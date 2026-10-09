//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/userpaths/userpathstest"
)

// A tool that returns an image (read on a PNG) carries it as an image part on
// its tool-result message. These tests cover the claudecode paths that deliver
// a result without going through the anthropic message transform: the live MCP
// tools/call answer and the warm-append session entry. Either one dropping the
// part leaves the model reading "the image is attached below" with nothing
// attached.

var testPNG = []byte("\x89PNG\r\n\x1a\nfake-pixels")

func imageToolResultMsg(id, content string) provider.Message {
	m := toolResultMsg(id, content)
	m.Parts = []provider.MediaPart{
		{Type: "image", Mime: "image/png", AssetID: "asset-1", Data: testPNG, Width: 4, Height: 2},
		{Type: "image", Mime: "image/png", AssetID: "asset-missing"}, // unresolved: no bytes
	}
	return m
}

func TestExtractToolResults_CarriesImageParts(t *testing.T) {
	c := &Client{activeSession: &activeSession{pendingTools: []pendingToolMeta{{ID: "t1", Name: "read"}}}}
	results := c.extractToolResults([]provider.Message{imageToolResultMsg("t1", "Read image x.png")})
	if len(results) != 1 {
		t.Fatalf("got %d results, want 1", len(results))
	}
	parts := results[0].Parts
	if len(parts) == 0 || parts[0].Type != "image" || string(parts[0].Data) != string(testPNG) {
		t.Fatalf("result parts = %+v, want the message's image part with its bytes", parts)
	}
}

func TestControlProtocol_ToolResultImageReachesCLI(t *testing.T) {
	buf, cp := captureStdin()
	args := json.RawMessage(`{"file_path":"/x.png"}`)
	park(t, cp, "req-1", "1", "read", args)

	if _, err := cp.deliverNextToolResult(makeMCPMatchKey("read", args), &provider.ToolResult{
		ToolUseID:    "t1",
		Content:      "Read image /x.png. The image is attached below.",
		ResultStatus: provider.ResultStatusSuccess,
		Parts:        imageToolResultMsg("t1", "").Parts,
	}); err != nil {
		t.Fatalf("deliver: %v", err)
	}

	lines := readLines(t, buf)
	if len(lines) != 1 {
		t.Fatalf("got %d stdin lines, want 1", len(lines))
	}
	body := lines[0]["response"].(map[string]any)
	result := body["response"].(map[string]any)["mcp_response"].(map[string]any)["result"].(map[string]any)
	content := result["content"].([]any)
	if len(content) != 2 {
		t.Fatalf("tools/call content = %v, want [text, image] (the unresolved part skipped)", content)
	}
	text := content[0].(map[string]any)
	if text["type"] != "text" || text["text"] != "Read image /x.png. The image is attached below." {
		t.Errorf("content[0] = %v, want the tool's text", text)
	}
	img := content[1].(map[string]any)
	if img["type"] != "image" || img["mimeType"] != "image/png" || img["data"] != base64.StdEncoding.EncodeToString(testPNG) {
		t.Errorf("content[1] = %v, want an MCP image block carrying the PNG", img)
	}
	if _, has := img["text"]; has {
		t.Errorf("image block carries a text field: %v", img)
	}
}

func TestAppendToolResultsToWarmSession_NestsImageInToolResult(t *testing.T) {
	userpathstest.Isolate(t)
	workingDir := filepath.Join(t.TempDir(), "proj")
	if err := os.MkdirAll(workingDir, 0o755); err != nil {
		t.Fatalf("mkdir workingDir: %v", err)
	}
	const uuid = "uuid-warm-append-image"
	path := seedWarmSession(t, workingDir, uuid, "call_1")

	c := &Client{workingDir: workingDir, activeSession: &activeSession{sessionUUID: uuid}}
	if err := c.appendToolResultsToWarmSession([]provider.Message{imageToolResultMsg("call_1", "the answer")}, nil); err != nil {
		t.Fatalf("appendToolResultsToWarmSession: %v", err)
	}

	entries := readJSONL(t, path)
	msg, _ := entries[len(entries)-1]["message"].(map[string]any)
	blocks, _ := msg["content"].([]any)
	if len(blocks) != 1 {
		t.Fatalf("appended content = %v, want exactly one tool_result block", msg["content"])
	}
	block, _ := blocks[0].(map[string]any)
	if block["type"] != "tool_result" || block["tool_use_id"] != "call_1" {
		t.Fatalf("appended block = %v, want tool_result for call_1", block)
	}
	inner, ok := block["content"].([]any)
	if !ok || len(inner) != 2 {
		t.Fatalf("tool_result content = %v, want [text, image] (the unresolved part skipped)", block["content"])
	}
	text, _ := inner[0].(map[string]any)
	if text["type"] != "text" || text["text"] != "the answer" {
		t.Errorf("inner[0] = %v, want the tool's text", text)
	}
	img, _ := inner[1].(map[string]any)
	src, _ := img["source"].(map[string]any)
	if img["type"] != "image" || src["type"] != "base64" || src["media_type"] != "image/png" ||
		src["data"] != base64.StdEncoding.EncodeToString(testPNG) {
		t.Errorf("inner[1] = %v, want a base64 image block carrying the PNG", img)
	}
}
