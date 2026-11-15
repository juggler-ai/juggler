//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for the binary Yjs sync frame (utils/yjs-sync-frame.js) and for
 * the socket service carrying it both ways. The Go half is
 * cmd/juggler/server/ws_yjs_frame_test.go; the layout is written out longhand
 * here, as there, so a change to it has to be made on purpose in both places.
 *
 * The service cases run on a private `WebSocketService` with a fake transport,
 * so no real subscriber in the page hears a fabricated message.
 * @module unit-tests/yjs-sync-frame-test
 */

import { assert } from '../utilities/test-helpers.js';
import {
  encodeYjsSyncFrame,
  decodeYjsSyncFrame,
  isYjsSyncFrame,
  YJS_FRAME_KIND_SYNC,
  YJS_FRAME_KIND_RESYNC_RESPONSE
} from '../../js/utils/yjs-sync-frame.js';
import { WS_CHUNK_HEADER_SIZE } from '../../js/utils/ws-chunk.js';
import { WebSocketService } from '../../js/services/websocket.js';

/**
 * @param {Uint8Array|null|undefined} a - One byte string
 * @param {Uint8Array|null|undefined} b - The other
 * @returns {boolean} Whether they hold the same bytes
 */
function sameBytes(a, b) {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Wrap a message in one JGC1 chunk frame of the binary kind, as the server does
 * for a message over its chunk threshold.
 * @param {Uint8Array} message - The binary message
 * @returns {ArrayBuffer} The frame
 */
function binaryChunk(message) {
  const buf = new ArrayBuffer(WS_CHUNK_HEADER_SIZE + message.length);
  const view = new DataView(buf);
  new Uint8Array(buf).set([0x4a, 0x47, 0x43, 0x31]);
  view.setUint8(4, 1);
  view.setUint32(5, 0xabad1dea);
  view.setUint32(9, 7);
  view.setUint32(13, 0);
  view.setUint32(17, 1);
  new Uint8Array(buf).set(message, WS_CHUNK_HEADER_SIZE);
  return buf;
}

/**
 * A service on a fake open transport that records what it is handed.
 * @returns {{ws: any, sent: any[], heard: any[]}} The service and its records
 */
function fakeService() {
  const ws = /** @type {any} */ (new WebSocketService());
  /** @type {any[]} */
  const sent = [];
  /** @type {any[]} */
  const heard = [];
  ws._transport = { send: (/** @type {any} */ p) => sent.push(p), close: () => {} };
  ws.connected = true;
  ws.on('message', (/** @type {any} */ data) => heard.push(data));
  return { ws, sent, heard };
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated results
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - What is being checked
   * @param {() => void} body - The check
   */
  const check = (name, body) => {
    try {
      body();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  check('the layout matches the server byte for byte', () => {
    const frame = encodeYjsSyncFrame({ conversationId: 'ab', update: new Uint8Array([7]), engineDerived: true });
    const want = [0x4a, 0x59, 0x53, 0x31, 1, 1, 0, 2, 0x61, 0x62, 7];
    assert(sameBytes(frame, new Uint8Array(want)), `frame = [${Array.from(frame)}], want [${want}]`);
  });

  check('a sync frame round-trips into the worker message it replaces', () => {
    const update = new Uint8Array([0, 255, 1, 128, 0]);
    const frame = encodeYjsSyncFrame({ conversationId: 'conv_é', update, sinceEditMs: 1234 });
    assert(isYjsSyncFrame(frame), 'an encoded frame is not recognised');
    const got = decodeYjsSyncFrame(/** @type {ArrayBuffer} */ (frame.buffer));
    assert(got !== null, 'an encoded frame did not decode');
    assert(got?.conversationId === 'conv_é', `conversationId = ${got?.conversationId}`);
    assert(got?.workerMsgType === 'yjs-sync', `workerMsgType = ${got?.workerMsgType}`);
    assert(got?.payload.type === 'yjs-sync', `payload type = ${got?.payload.type}`);
    assert(sameBytes(got?.payload.bytes, update), 'the update bytes differ');
    assert(got?.payload.sinceEditMs === 1234, `sinceEditMs = ${got?.payload.sinceEditMs}`);
    assert(got?.payload.engineDerived === undefined, 'engineDerived appeared from nowhere');
  });

  check('a resync response carries its state vector, and an empty delta is null', () => {
    const frame = encodeYjsSyncFrame({
      kind: YJS_FRAME_KIND_RESYNC_RESPONSE, conversationId: 'c', update: new Uint8Array(0), stateVector: new Uint8Array([3, 4])
    });
    const got = decodeYjsSyncFrame(frame);
    assert(got?.workerMsgType === 'resync-response', `workerMsgType = ${got?.workerMsgType}`);
    assert(got?.payload.bytes === null, 'an empty delta must arrive as null, as JSON null did');
    assert(sameBytes(got?.payload.stateVector, new Uint8Array([3, 4])), 'the state vector differs');

    const noVector = decodeYjsSyncFrame(encodeYjsSyncFrame({
      kind: YJS_FRAME_KIND_RESYNC_RESPONSE, conversationId: 'c', update: new Uint8Array([1])
    }));
    assert(noVector?.payload.stateVector === null, 'an absent state vector must stay absent');
    assert(YJS_FRAME_KIND_SYNC === 1, 'the sync kind is 1 on the wire');
  });

  check('anything that is not a frame is refused', () => {
    const valid = encodeYjsSyncFrame({ conversationId: 'conv', update: new Uint8Array([1]) });
    const chunk = valid.slice();
    chunk.set([0x4a, 0x47, 0x43, 0x31]);
    const unknownKind = valid.slice();
    unknownKind[4] = 9;
    const overrun = valid.slice();
    new DataView(overrun.buffer).setUint16(6, 500);
    for (const [name, raw] of /** @type {[string, Uint8Array][]} */ ([
      ['empty', new Uint8Array(0)], ['chunk magic', chunk], ['unknown kind', unknownKind], ['conv past the end', overrun]
    ])) {
      assert(decodeYjsSyncFrame(raw) === null, `${name} decoded as a frame`);
    }
    assert(!isYjsSyncFrame(chunk), 'a chunk frame was recognised as a sync frame');
  });

  check('the service delivers a binary sync as a worker message', () => {
    const { ws, heard } = fakeService();
    const update = new Uint8Array([5, 6, 7]);
    ws._handleMessageData(encodeYjsSyncFrame({ conversationId: 'conv_in', update }).buffer);
    assert(heard.length === 1, `heard ${heard.length} messages`);
    const m = heard[0];
    assert(m?.type === 'worker-message' && m.conversationId === 'conv_in' && m.workerMsgType === 'yjs-sync',
      `delivered ${JSON.stringify(m)}`);
    assert(sameBytes(m.payload.bytes, update), 'the delivered bytes differ');
  });

  check('the service delivers a sync frame the server had to chunk', () => {
    const { ws, heard } = fakeService();
    const update = new Uint8Array([9, 8, 7, 6]);
    ws._handleMessageData(binaryChunk(encodeYjsSyncFrame({ conversationId: 'conv_big', update })));
    assert(heard.length === 1 && heard[0]?.conversationId === 'conv_big', `heard ${JSON.stringify(heard)}`);
    assert(sameBytes(heard[0].payload.bytes, update), 'the reassembled bytes differ');
  });

  check('outbound sync is binary only once the server has granted it', () => {
    const { ws, sent } = fakeService();
    const update = new Uint8Array([1, 2, 3]);

    ws.sendWorkerMessage('conv_out', { type: 'yjs-sync', bytes: update, engineDerived: true });
    assert(sent.length === 1 && typeof sent[0] === 'string', 'before the grant the sync must go as JSON');
    const json = JSON.parse(sent[0]);
    assert(json.payload.bytes === 'AQID', `JSON bytes = ${json.payload.bytes}, want base64 AQID`);
    assert(json.payload.engineDerived === true, 'engineDerived was lost on the JSON path');

    ws._handleMessageData(JSON.stringify({ type: 'session', clientId: 'client_x', viewerId: '', bootId: 'boot', binarySync: true }));
    ws.sendWorkerMessage('conv_out', { type: 'yjs-sync', bytes: update, engineDerived: true });
    assert(sent.length === 2 && sent[1] instanceof Uint8Array, 'after the grant the sync must go as a binary frame');
    const back = decodeYjsSyncFrame(sent[1]);
    assert(back?.conversationId === 'conv_out' && sameBytes(back.payload.bytes, update) && back.payload.engineDerived === true,
      `the binary frame does not carry the sync: ${JSON.stringify(back)}`);

    ws.sendWorkerMessage('conv_out', { type: 'cancel', reason: 'x' });
    assert(typeof sent[2] === 'string', 'every other worker message stays JSON');
  });

  return { passed, failed, errors };
}
