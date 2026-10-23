//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "time"

// metaUnattended marks a conversation nobody is attending: a headless
// `juggler run`. The engine writes it when it configures the run
// (Conversation.setUnattended), and the engine also reads it there to withhold
// the tools only a person can resolve. Here it is what lets the turn loop do
// what the absent person would have done at the one point a run otherwise
// stops to wait for them. Riding in doc metadata, it survives a reload of the
// conversation mid-run.
const metaUnattended = "unattended"

// maxUnattendedTruncationContinues bounds how many times one unattended run
// goes on past a turn cut off at its output limit before it acted. A model
// that spirals every time is not asked again forever; past the bound the run
// rests, as an attended one does at the first truncation.
const maxUnattendedTruncationContinues = 2

// unattended reports whether nobody is attending this conversation. See
// metaUnattended.
func (r *run) unattended() bool {
	v, _ := r.doc.GetMetadata(metaUnattended).(bool)
	return v
}

// appendTruncationNudge tells the model why it is being asked to go on after a
// turn its output limit cut off: in an attended conversation the person reads
// the truncation notice and says "continue"; here nobody will. The ask is to
// act rather than to think again, since thinking is what spent the budget.
func (r *run) appendTruncationNudge() {
	r.appendTargetMessage(ConversationItem{
		Type:   ItemTypeSystemReminder,
		ItemID: generateItemID(),
		Content: "Your last reply reached its output limit while you were still reasoning, before you acted, " +
			"and nobody is attending this run to tell you to go on. Don't restart your analysis: take the " +
			"next concrete step now — a tool call — or give your answer, and keep each reply's reasoning " +
			"short enough to finish within the limit.",
		Source:    "unattended run",
		Timestamp: time.Now().Format(time.RFC3339),
	})
}
