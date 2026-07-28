//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package utils

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"juggler/internal/httpx"
)

// JSONGetOptions configures GetJSON: how to authenticate, which headers to send,
// and how to label the endpoint in error messages.
type JSONGetOptions struct {
	// Bearer, when non-empty, sets "Authorization: Bearer <Bearer>".
	Bearer string
	// RawAuthorization, when non-empty, sets "Authorization: <RawAuthorization>"
	// verbatim (no scheme prefix) — some APIs authenticate with the raw key.
	// Ignored when Bearer is also set.
	RawAuthorization string
	// Headers are set on the request verbatim (overwriting anything already
	// present). Use this for caller-supplied headers and for non-Authorization
	// auth headers (e.g. "x-goog-api-key").
	Headers map[string]string
	// Defaults are applied only when the header is not already present after
	// Headers and auth have been set — e.g. an Accept or User-Agent fallback.
	Defaults map[string]string
	// Label names the endpoint in the non-200 error (e.g. "OpenRouter /models").
	// When empty the request URL is used.
	Label string
	// Client, when set, issues the request instead of a fresh 30s-timeout client.
	Client *http.Client
}

// GetJSON issues a GET request to url and decodes a 200 JSON response body into
// dst. It centralises the request-build → header-set → status-check → decode
// boilerplate duplicated across provider usage and list-model probes. On a
// non-200 status it returns an error including up to 4 KiB of the response body.
func GetJSON(ctx context.Context, url string, opts JSONGetOptions, dst any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("failed to build request: %w", err)
	}
	for key, value := range opts.Headers {
		req.Header.Set(key, value)
	}
	switch {
	case opts.Bearer != "":
		req.Header.Set("Authorization", "Bearer "+opts.Bearer)
	case opts.RawAuthorization != "":
		req.Header.Set("Authorization", opts.RawAuthorization)
	}
	for key, value := range opts.Defaults {
		if req.Header.Get(key) == "" {
			req.Header.Set(key, value)
		}
	}

	client := opts.Client
	if client == nil {
		// The proxy-aware default so live model-list probes reach providers from
		// behind a proxy; callers may still inject their own client.
		client = httpx.Client(30 * time.Second)
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		label := opts.Label
		if label == "" {
			label = url
		}
		return fmt.Errorf("%s returned %d: %s", label, resp.StatusCode, string(body))
	}
	if err := json.NewDecoder(resp.Body).Decode(dst); err != nil {
		return fmt.Errorf("failed to decode response: %w", err)
	}
	return nil
}
