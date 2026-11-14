//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

func TestRefreshProvidersDuringComputeQueuesLatestFollowUp(t *testing.T) {
	s := newReadyTestServer()
	s.hub = newClientHub()
	s.refreshRequests = make(chan struct{}, 1)

	started := make(chan int, 3)
	release := make(chan struct{}, 3)
	var state atomic.Int32
	var calls atomic.Int32
	s.computeProvidersFunc = func(context.Context) []ProviderStatus {
		call := int(calls.Add(1))
		started <- call
		<-release
		return []ProviderStatus{{Name: strconv.Itoa(int(state.Load()))}}
	}
	go s.runProviderRefreshActor()
	t.Cleanup(func() { close(s.shutdownChan) })

	state.Store(1)
	s.RefreshProviders()
	select {
	case call := <-started:
		if call != 1 {
			t.Fatalf("first compute call = %d", call)
		}
	case <-time.After(time.Second):
		t.Fatal("first provider compute did not start")
	}

	state.Store(2)
	for range 10 {
		s.RefreshProviders()
	}
	release <- struct{}{}

	select {
	case call := <-started:
		if call != 2 {
			t.Fatalf("follow-up compute call = %d", call)
		}
	case <-time.After(time.Second):
		t.Fatal("refresh during compute was dropped")
	}
	release <- struct{}{}

	deadline := time.Now().Add(time.Second)
	for {
		providers := s.cachedProviders()
		if len(providers) == 1 && providers[0].Name == "2" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("published providers = %+v, want latest state", providers)
		}
		time.Sleep(time.Millisecond)
	}
	if !s.providersReadyNow() {
		t.Fatal("provider refresh did not preserve readiness signaling")
	}

	select {
	case call := <-started:
		t.Fatalf("burst produced unexpected compute %d", call)
	case <-time.After(50 * time.Millisecond):
	}
}

// TestRefreshAnswersWithAListComputedAfterIt: the settings page's re-check
// draws a card from what POST /providers/refresh answers, so the answer must
// come from a recomputation that began after the request — however long its
// probes take — and never from the cache, nor from a recomputation that was
// already under way and so may predate the sign-in being checked.
func TestRefreshAnswersWithAListComputedAfterIt(t *testing.T) {
	s := newReadyTestServer()
	s.hub = newClientHub()
	s.refreshRequests = make(chan struct{}, 1)

	started := make(chan int, 3)
	release := make(chan struct{}, 3)
	var state atomic.Int32
	var calls atomic.Int32
	// Each recomputation sees the state as it was when it began.
	s.computeProvidersFunc = func(context.Context) []ProviderStatus {
		seen := state.Load()
		started <- int(calls.Add(1))
		<-release
		return []ProviderStatus{{Name: strconv.Itoa(int(seen))}}
	}
	go s.runProviderRefreshActor()
	t.Cleanup(func() { close(s.shutdownChan) })
	wait := func(what string) {
		t.Helper()
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatalf("%s never started", what)
		}
	}

	// A recomputation is under way, of the state before the sign-in.
	state.Store(1)
	s.RefreshProviders()
	wait("the recomputation already under way")

	// The user signs in and re-checks.
	state.Store(2)
	answered := make(chan []ProviderStatus, 1)
	go func() {
		rec := httptest.NewRecorder()
		s.handleRefreshProviders(rec, httptest.NewRequest(http.MethodPost, "/api/providers/refresh", nil))
		var body struct {
			Providers []ProviderStatus `json:"providers"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		answered <- body.Providers
	}()

	// The one under way finishes; the re-check's own has not begun, so the
	// re-check has nothing to answer with yet.
	release <- struct{}{}
	select {
	case got := <-answered:
		t.Fatalf("the re-check answered %+v before a recomputation that began after it", got)
	case <-started:
	}
	select {
	case got := <-answered:
		t.Fatalf("the re-check answered %+v while its recomputation was still running", got)
	case <-time.After(20 * time.Millisecond):
	}

	release <- struct{}{}
	select {
	case got := <-answered:
		if len(got) != 1 || got[0].Name != "2" {
			t.Fatalf("the re-check answered %+v; want the list computed after it", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the re-check never answered once its recomputation was published")
	}
}
