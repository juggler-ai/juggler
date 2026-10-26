//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// captureStdin records every line written to the "CLI" by the control
// protocol. Each line is a single JSON value followed by '\n'.
func captureStdin() (*bytes.Buffer, *controlProtocol) {
	buf := &bytes.Buffer{}
	return buf, newControlProtocol(buf)
}

type shortWriter struct{}

func (shortWriter) Write(p []byte) (int, error) { return len(p) - 1, nil }

func TestControlProtocolRejectsShortStdinWrite(t *testing.T) {
	cp := newControlProtocol(shortWriter{})
	defer cp.teardown()
	if err := cp.writeUserDelta([]byte("{}\n")); !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("writeUserDelta error = %v, want io.ErrShortWrite", err)
	}
}

// readLines pops every JSON object the dispatcher has emitted to its
// stdin buffer so tests can assert on them. Trailing newline-separated.
func readLines(t *testing.T, buf *bytes.Buffer) []map[string]any {
	t.Helper()
	out := []map[string]any{}
	for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("decode stdin line %q: %v", line, err)
		}
		out = append(out, m)
	}
	return out
}

func TestControlProtocol_SendInitializeWritesEnvelope(t *testing.T) {
	buf, cp := captureStdin()
	if err := cp.sendInitialize(); err != nil {
		t.Fatalf("sendInitialize: %v", err)
	}
	lines := readLines(t, buf)
	if len(lines) != 1 {
		t.Fatalf("expected one line, got %d", len(lines))
	}
	m := lines[0]
	if m["type"] != "control_request" {
		t.Errorf("type = %v, want control_request", m["type"])
	}
	if _, ok := m["request_id"].(string); !ok {
		t.Errorf("missing request_id")
	}
	req, _ := m["request"].(map[string]any)
	if req["subtype"] != "initialize" {
		t.Errorf("subtype = %v, want initialize", req["subtype"])
	}
}

func TestControlProtocol_MCPInitializeIsHandledSynchronously(t *testing.T) {
	buf, cp := captureStdin()

	mcpInit := JSONRPCMessage{JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: "initialize"}
	mcpInitBytes, _ := json.Marshal(mcpInit)

	msg := &StreamMessage{
		Type:      "control_request",
		RequestID: "req-mcp-init",
		Request: &ControlRequestBody{
			Subtype:    "mcp_message",
			ServerName: mcpServerName,
			Message:    mcpInitBytes,
		},
	}
	if err := cp.handleControlRequest(msg); err != nil {
		t.Fatalf("handleControlRequest: %v", err)
	}

	lines := readLines(t, buf)
	if len(lines) != 1 {
		t.Fatalf("expected one response, got %d", len(lines))
	}
	resp := lines[0]
	if resp["type"] != "control_response" {
		t.Fatalf("type = %v, want control_response", resp["type"])
	}
	respBody, _ := resp["response"].(map[string]any)
	if respBody["subtype"] != "success" {
		t.Errorf("subtype = %v, want success", respBody["subtype"])
	}
	if respBody["request_id"] != "req-mcp-init" {
		t.Errorf("request_id roundtrip lost: got %v", respBody["request_id"])
	}
	mcpResp, _ := respBody["response"].(map[string]any)
	innerRaw, _ := mcpResp["mcp_response"].(map[string]any)
	if innerRaw == nil {
		t.Fatalf("expected mcp_response inner envelope, got %+v", respBody["response"])
	}
	result, _ := innerRaw["result"].(map[string]any)
	if result["protocolVersion"] != "2024-11-05" {
		t.Errorf("protocolVersion = %v, want 2024-11-05", result["protocolVersion"])
	}
}

func TestControlProtocol_ToolsListReturnsConfiguredTools(t *testing.T) {
	buf, cp := captureStdin()
	cp.tools = func() ([]json.RawMessage, error) {
		return []json.RawMessage{
			json.RawMessage(`{"name":"mcp__juggler__bash","description":"run a shell command"}`),
		}, nil
	}

	listReq := JSONRPCMessage{JSONRPC: "2.0", ID: json.RawMessage(`7`), Method: "tools/list"}
	listReqBytes, _ := json.Marshal(listReq)

	if err := cp.handleControlRequest(&StreamMessage{
		Type:      "control_request",
		RequestID: "req-tools",
		Request: &ControlRequestBody{
			Subtype: "mcp_message",
			Message: listReqBytes,
		},
	}); err != nil {
		t.Fatalf("handleControlRequest: %v", err)
	}

	lines := readLines(t, buf)
	if len(lines) != 1 {
		t.Fatalf("expected one response, got %d", len(lines))
	}
	body := lines[0]["response"].(map[string]any)
	if body["subtype"] != "success" {
		t.Fatalf("subtype = %v, want success", body["subtype"])
	}
	wrapper := body["response"].(map[string]any)["mcp_response"].(map[string]any)
	result := wrapper["result"].(map[string]any)
	tools, _ := result["tools"].([]any)
	if len(tools) != 1 {
		t.Errorf("expected 1 tool advertised, got %d", len(tools))
	}
}

// TestToolDefsToMCPList_AdvertisesUnprefixedNames pins the lesson learned
// the hard way: the CLI prepends `mcp__<server-name>__` itself based on
// the --mcp-config server name when exposing tools to the LLM. Adding the
// prefix on our side too produces names like
// `mcp__juggler__mcp__juggler__bash` and the CLI reports "Unknown tool"
// when the LLM tries to call them.
func TestToolDefsToMCPList_AdvertisesUnprefixedNames(t *testing.T) {
	raws, err := toolDefsToMCPList([]provider.ToolDefinition{
		{Name: "bash", Description: "shell", InputSchema: json.RawMessage(`{"type":"object","properties":{}}`)},
		{Name: "read_file", Description: "read", InputSchema: json.RawMessage(`{"type":"object","properties":{}}`)},
	})
	if err != nil {
		t.Fatalf("toolDefsToMCPList: %v", err)
	}
	if len(raws) != 2 {
		t.Fatalf("expected 2 tools, got %d", len(raws))
	}
	for _, raw := range raws {
		var def map[string]any
		if err := json.Unmarshal(raw, &def); err != nil {
			t.Fatalf("decode: %v", err)
		}
		name, _ := def["name"].(string)
		if strings.HasPrefix(name, mcpToolPrefix) {
			t.Errorf("tool %q is prefixed with %q; CLI will double-prefix and reject", name, mcpToolPrefix)
		}
	}
}

// TestToolDefsToMCPList_WithholdsMalformedSchemas pins the blast radius of a
// bad schema. The consumer of tools/list refuses a malformed payload as a
// whole, so advertising one unusable schema costs the model every tool it has
// — a failure that surfaces far downstream as the model narrating tool calls
// in prose, naming neither the tool nor the fault. The malformed entry is
// dropped and the rest of the list still ships.
func TestToolDefsToMCPList_WithholdsMalformedSchemas(t *testing.T) {
	const good = `{"type":"object","properties":{"x":{"type":"string"}}}`
	raws, err := toolDefsToMCPList([]provider.ToolDefinition{
		{Name: "keeper", Description: "fine", InputSchema: json.RawMessage(good)},
		// The regression this guards: `type` dropped from an otherwise
		// complete schema. Still valid JSON, so nothing upstream objects.
		{Name: "no_type", Description: "bad", InputSchema: json.RawMessage(`{"properties":{"x":{"type":"string"}}}`)},
		{Name: "wrong_type", Description: "bad", InputSchema: json.RawMessage(`{"type":"string"}`)},
		{Name: "not_an_object", Description: "bad", InputSchema: json.RawMessage(`["nope"]`)},
		{Name: "absent", Description: "bad", InputSchema: nil},
	})
	if err != nil {
		t.Fatalf("toolDefsToMCPList: %v", err)
	}
	if len(raws) != 1 {
		t.Fatalf("expected only the well-formed tool to be advertised, got %d entries", len(raws))
	}
	var def map[string]any
	if err := json.Unmarshal(raws[0], &def); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if name, _ := def["name"].(string); name != "keeper" {
		t.Errorf("advertised tool = %q, want \"keeper\"", name)
	}
}

// TestValidateToolInputSchema_AcceptsNoArgTools guards the validator against
// over-reach: a tool with no parameters is legitimate, and withholding one
// would break a working tool in the name of tidiness.
func TestValidateToolInputSchema_AcceptsNoArgTools(t *testing.T) {
	for _, schema := range []string{
		`{"type":"object","properties":{}}`,
		`{"type":"object"}`,
	} {
		if reason := validateToolInputSchema(json.RawMessage(schema)); reason != "" {
			t.Errorf("schema %s rejected: %s", schema, reason)
		}
	}
}

// TestControlProtocol_ToolsCallDeferredUntilWorkerResponds: a CLI-side
// tools/call arrives, we record it as pending (no response yet), and only
// when deliverNextToolResult is called do we emit the control_response. Mirrors
// the production flow where the worker hands us the result on the next
// StreamMessage call.
func TestControlProtocol_ToolsCallDeferredUntilWorkerResponds(t *testing.T) {
	buf, cp := captureStdin()

	args := json.RawMessage(`{"cmd":"ls"}`)
	callParams, _ := json.Marshal(MCPToolsCallParams{Name: mcpToolPrefix + "bash", Arguments: args})
	jrpc := JSONRPCMessage{
		JSONRPC: "2.0", ID: json.RawMessage(`42`),
		Method: "tools/call", Params: callParams,
	}
	jrpcBytes, _ := json.Marshal(jrpc)

	if err := cp.handleControlRequest(&StreamMessage{
		Type:      "control_request",
		RequestID: "req-call",
		Request:   &ControlRequestBody{Subtype: "mcp_message", Message: jrpcBytes},
	}); err != nil {
		t.Fatalf("handleControlRequest: %v", err)
	}

	// No response written yet — the deferral is the whole point.
	if buf.Len() != 0 {
		t.Fatalf("expected no immediate response; stdin captured %q", buf.String())
	}

	// The worker hands us a tool-result for that call. Routing is FIFO:
	// this is the front (and only) parked call.
	ok, err := cp.deliverNextToolResult(makeMCPMatchKey("bash", args), &provider.ToolResult{
		ToolUseID: "t1", Content: "/home/jules", ResultStatus: provider.ResultStatusSuccess,
	})
	if err != nil {
		t.Fatalf("deliverNextToolResult: %v", err)
	}
	if !ok {
		t.Fatal("expected delivery to find matching pending call")
	}

	lines := readLines(t, buf)
	if len(lines) != 1 {
		t.Fatalf("expected one response, got %d", len(lines))
	}
	respBody := lines[0]["response"].(map[string]any)
	if respBody["request_id"] != "req-call" {
		t.Errorf("request_id roundtrip lost: got %v", respBody["request_id"])
	}
	wrapper := respBody["response"].(map[string]any)["mcp_response"].(map[string]any)
	result := wrapper["result"].(map[string]any)
	content, _ := result["content"].([]any)
	if len(content) == 0 {
		t.Fatalf("no content in result: %+v", result)
	}
	first := content[0].(map[string]any)
	if first["text"] != "/home/jules" {
		t.Errorf("content text = %v, want /home/jules", first["text"])
	}
}

// TestControlProtocol_ToolsCallsMatchedFIFOInOrder locks the consuming-FIFO
// contract: two tools/call envelopes parked in order are paired to results by
// FRONT-of-queue position. Production sorts results into pendingTools order
// (the same order the CLI parks its calls), so delivery is IN ORDER — the first
// result answers the first parked call, the second answers the second.
func TestControlProtocol_ToolsCallsMatchedFIFOInOrder(t *testing.T) {
	buf, cp := captureStdin()

	argsA := json.RawMessage(`{"cmd":"ls"}`)
	argsB := json.RawMessage(`{"cmd":"pwd"}`)

	enqueue := func(reqID, jrpcID string, args json.RawMessage) {
		t.Helper()
		params, _ := json.Marshal(MCPToolsCallParams{Name: mcpToolPrefix + "bash", Arguments: args})
		jrpc, _ := json.Marshal(JSONRPCMessage{JSONRPC: "2.0", ID: json.RawMessage(jrpcID), Method: "tools/call", Params: params})
		if err := cp.handleControlRequest(&StreamMessage{
			Type:      "control_request",
			RequestID: reqID,
			Request:   &ControlRequestBody{Subtype: "mcp_message", Message: jrpc},
		}); err != nil {
			t.Fatalf("handleControlRequest: %v", err)
		}
	}
	enqueue("req-A", "1", argsA) // front of queue
	enqueue("req-B", "2", argsB) // behind A

	// Deliver IN ORDER — A answers the front (req-A), then B answers req-B.
	if _, err := cp.deliverNextToolResult(makeMCPMatchKey("bash", argsA), &provider.ToolResult{
		ToolUseID: "tA", Content: "for A", ResultStatus: provider.ResultStatusSuccess,
	}); err != nil {
		t.Fatalf("deliver A: %v", err)
	}
	if _, err := cp.deliverNextToolResult(makeMCPMatchKey("bash", argsB), &provider.ToolResult{
		ToolUseID: "tB", Content: "for B", ResultStatus: provider.ResultStatusSuccess,
	}); err != nil {
		t.Fatalf("deliver B: %v", err)
	}

	lines := readLines(t, buf)
	if len(lines) != 2 {
		t.Fatalf("expected two responses, got %d", len(lines))
	}
	got := map[string]string{}
	for _, line := range lines {
		body := line["response"].(map[string]any)
		wrap := body["response"].(map[string]any)["mcp_response"].(map[string]any)
		result := wrap["result"].(map[string]any)
		content := result["content"].([]any)
		got[body["request_id"].(string)] = content[0].(map[string]any)["text"].(string)
	}
	if got["req-A"] != "for A" {
		t.Errorf("req-A got %q, want 'for A'", got["req-A"])
	}
	if got["req-B"] != "for B" {
		t.Errorf("req-B got %q, want 'for B'", got["req-B"])
	}
}

// recordPendingToolCall runs recordPendingToolCallLocked on the actor goroutine.
// Production dispatch already runs on the actor and calls the Locked form
// directly; this wrapper exists only so tests can park a call from outside.
func (cp *controlProtocol) recordPendingToolCall(requestID string, jrpc JSONRPCMessage) error {
	var err error
	cp.runOnActor(func() { err = cp.recordPendingToolCallLocked(requestID, jrpc) })
	return err
}

// TestControlProtocol_DeliverToolResultStashesWhenCallNotYetParked locks
// in the result-before-call race: when the worker hands us a result for a
// position whose tools/call hasn't arrived yet, we stash it in FIFO order and let
// the eventual recordPendingToolCall drain it, rather than dropping it and
// hanging the CLI on a request we'd never answer.
func TestControlProtocol_DeliverToolResultStashesWhenCallNotYetParked(t *testing.T) {
	buf, cp := captureStdin()

	ok, err := cp.deliverNextToolResult(makeMCPMatchKey("bash", json.RawMessage(`{"cmd":"ls"}`)), &provider.ToolResult{
		ToolUseID: "early", Content: "out", ResultStatus: provider.ResultStatusSuccess,
	})
	if err != nil {
		t.Fatalf("deliverNextToolResult: %v", err)
	}
	if !ok {
		t.Errorf("expected ok=true (stashed) for early delivery")
	}
	if buf.Len() != 0 {
		t.Errorf("expected no response written yet (stashed, not delivered), got %q", buf.String())
	}

	// Now the CLI emits the matching tools/call; the stashed result must
	// flush as a control_response with the right jsonrpc id.
	if err := cp.recordPendingToolCall("req-late", JSONRPCMessage{
		JSONRPC: "2.0",
		ID:      json.RawMessage(`42`),
		Method:  "tools/call",
		Params:  json.RawMessage(`{"name":"bash","arguments":{"cmd":"ls"}}`),
	}); err != nil {
		t.Fatalf("recordPendingToolCall: %v", err)
	}
	if buf.Len() == 0 {
		t.Fatalf("expected stashed result to flush on matching tools/call")
	}
	if !strings.Contains(buf.String(), `"request_id":"req-late"`) {
		t.Errorf("response missing request_id=req-late: %s", buf.String())
	}
}

// TestControlProtocol_IdentityRoutingAnswersMatchingParkedCall is the
// regression for the warm-session "+1 shift" corruption: two calls are parked
// (A then B) and the worker delivers B's result FIRST. Pure positional routing
// answered the front (A) with B's result, permanently shifting every later
// pairing so each tool received the PREVIOUS tool's output. Identity routing
// must answer B's call with B's result regardless of queue position, leaving
// A's call to be answered by A's result.
func TestControlProtocol_IdentityRoutingAnswersMatchingParkedCall(t *testing.T) {
	buf, cp := captureStdin()

	argsA := json.RawMessage(`{"command":"echo A"}`)
	argsB := json.RawMessage(`{"command":"echo B"}`)
	park := func(reqID, jrpcID string, args json.RawMessage) {
		t.Helper()
		params, _ := json.Marshal(MCPToolsCallParams{Name: mcpToolPrefix + "bash", Arguments: args})
		jrpc, _ := json.Marshal(JSONRPCMessage{JSONRPC: "2.0", ID: json.RawMessage(jrpcID), Method: "tools/call", Params: params})
		if err := cp.handleControlRequest(&StreamMessage{
			Type: "control_request", RequestID: reqID,
			Request: &ControlRequestBody{Subtype: "mcp_message", Message: jrpc},
		}); err != nil {
			t.Fatalf("park %s: %v", reqID, err)
		}
	}
	park("req-A", "1", argsA) // front of queue
	park("req-B", "2", argsB) // behind A

	// Deliver B FIRST. Identity must route B's result to req-B, not the front.
	if _, err := cp.deliverNextToolResult(makeMCPMatchKey("bash", argsB), &provider.ToolResult{
		ToolUseID: "tB", Content: "result-for-B", ResultStatus: provider.ResultStatusSuccess,
	}); err != nil {
		t.Fatalf("deliver B: %v", err)
	}
	if _, err := cp.deliverNextToolResult(makeMCPMatchKey("bash", argsA), &provider.ToolResult{
		ToolUseID: "tA", Content: "result-for-A", ResultStatus: provider.ResultStatusSuccess,
	}); err != nil {
		t.Fatalf("deliver A: %v", err)
	}

	got := map[string]string{}
	for _, line := range readLines(t, buf) {
		body := line["response"].(map[string]any)
		wrap := body["response"].(map[string]any)["mcp_response"].(map[string]any)
		result := wrap["result"].(map[string]any)
		content := result["content"].([]any)
		got[body["request_id"].(string)] = content[0].(map[string]any)["text"].(string)
	}
	if got["req-B"] != "result-for-B" {
		t.Errorf("req-B got %q, want result-for-B — out-of-order delivery crossed onto the front call", got["req-B"])
	}
	if got["req-A"] != "result-for-A" {
		t.Errorf("req-A got %q, want result-for-A", got["req-A"])
	}
}

// TestControlProtocol_IdentityRoutingDrainsMatchingStash is the record-side
// mirror: two results are stashed (the result-before-call race) and the calls
// then park in a DIFFERENT order. Each parking call must drain the stash whose
// key matches it, not the front-of-FIFO stash.
func TestControlProtocol_IdentityRoutingDrainsMatchingStash(t *testing.T) {
	buf, cp := captureStdin()

	argsA := json.RawMessage(`{"command":"echo A"}`)
	argsB := json.RawMessage(`{"command":"echo B"}`)

	// Stash A then B (neither call parked yet).
	if _, err := cp.deliverNextToolResult(makeMCPMatchKey("bash", argsA), &provider.ToolResult{
		ToolUseID: "tA", Content: "result-for-A", ResultStatus: provider.ResultStatusSuccess,
	}); err != nil {
		t.Fatalf("stash A: %v", err)
	}
	if _, err := cp.deliverNextToolResult(makeMCPMatchKey("bash", argsB), &provider.ToolResult{
		ToolUseID: "tB", Content: "result-for-B", ResultStatus: provider.ResultStatusSuccess,
	}); err != nil {
		t.Fatalf("stash B: %v", err)
	}
	if buf.Len() != 0 {
		t.Fatalf("expected both results stashed; stdin captured %q", buf.String())
	}

	// B's call parks FIRST — it must drain B's stash, not A's (front).
	park := func(reqID, jrpcID string, args json.RawMessage) {
		t.Helper()
		params, _ := json.Marshal(MCPToolsCallParams{Name: mcpToolPrefix + "bash", Arguments: args})
		jrpc, _ := json.Marshal(JSONRPCMessage{JSONRPC: "2.0", ID: json.RawMessage(jrpcID), Method: "tools/call", Params: params})
		if err := cp.handleControlRequest(&StreamMessage{
			Type: "control_request", RequestID: reqID,
			Request: &ControlRequestBody{Subtype: "mcp_message", Message: jrpc},
		}); err != nil {
			t.Fatalf("park %s: %v", reqID, err)
		}
	}
	park("req-B", "2", argsB)
	park("req-A", "1", argsA)

	got := map[string]string{}
	for _, line := range readLines(t, buf) {
		body := line["response"].(map[string]any)
		wrap := body["response"].(map[string]any)["mcp_response"].(map[string]any)
		result := wrap["result"].(map[string]any)
		content := result["content"].([]any)
		got[body["request_id"].(string)] = content[0].(map[string]any)["text"].(string)
	}
	if got["req-B"] != "result-for-B" {
		t.Errorf("req-B got %q, want result-for-B — parking call drained the wrong (front) stash", got["req-B"])
	}
	if got["req-A"] != "result-for-A" {
		t.Errorf("req-A got %q, want result-for-A", got["req-A"])
	}
}

// park drives the tools/call control_request — the only thing the CLI sends for
// a tool invocation (the wire frame carries no tool_use_id). Results route to it
// by (name+args) key, FIFO among same-key, with a same-tool-name fallback.
func park(t *testing.T, cp *controlProtocol, reqID, jrpcID, toolName string, args json.RawMessage) {
	t.Helper()
	params, _ := json.Marshal(MCPToolsCallParams{Name: mcpToolPrefix + toolName, Arguments: args})
	jrpc, _ := json.Marshal(JSONRPCMessage{JSONRPC: "2.0", ID: json.RawMessage(jrpcID), Method: "tools/call", Params: params})
	if err := cp.handleControlRequest(&StreamMessage{
		Type: "control_request", RequestID: reqID,
		Request: &ControlRequestBody{Subtype: "mcp_message", Message: jrpc},
	}); err != nil {
		t.Fatalf("park %s: %v", reqID, err)
	}
}

func collectAnswers(t *testing.T, buf *bytes.Buffer) map[string]string {
	t.Helper()
	got := map[string]string{}
	for _, line := range readLines(t, buf) {
		body := line["response"].(map[string]any)
		wrap := body["response"].(map[string]any)["mcp_response"].(map[string]any)
		result := wrap["result"].(map[string]any)
		content := result["content"].([]any)
		got[body["request_id"].(string)] = content[0].(map[string]any)["text"].(string)
	}
	return got
}

// TestControlProtocol_DuplicateArgsPairInFIFOOrder covers two tool calls with an
// IDENTICAL (name+args) in one turn. The (name+args) key cannot tell them apart,
// so they pair by FIFO arrival order — which is CORRECT because the worker feeds
// results in pendingTools (stream) order and the CLI parks in that same order.
// The first result answers the first parked call, the second answers the second.
func TestControlProtocol_DuplicateArgsPairInFIFOOrder(t *testing.T) {
	buf, cp := captureStdin()
	args := json.RawMessage(`{"command":"date"}`) // identical for BOTH calls
	park(t, cp, "req-A", "1", "bash", args)
	park(t, cp, "req-B", "2", "bash", args)

	// Fed in pendingTools order: A's result first, then B's.
	if _, err := cp.deliverNextToolResult(makeMCPMatchKey("bash", args), &provider.ToolResult{ToolUseID: "u-A", Content: "RESULT-A", ResultStatus: provider.ResultStatusSuccess}); err != nil {
		t.Fatalf("deliver: %v", err)
	}
	if _, err := cp.deliverNextToolResult(makeMCPMatchKey("bash", args), &provider.ToolResult{ToolUseID: "u-B", Content: "RESULT-B", ResultStatus: provider.ResultStatusSuccess}); err != nil {
		t.Fatalf("deliver: %v", err)
	}

	got := collectAnswers(t, buf)
	if got["req-A"] != "RESULT-A" {
		t.Errorf("req-A got %q, want RESULT-A — identical-args calls must pair in FIFO order", got["req-A"])
	}
	if got["req-B"] != "RESULT-B" {
		t.Errorf("req-B got %q, want RESULT-B — identical-args calls must pair in FIFO order", got["req-B"])
	}
}

// TestControlProtocol_ArgDriftDeliversToSameToolName is the unit mirror of
// TestContinueSession_DeliversAcrossArgDivergence: a result whose (name+args) key
// does NOT match the parked call's key (args re-serialised to different bytes
// across a resume/restart) must still be delivered to the parked call of the SAME
// tool, so the CLI — blocked on stdin with no transport timeout — never hangs.
func TestControlProtocol_ArgDriftDeliversToSameToolName(t *testing.T) {
	buf, cp := captureStdin()
	park(t, cp, "req-bash", "1", "bash", json.RawMessage(`{"command":"echo A"}`))

	if _, err := cp.deliverNextToolResult(makeMCPMatchKey("bash", json.RawMessage(`{"command":"echo B-different"}`)), &provider.ToolResult{
		ToolUseID: "u-bash", Content: "OUT", ResultStatus: provider.ResultStatusSuccess,
	}); err != nil {
		t.Fatalf("deliver: %v", err)
	}
	if got := collectAnswers(t, buf); got["req-bash"] != "OUT" {
		t.Errorf("req-bash got %q, want OUT — an arg-drifted result must still reach the same-tool parked call", got["req-bash"])
	}
}

// TestControlProtocol_StashedForeignResultDoesNotCrossOnPark is the park-side
// mirror of TestControlProtocol_NeverCrossDeliversAcrossToolTypes: an `edit`
// result is stashed, then a `bash` call parks. The bash call must NOT drain the
// edit stash (cross-type corruption) — it parks and waits for its own result.
func TestControlProtocol_StashedForeignResultDoesNotCrossOnPark(t *testing.T) {
	buf, cp := captureStdin()

	if _, err := cp.deliverNextToolResult(makeMCPMatchKey("edit", json.RawMessage(`{"file_path":"x"}`)), &provider.ToolResult{
		ToolUseID: "u-edit", Content: "EDIT-OUT", ResultStatus: provider.ResultStatusSuccess,
	}); err != nil {
		t.Fatalf("stash edit: %v", err)
	}
	park(t, cp, "req-bash", "1", "bash", json.RawMessage(`{"command":"ls"}`))
	if got := collectAnswers(t, buf); len(got) != 0 {
		t.Fatalf("bash call drained a foreign edit stash %v — a parking call must never absorb a different tool's result", got)
	}

	// Its own result then arrives and is delivered correctly.
	if _, err := cp.deliverNextToolResult(makeMCPMatchKey("bash", json.RawMessage(`{"command":"ls"}`)), &provider.ToolResult{
		ToolUseID: "u-bash", Content: "BASH-OUT", ResultStatus: provider.ResultStatusSuccess,
	}); err != nil {
		t.Fatalf("deliver bash: %v", err)
	}
	if got := collectAnswers(t, buf); got["req-bash"] != "BASH-OUT" {
		t.Errorf("req-bash got %q, want BASH-OUT", got["req-bash"])
	}
}

// TestControlProtocol_NeverCrossDeliversAcrossToolTypes is the regression for
// the recurring silent corruption: a tool result routed to a call of a DIFFERENT
// tool. The worker executes tools off the STREAM, so a result routinely arrives
// and is stashed BEFORE its own tools/call parks. Here an `edit` result is
// stashed; then a `read` of a different file parks carrying no bound id (its
// streamed id was dropped at a message boundary — the production reality). The
// read must NEVER be answered with the edit's result; a result may only reach a
// call of the SAME tool. Crossing tool types is silent corruption (an agent
// reasons on, or re-runs, the wrong output) and is the dangerous failure mode.
func TestControlProtocol_NeverCrossDeliversAcrossToolTypes(t *testing.T) {
	buf, cp := captureStdin()

	editArgs := json.RawMessage(`{"file_path":"input-box.js","old_string":"a","new_string":"b"}`)
	if _, err := cp.deliverNextToolResult(makeMCPMatchKey("edit", editArgs), &provider.ToolResult{
		ToolUseID: "u-edit", Content: "Search failed in 'input-box.js'.", ResultStatus: provider.ResultStatusError,
	}); err != nil {
		t.Fatalf("stash edit result: %v", err)
	}

	readArgs := json.RawMessage(`{"file_path":"conversation-tab.js","offset":559}`)
	params, _ := json.Marshal(MCPToolsCallParams{Name: mcpToolPrefix + "read", Arguments: readArgs})
	jrpc, _ := json.Marshal(JSONRPCMessage{JSONRPC: "2.0", ID: json.RawMessage(`3`), Method: "tools/call", Params: params})
	if err := cp.handleControlRequest(&StreamMessage{
		Type: "control_request", RequestID: "req-read",
		Request: &ControlRequestBody{Subtype: "mcp_message", Message: jrpc},
	}); err != nil {
		t.Fatalf("park read call: %v", err)
	}

	if got := collectAnswers(t, buf); len(got) != 0 {
		t.Fatalf("read call was cross-delivered a foreign result %v — a result must only reach a same-tool call; the read must stay parked until its own read result arrives", got)
	}
}

func TestControlProtocol_ControlResponseRoutesToPendingOut(t *testing.T) {
	buf, cp := captureStdin()
	// Plant a pending outbound channel and feed a matching response.
	// pendingOut is actor-owned, so install it on the actor goroutine.
	resp := make(chan *ControlResponseBody, 1)
	cp.runOnActor(func() { cp.pendingOut["req-X"] = resp })
	_ = buf

	cp.handleControlResponse(&StreamMessage{
		Type: "control_response",
		Response: &ControlResponseBody{
			Subtype:   "success",
			RequestID: "req-X",
		},
	})

	select {
	case got := <-resp:
		if got.RequestID != "req-X" {
			t.Errorf("RequestID = %q, want req-X", got.RequestID)
		}
	default:
		t.Fatal("expected response to be delivered")
	}
	var still bool
	cp.runOnActor(func() { _, still = cp.pendingOut["req-X"] })
	if still {
		t.Errorf("pendingOut should be cleared after delivery")
	}
}

func TestControlProtocol_TeardownReleasesPendingOut(t *testing.T) {
	_, cp := captureStdin()
	resp := make(chan *ControlResponseBody, 1)
	cp.runOnActor(func() { cp.pendingOut["req-Y"] = resp })

	cp.teardown()

	select {
	case got, ok := <-resp:
		if ok && got != nil {
			t.Errorf("teardown should close channels, got %+v", got)
		}
	default:
		t.Fatal("teardown should have closed the pending channel")
	}
}

// TestControlProtocol_TeardownAbandonsParkedToolsCall locks the rule that
// teardown answers nothing: a tools/call still parked when the session goes down
// is dropped without a synthetic result on stdin.
//
// The CLI blocks on stdin with no transport timeout, but it is not left hanging
// on our response — tearDownLiveCLI closes stdin the moment teardown returns and
// SIGKILLs whatever survives teardownGracePeriod. A synthetic result, by
// contrast, is one the CLI journals into its own session file, displacing the
// dangling assistant tool_use warm-append resumes from and cold-starting an
// otherwise warm conversation. Regression for the ~70k-token cache miss on
// approving a tool call parked across a restart.
func TestControlProtocol_TeardownAbandonsParkedToolsCall(t *testing.T) {
	buf, cp := captureStdin()

	args := json.RawMessage(`{"cmd":"ls"}`)
	params, _ := json.Marshal(MCPToolsCallParams{Name: mcpToolPrefix + "bash", Arguments: args})
	jrpc, _ := json.Marshal(JSONRPCMessage{JSONRPC: "2.0", ID: json.RawMessage(`7`), Method: "tools/call", Params: params})
	if err := cp.handleControlRequest(&StreamMessage{
		Type:      "control_request",
		RequestID: "req-parked",
		Request:   &ControlRequestBody{Subtype: "mcp_message", Message: jrpc},
	}); err != nil {
		t.Fatalf("handleControlRequest: %v", err)
	}
	// Deferred — nothing written yet (no result ever delivered).
	if buf.Len() != 0 {
		t.Fatalf("expected the call to be parked; stdin captured %q", buf.String())
	}

	cp.teardown()

	// The actor has exited, so reading the maps directly here is race-free.
	if buf.Len() != 0 {
		t.Fatalf("teardown wrote to stdin; the CLI would journal it into its session file and cold-start the next resume: %q", buf.String())
	}
	if len(cp.parkedCalls) != 0 {
		t.Fatalf("teardown left %d parked call(s) behind", len(cp.parkedCalls))
	}
}

// TestControlProtocol_CrossTurnDelivery is the regression for the cross-turn
// coordinate desync: in a warm session, turn 1 parks+answers one call, then
// turn 2 parks another. Because answered calls are consumed (removed) from the
// queue, turn 2's call must be answered too — not dropped as a duplicate of
// turn 1's already-answered slot 0 (the "index=0 already answered" hang).
func TestControlProtocol_CrossTurnDelivery(t *testing.T) {
	buf, cp := captureStdin()

	park := func(reqID, jrpcID, cmd string) {
		t.Helper()
		params, _ := json.Marshal(MCPToolsCallParams{Name: mcpToolPrefix + "bash", Arguments: json.RawMessage(`{"command":"` + cmd + `"}`)})
		jrpc, _ := json.Marshal(JSONRPCMessage{JSONRPC: "2.0", ID: json.RawMessage(jrpcID), Method: "tools/call", Params: params})
		if err := cp.handleControlRequest(&StreamMessage{
			Type: "control_request", RequestID: reqID,
			Request: &ControlRequestBody{Subtype: "mcp_message", Message: jrpc},
		}); err != nil {
			t.Fatalf("park %s: %v", reqID, err)
		}
	}

	// Turn 1: park then answer.
	park("req-turn1", "1", "ls")
	if _, err := cp.deliverNextToolResult(makeMCPMatchKey("bash", json.RawMessage(`{"command":"ls"}`)), &provider.ToolResult{ToolUseID: "t1", Content: "turn1 out", ResultStatus: provider.ResultStatusSuccess}); err != nil {
		t.Fatalf("deliver turn1: %v", err)
	}
	// Turn 2: a fresh per-turn pendingTools (re-numbered from 0). The call parks
	// at session slot 1; the consuming queue must still answer it.
	park("req-turn2", "2", "pwd")
	if _, err := cp.deliverNextToolResult(makeMCPMatchKey("bash", json.RawMessage(`{"command":"pwd"}`)), &provider.ToolResult{ToolUseID: "t2", Content: "turn2 out", ResultStatus: provider.ResultStatusSuccess}); err != nil {
		t.Fatalf("deliver turn2: %v", err)
	}

	s := buf.String()
	if !strings.Contains(s, `"request_id":"req-turn1"`) || !strings.Contains(s, "turn1 out") {
		t.Errorf("turn1 call not answered: %s", s)
	}
	if !strings.Contains(s, `"request_id":"req-turn2"`) || !strings.Contains(s, "turn2 out") {
		t.Fatalf("turn2 call was NOT answered — the cross-turn hang regressed: %s", s)
	}
}

// TestControlProtocol_DiscardStaleBuffersDropsOrphanStash is the regression for
// the cross-turn STALE-delivery corruption (the "results are stale" report): a
// worker result that was stashed but never claimed by a tools/call (an orphan)
// must NOT survive the turn boundary. If it does, a later same-tool call in a
// future turn drains it via the name fallback and the model reasons on a result
// from a completely different call. discardStaleBuffers (called at end_turn)
// drops the orphan so the next turn's call parks cleanly and waits for its own
// result instead of absorbing the stale one.
func TestControlProtocol_DiscardStaleBuffersDropsOrphanStash(t *testing.T) {
	buf, cp := captureStdin()

	// Turn 1 leaves an orphan: a read result arrives whose tools/call never
	// parks (the production shape — worker fed a result the CLI never asked
	// for), so it sits in the stash.
	orphanArgs := json.RawMessage(`{"file_path":"/turn1/stale.go"}`)
	if _, err := cp.deliverNextToolResult(makeMCPMatchKey("read", orphanArgs), &provider.ToolResult{
		ToolUseID: "orphan", Content: "STALE TURN-1 OUTPUT", ResultStatus: provider.ResultStatusSuccess,
	}); err != nil {
		t.Fatalf("stash orphan: %v", err)
	}
	if buf.Len() != 0 {
		t.Fatalf("orphan result should stash silently, not answer; stdin=%q", buf.String())
	}

	// Turn boundary: the orphan must be discarded.
	stashed, parked := cp.discardStaleBuffers()
	if stashed != 1 || parked != 0 {
		t.Fatalf("discardStaleBuffers cleared (stashed=%d, parked=%d), want (1, 0)", stashed, parked)
	}

	// Turn 2: a DIFFERENT read parks. With the orphan gone it must wait for its
	// own result — never get answered from the dropped stale stash.
	nextArgs := json.RawMessage(`{"file_path":"/turn2/fresh.go"}`)
	params, _ := json.Marshal(MCPToolsCallParams{Name: mcpToolPrefix + "read", Arguments: nextArgs})
	jrpc, _ := json.Marshal(JSONRPCMessage{JSONRPC: "2.0", ID: json.RawMessage(`9`), Method: "tools/call", Params: params})
	if err := cp.handleControlRequest(&StreamMessage{
		Type:      "control_request",
		RequestID: "req-turn2-read",
		Request:   &ControlRequestBody{Subtype: "mcp_message", Message: jrpc},
	}); err != nil {
		t.Fatalf("park turn2 read: %v", err)
	}
	if buf.Len() != 0 {
		t.Fatalf("turn2 read was answered from a stale cross-turn orphan (the corruption); stdin=%q", buf.String())
	}

	// And it is answerable by its OWN result, proving it merely parked.
	if _, err := cp.deliverNextToolResult(makeMCPMatchKey("read", nextArgs), &provider.ToolResult{
		ToolUseID: "fresh", Content: "FRESH TURN-2 OUTPUT", ResultStatus: provider.ResultStatusSuccess,
	}); err != nil {
		t.Fatalf("deliver turn2 result: %v", err)
	}
	s := buf.String()
	if !strings.Contains(s, "FRESH TURN-2 OUTPUT") || strings.Contains(s, "STALE TURN-1 OUTPUT") {
		t.Fatalf("turn2 read must get its own fresh result, never the stale orphan; stdin=%q", s)
	}
}

// TestControlProtocol_DiscardStaleBuffersErrorsOrphanParkedCall locks the
// never-hang half of the turn-boundary reset: a tools/call still parked at
// end_turn (the worker never delivered its result) must be answered with an
// error mcp_response so the CLI — which blocks on stdin with no transport
// timeout — unwinds, exactly as teardown does, but with the session still live.
func TestControlProtocol_DiscardStaleBuffersErrorsOrphanParkedCall(t *testing.T) {
	buf, cp := captureStdin()

	args := json.RawMessage(`{"command":"ls"}`)
	params, _ := json.Marshal(MCPToolsCallParams{Name: mcpToolPrefix + "bash", Arguments: args})
	jrpc, _ := json.Marshal(JSONRPCMessage{JSONRPC: "2.0", ID: json.RawMessage(`3`), Method: "tools/call", Params: params})
	if err := cp.handleControlRequest(&StreamMessage{
		Type:      "control_request",
		RequestID: "req-orphan-park",
		Request:   &ControlRequestBody{Subtype: "mcp_message", Message: jrpc},
	}); err != nil {
		t.Fatalf("park orphan call: %v", err)
	}
	if buf.Len() != 0 {
		t.Fatalf("parked call should defer; stdin=%q", buf.String())
	}

	stashed, parked := cp.discardStaleBuffers()
	if stashed != 0 || parked != 1 {
		t.Fatalf("discardStaleBuffers cleared (stashed=%d, parked=%d), want (0, 1)", stashed, parked)
	}

	lines := readLines(t, buf)
	if len(lines) != 1 {
		t.Fatalf("expected one abort response, got %d: %q", len(lines), buf.String())
	}
	respBody := lines[0]["response"].(map[string]any)
	if respBody["request_id"] != "req-orphan-park" {
		t.Errorf("request_id = %v, want req-orphan-park", respBody["request_id"])
	}
	wrapper := respBody["response"].(map[string]any)["mcp_response"].(map[string]any)
	result := wrapper["result"].(map[string]any)
	if isErr, _ := result["isError"].(bool); !isErr {
		t.Errorf("orphan parked call must be answered with an error result; got %+v", result)
	}
}

// TestMakeMCPMatchKey_ScalarTypeInsensitive locks in that a tool argument and
// its string spelling canonicalise to the SAME key. The CLI parks its
// tools/call with native JSON scalars (e.g. {"limit":40,"-n":true}) while the
// worker-recorded tool_use.input can pick up string spellings ({"limit":"40",
// "-n":"true"}) across a resume/restart doc round-trip. They denote the same
// logical call, so exact-key matching must treat them as identical — otherwise
// the lossy same-tool-name positional fallback takes over and mis-pairs
// concurrent same-tool calls (see the cross-file cascade test below).
func TestMakeMCPMatchKey_ScalarTypeInsensitive(t *testing.T) {
	cases := []struct {
		name string
		a, b json.RawMessage
	}{
		{"int vs string-int", json.RawMessage(`{"limit":40}`), json.RawMessage(`{"limit":"40"}`)},
		{"bool vs string-bool", json.RawMessage(`{"-n":true}`), json.RawMessage(`{"-n":"true"}`)},
		{"multi-scalar", json.RawMessage(`{"limit":40,"offset":640}`), json.RawMessage(`{"limit":"40","offset":"640"}`)},
		{"nested array+object", json.RawMessage(`{"a":{"b":[1,true,null]}}`), json.RawMessage(`{"a":{"b":["1","true","null"]}}`)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if ka, kb := makeMCPMatchKey("read", tc.a), makeMCPMatchKey("read", tc.b); ka != kb {
				t.Errorf("scalar type drift must canonicalise equal:\n a=%q\n b=%q", ka, kb)
			}
		})
	}
}

// TestMakeMCPMatchKey_DistinguishesRealDivergence is the guard rail on the
// canonicalisation above: collapsing scalar TYPES must NOT collapse different
// VALUES. A read of a different file, or a different limit, is a genuine
// divergence the diagnostic must still surface.
func TestMakeMCPMatchKey_DistinguishesRealDivergence(t *testing.T) {
	if makeMCPMatchKey("read", json.RawMessage(`{"file_path":"/a.go","limit":40}`)) ==
		makeMCPMatchKey("read", json.RawMessage(`{"file_path":"/b.go","limit":40}`)) {
		t.Error("different file_path must NOT canonicalise equal")
	}
	if makeMCPMatchKey("read", json.RawMessage(`{"limit":40}`)) ==
		makeMCPMatchKey("read", json.RawMessage(`{"limit":50}`)) {
		t.Error("different limit must NOT canonicalise equal")
	}
}

// TestMakeMCPMatchKey_UnicodeEscapeInsensitive guards the second class of
// benign regeneration drift seen in the logs: a string leaf that reached the
// worker as a literal "\uXXXX" escape must canonicalise equal to the same leaf
// carrying the actual rune (which is how the CLI parks it). Without the fold the
// two are different Go strings, keys diverge, and delivery falls to the lossy
// same-tool positional pairing (the "tool/request divergence" INFO/ERROR log).
// Cases are the real payloads: '…', the BOM, '→', '≥', and an astral emoji
// (surrogate pair). NOTE: the backtick literals are raw — the escaped-side
// values contain a real backslash ("\\u2026" → the seven bytes \u2026 in JSON),
// while the literal-side "\uXXXX" is decoded to a rune by json.Unmarshal.
func TestMakeMCPMatchKey_UnicodeEscapeInsensitive(t *testing.T) {
	cases := []struct {
		name     string
		esc, lit json.RawMessage
	}{
		{"ellipsis", json.RawMessage(`{"new_string":"p = '\\u2026/'"}`), json.RawMessage(`{"new_string":"p = '…/'"}`)},
		{"bom", json.RawMessage(`{"old_string":"/^\\uFEFF?---/"}`), json.RawMessage(`{"old_string":"/^\ufeff?---/"}`)},
		{"arrow", json.RawMessage(`{"new_string":"Get API Key \\u2192"}`), json.RawMessage(`{"new_string":"Get API Key →"}`)},
		{"gte", json.RawMessage(`{"new_string":"need \\u2265 %d"}`), json.RawMessage(`{"new_string":"need ≥ %d"}`)},
		{"surrogate-pair", json.RawMessage(`{"pattern":"\\uD83D\\uDE00"}`), json.RawMessage(`{"pattern":"😀"}`)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if ka, kb := makeMCPMatchKey("edit", tc.esc), makeMCPMatchKey("edit", tc.lit); ka != kb {
				t.Errorf("unicode-escape drift must canonicalise equal:\n esc=%q\n lit=%q", ka, kb)
			}
		})
	}
}

// TestMakeMCPMatchKey_UnicodeFoldKeepsDistinctRunesDistinct is the guard rail on
// the fold: collapsing escape spelling must NOT collapse different runes. A
// literal "\u2026" (…) and a literal "\u2192" (→) decode to different
// characters and must stay different keys.
func TestMakeMCPMatchKey_UnicodeFoldKeepsDistinctRunesDistinct(t *testing.T) {
	if makeMCPMatchKey("edit", json.RawMessage(`{"s":"\\u2026"}`)) ==
		makeMCPMatchKey("edit", json.RawMessage(`{"s":"\\u2192"}`)) {
		t.Error("different runes must NOT canonicalise equal after unicode fold")
	}
}

// TestControlProtocol_ExactKeyRoutesAcrossTypeDriftOutOfOrder is the regression
// for the cross-file cascade seen in the logs: two concurrent reads of DIFFERENT
// files are parked (native int offsets), and the worker delivers their results
// OUT OF ORDER with string-spelled offsets (the resume/restart type drift). If
// the type drift defeats exact-key matching, delivery falls back to same-tool
// FIFO position and hands fileB's result to fileA's parked call — exactly the
// "read got the wrong file's content" corruption. Type-insensitive keys must
// route each result to its OWN parked call regardless of arrival order.
func TestControlProtocol_ExactKeyRoutesAcrossTypeDriftOutOfOrder(t *testing.T) {
	buf, cp := captureStdin()

	// CLI parks both reads first, with NATIVE numeric offsets, file A then B.
	park := func(reqID, jrpcID string, args json.RawMessage) {
		t.Helper()
		params, _ := json.Marshal(MCPToolsCallParams{Name: mcpToolPrefix + "read", Arguments: args})
		jrpc, _ := json.Marshal(JSONRPCMessage{JSONRPC: "2.0", ID: json.RawMessage(jrpcID), Method: "tools/call", Params: params})
		if err := cp.handleControlRequest(&StreamMessage{
			Type: "control_request", RequestID: reqID,
			Request: &ControlRequestBody{Subtype: "mcp_message", Message: jrpc},
		}); err != nil {
			t.Fatalf("park %s: %v", reqID, err)
		}
	}
	park("req-A", "1", json.RawMessage(`{"file_path":"/a.go","offset":640}`))  // front of FIFO
	park("req-B", "2", json.RawMessage(`{"file_path":"/b.go","offset":1147}`)) // behind A

	// Worker delivers B's result FIRST, with STRING offsets (the drift). Pure
	// FIFO-by-name would drain the front (req-A) and mis-deliver B's content.
	if _, err := cp.deliverNextToolResult(
		makeMCPMatchKey("read", json.RawMessage(`{"file_path":"/b.go","offset":"1147"}`)),
		&provider.ToolResult{ToolUseID: "tB", Content: "RESULT-FOR-B", ResultStatus: provider.ResultStatusSuccess},
	); err != nil {
		t.Fatalf("deliver B: %v", err)
	}
	if _, err := cp.deliverNextToolResult(
		makeMCPMatchKey("read", json.RawMessage(`{"file_path":"/a.go","offset":"640"}`)),
		&provider.ToolResult{ToolUseID: "tA", Content: "RESULT-FOR-A", ResultStatus: provider.ResultStatusSuccess},
	); err != nil {
		t.Fatalf("deliver A: %v", err)
	}

	got := map[string]string{}
	for _, line := range readLines(t, buf) {
		body := line["response"].(map[string]any)
		wrap := body["response"].(map[string]any)["mcp_response"].(map[string]any)
		content := wrap["result"].(map[string]any)["content"].([]any)
		got[body["request_id"].(string)] = content[0].(map[string]any)["text"].(string)
	}
	if got["req-A"] != "RESULT-FOR-A" {
		t.Errorf("req-A (file /a.go) got %q, want RESULT-FOR-A — cross-file mis-delivery", got["req-A"])
	}
	if got["req-B"] != "RESULT-FOR-B" {
		t.Errorf("req-B (file /b.go) got %q, want RESULT-FOR-B — cross-file mis-delivery", got["req-B"])
	}
}

// parkRead parks a tools/call for the read tool with the given args, mirroring
// what the CLI emits when the model invokes a tool.
func parkRead(t *testing.T, cp *controlProtocol, reqID, jrpcID string, args json.RawMessage) {
	t.Helper()
	params, _ := json.Marshal(MCPToolsCallParams{Name: mcpToolPrefix + "read", Arguments: args})
	jrpc, _ := json.Marshal(JSONRPCMessage{JSONRPC: "2.0", ID: json.RawMessage(jrpcID), Method: "tools/call", Params: params})
	if err := cp.handleControlRequest(&StreamMessage{
		Type: "control_request", RequestID: reqID,
		Request: &ControlRequestBody{Subtype: "mcp_message", Message: jrpc},
	}); err != nil {
		t.Fatalf("park %s: %v", reqID, err)
	}
}

// answeredRequestIDs returns the set of request_ids the control protocol has
// written control_responses for, mapped to the delivered result text.
func answeredRequestIDs(t *testing.T, buf *bytes.Buffer) map[string]string {
	t.Helper()
	got := map[string]string{}
	for _, line := range readLines(t, buf) {
		body, ok := line["response"].(map[string]any)
		if !ok {
			continue
		}
		wrap, ok := body["response"].(map[string]any)["mcp_response"].(map[string]any)
		if !ok {
			continue
		}
		result, ok := wrap["result"].(map[string]any)
		if !ok {
			continue
		}
		content, ok := result["content"].([]any)
		if !ok || len(content) == 0 {
			continue
		}
		got[body["request_id"].(string)] = content[0].(map[string]any)["text"].(string)
	}
	return got
}

// TestControlProtocol_ProductionParkThenPauseDelivers is the regression for the
// generation-scoping strand seen in production on the FIRST tool round. The real
// CLI emits a round's tools/call BEFORE its stop_reason=tool_use pause (park,
// then pause), the reverse of the test harness's order. The old code advanced
// the generation ON the pause, bumping it between the park (gen 0) and the
// result delivery — so delivery, scoped to the new generation, could not see the
// gen-0 parked call and stranded it (and false-tripped the out-of-band invariant
// on a perfectly normal round). The round boundary must be the first park after
// a pause, so a single round's park and delivery share one generation.
func TestControlProtocol_ProductionParkThenPauseDelivers(t *testing.T) {
	buf, cp := captureStdin()

	// Production order: the tools/call parks FIRST...
	parkRead(t, cp, "req-1", "1", json.RawMessage(`{"file_path":"/a.go"}`))
	// ...THEN the message_delta(stop_reason=tool_use) pause closes the message.
	cp.noteToolUsePause()
	// The worker delivers the result for that round.
	if _, err := cp.deliverNextToolResult(
		makeMCPMatchKey("read", json.RawMessage(`{"file_path":"/a.go"}`)),
		&provider.ToolResult{ToolUseID: "t1", Content: "CONTENT-A", ResultStatus: provider.ResultStatusSuccess},
	); err != nil {
		t.Fatalf("deliver: %v", err)
	}

	if got := answeredRequestIDs(t, buf); got["req-1"] != "CONTENT-A" {
		t.Fatalf("parked call was stranded by the generation bump: req-1 got %q, want CONTENT-A", got["req-1"])
	}
	if n := cp.outOfBandRoundCount(); n != 0 {
		t.Fatalf("a normal first round false-tripped the out-of-band detector: %d", n)
	}
}

// TestControlProtocol_StarvedReaderPauseThenDeliverThenPark reproduces the
// multi-CLI idle-window stall ("stream stalled: no output" → teardown). In
// production a round's
// stop_reason=tool_use pause can be processed by the always-on reader BEFORE its
// tools/call park arrives (the order seen in the logs: pause at 09:29:03, park 5s
// later at 09:29:08). The pause latches roundClosed. With several CLIs in flight,
// the reader goroutine is starved while the worker goroutine races ahead, so the
// result DELIVERY can reach the control-protocol actor before the matching park —
// especially for a fast tool. The delivery, finding no park, stashes at the
// pre-advance generation; the park then opens a NEW generation and cannot drain
// the older-generation stash. Call and result are stranded in different
// generations and never pair, so the CLI hangs until teardown. A single tab never
// contends, so the reader always parks first and this never trips — matching the
// "only with multiple CLIs" report.
func TestControlProtocol_StarvedReaderPauseThenDeliverThenPark(t *testing.T) {
	buf, cp := captureStdin()

	args := json.RawMessage(`{"command":"echo 1"}`)

	// Reader processes the message_delta(stop_reason=tool_use) pause first,
	// latching roundClosed, BEFORE the tools/call park line arrives.
	cp.noteToolUsePause()
	// Worker delivers the (fast) result; under load it beats the starved reader's
	// park, so there is no parked call to match yet.
	if _, err := cp.deliverNextToolResult(makeMCPMatchKey("bash", args), &provider.ToolResult{
		ToolUseID: "t1", Content: "OUT-1", ResultStatus: provider.ResultStatusSuccess,
	}); err != nil {
		t.Fatalf("deliver: %v", err)
	}
	// The reader finally parks the tools/call for that same round.
	park(t, cp, "req-1", "1", "bash", args)

	if got := answeredRequestIDs(t, buf); got["req-1"] != "OUT-1" {
		t.Fatalf("parked call orphaned by a generation skew (the multi-CLI stall): req-1 got %q, want OUT-1", got["req-1"])
	}
	if n := cp.outOfBandRoundCount(); n != 0 {
		t.Fatalf("a normal round (pause before park) false-tripped the out-of-band detector: %d", n)
	}
}

// TestControlProtocol_ProductionMultiRoundParkThenPause extends the regression to
// two rounds in production order: each round's park precedes its pause, and each
// round's result is delivered before the next round parks. Both calls must be
// answered with their OWN result and the out-of-band detector must stay quiet.
func TestControlProtocol_ProductionMultiRoundParkThenPause(t *testing.T) {
	buf, cp := captureStdin()

	// Round 1: park A, pause, deliver A.
	parkRead(t, cp, "req-A", "1", json.RawMessage(`{"file_path":"/a.go"}`))
	cp.noteToolUsePause()
	if _, err := cp.deliverNextToolResult(
		makeMCPMatchKey("read", json.RawMessage(`{"file_path":"/a.go"}`)),
		&provider.ToolResult{ToolUseID: "tA", Content: "CONTENT-A", ResultStatus: provider.ResultStatusSuccess},
	); err != nil {
		t.Fatalf("deliver A: %v", err)
	}
	// Round 2: park B (opens a new generation), pause, deliver B.
	parkRead(t, cp, "req-B", "2", json.RawMessage(`{"file_path":"/b.go"}`))
	cp.noteToolUsePause()
	if _, err := cp.deliverNextToolResult(
		makeMCPMatchKey("read", json.RawMessage(`{"file_path":"/b.go"}`)),
		&provider.ToolResult{ToolUseID: "tB", Content: "CONTENT-B", ResultStatus: provider.ResultStatusSuccess},
	); err != nil {
		t.Fatalf("deliver B: %v", err)
	}

	got := answeredRequestIDs(t, buf)
	if got["req-A"] != "CONTENT-A" {
		t.Errorf("req-A got %q, want CONTENT-A", got["req-A"])
	}
	if got["req-B"] != "CONTENT-B" {
		t.Errorf("req-B got %q, want CONTENT-B", got["req-B"])
	}
	if n := cp.outOfBandRoundCount(); n != 0 {
		t.Fatalf("normal two-round turn false-tripped the out-of-band detector: %d", n)
	}
}

// TestControlProtocol_OrphanResultDoesNotStrandNextRound replays the wedge seen
// in production. Round A's only call was one the CLI rejected itself, so it
// never parked, but juggler executed it and delivered the result: an orphan
// stash, which (the round being closed) opened the next generation early. Round
// B then parked todo (draining the orphan by name) and bash, and paused. On
// delivery of B's todo result, finding no parked todo, the actor took itself to
// be at the start of a new round and opened another generation — moving past
// the round B bash was parked in, so B's bash result could not see it. The CLI
// waited on bash until the server was restarted, two hours later.
//
// A parked call means its round is still open: the CLI cannot start a new round
// while one of its calls is unanswered. So a delivery with calls still parked in
// the current generation belongs to that generation.
func TestControlProtocol_OrphanResultDoesNotStrandNextRound(t *testing.T) {
	buf, cp := captureStdin()

	// Round A: the pause, then the result of a call the CLI never parked.
	cp.noteToolUsePause()
	if _, err := cp.deliverNextToolResult(makeMCPMatchKey("todo", json.RawMessage(`{"todos":"[]"}`)), &provider.ToolResult{
		ToolUseID: "tA", Content: "ORPHAN", ResultStatus: provider.ResultStatusSuccess,
	}); err != nil {
		t.Fatalf("deliver orphan: %v", err)
	}

	// Round B, in production order: both calls park, then the pause.
	park(t, cp, "req-todo", "1", "todo", json.RawMessage(`{"todos":[]}`))
	bashArgs := json.RawMessage(`{"command":"cat proposal.md"}`)
	park(t, cp, "req-bash", "2", "bash", bashArgs)
	cp.noteToolUsePause()

	// The worker delivers round B's results in stream order.
	if _, err := cp.deliverNextToolResult(makeMCPMatchKey("todo", json.RawMessage(`{"todos":[]}`)), &provider.ToolResult{
		ToolUseID: "tB1", Content: "TODO-OUT", ResultStatus: provider.ResultStatusSuccess,
	}); err != nil {
		t.Fatalf("deliver todo: %v", err)
	}
	if _, err := cp.deliverNextToolResult(makeMCPMatchKey("bash", bashArgs), &provider.ToolResult{
		ToolUseID: "tB2", Content: "BASH-OUT", ResultStatus: provider.ResultStatusSuccess,
	}); err != nil {
		t.Fatalf("deliver bash: %v", err)
	}

	if got := answeredRequestIDs(t, buf); got["req-bash"] != "BASH-OUT" {
		t.Fatalf("round B's bash was stranded behind a generation the orphan opened: req-bash got %q, want BASH-OUT", got["req-bash"])
	}
}
