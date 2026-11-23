//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"os"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/gitattr"
	"juggler/cmd/juggler/worker"
	"juggler/internal/projectpaths"
)

// conversationDirectory is the project's conversations as an attribution read
// scores them (gitattr.Directory). It reads the conversation folders on every
// call — a read is made when somebody asks for a commit message, not on any
// hot path — so it never goes stale. Binned conversations are not in it.
type conversationDirectory struct{ s *Server }

// Conversations is every conversation folder of the project, titled by its
// name and dated by when its document was last stored.
func (d conversationDirectory) Conversations(context.Context) map[string]gitattr.Conversation {
	idx := d.scan()
	if idx == nil {
		return nil
	}
	out := make(map[string]gitattr.Conversation, len(idx.ByID))
	for id, dir := range idx.ByID {
		c := gitattr.Conversation{Title: idx.Names[id]}
		if info, err := os.Stat(core.ConvDocPath(dir)); err == nil {
			c.Updated = info.ModTime().UnixMilli()
		}
		out[id] = c
	}
	return out
}

// BoundTo is the conversations bound to the workspace: a loaded one read from
// its live document, the rest from what they stored. The binding lives only in
// each conversation's document, so this reads every one of them.
func (d conversationDirectory) BoundTo(ctx context.Context, workspace string) []string {
	idx := d.scan()
	if idx == nil {
		return nil
	}
	var out []string
	for id, dir := range idx.ByID {
		if ctx.Err() != nil {
			return out
		}
		var bound string
		var live *worker.ConversationWorker
		if d.s.workerManager != nil {
			live = d.s.workerManager.Get(id)
		}
		if live != nil {
			bound = live.WorkspaceID()
		} else {
			state, err := os.ReadFile(core.ConvDocPath(dir))
			if err != nil {
				continue
			}
			if bound, err = worker.WorkspaceIDInState(state); err != nil {
				continue
			}
		}
		if bound == workspace {
			out = append(out, id)
		}
	}
	return out
}

// scan is the project's conversation folders, or nil with no project.
func (d conversationDirectory) scan() *core.ConvDirIndex {
	project := d.s.ProjectPath()
	if project == "" {
		return nil
	}
	idx, err := core.ScanConvDirs(projectpaths.StateDir(project))
	if err != nil {
		return nil
	}
	return idx
}
