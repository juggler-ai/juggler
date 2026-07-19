//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"strings"
	"testing"
)

func TestCleanSuggestedName(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"plain", "Refactor Auth Middleware", "Refactor Auth Middleware"},
		{"surrounding double quotes", "\"Fix Login Bug\"", "Fix Login Bug"},
		{"surrounding single quotes", "'Fix Login Bug'", "Fix Login Bug"},
		{"backticks", "`Add Retry Logic`", "Add Retry Logic"},
		{"title label", "Title: Parse YAML Config", "Parse YAML Config"},
		{"name label lowercase", "name: Parse YAML Config", "Parse YAML Config"},
		{"leading/trailing space", "   Deploy Script   ", "Deploy Script"},
		{"multi-line keeps first non-empty", "\n\nGraph Traversal\nBlah blah explanation", "Graph Traversal"},
		{"label then quotes", "Title: \"Wire Up Router\"", "Wire Up Router"},
		{"empty", "", ""},
		{"only whitespace", "   \n  ", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := cleanSuggestedName(tc.in); got != tc.want {
				t.Errorf("cleanSuggestedName(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestBuildNamePromptContent(t *testing.T) {
	got := buildNamePromptContent("Help me fix the parser", "Sure, here is the fix")
	if !strings.Contains(got, "First user message:") {
		t.Errorf("missing user-message section: %q", got)
	}
	if !strings.Contains(got, "Help me fix the parser") {
		t.Errorf("missing prompt text: %q", got)
	}
	if !strings.Contains(got, "Assistant's first reply:") {
		t.Errorf("missing reply section: %q", got)
	}
	if !strings.HasSuffix(got, "Title:") {
		t.Errorf("expected trailing 'Title:' cue, got: %q", got)
	}
}

func TestBuildNamePromptContentEmptyResponse(t *testing.T) {
	got := buildNamePromptContent("Just a prompt", "   ")
	if strings.Contains(got, "Assistant's first reply:") {
		t.Errorf("empty reply should be omitted, got: %q", got)
	}
	if !strings.Contains(got, "Just a prompt") {
		t.Errorf("missing prompt text: %q", got)
	}
}

func TestBuildNamePromptContentClipsLongInput(t *testing.T) {
	long := strings.Repeat("x", nameGenInputCap+500)
	got := buildNamePromptContent(long, "")
	// The prompt half must be clipped to the cap; the wrapper text adds a
	// bounded amount, so total x-runs cannot exceed the cap.
	if strings.Count(got, "x") > nameGenInputCap {
		t.Errorf("prompt not clipped: %d x's (cap %d)", strings.Count(got, "x"), nameGenInputCap)
	}
}

func TestClipRuneBoundary(t *testing.T) {
	// Multibyte runes must not be split mid-byte.
	in := strings.Repeat("é", 10) // each 'é' is 2 bytes
	got := clip(in, 4)
	if r := []rune(got); len(r) != 4 {
		t.Errorf("clip returned %d runes, want 4", len(r))
	}
	if !strings.HasPrefix(in, got) {
		t.Errorf("clip result %q is not a prefix of input", got)
	}
}
