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
	Type string `json:"type"` // "user", "assistant", "thinking", "provider-state", "tool-use", "tool-result", "context-item", "context-item-updated", "guidance", "system-reminder", "error", "system"

	// Content field - used by user, assistant, context-item, context-item-updated, system-reminder, tool-result
	Content string `json:"content,omitempty"`

	// Provider-specific fields
	ProviderData map[string]any `json:"providerData,omitempty"` // Opaque continuation data (e.g., thinking signatures or hidden provider state)

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
	Message string `json:"message,omitempty"` // Error message (also used by system messages)
	Stack   string `json:"stack,omitempty"`   // Error stack trace

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

	// BypassContextGuard explicitly permits this request to dispatch when its
	// estimate is over the admission ceiling. The worker sets it only for one
	// visible fallback attempt after structured compaction cannot progress, and
	// for hidden compaction requests whose own bounded pack/split controller
	// already handles context pressure.
	BypassContextGuard bool

	// SyntheticTranscript marks a request whose messages are not a thread's
	// transcript: the hidden compaction calls, which swap the system prompt, drop
	// the tools and send a transcript of their own construction, and one-shot
	// out-of-band completions. It is orthogonal to BypassContextGuard — a real
	// turn dispatched over the ceiling bypasses the guard and is still the
	// thread's transcript — and admission uses it to decide whether a round-trip's
	// billed input count may be recorded as that thread's measured prefix.
	SyntheticTranscript bool

	// ContextCeilingFraction is the fraction of the context window this request
	// may occupy before admission raises a ContextCompactionAdvisory. 0 selects
	// DefaultContextCeilingFraction, the soft ceiling that makes compaction fire
	// while a turn is still running rather than after the provider rejects it.
	// 1.0 asks for the hard window instead: the caller wants every request that
	// genuinely fits to dispatch, and accepts reaching the wall (set when the
	// user has disabled automatic compaction).
	ContextCeilingFraction float64

	// ExplicitContinuation marks a provider request initiated by the human's
	// Continue action without adding a user-authored transcript message. Stateful
	// providers may use it to distinguish that intent from internal empty-delta
	// triggers such as regeneration. It is ephemeral and never part of history.
	ExplicitContinuation bool

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

	// ServiceTier selects the serving speed/priority class for this turn, named
	// by the id the model advertised in ModelInfo.ServiceTiers (e.g. "priority"
	// for OpenAI Codex's "Fast"), or "" for the provider's standard serving —
	// no tier parameter is sent, byte-identical to pre-feature behaviour. It is
	// orthogonal to ThinkingLevel: one buys latency, the other reasoning depth,
	// and a model may advertise either, both, or neither. Providers ignore any
	// value the model did not advertise. Per-turn (not on Config) for the same
	// reason as ThinkingLevel — flicking it must not churn the cache handle.
	//
	// A tier is a REQUEST, not a guarantee: a backend may serve the standard
	// tier anyway without erroring, so a provider that can observe the tier it
	// was actually served should report the discrepancy rather than assume the
	// request was honoured.
	ServiceTier string
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
	ContentBlockTypeActivity         ContentBlockType = "activity"       // Transient replaceable provider activity snapshot; never conversation history
	ContentBlockTypeProviderState    ContentBlockType = "provider_state" // Durable hidden provider continuation state, ordered with response blocks
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

// StopReason names why a turn ended, in one vocabulary that every provider
// normalises onto at its own boundary. Upstreams spell this differently and
// disagree about which endings are worth distinguishing, so a provider that
// passes its own wire value straight through hands the turn loop a name it does
// not branch on — the failure being silent, since an unrecognised reason simply
// takes the default arm.
//
// The set is deliberately small: a reason earns a constant only where a
// consumer acts on it. An upstream reason with no equivalent here maps onto the
// closest one rather than being invented.
type StopReason string

const (
	StopReasonEndTurn   StopReason = "end_turn"   // Model finished of its own accord
	StopReasonToolUse   StopReason = "tool_use"   // Model asked for tools; the loop must resolve them before it can end
	StopReasonMaxTokens StopReason = "max_tokens" // Cut off at the output budget, mid-answer

	// StopReasonContentFilter is an upstream filter ending the turn. Kept
	// distinct from a clean finish because a filtered completion is often empty
	// and would otherwise be indistinguishable from one.
	StopReasonContentFilter StopReason = "content_filter"

	// StopReasonRefusal is a safety classifier declining. It arrives as an
	// ordinary HTTP 200 whose turn carries no content, so it is distinguished
	// from a blank turn only by this value and the stop_details beside it.
	StopReasonRefusal StopReason = "refusal"

	// StopReasonEmptyResponse is a turn that completed with nothing in it. A
	// finish, not a failure: the request was served and the answer was blank.
	StopReasonEmptyResponse StopReason = "empty_response"

	StopReasonCancelled StopReason = "cancelled" // Ended by the user, mid-stream
	StopReasonError     StopReason = "error"     // Ended by a failure; the error text carries the detail
)

// StructuredResponse represents a response with structured content blocks.
// Token-field semantics match StreamResult — see that type for the contract.
type StructuredResponse struct {
	Blocks                 []ContentBlock `json:"blocks"`
	StopReason             StopReason     `json:"stopReason,omitempty"`
	InputTokens            int            `json:"inputTokens,omitempty"`
	InputTokensApproximate bool           `json:"inputTokensApproximate,omitempty"`
	OutputTokens           int            `json:"outputTokens,omitempty"`
	CachedTokens           *int           `json:"cachedTokens,omitempty"`
	CacheWriteTokens       *int           `json:"cacheWriteTokens,omitempty"`
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
//     nil means the provider did not report cache
//     usage for this call — unknown, NOT a miss.
//     An explicit &0 means the provider reported
//     zero cache reuse. Consumers that only need a
//     number use TokenCount (nil ⇒ 0); anything
//     persisted or displayed must preserve the
//     nil/0 distinction by omission.
//   - CacheWriteTokens: Prompt tokens written to cache this turn
//     (subset of InputTokens). Anthropic
//     cache_creation. Same nil-means-unreported
//     contract as CachedTokens: providers without
//     an explicit cache-write phase leave it nil.
type StreamResult struct {
	StopReason             StopReason `json:"stopReason,omitempty"`
	InputTokens            int        `json:"inputTokens,omitempty"`
	InputTokensApproximate bool       `json:"inputTokensApproximate,omitempty"`
	OutputTokens           int        `json:"outputTokens,omitempty"`
	CachedTokens           *int       `json:"cachedTokens,omitempty"`
	CacheWriteTokens       *int       `json:"cacheWriteTokens,omitempty"`

	// AdmissionEstimateTokens is what admission estimated this request's input
	// at before dispatching it. Unlike every field above it is a local
	// heuristic, not a provider report — it is carried here so the estimate and
	// the provider's own InputTokens for the same request meet in one place and
	// their ratio is observable. That ratio matters because the automatic
	// compaction advisory fires on the estimate: a persistent ratio above 1
	// means compaction triggers earlier than the real prompt size warrants.
	// Zero when admission did not estimate, which is the unknown-window case
	// under BudgetContract.AllowUnknownLimits.
	AdmissionEstimateTokens int `json:"admissionEstimateTokens,omitempty"`

	// AdmissionAnchored reports that AdmissionEstimateTokens was projected from
	// the previous request's provider-reported count plus an estimate of only
	// the messages appended since, rather than estimated in full. False means
	// the whole request was estimated, which is the case on a conversation's
	// first dispatch and whenever the transcript prefix or envelope changed.
	AdmissionAnchored bool `json:"admissionAnchored,omitempty"`
}

// Reported wraps a provider-reported token count for the optional (*int)
// usage fields — including an explicit zero, which is a real report and must
// stay distinguishable from nil (not reported).
func Reported(v int) *int { return &v }

// TokenCount reads an optional token count, treating nil (not reported) as 0.
// For arithmetic and display where the unknown/zero distinction is irrelevant.
func TokenCount(p *int) int {
	if p == nil {
		return 0
	}
	return *p
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
	// Parts carries the images a tool returned alongside its text (e.g. read on
	// a PNG), with Data already resolved — see Message.Parts.
	Parts []MediaPart `json:"parts,omitempty"`
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
	// WindowAssumed is true when ContextWindow is a provider-wide fallback: the
	// server reported nothing for this model and no per-model catalogue entry
	// knew it either. It is narrower than !FromAPI, which also covers curated
	// catalogue figures for endpoints that publish bare ids. This is the one
	// case worth telling a user about, because the number is a guess.
	WindowAssumed bool
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
	// ServiceTiers lists the non-standard serving classes this model offers, in
	// display order. Standard serving is always available and is NOT a member —
	// it is the empty MessageRequest.ServiceTier. Empty/nil ⇒ the model exposes
	// no speed control and the UI hides the selector.
	ServiceTiers []ServiceTier
	// DefaultServiceTier names the tier the provider bills as this model's
	// default. Presentation only, and deliberately NOT applied on the client's
	// behalf: a tier costs materially more, so it is sent only when the human
	// picked it. Empty when the provider declares none.
	DefaultServiceTier string
}

// ServiceTier is one serving class a model offers beyond standard — a latency
// tier bought at a higher price, not a capability. ID is the identity: it is
// what MessageRequest.ServiceTier carries and what goes on the wire verbatim.
// Name and Description are the provider's own words for it and are presentation
// only, so the UI never has to invent marketing copy or guess a multiplier.
type ServiceTier struct {
	ID          string `json:"id"`                    // Wire identifier, e.g. "priority"
	Name        string `json:"name,omitempty"`        // Provider's label, e.g. "Fast"
	Description string `json:"description,omitempty"` // Provider's blurb, e.g. "1.5x speed, increased usage"
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
// Concurrency invariant: Submit calls for distinct MessageRequest.ThreadID values
// may overlap, and their callbacks may therefore run concurrently. Submit calls
// for the same thread are serialized by the caller; stateful providers should
// preserve that ordering when they add their own admission. Cancel may race a
// Submit and must target only the named thread; CancelAllThreads and Close act on
// the whole handle. Implementations must synchronize per-conversation state.
// CancelAllThreads is the Cancel threadItemID that means "every thread of this
// conversation" rather than one of them. It cannot be the empty string: "" is
// the ROOT thread, a real and separately cancellable thread, and conflating the
// two is what makes one thread's Stop tear down its siblings.
const CancelAllThreads = "*"

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

	// Cancel aborts in-flight work on ONE thread of this conversation and
	// releases that thread's live subprocess state (e.g. a CLI parked inside MCP
	// awaiting a result), while PRESERVING any resume token / prompt-cache anchor
	// so the next user message picks up cache-warm. A cancel is an interrupt, not
	// an invalidation: it never discards the resumable session. (Providers that
	// genuinely need to drop a poisoned session do so internally, where the
	// corruption is detected — not via this hook.) Safe to call even when nothing
	// is in-flight; no-op for providers without per-conversation state.
	//
	// threadItemID names the thread, "" being the root thread and CancelAllThreads
	// every thread at once (conversation teardown). A provider that keeps no
	// per-thread state may ignore it and cancel what it has.
	Cancel(threadItemID string)

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

// BudgetContract defines how shared admission reserves room for a response.
// A positive OutputReserveTokens overrides MaxOutputTokens. A known context with
// neither uses a conservative derived reserve. Unknown context fails closed
// unless AllowUnknownLimits is explicitly set.
type BudgetContract struct {
	OutputReserveTokens int64
	AllowUnknownLimits  bool
}

// Config contains provider configuration
type Config struct {
	APIKey      string
	BearerToken string
	Headers     map[string]string
	Model       string

	// BaseURL overrides the endpoint this client talks to, taking precedence
	// over whatever the provider was registered with. It is what lets one
	// registered provider serve several user-configured endpoints: the endpoint
	// travels with the request instead of being fixed at registration. Empty
	// means "use the registered endpoint", which is every built-in vendor.
	BaseURL string

	// ProjectPath is the loaded project's root — the authoritative working
	// directory the server currently has open. Providers that spawn a CLI
	// (claudecode, acp) must root that process here so it resolves the same
	// project the window shows, not the directory the server was launched
	// from. Empty means "no project loaded"; providers then fall back to
	// their own detection (used by model-listing calls that pass a bare
	// Config and never spawn against a project).
	ProjectPath string

	// WorkspaceRoot is where THIS conversation's work happens, when it is bound
	// to a workspace that is not the project itself — a git worktree, a scratch
	// copy. A CLI-spawning provider roots its subprocess here so the model sees
	// the tree the conversation is about, while ProjectPath stays the project
	// and remains the only place Juggler writes its own per-conversation state:
	// a workspace root holds the user's files and nothing of ours, so that
	// removing one destroys nothing and leaves no untracked debris behind.
	//
	// Empty means the conversation is bound to the project, which is what every
	// conversation meant before workspaces existed.
	WorkspaceRoot string

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
	// CheapModel names this provider's preferred low-cost / fast model id, used
	// for out-of-band micro-tasks (e.g. auto-naming a tab) when the user has not
	// pinned an explicit cheap model. Empty ⇒ this provider offers no cheap tier
	// and never auto-derives (callers then fall through to the next resolution
	// step, or no-op). Presentation/selection only — never sent on the wire as-is
	// without validation against the live model list.
	CheapModel string
	// DefaultModels names, in order of preference, the model ids a new
	// conversation starts on when the user has no explicit default and this is
	// the preferred provider. The first one the provider's live catalog lists
	// and the user has not hidden wins; with none of them present the
	// provider's first visible model is used. Empty ⇒ always that first model.
	//
	// This exists because a catalog's own order puts its flagship first, and
	// the automatic default is spent without the user ever choosing it.
	DefaultModels []string
	// FreeToRun marks a provider that bills nothing per token — a local runtime
	// serving models off the user's own hardware. It is the property the cheap
	// model's last resolution step depends on: with nothing billed, re-running
	// the conversation's own model for a micro-task costs only time, so such a
	// provider needs no cheap tier of its own and never has to be nudged about
	// one. Deliberately not "is local", which is a deployment detail: a local
	// gateway proxying a paid API is local and not free, and it is the price
	// that decides whether re-running the main model is acceptable.
	//
	// A hosted provider must never set this, free tier or not — a free tier is a
	// quota to be spent carefully, which is the opposite of the reasoning here.
	FreeToRun bool
	// ForcedToolChoiceUnsupported marks a provider that cannot reliably honor a
	// forced single-tool choice — local daemons and OpenAI-compatible gateways
	// whose models either reject the tools array, answer a forced tool call as
	// literal JSON text, or return nothing. The zero value (false) means forced
	// tool choice is reliable, so natively-registered providers keep it. The
	// worker reads this before emitting a tool_choice (resolveForcedToolChoice):
	// such a provider runs the turn unforced instead of spending it on a call it
	// cannot make.
	ForcedToolChoiceUnsupported bool
	// StreamsLiveUsage marks a provider that reports authoritative per-step input
	// usage mid-turn that maps onto our context meter — i.e. its transient `usage`
	// stream chunks carry a real, monotonic prompt-token total the footer bar can
	// grow against as the turn proceeds. The zero value (false) keeps the footer's
	// end-of-turn blob anchor: a provider whose live numbers are absent, cumulative
	// across calls, or otherwise unfit for the meter (e.g. the claudecode CLI) must
	// leave this unset so its bar stays pinned to the last completed turn.
	StreamsLiveUsage bool
	// SpawnsLocalProcess marks a provider Juggler runs as a subprocess of its
	// own, in the conversation's working directory — the CLI agents, not the
	// HTTP APIs. It is the property a workspace has to be able to host: a
	// conversation working somewhere this machine only reaches over a wire would
	// run such a provider *here*, in a directory that is not the one every file
	// operation of that turn uses. That is silently the wrong thing, and the user
	// discovers it through results that make no sense — so the workspace kind
	// declares whether it can host one (ops.WorkspaceKind.HostsLocalProviders)
	// and the model picker refuses the pairing rather than offering it.
	//
	// Deliberately about spawning rather than about locality in general: an HTTP
	// provider running on this machine is fine anywhere, because the turn reaches
	// it the same way from any workspace.
	SpawnsLocalProcess bool
	// Successor, when set, asks whether the server this provider is pointed at
	// would be better served by another provider, and returns nil when it would
	// not. It exists for a keyless local provider aimed at a server it can talk to
	// but not understand — LocalAI pointed at LM Studio lists LM Studio's models
	// through the OpenAI-compatible API, yet can read none of their windows. It
	// may make a network request, so it is asked only of a provider that is
	// switched on.
	Successor func(ctx context.Context) *Successor
}

// Successor names a provider better suited than the asking one to the server
// that one is pointed at, with what switching to it has to carry over.
type Successor struct {
	// Provider is the registered name of the provider to switch to.
	Provider string
	// Reason says, in one or two sentences a user can act on, what the server is
	// and what staying on the asking provider costs.
	Reason string
	// Adopt points Provider at the server the asking provider is configured
	// for, so the switch keeps talking to the same server. Nil when there is
	// nothing to carry.
	Adopt func() error
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
