use std::{collections::BTreeSet, str::FromStr};

use chrono::{DateTime, LocalResult, SecondsFormat, TimeZone, Utc};
use chrono_tz::Tz;
use cron::Schedule;

const FIVE_FIELD_COUNT: usize = 5;
const SIX_FIELD_COUNT: usize = 6;
const SEVEN_FIELD_COUNT: usize = 7;
const FIVE_FIELD_WEEKDAY_INDEX: usize = 4;
const EXTENDED_WEEKDAY_INDEX: usize = 5;
const CRON_WEEKDAY_OFFSET: u8 = 1;
const SUNDAY_ALIAS: u8 = 7;
const UI_WEEKDAY_MAX: u8 = 6;
const MIN_WEEKDAY_STEP: usize = 1;
const MAX_WEEKDAY_STEP: usize = 7;

const CRON_FIELD_HINTS: [(&str, &str); 7] = [
    ("Seconds", "秒"),
    ("Minutes", "分钟"),
    ("Hours", "小时"),
    ("Days of Month", "日期"),
    ("Months", "月份"),
    ("Days of Week", "星期"),
    ("Years", "年份"),
];

struct CronSchedules {
    values: Vec<Schedule>,
}

impl CronSchedules {
    fn next_after(&self, timezone: Tz, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
        let local_after = after.with_timezone(&timezone);
        self.values
            .iter()
            .filter_map(|schedule| next_distinct_local_time(schedule, timezone, &local_after))
            .map(|value| value.with_timezone(&Utc))
            .min()
    }
}

pub fn next_run_at(
    cron_expression: &str,
    timezone: &str,
    after: DateTime<Utc>,
) -> Result<DateTime<Utc>, String> {
    let schedules = parse_cron(cron_expression)?;
    let timezone = parse_timezone(timezone)?;
    schedules
        .next_after(timezone, after)
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

fn parse_cron(expression: &str) -> Result<CronSchedules, String> {
    let values = normalize_cron(expression)?
        .into_iter()
        .map(|normalized| {
            Schedule::from_str(&normalized).map_err(|error| format_cron_error(&error))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(CronSchedules { values })
}

fn next_distinct_local_time(
    schedule: &Schedule,
    timezone: Tz,
    after: &DateTime<Tz>,
) -> Option<DateTime<Tz>> {
    schedule
        .after(after)
        .find(|candidate| !is_later_ambiguous_time(timezone, candidate))
}

fn is_later_ambiguous_time(timezone: Tz, candidate: &DateTime<Tz>) -> bool {
    match timezone.from_local_datetime(&candidate.naive_local()) {
        LocalResult::Ambiguous(_, later) => candidate == &later,
        LocalResult::Single(_) | LocalResult::None => false,
    }
}

fn format_cron_error(error: &cron::error::Error) -> String {
    let detail = error.to_string();
    eprintln!("Cron 表达式解析失败：{detail}");
    CRON_FIELD_HINTS
        .iter()
        .find(|(source, _)| detail.contains(source))
        .map(|(_, label)| format!("Cron 表达式的{label}字段无效，请检查取值或格式"))
        .unwrap_or_else(|| "Cron 表达式格式无效，请检查字段数量、顺序和分隔符".to_string())
}

fn parse_timezone(value: &str) -> Result<Tz, String> {
    value
        .trim()
        .parse::<Tz>()
        .map_err(|_| format!("时区无效：{value}"))
}

fn normalize_cron(expression: &str) -> Result<Vec<String>, String> {
    let fields: Vec<&str> = expression.split_whitespace().collect();
    match fields.len() {
        FIVE_FIELD_COUNT => normalize_five_field_cron(&fields),
        SIX_FIELD_COUNT | SEVEN_FIELD_COUNT => normalize_extended_cron(&fields),
        count => Err(format!(
            "Cron 表达式字段数无效：期望 5、6 或 7，实际 {count}"
        )),
    }
}

fn normalize_five_field_cron(fields: &[&str]) -> Result<Vec<String>, String> {
    let day_of_month_restricted = is_restricted_day_field(fields[2]);
    let weekday_restricted = is_restricted_day_field(fields[FIVE_FIELD_WEEKDAY_INDEX]);
    let mut normalized = vec!["0".to_string()];
    normalized.extend(fields.iter().map(|field| (*field).to_string()));
    normalized[EXTENDED_WEEKDAY_INDEX] =
        normalize_weekday_field(&normalized[EXTENDED_WEEKDAY_INDEX])?;
    if !day_of_month_restricted || !weekday_restricted {
        return Ok(vec![normalized.join(" ")]);
    }
    let mut by_month_day = normalized.clone();
    by_month_day[EXTENDED_WEEKDAY_INDEX] = "*".to_string();
    normalized[3] = "*".to_string();
    Ok(vec![by_month_day.join(" "), normalized.join(" ")])
}

fn normalize_extended_cron(fields: &[&str]) -> Result<Vec<String>, String> {
    let mut normalized = fields
        .iter()
        .map(|field| (*field).to_string())
        .collect::<Vec<_>>();
    normalized[EXTENDED_WEEKDAY_INDEX] =
        normalize_weekday_field(&normalized[EXTENDED_WEEKDAY_INDEX])?;
    Ok(vec![normalized.join(" ")])
}

fn is_restricted_day_field(field: &str) -> bool {
    !matches!(field, "*" | "?")
}

fn normalize_weekday_field(field: &str) -> Result<String, String> {
    if matches!(field, "*" | "?") {
        return Ok("*".to_string());
    }
    let mut weekdays = BTreeSet::new();
    for token in field.split(',') {
        weekdays.extend(expand_weekday_token(token)?);
    }
    if weekdays.is_empty() {
        return Err("星期字段不能为空".to_string());
    }
    Ok(weekdays
        .into_iter()
        .map(|day| (day + CRON_WEEKDAY_OFFSET).to_string())
        .collect::<Vec<_>>()
        .join(","))
}

fn expand_weekday_token(token: &str) -> Result<Vec<u8>, String> {
    let (base, step) = parse_weekday_step(token)?;
    let values = weekday_base_values(base, step.is_some())?;
    let step = step.unwrap_or(MIN_WEEKDAY_STEP);
    Ok(values.into_iter().step_by(step).collect())
}

fn parse_weekday_step(token: &str) -> Result<(&str, Option<usize>), String> {
    let Some((base, step)) = token.split_once('/') else {
        return Ok((token, None));
    };
    if base == "?" {
        return Err("星期字段不支持对 ? 使用步长".to_string());
    }
    let step = step
        .parse::<usize>()
        .map_err(|_| format!("星期字段步长无效：{step}"))?;
    if !(MIN_WEEKDAY_STEP..=MAX_WEEKDAY_STEP).contains(&step) {
        return Err(format!("星期字段步长无效：{step}"));
    }
    Ok((base, Some(step)))
}

fn weekday_base_values(base: &str, has_step: bool) -> Result<Vec<u8>, String> {
    if base == "*" {
        return Ok((0..=UI_WEEKDAY_MAX).collect());
    }
    if let Some((start, end)) = base.split_once('-') {
        return weekday_range(start, end);
    }
    let endpoint = parse_weekday_endpoint(base)?;
    if has_step {
        let raw = endpoint
            .numeric
            .ok_or_else(|| format!("星期字段不支持对英文星期使用步长：{base}"))?;
        return Ok((raw..=SUNDAY_ALIAS).map(normalize_weekday_number).collect());
    }
    Ok(vec![endpoint.day])
}

fn weekday_range(start: &str, end: &str) -> Result<Vec<u8>, String> {
    let start = parse_weekday_endpoint(start)?;
    let end = parse_weekday_endpoint(end)?;
    match (start.numeric, end.numeric) {
        (Some(start), Some(end)) if start <= end => {
            Ok((start..=end).map(normalize_weekday_number).collect())
        }
        (None, None) if start.day <= end.day => Ok((start.day..=end.day).collect()),
        _ => Err("星期字段范围无效".to_string()),
    }
}

struct WeekdayEndpoint {
    day: u8,
    numeric: Option<u8>,
}

fn parse_weekday_endpoint(value: &str) -> Result<WeekdayEndpoint, String> {
    if let Ok(number) = value.parse::<u8>() {
        if number <= SUNDAY_ALIAS {
            return Ok(WeekdayEndpoint {
                day: normalize_weekday_number(number),
                numeric: Some(number),
            });
        }
    }
    let day = named_weekday(value).ok_or_else(|| format!("星期字段无效：{value}"))?;
    Ok(WeekdayEndpoint { day, numeric: None })
}

fn normalize_weekday_number(day: u8) -> u8 {
    if day == SUNDAY_ALIAS {
        0
    } else {
        day
    }
}

fn named_weekday(value: &str) -> Option<u8> {
    match value.to_ascii_lowercase().as_str() {
        "sun" | "sunday" => Some(0),
        "mon" | "monday" => Some(1),
        "tue" | "tues" | "tuesday" => Some(2),
        "wed" | "wednesday" => Some(3),
        "thu" | "thurs" | "thursday" => Some(4),
        "fri" | "friday" => Some(5),
        "sat" | "saturday" => Some(6),
        _ => None,
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
    fn weekly_friday_schedule_keeps_the_current_friday() {
        let friday_morning = Utc.with_ymd_and_hms(2026, 7, 17, 3, 0, 0).unwrap();
        let next = next_run_at("0 20 * * 5", "Asia/Shanghai", friday_morning).unwrap();

        assert_eq!(format_utc(next), "2026-07-17T12:00:00Z");
    }

    #[test]
    fn weekly_saturday_schedule_maps_to_cron_weekday_seven() {
        let friday_morning = Utc.with_ymd_and_hms(2026, 7, 17, 3, 0, 0).unwrap();
        let next = next_run_at("0 9 * * 6", "Asia/Shanghai", friday_morning).unwrap();

        assert_eq!(format_utc(next), "2026-07-18T01:00:00Z");
    }

    #[test]
    fn seven_field_cron_normalizes_weekday_without_changing_year() {
        assert!(validate("0 0 9 * * 6 2026", "Asia/Shanghai").is_ok());
    }

    #[test]
    fn accepts_common_custom_weekday_syntax() {
        for expression in [
            "0 9 * * MON-FRI",
            "0 9 * * */2",
            "0 9 * * 1-7",
            "0 0 9 * * ?",
        ] {
            assert!(
                validate(expression, "Asia/Shanghai").is_ok(),
                "{expression}"
            );
        }
    }

    #[test]
    fn five_field_cron_uses_day_of_month_or_weekday_semantics() {
        let thursday = Utc.with_ymd_and_hms(2026, 7, 2, 0, 0, 0).unwrap();
        let next = next_run_at("0 9 1 * 1", "Asia/Shanghai", thursday).unwrap();

        assert_eq!(format_utc(next), "2026-07-06T01:00:00Z");
    }

    #[test]
    fn skips_second_occurrence_of_ambiguous_dst_time() {
        let first_occurrence = Utc.with_ymd_and_hms(2026, 11, 1, 5, 30, 0).unwrap();
        let next = next_run_at("30 1 * * *", "America/New_York", first_occurrence).unwrap();

        assert_eq!(format_utc(next), "2026-11-02T06:30:00Z");
    }

    #[test]
    fn rejects_invalid_cron_and_timezone() {
        assert!(validate("not cron", "Asia/Shanghai")
            .unwrap_err()
            .contains("字段数无效"));
        let cron_error = validate("70 9 * * *", "Asia/Shanghai").unwrap_err();
        assert_eq!(cron_error, "Cron 表达式的分钟字段无效，请检查取值或格式");
        assert!(!cron_error.contains("Minutes"));
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
