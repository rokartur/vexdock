use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering as Atomic};

use axum::extract::State as AxumState;
use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};

use super::*;
use crate::docker::Docker;

/// An updater whose state lives in a temporary system dir and whose release
/// lookups go to releases_url.
fn updater(version: &str, releases_url: &str) -> (tempfile::TempDir, Updater) {
	let dir = tempfile::tempdir().unwrap();
	let mut cfg = Config::at(dir.path().to_str().unwrap());
	cfg.version = version.into();
	let cfg = Arc::new(cfg);
	let db = Arc::new(crate::database::Db::open(&format!("{}/app.db", cfg.root)).unwrap());
	let backups = Arc::new(Backup::new(Arc::clone(&cfg), db, Arc::new(Docker::unreachable())));
	let mut u = Updater::new(cfg, backups, "o/r");
	u.releases_url = releases_url.into();
	(dir, u)
}

#[test]
fn state_reads_idle_for_missing_malformed_or_stale() {
	let (_dir, s) = updater("v1.0.0", "");
	assert_eq!(s.state().phase, PHASE_IDLE, "missing file");

	s.write_state(State { phase: PHASE_PULLING.into(), target: "v1.1.0".into(), ..Default::default() });
	let st = s.state();
	assert_eq!((st.phase.as_str(), st.target.as_str()), (PHASE_PULLING, "v1.1.0"));

	let write = |st: State| std::fs::write(s.state_path(), serde_json::to_vec(&st).unwrap()).unwrap();
	let old = chrono::Utc::now().timestamp() - 3600;
	write(State { phase: PHASE_PULLING.into(), target: "v1.1.0".into(), at: old, ..Default::default() });
	assert_eq!(s.state().phase, PHASE_IDLE, "stale active state");

	// Terminal phases are results, not liveness claims; age must not erase them.
	write(State { phase: PHASE_ROLLED_BACK.into(), target: "v1.1.0".into(), error: "pull failed".into(), at: old, ..Default::default() });
	let st = s.state();
	assert_eq!((st.phase.as_str(), st.error.as_str()), (PHASE_ROLLED_BACK, "pull failed"));

	std::fs::write(s.state_path(), "not json").unwrap();
	assert_eq!(s.state().phase, PHASE_IDLE, "malformed file");
}

#[test]
fn prerelease_track_cases() {
	for (setting, current, want) in
		[("true", "v1.0.0", true), ("false", "v1.0.0-beta.1", false), ("", "v1.0.0-beta.1", true), ("", "v1.0.0", false)]
	{
		assert_eq!(prerelease_track(setting, current), want, "{setting:?} {current:?}");
	}
}

#[test]
fn compare_versions_follows_semver() {
	assert_eq!(compare_versions("v0.1.0-beta.10", "v0.1.0-beta.9"), Ordering::Greater);
	assert_eq!(compare_versions("v0.1.0", "v0.1.0-beta.9"), Ordering::Greater);
	assert_eq!(compare_versions("0.2.0", "v0.1.9"), Ordering::Greater);
	assert_eq!(compare_versions("v0.1.0-beta.2", "v0.1.0-beta.2"), Ordering::Equal);
	assert_eq!(compare_versions("v0.1.0-alpha", "v0.1.0-1"), Ordering::Greater);
	assert_eq!(compare_versions("v0.0.1", "dev"), Ordering::Greater);
}

/// Answers the two pages the updater reads, the way github.com does.
#[derive(Default)]
struct FakeGitHub {
	/// Where /releases/latest redirects; empty means no stable release.
	stable: Mutex<String>,
	/// Tags in /releases.atom, newest first.
	feed: Mutex<Vec<String>>,
	/// When set, every request gets this instead.
	status: Mutex<Option<StatusCode>>,
	hits: AtomicUsize,
}

impl FakeGitHub {
	fn new(stable: &str, feed: &[&str]) -> Arc<FakeGitHub> {
		let gh = FakeGitHub::default();
		*gh.stable.lock().unwrap() = stable.into();
		gh.set_feed(feed);
		Arc::new(gh)
	}

	fn set_feed(&self, feed: &[&str]) {
		*self.feed.lock().unwrap() = feed.iter().map(|t| t.to_string()).collect();
	}

	async fn serve(self: &Arc<Self>) -> String {
		let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
		let addr = listener.local_addr().unwrap();
		let app = axum::Router::new().fallback(answer).with_state(Arc::clone(self));
		tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
		format!("http://{addr}/releases")
	}
}

async fn answer(AxumState(gh): AxumState<Arc<FakeGitHub>>, uri: Uri) -> Response {
	gh.hits.fetch_add(1, Atomic::SeqCst);
	if let Some(status) = *gh.status.lock().unwrap() {
		return status.into_response();
	}
	match uri.path() {
		"/releases/latest" => {
			let stable = gh.stable.lock().unwrap().clone();
			let target = if stable.is_empty() { "/releases".to_string() } else { format!("/releases/tag/{stable}") };
			let mut headers = HeaderMap::new();
			headers.insert(header::LOCATION, target.parse().unwrap());
			(StatusCode::FOUND, headers).into_response()
		}
		"/releases.atom" => {
			let mut body = String::from(r#"<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">"#);
			for tag in gh.feed.lock().unwrap().iter() {
				body.push_str(&format!(
					r#"<entry><link rel="alternate" type="text/html" href="https://github.com/o/r/releases/tag/{tag}"/></entry>"#
				));
			}
			body.push_str("</feed>");
			([(header::CONTENT_TYPE, "application/atom+xml")], body).into_response()
		}
		path => panic!("unexpected path {path}"),
	}
}

#[tokio::test]
async fn latest_version_skips_stable_on_prerelease_track() {
	let gh = FakeGitHub::new("", &["v0.1.0", "v0.1.0-beta.2", "v0.1.0-beta.1"]);
	let (_dir, s) = updater("v0.1.0-beta.1", &gh.serve().await);
	let st = s.status(true).await;
	assert_eq!(st.latest, "v0.1.0-beta.2");
	assert!(st.update_available && st.beta, "{st:?}");
}

#[tokio::test]
async fn latest_version_refreshes_after_two_minutes() {
	let gh = FakeGitHub::new("", &["v0.1.0-beta.8"]);
	let (_dir, s) = updater("v0.1.0-beta.8", &gh.serve().await);
	assert!(!s.status(true).await.update_available);

	gh.set_feed(&["v0.1.0-beta.9"]);
	s.cache.lock().await.asked_at = Instant::now().checked_sub(CACHE_FOR);
	let st = s.status(true).await;
	assert_eq!(st.latest, "v0.1.0-beta.9");
	assert!(st.update_available);
}

// The panel's "check for updates" button exists so a release published inside
// the cache window shows up now instead of in two minutes.
#[tokio::test]
async fn invalidate_forces_fresh_lookup() {
	let gh = FakeGitHub::new("", &["v0.1.0-beta.8"]);
	let (_dir, s) = updater("v0.1.0-beta.8", &gh.serve().await);
	assert!(!s.status(true).await.checked_at.is_empty());

	gh.set_feed(&["v0.1.0-beta.9"]);
	assert_ne!(s.status(true).await.latest, "v0.1.0-beta.9", "the cache answered with the new tag");

	s.invalidate().await;
	let st = s.status(true).await;
	assert_eq!(st.latest, "v0.1.0-beta.9");
	assert!(st.update_available);
}

// A failed lookup must not pass the last answer off as current, and the public
// GET must not turn every poll into another request GitHub refuses.
#[tokio::test]
async fn failed_lookup_keeps_last_answer_and_says_why() {
	let gh = FakeGitHub::new("", &["v0.1.0-beta.99"]);
	let (_dir, s) = updater("v0.1.0-beta.99", &gh.serve().await);
	let good = s.status(true).await;

	*gh.status.lock().unwrap() = Some(StatusCode::TOO_MANY_REQUESTS);
	s.invalidate().await;
	let st = s.status(true).await;
	assert_eq!(st.latest, "v0.1.0-beta.99");
	assert_eq!(st.checked_at, good.checked_at);
	assert!(st.check_error.contains("429"), "check_error = {:?}", st.check_error);

	s.status(true).await;
	assert_eq!(gh.hits.load(Atomic::SeqCst), 2, "a failure is cached like an answer");
}

#[tokio::test]
async fn latest_version_skips_prerelease_on_stable_track() {
	let gh = FakeGitHub::new("v0.0.9", &["v0.1.0-beta.2", "v0.0.9"]);
	let (_dir, s) = updater("v0.0.9", &gh.serve().await);
	let st = s.status(false).await;
	assert_eq!(st.latest, "v0.0.9");
	assert!(!st.update_available && !st.beta, "{st:?}");
}

// With no stable release GitHub redirects /releases/latest to /releases.
#[tokio::test]
async fn stable_track_without_stable_release_is_unknown() {
	let gh = FakeGitHub::new("", &["v0.1.0-beta.2"]);
	let (_dir, s) = updater("v0.0.9", &gh.serve().await);
	let st = s.status(false).await;
	assert!(st.latest.is_empty() && !st.update_available && st.check_error.is_empty(), "{st:?}");
}

// The feed is ordered by date, so a beta of an older line can come first and an
// installed beta.10 must not be offered beta.9.
#[tokio::test]
async fn latest_version_picks_highest_semver_not_first_entry() {
	let gh = FakeGitHub::new("", &["v0.1.0-beta.9", "v0.1.0-beta.2", "v0.1.0-beta.10", "v0.1.0-beta.1"]);
	let (_dir, s) = updater("v0.1.0-beta.10", &gh.serve().await);
	let st = s.status(true).await;
	assert_eq!(st.latest, "v0.1.0-beta.10");
	assert!(!st.update_available, "offered a downgrade: {st:?}");
}

const FAKE_DOCKER: &str = r#"#!/bin/sh
set -eu
case "$1" in
    compose)
        case "$*" in
            *" config --images")
                if grep -q '^VERSION=v1.1.0$' "$PLATFORM_ROOT/.env"; then
                    printf '%s\n' ghcr.io/test/manager:v1.1.0 ghcr.io/test/auth:shared
                else
                    printf '%s\n' ghcr.io/test/manager:v1.0.0 ghcr.io/test/auth:shared
                fi
                ;;
            *" pull"|*" up -d --remove-orphans") ;;
            *) echo "unexpected compose command: $*" >&2; exit 1 ;;
        esac
        ;;
    inspect) echo healthy ;;
    ps) printf '%s\n' 'vexdock-manager strangers' "vexdock-auth $(basename "$PLATFORM_ROOT")" ;;
    image)
        [ "$2" = rm ]
        printf '%s\n' "$3" >> "$REMOVED_IMAGES"
        ;;
    rm)
        if [ "$3" = vexdock-updater ]; then
            : > "$PLATFORM_ROOT/self-removed"
        else
            printf '%s\n' "$3" >> "$PLATFORM_ROOT/removed-containers"
        fi
        ;;
    *) echo "unexpected docker command: $*" >&2; exit 1 ;;
esac
"#;

#[test]
fn update_script_cleans_previous_images_only_when_requested() {
	use std::os::unix::fs::PermissionsExt;
	for (cleanup, want) in [("false", ""), ("true", "ghcr.io/test/manager:v1.0.0")] {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path();
		let bin = root.join("bin");
		std::fs::create_dir_all(root.join("system")).unwrap();
		std::fs::create_dir(&bin).unwrap();
		std::fs::write(root.join("compose.yml"), "services: {}\n").unwrap();
		std::fs::write(root.join(".env"), "").unwrap();
		std::fs::write(root.join("update.sh"), SCRIPT).unwrap();
		std::fs::write(bin.join("docker"), FAKE_DOCKER).unwrap();
		std::fs::set_permissions(bin.join("docker"), std::fs::Permissions::from_mode(0o755)).unwrap();
		let removed_path = root.join("removed-images");

		let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default());
		let out = std::process::Command::new("sh")
			.args(["update.sh", "v1.1.0", cleanup])
			.current_dir(root)
			.env("PATH", path)
			.env("PLATFORM_ROOT", root)
			.env("REMOVED_IMAGES", &removed_path)
			.output()
			.unwrap();
		assert!(out.status.success(), "update script: {}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));

		assert!(root.join("self-removed").exists(), "a successful update did not remove its own container");
		let containers = std::fs::read_to_string(root.join("removed-containers")).unwrap();
		assert_eq!(containers, "vexdock-manager\n", "only the container another project holds is removed before the recreate");

		// The script's state() helper must write JSON the State reader understands.
		let (_unused, mut reader) = updater("v1.0.0", "");
		let mut cfg = (*reader.cfg).clone();
		cfg.system_dir = root.join("system").to_string_lossy().into_owned();
		reader.cfg = Arc::new(cfg);
		let st = reader.state();
		assert_eq!((st.phase.as_str(), st.target.as_str()), (PHASE_DONE, "v1.1.0"));

		let removed = std::fs::read_to_string(&removed_path).unwrap_or_default();
		assert_eq!(removed.trim(), want, "cleanup={cleanup}");
	}
}
