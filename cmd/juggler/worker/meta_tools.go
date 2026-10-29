//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
)

// isMetaTool checks if a tool name is a meta tool (built-in tools that execute in worker).
func isMetaTool(toolName string) bool {
	return toolName == "drop_context_items"
}

// executeMetaTool executes a meta tool directly in the worker.
// Meta tools are built-in operations that manipulate Yjs state (set metadata, drop context items).
// They execute instantly and don't need frontend approval or action execution.
func (r *run) executeMetaTool(toolUseID, toolName string, toolInput json.RawMessage) error {
	var input map[string]any
	if err := json.Unmarshal(toolInput, &input); err != nil {
		return fmt.Errorf("failed to parse meta tool input: %w", err)
	}

	var (
		message string
		execErr error
	)
	switch toolName {
	case "drop_context_items":
		message, execErr = r.execDropContextItems(input)
	default:
		execErr = fmt.Errorf("unknown meta tool: %s", toolName)
		message = fmt.Sprintf("Error: %v", execErr)
	}

	r.addThinkingMessage(message)
	r.addMetaToolResult(toolUseID, toolName, toolInput, message, execErr != nil)

	return execErr
}

// execDropContextItems handles the drop_context_items meta tool: it deletes the
// context items whose itemId appears in the input set. Returns the log message
// and an error for malformed input.
func (w *ConversationWorker) execDropContextItems(input map[string]any) (string, error) {
	rawIDs, ok := input[keyItemIDs].([]any)
	if !ok {
		err := fmt.Errorf("drop_context_items: invalid itemIds input (expected array)")
		return fmt.Sprintf("Error: %v", err), err
	}

	// Build a set so matching is O(n+m), not O(n×m).
	wanted := make(map[string]bool, len(rawIDs))
	for _, id := range rawIDs {
		if idStr, ok := id.(string); ok {
			wanted[idStr] = true
		}
	}

	var indicesToDelete []int
	for i, item := range w.doc.GetItems() {
		if item.ItemID != "" && wanted[item.ItemID] {
			indicesToDelete = append(indicesToDelete, i)
		}
	}
	if len(indicesToDelete) > 0 {
		w.tracker.DeleteMessages(indicesToDelete)
	}
	return fmt.Sprintf("Dropped %d context items", len(indicesToDelete)), nil
}
