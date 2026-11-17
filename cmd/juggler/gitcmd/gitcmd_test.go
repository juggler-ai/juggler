//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitcmd

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

// TestMain keeps the user's git configuration out of every repository here.
func TestMain(m *testing.M) {
	home, err := os.MkdirTemp("", "gitcmd-home-*")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	for k, v := range map[string]string{"GIT_CONFIG_NOSYSTEM": "1", "HOME": home, "XDG_CONFIG_HOME": filepath.Join(home, ".config")} {
		if err := os.Setenv(k, v); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	code := m.Run()
	_ = os.RemoveAll(home)
	os.Exit(code)
}

// newRepo makes a repository with one commit, an identity, no housekeeping.
func newRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git is not installed here: %v", err)
	}
	dir := t.TempDir()
	run(t, dir, "init", "-q")
	run(t, dir, "config", "user.email", "test@example.com")
	run(t, dir, "config", "user.name", "Juggler Test")
	run(t, dir, "config", "commit.gpgsign", "false")
	run(t, dir, "config", "maintenance.auto", "false")
	run(t, dir, "config", "gc.auto", "0")
	writeFile(t, filepath.Join(dir, "a.txt"), "one\n")
	run(t, dir, "add", "a.txt")
	run(t, dir, "commit", "-q", "-m", "first")
	return dir
}

func run(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return string(out)
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// hook installs an executable hook script.
func hook(t *testing.T, dir, name, script string) {
	t.Helper()
	path := filepath.Join(dir, ".git", "hooks", name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o700); err != nil { //nolint:gosec // a hook must be executable
		t.Fatal(err)
	}
}

// A read and a write differ only in whether git may take its optional locks.
func TestCommandModes(t *testing.T) {
	t.Parallel()
	read := Command(t.Context(), "/x", Read, "status").Args
	write := Command(t.Context(), "/x", Write, "status").Args
	for _, args := range [][]string{read, write} {
		for _, want := range []string{"--literal-pathspecs", "core.quotePath=false", "diff.external="} {
			if !slices.Contains(args, want) {
				t.Errorf("%v lacks %s", args, want)
			}
		}
		if args[len(args)-1] != "status" {
			t.Errorf("%v: the verb is not last", args)
		}
	}
	if !slices.Contains(read, "--no-optional-locks") {
		t.Errorf("a read must not take optional locks: %v", read)
	}
	if slices.Contains(write, "--no-optional-locks") {
		t.Errorf("a write takes the locks it needs: %v", write)
	}
}

// A write's stdin reaches git and its stdout comes back whole.
func TestExecStdinAndStdout(t *testing.T) {
	t.Parallel()
	dir := newRepo(t)
	res, err := Exec(t.Context(), Request{Dir: dir, Args: []string{"hash-object", "-w", "--stdin"}, Stdin: []byte("hello\n")})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(res.Stdout)); got != "ce013625030ba8dba906f756967f9e9ca394464a" {
		t.Errorf("stdout = %q", got)
	}
}

// A hook's complaint is the error, and every byte of it was streamed.
func TestExecFailureIsTheHooksComplaint(t *testing.T) {
	t.Parallel()
	if runtime.GOOS == "windows" {
		t.Skip("hooks here are sh scripts")
	}
	dir := newRepo(t)
	hook(t, dir, "pre-commit", "echo 'lint failed: a.txt'\necho 'second line' >&2\nexit 1\n")
	writeFile(t, filepath.Join(dir, "a.txt"), "two\n")
	run(t, dir, "add", "a.txt")

	var streamed strings.Builder
	_, err := Exec(t.Context(), Request{
		Dir: dir, Args: []string{"commit", "-F", "-"}, Stdin: []byte("msg\n"),
		OnOutput: func(b []byte) { streamed.Write(b) },
	})
	var failure *Error
	if !errors.As(err, &failure) {
		t.Fatalf("err = %v, want *Error", err)
	}
	if failure.Error() != "lint failed: a.txt" || failure.Code != 1 || failure.Cancelled {
		t.Errorf("failure = %q, code %d, cancelled %v", failure.Error(), failure.Code, failure.Cancelled)
	}
	for _, want := range []string{"lint failed: a.txt", "second line"} {
		if !strings.Contains(failure.Output, want) || !strings.Contains(streamed.String(), want) {
			t.Errorf("output %q / streamed %q lacks %q", failure.Output, streamed.String(), want)
		}
	}
}

// A server started from inside a git hook inherits GIT_DIR and GIT_INDEX_FILE;
// a write must still act on the repository it names.
func TestExecIgnoresInheritedRepository(t *testing.T) {
	dir := newRepo(t)
	other := newRepo(t)
	t.Setenv("GIT_DIR", filepath.Join(other, ".git"))
	t.Setenv("GIT_INDEX_FILE", filepath.Join(other, ".git", "index"))
	res, err := Exec(t.Context(), Request{Dir: dir, Args: []string{"rev-parse", "--git-dir"}})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(res.Stdout)); got != ".git" {
		t.Errorf("git dir = %q, want this repository's own", got)
	}
}

// Cancelling a commit while its hook runs interrupts git, which removes the
// index.lock it holds for the hook; a killed git would leave it behind.
func TestExecCancelLeavesNoIndexLock(t *testing.T) {
	t.Parallel()
	if runtime.GOOS == "windows" {
		t.Skip("there is no interrupt to send on Windows; the write is killed")
	}
	dir := newRepo(t)
	hook(t, dir, "pre-commit", "echo hook-started\nexec sleep 600\n")
	writeFile(t, filepath.Join(dir, "a.txt"), "two\n")
	run(t, dir, "add", "a.txt")

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	_, err := Exec(ctx, Request{
		Dir: dir, Args: []string{"commit", "-F", "-"}, Stdin: []byte("msg\n"),
		OnOutput: func(b []byte) {
			if strings.Contains(string(b), "hook-started") {
				cancel()
			}
		},
	})
	var failure *Error
	if !errors.As(err, &failure) || !failure.Cancelled {
		t.Fatalf("err = %v, want a cancelled *Error", err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".git", "index.lock")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("index.lock after a cancelled commit: %v", err)
	}
	if head := strings.TrimSpace(run(t, dir, "log", "-1", "--format=%s")); head != "first" {
		t.Errorf("HEAD is %q; the cancelled commit landed", head)
	}
}
