//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"juggler/cmd/juggler/core"
)

// ImportedItem is one entry of an imported transcript, in a shape no agent in
// particular writes: whoever converts another tool's history into a Juggler
// conversation produces these, and BuildImportedConversation is the one place
// that knows how they become document items.
//
// Type is "user", "assistant", "thinking" or "tool-action". A tool-action is a
// whole call — ToolUseID, ToolName, ToolInput (a JSON object) and the text it
// returned in Result — because that is how the document holds one; the call
// and its result are never separate entries.
type ImportedItem struct {
	Type      string          `json:"type"`
	Content   string          `json:"content,omitempty"`
	Timestamp string          `json:"timestamp,omitempty"`
	ToolUseID string          `json:"toolUseId,omitempty"`
	ToolName  string          `json:"toolName,omitempty"`
	ToolInput json.RawMessage `json:"toolInput,omitempty"`
	Result    string          `json:"result,omitempty"`
	IsError   bool            `json:"isError,omitempty"`
}

// ImportedTranscript is a whole conversation to import. Created is when it
// began (RFC3339); Source is what a later import of the same transcript is
// recognised by.
type ImportedTranscript struct {
	Title   string            `json:"title"`
	Created string            `json:"created,omitempty"`
	Source  core.ImportSource `json:"source"`
	Items   []ImportedItem    `json:"items"`
}

// MaxImportedItems bounds one transcript, so a request cannot make the server
// build a document of any size it likes. It is far beyond any session a person
// works through by hand, which tops out in the low thousands of entries.
const MaxImportedItems = 20000

// MaxImportBytes bounds one import request: the transcript as JSON. Tool
// output makes a transcript far larger than its conversation reads; this is
// room for a long session's worth of it, and no more.
const MaxImportBytes = 64 << 20

// ImportPath is the session server's route that takes an ImportedTranscript
// (POST, one per request) and answers with an ImportAnswer: 201 for a new
// conversation, 200 for one imported before, 409 when the session has no
// room for another, 400 for a transcript Validate refuses.
const ImportPath = "/api/conversations/import"

// ImportAnswer is ImportPath's answer to a transcript it took. Existing marks
// a transcript imported before (same source kind, id and digest), whose
// conversation is ID; Name and Created are a new one's. Room is how many more
// conversations the session can take, so an importer can stop before the cap
// rather than at it.
type ImportAnswer struct {
	ID       string `json:"id"`
	Name     string `json:"name,omitempty"`
	Created  string `json:"created,omitempty"`
	Existing bool   `json:"existing,omitempty"`
	Room     int    `json:"room"`
}

// Validate reports the first thing that keeps t from becoming a conversation.
// Its errors are about the request, not the server, so a caller answers them
// with 400.
func (t ImportedTranscript) Validate() error {
	if !t.Source.Valid() {
		return errors.New("source needs a kind, an id and a digest")
	}
	if len(t.Items) > MaxImportedItems {
		return fmt.Errorf("a transcript may hold at most %d items", MaxImportedItems)
	}
	said := false
	seen := map[string]bool{}
	for i, it := range t.Items {
		switch it.Type {
		case ItemTypeUser:
			said = said || it.Content != ""
		case ItemTypeAssistant, ItemTypeThinking:
		case ItemTypeToolAction:
			if it.ToolUseID == "" || it.ToolName == "" {
				return fmt.Errorf("item %d: a tool-action needs a toolUseId and a toolName", i)
			}
			if seen[it.ToolUseID] {
				return fmt.Errorf("item %d: toolUseId %q is used twice", i, it.ToolUseID)
			}
			seen[it.ToolUseID] = true
			if in := bytes.TrimSpace(it.ToolInput); len(in) > 0 {
				var obj map[string]any
				if json.Unmarshal(in, &obj) != nil || obj == nil {
					return fmt.Errorf("item %d: toolInput must be a JSON object", i)
				}
			}
		default:
			return fmt.Errorf("item %d: unknown type %q", i, it.Type)
		}
	}
	if !said {
		return errors.New("a transcript needs at least one user message")
	}
	return nil
}

// BuildImportedConversation returns the document state of a new conversation
// holding t, ready to be written as its doc.yjs before anything can load it.
//
// What a conversation made in the browser would hold, it holds too, because a
// load adds none of it: the system-prompt item (SYSTEM_1, seeded only when a
// conversation is created), its created time and its default model. Every
// tool-action is completed — a call in any other state is one a load takes to
// be still in flight, and would run the turn again. The importedFrom marker is
// what the browser reads to seed the project's standing context (agents files,
// memory) at the first message, which history otherwise tells it was done
// long ago.
//
// Items get message ids (msg_…), never transaction ids: an id the engine does
// not recognise as a message is waited for as a context item, and a
// transaction id names a request blob this conversation never had.
func BuildImportedConversation(convID string, t ImportedTranscript, created string, model *core.ModelRef) ([]byte, error) {
	if err := t.Validate(); err != nil {
		return nil, err
	}
	doc := NewConversationDocument(convID, "server:import")
	defer doc.Destroy()

	sysData, _ := json.Marshal(map[string]any{keyText: "", keySelectedPresetID: "default", keyIsModified: false})
	items := make([]ConversationItem, 0, len(t.Items)+1)
	items = append(items, ConversationItem{
		Type:                ItemTypeSystemPrompt,
		ItemID:              "SYSTEM_1",
		Data:                sysData,
		PreventUserDeletion: true,
	})
	for _, it := range t.Items {
		item := ConversationItem{
			Type:      it.Type,
			ItemID:    generateItemID(),
			Content:   it.Content,
			Timestamp: importedTimestamp(it.Timestamp),
		}
		if it.Type == ItemTypeToolAction {
			input := bytes.TrimSpace(it.ToolInput)
			if len(input) == 0 {
				input = []byte("{}")
			}
			result, _ := json.Marshal(map[string]any{
				keyContent:    it.Result,
				keyIsError:    it.IsError,
				keyResultType: "action",
			})
			item.Content = ""
			item.ToolUseID = it.ToolUseID
			item.ToolName = it.ToolName
			item.ToolInput = input
			item.State = StateCompleted
			item.Result = result
		}
		items = append(items, item)
	}
	doc.AppendMessage(items...)

	if created == "" {
		created = time.Now().UTC().Format(time.RFC3339)
	}
	doc.SetMetadata(keyCreated, created)
	doc.SetMetadata(keyImportedFrom, map[string]any{
		keyKind:   t.Source.Kind,
		keyID:     t.Source.ID,
		keyDigest: t.Source.Digest,
	})
	if model != nil && model.Provider != "" && model.Model != "" {
		seed := map[string]any{keyProvider: model.Provider, keyModel: model.Model}
		if model.Thinking != "" {
			seed[keyThinking] = model.Thinking
		}
		if model.ServiceTier != "" {
			seed[keyServiceTier] = model.ServiceTier
		}
		doc.SetMetadata(keyDefaultModelConfig, seed)
	}
	return doc.ToState(), nil
}

// importedTimestamp is ts in the document's timestamp format, or "" when ts is
// not a time at all — an item with no timestamp shows none, which beats one
// that is wrong.
func importedTimestamp(ts string) string {
	if ts == "" {
		return ""
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if parsed, err := time.Parse(layout, ts); err == nil {
			return parsed.Format(time.RFC3339)
		}
	}
	return ""
}
