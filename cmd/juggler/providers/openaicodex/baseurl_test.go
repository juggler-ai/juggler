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
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// setOverride sets JUGGLER_CODEX_BASE_URL for the test and has the next request
// resolve it afresh, as a process started with that value would.
func setOverride(t *testing.T, value string) {
	t.Helper()
	t.Setenv(baseURLEnv, value)
	baseURLOverride = sync.OnceValues(overrideFromEnv)
	t.Cleanup(func() { baseURLOverride = sync.OnceValues(overrideFromEnv) })
}

// captureLog collects the standard logger, which jlog writes through, for the
// rest of the test.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var out bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&out)
	t.Cleanup(func() { log.SetOutput(prev) })
	return &out
}

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
		{raw: "http://127.0.0.1@gateway.example/x", wantErr: true},
		{raw: "ftp://127.0.0.1/x", wantErr: true},
		{raw: "/backend-api/codex", wantErr: true},
		{raw: "https://gateway.example/x?key=secret", wantErr: true},
		{raw: "https://gateway.example/x#secret", wantErr: true},
		{raw: "https://user:secret@gateway.example/x", wantErr: true},
		{raw: "https://secret@gateway.example/x", wantErr: true},
		{raw: "://bad", wantErr: true},
		{raw: "https://gateway.example/\x7fsecret", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.raw, func(t *testing.T) {
			got, err := parseBaseURLOverride(tt.raw)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("parseBaseURLOverride(%q) = %q, want error", tt.raw, got)
				}
				// The error is logged and shown, so it must not repeat a
				// credential the value carried.
				if strings.Contains(err.Error(), "secret") {
					t.Fatalf("error %q repeats the value's credential", err)
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
		wantErr  bool
	}{
		{name: "unset keeps default", want: baseURL},
		{name: "expands env", override: "${CODEX_CHATGPT_0_BASE_URL}/backend-api/codex",
			env:  map[string]string{"CODEX_CHATGPT_0_BASE_URL": "http://127.0.0.1:4567/chatgpt"},
			want: "http://127.0.0.1:4567/chatgpt/backend-api/codex"},
		{name: "remote http is refused", override: "http://gateway.example/backend-api/codex", wantErr: true},
		{name: "unset expansion is refused", override: "${CODEX_TEST_UNSET_VAR}/backend-api/codex", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			captureLog(t)
			t.Setenv("CODEX_TEST_UNSET_VAR", "")
			for k, v := range tt.env {
				t.Setenv(k, v)
			}
			setOverride(t, tt.override)
			got, err := codexBaseURL()
			if tt.wantErr {
				if err == nil {
					t.Fatalf("codexBaseURL() = %q, want an error, never a fallback to the default", got)
				}
				return
			}
			if err != nil || got != tt.want {
				t.Fatalf("codexBaseURL() = %q, %v; want %q", got, err, tt.want)
			}
		})
	}
}

// TestCodexBaseURLResolvesOnce: the environment is fixed for the life of the
// process, so the override is resolved once and an unusable one is logged once,
// naming the variable, however many requests then meet it.
func TestCodexBaseURLResolvesOnce(t *testing.T) {
	out := captureLog(t)
	setOverride(t, "http://gateway.example/backend-api/codex")
	for range 3 {
		if _, err := codexBaseURL(); err == nil {
			t.Fatal("codexBaseURL() accepted a remote http override")
		}
	}
	if n := strings.Count(out.String(), baseURLEnv); n != 1 {
		t.Fatalf("the rejection was logged %d times, want once: %q", n, out.String())
	}

	out.Reset()
	setOverride(t, "")
	if _, err := codexBaseURL(); err != nil || out.Len() != 0 {
		t.Fatalf("an unset override: err %v, logged %q", err, out.String())
	}
}

// codexTurn submits one user turn through the registered provider, which is
// the only route to the responses endpoint.
func codexTurn(t *testing.T) error {
	t.Helper()
	Register()
	p, err := provider.InitializeProvider("openaicodex", provider.Config{
		BearerToken:       "token",
		Model:             "gpt-5.5",
		ModelCapabilities: provider.ModelCapabilities{ContextWindowTokens: 272000, MaxOutputTokens: 32000},
	})
	if err != nil {
		return err
	}
	conv, err := provider.OpenConversation(context.Background(), p, "conv")
	if err != nil {
		t.Fatalf("OpenConversation: %v", err)
	}
	defer conv.Close()
	_, err = conv.Submit(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hello"}},
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil })
	return err
}

// TestBaseURLOverrideRoutesEveryRequest: the turn itself, /models and /usage
// are all built on the override.
func TestBaseURLOverrideRoutesEveryRequest(t *testing.T) {
	paths := make(chan string, 8)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths <- r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/proxy/backend-api/codex/models":
			_, _ = w.Write([]byte(`{"models":[{"slug":"gpt-5.5","visibility":"list","context_window":272000,"priority":1}]}`))
		case "/proxy/backend-api/codex/usage":
			_, _ = w.Write([]byte(`{}`))
		default:
			// Reaching here is all the turn has to do.
			http.Error(w, `{"error":{"message":"stop here","type":"invalid_request_error"}}`, http.StatusBadRequest)
		}
	}))
	defer server.Close()
	t.Setenv("CODEX_TEST_PROXY", server.URL+"/proxy")
	setOverride(t, "${CODEX_TEST_PROXY}/backend-api/codex")

	if _, err := listModels(context.Background(), "token", nil); err != nil {
		t.Fatalf("listModels: %v", err)
	}
	if _, err := usageStats(context.Background(), "token", nil); err != nil {
		t.Fatalf("usageStats: %v", err)
	}
	_ = codexTurn(t)
	server.Close() // waits out the handlers, so every path is on the channel
	close(paths)

	var got []string
	for p := range paths {
		got = append(got, p)
	}
	want := []string{"/proxy/backend-api/codex/models", "/proxy/backend-api/codex/usage", "/proxy/backend-api/codex/responses"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("paths = %q, want %q", got, want)
	}
}

// TestUnusableOverrideSendsNothing: an override that fails validation stops
// every request with the reason, rather than sending the token to the default
// endpoint around the gateway the user named.
func TestUnusableOverrideSendsNothing(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		http.Error(w, "the default endpoint was called", http.StatusTeapot)
	}))
	defer server.Close()
	originalBaseURL := baseURL
	baseURL = server.URL
	t.Cleanup(func() { baseURL = originalBaseURL })
	captureLog(t)
	setOverride(t, "http://gateway.example/backend-api/codex")

	_, modelsErr := listModels(context.Background(), "token", nil)
	_, usageErr := usageStats(context.Background(), "token", nil)
	turnErr := codexTurn(t)
	for name, err := range map[string]error{"models": modelsErr, "usage": usageErr, "turn": turnErr} {
		if err == nil || !strings.Contains(err.Error(), baseURLEnv) {
			t.Errorf("%s: error = %v, want it to name %s", name, err, baseURLEnv)
		}
	}
	if n := requests.Load(); n != 0 {
		t.Fatalf("the default endpoint was called %d times", n)
	}
}
