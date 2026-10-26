//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import PinboardItemType from 'juggler/pinboard-item-type';
import { translator } from 'juggler/i18n';
import { createElement, errorText, injectStylesOnce } from 'juggler/ui';
import { reconcileParts, reconcileRows, setText } from '../lib/reconcile.js';
import { pinEmpty } from '../lib/pin-empty.js';

const t = translator('@juggler/core');

injectStylesOnce('tasks-pin-styles', `
.tasks-pin {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  height: 100%;
}
.tasks-pin__groups {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.tasks-pin__group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.tasks-pin__heading {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  font-weight: 600;
  overflow-wrap: anywhere;
}
.tasks-pin__here {
  color: var(--text-tertiary);
  font-weight: normal;
}
.tasks-pin__list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.tasks-pin__row {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.5rem;
  border: 0.0625rem solid var(--border-color);
  border-radius: var(--radius-md, 0.25rem);
}
.tasks-pin__open {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  width: 100%;
  min-width: 0;
  padding: 0;
  border: none;
  border-radius: var(--radius-md, 0.25rem);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.tasks-pin__open:hover .tasks-pin__command {
  text-decoration: underline;
}
.tasks-pin__command {
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.tasks-pin__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.5rem;
  color: var(--text-tertiary);
  font-size: var(--font-size-sm);
}
.tasks-pin__tool {
  font-family: var(--font-mono);
}
.tasks-pin__kind {
  text-transform: lowercase;
}
.tasks-pin__label {
  color: var(--text-secondary);
}
.tasks-pin__elapsed {
  margin-left: auto;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.tasks-pin__actions {
  display: flex;
  justify-content: flex-end;
}
.tasks-pin__stop {
  padding: 0.25rem 0.5rem;
  border: 0.0625rem solid var(--border-color);
  border-radius: var(--radius-md, 0.25rem);
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--font-size-sm);
  cursor: pointer;
}
.tasks-pin__stop:hover:not(:disabled) {
  border-color: var(--error-color, var(--border-color));
  color: var(--error-color, var(--text-primary));
}
.tasks-pin__stop:disabled {
  cursor: default;
  opacity: 0.5;
}
.tasks-pin__note {
  color: var(--text-tertiary);
}
.tasks-pin__error {
  color: var(--error-color, var(--text-secondary));
  overflow-wrap: anywhere;
}
.tasks-pin__note {
  margin-top: auto;
  font-size: var(--font-size-sm);
}
`);

/** How much of a command line to show before it is cut short. */
const COMMAND_LIMIT = 160;

/**
 * How often the elapsed times are redrawn. The host speaks only when the set of
 * running tasks changes, which for a build that has been going for ten minutes is
 * never — so a clock of the pin's own is what keeps "10m" from being a stopped
 * one. It writes nothing but those words.
 */
const ELAPSED_TICK_MS = 1000;

/**
 * How long a task has been running, in the coarsest unit that still says
 * something. Seconds below a minute, then minutes, then hours: nobody watching a
 * two-hour build needs it to the second.
 * @param {number} startedAt - Unix ms the task started.
 * @param {number} now - Unix ms now.
 * @returns {string} An elapsed time, or '' when the start time is not known yet.
 */
function elapsed(startedAt, now) {
  if (!Number.isFinite(startedAt)) return '';
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  if (seconds < 60) return t('{seconds}s', { seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('{minutes}m', { minutes });
  return t('{hours}h {minutes}m', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

/**
 * What kind of process a task is, in a word, for when the transcript that would
 * name its tool is not loaded here.
 * @param {string} kind - The task's kind.
 * @returns {string} The word.
 */
function kindWord(kind) {
  switch (kind) {
    case 'background': return t('background');
    case 'python': return t('python');
    default: return t('foreground');
  }
}

/**
 * One task's card: the command it is running, then a line of what is known about
 * it — the tool it came from, what it was for, how long it has been at it — and
 * the way to stop it. A card rather than a line because a handful of tasks is all
 * there ever is, so there is room to say each thing in its own place instead of
 * fitting them all between two ellipses.
 *
 * The card is keyed by task id, so the id the Stop button hands back is the same
 * id the card was built for however long it stands. The task to reveal is looked
 * up by that id at click time, so a click acts on the task as it is now.
 * @param {import('juggler/pinboard-item-type').PinTask} task - The running task.
 * @param {(taskId: string) => void} reveal - Go to the action that started it.
 * @param {(taskId: string, button: HTMLButtonElement) => void} stop - Stop it.
 * @returns {HTMLElement} The card.
 */
function buildTaskRow(task, reveal, stop) {
  const row = createElement('div', 'tasks-pin__row');
  const taskId = task.taskId;

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'tasks-pin__open';
  open.append(createElement('span', 'tasks-pin__command'), createElement('div', 'tasks-pin__meta'));
  open.addEventListener('click', () => reveal(taskId));

  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.className = 'tasks-pin__stop';
  stopBtn.textContent = t('Stop');
  stopBtn.addEventListener('click', () => stop(taskId, stopBtn));

  const actions = createElement('div', 'tasks-pin__actions');
  actions.appendChild(stopBtn);

  row.append(open, actions);
  return row;
}

/**
 * One field of the meta line, when there is something to put in it.
 * @param {string} key - Its place in the line.
 * @param {string} className - The class it is styled by.
 * @param {string} text - What it says.
 * @returns {import('../lib/reconcile.js').PartSpec} The field.
 */
function metaField(key, className, text) {
  return {
    key,
    build: () => createElement('span', className),
    fill: (el) => setText(el, text),
  };
}

/**
 * Write one task's current words into its card.
 * @param {HTMLElement} row - The card for this task.
 * @param {import('juggler/pinboard-item-type').PinTask} task - The running task.
 * @param {number} now - Unix ms, so every card in one render agrees on the time.
 * @returns {void}
 */
function fillTaskRow(row, task, now) {
  const open = /** @type {HTMLElement} */ (row.querySelector('.tasks-pin__open'));
  const stopBtn = /** @type {HTMLElement} */ (row.querySelector('.tasks-pin__stop'));
  const name = task.command || task.toolName || kindWord(task.kind);

  // The tick reads the start time from here, so it can redraw an elapsed time
  // without the task list in front of it.
  if (row.dataset.at !== String(task.at)) row.dataset.at = String(task.at);

  const reveals = t('Reveal the action that started {name}', { name });
  if (open.getAttribute('aria-label') !== reveals) open.setAttribute('aria-label', reveals);
  const stops = t('Stop {name}', { name });
  if (stopBtn.getAttribute('aria-label') !== stops) stopBtn.setAttribute('aria-label', stops);

  setText(
    /** @type {HTMLElement} */ (open.querySelector('.tasks-pin__command')),
    name.length > COMMAND_LIMIT ? `${name.slice(0, COMMAND_LIMIT)}…` : name
  );

  /** @type {import('../lib/reconcile.js').PartSpec[]} */
  const meta = [];
  // Which tool a command came from is worth a word, except when the command line
  // is the tool's own name and saying it twice would be the only thing said.
  // Without the transcript to name the tool, how the process runs is the word.
  if (task.command && task.toolName) meta.push(metaField('tool', 'tasks-pin__tool', task.toolName));
  else meta.push(metaField('kind', 'tasks-pin__kind', kindWord(task.kind)));
  if (task.label) meta.push(metaField('label', 'tasks-pin__label', task.label));
  const since = elapsed(task.at, now);
  if (since) meta.push(metaField('elapsed', 'tasks-pin__elapsed', since));
  reconcileParts(/** @type {HTMLElement} */ (open.querySelector('.tasks-pin__meta')), meta);
}

/**
 * The tasks, in groups by the conversation that started them, in the order the
 * list put them — the conversation being read first.
 * @param {import('juggler/pinboard-item-type').PinTask[]} tasks - The running tasks.
 * @returns {{conversationId: string, title: string, tasks: import('juggler/pinboard-item-type').PinTask[]}[]} The groups.
 */
function groupByConversation(tasks) {
  /** @type {Map<string, {conversationId: string, title: string, tasks: import('juggler/pinboard-item-type').PinTask[]}>} */
  const groups = new Map();
  for (const task of tasks) {
    let group = groups.get(task.conversationId);
    if (!group) {
      group = { conversationId: task.conversationId, title: task.conversationTitle, tasks: [] };
      groups.set(task.conversationId, group);
    }
    group.tasks.push(task);
  }
  return [...groups.values()];
}

/**
 * TasksPin — the session's task manager: every command the conversations in
 * this project have running, background and foreground alike, grouped by the
 * conversation that started it.
 *
 * A live inventory, and only that. A task appears when it starts and is gone the
 * moment it ends, whether it finished, failed or was stopped — so there is no
 * retention to configure and nothing to clear. Its history is not lost by being
 * absent from here: it is on the tool action that started it, which is where the
 * output, the exit code and the approval already live, and which is exactly where
 * a row goes when clicked.
 *
 * That division is also why the pin shows no output of its own. A running
 * command's output can hold anything the command touched, and the tool action
 * already displays it under rules that already exist; a second copy on a board
 * that may be open in another window would be a new place for it to appear and no
 * new way to read it.
 *
 * It lists what Juggler started. A shell command that daemonised something, or
 * anything started outside Juggler, is not here and cannot be — nothing ties a
 * process on this machine to a conversation unless Juggler started it.
 * @class
 * @augments PinboardItemType
 */
class TasksPin extends PinboardItemType {
  /** @type {import('juggler/pinboard-item-type').PinboardItemManifest} */
  static MANIFEST = {
    id: 'tasks',
    name: 'Running tasks',
    version: '2.0.0',
    description: "Lists every command this project's conversations are running",
    order: 50,
    defaultPin: true,
  };

  /**
   * The list is the project's, so there is always something to show.
   * @returns {true} Always.
   */
  canAdd() {
    return true;
  }

  /**
   * The tasks themselves, wherever a surface offers to show them — a background
   * run's properties panel and its card's Background badge.
   * @param {import('juggler/pinboard-item-type').PinSource} source - The source to pin.
   * @returns {boolean} True for the tasks.
   */
  static canPinSource(source) {
    return source?.kind === 'tasks';
  }

  /**
   * The pin lists whatever the project is running, so a request to show it
   * carries nothing: an empty config is the whole of it.
   * @returns {Record<string, any>} The config.
   */
  static configFromSource() {
    return {};
  }

  /**
   * The name, and nothing else: each group names its own conversation.
   * @returns {import('juggler/pinboard-item-type').PinDescription} The tab's words.
   */
  describe() {
    return { title: t(this.name) };
  }

  /**
   * @param {HTMLElement} container - The body to fill.
   * @param {import('juggler/pinboard-item-type').PinContext} pinContext - The pin and its context.
   * @returns {import('juggler/pinboard-item-type').PinController} The controller.
   */
  mount(container, pinContext) {
    let context = pinContext;
    const body = createElement('div', 'tasks-pin');
    container.replaceChildren(body);

    /** The last stop attempt's complaint, cleared by the next render that succeeds. */
    let stopError = '';

    /**
     * @param {string} taskId - The task to stop.
     * @param {HTMLButtonElement} button - Its Stop control, dimmed while the stop is in flight.
     */
    const stop = (taskId, button) => {
      button.disabled = true;
      Promise.resolve(context.services.tasks.stop(taskId))
        .then(() => {
          stopError = '';
        })
        .catch((err) => {
          stopError = errorText(err);
          render();
        });
    };

    /**
     * The tasks as last rendered, by id, so a click reveals the task as it is
     * rather than as it was when its card was built.
     * @type {Map<string, import('juggler/pinboard-item-type').PinTask>}
     */
    let shown = new Map();

    /**
     * @param {string} taskId - The task whose action to go to.
     * @returns {void}
     */
    const reveal = (taskId) => {
      const task = shown.get(taskId);
      if (task) context.services.tasks.reveal(task);
    };

    /** @type {ReturnType<typeof setInterval>|null} The elapsed-time clock, while anything is running. */
    let ticker = null;

    /**
     * Redraw the elapsed times, and only those. Every other word on a row comes
     * from the task list, which has not been read again.
     * @returns {void}
     */
    const tick = () => {
      const now = Date.now();
      for (const row of Array.from(body.querySelectorAll('.tasks-pin__row'))) {
        const el = row.querySelector('.tasks-pin__elapsed');
        if (!el) continue;
        setText(/** @type {HTMLElement} */ (el), elapsed(Number(/** @type {HTMLElement} */ (row).dataset.at), now));
      }
    };

    /** @returns {void} */
    const stopClock = () => {
      if (ticker === null) return;
      clearInterval(ticker);
      ticker = null;
    };

    /** @returns {void} */
    const startClock = () => {
      if (ticker === null) ticker = setInterval(tick, ELAPSED_TICK_MS);
    };

    const render = () => {
      const tasks = context.services.tasks.list();
      const error = context.services.tasks.error();
      const now = Date.now();
      const here = context.active?.conversation?.id || '';
      shown = new Map((tasks || []).map((task) => [task.taskId, task]));

      /** @type {import('../lib/reconcile.js').PartSpec[]} */
      const parts = [];

      if (!tasks || !tasks.length) {
        // A null list is not the same as an empty one, and saying what the card
        // holds before anything has been asked would be a guess.
        const words = tasks === null
          ? t('Looking…')
          : t('Commands running in this project appear here.');
        parts.push({
          key: 'empty',
          build: () => pinEmpty(''),
          fill: (el) => setText(el, words),
        });
      } else {
        parts.push({
          key: 'groups',
          build: () => createElement('div', 'tasks-pin__groups'),
          fill: (el) => reconcileRows(
            el,
            groupByConversation(tasks),
            (group) => group.conversationId,
            () => {
              const section = createElement('section', 'tasks-pin__group');
              const heading = createElement('h3', 'tasks-pin__heading');
              heading.append(createElement('span', 'tasks-pin__title'), createElement('span', 'tasks-pin__here'));
              section.append(heading, createElement('div', 'tasks-pin__list'));
              return section;
            },
            (section, group) => {
              setText(/** @type {HTMLElement} */ (section.querySelector('.tasks-pin__title')),
                group.title || (group.conversationId ? t('Untitled') : t('No conversation')));
              const marker = /** @type {HTMLElement} */ (section.querySelector('.tasks-pin__here'));
              setText(marker, t('this conversation'));
              const isHere = Boolean(group.conversationId) && group.conversationId === here;
              if (marker.hidden === isHere) marker.hidden = !isHere;
              reconcileRows(
                /** @type {HTMLElement} */ (section.querySelector('.tasks-pin__list')),
                group.tasks,
                (task) => task.taskId,
                (task) => buildTaskRow(task, reveal, stop),
                (row, task) => fillTaskRow(row, task, now)
              );
            }
          ),
        });
      }

      // Both failures keep the list beside them: a check that failed does not
      // mean the tasks stopped, and a stop that failed does not mean the list is
      // wrong. The underlying text is shown as it came back.
      if (error) {
        parts.push({
          key: 'error',
          build: () => createElement('div', 'tasks-pin__error'),
          fill: (el) => setText(el, t("Couldn't check what's running. {error}", { error })),
        });
      }
      if (stopError) {
        parts.push({
          key: 'stop-error',
          build: () => createElement('div', 'tasks-pin__error'),
          fill: (el) => setText(el, t("Couldn't stop it. {error}", { error: stopError })),
        });
      }

      // Always present, because it is what the list means rather than a remark
      // about it: without it an empty card reads as the whole machine.
      parts.push({
        key: 'note',
        build: () => createElement('div', 'tasks-pin__note'),
        fill: (el) => setText(el, t("Only what this project's conversations started, and only while it runs.")),
      });
      reconcileParts(body, parts);

      // Nothing on screen has an elapsed time to keep, so nothing is counting.
      if (tasks && tasks.length) startClock();
      else stopClock();
    };

    const stopWatching = context.services.tasks.onChange(render);
    render();

    return {
      update: (next) => {
        context = next;
        render();
      },
      teardown: () => {
        stopClock();
        stopWatching();
      },
    };
  }
}

export default TasksPin;
