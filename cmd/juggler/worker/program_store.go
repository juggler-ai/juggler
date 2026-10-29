//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/atomicio"
)

// MaxProgramSnapshotBytes caps one program snapshot. A snapshot holds every
// answer the program has had — file contents, tool output — so it can be
// large; past this it is not kept, and a program lost while it waits fails
// on a restart as it would with no snapshot at all. Save enforces it, so the
// store stands alone; the HTTP handler also bounds its body read with it.
const MaxProgramSnapshotBytes = 32 << 20 // 32 MiB

// programTmpGrace is how old a snapshot's temp file must be before Sweep takes
// it for one left by a crash or a failed write. A Save in progress writes its
// temp file in far less, so a sweep never removes one being written.
const programTmpGrace = time.Minute

// ErrBadProgramKey is returned for a tool-use id that cannot be a file name.
var ErrBadProgramKey = errors.New("program store: invalid tool-use id")

// ErrProgramTooLarge is returned for a snapshot past MaxProgramSnapshotBytes.
var ErrProgramTooLarge = errors.New("program store: snapshot too large")

// ErrUnknownConversation is returned for a conversation the path provider does
// not know: deleted or binned.
var ErrUnknownConversation = errors.New("program store: unknown conversation")

// programKeyRe is the path guard: a tool-use id is used as a file name only if
// it is one plain name. With the "." and ".." check in path, it refuses an
// empty id, one over 200 bytes, any separator or NUL, and the two dot-names
// that name a directory.
var programKeyRe = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,200}$`)

// programExt is the snapshot file extension.
const programExt = ".json"

// ProgramStore keeps the snapshot a program tool (run_code) takes each time
// one of its calls waits on the user, under <convDir>/programs/<toolUseId>.json.
//
// The program waits alive, and while its engine lives the snapshot is never
// read. It is for an engine that dies meanwhile: the item stays pending in the
// document, and once the user answers, the program is run again from the top,
// answered from the snapshot up to the held call. The bytes are opaque here —
// the engine writes and reads them — and kept out of the document, which every
// viewer syncs and every save rewrites.
//
// A snapshot outlives nothing it could resume: sweepPrograms drops it once its
// tool-action has settled or is gone.
type ProgramStore struct {
	pathProvider PathProviderFunc

	// remove removes one file from the programs directory, and nothing if it
	// is not there. On Windows a reader's handle (Get, a scanner) refuses the
	// delete for as long as it is open, so the removal outlasts one. A field
	// so a test can fail one removal of its own store.
	remove func(path string) error
}

// NewProgramStore returns a store backed by the given path provider. The
// <convDir>/programs/ directory is created lazily on Save.
func NewProgramStore(pathProvider PathProviderFunc) *ProgramStore {
	return &ProgramStore{pathProvider: pathProvider, remove: atomicio.RobustRemoveAll}
}

// dir returns the conversation's programs directory, or "" if the
// conversation is unknown to the path provider.
func (s *ProgramStore) dir(convID string) string {
	if s == nil || s.pathProvider == nil {
		return ""
	}
	convDir, ok := s.pathProvider(convID)
	if !ok {
		return ""
	}
	return core.ConvProgramsDir(convDir)
}

// path resolves a snapshot's file, refusing an id that is not a plain name.
func (s *ProgramStore) path(convID, toolUseID string) (string, error) {
	if !programKeyRe.MatchString(toolUseID) || toolUseID == "." || toolUseID == ".." {
		return "", ErrBadProgramKey
	}
	dir := s.dir(convID)
	if dir == "" {
		return "", fmt.Errorf("%w %q", ErrUnknownConversation, convID)
	}
	return filepath.Join(dir, toolUseID+programExt), nil
}

// Save writes a snapshot, replacing any earlier one for the same tool-use id.
// The write is atomic: a reader sees the old snapshot or the new, never part.
func (s *ProgramStore) Save(convID, toolUseID string, data []byte) error {
	p, err := s.path(convID, toolUseID)
	if err != nil {
		return err
	}
	if len(data) > MaxProgramSnapshotBytes {
		return ErrProgramTooLarge
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return fmt.Errorf("create programs dir: %w", err)
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return fmt.Errorf("write program snapshot: %w", err)
	}
	if err := atomicio.RobustRename(tmp, p); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("rename program snapshot: %w", err)
	}
	return nil
}

// Get reads a snapshot. Returns os.ErrNotExist if there is none.
func (s *ProgramStore) Get(convID, toolUseID string) ([]byte, error) {
	p, err := s.path(convID, toolUseID)
	if err != nil {
		return nil, err
	}
	return atomicio.RobustReadFile(p)
}

// Delete removes a snapshot. One that is not there is not an error.
func (s *ProgramStore) Delete(convID, toolUseID string) error {
	p, err := s.path(convID, toolUseID)
	if err != nil {
		return err
	}
	return s.remove(p)
}

// List returns the tool-use ids with a snapshot. Temp files left by an
// interrupted write are ignored.
func (s *ProgramStore) List(convID string) ([]string, error) {
	dir := s.dir(convID)
	if dir == "" {
		return nil, nil
	}
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var ids []string
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, programExt) {
			continue
		}
		ids = append(ids, strings.TrimSuffix(name, programExt))
	}
	return ids, nil
}

// Sweep deletes every snapshot whose tool-use id is not in live, and every
// temp file older than programTmpGrace — one left by a crash or a failed
// write, which List never reports and so no snapshot sweep would reach. A
// removal that fails costs only its own file: the rest are still removed, and
// the failures are returned together.
func (s *ProgramStore) Sweep(convID string, live map[string]bool) error {
	ids, err := s.List(convID)
	if err != nil {
		return err
	}
	var failed []error
	for _, id := range ids {
		if live[id] {
			continue
		}
		if err := s.Delete(convID, id); err != nil {
			failed = append(failed, err)
		}
	}
	return errors.Join(append(failed, s.sweepTemps(convID))...)
}

// sweepTemps removes the programs directory's stale temp files.
func (s *ProgramStore) sweepTemps(convID string) error {
	dir := s.dir(convID)
	if dir == "" {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	cutoff := time.Now().Add(-programTmpGrace)
	var failed []error
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".tmp") {
			continue
		}
		info, err := e.Info()
		if err != nil || info.ModTime().After(cutoff) {
			continue
		}
		if err := s.remove(filepath.Join(dir, e.Name())); err != nil {
			failed = append(failed, err)
		}
	}
	return errors.Join(failed...)
}
