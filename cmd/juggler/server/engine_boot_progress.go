//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

// Boot progress: how far an engine has got towards connecting its socket.
//
// How long an engine takes to boot is how fast the machine is, so a startup
// budget of wall time gives up on a healthy engine on a starved core. What does
// tell a slow engine from a dead one is whether it is getting anywhere: a
// webview engine loads /engine and then imports its whole module graph through
// /worker-module before it dials, and a node engine imports its extensions
// there too. Neither route serves anything else.
//
// Traffic is not progress. A renderer that crashes part-way through its boot is
// reloaded by WebKit and fetches the same things again, for ever; counting
// those fetches would keep a server with no working engine alive, which is the
// very thing the startup budget exists to prevent. So each page load starts a
// boot, and progress is a boot reaching more distinct fetches than any boot
// before it — getting further than the engine has ever got.

import (
	"sync/atomic"
	"time"
)

// engineBootProgress tracks the current boot's distinct fetches and the
// furthest any boot has reached. Its state is replaced whole, never mutated,
// so a reader holds a consistent snapshot; the zero value has seen nothing.
type engineBootProgress struct {
	state atomic.Pointer[engineBootState]
}

type engineBootState struct {
	// seen holds the current boot's distinct fetches.
	seen map[string]bool
	// best is the most distinct fetches any boot has reached.
	best int
	// at is when best last grew; zero until the engine has fetched anything.
	at time.Time
	// stepAt is when the current boot last reached a fetch it had not made:
	// progress within this boot, where at is progress beyond every boot.
	stepAt time.Time
}

// note records a fetch, as the first of a new boot when newBoot is set.
func (b *engineBootProgress) note(url string, newBoot bool) {
	for {
		cur := b.state.Load()
		old := cur
		if old == nil {
			old = &engineBootState{}
		} else if !newBoot && old.seen[url] {
			return
		}
		next := &engineBootState{seen: map[string]bool{url: true}, best: old.best, at: old.at, stepAt: time.Now()}
		if !newBoot {
			for u := range old.seen {
				next.seen[u] = true
			}
		}
		if len(next.seen) > next.best {
			next.best, next.at = len(next.seen), time.Now()
		}
		if b.state.CompareAndSwap(cur, next) {
			return
		}
	}
}

// noteEnginePage records a load of the engine page: the start of a boot, and
// its first fetch.
func (s *Server) noteEnginePage() { s.engineBoot.note("/engine", true) }

// noteEngineFetch records one of the engine's boot fetches.
func (s *Server) noteEngineFetch(url string) { s.engineBoot.note(url, false) }

// EngineBootProgressAt is when the engine last got further towards connecting
// than it ever had; zero if it has fetched nothing yet.
func (s *Server) EngineBootProgressAt() time.Time {
	if st := s.engineBoot.state.Load(); st != nil {
		return st.at
	}
	return time.Time{}
}

// engineBootStepAt is when the current boot last made a fetch it had not made
// before; zero if the engine has fetched nothing yet. Unlike
// EngineBootProgressAt, a reload counts from its own start: it re-fetches what
// the boot before it did, which is no progress towards a first connection but
// is the reloaded engine getting somewhere.
func (s *Server) engineBootStepAt() time.Time {
	if st := s.engineBoot.state.Load(); st != nil {
		return st.stepAt
	}
	return time.Time{}
}
