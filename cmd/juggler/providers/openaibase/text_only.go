//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"fmt"

	"juggler/cmd/juggler/providers/provider"
)

// withholdImages returns the messages a text-only model can be sent: every
// image part removed, and each message that carried one told so in its text.
//
// Images reach a request even when the composer refuses an attachment for a
// text-only model — a tool can return one (query_code's image(), read on a
// PNG), and a restored draft keeps its attachments. A text-only endpoint
// answers the whole request with a 400 rather than ignoring the part, and the
// image stays in the history, so without this every later turn fails too. The
// note is there so the model knows it has not seen what the tool rendered,
// rather than reasoning as if it had.
//
// Only applied for a model whose provider declares its input modalities and
// lists no image input; a provider that declares nothing is sent what it
// always was.
func withholdImages(messages []provider.Message, model string) []provider.Message {
	var out []provider.Message
	for i, msg := range messages {
		images := 0
		for _, part := range msg.Parts {
			if part.Type == "image" {
				images++
			}
		}
		if images == 0 {
			if out != nil {
				out = append(out, msg)
			}
			continue
		}
		if out == nil {
			out = append(make([]provider.Message, 0, len(messages)), messages[:i]...)
		}
		kept := make([]provider.MediaPart, 0, len(msg.Parts)-images)
		for _, part := range msg.Parts {
			if part.Type != "image" {
				kept = append(kept, part)
			}
		}
		note := fmt.Sprintf("[%d image(s) not sent: %s does not accept image input]", images, model)
		if msg.Content == "" {
			msg.Content = note
		} else {
			msg.Content += "\n\n" + note
		}
		msg.Parts = kept
		out = append(out, msg)
	}
	if out == nil {
		return messages
	}
	return out
}

// requestMessages is the history this client sends: as given, or with images
// withheld for a model declared text-only.
func (c *Client) requestMessages(req provider.MessageRequest) []provider.Message {
	if c.textOnly {
		return withholdImages(req.Messages, c.model)
	}
	return req.Messages
}
