//go:build windows

package fsnotify

import (
	"errors"
	"testing"
)

// Close hands readEvents a reply channel on w.done and waits for the answer.
// When the request arrives while readEvents is blocked sending an error nobody
// has read yet, sendError gives up the send; it must leave the request on
// w.done for readEvents to answer, or Close waits forever.
func TestWindowsSendErrorKeepsCloseRequest(t *testing.T) {
	w, err := NewWatcher()
	if err != nil {
		t.Fatal(err)
	}
	b := w.b.(*readDirChangesW)

	// The first half of Close, without the wake-up: readEvents stays parked in
	// GetQueuedCompletionStatus, so the request can only be seen by sendError,
	// as it is when Close arrives while the reader is inside sendError. Nothing
	// reads w.Errors, so the close request is the only case sendError can take.
	b.mu.Lock()
	b.closed = true
	b.mu.Unlock()
	reply := make(chan error)
	b.done <- reply

	if b.sendError(errors.New("an error nobody reads")) {
		t.Error("sendError reported an unread error as sent")
	}
	if len(b.done) != 1 {
		// readEvents will never answer, so don't wait for it.
		t.Fatal("sendError dropped the close request: Close would wait forever")
	}

	// The second half of Close: readEvents answers the request and returns.
	if err := b.wakeupReader(); err != nil {
		t.Fatal(err)
	}
	if err := <-reply; err != nil {
		t.Fatal(err)
	}
	if _, ok := <-w.Errors; ok {
		t.Error("the Errors channel is still open after the close completed")
	}
}
