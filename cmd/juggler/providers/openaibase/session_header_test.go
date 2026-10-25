//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// sessionHeaderServer serves chat completions, responses and the model list,
// recording each request's path and the two headers under test.
type sessionHeaderServer struct {
	seen chan sessionHeaderRequest
}

type sessionHeaderRequest struct {
	path, session, trace string
	hasSession           bool
}

func (s *sessionHeaderServer) start(t *testing.T) *httptest.Server {
	t.Helper()
	s.seen = make(chan sessionHeaderRequest, 64)
	chat := "data: {\"id\":\"x\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
	responses := sseBody(`{"type":"response.output_text.delta","delta":"hi","item_id":"m1","output_index":0,"content_index":0,"sequence_number":1}`)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, has := r.Header[http.CanonicalHeaderKey("x-opencode-session")]
		s.seen <- sessionHeaderRequest{
			path:       r.URL.Path,
			session:    r.Header.Get("x-opencode-session"),
			trace:      r.Header.Get("X-Trace"),
			hasSession: has,
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/chat/completions"):
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, chat)
		case strings.HasSuffix(r.URL.Path, "/responses"):
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, responses)
		default:
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"object":"list","data":[{"id":"m","object":"model"}]}`)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// take drains the requests recorded so far. Every caller has already had its
// response, so each request it made is in the channel.
func (s *sessionHeaderServer) take() []sessionHeaderRequest {
	var seen []sessionHeaderRequest
	for {
		select {
		case r := <-s.seen:
			seen = append(seen, r)
		default:
			return seen
		}
	}
}

// registerSessionHeaderProvider registers a provider whose user-configured
// headers carry the placeholder, the way a custom endpoint's do.
func registerSessionHeaderProvider(t *testing.T, quirks Quirks) string {
	t.Helper()
	name := "openaibase-session-header-" + t.Name()
	Register(Descriptor{
		Name:            name,
		Quirks:          quirks,
		ContextWindowFn: func(string) (int, int) { return 2000, 200 },
		HeadersFunc: func() map[string]string {
			return map[string]string{
				"x-opencode-session": "{{sessionId}}",
				"X-Trace":            "juggler-{{sessionId}}",
			}
		},
	})
	return name
}

// TestSessionHeaderPlaceholder: a header value's {{sessionId}} becomes the
// conversation's stable id on both wire paths — the same for every thread of
// a conversation, different between conversations — and a request with no
// conversation sends no such header rather than the literal placeholder.
func TestSessionHeaderPlaceholder(t *testing.T) {
	for _, tc := range []struct {
		name   string
		quirks Quirks
		path   string
	}{
		{"chat completions", Quirks{}, "/chat/completions"},
		{"responses", Quirks{ForceResponsesAPI: true}, "/responses"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var s sessionHeaderServer
			srv := s.start(t)
			name := registerSessionHeaderProvider(t, tc.quirks)
			p, err := provider.InitializeProvider(name, provider.Config{
				APIKey:            "test",
				Model:             "m",
				BaseURL:           srv.URL,
				ModelCapabilities: provider.ModelCapabilities{ContextWindowTokens: 2000, MaxOutputTokens: 200},
			})
			if err != nil {
				t.Fatalf("InitializeProvider: %v", err)
			}

			send := func(convID, threadID string) sessionHeaderRequest {
				t.Helper()
				conv, err := provider.OpenConversation(context.Background(), p, convID)
				if err != nil {
					t.Fatalf("OpenConversation: %v", err)
				}
				defer func() { _ = conv.Close() }()
				_, err = conv.Submit(context.Background(), provider.MessageRequest{
					Messages:       []provider.Message{{Type: "user", Content: "hello"}},
					ConversationID: convID,
					ThreadID:       threadID,
				}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil })
				if err != nil {
					t.Fatalf("Submit: %v", err)
				}
				seen := s.take()
				if len(seen) != 1 || seen[0].path != tc.path {
					t.Fatalf("requests = %+v, want one to %s", seen, tc.path)
				}
				return seen[0]
			}

			root := send("conv-a", "")
			want := sessionAffinityID("conv-a")
			if root.session != want {
				t.Fatalf("x-opencode-session = %q, want %q", root.session, want)
			}
			if root.trace != "juggler-"+want {
				t.Fatalf("X-Trace = %q, want the placeholder replaced inside the value", root.trace)
			}
			if sub := send("conv-a", "sub-thread"); sub.session != want {
				t.Fatalf("sub-thread sent %q, want the conversation's %q", sub.session, want)
			}
			if other := send("conv-b", ""); other.session == want {
				t.Fatalf("two conversations share session %q", want)
			}
			if none := send("", ""); none.hasSession || strings.Contains(none.trace, "{{") {
				t.Fatalf("no-conversation request sent session %q / trace %q, want neither", none.session, none.trace)
			}
		})
	}
}

// TestSessionHeaderNotSentOutsideAConversation: the model list and the
// capability fetch that follows it belong to no conversation, so neither
// carries the header — least of all the literal placeholder.
func TestSessionHeaderNotSentOutsideAConversation(t *testing.T) {
	var s sessionHeaderServer
	srv := s.start(t)
	name := registerSessionHeaderProvider(t, Quirks{})
	p, err := provider.InitializeProvider(name, provider.Config{APIKey: "test", Model: "m", BaseURL: srv.URL})
	if err != nil {
		t.Fatalf("InitializeProvider: %v", err)
	}
	if _, err := p.ListModelsWithInfo(context.Background()); err != nil {
		t.Fatalf("ListModelsWithInfo: %v", err)
	}
	seen := s.take()
	if len(seen) == 0 {
		t.Fatal("the listing made no requests")
	}
	for _, r := range seen {
		if r.hasSession || r.trace != "" {
			t.Fatalf("%s sent session %q / trace %q, want neither", r.path, r.session, r.trace)
		}
	}
}
