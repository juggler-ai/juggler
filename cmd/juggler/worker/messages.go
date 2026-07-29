//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package worker implements the Go conversation worker that handles
// conversation orchestration, state management, and LLM coordination.
//
// Message Protocol:
//
// The authoritative inbound dispatch is the switch in worker.go
// (handleMessage); the test-only kinds are dispatched in worker_test_support.go.
// This overview groups them by purpose — keep it in step with those switches.
//
// Messages TO worker:
//   - lifecycle: init, send-message, cancel
//   - turns/context: provider-turn, render-context-items-response, tools-result,
//     strategy-hook-response, build-subthread-spec-response, subthread-error-response
//   - threads: inject-thread-message, delivery-ended, create-thread,
//     reopen-thread, close-thread-with-last-message
//   - tool retry: retry-tool-approval, retry-tool-action, update-tool-action-for-retry
//   - context-item items: move-context-item-message-to-end,
//     update-and-reposition-tool-actions, reposition-context-item-placeholder
//   - sync/undo: yjs-sync, undo, redo, clear-history, stop-undo-capturing,
//     begin-undo-coalesce, end-undo-coalesce, request-full-state, resync-request,
//     resync-to-origin, clear-undo-stacks, get-transaction
//   - diagnostics: tool-command-ack, engine-trace, rename-log
//   - test-only: get-yjs-state, ping, flush-persistence, set-mock-responses, release-mock
//
// NOTE: State mutations (item add/delete/update) flow through Yjs CRDT sync,
// not as messages. The worker observes Yjs document changes via RegisterItemsObserver.
//
// Messages FROM worker:
//   - render-context-items-request: Get rendered context item content for LLM
//   - request-tools: Get tool definitions from browser
//   - error: Unhandled exceptions
//   - yjs-sync: CRDT state updates
//   - ack: Acknowledgment for acked operations
//   - pong: Reply to a test-only ping health check
package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"juggler/cmd/juggler/core"
	provider "juggler/cmd/juggler/providers/registry"
)

// ErrCancelled is returned when an operation is interrupted by user cancellation
// or tool denial. Check with errors.Is(err, ErrCancelled).
var ErrCancelled = errors.New("cancelled")

// ErrRestartStrategy is returned by callLLMWithRetry when a new user message
// arrived during a rate-limit wait. The caller must restart the strategy loop
// iteration so the new message is included in the LLM context.
var ErrRestartStrategy = errors.New("restart strategy")

// ErrProviderUnavailable marks a turn that failed because the selected model's
// provider isn't configured/usable (no API key, provider disabled, OAuth not
// signed in). The LLM caller wraps its credential-resolution failure with this
// sentinel; the strategy loop detects it with errors.Is and surfaces a
// user-fixable validation error (Guard B, code "provider-unavailable") — a
// "pick another model / configure this one" prompt — instead of a generic red
// error item. It is NEVER auto-retried: the model genuinely cannot run until the
// user acts. It survives the deliveredLLMError + classifyLLMError wrapping
// because both preserve the cause via Unwrap()/%w.
var ErrProviderUnavailable = errors.New("provider not configured")

// retryableError is implemented by provider errors that callLLMWithRetry
// should transparently retry after a short wait rather than surface to the
// user. New retryable categories satisfy this interface and need no changes
// in the retry loop itself — the loop classifies purely by behaviour, never
// by a concrete-type switch.
type retryableError interface {
	error
	// retryWait is how long the loop should park before the next attempt.
	retryWait() time.Duration
	// retryStatus is the user-facing "retrying" status for this attempt.
	retryStatus(attempt, max int) string
}

// RateLimitError is returned by callLLM when the provider responds with a
// rate-limit (429). The strategy loop retries after Wait.
type RateLimitError struct {
	Wait    time.Duration
	Message string
	Cause   error
}

func (e *RateLimitError) Error() string            { return e.Message }
func (e *RateLimitError) Unwrap() error            { return e.Cause }
func (e *RateLimitError) retryWait() time.Duration { return e.Wait }
func (e *RateLimitError) retryStatus(a, max int) string {
	return fmt.Sprintf("Rate limited, retrying (%d/%d)", a, max)
}

// TransientError is returned by callLLM when the provider failed for a
// transport reason that a fresh attempt usually clears — most commonly the
// claude CLI stream stalling because the upstream connection dropped (machine
// slept mid-request, a network blip). Unlike a RateLimitError there is no
// server-suggested delay, so Wait is a fixed short backoff.
type TransientError struct {
	Wait    time.Duration
	Message string
	Cause   error
}

func (e *TransientError) Error() string            { return e.Message }
func (e *TransientError) Unwrap() error            { return e.Cause }
func (e *TransientError) retryWait() time.Duration { return e.Wait }
func (e *TransientError) retryStatus(a, max int) string {
	return fmt.Sprintf("Connection dropped, retrying (%d/%d)", a, max)
}

// LLMCallFunc is the signature for direct LLM calls from the worker.
// The chunkHandler receives streaming chunks (called from the provider goroutine).
// Returns the complete response when streaming finishes.
type LLMCallFunc func(ctx context.Context, request json.RawMessage, chunkHandler func(StreamChunk)) (*LLMResponse, error)

// WindowResolverFunc resolves a model's context window and output reserve (in
// tokens) from its identity alone, with no provider round-trip. Injected
// alongside the LLM caller so the worker can evaluate the proactive compaction
// threshold (anchored input usage ÷ window) at turn-settle — the numerator is
// already worker-owned (the saved transaction blob), only the denominator was
// missing. Returns (0, 0) when the model is unknown; a non-positive window means
// "no threshold" to callers.
type WindowResolverFunc func(modelConfig ModelConfig) (windowTokens, reserveTokens int)

// AutoNameFunc is an injected server callback the worker fires exactly once, on
// the FIRST user message of the root conversation, so the server can derive a
// short tab title out-of-band. The worker only signals (convID, the first
// message text, and the primary provider/model/thinking it will run under); the
// server owns the guard, cheap-model resolution, the bounded completion, and the
// rename + broadcast. Passing provider/model/thinking as plain strings keeps the
// worker free of any dependency on the server's model-ref type. Fire-and-forget:
// the callee must not block the worker goroutine (the server hands off to its
// own goroutine).
type AutoNameFunc func(convID, firstMessage, provider, model, thinking string)

// =============================================================================
// Generic Message Envelope
// =============================================================================

// Message is the generic envelope for all worker messages
type Message struct {
	Type string `json:"type"`
}

// =============================================================================
// Messages TO Worker
// =============================================================================

// InitMessage bootstraps the worker with conversation data
type InitMessage struct {
	Type         string                 `json:"type"` // "init"
	Conversation SerializedConversation `json:"conversation"`
	Config       WorkerConfig           `json:"config"`
}

// SerializedConversation contains the initial conversation state
type SerializedConversation struct {
	ID                string                `json:"id"`
	Name              string                `json:"name"`
	Created           string                `json:"created"`
	ModelConfig       *ModelConfig          `json:"modelConfig,omitempty"`
	CurrentStrategyID string                `json:"currentStrategyId"`
	PermissionRules   []core.PermissionRule `json:"permissionRules,omitempty"`
	AllowedPaths      []string              `json:"allowedPaths,omitempty"`
	IsClone           bool                  `json:"isClone,omitempty"`
	LoadFromDisk      bool                  `json:"loadFromDisk,omitempty"` // If true, load Yjs state from disk and extract metadata
}

// ModelConfig represents LLM provider and model configuration
type ModelConfig struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	// Thinking is the optional canonical thinking/reasoning-effort level
	// ("off","low","medium","high","max"); empty ⇒ provider default. It rides
	// atomically with the (Provider, Model) pair through the thread tree.
	Thinking string `json:"thinking,omitempty"`
}

// WorkerConfig contains worker configuration
type WorkerConfig struct {
	ProjectPath string `json:"projectPath"`
	APIBaseURL  string `json:"apiBaseUrl,omitempty"`
}

// SendMessageMessage contains a user message to process
type SendMessageMessage struct {
	Type           string     `json:"type"` // "send-message"
	Text           string     `json:"text"`
	IsContinuation bool       `json:"isContinuation,omitempty"`
	ThreadItemID   string     `json:"threadItemId,omitempty"`
	Attachments    []AssetRef `json:"attachments,omitempty"`
}

// UserInput returns the send's payload as the single inseparable submission
// unit. Every path that turns a send into a user item — immediate or queued —
// takes this whole value so the text can never be carried without its
// attachments.
func (m SendMessageMessage) UserInput() UserMessageInput {
	return UserMessageInput{Text: m.Text, Attachments: m.Attachments}
}

// UserMessageInput is the inseparable unit of a user submission: the message
// text AND its image attachments, always carried together. A user item is only
// ever built from this whole value (see newUserItem), so no code path — neither
// the immediate send nor the "type while busy" queue — can construct a user
// message from bare text and silently drop the attachments.
type UserMessageInput struct {
	Text        string
	Attachments []AssetRef
	// TaskSource, when set, marks this submission as a chunk of a background
	// task's output injected by a delivery pump (the generic deliverTaskOutput
	// mechanism; Monitor is the first consumer). It rides along as part of the
	// inseparable unit so newUserItem stamps every injected chunk with the
	// originating task id — letting the UI join any chunk back to its live
	// binding and offer the same Stop control the monitor's tool-action shows.
	// nil for ordinary user messages.
	TaskSource *TaskSourceRef
}

// isEmpty reports whether the submission carries nothing at all — no text AND
// no attachments. An attachment-only message (an image with no caption) is NOT
// empty: it still has something to send.
func (u UserMessageInput) isEmpty() bool {
	return u.Text == "" && len(u.Attachments) == 0
}

// ProviderTurnMessage carries a turn the provider surfaced out-of-band — a
// turn the backend emitted with no Submit in flight (a scheduled wake /
// monitor firing through a persistent CLI). It enters the worker through the
// normal inbound FIFO. Delivering it as it completes is what fixes turn
// mis-attribution (the foreground Submit can no longer dequeue it as its own
// reply); its relative ordering vs. a near-simultaneous send-message is
// best-effort, not guaranteed. The handler lands it as a normal assistant
// turn in the root conversation.
type ProviderTurnMessage struct {
	Type                   string             `json:"type"` // "provider-turn"
	Blocks                 []LLMResponseBlock `json:"blocks"`
	StopReason             string             `json:"stopReason"`
	InputTokens            int                `json:"inputTokens"`
	InputTokensApproximate bool               `json:"inputTokensApproximate,omitempty"`
	OutputTokens           int                `json:"outputTokens"`
	CachedTokens           int                `json:"cachedTokens"`
	CacheWriteTokens       int                `json:"cacheWriteTokens"`
	Autonomous             bool               `json:"autonomous"`
}

// StreamChunk represents a streamed LLM content chunk
type StreamChunk struct {
	Type         provider.ContentBlockType `json:"type"`                   // Chunk type (text, thinking, tool_use, progress, usage, …)
	ItemID       string                    `json:"itemId,omitempty"`       // Item ID for UI tracking
	Content      string                    `json:"content,omitempty"`      // Content text
	OutputTokens int                       `json:"outputTokens,omitempty"` // Running output-token estimate, only set for type=="progress"

	// Set only for type=="usage" — a mid-stream anchor written as soon as
	// the provider emits its first usage event (e.g. Anthropic message_start
	// arrives ~100ms in with `input_tokens`). Lets the footer flip to "real
	// numbers only" immediately instead of waiting for end-of-turn.
	InputTokens  int   `json:"inputTokens,omitempty"`
	CachedTokens int   `json:"cachedTokens,omitempty"`
	CacheTTLMs   int64 `json:"cacheTTLMs,omitempty"`
}

// llmCallResult is the in-process completion delivered from the provider
// goroutine. Err remains concrete so callers can inspect provider error types;
// LLMResponse.Error remains available for scripted and wire-compatible failures.
type llmCallResult struct {
	Response *LLMResponse
	Err      error
}

type deliveredLLMError struct {
	err error
}

func (e *deliveredLLMError) Error() string { return e.err.Error() }
func (e *deliveredLLMError) Unwrap() error { return e.err }

// LLMResponse represents a complete LLM response
type LLMResponse struct {
	Blocks                 []LLMResponseBlock `json:"blocks"`
	InputTokens            int                `json:"inputTokens"`
	InputTokensApproximate bool               `json:"inputTokensApproximate,omitempty"`
	OutputTokens           int                `json:"outputTokens"`
	CachedTokens           int                `json:"cachedTokens,omitempty"`
	CacheWriteTokens       int                `json:"cacheWriteTokens,omitempty"`
	StopReason             string             `json:"stopReason"` // "end_turn", "tool_use", "max_tokens"
	Error                  string             `json:"error,omitempty"`
	TransactionID          string             `json:"transactionId,omitempty"`
	CacheTTLMs             int64              `json:"cacheTTLMs,omitempty"` // Provider's prompt-cache TTL in ms; 0 if no cache concept
}

// LLMResponseBlock represents a block in an LLM response
// JSON tags must match provider.ContentBlock (server sends these via WebSocket)
type LLMResponseBlock struct {
	Type     provider.ContentBlockType `json:"type"`                // Block type (text, thinking, tool_use, …)
	Content  string                    `json:"content,omitempty"`   // Text content (for type=text) or empty
	Thinking string                    `json:"thinking,omitempty"`  // Thinking content
	ID       string                    `json:"toolUseId,omitempty"` // Tool use ID (matches provider.ContentBlock)
	Name     string                    `json:"toolName,omitempty"`  // Tool name (matches provider.ContentBlock)
	Input    json.RawMessage           `json:"toolInput,omitempty"` // Tool input (matches provider.ContentBlock)
	Metadata map[string]any            `json:"metadata,omitempty"`  // Provider-specific metadata (e.g., Gemini ThoughtSignature)
}

// RenderContextItemsResponse contains rendered context item contexts for LLM
type RenderContextItemsResponse struct {
	Type         string        `json:"type"` // "render-context-items-response"
	RequestID    string        `json:"requestId"`
	Contexts     []ItemContext `json:"contexts"`
	SystemPrompt string        `json:"systemPrompt,omitempty"` // Full system prompt built by frontend
}

// ItemContext represents context text from a context item
type ItemContext struct {
	ItemID  string `json:"itemId"`
	Content string `json:"content"`
	Tokens  int    `json:"tokens,omitempty"`
}

// ToolsResultMessage contains tool definitions from browser
type ToolsResultMessage struct {
	Type      string           `json:"type"` // "tools-result"
	RequestID string           `json:"requestId"`
	Tools     []ToolDefinition `json:"tools"`
}

// ToolDefinition represents a tool that the LLM can use
type ToolDefinition struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"input_schema"`
	Category    string          `json:"category,omitempty"` // "read", "write", "meta"
	// DelegatesToSubthread marks a tool whose invocation MAY run as a subthread
	// (the browser item declared delegatesToSubthread in its MANIFEST). When the
	// LLM calls such a tool, the worker first asks the engine to build a
	// SubthreadSpec (BuildSubthreadSpecRequest); a spec spawns a delegated child
	// thread, a null spec falls back to the ordinary client-side tool-action.
	DelegatesToSubthread bool `json:"delegatesToSubthread,omitempty"`
}

// YjsSyncMessage contains Yjs CRDT state update.
//
// EngineDerived marks updates produced by the browser engine's reactive
// state-machine (e.g. the tool-action reducer writing PENDING / approvalOptions /
// displayData in response to observing an inserted tool-action). Those writes
// are pure derivations of items already on the user's undo stack — if the
// worker's UndoManager tracked them, every undo would pop only the most
// recent derivation and the engine would immediately re-derive, making undo
// a visible no-op. The browser sets this flag for updates whose Yjs
// transaction origin is the "engine-derived" sentinel (see
// web/js/model/conversation-tool-actions.js); the worker applies them with
// a non-nil, non-tracked origin so they bypass the UndoManager.
type YjsSyncMessage struct {
	Type          string `json:"type"` // "yjs-sync"
	Bytes         []byte `json:"bytes"`
	EngineDerived bool   `json:"engineDerived,omitempty"`
}

// ResyncRequestMessage asks the worker to send only the Yjs ops the client is
// missing, computed as the delta since the client's state vector. Used on WS
// reconnect to catch up cheaply: the alternative — re-sending full document
// state (or reloading the page) on every transient link drop — is what burned
// gigabytes over a remote tunnel. StateVector is base64 in JSON.
type ResyncRequestMessage struct {
	Type        string `json:"type"` // "resync-request"
	StateVector []byte `json:"stateVector"`
}

// ReopenThreadMessage requests that a completed thread's result be cleared,
// reopening it for continued work. The operation is performed Go-side with
// authorID origin so it is tracked by the UndoManager and can be undone.
type ReopenThreadMessage struct {
	Type         string `json:"type"` // "reopen-thread"
	ThreadItemID string `json:"threadItemId"`
	AckID        string `json:"ackId,omitempty"`
}

// CloseThreadWithLastMessageMessage requests the cheap, no-LLM-turn close of an
// open thread: promote its trailing assistant message as the thread result.
// Performed Go-side with authorID origin so it is undoable like reopen.
type CloseThreadWithLastMessageMessage struct {
	Type         string `json:"type"` // "close-thread-with-last-message"
	ThreadItemID string `json:"threadItemId"`
	AckID        string `json:"ackId,omitempty"`
}

// =============================================================================
// Messages FROM Worker
// =============================================================================

// RenderContextItemsRequest requests rendered context item content for LLM context
type RenderContextItemsRequest struct {
	Type          string            `json:"type"` // "render-context-items-request"
	RequestID     string            `json:"requestId"`
	ItemIDs       []string          `json:"itemIds"`
	ContextParams map[string]string `json:"contextParams,omitempty"`
}

// RunStrategyHookRequest asks the engine to run a strategy lifecycle hook
// (onActivate / onWorkerIdle) on its loaded copy of the conversation. The
// engine is the single place session-wide flow runs; the worker is the single
// decider of WHEN. Targeted at the engine only (sendToEngine), never broadcast,
// so a hook runs exactly once with no per-viewer ownership election. RequestID
// is empty for fire-and-forget hooks (onWorkerIdle); a non-empty RequestID asks
// the engine to report which items it injected (onActivate) so the worker can
// block until that guidance has synced into its doc before building the turn.
type RunStrategyHookRequest struct {
	Type               string `json:"type"` // "run-strategy-hook"
	RequestID          string `json:"requestId,omitempty"`
	Hook               string `json:"hook"`       // "onActivate" | "onWorkerIdle"
	StrategyID         string `json:"strategyId"` // the worker's authoritative active strategy
	PreviousStrategyID string `json:"previousStrategyId,omitempty"`
}

// StrategyHookResponse returns the guidance the hook asked to inject. The engine
// captures injectGuidance calls rather than writing them itself, so the WORKER
// is the single writer of these durable items — it appends them after the
// already-promoted user message, giving a deterministic order with no
// two-writer CRDT race against the user message.
type StrategyHookResponse struct {
	Type      string         `json:"type"` // "strategy-hook-response"
	RequestID string         `json:"requestId"`
	Guidance  []GuidanceItem `json:"guidance"`
}

// GuidanceItem is one durable system-reminder a strategy's onActivate hook
// asked to inject (via injectGuidance).
type GuidanceItem struct {
	Content string `json:"content"`
	Source  string `json:"source,omitempty"`
}

// SubthreadSpec is the seed for a delegated child thread, produced by the
// engine's buildSubthreadSpec for a delegatesToSubthread tool. Goal/Prompt/
// ResultSpec map directly onto CreateThreadOptions.
type SubthreadSpec struct {
	Goal       string `json:"goal"`
	Prompt     string `json:"prompt"`
	ResultSpec string `json:"resultSpec,omitempty"`
}

// BuildSubthreadSpecRequest asks the engine to run a delegating tool's
// validate + buildSubthreadSpec for one invocation and report the resulting
// spec (or null → run the tool client-side). Targeted at the engine only, so
// the decision runs exactly once. Mirrors RunStrategyHookRequest.
type BuildSubthreadSpecRequest struct {
	Type      string          `json:"type"` // "build-subthread-spec"
	RequestID string          `json:"requestId"`
	ToolUseID string          `json:"toolUseId"`
	ToolName  string          `json:"toolName"`
	ToolInput json.RawMessage `json:"toolInput"`
}

// BuildSubthreadSpecResponse returns the engine's decision. Spec == nil means
// "do not delegate — run the ordinary client-side execute()". A non-empty Error
// is treated the same as a null spec (fall back), with the reason logged.
type BuildSubthreadSpecResponse struct {
	Type      string         `json:"type"` // "build-subthread-spec-response"
	RequestID string         `json:"requestId"`
	Spec      *SubthreadSpec `json:"spec"`
	Error     string         `json:"error,omitempty"`
}

// SubthreadErrorRequest asks the engine to run a delegating tool's optional
// onSubthreadError hook when its child ended without a result, so the tool can
// degrade gracefully (e.g. return raw content) instead of a default error.
type SubthreadErrorRequest struct {
	Type      string          `json:"type"` // "subthread-error"
	RequestID string          `json:"requestId"`
	ToolName  string          `json:"toolName"`
	ToolInput json.RawMessage `json:"toolInput"`
	Reason    string          `json:"reason"`
}

// SubthreadErrorResponse returns the fallback tool_result text. Result == ""
// means "no fallback — use the default error result".
type SubthreadErrorResponse struct {
	Type      string `json:"type"` // "subthread-error-response"
	RequestID string `json:"requestId"`
	Result    string `json:"result"`
}

// ErrorMessage reports an unhandled exception
type ErrorMessage struct {
	Type    string `json:"type"` // "error"
	Message string `json:"message"`
	Summary string `json:"summary,omitempty"`
	Stack   string `json:"stack,omitempty"`
}

// AckMessage acknowledges an operation
type AckMessage struct {
	Type   string `json:"type"` // "ack"
	AckID  string `json:"ackId"`
	Result any    `json:"result,omitempty"`
}

// CorruptionRepairedMessage notifies frontend that corruption was repaired on load
type CorruptionRepairedMessage struct {
	Type          string `json:"type"`          // "corruption-repaired"
	RepairedCount int    `json:"repairedCount"` // Number of duplicate itemIds repaired
}

// =============================================================================
// Strategy-Driven Thread Creation Messages
// =============================================================================

// CreateThreadMessage requests thread creation from a strategy plugin
type CreateThreadMessage struct {
	Type           string `json:"type"` // "create-thread"
	RequestID      string `json:"requestId"`
	Goal           string `json:"goal"`
	Prompt         string `json:"prompt"`
	ThreadItemID   string `json:"threadItemId,omitempty"`   // parent thread (empty = root)
	IsContinuation bool   `json:"isContinuation,omitempty"` // continue thread without inserting a user prompt
}

// CreateThreadResponse contains the result of strategy-driven thread creation
type CreateThreadResponse struct {
	Type         string `json:"type"` // "create-thread-response"
	RequestID    string `json:"requestId"`
	ThreadItemID string `json:"threadItemId,omitempty"`
	Result       string `json:"result,omitempty"`
	Error        string `json:"error,omitempty"`
}

// =============================================================================
// Test Harness Messages
// =============================================================================

// GetYjsStateMessage requests Yjs state for testing
type GetYjsStateMessage struct {
	Type  string `json:"type"` // "get-yjs-state"
	AckID string `json:"ackId"`
}

// ClearUndoStacksMessage clears undo/redo stacks for testing
type ClearUndoStacksMessage struct {
	Type  string `json:"type"` // "clear-undo-stacks"
	AckID string `json:"ackId,omitempty"`
}

// GetTransactionMessage requests the on-disk blob for one LLM round-trip.
// The worker responds with an AckMessage whose Result is the parsed JSON
// blob (or null if the blob is missing).
type GetTransactionMessage struct {
	Type          string `json:"type"` // "get-transaction"
	AckID         string `json:"ackId"`
	TransactionID string `json:"transactionId"`
}

// CompactMessage is the browser /compact + /handoff request: fold the
// conversation into an unsummarized bounded-compaction thread worker-side (the
// single Go fold, shared with the proactive auto-compaction trigger), then let
// the existing pickup summarize it. HandoffPromote tags the thread so the browser
// promotes its result into the continued tab's parked first message.
type CompactMessage struct {
	Type           string `json:"type"` // "compact"
	AckID          string `json:"ackId"`
	HandoffPromote bool   `json:"handoffPromote,omitempty"`
}

// SetMockResponsesMessage injects mock LLM responses for testing.
// When mock responses are set, callLLM() pops and returns them instead of calling real LLM.
type SetMockResponsesMessage struct {
	Type      string         `json:"type"` // "set-mock-responses"
	Responses []MockResponse `json:"responses"`
}

// MockResponse represents a scripted LLM response for testing.
type MockResponse struct {
	Blocks                 []LLMResponseBlock `json:"blocks"`
	StopReason             string             `json:"stopReason"`
	InputTokens            int                `json:"inputTokens,omitempty"`
	InputTokensApproximate bool               `json:"inputTokensApproximate,omitempty"`
	OutputTokens           int                `json:"outputTokens,omitempty"`
	CachedTokens           int                `json:"cachedTokens,omitempty"`
	// PauseBeforeReturn, when true, causes popMockResponse to deliver the
	// response (streaming chunks) and then block on the worker's mockReleaseChan
	// until the test sends a "release-mock" message. Tests use this to inject
	// actions (e.g. cancel) at a precisely-known point in the response lifecycle
	// without racing against tool execution timing.
	PauseBeforeReturn bool `json:"pauseBeforeReturn,omitempty"`
	// Error, when non-empty, makes this scripted turn fail as if the provider
	// returned an error (e.g. a transient network failure). callLLM surfaces it
	// through the same path as a real provider error, so tests can exercise the
	// strategy loop's error handling deterministically.
	Error string `json:"error,omitempty"`
}

// ReleaseMockMessage releases a paused mock response. See MockResponse.PauseBeforeReturn.
type ReleaseMockMessage struct {
	Type string `json:"type"` // "release-mock"
}

// =============================================================================
// Conversation Item Types
// =============================================================================

// Tool-action lifecycle states.
//
// The tool-action is a state machine:
//
//	"" → pending → approved → running → completed | cancelled
//	"" → approved → running → completed | cancelled   (auto-approve)
//
// "approved" is the "ready to run, not yet claimed" state. The frontend
// reducer (Conversation._reconcileToolAction) atomically transitions
// approved → running as its claim before launching the side effect.
// Writers that want to request execution must write "approved"; only the
// executor itself writes "running" (as its claim).
const (
	StateUnevaluated = ""          // Initial state: tool not yet evaluated for approval
	StatePending     = "pending"   // Waiting for user approval
	StateApproved    = "approved"  // Ready to run, not yet claimed
	StateRunning     = "running"   // Claimed, execution in progress
	StateCompleted   = "completed" // Done, result field has data
	StateCancelled   = "cancelled" // Denied or interrupted
)

// ToolCommand is a worker→engine instruction to drive one tool-action through a
// specific lifecycle transition, identified by toolUseId. It is the
// command-driven counterpart to the engine's reactive reducer: rather than the
// engine observing a doc state change and reacting, the worker (which already
// watches every doc update) tells the single tool-executor engine exactly what
// to do. Type is one of:
//
//	"evaluate-tool" — run handleNewToolAction (approval-gate or auto-approve)
//	"execute-tool"  — claim approved→running and run the side effect
//	"cancel-tool"   — abort an in-flight execution
//
// The conversationId is added by the outbound envelope (FormatWorkerMessage),
// so only the type and toolUseId travel in the payload.
type ToolCommand struct {
	Type      string `json:"type"`
	ToolUseID string `json:"toolUseId"`
}

// Activity constants for the `activity` field of processingState metadata.
//
// activity is the doc-native "is a long-running operation claimed for this
// conversation" marker. claimLLM does a compare-and-set (null →
// ActivityCallingLLM) to launch an LLM turn; sendStatus("idle") clears it.
// Unlike the UI-facing `status` field, activity is the reducer's source of
// truth for whether a new CallLLM action is allowed, and the reducer gates
// dispatch on it.
const (
	ActivityNone        = ""             // Idle — no claim; a new operation may start
	ActivityAwaitingLLM = "awaiting_llm" // Tools executing; LLM call needed when they finish
	ActivityCallingLLM  = "calling_llm"  // Claimed for an LLM turn
)

// ConversationItem represents an item in the conversation (message, tool action, etc.)
type ConversationItem struct {
	Type            string          `json:"type"`                      // "user", "assistant", "thinking", "tool-action", "system-prompt", "rule", "error", etc.
	ItemID          string          `json:"itemId,omitempty"`          // Unique ID for every item (DOM diffing, tracking, context item identity)
	Content         string          `json:"content,omitempty"`         // Content text
	Source          string          `json:"source,omitempty"`          // Origin tag for system-reminder/guidance items (the injecting strategy)
	Summary         string          `json:"summary,omitempty"`         // Short user-facing summary (used by error items)
	Timestamp       string          `json:"timestamp,omitempty"`       // Creation timestamp
	ToolUseID       string          `json:"toolUseId,omitempty"`       // Tool use ID
	ToolName        string          `json:"toolName,omitempty"`        // Tool name
	ToolInput       json.RawMessage `json:"toolInput,omitempty"`       // Tool input parameters
	State           string          `json:"state,omitempty"`           // Tool lifecycle state (see State* constants)
	ApprovalOptions json.RawMessage `json:"approvalOptions,omitempty"` // Approval options for UI
	DisplayData     json.RawMessage `json:"displayData,omitempty"`     // Display data for UI
	IsError         bool            `json:"isError,omitempty"`         // Whether this is an error result
	Data            json.RawMessage `json:"data,omitempty"`            // Additional data
	Cancelled       bool            `json:"cancelled,omitempty"`       // Whether tool was cancelled
	Result          json.RawMessage `json:"result,omitempty"`          // Tool result or thread result (omitted when null/empty)
	// Thread-specific fields
	Goal                   string          `json:"goal,omitempty"`                   // Thread goal description
	Items                  json.RawMessage `json:"items,omitempty"`                  // Nested items for thread messages (preserved for undo/redo)
	BoundedCompaction      bool            `json:"boundedCompaction,omitempty"`      // Enables bounded fallback after registry context rejection
	CompactionPromptItemID string          `json:"compactionPromptItemId,omitempty"` // Orchestration prompt excluded from canonical source history

	// Thread-run control fields, set by a fold that produces an UNSUMMARIZED
	// bounded-compaction thread (the /compact shape the browser fold also
	// builds). checkForNewThreads picks up NeedsStrategyRun and runs the thread
	// through the folded-compaction summarizer; NoAutoSelect keeps the fold off
	// the active tab and marks it for one-undo-group merge; NoContextSeed stops
	// starting-context re-injection into a thread already populated by
	// relocation; ForceTool pins the summarization turn to return_result.
	// HandoffPromote tags a /handoff fold so the browser promotes its result into
	// the parked first message of the continued tab. All omitempty so ordinary
	// items and already-summarized recovery folds stay byte-identical.
	NeedsStrategyRun bool   `json:"needsStrategyRun,omitempty"`
	NoAutoSelect     bool   `json:"noAutoSelect,omitempty"`
	NoContextSeed    bool   `json:"noContextSeed,omitempty"`
	ForceTool        string `json:"forceTool,omitempty"`
	HandoffPromote   bool   `json:"handoffPromote,omitempty"`

	// Context-item specific fields
	PreventUserDeletion bool   `json:"preventUserDeletion,omitempty"` // Whether context item cannot be deleted by user
	IsNew               bool   `json:"isNew,omitempty"`               // Whether context item is newly created
	Error               string `json:"error,omitempty"`               // Error message for context items

	// TransactionID identifies the LLM round-trip that produced this item.
	// All items inserted/stamped during one round-trip share the same id;
	// the corresponding input/output blob is stored on disk via
	// TransactionStore and carries inputTokens / cachedTokens for that turn.
	// inputTokensApproximate distinguishes local fallback estimates from
	// provider-reported usage; absent remains provider-reported for compatibility.
	// Consumers (footer, auto-compact) walk their thread's items backward, find the most recent TransactionID,
	// and fetch the blob on demand — there is no per-item or
	// per-conversation cached token state.
	TransactionID string `json:"transactionId,omitempty"`

	// ProviderData holds opaque provider-specific metadata (e.g., Gemini ThoughtSignature on tool-use items).
	ProviderData map[string]any `json:"providerData,omitempty"`

	// Attachments holds references to content-addressed binary assets (e.g.
	// attached images) carried by user items. The bytes live out-of-doc in the
	// AssetStore; only this reference (sha id, mime, dims) is stored in the doc.
	Attachments []AssetRef `json:"attachments,omitempty"`

	// TaskSource marks a user item that was injected by a background-task output
	// delivery pump (the generic deliverTaskOutput mechanism; Monitor is the
	// first consumer). It carries the originating task id so the UI can join the
	// chunk back to its live binding and offer the same status + Stop control the
	// monitor's own tool-action shows. A pointer so an ordinary user message
	// omits the key entirely and stays byte-identical to the legacy shape.
	TaskSource *TaskSourceRef `json:"taskSource,omitempty"`
}

// TaskSourceRef identifies the background task whose output produced an injected
// user item (see ConversationItem.TaskSource). The label mirrors the per-chunk
// delivery header so an injected message is self-describing without re-reading
// the binding.
type TaskSourceRef struct {
	TaskID string `json:"taskId"`
	Label  string `json:"label,omitempty"`
}

// ConversationItemType defines conversation item types
const (
	ItemTypeUser           = "user"
	ItemTypeAssistant      = "assistant"
	ItemTypeThinking       = "thinking"
	ItemTypeToolAction     = "tool-action"
	ItemTypeError          = "error"
	ItemTypeMetaToolResult = "meta-tool-result"
	ItemTypeThread         = "thread"
	// ItemTypeSystemReminder and ItemTypeGuidance are meta-instruction messages
	// a strategy injects into the doc (via injectGuidance) to steer a turn
	// without authoring system-prompt text. The provider maps both to the user
	// role (provider.MessageTypeToRole); buildMessages emits them verbatim.
	ItemTypeSystemReminder = "system-reminder"
	ItemTypeGuidance       = "guidance"
	// ItemTypeSystemPrompt is the standing system-prompt context item: root's
	// canonical SYSTEM_1 and the fresh-id copies seeded into sub-threads. Used
	// as the idempotency key for seeding (a thread with one has been seeded).
	ItemTypeSystemPrompt = "system-prompt"
	// ItemTypeCompactionSummary is the folded product of context-window
	// recovery: one item replacing a summarized prefix of the conversation.
	// buildMessages emits it as a single user message with an inert-data
	// header; it is conversational (and re-foldable by a later recovery).
	ItemTypeCompactionSummary = "compaction-summary"
)

// isConversationalItemType reports whether an item type is conversation history
// — a message, tool call, sub-thread, or strategy-injected instruction — as
// opposed to a standing context item (system-prompt, memory, file-content,
// rule, plan, …). Used to bound the leading run of starting-context items a
// sub-thread is seeded with (see collectSeedItemMaps): the run ends at the
// first conversational item.
func isConversationalItemType(t string) bool {
	switch t {
	case ItemTypeUser, ItemTypeAssistant, ItemTypeThinking, ItemTypeToolAction,
		ItemTypeThread, ItemTypeMetaToolResult, ItemTypeError,
		ItemTypeSystemReminder, ItemTypeGuidance, ItemTypeCompactionSummary:
		return true
	default:
		return false
	}
}

// =============================================================================
// Context Item Types
// =============================================================================

// ContextItemData represents a context item in the conversation
type ContextItemData struct {
	ID                  string          `json:"id"`
	Type                string          `json:"type"` // Context item type: "tree", "read-file", "rule", etc.
	PreventUserDeletion bool            `json:"preventUserDeletion,omitempty"`
	Data                json.RawMessage `json:"data,omitempty"` // Type-specific data
}
