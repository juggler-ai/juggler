//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// metaWorkspaceID is the doc-metadata key naming the workspace a conversation
// is bound to — where its tools and its provider run. Absent or "" is the
// project itself, which is what every conversation meant before workspaces
// existed.
//
// The browser owns the write, once, when the conversation is initialised. The
// worker only reads it, and puts it on every LLM request: the binding lives in
// the Yjs doc, which the server does not read, so the request is how the server
// learns where this conversation works.
//
// It is metadata rather than an item for two reasons. A clone copies doc.yjs
// wholesale, so a duplicated conversation inherits its workspace without any
// code; and metadata sits outside the UndoManager's `items` scope, so no undo
// can take a conversation's workspace away from it while a turn is in flight.
const metaWorkspaceID = "workspaceId"

// workspaceID returns the workspace this conversation is bound to, "" for the
// project.
func (r *run) workspaceID() string {
	id, _ := r.doc.GetMetadata(metaWorkspaceID).(string)
	return id
}

// WorkspaceID is the workspace the conversation is bound to, "" for the
// project.
func (cd *ConversationDocument) WorkspaceID() string {
	id, _ := cd.GetMetadata(metaWorkspaceID).(string)
	return id
}

// WorkspaceIDInState is WorkspaceID for a conversation that is not loaded,
// read from its stored document state (doc.yjs).
func WorkspaceIDInState(state []byte) (string, error) {
	cd := NewConversationDocument("", "")
	if err := cd.LoadFromState(state); err != nil {
		return "", err
	}
	return cd.WorkspaceID(), nil
}

// WorkspaceID is WorkspaceID of a loaded conversation's live document.
func (w *ConversationWorker) WorkspaceID() string {
	return w.doc.WorkspaceID()
}
