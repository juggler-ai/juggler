//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"testing"
	"time"

	"juggler/internal/userpaths/userpathstest"
)

// mark claims and drops the release, for cases that only care about the mark.
func mark(at time.Time) int {
	m, _ := claimFirstCheck(at)
	return m
}

func TestClaimFirstCheck(t *testing.T) {
	t.Run("once per day and month", func(t *testing.T) {
		userpathstest.Isolate(t)
		sep6 := time.Date(2026, 9, 6, 1, 0, 0, 0, time.UTC)
		if got := mark(sep6); got != firstOfDay|firstOfMonth {
			t.Fatalf("first = %d, want %d", got, firstOfDay|firstOfMonth)
		}
		for _, at := range []time.Time{sep6.Add(6 * time.Hour), sep6.Add(12 * time.Hour)} {
			if got := mark(at); got != 0 {
				t.Fatalf("later check at %v = %d, want 0", at, got)
			}
		}
		if got := mark(sep6.AddDate(0, 0, 1)); got != firstOfDay {
			t.Fatalf("next day = %d, want %d", got, firstOfDay)
		}
		if got := mark(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)); got != firstOfDay|firstOfMonth {
			t.Fatalf("next month = %d, want %d", got, firstOfDay|firstOfMonth)
		}
	})

	t.Run("day boundary is UTC", func(t *testing.T) {
		userpathstest.Isolate(t)
		east := time.FixedZone("east", 13*3600)
		if got := mark(time.Date(2026, 9, 6, 23, 0, 0, 0, time.UTC)); got == 0 {
			t.Fatal("first = 0, want a claim")
		}
		// Same UTC day, a different local one: the boundary must not move.
		if got := mark(time.Date(2026, 9, 7, 11, 0, 0, 0, east)); got != 0 {
			t.Fatalf("same UTC day elsewhere = %d, want 0", got)
		}
	})

	t.Run("release lets the day be claimed again", func(t *testing.T) {
		userpathstest.Isolate(t)
		at := time.Date(2026, 9, 6, 1, 0, 0, 0, time.UTC)
		got, release := claimFirstCheck(at)
		if got != firstOfDay|firstOfMonth {
			t.Fatalf("first = %d, want %d", got, firstOfDay|firstOfMonth)
		}
		// The request never arrived, so the day is unspent. Without this a
		// machine offline at its first poll would go unreported until tomorrow.
		release()
		if got := mark(at.Add(6 * time.Hour)); got != firstOfDay|firstOfMonth {
			t.Fatalf("after release = %d, want %d", got, firstOfDay|firstOfMonth)
		}
		if got := mark(at.Add(12 * time.Hour)); got != 0 {
			t.Fatalf("after re-claim = %d, want 0", got)
		}
	})

	t.Run("concurrent servers claim a day between them", func(t *testing.T) {
		userpathstest.Isolate(t)
		const servers = 8
		at := time.Date(2026, 9, 6, 1, 0, 0, 0, time.UTC)
		start := make(chan struct{})
		got := make(chan int, servers)
		for i := 0; i < servers; i++ {
			go func() {
				<-start
				got <- mark(at)
			}()
		}
		close(start)
		claims := 0
		for i := 0; i < servers; i++ {
			if <-got != 0 {
				claims++
			}
		}
		if claims != 1 {
			t.Fatalf("%d of %d servers claimed the day, want 1", claims, servers)
		}
	})
}
