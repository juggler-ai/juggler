# Juggler Integration Tests

## Overview

Integration tests exercise the FULL framework pipeline with mock LLM responses:
- User sends message → Worker processes → Tools execute → Yjs syncs → Assertions verify

Only the LLM response is mocked. Everything else runs real code.

## Test Structure

Each test definition includes:
- `name` - Unique test identifier
- `description` - What the test verifies
- `fixture` - Fixture directory to use
- `llmResponses` - Mock LLM responses (consumed in order)
- `operations` - User actions to perform
- `expectedDocument` or `expectedItems` - Golden data assertions

## Writing Tests

### 1. Define Mock Responses
```javascript
llmResponses: [
    textResponse('Hello!'),
    toolUseResponse('call_1', 'bash', { command: 'echo test' }, 'Running.')
]
```

### 2. Define Operations
```javascript
operations: [
    { type: 'send-message', message: 'Hi' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'approve', toolUseId: 'call_1' }
]
```

### 3. Define Assertions
Use `expectedDocument` for full golden comparison or `expectedItems` for partial matching.

## Operation Types

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `send-message` | Send user message | `message: string` |
| `wait-for-approval` | Wait for tool to need approval | `toolUseId: string`, `timeoutMs?: number` |
| `approve` | Approve a pending tool | `toolUseId: string` |
| `deny` | Deny a pending tool | `toolUseId: string` |
| `run-command` | Execute slash command | `command: string`, `args?: string` |
| `wait-for-state` | Wait for conversation state | `condition: object` |
| `create-conversation` | Create new conversation | `name?: string` |
| `switch-conversation` | Switch active conversation | `conversationId: string` |
| `delete-conversation` | Delete a conversation | `conversationId: string` |
| `undo` | Undo last operation | - |
| `redo` | Redo last undone operation | - |

## Rules

1. **NO SKIPPING** - Every test that exists MUST pass. There is no `skip` property.
   If a test cannot pass, either fix it or delete it. We do not commit broken tests.
2. **NO FLAKY TESTS** - If timing-dependent, use explicit waits
3. **GOLDEN DATA** - Compare entire structures, not substrings
4. **ISOLATION** - Each test gets fresh session

## No-Skip, No-Slop Policy

**This repository enforces rigorous test standards.** The test framework intentionally
has no `skip: true` property or similar mechanism.

**No-Skip**: Every test in the repo MUST pass. There is no mechanism to skip tests.

**No-Slop**: Tests must be precise and meaningful:
- Golden data comparisons verify ENTIRE structures, not substrings
- No "close enough" assertions — exact matches required
- No flaky tests — use explicit waits, not timing assumptions
- No placeholder assertions — every field must be verified

If you find yourself wanting to skip a test:
- **Fix the test** - Make it pass with correct assertions
- **Fix the code** - If the test reveals a real bug
- **Delete the test** - If it tests something that can't be tested reliably

**Never commit a broken or skipped test.** The test suite must be 100% green.

## Measuring rendered things

The pool window is never shown. On macOS it is ordered in out of sight so its
pages run on the performance cores, and frames arrive; on Linux, and on macOS
under `JUGGLER_TEST_BACKGROUND_POOL=1`, a lane's page lays out but never paints
a frame. A test must pass in both, so write it for the page that never paints.
Three consequences catch every test that reads a size or a colour:

- **Turn the transition off before a geometry read.** `el.style.transition =
  'none'` first, then measure. A transition in flight with no frames to drive it
  resolves per engine: WebKit's first read after the class change returns the end
  value and every read after that is pinned at the from-value for good, while
  WebView2 runs it to completion. The same assertion then passes on one platform
  and fails on another, describing a layout bug that isn't there. Measure before
  the interaction that starts the animation, not after awaiting it.
- **Poll for a windowed code block's height.** A block past the eager limit
  (`sdk/lib/code-lines.js`) draws its first window with `rowHeight` 0, so both
  spacers are 0px and the block is exactly 120 rows tall until the first measure
  tick. Assert in the turn the content lands and you are measuring that state,
  not the file.
- **A highlight pseudo-element's `color` is not assertable.**
  `getComputedStyle(el, '::selection').color` reports the covered element's own
  colour in WebKit and the root's in Chromium — both engines paint identically,
  since a highlight naming no `color` leaves the text the colour it had. To
  assert that nothing sets one, walk `document.styleSheets` for rules whose
  `selectorText` contains `::selection` (recursing into `@media` groups) and
  check the property is empty. `background-color` on the pseudo *is* portable.

## Running Tests

```bash
bin/juggler-test --task integration-all
```
