//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
)

// ProjectStorageKeyLen is how much of the path hash the viewer's storage key
// carries: 8 bytes, plenty to separate one user's project folders.
const ProjectStorageKeyLen = 16

// ProjectStorageKey derives an opaque, stable per-project key that the viewer
// uses to namespace its own localStorage, and to name the project in the
// preferences every project shares (a window border's colour,
// web/js/utils/project-colour.js). A session's server injects it into its page
// as window.__projectKey; the machine server hands it to the sessions page with
// each session and recent project, so both name a project alike.
//
// The page origin identifies the machine server, not a project: every session
// it runs is served from that one origin under /p/<key>/, so a bare key can hold
// the value another project left behind; and a viewer reaching the server over
// the studio relay sees a single origin for every project on every machine it
// connects to. Keyed by this, a cached preference belongs to
// the project it was set in.
//
// It hashes the path rather than carrying it because the key is visible in a
// localStorage that origin shares with other pages, and where a project lives is
// nobody else's business. Only the path goes in, so the same path on two
// machines is the same key. Empty for an empty path, where the viewer falls back
// to the bare key.
func ProjectStorageKey(projectPath string) string {
	if projectPath == "" {
		return ""
	}
	abs := projectPath
	if a, err := filepath.Abs(projectPath); err == nil {
		abs = a
	}
	sum := sha256.Sum256([]byte(filepath.Clean(abs)))
	return hex.EncodeToString(sum[:])[:ProjectStorageKeyLen]
}
