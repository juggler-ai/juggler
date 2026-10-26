//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The queued zone's actions on a queued message, and the tab clock.
 *
 * A held send ("Send later") waits in the thread's queue, and the zone says
 * what for: "Sends at 14:05", or "After this run". On a held message it offers
 * Send now (the worker drops the hold) and Edit (the text goes back into an
 * empty box and the send leaves the queue). Every queued message offers Remove,
 * which asks the worker to take the whole send — the context items queued for
 * it too — rather than deleting the message alone.
 *
 * The tab clock is lit while any thread of the conversation holds a held send,
 * read from a flag kept by watching the document's transactions: it is
 * recomputed only after a transaction that touched a queue or an items array.
 * @module unit-tests/queued-actions-test
 */

import * as Y from '../../js/vendor/yjs.mjs';
import { ensurePendingMessages } from '../../js/components/conversation-area-rendering.js';
import { formatClockTime } from '../../js/components/composer-schedule.js';
import { HeldSendFlag } from '../../js/model/held-send-flag.js';
import MessageThread from '../../js/model/message-thread.js';
import Conversation from '../../js/model/conversation.js';
import { MESSAGE_TYPES } from '../../sdk/lib/message.js';
import { t, isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale } from '../utilities/pseudo-locale.js';

/**
 * An item that reads like a Y.Map.
 * @param {Record<string, any>} fields
 * @returns {{get: (key: string) => any}} The stand-in item.
 */
function item(fields) {
  return { get: (key) => fields[key] };
}

/**
 * A queue drawn into a detached list, with a thread and composer that record
 * what is asked of them.
 * @param {any[]} pending - The queue's entries.
 * @param {{boxEmpty?: boolean}} [opts]
 * @returns {{list: HTMLElement, calls: any[][]}} The list and the calls made.
 */
function drawQueue(pending, opts = {}) {
  /** @type {any[][]} */
  const calls = [];
  const thread = {
    pendingItems: pending,
    releaseQueued: (/** @type {string} */ id) => calls.push(['release', id]),
    removeQueued: (/** @type {string} */ id) => calls.push(['remove', id]),
    removeItemById: (/** @type {string} */ id) => calls.push(['removeItemById', id]),
  };
  const composer = {
    isEmpty: () => opts.boxEmpty !== false,
    restoreMessage: (/** @type {any} */ m) => calls.push(['restore', m]),
    showWarning: (/** @type {string} */ m) => calls.push(['warn', m]),
  };
  const area = { getMessageThread: () => thread, composer };
  const list = document.createElement('div');
  ensurePendingMessages(area, list);
  return { list, calls };
}

/**
 * The queued bubble for itemId.
 * @param {HTMLElement} list
 * @param {string} id
 * @returns {HTMLElement} The bubble.
 */
function bubble(list, id) {
  const el = /** @type {HTMLElement|null} */ (list.querySelector(`[message-id="${id}"]`));
  assert(!!el, `no queued bubble for ${id}`);
  return /** @type {HTMLElement} */ (el);
}

/**
 * Click the bubble's button matching selector.
 * @param {HTMLElement} el
 * @param {string} selector
 * @returns {void}
 */
function click(el, selector) {
  const button = /** @type {HTMLButtonElement|null} */ (el.querySelector(selector));
  assert(!!button, `no ${selector} on the bubble`);
  button?.click();
}

/**
 * Run the queued-actions test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  /** @type {string[]} */
  const errors = [];
  let passed = 0;
  let failed = 0;

  /**
   * @param {string} name
   * @param {() => Promise<void>|void} fn
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

  const notBefore = new Date(2026, 9, 26, 14, 5).getTime();
  const timed = item({ type: MESSAGE_TYPES.USER, itemId: 'q-timed', content: 'later', notBefore, sendId: 's1' });
  const runEnd = item({ type: MESSAGE_TYPES.USER, itemId: 'q-run-end', content: 'after', hold: 'run-end', sendId: 's2' });
  const plain = item({ type: MESSAGE_TYPES.USER, itemId: 'q-plain', content: 'plain' });

  await run('a held message says what it waits for; an untimed one says nothing', () => {
    const { list } = drawQueue([timed, runEnd, plain]);
    const badge = (/** @type {string} */ id) => bubble(list, id).querySelector('.queued-message-hold')?.textContent || '';
    const want = t('Sends at {time}', { time: formatClockTime(notBefore) });
    assert(badge('q-timed') === want, `timed badge = ${JSON.stringify(badge('q-timed'))}, want ${JSON.stringify(want)}`);
    assert(badge('q-timed').includes('14:05'), `timed badge must read the 24h clock, got ${JSON.stringify(badge('q-timed'))}`);
    assert(badge('q-run-end') === t('After this run'), `run-end badge = ${JSON.stringify(badge('q-run-end'))}`);
    assert(!bubble(list, 'q-plain').querySelector('.queued-message-hold'), 'an untimed message drew a hold badge');
    assert(!bubble(list, 'q-plain').querySelector('.queued-message-send-now-btn, .queued-message-edit-btn'),
      'an untimed message offers Send now or Edit');
  });

  await run('a hold that lifts takes its badge and actions with it', () => {
    const fields = { type: MESSAGE_TYPES.USER, itemId: 'q-lift', content: 'x', notBefore };
    const queue = [item(fields)];
    /** @type {any} */
    const thread = { pendingItems: queue };
    const area = { getMessageThread: () => thread };
    const list = document.createElement('div');
    ensurePendingMessages(area, list);
    assert(!!bubble(list, 'q-lift').querySelector('.queued-message-hold'), 'no badge while held');
    delete (/** @type {any} */ (fields)).notBefore;
    ensurePendingMessages(area, list);
    assert(!bubble(list, 'q-lift').querySelector('.queued-message-hold, .queued-message-send-now-btn, .queued-message-edit-btn'),
      'a released message kept its badge or its held-only actions');
  });

  await run('Send now asks the worker to release the send', () => {
    const { list, calls } = drawQueue([timed]);
    click(bubble(list, 'q-timed'), '.queued-message-send-now-btn');
    assert(JSON.stringify(calls) === JSON.stringify([['release', 'q-timed']]), `calls = ${JSON.stringify(calls)}`);
  });

  await run('Remove asks the worker to remove the whole send, held or not', () => {
    const { list, calls } = drawQueue([timed, plain]);
    click(bubble(list, 'q-timed'), '.queued-message-delete-btn');
    click(bubble(list, 'q-plain'), '.queued-message-delete-btn');
    assert(JSON.stringify(calls) === JSON.stringify([['remove', 'q-timed'], ['remove', 'q-plain']]), `calls = ${JSON.stringify(calls)}`);
  });

  await run('Edit into an empty box restores the message and removes the send', () => {
    const attachments = [{ id: 'a1', mime: 'image/png', filename: 'x.png', bytes: 1, width: 1, height: 1 }];
    const held = item({ type: MESSAGE_TYPES.USER, itemId: 'q-edit', content: 'edit me', notBefore, attachments });
    const { list, calls } = drawQueue([held]);
    click(bubble(list, 'q-edit'), '.queued-message-edit-btn');
    assert(calls.length === 2 && calls[0][0] === 'restore' && calls[1][0] === 'remove' && calls[1][1] === 'q-edit',
      `calls = ${JSON.stringify(calls)}`);
    assert(calls[0][1].content === 'edit me' && calls[0][1].attachments?.[0]?.id === 'a1',
      `restored ${JSON.stringify(calls[0][1])}`);
  });

  await run('Edit into a box with a message in it refuses, and changes nothing', () => {
    const { list, calls } = drawQueue([timed], { boxEmpty: false });
    click(bubble(list, 'q-timed'), '.queued-message-edit-btn');
    assert(JSON.stringify(calls) === JSON.stringify([['warn', t('Clear the message box to edit a scheduled message')]]),
      `calls = ${JSON.stringify(calls)}`);
  });

  await run('the thread sends release-queued and remove-queued for its own queue', () => {
    /** @type {any[]} */
    const sent = [];
    const conversation = {
      id: 'conv-q',
      queuedAction: Conversation.prototype.queuedAction,
      _workerManager: { sendToWorker: (/** @type {string} */ id, /** @type {any} */ m) => sent.push([id, m]) },
    };
    MessageThread.prototype.releaseQueued.call({ conversation, threadItemId: 'thr-1' }, 'q1');
    MessageThread.prototype.removeQueued.call({ conversation, threadItemId: null }, 'q2');
    const want = [
      ['conv-q', { type: 'release-queued', threadItemId: 'thr-1', itemId: 'q1' }],
      ['conv-q', { type: 'remove-queued', threadItemId: undefined, itemId: 'q2' }],
    ];
    assert(JSON.stringify(sent) === JSON.stringify(want), `sent ${JSON.stringify(sent)}`);
  });

  await run('en-XA: the badge and every action label are translated', async () => {
    await underPseudoLocale('queued-actions-test', async () => {
      const { list } = drawQueue([timed, runEnd]);
      /** @type {string[]} */
      const shown = [];
      for (const el of list.querySelectorAll('.queued-message-hold')) shown.push(el.textContent || '');
      for (const b of list.querySelectorAll('button')) {
        shown.push(b.getAttribute('title') || '', b.getAttribute('aria-label') || '');
      }
      assert(shown.length >= 2 + 3 * 2 * 2, `drew too little: ${JSON.stringify(shown)}`);
      const raw = shown.filter(s => !isPseudoLocalized(s));
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    });
  });

  await run('the tab clock flag follows the queues, and ignores a streaming write', () => {
    const doc = new Y.Doc();
    const root = doc.getMap('root');
    /** @type {Y.Array<any>} */
    const items = new Y.Array();
    root.set('items', items);
    const flag = new HeldSendFlag(doc, root);
    assert(flag.value === false, 'an empty conversation holds nothing');

    // A sub-thread with a held send in its queue.
    const threadMap = new Y.Map();
    const reply = new Y.Map();
    reply.set('type', 'assistant');
    reply.set('content', '');
    doc.transact(() => {
      items.push([reply, threadMap]);
      threadMap.set('itemId', 'thr-1');
      const queue = new Y.Array();
      threadMap.set('pendingItems', queue);
      const entry = new Y.Map();
      entry.set('type', 'user');
      entry.set('itemId', 'q1');
      entry.set('notBefore', Date.now() + 3600000);
      queue.push([entry]);
    });
    assert(flag.value === true, 'a held send in a sub-thread queue must light the clock');

    const walks = flag.walks;
    for (let i = 0; i < 20; i++) reply.set('content', 'chunk ' + i);
    assert(flag.value === true && flag.walks === walks, `a streaming write walked the queues (${flag.walks - walks} walks)`);

    // Released: the hold keys go, the entry stays queued.
    const queue = /** @type {Y.Array<any>} */ (threadMap.get('pendingItems'));
    queue.get(0).delete('notBefore');
    assert(flag.value === false, 'a released send must put the clock out');

    queue.get(0).set('hold', 'run-end');
    assert(flag.value === true, 'a run-end hold must light the clock');
    queue.delete(0, 1);
    assert(flag.value === false, 'removing the send must put the clock out');
    flag.destroy();
  });

  return { passed, failed, errors };
}
