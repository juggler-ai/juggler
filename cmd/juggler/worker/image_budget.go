//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"fmt"

	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/jlog"
)

// ModelImageByteBudget is the most image bytes one request carries. Chat APIs
// are stateless, so every request resends every image in the conversation;
// without a cap a long image-heavy conversation grows each request until a
// provider (Anthropic: 32 MB) or a proxy in between refuses it, and uploads
// that much on every turn first. Base64 makes the wire size about 4/3 of this,
// leaving the rest of a provider's limit for text.
const ModelImageByteBudget = 8 << 20

// ModelImageCountBudget is the most images one request carries, under
// Anthropic's 100 per request.
const ModelImageCountBudget = 80

// The cut over each budget moves in steps of these, so it stays put while
// smaller amounts of new images arrive (see CapImagesForModel).
const (
	modelImageByteStep  = ModelImageByteBudget / 2
	modelImageCountStep = 20
)

// CapImagesForModel drops the oldest images in msgs until the request is
// within ModelImageByteBudget and ModelImageCountBudget, and appends a note to
// each message that lost any, so the model knows something was there. Images
// from the latest user message on are always kept: they are what the turn
// under way is about (currentPromptIndex).
//
// Dropping an image rewrites the history before it, which throws away the
// provider's cached prefix, so the cut must not creep forward an image at a
// time. Every image has a fixed position — the image bytes, and the image
// count, before it — and an image is dropped when it starts before the cut,
// a multiple of the step, just far enough in to bring the total within
// budget. The cut stays where it is until a step's worth of new images has
// arrived, and every request computes the same one from the same history,
// with nothing to remember between them.
func CapImagesForModel(msgs []provider.Message) {
	type position struct{ startByte, index int }
	var (
		positions  [][]position // per message, per part
		totalBytes int
		totalCount int
	)
	for _, msg := range msgs {
		parts := make([]position, len(msg.Parts))
		for j, part := range msg.Parts {
			if part.Type != provider.MediaTypeImage {
				// Only images are budgeted here: a video is far larger than the
				// image budget and is bounded at upload instead, so counting it
				// would push every image out of the request.
				parts[j] = position{startByte: -1}
				continue
			}
			parts[j] = position{startByte: totalBytes, index: totalCount}
			totalBytes += len(part.Data)
			totalCount++
		}
		positions = append(positions, parts)
	}
	byteCut := batchedCut(totalBytes, ModelImageByteBudget, modelImageByteStep)
	countCut := batchedCut(totalCount, ModelImageCountBudget, modelImageCountStep)
	if byteCut == 0 && countCut == 0 {
		return
	}

	droppedImages, droppedBytes := 0, 0
	for i := range currentPromptIndex(msgs) {
		msg := &msgs[i]
		kept := msg.Parts[:0:0]
		for j, part := range msg.Parts {
			at := positions[i][j]
			if at.startByte >= 0 && (at.startByte < byteCut || at.index < countCut) {
				droppedBytes += len(part.Data)
				continue
			}
			kept = append(kept, part)
		}
		dropped := len(msg.Parts) - len(kept)
		if dropped == 0 {
			continue
		}
		droppedImages += dropped
		msg.Parts = kept
		msg.Content = appendNote(msg.Content, droppedImageNote(dropped))
	}
	if droppedImages > 0 {
		jlog.Info("images: dropped the %d oldest (%d bytes) of %d (%d bytes) to keep the request within %d images and %d bytes",
			droppedImages, droppedBytes, totalCount, totalBytes, ModelImageCountBudget, ModelImageByteBudget)
	}
}

// currentPromptIndex is the index of the latest user message — the prompt the
// turn under way answers, followed by any tool calls and results since — or of
// the last message when there is none. Images from there on are never dropped.
func currentPromptIndex(msgs []provider.Message) int {
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Type == "user" {
			return i
		}
	}
	return max(0, len(msgs)-1)
}

// batchedCut is where to cut a total over budget: the smallest multiple of
// step that leaves at most budget after it, or 0 when the total is within it.
func batchedCut(total, budget, step int) int {
	if total <= budget {
		return 0
	}
	return (total - budget + step - 1) / step * step
}

// droppedImageNote is what the model reads in place of images dropped from a
// message.
func droppedImageNote(count int) string {
	if count == 1 {
		return "[An image attached here has been left out of this request to keep it within size limits. Ask the user to attach it again if you need to see it.]"
	}
	return fmt.Sprintf("[%d images attached here have been left out of this request to keep it within size limits. Ask the user to attach them again if you need to see them.]", count)
}

func appendNote(content, note string) string {
	if content == "" {
		return note
	}
	return content + "\n\n" + note
}
