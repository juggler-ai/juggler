//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/worker"
	"juggler/cmd/juggler/workspace"
)

// newWorkspaceTurnServer is a server with a real SessionManager (so workspaces
// can be registered) and a live conversation cache, ready to run one turn.
func newWorkspaceTurnServer(t *testing.T) *Server {
	t.Helper()
	s := &Server{wsFleet: wsFleet{hub: newClientHub()}}
	mgr, err := core.NewSessionManagerForPath(t.TempDir())
	if err != nil {
		t.Fatalf("NewSessionManagerForPath: %v", err)
	}
	t.Cleanup(mgr.Shutdown)
	s.projectState.Store(&projectState{
		projectPath:    mgr.GetProjectPath(),
		sessionManager: mgr,
		viewers:        newViewerGroup(),
	})
	s.providersReady = make(chan struct{})
	s.shutdownChan = make(chan struct{})
	s.conversationCache = newConversationCache(s.ProjectPath)
	t.Cleanup(s.conversationCache.Shutdown)
	return s
}

// registerTurnProvider registers a provider that records the Config it was
// initialized with, and enables it. Returns the channel of captured configs.
func registerTurnProvider(t *testing.T, s *Server, name, model string) chan provider.Config {
	t.Helper()
	configs := make(chan provider.Config, 4)
	var opened []*capabilityCacheConversation
	provider.RegisterProvider(provider.ProviderInfo{
		Name:     name,
		AuthType: provider.AuthTypeToggle,
	}, func(cfg provider.Config) (provider.Provider, error) {
		configs <- cfg
		return &capabilityCacheProvider{opened: &opened}, nil
	})
	credentials, err := core.NewCredentialsStore()
	if err != nil {
		t.Fatal(err)
	}
	if err := credentials.SetProviderEnabled(name, true); err != nil {
		t.Fatal(err)
	}
	providers := []ProviderStatus{{Name: name, ModelsWithContext: []ModelWithContext{{
		ID: model, ContextWindow: 100000, MaxOutputTokens: 1000,
	}}}}
	s.providersList.Store(&providers)
	s.markProvidersReady()
	return configs
}

func turnRequest(t *testing.T, convID, providerName, model, workspaceID string) json.RawMessage {
	t.Helper()
	req := map[string]any{
		"conversationId": convID,
		"modelConfig":    map[string]string{"provider": providerName, "model": model},
	}
	if workspaceID != "" {
		req["workspaceId"] = workspaceID
	}
	data, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// A conversation bound to a workspace runs its turn there: the workspace root
// reaches the provider, which is what roots a spawned CLI in the worktree the
// conversation is about. The project travels with it and is unchanged, since
// that is still where the provider's own per-conversation state belongs.
func TestLLMCallerSpawnsInTheBoundWorkspace(t *testing.T) {
	t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
	const providerName = "test_workspace_spawn"
	s := newWorkspaceTurnServer(t)
	configs := registerTurnProvider(t, s, providerName, "model")

	workspaceRoot := t.TempDir()
	ws, err := s.SessionManager().RegisterWorkspace(core.Workspace{
		Kind:  core.WorkspaceKindLocal,
		Root:  workspaceRoot,
		Label: "feat/tunnels",
		State: core.WorkspaceStateReady,
	})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}

	if _, err := s.createLLMCaller()(context.Background(),
		turnRequest(t, "conv", providerName, "model", ws.ID),
		func(worker.StreamChunk) {}); err != nil {
		t.Fatalf("LLM call failed: %v", err)
	}

	select {
	case cfg := <-configs:
		if cfg.WorkspaceRoot != workspaceRoot {
			t.Errorf("provider WorkspaceRoot = %q, want the bound workspace %q", cfg.WorkspaceRoot, workspaceRoot)
		}
		if cfg.ProjectPath != s.ProjectPath() {
			t.Errorf("provider ProjectPath = %q, want the project %q", cfg.ProjectPath, s.ProjectPath())
		}
	case <-time.After(time.Second):
		t.Fatal("provider was never initialized")
	}
}

// An unbound conversation carries no workspace at all, and the provider sees
// exactly what it saw before workspaces existed.
func TestLLMCallerUnboundConversationRunsInTheProject(t *testing.T) {
	t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
	const providerName = "test_workspace_unbound"
	s := newWorkspaceTurnServer(t)
	configs := registerTurnProvider(t, s, providerName, "model")

	if _, err := s.createLLMCaller()(context.Background(),
		turnRequest(t, "conv", providerName, "model", ""),
		func(worker.StreamChunk) {}); err != nil {
		t.Fatalf("LLM call failed: %v", err)
	}

	select {
	case cfg := <-configs:
		if cfg.WorkspaceRoot != "" {
			t.Errorf("provider WorkspaceRoot = %q, want empty for an unbound conversation", cfg.WorkspaceRoot)
		}
	case <-time.After(time.Second):
		t.Fatal("provider was never initialized")
	}
}

// Every binding that cannot be honoured fails the turn, and says which. The
// alternative — quietly running in the project — would edit the wrong tree and
// look exactly like working.
func TestLLMCallerRefusesUnusableWorkspace(t *testing.T) {
	t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
	const providerName = "test_workspace_refusal"
	s := newWorkspaceTurnServer(t)
	configs := registerTurnProvider(t, s, providerName, "model")

	provisioning, err := s.SessionManager().RegisterWorkspace(core.Workspace{
		Kind: core.WorkspaceKindLocal, Root: t.TempDir(), Label: "half-built",
		State: core.WorkspaceStateProvisioning,
	})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}
	closed, err := s.SessionManager().RegisterWorkspace(core.Workspace{
		Kind: core.WorkspaceKindLocal, Root: t.TempDir(), Label: "finished-with",
		State: core.WorkspaceStateClosed,
	})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}
	goneRoot := t.TempDir()
	gone, err := s.SessionManager().RegisterWorkspace(core.Workspace{
		Kind: core.WorkspaceKindLocal, Root: goneRoot, Label: "removed-behind-our-back",
		State: core.WorkspaceStateReady,
	})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}
	if err := os.RemoveAll(goneRoot); err != nil {
		t.Fatalf("remove workspace root: %v", err)
	}

	for _, tc := range []struct {
		name        string
		workspaceID string
		want        string
	}{
		{"provisioning", provisioning.ID, "half-built is still being created"},
		{"closed", closed.ID, "finished-with was closed"},
		{"root gone", gone.ID, "removed-behind-our-back is missing its root"},
		{"unknown", "ws_nosuchid", "unknown workspace: ws_nosuchid"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := s.createLLMCaller()(context.Background(),
				turnRequest(t, "conv-"+tc.name, providerName, "model", tc.workspaceID),
				func(worker.StreamChunk) {})
			if err == nil {
				t.Fatal("turn ran; want a refusal naming the workspace")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %q, want it to contain %q", err, tc.want)
			}
		})
	}

	select {
	case cfg := <-configs:
		t.Fatalf("a provider was initialized for a refused turn: %+v", cfg)
	default:
	}
}

// Where a turn's provider is rooted is the workspace's LocalDir — and a
// workspace with none cannot host a provider Juggler spawns as a subprocess:
// that CLI would run on this machine while every operation of the turn ran
// somewhere else, so the turn is refused rather than spawned in the project. A
// provider that is reached over HTTP runs the same from anywhere and is not
// asked to care.
func TestTurnDirIsTheWorkspacesLocalDir(t *testing.T) {
	const spawning, remote = "test_turn_dir_cli", "test_turn_dir_http"
	provider.RegisterProvider(provider.ProviderInfo{Name: spawning, DisplayName: "Some CLI", SpawnsLocalProcess: true},
		func(provider.Config) (provider.Provider, error) { return nil, nil })
	provider.RegisterProvider(provider.ProviderInfo{Name: remote, DisplayName: "Some API"},
		func(provider.Config) (provider.Provider, error) { return nil, nil })

	here := t.TempDir()
	resolve := func(id string) (workspace.Workspace, error) {
		switch id {
		case "ws_here":
			return workspace.NewResolver(func() string { return t.TempDir() },
				func(string) (core.Workspace, bool) {
					return core.Workspace{ID: "ws_here", Kind: core.WorkspaceKindLocal, Root: here, State: core.WorkspaceStateReady}, true
				}, nil).Resolve(id)
		case "ws_far":
			return &elsewhere{}, nil
		}
		return nil, errors.New("unknown workspace: " + id)
	}

	if dir, err := turnDir(resolve, "", spawning); dir != "" || err != nil {
		t.Errorf("the project's turn dir = %q, %v; want \"\" — the provider roots itself at the project", dir, err)
	}
	if dir, err := turnDir(resolve, "ws_here", spawning); dir != here || err != nil {
		t.Errorf("a local workspace's turn dir = %q, %v; want %q", dir, err, here)
	}
	if dir, err := turnDir(resolve, "ws_far", spawning); err == nil || !strings.Contains(err.Error(), "far-tree") {
		t.Errorf("a CLI provider in a workspace with no LocalDir got %q, %v; want the turn refused, naming the workspace", dir, err)
	}
	if dir, err := turnDir(resolve, "ws_far", remote); dir != "" || err != nil {
		t.Errorf("an HTTP provider in a workspace with no LocalDir got %q, %v; want it to run", dir, err)
	}
	if _, err := turnDir(resolve, "ws_gone", remote); err == nil {
		t.Error("an unresolvable workspace was given a turn dir")
	}
}
