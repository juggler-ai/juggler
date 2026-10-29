//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside worker_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

// TestProviderUnavailableSurfacedAsValidationError verifies Guard B: when the LLM
// dispatch fails because the selected model's provider can't be used (the caller
// wraps ErrProviderUnavailable), the worker surfaces a validation-error with code
// "provider-unavailable" — a user-fixable "pick another model" prompt — and does
// not retry a model that cannot run. It also leaves a durable error item carrying
// the resolver's own explanation, so a credential that lapses mid-loop doesn't
// look like a turn that simply stopped (the status alone is a transient notice
// the client drops when the conversation isn't on screen).
func TestProviderUnavailableSurfacedAsValidationError(t *testing.T) {
	w := NewConversationWorker("conv-pu", "user:test")
	defer w.doc.Destroy()

	// Seed a resolvable default model so the mapped message can name it.
	initPayload, _ := json.Marshal(InitMessage{
		Type: "init",
		Conversation: SerializedConversation{
			ID:          "conv-pu",
			ModelConfig: &ModelConfig{Provider: "test", Model: "test-model"},
		},
		Config: WorkerConfig{ProjectPath: t.TempDir()},
	})
	w.currentRun().handleInit(initPayload)

	// Real dispatch path (no mock): the caller fails with a wrapped
	// ErrProviderUnavailable, exactly as createLLMCaller does when credentials
	// for the stored provider are missing.
	var calls int32
	w.SetLLMCaller(func(context.Context, json.RawMessage, func(StreamChunk)) (*LLMResponse, error) {
		atomic.AddInt32(&calls, 1)
		return nil, fmt.Errorf("%w: no API key configured for provider: test", ErrProviderUnavailable)
	})

	// Capture the worker's broadcast status messages.
	statusCh := make(chan map[string]any, 16)
	w.SetCallback("viewer", func(b []byte) {
		var m map[string]any
		if json.Unmarshal(b, &m) == nil && m["type"] == "status" {
			statusCh <- m
		}
	})

	// Feed context/tools so the turn reaches dispatch without a live engine
	// (mirrors TestToolTurnPushesStateToEngine).
	done := make(chan struct{})
	defer close(done)
	go func() {
		ctxResp, _ := json.Marshal(map[string]any{"type": "render-context-items-result", "systemPrompt": "sys", "contexts": []any{}})
		toolsResp, _ := json.Marshal(map[string]any{"type": "tools-result", "tools": []any{}})
		for {
			if !w.engine.contextReply.inject(done, ctxResp) {
				return
			}
			if !w.engine.toolsReply.inject(done, toolsResp) {
				return
			}
		}
	}()

	w.driveStrategyLoop(t, "Hello", false)

	deadline := time.After(2 * time.Second)
	for {
		select {
		case m := <-statusCh:
			if m["status"] != "validation-error" {
				continue
			}
			if code, _ := m["code"].(string); code != "provider-unavailable" {
				t.Fatalf("expected code 'provider-unavailable', got %q (message=%v)", code, m["message"])
			}
			if got := atomic.LoadInt32(&calls); got != 1 {
				t.Fatalf("provider dispatch calls = %d, want 1 (an unusable model must not be retried)", got)
			}
			// The status message and the durable item both keep the resolver's
			// detail; a lead that only says "isn't configured" is unactionable.
			if msg, _ := m["message"].(string); !strings.Contains(msg, "no API key configured for provider: test") {
				t.Errorf("status message dropped the resolver detail: %q", msg)
			}
			m0 := m
			if key := statusTextKey(m); key != "The provider for {model} ({provider}) can't be used. Pick another model, or configure {provider} in settings.{hasDetail, select, yes {\n\n{detail}} other {}}" {
				t.Errorf("status text key = %q, want the provider-unavailable message", key)
			}
			var errItem *ConversationItem
			items := w.doc.GetItems()
			for i := range items {
				if items[i].Type == ItemTypeError {
					errItem = &items[i]
					break
				}
			}
			if errItem == nil {
				t.Fatal("no error item in the doc: Guard B must leave a durable record of the ended turn")
			}
			if !strings.Contains(errItem.Content, "no API key configured for provider: test") {
				t.Errorf("error item dropped the resolver detail: %q", errItem.Content)
			}
			if !strings.Contains(errItem.Content, "test-model") {
				t.Errorf("error item doesn't name the model: %q", errItem.Content)
			}
			// The durable item carries the same message, for the row to translate.
			if m := dataMessage(t, *errItem, "message"); m.Key != statusTextKey(m0) || m.English() != errItem.Content {
				t.Errorf("error item message = %+v, want the warning's message rendering its content", m)
			}
			return
		case <-deadline:
			t.Fatal("timeout waiting for validation-error status with code provider-unavailable")
		}
	}
}

// TestAuthErrorSurfacedWithRemediation covers the sibling of Guard B: a provider
// that refused a call it actually made, on authentication grounds. Guard B never
// sees this — it fires when credential resolution fails first, and a CLI-backed
// provider resolves no credential of its own, so the refusal is the first sign
// the login has lapsed.
//
// The turn must end with the provider's remediation leading, the provider's own
// text kept underneath, an errorKind the transcript row can key its action off,
// and no retry: an expired sign-in does not heal by being asked again.
func TestAuthErrorSurfacedWithRemediation(t *testing.T) {
	// The exact failure a user reported, in the shape the claudecode parser now
	// produces for it.
	const cliText = "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue."
	const hint = "Claude Code isn't signed in. Run claude in a terminal and use /login."
	assertUserFixableFailure(t, &provider.AuthError{
		Provider: "claudecode",
		Status:   401,
		Message:  cliText,
		Hint:     hint,
	}, "auth-required", "auth", hint, cliText, "")
}

// TestAuthErrorWithoutAHintLeadsWithItsOwnWords: a provider that gives no hint
// is led by Juggler's own sentence, which travels as a message too.
func TestAuthErrorWithoutAHintLeadsWithItsOwnWords(t *testing.T) {
	const lead = "The provider isn't signed in."
	assertUserFixableFailure(t, &provider.AuthError{
		Provider: "claudecode",
		Status:   401,
		Message:  "401 unauthorized",
	}, "auth-required", "auth", lead, "401 unauthorized", lead)
}

// TestSetupErrorSurfacedWithRemediation covers a provider that cannot run on
// this machine at all — the claude CLI not installed, or not where Juggler can
// find it. Reported generically it reached a new user as a PATH search report
// with only a Retry under it, which fails the same way forever. It gets the
// same terminal shape as an auth failure, under its own errorKind so the row
// can offer another model as well as settings.
func TestSetupErrorSurfacedWithRemediation(t *testing.T) {
	const detail = "claude executable not found. Searched $PATH and known install locations."
	const hint = "Claude Code isn't installed, or Juggler can't find it."
	assertUserFixableFailure(t, &provider.SetupError{
		Provider: "claudecode",
		Message:  detail,
		Hint:     hint,
	}, "provider-setup", "setup", hint, detail, "")
}

// TestSetupErrorWithoutAHintLeadsWithItsOwnWords is the setup twin of
// TestAuthErrorWithoutAHintLeadsWithItsOwnWords.
func TestSetupErrorWithoutAHintLeadsWithItsOwnWords(t *testing.T) {
	const lead = "The provider isn't set up on this machine."
	assertUserFixableFailure(t, &provider.SetupError{
		Provider: "claudecode",
		Message:  "claude executable not found.",
	}, "provider-setup", "setup", lead, "claude executable not found.", lead)
}

// assertUserFixableFailure runs one turn whose provider call fails with failErr
// and asserts the terminal shape every user-fixable failure shares: one call
// and no retry, a composer warning carrying only the hint under wantCode, and a
// durable error item that leads with the hint, keeps the provider's own text,
// and carries wantKind for the transcript row to key its actions off. The
// warning's message key is wantKey, "" when the lead is the provider's own hint
// and so has none.
func assertUserFixableFailure(t *testing.T, failErr error, wantCode, wantKind, hint, detail, wantKey string) {
	t.Helper()
	w := NewConversationWorker("conv-auth", "user:test")
	defer w.doc.Destroy()

	initPayload, _ := json.Marshal(InitMessage{
		Type: "init",
		Conversation: SerializedConversation{
			ID:          "conv-auth",
			ModelConfig: &ModelConfig{Provider: "claudecode", Model: "sonnet"},
		},
		Config: WorkerConfig{ProjectPath: t.TempDir()},
	})
	w.currentRun().handleInit(initPayload)

	var calls int32
	w.SetLLMCaller(func(context.Context, json.RawMessage, func(StreamChunk)) (*LLMResponse, error) {
		atomic.AddInt32(&calls, 1)
		return nil, fmt.Errorf("LLM error: %w", failErr)
	})

	statusCh := make(chan map[string]any, 16)
	w.SetCallback("viewer", func(b []byte) {
		var m map[string]any
		if json.Unmarshal(b, &m) == nil && m["type"] == "status" {
			statusCh <- m
		}
	})

	done := make(chan struct{})
	defer close(done)
	go func() {
		ctxResp, _ := json.Marshal(map[string]any{"type": "render-context-items-result", "systemPrompt": "sys", "contexts": []any{}})
		toolsResp, _ := json.Marshal(map[string]any{"type": "tools-result", "tools": []any{}})
		for {
			if !w.engine.contextReply.inject(done, ctxResp) {
				return
			}
			if !w.engine.toolsReply.inject(done, toolsResp) {
				return
			}
		}
	}()

	w.driveStrategyLoop(t, "Hello", false)

	deadline := time.After(2 * time.Second)
	for {
		select {
		case m := <-statusCh:
			if m["status"] != "validation-error" {
				continue
			}
			if code, _ := m["code"].(string); code != wantCode {
				t.Fatalf("expected code %q, got %q (message=%v)", wantCode, code, m["message"])
			}
			if got := atomic.LoadInt32(&calls); got != 1 {
				t.Fatalf("provider dispatch calls = %d, want 1 (a user-fixable failure must not be retried)", got)
			}
			// The composer warning gets the lead only — the detail needs room to
			// read, which the transcript has and the warning strip does not.
			if msg, _ := m["message"].(string); msg != hint {
				t.Errorf("status message = %q, want just the hint", msg)
			}
			if key := statusTextKey(m); key != wantKey {
				t.Errorf("status text key = %q, want %q", key, wantKey)
			}

			var errItem *ConversationItem
			items := w.doc.GetItems()
			for i := range items {
				if items[i].Type == ItemTypeError {
					errItem = &items[i]
					break
				}
			}
			if errItem == nil {
				t.Fatal("no error item in the doc: an ended turn must leave a durable record")
			}
			if !strings.HasPrefix(errItem.Content, hint) {
				t.Errorf("error item doesn't lead with the remediation: %q", errItem.Content)
			}
			// Dropping the provider's own words leaves nothing to search for.
			if !strings.Contains(errItem.Content, detail) {
				t.Errorf("error item dropped the provider's own text: %q", errItem.Content)
			}

			var data map[string]any
			if err := json.Unmarshal(errItem.Data, &data); err != nil {
				t.Fatalf("error item data is not decodable: %v", err)
			}
			if data["errorKind"] != wantKind {
				t.Errorf("errorKind = %v, want %q — the transcript row keys its action off this", data["errorKind"], wantKind)
			}
			if data["provider"] != "claudecode" {
				t.Errorf("provider = %v, want \"claudecode\"", data["provider"])
			}
			// Juggler's own lead makes the item one message, the provider's text a
			// param; a provider's own hint leaves it data, with nothing to translate.
			if m := dataMessage(t, *errItem, "message"); wantKey == "" && !m.IsZero() {
				t.Errorf("error item led by the provider's hint carries message %+v, want none", m)
			} else if wantKey != "" && (!strings.HasPrefix(m.Key, wantKey) || m.English() != errItem.Content || m.Params["detail"] != detail) {
				t.Errorf("error item message = %+v, want %q plus the provider text, rendering %q", m, wantKey, errItem.Content)
			}
			return
		case <-deadline:
			t.Fatalf("timeout waiting for validation-error status with code %s", wantCode)
		}
	}
}
