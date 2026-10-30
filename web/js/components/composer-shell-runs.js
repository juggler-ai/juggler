//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The composer's share of `! cmd`: a cue while the box holds one, and a row per
 * command still running in the composer's thread, each with a Stop button.
 *
 * The output itself lands in the transcript as a `shell-output` item when the
 * command ends (services/user-shell.js); until then this row is the only sign it
 * is running.
 * @module components/composer-shell-runs
 */

import { runningUserShells, onUserShellsChange, shellShortcutCommand } from '../services/user-shell.js';
import { t } from '../../sdk/lib/i18n.js';

/** @typedef {import('../model/message-thread.js').MessageThread} MessageThread */

/**
 * Mark the box while its text is a `! cmd`, so the user sees before sending
 * that it will run in the shell rather than go to the model.
 * @param {HTMLElement} composer - The composer box
 * @param {string} text - The text in it
 */
export function updateShellInputCue(composer, text) {
  composer.toggleAttribute('shell-input', shellShortcutCommand(text) !== null);
}

/**
 * Draw the commands running in a thread into the composer's row, hiding the
 * row when there are none.
 * @param {HTMLElement} composer - The composer box
 * @param {MessageThread|null|undefined} messageThread - The thread the composer writes to
 */
export function renderShellRuns(composer, messageThread) {
  const row = /** @type {HTMLElement|null} */ (composer.querySelector('composer-shell-runs'));
  if (!row) return;
  const runs = runningUserShells(messageThread);
  row.replaceChildren();
  row.hidden = runs.length === 0;
  for (const run of runs) {
    const item = document.createElement('div');
    item.className = 'shell-run';
    item.dataset.runId = run.id;

    const label = document.createElement('span');
    label.className = 'shell-run-label';
    label.textContent = t('Running');
    const command = document.createElement('code');
    command.className = 'shell-run-command';
    command.textContent = `$ ${run.command}`;
    command.title = run.command;

    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'shell-run-stop';
    stop.textContent = t('Stop');
    stop.setAttribute('aria-label', t('Stop {command}', { command: run.command }));
    stop.addEventListener('click', () => {
      stop.disabled = true;
      run.stop();
    });

    item.append(label, command, stop);
    row.appendChild(item);
  }
}

/**
 * Keep the composer's row in step with the commands running in its thread.
 * @param {HTMLElement} composer - The composer box
 * @param {() => MessageThread|null|undefined} currentThread - The thread the composer writes to now
 * @returns {() => void} Stop following them
 */
export function followShellRuns(composer, currentThread) {
  renderShellRuns(composer, currentThread());
  return onUserShellsChange(() => renderShellRuns(composer, currentThread()));
}
