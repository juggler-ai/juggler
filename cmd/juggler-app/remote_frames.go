//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"juggler/cmd/juggler/core"
	"juggler/internal/atomicio"
	"juggler/internal/userpaths"
)

// A window's frame belongs to the machine whose screen it is on. For a window
// onto a server this app runs, that machine is the server's too, so the frame
// lives in the project's session (window_state_client.go). A window onto a
// server by URL is a different matter: the session it views is on another
// machine, and that machine's own windows onto the same project keep their
// frames in the same slot. Storing ours there would have each machine opening
// at the other's last frame — sized and placed for displays it does not have.
//
// So the frames of windows onto a server by URL stay here, on the machine that
// shows them, in ~/.juggler/remote-frames.json, keyed by server URL and window
// role. The server is never asked for them and never given them.
//
// The store is owned by a single goroutine (no mutex, per the concurrency
// rule). Every operation waits for its answer, and a put for its write: they
// are few — one per settled drag, one per window at close and at quit — and a
// put that returned before its write would be lost to a quit that followed it.

// remoteFramesFile is the JSON document: one frame per server URL and role.
type remoteFramesFile struct {
	Frames map[string]core.WindowState `json:"frames,omitempty"`
}

// remoteFrames persists the frames of windows onto servers by URL. A nil store
// remembers nothing, which is what a test app state without one wants.
type remoteFrames struct {
	ops  chan func(frames map[string]core.WindowState) (changed bool)
	path string
}

func newRemoteFrames() *remoteFrames {
	return newRemoteFramesAt(filepath.Join(userpaths.ConfigDir(), "remote-frames.json"))
}

// newRemoteFramesAt is newRemoteFrames keeping its document at path.
func newRemoteFramesAt(path string) *remoteFrames {
	r := &remoteFrames{ops: make(chan func(map[string]core.WindowState) bool), path: path}
	go func() {
		// Read on the first operation rather than here: the store is built before
		// the single-instance lock is taken, and a second launch that exits at
		// that lock has no business touching the file.
		var frames map[string]core.WindowState
		for op := range r.ops {
			if frames == nil {
				frames = readRemoteFrames(r.path)
			}
			if op(frames) {
				writeRemoteFrames(r.path, frames)
			}
		}
	}()
	return r
}

// remoteFrameKey files a frame under the server it views and the window's role.
func remoteFrameKey(serverURL, role string) string {
	return strings.TrimRight(serverURL, "/") + " " + role
}

// do runs op on the store's goroutine and waits for it, including any write it
// asked for.
func (r *remoteFrames) do(op func(map[string]core.WindowState) bool) {
	done := make(chan struct{})
	r.ops <- func(frames map[string]core.WindowState) bool {
		defer close(done)
		return op(frames)
	}
	<-done
}

// get returns the frame saved for one role of a window onto serverURL.
func (r *remoteFrames) get(serverURL, role string) (ws core.WindowState, ok bool) {
	if r == nil {
		return core.WindowState{}, false
	}
	r.do(func(frames map[string]core.WindowState) bool {
		ws, ok = frames[remoteFrameKey(serverURL, role)]
		return false
	})
	return ws, ok
}

// put records the frame of one role of a window onto serverURL. Only the frame:
// a window's UI preferences stay in the session it views, which owns them.
func (r *remoteFrames) put(serverURL, role string, ws core.WindowState) {
	if r == nil {
		return
	}
	ws.UI = nil
	r.do(func(frames map[string]core.WindowState) bool {
		key := remoteFrameKey(serverURL, role)
		if prev, ok := frames[key]; ok && prev.SameFrame(ws) {
			return false
		}
		frames[key] = ws
		return true
	})
}

// forget drops the frame of one role of a window onto serverURL.
func (r *remoteFrames) forget(serverURL, role string) {
	if r == nil {
		return
	}
	r.do(func(frames map[string]core.WindowState) bool {
		key := remoteFrameKey(serverURL, role)
		if _, ok := frames[key]; !ok {
			return false
		}
		delete(frames, key)
		return true
	})
}

// readRemoteFrames loads the document, or an empty set when it is missing or
// unreadable — every window then opens at its default placement, which is all a
// lost frame costs.
func readRemoteFrames(path string) map[string]core.WindowState {
	frames := map[string]core.WindowState{}
	data, err := atomicio.RobustReadFile(path)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			logf("remote frames: read failed: %v", err)
		}
		return frames
	}
	var f remoteFramesFile
	if err := json.Unmarshal(data, &f); err != nil {
		logf("remote frames: %s is corrupt (%v); starting with none", path, err)
		return frames
	}
	for k, ws := range f.Frames {
		frames[k] = ws
	}
	return frames
}

// writeRemoteFrames replaces the document whole, so a write cut short leaves
// the previous one rather than a torn file.
func writeRemoteFrames(path string, frames map[string]core.WindowState) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		logf("remote frames: mkdir failed: %v", err)
		return
	}
	data, err := json.MarshalIndent(remoteFramesFile{Frames: frames}, "", "  ")
	if err != nil {
		logf("remote frames: encode failed: %v", err)
		return
	}
	if err := atomicio.WriteFile(path, data, 0o644); err != nil {
		logf("remote frames: write failed: %v", err)
	}
}
