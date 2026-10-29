//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// A running worker's lifetime: the context it is started under, and what a stop
// owes the turns still streaming when it comes.

import (
	"strings"
	"sync/atomic"
	"testing"
)

// savedDocs records every document state a worker writes, so a test can read
// the last one the way the next launch would, and whether a turn was still
// running when it was written.
type savedDocs struct {
	last          atomic.Pointer[[]byte]
	lastWhileLive atomic.Bool
	// live reports whether a turn is still running. Set once the worker exists.
	live atomic.Pointer[func() bool]
}

func (s *savedDocs) save(_ string, data []byte) error {
	saved := append([]byte(nil), data...)
	s.last.Store(&saved)
	live := s.live.Load()
	s.lastWhileLive.Store(live != nil && (*live)())
	return nil
}

// unfinishedTurn reports whether any turn w has registered has yet to return.
func unfinishedTurn(w *ConversationWorker) bool {
	for _, e := range w.sched.runs() {
		select {
		case <-e.t.finished:
		default:
			return true
		}
	}
	return false
}

// items decodes the last saved state.
func (s *savedDocs) items(t *testing.T) []ConversationItem {
	t.Helper()
	p := s.last.Load()
	if p == nil || len(*p) == 0 {
		t.Fatal("the worker never saved its document")
	}
	doc := NewConversationDocument("verify", "user:test")
	defer doc.Destroy()
	if err := doc.LoadFromState(*p); err != nil {
		t.Fatalf("loading the saved state: %v", err)
	}
	return doc.GetItems()
}

// workerContextKey marks the context a worker is started under.
type workerContextKey struct{}

// holdsAssistantText reports whether items hold an assistant message reading
// exactly text.
func holdsAssistantText(items []ConversationItem, text string) bool {
	for _, it := range items {
		if it.Type == ItemTypeAssistant && it.Content == text {
			return true
		}
	}
	return false
}

// describeItems renders items one per line, for a failure message.
func describeItems(items []ConversationItem) string {
	var b strings.Builder
	for _, it := range items {
		b.WriteString("  " + it.Type + ": " + it.Content + "\n")
	}
	return b.String()
}
