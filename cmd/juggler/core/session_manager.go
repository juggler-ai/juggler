//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"fmt"
	"os"
	"slices"
	"sort"
	"sync"
	"time"

	"juggler/internal/jlog"
)

// binSizeInterval is how often the low-priority background monitor recomputes
// the on-disk size of .juggler/trash/ as a backstop. Bin contents change
// rarely and the tally is only cosmetic (a "(50 MB)" hint on the Bin button
// and Empty-Bin action), so this is deliberately coarse; user-initiated
// bin/restore/delete/empty operations nudge an immediate recompute on top of
// it (see kickBinSizeRecompute).
const binSizeInterval = 5 * time.Minute

// SessionManager owns the in-memory *Session and serializes all access via a
// single goroutine. Operations are typed closures sent over read/write
// channels; the actor goroutine runs them on the shared state.
//
// Read commands (GetSession, ConvDir, ConvNames, ListBinnedConversations,
// LoadConversationBinary) go on readChan; write commands (everything else) on
// writeChan. The run loop drains pending reads before picking a write, so
// in-memory reads never queue behind disk-writing operations.
//
// Channel capacity 64 is well above the steady-state depth: each websocket
// frame may produce one read; debounced saves produce one write every couple
// of seconds.
type SessionManager struct {
	state        *sessionState
	readChan     chan sessionTask
	writeChan    chan sessionTask
	shutdownChan chan struct{}
	shutdownOnce sync.Once
	// goroutines counts the actor, the background helpers started with the
	// manager, and any later work handed to goBackground, so Shutdown can wait
	// for the last of them to stop touching the project directory before it
	// returns.
	goroutines  sync.WaitGroup
	scratchDir  string // non-empty in no-project mode; removed on Shutdown
	projectPath string
	// binSizeKick nudges the background bin-size monitor to recompute now
	// (buffered/size-1: sends are non-blocking and coalesce).
	binSizeKick chan struct{}
}

// sessionState is the mutable cell owned by the actor goroutine. Closures
// receive *sessionState so they can both read and replace s.session.
type sessionState struct {
	store   *FileSessionStore
	session *Session
	// binSizeBytes caches the on-disk size of .juggler/trash/, refreshed by
	// the background bin-size monitor. Read on the actor; written only via a
	// task the monitor posts, so it never needs a lock.
	binSizeBytes int64
	// boardsClaimed records that the detached boards left over from the last run
	// have been handed to a window to reopen. Read and written only on the actor,
	// and deliberately not persisted: it is a fact about this process, not about
	// the project. See SessionManager.ClaimDetachedBoards.
	boardsClaimed bool
	// workspacesReconciled records that a client has taken on the once-per-run
	// job of reconciling the workspace table against what is actually on disk.
	// Read and written only on the actor, and not persisted for the same reason
	// boardsClaimed isn't: it is a fact about this process. See
	// SessionManager.ClaimWorkspaceReconcile.
	workspacesReconciled bool
}

// sessionTask is the unit of work the actor goroutine runs.
type sessionTask func(*sessionState)

// SessionManagerConfig configures the session manager.
type SessionManagerConfig struct {
	Store       *FileSessionStore
	ProjectPath string
}

// NewSessionManager creates a new session manager.
func NewSessionManager(cfg SessionManagerConfig) (*SessionManager, error) {
	if cfg.Store == nil {
		return nil, fmt.Errorf("store is required")
	}
	if cfg.ProjectPath == "" {
		return nil, fmt.Errorf("project path is required")
	}
	return startManager(cfg.Store, cfg.ProjectPath, ""), nil
}

// NewSessionManagerForPath constructs a SessionManager for the given project
// path, or an ephemeral one (backed by a temp directory) if the path is empty.
// The ephemeral mode supports "no project loaded" startup without forcing the
// rest of the server to special-case a nil manager.
func NewSessionManagerForPath(projectPath string) (*SessionManager, error) {
	if projectPath == "" {
		scratch, err := os.MkdirTemp("", "juggler-noproject-")
		if err != nil {
			return nil, fmt.Errorf("failed to create scratch dir: %w", err)
		}
		store, err := NewFileSessionStore(scratch)
		if err != nil {
			return nil, err
		}
		return startManager(store, "", scratch), nil
	}
	store, err := NewFileSessionStore(projectPath)
	if err != nil {
		return nil, err
	}
	return startManager(store, projectPath, ""), nil
}

func startManager(store *FileSessionStore, projectPath, scratchDir string) *SessionManager {
	m := &SessionManager{
		state:        &sessionState{store: store},
		readChan:     make(chan sessionTask, 64),
		writeChan:    make(chan sessionTask, 64),
		shutdownChan: make(chan struct{}),
		scratchDir:   scratchDir,
		projectPath:  projectPath,
		binSizeKick:  make(chan struct{}, 1),
	}
	// Read the orphan list HERE, on the constructing goroutine, rather than on
	// the sweeper. An orphan is by definition a staging directory left behind by
	// a PREVIOUS process, and the two are told apart only by time: the glob
	// matches every `trash.emptying-*` there is, including the one an EmptyBin
	// this manager is about to serve will create. Taken before the manager can
	// accept a single request, the list cannot contain one of our own; taken on
	// the goroutine it was, a scheduler that ran the sweeper late enough handed
	// it a live staging directory to send to the OS trash, underneath the empty
	// that was still writing into it.
	orphans := store.orphanedEmptyingDirs()
	m.goroutines.Add(3)
	go func() { defer m.goroutines.Done(); m.run() }()
	go func() { defer m.goroutines.Done(); m.runBinSizeMonitor(store) }()
	go func() { defer m.goroutines.Done(); m.sweepOrphanedEmptyingDirs(orphans) }()
	return m
}

// backgroundTrash is the OS-trash step EmptyBin defers to a background
// goroutine. Indirected so a test can hold it open and ask what Shutdown does
// while it runs.
var backgroundTrash = trashOrRemove

// goBackground runs fn off the actor, on a goroutine Shutdown waits for — so
// work an actor task defers is still ordered before the barrier, and the
// project directory is quiet by the time the project's lock is released.
//
// It must be called ON the actor goroutine, which is what makes it safe
// without a lock: the actor is itself counted and cannot return mid-task, so
// this Add always lands with the counter at two or more and strictly before
// the actor's own Done. A concurrent Shutdown therefore cannot finish waiting
// without also waiting for fn.
func (m *SessionManager) goBackground(fn func()) {
	m.goroutines.Add(1)
	go func() {
		defer m.goroutines.Done()
		fn()
	}()
}

// sweepOrphanedEmptyingDirs trashes the .juggler/trash.emptying-* directories
// left behind by an EmptyBin whose background trash step was interrupted (e.g.
// the process exited before it finished). Runs once at startup, off the actor,
// so it never delays session load. Best-effort: failures are logged, not fatal.
//
// Takes the list rather than globbing for it, so that what counts as an orphan
// is decided before this manager has served anything (see startManager).
// Trashes through backgroundTrash, the same seam EmptyBin's own step uses: this
// is the second writer of the same directories, and a test that holds one open
// while leaving the other pointed at the real OS trash is not testing the thing
// it thinks it is.
func (m *SessionManager) sweepOrphanedEmptyingDirs(orphans []string) {
	for _, dir := range orphans {
		if err := backgroundTrash(dir); err != nil {
			jlog.Error("[session] failed to sweep orphaned empty-bin dir %q: %v", dir, err)
		}
	}
}

// runBinSizeMonitor is a low-priority background goroutine that keeps
// sessionState.binSizeBytes fresh. It recomputes on a coarse ticker and
// whenever a bin mutation nudges binSizeKick, then posts the result to the
// actor via writeChan so the cached value is only ever mutated on the actor
// goroutine. The size walk itself runs here, off the actor, so a large bin
// never stalls session reads/writes. store is captured directly (its
// projectPath is immutable and BinSizeBytes touches no in-memory index), so
// this goroutine shares no mutable state with the actor.
func (m *SessionManager) runBinSizeMonitor(store *FileSessionStore) {
	ticker := time.NewTicker(binSizeInterval)
	defer ticker.Stop()

	recompute := func() {
		size := store.BinSizeBytes()
		select {
		case m.writeChan <- func(s *sessionState) { s.binSizeBytes = size }:
		case <-m.shutdownChan:
		}
	}

	// Reclaim anything binned before binning stripped transaction inputs, or by a
	// strip a shutdown cut short. It belongs here rather than on the load path:
	// the first pass over a long-accumulated bin reads every blob in it, which is
	// gigabytes on a project that has been in use for a while, and this goroutine
	// is already where the bin's slow filesystem work happens.
	store.sweepBinTxnInputs()

	recompute() // seed the cache promptly after startup
	for {
		select {
		case <-ticker.C:
			recompute()
		case <-m.binSizeKick:
			recompute()
		case <-m.shutdownChan:
			return
		}
	}
}

// kickBinSizeRecompute nudges the background monitor to recompute the bin
// size now, without blocking: a full kick channel already means a recompute
// is pending, so the extra signal is dropped.
func (m *SessionManager) kickBinSizeRecompute() {
	select {
	case m.binSizeKick <- struct{}{}:
	default:
	}
}

// BinSizeBytes returns the most recently cached on-disk size of
// .juggler/trash/. The value is maintained by the background monitor, so a
// read is a cheap in-memory lookup — it never triggers a filesystem walk.
func (m *SessionManager) BinSizeBytes() int64 {
	v, _ := runRead(m, func(s *sessionState) (int64, error) {
		return s.binSizeBytes, nil
	})
	return v
}

// run is the actor goroutine that owns the session and all file I/O.
// Reads are served before writes when both are pending — small in-memory
// lookups never queue behind a disk-writing Save.
func (m *SessionManager) run() {
	session, err := m.state.store.Load()
	if err != nil {
		session = NewSession()
		if err := m.state.store.Save(session); err != nil {
			jlog.Error("[session] failed to create session: %v", err)
		}
	}
	m.state.session = session

	for {
		// Drain pending reads before considering a write.
		select {
		case t := <-m.readChan:
			t(m.state)
			continue
		default:
		}
		select {
		case t := <-m.readChan:
			t(m.state)
		case t := <-m.writeChan:
			t(m.state)
		case <-m.shutdownChan:
			return
		}
	}
}

// Shutdown gracefully shuts down the actor goroutine and removes any
// ephemeral scratch directory created for no-project mode.
//
// It is a barrier: once it returns, no goroutine of this manager will write
// into the project directory again. Callers depend on that — the project switch
// releases the project's lock immediately afterwards, and a task still in flight
// would write into a directory whose next owner is already there.
func (m *SessionManager) Shutdown() {
	m.shutdownOnce.Do(func() {
		close(m.shutdownChan)
		// A task already picked off the queue runs to completion, so waiting is
		// the only thing that makes the last write ordered before the return.
		m.goroutines.Wait()
		if m.scratchDir != "" {
			os.RemoveAll(m.scratchDir)
		}
	})
}

// pair carries two values out of an actor closure, which runRead and runWrite
// otherwise let return only one.
type pair[A, B any] struct {
	a A
	b B
}

// runOn submits fn to one of the actor's channels and waits for its result.
func runOn[T any](ch chan<- sessionTask, fn func(*sessionState) (T, error)) (T, error) {
	out := make(chan pair[T, error], 1)
	ch <- func(s *sessionState) {
		v, err := fn(s)
		out <- pair[T, error]{v, err}
	}
	r := <-out
	return r.a, r.b
}

// runRead submits fn to the read channel and waits for its result.
func runRead[T any](m *SessionManager, fn func(*sessionState) (T, error)) (T, error) {
	return runOn(m.readChan, fn)
}

// runWrite submits fn to the write channel and waits for its result.
func runWrite[T any](m *SessionManager, fn func(*sessionState) (T, error)) (T, error) {
	return runOn(m.writeChan, fn)
}

// runLookup runs a read that answers (value, found) and cannot fail.
func runLookup[T any](m *SessionManager, fn func(*sessionState) (T, bool)) (T, bool) {
	r, _ := runRead(m, func(s *sessionState) (pair[T, bool], error) {
		v, ok := fn(s)
		return pair[T, bool]{v, ok}, nil
	})
	return r.a, r.b
}

// ============================================================================
// Wrapper methods
// ============================================================================

// GetSession returns a private snapshot of the session. The clone is taken on
// the actor goroutine, so it is a consistent point-in-time copy; callers then
// own it outright. Because the live session never escapes the actor, the only
// way to change session state is an actor method (Update / PatchMetadata /
// SetWindowState) — mutating the result of GetSession from an HTTP handler is a
// no-op on the real state, which is what makes the concurrent-map-write
// server-crash structurally impossible rather than merely discouraged.
func (m *SessionManager) GetSession() *Session {
	v, _ := runRead(m, func(s *sessionState) (*Session, error) {
		return s.session.Clone(), nil
	})
	return v
}

// Update is the single entry point for arbitrary session mutation. mutate runs
// on the actor goroutine with exclusive access to the live *Session; the
// manifest is then validated and persisted. There is deliberately no exported
// way to hand back an externally-built session and swap it in: that
// build-outside / replace-inside shape would let two HTTP goroutines race the
// same map. Here the mutation happens in-place under the actor, atomic with
// respect to every other session operation.
func (m *SessionManager) Update(mutate func(*Session) error) error {
	_, err := runWrite(m, func(s *sessionState) (struct{}, error) {
		if s.session == nil {
			return struct{}{}, nil
		}
		if err := mutate(s.session); err != nil {
			return struct{}{}, err
		}
		if err := s.session.Validate(); err != nil {
			return struct{}{}, fmt.Errorf("invalid session: %w", err)
		}
		return struct{}{}, s.store.Save(s.session)
	})
	return err
}

// CreateConversation creates a new conversation folder, using requestedID when
// supplied or allocating a fresh id otherwise, and prepends the id to
// ConversationOrder. Returns the id and canonical name (which gets a
// " (copy N)" suffix on case-folded collision).
//
// Single authoritative entry point for creating a new conversation: the
// folder exists with its final name before this call returns, and the
// worker subsequently spawned for the id resolves the folder by id via
// ensureConvDir.
func (m *SessionManager) CreateConversation(name string, requestedID ...string) (string, string, error) {
	idHint := ""
	if len(requestedID) > 0 {
		idHint = requestedID[0]
	}
	return m.CreateConversationAt(name, idHint, ConversationPlacement{Where: PlaceHead})
}

// The three places a new conversation can be asked for. They are spelled out
// rather than inferred from whether an anchor was given, because "the end of
// the bar" and "behind this particular conversation" are different requests
// that a single id cannot tell apart: a client naming its own last tab means
// the first, unless it means the second, and the server holds conversations the
// client has never seen either way.
const (
	PlaceHead  = "head"
	PlaceAfter = "after"
	PlaceEnd   = "end"
)

// ConversationPlacement says where a new conversation goes in ConversationOrder.
type ConversationPlacement struct {
	Where string // PlaceHead, PlaceAfter or PlaceEnd; anything else reads as PlaceHead
	After string // The conversation to sit behind, for PlaceAfter
}

// PlacementFor reads a placement off the wire, accepting a request that carries
// only an anchor: no `where` at all means the head when nothing is named, and
// behind the named conversation otherwise.
func PlacementFor(where, after string) ConversationPlacement {
	if where == "" {
		if after == "" {
			return ConversationPlacement{Where: PlaceHead}
		}
		return ConversationPlacement{Where: PlaceAfter, After: after}
	}
	return ConversationPlacement{Where: where, After: after}
}

// indexIn resolves a placement against the order it is going into.
//
// An unknown anchor is not an error and does not move the request somewhere
// else: a viewer can name a conversation this session has since binned, or one
// from a session it has left, and a create is far too important to refuse — or
// to relocate — over where it was hoping to sit. It lands at the head, which is
// where a create with nothing to say about position goes.
func (p ConversationPlacement) indexIn(order []string) int {
	switch p.Where {
	case PlaceEnd:
		return len(order)
	case PlaceAfter:
		if i := slices.Index(order, p.After); i >= 0 {
			return i + 1
		}
		return 0
	default:
		return 0
	}
}

// CreateConversationAt is CreateConversation with a say in where the new id
// lands in ConversationOrder.
//
// The order is the server's, and it is what a viewer's tab list is re-slotted
// into on the broadcast this create produces — so where a conversation goes is
// settled here or not at all, however carefully the viewer placed the tab. The
// head is right for a conversation of the project's and wrong for one made
// inside a workspace box, which belongs beside the rest of that box.
func (m *SessionManager) CreateConversationAt(name, requestedID string, place ConversationPlacement) (string, string, error) {
	return m.CreateConversationFilled(name, requestedID, place, nil)
}

// CreateConversationFilled is CreateConversationAt for a conversation that
// starts with content — a duplicate. fill runs once the folder exists and
// before the id enters ConversationOrder, so nothing can load the conversation
// until it holds what fill put there. The order is what every viewer reads
// (the session document, and the refresh any client runs on a reconnect or a
// sibling's session change), and a load that lands on the folder's zero-byte
// doc.yjs starts a worker on an empty document that never reads the copy.
//
// fill runs outside the session actor: it may flush a worker, whose save goes
// through it. When fill fails the id is not added, and the folder is left for
// the next load's reconcile, as a crash between the two would leave it.
func (m *SessionManager) CreateConversationFilled(name, requestedID string, place ConversationPlacement, fill func(id string) error) (string, string, error) {
	if fill == nil {
		return m.createConversationOrdered(name, requestedID, place)
	}
	created, err := runWrite(m, func(s *sessionState) (pair[string, string], error) {
		id, finalName, _, err := s.store.CreateConversationFolder(name, requestedID)
		return pair[string, string]{id, finalName}, err
	})
	if err != nil {
		return "", "", err
	}
	id, finalName := created.a, created.b
	if err := fill(id); err != nil {
		return "", "", err
	}
	_, err = runWrite(m, func(s *sessionState) (struct{}, error) {
		if _, ok := s.store.ConvDir(id); !ok {
			return struct{}{}, fmt.Errorf("conversation %s left the session while it was filled", id)
		}
		if !slices.Contains(s.session.ConversationOrder, id) {
			at := place.indexIn(s.session.ConversationOrder)
			s.session.ConversationOrder = slices.Insert(s.session.ConversationOrder, at, id)
		}
		return struct{}{}, s.store.Save(s.session)
	})
	if err != nil {
		return "", "", err
	}
	return id, finalName, nil
}

// createConversationOrdered creates the folder and enters the id into
// ConversationOrder in one actor step.
func (m *SessionManager) createConversationOrdered(name, requestedID string, place ConversationPlacement) (string, string, error) {
	r, err := runWrite(m, func(s *sessionState) (pair[string, string], error) {
		id, finalName, _, err := s.store.CreateConversationFolder(name, requestedID)
		if err != nil {
			return pair[string, string]{}, err
		}
		if !slices.Contains(s.session.ConversationOrder, id) {
			at := place.indexIn(s.session.ConversationOrder)
			s.session.ConversationOrder = slices.Insert(s.session.ConversationOrder, at, id)
		}
		if err := s.store.Save(s.session); err != nil {
			return pair[string, string]{}, err
		}
		return pair[string, string]{id, finalName}, nil
	})
	if err != nil {
		return "", "", err
	}
	return r.a, r.b, nil
}

// SaveConversationBinary writes the Yjs document for an existing
// conversation to disk. ConversationOrder is owned by CreateConversation;
// callers must register the id there before saving bytes for it.
func (m *SessionManager) SaveConversationBinary(convID string, yjsData []byte) error {
	_, err := runWrite(m, func(s *sessionState) (struct{}, error) {
		return struct{}{}, s.store.SaveConversationBinary(convID, yjsData)
	})
	return err
}

// SaveConversationBinaryIfOwned persists the Yjs document only when convID is a
// conversation this project already owns (has a registered on-disk folder),
// reporting whether the save happened. It is the persistence path for the
// conversation-worker manager, which is server-lifetime: its workers can
// outlive a SwitchProject, so a worker created under one project must never
// write its conversation into whichever project is loaded now. Unlike
// SaveConversationBinary — which fabricates an "Untitled--<id>" folder for an
// unknown id (a deliberate low-level store convenience some tests rely on) —
// this refuses the unowned id and returns (false, nil): a benign no-op, since
// the project that actually owns the conversation persists it when it is the
// loaded project. The ownership check and the write happen in one actor turn,
// so a concurrent SwitchProject can never wedge a save between them.
func (m *SessionManager) SaveConversationBinaryIfOwned(convID string, yjsData []byte) (bool, error) {
	return runWrite(m, func(s *sessionState) (bool, error) {
		if _, ok := s.store.ConvDir(convID); !ok {
			return false, nil
		}
		return true, s.store.SaveConversationBinary(convID, yjsData)
	})
}

// LoadConversationBinary loads binary Yjs conversation data.
func (m *SessionManager) LoadConversationBinary(convID string) ([]byte, error) {
	return runRead(m, func(s *sessionState) ([]byte, error) {
		return s.store.LoadConversationBinary(convID)
	})
}

// ReorderConversations updates the conversation order. The incoming order may
// mention only a subset of conversations (a client that knows only some — e.g.
// one lane of the multi-iframe test pool, or any viewer mid-sync); it is merged
// onto the manifest so unmentioned conversations keep their slots rather than
// being dropped. When the client posts the full set (the production case) the
// merge is an exact replacement.
//
// Ids with no folder on disk are dropped before merging. A viewer posts its
// whole tab list, and it keeps a tab for a conversation whose load failed, so
// without this an id binned in one window is put straight back into the
// manifest by the next reorder from another — reinstating a tab that names no
// conversation, cannot be renamed, and cannot be duplicated. A conversation
// enters the order by being created or restored, never by being mentioned here.
// Returns the merged manifest order, which is what clients must be told: the
// posted order is one viewer's snapshot of its own tabs, and echoing that back
// tells every other viewer to forget any conversation the sender had not heard
// of yet.
// `moved`, when set, names the one conversation the client dragged, and is what
// lets a workspace box keep the place it is drawn in: a box is placed by the
// conversation it sits behind, so that conversation moving means the box has to
// hand its place on or be dragged along behind a tab nobody touched
// (reanchorBoxesAt). It cannot be inferred from the order — two adjacent tabs
// swapping is the same pair of sequences whichever of them was the one dragged —
// so the mover is told rather than guessed. Empty means a reorder that is not
// one conversation moving (a bump, a duplicate, a viewer syncing its whole
// list), and no box changes place. Reports whether any box did.
func (m *SessionManager) ReorderConversations(order []string, moved string) ([]string, bool, error) {
	res, err := runWrite(m, func(s *sessionState) (reorderResult, error) {
		known := make([]string, 0, len(order))
		for _, id := range order {
			if _, ok := s.store.ConvDir(id); ok {
				known = append(known, id)
			}
		}
		merged := mergeConversationOrder(s.session.ConversationOrder, known)

		// While the old order still holds the neighbour a box is to inherit.
		//
		// Not conditional on the merged order differing: dragging a tab from
		// above its box to just below it leaves the flat order exactly as it
		// was — the tab was already in front of the one below the box — and the
		// whole of what moved is the box. Re-anchoring is self-limiting anyway,
		// since it is only ever the rows anchored to `moved`, and they are not
		// anchored to it afterwards.
		reanchored := false
		if moved != "" {
			reanchored = reanchorBoxesAt(s.session, moved)
		}

		s.session.ConversationOrder = merged
		return reorderResult{
			order:      append([]string(nil), merged...),
			reanchored: reanchored,
		}, s.store.Save(s.session)
	})
	return res.order, res.reanchored, err
}

// reorderResult is what one reorder did: the merged order to echo back, and
// whether it moved a workspace box, which the caller must broadcast separately.
type reorderResult struct {
	order      []string
	reanchored bool
}

// mergeConversationOrder re-slots the ids named in `desired` (in desired
// sequence) into the positions they currently occupy in `current`, leaving ids
// absent from `desired` exactly where they are. Ids in `desired` not present in
// `current` are appended. With `desired` covering all of `current`'s ids this
// is a straight replacement; with a subset it reorders only that subset.
func mergeConversationOrder(current, desired []string) []string {
	desiredSet := make(map[string]bool, len(desired))
	for _, id := range desired {
		desiredSet[id] = true
	}
	currentSet := make(map[string]bool, len(current))
	for _, id := range current {
		currentSet[id] = true
	}
	// Desired ids that actually exist now, in desired order — these fill the
	// slots currently held by any desired id.
	queue := make([]string, 0, len(desired))
	for _, id := range desired {
		if currentSet[id] {
			queue = append(queue, id)
		}
	}
	result := make([]string, 0, len(current)+len(desired))
	qi := 0
	for _, id := range current {
		if desiredSet[id] {
			result = append(result, queue[qi])
			qi++
		} else {
			result = append(result, id)
		}
	}
	// New arrivals (in desired but not yet on disk in the order) go last.
	for _, id := range desired {
		if !currentSet[id] {
			result = append(result, id)
		}
	}
	return result
}

// DeleteConversation removes the conversation's folder and session manifest entry,
// along with the detached boards that were views of it.
// Set permanent=true for test teardown (permanent delete); false for user-initiated
// deletion (moves to OS trash so the user can recover if needed).
func (m *SessionManager) DeleteConversation(convID string, permanent bool) error {
	_, err := runWrite(m, func(s *sessionState) (struct{}, error) {
		removeConvIDFromSession(s.session, convID)
		s.session.removeBoardsForConversation(convID)
		if err := s.store.removeConversationFiles(convID, permanent); err != nil {
			return struct{}{}, err
		}
		if err := s.store.Save(s.session); err != nil {
			return struct{}{}, fmt.Errorf("failed to save session after deleting conversation: %w", err)
		}
		return struct{}{}, nil
	})
	return err
}

// RenameConversation renames the conversation's folder on disk.
// Returns the canonical (post-sanitization) name on success.
func (m *SessionManager) RenameConversation(convID, newName string) (string, error) {
	return runWrite(m, func(s *sessionState) (string, error) {
		return s.store.RenameConversation(convID, newName)
	})
}

// ConvDir returns the absolute folder path for the conversation, or "",
// false if the conversation isn't known.
func (m *SessionManager) ConvDir(convID string) (string, bool) {
	return runLookup(m, func(s *sessionState) (string, bool) {
		return s.store.ConvDir(convID)
	})
}

// ConvName returns the human-readable name of one conversation, or "", false
// if the conversation isn't known.
func (m *SessionManager) ConvName(convID string) (string, bool) {
	return runLookup(m, func(s *sessionState) (string, bool) {
		return s.store.ConvName(convID)
	})
}

// ConvNames returns a snapshot of id → human name for every conversation
// folder currently on disk.
func (m *SessionManager) ConvNames() map[string]string {
	v, _ := runRead(m, func(s *sessionState) (map[string]string, error) {
		return s.store.ConvNames(), nil
	})
	return v
}

// autoNameSuffix appends a plain numeric suffix: "Title 2", "Title 3", …
func autoNameSuffix(base string, i int) string {
	return fmt.Sprintf("%s %d", base, i)
}

// ResolveAutoName returns a collision-free variant of base with plain numeric
// suffixes. Excludes excludeID from the collision check.
func (m *SessionManager) ResolveAutoName(base, excludeID string) string {
	v, _ := runRead(m, func(s *sessionState) (string, error) {
		return disambiguateName(base, excludeID, s.store.ConvNames(), autoNameSuffix), nil
	})
	return v
}

// BinConversation moves a conversation's folder to .juggler/bin/ and removes
// it from the active conversation order. The detached boards that were views of
// it are forgotten as they are on a delete: the bin holds the conversation, not
// the windows that were watching it, and a board window left open over a
// conversation the user has put away has nothing to show.
func (m *SessionManager) BinConversation(convID string) error {
	binnedDir, err := runWrite(m, func(s *sessionState) (string, error) {
		removeConvIDFromSession(s.session, convID)
		s.session.removeBoardsForConversation(convID)
		dir, binErr := s.store.binConversationDeferred(convID)
		if binErr != nil {
			return "", binErr
		}
		if err := s.store.Save(s.session); err != nil {
			return "", fmt.Errorf("failed to save session after binning conversation: %w", err)
		}
		return dir, nil
	})
	if err == nil {
		// Strip the binned conversation's transaction inputs off the actor: it is
		// the only part of binning whose cost scales with the conversation, and a
		// long one carries hundreds of megabytes of replayed history. The kick
		// below then recomputes the bin size over what is left.
		go func() {
			stripConvTxnInputs(binnedDir)
			m.kickBinSizeRecompute()
		}()
	}
	return err
}

// RestoreConversation moves a conversation's folder back from .juggler/bin/
// to .juggler/ and prepends it to the active conversation order, matching
// CreateConversation: a restore is a deliberate act on one conversation, so it
// belongs at the head of the bar rather than the tail of a long tab list.
func (m *SessionManager) RestoreConversation(convID string) error {
	_, err := runWrite(m, func(s *sessionState) (struct{}, error) {
		if err := s.store.RestoreConversation(convID); err != nil {
			return struct{}{}, err
		}
		if !slices.Contains(s.session.ConversationOrder, convID) {
			s.session.ConversationOrder = append([]string{convID}, s.session.ConversationOrder...)
		}
		if err := s.store.Save(s.session); err != nil {
			return struct{}{}, fmt.Errorf("failed to save session after restoring conversation: %w", err)
		}
		return struct{}{}, nil
	})
	if err == nil {
		m.kickBinSizeRecompute()
	}
	return err
}

// ListBinnedConversations returns metadata for all conversations in
// .juggler/bin/, sorted most-recently-modified first.
func (m *SessionManager) ListBinnedConversations() []BinnedConvInfo {
	v, _ := runRead(m, func(s *sessionState) ([]BinnedConvInfo, error) {
		return s.store.BinnedConvList(), nil
	})
	return v
}

// DeleteBinnedConversation permanently removes (via OS trash) a single
// conversation folder from .juggler/bin/.
func (m *SessionManager) DeleteBinnedConversation(convID string) error {
	_, err := runWrite(m, func(s *sessionState) (struct{}, error) {
		return struct{}{}, s.store.removeBinnedConversationFiles(convID)
	})
	if err == nil {
		m.kickBinSizeRecompute()
	}
	return err
}

// EmptyBin permanently removes (via OS trash) every conversation currently in
// .juggler/trash/, returning the ids removed. The actor only does the fast
// in-memory move-aside (emptyBinDeferred); the actual OS-trash of the moved-
// aside directory runs on a background goroutine so a multi-GB bin neither
// stalls other session writes (new tabs, saves) nor plays one "moved to trash"
// sound per conversation — it is a single trash operation, off the hot path.
func (m *SessionManager) EmptyBin() ([]string, error) {
	return m.emptyBinSelection((*FileSessionStore).emptyBinDeferred)
}

// emptyBinSelection is the shape both bin-emptying calls share: moveAside runs
// on the actor and renames the chosen folders into one staging directory, which
// trashAside then OS-trashes off it. Returns the ids moved aside.
func (m *SessionManager) emptyBinSelection(moveAside func(*FileSessionStore) (ids []string, trashPath string, err error)) ([]string, error) {
	ids, err := runWrite(m, func(s *sessionState) ([]string, error) {
		ids, trashPath, e := moveAside(s.store)
		if e == nil && trashPath != "" {
			m.trashAside(trashPath)
		}
		return ids, e
	})
	if err != nil {
		return nil, err
	}
	m.kickBinSizeRecompute()
	return ids, nil
}

// trashAside OS-trashes a staging directory the actor has just moved the
// emptied conversations into, on a goroutine so a multi-GB bin neither stalls
// other session writes nor plays one "moved to trash" sound per conversation.
// Called on the actor, so Shutdown covers it (see goBackground).
func (m *SessionManager) trashAside(path string) {
	m.goBackground(func() {
		if err := backgroundTrash(path); err != nil {
			jlog.Error("[session] empty bin: failed to trash %q: %v", path, err)
		}
		m.kickBinSizeRecompute()
	})
}

// EmptyBinOlderThan is EmptyBin restricted to binned conversations whose last
// activity is more than days old (see emptySelectionDeferred for what "old"
// measures). Splits the work the same way EmptyBin does: the actor renames the
// qualifying folders aside, a background goroutine OS-trashes them.
func (m *SessionManager) EmptyBinOlderThan(days int) ([]string, error) {
	cutoff := time.Now().AddDate(0, 0, -days)
	return m.emptyBinSelection(func(store *FileSessionStore) ([]string, string, error) {
		return store.emptySelectionDeferred(cutoff)
	})
}

// GetRuntimeInfo returns the runtime info for this manager's project.
func (m *SessionManager) GetRuntimeInfo() RuntimeInfo {
	return GetRuntimeInfo(m.projectPath)
}

// GetProjectPath returns the project path for this manager.
func (m *SessionManager) GetProjectPath() string {
	return m.projectPath
}

// GetWindowState returns the persisted native-window geometry for one of this
// project's window roles, or (zero, false) if none has been saved yet. Runs on
// the actor goroutine so it never races a concurrent save.
func (m *SessionManager) GetWindowState(role string) (WindowState, bool) {
	return runLookup(m, func(s *sessionState) (WindowState, bool) {
		if s.session == nil {
			return WindowState{}, false
		}
		s.session.migrateWindowStates()
		ws, ok := s.session.WindowStates[role]
		return ws, ok
	})
}

// SetWindowState persists the native-window geometry for one window role of this
// project and writes the session manifest. Runs on the actor goroutine, so the
// read-modify-write is atomic with respect to every other session mutation.
//
// Roles are separate slots on purpose: a detached board and the window it came
// from are different shapes, and one shared slot had each writing over the
// other's frame every time one of them closed.
//
// This is a geometry write. The frame comes from the live native window and so
// carries no appearance, and it arrives on every drag and resize — so the
// window's stored UI preferences are kept, not overwritten with the blank the
// caller could not have filled in. MergeWindowUIPrefs owns those.
func (m *SessionManager) SetWindowState(role string, ws WindowState) error {
	_, err := runWrite(m, func(s *sessionState) (struct{}, error) {
		// No session loaded (e.g. a no-project window still at the picker) —
		// there's nowhere to store geometry, so no-op rather than panic.
		if s.session == nil {
			return struct{}{}, nil
		}
		s.session.migrateWindowStates()
		if s.session.WindowStates == nil {
			s.session.WindowStates = map[string]WindowState{}
		}
		prev := s.session.WindowStates[role]
		ws.UI = prev.UI
		s.session.WindowStates[role] = ws
		return struct{}{}, s.store.Save(s.session)
	})
	return err
}

// setWindowPref applies one change to a window role's slot, creating the slot if
// this is the first thing ever stored about that window. A slot holding only UI
// preferences is fine: Place() reads a frameless one as "no saved geometry" and
// centres the window, exactly as a missing slot does.
func setWindowPref(s *sessionState, role string, apply func(*WindowState)) error {
	if s.session == nil {
		return nil
	}
	s.session.migrateWindowStates()
	if s.session.WindowStates == nil {
		s.session.WindowStates = map[string]WindowState{}
	}
	ws := s.session.WindowStates[role]
	apply(&ws)
	s.session.WindowStates[role] = ws
	return s.store.Save(s.session)
}

// GetUIZoom returns the UI zoom (root font-size %) this project's session holds,
// or (0, false) if it holds none. Runs on the actor goroutine so it never races a
// concurrent save. Nothing writes it: the zoom is a machine preference in
// settings.json (see web/js/utils/zoom-manager.js), and this is read only so
// serveIndex can offer it to the server's own window to adopt for a machine that
// has none.
func (m *SessionManager) GetUIZoom() (int, bool) {
	return runLookup(m, func(s *sessionState) (int, bool) {
		if s.session == nil || s.session.UIZoom <= 0 {
			return 0, false
		}
		return s.session.UIZoom, true
	})
}

// validUIThemeMode reports whether mode is a theme mode the web viewer accepts.
func validUIThemeMode(mode string) bool {
	return mode == "system" || mode == "light" || mode == "dark"
}

// GetUITheme returns the UI theme mode (system|light|dark) this project's
// session holds, or ("", false) if it holds none or one the viewer does not
// accept. Runs on the actor goroutine so it never races a concurrent save.
// Nothing writes it: the theme is a machine preference in settings.json (see
// web/js/utils/theme-manager.js), and this is read only so serveIndex can offer
// it to the server's own window to adopt for a machine that has none.
func (m *SessionManager) GetUITheme() (string, bool) {
	return runLookup(m, func(s *sessionState) (string, bool) {
		if s.session == nil || !validUIThemeMode(s.session.UITheme) {
			return "", false
		}
		return s.session.UITheme, true
	})
}

// GetPinboard returns one board's composition — the ordered pins of the panel
// with this id. Runs on the actor goroutine and returns a copy, so the caller
// can hand it straight to a JSON encoder without racing a concurrent edit. A
// board with nothing on it, and a board that does not exist, both answer with an
// empty slice rather than nil: the wire shape should be `[]`, not `null`, and a
// board is created by being written to rather than by being asked for.
func (m *SessionManager) GetPinboard(boardID string) []Pin {
	pins, _ := runRead(m, func(s *sessionState) ([]Pin, error) {
		if s.session == nil {
			return []Pin{}, nil
		}
		s.session.migrateBoards()
		return append([]Pin{}, s.session.Boards[boardID].Pins...), nil
	})
	return pins
}

// ApplyPinboardOps applies a batch of semantic edits to one board and persists
// the session, returning that board's resulting composition.
//
// The read-modify-write runs inside the actor closure, which is the whole point:
// two viewers editing the same board at the same instant are serialized here and
// both edits land, so no revision number, conflict response, or client rebase is
// needed. An invalid batch is rejected whole and the board is left untouched.
//
// Editing a board that does not exist creates it, which is what makes the main
// board need no setting up: the first pin added to a project is an add against
// "main", and the board is whatever that leaves behind.
//
// A no-project session (still at the picker) has nowhere to store a board, so it
// yields an empty one rather than an error.
func (m *SessionManager) ApplyPinboardOps(boardID string, ops []PinboardOp) ([]Pin, error) {
	return runWrite(m, func(s *sessionState) ([]Pin, error) {
		if s.session == nil {
			return []Pin{}, nil
		}
		s.session.migrateBoards()
		board := s.session.Boards[boardID]
		next, err := applyPinboardOps(board.Pins, ops)
		if err != nil {
			return nil, err
		}
		board.ID = boardID
		board.Pins = next
		s.session.setBoard(board)
		if err := s.store.Save(s.session); err != nil {
			return nil, err
		}
		return append([]Pin{}, next...), nil
	})
}

// ClaimBoardSeed answers whether the caller is the one to furnish this board
// with its starting tabs, and is true at most once in a board's life.
//
// Which tabs those are is not a question the server can answer: a pin's type is
// an item type published by an extension, and this package knows a type only as
// an opaque string. So the claim is all that lives here — the client holds the
// list, and asks first whether it is its place to lay it out. Being the one
// answer that must not be given twice, it is settled on the actor goroutine,
// where two windows opening together are serialized and the second is told no.
//
// The board is created by the winning claim, empty and marked, so a user who
// removes every tab it was given is left with an empty board rather than one
// that furnishes itself again on the next load.
//
// A board that already exists is never claimable, flag or no flag: it is an
// arrangement somebody has already made.
//
// Only the main board is ever furnished this way. A detached board is created
// carrying the tabs of the panel it was detached from, so one that is missing is
// not a new board waiting to be filled — it is a board that has been forgotten,
// and answering yes would put back a conversation-less orphan under its id.
func (m *SessionManager) ClaimBoardSeed(boardID string) bool {
	claimed, _ := runWrite(m, func(s *sessionState) (bool, error) {
		if s.session == nil || boardID != MainBoardID {
			return false, nil
		}
		s.session.migrateBoards()
		if _, ok := s.session.Boards[boardID]; ok {
			return false, nil
		}
		s.session.setBoard(Board{ID: boardID, Seeded: true})
		return true, s.store.Save(s.session)
	})
	return claimed
}

// CreateBoard records a detached board: a window's own composition, seeded with
// the pins it is to open on and tied to the conversation it is a view of.
//
// Creating one that already exists returns it unchanged rather than replacing
// it. A detach is a window opening, and a window that failed to open and was
// asked for again must not wipe the arrangement of the one that did.
func (m *SessionManager) CreateBoard(boardID, conversationID string, pins []Pin) (Board, error) {
	return runWrite(m, func(s *sessionState) (Board, error) {
		if s.session == nil {
			return Board{}, fmt.Errorf("no project is open")
		}
		if !ValidBoardID(boardID) {
			return Board{}, fmt.Errorf("invalid board id %q", boardID)
		}
		if boardID == MainBoardID {
			return Board{}, fmt.Errorf("the main board is not a window")
		}
		if conversationID == "" {
			return Board{}, fmt.Errorf("a detached board needs the conversation it views")
		}
		s.session.migrateBoards()
		if existing, ok := s.session.Boards[boardID]; ok {
			return existing.Clone(), nil
		}
		if len(s.session.Boards) >= MaxBoards {
			return Board{}, fmt.Errorf("too many boards: %d (max %d)", len(s.session.Boards), MaxBoards)
		}
		if len(pins) > MaxPins {
			return Board{}, fmt.Errorf("too many pins: %d (max %d)", len(pins), MaxPins)
		}
		board := Board{ID: boardID, Conversation: conversationID, Seeded: true, Pins: append([]Pin{}, pins...)}
		s.session.setBoard(board)
		if err := s.store.Save(s.session); err != nil {
			return Board{}, err
		}
		return board.Clone(), nil
	})
}

// DeleteBoard forgets a detached board and the geometry of the window that held
// it — what closing that window on purpose means. The main board cannot be
// deleted: it is the docked panel, and a project always has one.
//
// Deleting a board that is not there is not an error. The window closing and the
// app quitting can both reach this, and neither is in a position to know what
// the other has already done.
func (m *SessionManager) DeleteBoard(boardID string) error {
	_, err := runWrite(m, func(s *sessionState) (struct{}, error) {
		if s.session == nil {
			return struct{}{}, nil
		}
		if boardID == MainBoardID {
			return struct{}{}, fmt.Errorf("the main board cannot be removed")
		}
		s.session.migrateBoards()
		if _, ok := s.session.Boards[boardID]; !ok {
			return struct{}{}, nil
		}
		delete(s.session.Boards, boardID)
		delete(s.session.WindowStates, WindowRolePinboardFor(boardID))
		return struct{}{}, s.store.Save(s.session)
	})
	return err
}

// ClaimDetachedBoards answers, once per run of this server, with the detached
// boards left over from the last one — the windows that were open when Juggler
// was last shut, in board order by id so two runs restore the same way.
//
// Once, because the answer is an instruction to open windows. Every main window
// of a project asks, and a project can have several; the second to ask must be
// told nothing rather than open a second copy of every board. The claim is
// deliberately not persisted: it is about this process, and a board stays
// restorable for as long as it exists.
//
// A board whose conversation has gone is dropped here rather than handed out,
// along with the geometry of the window that held it. Forgetting boards as a
// conversation is deleted or binned covers the ways a conversation goes through
// this server, and it is where a board should be forgotten. It cannot cover a
// conversation removed from the project folder by hand. This is the last point
// at which such a board can be caught, and the only one that is asked before a
// window is opened onto it — so it is checked here as well, and a board that
// answers for nothing is finished with.
func (m *SessionManager) ClaimDetachedBoards() []Board {
	boards, _ := runWrite(m, func(s *sessionState) ([]Board, error) {
		if s.session == nil || s.boardsClaimed {
			return []Board{}, nil
		}
		s.boardsClaimed = true
		s.session.migrateBoards()
		detached := []Board{}
		dropped := false
		for id, board := range s.session.Boards {
			if !board.IsDetached() {
				continue
			}
			if !s.session.hasConversation(board.Conversation) {
				delete(s.session.Boards, id)
				delete(s.session.WindowStates, WindowRolePinboardFor(id))
				dropped = true
				continue
			}
			detached = append(detached, board.Clone())
		}
		sort.Slice(detached, func(i, j int) bool { return detached[i].ID < detached[j].ID })
		// Only a claim that dropped something has anything to write, so the
		// ordinary one still costs no disk.
		if !dropped {
			return detached, nil
		}
		return detached, s.store.Save(s.session)
	})
	return boards
}

// PatchMetadata applies a targeted key-by-key patch to the session metadata
// map and persists the manifest, returning the set of changed keys (nil value
// = key deleted). It is a thin convenience over Update: the mutation runs on the
// actor goroutine, the sole accessor of the live map, so the in-place
// read-modify-write is atomic with respect to every other session operation.
func (m *SessionManager) PatchMetadata(patch map[string]any) (map[string]any, error) {
	changed := make(map[string]any, len(patch))
	err := m.Update(func(s *Session) error {
		if s.Metadata == nil {
			s.Metadata = map[string]any{}
		}
		for key, value := range patch {
			if value == nil {
				delete(s.Metadata, key)
				changed[key] = nil
			} else {
				s.Metadata[key] = value
				changed[key] = value
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return changed, nil
}

// reanchorBoxesAt moves every box placed behind convID onto that conversation's
// predecessor in the order, so a workspace keeps the place it is drawn in when
// the conversation it happens to sit behind goes away. A box behind the first
// conversation inherits the head of the bar, named as such — the box really is
// at the top, which is a different statement from having no place at all.
//
// It reads the predecessor from ConversationOrder, so it must run while convID
// is still in it. Reports whether any box was anchored there to move.
func reanchorBoxesAt(s *Session, convID string) bool {
	predecessor := PlaceHead
	for i, id := range s.ConversationOrder {
		if id != convID {
			continue
		}
		if i > 0 {
			predecessor = s.ConversationOrder[i-1]
		}
		break
	}
	moved := false
	for i := range s.Workspaces {
		if s.Workspaces[i].Place == convID {
			s.Workspaces[i].Place = predecessor
			moved = true
		}
	}
	return moved
}

// removeConvIDFromSession drops convID from ConversationOrder and clears
// ActiveConversationID if it pointed at convID. Shared by delete and bin
// flows.
func removeConvIDFromSession(s *Session, convID string) {
	// Before it leaves the order, while it still has a neighbour to hand on to.
	reanchorBoxesAt(s, convID)

	newOrder := make([]string, 0, len(s.ConversationOrder))
	for _, id := range s.ConversationOrder {
		if id != convID {
			newOrder = append(newOrder, id)
		}
	}
	s.ConversationOrder = newOrder
	if s.ActiveConversationID == convID {
		s.ActiveConversationID = ""
	}
}
