//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"errors"
	"net"
	"slices"
	"strconv"
	"testing"
)

// realCollision returns the error this platform gives for binding an address
// another socket already holds. It is produced rather than written out because
// the platforms disagree on it: Windows answers WSAEADDRINUSE, whose text is not
// "address already in use" and is translated into the system language.
func realCollision(t *testing.T) error {
	t.Helper()
	first, err := listenForViewers("127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer func() { _ = first.Close() }()
	second, err := listenForViewers(first.Addr().String())
	if err == nil {
		_ = second.Close()
		t.Fatalf("a second listener on %s was allowed; there is no collision to test", first.Addr())
	}
	return err
}

// TestPortUnavailableRecognisesACollision pins that a port another socket holds
// is recognised as busy on every platform, and that an unrelated failure is not.
func TestPortUnavailableRecognisesACollision(t *testing.T) {
	if err := realCollision(t); !portUnavailable(err) {
		t.Fatalf("portUnavailable(%v) = false, want true", err)
	}
	if err := errors.New("listen tcp: something else entirely"); portUnavailable(err) {
		t.Fatalf("portUnavailable(%v) = true, want false", err)
	}
}

// fakeListen answers with err for every port below freeFrom and with a real
// loopback listener from there on, recording each port it was asked for.
type fakeListen struct {
	err      error
	freeFrom int
	asked    []int
}

func (f *fakeListen) listen(addr string) (net.Listener, error) {
	_, portStr, _ := net.SplitHostPort(addr)
	port, _ := strconv.Atoi(portStr)
	f.asked = append(f.asked, port)
	if port < f.freeFrom {
		return nil, f.err
	}
	return net.Listen("tcp", "127.0.0.1:0")
}

// TestBindFirstFreeSkipsBusyPorts is the third window on Windows: earlier
// servers hold the configured port and the ones after it, so the next server
// must step past all of them, not give up at the second busy one.
func TestBindFirstFreeSkipsBusyPorts(t *testing.T) {
	f := &fakeListen{err: realCollision(t), freeFrom: 3942}
	ln, err := bindFirstFree("", 3939, f.listen)
	if err != nil {
		t.Fatalf("bindFirstFree: %v (tried %v)", err, f.asked)
	}
	_ = ln.Close()
	if want := []int{3939, 3940, 3941, 3942}; !slices.Equal(f.asked, want) {
		t.Fatalf("tried ports %v, want %v", f.asked, want)
	}
}

// TestBindFirstFreeStopsOnOtherErrors pins that a failure other than a busy port
// is reported as it is, at the configured port, rather than taken as a reason
// to look elsewhere.
func TestBindFirstFreeStopsOnOtherErrors(t *testing.T) {
	boom := errors.New("listen tcp: something else entirely")
	f := &fakeListen{err: boom, freeFrom: 1 << 16}
	if _, err := bindFirstFree("", 3939, f.listen); !errors.Is(err, boom) {
		t.Fatalf("bindFirstFree error = %v, want %v", err, boom)
	}
	if want := []int{3939}; !slices.Equal(f.asked, want) {
		t.Fatalf("tried ports %v, want %v", f.asked, want)
	}
}

// TestBindFirstFreeGivesUpAfterTheRange pins the bound on the search.
func TestBindFirstFreeGivesUpAfterTheRange(t *testing.T) {
	f := &fakeListen{err: realCollision(t), freeFrom: 1 << 16}
	if _, err := bindFirstFree("", 3939, f.listen); err == nil {
		t.Fatal("bindFirstFree succeeded with every port busy")
	}
	if got, want := len(f.asked), maxPortSearch+1; got != want {
		t.Fatalf("tried %d ports, want %d", got, want)
	}
}

// TestFindAvailablePortBindScope pins which interfaces the listener is bound
// to: every interface by default, so the LAN gate decides who gets in, and
// loopback alone for a LoopbackOnly server, so nobody off the machine can
// connect whatever the gate says.
func TestFindAvailablePortBindScope(t *testing.T) {
	cases := []struct {
		name         string
		loopbackOnly bool
		want         func(net.IP) bool
		wantDesc     string
	}{
		{"default binds every interface", false, net.IP.IsUnspecified, "unspecified"},
		{"loopback-only binds loopback", true, net.IP.IsLoopback, "loopback"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := &Server{addr: "localhost:0", loopbackOnly: c.loopbackOnly}
			ln, _, err := s.findAvailablePort()
			if err != nil {
				t.Fatalf("findAvailablePort: %v", err)
			}
			defer func() { _ = ln.Close() }()
			ip := ln.Addr().(*net.TCPAddr).IP
			if !c.want(ip) {
				t.Fatalf("bound %s, want a %s address", ip, c.wantDesc)
			}
		})
	}
}
