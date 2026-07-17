use chrono::Utc;
use serde::Deserialize;
use tauri::State;

use crate::scheduler::SchedulerHost;
use crate::storage::WorkflowDb;

use super::schedule_domain;
use super::schedule_repository::{
    self, SetScheduleEnabledInput, UpsertScheduleInput, WorkflowSchedule,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulePreviewInput {
    cron_expression: String,
    timezone: String,
}

#[tauri::command]
pub fn workflow_schedule_get(
    db: State<'_, WorkflowDb>,
    workflow_id: String,
) -> Result<Option<WorkflowSchedule>, String> {
    schedule_repository::get(&db.open_connection()?, &workflow_id)
}

#[tauri::command]
pub fn workflow_schedule_preview(input: SchedulePreviewInput) -> Result<String, String> {
    schedule_domain::next_run_at(&input.cron_expression, &input.timezone, Utc::now())
        .map(schedule_domain::format_utc)
}

#[tauri::command]
pub fn workflow_schedule_upsert(
    db: State<'_, WorkflowDb>,
    scheduler: State<'_, SchedulerHost>,
    input: UpsertScheduleInput,
) -> Result<WorkflowSchedule, String> {
    let now = schedule_domain::format_utc(Utc::now());
    let schedule = schedule_repository::upsert(&mut db.open_connection()?, &input, &now)?;
    scheduler.wake();
    Ok(schedule)
}

#[tauri::command]
pub fn workflow_schedule_set_enabled(
    db: State<'_, WorkflowDb>,
    scheduler: State<'_, SchedulerHost>,
    input: SetScheduleEnabledInput,
) -> Result<WorkflowSchedule, String> {
    let now = schedule_domain::format_utc(Utc::now());
    let schedule = schedule_repository::set_enabled(&mut db.open_connection()?, &input, &now)?;
    scheduler.wake();
    Ok(schedule)
}

#[tauri::command]
pub fn workflow_schedule_delete(
    db: State<'_, WorkflowDb>,
    scheduler: State<'_, SchedulerHost>,
    workflow_id: String,
) -> Result<(), String> {
    schedule_repository::delete(&db.open_connection()?, &workflow_id)?;
    scheduler.wake();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn previews_next_run_without_persisting_schedule() {
        let before = Utc::now();
        let preview = workflow_schedule_preview(SchedulePreviewInput {
            cron_expression: "0 9 * * *".into(),
            timezone: "Asia/Shanghai".into(),
        })
        .unwrap();
        let next = schedule_domain::parse_utc(&preview).unwrap();

        assert!(next > before);
    }
}
