//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"maps"
	"os"
	"path/filepath"

	"juggler/internal/atomicio"
	"juggler/internal/jlog"
)

// The held-send index: which of a project's conversations have something
// waiting in a pending queue, so a server that starts can load them and their
// sends fire with nobody opening them (Manager.LoadHeldConversations).
//
// It lives at <project>/.juggler/held-sends.json, beside the conversations
// themselves, as a JSON object of conversation id → heldIndexEntry. A worker
// publishes its own entry whenever it recomputes its held-send timer
// (rearmHeldTimer) and the entry differs from the one it last published, and
// withdraws it once its queues hold nothing. The index is a hint, never the
// truth: the conversation's own document says what is queued, and a load that
// finds nothing there does nothing.

// heldIndexFile is the index's name under the project's .juggler directory.
const heldIndexFile = "held-sends.json"

// heldIndexPath is where a project's held-send index lives.
func heldIndexPath(projectPath string) string {
	return filepath.Join(projectPath, ".juggler", heldIndexFile)
}

// heldIndexEntry is what one conversation's queues are waiting for.
type heldIndexEntry struct {
	// NotBefore is the earliest time (epoch ms) any queued send waits for,
	// passed or not; zero when none waits for a time.
	NotBefore int64 `json:"notBefore,omitempty"`
	// Due is set when a queue holds a send with no time: one queued untimed,
	// or held for the end of a run.
	Due bool `json:"due,omitempty"`
}

// heldSendIndex is the Manager's copy of every project's index it has touched,
// each written through to its file. Safe for concurrent use — workers publish
// from their own run loops — because its state sits in a one-slot channel and
// is owned by whoever has taken it out (with).
type heldSendIndex struct {
	state chan *heldIndexState
}

type heldIndexState struct {
	files map[string]map[string]heldIndexEntry // index path → conversation id → entry
	// removed holds the conversations Remove tore down. A worker being removed
	// may still be finishing a run-loop iteration, and must not write its entry
	// back after Remove withdrew it.
	removed map[string]bool
}

func newHeldSendIndex() *heldSendIndex {
	x := &heldSendIndex{state: make(chan *heldIndexState, 1)}
	x.state <- &heldIndexState{files: map[string]map[string]heldIndexEntry{}, removed: map[string]bool{}}
	return x
}

// with runs fn as the state's only owner.
func (x *heldSendIndex) with(fn func(s *heldIndexState)) {
	s := <-x.state
	defer func() { x.state <- s }()
	fn(s)
}

// file returns the index for path, read from disk the first time.
func (x *heldIndexState) file(path string) map[string]heldIndexEntry {
	if f, ok := x.files[path]; ok {
		return f
	}
	f := map[string]heldIndexEntry{}
	data, err := atomicio.RobustReadFile(path)
	switch {
	case err == nil:
		if err := json.Unmarshal(data, &f); err != nil {
			jlog.Error("[held-index] %s is unreadable, starting it afresh: %v", path, err)
			f = map[string]heldIndexEntry{}
		}
	case !os.IsNotExist(err):
		jlog.Error("[held-index] reading %s: %v", path, err)
	}
	x.files[path] = f
	return f
}

// write writes the index for path atomically, so a reader never sees half a
// file, and outlasting a reader that briefly holds it open. An empty index is
// deleted.
func (x *heldIndexState) write(path string) {
	f := x.files[path]
	if len(f) == 0 {
		if err := atomicio.RobustRemoveAll(path); err != nil {
			jlog.Error("[held-index] removing %s: %v", path, err)
		}
		return
	}
	data, err := json.Marshal(f)
	if err != nil {
		jlog.Error("[held-index] encoding %s: %v", path, err)
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		jlog.Error("[held-index] creating %s: %v", filepath.Dir(path), err)
		return
	}
	if err := atomicio.WriteFile(path, data, 0o644); err != nil {
		jlog.Error("[held-index] writing %s: %v", path, err)
	}
}

// publish records the conversation's entry in its project's index, or removes
// it when present is false. A conversation Remove tore down is not recorded.
func (x *heldSendIndex) publish(projectPath, convID string, e heldIndexEntry, present bool) {
	x.with(func(s *heldIndexState) {
		if present && s.removed[convID] {
			return
		}
		path := heldIndexPath(projectPath)
		f := s.file(path)
		if old, ok := f[convID]; ok == present && old == e {
			return
		}
		if present {
			f[convID] = e
		} else {
			delete(f, convID)
		}
		s.write(path)
	})
}

// entries returns a copy of a project's index.
func (x *heldSendIndex) entries(projectPath string) map[string]heldIndexEntry {
	var out map[string]heldIndexEntry
	x.with(func(s *heldIndexState) { out = maps.Clone(s.file(heldIndexPath(projectPath))) })
	return out
}

// discard removes a conversation from a project's index.
func (x *heldSendIndex) discard(projectPath, convID string) {
	x.with(func(s *heldIndexState) {
		path := heldIndexPath(projectPath)
		f := s.file(path)
		if _, ok := f[convID]; ok {
			delete(f, convID)
			s.write(path)
		}
	})
}

// drop withdraws a removed conversation from every index and refuses its entry
// from now on, until restore.
func (x *heldSendIndex) drop(convID string) {
	x.with(func(s *heldIndexState) {
		s.removed[convID] = true
		for path, f := range s.files {
			if _, ok := f[convID]; ok {
				delete(f, convID)
				s.write(path)
			}
		}
	})
}

// restore lets a conversation brought back from the bin publish again.
func (x *heldSendIndex) restore(convID string) {
	x.with(func(s *heldIndexState) { delete(s.removed, convID) })
}

// heldPublication is one entry a worker published, or its absence.
type heldPublication struct {
	entry   heldIndexEntry
	present bool
	// valid is false until the worker first publishes, so its first
	// computation is written even when it finds nothing: an index from an
	// earlier server may still list the conversation.
	valid bool
}
