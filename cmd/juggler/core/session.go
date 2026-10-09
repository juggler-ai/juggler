//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"time"

	"juggler/internal/atomicio"
	"juggler/internal/jlog"
)

// BinnedConvInfo describes a conversation that lives in .juggler/trash/.
// Sent over the wire to populate the Bin modal. The bin is a permanent holding
// area — items stay until the user restores them or empties the bin — so there
// is no expiry/binned-at timestamp to track.
type BinnedConvInfo struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	LastModifiedAt string `json:"lastModifiedAt"` // ISO 8601, the last time the conversation was actually edited (see lastActivityTime), not when it was binned
}

// ============================================================================
// Session Types
// ============================================================================

// RuntimeInfo contains environment info injected at runtime (not persisted)
type RuntimeInfo struct {
	ProjectPath string `json:"projectPath"`
	Platform    string `json:"platform"`
	Home        string `json:"home"`
}

// GetRuntimeInfo returns current runtime environment info
func GetRuntimeInfo(projectPath string) RuntimeInfo {
	home, _ := os.UserHomeDir()
	return RuntimeInfo{
		ProjectPath: projectPath,
		Platform:    runtime.GOOS,
		Home:        home,
	}
}

// Window roles. Geometry is kept per role, because a project's windows are not
// all the same shape: WindowRoleMain is Juggler itself, and WindowRolePinboard
// is a board detached into a window of its own. One shared frame would have each
// kind overwriting the other's every time one of them closed.
const (
	WindowRoleMain     = "main"
	WindowRolePinboard = "pinboard"
)

// WindowRolePinboardFor names the geometry slot of one detached board's window.
//
// Each board gets its own slot rather than every board sharing the "pinboard"
// one. Two boards are two windows the user placed somewhere on purpose, and a
// single slot had the second one opened land on top of the first and the last
// one closed decide where all of them opened next time.
func WindowRolePinboardFor(boardID string) string {
	return WindowRolePinboard + ":" + boardID
}

// WindowViewPinboard is the "view" a detached board's page URL carries. The
// desktop app puts it there when it opens the window, and it comes back on every
// request for that page — which is what lets the server tell one window's role
// from another's without the page having to say so.
const WindowViewPinboard = "pinboard"

// WindowRoleForView names the window role a page URL describes, from the view
// and board parameters the desktop app baked into it.
//
// Anything that is not a board is the main window, and a board whose id did not
// survive the round trip falls back to the shared "pinboard" slot rather than
// inventing a role named after a malformed id. This mirrors the desktop app's
// own role(), so the app and the server always name the same window the same way.
func WindowRoleForView(view, boardID string) string {
	if view != WindowViewPinboard {
		return WindowRoleMain
	}
	if !ValidBoardID(boardID) {
		return WindowRolePinboard
	}
	return WindowRolePinboardFor(boardID)
}

// WindowState is one of this project's windows: the native geometry it was left
// in, and the look it was left wearing. It is session state (persisted in
// .juggler/session.json) rather than a single machine-global file: keying it by
// project gives each project's windows their own slots with no cross-process
// write race, and reopening a project restores its windows as they were.
// Process-local; deliberately NOT part of Metadata, so it is never sent to
// viewers or surfaced as a frontend flag.
//
// Theme and Zoom sit beside the frame because they are the same kind of fact
// about the same window: a board detached onto a second display is a window the
// user set up on purpose, and its appearance belongs to it rather than to
// whichever window last touched the project. Both are unset ("" / 0) until that
// window is told otherwise, and an unset one falls back to the project-wide
// UITheme/UIZoom — so a board nobody has restyled still follows the main window.
//
// UI is the same kind of fact again, one level less structured: the preferences
// the viewer keeps for this window (see ui_prefs.go). Nothing in Go reads them,
// so they are stored opaquely.
//
// Geometry writes never carry any of it: the frame is captured from the live
// native window (see windowgeom.Tracker.Capture) and knows nothing about
// appearance, so SetWindowState preserves whatever is already stored.
type WindowState struct {
	X          int                        `json:"x"`
	Y          int                        `json:"y"`
	Width      int                        `json:"width"`
	Height     int                        `json:"height"`
	HasPos     bool                       `json:"hasPos"`
	Maximised  bool                       `json:"maximised"`
	Fullscreen bool                       `json:"fullscreen"`
	Theme      string                     `json:"theme,omitempty"` // UI theme mode (system|light|dark) for this window; "" follows the project
	Zoom       int                        `json:"zoom,omitempty"`  // UI zoom (root font-size %) for this window; 0 follows the project
	UI         map[string]json.RawMessage `json:"ui,omitempty"`    // This window's UI preferences, stored verbatim (the client owns the shape); nil until one is set
}

// Clone returns a private copy of one window's slot. The UI map is the reason
// it exists: a map inside a struct value is copied by reference, so a caller
// handed the struct would share that map with whoever else holds a copy.
func (ws WindowState) Clone() WindowState {
	ws.UI = cloneUIPrefs(ws.UI)
	return ws
}

// SameFrame reports whether two slots describe the same native window frame,
// ignoring everything that is not geometry.
//
// It exists because WindowState holds a map and so cannot be compared with ==.
// That is the useful outcome rather than an obstacle: almost every comparison
// here is asking about the frame, and one that silently started including the
// viewer's preferences would answer a question nobody asked.
func (ws WindowState) SameFrame(other WindowState) bool {
	return ws.X == other.X && ws.Y == other.Y &&
		ws.Width == other.Width && ws.Height == other.Height &&
		ws.HasPos == other.HasPos &&
		ws.Maximised == other.Maximised && ws.Fullscreen == other.Fullscreen
}

// Session represents the folder state with multiple conversations.
// There is exactly one session per folder.
//
// Conversation human-readable names are not persisted in this manifest:
// the on-disk folder name (.juggler/<sanitized-name>--<id>/) is the source of
// truth, parsed by ScanConvDirs at load time.
type Session struct {
	Version              int                        `json:"version"`                // Schema version
	ConversationOrder    []string                   `json:"conversationOrder"`      // Ordered list of conversation IDs (for tab ordering)
	ActiveConversationID string                     `json:"activeConversationId"`   // Currently selected conversation tab (persisted for refresh)
	MessageHistory       []json.RawMessage          `json:"messageHistory"`         // Session-level history of user messages for input navigation. Opaque JSON entries: the server stores and forwards them verbatim (the client owns the shape).
	Metadata             map[string]any             `json:"metadata,omitempty"`     // General-purpose key-value store for frontend flags
	WindowState          *WindowState               `json:"windowState,omitempty"`  // Geometry written by a Juggler that had one window slot; folded into WindowStates["main"] on first use (see migrateWindowStates)
	WindowStates         map[string]WindowState     `json:"windowStates,omitempty"` // Native-window geometry for this project, per window role (nil until first save)
	UIZoom               int                        `json:"uiZoom,omitempty"`       // Project-wide UI zoom (root font-size %), followed by any window without one of its own; 0 until first set
	UITheme              string                     `json:"uiTheme,omitempty"`      // Project-wide UI theme mode (system|light|dark), followed by any window without one of its own; "" until first set
	UI                   map[string]json.RawMessage `json:"ui,omitempty"`           // UI preferences shared by every window of this project, stored verbatim (the client owns the shape); see ui_prefs.go
	Pinboard             []Pin                      `json:"pinboard,omitempty"`     // Board written by a Juggler that had one; folded into Boards["main"] on first use (see migrateBoards)
	Boards               map[string]Board           `json:"boards,omitempty"`       // Pinboard compositions by board id: "main" is the docked panel, the rest are detached windows (see pinboard.go)
	Workspaces           []Workspace                `json:"workspaces,omitempty"`   // The places conversations run, other than the project itself (see workspace.go); nil until one is made

	// unknown holds the manifest keys this build does not recognise, kept
	// verbatim so that saving gives them back. See UnmarshalJSON.
	unknown map[string]json.RawMessage
}

// sessionJSONKeys is every key this build writes, derived from the struct so it
// cannot drift from it. A field tagged "-" is in-memory only and is not a
// manifest key at all.
var sessionJSONKeys = func() map[string]bool {
	keys := map[string]bool{}
	t := reflect.TypeOf(Session{})
	for i := 0; i < t.NumField(); i++ {
		tag := t.Field(i).Tag.Get("json")
		name, _, _ := strings.Cut(tag, ",")
		if name == "" || name == "-" {
			continue
		}
		keys[name] = true
	}
	return keys
}()

// UnmarshalJSON reads the manifest and remembers any key it does not recognise.
//
// Without this, running an older Juggler on a newer project is quietly
// destructive: it parses what it knows, drops the rest, and writes the loss back
// on the next save. Nothing announces it — the user downgrades, works for an
// afternoon, upgrades again, and finds every conversation bound to a workspace
// pointing at nothing. Keeping the bytes costs one map.
func (s *Session) UnmarshalJSON(data []byte) error {
	type manifest Session // no methods, so this does not recurse
	var parsed manifest
	if err := json.Unmarshal(data, &parsed); err != nil {
		return err
	}
	*s = Session(parsed)

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	for key := range raw {
		if sessionJSONKeys[key] {
			delete(raw, key)
		}
	}
	if len(raw) > 0 {
		s.unknown = raw
	}
	return nil
}

// MarshalJSON writes the manifest with the unrecognised keys put back.
//
// A key this build knows always wins: the kept bytes are what was there when it
// was read, and anything written since is what the user has actually done.
func (s Session) MarshalJSON() ([]byte, error) {
	type manifest Session
	known, err := json.Marshal(manifest(s))
	if err != nil {
		return nil, err
	}
	if len(s.unknown) == 0 {
		return known, nil
	}
	merged := map[string]json.RawMessage{}
	for key, value := range s.unknown {
		merged[key] = value
	}
	var mine map[string]json.RawMessage
	if err := json.Unmarshal(known, &mine); err != nil {
		return nil, err
	}
	for key, value := range mine {
		merged[key] = value
	}
	return json.Marshal(merged)
}

// NewSession creates a new session with initial state
func NewSession() *Session {
	return &Session{
		Version:           5,
		ConversationOrder: []string{},
		MessageHistory:    []json.RawMessage{},
	}
}

// Clone returns a private copy of the session that the caller may read or
// mutate freely without ever touching the original. Every container the rest of
// the code mutates — each slice, the maps inside and beside them (including the
// one inside each window's slot), the WindowState pointer — is duplicated, so a
// snapshot handed out by
// SessionManager.GetSession can never race the actor goroutine that owns the
// live session. (RawMessage payloads and metadata values are shared by
// reference: both are only ever replaced wholesale, never mutated in place.)
func (s *Session) Clone() *Session {
	if s == nil {
		return nil
	}
	c := *s
	c.ConversationOrder = append([]string(nil), s.ConversationOrder...)
	c.MessageHistory = append([]json.RawMessage(nil), s.MessageHistory...)
	c.Pinboard = append([]Pin(nil), s.Pinboard...)
	if s.Boards != nil {
		c.Boards = make(map[string]Board, len(s.Boards))
		for id, board := range s.Boards {
			c.Boards[id] = board.Clone()
		}
	}
	if s.unknown != nil {
		c.unknown = make(map[string]json.RawMessage, len(s.unknown))
		for k, v := range s.unknown {
			c.unknown[k] = v
		}
	}
	if s.Workspaces != nil {
		c.Workspaces = make([]Workspace, len(s.Workspaces))
		for i, ws := range s.Workspaces {
			c.Workspaces[i] = ws.Clone()
		}
	}
	if s.Metadata != nil {
		c.Metadata = make(map[string]any, len(s.Metadata))
		for k, v := range s.Metadata {
			c.Metadata[k] = v
		}
	}
	if s.WindowState != nil {
		ws := *s.WindowState
		c.WindowState = &ws
	}
	if s.WindowStates != nil {
		c.WindowStates = make(map[string]WindowState, len(s.WindowStates))
		for role, ws := range s.WindowStates {
			c.WindowStates[role] = ws.Clone()
		}
	}
	c.UI = cloneUIPrefs(s.UI)
	return &c
}

// migrateWindowStates folds a single-slot geometry written by an earlier Juggler
// into the role map, as the main window's — which is the only window that
// version could have been describing.
//
// Run before every read and write of geometry rather than at load: geometry is
// touched by exactly those two paths, so this is where the old value is
// certainly seen, and the next save writes the migrated shape out. An existing
// main entry always wins; the old field is only ever a fallback.
func (s *Session) migrateWindowStates() {
	if s.WindowState == nil {
		return
	}
	if s.WindowStates == nil {
		s.WindowStates = map[string]WindowState{}
	}
	if _, ok := s.WindowStates[WindowRoleMain]; !ok {
		s.WindowStates[WindowRoleMain] = *s.WindowState
	}
	s.WindowState = nil
}

// migrateBoards folds the single board written by an earlier Juggler into the
// board map, as the main one — which is the only board that version could have
// had, since it had no way to detach a second.
//
// Run before every read and write of a board, on migrateWindowStates' pattern
// and for the same reason: those are the paths that certainly see the old value,
// and the next save writes the migrated shape out. An existing main board always
// wins; the old field is only ever a fallback.
//
// A session with nothing pinned migrates to nothing rather than to an empty main
// board. The board map is the arrangement the user made, and a project they
// never opened the panel in has not made one.
//
// Every board that is already here counts as seeded, whether or not it carries
// the flag. A board written by a Juggler that placed no starting tabs is one the
// user arranged themselves, and filling it now would drop six tabs into a board
// they had already made their own.
func (s *Session) migrateBoards() {
	for id, board := range s.Boards {
		if !board.Seeded {
			board.Seeded = true
			s.Boards[id] = board
		}
	}
	if len(s.Pinboard) == 0 {
		s.Pinboard = nil
		return
	}
	if s.Boards == nil {
		s.Boards = map[string]Board{}
	}
	if _, ok := s.Boards[MainBoardID]; !ok {
		s.Boards[MainBoardID] = Board{ID: MainBoardID, Seeded: true, Pins: s.Pinboard}
	}
	s.Pinboard = nil
}

// setBoard stores a board, or drops it when there is nothing left worth keeping.
//
// An empty main board that has never been seeded is not stored: it is
// indistinguishable from never having opened the panel, and leaving the key
// behind would put an empty arrangement in every project's session.json. A
// seeded one is stored however empty it is — that emptiness is a board the user
// cleared, and dropping the key would have the next load furnish it again. An
// empty *detached* board is stored too, because the window it belongs to is
// still open and still has to come back.
func (s *Session) setBoard(board Board) {
	if len(board.Pins) == 0 && !board.IsDetached() && !board.Seeded {
		delete(s.Boards, board.ID)
		return
	}
	if s.Boards == nil {
		s.Boards = map[string]Board{}
	}
	s.Boards[board.ID] = board
}

// removeBoardsForConversation forgets every detached board that is a view of
// one conversation, along with the geometry of the window each one held.
//
// A board is a window onto one conversation and stays there, so a conversation
// that has gone leaves its boards nothing to be a view of — and a board kept
// past that is a window reopened, next run, onto a transcript that no longer
// exists. The main board names no conversation and is never touched.
//
// Returns the ids removed, in board order, so a caller can say what it did.
func (s *Session) removeBoardsForConversation(convID string) []string {
	if convID == "" {
		return nil
	}
	s.migrateBoards()
	var removed []string
	for id, board := range s.Boards {
		if board.Conversation != convID {
			continue
		}
		delete(s.Boards, id)
		delete(s.WindowStates, WindowRolePinboardFor(id))
		removed = append(removed, id)
	}
	sort.Strings(removed)
	return removed
}

// hasConversation reports whether a conversation is one of this project's
// active ones. ConversationOrder is the authority: it holds exactly the
// conversations the bar can open, and the on-load reconcile keeps it to the
// folders that are actually there. A binned or deleted conversation has already
// left it.
func (s *Session) hasConversation(convID string) bool {
	for _, id := range s.ConversationOrder {
		if id == convID {
			return true
		}
	}
	return false
}

// Validate checks if the session is valid
func (s *Session) Validate() error {
	if s.Version != 5 {
		return fmt.Errorf("unsupported session version: %d (expected 5)", s.Version)
	}
	if s.ConversationOrder == nil {
		return fmt.Errorf("session must have conversationOrder array (can be empty)")
	}

	return nil
}

// Common errors
var (
	ErrSessionNotFound      = fmt.Errorf("session not found")
	ErrConversationNotFound = fmt.Errorf("conversation not found")
	ErrNameCollision        = fmt.Errorf("conversation name already in use")
	ErrInvalidName          = fmt.Errorf("conversation name is invalid")
	ErrInvalidConvID        = fmt.Errorf("invalid conversation id")
	ErrConvIDExists         = fmt.Errorf("conversation id already exists")
)

// ============================================================================
// FileSessionStore - file I/O methods (no goroutine, called from SessionManager)
// ============================================================================

// FileSessionStore implements session persistence using the filesystem.
// Session state is stored in {projectPath}/.juggler/: session.json holds the
// manifest (version, conversationOrder, activeConversationId, messageHistory,
// metadata), and one folder per conversation holds the rest. Those folders are
// convdir.go's subject — their name, their contents, and the accessors for
// both — so the layout is described there rather than restated here.
//
// The folder name carries the human-readable conversation name; renames
// rename the folder (atomic os.Rename). The id stays as the stable handle
// used everywhere in code.
//
// This struct has no goroutine of its own; all methods are called from
// SessionManager's actor goroutine, which provides serialized access.
// `index` mirrors the on-disk folder layout and is rebuilt on Load and
// mutated by Save/Delete/Rename.
type FileSessionStore struct {
	projectPath string
	index       *ConvDirIndex
	// binIndex mirrors the layout of .juggler/trash/ — conversation folders
	// that have been binned. Same shape as index; rebuilt on Load and mutated
	// by BinConversation/RestoreConversation.
	binIndex *ConvDirIndex
	// deletedIDs tracks conversations explicitly deleted this session.
	// ensureConvDir consults it to refuse recreating a folder that was just
	// deleted, which would otherwise create an orphan "Untitled--<id>" ghost
	// picked up by reconcileConversationOrder on the next session load.
	// Populated by DeleteConversation; all access is from the SessionManager
	// actor goroutine, so no mutex is needed.
	deletedIDs map[string]bool
}

// NewFileSessionStore creates a new file-based store
func NewFileSessionStore(projectPath string) (*FileSessionStore, error) {
	jugglerDir := filepath.Join(projectPath, ".juggler")
	if err := os.MkdirAll(jugglerDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create .juggler directory: %w", err)
	}

	return &FileSessionStore{
		projectPath: projectPath,
		index:       NewConvDirIndex(),
		binIndex:    NewConvDirIndex(),
		deletedIDs:  make(map[string]bool),
	}, nil
}

// ConvDir returns the absolute folder path for the conversation, or "" if
// the conversation is unknown.
func (fs *FileSessionStore) ConvDir(convID string) (string, bool) {
	if fs.index == nil {
		return "", false
	}
	dir, ok := fs.index.ByID[convID]
	return dir, ok
}

// ConvName returns the human-readable name of one conversation, or ok=false
// if the conversation is unknown. The name lives in the folder name, so this
// is the answer for anyone who needs the name but has no business knowing how
// a folder is spelled.
func (fs *FileSessionStore) ConvName(convID string) (string, bool) {
	if fs.index == nil {
		return "", false
	}
	name, ok := fs.index.Names[convID]
	return name, ok
}

// ConvNames returns a snapshot of id → human name for every conversation
// folder currently on disk. Safe to expose over the wire.
func (fs *FileSessionStore) ConvNames() map[string]string {
	out := make(map[string]string, len(fs.index.Names))
	for id, name := range fs.index.Names {
		out[id] = name
	}
	return out
}

// CreateConversationFolder creates a conversation folder for requestedID, or
// allocates a fresh id when requestedID is empty. It picks a case-folded-unique
// folder name based on the requested display name (sanitized; empty falls back
// to "Untitled"; collisions get a " (copy N)" suffix), and creates the folder
// on disk. Returns the id, the canonical name actually used, and the folder
// path.
//
// This is the authoritative entry point for creating a new conversation:
// the on-disk folder name is the source of truth for the conversation's
// display name from the very first moment, with no "Untitled" stage and
// no follow-up rename. Subsequent worker saves go through ensureConvDir
// and find this folder by id, preserving the name.
func (fs *FileSessionStore) CreateConversationFolder(name, requestedID string) (string, string, string, error) {
	if fs.index == nil {
		fs.index = NewConvDirIndex()
	}
	sanitized := SanitizeName(name)
	if sanitized == "" {
		sanitized = UntitledBase
	}
	id := requestedID
	if id == "" {
		id = GenerateConvID()
	} else if !IsValidConvID(id) {
		return "", "", "", fmt.Errorf("%w: %q", ErrInvalidConvID, id)
	}
	if _, exists := fs.index.ByID[id]; exists {
		return "", "", "", fmt.Errorf("%w: %s", ErrConvIDExists, id)
	}
	// Collision-resolve against existing names. id is either freshly generated
	// or has just been checked absent from the index; uniqueName's excludeID is
	// defensive.
	finalName := fs.uniqueName(sanitized, id)
	dir := filepath.Join(fs.jugglerDir(), BuildDirName(finalName, id))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", "", "", fmt.Errorf("create conv dir: %w", err)
	}
	// Touch an empty doc.yjs so concurrent loaders in other viewers see a
	// zero-byte file rather than ENOENT. loadStateFromDisk treats an empty file
	// as a fresh doc, and the worker's first save overwrites it with the real
	// Yjs state. Without this, a viewer racing the create gets "conversation
	// state file not found" and the new tab fails to load.
	if err := os.WriteFile(ConvDocPath(dir), nil, 0o644); err != nil {
		return "", "", "", fmt.Errorf("touch doc.yjs: %w", err)
	}
	fs.index.ByID[id] = dir
	fs.index.Names[id] = finalName
	return id, finalName, dir, nil
}

// fitSuffixed returns suffixFn(base, i), clipping the BASE — never the suffix —
// so the whole name stays within SanitizedNameMaxRunes. The suffix is what
// tells the disambiguated conversation apart from the one it collided with, and
// SanitizeName truncates from the END when the folder is written: without this,
// a name already near the cap yields " (copy)" chopped to " (cop" on disk while
// the in-memory index keeps the full name, so the two disagree until the next
// scan and the copy looks identical to its source.
func fitSuffixed(base string, i int, suffixFn func(string, int) string) string {
	candidate := suffixFn(base, i)
	over := len([]rune(candidate)) - SanitizedNameMaxRunes
	if over <= 0 {
		return candidate
	}
	rs := []rune(base)
	keep := len(rs) - over
	if keep < 0 {
		keep = 0
	}
	clipped := strings.TrimRight(string(rs[:keep]), " ")
	if clipped == "" {
		// The suffix fills the cap on its own: keep it alone rather than emit a
		// leading space SanitizeName would trim into a different name.
		return strings.TrimSpace(suffixFn("", i))
	}
	return suffixFn(clipped, i)
}

// nameTaken returns a test for whether a candidate name is already held,
// case-folded, by any conversation in names other than excludeID.
func nameTaken(names map[string]string, excludeID string) func(candidate string) bool {
	return func(candidate string) bool {
		folded := strings.ToLower(candidate)
		for id, n := range names {
			if id == excludeID {
				continue
			}
			if strings.ToLower(n) == folded {
				return true
			}
		}
		return false
	}
}

// disambiguateName resolves a name collision by calling suffixFn(base, i) for
// i=2, 3, … until the name is unique (case-folded, excluding excludeID). Each
// candidate is fitted to the name cap for its own suffix, so a longer counter
// tail eats further into the base instead of overflowing.
func disambiguateName(base, excludeID string, names map[string]string, suffixFn func(string, int) string) string {
	taken := nameTaken(names, excludeID)
	if !taken(base) {
		return base
	}
	for i := 2; ; i++ {
		if c := fitSuffixed(base, i, suffixFn); !taken(c) {
			return c
		}
	}
}

// copySuffix produces " (copy)", " (copy 2)", … — the "(copy)" series.
func copySuffix(base string, i int) string {
	if i == 2 {
		return base + " (copy)"
	}
	return fmt.Sprintf("%s (copy %d)", base, i)
}

// uniqueName returns a case-folded-unique variant of base by appending
// " (copy)", " (copy 2)", … if any other conversation already holds the
// name. Excludes excludeID so a no-op rename of an existing conversation
// to its current name doesn't trigger a copy suffix.
func (fs *FileSessionStore) uniqueName(base, excludeID string) string {
	// A blank new tab always requests the placeholder name "Untitled N". Treat that
	// as a numbered series, not a base to suffix: on collision pick the lowest
	// unused "Untitled K" so a fresh tab never inherits a "(copy)" suffix. "(copy)"
	// stays reserved for genuine duplicates (/duplicate, /handoff), which pass
	// an explicit, non-placeholder name.
	if IsUntitledName(base) {
		taken := nameTaken(fs.index.Names, excludeID)
		if !taken(base) {
			return base
		}
		for k := 1; ; k++ {
			if c := UntitledName(k); !taken(c) {
				return c
			}
		}
	}
	return disambiguateName(base, excludeID, fs.index.Names, copySuffix)
}

// ensureConvDir returns the existing folder for convID, or creates an
// "Untitled--<id>" fallback folder if no folder is registered. Returns
// an error if the conversation was deleted this session, so a racing
// worker save can't recreate the folder as a ghost orphan.
//
// In normal flow CreateConversationFolder has already created the folder
// with its canonical name before any worker saves to it; the "Untitled"
// fallback exists only as a regression guard for callers that skip the
// create endpoint.
func (fs *FileSessionStore) ensureConvDir(convID string) (string, error) {
	if fs.deletedIDs[convID] {
		return "", fmt.Errorf("cannot save conversation %s: it has been deleted", convID)
	}
	if dir, ok := fs.ConvDir(convID); ok {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return "", fmt.Errorf("ensure conv dir: %w", err)
		}
		return dir, nil
	}
	dirName := BuildDirName(UntitledBase, convID)
	dir := filepath.Join(fs.jugglerDir(), dirName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create conv dir: %w", err)
	}
	if fs.index == nil {
		fs.index = NewConvDirIndex()
	}
	fs.index.ByID[convID] = dir
	fs.index.Names[convID] = UntitledBase
	return dir, nil
}

// binDir returns the .juggler/trash directory path.
func (fs *FileSessionStore) binDir() string {
	return filepath.Join(fs.jugglerDir(), "trash")
}

// jugglerDir returns the .juggler directory path
func (fs *FileSessionStore) jugglerDir() string {
	return filepath.Join(fs.projectPath, ".juggler")
}

// removeSpillDir best-effort deletes a conversation's full-output spill
// directory under .juggler/bash-output/. It never blocks or fails the caller; a
// missing directory is not an error.
func removeSpillDir(jugglerDir, convID string) {
	if convID == "" {
		return
	}
	if err := os.RemoveAll(filepath.Join(jugglerDir, "bash-output", convID)); err != nil {
		jlog.Info("[session] failed to remove spill dir for %s: %v", convID, err)
	}
}

// stripConvTxnInputs rewrites every transaction blob in a conversation folder
// without its "input": the system prompt, the message history replayed that
// turn, and the tool schemas.
//
// That input is around 99% of a blob's bytes and grows with the square of a
// conversation's length, because turn N carries turns 1..N-1 — and every byte
// of it is already held, once, in doc.yjs. What remains is what the transaction
// panel still renders without it: the model's output, the token counts, and the
// round-trip metadata.
//
// Best-effort throughout. An unreadable or unparseable blob is logged and left
// exactly as it is, its neighbours are still stripped, and a conversation with
// no transaction directory is not an error.
func stripConvTxnInputs(convDir string) {
	txnsDir := ConvTxnsDir(convDir)
	entries, err := os.ReadDir(txnsDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".json") {
			continue
		}
		path := filepath.Join(txnsDir, name)
		data, err := os.ReadFile(path)
		if err != nil {
			jlog.Info("[session] failed to read txn blob %s: %v", path, err)
			continue
		}
		// A map rather than a struct: the blob's shape belongs to the worker, and
		// a key this code has not heard of has to survive the round-trip.
		var blob map[string]any
		if err := json.Unmarshal(data, &blob); err != nil {
			jlog.Info("[session] failed to parse txn blob %s: %v", path, err)
			continue
		}
		if _, present := blob["input"]; !present {
			continue
		}
		delete(blob, "input")
		stripped, err := json.Marshal(blob)
		if err != nil {
			jlog.Info("[session] failed to re-encode txn blob %s: %v", path, err)
			continue
		}
		tmp := path + ".tmp"
		if err := os.WriteFile(tmp, stripped, 0o644); err != nil {
			jlog.Info("[session] failed to write stripped txn blob %s: %v", path, err)
			continue
		}
		if err := atomicio.RobustRename(tmp, path); err != nil {
			os.Remove(tmp)
			jlog.Info("[session] failed to replace txn blob %s: %v", path, err)
		}
	}
}

// sweepBinTxnInputs strips the transaction inputs of every conversation in
// .juggler/trash/. Binning strips as it goes, so this finds only what was binned
// before it did — or a conversation whose strip a crash or a shutdown cut short.
//
// It reads the bin from disk rather than the in-memory binIndex and mutates no
// shared state, so it is safe to run off the actor goroutine; stripConvTxnInputs
// is idempotent, so repeating it costs a read per blob and nothing else. A
// missing or unreadable bin is not an error.
func (fs *FileSessionStore) sweepBinTxnInputs() {
	binDir := fs.binDir()
	entries, err := os.ReadDir(binDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		stripConvTxnInputs(filepath.Join(binDir, e.Name()))
	}
}

// sweepUnassignedSpills deletes orphaned full-output spill files — those written
// with no conversation id, or left behind by a crash mid-command — older than
// 24h. Best-effort; a missing or unreadable directory is silently ignored.
func sweepUnassignedSpills(jugglerDir string) {
	dir := filepath.Join(jugglerDir, "bash-output", "_unassigned")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-24 * time.Hour)
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			if rmErr := os.RemoveAll(filepath.Join(dir, e.Name())); rmErr != nil {
				jlog.Info("[session] failed to sweep spill %s: %v", e.Name(), rmErr)
			}
		}
	}
}

// sessionGlobalsPath returns the path to session.json
func (fs *FileSessionStore) sessionGlobalsPath() string {
	return filepath.Join(fs.jugglerDir(), "session.json")
}

// Save persists the session to disk in {projectPath}/.juggler/
func (fs *FileSessionStore) Save(session *Session) error {
	if err := session.Validate(); err != nil {
		return fmt.Errorf("invalid session: %w", err)
	}

	globalsPath := fs.sessionGlobalsPath()
	globalsData, err := json.MarshalIndent(session, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal session globals: %w", err)
	}
	// Atomic temp+rename (matching SaveConversationBinary) so a crash mid-write
	// can't leave a truncated/torn session.json.
	tmp := globalsPath + ".tmp"
	if err := os.WriteFile(tmp, globalsData, 0644); err != nil {
		return fmt.Errorf("failed to write session globals: %w", err)
	}
	if err := atomicio.RobustRename(tmp, globalsPath); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("failed to rename session globals: %w", err)
	}

	return nil
}

// SaveConversationBinary writes the Yjs document to <convDir>/doc.yjs.
// If the conversation has no folder yet, an "Untitled--<id>" folder is
// created; the frontend can rename it later via RenameConversation.
// Uses atomic temp+rename to avoid torn writes on crash.
func (fs *FileSessionStore) SaveConversationBinary(convID string, yjsData []byte) error {
	dir, err := fs.ensureConvDir(convID)
	if err != nil {
		return err
	}
	dst := ConvDocPath(dir)
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, yjsData, 0o644); err != nil {
		return fmt.Errorf("failed to write conversation binary: %w", err)
	}
	if err := atomicio.RobustRename(tmp, dst); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("failed to rename conversation binary: %w", err)
	}
	return nil
}

// LoadConversationBinary reads the Yjs document from <convDir>/doc.yjs.
// Returns ErrConversationNotFound if the conversation has no folder.
func (fs *FileSessionStore) LoadConversationBinary(convID string) ([]byte, error) {
	dir, ok := fs.ConvDir(convID)
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrConversationNotFound, convID)
	}
	data, err := os.ReadFile(ConvDocPath(dir))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("%w: %s", ErrConversationNotFound, convID)
		}
		return nil, fmt.Errorf("failed to read conversation binary: %w", err)
	}
	return data, nil
}

// RenameConversation atomically renames a conversation's folder to reflect
// a new human-readable name. Returns ErrInvalidName for empty/whitespace
// input and ErrNameCollision (case-folded) if another conversation already
// uses that name. The newly canonical name (after sanitization) is returned.
func (fs *FileSessionStore) RenameConversation(convID, newName string) (string, error) {
	if strings.TrimSpace(newName) == "" {
		return "", ErrInvalidName
	}
	sanitized := SanitizeName(newName)
	if sanitized == "" {
		return "", ErrInvalidName
	}

	oldDir, ok := fs.ConvDir(convID)
	if !ok {
		return "", fmt.Errorf("%w: %s", ErrConversationNotFound, convID)
	}

	// Case-folded collision check across all OTHER conversations. Mac/Win
	// case-insensitive filesystems would otherwise let two folders coexist
	// in different casings until the rename collapses one onto the other.
	folded := strings.ToLower(sanitized)
	for id, n := range fs.index.Names {
		if id == convID {
			continue
		}
		if strings.ToLower(n) == folded {
			return "", ErrNameCollision
		}
	}

	if fs.index.Names[convID] == sanitized {
		return sanitized, nil // no-op
	}

	newDir := filepath.Join(fs.jugglerDir(), BuildDirName(sanitized, convID))
	if oldDir == newDir {
		return sanitized, nil
	}
	if err := atomicio.RobustRename(oldDir, newDir); err != nil {
		return "", fmt.Errorf("rename conv dir: %w", err)
	}
	fs.index.ByID[convID] = newDir
	fs.index.Names[convID] = sanitized
	return sanitized, nil
}

// removeConversationFiles deletes (or trashes) a conversation's folder and
// records the deletion so any racing worker save is rejected by ensureConvDir
// before it can recreate the folder as an orphan ghost.
// When permanent is false the folder is moved to the OS trash (giving the user
// a recovery path); when true it is permanently deleted (use for test teardown
// or when the trash path is inappropriate).
func (fs *FileSessionStore) removeConversationFiles(convID string, permanent bool) error {
	if fs.deletedIDs == nil {
		fs.deletedIDs = make(map[string]bool)
	}
	fs.deletedIDs[convID] = true

	// Best-effort delete the conversation's full-output spill files. Never blocks
	// or fails the deletion.
	removeSpillDir(fs.jugglerDir(), convID)

	dir, ok := fs.ConvDir(convID)
	if !ok {
		return nil
	}
	var err error
	if permanent {
		err = os.RemoveAll(dir)
	} else {
		err = trashOrRemove(dir)
	}
	if err != nil {
		return fmt.Errorf("failed to delete conversation dir: %w", err)
	}
	delete(fs.index.ByID, convID)
	delete(fs.index.Names, convID)
	return nil
}

// BinConversation moves a conversation's folder from .juggler/ to
// .juggler/trash/. Returns ErrConversationNotFound if the conversation has no
// active folder. This is the synchronous form used by direct callers and tests;
// the server bins via binConversationDeferred so the transaction strip runs off
// the actor goroutine.
func (fs *FileSessionStore) BinConversation(convID string) error {
	binnedDir, err := fs.binConversationDeferred(convID)
	if err != nil {
		return err
	}
	stripConvTxnInputs(binnedDir)
	return nil
}

// binConversationDeferred performs the fast half of binning: it renames the
// conversation's folder into .juggler/trash/ and moves it between the two
// indexes. All of that is metadata work, cheap to run on the actor goroutine.
// Sets deletedIDs[convID]=true to close the worker-save race window (matches
// removeConversationFiles); RestoreConversation clears it.
//
// It returns the conversation's new path under .juggler/trash/, whose
// transaction blobs the caller strips with stripConvTxnInputs off the hot path —
// that is the one part of binning whose cost scales with the conversation.
// A strip lost to a crash or a shutdown costs only the space it would have
// freed: the blobs are still readable, and the next sweep of the bin finishes
// the job.
func (fs *FileSessionStore) binConversationDeferred(convID string) (binnedDir string, err error) {
	oldDir, ok := fs.ConvDir(convID)
	if !ok {
		return "", fmt.Errorf("%w: %s", ErrConversationNotFound, convID)
	}
	if err := os.MkdirAll(fs.binDir(), 0o755); err != nil {
		return "", fmt.Errorf("create bin dir: %w", err)
	}
	basename := filepath.Base(oldDir)
	newDir := filepath.Join(fs.binDir(), basename)
	if err := atomicio.RobustRename(oldDir, newDir); err != nil {
		return "", fmt.Errorf("bin conv dir: %w", err)
	}
	name := fs.index.Names[convID]
	delete(fs.index.ByID, convID)
	delete(fs.index.Names, convID)
	if fs.binIndex == nil {
		fs.binIndex = NewConvDirIndex()
	}
	fs.binIndex.ByID[convID] = newDir
	fs.binIndex.Names[convID] = name
	if fs.deletedIDs == nil {
		fs.deletedIDs = make(map[string]bool)
	}
	fs.deletedIDs[convID] = true

	// Best-effort delete the conversation's full-output spill files. Binning
	// removes them immediately and RestoreConversation does not resurrect them —
	// spills are recoverable command output, not conversation state.
	removeSpillDir(fs.jugglerDir(), convID)
	return newDir, nil
}

// RestoreConversation moves a conversation's folder from .juggler/trash/ back
// to .juggler/. Returns ErrConversationNotFound if the conversation is not in
// the bin.
func (fs *FileSessionStore) RestoreConversation(convID string) error {
	if fs.binIndex == nil {
		return fmt.Errorf("%w: %s", ErrConversationNotFound, convID)
	}
	oldDir, ok := fs.binIndex.ByID[convID]
	if !ok {
		return fmt.Errorf("%w: %s", ErrConversationNotFound, convID)
	}
	basename := filepath.Base(oldDir)
	newDir := filepath.Join(fs.jugglerDir(), basename)
	if err := atomicio.RobustRename(oldDir, newDir); err != nil {
		return fmt.Errorf("restore conv dir: %w", err)
	}
	name := fs.binIndex.Names[convID]
	delete(fs.binIndex.ByID, convID)
	delete(fs.binIndex.Names, convID)
	fs.index.ByID[convID] = newDir
	fs.index.Names[convID] = name
	delete(fs.deletedIDs, convID)
	return nil
}

// removeBinnedConversationFiles permanently removes (via OS trash where
// available) a conversation folder from .juggler/trash/.
func (fs *FileSessionStore) removeBinnedConversationFiles(convID string) error {
	if fs.binIndex == nil {
		return nil
	}
	dir, ok := fs.binIndex.ByID[convID]
	if !ok {
		return nil
	}
	if err := trashOrRemove(dir); err != nil {
		return fmt.Errorf("failed to delete binned conv dir: %w", err)
	}
	delete(fs.binIndex.ByID, convID)
	delete(fs.binIndex.Names, convID)
	return nil
}

// EmptyBin permanently removes (via OS trash) every conversation currently in
// .juggler/trash/, returning the ids removed. This is the synchronous form used
// by direct callers and tests; the server empties the bin via emptyBinDeferred
// so the slow OS-trash step runs off the actor goroutine.
func (fs *FileSessionStore) EmptyBin() ([]string, error) {
	return trashMovedAside(fs.emptyBinDeferred())
}

// trashMovedAside finishes a deferred empty synchronously: it trashes the
// moved-aside staging directory on the caller's goroutine and returns the ids.
func trashMovedAside(removed []string, trashPath string, err error) ([]string, error) {
	if err != nil {
		return nil, err
	}
	if trashPath != "" {
		if err := trashOrRemove(trashPath); err != nil {
			return removed, fmt.Errorf("empty bin: trash %q: %w", trashPath, err)
		}
	}
	return removed, nil
}

// emptyBinDeferred performs the in-memory half of emptying the bin: it snapshots
// the binned ids, atomically renames the whole .juggler/trash/ directory aside
// to a unique sibling, and clears the bin index. All of this is fast metadata
// work — no per-conversation filesystem traversal — so it is cheap to run on the
// actor goroutine. It returns the emptied ids and the path of the moved-aside
// directory; the caller must trash that directory (a single OS trash operation,
// hence one "moved to trash" sound instead of one per conversation) off the hot
// path. trashPath is "" when the bin was already empty.
func (fs *FileSessionStore) emptyBinDeferred() (removed []string, trashPath string, err error) {
	if fs.binIndex == nil || len(fs.binIndex.ByID) == 0 {
		return nil, "", nil
	}
	ids := make([]string, 0, len(fs.binIndex.ByID))
	for id := range fs.binIndex.ByID {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	// The index is non-empty, so the directory should exist; if it somehow does
	// not, there is nothing on disk to trash — just clear the index below.
	binDir := fs.binDir()
	if _, statErr := os.Stat(binDir); statErr == nil {
		trashPath = fs.uniqueEmptyingPath()
		if renameErr := atomicio.RobustRename(binDir, trashPath); renameErr != nil {
			return nil, "", fmt.Errorf("empty bin: move aside: %w", renameErr)
		}
	}

	fs.binIndex.ByID = map[string]string{}
	fs.binIndex.Names = map[string]string{}
	return ids, trashPath, nil
}

// EmptyBinOlderThan permanently removes (via OS trash) every binned
// conversation whose last activity predates cutoff, returning the ids removed.
// This is the synchronous form used by direct callers and tests; the server goes
// through emptySelectionDeferred so the slow OS-trash step runs off the actor
// goroutine.
func (fs *FileSessionStore) EmptyBinOlderThan(cutoff time.Time) ([]string, error) {
	return trashMovedAside(fs.emptySelectionDeferred(cutoff))
}

// emptySelectionDeferred is emptyBinDeferred restricted to the conversations
// whose last activity predates cutoff. Age is measured with lastActivityTime —
// the same signal BinnedConvList reports — so what goes is exactly what the bin
// listing shows as that old. Nothing records when a conversation was binned, so
// this is age-of-conversation, not time-served in the bin.
//
// The qualifying folders are renamed into one staging directory rather than
// trashed individually: like emptyBinDeferred this keeps the actor's work to
// metadata only and leaves the caller a single directory to trash off the hot
// path (one "moved to trash" sound, not one per conversation). trashPath is ""
// when nothing qualifies.
func (fs *FileSessionStore) emptySelectionDeferred(cutoff time.Time) (removed []string, trashPath string, err error) {
	if fs.binIndex == nil || len(fs.binIndex.ByID) == 0 {
		return nil, "", nil
	}

	ids := make([]string, 0, len(fs.binIndex.ByID))
	for id, dir := range fs.binIndex.ByID {
		t, tErr := lastActivityTime(dir)
		// A folder with no resolvable timestamp is absent from the listing too,
		// so leave it be rather than deleting something the user can't see.
		if tErr != nil || !t.Before(cutoff) {
			continue
		}
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return nil, "", nil
	}
	sort.Strings(ids)

	trashPath = fs.uniqueEmptyingPath()
	if mkErr := os.MkdirAll(trashPath, 0o755); mkErr != nil {
		return nil, "", fmt.Errorf("empty bin: staging dir: %w", mkErr)
	}
	// A folder that won't move (held open elsewhere) is left in the bin, where it
	// stays listed and can be emptied again later, rather than failing the whole
	// operation and stranding the folders that did move.
	moved := make([]string, 0, len(ids))
	var lastErr error
	for _, id := range ids {
		dir := fs.binIndex.ByID[id]
		staged := filepath.Join(trashPath, filepath.Base(dir))
		if renameErr := atomicio.RobustRename(dir, staged); renameErr != nil {
			lastErr = renameErr
			jlog.Error("[session] empty bin: couldn't move aside %q: %v", dir, renameErr)
			continue
		}
		delete(fs.binIndex.ByID, id)
		delete(fs.binIndex.Names, id)
		moved = append(moved, id)
	}
	if len(moved) == 0 {
		_ = os.Remove(trashPath)
		return nil, "", fmt.Errorf("empty bin: move aside: %w", lastErr)
	}
	return moved, trashPath, nil
}

// uniqueEmptyingPath returns a sibling of .juggler/trash/ that does not yet
// exist, used as the move-aside target when emptying the bin. The nanosecond
// timestamp plus a disambiguating counter guarantees uniqueness even across
// rapid successive empties.
func (fs *FileSessionStore) uniqueEmptyingPath() string {
	base := filepath.Join(fs.jugglerDir(), "trash.emptying")
	for i := 0; ; i++ {
		p := fmt.Sprintf("%s-%d-%d", base, time.Now().UnixNano(), i)
		if _, err := os.Stat(p); os.IsNotExist(err) {
			return p
		}
	}
}

// orphanedEmptyingDirs returns any leftover trash.emptying-* directories under
// .juggler/ (see emptyBinDeferred). These exist only when a prior EmptyBin's
// off-actor trash step was interrupted before it finished; the caller sweeps
// them at startup.
func (fs *FileSessionStore) orphanedEmptyingDirs() []string {
	matches, _ := filepath.Glob(filepath.Join(fs.jugglerDir(), "trash.emptying-*"))
	return matches
}

// dirSizeBytes returns the total size, in bytes, of every regular file under
// root (recursively). A missing directory (an empty bin never creates
// .juggler/trash) yields 0. Per-entry errors are swallowed rather than
// aborting the walk, so a file vanishing mid-scan (e.g. a concurrent
// EmptyBin) still produces a sensible tally instead of nothing.
func dirSizeBytes(root string) int64 {
	var total int64
	_ = filepath.WalkDir(root, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if info, err := d.Info(); err == nil {
			total += info.Size()
		}
		return nil
	})
	return total
}

// BinSizeBytes returns the on-disk size of .juggler/trash/ (all binned
// conversations). It walks the filesystem and touches none of the store's
// in-memory indexes, so — unlike the other FileSessionStore methods — it is
// safe to call off the SessionManager actor goroutine (the periodic bin-size
// monitor does exactly that).
func (fs *FileSessionStore) BinSizeBytes() int64 {
	return dirSizeBytes(fs.binDir())
}

// lastActivityTime returns the wall-clock time of the most recent real
// edit to a conversation folder. The right signal is the newest mtime
// among files in <convDir>/txns/ — each LLM round-trip writes one blob
// and nothing else does, so simply opening or migrating the conv never
// bumps it. Falls back to doc.yjs mtime, then the folder itself, so a
// conv that was binned before any LLM turn still gets a sensible
// timestamp.
func lastActivityTime(convDir string) (time.Time, error) {
	entries, err := os.ReadDir(ConvTxnsDir(convDir))
	if err == nil {
		var newest time.Time
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			if info.ModTime().After(newest) {
				newest = info.ModTime()
			}
		}
		if !newest.IsZero() {
			return newest, nil
		}
	}
	if st, err := os.Stat(ConvDocPath(convDir)); err == nil {
		return st.ModTime(), nil
	}
	st, err := os.Stat(convDir)
	if err != nil {
		return time.Time{}, err
	}
	return st.ModTime(), nil
}

// BinnedConvList returns metadata for every conversation in .juggler/trash/,
// sorted most-recently-modified first. "Modified" means the last real LLM
// transaction (see lastActivityTime). Folders whose timestamp can't be resolved
// are skipped.
func (fs *FileSessionStore) BinnedConvList() []BinnedConvInfo {
	if fs.binIndex == nil {
		return []BinnedConvInfo{}
	}
	out := make([]BinnedConvInfo, 0, len(fs.binIndex.ByID))
	type rec struct {
		info  BinnedConvInfo
		mtime int64
	}
	recs := make([]rec, 0, len(fs.binIndex.ByID))
	for id, dir := range fs.binIndex.ByID {
		t, err := lastActivityTime(dir)
		if err != nil {
			continue
		}
		recs = append(recs, rec{
			info: BinnedConvInfo{
				ID:             id,
				Name:           fs.binIndex.Names[id],
				LastModifiedAt: t.UTC().Format("2006-01-02T15:04:05Z"),
			},
			mtime: t.UnixNano(),
		})
	}
	sort.Slice(recs, func(i, j int) bool { return recs[i].mtime > recs[j].mtime })
	for _, r := range recs {
		out = append(out, r.info)
	}
	return out
}

// Load retrieves the session from disk. Disk is the source of truth for
// both the conversation set and the human-readable name (folder name);
// session.json carries only the manifest (order, active, etc.).
func (fs *FileSessionStore) Load() (*Session, error) {
	idx, err := ScanConvDirs(fs.jugglerDir())
	if err != nil {
		return nil, fmt.Errorf("scan conv dirs: %w", err)
	}
	fs.index = idx

	binIdx, err := ScanConvDirs(fs.binDir())
	if err != nil {
		return nil, fmt.Errorf("scan bin dirs: %w", err)
	}
	fs.binIndex = binIdx

	// Backstop for full-output spill files that never got a conversation id (or
	// were orphaned by a crash mid-command): sweep _unassigned entries older than
	// 24h. Best-effort; never fails the load.
	sweepUnassignedSpills(fs.jugglerDir())

	globalsPath := fs.sessionGlobalsPath()
	globalsData, readErr := os.ReadFile(globalsPath)

	// The conversation folders scanned above are the authoritative source of
	// truth for which conversations exist. session.json carries only the
	// manifest (order, active, history, metadata). When that manifest is
	// missing or corrupt we must NOT discard the conversations — we start from
	// an empty manifest and let reconcileConversationOrder repopulate the order
	// from the folders on disk. Anything else strands a fully-scanned index next
	// to an empty order, so a freshly opened window renders a subset of the real
	// tabs while the create path still collision-checks against the full set.
	var session Session
	rebuilt := false
	switch {
	case readErr == nil:
		if err := json.Unmarshal(globalsData, &session); err != nil {
			jlog.Error("[session] session.json unparseable, rebuilding order from disk: %v", err)
			session = *NewSession()
			rebuilt = true
		}
	case os.IsNotExist(readErr):
		session = *NewSession()
		rebuilt = true
	default:
		return nil, fmt.Errorf("failed to read session globals: %w", readErr)
	}

	// The load-time pass over the workspace table: provisions that died with
	// the process that started them. See verifyWorkspaces for why this half
	// runs here rather than in the browser.
	workspacesChanged := verifyWorkspaces(&session)

	// Reconcile manifest's ConversationOrder against the on-disk index:
	// drop ids that no longer have a folder, append orphan folders that
	// aren't yet in the order. Persist if anything changed, or if the manifest
	// was rebuilt from scratch (so session.json is re-created on disk).
	// Both passes run, and in this order: the anchors are checked against the
	// order the reconcile leaves behind, and a `||` between the calls would
	// short-circuit the second one away the moment the first had work to do.
	orderChanged := fs.reconcileConversationOrder(&session)
	anchorsChanged := reconcileWorkspaceAnchors(&session)
	if orderChanged || anchorsChanged || workspacesChanged || rebuilt {
		if err := fs.Save(&session); err != nil {
			jlog.Error("[session] failed to persist reconciled order: %v", err)
		}
	}

	if err := session.Validate(); err != nil {
		return nil, fmt.Errorf("loaded session is invalid: %w", err)
	}
	return &session, nil
}

// reconcileConversationOrder syncs ConversationOrder with the per-conv
// folders actually present on disk (fs.index). IDs whose folder is gone
// are dropped (along with the activeConversation pointer if it pointed
// at them); folders on disk that aren't in the order are appended in
// deterministic (lexical) order so the tab bar doesn't shuffle on every
// startup. Returns true if the order changed.
func (fs *FileSessionStore) reconcileConversationOrder(session *Session) bool {
	if fs.index == nil {
		return false
	}
	onDisk := fs.index.ByID
	changed := false

	kept := make([]string, 0, len(session.ConversationOrder))
	for _, id := range session.ConversationOrder {
		if _, ok := onDisk[id]; ok {
			kept = append(kept, id)
			continue
		}
		if session.ActiveConversationID == id {
			session.ActiveConversationID = ""
		}
		changed = true
	}
	session.ConversationOrder = kept

	inOrder := map[string]bool{}
	for _, id := range session.ConversationOrder {
		inOrder[id] = true
	}
	var orphans []string
	for id := range onDisk {
		if !inOrder[id] {
			orphans = append(orphans, id)
		}
	}
	if len(orphans) > 0 {
		sort.Strings(orphans)
		session.ConversationOrder = append(session.ConversationOrder, orphans...)
		changed = true
	}
	return changed
}

// reconcileWorkspaceAnchors puts right any box whose place names a conversation
// the order does not have. Returns true if anything changed.
//
// A session can be edited between runs — a conversation folder deleted by hand,
// a manifest restored from a backup — and the place is the one workspace field
// that points at something outside its own row. Such a box goes back to having
// no recorded place, which is the truth: the conversation it sat behind is not
// there to hand its place on (that is reanchorBoxesAt's job, and it only runs
// while the conversation is still in the order), so nothing here knows where the
// box was. It is then drawn by the older reading of the bar rather than being
// sent to either end of it.
func reconcileWorkspaceAnchors(session *Session) bool {
	if len(session.Workspaces) == 0 {
		return false
	}
	inOrder := make(map[string]bool, len(session.ConversationOrder))
	for _, id := range session.ConversationOrder {
		inOrder[id] = true
	}
	changed := false
	for i := range session.Workspaces {
		place := session.Workspaces[i].Place
		if place == "" || place == PlaceHead || inOrder[place] {
			continue
		}
		session.Workspaces[i].Place = ""
		changed = true
	}
	return changed
}
