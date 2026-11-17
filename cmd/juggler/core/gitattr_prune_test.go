//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"testing"

	"juggler/cmd/juggler/gitattr"
)

// A conversation that is gone for good takes its attribution records with it:
// deleted, deleted from the bin, or in a bin that was emptied. Binning alone
// keeps them, since the conversation can be restored.
func TestGitAttrPrunedWithConversation(t *testing.T) {
	for _, tc := range []struct {
		name   string
		remove func(m *SessionManager, convID string) error
	}{
		{"deleted", func(m *SessionManager, convID string) error { return m.DeleteConversation(convID, true) }},
		{"deleted from the bin", func(m *SessionManager, convID string) error {
			if err := m.BinConversation(convID); err != nil {
				return err
			}
			return m.DeleteBinnedConversation(convID)
		}},
		{"bin emptied", func(m *SessionManager, convID string) error {
			if err := m.BinConversation(convID); err != nil {
				return err
			}
			_, err := m.EmptyBin()
			return err
		}},
		{"old bin emptied", func(m *SessionManager, convID string) error {
			if err := m.BinConversation(convID); err != nil {
				return err
			}
			_, err := m.EmptyBinOlderThan(-1)
			return err
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := newManagerForTest(t)
			going, _, err := m.CreateConversation("Going")
			if err != nil {
				t.Fatal(err)
			}
			staying, _, err := m.CreateConversation("Staying")
			if err != nil {
				t.Fatal(err)
			}
			x := gitattr.ForProject(m.GetProjectPath())
			x.Add(gitattr.Record{Path: "a.go", Blob: "b1", Conv: going})
			x.Add(gitattr.Record{Path: "a.go", Blob: "b2", Conv: staying})

			if err := tc.remove(m, going); err != nil {
				t.Fatalf("remove: %v", err)
			}
			got := x.ForPaths("", "", nil)
			if len(got) != 1 || got[0].Conv != staying {
				t.Errorf("records after the conversation went = %+v, want only the other conversation's", got)
			}
		})
	}

	t.Run("binned", func(t *testing.T) {
		m := newManagerForTest(t)
		conv, _, err := m.CreateConversation("Binned")
		if err != nil {
			t.Fatal(err)
		}
		x := gitattr.ForProject(m.GetProjectPath())
		x.Add(gitattr.Record{Path: "a.go", Blob: "b1", Conv: conv})
		if err := m.BinConversation(conv); err != nil {
			t.Fatal(err)
		}
		if got := x.ForPaths("", "", nil); len(got) != 1 {
			t.Errorf("binning the conversation left %+v, want its record kept", got)
		}
	})
}
