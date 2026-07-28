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
	"time"
)

// TestMain starts the background-shell registry goroutine once for the package
// so tests that exercise background shells (startBackground / TaskState) have a
// live registry. Mirrors the goroutine RegisterAll() launches in production.
func TestMain(m *testing.M) {
	go runShellRegistry()
	os.Exit(m.Run())
}

// waitForOutput polls TaskState until its Output contains want or the deadline
// elapses. Returns the final snapshot. Polling a deterministic condition (vs a
// fixed sleep) keeps the test fast and race-free.
func waitForOutput(t *testing.T, id, want string, deadline time.Duration) TaskSnapshot {
	t.Helper()
	stop := time.After(deadline)
	for {
		s := TaskState(id)
		if strings.Contains(s.Output, want) {
			return s
		}
		select {
		case <-stop:
			t.Fatalf("timed out waiting for %q in output; got status=%q output=%q", want, s.Status, s.Output)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// TestStartBackground_PublishesOutputWhileRunning is the regression test for the
// incremental-publish fix: a background command must expose its output via
// ops.TaskState WHILE it is still running, not only after it exits. The command
// emits A, sleeps, emits B, then sleeps long enough that both substrings are
// observed (and B's status asserted to be "running") well before exit.
func TestStartBackground_PublishesOutputWhileRunning(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX-only shell command")
	}

	dir := t.TempDir()
	shellOps := NewShellOperations(NewPathScope(dir, nil))

	res, err := shellOps.startBackground(map[string]any{
		"command": "echo A; sleep 1; echo B; sleep 30",
	})
	if err != nil {
		t.Fatalf("startBackground failed: %v", err)
	}
	id, _ := res.(map[string]any)["task_id"].(string)
	if id == "" {
		t.Fatalf("startBackground returned no task_id: %+v", res)
	}
	// Ensure the long-running command can't outlive the test.
	defer KillTask(id)

	// A must appear while the command is still running (it sleeps 30s after B).
	sA := waitForOutput(t, id, "A", 5*time.Second)
	if sA.Status != "running" {
		t.Fatalf("expected status running when A observed, got %q", sA.Status)
	}

	// B appears after the 1s sleep — still long before the trailing 30s sleep.
	sB := waitForOutput(t, id, "B", 5*time.Second)
	if sB.Status != "running" {
		t.Fatalf("expected status running when B observed, got %q", sB.Status)
	}

	// Output is exactly the two emitted lines, in order, not doubled.
	if sB.Output != "A\nB\n" {
		t.Fatalf("expected output %q, got %q", "A\nB\n", sB.Output)
	}
}

// TestStartBackground_CompletedOutputNotDoubled verifies a fast-exiting command
// publishes its output exactly once (the incremental append + final status-only
// update must not double-write).
func TestStartBackground_CompletedOutputNotDoubled(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX-only shell command")
	}

	dir := t.TempDir()
	shellOps := NewShellOperations(NewPathScope(dir, nil))

	res, err := shellOps.startBackground(map[string]any{
		"command": "printf 'hello\\n'",
	})
	if err != nil {
		t.Fatalf("startBackground failed: %v", err)
	}
	id, _ := res.(map[string]any)["task_id"].(string)
	if id == "" {
		t.Fatalf("startBackground returned no task_id: %+v", res)
	}

	// Wait for completion.
	stop := time.After(5 * time.Second)
	for {
		s := TaskState(id)
		if s.Status == "completed" {
			if s.Output != "hello\n" {
				t.Fatalf("expected output %q (not doubled), got %q", "hello\n", s.Output)
			}
			if s.ExitCode != 0 {
				t.Fatalf("expected exit code 0, got %d", s.ExitCode)
			}
			break
		}
		select {
		case <-stop:
			t.Fatalf("timed out waiting for completion; status=%q output=%q", s.Status, s.Output)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// TestGetOutput_ReturnsDeltaNotCumulative is the regression test for the
// TaskOutput context-bloat fix: successive getOutput calls must each return only
// the output produced since the previous call (BashOutput semantics), never an
// ever-growing superset. A model that polls a running task must not re-ingest
// output it has already seen. Monitor's own delivery cursor (getState) is
// independent and unaffected — asserted by reading full state alongside.
func TestGetOutput_ReturnsDeltaNotCumulative(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX-only shell command")
	}

	dir := t.TempDir()
	shellOps := NewShellOperations(NewPathScope(dir, nil))

	res, err := shellOps.startBackground(map[string]any{
		"command": "echo A; sleep 1; echo B; sleep 30",
	})
	if err != nil {
		t.Fatalf("startBackground failed: %v", err)
	}
	id, _ := res.(map[string]any)["task_id"].(string)
	if id == "" {
		t.Fatalf("startBackground returned no task_id: %+v", res)
	}
	defer KillTask(id)

	// First delta read after A appears returns exactly "A\n".
	waitForOutput(t, id, "A", 5*time.Second)
	out1, err := shellOps.getOutputDelta(map[string]any{"task_id": id})
	if err != nil {
		t.Fatalf("getOutputDelta #1 failed: %v", err)
	}
	m1 := out1.(map[string]any)
	if m1["output"] != "A\n" {
		t.Fatalf("first delta: expected %q, got %q", "A\n", m1["output"])
	}
	if m1["outputIsNew"] != true {
		t.Fatalf("expected outputIsNew=true on delta read, got %v", m1["outputIsNew"])
	}

	// Second delta read before B is a no-op: the cursor already consumed "A\n".
	// The cumulative getOutput path must STILL return the full log — proving the
	// delta cursor is isolated and the Monitor live-output panel is unaffected.
	out2, err := shellOps.getOutputDelta(map[string]any{"task_id": id})
	if err != nil {
		t.Fatalf("getOutputDelta #2 failed: %v", err)
	}
	if got := out2.(map[string]any)["output"]; got != "" {
		t.Fatalf("second delta (no new output): expected %q, got %q", "", got)
	}
	cumul, err := shellOps.getOutput(map[string]any{"task_id": id})
	if err != nil {
		t.Fatalf("getOutput (cumulative) failed: %v", err)
	}
	if got := cumul.(map[string]any)["output"]; got != "A\n" {
		t.Fatalf("cumulative getOutput must still see the full log %q, got %q (delta must not consume it)", "A\n", got)
	}

	// Third delta read after B appears returns only the NEW line, not "A\nB\n".
	waitForOutput(t, id, "B", 5*time.Second)
	out3, err := shellOps.getOutputDelta(map[string]any{"task_id": id})
	if err != nil {
		t.Fatalf("getOutputDelta #3 failed: %v", err)
	}
	if got := out3.(map[string]any)["output"]; got != "B\n" {
		t.Fatalf("third delta: expected %q (delta only), got %q", "B\n", got)
	}
}

// TestNormalizeCommandNewlines pins the three distinct multi-line shapes the
// model sends. (1) A command-per-line list — several independent commands
// separated by bare newlines — is deliberately joined with " && " for fail-fast
// display/semantics. (2) A SINGLE multi-line command whose newlines live inside
// a quote, backtick, here-document, or a backslash continuation must survive
// verbatim: those newlines are data, not command separators. (3) A multi-line
// command containing comments or shell control-flow (for/if/case/functions,
// trailing pipes) must also survive verbatim — " && " cannot be spliced between
// those segments without producing broken shell. Cases (2) and (3) are the
// traps: a naive newline→" && " rewrite shreds them into broken fragments —
// squashing multi-line git commit messages and python -c scripts, and turning
// loops into `for f in a; && do`.
func TestNormalizeCommandNewlines(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		// --- case (1): genuine command-per-line lists still join with && ---
		{
			name: "single line unchanged",
			in:   "echo hello",
			want: "echo hello",
		},
		{
			name: "command per line joined with &&",
			in:   "echo a\necho b\necho c",
			want: "echo a && echo b && echo c",
		},
		{
			name: "blank lines dropped",
			in:   "echo a\n\n\necho b",
			want: "echo a && echo b",
		},
		// --- case (2): a single multi-line command is preserved verbatim ---
		{
			name: "double-quoted multiline commit message preserved",
			in:   "git commit -m \"feat: add thing\n\n- bullet one\n- bullet two\"",
			want: "git commit -m \"feat: add thing\n\n- bullet one\n- bullet two\"",
		},
		{
			name: "single-quoted multiline python preserved",
			in:   "python3 -c 'import json\nprint(json.dumps({}))\n'",
			want: "python3 -c 'import json\nprint(json.dumps({}))\n'",
		},
		{
			name: "backtick substitution newline preserved",
			in:   "echo `date\nwhoami`",
			want: "echo `date\nwhoami`",
		},
		{
			name: "quoted newline preserved but top-level newline still joins",
			in:   "echo \"a\nb\"\necho done",
			want: "echo \"a\nb\" && echo done",
		},
		{
			name: "heredoc body preserved, trailing command still joins",
			in:   "cat <<EOF\nline1\nline2\nEOF\necho after",
			want: "cat <<EOF\nline1\nline2\nEOF && echo after",
		},
		{
			name: "here-string is not treated as a heredoc",
			in:   "grep x <<< \"$var\"\necho next",
			want: "grep x <<< \"$var\" && echo next",
		},
		{
			name: "backslash line continuation preserved",
			in:   "echo one \\\ntwo",
			want: "echo one \\\ntwo",
		},
		// --- case (3): comments and shell control-flow are left verbatim ---
		// " && " cannot be spliced between these segments without producing
		// broken shell, so the multi-line command passes through unchanged.
		{
			name: "comment lines between commands preserved verbatim",
			in:   "echo \"step 1\"\n# comment line\necho \"step 2\"",
			want: "echo \"step 1\"\n# comment line\necho \"step 2\"",
		},
		{
			name: "inline trailing comment preserved verbatim",
			in:   "echo hi # note\necho bye",
			want: "echo hi # note\necho bye",
		},
		{
			name: "for loop preserved verbatim",
			in:   "for f in a b c;\ndo\n  echo \"item: $f\"\ndone",
			want: "for f in a b c;\ndo\n  echo \"item: $f\"\ndone",
		},
		{
			name: "if block preserved verbatim",
			in:   "if true;\nthen\n  echo yes\nfi",
			want: "if true;\nthen\n  echo yes\nfi",
		},
		{
			name: "function definition preserved verbatim",
			in:   "myfunc() {\n  echo hi\n}\nmyfunc",
			want: "myfunc() {\n  echo hi\n}\nmyfunc",
		},
		{
			name: "case statement preserved verbatim",
			in:   "case $x in\n  a) echo match;;\n  *) echo other;;\nesac",
			want: "case $x in\n  a) echo match;;\n  *) echo other;;\nesac",
		},
		{
			name: "trailing pipe continuation preserved verbatim",
			in:   "curl -s url |\ntail -3",
			want: "curl -s url |\ntail -3",
		},
		{
			name: "background job then command preserved verbatim",
			in:   "sleep 10 &\necho next",
			want: "sleep 10 &\necho next",
		},
		{
			name: "hash inside quotes is not a comment, still joins",
			in:   "echo \"a # b\"\necho c",
			want: "echo \"a # b\" && echo c",
		},
		{
			// `echo a; && echo b` is a bash syntax error; verbatim runs fine.
			name: "trailing bare semicolon preserved verbatim",
			in:   "echo a;\necho b",
			want: "echo a;\necho b",
		},
		{
			// An escaped \; is find's -exec terminator, not a separator, so
			// `... \; && echo done` is valid and still joins.
			name: "escaped semicolon (find -exec) still joins",
			in:   "find . -maxdepth 0 -exec echo {} \\;\necho done",
			want: "find . -maxdepth 0 -exec echo {} \\; && echo done",
		},
		{
			name: "leading pipe continuation preserved verbatim",
			in:   "cat hostname\n| grep x",
			want: "cat hostname\n| grep x",
		},
		{
			name: "leading && continuation preserved verbatim",
			in:   "echo a\n&& echo b",
			want: "echo a\n&& echo b",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := normalizeCommandNewlines(tc.in); got != tc.want {
				t.Fatalf("normalizeCommandNewlines(%q) =\n  %q\nwant\n  %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestValidateCwd_SiblingDirectoryRejected guards against the missing-separator
// bug in the shell cwd prefix check: a sibling dir whose name happens to start
// with the project dir's name must not be accepted.
func TestValidateCwd_SiblingDirectoryRejected(t *testing.T) {
	tmp := t.TempDir()
	project := filepath.Join(tmp, "juggler")
	sibling := filepath.Join(tmp, "juggler-evil")
	subdir := filepath.Join(tmp, "jugglerXsecrets")

	cases := []struct {
		name string
		cwd  string
	}{
		{"sibling-with-suffix", sibling},
		{"sibling-no-separator", subdir},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := validateCwd(project, tc.cwd); err == nil {
				t.Fatalf("expected validateCwd(%q, %q) to reject sibling dir, got nil", project, tc.cwd)
			}
		})
	}
}

func TestValidateCwd_InsideProjectAccepted(t *testing.T) {
	tmp := t.TempDir()
	project := filepath.Join(tmp, "juggler")
	inside := filepath.Join(project, "sub")

	got, err := validateCwd(project, inside)
	if err != nil {
		t.Fatalf("expected validateCwd to accept inside path %q, got err: %v", inside, err)
	}
	want, _ := filepath.Abs(inside)
	if got != want {
		t.Fatalf("validateCwd returned %q, want %q", got, want)
	}
}

func TestValidateCwd_ProjectRootItselfAccepted(t *testing.T) {
	tmp := t.TempDir()
	project := filepath.Join(tmp, "juggler")

	got, err := validateCwd(project, project)
	if err != nil {
		t.Fatalf("expected validateCwd to accept project root, got err: %v", err)
	}
	want, _ := filepath.Abs(project)
	if got != want {
		t.Fatalf("validateCwd returned %q, want %q", got, want)
	}
}

func TestValidateCwd_EmptyReturnsWorkingDir(t *testing.T) {
	tmp := t.TempDir()
	project := filepath.Join(tmp, "juggler")

	got, err := validateCwd(project, "")
	if err != nil {
		t.Fatalf("expected validateCwd to accept empty cwd, got err: %v", err)
	}
	if got != project {
		t.Fatalf("validateCwd returned %q, want %q", got, project)
	}
}
