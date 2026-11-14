//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"context"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// streamResponsesToolCalls streams body through the Responses parser and
// returns the tool_use chunks it emitted, in emission order.
func streamResponsesToolCalls(t *testing.T, body string) []provider.StreamChunk {
	t.Helper()
	httpClient := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		header := make(http.Header)
		header.Set("Content-Type", "text/event-stream")
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     header,
			Body:       io.NopCloser(strings.NewReader(body)),
			Request:    r,
		}, nil
	})}
	c, err := NewClient(Config{
		APIKey:     "test",
		Model:      "gpt-5-codex",
		BaseURL:    "https://example.test",
		HTTPClient: httpClient,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	var calls []provider.StreamChunk
	if _, err := c.streamMessage(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "go"}},
	}, func(chunk provider.StreamChunk) (*provider.ToolResult, error) {
		if chunk.Type == provider.ContentBlockTypeToolUse {
			calls = append(calls, chunk)
		}
		return nil, nil
	}); err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	return calls
}

// TestResponsesToolCallArguments covers how a streamed function call gets its
// arguments. A call whose arguments are lost does not fail here: it is emitted
// as `{}`, runs, and comes back as "Missing required parameter" — and the `{}`
// is then replayed to the model as what it asked for. So every shape a backend
// may use to deliver arguments must arrive whole, and parallel calls must keep
// the order the model emitted them in.
func TestResponsesToolCallArguments(t *testing.T) {
	type call struct {
		id, name string
		input    map[string]any
	}
	for _, tc := range []struct {
		name   string
		events []string
		want   []call
	}{
		{
			name: "arguments only on the done events, no deltas",
			events: []string{
				`{"type":"response.output_item.added","output_index":0,"sequence_number":1,"item":{"type":"function_call","id":"fc_a","call_id":"call_a","name":"bash","arguments":""}}`,
				`{"type":"response.function_call_arguments.done","item_id":"fc_a","output_index":0,"sequence_number":2,"arguments":"{\"command\":\"ls\"}"}`,
				`{"type":"response.output_item.done","output_index":0,"sequence_number":3,"item":{"type":"function_call","id":"fc_a","call_id":"call_a","name":"bash","arguments":"{\"command\":\"ls\"}"}}`,
			},
			want: []call{{"call_a", "bash", map[string]any{"command": "ls"}}},
		},
		{
			name: "deltas under an item id the added event did not use",
			events: []string{
				`{"type":"response.output_item.added","output_index":0,"sequence_number":1,"item":{"type":"function_call","id":"fc_a","call_id":"call_a","name":"bash","arguments":""}}`,
				`{"type":"response.function_call_arguments.delta","item_id":"fc_other","output_index":0,"sequence_number":2,"delta":"{\"command\":"}`,
				`{"type":"response.function_call_arguments.delta","item_id":"fc_other","output_index":0,"sequence_number":3,"delta":"\"pwd\"}"}`,
			},
			want: []call{{"call_a", "bash", map[string]any{"command": "pwd"}}},
		},
		{
			name: "a call seen only as a finished item",
			events: []string{
				`{"type":"response.output_item.done","output_index":0,"sequence_number":1,"item":{"type":"function_call","id":"fc_a","call_id":"call_a","name":"query_code","arguments":"{\"code\":\"return 1\"}"}}`,
			},
			want: []call{{"call_a", "query_code", map[string]any{"code": "return 1"}}},
		},
		{
			name: "the finished item's arguments win over the deltas",
			events: []string{
				`{"type":"response.output_item.added","output_index":0,"sequence_number":1,"item":{"type":"function_call","id":"fc_a","call_id":"call_a","name":"bash","arguments":""}}`,
				`{"type":"response.function_call_arguments.delta","item_id":"fc_a","output_index":0,"sequence_number":2,"delta":"{\"command\":\"l"}`,
				`{"type":"response.output_item.done","output_index":0,"sequence_number":3,"item":{"type":"function_call","id":"fc_a","call_id":"call_a","name":"bash","arguments":"{\"command\":\"ls\"}"}}`,
			},
			want: []call{{"call_a", "bash", map[string]any{"command": "ls"}}},
		},
		{
			name: "parallel calls keep their output order",
			events: []string{
				`{"type":"response.output_item.added","output_index":1,"sequence_number":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"query_code","arguments":""}}`,
				`{"type":"response.output_item.added","output_index":2,"sequence_number":2,"item":{"type":"function_call","id":"fc_2","call_id":"call_2","name":"bash","arguments":""}}`,
				`{"type":"response.output_item.added","output_index":3,"sequence_number":3,"item":{"type":"function_call","id":"fc_3","call_id":"call_3","name":"batch_read","arguments":""}}`,
				`{"type":"response.function_call_arguments.delta","item_id":"fc_3","output_index":3,"sequence_number":4,"delta":"{\"files\":[]}"}`,
				`{"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":1,"sequence_number":5,"delta":"{\"code\":\"x\"}"}`,
				`{"type":"response.function_call_arguments.delta","item_id":"fc_2","output_index":2,"sequence_number":6,"delta":"{\"command\":\"ls\"}"}`,
			},
			want: []call{
				{"call_1", "query_code", map[string]any{"code": "x"}},
				{"call_2", "bash", map[string]any{"command": "ls"}},
				{"call_3", "batch_read", map[string]any{"files": []any{}}},
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			events := append(append([]string{}, tc.events...), `{"type":"response.completed","sequence_number":99,"response":{"id":"resp_1","status":"completed","output":[]}}`)
			got := streamResponsesToolCalls(t, sseBody(events...))
			if len(got) != len(tc.want) {
				t.Fatalf("emitted %d tool calls, want %d: %+v", len(got), len(tc.want), got)
			}
			for i, w := range tc.want {
				g := got[i]
				if g.ToolUseID != w.id || g.ToolName != w.name {
					t.Errorf("call %d = %s %s, want %s %s", i, g.ToolUseID, g.ToolName, w.id, w.name)
				}
				if !reflect.DeepEqual(g.ToolInput, w.input) {
					t.Errorf("call %d (%s) input = %#v, want %#v", i, w.name, g.ToolInput, w.input)
				}
			}
		})
	}
}
