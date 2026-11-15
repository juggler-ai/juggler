//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The binary frame Yjs sync rides the socket in, when the server grants it.
 *
 * The JSON form of a sync carries the update as base64 inside a worker-message
 * envelope, which adds a third to every sync — the bulk of a conversation's
 * traffic. This frame carries the same worker message with its bytes raw. The
 * socket asks for it with `sync=binary` and sends it only once the session
 * frame says `binarySync`; everything else stays JSON, and so does a sync on a
 * server that never granted it.
 *
 * The layout is fixed on both sides (cmd/juggler/server/ws_yjs_frame.go):
 *
 *   magic        4 bytes  "JYS1"
 *   kind         1 byte   YJS_FRAME_KIND_* — also the worker message type
 *   flags        1 byte   bit 0 engineDerived, bit 1 sinceEditMs, bit 2 stateVector
 *   convLen      2 bytes  uint16 BE, then the conversation id, UTF-8
 *   sinceEditMs  4 bytes  int32 BE, when bit 1 is set
 *   svLen        4 bytes  uint32 BE, then the state vector, when bit 2 is set
 *   update       remainder, the raw Yjs update (empty stands for none)
 * @module utils/yjs-sync-frame
 */

/**
 * The worker message a frame stands for, as the JSON envelope's payload would
 * have decoded — except that the byte fields are bytes rather than base64.
 * @typedef {object} YjsSyncFramePayload
 * @property {'yjs-sync'|'resync-response'} type - The worker message type
 * @property {Uint8Array|null} bytes - The Yjs update or delta; null when empty
 * @property {true} [engineDerived] - yjs-sync only: an engine-derived write
 * @property {number} [sinceEditMs] - yjs-sync only: ms since the sender's previous edit
 * @property {Uint8Array|null} [stateVector] - resync-response only: the worker's state vector
 */

/** A yjs-sync, either direction. */
export const YJS_FRAME_KIND_SYNC = 1;

/** A resync-response, server to client only. */
export const YJS_FRAME_KIND_RESYNC_RESPONSE = 2;

const MAGIC = [0x4a, 0x59, 0x53, 0x31]; // "JYS1"
const FIXED_HEADER = 8;
const FLAG_ENGINE_DERIVED = 1;
const FLAG_SINCE_EDIT = 2;
const FLAG_STATE_VECTOR = 4;
const KNOWN_FLAGS = FLAG_ENGINE_DERIVED | FLAG_SINCE_EDIT | FLAG_STATE_VECTOR;

/** @type {Record<number, 'yjs-sync'|'resync-response'>} */
const MSG_TYPE = {
  [YJS_FRAME_KIND_SYNC]: 'yjs-sync',
  [YJS_FRAME_KIND_RESYNC_RESPONSE]: 'resync-response'
};

/**
 * @param {ArrayBuffer|Uint8Array} raw - A received binary message
 * @returns {Uint8Array} The same bytes, viewed
 */
function asBytes(raw) {
  return raw instanceof Uint8Array ? raw : new Uint8Array(raw);
}

/**
 * Whether a binary message is a sync frame rather than, say, a chunk frame.
 * @param {ArrayBuffer|Uint8Array} raw - A received binary message
 * @returns {boolean} Whether it opens with the frame's magic
 */
export function isYjsSyncFrame(raw) {
  const bytes = asBytes(raw);
  return bytes.length >= MAGIC.length && MAGIC.every((b, i) => bytes[i] === b);
}

/**
 * The fields a frame is written from.
 * @typedef {{kind?: number, conversationId: string, update: Uint8Array, engineDerived?: boolean, sinceEditMs?: number, stateVector?: Uint8Array|null}} YjsSyncFrameFields
 */

/**
 * Whether a frame can carry these fields as they are. Its sinceEditMs is an
 * int32 and its conversation id's length a uint16, so a value past either
 * would wrap; such a sync goes as JSON instead, as the server's encoder sends
 * one (ws_yjs_frame.go).
 * @param {YjsSyncFrameFields} frame - The fields
 * @returns {boolean} True when encodeYjsSyncFrame can write them
 */
export function fitsYjsSyncFrame(frame) {
  const since = frame.sinceEditMs;
  if (typeof since === 'number' && !(Number.isInteger(since) && since >= -(2 ** 31) && since < 2 ** 31)) return false;
  const convLength = new TextEncoder().encode(frame.conversationId).length;
  return convLength > 0 && convLength <= 0xffff;
}

/**
 * Write one frame.
 * @param {YjsSyncFrameFields} frame - Its fields; kind defaults to a yjs-sync
 * @returns {Uint8Array} The frame
 * @throws {RangeError} For fields the frame cannot carry (see fitsYjsSyncFrame)
 */
export function encodeYjsSyncFrame(frame) {
  if (!fitsYjsSyncFrame(frame)) throw new RangeError('a sync frame cannot carry these fields');
  const conv = new TextEncoder().encode(frame.conversationId);
  const hasSince = typeof frame.sinceEditMs === 'number';
  const vector = frame.stateVector ?? null;
  let flags = 0;
  if (frame.engineDerived) flags |= FLAG_ENGINE_DERIVED;
  if (hasSince) flags |= FLAG_SINCE_EDIT;
  if (vector) flags |= FLAG_STATE_VECTOR;

  const size = FIXED_HEADER + conv.length + (hasSince ? 4 : 0) + (vector ? 4 + vector.length : 0) + frame.update.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  out[4] = frame.kind ?? YJS_FRAME_KIND_SYNC;
  out[5] = flags;
  view.setUint16(6, conv.length);
  let at = FIXED_HEADER;
  out.set(conv, at);
  at += conv.length;
  if (hasSince) {
    view.setInt32(at, /** @type {number} */ (frame.sinceEditMs));
    at += 4;
  }
  if (vector) {
    view.setUint32(at, vector.length);
    at += 4;
    out.set(vector, at);
    at += vector.length;
  }
  out.set(frame.update, at);
  return out;
}

/**
 * Read one frame into the worker message it stands for. Returns null for
 * anything malformed, never reading past its end.
 * @param {ArrayBuffer|Uint8Array} raw - A received binary message
 * @returns {{conversationId: string, workerMsgType: 'yjs-sync'|'resync-response', payload: YjsSyncFramePayload}|null} The message, or null
 */
export function decodeYjsSyncFrame(raw) {
  const bytes = asBytes(raw);
  if (!isYjsSyncFrame(bytes) || bytes.length < FIXED_HEADER) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = MSG_TYPE[view.getUint8(4)];
  const flags = view.getUint8(5);
  if (!type || (flags & ~KNOWN_FLAGS) !== 0) return null;
  if ((flags & FLAG_STATE_VECTOR) && type !== 'resync-response') return null;

  const convLen = view.getUint16(6);
  let at = FIXED_HEADER;
  if (convLen === 0 || at + convLen > bytes.length) return null;
  const conversationId = new TextDecoder().decode(bytes.subarray(at, at + convLen));
  at += convLen;

  /** @type {YjsSyncFramePayload} */
  const payload = { type, bytes: null };
  if (flags & FLAG_ENGINE_DERIVED) payload.engineDerived = true;
  if (flags & FLAG_SINCE_EDIT) {
    if (at + 4 > bytes.length) return null;
    payload.sinceEditMs = view.getInt32(at);
    at += 4;
  }
  if (type === 'resync-response') payload.stateVector = null;
  if (flags & FLAG_STATE_VECTOR) {
    if (at + 4 > bytes.length) return null;
    const svLen = view.getUint32(at);
    at += 4;
    if (at + svLen > bytes.length) return null;
    payload.stateVector = bytes.subarray(at, at + svLen);
    at += svLen;
  }
  // An empty update is what the JSON form spelled null.
  payload.bytes = at < bytes.length ? bytes.subarray(at) : null;
  return { conversationId, workerMsgType: type, payload };
}
