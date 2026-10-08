//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Read tool limits
const (
	// DefaultMaxLines is the maximum number of lines returned when no limit is specified
	DefaultMaxLines = 2000
	// MaxLineLength is the maximum bytes of a single line the LLM-facing read
	// returns before it is truncated. Sized to pass any real prose paragraph
	// through untouched while still bounding minified/generated single-line
	// files that would otherwise flood the context.
	MaxLineLength = 10000
	// MaxImageReadBytes caps an image the read tool will inline for a multimodal
	// model. Sized at the smallest common provider ceiling (Anthropic's 5 MB per
	// image) so a read against any provider stays within limits; a larger image
	// falls back to the binary-file warning instead of being snapshotted.
	MaxImageReadBytes = 5 << 20
)

// imageMimeByExt maps a lower-cased file extension (with leading dot) to the
// canonical image mime type the asset store supports. Kept in lockstep with the
// worker asset store's extForMime/mimeForExt so a read-tool snapshot round-trips.
var imageMimeByExt = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
}

// ImageMimeForPath returns the canonical image mime type for a path whose
// extension names a supported image format, or "" when the extension is not a
// supported image type. Shared by the read op's image detection and the
// asset-snapshot route so both agree on which files are inlineable images.
func ImageMimeForPath(path string) string {
	return imageMimeByExt[strings.ToLower(filepath.Ext(path))]
}

// mimeByExt maps a lower-cased file extension (with leading dot) to the mime
// type reported for a file. It is deliberately a small, explicit table rather
// than the stdlib's platform mime database: the value is reported to the browser
// so a file viewer can claim the file, and a viewer's claim must not vary with
// whatever mime mappings happen to be installed on the user's machine.
var mimeByExt = map[string]string{
	".pdf":      "application/pdf",
	".json":     "application/json",
	".md":       "text/markdown",
	".markdown": "text/markdown",
	".txt":      "text/plain",
	".log":      "text/plain",
	".csv":      "text/csv",
	".html":     "text/html",
	".htm":      "text/html",
	".css":      "text/css",
	".js":       "text/javascript",
	".mjs":      "text/javascript",
	".ts":       "text/typescript",
	".xml":      "text/xml",
	".svg":      "image/svg+xml",
	".yaml":     "text/yaml",
	".yml":      "text/yaml",
	".toml":     "text/toml",
	// Media the content route streams to a <video>/<audio>/<img>. Served with
	// nosniff, so a format missing here reaches the player as octet-stream.
	".mp4":  "video/mp4",
	".m4v":  "video/mp4",
	".mov":  "video/quicktime",
	".webm": "video/webm",
	".ogv":  "video/ogg",
	".mp3":  "audio/mpeg",
	".wav":  "audio/wav",
	".m4a":  "audio/mp4",
	".aac":  "audio/aac",
	".flac": "audio/flac",
	".ogg":  "audio/ogg",
	".oga":  "audio/ogg",
	".opus": "audio/ogg",
	".aif":  "audio/aiff",
	".aiff": "audio/aiff",
	".bmp":  "image/bmp",
	".ico":  "image/x-icon",
	".avif": "image/avif",
	".tif":  "image/tiff",
	".tiff": "image/tiff",
	".heic": "image/heic",
	".heif": "image/heif",
}

// MimeForPath returns the mime type reported for a path — images first (so the
// image table stays the single source of truth for what the asset store
// accepts), then the general table. Returns "" when the extension is unknown,
// which callers render as an explicit "unknown" rather than guessing.
func MimeForPath(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	if mime, ok := imageMimeByExt[ext]; ok {
		return mime
	}
	return mimeByExt[ext]
}

// FileOperations handles file I/O operations
type FileOperations struct {
	scope PathScope
}

// NewFileOperations creates a new file operations handler
func NewFileOperations(scope PathScope) *FileOperations {
	return &FileOperations{
		scope: scope,
	}
}

// Execute executes a file operation
func (ops *FileOperations) Execute(_ context.Context, operation string, params map[string]any) (any, error) {
	switch operation {
	case "loadFile":
		return ops.loadFile(params)
	case "writeFile":
		return ops.writeFile(params)
	case "editFile":
		return ops.editFile(params)
	case "editFileLines":
		return ops.editFileLines(params)
	case "getFileHash":
		return ops.getFileHash(params)
	case "stat":
		return ops.stat(params)
	case "mkdir":
		return ops.mkdir(params)
	default:
		return nil, fmt.Errorf("unknown operation: %s", operation)
	}
}

// truncateLineForContext shortens a single over-long line for the LLM-facing
// read. It cuts at or below MaxLineLength on a UTF-8 rune boundary — never
// mid-character, so the result is always valid UTF-8 — and appends a marker
// naming how many characters were shown versus elided, so the model treats the
// line as deliberately truncated rather than corrupted content to reconstruct.
func truncateLineForContext(line string) string {
	cut := MaxLineLength
	// Back off to the start of the rune straddling the cut so a multi-byte
	// character is never split. Runes are at most 4 bytes, so this steps back
	// at most 3 times.
	for cut > 0 && !utf8.RuneStart(line[cut]) {
		cut--
	}
	shown := utf8.RuneCountInString(line[:cut])
	total := utf8.RuneCountInString(line)
	return fmt.Sprintf("%s… [line truncated: %d of %d characters shown]", line[:cut], shown, total)
}

// loadFile loads a file's content with various modes
// Supports: full file, line range, tail (last N lines), head (first N lines), around (lines around a specific line)
func (ops *FileOperations) loadFile(params map[string]any) (any, error) {
	// Validate path parameter
	path, err := ValidateStringParam(params["path"], "path", true, 4096)
	if err != nil {
		return nil, err
	}

	// User-initiated reads (e.g. an @-mention or file-picker pin) may reference
	// paths outside the project — relative (../sibling) or absolute. Resolve
	// honours that escape hatch. An LLM read (userInitiated=false) stays
	// restricted to the working directory unless outOfRootApproved is set, which
	// the JS approval flow adds only after the user OK'd this specific read
	// (mirroring the write tool's out-of-scope approval).
	userInitiated, _ := params["userInitiated"].(bool)
	approved, _ := params["outOfRootApproved"].(bool)
	absPath, err := ops.scope.ResolveRead(path, userInitiated, approved)
	if err != nil {
		return nil, err
	}

	// Get file info for metadata
	fileInfo, statErr := os.Stat(absPath)
	if statErr != nil {
		if os.IsNotExist(statErr) {
			// File doesn't exist
			return map[string]any{
				"content":    "",
				"path":       path,
				"language":   detectLanguage(path),
				"exists":     false,
				"size":       0,
				"mime":       MimeForPath(path),
				"isBinary":   false,
				"totalLines": 0,
			}, nil
		}
		return nil, fmt.Errorf("failed to stat file: %w", statErr)
	}

	// Check if path is a directory
	if fileInfo.IsDir() {
		return nil, fmt.Errorf("path is a directory, not a file: %s", path)
	}

	// Images: a supported image type within the inline size cap is returned as an
	// isImage marker carrying the base64 bytes, so the read tool can upload it to
	// the conversation asset store (via the existing asset-upload endpoint) and
	// hand a multimodal model the actual pixels. An oversized image, or any other
	// binary, falls through to the binary-file warning below. This must precede
	// the IsBinaryFile check since images are binary and would otherwise be
	// rejected as undisplayable. The path was already validated by ResolveRead
	// above, so the bytes are safe to read here.
	if mime := ImageMimeForPath(absPath); mime != "" {
		if fileInfo.Size() <= MaxImageReadBytes {
			imgData, readErr := os.ReadFile(absPath)
			if readErr != nil {
				return nil, fmt.Errorf("failed to read image file: %w", readErr)
			}
			return map[string]any{
				"isImage":     true,
				"mime":        mime,
				"path":        path,
				"exists":      true,
				"size":        fileInfo.Size(),
				"imageBase64": base64.StdEncoding.EncodeToString(imgData),
			}, nil
		}
		// Too large to inline. Report it as what it is — an image of this size —
		// and let the browser decide: the image viewer's own maxBytes declines it
		// and the host renders its no-viewer fallback. The size limit is a
		// property of the viewer, not a verdict the read op should be issuing.
		return map[string]any{
			"content":  "",
			"path":     path,
			"language": detectLanguage(path),
			"exists":   true,
			"size":     fileInfo.Size(),
			"mime":     mime,
			"isBinary": true,
		}, nil
	}

	// Binary content is REPORTED, not judged: the op returns the observation
	// (isBinary, mime, size) and no content, and the browser's file-viewer
	// registry decides whether anything can display it. Baking a verdict into an
	// English warning here is what forced every new displayable format to be
	// carved out as another escape hatch above this check.
	isBinary, err := IsBinaryFile(absPath)
	if err == nil && isBinary {
		return map[string]any{
			"content":  "",
			"path":     path,
			"language": detectLanguage(path),
			"exists":   true,
			"size":     fileInfo.Size(),
			"mime":     MimeForPath(absPath),
			"isBinary": true,
		}, nil
	}

	// SECURITY: Check file size limit (prevent DoS via huge files). It guards
	// reading the whole file as text, so it sits after the branches above, which
	// read at most an inline-capped image and otherwise only report: a large
	// binary — a video, a recording — is described like any other, not refused.
	if err := ValidateFileSize(absPath); err != nil {
		return nil, err
	}

	// Read file
	content, err := os.ReadFile(absPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read file: %w", err)
	}

	// Hash the raw on-disk bytes (before decode/normalize/truncation) so the
	// staleness baseline matches getFileHash, which hashes the same raw bytes.
	// Hashing the transformed content instead made CRLF / long-line files read
	// as permanently stale.
	rawHashBytes := sha256.Sum256(content)

	// Transcode Windows text encodings to UTF-8 (UTF-16 BOM → UTF-8) and strip a
	// UTF-8 BOM, so the properties panel and the model always see clean UTF-8
	// regardless of how the file was saved. IsBinaryFile above already whitelists
	// UTF-16 BOM files that the null-byte heuristic would otherwise reject.
	content = decodeTextBytes(content)

	fullContent := strings.ReplaceAll(string(content), "\r\n", "\n")
	lines := strings.Split(fullContent, "\n")
	totalLines := len(lines)

	// Raw mode returns the exact on-disk bytes: no per-line truncation and no
	// DefaultMaxLines cap. Sandboxed exploration code (query_code's read-only
	// filesystem) processes files programmatically — JSON.parse, hashing, line
	// counting — so the context-trimming that keeps minified files out of the
	// LLM prompt would instead corrupt the data (a truncated line + an injected
	// truncation marker makes JSON.parse fail at the cut point). Only the
	// LLM-facing read tool wants the trimmed view.
	raw, _ := params["raw"].(bool)

	// Truncate over-long lines (keeps minified/generated files from flooding the
	// context). truncateLineForContext cuts on a UTF-8 rune boundary — a raw
	// byte slice at MaxLineLength can split a multi-byte character and emit an
	// invalid rune the model then wastes turns trying to "repair" — and marks
	// how much was elided so the line reads as truncated, not corrupted.
	if !raw {
		for i, line := range lines {
			if len(line) > MaxLineLength {
				lines[i] = truncateLineForContext(line)
			}
		}
		// Rebuild fullContent after potential line truncation
		fullContent = strings.Join(lines, "\n")
	}

	var resultContent string
	var readMode string
	var lineOffset int // 1-indexed line number where content starts
	var lineCount int  // Number of lines in resultContent

	// Determine read mode and extract content
	// Priority: tail > head > around > lineRange > full

	if tail, ok := params["tail"].(float64); ok && tail > 0 {
		// Tail mode: last N lines
		tailCount := int(tail)
		readMode = fmt.Sprintf("Last %d lines", tailCount)

		if tailCount >= totalLines {
			resultContent = fullContent
			lineOffset = 1
			lineCount = totalLines
		} else {
			resultContent = strings.Join(lines[totalLines-tailCount:], "\n")
			lineOffset = totalLines - tailCount + 1
			lineCount = tailCount
		}

	} else if head, ok := params["head"].(float64); ok && head > 0 {
		// Head mode: first N lines
		headCount := int(head)
		readMode = fmt.Sprintf("First %d lines", headCount)

		if headCount >= totalLines {
			resultContent = fullContent
			lineOffset = 1
			lineCount = totalLines
		} else {
			resultContent = strings.Join(lines[:headCount], "\n")
			lineOffset = 1
			lineCount = headCount
		}

	} else if aroundParam, ok := params["around"].(map[string]any); ok {
		// Around mode: lines around a specific line
		line, lineOk := aroundParam["line"].(float64)
		context, contextOk := aroundParam["context"].(float64)

		if !lineOk || line <= 0 {
			return nil, fmt.Errorf("around mode requires a valid 'line' parameter")
		}

		contextLines := 10 // default
		if contextOk && context > 0 {
			contextLines = int(context)
		}

		targetLine := int(line)
		startIdx := targetLine - contextLines - 1
		endIdx := targetLine + contextLines

		if startIdx < 0 {
			startIdx = 0
		}
		if endIdx > totalLines {
			endIdx = totalLines
		}

		readMode = fmt.Sprintf("Around line %d", targetLine)
		resultContent = strings.Join(lines[startIdx:endIdx], "\n")
		lineOffset = startIdx + 1 // Convert 0-indexed to 1-indexed
		lineCount = endIdx - startIdx

	} else if lineRange, ok := params["lineRange"].(map[string]any); ok {
		// Line range mode: specific range of lines
		start, startOk := lineRange["start"].(float64)
		end, endOk := lineRange["end"].(float64)

		if !startOk || !endOk || start <= 0 || end <= 0 {
			return nil, fmt.Errorf("lineRange requires valid 'start' and 'end' parameters")
		}

		if start > end {
			return nil, fmt.Errorf("invalid line range: start (%d) must be <= end (%d)", int(start), int(end))
		}

		startIdx := int(start) - 1
		endIdx := int(end)

		if startIdx < 0 {
			startIdx = 0
		}
		if endIdx > totalLines {
			endIdx = totalLines
		}
		if startIdx > endIdx {
			startIdx = endIdx
		}

		readMode = fmt.Sprintf("Lines %d-%d", int(start), int(end))
		resultContent = strings.Join(lines[startIdx:endIdx], "\n")
		lineOffset = int(start)
		lineCount = endIdx - startIdx

	} else {
		// Full file mode. The line ceiling is DefaultMaxLines unless the caller
		// names its own with maxLines, where 0 means "no ceiling" — what a
		// viewer displaying the file wants, as against the context-trimming the
		// LLM-facing read wants. Over-long lines are still truncated either
		// way: only raw mode returns them whole.
		maxLines := DefaultMaxLines
		if requested, ok := params["maxLines"].(float64); ok && requested >= 0 {
			maxLines = int(requested)
		}
		if !raw && maxLines > 0 && totalLines > maxLines {
			// Truncate to first maxLines lines
			readMode = fmt.Sprintf("Lines 1-%d (truncated)", maxLines)
			resultContent = strings.Join(lines[:maxLines], "\n")
			lineOffset = 1
			lineCount = maxLines
		} else {
			readMode = "Full file"
			resultContent = fullContent
			lineOffset = 1
			lineCount = totalLines
		}
	}

	// Compute hash for detecting external file changes. Hash the raw on-disk
	// bytes captured above (before decode/normalize/truncation) so it matches
	// getFileHash — hashing the transformed content made CRLF / long-line files
	// read as permanently stale.
	contentHash := hex.EncodeToString(rawHashBytes[:])

	return map[string]any{
		"content":     resultContent,
		"path":        path,
		"language":    detectLanguage(path),
		"exists":      true,
		"size":        fileInfo.Size(),
		"mime":        MimeForPath(absPath),
		"isBinary":    false,
		"totalLines":  totalLines,
		"readMode":    readMode,
		"lineOffset":  lineOffset,  // 1-indexed start line
		"lineCount":   lineCount,   // Number of lines in content
		"contentHash": contentHash, // SHA-256 for detecting external changes
	}, nil
}

// writeFile writes content to a file (creates or overwrites)
func (ops *FileOperations) writeFile(params map[string]any) (any, error) {
	// Validate path parameter
	path, err := ValidateStringParam(params["path"], "path", true, 4096)
	if err != nil {
		return nil, fmt.Errorf("invalid path parameter: %w", err)
	}

	// Validate content parameter
	content, err := ValidateStringParam(params["content"], "content", false, 10*1024*1024) // 10MB max
	if err != nil {
		return nil, fmt.Errorf("invalid content parameter: %w", err)
	}

	// Optional: dryRun mode - validate everything but don't write. Used by the
	// plugin to fail fast before opening the approval modal for an impossible
	// write (mirrors editFile's dryRun).
	dryRun, _ := params["dryRun"].(bool)

	// The JS approval flow is the policy gate; the backend just sanitises.
	absPath, err := ops.scope.Sanitize(path)
	if err != nil {
		return nil, fmt.Errorf("invalid path '%s': %w", path, err)
	}

	// Serialize the stat→write window against any concurrent mutation of the
	// same file (see pathLocker).
	unlock := fileMutationLock.lock(absPath)
	defer unlock()

	// Check if file already exists, and reject directories outright.
	info, statErr := os.Stat(absPath)
	fileExists := statErr == nil
	if fileExists && info.IsDir() {
		return nil, fmt.Errorf("cannot write file '%s': path is a directory", path)
	}
	if statErr != nil && !os.IsNotExist(statErr) {
		return nil, fmt.Errorf("failed to stat '%s': %w", path, statErr)
	}

	if dryRun {
		// Side-effect-free validation: a dryRun must NOT touch the filesystem.
		// We probe only what we can observe without mutating anything —
		// creating the parent tree or O_CREATE'ing the target here would leak
		// side effects before the write is approved.
		if fileExists {
			// Existing file: open O_WRONLY (no O_CREATE, no O_TRUNC) to check
			// writability. This modifies neither content, mode, nor mtime.
			f, openErr := os.OpenFile(absPath, os.O_WRONLY, 0)
			if openErr != nil {
				return nil, fmt.Errorf("cannot write '%s': %w", path, openErr)
			}
			_ = f.Close()
		} else {
			// New file: walk up to the nearest existing ancestor and require
			// it to be a directory. We deliberately do NOT create parents or
			// probe with O_CREATE — a lexical/stat check can't prove
			// writability portably (Windows ACLs), so we accept that some
			// permission failures surface only at the real (post-approval)
			// write. That trade beats the old probe's side effects.
			ancestor := filepath.Dir(absPath)
			for {
				ancestorInfo, statErr := os.Stat(ancestor)
				if statErr == nil {
					if !ancestorInfo.IsDir() {
						return nil, fmt.Errorf("cannot write '%s': parent path '%s' is not a directory", path, ancestor)
					}
					break
				}
				if !os.IsNotExist(statErr) {
					return nil, fmt.Errorf("cannot write '%s': %w", path, statErr)
				}
				parent := filepath.Dir(ancestor)
				if parent == ancestor {
					break // reached the filesystem root without finding a real dir
				}
				ancestor = parent
			}
		}
		return map[string]any{
			"path":    path,
			"created": !fileExists,
			"size":    len(content),
			"dryRun":  true,
		}, nil
	}

	// Defence in depth: a real (non-dryRun) write to a path outside the working
	// directory and every allowed root is refused unless the request is
	// explicitly marked user-approved. The JS approval flow is the primary gate;
	// this ensures a JS bug can't silently write anywhere on disk.
	approved, _ := params["outOfRootApproved"].(bool)
	if err := ops.scope.AuthorizeOutOfScopeWrite(absPath, path, "write", approved); err != nil {
		return nil, err
	}

	// Optional: expectedHash - the hash of the existing file the caller's
	// approved diff was computed against. Refuse the overwrite if the file's
	// current bytes hash differently: the file changed between the approved
	// preview and this write, so the approved diff no longer describes what
	// would be destroyed. A file deleted in the interim is not an error — the
	// write then simply creates it with the approved content.
	if expectedHash, _ := params["expectedHash"].(string); expectedHash != "" && fileExists {
		raw, readErr := os.ReadFile(absPath)
		if readErr != nil {
			return nil, fmt.Errorf("failed to read file '%s' for change detection: %w", path, readErr)
		}
		currentHashBytes := sha256.Sum256(raw)
		if hex.EncodeToString(currentHashBytes[:]) != expectedHash {
			return nil, fmt.Errorf("file '%s' has changed on disk since the write was prepared. Re-read the file and retry", path)
		}
	}

	// Ensure parent directory exists. This runs only on the real
	// (post-approval) write — never during dryRun — so pre-approval validation
	// leaves no directories behind.
	parentDir := filepath.Dir(absPath)
	if err := os.MkdirAll(parentDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create parent directory '%s': %w. Check file path and permissions", parentDir, err)
	}

	// Write file, preserving the existing file's permissions on a full rewrite
	// (a new file gets 0644). Without this, overwriting an existing file would
	// reset its mode bits — dropping an executable bit or tightened perms.
	mode := os.FileMode(0644)
	if fileExists {
		mode = info.Mode()
	}
	if err := writeFileAtomic(absPath, []byte(content), mode); err != nil {
		return nil, fmt.Errorf("failed to write file '%s': %w. Check permissions and disk space", path, err)
	}

	// Echo the post-write hash: it lands in the transcript's record of this
	// write, becoming the freshness baseline that lets a follow-up mutation of
	// the same file pass the JS staleness guard without a re-read.
	writtenHashBytes := sha256.Sum256([]byte(content))
	writtenHash := hex.EncodeToString(writtenHashBytes[:])

	// Get file info for response
	fileInfo, err := os.Stat(absPath)
	if err != nil {
		// File was written but we can't stat it - still return success
		return map[string]any{
			"path":        path,
			"created":     !fileExists,
			"size":        len(content),
			"contentHash": writtenHash,
		}, nil
	}

	return map[string]any{
		"path":        path,
		"created":     !fileExists,
		"size":        fileInfo.Size(),
		"contentHash": writtenHash,
	}, nil
}

// editFile modifies an existing file using search-and-replace
func (ops *FileOperations) editFile(params map[string]any) (any, error) {
	// Validate path parameter
	path, err := ValidateStringParam(params["path"], "path", true, 4096)
	if err != nil {
		return nil, fmt.Errorf("invalid path parameter: %w", err)
	}

	// Validate old_str parameter (normalized from various aliases)
	oldStr, err := ValidateStringParam(params["old_str"], "old_str", true, 10*1024*1024)
	if err != nil {
		return nil, fmt.Errorf("invalid old_str parameter: %w", err)
	}

	// Validate new_str parameter (normalized from various aliases)
	newStr, err := ValidateStringParam(params["new_str"], "new_str", false, 10*1024*1024)
	if err != nil {
		return nil, fmt.Errorf("invalid new_str parameter: %w", err)
	}

	// Reject a no-op edit: old_str and new_str are identical, so the replace
	// would rewrite the file with unchanged content and report success — a
	// silent no-op that hides a mistake from the model (e.g. it copied the
	// wrong block, or forgot to adjust new_str after editing old_str).
	// Surfaces this as an error so the model can self-correct.
	if oldStr == newStr {
		return nil, fmt.Errorf("old_str and new_str are identical, this edit is a no-op")
	}

	// Optional: dryRun mode - validate everything but don't write
	dryRun, _ := params["dryRun"].(bool)

	// Optional: replace_all mode - replace every exact occurrence instead of
	// requiring old_str to be unique. This is deliberately limited to exact
	// matching so flexible fallback edits remain surgical and unambiguous.
	replaceAll, _ := params["replace_all"].(bool)

	// Optional: expectedHash - the caller's staleness baseline (the contentHash
	// its approved dryRun preview reported). When present, the edit is refused
	// if the file's current bytes hash differently: the file changed between
	// the preview the user approved and this write.
	expectedHash, _ := params["expectedHash"].(string)

	// Sanitise, lock, and read the existing file (see openForMutation).
	absPath, fileInfo, currentContentStr, usedCRLF, currentHash, unlock, err := ops.openForMutation(path)
	if err != nil {
		return nil, err
	}
	defer unlock()

	if expectedHash != "" && expectedHash != currentHash {
		return nil, fmt.Errorf("file '%s' has changed on disk since the edit was prepared. Re-read the file and retry with its current content", path)
	}

	var newContentStr string
	var matchStrategy string

	// Layered matching, falling back when an exact match fails:
	// 1. Exact match - fastest and most reliable
	// 2. Flexible whitespace - handles indentation/formatting differences
	// 3. Regex flexible - handles more complex whitespace variations

	// Strategy 1: Try exact match first
	if strings.Contains(currentContentStr, oldStr) {
		occurrences := strings.Count(currentContentStr, oldStr)
		if occurrences > 1 && !replaceAll {
			return nil, fmt.Errorf("search string appears %d times in file '%s'. The old_str is ambiguous - it matches multiple locations in the file. Please provide a longer, unique search string that matches only the specific section you want to replace, or set replace_all to true to replace every occurrence", occurrences, path)
		}
		if replaceAll {
			newContentStr = strings.ReplaceAll(currentContentStr, oldStr, newStr)
			matchStrategy = "exact-all"
		} else {
			newContentStr = strings.Replace(currentContentStr, oldStr, newStr, 1)
			matchStrategy = "exact"
		}
	} else {
		// Strategy 2: Try flexible whitespace match
		idx, originalMatch := findNormalizedMatch(currentContentStr, oldStr)
		if idx != -1 {
			// Fail closed on ambiguity, exactly as the exact (strategy 1) and
			// regex (strategy 3) paths do: findNormalizedMatch returns only the
			// FIRST normalized hit, so without this a flexible match that occurs
			// in several places would silently rewrite one of them — the wrong
			// region — instead of surfacing the ambiguity. A stale/imprecise
			// old_str must fail loudly (the model then re-reads) rather than
			// corrupt the file at a low-confidence location.
			normalizedOccurrences := strings.Count(normalizeWhitespace(currentContentStr), normalizeWhitespace(oldStr))
			if normalizedOccurrences > 1 {
				return nil, fmt.Errorf("search string matches %d locations in file '%s' (using flexible whitespace matching; replace_all only applies to exact matches). The old_str is ambiguous. Re-read the file and copy the exact text including whitespace, or provide a longer, unique search string", normalizedOccurrences, path)
			}
			// Found a unique match with flexible whitespace - use the original text to preserve indentation
			newContentStr = currentContentStr[:idx] + newStr + currentContentStr[idx+len(originalMatch):]
			matchStrategy = "flexible-whitespace"
		} else {
			// Strategy 3: Try regex match with flexible whitespace
			pattern := makeFlexiblePattern(oldStr)
			re, err := regexp.Compile(pattern)
			if err == nil {
				matches := re.FindAllStringIndex(currentContentStr, -1)
				if len(matches) == 1 {
					match := matches[0]
					newContentStr = currentContentStr[:match[0]] + newStr + currentContentStr[match[1]:]
					matchStrategy = "regex-flexible"
				} else if len(matches) > 1 {
					return nil, fmt.Errorf("search string matches %d locations in file '%s' (using flexible whitespace matching; replace_all only applies to exact matches). The old_str is ambiguous. Re-read the file and copy the exact text including whitespace, or provide a longer, unique search string", len(matches), path)
				}
			}
		}
	}

	// All strategies failed. Test matchStrategy (not newContentStr) so a
	// legitimate edit that replaces the whole file with "" isn't misreported as
	// a failed search. The detail's contentHash lets the caller tell "your
	// old_str is wrong" from "the file changed since you read it".
	if matchStrategy == "" {
		return nil, &CodedError{
			Code: CodeSearchNotFound,
			Msg: searchNotFoundMessage(path,
				hasEscapingIssues(oldStr, currentContentStr),
				findApproximateLocation(oldStr, currentContentStr)),
			Detail: map[string]any{"path": path, "contentHash": currentHash},
		}
	}

	// If dry-run mode, return full old and new file content for diff preview.
	// contentHash is the current on-disk file's hash: the JS edit tool
	// (replace-text) compares it against the hashes its transcript records for
	// this path and refuses the edit when none match, then echoes it back as
	// expectedHash on the real write.
	if dryRun {
		return map[string]any{
			"path":          path,
			"oldContent":    currentContentStr, // Full old file
			"newContent":    newContentStr,     // Full new file with edits applied
			"matchStrategy": matchStrategy,
			"contentHash":   currentHash,
			"dryRun":        true,
		}, nil
	}

	// Defence in depth: refuse an out-of-scope edit unless explicitly approved
	// (see writeFile and AuthorizeOutOfScopeWrite). Runs only on the real write —
	// the dryRun feasibility probe above already returned.
	approved, _ := params["outOfRootApproved"].(bool)
	if err := ops.scope.AuthorizeOutOfScopeWrite(absPath, path, "edit", approved); err != nil {
		return nil, err
	}

	// Write updated content, restoring the file's original CRLF line endings so an
	// edit to a pure-CRLF (Windows) file doesn't rewrite every line as LF (see
	// openForMutation). The post-write hash below is taken over these same on-disk
	// bytes so a follow-up edit's staleness check matches getFileHash's raw hash.
	outBytes := []byte(newContentStr)
	if usedCRLF {
		outBytes = []byte(strings.ReplaceAll(newContentStr, "\n", "\r\n"))
	}
	if err := writeFileAtomic(absPath, outBytes, fileInfo.Mode()); err != nil {
		return nil, fmt.Errorf("failed to write updated file '%s': %w. Check permissions and disk space", path, err)
	}

	// Calculate changes for response
	oldLines := strings.Count(oldStr, "\n") + 1
	newLines := strings.Count(newStr, "\n") + 1

	// Echo the post-write hash: it lands in the transcript's record of this
	// edit, becoming the freshness baseline that lets a follow-up mutation of
	// the same file pass the JS staleness guard without a re-read.
	newHashBytes := sha256.Sum256(outBytes)

	return map[string]any{
		"path":          path,
		"method":        "search-replace",
		"matchStrategy": matchStrategy,
		"oldLines":      oldLines,
		"newLines":      newLines,
		"size":          len(newContentStr),
		"contentHash":   hex.EncodeToString(newHashBytes[:]),
	}, nil
}

// editFileLines modifies an existing file by replacing a range of lines
func (ops *FileOperations) editFileLines(params map[string]any) (any, error) {
	// Validate path parameter
	path, err := ValidateStringParam(params["path"], "path", true, 4096)
	if err != nil {
		return nil, fmt.Errorf("invalid path parameter: %w", err)
	}

	// Validate startLine parameter
	startLineFloat, ok := params["startLine"].(float64)
	if !ok {
		return nil, fmt.Errorf("missing or invalid startLine parameter (must be a number)")
	}
	startLine := int(startLineFloat)
	if startLine <= 0 {
		return nil, fmt.Errorf("startLine must be greater than 0")
	}

	var endLine int

	// Validate newContent parameter (normalized from aliases)
	newContent, err := ValidateStringParam(params["newContent"], "newContent", false, 10*1024*1024)
	if err != nil {
		return nil, fmt.Errorf("invalid newContent parameter: %w", err)
	}

	// Optional: dryRun mode - validate everything but don't write
	dryRun, _ := params["dryRun"].(bool)

	// Optional: contextLine for validation (line number that should contain specific text)
	var contextLine int
	var contextText string
	if contextLineFloat, ok := params["contextLine"].(float64); ok {
		contextLine = int(contextLineFloat)
		if contextTextParam, ok := params["contextText"].(string); ok {
			contextText = contextTextParam
		}
	}

	// Optional: expectedHash - staleness baseline, as in editFile.
	expectedHash, _ := params["expectedHash"].(string)

	// Sanitise, lock, and read the existing file (see openForMutation).
	absPath, fileInfo, currentContentStr, usedCRLF, currentHash, unlock, err := ops.openForMutation(path)
	if err != nil {
		return nil, err
	}
	defer unlock()

	if expectedHash != "" && expectedHash != currentHash {
		return nil, fmt.Errorf("file '%s' has changed on disk since the edit was prepared. Re-read the file and retry with its current content", path)
	}

	lines := strings.Split(currentContentStr, "\n")
	totalLines := len(lines)

	// Determine endLine: optional. If not provided, defaults to totalLines. If provided, must be > 0.
	// Always capped at totalLines if the provided value is too large.
	endLine = totalLines // Default to end of file
	if endLineFloat, ok := params["endLine"].(float64); ok {
		parsedEndLine := int(endLineFloat)
		if parsedEndLine <= 0 {
			return nil, fmt.Errorf("provided endLine (%d) must be greater than 0, or omit endLine to replace to the end of the file", parsedEndLine)
		}
		endLine = parsedEndLine
	}

	// Cap endLine at totalLines if it's still too large (handles both default and provided values)
	if endLine > totalLines {
		endLine = totalLines
	}

	// Validate that startLine is not greater than endLine after endLine has been determined
	if startLine > endLine {
		return nil, fmt.Errorf("invalid line range: startLine (%d) must be <= endLine (%d)", startLine, endLine)
	}

	// Validate line range is within file bounds
	if startLine > totalLines {
		return nil, fmt.Errorf("startLine (%d) is beyond end of file (file has %d lines)", startLine, totalLines)
	}

	// Optional: Validate context line with flexible whitespace matching
	// This uses the same normalization strategy as editFile for consistency
	if contextLine > 0 && contextText != "" {
		if contextLine > totalLines {
			return nil, fmt.Errorf("contextLine (%d) is beyond end of file (file has %d lines)", contextLine, totalLines)
		}
		actualContextLine := lines[contextLine-1] // Convert to 0-indexed

		// Try exact match first (fastest); fall back to a normalized
		// (flexible-whitespace) match before treating it as a mismatch.
		if !strings.Contains(actualContextLine, contextText) {
			normalizedActual := strings.TrimSpace(actualContextLine)
			normalizedExpected := strings.TrimSpace(contextText)

			if !strings.Contains(normalizedActual, normalizedExpected) {
				// Context validation failed - provide enhanced error information
				// Search for the expected text in the entire file
				foundAtLine := -1
				matchCount := 0
				for i, line := range lines {
					normalizedLine := strings.TrimSpace(line)
					if strings.Contains(normalizedLine, normalizedExpected) {
						matchCount++
						if matchCount == 1 {
							foundAtLine = i + 1 // Convert to 1-indexed
						}
					}
				}

				// Build enhanced error message for frontend recovery
				if matchCount == 1 && foundAtLine != contextLine {
					return nil, fmt.Errorf(
						"line %d doesn't match expected content\nExpected: '%s'\nActual at line %d: '%s'\nNote: Expected text found at line %d",
						contextLine, contextText, contextLine, actualContextLine, foundAtLine)
				} else if matchCount > 1 {
					return nil, fmt.Errorf(
						"line %d doesn't match expected content\nExpected: '%s'\nActual at line %d: '%s'\nNote: Expected text found at %d locations in file",
						contextLine, contextText, contextLine, actualContextLine, matchCount)
				}
				return nil, fmt.Errorf(
					"line %d doesn't match expected content\nExpected: '%s'\nActual at line %d: '%s'",
					contextLine, contextText, contextLine, actualContextLine)
			}
		}
	}

	// Build new file content (for both dry-run and actual write)
	// Lines before the edit
	var newLines []string
	if startLine > 1 {
		newLines = append(newLines, lines[:startLine-1]...)
	}

	// Add new content (split into lines if it contains newlines)
	if newContent != "" {
		newContentLines := strings.Split(newContent, "\n")
		newLines = append(newLines, newContentLines...)
	}

	// Lines after the edit
	if endLine < totalLines {
		newLines = append(newLines, lines[endLine:]...)
	}

	newFileContent := strings.Join(newLines, "\n")

	// If dry-run mode, return full old and new file content for diff preview.
	// contentHash is the current on-disk file's staleness baseline (see editFile).
	if dryRun {
		return map[string]any{
			"path":        path,
			"oldContent":  currentContentStr, // Full old file (CRLF-normalized, matching newContent)
			"newContent":  newFileContent,    // Full new file with edits applied
			"contentHash": currentHash,
			"dryRun":      true,
		}, nil
	}

	// Defence in depth: refuse an out-of-scope edit unless explicitly approved
	// (see writeFile and AuthorizeOutOfScopeWrite). Runs only on the real write —
	// the dryRun feasibility probe above already returned.
	approved, _ := params["outOfRootApproved"].(bool)
	if err := ops.scope.AuthorizeOutOfScopeWrite(absPath, path, "edit", approved); err != nil {
		return nil, err
	}

	// Write updated content, restoring CRLF endings on a pure-CRLF file and
	// hashing the exact bytes written (see editFile and openForMutation).
	outBytes := []byte(newFileContent)
	if usedCRLF {
		outBytes = []byte(strings.ReplaceAll(newFileContent, "\n", "\r\n"))
	}
	if err := writeFileAtomic(absPath, outBytes, fileInfo.Mode()); err != nil {
		return nil, fmt.Errorf("failed to write updated file '%s': %w. Check permissions and disk space", path, err)
	}

	// Calculate changes for response
	linesReplaced := endLine - startLine + 1
	newLinesCount := strings.Count(newContent, "\n") + 1

	// Echo the post-write hash as the freshness baseline for follow-up
	// mutations (see editFile).
	newHashBytes := sha256.Sum256(outBytes)

	return map[string]any{
		"path":          path,
		"method":        "line-range",
		"startLine":     startLine,
		"endLine":       endLine,
		"linesReplaced": linesReplaced,
		"newLines":      newLinesCount,
		"size":          len(newFileContent),
		"contentHash":   hex.EncodeToString(newHashBytes[:]),
	}, nil
}

// languageByExt maps a lower-case file extension to the language id the client
// highlights it as. The browser keeps the same table in web/sdk/lib/languages.js
// (a file dropped into the UI never reaches us, so it has to work this out on
// its own); TestDetectLanguageMatchesClient fails when the two disagree.
var languageByExt = map[string]string{
	"js": "javascript", "mjs": "javascript", "cjs": "javascript", "jsx": "javascript",
	"ts": "typescript", "tsx": "typescript", "mts": "typescript", "cts": "typescript",
	"py": "python", "rb": "ruby", "go": "go", "rs": "rust", "java": "java",
	"c": "c", "h": "c",
	"cpp": "cpp", "cc": "cpp", "cxx": "cpp", "c++": "cpp",
	"hpp": "cpp", "hxx": "cpp", "h++": "cpp", "ipp": "cpp", "inl": "cpp",
	"cu": "cpp", "cuh": "cpp",
	"cs": "csharp", "php": "php", "swift": "swift", "kt": "kotlin", "kts": "kotlin",
	"sh": "bash", "bash": "bash", "zsh": "bash", "fish": "bash",
	"json": "json", "yaml": "yaml", "yml": "yaml", "toml": "toml",
	"xml": "xml", "html": "html", "htm": "html", "css": "css", "scss": "scss", "sass": "sass",
	"md": "markdown", "sql": "sql", "txt": "text",
	"ini": "ini", "cfg": "ini", "conf": "ini", "env": "ini", "editorconfig": "ini",
	"properties": "properties", "gradle": "groovy",
	"mk": "makefile", "cmake": "cmake", "dockerfile": "docker",
	"diff": "diff", "patch": "diff",
}

// languageByFilename maps a lower-case whole file name to a language id, for the
// build files that carry their type in the name rather than an extension.
var languageByFilename = map[string]string{
	"dockerfile": "docker", "containerfile": "docker",
	"makefile": "makefile", "gnumakefile": "makefile",
	"cmakelists.txt": "cmake",
}

// detectLanguage names the language of a file from its path, for the UI to
// highlight it with. A whole-name match wins over an extension, so CMakeLists.txt
// is CMake rather than the plain text its .txt claims.
func detectLanguage(filePath string) string {
	name := strings.ToLower(filepath.Base(filePath))
	if lang, ok := languageByFilename[name]; ok {
		return lang
	}
	ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(name)), ".")
	if lang, ok := languageByExt[ext]; ok {
		return lang
	}

	return "text"
}

// normalizeWhitespace removes leading/trailing whitespace from each line
func normalizeWhitespace(s string) string {
	lines := strings.Split(s, "\n")
	normalized := make([]string, len(lines))
	for i, line := range lines {
		normalized[i] = strings.TrimSpace(line)
	}
	return strings.Join(normalized, "\n")
}

// findNormalizedMatch finds a match ignoring leading/trailing whitespace per line
// Returns the start index in the original string, or -1 if not found
func findNormalizedMatch(haystack, needle string) (int, string) {
	normalizedHaystack := normalizeWhitespace(haystack)
	normalizedNeedle := normalizeWhitespace(needle)

	idx := strings.Index(normalizedHaystack, normalizedNeedle)
	if idx == -1 {
		return -1, ""
	}

	// Map back to original string to preserve indentation
	haystackLines := strings.Split(haystack, "\n")
	needleLines := strings.Split(needle, "\n")
	normalizedHaystackLines := strings.Split(normalizedHaystack, "\n")

	// Find which line the match starts on
	lineOffset := 0
	charCount := 0
	for i, line := range normalizedHaystackLines {
		if charCount >= idx {
			lineOffset = i
			break
		}
		charCount += len(line) + 1 // +1 for newline
	}

	// Extract the original text at this position
	if lineOffset+len(needleLines) > len(haystackLines) {
		return -1, ""
	}

	originalMatch := strings.Join(haystackLines[lineOffset:lineOffset+len(needleLines)], "\n")

	// Calculate character offset in original string
	originalIdx := 0
	for i := 0; i < lineOffset; i++ {
		originalIdx += len(haystackLines[i]) + 1
	}

	return originalIdx, originalMatch
}

// makeFlexiblePattern creates a regex pattern with flexible whitespace
func makeFlexiblePattern(s string) string {
	// Escape special regex characters except whitespace
	escaped := regexp.QuoteMeta(s)
	// Replace literal \s with flexible whitespace pattern
	pattern := strings.ReplaceAll(escaped, `\ `, `\s+`)
	pattern = strings.ReplaceAll(pattern, `\t`, `\s+`)
	pattern = strings.ReplaceAll(pattern, `\n`, `\s*\n\s*`)
	return pattern
}

// searchNotFoundMessage is what an edit whose old_str matched nothing tells the
// model: which file, an escaping hint when unescaping old_str would have
// matched, the file around the likeliest intended location (context, from
// findApproximateLocation, may be empty), and what to do next.
func searchNotFoundMessage(path string, escaping bool, context string) string {
	parts := []string{fmt.Sprintf("Search failed in '%s'.", path)}
	if escaping {
		parts = append(parts, "ESCAPING ERROR: old_str is LITERAL, don't escape backticks, ${}, (), [], {}.")
	}
	if context != "" {
		parts = append(parts, context)
	}
	parts = append(parts, "Re-read file and use exact text including whitespace.")
	return strings.Join(parts, " ")
}

// hasEscapingIssues reports whether oldStr carries backslash escapes that are
// literal in the file: oldStr does not match, but would once unescaped.
func hasEscapingIssues(oldStr, fileContent string) bool {
	// Check if oldStr has escaped characters that might be literal in the file
	hasEscapedBackticks := strings.Contains(oldStr, "\\`")
	hasEscapedDollar := strings.Contains(oldStr, "\\$")
	hasEscapedParens := strings.Contains(oldStr, "\\(") || strings.Contains(oldStr, "\\)")
	hasEscapedBrackets := strings.Contains(oldStr, "\\[") || strings.Contains(oldStr, "\\]")
	hasEscapedBraces := strings.Contains(oldStr, "\\{") || strings.Contains(oldStr, "\\}")

	if hasEscapedBackticks || hasEscapedDollar || hasEscapedParens || hasEscapedBrackets || hasEscapedBraces {
		// Try unescaping and see if it matches
		unescaped := oldStr
		unescaped = strings.ReplaceAll(unescaped, "\\`", "`")
		unescaped = strings.ReplaceAll(unescaped, "\\$", "$")
		unescaped = strings.ReplaceAll(unescaped, "\\(", "(")
		unescaped = strings.ReplaceAll(unescaped, "\\)", ")")
		unescaped = strings.ReplaceAll(unescaped, "\\[", "[")
		unescaped = strings.ReplaceAll(unescaped, "\\]", "]")
		unescaped = strings.ReplaceAll(unescaped, "\\{", "{")
		unescaped = strings.ReplaceAll(unescaped, "\\}", "}")

		return strings.Contains(fileContent, unescaped)
	}
	return false
}

// findApproximateLocation tries to find an approximate location in the file for diagnostics
func findApproximateLocation(oldStr, fileContent string) string {
	fileLines := strings.Split(fileContent, "\n")
	searchLines := strings.Split(oldStr, "\n")

	if len(searchLines) == 0 {
		return ""
	}

	// Pick the most distinctive line from the search string to match against.
	// Skip generic lines (comments, braces, blank) that would match everywhere.
	probe := ""
	for _, sl := range searchLines {
		trimmed := strings.TrimSpace(sl)
		if len(trimmed) < 6 {
			continue
		}
		// Skip common boilerplate that matches too broadly
		if strings.HasPrefix(trimmed, "/**") || strings.HasPrefix(trimmed, "* ") ||
			strings.HasPrefix(trimmed, "*/") || strings.HasPrefix(trimmed, "//") ||
			strings.HasPrefix(trimmed, "#") || trimmed == "{" || trimmed == "}" {
			continue
		}
		probe = trimmed
		break
	}
	// Fallback: use the longest trimmed line if no distinctive line found
	if probe == "" {
		for _, sl := range searchLines {
			trimmed := strings.TrimSpace(sl)
			if len(trimmed) > len(probe) {
				probe = trimmed
			}
		}
	}

	if len(probe) < 3 {
		return "" // Too short to be useful
	}

	// Try progressively shorter prefixes of the probe to handle cases where
	// the search string's line is longer than the file's actual line
	// (e.g., function signature with extra params that don't exist in the file).
	for _, maxLen := range []int{80, 40, 20} {
		truncated := probe
		if len(truncated) > maxLen {
			truncated = truncated[:maxLen]
		}

		for i, line := range fileLines {
			if strings.Contains(strings.TrimSpace(line), truncated) {
				// Found approximate location - show context
				startLine := max(i-2, 0)
				endLine := min(i+5, len(fileLines))

				var contextLines strings.Builder
				fmt.Fprintf(&contextLines, "\n\nApproximate file content near possible match (lines %d-%d):\n", startLine+1, endLine)
				for j := startLine; j < endLine; j++ {
					marker := " "
					if j == i {
						marker = "→"
					}
					fmt.Fprintf(&contextLines, "%s%d: %s\n", marker, j+1, fileLines[j])
				}
				return contextLines.String()
			}
		}
	}

	return ""
}

// getFileHash returns the SHA-256 hash of a file for cheap staleness detection
// This is much faster than reading the entire file content
func (ops *FileOperations) getFileHash(params map[string]any) (any, error) {
	// Validate path parameter
	path, err := ValidateStringParam(params["path"], "path", true, 4096)
	if err != nil {
		return nil, err
	}

	// Validate path security
	pathResult, err := ops.scope.Resolve(path)
	if err != nil {
		return nil, err
	}
	absPath := pathResult.AbsPath

	// Check if file exists
	fileInfo, statErr := os.Stat(absPath)
	if statErr != nil {
		if os.IsNotExist(statErr) {
			return map[string]any{
				"path":   path,
				"exists": false,
			}, nil
		}
		return nil, fmt.Errorf("failed to stat file: %w", statErr)
	}

	// Check if it's a directory
	if fileInfo.IsDir() {
		return nil, fmt.Errorf("path is a directory, not a file: %s", path)
	}

	// Read file and compute hash
	content, err := os.ReadFile(absPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read file: %w", err)
	}

	contentHashBytes := sha256.Sum256(content)
	contentHash := hex.EncodeToString(contentHashBytes[:])
	fileModifiedAt := fileInfo.ModTime().UnixMilli()

	return map[string]any{
		"path":           path,
		"exists":         true,
		"contentHash":    contentHash,
		"fileModifiedAt": fileModifiedAt,
	}, nil
}

// stat returns file/directory metadata without reading content
func (ops *FileOperations) stat(params map[string]any) (any, error) {
	path, err := ValidateStringParam(params["path"], "path", true, 4096)
	if err != nil {
		return nil, err
	}

	// User-initiated metadata checks accompany @-mention/file-picker pins, which
	// may refer to paths outside the project. LLM file operations remain scoped.
	userInitiated, _ := params["userInitiated"].(bool)
	absPath, err := ops.scope.ResolveUserInitiated(path, userInitiated)
	if err != nil {
		return nil, err
	}

	fileInfo, statErr := os.Stat(absPath)
	if statErr != nil {
		if os.IsNotExist(statErr) {
			return map[string]any{
				"path":   path,
				"exists": false,
			}, nil
		}
		return nil, fmt.Errorf("failed to stat path: %w", statErr)
	}

	return map[string]any{
		"path":        path,
		"exists":      true,
		"isFile":      !fileInfo.IsDir(),
		"isDirectory": fileInfo.IsDir(),
		"size":        fileInfo.Size(),
		"modified":    fileInfo.ModTime().UnixMilli(),
	}, nil
}

// mkdir creates a directory (and parents if recursive)
func (ops *FileOperations) mkdir(params map[string]any) (any, error) {
	path, err := ValidateStringParam(params["path"], "path", true, 4096)
	if err != nil {
		return nil, err
	}

	pathResult, err := ops.scope.Resolve(path)
	if err != nil {
		return nil, err
	}

	recursive := false
	if r, ok := params["recursive"].(bool); ok {
		recursive = r
	}

	if recursive {
		err = os.MkdirAll(pathResult.AbsPath, 0755)
	} else {
		err = os.Mkdir(pathResult.AbsPath, 0755)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to create directory: %w", err)
	}

	return map[string]any{
		"path": path,
	}, nil
}
