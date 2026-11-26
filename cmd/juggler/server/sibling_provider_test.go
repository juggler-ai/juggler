//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows

package server

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/claudecode"
	"juggler/cmd/juggler/providers/openaicodex"
	"juggler/cmd/juggler/providers/provider"
)

// Sibling threads of one conversation can run on different providers at once:
// a Claude Code author and a Codex reviewer. Opening the reviewer's handle must
// not close the author's, whose CLI is mid-turn — and the author's next turn
// must find its own handle still cached, leaving the reviewer's alone. The
// separate-conversation case is the control. The Claude CLI is a stub script
// that holds its turn open until told to finish; opening a Codex handle makes
// no network call.
func TestSiblingProviderKeepsAuthorAlive(t *testing.T) {
	claudecode.Register()
	openaicodex.Register()

	for _, test := range []struct{ name, reviewerConversation string }{
		{"separate_conversations", "other"},
		{"same_conversation", "task"},
	} {
		t.Run(test.name, func(t *testing.T) {
			project := t.TempDir()
			t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
			t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
			t.Setenv("JUGGLER_STATE_DIR", t.TempDir())
			cli := filepath.Join(project, "claude-stub")
			const script = `#!/bin/sh
while IFS= read -r line; do
    case "$line" in *'"type":"user"'*) break ;; esac
done
printf '%s\n' '{"type":"system","subtype":"init","session_id":"fake-author"}'
touch author-started
while [ ! -f finish-author ]; do sleep 0.05; done
printf '%s\n' '{"type":"result","subtype":"success","result":"author finished"}'
`
			if err := os.WriteFile(cli, []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("JUGGLER_CLAUDE_PATH", cli)

			cache := newConversationCache(func() string { return project })
			t.Cleanup(cache.Shutdown)
			ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
			defer cancel()
			caps := provider.ModelCapabilities{ContextWindowTokens: 200000, MaxOutputTokens: 4096}
			openAuthor := func() provider.Conversation {
				t.Helper()
				conv, err := cache.GetOrOpen(ctx, "task", "author", "claudecode", "claude-sonnet-4-6", core.ProviderCredential{}, caps, "")
				if err != nil {
					t.Fatal(err)
				}
				return conv
			}
			openReviewer := func() provider.Conversation {
				t.Helper()
				conv, err := cache.GetOrOpen(ctx, test.reviewerConversation, "reviewer", "openaicodex", "gpt-6.1-sol", core.ProviderCredential{BearerToken: "unused"}, caps, "")
				if err != nil {
					t.Fatalf("open reviewer: %v", err)
				}
				return conv
			}

			author := openAuthor()
			done := make(chan error, 1)
			go func() {
				_, err := author.Submit(ctx, provider.MessageRequest{
					ConversationID: "task", ThreadID: "author",
					Messages: []provider.Message{{Type: "user", Content: "Respond when ready."}},
				}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil })
				done <- err
			}()
			// Wait on the stub's progress, not a fixed span: it touches the
			// marker once it holds the turn open.
			for {
				if _, err := os.Stat(filepath.Join(project, "author-started")); err == nil {
					break
				}
				select {
				case err := <-done:
					t.Fatalf("author exited before reviewer started: %v", err)
				case <-ctx.Done():
					t.Fatal("author did not start")
				case <-time.After(10 * time.Millisecond):
				}
			}
			reviewer := openReviewer()
			if err := os.WriteFile(filepath.Join(project, "finish-author"), nil, 0600); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				if err != nil {
					t.Fatalf("opening the reviewer interrupted the author: %v (caller context: %v)", err, ctx.Err())
				}
			case <-ctx.Done():
				t.Fatal("author did not finish")
			}

			if openAuthor() != author {
				t.Fatal("the author's next turn reopened its handle instead of reusing it")
			}
			if openReviewer() != reviewer {
				t.Fatal("the author's next turn closed the reviewer's handle")
			}
		})
	}
}
