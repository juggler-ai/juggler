//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The progress info card — how far the visible conversation is through its plan
 * and its todo list, as one thin strip each.
 *
 * It is there only while there is work in flight: a plan with steps that has not
 * yet completed, a checklist with something left unticked. The rest of the time
 * it is absent rather than empty, because an ambient card saying "no plan" would
 * be saying it in almost every conversation.
 *
 * Which plan it shows is the Plan pin's answer, from the same resolution
 * (`findReaderContextItem`): the reader's thread, else the
 * nearest ancestor with one. Each strip is the way in to its pin, so the card and
 * the pin it opens must never be describing different lists. Like the Git status
 * card, it names a source kind and lets the registry find the pin.
 * @module extensions/juggler-core/cards/task-progress-card
 */

import InfoCardType from 'juggler/info-card-type';
import { translator, markForTranslation } from 'juggler/i18n';
import { pinSource, canPinSource, findReaderContextItem, onReaderThreadChange } from 'juggler/ui';
import { taskProgress, createProgressBar } from '../lib/task-lists.js';

const t = translator('@juggler/core');

/**
 * How long a burst of document changes is gathered before the lists are read
 * again. `conversation:changed` fires for every streamed delta and reading a list
 * walks the thread's items, so a turn would otherwise re-read at the sync rate;
 * a strip that lags a step by a tenth of a second is not something anyone sees.
 * @type {number}
 */
export const FOLLOW_MS = 100;

/**
 * One list the card can show: where it lives, what counts as finished, and the
 * words for it.
 * @typedef {object} TaskListKind
 * @property {'plan'|'todo'} kind - The context-item type, which is also the pin source kind.
 * @property {(data: Record<string, any>) => Array<Record<string, any>>} itemsOf - The list inside the item's data.
 * @property {(data: Record<string, any>, items: Array<Record<string, any>>) => boolean} active - Whether work remains.
 * @property {string} label - The row's name (markForTranslation).
 * @property {string} summary - The row's full reading (markForTranslation), with {completed} and {total}.
 * @property {string} open - What clicking the row does (markForTranslation).
 */

/** @type {TaskListKind[]} */
const KINDS = [
  {
    kind: 'plan',
    itemsOf: (data) => data?.steps || [],
    // A plan whose steps are all settled is marked completed by the plan tool,
    // failed and skipped steps included, so the plan's own status is the answer.
    active: (data, items) => items.length > 0 && data?.status !== 'completed',
    label: markForTranslation('Plan'),
    summary: markForTranslation('Plan: {completed} of {total, plural, one {# step} other {# steps}} done'),
    open: markForTranslation('Open the plan in the Pinboard'),
  },
  {
    kind: 'todo',
    itemsOf: (data) => data?.todos || [],
    active: (_data, items) => items.some((item) => item?.status !== 'completed'),
    label: markForTranslation('Todos'),
    summary: markForTranslation('Todos: {completed} of {total, plural, one {# item} other {# items}} done'),
    open: markForTranslation('Open the todo list in the Pinboard'),
  },
];

/**
 * A list the card is showing: its kind, its items, and how many are done.
 * @typedef {{spec: TaskListKind, items: Array<Record<string, any>>, completed: number, total: number}} ActiveList
 */

/**
 * The lists with work still in them, plan first, in the conversation on screen.
 * @param {import('../../../js/model/session.js').default|undefined} session - The window's session.
 * @returns {ActiveList[]} One entry per active list.
 */
function activeLists(session) {
  /** @type {ActiveList[]} */
  const lists = [];
  for (const spec of KINDS) {
    const found = findReaderContextItem(session, spec.kind);
    if (!found) continue;
    const data = found.item.data || {};
    const items = spec.itemsOf(data);
    if (!spec.active(data, items)) continue;
    lists.push({ spec, items, ...taskProgress(items) });
  }
  return lists;
}

/**
 * Call `onChange` whenever the visible conversation's lists may have moved: a
 * document change in it (gathered over {@link FOLLOW_MS}), or a deliberate act —
 * switching conversation, moving between threads — which is answered at once.
 * @param {any} session - The window's session.
 * @param {() => void} onChange - Re-read the lists.
 * @returns {() => void} Stop following.
 */
function follow(session, onChange) {
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  const now = () => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    onChange();
  };
  /** @param {{type: string, data?: any}} event - A session event. */
  const onSession = (event) => {
    switch (event.type) {
      case 'conversation:changed':
      case 'context-items:changed': {
        // Every conversation in the session emits these; a turn streaming in a
        // tab nobody is looking at says nothing about the one on screen.
        const changed = event.data?.conversationId;
        if (changed && changed !== session.getVisibleConversation?.()?.id) return;
        if (timer === null) timer = setTimeout(now, FOLLOW_MS);
        return;
      }
      case 'conversation:switched':
      case 'conversation:deleted':
      case 'session:loaded':
        now();
        return;
      default:
        return;
    }
  };
  const unsubscribe = session?.subscribe?.(onSession);
  const stopFocus = onReaderThreadChange(now);
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (typeof unsubscribe === 'function') unsubscribe();
    stopFocus();
  };
}

/**
 * One list as a row: its name, the strip, and the count. A button that opens the
 * list's pin when there is a pin to open; otherwise just the reading.
 *
 * The strip is the plan and todo pins' own bar ({@link createProgressBar}), so
 * the card and the pin it opens colour the same states the same way.
 * @param {ActiveList} list - The list to draw.
 * @returns {HTMLElement} The row.
 */
function row(list) {
  const { spec, items, completed, total } = list;
  const source = { kind: spec.kind };
  const summary = t(spec.summary, { completed, total });
  /** @type {HTMLElement} */
  let el;
  if (canPinSource(source)) {
    const button = document.createElement('button');
    button.className = 'info-card__task-row';
    button.type = 'button';
    button.title = t(spec.open);
    // addSource dedupes: the pin is a singleton, so a second click reveals the
    // one already there.
    button.addEventListener('click', () => { void pinSource(source); });
    el = button;
  } else {
    const group = document.createElement('div');
    group.className = 'info-card__task-row';
    group.setAttribute('role', 'group');
    group.title = summary;
    el = group;
  }
  el.dataset.kind = spec.kind;
  el.setAttribute('aria-label', summary);

  const name = document.createElement('span');
  name.className = 'info-card__task-name';
  name.textContent = t(spec.label);

  // An active list always has items, so there is always a bar.
  const strip = /** @type {HTMLElement} */ (createProgressBar(items));

  const count = document.createElement('span');
  count.className = 'info-card__task-count';
  count.textContent = t('{completed}/{total}', { completed, total });

  el.append(name, strip, count);
  return el;
}

/**
 * The progress info card.
 */
export default class TaskProgressCard extends InfoCardType {
  /** @type {import('juggler/info-card-type').InfoCardManifest} */
  static MANIFEST = {
    id: 'task-progress',
    name: 'Plan & todos',
    version: '1.0.0',
    description: "Show how far the visible conversation is through its plan and todo list, while either has work left.",
    eyebrow: 'Progress',
    // Above Usage and Git status: work in flight is the most current thing the
    // sidebar can say, and the card is only there while it is.
    priority: 30,
  };

  /**
   * @param {import('../../../js/model/session.js').default} [session] - The window's session.
   * @returns {boolean} True while the visible conversation has a plan or todo list in progress.
   */
  hasContent(session) {
    return activeLists(session).length > 0;
  }

  /**
   * Tell the rail when the card should come or go. Only a change of answer is
   * passed on: the rail re-asks every card when told, and the lists move far more
   * often than whether there are any.
   * @param {any} session - The window's session.
   * @param {() => void} onChange - Ask the rail to re-ask.
   * @returns {() => void} Stop watching.
   */
  watchContent(session, onChange) {
    let showing = this.hasContent(session);
    return follow(session, () => {
      const next = this.hasContent(session);
      if (next === showing) return;
      showing = next;
      onChange();
    });
  }

  /**
   * Draw the strips and keep them current. A list that has just finished is
   * dropped from the card here; the rail takes the card away once there are none.
   * @param {HTMLElement} contentEl - The content region.
   * @param {any} [session] - The window's session.
   * @returns {() => void} Teardown.
   */
  mount(contentEl, session = undefined) {
    /** @type {string|null} */
    let drawn = null;
    const render = () => {
      const lists = activeLists(session);
      const signature = JSON.stringify([
        // Every status, not just the count done: a step starting changes the bar.
        lists.map((l) => [l.spec.kind, l.items.map((item) => item?.status)]),
        canPinSource({ kind: 'plan' }),
        canPinSource({ kind: 'todo' }),
      ]);
      if (signature === drawn) return;
      drawn = signature;
      contentEl.replaceChildren(...lists.map(row));
    };
    render();
    return follow(session, render);
  }
}
