//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package customprovider

import (
	"context"
	"fmt"

	"juggler/cmd/juggler/ops"
)

// RegisterOps registers the "customProviders" ops handler, which answers the
// add form's question of which providers it can name instead of a typed URL.
// Adding, editing and removing an endpoint are the "accounts" ops, as for any
// account. Call once at startup in app/run.go — not from inside the ops
// package, which would import-cycle.
func RegisterOps() {
	ops.Register("customProviders", func(scope ops.PathScope) ops.Operations {
		return &operations{}
	})
}

// operations is the per-request ops handler. It carries no project scope: the
// catalogue is the same everywhere.
type operations struct{}

// Execute dispatches a customProviders operation.
func (o *operations) Execute(_ context.Context, operation string, _ map[string]any) (any, error) {
	switch operation {
	case "catalog":
		// The snapshot is compiled in, so this asks nothing of the network.
		return map[string]any{"providers": catalog().Providers()}, nil
	default:
		return nil, fmt.Errorf("unknown customProviders operation: %s", operation)
	}
}
