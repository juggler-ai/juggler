//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"path/filepath"
	"strings"

	"juggler/cmd/juggler/msg"
)

// StoppingAction is something that stops a server's work and asks the user
// first: the desktop app quitting, restarting into an update, or relaunching
// into the build installed in its place, and the machine server relaunching.
// Each has whole sentences of its own, so a translation never fits an action
// word into a sentence built around it.
type StoppingAction int

const (
	// StopByQuitting is the app quitting.
	StopByQuitting StoppingAction = iota
	// StopByRestartingToUpdate is the app restarting into a staged update.
	StopByRestartingToUpdate
	// StopByRelaunching is the app, or the machine server, relaunching into the
	// build now installed.
	StopByRelaunching
)

// Prompt is the body of the question action asks before stopping b: what is
// still running, then each task it names on a line of its own with the project
// it runs in, so the user can tell which one it is and where to stop it.
func (b BusyWork) Prompt(action StoppingAction) msg.Message {
	list := b.taskList()
	conversations, tasks := b.Conversations, b.Tasks
	switch action {
	case StopByRestartingToUpdate:
		switch {
		case tasks == 0:
			return msg.New("{n, plural, one {A conversation is still working. Restarting to update will stop and discard it.} other {# conversations are still working. Restarting to update will stop and discard them.}}", "n", conversations)
		case conversations == 0:
			return msg.New("{n, plural, one {A background task is still running. Restarting to update will stop it.} other {# background tasks are still running. Restarting to update will stop them.}}\n\n{list}", "n", tasks, "list", list)
		default:
			return msg.New("{conversations, plural, one {A conversation is still working} other {# conversations are still working}} and {tasks, plural, one {a background task is running} other {# background tasks are running}}. Restarting to update will stop them all.\n\n{list}", "conversations", conversations, "tasks", tasks, "list", list)
		}
	case StopByRelaunching:
		switch {
		case tasks == 0:
			return msg.New("{n, plural, one {A conversation is still working. Relaunching will stop and discard it.} other {# conversations are still working. Relaunching will stop and discard them.}}", "n", conversations)
		case conversations == 0:
			return msg.New("{n, plural, one {A background task is still running. Relaunching will stop it.} other {# background tasks are still running. Relaunching will stop them.}}\n\n{list}", "n", tasks, "list", list)
		default:
			return msg.New("{conversations, plural, one {A conversation is still working} other {# conversations are still working}} and {tasks, plural, one {a background task is running} other {# background tasks are running}}. Relaunching will stop them all.\n\n{list}", "conversations", conversations, "tasks", tasks, "list", list)
		}
	default:
		switch {
		case tasks == 0:
			return msg.New("{n, plural, one {A conversation is still working. Quitting will stop and discard it.} other {# conversations are still working. Quitting will stop and discard them.}}", "n", conversations)
		case conversations == 0:
			return msg.New("{n, plural, one {A background task is still running. Quitting will stop it.} other {# background tasks are still running. Quitting will stop them.}}\n\n{list}", "n", tasks, "list", list)
		default:
			return msg.New("{conversations, plural, one {A conversation is still working} other {# conversations are still working}} and {tasks, plural, one {a background task is running} other {# background tasks are running}}. Quitting will stop them all.\n\n{list}", "conversations", conversations, "tasks", tasks, "list", list)
		}
	}
}

// taskList is the named tasks one to a line, each as "• name — project", the
// project by its folder's name. Data, not words: nothing in it is translated.
// Empty when no session named its tasks — a child of an older build — which
// leaves the prompt with trailing blank lines for its reader to trim.
func (b BusyWork) taskList() string {
	lines := make([]string, len(b.Named))
	for i, t := range b.Named {
		lines[i] = "• " + t.Name + " — " + filepath.Base(t.Project)
	}
	return strings.Join(lines, "\n")
}
