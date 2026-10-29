//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
)

// UI preferences the viewer keeps server-side: which info cards it has hidden,
// how wide a column was dragged to. Two realms live here — one per window
// (WindowState.UI, keyed by window role) and one per project (Session.UI) —
// and a third, per user, lives in GlobalSettings.UI.
//
// They are stored server-side because browser localStorage is partitioned by
// ORIGIN, and a window's origin is its port. The port is not stable per project:
// the default is 3939 and the next launch increments past whatever is already
// listening, so which project gets which port depends on launch order. A
// relaunch that lands on a different port hands the window a different, usually
// empty, localStorage — and every preference kept there appears to have
// reverted. Keeping these two realms in the session makes them survive it.
//
// The values are opaque: keys are named by the client and the bytes are stored
// verbatim, as MessageHistory and Metadata already are. Nothing in Go reads a
// column width, so a typed field per preference would buy nothing and would have
// to be added to the geometry carry-over in SetWindowState one at a time —
// which is precisely the thing that goes wrong silently. One map is carried over
// once, forever.
//
// json.RawMessage rather than any: Session.Clone copies its maps by walking
// them, and immutable bytes make that a real copy with no deep-clone of an
// arbitrary nested value to get wrong.
//
// What round-trips is the value, not the bytes: the manifest is written
// indented, so a value read back after a save comes back re-indented. No caller
// may depend on the exact spelling it wrote.

// What one realm may hold. session.json is rewritten whole, unbuffered, on every
// save, and settings.json is shared by every project's server — so an unbounded
// map is a way for one viewer to make every later save expensive. The limits are
// far above what the UI stores (a dozen keys of a few hundred bytes) and far
// below where a whole-file rewrite starts to matter.
const (
	maxUIPrefKeys       = 64
	maxUIPrefKeyBytes   = 128
	maxUIPrefValueBytes = 8 << 10
	maxUIPrefTotalBytes = 64 << 10
)

// ErrUIPrefsRejected is a patch the server refused: a key it will not store, a
// value too big, or a map that would grow past its bounds. It is a fault at the
// caller's end rather than a storage failure, so the HTTP layer answers 400 —
// and the whole patch is refused, never partly applied. A viewer told its write
// succeeded when only some of it landed would go on believing it had stored
// something it had not.
var ErrUIPrefsRejected = errors.New("UI preferences rejected")

// cloneUIPrefs copies one realm's map. The values are immutable bytes, so
// copying the map is a genuine copy; nil stays nil, so an untouched realm
// serialises away entirely.
func cloneUIPrefs(prefs map[string]json.RawMessage) map[string]json.RawMessage {
	if prefs == nil {
		return nil
	}
	out := make(map[string]json.RawMessage, len(prefs))
	for key, value := range prefs {
		out[key] = value
	}
	return out
}

// deletesUIPref reports whether a patch value means "forget this key". JSON null
// is how a viewer drops a preference it no longer has; without it a key written
// once could never be cleared.
func deletesUIPref(value json.RawMessage) bool {
	return len(value) == 0 || bytes.Equal(bytes.TrimSpace(value), []byte("null"))
}

// MergeUIPrefs applies patch to cur and returns the result, leaving cur
// untouched. Keys the patch does not name are kept: a viewer PUTs the
// preference it just changed, not the whole document, so an omitted key means
// "unchanged" rather than "deleted".
//
// The bounds are checked against the RESULT, not the patch, so a viewer cannot
// walk past the key limit one key at a time. A map left with nothing in it
// returns nil, so clearing the last preference clears the field from the
// manifest rather than leaving an empty object behind.
func MergeUIPrefs(cur, patch map[string]json.RawMessage) (map[string]json.RawMessage, error) {
	next := cloneUIPrefs(cur)
	if next == nil {
		next = make(map[string]json.RawMessage, len(patch))
	}
	for key, value := range patch {
		if deletesUIPref(value) {
			delete(next, key)
			continue
		}
		if key == "" {
			return nil, fmt.Errorf("%w: a preference must have a name", ErrUIPrefsRejected)
		}
		if len(key) > maxUIPrefKeyBytes {
			return nil, fmt.Errorf("%w: the name %q is %d bytes, over the %d-byte limit",
				ErrUIPrefsRejected, key[:maxUIPrefKeyBytes], len(key), maxUIPrefKeyBytes)
		}
		if len(value) > maxUIPrefValueBytes {
			return nil, fmt.Errorf("%w: %q is %d bytes, over the %d-byte limit",
				ErrUIPrefsRejected, key, len(value), maxUIPrefValueBytes)
		}
		next[key] = value
	}
	if len(next) > maxUIPrefKeys {
		return nil, fmt.Errorf("%w: %d preferences, over the limit of %d",
			ErrUIPrefsRejected, len(next), maxUIPrefKeys)
	}
	total := 0
	for key, value := range next {
		total += len(key) + len(value)
	}
	if total > maxUIPrefTotalBytes {
		return nil, fmt.Errorf("%w: %d bytes in all, over the %d-byte limit",
			ErrUIPrefsRejected, total, maxUIPrefTotalBytes)
	}
	if len(next) == 0 {
		return nil, nil
	}
	return next, nil
}

// GetWindowUIPrefs returns the UI preferences stored for one window role, as a
// copy the caller may do as it likes with. Runs on the actor goroutine so it
// never races a concurrent save.
//
// Unlike theme and zoom there is NO project-wide fallback: a window that has
// stored nothing is answered with nothing. The fallback exists for appearance
// because a project's windows should look alike, and a board detached today
// should open wearing what Juggler is wearing. No such argument applies to a
// column width — a board inheriting the main window's is meaningless — so the
// realms here stay separate.
func (m *SessionManager) GetWindowUIPrefs(role string) map[string]json.RawMessage {
	prefs, _ := runRead(m, func(s *sessionState) (map[string]json.RawMessage, error) {
		if s.session == nil {
			return nil, nil
		}
		s.session.migrateWindowStates()
		return cloneUIPrefs(s.session.WindowStates[role].UI), nil
	})
	return prefs
}

// MergeWindowUIPrefs applies a patch to one window role's preferences and writes
// the session manifest. Before the session is loaded it is a no-op — there is
// nowhere to store it — mirroring SetWindowState.
//
// Only a viewer on this machine may call this: the route is wrapped in
// localViewerOnly, so a phone or laptop browsing in remotely keeps its own
// preferences in its own localStorage instead.
func (m *SessionManager) MergeWindowUIPrefs(role string, patch map[string]json.RawMessage) error {
	_, err := runWrite(m, func(s *sessionState) (struct{}, error) {
		if s.session == nil {
			return struct{}{}, nil
		}
		s.session.migrateWindowStates()
		next, err := MergeUIPrefs(s.session.WindowStates[role].UI, patch)
		if err != nil {
			return struct{}{}, err
		}
		return struct{}{}, setWindowPref(s, role, func(ws *WindowState) { ws.UI = next })
	})
	return err
}

// GetSessionUIPrefs returns the UI preferences shared by every window of this
// project, as a copy. Mirrors GetWindowUIPrefs.
func (m *SessionManager) GetSessionUIPrefs() map[string]json.RawMessage {
	prefs, _ := runRead(m, func(s *sessionState) (map[string]json.RawMessage, error) {
		if s.session == nil {
			return nil, nil
		}
		return cloneUIPrefs(s.session.UI), nil
	})
	return prefs
}

// MergeSessionUIPrefs applies a patch to the project-wide preferences and writes
// the session manifest. Mirrors MergeWindowUIPrefs, including its no-session
// no-op and its local-viewer-only route guard.
//
// It is deliberately not Metadata, which would otherwise do: Metadata is
// broadcast to every viewer and is ungated, so a remote viewer could write it —
// which is the one thing these routes exist to refuse.
func (m *SessionManager) MergeSessionUIPrefs(patch map[string]json.RawMessage) error {
	_, err := runWrite(m, func(s *sessionState) (struct{}, error) {
		if s.session == nil {
			return struct{}{}, nil
		}
		next, err := MergeUIPrefs(s.session.UI, patch)
		if err != nil {
			return struct{}{}, err
		}
		s.session.UI = next
		return struct{}{}, s.store.Save(s.session)
	})
	return err
}
