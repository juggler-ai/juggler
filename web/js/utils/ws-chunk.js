//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Reassembly for messages the server had to split.
 *
 * A WebSocket message has no size limit on the wire, but every client library
 * imposes one on what it will accept. Node's built-in WebSocket — what the
 * headless engine host runs on — refuses anything over 128 MiB by closing the
 * connection, which nothing recovers from on its own: the client reconnects,
 * the server re-sends the same message, and the conversation stays unusable.
 * So the server splits a message that large into binary frames (see
 * cmd/juggler/server/ws_chunk.go) and this puts it back together.
 *
 * The frame layout is fixed on both sides:
 *
 *   magic   4 bytes   "JGC1"
 *   kind    1 byte    what the reassembled bytes are (WS_CHUNK_KIND_*)
 *   id      8 bytes   uint64 BE, unique per connection
 *   index   4 bytes   uint32 BE
 *   total   4 bytes   uint32 BE
 *   data    remainder
 * @module utils/ws-chunk
 */

/** Bytes of fixed header before a chunk's data. Matches wsChunkHeaderSize. */
export const WS_CHUNK_HEADER_SIZE = 21;

/** Reassembled bytes are a UTF-8 text message. */
export const WS_CHUNK_KIND_TEXT = 0;

const MAGIC = [0x4a, 0x47, 0x43, 0x31]; // "JGC1"

/**
 * @typedef {object} WSChunkFrame
 * @property {number} kind - One of WS_CHUNK_KIND_*
 * @property {string} id - The run this frame belongs to
 * @property {number} index - Position within the run, from 0
 * @property {number} total - How many frames the run has
 * @property {Uint8Array} data - This frame's slice of the payload
 */

/**
 * Read a chunk frame. Returns null for anything that is not one, so an ordinary
 * binary message is never mistaken for a chunk and swallowed.
 * @param {ArrayBuffer|Uint8Array} raw - A received binary message
 * @returns {WSChunkFrame|null} The parsed frame, or null if it is not one
 */
export function parseWSChunkFrame(raw) {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (bytes.length < WS_CHUNK_HEADER_SIZE) return null;
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The id is read as two 32-bit halves rather than a BigInt purely to keep the
  // key a plain string; nothing here does arithmetic on it.
  const id = `${view.getUint32(5)}-${view.getUint32(9)}`;
  const index = view.getUint32(13);
  const total = view.getUint32(17);
  if (total === 0 || index >= total) return null;

  return {
    kind: view.getUint8(4),
    id,
    index,
    total,
    data: bytes.subarray(WS_CHUNK_HEADER_SIZE)
  };
}

/**
 * Collects the frames of a split message until it is whole again.
 *
 * One of these belongs to one connection. The server writes a run of frames
 * from a single goroutine, so in practice they arrive contiguous and in order,
 * but nothing here assumes that: frames are placed by index and the run
 * completes when every slot is filled. The id is what keeps two runs apart, so
 * a dropped frame strands its own run rather than splicing the next one onto
 * it.
 */
export class WSChunkReassembler {
  constructor() {
    /** @type {Map<string, {total: number, kind: number, parts: (Uint8Array|undefined)[], received: number, bytes: number}>} @private */
    this._runs = new Map();
  }

  /**
   * Offer a received binary message.
   * @param {ArrayBuffer|Uint8Array} raw - The received binary message
   * @returns {{kind: number, bytes: Uint8Array}|null} The reassembled message
   *   once its last frame has arrived; null while the run is still incomplete,
   *   or if `raw` was not a chunk frame at all (distinguish with
   *   {@link parseWSChunkFrame} when that matters)
   */
  accept(raw) {
    const frame = parseWSChunkFrame(raw);
    if (!frame) return null;

    let run = this._runs.get(frame.id);
    if (!run) {
      run = {
        total: frame.total,
        kind: frame.kind,
        parts: new Array(frame.total),
        received: 0,
        bytes: 0
      };
      this._runs.set(frame.id, run);
    }
    // A run whose frames disagree about their own shape is not a run. Drop it
    // rather than assembling something that was never sent.
    if (run.total !== frame.total || run.kind !== frame.kind) {
      this._runs.delete(frame.id);
      return null;
    }
    // First writer wins, so a retransmitted frame cannot double-count and leave
    // the run permanently one short of complete.
    if (run.parts[frame.index] === undefined) {
      run.parts[frame.index] = frame.data;
      run.received++;
      run.bytes += frame.data.length;
    }
    if (run.received !== run.total) return null;

    this._runs.delete(frame.id);
    const bytes = new Uint8Array(run.bytes);
    let at = 0;
    for (const part of run.parts) {
      if (!part) continue;
      bytes.set(part, at);
      at += part.length;
    }
    return { kind: run.kind, bytes };
  }

  /**
   * Forget every partial run. Called when the link dies: the frames still
   * outstanding belong to a connection that will never finish sending them, and
   * the next connection starts its ids again from one.
   */
  reset() {
    this._runs.clear();
  }

  /** @returns {number} How many runs are part-way through. Diagnostics only. */
  get pending() {
    return this._runs.size;
  }
}
