//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	ycrdt "github.com/skyterra/y-crdt"
)

// ModelProviders lists the providers this conversation names as a model
// choice: its default, and that of every thread that chose its own. A thread
// that inherits names nothing of its own, so it adds nothing here.
func (cd *ConversationDocument) ModelProviders() map[string]bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	out := map[string]bool{}
	if mc := cd.resolveEffectiveModelConfig(""); mc != nil {
		out[mc.Provider] = true
	}
	walkThreads(cd.getItems(), func(m *ycrdt.YMap, _ *ycrdt.YArray, _ string) bool {
		if mc := cd.extractModelConfigFromMap(m.Get(keyModelConfig)); mc != nil {
			out[mc.Provider] = true
		}
		return false
	})
	return out
}

// ModelProvidersInState is ModelProviders for a conversation that is not
// loaded, read from its stored document state (doc.yjs).
func ModelProvidersInState(state []byte) (map[string]bool, error) {
	cd := NewConversationDocument("", "")
	if err := cd.LoadFromState(state); err != nil {
		return nil, err
	}
	return cd.ModelProviders(), nil
}

// ModelProviders is ModelProviders of a loaded conversation's live document,
// which may be ahead of what it has stored.
func (w *ConversationWorker) ModelProviders() map[string]bool {
	return w.doc.ModelProviders()
}
