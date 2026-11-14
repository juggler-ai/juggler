//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"juggler/internal/atomicio"
	"juggler/internal/userpaths"
)

// RecentModelsCap caps the number of remembered recent
// (provider, model, thinking, serviceTier) picks.
const RecentModelsCap = 6

// RecentModelsStore manages a user-level list of recently-used concrete
// models, stored in ~/.juggler/cache/recent-models.json. It is deliberately
// server-side (not browser localStorage) so the list survives an app relaunch
// and the spawned server binding to a different port — localStorage is
// partitioned by origin, so a port change would otherwise reset it. Whether a
// model is currently available has no bearing on this list.
type RecentModelsStore struct {
	filePath string
}

// recentModelsFile is the on-disk schema.
type recentModelsFile struct {
	Models []ModelRef `json:"models"`
}

// NewRecentModelsStore returns a store backed by
// ~/.juggler/cache/recent-models.json. The MRU list is regenerable convenience
// state, so it lives under the cache dir.
func NewRecentModelsStore() (*RecentModelsStore, error) {
	return &RecentModelsStore{
		filePath: filepath.Join(userpaths.CacheDir(), "recent-models.json"),
	}, nil
}

// Load returns the current recents list (most-recent first). Missing file
// yields an empty slice without error.
func (s *RecentModelsStore) Load() ([]ModelRef, error) {
	data, err := os.ReadFile(s.filePath)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to read recent models file: %w", err)
	}
	if len(data) == 0 {
		return nil, nil
	}
	var f recentModelsFile
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("failed to parse recent models file: %w", err)
	}
	return f.Models, nil
}

// Add moves ref to the front of the list, dedups by the whole ref — the same
// model at two thinking levels, or at two serving tiers, is two distinct
// entries — and caps at RecentModelsCap. Both dials are part of the identity
// because re-picking a recent entry restores the pair verbatim, and an entry
// that dropped its tier would quietly re-select standard serving.
// A ref with an empty provider or model is ignored.
func (s *RecentModelsStore) Add(ref ModelRef) error {
	if ref.Provider == "" || ref.Model == "" {
		return nil
	}
	models, err := s.Load()
	if err != nil {
		return err
	}
	out := make([]ModelRef, 0, len(models)+1)
	out = append(out, ref)
	for _, m := range models {
		if m.Provider == ref.Provider && m.Model == ref.Model && m.Thinking == ref.Thinking && m.ServiceTier == ref.ServiceTier {
			continue
		}
		out = append(out, m)
		if len(out) >= RecentModelsCap {
			break
		}
	}
	return s.save(out)
}

// RemoveProvider drops every entry naming providerName. A list with none is
// left untouched on disk.
func (s *RecentModelsStore) RemoveProvider(providerName string) error {
	models, err := s.Load()
	if err != nil {
		return err
	}
	kept := make([]ModelRef, 0, len(models))
	for _, m := range models {
		if m.Provider != providerName {
			kept = append(kept, m)
		}
	}
	if len(kept) == len(models) {
		return nil
	}
	return s.save(kept)
}

func (s *RecentModelsStore) save(models []ModelRef) error {
	dir := filepath.Dir(s.filePath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("failed to create recent models directory: %w", err)
	}
	data, err := json.MarshalIndent(recentModelsFile{Models: models}, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal recent models: %w", err)
	}
	if err := atomicio.WriteFile(s.filePath, data, 0600); err != nil {
		return fmt.Errorf("failed to write recent models file: %w", err)
	}
	return nil
}
