//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
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
	m.goroutines.Add(3)
	go func() { defer m.goroutines.Done(); m.run() }()
	go func() { defer m.goroutines.Done(); m.runBinSizeMonitor(store) }()
	go func() { defer m.goroutines.Done(); m.sweepOrphanedEmptyingDirs(store) }()
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

// sweepOrphanedEmptyingDirs trashes any .juggler/trash.emptying-* directories
// left behind by an EmptyBin whose background trash step was interrupted (e.g.
// the process exited before it finished). Runs once at startup, off the actor,
// so it never delays session load. Best-effort: failures are logged, not fatal.
func (m *SessionManager) sweepOrphanedEmptyingDirs(store *FileSessionStore) {
	for _, dir := range store.orphanedEmptyingDirs() {
		if err := trashOrRemove(dir); err != nil {
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

// runRead submits fn to the read channel and waits for its result.
func runRead[T any](m *SessionManager, fn func(*sessionState) (T, error)) (T, error) {
	out := make(chan struct {
		v   T
		err error
	}, 1)
	m.readChan <- func(s *sessionState) {
		v, err := fn(s)
		out <- struct {
			v   T
			err error
		}{v, err}
	}
	r := <-out
	return r.v, r.err
}

// runWrite submits fn to the write channel and waits for its result.
func runWrite[T any](m *SessionManager, fn func(*sessionState) (T, error)) (T, error) {
	out := make(chan struct {
		v   T
		err error
	}, 1)
	m.writeChan <- func(s *sessionState) {
		v, err := fn(s)
		out <- struct {
			v   T
			err error
		}{v, err}
	}
	r := <-out
	return r.v, r.err
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
	type result struct {
		id   string
		name string
	}
	idHint := ""
	if len(requestedID) > 0 {
		idHint = requestedID[0]
	}
	r, err := runWrite(m, func(s *sessionState) (result, error) {
		id, finalName, _, err := s.store.CreateConversationFolder(name, idHint)
		if err != nil {
			return result{}, err
		}
		if !slices.Contains(s.session.ConversationOrder, id) {
			s.session.ConversationOrder = append([]string{id}, s.session.ConversationOrder...)
		}
		if err := s.store.Save(s.session); err != nil {
			return result{}, err
		}
		return result{id, finalName}, nil
	})
	if err != nil {
		return "", "", err
	}
	return r.id, r.name, nil
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
func (m *SessionManager) ReorderConversations(order []string) ([]string, error) {
	return runWrite(m, func(s *sessionState) ([]string, error) {
		known := make([]string, 0, len(order))
		for _, id := range order {
			if _, ok := s.store.ConvDir(id); ok {
				known = append(known, id)
			}
		}
		s.session.ConversationOrder = mergeConversationOrder(s.session.ConversationOrder, known)
		merged := append([]string(nil), s.session.ConversationOrder...)
		return merged, s.store.Save(s.session)
	})
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
	type result struct {
		dir string
		ok  bool
	}
	r, _ := runRead(m, func(s *sessionState) (result, error) {
		dir, ok := s.store.ConvDir(convID)
		return result{dir, ok}, nil
	})
	return r.dir, r.ok
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
	_, err := runWrite(m, func(s *sessionState) (struct{}, error) {
		removeConvIDFromSession(s.session, convID)
		s.session.removeBoardsForConversation(convID)
		if err := s.store.BinConversation(convID); err != nil {
			return struct{}{}, err
		}
		if err := s.store.Save(s.session); err != nil {
			return struct{}{}, fmt.Errorf("failed to save session after binning conversation: %w", err)
		}
		return struct{}{}, nil
	})
	if err == nil {
		m.kickBinSizeRecompute()
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
	type emptied struct {
		ids       []string
		trashPath string
	}
	r, err := runWrite(m, func(s *sessionState) (emptied, error) {
		ids, trashPath, e := s.store.emptyBinDeferred()
		if e == nil && trashPath != "" {
			m.trashAside(trashPath)
		}
		return emptied{ids: ids, trashPath: trashPath}, e
	})
	if err != nil {
		return nil, err
	}
	m.kickBinSizeRecompute()
	return r.ids, nil
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
	type emptied struct {
		ids       []string
		trashPath string
	}
	r, err := runWrite(m, func(s *sessionState) (emptied, error) {
		ids, trashPath, e := s.store.emptySelectionDeferred(cutoff)
		if e == nil && trashPath != "" {
			m.trashAside(trashPath)
		}
		return emptied{ids: ids, trashPath: trashPath}, e
	})
	if err != nil {
		return nil, err
	}
	m.kickBinSizeRecompute()
	return r.ids, nil
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
	type result struct {
		ws WindowState
		ok bool
	}
	r, _ := runRead(m, func(s *sessionState) (result, error) {
		if s.session == nil {
			return result{}, nil
		}
		s.session.migrateWindowStates()
		ws, ok := s.session.WindowStates[role]
		return result{ws, ok}, nil
	})
	return r.ws, r.ok
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
// window's stored theme and zoom are kept, not overwritten with the blanks the
// caller could not have filled in. SetWindowUITheme/SetWindowUIZoom own those.
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
		ws.Theme, ws.Zoom = prev.Theme, prev.Zoom
		s.session.WindowStates[role] = ws
		return struct{}{}, s.store.Save(s.session)
	})
	return err
}

// setWindowPref applies one change to a window role's slot, creating the slot if
// this is the first thing ever stored about that window. A slot holding only an
// appearance is fine: Place() reads a frameless one as "no saved geometry" and
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

// GetUIZoom returns the persisted UI zoom (root font-size %) for this project,
// or (0, false) if none has been saved yet. Runs on the actor goroutine so it
// never races a concurrent save. Zoom is per-project session state — like
// WindowState — but, unlike geometry, it is surfaced to the web viewer so a
// reopened project paints at the size the user left it.
func (m *SessionManager) GetUIZoom() (int, bool) {
	type result struct {
		zoom int
		ok   bool
	}
	r, _ := runRead(m, func(s *sessionState) (result, error) {
		if s.session == nil || s.session.UIZoom <= 0 {
			return result{}, nil
		}
		return result{s.session.UIZoom, true}, nil
	})
	return r.zoom, r.ok
}

// SetUIZoom persists the UI zoom for this project and writes the session
// manifest. A non-positive value or a no-project session (still at the picker)
// is a no-op — there is nowhere to store it — mirroring SetWindowState.
//
// This is the desktop window's size. Only a viewer on this machine may set it:
// the route is wrapped in localViewerOnly, so a phone or laptop browsing in
// remotely keeps its own size in its own localStorage instead.
func (m *SessionManager) SetUIZoom(zoom int) error {
	if zoom <= 0 {
		return nil
	}
	_, err := runWrite(m, func(s *sessionState) (struct{}, error) {
		if s.session == nil {
			return struct{}{}, nil
		}
		s.session.UIZoom = zoom
		return struct{}{}, s.store.Save(s.session)
	})
	return err
}

// validUIThemeMode reports whether mode is a theme mode the web viewer accepts.
func validUIThemeMode(mode string) bool {
	return mode == "system" || mode == "light" || mode == "dark"
}

// GetUITheme returns the persisted UI theme mode (system|light|dark) for this
// project, or ("", false) if none has been saved yet. Runs on the actor
// goroutine so it never races a concurrent save. Like UIZoom this is per-project
// session state, surfaced to the web viewer so a reopened project paints in the
// theme the user left it — not whichever theme another project last wrote to the
// origin-shared localStorage (every project's server reuses the same port).
func (m *SessionManager) GetUITheme() (string, bool) {
	type result struct {
		mode string
		ok   bool
	}
	r, _ := runRead(m, func(s *sessionState) (result, error) {
		if s.session == nil || !validUIThemeMode(s.session.UITheme) {
			return result{}, nil
		}
		return result{s.session.UITheme, true}, nil
	})
	return r.mode, r.ok
}

// SetUITheme persists the UI theme mode for this project and writes the session
// manifest. An unrecognised mode or a no-project session (still at the picker)
// is a no-op — mirroring SetUIZoom, including its local-viewer-only route guard.
func (m *SessionManager) SetUITheme(mode string) error {
	if !validUIThemeMode(mode) {
		return nil
	}
	_, err := runWrite(m, func(s *sessionState) (struct{}, error) {
		if s.session == nil {
			return struct{}{}, nil
		}
		s.session.UITheme = mode
		return struct{}{}, s.store.Save(s.session)
	})
	return err
}

// GetWindowUITheme returns the UI theme mode one window role should paint in:
// its own if it has been given one, else the project's, else ("", false).
//
// The fallback is what keeps a project coherent. A window only stops following
// the project when the user changes the theme in that window, so opening a
// second board does not produce a window in some other colour than the one it
// was opened from.
func (m *SessionManager) GetWindowUITheme(role string) (string, bool) {
	type result struct {
		mode string
		ok   bool
	}
	r, _ := runRead(m, func(s *sessionState) (result, error) {
		if s.session == nil {
			return result{}, nil
		}
		s.session.migrateWindowStates()
		if mode := s.session.WindowStates[role].Theme; validUIThemeMode(mode) {
			return result{mode, true}, nil
		}
		if validUIThemeMode(s.session.UITheme) {
			return result{s.session.UITheme, true}, nil
		}
		return result{}, nil
	})
	return r.mode, r.ok
}

// SetWindowUITheme records the theme mode one window is wearing. The main
// window also sets the project's, so a window opened later — a board detached
// tomorrow, a project reopened from Finder — starts out matching Juggler itself
// rather than the theme of whichever board was restyled last.
func (m *SessionManager) SetWindowUITheme(role, mode string) error {
	if !validUIThemeMode(mode) {
		return nil
	}
	_, err := runWrite(m, func(s *sessionState) (struct{}, error) {
		if s.session == nil {
			return struct{}{}, nil
		}
		if role == WindowRoleMain {
			s.session.UITheme = mode
		}
		return struct{}{}, setWindowPref(s, role, func(ws *WindowState) { ws.Theme = mode })
	})
	return err
}

// GetWindowUIZoom returns the UI zoom one window role should paint at: its own
// if it has been given one, else the project's, else (0, false). Mirrors
// GetWindowUITheme, including why it falls back.
func (m *SessionManager) GetWindowUIZoom(role string) (int, bool) {
	type result struct {
		zoom int
		ok   bool
	}
	r, _ := runRead(m, func(s *sessionState) (result, error) {
		if s.session == nil {
			return result{}, nil
		}
		s.session.migrateWindowStates()
		if zoom := s.session.WindowStates[role].Zoom; zoom > 0 {
			return result{zoom, true}, nil
		}
		if s.session.UIZoom > 0 {
			return result{s.session.UIZoom, true}, nil
		}
		return result{}, nil
	})
	return r.zoom, r.ok
}

// SetWindowUIZoom records the zoom one window is at, and the project's too when
// that window is the main one — mirroring SetWindowUITheme.
func (m *SessionManager) SetWindowUIZoom(role string, zoom int) error {
	if zoom <= 0 {
		return nil
	}
	_, err := runWrite(m, func(s *sessionState) (struct{}, error) {
		if s.session == nil {
			return struct{}{}, nil
		}
		if role == WindowRoleMain {
			s.session.UIZoom = zoom
		}
		return struct{}{}, setWindowPref(s, role, func(ws *WindowState) { ws.Zoom = zoom })
	})
	return err
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

// removeConvIDFromSession drops convID from ConversationOrder, Conversations,
// and clears ActiveConversationID if it pointed at convID. Shared by delete
// and bin flows.
func removeConvIDFromSession(s *Session, convID string) {
	newOrder := make([]string, 0, len(s.ConversationOrder))
	for _, id := range s.ConversationOrder {
		if id != convID {
			newOrder = append(newOrder, id)
		}
	}
	s.ConversationOrder = newOrder

	newConversations := make([]json.RawMessage, 0, len(s.Conversations))
	for _, conv := range s.Conversations {
		var obj struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(conv, &obj); err == nil && obj.ID != convID {
			newConversations = append(newConversations, conv)
		}
	}
	s.Conversations = newConversations
	if s.ActiveConversationID == convID {
		s.ActiveConversationID = ""
	}
}
