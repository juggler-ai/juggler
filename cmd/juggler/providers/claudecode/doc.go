//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package claudecode wraps the Claude Code CLI (`claude`) as a juggler
// LLM provider. The CLI handles OAuth, so this provider needs no API key
// — Max-subscription auth flows through the binary.
//
// # Why a wrapper
//
// Other providers in juggler talk HTTP to Anthropic / OpenAI / Gemini APIs
// directly. Claude Code is different: it exposes its capability surface
// only through a local subprocess, and that subprocess speaks JSON-lines
// on stdio. This package's job is to translate juggler's StreamMessage
// contract into the CLI's wire protocol — same external shape as any
// other provider, with the per-subprocess plumbing hidden.
//
// # Wire protocol
//
// Every CLI invocation runs with --output-format stream-json
// --include-partial-messages, so its stdout is a stream of newline-
// delimited JSON envelopes:
//
//   - system / result: turn-start and turn-end metadata, usage, model info.
//   - stream_event: fine-grained Anthropic API events (message_start /
//     content_block_start / content_block_delta / content_block_stop /
//     message_delta / message_stop). parser.go re-assembles per-block
//     text, thinking, and tool_use chunks from these and emits them
//     incrementally through the StructuredStreamCallback.
//   - control_request / control_response / control_cancel_request:
//     bidirectional control channel, modelled after Anthropic's official
//     Claude Agent SDK. See "Control protocol" below.
//
// For input the CLI is always spawned with --input-format stream-json,
// which means *we* control its lifecycle bidirectionally: we write JSON
// lines to its stdin, it writes JSON lines to its stdout. The CLI keeps
// running between turns, parked on stdin reads.
//
// # Dispatch regimes
//
// regime.go's classifyRegime is the single decision point for
// StreamMessage dispatch. Three regimes:
//
//   - regimeStartFresh: spawn `claude -p --input-format stream-json`
//     (no --resume) for the first turn or whenever the prior session
//     diverged. We pipe user-role messages via stdin; assistant content
//     from prior turns is dropped (acceptable degradation — divergence
//     is rare and the alternative requires materialising a synthetic
//     session file on disk). The CLI generates a session id we capture
//     from system/init so the next turn can --resume.
//
//   - regimeResumeDelta: spawn (or reuse) `claude --resume <uuid>
//     --input-format stream-json` and pipe only the *new* messages on
//     stdin. The CLI re-reads its on-disk session for the warm prefix;
//     prompt-cache stays hot across turns.
//
//   - regimeContinue: a live CLI from a previous turn is parked mid-LLM-
//     turn awaiting tool results. continueSession feeds those results to
//     the parked CLI via the control protocol — no new spawn — and reads
//     the rest of the turn off the same stdio. Not taken when the system
//     prompt has changed since spawn: the CLI only reads --system-prompt at
//     start, so an edit made while it is parked routes to a fresh start.
//
// regimeResumeDelta with SoftReset=true is the user-interjection path:
// pending tool calls didn't get results before the user typed something
// new; we kill the parked CLI (preserving sessionUUID/sentCount/sentHash)
// and let resume-with-delta pipe [cancelled-tool-result, user-new] in one
// go. This keeps the cache warm across an aborted tool flow.
//
// # Control protocol
//
// The CLI multiplexes "control" messages (tool-execution callbacks, mid-
// session reconfiguration) on its regular stdout, distinguished only by
// the top-level type field. Routing lives in control_protocol.go:
//
//   - The CLI sends control_request{subtype:mcp_message} when it wants
//     to invoke an MCP tool. The inner JSONRPC envelope has the standard
//     MCP method (tools/list, tools/call). We implement those in-process
//     in mcp_inproc.go; no separate MCP HTTP server.
//
//   - For tools/call specifically, the response is *deferred*: we park
//     the call at the back of a consuming FIFO queue (parkedCalls in
//     control_protocol.go) and return immediately. The worker executes
//     the tool out-of-band (UI approval + frontend execution) and hands
//     us the result via the next StreamMessage's req.Messages.
//     continueSession then writes the control_response that unblocks the
//     parked CLI. Results are matched to calls by the stable tool_use_id,
//     falling back to the (name,args) key then FIFO position — see below.
//
//   - Outbound: we send control_request{subtype:initialize} once per
//     spawn, fire-and-forget. The CLI's response is acked but we don't
//     read its payload.
//
// Tool calls run over stdio rather than a per-client loopback MCP HTTP
// server, which sidesteps three HTTP pain points:
//
//   - No TCP-level request timeout. An MCP HTTP client gives up after
//     ~2 minutes, synthesizes a "tool timed out" result, and poisons the
//     session. Stdio has no transport timeout — the CLI patiently waits on
//     stdin for as long as the user takes to approve.
//
//   - No mispairing across tool types. The MCP tools/call payload carries
//     (name, arguments) but no tool_use_id, so the dispatcher routes a delivered
//     result to the parked call by (name+args) key, FIFO among same-key. The
//     worker feeds results in pendingTools (stream) order and the CLI parks in
//     that same order, so the oldest same-key call is the right one — including
//     two identical-(name,args) calls in one turn, which pair in arrival order.
//     When the key doesn't match exactly (arg-drift across a resume/restart: the
//     same logical call, args re-serialised to different bytes) the result goes
//     to the oldest parked call of the SAME TOOL NAME. The name-match is a HARD
//     wall: a result is NEVER delivered to a call of a different tool, because
//     crossing tool types is silent corruption (an agent reasons on, or re-runs,
//     the wrong output). A genuine no-match degrades to a recoverable wait
//     (teardown answers it with an error), never a wrong answer. Cross-turn
//     staleness is filtered upstream — extractToolResults only feeds results
//     whose tool_use_id is in the CURRENT turn's pendingTools, so a stale or
//     duplicate result from a prior turn never reaches the router. Done locally
//     in the dispatcher where it can't race across an HTTP buffer.
//
//   - No connection-lifecycle complexity. No HTTP server to spawn, no
//     per-conversation port, no shutdown ordering between handler and
//     subprocess. The CLI subprocess owns its own end of the pipe and
//     teardown is identical to any subprocess teardown.
//
// # Tool-delivery desync: cure vs. defenses
//
// Everything in this section is a workaround for ONE missing field: the MCP
// tools/call wire frame carries no tool_use_id. The CLI says "call `bash` with
// these args", not "this is the block the assistant labelled toolu_123". So a
// delivered worker result is routed back to a parked call by (name+args) key,
// FIFO among same-key, with a same-tool-name fallback for arg-drift across a
// resume/restart (makeMCPMatchKey / deliverNextToolResult, control_protocol.go).
// That router is correct as long as the parked calls and the delivered results
// stay in lockstep. The desync class is everything that knocks them out of
// lockstep, and the genesis is always one shape: a SECOND result is fed for a
// tool whose call was already answered, so it has no call to pair with and
// becomes an orphan a later same-tool call can drain by the name fallback — the
// model then reasons on a different call's output.
//
// That duplicate comes from an engine reattach. A tool can sit in state=running
// with no result in the doc while the worker has ALREADY fed a placeholder
// result for it this turn (the auto-continue race, worker/llm_request.go
// buildMessages). If the engine reattaches mid-turn and blindly re-drives every
// running tool, it re-executes that tool and re-feeds its real result.
//
// Five guards — one cure, four defenses:
//
//   - resultFedTurn (CURE — worker/llm_request.go stamps it; honoured by
//     resetRunningToolsForReattach in worker/message_handlers.go). Reattach skips
//     re-executing a tool whose result was already fed this turn, removing the
//     duplicate at source: no re-execution, no second result. TestReattach_* in
//     package worker is the authoritative repro — the genesis is only
//     constructible worker-side, since the provider's extractToolResults already
//     filters feeds to the current pendingTools.
//
//   - fedResultIDs (defense — dispatch.go continueSession). Per-turn set of fed
//     tool_use_ids; a second feed of the same id is dropped before it reaches the
//     router. With the cure in place no duplicate re-feed reaches this path in
//     any REACHABLE flow, so it is a pure backstop against a future re-feed
//     vector (see TestReattach_SkipsToolWhoseResultDeliveredThisTurn).
//
//   - generation scoping (defense — currentGeneration et al, control_protocol.go).
//     Each tool ROUND has a generation index; parked calls and stashed results
//     pair only within the same generation. This bounds a desync to its round —
//     a call left parked from an earlier round can't be drained by a later
//     round's same-tool result. It fixes a real multi-round mis-pairing bug,
//     independent of the reattach genesis. A round stays open while any of its
//     calls is still parked (the CLI cannot start the next one), so a delivery
//     never opens a generation past a parked call — otherwise an orphan that
//     drained one of a round's parks would strand the rest of that round.
//
//   - discardStaleBuffers (backstop — control_protocol.go, called at finalizeTurn).
//     At end_turn every round is resolved, so anything still parked/stashed is an
//     orphan; clearing it (parked calls answered with an error first — stdio has
//     no transport timeout) bounds any desync's blast radius to its own turn
//     rather than poisoning the warm session.
//
//   - releaseStrandedCalls (recovery — parser.go / control_protocol.go). The
//     backstop above needs end_turn, and a desync that strands a call the CLI is
//     blocked on means end_turn never comes. While a read loop runs every result
//     for the turn is already delivered, so a call still parked after
//     strandedCallGrace with no model output will never be answered: the read
//     loop answers it — with its own result if one is stashed under another
//     generation, else with an error the model can act on — and the turn goes on.
//     It catches desyncs of shapes nobody has seen yet, which is its point.
//
// canonicalizeScalars (makeMCPMatchKey) is NOT a desync guard: it collapses
// scalar TYPE drift (40 vs "40") so exact-key routing survives a resume/restart
// re-serialisation instead of degrading to the lossy positional fallback.
//
// Generation scoping also carries an out-of-band detector
// (deliveredSinceGenAdvance / outOfBandRounds) as a tripwire for the day the
// CLI's execution model changes: if a new round opens while a prior round's call
// is still parked AND nothing was delivered for it, the CLI emitted a tool turn
// while blocked on a parked call — impossible today, hence unrecoverable, so it
// is logged loudly
// and counted (outOfBandRounds) rather than stranding a call silently. Kept
// deliberately: deliveredSinceGenAdvance is also what gives the detector its
// specificity (a normal round that leaves a lingering orphan does NOT trip it),
// and an assertable counter is worth more than a bare log given how long silent
// tool-desync bugs have historically taken to find.
//
// # Sessions, persistence, and the cache
//
// activeSession (cli_lifecycle.go) tracks per-conversation state across
// turns:
//
//   - sessionUUID: captured from the CLI's system/init event on first
//     turn; passed as --resume <uuid> on every subsequent turn so the
//     CLI loads its on-disk transcript and the upstream prompt-cache
//     stays warm.
//   - heldCount: the full req.Messages extent accepted by a complete stdin
//     write. Any later request shorter than this projection must cold-start.
//   - sentCount / sentHash / element hashes: the stable decision prefix. The
//     element hashes are authoritative for compatibility; sentHash remains for
//     old sidecars and telemetry. The decision prefix excludes only trailing
//     volatile context, and is where the next warm delta begins.
//   - pendingTools: tool_use blocks the LLM has emitted but the worker
//     hasn't delivered results for yet. continueSession reconciles these
//     against tool-result messages in req.Messages.
//   - control: the stdio control protocol dispatcher (see above).
//
// session_persistence.go writes a per-conversation sidecar
// (`.juggler/<conv>/claude_session.json`) as soon as a complete request write
// is consumed when a UUID is known, and refreshes response metadata at pause or
// end_turn. Old sidecars without heldCount or element hashes load conservatively
// through sentCount / sentHash.
//
// # Cancellation
//
// session_manager.go registers CancelConversation as the registry-side
// canceller; the worker invokes it on every user-initiated cancel (Escape) —
// mid-stream, parked on approvals, or with tools genuinely in flight. Cancel
// is always warm-preserving: kill the live CLI subprocess but keep the persisted
// projection, which was advanced when the complete request write succeeded, so
// the next turn resumes only when its history is compatible. A cancel is an
// interrupt, not a session invalidation.
//
// Dropping a session (dropSession: delete UUID + sidecar, next turn cold-starts)
// is reserved for the provider's own detect-corruption paths — a malformed
// tool_use stop with no ids (dispatch.go) and hard turn errors — where the
// stored anchor is no longer safe to resume. It is never reached via a cancel.
//
// Teardown order in tearDownLiveCLI matters and is documented inline:
// release control-protocol waiters → close stdin (EOF, giving the CLI
// a graceful-shutdown window to flush its session file) → wait
// teardownGracePeriod → SIGKILL if needed → drain stdout → reap.
//
// # Model surface
//
// model_info.go exposes the Claude model family (sonnet / opus / haiku /
// fable).
// ListModelsWithInfo returns hardcoded defaults that the self-update path
// overwrites every turn from the CLI's modelUsage report — so the numbers
// stay current without us tracking Anthropic's release notes.
//
// # Native tool conversion
//
// message_format.go strips the CLI's mcp__juggler__ prefix from tool
// names on the way out and translates the CLI's built-in tool names
// (Read / Edit / Write / Bash / Grep) into juggler's equivalents
// (read_file / edit_file / write_file / execute_command / grep) so the
// worker speaks one consistent vocabulary regardless of which tool the
// LLM picked. We pass --disallowedTools for the built-ins and
// --allowedTools mcp__juggler__* so the CLI prefers our versions, but
// the conversion is a defensive belt-and-braces.
//
// # File map
//
//   - client.go: Client struct, NewClient, StreamMessage entry point.
//   - conversation.go: per-conversation handle (provider.Conversation);
//     owns the per-thread session map + idle reaper behind one goroutine.
//   - dispatch.go: regime entry functions + finalizeTurn bookkeeping.
//   - reader.go: continuous stdout demux (control frames vs content) for
//     one persistent CLI session.
//   - autonomous_turn.go: between-Submit drain that surfaces turns the CLI
//     emits with no Submit in flight.
//   - parser.go: stdout JSON-line parser and turn read loop.
//   - stream_events.go: stream-event state machine, one function per
//     Anthropic event type (handleStreamEvent dispatches).
//   - protocol.go: wire-format types (CLI envelopes + control protocol).
//   - control_protocol.go: stdio control dispatcher + outbound writer.
//   - mcp_inproc.go: in-process MCP responses (initialize / tools/list /
//     tools/call envelopes).
//   - regime.go: classifyRegime + the predicates it depends on
//     (continuationCovers, userInterjectedAfterPendingTools,
//     canResumeWithDelta).
//   - synthetic_resume.go: materialise prior turns as a CLI session JSONL
//     so a cold start can --resume without losing assistant history.
//   - concurrency.go: process-wide semaphore bounding concurrently-
//     streaming CLI turns.
//   - cli_lifecycle.go: activeSession + spawn/teardown.
//   - session_manager.go: registry hook (Register) + model-info actor init.
//   - session_persistence.go: disk sidecar.
//   - model_info.go: model spec cache, Info, ListModelsWithInfo.
//   - message_format.go: CLI input formatting, common args,
//     buildMCPConfig.
//   - helpers.go: prefix hashing, cache constants, log formatters.

package claudecode
