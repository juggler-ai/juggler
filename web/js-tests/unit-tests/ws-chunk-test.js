//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for the reassembler that puts back together a message the server
 * had to split (utils/ws-chunk.js). The splitting half is covered by
 * cmd/juggler/server/ws_chunk_test.go; the frame layout is written out longhand
 * here rather than imported, so that a change to it has to be made on purpose
 * in both places.
 * @module unit-tests/ws-chunk-test
 */

import { assert } from '../utilities/test-helpers.js';
import {
  WSChunkReassembler,
  parseWSChunkFrame,
  WS_CHUNK_HEADER_SIZE,
  WS_CHUNK_KIND_TEXT
} from '../../js/utils/ws-chunk.js';

/** wsChunkKindBinary (cmd/juggler/server/ws_chunk.go): a kind this client never reads. */
const WS_CHUNK_KIND_BINARY = 1;

/**
 * Build one chunk frame exactly as cmd/juggler/server/ws_chunk.go writes it.
 * @param {{kind?: number, idHi?: number, idLo?: number, index: number, total: number, data: Uint8Array}} spec - Frame fields
 * @returns {ArrayBuffer} The encoded frame
 */
function frame({ kind = WS_CHUNK_KIND_TEXT, idHi = 0, idLo = 1, index, total, data }) {
  const bytes = new Uint8Array(WS_CHUNK_HEADER_SIZE + data.length);
  bytes.set([0x4a, 0x47, 0x43, 0x31], 0); // "JGC1"
  bytes[4] = kind;
  const view = new DataView(bytes.buffer);
  view.setUint32(5, idHi);
  view.setUint32(9, idLo);
  view.setUint32(13, index);
  view.setUint32(17, total);
  bytes.set(data, WS_CHUNK_HEADER_SIZE);
  return bytes.buffer;
}

/**
 * Split text into `count` frames of equal byte length, cutting wherever the
 * bytes fall — including through a multi-byte rune, which is the case the
 * binary framing exists to make safe.
 * @param {string} text - The message being split
 * @param {number} count - How many frames to produce
 * @param {number} [idLo] - Low half of the run id
 * @returns {ArrayBuffer[]} The frames, in order
 */
function split(text, count, idLo = 1) {
  const bytes = new TextEncoder().encode(text);
  const size = Math.ceil(bytes.length / count);
  const frames = [];
  for (let i = 0; i < count; i++) {
    frames.push(
      frame({
        idLo,
        index: i,
        total: count,
        data: bytes.subarray(i * size, Math.min((i + 1) * size, bytes.length))
      })
    );
  }
  return frames;
}

/**
 * @param {Uint8Array} bytes - Reassembled payload
 * @returns {string} The decoded text
 */
function text(bytes) {
  return new TextDecoder().decode(bytes);
}

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated results
 */
export async function runTests(_ctx) {
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

  // Anything that is not a chunk frame must be refused rather than guessed at,
  // or an ordinary binary message would be silently swallowed.
  check('parse refuses non-frames', () => {
    assert(parseWSChunkFrame(new Uint8Array(0)) === null, 'accepted an empty message');
    assert(
      parseWSChunkFrame(new Uint8Array(WS_CHUNK_HEADER_SIZE - 1)) === null,
      'accepted a message shorter than the header'
    );

    const wrongMagic = new Uint8Array(frame({ index: 0, total: 1, data: new Uint8Array(1) }));
    wrongMagic[2] = 0x58;
    assert(parseWSChunkFrame(wrongMagic) === null, 'accepted a frame with the wrong magic');

    assert(
      parseWSChunkFrame(frame({ index: 0, total: 0, data: new Uint8Array(1) })) === null,
      'accepted a run of zero frames'
    );
    assert(
      parseWSChunkFrame(frame({ index: 4, total: 4, data: new Uint8Array(1) })) === null,
      'accepted a frame indexed past the end of its run'
    );
  });

  // The whole point: a message split anywhere — including mid-rune — comes back
  // byte for byte.
  check('reassembles a message split through a multi-byte rune', () => {
    const original = `héllo — ${'x'.repeat(500)} — wörld 🎪`;
    const r = new WSChunkReassembler();
    const frames = split(original, 4);

    for (let i = 0; i < frames.length - 1; i++) {
      assert(r.accept(frames[i]) === null, `run completed early at frame ${i}`);
    }
    const done = r.accept(frames[frames.length - 1]);
    assert(done !== null, 'the last frame did not complete the run');
    assert(done.kind === WS_CHUNK_KIND_TEXT, `kind = ${done.kind}, want text`);
    assert(text(done.bytes) === original, 'the reassembled text differs from the original');
    assert(r.pending === 0, 'a completed run was left behind');
  });

  // Ordering is guaranteed by the server's single writer goroutine, but the
  // reassembler must not depend on it — a bug there should strand a run, not
  // corrupt one.
  check('reassembles out of order', () => {
    const original = 'abcdefghijklmnopqrstuvwxyz'.repeat(20);
    const r = new WSChunkReassembler();
    const frames = split(original, 5);

    for (const i of [3, 0, 4, 1]) {
      assert(r.accept(frames[i]) === null, `run completed early at frame ${i}`);
    }
    const done = r.accept(frames[2]);
    assert(done !== null, 'the run never completed');
    assert(text(done.bytes) === original, 'out-of-order reassembly differs from the original');
  });

  // A repeated frame must not count twice, which would leave the run one short
  // of complete forever.
  check('ignores a repeated frame', () => {
    const original = 'the same thing twice';
    const r = new WSChunkReassembler();
    const frames = split(original, 3);

    r.accept(frames[0]);
    assert(r.accept(frames[0]) === null, 'a repeat completed the run on its own');
    r.accept(frames[1]);
    const done = r.accept(frames[2]);
    assert(done !== null, 'the run never completed after a repeated frame');
    assert(text(done.bytes) === original, 'a repeated frame corrupted the payload');
  });

  // Two runs in flight at once are kept apart by their ids, so a frame lost
  // from one cannot be filled in by a frame of the other.
  check('keeps separate runs apart', () => {
    const first = 'first message, quite short';
    const second = 'second message, also short';
    const r = new WSChunkReassembler();
    const a = split(first, 2, 1);
    const b = split(second, 2, 2);

    assert(r.accept(a[0]) === null, 'run A completed on one frame');
    assert(r.accept(b[0]) === null, 'run B completed on one frame');
    assert(r.pending === 2, `pending = ${r.pending}, want 2`);

    const doneB = r.accept(b[1]);
    assert(doneB !== null && text(doneB.bytes) === second, 'run B did not reassemble correctly');
    const doneA = r.accept(a[1]);
    assert(doneA !== null && text(doneA.bytes) === first, 'run A did not reassemble correctly');
  });

  // A run whose frames disagree about their own shape was never one message.
  check('drops a run whose frames disagree', () => {
    const r = new WSChunkReassembler();
    const data = new Uint8Array([1, 2, 3]);
    r.accept(frame({ index: 0, total: 3, data }));
    assert(r.accept(frame({ index: 1, total: 4, data })) === null, 'a contradictory frame completed the run');
    assert(r.pending === 0, 'the contradictory run was kept');

    r.accept(frame({ idLo: 7, index: 0, total: 2, data }));
    assert(
      r.accept(frame({ idLo: 7, kind: WS_CHUNK_KIND_BINARY, index: 1, total: 2, data })) === null,
      'frames of two different kinds were assembled into one message'
    );
    assert(r.pending === 0, 'the mixed-kind run was kept');
  });

  // When the link dies, the frames still outstanding belong to a connection
  // that will never finish sending them — and the next connection numbers its
  // runs from one again.
  check('reset drops partial runs', () => {
    const r = new WSChunkReassembler();
    const frames = split('half a message', 2);
    r.accept(frames[0]);
    assert(r.pending === 1, 'the partial run was not recorded');

    r.reset();
    assert(r.pending === 0, 'reset left a partial run behind');
    assert(r.accept(frames[1]) === null, 'a stale frame completed a run after reset');
  });

  return { passed, failed, errors };
}
