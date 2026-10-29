//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"testing"
)

// managerWithStoredAppearance opens a project whose session.json on disk holds
// the given theme mode and zoom, as a project left by an earlier Juggler does.
func managerWithStoredAppearance(t *testing.T, theme string, zoom int) *SessionManager {
	t.Helper()
	dir := t.TempDir()
	store, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	seed := NewSession()
	seed.UITheme = theme
	seed.UIZoom = zoom
	if err := store.Save(seed); err != nil {
		t.Fatalf("seed: %v", err)
	}
	m := startManager(store, dir)
	t.Cleanup(m.Shutdown)
	return m
}

// The theme and zoom a project's session stored are what serveIndex offers the
// server's own window to adopt for a machine that has none, so they have to read
// back exactly what is on disk.
func TestStoredAppearanceReadsBackFromDisk(t *testing.T) {
	m := managerWithStoredAppearance(t, "light", 90)
	if got, ok := m.GetUITheme(); !ok || got != "light" {
		t.Fatalf("GetUITheme = %q ok=%v, want \"light\" true", got, ok)
	}
	if got, ok := m.GetUIZoom(); !ok || got != 90 {
		t.Fatalf("GetUIZoom = %d ok=%v, want 90 true", got, ok)
	}
}

// A session that stored nothing offers nothing, so the page keeps its own
// defaults rather than adopting a blank.
func TestStoredAppearanceAbsent(t *testing.T) {
	m := managerWithStoredAppearance(t, "", 0)
	if got, ok := m.GetUITheme(); ok {
		t.Fatalf("GetUITheme = %q, want none", got)
	}
	if got, ok := m.GetUIZoom(); ok {
		t.Fatalf("GetUIZoom = %d, want none", got)
	}
}

// A value the viewer would not accept is no offer at all, rather than one the
// page has to reject.
func TestStoredAppearanceInvalidIsAbsent(t *testing.T) {
	m := managerWithStoredAppearance(t, "chartreuse", -5)
	if got, ok := m.GetUITheme(); ok {
		t.Fatalf("GetUITheme = %q, want none for an unrecognised mode", got)
	}
	if got, ok := m.GetUIZoom(); ok {
		t.Fatalf("GetUIZoom = %d, want none for a non-positive zoom", got)
	}
}
