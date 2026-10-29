//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"juggler/cmd/juggler/childcontain"
	"juggler/internal/ingress"
	"juggler/internal/jlog"
	"juggler/internal/logpaths"
)

// childStartTimeout bounds how long a freshly spawned session child may take
// to print its bound address before the spawn is abandoned.
const childStartTimeout = 20 * time.Second

// childStopGrace is how long a child gets to exit after a graceful interrupt
// before its process tree is killed.
const childStopGrace = 3 * time.Second

// child is one live session-child process: today's per-project server, spawned
// with --session-child and contained via childcontain for tree-kill. That flag
// binds it to a loopback ephemeral port, so it is reachable only through the
// proxy.
type child struct {
	cmd       *exec.Cmd
	contained *childcontain.Child
	addr      string
	exited    chan struct{} // closed by the monitor goroutine when the process exits
	// exit is how the process ended (nil if it couldn't be reaped), and
	// waitErr why it couldn't. Both are written once, before exited closes,
	// and read only after.
	exit    *os.ProcessState
	waitErr error
	// ingressSecret is this child's alone, handed to it in its environment
	// (ingress.SecretEnv). The proxy sends it to vouch that a request came from
	// a caller off loopback (see handleSessionProxy).
	ingressSecret string
	// apiToken is the child's API token, minted here and handed to it in its
	// environment (ingress.TokenEnv): what its spawner sends to call its API.
	apiToken string
}

// newChildCommand builds the exec.Cmd for a session child. A package variable
// so tests can substitute a stub child process. bin comes from the supervisor's
// own executable path (or $JUGGLER_SERVER_BIN) and the args are fixed flags,
// the supervisor's own extra flags (Server.childExtraArgs), and a validated
// project path, passed as separate argv elements — no shell, nothing
// request-derived beyond the directory path the control API validated.
var newChildCommand = func(bin, project string, extra []string) *exec.Cmd {
	args := []string{"--session-child",
		"--port", "0",
		"--log-file", logpaths.ServerLogPath(project)}
	args = append(args, extra...)
	args = append(args, "--project", project)
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	return exec.Command(bin, args...) //nolint:gosec // operator-controlled bin+args, no shell
}

// launchIdentityEnv are the variables macOS gives a launched app to name its
// launch: its bundle identifier and its launchd job. Whoever started this
// process passes them on — the desktop app, or the terminal of a bare
// juggler. A session child runs AppKit (the engine WebView), and one carrying
// them checks in with LaunchServices as that app: opening the app then brings
// the child forward instead of launching it. A child is spawned without them.
var launchIdentityEnv = []string{"__CFBundleIdentifier", "XPC_SERVICE_NAME", "XPC_FLAGS"}

// isLaunchIdentity reports whether kv, a NAME=value environment entry, is one
// of launchIdentityEnv.
func isLaunchIdentity(kv string) bool {
	name, _, _ := strings.Cut(kv, "=")
	return slices.Contains(launchIdentityEnv, name)
}

// isSupervisorLink reports whether kv, a NAME=value environment entry, tells a
// child how to reach a machine server, or which session it is there. Only the
// server spawning the child may say that (childEnv); one its own environment
// carried is dropped.
func isSupervisorLink(kv string) bool {
	name, _, _ := strings.Cut(kv, "=")
	return name == ingress.SupervisorAddrEnv || name == ingress.SupervisorTokenEnv || name == ingress.SupervisorSessionEnv
}

// spawnChild starts a session child for project and waits for its ready
// handshake (a JUGGLER_ADDR=<host:port> line on stdout). The child keeps
// running after return; the caller owns stopping it via stop(). Once ctx is
// done nothing is started, and a child still in its handshake is killed and
// reaped before spawnChild returns ctx's error. env is added to the child's
// environment (Server.childEnv); nil adds nothing.
func spawnChild(ctx context.Context, bin, project string, extra, env []string) (*child, error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("session child for %s not started: %w", project, err)
	}
	cmd := newChildCommand(bin, project, extra)

	// A secret of this child's own, by which the proxy vouches for a caller off
	// loopback, and the API token the child serves, minted here so its spawner
	// holds it. Appended after the inherited environment, where exec gives the
	// last duplicate precedence, so values the spawner itself inherited never
	// stand in for them.
	secret, token := ingress.NewSecret(), ingress.NewSecret()
	if cmd.Env == nil {
		cmd.Env = os.Environ()
	}
	cmd.Env = slices.DeleteFunc(cmd.Env, func(kv string) bool { return isLaunchIdentity(kv) || isSupervisorLink(kv) })
	cmd.Env = append(cmd.Env, ingress.SecretEnv+"="+secret, ingress.TokenEnv+"="+token)
	cmd.Env = append(cmd.Env, env...)

	// The child's stderr carries only genuine panics / pre-logging output;
	// capture it to the project's crash sink (single writer per project). The
	// child keeps its own fd after Start, so our copy closes below.
	if sink := openStderrSink(project); sink != nil {
		cmd.Stderr = sink
		defer sink.Close()
	} else {
		cmd.Stderr = os.Stderr
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("session child stdout pipe: %w", err)
	}

	childcontain.Prepare(cmd)
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start session child: %w", err)
	}
	contained, err := childcontain.Adopt(cmd)
	if err != nil {
		jlog.Error("[machineserver] child containment incomplete for %s: %v", project, err)
	}

	c := &child{cmd: cmd, contained: contained, exited: make(chan struct{}), ingressSecret: secret, apiToken: token}

	// Monitor: reap the process and release containment resources exactly once,
	// whatever caused the exit. Everyone else observes c.exited.
	go func() {
		c.exit, c.waitErr = cmd.Process.Wait()
		c.contained.Cleanup()
		close(c.exited)
	}()

	// Scan stdout for the ready handshake, then keep draining so the child
	// never blocks on a full pipe. The scanner exits on EOF when the child does.
	addrCh := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			if addr, ok := strings.CutPrefix(sc.Text(), "JUGGLER_ADDR="); ok {
				select {
				case addrCh <- strings.TrimSpace(addr):
				default:
				}
			}
		}
	}()

	select {
	case addr := <-addrCh:
		c.addr = addr
		return c, nil
	case <-c.exited:
		return nil, fmt.Errorf("session child for %s exited before reporting its address (see %s)",
			project, logpaths.StderrLogPath(project))
	case <-ctx.Done():
		c.kill()
		return nil, fmt.Errorf("session child for %s cancelled before reporting its address: %w", project, ctx.Err())
	case <-time.After(childStartTimeout):
		c.kill()
		return nil, fmt.Errorf("session child for %s did not report its address within %s", project, childStartTimeout)
	}
}

// SessionChild is a session child spawned for a caller of its own rather than
// for this package's registry: `juggler run`'s, which serves that run alone
// and is stopped when it ends.
type SessionChild struct{ c *child }

// SpawnSessionChild starts a session child for project, from this binary as
// a machine server would, with extra flags after its own. It returns once the
// child has reported its address; the caller stops it with Stop. ctx ending
// before then kills the child and reports why.
func SpawnSessionChild(ctx context.Context, project string, extra ...string) (*SessionChild, error) {
	bin, err := childBinPath()
	if err != nil {
		return nil, err
	}
	c, err := spawnChild(ctx, bin, project, extra, nil)
	if err != nil {
		return nil, err
	}
	return &SessionChild{c: c}, nil
}

// Addr is the loopback host:port the child serves on.
func (s *SessionChild) Addr() string { return s.c.addr }

// Token is the API token minted for the child, sent to call its API.
func (s *SessionChild) Token() string { return s.c.apiToken }

// Exited closes when the child process has ended.
func (s *SessionChild) Exited() <-chan struct{} { return s.c.exited }

// Stop interrupts the child, gives it its grace to shut down, then kills its
// process tree, and returns once it has exited.
func (s *SessionChild) Stop() { s.c.stop() }

// kill tree-kills a child that never finished its handshake, and returns once
// it has been reaped (or, as stop does, shortly after the kill as a backstop).
func (c *child) kill() {
	_ = c.contained.Terminate()
	select {
	case <-c.exited:
	case <-time.After(childStopGrace):
		jlog.Error("[machineserver] session child pid %d did not exit after kill", c.cmd.Process.Pid)
	}
}

// stop tears the child down: graceful interrupt, a grace period, then a
// process-tree kill. It returns once the process has exited (or shortly after
// the kill was issued, as a backstop against an unreapable process). On
// Windows, where signalling another process is unsupported, it tree-kills
// immediately.
func (c *child) stop() {
	if c == nil || c.cmd == nil || c.cmd.Process == nil {
		return
	}
	if err := c.cmd.Process.Signal(os.Interrupt); err != nil {
		_ = c.contained.Terminate()
	} else {
		select {
		case <-c.exited:
			return
		case <-time.After(childStopGrace):
			_ = c.contained.Terminate()
		}
	}
	select {
	case <-c.exited:
	case <-time.After(childStopGrace):
		jlog.Error("[machineserver] session child pid %d did not exit after kill", c.cmd.Process.Pid)
	}
}

// exitedCleanly reports whether the exited process ended with status 0: a
// deliberate shutdown, not a crash. Call only after exited has closed.
func (c *child) exitedCleanly() bool {
	return c.exit != nil && c.exit.Success()
}

// exitReason describes how the exited process ended ("exit status 3",
// "signal: killed"). Call only after exited has closed.
func (c *child) exitReason() string {
	if c.exit == nil {
		return fmt.Sprintf("session child could not be reaped: %v", c.waitErr)
	}
	return "session child ended: " + c.exit.String()
}

// openStderrSink opens the per-project raw-stderr crash file for a session
// child (logpaths.StderrLogPath): one file per project means a single writer.
// Returns nil if it can't be opened; the caller falls back to our stderr.
func openStderrSink(project string) *os.File {
	p := logpaths.StderrLogPath(project)
	if os.MkdirAll(filepath.Dir(p), 0o755) != nil {
		return nil
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil
	}
	return f
}
