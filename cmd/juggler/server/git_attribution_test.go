//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/gitattr"
	"juggler/cmd/juggler/gitview"
	"juggler/cmd/juggler/worker"
)

// storedConversation makes a conversation in the session, stored bound to a
// workspace ("" for the project), and returns its id.
func storedConversation(t *testing.T, s *Server, name, workspaceID string) string {
	t.Helper()
	id, _, err := s.SessionManager().CreateConversation(name)
	if err != nil {
		t.Fatal(err)
	}
	dir, ok := s.SessionManager().ConvDir(id)
	if !ok {
		t.Fatalf("conversation %s has no folder", id)
	}
	doc := worker.NewConversationDocument(id, "")
	if workspaceID != "" {
		doc.SetMetadata("workspaceId", workspaceID)
	}
	if err := os.WriteFile(core.ConvDocPath(dir), doc.ToState(), 0o600); err != nil {
		t.Fatal(err)
	}
	return id
}

// An attribution read of a workspace's tree, through the server's resolver,
// scores the project's index against the project's conversations: a version
// match goes to the conversation that wrote it, and everything else staged to
// the conversations bound to the workspace, each named by its title. A
// conversation bound elsewhere gets nothing.
func TestGitAttributionReadInAWorkspace(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git is not installed here: %v", err)
	}
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	s := newTestServerStateWithProject(t)
	root := t.TempDir()
	gitIn(t, root, "init", "-q")
	for _, f := range []string{"a.txt", "b.txt"} {
		if err := os.WriteFile(filepath.Join(root, f), []byte(f+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	gitIn(t, root, "add", "a.txt", "b.txt")
	ws, err := s.SessionManager().RegisterWorkspace(core.Workspace{Kind: core.WorkspaceKindLocal, Root: root, Label: "feat/x", State: core.WorkspaceStateReady})
	if err != nil {
		t.Fatal(err)
	}

	bound := storedConversation(t, s, "Bound one", ws.ID)
	writer := storedConversation(t, s, "The writer", "")
	storedConversation(t, s, "Bound elsewhere", "ws_other")
	gitattr.ForProject(s.ProjectPath()).Add(gitattr.Record{
		Workspace: ws.ID, Path: "a.txt", Blob: gitIn(t, root, "hash-object", "a.txt"), Conv: writer,
	})

	answer, err := callGitTool(s, t.Context(), ws.ID, "read", map[string]any{"kind": gitview.QueryAttribution})
	if err != nil {
		t.Fatalf("attribution read: %v", err)
	}
	got, ok := answer.(gitattr.Attribution)
	if !ok {
		t.Fatalf("attribution read answered %T, want a gitattr.Attribution", answer)
	}
	want := fmt.Sprintf("staged 2: %s The writer 1/0/0 [a.txt]; %s Bound one 0/0/1 [b.txt]", writer, bound)
	line := fmt.Sprintf("staged %d:", got.Staged)
	for i, c := range got.Conversations {
		sep := " "
		if i > 0 {
			sep = "; "
		}
		line += fmt.Sprintf("%s%s %s %d/%d/%d %v", sep, c.Conv, c.Title, c.Strong, c.Weak, c.Prior, c.Files)
	}
	if line != want {
		t.Errorf("attribution:\n got %s\nwant %s", line, want)
	}
}
