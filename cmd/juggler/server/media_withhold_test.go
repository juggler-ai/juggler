//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"slices"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/provider"
)

func videoHistory() []provider.Message {
	return []provider.Message{{Type: "user", Content: "what breaks here?", Parts: []provider.MediaPart{
		{Type: provider.MediaTypeImage, AssetID: "shot"},
		{Type: provider.MediaTypeVideo, Mime: "video/quicktime", AssetID: "clip"},
	}}}
}

// A video reaches a model only when its provider declares it sends video:
// every other model — an unregistered provider included — gets a note in its
// place, and its images as before.
func TestWithholdUnsentMediaSendsVideoOnlyWhereTheProviderTakesIt(t *testing.T) {
	const plain, video = "media-test-plain", "media-test-video"
	factory := func(provider.Config) (provider.Provider, error) { return nil, nil }
	provider.RegisterProvider(provider.ProviderInfo{Name: plain}, factory)
	provider.RegisterProvider(provider.ProviderInfo{Name: video, VideoInput: func(model string) bool { return model == "watcher" }}, factory)
	t.Cleanup(func() { provider.UnregisterProvider(plain); provider.UnregisterProvider(video) })

	for _, c := range []struct{ provider, model string }{{plain, "m"}, {video, "reader"}, {"no-such-provider", "m"}} {
		got := withholdUnsentMedia(c.provider, c.model, videoHistory())
		if len(got[0].Parts) != 1 || got[0].Parts[0].Type != provider.MediaTypeImage {
			t.Errorf("%s/%s: parts %+v, want the image alone", c.provider, c.model, got[0].Parts)
		}
		if !strings.Contains(got[0].Content, "[1 video(s) not sent: "+c.model+" does not accept video input]") {
			t.Errorf("%s/%s: content %q, want the withheld note", c.provider, c.model, got[0].Content)
		}
	}
	if got := withholdUnsentMedia(video, "watcher", videoHistory()); len(got[0].Parts) != 2 || got[0].Content != "what breaks here?" {
		t.Errorf("a model whose provider takes video was sent %+v", got[0])
	}
}

// The published list is what the composer decides by, so a catalogue's
// "video" must not reach it for a provider that cannot send video.
func TestPublishedModelsOmitVideoTheProviderCannotSend(t *testing.T) {
	models := publishedModels(provider.ProviderInfo{Name: "p"},
		[]provider.ModelInfo{{ID: "m", InputModalities: []string{"image", "text", "video"}}}, core.GlobalSettings{})
	if len(models) != 1 || slices.Contains(models[0].InputModalities, "video") || !slices.Contains(models[0].InputModalities, "image") {
		t.Fatalf("published %+v, want image kept and video dropped", models)
	}
}
