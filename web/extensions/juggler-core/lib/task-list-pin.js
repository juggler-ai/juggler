//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The body shared by the Plan and Todo pins: find the nearest list, say whose it
 * is, render it, and offer the way back to it.
 *
 * The two pins differ only in which context item they read, where the list sits
 * inside it, how it renders, and what it says when there isn't one. Everything
 * else — the resolution order, the source line, re-reading on a change, the
 * reveal action — is one behaviour, and it lives here so the two cannot drift.
 *
 * Both are read-only. Ticking a box would have to go through the same
 * approval-gated tool path the assistant uses, whose semantics are wholesale
 * list replacement; until that is designed, a pin shows the list and does not
 * pretend to own it.
 * @module lib/task-list-pin
 */

import { createElement, injectStylesOnce } from 'juggler/ui';
import { translator } from 'juggler/i18n';
import { pinEmpty } from './pin-empty.js';

const t = translator('@juggler/core');

injectStylesOnce('task-list-pin-styles', `
.task-list-pin {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  height: 100%;
}

.task-list-pin__source {
  color: var(--text-tertiary);
  font-size: var(--font-size-sm);
}
`);

/**
 * What to say above the list about where it came from. Silent for the thread the
 * user is already reading — naming the obvious on every render is noise — and
 * explicit the moment it belongs to something else, because a plan attributed to
 * the wrong thread is worse than no plan at all.
 * @param {import('juggler/pinboard-item-type').PinContextItemSource} source - Where the item was found.
 * @returns {string} The line to show, or '' to show none.
 */
function sourceLine(source) {
  if (!source?.inherited) return '';
  return source.label ? t('From {label}', { label: source.label }) : t('From a parent thread');
}

/**
 * How one task-list pin differs from the other.
 * @typedef {object} TaskListPinSpec
 * @property {string} itemType - The context-item type to look for, e.g. 'plan'
 * @property {(data: Record<string, any>) => Array<Record<string, any>>} itemsOf - The list inside that item's data
 * @property {(data: Record<string, any>, items: Array<Record<string, any>>) => HTMLElement} render - The list as an
 *   element, given the item's whole data (a plan's title and status live there
 *   too) and the list `itemsOf` already took out of it
 * @property {string} empty - What to say when no thread in the chain has one:
 *   English source text (`markForTranslation`), translated here where it is drawn
 */

/**
 * Mount a task-list pin.
 * @param {HTMLElement} container - The body region to fill.
 * @param {import('juggler/pinboard-item-type').PinContext} pinContext - The pin and its context.
 * @param {TaskListPinSpec} spec - What makes this pin the one it is.
 * @returns {import('juggler/pinboard-item-type').PinController} The controller.
 */
export function mountTaskListPin(container, pinContext, spec) {
  let context = pinContext;
  const body = createElement('div', 'task-list-pin');
  container.replaceChildren(body);

  /**
   * The thread whose list is on screen, so `Reveal in conversation` points at the
   * thread that actually owns it rather than the one being read.
   * @type {import('juggler/pinboard-item-type').PinContextItemSource|null}
   */
  let shown = null;

  /**
   * What the body was last drawn from. A list is one markdown block rather than a
   * set of rows — the items carry no identity of their own, only a position — so
   * there is nothing to match a row to, and what makes an unchanged list free is
   * not drawing it a second time. The pin hears about every change to the
   * conversation, and a plan submitted an hour ago has not moved through any of
   * them.
   * @type {string|null}
   */
  let drawn = null;

  const render = () => {
    const found = context.services.contextItems.find(spec.itemType);
    shown = found ? found.source : null;

    const items = found ? spec.itemsOf(found.data) : [];
    const line = found ? sourceLine(found.source) : '';
    // The whole of the item's data, because a pin renders more of it than its
    // items: a plan's title and status are in the block too.
    const signature = items.length ? JSON.stringify([line, found?.data]) : '';
    if (signature === drawn) return;
    drawn = signature;

    if (!items.length) {
      body.replaceChildren(pinEmpty(t(spec.empty)));
      return;
    }

    /** @type {HTMLElement[]} */
    const parts = [];
    if (line) parts.push(createElement('div', 'task-list-pin__source', line));
    parts.push(spec.render(/** @type {Record<string, any>} */ (found).data, items));
    body.replaceChildren(...parts);
  };

  const stopWatching = context.services.contextItems.onChange(render);
  render();

  return {
    update: (next) => {
      context = next;
      render();
    },
    teardown: () => stopWatching(),
    getActions: () => [
      {
        id: 'reveal',
        label: t('Reveal in conversation'),
        primary: true,
        disabled: !shown,
        // The row that wrote the list, when there is one. A list of this kind
        // draws no tile in the transcript, so pointing at the owning thread
        // alone is nothing at all to a reader already in it.
        run: () => context.services.contextItems.reveal(shown?.threadId ?? null, shown?.itemId ?? null),
      },
    ],
  };
}
