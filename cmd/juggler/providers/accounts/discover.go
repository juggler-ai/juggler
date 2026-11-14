//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package accounts

import (
	"context"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
)

// Further logins found on this machine — a second Claude Code config dir, say
// — are found by each type's Discover. That can mean running a CLI per login
// to confirm it, so it is not done on every list: once in the background at
// startup, and again when the settings page asks (the "discover" op), at most
// every rediscoverInterval. Between runs the page is drawn from what was found.

// rediscoverInterval is the least time between two discoveries.
const rediscoverInterval = 30 * time.Second

// discoverTimeout bounds one discovery: each probe has its own timeout, and a
// wedged one must not hold the page.
const discoverTimeout = 20 * time.Second

// discoverLock guards discovered and discoveredAt; a 1-capacity channel used as
// a binary semaphore (the codebase forbids sync.Mutex).
var (
	discoverLock = make(chan struct{}, 1)
	discovered   []provider.Candidate
	discoveredAt time.Time
)

// rediscover runs every type's discovery and keeps what it found.
func rediscover(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, discoverTimeout)
	defer cancel()
	var found []provider.Candidate
	results := make(chan []provider.Candidate)
	n := 0
	for _, t := range provider.Types() {
		if t.Discover == nil {
			continue
		}
		n++
		go func() { results <- t.Discover(ctx) }()
	}
	for range n {
		found = append(found, <-results...)
	}
	discoverLock <- struct{}{}
	discovered, discoveredAt = found, time.Now()
	<-discoverLock
}

// rediscoverIfStale runs discovery when the last run is older than
// rediscoverInterval.
func rediscoverIfStale(ctx context.Context) {
	discoverLock <- struct{}{}
	stale := time.Since(discoveredAt) >= rediscoverInterval
	<-discoverLock
	if stale {
		rediscover(ctx)
	}
}

// foundCandidates is what the last discovery found that is not an account
// already.
func foundCandidates(file core.AccountsFile) []provider.Candidate {
	discoverLock <- struct{}{}
	all := append([]provider.Candidate(nil), discovered...)
	<-discoverLock
	out := all[:0]
	for _, c := range all {
		if !isAccountAlready(file, c) {
			out = append(out, c)
		}
	}
	return out
}

// foundCandidate is the found login whose key is key.
func foundCandidate(key string) (provider.Candidate, bool) {
	discoverLock <- struct{}{}
	defer func() { <-discoverLock }()
	for _, c := range discovered {
		if c.Key == key {
			return c, true
		}
	}
	return provider.Candidate{}, false
}

// isAccountAlready reports whether an account has the login the candidate
// would add (TypeInfo.LoginKey).
func isAccountAlready(file core.AccountsFile, c provider.Candidate) bool {
	t, ok := provider.LookupType(c.Type)
	if !ok {
		return false
	}
	_, taken := accountWithLogin(file, t, c.Settings, "")
	return taken
}
