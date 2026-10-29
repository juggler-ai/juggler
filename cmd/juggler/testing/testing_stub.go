//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Production stub for cmd/juggler/testing. Provides the minimal surface
// app_phases.go references (NewTestService) so the package compiles under
// -tags production without dragging the real test handlers into the binary.
// The value is never used: app_phases.go calls it only under --test, and a
// production build's RegisterTestRoutes (test_routes_production.go) panics
// before reading its argument.

//go:build production

package testing

// TestService is a stub in production builds — the real type lives in
// test_run_api.go and is only compiled when -tags production is NOT set.
type TestService struct{}

// NewTestService returns nil in production builds. Its only caller hands the
// result straight to RegisterTestRoutes, which in a production build refuses
// --test outright.
func NewTestService(_ string, _ any) *TestService { return nil }
