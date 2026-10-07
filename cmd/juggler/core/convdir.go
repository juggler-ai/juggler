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
	return generatePrefixedID("conv_")
}

// generatePrefixedID returns prefix followed by 9 random base36 characters —
// the id shape the frontend generates, used for every kind of id the server
// allocates itself.
func generatePrefixedID(prefix string) string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	const idLen = 9
	max := big.NewInt(int64(len(alphabet)))
	var b strings.Builder
	b.Grow(len(prefix) + idLen)
	b.WriteString(prefix)
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
//     txns/
//       <txnID>.json
//     assets/
//       <sha256>.<ext>
//
// The folder name is the source of truth for the human-readable name; the
// id is the stable internal handle (conv_<base36>) used everywhere in code,
// Yjs metadata and tests. The "--" separator is reserved by SanitizeName so
// the trailing "--<id>" is unambiguously the suffix.
//
// Every name in that tree is spelled in this file and nowhere else: the
// folder name by BuildDirName/ParseDirName, its contents by the three
// accessors below. A package that stores something for a conversation is
// handed the folder path and asks here what lives inside it, so how a
// conversation is laid out on disk stays a question only this package
// answers.

// convDirSeparator separates the sanitized name from the id in folder names.
const convDirSeparator = "--"

const (
	// docFileName holds the Yjs document: items AND metadata.
	docFileName = "doc.yjs"
	// txnsDirName holds one write-once JSON blob per LLM round-trip.
	txnsDirName = "txns"
	// assetsDirName holds content-addressed attachment blobs.
	assetsDirName = "assets"
)

// ConvDocPath returns the Yjs document path inside a conversation folder.
func ConvDocPath(convDir string) string {
	return filepath.Join(convDir, docFileName)
}

// ConvTxnsDir returns the transaction-blob directory inside a conversation
// folder. Created lazily by whoever writes the first blob.
func ConvTxnsDir(convDir string) string {
	return filepath.Join(convDir, txnsDirName)
}

// ConvAssetsDir returns the attachment directory inside a conversation folder.
// Created lazily by whoever saves the first attachment.
func ConvAssetsDir(convDir string) string {
	return filepath.Join(convDir, assetsDirName)
}

// CloneConvFolder fills dstDir, an already-created conversation folder, with
// everything srcDir persists: the document, the transaction blobs its items
// reference by id, and the attachment bytes its items reference by sha. A
// clone that carried the doc without the blobs would open with broken
// transaction links and images that resolve to nothing.
//
// doc, when non-nil, is written as the clone's document in place of the
// source's on-disk one, for a caller holding a more current copy (a live
// worker's snapshot). When nil, the source's doc.yjs is copied, and a source
// that has never saved one yields an empty clone rather than an error.
func CloneConvFolder(srcDir, dstDir string, doc []byte) error {
	var err error
	if doc != nil {
		err = os.WriteFile(ConvDocPath(dstDir), doc, 0o644)
	} else {
		err = copyFileIfExists(ConvDocPath(srcDir), ConvDocPath(dstDir))
	}
	if err != nil {
		return fmt.Errorf("write clone %s: %w", docFileName, err)
	}
	if err := copyDirContents(ConvTxnsDir(srcDir), ConvTxnsDir(dstDir)); err != nil {
		return fmt.Errorf("copy %s: %w", txnsDirName, err)
	}
	if err := copyDirContents(ConvAssetsDir(srcDir), ConvAssetsDir(dstDir)); err != nil {
		return fmt.Errorf("copy %s: %w", assetsDirName, err)
	}
	return nil
}

// copyFileIfExists copies src→dst. A missing src is not an error (it means the
// source has nothing persisted yet); any other read/write failure is returned.
func copyFileIfExists(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	return os.WriteFile(dst, data, 0o644)
}

// copyDirContents copies every regular file in srcDir into dstDir (non-recursive
// — txns/ and assets/ are flat). A missing srcDir is not an error.
func copyDirContents(srcDir, dstDir string) error {
	entries, err := os.ReadDir(srcDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if err := copyFileIfExists(filepath.Join(srcDir, e.Name()), filepath.Join(dstDir, e.Name())); err != nil {
			return err
		}
	}
	return nil
}

// SanitizedNameMaxRunes caps the sanitized name length to leave headroom
// under the 255-byte filename limits on most filesystems even when
// characters expand to 4-byte UTF-8 sequences. The full folder name is
// "<name><sep><conv_<9-char id>>" so the cap also keeps Windows MAX_PATH
// happy for reasonable project paths.
const SanitizedNameMaxRunes = 50

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
		return UntitledBase
	}

	if reservedWindowsNameRe.MatchString(s) {
		s += "_"
	}

	// Truncate to rune cap. Trim trailing whitespace/dots again in case the
	// truncation landed on a problematic character.
	if rs := []rune(s); len(rs) > SanitizedNameMaxRunes {
		s = strings.TrimRight(string(rs[:SanitizedNameMaxRunes]), ". ")
		if s == "" {
			return UntitledBase
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
