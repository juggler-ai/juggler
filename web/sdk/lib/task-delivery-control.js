//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared "Monitor" status + Stop control for a background-task output delivery
 * binding (the generic `deliverTaskOutput` mechanism).
 *
 * Rendered in two places, from one implementation:
 *  - the Monitor tool-action's properties view (the command that started it), and
 *  - the properties view of every output chunk that monitor injects into the
 *    conversation (each carries a `taskSource` provenance ref).
 *
 * So clicking the originating tool-action OR any of its output messages offers
 * the same kill button. The control reads its status purely from the live
 * binding (reactive doc state), repaints on any pendingRequests change without
 * polling, and self-cleans once its DOM is detached. The ONLY state mutation is
 * the Stop button's click handler — the action site; the render path never writes.
 */

import { t, markForTranslation } from './i18n.js';

/** What a binding with no known status shows. */
const ENDED_LABEL = markForTranslation('Ended');

/** @type {Record<string, string>} */
const STATUS_LABELS = {
  active: markForTranslation('Active'),
  ended: ENDED_LABEL,
  stopped: markForTranslation('Stopped'),
};

/**
 * Append a labelled status row + Stop button bound to `taskId`'s delivery.
 * No-op when `taskId` or `messageThread` is missing.
 * @param {HTMLElement} wrapper - Section container to append into.
 * @param {object} opts
 * @param {import('../../js/model/message-thread.js').MessageThread|null|undefined} opts.messageThread - MessageThread exposing the task-delivery API
 *   (`getTaskDeliveryStatus` / `cancelTaskOutputDelivery` / `observePendingRequests`).
 * @param {string} opts.taskId - Background task id to bind to.
 * @param {string} [opts.label] - Optional display label (e.g. "monitor: build");
 *   shown as a line above the status when present.
 * @returns {void}
 */
export function renderTaskDeliveryControl(wrapper, { messageThread, taskId, label = '' }) {
  if (!taskId || !messageThread) return;

  const section = document.createElement('properties-panel-subsection');

  const labelEl = document.createElement('h4');
  labelEl.className = 'properties-panel-subtitle';
  labelEl.textContent = t('Monitor');
  section.appendChild(labelEl);

  // Self-describing when a label rides along (the chunk has no command shown).
  // The label is the plugin's, the same English the model reads in each
  // delivered message's header, so it is shown as data.
  if (label) {
    const labelText = document.createElement('div');
    labelText.className = 'properties-panel-text task-delivery-label';
    labelText.textContent = label;
    section.appendChild(labelText);
  }

  const statusEl = document.createElement('div');
  statusEl.className = 'properties-panel-text';
  section.appendChild(statusEl);

  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.className = 'properties-panel-btn danger';
  stopBtn.textContent = t('Stop monitor');
  // Shrink to fit its label: `.properties-panel-btn` is `display:flex` and the
  // subsection is a column flex container, so without this the button would
  // stretch to the full panel width. Scoped inline so the global rule (relied
  // on by other panels) is untouched.
  stopBtn.style.alignSelf = 'flex-start';
  // Action site: the only place that mutates state. The paint() below never writes.
  stopBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    messageThread.cancelTaskOutputDelivery(taskId);
  });
  section.appendChild(stopBtn);

  wrapper.appendChild(section);

  // Pure read of the binding status → DOM; performs NO state changes.
  const paint = () => {
    const status = messageThread.getTaskDeliveryStatus(taskId);
    statusEl.textContent = t((status && STATUS_LABELS[status]) || ENDED_LABEL);
    // Toggle inline `display` rather than the `hidden` attribute: `[hidden]` is
    // defeated by the more specific `.properties-panel-btn { display:flex }`
    // rule, so the button would never actually disappear. An inline value wins.
    stopBtn.style.display = status === 'active' ? '' : 'none';
  };

  // Reactive without polling: re-paint on any pendingRequests change. The
  // observer self-cleans once the section is detached (panel closed or
  // re-rendered), so it cannot leak past the DOM it updates.
  const unsubscribe = messageThread.observePendingRequests(() => {
    if (!section.isConnected) { unsubscribe(); return; }
    paint();
  });
  paint();
}
