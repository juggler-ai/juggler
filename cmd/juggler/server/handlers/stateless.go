//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"net/http"
	"time"

	"juggler/internal/jlog"
)

// The handlers here need nothing injected at all, so they are plain functions
// rather than methods on an API struct.

// HandleHealth reports that the server is up, with its current Unix time.
func HandleHealth(w http.ResponseWriter, r *http.Request) {
	WriteJSON(w, r, 0, map[string]any{
		"status": "ok",
		"time":   time.Now().Unix(),
	})
}

// engineHostReportMax bounds an engine-host report: twenty console lines of
// 300 characters and a list of in-flight URLs, with room to spare.
const engineHostReportMax = 12_000

// HandleClientReport is the frontend → application-log bridge. The desktop app's
// WebView console (and the engine's hidden worker WebView console) can't be read
// in a shipped build, so a fault a real user hits would otherwise vanish — this
// endpoint lands it in the app log they can send us. Three callers use it:
//   - the worker-backed engine runtime (web/js/engine-worker-runtime.js), which
//     reports its boot outcome; it predates the generic bridge, so an omitted (or
//     "engine") source keeps its original, descriptive wording.
//   - the viewer's chime path (web/js/utils/chime-synth.js), which reports the
//     rare untoward audio events (a wedged/rebuilt context, a resume that never
//     recovers, a fresh context that comes up interrupted, no Web Audio at all)
//     tagged source "chime".
//   - the engine's conversation loader (web/js/services/conversation-loader.js),
//     which reports a conversation it failed to auto-load, tagged source
//     "engine-autoload".
//   - the engine page's main thread (web/js/engine-worker-main.js), which
//     reports a worker that stopped answering it, with the fetches and console
//     lines it had in flight, tagged source "engine-host". That report is the
//     only one allowed to run long (engineHostReportMax).
//
// Body: {source?, event?, message?, stack?}. event "error" logs at Error,
// "ready" at Info, anything else at Debug. Callers send only untoward events, so
// the app log stays quiet unless something actually went wrong.
func HandleClientReport(w http.ResponseWriter, r *http.Request) {
	body, ok := DecodeJSON[struct {
		Source  string `json:"source"`
		Event   string `json:"event"`
		Message string `json:"message"`
		Stack   string `json:"stack"`
	}](w, r)
	if !ok {
		return
	}

	// The engine runtime's boot telemetry keeps its original wording verbatim.
	if body.Source == "" || body.Source == "engine" {
		switch body.Event {
		case "ready":
			jlog.Info("[engine] worker runtime ready")
		case "error":
			jlog.Error("[engine] worker runtime error: %v\nstack: %v", body.Message, body.Stack)
		default:
			jlog.Debug("[engine] worker runtime report: %v", body.Event)
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// Any other source (e.g. the chime path) logs generically, tagged by source.
	// Both strings are client-supplied and land verbatim in the app log, so bound
	// them defensively.
	source, msg := body.Source, body.Message
	if len(source) > 32 {
		source = source[:32]
	}
	maxMsg := 500
	if source == "engine-host" {
		maxMsg = engineHostReportMax
	}
	if len(msg) > maxMsg {
		msg = msg[:maxMsg]
	}
	if body.Event == "error" {
		jlog.Error("[%s] %s", source, msg)
	} else {
		jlog.Info("[%s] %s", source, msg)
	}
	w.WriteHeader(http.StatusNoContent)
}
