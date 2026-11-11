//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package web provides embedded static files for the web frontend.
package web

import (
	"embed"
	"io/fs"
)

// Licensing: sdk/ and extensions/ are Apache-2.0 (see their LICENSE files);
// everything else embedded here is AGPL-3.0-or-later (see the root LICENSE).
// Mixing them in one embed.FS is fine — see LICENSING.md at the repo root.
//
//go:embed css/* js/* extensions/* sdk/* resources/* i18n/* machine/* shell/* index.html engine.html sandbox.html
var builtin embed.FS

// Shell is the desktop window's shell and nothing more: the shared templates
// in shell/ (the header bar's stylesheets, the pre-paint window-mode script,
// the caption controls, edge resize and fullscreen), what they load, the
// notice pattern a stand-in's message is laid out by, and the sessions page's
// stylesheet, whose buttons a stand-in wears.
// It is what the desktop app links to draw its own pages (cmd/juggler-app,
// stand_in.go) — a megabyte, where Files is the whole tree. A binary that links
// both shares the bytes of the files they have in common.
//
// The modules listed are the static import graph of the ones shell/ loads;
// TestStandInPageResolvesFromTheShell in cmd/juggler-app names any it misses.
//
//go:embed shell/*
//go:embed css/base/fonts.css css/base/reset.css css/base/elements.css css/base/text-selection.css
//go:embed css/tokens/scale.css css/tokens/theme-dark.css css/tokens/theme-light.css
//go:embed css/layout/app-shell.css css/layout/window-chrome.css css/layout/app-header.css
//go:embed css/patterns/notice.css css/patterns/buttons.css
//go:embed machine/sessions.css
//go:embed resources/fonts/* resources/juggler-logo.svg resources/juggler-logo-with-name.svg resources/chrome-pattern.svg
//go:embed js/components/window-caption-controls.js js/components/window-caption-glyphs.js js/components/juggler-element.js
//go:embed js/utils/window-edge-resize.js js/utils/window-fullscreen.js js/utils/window-history-buttons.js js/utils/window-resize-cursor.js js/utils/window-shell-theme.js js/utils/fault-report.js
//go:embed js/services/http.js
//go:embed sdk/lib/window-control.js sdk/lib/i18n.js sdk/lib/html.js sdk/lib/error-utils.js
var Shell embed.FS

// FS is the capability set consumers of the asset tree rely on. embed.FS
// satisfies it, and so does the overlay installed by SetOverlay.
type FS interface {
	fs.FS
	fs.ReadFileFS
	fs.ReadDirFS
}

// Files is the asset tree the server serves. By default it is exactly the
// embedded tree; SetOverlay layers additional assets over it. Read at server
// startup — do not reassign after the server has started.
//
// A pointer, not a copy: converting the embed.FS value would make Files
// initialised at run time, which keeps the whole tree in every binary that
// imports this package, Shell's users included. &builtin is static data the
// linker drops from a binary that never reads Files.
var Files FS = &builtin

// SetOverlay layers extra assets over the embedded tree: lookups check the
// overlay first and fall back to the embedded files, and directory listings
// merge both (overlay wins on a name collision). This is the seam a
// distribution with additional components (e.g. extra extensions under
// extensions/<name>/) uses to add assets without editing this repository.
// Call before the server starts; passing nil restores the embedded tree.
func SetOverlay(overlay fs.FS) {
	if overlay == nil {
		Files = &builtin
		return
	}
	Files = &overlayFS{base: &builtin, overlay: overlay}
}
