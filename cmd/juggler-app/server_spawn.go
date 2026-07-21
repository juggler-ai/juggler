//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/logpaths"
)

// serverStartTimeout bounds how long we wait for a freshly spawned server to
// print its bound address before giving up.
const serverStartTimeout = 20 * time.Second

// orphanDrainTimeout bounds how long we wait for an about-to-exit orphan server
// (its owning app died on a quick quit→relaunch) to release the project lock
// before we spawn a fresh one. Generous: the orphan's parent-watchdog polls
// twice a second and self-exits within ~500ms of the parent dying.
const orphanDrainTimeout = 3 * time.Second

// discoverOrSpawnServer returns an address to connect to for the given project,
// reusing an already-running server when one holds the project's instance lock
// and answers a health probe (so a second "open this project" attaches to the
// live server instead of starting a duplicate), else spawning a fresh headless
// server. The returned *exec.Cmd is non-nil only when we spawned it (the caller
// owns stopping it); a reused server returns nil.
func discoverOrSpawnServer(project string) (string, *exec.Cmd, error) {
	if abs := expandProject(project); abs != "" {
		if locked, info, _ := core.CheckProjectLocked(abs); locked {
			switch core.ClassifyRunningInstance(info, abs) {
			case core.InstanceReusable:
				logf("reusing running server for %s at %s:%d", abs, info.Host, info.Port)
				return net.JoinHostPort(info.Host, strconv.Itoa(info.Port)), nil, nil
			case core.InstanceExiting:
				// The server holding this project's lock is an orphan about to
				// self-terminate (its owning app quit on a quick quit→relaunch).
				// Attaching a window would leave it stuck on "connecting" the moment
				// the server exits, so wait for it to release the lock and then spawn
				// a fresh server we own. If it somehow outlives the grace period,
				// surface it as locked rather than spawn into a collision.
				logf("server for %s is an exiting orphan; waiting for it to release the lock", abs)
				if !core.WaitForShutdown(info, orphanDrainTimeout) {
					logf("orphan server for %s still present after %s; treating as locked", abs, orphanDrainTimeout)
					return "", nil, newLockedProjectError(abs, info)
				}
				// Lock released — fall through to spawn below.
			default: // core.InstanceUnreachable
				return "", nil, newLockedProjectError(abs, info)
			}
		}
	}
	logf("spawning new server for project=%q", project)
	return spawnServer(project)
}

// expandProject resolves project to an absolute path (expanding a leading ~),
// or "" when project is empty.
func expandProject(project string) string {
	if project == "" {
		return ""
	}
	if project == "~" || strings.HasPrefix(project, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			project = filepath.Join(home, strings.TrimPrefix(project, "~"))
		}
	}
	if abs, err := filepath.Abs(project); err == nil {
		return abs
	}
	return project
}

// serverBinPath locates the juggler server binary the app should spawn:
//   - $JUGGLER_SERVER_BIN if set (explicit override, used in dev/tests),
//   - a sibling "juggler" next to this executable (the bundled layout),
//   - else "juggler" on PATH.
func serverBinPath() (string, error) {
	if env := os.Getenv("JUGGLER_SERVER_BIN"); env != "" {
		if st, err := os.Stat(env); err != nil || st.IsDir() {
			return "", fmt.Errorf("JUGGLER_SERVER_BIN=%q: not a regular file", env)
		}
		return env, nil
	}
	name := "juggler"
	if runtime.GOOS == "windows" {
		name = "juggler.exe"
	}
	if exe, err := os.Executable(); err == nil {
		cand := filepath.Join(filepath.Dir(exe), name)
		if st, statErr := os.Stat(cand); statErr == nil && !st.IsDir() {
			return cand, nil
		}
	}
	if p, err := exec.LookPath(name); err == nil {
		return p, nil
	}
	return "", fmt.Errorf("could not locate the juggler server binary; set JUGGLER_SERVER_BIN")
}

// spawnServer launches a headless juggler server as a child process for the
// given project and returns the address it bound to. The server is started in
// headless mode (--window=false) so it serves + runs its hidden engine but
// shows no window — this process owns the window. We learn the actual address
// from the JUGGLER_ADDR= line the server prints on startup (it may differ from
// the configured port when findAvailablePort had to move past a busy one).
//
// The returned *exec.Cmd is the live child; the caller is responsible for
// stopping it (stopServer) when no window views it any more.
func spawnServer(project string) (string, *exec.Cmd, error) {
	bin, err := serverBinPath()
	if err != nil {
		return "", nil, err
	}
	// Resolve to an absolute path so exec.Command receives a fully qualified,
	// verified binary path rather than a bare name subject to PATH manipulation.
	if resolved, lookErr := exec.LookPath(bin); lookErr == nil {
		bin = resolved
	}

	// --exit-with-parent ties the server's lifetime to ours: if this app quits
	// or crashes, the server self-terminates instead of lingering as an orphan.
	// --log-file pins the server's structured log to this project's central file
	// (<slug>.log in the platform log dir), so one server → one file with no
	// cross-project interleave.
	args := []string{"--window=false", "--exit-with-parent",
		"--log-file", logpaths.ServerLogPath(project)}
	if project != "" {
		args = append(args, "--project", project)
	}
	cmd := exec.Command(bin, args...) // #nosec G204 -- bin is resolved via serverBinPath which validates file existence
	// The server discards its console when launched without a terminal, so its
	// stderr carries only genuine panics / pre-jlog output. Capture that to this
	// project's per-server crash file (single writer — no interleave with other
	// projects' servers); fall back to our stderr if it can't open. The child
	// keeps its own fd after Start, so we close our copy below.
	stderrSink := openStderrSink(project)
	if stderrSink != nil {
		cmd.Stderr = stderrSink
		defer stderrSink.Close()
	} else {
		cmd.Stderr = os.Stderr
	}
	hideServerConsole(cmd) // Windows: no console window for the spawned server
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", nil, fmt.Errorf("server stdout pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return "", nil, fmt.Errorf("start server: %w", err)
	}

	addrCh := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			line := sc.Text()
			if addr, ok := strings.CutPrefix(line, "JUGGLER_ADDR="); ok {
				select {
				case addrCh <- strings.TrimSpace(addr):
				default:
				}
			}
		}
	}()

	select {
	case addr := <-addrCh:
		return addr, cmd, nil
	case <-time.After(serverStartTimeout):
		_ = cmd.Process.Kill()
		return "", nil, fmt.Errorf("server did not report its address within %s", serverStartTimeout)
	}
}

// stopServer asks a spawned server to exit (the clean-close path: a window
// closed, or the app is quitting). It tries a graceful interrupt first, then
// force-kills after a short grace period. On Windows, where Signal(os.Interrupt)
// to another process is unsupported and returns an error, it force-kills
// immediately rather than waiting out a grace period for a signal that was never
// delivered. The crash/hard-kill path is covered separately by the server's own
// --exit-with-parent watchdog (waitParentExit), not by this function.
func stopServer(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	if err := cmd.Process.Signal(os.Interrupt); err != nil {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
		return
	}
	done := make(chan struct{})
	go func() { _, _ = cmd.Process.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		_ = cmd.Process.Kill()
	}
}
