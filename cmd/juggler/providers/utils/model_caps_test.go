//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package utils

import (
	"strings"
	"testing"
)

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

// TestModelCapsFallback: a fallback catalogue answers for the models the
// overrides do not name, counts as knowledge (unlike Default), and is asked
// with the id as the provider reported it, since it keeps its own ids.
func TestModelCapsFallback(t *testing.T) {
	var asked []string
	caps := ModelCaps{
		Default:   100,
		Overrides: map[string]int{"base": 200},
		Normalize: func(model string) string { return strings.TrimSuffix(model, "-snapshot") },
		Fallback: func(model string) (int, bool) {
			asked = append(asked, model)
			switch model {
			case "listed":
				return 300, true
			case "listed-without-figure":
				return 0, true
			}
			return 0, false
		},
	}
	tests := []struct {
		model     string
		lookup    int
		known     int
		wantKnown bool
	}{
		{"base", 200, 200, true},          // an override is never second-guessed
		{"base-snapshot", 200, 200, true}, // nor is a normalised one
		{"listed", 300, 300, true},
		{"listed-without-figure", 100, 0, false}, // a non-positive figure is no figure
		{"unknown", 100, 0, false},
	}
	for _, tt := range tests {
		if got := caps.Lookup(tt.model); got != tt.lookup {
			t.Errorf("Lookup(%s) = %d, want %d", tt.model, got, tt.lookup)
		}
		if got, known := caps.LookupKnown(tt.model); got != tt.known || known != tt.wantKnown {
			t.Errorf("LookupKnown(%s) = (%d, %v), want (%d, %v)", tt.model, got, known, tt.known, tt.wantKnown)
		}
	}
	for _, model := range asked {
		if model == "base" || model == "base-snapshot" {
			t.Errorf("the fallback was asked about %q, which an override answers", model)
		}
	}
}
