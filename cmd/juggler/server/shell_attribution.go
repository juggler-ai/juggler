//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/shellattr"
)

// runningShells is the shell recorder's view of the process inventory: every
// shell command running under the project, and where. Python runs are left
// out; they are code the agent wrote to compute, not to change the tree.
func runningShells(project string) []shellattr.ShellCall {
	var out []shellattr.ShellCall
	for _, p := range ops.ListProcesses(project) {
		if p.Kind == ops.ProcessPython || p.ConvID == "" {
			continue
		}
		out = append(out, shellattr.ShellCall{Conv: p.ConvID, Thread: p.ThreadID, Item: p.ToolUseID, Cwd: p.Cwd, Workspace: p.WorkspaceID})
	}
	return out
}

// shellTreeRoot is where a workspace's tree is on this machine, for the shell
// recorder to watch while commands run in it; false for one that cannot be
// resolved or is not on this machine.
func (s *Server) shellTreeRoot(id string) (string, bool) {
	ws, err := s.gitResolve(id)
	if err != nil {
		return "", false
	}
	root, local := ws.LocalDir()
	return root, local && root != ""
}
