//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"strings"
	"testing"
)

func TestSanitizeNameRuneCap(t *testing.T) {
	// An ASCII name longer than the rune cap is truncated to exactly the cap.
	in := strings.Repeat("a", SanitizedNameMaxRunes+25)
	got := SanitizeName(in)
	if n := len([]rune(got)); n != SanitizedNameMaxRunes {
		t.Fatalf("rune length = %d, want %d", n, SanitizedNameMaxRunes)
	}
}

func TestSanitizeNameByteCapWithMultibyte(t *testing.T) {
	// An all-emoji name (4 bytes/rune) must be clamped by BYTES so the folder
	// name stays under filesystem limits, even though its rune count is under
	// the rune cap.
	in := strings.Repeat("😀", SanitizedNameMaxRunes) // 4 bytes each
	got := SanitizeName(in)

	if len(got) > sanitizedNameMaxBytes {
		t.Fatalf("byte length = %d, want <= %d", len(got), sanitizedNameMaxBytes)
	}
	// Must remain valid UTF-8 (no rune split mid-truncation).
	if strings.ContainsRune(got, '\uFFFD') {
		t.Fatalf("result contains replacement char (rune split): %q", got)
	}
	// The whole folder name must be comfortably under the 255-byte filename cap.
	folder := BuildDirName(got, "conv_abcdefghi")
	if len(folder) > 255 {
		t.Fatalf("folder name %d bytes, exceeds 255", len(folder))
	}
}

func TestSanitizeNameShortNameUnchanged(t *testing.T) {
	// A normal AI-generated title well under both caps is preserved verbatim.
	in := "Refactor Auth Middleware"
	if got := SanitizeName(in); got != in {
		t.Fatalf("SanitizeName(%q) = %q, want unchanged", in, got)
	}
}

func TestSanitizeNameEmptyIsUntitled(t *testing.T) {
	if got := SanitizeName("   "); got != "Untitled" {
		t.Fatalf("SanitizeName(whitespace) = %q, want Untitled", got)
	}
}
