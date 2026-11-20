//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/userpaths"
	"juggler/internal/userpaths/userpathstest"
)

type fakeUsageProvider struct {
	name string
	err  error
	// reportAs, when set, is the Provider its stats name in place of name — as
	// a further account of a type reports the type's name.
	reportAs string
}

func (p fakeUsageProvider) Name() string { return p.name }
func (p fakeUsageProvider) ListModelsWithInfo(context.Context) ([]provider.ModelInfo, error) {
	return nil, nil
}
func (p fakeUsageProvider) OpenConversation(context.Context, string) (provider.Conversation, error) {
	return nil, nil
}
func (p fakeUsageProvider) UsageStats(context.Context) (provider.UsageStats, error) {
	if p.err != nil {
		return provider.UsageStats{}, p.err
	}
	reported := p.name
	if p.reportAs != "" {
		reported = p.reportAs
	}
	return provider.UsageStats{
		Provider:  reported,
		Plan:      "test-plan",
		UpdatedAt: time.Unix(1000, 0).UTC(),
		Stats: []provider.UsageStat{{
			Name:        "Session (5h)",
			UsedPercent: provider.Pct(42),
			Category:    "primary",
		}},
	}, nil
}

// fakeModelProvider is a minimal provider whose model list is produced locally
// (no network, no subprocess) — the contract a ReadinessCheck provider must
// honour so computeProviders can list its models even when gated unready.
type fakeModelProvider struct{ name string }

func (p fakeModelProvider) Name() string { return p.name }
func (p fakeModelProvider) ListModelsWithInfo(context.Context) ([]provider.ModelInfo, error) {
	return []provider.ModelInfo{{ID: "m1", DisplayName: "Model One"}}, nil
}
func (p fakeModelProvider) OpenConversation(context.Context, string) (provider.Conversation, error) {
	return nil, nil
}

func writeEnabledProviders(t *testing.T, names ...string) {
	t.Helper()
	userpathstest.Isolate(t)
	jugglerDir := userpaths.ConfigDir()
	if err := os.MkdirAll(jugglerDir, 0700); err != nil {
		t.Fatalf("mkdir credentials dir: %v", err)
	}
	var b strings.Builder
	b.WriteString("{")
	for i, n := range names {
		if i > 0 {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, "%q:%q", "enabled_"+n, "true")
	}
	b.WriteString("}")
	if err := os.WriteFile(filepath.Join(jugglerDir, "credentials.json"), []byte(b.String()), 0600); err != nil {
		t.Fatalf("write credentials: %v", err)
	}
}

// TestHandleProviderUsageStatsScopedToProvider verifies the endpoint fetches
// ONLY the requested provider, never fanning out to others the user isn't
// viewing (which for CLI providers can provoke a login).
func TestHandleProviderUsageStatsScopedToProvider(t *testing.T) {
	const okName = "scope_ok"
	const otherName = "scope_other"
	provider.RegisterProvider(provider.ProviderInfo{Name: okName, AuthType: provider.AuthTypeToggle}, func(provider.Config) (provider.Provider, error) {
		return fakeUsageProvider{name: okName}, nil
	})
	// This provider errors if its usage is ever fetched — so if the scope leaks,
	// the test sees it surface in the errors map.
	provider.RegisterProvider(provider.ProviderInfo{Name: otherName, AuthType: provider.AuthTypeToggle}, func(provider.Config) (provider.Provider, error) {
		return fakeUsageProvider{name: otherName, err: errors.New("should not be fetched")}, nil
	})

	writeEnabledProviders(t, okName, otherName)

	req := httptest.NewRequest(http.MethodGet, "/api/providers/usage?provider="+okName, nil)
	rec := httptest.NewRecorder()
	(&Server{}).handleProviderUsageStats(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}

	var body struct {
		Usage  []provider.UsageStats `json:"usage"`
		Errors map[string]string     `json:"errors"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	for _, u := range body.Usage {
		if u.Provider == otherName {
			t.Fatalf("scoped request leaked usage for %s", otherName)
		}
	}
	if _, leaked := body.Errors[otherName]; leaked {
		t.Fatalf("scoped request fetched (and errored on) %s: %v", otherName, body.Errors)
	}
	var gotOK bool
	for _, u := range body.Usage {
		if u.Provider == okName {
			gotOK = true
		}
	}
	if !gotOK {
		t.Fatalf("scoped request missing usage for %s: %+v", okName, body.Usage)
	}
}

// TestHandleProviderUsageStatsNamesAccount verifies the endpoint labels each
// snapshot with the account it fetched, whatever name the provider's stats
// carry: a further account of a type (a second Codex login) reports the type's
// name, and the client keeps only the entry whose provider matches the account
// it asked for.
func TestHandleProviderUsageStatsNamesAccount(t *testing.T) {
	const accountName = "usage_type-work"
	provider.RegisterProvider(provider.ProviderInfo{Name: accountName, AuthType: provider.AuthTypeToggle}, func(provider.Config) (provider.Provider, error) {
		return fakeUsageProvider{name: accountName, reportAs: "usage_type"}, nil
	})
	writeEnabledProviders(t, accountName)

	req := httptest.NewRequest(http.MethodGet, "/api/providers/usage?provider="+accountName, nil)
	rec := httptest.NewRecorder()
	(&Server{}).handleProviderUsageStats(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Usage []provider.UsageStats `json:"usage"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(body.Usage) != 1 || body.Usage[0].Provider != accountName {
		t.Fatalf("usage = %+v, want one snapshot for %s", body.Usage, accountName)
	}
}

// TestComputeProvidersReadinessGate verifies the option-2 wiring: a credentialed
// provider whose ReadinessCheck reports not-ready is marked unavailable with the
// probe's hint, yet still lists its (local) models so the menu shows them
// disabled rather than hiding the provider.
func TestComputeProvidersReadinessGate(t *testing.T) {
	const name = "readygate"
	provider.RegisterProvider(provider.ProviderInfo{
		Name:           name,
		AuthType:       provider.AuthTypeToggle,
		AutoDetect:     func() bool { return true },
		ReadinessCheck: func() (bool, msg.Message) { return false, msg.New("please sign in") },
	}, func(provider.Config) (provider.Provider, error) {
		return fakeModelProvider{name: name}, nil
	})

	writeEnabledProviders(t, name)

	list := (&Server{}).computeProviders(context.Background())
	var got *ProviderStatus
	for i := range list {
		if list[i].Name == name {
			got = &list[i]
		}
	}
	if got == nil {
		t.Fatalf("provider %s missing from computeProviders result", name)
	}
	if got.Available {
		t.Fatalf("expected %s unavailable when readiness gated", name)
	}
	if got.AuthHint != "please sign in" {
		t.Fatalf("AuthHint = %q, want the readiness hint", got.AuthHint)
	}
	if len(got.ModelsWithContext) == 0 {
		t.Fatalf("expected models listed (disabled) even when gated unready")
	}
}

// TestComputeProvidersPublishesMessages pins what /api/providers carries for a
// provider's description and its readiness hint: the English in description
// and authHint, as an older client reads them, and beside each the message it
// was rendered from, for the settings page to show translated.
func TestComputeProvidersPublishesMessages(t *testing.T) {
	const name = "messagegate"
	provider.RegisterProvider(provider.ProviderInfo{
		Name:           name,
		Description:    msg.New("Stands in for a provider with a blurb."),
		AuthType:       provider.AuthTypeToggle,
		AutoDetect:     func() bool { return true },
		ReadinessCheck: func() (bool, msg.Message) { return false, msg.New("Sign in to the stand-in.") },
	}, func(provider.Config) (provider.Provider, error) {
		return fakeModelProvider{name: name}, nil
	})

	writeEnabledProviders(t, name)

	var published map[string]any
	for _, p := range (&Server{}).computeProviders(context.Background()) {
		if p.Name != name {
			continue
		}
		raw, err := json.Marshal(p)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(raw, &published); err != nil {
			t.Fatal(err)
		}
	}
	if published == nil {
		t.Fatalf("provider %s missing from computeProviders result", name)
	}
	for field, want := range map[string]string{
		"description": "Stands in for a provider with a blurb.",
		"authHint":    "Sign in to the stand-in.",
	} {
		if published[field] != want {
			t.Errorf("%s = %#v, want %q", field, published[field], want)
		}
		message, _ := published[field+"Message"].(map[string]any)
		if message == nil || message["key"] != want {
			t.Errorf("%sMessage = %#v, want a message keyed %q", field, published[field+"Message"], want)
		}
	}
}

func TestHandleProviderUsageStatsBestEffort(t *testing.T) {
	const okName = "testusage_ok"
	const errName = "testusage_err"
	provider.RegisterProvider(provider.ProviderInfo{Name: okName, AuthType: provider.AuthTypeToggle}, func(provider.Config) (provider.Provider, error) {
		return fakeUsageProvider{name: okName}, nil
	})
	provider.RegisterProvider(provider.ProviderInfo{Name: errName, AuthType: provider.AuthTypeToggle}, func(provider.Config) (provider.Provider, error) {
		return fakeUsageProvider{name: errName, err: errors.New("upstream unavailable")}, nil
	})

	userpathstest.Isolate(t)
	jugglerDir := userpaths.ConfigDir()
	if err := os.MkdirAll(jugglerDir, 0700); err != nil {
		t.Fatalf("mkdir credentials dir: %v", err)
	}
	creds := []byte(`{"enabled_testusage_ok":"true","enabled_testusage_err":"true"}`)
	if err := os.WriteFile(filepath.Join(jugglerDir, "credentials.json"), creds, 0600); err != nil {
		t.Fatalf("write credentials: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/providers/usage", nil)
	rec := httptest.NewRecorder()
	(&Server{}).handleProviderUsageStats(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}

	var body struct {
		Usage  []provider.UsageStats `json:"usage"`
		Errors map[string]string     `json:"errors"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	var found *provider.UsageStats
	for i := range body.Usage {
		if body.Usage[i].Provider == okName {
			found = &body.Usage[i]
		}
	}
	if found == nil || found.Plan != "test-plan" || len(found.Stats) != 1 || found.Stats[0].UsedPercent == nil || *found.Stats[0].UsedPercent != 42 {
		t.Fatalf("missing expected usage for %s: %+v", okName, body.Usage)
	}
	if body.Errors[errName] != "upstream unavailable" {
		t.Fatalf("errors[%s] = %q", errName, body.Errors[errName])
	}
}
