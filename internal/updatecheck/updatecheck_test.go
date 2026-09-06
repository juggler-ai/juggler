//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package updatecheck

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCompareSemver(t *testing.T) {
	cases := []struct {
		a, b string
		want int
		ok   bool
	}{
		{"v0.0.8", "v0.1.0", -1, true},
		{"0.0.8", "0.1.0", -1, true},
		{"v0.1.0", "v0.0.8", 1, true},
		{"v1.2.3", "v1.2.3", 0, true},
		{"v1.2", "v1.2.0", 0, true},
		{"v1.2.3-beta.1", "v1.2.3", 0, true}, // prerelease suffix ignored
		{"v2.0.0", "v10.0.0", -1, true},      // numeric, not lexical
		{"dev", "v0.1.0", 0, false},
		{"v0.1.0", "garbage", 0, false},
		{"", "v0.1.0", 0, false},
	}
	for _, c := range cases {
		got, ok := compareSemver(c.a, c.b)
		if got != c.want || ok != c.ok {
			t.Errorf("compareSemver(%q,%q) = (%d,%v), want (%d,%v)", c.a, c.b, got, ok, c.want, c.ok)
		}
	}
}

func TestComputeStatus(t *testing.T) {
	notice := &Notice{ID: "upgrade-0.1.0", Severity: "recommended", Title: "Update"}
	m := &Manifest{Schema: Schema, SchemaVersion: 1, Latest: "v0.1.0", Notice: notice}

	t.Run("older shows notice", func(t *testing.T) {
		st := ComputeStatus(m, "v0.0.8")
		if !st.UpdateAvailable || st.Notice == nil || st.Notice.ID != "upgrade-0.1.0" {
			t.Fatalf("expected update+notice, got %+v", st)
		}
		if st.LatestVersion != "v0.1.0" || st.CurrentVersion != "v0.0.8" {
			t.Errorf("version fields = %q/%q", st.CurrentVersion, st.LatestVersion)
		}
	})
	t.Run("equal shows nothing", func(t *testing.T) {
		st := ComputeStatus(m, "v0.1.0")
		if st.UpdateAvailable || st.Notice != nil {
			t.Fatalf("expected no update, got %+v", st)
		}
	})
	t.Run("newer shows nothing", func(t *testing.T) {
		st := ComputeStatus(m, "v0.2.0")
		if st.UpdateAvailable || st.Notice != nil {
			t.Fatalf("expected no update, got %+v", st)
		}
	})
	t.Run("dev build never nags", func(t *testing.T) {
		st := ComputeStatus(m, "dev")
		if st.UpdateAvailable || st.Notice != nil {
			t.Fatalf("dev should not update, got %+v", st)
		}
	})
	t.Run("nil manifest", func(t *testing.T) {
		st := ComputeStatus(nil, "v0.0.8")
		if st.UpdateAvailable || st.Notice != nil || st.CurrentVersion != "v0.0.8" {
			t.Fatalf("unexpected %+v", st)
		}
	})
}

func TestCheckOnce(t *testing.T) {
	const manifest = `{
		"schema": "juggler-version",
		"schemaVersion": 1,
		"latest": "v0.1.0",
		"notice": {"id": "upgrade-0.1.0", "severity": "recommended", "title": "Juggler 0.1.0"},
		"downloads": {"darwin/arm64": {"url": "https://example.com/x.dmg"}}
	}`

	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		w.Header().Set("ETag", `"v1"`)
		_, _ = w.Write([]byte(manifest))
	}))
	defer srv.Close()

	var changes []Status
	c := New(Config{
		URL:            srv.URL,
		CurrentVersion: "v0.0.8",
		OS:             "darwin",
		Arch:           "arm64",
		OnChange:       func(s Status) { changes = append(changes, s) },
	})

	if err := c.CheckOnce(context.Background()); err != nil {
		t.Fatalf("CheckOnce: %v", err)
	}
	// The whole query, not just the parts we expect: the request describes the
	// build and carries nothing else, so anything added here has to be
	// deliberate enough to update this line.
	if want := "arch=arm64&os=darwin&v=v0.0.8"; gotQuery != want {
		t.Errorf("query = %q, want %q", gotQuery, want)
	}
	st := c.Current()
	if !st.UpdateAvailable || st.Notice == nil || st.Notice.ID != "upgrade-0.1.0" {
		t.Fatalf("status = %+v", st)
	}
	if len(changes) != 1 {
		t.Fatalf("OnChange fired %d times, want 1", len(changes))
	}

	// Second identical fetch must NOT re-fire OnChange (no change).
	if err := c.CheckOnce(context.Background()); err != nil {
		t.Fatalf("CheckOnce#2: %v", err)
	}
	if len(changes) != 1 {
		t.Fatalf("OnChange fired %d times after stable fetch, want 1", len(changes))
	}
}

func TestCheckOnceRejectsForeignBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<html>captive portal</html>`))
	}))
	defer srv.Close()

	c := New(Config{URL: srv.URL, CurrentVersion: "v0.0.8"})
	if err := c.CheckOnce(context.Background()); err == nil {
		t.Fatal("expected error for non-manifest body")
	}
	if c.Current().UpdateAvailable {
		t.Fatal("foreign body must not flip updateAvailable")
	}
}

func TestCheckOnceRejectsBadSchema(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"schema":"something-else","schemaVersion":1,"latest":"v9.9.9"}`))
	}))
	defer srv.Close()

	c := New(Config{URL: srv.URL, CurrentVersion: "v0.0.8"})
	if err := c.CheckOnce(context.Background()); err == nil {
		t.Fatal("expected error for wrong schema")
	}
}

func TestCheckOnceNotModified(t *testing.T) {
	const manifest = `{"schema":"juggler-version","schemaVersion":1,"latest":"v0.1.0",
		"notice":{"id":"n1","severity":"info"}}`
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if r.Header.Get("If-None-Match") == `"etag1"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", `"etag1"`)
		_, _ = w.Write([]byte(manifest))
	}))
	defer srv.Close()

	changes := 0
	c := New(Config{URL: srv.URL, CurrentVersion: "v0.0.8", OnChange: func(Status) { changes++ }})
	if err := c.CheckOnce(context.Background()); err != nil {
		t.Fatalf("first: %v", err)
	}
	if err := c.CheckOnce(context.Background()); err != nil {
		t.Fatalf("second: %v", err)
	}
	if hits != 2 {
		t.Fatalf("server hit %d times, want 2", hits)
	}
	if changes != 1 {
		t.Fatalf("OnChange fired %d times, want 1 (304 must not re-fire)", changes)
	}
	if !c.Current().UpdateAvailable {
		t.Fatal("304 must preserve last-good status")
	}
}

func TestCheckOnceGateDisabled(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Header().Set("ETag", `"v1"`)
		_, _ = w.Write([]byte(`{"schema":"juggler-version","schemaVersion":1,"latest":"v9.9.9",
			"notice":{"id":"n1","severity":"info"}}`))
	}))
	defer srv.Close()

	c := New(Config{
		URL:            srv.URL,
		CurrentVersion: "v0.0.8",
		Enabled:        func() bool { return false },
	})

	// Gated: CheckOnce makes no request and leaves the seeded status untouched.
	if err := c.CheckOnce(context.Background()); err != nil {
		t.Fatalf("CheckOnce (gated): %v", err)
	}
	if hits != 0 {
		t.Fatalf("gated CheckOnce hit server %d times, want 0", hits)
	}
	if c.Current().UpdateAvailable {
		t.Fatal("gated CheckOnce must not flip updateAvailable")
	}

	// Manual CheckNow bypasses the gate and updates the status.
	if err := c.CheckNow(context.Background()); err != nil {
		t.Fatalf("CheckNow: %v", err)
	}
	if hits != 1 {
		t.Fatalf("CheckNow hit server %d times, want 1", hits)
	}
	if !c.Current().UpdateAvailable {
		t.Fatal("CheckNow must bypass the gate and update status")
	}
}

// markStub supplies a fixed mark and records how it was used.
type markStub struct {
	mark     int
	calls    int
	released int
}

func (s *markStub) fn() (int, func()) {
	s.calls++
	return s.mark, func() { s.released++ }
}

func TestCheckOnceMark(t *testing.T) {
	const manifest = `{"schema":"juggler-version","schemaVersion":1,"latest":"v0.1.0"}`
	// serve returns a checker wired to stub, plus a pointer to the last query.
	serve := func(t *testing.T, stub *markStub, enabled bool, h http.HandlerFunc) (*Checker, *string) {
		got := new(string)
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			*got = r.URL.RawQuery
			h(w, r)
		}))
		t.Cleanup(srv.Close)
		return New(Config{
			URL:            srv.URL,
			CurrentVersion: "v0.0.8",
			OS:             "darwin",
			Arch:           "arm64",
			Mark:           stub.fn,
			Enabled:        func() bool { return enabled },
		}), got
	}
	ok := func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(manifest)) }

	t.Run("the mark rides on the scheduled check", func(t *testing.T) {
		stub := &markStub{mark: 3}
		c, got := serve(t, stub, true, ok)
		if err := c.CheckOnce(context.Background()); err != nil {
			t.Fatalf("CheckOnce: %v", err)
		}
		if want := "arch=arm64&countme=3&os=darwin&v=v0.0.8"; *got != want {
			t.Errorf("query = %q, want %q", *got, want)
		}
		if stub.released != 0 {
			t.Errorf("release ran %d times after a good check, want 0", stub.released)
		}
	})

	t.Run("nothing to claim sends no param", func(t *testing.T) {
		stub := &markStub{mark: 0}
		c, got := serve(t, stub, true, ok)
		if err := c.CheckOnce(context.Background()); err != nil {
			t.Fatalf("CheckOnce: %v", err)
		}
		if want := "arch=arm64&os=darwin&v=v0.0.8"; *got != want {
			t.Errorf("query = %q, want %q (no countme=0)", *got, want)
		}
	})

	t.Run("manual and gated checks never consult the claim", func(t *testing.T) {
		// CheckNow deliberately ignores the Enabled gate, so it must not reach
		// for a mark at all rather than merely dropping it.
		stub := &markStub{mark: 3}
		c, got := serve(t, stub, false, ok)
		if err := c.CheckNow(context.Background()); err != nil {
			t.Fatalf("CheckNow: %v", err)
		}
		if want := "arch=arm64&os=darwin&v=v0.0.8"; *got != want {
			t.Errorf("manual query = %q, want %q", *got, want)
		}
		if err := c.CheckOnce(context.Background()); err != nil {
			t.Fatalf("CheckOnce (gated): %v", err)
		}
		if stub.calls != 0 {
			t.Errorf("claim consulted %d times off the scheduled path, want 0", stub.calls)
		}
	})

	t.Run("a request that never arrives gives the claim back", func(t *testing.T) {
		stub := &markStub{mark: 3}
		srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		srv.Close() // nothing listening
		c := New(Config{URL: srv.URL, CurrentVersion: "v0.0.8", Mark: stub.fn})
		if err := c.CheckOnce(context.Background()); err == nil {
			t.Fatal("expected a transport error")
		}
		if stub.released != 1 {
			t.Errorf("release ran %d times, want 1", stub.released)
		}
	})

	t.Run("an error response keeps the claim", func(t *testing.T) {
		// The request arrived and was recorded at the other end before the
		// version lookup failed, so handing it back would report twice.
		stub := &markStub{mark: 3}
		c, _ := serve(t, stub, true, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadGateway)
		})
		if err := c.CheckOnce(context.Background()); err == nil {
			t.Fatal("expected an error for a 502")
		}
		if stub.released != 0 {
			t.Errorf("release ran %d times after a 502, want 0", stub.released)
		}
	})
}
