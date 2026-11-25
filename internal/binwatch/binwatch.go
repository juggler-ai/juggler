//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package binwatch notices when the executable at a path is no longer the
// build it was when watching began: a rebuild, an installer or an in-app update
// has put another one there. Whoever put it there need not say so; the file is
// the signal.
//
// A build is told apart by its Go build ID, a hash the linker writes near the
// start of every Go binary that changes exactly when the binary's content does.
// Neither the version nor the file's times will do: a build from source keeps
// its version (and, outside an official build, its stamped date) across
// rebuilds of changed code, and a rebuild with nothing changed is a new file
// with a new mtime holding the same build.
package binwatch

import (
	"bytes"
	"debug/buildinfo"
	"debug/elf"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// buildIDPrefix opens the build ID string the Go linker places at the start
// of the text segment of a Windows PE or a Mach-O binary, followed by the ID
// and a closing quote. An ELF binary carries no such string: its ID is the
// .note.go.buildid note (elfNoteSection).
const buildIDPrefix = "\xff Go build ID: \""

// buildIDSearch is how far into a PE or Mach-O binary Read looks for the build
// ID. It sits at the start of the text segment, a few KB in (1.5 KB into a
// Windows PE, 4 KB into a Mach-O).
const buildIDSearch = 1 << 20

// elfNoteSection is the ELF section the Go linker writes the build ID to, as
// one note named elfNoteName of type elfNoteType whose content is the ID.
const (
	elfNoteSection = ".note.go.buildid"
	elfNoteName    = "Go\x00\x00"
	elfNoteType    = 4
)

// Build is one Go binary, as Read finds it.
type Build struct {
	// ID is the Go build ID: equal for two binaries exactly when they are
	// the same build.
	ID string
	// Version is the version stamped into the binary (core.stampedVersion,
	// set through -ldflags), or "" for a binary built without one.
	Version string
	// Revision and Modified are the VCS revision the binary was built from,
	// and whether that tree had uncommitted changes, when the build recorded
	// them.
	Revision string
	Modified bool
}

// Read reads the build of the Go binary at path. It fails for a file that is
// not a complete Go binary: one with no build ID, or whose build information
// cannot be parsed, as for a binary still being written.
func Read(path string) (Build, error) {
	f, err := open(path)
	if err != nil {
		return Build{}, err
	}
	defer f.Close()
	id, err := readID(f)
	if err != nil {
		return Build{}, fmt.Errorf("%s: %w", path, err)
	}
	info, err := buildinfo.Read(f)
	if err != nil {
		return Build{}, fmt.Errorf("%s: %w", path, err)
	}
	b := Build{ID: id}
	for _, s := range info.Settings {
		switch s.Key {
		case "-ldflags":
			b.Version = stampedVersion(s.Value)
		case "vcs.revision":
			b.Revision = s.Value
		case "vcs.modified":
			b.Modified = s.Value == "true"
		}
	}
	return b, nil
}

// ReadID reads the Go build ID of the binary at path, and nothing else of it:
// what tells two builds apart, without Read's parse of the build information.
func ReadID(path string) (string, error) {
	f, err := open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	id, err := readID(f)
	if err != nil {
		return "", fmt.Errorf("%s: %w", path, err)
	}
	return id, nil
}

// readID is ReadID of a binary already open.
func readID(r io.ReaderAt) (string, error) {
	start, end, err := IDSpan(r)
	if err != nil {
		return "", err
	}
	id := make([]byte, end-start)
	if _, err := r.ReadAt(id, start); err != nil {
		return "", err
	}
	return string(id), nil
}

// IDSpan finds the Go build ID in the binary r: the bytes [start, end) it
// occupies. An ELF binary carries it as a note (elfNoteSection); a PE or
// Mach-O one as a quoted string near the start of its text (buildIDPrefix).
func IDSpan(r io.ReaderAt) (start, end int64, err error) {
	var magic [4]byte
	if _, err := r.ReadAt(magic[:], 0); err != nil {
		return 0, 0, err
	}
	if string(magic[:]) == elf.ELFMAG {
		return elfIDSpan(r)
	}
	buf := make([]byte, buildIDSearch)
	n, err := r.ReadAt(buf, 0)
	if err != nil && !errors.Is(err, io.EOF) {
		return 0, 0, err
	}
	buf = buf[:n]
	i := bytes.Index(buf, []byte(buildIDPrefix))
	if i < 0 {
		return 0, 0, errors.New("no Go build ID")
	}
	from := i + len(buildIDPrefix)
	n = bytes.IndexByte(buf[from:], '"')
	if n <= 0 {
		return 0, 0, errors.New("unterminated Go build ID")
	}
	return int64(from), int64(from + n), nil
}

// elfIDSpan is IDSpan for an ELF binary: the content of its build ID note. A
// binary cut short reads as having none, since ELF keeps its section table at
// the end.
func elfIDSpan(r io.ReaderAt) (start, end int64, err error) {
	f, err := elf.NewFile(r)
	if err != nil {
		return 0, 0, err
	}
	sec := f.Section(elfNoteSection)
	if sec == nil || sec.Type != elf.SHT_NOTE {
		return 0, 0, errors.New("no Go build ID note")
	}
	data, err := sec.Data()
	if err != nil {
		return 0, 0, err
	}
	order := f.ByteOrder
	for off := 0; off+12 <= len(data); {
		nameSize := int(order.Uint32(data[off:]))
		descSize := int(order.Uint32(data[off+4:]))
		typ := order.Uint32(data[off+8:])
		name := off + 12
		desc := name + (nameSize+3)&^3
		next := desc + (descSize+3)&^3
		if desc+descSize > len(data) {
			break
		}
		if typ == elfNoteType && string(data[name:name+nameSize]) == elfNoteName && descSize > 0 {
			return int64(sec.Offset) + int64(desc), int64(sec.Offset) + int64(desc+descSize), nil
		}
		off = next
	}
	return 0, 0, errors.New("no Go build ID note")
}

// stampedVersion is the value -ldflags gives core.stampedVersion, or "".
func stampedVersion(ldflags string) string {
	const key = "/core.stampedVersion="
	for _, f := range strings.Fields(ldflags) {
		if _, v, ok := strings.Cut(f, key); ok {
			return v
		}
	}
	return ""
}

// Watcher watches the binary at one path for a build other than the one it
// held when the Watcher was made. It does no waiting of its own: its owner
// calls Poll as often as it likes (on a ticker, when a window is focused), and
// a file counts as settled once two polls in a row find it unchanged, so how
// long a build or an install takes never decides what is reported.
type Watcher struct {
	path string
	base string // the build ID of the binary being watched

	seen   os.FileInfo // the file at path as the last Poll found it, or nil
	judged bool        // whether found reflects seen
	found  *Build      // seen's build, when it is another build and complete
}

// New watches path, whose current binary is the build that counts as
// unchanged.
func New(path string) (*Watcher, error) {
	id, err := ReadID(path)
	if err != nil {
		return nil, err
	}
	return NewFrom(path, id), nil
}

// NewFrom watches path for a build other than the one whose ID is base, read
// already (ReadID) by a caller that holds on to it for something else too.
func NewFrom(path, base string) *Watcher {
	return &Watcher{path: path, base: base}
}

// Poll looks at the file at the path and returns the build there if it is
// another build than the watched one, complete, and unchanged since the
// previous Poll; otherwise nil. It keeps returning that build for as long as
// the file stays as it is, so a caller that missed one report gets the next.
func (w *Watcher) Poll() *Build {
	st, err := os.Stat(w.path)
	if err != nil {
		// Gone, perhaps for the moment of a swap: judge whatever comes next
		// afresh.
		w.seen, w.judged, w.found = nil, false, nil
		return nil
	}
	if w.seen == nil || !sameState(w.seen, st) {
		w.seen, w.judged, w.found = st, false, nil
		return nil
	}
	if !w.judged {
		// A read that fails on a settled file (one held open by a scan, say)
		// is tried again at the next Poll, not taken as the file's verdict.
		if b, err := Read(w.path); err == nil {
			w.judged = true
			if b.ID != w.base {
				w.found = &b
			}
		}
	}
	return w.found
}

// sameState is whether a and b are the same file with the same size and
// modification time: nothing has been put at the path or written to it
// between the two looks.
func sameState(a, b os.FileInfo) bool {
	return os.SameFile(a, b) && a.Size() == b.Size() && a.ModTime().Equal(b.ModTime())
}
