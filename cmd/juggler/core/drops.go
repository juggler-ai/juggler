//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// DropsDirName is the folder in the project root that holds files dropped into
// a conversation too large (or too binary) to inline: the agent's file tools
// read them where they are. It lives in the project, never in state kept
// outside it, because that is where every workspace's tools can read. It
// carries its own `.gitignore` of `*`, so nothing in it is ever committed and
// the project's own `.gitignore` is left alone.
const DropsDirName = ".juggler-drops"

// ErrEmptyDrop is StoreDrop's answer to a body with no bytes in it.
var ErrEmptyDrop = errors.New("empty drop")

// dropSniffBytes is how much of a drop's head the preview inspects.
const dropSniffBytes = 64 << 10

// The preview's bounds: lines shown, characters per line, characters in all,
// and archive entries listed.
const (
	dropPreviewLines      = 20
	dropPreviewLineChars  = 300
	dropPreviewTotalChars = 4000
	dropPreviewEntries    = 50
)

// DropPreview is what the model is shown of a dropped file up front, so it can
// decide how to read it without reading it whole.
type DropPreview struct {
	// Mime is the sniffed content type (http.DetectContentType).
	Mime string `json:"mime"`
	// Text reports that the head is UTF-8 text with no NUL bytes.
	Text bool `json:"text"`
	// Lines is the file's line count, for a text file.
	Lines int64 `json:"lines,omitempty"`
	// Head is the file's first lines, each and all of them bounded, for a text
	// file.
	Head string `json:"head,omitempty"`
	// Entries names an archive's first entries, and EntryCount how many it has
	// in all (zip, and zip-based formats such as docx and xlsx).
	Entries    []string `json:"entries,omitempty"`
	EntryCount int      `json:"entryCount,omitempty"`
}

// DropRef says where a stored drop is and what it holds.
type DropRef struct {
	// Path is project-relative, with forward slashes.
	Path string `json:"path"`
	// AbsPath is the same file's absolute path, which every workspace's tools
	// can read: a worktree conversation's shell runs in the worktree, where
	// Path would not resolve.
	AbsPath  string      `json:"absPath"`
	Filename string      `json:"filename"`
	Bytes    int64       `json:"bytes"`
	SHA256   string      `json:"sha256"`
	Preview  DropPreview `json:"preview"`
}

// StoreDrop writes a dropped file's bytes to
// <project>/.juggler-drops/<sha prefix>/<name>, name cleaned to one safe path
// element, and says where it is and what it holds.
//
// The body streams to a temporary file in the drops folder while it is hashed
// and sniffed, then is renamed into place, so a half-written drop is never at
// a path the model is given, and nothing is left behind when the body fails
// (a caller's size cap included: its error is returned as it is). The same
// bytes under the same name land on the same path, and a second store of them
// keeps the first.
func StoreDrop(project, rawName string, body io.Reader) (DropRef, error) {
	name := sanitizeDropName(rawName)
	dir := filepath.Join(project, DropsDirName)
	if err := ensureDropsDir(dir); err != nil {
		return DropRef{}, err
	}
	tmp, err := os.CreateTemp(dir, ".upload-*")
	if err != nil {
		return DropRef{}, err
	}
	tmpPath := tmp.Name()
	placed := false
	defer func() {
		if !placed {
			_ = tmp.Close()
			_ = os.Remove(tmpPath)
		}
	}()

	hash := sha256.New()
	head := &headWriter{limit: dropSniffBytes}
	lines := &lineCounter{}
	n, err := io.Copy(io.MultiWriter(tmp, hash, head, lines), body)
	if err != nil {
		return DropRef{}, err
	}
	if n == 0 {
		return DropRef{}, ErrEmptyDrop
	}
	if err := tmp.Close(); err != nil {
		return DropRef{}, err
	}

	sum := hex.EncodeToString(hash.Sum(nil))
	destDir := filepath.Join(dir, sum[:12])
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return DropRef{}, err
	}
	dest := filepath.Join(destDir, name)
	if err := placeDrop(tmpPath, dest); err != nil {
		return DropRef{}, err
	}
	placed = true

	return DropRef{
		Path:     filepath.ToSlash(filepath.Join(DropsDirName, sum[:12], name)),
		AbsPath:  dest,
		Filename: name,
		Bytes:    n,
		SHA256:   sum,
		Preview:  dropPreview(dest, head.buf.Bytes(), n, lines.count(n)),
	}, nil
}

// placeDrop moves the finished upload at tmp to dest. When dest already holds
// a file, it is these same bytes (its folder is named by their hash, and the
// name is the same), so the upload is discarded and the file kept — which also
// settles two identical uploads racing to the same path.
func placeDrop(tmp, dest string) error {
	if _, err := os.Stat(dest); err == nil {
		return os.Remove(tmp)
	}
	if err := os.Rename(tmp, dest); err != nil {
		if _, statErr := os.Stat(dest); statErr == nil {
			return os.Remove(tmp)
		}
		return err
	}
	return nil
}

// ensureDropsDir creates the drops folder and the `.gitignore` that keeps its
// contents out of git.
func ensureDropsDir(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	ignore := filepath.Join(dir, ".gitignore")
	if _, err := os.Stat(ignore); err == nil {
		return nil
	}
	return os.WriteFile(ignore, []byte("# Files dropped into Juggler conversations; never committed.\n*\n"), 0o644)
}

// dropNameFallback names a drop whose own name has nothing usable left.
const dropNameFallback = "dropped-file"

// maxDropNameBytes bounds a stored drop's name, well inside every filesystem's
// limit on one path element.
const maxDropNameBytes = 200

// windowsReservedNames are the device names Windows refuses as a file's name,
// with or without an extension.
var windowsReservedNames = map[string]bool{
	"CON": true, "PRN": true, "AUX": true, "NUL": true,
	"COM1": true, "COM2": true, "COM3": true, "COM4": true, "COM5": true, "COM6": true, "COM7": true, "COM8": true, "COM9": true,
	"LPT1": true, "LPT2": true, "LPT3": true, "LPT4": true, "LPT5": true, "LPT6": true, "LPT7": true, "LPT8": true, "LPT9": true,
}

// sanitizeDropName makes a dropped file's name safe as one path element on
// every platform: its last path segment only, with control characters removed,
// characters Windows forbids replaced, no trailing dots or spaces, no device
// name, and a bounded length that keeps the extension.
func sanitizeDropName(raw string) string {
	name := raw
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		name = name[i+1:]
	}
	name = strings.Map(func(c rune) rune {
		switch {
		case c < 0x20 || c == 0x7f || c == utf8.RuneError:
			return -1
		case strings.ContainsRune(`<>:"|?*`, c):
			return '_'
		}
		return c
	}, name)
	name = strings.TrimRight(strings.TrimSpace(name), ". ")
	if name == "" {
		return dropNameFallback
	}
	stem := name
	if i := strings.IndexByte(name, '.'); i >= 0 {
		stem = name[:i]
	}
	if windowsReservedNames[strings.ToUpper(strings.TrimSpace(stem))] {
		name = "_" + name
	}
	if len(name) > maxDropNameBytes {
		ext := filepath.Ext(name)
		if len(ext) > 20 {
			ext = ""
		}
		stem := name[:len(name)-len(ext)]
		cut := maxDropNameBytes - len(ext)
		for cut > 0 && !utf8.RuneStart(stem[cut]) {
			cut--
		}
		name = stem[:cut] + ext
	}
	return name
}

// headWriter keeps the first limit bytes written to it and discards the rest.
type headWriter struct {
	limit int
	buf   bytes.Buffer
}

func (h *headWriter) Write(p []byte) (int, error) {
	if room := h.limit - h.buf.Len(); room > 0 {
		h.buf.Write(p[:min(room, len(p))])
	}
	return len(p), nil
}

// lineCounter counts the newlines written to it, remembering whether the last
// byte was one.
type lineCounter struct {
	newlines int64
	lastNL   bool
}

func (l *lineCounter) Write(p []byte) (int, error) {
	if len(p) > 0 {
		l.newlines += int64(bytes.Count(p, []byte{'\n'}))
		l.lastNL = p[len(p)-1] == '\n'
	}
	return len(p), nil
}

// count is the number of lines in total bytes: a final line with no newline
// counts too.
func (l *lineCounter) count(total int64) int64 {
	if total > 0 && !l.lastNL {
		return l.newlines + 1
	}
	return l.newlines
}

// dropPreview describes a stored drop from its head (and, for an archive, its
// central directory), never reading the file whole.
func dropPreview(path string, head []byte, total, lines int64) DropPreview {
	p := DropPreview{Mime: http.DetectContentType(head)}
	if looksLikeText(head, total) {
		p.Text = true
		p.Lines = lines
		p.Head = previewHead(head)
		return p
	}
	if p.Mime == "application/zip" {
		if zr, err := zip.OpenReader(path); err == nil {
			p.EntryCount = len(zr.File)
			for _, f := range zr.File[:min(len(zr.File), dropPreviewEntries)] {
				p.Entries = append(p.Entries, f.Name)
			}
			_ = zr.Close()
		}
	}
	return p
}

// looksLikeText reports whether a file's head is UTF-8 text: no NUL byte and
// valid UTF-8, allowing a rune cut off where the head stops short of the file.
func looksLikeText(head []byte, total int64) bool {
	if len(head) == 0 || bytes.IndexByte(head, 0) >= 0 {
		return false
	}
	if int64(len(head)) < total {
		for i := 0; i < utf8.UTFMax && len(head) > 0 && !utf8.Valid(head); i++ {
			head = head[:len(head)-1]
		}
	}
	return utf8.Valid(head)
}

// previewHead is a text file's first lines, each and all of them bounded so a
// minified file cannot fill the preview with one line.
func previewHead(head []byte) string {
	var out strings.Builder
	text := strings.TrimSuffix(strings.ToValidUTF8(string(head), ""), "\n")
	for i, line := range strings.SplitN(text, "\n", dropPreviewLines+1) {
		if i == dropPreviewLines {
			break
		}
		line = strings.TrimSuffix(line, "\r")
		if utf8.RuneCountInString(line) > dropPreviewLineChars {
			line = string([]rune(line)[:dropPreviewLineChars]) + "…"
		}
		if out.Len()+len(line) > dropPreviewTotalChars {
			break
		}
		out.WriteString(line)
		out.WriteByte('\n')
	}
	return out.String()
}
