//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "time"

// dateNoticeSource tags the system-reminder that tells the model the date has
// changed since the date it was last given.
const dateNoticeSource = "date"

// dateNotice is the reminder for a turn taken on day (YYYY-MM-DD).
func dateNotice(day string) string {
	return "Today's date is now " + day + ". The date has changed since the date given earlier in this " +
		"conversation; use this one."
}

// localDay is t's date on this machine's calendar, as YYYY-MM-DD.
func localDay(t time.Time) string { return t.Local().Format(time.DateOnly) }

// announceDateChange tells the model today's date when it differs from the
// last date this thread's transcript gave it, at the turn boundary, so the
// notice is in the request it is about.
//
// The system prompt's env block states the date the conversation started
// (system-prompt-context-item.js, buildEnvBlock), on this machine's calendar,
// and never moves: it heads every request, so changing it at midnight would
// cost a full prompt-cache rewrite. A conversation that runs for days would
// otherwise leave the model sure it is still the day it began. The notice is
// appended, so the request stays append-only and costs its own bytes; it is
// said once per date change, because the latest notice in the transcript is
// what the next boundary compares against.
//
// It reads the transcript rather than remembering what it said, so a notice
// lost to compaction is said again, and a sub-thread — whose transcript holds
// none of its parent's notices — is told on its first turn of a later day.
func (r *run) announceDateChange() {
	created, _ := r.doc.GetMetadata(keyCreated).(string)
	start, err := time.Parse(time.RFC3339, created)
	if err != nil {
		// No start date to have gone stale: buildEnvBlock falls back to the
		// live date when the conversation carries none.
		return
	}
	today := localDay(r.clock.Now())
	items := r.getTargetItems()
	for i := len(items) - 1; i >= 0; i-- {
		it := items[i]
		if it.Type == ItemTypeSystemReminder && it.Source == dateNoticeSource {
			if it.Content == dateNotice(today) {
				return
			}
			r.appendDateNotice(today)
			return
		}
	}
	if localDay(start) != today {
		r.appendDateNotice(today)
	}
}

func (r *run) appendDateNotice(day string) {
	r.appendTargetMessage(ConversationItem{
		Type:      ItemTypeSystemReminder,
		ItemID:    generateItemID(),
		Content:   dateNotice(day),
		Source:    dateNoticeSource,
		Timestamp: r.clock.Now().Format(time.RFC3339),
	})
}
