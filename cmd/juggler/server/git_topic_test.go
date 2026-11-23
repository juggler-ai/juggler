//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"testing"
	"time"

	"juggler/cmd/juggler/gitops"
	"juggler/cmd/juggler/workspace"

	"github.com/gorilla/websocket"
)

// A viewer asks for the git changes of the trees it shows with one
// subscriptions frame of the git topic naming all of them, and is sent their
// git-change events and no others for as long as it asks — until it asks for
// something else or its connection goes. The tree here is scripted: what a real
// one watches is gitops's business, and these are about who is watching.

// watchedTree is a workspace whose git watch the test drives: each GitWatch is
// announced on started with its context, and whatever the test puts on changes
// is what the watch reports.
type watchedTree struct {
	workspace.Workspace
	started chan context.Context
	changes chan []gitops.Change
}

func newWatchedTree() *watchedTree {
	return &watchedTree{started: make(chan context.Context, 4), changes: make(chan []gitops.Change)}
}

func (w *watchedTree) GitWatch(ctx context.Context) (<-chan []gitops.Change, error) {
	out := make(chan []gitops.Change)
	go func() {
		defer close(out)
		for {
			select {
			case batch := <-w.changes:
				select {
				case out <- batch:
				case <-ctx.Done():
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}()
	w.started <- ctx
	return out, nil
}

func newGitWatchServer(t *testing.T, tree *watchedTree) (*Server, *httptest.Server) {
	t.Helper()
	s, ts := newViewerSocketServer(t)
	scriptGit(t, s, resolveOnly("ws_tree", tree))
	return s, ts
}

func askToWatch(t *testing.T, conn *websocket.Conn, ids ...string) {
	t.Helper()
	if ids == nil {
		ids = []string{}
	}
	if err := conn.WriteJSON(map[string]any{"type": "subscriptions", "topic": "git", "keys": ids}); err != nil {
		t.Fatal(err)
	}
}

// within fails the test if ch yields nothing before the test's own deadline:
// a guard against a hang, never a measure of anything.
func within[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(time.Minute):
		t.Fatalf("never happened: %s", what)
		var zero T
		return zero
	}
}

// nextGitChange reads frames until a git topic's git-change event arrives, and
// returns the frame raw.
func nextGitChange(t *testing.T, conn *websocket.Conn) string {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(time.Minute))
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("no git-change reached the viewer: %v", err)
		}
		var head struct {
			Type, Topic string
			Event       struct{ Type string }
		}
		if json.Unmarshal(data, &head) == nil && head.Type == "topic-event" && head.Topic == "git" && head.Event.Type == "git-change" {
			return string(data)
		}
	}
}

// watchersOf is how many connections hold the running watch of a workspace;
// 0 when none runs.
func watchersOf(s *Server, id string) int {
	n := 0
	h := s.topicHub()
	h.do(func() {
		k := topicKey{gitTopicName, id}
		if h.upstreams[k] != nil {
			n = len(h.subscribers[k])
		}
	})
	return n
}

// eventually waits until cond holds, which it must before the test's deadline.
// A connection's frames reach the hub in order but at no moment the test can
// see, so this is how a test knows one has been taken in.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Minute)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("never happened: %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestGitWatchFrame_SubscribeDeliverUnsubscribe(t *testing.T) {
	tree := newWatchedTree()
	_, ts := newGitWatchServer(t, tree)
	conn, _ := dialViewerAs(t, ts, "")

	askToWatch(t, conn, "ws_tree")
	ctx := within(t, tree.started, "the tree's watch starting")

	tree.changes <- []gitops.Change{
		{Repo: "", Kinds: gitops.KindIndex | gitops.KindWorktree},
		{Repo: "libs/inner", Kinds: gitops.KindRefs},
	}
	got := nextGitChange(t, conn)
	want := `{"type":"topic-event","topic":"git","key":"ws_tree","event":{"type":"git-change","workspace":"ws_tree","repos":[{"path":"","kinds":["index","worktree"]},{"path":"libs/inner","kinds":["refs"]}]}}`
	if got != want {
		t.Errorf("git-change event:\n  got  %s\n  want %s", got, want)
	}

	askToWatch(t, conn)
	within(t, ctx.Done(), "the watch ending when the viewer stopped asking for it")
}

func TestGitWatchFrame_DisconnectCancels(t *testing.T) {
	tree := newWatchedTree()
	_, ts := newGitWatchServer(t, tree)
	conn, _ := dialViewerAs(t, ts, "")

	askToWatch(t, conn, "ws_tree")
	ctx := within(t, tree.started, "the tree's watch starting")
	_ = conn.Close()
	within(t, ctx.Done(), "the watch ending with the viewer's connection")
}

// Two viewers of one tree share one watch, and both hear every change; it ends
// when the last of them stops asking, not the first.
func TestGitWatchFrame_SharedAcrossConnections(t *testing.T) {
	tree := newWatchedTree()
	s, ts := newGitWatchServer(t, tree)
	first, _ := dialViewerAs(t, ts, "")
	second, _ := dialViewerAs(t, ts, "")

	askToWatch(t, first, "ws_tree")
	ctx := within(t, tree.started, "the tree's watch starting")
	askToWatch(t, second, "ws_tree")
	eventually(t, "the second viewer joining the watch", func() bool { return watchersOf(s, "ws_tree") == 2 })
	select {
	case <-tree.started:
		t.Fatal("the second viewer started a watch of its own")
	default:
	}

	tree.changes <- []gitops.Change{{Repo: "", Kinds: gitops.KindHead}}
	nextGitChange(t, first)
	nextGitChange(t, second)

	askToWatch(t, first)
	eventually(t, "the first viewer leaving the watch", func() bool { return watchersOf(s, "ws_tree") == 1 })
	if ctx.Err() != nil {
		t.Fatal("the watch ended while a viewer still asked for it")
	}
	_ = second.Close()
	within(t, ctx.Done(), "the watch ending with the last viewer")
}

// A workspace that cannot be resolved is not watched, and costs the viewer
// nothing else it asked for.
func TestGitWatchFrame_UnknownWorkspaceIsSkipped(t *testing.T) {
	tree := newWatchedTree()
	s, ts := newGitWatchServer(t, tree)
	conn, _ := dialViewerAs(t, ts, "")

	askToWatch(t, conn, "ws_gone", "ws_tree")
	within(t, tree.started, "the resolvable tree's watch starting")
	if n := watchersOf(s, "ws_gone"); n != 0 {
		t.Errorf("an unresolvable workspace has %d watchers", n)
	}
}

// lateTree is a workspace whose git watch cannot start until ready is closed,
// as the project's cannot until the server's git watcher exists.
type lateTree struct {
	*watchedTree
	ready chan struct{}
}

func (w *lateTree) GitWatch(ctx context.Context) (<-chan []gitops.Change, error) {
	select {
	case <-w.ready:
		return w.watchedTree.GitWatch(ctx)
	default:
		return nil, errors.New("this server watches no git state")
	}
}

// A viewer that asks before the git watcher exists — a window reconnecting to
// a server that has just started — is watching once it does, without asking
// again: it names its trees only when what it shows changes.
func TestGitWatchFrame_WatchRefusedBeforeTheWatcherStartsOnceItExists(t *testing.T) {
	tree := &lateTree{watchedTree: newWatchedTree(), ready: make(chan struct{})}
	s, ts := newViewerSocketServer(t)
	scriptGit(t, s, resolveOnly("ws_tree", tree))
	conn, _ := dialViewerAs(t, ts, "")

	askToWatch(t, conn, "ws_tree")
	eventually(t, "the viewer's ask to be taken in", func() bool { return subscribersOf(s, "ws_tree") == 1 })
	if n := watchersOf(s, "ws_tree"); n != 0 {
		t.Fatalf("a watch that could not start has %d watchers", n)
	}

	close(tree.ready)
	s.retryGitWatches()
	within(t, tree.started, "the refused watch starting once the watcher exists")
	tree.changes <- []gitops.Change{{Repo: "", Kinds: gitops.KindRefs}}
	nextGitChange(t, conn)
}

// The git topic is a viewer's: the engine shows no trees. Its subscriptions
// frame starts no watch and subscribes it to nothing.
func TestGitTopic_RefusedToTheEngine(t *testing.T) {
	tree := newWatchedTree()
	s, ts := newGitWatchServer(t, tree)
	viewer, _ := dialViewerAs(t, ts, "")
	engine := dialEngine(t, ts)

	if err := engine.WriteJSON(map[string]any{"type": "subscriptions", "topic": "git", "keys": []string{"ws_tree"}}); err != nil {
		t.Fatal(err)
	}
	// The engine's frames are handled in order, so once its session-changed
	// reaches the viewer its subscriptions frame has been answered, and anything
	// that answer gave the hub to do is queued ahead of the look below.
	if err := engine.WriteJSON(map[string]any{"type": "session-changed"}); err != nil {
		t.Fatal(err)
	}
	nextFrameOfType(t, viewer, "session-changed")
	if n := subscribersOf(s, "ws_tree"); n != 0 {
		t.Errorf("the engine's subscription was taken: %d subscribers", n)
	}
	select {
	case <-tree.started:
		t.Error("the engine's subscription started a watch")
	default:
	}
}

// nextFrameOfType reads frames until one of type typ arrives.
func nextFrameOfType(t *testing.T, conn *websocket.Conn, typ string) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(time.Minute))
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("no %s reached the connection: %v", typ, err)
		}
		var head struct{ Type string }
		if json.Unmarshal(data, &head) == nil && head.Type == typ {
			return
		}
	}
}

// subscribersOf is how many connections are subscribed to a workspace's git,
// whether or not its watch runs.
func subscribersOf(s *Server, id string) int {
	n := 0
	h := s.topicHub()
	h.do(func() { n = len(h.subscribers[topicKey{gitTopicName, id}]) })
	return n
}
