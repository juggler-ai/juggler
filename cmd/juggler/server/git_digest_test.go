//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/gitattr"
	"juggler/cmd/juggler/worker"
	"juggler/cmd/juggler/workspace"
)

func userItem(text string) worker.ConversationItem {
	return worker.ConversationItem{Type: worker.ItemTypeUser, Content: text}
}

func assistantItem(text string) worker.ConversationItem {
	return worker.ConversationItem{Type: worker.ItemTypeAssistant, Content: text}
}

// toolItem is a tool call in the given state, its input marshalled from input.
func toolItem(t *testing.T, id, tool, state string, input map[string]any) worker.ConversationItem {
	t.Helper()
	raw, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	return worker.ConversationItem{Type: worker.ItemTypeToolAction, ToolUseID: id, ToolName: tool, State: state, ToolInput: raw}
}

// storedTranscript makes a conversation in the session and stores its
// document: the items before a thread, the thread holding nested, then after.
func storedTranscript(t *testing.T, s *Server, name string, before, nested, after []worker.ConversationItem) string {
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
	doc.AppendMessage(before...)
	if nested != nil {
		arr := doc.InsertThread(len(before), "a sub-task")
		doc.InsertMessageIntoArray(arr, 0, nested...)
	}
	doc.AppendMessage(after...)
	if err := os.WriteFile(core.ConvDocPath(dir), doc.ToState(), 0o600); err != nil {
		t.Fatal(err)
	}
	return id
}

// askDigest asks the digest route and decodes a 200's answer.
func askDigest(t *testing.T, s *Server, query url.Values) (int, conversationDigest) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/git/conversation-digest?"+query.Encode(), nil).WithContext(t.Context())
	s.handleGitConversationDigest(rec, req)
	var d conversationDigest
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &d); err != nil {
			t.Fatalf("digest: %v\n%s", err, rec.Body.String())
		}
	}
	return rec.Code, d
}

func turnsLine(d conversationDigest) string {
	var parts []string
	for _, turn := range d.Turns {
		parts = append(parts, fmt.Sprintf("%s → %s %v", turn.User, turn.Closing, turn.Files))
	}
	return strings.Join(parts, "; ")
}

// A digest is the conversation's user messages, and the turns that touched the
// files asked about: each with what the user asked, how the agent closed it,
// and which of the files it touched. A turn runs from one user message to the
// next. Touching is a completed write or edit, wherever its path was absolute
// or relative and however deep in a sub-thread it ran, or a record the
// attribution index holds for one of the turn's tool calls (a shell command's).
// A cancelled edit, or a write to another file, touches nothing asked about.
func TestGitConversationDigest(t *testing.T) {
	s := newTestServerStateWithProject(t)
	root := t.TempDir()
	tree, err := workspace.NewResolver(func() string { return root }, nil, nil).Resolve("")
	if err != nil {
		t.Fatal(err)
	}
	s.gitWatchResolve = resolveTrees(map[string]workspace.Workspace{"ws_tree": tree})
	done := worker.StateCompleted

	id := storedTranscript(t, s, "Parser work",
		[]worker.ConversationItem{
			{Type: worker.ItemTypeSystemPrompt, Content: "You are an agent."},
			userItem("Fix the parser"),
			assistantItem("Looking."),
			toolItem(t, "tu1", "edit", done, map[string]any{"path": filepath.Join(root, "pkg", "parse.go")}),
			assistantItem("Fixed the parser."),
			userItem("Now the docs"),
			toolItem(t, "tu2", "write", done, map[string]any{"path": "docs/readme.md"}),
			assistantItem("Docs done."),
			userItem("Tidy the lexer"),
		},
		[]worker.ConversationItem{
			userItem("the sub-thread's own prompt"),
			toolItem(t, "tu3", "mcp__juggler__edit", done, map[string]any{"path": "./pkg/../pkg/lex.go"}),
			assistantItem("sub done"),
		},
		[]worker.ConversationItem{
			assistantItem("Lexer tidied."),
			userItem("Run the generator"),
			toolItem(t, "tu_bash", "bash", done, map[string]any{"command": "go generate ./..."}),
			assistantItem("Generated."),
			userItem("And a denied edit"),
			toolItem(t, "tu5", "edit", worker.StateCancelled, map[string]any{"path": "pkg/parse.go"}),
			assistantItem("Not editing, then."),
			userItem("Edit the vendored lib"),
			toolItem(t, "tu6", "write", done, map[string]any{"path": filepath.Join(root, "vendor", "lib", "a.go")}),
			assistantItem("Vendored lib edited."),
		})
	gitattr.ForProject(s.ProjectPath()).Add(gitattr.Record{
		Workspace: "ws_tree", Path: "gen/out.go", Blob: "b1", Conv: id, Item: "tu_bash", Strength: gitattr.Weak,
	})
	gitattr.ForProject(s.ProjectPath()).Add(gitattr.Record{
		Workspace: "ws_tree", Path: "gen/out.go", Blob: "b1", Conv: "someone_else", Item: "tu1", Strength: gitattr.Strong,
	})

	code, d := askDigest(t, s, url.Values{"conv": {id}, "workspace": {"ws_tree"},
		"paths": {"pkg/parse.go", "pkg/lex.go", "gen/out.go"}})
	if code != http.StatusOK {
		t.Fatalf("digest = %d, want 200", code)
	}
	if d.Title != "Parser work" {
		t.Errorf("title = %q, want Parser work", d.Title)
	}
	wantUsers := []string{"Fix the parser", "Now the docs", "Tidy the lexer", "Run the generator", "And a denied edit", "Edit the vendored lib"}
	if !slices.Equal(d.UserMessages, wantUsers) {
		t.Errorf("user messages = %q, want %q", d.UserMessages, wantUsers)
	}
	want := "Fix the parser → Fixed the parser. [pkg/parse.go]; " +
		"Tidy the lexer → Lexer tidied. [pkg/lex.go]; " +
		"Run the generator → Generated. [gen/out.go]"
	if got := turnsLine(d); got != want {
		t.Errorf("turns:\n got %s\nwant %s", got, want)
	}

	// Paths asked about are the repository's: a file the tree names
	// vendor/lib/a.go is a.go of the repository at vendor/lib.
	_, d = askDigest(t, s, url.Values{"conv": {id}, "workspace": {"ws_tree"}, "repo": {"vendor/lib"}, "paths": {"a.go", "pkg/parse.go"}})
	if got, want := turnsLine(d), "Edit the vendored lib → Vendored lib edited. [a.go]"; got != want {
		t.Errorf("turns in vendor/lib:\n got %s\nwant %s", got, want)
	}

	if code, _ := askDigest(t, s, url.Values{"conv": {"conv_nobody"}, "workspace": {"ws_tree"}, "paths": {"a.go"}}); code != http.StatusNotFound {
		t.Errorf("a conversation that does not exist = %d, want 404", code)
	}
	if code, _ := askDigest(t, s, url.Values{"workspace": {"ws_tree"}}); code != http.StatusBadRequest {
		t.Errorf("a digest naming no conversation = %d, want 400", code)
	}
	if code, _ := askDigest(t, s, url.Values{"conv": {id}, "workspace": {"ws_gone"}}); code != http.StatusBadRequest {
		t.Errorf("a digest in a workspace that does not resolve = %d, want 400", code)
	}
}

// Every message is capped, and the user messages together: the most recent
// are kept, and the digest says something was left out.
func TestGitConversationDigestCaps(t *testing.T) {
	t.Parallel()
	var items []worker.ConversationItem
	for i := range 10 {
		items = append(items, userItem(fmt.Sprintf("message %d %s", i, strings.Repeat("x", 1500))))
	}
	items = append(items, userItem(strings.Repeat("y", 3*digestMessageBudget)))
	d := digestItems(items, digestScope{})
	if !d.Truncated {
		t.Error("a digest that dropped messages is not marked truncated")
	}
	total := 0
	for _, m := range d.UserMessages {
		total += len(m)
	}
	if total > digestUserBudget || len(d.UserMessages) == 0 {
		t.Fatalf("user messages total %d bytes in %d, want at most %d", total, len(d.UserMessages), digestUserBudget)
	}
	last := d.UserMessages[len(d.UserMessages)-1]
	if len(last) > digestMessageBudget+20 || !strings.HasSuffix(last, "[… cut]") {
		t.Errorf("the long message is %d bytes ending %q, want it capped and marked", len(last), last[max(0, len(last)-20):])
	}
	if !strings.HasPrefix(d.UserMessages[len(d.UserMessages)-2], "message 9 ") || strings.HasPrefix(d.UserMessages[0], "message 0 ") {
		t.Errorf("want the most recent messages kept and the oldest dropped, got first %.12q", d.UserMessages[0])
	}
}
