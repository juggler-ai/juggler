//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// These tests pin two related failure modes seen when a window opens an old
// session:
//
//  1. Load split-brain — if session.json is missing or corrupt, the on-disk
//     conversation folders are the source of truth and must still populate the
//     tab order. Historically Load() scanned the folders into fs.index but then
//     bailed out on the globals read, leaving the manager with a full index yet
//     an empty ConversationOrder: the window showed one seeded tab while the
//     namer silently dodged the hidden real tabs.
//
//  2. New-tab naming — a brand-new blank tab always requests "Untitled N" and must
//     resolve to a clean, unused "Untitled K". It must never inherit the generic
//     "(copy)" collision suffix, which is reserved for genuine duplicates.

// assertOrderMatchesDisk asserts the recovered ConversationOrder lists exactly
// the conversation folders present on disk (per ConvNames). Divergence is the
// split-brain: the window renders ConversationOrder while the create path
// collision-checks against ConvNames, so any gap names a new tab against
// conversations the window never showed.
func assertOrderMatchesDisk(t *testing.T, store *FileSessionStore, sess *Session) {
	t.Helper()
	names := store.ConvNames()
	if len(sess.ConversationOrder) != len(names) {
		t.Fatalf("ConversationOrder %v disagrees with on-disk folders %v",
			sess.ConversationOrder, names)
	}
	for _, id := range sess.ConversationOrder {
		if _, ok := names[id]; !ok {
			t.Fatalf("ConversationOrder id %s not present on disk %v", id, names)
		}
	}
}

// A missing session.json must not lose the tabs: Load rebuilds the order from
// the conversation folders on disk.
func TestLoad_MissingGlobalsRebuildsOrderFromDisk(t *testing.T) {
	store, dir := newStoreForTest(t)

	for _, name := range []string{"Untitled 1", "Untitled 2", "Untitled 3"} {
		if _, _, _, err := store.CreateConversationFolder(name, ""); err != nil {
			t.Fatalf("CreateConversationFolder(%s): %v", name, err)
		}
	}

	// The trigger: the manifest is gone but the conversation folders remain.
	if err := os.Remove(filepath.Join(dir, ".juggler", "session.json")); err != nil {
		t.Fatalf("remove session.json: %v", err)
	}

	// A fresh store, as a newly opened window/process would use.
	fresh, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	sess, err := fresh.Load()
	if err != nil {
		t.Fatalf("Load after missing session.json: %v", err)
	}

	if len(sess.ConversationOrder) != 3 {
		t.Fatalf("ConversationOrder = %v, want all 3 conversations", sess.ConversationOrder)
	}
	assertOrderMatchesDisk(t, fresh, sess)
}

// A corrupt/unparseable session.json is likewise recovered from disk rather
// than discarding every conversation.
func TestLoad_CorruptGlobalsRebuildsOrderFromDisk(t *testing.T) {
	store, dir := newStoreForTest(t)

	for _, name := range []string{"Untitled 1", "Untitled 2"} {
		if _, _, _, err := store.CreateConversationFolder(name, ""); err != nil {
			t.Fatalf("CreateConversationFolder(%s): %v", name, err)
		}
	}

	globals := filepath.Join(dir, ".juggler", "session.json")
	if err := os.WriteFile(globals, []byte("{ this is not valid json"), 0o644); err != nil {
		t.Fatalf("corrupt session.json: %v", err)
	}

	fresh, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	sess, err := fresh.Load()
	if err != nil {
		t.Fatalf("Load after corrupt session.json: %v", err)
	}

	if len(sess.ConversationOrder) != 2 {
		t.Fatalf("ConversationOrder = %v, want both conversations", sess.ConversationOrder)
	}
	assertOrderMatchesDisk(t, fresh, sess)
}

// The end-to-end reproduction: a manager brought up on a project whose
// session.json vanished must not present a split-brain. The window renders
// GetSession().ConversationOrder; the create path collision-checks against
// ConvNames(). If they disagree, a brand-new tab is named against
// conversations the window never showed — the reported "(copy 2)" bug.
func TestManager_MissingGlobalsNoSplitBrain(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	if err := store.Save(NewSession()); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	for _, name := range []string{"Untitled 1", "Untitled 2", "Untitled 3"} {
		if _, _, _, err := store.CreateConversationFolder(name, ""); err != nil {
			t.Fatalf("CreateConversationFolder(%s): %v", name, err)
		}
	}
	if err := os.Remove(filepath.Join(dir, ".juggler", "session.json")); err != nil {
		t.Fatalf("remove session.json: %v", err)
	}

	// A new manager, as a freshly opened window would create.
	fresh, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	m := startManager(fresh, dir)
	t.Cleanup(m.Shutdown)

	order := m.GetSession().ConversationOrder
	names := m.ConvNames()
	if len(order) != len(names) {
		t.Fatalf("split-brain: ConversationOrder has %d ids %v but ConvNames has %d %v",
			len(order), order, len(names), names)
	}
	for _, id := range order {
		if _, ok := names[id]; !ok {
			t.Fatalf("ConversationOrder id %s missing from ConvNames %v", id, names)
		}
	}
}

// A legacy session.json whose messageHistory is a plain string array (the
// pre-structured shape) must still load. Entries are now opaque
// json.RawMessage, so each string survives verbatim rather than failing the
// manifest parse and triggering a rebuild that would drop the history.
func TestLoad_LegacyStringMessageHistory(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	if err := store.Save(NewSession()); err != nil {
		t.Fatalf("seed session: %v", err)
	}

	globals := filepath.Join(dir, ".juggler", "session.json")
	legacy := `{"version":5,"conversationOrder":[],"activeConversationId":"","messageHistory":["hello","world"],"metadata":{}}`
	if err := os.WriteFile(globals, []byte(legacy), 0o644); err != nil {
		t.Fatalf("write legacy session.json: %v", err)
	}

	fresh, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	sess, err := fresh.Load()
	if err != nil {
		t.Fatalf("Load legacy session.json: %v", err)
	}
	if len(sess.MessageHistory) != 2 {
		t.Fatalf("MessageHistory = %v, want 2 legacy entries", sess.MessageHistory)
	}
	if string(sess.MessageHistory[0]) != `"hello"` || string(sess.MessageHistory[1]) != `"world"` {
		t.Fatalf("legacy entries not preserved verbatim: %q, %q",
			string(sess.MessageHistory[0]), string(sess.MessageHistory[1]))
	}
}

// A brand-new "Untitled N" create must resolve to the lowest unused "Untitled K" and
// never a "(copy)" suffix — even when "Untitled 1 (copy)" already sits on disk.
// Mirrors the reported state: "Untitled 1" and "Untitled 1 (copy)" exist, with a gap
// at "Untitled 2".
func TestCreateConversation_TaskNameNeverGetsCopySuffix(t *testing.T) {
	store, _ := newStoreForTest(t)

	for _, name := range []string{"Untitled 1", "Untitled 1 (copy)", "Untitled 3"} {
		if _, _, _, err := store.CreateConversationFolder(name, ""); err != nil {
			t.Fatalf("seed %q: %v", name, err)
		}
	}

	// A new blank tab always requests "Untitled N".
	_, name, _, err := store.CreateConversationFolder("Untitled 1", "")
	if err != nil {
		t.Fatalf("CreateConversationFolder: %v", err)
	}
	if !IsUntitledName(name) {
		t.Fatalf("new tab name = %q, want a bare \"Untitled N\" (never a (copy) suffix)", name)
	}
	if name != "Untitled 2" {
		t.Fatalf("new tab name = %q, want lowest unused \"Untitled 2\"", name)
	}
}

// Guard: a genuine duplicate of a non-"Untitled N" name still gets the "(copy)"
// suffix. The Task-number reallocation must not change duplicate behaviour.
func TestCreateConversation_NonTaskNameStillGetsCopySuffix(t *testing.T) {
	store, _ := newStoreForTest(t)

	if _, _, _, err := store.CreateConversationFolder("Charlie", ""); err != nil {
		t.Fatalf("seed Charlie: %v", err)
	}
	_, name, _, err := store.CreateConversationFolder("Charlie", "")
	if err != nil {
		t.Fatalf("CreateConversationFolder: %v", err)
	}
	if name != "Charlie (copy)" {
		t.Fatalf("duplicate name = %q, want \"Charlie (copy)\"", name)
	}
}

// A duplicate of a name already at the length cap must keep its "(copy)" suffix
// whole: the suffix is the only thing telling the two conversations apart, and
// SanitizeName truncates from the END when the folder is written, so an
// unclipped base would land on disk as "… (cop" while the index held the full
// name. The base gives way instead.
func TestCreateConversation_LongNameKeepsCopySuffix(t *testing.T) {
	store, _ := newStoreForTest(t)

	long := strings.Repeat("A", SanitizedNameMaxRunes)
	if _, _, _, err := store.CreateConversationFolder(long, ""); err != nil {
		t.Fatalf("seed long name: %v", err)
	}
	_, name, dir, err := store.CreateConversationFolder(long, "")
	if err != nil {
		t.Fatalf("CreateConversationFolder: %v", err)
	}
	if !strings.HasSuffix(name, " (copy)") {
		t.Fatalf("duplicate name = %q, want an intact \" (copy)\" suffix", name)
	}
	if got := len([]rune(name)); got > SanitizedNameMaxRunes {
		t.Fatalf("duplicate name = %q (%d runes), want <= %d", name, got, SanitizedNameMaxRunes)
	}
	// The returned name must be the one actually on disk — the divergence this
	// guards is the index reporting a name the folder never carried.
	onDisk, _, ok := ParseDirName(filepath.Base(dir))
	if !ok {
		t.Fatalf("ParseDirName(%q) failed", filepath.Base(dir))
	}
	if onDisk != name {
		t.Fatalf("folder name %q != returned name %q", onDisk, name)
	}
}

// The counter series stays within the cap too: " (copy 10)" is three runes
// longer than " (copy)", so each candidate must be fitted for its own suffix
// rather than for the first one.
func TestDisambiguateName_CounterVariantsStayWithinCap(t *testing.T) {
	long := strings.Repeat("B", SanitizedNameMaxRunes)
	names := map[string]string{"conv_a": long}
	for i := 2; i <= 12; i++ {
		got := disambiguateName(long, "", names, copySuffix)
		if n := len([]rune(got)); n > SanitizedNameMaxRunes {
			t.Fatalf("candidate %q (%d runes), want <= %d", got, n, SanitizedNameMaxRunes)
		}
		if got != SanitizeName(got) {
			t.Fatalf("candidate %q would be rewritten to %q on disk", got, SanitizeName(got))
		}
		want := " (copy)"
		if i > 2 {
			want = fmt.Sprintf(" (copy %d)", i)
		}
		if !strings.HasSuffix(got, want) {
			t.Fatalf("candidate %q, want a %q suffix", got, want)
		}
		names[fmt.Sprintf("conv_%d", i)] = got
	}
}
