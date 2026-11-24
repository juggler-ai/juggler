//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package provider

import (
	"slices"
	"strings"
	"testing"
)

func TestWithholdVideoLeavesAVideoFreeHistoryUncopied(t *testing.T) {
	msgs := []Message{
		{Type: "user", Content: "look", Parts: []MediaPart{{Type: MediaTypeImage, AssetID: "a"}}},
		{Type: "assistant", Content: "ok"},
	}
	got := WithholdVideo(msgs, "m")
	if &got[0] != &msgs[0] {
		t.Fatal("a history with no video was copied")
	}
}

func TestWithholdVideoReplacesEachVideoWithANote(t *testing.T) {
	msgs := []Message{
		{Type: "user", Content: "first"},
		{Type: "user", Content: "what happens here?", Parts: []MediaPart{
			{Type: MediaTypeImage, AssetID: "img"},
			{Type: MediaTypeVideo, Mime: "video/quicktime", AssetID: "v1"},
			{Type: MediaTypeVideo, Mime: "video/mp4", AssetID: "v2"},
		}},
		{Type: "tool-result", Parts: []MediaPart{{Type: MediaTypeVideo, AssetID: "v3"}}},
	}
	got := WithholdVideo(msgs, "gpt-x")

	if len(got) != 3 || got[0].Content != "first" {
		t.Fatalf("messages = %+v, want all three kept in order", got)
	}
	if len(got[1].Parts) != 1 || got[1].Parts[0].Type != MediaTypeImage {
		t.Fatalf("parts = %+v, want only the image kept", got[1].Parts)
	}
	if want := "what happens here?\n\n[2 video(s) not sent: gpt-x does not accept video input]"; got[1].Content != want {
		t.Fatalf("content = %q, want %q", got[1].Content, want)
	}
	if len(got[2].Parts) != 0 || !strings.HasPrefix(got[2].Content, "[1 video(s) not sent") {
		t.Fatalf("tool result = %+v, want its video replaced by the note alone", got[2])
	}
	if len(msgs[1].Parts) != 3 || msgs[1].Content != "what happens here?" {
		t.Fatal("WithholdVideo modified the caller's messages")
	}
}

func TestPublishedInputModalitiesDropsVideoUnlessTheProviderTakesIt(t *testing.T) {
	catalogued := []string{"image", "text", "video"}

	if got := PublishedInputModalities(ProviderInfo{Name: "p"}, "m", catalogued); !slices.Equal(got, []string{"image", "text"}) {
		t.Fatalf("published %v for a provider that cannot send video, want the other modalities only", got)
	}
	takesVideo := ProviderInfo{Name: "v", VideoInput: func(model string) bool { return model == "vid" }}
	if got := PublishedInputModalities(takesVideo, "vid", catalogued); !slices.Equal(got, catalogued) {
		t.Fatalf("published %v for a model whose provider takes video, want %v", got, catalogued)
	}
	if got := PublishedInputModalities(takesVideo, "other", catalogued); slices.Contains(got, MediaTypeVideo) {
		t.Fatalf("published %v for a model the provider declines video for", got)
	}
}

func TestVideoIsChargedByItsSizeWithinBounds(t *testing.T) {
	cases := []struct {
		name  string
		bytes int
		want  int64
	}{
		{"unresolved", 0, minVideoTokenEstimate},
		{"tiny", 10, minVideoTokenEstimate},
		{"a two-minute screen recording", 60 << 20, (60 << 20) / videoBytesPerToken},
		{"huge", 1 << 30, maxVideoTokenEstimate},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			part := MediaPart{Type: MediaTypeVideo, Data: make([]byte, c.bytes)}
			if got := estimateVideoTokens64(part); got != c.want {
				t.Fatalf("estimate = %d, want %d", got, c.want)
			}
			if got := estimateImageTokens64(part); got != 0 {
				t.Fatalf("image estimate charged a video %d", got)
			}
		})
	}
	breakdown := EstimateMessageRequestTokenBreakdown(MessageRequest{Messages: []Message{{
		Type: "user", Parts: []MediaPart{{Type: MediaTypeVideo, Data: make([]byte, 60<<20)}},
	}}}, 0)
	if breakdown.ImageTokens != (60<<20)/videoBytesPerToken {
		t.Fatalf("admission media tokens = %d, want the video's estimate", breakdown.ImageTokens)
	}
}
