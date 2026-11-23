//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"context"
	"errors"
	"io/fs"
	"net/http"
	"slices"
	"testing"

	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/workspace"
)

// Every handler that acts on a conversation's tree asks the Workspace it was
// resolved to, and never reads its Root as a directory on this machine. The
// workspace here is rooted at a path that does not exist and answers every
// question from a script, so a handler that went to the disk instead would find
// nothing — and a handler that asked would return the script.

const nowhere = "/nowhere/this/tree/does/not/exist"

// scripted is a Workspace whose every answer is canned.
type scripted struct {
	id, name string
	root     string

	build    bool     // whether Operations builds the tool's own handler rather than the script's
	asked    bool     // whether Operations has been asked for a tool
	allowed  []string // the grant it was given
	statable string   // the one path Stat says exists
}

func (s *scripted) ID() string               { return s.id }
func (s *scripted) Root() string             { return s.root }
func (s *scripted) Name() string             { return s.name }
func (s *scripted) LocalDir() (string, bool) { return "", false }

func (s *scripted) Operations(reg ops.Registration, allowed []string) (ops.Operations, error) {
	s.asked, s.allowed = true, allowed
	if s.build {
		return reg.Factory(ops.NewPathScope(s.root, allowed).WithWorkspace(s.id)), nil
	}
	return scriptedOps{}, nil
}

func (s *scripted) StreamShell(_ context.Context, req workspace.ShellRequest, out chan<- ops.ShellStreamChunk) {
	out <- ops.ShellStreamChunk{ShellID: req.ShellID, Data: "from the script", Done: true}
	close(out)
}

func (s *scripted) SearchFiles(context.Context, string, int) ([]ops.FileMatch, error) {
	return []ops.FileMatch{{Path: "scripted/searched.go"}}, nil
}

func (s *scripted) CompletePath(context.Context, string, int) ([]ops.FileMatch, error) {
	return []ops.FileMatch{{Path: "scripted/completed/"}}, nil
}

func (s *scripted) Stat(path string) (fs.FileInfo, error) {
	if path == s.statable {
		return scriptedInfo{}, nil
	}
	return nil, fs.ErrNotExist
}

func (s *scripted) Open(string) (workspace.File, error) { return nil, fs.ErrNotExist }

type scriptedOps struct{}

func (scriptedOps) Execute(context.Context, string, map[string]any) (any, error) {
	return "from the script", nil
}

type scriptedInfo struct{ fs.FileInfo }

// resolveTo answers "" with a scripted project and "ws_far" with far; anything
// else is unknown.
func resolveTo(far *scripted) workspace.ResolveFunc {
	project := &scripted{root: nowhere + "/project"}
	return func(id string) (workspace.Workspace, error) {
		switch id {
		case "":
			return project, nil
		case far.id:
			return far, nil
		}
		return nil, errors.New("unknown workspace: " + id)
	}
}

func TestOpsAPIAsksTheWorkspace(t *testing.T) {
	far := &scripted{id: "ws_far", root: nowhere}
	table := ops.NewTable()
	table.Register("seam-tool", ops.Registration{Factory: func(ops.PathScope) ops.Operations { return nil }})
	api := NewOpsAPI(resolveTo(far)).WithTable(table)

	got, err := api.routeOperation(t.Context(), OperationRequest{
		ToolID: "seam-tool", Operation: "loadFile", WorkspaceID: "ws_far",
		AllowedPaths: []string{"/granted"},
	})
	if err != nil || got != "from the script" {
		t.Fatalf("routeOperation = %v, %v, want the workspace's own answer", got, err)
	}
	if !far.asked || !slices.Equal(far.allowed, []string{"/granted"}) {
		t.Errorf("the workspace was asked %v with grant %v, want asked with [/granted]", far.asked, far.allowed)
	}
}

func TestCompletionsAskTheWorkspace(t *testing.T) {
	far := &scripted{id: "ws_far", root: nowhere, statable: "THERE"}
	api := NewCompletionsAPI(resolveTo(far))

	for _, tc := range []struct {
		handler http.HandlerFunc
		target  string
		want    []string
	}{
		{api.HandleFileCompletions, "/api/completions/files?q=x&workspace=ws_far", []string{"scripted/searched.go"}},
		{api.HandlePathCompletions, "/api/completions/path?q=./x&workspace=ws_far", []string{"scripted/completed/"}},
		{api.HandlePathExists, "/api/completions/exists?paths=THERE&paths=GONE&workspace=ws_far", []string{"THERE"}},
	} {
		if _, got := askCompletions(t, tc.handler, tc.target); !slices.Equal(got, tc.want) {
			t.Errorf("%s = %v, want %v", tc.target, got, tc.want)
		}
	}
}
