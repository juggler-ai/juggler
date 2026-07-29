//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

// The explore_code sandbox filesystem reads files to process them
// programmatically (JSON.parse, hashing, line counting). It must therefore get
// the exact bytes on disk, NOT the LLM-context view that truncates long lines
// at MaxLineLength (appending a "[line truncated: ...]" marker) and caps files
// at DefaultMaxLines. A minified/single-line JSON file read the LLM way is cut
// at the MaxLineLength rune boundary, so `JSON.parse` blows up at that point.
// The `raw` param opts into an untruncated read for these callers.

func TestLoadFileRawReturnsUntruncatedLongLine(t *testing.T) {
	dir := t.TempDir()
	// Single-line (minified) content longer than MaxLineLength.
	longLine := `{"key":"` + strings.Repeat("x", MaxLineLength*2) + `"}`
	path := filepath.Join(dir, "min.json")
	if err := os.WriteFile(path, []byte(longLine), 0o644); err != nil {
		t.Fatal(err)
	}
	ops := NewFileOperations(NewPathScope(dir, nil))

	// Default (LLM-facing) read truncates the long line with an explicit marker.
	def, err := ops.Execute(context.Background(), "loadFile", map[string]any{"path": path})
	if err != nil {
		t.Fatalf("default loadFile: %v", err)
	}
	defContent := def.(map[string]any)["content"].(string)
	if !strings.Contains(defContent, "[line truncated:") {
		t.Fatalf("expected default read to mark the long line as truncated (got %d chars)", len(defContent))
	}
	if len(defContent) >= len(longLine) {
		t.Fatalf("expected default read to shorten the long line, got %d chars (original %d)", len(defContent), len(longLine))
	}
	if !utf8.ValidString(defContent) {
		t.Fatalf("truncated content must remain valid UTF-8")
	}

	// Raw read must return the exact on-disk bytes so JSON.parse et al. work.
	rawRes, err := ops.Execute(context.Background(), "loadFile", map[string]any{"path": path, "raw": true})
	if err != nil {
		t.Fatalf("raw loadFile: %v", err)
	}
	rawContent := rawRes.(map[string]any)["content"].(string)
	if rawContent != longLine {
		t.Fatalf("raw read altered content: got %d chars, want %d (must be byte-exact, no truncation/ellipsis)", len(rawContent), len(longLine))
	}
}

// A single line whose byte at MaxLineLength lands inside a multi-byte rune must
// still truncate to valid UTF-8. A naive byte slice at MaxLineLength would split
// the straddling character and emit a replacement/garbage rune that the model
// then tries to "repair" — the exact prose-corruption failure this guards.
func TestLoadFileTruncatesLongLineOnRuneBoundary(t *testing.T) {
	dir := t.TempDir()
	// "…" (U+2026) is 3 bytes; MaxLineLength is not a multiple of 3, so byte
	// MaxLineLength falls inside a rune and forces a boundary back-off.
	line := strings.Repeat("…", MaxLineLength) // 3*MaxLineLength bytes
	path := filepath.Join(dir, "prose.md")
	if err := os.WriteFile(path, []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}
	ops := NewFileOperations(NewPathScope(dir, nil))

	res, err := ops.Execute(context.Background(), "loadFile", map[string]any{"path": path})
	if err != nil {
		t.Fatalf("loadFile: %v", err)
	}
	content := res.(map[string]any)["content"].(string)
	if !utf8.ValidString(content) {
		t.Fatalf("truncated multi-byte line must remain valid UTF-8")
	}
	if !strings.Contains(content, "[line truncated:") {
		t.Fatalf("expected a truncation marker for the over-long line")
	}
}

func TestLoadFileRawReturnsAllLines(t *testing.T) {
	dir := t.TempDir()
	total := DefaultMaxLines + 500
	var sb strings.Builder
	for i := 0; i < total; i++ {
		sb.WriteString("line\n")
	}
	path := filepath.Join(dir, "big.txt")
	if err := os.WriteFile(path, []byte(sb.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	ops := NewFileOperations(NewPathScope(dir, nil))

	// Default read caps at DefaultMaxLines.
	def, err := ops.Execute(context.Background(), "loadFile", map[string]any{"path": path})
	if err != nil {
		t.Fatalf("default loadFile: %v", err)
	}
	if lc := def.(map[string]any)["lineCount"].(int); lc > DefaultMaxLines {
		t.Fatalf("default read should cap at %d lines, got %d", DefaultMaxLines, lc)
	}

	// Raw read must return every line.
	rawRes, err := ops.Execute(context.Background(), "loadFile", map[string]any{"path": path, "raw": true})
	if err != nil {
		t.Fatalf("raw loadFile: %v", err)
	}
	m := rawRes.(map[string]any)
	if lc := m["lineCount"].(int); lc < total {
		t.Fatalf("raw read capped lines: got %d, want >= %d", lc, total)
	}
	// And the content must actually contain the last line's worth of data.
	if got := strings.Count(m["content"].(string), "line"); got < total {
		t.Fatalf("raw content dropped lines: found %d 'line' tokens, want >= %d", got, total)
	}
}
