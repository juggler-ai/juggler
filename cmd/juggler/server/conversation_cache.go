//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Server-side per-conversation Provider Conversation cache. One handle
// per (convID, providerName, model, credential, workspace) tuple, opened
// lazily, reused across turns. It is the home for long-lived per-conversation
// state (e.g. claudecode's session bookkeeping).
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
// mid-conversation configuration switch closes the old handle and opens a new
// one.
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

// conversationCache stores Conversation handles keyed by (convID,
// providerName, model, credential, workspace). Lifetime is bounded by the
// server process or an explicit Close(convID). Cache is per-server-instance;
// not shared across processes.
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
	kind        cacheOpKind
	key         conversationCacheKey
	credential  core.ProviderCredential
	convID      string // for close / cancel ops (matches every cached entry for that conv)
	threadID    string // for cancel ops: the thread to cancel, or provider.CancelAllThreads
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

// GetOrOpen returns the cached Conversation for the key, opening a new
// one if absent. If a Conversation exists for the same convID but a
// different (provider, model, workspace), the old handle is closed first (the
// user switched models mid-conversation, or rebound the conversation).
//
// workspaceRoot is the directory this conversation works in, already resolved
// from its binding — "" for the project. The caller resolves it rather than the
// cache, so a binding that cannot be honoured fails the turn before any handle
// is opened.
func (cc *conversationCache) GetOrOpen(ctx context.Context, convID, providerName, model string, credential core.ProviderCredential, capabilities provider.ModelCapabilities, workspaceRoot string) (provider.Conversation, error) {
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

// runActor owns the entries map; serialises every read and write so the
// cache itself needs no mutex.
func (cc *conversationCache) runActor() {
	entries := make(map[conversationCacheKey]provider.Conversation)
	cancelling := make(map[string]<-chan struct{})
	pendingCancellation := func(convID string) <-chan struct{} {
		done := cancelling[convID]
		if done == nil {
			return nil
		}
		select {
		case <-done:
			delete(cancelling, convID)
			return nil
		default:
			return done
		}
	}
	deferUntil := func(done <-chan struct{}, op cacheOp) {
		go func() {
			<-done
			cc.ops <- op
		}()
	}
	var sinkFactory turnSinkFactory
	for op := range cc.ops {
		switch op.kind {
		case cacheOpSetSinkFactory:
			sinkFactory = op.sinkFactory
			op.doneCh <- struct{}{}

		case cacheOpGetOrOpen:
			if done := pendingCancellation(op.key.convID); done != nil {
				deferUntil(done, op)
				continue
			}
			if existing, ok := entries[op.key]; ok {
				op.respCh <- cacheResult{conv: existing}
				continue
			}
			// Close any other entries for the same convID (provider/model/
			// workspace switch). Conversations are bound to (provider, model,
			// workspace) for the lifetime of the handle; switching any of them
			// invalidates the old resource.
			for k, conv := range entries {
				if k.convID == op.key.convID {
					_ = conv.Close()
					delete(entries, k)
				}
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
			op.respCh <- cacheResult{conv: conv}

		case cacheOpCloseConversation:
			if done := pendingCancellation(op.convID); done != nil {
				deferUntil(done, op)
				continue
			}
			for k, conv := range entries {
				if k.convID == op.convID {
					if err := conv.Close(); err != nil {
						jlog.Debug("conversation cache: close %s (%s/%s): %v", k.convID, k.providerName, k.model, err)
					}
					delete(entries, k)
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
			if pendingCancellation(op.convID) != nil {
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
				if err := conv.Close(); err != nil {
					jlog.Debug("conversation cache: shutdown close %s (%s/%s): %v", k.convID, k.providerName, k.model, err)
				}
				delete(entries, k)
			}
			close(cc.done)
			op.doneCh <- struct{}{}
			return
		}
	}
}
