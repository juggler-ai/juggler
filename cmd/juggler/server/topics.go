//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"errors"
	"fmt"
	"slices"
	"sync"

	"juggler/internal/jlog"
)

// Topics: the events a client asks the server to push to it.
//
// A feature declares a named topic, which the hub is made with (topicHub). A
// client subscribes to
// some of its keys — which keys mean what is the topic's own business: git's are
// workspace ids — by sending one subscriptions frame per topic naming every key
// it wants, in place of whatever it named before; it sends the whole set again
// after a reconnect, and an empty set when it wants none. Who may subscribe is
// the topic's to say (Roles), and a frame naming a topic its sender's role may
// not hear is refused whole.
//
// Anything a feature publishes to a key (Publish) is sent, as a topic-event
// frame, to every connection subscribed to that key and to no others. A topic
// may also have an upstream (Watch): started for a key when the first connection
// subscribes to it, shared by however many do, and stopped when the last stops
// asking or disconnects. A key whose upstream cannot be started is still
// subscribed — what is published to it still arrives — and its upstream is tried
// again by the next subscriptions frame naming it, or by retryTopic.
//
// All of a hub's state belongs to one goroutine, which everything else reaches
// through cmds, so what a connection hears follows every subscription it made
// before. The goroutine is started on first use: a server no client ever asks
// has none.

// topicWatch starts the shared upstream of one key of a topic, handing each
// event to publish, which may be called from any goroutine but not from within
// topicWatch itself. It returns the function that stops it, or why it cannot
// start.
type topicWatch func(key string, publish func(event any)) (stop func(), err error)

// topic is one kind of event clients may subscribe to.
type topic struct {
	name string
	// roles are the client roles that may subscribe. None means nobody may.
	roles []ClientRole
	// watch is the topic's upstream, nil when everything it carries is
	// published by Publish.
	watch topicWatch
}

// errUnknownTopic and errTopicRefused are why a subscriptions frame was refused.
var (
	errUnknownTopic = errors.New("no such topic")
	errTopicRefused = errors.New("not open to this client's role")
)

// topicKey is one key of one topic.
type topicKey struct{ topic, key string }

// topicUpstream is one key's running upstream.
type topicUpstream struct {
	stop func()
}

// topicHub holds every topic and who is subscribed to what.
type topicHub struct {
	// send delivers one frame to one connection.
	send func(clientID string, frame any)

	// topics are every topic, fixed when the hub is made.
	topics map[string]topic

	once     sync.Once
	stopOnce sync.Once
	cmds     chan func()
	quit     chan struct{}

	// Owned by the hub's goroutine.
	clients     map[string]map[topicKey]bool // by connection: what it subscribed to
	subscribers map[topicKey]map[string]bool // by key: the connections subscribed
	upstreams   map[topicKey]*topicUpstream  // by key: its upstream, while one runs
}

// newTopicHub is a hub of the topics given, which sends its frames with send.
// No two topics may share a name.
func newTopicHub(send func(clientID string, frame any), topics ...topic) *topicHub {
	byName := map[string]topic{}
	for _, t := range topics {
		if _, taken := byName[t.name]; taken || t.name == "" {
			panic(fmt.Sprintf("topics: %q declared twice, or unnamed", t.name))
		}
		byName[t.name] = t
	}
	return &topicHub{
		send:   send,
		topics: byName,
		// Buffered so a connection's read loop hands over its frames in order
		// and moves on, while an upstream is started behind it.
		cmds:        make(chan func(), 64),
		quit:        make(chan struct{}),
		clients:     map[string]map[topicKey]bool{},
		subscribers: map[topicKey]map[string]bool{},
		upstreams:   map[topicKey]*topicUpstream{},
	}
}

// topicHub is the server's topic hub, made with every topic the core has on
// first use.
func (s *Server) topicHub() *topicHub {
	s.topicsOnce.Do(func() {
		s.topics = newTopicHub(s.viewerSendToClient, s.gitTopic(), s.jobsTopic())
	})
	return s.topics
}

// topic is the topic named, if there is one.
func (h *topicHub) topic(name string) (topic, bool) {
	t, ok := h.topics[name]
	return t, ok
}

func (h *topicHub) run() {
	for {
		select {
		case fn := <-h.cmds:
			fn()
		case <-h.quit:
			for _, u := range h.upstreams {
				u.stop()
			}
			h.upstreams = map[topicKey]*topicUpstream{}
			return
		}
	}
}

// post queues fn for the hub's goroutine, starting it if it was not, unless the
// hub has stopped.
func (h *topicHub) post(fn func()) bool {
	h.once.Do(func() { go h.run() })
	select {
	case h.cmds <- fn:
		return true
	case <-h.quit:
		return false
	}
}

// subscribe makes keys the keys of a topic a connection is subscribed to, or
// says why a client in role may not. Nothing changes on a refusal.
func (h *topicHub) subscribe(clientID string, role ClientRole, name string, keys []string) error {
	t, ok := h.topic(name)
	if !ok {
		return errUnknownTopic
	}
	if !slices.Contains(t.roles, role) {
		return errTopicRefused
	}
	want := map[string]bool{}
	for _, k := range keys {
		want[k] = true
	}
	h.post(func() { h.set(t, clientID, want) })
	return nil
}

// drop ends every subscription of a departed connection.
func (h *topicHub) drop(clientID string) {
	h.post(func() {
		for k := range h.clients[clientID] {
			h.release(clientID, k)
		}
	})
}

// publish sends event to every connection subscribed to key of the topic named,
// after every subscription each made before it.
func (h *topicHub) publish(name, key string, event any) {
	k := topicKey{name, key}
	h.post(func() { h.deliver(k, event) })
}

// retry starts every upstream of a topic that a connection is subscribed to and
// that is not running: for an upstream that could not start until something
// else existed, once it does.
func (h *topicHub) retry(name string) {
	t, ok := h.topic(name)
	if !ok || t.watch == nil {
		return
	}
	h.post(func() {
		for k := range h.subscribers {
			if k.topic == name && h.upstreams[k] == nil {
				h.start(t, k)
			}
		}
	})
}

// stop ends every upstream, for shutdown. Safe to call twice.
func (h *topicHub) stop() {
	h.stopOnce.Do(func() { close(h.quit) })
}

// set is subscribe on the hub's goroutine.
func (h *topicHub) set(t topic, clientID string, want map[string]bool) {
	for k := range h.clients[clientID] {
		if k.topic == t.name && !want[k.key] {
			h.release(clientID, k)
		}
	}
	for key := range want {
		k := topicKey{t.name, key}
		mine := h.clients[clientID]
		if mine == nil {
			mine = map[topicKey]bool{}
			h.clients[clientID] = mine
		}
		mine[k] = true
		subs := h.subscribers[k]
		if subs == nil {
			subs = map[string]bool{}
			h.subscribers[k] = subs
		}
		subs[clientID] = true
		// Named again, an upstream that could not start is tried again.
		if t.watch != nil && h.upstreams[k] == nil {
			h.start(t, k)
		}
	}
}

// release takes one connection off one key, stopping the key's upstream when it
// was the last.
func (h *topicHub) release(clientID string, k topicKey) {
	if mine := h.clients[clientID]; mine != nil {
		delete(mine, k)
		if len(mine) == 0 {
			delete(h.clients, clientID)
		}
	}
	subs := h.subscribers[k]
	if subs == nil {
		return
	}
	delete(subs, clientID)
	if len(subs) > 0 {
		return
	}
	delete(h.subscribers, k)
	if u := h.upstreams[k]; u != nil {
		u.stop()
		delete(h.upstreams, k)
	}
}

// start begins a key's upstream, or says why it cannot and leaves none.
func (h *topicHub) start(t topic, k topicKey) {
	u := &topicUpstream{}
	stop, err := t.watch(k.key, func(event any) {
		h.post(func() {
			// An upstream stopped and begun again is another one; this one's
			// news is for nobody.
			if h.upstreams[k] == u {
				h.deliver(k, event)
			}
		})
	})
	if err != nil {
		jlog.Info("[Topics] Not watching %s %q: %v", k.topic, k.key, err)
		return
	}
	u.stop = stop
	h.upstreams[k] = u
}

// deliver sends event to every connection subscribed to k.
func (h *topicHub) deliver(k topicKey, event any) {
	if len(h.subscribers[k]) == 0 {
		return
	}
	frame := topicEventFrame{Type: frameTopicEvent, Topic: k.topic, Key: k.key, Event: event}
	for clientID := range h.subscribers[k] {
		h.send(clientID, frame)
	}
}

// Publish sends event to every connection subscribed to key of the topic named,
// as a topic-event frame. A feature's way to push to the clients that asked.
func (s *Server) Publish(topicName, key string, event any) {
	s.topicHub().publish(topicName, key, event)
}
