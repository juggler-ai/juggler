//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

import (
	"testing"
	"time"
)

// TestDateChangeIsAnnouncedOncePerDay: the env block keeps the date the
// conversation started, so a turn taken on a later day is told today's date —
// once, behind the message that turn answers — and a turn on the start day is
// told nothing. Without it the model insists it is still the day it began.
func TestDateChangeIsAnnouncedOncePerDay(t *testing.T) {
	fc := newFakeClock()
	w := heldSendWorker(t, "conv-date-notice", fc, "same day", "days later", "still later", "next day")
	w.doc.SetMetadata(keyCreated, fakeEpoch.UTC().Format(time.RFC3339))

	sendMsg(t, w, SendMessageMessage{Type: "send-message", Text: "one"})
	w.quiesce(t)

	later := fakeEpoch.Add(72 * time.Hour)
	fc.set(later)
	sendMsg(t, w, SendMessageMessage{Type: "send-message", Text: "two"})
	w.quiesce(t)
	sendMsg(t, w, SendMessageMessage{Type: "send-message", Text: "three"})
	w.quiesce(t)

	next := later.Add(24 * time.Hour)
	fc.set(next)
	sendMsg(t, w, SendMessageMessage{Type: "send-message", Text: "four"})
	w.quiesce(t)

	requireLabels(t, "transcript", transcript(w), []string{
		ItemTypeUser + ":one", ItemTypeAssistant + ":same day",
		ItemTypeUser + ":two", ItemTypeSystemReminder + ":" + dateNotice(localDay(later)), ItemTypeAssistant + ":days later",
		ItemTypeUser + ":three", ItemTypeAssistant + ":still later",
		ItemTypeUser + ":four", ItemTypeSystemReminder + ":" + dateNotice(localDay(next)), ItemTypeAssistant + ":next day",
	})
}
