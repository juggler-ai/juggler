//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// GenerateConvID returns a fresh `conv_<9-char base36>` id, matching the
// frontend's id shape. Used as a fallback when callers do not preallocate ids.
func GenerateConvID() string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	const idLen = 9
	max := big.NewInt(int64(len(alphabet)))
	var b strings.Builder
	b.Grow(len("conv_") + idLen)
	b.WriteString("conv_")
	for i := 0; i < idLen; i++ {
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			// Crypto rand failures are catastrophic and rare; fall back to
			// a deterministic char so we never produce an invalid empty id.
			b.WriteByte('0')
			continue
		}
		b.WriteByte(alphabet[n.Int64()])
	}
	return b.String()
}

// Per-conversation folder layout
//
// On disk every conversation lives in a single folder
//   .juggler/<sanitized-name>--<id>/
//     doc.yjs
//     undo.json
//     txns/
//       <txnID>.json
//
// The folder name is the source of truth for the human-readable name; the
// id is the stable internal handle (conv_<base36>) used everywhere in code,
// Yjs metadata and tests. The "--" separator is reserved by SanitizeName so
// the trailing "--<id>" is unambiguously the suffix.

// convDirSeparator separates the sanitized name from the id in folder names.
const convDirSeparator = "--"

// SanitizedNameMaxRunes caps the sanitized name length in RUNES — the
// user-facing "how many characters fit in a tab name" limit. It is the
// filesystem-side counterpart of the UI's MAX_CONVERSATION_NAME_LENGTH
// (web/js/utils/constants.js), and is kept a couple of runes ABOVE it so a
// name the UI accepts is never silently truncated when the folder is written.
//
// Runes alone don't bound filesystem safety, though: a rune can expand to a
// 4-byte UTF-8 sequence (emoji), so a 74-rune name could reach ~296 bytes and
// blow the 255-byte filename limit ext4/APFS enforce. sanitizedNameMaxBytes is
// the second, independent clamp that guarantees the full folder name
// "<name><sep><conv_id>" stays comfortably under 255 bytes even for an
// all-emoji name. Both caps apply; whichever binds first wins.
const SanitizedNameMaxRunes = 74

// sanitizedNameMaxBytes caps the sanitized name's UTF-8 byte length. With the
// "--<conv_id>" suffix (~16 bytes) this keeps the whole folder name well under
// the 255-byte filename limit on every supported filesystem, and keeps Windows
// MAX_PATH happy for reasonable project paths. See SanitizedNameMaxRunes.
const sanitizedNameMaxBytes = 200

var (
	// forbiddenCharRe matches characters that are unsafe in filenames on at
	// least one of macOS / Linux / Windows, plus C0/DEL controls.
	forbiddenCharRe = regexp.MustCompile(`[\\/:*?"<>|\x00-\x1f\x7f]`)

	// reservedWindowsNameRe matches reserved Windows device names regardless
	// of case or extension.
	reservedWindowsNameRe = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$`)

	// convIDRe matches the standard "conv_<body>" id form. The body is
	// permissive (alnum + underscore + dash) so test fixtures (e.g.
	// "conv_ci_test_001") and any future id-generation change are
	// accepted without churn here.
	convIDRe = regexp.MustCompile(`^conv_[A-Za-z0-9_-]+$`)
)

// SanitizeName produces a filesystem-safe, single-line variant of raw.
// Empty/whitespace-only input becomes "Untitled".
func SanitizeName(raw string) string {
	s := norm.NFC.String(raw)
	s = forbiddenCharRe.ReplaceAllString(s, "_")

	// Replace runs of "--" with "-_" so the suffix delimiter stays unambiguous.
	s = strings.ReplaceAll(s, convDirSeparator, "-_")

	// Collapse internal whitespace runs to single spaces.
	var b strings.Builder
	b.Grow(len(s))
	prevSpace := false
	for _, r := range s {
		if unicode.IsSpace(r) {
			if !prevSpace {
				b.WriteRune(' ')
				prevSpace = true
			}
			continue
		}
		b.WriteRune(r)
		prevSpace = false
	}
	s = b.String()

	s = strings.TrimSpace(s)
	s = strings.TrimRight(s, ". ")

	if s == "" || s == "." || s == ".." {
		return "Untitled"
	}

	if reservedWindowsNameRe.MatchString(s) {
		s += "_"
	}

	// Truncate to the rune cap first (display length), then to the byte cap
	// (filesystem safety) on a rune boundary. Trim trailing whitespace/dots
	// again in case the truncation landed on a problematic character.
	if rs := []rune(s); len(rs) > SanitizedNameMaxRunes || len(s) > sanitizedNameMaxBytes {
		if len(rs) > SanitizedNameMaxRunes {
			rs = rs[:SanitizedNameMaxRunes]
		}
		for len(rs) > 0 && len(string(rs)) > sanitizedNameMaxBytes {
			rs = rs[:len(rs)-1]
		}
		s = strings.TrimRight(string(rs), ". ")
		if s == "" {
			return "Untitled"
		}
	}

	return s
}

// IsValidConvID reports whether id is safe for use as a conversation id.
func IsValidConvID(id string) bool {
	return convIDRe.MatchString(id)
}

// BuildDirName joins a sanitized name with the conv id using the suffix
// delimiter. The caller is expected to pass a name that has already been
// run through SanitizeName, but BuildDirName re-sanitizes defensively so
// callers can't accidentally introduce path separators.
func BuildDirName(name, id string) string {
	return SanitizeName(name) + convDirSeparator + id
}

// ParseDirName splits "Foo--conv_abc123" into ("Foo", "conv_abc123", true).
// Returns ok=false for any folder name that doesn't end with a recognised
// conv id suffix.
func ParseDirName(dir string) (name string, id string, ok bool) {
	idx := strings.LastIndex(dir, convDirSeparator)
	if idx < 0 || idx == len(dir)-len(convDirSeparator) {
		return "", "", false
	}
	candidateID := dir[idx+len(convDirSeparator):]
	if !convIDRe.MatchString(candidateID) {
		return "", "", false
	}
	return norm.NFC.String(dir[:idx]), candidateID, true
}

// ConvDirIndex is a snapshot of the conversation folders found in
// .juggler/. Keys in both maps are the conv id.
type ConvDirIndex struct {
	ByID  map[string]string // id → absolute folder path
	Names map[string]string // id → human name (parsed from the folder name)
}

// NewConvDirIndex returns an empty index.
func NewConvDirIndex() *ConvDirIndex {
	return &ConvDirIndex{
		ByID:  map[string]string{},
		Names: map[string]string{},
	}
}

// ScanConvDirs reads jugglerDir and returns an index of every folder whose
// name matches `<name>--<conv_id>`. Anything else (session.json, plugins/,
// the lockfile, legacy conv_*.yjs siblings) is ignored. The returned index
// is always non-nil. An error is returned only if jugglerDir itself cannot
// be read.
func ScanConvDirs(jugglerDir string) (*ConvDirIndex, error) {
	idx := NewConvDirIndex()
	entries, err := os.ReadDir(jugglerDir)
	if err != nil {
		if os.IsNotExist(err) {
			return idx, nil
		}
		return nil, fmt.Errorf("read juggler dir: %w", err)
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name, id, ok := ParseDirName(e.Name())
		if !ok {
			continue
		}
		idx.ByID[id] = filepath.Join(jugglerDir, e.Name())
		idx.Names[id] = name
	}
	return idx, nil
}
