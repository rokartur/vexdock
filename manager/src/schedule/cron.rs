use anyhow::{Result, anyhow, bail};
use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Timelike};
use chrono_tz::Tz;

/// A parsed five field cron expression, one bitmask per field.
#[derive(Clone, Copy, Debug, Default)]
pub struct Schedule {
	minute: u64,
	hour: u64,
	dom: u64,
	month: u64,
	dow: u64,
	dom_star: bool,
	dow_star: bool,
}

struct Field {
	min: u32,
	max: u32,
	names: &'static [(&'static str, u32)],
}

const MINUTES: Field = Field { min: 0, max: 59, names: &[] };
const HOURS: Field = Field { min: 0, max: 23, names: &[] };
const DOMS: Field = Field { min: 1, max: 31, names: &[] };
const MONTHS: Field = Field {
	min: 1,
	max: 12,
	names: &[
		("jan", 1),
		("feb", 2),
		("mar", 3),
		("apr", 4),
		("may", 5),
		("jun", 6),
		("jul", 7),
		("aug", 8),
		("sep", 9),
		("oct", 10),
		("nov", 11),
		("dec", 12),
	],
};
const DOWS: Field = Field { min: 0, max: 6, names: &[("sun", 0), ("mon", 1), ("tue", 2), ("wed", 3), ("thu", 4), ("fri", 5), ("sat", 6)] };

const NICKNAMES: &[(&str, &str)] = &[
	("@yearly", "0 0 1 1 *"),
	("@annually", "0 0 1 1 *"),
	("@monthly", "0 0 1 * *"),
	("@weekly", "0 0 * * 0"),
	("@daily", "0 0 * * *"),
	("@midnight", "0 0 * * *"),
	("@hourly", "0 * * * *"),
];

/// Reads a five field expression (minute hour day-of-month month day-of-week)
/// or one of the @daily style nicknames. Each field accepts `*`, a number,
/// `a-b`, a `/step` suffix and comma separated lists.
pub fn parse(expr: &str) -> Result<Schedule> {
	let mut expr = expr.trim();
	let lowered = expr.to_lowercase();
	if let Some((_, nick)) = NICKNAMES.iter().find(|(name, _)| *name == lowered) {
		expr = nick;
	}
	let parts: Vec<&str> = expr.split_whitespace().collect();
	if parts.len() != 5 {
		bail!("cron expression needs 5 fields, got {}", parts.len());
	}
	let field = |text: &str, f: &Field, label: &str| parse_field(text, f).map_err(|err| anyhow!("{label}: {err}"));
	Ok(Schedule {
		minute: field(parts[0], &MINUTES, "minute")?,
		hour: field(parts[1], &HOURS, "hour")?,
		dom: field(parts[2], &DOMS, "day of month")?,
		month: field(parts[3], &MONTHS, "month")?,
		dow: field(parts[4], &DOWS, "day of week")?,
		dom_star: is_star(parts[2]),
		dow_star: is_star(parts[4]),
	})
}

/// Resolves a task's IANA zone name, reading an empty name as UTC so a task
/// written before zones existed keeps its meaning.
pub fn location(name: &str) -> Result<Tz> {
	if name.is_empty() {
		return Ok(Tz::UTC);
	}
	name.parse::<Tz>().map_err(|_| anyhow!("unknown time zone {name}"))
}

impl Schedule {
	/// Whether the schedule fires at t, to minute precision, read in t's zone.
	pub fn matches(&self, t: &DateTime<Tz>) -> bool {
		self.minute & bit(t.minute()) != 0 && self.hour & bit(t.hour()) != 0 && self.match_date(t)
	}

	fn match_date(&self, t: &DateTime<Tz>) -> bool {
		if self.month & bit(t.month()) == 0 {
			return false;
		}
		let dom = self.dom & bit(t.day()) != 0;
		let dow = self.dow & bit(t.weekday().num_days_from_sunday()) != 0;
		// Standard cron: when both day fields are restricted, either one matching
		// is enough. Otherwise the restricted one decides.
		if self.dom_star || self.dow_star { dom && dow } else { dom || dow }
	}

	/// The first minute strictly after t that the schedule fires, in t's zone.
	/// None for an expression the calendar never reaches, such as February 30th,
	/// after searching five years ahead.
	///
	/// Across a DST jump the wall clock is what moves: a 02:30 task does not run
	/// on the night that has no 02:30, and runs twice on the night that has two.
	pub fn next(&self, t: DateTime<Tz>) -> Option<DateTime<Tz>> {
		let mut next = t - Duration::seconds(t.second() as i64) - Duration::nanoseconds(t.nanosecond() as i64) + Duration::minutes(1);
		let limit = next + Duration::days(5 * 366);
		while next < limit {
			// Skipping whole days and hours keeps a rare expression like "Feb 29"
			// from walking two million minutes to its answer.
			if !self.match_date(&next) {
				next = next_day_start(next)?;
			} else if self.hour & bit(next.hour()) == 0 {
				// Local minutes subtracted from the instant, so a zone like
				// Asia/Kathmandu does not land mid-hour.
				next = next - Duration::minutes(next.minute() as i64) + Duration::hours(1);
			} else if self.minute & bit(next.minute()) != 0 {
				return Some(next);
			} else {
				next += Duration::minutes(1);
			}
		}
		None
	}
}

/// Local midnight of the next calendar day, or the first hour that exists when
/// a DST jump skips midnight.
fn next_day_start(t: DateTime<Tz>) -> Option<DateTime<Tz>> {
	let date: NaiveDate = t.date_naive().succ_opt()?;
	let tz = t.timezone();
	(0..3).find_map(|hour| tz.from_local_datetime(&date.and_hms_opt(hour, 0, 0)?).earliest())
}

fn is_star(s: &str) -> bool {
	s == "*" || s.starts_with("*/")
}

fn bit(n: u32) -> u64 {
	1 << n
}

fn parse_field(text: &str, f: &Field) -> Result<u64> {
	let mut bits = 0;
	for part in text.split(',') {
		bits |= parse_range(part, f)?;
	}
	Ok(bits)
}

fn parse_range(part: &str, f: &Field) -> Result<u64> {
	let (mut part, mut step) = (part, 1);
	if let Some((base, step_text)) = part.split_once('/') {
		step = match step_text.parse::<u32>() {
			Ok(n) if n >= 1 => n,
			_ => bail!("invalid step {step_text:?}"),
		};
		part = base;
	}
	let (mut low, mut high) = (f.min, f.max);
	if part != "*" {
		let (from, to) = match part.split_once('-') {
			Some((from, to)) => (from, Some(to)),
			None => (part, None),
		};
		low = parse_value(from, f)?;
		high = match to {
			Some(to) => parse_value(to, f)?,
			// `5/15` means "from 5 to the end of the field", as in `5-59/15`.
			None if step > 1 => f.max,
			None => low,
		};
		if low > high {
			bail!("range {part:?} is inverted");
		}
	}
	let mut bits = 0;
	let mut v = low;
	while v <= high {
		bits |= bit(v);
		v += step;
	}
	Ok(bits)
}

fn parse_value(text: &str, f: &Field) -> Result<u32> {
	let lowered = text.to_lowercase();
	if let Some((_, n)) = f.names.iter().find(|(name, _)| *name == lowered) {
		return Ok(*n);
	}
	let mut n: u32 = text.parse().map_err(|_| anyhow!("invalid value {text:?}"))?;
	// Both 0 and 7 are Sunday in every cron implementation.
	if f.max == 6 && n == 7 {
		n = 0;
	}
	if n < f.min || n > f.max {
		bail!("value {n} out of range {}-{}", f.min, f.max);
	}
	Ok(n)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn utc(s: &str) -> DateTime<Tz> {
		DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Tz::UTC)
	}

	#[test]
	fn parse_rejects_garbage() {
		for expr in ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "*/0 * * * *", "5-1 * * * *", "x * * * *", "* * 0 * *"] {
			assert!(parse(expr).is_err(), "parse({expr:?}) accepted an invalid expression");
		}
	}

	#[test]
	fn matches_cases() {
		// 2024-03-06 is a Wednesday, 2024-03-10 a Sunday.
		let cases = [
			("* * * * *", "2024-03-06T13:37:00Z", true),
			("*/15 * * * *", "2024-03-06T13:30:00Z", true),
			("*/15 * * * *", "2024-03-06T13:31:00Z", false),
			("5/15 * * * *", "2024-03-06T13:35:00Z", true),
			("0 3 * * *", "2024-03-06T03:00:00Z", true),
			("0 3 * * *", "2024-03-06T04:00:00Z", false),
			("@daily", "2024-03-06T00:00:00Z", true),
			("@hourly", "2024-03-06T13:00:00Z", true),
			("0 0 * * sun", "2024-03-10T00:00:00Z", true),
			("0 0 * * 7", "2024-03-10T00:00:00Z", true),
			("0 0 * * 1-5", "2024-03-10T00:00:00Z", false),
			("0 0 * * 1-5", "2024-03-06T00:00:00Z", true),
			("0,30 9-17 * * *", "2024-03-06T09:30:00Z", true),
			("0,30 9-17 * * *", "2024-03-06T18:30:00Z", false),
			("0 0 1 jan *", "2024-01-01T00:00:00Z", true),
			("0 0 1 jan *", "2024-02-01T00:00:00Z", false),
			// Both day fields restricted: either one matching fires the task.
			("0 0 6 * sun", "2024-03-06T00:00:00Z", true),
			("0 0 6 * sun", "2024-03-10T00:00:00Z", true),
			("0 0 6 * sun", "2024-03-07T00:00:00Z", false),
		];
		for (expr, time, want) in cases {
			assert_eq!(parse(expr).unwrap().matches(&utc(time)), want, "{expr} at {time}");
		}
	}

	#[test]
	fn next_cases() {
		let warsaw: Tz = "Europe/Warsaw".parse().unwrap();
		let cases = [
			("*/15 * * * *", utc("2024-03-06T13:31:20Z"), "2024-03-06T13:45:00Z"),
			// Strictly after: a schedule matching right now points at the next one.
			("0 3 * * *", utc("2024-03-06T03:00:00Z"), "2024-03-07T03:00:00Z"),
			("0 9 * * 1", utc("2024-03-06T13:00:00Z"), "2024-03-11T09:00:00Z"),
			// A day skip that lands years out still resolves.
			("0 0 29 2 *", utc("2024-03-01T00:00:00Z"), "2028-02-29T00:00:00Z"),
			// The zone of the input decides the wall clock: the next 03:00 in Warsaw is 02:00Z.
			("0 3 * * *", warsaw.with_ymd_and_hms(2024, 3, 6, 13, 0, 0).unwrap(), "2024-03-07T02:00:00Z"),
		];
		for (expr, from, want) in cases {
			let next = parse(expr).unwrap().next(from).unwrap_or_else(|| panic!("{expr} found nothing"));
			assert_eq!(next.with_timezone(&chrono::Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string(), want, "{expr} from {from}");
		}
		// February 30th is a valid expression the calendar never reaches.
		assert!(parse("0 0 30 2 *").unwrap().next(chrono::Utc::now().with_timezone(&Tz::UTC)).is_none());
	}
}
