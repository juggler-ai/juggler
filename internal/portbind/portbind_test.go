//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package portbind

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
	first, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer func() { _ = first.Close() }()
	second, err := net.Listen("tcp", first.Addr().String())
	if err == nil {
		_ = second.Close()
		t.Fatalf("a second listener on %s was allowed; there is no collision to test", first.Addr())
	}
	return err
}

// TestUnavailableRecognisesACollision pins that a port another socket holds
// is recognised as busy on every platform, and that an unrelated failure is not.
func TestUnavailableRecognisesACollision(t *testing.T) {
	if err := realCollision(t); !unavailable(err) {
		t.Fatalf("unavailable(%v) = false, want true", err)
	}
	if err := errors.New("listen tcp: something else entirely"); unavailable(err) {
		t.Fatalf("unavailable(%v) = true, want false", err)
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

// TestFirstFreeSkipsBusyPorts: when earlier servers hold the starting port and
// the ones after it, the next server steps past all of them, not giving up at
// the second busy one.
func TestFirstFreeSkipsBusyPorts(t *testing.T) {
	f := &fakeListen{err: realCollision(t), freeFrom: 3942}
	ln, err := FirstFree("", 3939, f.listen)
	if err != nil {
		t.Fatalf("FirstFree: %v (tried %v)", err, f.asked)
	}
	_ = ln.Close()
	if want := []int{3939, 3940, 3941, 3942}; !slices.Equal(f.asked, want) {
		t.Fatalf("tried ports %v, want %v", f.asked, want)
	}
}

// TestFirstFreeStopsOnOtherErrors pins that a failure other than a busy port is
// reported as it is, at the starting port, rather than taken as a reason to
// look elsewhere.
func TestFirstFreeStopsOnOtherErrors(t *testing.T) {
	boom := errors.New("listen tcp: something else entirely")
	f := &fakeListen{err: boom, freeFrom: 1 << 16}
	if _, err := FirstFree("", 3939, f.listen); !errors.Is(err, boom) {
		t.Fatalf("FirstFree error = %v, want %v", err, boom)
	}
	if want := []int{3939}; !slices.Equal(f.asked, want) {
		t.Fatalf("tried ports %v, want %v", f.asked, want)
	}
}

// TestFirstFreeGivesUpAfterTheRange pins the bound on the search.
func TestFirstFreeGivesUpAfterTheRange(t *testing.T) {
	f := &fakeListen{err: realCollision(t), freeFrom: 1 << 16}
	if _, err := FirstFree("", 3939, f.listen); err == nil {
		t.Fatal("FirstFree succeeded with every port busy")
	}
	if got, want := len(f.asked), MaxSearch+1; got != want {
		t.Fatalf("tried %d ports, want %d", got, want)
	}
}
