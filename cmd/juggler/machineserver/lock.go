//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/gofrs/flock"

	"juggler/internal/atomicio"
	"juggler/internal/jlog"
)

// ServerInfo is the machine server's identity, written next to the machine
// lock so clients can discover the running server: read the info, probe
// /api/server/status, attach. It is the machine-scope analogue of the
// per-project core.InstanceInfo.
type ServerInfo struct {
	PID       int       `json:"pid"`
	Addr      string    `json:"addr"`
	Version   string    `json:"version"`
	StartedAt time.Time `json:"startedAt"`
	// Token is the control-API token (the Server's tokenGuard). This file is
	// how a client on this machine, running as this user, comes to hold it.
	Token string `json:"token"`
	// Implicit marks a server a client started on demand (serve --implicit),
	// rather than one run by hand.
	Implicit bool `json:"implicit,omitempty"`
}

// MachineLock enforces one machine server per machine via a flock under the
// user config dir (~/.juggler/server.lock), with ServerInfo JSON alongside it
// (server.json) as the discovery channel.
type MachineLock struct {
	lockPath string
	infoPath string
	flock    *flock.Flock
	info     ServerInfo
}

// NewMachineLock returns the lock manager rooted at configDir (normally
// userpaths.ConfigDir(); tests pass a temp dir).
func NewMachineLock(configDir string) *MachineLock {
	return &MachineLock{
		lockPath: filepath.Join(configDir, "server.lock"),
		infoPath: filepath.Join(configDir, "server.json"),
	}
}

// TryAcquire attempts to become the machine server. On success it writes want
// as our ServerInfo, with this process's PID and start time and an empty Addr
// until UpdateAddr, and returns acquired=true.
// When the lock is held elsewhere it returns the holder's info, when readable,
// so the caller can report where the running server lives.
func (l *MachineLock) TryAcquire(want ServerInfo) (acquired bool, existing *ServerInfo, err error) {
	if err := os.MkdirAll(filepath.Dir(l.lockPath), 0700); err != nil {
		return false, nil, fmt.Errorf("failed to create config directory: %w", err)
	}
	l.flock = flock.New(l.lockPath)
	locked, err := l.flock.TryLock()
	if err != nil {
		return false, nil, fmt.Errorf("failed to acquire machine lock: %w", err)
	}
	if !locked {
		return false, l.readInfo(), nil
	}
	l.info = want
	l.info.PID = os.Getpid()
	l.info.Addr = ""
	l.info.StartedAt = time.Now()
	if err := l.writeInfo(); err != nil {
		if unlockErr := l.flock.Unlock(); unlockErr != nil {
			jlog.Error("[machineserver] failed to release lock after write failure: %v", unlockErr)
		}
		return false, nil, fmt.Errorf("failed to write server info: %w", err)
	}
	return true, nil, nil
}

// UpdateAddr records the address the server actually bound to. TryAcquire runs
// before the listener exists, so the info starts with an empty Addr; this makes
// server.json authoritative for discovery. No-op if we don't hold the lock.
func (l *MachineLock) UpdateAddr(addr string) error {
	if l == nil || l.flock == nil || !l.flock.Locked() {
		return nil
	}
	l.info.Addr = addr
	return l.writeInfo()
}

// Release removes the server info and releases the lock. Info removal is
// non-fatal — the flock release is what actually frees the machine slot.
func (l *MachineLock) Release() error {
	if l == nil || l.flock == nil {
		return nil
	}
	if err := os.Remove(l.infoPath); err != nil && !os.IsNotExist(err) {
		jlog.Error("[machineserver] failed to remove server info file: %v", err)
	}
	return l.flock.Unlock()
}

// writeInfo replaces server.json with a file only its owner can read, since it
// carries the control-API token. It writes a fresh file (os.CreateTemp makes it
// 0600) and renames it over the old one, so a server.json left behind with
// wider permissions never has the token written into it, and a reader never
// sees half a file.
func (l *MachineLock) writeInfo() error {
	data, err := json.MarshalIndent(l.info, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(l.infoPath), ".server-*.json")
	if err != nil {
		return err
	}
	_, werr := tmp.Write(data)
	cerr := tmp.Close()
	if werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = atomicio.RobustRename(tmp.Name(), l.infoPath)
	}
	if werr != nil {
		_ = os.Remove(tmp.Name())
	}
	return werr
}

// lockState is what probing the machine lock found.
type lockState int

const (
	lockFree lockState = iota
	lockHeld
	// lockUnknown is a lock that could not be probed.
	lockUnknown
)

// probe reports whether a machine server holds the lock, by trying to take it
// and, on success, letting it go at once. A server starting in that instant
// loses the lock to the probe and exits as if another held it — which is why
// Connect starts a server again when the one it started has gone.
func (l *MachineLock) probe() lockState {
	if _, err := os.Stat(l.lockPath); err != nil {
		return lockFree
	}
	p := flock.New(l.lockPath)
	locked, err := p.TryLock()
	if err != nil {
		return lockUnknown
	}
	if locked {
		if err := p.Unlock(); err != nil {
			jlog.Error("[machineserver] failed to release the lock probe: %v", err)
		}
		return lockFree
	}
	return lockHeld
}

// readInfo returns the on-disk ServerInfo, or nil when it is missing or
// unparsable — callers treat nil as "holder unknown".
func (l *MachineLock) readInfo() *ServerInfo {
	data, err := atomicio.RobustReadFile(l.infoPath)
	if err != nil {
		return nil
	}
	var info ServerInfo
	if err := json.Unmarshal(data, &info); err != nil {
		return nil
	}
	return &info
}
