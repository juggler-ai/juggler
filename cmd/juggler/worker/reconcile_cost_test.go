//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"runtime"
	"strings"
	"testing"
)

// The run() loop drains the reducer after every event it handles, and every
// reply a turn waits on queues behind those drains in the one inbox. A pass
// whose cost grows with what the sub-threads have SAID — their transcripts,
// their tool output — rather than with how many there are makes a long
// multi-thread conversation slower on every event until context/tools replies
// miss ContextTimeout. The reducer decides on types, states and run records;
// none of that is in a transcript's payload, so a pass must not touch it.
//
// Measured in bytes allocated rather than time, because copying a payload is
// what reading it costs here. The counter is process-wide, so anything else
// running — a sibling test's goroutines, the race detector stretching the
// window they have — adds to a sample and nothing subtracts from one. The
// least of several passes is therefore the closest reading of the pass alone.

// reconcilePassSamples is how many measured passes the least is taken over.
const reconcilePassSamples = 5

// reconcilePassBytes returns the fewest bytes one reducer pass allocated, over
// reconcilePassSamples passes, on a conversation holding one settled delegated
// sub-thread whose transcript carries payloadBytes of assistant text.
func reconcilePassBytes(t *testing.T, payloadBytes int) uint64 {
	t.Helper()
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.doc.ensureItems()
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.currentRun().storeState(StateProcessing)

	threadID, err := w.currentRun().spawnThread(threadSpec{Goal: "audit", Prompt: "audit the worker"}, toolSpawn{
		ToolUseID: "tu-1", ToolName: "create_thread", ToolInput: json.RawMessage(`{"prompt":"audit the worker"}`), Delegated: true,
	})
	if err != nil {
		t.Fatalf("createThread: %v", err)
	}
	w.turn.thread.itemID = threadID
	w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(threadID)
	w.currentRun().appendTargetMessage(ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: strings.Repeat("x", payloadBytes),
	})
	w.currentRun().resetThreadContext()
	w.settleThreadRun(threadID, false)
	w.currentRun().storeState(StateIdle)

	r := w.currentRun()
	// One warm pass first, so lazily built state is not billed to the measured one.
	w.needsReconcile.Store(true)
	r.tryReconcile()

	var least uint64
	for i := 0; i < reconcilePassSamples; i++ {
		// No runtime.GC() first: TotalAlloc counts every allocation whether or
		// not it has been collected, and a forced cycle on a saturated machine
		// under -race can wait minutes for its turn.
		var before, after runtime.MemStats
		w.needsReconcile.Store(true)
		runtime.ReadMemStats(&before)
		r.tryReconcile()
		runtime.ReadMemStats(&after)
		if got := after.TotalAlloc - before.TotalAlloc; i == 0 || got < least {
			least = got
		}
	}
	return least
}

func TestReconcilePassCostIsIndependentOfSubThreadTranscriptSize(t *testing.T) {
	const payload = 8 << 20
	small := reconcilePassBytes(t, 16)
	large := reconcilePassBytes(t, payload)
	// A pass that reads the transcript copies the payload several times over (a
	// serialise-and-parse round trip is five copies), so half of one copy is far
	// below the failure and far above the noise left in the least sample.
	if grew := int64(large) - int64(small); grew > payload/2 {
		t.Errorf("a reducer pass allocated %d bytes more with a %d-byte sub-thread transcript than with a 16-byte one (%d vs %d): it is reading the transcript's payload",
			grew, payload, large, small)
	}
}
