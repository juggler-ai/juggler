//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package core

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

// A move to another drive is refused before anything is tried: a rename
// cannot make it, and the session would be retired for nothing.
func TestRelocateProjectRefusesAnotherDrive(t *testing.T) {
	project := t.TempDir()
	drive := "Z:"
	if strings.EqualFold(filepath.VolumeName(project), drive) {
		drive = "Y:"
	}
	if err := CheckProjectRelocation(project, drive+`\elsewhere`); !errors.Is(err, errVolume) {
		t.Fatalf("CheckProjectRelocation to %s = %v, want the other-volume refusal", drive, err)
	}
}
