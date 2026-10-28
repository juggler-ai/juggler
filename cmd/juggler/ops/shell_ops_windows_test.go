//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package ops

import (
	"context"
	"errors"
	"os/exec"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

// requirePOSIXShell skips a test whose commands are sh syntax when the host
// has no POSIX shell to run them in: neither Git for Windows nor WSL resolved.
func requirePOSIXShell(t *testing.T) {
	t.Helper()
	if winShell().shell == nil {
		t.Skip("no POSIX shell on this host (neither Git for Windows nor WSL)")
	}
}

// posixShellCommand runs script in the POSIX shell commands resolve to, for a
// test that needs a process to stand in for something else.
func posixShellCommand(t *testing.T, script string) *exec.Cmd {
	t.Helper()
	requirePOSIXShell(t)
	sh := winShell().shell
	return exec.Command(sh[0], append(slices.Clone(sh[1:]), script)...)
}

// requireGracefulStop skips a test of escalating from a polite stop to a
// force-kill. Windows has no polite stop to escalate from: a signal is not
// delivered, and cancelling a command terminates its whole job at once (see
// takeTreeOnCancel), so nothing is left to outlive a grace.
func requireGracefulStop(t *testing.T) {
	t.Helper()
	t.Skip("a Windows stop takes the command's whole job at once, so there is nothing to escalate")
}

// requirePython skips a test that runs Python when no interpreter resolved
// beside the shell.
func requirePython(t *testing.T) {
	t.Helper()
	if winShell().python == nil {
		t.Skip("no Python interpreter resolved on this host")
	}
}

// A WSL probe that times out once (a cold VM boot) must not leave the server
// without a shell: the next command after the retry interval probes again, and
// once a probe succeeds its answer is kept.
func TestToolchainCache_RetriesFailureThenKeepsSuccess(t *testing.T) {
	clock := time.Unix(0, 0)
	results := []bool{false, true, false}
	calls := 0
	c := newToolchainCache(func() (string, bool) {
		ok := results[calls]
		calls++
		if ok {
			return "wsl", true
		}
		return "none", false
	}, 10*time.Second)
	c.now = func() time.Time { return clock }

	if got := c.get(); got != "none" || calls != 1 {
		t.Fatalf("first get = %q after %d probes, want none after 1", got, calls)
	}
	clock = clock.Add(5 * time.Second)
	if got := c.get(); got != "none" || calls != 1 {
		t.Fatalf("get inside retry interval = %q after %d probes, want the cached failure without a probe", got, calls)
	}
	clock = clock.Add(6 * time.Second)
	if got := c.get(); got != "wsl" || calls != 2 {
		t.Fatalf("get after retry interval = %q after %d probes, want wsl after 2", got, calls)
	}
	clock = clock.Add(time.Hour)
	if got := c.get(); got != "wsl" || calls != 2 {
		t.Fatalf("get after success = %q after %d probes, want the kept success without a probe", got, calls)
	}
}

func utf16le(s string) []byte {
	var out []byte
	for _, u := range utf16.Encode([]rune(s)) {
		out = append(out, byte(u), byte(u>>8))
	}
	return out
}

func TestParseWSLDistroList(t *testing.T) {
	cases := []struct {
		name string
		out  []byte
		want []string
	}{
		{"utf-16 with BOM and CRLF", utf16le("\uFEFFUbuntu-22.04\r\ndocker-desktop\r\n"), []string{"Ubuntu-22.04", "docker-desktop"}},
		{"utf-8", []byte("Debian\n\n"), []string{"Debian"}},
		{"no distros", utf16le("Windows Subsystem for Linux has no installed distributions.\r\n"), nil},
		{"stub install hint", []byte("The Windows Subsystem for Linux is not installed. You can install by running 'wsl.exe --install'.\r\n"), nil},
		{"empty", nil, nil},
	}
	for _, tc := range cases {
		if got := parseWSLDistroList(tc.out); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: parseWSLDistroList = %q, want %q", tc.name, got, tc.want)
		}
	}
}

// A project variable set on wsl.exe reaches the Linux side only when WSLENV
// lists it, so each name but PATH is added there, to whatever list was already
// set. PATH is a Windows path list here; WSL builds its own Linux PATH, and
// shipping this one across would replace it. Git Bash reads the Windows
// environment directly and gets the environment untouched.
func TestShellEnv_RoutesProjectVarsIntoWSLOnly(t *testing.T) {
	overrides := map[string]string{"PATH": `C:\x`, "NEW": "x"}
	env := []string{"KEEP=1", "NEW=x", `PATH=C:\x`, "WSLENV=EXISTING/p"}

	got := shellEnv(exec.Command("wsl.exe", "-e", "sh", "-c", "true"), slices.Clone(env), overrides)
	slices.Sort(got)
	if want := []string{"KEEP=1", "NEW=x", `PATH=C:\x`, "WSLENV=EXISTING/p:NEW/u"}; !slices.Equal(got, want) {
		t.Fatalf("WSL env %v, want %v", got, want)
	}

	got = shellEnv(exec.Command("wsl.exe", "-e", "sh", "-c", "true"), []string{"A=1", "B=2"}, map[string]string{"B": "2"})
	slices.Sort(got)
	if want := []string{"A=1", "B=2", "WSLENV=B/u"}; !slices.Equal(got, want) {
		t.Fatalf("WSL env without WSLENV %v, want %v", got, want)
	}

	got = shellEnv(exec.Command(`C:\Git\bin\bash.exe`, "-c", "true"), slices.Clone(env), overrides)
	if !slices.Equal(got, env) {
		t.Fatalf("Git Bash env %v, want it untouched: %v", got, env)
	}
}

// TestWindowsShellResolvesAndRuns is the regression test for the
// WSL-not-installed failure: on a Windows host with any POSIX shell available
// (Git for Windows, or WSL with a distro), an approved command must actually
// run — not fail through the bare wsl.exe stub. GitHub-hosted windows runners
// ship Git for Windows, so this exercises Git Bash there.
func TestWindowsShellResolvesAndRuns(t *testing.T) {
	if winShell().shell == nil {
		t.Skip("no POSIX shell on this host (neither WSL nor Git for Windows)")
	}

	dir := t.TempDir()
	shellOps := NewShellOperations(NewPathScope(dir, nil))

	res, err := shellOps.Execute(context.Background(), "execute", map[string]any{
		"command": "echo hello",
	})
	if err != nil {
		t.Fatalf("execute echo failed: %v", err)
	}
	m := res.(map[string]any)
	if m["success"] != true {
		t.Fatalf("expected success=true, got %+v", m)
	}
	if out, _ := m["stdout"].(string); !strings.Contains(out, "hello") {
		t.Fatalf("expected stdout to contain %q, got %q", "hello", out)
	}
}

// Git for Windows is the shell whenever it is installed, even beside a working
// WSL: it runs the host's own toolchain against the project's own paths, where
// WSL would run a Linux one through a /mnt mount. Python follows the shell into
// the same world, so with Git Bash WSL is never even probed. WSL is the shell
// only where there is no Git for Windows.
func TestResolveWinPOSIX_PrefersGitBashOverWSL(t *testing.T) {
	const bash, py = `C:\Git\bin\bash.exe`, `C:\Python\python.exe`
	wslCalls := 0
	probes := func(gitBash, python string) winProbes {
		return winProbes{
			gitBash: func() string { return gitBash },
			python:  func() string { return python },
			wsl: func() wslProbe {
				wslCalls++
				return wslProbe{distros: []string{"Ubuntu"}, ready: true}
			},
		}
	}

	got, ok := resolveWinPOSIXWith(probes(bash, py))
	if !ok || len(got.shell) == 0 || got.shell[0] != bash || len(got.python) == 0 || got.python[0] != py || wslCalls != 0 {
		t.Fatalf("with Git and WSL: shell %q, python %q, ok %v after %d WSL probes; want Git Bash and native Python without probing WSL", got.shell, got.python, ok, wslCalls)
	}

	got, ok = resolveWinPOSIXWith(probes(bash, ""))
	if !ok || got.shell[0] != bash || got.python != nil || got.pythonErr == nil || !strings.Contains(got.pythonErr.Error(), "Python for Windows") || wslCalls != 0 {
		t.Fatalf("with Git, WSL and no native Python: shell %q, python %q, pythonErr %v after %d WSL probes; want Git Bash and an error naming Python for Windows", got.shell, got.python, got.pythonErr, wslCalls)
	}

	got, ok = resolveWinPOSIXWith(probes("", py))
	if !ok || !slices.Equal(got.shell, []string{"wsl.exe", "-e", "sh", "-c"}) || !slices.Equal(got.python, []string{"wsl.exe", "-e", "python3", "-"}) {
		t.Fatalf("with WSL and no Git: shell %q, python %q, ok %v; want WSL for both", got.shell, got.python, ok)
	}
}

// TestShellCmdFrom_NoShellSurfacesActionableError verifies that when no POSIX
// shell resolves, command-start fails with the resolver's actionable message
// rather than a cryptic wsl.exe error. Uses a synthetic winPOSIX so the branch
// is exercised regardless of what the host actually has installed.
func TestShellCmdFrom_NoShellSurfacesActionableError(t *testing.T) {
	want := errors.New("no POSIX shell available: install WSL or Git for Windows")
	cmd := shellCmdFrom(context.Background(), winPOSIX{shellErr: want}, "echo hello")
	if err := cmd.Start(); !errors.Is(err, want) {
		t.Fatalf("Start() error = %v, want %v", err, want)
	}
}

// A WSL that is installed but slow or failing must not be reported as missing:
// "install WSL" sends a user with a working WSL the wrong way.
func TestNoShellError_TellsSlowWSLFromAbsentWSL(t *testing.T) {
	cases := []struct {
		name string
		wsl  wslProbe
		want string
	}{
		{"absent", wslProbe{}, "install Git for Windows"},
		{"timed out", wslProbe{distros: []string{"Ubuntu"}, timedOut: true, err: errors.New("deadline")}, "not responding"},
		{"failing", wslProbe{distros: []string{"Ubuntu"}, err: errors.New("exit status 1")}, "cannot run a shell"},
	}
	for _, tc := range cases {
		if got := noShellError(tc.wsl).Error(); !strings.Contains(got, tc.want) {
			t.Errorf("%s: noShellError = %q, want it to contain %q", tc.name, got, tc.want)
		}
	}
}

func TestPythonCmdFrom_NoInterpreterSurfacesActionableError(t *testing.T) {
	want := errors.New("no Python interpreter available")
	cmd := pythonCmdFrom(context.Background(), winPOSIX{pythonErr: want})
	if err := cmd.Start(); !errors.Is(err, want) {
		t.Fatalf("Start() error = %v, want %v", err, want)
	}
}

func TestIsWindowsStoreStub(t *testing.T) {
	cases := map[string]bool{
		`C:\Users\me\AppData\Local\Microsoft\WindowsApps\python.exe`: true,
		`C:\Program Files\Python312\python.exe`:                      false,
		`C:\Windows\py.exe`:                                          false,
	}
	for path, want := range cases {
		if got := isWindowsStoreStub(path); got != want {
			t.Errorf("isWindowsStoreStub(%q) = %v, want %v", path, got, want)
		}
	}
}
