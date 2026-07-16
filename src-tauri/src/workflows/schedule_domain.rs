use std::str::FromStr;

use chrono::{DateTime, SecondsFormat, Utc};
use chrono_tz::Tz;
use cron::Schedule;

const FIVE_FIELD_COUNT: usize = 5;
const SIX_FIELD_COUNT: usize = 6;
const SEVEN_FIELD_COUNT: usize = 7;

pub fn next_run_at(
    cron_expression: &str,
    timezone: &str,
    after: DateTime<Utc>,
) -> Result<DateTime<Utc>, String> {
    let schedule = parse_cron(cron_expression)?;
    let timezone = parse_timezone(timezone)?;
    schedule
        .after(&after.with_timezone(&timezone))
        .next()
        .map(|value| value.with_timezone(&Utc))
        .ok_or_else(|| "Cron 表达式没有可计算的下一次执行时间".to_string())
}

pub fn validate(cron_expression: &str, timezone: &str) -> Result<(), String> {
    parse_cron(cron_expression)?;
    parse_timezone(timezone)?;
    Ok(())
}

pub fn parse_utc(value: &str) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(value)
        .map(|parsed| parsed.with_timezone(&Utc))
        .map_err(|error| format!("调度时间格式无效：{error}"))
}

pub fn format_utc(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn parse_cron(expression: &str) -> Result<Schedule, String> {
    let normalized = normalize_cron(expression)?;
    Schedule::from_str(&normalized).map_err(|error| format!("Cron 表达式无效：{error}"))
}

fn parse_timezone(value: &str) -> Result<Tz, String> {
    value
        .trim()
        .parse::<Tz>()
        .map_err(|_| format!("时区无效：{value}"))
}

fn normalize_cron(expression: &str) -> Result<String, String> {
    let fields: Vec<&str> = expression.split_whitespace().collect();
    match fields.len() {
        FIVE_FIELD_COUNT => Ok(format!("0 {}", fields.join(" "))),
        SIX_FIELD_COUNT | SEVEN_FIELD_COUNT => Ok(fields.join(" ")),
        count => Err(format!(
            "Cron 表达式字段数无效：期望 5、6 或 7，实际 {count}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    #[test]
    fn accepts_five_field_cron_and_converts_timezone_to_utc() {
        let after = Utc.with_ymd_and_hms(2026, 7, 16, 0, 0, 0).unwrap();
        let next = next_run_at("30 9 * * *", "Asia/Shanghai", after).unwrap();
        assert_eq!(format_utc(next), "2026-07-16T01:30:00Z");
    }

    #[test]
    fn rejects_invalid_cron_and_timezone() {
        assert!(validate("not cron", "Asia/Shanghai")
            .unwrap_err()
            .contains("字段数无效"));
        assert!(validate("0 9 * * *", "Invalid/Timezone")
            .unwrap_err()
            .contains("时区无效"));
    }

    #[test]
    fn skips_nonexistent_dst_local_time() {
        let before_gap = Utc.with_ymd_and_hms(2026, 3, 8, 6, 0, 0).unwrap();
        let next = next_run_at("30 2 * * *", "America/New_York", before_gap).unwrap();
        assert_eq!(format_utc(next), "2026-03-09T06:30:00Z");
    }
}
