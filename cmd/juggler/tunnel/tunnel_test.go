//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package tunnel

import "testing"

// withEmptyRegistry swaps the registry for the duration of a test. The
// registry is a startup-time package global, so a test that exercises it
// saves and restores it rather than leaking modes into other tests.
func withEmptyRegistry(t *testing.T) {
	t.Helper()
	saved, wasSealed := registry, sealed.Load()
	registry = nil
	sealed.Store(false)
	t.Cleanup(func() {
		registry = saved
		sealed.Store(wasSealed)
	})
}

func noProvider(Host) Provider { return nil }

// TestRegisterModeValidation: invalid and duplicate registrations fail loudly
// at startup rather than being silently accepted, and a valid one is found.
func TestRegisterModeValidation(t *testing.T) {
	withEmptyRegistry(t)

	mustPanic := func(name string, fn func()) {
		t.Helper()
		defer func() {
			if recover() == nil {
				t.Fatalf("%s: expected panic", name)
			}
		}()
		fn()
	}

	mustPanic("missing mode", func() { RegisterMode(ModeSpec{New: noProvider}) })
	mustPanic("missing factory", func() { RegisterMode(ModeSpec{Mode: "x"}) })

	RegisterMode(ModeSpec{Mode: "x", New: noProvider})
	mustPanic("duplicate mode", func() { RegisterMode(ModeSpec{Mode: "x", New: noProvider}) })

	if _, ok := Find("x"); !ok {
		t.Fatal("a registered mode is not found")
	}
	if _, ok := Find("y"); ok {
		t.Fatal("an unregistered mode is found")
	}
	if got := Modes(); len(got) != 1 || got[0].Mode != "x" {
		t.Fatalf("Modes() = %+v, want just x", got)
	}
}

// TestRegisterModeAfterSealPanics: the registry is read without a lock once a
// server reads it, so a registration after that is refused loudly rather than
// racing the readers.
func TestRegisterModeAfterSealPanics(t *testing.T) {
	withEmptyRegistry(t)
	RegisterMode(ModeSpec{Mode: "early", New: noProvider})

	Seal()
	defer func() {
		if recover() == nil {
			t.Fatal("a registration after the seal was accepted")
		}
		if _, ok := Find("late"); ok {
			t.Fatal("a refused registration still landed in the registry")
		}
	}()
	RegisterMode(ModeSpec{Mode: "late", New: noProvider})
}

// TestLinkTo: a page of the server is reached through a tunnel as its mode
// says, and by default at the path on the link's own origin, however the link
// ends.
func TestLinkTo(t *testing.T) {
	plain := ModeSpec{}
	for _, link := range []string{"https://relay.example", "https://relay.example/"} {
		if got := plain.LinkTo(link, "/s/abc/"); got != "https://relay.example/s/abc/" {
			t.Errorf("default LinkTo(%q) = %q, want https://relay.example/s/abc/", link, got)
		}
	}
	bootstrap := ModeSpec{PageURL: func(link, path string) string { return link + "#" + path }}
	if got := bootstrap.LinkTo("https://rv.example/c/xyz", "/s/abc/"); got != "https://rv.example/c/xyz#/s/abc/" {
		t.Errorf("a mode's own PageURL: %q, want https://rv.example/c/xyz#/s/abc/", got)
	}
}

// TestAvailability: no probe means available; a probe decides otherwise.
func TestAvailability(t *testing.T) {
	if !(ModeSpec{}).IsAvailable() {
		t.Error("a spec with no probe should be available")
	}
	if (ModeSpec{Available: func() bool { return false }}).IsAvailable() {
		t.Error("a spec whose probe says no should be unavailable")
	}
}
