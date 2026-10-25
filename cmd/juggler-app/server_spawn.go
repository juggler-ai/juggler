//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/binpath"
	"juggler/internal/logpaths"
	"juggler/internal/userpaths"
)

// serverStartTimeout bounds how long we wait for a freshly spawned server to
// print its bound address before giving up.
const serverStartTimeout = 20 * time.Second

// serverStopGrace bounds how long serverProc.stop waits, once it has asked a
// spawned server to shut down, before force-killing it.
//
// It must stay above the server's own shutdown budget, because that teardown is
// what writes conversation documents to disk — and a conversation with an LLM
// call in flight has nothing on disk for the whole turn, so a kill that lands
// first costs the user the entire exchange. A healthy server is gone in well
// under a second; this only bites when one is genuinely struggling, and both
// callers are off any path the user waits on.
const serverStopGrace = 15 * time.Second

// orphanDrainTimeout bounds how long we wait for an about-to-exit orphan server
// (its owning app died on a quick quit→relaunch) to release the project lock
// before we spawn a fresh one. Generous: the orphan's parent-watchdog polls
// twice a second and self-exits within ~500ms of the parent dying.
const orphanDrainTimeout = 3 * time.Second

// discoverOrSpawnServer returns an address to connect to for the given project,
// reusing an already-running server when one holds the project's instance lock
// and answers a health probe (so a second "open this project" attaches to the
// live server instead of starting a duplicate), else spawning a fresh headless
// server. The returned *serverProc is non-nil only when we spawned it (the
// caller owns stopping it); a reused server returns nil.
func discoverOrSpawnServer(project string) (string, *serverProc, error) {
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
	project = userpaths.ExpandHome(project)
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
		return env, nil
	}
	name := "juggler"
	if runtime.GOOS == "windows" {
		name = "juggler.exe"
	}
	if exe, err := os.Executable(); err == nil {
		if cand, ok := binpath.Sibling(exe, name); ok {
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
// The returned *serverProc is the live child; the caller is responsible for
// stopping it (serverProc.stop) when no window views it any more.
func spawnServer(project string) (string, *serverProc, error) {
	return spawnServerOn(project, "")
}

// spawnServerOn is spawnServer asking for a particular port, or the configured
// one when port is empty. The server moves past a port that is taken, so the
// address it reports is still the one to believe.
func spawnServerOn(project, port string) (string, *serverProc, error) {
	bin, err := serverBinPath()
	if err != nil {
		return "", nil, err
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
	if port != "" {
		args = append(args, "--port", port)
	}
	// bin comes from serverBinPath (JUGGLER_SERVER_BIN override, sibling binary,
	// or PATH lookup) and args are fixed flags plus a filesystem path passed as
	// separate argv elements — no shell is invoked and nothing here is
	// request-derived, so there is nothing to inject. Matches the //nolint:gosec
	// convention on the other operator-controlled exec.Command sites.
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	cmd := exec.Command(bin, args...) //nolint:gosec // operator-controlled bin+args, no shell
	// The server discards its console when launched without a terminal, so its
	// stderr carries only genuine panics / pre-jlog output. Capture that to this
	// project's per-server crash file (single writer — no interleave with other
	// projects' servers); fall back to our stderr if it can't open. The child
	// keeps its own fd after Start, so we close our copy below.
	stderrSink := openStderrSink(project)
	stderrFrom := int64(-1) // where this run's stderr starts in the shared file
	if stderrSink != nil {
		if fi, err := stderrSink.Stat(); err == nil {
			stderrFrom = fi.Size()
		}
		cmd.Stderr = stderrSink
		defer stderrSink.Close()
	} else {
		cmd.Stderr = os.Stderr
	}
	hideServerConsole(cmd) // Windows: no console window for the spawned server
	// A pipe of our own rather than StdoutPipe, because the server is waited on
	// for its whole life (serverProc) while this end is still being read, and
	// StdoutPipe's reader may not outlive a Wait.
	stdout, stdoutW, err := os.Pipe()
	if err != nil {
		return "", nil, fmt.Errorf("server stdout pipe: %w", err)
	}
	cmd.Stdout = stdoutW
	if err := cmd.Start(); err != nil {
		_ = stdout.Close()
		_ = stdoutW.Close()
		return "", nil, fmt.Errorf("start server: %w", err)
	}
	_ = stdoutW.Close() // the child holds its own copy
	proc := newServerProc(cmd, project)

	// Read stdout until it closes, which is when the server exits: after the
	// address, so the server never blocks on a full pipe; before it, so a server
	// that exits without one is reported at once rather than at the timeout.
	addrCh := make(chan string, 1)
	eof := make(chan struct{})
	go func() {
		defer close(eof)
		defer stdout.Close()
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

	timeout := time.After(serverStartTimeout)
	select {
	case addr := <-addrCh:
		proc.addr = addr
		return addr, proc, nil
	case <-eof:
		// The reader sends the address before it closes eof, so one that was
		// printed is already waiting here.
		select {
		case addr := <-addrCh:
			proc.addr = addr
			return addr, proc, nil
		default:
		}
		select {
		case <-proc.exited:
			if reason := startupFailureReason(logpaths.StderrLogPath(project), stderrFrom); reason != "" {
				return "", nil, fmt.Errorf("%s (the server exited: %s)", reason, proc.cmd.ProcessState)
			}
			return "", nil, fmt.Errorf("server exited (%s) before reporting its address", proc.cmd.ProcessState)
		case <-timeout:
		}
	case <-timeout:
	}
	_ = cmd.Process.Kill()
	return "", nil, fmt.Errorf("server did not report its address within %s", serverStartTimeout)
}

// maxStartupStderr bounds how much of a failed server's stderr is searched for
// its reason. The line comes at the very end of a short-lived run's output.
const maxStartupStderr = 64 << 10

// startupFailureReason is what a server that exited without starting said was
// wrong: the rest of its core.StartupFailurePrefix line in its stderr log, read
// from offset from, where its run began. The file is shared by every run of the
// project's server, so a reason before from belongs to another run. Empty when
// the server said nothing, or from is negative (the log could not be opened).
func startupFailureReason(path string, from int64) string {
	if from < 0 {
		return ""
	}
	f, err := os.Open(path) //nolint:gosec // our own log path, from logpaths
	if err != nil {
		return ""
	}
	defer f.Close()
	if _, err := f.Seek(from, io.SeekStart); err != nil {
		return ""
	}
	sc := bufio.NewScanner(io.LimitReader(f, maxStartupStderr))
	for sc.Scan() {
		if reason, ok := strings.CutPrefix(sc.Text(), core.StartupFailurePrefix); ok {
			return strings.TrimSpace(reason)
		}
	}
	return ""
}
