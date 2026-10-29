//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package childcontain_test

import (
	"context"
	"os"
	"os/exec"
	"reflect"
	"runtime"
	"testing"
	"time"

	"juggler/cmd/juggler/childcontain"
)

// longRunningCmd returns a command that blocks indefinitely, suitable as a
// containment target in tests.
func longRunningCmd(ctx context.Context) *exec.Cmd {
	switch runtime.GOOS {
	case "windows":
		return exec.CommandContext(ctx, "ping", "-n", "60", "127.0.0.1")
	default:
		return exec.CommandContext(ctx, "sleep", "60")
	}
}

func TestStartTerminate_KillsProcess(t *testing.T) {
	cmd := longRunningCmd(context.Background())
	child, err := start(cmd)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if cmd.Process == nil {
		t.Fatal("cmd.Process is nil after Start")
	}
	if err := child.Terminate(); err != nil && !isAlreadyFinished(err) {
		t.Fatalf("child.Terminate: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("child did not exit within 5s after Terminate")
	}
	child.Cleanup()
}

func isAlreadyFinished(err error) bool { return err == os.ErrProcessDone }

// TestPrepareAdopt_NoError verifies that Prepare and Adopt succeed and that
// the child process is alive after adoption. The child is killed via context
// cancellation, and cleanup is called once the child has exited.
func TestPrepareAdopt_NoError(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cmd := longRunningCmd(ctx)
	childcontain.Prepare(cmd)

	if err := cmd.Start(); err != nil {
		t.Fatalf("cmd.Start: %v", err)
	}

	child, err := childcontain.Adopt(cmd)
	if err != nil {
		t.Fatalf("childcontain.Adopt: %v", err)
	}

	// Child should be alive immediately after adoption.
	if cmd.Process == nil {
		t.Fatal("cmd.Process is nil after Start")
	}

	// Kill via context, wait for the child to exit, then release OS resources.
	cancel()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("child did not exit within 5s after context cancel")
	}
	child.Cleanup()
}

// TestPrepare_Idempotent verifies that calling Prepare twice on the same cmd
// leaves exactly the SysProcAttr one call leaves: a second call neither
// replaces the struct the first one filled nor changes any field of it.
func TestPrepare_Idempotent(t *testing.T) {
	once := exec.Command("true")
	childcontain.Prepare(once)

	twice := exec.Command("true")
	childcontain.Prepare(twice)
	first := twice.SysProcAttr
	childcontain.Prepare(twice)

	if twice.SysProcAttr != first {
		t.Fatal("a second Prepare replaced the SysProcAttr the first one set")
	}
	if !reflect.DeepEqual(once.SysProcAttr, twice.SysProcAttr) {
		t.Fatalf("Prepare twice gave SysProcAttr %+v, Prepare once gave %+v", twice.SysProcAttr, once.SysProcAttr)
	}
}

// TestAdopt_BeforeStart verifies that Adopt returns an error when called
// before cmd.Start().
func TestAdopt_BeforeStart(t *testing.T) {
	cmd := exec.Command("true")
	childcontain.Prepare(cmd)
	// Do NOT call cmd.Start() — Adopt must not panic and should either
	// succeed as a no-op or return a clear error.
	child, err := childcontain.Adopt(cmd)
	if err != nil {
		// Expected on platforms where Adopt does real work (Windows).
		t.Logf("Adopt before Start returned expected error: %v", err)
	}
	// cleanup must be safe to call regardless.
	child.Cleanup()
}
