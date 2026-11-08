//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"juggler/internal/atomicio"
	"juggler/internal/userpaths"
)

// RecentsCap caps the number of remembered recent project paths.
const RecentsCap = 10

// RecentsStore manages a user-level list of recently-opened project paths,
// stored in ~/.juggler/cache/recents.json.
type RecentsStore struct {
	filePath string
}

// recentsFile is the on-disk schema. Used holds when each path was last
// touched (Touch); a path recorded before that was kept has none.
type recentsFile struct {
	Paths []string             `json:"paths"`
	Used  map[string]time.Time `json:"used,omitempty"`
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
	f, err := s.read()
	return f.Paths, err
}

// Used returns when each recent path was last touched. A path with no time
// recorded is absent.
func (s *RecentsStore) Used() (map[string]time.Time, error) {
	f, err := s.read()
	if f.Used == nil {
		f.Used = map[string]time.Time{}
	}
	return f.Used, err
}

// read loads the whole file. Missing file yields an empty one without error.
// Every session and the machine server share the file, and save replaces it by
// rename, which Windows refuses a reader for its duration — hence the robust read.
func (s *RecentsStore) read() (recentsFile, error) {
	var f recentsFile
	data, err := atomicio.RobustReadFile(s.filePath)
	if os.IsNotExist(err) {
		return f, nil
	}
	if err != nil {
		return f, fmt.Errorf("failed to read recents file: %w", err)
	}
	if len(data) == 0 {
		return f, nil
	}
	if err := json.Unmarshal(data, &f); err != nil {
		return recentsFile{}, fmt.Errorf("failed to parse recents file: %w", err)
	}
	return f, nil
}

// Add touches path now (Touch).
func (s *RecentsStore) Add(path string) error {
	return s.Touch(path, time.Now())
}

// Touch moves path to the front of the list, records at as when it was last
// used, dedups, and caps at RecentsCap. path should already be absolute.
func (s *RecentsStore) Touch(path string, at time.Time) error {
	if path == "" {
		return nil
	}
	f, err := s.read()
	if err != nil {
		return err
	}
	out := make([]string, 0, len(f.Paths)+1)
	out = append(out, path)
	for _, p := range f.Paths {
		if p == path {
			continue
		}
		out = append(out, p)
		if len(out) >= RecentsCap {
			break
		}
	}
	used := map[string]time.Time{path: at}
	for _, p := range out[1:] {
		if t, ok := f.Used[p]; ok {
			used[p] = t
		}
	}
	return s.save(recentsFile{Paths: out, Used: used})
}

// Prune drops entries whose folder no longer exists (or is no longer a
// directory), persists the result when anything changed, and returns the
// surviving list in most-recent order. A path that fails to stat for any
// reason other than "not found" — e.g. an offline network mount or a
// permission error — is kept, so a temporarily-unreachable project isn't
// forgotten; only definitively-absent folders are dropped.
func (s *RecentsStore) Prune() ([]string, error) {
	f, err := s.read()
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(f.Paths))
	changed := false
	for _, p := range f.Paths {
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
		used := map[string]time.Time{}
		for _, p := range out {
			if t, ok := f.Used[p]; ok {
				used[p] = t
			}
		}
		if err := s.save(recentsFile{Paths: out, Used: used}); err != nil {
			return out, err
		}
	}
	return out, nil
}

func (s *RecentsStore) save(f recentsFile) error {
	dir := filepath.Dir(s.filePath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("failed to create recents directory: %w", err)
	}
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal recents: %w", err)
	}
	if err := atomicio.WriteFile(s.filePath, data, 0600); err != nil {
		return fmt.Errorf("failed to write recents file: %w", err)
	}
	return nil
}
