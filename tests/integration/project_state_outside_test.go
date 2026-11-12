//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"juggler/internal/ingress"
	"juggler/internal/projectpaths"
	"juggler/tests/helpers"
)

// TestProjectStateOutsideTheProject: with the project's state kept outside
// it, a session leaves the project tree with no .juggler at all, and what it
// stored there is what the next session on that project finds — the whole
// point of the setting is that the state still persists, just elsewhere.
func TestProjectStateOutsideTheProject(t *testing.T) {
	iso := newIsolatedRun(t)
	base := filepath.Join(iso.base, "state")
	env := helpers.EnvWithOverride(iso.env, projectpaths.StateDirEnv, base)
	token := ingress.NewSecret()
	env = helpers.EnvWithOverride(env, ingress.SecretEnv, ingress.NewSecret())
	env = helpers.EnvWithOverride(env, ingress.TokenEnv, token)
	project := newProjectDir(t)

	addr, stop := startStoppableChild(t, iso, env, project)
	call := func(addr, method, path, body string) []byte {
		t.Helper()
		req, err := http.NewRequest(method, "http://"+addr+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Juggler-Token", token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		data, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode >= 300 {
			t.Fatalf("%s %s: status %d: %s", method, path, resp.StatusCode, data)
		}
		return data
	}

	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(call(addr, http.MethodPost, "/api/conversations", `{"name":"kept outside"}`), &created); err != nil || created.ID == "" {
		t.Fatalf("create conversation: %v", err)
	}
	var state struct {
		StateDir string `json:"stateDir"`
		Outside  bool   `json:"outside"`
	}
	if err := json.Unmarshal(call(addr, http.MethodGet, "/api/project-state", ""), &state); err != nil {
		t.Fatal(err)
	}
	if !state.Outside || !strings.HasPrefix(state.StateDir, base) {
		t.Fatalf("project state = %+v, want it under %s", state, base)
	}
	stop()

	if _, err := os.Stat(filepath.Join(project, ".juggler")); err == nil {
		entries, _ := os.ReadDir(filepath.Join(project, ".juggler"))
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("the project has a .juggler holding %v; with state outside it must have none", names)
	}

	addr, _ = startStoppableChild(t, iso, env, project)
	var session struct {
		ConversationOrder []string `json:"conversationOrder"`
	}
	if err := json.Unmarshal(call(addr, http.MethodGet, "/api/session", ""), &session); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(session.ConversationOrder, created.ID) {
		t.Fatalf("after a restart the session lists %v, want it to still hold %s", session.ConversationOrder, created.ID)
	}
}

// startStoppableChild runs a session child for project under env and returns
// its address and a stop that shuts it down the way a supervisor does (SIGTERM,
// then waiting for it to exit), so a test can start another on the same
// project once its lock is free. The process is killed at the end of the test
// if it is still running.
func startStoppableChild(t *testing.T, iso isolatedRun, env []string, project string) (string, func()) {
	t.Helper()
	cmd := exec.Command(iso.binary, "--session-child", "--port", "0", "--project", project) //nolint:gosec // the suite's own binary
	cmd.Env = env
	helpers.SetProcGroupAttr(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stderrPath := filepath.Join(iso.base, "server-stderr.log")
	stderrFile, err := os.OpenFile(stderrPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = stderrFile
	if err := cmd.Start(); err != nil {
		_ = stderrFile.Close()
		t.Fatal(err)
	}
	_ = stderrFile.Close()
	addrCh := make(chan string, 1)
	exited := make(chan struct{})
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			if after, ok := strings.CutPrefix(sc.Text(), "JUGGLER_ADDR="); ok {
				select {
				case addrCh <- strings.TrimSpace(after):
				default:
				}
			}
		}
		_ = cmd.Wait()
		close(exited)
	}()
	stop := func() {
		helpers.SignalGroup(cmd, syscall.SIGTERM)
		<-exited
	}
	t.Cleanup(func() {
		helpers.SignalGroup(cmd, syscall.SIGKILL)
		<-exited
	})
	select {
	case addr := <-addrCh:
		return addr, stop
	case <-exited:
		b, _ := os.ReadFile(stderrPath)
		t.Fatalf("session child exited before printing its address:\n%s", b)
	case <-time.After(sessionOpenTimeout):
		t.Fatalf("session child did not print its address within %s", sessionOpenTimeout)
	}
	return "", stop
}
