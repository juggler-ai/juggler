//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * `! cmd` and `/shell cmd`: a command the user runs from the composer, with no
 * model call, whose output joins the conversation as a `shell-output` item.
 *
 * Four layers, outermost last:
 *  1. What reads as `! cmd` (and what stays a message).
 *  2. The `/shell` command: it declares the run, the host performs it.
 *  3. services/user-shell.js against a stub shell: the item it writes, where it
 *     writes it (transcript when idle, queue when busy), Stop, and the fallback
 *     to the blocking shell when the socket is down.
 *  4. The composer's cue and running row, then a real `! echo` through
 *     Conversation.sendMessage against the test server.
 * @module unit-tests/shell-command-test
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  waitFor,
  assert
} from '../utilities/test-helpers.js';
import {
  shellShortcutCommand,
  runUserShell,
  runningUserShells,
  onUserShellsChange,
  SHELL_OUTPUT_ITEM_TYPE
} from '../../js/services/user-shell.js';
import { updateShellInputCue, renderShellRuns } from '../../js/components/composer-shell-runs.js';
import ShellCommandType from '../../extensions/juggler-core/commands/shell-command-type.js';

/**
 * A thread double that records where `runUserShell` writes its item.
 * @param {{busy?: boolean, threadItemId?: string|null}} [opts]
 * @returns {any} The thread, with `writes` listing each write
 */
function stubThread({ busy = false, threadItemId = null } = {}) {
  /** @type {Array<{where: string, type: string, params: any}>} */
  const writes = [];
  return {
    writes,
    threadItemId,
    conversation: { id: `conv-shell-${Math.random().toString(36).slice(2)}`, workingWorkspaceId: '' },
    get sendWillQueue() { return busy; },
    async executeContextItem(/** @type {string} */ type, /** @type {any} */ params) {
      writes.push({ where: 'items', type, params });
      return { id: 'SHELL_x', type, created: true };
    },
    async executeContextItemIntoPending(/** @type {string} */ type, /** @type {any} */ params) {
      writes.push({ where: 'pending', type, params });
      return { id: 'SHELL_x', type, created: true };
    }
  };
}

/**
 * A shell double that stays running until `finish` (or the signal) ends it.
 * @returns {{shellStreaming: any, calls: any[], finish: (result: any) => void}} The double
 */
function controllableShell() {
  /** @type {any[]} */
  const calls = [];
  /** @type {(result: any) => void} */
  let finish = () => {};
  const shellStreaming = (/** @type {any} */ params, /** @type {any} */ _onOutput, /** @type {AbortSignal} */ signal) => {
    calls.push(params);
    return new Promise((resolve) => {
      finish = resolve;
      signal?.addEventListener('abort', () => resolve({ command: params.command, stdout: 'partial', exitCode: -1, success: false, cancelled: true }));
    });
  };
  return { shellStreaming, calls, finish: (result) => finish(result) };
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ── 1. What reads as `! cmd` ─────────────────────────────────────────────

  await run('`! cmd` names the command; a bare `!` is a message', () => {
    assert(shellShortcutCommand('! gh search repos --help') === 'gh search repos --help', 'spaced form');
    assert(shellShortcutCommand('!npm run lint') === 'npm run lint', 'unspaced form');
    assert(shellShortcutCommand('  ! npm audit  ') === 'npm audit', 'surrounding whitespace');
    assert(shellShortcutCommand('! echo a\necho b') === 'echo a\necho b', 'multi-line commands keep their lines');
    assert(shellShortcutCommand('!') === null, 'a lone ! is a message');
    assert(shellShortcutCommand('!   ') === null, '! and spaces is a message');
    assert(shellShortcutCommand('wow!') === null, 'a ! later on is a message');
    assert(shellShortcutCommand('/shell ls') === null, '/shell is the command, not the shortcut');
  });

  // ── 2. The /shell command ────────────────────────────────────────────────

  await run('/shell declares the run, with the command line verbatim', async () => {
    const command = new ShellCommandType({});
    const result = await command.execute(['git', 'log', '--oneline'], 'git log --oneline  -n 3');
    const effect = result.sideEffects?.[0];
    assert(result.handled === true && result.error !== true, `expected handled, got ${JSON.stringify(result)}`);
    assert(effect?.type === 'runShell', `expected a runShell side effect, got ${JSON.stringify(result.sideEffects)}`);
    assert(effect?.data?.command === 'git log --oneline  -n 3', `command not verbatim: ${JSON.stringify(effect?.data)}`);
  });

  await run('/shell with no command says how to use it and runs nothing', async () => {
    const result = await new ShellCommandType({}).execute([], '   ');
    assert(result.handled === true && result.error === true, `expected a handled error, got ${JSON.stringify(result)}`);
    assert(!result.sideEffects, 'nothing may run');
    assert(/! git status/.test(result.message || ''), `usage should show an example: ${result.message}`);
  });

  await run('/shell neither stops nor refuses a running turn', () => {
    const manifest = /** @type {any} */ (ShellCommandType.MANIFEST);
    assert(!manifest.mutatesConversation, 'a shell command must not cancel the turn');
    assert(!manifest.rejectWhileBusy, 'a shell command must not be refused while busy');
  });

  // ── 3. The service ───────────────────────────────────────────────────────

  await run('an idle thread gets the output in its transcript, with no model call', async () => {
    const mt = stubThread();
    const shell = controllableShell();
    let changes = 0;
    const off = onUserShellsChange(() => { changes++; });
    try {
      const done = runUserShell(mt, 'echo hi', { shellStreaming: shell.shellStreaming });
      assert(runningUserShells(mt).map((r) => r.command).join() === 'echo hi', 'the run must be listed while it runs');
      assert(shell.calls[0]?.command === 'echo hi', `shell got ${JSON.stringify(shell.calls[0])}`);
      assert(shell.calls[0]?.convId === mt.conversation.id, 'the run is tagged with its conversation');
      shell.finish({ command: 'echo hi', stdout: 'hi', exitCode: 0, success: true });
      await done;
      assert(runningUserShells(mt).length === 0, 'the run must leave the list when it ends');
      assert(changes === 2, `expected a start and an end notification, got ${changes}`);
      assert(mt.writes.length === 1 && mt.writes[0].where === 'items', `expected one transcript write, got ${JSON.stringify(mt.writes)}`);
      const { type, params } = mt.writes[0];
      assert(type === SHELL_OUTPUT_ITEM_TYPE, `wrong item type ${type}`);
      assert(params.command === 'echo hi' && params.output === 'hi' && params.exitCode === 0 && !params.cancelled,
        `wrong item params ${JSON.stringify(params)}`);
    } finally {
      off();
    }
  });

  await run('a busy thread gets the output queued for the next turn boundary', async () => {
    const mt = stubThread({ busy: true });
    const shell = controllableShell();
    const done = runUserShell(mt, 'npm test', { shellStreaming: shell.shellStreaming });
    shell.finish({ command: 'npm test', stdout: 'FAIL', exitCode: 1, success: false });
    await done;
    assert(mt.writes.length === 1 && mt.writes[0].where === 'pending',
      `expected one queued write, got ${JSON.stringify(mt.writes)}`);
    assert(mt.writes[0].params.exitCode === 1, 'the exit code travels');
  });

  await run('Stop ends the command and still records what it printed', async () => {
    const mt = stubThread();
    const shell = controllableShell();
    const done = runUserShell(mt, 'sleep 100', { shellStreaming: shell.shellStreaming });
    const [running] = runningUserShells(mt);
    assert(running !== undefined, 'the run must be listed');
    running?.stop();
    await done;
    const params = mt.writes[0]?.params;
    assert(params?.cancelled === true && params.output === 'partial' && params.exitCode === null,
      `expected a stopped record with the partial output, got ${JSON.stringify(params)}`);
  });

  await run('runs are listed per thread', async () => {
    const root = stubThread();
    const child = { ...stubThread({ threadItemId: 'th-1' }), conversation: root.conversation };
    const shell = controllableShell();
    const done = runUserShell(root, 'make', { shellStreaming: shell.shellStreaming });
    assert(runningUserShells(root).length === 1, 'listed on its own thread');
    assert(runningUserShells(/** @type {any} */ (child)).length === 0, 'not on a sibling thread of the same conversation');
    shell.finish({ command: 'make', stdout: '', exitCode: 0, success: true });
    await done;
  });

  await run('with the socket down the blocking shell runs it', async () => {
    const mt = stubThread();
    /** @type {any[]} */
    const blockingCalls = [];
    await runUserShell(mt, 'pwd', {
      shellStreaming: async () => { throw new Error('WebSocket not connected, cannot execute streaming command'); },
      shell: async (/** @type {any} */ params) => {
        blockingCalls.push(params);
        return { command: 'pwd', stdout: '/p', stderr: '', exitCode: 0, success: true };
      }
    });
    assert(blockingCalls.length === 1, 'the blocking shell must be tried');
    assert(mt.writes[0]?.params.output === '/p', `fallback output lost: ${JSON.stringify(mt.writes)}`);
  });

  await run('a shell that cannot start is recorded with its reason', async () => {
    const mt = stubThread();
    await runUserShell(mt, 'ls', {
      shellStreaming: async () => ({ command: 'ls', stdout: '', exitCode: 1, success: false, error: 'no POSIX shell found' })
    });
    const params = mt.writes[0]?.params;
    assert(params?.error === 'no POSIX shell found', `reason lost: ${JSON.stringify(params)}`);
  });

  // ── 4. The composer, then the real thing ─────────────────────────────────

  await run('the composer marks a `! cmd` draft and lists its running commands', async () => {
    const host = document.createElement('div');
    const row = document.createElement('composer-shell-runs');
    row.hidden = true;
    host.appendChild(row);
    const mt = stubThread();

    updateShellInputCue(host, '! ls');
    assert(host.hasAttribute('shell-input'), 'a `! cmd` draft must be marked');
    updateShellInputCue(host, 'ls');
    assert(!host.hasAttribute('shell-input'), 'a message must not be');

    const shell = controllableShell();
    const done = runUserShell(mt, 'npm audit', { shellStreaming: shell.shellStreaming });
    renderShellRuns(host, mt);
    assert(!row.hidden, 'the row shows while a command runs');
    assert(row.textContent?.includes('$ npm audit') === true, `row lost the command: ${row.textContent}`);
    renderShellRuns(host, stubThread());
    assert(row.hidden, 'another thread\'s composer shows none of them');
    renderShellRuns(host, mt);
    /** @type {HTMLButtonElement|null} */ (row.querySelector('.shell-run-stop'))?.click();
    await done;
    renderShellRuns(host, mt);
    assert(row.hidden, 'the row hides once nothing runs');
    assert(mt.writes[0]?.params.cancelled === true, 'Stop in the row stops the command');
  });

  await run('`! echo` in a real conversation lands its output, and starts no turn', async () => {
    const session = await createTestSession();
    const conversation = await createTestConversation(session);
    const root = conversation.rootMessageThread;
    const shellItems = () => root.items.filter((/** @type {any} */ i) => i.get('type') === SHELL_OUTPUT_ITEM_TYPE);
    const userItems = () => root.items.filter((/** @type {any} */ i) => i.get('type') === 'user');

    const reason = await conversation.sendMessage('! echo shell-187', null, root);
    assert(reason === null, `the send was dropped: ${reason}`);
    await waitFor(() => shellItems().length === 1, () => `no shell-output item; items: ${root.items.map((/** @type {any} */ i) => i.get('type')).join(',')}`);

    const item = root.getContextItem(shellItems()[0].get('itemId'));
    const data = /** @type {any} */ (item?.data);
    assert(data?.command === 'echo shell-187', `wrong command ${JSON.stringify(data)}`);
    assert(String(data?.output).includes('shell-187') && data.exitCode === 0, `wrong output ${JSON.stringify(data)}`);
    assert(userItems().length === 0, 'the command must not become a user message');
    assert(!conversation.isTurnActive(), 'no turn may start for a shell command');
    const text = await item?.createContextText(/** @type {any} */ ({}));
    assert(String(text).includes('$ echo shell-187'), `the model's text lost the command: ${text}`);
  });

  return { passed, failed, errors };
}
