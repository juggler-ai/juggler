//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/utils"
	"juggler/internal/userpaths"
)

// displayName labels a claudecode model for the UI: the readable model name
// prefixed with the "Claude" family (the CLI's ids are bare — "opus", "sonnet")
// and qualified with the route it takes, so it reads distinctly from the same
// model reached via the Anthropic API. The naming lives here because it is this
// provider's decision, not the app's.
func displayName(id string) string {
	name := utils.ModelDisplayName(id)
	if !strings.HasPrefix(strings.ToLower(name), "claude") {
		name = "Claude " + name
	}
	return name + " (CLI)"
}

// Info returns provider metadata. Registered with the global provider
// registry at package-init time via Register() in session_manager.go.
func Info() provider.ProviderInfo {
	return provider.ProviderInfo{
		Name:          "claudecode",
		DisplayName:   "Anthropic (Claude Code CLI)",
		Description:   msg.New("Processes requests by invoking the claude CLI tool (so you can use a Max/Pro plan). The CLI must be signed in — run claude in a terminal and use /login. For better results use the Anthropic API via a key."),
		ConfigKeyName: "", // No API key needed - uses CLI's OAuth
		AutoDetect:    detectClaudeCLI,
		// AutoDetect only answers "is the binary there". A CLI that is installed
		// but not signed in is indistinguishable to it, which is how an expired
		// login stayed invisible until a turn failed. ReadinessCheck carries that
		// second question; see readinessOf for why it refuses only on
		// evidence from a real turn.
		ReadinessCheck:           func() (bool, msg.Message) { return readinessOf(account{}) },
		ResolveModelCapabilities: conservativeAliasCapabilities,
		// Learn-on-first-turn: a verbatim custom model id resolves no static
		// capabilities, and the CLI only reports its real window/output limits
		// after it runs once. Without this, fail-closed admission would reject
		// that first turn and the live values could never populate; the
		// Anthropic API behind the CLI remains the enforcing backstop. The
		// known aliases above keep static+live limits and stay fully admitted.
		AllowUnknownLimits: true,
		// The CLI's bare Haiku alias — a first-class entry in ListModelsWithInfo,
		// so it matches exactly. Fast/cheap tier for out-of-band micro-tasks.
		CheapModel: "haiku",
		// The provider IS a subprocess, run in the conversation's own directory,
		// so it can only serve a workspace this machine is able to spawn into.
		SpawnsLocalProcess: true,
		// The CLI has no per-request max_tokens knob (see streamMessage).
		FixedOutputCap: true,
	}
}

const (
	conservativeContextWindowTokens = 200000
	claudeCodeOverheadTokens        = 40000
)

func conservativeAliasCapabilities(model string) (provider.ModelCapabilities, bool) {
	maxOutputTokens := map[string]int64{
		"opus":   32000,
		"sonnet": 64000,
		"haiku":  32000,
		"fable":  64000,
	}[model]
	if maxOutputTokens == 0 {
		return provider.ModelCapabilities{}, false
	}
	return provider.ModelCapabilities{
		ContextWindowTokens:    conservativeContextWindowTokens,
		MaxOutputTokens:        maxOutputTokens,
		ProviderOverheadTokens: claudeCodeOverheadTokens,
	}, true
}

// ListModelsWithInfo returns available Claude models. We don't hardcode a
// context window: the CLI reports the model's true window (1M for opus/sonnet,
// 200k for others — and the numbers shift as Anthropic ships changes), so any
// guess we bake in is frequently wrong. Instead the window stays unknown
// (ContextWindow 0) until the first turn parses
// `modelUsage[<full-model-id>].contextWindow / maxOutputTokens` from the CLI's
// result event and caches it via updateCachedModelInfo. The learned values are
// persisted to disk (see modelInfoStorePath) and reloaded at startup, so a
// server restart or watchdog re-exec doesn't blank the gauge back to unknown —
// only a brand-new install shows nothing, and only until its first turn. UI
// that consumes the window treats 0 as "unknown" and shows nothing rather than
// a placeholder. MaxOutputTokens keeps a family-typical default because the CLI
// request needs one up front; it too is corrected from the result event.
//
// Caveat: contextWindow reported by the CLI is the model's full window. The
// CLI itself eats ~30–35k of that for its system prompt + tool defs + memory
// paths before the user's conversation starts. juggler's "% of context used"
// gauge will under-report by that amount; treating the figure as an upper
// bound is the right mental model.
func (c *Client) ListModelsWithInfo(ctx context.Context) ([]provider.ModelInfo, error) {
	// opus/sonnet/haiku map to multimodal Claude families (image input). "fable"
	// is left text-only by convention until its image support is verified.
	imageInput := []string{"text", "image"}
	// All four base families expose the claude CLI's native reasoning-effort
	// levels (low/medium/high/xhigh/max — see claudecodeEffortLevels), passed
	// through verbatim via CLAUDE_CODE_EFFORT_LEVEL. We do NOT advertise "off" and
	// leave DefaultThinkingLevel empty on purpose: with no level set the CLI
	// decides adaptively (extended thinking is triggered by "think"-family
	// keywords in the prompt, not forced off), so "Default" is the honest label,
	// and the CLI has no distinct "off" effort we could send. The level list comes
	// from thinkingLevelsFor, the single source of truth shared with the spawn
	// path, so the advertised set and the accepted set can never drift.
	bases := []provider.ModelInfo{
		{ID: "opus", ContextWindow: 0, MaxOutputTokens: 32000, FromAPI: false, InputModalities: imageInput, ThinkingLevels: thinkingLevelsFor("opus")},
		{ID: "sonnet", ContextWindow: 0, MaxOutputTokens: 64000, FromAPI: false, InputModalities: imageInput, ThinkingLevels: thinkingLevelsFor("sonnet")},
		{ID: "haiku", ContextWindow: 0, MaxOutputTokens: 32000, FromAPI: false, InputModalities: imageInput, ThinkingLevels: thinkingLevelsFor("haiku")},
		{ID: "fable", ContextWindow: 0, MaxOutputTokens: 64000, FromAPI: false, ThinkingLevels: thinkingLevelsFor("fable")},
	}
	out := make([]provider.ModelInfo, 0, len(bases))
	for _, base := range bases {
		base.DisplayName = displayName(base.ID)
		if cached, ok := getCachedModelInfo(base.ID); ok {
			if cached.ContextWindow > 0 {
				base.ContextWindow = cached.ContextWindow
			}
			if cached.MaxOutputTokens > 0 {
				base.MaxOutputTokens = cached.MaxOutputTokens
			}
		}
		out = append(out, base)
	}
	return out, nil
}

// modelInfoCache is the dynamic model-spec cache, owned by a dedicated actor
// goroutine. The CLI reports `modelUsage[<full-id>].contextWindow /
// maxOutputTokens` on every result event; we apply those to the alias
// ("sonnet" | "opus" | "haiku" | "fable", or any verbatim model the user
// configured) the user requested so ListModelsWithInfo returns current
// numbers without a hardcoded model-version table.
//
// All access flows through modelInfoCh so we don't need a mutex.
type modelInfoOp struct {
	opType          string // "get" | "update" | "sethook"
	alias           string
	contextWindow   int
	maxOutputTokens int
	hook            func()                  // for "sethook"
	response        chan provider.ModelInfo // for "get"
}

var (
	modelInfoOps   = make(chan modelInfoOp)
	modelInfoStart sync.Once
)

// modelInfoCh is the model-info actor's mailbox, and starts the actor on first
// use — so a process that never asks Claude Code about a model never runs it,
// nor reads its on-disk cache. Every send goes through here rather than to
// modelInfoOps, which nothing would ever receive from until the actor runs.
func modelInfoCh() chan<- modelInfoOp {
	modelInfoStart.Do(func() { go runModelInfoActor() })
	return modelInfoOps
}

// runModelInfoActor owns the cache. Per-conversation session state lives on
// each *Client (bound 1:1 to a Conversation by the server's
// conversationCache), not here.
func runModelInfoActor() {
	cache := loadModelInfoCache()
	var changed func()
	for op := range modelInfoOps {
		switch op.opType {
		case "get":
			op.response <- cache[op.alias]
		case "sethook":
			changed = op.hook
		case "update":
			cur := cache[op.alias]
			dirty := false
			if op.contextWindow > 0 && op.contextWindow != cur.ContextWindow {
				cur.ContextWindow = op.contextWindow
				dirty = true
			}
			if op.maxOutputTokens > 0 && op.maxOutputTokens != cur.MaxOutputTokens {
				cur.MaxOutputTokens = op.maxOutputTokens
				dirty = true
			}
			cur.ID = op.alias
			cache[op.alias] = cur
			if dirty {
				// First turn against an alias is when the CLI reveals its true
				// window. Persist so a restart keeps it, then notify so the
				// server rebroadcasts the provider list and the UI's context
				// gauge fills in. Re-reports of the same numbers are no-ops. Run
				// the hook off the actor goroutine — it calls back into the
				// provider list (and thus this actor).
				saveModelInfoCache(cache)
				if changed != nil {
					go changed()
				}
			}
		}
	}
}

// modelInfoStorePath is the global on-disk cache of CLI-learned model specs,
// keyed by alias. Regenerable (re-learned on the next turn), so it lives under
// the cache dir. Global (not per-project) because the window is a property of
// the model/account, not the workspace.
func modelInfoStorePath() string {
	return filepath.Join(userpaths.CacheDir(), "claudecode-model-info.json")
}

// persistedModelInfo is the on-disk shape — just the learned numbers, not the
// transient ID/FromAPI fields ListModelsWithInfo fills in.
type persistedModelInfo struct {
	ContextWindow   int `json:"contextWindow,omitempty"`
	MaxOutputTokens int `json:"maxOutputTokens,omitempty"`
}

// loadModelInfoCache reads the persisted specs into a fresh cache. Any error
// (missing file, bad JSON) yields an empty cache — the numbers re-learn on the
// next turn. Called once at actor start, so access stays single-goroutine.
func loadModelInfoCache() map[string]provider.ModelInfo {
	cache := map[string]provider.ModelInfo{}
	path := modelInfoStorePath()
	if path == "" {
		return cache
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return cache
	}
	var stored map[string]persistedModelInfo
	if err := json.Unmarshal(data, &stored); err != nil {
		return cache
	}
	for alias, info := range stored {
		if alias == "" || (info.ContextWindow == 0 && info.MaxOutputTokens == 0) {
			continue
		}
		cache[alias] = provider.ModelInfo{
			ID:              alias,
			ContextWindow:   info.ContextWindow,
			MaxOutputTokens: info.MaxOutputTokens,
		}
	}
	return cache
}

// saveModelInfoCache writes the cache to disk best-effort. Called only from the
// actor goroutine on a real change (rare — once per alias per learn), so it
// needs no locking and the write cost is immaterial.
func saveModelInfoCache(cache map[string]provider.ModelInfo) {
	path := modelInfoStorePath()
	if path == "" {
		return
	}
	stored := make(map[string]persistedModelInfo, len(cache))
	for alias, info := range cache {
		stored[alias] = persistedModelInfo{
			ContextWindow:   info.ContextWindow,
			MaxOutputTokens: info.MaxOutputTokens,
		}
	}
	data, err := json.MarshalIndent(stored, "", "  ")
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	_ = os.WriteFile(path, data, 0o644)
}

// SetModelInfoChangedHook registers a callback fired whenever a model's cached
// context window or max-output tokens changes value (learned from the CLI's
// result event). The server wires this to RefreshProviders so the freshly
// learned window propagates to clients via the providers-update broadcast.
// Pass nil to clear. Safe to call once at startup before any turns run.
func SetModelInfoChangedHook(fn func()) {
	modelInfoCh() <- modelInfoOp{opType: "sethook", hook: fn}
}

func getCachedModelInfo(alias string) (provider.ModelInfo, bool) {
	resp := make(chan provider.ModelInfo, 1)
	modelInfoCh() <- modelInfoOp{opType: "get", alias: alias, response: resp}
	info := <-resp
	return info, info.ID != ""
}

// selectModelUsage picks the single modelUsage entry a turn should learn its
// window/output limits from, given the canonical alias the turn ran as. The map
// is keyed by full model id and often carries more than the requested model
// (the CLI co-bills a background model such as haiku), so we cannot learn from
// every entry — a co-billed model's smaller window would clobber the requested
// model's. Rules, in order:
//
//   - Prefer the entry whose family (canonicalAlias of its full-id key) matches
//     the requested alias — that is unambiguously this turn's model.
//   - Otherwise, if exactly one model was billed, use it: a lone entry is the
//     turn's model even when its resolved full id doesn't string-match a
//     verbatim custom alias, so learn-on-first-turn still works for custom ids.
//   - Otherwise return false: with multiple co-billed models and no family
//     match, attribution is ambiguous, so learn nothing rather than guess.
//
// Pure and side-effect free so the attribution logic is unit-testable without
// the cache actor.
func selectModelUsage(modelUsage map[string]*ModelUsageDetail, alias string) (*ModelUsageDetail, bool) {
	var lone *ModelUsageDetail
	loneCount := 0
	for fullID, mu := range modelUsage {
		if mu == nil {
			continue
		}
		if canonicalAlias(fullID) == alias {
			return mu, true
		}
		lone = mu
		loneCount++
	}
	if loneCount == 1 {
		return lone, true
	}
	return nil, false
}

func updateCachedModelInfo(alias string, contextWindow, maxOutputTokens int) {
	if alias == "" || (contextWindow == 0 && maxOutputTokens == 0) {
		return
	}
	modelInfoCh() <- modelInfoOp{
		opType:          "update",
		alias:           alias,
		contextWindow:   contextWindow,
		maxOutputTokens: maxOutputTokens,
	}
}
