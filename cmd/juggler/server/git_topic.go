//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"errors"

	"juggler/cmd/juggler/gitops"
)

// The git topic: the git state of the trees a viewer shows, keyed by workspace
// id ("" is the project).
//
// Its upstream is the server's git watch of the workspace's tree (gitWatch), one per
// workspace however many viewers subscribe, and each batch it reports is a
// git-change event. A git write's progress is a job's, on the jobs topic
// (jobs.go, git_jobs.go).
//
// A workspace that cannot be resolved is not watched; its viewer's status read
// reports why, as it would have anyway. A viewer naming it again — after a
// reconnect, or on switching back to it — tries again.
//
// Only viewers may subscribe: the engine shows no trees.

// gitTopicName is the git topic's name on the wire.
const gitTopicName = "git"

// gitEventChange is the git topic's one event.
const gitEventChange = "git-change"

// gitChangeEvent is one batch of a watched workspace's git changes.
type gitChangeEvent struct {
	Type      string          `json:"type"`      // "git-change"
	Workspace string          `json:"workspace"` // The workspace id the viewer named; "" is the project
	Repos     []gitChangeRepo `json:"repos"`
}

// gitChangeRepo is one repository's part of a git-change: its path in the tree,
// as the status card names it ("" for the root repository), and which parts of
// its git state changed — "index", "refs", "head", "worktree", "operation".
type gitChangeRepo struct {
	Path  string   `json:"path"`
	Kinds []string `json:"kinds"`
}

// gitTopic is the git topic as the hub registers it.
func (s *Server) gitTopic() topic {
	return topic{name: gitTopicName, roles: []ClientRole{ClientRoleViewer}, watch: s.watchGitTree}
}

// watchGitTree is the git topic's upstream: the git watch of one workspace.
func (s *Server) watchGitTree(id string, publish func(event any)) (func(), error) {
	ws, err := s.gitResolve(id)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	changes, err := s.gitWatch(ctx, ws.Root())
	if err != nil {
		cancel()
		return nil, err
	}
	go func() {
		for batch := range changes {
			publish(newGitChangeEvent(id, batch))
		}
	}()
	return cancel, nil
}

// gitWatch reports changes to the git state of every repository in the tree at
// root until ctx ends, when the channel is closed (see gitops.Watcher.Watch) —
// or a test's script of it, when gitWatchScript is set. It acts for the user:
// it widens nothing the agent's tools may reach.
func (s *Server) gitWatch(ctx context.Context, root string) (<-chan []gitops.Change, error) {
	if s.gitWatchScript != nil {
		return s.gitWatchScript(ctx, root)
	}
	watcher := s.GitWatcher()
	if watcher == nil {
		return nil, errors.New("this server watches no git state")
	}
	if root == "" {
		return nil, errors.New("no project is open")
	}
	return watcher.Watch(ctx, root)
}

// retryGitWatches starts every git watch a viewer asked for that could not be
// started. Called once the server's git watcher exists: a window reconnecting
// to a server that has just started asks before it does, and names its trees
// again only when what it shows changes.
func (s *Server) retryGitWatches() {
	s.topicHub().retry(gitTopicName)
}

// newGitChangeEvent is one batch of a workspace's changes as the wire spells it.
func newGitChangeEvent(id string, batch []gitops.Change) gitChangeEvent {
	repos := make([]gitChangeRepo, 0, len(batch))
	for _, c := range batch {
		repos = append(repos, gitChangeRepo{Path: c.Repo, Kinds: c.Kinds.Names()})
	}
	return gitChangeEvent{Type: gitEventChange, Workspace: id, Repos: repos}
}
