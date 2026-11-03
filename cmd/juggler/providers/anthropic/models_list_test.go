//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package anthropic

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// apiModel is one Models API entry with limits and capabilities the static
// catalog could not have guessed for its id, so a matching ModelInfo proves the
// entry was read from the response.
func apiModel(id string, window, output int, images bool) string {
	return fmt.Sprintf(`{"type":"model","id":%q,"display_name":"Model %s","created_at":"2026-01-01T00:00:00Z",`+
		`"max_input_tokens":%d,"max_tokens":%d,"capabilities":{"image_input":{"supported":%t},"thinking":{"supported":false}}}`,
		id, id, window, output, images)
}

// modelsPage is a /v1/models response body.
func modelsPage(hasMore bool, entries ...string) string {
	idOf := func(entry string) string {
		var m struct{ ID string }
		_ = json.Unmarshal([]byte(entry), &m)
		return m.ID
	}
	first, last := "", ""
	if len(entries) > 0 {
		first, last = idOf(entries[0]), idOf(entries[len(entries)-1])
	}
	return fmt.Sprintf(`{"data":[%s],"has_more":%t,"first_id":%q,"last_id":%q}`,
		strings.Join(entries, ","), hasMore, first, last)
}

func modelIDs(infos []provider.ModelInfo) []string {
	ids := make([]string, len(infos))
	for i, m := range infos {
		ids[i] = m.ID
	}
	return ids
}

// TestListModelsWalksEveryPage: the Models API pages its catalog, so a list read
// from the first page alone silently drops every model past it. Each page is
// fetched by the previous page's last id, a model a proxy repeats across a page
// boundary is listed once, and the models from later pages carry their own
// metadata.
func TestListModelsWalksEveryPage(t *testing.T) {
	var queries []string
	c := respondingClient(func(r *http.Request) (*http.Response, error) {
		queries = append(queries, r.URL.RawQuery)
		switch r.URL.Query().Get("after_id") {
		case "":
			return statusResponse(r, 200, nil, modelsPage(true,
				apiModel("claude-zeta-9", 2000000, 64000, true),
				apiModel("claude-eta-9", 500000, 32000, false))), nil
		case "claude-eta-9":
			return statusResponse(r, 200, nil, modelsPage(false,
				apiModel("claude-eta-9", 1, 1, true),
				apiModel("claude-theta-9", 300000, 16000, true))), nil
		}
		return statusResponse(r, 400, nil, `{"type":"error","error":{"type":"invalid_request_error","message":"unknown cursor"}}`), nil
	})

	infos, err := c.ListModelsWithInfo(context.Background())
	if err != nil {
		t.Fatalf("ListModelsWithInfo: %v", err)
	}
	if got, want := modelIDs(infos), []string{"claude-zeta-9", "claude-eta-9", "claude-theta-9"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("models = %v, want %v (queries %v)", got, want, queries)
	}
	if len(queries) != 2 {
		t.Fatalf("made %d requests, want 2: %v", len(queries), queries)
	}
	if !strings.Contains(queries[0], "limit=1000") {
		t.Errorf("first request %q does not ask for the largest page", queries[0])
	}

	eta, theta := infos[1], infos[2]
	if eta.ContextWindow != 500000 || eta.MaxOutputTokens != 32000 || len(eta.InputModalities) != 0 {
		t.Errorf("repeated model took the later page's entry: %+v", eta)
	}
	if theta.ContextWindow != 300000 || theta.MaxOutputTokens != 16000 || !theta.FromAPI ||
		theta.DisplayName != "Model claude-theta-9" || len(theta.InputModalities) != 2 || len(theta.ThinkingLevels) != 0 {
		t.Errorf("second-page model lost its API metadata: %+v", theta)
	}
}

// TestListModelsFailsOnALaterPage: a page that fails makes the whole list fail,
// so the caller falls back to what it knew rather than believing a catalog with
// a hole in it.
func TestListModelsFailsOnALaterPage(t *testing.T) {
	c := respondingClient(func(r *http.Request) (*http.Response, error) {
		if r.URL.Query().Get("after_id") == "" {
			return statusResponse(r, 200, nil, modelsPage(true, apiModel("claude-zeta-9", 2000000, 64000, true))), nil
		}
		return statusResponse(r, 500, nil, `{"type":"error","error":{"type":"api_error","message":"Internal server error"}}`), nil
	})
	if infos, err := c.ListModelsWithInfo(context.Background()); err == nil {
		t.Fatalf("ListModelsWithInfo succeeded with %v, want the second page's error", modelIDs(infos))
	}
}

// TestListModelsStopsWhenCancelled: cancelling between pages ends the walk with
// the context's error instead of fetching the rest.
func TestListModelsStopsWhenCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	requests := 0
	c := respondingClient(func(r *http.Request) (*http.Response, error) {
		requests++
		if err := r.Context().Err(); err != nil {
			return nil, err
		}
		cancel()
		return statusResponse(r, 200, nil, modelsPage(true, apiModel(fmt.Sprintf("claude-page-%d", requests), 200000, 8000, false))), nil
	})
	_, err := c.ListModelsWithInfo(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if requests > 2 {
		t.Fatalf("made %d requests after cancellation", requests)
	}
}

// TestListModelsEndsWhenTheCursorIsIgnored: a proxy that ignores after_id and
// answers every request with the same page, still claiming more, would page
// forever. A page with nothing new on it is the end of the catalog.
func TestListModelsEndsWhenTheCursorIsIgnored(t *testing.T) {
	for _, hasMore := range []string{`"has_more":true,`, ""} {
		t.Run(fmt.Sprintf("has_more=%q", hasMore), func(t *testing.T) {
			requests := 0
			c := respondingClient(func(r *http.Request) (*http.Response, error) {
				requests++
				if requests > 10 {
					return nil, errors.New("still paging")
				}
				body := strings.Replace(modelsPage(true,
					apiModel("claude-zeta-9", 2000000, 64000, true),
					apiModel("claude-eta-9", 500000, 32000, false)), `"has_more":true,`, hasMore, 1)
				return statusResponse(r, 200, nil, body), nil
			})
			infos, err := c.ListModelsWithInfo(context.Background())
			if err != nil {
				t.Fatalf("ListModelsWithInfo: %v (after %d requests)", err, requests)
			}
			if got, want := modelIDs(infos), []string{"claude-zeta-9", "claude-eta-9"}; !reflect.DeepEqual(got, want) {
				t.Fatalf("models = %v, want %v", got, want)
			}
			if requests != 2 {
				t.Fatalf("made %d requests, want 2", requests)
			}
		})
	}
}
