//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Live "Output" section for a background task, for the properties panel.
 *
 * A background task (bash's `run_in_background`, Monitor) outlives the tool call
 * that started it, and its stdout is nowhere in the conversation document — the
 * tool result only tells the model the task id and how to read it. The shell
 * registry keeps the accumulated buffer server-side and exposes it through the
 * cumulative `shellOutput` op, so this section polls that buffer and shows the
 * user what the task is actually printing.
 *
 * Cumulative `shellOutput` — never `shellOutputDelta`, which advances the read
 * cursor the TaskOutput tool reads from and would steal output from the model.
 * Growth is append-only against a locally tracked length, so a poll never
 * rebuilds the node (which would reset the reader's scroll position); a rare
 * buffer shrink (head+tail capping rewrites the string) costs one rebuild, after
 * which appends resume. Polling stops as soon as the section is detached or the
 * task stops running, so a finished task is fetched exactly once more and then
 * left alone.
 *
 * The poll itself is read-only. The one write path is the optional Stop button,
 * which a caller opts into by passing `onStop`; its click handler is the only
 * place this module mutates anything.
 * @module sdk/lib/live-task-output
 */

import { shellOutput } from 'juggler/ops';
import { ansiToFragment, applyAnsi, stripAnsi } from './ansi.js';
import { createCopyButton } from './copy-button.js';
import { extractErrorMessage } from './error-utils.js';
import { t } from './i18n.js';

/** Default gap between polls of a running task, in ms. */
const DEFAULT_POLL_MS = 1000;

/**
 * A `shellOutput` result, narrowed to the fields this section reads.
 * @typedef {object} TaskOutputState
 * @property {string} [status] - "running" | "completed" | "failed" | "not_found"
 * @property {string} [output] - The accumulated output so far
 * @property {number} [exitCode] - Exit code once the task has ended
 * @property {string} [error] - Failure message, when the task failed
 * @property {string} [outputFile] - Spill file holding the complete output
 * @property {boolean} [truncated] - Whether the buffer above dropped its middle
 */

/**
 * Append a live output section for `taskId` to a properties-panel wrapper.
 * @param {HTMLElement} wrapper - Section container to append into.
 * @param {object} opts
 * @param {string} opts.taskId - Background task id to read.
 * @param {import('../context-item-types.js').ToolActionRenderHelpers} opts.helpers - The panel helpers passed to `renderToolActionDetails`.
 * @param {string} [opts.label] - Section heading (default "Output").
 * @param {number} [opts.pollMs] - Gap between polls while running.
 * @param {(state: TaskOutputState) => boolean} [opts.isRunning] - Whether to keep
 *   polling. Defaults to the task's own reported status; Monitor overrides it to
 *   follow its delivery binding instead.
 * @param {(state: TaskOutputState) => string} [opts.describeStatus] - When given,
 *   a status line above the output, repainted from each poll.
 * @param {() => unknown} [opts.onStop] - When given, a Stop button shown
 *   only while the task is running. Callers that already offer a kill elsewhere
 *   (Monitor's delivery control) leave this unset.
 * @param {string} [opts.stopLabel] - Stop button text (default "Stop").
 * @param {TaskOutputState} [opts.initialState] - Durable state shown before and
 *   underneath live registry reads.
 * @param {string} [opts.convId] - The conversation this task belongs to. Sent with
 *   every read so the server can refuse an id that names another conversation's
 *   task; omitting it falls back to the project check alone.
 * @param {(params: {taskId: string, convId?: string}) => Promise<TaskOutputState>} [opts.readOutput]
 *   Output reader; injectable for deterministic tests.
 * @returns {HTMLElement|null} The section element, or null if it wasn't rendered.
 */
export function renderLiveTaskOutput(wrapper, {
  taskId,
  helpers,
  label = t('Output'),
  pollMs = DEFAULT_POLL_MS,
  isRunning = (state) => state.status === 'running',
  describeStatus,
  onStop,
  stopLabel = t('Stop'),
  initialState,
  convId,
  readOutput = shellOutput
}) {
  if (!taskId || !helpers) return null;

  const section = helpers.labeledSubsection(label);

  const statusEl = describeStatus ? document.createElement('div') : null;
  if (statusEl) {
    statusEl.className = 'properties-panel-text live-task-output-status';
    section.appendChild(statusEl);
  }

  // Hidden until a poll reports the task running, so a task that ended before
  // the panel opened never offers a Stop that would do nothing. Toggled through
  // inline `display` rather than the `hidden` attribute, which loses to
  // `.properties-panel-btn { display: flex }` on specificity.
  // Bound to a const so the null check below narrows inside the click handler.
  const stopTask = onStop;
  const stopBtn = stopTask ? document.createElement('button') : null;
  const stopError = stopTask ? document.createElement('div') : null;
  if (stopTask && stopBtn && stopError) {
    stopBtn.type = 'button';
    stopBtn.className = 'properties-panel-btn danger live-task-output-stop';
    stopBtn.textContent = stopLabel;
    stopBtn.style.display = 'none';
    stopError.className = 'properties-panel-text live-task-output-note';
    stopError.hidden = true;
    // The only state mutation in this module; every other path here reads.
    stopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      stopBtn.disabled = true;
      stopError.hidden = true;
      void (async () => {
        try {
          await stopTask();
        } catch (err) {
          stopError.hidden = false;
          stopError.textContent = t('Couldn\'t stop the task — {error}', { error: extractErrorMessage(err) });
          stopBtn.disabled = false;
          return;
        }
        // Repaint now rather than at the next interval, so the status line and
        // this button reflect the kill immediately.
        void tick();
      })();
    });
    section.appendChild(stopBtn);
    section.appendChild(stopError);
  }

  // Built here rather than through `helpers.createCopyableText` because that
  // binds the copy button to the text it was created with — this text grows, so
  // the button has to resolve it at click time.
  let text = '';
  const copyable = document.createElement('div');
  copyable.className = 'properties-panel-copyable';
  const copyHeader = document.createElement('div');
  copyHeader.className = 'properties-panel-copy-header';
  copyHeader.appendChild(createCopyButton(() => stripAnsi(text)));
  copyable.appendChild(copyHeader);
  const pre = document.createElement('pre');
  // Same class the finished-result box uses, so live terminal output is laid out
  // monospaced and column-aligned rather than as prose.
  pre.className = 'properties-panel-result';
  pre.textContent = t('(no output yet)');
  copyable.appendChild(pre);
  section.appendChild(copyable);

  // Only shown once the server reports it dropped the middle of the buffer.
  const spillNote = document.createElement('div');
  spillNote.className = 'properties-panel-text live-task-output-note';
  spillNote.hidden = true;
  section.appendChild(spillNote);

  wrapper.appendChild(section);

  let placeholderShown = true;

  /**
   * Grow the rendered output to match the server's buffer.
   * @param {string} next - The full accumulated output from this poll.
   */
  const applyOutput = (next) => {
    if (next.length === 0 || next === text) return;
    if (placeholderShown) {
      pre.textContent = '';
      placeholderShown = false;
      text = '';
    }
    if (next.length < text.length || !next.startsWith(text)) {
      applyAnsi(pre, next);
    } else {
      pre.appendChild(ansiToFragment(next.slice(text.length)));
    }
    text = next;
  };

  /** @param {TaskOutputState} state */
  const paintState = (state) => {
    applyOutput(typeof state.output === 'string' ? state.output : '');
    if (placeholderShown && state.status === 'not_found') pre.textContent = t('(no output available)');
    if (statusEl && describeStatus) statusEl.textContent = describeStatus(state);
    if (state.truncated && state.outputFile) {
      spillNote.hidden = false;
      spillNote.textContent = t('Middle dropped — the complete output is in {file}', { file: state.outputFile });
    }
  };

  let persistedState = initialState;
  if (persistedState) paintState(persistedState);

  let timer = /** @type {ReturnType<typeof setInterval>|null} */ (null);
  const stopPolling = () => {
    if (timer !== null) { clearInterval(timer); timer = null; }
  };

  // The panel builds its sections into a detached wrapper and appends it once,
  // so "not connected" means "not mounted yet" until the section has been seen
  // connected — only after that does it mean the panel has moved on.
  // A section that is never mounted at all (the panel threw the wrapper away)
  // would otherwise poll forever, so give that up after a few attempts.
  let wasConnected = false;
  let unmountedPolls = 0;
  const gone = () => {
    if (section.isConnected) { wasConnected = true; return false; }
    return wasConnected || ++unmountedPolls > 5;
  };

  /** One poll: read the buffer, grow the output, stop once the task is done. */
  const tick = async () => {
    if (gone()) { stopPolling(); return; }
    /** @type {TaskOutputState} */
    let state;
    try {
      state = await readOutput({ taskId, convId });
    } catch {
      return;
    }
    if (gone()) { stopPolling(); return; }

    // A missing live handle says nothing about historical data. A terminal
    // durable snapshot is authoritative after restart/reaping; a running one
    // contributes its last output while not_found honestly reports that the
    // process itself can no longer be reached.
    if (state.status === 'not_found' && persistedState) {
      if (persistedState.status === 'completed' || persistedState.status === 'failed') {
        state = persistedState;
      } else {
        state = { ...persistedState, status: 'not_found' };
      }
    } else if (state.status !== 'not_found') {
      persistedState = state;
    }
    paintState(state);

    const running = isRunning(state);
    if (stopBtn) {
      stopBtn.style.display = running ? '' : 'none';
      stopBtn.disabled = false;
    }
    if (!running) stopPolling();
  };

  // First read deferred to the next task so the panel has mounted the wrapper by
  // then, and the section shows what the task has already printed straight away
  // rather than a poll interval later.
  setTimeout(() => { void tick(); }, 0);
  timer = setInterval(() => { void tick(); }, pollMs);

  return section;
}
