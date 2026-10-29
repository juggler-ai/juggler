//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestValidateFilePathWithRoots_SymlinkedWorkingDir_NotYetExistingFile guards a
// symlink-prefix regression: on macOS, t.TempDir() returns a path under
// /var/folders/... which is a symlink to /private/var/folders/..., so
// EvalSymlinks(workingDir) resolves to the /private form. When the caller asks
// to validate an absolute path to a not-yet-existing file inside that dir, the
// raw absPath stays in the /var form. Without resolveExistingPrefix the prefix
// check spuriously fires "outside working directory".
func TestValidateFilePathWithRoots_SymlinkedWorkingDir_NotYetExistingFile(t *testing.T) {
	if runtime.GOOS != "darwin" {
		// /var → /private/var is a macOS convention. On Linux /tmp is not
		// symlinked the same way; the explicit-symlink subtest below covers
		// the cross-platform case.
		t.Skip("symlinked /var prefix is macOS-specific")
	}

	tmpDir := t.TempDir()
	// Sanity: on macOS, t.TempDir() returns the un-resolved /var/folders form.
	if !strings.HasPrefix(tmpDir, "/var/folders/") {
		t.Skipf("t.TempDir() returned %q; expected /var/folders prefix", tmpDir)
	}

	// File does not exist yet — write tools pre-validate before creation.
	notYetExisting := filepath.Join(tmpDir, "subdir", "newfile.txt")

	result, err := ValidateFilePathWithRoots(tmpDir, nil, notYetExisting)
	if err != nil {
		t.Fatalf("ValidateFilePathWithRoots returned error for symlinked workingDir + new file: %v", err)
	}
	if !result.IsValid {
		t.Fatalf("expected IsValid=true, got error %q (AbsPath=%q)", result.ErrorMsg, result.AbsPath)
	}
}

// TestValidateFilePathWithRoots_ExplicitSymlinkedWorkingDir is the cross-platform analogue:
// build a symlink that points at the real working dir, then call validate with
// the symlink-side path. Without prefix canonicalisation, the unresolved input
// path doesn't match the EvalSymlinks-resolved workingDir and validation fails.
func TestValidateFilePathWithRoots_ExplicitSymlinkedWorkingDir(t *testing.T) {
	realDir := t.TempDir()
	linkParent := t.TempDir()
	linkDir := filepath.Join(linkParent, "link-to-real")
	if err := os.Symlink(realDir, linkDir); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	notYetExisting := filepath.Join(linkDir, "subdir", "newfile.txt")

	result, err := ValidateFilePathWithRoots(linkDir, nil, notYetExisting)
	if err != nil {
		t.Fatalf("ValidateFilePathWithRoots returned error for symlinked workingDir + new file: %v", err)
	}
	if !result.IsValid {
		t.Fatalf("expected IsValid=true, got error %q (AbsPath=%q)", result.ErrorMsg, result.AbsPath)
	}

	// AbsPath should be canonicalised under realDir, not linkDir.
	realResolved, err := filepath.EvalSymlinks(realDir)
	if err != nil {
		t.Fatalf("EvalSymlinks(realDir): %v", err)
	}
	if !strings.HasPrefix(result.AbsPath, realResolved) {
		t.Errorf("AbsPath=%q does not start with resolved realDir=%q", result.AbsPath, realResolved)
	}
}

// TestValidateFilePathWithRoots_AcceptsPathInExtraRoot covers the allowed-paths
// feature: a path outside the working dir but inside a user-granted extra root
// validates successfully.
func TestValidateFilePathWithRoots_AcceptsPathInExtraRoot(t *testing.T) {
	workingDir := t.TempDir()
	extraRoot := t.TempDir()
	target := filepath.Join(extraRoot, "notes.txt")
	if err := os.WriteFile(target, []byte("hi"), 0o644); err != nil {
		t.Fatalf("write target: %v", err)
	}

	result, err := ValidateFilePathWithRoots(workingDir, []string{extraRoot}, target)
	if err != nil {
		t.Fatalf("expected path inside extra root to validate, got error: %v", err)
	}
	if !result.IsValid {
		t.Fatalf("expected IsValid=true, got error %q", result.ErrorMsg)
	}
	realExtra, _ := filepath.EvalSymlinks(extraRoot)
	if !strings.HasPrefix(result.AbsPath, realExtra) {
		t.Errorf("AbsPath=%q does not start with resolved extra root=%q", result.AbsPath, realExtra)
	}
}

// TestValidateFilePathWithRoots_AcceptsNotYetExistingInExtraRoot guards that a
// not-yet-existing file under an extra root (write-class pre-validation) is
// accepted, exercising the resolveExistingPrefix path against the extra root.
func TestValidateFilePathWithRoots_AcceptsNotYetExistingInExtraRoot(t *testing.T) {
	workingDir := t.TempDir()
	extraRoot := t.TempDir()
	target := filepath.Join(extraRoot, "subdir", "new.txt")

	result, err := ValidateFilePathWithRoots(workingDir, []string{extraRoot}, target)
	if err != nil {
		t.Fatalf("expected not-yet-existing path inside extra root to validate, got error: %v", err)
	}
	if !result.IsValid {
		t.Fatalf("expected IsValid=true, got error %q", result.ErrorMsg)
	}
}

// TestValidateFilePathWithRoots_RejectsOutsideAllRoots guards the security
// property: a path outside both the working dir and every extra root is
// rejected.
func TestValidateFilePathWithRoots_RejectsOutsideAllRoots(t *testing.T) {
	workingDir := t.TempDir()
	extraRoot := t.TempDir()
	elsewhere := t.TempDir()
	outsideFile := filepath.Join(elsewhere, "secret.txt")

	result, err := ValidateFilePathWithRoots(workingDir, []string{extraRoot}, outsideFile)
	if err == nil {
		t.Fatalf("expected error for path outside all roots, got AbsPath=%q IsValid=%v", result.AbsPath, result.IsValid)
	}
	if result.IsValid {
		t.Fatalf("expected IsValid=false for path outside all roots")
	}
}

// TestValidateFilePathWithRoots_EmptyRootsMatchesWorkingDirOnly confirms that
// with no extra roots the validator contains to the working directory: inside
// it validates, outside is rejected.
func TestValidateFilePathWithRoots_EmptyRootsMatchesWorkingDirOnly(t *testing.T) {
	workingDir := t.TempDir()
	outside := t.TempDir()

	inside := filepath.Join(workingDir, "f.txt")
	if r, err := ValidateFilePathWithRoots(workingDir, nil, inside); err != nil || !r.IsValid {
		t.Fatalf("expected inside-workingDir path to validate, err=%v", err)
	}

	outsideFile := filepath.Join(outside, "f.txt")
	if r, err := ValidateFilePathWithRoots(workingDir, nil, outsideFile); err == nil || r.IsValid {
		t.Fatalf("expected outside-workingDir path to be rejected with empty roots")
	}
}

// TestValidateFilePathWithRoots_IgnoresEmptyRootEntries guards that blank
// entries in the roots slice never widen access to the filesystem root.
func TestValidateFilePathWithRoots_IgnoresEmptyRootEntries(t *testing.T) {
	workingDir := t.TempDir()
	elsewhere := t.TempDir()
	outsideFile := filepath.Join(elsewhere, "secret.txt")

	result, err := ValidateFilePathWithRoots(workingDir, []string{"", "   "}, outsideFile)
	if err == nil || result.IsValid {
		t.Fatalf("expected blank root entries to be ignored, but path validated: AbsPath=%q", result.AbsPath)
	}
}
