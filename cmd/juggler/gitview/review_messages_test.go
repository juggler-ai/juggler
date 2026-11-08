//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A scope's label reaches the client as a message as well as English, so the
// line above a review can be shown in the viewer's language — except a commit
// range, which is labelled in git's notation and has nothing to translate.
func TestScopeInfoCarriesALabelMessage(t *testing.T) {
	cases := []struct {
		scope, key, label string
	}{
		{"@staged", "Staged against {revision}", "Staged against HEAD"},
		{"@branch", "Working tree against the merge-base with the default branch", "Working tree against the merge-base with the default branch"},
		{"@last", "Last commit against its parent", "Last commit against its parent"},
		{"@unstaged", "Working tree against the index", "Working tree against the index"},
		{"main", "Working tree against {revision}", "Working tree against main"},
		{"--merge-base main", "Working tree against the merge-base with {revision}", "Working tree against the merge-base with main"},
		{"--cached --merge-base main", "Staged against the merge-base with {revision}", "Staged against the merge-base with main"},
		{"main..feature", "", "main..feature"},
		{"main...feature", "", "main...feature"},
	}
	for _, tc := range cases {
		s, err := ParseScope(tc.scope)
		if err != nil {
			t.Fatalf("ParseScope(%q): %v", tc.scope, err)
		}
		info := s.Info()
		if info.Label != tc.label {
			t.Errorf("%q: Label = %q, want %q", tc.scope, info.Label, tc.label)
		}
		if tc.key == "" {
			if info.LabelMessage != nil {
				t.Errorf("%q: LabelMessage = %+v, want none for a range", tc.scope, *info.LabelMessage)
			}
			continue
		}
		if info.LabelMessage == nil {
			t.Errorf("%q: no LabelMessage", tc.scope)
			continue
		}
		if info.LabelMessage.Key != tc.key || info.LabelMessage.English() != info.Label {
			t.Errorf("%q: LabelMessage = %q → %q, want %q → %q", tc.scope, info.LabelMessage.Key, info.LabelMessage.English(), tc.key, info.Label)
		}
	}

	staged, _ := ParseScope("@staged")
	wire, err := json.Marshal(staged.Info())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(wire), `"labelMessage":{"key":"Staged against {revision}","params":{"revision":"HEAD"}}`) {
		t.Errorf("ScopeInfo JSON = %s, want a labelMessage", wire)
	}
}

// Every warning a review makes reaches the client as a message too, in step
// with the English, with what git said and the repository's path as data.
func TestGitReviewWarningsCarryMessages(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	p.write("root.txt", "root\n")
	p.commit("init")
	broken := filepath.Join(p.root, "libs", "broken")
	if err := os.MkdirAll(broken, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(broken, ".git"), []byte("gitdir: ../nowhere\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	resp := p.review()
	assertWarningMessages(t, resp)
	found := false
	for _, m := range resp.WarningMessages {
		if m.Key == "Couldn't read {where, select, root {the project repository} other {{repo}}}: {detail}" &&
			m.Params["repo"] == "libs/broken" && m.Params["where"] == "nested" {
			found = true
		}
	}
	if !found {
		t.Errorf("WarningMessages = %+v, want the unreadable repository's", resp.WarningMessages)
	}

	// The root repository has no path, and the warning words it.
	scope, err := ParseScope("no-such-revision")
	if err != nil {
		t.Fatal(err)
	}
	scoped := Review(t.Context(), p.root, scope)
	assertWarningMessages(t, scoped)
	found = false
	for i, m := range scoped.WarningMessages {
		if strings.HasPrefix(m.Key, "Couldn't compare ") && m.Params["where"] == "root" {
			found = true
			if !strings.HasPrefix(scoped.Warnings[i], "Couldn't compare the project repository: ") {
				t.Errorf("warning = %q, want the root repository worded", scoped.Warnings[i])
			}
		}
	}
	if !found {
		t.Errorf("WarningMessages = %+v, want the root repository's comparison failure", scoped.WarningMessages)
	}

	wire, err := json.Marshal(scoped)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(wire), `"warningMessages":[{"key":"Couldn't compare`) {
		t.Errorf("manifest JSON = %s, want warningMessages", wire)
	}
}

// assertWarningMessages checks the messages and the English are the same list.
func assertWarningMessages(t *testing.T, resp Manifest) {
	t.Helper()
	if len(resp.WarningMessages) != len(resp.Warnings) || len(resp.Warnings) == 0 {
		t.Fatalf("%d warnings, %d messages: %v / %+v", len(resp.Warnings), len(resp.WarningMessages), resp.Warnings, resp.WarningMessages)
	}
	for i, m := range resp.WarningMessages {
		if m.English() != resp.Warnings[i] {
			t.Errorf("warning %d: message renders %q, English is %q", i, m.English(), resp.Warnings[i])
		}
	}
}
