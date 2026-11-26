//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package provider

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync/atomic"
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
	ImageTokens            int64 // every media part: images and video
	FramingTokens          int64
	ProviderOverheadTokens int64
	Total                  int64
}

// ContextLimitExceededError reports a context overflow confirmed by the
// provider. Cause retains that provider error so recovery and terminal reporting
// never mistake an approximate local estimate for authoritative rejection.
type ContextLimitExceededError struct {
	EstimatedInputTokens int64
	OutputReserveTokens  int64
	ContextWindowTokens  int64
	Breakdown            RequestTokenEstimate
	// MeasuredPrefix carries the basis of EstimatedInputTokens through recovery:
	// true means it was projected from a provider-reported count for this
	// thread's previous request, false that the whole request was estimated by
	// the local heuristic. Breakdown is whole-request estimate either way, so
	// this is the only thing that says whether the two are in the same units —
	// which is what the recovery logs need to be readable.
	MeasuredPrefix bool
	// Cause is the original provider context-overflow error. Visible request
	// admission never creates this type from an estimate alone.
	Cause error
}

// InputBasis names how EstimatedInputTokens was arrived at, for logs and
// messages that would otherwise present a measurement and a guess identically.
func (e *ContextLimitExceededError) InputBasis() string {
	if e.MeasuredPrefix {
		return "measured"
	}
	return "estimated"
}

func (e *ContextLimitExceededError) Error() string {
	return fmt.Sprintf("the provider rejected the request as exceeding its %d-token context window (%d tokens reserved for output; %s at %d input tokens)", e.ContextWindowTokens, e.OutputReserveTokens, e.InputBasis(), e.EstimatedInputTokens)
}

// Unwrap exposes the originating provider error (if any) so the terminal error
// item and logs can surface the provider's own wording while Error() stays a
// deterministic, provider-independent message.
func (e *ContextLimitExceededError) Unwrap() error { return e.Cause }

// ContextCompactionAdvisory asks the worker to compact a visible request before
// dispatch to a provider known to silently truncate oversized input. It is based
// only on an approximate estimate, is never terminal, and must either lead to
// structured recovery or one explicit request-local fallback dispatch.
type ContextCompactionAdvisory struct {
	EstimatedInputTokens int64
	OutputReserveTokens  int64
	ContextWindowTokens  int64
	Breakdown            RequestTokenEstimate

	// MeasuredPrefix reports that EstimatedInputTokens was projected from a
	// provider-reported count for this conversation's previous request plus an
	// estimate of only the messages appended since, rather than estimated in
	// full. Breakdown always describes the whole request either way, because the
	// recovery ladder reduces history in estimator units.
	MeasuredPrefix bool
}

func (e *ContextCompactionAdvisory) Error() string {
	basis := "estimated"
	if e.MeasuredPrefix {
		basis = "measured"
	}
	return fmt.Sprintf("request is %s at %d input tokens plus %d reserved output tokens against a %d-token context window; conservative compaction is advised", basis, e.EstimatedInputTokens, e.OutputReserveTokens, e.ContextWindowTokens)
}

// UnknownContextLimitError reports that admission could not prove the request
// fits because its context window is unknown.
type UnknownContextLimitError struct {
	ContextWindowTokens int64
	OutputReserveTokens int64
}

func (e *UnknownContextLimitError) Error() string {
	return fmt.Sprintf("cannot admit request: context limits are unknown for this model (context window %d, output reserve %d). Check the model id is one the provider reports, or refresh the provider's model list in settings", e.ContextWindowTokens, e.OutputReserveTokens)
}

// InvalidOutputReserveError reports model limits which leave no room for input.
type InvalidOutputReserveError struct {
	OutputReserveTokens int64
	ContextWindowTokens int64
}

func (e *InvalidOutputReserveError) Error() string {
	return fmt.Sprintf("cannot admit request: output reserve %d must be smaller than context window %d", e.OutputReserveTokens, e.ContextWindowTokens)
}

// SaturatingAdd returns a+b clamped to the int64 range instead of overflowing.
// Exported as the single home for saturating token arithmetic shared by the
// registry and the worker's compaction budgets.
func SaturatingAdd(a, b int64) int64 {
	if b > 0 && a > math.MaxInt64-b {
		return math.MaxInt64
	}
	if b < 0 && a < math.MinInt64-b {
		return math.MinInt64
	}
	return a + b
}

// approximateTokenCount is deliberately conservative across common BPE
// tokenizers. It is an advisory planning heuristic, not proof that request
// content fits or exceeds a provider's context window. Natural ASCII runs and
// repeated-punctuation runs receive modest compression, while mixed punctuation,
// long opaque strings, CJK, and symbols are charged at their denser rates.
//
// Calibrated against a cl100k golden corpus (admission_golden_test.go). Two
// rates are true per-byte maxima for byte-level BPE, which emits at most one
// token per input byte: non-ASCII runes are charged their UTF-8 byte length,
// and long (>16-char) ASCII alphanumeric runs one token per byte. This is NOT
// an unconditional upper bound, though: short alphanumeric runs are charged
// ~1/3 token per byte, so content segmented into ≤16-char chunks by punctuation
// (UUIDs, dotted/snake ids, hex columns, minified JSON keys) can tokenize near
// 1/byte and under-count without a fixed ceiling. That drift is left for
// context recovery to catch, not a guarantee admission proves away.
func approximateTokenCount(text string) int64 {
	var counter approximateTokenCounter
	for _, r := range text {
		counter.add(r)
	}
	return counter.total()
}

const (
	runAlphaNumeric uint8 = iota + 1
	runWhitespace
	runRepeatedPunct
)

type approximateTokenCounter struct {
	tokens    int64
	runLength int64
	runKind   uint8
	runRune   rune
}

func (c *approximateTokenCounter) add(r rune) {
	if r == utf8.RuneError {
		// U+FFFD, either literal or produced per invalid input byte by Go's
		// UTF-8 decoding. json.Marshal replaces invalid bytes with U+FFFD on
		// the wire too, so this is what the provider tokenizes; measured 1
		// token alone and 0.25/char in runs (cl100k). Charging its 3-byte
		// UTF-8 length tripled the estimate for binary junk (the
		// lone-surrogate adversarial case), so charge the measured maximum.
		c.flushRun(0)
		c.tokens = SaturatingAdd(c.tokens, 1)
		return
	}

	var kind uint8
	if r < utf8.RuneSelf {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			kind = runAlphaNumeric
		case unicode.IsSpace(r):
			kind = runWhitespace
		default:
			// ASCII punctuation/symbols: only *identical* consecutive runes
			// merge into a run (flushRun charges a compressed rate); a rune
			// differing from its predecessor flushes and starts a new run, so
			// mixed punctuation stays at one token per rune.
			kind = runRepeatedPunct
		}
	}
	if kind != 0 {
		if c.runKind != kind || (kind == runRepeatedPunct && c.runRune != r) {
			c.flushRun(kind)
			c.runKind = kind
			c.runRune = r
		}
		c.runLength = SaturatingAdd(c.runLength, 1)
		return
	}

	c.flushRun(0)
	// Every other non-ASCII rune costs its UTF-8 byte length: the provable
	// maximum for byte-level BPE (measured: common CJK ~1.75 tokens/char, rare
	// glyphs ~2.5, emoji ~2–3, of a 3–4 byte ceiling).
	c.tokens = SaturatingAdd(c.tokens, int64(utf8.RuneLen(r)))
}

// flushRun charges the run that just ended. next is the kind of run starting
// after it, or 0 at end of text or before a non-ASCII rune, because one rate
// depends on what follows.
func (c *approximateTokenCounter) flushRun(next uint8) {
	if c.runLength == 0 {
		return
	}
	var tokens int64
	switch {
	case c.runKind == runWhitespace && c.runLength == 1 && next == runAlphaNumeric:
		// A single space before a word is free. BPE vocabularies carry the
		// leading space inside the word token (" the", " quick"), so charging
		// the separator as well double-counts every word boundary in prose and
		// code — the largest single source of drift against cl100k. Only a lone
		// separator absorbed by a following word qualifies: runs of two or more
		// are real tokens and stay on the rate below, as does a trailing space
		// with no word to be absorbed into.
		tokens = 0
	case c.runKind == runAlphaNumeric && c.runLength <= 16:
		// Prose words: modest compression. Opaque runs this short (pasted ids,
		// keys, hex) tokenize denser — up to ~1/byte — so punctuation-segmented
		// dense content can under-count here without a fixed bound. Context
		// recovery, not admission, is the backstop for that drift.
		tokens = SaturatingAdd(c.runLength, 2) / 3
	case c.runKind == runAlphaNumeric:
		// Hashes, base64, random IDs, and minified data: adversarial
		// alphanumeric content reaches one token per byte in real BPE
		// tokenizers (measured "x9"×2000 and random alnum at exactly 1.0 in
		// cl100k), so charge the provable maximum rather than a density
		// guess.
		tokens = c.runLength
	case c.runKind == runRepeatedPunct:
		// Runs of one repeated punctuation rune (bracket walls in nested
		// JSON, ---- rules, ==== banners) merge aggressively in real BPE
		// vocabularies. The worst measured identical-run rate in cl100k is
		// exactly 0.5/char (brackets, quotes) with most far cheaper ("-"×64
		// is 1 token), so charge 1 + n/2 — never below the measured maximum
		// at any run length, and a single rune stays exactly 1.
		tokens = SaturatingAdd(1, c.runLength/2)
	default:
		// Whitespace: pure runs merge almost entirely in BPE, but
		// alternating mixes measured 0.33 tokens/char in cl100k.
		tokens = SaturatingAdd(c.runLength, 1) / 2
	}
	c.tokens = SaturatingAdd(c.tokens, tokens)
	c.runLength = 0
	c.runKind = 0
	c.runRune = 0
}

func (c approximateTokenCounter) total() int64 {
	c.flushRun(0)
	return c.tokens
}

func addEstimate(total *int64, field *int64, value int64) {
	*field = SaturatingAdd(*field, value)
	*total = SaturatingAdd(*total, value)
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
			addEstimate(&estimate.Total, &estimate.ImageTokens, estimateVideoTokens64(part))
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

// Unwrap exposes the wrapped provider so As can reach the capabilities that
// need no admission check, such as UsageStatsProvider.
func (p *admissionProvider) Unwrap() Provider { return p.Provider }

// AsCapability supplies the capabilities whose requests must be checked
// against the model's context window, and only when the provider underneath
// has them. A capability that sends model requests belongs here: one that is
// left out is found by As on the unchecked provider instead.
func (p *admissionProvider) AsCapability(target any) bool {
	switch t := target.(type) {
	case *ConversationProvider:
		inner, ok := As[ConversationProvider](p.Provider)
		if !ok {
			return false
		}
		*t = admissionConversationProvider{inner: inner, capabilities: p.capabilities, contract: p.contract}
		return true
	case *Decider:
		inner, ok := As[Decider](p.Provider)
		if !ok {
			return false
		}
		*t = admissionDecider{inner: inner, capabilities: p.capabilities, contract: p.contract}
		return true
	}
	return false
}

// admissionConversationProvider is the ConversationProvider admission control
// hands out: every conversation it opens checks each request against the
// model's context window before it reaches the provider.
type admissionConversationProvider struct {
	inner        ConversationProvider
	capabilities ModelCapabilities
	contract     BudgetContract
}

func (p admissionConversationProvider) OpenConversation(ctx context.Context, convID string) (Conversation, error) {
	cv, err := p.inner.OpenConversation(ctx, convID)
	if err != nil {
		return nil, err
	}
	return &admissionConversation{Conversation: cv, capabilities: p.capabilities, contract: p.contract}, nil
}

type admissionConversation struct {
	Conversation
	capabilities ModelCapabilities
	contract     BudgetContract

	// anchors holds the last measurement taken for each thread that has
	// dispatched through this conversation, keyed by MessageRequest.ThreadID.
	//
	// It is keyed by thread because one admissionConversation is shared by every
	// thread in the conversation — the handle is cached per (conversation,
	// provider, model, credential, capabilities), not per thread. A sub-thread
	// turn sends an entirely different message array and a filtered tool set, so
	// a single anchor would be overwritten by every sub-thread dispatch and miss
	// on the root turn that followed. Sub-threads are routine here, so that would
	// leave long conversations — the only ones that ever reach compaction —
	// permanently on the estimated path this anchor exists to avoid.
	//
	// The map is replaced wholesale and never mutated in place, so a pointer swap
	// is the entire synchronisation. Two dispatches racing to record can lose one
	// update; that costs a later miss, never a wrong projection, because every
	// read revalidates the hashes before trusting the number. Nil means nothing
	// measured yet.
	anchors atomic.Pointer[map[string]*measuredPrefixAnchor]
}

// maxAnchoredThreads bounds the anchor table. A conversation can open an
// unbounded number of sub-threads over its life and each would otherwise leave
// an entry behind for good. The bound sits well above the number of threads
// that can be mid-dispatch at once, so the entries that earn their place — the
// root and whatever sub-threads are live — are never the ones evicted.
const maxAnchoredThreads = 16

// measuredPrefixAnchor records what a provider actually billed for a request
// this conversation already dispatched, so the next request can be projected
// from that measurement instead of estimated from nothing.
//
// This exists because the estimator is a character heuristic that overcounts
// real transcripts by a factor of two or more, and estimating an entire history
// makes that error scale with the history. Anchoring takes the history out of
// the estimate: everything up to the last measured round-trip is a number the
// provider gave us, and only the messages appended since are estimated. The
// heuristic's error then applies to a few thousand tokens of new tool results
// rather than to two hundred thousand tokens of transcript.
//
// An anchor is valid only while the request keeps the shape it had when the
// measurement was taken — the same leading messages, and the same envelope
// (system prompt, tool definitions, tool choice), because the provider bills all
// of that inside InputTokens. Anything else means the measurement describes a
// request we are no longer sending, and admission falls back to estimating the
// whole thing.
//
// The match is all-or-nothing by necessity, not by choice: one measurement
// describes one exact prefix, so there is no partial number to re-anchor
// against a shorter common prefix when an early message changes. A standing
// context item that re-renders — a pinned file, edited between turns — therefore
// costs one estimated turn before the next dispatch anchors again.
type measuredPrefixAnchor struct {
	messageCount int
	prefixHash   string
	envelopeHash string
	inputTokens  int64
	// seq orders anchors by when they were recorded, so the table can evict its
	// least recently written entry without keeping a separate clock.
	seq int64
}

// inputProjection is admission's answer to "how large is this request", and
// which way it arrived at that number.
type inputProjection struct {
	total    int64
	anchored bool
	// breakdown is populated only on the unanchored path, where the whole
	// request had to be estimated anyway. hasFull distinguishes a computed
	// zero-value breakdown from an absent one.
	breakdown RequestTokenEstimate
	hasFull   bool
}

// hashMessages fingerprints a message sequence. Each record is length-prefixed
// so no two different sequences can produce the same concatenation. An
// unmarshalable message yields "", which callers treat as "cannot anchor"
// rather than as a match.
func hashMessages(messages []Message) string {
	h := sha256.New()
	for _, msg := range messages {
		encoded, err := json.Marshal(msg)
		if err != nil {
			return ""
		}
		fmt.Fprintf(h, "%d:", len(encoded))
		h.Write(encoded)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// hashRequestEnvelope fingerprints everything a request sends that is not a
// message. A changed system prompt or tool set changes the billed input just as
// a changed message does, so it invalidates an anchor the same way. Fields that
// cannot be marshaled (ShouldContinue is a func) are deliberately excluded:
// they are not sent to the provider as prompt content.
func hashRequestEnvelope(req MessageRequest) string {
	encoded, err := json.Marshal(struct {
		SystemPrompt string           `json:"systemPrompt"`
		Tools        []ToolDefinition `json:"tools"`
		ToolChoice   *ToolChoice      `json:"toolChoice"`
	}{req.SystemPrompt, req.Tools, req.ToolChoice})
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

// anchorFor returns this thread's stored anchor when it still describes a
// prefix of this request.
func (cv *admissionConversation) anchorFor(req MessageRequest) (*measuredPrefixAnchor, bool) {
	anchors := cv.anchors.Load()
	if anchors == nil {
		return nil, false
	}
	anchor := (*anchors)[req.ThreadID]
	if anchor == nil || anchor.messageCount == 0 || anchor.inputTokens <= 0 {
		return nil, false
	}
	// Fewer messages than were measured means the transcript was rewritten —
	// compaction folded it, or an edit dropped history — so the measurement
	// describes messages that are no longer being sent.
	if len(req.Messages) < anchor.messageCount {
		return nil, false
	}
	if hashRequestEnvelope(req) != anchor.envelopeHash {
		return nil, false
	}
	if hashMessages(req.Messages[:anchor.messageCount]) != anchor.prefixHash {
		return nil, false
	}
	return anchor, true
}

// projectInputTokens sizes the request, preferring measurement over estimate.
func (cv *admissionConversation) projectInputTokens(req MessageRequest) inputProjection {
	if anchor, ok := cv.anchorFor(req); ok {
		// Estimate the appended messages ONLY. The system prompt, tools,
		// framing and any provider overhead are all inside the measured count
		// already — re-adding them here would double-charge the very fixed
		// costs the measurement captured, which for a provider declaring a
		// large ProviderOverheadTokens is a large double-charge.
		delta := EstimateMessageRequestTokenBreakdown(MessageRequest{Messages: req.Messages[anchor.messageCount:]}, 0)
		return inputProjection{total: SaturatingAdd(anchor.inputTokens, delta.Total), anchored: true}
	}
	full := EstimateMessageRequestTokenBreakdown(req, cv.capabilities.ProviderOverheadTokens)
	return inputProjection{total: full.Total, breakdown: full, hasFull: true}
}

// fullBreakdown returns a whole-request breakdown, computing one if the
// projection took the anchored path. The compaction ladder reduces history
// using per-item estimates and derives its fixed envelope from these
// components, so it needs whole-request semantics even when the decision to
// compact was made from a measurement.
func (cv *admissionConversation) fullBreakdown(req MessageRequest, p inputProjection) RequestTokenEstimate {
	if p.hasFull {
		return p.breakdown
	}
	return EstimateMessageRequestTokenBreakdown(req, cv.capabilities.ProviderOverheadTokens)
}

// recordAnchor stores this round-trip's measurement for the next request on the
// same thread. err is the dispatch's own error, because what a failed dispatch
// reports is not a measurement of it.
func (cv *admissionConversation) recordAnchor(req MessageRequest, result *StreamResult, err error) {
	// A synthetic request is not a turn in any thread's transcript: the hidden
	// compaction calls that set it swap the system prompt, drop the tools and send
	// a transcript of their own, and the folded-summary probe sends that under the
	// PARENT thread's id. Recording any of them would file a measurement of a
	// request shape no real turn ever sends under a key real turns read, and evict
	// a good anchor to do it.
	//
	// Bypassing the context guard is deliberately NOT the test. A real turn
	// dispatched over the ceiling is still that thread's transcript, and it is the
	// dispatch a pressured conversation most needs measured: the ladder bypasses
	// exactly when its projection is the thing in doubt, so refusing to anchor
	// there would make a wrong or missing anchor permanent for the life of the
	// conversation.
	if req.SyntheticTranscript {
		return
	}
	// A dispatch that failed did not measure the request it was given. Providers
	// still populate a result on the error path — claudecode sums whatever usage
	// arrived before the failure — and the counts that survive there can describe
	// something else entirely: when a session limit means no usage for this
	// request ever arrives, what is left is the CLI's session-wide cumulative
	// total, several times the size of the request that never went out.
	if err != nil {
		return
	}
	// Only a provider-reported count may anchor. InputTokensApproximate means
	// the number is itself a local fallback estimate, so anchoring on it would
	// pin the projection to the guesswork it exists to replace.
	//
	// An unusable result leaves any existing anchor in place rather than
	// clearing it: an older anchor still describes a real measured prefix, and
	// carrying a larger estimated delta is strictly better than estimating the
	// entire history again.
	if result == nil || result.InputTokens <= 0 || result.InputTokensApproximate {
		return
	}
	// A count larger than the whole context window cannot describe the request
	// that was just accepted — it fit, so it was smaller than the window. The
	// comparison is against the WINDOW and not the admission ceiling on purpose:
	// a bypassed dispatch may legitimately sit between the two, and that is
	// precisely the measurement worth having. This is only a backstop for counts
	// that are self-evidently not this request's (a provider reporting a
	// session-wide total); a wrong-but-plausible number still gets through, so
	// nothing else may lean on it.
	if window := cv.capabilities.ContextWindowTokens; window > 0 && int64(result.InputTokens) > window {
		return
	}
	prefix := hashMessages(req.Messages)
	envelope := hashRequestEnvelope(req)
	if prefix == "" || envelope == "" {
		return
	}
	cv.storeAnchor(req.ThreadID, &measuredPrefixAnchor{
		messageCount: len(req.Messages),
		prefixHash:   prefix,
		envelopeHash: envelope,
		inputTokens:  int64(result.InputTokens),
	})
}

// storeAnchor files an anchor under its thread, copying the table rather than
// mutating the one readers hold, and evicting the oldest entry once the table
// is over its bound.
func (cv *admissionConversation) storeAnchor(threadID string, anchor *measuredPrefixAnchor) {
	next := map[string]*measuredPrefixAnchor{}
	var latest int64
	if current := cv.anchors.Load(); current != nil {
		for id, existing := range *current {
			next[id] = existing
			if existing.seq > latest {
				latest = existing.seq
			}
		}
	}
	anchor.seq = latest + 1
	next[threadID] = anchor
	for len(next) > maxAnchoredThreads {
		oldestID, oldestSeq := "", int64(math.MaxInt64)
		for id, existing := range next {
			if existing.seq < oldestSeq {
				oldestID, oldestSeq = id, existing.seq
			}
		}
		delete(next, oldestID)
	}
	cv.anchors.Store(&next)
}

// ContextSafetyReserve derives the output reserve for a known context window
// when the model exposes no output limit of its own. Exported so providers that
// set their own wire output cap can charge the identical reserve (the wire
// value and the admission reserve must never diverge).
func ContextSafetyReserve(window int64) int64 {
	// min(window/5, clamp(window/8, 20k, 64k)), floored at one token:
	//
	//   - up to 100k, a fifth of the window;
	//   - 100k–160k, a flat 20k;
	//   - 160k–512k, an eighth of the window (262,144 → 32,768);
	//   - 512k and above, a flat 64k.
	//
	// Every piece meets its neighbour, so the function is continuous and
	// monotone: no window derives less than a slightly smaller one. The reserve
	// is held back inside the window, so it is room history cannot use. A
	// modest one suits the short replies of an agent turn and keeps input room
	// in the 100k–200k range where compaction pressure is highest. A large window
	// has room to spare, and there a long single reply (a reasoning model's
	// thinking plus its answer) should not be cut short by a budget sized for a
	// small one. The 64k ceiling bounds how long a runaway generation can run on
	// slow local hardware. The fifth keeps small windows well under the
	// compaction ceiling (DefaultContextCeilingFraction).
	return max(int64(1), min(window/5, min(max(window/8, 20_000), MaxDefaultOutputReserve)))
}

// MaxDefaultOutputReserve is the most output a request budgets for unless the
// user set the model's Max output themselves. A limit a catalogue or endpoint
// states is the longest reply the model can give, not what a turn needs, and
// some are a large share of the window (384k of 1M): charged in full, that
// share is room history can never use, so admission advises compaction with
// much of the window empty. A reply that runs out can still be retried once at
// up to the stated limit.
const MaxDefaultOutputReserve int64 = 64_000

// DefaultContextCeilingFraction is the share of a model's context window a
// request may occupy before admission asks the caller to compact.
//
// It is deliberately below 1.0, and that is the whole design of automatic
// compaction. Admission is the one place that measures a fully-built request
// against a known window, and it runs before every dispatch — including the
// dispatches between the tool calls of a single turn. Raising the advisory at a
// soft ceiling therefore makes compaction happen while a turn is still working,
// where a smaller transcript still helps it, instead of only after a provider
// rejects a request or after the turn has already settled.
//
// The advisory is a request to reduce, not a refusal: a caller that cannot
// reduce any further re-submits with BypassContextGuard and the request goes
// out. That is safe precisely because the ceiling is soft — there is real window
// left above it — and it is why this single rule also protects providers that
// would silently truncate rather than reject, without a separate policy.
const DefaultContextCeilingFraction = 0.85

// ContextCeiling resolves the input ceiling for a request against a known
// window. A zero fraction selects DefaultContextCeilingFraction; 1.0 asks for
// the hard window (see MessageRequest.ContextCeilingFraction). The result is
// clamped to at least 1 so a tiny window can never produce a ceiling of 0,
// which would advise on every request including the ones compaction emits.
func ContextCeiling(window int64, fraction float64) int64 {
	if fraction <= 0 {
		fraction = DefaultContextCeilingFraction
	}
	if fraction > 1 {
		fraction = 1
	}
	return max(int64(1), int64(float64(window)*fraction))
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
		reserve = ContextSafetyReserve(window)
	}
	// A one-off raise (a retry of a turn that ran out of Max output) is charged
	// in full: a raised reply that cannot fit beside the input is advised to
	// compact below rather than dispatched to be cut off again.
	if req.RaiseMaxOutputTokens > reserve {
		reserve = req.RaiseMaxOutputTokens
	}
	// A per-request output cap (F1: hidden compaction map calls) only ever lowers
	// the wire max_tokens, so charge the smaller reserve to match — the reserve
	// admission charges must never exceed what the wire actually reserves. The
	// invalid-reserve check below runs against this effective reserve.
	if req.MaxOutputTokens > 0 && req.MaxOutputTokens < reserve {
		reserve = req.MaxOutputTokens
	}
	if reserve >= window {
		return nil, &InvalidOutputReserveError{
			OutputReserveTokens: reserve,
			ContextWindowTokens: window,
		}
	}

	projection := cv.projectInputTokens(req)
	if !req.BypassContextGuard && SaturatingAdd(projection.total, reserve) > ContextCeiling(window, req.ContextCeilingFraction) {
		return nil, &ContextCompactionAdvisory{
			EstimatedInputTokens: projection.total,
			OutputReserveTokens:  reserve,
			ContextWindowTokens:  window,
			Breakdown:            cv.fullBreakdown(req, projection),
			MeasuredPrefix:       projection.anchored,
		}
	}
	// The estimate cleared the ceiling, so dispatch. It is still only an
	// estimate: a provider that rejects the request anyway is authoritative, and
	// the conversion below hands the worker the same typed error the advisory
	// produces, so both arrive at one compaction path.
	result, err := cv.Conversation.Submit(ctx, req, callback)
	if err != nil && isProviderContextOverflowError(err) {
		// Convert the provider's real rejection into the shared typed error so the
		// worker can recover while retaining the authoritative cause.
		return nil, &ContextLimitExceededError{
			EstimatedInputTokens: projection.total,
			OutputReserveTokens:  reserve,
			ContextWindowTokens:  window,
			Breakdown:            cv.fullBreakdown(req, projection),
			MeasuredPrefix:       projection.anchored,
			Cause:                err,
		}
	}
	// Anchor the next request on what this one actually cost, then carry the
	// projection out beside the provider's own count for the same request. This
	// is the only point where both numbers exist: the projection is computed
	// here and discarded otherwise, while the reported count is only read
	// further up. Pairing them lets the caller log the ratio the advisory fires
	// on, and whether it fired from measurement or from estimate.
	cv.recordAnchor(req, result, err)
	if result != nil {
		result.AdmissionEstimateTokens = clampToInt(projection.total)
		result.AdmissionAnchored = projection.anchored
	}
	return result, err
}

// clampToInt narrows a saturating token estimate to the int the usage fields
// use. A saturated estimate (unmarshalable request data) pins at MaxInt rather
// than wrapping negative, which would read as an impossible ratio in the log.
func clampToInt(v int64) int {
	if v > math.MaxInt {
		return math.MaxInt
	}
	if v < 0 {
		return 0
	}
	return int(v)
}

// isProviderContextOverflowError reports whether a provider's own error signals
// that the request exceeded the model's context window. Providers surface this
// as an HTTP 400 with heterogeneous wording and no shared structured code, so
// detection is centralized here over a conservative set of signatures rather
// than scattered across the provider adapters. An error that is already a
// ContextLimitExceededError is left alone because it already represents a
// converted provider rejection.
func isProviderContextOverflowError(err error) bool {
	if err == nil {
		return false
	}
	var limit *ContextLimitExceededError
	if errors.As(err, &limit) {
		return false
	}
	msg := strings.ToLower(err.Error())
	// Negative screen first: an OpenAI TPM rate-limit 429 reads "Request too
	// large for gpt-4o ... tokens per min (TPM)", which otherwise matches the
	// "request too large" signature below. A rate limit is retryable and must
	// not be converted into a terminal context-limit error; the worker's
	// rate-limit path handles it. Screen these out before the overflow match.
	for _, rateLimit := range []string{"per min", "tpm", "rate limit", "rate_limit"} {
		if strings.Contains(msg, rateLimit) {
			return false
		}
	}
	// A request body over Anthropic's byte limit (413 request_too_large,
	// "Request exceeds the maximum allowed number of bytes") matches "exceeds
	// the maximum" but is no token overflow. Images are what make a body that
	// big, and compaction folds text while resending every image, so recovery
	// would spend summary calls and history without ever getting under the
	// limit. Leave it a plain error that ends the turn with the provider's own
	// wording. The HTTP status text ("413 Request Entity Too Large") is not a
	// marker: Vertex sends a genuine token overflow with that status.
	for _, byteLimit := range []string{"number of bytes", "request_too_large"} {
		if strings.Contains(msg, byteLimit) {
			return false
		}
	}
	for _, signature := range []string{
		"context_length_exceeded",           // OpenAI error code
		"context length",                    // OpenAI/DeepSeek/Mistral "maximum context length is N tokens"
		"context window",                    // OpenAI responses "exceeds the context window of this model"
		"context limit",                     // Anthropic "input length and max_tokens exceed context limit"
		"context size",                      // llama.cpp "request exceeds the available context size"
		"maximum context",                   // OpenAI "This model's maximum context length"
		"maximum prompt length",             // xAI "This model's maximum prompt length is N"
		"prompt is too long",                // Anthropic "prompt is too long: N tokens > M maximum"
		"input is too long",                 // Anthropic (legacy wording)
		"too many tokens",                   // Cohere-style "too many tokens"
		"exceeded model token limit",        // Moonshot/Kimi "Your request exceeded model token limit: N"
		"prompt token count",                // GitHub Copilot "prompt token count of N exceeds the limit of M"
		"exceeds the maximum",               // Gemini "input token count (N) exceeds the maximum number of tokens allowed (M)"
		"reduce the length of the messages", // OpenAI remediation suffix
		"request too large",                 // generic 400 wording (rate limits screened above)
	} {
		if strings.Contains(msg, signature) {
			return true
		}
	}
	return false
}
