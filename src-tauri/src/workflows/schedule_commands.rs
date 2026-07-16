use chrono::Utc;
use tauri::State;

use crate::scheduler::SchedulerHost;
use crate::storage::WorkflowDb;

use super::schedule_domain::format_utc;
use super::schedule_repository::{
    self, SetScheduleEnabledInput, UpsertScheduleInput, WorkflowSchedule,
};

#[tauri::command]
pub fn workflow_schedule_get(
    db: State<'_, WorkflowDb>,
    workflow_id: String,
) -> Result<Option<WorkflowSchedule>, String> {
    schedule_repository::get(&db.open_connection()?, &workflow_id)
}

#[tauri::command]
pub fn workflow_schedule_upsert(
    db: State<'_, WorkflowDb>,
    scheduler: State<'_, SchedulerHost>,
    input: UpsertScheduleInput,
) -> Result<WorkflowSchedule, String> {
    let now = format_utc(Utc::now());
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
    let now = format_utc(Utc::now());
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
