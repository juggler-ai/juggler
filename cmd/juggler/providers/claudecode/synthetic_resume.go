//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Synthetic --resume support for cold-starting the CLI without losing
// assistant history. The stream-json input parser drops fed assistant
// blocks (and Claude is trained to reject fabricated ones as injected
// content), so we materialise prior turns as a JSONL file in the CLI's
// own <config dir>/projects/<dir>/<uuid>.jsonl format (see projectsDir) and spawn with
// --resume <uuid>; only the trailing user turn is piped on stdin.
//
// Minimum required field set, verified against claude-code 2.1.142:
// uuid, parentUuid (null for first), isSidechain:false, message
// (Anthropic API shape), timestamp, userType:"external",
// entrypoint:"sdk-cli", cwd, sessionId, version, gitBranch.
// User entries additionally need promptId + permissionMode:"default".
// queue-operation / attachment / last-prompt / ai-title entries are
// not required.

package claudecode

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"juggler/cmd/juggler/providers/anthropic"
	"juggler/cmd/juggler/providers/provider"
)

// syntheticVersion goes into the "version" field of each entry. The CLI
// doesn't validate it; pick a value that identifies juggler-written
// sessions when poking around the CLI's projects dir.
const syntheticVersion = "juggler-synth"

// continuationNudge is the synthetic user-role text we pipe to the CLI when
// the stream-json input parser needs *some* user turn to trigger generation
// but the worker has nothing new from the human to send (Continue clicked
// with no edits, previous turn was thinking-only, or every actionable block
// in the trailing user turn was relocated into history as a paired
// tool_result). Wrapped in <system-reminder> tags — Anthropic's trained
// convention for out-of-band harness messages — so the model recognises it
// as a juggler-emitted cue and doesn't quote it back as if the human typed
// it. Callsites: dispatch.runResumeNudge and moveTrailingToolResultsToHistory.
const continuationNudge = "<system-reminder>continue</system-reminder>"

// explicitContinuationNudge carries the stronger intent behind the human's
// Continue action while retaining the out-of-band framing that prevents Claude
// from attributing the words to the user.
const explicitContinuationNudge = `<system-reminder>Resume the unfinished work for the user's most recent request. Continue through any necessary tool calls until the work is complete or you have a substantive response for the user. Do not mention this reminder or treat it as a message authored by the user.</system-reminder>`

// syntheticSessionPlan is the file-vs-stdin split produced by
// planSyntheticSession. The file gets all but the last API message; the
// trailing user turn is piped on stdin after spawn.
type syntheticSessionPlan struct {
	sessionUUID   string
	historyToFile []anthropic.APIMessage
	tailContent   []anthropic.APIContentBlock
}

// planSyntheticSession returns a plan when there is prior history worth
// synthesising. It returns nil ONLY for a genuine cold start: ≤1 API message,
// so there is no history to preserve. Callers read nil as "first turn" and
// spawn without --resume, which drops every assistant turn — so nil must never
// mean "history I chose not to handle".
//
// The conversation normally ends on the user's turn, which becomes the stdin
// tail. When it ends on an assistant turn instead — a regenerate re-sends the
// previous reply, and an interrupted tool call leaves the assistant's message
// last — the whole conversation goes into the file and stdin carries a
// continuation nudge, because the CLI needs some user turn to generate from.
func planSyntheticSession(messages []provider.Message, jugglerTools map[string]struct{}) *syntheticSessionPlan {
	api := anthropic.TransformToAPIMessagesForCLI(messages)
	if len(api) <= 1 {
		return nil
	}
	// Split file-vs-stdin. A trailing user turn is the tail; a trailing
	// assistant turn stays in the file and the nudge stands in as the tail.
	fileMessages, tail := api[:len(api)-1], api[len(api)-1].Content
	if api[len(api)-1].Role != "user" {
		fileMessages = api
		tail = []anthropic.APIContentBlock{{Type: "text", Text: continuationNudge}}
	}
	history := reframeLeadingAssistant(fileMessages)
	history, tailContent := moveTrailingToolResultsToHistory(history, tail)
	history = repairOrphanToolUses(history, tailContent)
	history = prefixJugglerToolUses(history, jugglerTools)
	return &syntheticSessionPlan{
		sessionUUID:   newSyntheticSessionUUID(),
		historyToFile: history,
		tailContent:   tailContent,
	}
}

// jugglerToolNameSet builds a lookup of the bare tool names juggler exposes
// through its in-process MCP server (from the tool list handed to the CLI on
// tools/list). prefixJugglerToolUses consults it to decide which historical
// tool_use names belong to juggler and therefore need re-prefixing.
func jugglerToolNameSet(tools []provider.ToolDefinition) map[string]struct{} {
	set := make(map[string]struct{}, len(tools))
	for _, t := range tools {
		set[t.Name] = struct{}{}
	}
	return set
}

// prefixJugglerToolUses rewrites assistant tool_use block names from juggler's
// canonical bare form (e.g. "bash", "edit") back to the mcp__juggler__-prefixed
// form the CLI exposes to the model and records in its OWN native session
// files. The synthetic session file masquerades as a CLI-native session, so
// each tool_use name must match what the model actually emitted — the prefixed
// name. Left bare, on resume the model imitates the bare names from its own
// history; the CLI only knows mcp__juggler__* (everything else is
// --disallowedTools) and rejects the call with "No such tool available:
// <name>", so the model re-issues it and re-runs the already-applied side
// effect.
//
// Only names in the juggler tool set are prefixed. A Claude-native tool that
// slipped past --disallowedTools (an orphan) keeps its bare native name —
// that's exactly how the CLI itself would have recorded it.
func prefixJugglerToolUses(history []anthropic.APIMessage, jugglerTools map[string]struct{}) []anthropic.APIMessage {
	if len(jugglerTools) == 0 {
		return history
	}
	out := make([]anthropic.APIMessage, len(history))
	copy(out, history)
	for i := range out {
		if out[i].Role != "assistant" {
			continue
		}
		var rewritten []anthropic.APIContentBlock
		for j, b := range out[i].Content {
			if b.Type != "tool_use" {
				continue
			}
			if _, ok := jugglerTools[b.Name]; !ok || strings.HasPrefix(b.Name, mcpToolPrefix) {
				continue
			}
			// Copy-on-write: only clone this message's blocks once we know a
			// rename is needed, so untouched messages keep sharing their slice.
			if rewritten == nil {
				rewritten = append([]anthropic.APIContentBlock(nil), out[i].Content...)
			}
			rewritten[j].Name = mcpToolPrefix + b.Name
		}
		if rewritten != nil {
			out[i].Content = rewritten
		}
	}
	return out
}

// moveTrailingToolResultsToHistory closes any open tool_use at the end
// of history by relocating its matching tool_result from the tail into a
// new user entry appended to history. When the loaded session ends with
// an assistant tool_use, the claudecode CLI expects the result via its
// stdio control protocol — feeding it as a user-message tool_result on
// stdin instead leaves the CLI's session out of sync.
//
// By relocating those tool_results into history, the file ends with
// `user: tool_result` — a fully-paired tool call — and the stdin tail
// becomes whatever non-tool_result blocks remained (typically the
// user's actual question text). Returns the updated history and the
// trimmed tail content.
func moveTrailingToolResultsToHistory(history []anthropic.APIMessage, tail []anthropic.APIContentBlock) ([]anthropic.APIMessage, []anthropic.APIContentBlock) {
	if len(history) == 0 || history[len(history)-1].Role != "assistant" {
		return history, tail
	}
	openToolUseIDs := map[string]struct{}{}
	for _, b := range history[len(history)-1].Content {
		if b.Type == "tool_use" {
			openToolUseIDs[b.ID] = struct{}{}
		}
	}
	if len(openToolUseIDs) == 0 {
		return history, tail
	}

	var moved, remaining []anthropic.APIContentBlock
	for _, b := range tail {
		if b.Type == "tool_result" {
			if _, ok := openToolUseIDs[b.ToolUseID]; ok {
				moved = append(moved, b)
				continue
			}
		}
		remaining = append(remaining, b)
	}
	if len(moved) == 0 {
		return history, tail
	}
	out := make([]anthropic.APIMessage, 0, len(history)+1)
	out = append(out, history...)
	out = append(out, anthropic.APIMessage{Role: "user", Content: moved})
	// stdin can't be empty — the CLI ignores a zero-content user message.
	// If everything actionable moved into history, synthesise a minimal
	// nudge so the model has something to respond to.
	if len(remaining) == 0 {
		remaining = []anthropic.APIContentBlock{{Type: "text", Text: continuationNudge}}
	}
	return out, remaining
}

// repairOrphanToolUses ensures every assistant tool_use has a matching
// user tool_result, splicing in a synthetic error result for any dangling
// tool_use. Anthropic's API rejects requests where a tool_use isn't
// followed by its tool_result before the next user message. The common
// cause of orphans is a Claude-native tool that juggler doesn't handle
// (so no result was ever produced) slipping past --disallowedTools.
//
// tailContent is the user message that will be piped to stdin after the
// resumed file is loaded. Its tool_results are part of the API request
// the CLI will eventually build, so they count toward "satisfied"
// tool_uses — without considering them, the repair adds a duplicate
// synthetic tool_result and Anthropic rejects for double-pairing instead.
//
// Walks in reverse so insertions don't shift the indices we still need
// to visit. For each orphan tool_use found in an assistant message,
// either prepends a tool_result to the user message immediately after,
// or inserts a fresh synthetic user message if no user follows.
func repairOrphanToolUses(history []anthropic.APIMessage, tailContent []anthropic.APIContentBlock) []anthropic.APIMessage {
	resultIDs := map[string]struct{}{}
	for _, m := range history {
		if m.Role != "user" {
			continue
		}
		for _, b := range m.Content {
			if b.Type == "tool_result" {
				resultIDs[b.ToolUseID] = struct{}{}
			}
		}
	}
	for _, b := range tailContent {
		if b.Type == "tool_result" {
			resultIDs[b.ToolUseID] = struct{}{}
		}
	}

	out := append([]anthropic.APIMessage(nil), history...)
	for i := len(out) - 1; i >= 0; i-- {
		if out[i].Role != "assistant" {
			continue
		}
		var orphans []anthropic.APIContentBlock
		for _, b := range out[i].Content {
			if b.Type != "tool_use" {
				continue
			}
			if _, ok := resultIDs[b.ID]; ok {
				continue
			}
			orphans = append(orphans, anthropic.APIContentBlock{
				Type:      "tool_result",
				ToolUseID: b.ID,
				Content:   "[Tool call not handled by juggler; no result available]",
				IsError:   true,
			})
		}
		if len(orphans) == 0 {
			continue
		}
		if i+1 < len(out) && out[i+1].Role == "user" {
			out[i+1].Content = append(orphans, out[i+1].Content...)
		} else {
			inserted := anthropic.APIMessage{Role: "user", Content: orphans}
			out = append(out[:i+1], append([]anthropic.APIMessage{inserted}, out[i+1:]...)...)
		}
	}
	return out
}

// reframeLeadingAssistant guards against the Anthropic API requirement
// that every request's first message be role=user. After conversation
// compaction the first juggler item is the summary assistant turn, which
// transforms to a leading assistant APIMessage; resuming from a session
// file starting with assistant + a follow-up turn produces a request the
// API rejects (the claudecode CLI swallows that rejection and emits a
// silent end_turn).
//
// Repackages a leading text-only assistant turn as a user
// "Previous conversation summary:" prefix so the resumed history starts
// with a user message. For exotic content (tool_use blocks at the head,
// which shouldn't happen for compaction artefacts), drops the leading
// assistant entirely.
func reframeLeadingAssistant(history []anthropic.APIMessage) []anthropic.APIMessage {
	if len(history) == 0 || history[0].Role != "assistant" {
		return history
	}
	reframed := reframeAssistantAsUserSummary(history[0])
	if reframed == nil {
		return history[1:]
	}
	// Re-establish user/assistant alternation. After turning the leading
	// assistant into a user message, the next entry (if user-role) becomes
	// the second consecutive user — Anthropic's API rejects this and the
	// claudecode CLI silently bails. Splice in an empty assistant between
	// them, mirroring insertEmptyAssistantAPIMessages.
	out := make([]anthropic.APIMessage, 0, len(history)+1)
	out = append(out, *reframed)
	if len(history) > 1 && history[1].Role == "user" {
		out = append(out, anthropic.APIMessage{
			Role: "assistant",
			Content: []anthropic.APIContentBlock{
				{Type: "text", Text: ""},
			},
		})
	}
	out = append(out, history[1:]...)
	return out
}

// reframeAssistantAsUserSummary returns the message rewritten as a
// user turn whose text content is prefixed with a summary header.
// Returns nil if the message contains non-text blocks (e.g. tool_use),
// which can't be safely reframed.
func reframeAssistantAsUserSummary(m anthropic.APIMessage) *anthropic.APIMessage {
	for _, b := range m.Content {
		if b.Type != "text" {
			return nil
		}
	}
	var sb strings.Builder
	sb.WriteString("Previous conversation summary:\n")
	for _, b := range m.Content {
		sb.WriteString(b.Text)
	}
	return &anthropic.APIMessage{
		Role: "user",
		Content: []anthropic.APIContentBlock{
			{Type: "text", Text: sb.String()},
		},
	}
}

// writeSyntheticSession materialises the plan as a JSONL file under
// <projectsDir>/<sessionUUID>.jsonl and returns the absolute
// path. The CLI's own subsequent writes append to this file as a normal
// session. accountDir is the account's config dir, "" for the default account.
func writeSyntheticSession(workingDir, accountDir string, plan *syntheticSessionPlan) (string, error) {
	dir := projectsDir(workingDir, accountDir)
	if dir == "" {
		return "", fmt.Errorf("synthetic resume: no claude config dir (no home dir and no CLAUDE_CONFIG_DIR)")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("synthetic resume: mkdir %s: %w", dir, err)
	}
	path := filepath.Join(dir, plan.sessionUUID+".jsonl")

	var buf strings.Builder
	baseTime := time.Now().Add(-time.Duration(len(plan.historyToFile)) * time.Second).UTC()
	var prevUUID any // nil for the first entry, string thereafter
	for i, m := range plan.historyToFile {
		entryUUID := newSyntheticSessionUUID()
		entry := newSyntheticEntry(m.Role, m.Content, entryUUID, prevUUID, plan.sessionUUID, workingDir,
			baseTime.Add(time.Duration(i)*time.Second))
		line, err := json.Marshal(entry)
		if err != nil {
			return "", fmt.Errorf("synthetic resume: marshal entry %d: %w", i, err)
		}
		buf.Write(line)
		buf.WriteByte('\n')
		prevUUID = entryUUID
	}

	if err := os.WriteFile(path, []byte(buf.String()), 0o644); err != nil {
		return "", fmt.Errorf("synthetic resume: write %s: %w", path, err)
	}
	return path, nil
}

// newSyntheticEntry builds one projects-dir JSONL session entry in the
// CLI's native shape (minimum verified field set — see the file header). role
// is "user" or "assistant"; content is the entry's API content blocks;
// entryUUID identifies it and parentUUID chains it to its predecessor (nil for
// the first entry). User entries additionally carry promptId + permissionMode,
// which the CLI requires. Single-sourced here so writeSyntheticSession (full
// rebuild) and appendToolResultsToWarmSession (one appended entry) can never
// drift in format.
func newSyntheticEntry(role string, content any, entryUUID string, parentUUID any, sessionUUID, workingDir string, ts time.Time) map[string]any {
	entry := map[string]any{
		"type":        role,
		"uuid":        entryUUID,
		"parentUuid":  parentUUID,
		"isSidechain": false,
		"message":     map[string]any{"role": role, "content": content},
		"timestamp":   ts.UTC().Format("2006-01-02T15:04:05.000Z"),
		"userType":    "external",
		"entrypoint":  "sdk-cli",
		"cwd":         workingDir,
		"sessionId":   sessionUUID,
		"version":     syntheticVersion,
		"gitBranch":   "",
	}
	if role == "user" {
		entry["promptId"] = newSyntheticSessionUUID()
		entry["permissionMode"] = "default"
	}
	return entry
}

// tailStdinLine returns the stream-json envelope for the trailing user turn
// to be piped on stdin once --resume has loaded the file.
func tailStdinLine(plan *syntheticSessionPlan) []byte {
	envelope := map[string]any{
		"type":               "user",
		"message":            map[string]any{"role": "user", "content": plan.tailContent},
		"parent_tool_use_id": nil,
		"session_id":         plan.sessionUUID,
	}
	buf, _ := json.Marshal(envelope) // map[string]any with JSON-safe values cannot fail
	return buf
}

// projectsDir returns the directory the claude CLI spawned in workingDir keeps
// that directory's session files in: <config dir>/projects/<dir-form>, or ""
// when there is no config dir to be had (see claudeConfigDir).
func projectsDir(workingDir, accountDir string) string {
	configDir := claudeConfigDir(workingDir, accountDir)
	if configDir == "" {
		return ""
	}
	return filepath.Join(configDir, "projects", projectDirNameFromWorkingDir(workingDir))
}

// claudeConfigDir returns the config dir of a claude CLI spawned in workingDir,
// derived as the CLI derives it: $CLAUDE_CONFIG_DIR when set — which the spawn
// inherits from Juggler's own environment — cleaned, and resolved against the
// CLI's working directory when relative; otherwise ~/.claude. "" when neither
// is set and there is no home directory.
//
// accountDir is an extra account's config dir, which its CLI is given in
// place of all that; "" for the default account.
func claudeConfigDir(workingDir, accountDir string) string {
	if accountDir != "" {
		return accountDir
	}
	if dir := os.Getenv("CLAUDE_CONFIG_DIR"); dir != "" {
		if !filepath.IsAbs(dir) {
			dir = filepath.Join(workingDir, dir)
		}
		return filepath.Clean(dir)
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".claude")
}

// projectDirNameFromWorkingDir maps an absolute working-directory path to the
// directory name the claude CLI uses under its projects dir. It mirrors the
// CLI's own encoder exactly (the `gw` function, verified against claude-code
// 2.1.160): every non-alphanumeric character is replaced with "-" — that
// covers path separators on Unix ("/") and Windows ("\\" and the drive ":"),
// as well as dots, spaces and underscores. If the encoded form exceeds 200
// characters it is truncated to 200 and a hash of the original path is
// appended so distinct long paths stay unique. Matching this byte-for-byte is
// what lets a synthesised JSONL land in the directory the CLI reads on resume.
func projectDirNameFromWorkingDir(workingDir string) string {
	const maxLen = 200 // CLI constant: encoded names longer than this get hashed
	encoded := encodeClaudeProjectSegment(workingDir)
	if len(encoded) <= maxLen {
		return encoded
	}
	return encoded[:maxLen] + "-" + claudeProjectPathHash(workingDir)
}

// encodeClaudeProjectSegment replaces every non-[a-zA-Z0-9] rune with "-",
// matching the CLI's `replace(/[^a-zA-Z0-9]/g,"-")`. (The CLI operates on
// UTF-16 code units; this operates on runes, which agree for every character
// in the basic multilingual plane — i.e. every character that appears in real
// filesystem paths.)
func encodeClaudeProjectSegment(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	return b.String()
}

// claudeProjectPathHash reproduces the CLI's disambiguation hash for over-long
// paths: a 32-bit Java-style string hash (h = h*31 + char, wrapping on
// overflow) of the *original* path, made positive and base-36 encoded.
func claudeProjectPathHash(s string) string {
	var h int32
	for _, r := range s {
		h = h*31 + r
	}
	v := int64(h)
	if v < 0 {
		v = -v
	}
	return strconv.FormatInt(v, 36)
}

// newSyntheticSessionUUID returns a fresh RFC 4122 v4 UUID string. We mint
// our own (not the juggler convID) so synthesised filenames can never
// collide with real claude-written sessions.
func newSyntheticSessionUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// Unrecoverable; fall back to a recognisably non-UUID value so the
		// file is still uniquely named and obviously synthesised.
		return fmt.Sprintf("synth-%d-%s", time.Now().UnixNano(), hex.EncodeToString(b[:4]))
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
