use std::{collections::HashMap, sync::Arc, time::Duration};

use chrono::{DateTime, Utc};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio::sync::{oneshot, Mutex, Notify};

use crate::{
    archery::{ArcheryService, SessionContext},
    notifications::{self, domain::NewMessage},
    storage::WorkflowDb,
    workflows::{
        execution_models::TriggerType,
        execution_repository::{self, CreatedExecution},
        execution_service::{self, ExecutionOutcome, ExecutionRunContext, PreflightFailure},
        schedule_domain, schedule_repository,
    },
    Kv,
};

type ManualResult = Result<ExecutionOutcome, String>;

#[derive(Clone)]
struct SchedulerShared {
    wake: Arc<Notify>,
    submission: Arc<Mutex<()>>,
    sessions: Arc<Mutex<HashMap<String, SessionContext>>>,
    waiters: Arc<Mutex<HashMap<String, oneshot::Sender<ManualResult>>>>,
}

pub struct SchedulerHost {
    shared: SchedulerShared,
}

pub struct ManualSubmission<'a> {
    pub db: &'a WorkflowDb,
    pub workflow_id: &'a str,
    pub session: SessionContext,
}

impl SchedulerHost {
    pub fn start(app: AppHandle) -> Self {
        let shared = SchedulerShared {
            wake: Arc::new(Notify::new()),
            submission: Arc::new(Mutex::new(())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            waiters: Arc::new(Mutex::new(HashMap::new())),
        };
        let worker = shared.clone();
        tauri::async_runtime::spawn(async move {
            run_scheduler(app, worker).await;
        });
        Self { shared }
    }

    pub fn wake(&self) {
        self.shared.wake.notify_one();
    }

    pub async fn submit_manual(&self, input: ManualSubmission<'_>) -> ManualResult {
        let submission = self.shared.submission.lock().await;
        let created = execution_repository::create_manual(
            &mut input.db.open_connection()?,
            input.workflow_id,
        )?;
        let execution_id = created.id;
        let (sender, receiver) = oneshot::channel();
        self.shared
            .sessions
            .lock()
            .await
            .insert(execution_id.clone(), input.session);
        self.shared
            .waiters
            .lock()
            .await
            .insert(execution_id, sender);
        drop(submission);
        self.wake();
        receiver
            .await
            .map_err(|_| "后台执行队列意外终止".to_string())?
    }
}

async fn run_scheduler(app: AppHandle, shared: SchedulerShared) {
    if let Err(error) = handle_startup(&app).await {
        report_scheduler_error(&app, "SCHEDULER_STARTUP_FAILED", &error);
    }
    loop {
        if let Err(error) = run_cycle(&app, &shared).await {
            report_scheduler_error(&app, "SCHEDULER_CYCLE_FAILED", &error);
        }
        wait_for_next(&app, &shared.wake).await;
    }
}

async fn handle_startup(app: &AppHandle) -> Result<(), String> {
    let db = app.state::<WorkflowDb>();
    let now = schedule_domain::format_utc(Utc::now());
    let missed = schedule_repository::skip_missed(&mut db.open_connection()?, &now)?;
    for item in missed {
        create_missed_message(app, &db, &item)?;
    }
    Ok(())
}

async fn run_cycle(app: &AppHandle, shared: &SchedulerShared) -> Result<(), String> {
    enqueue_due(app)?;
    loop {
        let db = app.state::<WorkflowDb>();
        let now = schedule_domain::format_utc(Utc::now());
        let submission = shared.submission.lock().await;
        let Some(claimed) =
            schedule_repository::claim_next_pending(&mut db.open_connection()?, &now)?
        else {
            return Ok(());
        };
        drop(submission);
        let execution_id = claimed.execution_id.clone();
        let result = execute_claimed(app, shared, claimed).await;
        complete_waiter(shared, &execution_id, result).await?;
    }
}

fn enqueue_due(app: &AppHandle) -> Result<(), String> {
    let db = app.state::<WorkflowDb>();
    loop {
        let now = schedule_domain::format_utc(Utc::now());
        let Some(result) = schedule_repository::enqueue_due(&mut db.open_connection()?, &now)?
        else {
            return Ok(());
        };
        if let schedule_repository::DueScheduleResult::Skipped(item) = result {
            create_missed_message(app, &db, &item)?;
        }
    }
}

async fn execute_claimed(
    app: &AppHandle,
    shared: &SchedulerShared,
    claimed: schedule_repository::ClaimedExecution,
) -> ManualResult {
    let db = app.state::<WorkflowDb>();
    let archery = app.state::<ArcheryService>();
    let created = CreatedExecution {
        id: claimed.execution_id,
        version_id: claimed.workflow_version_id,
        sql_node_id: claimed.sql_node_execution_id,
    };
    let detail = execution_repository::detail(&db.open_connection()?, &created.id)?.0;
    let context = ExecutionRunContext {
        app,
        db: &db,
        archery: &archery,
    };
    let session = match detail.summary.trigger_type {
        TriggerType::Manual => shared.sessions.lock().await.remove(&created.id),
        TriggerType::Schedule => {
            match scheduled_session(app, &archery, &detail.data_source.environment_id).await {
                Ok(session) => Some(session),
                Err(failure) => {
                    return execution_service::fail_before_sql(&context, created, failure);
                }
            }
        }
    };
    let Some(session) = session else {
        return execution_service::fail_before_sql(
            &context,
            created,
            PreflightFailure {
                code: "MANUAL_SESSION_LOST",
                safe_message: "应用重启后手动执行会话已失效",
            },
        );
    };
    execution_service::run_claimed(&context, created, session).await
}

async fn scheduled_session(
    app: &AppHandle,
    archery: &ArcheryService,
    environment_id: &str,
) -> Result<SessionContext, PreflightFailure<'static>> {
    let identity = resolve_identity(app, environment_id).await?;
    archery
        .login(&identity.session, &identity.password)
        .await
        .map_err(|_| PreflightFailure {
            code: "SCHEDULE_LOGIN_FAILED",
            safe_message: "定时执行使用保存凭据登录失败",
        })?;
    Ok(identity.session)
}

struct SavedIdentity {
    session: SessionContext,
    password: String,
}

async fn resolve_identity(
    app: &AppHandle,
    environment_id: &str,
) -> Result<SavedIdentity, PreflightFailure<'static>> {
    let kv = app.state::<Kv>();
    let data = kv.data.lock().await;
    let environment = find_environment(&data, environment_id)?;
    let credential = data
        .get("sqls_creds")
        .and_then(Value::as_object)
        .and_then(|items| items.get(environment_id))
        .ok_or_else(missing_credential)?;
    let username = credential
        .get("user")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(missing_credential)?
        .to_string();
    if credential.get("remember").and_then(Value::as_bool) != Some(true) {
        return Err(missing_credential());
    }
    let origin = environment_origin(environment)?;
    drop(data);
    let password = crate::cred_get(environment_id.to_string())
        .map_err(|_| credential_read_failed())?
        .filter(|value| !value.is_empty())
        .ok_or_else(missing_credential)?;
    Ok(SavedIdentity {
        session: SessionContext::new(environment_id.into(), username, origin),
        password,
    })
}

fn find_environment<'a>(
    data: &'a Value,
    environment_id: &str,
) -> Result<&'a Value, PreflightFailure<'static>> {
    data.get("sqls_envs")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(environment_id))
        })
        .ok_or(PreflightFailure {
            code: "SCHEDULE_ENVIRONMENT_MISSING",
            safe_message: "定时执行引用的环境不存在",
        })
}

fn environment_origin(environment: &Value) -> Result<String, PreflightFailure<'static>> {
    let base = environment
        .get("base")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(PreflightFailure {
            code: "SCHEDULE_ENVIRONMENT_INVALID",
            safe_message: "定时执行环境地址无效",
        })?;
    let scheme = environment
        .get("scheme")
        .and_then(Value::as_str)
        .unwrap_or("http");
    Ok(format!("{scheme}://{base}"))
}

async fn complete_waiter(
    shared: &SchedulerShared,
    execution_id: &str,
    result: ManualResult,
) -> Result<(), String> {
    if let Some(sender) = shared.waiters.lock().await.remove(execution_id) {
        let _ = sender.send(result);
        return Ok(());
    }
    result.map(|_| ())
}

async fn wait_for_next(app: &AppHandle, wake: &Notify) {
    let db = app.state::<WorkflowDb>();
    let connection = match db.open_connection() {
        Ok(connection) => connection,
        Err(error) => {
            report_scheduler_error(app, "SCHEDULER_DB_OPEN_FAILED", &error);
            wake.notified().await;
            return;
        }
    };
    let next = match schedule_repository::next_due(&connection) {
        Ok(Some(next)) => next,
        Ok(None) => {
            wake.notified().await;
            return;
        }
        Err(error) => {
            report_scheduler_error(app, "SCHEDULER_NEXT_DUE_FAILED", &error);
            wake.notified().await;
            return;
        }
    };
    let duration = match wait_duration(&next.next_run_at) {
        Ok(duration) => duration,
        Err(error) => {
            report_scheduler_error(app, "SCHEDULER_NEXT_RUN_INVALID", &error);
            wake.notified().await;
            return;
        }
    };
    tokio::select! {
        _ = tokio::time::sleep(duration) => {},
        _ = wake.notified() => {},
    }
}

fn wait_duration(value: &str) -> Result<Duration, String> {
    let due = DateTime::parse_from_rfc3339(value)
        .map_err(|_| "调度 next_run_at 格式无效".to_string())?
        .with_timezone(&Utc);
    Ok((due - Utc::now()).to_std().unwrap_or(Duration::ZERO))
}

fn create_missed_message(
    app: &AppHandle,
    db: &WorkflowDb,
    missed: &schedule_repository::MissedSchedule,
) -> Result<(), String> {
    let input = NewMessage {
        message_kind: "schedule".into(),
        severity: "warning".into(),
        title: "定时计划已错过".into(),
        content: "应用未运行期间的计划未补跑，已推进到下一执行时间".into(),
        workflow_id: Some(missed.workflow_id.clone()),
        execution_id: None,
        dedupe_key: format!(
            "schedule:{}:missed:{}",
            missed.schedule_id, missed.scheduled_for
        ),
    };
    let id = notifications::repository::create(&mut db.open_connection()?, &input)?;
    notifications::service::deliver_if_needed(app, db, &id)?;
    Ok(())
}

fn report_scheduler_error(app: &AppHandle, code: &str, _error: &str) {
    let db = app.state::<WorkflowDb>();
    let minute = Utc::now().format("%Y%m%d%H%M");
    let input = NewMessage {
        message_kind: "system".into(),
        severity: "error".into(),
        title: "后台调度异常".into(),
        content: "后台调度已遇到错误，请打开应用检查调度配置与执行详情".into(),
        workflow_id: None,
        execution_id: None,
        dedupe_key: format!("scheduler:{code}:{minute}"),
    };
    let result = db
        .open_connection()
        .and_then(|mut connection| notifications::repository::create(&mut connection, &input));
    match result {
        Ok(id) => {
            if notifications::service::deliver_if_needed(app, &db, &id).is_err() {
                eprintln!("后台调度异常通知投递状态记录失败");
            }
        }
        Err(_) => eprintln!("后台调度异常无法写入通知中心"),
    }
}

fn missing_credential() -> PreflightFailure<'static> {
    PreflightFailure {
        code: "SCHEDULE_CREDENTIAL_MISSING",
        safe_message: "定时执行缺少已保存凭据",
    }
}

fn credential_read_failed() -> PreflightFailure<'static> {
    PreflightFailure {
        code: "SCHEDULE_CREDENTIAL_READ_FAILED",
        safe_message: "读取定时执行凭据失败",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_environment_origin_without_credentials() {
        let environment = json!({"id":"env","scheme":"https","base":"archery.example.com"});
        assert_eq!(
            environment_origin(&environment).unwrap(),
            "https://archery.example.com"
        );
    }

    #[test]
    fn finds_environment_by_exact_identifier() {
        let data = json!({"sqls_envs":[{"id":"env-a","base":"a"},{"id":"env-b","base":"b"}]});
        let found = find_environment(&data, "env-b").unwrap();
        assert_eq!(found["base"], "b");
        assert_eq!(
            find_environment(&data, "missing").unwrap_err().code,
            "SCHEDULE_ENVIRONMENT_MISSING"
        );
    }

    #[test]
    fn computes_zero_wait_for_past_due_schedule() {
        assert_eq!(
            wait_duration("2020-01-01T00:00:00Z").unwrap(),
            Duration::ZERO
        );
        assert!(wait_duration("invalid").is_err());
    }
}
