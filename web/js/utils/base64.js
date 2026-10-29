//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * base64 <-> Uint8Array conversion for the worker/engine yjs-sync transport. Go's
 * json.Marshal encodes `[]byte` as base64 and json.Unmarshal expects the same, so
 * every doc update crossing the boundary is packed/unpacked here.
 * @module utils/base64
 */

/**
 * Encode raw bytes as a base64 string.
 * @param {Uint8Array} bytes - The bytes to encode.
 * @returns {string} The base64 representation.
 */
export function bytesToBase64(bytes) {
  // Converted a block at a time: btoa needs one binary string, and building that
  // string per byte costs hundreds of milliseconds of blocked main thread on the
  // multi-megabyte updates a full-state sync carries. String.fromCharCode takes
  // the bytes as arguments, so the block stays well inside the engine's argument
  // limit rather than near it.
  const BLOCK = 0x8000;
  if (bytes.length <= BLOCK) {
    return globalThis.btoa(String.fromCharCode(...bytes));
  }
  const blocks = [];
  for (let i = 0; i < bytes.length; i += BLOCK) {
    blocks.push(String.fromCharCode(...bytes.subarray(i, i + BLOCK)));
  }
  return globalThis.btoa(blocks.join(''));
}

/**
 * Decode a base64 string back into raw bytes.
 * @param {string} base64 - The base64 string to decode.
 * @returns {Uint8Array} The decoded bytes.
 */
export function base64ToBytes(base64) {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
