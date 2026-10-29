//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"errors"

	"juggler/cmd/juggler/msg"
)

// Error and notice items keep their English in Content and Summary, which is
// what every reader that translates nothing shows, and carry beside it in Data
// the messages that English was rendered from, for the transcript to show
// translated (web/js/utils/item-text.js):
//
//   - "message" renders Content;
//   - "summaryMessage" renders Summary, on a notice, whose Summary is a sentence
//     of its own. An error's Summary is either its Content or the provider's
//     own text pulled out of it (extractErrorSummary), so it has none.
//
// Neither item reaches the model, so neither field does.

// errorText is the message err was rendered from, when the whole of its text
// is a *msg.Error's — nil for an error with text of its own around one, or
// none at all, whose text is then data.
func errorText(err error) *msg.Message {
	var me *msg.Error
	if errors.As(err, &me) && me.Error() == err.Error() {
		m := me.Message
		return &m
	}
	return nil
}

// setNoticeText gives a notice item its Summary and Content in English and the
// messages they render from, merged into whatever Data the item already holds.
func setNoticeText(item *ConversationItem, summary, content msg.Message) {
	item.Summary = summary.English()
	item.Content = content.English()
	data := map[string]any{}
	if len(item.Data) > 0 {
		_ = json.Unmarshal(item.Data, &data)
	}
	data[keySummaryMessage] = summary
	data[keyMessage] = content
	item.Data, _ = json.Marshal(data)
}

// yesNo is a boolean as the "yes"/"other" select a message template branches on.
func yesNo(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}
