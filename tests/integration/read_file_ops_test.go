//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"unicode/utf16"

	"juggler/cmd/juggler/ops"
	"juggler/tests/helpers"
)

// utf16LEWithBOM encodes s as UTF-16 little-endian with a leading BOM — the
// on-disk shape produced by PowerShell `>` redirection and Notepad's "Unicode"
// save option on Windows.
func utf16LEWithBOM(s string) []byte {
	b := []byte{0xFF, 0xFE}
	for _, u := range utf16.Encode([]rune(s)) {
		b = append(b, byte(u), byte(u>>8))
	}
	return b
}

// TestLoadFile_BasicRead tests basic file reading functionality
func TestLoadFile_BasicRead(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	content := "Hello, World!\nThis is a test file.\n"
	helpers.WriteFile(t, filepath.Join(projectDir, "test.txt"), []byte(content))

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))

	params := map[string]any{
		"path": "test.txt",
	}

	result, err := readOps.Execute(context.Background(), "loadFile", params)
	if err != nil {
		t.Fatalf("Expected no error but got: %v", err)
	}

	resultMap, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("Expected result to be map, got %T", result)
	}

	if resultMap["content"] != content {
		t.Errorf("Expected content %q but got %q", content, resultMap["content"])
	}

	if resultMap["exists"] != true {
		t.Error("Expected exists to be true")
	}
}

// TestLoadFile_UTF16LE verifies a UTF-16LE (BOM'd) file — its pervasive null
// bytes would trip the binary-file heuristic — is transcoded to UTF-8 and read
// as text rather than rejected as binary.
func TestLoadFile_UTF16LE(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	want := "Hello, 世界!\nSecond line\n"
	helpers.WriteFile(t, filepath.Join(projectDir, "utf16.txt"), utf16LEWithBOM(want))

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))
	result, err := readOps.Execute(context.Background(), "loadFile", map[string]any{"path": "utf16.txt"})
	if err != nil {
		t.Fatalf("Expected no error but got: %v", err)
	}

	resultMap := result.(map[string]any)
	if w, flagged := resultMap["warning"]; flagged {
		t.Fatalf("UTF-16 file wrongly flagged as binary: %v", w)
	}
	if resultMap["content"] != want {
		t.Errorf("Expected content %q but got %q", want, resultMap["content"])
	}
}

// TestLoadFile_UTF8BOM verifies a leading UTF-8 BOM (common from Windows
// editors) is stripped so it doesn't survive as a spurious \ufeff.
func TestLoadFile_UTF8BOM(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	want := "package main\n"
	raw := append([]byte{0xEF, 0xBB, 0xBF}, []byte(want)...)
	helpers.WriteFile(t, filepath.Join(projectDir, "bom.txt"), raw)

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))
	result, err := readOps.Execute(context.Background(), "loadFile", map[string]any{"path": "bom.txt"})
	if err != nil {
		t.Fatalf("Expected no error but got: %v", err)
	}

	resultMap := result.(map[string]any)
	if resultMap["content"] != want {
		t.Errorf("Expected BOM-stripped content %q but got %q", want, resultMap["content"])
	}
}

// TestLoadFile_NonexistentFile tests reading a file that doesn't exist
func TestLoadFile_NonexistentFile(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))

	params := map[string]any{
		"path": "nonexistent.txt",
	}

	result, err := readOps.Execute(context.Background(), "loadFile", params)
	if err != nil {
		t.Fatalf("Expected no error but got: %v", err)
	}

	resultMap, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("Expected result to be map, got %T", result)
	}

	if resultMap["exists"] != false {
		t.Error("Expected exists to be false for nonexistent file")
	}
}

// TestLoadFile_ReadModes tests different read modes (head, tail, around, etc.)
func TestLoadFile_ReadModes(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	// Create file with numbered lines
	lines := make([]string, 100)
	for i := range lines {
		lines[i] = fmt.Sprintf("Line %d", i+1)
	}
	content := strings.Join(lines, "\n") + "\n"
	helpers.WriteFile(t, filepath.Join(projectDir, "numbered.txt"), []byte(content))

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))

	tests := []struct {
		name            string
		params          map[string]any
		expectedContain string
	}{
		{
			name: "Head mode",
			params: map[string]any{
				"path": "numbered.txt",
				"head": float64(10),
			},
			expectedContain: "Line 1",
		},
		{
			name: "Tail mode",
			params: map[string]any{
				"path": "numbered.txt",
				"tail": float64(10),
			},
			expectedContain: "Line 100",
		},
		{
			name: "Around mode",
			params: map[string]any{
				"path": "numbered.txt",
				"around": map[string]any{
					"line":    float64(50),
					"context": float64(5),
				},
			},
			expectedContain: "Line 50",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := readOps.Execute(context.Background(), "loadFile", tt.params)
			if err != nil {
				t.Fatalf("Expected no error but got: %v", err)
			}

			resultMap := result.(map[string]any)
			content := resultMap["content"].(string)

			if !strings.Contains(content, tt.expectedContain) {
				t.Errorf("Expected content to contain %q but it didn't. Content: %q", tt.expectedContain, content)
			}
		})
	}
}

// TestLoadFile_BinaryDetection tests binary file detection
func TestLoadFile_BinaryDetection(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	// Create binary file (with null bytes)
	binaryContent := []byte{0x7F, 0x45, 0x4C, 0x46, 0x00, 0x01, 0x02}
	helpers.WriteFile(t, filepath.Join(projectDir, "binary.bin"), binaryContent)

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))

	params := map[string]any{
		"path": "binary.bin",
	}

	result, err := readOps.Execute(context.Background(), "loadFile", params)
	if err != nil {
		// Binary file might be rejected - that's OK
		return
	}

	resultMap := result.(map[string]any)

	// The op REPORTS binary content rather than judging it: it flags isBinary and
	// returns no text, and the browser's file-viewer registry decides whether
	// anything can display it. Baking an English verdict in here is what forced
	// each new displayable format to be carved out as another special case.
	if resultMap["isBinary"] != true {
		t.Errorf("expected isBinary=true for a binary file, got %#v", resultMap)
	}
	if warning, ok := resultMap["warning"]; ok && warning != nil {
		t.Errorf("binary content must be reported, not judged; got warning %v", warning)
	}
	if content, ok := resultMap["content"].(string); ok && content != "" {
		t.Error("binary content must not be returned as text")
	}
}

func TestEditFileLines_EndLineHandling(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	// Create a file with 10 lines
	lines := make([]string, 10)
	for i := range lines {
		lines[i] = fmt.Sprintf("Line %d", i+1)
	}
	content := strings.Join(lines, "\n")
	filePath := filepath.Join(projectDir, "test.txt")
	helpers.WriteFile(t, filePath, []byte(content))

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))

	// Test case 1: endLine is omitted, defaults to end of file
	t.Run("OmittedEndLineDefaultsToEnd", func(t *testing.T) {
		params := map[string]any{
			"path":       "test.txt",
			"startLine":  float64(5),
			"newContent": "New content",
		}

		_, err := readOps.Execute(context.Background(), "editFileLines", params)
		if err != nil {
			t.Fatalf("Expected no error but got: %v", err)
		}

		// Verify file content
		newContentBytes, _ := os.ReadFile(filePath)
		newContent := string(newContentBytes)
		expectedContent := "Line 1\nLine 2\nLine 3\nLine 4\nNew content"
		if newContent != expectedContent {
			t.Errorf("Expected content %q but got %q", expectedContent, newContent)
		}
	})

	// Restore file content for next test case
	helpers.WriteFile(t, filePath, []byte(content))

	// Test case 2: endLine is less than or equal to 0
	t.Run("EndLineInvalid", func(t *testing.T) {
		params := map[string]any{
			"path":       "test.txt",
			"startLine":  float64(5),
			"endLine":    float64(0), // Invalid endLine
			"newContent": "New content",
		}

		_, err := readOps.Execute(context.Background(), "editFileLines", params)
		if err == nil {
			t.Fatal("Expected an error but got none")
		}

		expectedError := "provided endLine (0) must be greater than 0, or omit endLine to replace to the end of the file"
		if err.Error() != expectedError {
			t.Errorf("Expected error %q but got %q", expectedError, err.Error())
		}
	})
}

func TestEditFile_ReplaceAll(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	filePath := filepath.Join(projectDir, "test.txt")
	helpers.WriteFile(t, filePath, []byte("foo and foo and foo"))

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))

	result, err := readOps.Execute(context.Background(), "editFile", map[string]any{
		"path":        "test.txt",
		"old_str":     "foo",
		"new_str":     "bar",
		"replace_all": true,
	})
	if err != nil {
		t.Fatalf("Expected no error but got: %v", err)
	}

	resultMap := result.(map[string]any)
	if resultMap["matchStrategy"] != "exact-all" {
		t.Fatalf("Expected matchStrategy=exact-all, got %v", resultMap["matchStrategy"])
	}

	newContentBytes, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(newContentBytes), "bar and bar and bar"; got != want {
		t.Fatalf("Expected content %q, got %q", want, got)
	}
}

func TestEditFile_ReplaceAllDryRun(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	filePath := filepath.Join(projectDir, "test.txt")
	original := "foo and foo and foo"
	helpers.WriteFile(t, filePath, []byte(original))

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))

	result, err := readOps.Execute(context.Background(), "editFile", map[string]any{
		"path":        "test.txt",
		"old_str":     "foo",
		"new_str":     "bar",
		"replace_all": true,
		"dryRun":      true,
	})
	if err != nil {
		t.Fatalf("Expected no error but got: %v", err)
	}

	resultMap := result.(map[string]any)
	if resultMap["oldContent"] != original {
		t.Fatalf("Expected oldContent %q, got %q", original, resultMap["oldContent"])
	}
	if resultMap["newContent"] != "bar and bar and bar" {
		t.Fatalf("Expected all replacements in newContent, got %q", resultMap["newContent"])
	}
	if resultMap["matchStrategy"] != "exact-all" {
		t.Fatalf("Expected matchStrategy=exact-all, got %v", resultMap["matchStrategy"])
	}

	currentBytes, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(currentBytes); got != original {
		t.Fatalf("Dry run modified file: got %q, want %q", got, original)
	}
}

func TestEditFile_MultipleMatchesWithoutReplaceAllFails(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	helpers.WriteFile(t, filepath.Join(projectDir, "test.txt"), []byte("foo and foo and foo"))

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))

	_, err := readOps.Execute(context.Background(), "editFile", map[string]any{
		"path":    "test.txt",
		"old_str": "foo",
		"new_str": "bar",
	})
	if err == nil {
		t.Fatal("Expected ambiguous-match error without replace_all")
	}
	if !strings.Contains(err.Error(), "search string appears 3 times") {
		t.Fatalf("Expected occurrence-count error, got: %v", err)
	}
	if !strings.Contains(err.Error(), "replace_all") {
		t.Fatalf("Expected error to suggest replace_all, got: %v", err)
	}
}

// TestEditFile_SearchNotFound_JSDocSkipped verifies that the near-match logic
// skips JSDoc/comment lines and matches on the function signature instead.
func TestEditFile_SearchNotFound_JSDocSkipped(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	fileContent := `/**
 * PropertiesPanel - Right-side panel
 */
class PropertiesPanel {
    /**
     * Create a header element
     * @param {string} title
     * @returns {HTMLElement}
     */
    _createHeader(title, iconOptions, extraEl) {
        const header = document.createElement('div');
        header.className = 'properties-panel-header';
        return header;
    }
}`
	helpers.WriteFile(t, filepath.Join(projectDir, "panel.js"), []byte(fileContent))

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))

	// Search for the function with a slightly different param list (will not match exactly)
	params := map[string]any{
		"path":    "panel.js",
		"old_str": "    /**\n     * Create a header element\n     * @param {string} title\n     * @returns {HTMLElement}\n     */\n    _createHeader(title, iconOptions, extraEl, statusText) {",
		"new_str": "replaced",
	}

	result, err := readOps.Execute(context.Background(), "editFile", params)
	coded := searchNotFound(t, result, err)

	// The near-match should point near the function signature, not the file's
	// opening comment. The window starts 2 lines before the match; the
	// signature is on line 10, so the window starts around line 8.
	start := nearMatchWindowStart(coded.Msg)
	if start < 0 {
		t.Fatalf("Expected a near-match window — should find the function signature. Message: %s", coded.Msg)
	}
	if start <= 2 {
		t.Errorf("Near match pointed to line %d (file header area) — should match near the function signature", start)
	}
	if !strings.Contains(coded.Msg, "→10:     _createHeader") {
		t.Errorf("The window should mark the signature line, got: %s", coded.Msg)
	}
}

// searchNotFound asserts that an edit failed as a search-not-found: an error,
// not a result, carrying the SEARCH_NOT_FOUND code, a message the model can act
// on, and the path and current hash as its detail.
func searchNotFound(t *testing.T, result any, err error) *ops.CodedError {
	t.Helper()
	if err == nil {
		t.Fatalf("Expected a search-not-found error, got result %v", result)
	}
	var coded *ops.CodedError
	if !errors.As(err, &coded) {
		t.Fatalf("Expected an *ops.CodedError, got %T: %v", err, err)
	}
	if coded.Code != ops.CodeSearchNotFound {
		t.Fatalf("Expected code %s, got %q", ops.CodeSearchNotFound, coded.Code)
	}
	if !strings.HasPrefix(coded.Msg, "Search failed in '") ||
		!strings.HasSuffix(coded.Msg, "Re-read file and use exact text including whitespace.") {
		t.Errorf("The message should name the file and say what to do, got: %s", coded.Msg)
	}
	if hash, _ := coded.Detail["contentHash"].(string); len(hash) != 64 {
		t.Errorf("Expected the file's current hash in the detail, got %v", coded.Detail)
	}
	return coded
}

// nearMatchWindowStart reads the first line of the near-match window out of a
// search-not-found message, or -1 when the message carries no window.
func nearMatchWindowStart(msg string) int {
	m := regexp.MustCompile(`near possible match \(lines (\d+)-\d+\)`).FindStringSubmatch(msg)
	if m == nil {
		return -1
	}
	n, _ := strconv.Atoi(m[1])
	return n
}

// TestEditFile_SearchNotFound_NoNearMatch verifies that a completely
// unrelated search string produces no near-match window.
func TestEditFile_SearchNotFound_NoNearMatch(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	helpers.WriteFile(t, filepath.Join(projectDir, "simple.txt"), []byte("some content here"))

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))

	params := map[string]any{
		"path":    "simple.txt",
		"old_str": "NONEXISTENT",
		"new_str": "replacement",
	}

	result, err := readOps.Execute(context.Background(), "editFile", params)
	coded := searchNotFound(t, result, err)
	if want := "Search failed in 'simple.txt'. Re-read file and use exact text including whitespace."; coded.Msg != want {
		t.Errorf("Expected no near-match window for a completely unrelated search string.\n got: %q\nwant: %q", coded.Msg, want)
	}
}

// TestEditFile_SearchNotFound_Escaping verifies that an old_str which would
// match once its backslash escapes are removed is reported as an escaping
// mistake.
func TestEditFile_SearchNotFound_Escaping(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	helpers.WriteFile(t, filepath.Join(projectDir, "tmpl.js"), []byte("const s = `${name}`;\n"))

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))

	params := map[string]any{
		"path":    "tmpl.js",
		"old_str": "const s = \\`\\${name}\\`;",
		"new_str": "const s = name;",
	}

	result, err := readOps.Execute(context.Background(), "editFile", params)
	coded := searchNotFound(t, result, err)
	if !strings.Contains(coded.Msg, "ESCAPING ERROR: old_str is LITERAL") {
		t.Errorf("Expected the escaping hint, got: %s", coded.Msg)
	}
}

// TestEditFile_SearchNotFound_CommentOnlyFallback verifies that when the search
// string contains only comment lines, the longest line is used as probe.
func TestEditFile_SearchNotFound_CommentOnlyFallback(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	fileContent := `/**
 * This is a very distinctive comment about frobnicating the widget
 */
function unrelated() {
    return 42;
}`
	helpers.WriteFile(t, filepath.Join(projectDir, "comments.js"), []byte(fileContent))

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))

	// Search with only comment lines — probe should fall back to the longest line
	params := map[string]any{
		"path":    "comments.js",
		"old_str": "/**\n * This is a very distinctive comment about frobnicating the widget\n * And another line that does not exist\n */",
		"new_str": "replaced",
	}

	result, err := readOps.Execute(context.Background(), "editFile", params)
	coded := searchNotFound(t, result, err)

	// The fallback should use the longest comment line as probe and find a match.
	// The distinctive comment is on line 2; context window starts at line 1.
	if nearMatchWindowStart(coded.Msg) != 1 {
		t.Fatalf("Expected a near-match window from line 1 — fallback should use the longest comment line. Message: %s", coded.Msg)
	}
	if !strings.Contains(coded.Msg, "frobnicating") {
		t.Errorf("Context should contain the distinctive comment line, got: %s", coded.Msg)
	}
}

// TestLoadFile_AllowedRootsScope verifies the allowed-paths wiring: a file
// outside the project is blocked by default, but reads successfully when its
// directory is part of the handler's PathScope grant (assembled from the
// frontend's messageThread.getAllowedPaths()).
func TestLoadFile_AllowedRootsScope(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)
	outsideDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(outsideDir)

	content := "secret notes outside the project\n"
	outsideFile := filepath.Join(outsideDir, "notes.txt")
	helpers.WriteFile(t, outsideFile, []byte(content))

	// Without the grant: blocked by working-directory containment.
	noGrant := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))
	if _, err := noGrant.Execute(context.Background(), "loadFile", map[string]any{
		"path": outsideFile,
	}); err == nil {
		t.Fatal("Expected out-of-project read to be rejected without an allowed-roots grant")
	}

	// With the grant on the scope: allowed.
	granted := ops.NewFileOperations(ops.NewPathScope(projectDir, []string{outsideDir}))
	result, err := granted.Execute(context.Background(), "loadFile", map[string]any{
		"path": outsideFile,
	})
	if err != nil {
		t.Fatalf("Expected out-of-project read to succeed with allowed-roots grant, got: %v", err)
	}
	resultMap, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("Expected map result, got %T", result)
	}
	if resultMap["content"] != content {
		t.Errorf("Expected content %q, got %q", content, resultMap["content"])
	}
	if resultMap["exists"] != true {
		t.Error("Expected exists=true")
	}

	// A grant that does NOT cover the file's directory must still reject.
	uncovered := ops.NewFileOperations(ops.NewPathScope(projectDir, []string{filepath.Join(outsideDir, "unrelated-subdir")}))
	if _, err := uncovered.Execute(context.Background(), "loadFile", map[string]any{
		"path": outsideFile,
	}); err == nil {
		t.Fatal("Expected read to be rejected when the allowed-roots grant does not cover the file")
	}
}

// TestGrep_AllowedRootsScope verifies the same grant wiring for the grep op.
func TestGrep_AllowedRootsScope(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)
	outsideDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(outsideDir)

	helpers.WriteFile(t, filepath.Join(outsideDir, "hay.txt"), []byte("alpha\nNEEDLE here\nbeta\n"))

	// Without the grant: searching an out-of-project path is rejected.
	noGrant := ops.NewSearchOperations(ops.NewPathScope(projectDir, nil))
	if _, err := noGrant.Execute(context.Background(), "grep", map[string]any{
		"pattern": "NEEDLE",
		"path":    outsideDir,
	}); err == nil {
		t.Fatal("Expected out-of-project grep to be rejected without an allowed-roots grant")
	}

	// With the grant on the scope: search runs and finds the match.
	granted := ops.NewSearchOperations(ops.NewPathScope(projectDir, []string{outsideDir}))
	result, err := granted.Execute(context.Background(), "grep", map[string]any{
		"pattern": "NEEDLE",
		"path":    outsideDir,
	})
	if err != nil {
		t.Fatalf("Expected out-of-project grep to succeed with allowed-roots grant, got: %v", err)
	}
	resultMap, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("Expected map result, got %T", result)
	}
	if mc, _ := resultMap["matchCount"].(int); mc < 1 {
		t.Errorf("Expected at least one match, got matchCount=%v", resultMap["matchCount"])
	}
}

// TestLoadFile_UserInitiatedRelativeOutsideRoot covers a file pinned by
// @-mention with a RELATIVE path that escapes the project root (e.g.
// ../sibling-repo/file.go). Without userInitiated it's blocked; with it — and
// with no allowed-paths grant — it must read, because a pin is the user
// explicitly choosing the path. Regression: the escape hatch used to be
// absolute-only, so relative mentions silently failed.
func TestLoadFile_UserInitiatedRelativeOutsideRoot(t *testing.T) {
	parent := helpers.CreateTempDir(t)
	defer os.RemoveAll(parent)
	projectDir := filepath.Join(parent, "project")
	siblingDir := filepath.Join(parent, "sibling-repo")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(siblingDir, 0o755); err != nil {
		t.Fatal(err)
	}

	content := "package worker\n"
	helpers.WriteFile(t, filepath.Join(siblingDir, "worker.go"), []byte(content))

	// Relative mention as the user would type it: ../sibling-repo/worker.go
	relPath := filepath.Join("..", "sibling-repo", "worker.go")

	readOps := ops.NewFileOperations(ops.NewPathScope(projectDir, nil))

	// LLM-style call (no userInitiated): blocked by containment.
	if _, err := readOps.Execute(context.Background(), "loadFile", map[string]any{
		"path": relPath,
	}); err == nil {
		t.Fatal("Expected relative out-of-project read to be rejected without userInitiated")
	}

	// User-initiated pin: resolves without any allowed-paths grant.
	result, err := readOps.Execute(context.Background(), "loadFile", map[string]any{
		"path":          relPath,
		"userInitiated": true,
	})
	if err != nil {
		t.Fatalf("Expected user-initiated relative read to succeed, got: %v", err)
	}
	resultMap, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("Expected map result, got %T", result)
	}
	if resultMap["exists"] != true {
		t.Errorf("Expected exists=true, got %v", resultMap["exists"])
	}
	if resultMap["content"] != content {
		t.Errorf("Expected content %q, got %q", content, resultMap["content"])
	}
}

// TestGetTree_UserInitiatedRelativeOutsideRoot is the folder analogue of the
// above: an @-mentioned directory outside the project root (the exact reported
// case, `@../juggler-studio/worker/`) must list with userInitiated and be
// rejected without it.
func TestGetTree_UserInitiatedRelativeOutsideRoot(t *testing.T) {
	parent := helpers.CreateTempDir(t)
	defer os.RemoveAll(parent)
	projectDir := filepath.Join(parent, "project")
	siblingDir := filepath.Join(parent, "sibling-repo", "worker")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(siblingDir, 0o755); err != nil {
		t.Fatal(err)
	}
	helpers.WriteFile(t, filepath.Join(siblingDir, "main.go"), []byte("package worker\n"))

	relPath := filepath.Join("..", "sibling-repo", "worker")
	treeOps := ops.NewTreeOperations(ops.NewPathScope(projectDir, nil))

	// LLM-style call: blocked.
	if _, err := treeOps.Execute(context.Background(), "getTree", map[string]any{
		"path": relPath,
	}); err == nil {
		t.Fatal("Expected relative out-of-project getTree to be rejected without userInitiated")
	}

	// User-initiated pin: lists the sibling folder with no grant.
	result, err := treeOps.Execute(context.Background(), "getTree", map[string]any{
		"path":          relPath,
		"userInitiated": true,
	})
	if err != nil {
		t.Fatalf("Expected user-initiated relative getTree to succeed, got: %v", err)
	}
	resultMap, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("Expected map result, got %T", result)
	}
	if tree, _ := resultMap["content"].(string); !strings.Contains(tree, "main.go") {
		t.Errorf("Expected tree to list main.go, got: %q", resultMap["content"])
	}
}
