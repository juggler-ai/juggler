//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package provider

import (
	"context"
	"encoding/json"
	"math"
	"time"
)

// Message represents a unified conversation message using discriminated union via Type field.
// This matches the frontend Message type exactly - the frontend sends these directly to Go providers.
type Message struct {
	Type string `json:"type"` // "user", "assistant", "thinking", "tool-use", "tool-result", "context-item", "context-item-updated", "guidance", "system-reminder", "error", "system"

	// Content field - used by user, assistant, context-item, context-item-updated, system-reminder, tool-result
	Content string `json:"content,omitempty"`

	// Thinking-specific fields
	ProviderData map[string]any `json:"providerData,omitempty"` // Opaque provider data (e.g., Anthropic thinking signatures)

	// Tool-use specific fields
	ToolUseID string         `json:"toolUseId,omitempty"` // ID for matching tool-use with tool-result
	ToolName  string         `json:"toolName,omitempty"`  // Tool name
	ToolInput map[string]any `json:"toolInput,omitempty"` // Tool input parameters

	// Tool-result specific fields
	IsError    bool           `json:"isError,omitempty"`    // Whether this result is an error
	ResultType string         `json:"resultType,omitempty"` // 'context' | 'action' | 'meta-tool'
	FullResult map[string]any `json:"fullResult,omitempty"` // For UI rendering

	// Context item-specific fields
	ItemID   string `json:"itemId,omitempty"`   // Reference to context item instance
	IsNew    bool   `json:"isNew,omitempty"`    // Whether context item is newly added
	IsGlobal bool   `json:"isGlobal,omitempty"` // Whether context item is global session-level

	// Error-specific fields
	Message        string `json:"message,omitempty"`        // Error message (also used by system messages)
	Stack          string `json:"stack,omitempty"`          // Error stack trace
	HasRetryButton bool   `json:"hasRetryButton,omitempty"` // Whether to show retry button

	// System-specific fields
	EventType string `json:"eventType,omitempty"` // Event type for system messages
	Source    string `json:"source,omitempty"`    // Source for system-reminder

	// Parts carries non-text inputs attached to this message (v1: images).
	// Only user-role messages carry parts. The bytes live out-of-doc in the
	// asset store; what travels in the worker→provider request JSON is the
	// reference (AssetID + mime + dims), never the bytes — see MediaPart.
	Parts []MediaPart `json:"parts,omitempty"`
}

// MediaPart is one non-text input attached to a message (v1: images).
// Bytes live out-of-doc in the asset store and are resolved into Data at the
// server LLM-call boundary; Data is intentionally json:"-" so it never enters
// the worker→provider request JSON nor the cost estimator's marshaling — the
// stable identity on the wire is AssetID.
type MediaPart struct {
	Type    string `json:"type"`              // "image"
	Mime    string `json:"mime"`              // e.g. "image/png"
	AssetID string `json:"assetId,omitempty"` // sha256 hex; resolves bytes from the asset store
	Data    []byte `json:"-"`                 // raw bytes, filled server-side before Submit; never serialized
	Width   int    `json:"width,omitempty"`
	Height  int    `json:"height,omitempty"`
}

// MessageTypeToRole maps message types to LLM roles (user or assistant)
// Types that map to empty string are filtered out (UI-only messages)
func MessageTypeToRole(msgType string) string {
	switch msgType {
	case "user", "tool-result", "context-item", "context-item-updated", "guidance", "system-reminder":
		return "user"
	case "assistant", "thinking", "tool-use":
		return "assistant"
	default:
		// "error", "system" are UI-only, don't send to LLM
		return ""
	}
}

// MessageRequest represents a request to send messages
type MessageRequest struct {
	Messages       []Message
	SystemPrompt   string
	Tools          []ToolDefinition       // Tool definitions for LLM to use
	ConversationID string                 // Optional: for providers that need to correlate requests (e.g., MCP)
	ThreadID       string                 // Optional: scopes the turn to a thread ("" = root); stateful providers may keep a per-thread session, stateless ones ignore it
	ShouldContinue ShouldContinueCallback // Optional: called after each turn to check if loop should continue
	ToolChoice     *ToolChoice            // Optional: constrain which tool the model must call this turn. Nil = auto.

	// MaxOutputTokens optionally caps this one request's wire output length
	// (max_tokens), independent of the client/model default. 0 means "use the
	// client/model default". Introduced so hidden compaction map calls can be
	// output-bounded without a runaway final summary being truncated. When set it
	// may only *lower* the effective wire cap, never raise it: adapters apply it
	// as a min() against their existing client-level value, and admission charges
	// the smaller reserve so the wire cap and the admission reserve never diverge.
	MaxOutputTokens int64

	// BypassContextGuard explicitly permits this request to dispatch when a
	// silent-truncation provider's conservative estimate is over its input
	// ceiling. The worker sets it only for one visible fallback attempt after
	// structured recovery cannot progress, and for hidden compaction requests
	// whose own bounded pack/split controller already handles context pressure.
	BypassContextGuard bool

	// ThinkingLevel selects how much extended reasoning / "thinking" the model
	// does this turn, named in the provider's OWN native vocabulary. It is one
	// of the strings the model advertised in ModelInfo.ThinkingLevels (e.g.
	// "low" / "high" / "xhigh" / "none" / "max"), or "" for the provider default
	// — no thinking parameter is sent, byte-identical to pre-feature behaviour.
	// Each provider maps the string to its native parameter at its own boundary
	// (Anthropic thinking budget, OpenAI reasoning_effort, claudecode
	// MAX_THINKING_TOKENS, …) and ignores any value it doesn't recognise — same
	// contract as ToolChoice. Per-turn (not on Config) by design, so flicking
	// the level never churns the conversation cache handle.
	ThinkingLevel string
}

// ToolChoice constrains which tool (if any) the model must call on a turn.
// Nil on a MessageRequest means "auto" — the model decides — which is the
// default for every normal turn. It exists so a plugin can FORCE a tool: the
// plugin declares the constraint on its thread (a Yjs field; see the worker's
// resolveForcedToolChoice), the worker translates that into this provider-
// agnostic shape, and each provider maps it to its native API. This is the one
// generic mechanism; no provider or plugin hardcodes a specific tool name.
//
// Mode is the generic concept providers translate at their boundary:
//   - ToolChoiceTool: the model MUST call the tool named Name. (Anthropic
//     {type:"tool",name}; OpenAI {type:"function",function:{name}} / Responses
//     {type:"function",name}; Gemini functionCallingConfig{mode:ANY,
//     allowedFunctionNames:[name]}.)
//   - ToolChoiceAny:  the model must call SOME tool.
//   - ToolChoiceNone: the model must not call any tool.
//   - ToolChoiceAuto / "": the model decides (the nil-equivalent default).
//
// Providers without a forced-tool API (claudecode's CLI) ignore this; callers
// that depend on the tool actually being invoked must keep a fallback.
type ToolChoice struct {
	Mode string `json:"mode,omitempty"`
	Name string `json:"name,omitempty"` // tool name, required when Mode == ToolChoiceTool
}

// ToolChoice modes — the generic vocabulary providers translate into their
// native tool_choice / functionCallingConfig parameters.
const (
	ToolChoiceAuto = "auto" // model decides (default; also the nil ToolChoice)
	ToolChoiceAny  = "any"  // model must call some tool
	ToolChoiceTool = "tool" // model must call the named tool
	ToolChoiceNone = "none" // model must not call any tool
)

// ToolDefinition defines a tool the LLM can use
type ToolDefinition struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"input_schema"` // Raw JSON schema
}

// ToolCall represents a tool invocation request
type ToolCall struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Input string `json:"input"` // JSON string
}

// ContentBlockType identifies the type of content block
type ContentBlockType string

const (
	ContentBlockTypeText             ContentBlockType = "text"
	ContentBlockTypeThinking         ContentBlockType = "thinking"
	ContentBlockTypeRedactedThinking ContentBlockType = "redacted_thinking"
	ContentBlockTypeToolUse          ContentBlockType = "tool_use"
	ContentBlockTypeToolResult       ContentBlockType = "tool_result"
	ContentBlockTypeImage            ContentBlockType = "image"
	ContentBlockTypeCode             ContentBlockType = "code"
	ContentBlockTypeCodeResult       ContentBlockType = "code_result"
	ContentBlockTypeStatus           ContentBlockType = "status"   // Transient status (e.g. rate-limit retries), not stored as content
	ContentBlockTypeProgress         ContentBlockType = "progress" // Transient mid-stream progress (running output-token estimate); never stored
	ContentBlockTypeUsage            ContentBlockType = "usage"    // Transient mid-stream usage anchor (input/cached tokens, cache TTL); never stored
)

// ContentBlock represents a structured piece of content in a response
type ContentBlock struct {
	Type    ContentBlockType `json:"type"`
	Content string           `json:"content"`

	// Tool use fields (only populated when Type == ContentBlockTypeToolUse)
	ToolUseID string         `json:"toolUseId,omitempty"` // Required for tool_use blocks
	ToolName  string         `json:"toolName,omitempty"`  // Required for tool_use blocks
	ToolInput map[string]any `json:"toolInput,omitempty"` // Required for tool_use blocks (parsed object)

	// Provider-specific extensions (citations, signatures, mime types, etc.)
	Metadata map[string]any `json:"metadata,omitempty"`
}

// StructuredResponse represents a response with structured content blocks.
// Token-field semantics match StreamResult — see that type for the contract.
type StructuredResponse struct {
	Blocks                 []ContentBlock `json:"blocks"`
	StopReason             string         `json:"stopReason,omitempty"`
	InputTokens            int            `json:"inputTokens,omitempty"`
	InputTokensApproximate bool           `json:"inputTokensApproximate,omitempty"`
	OutputTokens           int            `json:"outputTokens,omitempty"`
	CachedTokens           int            `json:"cachedTokens,omitempty"`
	CacheWriteTokens       int            `json:"cacheWriteTokens,omitempty"`
}

// StreamResult contains metadata about a completed stream.
//
// Token-field semantics — providers MUST normalise to these meanings at
// their boundary so consumers (UI cache display, transaction blob,
// cost tracking) don't have to know provider quirks:
//
//   - InputTokens:      TOTAL prompt tokens sent that turn. Includes
//     any portion served from cache and any portion
//     written to cache. (Don't conflate with the
//     Anthropic SDK's `input_tokens`, which is fresh-
//     only — claudecode/anthropic providers sum
//     fresh + cache_read + cache_creation here.)
//   - InputTokensApproximate: InputTokens came from a local fallback estimate
//     because the provider supplied no input usage. False means provider-reported
//     (and remains the compatible default when the field is absent).
//   - OutputTokens:     Output tokens generated.
//   - CachedTokens:     Prompt tokens served from prompt cache (subset
//     of InputTokens). Anthropic cache_read /
//     OpenAI prompt_tokens_details.cached_tokens.
//   - CacheWriteTokens: Prompt tokens written to cache this turn
//     (subset of InputTokens). Anthropic
//     cache_creation; 0 for providers without an
//     explicit cache-write phase.
type StreamResult struct {
	StopReason             string `json:"stopReason,omitempty"`
	InputTokens            int    `json:"inputTokens,omitempty"`
	InputTokensApproximate bool   `json:"inputTokensApproximate,omitempty"`
	OutputTokens           int    `json:"outputTokens,omitempty"`
	CachedTokens           int    `json:"cachedTokens,omitempty"`
	CacheWriteTokens       int    `json:"cacheWriteTokens,omitempty"`
}

// ProviderTurn is a complete turn surfaced by a Conversation — either
// solicited (the result of a Submit) or autonomous (the backend emitted it
// unprompted: a scheduled wake / monitor firing through a persistent CLI).
// It carries the assembled content blocks and final usage so the consumer
// can land it in its store without re-parsing the wire. Autonomous turns are
// the reason this type exists: a request/response contract has no place to
// put a turn nobody asked for.
type ProviderTurn struct {
	Blocks     []ContentBlock
	Result     StreamResult
	Autonomous bool // true when no Submit was in flight (scheduled wake / monitor)
}

// TurnSink receives complete turns from a Conversation, in arrival order.
// The consumer (the worker) owns the sink; the provider calls DeliverTurn.
// DeliverTurn may be invoked from a provider-owned goroutine — claudecode's
// always-on stdout reader surfaces autonomous turns off the worker goroutine
// — so implementations must be safe to call concurrently with the worker's
// own activity. The worker's sink enqueues onto its inbound FIFO. Each turn is
// delivered as it completes (rather than sitting unread for the next Submit to
// mis-read), so turns are never mis-attributed.
// The relative Yjs *ordering* of an autonomous turn vs. a user message is
// best-effort, not guaranteed: a turn that completes at the same instant the
// user sends races the send to the FIFO and may land just after the user
// message. That ordering is cosmetic.
type TurnSink interface {
	DeliverTurn(turn ProviderTurn)
}

// EstimateTokens estimates token count from text (~4 chars/token).
// Use as a fallback when the provider doesn't report usage.
func EstimateTokens(text string) int {
	return len(text) / 4
}

// flatImageTokenEstimate is the per-image token cost assumed when an image's
// pixel dimensions are unknown (e.g. webp, which the stdlib can't decode). It
// is a deliberately generous round number so a missing dimension never
// under-counts a normal screenshot, and it also floors the pixel heuristic.
const flatImageTokenEstimate int64 = 1300

// maxFallbackImageTokens caps the dimensionless, byte-derived fallback so a
// single large attachment with unknown dimensions cannot alone exceed a model
// window. Vision models cost far less than this per image; the ceiling keeps
// admission conservative but bounded.
const maxFallbackImageTokens int64 = 6000

// EstimateImageTokens estimates the prompt-token cost of one image MediaPart.
// It follows Anthropic's published heuristic — tokens ≈ (width*height)/750 —
// when the pixel dimensions are known, and falls back to a bounded per-image
// estimate when they are not. Non-image parts contribute nothing.
func EstimateImageTokens(p MediaPart) int {
	estimate := estimateImageTokens64(p)
	if estimate > int64(^uint(0)>>1) {
		return int(^uint(0) >> 1)
	}
	return int(estimate)
}

// estimateImageTokens64 charges an image by its pixel/tile estimate whenever
// its dimensions are known, and never by its raw byte length: a compressed
// image's on-wire bytes bear no relation to its vision-token cost, and charging
// bytes could hard-fail an image-bearing turn on an otherwise empty context.
// Only when dimensions are absent does it fall back to a byte-derived charge,
// floored at the flat estimate and capped so one attachment cannot alone blow
// the window.
func estimateImageTokens64(p MediaPart) int64 {
	if p.Type != "image" {
		return 0
	}
	if p.Width > 0 && p.Height > 0 {
		width := int64(p.Width)
		height := int64(p.Height)
		if width > math.MaxInt64/height {
			return math.MaxInt64
		}
		if pixels := width * height; pixels/750 > flatImageTokenEstimate {
			return pixels / 750
		}
		return flatImageTokenEstimate
	}
	byteEstimate := int64(len(p.Data))
	if byteEstimate < flatImageTokenEstimate {
		return flatImageTokenEstimate
	}
	if byteEstimate > maxFallbackImageTokens {
		return maxFallbackImageTokens
	}
	return byteEstimate
}

// StreamChunk represents a chunk of streaming content with type information
type StreamChunk struct {
	Type    ContentBlockType `json:"type"`
	Content string           `json:"content"`

	// Tool use fields (only populated when Type == ContentBlockTypeToolUse)
	ToolUseID string         `json:"toolUseId,omitempty"` // Required for tool_use chunks
	ToolName  string         `json:"toolName,omitempty"`  // Required for tool_use chunks
	ToolInput map[string]any `json:"toolInput,omitempty"` // Required for tool_use chunks (parsed object)

	// Provider-specific extensions (citations, signatures, mime types, etc.)
	Metadata map[string]any `json:"metadata,omitempty"`
}

// ResultStatus indicates the outcome of a tool execution.
// Used to determine display styling and loop continuation behavior.
type ResultStatus string

const (
	ResultStatusSuccess   ResultStatus = "success"   // Tool executed successfully, loop continues
	ResultStatusError     ResultStatus = "error"     // Tool execution failed, loop continues (LLM may retry)
	ResultStatusDenied    ResultStatus = "denied"    // User denied approval, loop stops
	ResultStatusCancelled ResultStatus = "cancelled" // User cancelled execution, loop stops
)

// IsError returns true if this status indicates an error (for API display styling)
func (s ResultStatus) IsError() bool {
	return s == ResultStatusError
}

// VetosContinuation returns true if this status should stop the tool loop
func (s ResultStatus) VetosContinuation() bool {
	return s == ResultStatusDenied || s == ResultStatusCancelled
}

// ToolResult is returned by callback when executing a tool.
// For non-tool_use chunks, callback returns nil.
// For tool_use chunks, callback executes the tool and returns the result.
type ToolResult struct {
	ToolUseID    string       `json:"toolUseId"`    // Must match the tool_use chunk's ToolUseID
	Content      string       `json:"content"`      // The result content
	ResultStatus ResultStatus `json:"resultStatus"` // Outcome: "success", "error", "denied", "cancelled"
	Category     string       `json:"category"`     // Tool category: "read", "write", "meta"
}

// ShouldContinueResult is returned by ShouldContinueCallback
type ShouldContinueResult struct {
	ShouldContinue bool   // Whether to continue the tool execution loop
	Message        string // Message to inject if stopping (e.g., "provide final response")
}

// ShouldContinueCallback is called after each turn in the tool execution loop.
// Strategies use this to control iteration limits and emit warnings.
// turnNumber is 1-indexed, toolCallCount is the cumulative count of tool calls.
type ShouldContinueCallback func(turnNumber int, toolCallCount int) (*ShouldContinueResult, error)

// StructuredStreamCallback is called for each chunk of streamed content with type info.
// For tool_use chunks, the callback MUST execute the tool and return a ToolResult.
// For non-tool chunks (text, thinking), return nil for the ToolResult.
// All providers use this callback to execute tools during streaming, enabling them
// to receive results and continue the conversation.
type StructuredStreamCallback func(chunk StreamChunk) (*ToolResult, error)

// ModelInfo contains detailed information about a specific model
type ModelInfo struct {
	ID              string // Model ID/name — the wire identifier sent to the provider
	ContextWindow   int    // Input token limit (0 if unknown)
	MaxOutputTokens int    // Output token limit (0 if unknown)
	FromAPI         bool   // True if retrieved from API, false if hardcoded fallback
	// DisplayName is a human-readable label supplied by the provider (e.g.
	// Gemini's API returns "Gemini 2.5 Pro" for id "models/gemini-2.5-pro").
	// Empty when the provider exposes no such name — the UI then derives a
	// readable label from the ID itself. Never sent on the wire; presentation
	// only.
	DisplayName string
	// InputModalities lists the input kinds the model accepts, e.g.
	// ["text","image"]. Empty/nil means text-only by convention — consumers
	// must treat absence as text-only and never force-populate "text" for
	// every model. Set only for models with verified non-text input support.
	InputModalities []string
	// ThinkingLevels lists the reasoning-effort tiers this model supports, in
	// display order, each named in the provider's OWN native vocabulary (e.g.
	// "low"/"medium"/"high", or "none"/"low"/"high"/"xhigh"). A level string IS
	// the identity — shown in the UI verbatim, stored, and sent back on the next
	// turn as MessageRequest.ThinkingLevel for the provider to map to its native
	// parameter. Empty/nil ⇒ the model exposes no thinking control and the UI
	// hides the selector.
	ThinkingLevels []string
	// DefaultThinkingLevel names the level the provider uses when the request
	// carries none — one of ThinkingLevels, in that native vocabulary.
	// Presentation only (lets the UI label "Default (medium)"). Empty when
	// unknown.
	DefaultThinkingLevel string
}

// UsageStat is one provider-specific quota/plan usage signal normalised for UI
// display. Providers should only return stats they can fetch from an upstream
// source; absence means "unknown", not zero usage.
type UsageStat struct {
	Name        string     `json:"name"`                  // e.g. "Session (5h)", "Week (7d)", "Balance"
	UsedPercent *float64   `json:"usedPercent,omitempty"` // 0..100 where known; nil ⇒ no meter (e.g. a raw balance)
	Detail      string     `json:"detail,omitempty"`      // Absolute display value, e.g. "$12.34 left" — shown with or instead of the meter
	ResetsAt    *time.Time `json:"resetsAt,omitempty"`    // Window reset time, if provided by upstream
	WindowSecs  int        `json:"windowSecs,omitempty"`  // Window duration in seconds, if known
	Category    string     `json:"category,omitempty"`    // e.g. "primary", "weekly", "model", "code_review", "balance"
}

// Pct returns a pointer to v for use as UsageStat.UsedPercent. A nil
// UsedPercent means "no meter" (e.g. a raw balance), distinct from 0%.
func Pct(v float64) *float64 { return &v }

// UsageStats is a best-effort provider-level quota/plan usage snapshot. The
// shape deliberately stays generic because providers expose different limit
// windows and labels.
type UsageStats struct {
	Provider  string      `json:"provider"`
	Plan      string      `json:"plan,omitempty"`
	UpdatedAt time.Time   `json:"updatedAt"`
	Stats     []UsageStat `json:"stats"`
}

// UsageStatsProvider is implemented by providers that can report account/plan
// usage outside of a single LLM turn. Most providers won't implement it.
type UsageStatsProvider interface {
	UsageStats(ctx context.Context) (UsageStats, error)
}

// Provider is the factory for Conversation handles. Per-conversation
// state — session tokens, pending tool calls, live subprocess handles —
// lives on the Conversation, not the Provider. Most providers' Client
// is just metadata (model, credentials, HTTP client) and OpenConversation
// returns a thin per-turn dispatcher; claudecode is the stateful outlier
// (each handle owns a live CLI subprocess + session bookkeeping).
type Provider interface {
	// Name returns the provider's registry name (e.g., "anthropic", "gemini").
	Name() string

	// ListModelsWithInfo returns detailed information about available models
	// including context windows. Returns an error if the API call fails.
	// If the provider doesn't expose context window info via API, returns
	// models with hardcoded fallback values (FromAPI = false).
	ListModelsWithInfo(ctx context.Context) ([]ModelInfo, error)

	// OpenConversation returns a handle for sending and receiving on a
	// single conversation. Implementations may return a thin stateless
	// wrapper (most providers; the handle just holds the client + model)
	// or a stateful one (claudecode tracks per-thread session UUIDs, pending
	// tool calls, live CLI subprocesses — keyed internally by the turn's
	// MessageRequest.ThreadID). The handle is reused across turns and
	// should be Close()d when the conversation is deleted.
	OpenConversation(ctx context.Context, convID string) (Conversation, error)
}

// Conversation is one logical LLM dialogue, with provider-side state (if
// any) that persists across turns.
//
// Concurrency invariant: methods are called serially per Conversation —
// the worker manager (cmd/juggler/worker.Manager) owns one goroutine per
// conversationID and dispatches all calls through it. Implementations
// therefore don't need internal synchronisation. Violating this from
// outside the worker manager is a bug at the call site, not in the
// implementation; the manager is the sole sanctioned caller and the
// guarantee is enforced there.
type Conversation interface {
	// Submit drives one LLM turn from req. req.Messages carries the
	// conversation prefix the provider may already know about; if the prefix
	// diverges from prior provider-side state the provider may cold-start. The
	// turn is either a fresh user turn or a continuation of a turn that paused
	// at tool_use — providers derive which from req.Messages' trailing entries
	// (a tool-result tail means "resume the paused turn"), so there is no
	// separate delivery call. Stateless HTTP providers handle the whole tool
	// loop inside one request/response and treat both cases identically;
	// claudecode resumes its live CLI for a tool-result tail. Streams chunks to
	// callback; returns usage/stop-reason metadata.
	//
	// This is the foreground (solicited) path. Turns the backend emits with no
	// Submit in flight arrive via the TurnSink registered with Subscribe.
	Submit(ctx context.Context, req MessageRequest, callback StructuredStreamCallback) (*StreamResult, error)

	// Subscribe registers the sink that receives turns the conversation's
	// backend emits autonomously — with no Submit in flight — such
	// as a scheduled wake or monitor firing through a persistent CLI process.
	// Called once by the consumer after OpenConversation; passing nil detaches.
	// Purely-reactive providers (the HTTP backends) never emit autonomously and
	// implement this as a no-op. The single sanctioned caller is the server's
	// conversation cache, at open time, before the handle is used for a turn —
	// so the field write happens-before any provider-goroutine read.
	Subscribe(sink TurnSink)

	// CacheTTL reports how long the upstream prompt cache stays warm
	// after the last successful turn. Returns 0 for providers without a
	// time-bounded prefix cache.
	CacheTTL() time.Duration

	// Cancel aborts in-flight work for this conversation and releases live
	// subprocess state (e.g. a CLI parked inside MCP awaiting a result),
	// while PRESERVING any resume token / prompt-cache anchor so the next
	// user message picks up cache-warm. A cancel is an interrupt, not an
	// invalidation: it never discards the resumable session. (Providers that
	// genuinely need to drop a poisoned session do so internally, where the
	// corruption is detected — not via this hook.) Safe to call even when
	// nothing is in-flight; no-op for providers without per-conversation state.
	Cancel()

	// Close releases all resources owned by this conversation handle.
	// Called when the conversation is permanently deleted; the handle is
	// not used again after Close. Safe to call multiple times.
	Close() error
}

// ModelCapabilities is the immutable model-limit snapshot used when a provider
// is initialized. Callers should populate it from trusted model metadata rather
// than from request content.
type ModelCapabilities struct {
	ContextWindowTokens    int64
	MaxOutputTokens        int64
	ProviderOverheadTokens int64
}

// ContextAdmissionPolicy identifies who decides whether request content fits a
// model's context window. The zero value is provider-authoritative: local
// estimates may guide planning but do not reject a visible request. Providers
// known to silently truncate may explicitly request a conservative guard; the
// worker-side advisory behavior for that policy is implemented separately.
type ContextAdmissionPolicy string

const (
	ContextAdmissionProviderAuthoritative ContextAdmissionPolicy = ""
	ContextAdmissionSilentTruncationGuard ContextAdmissionPolicy = "silent-truncation-guard"
)

// BudgetContract defines how shared admission reserves room for a response.
// A positive OutputReserveTokens overrides MaxOutputTokens. A known context with
// neither uses a conservative derived reserve. Unknown context fails closed
// unless AllowUnknownLimits is explicitly set.
type BudgetContract struct {
	OutputReserveTokens int64
	AllowUnknownLimits  bool
	ContextAdmission    ContextAdmissionPolicy
}

// Config contains provider configuration
type Config struct {
	APIKey      string
	BearerToken string
	Headers     map[string]string
	Model       string

	ModelCapabilities ModelCapabilities
	BudgetContract    BudgetContract
}

// AuthType describes how a provider becomes available.
type AuthType string

const (
	AuthTypeAPIKey      AuthType = "api_key"
	AuthTypeToggle      AuthType = "toggle"
	AuthTypeOAuthBearer AuthType = "oauth_bearer"
)

// ProviderInfo contains metadata about a provider
type ProviderInfo struct {
	Name        string
	DisplayName string
	Description string // Human-readable blurb shown in the settings UI. May be empty.
	AuthType    AuthType
	AuthSource  string // Optional source name for non-key auth (e.g., a CLI-owned login).
	// SignInMethod names an interactive, in-app sign-in the provider supports
	// (currently "github_device" — GitHub OAuth device flow). Empty means the
	// provider has no in-app sign-in (an OAuth provider then relies on an
	// external login, like Codex reading the Codex CLI's token file). The
	// settings UI shows Sign in / Sign out controls only when this is set.
	SignInMethod  string
	ConfigKeyName string // e.g., "anthropic_api_key" - key name in config file
	EnvVarName    string // e.g., "ANTHROPIC_API_KEY" - environment variable to check as fallback
	APIKeyURL     string // URL where users can create/manage API keys for this provider
	// APIKeyOptional marks an AuthTypeAPIKey provider whose key is optional: it
	// stays available with no key configured, provided AutoDetect reports it is
	// otherwise configured (e.g. an OpenAI-compatible gateway with a public,
	// no-auth model list, available once its base URL is set). When true and the
	// key is empty, the provider is built keyless (no Authorization header).
	APIKeyOptional bool
	// AutoDetect optionally checks if the provider is available (e.g., CLI in PATH).
	// For keyless providers, returns true if usable. Nil means no auto-detection.
	AutoDetect func() bool
	// ReadinessCheck, when non-nil, is a cheap, strictly NON-INTERACTIVE liveness
	// probe run on each provider refresh after credential resolution. It reports
	// whether the provider can serve a turn right now and, when it can't, a
	// user-facing hint (e.g. a CLI whose OAuth login is missing). A not-ready
	// result marks the provider unavailable and surfaces the hint. The probe must
	// never itself trigger auth or spawn an interactive login — that is the whole
	// point of gating here. A provider that sets this must compute its model list
	// locally (no network, no subprocess), because the refresh still lists its
	// models when not-ready so the menu can show them disabled alongside the hint.
	ReadinessCheck func() (ready bool, hint string)
	// ModelContextWindows is the static context-window map for built-in models.
	// May be nil for providers whose models come from a runtime source (e.g. a
	// CLI subprocess or local daemon). Consumers should treat empty/nil as
	// "models discovered elsewhere", not as "no models".
	ModelContextWindows map[string]int
	// ResolveModelCapabilities optionally supplies static admission capabilities
	// that cannot be represented by ModelContextWindows alone. The bool is false
	// for unknown model ids so custom aliases continue to fail closed.
	ResolveModelCapabilities func(model string) (ModelCapabilities, bool)
	// AllowUnknownLimits opts the provider out of fail-closed admission when a
	// model's context window is unknown. Set only for providers that cannot
	// expose limits and already enforce a safe boundary themselves (e.g.
	// external agent protocols); their requests dispatch with no admission
	// check rather than dying with UnknownContextLimitError.
	AllowUnknownLimits bool
	// ContextAdmission selects request-content admission behavior. Its zero value
	// is provider-authoritative; only providers known to silently truncate should
	// select ContextAdmissionSilentTruncationGuard.
	ContextAdmission ContextAdmissionPolicy
	// CheapModel names this provider's preferred low-cost / fast model id, used
	// for out-of-band micro-tasks (e.g. auto-naming a tab) when the user has not
	// pinned an explicit cheap model. Empty ⇒ this provider offers no cheap tier
	// and never auto-derives (callers then fall through to the next resolution
	// step, or no-op). Presentation/selection only — never sent on the wire as-is
	// without validation against the live model list.
	CheapModel string
	// ForcedToolChoiceUnsupported marks a provider that cannot reliably honor a
	// forced single-tool choice — local daemons and OpenAI-compatible gateways
	// whose models either reject the tools array, answer a forced tool call as
	// literal JSON text, or return nothing. The zero value (false) means forced
	// tool choice is reliable, so natively-registered providers keep it. Bounded
	// compaction reads this to pick its final-summary call: reliable providers
	// force the return_result tool for clean structured output; the rest use a
	// tool-free plain-text final that every model answers cleanly.
	ForcedToolChoiceUnsupported bool
	// StreamsLiveUsage marks a provider that reports authoritative per-step input
	// usage mid-turn that maps onto our context meter — i.e. its transient `usage`
	// stream chunks carry a real, monotonic prompt-token total the footer bar can
	// grow against as the turn proceeds. The zero value (false) keeps the footer's
	// end-of-turn blob anchor: a provider whose live numbers are absent, cumulative
	// across calls, or otherwise unfit for the meter (e.g. the claudecode CLI) must
	// leave this unset so its bar stays pinned to the last completed turn.
	StreamsLiveUsage bool
}

// EffectiveAuthType preserves the legacy convention where an empty
// ConfigKeyName means "keyless toggle" unless a provider opted into a
// specific non-key auth type.
func (p ProviderInfo) EffectiveAuthType() AuthType {
	if p.AuthType != "" {
		return p.AuthType
	}
	if p.ConfigKeyName == "" {
		return AuthTypeToggle
	}
	return AuthTypeAPIKey
}
