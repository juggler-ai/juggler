//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"errors"
	"os"
	"slices"
	"testing"
)

// TestCreateConversationFilledOrdersOnlyOnceFilled pins when a filled
// conversation becomes findable. Every viewer finds conversations through
// ConversationOrder, so an id ordered before its copy is written can be loaded
// from the folder's empty doc.yjs — a duplicate that opens with nothing in it
// and never reads the copy. fill must see a folder to write into and an order
// that does not yet name it; afterwards the order names it where it was asked
// to go.
//
// A fill that fails leaves the id out of the order, so a half-made duplicate is
// never offered to anyone.
func TestCreateConversationFilledOrdersOnlyOnceFilled(t *testing.T) {
	newManager := func(t *testing.T) *SessionManager {
		t.Helper()
		projectDir := t.TempDir()
		store, err := NewFileSessionStore(projectDir)
		if err != nil {
			t.Fatal(err)
		}
		mgr, err := NewSessionManager(SessionManagerConfig{Store: store, ProjectPath: projectDir})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(mgr.Shutdown)
		return mgr
	}

	t.Run("ordered after the fill", func(t *testing.T) {
		mgr := newManager(t)
		first, _, err := mgr.CreateConversation("First")
		if err != nil {
			t.Fatal(err)
		}

		filled := false
		id, _, err := mgr.CreateConversationFilled("Copy", "", ConversationPlacement{Where: PlaceAfter, After: first}, func(id string) error {
			if slices.Contains(mgr.GetSession().ConversationOrder, id) {
				t.Errorf("order %v already names %s while it is being filled", mgr.GetSession().ConversationOrder, id)
			}
			dir, ok := mgr.ConvDir(id)
			if !ok {
				t.Fatalf("no folder for %s to fill", id)
			}
			filled = true
			return os.WriteFile(ConvDocPath(dir), []byte("copied"), 0o644)
		})
		if err != nil {
			t.Fatal(err)
		}
		if !filled {
			t.Fatal("fill never ran")
		}
		if got, want := mgr.GetSession().ConversationOrder, []string{first, id}; !slices.Equal(got, want) {
			t.Errorf("order = %v, want %v", got, want)
		}
		dir, _ := mgr.ConvDir(id)
		if data, _ := os.ReadFile(ConvDocPath(dir)); string(data) != "copied" {
			t.Errorf("doc.yjs = %q, want the fill's bytes", data)
		}
	})

	t.Run("a failed fill is never ordered", func(t *testing.T) {
		mgr := newManager(t)
		var made string
		_, _, err := mgr.CreateConversationFilled("Copy", "", ConversationPlacement{}, func(id string) error {
			made = id
			return errors.New("source unreadable")
		})
		if err == nil {
			t.Fatal("a failed fill reported success")
		}
		if slices.Contains(mgr.GetSession().ConversationOrder, made) {
			t.Errorf("order %v names %s, whose fill failed", mgr.GetSession().ConversationOrder, made)
		}
	})
}
