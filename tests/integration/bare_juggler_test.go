//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"bufio"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"juggler/tests/helpers"
)

// bareRun is one bare `juggler` process run by a test, under an isolated
// environment. Its stdout is read line by line as it arrives.
type bareRun struct {
	t      *testing.T
	cmd    *exec.Cmd
	lines  chan string   // stdout, a line at a time; closed at EOF
	seen   []string      // every line read so far
	exited chan struct{} // closed once the process has been reaped
	code   int           // its exit code, once exited
	stderr string        // path of the captured stderr
}

// startBare runs the suite's binary with args and no subcommand — bare
// juggler — under iso. A run still going when the test ends is killed, with
// its process group.
func startBare(t *testing.T, iso isolatedRun, name string, args ...string) *bareRun {
	t.Helper()
	cmd := exec.Command(iso.binary, args...) //nolint:gosec // the suite's own binary
	cmd.Env = iso.env
	helpers.SetProcGroupAttr(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	r := &bareRun{t: t, cmd: cmd, lines: make(chan string, 256), exited: make(chan struct{}),
		stderr: filepath.Join(iso.base, name+"-stderr.log")}
	stderrFile, err := os.Create(r.stderr)
	if err != nil {
		t.Fatalf("stderr file: %v", err)
	}
	cmd.Stderr = stderrFile
	if err := cmd.Start(); err != nil {
		_ = stderrFile.Close()
		t.Fatalf("start bare juggler: %v", err)
	}
	_ = stderrFile.Close()
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			r.lines <- sc.Text()
		}
		close(r.lines)
		err := cmd.Wait()
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			r.code = exitErr.ExitCode()
		}
		close(r.exited)
	}()
	t.Cleanup(func() {
		select {
		case <-r.exited:
		default:
			helpers.SignalGroup(cmd, syscall.SIGKILL)
			<-r.exited
		}
	})
	return r
}

// waitLine returns the rest of the first stdout line that starts with prefix,
// failing if the run ends its output first. The wait follows the run's
// progress; sessionOpenTimeout bounds only a run that hangs.
func (r *bareRun) waitLine(prefix string) string {
	r.t.Helper()
	deadline := time.After(sessionOpenTimeout)
	for {
		select {
		case line, ok := <-r.lines:
			if !ok {
				r.t.Fatalf("bare juggler ended its output without a line starting %q; stdout %q, stderr:\n%s", prefix, r.seen, r.stderrText())
			}
			r.seen = append(r.seen, line)
			if rest, found := strings.CutPrefix(line, prefix); found {
				return rest
			}
		case <-deadline:
			r.t.Fatalf("bare juggler printed no line starting %q within %s; stdout %q", prefix, sessionOpenTimeout, r.seen)
		}
	}
}

// interrupt sends the run a Ctrl-C, and returns its exit code and the rest of
// its output once it has exited.
func (r *bareRun) interrupt() (int, string) {
	r.t.Helper()
	if err := r.cmd.Process.Signal(os.Interrupt); err != nil {
		r.t.Fatalf("interrupt: %v", err)
	}
	select {
	case <-r.exited:
	case <-time.After(machineServerStopTimeout):
		r.t.Fatalf("bare juggler did not exit within %s of Ctrl-C; stdout %q, stderr:\n%s", machineServerStopTimeout, r.seen, r.stderrText())
	}
	for line := range r.lines {
		r.seen = append(r.seen, line)
	}
	return r.code, strings.Join(r.seen, "\n")
}

func (r *bareRun) stderrText() string {
	b, _ := os.ReadFile(r.stderr)
	return string(b)
}

// TestBareJugglerServesThenAttaches runs the real bare juggler twice in one
// project. The first finds no server, so it is the server, marked implicit,
// and prints a session URL that serves. The second finds it, attaches, and
// prints the same URL. The second's Ctrl-C leaves that session, which it did
// not open; the first's stops the server, which lets server.json go and takes
// the session's child with it.
func TestBareJugglerServesThenAttaches(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Ctrl-C is a console event on Windows, which a test cannot send to one child")
	}
	iso := newIsolatedRun(t)
	ms := &machineServer{t: t, Home: iso.home, ConfigDir: configDirUnder(iso.home), Logs: iso.logs, iso: iso, children: map[int]string{}}
	project := newProjectDir(t)

	first := startBare(t, iso, "first", "--project", project)
	first.waitLine("Started the Juggler server at ")
	url := first.waitLine("Session for " + project + ": ")
	info := ms.readServerInfo()
	ms.Addr, ms.Token = info.Addr, info.Token
	if !info.Implicit {
		t.Errorf("server.json %+v: want bare juggler's server marked implicit", info)
	}
	list := ms.mustListSessions()
	if len(list) != 1 || list[0].Project != project || url != "http://"+ms.Addr+"/s/"+list[0].ID+"/" {
		t.Fatalf("sessions %+v, printed URL %s: want one for %s at that URL", list, url, project)
	}
	ms.noteChild(list[0])
	resp, err := ms.do(http.MethodGet, "/s/"+list[0].ID+"/", nil)
	if err != nil {
		t.Fatalf("GET the session's page: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET the session's page: %d, want 200", resp.StatusCode)
	}

	second := startBare(t, iso, "second", "--project", project)
	second.waitLine("Using the Juggler server at http://" + ms.Addr + "/")
	if got := second.waitLine("Session for " + project + ": "); got != url {
		t.Fatalf("second bare juggler printed %s, want the first's session %s", got, url)
	}
	if code, out := second.interrupt(); code != 0 || !strings.Contains(out, "Left the session for "+project+" running.") {
		t.Fatalf("Ctrl-C on the second: exit %d, stdout %q; want 0, leaving the session", code, out)
	}
	if list := ms.mustListSessions(); len(list) != 1 || list[0].Project != project {
		t.Fatalf("sessions after the second's Ctrl-C = %+v, want the first's still open", list)
	}

	code, out := first.interrupt()
	if code != 0 || !strings.Contains(out, "Stopping the Juggler server.") {
		t.Fatalf("Ctrl-C on the first: exit %d, stdout %q, stderr:\n%s", code, out, first.stderrText())
	}
	if _, err := os.Stat(filepath.Join(ms.ConfigDir, "server.json")); !os.IsNotExist(err) {
		t.Errorf("server.json after the server's Ctrl-C: %v, want it gone", err)
	}
	for pid, addr := range ms.children {
		if dialable(addr) {
			t.Errorf("session child pid %d at %s is still serving after its server stopped", pid, addr)
		}
	}
}
