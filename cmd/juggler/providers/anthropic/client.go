//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package anthropic

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/utils"
	"juggler/internal/httpx"
	"juggler/internal/jlog"

	anthropicsdk "github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// defaultMaxOutputTokens is Anthropic's standard per-request output limit.
const defaultMaxOutputTokens = 8192

// errNoMessageStop is the failure of a stream whose body ended before its
// message_stop event.
var errNoMessageStop = errors.New("anthropic stream ended before message_stop")

// toolUseAccumulator tracks a tool_use block being assembled from streaming chunks
type toolUseAccumulator struct {
	id          string
	name        string
	argsBuilder strings.Builder
}

// thinkingAccumulator tracks a thinking block being assembled from streaming chunks
type thinkingAccumulator struct {
	contentBuilder strings.Builder
	signature      string
}

// transformMessages converts unified Message[] to Anthropic SDK format and
// places the rolling cache breakpoint on the last block that accepts one. Uses
// TransformToAPIMessages() for message grouping and alternation, then converts
// to SDK-specific types.
//
// The breakpoint goes at the tail because every message in the request belongs
// in the cache: standing context items render at the position their item stands
// in the conversation (worker.buildMessages), so the whole request is one
// growing prefix. An unchanged context render is byte-identical turn to turn and
// caches; a genuine change to it busts from its position, which is the intended
// cost of pinning something live.
func transformMessages(messages []provider.Message) []anthropicsdk.BetaMessageParam {
	// Use shared message transformation (defined in messages.go)
	apiMessages := TransformToAPIMessages(messages)
	if len(apiMessages) == 0 {
		return nil
	}

	result := make([]anthropicsdk.BetaMessageParam, 0, len(apiMessages))

	for _, msg := range apiMessages {
		var role anthropicsdk.BetaMessageParamRole
		if msg.Role == "user" {
			role = anthropicsdk.BetaMessageParamRoleUser
		} else {
			role = anthropicsdk.BetaMessageParamRoleAssistant
		}

		var blocks []anthropicsdk.BetaContentBlockParamUnion
		for _, block := range msg.Content {
			sdkBlock := convertBlockToSDK(block)
			if sdkBlock == nil {
				continue
			}
			blocks = append(blocks, *sdkBlock)
		}

		if len(blocks) > 0 {
			result = append(result, anthropicsdk.BetaMessageParam{
				Role:    role,
				Content: blocks,
			})
		}
	}

	setRollingCacheBreakpoint(result)
	return result
}

// convertBlockToSDK converts an APIContentBlock to an SDK content block.
func convertBlockToSDK(block APIContentBlock) *anthropicsdk.BetaContentBlockParamUnion {
	switch block.Type {
	case "text":
		b := anthropicsdk.NewBetaTextBlock(block.Text)
		return &b

	case "thinking":
		thinkingBlock := anthropicsdk.BetaThinkingBlockParam{
			Type:      "thinking",
			Thinking:  block.Thinking,
			Signature: block.Signature,
		}
		return &anthropicsdk.BetaContentBlockParamUnion{
			OfThinking: &thinkingBlock,
		}

	case "tool_use":
		// NewToolUseBlock's signature is (id, input, name) — input second, name
		// third. The input is the parsed object, not a JSON string: the SDK field
		// is `omitzero`+required, so a nil map is dropped and the API rejects with
		// "tool_use.input: Field required"; substitute an empty (non-nil) map so a
		// no-arg call still marshals as `input:{}`.
		input := any(block.Input)
		if block.Input == nil {
			input = map[string]any{}
		}
		b := anthropicsdk.NewBetaToolUseBlock(block.ID, input, block.Name)
		return &b

	case "tool_result":
		b := anthropicsdk.NewBetaToolResultBlock(block.ToolUseID, block.Content, block.IsError)
		if len(block.ContentBlocks) > 0 {
			// Rich content (text + the tool's images) replaces the text-only
			// content the constructor filled in.
			var content []anthropicsdk.BetaToolResultBlockParamContentUnion
			for _, inner := range block.ContentBlocks {
				switch {
				case inner.Type == "text":
					content = append(content, anthropicsdk.BetaToolResultBlockParamContentUnion{
						OfText: &anthropicsdk.BetaTextBlockParam{Text: inner.Text},
					})
				case inner.Type == "image" && inner.Source != nil:
					content = append(content, anthropicsdk.BetaToolResultBlockParamContentUnion{
						OfImage: betaImageBlock(inner.Source),
					})
				}
			}
			b.OfToolResult.Content = content
		}
		return &b

	case "image":
		// The shared transform only emits base64 image sources. The CLI path
		// serializes APIContentBlock to JSON directly; the SDK path needs the
		// block mapped into the SDK's image-block union.
		if block.Source == nil {
			return nil
		}
		return &anthropicsdk.BetaContentBlockParamUnion{OfImage: betaImageBlock(block.Source)}

	default:
		return nil
	}
}

// betaImageBlock maps a base64 image source into the SDK's image block. Built
// out rather than taken from a constructor because the beta surface ships no
// image-block helper — the shape is the non-beta one with the Beta types.
func betaImageBlock(src *APIImageSource) *anthropicsdk.BetaImageBlockParam {
	return &anthropicsdk.BetaImageBlockParam{
		Source: anthropicsdk.BetaImageBlockParamSourceUnion{
			OfBase64: &anthropicsdk.BetaBase64ImageSourceParam{
				Data:      src.Data,
				MediaType: anthropicsdk.BetaBase64ImageSourceMediaType(src.MediaType),
			},
		},
	}
}

// Register adds this provider to the global registry. Called explicitly from
// main; no init()-time side effects.
func Register() {
	provider.RegisterProvider(Info(), NewClient)
}

// Client implements provider.Provider for Anthropic Claude
type Client struct {
	client          *anthropicsdk.Client
	model           string
	maxOutputTokens int64
}

// NewClient creates a new Anthropic provider
func NewClient(cfg provider.Config) (provider.Provider, error) {
	if cfg.APIKey == "" {
		return nil, fmt.Errorf("API key is required")
	}
	if cfg.Model == "" {
		return nil, fmt.Errorf("model is required")
	}

	// httpx.Client(0) carries the proxy policy with no client-level timeout —
	// streaming responses need long-lived connections.
	client := newSDKClient(cfg.APIKey, httpx.Client(0))

	return &Client{
		client:          &client,
		model:           cfg.Model,
		maxOutputTokens: cfg.ModelCapabilities.MaxOutputTokens,
	}, nil
}

// newSDKClient configures the Anthropic SDK client every Client uses. The SDK's
// own retries are off: the worker's turn loop owns every retry (its
// retryRuleFor), so that one policy decides, one budget bounds the time, and
// the user sees each wait as a "retrying" status instead of a silent stall.
func newSDKClient(apiKey string, httpClient *http.Client) anthropicsdk.Client {
	return anthropicsdk.NewClient(
		option.WithAPIKey(apiKey),
		option.WithHTTPClient(httpClient),
		option.WithMaxRetries(0),
	)
}

// apiFailure maps the SDK's error onto the provider vocabulary the worker
// classifies: a 429 becomes a RateLimitedError carrying the wait the response
// stated, and any other API error an APIError with its status, its error type
// and the server's own retry verdict. err is returned unchanged when it is not
// an API error (a transport failure), for the classifier to read from its own
// types.
func apiFailure(err error) error {
	var sdkErr *anthropicsdk.Error
	if !errors.As(err, &sdkErr) {
		return err
	}
	var header http.Header
	if sdkErr.Response != nil {
		header = sdkErr.Response.Header
	}
	body := sdkErr.RawJSON()
	wait := utils.ParseRateLimitHint(header, body)
	status := sdkErr.StatusCode
	// An error event inside a stream carries the status of the stream itself,
	// which had answered 200; its type is the whole of what it says.
	if status < 400 {
		status = 0
	}
	if status == http.StatusTooManyRequests {
		return &provider.RateLimitedError{RetryAfter: wait, Message: err.Error(), Cause: err}
	}
	failure := &provider.APIError{
		Provider:   "anthropic",
		Status:     status,
		Type:       string(sdkErr.Type()),
		RetryAfter: wait,
		Message:    err.Error(),
		Cause:      err,
	}
	switch header.Get("x-should-retry") {
	case "true":
		failure.ShouldRetry = new(bool)
		*failure.ShouldRetry = true
	case "false":
		failure.ShouldRetry = new(bool)
	}
	return failure
}

// Name returns the provider name
func (c *Client) Name() string {
	return "anthropic"
}

// convertToolChoice maps the provider-agnostic ToolChoice onto the Anthropic
// SDK union. Returns ok=false for nil/auto (the default — the model decides),
// so the caller leaves params.ToolChoice unset.
func convertToolChoice(tc *provider.ToolChoice) (anthropicsdk.BetaToolChoiceUnionParam, bool) {
	if tc == nil {
		return anthropicsdk.BetaToolChoiceUnionParam{}, false
	}
	switch tc.Mode {
	case provider.ToolChoiceTool:
		if tc.Name == "" {
			return anthropicsdk.BetaToolChoiceUnionParam{}, false
		}
		return anthropicsdk.BetaToolChoiceParamOfTool(tc.Name), true
	case provider.ToolChoiceAny:
		return anthropicsdk.BetaToolChoiceUnionParam{OfAny: &anthropicsdk.BetaToolChoiceAnyParam{}}, true
	case provider.ToolChoiceNone:
		return anthropicsdk.BetaToolChoiceUnionParam{OfNone: &anthropicsdk.BetaToolChoiceNoneParam{}}, true
	default: // auto / unknown
		return anthropicsdk.BetaToolChoiceUnionParam{}, false
	}
}

// convertTools converts provider.ToolDefinition to Anthropic SDK format
func convertTools(tools []provider.ToolDefinition) []anthropicsdk.BetaToolUnionParam {
	if len(tools) == 0 {
		return nil
	}

	result := make([]anthropicsdk.BetaToolUnionParam, 0, len(tools))
	for _, tool := range tools {
		// Extract properties and required from the input schema
		var schemaMap map[string]any
		if err := json.Unmarshal(tool.InputSchema, &schemaMap); err != nil {
			// ⚠️ CRITICAL: Tool schema unmarshal failed
			jlog.Error("WARNING: Failed to unmarshal input schema for tool '%s': %v", tool.Name, err)
			jlog.Error("Raw InputSchema bytes (%d bytes): %s", len(tool.InputSchema), string(tool.InputSchema))
			jlog.Error("Skipping tool '%s'", tool.Name)
			continue // Skip invalid schemas
		}

		// Extract the properties object (the actual parameter definitions)
		properties := schemaMap["properties"]
		if properties == nil {
			properties = map[string]any{} // Empty properties if not specified
		}

		// Extract required fields
		var required []string
		if req, ok := schemaMap["required"].([]any); ok {
			required = make([]string, 0, len(req))
			for _, r := range req {
				if rStr, ok := r.(string); ok {
					required = append(required, rStr)
				}
			}
		}

		// Create ToolInputSchemaParam with extracted fields
		schema := anthropicsdk.BetaToolInputSchemaParam{
			Type:       "object",
			Properties: properties,
			Required:   required,
		}

		// Create the tool union param with full ToolParam including description
		result = append(result, anthropicsdk.BetaToolUnionParam{
			OfTool: &anthropicsdk.BetaToolParam{
				Name:        tool.Name,
				Description: anthropicsdk.String(tool.Description),
				InputSchema: schema,
			},
		})
	}
	return result
}

// buildMessageParams assembles the Anthropic SDK request from a provider
// request, including the prompt-cache breakpoints. Pure (no network, no ctx)
// so the cache-breakpoint scheme is unit-testable.
//
// Prompt cache layout (Anthropic matches the longest previously-written prefix,
// in tools → system → messages order):
//
//		[ tools ][ system ] | cache_control | [ history, context items in place ] | cache_control
//
//	  - The system breakpoint caches tools+system. This prefix is stable across a
//	    strategy change and across turns (it varies only on a plugin
//	    enable/disable), so the breakpoint actually hits instead of cold-starting
//	    every phase change. Standing context items are NOT in the system prompt,
//	    so a todo update or a file edit cannot bust it. What IS in the system
//	    prompt must therefore never move mid-conversation: memory and skills both
//	    freeze their block at seed time for exactly this reason.
//	  - The message breakpoint sits on the final block, so each turn writes an
//	    incrementally longer prefix and the next turn reads the prior one: a
//	    rolling cache over the growing conversation, with no offset bookkeeping on
//	    our side. Blocks that cannot carry cache_control (thinking,
//	    redacted_thinking) are stepped over, so the breakpoint lands on the last
//	    block that accepts one — see setRollingCacheBreakpoint.
//	  - Standing context items ride at the position their item occupies in the
//	    conversation (worker.buildMessages), so adding one appends rather than
//	    shifting what is already cached. An unchanged render is byte-identical
//	    each turn and rides the cache; a real change busts from that point, which
//	    is the intended cost of a live pin.
//
// Two breakpoints, well within Anthropic's limit of four. Below the model's
// minimum cacheable size the breakpoints are silently ignored by the API, so
// always emitting them is safe.
func (c *Client) buildMessageParams(req provider.MessageRequest) anthropicsdk.BetaMessageNewParams {
	// transformMessages also places the rolling cache breakpoint (before any
	// volatile standing-context tail — see its doc comment).
	messages := transformMessages(req.Messages)
	messages = closeTrailingPrefill(c.model, messages)

	// The capability snapshot (c.maxOutputTokens) may carry a *derived* reserve
	// when the model resolved from window only — e.g. a static-map id the live
	// list no longer returns (claude-3-opus, real cap 4096) can arrive here with
	// a 40k reserve. Sending that as max_tokens is a hard 400. The static catalog
	// is authoritative for the wire ceiling of any model it recognises, so clamp
	// down to it (min) for known models. Unknown/live-list-only ids keep the
	// snapshot value. Admission charged reserve = snapshot value, so a wire value
	// at or below it keeps admission conservative (it over-reserves) — acceptable.
	maxTokens := c.maxOutputTokens
	// A one-off raise lifts the client value before the catalog clamp, so a
	// model's known ceiling still bounds it.
	if req.RaiseMaxOutputTokens > maxTokens {
		maxTokens = req.RaiseMaxOutputTokens
	}
	if catalogMax, known := CatalogMaxOutputTokens(c.model); known {
		if maxTokens <= 0 || int64(catalogMax) < maxTokens {
			maxTokens = int64(catalogMax)
		}
	} else if maxTokens <= 0 {
		maxTokens = int64(GetMaxOutputTokens(c.model))
	}
	// A per-request wire output cap (F1: hidden compaction map calls) may only
	// lower the effective max_tokens — apply it as a min() after the catalog
	// clamp above. The thinking budget clamps against this value automatically
	// (thinkingBudgetForLevel takes maxTokens as a parameter).
	if req.MaxOutputTokens > 0 && req.MaxOutputTokens < maxTokens {
		maxTokens = req.MaxOutputTokens
	}
	params := anthropicsdk.BetaMessageNewParams{
		Model:     anthropicsdk.Model(c.model),
		MaxTokens: maxTokens,
		Messages:  messages,
	}

	// System prompt as a single cached block (stable prefix — see the cache
	// layout note on buildMessageParams).
	if req.SystemPrompt != "" {
		sys := anthropicsdk.BetaTextBlockParam{Text: req.SystemPrompt, Type: "text"}
		sys.CacheControl = anthropicsdk.NewBetaCacheControlEphemeralParam()
		params.System = []anthropicsdk.BetaTextBlockParam{sys}
	}

	// Add tools if provided
	if len(req.Tools) > 0 {
		params.Tools = convertTools(req.Tools)
		// Honour a forced tool choice set by a plugin. Only meaningful when
		// tools are present, and only on models that accept one — the rest
		// answer a forced choice with a 400, so it is dropped here and the turn
		// runs unforced. That matches how a provider which cannot honour a
		// forced choice is already treated a layer up: the prompt still asks for
		// the call, and losing the constraint costs a turn where sending it
		// costs the request.
		choice := req.ToolChoice
		if forcesTool(choice) && !supportsForcedToolChoice(c.model) {
			choice = nil
		}
		if tc, ok := convertToolChoice(choice); ok {
			params.ToolChoice = tc
		}
	}

	// Thinking. Anthropic takes two wire forms and rejects the wrong one with a
	// hard 400, so the model's generation picks the branch (thinkingModeForModel).
	// Both forms send nothing at all for "off" and for levels this provider does
	// not recognise. Temperature is never set here, which both forms require.
	if SupportsThinking(c.model) && thinkingModeForModel(c.model) == thinkingAdaptive {
		// Adaptive thinking, steered by output_config.effort rather than a token
		// budget. The model bounds its own thinking against max_tokens, so the
		// budget clamp has no equivalent here, and this form is compatible with a
		// forced tool_choice.
		//
		// block_binding rides whatever config goes out. Every signed thinking
		// block from every earlier turn is replayed on each request, and each is
		// bound to the exact prefix it was created under — the system prompt, the
		// tools array, and every message before it. Juggler moves that prefix on
		// entirely ordinary paths: a pinned file re-rendered live, a tool arriving
		// mid-conversation, a compaction fold, a deleted item. The default for a
		// block whose prefix moved is a 400 that fails the whole request;
		// drop_block discards just that block and lets the turn run. Reasoning
		// continuity is worth less than the turn, and a dropped block is not
		// billed either way.
		adaptive := &anthropicsdk.BetaThinkingConfigAdaptiveParam{
			BlockBinding: anthropicsdk.BetaThinkingBlockBindingParam{
				PrefixMismatchBehavior: anthropicsdk.BetaThinkingPrefixMismatchBehaviorDropBlock,
			},
		}

		// display is set explicitly because it defaults to "omitted" on newer
		// models, which returns thinking blocks stripped of their text — Juggler
		// shows that text.
		effort, levelAsksForThinking := anthropicThinkingEfforts[req.ThinkingLevel]
		switch {
		case levelAsksForThinking:
			// A level was chosen, so the reasoning was asked for. "summarized"
			// carries the progress updates between tool calls as well.
			adaptive.Display = anthropicsdk.BetaThinkingConfigAdaptiveDisplaySummarized
			params.OutputConfig = anthropicsdk.BetaOutputConfigParam{Effort: effort}

		case thinkingAlwaysOn(c.model):
			// "off" on a model that thinks regardless. The default here is
			// "omitted", which returns every thinking block emptied — so an
			// agentic turn that runs for minutes between tool calls shows
			// nothing at all and reads as a hang. "updates" returns only the
			// short progress lines the model writes between tool calls and
			// still withholds the reasoning, which is the distinction "off"
			// was asking for: not "say nothing", but "spare me the working
			// out".
			adaptive.Display = anthropicsdk.BetaThinkingConfigAdaptiveDisplayUpdates
			params.Betas = append(params.Betas, anthropicsdk.AnthropicBetaThinkingDisplayUpdates2026_08_18)
		}

		// A model that can be quiet is left alone at "off": omitting the config
		// is how that is said, and sending one would talk it into thinking it
		// would otherwise have skipped. A model that always thinks has no such
		// reading — it thinks either way — so the config still goes out at "off"
		// to carry block_binding, which is the whole point of sending it.
		if levelAsksForThinking || thinkingAlwaysOn(c.model) {
			params.Thinking = anthropicsdk.BetaThinkingConfigParamUnion{OfAdaptive: adaptive}
			params.Betas = append(params.Betas, anthropicsdk.AnthropicBetaThinkingBindingControls2026_08_01)
		}
	} else if budget, ok := thinkingBudgetForLevel(c.model, req.ThinkingLevel, maxTokens); ok && !forcesTool(req.ToolChoice) {
		// Manual thinking. Anthropic forbids a forced tool_choice (type "tool" or
		// "any") together with this form — a hard 400 — so a forced-tool turn
		// wins and drops thinking for that turn.
		params.Thinking = anthropicsdk.BetaThinkingConfigParamOfEnabled(budget)
	}

	return params
}

// continuationPrompt is the user turn sent in place of an assistant prefill, on
// models that reject one. It is wire-only — nothing writes it into the
// conversation document, so it is never shown and never stored.
const continuationPrompt = "Continue."

// closeTrailingPrefill appends a user turn when the request would otherwise end
// on an assistant message and the model rejects a prefill.
//
// A request ending on an assistant message asks the model to continue writing
// that message. Two ordinary paths produce that shape: an explicit Continue,
// whose marker carries a run record and emits no wire message of its own, and an
// autonomous turn, which can come to rest on a thinking-tailed assistant message
// with no user message after it. On a model that takes prefills both are free;
// on one that does not, both are a 400, so the continuation is stated instead of
// implied.
//
// Appending after transformMessages leaves the rolling cache breakpoint on the
// assistant tail, so this turn sits outside the cached prefix. That costs a
// couple of tokens and keeps the breakpoint on the growing prefix where it
// belongs.
func closeTrailingPrefill(model string, messages []anthropicsdk.BetaMessageParam) []anthropicsdk.BetaMessageParam {
	if len(messages) == 0 || supportsAssistantPrefill(model) {
		return messages
	}
	if messages[len(messages)-1].Role != anthropicsdk.BetaMessageParamRoleAssistant {
		return messages
	}
	return append(messages, anthropicsdk.BetaMessageParam{
		Role:    anthropicsdk.BetaMessageParamRoleUser,
		Content: []anthropicsdk.BetaContentBlockParamUnion{anthropicsdk.NewBetaTextBlock(continuationPrompt)},
	})
}

// refusalNotice composes the durable transcript notice for a turn the model
// declined, returning ok=false for every other stop reason.
//
// The failure this prevents is a misreport rather than a crash: a refusal
// carrying no text produces no assistant text and no tool call, which is exactly
// the shape of a barren turn, so without this the strategy loop retries the same
// request three times and then files a deliberate decision under "no further
// response". Naming the policy area is also the only way the user can tell a
// refusal from an outage.
func refusalNotice(stopReason provider.StopReason, details anthropicsdk.BetaRefusalStopDetails) (provider.StreamChunk, bool) {
	if stopReason != provider.StopReasonRefusal {
		return provider.StreamChunk{}, false
	}

	lead := "The model declined this request."
	var content strings.Builder
	content.WriteString(lead)
	content.WriteString("\n\n")
	// The category and the explanation go in verbatim under the plain-English
	// lead. The explanation is the provider's own words and is documented as
	// unstable, so it is shown as given and never parsed.
	if category := string(details.Category); category != "" {
		fmt.Fprintf(&content, "Policy area: %s\n", category)
	}
	if details.Explanation != "" {
		content.WriteString(details.Explanation + "\n")
	}
	content.WriteString("\nA refused request is refused the same way again, so this turn stopped rather than retrying.")

	return provider.StreamChunk{
		Type: provider.ContentBlockTypeStatus,
		// Rides the spinner for the rest of the turn; the notice is what survives it.
		Content: "Request declined",
		Metadata: map[string]any{
			"noticeSummary": lead,
			"noticeContent": content.String(),
			"noticeSource":  "anthropic",
		},
	}, true
}

// forcesTool reports whether a ToolChoice compels the model to call a tool
// (mode "tool" or "any"). These are the two modes that conflict with manual
// thinking, and the two that supportsForcedToolChoice can withhold entirely;
// "auto"/"none"/nil do neither. The manual-thinking conflict is about the wire
// form and applies to no adaptive model, so both tests are applied separately.
func forcesTool(tc *provider.ToolChoice) bool {
	return tc != nil && (tc.Mode == provider.ToolChoiceTool || tc.Mode == provider.ToolChoiceAny)
}

// anthropicThinkingLevels are the levels an Anthropic thinking model advertises,
// in display order. "off" sends no thinking param; the rest map to the wire
// value the model's thinking form takes — budget_tokens via
// anthropicThinkingBudgets, or output_config.effort via anthropicThinkingEfforts.
var anthropicThinkingLevels = []string{"off", "low", "medium", "high", "max"}

// anthropicThinkingBudgets maps a thinking level to its Anthropic budget_tokens,
// for models on the manual thinking form. A level absent here ("off", or any
// string this provider doesn't recognise) ⇒ no thinking param.
var anthropicThinkingBudgets = map[string]int64{
	"low":    2048,
	"medium": 8192,
	"high":   16384,
	"max":    32768,
}

// anthropicThinkingEfforts maps a thinking level to its output_config.effort
// value, for models on the adaptive thinking form. A level absent here ("off",
// or an unrecognised string) ⇒ neither a thinking nor an output_config param.
//
// The API also defines an "xhigh" effort sitting between "high" and "max", left
// unused here: it arrived with generation 4.7, while "max" is available on every
// model that takes the adaptive form at all (4.6 and later). Mapping any level
// to "xhigh" would 400 on Sonnet and Opus 4.6, and there is no sixth level to
// carry it without one of the five losing its meaning.
var anthropicThinkingEfforts = map[string]anthropicsdk.BetaOutputConfigEffort{
	"low":    anthropicsdk.BetaOutputConfigEffortLow,
	"medium": anthropicsdk.BetaOutputConfigEffortMedium,
	"high":   anthropicsdk.BetaOutputConfigEffortHigh,
	"max":    anthropicsdk.BetaOutputConfigEffortMax,
}

// thinkingBudgetForLevel maps a thinking level to an Anthropic budget_tokens
// value for the given model, for models on the manual thinking form. It returns
// (budget, true) when thinking should be enabled for this turn, or (0, false)
// for "off"/absent/unknown levels and models that don't support extended
// thinking at all. The budget is clamped to stay a
// safe margin (~4k answer headroom) below the effective max_tokens going on the
// wire, since Anthropic requires budget_tokens < max_tokens. The wire value is
// passed in rather than re-derived from the static catalog so a capability
// snapshot carrying a lower output limit can never push budget_tokens above
// max_tokens (a hard 400).
func thinkingBudgetForLevel(model, level string, maxTokens int64) (int64, bool) {
	if !SupportsThinking(model) {
		return 0, false
	}
	budget, ok := anthropicThinkingBudgets[level]
	if !ok { // "off", absent, or unknown ⇒ no thinking param (current behaviour)
		return 0, false
	}
	const answerHeadroom int64 = 4096
	maxBudget := maxTokens - answerHeadroom
	if maxBudget < 1024 { // Anthropic requires budget_tokens ≥ 1024
		return 0, false
	}
	if budget > maxBudget {
		budget = maxBudget
	}
	return budget, true
}

// setRollingCacheBreakpoint places the single ephemeral cache_control breakpoint
// as late in the request as a block will accept it. Anthropic matches the
// longest previously-cached prefix, so writing the breakpoint at the tail each
// turn rolls the cache forward across the conversation without us tracking
// offsets.
//
// The search runs backward — last block of the last message, then earlier blocks
// of that message, then earlier messages — because not every block type can
// carry cache_control. The SDK's ContentBlockParamUnion.GetCacheControl returns
// nil for thinking and redacted_thinking blocks, which have no such field, and
// an assistant turn can end on one (a "continue"/autonomous turn leaves a
// thinking-tailed assistant message with no user message after it). Anchoring
// only on the final block would then place no breakpoint at all and forfeit the
// entire message-body cache for that request, silently. Retreating instead costs
// just the uncached tail between the breakpoint and the end of the request —
// bounded by one message — which is why the walk crosses message boundaries too:
// a message whose every block is thinking is possible in principle, and one
// short message of lost prefix is far cheaper than the whole conversation.
//
// No-op on empty input.
func setRollingCacheBreakpoint(messages []anthropicsdk.BetaMessageParam) {
	if len(messages) == 0 {
		return
	}
	for i := len(messages) - 1; i >= 0; i-- {
		content := messages[i].Content
		for j := len(content) - 1; j >= 0; j-- {
			if cc := content[j].GetCacheControl(); cc != nil {
				*cc = anthropicsdk.NewBetaCacheControlEphemeralParam()
				return
			}
		}
	}
	// Every block in the request refused cache_control. Not reachable from any
	// history the transform produces, and it costs the whole message-body cache,
	// so say so rather than dropping the breakpoint in silence.
	jlog.Info("⚠ anthropic cache-miss: no block in %d messages accepts cache_control — request sent without a rolling breakpoint", len(messages))
}

// sendMessageStreaming sends a message request using the streaming API to preserve block generation order.
// Emits chunks to callback in real-time as content is generated; the callback
// is the only consumer of the content, so the result carries just the stop
// reason and token counts.
func (c *Client) sendMessageStreaming(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	// Check context before making API call
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}

	// Build request params (system/tools/messages + prompt-cache breakpoints).
	params := c.buildMessageParams(req)

	// Log the SDK request payload
	jlog.Trace("[anthropic REQUEST] model=%s, messages=%d", string(params.Model), len(params.Messages))

	// Provider-boundary liveness: the SDK stream blocks on a socket read with
	// no deadline of its own, so guard it with an idle watchdog that cancels
	// streamCtx if the upstream goes silent (half-open connection, server
	// stalled mid-response). Each event resets it; see utils.StreamIdleTimeout.
	// The session also carries the running output-token estimate behind the UI
	// spinner.
	sess, streamCtx := utils.NewStreamSession(ctx, "anthropic", callback)
	defer sess.Close()

	// Create streaming request - this preserves block generation order.
	// The beta surface is the same v1/messages endpoint; it is taken because
	// several request fields Juggler sends exist only on the beta params
	// (see buildMessageParams), and the response carries the matching extras.
	stream := c.client.Beta.Messages.NewStreaming(streamCtx, params)
	defer func() { _ = stream.Close() }() // release the underlying TLS conn on every return path

	// Track current block being assembled
	var currentTextBuilder strings.Builder
	var currentToolUse *toolUseAccumulator
	var currentThinking *thinkingAccumulator
	var currentBlockType string

	// Token counts and stop reason from message_delta. Per the provider
	// boundary contract (registry/provider.go StreamResult), InputTokens
	// is the TOTAL prompt (fresh + cache_read + cache_creation), and
	// cacheRead/cacheWrite are reported as their own subset fields.
	var inputTokens, outputTokens int
	var cacheReadTokens, cacheWriteTokens *int
	var stopReason provider.StopReason
	// message_stop is the only proof the message is complete; a body that ends
	// without it was cut off.
	sawMessageStop := false

	// Process streaming events in order
	for stream.Next() {
		sess.Reset()
		event := stream.Current()

		if ctx.Err() != nil {
			return nil, ctx.Err()
		}

		switch event.Type {
		case "message_start":
			// Extract input token count from initial message.
			//
			// We deliberately do NOT emit a transient `usage` chunk here.
			// The Anthropic-style usage that arrives at message_start has
			// been observed to be cumulative across all API calls in a
			// single juggler turn (the LLM-internal tool-use chain) — so
			// emitting it mid-stream would flash a wrong number in the
			// footer before end-of-turn corrects it. The footer keeps
			// showing the previous turn's correct anchor until the new
			// end-of-turn write lands, which is the least-wrong UX.
			if event.Message.Usage.InputTokens > 0 {
				inputTokens = int(event.Message.Usage.InputTokens)
			}
			// Thinking blocks the API removed before the model saw them. Read
			// here and not from message_delta: the array is final in
			// message_start, and the delta carries it only when a server-side
			// model fallback replaced it mid-stream. Reported at all only
			// because the request asks for it (thinking-binding-controls);
			// without that beta the same blocks are dropped in silence.
			// Logged rather than surfaced: dropping is the outcome we asked
			// for over a failed request, it costs nothing on the bill, and the
			// turn is unharmed — but a conversation dropping blocks every turn
			// means Juggler is moving a prefix it could hold still, and this
			// is the only place that is visible.
			for _, dropped := range event.Message.InputTransformations {
				jlog.Trace("[anthropic] thinking block dropped at %s: %s", dropped.Path, dropped.Reason)
			}

		case "content_block_start":
			// Finalize any previous block before starting new one
			c.finalizeCurrentBlock(&currentTextBuilder, &currentToolUse, &currentThinking, currentBlockType)

			// Initialize accumulator based on block type
			currentBlockType = event.ContentBlock.Type
			switch event.ContentBlock.Type {
			case "text":
				// Text block - will accumulate via text_delta
				currentTextBuilder.Reset()
			case "thinking":
				// Thinking block - will accumulate via thinking_delta
				currentThinking = &thinkingAccumulator{}
			case "tool_use", "server_tool_use":
				// Tool use block - will accumulate via input_json_delta
				currentToolUse = &toolUseAccumulator{
					id:   event.ContentBlock.ID,
					name: event.ContentBlock.Name,
				}
			default:
				// The stream carries block types this client does not assemble
				// (compaction, container upload, MCP tool use/result, fallback,
				// redacted thinking). None of them can arrive unless a request
				// asks for the feature that produces it, and none is requested
				// here — so reaching this is a signal that the request shape or
				// the API changed, not a case to handle inline. Dropping it
				// silently is what would make that change invisible.
				jlog.Trace("[anthropic] unhandled content block type %q", event.ContentBlock.Type)
			}

		case "content_block_delta":
			// Process delta based on type
			switch event.Delta.Type {
			case "text_delta":
				// Stream text immediately via callback (preserves UI responsiveness)
				text := event.Delta.Text
				currentTextBuilder.WriteString(text)
				sess.Progress(text)
				if _, err := callback(provider.StreamChunk{
					Type:    provider.ContentBlockTypeText,
					Content: text,
				}); err != nil {
					return nil, fmt.Errorf("callback error: %w", err)
				}

			case "input_json_delta":
				// Accumulate tool input JSON (streamed incrementally)
				if currentToolUse != nil {
					currentToolUse.argsBuilder.WriteString(event.Delta.PartialJSON)
					sess.Progress(event.Delta.PartialJSON)
				}

			case "thinking_delta":
				// Stream thinking content immediately
				if currentThinking != nil {
					thinking := event.Delta.Thinking
					currentThinking.contentBuilder.WriteString(thinking)
					sess.Progress(thinking)
					if _, err := callback(provider.StreamChunk{
						Type:    provider.ContentBlockTypeThinking,
						Content: thinking,
					}); err != nil {
						return nil, fmt.Errorf("callback error: %w", err)
					}
				}

			case "signature_delta":
				// Accumulate signature for thinking block
				if currentThinking != nil {
					currentThinking.signature += event.Delta.Signature
				}
			default:
				// Citations and compaction deltas both belong to features this
				// client does not request. Logged for the same reason as the
				// block-start default above.
				jlog.Trace("[anthropic] unhandled content block delta type %q", event.Delta.Type)
			}

		case "content_block_stop":
			// Finalize the current block
			block := c.finalizeCurrentBlock(&currentTextBuilder, &currentToolUse, &currentThinking, currentBlockType)
			currentBlockType = ""

			// For tool_use blocks, stream to frontend (no execution - frontend handles that)
			if block != nil && block.Type == provider.ContentBlockTypeToolUse {
				if _, err := callback(provider.StreamChunk(*block)); err != nil {
					return nil, fmt.Errorf("callback error: %w", err)
				}
			}

			// The signature arrives in its own deltas alongside the thinking
			// text and is complete only here, so it rides a contentless chunk
			// that the worker attaches to the block already on screen. Anthropic
			// rejects a signatureless thinking block passed back, so a block
			// that reaches the next turn without this is one that gets dropped
			// instead of replayed.
			if block != nil && block.Type == provider.ContentBlockTypeThinking && len(block.Metadata) > 0 {
				if _, err := callback(provider.StreamChunk{
					Type:     provider.ContentBlockTypeThinking,
					Metadata: block.Metadata,
				}); err != nil {
					return nil, fmt.Errorf("callback error: %w", err)
				}
			}

		case "message_stop":
			sawMessageStop = true

		case "message_delta":
			// Extract stop_reason and output token count
			if event.Delta.StopReason != "" {
				// provider.StopReason is modelled on this vocabulary, so
				// Anthropic's values carry across as themselves. The four with
				// no constant there — "stop_sequence", "pause_turn",
				// "compaction" and "model_context_window_exceeded" — reach the
				// turn loop as themselves and take its default arm.
				stopReason = provider.StopReason(event.Delta.StopReason)
				// A refusal arrives as a 200 with no content, so it reads as a
				// blank turn unless it is named here.
				if notice, ok := refusalNotice(stopReason, event.Delta.StopDetails); ok {
					if _, err := callback(notice); err != nil {
						return nil, fmt.Errorf("callback error: %w", err)
					}
				}
			}
			if event.Usage.OutputTokens > 0 {
				outputTokens = int(event.Usage.OutputTokens)
			}
			// Emit a transient `usage` chunk so the UI footer flips
			// to a real input-token anchor as soon as this API call
			// finishes. message_delta carries per-call authoritative
			// usage; we deliberately do NOT use message_start here
			// because some upstreams (notably the claudecode CLI)
			// report message_start.usage cumulatively across calls,
			// producing 10×–40× wrong values.
			fresh := int(event.Usage.InputTokens)
			cacheRead := int(event.Usage.CacheReadInputTokens)
			cacheWrite := int(event.Usage.CacheCreationInputTokens)
			if total := fresh + cacheRead + cacheWrite; total > 0 {
				// Promote per-call authoritative usage so the final
				// StreamResult reflects the boundary contract
				// (InputTokens = total prompt; CachedTokens / CacheWriteTokens
				// reported separately as subsets).
				inputTokens = total
				cacheReadTokens = provider.Reported(cacheRead)
				cacheWriteTokens = provider.Reported(cacheWrite)
				if _, err := callback(provider.StreamChunk{
					Type: provider.ContentBlockTypeUsage,
					Metadata: map[string]any{
						"inputTokens":  total,
						"cachedTokens": cacheRead,
					},
				}); err != nil {
					return nil, fmt.Errorf("callback error: %w", err)
				}
			}
		}
	}

	// Check for stream errors
	if err := stream.Err(); err != nil {
		// Distinguish a watchdog-induced idle stall (our streamCtx cancel, with
		// the parent ctx still alive) from a caller cancel or a real API error.
		// The session words it so the worker's transient classifier retries (it
		// matches "stream stalled" / "connection may have dropped").
		if stall := sess.StallError(); stall != nil {
			return nil, stall
		}
		return nil, apiFailure(fmt.Errorf("anthropic streaming error: %w", sess.Annotate(err)))
	}
	// The body ended cleanly, but before the event that says the message is
	// complete: whatever arrived is a fragment, and acting on it as an answer
	// would run a cut-off reply or a half-formed tool call.
	if !sawMessageStop {
		return nil, provider.NewFailureError(provider.FailureTruncated, sess.Annotate(errNoMessageStop).Error(), nil)
	}

	return &provider.StreamResult{
		StopReason:       stopReason,
		InputTokens:      inputTokens,
		OutputTokens:     outputTokens,
		CachedTokens:     cacheReadTokens,
		CacheWriteTokens: cacheWriteTokens,
	}, nil
}

// finalizeCurrentBlock finalizes the current block being accumulated.
// Returns the finalized block if one was created, nil otherwise.
func (c *Client) finalizeCurrentBlock(
	textBuilder *strings.Builder,
	toolUse **toolUseAccumulator,
	thinking **thinkingAccumulator,
	blockType string,
) *provider.ContentBlock {
	var block *provider.ContentBlock

	switch blockType {
	case "text":
		if textBuilder.Len() > 0 {
			b := provider.ContentBlock{
				Type:    provider.ContentBlockTypeText,
				Content: textBuilder.String(),
			}
			block = &b
			textBuilder.Reset()
		}

	case "thinking":
		if *thinking != nil && (*thinking).contentBuilder.Len() > 0 {
			b := provider.ContentBlock{
				Type:    provider.ContentBlockTypeThinking,
				Content: (*thinking).contentBuilder.String(),
			}
			// Only a real signature is worth carrying: an empty one is stored
			// as providerData, replayed, and then dropped again at the next
			// transform, since Anthropic rejects a signatureless thinking block.
			if (*thinking).signature != "" {
				b.Metadata = map[string]any{"signature": (*thinking).signature}
			}
			block = &b
			*thinking = nil
		}

	case "tool_use", "server_tool_use":
		if *toolUse != nil {
			// Parse accumulated JSON
			var input map[string]any
			argsStr := (*toolUse).argsBuilder.String()
			if argsStr != "" {
				if err := json.Unmarshal([]byte(argsStr), &input); err != nil {
					jlog.Error("Failed to parse tool input JSON for %s: %v", (*toolUse).name, err)
					input = map[string]any{}
				}
			} else {
				input = map[string]any{}
			}

			b := provider.ContentBlock{
				Type:      provider.ContentBlockTypeToolUse,
				ToolUseID: (*toolUse).id,
				ToolName:  (*toolUse).name,
				ToolInput: input,
			}
			block = &b
			*toolUse = nil
		}
	}

	return block
}

var _ provider.ConversationProvider = (*Client)(nil)

// OpenConversation returns a native anthropic Conversation handle.
// anthropic is stateless from the conversation's view (one HTTP request
// per turn carries its own history) so the handle just owns the model
// identity + per-turn dispatch.
func (c *Client) OpenConversation(ctx context.Context, convID string) (provider.Conversation, error) {
	// CacheTTL 5m: the ephemeral cache_control breakpoints buildMessageParams
	// writes default to Anthropic's 5-minute TTL, so the UI treats a warm anchor
	// as stale after 5 minutes of inactivity.
	return &provider.StatelessConversation{ConvID: convID, TTL: 5 * time.Minute, Dispatch: c.streamMessage}, nil
}

// streamMessage streams a message to Claude API.
// Makes a single API call and returns. Tool execution is handled by frontend.
// Uses real streaming API to preserve block generation order.
func (c *Client) streamMessage(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}

	// Stream response from API - this preserves block generation order
	// and emits chunks to callback in real-time
	return c.sendMessageStreaming(ctx, req, callback)
}

// ListModelsWithInfo returns detailed information about available models from
// the Anthropic Models API.
func (c *Client) ListModelsWithInfo(ctx context.Context) ([]provider.ModelInfo, error) {
	// Use the Anthropic Models API to list available models
	page, err := c.client.Models.List(ctx, anthropicsdk.ModelListParams{})
	if err != nil {
		return nil, fmt.Errorf("failed to list models from Anthropic: %w", err)
	}

	modelInfos := make([]provider.ModelInfo, 0, len(page.Data))
	for _, model := range page.Data {
		modelInfos = append(modelInfos, modelInfoFromAPI(model))
	}

	return modelInfos, nil
}

// modelInfoFromAPI converts one Models API entry into a provider.ModelInfo,
// preferring what the API states about a model over what the static catalog in
// models.go infers from its id.
//
// The response carries max_input_tokens, max_tokens and a per-model capabilities
// object, so the window, the output ceiling, image input and thinking support are
// all answerable without pattern-matching the id. That matters because the
// catalog can only recognise families and generations it was told about, and it
// answers for the ones it has not with a conservative default — a 200k window
// and an 8k output ceiling — which is silently wrong for any newer model rather
// than visibly absent.
//
// The catalog is the fallback for whatever a response omits, which is what an
// older API version, a proxy, or a trimmed response looks like. Each field falls
// back on its own: a response stating limits but no capabilities still has its
// limits believed.
func modelInfoFromAPI(model anthropicsdk.ModelInfo) provider.ModelInfo {
	// FromAPI tracks the window specifically, matching the convention the other
	// providers use for it — it drives whether the UI presents the context size
	// as measured or as an assumption.
	contextWindow, fromAPI := int(model.MaxInputTokens), model.MaxInputTokens > 0
	if !fromAPI {
		contextWindow = GetContextWindow(model.ID)
	}

	maxOutputTokens := int(model.MaxTokens)
	if maxOutputTokens <= 0 {
		maxOutputTokens = GetMaxOutputTokens(model.ID)
	}

	caps := model.Capabilities
	capsPresent := model.JSON.Capabilities.Valid()

	acceptsImages := SupportsImageInput(model.ID)
	if capsPresent && caps.JSON.ImageInput.Valid() {
		acceptsImages = caps.ImageInput.Supported
	}
	var inputModalities []string
	if acceptsImages {
		inputModalities = []string{"text", "image"}
	}

	supportsThinking := SupportsThinking(model.ID)
	if capsPresent && caps.JSON.Thinking.Valid() {
		supportsThinking = caps.Thinking.Supported
	}
	var thinkingLevels []string
	var defaultThinkingLevel string
	if supportsThinking {
		thinkingLevels = anthropicThinkingLevels
		defaultThinkingLevel = "off"
	}

	return provider.ModelInfo{
		ID:                   model.ID,
		DisplayName:          utils.FirstNonEmpty(model.DisplayName, utils.ModelDisplayName(model.ID)),
		ContextWindow:        contextWindow,
		MaxOutputTokens:      maxOutputTokens,
		FromAPI:              fromAPI,
		InputModalities:      inputModalities,
		ThinkingLevels:       thinkingLevels,
		DefaultThinkingLevel: defaultThinkingLevel,
	}
}

// Info returns provider metadata
func Info() provider.ProviderInfo {
	return provider.ProviderInfo{
		Name:                "anthropic",
		DisplayName:         "Anthropic (API)",
		ConfigKeyName:       "anthropic_api_key",
		EnvVarName:          "ANTHROPIC_API_KEY",
		APIKeyURL:           "https://console.anthropic.com/settings/keys",
		ModelContextWindows: ModelContextWindows,
		// Latest Haiku family for out-of-band micro-tasks. Matched by prefix
		// against the live Models API list (which returns dated ids such as
		// claude-haiku-4-5-20251001), so this need not be an exact id.
		CheapModel: "claude-haiku-4-5",
		// message_delta carries per-call authoritative prompt-token usage (see the
		// transient `usage` chunk emitted in the stream handler), so the footer
		// meter can grow against it live through a turn.
		StreamsLiveUsage: true,
	}
}
