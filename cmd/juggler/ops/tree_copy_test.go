//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

// seedTree writes a small project: two source files, a gitignored build
// directory, and the two directories this app always treats as its own.
func seedTree(t *testing.T, root string) {
	t.Helper()
	write := func(rel, content string, mode os.FileMode) {
		abs := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatalf("seed %s: %v", rel, err)
		}
		if err := os.WriteFile(abs, []byte(content), mode); err != nil {
			t.Fatalf("seed %s: %v", rel, err)
		}
		// WriteFile's mode is filtered by the umask; set it outright.
		if err := os.Chmod(abs, mode); err != nil {
			t.Fatalf("seed %s: %v", rel, err)
		}
	}
	write(".gitignore", "build/\n*.log\n", 0o644)
	write("main.go", "package main\n", 0o644)
	write("src/util.go", "package src\n", 0o644)
	write("run.sh", "#!/bin/sh\necho hi\n", 0o755)
	write("noise.log", "chatter\n", 0o644)
	write("build/artifact.bin", "binary\n", 0o644)
	write(".git/HEAD", "ref: refs/heads/main\n", 0o644)
	write(".juggler/session.json", "{}\n", 0o644)
}

// paths lists what a copy landed, relative and slash-separated, so a test can
// say what a tree holds in one comparison.
func landedPaths(t *testing.T, root string) []string {
	t.Helper()
	var found []string
	err := filepath.WalkDir(root, func(abs string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, abs)
		rel = filepath.ToSlash(rel)
		if rel == "." || d.IsDir() {
			return nil
		}
		found = append(found, rel)
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	slices.Sort(found)
	return found
}

// TestCopyTreeRespectsIgnoreRules asserts that a copy carries the files that
// matter and leaves out the ones every other surface here leaves out — without
// git being involved, which is the whole point: the matcher reads .gitignore
// itself, so a project with no git installed and no repository still gets the
// copy its ignore file describes.
func TestCopyTreeRespectsIgnoreRules(t *testing.T) {
	from := t.TempDir()
	to := filepath.Join(t.TempDir(), "copy")
	seedTree(t, from)

	ops := NewTreeOperations(NewPathScope(filepath.Dir(from), nil))
	result, err := ops.Execute(context.Background(), "copy", map[string]any{
		"from": from,
		"to":   to,
	})
	if err != nil {
		t.Fatalf("copy: %v", err)
	}

	want := []string{".gitignore", "main.go", "run.sh", "src/util.go"}
	if got := landedPaths(t, to); !slices.Equal(got, want) {
		t.Fatalf("copied %v, want %v", got, want)
	}
	if copied := result.(map[string]any)["copied"].(int); copied != len(want) {
		t.Fatalf("reported %d files copied, want %d", copied, len(want))
	}
}

// TestCopyTreeSkipsASourceThatVanishesBetweenThePasses asserts that a file the
// walk found and the copy cannot open because it has gone is left out, rather
// than taking the whole copy down with it. A copy reads a tree other things are
// writing into — the user's editor, a build, another conversation's atomic
// write, whose temporary file is renamed away moments after it appears — so the
// gap between collecting a tree and copying it is a gap anything in it can go
// missing in. Everything else still arrives, and the counts say one thing did
// not.
func TestCopyTreeSkipsASourceThatVanishesBetweenThePasses(t *testing.T) {
	from := t.TempDir()
	to := filepath.Join(t.TempDir(), "copy")
	seedTree(t, from)

	afterCollectHook.Store(func() {
		if err := os.Remove(filepath.Join(from, "main.go")); err != nil {
			t.Errorf("remove: %v", err)
		}
	})
	t.Cleanup(func() { afterCollectHook.Store(func() {}) })

	ops := NewTreeOperations(NewPathScope(filepath.Dir(from), nil))
	result, err := ops.Execute(context.Background(), "copy", map[string]any{
		"from": from,
		"to":   to,
	})
	if err != nil {
		t.Fatalf("copy: %v", err)
	}

	want := []string{".gitignore", "run.sh", "src/util.go"}
	if got := landedPaths(t, to); !slices.Equal(got, want) {
		t.Fatalf("copied %v, want %v", got, want)
	}
	counts := result.(map[string]any)
	if copied := counts["copied"].(int); copied != len(want) {
		t.Fatalf("reported %d files copied, want %d", copied, len(want))
	}
	if skipped := counts["skipped"].(int); skipped != 1 {
		t.Fatalf("reported %d files skipped, want 1", skipped)
	}
}

// TestCopyTreeKeepsModeAndTime asserts the two things a later comparison
// depends on: an executable stays executable, and a copied file keeps its
// modification time, which is what lets compare answer for an untouched tree
// without reading any of it.
func TestCopyTreeKeepsModeAndTime(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix permission bits are not represented on Windows")
	}
	from := t.TempDir()
	to := filepath.Join(t.TempDir(), "copy")
	seedTree(t, from)

	ops := NewTreeOperations(NewPathScope(filepath.Dir(from), nil))
	if _, err := ops.Execute(context.Background(), "copy", map[string]any{"from": from, "to": to}); err != nil {
		t.Fatalf("copy: %v", err)
	}

	source, err := os.Stat(filepath.Join(from, "run.sh"))
	if err != nil {
		t.Fatalf("stat source: %v", err)
	}
	copied, err := os.Stat(filepath.Join(to, "run.sh"))
	if err != nil {
		t.Fatalf("stat copy: %v", err)
	}
	if copied.Mode().Perm() != 0o755 {
		t.Fatalf("copied mode = %o, want 0755", copied.Mode().Perm())
	}
	if !copied.ModTime().Equal(source.ModTime()) {
		t.Fatalf("copied mtime = %v, want %v", copied.ModTime(), source.ModTime())
	}
}

// TestCopyTreeSkipsItsOwnDestination asserts that copying a tree into a
// directory inside itself terminates and does not copy the destination into
// itself. This is the ordinary case rather than an odd one: a sandbox lives
// under the project it is a copy of, and the ignore rules that would normally
// hide it are explicitly off here, so only the walk's own guard can stop it.
func TestCopyTreeSkipsItsOwnDestination(t *testing.T) {
	from := t.TempDir()
	seedTree(t, from)
	to := filepath.Join(from, "sandboxes", "work")

	ops := NewTreeOperations(NewPathScope(from, nil))
	done := make(chan error, 1)
	go func() {
		_, err := ops.Execute(context.Background(), "copy", map[string]any{
			"from":          from,
			"to":            to,
			"respectIgnore": false,
		})
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("copy: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("copying a tree into itself never finished")
	}

	if _, err := os.Stat(filepath.Join(to, "sandboxes")); !os.IsNotExist(err) {
		t.Fatalf("the destination copied itself into itself: %v", err)
	}
	if _, err := os.Stat(filepath.Join(to, "build", "artifact.bin")); err != nil {
		t.Fatalf("with the ignore rules off the build output should be there: %v", err)
	}
}

// TestCopyTreeNamedPathsAndDeletions asserts the two parameters an apply is
// built from: only the named paths are carried across (with the directories
// they need), and the named deletions are gone before anything lands.
func TestCopyTreeNamedPathsAndDeletions(t *testing.T) {
	from := t.TempDir()
	to := t.TempDir()
	seedTree(t, from)
	if err := os.WriteFile(filepath.Join(to, "doomed.txt"), []byte("go away\n"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	ops := NewTreeOperations(NewPathScope(filepath.Dir(from), nil))
	if _, err := ops.Execute(context.Background(), "copy", map[string]any{
		"from":   from,
		"to":     to,
		"paths":  []any{"src/util.go"},
		"delete": []any{"doomed.txt"},
	}); err != nil {
		t.Fatalf("copy: %v", err)
	}

	want := []string{"src/util.go"}
	if got := landedPaths(t, to); !slices.Equal(got, want) {
		t.Fatalf("landed %v, want %v", got, want)
	}
}

// TestCopyTreeStopsWhenTheContextIsCancelled asserts a copy is abandoned when
// the request behind it is. It is the server half of Cancel: a provision that
// is called off part-way through a fifteen-minute copy has to actually stop
// copying, and the browser half can only abort the request.
func TestCopyTreeStopsWhenTheContextIsCancelled(t *testing.T) {
	from := t.TempDir()
	to := filepath.Join(t.TempDir(), "copy")
	seedTree(t, from)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	ops := NewTreeOperations(NewPathScope(filepath.Dir(from), nil))
	if _, err := ops.Execute(ctx, "copy", map[string]any{"from": from, "to": to}); err == nil {
		t.Fatal("a copy under a cancelled request ran to completion")
	}
	if entries, err := os.ReadDir(to); err == nil && len(entries) > 0 {
		t.Fatalf("it copied %d entries anyway", len(entries))
	}
}

// TestCopyTreeDeletesWithoutCopying asserts the removal form: no `from`, just
// what to take away. It is the inverse of a copy and its only caller is whoever
// made the tree in the first place — which is what lets a provider build and
// unbuild one without a shell, and so without an opinion about how each of the
// three Windows shells quotes a path.
func TestCopyTreeDeletesWithoutCopying(t *testing.T) {
	root := t.TempDir()
	doomed := filepath.Join(root, "sandboxes", "try-it")
	if err := os.MkdirAll(doomed, 0o755); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(doomed, "work.txt"), []byte("hours of it\n"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	ops := NewTreeOperations(NewPathScope(root, nil))
	result, err := ops.Execute(context.Background(), "copy", map[string]any{
		"to":     ".",
		"delete": []any{"sandboxes/try-it"},
	})
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if deleted := result.(map[string]any)["deleted"].(int); deleted != 1 {
		t.Fatalf("reported %d deletions, want 1", deleted)
	}
	if _, err := os.Stat(doomed); !os.IsNotExist(err) {
		t.Fatalf("the directory is still there: %v", err)
	}

	if _, err := ops.Execute(context.Background(), "copy", map[string]any{"to": "."}); err == nil {
		t.Fatal("a copy with nothing to copy and nothing to delete was accepted")
	}
}

// startWritingTask spawns a background task rooted at dir that creates files in
// it for as long as it runs — a dev server or a watch build, as far as a removal
// can tell — and waits until it is up.
func startWritingTask(t *testing.T, dir string) string {
	t.Helper()
	res, err := NewShellOperations(NewPathScope(dir, nil)).startBackground(map[string]any{
		"command": `echo ready; i=0; while :; do i=$((i+1)); true > "w$i" 2>/dev/null || sleep 0.05; done`,
		"convId":  "conv-sandbox",
	})
	if err != nil {
		t.Fatalf("startBackground failed: %v", err)
	}
	id, _ := res.(map[string]any)["task_id"].(string)
	if id == "" {
		t.Fatalf("startBackground returned no task_id: %+v", res)
	}
	t.Cleanup(func() { KillTask(id) })
	waitForOutput(t, id, "ready", 5*time.Second)
	return id
}

// TestCopyTreeDeletionStopsTasksRunningInIt asserts that removing a tree stops
// the background tasks running in it first. A task started in a sandbox keeps
// writing there while the removal runs, so a removal that leaves it alone fails
// with "directory not empty" — and a removal that succeeded would leave it
// running in a directory that no longer exists.
func TestCopyTreeDeletionStopsTasksRunningInIt(t *testing.T) {
	requirePOSIXShell(t)
	root := t.TempDir()
	doomed := filepath.Join(root, "sandboxes", "try-it", "work")
	if err := os.MkdirAll(doomed, 0o755); err != nil {
		t.Fatalf("seed: %v", err)
	}
	writer := startWritingTask(t, doomed)
	// The project's own task stands above the tree being removed, not in it.
	spared := startTestTask(t, root, "conv-project")

	ops := NewTreeOperations(NewPathScope(root, nil))
	if _, err := ops.Execute(context.Background(), "copy", map[string]any{
		"to":     ".",
		"delete": []any{"sandboxes/try-it"},
	}); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "sandboxes", "try-it")); !os.IsNotExist(err) {
		t.Fatalf("the directory is still there: %v", err)
	}
	if s := TaskState(writer); s.Status != "failed" {
		t.Fatalf("the task running in the removed tree is %q, want it stopped", s.Status)
	} else if !strings.Contains(s.Error, "sandboxes/try-it") {
		t.Fatalf("the stop reason should name what was removed, got %q", s.Error)
	}
	if s := TaskState(spared); s.Status != "running" {
		t.Fatalf("a task outside the removed tree must keep running, got %q", s.Status)
	}
}

// TestCopyTreeDeletionOutlastsABriefWriter asserts that a removal rides out a
// writer that stops on its own a moment later — the last write of a process
// that is exiting, or a file manager dropping its metadata in a folder it was
// showing — rather than failing on the first entry that arrived mid-removal.
func TestCopyTreeDeletionOutlastsABriefWriter(t *testing.T) {
	root := t.TempDir()
	doomed := filepath.Join(root, "sandboxes", "try-it")
	if err := os.MkdirAll(doomed, 0o755); err != nil {
		t.Fatalf("seed: %v", err)
	}
	stopAt := time.Now().Add(150 * time.Millisecond)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; time.Now().Before(stopAt); i++ {
			_ = os.WriteFile(filepath.Join(doomed, fmt.Sprintf("late-%d", i)), nil, 0o644)
		}
	}()
	t.Cleanup(func() { <-done })

	ops := NewTreeOperations(NewPathScope(root, nil))
	if _, err := ops.Execute(context.Background(), "copy", map[string]any{
		"to":     ".",
		"delete": []any{"sandboxes/try-it"},
	}); err != nil {
		t.Fatalf("delete: %v", err)
	}
	<-done
	if _, err := os.Stat(doomed); !os.IsNotExist(err) {
		t.Fatalf("the directory is still there: %v", err)
	}
}

// TestCopyTreeDeletionNamesWhatWouldNotGo asserts that a removal that cannot
// finish says what was still there. The error the removal itself gives names
// one path, which for a tree that kept being written to is only the directory
// that was not empty — not what was in it, which is what identifies the writer.
func TestCopyTreeDeletionNamesWhatWouldNotGo(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("directory permissions do not stop a removal on Windows")
	}
	if os.Geteuid() == 0 {
		t.Skip("root removes from a read-only directory")
	}
	root := t.TempDir()
	locked := filepath.Join(root, "sandboxes", "try-it", "locked")
	if err := os.MkdirAll(locked, 0o755); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(locked, "stubborn"), nil, 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := os.Chmod(locked, 0o555); err != nil {
		t.Fatalf("seed: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })

	ops := NewTreeOperations(NewPathScope(root, nil))
	_, err := ops.Execute(context.Background(), "copy", map[string]any{
		"to":     ".",
		"delete": []any{"sandboxes/try-it"},
	})
	if err == nil {
		t.Fatal("a removal that could not remove everything reported success")
	}
	if !strings.Contains(err.Error(), "still there: locked/stubborn") {
		t.Fatalf("the error should name what was left, got %q", err)
	}
}

// TestCompareTreesExactReadsWhatTheTimesClaim asserts both halves of the
// comparison's bargain. Same size and same modification time is taken as
// unchanged, which is what makes comparing a whole tree affordable — and is
// wrong for a file whose editor put the timestamp back. An `exact` comparison
// reads instead, and is what a caller asks for when being wrong means losing
// the change: an apply that misses a file deletes the only copy of it.
func TestCompareTreesExactReadsWhatTheTimesClaim(t *testing.T) {
	root := t.TempDir()
	left := filepath.Join(root, "pristine")
	right := filepath.Join(root, "work")
	for _, dir := range []string{left, right} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	// Same length, different bytes, identical timestamps: the shape an editor
	// that restores mtimes leaves behind.
	if err := os.WriteFile(filepath.Join(left, "note.txt"), []byte("aaaa\n"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(right, "note.txt"), []byte("bbbb\n"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	stamp := time.Now().Add(-time.Hour)
	for _, dir := range []string{left, right} {
		if err := os.Chtimes(filepath.Join(dir, "note.txt"), stamp, stamp); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}

	ops := NewTreeOperations(NewPathScope(root, nil))
	fast, err := ops.Execute(context.Background(), "compare", map[string]any{
		"left": left, "right": right,
	})
	if err != nil {
		t.Fatalf("compare: %v", err)
	}
	if changed := fast.(map[string]any)["changed"].([]string); len(changed) != 0 {
		t.Fatalf("the fast path read the file after all, got %v", changed)
	}

	exact, err := ops.Execute(context.Background(), "compare", map[string]any{
		"left": left, "right": right, "exact": true,
	})
	if err != nil {
		t.Fatalf("exact compare: %v", err)
	}
	changed := exact.(map[string]any)["changed"].([]string)
	if len(changed) != 1 || changed[0] != "note.txt" {
		t.Fatalf("an exact comparison must read the bytes, got %v", changed)
	}
}

// TestCopyTreeRefusesADestinationSymlink asserts that the destination is a real
// directory. The source walk never follows a link, but MkdirAll and O_CREATE
// both do: a destination entry that is a symlink out of the tree would put the
// copy wherever it pointed, which is the containment this file is built on,
// undone by one entry the caller does not control.
func TestCopyTreeRefusesADestinationSymlink(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	from := filepath.Join(root, "source")
	to := filepath.Join(root, "destination")
	if err := os.MkdirAll(filepath.Join(from, "nested"), 0o755); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(from, "nested", "file.txt"), []byte("mine\n"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(from, "plain.txt"), []byte("mine too\n"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := os.MkdirAll(to, 0o755); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// A directory and a file in the destination, each a link out of the tree.
	if err := os.Symlink(outside, filepath.Join(to, "nested")); err != nil {
		t.Skipf("this platform will not make a symlink: %v", err)
	}
	escape := filepath.Join(outside, "plain.txt")
	if err := os.WriteFile(escape, []byte("theirs\n"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := os.Symlink(escape, filepath.Join(to, "plain.txt")); err != nil {
		t.Fatalf("seed: %v", err)
	}

	ops := NewTreeOperations(NewPathScope(root, nil))
	if _, err := ops.Execute(context.Background(), "copy", map[string]any{
		"from": from, "to": to,
	}); err != nil {
		t.Fatalf("copy: %v", err)
	}

	if _, err := os.Stat(filepath.Join(outside, "file.txt")); !os.IsNotExist(err) {
		t.Fatalf("the copy went through a symlinked directory and landed outside the tree: %v", err)
	}
	if content, err := os.ReadFile(escape); err != nil || string(content) != "theirs\n" {
		t.Fatalf("the copy wrote through a symlinked file, got %q (%v)", content, err)
	}
	landed := filepath.Join(to, "nested", "file.txt")
	if info, err := os.Lstat(filepath.Join(to, "nested")); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("the destination directory is not a real directory of its own: %v", err)
	}
	if content, err := os.ReadFile(landed); err != nil || string(content) != "mine\n" {
		t.Fatalf("the file did not arrive inside the destination, got %q (%v)", content, err)
	}
}

// TestCopyTreeRefusesToDeleteTheDestinationItself asserts that a deletion names
// something IN the destination. "." and "" resolve to the destination root, and
// a caller that reaches the root reaches every tree it stands for: a workspace
// conversation's scope holds the project, so one blank string in a delete list
// is the whole project gone.
func TestCopyTreeRefusesToDeleteTheDestinationItself(t *testing.T) {
	for _, rel := range []string{".", "", "./", "sandboxes/.."} {
		root := t.TempDir()
		seedTree(t, root)

		ops := NewTreeOperations(NewPathScope(root, nil))
		if _, err := ops.Execute(context.Background(), "copy", map[string]any{
			"to":     ".",
			"delete": []any{rel},
		}); err == nil {
			t.Errorf("a deletion of %q (the destination itself) was allowed", rel)
		}
		if _, err := os.Stat(root); err != nil {
			t.Fatalf("deleting %q took the destination root with it: %v", rel, err)
		}
	}
}

// TestCopyTreeRefusesToEscape asserts that both ends are contained. These
// operations are not gated by the approval flow that stands behind an ordinary
// write, so the scope is the only thing between a caller and the rest of the
// disk.
func TestCopyTreeRefusesToEscape(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "project")
	seedTree(t, inside)

	ops := NewTreeOperations(NewPathScope(inside, nil))
	if _, err := ops.Execute(context.Background(), "copy", map[string]any{
		"from": ".",
		"to":   "../elsewhere",
	}); err == nil {
		t.Fatal("a copy to a directory outside the scope was allowed")
	}
	if _, err := ops.Execute(context.Background(), "copy", map[string]any{
		"from": "..",
		"to":   "copy",
	}); err == nil {
		t.Fatal("a copy from a directory outside the scope was allowed")
	}
	if _, err := ops.Execute(context.Background(), "copy", map[string]any{
		"from":   ".",
		"to":     "copy",
		"delete": []any{"../../escape.txt"},
	}); err == nil {
		t.Fatal("a deletion outside the destination was allowed")
	}
}

// TestCompareTreesReportsEachKindOfChange asserts the three lists a sandbox is
// read through, and that a fresh copy reports nothing at all — which is the
// answer the setup panel asks for speculatively and must not be slow or wrong.
func TestCompareTreesReportsEachKindOfChange(t *testing.T) {
	root := t.TempDir()
	from := filepath.Join(root, "project")
	to := filepath.Join(root, "copy")
	seedTree(t, from)

	ops := NewTreeOperations(NewPathScope(root, nil))
	if _, err := ops.Execute(context.Background(), "copy", map[string]any{"from": from, "to": to}); err != nil {
		t.Fatalf("copy: %v", err)
	}

	compare := func() map[string]any {
		t.Helper()
		result, err := ops.Execute(context.Background(), "compare", map[string]any{"left": from, "right": to})
		if err != nil {
			t.Fatalf("compare: %v", err)
		}
		return result.(map[string]any)
	}
	lists := compare()
	for _, key := range []string{"changed", "added", "removed"} {
		if got := lists[key].([]string); len(got) != 0 {
			t.Fatalf("a fresh copy reported %s = %v", key, got)
		}
	}

	if err := os.WriteFile(filepath.Join(to, "main.go"), []byte("package main // edited\n"), 0o644); err != nil {
		t.Fatalf("edit: %v", err)
	}
	if err := os.WriteFile(filepath.Join(to, "extra.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatalf("add: %v", err)
	}
	if err := os.Remove(filepath.Join(to, "src", "util.go")); err != nil {
		t.Fatalf("remove: %v", err)
	}
	// Ignored in the copy as well as in the original: work done in a sandbox is
	// the source it changed, not the build output it produced along the way.
	if err := os.WriteFile(filepath.Join(to, "noise.log"), []byte("chatter chatter\n"), 0o644); err != nil {
		t.Fatalf("noise: %v", err)
	}

	lists = compare()
	if got := lists["changed"].([]string); !slices.Equal(got, []string{"main.go"}) {
		t.Fatalf("changed = %v, want [main.go]", got)
	}
	if got := lists["added"].([]string); !slices.Equal(got, []string{"extra.go"}) {
		t.Fatalf("added = %v, want [extra.go]", got)
	}
	if got := lists["removed"].([]string); !slices.Equal(got, []string{"src/util.go"}) {
		t.Fatalf("removed = %v, want [src/util.go]", got)
	}
}

// TestCompareTreesRestrictedToNamedPaths asserts a comparison can be asked
// about a few files rather than about two whole trees. It is what lets one end
// hold only the files a carry is bringing: against the whole of the other tree
// every file it does not hold would read as added, which is both a wrong answer
// and a long one.
func TestCompareTreesRestrictedToNamedPaths(t *testing.T) {
	root := t.TempDir()
	left := filepath.Join(root, "left")
	right := filepath.Join(root, "right")
	seedTree(t, left)
	seedTree(t, right)

	if err := os.WriteFile(filepath.Join(right, "main.go"), []byte("package main // asked about\n"), 0o644); err != nil {
		t.Fatalf("edit: %v", err)
	}
	if err := os.WriteFile(filepath.Join(right, "src", "util.go"), []byte("package src // not asked about\n"), 0o644); err != nil {
		t.Fatalf("edit: %v", err)
	}

	ops := NewTreeOperations(NewPathScope(root, nil))
	result, err := ops.Execute(context.Background(), "compare", map[string]any{
		"left":  left,
		"right": right,
		"paths": []any{"main.go", "gone.go"},
	})
	if err != nil {
		t.Fatalf("compare: %v", err)
	}
	lists := result.(map[string]any)
	if got := lists["changed"].([]string); !slices.Equal(got, []string{"main.go"}) {
		t.Fatalf("changed = %v, want [main.go]", got)
	}
	// A path neither tree holds is not an error: a carry names what it means to
	// bring, and asking about a file that has gone from both is how a deletion
	// reads.
	for _, key := range []string{"added", "removed"} {
		if got := lists[key].([]string); len(got) != 0 {
			t.Fatalf("%s = %v, want nothing", key, got)
		}
	}
}

// TestCompareTreesReadsFilesTheTimesDisagreeAbout asserts the fast path is only
// a fast path: two files of the same size whose times differ are read, and
// answer by their contents rather than by their timestamps.
func TestCompareTreesReadsFilesTheTimesDisagreeAbout(t *testing.T) {
	root := t.TempDir()
	left := filepath.Join(root, "left")
	right := filepath.Join(root, "right")
	for _, dir := range []string{left, right} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	if err := os.WriteFile(filepath.Join(left, "same.txt"), []byte("identical"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(right, "same.txt"), []byte("identical"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	past := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(filepath.Join(right, "same.txt"), past, past); err != nil {
		t.Fatalf("chtimes: %v", err)
	}

	ops := NewTreeOperations(NewPathScope(root, nil))
	result, err := ops.Execute(context.Background(), "compare", map[string]any{"left": left, "right": right})
	if err != nil {
		t.Fatalf("compare: %v", err)
	}
	if got := result.(map[string]any)["changed"].([]string); len(got) != 0 {
		t.Fatalf("two identical files with different times reported %v", got)
	}
}

// TestCopyTreeCarriesSymlinks asserts a link is recreated as a link rather than
// followed into a second copy of what it points at.
func TestCopyTreeCarriesSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating a symlink on Windows needs a privilege the test machine may not have")
	}
	from := t.TempDir()
	to := filepath.Join(t.TempDir(), "copy")
	seedTree(t, from)
	if err := os.Symlink("main.go", filepath.Join(from, "link.go")); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	ops := NewTreeOperations(NewPathScope(filepath.Dir(from), nil))
	if _, err := ops.Execute(context.Background(), "copy", map[string]any{"from": from, "to": to}); err != nil {
		t.Fatalf("copy: %v", err)
	}
	target, err := os.Readlink(filepath.Join(to, "link.go"))
	if err != nil {
		t.Fatalf("the link was not copied as a link: %v", err)
	}
	if target != "main.go" {
		t.Fatalf("link points at %q, want main.go", target)
	}
}
