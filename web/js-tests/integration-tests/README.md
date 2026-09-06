# Integration Tests

This directory contains integration tests for the Juggler framework. Tests run the **full framework pipeline** with only the LLM mocked.

## Quick Start

```bash
# Run all tests
make test

# Run all integration tests
bin/juggler-test --task integration-all

# Run specific test
bin/juggler-test --task approval-approve
```

## Architecture

```
User message → Worker → Strategy → callLLM() [MOCKED]
→ ResponseHandler → Tool execution [REAL]
→ Yjs sync → conversation.items [REAL]
→ Context preparation [REAL]
```

**Key principle**: Only the LLM response is scripted. Everything else (tool execution, Yjs sync, context building, approval flows) runs through real code paths.

## Test File Structure

```
web/js-tests/
├── utilities/
│   ├── integration-test-runner.js   # Main orchestrator
│   ├── test-harness.js              # Test environment (mock LLM injection)
│   ├── golden-comparator.js         # Golden data comparison utilities
│   └── integration-test-executor.js # Browser-side test execution
└── integration-tests/
    ├── approval-flow-tests.js   # Approval approve/deny tests
    ├── compaction-tests.js      # /compact command tests
    ├── error-recovery-tests.js  # Error handling tests
    ├── execute-tests.js         # Shell execution tests
    ├── glob-tests.js            # File pattern matching tests
    ├── multi-conversation-tests.js # Multi-conversation tests
    ├── read-file-tests.js       # File reading tests
    ├── write-file-basic.js      # Basic file writing
    └── write-file-tests.js      # Advanced file writing
```

## Writing a New Test

### 1. Create Test File

Create `web/js-tests/integration-tests/my-feature-tests.js`:

```javascript
import { textResponse, toolUseResponse, multiToolResponse } from '../utilities/integration-test-runner.js';

// Test definition
export const myFeatureBasicTest = {
    name: 'my-feature-basic',
    description: 'Verify my feature works correctly',
    fixture: 'unit-test-fixture',

    // Mock LLM responses (consumed in order as callLLM() is called)
    llmResponses: [
        toolUseResponse('call_1', 'bash', { command: 'echo hello' }, 'Running command.'),
        textResponse('Done!')
    ],

    // Test flow operations
    operations: [
        { type: 'send-message', message: 'Run echo hello' },
        { type: 'wait-for-approval', toolUseId: 'call_1' },
        { type: 'approve', toolUseId: 'call_1' }
    ],

    // Golden data: expected final document state
    expectedDocument: {
        items: [
            { type: 'system-prompt', itemId: '$ITEM_1' },
            { type: 'user', content: 'Run echo hello' },
            { type: 'assistant', content: 'Running command.' },
            {
                type: 'tool-action',
                toolUseId: '$TOOL_1',
                toolName: 'bash',
                toolInput: { command: 'echo hello' },
                state: 'completed',
                result: { content: 'Action completed.', isError: false }
            },
            { type: 'assistant', content: 'Done!' }
        ]
    }
};

// Export all tests from this file
export const allTests = [myFeatureBasicTest];
```

### 2. Register Test File

Add your test file to `utilities/integration-test-executor.js`:

```javascript
// Import your test file
import { tests as myFeatureTests } from '../integration-tests/my-feature-tests.js';

// Add to the allTests array in runIntegrationTests()
const allTests = [
    ...writeFileBasicTests,
    ...readFileTests,
    // ...existing test imports...
    ...myFeatureTests  // Add your tests here
];
```

## Test Definition Reference

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Unique test identifier (used in CLI: `--task {name}`) |
| `description` | `string` | Human-readable description |
| `fixture` | `string` | Fixture directory name (in `tests/fixtures/`) |
| `llmResponses` | `MockResponse[]` | Mock LLM responses, consumed in order |
| `operations` | `Operation[]` | Test flow operations |
| `expectedDocument` | `object` | Expected final document state for golden comparison |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `expectedItems` | `object[]` | Partial item matching (less strict than `expectedDocument`) |
| `fileAssertions` | `object[]` | Verify file contents: `{ path, content }` |

## Operation Types

### `send-message`

Send a user message to start/continue conversation.

```javascript
{ type: 'send-message', message: 'Hello world' }
```

### `wait-for-approval`

Wait for a tool to reach pending approval state.

```javascript
{ type: 'wait-for-approval', toolUseId: 'call_1', timeoutMs: 5000 }
```

### `approve`

Approve a pending tool execution.

```javascript
{ type: 'approve', toolUseId: 'call_1' }
```

### `deny`

Deny a pending tool execution.

```javascript
{ type: 'deny', toolUseId: 'call_1' }
```

### `run-command`

Execute a slash command.

```javascript
{ type: 'run-command', command: 'compact', args: '' }
```

### `run-command-no-wait`

Execute a slash command without fencing on anything it might start. For commands
expected *not* to run — a declined confirmation leaves the original turn in
flight, so `run-command`'s fences would never settle.

```javascript
{ type: 'run-command-no-wait', command: 'compact' }
```

### `expect-confirm` / `assert-confirm-shown`

Answer the next confirmation dialog by clicking the real `<modal-dialog>`, then
assert what it said. Arm `expect-confirm` **before** the operation that raises
the dialog — that operation is blocked on the answer, so it can never reach a
later step. `assert-confirm-shown` waits for the dialog to have appeared (failing
if it never did) and clears the arm.

Because the arm goes first, its clock is already running while the operation
does its own work — loading registries, cancelling a live turn — before the
dialog is raised. That is why the watcher rides the test's deadline rather than a
fixed timeout: the production confirm resolves on a click and on nothing else, so
a watcher that gives up early does not fail the test, it strands it, and the
failure arrives much later naming only the operation it was in. If that ever
happens the failure block says `ARMED CONFIRM GAVE UP` and what it was waiting
for.

```javascript
{ type: 'expect-confirm', answer: false },
{ type: 'run-command-no-wait', command: 'compact' },
{ type: 'assert-confirm-shown', titleContains: 'Stop the current turn?' }
```

### `simulate-disconnect`

Simulate WebSocket disconnection for reconnection tests.

```javascript
{ type: 'simulate-disconnect', reconnectMs: 100 }
```

### `wait-for-state`

Wait for specific conversation state.

```javascript
{ type: 'wait-for-state', condition: { itemCount: 5 } }
```

## Mock Response Helpers

### `textResponse(text)`

Create a text-only LLM response.

```javascript
textResponse('Here is my answer.')
// Returns: { blocks: [{ type: 'text', content: 'Here is my answer.' }], stopReason: 'end_turn' }
```

### `toolUseResponse(id, name, input, text?)`

Create a single tool use response with optional preceding text.

```javascript
toolUseResponse('call_1', 'read_file', { path: 'src/main.go' }, 'Let me read that file.')
// Returns: {
//   blocks: [
//     { type: 'text', content: 'Let me read that file.' },
//     { type: 'tool_use', toolUseId: 'call_1', toolName: 'read_file', toolInput: {...} }
//   ],
//   stopReason: 'tool_use'
// }
```

### `multiToolResponse(tools, text?)`

Create a response with multiple tool uses.

```javascript
multiToolResponse([
    { id: 'call_1', name: 'read_file', input: { path: 'a.js' } },
    { id: 'call_2', name: 'read_file', input: { path: 'b.js' } }
], 'Reading both files.')
```

## Golden Data Comparison

### ID Normalization

Non-deterministic IDs are normalized for stable comparisons:

| Original | Normalized |
|----------|------------|
| `call_abc123xyz` | `$TOOL_1` |
| `call_def456uvw` | `$TOOL_2` |
| `ci_ghi789rst` | `$ITEM_1` |

Use normalized IDs in `expectedDocument`:

```javascript
expectedDocument: {
    items: [
        {
            type: 'tool-action',
            toolUseId: '$TOOL_1',  // NOT 'call_1'
            // ...
        }
    ]
}
```

### Required Fields for tool-action

Every `tool-action` item MUST specify:

```javascript
{
    type: 'tool-action',
    toolUseId: '$TOOL_1',           // Required
    toolName: 'bash',               // Required
    toolInput: { command: '...' },  // Required
    state: 'completed',      // Required: 'completed', 'cancelled', or 'pending'
    result: {                       // Required
        content: 'Action completed.',
        isError: false
    }
}
```

### Golden Data Rules

1. **Compare ENTIRE document** - Use `expectedDocument` for full comparison
2. **No substring matching** - Golden comparison catches any deviation
3. **Fixture-dependent is OK** - Update golden data when fixtures change
4. **Keep golden data inline** - No separate JSON files

## No-Skip, No-Slop Policy

**This test framework enforces rigorous standards.**

There is intentionally no `skip: true` property in the test definition schema.
The `IntegrationTestDefinition` type does not include a skip field.

**No-Skip**: Every test MUST pass. No exceptions, no workarounds.

**No-Slop**: Tests must be precise:
- `expectedDocument` compares the ENTIRE document structure
- Every `tool-action` must specify `state` and `result`
- No substring matching — use exact golden data
- No "it works sometimes" — tests must be deterministic

If a test cannot pass:
- **Fix the test** - Adjust mock responses, operations, or expected results
- **Fix the code** - If the test reveals a real bug
- **Delete the test** - If it tests something that cannot be tested reliably

**Never commit a broken test.** The test suite must be 100% green at all times.

## Debugging

### Enable Verbose Logging

```bash
bin/juggler-test --task my-test --verbose
```

### Capture Actual State

In test code, use:

```javascript
import { logDocumentSnapshot, captureGoldenData } from '../utilities/golden-comparator.js';

// Log to console
logDocumentSnapshot(conversation, 'After operation');

// Get JSON for golden data
const json = captureGoldenData(conversation);
console.log(json);
```

### Common Issues

**Test hangs on `wait-for-approval`:**
- Check that `toolUseId` matches the ID in `llmResponses`
- Verify the tool requires approval (bash does, read_file doesn't)

**Golden comparison fails:**
- Use `captureGoldenData()` to see actual document state
- Check for extra/missing items
- Verify `state` and `result` are present

**Tool not found:**
- Ensure action registry is initialized
- Check tool name matches plugin (e.g., `bash` not `execute`)

## Test Infrastructure Files

| File | Purpose |
|------|---------|
| `integration-test-runner.js` | Main orchestrator, helper functions |
| `test-harness.js` | `IntegrationTestHarness` class - creates test environment |
| `golden-comparator.js` | Normalization and comparison utilities |
| `integration-test-executor.js` | Browser-side execution coordinator |

## IntegrationTestHarness API

```javascript
const harness = new IntegrationTestHarness({
    llmResponses: [...],
    fixture: 'unit-test-fixture',
    fixtureDir: '/path/to/fixtures'
});

await harness.setup();                          // Initialize everything
await harness.sendMessage('Hello');             // Send user message
await harness.waitForApproval('call_1');        // Wait for approval state
await harness.resolveApproval('call_1', 'approved');  // Approve/deny
const snapshot = harness.getDocumentSnapshot(); // Get normalized state
await harness.teardown();                       // Cleanup
```
