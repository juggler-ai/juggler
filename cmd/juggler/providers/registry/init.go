//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package provider

import (
	"fmt"
	"sync"
)

// ProviderInitializer is a function that creates a provider instance
type ProviderInitializer func(cfg Config) (Provider, error)

// initializers maps provider names to their initializer functions.
// Populated only at package-init time by RegisterProvider; the read accessors
// below treat the maps as immutable after init.
var initializers = make(map[string]ProviderInitializer)

// providerInfos maps provider names to their info. Same lifecycle as initializers.
var providerInfos = make(map[string]ProviderInfo)

// RegisterProvider registers a provider info and its initializer
func RegisterProvider(info ProviderInfo, initializer ProviderInitializer) {
	initializers[info.Name] = initializer
	providerInfos[info.Name] = info
}

// InitializeProvider initializes a provider by name using config
// Note: Model is required in Config. If you only need to list models,
// you can pass any placeholder model name since ListModelsWithInfo() doesn't use it.
func InitializeProvider(name string, cfg Config) (Provider, error) {
	initializer, ok := initializers[name]
	if !ok {
		return nil, fmt.Errorf("no initializer registered for provider: %s", name)
	}

	initialized, err := initializer(cfg)
	if err != nil {
		return nil, err
	}
	wrapped := &admissionProvider{
		Provider:     initialized,
		capabilities: cfg.ModelCapabilities,
		contract:     cfg.BudgetContract,
	}
	if usage, ok := initialized.(UsageStatsProvider); ok {
		return &admissionUsageProvider{admissionProvider: wrapped, usage: usage}, nil
	}
	return wrapped, nil
}

// ListAvailableProviders returns a list of registered provider names
func ListAvailableProviders() []string {
	var names []string
	for name := range initializers {
		names = append(names, name)
	}
	return names
}

// GetProviderInfo returns the provider info for a given provider name
func GetProviderInfo(name string) (ProviderInfo, bool) {
	info, ok := providerInfos[name]
	return info, ok
}

// ListProviderInfos returns all registered provider infos
func ListProviderInfos() []ProviderInfo {
	var infos []ProviderInfo
	for _, info := range providerInfos {
		infos = append(infos, info)
	}
	return infos
}

// Auto-detection results are computed once on first access.
// After computation, the map is read-only (safe from any goroutine).
var (
	autoDetectResults map[string]bool
	autoDetectOnce    sync.Once
)

func computeAutoDetect() {
	autoDetectResults = make(map[string]bool)
	for name, info := range providerInfos {
		if info.AutoDetect != nil {
			autoDetectResults[name] = info.AutoDetect()
		}
	}
}

// CheckAutoDetect returns whether a provider is auto-detected as available.
// Results are computed once on first call and cached for the server lifetime.
func CheckAutoDetect(providerName string) bool {
	autoDetectOnce.Do(computeAutoDetect)
	return autoDetectResults[providerName]
}
