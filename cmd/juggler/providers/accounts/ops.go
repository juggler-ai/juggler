//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package accounts

import (
	"context"
	"encoding/json"
	"fmt"
	"sync/atomic"

	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/providers/provider"
)

// RegisterOps registers the "accounts" ops handler backing the settings page's
// Providers section. Call once at startup in app/run.go, beside the other
// non-core ops — not from inside the ops package, which would import-cycle.
func RegisterOps() {
	ops.Register("accounts", func(scope ops.PathScope) ops.Operations {
		return &operations{}
	})
}

// operations is the per-request ops handler. It carries no project scope:
// accounts are global, since an account id is written into conversations and
// into the global model stores alike.
type operations struct{}

// conversationCounter counts this server's conversations that name a provider
// as a model choice, for the remove confirm ("3 conversations use it."). Only
// the server can read conversations, so it installs this; nil leaves the count
// unknown, which the confirm reads as none.
var conversationCounter atomic.Pointer[func(providerID string) (int, error)]

// SetConversationCounter installs the conversation counter. Call it where the
// server is built.
func SetConversationCounter(count func(providerID string) (int, error)) {
	conversationCounter.Store(&count)
}

// Execute dispatches an accounts operation. Every mutation answers with the
// whole list, so the page redraws from one round trip, and republishes the
// providers, so every window's model menus follow without being asked.
func (o *operations) Execute(ctx context.Context, operation string, params map[string]any) (any, error) {
	out, err := o.execute(ctx, operation, params)
	if err == nil && mutates[operation] {
		provider.AccountChanged()
	}
	return out, err
}

// mutates names the operations that change an account.
var mutates = map[string]bool{"save": true, "remove": true, "setKey": true, "addCandidate": true}

func (o *operations) execute(ctx context.Context, operation string, params map[string]any) (any, error) {
	key, _ := params["key"].(string)
	id, _ := params["id"].(string)
	switch operation {
	case "list":
		return listOrLog()
	case "discover":
		// Look again for logins on this machine, then list.
		rediscoverIfStale(ctx)
		return listOrLog()
	case "types":
		return map[string]any{"types": typeEntries()}, nil
	case "preview":
		var p saveParams
		if err := decodeParams(params, &p); err != nil {
			return nil, err
		}
		name := ""
		if p.DisplayName != nil {
			name = *p.DisplayName
		}
		return preview(p.Type, name, p.Settings)
	case "usage":
		if id == "" {
			return nil, fmt.Errorf("'id' is required")
		}
		n := 0
		if count := conversationCounter.Load(); count != nil {
			var err error
			if n, err = (*count)(id); err != nil {
				return nil, err
			}
		}
		return map[string]any{"conversations": n}, nil
	case "save":
		var p saveParams
		if err := decodeParams(params, &p); err != nil {
			return nil, err
		}
		return save(p)
	case "remove":
		if id == "" {
			return nil, fmt.Errorf("'id' is required")
		}
		if err := remove(id); err != nil {
			return nil, err
		}
		return listOrLog()
	case "setKey":
		apiKey, ok := params["apiKey"].(string)
		if id == "" || !ok {
			return nil, fmt.Errorf("'id' and a string 'apiKey' are required")
		}
		return save(saveParams{ID: id, APIKey: &apiKey})
	case "addCandidate":
		if key == "" {
			return nil, fmt.Errorf("'key' is required")
		}
		return addCandidate(key)
	default:
		return nil, fmt.Errorf("unknown accounts operation: %s", operation)
	}
}

func listOrLog() (List, error) {
	list, err := buildList()
	if err != nil {
		logListError(err)
	}
	return list, err
}

// decodeParams coerces an untyped JSON body into typed params via a round-trip.
func decodeParams(params map[string]any, out any) error {
	if params == nil {
		return nil
	}
	encoded, err := json.Marshal(params)
	if err != nil {
		return err
	}
	return json.Unmarshal(encoded, out)
}
