use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::Updater;

// Update phases, in the order an update moves through them. start writes the
// first one; update.sh writes the rest, so its state() helper must stay in
// sync with this file's JSON shape.
pub const PHASE_IDLE: &str = "idle";
pub const PHASE_BACKUP: &str = "backup";
pub const PHASE_PULLING: &str = "pulling";
pub const PHASE_RESTARTING: &str = "restarting";
pub const PHASE_DONE: &str = "done";
pub const PHASE_ROLLED_BACK: &str = "rolled-back";

/// Mirrors system/update-state.json. The panel polls it through the API to
/// render progress, including across the manager's own restart: the file
/// outlives the process being replaced.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct State {
	#[serde(default)]
	pub phase: String,
	#[serde(default)]
	pub target: String,
	#[serde(default)]
	pub previous: String,
	#[serde(default, skip_serializing_if = "String::is_empty")]
	pub error: String,
	/// Unix seconds of the last phase write.
	#[serde(default)]
	pub at: i64,
}

impl State {
	/// Whether an update is still moving. done and rolled-back are terminal;
	/// idle means none was ever started.
	pub fn active(&self) -> bool {
		matches!(self.phase.as_str(), PHASE_BACKUP | PHASE_PULLING | PHASE_RESTARTING)
	}

	fn idle() -> State {
		State { phase: PHASE_IDLE.into(), ..Default::default() }
	}
}

/// Caps how long an active phase is believed. An updater that died without
/// reaching a terminal phase (host reboot mid-update) would otherwise leave
/// the panel showing "updating" forever.
const STALE_AFTER: Duration = Duration::from_secs(30 * 60);

impl Updater {
	pub(super) fn state_path(&self) -> String {
		format!("{}/update-state.json", self.cfg.system_dir)
	}

	/// The update state file; a missing, malformed or stale file all read as idle.
	pub fn state(&self) -> State {
		let Ok(data) = std::fs::read(self.state_path()) else { return State::idle() };
		let Ok(st) = serde_json::from_slice::<State>(&data) else { return State::idle() };
		if st.active() && chrono::Utc::now().timestamp() - st.at > STALE_AFTER.as_secs() as i64 {
			return State::idle();
		}
		st
	}

	pub(super) fn write_state(&self, mut st: State) {
		st.at = chrono::Utc::now().timestamp();
		let Ok(data) = serde_json::to_vec(&st) else { return };
		// Best effort: the update must not fail because progress reporting did.
		let _ = std::fs::create_dir_all(&self.cfg.system_dir);
		// The panel polls this file while it is written, and a half-written
		// document reads as idle, so the rename keeps progress monotonic.
		let tmp = format!("{}.tmp", self.state_path());
		if std::fs::write(&tmp, data).is_ok() {
			let _ = std::fs::rename(tmp, self.state_path());
		}
	}
}
