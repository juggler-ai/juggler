//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Server-side per-conversation Provider Conversation cache. One handle
// per (convID, providerName, model, credential) tuple, opened lazily, reused across
// turns. It is the home for long-lived per-conversation state (e.g.
// claudecode's session bookkeeping).
//
// All state is owned by a single goroutine (runActor); GetOrOpen and
// Close send ops to it, so the cache itself needs no mutex. The
// goroutine is started once at server bootstrap and runs until shutdown.

package server

import (
	"context"
	"fmt"

	"juggler/cmd/juggler/core"
	provider "juggler/cmd/juggler/providers/registry"
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
}

// conversationCache stores Conversation handles keyed by (convID,
// providerName, model, credential). Lifetime is bounded by the server process or an
// explicit Close(convID). Cache is per-server-instance; not shared
// across processes.
type conversationCache struct {
	ops  chan cacheOp
	done chan struct{}
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
	kind         cacheOpKind
	key          conversationCacheKey
	credential   core.ProviderCredential
	capabilities provider.ModelCapabilities
	convID       string // for close / cancel ops (matches every cached entry for that conv)
	sinkFactory  turnSinkFactory
	respCh       chan cacheResult
	doneCh       chan struct{}
}

type cacheResult struct {
	conv provider.Conversation
	err  error
}

// newConversationCache spawns the actor and returns the cache handle.
// Caller must call Shutdown at process exit so any provider-side
// resources (live subprocesses, open files) get released.
func newConversationCache() *conversationCache {
	cc := &conversationCache{
		ops:  make(chan cacheOp, 16),
		done: make(chan struct{}),
	}
	go cc.runActor()
	return cc
}

// GetOrOpen returns the cached Conversation for the key, opening a new
// one if absent. If a Conversation exists for the same convID but a
// different (provider, model), the old handle is closed first (the user
// switched models mid-conversation).
func (cc *conversationCache) GetOrOpen(ctx context.Context, convID, providerName, model string, credential core.ProviderCredential, capabilities provider.ModelCapabilities) (provider.Conversation, error) {
	resp := make(chan cacheResult, 1)
	cc.ops <- cacheOp{
		kind: cacheOpGetOrOpen,
		key: conversationCacheKey{
			convID:       convID,
			providerName: providerName,
			model:        model,
			credential:   credential.CacheKey(),
			capabilities: capabilities,
		},
		credential:   credential,
		capabilities: capabilities,
		respCh:       resp,
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

// CancelConversation invokes Cancel on every cached Conversation for the
// given convID. The cache already holds the handle, so no registry-wide
// fanout is needed. Cancel is warm-preserving (it never drops the resume
// anchor), so the handle stays usable for the next turn. Idempotent.
func (cc *conversationCache) CancelConversation(convID string) {
	done := make(chan struct{}, 1)
	cc.ops <- cacheOp{
		kind:   cacheOpCancelConversation,
		convID: convID,
		doneCh: done,
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
	var sinkFactory turnSinkFactory
	for op := range cc.ops {
		switch op.kind {
		case cacheOpSetSinkFactory:
			sinkFactory = op.sinkFactory
			op.doneCh <- struct{}{}

		case cacheOpGetOrOpen:
			if existing, ok := entries[op.key]; ok {
				op.respCh <- cacheResult{conv: existing}
				continue
			}
			// Close any other entries for the same convID (provider/model
			// switch). Conversations are bound to (provider, model) for
			// the lifetime of the handle; switching either invalidates
			// the old resource.
			for k, conv := range entries {
				if k.convID == op.key.convID {
					_ = conv.Close()
					delete(entries, k)
				}
			}
			info, _ := provider.GetProviderInfo(op.key.providerName)
			prov, err := provider.InitializeProvider(op.key.providerName, provider.Config{
				APIKey:            op.credential.APIKey,
				BearerToken:       op.credential.BearerToken,
				Headers:           op.credential.Headers,
				Model:             op.key.model,
				ModelCapabilities: op.capabilities,
				BudgetContract:    provider.BudgetContract{AllowUnknownLimits: info.AllowUnknownLimits},
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
			conv, err := prov.OpenConversation(context.Background(), op.key.convID)
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
			// resume token for the next turn. Only Close removes from the cache.
			for k, conv := range entries {
				if k.convID == op.convID {
					conv.Cancel()
					_ = k
				}
			}
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
