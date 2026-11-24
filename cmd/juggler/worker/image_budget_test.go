//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"fmt"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// imageHistory is a conversation of user messages, each carrying one image of
// the given size whose AssetID names its position, then a text-only reply.
func imageHistory(sizes ...int) []provider.Message {
	var msgs []provider.Message
	for i, size := range sizes {
		msgs = append(msgs,
			provider.Message{Type: "user", Content: fmt.Sprintf("look at %d", i), Parts: []provider.MediaPart{
				{Type: "image", Mime: "image/jpeg", AssetID: fmt.Sprintf("img-%d", i), Data: make([]byte, size)},
			}},
			provider.Message{Type: "assistant", Content: "seen"},
		)
	}
	return msgs
}

// keptImages lists the AssetIDs still carried, in order.
func keptImages(msgs []provider.Message) []string {
	var ids []string
	for _, msg := range msgs {
		for _, part := range msg.Parts {
			ids = append(ids, part.AssetID)
		}
	}
	return ids
}

func imageBytes(msgs []provider.Message) int {
	total := 0
	for _, msg := range msgs {
		for _, part := range msg.Parts {
			total += len(part.Data)
		}
	}
	return total
}

func repeated(n, size int) []int {
	sizes := make([]int, n)
	for i := range sizes {
		sizes[i] = size
	}
	return sizes
}

const mib = 1 << 20

// Within budget, nothing changes.
func TestCapImagesForModelLeavesAnUnderBudgetRequestAlone(t *testing.T) {
	msgs := imageHistory(repeated(8, mib)...)
	CapImagesForModel(msgs)
	if got := len(keptImages(msgs)); got != 8 {
		t.Fatalf("kept %d images, want all 8", got)
	}
	for _, msg := range msgs {
		if strings.Contains(msg.Content, "image") {
			t.Fatalf("an under-budget request was annotated: %q", msg.Content)
		}
	}
}

// Over budget, the oldest images go, the request ends under budget, and the
// model is told in each message that lost one, so it neither invents what it
// can no longer see nor treats the message as having had none.
func TestCapImagesForModelDropsOldestAndSaysSo(t *testing.T) {
	msgs := imageHistory(repeated(9, mib)...)
	CapImagesForModel(msgs)

	if got := imageBytes(msgs); got > ModelImageByteBudget {
		t.Errorf("request carries %d image bytes, over the %d budget", got, ModelImageByteBudget)
	}
	want := []string{"img-4", "img-5", "img-6", "img-7", "img-8"}
	if got := keptImages(msgs); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("kept %v, want the newest %v", got, want)
	}
	for i := 0; i < 4; i++ {
		content := msgs[2*i].Content
		if !strings.HasPrefix(content, fmt.Sprintf("look at %d", i)) || !strings.Contains(content, "image") {
			t.Errorf("message %d lost its image without a note: %q", i, content)
		}
	}
	if content := msgs[8].Content; content != "look at 4" {
		t.Errorf("a message that kept its image was annotated: %q", content)
	}
}

// The cut moves in batches. Dropping an image rewrites the history before it,
// which costs the provider's cached prefix, so the cut must not creep forward
// by one image with every image sent: one more image after a cut leaves the
// same older images dropped, and the request still under budget.
func TestCapImagesForModelCutsInBatches(t *testing.T) {
	before := imageHistory(repeated(9, mib)...)
	CapImagesForModel(before)
	after := imageHistory(repeated(10, mib)...)
	CapImagesForModel(after)

	for i := range before {
		if before[i].Content != after[i].Content || len(before[i].Parts) != len(after[i].Parts) {
			t.Fatalf("message %d differs once one more image is sent (%q, %d images → %q, %d images): the cut crept",
				i, before[i].Content, len(before[i].Parts), after[i].Content, len(after[i].Parts))
		}
	}
	if got := imageBytes(after); got > ModelImageByteBudget {
		t.Errorf("request carries %d image bytes, over the %d budget", got, ModelImageByteBudget)
	}
}

// The newest message's images are what the user just asked about: they are
// sent even when they alone are over budget.
func TestCapImagesForModelKeepsTheNewestMessage(t *testing.T) {
	msgs := imageHistory(mib)
	msgs = append(msgs, provider.Message{Type: "user", Parts: []provider.MediaPart{
		{Type: "image", AssetID: "new-a", Data: make([]byte, 5*mib)},
		{Type: "image", AssetID: "new-b", Data: make([]byte, 5*mib)},
	}})
	CapImagesForModel(msgs)
	want := []string{"new-a", "new-b"}
	if got := keptImages(msgs); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("kept %v, want the newest message's %v", got, want)
	}
}

// Mid-turn, the newest messages are tool calls and results, but the images
// the user sent with the prompt that started the turn are still what the turn
// is about: everything from the latest user message on is kept.
func TestCapImagesForModelKeepsTheCurrentPromptThroughToolCalls(t *testing.T) {
	msgs := imageHistory(mib)
	msgs = append(msgs,
		provider.Message{Type: "user", Parts: []provider.MediaPart{
			{Type: "image", AssetID: "prompt-a", Data: make([]byte, 5*mib)},
			{Type: "image", AssetID: "prompt-b", Data: make([]byte, 5*mib)},
		}},
		provider.Message{Type: "tool-use", Content: "read"},
		provider.Message{Type: "tool-result", Content: "contents"},
	)
	CapImagesForModel(msgs)
	want := []string{"prompt-a", "prompt-b"}
	if got := keptImages(msgs); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("kept %v, want the current prompt's %v", got, want)
	}
}

// A video is not an image for this budget: a 60 MB recording early in the
// history neither pushes the images after it out nor is dropped itself.
func TestCapImagesForModelLeavesVideoOutOfTheImageBudget(t *testing.T) {
	msgs := []provider.Message{{Type: "user", Content: "watch", Parts: []provider.MediaPart{
		{Type: provider.MediaTypeVideo, AssetID: "clip", Data: make([]byte, 60*mib)},
	}}}
	msgs = append(msgs, imageHistory(repeated(4, mib)...)...)
	CapImagesForModel(msgs)
	want := []string{"clip", "img-0", "img-1", "img-2", "img-3"}
	if got := keptImages(msgs); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("kept %v, want %v", got, want)
	}
	if msgs[0].Content != "watch" {
		t.Errorf("the video's message was annotated: %q", msgs[0].Content)
	}
}

// Many small images are capped by count: Anthropic rejects a request with
// more than 100.
func TestCapImagesForModelCapsTheCount(t *testing.T) {
	msgs := imageHistory(repeated(101, 1024)...)
	CapImagesForModel(msgs)
	if got := len(keptImages(msgs)); got > ModelImageCountBudget {
		t.Errorf("kept %d images, over the %d budget", got, ModelImageCountBudget)
	}
}
