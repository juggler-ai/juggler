# Integration Test Helper Framework

This directory contains the helper framework for writing integration tests in Juggler. The framework provides a clean, deterministic API for testing real system mechanics with only the LLM mocked.

## Philosophy

**Test real app mechanics, only mock the LLM.**

The helper framework follows the principle that integration tests should use real components (worker, Yjs documents, managers) and only mock external dependencies (LLM API calls). This ensures tests catch real bugs while remaining fast and deterministic.

## Core Helpers

### 1. `test_setup.go` - Session Management

**Purpose**: Simplify test boilerplate with reusable session setup.

```go
func TestExample(t *testing.T) {
    // Setup creates manager, worker, and temp directory
    ts := helpers.SetupTestSession(t)

    // Access components
    doc := ts.GetDocument()
    worker := ts.Worker
    manager := ts.Manager
}
```

**Key Functions:**
- `SetupTestSession(t)` - Creates fully initialized test session
- `ts.SetLLMSequence(...)` - Configure mock LLM responses
- `ts.CreateFile(path, content)` - Create test files
- `ts.GetDocument()` - Access conversation document

### 2. `document_assertions.go` - Structured State Assertions

**Purpose**: Replace brittle string matching with structured document state verification.

```go
// ❌ OLD: String matching (brittle, misses issues)
if !strings.Contains(string(msg), "evaluate-tool") {
    t.Fatal("Never received evaluate-tool")
}

// ✅ NEW: Structured state assertion (deterministic)
helpers.AssertDocumentState(t, worker, helpers.DocumentState{
    ItemCount: &itemCount,
    Items: []helpers.ItemAssertion{
        {Index: 0, ToolUseID: "tool-1", ApprovalState: "pending"},
    },
})
```

**Key Types:**
- `DocumentState` - Expected document state (items, context items, metadata, undo/redo)
- `ItemAssertion` - Expected item properties (type, content, approval state)
- `AssertDocumentState(t, worker, expected)` - Primary assertion function
- `FindItemByToolUseID(doc, toolUseID)` - Find specific items

### 3. `sync_helpers.go` - Condition-Based Waiting

**Purpose**: Eliminate hardcoded sleeps with adaptive polling.

```go
// ❌ OLD: Hardcoded sleep (timing-sensitive)
time.Sleep(200 * time.Millisecond)

// ✅ NEW: Condition-based wait (deterministic)
err := helpers.WaitForApprovalState(t, worker, "tool-1", "pending", 2*time.Second)
if err != nil {
    t.Fatalf("Tool did not reach pending state: %v", err)
}
```

**Key Functions:**
- `WaitForItemCount(t, worker, count, timeout)` - Wait for specific item count
- `WaitForApprovalState(t, worker, toolUseID, state, timeout)` - Wait for approval state
- `WaitForContextItemExists(t, worker, itemID, timeout)` - Wait for context item to exist
- `WaitForUndoAvailable(t, worker, available, timeout)` - Wait for undo availability
- `WaitForDocumentCondition(t, worker, timeout, condition)` - Custom conditions
- `WaitUntil(t, what, cond)` - Wait for something a worker does once scheduled
  (a turn reaching its model, the item it writes); bounded by `ReadyTimeout`,
  which only names a hang
- `WaitForItem(t, worker, what, match)` / `WaitForDocument(t, worker, what, cond)`
  / `WaitForState(t, worker, state)` - `WaitUntil` on the document or the
  worker's state. A queued turn leaves the worker idle until it starts, so wait
  for something the turn does before waiting for idle

All wait functions use exponential backoff (10ms → 100ms) for efficient polling.

### 4. `mock_llm.go` - Structured Mock Responses

**Purpose**: Clear, reusable mock LLM responses.

```go
// Simple text response
ts.SetLLMSequence(
    helpers.TextResponse("Here's my response"),
)

// Tool use response
ts.SetLLMSequence(
    helpers.ToolUseResponse("tool-1", "bash", map[string]string{
        "command": "ls -la",
    }),
)

// Multiple tools
ts.SetLLMSequence(
    helpers.MultiToolResponse(
        helpers.ToolUse{ID: "tool-1", Name: "read_file", Input: map[string]string{"path": "a.txt"}},
        helpers.ToolUse{ID: "tool-2", Name: "read_file", Input: map[string]string{"path": "b.txt"}},
    ),
)

// Conditional responses
cond := ts.SetLLMConditional()
cond.When(helpers.ContainsText("hello"), helpers.TextResponse("Hi there"))
cond.When(helpers.ContainsText("goodbye"), helpers.TextResponse("Farewell"))
cond.When(helpers.AlwaysMatch(), helpers.TextResponse("Default response"))
```

**Key Functions:**
- `TextResponse(text)` - Simple text response
- `ToolUseResponse(id, name, input)` - Single tool use
- `MultiToolResponse(tools...)` - Multiple tools
- `TextAndToolResponse(text, tools...)` - Text followed by tools
- `ThinkingResponse(thinking)` - Thinking block
- `NewConditionalSequence()` - Dynamic responses based on request

## Example Test Structure

```go
func TestApprovalFlow(t *testing.T) {
    // 1. Setup
    ts := helpers.SetupTestSession(t)

    // 2. Configure mock LLM
    ts.SetLLMSequence(
        helpers.ToolUseResponse("tool-1", "bash", map[string]string{
            "command": "echo test",
        }),
    )

    // 3. Execute: Insert message via tracker
    ts.Worker.Tracker().InsertMessage(0, worker.ConversationItem{
        Type:    "user",
        Content: "Run echo test",
    })

    // 4. Wait: Use condition-based waiter
    err := helpers.WaitForApprovalState(t, ts.Worker, "tool-1", "pending", 2*time.Second)
    if err != nil {
        t.Fatalf("Tool did not reach pending state: %v", err)
    }

    // 5. Assert: Structured document state
    itemCount := 1
    helpers.AssertDocumentState(t, ts.Worker, helpers.DocumentState{
        ItemCount: &itemCount,
        Items: []helpers.ItemAssertion{
            {Index: 0, ToolUseID: "tool-1", ApprovalState: "pending"},
        },
    })
}
```

## Benefits Over Old Approach

### Before: String Matching + Hardcoded Sleeps

```go
// ~200 lines of boilerplate
time.Sleep(200 * time.Millisecond)

var foundApproval bool
for _, msgBytes := range messages {
    var parsed map[string]any
    json.Unmarshal(msgBytes, &parsed)
    if parsed["type"] == "evaluate-tool" {
        foundApproval = true
    }
}

if !foundApproval {
    t.Fatal("Never received evaluate-tool")
}
```

**Problems:**
- Timing-sensitive (hardcoded sleeps)
- Brittle (string matching passes even when content is corrupt)
- Verbose (200+ lines of setup per test)
- Manual message routing (duplicated auto-responder logic)

### After: Document State + Condition Waiters

```go
// ~60 lines with helpers
ts := helpers.SetupTestSession(t)
ts.SetLLMSequence(helpers.ToolUseResponse("tool-1", "bash", map[string]string{"command": "echo test"}))

err := helpers.WaitForApprovalState(t, ts.Worker, "tool-1", "pending", 2*time.Second)
if err != nil {
    t.Fatalf("Tool did not reach pending state: %v", err)
}

helpers.AssertDocumentState(t, ts.Worker, helpers.DocumentState{
    Items: []helpers.ItemAssertion{
        {Index: 0, ToolUseID: "tool-1", ApprovalState: "pending"},
    },
})
```

**Benefits:**
- 67% reduction in lines of code
- No hardcoded sleeps (adaptive polling)
- Deterministic assertions (full document state)
- Clear intent (readable test code)

## Writing New Tests

### 1. Use Helpers for Setup

```go
func TestMyFeature(t *testing.T) {
    ts := helpers.SetupTestSession(t)
    // Test code here
}
```

### 2. Configure Mock LLM

```go
ts.SetLLMSequence(
    helpers.TextResponse("First response"),
    helpers.ToolUseResponse("tool-1", "bash", map[string]string{"command": "ls"}),
    helpers.TextResponse("Second response"),
)
```

### 3. Use Condition Waiters (Not Sleeps)

```go
// ❌ DON'T
time.Sleep(100 * time.Millisecond)

// ✅ DO
err := helpers.WaitForItemCount(t, ts.Worker, 3, 2*time.Second)
if err != nil {
    t.Fatalf("Items did not reach expected count: %v", err)
}
```

### 4. Assert Document State (Not Strings)

```go
// ❌ DON'T
if strings.Contains(string(msg), "success") {
    // ...
}

// ✅ DO
itemCount := 2
helpers.AssertDocumentState(t, ts.Worker, helpers.DocumentState{
    ItemCount: &itemCount,
    Items: []helpers.ItemAssertion{
        {Index: 0, Type: "user", Content: "Hello"},
        {Index: 1, Type: "assistant", Content: "Hi there"},
    },
})
```

## Debugging Failed Tests

When a test fails, use `DumpDocument` to see the actual state:

```go
func TestMyFeature(t *testing.T) {
    ts := helpers.SetupTestSession(t)

    // ... test code ...

    // If test fails, dump document for debugging
    ts.DumpDocument()
}
```

Output:
```
=== Document State ===
Items: 3
Item[0]: {
  "type": "user",
  "content": "Hello",
  "messageId": "msg-1"
}
Item[1]: {
  "type": "assistant",
  "content": "Hi there",
  "messageId": "msg-2"
}
...
Context Items: 2
  - ci-1
  - ci-2
CanUndo: (check tracker), CanRedo: (check tracker)
```

## Coverage Goals

The helper framework enables comprehensive testing:

- **Approval flows**: 100% (critical user path)
- **Undo/redo**: 100% (data integrity)
- **Strategy types**: 100% (4 strategies)
- **Tool execution**: 90% (happy + error paths)
- **Document operations**: 95% (all mutation types)
- **Error conditions**: 75% (major failure modes)

## Migration Guide

When migrating existing tests to use helpers:

1. **Replace setup boilerplate** with `SetupTestSession(t)`
2. **Replace hardcoded sleeps** with `WaitFor*()` functions
3. **Replace string matching** with `AssertDocumentState()`
4. **Replace inline mock LLM** with `SetLLMSequence()`

See `helpers_example_test.go` for complete examples.
