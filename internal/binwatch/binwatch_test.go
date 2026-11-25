//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package binwatch

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// goBinary is this test's own executable: a real Go binary, with a build ID
// and build info, that every case starts from.
func goBinary(t *testing.T) []byte {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// otherBuild is data with one character of its build ID changed: to Read, the
// binary of another build, still complete and parseable.
func otherBuild(t *testing.T, data []byte) []byte {
	t.Helper()
	start, _, err := IDSpan(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("test binary: %v", err)
	}
	out := bytes.Clone(data)
	at := start
	if out[at] == 'A' {
		out[at] = 'B'
	} else {
		out[at] = 'A'
	}
	return out
}

// install puts data at path the way a build or an update does: written beside
// it, then renamed over it.
func install(t *testing.T, path string, data []byte) {
	t.Helper()
	tmp := path + ".new"
	if err := os.WriteFile(tmp, data, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, path); err != nil {
		t.Fatal(err)
	}
}

func watching(t *testing.T, data []byte) (*Watcher, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "juggler.exe")
	install(t, path, data)
	w, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	return w, path
}

// settle polls the way the caller's ticker does, twice, so a file that stopped
// changing is judged; it returns what the second poll reported.
func settle(w *Watcher) *Build {
	w.Poll()
	return w.Poll()
}

// TestBinwatchReadsTheLinkersBuildID: the ID found is the one the Go
// toolchain itself reports for this binary (go tool buildid's, which
// debug/buildinfo does not carry), whichever format the platform links.
func TestBinwatchReadsTheLinkersBuildID(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	id, err := ReadID(exe)
	if err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("go", "tool", "buildid", exe).Output()
	if err != nil {
		t.Skipf("go tool buildid: %v", err)
	}
	if want := strings.TrimSpace(string(out)); id != want {
		t.Fatalf("ReadID = %q, want go tool buildid's %q", id, want)
	}
}

func TestBinwatchUnchangedIsNotReported(t *testing.T) {
	w, _ := watching(t, goBinary(t))
	if b := settle(w); b != nil {
		t.Fatalf("the watched build itself was reported as new: %+v", b)
	}
}

func TestBinwatchAnotherBuildIsReportedOnceSettled(t *testing.T) {
	data := goBinary(t)
	w, path := watching(t, data)
	settle(w)
	next := otherBuild(t, data)
	install(t, path, next)
	if b := w.Poll(); b != nil {
		t.Fatalf("a file first seen this poll was reported before it settled: %+v", b)
	}
	b := w.Poll()
	if b == nil {
		t.Fatal("another build, settled, was not reported")
	}
	want, err := Read(path)
	if err != nil {
		t.Fatal(err)
	}
	if b.ID != want.ID || b.ID == "" {
		t.Fatalf("reported build ID %q, want %q", b.ID, want.ID)
	}
	if again := w.Poll(); again == nil || again.ID != b.ID {
		t.Fatalf("a later poll stopped reporting the new build: %+v", again)
	}
}

func TestBinwatchSameBuildCopiedAgainIsNotReported(t *testing.T) {
	// A rebuild with nothing changed: a new file, new mtime, the same build.
	data := goBinary(t)
	w, path := watching(t, data)
	settle(w)
	install(t, path, data)
	if b := settle(w); b != nil {
		t.Fatalf("the same build, placed again, was reported as new: %+v", b)
	}
}

func TestBinwatchFileStillGrowingIsNotReported(t *testing.T) {
	data := goBinary(t)
	w, path := watching(t, data)
	settle(w)
	next := otherBuild(t, data)
	half := len(next) / 2
	install(t, path, next[:half])
	w.Poll()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write(next[half : half+half/2]); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if b := w.Poll(); b != nil {
		t.Fatalf("a file that grew since the last poll was reported: %+v", b)
	}
}

func TestBinwatchIncompleteBinaryIsNotReported(t *testing.T) {
	// Stopped part-way: the build ID near the start is all there, the rest is not.
	data := goBinary(t)
	w, path := watching(t, data)
	settle(w)
	next := otherBuild(t, data)
	install(t, path, next[:len(next)/2])
	if b := settle(w); b != nil {
		t.Fatalf("a truncated binary was reported as a build: %+v", b)
	}
	install(t, path, next)
	if b := settle(w); b == nil {
		t.Fatal("the build, once complete, was not reported")
	}
}

func TestBinwatchMissingFileIsNotReported(t *testing.T) {
	w, path := watching(t, goBinary(t))
	settle(w)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if b := settle(w); b != nil {
		t.Fatalf("a missing file was reported: %+v", b)
	}
}

// TestBinwatchReadNeverBlocksAnInstall: a binary binwatch has open can be put
// aside and replaced, as an update or a rebuild does on Windows while the
// watcher happens to be reading it.
func TestBinwatchReadNeverBlocksAnInstall(t *testing.T) {
	path := filepath.Join(t.TempDir(), "juggler.exe")
	install(t, path, goBinary(t))
	f, err := open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := os.Rename(path, path+".old"); err != nil {
		t.Fatalf("put aside while binwatch reads it: %v", err)
	}
	install(t, path, goBinary(t))
}

func TestBinwatchReadsTheStampedVersion(t *testing.T) {
	if got := stampedVersion("-X juggler/cmd/juggler/core.stampedVersion=v0.8.2-dev -X juggler/cmd/juggler/core.Commit=7c022ce4 -H windowsgui"); got != "v0.8.2-dev" {
		t.Fatalf("stampedVersion = %q", got)
	}
	if got := stampedVersion("-s -w"); got != "" {
		t.Fatalf("stampedVersion of unstamped flags = %q", got)
	}
}
