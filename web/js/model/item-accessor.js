//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @file Item Accessor - Y.Map conversion helpers for conversation items
 * Converts plain JS objects to Y.Map CRDT types at insertion boundaries, and
 * back to plain values at read boundaries.
 * @module model/item-accessor
 */

import * as Y from '../vendor/yjs.mjs';

/**
 * @typedef {import('../../sdk/lib/message.js').YMapItem} YMapItem
 * @typedef {import('../../sdk/lib/message.js').ItemFields} ItemFields
 */

/**
 * A conversation item read through its `get`: a Y.Map from the document, or a
 * fixture standing in for one.
 * @typedef {Pick<YMapItem, 'get'>} ItemView
 */

/**
 * A conversation item as the document holds it, read and written by field name.
 * @typedef {YMapItem & {delete: (key: keyof ItemFields) => void, parent?: unknown}} ItemMap
 */

/**
 * Whether a value can be read as a conversation item: it has a `get`.
 * @param {unknown} value - A Y.Map, a stand-in for one, or anything else
 * @returns {value is ItemView} True when the value reads through `get`
 */
export function isItemView(value) {
  return !!value && typeof value === 'object' && 'get' in value && typeof value.get === 'function';
}

/**
 * Whether a value can be written as a conversation item: it has a `get`, a
 * `set` and a `delete`, as a Y.Map does.
 * @param {unknown} value - A Y.Map, or anything else
 * @returns {value is ItemMap} True when the value reads and writes by field name
 */
export function isItemMap(value) {
  return isItemView(value)
    && 'set' in value && typeof value.set === 'function'
    && 'delete' in value && typeof value.delete === 'function';
}

/**
 * Whether a value is a Y.Map: read, written and enumerated by key, whatever
 * the key's name.
 * @param {unknown} value - A Y.Map, or anything else
 * @returns {value is import('yjs').Map<unknown>} True for a Y.Map
 */
export function isYMap(value) {
  return isItemMap(value) && 'keys' in value && typeof value.keys === 'function';
}

/**
 * Whether a value is a Y.Array: something items can be read from and inserted into.
 * @param {unknown} value - A Y.Array, or anything else
 * @returns {value is import('yjs').Array<unknown>} True for a Y.Array
 */
export function isYArray(value) {
  return !!value && typeof value === 'object'
    && 'toArray' in value && typeof value.toArray === 'function'
    && 'insert' in value && typeof value.insert === 'function';
}

/**
 * The elements of a Y.Array or a plain array, as stored (a Y type stays one);
 * anything else has none.
 * @param {unknown} value - A Y.Array, a plain array, or nothing
 * @returns {unknown[]} The elements
 */
export function arrayItems(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && 'toArray' in value && typeof value.toArray === 'function') {
    /** @type {unknown} */
    const items = value.toArray();
    return Array.isArray(items) ? items : [];
  }
  return [];
}

/**
 * Read a CRDT value as plain JS. A field's stored shape is not stable: the
 * same key holds a Y.Map/Y.Array when it arrived through the CRDT and a plain
 * object when it was set locally before conversion, so every reader has to cope
 * with both. Non-CRDT values (objects, primitives, null, undefined) pass through
 * untouched, which makes this safe to wrap around any field read.
 *
 * The result is `unknown`: the caller narrows it, or reads it through
 * {@link plainRecord} / {@link plainList} when it expects an object or a list.
 * @param {unknown} value - Value read from a Y.Map/Y.Array, or an already-plain value
 * @returns {unknown} The plain-JS equivalent
 */
export function plain(value) {
  if (value && typeof value === 'object' && 'toJSON' in value && typeof value.toJSON === 'function') {
    return /** @type {unknown} */ (value.toJSON());
  }
  return value;
}

/**
 * A CRDT value as a plain record, or undefined when it is not an object.
 * Callers wanting an empty record for an absent field spell it
 * `plainRecord(v) ?? {}`.
 * @param {unknown} value - Value read from a Y.Map/Y.Array, or an already-plain value
 * @returns {Record<string, unknown>|undefined} The record, or undefined
 */
export function plainRecord(value) {
  const data = plain(value);
  return data && typeof data === 'object' && !Array.isArray(data)
    ? /** @type {Record<string, unknown>} */ (data)
    : undefined;
}

/**
 * A CRDT value as a plain list; anything that is not a list reads as empty.
 * @param {unknown} value - Value read from a Y.Array, or an already-plain value
 * @returns {unknown[]} The list's elements
 */
export function plainList(value) {
  const data = plain(value);
  return Array.isArray(data) ? data : [];
}

/**
 * One key of a Y.Map (or anything with a `get`) as stored, or undefined.
 * @param {unknown} item - Y.Map to read from
 * @param {string} key - Key to read
 * @returns {unknown} The stored value at `key`
 */
function getField(item, key) {
  if (!item || typeof item !== 'object' || !('get' in item) || typeof item.get !== 'function') return undefined;
  return /** @type {unknown} */ (item.get(key));
}

/**
 * Read one key off a thread item (or any Y.Map) as plain JS — `plain(item.get(key))`,
 * without spelling the `get` twice. This materialises the value; to read a field
 * as stored, from a Y.Map or a plain object alike, use `itemField`
 * (`sdk/lib/message.js`).
 * @param {unknown} item - Y.Map to read from
 * @param {string} key - Key to read
 * @returns {unknown} The plain-JS value at `key`
 */
export function yGet(item, key) {
  return plain(getField(item, key));
}

/**
 * Read one key off a thread item (or any Y.Map) as a plain record —
 * `plainRecord(item.get(key))`.
 * @param {unknown} item - Y.Map to read from
 * @param {string} key - Key to read
 * @returns {Record<string, unknown>|undefined} The record at `key`, or undefined when it is not an object
 */
export function yGetRecord(item, key) {
  return plainRecord(getField(item, key));
}

/**
 * Convert a plain object to a Y.Map with nested CRDT types.
 * Used at insertion boundaries when creating new items.
 * Nested objects become Y.Map, arrays become Y.Array, primitives pass through.
 * @param {unknown} obj - Plain object (anything else yields an empty map)
 * @returns {Y.Map} New Y.Map with properties set
 */
export function plainToYMap(obj) {
  const ymap = new Y.Map();
  if (!obj || typeof obj !== 'object') return ymap;

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    ymap.set(key, convertToYType(value));
  }
  return ymap;
}

/**
 * Convert a plain JS value to a Yjs CRDT type.
 * Objects → Y.Map, Arrays → Y.Array, primitives pass through.
 * Already-CRDT values (Y.Map, Y.Array) pass through unchanged.
 * @param {unknown} value - Value to convert
 * @returns {unknown} Converted value
 */
export function convertToYType(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Y.Map || value instanceof Y.Array) return value;

  if (Array.isArray(value)) {
    const yarr = new Y.Array();
    yarr.push(value.map(v => convertToYType(v)));
    return yarr;
  }

  if (typeof value === 'object') {
    const ymap = new Y.Map();
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || v === null) continue;
      ymap.set(k, convertToYType(v));
    }
    return ymap;
  }

  return value;
}
