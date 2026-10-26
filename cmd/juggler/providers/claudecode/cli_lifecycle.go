//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"juggler/cmd/juggler/childcontain"
	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/jlog"
)

// testExtraSpawnEnv is appended to cmd.Env on every spawn when non-nil.
// Tests use it (in tandem with SetBinaryPathForTesting) to drop a sentinel
// env var into the child so the test binary, when re-exec'd as the fake
// claude CLI, knows to behave as the fake instead of running tests.
// Production code must leave this nil.
var testExtraSpawnEnv []string

// pinnedBinaryPath, when non-empty, forces claudeBinary() to a specific path,
// bypassing every other source. It is the test seam (set by
// SetBinaryPathForTesting) and must win over the live credentials/env lookup so
// tests that don't isolate the config dir aren't shadowed by a real
// claudecode_binary_path on the developer's machine. Production leaves it "".
var pinnedBinaryPath string

// SetBinaryPathForTesting pins the claude CLI path and the env vars added to
// spawned children. Returns a restore function. Test helpers call this to
// redirect spawnCLIPipes to a fake binary (typically the test binary itself,
// re-exec'd via the helper-process pattern).
//
// This export is test-only — production code never calls it. Wiring it
// through a build tag would be cleaner but would also require a parallel
// test-only file just to host the call site, so we instead trust the
// "ForTesting" suffix and the comment.
func SetBinaryPathForTesting(path string, extraEnv ...string) (restore func()) {
	oldPath := pinnedBinaryPath
	oldEnv := testExtraSpawnEnv
	pinnedBinaryPath = path
	testExtraSpawnEnv = append([]string(nil), extraEnv...)
	return func() {
		pinnedBinaryPath = oldPath
		testExtraSpawnEnv = oldEnv
	}
}

// claudePathEnvVar lets a user pin the claude CLI's absolute path when it lives
// somewhere auto-detection can't reach, via the environment.
const claudePathEnvVar = "JUGGLER_CLAUDE_PATH"

// BinaryPathCredKey is the credentials.json field where the user-configured
// claude CLI path lives. Set from the settings panel; read by
// configuredClaudeBinary. The settings handler posts this literal name (kept in
// sync there), mirroring ollama.HostCredKey.
const BinaryPathCredKey = "claudecode_binary_path"

// claudeBinaryPath is the auto-detected absolute path to the claude CLI, or ""
// if none was found. Resolved once at package load. Auto-detection is layered
// (see resolveClaudeBinary) because GUI launches on macOS inherit a minimal
// PATH (typically just /usr/bin:/bin:/usr/sbin:/sbin) that omits the
// version-manager and user-local bin dirs where a terminal's `which claude`
// finds it. Explicit user overrides (settings field, env var) are consulted
// separately and live, ahead of this — see claudeBinary.
var claudeBinaryPath = resolveClaudeBinary()

// claudeBinary returns the claude CLI path to use, in priority order:
//
//  1. the test seam (pinnedBinaryPath);
//  2. an explicit user override — the settings-panel path or JUGGLER_CLAUDE_PATH
//     — read live so a change takes effect without restarting juggler;
//  3. the path auto-detected at startup, while it is still a runnable file;
//  4. a fresh auto-detect otherwise — covering a claude installed after the
//     process started, and one removed or moved since (an uninstall, or a
//     version-manager upgrade that retires the old node's bin dir).
//
// The happy path (auto-detected once, no override) is a field read and a stat.
// The startup path is never rewritten, so the field stays read-only after
// package init and needs no lock.
func claudeBinary() string {
	if pinnedBinaryPath != "" {
		return pinnedBinaryPath
	}
	if p := configuredClaudeBinary(); p != "" {
		return p
	}
	if claudeBinaryPath != "" && isExecutablePath(claudeBinaryPath) {
		return claudeBinaryPath
	}
	return resolveClaudeBinary()
}

// configuredClaudeBinary returns the user's explicit override path, or "". It
// reads the settings-panel value from the credentials store first, then the
// JUGGLER_CLAUDE_PATH env var, ignoring (with a log for the env case) any value
// that isn't a runnable file so a stale override falls through to
// auto-detection rather than wedging every spawn.
func configuredClaudeBinary() string {
	if store, err := core.NewCredentialsStore(); err == nil {
		if p := strings.TrimSpace(store.GetRawKey(BinaryPathCredKey)); p != "" && isExecutablePath(p) {
			return p
		}
	}
	if p := strings.TrimSpace(os.Getenv(claudePathEnvVar)); p != "" {
		if isExecutablePath(p) {
			return p
		}
		jlog.Info("[claudecode] %s=%q is not an executable file; falling back to auto-detection", claudePathEnvVar, p)
	}
	return ""
}

// resolveClaudeBinary auto-detects the claude CLI (no user overrides — those
// live in configuredClaudeBinary) by trying, in priority order:
//
//  1. the current process PATH via exec.LookPath. This honours PATHEXT on
//     Windows and, on a GUI launch, the login-shell PATH that Run() already
//     merged in at startup (see repairPathForGUILaunch), so version-manager and
//     homebrew installs resolve without a second per-provider shell probe;
//  2. a fixed list of well-known install locations.
//
// The candidate list and the notion of "executable" are OS-specific — see
// claude_install_unix.go and claude_install_windows.go.
func resolveClaudeBinary() string {
	if p, err := exec.LookPath("claude"); err == nil {
		return p
	}
	for _, c := range claudeBinaryCandidates() {
		if isExecutablePath(c) {
			return c
		}
	}
	return ""
}

// isExecutablePath reports whether p is an existing, runnable, non-directory
// file. The bit-level notion of "executable" is OS-specific (isExecutableFile).
func isExecutablePath(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir() && isExecutableFile(info)
}

// spawnEnv builds the child environment for a claude CLI spawn: the parent
// environment with the resolved binary's own directory prepended to PATH, plus
// any test-only extras. Prepending dir(bin) lets a version-manager install
// (nvm/fnm/volta/asdf/homebrew, all of which co-locate node and the claude
// shim) find its `node` interpreter even when juggler was launched from a GUI
// with a minimal PATH — the npm-installed `claude` is a Node script whose
// shebang resolves `node` through PATH.
func spawnEnv(bin string, extra []string) []string {
	env := augmentPathEnv(os.Environ(), filepath.Dir(bin))
	if len(extra) > 0 {
		env = append(env, extra...)
	}
	return env
}

// claudecodeEffortLevels is the claude CLI's native reasoning-effort vocabulary,
// in display order — taken verbatim from the CLI's own definition
// (`"level": "low" | "medium" | "high" | "xhigh" | "max"`). The chosen level is
// passed to the CLI UNCHANGED via CLAUDE_CODE_EFFORT_LEVEL; the CLI validates it
// and reports "Effort not supported" for a model that can't honour it, so we
// never translate to a token budget or invent a number. This slice is the single
// source of truth: it IS the advertised list (thinkingLevelsFor) AND the accepted
// set (effortLevelSupported), so the two can never drift, and adding a level the
// CLI grows is a one-line edit here.
var claudecodeEffortLevels = []string{"low", "medium", "high", "xhigh", "max"}

// thinkingLevelsFor returns the effort levels a claudecode family advertises, in
// display order. Every family shares the CLI's one native vocabulary — the CLI,
// not us, decides per-model which a given model can honour.
func thinkingLevelsFor(modelID string) []string {
	return claudecodeEffortLevels
}

// effortLevelSupported reports whether level is one the claude CLI accepts (a
// member of claudecodeEffortLevels). Passed to CLAUDE_CODE_EFFORT_LEVEL verbatim,
// so anything not in the set (absent, "off", garbage) omits the var and the CLI
// falls back to its default adaptive thinking.
func effortLevelSupported(level string) bool {
	return slices.Contains(claudecodeEffortLevels, level)
}

// thinkingSpawnExtras returns the extra spawn-env entries for the current turn:
// the test extras plus, when this turn carries a valid effort level, a
// CLAUDE_CODE_EFFORT_LEVEL entry the claude CLI reads at spawn to set its native
// reasoning effort. It also records the level actually spawned
// (spawnedThinkingLevel) so a later turn with a different level knows to recycle
// the CLI. An absent/unknown level omits the var — the CLI then uses its default
// adaptive thinking.
func (c *Client) thinkingSpawnExtras() []string {
	c.spawnedThinkingLevel = c.thinkingLevel
	extras := testExtraSpawnEnv
	if effortLevelSupported(c.thinkingLevel) {
		extras = append(append([]string(nil), extras...), "CLAUDE_CODE_EFFORT_LEVEL="+c.thinkingLevel)
	}
	return extras
}

// augmentPathEnv returns environ with dir prepended to its PATH entry (matched
// case-insensitively for Windows' "Path"), creating one if absent. It is a
// no-op when dir is empty/"." or already the leading PATH element.
func augmentPathEnv(environ []string, dir string) []string {
	if dir == "" || dir == "." {
		return environ
	}
	sep := string(os.PathListSeparator)
	out := make([]string, 0, len(environ)+1)
	found := false
	for _, kv := range environ {
		name, val, ok := strings.Cut(kv, "=")
		if ok && strings.EqualFold(name, "PATH") {
			found = true
			if parts := filepath.SplitList(val); len(parts) > 0 && parts[0] == dir {
				out = append(out, kv) // already leading — leave untouched
				continue
			}
			out = append(out, name+"="+dir+sep+val)
			continue
		}
		out = append(out, kv)
	}
	if !found {
		out = append(out, "PATH="+dir)
	}
	return out
}

// claudeNotFoundHint leads the transcript when a turn finds no claude CLI. The
// person reading it is as likely to be new to Juggler and never to have
// installed Claude Code as to have it somewhere Juggler can't see, so it says
// first that this is one provider among several — the row beneath it offers
// another model as well as settings.
var claudeNotFoundHint = msg.New("Claude Code isn't installed, or Juggler can't find its claude CLI. It's only one way to run Juggler: choose another model, or install it — or set its path — in provider settings.")

// claudeNotFoundError is the failure for a spawn that finds no claude CLI: a
// provider.SetupError, so the worker reports it as user-fixable rather than as
// a generic error with only a Retry beneath it. The message keeps what was
// searched, which is the diagnosable part for someone who has it installed.
func claudeNotFoundError() error {
	return &provider.SetupError{
		Provider: "claudecode",
		Message: fmt.Sprintf("claude executable not found. Searched $PATH, the login shell, and known install locations (%s). Its path can be set in provider settings, or with %s.",
			claudeInstallLocationsHint, claudePathEnvVar),
		Hint: claudeNotFoundHint.English(),
	}
}

// detectClaudeCLI reports whether a usable claude CLI can be located, honouring
// an explicit settings-panel / env override as well as auto-detection.
func detectClaudeCLI() bool {
	return claudeBinary() != ""
}

// activeSession holds per-conversation state for the claudecode provider.
//
// Two distinct lifetimes are mixed in here:
//
//  1. Persistent fields (sessionUUID, heldCount, sentCount, sentHash) live for
//     the entire juggler conversation. They allow us to spawn or respawn a CLI
//     invocation with `--resume <sessionUUID>` so the prompt cache stays warm.
//
//  2. Live-CLI fields (grouped in the nilable live *liveCLI sub-struct) hold
//     the running `claude` process and its stdio plumbing. The CLI is always
//     spawned with `--input-format stream-json` so it idles on stdin between
//     turns; live-CLI state stays populated across many juggler turns and is
//     only cleared by tearDownLiveCLI on conversation close, error recovery,
//     or divergent history. pendingTools is the exception — it tracks
//     continuation state read by the pure regime classifier even with no live
//     CLI, so it lives on activeSession, not liveCLI.
//
// pendingToolMeta captures the dispatch identity of a single tool_use block
// emitted by the LLM, used by the MCP result router to pair an incoming
// tools/call (which carries name + arguments) with the result that the
// frontend will eventually send back (which carries tool_use_id). Order of
// the parent slice matches the order the CLI will issue tools/call.
type pendingToolMeta struct {
	ID   string
	Name string
	Args json.RawMessage // canonical (sorted-key) JSON of tool_use.input
}

type activeSession struct {
	// Persistent across CLI invocations. heldCount is the full extent of the
	// latest req.Messages accepted by stdin. sentCount is the stable decision
	// prefix: it deliberately excludes trailing volatile context, and therefore
	// governs prefix matching and where the next delta starts.
	sessionUUID string // claude session id captured from system/init; "" until first turn completes
	heldCount   int
	sentCount   int
	sentHash    uint64 // backward-compatible aggregate fingerprint of the decision prefix

	// Per-element fingerprints are authoritative for resume decisions. They cover
	// the system prompt and the same decision prefix as sentCount. Empty hashes on
	// an old sidecar fall back to sentHash for backward compatibility.
	sentSystemHash uint64
	sentMsgHashes  []uint64

	// Cache-warmth bookkeeping. Captured at the end of every successful turn
	// so the next turn knows what the CLI is currently warmed up for. The
	// system prompt is part of sentHash — not a separate field — because
	// juggler treats it as just another piece of the request payload, not a
	// privileged input.
	model         string    // c.model that produced this session
	lastCacheRead int       // CachedTokens reported by the last turn (0 until we've observed a hit)
	lastTurnAt    time.Time // wall-clock time of the last finalizeTurn success (for upstream cache TTL)

	// live holds the running CLI subprocess and its stdio plumbing, or nil
	// when this session exists only as a resumable UUID with no live process.
	// Populated by spawnCLIPipes; nil'd as a unit by doTearDownLiveCLI — so
	// "what survives a teardown" is a type-level fact (see liveCLI).
	live *liveCLI

	// teardownOnce gates the per-CLI-instance teardown body so it runs at
	// most once even when reached concurrently from different goroutines —
	// e.g. handleCancel cancels the in-flight LLM ctx (the LLM goroutine
	// unwinds into dropSession→tearDownLiveCLI) AND calls cancelLLMSession
	// (the conversationCache actor goroutine reaches the same teardown).
	// Without the gate both racing callers hit the channel closes
	// (control.teardown's close(quit), close(readerStop)) and the second
	// panics with "close of closed channel". A fresh Once is installed by
	// spawnCLIPipes on every (re)spawn so teardown→respawn→teardown works;
	// nil means no live CLI was ever spawned on this session (nothing to
	// tear down, no concurrent closers to guard).
	//
	// It lives on activeSession, NOT liveCLI: the gate must read a field the
	// teardown body never writes, but the body nils s.live as a unit — so a
	// teardownOnce inside liveCLI would have the gate read of s.live race the
	// body's s.live = nil. Keeping it here (and never nil'd by the body, as
	// before) keeps the gate's read stable and race-free.
	teardownOnce *sync.Once

	// Per-pending-tool metadata captured at tool_use emission. Tracks both
	// continuation state (we have N tools awaiting results) AND the
	// (name, args) of each block. Ordered: each entry's position matches the
	// order the CLI issues tools/call, which is how results are routed to
	// parked calls — positionally, by FIFO order (see control_protocol.go).
	// The (name, args) are no longer used to route; they only build the
	// divergence-diagnostic key passed to deliverNextToolResult, which loudly
	// logs if the worker-recorded args for a position disagree with what the
	// CLI parked there.
	pendingTools []pendingToolMeta

	// parkedAt is when the CLI parked on the pendingTools above — the moment it
	// blocked on stdin awaiting our control_responses. The idle-eviction
	// sweeper measures a parked session against the parked ceiling from here
	// rather than against lastUsedAt, which stands still for the whole park
	// (see reapIdleCLI). Meaningful only while pendingTools is non-empty, and
	// never persisted: a session restored from a sidecar parks nothing.
	parkedAt time.Time

	// fedResultIDs records the tool_use_ids whose result this session has already
	// fed to the CLI during the current LLM turn. A second feed of the same id is
	// always a duplicate; continueSession drops it (the fedResultIDs backstop in
	// doc.go's "Tool-delivery desync" section). Cleared at end_turn (finalizeTurn)
	// alongside pendingTools; ids are unique per invocation so cross-turn entries
	// never collide, the reset only bounds memory.
	fedResultIDs map[string]bool

	// Token tracking (accumulated across early-return continuations within one LLM turn)
	inputTokens      int
	outputTokens     int
	cacheReadTokens  int
	cacheWriteTokens int

	// lastUsedAt is updated at the entry of every StreamMessage call and again
	// as each round of a turn is read. The idle-eviction sweeper uses it to
	// decide when to tear down a live CLI — except while the session is parked
	// on tool results, which is measured from parkedAt instead. Sessions with
	// no live CLI ignore this field.
	lastUsedAt time.Time

	// exitDiag holds the CLI process's exit status ("exit status 1",
	// "signal: killed") captured by doTearDownLiveCLI after it reaps the
	// process. finalizeTurn reads it to enrich an "exited unexpectedly"
	// error so the log distinguishes a crash/OOM (a signal) from a clean
	// but incomplete exit (typically a quota-kill). Empty until a reap.
	exitDiag string

	// Autonomous-turn drain (autonomous_turn.go). Between Submits a single
	// background goroutine consumes `content`, segmenting and surfacing the
	// turns the CLI emits on its own (scheduled wake / monitor) to the
	// Client's onAutonomousTurn sink. autoDrainCancel cancels that
	// goroutine's read context; autoDrainDone closes once it has exited.
	// Both nil when no drain is running. The drain is the sole consumer of
	// `content` while it runs; a Submit stops it first so the foreground
	// turn becomes the sole consumer (single-consumer invariant).
	autoDrainCancel context.CancelFunc
	autoDrainDone   chan struct{}
}

// liveCLI holds the plumbing for one running `claude` subprocess and its stdio.
// Non-nil exactly while a process is alive; doTearDownLiveCLI nils it as a unit,
// so "what survives a teardown" is a type-level fact: everything that survives
// lives on activeSession, everything that dies lives here.
type liveCLI struct {
	cmd      *exec.Cmd
	child    *childcontain.Child // OS-level containment for cmd/process tree
	stdin    io.WriteCloser      // Stdin pipe; carries control_responses + user messages
	lines    <-chan string       // Raw scanner output channel (CLI stdout); owned by the reader
	scanDone <-chan struct{}     // Scanner done signal
	scanErr  <-chan error        // Scanner error channel

	// content carries CLI stdout *content* lines after the continuous reader
	// (reader.go) has peeled off control frames and routed them to the
	// control-protocol actor. readUntilPauseOrComplete consumes this rather
	// than the raw scanner channel, so control traffic is handled even
	// between turns. Created in spawnCLIPipes; the reader is its sole closer.
	content chan string
	// readerStop signals the continuous reader to exit; readerDone is closed
	// once it has (after content is closed). Created in spawnCLIPipes,
	// signalled in tearDownLiveCLI.
	readerStop chan struct{}
	readerDone chan struct{}

	// Bounded ring of the most recent CLI stderr lines. The drain goroutine
	// pushes onto this channel and drops the oldest entry when full so we
	// never block the CLI. The parser drains it when the CLI exits without
	// a terminal stop reason so a usage-limit / quota / auth error reported
	// only on stderr surfaces in the UI instead of vanishing.
	recentStderr chan string

	// resultOwed is set when a read ended at the stream's own end_turn: the CLI
	// still writes that query's `result` envelope after it, and the next read
	// meets it first. Owned by whichever reader holds content (the foreground
	// turn or the autonomous drain — one at a time). See passOverQueryTrailer.
	resultOwed bool

	// control owns the stdio control protocol for this CLI session. Set
	// when the persistent CLI is spawned with --input-format stream-json
	// and routes the CLI's mcp_message control_requests back to our
	// in-process MCP server via cp.stdin. Nil for one-shot -p sessions
	// (which exit before they'd hit an MCP call). See control_protocol.go.
	control *controlProtocol

	// toolSig is the fnv fingerprint (hashToolNames) of the tool-name set this
	// CLI was spawned with and advertised over tools/list. The CLI freezes that
	// list for its whole lifetime, so when a later turn's req.Tools set differs
	// (MCP servers finished discovering, or started/stopped mid-conversation)
	// dispatchTurn tears this CLI down and respawns so tools/list re-runs with
	// the current set. Lives on liveCLI (not activeSession) so it dies with the
	// process it describes and a respawn re-captures it fresh.
	toolSig uint64
}

// hasLiveCLI reports whether a CLI process is currently alive and ready to
// receive tool results via MCP. False when the session exists only as a
// resumable UUID with no running process.
func (s *activeSession) hasLiveCLI() bool {
	if s == nil || s.live == nil {
		return false
	}
	select {
	case <-s.live.scanDone:
		return false
	default:
		return true
	}
}

// teardownGracePeriod is how long we wait after closing stdin (EOF) for
// the CLI to exit on its own before escalating to SIGKILL. Borrowed from
// the Claude Agent SDK's teardown pattern (subprocess_cli.py:571-600) and
// motivated by anthropics/claude-agent-sdk-python#625: SIGKILL during a
// mid-write to the on-disk session file can lose the last assistant
// message. The grace period gives the CLI a chance to flush.
// teardownGracePeriod is intentionally short to stay inside the existing
// cancel-budget contract (2s observed in TestCancel_KillsLiveSubprocess);
// the SDK uses 5s but they're not bound by interactive cancel UX.
const teardownGracePeriod = 500 * time.Millisecond

// tearDownLiveCLI terminates the live CLI process and its MCP server and
// clears all live-CLI fields, leaving the persistent fields (sessionUUID,
// heldCount, sentCount, sentHash, and lastUsedAt) intact so future turns can
// still resume.
//
// Teardown order matters:
//  1. Release any parked control-protocol callers (outbound requests
//     waiting on a control_response that's never coming) so they observe
//     shutdown instead of hanging on a closed pipe. Inbound tools/call are
//     abandoned unanswered — steps 2 and 3 are what unwind the CLI, and a
//     synthetic result would only pollute its session file (control_protocol.go).
//  2. Close stdin to signal EOF — gives the CLI a chance to flush its
//     session file before we escalate.
//  3. Wait up to teardownGracePeriod for the CLI to exit cleanly; if it
//     doesn't, SIGKILL.
//  4. Reap the process so the OS doesn't accumulate zombies.
//  5. Drain stdout (the scanner goroutine exits when the channel closes).
//
// Safe to call concurrently from any goroutine: the body is gated by
// teardownOnce so it runs exactly once per live-CLI instance and racing
// callers block until it completes, then observe a fully torn-down session.
// This is load-bearing — handleCancel deliberately drives teardown from two
// goroutines at once (ctx-cancel on the LLM goroutine + cancelLLMSession on
// the cache-actor goroutine), and the inner channel closes (control quit,
// readerStop) would otherwise double-close and panic. A fresh Once installed
// per spawn re-arms it across the teardown→respawn→teardown cycle.
func (s *activeSession) tearDownLiveCLI() {
	if s == nil {
		return
	}
	if once := s.teardownOnce; once != nil {
		once.Do(s.doTearDownLiveCLI)
		return
	}
	// No live CLI was ever spawned on this session (e.g. loaded from disk):
	// the body is all nil-guarded no-ops and there are no live channels to
	// double-close, so run it directly.
	s.doTearDownLiveCLI()
}

// doTearDownLiveCLI is the actual teardown body. Never call it directly —
// go through tearDownLiveCLI so the teardownOnce gate serialises concurrent
// callers and prevents double-close panics.
func (s *activeSession) doTearDownLiveCLI() {
	// Stop the background autonomous-turn drain before touching any live-CLI
	// channels: it consumes s.live.content and reads s fields, so it must be
	// fully exited before we close readerStop / nil the live struct out below.
	s.stopAutonomousDrain()

	if lc := s.live; lc != nil {
		// Stop the continuous stdout reader first: it stops routing control
		// frames and forwarding content, and closes lc.content on the way out.
		// readerStop is in every reader select, so a reader parked on a full
		// lc.content (no consumer) or blocked on lc.lines unblocks promptly. Safe
		// if the reader already exited via lc.lines closing — readerDone is
		// already closed and the receive returns at once.
		if lc.readerStop != nil {
			close(lc.readerStop)
			lc.readerStop = nil
			if lc.readerDone != nil {
				<-lc.readerDone
				lc.readerDone = nil
			}
		}

		// Release any parked control-protocol callers (e.g. an outbound
		// initialize that never got a response) so they observe shutdown
		// instead of hanging on a closed pipe. Stops the actor goroutine too,
		// and drops the parked tools/call without answering them.
		if lc.control != nil {
			lc.control.teardown()
		}

		// Phase 1: graceful close. Close stdin so the CLI sees EOF and may
		// exit cleanly while flushing its on-disk session.
		if lc.stdin != nil {
			_ = lc.stdin.Close()
		}

		// Phase 2: wait for natural exit, escalate to SIGKILL if needed.
		// cmd.Wait reaps the zombie exactly once, so it runs in a goroutine
		// signalling completion via a channel.
		if lc.cmd != nil && lc.cmd.Process != nil {
			exited := make(chan struct{})
			go func() {
				_ = lc.cmd.Wait()
				close(exited)
			}()
			select {
			case <-exited:
				// CLI exited gracefully on EOF.
			case <-time.After(teardownGracePeriod):
				if lc.child != nil {
					if err := lc.child.Terminate(); err != nil {
						jlog.Error("[claudecode] failed to terminate stuck CLI process tree: %v", err)
					}
				} else if err := lc.cmd.Process.Kill(); err != nil {
					jlog.Error("[claudecode] failed to kill stuck CLI process: %v", err)
				}
				<-exited
			}
			// The process is now reaped, so ProcessState is populated. Record its
			// exit status for diagnostics — finalizeTurn surfaces it on an
			// unexpected-exit error (which only arises on the orderly post-read
			// teardown, where the process exited on its own rather than being
			// killed here). exitDiag lives on activeSession, so it survives the
			// s.live = nil below for finalizeTurn to read.
			if ps := lc.cmd.ProcessState; ps != nil {
				s.exitDiag = ps.String()
			}
			if lc.child != nil {
				lc.child.Cleanup()
				lc.child = nil
			}
		}

		if lc.lines != nil {
			// Drain any buffered output so the scanner goroutine can exit.
			go func(l <-chan string) {
				for range l {
				}
			}(lc.lines)
		}
		if lc.scanDone != nil {
			<-lc.scanDone
		}
	}

	// Drop the live-CLI plumbing as a unit — everything that dies on teardown
	// lives on liveCLI — then clear the non-liveCLI state that teardown also
	// resets: pendingTools and the per-turn token scratch.
	s.live = nil
	s.pendingTools = nil
	s.inputTokens = 0
	s.outputTokens = 0
	s.cacheReadTokens = 0
	s.cacheWriteTokens = 0
}

// ensurePersistentCLI spawns the persistent claude process if not already
// running. The process and its MCP server are tied to a long-lived
// background context (NOT the per-turn ctx) so they survive across turns.
// Lifetime is managed explicitly via tearDownLiveCLI on error / divergence /
// conversation close.
func (c *Client) ensurePersistentCLI(req provider.MessageRequest) error {
	if c.activeSession.hasLiveCLI() {
		return nil // already alive and persistent
	}

	args := []string{
		"-p",
		"--input-format", "stream-json",
		"--resume", c.activeSession.sessionUUID,
	}
	args = append(args, c.commonArgs(req.SystemPrompt)...)

	jlog.Debug("Spawning persistent claude CLI (uuid=%s)", c.activeSession.sessionUUID)
	if err := c.spawnCLIPipes(args); err != nil {
		return err
	}

	// Wire the stdio control protocol so the CLI can call back into our
	// in-process MCP server for tool execution.
	return c.attachControlProtocol(req.Tools)
}

// spawnCLIPipes is the low-level "start the process and wire up pipes" step
// shared by persistent and one-shot spawns. The process uses
// context.Background so its lifetime is decoupled from any per-turn context;
// it is killed only via tearDownLiveCLI.
func (c *Client) spawnCLIPipes(args []string) error {
	bin := claudeBinary()
	if bin == "" {
		return claudeNotFoundError()
	}
	jlog.Debug("Claude CLI command: %s %s", bin, strings.Join(args, " "))

	cmd := claudeCommand(context.Background(), bin, args)
	cmd.Dir = c.workingDir
	cmd.Env = spawnEnv(bin, c.thinkingSpawnExtras())

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("failed to create stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return fmt.Errorf("failed to create stdout pipe: %w", err)
	}
	// Capture stderr so the CLI's own error reports (argument parsing,
	// MCP config rejection, etc.) surface in our logs instead of being
	// silently dropped. The CLI emits structured errors on stdout for
	// in-protocol failures; stderr is for spawn-time / fatal issues.
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdin.Close()
		return fmt.Errorf("failed to create stderr pipe: %w", err)
	}
	childcontain.Prepare(cmd)
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return fmt.Errorf("failed to start claude CLI: %w", err)
	}
	child, containErr := childcontain.Adopt(cmd)
	if containErr != nil {
		jlog.Info("[claudecode] child containment unavailable (%v); shutdown may not terminate the full claude process tree", containErr)
	}

	// Stderr drain goroutine: forwards each line to jlog at Info level and
	// also retains the most recent lines in a bounded channel so the parser
	// can surface them if the CLI dies without emitting a terminal result.
	recentStderr := make(chan string, 32)
	go func() {
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			line := sc.Text()
			// Benign startup chatter (e.g. the "matches no known tool"
			// warnings the CLI prints for every --disallowedTools entry it
			// doesn't recognise) is logged at Debug so it doesn't pollute the
			// per-turn Info log; real stderr stays at Info.
			if isBenignStderrLine(line) {
				jlog.Debug("[claude stderr] %s", line)
			} else {
				jlog.Info("[claude stderr] %s", line)
			}
			select {
			case recentStderr <- line:
			default:
				// Buffer full — drop the oldest and retry; we want the
				// tail (most recent lines are usually the diagnostic).
				select {
				case <-recentStderr:
				default:
				}
				select {
				case recentStderr <- line:
				default:
				}
			}
		}
	}()

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 1024*1024), 10*1024*1024)
	lines := make(chan string, 100)
	scanErr := make(chan error, 1)
	scanDone := make(chan struct{})
	go func() {
		defer close(scanDone)
		defer close(lines)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
		if err := scanner.Err(); err != nil {
			scanErr <- err
		}
	}()

	if c.activeSession == nil {
		c.activeSession = &activeSession{}
	}
	// Build the live-CLI plumbing as a unit and install it in one shot, so the
	// session flips from "resumable UUID only" to "live" atomically.
	c.activeSession.live = &liveCLI{
		cmd:   cmd,
		child: child,
		// Wrap stdin in a logging writer so every byte we send the CLI is
		// captured at debug level. Critical for diagnosing stdio-control
		// protocol issues — a silently-eaten initialize or control_response
		// is the kind of bug we want a paper trail for.
		stdin: &debugLogWriteCloser{w: stdin, tag: "stdin"},
		lines: lines,
		// Per-session reader plumbing. The reader goroutine itself is launched by
		// attachControlProtocol, once the control protocol is set, so it can route
		// control frames from the very first line. content is buffered so a brief
		// gap between turns (the CLI emitting a trailing tail) doesn't backpressure
		// the scanner; a large autonomous burst still applies backpressure to the
		// CLI, which is acceptable (and resolved when turns are drained downstream).
		content:      make(chan string, 256),
		readerStop:   make(chan struct{}),
		readerDone:   make(chan struct{}),
		scanDone:     scanDone,
		scanErr:      scanErr,
		recentStderr: recentStderr,
	}
	// Re-arm the teardown gate for this fresh CLI instance: a prior Once was
	// spent by the previous instance's teardown, and the new live channels
	// above must be tear-down-able exactly once again. teardownOnce lives on
	// activeSession (not liveCLI) so the gate read in tearDownLiveCLI never
	// races doTearDownLiveCLI's s.live = nil.
	c.activeSession.teardownOnce = &sync.Once{}
	return nil
}

// drainStderr non-blockingly drains the recent-stderr ring and returns the
// accumulated lines joined with newlines. Used by the stream parser to
// surface CLI failures that only show up on stderr (usage-limit / quota /
// auth errors). Benign startup chatter is filtered out so it never gets
// appended to a failure message as if it were the cause — see
// isBenignStderrLine.
func (s *activeSession) drainStderr() string {
	if s == nil || s.live == nil || s.live.recentStderr == nil {
		return ""
	}
	var lines []string
	for {
		select {
		case l := <-s.live.recentStderr:
			if !isBenignStderrLine(l) {
				lines = append(lines, l)
			}
		default:
			return strings.Join(lines, "\n")
		}
	}
}

// isBenignStderrLine reports whether a CLI stderr line is harmless startup
// chatter rather than a real failure. The CLI prints a "matches no known
// tool" warning at launch for every --disallowedTools entry it doesn't
// recognise (older built-ins like LS/MultiEdit/TodoRead that Anthropic has
// since renamed or removed). We keep those names in the deny list on purpose —
// they're a safety net for any CLI version that still ships them — but the
// warning is noise, and when the stream later stalls, drainStderr would
// otherwise staple these startup lines onto the stall error and make them
// look causal.
func isBenignStderrLine(line string) bool {
	return strings.Contains(line, "matches no known tool")
}

// debugLogWriteCloser wraps an io.WriteCloser and emits a jlog.Debug line
// for every Write. Used to capture the wire-level CLI stdin traffic so
// stdio-control-protocol failures are diagnosable from logs alone. tag
// identifies the writer in the logs (typically "stdin").
type debugLogWriteCloser struct {
	w   io.WriteCloser
	tag string
}

func (d *debugLogWriteCloser) Write(p []byte) (int, error) {
	// Log without the trailing newline; truncate long payloads (tool
	// responses can run thousands of chars and drown out everything else)
	// so the log stays readable while still showing envelope shape.
	jlog.Debug("[%s →] %s", d.tag, truncateForLog(strings.TrimRight(string(p), "\n"), 400))
	return d.w.Write(p)
}

// truncateForLog clips s to max runes, inserting an "…(N more chars)" tail
// so the original length is still visible. Returns s unchanged if it fits.
func truncateForLog(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + fmt.Sprintf("…(+%d chars)", len(s)-max)
}

func (d *debugLogWriteCloser) Close() error { return d.w.Close() }

// writeStdinDelta writes the given stream-json payload to the live CLI's stdin.
// Returns an error if no live stdin is available or the write fails.
func (c *Client) writeStdinDelta(payload []byte) error {
	if c.activeSession == nil || c.activeSession.live == nil || c.activeSession.live.stdin == nil {
		return fmt.Errorf("no live CLI stdin")
	}
	// Route through the control protocol's single stdin write path when it's
	// attached (the normal case — every persistent/resume/fresh turn attaches
	// the control protocol before writing). This keeps user-message deltas and
	// control envelopes funnelling through one writer, the structural
	// prerequisite for the stdin-owning actor (plan step 1). Fall back to a
	// direct write only for the (test-only) sessions with no control protocol.
	if c.activeSession.live.control != nil {
		return c.activeSession.live.control.writeUserDelta(payload)
	}
	n, err := c.activeSession.live.stdin.Write(payload)
	if err != nil {
		return err
	}
	if n != len(payload) {
		return io.ErrShortWrite
	}
	return nil
}

// Session-lifecycle verbs, by what they touch. Every row kills the live CLI
// (transitively); the table shows the axes that distinguish them:
//
//   verb                interrupt-turn  own-token  kill-CLI  nil-session  del-sidecar
//   ------------------  --------------  ---------  --------  -----------  -----------
//   tearDownLiveCLI     no              no         yes       no           no
//   releaseSession      no              no         yes       yes          no
//   dropSession         no              no         yes       yes          yes
//   dispatchFreshStart  no              no         yes       yes          no
//   cancelSession       yes             yes        yes       no           no
//   closeSession        yes             yes        yes       yes          no
//
// interrupt-turn = unblocks an in-flight turn via turnInterrupt. own-token =
// acquires the `own` ownership token before mutating activeSession; only
// cancelSession/closeSession need it, because they may run on the
// conversation-actor goroutine while a turn streams, whereas the others run
// inside the turn goroutine that already holds `own`. nil-session = drops the
// in-memory activeSession handle. del-sidecar = deletes the durable on-disk
// resume anchor — only dropSession does. dispatchFreshStart deliberately
// PRESERVES the sidecar until the replacement turn succeeds and overwrites it,
// so a failed replacement still has the old warm-resume anchor to fall back on.

// releaseSession kills the live CLI (if any) and drops the in-memory
// session, but PRESERVES the on-disk sidecar. This is the handle-release
// teardown: it runs when a Conversation handle is evicted from the
// server's conversationCache — graceful server shutdown, a mid-conversation
// model switch, or the desktop app stopping a server as a window closes.
// In every one of those cases the conversation still exists on disk and
// will be reopened later; keeping the sidecar lets that next turn
// --resume the saved session warm instead of cold-starting the whole
// history (the "no prior session" cache-miss). Per-conversation state
// lives on this *Client (one Client per conversation via
// conversationCache), so no global map mutation is needed.
func (c *Client) releaseSession() {
	c.activeSession.tearDownLiveCLI()
	c.activeSession = nil
}

// dropSession is releaseSession plus deletion of the durable sidecar, so
// the next request starts completely fresh (new sessionUUID, no resume).
// Reserved for the cases where the stored anchor is no longer safe to
// resume — a malformed tool_use stop with no ids (dispatch.go) and hard turn
// errors (re-resuming a half-broken session is risky). It is NOT a cancel
// path: a user interrupt preserves the warm anchor (see cancelSession), and
// routine handle release keeps the sidecar (see releaseSession). Permanent
// conversation deletion needs neither: the session store removes the whole
// conv folder, sidecar included.
func (c *Client) dropSession(conversationID string) {
	c.releaseSession()
	c.deleteSidecar(conversationID)
}
