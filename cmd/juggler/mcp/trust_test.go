//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package mcp

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// writeProjectConfig writes servers to <project>/.juggler/mcp.json, as a cloned
// repository would carry it.
func writeProjectConfig(t *testing.T, project string, servers map[string]ServerConfig) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(project, ".juggler"), 0o755); err != nil {
		t.Fatal(err)
	}
	data, err := json.MarshalIndent(Config{Servers: servers}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, ".juggler", mcpFileName), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// statusOf returns one server's status from the manager.
func statusOf(m *Manager, name string) ServerStatus {
	for _, s := range m.ListServers() {
		if s.Name == name {
			return s
		}
	}
	return ServerStatus{}
}

// A repository can carry .juggler/mcp.json, and opening the project used to run
// every stdio command in it. The command must not run until the user trusts it.
func TestProjectStdioServerDoesNotRunUntilTrusted(t *testing.T) {
	writeGlobalConfig(t, map[string]ServerConfig{})
	project := t.TempDir()
	marker := filepath.Join(t.TempDir(), "ran")
	cfg := fakeServerConfig("serve")
	cfg.Env["MCP_FAKE_MARKER"] = marker
	writeProjectConfig(t, project, map[string]ServerConfig{"repo": cfg})

	m := NewManager()
	m.Start()
	m.Reconcile(project)

	// Give a start every chance to happen: the fake server is up in well under this.
	time.Sleep(1500 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatalf("the project's command ran without being trusted (status %+v)", statusOf(m, "repo"))
	}
	if got := statusOf(m, "repo").Status; got != "untrusted" {
		t.Fatalf("status %q, want untrusted", got)
	}
	// A tool call cannot start it either: it fails at once rather than parking.
	if _, err := m.CallTool(t.Context(), "repo", "echo", nil); err == nil {
		t.Fatal("a call to an untrusted server succeeded")
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a tool call ran the untrusted command")
	}

	// Trusted, it starts on the next reconcile.
	if err := trustProjectServer(project, "repo"); err != nil {
		t.Fatal(err)
	}
	m.Reconcile(project)
	if !waitFor(t, 15*time.Second, func() bool { return statusOf(m, "repo").Status == statusRunning }) {
		t.Fatalf("trusted server never ran: %+v", statusOf(m, "repo"))
	}
}

// Trust is for one command line. A repository that changes the command after
// it was trusted gets asked about again; the user's own global entries, and
// remote entries that run nothing here, are never gated.
func TestTrustIsPerCommand(t *testing.T) {
	writeGlobalConfig(t, map[string]ServerConfig{"mine": {Command: "my-tool"}})
	project := t.TempDir()
	writeProjectConfig(t, project, map[string]ServerConfig{
		"tool":   {Command: "node", Args: []string{"server.js"}},
		"remote": {Transport: "http", URL: "https://example.com/mcp"},
	})
	if err := trustProjectServer(project, "tool"); err != nil {
		t.Fatal(err)
	}
	merged, err := loadMergedConfig(project)
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]bool{"mine": false, "tool": false, "remote": false} {
		if merged[name].untrusted != want {
			t.Errorf("%s untrusted = %v, want %v", name, merged[name].untrusted, want)
		}
	}

	writeProjectConfig(t, project, map[string]ServerConfig{
		"tool": {Command: "node", Args: []string{"server.js", "--evil"}},
	})
	merged, err = loadMergedConfig(project)
	if err != nil {
		t.Fatal(err)
	}
	if !merged["tool"].untrusted {
		t.Error("a changed command kept the trust given to the old one")
	}

	// The settings UI saves the whole map; only the entry the user changed is
	// trusted by that save.
	prev := map[string]ServerConfig{"tool": {Command: "node", Args: []string{"server.js", "--evil"}}}
	next := map[string]ServerConfig{
		"tool":  prev["tool"],
		"typed": {Command: "uvx", Args: []string{"thing"}},
	}
	if err := trustAuthored(project, prev, next); err != nil {
		t.Fatal(err)
	}
	writeProjectConfig(t, project, next)
	merged, err = loadMergedConfig(project)
	if err != nil {
		t.Fatal(err)
	}
	if merged["typed"].untrusted {
		t.Error("an entry the user wrote was not trusted")
	}
	if !merged["tool"].untrusted {
		t.Error("saving beside an untrusted entry trusted it")
	}
	info, err := os.Stat(trustPath())
	if err != nil {
		t.Fatalf("trust store: %v", err)
	}
	// Windows has no permission bits to carry "owner only" (os.Stat reports
	// 0666 for every writable file); the profile directory's ACL guards it.
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Errorf("trust store mode %o, want 600", info.Mode().Perm())
	}
}

// An edit to a trusted project server's env is a command the user has not
// trusted, so the running process stops and waits for trust instead of carrying
// on as the old command.
func TestEditedProjectServerStopsUntilTrusted(t *testing.T) {
	writeGlobalConfig(t, map[string]ServerConfig{})
	project := t.TempDir()
	writeProjectConfig(t, project, map[string]ServerConfig{"repo": fakeServerConfig("serve")})
	if err := trustProjectServer(project, "repo"); err != nil {
		t.Fatal(err)
	}

	m := NewManager()
	m.Start()
	m.Reconcile(project)
	if !waitFor(t, 15*time.Second, func() bool { return statusOf(m, "repo").Status == statusRunning }) {
		t.Fatalf("trusted server never ran: %+v", statusOf(m, "repo"))
	}

	edited := fakeServerConfig("serve")
	edited.Env["EXTRA"] = "1"
	writeProjectConfig(t, project, map[string]ServerConfig{"repo": edited})
	m.Reconcile(project)
	if got := statusOf(m, "repo"); got.Status != statusUntrusted {
		t.Fatalf("an edited project server kept running as %+v, want untrusted", got)
	}
}

// mcp.json can hold bearer tokens in headers and secrets in env.
func TestConfigFileIsPrivate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no permission bits; the profile directory's ACL guards the file")
	}
	path := filepath.Join(t.TempDir(), "sub", mcpFileName)
	if err := writeConfigFile(path, map[string]ServerConfig{"x": {Command: "y"}}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("mcp.json written %o, want 600", perm)
	}
}
