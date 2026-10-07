//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// TestSkillInstallStagesThenCommits covers the staging contract the marketplace
// relies on: nothing appears under the final name until Commit, a path that
// would leave the skill is refused, Commit replaces an existing skill, and
// Abort leaves no staging directory behind on either path.
func TestSkillInstallStagesThenCommits(t *testing.T) {
	root := filepath.Join(t.TempDir(), "skills")
	final, ok := SkillDir(root, "demo")
	if !ok {
		t.Fatal("SkillDir refused a valid name")
	}
	if _, ok := SkillDir(root, "../escape"); ok {
		t.Fatal("SkillDir accepted a name that leaves the root")
	}

	// An earlier install the commit must replace, not merge into.
	if err := os.MkdirAll(final, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(final, "stale.txt"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}

	inst, err := BeginSkillInstall(root)
	if err != nil {
		t.Fatalf("BeginSkillInstall: %v", err)
	}
	defer inst.Abort()

	if inst.Accepts("../outside.md") {
		t.Error("Accepts let a path leave the skill")
	}
	if err := inst.WriteFile("../outside.md", []byte("x"), false); !errors.Is(err, ErrUnsafeSkillPath) {
		t.Errorf("WriteFile outside the skill: err = %v, want ErrUnsafeSkillPath", err)
	}
	if err := inst.WriteFile("SKILL.md", []byte("---\ndescription: d\n---\n"), false); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := inst.WriteFile("scripts/run.sh", []byte("#!/bin/sh\n"), true); err != nil {
		t.Fatalf("WriteFile nested: %v", err)
	}
	if _, err := os.Stat(filepath.Join(final, "SKILL.md")); !os.IsNotExist(err) {
		t.Fatal("a staged file was visible under the final name before Commit")
	}

	if err := inst.Commit(final); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if _, err := os.Stat(filepath.Join(final, "stale.txt")); !os.IsNotExist(err) {
		t.Error("Commit merged into the earlier install instead of replacing it")
	}
	info, err := os.Stat(filepath.Join(final, "scripts", "run.sh"))
	if err != nil {
		t.Fatalf("committed script missing: %v", err)
	}
	if info.Mode().Perm()&0o100 == 0 {
		t.Errorf("an executable file lost its mode: %v", info.Mode())
	}

	// Abort after Commit is a no-op; an aborted install leaves nothing behind.
	inst.Abort()
	aborted, err := BeginSkillInstall(root)
	if err != nil {
		t.Fatal(err)
	}
	aborted.Abort()
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "demo" {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("root holds %v, want only the committed skill", names)
	}
}
