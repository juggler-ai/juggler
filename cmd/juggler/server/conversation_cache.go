//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Server-side per-conversation Provider Conversation cache. One handle
// per (convID, providerName, model, credential, workspace) tuple, opened
// lazily, reused across turns. It is the home for long-lived per-conversation
// state (e.g. claudecode's session bookkeeping).
//
// Threads of one conversation may run on different providers or models at the
// same time (each thread resolves its own model), so one conversation can hold
// several handles at once. Each thread is bound to the handle it last used. A
// thread moving to another handle is retired from its old one: if no other
// thread is bound there the old handle is closed, otherwise only that thread's
// work on it is cancelled, so a sibling's in-flight turn on the old handle
// keeps running. A workspace change is the exception: the workspace belongs to
// the whole conversation, so every handle rooted elsewhere is closed.
//
// All state is owned by a single goroutine (runActor); GetOrOpen and
// Close send ops to it, so the cache itself needs no mutex. The
// goroutine is started once at server bootstrap and runs until shutdown.

package server

import (
	"context"
	"fmt"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/jlog"
)

// conversationCacheKey identifies one cached Conversation. Provider, model,
// credential, and immutable model capabilities are part of the key so a
// mid-conversation configuration switch moves the thread to a new handle.
type conversationCacheKey struct {
	convID       string
	providerName string
	model        string
	credential   string
	capabilities provider.ModelCapabilities
	// workspaceRoot is where this conversation's work happens — "" for the
	// project. It is part of the key because a handle can hold a live CLI
	// subprocess rooted there: rebinding a conversation to another workspace
	// must retire that process rather than keep talking to one running in the
	// tree the conversation has left.
	workspaceRoot string
}

// threadRef names one thread of one conversation ("" is the root thread).
type threadRef struct {
	convID   string
	threadID string
}

// conversationCache stores Conversation handles keyed by (convID,
// providerName, model, credential, workspace). A handle lives until no thread
// is bound to it, its conversation is closed or rebound to another workspace,
// or the server shuts down. Cache is per-server-instance; not shared across
// processes.
type conversationCache struct {
	ops  chan cacheOp
	done chan struct{}
	// projectPath returns the server's currently-open project root, read when
	// initializing a provider so CLI-spawning providers (claudecode, acp) root
	// their subprocess in the open project rather than the server's launch
	// directory. Injected at construction (before the actor goroutine starts)
	// so the actor's read never races the wire-up. May be nil in tests.
	projectPath func() string
}

type cacheOpKind int

const (
	cacheOpGetOrOpen cacheOpKind = iota
	cacheOpCloseConversation
	cacheOpCancelConversation
	cacheOpSetSinkFactory
	cacheOpShutdown
)

// turnSinkFactory builds the TurnSink a freshly-opened Conversation is
// Subscribe()d to, given its convID. The server wires it to route autonomous
// turns to the owning worker (see Server.wireWorkerManager). Returning nil
// detaches (no autonomous-turn routing for that conversation).
type turnSinkFactory func(convID string) provider.TurnSink

type cacheOp struct {
	kind       cacheOpKind
	key        conversationCacheKey
	credential core.ProviderCredential
	convID     string // for close / cancel ops (matches every cached entry for that conv)
	// threadID is, for get-or-open, the thread the turn runs on; for cancel
	// ops, the thread to cancel, or provider.CancelAllThreads.
	threadID    string
	sinkFactory turnSinkFactory
	respCh      chan cacheResult
	doneCh      chan struct{}
}

type cacheResult struct {
	conv provider.Conversation
	err  error
}

// newConversationCache spawns the actor and returns the cache handle.
// Caller must call Shutdown at process exit so any provider-side
// resources (live subprocesses, open files) get released.
func newConversationCache(projectPath func() string) *conversationCache {
	cc := &conversationCache{
		ops:         make(chan cacheOp, 16),
		done:        make(chan struct{}),
		projectPath: projectPath,
	}
	go cc.runActor()
	return cc
}

// GetOrOpen returns the cached Conversation for the key, opening a new one if
// absent, and binds threadID ("" is the root thread) to it. If the thread was
// bound to another handle of the conversation (its provider or model switched),
// it is retired from that handle: the handle is closed once no thread is bound
// to it, and otherwise only the thread's own work on it is cancelled, leaving
// sibling threads' turns there alone. Handles of the conversation rooted in
// another workspace are closed outright (the conversation was rebound).
//
// workspaceRoot is the directory this conversation works in, already resolved
// from its binding — "" for the project. The caller resolves it rather than the
// cache, so a binding that cannot be honoured fails the turn before any handle
// is opened.
func (cc *conversationCache) GetOrOpen(ctx context.Context, convID, threadID, providerName, model string, credential core.ProviderCredential, capabilities provider.ModelCapabilities, workspaceRoot string) (provider.Conversation, error) {
	resp := make(chan cacheResult, 1)
	cc.ops <- cacheOp{
		kind: cacheOpGetOrOpen,
		key: conversationCacheKey{
			convID:        convID,
			providerName:  providerName,
			model:         model,
			credential:    credential.CacheKey(),
			capabilities:  capabilities,
			workspaceRoot: workspaceRoot,
		},
		credential: credential,
		threadID:   threadID,
		respCh:     resp,
	}
	r := <-resp
	return r.conv, r.err
}

// CloseConversation drops every cached Conversation for the given convID
// (across all providers and models). Called when the conversation is
// permanently deleted; idempotent.
func (cc *conversationCache) CloseConversation(convID string) {
	done := make(chan struct{}, 1)
	cc.ops <- cacheOp{
		kind:   cacheOpCloseConversation,
		convID: convID,
		doneCh: done,
	}
	<-done
}

// CancelConversation invokes Cancel on every cached Conversation for the given
// convID, naming the thread to cancel ("" is the root thread;
// provider.CancelAllThreads is every thread, for conversation teardown). The
// cache already holds the handle, so no registry-wide fanout is needed. Cancel
// is warm-preserving (it never drops the resume anchor), so the handle stays
// usable for the next turn. Idempotent.
func (cc *conversationCache) CancelConversation(convID, threadID string) {
	done := make(chan struct{}, 1)
	cc.ops <- cacheOp{
		kind:     cacheOpCancelConversation,
		convID:   convID,
		threadID: threadID,
		doneCh:   done,
	}
	<-done
}

// SetTurnSinkFactory registers the factory used to Subscribe newly-opened
// Conversations to a TurnSink (autonomous-turn routing). Must be called before
// the first GetOrOpen so every handle is subscribed; handles opened before it
// is set get no autonomous-turn routing. Routed through the actor so the
// factory field needs no mutex.
func (cc *conversationCache) SetTurnSinkFactory(fn turnSinkFactory) {
	done := make(chan struct{}, 1)
	cc.ops <- cacheOp{kind: cacheOpSetSinkFactory, sinkFactory: fn, doneCh: done}
	<-done
}

// Shutdown closes every cached Conversation and stops the actor. Safe
// to call multiple times.
func (cc *conversationCache) Shutdown() {
	done := make(chan struct{}, 1)
	select {
	case cc.ops <- cacheOp{kind: cacheOpShutdown, doneCh: done}:
		<-done
	case <-cc.done:
		// Already shut down.
	}
}

// pending reports done unless it has already closed, in which case it forgets
// the entry and reports nil.
func pending[K comparable](m map[K]<-chan struct{}, key K) <-chan struct{} {
	done := m[key]
	if done == nil {
		return nil
	}
	select {
	case <-done:
		delete(m, key)
		return nil
	default:
		return done
	}
}

// runActor owns the entries map; serialises every read and write so the
// cache itself needs no mutex.
func (cc *conversationCache) runActor() {
	entries := make(map[conversationCacheKey]provider.Conversation)
	// bound maps each thread to the handle it last used; users is its inverse,
	// the threads bound to each handle.
	bound := make(map[threadRef]conversationCacheKey)
	users := make(map[conversationCacheKey]map[string]struct{})
	// retiring holds, per handle, the cancellation of a thread that has left
	// it. A turn that reuses the handle waits for it, so the cancel cannot land
	// on that turn's fresh work.
	retiring := make(map[conversationCacheKey]<-chan struct{})
	cancelling := make(map[string]<-chan struct{})
	deferUntil := func(done <-chan struct{}, op cacheOp) {
		go func() {
			<-done
			cc.ops <- op
		}()
	}
	// closeHandle closes one handle and forgets it and every thread bound to it.
	// A thread's cancellation still running on it is let finish first, outside
	// the actor: a provider's Close ends the handle, and a Cancel arriving after
	// it may never return.
	closeHandle := func(key conversationCacheKey, conv provider.Conversation) {
		closeConv := func() {
			if err := conv.Close(); err != nil {
				jlog.Debug("conversation cache: close %s (%s/%s): %v", key.convID, key.providerName, key.model, err)
			}
		}
		if before := pending(retiring, key); before != nil {
			go func() {
				<-before
				closeConv()
			}()
		} else {
			closeConv()
		}
		for threadID := range users[key] {
			delete(bound, threadRef{convID: key.convID, threadID: threadID})
		}
		delete(users, key)
		delete(entries, key)
		delete(retiring, key)
	}
	// bind points the thread at key, retiring it from the handle it was bound
	// to before.
	bind := func(key conversationCacheKey, threadID string) {
		ref := threadRef{convID: key.convID, threadID: threadID}
		if prev, ok := bound[ref]; ok && prev != key {
			delete(users[prev], threadID)
			if conv, open := entries[prev]; open {
				if len(users[prev]) == 0 {
					closeHandle(prev, conv)
				} else {
					// Other threads are still bound to the old handle, perhaps
					// mid-turn: release only this thread's work there. Cancel can
					// wait for a turn to unwind, so it runs outside the actor.
					done := make(chan struct{})
					before := pending(retiring, prev)
					retiring[prev] = done
					go func() {
						if before != nil {
							<-before
						}
						conv.Cancel(threadID)
						close(done)
					}()
				}
			}
		}
		bound[ref] = key
		if users[key] == nil {
			users[key] = make(map[string]struct{})
		}
		users[key][threadID] = struct{}{}
	}
	var sinkFactory turnSinkFactory
	for op := range cc.ops {
		switch op.kind {
		case cacheOpSetSinkFactory:
			sinkFactory = op.sinkFactory
			op.doneCh <- struct{}{}

		case cacheOpGetOrOpen:
			if done := pending(cancelling, op.key.convID); done != nil {
				deferUntil(done, op)
				continue
			}
			if done := pending(retiring, op.key); done != nil {
				deferUntil(done, op)
				continue
			}
			// A workspace switch rebinds the whole conversation: close every
			// handle rooted anywhere else, whichever threads are bound to it.
			for k, conv := range entries {
				if k.convID == op.key.convID && k.workspaceRoot != op.key.workspaceRoot {
					closeHandle(k, conv)
				}
			}
			if existing, ok := entries[op.key]; ok {
				bind(op.key, op.threadID)
				op.respCh <- cacheResult{conv: existing}
				continue
			}
			info, _ := provider.GetProviderInfo(op.key.providerName)
			var projectPath string
			if cc.projectPath != nil {
				projectPath = cc.projectPath()
			}
			prov, err := provider.InitializeProvider(op.key.providerName, provider.Config{
				APIKey:            op.credential.APIKey,
				BearerToken:       op.credential.BearerToken,
				Headers:           op.credential.Headers,
				Model:             op.key.model,
				ProjectPath:       projectPath,
				WorkspaceRoot:     op.key.workspaceRoot,
				ModelCapabilities: op.key.capabilities,
				BudgetContract: provider.BudgetContract{
					AllowUnknownLimits: info.AllowUnknownLimits,
				},
			})
			if err != nil {
				op.respCh <- cacheResult{err: fmt.Errorf("initialize provider %q: %w", op.key.providerName, err)}
				continue
			}
			// OpenConversation runs synchronously inside the actor; it
			// must be cheap. All current providers return a stateless
			// wrapper instantly. claudecode's eventual stateful handle
			// should likewise not do I/O here (just allocate; CLI spawn
			// happens on first Submit).
			conv, err := provider.OpenConversation(context.Background(), prov, op.key.convID)
			if err != nil {
				op.respCh <- cacheResult{err: fmt.Errorf("open conversation: %w", err)}
				continue
			}
			// Subscribe the handle to its autonomous-turn sink before returning
			// it, so the field write happens-before the caller uses the handle
			// for a turn (the respCh send below establishes that ordering). Only
			// done on first open — cached handles are already subscribed.
			if sinkFactory != nil {
				conv.Subscribe(sinkFactory(op.key.convID))
			}
			entries[op.key] = conv
			bind(op.key, op.threadID)
			op.respCh <- cacheResult{conv: conv}

		case cacheOpCloseConversation:
			if done := pending(cancelling, op.convID); done != nil {
				deferUntil(done, op)
				continue
			}
			for k, conv := range entries {
				if k.convID == op.convID {
					closeHandle(k, conv)
				}
			}
			op.doneCh <- struct{}{}

		case cacheOpCancelConversation:
			// Don't drop the entry — Cancel preserves the handle and its warm
			// resume token for the next turn. Cancellation can wait for a provider
			// turn to unwind, so run it outside this process-wide cache actor and
			// acknowledge once cancellation has started. A stuck provider must not
			// block its worker or prevent unrelated conversations from opening or
			// switching providers. Later operations for this conversation wait for
			// cancellation so its handle still has a single lifecycle owner.
			if pending(cancelling, op.convID) != nil {
				op.doneCh <- struct{}{}
				continue
			}
			var conversations []provider.Conversation
			for k, conv := range entries {
				if k.convID == op.convID {
					conversations = append(conversations, conv)
				}
			}
			cancelDone := make(chan struct{})
			cancelling[op.convID] = cancelDone
			threadID := op.threadID
			go func() {
				for _, conv := range conversations {
					conv.Cancel(threadID)
				}
				close(cancelDone)
			}()
			op.doneCh <- struct{}{}

		case cacheOpShutdown:
			for k, conv := range entries {
				closeHandle(k, conv)
			}
			close(cc.done)
			op.doneCh <- struct{}{}
			return
		}
	}
}
