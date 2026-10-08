//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * WebSocket listener isolation tests.
 *
 * Every inbound server message fans out to the subscribers of one event, and
 * those subscribers are independent of each other — the session model, the
 * pinboard, the provider list, the settings panel. One of them throwing must
 * cost that one subscriber its update and nothing else: the subscribers behind
 * it still hear the message, the throw does not escape into the transport's
 * receive path, and the fault reaches the app log through the fault sink,
 * because a release viewer has no console to read it in.
 *
 * Driven on a private `WebSocketService` instance, so no real subscriber in the
 * page is handed a fabricated message. The session's feed is held to the same
 * reporting rule, on a session of its own.
 * @module unit-tests/ws-listener-isolation-test
 */

import { assert, trackTestSession } from '../utilities/test-helpers.js';
import { WebSocketService } from '../../js/services/websocket.js';
import Session from '../../js/model/session.js';
import { setFaultSink } from '../../js/utils/fault-report.js';

/**
 * Run the WebSocket listener isolation tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * Run one case with a fresh fault sink installed, handing it the faults sent.
   * @param {string} name - Case name, for the error list.
   * @param {(faults: any[]) => void|Promise<void>} fn - The case.
   * @returns {Promise<void>} Settles once the case has been scored.
   */
  const run = (name, fn) => {
    /** @type {any[]} */
    const faults = [];
    setFaultSink((/** @type {any} */ fault) => { faults.push(fault); });
    return Promise.resolve().then(() => fn(faults)).then(() => { passed++; }).catch((e) => {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }).finally(() => { setFaultSink(null); });
  };

  // The inbound path end to end: a frame off the wire, parsed and routed to
  // 'message', with a broken subscriber ahead of a healthy one.
  await run('a throwing message listener does not starve the ones behind it', (/** @type {any} */ faults) => {
    const ws = new WebSocketService();
    /** @type {any[]} */
    const heard = [];
    ws.on('message', () => { throw new Error('subscriber blew up'); });
    ws.on('message', (/** @type {any} */ data) => { heard.push(data); });

    ws._handleMessageData(JSON.stringify({ conversationId: 'conv_x', workerMsgType: 'probe' }));

    assert(heard.length === 1,
      `the listener behind a throwing one must still hear the message, heard ${heard.length}`);
    assert(heard[0]?.conversationId === 'conv_x',
      `it must hear the message itself, got ${JSON.stringify(heard[0])}`);
    assert(faults.length === 1,
      `the throw must reach the fault sink once, got ${faults.length} — a release viewer has no console`);
    assert(faults[0].source === 'ws-listener:message',
      `the fault must name the event it was delivering, got ${faults[0].source}`);
    assert(faults[0].message === 'subscriber blew up',
      `the fault must carry what was thrown, got ${faults[0].message}`);
  });

  // Every event rides the same fan-out, so the rule is the emitter's, not the
  // message route's: a connection event is held to it too.
  await run('a throwing listener does not escape the emitter', (/** @type {any} */ faults) => {
    const ws = new WebSocketService();
    let secondRan = 0;
    ws.on('providers-update', () => { throw new Error('first blew up'); });
    ws.on('providers-update', () => { secondRan++; });

    let escaped = null;
    try {
      ws._emit('providers-update', []);
    } catch (e) {
      escaped = e;
    }

    assert(escaped === null, `a listener's throw must not reach the emitter's caller, got ${escaped}`);
    assert(secondRan === 1, `the second listener should run once, ran ${secondRan} times`);
    assert(faults.length === 1 && faults[0].source === 'ws-listener:providers-update',
      `expected one fault named ws-listener:providers-update, got ${JSON.stringify(faults.map((/** @type {any} */ f) => f.source))}`);
  });

  // The session's own feed is the app's other bus, and its subscribers are just
  // as independent — so a throw there owes the app log the same report.
  await run('a throwing session subscriber is reported like a socket one', (/** @type {any} */ faults) => {
    const session = /** @type {any} */ (trackTestSession(new Session(/** @type {any} */ ({}))));
    let secondRan = 0;
    const offFirst = session.subscribe(() => { throw new Error('session subscriber blew up'); });
    const offSecond = session.subscribe(() => { secondRan++; });
    try {
      session.notifyConversationChange('listener-isolation:probe', null);
    } finally {
      offFirst();
      offSecond();
    }

    assert(secondRan === 1, `the subscriber behind a throwing one should run once, ran ${secondRan} times`);
    assert(faults.length === 1,
      `the throw must reach the fault sink once, got ${faults.length} — a release viewer has no console`);
    assert(faults[0].source === 'session-listener:listener-isolation:probe',
      `the fault must name the event it was delivering, got ${faults[0].source}`);
    assert(faults[0].message === 'session subscriber blew up',
      `the fault must carry what was thrown, got ${faults[0].message}`);
  });

  return { passed, failed, errors };
}
