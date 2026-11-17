//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"

	"juggler/cmd/juggler/msg"
)

// The History place's commits are read here, a page at a time, from a graph
// session the server keeps for each list a client is showing.
//
// A session runs one `git log --topo-order` for as long as it lives and reads
// from it only as far as a client has asked, plus one page: git blocks on the
// pipe until more is wanted, so a history of a hundred thousand commits opens
// having read a few hundred, and costs nothing more until it is scrolled. The
// graph's lanes are laid out as the rows arrive (laneLayout), and a page
// carries the lanes entering its first row, which is all a client needs to
// draw it without the rows above.
//
// A ref that moves does not start the list again. The session finds what its
// scope now reaches and did not (prepended: a commit new to a history is never
// an ancestor of one already in it, so the order stays topological) and what
// it reached and no longer does (dropped, now and from the rest of the
// stream), lays the lanes out again over what it holds, and moves on to the
// next generation. Only a move too large to apply as a difference starts it
// again.

// The scopes a log can be read in.
const (
	LogScopeHead   = "head"   // what HEAD reaches: the current branch, or a detached HEAD
	LogScopeAll    = "all"    // every branch, remote branch and tag, and every worktree's HEAD
	LogScopeRef    = "ref"    // what one ref reaches
	LogScopeReflog = "reflog" // where the tree's HEAD has been, newest first: each commit once, by its latest entry
)

const (
	logPageDefault  = 200    // rows a page holds when the client does not say
	logPageMax      = 1000   // the most a page may hold
	logFilterMax    = 256    // characters a filter may be
	logSubjectMax   = 1000   // characters of a subject kept
	checkpointEvery = 256    // rows between the lanes a session remembers
	graphsMax       = 16     // sessions held at once, the least recently used dropped first
	graphDeltaMax   = 10_000 // commits a refresh applies as a difference before starting again
	graphIdle       = 10 * time.Minute
)

// logFormat is one commit of a log: fields separated by US, records by NUL
// (-z). No field a commit has can hold a NUL, and the subject, the one field
// that could hold a US, is last.
const logFormat = "%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s"

// LogQuery is one read of the History place's list.
//
// Graph names the session a client was given by an earlier read; empty, or a
// session the server no longer holds, opens a new one for the rest of the
// query, and the page says which. Message, Author and Path filter the list —
// message and author as case-insensitive text, path as a path; a message of
// four or more hex digits also matches the commits whose hash starts with
// it — and a filtered
// list is flat, with no lanes; a path's list follows the file across renames.
// A reflog row carries the entry's words in Reflog and is dated by the entry.
// Refresh asks the session to catch up with refs
// that moved, and Find asks where a commit is in the list, reading on until it
// is found or the history ends.
type LogQuery struct {
	Graph   string `json:"graph,omitempty"`
	Scope   string `json:"scope,omitempty"`
	Ref     string `json:"ref,omitempty"`
	Message string `json:"message,omitempty"`
	Author  string `json:"author,omitempty"`
	Path    string `json:"path,omitempty"`
	Offset  int    `json:"offset,omitempty"`
	Limit   int    `json:"limit,omitempty"`
	Refresh bool   `json:"refresh,omitempty"`
	Find    string `json:"find,omitempty"`
}

// LogRow is one commit of the list, and where the graph puts it: the lane its
// dot is in, and the lane each of its parents continues in, in parent order.
type LogRow struct {
	Sha     string   `json:"sha"`
	Parents []string `json:"parents"`
	Author  string   `json:"author"`
	Email   string   `json:"email"`
	Date    int64    `json:"date"` // its author time, Unix seconds
	Subject string   `json:"subject"`
	Lane    int      `json:"lane"`
	Out     []int    `json:"out"`
	Reflog  string   `json:"reflog,omitempty"`
}

// LogPage is one page of the list.
//
// Lanes are the lanes occupied entering Rows[0], in order. A lane never moves,
// so a row needs only its own Lane and Out: every other occupied lane passes
// straight through it, and the lanes entering the next row are these without
// Lane, with Out. Gen counts the times the session's rows moved under it — a
// refresh that found something, or a start again — and a client holding rows
// of another generation holds rows that are no longer where they were.
//
// More says there are rows past this page. Total is how many rows the list
// holds, or -1 while that is still being counted. Found is where Find is in
// the list, or -1.
type LogPage struct {
	Graph   string   `json:"graph"`
	Gen     int      `json:"gen"`
	Offset  int      `json:"offset"`
	Rows    []LogRow `json:"rows"`
	Lanes   []int    `json:"lanes"`
	More    bool     `json:"more"`
	Total   int      `json:"total"`
	Graphed bool     `json:"graphed"`
	Found   int      `json:"found"`
}

// Graphs holds the server's graph sessions.
//
// Which sessions there are is owned by one goroutine and reached through cmds.
// A session's own state is owned by whichever request holds its turn, so two
// reads of one list take turns and reads of two lists run at once.
type Graphs struct {
	cmds      chan func()
	done      chan struct{}
	closeOnce sync.Once

	// Owned by the run goroutine. max and deltaMax are set before the first
	// read and only read after.
	byID     map[string]*graphSession
	closed   bool
	max      int
	deltaMax int
}

// NewGraphs starts an empty store, which drops a session nobody has read for
// graphIdle.
func NewGraphs() *Graphs {
	g := &Graphs{cmds: make(chan func()), done: make(chan struct{}), byID: map[string]*graphSession{}, max: graphsMax, deltaMax: graphDeltaMax}
	go g.run()
	return g
}

func (g *Graphs) run() {
	sweep := time.NewTicker(time.Minute)
	defer sweep.Stop()
	for {
		select {
		case fn := <-g.cmds:
			fn()
		case now := <-sweep.C:
			g.dropIdle(now)
		case <-g.done:
			return
		}
	}
}

// do runs fn on the store's goroutine and waits for it; false when the store
// is closed and fn never ran.
func (g *Graphs) do(fn func()) bool {
	ran := make(chan struct{})
	select {
	case g.cmds <- func() { fn(); close(ran) }:
		<-ran
		return true
	case <-g.done:
		return false
	}
}

// Close ends every session, and its git with it. Later reads are refused.
func (g *Graphs) Close() {
	g.closeOnce.Do(func() {
		g.do(func() {
			g.closed = true
			for id, s := range g.byID {
				s.end()
				delete(g.byID, id)
			}
		})
		close(g.done)
	})
}

// errGraphsClosed is a read of a store that has been closed.
var errGraphsClosed = errors.New("the server is closing its git history")

// Read answers one page of the History place's list of the repository repo
// under root, named as the API names it. A query that cannot be read — an
// unknown scope, a ref that is not one, a filter too long — is a
// *RequestError.
func (g *Graphs) Read(ctx context.Context, root, repo string, q LogQuery) (LogPage, error) {
	key, err := logKeyOf(q)
	if err != nil {
		return LogPage{}, err
	}
	if key.dir, err = ResolveRepo(ctx, root, repo); err != nil {
		return LogPage{}, err
	}
	limit := q.Limit
	if limit <= 0 {
		limit = logPageDefault
	}
	limit = min(limit, logPageMax)
	offset := max(q.Offset, 0)

	var s *graphSession
	if !g.do(func() { s = g.session(q.Graph, key) }) || s == nil {
		return LogPage{}, errGraphsClosed
	}
	select {
	case s.turn <- struct{}{}:
	case <-ctx.Done():
		return LogPage{}, ctx.Err()
	}
	defer func() { <-s.turn }()

	if !s.started {
		if err := s.start(ctx); err != nil {
			g.do(func() { g.drop(s.id) })
			return LogPage{}, err
		}
	} else if q.Refresh {
		if err := s.refresh(ctx); err != nil {
			return LogPage{}, err
		}
	}
	found := -1
	if q.Find != "" {
		if found, err = s.find(ctx, q.Find); err != nil {
			return LogPage{}, err
		}
	}
	if err := s.readTo(ctx, offset+2*limit); err != nil {
		return LogPage{}, err
	}
	page := s.page(offset, limit)
	page.Found = found
	return page, nil
}

// session finds the session id names, if it answers key, or opens a new one,
// dropping the least recently read beyond max. On the store's goroutine.
func (g *Graphs) session(id string, key logKey) *graphSession {
	if g.closed {
		return nil
	}
	now := time.Now()
	if s, ok := g.byID[id]; ok && s.key == key {
		s.used = now
		return s
	}
	s := newGraphSession(newGraphID(), key, g.deltaMax)
	s.used = now
	g.byID[s.id] = s
	for len(g.byID) > g.max {
		oldest := ""
		for id, other := range g.byID {
			if oldest == "" || other.used.Before(g.byID[oldest].used) {
				oldest = id
			}
		}
		g.drop(oldest)
	}
	return s
}

// drop ends one session and forgets it. On the store's goroutine.
func (g *Graphs) drop(id string) {
	if s, ok := g.byID[id]; ok {
		s.end()
		delete(g.byID, id)
	}
}

// dropIdle drops every session nobody has read for graphIdle before now. On
// the store's goroutine.
func (g *Graphs) dropIdle(now time.Time) {
	for id, s := range g.byID {
		if now.Sub(s.used) > graphIdle {
			g.drop(id)
		}
	}
}

// newGraphID names a session. It is a handle, not a secret — every read is
// already the user's — but a guessable one would let two clients' lists
// collide.
func newGraphID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// logKey is what a session answers: one repository's list, in one scope,
// filtered one way.
type logKey struct {
	dir, scope, ref, message, author, path string
}

// hashPrefix is the message filter as the start of a commit's hash — four to
// forty hex digits, lower-cased — or "" when it cannot be one. Such a filter
// lists a commit whose hash starts with it as well as one whose message holds
// it, so git's --grep, which knows nothing of hashes, is not what applies it
// (see logStream.read). The reflog's message filter is --grep's alone.
func (k logKey) hashPrefix() string {
	if k.scope == LogScopeReflog || len(k.message) < 4 || len(k.message) > 40 {
		return ""
	}
	for _, c := range k.message {
		if !strings.ContainsRune("0123456789abcdefABCDEF", c) {
			return ""
		}
	}
	return strings.ToLower(k.message)
}

// graphed is whether the list is a graph: a filtered one is not, nor is the
// reflog, whose order is time's, not the graph's.
func (k logKey) graphed() bool {
	return k.message == "" && k.author == "" && k.path == "" && k.scope != LogScopeReflog
}

// logKeyOf checks a query and names what it asks for. The repository is the
// caller's to fill in.
func logKeyOf(q LogQuery) (logKey, error) {
	k := logKey{scope: q.Scope, ref: q.Ref, message: q.Message, author: q.Author, path: q.Path}
	switch k.scope {
	case "":
		k.scope = LogScopeHead
	case LogScopeHead, LogScopeAll, LogScopeReflog:
	case LogScopeRef:
		if k.ref == "" {
			return logKey{}, &RequestError{msg.NewError("No ref was named")}
		}
		if err := checkRevision(k.ref); err != nil {
			return logKey{}, err
		}
	default:
		return logKey{}, &RequestError{msg.NewError("Unknown history scope {scope}: the scopes are head, all, ref and reflog", "scope", k.scope)}
	}
	if k.scope != LogScopeRef {
		k.ref = ""
	}
	for _, text := range []string{k.message, k.author, k.path} {
		if len(text) > logFilterMax {
			return logKey{}, &RequestError{msg.NewError("A filter is longer than {max} characters", "max", logFilterMax)}
		}
		if slices.ContainsFunc([]rune(text), unicode.IsControl) {
			return logKey{}, &RequestError{msg.NewError("A filter holds a control character")}
		}
	}
	return k, nil
}
