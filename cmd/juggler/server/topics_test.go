//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"errors"
	"slices"
	"testing"
)

// The topic hub on its own: who is subscribed to what, which upstreams run, and
// who hears each event. Connections are plain ids and frames are recorded, so
// nothing here waits on a socket; every look at the hub's state is made on its
// own goroutine, after everything posted before it.

// do runs fn on the hub's goroutine and waits for it.
func (h *topicHub) do(fn func()) {
	ran := make(chan struct{})
	if h.post(func() { fn(); close(ran) }) {
		select {
		case <-ran:
		case <-h.quit:
		}
	}
}

// sentFrame is one frame the hub sent, and to whom.
type sentFrame struct {
	to    string
	frame topicEventFrame
}

// fakeUpstream is a topic's upstream the test drives: it counts the starts and
// stops of each key, refuses the keys in refuse, and keeps each running key's
// publish so the test can speak for it. The hub calls it on its own goroutine,
// and the test reads and writes it there too (topicHub.do).
type fakeUpstream struct {
	starts  map[string]int
	stops   map[string]int
	publish map[string]func(any)
	refuse  map[string]bool
}

func newFakeUpstream() *fakeUpstream {
	return &fakeUpstream{starts: map[string]int{}, stops: map[string]int{}, publish: map[string]func(any){}, refuse: map[string]bool{}}
}

func (u *fakeUpstream) watch(key string, publish func(any)) (func(), error) {
	if u.refuse[key] {
		return nil, errors.New("not yet")
	}
	u.starts[key]++
	u.publish[key] = publish
	return func() { u.stops[key]++ }, nil
}

// testTopicHub is a hub with a viewer-only topic "t" whose upstream is up, an
// open topic "open" with none, and a record of every frame it sent.
type testTopicHub struct {
	*topicHub
	up     *fakeUpstream
	frames []sentFrame
}

func newTestTopicHub(t *testing.T) *testTopicHub {
	t.Helper()
	th := &testTopicHub{up: newFakeUpstream()}
	th.topicHub = newTopicHub(func(clientID string, frame any) {
		th.frames = append(th.frames, sentFrame{to: clientID, frame: frame.(topicEventFrame)})
	},
		topic{name: "t", roles: []ClientRole{ClientRoleViewer}, watch: th.up.watch},
		topic{name: "open", roles: []ClientRole{ClientRoleViewer, ClientRoleEngine}})
	t.Cleanup(th.stop)
	return th
}

// sent is every frame sent so far, after everything posted before.
func (th *testTopicHub) sent() []sentFrame {
	var out []sentFrame
	th.do(func() { out = slices.Clone(th.frames) })
	return out
}

// counts is how often key's upstream has started and stopped.
func (th *testTopicHub) counts(key string) (starts, stops int) {
	th.do(func() { starts, stops = th.up.starts[key], th.up.stops[key] })
	return starts, stops
}

// publisher is the publish of key's latest upstream.
func (th *testTopicHub) publisher(key string) func(any) {
	var p func(any)
	th.do(func() { p = th.up.publish[key] })
	return p
}

func mustSubscribe(t *testing.T, h *testTopicHub, clientID string, name string, keys ...string) {
	t.Helper()
	if err := h.subscribe(clientID, ClientRoleViewer, name, keys); err != nil {
		t.Fatalf("%s subscribing to %s %v: %v", clientID, name, keys, err)
	}
}

// recipients is who was sent the frames about one key, in order.
func recipients(frames []sentFrame, name, key string) []string {
	var to []string
	for _, f := range frames {
		if f.frame.Topic == name && f.frame.Key == key {
			to = append(to, f.to)
		}
	}
	slices.Sort(to)
	return to
}

// Two connections on one key share one upstream, which stops with the last of
// them, not the first.
func TestTopicHub_UpstreamSharedAndRefCounted(t *testing.T) {
	h := newTestTopicHub(t)
	mustSubscribe(t, h, "a", "t", "k")
	mustSubscribe(t, h, "b", "t", "k")
	h.do(func() {})
	if starts, _ := h.counts("k"); starts != 1 {
		t.Fatalf("%d upstreams started for one key, want 1", starts)
	}

	mustSubscribe(t, h, "a", "t")
	h.do(func() {})
	if _, stops := h.counts("k"); stops != 0 {
		t.Fatal("the upstream stopped while a connection still subscribed")
	}
	mustSubscribe(t, h, "b", "t")
	h.do(func() {})
	if starts, stops := h.counts("k"); starts != 1 || stops != 1 {
		t.Errorf("starts %d, stops %d: want the one upstream stopped with the last subscriber", starts, stops)
	}
}

// A connection that goes takes every subscription it had with it, in every
// topic, and stops the upstreams it alone held.
func TestTopicHub_DropEndsAConnectionsSubscriptions(t *testing.T) {
	h := newTestTopicHub(t)
	mustSubscribe(t, h, "a", "t", "k1", "k2")
	mustSubscribe(t, h, "a", "open", "k1")
	mustSubscribe(t, h, "b", "t", "k2")
	h.drop("a")
	h.do(func() {})
	if _, stops := h.counts("k1"); stops != 1 {
		t.Error("the departed connection's own upstream kept running")
	}
	if _, stops := h.counts("k2"); stops != 0 {
		t.Error("an upstream another connection holds was stopped")
	}
	h.publish("open", "k1", "after")
	h.publish("t", "k2", "after")
	frames := h.sent()
	if got := recipients(frames, "open", "k1"); len(got) != 0 {
		t.Errorf("the departed connection was sent %v", got)
	}
	if got := recipients(frames, "t", "k2"); !slices.Equal(got, []string{"b"}) {
		t.Errorf("k2 went to %v, want b alone", got)
	}
	h.do(func() {
		if len(h.clients["a"]) != 0 {
			t.Errorf("the departed connection still holds %v", h.clients["a"])
		}
	})
}

// A topic says who may subscribe, and a refused or unknown subscription changes
// nothing — it neither subscribes nor starts an upstream.
func TestTopicHub_RolesAreTheTopics(t *testing.T) {
	h := newTestTopicHub(t)
	if err := h.subscribe("e", ClientRoleEngine, "t", []string{"k"}); !errors.Is(err, errTopicRefused) {
		t.Errorf("the engine subscribing to a viewer topic: %v, want %v", err, errTopicRefused)
	}
	if err := h.subscribe("e", ClientRole("stranger"), "open", []string{"k"}); !errors.Is(err, errTopicRefused) {
		t.Errorf("an unlisted role subscribing: %v, want %v", err, errTopicRefused)
	}
	if err := h.subscribe("e", ClientRoleViewer, "nope", []string{"k"}); !errors.Is(err, errUnknownTopic) {
		t.Errorf("an unknown topic: %v, want %v", err, errUnknownTopic)
	}
	if err := h.subscribe("e", ClientRoleEngine, "open", []string{"k"}); err != nil {
		t.Errorf("the engine subscribing to a topic open to it: %v", err)
	}
	h.do(func() {
		if len(h.subscribers[topicKey{"t", "k"}]) != 0 {
			t.Error("a refused subscription was taken")
		}
	})
	if starts, _ := h.counts("k"); starts != 0 {
		t.Error("a refused subscription started an upstream")
	}
}

// A connection's frame for one topic leaves its keys of another alone, and what
// is published to a key goes to that key's subscribers in that topic alone.
func TestTopicHub_PublishReachesOnlyTheKeysSubscribers(t *testing.T) {
	h := newTestTopicHub(t)
	mustSubscribe(t, h, "a", "open", "k")
	mustSubscribe(t, h, "a", "t", "other")
	mustSubscribe(t, h, "b", "t", "k")
	mustSubscribe(t, h, "c", "open", "elsewhere")
	h.publish("open", "k", map[string]any{"n": 1})
	frames := h.sent()
	if got := recipients(frames, "open", "k"); !slices.Equal(got, []string{"a"}) {
		t.Errorf("open/k went to %v, want a alone", got)
	}
	if len(frames) != 1 {
		t.Fatalf("%d frames sent, want 1: %+v", len(frames), frames)
	}
	if f := frames[0].frame; f.Type != frameTopicEvent || f.Event.(map[string]any)["n"] != 1 {
		t.Errorf("frame = %+v, want a topic-event carrying the event", f)
	}
}

// An upstream's events reach its key's subscribers; once it has been stopped
// and another started for the same key, the first one's are dropped.
func TestTopicHub_StoppedUpstreamIsHeardNoMore(t *testing.T) {
	h := newTestTopicHub(t)
	mustSubscribe(t, h, "a", "t", "k")
	h.do(func() {})
	first := h.publisher("k")
	first("one")
	if got := recipients(h.sent(), "t", "k"); !slices.Equal(got, []string{"a"}) {
		t.Fatalf("the upstream's event went to %v, want a", got)
	}

	mustSubscribe(t, h, "a", "t")
	mustSubscribe(t, h, "a", "t", "k")
	h.do(func() {})
	first("stale")
	h.publisher("k")("two")
	var events []any
	for _, f := range h.sent() {
		events = append(events, f.frame.Event)
	}
	if !slices.Equal(events, []any{"one", "two"}) {
		t.Errorf("events sent %v, want the stopped upstream's dropped", events)
	}
}

// An upstream that could not start is tried again on retry, and the connections
// already subscribed hear it without asking again.
func TestTopicHub_RetryStartsWhatCouldNot(t *testing.T) {
	h := newTestTopicHub(t)
	h.do(func() { h.up.refuse["k"] = true })
	mustSubscribe(t, h, "a", "t", "k")
	h.publish("t", "k", "published")
	if got := recipients(h.sent(), "t", "k"); !slices.Equal(got, []string{"a"}) {
		t.Errorf("a key with no upstream did not hear what was published to it: %v", got)
	}

	h.do(func() { delete(h.up.refuse, "k") })
	h.retry("t")
	h.do(func() {})
	if starts, _ := h.counts("k"); starts != 1 {
		t.Fatalf("retry started %d upstreams, want 1", starts)
	}
	h.publisher("k")("watched")
	if got := recipients(h.sent(), "t", "k"); !slices.Equal(got, []string{"a", "a"}) {
		t.Errorf("the retried upstream's event went to %v", got)
	}
}
