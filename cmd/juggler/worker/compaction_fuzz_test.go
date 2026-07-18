//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"testing"
	"unicode/utf8"
)

// FuzzLargestFittingRunePrefix checks the reducer's rune-level splitter
// against a monotone fits predicate (a rune-count limit derived from the
// fuzz input). The invariants: nothing is lost or corrupted (prefix + rest
// reconstructs the input), a non-empty prefix itself fits, and the split is
// maximal — one more rune would not have fit. Invalid UTF-8 is skipped
// because []rune conversion is lossy there by construction.
func FuzzLargestFittingRunePrefix(f *testing.F) {
	f.Add("hello world", uint(3))
	f.Add("翻译中文 mixed 内容", uint(5))
	f.Add("😀🧪🚀🫠", uint(1))
	f.Add("", uint(0))
	f.Add("no limit needed", uint(100))
	f.Fuzz(func(t *testing.T, text string, limit uint) {
		if !utf8.ValidString(text) {
			t.Skip("[]rune conversion is lossy for invalid UTF-8")
		}
		fits := func(s string) bool { return uint(utf8.RuneCountInString(s)) <= limit }
		prefix, rest := largestFittingRunePrefix(text, fits)
		if prefix+rest != text {
			t.Fatalf("prefix %q + rest %q != input %q", prefix, rest, text)
		}
		if prefix == "" {
			// Nothing fit: even a single rune must exceed the limit (or the
			// input was empty).
			if text == "" {
				return
			}
			_, size := utf8.DecodeRuneInString(text)
			if fits(text[:size]) {
				t.Fatalf("empty prefix but first rune of %q fits limit %d", text, limit)
			}
			return
		}
		if !fits(prefix) {
			t.Fatalf("prefix %q does not fit limit %d", prefix, limit)
		}
		if rest == "" {
			return
		}
		firstRune, size := utf8.DecodeRuneInString(rest)
		if fits(prefix + rest[:size]) {
			t.Fatalf("split not maximal: %q + %q still fits limit %d", prefix, string(firstRune), limit)
		}
	})
}
