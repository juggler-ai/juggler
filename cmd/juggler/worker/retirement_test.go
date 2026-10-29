//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "testing"

func TestRetireIdleCommitsAdmission(t *testing.T) {
	for _, withWorker := range []bool{false, true} {
		m := NewManager()
		if withWorker {
			m.GetOrCreate("idle", "user:test")
		}
		ok, err := m.TryRetire()
		if err != nil || !ok {
			m.Shutdown()
			t.Fatalf("retire idle (worker=%v) = %v, %v", withWorker, ok, err)
		}
		if m.HandleMessage("late", "send-message", nil, nil) {
			t.Error("committed manager admitted a viewer message")
		}
		if w := m.GetOrCreate("late", "user:test"); w != nil {
			t.Error("committed manager created a worker")
		}
		if ids := m.ActiveConversationIDs(); len(ids) != 0 {
			t.Error("committed idle manager must answer health without asking parked workers")
		}
		// Shutdown joins parked workers; it and a second retirement are idempotent.
		if again, err := m.TryRetire(); !again || err != nil {
			t.Errorf("repeated retirement = %v, %v", again, err)
		}
		m.Shutdown()
		m.Shutdown()
	}
}

func TestRetireApprovalRefusesAndResumes(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()
	idle := m.GetOrCreate("idle", "user:test")
	busy := m.GetOrCreate("parked", "user:test")
	busy.doc.InsertMessage(0, ConversationItem{Type: ItemTypeToolAction, ItemID: "pending", ToolUseID: "use", ToolName: "bash", State: StatePending})
	if !busy.requestLLM("") {
		t.Fatal("claim refused")
	}
	if ok, err := m.TryRetire(); ok || err != nil {
		t.Fatalf("approval retirement = %v, %v; want refusal", ok, err)
	}
	if m.AnyActive() {
		t.Error("approval changed quit-warning semantics")
	}
	// FIFO ack proves an idle participant resumed even if it voted before the
	// busy participant. The vote order must not affect rollback.
	if err := idle.SendAndWait(t.Context(), "stop-undo-capturing", nil); err != nil {
		t.Fatal(err)
	}
	if !m.HandleMessage("idle", "stop-undo-capturing", nil, nil) {
		t.Error("refused retirement closed admission")
	}
	// Released, the approval no longer holds the session.
	busy.releaseLLM("")
	if ok, err := m.TryRetire(); !ok || err != nil {
		t.Errorf("retirement after the approval ended = %v, %v", ok, err)
	}
}

func TestRetireProbeParksUntilDecision(t *testing.T) {
	for _, commit := range []bool{false, true} {
		w := NewConversationWorker("park", "user:test")
		decision := &retirementDecision{done: make(chan struct{})}
		p := &workerProbe{answer: make(chan bool, 1), decision: decision}
		w.inbox.push(workerMessage{Probe: p})
		w.Start(t.Context())
		select {
		case held := <-p.answer:
			if held {
				t.Fatal("idle probe refused")
			}
		case <-t.Context().Done():
			t.Fatal("probe never voted")
		}
		ack := w.sendWithAck("stop-undo-capturing", nil)
		decision.commit = commit
		close(decision.done)
		if commit {
			w.Stop()
			select {
			case <-ack:
				t.Error("committed actor processed inbox work instead of remaining parked")
			default:
			}
		} else {
			select {
			case err := <-ack:
				if err != nil {
					t.Fatal(err)
				}
			case <-t.Context().Done():
				t.Fatal("aborted probe did not resume actor")
			}
			w.Stop()
		}
	}
}
