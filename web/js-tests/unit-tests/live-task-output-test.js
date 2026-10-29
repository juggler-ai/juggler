//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for the background task's live "Output" section
 * (`sdk/lib/live-task-output.js`): every text it draws on its own — the default
 * heading, both placeholders, the spill note and the failed-stop note — follows
 * the UI language.
 *
 * The sections are never mounted, so each stops polling by itself after a few
 * reads of the injected reader.
 * @module unit-tests/live-task-output-test
 */

import { renderLiveTaskOutput } from '../../sdk/lib/live-task-output.js';
import { assert, waitFor } from '../utilities/test-helpers.js';
import { underPseudoLocale, assertPseudoLocalized } from '../utilities/pseudo-locale.js';

/** Panel helpers narrowed to what the section uses; the heading is drawn so it is checked. */
const helpers = {
  labeledSubsection: (/** @type {string} */ label) => {
    const section = document.createElement('div');
    const heading = document.createElement('div');
    heading.textContent = label;
    section.appendChild(heading);
    return section;
  },
};

/**
 * Run the live-task-output test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  /** @type {string[]} */
  const errors = [];
  let passed = 0;
  let failed = 0;

  /**
   * @param {string} name
   * @param {() => Promise<void>} fn
   */
  const run = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await run('en-XA: the section draws no plain English in any state', async () => {
    await underPseudoLocale('live-task-output-test', async () => {
      // A running task that has printed nothing yet, with a Stop that fails.
      const running = document.createElement('div');
      renderLiveTaskOutput(running, {
        taskId: '1',
        helpers,
        pollMs: 10,
        onStop: async () => { throw new Error('2'); },
        readOutput: async () => ({ status: 'running', output: '' }),
      });
      const stop = /** @type {HTMLButtonElement|null} */ (running.querySelector('.live-task-output-stop'));
      assert(!!stop, 'no Stop button was drawn');
      // Shown once the first read reports the task running.
      await waitFor(() => stop?.style.display === '', 'the first read to show the Stop button');
      stop?.click();
      const note = await waitFor(() => running.querySelector('.live-task-output-note:not([hidden])'),
        'the failed stop to show its note');
      assert(!!note, 'a failed stop showed no note');
      assertPseudoLocalized(running, { atLeast: 4, where: 'running, stop failed' });

      // A task whose process is gone, that had dropped the middle of its output.
      const gone = document.createElement('div');
      let reads = 0;
      renderLiveTaskOutput(gone, {
        taskId: '3',
        helpers,
        pollMs: 10,
        initialState: { status: 'not_found', truncated: true, outputFile: '/4/5' },
        readOutput: async () => { reads++; return { status: 'not_found' }; },
      });
      // Painted from initialState at once; checked after the first read has
      // repainted it from the registry's answer too. The repaint follows the
      // read in the same task, so a later poll that sees the read sees it.
      await waitFor(() => reads > 0, 'the first read of the gone task');
      assertPseudoLocalized(gone, { atLeast: 3, where: 'not found, spilled' });
    });
  });

  return { passed, failed, errors };
}
