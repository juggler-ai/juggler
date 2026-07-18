//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
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
