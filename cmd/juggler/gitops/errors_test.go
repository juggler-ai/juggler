//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"juggler/cmd/juggler/gitcmd"
)

// A push refused for unpushed submodule commits: git wraps its reason over
// several lines, so its first line stops mid-sentence.
const submodulePushRefusal = "Enumerating objects: 5, done.\rCounting objects: 100% (5/5), done.\n" +
	"The following submodule paths contain changes that can\n" +
	"not be found on any remote:\n" +
	"  juggler\n" +
	"\n" +
	"Please try\n" +
	"\n" +
	"\tgit push --recurse-submodules=on-demand\n" +
	"\n" +
	"fatal: Aborting.\n"

func TestFailureTextIsGitsWholeComplaint(t *testing.T) {
	t.Parallel()
	failed := &gitcmd.Error{Args: []string{"push"}, Code: 128, Stderr: submodulePushRefusal, Output: submodulePushRefusal}
	want := "The following submodule paths contain changes that can\n" +
		"not be found on any remote:\n" +
		"  juggler\n" +
		"\n" +
		"Please try\n" +
		"\n" +
		"\tgit push --recurse-submodules=on-demand\n" +
		"\n" +
		"fatal: Aborting."
	if got := FailureText(failed); got != want {
		t.Errorf("FailureText = %q, want %q", got, want)
	}
	// Whatever a caller said around git's complaint is kept.
	if got := FailureText(fmt.Errorf("pushing juggler: %w", failed)); got != "pushing juggler: "+want {
		t.Errorf("FailureText of a wrapped failure = %q", got)
	}
	// An error that is not git's says what it says.
	if got := FailureText(errors.New("no remote")); got != "no remote" {
		t.Errorf("FailureText of a plain error = %q", got)
	}
}

func TestFailureTextKeepsTheEndOfALongComplaint(t *testing.T) {
	t.Parallel()
	var hook strings.Builder
	for i := range 200 {
		fmt.Fprintf(&hook, "remote: test %d failed\n", i)
	}
	got := FailureText(&gitcmd.Error{Args: []string{"push"}, Code: 1, Stderr: hook.String()})
	lines := strings.Split(got, "\n")
	if len(lines) != failureLines+1 || lines[0] != "…" || lines[len(lines)-1] != "remote: test 199 failed" {
		t.Errorf("FailureText of 200 lines = %d lines, from %q to %q", len(lines), lines[0], lines[len(lines)-1])
	}
}
