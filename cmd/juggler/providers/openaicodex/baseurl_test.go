//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaicodex

import (
	"bytes"
	"context"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestParseBaseURLOverride(t *testing.T) {
	tests := []struct {
		raw     string
		want    string
		wantErr bool
	}{
		{raw: "https://gateway.example/backend-api/codex", want: "https://gateway.example/backend-api/codex"},
		{raw: "https://gateway.example/backend-api/codex/", want: "https://gateway.example/backend-api/codex"},
		{raw: "http://127.0.0.1:8123/chatgpt/backend-api/codex", want: "http://127.0.0.1:8123/chatgpt/backend-api/codex"},
		{raw: "http://localhost:8123/x", want: "http://localhost:8123/x"},
		{raw: "http://[::1]:8123/x", want: "http://[::1]:8123/x"},
		{raw: "http://127.8.9.10/x", want: "http://127.8.9.10/x"},
		{raw: "http://gateway.example/backend-api/codex", wantErr: true},
		{raw: "http://10.0.0.1/x", wantErr: true},
		{raw: "ftp://127.0.0.1/x", wantErr: true},
		{raw: "/backend-api/codex", wantErr: true},
		{raw: "https://gateway.example/x?a=b", wantErr: true},
		{raw: "://bad", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.raw, func(t *testing.T) {
			got, err := parseBaseURLOverride(tt.raw)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("parseBaseURLOverride(%q) = %q, want error", tt.raw, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseBaseURLOverride(%q): %v", tt.raw, err)
			}
			if got != tt.want {
				t.Fatalf("parseBaseURLOverride(%q) = %q, want %q", tt.raw, got, tt.want)
			}
		})
	}
}

func TestCodexBaseURL(t *testing.T) {
	tests := []struct {
		name     string
		override string
		env      map[string]string
		want     string
	}{
		{name: "unset keeps default", want: baseURL},
		{name: "expands env", override: "${CODEX_CHATGPT_0_BASE_URL}/backend-api/codex",
			env:  map[string]string{"CODEX_CHATGPT_0_BASE_URL": "http://127.0.0.1:4567/chatgpt"},
			want: "http://127.0.0.1:4567/chatgpt/backend-api/codex"},
		{name: "remote http falls back to default", override: "http://gateway.example/backend-api/codex", want: baseURL},
		{name: "unset expansion falls back to default", override: "${CODEX_TEST_UNSET_VAR}/backend-api/codex", want: baseURL},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv(baseURLEnv, tt.override)
			t.Setenv("CODEX_TEST_UNSET_VAR", "")
			for k, v := range tt.env {
				t.Setenv(k, v)
			}
			if got := codexBaseURL(); got != tt.want {
				t.Fatalf("codexBaseURL() = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestCodexBaseURLReportsARejectedOverride: an override that fails validation
// is named in the log, so a typo is not a silent fallback to the default.
func TestCodexBaseURLReportsARejectedOverride(t *testing.T) {
	var out bytes.Buffer
	log.SetOutput(&out)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })

	t.Setenv(baseURLEnv, "http://gateway.example/backend-api/codex")
	if got := codexBaseURL(); got != baseURL {
		t.Fatalf("codexBaseURL() = %q, want the default %q", got, baseURL)
	}
	if !strings.Contains(out.String(), "ignoring "+baseURLEnv) {
		t.Fatalf("log = %q, want it to name the ignored %s", out.String(), baseURLEnv)
	}

	out.Reset()
	t.Setenv(baseURLEnv, "")
	codexBaseURL()
	if out.Len() != 0 {
		t.Fatalf("an unset override logged %q", out.String())
	}
}

// TestBaseURLOverrideRoutesModelsAndUsage: /models and /usage are built on the
// override.
func TestBaseURLOverrideRoutesModelsAndUsage(t *testing.T) {
	paths := make(chan string, 8)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths <- r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/proxy/backend-api/codex/models" {
			_, _ = w.Write([]byte(`{"models":[{"slug":"gpt-5.5","visibility":"list","context_window":272000,"priority":1}]}`))
			return
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	t.Setenv("CODEX_TEST_PROXY", server.URL+"/proxy")
	t.Setenv(baseURLEnv, "${CODEX_TEST_PROXY}/backend-api/codex")

	if _, err := listModels(context.Background(), "token", nil); err != nil {
		t.Fatalf("listModels: %v", err)
	}
	if _, err := usageStats(context.Background(), "token", nil); err != nil {
		t.Fatalf("usageStats: %v", err)
	}
	for _, want := range []string{"/proxy/backend-api/codex/models", "/proxy/backend-api/codex/usage"} {
		if got := <-paths; got != want {
			t.Fatalf("path = %q, want %q", got, want)
		}
	}
}
