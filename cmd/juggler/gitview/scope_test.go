//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"strings"
	"testing"
)

// What can be typed is a small subset of git diff's own grammar, and every
// spelling in it has to come down to the comparison git would have made of it.
func TestParseScopeReadsWhatGitDiffWouldHave(t *testing.T) {
	for _, tc := range []struct {
		input string
		want  Scope
	}{
		{"", Scope{input: "@uncommitted", kind: ScopeWorktree}},
		{"  @uncommitted ", Scope{input: "@uncommitted", kind: ScopeWorktree}},
		{"@staged", Scope{input: "@staged", kind: ScopeIndex}},
		{"@unstaged", Scope{input: "@unstaged", kind: ScopeUnstaged}},
		{"@branch", Scope{input: "@branch", kind: ScopeWorktree, mergeBase: true, branch: true}},
		{"@last", Scope{input: "@last", kind: ScopeCommits, left: "HEAD^1", right: "HEAD", last: true}},
		{"HEAD", Scope{input: "HEAD", kind: ScopeWorktree, left: "HEAD"}},
		{"main", Scope{input: "main", kind: ScopeWorktree, left: "main"}},
		{"--merge-base  main", Scope{input: "--merge-base main", kind: ScopeWorktree, left: "main", mergeBase: true}},
		{"--cached", Scope{input: "--cached", kind: ScopeIndex}},
		{"--staged HEAD~2", Scope{input: "--staged HEAD~2", kind: ScopeIndex, left: "HEAD~2"}},
		{"--cached --merge-base main", Scope{input: "--cached --merge-base main", kind: ScopeIndex, left: "main", mergeBase: true}},
		{"--worktree", Scope{input: "--worktree", kind: ScopeUnstaged}},
		{"main..feature", Scope{input: "main..feature", kind: ScopeCommits, left: "main", right: "feature"}},
		{"main..", Scope{input: "main..", kind: ScopeCommits, left: "main"}},
		{"..feature", Scope{input: "..feature", kind: ScopeCommits, right: "feature"}},
		{"main...HEAD", Scope{input: "main...HEAD", kind: ScopeCommits, left: "main", right: "HEAD", mergeBase: true}},
		{"main...", Scope{input: "main...", kind: ScopeCommits, left: "main", mergeBase: true}},
		{"HEAD^1 HEAD", Scope{input: "HEAD^1 HEAD", kind: ScopeCommits, left: "HEAD^1", right: "HEAD"}},
		{"--merge-base main feature", Scope{input: "--merge-base main feature", kind: ScopeCommits, left: "main", right: "feature", mergeBase: true}},
		{"@{u}", Scope{input: "@{u}", kind: ScopeWorktree, left: "@{u}"}},
	} {
		t.Run(tc.input, func(t *testing.T) {
			got, err := ParseScope(tc.input)
			if err != nil {
				t.Fatalf("ParseScope(%q): %v", tc.input, err)
			}
			if got != tc.want {
				t.Errorf("ParseScope(%q) = %+v, want %+v", tc.input, got, tc.want)
			}
		})
	}
}

// A scope reaches git, so anything in it that git would read as an option, or
// that is not a revision at all, is refused here as the asker's mistake.
func TestParseScopeRefusesWhatIsNotARevision(t *testing.T) {
	for _, input := range []string{
		"-p",
		"--output=/tmp/x",
		"--ext-diff",
		"--no-index a b",
		"main..-p",
		"-x...HEAD",
		"a b c",
		"--worktree HEAD",
		"--cached main..HEAD",
		"--cached a b",
		"--merge-base",
		"main\x00",
		"@nonsense",
		"a....b",
		strings.Repeat("a", scopeMaxLen+1),
	} {
		t.Run(input, func(t *testing.T) {
			_, err := ParseScope(input)
			if err == nil {
				t.Fatalf("ParseScope(%q) was accepted", input)
			}
			if !refused(err) {
				t.Errorf("ParseScope(%q) = %v, want a *RequestError", input, err)
			}
		})
	}
}

// Only the working tree against HEAD can be read off `git status`; every other
// scope has to be asked of a diff.
func TestScopeIsDefaultOnlyForTheWorkingTreeAgainstHEAD(t *testing.T) {
	for input, want := range map[string]bool{
		"": true, "@uncommitted": true, "HEAD": true,
		"@staged": false, "@unstaged": false, "@branch": false, "@last": false,
		"main": false, "--merge-base HEAD": false, "HEAD..HEAD": false,
	} {
		s, err := ParseScope(input)
		if err != nil {
			t.Fatalf("ParseScope(%q): %v", input, err)
		}
		if got := s.IsDefault(); got != want {
			t.Errorf("ParseScope(%q).IsDefault() = %v, want %v", input, got, want)
		}
	}
	if !(Scope{}).IsDefault() {
		t.Error("the zero Scope is not the default")
	}
}

// branchedProject is a repository with a main line and a feature branch off it,
// checked out on the branch: the shape a branch review is for.
func branchedProject(t *testing.T) (p *gitProject, mainID, forkID, featureID string) {
	t.Helper()
	p = newGitProject(t)
	p.write("base.txt", "base\n")
	p.commit("base")
	p.git("branch", "-M", "main")
	forkID = strings.TrimSpace(p.git("rev-parse", "HEAD"))

	p.git("checkout", "-qb", "feature")
	p.write("feature.txt", "feature\n")
	p.commit("feature")
	featureID = strings.TrimSpace(p.git("rev-parse", "HEAD"))

	p.git("checkout", "-q", "main")
	p.write("mainline.txt", "mainline\n")
	p.commit("mainline")
	mainID = strings.TrimSpace(p.git("rev-parse", "HEAD"))

	p.git("checkout", "-q", "feature")
	return p, mainID, forkID, featureID
}

// Each scope resolves to the ids git would have diffed for it, in the repository
// it is resolved against.
func TestResolveScopeFindsTheCommitsEitherSide(t *testing.T) {
	p, mainID, forkID, featureID := branchedProject(t)

	for _, tc := range []struct {
		input, base, target, baseName string
	}{
		{"main", mainID, "", ""},
		{"--merge-base main", forkID, "", ""},
		{"@branch", forkID, "", "main"},
		{"--cached main", mainID, "", ""},
		{"main..HEAD", mainID, featureID, ""},
		{"main...HEAD", forkID, featureID, ""},
		{"main...", forkID, featureID, ""},
		{"@last", forkID, featureID, ""},
		{"HEAD", "HEAD", "", ""},
		{"@staged", "HEAD", "", ""},
		{"@unstaged", "", "", ""},
	} {
		t.Run(tc.input, func(t *testing.T) {
			s, err := ParseScope(tc.input)
			if err != nil {
				t.Fatal(err)
			}
			r, err := resolveScope(t.Context(), p.dir, s, gitDiffPerCmd)
			if err != nil {
				t.Fatalf("resolveScope(%q): %v", tc.input, err)
			}
			if r.base != tc.base || r.target != tc.target || r.baseName != tc.baseName {
				t.Errorf("resolveScope(%q) = base %q target %q name %q, want base %q target %q name %q",
					tc.input, r.base, r.target, r.baseName, tc.base, tc.target, tc.baseName)
			}
		})
	}
}

// A revision the repository does not have is the asker's mistake and says which
// revision it was.
func TestResolveScopeNamesARevisionItCannotFind(t *testing.T) {
	p, _, _, _ := branchedProject(t)
	for _, input := range []string{"nosuch", "nosuch..HEAD", "--merge-base nosuch", "HEAD...nosuch"} {
		s, err := ParseScope(input)
		if err != nil {
			t.Fatal(err)
		}
		_, err = resolveScope(t.Context(), p.dir, s, gitDiffPerCmd)
		if !refused(err) || !strings.Contains(err.Error(), "nosuch") {
			t.Errorf("resolveScope(%q) = %v, want a refusal naming nosuch", input, err)
		}
	}
}

// A repository with no default branch under any of the usual names cannot be
// reviewed as a branch, and says so rather than picking something.
func TestResolveScopeBranchNeedsADefaultBranch(t *testing.T) {
	p := newGitProject(t)
	p.write("a.txt", "a\n")
	p.commit("init")
	p.git("branch", "-M", "trunk")
	s, _ := ParseScope("@branch")
	if _, err := resolveScope(t.Context(), p.dir, s, gitDiffPerCmd); !refused(err) {
		t.Errorf("resolveScope(@branch) = %v, want a refusal", err)
	}
}

// The last commit of a repository with only one is everything, against nothing.
func TestResolveScopeLastCommitOfARootCommitIsAgainstTheEmptyTree(t *testing.T) {
	p := newGitProject(t)
	p.write("a.txt", "a\n")
	p.commit("init")
	s, _ := ParseScope("@last")
	r, err := resolveScope(t.Context(), p.dir, s, gitDiffPerCmd)
	if err != nil {
		t.Fatal(err)
	}
	empty := strings.TrimSpace(p.git("hash-object", "-t", "tree", "/dev/null"))
	if r.base != empty {
		t.Errorf("base = %q, want the empty tree %q", r.base, empty)
	}
}

// A repository whose first commit has not been made has no HEAD to resolve, but
// still has a working tree to compare with the tree of nothing.
func TestResolveScopeUnbornRepositoryStillHasADefault(t *testing.T) {
	p := newGitProject(t)
	p.write("a.txt", "a\n")
	for _, input := range []string{"", "@staged"} {
		s, _ := ParseScope(input)
		r, err := resolveScope(t.Context(), p.dir, s, gitDiffPerCmd)
		if err != nil {
			t.Fatalf("resolveScope(%q): %v", input, err)
		}
		if r.base == "" || r.base == "HEAD" {
			t.Errorf("resolveScope(%q).base = %q, want the empty tree", input, r.base)
		}
	}
	s, _ := ParseScope("@last")
	if _, err := resolveScope(t.Context(), p.dir, s, gitDiffPerCmd); !refused(err) {
		t.Errorf("resolveScope(@last) on an unborn repository = %v, want a refusal", err)
	}
}
