//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * `! cmd` and `/shell cmd`: a command the user runs from the composer. It is
 * posted to the conversation as an ordinary bash tool call — selectable, its
 * output streaming into the properties panel, stoppable there — and starts no
 * model turn.
 *
 * Three layers, outermost last:
 *  1. What reads as `! cmd` (and what stays a message).
 *  2. The `/shell` command: it declares the run, the host sends it.
 *  3. A real `! echo` and a real `! sleep` through Conversation.sendMessage
 *     against the test server: the bash call it posts, and Stop in its panel.
 * @module unit-tests/shell-command-test
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  waitFor,
  assert
} from '../utilities/test-helpers.js';
import { shellShortcutCommand } from '../../js/services/shell-shortcut.js';
import ShellCommandType from '../../extensions/juggler-core/commands/shell-command-type.js';
import ExecuteContextItem from '../../extensions/juggler-core/context-items/execute-context-item.js';

/**
 * The root thread's bash tool-actions.
 * @param {any} thread - The message thread
 * @returns {any[]} Its bash tool-action Y.Maps
 */
function bashCalls(thread) {
  return thread.items.filter((/** @type {any} */ i) => i.get('type') === 'tool-action' && i.get('toolName') === 'bash');
}

/**
 * @param {any} v - A Y type or a plain value
 * @returns {any} The plain value
 */
const plain = (v) => (v?.toJSON ? v.toJSON() : v);

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

  // ── 3. The real thing ────────────────────────────────────────────────────

  await run('`! echo` posts a bash call that runs, and starts no turn', async () => {
    const session = await createTestSession();
    const conversation = await createTestConversation(session);
    const root = conversation.rootMessageThread;

    const reason = await conversation.sendMessage('! env echo shell-187', null, root);
    assert(reason === null, `the send was dropped: ${reason}`);
    await waitFor(() => bashCalls(root)[0]?.get('state') === 'completed',
      () => `no completed bash call; items: ${JSON.stringify(root.items.map((/** @type {any} */ i) => [i.get('type'), i.get('toolName'), i.get('state')]))}`);

    const call = bashCalls(root)[0];
    const input = plain(call.get('toolInput'));
    assert(input?.command === 'env echo shell-187', `wrong command ${JSON.stringify(input)}`);
    const result = plain(call.get('result'));
    assert(String(result?.content).includes('shell-187') && !result?.isError, `wrong result ${JSON.stringify(result)}`);
    const kinds = root.items.map((/** @type {any} */ i) => i.get('type'));
    assert(!kinds.includes('user') && !kinds.includes('assistant'),
      `a shell command is neither a message nor a reply: ${kinds.join(',')}`);
    assert(!conversation.isTurnActive(), 'no turn may start for a shell command');
  });

  await run('a running bash call can be stopped from its properties panel', async () => {
    const session = await createTestSession();
    const conversation = await createTestConversation(session);
    const root = conversation.rootMessageThread;

    const reason = await conversation.sendMessage('! sleep 600', null, root);
    assert(reason === null, `the send was dropped: ${reason}`);
    await waitFor(() => bashCalls(root)[0]?.get('state') === 'running',
      () => `the bash call never ran: ${JSON.stringify(bashCalls(root).map((/** @type {any} */ i) => i.get('state')))}`);
    const call = bashCalls(root)[0];

    const helpers = {
      addSubsection: () => {},
      addLlmDescription: () => {},
      labeledSubsection: () => document.createElement('div'),
    };
    const item = new ExecuteContextItem(/** @type {any} */ ({
      id: 'properties-panel', session, conversation, messageThread: root
    }));
    const rendered = /** @type {any} */ (item.renderToolActionDetails(document.createElement('div'), /** @type {any} */ ({
      input: plain(call.get('toolInput')), helpers, toolAction: call
    })));
    const stop = /** @type {HTMLButtonElement|undefined} */ ((rendered?.controls || [])
      .find((/** @type {HTMLElement} */ c) => c.classList.contains('bash-stop')));
    assert(!!stop, `a running bash call offers no Stop: ${JSON.stringify((rendered?.controls || []).map((/** @type {HTMLElement} */ c) => c.textContent))}`);
    stop?.click();

    await waitFor(() => call.get('state') === 'completed' || call.get('state') === 'cancelled',
      () => `Stop did not end the command: state=${call.get('state')}`);
    assert(!conversation.isTurnActive(), 'stopping the user\'s command must start no turn');

    const finished = /** @type {any} */ (item.renderToolActionDetails(document.createElement('div'), /** @type {any} */ ({
      input: plain(call.get('toolInput')), helpers, toolAction: call
    })));
    assert(!(finished?.controls || []).some((/** @type {HTMLElement} */ c) => c.classList.contains('bash-stop')),
      'a finished call must offer no Stop');
  });

  return { passed, failed, errors };
}
