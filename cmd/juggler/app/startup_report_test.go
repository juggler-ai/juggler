//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
)

// TestStartupFailureExplainsAHeldLock covers the terminal half of the leaked
// lockfile. Without the report the failure reaches a person as a banner,
// silence and an exit code, which reads exactly like a session that ran and
// ended — so the one failure they could fix themselves would say least.
func TestStartupFailureExplainsAHeldLock(t *testing.T) {
	var out bytes.Buffer
	reportStartupFailure(&out, fmt.Errorf("instance lock: %w", &core.ProjectLockedError{
		Project: "/tmp/project",
		Info:    &core.InstanceInfo{PID: 42},
	}))

	for _, want := range []string{
		"Couldn't start Juggler",
		"still locked",
		"juggler.lock",
		"delete that file",
		"42",
	} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("startup failure report missing %q:\n%s", want, out.String())
		}
	}
}

// TestStartupFailureKeepsTheUnderlyingError guards the rule that a friendly
// lead never replaces the real text: whatever actually broke has to survive
// into the output, even when we have nothing helpful to add about it.
func TestStartupFailureKeepsTheUnderlyingError(t *testing.T) {
	var out bytes.Buffer
	reportStartupFailure(&out, errors.New("listen tcp 127.0.0.1:8080: address already in use"))

	if !strings.Contains(out.String(), "address already in use") {
		t.Fatalf("underlying error text was dropped:\n%s", out.String())
	}
}
