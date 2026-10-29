//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration Tests: run_code on the turn path
 *
 * A model's run_code call travels the whole pipeline: the worker asks the
 * engine for the thread's tools, the mock LLM answers with a program, the
 * worker admits and drives the call, the engine runs the program, and the
 * program's result goes back to the model as a tool_result. unit:run-code-program
 * runs the same item in-page; this is the only test that sees what the worker
 * offers and what it sends.
 * @module integration-tests/run-code-tests
 */

import { textResponse, toolUseResponse, testDirFor } from '../../../../js-tests/utilities/integration-test-runner.js';

/**
 * A document value as plain data: a live value's `toJSON()`, or the value itself.
 * @param {unknown} value - A value read from the document.
 * @returns {unknown} The plain value.
 */
function toPlain(value) {
  if (value && typeof value === 'object' && 'toJSON' in value && typeof value.toJSON === 'function') {
    return value.toJSON();
  }
  return value;
}

/**
 * A program that reads a file through the raw surface, edits it through
 * `tools.edit` on the strength of that read alone, and reads the result back
 * through `tools.bash`. Under YOLO nothing parks, so the turn completes
 * unattended, and the model receives the program's value followed by the
 * changes its calls made.
 * @returns {import('../../../../js-tests/utilities/integration-test-runner.js').IntegrationTestDefinition} Test definition
 */
function runCodeTurnTest() {
  const TD = testDirFor('run-code-turn');
  const target = `${TD}/seed.txt`;
  const code = [
    `const before = await fs.readFile(${JSON.stringify(target)});`,
    `await tools.edit({ file_path: ${JSON.stringify(target)}, old_string: "hello", new_string: "there" });`,
    `const shown = await tools.bash({ command: ${JSON.stringify(`cat ${target}`)} });`,
    'return { before: before.trim(), shown: String(shown).trim() };'
  ].join('\n');
  // The document holds what the program returned; the change list is added by
  // the worker's projection from the call record, so it appears on the wire
  // only.
  const valueText = [
    '{',
    '  "before": "greeting: hello",',
    '  "shown": "greeting: there"',
    '}'
  ].join('\n');
  const resultText = [
    valueText,
    '',
    'Changes the program made:',
    `- edit: ${target}`,
    `- bash: cat ${target}`
  ].join('\n');

  return {
    name: 'run-code-turn',
    description: 'A run_code program on the turn path: offered with its SDK, run, and reported on the wire',
    fixture: 'unit-test-fixture',
    strategy: 'yolo',
    // Only YOLO's own policy may approve: without this the harness's blanket
    // grant would approve the sub-calls whatever the strategy said.
    approvalFlow: true,
    setupFiles: {
      [target]: 'greeting: hello\n'
    },

    llmResponses: [
      toolUseResponse('call_1', 'run_code', { code }, 'Running a program.'),
      textResponse('Done.')
    ],

    operations: [
      { type: 'send-message', message: 'Swap the greeting with a program' },
      { type: 'wait-for-idle' },
      // The request that carried the program's result: it holds the result as
      // the model reads it, and the tool list the turn was offered.
      {
        type: 'validate-context-snapshot',
        expectedMessages: [{ role: 'tool-result', contentIncludes: resultText }],
        expectedTools: [
          { name: 'run_code', descriptionIncludes: 'calls any tool in your tool list by its name' },
          { name: 'run_code', descriptionIncludes: 'Not callable from a program: ' },
          { name: 'run_code', descriptionIncludes: 'describeTool(' }
        ]
      }
    ],

    expectedDocument: {
      items: [
        { type: 'system-prompt', itemId: '$ITEM_1' },
        { type: 'user', content: 'Swap the greeting with a program' },
        { type: 'assistant', content: 'Running a program.' },
        {
          type: 'tool-action',
          toolUseId: '$TOOL_1',
          toolName: 'run_code',
          toolInput: { code },
          state: 'completed',
          result: { content: valueText, isError: false }
        },
        { type: 'assistant', content: 'Done.' }
      ]
    },

    fileAssertions: [
      { path: target, content: 'greeting: there\n' }
    ],

    // The user sees one row per sub-call, and a row never carries a result.
    customAssertions: (conversation) => {
      const action = conversation.rootMessageThread.getToolAction('call_1');
      const data = /** @type {{nestedCalls?: unknown}|null|undefined} */ (toPlain(action?.get('displayData')));
      const rows = Array.isArray(data?.nestedCalls) ? data.nestedCalls : [];
      const brief = rows.map((/** @type {any} */ r) => `${r.name}:${r.status}`).join(',');
      if (brief !== 'edit:ok,bash:ok') {
        throw new Error(`run_code rows: expected edit:ok,bash:ok, got ${brief} (${JSON.stringify(rows)})`);
      }
      if (rows.some((/** @type {any} */ r) => 'result' in r)) {
        throw new Error(`a row must never hold a result: ${JSON.stringify(rows)}`);
      }
    }
  };
}

/**
 * A program the user stops part-way. It edits a file, then starts a call that
 * would run for half a minute, and Escape lands while that call runs. The
 * cancelled result is the worker's, so nothing the program could have
 * returned reaches the model — yet the next request must still tell the model
 * what the program changed, including the call that was cut off.
 * @returns {import('../../../../js-tests/utilities/integration-test-runner.js').IntegrationTestDefinition} Test definition
 */
function runCodeCancelReportsChangesTest() {
  const TD = testDirFor('run-code-cancel');
  const target = `${TD}/seed.txt`;
  const code = [
    `await fs.readFile(${JSON.stringify(target)});`,
    `await tools.edit({ file_path: ${JSON.stringify(target)}, old_string: "hello", new_string: "there" });`,
    'await tools.bash({ command: "sleep 30" });',
    'return "finished";'
  ].join('\n');

  return {
    name: 'run-code-cancel-reports-changes',
    description: 'A cancelled run_code program still tells the model what it changed',
    fixture: 'unit-test-fixture',
    strategy: 'yolo',
    approvalFlow: true,
    setupFiles: {
      [target]: 'greeting: hello\n'
    },

    llmResponses: [
      toolUseResponse('call_1', 'run_code', { code }, 'Running a program.'),
      textResponse('Noted.')
    ],

    operations: [
      { type: 'send-message-no-wait', message: 'Swap the greeting, then wait' },
      { type: 'wait-for-nested-call', toolUseId: 'call_1', callName: 'bash', callStatus: 'running' },
      { type: 'cancel' },
      // The worker writes the cancelled state; the engine writes the final rows
      // as the program unwinds. Send only once both have landed.
      { type: 'wait-for-nested-call', toolUseId: 'call_1', callName: 'bash', callStatus: 'cancelled' },
      { type: 'send-message', message: 'What happened?' },
      {
        type: 'validate-context-snapshot',
        expectedMessages: [{
          role: 'tool-result',
          contentIncludes: `Changes the program made:\n- edit: ${target}\n- bash: sleep 30 (interrupted)`
        }]
      }
    ],

    expectedDocument: {
      items: [
        { type: 'system-prompt', itemId: '$ITEM_1' },
        { type: 'user', content: 'Swap the greeting, then wait' },
        { type: 'assistant', content: 'Running a program.' },
        { type: 'tool-action', toolUseId: '$TOOL_1', toolName: 'run_code', state: 'cancelled' },
        { type: 'user', content: 'What happened?' },
        { type: 'assistant', content: 'Noted.' }
      ]
    },

    fileAssertions: [
      { path: target, content: 'greeting: there\n' }
    ]
  };
}

/**
 * A program the user stops while it is busy in its own code: one call, then a
 * loop that never awaits, so no call is in flight and nothing inside the
 * program can notice the cancel. Escape must still end it at once — its own
 * timeout is ten minutes — and the turn must be free for the next message.
 * @returns {import('../../../../js-tests/utilities/integration-test-runner.js').IntegrationTestDefinition} Test definition
 */
function runCodeCancelSpinningTest() {
  const code = 'await tools.bash({ command: "true" });\nfor (;;) {}';

  return {
    name: 'run-code-cancel-spinning',
    description: 'Escape ends a run_code program spinning in its own code, with no call in flight',
    fixture: 'unit-test-fixture',
    strategy: 'yolo',
    approvalFlow: true,

    llmResponses: [
      toolUseResponse('call_1', 'run_code', { code, timeout: 600000 }, 'Running a program.'),
      textResponse('Noted.')
    ],

    operations: [
      { type: 'send-message-no-wait', message: 'Run a program that never ends' },
      // The row reads ok only once the call has returned, by which time the
      // program is in its loop.
      { type: 'wait-for-nested-call', toolUseId: 'call_1', callName: 'bash', callStatus: 'ok' },
      { type: 'cancel' },
      { type: 'send-message', message: 'What happened?' },
      {
        type: 'validate-context-snapshot',
        expectedMessages: [{ role: 'tool-result', contentIncludes: 'Changes the program made:\n- bash: true' }]
      }
    ],

    expectedDocument: {
      items: [
        { type: 'system-prompt', itemId: '$ITEM_1' },
        { type: 'user', content: 'Run a program that never ends' },
        { type: 'assistant', content: 'Running a program.' },
        { type: 'tool-action', toolUseId: '$TOOL_1', toolName: 'run_code', state: 'cancelled' },
        { type: 'user', content: 'What happened?' },
        { type: 'assistant', content: 'Noted.' }
      ]
    }
  };
}

/**
 * The same program left to run into its timeout. Nothing in the program can
 * reach its own timer, so the host's has to end it; the model is told it timed
 * out, and the turn goes on.
 * @returns {import('../../../../js-tests/utilities/integration-test-runner.js').IntegrationTestDefinition} Test definition
 */
function runCodeTimeoutSpinningTest() {
  const code = 'for (;;) {}';

  return {
    name: 'run-code-timeout-spinning',
    description: 'A run_code program spinning in its own code ends at its timeout and the turn goes on',
    fixture: 'unit-test-fixture',
    strategy: 'yolo',
    approvalFlow: true,

    llmResponses: [
      toolUseResponse('call_1', 'run_code', { code, timeout: 1000 }, 'Running a program.'),
      textResponse('It timed out.')
    ],

    operations: [
      { type: 'send-message', message: 'Run a program that never ends' },
      {
        type: 'validate-context-snapshot',
        expectedMessages: [{ role: 'tool-result', contentIncludes: 'Script timed out after 1000ms' }]
      }
    ],

    expectedDocument: {
      items: [
        { type: 'system-prompt', itemId: '$ITEM_1' },
        { type: 'user', content: 'Run a program that never ends' },
        { type: 'assistant', content: 'Running a program.' },
        { type: 'tool-action', toolUseId: '$TOOL_1', toolName: 'run_code', state: 'completed' },
        { type: 'assistant', content: 'It timed out.' }
      ]
    }
  };
}

/**
 * A program shows the model an image: it reads a PNG through `tools.read`,
 * which gives it a handle, and attaches it with `image()`. The run_code item
 * carries the stored image as its attachment, as a read does, so the model is
 * sent it beside the program's text, which says what is attached.
 * @returns {import('../../../../js-tests/utilities/integration-test-runner.js').IntegrationTestDefinition} Test definition
 */
function runCodeImageTest() {
  const TD = testDirFor('run-code-image');
  const target = `${TD}/shot.png`;
  const code = [
    `const r = await tools.read({ file_path: ${JSON.stringify(target)} });`,
    'await image(r.images[0]);',
    'return "here it is";'
  ].join('\n');

  return {
    name: 'run-code-image',
    description: 'A run_code program attaches an image it read, and the model is sent it',
    fixture: 'unit-test-fixture',
    strategy: 'yolo',
    approvalFlow: true,
    setupFiles: { [target]: 'not really a png' },

    llmResponses: [
      toolUseResponse('call_1', 'run_code', { code }, 'Showing it.'),
      textResponse('I see it.')
    ],

    operations: [
      { type: 'send-message', message: 'Show me the screenshot' },
      {
        type: 'validate-context-snapshot',
        expectedMessages: [{ role: 'tool-result', contentIncludes: `here it is\n\nImages attached below:\n- ${target}` }]
      }
    ],

    expectedDocument: {
      items: [
        { type: 'system-prompt', itemId: '$ITEM_1' },
        { type: 'user', content: 'Show me the screenshot' },
        { type: 'assistant', content: 'Showing it.' },
        { type: 'tool-action', toolUseId: '$TOOL_1', toolName: 'run_code', state: 'completed' },
        { type: 'assistant', content: 'I see it.' }
      ]
    },

    customAssertions: (conversation) => {
      const action = conversation.rootMessageThread.getToolAction('call_1');
      const attachments = toPlain(action?.get('attachments'));
      if (!Array.isArray(attachments) || attachments.length !== 1
          || !/^[0-9a-f]{64}$/.test(attachments[0].id) || attachments[0].mime !== 'image/png') {
        throw new Error(`the run_code item must carry the stored image: ${JSON.stringify(attachments)}`);
      }
    }
  };
}

/**
 * A program under the Default strategy, where its calls ask. It reads three
 * files through `fs`, edits one and runs a command: the edit is held while
 * the program waits, the user approves, the program goes on and the command is
 * held, and the user approves that with "don't ask again". The program then
 * finishes in the one run it started in, each call having run exactly once —
 * its search for a random pattern would diverge were it ever run again. A
 * second program making the identical command runs unprompted on the saved
 * bash rule.
 * @returns {import('../../../../js-tests/utilities/integration-test-runner.js').IntegrationTestDefinition} Test definition
 */
function runCodeHoldsAndResumesTest() {
  const TD = testDirFor('run-code-hold');
  const a = `${TD}/a.txt`;
  const b = `${TD}/b.txt`;
  const c = `${TD}/c.txt`;
  const log = `${TD}/log.txt`;
  // Wrapped in a shell so no standing grant covers it: it asks.
  const command = `sh -c 'printf x >> ${log}'; printf ran`;
  const first = [
    `const a = await fs.readFile(${JSON.stringify(a)});`,
    `const b = await fs.readFile(${JSON.stringify(b)});`,
    `const c = await fs.readFile(${JSON.stringify(c)});`,
    `await grep(String(Math.random()), { cwd: ${JSON.stringify(TD)} });`,
    `await tools.edit({ file_path: ${JSON.stringify(c)}, old_string: "hello", new_string: "there" });`,
    `const r = await tools.bash({ command: ${JSON.stringify(command)} });`,
    'return [a.trim(), b.trim(), c.trim(), String(r).trim()].join("|");'
  ].join('\n');
  const second = `return String(await tools.bash({ command: ${JSON.stringify(command)} })).trim();`;

  return {
    name: 'run-code-hold',
    description: 'A run_code program under Default waits on each call that asks and goes on once approved',
    fixture: 'unit-test-fixture',
    approvalFlow: true,
    setupFiles: {
      [a]: 'alpha\n',
      [b]: 'beta\n',
      [c]: 'greeting: hello\n'
    },

    llmResponses: [
      toolUseResponse('call_1', 'run_code', { code: first }, 'Running a program.'),
      toolUseResponse('call_2', 'run_code', { code: second }, 'Once more.'),
      textResponse('Done.')
    ],

    operations: [
      // The approval-flow conversation permits file writes; the edit must ask.
      { type: 'clear-rules', itemType: 'write-file' },
      { type: 'send-message-no-wait', message: 'Swap the greeting with a program' },
      { type: 'wait-for-held-call', toolUseId: 'call_1', callName: 'edit' },
      { type: 'approve-no-wait', toolUseId: 'call_1' },
      { type: 'wait-for-held-call', toolUseId: 'call_1', callName: 'bash' },
      { type: 'approve-no-wait', toolUseId: 'call_1', response: 'yes-always:0' },
      // call_2 makes the same command. Were it to ask again, the turn would
      // rest on its prompt and never reach idle.
      { type: 'wait-for-idle' }
    ],

    expectedDocument: {
      items: [
        { type: 'system-prompt', itemId: '$ITEM_1' },
        { type: 'user', content: 'Swap the greeting with a program' },
        { type: 'assistant', content: 'Running a program.' },
        {
          type: 'tool-action',
          toolUseId: '$TOOL_1',
          toolName: 'run_code',
          toolInput: { code: first },
          state: 'completed',
          result: { content: 'alpha|beta|greeting: hello|ran', isError: false }
        },
        { type: 'assistant', content: 'Once more.' },
        {
          type: 'tool-action',
          toolUseId: '$TOOL_2',
          toolName: 'run_code',
          toolInput: { code: second },
          state: 'completed',
          result: { content: 'ran', isError: false }
        },
        { type: 'assistant', content: 'Done.' }
      ]
    },

    fileAssertions: [
      { path: c, content: 'greeting: there\n' },
      // One x per program: nothing ran the command a second time.
      { path: log, content: 'xx' }
    ],

    customAssertions: (conversation) => {
      const rowsOf = (/** @type {string} */ id) => {
        const data = /** @type {{nestedCalls?: unknown}|null|undefined} */ (
          toPlain(conversation.rootMessageThread.getToolAction(id)?.get('displayData')));
        return (Array.isArray(data?.nestedCalls) ? data.nestedCalls : [])
          .map((/** @type {any} */ r) => `${r.name}:${r.status}`).join(',');
      };
      if (rowsOf('call_1') !== 'edit:ok,bash:ok') {
        throw new Error(`call_1 rows: expected edit:ok,bash:ok, got ${rowsOf('call_1')}`);
      }
      if (rowsOf('call_2') !== 'bash:ok') {
        throw new Error(`call_2 rows: expected bash:ok, got ${rowsOf('call_2')}`);
      }
      const rules = conversation.rootMessageThread.getRulesFor('execute');
      if (!rules.length) {
        throw new Error('"don\'t ask again" on the held bash call must save a bash rule');
      }
      for (const id of ['call_1', 'call_2']) {
        if (conversation.rootMessageThread.getToolAction(id)?.get('heldCall') !== undefined) {
          throw new Error(`${id} must hold no call once finished`);
        }
      }
    }
  };
}

/**
 * The engine is lost while a program holds a call. Under Default the program
 * reads a file, searches the directory, makes an edit that runs unasked,
 * then makes a command that asks; while that command is held the engine page
 * is reloaded, so the program running it is gone. The user then approves, and
 * the new engine has no program to hand the answer to: it replays the program
 * from its snapshot, every earlier call answered from the journal and only the
 * held command made for real. Were anything replayed live, the edit would run
 * twice, the read would see the edited file, or the command would append to
 * its log twice. A replay runs the program's own code again, so nothing in it
 * may differ between runs (a random value would diverge from the journal).
 * @returns {import('../../../../js-tests/utilities/integration-test-runner.js').IntegrationTestDefinition} Test definition
 */
function runCodeEngineLostTest() {
  const TD = testDirFor('run-code-engine-lost');
  const target = `${TD}/seed.txt`;
  const log = `${TD}/log.txt`;
  // Wrapped in a shell so no standing grant covers it: it asks.
  const command = `sh -c 'printf x >> ${log}'; printf ran`;
  const code = [
    `const before = await fs.readFile(${JSON.stringify(target)});`,
    `await grep("greeting", { cwd: ${JSON.stringify(TD)} });`,
    `await tools.edit({ file_path: ${JSON.stringify(target)}, old_string: "hello", new_string: "hello!" });`,
    `const r = await tools.bash({ command: ${JSON.stringify(command)} });`,
    'return [before.trim(), String(r).trim()].join("|");'
  ].join('\n');

  return {
    name: 'run-code-engine-lost',
    description: 'A run_code program whose engine is lost while it holds a call resumes from its snapshot once approved',
    fixture: 'unit-test-fixture',
    approvalFlow: true,
    // Restarting the engine takes down every lane's executions with it.
    needsExclusiveRun: true,
    setupFiles: {
      [target]: 'greeting: hello\n'
    },

    llmResponses: [
      toolUseResponse('call_1', 'run_code', { code }, 'Running a program.'),
      textResponse('Done.')
    ],

    operations: [
      { type: 'send-message-no-wait', message: 'Mark the greeting with a program' },
      // The approval-flow conversation permits file writes, so the edit ran
      // unasked; the command is the first call to ask.
      { type: 'wait-for-held-call', toolUseId: 'call_1', callName: 'bash' },
      { type: 'assert-program-snapshot', toolUseId: 'call_1', exists: true, callName: 'bash' },
      { type: 'restart-engine' },
      // Still held after the engine change: nothing re-ran or failed it.
      { type: 'wait-for-held-call', toolUseId: 'call_1', callName: 'bash' },
      { type: 'approve-no-wait', toolUseId: 'call_1' },
      { type: 'wait-for-idle', timeoutMs: 30000 },
      { type: 'assert-program-snapshot', toolUseId: 'call_1', exists: false }
    ],

    expectedDocument: {
      items: [
        { type: 'system-prompt', itemId: '$ITEM_1' },
        { type: 'user', content: 'Mark the greeting with a program' },
        { type: 'assistant', content: 'Running a program.' },
        {
          type: 'tool-action',
          toolUseId: '$TOOL_1',
          toolName: 'run_code',
          toolInput: { code },
          state: 'completed',
          result: { content: 'greeting: hello|ran', isError: false }
        },
        { type: 'assistant', content: 'Done.' }
      ]
    },

    fileAssertions: [
      // One "!": the edit made before the hold was not made again.
      { path: target, content: 'greeting: hello!\n' },
      // One x: the held command ran once, on the new engine.
      { path: log, content: 'x' }
    ],

    customAssertions: (conversation) => {
      const action = conversation.rootMessageThread.getToolAction('call_1');
      const data = /** @type {{nestedCalls?: unknown}|null|undefined} */ (toPlain(action?.get('displayData')));
      const rows = (Array.isArray(data?.nestedCalls) ? data.nestedCalls : [])
        .map((/** @type {any} */ r) => `${r.name}:${r.status}`).join(',');
      if (rows !== 'edit:ok,bash:ok') {
        throw new Error(`call_1 rows: expected edit:ok,bash:ok, got ${rows}`);
      }
      if (action?.get('heldCall') !== undefined) {
        throw new Error('call_1 must hold no call once finished');
      }
    }
  };
}

/**
 * Denying the call a program is waiting on cancels the program, and the turn
 * stops there, as denying any call does. Nothing from the held call ran.
 * @returns {import('../../../../js-tests/utilities/integration-test-runner.js').IntegrationTestDefinition} Test definition
 */
function runCodeDenialCancelsTest() {
  const TD = testDirFor('run-code-deny');
  const target = `${TD}/seed.txt`;
  const code = [
    `await fs.readFile(${JSON.stringify(target)});`,
    `await tools.edit({ file_path: ${JSON.stringify(target)}, old_string: "hello", new_string: "there" });`,
    'return "finished";'
  ].join('\n');

  return {
    name: 'run-code-deny',
    description: 'Denying the call a run_code program is waiting on cancels the program and the turn',
    fixture: 'unit-test-fixture',
    approvalFlow: true,
    setupFiles: {
      [target]: 'greeting: hello\n'
    },

    llmResponses: [
      toolUseResponse('call_1', 'run_code', { code }, 'Running a program.')
    ],

    operations: [
      { type: 'clear-rules', itemType: 'write-file' },
      { type: 'send-message-no-wait', message: 'Swap the greeting with a program' },
      { type: 'wait-for-held-call', toolUseId: 'call_1', callName: 'edit' },
      { type: 'deny', toolUseId: 'call_1' }
    ],

    expectedDocument: {
      items: [
        { type: 'system-prompt', itemId: '$ITEM_1' },
        { type: 'user', content: 'Swap the greeting with a program' },
        { type: 'assistant', content: 'Running a program.' },
        { type: 'tool-action', toolUseId: '$TOOL_1', toolName: 'run_code', state: 'cancelled' }
      ]
    },

    fileAssertions: [
      { path: target, content: 'greeting: hello\n' }
    ]
  };
}

export const tests = [
  runCodeTurnTest(),
  runCodeCancelReportsChangesTest(),
  runCodeCancelSpinningTest(),
  runCodeTimeoutSpinningTest(),
  runCodeImageTest(),
  runCodeHoldsAndResumesTest(),
  runCodeEngineLostTest(),
  runCodeDenialCancelsTest()
];
