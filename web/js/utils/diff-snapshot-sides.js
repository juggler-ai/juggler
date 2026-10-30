//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The two sides of a tool action's recorded diff, wherever they are kept.
 *
 * An edit's `displayData.diffData` holds each side one of two ways: inline, as
 * `oldContent` / `newContent` (every diff written before the sides were stored
 * apart, and any whose upload failed), or as `oldRef` / `newRef`, the id of a
 * text asset in the conversation's asset store. Ref'd sides are fetched on
 * demand, and remembered by id: an asset never changes, so a side seen once —
 * the after of one edit is often the before of the next — is never fetched again.
 */

import { fetchAssetText } from '../services/ops-api.js';

/**
 * How one side of a recorded diff is kept.
 * @typedef {{content: string}|{ref: string}} DiffSide
 */

/**
 * A recorded diff, as the properties panel draws it.
 * @typedef {object} DiffSnapshotShape
 * @property {DiffSide} old - The file before.
 * @property {DiffSide} new - The file after.
 * @property {string} path - The file's path, or '' when the diff names none.
 * @property {number} startLineNumber - The first line's number, or 0 when unrecorded.
 */

/** How many fetched sides are remembered. */
const CACHE_SIZE = 32;

/** @type {Map<string, Promise<string>>} Most recently used last. */
const cache = new Map();

/**
 * One side of a diff, read from its inline and ref fields.
 * @param {Record<string, unknown>} d - The diffData.
 * @param {'old'|'new'} side - Which side.
 * @returns {DiffSide|null} The side, or null when it was not recorded.
 */
function sideOf(d, side) {
  const content = d[`${side}Content`];
  if (typeof content === 'string') return { content };
  const ref = d[`${side}Ref`];
  if (typeof ref === 'string' && ref) return { ref };
  return null;
}

/**
 * The diff a tool action's display data records, when both sides were recorded.
 * @param {unknown} displayData - The display data, plain.
 * @returns {DiffSnapshotShape|null} The diff, or null when there is none.
 */
export function diffSnapshotShape(displayData) {
  if (!displayData || typeof displayData !== 'object' || !('diffData' in displayData)) return null;
  const d = /** @type {Record<string, unknown>} */ (displayData.diffData);
  if (!d || typeof d !== 'object') return null;
  const before = sideOf(d, 'old');
  const after = sideOf(d, 'new');
  if (!before || !after) return null;
  return {
    old: before,
    new: after,
    path: typeof d.path === 'string' ? d.path : '',
    startLineNumber: typeof d.startLineNumber === 'number' ? d.startLineNumber : 0,
  };
}

/**
 * Whether neither side holds anything — the one diff there is nothing to draw for.
 * @param {DiffSnapshotShape} shape - The diff.
 * @returns {boolean} True when both sides are inline and empty.
 */
export function isEmptyDiff(shape) {
  return 'content' in shape.old && shape.old.content === '' && 'content' in shape.new && shape.new.content === '';
}

/**
 * The text of a stored side, fetched once per id.
 * @param {string} conversationId - The conversation that stored it.
 * @param {string} ref - The asset id.
 * @returns {Promise<string>} The text.
 */
function fetchSide(conversationId, ref) {
  const known = cache.get(ref);
  if (known) {
    cache.delete(ref);
    cache.set(ref, known);
    return known;
  }
  const pending = fetchAssetText(conversationId, ref);
  cache.set(ref, pending);
  // A failed fetch is not remembered, so the next look tries again.
  pending.catch(() => { if (cache.get(ref) === pending) cache.delete(ref); });
  while (cache.size > CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return pending;
}

/**
 * Both sides of a recorded diff as text: inline sides as they are, stored ones
 * fetched from the conversation's asset store.
 * @param {string} conversationId - The conversation the diff belongs to.
 * @param {DiffSnapshotShape} shape - The diff.
 * @returns {Promise<{oldContent: string, newContent: string}>} The two files.
 */
export async function loadDiffSides(conversationId, shape) {
  const read = (/** @type {DiffSide} */ side) => {
    if ('content' in side) return Promise.resolve(side.content);
    if (!conversationId) return Promise.reject(new Error('No conversation to load this diff from'));
    return fetchSide(conversationId, side.ref);
  };
  const [oldContent, newContent] = await Promise.all([read(shape.old), read(shape.new)]);
  return { oldContent, newContent };
}
