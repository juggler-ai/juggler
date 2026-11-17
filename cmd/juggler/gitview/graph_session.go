//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"time"

	"juggler/cmd/juggler/gitcmd"
	"juggler/cmd/juggler/gitview/internal/clocks"
)

// graphSession is one list a client is showing (see Graphs).
//
// ctx is the session's life: every git it starts runs under it, so ending the
// session ends them, from whichever goroutine ends it. Everything after turn
// is owned by the request holding turn.
type graphSession struct {
	id       string
	key      logKey
	deltaMax int
	ctx      context.Context
	end      context.CancelFunc
	turn     chan struct{}

	used time.Time // owned by the Graphs goroutine

	started     bool
	gen         int
	tips        []string
	rows        []LogRow
	index       map[string]int // sha → its row
	layout      *laneLayout
	checkpoints [][]int         // lanes entering row i*checkpointEvery
	removed     map[string]bool // commits the stream still brings that the scope no longer reaches
	stream      *logStream      // nil once read to its end
	streamErr   error
	total       int // -1 while counting
	count       *logCount
}

func newGraphSession(id string, key logKey, deltaMax int) *graphSession {
	ctx, end := context.WithCancel(context.Background())
	return &graphSession{id: id, key: key, deltaMax: deltaMax, ctx: ctx, end: end, turn: make(chan struct{}, 1), total: -1}
}

// start reads the scope's tips and starts the stream and the count.
func (s *graphSession) start(ctx context.Context) error {
	tips, err := s.readTips(ctx)
	if err != nil {
		return err
	}
	s.started = true
	s.restart(tips)
	s.gen = 0
	return nil
}

// restart begins the list again from tips, as the next generation.
func (s *graphSession) restart(tips []string) {
	if s.stream != nil {
		s.stream.stop()
	}
	if s.count != nil {
		s.count.stop()
	}
	s.tips = tips
	s.rows, s.index, s.removed = nil, map[string]int{}, map[string]bool{}
	s.layout, s.checkpoints = newLaneLayout(), nil
	s.stream, s.streamErr, s.count, s.total = nil, nil, nil, -1
	s.gen++
	if len(tips) == 0 {
		return
	}
	s.stream = startLogStream(s.ctx, s.key, tips, nil)
	s.count = startLogCount(s.ctx, s.key, tips)
}

// refresh catches up with refs that moved since the tips were read: see the
// package's account of History above Graphs.
func (s *graphSession) refresh(ctx context.Context) error {
	tips, err := s.readTips(ctx)
	if err != nil {
		return err
	}
	if slices.Equal(tips, s.tips) {
		return nil
	}
	if s.key.scope == LogScopeReflog {
		// An entry is added on top, but one can expire from anywhere: the
		// reflog is read again.
		s.restart(tips)
		return nil
	}
	gone, err := s.revList(ctx, s.tips, tips)
	if err != nil {
		return err
	}
	if len(gone) > s.deltaMax {
		s.restart(tips)
		return nil
	}
	added, err := s.readAdded(ctx, tips)
	if err != nil {
		return err
	}
	if len(added) > s.deltaMax || slices.ContainsFunc(added, func(r LogRow) bool { return s.removed[r.Sha] }) {
		// Too many to apply, or a commit coming back that the stream was
		// told to skip: where it belongs is no longer the top.
		s.restart(tips)
		return nil
	}

	kept := make([]LogRow, 0, len(added)+len(s.rows))
	kept = append(kept, added...)
	for _, r := range s.rows {
		if !gone[r.Sha] {
			kept = append(kept, r)
		}
	}
	for sha := range gone {
		s.removed[sha] = true
	}
	s.rows, s.tips = kept, tips
	s.relayout()
	// What left is counted unfiltered, so only a graph's total can be moved
	// by it; a filtered list is counted again.
	if s.total >= 0 && s.key.graphed() {
		s.total += len(added) - len(gone)
	} else {
		s.total = -1
		if s.count != nil {
			s.count.stop()
		}
		s.count = startLogCount(s.ctx, s.key, tips)
	}
	s.gen++
	return nil
}

// relayout lays every row the session holds out again, from the top.
func (s *graphSession) relayout() {
	s.layout, s.checkpoints = newLaneLayout(), nil
	s.index = make(map[string]int, len(s.rows))
	for i := range s.rows {
		s.place(i)
	}
}

// place lays out row i, the next row, and remembers where it is.
func (s *graphSession) place(i int) {
	r := &s.rows[i]
	s.index[r.Sha] = i
	if !s.key.graphed() {
		r.Lane, r.Out = 0, []int{}
		return
	}
	if i%checkpointEvery == 0 {
		s.checkpoints = append(s.checkpoints, s.layout.occupied())
	}
	r.Lane, r.Out = s.layout.place(r.Sha, r.Parents)
}

// readTo reads the stream until the session holds n rows or the history ends.
func (s *graphSession) readTo(ctx context.Context, n int) error {
	for len(s.rows) < n && s.stream != nil {
		if _, err := s.next(ctx); err != nil {
			return err
		}
	}
	return nil
}

// find is where sha is in the list, reading on until it is there or the
// history ends; -1 when the scope does not reach it.
func (s *graphSession) find(ctx context.Context, sha string) (int, error) {
	for {
		if i, ok := s.index[sha]; ok {
			return i, nil
		}
		if s.stream == nil {
			return -1, nil
		}
		if _, err := s.next(ctx); err != nil {
			return -1, err
		}
	}
}

// next reads one commit from the stream into the rows, skipping one the scope
// no longer reaches. At the end of the history it drops the stream, and
// reports git's failure if that is why it ended.
func (s *graphSession) next(ctx context.Context) (bool, error) {
	select {
	case r, ok := <-s.stream.rows:
		if !ok {
			<-s.stream.done
			s.streamErr = s.stream.err
			s.stream = nil
			if s.streamErr != nil && s.ctx.Err() == nil {
				return false, s.streamErr
			}
			return false, nil
		}
		if s.removed[r.Sha] {
			return true, nil
		}
		if _, dup := s.index[r.Sha]; dup {
			return true, nil
		}
		s.rows = append(s.rows, r)
		s.place(len(s.rows) - 1)
		return true, nil
	case <-ctx.Done():
		return false, ctx.Err()
	}
}

// page is limit rows from offset, with what a client needs to draw them.
func (s *graphSession) page(offset, limit int) LogPage {
	if s.count != nil {
		if n, ok := s.count.result(); ok {
			s.total, s.count = n, nil
		}
	}
	ended := s.stream == nil
	total := s.total
	if ended {
		total = len(s.rows)
	}
	start := min(offset, len(s.rows))
	end := min(offset+limit, len(s.rows))
	page := LogPage{
		Graph: s.id, Gen: s.gen, Offset: offset, Rows: slices.Clone(s.rows[start:end]),
		Lanes: []int{}, More: end < len(s.rows) || !ended, Total: total, Graphed: s.key.graphed(), Found: -1,
	}
	if page.Graphed && start < len(s.rows) {
		page.Lanes = s.lanesAt(start)
	}
	return page
}

// lanesAt is the lanes occupied entering row i: the nearest checkpoint above
// it, carried down the rows between.
func (s *graphSession) lanesAt(i int) []int {
	cp := min(i/checkpointEvery, len(s.checkpoints)-1)
	occ := slices.Clone(s.checkpoints[cp])
	for j := cp * checkpointEvery; j < i; j++ {
		occ = advanceLanes(occ, s.rows[j].Lane, s.rows[j].Out)
	}
	return occ
}

// readTips is the commits the scope starts from, sorted and unique: none for a
// repository with no commits yet.
func (s *graphSession) readTips(ctx context.Context) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, clocks.Review.Budget)
	defer cancel()
	var tips []string
	switch s.key.scope {
	case LogScopeReflog:
		// What the stream walks is HEAD's reflog, not these; they are what
		// tells a refresh it moved: HEAD and how many entries it has.
		head, ok, err := revParse(ctx, s.key.dir, "HEAD", clocks.Review.PerCmd)
		if err != nil || !ok {
			return nil, err
		}
		out, err := gitRead(ctx, s.key.dir, clocks.Review.PerCmd, 64, "rev-list", "--walk-reflogs", "--count", "HEAD", "--")
		if err != nil {
			return nil, err
		}
		return []string{head, "entries:" + strings.TrimSpace(string(out.Kept))}, nil
	case LogScopeRef:
		tip, err := resolveCommit(ctx, s.key.dir, s.key.ref, clocks.Review.PerCmd)
		if err != nil {
			return nil, err
		}
		tips = append(tips, tip)
	case LogScopeAll:
		out, err := gitRead(ctx, s.key.dir, clocks.Review.PerCmd, refsReadMax, "for-each-ref",
			"--format=%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)", "refs/heads", "refs/remotes", "refs/tags")
		if err != nil {
			return nil, err
		}
		for _, line := range strings.Split(string(out.Kept), "\n") {
			f := strings.Split(line, "\x00")
			switch {
			case len(f) != 4:
			case f[0] == "commit":
				tips = append(tips, f[1])
			case f[2] == "commit":
				tips = append(tips, f[3])
			}
		}
		trees, err := ListWorktrees(ctx, s.key.dir, "")
		if err != nil {
			return nil, err
		}
		for _, t := range trees.Trees {
			if !t.Prunable && t.Head != "" && strings.Trim(t.Head, "0") != "" {
				tips = append(tips, t.Head)
			}
		}
		fallthrough
	default:
		head, ok, err := revParse(ctx, s.key.dir, "HEAD", clocks.Review.PerCmd)
		if err != nil {
			return nil, err
		}
		if ok {
			tips = append(tips, head)
		}
	}
	slices.Sort(tips)
	return slices.Compact(tips), nil
}

// revList is the commits from reaches that not does not, as a set.
func (s *graphSession) revList(ctx context.Context, from, not []string) (map[string]bool, error) {
	set := map[string]bool{}
	if len(from) == 0 {
		return set, nil
	}
	ctx, cancel := context.WithTimeout(ctx, clocks.Review.Budget)
	defer cancel()
	args := []string{"rev-list", "--max-count=" + strconv.Itoa(s.deltaMax+1), "--stdin"}
	res, err := gitReadStdin(ctx, s.key.dir, revisionLines(from, not), args...)
	if err != nil {
		return nil, err
	}
	for _, sha := range strings.Fields(string(res)) {
		set[sha] = true
	}
	return set, nil
}

// readAdded is the commits the scope reaches from tips that it did not from
// the tips before, as rows in topological order, at most deltaMax+1 of them.
func (s *graphSession) readAdded(ctx context.Context, tips []string) ([]LogRow, error) {
	ctx, cancel := context.WithTimeout(ctx, clocks.Review.Budget)
	defer cancel()
	stream := startLogStream(ctx, s.key, tips, s.tips)
	defer stream.stop()
	var rows []LogRow
	for r := range stream.rows {
		rows = append(rows, r)
		if len(rows) > s.deltaMax {
			return rows, nil
		}
	}
	<-stream.done
	if stream.err != nil {
		return nil, stream.err
	}
	return rows, nil
}

// revisionLines is what --stdin reads: the commits to start from, then the
// ones whose history to leave out.
func revisionLines(from, not []string) string {
	var b strings.Builder
	for _, sha := range from {
		b.WriteString(sha + "\n")
	}
	for _, sha := range not {
		b.WriteString("^" + sha + "\n")
	}
	return b.String()
}

// logArgs is the log or rev-list command for a session's list, up to the
// pathspec, reading its revisions from stdin — or, for the reflog, walking
// HEAD's. A log of a path follows the file across renames; rev-list cannot,
// which is why such a list is not counted ahead (startLogCount).
func logArgs(key logKey, cmd ...string) []string {
	args := append([]string{}, cmd...)
	if key.path != "" && cmd[0] == "log" && key.scope != LogScopeReflog {
		args = append(args, "--follow")
	}
	grep := key.message != "" && key.hashPrefix() == ""
	if grep || key.author != "" {
		args = append(args, "--regexp-ignore-case", "--fixed-strings")
	}
	if grep {
		args = append(args, "--grep="+key.message)
	}
	if key.author != "" {
		args = append(args, "--author="+key.author)
	}
	if key.scope == LogScopeReflog {
		args = append(args, "HEAD", "--")
	} else {
		args = append(args, "--stdin", "--")
	}
	if key.path != "" {
		args = append(args, key.path)
	}
	return args
}

// logStream is one `git log` of a list, parsed a commit at a time onto rows,
// which is closed at the end of the history; err is git's failure, if it
// failed, once done is closed.
type logStream struct {
	rows chan LogRow
	done chan struct{}
	err  error
	stop context.CancelFunc
}

// startLogStream runs the list's log from tips, leaving out what not reaches.
func startLogStream(ctx context.Context, key logKey, tips, not []string) *logStream {
	ctx, stop := context.WithCancel(ctx)
	st := &logStream{rows: make(chan LogRow), done: make(chan struct{}), stop: stop}
	go func() {
		defer close(st.done)
		defer close(st.rows)
		st.err = st.read(ctx, key, tips, not)
	}()
	return st
}

// A list filtered by a hash prefix (logKey.hashPrefix) is read with each
// commit's whole message and filtered here: a row is kept when its hash starts
// with the prefix or its message holds the filter.
func (st *logStream) read(ctx context.Context, key logKey, tips, not []string) error {
	parse := func(rec []byte) (LogRow, bool) { return parseLogRecord(rec), true }
	var cmd *exec.Cmd
	switch prefix := key.hashPrefix(); {
	case key.scope == LogScopeReflog:
		cmd = gitCommand(ctx, key.dir, logArgs(key, "log", "-z", "-g", "--date=unix", "--no-show-signature", "--format="+reflogFormat)...)
		cmd.Stdin = strings.NewReader("")
		parse = func(rec []byte) (LogRow, bool) { return parseReflogRecord(rec), true }
	case prefix != "":
		cmd = gitCommand(ctx, key.dir, logArgs(key, "log", "-z", "--topo-order", "--no-show-signature", "--format="+logBodyFormat)...)
		cmd.Stdin = strings.NewReader(revisionLines(tips, not))
		parse = func(rec []byte) (LogRow, bool) {
			row, message := parseLogBodyRecord(rec)
			return row, strings.HasPrefix(row.Sha, prefix) || strings.Contains(strings.ToLower(message), prefix)
		}
	default:
		cmd = gitCommand(ctx, key.dir, logArgs(key, "log", "-z", "--topo-order", "--no-show-signature", "--format="+logFormat)...)
		cmd.Stdin = strings.NewReader(revisionLines(tips, not))
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	readErr := func() error {
		r := bufio.NewReaderSize(stdout, 64<<10)
		for {
			rec, err := r.ReadBytes(0)
			if len(bytes.TrimSpace(bytes.TrimRight(rec, "\x00"))) > 0 {
				if row, ok := parse(bytes.TrimRight(rec, "\x00")); ok {
					select {
					case st.rows <- row:
					case <-ctx.Done():
						return ctx.Err()
					}
				}
			}
			if errors.Is(err, io.EOF) {
				return nil
			}
			if err != nil {
				return err
			}
		}
	}()
	_, _ = io.Copy(io.Discard, stdout)
	waitErr := cmd.Wait()
	switch {
	case ctx.Err() != nil:
		return ctx.Err()
	case readErr != nil:
		return readErr
	case waitErr != nil:
		return gitcmd.Failure(waitErr, stderr.String())
	}
	return nil
}

// parseLogRecord reads one logFormat record.
func parseLogRecord(rec []byte) LogRow {
	f := strings.SplitN(strings.TrimLeft(string(rec), "\n"), "\x1f", 6)
	for len(f) < 6 {
		f = append(f, "")
	}
	subject := f[5]
	if len(subject) > logSubjectMax {
		subject = strings.ToValidUTF8(subject[:logSubjectMax], "")
	}
	parents := strings.Fields(f[1])
	if parents == nil {
		parents = []string{}
	}
	return LogRow{Sha: f[0], Parents: parents, Author: f[2], Email: f[3], Date: unixField(f[4]), Subject: subject, Out: []int{}}
}

// logBodyFormat is logFormat with the commit's whole message in place of its
// subject, last, where nothing it holds can be taken for a separator.
const logBodyFormat = "%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%B"

// parseLogBodyRecord reads one logBodyFormat record: the row, its subject
// made from the message as git's %s makes it (the first paragraph, its lines
// joined by spaces), and the message.
func parseLogBodyRecord(rec []byte) (LogRow, string) {
	f := strings.SplitN(strings.TrimLeft(string(rec), "\n"), "\x1f", 6)
	for len(f) < 6 {
		f = append(f, "")
	}
	message := f[5]
	first, _, _ := strings.Cut(strings.TrimLeft(message, "\n"), "\n\n")
	lines := strings.Split(first, "\n")
	for i, line := range lines {
		lines[i] = strings.TrimSpace(line)
	}
	f[5] = strings.Join(slices.DeleteFunc(lines, func(l string) bool { return l == "" }), " ")
	return parseLogRecord([]byte(strings.Join(f, "\x1f"))), message
}

// reflogFormat is one entry of HEAD's reflog: a commit as logFormat has it,
// but dated by the entry ("HEAD@{<unix>}" under --date=unix), with git's
// words for the entry before the subject.
const reflogFormat = "%H%x1f%P%x1f%an%x1f%ae%x1f%gd%x1f%gs%x1f%s"

// parseReflogRecord reads one reflogFormat record.
func parseReflogRecord(rec []byte) LogRow {
	f := strings.SplitN(strings.TrimLeft(string(rec), "\n"), "\x1f", 7)
	for len(f) < 7 {
		f = append(f, "")
	}
	when := f[4]
	if open := strings.LastIndex(when, "{"); open >= 0 {
		when = strings.TrimSuffix(when[open+1:], "}")
	}
	row := parseLogRecord([]byte(strings.Join([]string{f[0], f[1], f[2], f[3], when, f[6]}, "\x1f")))
	row.Reflog = f[5]
	if len(row.Reflog) > logSubjectMax {
		row.Reflog = strings.ToValidUTF8(row.Reflog[:logSubjectMax], "")
	}
	return row
}

// logCount counts a list in the background, for a scrollbar that knows how
// long the history is before it has been read.
type logCount struct {
	n    chan int
	stop context.CancelFunc
}

// startLogCount counts the list from tips. A list rev-list cannot count as log
// reads it — a file's history, which follows renames, the reflog, or a list
// filtered by a hash prefix — is not counted, and is nil: its total is known
// once it has been read to the end.
func startLogCount(ctx context.Context, key logKey, tips []string) *logCount {
	if key.path != "" || key.scope == LogScopeReflog || key.hashPrefix() != "" {
		return nil
	}
	ctx, stop := context.WithCancel(ctx)
	c := &logCount{n: make(chan int, 1), stop: stop}
	go func() {
		out, err := gitReadStdin(ctx, key.dir, revisionLines(tips, nil), logArgs(key, "rev-list", "--count")...)
		if err != nil {
			return
		}
		if n, err := strconv.Atoi(strings.TrimSpace(string(out))); err == nil {
			c.n <- n
		}
	}()
	return c
}

// result is the count, once there is one.
func (c *logCount) result() (int, bool) {
	select {
	case n := <-c.n:
		return n, true
	default:
		return 0, false
	}
}

// gitReadStdin runs one read that takes its revisions on stdin, and answers
// what it printed.
func gitReadStdin(ctx context.Context, dir, stdin string, args ...string) ([]byte, error) {
	cmd := gitCommand(ctx, dir, args...)
	cmd.Stdin = strings.NewReader(stdin)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, gitcmd.Failure(err, stderr.String())
	}
	return out, nil
}
