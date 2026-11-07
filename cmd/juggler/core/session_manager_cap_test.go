//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"errors"
	"os"
	"regexp"
	"strconv"
	"testing"
)

// TestCreateRefusedAtMaxConversations pins the cap on open conversations to
// the server, where every create lands. The engine runs the new_conversation
// tool against a registry holding only the conversations it drives, so a check
// anywhere but here lets a model open tabs past the cap that the "+" button
// stops at. A full session refuses a plain create and a duplicate alike, a
// refused duplicate never copies anything, and binning one makes room.
func TestCreateRefusedAtMaxConversations(t *testing.T) {
	mgr, err := NewSessionManagerForPath(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(mgr.Shutdown)

	var first string
	for i := range MaxConversations {
		id, _, err := mgr.CreateConversation("Conv " + strconv.Itoa(i))
		if err != nil {
			t.Fatalf("create %d of %d: %v", i+1, MaxConversations, err)
		}
		if i == 0 {
			first = id
		}
	}

	if _, _, err := mgr.CreateConversation("One too many"); !errors.Is(err, ErrTooManyConversations) {
		t.Errorf("a create past the cap returned %v, want ErrTooManyConversations", err)
	}
	filled := false
	_, _, err = mgr.CreateConversationFilled("Copy too many", "", ConversationPlacement{}, func(string) error {
		filled = true
		return nil
	})
	if !errors.Is(err, ErrTooManyConversations) {
		t.Errorf("a duplicate past the cap returned %v, want ErrTooManyConversations", err)
	}
	if filled {
		t.Error("a duplicate refused at the cap still copied its source")
	}
	if n := len(mgr.GetSession().ConversationOrder); n != MaxConversations {
		t.Errorf("order holds %d conversations after refused creates, want %d", n, MaxConversations)
	}

	if err := mgr.BinConversation(first); err != nil {
		t.Fatal(err)
	}
	if _, _, err := mgr.CreateConversation("Room made"); err != nil {
		t.Errorf("a create after binning one was refused: %v", err)
	}
}

// TestMaxConversationsMatchesTheViewer holds the viewer's copy of the cap to
// the server's. The viewer checks first so its "+" can show an alert; a viewer
// number above the server's makes that check dead, and one below it refuses
// tabs the server would allow.
func TestMaxConversationsMatchesTheViewer(t *testing.T) {
	src, err := os.ReadFile("../../../web/js/model/session.js")
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`export const MAX_CONVERSATIONS = (\d+);`).FindSubmatch(src)
	if m == nil {
		t.Fatal("web/js/model/session.js declares no MAX_CONVERSATIONS")
	}
	if got, _ := strconv.Atoi(string(m[1])); got != MaxConversations {
		t.Errorf("web/js/model/session.js MAX_CONVERSATIONS = %d, core.MaxConversations = %d", got, MaxConversations)
	}
}
