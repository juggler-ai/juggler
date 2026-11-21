//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"errors"
	"net/http"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/worker"
	"juggler/internal/jlog"
)

// importTurn is held by one import at a time, so the check for a transcript
// already imported and the create it decides on are one step: two importers
// offering the same transcript at once make one conversation between them.
// Process-wide rather than per session, which costs nothing — a server serves
// one project, and imports are not a path anything waits on.
var importTurn = make(chan struct{}, 1)

// HandleImportConversation creates a conversation from another agent's
// transcript (worker.ImportedTranscript), served at worker.ImportPath. It is the whole of what an importer
// needs from the session: reading the other agent's files, choosing which to
// bring over and deciding what each entry means are the importer's business,
// and this route takes the result in a shape no agent in particular writes.
//
// One transcript per request, so each answer names the one conversation it
// made. A transcript this project has imported before — same source kind, id
// and digest, open or binned — is not imported again: the answer is 200 with
// that conversation's id and "existing": true. A new one is 201 {id, name,
// created}. Both are a worker.ImportAnswer, carrying "room", how many more
// conversations the session can take, so an importer can stop before the cap
// rather than at it; at the cap the answer is 409, as for any create.
//
// The conversation goes at the end of the order: an import must not push aside
// the tabs the user already works in. It is filled before it is ordered
// (CreateConversationFilled), so no viewer can load it half-written, and it is
// announced like any other create.
func (api *SessionAPI) HandleImportConversation(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, worker.MaxImportBytes)
	transcript, ok := DecodeJSON[worker.ImportedTranscript](w, r)
	if !ok {
		return
	}
	if err := transcript.Validate(); err != nil {
		WriteMessageError(w, r, http.StatusBadRequest, msg.New("Couldn't import the conversation: {detail}", "detail", err.Error()))
		return
	}
	mgr := api.manager()

	select {
	case importTurn <- struct{}{}:
	case <-r.Context().Done():
		return
	}
	defer func() { <-importTurn }()

	if id, found := mgr.ImportedSources()[transcript.Source.Key()]; found {
		WriteJSON(w, r, http.StatusOK, worker.ImportAnswer{ID: id, Existing: true, Room: mgr.RoomForConversations()})
		return
	}

	var model *core.ModelRef
	if api.resolveDefaultModel != nil {
		if ref, _ := api.resolveDefaultModel(r.Context()); ref.Provider != "" && ref.Model != "" {
			model = &ref
		}
	}
	created := importedCreated(transcript.Created)

	var fillErr error
	fill := func(id string) error {
		fillErr = api.fillImportedConversation(id, transcript, created, model)
		return fillErr
	}
	id, finalName, err := mgr.CreateConversationFilled(transcript.Title, "", core.PlacementFor("end", ""), fill)
	if fillErr != nil {
		jlog.Error("[session.Import] %s %s failed: %v", transcript.Source.Kind, transcript.Source.ID, fillErr)
		WriteMessageError(w, r, http.StatusInternalServerError, msg.New("Couldn't import the conversation: {detail}", "detail", fillErr.Error()))
		return
	}
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, core.ErrTooManyConversations) {
			status = http.StatusConflict
		}
		WriteErr(w, r, status, err)
		return
	}
	jlog.Info("[session.Import] conv=%s name=%q from %s %s (%d items) remote=%s lane=%q",
		id, finalName, transcript.Source.Kind, transcript.Source.ID, len(transcript.Items), r.RemoteAddr, r.URL.Query().Get("lane"))

	WriteJSON(w, r, http.StatusCreated, worker.ImportAnswer{ID: id, Name: finalName, Created: created, Room: mgr.RoomForConversations()})
	if api.broadcaster != nil {
		api.broadcaster.BroadcastConversationsChanged("created", id, finalName)
	}
}

// fillImportedConversation writes an imported conversation's document and its
// import record into the folder CreateConversationFilled made for it.
func (api *SessionAPI) fillImportedConversation(id string, t worker.ImportedTranscript, created string, model *core.ModelRef) error {
	dir, ok := api.manager().ConvDir(id)
	if !ok {
		return errors.New("the new conversation's folder is missing")
	}
	state, err := worker.BuildImportedConversation(id, t, created, model)
	if err != nil {
		return err
	}
	return core.WriteImportedConversation(dir, state, t.Source)
}

// importedCreated is the transcript's own start time in the session's format,
// or now when it gave none that parses.
func importedCreated(ts string) string {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if parsed, err := time.Parse(layout, ts); err == nil {
			return parsed.UTC().Format(time.RFC3339)
		}
	}
	return nowRFC3339()
}
