//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package webui

import (
	_ "embed"
	"net/http"
)

// wailsRuntimeJS is the @wailsio/runtime bundle shipped by the upstream Wails
// v3 asset server. Both servers that serve pages a desktop window shows — a
// project's server and the machine server — serve this one copy at
// `/wails/runtime.js`. In a desktop window's WKWebView it is what turns
// --wails-draggable into a window drag, and carries the juggler:theme bridge;
// in a browser it is inert, because the native bridges it pokes don't exist.
//
// The Makefile keeps this copy in sync with
// 3rdparty/wails/v3/internal/assetserver/bundledassets/runtime.js because
// the embed directive can't follow symlinks or `..` paths.
//
//go:embed wails_runtime.js
var wailsRuntimeJS []byte

// ServeWailsRuntime serves the embedded @wailsio/runtime bundle.
// GET /wails/runtime.js.
func ServeWailsRuntime(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = w.Write(wailsRuntimeJS)
}

// ServeWailsCustomJS answers the runtime's probe for an optional custom.js (a
// Wails server-mode feature this app does not use). 204 makes the runtime's
// loadOptionalScript see `ok` false, so it injects no empty <script>, and
// keeps a 404 out of the console. GET/HEAD /wails/custom.js.
func ServeWailsCustomJS(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusNoContent)
}
