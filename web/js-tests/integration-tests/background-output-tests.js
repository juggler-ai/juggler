//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration test: watching a background bash command from the properties panel.
 *
 * `bash` with `run_in_background` hands the model a task id and returns — the
 * process's own stdout never enters the conversation, so without a live view the
 * user cannot see what it printed. The panel therefore shows BOTH: the frozen
 * `Result` the model was handed, and a live `Output` section polling the shell
 * registry's accumulated buffer.
 *
 * This drives it against a REAL background process: run a command that prints a
 * marker and then exits, select the tool-action through the real UI path, and
 * assert the marker reaches the panel and the status line settles on the exit
 * code (which is otherwise invisible — the tool-action's own outcome froze at
 * "started OK").
 * @module integration-tests/background-output-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';
import { waitFor } from '../utilities/test-helpers.js';

const MARKER = 'BG_PANEL_4X7';

/**
 * Text of the properties-panel subsection under the given heading.
 * @param {string} label - The subsection heading (e.g. "Output").
 * @returns {string} The section's text, or '' when it isn't rendered.
 */
function sectionText(label) {
  const panel = document.querySelector('properties-panel');
  const sections = panel ? panel.querySelectorAll('properties-panel-subsection') : [];
  for (const section of sections) {
    const heading = section.querySelector('.properties-panel-subtitle');
    if (heading?.textContent !== label) continue;
    const body = /** @type {HTMLElement} */ (section).cloneNode(true);
    /** @type {HTMLElement} */ (body).querySelector('.properties-panel-subtitle')?.remove();
    return /** @type {HTMLElement} */ (body).textContent || '';
  }
  return '';
}

/**
 * The live output section's Stop button, if it is currently on show.
 * @returns {HTMLButtonElement|null} The visible button, or null.
 */
function visibleStopButton() {
  const panel = document.querySelector('properties-panel');
  const btn = /** @type {HTMLButtonElement|null} */ (panel?.querySelector('.live-task-output-stop') || null);
  if (!btn || btn.style.display === 'none') return null;
  return btn;
}

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const backgroundOutputInPanelTest = {
  name: 'background-output-in-panel',
  description: 'The properties panel shows a background bash task\'s live output and exit status alongside the result the model was handed',
  fixture: 'unit-test-fixture',

  // Two waits on a 1 s poll, either side of the command's own second of life —
  // past the 10 s default, and nowhere near the 6 s each is given below.
  timeoutMs: 25000,

  // `sh -c` auto-approves (same spelling the Monitor tests rely on), so the turn
  // runs straight through: a background launch returns the instant it spawns.
  llmResponses: [
    toolUseResponse('call_1', 'bash',
      { command: `sh -c 'echo ${MARKER}; sleep 1'`, run_in_background: true },
      'Starting it in the background.'
    ),
    textResponse('Started.')
  ],

  operations: [
    { type: 'send-message', message: 'run it in the background' }
  ],

  customAssertions: async (conversation) => {
    const items = conversation.rootMessageThread.items;
    const action = items.find((/** @type {any} */ it) => it.get?.('type') === 'tool-action' && it.get('toolName') === 'bash');
    if (!action) throw new Error('[background-output] no bash tool-action in the thread');

    const result = action.get('result');
    const plain = result?.toJSON ? result.toJSON() : result;
    const taskId = String(plain?.fullResult?.result?.task_id || '');
    if (!taskId) throw new Error('[background-output] the background launch recorded no task_id');

    const area = /** @type {any} */ (document.querySelector('conversation-area'));
    if (!area || typeof area._selectItem !== 'function') return; // headless — no UI to drive
    area.selectItem(action.get('itemId'));

    // The panel render is debounced and the output section polls on an interval.
    await waitFor(() => sectionText('Output').includes(MARKER), {
      timeoutMs: 6000,
      intervalMs: 50,
      description: () => `[background-output] the panel to show the task's output; Output section was ${JSON.stringify(sectionText('Output'))}`,
    });

    // The exit code lands only through the live poll — the tool-action's own
    // outcome is frozen at the moment the process was spawned.
    await waitFor(() => sectionText('Output').includes('Exit 0'), {
      timeoutMs: 6000,
      intervalMs: 50,
      description: () => `[background-output] the output section to report the exit code; got ${JSON.stringify(sectionText('Output'))}`,
    });

    const backgroundTask = () => {
      const displayData = action.get('displayData');
      return (displayData?.toJSON ? displayData.toJSON() : displayData)?.backgroundTask;
    };
    const durable = await waitFor(() => (backgroundTask()?.status === 'completed' ? backgroundTask() : null), {
      timeoutMs: 6000,
      intervalMs: 50,
      description: () => `[background-output] the completed task to be persisted on the tool action; got ${JSON.stringify(backgroundTask())}`,
    });
    if (durable.taskId !== taskId || durable.output !== `${MARKER}\n` || durable.exitCode !== 0) {
      throw new Error(`[background-output] completed output was not persisted on the tool action; got ${JSON.stringify(durable)}`);
    }

    // The text the MODEL was handed stays on show beside the live output: the
    // handle plus how to read it, which is all a background launch returns.
    const resultText = sectionText('Result');
    if (!resultText.includes(taskId) || !resultText.includes('TaskOutput')) {
      throw new Error(`[background-output] Result section didn't carry the model-facing launch notice; got ${JSON.stringify(resultText)}`);
    }
  }
};

/**
 * A background bash task outlives its tool call and has no delivery binding to
 * cancel (the way a monitor does), so the properties panel is the only place a
 * user can reach the process. This drives that: launch something long-lived,
 * click the panel's Stop, and assert the task actually died — the status line
 * reports the kill and the button takes itself away.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const backgroundStopFromPanelTest = {
  name: 'background-stop-from-panel',
  description: 'The properties panel can kill a running background bash task',
  fixture: 'unit-test-fixture',

  timeoutMs: 25000,

  llmResponses: [
    toolUseResponse('call_1', 'bash',
      { command: `sh -c 'echo ${MARKER}; sleep 60'`, run_in_background: true },
      'Starting a long one.'
    ),
    textResponse('Started.')
  ],

  operations: [
    { type: 'send-message', message: 'start something long in the background' }
  ],

  customAssertions: async (conversation) => {
    const items = conversation.rootMessageThread.items;
    const action = items.find((/** @type {any} */ it) => it.get?.('type') === 'tool-action' && it.get('toolName') === 'bash');
    if (!action) throw new Error('[background-stop] no bash tool-action in the thread');

    const area = /** @type {any} */ (document.querySelector('conversation-area'));
    if (!area || typeof area._selectItem !== 'function') return; // headless — no UI to drive
    area.selectItem(action.get('itemId'));

    // The button appears only once a poll has reported the task running, so a
    // task that ended before the panel opened never offers a pointless Stop.
    const stopBtn = await waitFor(visibleStopButton, {
      timeoutMs: 6000,
      intervalMs: 50,
      description: () => `[background-stop] a Stop button for the running task; Output section was ${JSON.stringify(sectionText('Output'))}`,
    });

    stopBtn.click();

    await waitFor(() => sectionText('Output').includes('Killed by user'), {
      timeoutMs: 6000,
      intervalMs: 50,
      description: () => `[background-stop] the task to report being killed; Output section was ${JSON.stringify(sectionText('Output'))}`,
    });

    // Nothing left to stop: the control goes once the task is no longer running.
    await waitFor(() => visibleStopButton() === null, {
      timeoutMs: 3000,
      intervalMs: 50,
      description: '[background-stop] the Stop button to go once the task was killed',
    });
  }
};

export const tests = [backgroundOutputInPanelTest, backgroundStopFromPanelTest];
