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
