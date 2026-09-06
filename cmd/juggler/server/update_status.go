//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http"
	"os"
	"runtime"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/server/handlers"
	"juggler/internal/httpx"
	"juggler/internal/jlog"
	"juggler/internal/updatecheck"
)

// updateManifestURL resolves the version-manifest URL: JUGGLER_VERSION_MANIFEST_URL
// overrides the well-known default (used by tests and staging).
func updateManifestURL() string {
	if u := os.Getenv("JUGGLER_VERSION_MANIFEST_URL"); u != "" {
		return u
	}
	return updatecheck.DefaultManifestURL
}

// newUpdateChecker builds the version-manifest checker for this build, wiring
// OnChange to push the new status to every connected viewer. The poll loop is
// started later by startUpdateChecker.
func (s *Server) newUpdateChecker() *updatecheck.Checker {
	return updatecheck.New(updatecheck.Config{
		URL:            updateManifestURL(),
		CurrentVersion: core.Version,
		OS:             runtime.GOOS,
		Arch:           runtime.GOARCH,
		// Proxy-aware so update checks work from behind a proxy.
		Client: httpx.Client(10 * time.Second),
		OnChange: func(st updatecheck.Status) {
			s.broadcastToAll(updateStatusMsg{Type: "update-status", Status: st})
		},
		// Gate the scheduled poll on the user's update mode: "off" suspends
		// automatic checking (the ticker keeps running but no-ops), while
		// "automatic"/"notify" both poll. The manual endpoint bypasses this.
		Enabled: func() bool { return s.updateMode() != core.UpdateModeOff },
		Mark:    func() (int, func()) { return claimFirstCheck(time.Now()) },
	})
}

// startUpdateChecker begins polling, unless this is a test-mode server (the
// suite must never reach the network) — in which case /api/update-status still
// answers with the seeded "no update" status.
func (s *Server) startUpdateChecker() {
	if s.testMode {
		return
	}
	if s.updateChecker == nil {
		return
	}
	jlog.Info("updatecheck: polling %s", updateManifestURL())
	s.updateChecker.Start(s.shutdownChan)
}

// What a check can be the first of. They nest — the first check of a month is
// necessarily the first of its day — so a mark is only ever 0, 1 or 3.
const (
	firstOfDay   = 1
	firstOfMonth = 2
)

// claimFirstCheck reports what this scheduled check is the first of, and records
// it so the later checks that day report nothing. The record lives in the
// settings document, which is what serialises the several servers one machine
// runs; UTC, so the day boundary doesn't move with the timezone.
//
// The record is written before the request it describes, so release takes it
// back when the request never arrived — otherwise a machine offline at its first
// poll of the day would spend the day on a request nobody received. release is
// never nil and must be called at most once.
func claimFirstCheck(now time.Time) (int, func()) {
	day := now.UTC().Format(time.DateOnly)
	month := day[:len("2006-01")]

	mark := 0
	var prevDay, prevMonth string
	if _, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
		if gs.Updates.LastCountedDay == day {
			return false
		}
		prevDay, prevMonth = gs.Updates.LastCountedDay, gs.Updates.LastCountedMonth
		mark = firstOfDay
		gs.Updates.LastCountedDay = day
		if gs.Updates.LastCountedMonth != month {
			mark |= firstOfMonth
			gs.Updates.LastCountedMonth = month
		}
		return true
	}); err != nil {
		jlog.Info("updatecheck: %v", err)
		return 0, func() {}
	}
	if mark == 0 {
		return 0, func() {}
	}

	return mark, func() {
		if _, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
			if gs.Updates.LastCountedDay != day {
				return false // moved on since; not ours to undo
			}
			gs.Updates.LastCountedDay = prevDay
			if mark&firstOfMonth != 0 && gs.Updates.LastCountedMonth == month {
				gs.Updates.LastCountedMonth = prevMonth
			}
			return true
		}); err != nil {
			jlog.Info("updatecheck: %v", err)
		}
	}
}

// updateStatusMsg is the WS push envelope; embedding Status promotes its fields
// (currentVersion, latestVersion, updateAvailable, notice) to the top level
// alongside the type tag, matching the /api/update-status response shape.
type updateStatusMsg struct {
	Type string `json:"type"`
	updatecheck.Status
}

// handleUpdateStatus returns the latest computed update decision for this build.
func (s *Server) handleUpdateStatus(w http.ResponseWriter, r *http.Request) {
	var st updatecheck.Status
	if s.updateChecker != nil {
		st = s.updateChecker.Current()
	} else {
		st = updatecheck.Status{CurrentVersion: core.Version}
	}
	handlers.WriteJSON(w, r, 0, st)
}
