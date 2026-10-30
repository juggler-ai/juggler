//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"strings"
	"testing"
	"time"
)

// A reply that takes most of ContextTimeout "coming back" has waited in the
// inbox behind slow run() iterations. These pin the line that names them.

func TestDescribeSlowIterationSplitsEventFromReconcile(t *testing.T) {
	desc, ok := describeSlowIteration(slowIteration{
		event: "message yjs-sync", handled: 40 * time.Millisecond, reconcile: 600 * time.Millisecond, passes: 3,
	})
	if !ok {
		t.Fatalf("a 640ms iteration must be reported")
	}
	for _, want := range []string{"message yjs-sync", "640ms", "40ms", "600ms", "3 reconcile"} {
		if !strings.Contains(desc, want) {
			t.Errorf("description %q missing %q", desc, want)
		}
	}
}

func TestDescribeSlowIterationCountsTheReconcileAgainstTheThreshold(t *testing.T) {
	// An event that is quick to handle but triggers a long reducer drain holds
	// the inbox just as long, so the two halves are judged together.
	if _, ok := describeSlowIteration(slowIteration{
		event: "items change", handled: slowLoopIteration / 2, reconcile: slowLoopIteration / 2, passes: 1,
	}); !ok {
		t.Errorf("an iteration at the threshold, split across event and reconcile, must be reported")
	}
}

func TestDescribeSlowIterationIsSilentWhenHealthy(t *testing.T) {
	if desc, ok := describeSlowIteration(slowIteration{
		event: "liveness tick", handled: 2 * time.Millisecond, reconcile: 5 * time.Millisecond, passes: 1,
	}); ok {
		t.Errorf("a healthy iteration must not be reported, got %q", desc)
	}
}

// TestDescribeSlowIterationNamesTheBacklog: a slow iteration matters because of
// what queues behind it, and a message that waited minutes before it was even
// picked up is the backlog's own evidence. Without both, a [roundtrip] line's
// "coming back" time cannot be traced to the inbox.
func TestDescribeSlowIterationNamesTheBacklog(t *testing.T) {
	desc, ok := describeSlowIteration(slowIteration{
		event: "message engine-trace", handled: 300 * time.Millisecond, passes: 1,
		waited: 125 * time.Second, depth: 4321,
	})
	if !ok {
		t.Fatalf("a 300ms iteration must be reported")
	}
	for _, want := range []string{"waited 125000ms in the inbox", "4321 queued"} {
		if !strings.Contains(desc, want) {
			t.Errorf("description %q missing %q", desc, want)
		}
	}
}
