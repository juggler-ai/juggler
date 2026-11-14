//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"os"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/worker"
	"juggler/internal/projectpaths"
)

// countConversationsUsing counts the conversations in this server's project —
// binned ones aside — that name providerID as a model choice, as their own
// default or a thread's. It answers the settings page's remove confirm, so it
// reads every conversation, and runs only when asked: a loaded one from its
// live document, the rest from what they stored. Projects other than this one
// are not counted; nothing records where every one of them lives.
func countConversationsUsing(wm *worker.Manager, project, providerID string) (int, error) {
	if project == "" {
		return 0, nil
	}
	idx, err := core.ScanConvDirs(projectpaths.StateDir(project))
	if err != nil {
		return 0, err
	}
	n := 0
	for id, dir := range idx.ByID {
		var providers map[string]bool
		if w := wm.Get(id); w != nil {
			providers = w.ModelProviders()
		} else {
			state, err := os.ReadFile(core.ConvDocPath(dir))
			if err != nil {
				continue
			}
			if providers, err = worker.ModelProvidersInState(state); err != nil {
				continue
			}
		}
		if providers[providerID] {
			n++
		}
	}
	return n, nil
}
