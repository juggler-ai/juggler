//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Topic subscription tests — what the window asks the server for, and who hears
 * what comes back.
 *
 * The server forgets a connection's subscriptions when it goes and sends a key's
 * events only to the connections that named it, so what is asserted is the
 * naming: one key set per topic however many subscribers share a key, the key
 * dropped with its last subscriber, every set named again on a new connection,
 * and each subscriber told it may have missed events. The socket is a stand-in:
 * the frames sent are recorded, and the server's are emitted as the socket would.
 * @module unit-tests/topics-test
 */

import { createTopicsService, subscribe } from '../../js/services/topics.js';
import wsService from '../../js/services/websocket.js';
import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/** A topic nothing else in the window subscribes to. */
const TOPIC = 'test-topic';

/**
 * Run the topic subscription tests.
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /** @type {(() => void)[]} */
  const owed = [];

  /**
   * @param {string} name - Test label.
   * @param {() => Promise<void>|void} fn - Test body.
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    } finally {
      while (owed.length) owed.pop()?.();
    }
  }

  /** @returns {any} The socket service, with its emitter in reach. */
  function socket() {
    return /** @type {any} */ (wsService);
  }

  /**
   * Record the key sets this topic names, instead of sending them.
   * @returns {string[][]} Every set named, in order.
   */
  function recordSubscriptions() {
    const original = wsService.sendSubscriptions;
    /** @type {string[][]} */
    const named = [];
    wsService.sendSubscriptions = /** @type {any} */ ((/** @type {string} */ topic, /** @type {string[]} */ keys) => {
      if (topic === TOPIC) named.push([...keys]);
      return true;
    });
    owed.push(() => { wsService.sendSubscriptions = original; });
    return named;
  }

  /**
   * The server sending an event of this topic.
   * @param {string} key - Its key.
   * @param {unknown} event - What it carries.
   */
  function serverSends(key, event) {
    socket()._emit('topic-event', { type: 'topic-event', topic: TOPIC, key, event });
  }

  await test('two subscribers of a key name it once; the last to leave drops it', () => {
    const named = recordSubscriptions();
    /** @type {unknown[]} */
    const heard = [];
    const first = subscribe(TOPIC, 'k', (e) => heard.push(['first', e]));
    owed.push(first);
    const second = subscribe(TOPIC, 'k', (e) => heard.push(['second', e]));
    owed.push(second);
    assert(JSON.stringify(named) === '[["k"]]', `named ${JSON.stringify(named)}, want k once`);

    serverSends('k', { n: 1 });
    serverSends('other', { n: 2 });
    assert(JSON.stringify(heard) === '[["first",{"n":1}],["second",{"n":1}]]',
      `heard ${JSON.stringify(heard)}, want both subscribers told of k alone`);

    first();
    assert(named.length === 1, `one subscriber leaving named ${JSON.stringify(named.slice(1))}`);
    second();
    assert(JSON.stringify(named.at(-1)) === '[]', `nothing subscribed, yet named ${JSON.stringify(named.at(-1))}`);
    serverSends('k', { n: 3 });
    assert(heard.length === 2, 'an unsubscribed listener still heard');
  });

  await test('a new connection names every key again and tells each subscriber', () => {
    const named = recordSubscriptions();
    let resyncs = 0;
    owed.push(subscribe(TOPIC, 'b', () => {}, { onResync: () => { resyncs++; } }));
    owed.push(subscribe(TOPIC, 'a', () => {}));
    named.length = 0;

    socket()._emit('open');
    assert(JSON.stringify(named) === '[["a","b"]]', `on open named ${JSON.stringify(named)}, want [a, b] once`);
    assert(resyncs === 1, `onResync called ${resyncs} time(s) on a new connection, want 1`);
  });

  await test('an extension\'s subscriptions end with its signal', () => {
    const named = recordSubscriptions();
    const mount = new AbortController();
    const topics = createTopicsService(mount.signal);
    /** @type {any[]} */
    const heard = [];
    let resyncs = 0;
    topics.subscribe(TOPIC, 'k', (e) => heard.push(e), { onResync: () => { resyncs++; } });
    assert(JSON.stringify(named.at(-1)) === '["k"]', `subscribing named ${JSON.stringify(named.at(-1))}`);

    const sent = { nested: { n: 1 } };
    serverSends('k', sent);
    assert(heard.length === 1 && heard[0].nested.n === 1, `heard ${JSON.stringify(heard)}`);
    heard[0].nested.n = 99;
    assert(sent.nested.n === 1, 'the extension was handed the event itself, not a copy');

    mount.abort();
    assert(JSON.stringify(named.at(-1)) === '[]', `after the abort named ${JSON.stringify(named.at(-1))}, want nothing`);
    serverSends('k', { n: 2 });
    socket()._emit('open');
    assert(heard.length === 1 && resyncs === 0, 'a subscription outlived its signal');
    const late = topics.subscribe(TOPIC, 'k', () => {});
    late();
    assert(JSON.stringify(named.at(-1)) === '[]', 'a subscription made after the abort was taken');
  });

  return { passed, failed, errors };
}
