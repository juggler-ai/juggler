//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package utils

import "testing"

func TestModelCapsLookup(t *testing.T) {
	caps := ModelCaps{Default: 100, Overrides: map[string]int{"a": 200}}
	if got := caps.Lookup("a"); got != 200 {
		t.Errorf("Lookup(a) = %d, want 200 (override)", got)
	}
	if got := caps.Lookup("b"); got != 100 {
		t.Errorf("Lookup(b) = %d, want 100 (default)", got)
	}
}

func TestModelCapsNilOverrides(t *testing.T) {
	caps := ModelCaps{Default: 42}
	if got := caps.Lookup("anything"); got != 42 {
		t.Errorf("Lookup with nil overrides = %d, want 42 (default)", got)
	}
}

func TestModelCapsLookupKnown(t *testing.T) {
	caps := ModelCaps{Default: 100, Overrides: map[string]int{"a": 200}}
	if v, known := caps.LookupKnown("a"); !known || v != 200 {
		t.Errorf("LookupKnown(a) = (%d, %v), want (200, true)", v, known)
	}
	if v, known := caps.LookupKnown("b"); known || v != 0 {
		t.Errorf("LookupKnown(b) = (%d, %v), want (0, false) — the default is not a match", v, known)
	}
	defaultsOnly := ModelCaps{Default: 42}
	if _, known := defaultsOnly.LookupKnown("anything"); known {
		t.Error("LookupKnown with nil overrides matched, want no match")
	}
}
