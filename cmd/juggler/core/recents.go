//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"juggler/internal/userpaths"
)

// Project switching sentinel errors. Handlers map these to HTTP status codes.
var (
	// ErrProjectNotFound means the requested path does not exist.
	ErrProjectNotFound = errors.New("project path not found")
	// ErrProjectNotDir means the requested path exists but is not a directory.
	ErrProjectNotDir = errors.New("project path is not a directory")
	// ErrProjectLocked means another juggler instance is using that project.
	ErrProjectLocked = errors.New("this project is already open in another juggler instance")
)

// RecentsCap caps the number of remembered recent project paths.
const RecentsCap = 10

// RecentsStore manages a user-level list of recently-opened project paths,
// stored in ~/.juggler/cache/recents.json.
type RecentsStore struct {
	filePath string
}

// recentsFile is the on-disk schema.
type recentsFile struct {
	Paths []string `json:"paths"`
}

// NewRecentsStore returns a store backed by ~/.juggler/cache/recents.json. The
// MRU list is regenerable convenience state, so it lives under the cache dir.
func NewRecentsStore() (*RecentsStore, error) {
	return &RecentsStore{
		filePath: filepath.Join(userpaths.CacheDir(), "recents.json"),
	}, nil
}

// Load returns the current recents list (most-recent first). Missing file
// yields an empty slice without error.
func (s *RecentsStore) Load() ([]string, error) {
	data, err := os.ReadFile(s.filePath)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to read recents file: %w", err)
	}
	if len(data) == 0 {
		return nil, nil
	}
	var f recentsFile
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("failed to parse recents file: %w", err)
	}
	return f.Paths, nil
}

// Add moves path to the front of the list, dedups, and caps at RecentsCap.
// path should already be absolute.
func (s *RecentsStore) Add(path string) error {
	if path == "" {
		return nil
	}
	paths, err := s.Load()
	if err != nil {
		return err
	}
	out := make([]string, 0, len(paths)+1)
	out = append(out, path)
	for _, p := range paths {
		if p == path {
			continue
		}
		out = append(out, p)
		if len(out) >= RecentsCap {
			break
		}
	}
	return s.save(out)
}

// Prune drops entries whose folder no longer exists (or is no longer a
// directory), persists the result when anything changed, and returns the
// surviving list in most-recent order. A path that fails to stat for any
// reason other than "not found" — e.g. an offline network mount or a
// permission error — is kept, so a temporarily-unreachable project isn't
// forgotten; only definitively-absent folders are dropped.
func (s *RecentsStore) Prune() ([]string, error) {
	paths, err := s.Load()
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(paths))
	changed := false
	for _, p := range paths {
		info, statErr := os.Stat(p)
		if statErr != nil {
			if os.IsNotExist(statErr) {
				changed = true // folder is gone — drop it
				continue
			}
			out = append(out, p) // transient error — keep it
			continue
		}
		if !info.IsDir() {
			changed = true // exists but is a file now — can't be a project
			continue
		}
		out = append(out, p)
	}
	if changed {
		if err := s.save(out); err != nil {
			return out, err
		}
	}
	return out, nil
}

// Remove drops path from the list if present.
func (s *RecentsStore) Remove(path string) error {
	paths, err := s.Load()
	if err != nil {
		return err
	}
	out := paths[:0]
	for _, p := range paths {
		if p != path {
			out = append(out, p)
		}
	}
	return s.save(out)
}

func (s *RecentsStore) save(paths []string) error {
	dir := filepath.Dir(s.filePath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("failed to create recents directory: %w", err)
	}
	data, err := json.MarshalIndent(recentsFile{Paths: paths}, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal recents: %w", err)
	}
	if err := os.WriteFile(s.filePath, data, 0600); err != nil {
		return fmt.Errorf("failed to write recents file: %w", err)
	}
	return nil
}
