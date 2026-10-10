//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"sort"
	"strings"
	"testing"
)

// scopedProject is a feature branch with a little of everything on top of it:
// base.txt changed and staged, feature.txt (added on the branch) changed and not
// staged, and new.txt that git has never been told about. main has moved on
// since the branch left it, by mainline.txt.
func scopedProject(t *testing.T) *gitProject {
	t.Helper()
	p, _, _, _ := branchedProject(t)
	p.write("base.txt", "base\nstaged\n")
	p.git("add", "base.txt")
	p.write("feature.txt", "feature\nunstaged\n")
	p.write("new.txt", "new\n")
	return p
}

// scopeReview reads the project's manifest within one scope.
func (p *gitProject) scopeReview(input string) Manifest {
	p.t.Helper()
	s, err := ParseScope(input)
	if err != nil {
		p.t.Fatalf("ParseScope(%q): %v", input, err)
	}
	return Review(p.t.Context(), p.root, s)
}

// scopeDiff reads one file's diff within one scope.
func (p *gitProject) scopeDiff(input, fileRel string) FileDiff {
	p.t.Helper()
	resp, err := Diff(p.t.Context(), p.root, DiffRequest{Repo: p.rel, Path: fileRel, Scope: input})
	if err != nil {
		p.t.Fatalf("diff %q in scope %q: %v", fileRel, input, err)
	}
	return resp
}

// fileCodes renders a repository's files as "path:XY", sorted, which is how a
// failure reads as the list it is.
func fileCodes(repo gitReviewRepo) string {
	codes := make([]string, 0, len(repo.Files))
	for _, file := range repo.Files {
		codes = append(codes, file.Path+":"+file.Index+file.Worktree)
	}
	sort.Strings(codes)
	return strings.Join(codes, " ")
}

// Each scope lists exactly the files its comparison covers, lettered on the
// side of the two-letter code that comparison changes.
func TestGitReviewListsWhatTheScopeCompares(t *testing.T) {
	p := scopedProject(t)
	for _, tc := range []struct{ scope, want string }{
		{"", "base.txt:M. feature.txt:.M new.txt:.?"},
		{"@staged", "base.txt:M."},
		{"--cached main", "base.txt:M. feature.txt:A. mainline.txt:D."},
		{"@unstaged", "feature.txt:.M new.txt:.?"},
		{"@branch", "base.txt:.M feature.txt:.A new.txt:.?"},
		{"--merge-base main", "base.txt:.M feature.txt:.A new.txt:.?"},
		{"main...HEAD", "feature.txt:.A"},
		{"main..HEAD", "feature.txt:.A mainline.txt:.D"},
		{"@last", "feature.txt:.A"},
	} {
		t.Run(tc.scope, func(t *testing.T) {
			resp := p.scopeReview(tc.scope)
			repo := resp.repo(t, "")
			if repo.Error != "" || !resp.Complete {
				t.Fatalf("review in scope %q failed: %s %v", tc.scope, repo.Error, resp.Warnings)
			}
			if got := fileCodes(repo); got != tc.want {
				t.Errorf("files = %s\nwant    %s", got, tc.want)
			}
			if repo.Total != len(repo.Files) {
				t.Errorf("Total = %d for %d files", repo.Total, len(repo.Files))
			}
			if repo.Branch != "feature" {
				t.Errorf("Branch = %q: the branch is status's to report whatever the scope", repo.Branch)
			}
		})
	}
}

// The manifest says what it compared, and in what: the scope as asked, and the
// commits it came to in the repository.
func TestGitReviewReportsTheScopeItResolved(t *testing.T) {
	p := scopedProject(t)
	fork := strings.TrimSpace(p.git("merge-base", "main", "HEAD"))
	head := strings.TrimSpace(p.git("rev-parse", "HEAD"))

	resp := p.scopeReview("main...HEAD")
	if resp.Scope.Input != "main...HEAD" || resp.Scope.Kind != ScopeCommits {
		t.Errorf("Scope = %+v, want main...HEAD as commits", resp.Scope)
	}
	repo := resp.repo(t, "")
	if repo.Base != fork || repo.Target != head {
		t.Errorf("Base %q Target %q, want %q %q", repo.Base, repo.Target, fork, head)
	}

	if got := p.scopeReview("@branch").repo(t, ""); got.BaseName != "main" || got.Base != fork {
		t.Errorf("@branch resolved to %q (%s), want main (%s)", got.BaseName, got.Base, fork)
	}
	if got := p.scopeReview(""); got.Scope.Input != "@uncommitted" || got.repo(t, "").Base != "" {
		t.Errorf("default scope reported as %+v, base %q", got.Scope, got.repo(t, "").Base)
	}
}

// A revision one repository does not have leaves that repository listed,
// unreviewed and saying why, and the review incomplete.
func TestGitReviewNamesARepositoryTheScopeCannotResolveIn(t *testing.T) {
	p := scopedProject(t)
	resp := p.scopeReview("nosuch...HEAD")
	repo := resp.repo(t, "")
	if resp.Complete || repo.Complete || !strings.Contains(repo.Error, "nosuch") || len(repo.Files) != 0 {
		t.Errorf("review = complete %v, repo %+v; want it incomplete, naming nosuch, listing nothing", resp.Complete, repo)
	}
}

// A file's diff is taken from the same comparison its row was listed from.
func TestGitDiffFollowsTheScope(t *testing.T) {
	p := scopedProject(t)
	for _, tc := range []struct {
		scope, file, status string
		want, notWant       string
	}{
		{"", "feature.txt", "modified", "+unstaged\n", ""},
		{"main...HEAD", "feature.txt", "added", "+feature\n", "unstaged"},
		{"@branch", "feature.txt", "added", "+unstaged\n", ""},
		{"@staged", "base.txt", "modified", "+staged\n", ""},
		{"@staged", "feature.txt", "unchanged", "", "feature"},
		{"@unstaged", "feature.txt", "modified", "+unstaged\n", ""},
		{"@unstaged", "base.txt", "unchanged", "", "staged"},
		{"@unstaged", "new.txt", "untracked", "+new\n", ""},
		{"main...HEAD", "new.txt", "unchanged", "", "new"},
		{"main..HEAD", "mainline.txt", "deleted", "-mainline\n", ""},
		{"@last", "feature.txt", "added", "+feature\n", "unstaged"},
	} {
		t.Run(tc.scope+" "+tc.file, func(t *testing.T) {
			resp := p.scopeDiff(tc.scope, tc.file)
			got := lineText(resp)
			if resp.Status != tc.status {
				t.Errorf("Status = %q, want %q", resp.Status, tc.status)
			}
			if tc.want != "" && !strings.Contains(got, tc.want) {
				t.Errorf("diff lacks %q:\n%s", tc.want, got)
			}
			if tc.notWant != "" && strings.Contains(got, tc.notWant) {
				t.Errorf("diff shows %q, which this scope does not cover:\n%s", tc.notWant, got)
			}
		})
	}
}

// A scope that cannot be read, or that names what the repository does not
// have, is the asker's mistake.
func TestGitDiffRefusesAScopeItCannotUse(t *testing.T) {
	p := scopedProject(t)
	for _, scope := range []string{"--output=/tmp/x", "nosuch", "nosuch..HEAD"} {
		_, err := Diff(t.Context(), p.root, DiffRequest{Path: "base.txt", Scope: scope})
		if !refused(err) {
			t.Errorf("Diff in scope %q = %v, want a refusal", scope, err)
		}
	}
}

// Looking at a review in any scope is as much a read as looking at the default
// one.
func TestGitScopedReadsChangeNothingOnDisk(t *testing.T) {
	p := scopedProject(t)
	before := p.snapshot()
	for _, scope := range []string{"@staged", "@unstaged", "@branch", "main...HEAD", "@last", "--cached main"} {
		p.scopeReview(scope)
		p.scopeDiff(scope, "feature.txt")
		p.scopeDiff(scope, "base.txt")
	}
	after := p.snapshot()
	for path, was := range before {
		if now, present := after[path]; !present || now != was {
			t.Errorf("a scoped read changed %s", path)
		}
	}
	for path := range after {
		if _, present := before[path]; !present {
			t.Errorf("a scoped read created %s", path)
		}
	}
}

// A path is a path. Read as a pathspec, a file asked for as `*.txt` would be
// every text file's diff at once.
func TestGitDiffReadsAPathLiterally(t *testing.T) {
	p := newGitProject(t)
	p.write("a.txt", "a\n")
	p.write("b.txt", "b\n")
	p.commit("init")
	p.write("a.txt", "a\nA\n")
	p.write("b.txt", "b\nB\n")

	resp := p.diff("*.txt")
	if got := lineText(resp); got != "" || resp.Status != "unchanged" {
		t.Errorf("diff of a file named *.txt = %s %q, want nothing: there is no such file", resp.Status, got)
	}
}
