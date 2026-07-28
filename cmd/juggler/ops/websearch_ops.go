//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"juggler/internal/httpx"
)

// WebSearchOperations handles web search functionality
type WebSearchOperations struct {
	scope PathScope
}

// NewWebSearchOperations creates a new web search operations handler
func NewWebSearchOperations(scope PathScope) *WebSearchOperations {
	return &WebSearchOperations{
		scope: scope,
	}
}

// Execute executes a web search operation
func (ops *WebSearchOperations) Execute(ctx context.Context, operation string, params map[string]any) (any, error) {
	switch operation {
	case "search":
		return ops.search(ctx, params)
	default:
		return nil, fmt.Errorf("unknown operation: %s", operation)
	}
}

// search acts as a CORS proxy - frontend passes URL, we fetch and return raw content
func (ops *WebSearchOperations) search(ctx context.Context, params map[string]any) (any, error) {
	// Frontend passes the full search URL
	urlStr, ok := params["url"].(string)
	if !ok || urlStr == "" {
		return nil, fmt.Errorf("missing url parameter")
	}

	// For POST requests (DuckDuckGo), accept form data
	method := "GET"
	if m, ok := params["method"].(string); ok {
		method = strings.ToUpper(m)
	}

	var body io.Reader
	if formData, ok := params["form_data"].(map[string]any); ok && method == "POST" {
		data := url.Values{}
		for k, v := range formData {
			data.Set(k, fmt.Sprintf("%v", v))
		}
		body = strings.NewReader(data.Encode())
	}

	// Create HTTP request
	req, err := http.NewRequestWithContext(ctx, method, urlStr, body)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	// Set headers
	if method == "POST" {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	req.Header.Set("User-Agent", "Juggler/1.0 (AI Coding Assistant)")
	req.Header.Set("Accept", "application/json, text/html, */*")

	// Execute request (like webfetch does), proxy-aware.
	client := httpx.Client(30 * time.Second)
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP error: %d", resp.StatusCode)
	}

	// Read and return raw response
	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	return map[string]any{
		"url":     urlStr,
		"content": string(bodyBytes),
		"status":  resp.StatusCode,
	}, nil
}
