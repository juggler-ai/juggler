//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"os"
	"path/filepath"
	"sort"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/tests/helpers"
)

// TestConversationName_FolderIsSourceOfTruth pins the architectural invariant
// that the on-disk folder name `<name>--<conv_id>/` is the single
// authoritative source of every conversation's name.
//
// Concretely:
//   - CreateConversation makes the folder with its canonical name before
//     returning.
//   - RenameConversation changes the on-disk folder name atomically.
//   - ConvNames() always agrees with a fresh ScanConvDirs() of the same
//     directory — no second cache can drift.
//
// If any future change introduces a parallel name store (a JSON field,
// an in-memory map written by something other than the folder layer), this
// test will fail because the two scans will diverge.
func TestConversationName_FolderIsSourceOfTruth(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	t.Cleanup(func() { os.RemoveAll(projectDir) })

	manager, err := core.NewSessionManagerForPath(projectDir)
	helpers.AssertNoError(t, err)
	t.Cleanup(func() { manager.Shutdown() })

	jugglerDir := filepath.Join(projectDir, ".juggler")

	// 1. Create three conversations.
	idA, nameA, err := manager.CreateConversation("Alpha")
	helpers.AssertNoError(t, err)
	idB, nameB, err := manager.CreateConversation("Bravo")
	helpers.AssertNoError(t, err)
	idC, nameC, err := manager.CreateConversation("Charlie")
	helpers.AssertNoError(t, err)

	if nameA != "Alpha" || nameB != "Bravo" || nameC != "Charlie" {
		t.Fatalf("canonical names: got (%q,%q,%q)", nameA, nameB, nameC)
	}

	assertNamesMatchDisk(t, manager, jugglerDir, map[string]string{
		idA: "Alpha", idB: "Bravo", idC: "Charlie",
	})

	// 2. Rename the middle one — folder must be renamed.
	if _, err := manager.RenameConversation(idB, "Bravo Renamed"); err != nil {
		t.Fatalf("rename: %v", err)
	}
	assertNamesMatchDisk(t, manager, jugglerDir, map[string]string{
		idA: "Alpha", idB: "Bravo Renamed", idC: "Charlie",
	})

	// 3. Delete one — folder is gone, ConvNames drops it.
	if err := manager.DeleteConversation(idA, true); err != nil {
		t.Fatalf("delete: %v", err)
	}
	assertNamesMatchDisk(t, manager, jugglerDir, map[string]string{
		idB: "Bravo Renamed", idC: "Charlie",
	})

	// 4. Name collision picks up a " (copy N)" suffix — and that suffix
	//    lands in the folder name, not in some other field.
	idDup, nameDup, err := manager.CreateConversation("Charlie")
	helpers.AssertNoError(t, err)
	if nameDup == "Charlie" {
		t.Fatalf("expected case-folded collision to mint a new name, got %q", nameDup)
	}
	assertNamesMatchDisk(t, manager, jugglerDir, map[string]string{
		idB: "Bravo Renamed", idC: "Charlie", idDup: nameDup,
	})
}

// assertNamesMatchDisk asserts that manager.ConvNames() and a fresh
// ScanConvDirs of jugglerDir produce identical id→name maps, and that
// both equal the expected set. Three-way equality means no cache can
// drift from disk and no expected entry is missing.
func assertNamesMatchDisk(t *testing.T, m *core.SessionManager, jugglerDir string, expected map[string]string) {
	t.Helper()

	mgrNames := m.ConvNames()
	idx, err := core.ScanConvDirs(jugglerDir)
	helpers.AssertNoError(t, err)
	diskNames := idx.Names

	if !sameMap(mgrNames, diskNames) {
		t.Fatalf("ConvNames() drifted from disk:\n  manager: %s\n  disk:    %s",
			dumpMap(mgrNames), dumpMap(diskNames))
	}
	if !sameMap(mgrNames, expected) {
		t.Fatalf("names mismatch:\n  got:      %s\n  expected: %s",
			dumpMap(mgrNames), dumpMap(expected))
	}
}

func sameMap(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

func dumpMap(m map[string]string) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	s := "{"
	for i, k := range keys {
		if i > 0 {
			s += ", "
		}
		s += k + "=" + m[k]
	}
	return s + "}"
}
