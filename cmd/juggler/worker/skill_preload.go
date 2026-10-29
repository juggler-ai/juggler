//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// User-directed Agent Skill preloads.
//
// When a user explicitly picks a skill in the composer (a `$name` mention or the
// picker button), the selected names ride the send-message as `Skills`. Each is
// loaded by injecting a real `skill` tool-action — byte-identical to one the
// model would emit: undefined state so the engine evaluates it, and because the
// `skill` tool is read/meta it auto-approves and executes through the ordinary
// driveToolActions pipeline, landing the SKILL.md body as a visible tool-result.
//
// Injected AFTER the user message (idle) or ahead of it in the pending queue
// (busy), so the transcript reads user → assistant(skill) → tool_result → reply
// and the skill's instructions are in context before the assistant responds. A
// skills-only send (no prose) injects the actions without requesting an LLM turn
// (see handleSendMessage): the reducer rests on the completed tool-action because
// activity never becomes awaiting_llm, so the skills load with no empty turn.

// generateSkillToolUseID mints a unique tool-use id for an injected skill
// action, distinguishable in logs/tape from a model-issued call.
func generateSkillToolUseID() string {
	id := idCounter.Add(1)
	return fmt.Sprintf("skill_%d_%09d", time.Now().UnixMilli(), id)
}

// newSkillToolAction builds the tool-action ConversationItem for one skill load.
// State is left undefined so the engine evaluates (and auto-approves) it, exactly
// as for a model-issued skill call.
func newSkillToolAction(name string) ConversationItem {
	input, _ := json.Marshal(map[string]string{keyName: name})
	return ConversationItem{
		Type:      ItemTypeToolAction,
		ItemID:    generateItemID(),
		ToolUseID: generateSkillToolUseID(),
		ToolName:  "skill",
		ToolInput: json.RawMessage(input),
		Timestamp: time.Now().Format(time.RFC3339),
	}
}

// dedupSkills trims, drops empties, and removes duplicates while preserving order.
// A repeated name would only produce a redundant "already loaded" tool-action.
func dedupSkills(names []string) []string {
	seen := make(map[string]bool, len(names))
	out := make([]string, 0, len(names))
	for _, n := range names {
		n = strings.TrimSpace(n)
		if n == "" || seen[n] {
			continue
		}
		seen[n] = true
		out = append(out, n)
	}
	return out
}

// injectSkillPreloadsInto appends a `skill` tool-action into dest for each name,
// in order. The caller places it relative to the user message; driveToolActions
// (triggered by the surrounding handleItemsChange) evaluates, approves, and
// executes each.
func (r *run) injectSkillPreloadsInto(dest threadContext, names []string) {
	for _, name := range names {
		item := newSkillToolAction(name)
		r.log.Tool("skill", name)
		r.appendMessageTo(dest, item)
	}
}
