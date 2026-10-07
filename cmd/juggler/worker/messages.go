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
//     strategy-hook-response, build-subthread-spec-response
//   - threads: inject-thread-message, delivery-ended, create-thread,
//     resummarize-compaction-thread
//   - tool retry: retry-tool-approval, retry-tool-action, update-tool-action-for-retry
//   - context-item items: update-and-reposition-tool-actions,
//     reposition-context-item-placeholder
//   - sync/undo: yjs-sync, undo, redo, clear-history, stop-undo-capturing,
//     begin-undo-coalesce, end-undo-coalesce, request-full-state, resync-request,
//     resync-to-origin, clear-undo-stacks, get-transaction
//   - persistence: flush-persistence (save now and ack — the quit handshake's
//     "it's on disk" barrier)
//   - diagnostics: engine-trace, rename-log
//   - naming: request-auto-name (/handoff's promoted summary, or the tab bar's
//     manual "auto-name now")
//   - test-only: get-yjs-state, ping, set-mock-responses, release-mock
//
// NOTE: State mutations (item add/delete/update) flow through Yjs CRDT sync,
// not as messages. The worker observes Yjs document changes via RegisterItemsObserver.
//
// Messages FROM worker:
//   - render-context-items-request: Get rendered context item content for LLM
//   - request-tools: Get tool definitions from browser
//   - error: Unhandled exceptions
//   - yjs-sync: CRDT state updates
//   - resync-response: reply to resync-request — the ops the client is missing
//     plus the worker's own state vector, so the client can send back the ops
//     the WORKER is missing
//   - ack: Acknowledgment for acked operations
//   - pong: Reply to a test-only ping health check
package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
)

// ErrCancelled is returned when an operation is interrupted by user cancellation
// or tool denial. Check with errors.Is(err, ErrCancelled).
var ErrCancelled = errors.New("cancelled")

// ErrRestartStrategy is returned by callLLMWithRetry when a new user message
// arrived during a rate-limit wait. The caller must restart the strategy loop
// iteration so the new message is included in the LLM context.
var ErrRestartStrategy = errors.New("restart strategy")

// ErrPolitelyStopped is returned by callLLMWithRetry when a Pause landed while
// the turn sat in a retry backoff. The caller ends the turn as an ordinary rest:
// nothing was sent, so the transcript is a clean prefix and there is no failure
// to report — the run settles exactly as it would have at any other boundary.
var ErrPolitelyStopped = errors.New("politely stopped")

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
	Wait time.Duration
	// ResetAt is when the provider said the limit lifts, or the zero time when
	// it said nothing and Wait is therefore a guess. Only a stated reset may
	// stand over the rest of the conversation (see rate_limit_latch.go): holding
	// every thread on a number nobody supplied would turn one unlucky 429 into a
	// conversation that refuses to run.
	ResetAt time.Time
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

// UnusableOutputError is returned by callLLM when the provider abandoned a turn
// whose output could not be acted on (provider.UnusableOutputError). The same
// request is sent again, since a fresh sample usually lands where the last one
// did not.
type UnusableOutputError struct {
	Wait    time.Duration
	Message string
	Cause   error
}

func (e *UnusableOutputError) Error() string            { return e.Message }
func (e *UnusableOutputError) Unwrap() error            { return e.Cause }
func (e *UnusableOutputError) retryWait() time.Duration { return e.Wait }
func (e *UnusableOutputError) retryStatus(a, max int) string {
	return fmt.Sprintf("Unusable response, retrying (%d/%d)", a, max)
}

// LLMCallFunc is the signature for direct LLM calls from the worker.
// The chunkHandler receives streaming chunks (called from the provider goroutine).
// Returns the complete response when streaming finishes.
type LLMCallFunc func(ctx context.Context, request json.RawMessage, chunkHandler func(StreamChunk)) (*LLMResponse, error)

// ContextWindowInfo is a model's effective context window and output reserve
// (in tokens), with whether that window is a guess. A non-positive
// WindowTokens means "unknown".
type ContextWindowInfo struct {
	WindowTokens  int
	ReserveTokens int
	// Assumed is true when the window is a provider-wide fallback — the server
	// reported nothing for this model and no catalogue entry knew it — and the
	// user has not set one. Compaction says so, because a guessed window
	// decides both when a conversation folds and how long a reply may be.
	Assumed bool
}

// WindowResolverFunc resolves a model's context window from its identity alone,
// with no provider round-trip. Injected alongside the LLM caller for the places
// that need the model's limits without building a request. Returns the zero
// value when the model is unknown.
type WindowResolverFunc func(modelConfig ModelConfig) ContextWindowInfo

// AutoCompactGateFunc reports whether automatic compaction is enabled. A nil
// gate preserves the default enabled behavior.
type AutoCompactGateFunc func() bool

// AutoNameFunc is an injected server callback the worker fires so the server can
// derive a short tab title out-of-band. It fires automatically on the FIRST user
// message of the root conversation, and on demand for a request-auto-name
// message — /handoff's, once its summary has landed as the continued tab's first
// message (force=false), or the tab bar's "auto-name now" button (force=true).
// The worker only signals (convID, the first message text, the primary
// provider/model/thinking it will run under, and force); the server owns the
// enable gate, cheap-model resolution, the bounded completion, and the rename +
// broadcast. force=true bypasses the server's enable gate and its name-provenance
// guard, so a manual request always renames. Passing provider/model/thinking as
// plain strings keeps the worker free of any dependency on the server's model-ref
// type. Fire-and-forget: the callee must not block the worker goroutine (the
// server hands off to its own goroutine).
type AutoNameFunc func(convID, firstMessage, provider, model, thinking string, force bool)

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

	// StateVector is the sending client's Yjs state vector for this
	// conversation. An already-initialized worker answers it with just the ops
	// that vector does not cover, addressed to the sender alone — a document runs
	// to megabytes, and re-broadcasting one on every attach charges that to every
	// other viewer and the engine as well. Omitted when the client holds no
	// document to diff against, which is the one case that genuinely needs full
	// state. Base64 in JSON.
	StateVector []byte `json:"stateVector,omitempty"`
}

// SerializedConversation contains the initial conversation state. It carries
// only what the worker cannot recover for itself: the identity of the
// conversation and, for a brand-new one, its starting model. Everything else a
// conversation is made of — strategy, permission rules, allowed paths — lives in
// the Yjs doc and reaches the worker by sync, never through init.
type SerializedConversation struct {
	ID           string       `json:"id"`
	Name         string       `json:"name"`
	Created      string       `json:"created"`
	ModelConfig  *ModelConfig `json:"modelConfig,omitempty"`
	LoadFromDisk bool         `json:"loadFromDisk,omitempty"` // If true, load Yjs state from disk and extract metadata
}

// ModelConfig is the worker's name for a model selection. It IS core.ModelRef
// — the same type the default/cheap/recent model stores persist and the server
// decodes an LLM request into — so the (provider, model, thinking, serviceTier)
// quadruple is declared once and a new dial reaches every layer at once. The
// whole selection rides atomically through the thread tree: a thread override
// replaces it entire, never dial by dial.
type ModelConfig = core.ModelRef

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
	// Skills lists Agent Skill names the user explicitly chose to load before
	// this turn (via the composer `$name` mention or picker). Each is loaded as a
	// real `skill` tool-action — the same visible, auto-approved action the model
	// issues — injected ahead of the assistant's response so its instructions are
	// in context first. A skills-only send (empty Text) is a preload: the skills
	// load and the worker rests without starting an LLM turn.
	Skills []string `json:"skills,omitempty"`
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

// CancelMessage stops the turn in flight. Reason names the gesture behind it —
// the browser sends what the user did ("escape", "stop button", "slash
// command"); the worker's own internal cancels supply one of the cancelReason
// constants below. It exists solely so the log can say who stopped the turn: a
// cancel is otherwise indistinguishable from a turn that simply ended.
type CancelMessage struct {
	Type   string `json:"type"` // "cancel"
	Reason string `json:"reason,omitempty"`
}

// cancelReason is a short human-readable cause for a cancel, written to the
// per-conversation log and nothing else. It never reaches the model or the UI.
type cancelReason string

// Causes the worker raises for itself, with no gesture behind them.
const (
	// cancelReasonUnspecified is a cancel frame that named no reason — an older
	// client, or a hand-built frame.
	cancelReasonUnspecified cancelReason = "unspecified"
	// cancelReasonThreadDeleted is the items observer noticing the thread being
	// processed has been deleted out from under the turn.
	cancelReasonThreadDeleted cancelReason = "thread deleted"
	// cancelReasonUndoRedo is history navigation stopping the turn so the
	// document rollback can't be raced by the strategy's deferred writes.
	cancelReasonUndoRedo cancelReason = "undo/redo"
	// cancelReasonPendingRequest is a pending request (a createThread) whose
	// cancelRequested flag flipped, stopping the work it owns.
	cancelReasonPendingRequest cancelReason = "pending request cancelled"
)

// maxCancelReasonLen bounds a wire-supplied reason. The value is a log label,
// so anything longer is a mistake or an attempt to pad the log.
const maxCancelReasonLen = 64

// threadItemIDFromPayload reads the thread a pause/unpause frame names, "" for
// the root — which is also what an absent or malformed payload yields, since a
// pause with no thread on it is the conversation-wide one the root's column
// sends.
func threadItemIDFromPayload(payload json.RawMessage) string {
	var msg struct {
		ThreadItemID string `json:"threadItemId"`
	}
	if len(payload) == 0 || json.Unmarshal(payload, &msg) != nil {
		return ""
	}
	return msg.ThreadItemID
}

// cancelReasonFromPayload reads the reason off a cancel frame. Deliberately
// total: an absent, malformed or empty payload yields cancelReasonUnspecified
// rather than an error, because a cancel must never fail to cancel over its
// annotation.
func cancelReasonFromPayload(payload json.RawMessage) cancelReason {
	var msg CancelMessage
	if len(payload) == 0 || json.Unmarshal(payload, &msg) != nil {
		return cancelReasonUnspecified
	}
	return sanitizeCancelReason(msg.Reason)
}

// sanitizeCancelReason flattens control characters to spaces and truncates, so
// a reason arriving from the wire lands as one bounded log line and cannot
// forge others.
func sanitizeCancelReason(reason string) cancelReason {
	flat := strings.Map(func(r rune) rune {
		if r < ' ' || r == 0x7f {
			return ' '
		}
		return r
	}, reason)
	flat = strings.TrimSpace(flat)
	if runes := []rune(flat); len(runes) > maxCancelReasonLen {
		flat = strings.TrimSpace(string(runes[:maxCancelReasonLen]))
	}
	if flat == "" {
		return cancelReasonUnspecified
	}
	return cancelReason(flat)
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
	Type                   string              `json:"type"` // "provider-turn"
	Blocks                 []LLMResponseBlock  `json:"blocks"`
	StopReason             provider.StopReason `json:"stopReason"`
	InputTokens            int                 `json:"inputTokens"`
	InputTokensApproximate bool                `json:"inputTokensApproximate,omitempty"`
	OutputTokens           int                 `json:"outputTokens"`
	CachedTokens           *int                `json:"cachedTokens,omitempty"`
	CacheWriteTokens       *int                `json:"cacheWriteTokens,omitempty"`
	Autonomous             bool                `json:"autonomous"`
}

// StreamChunk represents a streamed LLM content chunk
type StreamChunk struct {
	TurnID          string                    `json:"-"`                         // Provider-attempt generation; assigned by the worker sink
	Type            provider.ContentBlockType `json:"type"`                      // Chunk type (text, thinking, tool_use, progress, usage, …)
	ItemID          string                    `json:"itemId,omitempty"`          // Item ID for UI tracking
	Content         string                    `json:"content,omitempty"`         // Content text
	OutputTokens    int                       `json:"outputTokens,omitempty"`    // Running output-token estimate, only set for type=="progress"
	CacheMissReason string                    `json:"cacheMissReason,omitempty"` // Consequential provider cache miss, only set for type=="status"

	// Notice is a durable warning this turn earned, already composed by the
	// provider. Only set for type=="status". CacheMissReason above is the
	// provider-cache special case, which owns its own lead text; anything else
	// worth keeping in the transcript — a serving tier the backend declined —
	// arrives here ready to insert.
	Notice *StreamNotice `json:"notice,omitempty"`

	// Metadata carries opaque provider data belonging to the block this chunk
	// is part of — an Anthropic thinking signature, an OpenAI reasoning item's
	// id and encrypted content. It rides on a thinking chunk because the value
	// is only known once the block ends, so a provider emits it as a trailing
	// contentless chunk and the worker attaches it to the item already on
	// screen. Persisted as the item's providerData and replayed on later turns.
	Metadata map[string]any `json:"metadata,omitempty"`

	// Set only for type=="usage" — a mid-stream anchor written as soon as
	// the provider emits its first usage event (e.g. Anthropic message_start
	// arrives ~100ms in with `input_tokens`). Lets the footer flip to "real
	// numbers only" immediately instead of waiting for end-of-turn.
	InputTokens  int   `json:"inputTokens,omitempty"`
	CachedTokens int   `json:"cachedTokens,omitempty"`
	CacheTTLMs   int64 `json:"cacheTTLMs,omitempty"`
}

// StreamNotice is a provider-composed durable warning bound for the transcript
// as an ItemTypeNotice. The provider writes the whole thing because only it
// knows what happened and in what words; the worker decides where it lands and
// that it lands only once.
type StreamNotice struct {
	Summary string `json:"summary"`          // One-line explanation; the transcript row's only text
	Content string `json:"content"`          // Plain-English lead, then the underlying values verbatim
	Source  string `json:"source,omitempty"` // What reported it, e.g. "openaicodex"
}

// llmCallResult is the in-process completion delivered from the provider
// goroutine. Err remains concrete so callers can inspect provider error types;
// LLMResponse.Error remains available for scripted and wire-compatible failures.
type llmCallResult struct {
	TurnID   string
	Response *LLMResponse
	Err      error
}

type deliveredLLMError struct {
	err error
}

func (e *deliveredLLMError) Error() string { return e.err.Error() }
func (e *deliveredLLMError) Unwrap() error { return e.err }

// LLMResponse represents a complete LLM response.
// CachedTokens / CacheWriteTokens are nil when the provider did not report
// cache usage for the call (unknown — NOT a miss); an explicit 0 means the
// provider reported zero. See provider.StreamResult for the full contract.
type LLMResponse struct {
	Blocks                  []LLMResponseBlock  `json:"blocks"`
	InputTokens             int                 `json:"inputTokens"`
	InputTokensApproximate  bool                `json:"inputTokensApproximate,omitempty"`
	OutputTokens            int                 `json:"outputTokens"`
	CachedTokens            *int                `json:"cachedTokens,omitempty"`
	CacheWriteTokens        *int                `json:"cacheWriteTokens,omitempty"`
	StopReason              provider.StopReason `json:"stopReason"`
	AdmissionEstimateTokens int                 `json:"admissionEstimateTokens,omitempty"` // Local pre-dispatch estimate; compare against InputTokens
	AdmissionAnchored       bool                `json:"admissionAnchored,omitempty"`       // Estimate projected from the previous turn's measured count
	Error                   string              `json:"error,omitempty"`
	TransactionID           string              `json:"transactionId,omitempty"`
	CacheTTLMs              int64               `json:"cacheTTLMs,omitempty"` // Provider's prompt-cache TTL in ms; 0 if no cache concept
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

// ItemContext represents context text from a standing context item. Every such
// item is injected as a leading message BEFORE the conversation history (inside
// the cached prefix); there is no trailing position. System-position items never
// reach here (their content is in the system prompt), and 'none'-position items
// (todo/plan, whose state lives in the model's own tool_use history) are dropped
// by the frontend before send.
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
	//
	// This says the tool CAN delegate, never that it must: WebFetch delegates
	// with a prompt and fetches the page itself without one. So it is not the
	// field to filter a tool list on — withholding everything that can delegate
	// would take WebFetch away from a sub-agent that needs it. RequiresDelegation
	// is the one that means "unusable unless delegated".
	DelegatesToSubthread bool `json:"delegatesToSubthread,omitempty"`
	// RequiresDelegation marks a delegating tool with NO inline behaviour — its
	// execute() can only report that it was not delegated. filterToolsForThread
	// withholds such a tool wherever delegationBlocked says this thread may not
	// delegate, so the model is never offered a call that could only fail.
	RequiresDelegation bool `json:"requiresDelegation,omitempty"`
	// ReadOnlySubthread declares that the child this tool delegates to cannot
	// change anything outside its own transcript — no writes to the working tree,
	// no state the caller or a sibling could observe. It is a claim made by the
	// owning item's MANIFEST about the CHILD, not about the tool, and nothing
	// verifies it; what it licenses is running such a child beside its siblings
	// instead of after them, so an item that overstates it trades a serialisation
	// guarantee for a race.
	//
	// Only meaningful alongside DelegatesToSubthread. It is stamped onto the
	// child's thread Y.Map at creation (see toolSpawn.ReadOnly), where
	// the reducer reads it back — the tool that spawned the child may be long
	// gone from the turn by the time the child is dispatched.
	ReadOnlySubthread bool `json:"readOnlySubthread,omitempty"`
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

// ResyncOfferMessage tells a freshly attached engine that this conversation is
// loaded on the server, without sending any of it.
//
// It carries no state deliberately. The engine's realm outlives its socket, so
// after a link drop it usually still holds the document and needs only the ops
// it missed — which it asks for with a resync-request carrying its own vector,
// the same delta handshake a reconnecting viewer uses. Pushing full state
// instead, as this seed once did, sent the entire CRDT of every loaded
// conversation on every reconnect: wasted almost always, and above what the
// client would accept as one message, fatal — the connection died, the engine
// reconnected, and the same state went out again.
//
// An engine that does not know the conversation ignores the offer and loads it
// the ordinary way (see _autoLoadConversation in web/js/services/worker-manager.js),
// which arrives at full state through init.
type ResyncOfferMessage struct {
	Type string `json:"type"` // "resync-offer"
}

// ResyncResponseMessage answers a resync-request in BOTH directions. Bytes is
// the delta the client is missing (as ResyncRequestMessage describes);
// StateVector is the worker's own state vector, from which the client computes
// the ops the WORKER is missing and returns them as an ordinary yjs-sync.
//
// A client's outbound updates are discarded while its socket is down — nothing
// queues them — so without the worker's vector every edit made during the
// outage would stay invisible to the worker, which is the source of truth and
// the thing that persists to disk. The vector rides this dedicated type rather
// than YjsSyncMessage so the streaming sync path (many frames per second)
// never carries it. Both fields are base64 in JSON.
type ResyncResponseMessage struct {
	Type        string `json:"type"` // "resync-response"
	Bytes       []byte `json:"bytes"`
	StateVector []byte `json:"stateVector"`
}

// ResummarizeCompactionThreadMessage requests a fresh summary for a compaction
// (/compact or /handoff) fold: clear its committed summary and re-arm the
// one-shot needsStrategyRun trigger so the folded-compaction summarizer runs
// again over the same source. It exists because that summarizer supplies its own
// prompt and reads the thread's items as inert data — routing a re-summarise
// through the ordinary close turn would append a "summarise this thread"
// instruction into the very transcript being summarized.
type ResummarizeCompactionThreadMessage struct {
	Type         string `json:"type"` // "resummarize-compaction-thread"
	ThreadItemID string `json:"threadItemId"`
	AckID        string `json:"ackId,omitempty"`
}

// =============================================================================
// Messages FROM Worker
// =============================================================================

// RenderContextItemsRequest requests rendered context item content for LLM context
type RenderContextItemsRequest struct {
	Type      string   `json:"type"` // "render-context-items-request"
	RequestID string   `json:"requestId"`
	ItemIDs   []string `json:"itemIds"`
	// SentAt is the wall-clock millisecond this request left the worker. The
	// engine echoes it back beside its own marks so a slow round-trip can be
	// split into the stage that was slow (roundtrip_timing.go).
	SentAt        int64             `json:"sentAt,omitempty"`
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
// ThreadItemID names the thread the hook belongs to (empty for root): strategy
// is per-thread, so the engine must run the hook on THAT thread's strategy and
// leave every other thread's alone.
type RunStrategyHookRequest struct {
	Type               string `json:"type"` // "run-strategy-hook"
	RequestID          string `json:"requestId,omitempty"`
	Hook               string `json:"hook"`       // "onActivate" | "onWorkerIdle"
	StrategyID         string `json:"strategyId"` // the worker's authoritative active strategy
	ThreadItemID       string `json:"threadItemId,omitempty"`
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

// RunContextHookRequest asks the engine to run a context-item lifecycle hook
// (onTurnEnd) across EVERY registered context-item type. Dispatched from the
// worker's root-idle chokepoint alongside the onWorkerIdle strategy hook, it is
// fire-and-forget: the engine invokes each type's static hook and there is
// nothing to wait for (onTurnEnd performs side-effects, not doc writes). Unlike
// a strategy hook it carries no strategy id — it fans out over the registry, not
// the conversation's one active strategy. Targeted at the engine only
// (sendToEngine), never broadcast, so each hook runs exactly once with no
// per-viewer ownership election.
type RunContextHookRequest struct {
	Type      string `json:"type"`      // "run-context-hook"
	Hook      string `json:"hook"`      // "onTurnEnd"
	TurnIndex int    `json:"turnIndex"` // completedTurns counter at this idle transition
}

// SubthreadSpec is the seed for a delegated child thread, produced by the
// engine's buildSubthreadSpec for a delegatesToSubthread tool. Goal/Prompt/
// ResultSpec map directly onto threadSpec.
//
// SessionName is the caller's handle for the child: a name matching a session
// this tool already started in the calling thread invokes THAT thread again
// (the prompt arrives as the next message in the transcript it already has)
// rather than spawning a fresh one. Empty, or matching nothing, starts a new
// session — which is the safe direction to fail in, since an unwanted create
// only costs a slower correct answer. A tool that wants this exposes it as an
// optional argument on its own schema and passes it through here.
//
// StrategyID and ModelConfig map onto threadSpec.StrategyID /
// ModelConfigJSON exactly as Goal/Prompt/ResultSpec map onto their fields: they
// pin the child's strategy and model, and omitting them leaves the child
// inheriting from its parent. A tool that owns a hidden strategy (a subagent)
// names it here, which is how a delegated run gets its own tool filter and
// approval policy without the strategy appearing in any user-facing list.
type SubthreadSpec struct {
	Goal        string          `json:"goal"`
	Prompt      string          `json:"prompt"`
	ResultSpec  string          `json:"resultSpec,omitempty"`
	SessionName string          `json:"sessionName,omitempty"`
	StrategyID  string          `json:"strategyId,omitempty"`
	ModelConfig json.RawMessage `json:"modelConfig,omitempty"`
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
// Browser-Requested Thread Creation Messages
// =============================================================================

// CreateThreadMessage requests thread creation from the browser, over
// WorkerManager#createThread. A strategy plugin's own createThread primitive
// does NOT come this way — it goes through pendingRequests (see
// handleCreateThread, which answers this one).
type CreateThreadMessage struct {
	Type           string `json:"type"` // "create-thread"
	RequestID      string `json:"requestId"`
	Goal           string `json:"goal"`
	Prompt         string `json:"prompt"`
	ThreadItemID   string `json:"threadItemId,omitempty"`   // parent thread (empty = root)
	IsContinuation bool   `json:"isContinuation,omitempty"` // continue thread without inserting a user prompt
}

// CreateThreadResponse answers a CreateThreadMessage.
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

// ClearUndoStacksMessage wipes undo/redo history after a conversation's
// non-user seeding (handleClearUndoStacks reads its ack id through ackIDOf).
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

// RequestAutoNameMessage asks for an out-of-band tab-title derivation from the
// conversation's first user message. Force distinguishes the two callers: the
// tab bar's "auto-name now" button sends true (the user asked for this name, so
// it overrides both the enable setting and the name-provenance guard), while
// /handoff sends false — a background rename that must respect a user who turned
// auto-naming off, or who named the source tab by hand.
type RequestAutoNameMessage struct {
	Type  string `json:"type"` // "request-auto-name"
	Force bool   `json:"force,omitempty"`
}

// SetMockResponsesMessage injects mock LLM responses for testing.
// When mock responses are set, callLLM() pops and returns them instead of calling real LLM.
type SetMockResponsesMessage struct {
	Type      string         `json:"type"` // "set-mock-responses"
	Responses []MockResponse `json:"responses"`
}

// MockResponse represents a scripted LLM response for testing.
type MockResponse struct {
	Blocks                 []LLMResponseBlock  `json:"blocks"`
	StopReason             provider.StopReason `json:"stopReason"`
	InputTokens            int                 `json:"inputTokens,omitempty"`
	InputTokensApproximate bool                `json:"inputTokensApproximate,omitempty"`
	OutputTokens           int                 `json:"outputTokens,omitempty"`
	CachedTokens           int                 `json:"cachedTokens,omitempty"`
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
	// Panic, when non-empty, makes this scripted turn panic with that value on
	// the turn's own goroutine, at the point the provider would be called. Tests
	// use it to exercise turn panic recovery (turn_panic.go).
	Panic string `json:"panic,omitempty"`
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
//
// RunningEpoch scopes a cancel-tool command to one execution generation (the
// value claimRunning stamped on the tool-action). The engine aborts an
// in-flight execution only when its epoch matches, so a cancel meant for a
// prior run can't kill a fresh re-run of the same toolUseId. Omitted (0) for
// evaluate-tool/execute-tool and for pre-claim cancels of an approved tool
// (no epoch stamped yet), where the abort stays unscoped.
type ToolCommand struct {
	Type         string `json:"type"`
	ToolUseID    string `json:"toolUseId"`
	RunningEpoch int64  `json:"runningEpoch,omitempty"`
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
	// ContextSeeded records that this thread's starting context has been cloned
	// from its parent, so the per-turn backstop (SeedThreadIfUnseeded) leaves it
	// alone. Carried on the item, not just the Y.Map, so a thread that survives a
	// serialization round-trip (undo/redo, fold) is not seeded a second time.
	ContextSeeded bool `json:"contextSeeded,omitempty"`

	// SessionName is a tool-spawned thread's handle within the thread that
	// called it: the name a later call passes to invoke this thread again
	// instead of spawning a fresh one. Stamped at creation, unique in the
	// calling thread, and reported at the head of every result the thread
	// returns — so a caller that never planned to follow up can still do so.
	SessionName string `json:"sessionName,omitempty"`

	// AliasOf names the thread this item is a second view of: an alias holds no
	// transcript, and the transcript it shows belongs to the canonical thread
	// item with this id, standing earlier in the same array. One parent item per
	// call into a thread is what keeps the parent's wire history in call order —
	// an alias is appended where the call was made, so a later call can never
	// slide an earlier one's tool_result out from under a warm prompt cache.
	//
	// Its presence is what makes an item an alias. An alias carries a run
	// selector (the Run* fields below) naming which single run of the canonical
	// transcript it stands for, plus frozen display copies of `goal` and
	// `sessionName` that are read by the tile alone and never as truth.
	AliasOf string `json:"aliasOf,omitempty"`

	// Thread-run control fields, set by a fold that produces an UNSUMMARIZED
	// bounded-compaction thread (the /compact shape the browser fold also
	// builds). checkForNewThreads picks up NeedsStrategyRun and runs the thread
	// through the folded-compaction summarizer; NoAutoSelect keeps the fold off
	// the active tab and marks it for one-undo-group merge; NoContextSeed stops
	// starting-context re-injection into a thread already populated by
	// relocation; ForceTool names a tool the model must call on every turn of
	// this thread, a seam any plugin may set and nothing in the core does.
	// HandoffPromote tags a /handoff fold so the browser promotes its result into
	// the parked first message of the continued tab. All omitempty so ordinary
	// items and already-summarized recovery folds stay byte-identical.
	NeedsStrategyRun bool   `json:"needsStrategyRun,omitempty"`
	NoAutoSelect     bool   `json:"noAutoSelect,omitempty"`
	NoContextSeed    bool   `json:"noContextSeed,omitempty"`
	ForceTool        string `json:"forceTool,omitempty"`
	HandoffPromote   bool   `json:"handoffPromote,omitempty"`

	// FoldedRuns carries the run records of the invocation messages a
	// bounded-compaction fold swallowed, in the order they stood in the
	// transcript the fold replaced. A fold takes the place of the messages it
	// folded, so a thread's calls are still read in call order from its own
	// items — some live, some carried by the fold sitting where they used to be
	// (threadRunRecords). Set only on fold threads.
	FoldedRuns []FoldedRun `json:"foldedRuns,omitempty"`

	// Context-item specific fields
	PreventUserDeletion bool   `json:"preventUserDeletion,omitempty"` // Whether context item cannot be deleted by user
	IsNew               bool   `json:"isNew,omitempty"`               // Whether context item is newly created
	Error               string `json:"error,omitempty"`               // Error message for context items

	// Run record — carried by a user item that STARTED a run (an "invocation
	// message"). RunToolUseID/RunToolName/RunToolInput name the parent's tool
	// call, while RunGoal preserves the resolved short display label returned by
	// buildSubthreadSpec. RunStatus/RunResult record how the run it began settled.

	// On a THREAD item the same three coordinates mean something adjacent: they
	// are that item's RUN SELECTOR — which single run of the transcript this
	// item is the parent's view of. Same run, same identity, read from both
	// ends: the child stamps the message that started the run, the parent stamps
	// the item that called it. A thread item never carries RunStatus/RunResult —
	// the outcome lives on the run's own record, in the canonical's transcript.
	// Readers that mean "invocation message" therefore test the item type too
	// (isInvocationMessage), because a thread item standing in a transcript is a
	// child, not a call into the thread that holds it.
	//
	// This is what makes a subthread resumable. The coordinates used to live on
	// the thread Y.Map, which is scalar — one pairing per thread for all time, so
	// a thread could only ever be invoked once. Held per-message instead, N
	// invocations are N stamped user items in order down the child's transcript,
	// each paired against the run it began.
	//
	// They are deliberately NOT called toolUseId/toolName/toolInput: those keys
	// mean "this item IS a tool call", and a good deal of code keys off their
	// mere presence (the compaction leading-run classifier at document.go, the
	// browser's context-item scans) or looks them up across all item types with
	// no type guard. A separate namespace keeps a user item a user item.
	//
	// The outcome is stored rather than re-derived because a run's trailing items
	// are user-editable and deletable: buildMessages must still reconstruct a
	// stable tool_use/tool_result pair for a run whose transcript has since been
	// edited.
	RunToolUseID string          `json:"runToolUseId,omitempty"`
	RunToolName  string          `json:"runToolName,omitempty"`
	RunToolInput json.RawMessage `json:"runToolInput,omitempty"`
	RunGoal      string          `json:"runGoal,omitempty"`
	RunStatus    string          `json:"runStatus,omitempty"`
	RunResult    string          `json:"runResult,omitempty"`

	// Continuation marks the message a Continue appends to start a run with
	// nothing new to say (continuationMarker). It carries no content and emits no
	// wire message; it exists so that run has a record of its own to be stamped
	// with, the way a call has its invocation message and typing has the user's
	// text. Reusing the previous run's record instead would rewrite an outcome the
	// parent may already have read.
	Continuation bool `json:"continuation,omitempty"`

	// RunItemID is the other run selector: the ItemID of the child message that
	// STARTED the run this thread item stands for. It names the same thing
	// RunToolUseID does — one run of the canonical transcript — for a run no call
	// made, so there is no tool-use id to name it by. A receipt item (receiptItem)
	// carries it; nothing else does.
	//
	// Every run has a starting message, which is what makes this a total
	// selector: a delegated call appends its invocation message, typing into a
	// stopped child appends a user message, and Continue appends a continuation
	// marker.
	RunItemID string `json:"runItemId,omitempty"`

	// RunResultFed marks a thread item whose REAL result — not the pending
	// placeholder — has been emitted to the provider (buildMessagesFromItems
	// stamps it, under the same stampPending gate as a tool-action's
	// resultFedTurn, so snapshot consumers never write).
	//
	// It answers the one question the document otherwise cannot: has the model
	// already been given this item's answer? A pair may be emitted many times as
	// a placeholder before it is ever emitted as an answer, so position in the
	// transcript cannot tell the two apart. Once set, the item is a receipt for
	// something already on the wire and its content may never move again — a
	// later run of the same session is appended as a new item instead
	// (settleThreadRun). Unlike a tool-action's resultFedTurn it records no turn
	// and never expires: the question is whether the model has this item's
	// answer, not whether it had it recently.
	RunResultFed bool `json:"runResultFed,omitempty"`

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

// FoldedRun is one delegated run's record, preserved on the compaction fold
// that swallowed the invocation message carrying it (ConversationItem.
// FoldedRuns). The fields mirror the message's own run fields exactly, because
// this is a verbatim copy: the caller's tool_result for a run that has already
// returned is frozen at the moment that run settled, and a fold must not
// disturb a single byte of it.
//
// Preserving the record is what lets a fold swallow an invocation message at
// all. The message itself is small — the fold is after the run bodies between
// them — but the record is the only copy of the pairing between the caller's
// tool_use and what the run returned, and of which tool owns the session.
type FoldedRun struct {
	ToolUseID string          `json:"runToolUseId,omitempty"`
	ToolName  string          `json:"runToolName,omitempty"`
	ToolInput json.RawMessage `json:"runToolInput,omitempty"`
	Goal      string          `json:"runGoal,omitempty"`
	Status    string          `json:"runStatus,omitempty"`
	Result    string          `json:"runResult,omitempty"`
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
	ItemTypeProviderState  = "provider-state"
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
	// ItemTypeNotice is a durable, user-facing record of something that happened
	// to a turn and is worth reading after the fact — a provider rebuilding its
	// context cache, say. It carries Summary (a one-line explanation, the whole
	// of the transcript row), Content (the detail, ending in the underlying
	// reason verbatim) and Source (what
	// reported it), and optionally Data naming a setting that corrects the cause
	// (assumedWindowNoticeData), which the browser turns into the row's one
	// link. It stands in the transcript at the point the event occurred,
	// and is never sent to the LLM: itemWireMessages has no case for it, so it
	// emits nothing (TestNoticeItemEmitsNothingToTheLLM pins that).
	ItemTypeNotice = "notice"
)

// isConversationalItemType reports whether an item type is conversation history
// — a message, tool call, sub-thread, or strategy-injected instruction — as
// opposed to a standing context item (system-prompt, memory, file-content,
// rule, plan, …). Used to bound the leading run of starting-context items a
// sub-thread is seeded with (see collectSeedItemMaps): the run ends at the
// first conversational item.
func isConversationalItemType(t string) bool {
	switch t {
	case ItemTypeUser, ItemTypeAssistant, ItemTypeThinking, ItemTypeProviderState, ItemTypeToolAction,
		ItemTypeThread, ItemTypeMetaToolResult, ItemTypeError,
		ItemTypeSystemReminder, ItemTypeGuidance, ItemTypeCompactionSummary,
		ItemTypeNotice:
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
