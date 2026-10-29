//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"net/http"
	"strconv"

	"juggler/cmd/juggler/msg"
	"juggler/internal/logpaths"
)

// maxInitialLogBytes caps the first read of a log file so opening a large,
// long-lived log tails the most recent window rather than dumping megabytes
// into the viewer. The incremental (offset-based) reads that follow are
// uncapped — they only ever return the bytes appended since the last poll.
const maxInitialLogBytes = 256 * 1024

// LogsAPI serves the read-only /api/logs endpoints behind the Logs settings
// page. Which files exist and how they are read is logpaths'; this only scopes
// the listing to the current project.
type LogsAPI struct {
	pathProvider func() string
}

// NewLogsAPI creates a LogsAPI. pathProvider returns the project path.
func NewLogsAPI(pathProvider func() string) *LogsAPI {
	return &LogsAPI{pathProvider: pathProvider}
}

// HandleList returns the log files for the current session: this project
// server's own logs (server.log, server.stderr.log, and each per-conversation
// log) plus the shared desktop app.log. Files that don't exist yet are omitted.
func (api *LogsAPI) HandleList(w http.ResponseWriter, r *http.Request) {
	WriteJSON(w, r, 0, map[string]any{
		"logDir": logpaths.LogDir(),
		"files":  logpaths.SessionLogs(api.pathProvider()),
	})
}

// HandleContent streams a byte window of one log file. The client passes the
// offset it has already consumed; the handler returns everything appended since
// (or a capped tail on the first read), so the viewer can follow a growing log
// with cheap incremental polls. The path must resolve inside the log directory.
func (api *LogsAPI) HandleContent(w http.ResponseWriter, r *http.Request) {
	abs, ok := logpaths.Resolve(r.URL.Query().Get("path"))
	if !ok {
		WriteMessageError(w, r, http.StatusForbidden, msg.New("path is not a Juggler log file"))
		return
	}
	offset, _ := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
	win, err := logpaths.ReadWindow(abs, offset, maxInitialLogBytes)
	if err != nil {
		WriteMessageError(w, r, http.StatusNotFound, msg.New("log file is unavailable"))
		return
	}
	WriteJSON(w, r, 0, win)
}
