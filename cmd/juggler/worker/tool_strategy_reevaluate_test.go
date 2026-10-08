//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
)

// TestStrategySwitch_ResetsParkedToolsAndOnlyThem pins what a strategy switch
// does to the tools already in the doc: one parked for approval goes back to
// unevaluated with its cached approval form cleared, so the engine decides it
// again under the new policy; one that is already running is left alone.
func TestStrategySwitch_ResetsParkedToolsAndOnlyThem(t *testing.T) {
	w := NewConversationWorker("conv-strategy-switch", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })
	initPayload, _ := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: "conv-strategy-switch"},
		Config:       WorkerConfig{ProjectPath: t.TempDir()},
	})
	w.currentRun().handleInit(initPayload)

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-parked", ToolUseID: "tu-parked",
		ToolName: "bash", State: StatePending,
		ApprovalOptions: json.RawMessage(`{"choices":["allow","deny"]}`),
	})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-running", ToolUseID: "tu-running",
		ToolName: "bash", State: StateRunning,
	})

	// The first pass only records the baseline.
	w.reevaluatePendingToolsOnStrategyChangeExcept(nil)
	if got := toolByID(t, w, "tu-parked"); got.State != StatePending {
		t.Fatalf("the baseline pass reset a parked tool: state=%q", got.State)
	}

	w.doc.SetMetadata("currentStrategyId", "yolo")
	w.reevaluatePendingToolsOnStrategyChangeExcept(nil)

	parked := toolByID(t, w, "tu-parked")
	if parked.State != StateUnevaluated {
		t.Errorf("parked tool after the switch: state=%q, want unevaluated", parked.State)
	}
	if len(parked.ApprovalOptions) != 0 && string(parked.ApprovalOptions) != "null" {
		t.Errorf("parked tool kept its approval form across the switch: %s", parked.ApprovalOptions)
	}
	if got := toolByID(t, w, "tu-running"); got.State != StateRunning {
		t.Errorf("running tool after the switch: state=%q, want running", got.State)
	}
}

func toolByID(t *testing.T, w *ConversationWorker, toolUseID string) ConversationItem {
	t.Helper()
	for _, item := range w.doc.GetItems() {
		if item.ToolUseID == toolUseID {
			return item
		}
	}
	t.Fatalf("no tool-action %s in the doc", toolUseID)
	return ConversationItem{}
}
