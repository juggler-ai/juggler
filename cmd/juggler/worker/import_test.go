//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
)

func importFixture() ImportedTranscript {
	return ImportedTranscript{
		Title:   "Fix the build",
		Created: "2026-11-01T09:00:00.123Z",
		Source:  core.ImportSource{Kind: "claude-code", ID: "sess-1", Digest: "d1"},
		Items: []ImportedItem{
			{Type: ItemTypeUser, Content: "the build is broken", Timestamp: "2026-11-01T09:00:00.123Z"},
			{Type: ItemTypeThinking, Content: "look at the log first"},
			{Type: ItemTypeAssistant, Content: "Let me look."},
			{Type: ItemTypeToolAction, ToolUseID: "toolu_1", ToolName: "Bash", ToolInput: json.RawMessage(`{"command":"make"}`), Result: "error: x undefined", IsError: true},
			{Type: ItemTypeToolAction, ToolUseID: "toolu_2", ToolName: "Read", Result: "package x"},
			{Type: ItemTypeAssistant, Content: "Fixed."},
		},
	}
}

func loadImported(t *testing.T, state []byte) *ConversationDocument {
	t.Helper()
	doc := NewConversationDocument("conv_imp", "")
	t.Cleanup(doc.Destroy)
	if err := doc.LoadFromState(state); err != nil {
		t.Fatalf("load: %v", err)
	}
	return doc
}

// TestBuildImportedConversationHoldsWhatALoadNeeds pins what a load adds to
// nothing, so an imported document must carry itself: the system-prompt item
// first (seeded only at a browser create), created, the default model, the
// importedFrom marker the browser seeds standing context on — and every
// tool-action completed, since a load re-drives any call in another state.
func TestBuildImportedConversationHoldsWhatALoadNeeds(t *testing.T) {
	model := &core.ModelRef{Provider: "anthropic", Model: "claude-opus-4-5"}
	state, err := BuildImportedConversation("conv_imp", importFixture(), "2026-11-01T09:00:00Z", model)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	doc := loadImported(t, state)

	items := doc.GetItems()
	if len(items) != 7 {
		t.Fatalf("got %d items, want the system prompt + 6", len(items))
	}
	if items[0].ItemID != "SYSTEM_1" || items[0].Type != ItemTypeSystemPrompt || !items[0].PreventUserDeletion {
		t.Errorf("first item = %+v, want the SYSTEM_1 system-prompt placeholder", items[0])
	}
	for _, it := range items[1:] {
		if !strings.HasPrefix(it.ItemID, "msg_") {
			t.Errorf("item %q: id must be a message id, or the engine waits for it as a context item", it.ItemID)
		}
		if it.TransactionID != "" {
			t.Errorf("item %q carries transaction %q, which names no blob", it.ItemID, it.TransactionID)
		}
		if it.ProviderData != nil {
			t.Errorf("item %q carries providerData %v from another agent", it.ItemID, it.ProviderData)
		}
	}
	if items[1].Timestamp != "2026-11-01T09:00:00Z" {
		t.Errorf("user timestamp = %q, want it normalised to RFC3339", items[1].Timestamp)
	}

	bash, read := items[4], items[5]
	for _, ta := range []ConversationItem{bash, read} {
		if ta.State != StateCompleted {
			t.Errorf("%s state = %q, want completed — anything else is re-run on load", ta.ToolName, ta.State)
		}
	}
	var bashResult map[string]any
	if err := json.Unmarshal(bash.Result, &bashResult); err != nil {
		t.Fatalf("bash result: %v", err)
	}
	if bashResult["content"] != "error: x undefined" || bashResult["isError"] != true {
		t.Errorf("bash result = %v, want its text and isError", bashResult)
	}
	if string(read.ToolInput) != "{}" {
		t.Errorf("read toolInput = %s, want an empty object for a call that gave none", read.ToolInput)
	}

	if got := doc.GetMetadata(keyCreated); got != "2026-11-01T09:00:00Z" {
		t.Errorf("created = %v", got)
	}
	from, _ := doc.GetMetadata(keyImportedFrom).(map[string]any)
	if from["kind"] != "claude-code" || from["id"] != "sess-1" || from["digest"] != "d1" {
		t.Errorf("importedFrom = %v", doc.GetMetadata(keyImportedFrom))
	}
	dm, _ := doc.GetMetadata(keyDefaultModelConfig).(map[string]any)
	if dm[keyProvider] != "anthropic" || dm[keyModel] != "claude-opus-4-5" {
		t.Errorf("defaultModelConfig = %v", doc.GetMetadata(keyDefaultModelConfig))
	}
}

// TestImportedToolActionsReachTheWireAsPairs is what continuing an imported
// conversation rests on: each call goes to the model as a tool_use answered by
// its own tool_result, whatever agent's tool it was — a call with no answer, or
// an answer to no call, is a request every provider rejects.
func TestImportedToolActionsReachTheWireAsPairs(t *testing.T) {
	state, err := BuildImportedConversation("conv_imp", importFixture(), "", nil)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	doc := loadImported(t, state)
	w := NewConversationWorker("conv_imp", "user:test")
	defer w.doc.Destroy()

	wire := w.buildMessagesFromItems(doc.GetItems(), true)
	var kinds []string
	for _, m := range wire {
		kinds = append(kinds, m["type"].(string)+":"+stringOr(m["toolUseId"]))
	}
	got := strings.Join(kinds, " ")
	for _, want := range []string{
		"tool-use:toolu_1 tool-result:toolu_1",
		"tool-use:toolu_2 tool-result:toolu_2",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("wire %q lacks the pair %q", got, want)
		}
	}
	for _, m := range wire {
		if m["type"] == "tool-result" && m["toolUseId"] == "toolu_1" {
			if c, _ := m["content"].(string); !strings.Contains(c, "error: x undefined") {
				t.Errorf("toolu_1 result content = %v, want the imported output", m["content"])
			}
		}
	}
}

func stringOr(v any) string {
	s, _ := v.(string)
	return s
}

// TestImportedTranscriptValidate covers what makes a transcript unusable as a
// conversation, each answered before anything is created.
func TestImportedTranscriptValidate(t *testing.T) {
	for name, mutate := range map[string]func(*ImportedTranscript){
		"no source digest": func(t *ImportedTranscript) { t.Source.Digest = "" },
		"no user message": func(t *ImportedTranscript) {
			t.Items = []ImportedItem{{Type: ItemTypeAssistant, Content: "hi"}}
		},
		"unknown type":     func(t *ImportedTranscript) { t.Items[1].Type = "system-prompt" },
		"tool without id":  func(t *ImportedTranscript) { t.Items[3].ToolUseID = "" },
		"repeated tool id": func(t *ImportedTranscript) { t.Items[4].ToolUseID = "toolu_1" },
		"input not object": func(t *ImportedTranscript) { t.Items[3].ToolInput = json.RawMessage(`"make"`) },
	} {
		t.Run(name, func(t *testing.T) {
			tr := importFixture()
			mutate(&tr)
			if err := tr.Validate(); err == nil {
				t.Fatal("Validate accepted it")
			}
		})
	}
	if err := importFixture().Validate(); err != nil {
		t.Fatalf("the fixture itself: %v", err)
	}
}
