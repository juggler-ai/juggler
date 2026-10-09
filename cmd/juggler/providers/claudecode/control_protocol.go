//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Stdio control protocol dispatcher matching the wire format used by the
// Claude Agent SDK (https://github.com/anthropics/claude-agent-sdk-python).
// The CLI multiplexes regular stream events and control envelopes on the
// same stdout — they're distinguished by the top-level "type" field. This
// file owns:
//
//   - inbound dispatch: a control_request from the CLI (typically asking
//     us to run an MCP tool via mcp_message) is routed to the matching
//     handler. tools/call is async — we record it and let the worker
//     execute the tool out-of-band; the control_response is written when
//     the worker hands us the result on the next StreamMessage call.
//
//   - outbound bookkeeping: control_requests we send to the CLI (today
//     only the initialize handshake) carry a unique request_id; the CLI
//     replies with a matching control_response, which we deliver back to
//     the in-flight caller via a per-request channel.
//
//   - serialised stdin writes: every line that goes to the CLI's stdin
//     (user messages, control_responses, control_requests) is funnelled
//     through a single writer to keep encoded JSON-lines whole.
//
// The wire format is documented inline in protocol.go; the canonical
// reference is the SDK's query.py.

package claudecode

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync/atomic"

	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/jlog"
)

// controlProtocol owns the stdio control flow for one CLI session. One
// instance per activeSession, lifetime tied to the live CLI subprocess.
//
// Concurrency model: a single actor goroutine (run) owns every field below
// and is the ONLY writer of the CLI's stdin. Public methods submit a closure
// on cmds and block until the actor has executed it (see runOnActor), so callers get
// synchronous semantics while all state mutation + stdin writes happen on one
// goroutine — no mutex. Internal `…Locked` bodies already run on the actor and
// call each other directly (calling a public wrapper from inside the actor
// would deadlock). This is what lets the always-on stdout reader feed control
// frames concurrently with the worker delivering tool results.
type controlProtocol struct {
	stdin io.Writer

	// Actor plumbing. cmds carries closures to run on the actor goroutine;
	// quit stops it; done closes when run() returns. cmds is unbuffered so a
	// successful send guarantees the actor will execute the closure before its
	// next select (the basis for runOnActor()'s deadlock-freedom).
	cmds chan func()
	quit chan struct{}
	done chan struct{}

	// parkedCalls holds mcp_message tools/call requests the CLI has sent us but
	// we haven't answered yet — a CONSUMING FIFO: an answered call is removed,
	// never marked-in-place. Routing matches a delivered result to a parked call
	// by its (name+args) key, FIFO among same-key. The worker feeds results in
	// pendingTools (stream) order and the CLI parks tools/call in that SAME order
	// (pendingTools is the authoritative source of truth), so the oldest same-key
	// parked call is always the right one — including two identical-(name,args)
	// calls in one turn, which then pair in arrival order. When no exact-key call
	// is parked the result answers the oldest parked call of the SAME TOOL NAME
	// (arg-drift across a resume/restart: same logical call, args re-serialised to
	// different bytes — see TestContinueSession_DeliversAcrossArgDivergence). The
	// name-match is a HARD wall: a result is NEVER delivered to a call of a
	// different tool, because crossing tool types is silent corruption (an agent
	// reasons on, or re-runs, the wrong output). A genuine no-match degrades to a
	// recoverable wait (teardown answers it with an error), never a wrong answer.
	// Consuming (not index-addressed) is load-bearing: pendingTools is rebuilt
	// per turn and re-numbered from 0, while this set spans the warm session, so
	// any absolute index would desync across turns ("index=0 already answered").
	// Cross-turn staleness is filtered upstream: extractToolResults only ever
	// feeds results whose tool_use_id is in the CURRENT turn's pendingTools, so a
	// stale/duplicate result from a prior turn never reaches the router.
	parkedCalls []pendingMCPCall

	// pendingOut records control_requests we've sent to the CLI that
	// are awaiting a control_response. Keyed by the request_id we
	// generated. Channel is closed when a response arrives or the
	// session ends.
	pendingOut map[string]chan *ControlResponseBody

	// stashedResults holds worker results that arrived before their parked call.
	// This is the COMMON order, not a rare race: the worker executes each tool off
	// the streamed tool_use block (driveToolActions), so the result is usually
	// ready before the CLI emits the matching tools/call. Each carries the
	// worker-recorded (name+args) key; a parking call drains the oldest stash that
	// matches it by key, then by same-tool-name (arg-drift), never across types.
	stashedResults []stashedResult

	// reqCounter generates monotonic request_ids for outbound
	// control_requests. Random suffix prevents collisions across
	// processes / restarts when reading logs.
	reqCounter atomic.Int64

	// tools is set by dispatch.go to a closure that returns the current
	// request's MCP-formatted tool list. Decoupled from the constructor
	// because tools come from the request, not the session.
	tools func() ([]json.RawMessage, error)

	// currentGeneration is the index of the tool ROUND in flight; parked calls and
	// stashed results pair only within the same generation, bounding a desync to
	// its round (see doc.go's "Tool-delivery desync" section — the generation
	// scoping defense).
	//
	// Advanced at the true round BOUNDARY: the first tools/call park that follows
	// a stop_reason=tool_use pause (openNewGenerationLocked, gated by roundClosed),
	// NOT on the pause itself. The real CLI emits a round's tools/call BEFORE that
	// round's pause (the tool_use block completes → CLI dispatches the MCP
	// tools/call → THEN the message_delta pause closes the message). Advancing on
	// the pause would bump the generation between a round's park and its own
	// delivery, stranding the just-parked call a generation behind its result.
	// Anchoring on the first park after a pause keeps each round's park AND
	// delivery in one generation regardless of pause/park/deliver ordering.
	currentGeneration int

	// roundClosed is set by noteToolUsePause (stream paused on stop_reason=tool_use,
	// the round's tool emission is complete) and cleared by openNewGenerationLocked
	// when the next round's first call parks. The latch that turns "a pause
	// happened" into "the next park opens a new generation", decoupling the bump
	// from pause/park arrival order on the wire.
	roundClosed bool

	// deliveredSinceGenAdvance records whether deliverNextToolResult ran since the
	// current generation was opened — the specificity input to the out-of-band
	// detector (see openNewGenerationLocked and doc.go's "Tool-delivery desync"
	// section). A normal round that resolved its tools sets this true, so a
	// lingering orphan does not look like the out-of-band case.
	deliveredSinceGenAdvance bool

	// outOfBandRounds counts out-of-band rounds openNewGenerationLocked detected
	// (a new round opening while the prior generation still had parked calls and
	// nothing was delivered for them). Always 0 in practice; the loud tripwire for
	// a future CLI execution-model change. See doc.go's "Tool-delivery desync".
	outOfBandRounds int
}

// pendingMCPCall captures the identity of a CLI-side tools/call we've
// received but haven't responded to. requestID is the control_request's
// envelope ID; jsonrpcID is the inner JSONRPC ID we need to echo back in
// the mcp_response. key is the (name+canonical-args) the result is routed on
// (FIFO among same-key; same-tool-name fallback for arg-drift). The tools/call
// wire frame carries no tool_use_id, so the key is the only identity available.
type pendingMCPCall struct {
	requestID  string
	jsonrpcID  json.RawMessage
	key        mcpMatchKey
	generation int // tool round this call parked in; matched only against same-generation results
}

// stashedResult is a worker result delivered before its CLI tools/call had
// parked, tagged with the worker-recorded key so the eventual parking call
// can drain it by identity rather than blindly by FIFO position.
type stashedResult struct {
	key        mcpMatchKey
	result     *provider.ToolResult
	generation int // tool round this result was delivered in; drained only by a same-generation park
}

// mcpMatchKey identifies one logical tool call by (toolName + canonical JSON
// of its arguments). The tools/call wire format carries no tool_use_id, so this
// (name+args) key is the only stable identity we have, and it is the router: a
// delivered result answers the parked call whose key matches it, FIFO among
// same-key. Because args can drift across a resume/restart (the old "stuck in
// Running" wedge), a non-matching key is NOT fatal — delivery falls back to the
// oldest parked call of the SAME TOOL NAME so the turn proceeds, and the
// mismatch is logged. The fallback never crosses tool names (see toolNameOf).
type mcpMatchKey string

// makeMCPMatchKey canonicalises args by round-tripping through
// interface{} so map keys are sorted at every nesting level (Go's
// encoding/json sorts map keys recursively). Identical inputs produce
// identical keys regardless of upstream ordering.
//
// It also collapses scalar TYPE drift (canonicalizeScalars): a JSON number and
// its string spelling, a bool and its string spelling, canonicalise equal. The
// CLI parks its tools/call with native scalars ({"limit":40,"-n":true}) while
// the worker-recorded tool_use.input can carry string spellings ({"limit":"40",
// "-n":"true"}) after a resume/restart doc round-trip — the same logical call,
// re-serialised. Without this collapse the pure type difference defeats
// exact-key matching, forcing the lossy same-tool-name positional fallback,
// which mis-pairs concurrent same-tool calls (two reads of different files swap
// results). Different VALUES still produce different keys, so a genuine
// divergence is still surfaced.
//
// Finally it folds literal "\uXXXX" escapes in string leaves to the rune they
// denote (canonicalizeScalars → decodeLiteralUnicodeEscapes): the CLI parks the
// actual rune ("…") while the worker-recorded tool_use.input, streamed across
// input_json_delta fragments, can carry the six-character escape ("\u2026") for
// the same non-ASCII character. Left unfolded the two spellings are different Go
// string values, so json.Marshal renders them differently and the keys diverge
// (the "tool/request divergence" INFO/ERROR log seen on large edit/write/grep
// payloads containing …, →, —, ≥, the BOM, or emoji). Same class of benign
// re-serialisation drift as scalar types; folded symmetrically on both sides.
func makeMCPMatchKey(toolName string, argsJSON json.RawMessage) mcpMatchKey {
	if len(argsJSON) == 0 {
		return mcpMatchKey(toolName + "::{}")
	}
	var v any
	if err := json.Unmarshal(argsJSON, &v); err != nil {
		return mcpMatchKey(toolName + "::" + string(argsJSON))
	}
	canon, err := json.Marshal(canonicalizeScalars(v))
	if err != nil {
		return mcpMatchKey(toolName + "::" + string(argsJSON))
	}
	return mcpMatchKey(toolName + "::" + string(canon))
}

// canonicalizeScalars rewrites every leaf scalar of a decoded JSON value to its
// canonical string form so a scalar matches its string spelling: 40 and "40",
// true and "true", null and "null". Container shape (object keys, array order)
// is preserved; only leaves change. json.Unmarshal decodes all numbers as
// float64, so integers are formatted without a trailing ".0" — 40, not 40.0 —
// to match the spelling "40". See makeMCPMatchKey for why this collapse is
// load-bearing for tool-result routing across a resume/restart.
func canonicalizeScalars(v any) any {
	switch t := v.(type) {
	case map[string]any:
		for k, val := range t {
			t[k] = canonicalizeScalars(val)
		}
		return t
	case []any:
		for i, val := range t {
			t[i] = canonicalizeScalars(val)
		}
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	case nil:
		return "null"
	case string:
		// Already the canonical form the numeric/bool/nil leaves coerce to —
		// except a literal "\uXXXX" escape must fold to its rune so it matches the
		// same leaf carrying the actual character (see decodeLiteralUnicodeEscapes).
		return decodeLiteralUnicodeEscapes(t)
	default:
		return t
	}
}

// decodeLiteralUnicodeEscapes folds every literal "\uXXXX" sequence in s (a
// backslash, a 'u', four hex digits — six ASCII characters) to the single rune
// it denotes, combining an adjacent high+low surrogate pair into one astral
// rune. It exists because a tool-input string leaf can reach the router two ways
// for the same logical call: the CLI parks the actual rune ("…"), while the
// worker-recorded tool_use.input — reassembled from input_json_delta fragments —
// can carry the six-character escape ("\u2026"). Both must canonicalise to one
// key or exact-key matching fails and the lossy same-tool-name positional
// fallback fires. Folding is applied to BOTH match sides, so it can never
// manufacture a false divergence, and the key is match-only (never delivered to
// the tool), so collapsing escaped and literal spellings of identical runes is
// safe. Real payloads seen in the logs: '…' (\u2026), '→' (\u2192), '—'
// (\u2014), '≥' (\u2265), the BOM (\uFEFF), and emoji-range grep patterns.
func decodeLiteralUnicodeEscapes(s string) string {
	// Fast path: no "\u" means no escape to fold (the overwhelmingly common case).
	if !strings.Contains(s, `\u`) {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		if r, size, ok := parseUnicodeEscapeAt(s, i); ok {
			b.WriteRune(r)
			i += size
			continue
		}
		b.WriteByte(s[i])
		i++
	}
	return b.String()
}

// parseUnicodeEscapeAt decodes a literal "\uXXXX" escape at s[i], returning the
// rune, the bytes consumed, and whether an escape was present. A high surrogate
// immediately followed by a low surrogate is combined into the single astral
// rune it encodes (12 bytes); a lone or malformed escape decodes to its 16-bit
// value as-is (6 bytes). Any fixed handling of the malformed case stays
// symmetric because it runs on both match sides.
func parseUnicodeEscapeAt(s string, i int) (rune, int, bool) {
	h, ok := hex4At(s, i)
	if !ok {
		return 0, 0, false
	}
	if h >= 0xD800 && h <= 0xDBFF { // high surrogate — try to pair with a following low one
		if l, ok := hex4At(s, i+6); ok && l >= 0xDC00 && l <= 0xDFFF {
			return 0x10000 + (rune(h)-0xD800)<<10 + (rune(l) - 0xDC00), 12, true
		}
	}
	return rune(h), 6, true
}

// hex4At returns the value of a "\uXXXX" escape starting at s[i], or ok=false if
// s[i:] is not a backslash-u followed by four hex digits. JSON only ever emits a
// lowercase \u; the four hex digits may be either case.
func hex4At(s string, i int) (uint16, bool) {
	if i+6 > len(s) || s[i] != '\\' || s[i+1] != 'u' {
		return 0, false
	}
	var v uint16
	for j := i + 2; j < i+6; j++ {
		var d uint16
		switch c := s[j]; {
		case c >= '0' && c <= '9':
			d = uint16(c - '0')
		case c >= 'a' && c <= 'f':
			d = uint16(c-'a') + 10
		case c >= 'A' && c <= 'F':
			d = uint16(c-'A') + 10
		default:
			return 0, false
		}
		v = v<<4 | d
	}
	return v, true
}

// toolNameOf returns the tool name embedded in a match key — the segment before
// the "::" separator makeMCPMatchKey writes. Tool names never contain "::", so
// the split is unambiguous. The router uses it as a HARD wall: the arg-drift
// fallback may pair a result with a same-name parked call, but NEVER one of a
// different name, because crossing tool types is silent corruption.
func toolNameOf(key mcpMatchKey) string {
	if i := strings.Index(string(key), "::"); i >= 0 {
		return string(key)[:i]
	}
	return string(key)
}

// newControlProtocol constructs the dispatcher attached to a specific
// stdin writer. Maps are pre-sized for the typical case (handful of
// pending tool calls + an initialize).
func newControlProtocol(stdin io.Writer) *controlProtocol {
	cp := &controlProtocol{
		stdin:      stdin,
		pendingOut: make(map[string]chan *ControlResponseBody, 4),
		cmds:       make(chan func()),
		quit:       make(chan struct{}),
		done:       make(chan struct{}),
	}
	go cp.run()
	return cp
}

// run is the actor loop: it owns all controlProtocol state and serialises
// every command. Exits (closing done) when teardown closes quit.
func (cp *controlProtocol) run() {
	defer close(cp.done)
	for {
		select {
		case fn := <-cp.cmds:
			fn()
		case <-cp.quit:
			return
		}
	}
}

// runOnActor runs fn on the actor goroutine and blocks until it completes, returning
// true. Returns false without running fn if the actor has already been torn
// down. Deadlock-free: cmds is unbuffered, so a completed send means the actor
// received fn and will execute it (closing the local done) before re-entering
// its select — there is no path where a received closure goes unrun.
func (cp *controlProtocol) runOnActor(fn func()) bool {
	done := make(chan struct{})
	select {
	case cp.cmds <- func() { fn(); close(done) }:
		<-done
		return true
	case <-cp.quit:
		return false
	}
}

// nextRequestID generates a unique request_id for an outbound
// control_request. Mirrors the SDK's `req_<counter>_<hex>` shape so log
// lines from both sides look uniform.
func (cp *controlProtocol) nextRequestID() string {
	n := cp.reqCounter.Add(1)
	var rnd [4]byte
	_, _ = readRandom(rnd[:])
	return fmt.Sprintf("req_%d_%x", n, rnd)
}

// readRandom fills b with cryptographically-secure random bytes. Uses
// crypto/rand so it works on every platform — the old /dev/urandom open
// produced zero bytes on Windows, collapsing request-id suffixes. Failures
// degrade to whatever's in the buffer, which for our request-id
// collision-avoidance use is harmless.
func readRandom(b []byte) (int, error) {
	return rand.Read(b)
}

// writeLine serialises one JSON value as a single line on the CLI's
// stdin. Trailing newline is appended; partial writes are not split so
// the CLI's scanner sees a whole envelope per Scan(). Callers run on the
// actor goroutine, which guarantees no concurrent writeLine.
func (cp *controlProtocol) writeLine(v any) error {
	buf, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("marshal control message: %w", err)
	}
	buf = append(buf, '\n')
	return cp.writeRaw(buf)
}

// stdinWriteError marks a failure to put bytes on the CLI's stdin. The pipe
// breaks only when the far end has stopped reading it, and the CLI reads its
// stdin for as long as it lives — so a caller that owns a turn reads this as
// "the process is gone", not as an I/O detail. See Client.cliBootError.
type stdinWriteError struct{ err error }

func (e *stdinWriteError) Error() string { return "write stdin: " + e.err.Error() }

func (e *stdinWriteError) Unwrap() error { return e.err }

// writeRaw is the single low-level stdin write path. Both control envelopes
// (via writeLine) and user-message deltas (via Client.writeStdinDelta) funnel
// through here so one owner serialises all stdin traffic and keeps JSON-lines
// whole. payload must already be newline-terminated.
func (cp *controlProtocol) writeRaw(payload []byte) error {
	n, err := cp.stdin.Write(payload)
	if err != nil {
		return &stdinWriteError{err}
	}
	if n != len(payload) {
		return &stdinWriteError{io.ErrShortWrite}
	}
	return nil
}

// sendInitialize emits the SDK→CLI initialize control_request without
// waiting for the response. We intentionally do not block: the CLI
// processes stdin in order, so sending initialize followed by the first
// user message is well-defined whether or not we read the ack. The CLI's
// control_response will arrive on stdout and the parser routes it to
// handleControlResponse, which silently drops untracked replies. The body
// is empty: the handshake carries no hooks, agents, or skills config.
func (cp *controlProtocol) sendInitialize() error {
	var err error
	cp.runOnActor(func() { err = cp.sendInitializeLocked() })
	return err
}

// writeUserDelta writes a user-message stream-json payload to the CLI's stdin
// through the actor, so user-message writes can never interleave with control
// envelopes the actor emits (the stdin single-writer invariant). payload must
// already be newline-terminated.
func (cp *controlProtocol) writeUserDelta(payload []byte) error {
	var err error
	if !cp.runOnActor(func() { err = cp.writeRaw(payload) }) {
		return fmt.Errorf("control protocol torn down")
	}
	return err
}

func (cp *controlProtocol) sendInitializeLocked() error {
	envelope := StreamMessage{
		Type:      "control_request",
		RequestID: cp.nextRequestID(),
		Request:   &ControlRequestBody{Subtype: "initialize"},
	}
	return cp.writeLine(envelope)
}

// handleControlRequest processes one inbound control_request from the
// CLI. Returns an error only if the dispatch encountered a programming
// bug; protocol-level errors are sent as control_response{error:...} so
// the CLI sees them. Caller should pass the same controlProtocol state
// that owns the stdin writer.
func (cp *controlProtocol) handleControlRequest(msg *StreamMessage) error {
	var err error
	cp.runOnActor(func() { err = cp.handleControlRequestLocked(msg) })
	return err
}

func (cp *controlProtocol) handleControlRequestLocked(msg *StreamMessage) error {
	if msg == nil || msg.Request == nil {
		return cp.sendControlError(msg.RequestID, "malformed control_request: missing request body")
	}
	body := msg.Request
	switch body.Subtype {
	case "mcp_message":
		return cp.handleMCPMessageLocked(msg.RequestID, body)
	default:
		// Unknown subtypes are non-fatal; we acknowledge with an error
		// response so the CLI doesn't park forever.
		jlog.Debug("control_request: unhandled subtype %q (request_id=%s)", body.Subtype, msg.RequestID)
		return cp.sendControlError(msg.RequestID, fmt.Sprintf("unsupported subtype: %s", body.Subtype))
	}
}

// handleMCPMessage dispatches the JSONRPC method inside an mcp_message
// control_request. initialize and tools/list are answered synchronously
// here; tools/call is recorded as pending and the control_response is
// emitted later by deliverNextToolResult once the worker hands us the result.
//
// tools list is delivered by reading the live session's MCP tool
// definitions. Caller (parser) supplies them via setTools.
func (cp *controlProtocol) handleMCPMessageLocked(requestID string, body *ControlRequestBody) error {
	var jrpc JSONRPCMessage
	if err := json.Unmarshal(body.Message, &jrpc); err != nil {
		return cp.sendControlError(requestID, fmt.Sprintf("malformed mcp_message: %v", err))
	}

	switch jrpc.Method {
	case "initialize":
		return cp.respondJSONRPC(requestID, jrpc.ID, mcpInitializeResult())
	case "tools/list":
		if cp.tools == nil {
			return cp.respondJSONRPCError(requestID, jrpc.ID, -32603, "no tools registered for session")
		}
		tools, err := cp.tools()
		if err != nil {
			return cp.respondJSONRPCError(requestID, jrpc.ID, -32603, err.Error())
		}
		return cp.respondJSONRPC(requestID, jrpc.ID, MCPToolsListResult{Tools: tools})
	case "tools/call":
		return cp.recordPendingToolCallLocked(requestID, jrpc)
	default:
		return cp.respondJSONRPCError(requestID, jrpc.ID, -32601, "method not found: "+jrpc.Method)
	}
}

// recordPendingToolCallLocked parks a CLI tools/call. It is answered later by
// deliverNextToolResult — or immediately, if a result was already stashed (the
// common result-before-call order, since the worker executes tools off the
// stream), draining the oldest stash that matches this call by (name+args) key,
// then by same tool name (arg-drift). It NEVER drains a stash of a different
// tool: a cross-type answer is silent corruption, so the call waits instead.
func (cp *controlProtocol) recordPendingToolCallLocked(requestID string, jrpc JSONRPCMessage) error {
	var params MCPToolsCallParams
	if err := json.Unmarshal(jrpc.Params, &params); err != nil {
		return cp.respondJSONRPCError(requestID, jrpc.ID, -32602, fmt.Sprintf("bad params: %v", err))
	}
	// A pause (noteToolUsePause) closed the previous round's tool emission, so
	// this park is the first call of the NEXT round — open a new generation
	// before stamping it. See currentGeneration for why the boundary is the park
	// after the pause, not the pause itself.
	if cp.roundClosed {
		cp.openNewGenerationLocked()
	}
	toolName := canonicalToolName(params.Name)
	call := pendingMCPCall{requestID: requestID, jsonrpcID: jrpc.ID, key: makeMCPMatchKey(toolName, params.Arguments), generation: cp.currentGeneration}

	// Exact (name+args) match, FIFO: drain the oldest stash with this key.
	if i := cp.stashIndexByKey(call.key); i >= 0 {
		result := cp.takeStashLocked(i)
		jlog.Debug("control_request: tools/call name=%s requestID=%s — answering from stashed result", toolName, requestID)
		return cp.answerCallLocked(call, result)
	}
	// No exact key. A same-NAME stash is arg-drift across a resume/restart (the
	// same logical call, args re-serialised to different bytes) — drain the oldest
	// so the call doesn't hang, logged loudly. A different-name stash is NEVER
	// drained: the call waits for its own result rather than absorb a foreign one.
	if i := cp.stashIndexByName(toolName); i >= 0 {
		stashed := cp.stashedResults[i]
		ambiguous := cp.countStashByName(toolName) > 1
		result := cp.takeStashLocked(i)
		logToolDivergence(ambiguous, "tool/request divergence: CLI parked %q but stash recorded %q — same tool, args drifted across a resume/restart; answering by position so the turn proceeds", call.key, stashed.key)
		return cp.answerCallLocked(call, result)
	}
	cp.parkedCalls = append(cp.parkedCalls, call)
	jlog.Debug("control_request: parked tools/call key=%q requestID=%s queue=%d stash=%d", call.key, requestID, len(cp.parkedCalls), len(cp.stashedResults))
	return nil
}

// deliverNextToolResult answers the oldest parked call matching this result by
// (name+args) key, then — for arg-drift — by the oldest parked call of the SAME
// tool name. It NEVER answers a call of a different tool: that is silent
// corruption. If no same-tool call is parked yet (the common result-before-call
// order) the result is stashed for the eventual park to drain. Cross-turn
// staleness is filtered upstream (extractToolResults), so only current-turn
// results reach here and the FIFO pairing cannot be poisoned by a prior turn.
func (cp *controlProtocol) deliverNextToolResult(recordedKey mcpMatchKey, result *provider.ToolResult) (ok bool, err error) {
	if !cp.runOnActor(func() { ok, err = cp.deliverNextToolResultLocked(recordedKey, result) }) {
		return false, fmt.Errorf("control protocol torn down")
	}
	return ok, err
}

func (cp *controlProtocol) deliverNextToolResultLocked(recordedKey mcpMatchKey, result *provider.ToolResult) (bool, error) {
	// Mark that the current round produced a delivery, so a subsequent
	// openNewGenerationLocked knows this round resolved (see openNewGenerationLocked's
	// invariant check). Set on entry — stash or match, the worker IS delivering
	// for this round.
	cp.deliveredSinceGenAdvance = true
	// Exact (name+args) match, FIFO among same-key: the worker feeds results in
	// pendingTools (stream) order and the CLI parks in that same order, so the
	// oldest same-key parked call is the right one — including two identical calls
	// in one turn, which pair in arrival order.
	if i := cp.parkedIndexByKey(recordedKey); i >= 0 {
		call := cp.takeParkedLocked(i)
		return true, cp.answerCallLocked(call, result)
	}
	// No exact key. Answer the oldest parked call of the SAME tool name (arg-drift
	// across a resume/restart). NEVER cross tool names: a different-tool call is
	// left parked rather than handed this result (silent corruption).
	if i := cp.parkedIndexByName(toolNameOf(recordedKey)); i >= 0 {
		ambiguous := cp.countParkedByName(toolNameOf(recordedKey)) > 1
		call := cp.takeParkedLocked(i)
		logToolDivergence(ambiguous, "tool/request divergence: worker recorded %q but CLI parked %q — same tool, args drifted across a resume/restart; answering by position so the turn proceeds", recordedKey, call.key)
		return true, cp.answerCallLocked(call, result)
	}
	// No same-tool call is parked yet (result-before-call race): stash, tagged
	// with its key and the current round's generation, for the eventual park to
	// drain. A park from a LATER round won't drain it (generation mismatch).
	//
	// If the round has already closed (the stop_reason=tool_use pause was processed
	// before this round's tools/call parked — the production order under multi-CLI
	// load, where the always-on reader is starved while the worker races ahead and
	// delivers a fast tool's result first), this stash is the FIRST event of the new
	// round, exactly as a park would be. It must therefore open the new generation
	// ITSELF — symmetric to recordPendingToolCallLocked's roundClosed handling.
	// Otherwise the park that follows opens a generation PAST this stash, the two
	// land in different generations, and they never pair: the CLI hangs on the
	// unanswered tools/call until teardown error-releases it (the idle-window
	// "stream stalled" → "conversation session ended"). The match attempts above
	// run at the current generation FIRST, so the normal park-then-pause-then-deliver
	// order still answers the already-parked call without advancing.
	if cp.roundClosed {
		cp.openNewGenerationLocked()
		cp.deliveredSinceGenAdvance = true // this stash IS the new round's delivery
	}
	cp.stashedResults = append(cp.stashedResults, stashedResult{key: recordedKey, result: result, generation: cp.currentGeneration})
	jlog.Debug("deliverNextToolResult: no matching parked call yet — stashed key=%q (queue=%d, parked=%d)", recordedKey, len(cp.stashedResults), len(cp.parkedCalls))
	return true, nil
}

// parkedIndexByKey / parkedIndexByName / stashIndexByKey / stashIndexByName
// return the index of the oldest entry matching by exact key or by tool name,
// or -1. The name finders are the arg-drift fallback and never cross tool types.
// All four are scoped to the CURRENT generation: an entry from an earlier tool
// round (a stale orphan) is invisible to matching, so a later round's result
// can never be paired with it — only swept at end_turn by discardStaleBuffers.
func (cp *controlProtocol) parkedIndexByKey(key mcpMatchKey) int {
	for i := range cp.parkedCalls {
		if cp.parkedCalls[i].generation == cp.currentGeneration && cp.parkedCalls[i].key == key {
			return i
		}
	}
	return -1
}

func (cp *controlProtocol) parkedIndexByName(name string) int {
	for i := range cp.parkedCalls {
		if cp.parkedCalls[i].generation == cp.currentGeneration && toolNameOf(cp.parkedCalls[i].key) == name {
			return i
		}
	}
	return -1
}

func (cp *controlProtocol) stashIndexByKey(key mcpMatchKey) int {
	for i := range cp.stashedResults {
		if cp.stashedResults[i].generation == cp.currentGeneration && cp.stashedResults[i].key == key {
			return i
		}
	}
	return -1
}

func (cp *controlProtocol) stashIndexByName(name string) int {
	for i := range cp.stashedResults {
		if cp.stashedResults[i].generation == cp.currentGeneration && toolNameOf(cp.stashedResults[i].key) == name {
			return i
		}
	}
	return -1
}

// countParkedByName / countStashByName count current-generation entries sharing
// a tool name. The arg-drift positional fallback is UNAMBIGUOUS only when the
// count is 1: the single same-tool entry must be this call's partner, so the
// pairing is benign regeneration drift. With two or more same-tool entries the
// FIFO pick could mis-pair concurrent calls (two reads of different files swap
// results) — that is the genuinely dangerous case worth an ERROR. See
// logToolDivergence.
func (cp *controlProtocol) countParkedByName(name string) int {
	n := 0
	for i := range cp.parkedCalls {
		if cp.parkedCalls[i].generation == cp.currentGeneration && toolNameOf(cp.parkedCalls[i].key) == name {
			n++
		}
	}
	return n
}

func (cp *controlProtocol) countStashByName(name string) int {
	n := 0
	for i := range cp.stashedResults {
		if cp.stashedResults[i].generation == cp.currentGeneration && toolNameOf(cp.stashedResults[i].key) == name {
			n++
		}
	}
	return n
}

// logToolDivergence reports an arg-drift positional fallback at a severity that
// matches the actual risk. When ambiguous (two or more same-tool entries
// competed, so the FIFO pick could be wrong) it is a real mis-pairing hazard and
// logs at ERROR. When a single same-tool entry made the pairing unambiguous it
// is benign regeneration drift — the same logical call re-serialised to
// different bytes across a resume/restart — and logs at INFO so it stays visible
// without reading as a fault.
func logToolDivergence(ambiguous bool, format string, args ...any) {
	if ambiguous {
		jlog.Error(format, args...)
		return
	}
	jlog.Info(format, args...)
}

// noteToolUsePause latches that the stream paused on stop_reason=tool_use — the
// current round's tool emission is complete. It does NOT advance the generation
// itself: the real CLI emits a round's tools/call BEFORE this pause, so advancing
// here would strand the just-parked calls (see currentGeneration). The latch is
// consumed by openNewGenerationLocked when the NEXT round's first call parks.
// Runs on the actor like every other mutator.
func (cp *controlProtocol) noteToolUsePause() {
	cp.runOnActor(func() { cp.roundClosed = true })
}

// openNewGenerationLocked advances the tool-round counter at the boundary between
// rounds — the first tools/call park after a pause (recordPendingToolCallLocked,
// gated by roundClosed). Callers hold the actor.
//
// It also runs the out-of-band detector (doc.go's "Tool-delivery desync"
// tripwire): if a new round opens while prior-generation calls are still parked
// AND nothing was delivered for them (deliveredSinceGenAdvance false), the CLI
// opened a tool round while blocked on a parked call — impossible per its
// execution model, so unrecoverable; we log it loudly and count it rather than
// strand the call silently. A normal lingering orphan does NOT trip this: a
// delivery happened that round, so deliveredSinceGenAdvance is true.
func (cp *controlProtocol) openNewGenerationLocked() {
	if !cp.deliveredSinceGenAdvance && cp.hasParkedInGenerationLocked(cp.currentGeneration) {
		cp.outOfBandRounds++
		jlog.Error("claudecode tool-routing invariant violated: a new tool round (generation %d→%d) opened while tool call(s) from the previous round are still parked and no result was delivered for them — the CLI emitted a tool_use turn while blocked on a parked tools/call, which its execution model should forbid (an out-of-band / autonomous tool turn?). The advancing generation hides the parked call(s) from delivery; they will be stranded and error-released at end_turn, and this turn's tool delivery may be mispaired.",
			cp.currentGeneration, cp.currentGeneration+1)
	}
	cp.currentGeneration++
	cp.roundClosed = false
	cp.deliveredSinceGenAdvance = false
}

// hasParkedInGenerationLocked reports whether any parked call carries the given
// generation. Callers hold the actor.
func (cp *controlProtocol) hasParkedInGenerationLocked(gen int) bool {
	for i := range cp.parkedCalls {
		if cp.parkedCalls[i].generation == gen {
			return true
		}
	}
	return false
}

// outOfBandRoundCount returns how many out-of-band tool rounds openNewGenerationLocked
// has detected this session (always 0 unless the CLI violated the
// blocked-while-parked invariant). Actor-read so it is race-free against the
// reader goroutine that mutates the counter.
func (cp *controlProtocol) outOfBandRoundCount() int {
	var n int
	cp.runOnActor(func() { n = cp.outOfBandRounds })
	return n
}

// takeParkedLocked / takeStashLocked remove and return the entry at idx,
// preserving FIFO order of the remaining entries.
func (cp *controlProtocol) takeParkedLocked(idx int) pendingMCPCall {
	call := cp.parkedCalls[idx]
	cp.parkedCalls = append(cp.parkedCalls[:idx:idx], cp.parkedCalls[idx+1:]...)
	return call
}

func (cp *controlProtocol) takeStashLocked(idx int) *provider.ToolResult {
	result := cp.stashedResults[idx].result
	cp.stashedResults = append(cp.stashedResults[:idx:idx], cp.stashedResults[idx+1:]...)
	return result
}

// answerCallLocked writes the control_response for one parked call.
func (cp *controlProtocol) answerCallLocked(call pendingMCPCall, result *provider.ToolResult) error {
	mcpResp, err := mcpToolsCallSuccess(call.jsonrpcID, result.Content, result.Parts, result.ResultStatus.IsError() || result.ResultStatus.VetosContinuation())
	if err != nil {
		return fmt.Errorf("encode tools/call response: %w", err)
	}
	return cp.sendControlSuccess(call.requestID, mcpResp)
}

// respondJSONRPC writes a control_response wrapping a successful JSONRPC
// envelope. Used for initialize and tools/list dispatches.
func (cp *controlProtocol) respondJSONRPC(requestID string, jrpcID json.RawMessage, result any) error {
	mcpResp, err := jsonrpcSuccess(jrpcID, result)
	if err != nil {
		return fmt.Errorf("encode jsonrpc success: %w", err)
	}
	return cp.sendControlSuccess(requestID, mcpResp)
}

// respondJSONRPCError writes a control_response wrapping a JSONRPC error
// envelope. Used when our handlers detect a malformed request or can't
// satisfy it.
func (cp *controlProtocol) respondJSONRPCError(requestID string, jrpcID json.RawMessage, code int, message string) error {
	mcpResp, err := jsonrpcFailure(jrpcID, code, message)
	if err != nil {
		return fmt.Errorf("encode jsonrpc error: %w", err)
	}
	return cp.sendControlSuccess(requestID, mcpResp)
}

// sendControlSuccess writes a control_response envelope with subtype
// success. The mcpResp payload (raw JSONRPC envelope, when applicable)
// goes in response.mcp_response per the SDK's convention.
func (cp *controlProtocol) sendControlSuccess(requestID string, mcpResp json.RawMessage) error {
	wrapper, err := json.Marshal(map[string]any{"mcp_response": json.RawMessage(mcpResp)})
	if err != nil {
		return fmt.Errorf("marshal mcp_response wrapper: %w", err)
	}
	env := StreamMessage{
		Type: "control_response",
		Response: &ControlResponseBody{
			Subtype:   "success",
			RequestID: requestID,
			Response:  wrapper,
		},
	}
	return cp.writeLine(env)
}

// sendControlError writes a control_response with subtype error.
func (cp *controlProtocol) sendControlError(requestID, message string) error {
	env := StreamMessage{
		Type: "control_response",
		Response: &ControlResponseBody{
			Subtype:   "error",
			RequestID: requestID,
			Error:     message,
		},
	}
	return cp.writeLine(env)
}

// handleControlResponse matches an inbound control_response to its
// outbound control_request by request_id and delivers it to the parked
// caller via the per-request channel. Silently dropped if no caller is
// waiting (e.g. timed out).
func (cp *controlProtocol) handleControlResponse(msg *StreamMessage) {
	cp.runOnActor(func() { cp.handleControlResponseLocked(msg) })
}

func (cp *controlProtocol) handleControlResponseLocked(msg *StreamMessage) {
	if msg == nil || msg.Response == nil {
		return
	}
	ch, ok := cp.pendingOut[msg.Response.RequestID]
	if !ok {
		jlog.Debug("control_response: no pending request for id=%s", msg.Response.RequestID)
		return
	}
	delete(cp.pendingOut, msg.Response.RequestID)
	select {
	case ch <- msg.Response:
	default:
	}
}

// discardStaleBuffers empties the parked-call and stashed-result queues at an
// LLM turn boundary, returning how many of each it cleared. By end_turn every
// tool round is resolved, so anything still buffered is an ORPHAN; clearing it
// bounds any desync's blast radius to its own turn instead of poisoning the warm
// session (the desync backstop in doc.go's "Tool-delivery desync" section).
// Parked orphans are answered with an error first — stdio has no transport
// timeout, so an unanswered park hangs the CLI forever (as release teardown
// does); the stash is ours to drop silently. Unlike teardown the actor keeps
// running, so this goes through runOnActor like every other mutator.
func (cp *controlProtocol) discardStaleBuffers() (stashed, parked int) {
	cp.runOnActor(func() {
		stashed, parked = len(cp.stashedResults), len(cp.parkedCalls)
		// Per-orphan detail so a desync is attributable from the log alone. For an
		// orphaned stash, generation < currentGeneration means a generation SPLIT
		// (the result was stashed in an earlier round than the park that should
		// have drained it); generation == currentGeneration with no matching park
		// means a COUNT EXCESS (more results fed than calls parked — an upstream
		// duplicate/extra-result feed). Logged before the queues are cleared.
		for _, s := range cp.stashedResults {
			split := ""
			if s.generation != cp.currentGeneration {
				split = " (GENERATION SPLIT — stashed in an earlier round than current)"
			}
			jlog.Error("discardStaleBuffers: orphaned stashed result key=%q toolUseID=%s gen=%d currentGen=%d%s", s.key, s.result.ToolUseID, s.generation, cp.currentGeneration, split)
		}
		for _, call := range cp.parkedCalls {
			jlog.Error("discardStaleBuffers: orphaned parked call key=%q gen=%d currentGen=%d", call.key, call.generation, cp.currentGeneration)
			mcpResp, err := mcpToolsCallSuccess(call.jsonrpcID, "tool result not delivered before turn end (provider/CLI tool desync)", nil, true)
			if err != nil {
				jlog.Error("discardStaleBuffers: encode abort for requestID=%s: %v", call.requestID, err)
				continue
			}
			if err := cp.sendControlSuccess(call.requestID, mcpResp); err != nil {
				jlog.Debug("discardStaleBuffers: send abort for requestID=%s failed: %v", call.requestID, err)
			}
		}
		cp.parkedCalls = nil
		cp.stashedResults = nil
		// New turn starts clean: no round is mid-flight, so the first park of the
		// next turn parks at the current generation (no spurious advance) and a
		// stale flag can't false-trip the out-of-band detector.
		cp.roundClosed = false
		cp.deliveredSinceGenAdvance = false
	})
	return stashed, parked
}

// teardown stops the actor, releases anything waiting on a control_response so
// it observes the session ending instead of hanging forever, and drops the
// parked/stashed tool bookkeeping. Called from the session's tearDownLiveCLI
// path before the underlying stdin pipe is closed.
func (cp *controlProtocol) teardown() {
	// Never entered concurrently: the sole caller (activeSession.tearDownLiveCLI)
	// gates its whole body — this call included — behind teardownOnce, so the
	// check-then-close on cp.quit below cannot race. The guard stays as a cheap
	// safeguard against a future second direct call.
	select {
	case <-cp.quit:
		return
	default:
	}
	// Stop the actor and wait for it to exit; afterwards we are the sole
	// accessor of the maps, so closing the pending channels here is race-free.
	close(cp.quit)
	<-cp.done
	for id, ch := range cp.pendingOut {
		close(ch)
		delete(cp.pendingOut, id)
	}
	// Parked tools/call are abandoned in silence, deliberately. The CLI blocks on
	// stdin per pending tools/call and stdio has NO transport timeout (see
	// dispatch.go), but it is not left hanging on that: tearDownLiveCLI closes
	// stdin the moment this returns and SIGKILLs anything still alive after
	// teardownGracePeriod, so a blocked CLI unwinds either way.
	//
	// Answering them instead is what does damage. An error result is a delivered
	// result as far as the CLI is concerned: it journals it into its own session
	// file, displacing the dangling assistant tool_use that warm-append resumes
	// from (warm_append_resume.go), and — if it outlives us, as an orphan briefly
	// does — spends a full model turn replying to it, for nobody. All for a call
	// whose real result is about to be delivered by the process that takes over.
	for _, call := range cp.parkedCalls {
		jlog.Debug("teardown: abandoning parked tools/call key=%q requestID=%s (its result is delivered on resume)", call.key, call.requestID)
	}
	cp.parkedCalls = nil
	cp.stashedResults = nil
}
