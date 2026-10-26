//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync/atomic"
	"time"

	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/jlog"
)

const cacheMissWarningTokens int64 = 25_000

// Client implements the provider.Provider interface using Claude Code CLI.
// Tool execution flows back through the stdio control protocol, not a
// per-client HTTP MCP server. See control_protocol.go for the
// dispatcher that fields the CLI's mcp_message control_requests.
type Client struct {
	model      string
	workingDir string // where the CLI spawns: the bound workspace, or the project
	stateDir   string // the project: where OUR per-conversation files live, wherever the CLI runs

	threadID      string         // "" = root thread; sub-threads are in-memory only (no disk sidecar)
	activeSession *activeSession // Persisted between StreamMessage calls for continuation

	// own is the single-owner token for activeSession: a 1-buffered channel
	// pre-loaded with exactly one token. Whoever holds the token is the sole
	// goroutine permitted to mutate activeSession (and the live-CLI fields it
	// owns). A streaming turn holds it for its whole duration; Cancel/Close
	// first interrupt the in-flight turn (so it unwinds and releases the token)
	// then take the token to tear down. This makes activeSession single-owner
	// across the turn goroutine and the conversationCache-actor goroutine
	// without a mutex (channels, per the project concurrency rule). Initialised
	// by NewClient; the test-only direct &Client{} builds never stream/cancel.
	own chan struct{}
	// turnInterrupt holds the in-flight turn's context-cancel func so Cancel /
	// Close can make the owning turn unwind and release `own` promptly. nil
	// between turns.
	turnInterrupt atomic.Pointer[context.CancelFunc]

	// consecutiveStalls counts how many turn attempts in a row have failed with
	// a transient stall/exit (the resumed CLI produced no terminal turn). It is
	// reset to zero by any successful or definitively-failed turn. When it
	// reaches maxConsecutiveStallsBeforeColdStart the next dispatch ABANDONS the
	// stored --resume uuid and cold-starts fresh: a session whose --resume keeps
	// stalling is wedged on the CLI side (a backed-up stdin queue or a corrupt
	// resume transcript), and re-resuming it every turn leaves the user staring
	// at "receiving…" forever. Mutated only under the `own` token (single turn at
	// a time), so a plain int is safe — no mutex (project concurrency rule).
	consecutiveStalls int

	// turnWaitingDescription is the spinner label the parser emits at system/init —
	// the moment the freshly-spawned CLI has booted and the otherwise-silent
	// prompt-ingestion wait begins. dispatchTurn resets it to activityWaiting each
	// turn; startFreshSession overrides it to activityProcessingHistory for a cold
	// start that carries prior history, so the long cache-miss wait reads as
	// purposeful instead of a generic "Waiting…". Mutated only under the `own`
	// token (single turn at a time) and read on the same turn goroutine, so a
	// plain string is safe — no mutex (project concurrency rule).
	turnWaitingDescription string

	// thinkingLevel is the canonical thinking level of the turn currently being
	// dispatched (normalized; "" ⇒ provider default). Set at the top of
	// dispatchTurn from req.ThinkingLevel and read by spawnCLIPipes to inject
	// MAX_THINKING_TOKENS. spawnedThinkingLevel records the level the live CLI
	// was actually spawned with, so a turn whose level differs recycles the CLI
	// (the budget is read once at spawn, not per-message). Both mutated only
	// under the `own` token (single turn at a time), so plain fields are safe —
	// no mutex (project concurrency rule).
	thinkingLevel        string
	spawnedThinkingLevel string

	// onAutonomousTurn, when non-nil, receives every turn the persistent CLI
	// emits while no Submit is in flight (scheduled wake / monitor). The
	// always-on stdout reader surfaces these via the background drain
	// (autonomous_turn.go) instead of letting them pile up unread and be
	// mis-attributed to the next user message. Set by the consumer (the
	// worker; the claudecode tests set it directly). One Client per
	// conversation, so a plain field is the single owner — no map, no global.
	onAutonomousTurn func(*turnResult)
}

// NewClient creates a new Claude Code provider client
func NewClient(cfg provider.Config) (provider.Provider, error) {
	// The project the server has open is the authoritative source, so it is
	// cfg.ProjectPath (filled from Server.ProjectPath() at the conversation-cache
	// call site). Fall back to the process cwd only when no project is carried —
	// the path taken by model-listing calls that pass a bare Config and never
	// spawn against a project.
	stateDir := cfg.ProjectPath
	if stateDir == "" {
		var err error
		stateDir, err = os.Getwd()
		if err != nil {
			return nil, fmt.Errorf("failed to get working directory: %w", err)
		}
	}

	// The two diverge only for a conversation bound to a workspace: the CLI runs
	// where the work is, our own files stay with the project. Unbound, they are
	// the same directory and this client behaves as it always did.
	workingDir := stateDir
	if cfg.WorkspaceRoot != "" {
		workingDir = cfg.WorkspaceRoot
	}

	c := &Client{
		model:      cfg.Model,
		workingDir: workingDir,
		stateDir:   stateDir,
		own:        make(chan struct{}, 1),
	}
	c.own <- struct{}{} // token starts available: no turn in flight
	return c, nil
}

// acquireTurnOwnership blocks until this goroutine holds the sole right to
// mutate activeSession, returning a release func — or gives up with ctx's error
// when ctx ends first, so a turn queued behind another on this session can be
// cancelled (by Stop, or by the worker abandoning a call it timed out). A nil
// `own` (test-only direct &Client{} builds that never stream/cancel) yields a
// no-op so those tests keep working. Teardown takes the token through
// acquireOwnershipAfterInterrupt instead.
func (c *Client) acquireTurnOwnership(ctx context.Context) (release func(), err error) {
	if c.own == nil {
		return func() {}, nil
	}
	select {
	case <-c.own:
		return func() { c.own <- struct{}{} }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// interruptUnwindTimeout bounds how long cancelSession / closeSession wait for
// an interrupted turn to give up ownership. An interrupted turn unwinds within
// seconds; one that hasn't by now is stuck somewhere its context cannot reach,
// and waiting longer would freeze the conversation's ops goroutine with it —
// every later open, cancel and close of the conversation queued behind it.
const interruptUnwindTimeout = 30 * time.Second

// acquireOwnershipAfterInterrupt interrupts the in-flight turn, if any, and
// takes the ownership token once it unwinds — the way a teardown (cancel,
// close), which may race a streaming turn, must take it. ok is false when the
// turn has not released the token within interruptUnwindTimeout; the caller
// must then leave activeSession alone, since the turn still owns it.
func (c *Client) acquireOwnershipAfterInterrupt() (release func(), ok bool) {
	if f := c.turnInterrupt.Load(); f != nil {
		(*f)() // make the owning turn unwind and release `own`
	}
	if c.own == nil {
		return func() {}, true
	}
	select {
	case <-c.own:
		return func() { c.own <- struct{}{} }, true
	case <-time.After(interruptUnwindTimeout):
		// activeSession is the turn's, so it is not read here, even for the log.
		jlog.Error("claudecode: the in-flight turn did not release its session within %v of being interrupted — leaving the session to it rather than freezing the conversation",
			interruptUnwindTimeout)
		return nil, false
	}
}

// Name returns the provider name
func (c *Client) Name() string {
	return "claudecode"
}

// reapIdleCLI frees the live CLI subprocess when this session has gone idle,
// while KEEPING the resumable record (sessionUUID/sentCount/sentHash) so the
// next turn --resumes warm. Per-thread keying means one CLI per thread, so
// idle processes must be bounded — but a re-opened thread should still resume
// warm, hence we reap the process, not the session. Non-blocking on ownership:
// if a turn holds `own` the session is active, so skip; holding the token for
// the whole check makes the pendingTools/parkedAt/live reads race-free against
// the turn goroutine that writes them.
//
// A session parked awaiting tool results is waiting on US, not idle: the CLI
// sits blocked on stdin while a tool runs (a sub-agent thread, a long build, an
// approval prompt the user hasn't answered), and lastUsedAt is frozen for the
// duration. Reaping there strands the parked call and costs the next turn its
// warm resume, so a parked session is measured against `parked` from the moment
// it parked instead of against `idle` — long enough for any tool that is going
// to finish, short enough that an abandoned park still gives its process back.
func (c *Client) reapIdleCLI(idle, parked time.Duration) {
	if c.own == nil {
		return
	}
	select {
	case <-c.own:
	default:
		return // a turn is in flight — not idle
	}
	defer func() { c.own <- struct{}{} }()

	s := c.activeSession
	if s == nil || !s.hasLiveCLI() {
		return
	}
	if len(s.pendingTools) > 0 {
		held := time.Since(s.parkedAt)
		if held < parked {
			if held >= idle {
				// Logged only once the park has outlived the idle timeout, so
				// an ordinary tool call that straddles a sweep stays silent and
				// only the exemptions that actually matter are accounted for.
				jlog.Debug("claudecode: session parked %v on %d tool call(s) — waiting on us, exempt from idle reap (uuid=%s)",
					held.Round(time.Second), len(s.pendingTools), shortID(s.sessionUUID))
			}
			return
		}
		jlog.Info("claudecode: reaping CLI parked %v on %d tool call(s) — past the %v ceiling, so nothing is coming back for it (uuid=%s)",
			held.Round(time.Second), len(s.pendingTools), parked, shortID(s.sessionUUID))
		s.tearDownLiveCLI() // free the OS process; the resumable record survives
		return
	}
	if time.Since(s.lastUsedAt) < idle {
		return
	}
	jlog.Debug("claudecode: reaping CLI idle %v (uuid=%s)",
		time.Since(s.lastUsedAt).Round(time.Second), shortID(s.sessionUUID))
	s.tearDownLiveCLI() // free the OS process; the resumable record survives
}

var _ provider.ConversationProvider = (*Client)(nil)

// OpenConversation returns a native claudecode Conversation handle. The
// handle binds this *Client (which carries model + workingDir + the
// lazily-populated activeSession) to convID. One Client per Conversation;
// the server's conversationCache owns the handle's lifetime.
func (c *Client) OpenConversation(ctx context.Context, convID string) (provider.Conversation, error) {
	// The handle owns a registry of per-thread sessions (one warm CLI per
	// thread); this Client is the config template and the root-thread ("")
	// session. See conversation.go.
	return newConversation(c, convID), nil
}

// newThreadSession clones this Client's config into a fresh per-thread session
// (its own activeSession, ownership token, and threadID). Sub-thread sessions
// (threadID != "") keep their state in memory only — never the on-disk sidecar
// (gated in loadSidecar/saveSidecar/deleteSidecar). Autonomous-turn surfacing
// is a root-thread concern, so onAutonomousTurn is intentionally NOT copied.
func (base *Client) newThreadSession(threadID string) *Client {
	s := &Client{
		model:      base.model,
		workingDir: base.workingDir,
		stateDir:   base.stateDir,
		threadID:   threadID,
		own:        make(chan struct{}, 1),
	}
	s.own <- struct{}{} // token starts available: no turn in flight
	return s
}

// loadSidecar / saveSidecar / deleteSidecar centralise the on-disk warm-resume
// sidecar. Only the ROOT thread persists: a sub-thread's session is transient
// and in-memory only, so it must never touch (read, overwrite, or delete) the
// conversation-level sidecar keyed by convID. Gating here keeps that invariant
// in one place.
//
// All three address stateDir, never workingDir: the sidecar lives beside the
// conversation it belongs to, in the project, however far from it the CLI is
// running. A workspace holds the user's files and nothing of ours — it can be
// deleted the moment its branch is merged, and doing so must not cost a
// conversation its warm resume.
//
// Where it lives and what it is valid for are different questions, though. The
// session inside it was made in one tree and the CLI files it under that tree,
// so `workingDir` goes in as what the session is FOR: a conversation that has
// moved cold-starts rather than resuming a transcript about another tree's
// files.
func (c *Client) loadSidecar(convID string) *activeSession {
	if c.threadID != "" {
		return nil
	}
	return loadDiskSession(c.stateDir, convID, c.workingDir)
}

func (c *Client) saveSidecar(convID string, sess *activeSession) {
	if c.threadID != "" {
		return
	}
	saveDiskSession(c.stateDir, convID, c.workingDir, sess)
}

func (c *Client) deleteSidecar(convID string) {
	if c.threadID != "" {
		return
	}
	deleteDiskSession(c.stateDir, convID)
}

// streamMessage drives one LLM turn against the CLI. The Conversation
// handle (conversation.go) is the public entry point; this method holds
// the dispatch logic across three regimes:
//
//  1. Tool-use continuation: a CLI process is alive, paused inside an MCP
//     tools/call waiting for our tool results. Feed the results via MCP and
//     resume reading. (No new CLI invocation; this is mid-LLM-turn.)
//
//  2. Resume with delta: no live CLI, but we have a stored sessionUUID and the
//     new req.Messages is a strict linear extension of what claude already has.
//     Spawn `claude --resume <uuid> --input-format stream-json` and pipe only
//     the delta on stdin. Prompt cache stays warm.
//
//  3. Fresh start: divergent history or first turn. Spawn with `-p
//     --input-format stream-json` and capture the session id from the
//     system/init event so future turns can use --resume.
//
// Per-conversation state lives on c.activeSession; one *Client is bound
// to one conversation via the server's conversationCache, so no global
// lookup is needed. Cold-start after a juggler restart loads state from
// the on-disk sidecar.
// req.ToolChoice is intentionally NOT honoured here: the claude CLI exposes no
// tool_choice / forced-function-call equivalent (only --allowedTools /
// --disallowedTools name-gating, which cannot compel a call). A plugin that
// forces a tool therefore degrades gracefully under claudecode — the model may
// answer in text, and the run settles on that trailing text as the thread's
// summary. If the CLI ever gains a forced-tool option, translate
// req.ToolChoice here.
// req.MaxOutputTokens (F1's per-request wire output cap) is likewise ignored:
// the CLI transport has no per-request max_tokens knob. Admission still charges
// the smaller reserve, which is safe here — the CLI cannot overshoot its own
// configured limits (the Anthropic API behind it enforces the model ceiling).
func (c *Client) streamMessage(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}

	turnCtx, turnCancel := context.WithCancel(ctx)
	defer turnCancel()

	// Take sole ownership of activeSession for the streaming window. Cancel /
	// Close interrupt this turn via turnInterrupt so the token frees promptly,
	// then take the token to tear down — so activeSession is never mutated by
	// the turn goroutine and the cache-actor goroutine at the same time.
	//
	// Ownership comes FIRST, and its wait honours turnCtx: a turn queued behind
	// another on this session holds no CLI turn slot while it waits (one stuck
	// turn must not let its retries drain the process-wide pool), and it leaves
	// the moment it is cancelled.
	releaseOwn, err := c.acquireTurnOwnership(turnCtx)
	if err != nil {
		return nil, err
	}
	defer releaseOwn()

	// Only the owner publishes its interrupt. A queued turn publishing its own
	// would displace the running turn's, and Cancel would then interrupt the
	// wrong turn and wait forever for the token the running one still holds.
	// Published before the slot wait so Cancel/Close also reach a turn queued
	// there (cliTurnSlots.acquire waits on turnCtx); cleared before the token is
	// released (defers run in reverse), so it never outlives this turn's
	// ownership.
	c.turnInterrupt.Store(&turnCancel)
	defer c.turnInterrupt.Store(nil)

	// Throttle concurrently-streaming turns process-wide before doing any
	// work. Acquired BEFORE stopping the autonomous drain so that, while this
	// turn queues behind others, the CLI's background drain keeps surfacing
	// autonomous turns. The slot is held only for this active-streaming window
	// and released on return (see concurrency.go for the deadlock-freedom
	// argument: a turn that pauses for tool approval / subthreads has already
	// returned and holds no slot). A turn cancelled while queued bails here.
	release, err := cliTurnSlots.acquire(turnCtx)
	if err != nil {
		return nil, err
	}
	defer release()

	// A Submit owns stdout for the duration of its turn: stop any background
	// autonomous-turn drain so the foreground turn is the sole consumer of
	// s.content (single-consumer invariant), then flush any already-complete
	// autonomous turns the CLI emitted before this Submit so they surface via
	// the sink ahead of the user's message instead of being mis-read as its
	// reply (send-site ordering; see flushBufferedTurns). Zero-cost when the
	// CLI has been quiet.
	if c.activeSession != nil {
		c.activeSession.stopAutonomousDrain()
		c.flushBufferedTurns()
	}

	// Fold overlong tool descriptions into the system prompt here, once, so the
	// spawn arguments, tools/list and the session's resume hashes all see the
	// same request.
	req = foldLongToolDescriptions(req)

	res, err := c.dispatchTurnWithRetry(turnCtx, req, callback)

	// The CLI now idles on stdin and may emit autonomous turns (scheduled
	// wake / monitor). Resume the drain so they surface promptly instead of
	// piling up unread and being mis-attributed to the next user message.
	c.maybeStartAutonomousDrain(res, err)
	return res, err
}

// cliMaxRetries bounds how many times a single turn is re-attempted after a
// transient CLI failure: one initial attempt plus cliMaxRetries retries.
const cliMaxRetries = 2

// maxConsecutiveStallsBeforeColdStart is the circuit-breaker threshold: after
// this many back-to-back transient stalls/exits on a warm --resume, the next
// dispatch stops re-resuming the (evidently wedged) session and cold-starts
// fresh. Set to 2 so a single one-off stall (e.g. a dropped connection across
// system sleep) still retries WARM — preserving the prompt cache — and only a
// genuinely stuck session escalates to a (cache-missing but unwedging) cold
// start.
const maxConsecutiveStallsBeforeColdStart = 2

// cliRetryBackoff is the base delay between transient-failure retries; the
// nth retry waits n*cliRetryBackoff. A package var so tests can shrink it.
var cliRetryBackoff = 750 * time.Millisecond

// dispatchTurnWithRetry runs dispatchTurn and, on a transient CLI failure
// (the process died without a terminal stop reason, or the stream stalled),
// re-attempts the turn up to cliMaxRetries times with linear backoff.
//
// The claude CLI already handles in-band rate-limit (HTTP 529) backoff itself
// via api_retry; this covers the orthogonal case where the process VANISHES
// without reporting an in-band result — most likely when many parallel CLIs
// (e.g. fanned-out subthreads) momentarily overwhelm the account's
// concurrency / usage limits, but also a plain crash or a dropped connection.
//
// A retry is only safe when NOTHING has streamed to the UI yet: replaying
// would duplicate already-shown text / thinking / tool_use. A clean,
// definitive error (rate-limit exhaustion the CLI reported in-band, a 400) is
// not a transientCLIError and is never retried. The failed attempt's
// finalizeTurn keeps the on-disk sidecar, so each retry --resumes warm rather
// than cold-starting the whole history.
//
// The one definitive error that is re-attempted is a rejectedTranscriptError:
// finalizeTurn has dropped the refused session, so the next attempt rebuilds it
// from juggler's history. That happens once per turn — a rebuilt session that
// is refused too means the request itself is malformed, and the error surfaces.
func (c *Client) dispatchTurnWithRetry(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	rebuilt := false
	for attempt := 0; ; attempt++ {
		// Whether this attempt streamed any real content. Status chunks (retry
		// notices) and replaceable activity snapshots are not content and don't
		// block a retry.
		streamed := false
		wrapped := func(chunk provider.StreamChunk) (*provider.ToolResult, error) {
			if chunk.Type != provider.ContentBlockTypeStatus && chunk.Type != provider.ContentBlockTypeActivity {
				streamed = true
			}
			return callback(chunk)
		}

		res, err := c.dispatchTurn(ctx, req, wrapped)

		// Every failed attempt is logged here, including the ones that return
		// without retrying below. A silent return leaves a respawn in the log
		// with no reason attached, which is indistinguishable from the turn
		// simply restarting on its own.
		if err != nil {
			jlog.Info("[claudecode] turn attempt %d/%d failed conv=%s (transient=%v streamed=%v ctxErr=%v): %v",
				attempt+1, cliMaxRetries+1, shortID(req.ConversationID),
				isTransientCLIError(err), streamed, ctx.Err(), err)
		}

		// Circuit-breaker bookkeeping: only consecutive transient stalls/exits
		// accumulate. A clean success or a definitive (non-transient) error
		// means the session isn't wedged, so reset. The count persists across
		// turns on the Client, so a wedge that spans user submissions still
		// escalates to a cold start on the next dispatch (see dispatchTurn).
		switch {
		case err == nil || !isTransientCLIError(err):
			c.consecutiveStalls = 0
		case isLadderExhaustedError(err):
			// Upstream overload, NOT a wedged session: the CLI streamed its
			// retry notices to us throughout, so the session and its prompt
			// cache are healthy. Cold-starting here would torch that cache and
			// re-send a LARGER request into the same overloaded upstream, so
			// leave the breaker's count alone and let the error surface.
		default:
			c.consecutiveStalls++
		}

		if err == nil {
			return res, nil
		}
		if attempt >= cliMaxRetries {
			// Surfaced with its retries spent: the worker reads that and does
			// not retry it again.
			var te *transientCLIError
			if errors.As(err, &te) {
				te.retried = true
			}
			return res, err
		}
		if isRejectedTranscriptError(err) && !rebuilt && !streamed && ctx.Err() == nil {
			rebuilt = true
			jlog.Info("[claudecode] API refused the session transcript conv=%s — rebuilding the session from juggler's history",
				shortID(req.ConversationID))
			continue
		}
		if ctx.Err() != nil || !isRetryableCLIError(err) || streamed {
			// Cancelled, a definitive (non-transient) error, or content has
			// already streamed — none are safely retryable.
			return res, err
		}

		delay := time.Duration(attempt+1) * cliRetryBackoff
		jlog.Info("[claudecode] transient CLI failure on attempt %d/%d (%v) — retrying in %v",
			attempt+1, cliMaxRetries+1, err, delay)
		select {
		case <-ctx.Done():
			return res, err
		case <-time.After(delay):
		}
	}
}

// dispatchTurn classifies the request and routes it to the matching regime.
// Factored out of streamMessage so the autonomous-turn drain can be stopped
// before dispatch and restarted after it.
func (c *Client) dispatchTurn(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	// Default spinner label for the post-boot wait; startFreshSession overrides
	// it for a cold start that carries prior history (see turnWaitingDescription).
	c.turnWaitingDescription = activityWaiting

	// Thinking level rides per-turn, but the CLI reads MAX_THINKING_TOKENS once
	// at spawn. If a live CLI is already running under a different level, recycle
	// it so the new budget takes effect. tearDownLiveCLI preserves
	// sessionUUID/history, so this is a warm-history cold-cache restart (the
	// resume machinery re-warms), not a cold start.
	c.thinkingLevel = req.ThinkingLevel
	if c.activeSession != nil && c.activeSession.hasLiveCLI() && c.spawnedThinkingLevel != c.thinkingLevel {
		jlog.Info("claudecode: thinking level changed %q→%q — recycling CLI session conv=%s",
			c.spawnedThinkingLevel, c.thinkingLevel, shortID(req.ConversationID))
		c.activeSession.tearDownLiveCLI()
	}

	// The CLI answers tools/list once at spawn and freezes that snapshot for its
	// whole lifetime. When MCP servers finish discovery (or start/stop) between
	// turns, req.Tools changes but the live CLI still advertises its spawn-time
	// set — so the model can neither see nor call the newly-discovered tools
	// (it gets "No such tool available"). Recycle the CLI when the tool-set
	// fingerprint diverges; tearDownLiveCLI preserves sessionUUID/history, so the
	// resume respawn re-runs tools/list with the current set and the prompt cache
	// re-warms (a warm-history cold-cache restart, not a cold start).
	//
	// Only at a turn boundary (no pending tools). A CLI parked mid-round inside a
	// tools/call must receive its result to unwedge — tearing it down here would
	// strand the parked call, and the CLI can't be re-advertised a new tools/list
	// mid-round anyway. When pendingTools is non-empty the turn either continues
	// (regimeContinue, must keep the CLI) or soft-resets (regimeResumeDelta, which
	// tears the CLI down itself); either way the tool-set change lands correctly
	// on the next boundary spawn. Skipping here keeps that invariant.
	if c.activeSession != nil && c.activeSession.hasLiveCLI() &&
		len(c.activeSession.pendingTools) == 0 &&
		c.activeSession.live.toolSig != hashToolNames(req.Tools) {
		jlog.Info("claudecode: MCP tool set changed since spawn — recycling CLI session to re-advertise tools/list conv=%s",
			shortID(req.ConversationID))
		c.activeSession.tearDownLiveCLI()
	}

	// Cold-start path: no in-memory session yet, but a sidecar from a
	// prior juggler run may exist on disk. Load so the first turn after
	// restart can --resume directly.
	if c.activeSession == nil {
		if loaded := c.loadSidecar(req.ConversationID); loaded != nil {
			c.activeSession = loaded
		}
	}

	if c.activeSession != nil {
		// Touch lastUsedAt so the idle sweeper (reapIdleCLI) counts this turn
		// as recent activity.
		c.activeSession.lastUsedAt = time.Now()
	}

	// Circuit breaker: a stored session whose --resume has stalled repeatedly is
	// wedged on the CLI side. Stop re-resuming the poisoned uuid; cold-start
	// fresh instead (startFreshSession rebuilds the CLI session from juggler's
	// own history under a NEW synthetic uuid, escaping the wedge). The sidecar is
	// preserved until the replacement turn succeeds and overwrites it
	// (dispatchFreshStart), so this never causes a spurious "no prior session"
	// cold start for a healthy session — only one that has actually stalled out.
	if c.activeSession != nil && c.activeSession.sessionUUID != "" &&
		c.consecutiveStalls >= maxConsecutiveStallsBeforeColdStart {
		return c.coldStartFallback(ctx, req, callback,
			fmt.Sprintf("wedged-resume: uuid=%s stalled %d times consecutively",
				shortID(c.activeSession.sessionUUID), c.consecutiveStalls))
	}

	dec := classifyRegime(c.activeSession, c.model, req.SystemPrompt, req.Messages, c.activeSession.hasLiveCLI())
	switch dec.Regime {
	case regimeContinue:
		return c.continueSession(ctx, req, callback)
	case regimeResumeDelta:
		if dec.SoftReset {
			// Pending tools but we couldn't continue (live CLI died, or user
			// interjected new content). Kill the parked subprocess so it
			// doesn't leak inside MCP; sessionUUID/sentCount/sentHash survive
			// so resume-with-delta still hits a warm prompt cache.
			jlog.Debug("Soft-resetting session before resume-with-delta (pendingTools=%d)",
				len(c.activeSession.pendingTools))
			c.activeSession.tearDownLiveCLI()
			c.activeSession.pendingTools = nil
		}
		return c.runPersistentResumeTurn(ctx, req, dec.DeltaStart, dec.DeltaEnd, callback)
	case regimeResumeAppendResult:
		// A tool_result-bearing delta whose results close the warm transcript's
		// dangling tool_use. Pair them into the warm session file and re-resume
		// warm rather than cold-rebuilding (see runWarmAppendResume).
		return c.runWarmAppendResume(ctx, req, dec.DeltaStart, dec.DeltaEnd, callback)
	case regimeStartFresh:
		// "no-new-msgs" steady state (e.g. user hit Continue with no edits,
		// or last turn produced only thinking/empty content): there is no
		// delta to ship through --resume, and cold-starting would torch the
		// 30k+ token prompt cache. Pipe a tiny continuationNudge (a
		// <system-reminder>-wrapped synthetic user turn) into the live
		// session instead — preserves the cache and gives the LLM a fresh
		// prompt cue without the model quoting it back as if the human had
		// typed it. Falls through to cold-start if the session can't be
		// resumed.
		if dec.NoNewMsgs && c.activeSession != nil && c.activeSession.sessionUUID != "" {
			return c.runResumeNudge(ctx, req, callback, false)
		}
		reason := "no prior Claude Code session"
		if c.activeSession != nil {
			reason = dec.Reason
			if dec.Reason == "diverged" || dec.Reason == "shrunk" {
				if detail := diagnoseDivergence(c.activeSession, req.SystemPrompt, req.Messages); detail != "" {
					reason = dec.Reason + ": " + detail
				}
			}
		}
		return c.coldStartFallback(ctx, req, callback, reason)
	}
	return nil, fmt.Errorf("claudecode: unknown regime %d", dec.Regime)
}

func hasAssistantHistory(messages []provider.Message) bool {
	for _, msg := range messages {
		if provider.MessageTypeToRole(msg.Type) == "assistant" {
			return true
		}
	}
	return false
}

// emitCacheMissWarning surfaces consequential cold starts through the provider's
// transient status path. A transcript without assistant history has no prior
// conversation cache to lose, and short requests are cheap to re-ingest. Those
// cases stay in the diagnostic log only.
func emitCacheMissWarning(callback provider.StructuredStreamCallback, req provider.MessageRequest, sess *activeSession, reason string) {
	if callback == nil || !hasAssistantHistory(req.Messages) {
		return
	}
	if sess != nil && sess.sentCount == 0 {
		return
	}
	if provider.EstimateMessageRequestTokens(req) < cacheMissWarningTokens {
		return
	}
	_, _ = callback(provider.StreamChunk{
		Type:    provider.ContentBlockTypeStatus,
		Content: "Rebuilding Claude Code context",
		Metadata: map[string]any{
			"cacheMissReason": reason,
		},
	})
}

// coldStartFallback is the single funnel for every cold start: both the ones
// classifyRegime chooses up front and the ones a warm path falls back to when
// something fails mid-dispatch. Either way the entire conversation is
// re-ingested, so either way it must announce itself — one greppable
// "⚠ claudecode cache-miss" line, plus the UI status warning when the loss is
// consequential enough to be worth interrupting for.
//
// A full re-ingest is otherwise effectively undetectable: the NEXT turn's cache
// hit ratio reads ~99% (a small truncated context re-reads perfectly), so the
// only symptom is absolute input tokens collapsing and the token spend
// climbing. Every cold start goes through here so none passes silently.
//
// Order is load-bearing: emitCacheMissWarning reads the session's sentCount to
// distinguish a real loss from a first turn, and dispatchFreshStart releases
// the session — so the warning must be emitted first.
func (c *Client) coldStartFallback(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback, reason string) (*provider.StreamResult, error) {
	jlog.Info("⚠ claudecode cache-miss: cold start (reason=%s) conv=%s msgs=%d",
		reason, shortID(req.ConversationID), len(req.Messages))
	emitCacheMissWarning(callback, req, c.activeSession, reason)
	c.dispatchFreshStart()
	return c.startFreshSession(ctx, req, callback)
}

// dispatchFreshStart prepares for a replacement fresh session after a routine
// cache-miss classification (diverged/shrunk/model-changed). It releases the
// live/in-memory handle, but deliberately PRESERVES the durable sidecar until
// the replacement turn succeeds and overwrites it. If the replacement stalls or
// fails (common after sleep/wake), the old sidecar is still the retry's only
// warm-resume anchor; deleting it here causes repeated "no prior session" cold
// starts.
func (c *Client) dispatchFreshStart() {
	if c.activeSession == nil {
		return
	}
	c.releaseSession()
}
