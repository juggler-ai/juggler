//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package customprovider

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/providers/provider"
)

// RegisterOps registers the "customProviders" ops handler backing the endpoints
// section of the Providers settings tab (list / catalog / save / remove /
// setKey). Call
// once at startup next to acp.RegisterOps() in app/run.go — not from inside the
// ops package, which would import-cycle. Distinct from RegisterAll(), which
// registers the endpoints themselves as providers.
func RegisterOps() {
	ops.Register("customProviders", func(scope ops.PathScope) ops.Operations {
		return &operations{}
	})
}

// operations is the per-request ops handler. It carries no project scope:
// endpoints are global by design, since a provider id is written into
// conversations and into the global model stores alike.
type operations struct{}

// Endpoint is one custom endpoint as its settings card needs it: the definition,
// whether it reached the provider registry, and where its key is coming from.
//
// It is deliberately the whole card in one row. The card sits among the built-in
// providers, but it cannot be drawn from the published provider list alone: an
// endpoint that is switched off, or whose URL no longer parses, is not
// registered and so is not in that list — and that is precisely the endpoint the
// user has come to settings to fix.
type Endpoint struct {
	ID string `json:"id"`
	// ProviderID is the id this endpoint registers under, which is what
	// conversations, the model stores and the model picker all name.
	ProviderID  string            `json:"providerId"`
	DisplayName string            `json:"displayName,omitempty"`
	URL         string            `json:"url,omitempty"`
	Headers     map[string]string `json:"headers,omitempty"`
	Enabled     bool              `json:"enabled"`
	// Registered reports that the endpoint reached the provider registry, and so
	// that its models can be listed and chosen.
	Registered bool `json:"registered"`
	// Error says why an enabled endpoint did not register.
	Error      string         `json:"error,omitempty"`
	HasKey     bool           `json:"hasKey"`
	KeySource  core.KeySource `json:"keySource,omitempty"`
	EnvVarName string         `json:"envVarName"`
}

// Execute dispatches a customProviders operation. Names mirror the JS ops-api
// wrappers (list, catalog, save, remove, setKey).
func (o *operations) Execute(_ context.Context, operation string, params map[string]any) (any, error) {
	switch operation {
	case "list":
		return listEndpoints()
	case "catalog":
		// The providers the add form can name instead of typing a URL. The
		// snapshot is compiled in, so this asks nothing of the network.
		return map[string]any{"providers": catalog().Providers()}, nil
	case "save":
		return save(params)
	case "remove":
		return remove(params)
	case "setKey":
		return setKey(params)
	default:
		return nil, fmt.Errorf("unknown customProviders operation: %s", operation)
	}
}

// listEndpoints returns every configured endpoint, enabled or not, sorted by id
// for a stable card order. Every mutation answers with the same list, so a card
// redraws from one round trip.
func listEndpoints() (any, error) {
	instances, err := Load()
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(instances))
	for id := range instances {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	store, storeErr := core.NewCredentialsStore()
	out := make([]Endpoint, 0, len(ids))
	for _, id := range ids {
		inst := instances[id]
		endpoint := Endpoint{
			ID:          id,
			ProviderID:  RegisteredName(id),
			DisplayName: inst.DisplayName,
			URL:         inst.BaseURL,
			Headers:     inst.Headers,
			Enabled:     inst.IsEnabled(),
			EnvVarName:  EnvVarName(id),
		}
		if endpoint.Enabled {
			if _, registered := provider.GetProviderInfo(RegisteredName(id)); registered {
				endpoint.Registered = true
			} else {
				endpoint.Error = "Not registered. Check the base URL."
				if err := ValidateInstance(inst); err != nil {
					endpoint.Error = err.Error()
				}
			}
		}
		if storeErr == nil {
			endpoint.KeySource = keySource(store, id)
			endpoint.HasKey = endpoint.KeySource != core.KeySourceNone
		}
		out = append(out, endpoint)
	}
	return map[string]any{"endpoints": out}, nil
}

// keySource reports where an endpoint's key comes from, working from the id
// alone rather than through the provider registry: a switched-off endpoint is
// not registered, and its card still shows a key row.
func keySource(store *core.CredentialsStore, id string) core.KeySource {
	if store.GetRawKey(ConfigKeyName(id)) != "" {
		return core.KeySourceCredentials
	}
	if os.Getenv(EnvVarName(id)) != "" {
		return core.KeySourceEnvVar
	}
	return core.KeySourceNone
}

// saveParams is one endpoint in the vocabulary its card posts. Every field but
// the id is optional, and an absent one is left as it was: the card saves a
// field at a time, on the blur of the input the user just left.
type saveParams struct {
	ID          string             `json:"id"`
	DisplayName *string            `json:"displayName,omitempty"`
	URL         *string            `json:"url,omitempty"`
	Headers     *map[string]string `json:"headers,omitempty"`
	Enabled     *bool              `json:"enabled,omitempty"`
}

// save writes one endpoint, adding it when the id is new and editing it when it
// is not. The whole set is rewritten through Apply, which is what reconciles the
// registry, so a new endpoint reaches the picker without a restart.
func save(params map[string]any) (any, error) {
	var p saveParams
	if err := decodeParams(params, &p); err != nil {
		return nil, err
	}
	if p.ID == "" {
		return nil, fmt.Errorf("'id' is required")
	}

	instances, err := Load()
	if err != nil {
		return nil, err
	}
	// A new id must clear the whole bar, including collision with a provider that
	// already exists. An id already present is being edited, so only its shape is
	// checked — it collides with itself.
	instance, existing := instances[p.ID]
	if existing {
		if err := validateIDShape(p.ID); err != nil {
			return nil, err
		}
	} else if err := ValidateID(p.ID); err != nil {
		return nil, err
	}

	instance.Protocol = ProtocolOpenAI
	if p.DisplayName != nil {
		instance.DisplayName = *p.DisplayName
	}
	if p.URL != nil {
		instance.BaseURL = *p.URL
	}
	if p.Headers != nil {
		instance.Headers = *p.Headers
	}
	if p.Enabled != nil {
		instance.Enabled = p.Enabled
	}
	if err := ValidateInstance(instance); err != nil {
		return nil, fmt.Errorf("%s: %w", p.ID, err)
	}

	instances[p.ID] = instance
	if err := Apply(instances); err != nil {
		return nil, err
	}
	return listEndpoints()
}

// remove deletes one endpoint. Delete also forgets the hidden models, token
// limits and model selections keyed to the provider id it registered under, so
// an id handed to a different endpoint later inherits nothing.
func remove(params map[string]any) (any, error) {
	id, _ := params["id"].(string)
	if id == "" {
		return nil, fmt.Errorf("'id' is required")
	}
	if err := Delete(id); err != nil {
		return nil, err
	}
	return listEndpoints()
}

// setKey stores (or, given an empty value, clears) one endpoint's API key. It is
// an operation of its own rather than a post to the generic config route because
// that route resolves a provider's credential slot through the registry, and an
// endpoint the user has switched off is not in it. The slot is derived from the
// id here instead, so the key can be set whatever state the endpoint is in.
func setKey(params map[string]any) (any, error) {
	id, _ := params["id"].(string)
	if id == "" {
		return nil, fmt.Errorf("'id' is required")
	}
	apiKey, ok := params["apiKey"].(string)
	if !ok {
		return nil, fmt.Errorf("'apiKey' must be a string")
	}
	instances, err := Load()
	if err != nil {
		return nil, err
	}
	if _, known := instances[id]; !known {
		return nil, fmt.Errorf("no custom provider %q", id)
	}
	store, err := core.NewCredentialsStore()
	if err != nil {
		return nil, err
	}
	if err := store.SetRawKey(ConfigKeyName(id), apiKey); err != nil {
		return nil, err
	}
	return listEndpoints()
}

// decodeParams coerces an untyped JSON body into typed params via a round-trip,
// the same way the ACP tab decodes its agents.
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
