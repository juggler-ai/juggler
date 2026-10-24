//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"fmt"

	"juggler/cmd/juggler/projectenv"
)

// ProjectEnvOperations read and write the environment variables shell commands
// get (package projectenv). Like the shell, they act on the PROJECT whichever
// workspace the request names.
type ProjectEnvOperations struct {
	scope PathScope
}

// NewProjectEnvOperations creates the handler.
func NewProjectEnvOperations(scope PathScope) *ProjectEnvOperations {
	return &ProjectEnvOperations{scope: scope}
}

// Execute dispatches:
//
//	get                 every file, the merged result and what is pending
//	approve             approve the project file as it stands now
//	set {scope, env}    replace one file's variables; an empty env removes it
func (o *ProjectEnvOperations) Execute(_ context.Context, operation string, params map[string]any) (any, error) {
	root := o.scope.ProjectRoot()
	switch operation {
	case "get":
		return projectenv.Resolve(root), nil
	case "approve":
		if err := projectenv.Approve(root); err != nil {
			return nil, err
		}
		return projectenv.Resolve(root), nil
	case "set":
		rawScope, _ := params["scope"].(string)
		sc, err := projectenv.ParseScope(rawScope)
		if err != nil {
			return nil, err
		}
		env, err := envParam(params["env"])
		if err != nil {
			return nil, err
		}
		if err := projectenv.Write(root, sc, env); err != nil {
			return nil, err
		}
		return projectenv.Resolve(root), nil
	default:
		return nil, fmt.Errorf("unknown operation: %s", operation)
	}
}

// envParam reads a JSON object of string values; absent is empty.
func envParam(v any) (map[string]string, error) {
	if v == nil {
		return map[string]string{}, nil
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("env must be an object of string values")
	}
	out := make(map[string]string, len(m))
	for k, raw := range m {
		s, ok := raw.(string)
		if !ok {
			return nil, fmt.Errorf("env value for %s must be a string", k)
		}
		out[k] = s
	}
	return out, nil
}
