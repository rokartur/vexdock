package updater

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// Update phases, in the order an update moves through them. Start writes the
// first one; update.sh writes the rest, so its state() helper must stay in
// sync with this file's JSON shape.
const (
	PhaseIdle       = "idle"
	PhaseBackup     = "backup"
	PhasePulling    = "pulling"
	PhaseRestarting = "restarting"
	PhaseDone       = "done"
	PhaseRolledBack = "rolled-back"
)

// State mirrors system/update-state.json. The panel polls it through the API
// to render progress, including across the manager's own restart: the file
// outlives the process being replaced.
type State struct {
	Phase    string `json:"phase"`
	Target   string `json:"target"`
	Previous string `json:"previous"`
	Error    string `json:"error,omitempty"`
	// At is unix seconds of the last phase write.
	At int64 `json:"at"`
}

// Active reports whether an update is still moving. done and rolled-back are
// terminal; idle means none was ever started.
func (st State) Active() bool {
	switch st.Phase {
	case PhaseBackup, PhasePulling, PhaseRestarting:
		return true
	}
	return false
}

// staleAfter caps how long an active phase is believed. An updater that died
// without reaching a terminal phase (host reboot mid-update) would otherwise
// leave the panel showing "updating" forever.
const staleAfter = 30 * time.Minute

func (s *Service) statePath() string {
	return filepath.Join(s.cfg.SystemDir, "update-state.json")
}

// State reads the update state file; a missing, malformed or stale file all
// read as idle.
func (s *Service) State() State {
	data, err := os.ReadFile(s.statePath())
	if err != nil {
		return State{Phase: PhaseIdle}
	}
	var st State
	if err := json.Unmarshal(data, &st); err != nil {
		return State{Phase: PhaseIdle}
	}
	if st.Active() && time.Since(time.Unix(st.At, 0)) > staleAfter {
		return State{Phase: PhaseIdle}
	}
	return st
}

func (s *Service) writeState(st State) {
	st.At = time.Now().Unix()
	data, err := json.Marshal(st)
	if err != nil {
		return
	}
	// Best effort: the update must not fail because progress reporting did.
	_ = os.MkdirAll(s.cfg.SystemDir, 0o755)
	_ = os.WriteFile(s.statePath(), data, 0o644)
}
