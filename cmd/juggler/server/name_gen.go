//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/osactivity"
	provider "juggler/cmd/juggler/providers/registry"
	"juggler/cmd/juggler/server/handlers"
	"juggler/internal/jlog"
)

// Auto-naming: turn a conversation's opening exchange into a short, human
// readable tab title using the conversation's own model — the same idea as
// t3.chat / t3code naming a thread from its first message. The frontend
// (web/js/services/auto-namer.js) detects the first completed turn, POSTs the
// opening prompt + reply here, and applies the returned title through the
// normal rename path only if the user hasn't renamed the tab themselves.

// nameGenSystemPrompt instructs the model to emit ONLY a short title. The
// output is sanitized and truncated afterwards regardless, so a misbehaving
// model degrades to a clipped title rather than a bad tab name.
const nameGenSystemPrompt = `You generate a short, descriptive title for a coding-assistant conversation, given the user's first message and the assistant's first reply.

Rules:
- Reply with ONLY the title. No quotes, no trailing punctuation, no "Title:" prefix, no explanation.
- 2 to 6 words, Title Case.
- Name the concrete task or topic. Prefer specifics (the file, tool, technology, or goal) over generic words like "Help", "Question", or "Request".
- Never include the words "conversation", "chat", "thread", or "task".`

// nameGenTimeout bounds the isolated naming turn. Auto-naming is best-effort
// and must never wedge; if the model is slow the frontend simply keeps the
// default "Task N" name.
const nameGenTimeout = 30 * time.Second

// nameGenInputCap bounds how much of the prompt / reply we forward, keeping the
// naming turn cheap regardless of how long the opening exchange was. The
// frontend also trims, so this is a backstop.
const nameGenInputCap = 4000

// generateNameRequest is the POST body for the auto-naming endpoint.
type generateNameRequest struct {
	Model    ModelConfig `json:"model"`
	Prompt   string      `json:"prompt"`
	Response string      `json:"response"`
}

// handleGenerateConversationName turns the opening exchange into a suggested
// title. It is a pure "text → title" endpoint: it never renames the
// conversation itself — the frontend owns the "only if still auto-named"
// decision and applies the result through the existing rename API. Lives in the
// server package (not handlers) because it needs provider access.
func (s *Server) handleGenerateConversationName(w http.ResponseWriter, r *http.Request) {
	convID, ok := handlers.ConvIDFromVars(w, r)
	if !ok {
		return
	}

	var req generateNameRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if strings.TrimSpace(req.Prompt) == "" {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "prompt is required"})
		return
	}
	if req.Model.Provider == "" || req.Model.Model == "" {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "model (provider + model) is required"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), nameGenTimeout)
	defer cancel()

	name, err := s.generateConversationName(ctx, convID, req.Model, req.Prompt, req.Response)
	if err != nil {
		jlog.Debug("generate-name: conv=%s failed: %v", convID, err)
		handlers.WriteJSON(w, r, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	handlers.WriteJSON(w, r, http.StatusOK, map[string]string{"name": name})
}

// generateConversationName runs a single isolated LLM completion that turns the
// opening exchange into a short title.
//
// Isolation is the whole point: it opens its OWN provider handle under a
// synthetic conversation id, entirely outside the server's conversationCache
// and the live conversation's provider-side state, and Closes it on return. A
// stateful provider (claudecode) therefore spins a throwaway CLI for the naming
// turn instead of injecting a spurious "name this" turn into the real session —
// so auto-naming can never perturb, resume, or corrupt the user's conversation.
func (s *Server) generateConversationName(ctx context.Context, convID string, model ModelConfig, prompt, response string) (string, error) {
	creds, err := core.NewCredentialsStore()
	if err != nil {
		return "", fmt.Errorf("credentials: %w", err)
	}
	credential, err := creds.GetProviderCredential(model.Provider)
	if err != nil {
		return "", fmt.Errorf("credentials: %w", err)
	}

	prov, err := provider.InitializeProvider(model.Provider, provider.Config{
		APIKey:      credential.APIKey,
		BearerToken: credential.BearerToken,
		Headers:     credential.Headers,
		Model:       model.Model,
	})
	if err != nil {
		return "", fmt.Errorf("initialize provider %q: %w", model.Provider, err)
	}

	// Synthetic id → a fresh handle the cache never sees; Close on return so no
	// handle / subprocess leaks.
	nameConvID := "namegen-" + convID
	conv, err := prov.OpenConversation(ctx, nameConvID)
	if err != nil {
		return "", fmt.Errorf("open conversation: %w", err)
	}
	defer func() { _ = conv.Close() }()

	var out strings.Builder
	cb := func(chunk provider.StreamChunk) (*provider.ToolResult, error) {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if chunk.Type == provider.ContentBlockTypeText {
			out.WriteString(chunk.Content)
		}
		return nil, nil
	}

	// Keep macOS from App-Napping us mid-request (mirrors createLLMCaller).
	osactivity.Begin()
	defer osactivity.End()

	_, err = conv.Submit(ctx, provider.MessageRequest{
		SystemPrompt:   nameGenSystemPrompt,
		Messages:       []provider.Message{{Type: "user", Content: buildNamePromptContent(prompt, response)}},
		ConversationID: nameConvID,
		// No tools, no extended thinking: this is a one-line summary.
		ThinkingLevel: provider.ThinkingOff,
	}, cb)
	if err != nil {
		return "", err
	}

	name := core.SanitizeName(cleanSuggestedName(out.String()))
	if name == "" || name == "Untitled" {
		return "", fmt.Errorf("model returned no usable title")
	}
	return name, nil
}

// buildNamePromptContent assembles the single user message the naming model
// sees. Both halves are capped so a long opening exchange never bloats the
// naming turn.
func buildNamePromptContent(prompt, response string) string {
	var b strings.Builder
	b.WriteString("First user message:\n")
	b.WriteString(clip(strings.TrimSpace(prompt), nameGenInputCap))
	if r := strings.TrimSpace(response); r != "" {
		b.WriteString("\n\nAssistant's first reply:\n")
		b.WriteString(clip(r, nameGenInputCap))
	}
	b.WriteString("\n\nTitle:")
	return b.String()
}

// cleanSuggestedName strips the wrapper noise a model tends to add around a
// one-line title — surrounding quotes/backticks, a leading "Title:" label, and
// everything after the first line — before the caller sanitizes it for the
// filesystem.
func cleanSuggestedName(raw string) string {
	s := strings.TrimSpace(raw)
	// Keep only the first non-empty line.
	for _, line := range strings.Split(s, "\n") {
		if strings.TrimSpace(line) != "" {
			s = strings.TrimSpace(line)
			break
		}
	}
	// Drop a leading "Title:" / "Name:" label if the model added one.
	for _, prefix := range []string{"Title:", "title:", "Name:", "name:"} {
		if strings.HasPrefix(s, prefix) {
			s = strings.TrimSpace(strings.TrimPrefix(s, prefix))
		}
	}
	// Strip a single matching pair of surrounding quotes/backticks.
	s = trimMatchingQuotes(s)
	return strings.TrimSpace(s)
}

// trimMatchingQuotes removes one matching pair of surrounding ", ', or `.
func trimMatchingQuotes(s string) string {
	if len(s) >= 2 {
		first, last := s[0], s[len(s)-1]
		if (first == '"' || first == '\'' || first == '`') && first == last {
			return s[1 : len(s)-1]
		}
	}
	return s
}

// clip truncates s to at most maxRunes runes on a rune boundary.
func clip(s string, maxRunes int) string {
	rs := []rune(s)
	if len(rs) <= maxRunes {
		return s
	}
	return string(rs[:maxRunes])
}
