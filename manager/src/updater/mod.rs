//! Platform self-updates.
//!
//! The manager must not replace its own container from inside itself: it would
//! be killed mid-swap with no way to recover. Instead it takes a backup and
//! launches a short-lived, detached updater container that pulls the new
//! images, recreates the stack and rolls back if the health check fails.

mod state;

pub use state::*;

use std::cmp::Ordering;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, bail};
use regex::Regex;
use serde::Serialize;
use tokio::process::Command;

use crate::backup::Backup;
use crate::config::Config;

/// The update shell script shipped inside the manager binary.
pub const SCRIPT: &str = include_str!("update.sh");

/// Runs the update script; it ships the docker CLI and the compose plugin,
/// which is all the script needs.
pub const UPDATER_IMAGE: &str = "docker:28-cli";

/// The system_settings key for the prerelease channel. "true" / "false"; empty
/// follows the installed version's track.
pub const SETTING_BETA: &str = "updater.beta";

/// The system_settings key for pruning the previous platform images after a
/// successful update. "true" / "false"; empty is off.
pub const SETTING_CLEANUP_OLD_IMAGES: &str = "updater.cleanup_old_images";

/// The only shape accepted for a target version, so nothing user-supplied can
/// be reinterpreted by the shell inside the updater container.
static VERSION_PATTERN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^v?[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$").unwrap());

/// How long one release lookup answers for, failures included.
const CACHE_FOR: Duration = Duration::from_secs(2 * 60);

pub struct Updater {
	cfg: Arc<Config>,
	backups: Arc<Backup>,
	repo: String,
	releases_url: String,
	raw_base: String,
	http: reqwest::Client,
	no_redirects: reqwest::Client,
	/// Also what makes two simultaneous starts one update: the state file is
	/// claimed under it.
	cache: tokio::sync::Mutex<Cache>,
}

#[derive(Default)]
struct Cache {
	latest: String,
	latest_at: Option<chrono::DateTime<chrono::Utc>>,
	asked_at: Option<Instant>,
	check_err: Option<String>,
	prerelease: bool,
}

/// What the System > About screen renders.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Status {
	pub current: String,
	pub latest: String,
	pub update_available: bool,
	pub beta: bool,
	pub checked_at: String,
	/// The latest release's notes on GitHub; empty when no release is known or
	/// no repo is configured.
	pub release_url: String,
	/// Why the last lookup failed; latest and checked_at then still describe
	/// the last one that succeeded. Empty after a success.
	pub check_error: String,
	/// Filled in by the API from system_settings.
	pub cleanup_old_images: bool,
}

/// Resolves the channel, stable or prerelease, never both: an explicit setting
/// wins, otherwise a prerelease install stays on prereleases.
pub fn prerelease_track(setting: &str, current: &str) -> bool {
	match setting {
		"true" => true,
		"false" => false,
		_ => current.contains('-'),
	}
}

impl Updater {
	/// repo is the "owner/name" GitHub slug that publishes this platform:
	/// releases are read from it and the compose file for the target version is
	/// downloaded from it. An empty slug disables update checks.
	pub fn new(cfg: Arc<Config>, backups: Arc<Backup>, repo: &str) -> Updater {
		let (releases_url, raw_base) = if repo.is_empty() {
			(String::new(), String::new())
		} else {
			(format!("https://github.com/{repo}/releases"), format!("https://raw.githubusercontent.com/{repo}"))
		};
		Updater {
			cfg,
			backups,
			repo: repo.into(),
			releases_url,
			raw_base,
			http: http_client(reqwest::redirect::Policy::default()),
			no_redirects: http_client(reqwest::redirect::Policy::none()),
			cache: tokio::sync::Mutex::default(),
		}
	}

	/// The installed version and the newest release on the chosen track.
	pub async fn status(&self, prerelease: bool) -> Status {
		let (latest, checked_at, check_error) = self.latest_version(prerelease).await;
		let release_url = if !latest.is_empty() && !self.repo.is_empty() {
			format!("https://github.com/{}/releases/tag/{latest}", self.repo)
		} else {
			String::new()
		};
		Status {
			current: self.cfg.version.clone(),
			// Strictly newer, never merely different: the release list is not
			// ordered by version, so an inequality would offer a downgrade.
			update_available: !latest.is_empty() && compare_versions(&latest, &self.cfg.version) == Ordering::Greater,
			latest,
			release_url,
			beta: prerelease,
			// None means no lookup ever succeeded; the panel says "never".
			checked_at: checked_at.map(|t| t.format("%Y-%m-%dT%H:%M:%SZ").to_string()).unwrap_or_default(),
			check_error: check_error.unwrap_or_default(),
			cleanup_old_images: false,
		}
	}

	/// Drops the cached lookup so the next status queries GitHub again, which is
	/// what the panel's manual check does. Callers must be authenticated: this
	/// turns a request into an outbound one to GitHub.
	pub async fn invalidate(&self) {
		self.cache.lock().await.asked_at = None;
	}

	/// Asks GitHub at most once every two minutes per track, failures included,
	/// and returns the last answer that succeeded with when it was fetched.
	async fn latest_version(&self, prerelease: bool) -> (String, Option<chrono::DateTime<chrono::Utc>>, Option<String>) {
		if self.releases_url.is_empty() {
			return (String::new(), None, None);
		}
		let mut cache = self.cache.lock().await;
		if cache.prerelease != prerelease {
			*cache = Cache { prerelease, ..Default::default() };
		}
		if cache.asked_at.is_some_and(|at| at.elapsed() < CACHE_FOR) {
			return (cache.latest.clone(), cache.latest_at, cache.check_err.clone());
		}
		let fetched = tokio::time::timeout(Duration::from_secs(10), self.fetch_latest(prerelease))
			.await
			.unwrap_or_else(|_| Err(anyhow!("GitHub did not answer in 10s")));
		cache.asked_at = Some(Instant::now());
		cache.check_err = fetched.as_ref().err().map(|err| format!("{err:#}"));
		if let Ok(latest) = fetched {
			cache.latest = latest;
			cache.latest_at = Some(chrono::Utc::now());
		}
		(cache.latest.clone(), cache.latest_at, cache.check_err.clone())
	}

	/// The highest release on the track, or "" when none matches, which the UI
	/// shows as "unknown". It reads github.com pages, not api.github.com:
	/// anonymous API calls share 60 an hour per address.
	async fn fetch_latest(&self, prerelease: bool) -> Result<String> {
		if prerelease { self.latest_prerelease().await } else { self.latest_stable().await }
	}

	/// Reads where /releases/latest redirects: the newest stable release's tag
	/// page, or /releases when there is none yet.
	async fn latest_stable(&self) -> Result<String> {
		let resp = self.no_redirects.get(format!("{}/latest", self.releases_url)).send().await?;
		if resp.status() != reqwest::StatusCode::FOUND {
			bail!("GitHub answered {}", resp.status());
		}
		let location = resp.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).unwrap_or_default();
		let tag = location.rsplit('/').next().unwrap_or_default();
		Ok(if VERSION_PATTERN.is_match(tag) { tag.into() } else { String::new() })
	}

	/// Reads the release feed: the ten newest published releases, never drafts.
	/// A tag with a hyphen is a prerelease, the test release.yml uses.
	async fn latest_prerelease(&self) -> Result<String> {
		let resp = self.http.get(format!("{}.atom", self.releases_url)).send().await?;
		if !resp.status().is_success() {
			bail!("GitHub answered {}", resp.status());
		}
		let feed = resp.text().await?;
		// The feed is ordered by date, so a hotfix beta for an older line would
		// come first; take the highest version instead.
		let mut latest = String::new();
		for tag in feed_tags(&feed) {
			if !tag.contains('-') || !VERSION_PATTERN.is_match(&tag) {
				continue;
			}
			if latest.is_empty() || compare_versions(&tag, &latest) == Ordering::Greater {
				latest = tag;
			}
		}
		Ok(latest)
	}

	/// Backs up the platform and launches the detached updater container. The
	/// caller spawns it detached from the request: a tab closed mid-launch must
	/// not kill the CLI after the container started.
	pub async fn start(&self, version: &str, prerelease: bool, cleanup_old_images: bool) -> Result<()> {
		let mut version = version.to_string();
		if version.is_empty() {
			let (latest, _, err) = self.latest_version(prerelease).await;
			if let Some(err) = err {
				bail!("finding the latest release: {err}");
			}
			version = latest;
		}
		if !VERSION_PATTERN.is_match(&version) {
			bail!("invalid target version {version:?}");
		}
		// The launch removes any updater container first, so a second start would
		// kill one mid-recreate. Claiming the state file under the lock is what
		// makes two simultaneous requests one update. From here the panel renders
		// progress from the state file, so every error path resets it to idle.
		{
			let _claim = self.cache.lock().await;
			if self.state().active() {
				bail!("an update is already running");
			}
			self.write_state(State {
				phase: PHASE_BACKUP.into(),
				target: version.clone(),
				previous: self.cfg.version.clone(),
				..Default::default()
			});
		}
		let launched = tokio::time::timeout(Duration::from_secs(10 * 60), self.launch(&version, cleanup_old_images))
			.await
			.unwrap_or_else(|_| Err(anyhow!("starting the update timed out")));
		if launched.is_err() {
			self.write_state(State { phase: PHASE_IDLE.into(), ..Default::default() });
		}
		launched
	}

	async fn launch(&self, version: &str, cleanup_old_images: bool) -> Result<()> {
		// Platform state only: an update replaces images, it does not touch
		// application volumes, and archiving them would stall every update.
		self.backups.create(false).await.map_err(|err| anyhow!("pre-update backup failed: {err:#}"))?;
		let script = self.write_script()?;
		// A successful update removes its own container; a failed one is kept so
		// `docker logs vexdock-updater` can explain it, and cleared here.
		let _ = Command::new("docker").args(["rm", "-f", "vexdock-updater"]).output().await;
		let root = &self.cfg.root;
		let output = Command::new("docker")
			.args(["run", "--detach", "--name", "vexdock-updater"])
			.args(["-v", "/var/run/docker.sock:/var/run/docker.sock"])
			.args(["-v", &format!("{root}:{root}"), "-w", root])
			.args(["-e", &format!("PLATFORM_ROOT={root}")])
			.args(["-e", &format!("PLATFORM_RAW_BASE={}", self.raw_base)])
			.args(["-e", &format!("PLATFORM_UPDATER_IMAGE={UPDATER_IMAGE}")])
			.args([UPDATER_IMAGE, "sh", &script, version, if cleanup_old_images { "true" } else { "false" }])
			.output()
			.await?;
		if !output.status.success() {
			let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
			combined.push_str(&String::from_utf8_lossy(&output.stderr));
			bail!("start updater: {}", combined.trim());
		}
		Ok(())
	}

	/// The last lines of the updater container's output. A failed update keeps
	/// its container precisely so this can explain it; a missing one reads as no log.
	pub async fn log_tail(&self) -> String {
		let run = Command::new("docker").args(["logs", "--tail", "15", "vexdock-updater"]).kill_on_drop(true).output();
		match tokio::time::timeout(Duration::from_secs(5), run).await {
			Ok(Ok(out)) if out.status.success() => {
				let mut combined = String::from_utf8_lossy(&out.stdout).into_owned();
				combined.push_str(&String::from_utf8_lossy(&out.stderr));
				combined.trim().to_string()
			}
			_ => String::new(),
		}
	}

	/// Materialises the update script into the shared root so the updater
	/// container can execute it.
	fn write_script(&self) -> Result<String> {
		let path = format!("{}/update.sh", self.cfg.system_dir);
		crate::security::create_dir_mode(std::path::Path::new(&self.cfg.system_dir), 0o755)?;
		crate::security::write_file_mode(std::path::Path::new(&path), SCRIPT.as_bytes(), 0o755)?;
		Ok(path)
	}
}

fn http_client(redirects: reqwest::redirect::Policy) -> reqwest::Client {
	reqwest::Client::builder().user_agent("vexdock-updater").redirect(redirects).build().expect("static client config")
}

/// The tag each feed entry links to: the last path segment of its link's href.
fn feed_tags(feed: &str) -> Vec<String> {
	let mut tags = Vec::new();
	for entry in feed.split("<entry>").skip(1) {
		let entry = entry.split("</entry>").next().unwrap_or_default();
		let Some(link) = entry.split("<link").nth(1) else { continue };
		let Some(href) = link.split("href=\"").nth(1).and_then(|rest| rest.split('"').next()) else { continue };
		tags.push(href.rsplit('/').next().unwrap_or_default().to_string());
	}
	tags
}

/// Semantic version precedence for tags with or without the leading v. A tag
/// that does not parse sorts below every one that does, and equal to another
/// that does not, the way golang.org/x/mod/semver.Compare treats them.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
	match (parse_version(a), parse_version(b)) {
		(Some(a), Some(b)) => a.0.cmp(&b.0).then_with(|| compare_prerelease(&a.1, &b.1)),
		(Some(_), None) => Ordering::Greater,
		(None, Some(_)) => Ordering::Less,
		(None, None) => Ordering::Equal,
	}
}

fn parse_version(v: &str) -> Option<([u64; 3], Vec<String>)> {
	if !VERSION_PATTERN.is_match(v) {
		return None;
	}
	let v = v.strip_prefix('v').unwrap_or(v);
	let (core, pre) = v.split_once('-').unwrap_or((v, ""));
	let mut parts = core.split('.').map(|n| n.parse::<u64>().ok());
	let numbers = [parts.next()??, parts.next()??, parts.next()??];
	let pre = if pre.is_empty() { Vec::new() } else { pre.split('.').map(String::from).collect() };
	Some((numbers, pre))
}

/// A release outranks its prereleases; identifiers compare numerically when
/// both are numbers, numbers below words, and a longer list wins a tie.
fn compare_prerelease(a: &[String], b: &[String]) -> Ordering {
	match (a.is_empty(), b.is_empty()) {
		(true, true) => return Ordering::Equal,
		(true, false) => return Ordering::Greater,
		(false, true) => return Ordering::Less,
		_ => {}
	}
	for (x, y) in a.iter().zip(b) {
		let order = match (x.parse::<u64>(), y.parse::<u64>()) {
			(Ok(x), Ok(y)) => x.cmp(&y),
			(Ok(_), Err(_)) => Ordering::Less,
			(Err(_), Ok(_)) => Ordering::Greater,
			(Err(_), Err(_)) => x.cmp(y),
		};
		if order != Ordering::Equal {
			return order;
		}
	}
	a.len().cmp(&b.len())
}

#[cfg(test)]
mod tests;
