//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// sweep drops every session idle at now.
func (g *Graphs) sweep(now time.Time) {
	g.do(func() { g.dropIdle(now) })
}

// sessions is how many sessions the store holds.
func (g *Graphs) sessions() int {
	n := 0
	g.do(func() { n = len(g.byID) })
	return n
}

// loadedRows is how many rows the session id has read from git, or -1 for a
// session the store does not hold.
func (g *Graphs) loadedRows(id string) int {
	var s *graphSession
	g.do(func() { s = g.byID[id] })
	if s == nil {
		return -1
	}
	s.turn <- struct{}{}
	defer func() { <-s.turn }()
	return len(s.rows)
}

// importLinear appends n commits to branch in one fast-import, each touching
// file.txt, the first at unix second start and one second apart, and returns
// the branch's new tip. A spawn per commit would make a long history slow to
// build; fast-import makes thousands in one.
func importLinear(t *testing.T, p *gitProject, branch string, n int, start int64) string {
	t.Helper()
	var b strings.Builder
	parent := strings.TrimSpace(gitOrEmpty(p, "rev-parse", "--verify", "-q", "refs/heads/"+branch))
	for i := range n {
		fmt.Fprintf(&b, "commit refs/heads/%s\nmark :%d\ncommitter Imp Orter <imp@example.com> %d +0000\n", branch, i+1, start+int64(i))
		msg := fmt.Sprintf("%s %d", branch, i)
		fmt.Fprintf(&b, "data %d\n%s\n", len(msg), msg)
		if i == 0 && parent != "" {
			fmt.Fprintf(&b, "from %s\n", parent)
		}
		content := fmt.Sprintf("%s %d\n", branch, i)
		fmt.Fprintf(&b, "M 100644 inline file.txt\ndata %d\n%s\n", len(content), content)
	}
	cmd := exec.Command("git", "fast-import", "--quiet")
	cmd.Dir = p.dir
	cmd.Stdin = strings.NewReader(b.String())
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fast-import: %v\n%s", err, out)
	}
	return strings.TrimSpace(p.git("rev-parse", "refs/heads/"+branch))
}

// gitOrEmpty is git's answer, or "" when it refused.
func gitOrEmpty(p *gitProject, args ...string) string {
	cmd := exec.Command("git", args...)
	cmd.Dir = p.dir
	out, _ := cmd.Output()
	return string(out)
}

// commitAt commits everything with a fixed date, so where a commit falls in a
// date-ordered history is the test's choice.
func commitAt(t *testing.T, p *gitProject, message string, unix int64) string {
	t.Helper()
	p.git("add", "-A")
	cmd := exec.Command("git", "commit", "-q", "--allow-empty", "-m", message)
	cmd.Dir = p.dir
	date := fmt.Sprintf("%d +0000", unix)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("commit %s: %v\n%s", message, err, out)
	}
	return strings.TrimSpace(p.git("rev-parse", "HEAD"))
}

func newGraphs(t *testing.T) *Graphs {
	t.Helper()
	g := NewGraphs()
	t.Cleanup(g.Close)
	return g
}

func readLog(t *testing.T, g *Graphs, p *gitProject, q LogQuery) LogPage {
	t.Helper()
	page, err := g.Read(t.Context(), p.root, p.rel, q)
	if err != nil {
		t.Fatalf("Read(%+v): %v", q, err)
	}
	return page
}

// A long history opens on its first page having read little more than that
// page: what makes a hundred thousand commits open as fast as a hundred. The
// rest is read as it is asked for, and the last page knows it is the last.
func TestLogPaging(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	branch := strings.TrimSpace(p.git("symbolic-ref", "--short", "HEAD"))
	tip := importLinear(t, p, branch, 1200, 1_600_000_000)
	g := newGraphs(t)

	first := readLog(t, g, p, LogQuery{Limit: 200})
	if len(first.Rows) != 200 || first.Offset != 0 || !first.Graphed || !first.More {
		t.Fatalf("first page: %d rows at %d, graphed %v, more %v", len(first.Rows), first.Offset, first.Graphed, first.More)
	}
	if first.Rows[0].Sha != tip || first.Rows[0].Subject != branch+" 1199" || first.Rows[0].Author != "Imp Orter" ||
		first.Rows[0].Email != "imp@example.com" || first.Rows[0].Date != 1_600_000_000+1199 {
		t.Errorf("first row = %+v, want the tip %s", first.Rows[0], tip)
	}
	if len(first.Lanes) != 0 {
		t.Errorf("lanes entering the first row = %v, want none", first.Lanes)
	}
	if loaded := g.loadedRows(first.Graph); loaded > 400 {
		t.Errorf("the first page read %d rows of the history, want at most two pages", loaded)
	}

	last := readLog(t, g, p, LogQuery{Graph: first.Graph, Offset: 1100, Limit: 200})
	if last.Graph != first.Graph || last.Gen != first.Gen {
		t.Fatalf("a later page opened a new graph: %s/%d after %s/%d", last.Graph, last.Gen, first.Graph, first.Gen)
	}
	if len(last.Rows) != 100 || last.More || last.Total != 1200 {
		t.Errorf("last page: %d rows, more %v, total %d; want 100, false, 1200", len(last.Rows), last.More, last.Total)
	}
	if got := last.Rows[99].Parents; len(got) != 0 {
		t.Errorf("the root commit has parents %v", got)
	}
	if !slices.Equal(last.Lanes, []int{0}) {
		t.Errorf("lanes entering row 1100 = %v, want [0]", last.Lanes)
	}
}

// Every page carries the lanes entering its first row, and they are the lanes
// the rows above it leave behind: any page can be drawn on its own.
func TestLogPagesCarryTheirLanes(t *testing.T) {
	t.Parallel()
	p := branchyProject(t)
	g := newGraphs(t)
	whole := readLog(t, g, p, LogQuery{Scope: LogScopeAll, Limit: 500})
	if whole.More {
		t.Fatalf("the whole history did not fit one page: %d rows", len(whole.Rows))
	}
	occ := []int{}
	for offset := 0; offset < len(whole.Rows); offset += 3 {
		page := readLog(t, g, p, LogQuery{Graph: whole.Graph, Scope: LogScopeAll, Offset: offset, Limit: 3})
		if !slices.Equal(page.Lanes, occ) {
			t.Fatalf("page at %d enters with lanes %v, the rows above leave %v", offset, page.Lanes, occ)
		}
		for i, row := range page.Rows {
			want := whole.Rows[offset+i]
			if row.Sha != want.Sha || row.Lane != want.Lane || !slices.Equal(row.Out, want.Out) {
				t.Fatalf("row %d paged = %+v, whole = %+v", offset+i, row, want)
			}
			occ = advanceLanes(occ, row.Lane, row.Out)
		}
	}
}

// branchyProject is a repository with a merged topic, an unmerged one, a tag,
// a stash, a discarded save under refs/juggler, and a second worktree at a
// detached commit no ref reaches.
func branchyProject(t *testing.T) *gitProject {
	t.Helper()
	p := newGitProject(t)
	day := int64(1_700_000_000)
	p.write("a.txt", "1\n")
	commitAt(t, p, "one", day)
	p.write("a.txt", "2\n")
	commitAt(t, p, "two", day+10)
	p.git("switch", "-q", "-c", "topic")
	p.write("t.txt", "t\n")
	commitAt(t, p, "topic work", day+20)
	p.git("switch", "-q", "-")
	p.write("a.txt", "3\n")
	commitAt(t, p, "three", day+30)
	p.git("merge", "-q", "--no-ff", "-m", "merge topic", "topic")
	p.git("switch", "-q", "-c", "side", "HEAD~1")
	p.write("s.txt", "s\n")
	commitAt(t, p, "side work", day+50)
	p.git("tag", "v1")
	p.git("switch", "-q", "-")
	p.write("a.txt", "dirty\n")
	p.git("stash", "push", "-q", "-m", "stashed")
	saved := strings.TrimSpace(p.git("commit-tree", "-p", "HEAD", "-m", "a discarded save", "HEAD^{tree}"))
	p.git("update-ref", "refs/juggler/discarded", saved)

	wt := filepath.Join(t.TempDir(), "wt")
	p.git("worktree", "add", "-q", "--detach", wt, "HEAD")
	lost := &gitProject{t: t, root: wt, dir: wt}
	lost.write("l.txt", "l\n")
	commitAt(t, lost, "only in the detached tree", day+60)
	return p
}

func subjects(rows []LogRow) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = r.Subject
	}
	return out
}

// The current branch is what HEAD reaches. All refs is every branch, remote
// branch and tag, and the HEAD of every worktree — never a stash or the
// client's own saves. A ref is what that ref reaches.
func TestLogScopes(t *testing.T) {
	t.Parallel()
	p := branchyProject(t)
	g := newGraphs(t)

	// Which of the merge's two lines comes first is git's choice; that both
	// come between the merge and their fork is the topological order's.
	head := subjects(readLog(t, g, p, LogQuery{Limit: 100}).Rows)
	middle := slices.Clone(head[1:min(3, len(head))])
	slices.Sort(middle)
	if len(head) != 5 || head[0] != "merge topic" || !slices.Equal(middle, []string{"three", "topic work"}) ||
		head[3] != "two" || head[4] != "one" {
		t.Errorf("head scope = %q", head)
	}

	all := subjects(readLog(t, g, p, LogQuery{Scope: LogScopeAll, Limit: 100}).Rows)
	for _, want := range []string{"merge topic", "side work", "only in the detached tree", "topic work", "one"} {
		if !slices.Contains(all, want) {
			t.Errorf("all refs = %q, missing %q", all, want)
		}
	}
	if len(all) != 7 {
		t.Errorf("all refs = %q, want 7 commits and no stash", all)
	}

	ref := subjects(readLog(t, g, p, LogQuery{Scope: LogScopeRef, Ref: "side", Limit: 100}).Rows)
	if want := []string{"side work", "three", "two", "one"}; !slices.Equal(ref, want) {
		t.Errorf("ref scope = %q, want %q", ref, want)
	}

	if _, err := g.Read(t.Context(), p.root, "", LogQuery{Scope: LogScopeRef, Ref: "nosuch", Limit: 10}); !refused(err) {
		t.Errorf("an unknown ref = %v, want a refusal", err)
	}
	if _, err := g.Read(t.Context(), p.root, "", LogQuery{Scope: LogScopeRef, Ref: "--all", Limit: 10}); !refused(err) {
		t.Errorf("a ref that is an option = %v, want a refusal", err)
	}
}

// A filter lists the commits that match it, flat: what is left of a graph
// once most of it is filtered away is not one worth drawing.
func TestLogFilters(t *testing.T) {
	t.Parallel()
	p := branchyProject(t)
	g := newGraphs(t)
	for _, tc := range []struct {
		q    LogQuery
		want []string
	}{
		{LogQuery{Scope: LogScopeAll, Message: "WORK"}, []string{"side work", "topic work"}},
		{LogQuery{Scope: LogScopeAll, Message: "t*"}, []string{}},
		{LogQuery{Path: "t.txt"}, []string{"topic work"}},
		{LogQuery{Author: "nobody"}, []string{}},
		{LogQuery{Author: "juggler test", Message: "three"}, []string{"three"}},
	} {
		tc.q.Limit = 100
		page := readLog(t, g, p, tc.q)
		got := subjects(page.Rows)
		slices.Sort(got)
		if !slices.Equal(got, tc.want) || page.Graphed {
			t.Errorf("%+v = %q graphed %v, want %q flat", tc.q, got, page.Graphed, tc.want)
		}
		for _, row := range page.Rows {
			if row.Lane != 0 || len(row.Out) != 0 {
				t.Errorf("%+v: a filtered row has lanes: %+v", tc.q, row)
			}
		}
	}
}

// A message filter that is four or more hex digits also lists the commits
// whose hash starts with it, beside those whose message holds it — a hash is
// often quoted in a message. Author and path still narrow both; a shorter hex
// word is matched against messages only.
func TestLogFilterMatchesAHashPrefix(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	day := int64(1_700_000_000)
	p.write("a.txt", "1\n")
	one := commitAt(t, p, "one", day)
	p.write("a.txt", "2\n")
	commitAt(t, p, "two", day+10)
	p.write("b.txt", "b\n")
	commitAt(t, p, "Reverts "+one[:8]+"\n\nThe body names "+one[:8]+" too.", day+20)
	p.write("a.txt", "3\n")
	commitAt(t, p, "Body only\n\nSee "+strings.ToUpper(one[:6])+".", day+30)
	g := newGraphs(t)
	for _, tc := range []struct {
		q    LogQuery
		want []string
	}{
		{LogQuery{Message: one[:8]}, []string{"Reverts " + one[:8], "one"}},
		{LogQuery{Message: strings.ToUpper(one[:5])}, []string{"Body only", "Reverts " + one[:8], "one"}},
		{LogQuery{Message: one}, []string{"one"}},
		// Three digits are a word, not a hash: "one" itself is not listed.
		{LogQuery{Message: one[:3]}, []string{"Body only", "Reverts " + one[:8]}},
		{LogQuery{Message: one[:8], Path: "b.txt"}, []string{"Reverts " + one[:8]}},
		{LogQuery{Message: one[:8], Author: "nobody"}, []string{}},
	} {
		tc.q.Limit = 100
		page := readLog(t, g, p, tc.q)
		got := subjects(page.Rows)
		slices.Sort(got)
		slices.Sort(tc.want)
		if !slices.Equal(got, tc.want) || page.Graphed || page.More || page.Total != len(tc.want) {
			t.Errorf("%+v = %q graphed %v more %v total %d, want %q flat and complete", tc.q, got, page.Graphed, page.More, page.Total, tc.want)
		}
	}
}

// A path filter is a file's history: it follows the file back across a rename.
func TestLogFollowsAFileAcrossARename(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	day := int64(1_700_000_000)
	p.write("old.txt", "one\ntwo\nthree\nfour\n")
	commitAt(t, p, "adds old", day)
	p.write("other.txt", "x\n")
	commitAt(t, p, "adds other", day+10)
	p.git("mv", "old.txt", "new.txt")
	commitAt(t, p, "renames it", day+20)
	p.write("new.txt", "one\ntwo\nthree\nfour\nfive\n")
	commitAt(t, p, "grows it", day+30)

	g := newGraphs(t)
	page := readLog(t, g, p, LogQuery{Path: "new.txt", Limit: 100})
	if got, want := subjects(page.Rows), []string{"grows it", "renames it", "adds old"}; !slices.Equal(got, want) {
		t.Errorf("history of new.txt = %q, want %q", got, want)
	}
	if page.More || page.Total != 3 {
		t.Errorf("more %v total %d, want the whole history counted once read", page.More, page.Total)
	}
}

// The reflog scope is where the viewed tree's HEAD has been, newest first: each
// commit once, by the latest entry that names it, with git's words for the
// entry and its time.
func TestLogReflog(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	day := int64(1_700_000_000)
	p.write("a.txt", "1\n")
	one := commitAt(t, p, "one", day)
	p.write("a.txt", "2\n")
	two := commitAt(t, p, "two", day+10)
	p.git("reset", "-q", "--hard", "HEAD~1")

	g := newGraphs(t)
	page := readLog(t, g, p, LogQuery{Scope: LogScopeReflog, Limit: 100})
	if len(page.Rows) != 2 || page.Graphed {
		t.Fatalf("reflog = %+v, want two flat rows", page.Rows)
	}
	top, next := page.Rows[0], page.Rows[1]
	if top.Sha != one || !strings.HasPrefix(top.Reflog, "reset: moving to") || top.Subject != "one" {
		t.Errorf("newest entry = %+v, want the reset back to one", top)
	}
	if next.Sha != two || next.Reflog != "commit: two" {
		t.Errorf("next entry = %+v, want the commit of two", next)
	}
	if top.Date < day+10 {
		t.Errorf("the reset's date %d is not the entry's time", top.Date)
	}

	// A move is read again from the top.
	p.write("a.txt", "3\n")
	three := commitAt(t, p, "three", day+40)
	page = readLog(t, g, p, LogQuery{Graph: page.Graph, Scope: LogScopeReflog, Limit: 100, Refresh: true})
	if len(page.Rows) != 3 || page.Rows[0].Sha != three || page.Rows[0].Reflog != "commit: three" {
		t.Errorf("after a commit = %+v", page.Rows)
	}
}

// A ref that moves extends the graph rather than reading it again: new commits
// arrive on top, a commit nothing reaches any more leaves, the generation
// says the rows moved, and the row the reader was looking at is found again.
func TestLogRefresh(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	day := int64(1_700_000_000)
	for i := range 5 {
		p.write("a.txt", fmt.Sprint(i))
		commitAt(t, p, fmt.Sprintf("c%d", i), day+int64(i))
	}
	g := newGraphs(t)
	first := readLog(t, g, p, LogQuery{Limit: 2})
	top := first.Rows[0].Sha

	same := readLog(t, g, p, LogQuery{Graph: first.Graph, Refresh: true, Find: top, Limit: 2})
	if same.Gen != first.Gen || same.Found != 0 {
		t.Errorf("a refresh with nothing moved: gen %d found %d, want %d and 0", same.Gen, same.Found, first.Gen)
	}

	p.write("a.txt", "new")
	added := commitAt(t, p, "c5", day+5)
	grown := readLog(t, g, p, LogQuery{Graph: first.Graph, Refresh: true, Find: top, Limit: 10})
	if grown.Graph != first.Graph || grown.Gen != first.Gen+1 {
		t.Fatalf("after a commit: graph %s gen %d, want %s gen %d", grown.Graph, grown.Gen, first.Graph, first.Gen+1)
	}
	if got := subjects(grown.Rows); !slices.Equal(got, []string{"c5", "c4", "c3", "c2", "c1", "c0"}) || grown.Rows[0].Sha != added {
		t.Errorf("after a commit = %q", got)
	}
	if grown.Found != 1 || grown.Total != 6 {
		t.Errorf("after a commit: found %d total %d, want 1 and 6", grown.Found, grown.Total)
	}

	p.git("reset", "-q", "--hard", "HEAD~2")
	shrunk := readLog(t, g, p, LogQuery{Graph: first.Graph, Refresh: true, Find: top, Limit: 10})
	if got := subjects(shrunk.Rows); shrunk.Gen != grown.Gen+1 || !slices.Equal(got, []string{"c3", "c2", "c1", "c0"}) {
		t.Errorf("after a reset: gen %d %q", shrunk.Gen, got)
	}
	if shrunk.Found != -1 || shrunk.Total != 4 {
		t.Errorf("after a reset: found %d total %d, want -1 (gone) and 4", shrunk.Found, shrunk.Total)
	}
}

// A commit nothing reaches any more leaves even when it was never read: the
// stream still running from before the ref moved does not bring it back.
func TestLogRefreshDropsCommitsNotYetRead(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	day := int64(1_700_000_000)
	p.write("a.txt", "0")
	commitAt(t, p, "base", day)
	p.git("switch", "-q", "-c", "old")
	p.write("o.txt", "o")
	commitAt(t, p, "old work", day+1)
	p.git("switch", "-q", "-")
	for i := range 6 {
		p.write("a.txt", fmt.Sprint(i))
		commitAt(t, p, fmt.Sprintf("m%d", i), day+100+int64(i))
	}
	g := newGraphs(t)
	first := readLog(t, g, p, LogQuery{Scope: LogScopeAll, Limit: 1})
	if loaded := g.loadedRows(first.Graph); loaded >= 7 {
		t.Fatalf("the test needs old work unread, but %d rows were read", loaded)
	}
	p.git("branch", "-q", "-D", "old")
	readLog(t, g, p, LogQuery{Graph: first.Graph, Scope: LogScopeAll, Refresh: true, Limit: 1})
	rest := readLog(t, g, p, LogQuery{Graph: first.Graph, Scope: LogScopeAll, Limit: 100})
	if got := subjects(rest.Rows); slices.Contains(got, "old work") || len(got) != 7 {
		t.Errorf("after deleting old: %q", got)
	}
}

// A move too big to apply as a difference starts the graph again, under the
// same id and the next generation.
func TestLogRefreshRestartsAfterABigMove(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	branch := strings.TrimSpace(p.git("symbolic-ref", "--short", "HEAD"))
	importLinear(t, p, branch, 3, 1_600_000_000)
	g := newGraphs(t)
	g.deltaMax = 2
	first := readLog(t, g, p, LogQuery{Limit: 50})
	importLinear(t, p, branch, 3, 1_600_001_000)
	after := readLog(t, g, p, LogQuery{Graph: first.Graph, Refresh: true, Limit: 50})
	if after.Graph != first.Graph || after.Gen != first.Gen+1 || len(after.Rows) != 6 {
		t.Errorf("after a big move: graph %s gen %d rows %d", after.Graph, after.Gen, len(after.Rows))
	}
}

// An id the store no longer holds is not an error: the reader is given a new
// graph for the same question, and can tell from the id that it is new.
func TestLogEviction(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	p.write("a.txt", "a")
	p.commit("one")
	g := newGraphs(t)
	g.max = 2

	a := readLog(t, g, p, LogQuery{Limit: 10})
	b := readLog(t, g, p, LogQuery{Limit: 10})
	c := readLog(t, g, p, LogQuery{Limit: 10})
	if a.Graph == b.Graph || b.Graph == c.Graph {
		t.Fatalf("two reads without an id shared a graph")
	}
	if g.sessions() != 2 {
		t.Errorf("%d graphs held, want the most recent 2", g.sessions())
	}
	again := readLog(t, g, p, LogQuery{Graph: a.Graph, Limit: 10})
	if again.Graph == a.Graph || len(again.Rows) != 1 {
		t.Errorf("an evicted graph answered as itself: %+v", again)
	}

	g.sweep(time.Now().Add(graphIdle + time.Minute))
	if g.sessions() != 0 {
		t.Errorf("%d graphs outlived their idle time", g.sessions())
	}

	if _, err := g.Read(t.Context(), p.root, "", LogQuery{Scope: "sideways"}); !refused(err) {
		t.Errorf("an unknown scope = %v, want a refusal", err)
	}
}

// worktreeAt is where the working tree's row is in rows, or -1.
func worktreeAt(rows []LogRow) int {
	return slices.IndexFunc(rows, func(r LogRow) bool { return r.Worktree })
}

// The working tree's changes are a row of the graph, laid out as a child of
// HEAD and placed right above it — not at the top of the list, where commits
// HEAD has not caught up with (an upstream not pulled) would sit under it. A
// refresh moves it with HEAD, and takes it away or brings it back as asked.
func TestLogWorktreeRow(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	day := int64(1_700_000_000)
	for i := range 3 {
		p.write("a.txt", fmt.Sprint(i))
		commitAt(t, p, fmt.Sprintf("c%d", i), day+int64(i))
	}
	head := strings.TrimSpace(p.git("rev-parse", "HEAD"))
	// Two commits on top of HEAD that HEAD is not on: an upstream not pulled.
	p.git("switch", "-q", "-c", "upstream")
	for i := range 2 {
		p.write("a.txt", fmt.Sprint("u", i))
		commitAt(t, p, fmt.Sprintf("u%d", i), day+10+int64(i))
	}
	p.git("switch", "-q", "-")
	g := newGraphs(t)

	all := readLog(t, g, p, LogQuery{Scope: LogScopeAll, Worktree: true, Limit: 50})
	at := worktreeAt(all.Rows)
	if got := subjects(all.Rows); at != 2 || len(got) != 6 || all.Rows[3].Sha != head || all.Total != 6 {
		t.Fatalf("all refs = %q, the working tree at %d, total %d; want it at 2, above HEAD, total 6", got, at, all.Total)
	}
	wt, h := all.Rows[at], all.Rows[at+1]
	if wt.Sha != "" || !slices.Equal(wt.Parents, []string{head}) || !slices.Equal(wt.Out, []int{h.Lane}) {
		t.Errorf("the working tree's row = %+v, want no sha, HEAD its parent and its edge into HEAD's lane %d", wt, h.Lane)
	}
	if wt.Lane == h.Lane {
		t.Errorf("the working tree shares HEAD's lane %d with the upstream above it", h.Lane)
	}

	// On a line of its own with nothing above HEAD, it is HEAD's lane, at the top.
	mine := readLog(t, g, p, LogQuery{Worktree: true, Limit: 50})
	if at := worktreeAt(mine.Rows); at != 0 || mine.Rows[0].Lane != mine.Rows[1].Lane || mine.Total != 4 {
		t.Errorf("head scope: the working tree at %d, rows %+v, total %d", at, mine.Rows[:2], mine.Total)
	}
	if plain := readLog(t, g, p, LogQuery{Scope: LogScopeAll, Limit: 50}); worktreeAt(plain.Rows) >= 0 || plain.Total != 5 {
		t.Errorf("not asked for: the working tree at %d, total %d", worktreeAt(plain.Rows), plain.Total)
	}
	if filtered := readLog(t, g, p, LogQuery{Worktree: true, Message: "c", Limit: 50}); worktreeAt(filtered.Rows) >= 0 {
		t.Errorf("a filtered list has the working tree's row: %q", subjects(filtered.Rows))
	}

	// HEAD moves: the row moves with it, and the page still says where every lane is.
	p.write("a.txt", "next")
	next := commitAt(t, p, "c3", day+5)
	moved := readLog(t, g, p, LogQuery{Graph: all.Graph, Scope: LogScopeAll, Worktree: true, Refresh: true, Limit: 50})
	if at := worktreeAt(moved.Rows); moved.Gen != all.Gen+1 || at < 0 || at+1 >= len(moved.Rows) || moved.Rows[at+1].Sha != next ||
		len(moved.Rows) != 7 || moved.Total != 7 {
		t.Errorf("after a commit: gen %d, %q, the working tree at %d", moved.Gen, subjects(moved.Rows), at)
	}
	occ := []int{}
	for _, r := range moved.Rows {
		occ = advanceLanes(occ, r.Lane, r.Out)
	}
	if len(occ) != 0 {
		t.Errorf("lanes left open below the last row: %v", occ)
	}

	// Asked for no more, it goes; asked again, it is back.
	clean := readLog(t, g, p, LogQuery{Graph: all.Graph, Scope: LogScopeAll, Refresh: true, Limit: 50})
	if clean.Gen != moved.Gen+1 || worktreeAt(clean.Rows) >= 0 || len(clean.Rows) != 6 || clean.Total != 6 {
		t.Errorf("once clean: gen %d, %q, total %d", clean.Gen, subjects(clean.Rows), clean.Total)
	}
	dirty := readLog(t, g, p, LogQuery{Graph: all.Graph, Scope: LogScopeAll, Worktree: true, Refresh: true, Limit: 50})
	if dirty.Gen != clean.Gen+1 || worktreeAt(dirty.Rows) < 0 || dirty.Total != 7 {
		t.Errorf("dirty again: gen %d, %q, total %d", dirty.Gen, subjects(dirty.Rows), dirty.Total)
	}
	// A page read without a refresh leaves it as the session has it.
	if page := readLog(t, g, p, LogQuery{Graph: all.Graph, Scope: LogScopeAll, Limit: 50}); page.Gen != dirty.Gen || worktreeAt(page.Rows) < 0 {
		t.Errorf("a plain page read moved the working tree: gen %d, %q", page.Gen, subjects(page.Rows))
	}
}

// A repository with no commits yet still has the working tree's changes: they
// are the one row, the root of what is to come.
func TestLogWorktreeRowOfAnUnbornRepository(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	g := newGraphs(t)
	page := readLog(t, g, p, LogQuery{Worktree: true, Limit: 10})
	if len(page.Rows) != 1 || !page.Rows[0].Worktree || len(page.Rows[0].Parents) != 0 || page.Total != 1 {
		t.Errorf("unborn, with changes = %+v", page)
	}
}

// A repository with no commits has an empty history, not an error.
func TestLogOfAnUnbornRepository(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	g := newGraphs(t)
	page := readLog(t, g, p, LogQuery{Limit: 10})
	if len(page.Rows) != 0 || page.More || page.Total != 0 {
		t.Errorf("unborn = %+v", page)
	}
}
