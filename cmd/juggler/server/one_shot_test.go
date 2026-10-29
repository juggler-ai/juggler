//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"testing"
)

// The one-shot round-trip carries a whole `juggler run` invocation: the caller
// blocks on its channel and exits on what arrives there. So the answer it takes
// must be the answer to the request in flight, taken once, and nothing else —
// the failure being a run that reports another run's outcome, or reports twice,
// or reports a result the caller had already given up on.

func TestOneShotTakesOnlyTheAnswerToTheArmedRequest(t *testing.T) {
	var r oneShotRoundTrip
	ch, err := r.arm("run_a")
	if err != nil {
		t.Fatalf("arm: %v", err)
	}

	r.deliver(OneShotResult{RequestID: "run_b", Status: OneShotCompleted})
	select {
	case res := <-ch:
		t.Fatalf("took an answer to another request: %+v", res)
	default:
	}

	// An answer with no id is not attributable to any request either.
	r.deliver(OneShotResult{Status: OneShotCompleted})
	select {
	case res := <-ch:
		t.Fatalf("took an answer carrying no request id: %+v", res)
	default:
	}

	r.deliver(OneShotResult{RequestID: "run_a", Status: OneShotCompleted, FinalText: "done"})
	select {
	case res := <-ch:
		if res.FinalText != "done" {
			t.Fatalf("got %+v, want the armed request's answer", res)
		}
	default:
		t.Fatal("the answer to the armed request was not taken")
	}
}

func TestOneShotRefusesDuplicateAndLateAnswers(t *testing.T) {
	var r oneShotRoundTrip
	ch, err := r.arm("run_a")
	if err != nil {
		t.Fatalf("arm: %v", err)
	}

	r.deliver(OneShotResult{RequestID: "run_a", Status: OneShotCompleted, FinalText: "first"})
	r.deliver(OneShotResult{RequestID: "run_a", Status: OneShotFailed, FinalText: "second"})

	res := <-ch
	if res.FinalText != "first" {
		t.Fatalf("got %q, want the first answer", res.FinalText)
	}
	select {
	case res := <-ch:
		t.Fatalf("a duplicate answer was queued behind the first: %+v", res)
	default:
	}

	// Once the caller has given up, a straggler goes nowhere rather than
	// waiting for whatever asks next.
	ch2, err := r.arm("run_b")
	if err != nil {
		t.Fatalf("re-arm after an answered round-trip: %v", err)
	}
	r.disarm()
	r.deliver(OneShotResult{RequestID: "run_b", Status: OneShotCompleted})
	select {
	case res := <-ch2:
		t.Fatalf("took an answer to an abandoned request: %+v", res)
	default:
	}
}

func TestOneShotRefusesASecondRunInFlight(t *testing.T) {
	var r oneShotRoundTrip
	if _, err := r.arm("run_a"); err != nil {
		t.Fatalf("arm: %v", err)
	}
	if _, err := r.arm("run_b"); err == nil {
		t.Fatal("armed a second run while one was already in flight")
	}
}

func TestStartOneShotRefusesWithoutAnEngine(t *testing.T) {
	s := &Server{}
	ch, err := s.startOneShot(OneShotRequest{Prompt: "hello", StrategyID: "yolo"})
	if err == nil {
		t.Fatal("dispatched a run with no engine connected")
	}
	if ch != nil {
		t.Fatal("returned a channel nothing can ever answer on")
	}
	// The refusal must leave nothing armed, or the next attempt is refused for
	// the wrong reason.
	if _, err := s.oneShot.arm("run_a"); err != nil {
		t.Fatalf("a refused dispatch left the round-trip armed: %v", err)
	}
}
