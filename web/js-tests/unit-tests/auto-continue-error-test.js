//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The error row's Auto-continue offer, on a failure the worker reported as a
 * usage cap with a stated reset (`data.resetAt`, epoch ms). Pressing it does what
 * typing "continue" and scheduling it for the reset would: a held send of
 * "continue", which the worker fires itself when the cap lifts.
 *
 * Like Retry it is offered only while the error is last — a continue resumes from
 * the end of the transcript — and only while the reset is still to come. A thread
 * that already holds a send has said what happens next, so it is not offered there.
 * @module unit-tests/auto-continue-error-test
 */

import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale, assertPseudoLocalized } from '../utilities/pseudo-locale.js';
import ErrorMessage from '../../js/components/error-message.js';
import { formatClockTime } from '../../js/components/composer-schedule.js';
import {
  buildElementMap,
  identifyElementsToKeep,
  removeDeletedElements,
  positionElements,
} from '../../js/components/conversation-area-rendering.js';

/**
 * A plain-object stand-in for a conversation item Y.Map.
 * @param {Record<string, any>} fields - The item's fields
 * @returns {{get: (key: string) => any}} A Y.Map-shaped item
 */
function item(fields) {
  return { get: (key) => fields[key] };
}

/**
 * An error item carrying the worker's `data` blob as a JSON string.
 * @param {string} id - Item id
 * @param {Record<string, any>|null} data - The item's data blob, or null for none
 * @returns {{get: (key: string) => any}} A Y.Map-shaped error item
 */
function errorItem(id, data) {
  return item({ itemId: id, type: 'error', content: `capped ${id}`, data: data ? JSON.stringify(data) : undefined });
}

/**
 * A usage cap reported as the worker reports one, lifting `inMs` from now.
 * @param {number} inMs - How far off the reset is
 * @returns {Record<string, any>} The item's data blob
 */
function capData(inMs) {
  return { provider: 'claudecode', model: 'opus', duration: 900, resetAt: Date.now() + inMs };
}

/**
 * A message thread that records what is sent through its conversation.
 * @param {Array<any>} [pending] - Its queued items
 * @returns {{thread: any, sends: Array<any[]>}} The thread and the sends it saw
 */
function fakeThread(pending = []) {
  /** @type {Array<any[]>} */
  const sends = [];
  const thread = {
    threadItemId: 'T1',
    pendingItems: pending,
    conversation: {
      sendMessage: async (/** @type {any[]} */ ...args) => { sends.push(args); return null; },
    },
  };
  return { thread, sends };
}

/**
 * Mount a message list, with every error row finding `thread` as its own.
 * @param {any} thread - The thread the rows belong to
 * @returns {{list: HTMLElement, render: (items: any[]) => void, teardown: () => void}} The mounted list and a render pass over it
 */
function mountList(thread) {
  const proto = /** @type {any} */ (ErrorMessage.prototype);
  const original = proto._getMessageThread;
  proto._getMessageThread = () => thread;
  const list = document.createElement('div');
  const anchor = document.createElement('div');
  anchor.className = 'thread-result-final';
  list.appendChild(anchor);
  document.body.appendChild(list);
  return {
    list,
    render(items) {
      const currentElements = buildElementMap(list);
      removeDeletedElements(currentElements, identifyElementsToKeep(items, currentElements));
      positionElements(null, list, anchor, items, currentElements);
    },
    teardown() {
      list.remove();
      proto._getMessageThread = original;
    },
  };
}

/**
 * @param {HTMLElement} list - The mounted message list
 * @param {string} id - Item id
 * @returns {HTMLButtonElement|null} The Auto-continue button on that row, if it has one
 */
function autoButton(list, id) {
  return list.querySelector(`error-message[message-id="${id}"] .error-autocontinue-btn`);
}

/**
 * Run auto-continue error tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test counts and errors
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * Run one test case and collect its outcome.
   * @param {string} name - Test case name
   * @param {() => Promise<void>|void} fn - Test case body
   */
  async function test(name, fn) {
    try { await fn(); passed++; }
    catch (e) { failed++; errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  }

  await test('a dated cap offers to continue at its reset, before Retry', () => {
    const { thread } = fakeThread();
    const { list, render, teardown } = mountList(thread);
    try {
      const data = capData(2 * 3600_000);
      render([errorItem('ERR_CAP', data)]);
      const btn = autoButton(list, 'ERR_CAP');
      assert(!!btn, 'a cap that states its reset must offer to continue then');
      const label = btn.textContent || '';
      assert(label.includes('Auto-continue at') && label.includes(formatClockTime(data.resetAt)),
        `the action must name the time it continues at, got ${JSON.stringify(label)}`);
      const row = /** @type {Element} */ (list.querySelector('error-message[message-id="ERR_CAP"] .error-message-actions'));
      const classes = Array.from(row.children).map((c) => c.className);
      assert(classes.length === 2 && classes[0].includes('error-autocontinue-btn') && classes[1].includes('error-retry-btn'),
        `auto-continue must read before Retry, got ${JSON.stringify(classes)}`);
    } finally {
      teardown();
    }
  });

  await test('pressing it schedules "continue" for the reset, once', async () => {
    const { thread, sends } = fakeThread();
    const { list, render, teardown } = mountList(thread);
    try {
      const data = capData(3600_000);
      render([errorItem('ERR_CAP', data)]);
      const btn = /** @type {HTMLButtonElement} */ (autoButton(list, 'ERR_CAP'));
      btn.click();
      await Promise.resolve();
      assert(sends.length === 1, `expected one send, got ${sends.length}`);
      const [text, threadItemId, sentThread, options] = sends[0];
      assert(text === 'continue', `the held message must be "continue", got ${JSON.stringify(text)}`);
      assert(threadItemId === 'T1' && sentThread === thread, 'the send must go to the error\'s own thread');
      // Ten seconds past the stated reset, so a clock running ahead of the
      // provider's cannot land the continue on a cap that has not lifted yet.
      assert(options?.schedule?.notBefore === data.resetAt + 10_000,
        `the send must be held until 10s past the reset, got ${JSON.stringify(options?.schedule)}`);
      assert(options.consumeComposer === false && options.interpretCommands === false,
        `the send must leave the composer alone, got ${JSON.stringify(options)}`);
      assert(btn.disabled, 'a continue already scheduled must not be offered again');
      btn.click();
      await Promise.resolve();
      assert(sends.length === 1, `a second press must schedule nothing more, got ${sends.length} sends`);
    } finally {
      teardown();
    }
  });

  await test('no offer without a reset still to come, or once the error is not last', () => {
    const { thread } = fakeThread();
    const { list, render, teardown } = mountList(thread);
    try {
      render([errorItem('ERR_PAST', capData(-60_000))]);
      assert(!autoButton(list, 'ERR_PAST'), 'a reset already gone by leaves only Retry');
      render([errorItem('ERR_PLAIN', { provider: 'claudecode', duration: 3 })]);
      assert(!autoButton(list, 'ERR_PLAIN'), 'an error stating no reset has nothing to wait for');
      render([errorItem('ERR_CAP', capData(3600_000)), errorItem('ERR_2', null)]);
      assert(!autoButton(list, 'ERR_CAP'), 'a continue resumes from the end, so an error further back offers none');
    } finally {
      teardown();
    }
  });

  await test('a thread already holding a send is not offered another', () => {
    const held = item({ itemId: 'Q1', type: 'user', content: 'later', notBefore: Date.now() + 3600_000 });
    const { thread } = fakeThread([held]);
    const { list, render, teardown } = mountList(thread);
    try {
      render([errorItem('ERR_CAP', capData(3600_000))]);
      assert(!autoButton(list, 'ERR_CAP'), 'the queue already says what happens next');
      assert(!!list.querySelector('error-message[message-id="ERR_CAP"] .error-retry-btn'), 'Retry is still offered');
    } finally {
      teardown();
    }
  });

  await test('en-XA', async () => {
    await underPseudoLocale('auto-continue-error-test', () => {
      const { thread } = fakeThread();
      const { list, render, teardown } = mountList(thread);
      try {
        render([errorItem('ERR_CAP', capData(3600_000))]);
        const btn = autoButton(list, 'ERR_CAP');
        assert(!!btn, 'no auto-continue button');
        assertPseudoLocalized(btn, { atLeast: 1, where: 'auto-continue button' });
      } finally {
        teardown();
      }
    });
  });

  return { passed, failed, errors };
}
