//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"unicode"
	"unicode/utf8"
)

const messageFramingTokens int64 = 4

// RequestTokenEstimate identifies each contribution to an admission estimate.
// Fields and Total use saturating arithmetic.
type RequestTokenEstimate struct {
	SystemPromptTokens     int64
	MessageTokens          int64
	ToolTokens             int64
	MetadataTokens         int64
	ImageTokens            int64
	FramingTokens          int64
	ProviderOverheadTokens int64
	Total                  int64
}

// ContextLimitExceededError reports a request which cannot fit while preserving
// the configured output reserve. It is deterministic and must not be retried.
type ContextLimitExceededError struct {
	EstimatedInputTokens int64
	OutputReserveTokens  int64
	ContextWindowTokens  int64
	Breakdown            RequestTokenEstimate
}

func (e *ContextLimitExceededError) Error() string {
	return fmt.Sprintf("request needs %d input tokens plus %d reserved output tokens; model context window is %d tokens", e.EstimatedInputTokens, e.OutputReserveTokens, e.ContextWindowTokens)
}

// Retryable allows generic error classifiers to identify this as terminal.
func (e *ContextLimitExceededError) Retryable() bool { return false }

// UnknownContextLimitError reports that admission could not prove the request
// fits because its context window is unknown.
type UnknownContextLimitError struct {
	ContextWindowTokens int64
	OutputReserveTokens int64
}

func (e *UnknownContextLimitError) Error() string {
	return fmt.Sprintf("cannot admit request with unknown model limits (context window %d, output reserve %d)", e.ContextWindowTokens, e.OutputReserveTokens)
}

// Retryable allows generic error classifiers to identify this as terminal.
func (e *UnknownContextLimitError) Retryable() bool { return false }

// InvalidOutputReserveError reports model limits which leave no room for input.
type InvalidOutputReserveError struct {
	OutputReserveTokens int64
	ContextWindowTokens int64
}

func (e *InvalidOutputReserveError) Error() string {
	return fmt.Sprintf("cannot admit request: output reserve %d must be smaller than context window %d", e.OutputReserveTokens, e.ContextWindowTokens)
}

// Retryable allows generic error classifiers to identify this as terminal.
func (e *InvalidOutputReserveError) Retryable() bool { return false }

func saturatingAdd(a, b int64) int64 {
	if b > 0 && a > math.MaxInt64-b {
		return math.MaxInt64
	}
	if b < 0 && a < math.MinInt64-b {
		return math.MinInt64
	}
	return a + b
}

// approximateTokenCount is deliberately conservative across common BPE
// tokenizers. Natural ASCII runs receive modest compression, while punctuation,
// long opaque strings, CJK, and symbols are charged at their denser rates.
func approximateTokenCount(text string) int64 {
	var counter approximateTokenCounter
	for _, r := range text {
		counter.add(r)
	}
	return counter.total()
}

type approximateTokenCounter struct {
	tokens    int64
	runLength int64
	runKind   uint8
}

func (c *approximateTokenCounter) add(r rune) {
	const (
		runAlphaNumeric uint8 = iota + 1
		runWhitespace
	)

	var kind uint8
	if r < utf8.RuneSelf {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			kind = runAlphaNumeric
		case unicode.IsSpace(r):
			kind = runWhitespace
		}
	}
	if kind != 0 {
		if c.runKind != kind {
			c.flushRun()
			c.runKind = kind
		}
		c.runLength = saturatingAdd(c.runLength, 1)
		return
	}

	c.flushRun()
	if r < utf8.RuneSelf || unicode.IsLetter(r) || unicode.IsNumber(r) {
		c.tokens = saturatingAdd(c.tokens, 1)
		return
	}
	// Emoji and symbols can decompose into multiple byte-level BPE tokens.
	c.tokens = saturatingAdd(c.tokens, int64(utf8.RuneLen(r)))
}

func (c *approximateTokenCounter) flushRun() {
	if c.runLength == 0 {
		return
	}
	var tokens int64
	switch {
	case c.runKind == 1 && c.runLength <= 16:
		tokens = saturatingAdd(c.runLength, 2) / 3
	case c.runKind == 1:
		// Hashes, base64, random IDs, and minified data tokenize densely.
		if c.runLength > (math.MaxInt64-3)/3 {
			tokens = math.MaxInt64
		} else {
			tokens = (c.runLength*3 + 3) / 4
		}
	default:
		tokens = saturatingAdd(c.runLength, 3) / 4
	}
	c.tokens = saturatingAdd(c.tokens, tokens)
	c.runLength = 0
	c.runKind = 0
}

func (c approximateTokenCounter) total() int64 {
	c.flushRun()
	return c.tokens
}

func addEstimate(total *int64, field *int64, value int64) {
	*field = saturatingAdd(*field, value)
	*total = saturatingAdd(*total, value)
}

func marshaledTokenCount(value any) int64 {
	encoded, err := json.Marshal(value)
	if err != nil {
		return math.MaxInt64
	}
	return approximateTokenCount(string(encoded))
}

// EstimateMessageRequestTokenBreakdown conservatively estimates every shared
// request field, tool and schema, image, chat framing marker, and configured
// provider serialization overhead. Unsupported provider data saturates it.
func EstimateMessageRequestTokenBreakdown(req MessageRequest, providerOverhead int64) RequestTokenEstimate {
	var estimate RequestTokenEstimate
	if req.SystemPrompt != "" {
		addEstimate(&estimate.Total, &estimate.FramingTokens, messageFramingTokens)
		addEstimate(&estimate.Total, &estimate.SystemPromptTokens, approximateTokenCount("system"))
		addEstimate(&estimate.Total, &estimate.SystemPromptTokens, approximateTokenCount(req.SystemPrompt))
	}

	for _, msg := range req.Messages {
		addEstimate(&estimate.Total, &estimate.FramingTokens, messageFramingTokens)
		addEstimate(&estimate.Total, &estimate.MessageTokens, approximateTokenCount(MessageTypeToRole(msg.Type)))
		addEstimate(&estimate.Total, &estimate.MessageTokens, marshaledTokenCount(msg))
		for _, part := range msg.Parts {
			addEstimate(&estimate.Total, &estimate.ImageTokens, estimateImageTokens64(part))
		}
	}

	for _, tool := range req.Tools {
		addEstimate(&estimate.Total, &estimate.ToolTokens, marshaledTokenCount(tool))
	}
	if req.ToolChoice != nil {
		addEstimate(&estimate.Total, &estimate.MetadataTokens, marshaledTokenCount(req.ToolChoice))
	}
	addEstimate(&estimate.Total, &estimate.MetadataTokens, approximateTokenCount(req.ConversationID))
	addEstimate(&estimate.Total, &estimate.MetadataTokens, approximateTokenCount(req.ThreadID))
	if providerOverhead > 0 {
		addEstimate(&estimate.Total, &estimate.ProviderOverheadTokens, providerOverhead)
	}
	return estimate
}

// EstimateMessageRequestTokens estimates the shared request envelope without
// model-specific provider overhead.
func EstimateMessageRequestTokens(req MessageRequest) int64 {
	return EstimateMessageRequestTokenBreakdown(req, 0).Total
}

type admissionProvider struct {
	Provider
	capabilities ModelCapabilities
	contract     BudgetContract
}

func (p *admissionProvider) OpenConversation(ctx context.Context, convID string) (Conversation, error) {
	cv, err := p.Provider.OpenConversation(ctx, convID)
	if err != nil {
		return nil, err
	}
	return &admissionConversation{Conversation: cv, capabilities: p.capabilities, contract: p.contract}, nil
}

type admissionUsageProvider struct {
	*admissionProvider
	usage UsageStatsProvider
}

func (p *admissionUsageProvider) UsageStats(ctx context.Context) (UsageStats, error) {
	return p.usage.UsageStats(ctx)
}

type admissionConversation struct {
	Conversation
	capabilities ModelCapabilities
	contract     BudgetContract
}

func contextSafetyReserve(window int64) int64 {
	if window > 200_000 {
		return 20_000
	}
	return max(int64(1), window/5)
}

func (cv *admissionConversation) Submit(ctx context.Context, req MessageRequest, callback StructuredStreamCallback) (*StreamResult, error) {
	window := cv.capabilities.ContextWindowTokens
	reserve := cv.contract.OutputReserveTokens
	if reserve <= 0 {
		reserve = cv.capabilities.MaxOutputTokens
	}
	if window <= 0 {
		if cv.contract.AllowUnknownLimits {
			return cv.Conversation.Submit(ctx, req, callback)
		}
		return nil, &UnknownContextLimitError{ContextWindowTokens: window, OutputReserveTokens: reserve}
	}
	if reserve <= 0 {
		reserve = contextSafetyReserve(window)
	}
	if reserve >= window {
		return nil, &InvalidOutputReserveError{
			OutputReserveTokens: reserve,
			ContextWindowTokens: window,
		}
	}

	breakdown := EstimateMessageRequestTokenBreakdown(req, cv.capabilities.ProviderOverheadTokens)
	if saturatingAdd(breakdown.Total, reserve) > window {
		return nil, &ContextLimitExceededError{
			EstimatedInputTokens: breakdown.Total,
			OutputReserveTokens:  reserve,
			ContextWindowTokens:  window,
			Breakdown:            breakdown,
		}
	}
	return cv.Conversation.Submit(ctx, req, callback)
}
