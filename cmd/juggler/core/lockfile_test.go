//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"testing"
)

// TestReleaseOfARefusedLockLeavesTheHoldersInfo: a launch refused a project's
// lock still runs its cleanup, which releases its InstanceLock. That lock was
// never held, so the release must leave alone the instance.json the live
// holder wrote — its PID for the advice the next refused launch prints, and
// the address a `juggler run` caller finds its server by.
func TestReleaseOfARefusedLockLeavesTheHoldersInfo(t *testing.T) {
	dir := t.TempDir()
	holder := NewInstanceLock(dir)
	if res, err := holder.TryAcquire(); err != nil || !res.Acquired {
		t.Fatalf("holder could not take the lock: acquired=%v err=%v", res.Acquired, err)
	}
	t.Cleanup(func() { _ = holder.Release() })

	contender := NewInstanceLock(dir)
	res, err := contender.TryAcquire()
	if err != nil || res.Acquired {
		t.Fatalf("contender: acquired=%v err=%v, want a refusal", res.Acquired, err)
	}
	if err := contender.Release(); err != nil {
		t.Fatalf("releasing a refused lock: %v", err)
	}

	locked, info, err := CheckProjectLocked(dir)
	if err != nil || !locked {
		t.Fatalf("after the refused contender let go, CheckProjectLocked = locked %v, err %v; the holder still holds it", locked, err)
	}
	if info == nil || info.PID != os.Getpid() {
		t.Fatalf("after the refused contender let go, the holder's instance info reads %+v; the contender removed the holder's instance.json", info)
	}
}
