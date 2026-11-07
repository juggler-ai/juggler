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

// Shell commands the user types as `! cmd` (or `/shell cmd`).
//
// The command rides the send-message as ShellCommand and is posted as an
// ordinary `bash` tool-action, placed exactly where a skill preload is (see
// skill_preload.go and handleSendMessage): after the user message, or alone
// with no turn requested, or on the pending queue while a turn is in flight.
// From there it is any other bash call — the engine runs it, its output streams
// into the properties panel, and it is stopped as any running call is.
//
// It is created already approved: the user typed it, so there is nothing to
// ask. Its description tells the model the call is the user's, not one of its
// own. And it asks for no turn, wherever it lands: a finished one is not a
// result the model owes a reply to (isUserShellAction).

// userShellTimeoutMs is the full execution cap (maxExecTimeoutMs in
// ops/shell_exec.go): a test run or an audit takes minutes, and the user has
// Stop for anything that should end sooner.
const userShellTimeoutMs = 1200000

// userShellDescription is the bash call's description: the model reads it in
// the call's input, and the tile shows it under the command.
const userShellDescription = "Run by the user"

// userShellToolUseIDPrefix starts the tool-use id of every user shell command.
// The id is the call's mark: isUserShellAction reads it, and so does the
// browser (USER_SHELL_TOOL_USE_ID_PREFIX in web/js/services/shell-shortcut.js),
// to show a queued command in the queued zone.
const userShellToolUseIDPrefix = "usershell_"

// generateShellToolUseID mints a unique tool-use id for a user's shell command,
// distinguishable in logs/tape from a model-issued call.
func generateShellToolUseID() string {
	id := idCounter.Add(1)
	return fmt.Sprintf("%s%d_%09d", userShellToolUseIDPrefix, time.Now().UnixMilli(), id)
}

// isUserShellAction reports whether item is a user's shell command. Its result
// asks for no turn: it is news to the model, read on the next turn something
// else asks for, never work to answer (decideNextAction, promotePendingItems).
func isUserShellAction(item ConversationItem) bool {
	return isUserShellToolAction(item.Type, item.ToolUseID)
}

// isUserShellToolAction is isUserShellAction on an item's type and tool-use id.
func isUserShellToolAction(itemType, toolUseID string) bool {
	return itemType == ItemTypeToolAction && strings.HasPrefix(toolUseID, userShellToolUseIDPrefix)
}

// allUserShellActions reports whether batch is non-empty and holds only the
// user's shell commands.
func allUserShellActions(batch []ConversationItem) bool {
	return len(batch) > 0 && turnAskingCount(batch) == 0
}

// turnAskingCount is how many of items ask for a turn: all but the user's
// shell commands.
func turnAskingCount(items []ConversationItem) int {
	n := 0
	for _, item := range items {
		if !isUserShellAction(item) {
			n++
		}
	}
	return n
}

// newShellToolAction builds the approved bash tool-action for one command.
func newShellToolAction(command string) ConversationItem {
	input, _ := json.Marshal(map[string]any{
		keyCommand:     command,
		keyDescription: userShellDescription,
		keyTimeout:     userShellTimeoutMs,
	})
	return ConversationItem{
		Type:      ItemTypeToolAction,
		ItemID:    generateItemID(),
		ToolUseID: generateShellToolUseID(),
		ToolName:  "bash",
		ToolInput: json.RawMessage(input),
		State:     StateApproved,
		Timestamp: time.Now().Format(time.RFC3339),
	}
}

// sendPreloads is every tool-action a send asks to post ahead of the
// assistant's response: a `skill` load per chosen skill, then the user's shell
// command. Empty when the send carries neither.
func sendPreloads(skills []string, shellCommand string) []ConversationItem {
	out := make([]ConversationItem, 0, len(skills)+1)
	for _, name := range skills {
		out = append(out, newSkillToolAction(name))
	}
	if command := strings.TrimSpace(shellCommand); command != "" {
		out = append(out, newShellToolAction(command))
	}
	return out
}
