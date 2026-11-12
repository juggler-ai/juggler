//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/jlog"
	"juggler/internal/projectpaths"
)

// diskSessionState is the on-disk shape of the persistent fields of an
// activeSession. Saved as `<state folder>/<name>--<convID>/claude_session.json`
// (the project's state folder: projectpaths.For)
// after every successful turn so juggler restarts can resume the claude
// session via --resume <uuid> instead of cold-starting from full history.
type diskSessionState struct {
	SessionUUID      string   `json:"sessionUUID"`
	WorkingDir       string   `json:"workingDir,omitempty"` // the tree the session was made in
	HeldCount        *int     `json:"heldCount,omitempty"`
	SentCount        int      `json:"sentCount"`
	SentHash         uint64   `json:"sentHash"` // legacy aggregate; covers system prompt + first SentCount messages
	SentSystemHash   uint64   `json:"sentSystemHash,omitempty"`
	SentMsgHashes    []uint64 `json:"sentMsgHashes,omitempty"`
	Model            string   `json:"model,omitempty"`
	LastCacheRead    int      `json:"lastCacheRead,omitempty"`
	LastTurnUnixNano int64    `json:"lastTurnUnixNano,omitempty"`
}

// sessionDiskPath returns the path for the claude_session.json sidecar inside
// the conversation's own folder. Returns "" if the folder cannot be found.
//
// stateDir is the PROJECT, not wherever the CLI is running: the conversation
// folders are only ever there, so a conversation bound to a workspace would
// otherwise index a tree that has no folders in it and silently stop resuming.
func sessionDiskPath(stateDir, convID string) string {
	if stateDir == "" || convID == "" {
		return ""
	}
	idx, err := core.ScanConvDirs(projectpaths.StateDir(stateDir))
	if err != nil {
		return ""
	}
	folder, ok := idx.ByID[convID]
	if !ok {
		return ""
	}
	return filepath.Join(folder, "claude_session.json")
}

// legacySessionDiskPath returns the old flat sidecar path used before
// sessions were moved into per-conversation folders.
func legacySessionDiskPath(stateDir, convID string) string {
	if stateDir == "" || convID == "" {
		return ""
	}
	return filepath.Join(projectpaths.StateDir(stateDir), convID+".claudecode.json")
}

// loadDiskSession reads the sidecar, and answers nil for a session that belongs
// to a different tree.
//
// The sidecar is the project's and outlives any one workspace; the session it
// names is not. The CLI files its transcript under the directory it ran in and
// records that directory in every entry, so resuming the uuid somewhere else
// asks it to carry on a conversation about files that are not the ones in front
// of it. A conversation that has moved cold-starts from its own history, and one
// that moves back finds its session where it left it.
//
// A sidecar written before this field existed is read as the project's, which is
// the only tree there was.
func loadDiskSession(stateDir, convID, workingDir string) *activeSession {
	p := sessionDiskPath(stateDir, convID)
	legacy := legacySessionDiskPath(stateDir, convID)

	var data []byte
	var err error
	if p != "" {
		data, err = os.ReadFile(p)
	}
	if err != nil || len(data) == 0 {
		// Fall back to legacy location and migrate on success.
		if legacy == "" {
			return nil
		}
		data, err = os.ReadFile(legacy)
		if err != nil {
			return nil
		}
	}
	var d diskSessionState
	if err := json.Unmarshal(data, &d); err != nil {
		jlog.Debug("loadDiskSession: corrupt sidecar: %v", err)
		return nil
	}
	if d.SessionUUID == "" {
		return nil
	}
	made := d.WorkingDir
	if made == "" {
		made = stateDir
	}
	if !sameDir(made, workingDir) {
		jlog.Debug("loadDiskSession: session for %s was made in %s, not %s: cold starting", convID, made, workingDir)
		return nil
	}
	heldCount := d.SentCount
	if d.HeldCount != nil {
		heldCount = *d.HeldCount
	}
	jlog.Debug("loadDiskSession: restored uuid=%s heldCount=%d sentCount=%d for %s", d.SessionUUID, heldCount, d.SentCount, convID)
	s := &activeSession{
		sessionUUID:    d.SessionUUID,
		heldCount:      heldCount,
		sentCount:      d.SentCount,
		sentHash:       d.SentHash,
		sentSystemHash: d.SentSystemHash,
		sentMsgHashes:  d.SentMsgHashes,
		model:          d.Model,
		lastCacheRead:  d.LastCacheRead,
	}
	if d.LastTurnUnixNano > 0 {
		s.lastTurnAt = time.Unix(0, d.LastTurnUnixNano)
	}
	// Migrate: remove legacy file now that we have a valid session to re-save.
	if legacy != "" {
		_ = os.Remove(legacy)
	}
	return s
}

func saveDiskSession(stateDir, convID, workingDir string, sess *activeSession) {
	p := sessionDiskPath(stateDir, convID)
	if p == "" || sess == nil || sess.sessionUUID == "" {
		return
	}
	heldCount := sess.heldCount
	d := diskSessionState{
		SessionUUID:    sess.sessionUUID,
		WorkingDir:     workingDir,
		HeldCount:      &heldCount,
		SentCount:      sess.sentCount,
		SentHash:       sess.sentHash,
		SentSystemHash: sess.sentSystemHash,
		SentMsgHashes:  sess.sentMsgHashes,
		Model:          sess.model,
		LastCacheRead:  sess.lastCacheRead,
	}
	if !sess.lastTurnAt.IsZero() {
		d.LastTurnUnixNano = sess.lastTurnAt.UnixNano()
	}
	data, err := json.Marshal(&d)
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		jlog.Debug("saveDiskSession: mkdir failed for %s: %v", p, err)
		return
	}
	if err := os.WriteFile(p, data, 0o644); err != nil {
		jlog.Debug("saveDiskSession: write failed for %s: %v", p, err)
	}
}

// sameDir answers whether two paths name the same directory, allowing for the
// spellings one machine has for itself: a symlinked /var that resolves to
// /private/var, a trailing separator, a Windows drive letter in either case.
// Two tree names that differ only in spelling are one tree, and a session made
// in it may be resumed there.
func sameDir(a, b string) bool {
	if a == b {
		return true
	}
	if a == "" || b == "" {
		return false
	}
	resolve := func(p string) string {
		if real, err := filepath.EvalSymlinks(p); err == nil {
			p = real
		}
		p = filepath.Clean(p)
		if runtime.GOOS == "windows" {
			return strings.ToLower(p)
		}
		return p
	}
	return resolve(a) == resolve(b)
}

func deleteDiskSession(stateDir, convID string) {
	if p := sessionDiskPath(stateDir, convID); p != "" {
		_ = os.Remove(p)
	}
	if p := legacySessionDiskPath(stateDir, convID); p != "" {
		_ = os.Remove(p)
	}
}
