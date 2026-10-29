//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Shared helpers for user-message image attachments (AssetRefs).
 *
 * `normalizeAttachments` collapses the `attachments` field — which arrives
 * either as a plain array of plain objects (embedded JSON synced from the Go
 * worker) or, defensively, as a Y.Array of Y.Maps — into plain AssetRef
 * records. Lives here (rather than in a component) so both the conversation
 * area and the service-layer properties-panel renderers can share it without a
 * component→service layering inversion.
 * @module utils/attachments
 */

import { formatBytes } from './format.js';
import { markUntranslated } from '../../sdk/lib/i18n.js';

/**
 * @typedef {{id:string, mime:string, filename:string, bytes:number, width:number, height:number}} AssetRef
 */

/**
 * Coerce a synced list field into a plain array. The value arrives either as a
 * plain array (embedded JSON synced from the Go worker) or, defensively, as a
 * Y.Array; anything else yields an empty array.
 * @param {unknown} raw
 * @returns {unknown[]} Plain array of the (still possibly Y.Map) entries.
 */
function toPlainList(raw) {
  if (raw && typeof raw === 'object' && 'toArray' in raw && typeof raw.toArray === 'function') {
    /** @type {unknown} */
    const list = raw.toArray();
    return Array.isArray(list) ? list : [];
  }
  return Array.isArray(raw) ? raw : [];
}

/**
 * One list entry as a record: a Y.Map entry read for the named fields, a plain
 * object as it is, and null for anything that is not an object.
 * @param {unknown} entry - The stored entry.
 * @param {readonly string[]} keys - The fields read off a Y.Map entry.
 * @returns {Record<string, unknown>|null} The entry's fields, or null.
 */
function entryFields(entry, keys) {
  if (!entry || typeof entry !== 'object') return null;
  if ('get' in entry && typeof entry.get === 'function') {
    const get = entry.get;
    return Object.fromEntries(keys.map((key) => [key, /** @type {unknown} */ (get.call(entry, key))]));
  }
  return /** @type {Record<string, unknown>} */ (entry);
}

/** The fields of an AssetRef. */
const ASSET_REF_KEYS = ['id', 'mime', 'filename', 'bytes', 'width', 'height'];

/**
 * Normalize a user item's `attachments` field into plain AssetRef objects.
 * @param {unknown} raw
 * @returns {AssetRef[]} Plain attachment refs (empty if none).
 */
export function normalizeAttachments(raw) {
  return toPlainList(raw).flatMap((entry) => {
    const ref = entryFields(entry, ASSET_REF_KEYS);
    return ref && ref.id ? [/** @type {AssetRef} */ (ref)] : [];
  });
}

/**
 * @typedef {{filename:string, content:string, bytes:number}} TextFileSnapshot
 */

/**
 * @typedef {{id:number, content:string, bytes:number}} PasteBlob
 * The full content of a captured large paste, keyed by the inline token id
 * (`#N`) that stands in for it in the draft text. Persisted on the draft so a
 * composer placeholder survives a reload / thread switch / remote client, and
 * so send-time expansion can resolve every token back to its content. See
 * utils/paste-tokens.
 */

/**
 * @typedef {{text: string, attachments: AssetRef[], textFiles: TextFileSnapshot[], pasteBlobs: PasteBlob[]}} Draft
 * A draft carries no timer: a scheduled send leaves the box for the thread's
 * pending queue, where the worker holds it. Any other key on a stored record
 * is not read.
 */

/**
 * Normalize a draft's `textFiles` field — dropped text-file snapshots — into
 * plain records. Like {@link normalizeAttachments}, it accepts either a plain
 * array of plain objects (synced from the Go worker) or a Y.Array of Y.Maps.
 * Entries without string content are dropped.
 * @param {unknown} raw
 * @returns {TextFileSnapshot[]} Plain text-file snapshots (empty if none).
 */
export function normalizeTextFiles(raw) {
  return toPlainList(raw).flatMap((entry) => {
    const file = entryFields(entry, ['filename', 'content', 'bytes']);
    const content = file?.content;
    if (typeof content !== 'string') return [];
    const filename = file?.filename;
    const bytes = file?.bytes;
    return [{
      filename: typeof filename === 'string' ? filename : markUntranslated('dropped file'),
      content,
      bytes: typeof bytes === 'number' ? bytes : 0
    }];
  });
}

/**
 * Normalize a draft's `pasteBlobs` field — the captured contents of large
 * pastes collapsed into inline placeholder tokens — into plain records. Like
 * {@link normalizeTextFiles}, it accepts either a plain array or a Y.Array of
 * Y.Maps. Entries without string content or a finite id are dropped.
 * @param {unknown} raw
 * @returns {PasteBlob[]} Plain paste blobs (empty if none).
 */
export function normalizePasteBlobs(raw) {
  return toPlainList(raw).flatMap((entry) => {
    const blob = entryFields(entry, ['id', 'content', 'bytes']);
    const content = blob?.content;
    const id = Number(blob?.id);
    if (typeof content !== 'string' || !Number.isFinite(id)) return [];
    const bytes = blob?.bytes;
    return [{ id, content, bytes: typeof bytes === 'number' ? bytes : 0 }];
  });
}

/**
 * Normalize the `draft` field — the unsent composer-box draft, stored as a single
 * `{text, attachments, textFiles, pasteBlobs}` record (a Y.Map on a thread
 * container, or a plain object synced from conversation metadata) — into a
 * plain Draft. Always returns a well-formed record so callers can read every
 * part unconditionally.
 * Modelling the draft as ONE record (rather than a bare text string plus
 * component-local attachments) is what makes a half-persisted draft — text
 * kept, attachments/text-files lost across a reload — structurally impossible.
 * @param {unknown} raw
 * @returns {Draft} The draft (empty text + no attachments/text-files when absent).
 */
export function normalizeDraft(raw) {
  if (!raw || typeof raw !== 'object') return { text: '', attachments: [], textFiles: [], pasteBlobs: [] };
  /** @type {unknown} */
  const value = 'toJSON' in raw && typeof raw.toJSON === 'function' ? raw.toJSON() : raw;
  const obj = value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
  return {
    text: typeof obj.text === 'string' ? obj.text : '',
    attachments: normalizeAttachments(obj.attachments),
    textFiles: normalizeTextFiles(obj.textFiles),
    pasteBlobs: normalizePasteBlobs(obj.pasteBlobs)
  };
}

/**
 * Format a byte count as a compact human-readable size ("823 B", "12.3 KB",
 * "4.1 MB"). Returns an empty string for a missing/zero/invalid count so
 * callers can omit the field entirely.
 * @param {number} bytes
 * @returns {string} Formatted size, or '' when there is nothing to show.
 */
export function formatAttachmentBytes(bytes) {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '';
  return formatBytes(bytes);
}
