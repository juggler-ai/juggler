//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

// The viewer's UI preferences — which info cards are hidden, how wide a column
// was dragged — are stored server-side because browser localStorage is
// partitioned by origin, and a window's origin is its port. The port is not
// stable per project (the default is taken, the next launch increments past it),
// so a relaunch hands the window a different, usually empty, store and the
// settings appear to revert. These tests pin the server-side half: what is
// stored survives a reopen, one window's preferences are not another's, a patch
// merges rather than replaces, and a patch over the bounds is refused whole.

// uiPatch builds a patch from a JSON object literal, so a test reads as the
// request body the viewer actually sends.
func uiPatch(t *testing.T, body string) map[string]json.RawMessage {
	t.Helper()
	var patch map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &patch); err != nil {
		t.Fatalf("uiPatch(%s): %v", body, err)
	}
	return patch
}

// wantUIPref asserts one key's stored JSON, since the server holds these values
// as opaque bytes and never as a parsed shape.
//
// Compared compacted, not byte for byte: the manifest is written indented, so a
// value that has been through a save and a load comes back re-indented. The
// bytes are not promised — the value is.
func wantUIPref(t *testing.T, prefs map[string]json.RawMessage, key, want string) {
	t.Helper()
	got, ok := prefs[key]
	if !ok {
		t.Fatalf("no stored value for %q; have %v", key, uiPrefKeys(prefs))
	}
	if compactJSON(t, string(got)) != compactJSON(t, want) {
		t.Fatalf("%q: got %s want %s", key, got, want)
	}
}

// compactJSON strips the insignificant whitespace out of a JSON value.
func compactJSON(t *testing.T, raw string) string {
	t.Helper()
	var buf bytes.Buffer
	if err := json.Compact(&buf, []byte(raw)); err != nil {
		t.Fatalf("compact %s: %v", raw, err)
	}
	return buf.String()
}

// uiPrefKeys names what is stored, for a failure message that says what was
// there instead of what was missing.
func uiPrefKeys(prefs map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(prefs))
	for key := range prefs {
		keys = append(keys, key)
	}
	return keys
}

func TestWindowUIPrefsMergeRatherThanReplace(t *testing.T) {
	m := newManagerForTest(t)
	board := WindowRolePinboardFor("board_a")

	if err := m.MergeWindowUIPrefs(board, uiPatch(t, `{
		"juggler-column-width": "31.5",
		"juggler-info-cards-hidden": {"hidden": ["tips"]}
	}`)); err != nil {
		t.Fatalf("first merge: %v", err)
	}
	// A second patch naming one key leaves the other alone: the viewer PUTs the
	// preference it just changed, not the whole document, so an omitted key is
	// "unchanged" rather than "deleted".
	if err := m.MergeWindowUIPrefs(board, uiPatch(t, `{"juggler-column-width": "40"}`)); err != nil {
		t.Fatalf("second merge: %v", err)
	}

	prefs := m.GetWindowUIPrefs(board)
	wantUIPref(t, prefs, "juggler-column-width", `"40"`)
	wantUIPref(t, prefs, "juggler-info-cards-hidden", `{"hidden": ["tips"]}`)
}

// A null value deletes: it is how a viewer drops a preference it no longer has,
// and without it a key written once could never be cleared.
func TestWindowUIPrefsNullDeletes(t *testing.T) {
	m := newManagerForTest(t)

	if err := m.MergeWindowUIPrefs(WindowRoleMain, uiPatch(t, `{"a": 1, "b": 2}`)); err != nil {
		t.Fatalf("merge: %v", err)
	}
	if err := m.MergeWindowUIPrefs(WindowRoleMain, uiPatch(t, `{"a": null}`)); err != nil {
		t.Fatalf("delete: %v", err)
	}

	prefs := m.GetWindowUIPrefs(WindowRoleMain)
	if _, ok := prefs["a"]; ok {
		t.Fatalf("null must delete the key, got %s", prefs["a"])
	}
	wantUIPref(t, prefs, "b", `2`)
}

// Unlike theme and zoom, a window with no preferences of its own is answered
// with nothing rather than the project's. A detached board inheriting the main
// window's column width is meaningless — there is no cross-window coherence to
// keep, as there is with the theme a project is wearing.
func TestWindowUIPrefsDoNotFallBackToTheProject(t *testing.T) {
	m := newManagerForTest(t)

	if err := m.MergeSessionUIPrefs(uiPatch(t, `{"juggler-column-width": "40"}`)); err != nil {
		t.Fatalf("merge project: %v", err)
	}
	if err := m.MergeWindowUIPrefs(WindowRoleMain, uiPatch(t, `{"juggler-pinboard-width": "20"}`)); err != nil {
		t.Fatalf("merge window: %v", err)
	}

	if got := m.GetWindowUIPrefs(WindowRolePinboardFor("board_a")); len(got) != 0 {
		t.Fatalf("a board with nothing of its own must be answered with nothing, got %v", uiPrefKeys(got))
	}
	if _, ok := m.GetWindowUIPrefs(WindowRoleMain)["juggler-column-width"]; ok {
		t.Fatal("the project's preferences must not leak into a window's")
	}
	wantUIPref(t, m.GetSessionUIPrefs(), "juggler-column-width", `"40"`)
	if _, ok := m.GetSessionUIPrefs()["juggler-pinboard-width"]; ok {
		t.Fatal("nor a window's into the project's")
	}
}

func TestWindowUIPrefsAreIndependentPerWindow(t *testing.T) {
	m := newManagerForTest(t)
	a := WindowRolePinboardFor("board_a")
	b := WindowRolePinboardFor("board_b")

	if err := m.MergeWindowUIPrefs(a, uiPatch(t, `{"juggler-pinboard-width": "20"}`)); err != nil {
		t.Fatalf("merge a: %v", err)
	}
	if err := m.MergeWindowUIPrefs(b, uiPatch(t, `{"juggler-pinboard-width": "55"}`)); err != nil {
		t.Fatalf("merge b: %v", err)
	}

	wantUIPref(t, m.GetWindowUIPrefs(a), "juggler-pinboard-width", `"20"`)
	wantUIPref(t, m.GetWindowUIPrefs(b), "juggler-pinboard-width", `"55"`)
}

// The bug this whole seam exists for: the settings have to be there after the
// app is relaunched onto a different port.
func TestUIPrefsSurviveReopeningTheProject(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	if err := store.Save(NewSession()); err != nil {
		t.Fatalf("seed: %v", err)
	}
	board := WindowRolePinboardFor("board_a")

	m := startManager(store, dir)
	if err := m.MergeWindowUIPrefs(board, uiPatch(t, `{"juggler-info-cards-hidden": {"hidden":["tips"]}}`)); err != nil {
		t.Fatalf("merge window: %v", err)
	}
	if err := m.MergeSessionUIPrefs(uiPatch(t, `{"juggler-column-width": "31.5"}`)); err != nil {
		t.Fatalf("merge project: %v", err)
	}
	m.Shutdown()

	store2, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	m2 := startManager(store2, dir)
	t.Cleanup(m2.Shutdown)

	wantUIPref(t, m2.GetWindowUIPrefs(board), "juggler-info-cards-hidden", `{"hidden":["tips"]}`)
	wantUIPref(t, m2.GetSessionUIPrefs(), "juggler-column-width", `"31.5"`)
	if _, err := store2.Load(); err != nil {
		t.Fatalf("the manifest at %s no longer loads: %v", filepath.Join(dir, ".juggler", "session.json"), err)
	}
}

// GetWindowUIPrefs hands out a copy. The live map is owned by the actor
// goroutine, and a caller that could write into it would be racing every other
// read of the session.
func TestGetUIPrefsHandsOutACopy(t *testing.T) {
	m := newManagerForTest(t)
	if err := m.MergeWindowUIPrefs(WindowRoleMain, uiPatch(t, `{"a": 1}`)); err != nil {
		t.Fatalf("merge: %v", err)
	}

	got := m.GetWindowUIPrefs(WindowRoleMain)
	got["a"] = json.RawMessage(`999`)
	got["b"] = json.RawMessage(`2`)

	after := m.GetWindowUIPrefs(WindowRoleMain)
	wantUIPref(t, after, "a", `1`)
	if _, ok := after["b"]; ok {
		t.Fatal("a caller's write reached the stored preferences")
	}
}

// session.json is rewritten whole on every save, so the map cannot be allowed to
// grow without limit. A patch over any bound is refused ENTIRELY: a silent
// truncation would leave the viewer believing it had stored something it had not.
func TestUIPrefPatchesOverTheBoundsAreRefusedWhole(t *testing.T) {
	cases := []struct {
		name  string
		patch string
	}{
		{"a value over the size limit", fmt.Sprintf(`{"big": %q}`, strings.Repeat("x", maxUIPrefValueBytes))},
		{"a key over the name limit", fmt.Sprintf(`{%q: 1}`, strings.Repeat("k", maxUIPrefKeyBytes+1))},
		{"an empty key", `{"": 1}`},
		{"more keys than the limit", manyUIPrefKeys(maxUIPrefKeys + 1)},
		{"more bytes than the whole map may hold", bulkyUIPrefs(maxUIPrefTotalBytes)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := newManagerForTest(t)
			if err := m.MergeWindowUIPrefs(WindowRoleMain, uiPatch(t, `{"kept": 1}`)); err != nil {
				t.Fatalf("seed: %v", err)
			}

			err := m.MergeWindowUIPrefs(WindowRoleMain, uiPatch(t, c.patch))
			if !errors.Is(err, ErrUIPrefsRejected) {
				t.Fatalf("got %v, want ErrUIPrefsRejected", err)
			}
			prefs := m.GetWindowUIPrefs(WindowRoleMain)
			if len(prefs) != 1 {
				t.Fatalf("a refused patch must store nothing at all, got %v", uiPrefKeys(prefs))
			}
			wantUIPref(t, prefs, "kept", `1`)
		})
	}
}

// The count limit is on what is stored, not on one patch: a viewer cannot walk
// past it a key at a time.
func TestUIPrefKeysAreCappedAcrossPatches(t *testing.T) {
	m := newManagerForTest(t)

	for i := 0; i < maxUIPrefKeys; i++ {
		if err := m.MergeWindowUIPrefs(WindowRoleMain, uiPatch(t, fmt.Sprintf(`{"key-%d": 1}`, i))); err != nil {
			t.Fatalf("merge %d: %v", i, err)
		}
	}
	if err := m.MergeWindowUIPrefs(WindowRoleMain, uiPatch(t, `{"one-too-many": 1}`)); !errors.Is(err, ErrUIPrefsRejected) {
		t.Fatalf("got %v, want ErrUIPrefsRejected", err)
	}
	// Replacing a key already stored is not growth, so it is still accepted.
	if err := m.MergeWindowUIPrefs(WindowRoleMain, uiPatch(t, `{"key-0": 2}`)); err != nil {
		t.Fatalf("replacing an existing key at the limit: %v", err)
	}
	wantUIPref(t, m.GetWindowUIPrefs(WindowRoleMain), "key-0", `2`)
}

// bulkyUIPrefs builds a patch that stays under every per-key and per-value
// bound but carries more than total bytes between them.
func bulkyUIPrefs(total int) string {
	value := strings.Repeat("x", maxUIPrefValueBytes/2)
	var b strings.Builder
	b.WriteString("{")
	for size := 0; size < total; size += len(value) {
		if size > 0 {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, `"key-%d": %q`, size, value)
	}
	b.WriteString("}")
	return b.String()
}

// manyUIPrefKeys builds a patch of n distinct keys.
func manyUIPrefKeys(n int) string {
	var b strings.Builder
	b.WriteString("{")
	for i := 0; i < n; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, `"key-%d": 1`, i)
	}
	b.WriteString("}")
	return b.String()
}
