//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"

	"juggler/cmd/juggler/ops"
)

// RegisterProjectOps registers the "project" operations: what is done to the
// project itself rather than to files in it. sup is how this session reaches
// its machine server; zero for a session with none.
//
//   - relocate {path}: move the project's folder to path — absolute, or a bare
//     name for a folder beside the current one. The machine server does it
//     once nothing holds this session, retiring this process and opening a
//     session on the new path (machineserver/relocate.go); the call returns
//     at once with where the project will be, {project, link}, or the reason
//     the move cannot be made.
func RegisterProjectOps(sup Supervisor) {
	ops.Register("project", func(scope ops.PathScope) ops.Operations {
		return projectOps{sup: sup, project: scope.ProjectRoot()}
	})
}

type projectOps struct {
	sup     Supervisor
	project string
}

func (o projectOps) Execute(ctx context.Context, operation string, params map[string]any) (any, error) {
	switch operation {
	case "relocate":
		dest, _ := params["path"].(string)
		return o.relocate(ctx, dest)
	default:
		return nil, fmt.Errorf("unknown project operation: %s", operation)
	}
}

// relocate asks the machine server to move the project to dest.
func (o projectOps) relocate(ctx context.Context, dest string) (any, error) {
	dest = strings.TrimSpace(dest)
	if dest == "" {
		return nil, errors.New("path is required")
	}
	if !filepath.IsAbs(dest) && !strings.HasPrefix(dest, "~") {
		if strings.ContainsAny(dest, `/\`) {
			return nil, errors.New("give an absolute path, or a bare folder name to rename the project in place")
		}
		dest = filepath.Join(filepath.Dir(o.project), dest)
	}
	if o.sup.Addr == "" || o.sup.Session == "" {
		return nil, errors.New("moving the project needs the machine server, and this session was started without one")
	}
	body, _ := json.Marshal(map[string]string{"project": dest})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"http://"+o.sup.Addr+"/api/server/sessions/"+url.PathEscape(o.sup.Session)+"/relocate", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Juggler-Token", o.sup.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req) //nolint:gosec // loopback machine server named by our spawner
	if err != nil {
		return nil, fmt.Errorf("the machine server could not be reached: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode != http.StatusAccepted {
		var refusal struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(raw, &refusal) == nil && refusal.Error != "" {
			return nil, errors.New(refusal.Error)
		}
		return nil, fmt.Errorf("the machine server refused the move (%d): %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var out struct {
		Project string `json:"project"`
		Link    string `json:"link"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return map[string]any{"project": out.Project, "link": out.Link}, nil
}
