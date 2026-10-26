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
 * @param {any} raw
 * @returns {any[]} Plain array of the (still possibly Y.Map) entries.
 */
function toPlainList(raw) {
  return typeof raw?.toArray === 'function' ? raw.toArray() : (Array.isArray(raw) ? raw : []);
}

/**
 * Normalize a user item's `attachments` field into plain AssetRef objects.
 * @param {any} raw
 * @returns {AssetRef[]} Plain attachment refs (empty if none).
 */
export function normalizeAttachments(raw) {
  return toPlainList(raw)
    .map((/** @type {any} */ ref) => (ref && typeof ref.get === 'function')
      ? { id: ref.get('id'), mime: ref.get('mime'), filename: ref.get('filename'), bytes: ref.get('bytes'), width: ref.get('width'), height: ref.get('height') }
      : ref)
    .filter((/** @type {any} */ ref) => ref && ref.id);
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
 * @param {any} raw
 * @returns {TextFileSnapshot[]} Plain text-file snapshots (empty if none).
 */
export function normalizeTextFiles(raw) {
  return toPlainList(raw)
    .map((/** @type {any} */ t) => (t && typeof t.get === 'function')
      ? { filename: t.get('filename'), content: t.get('content'), bytes: t.get('bytes') }
      : t)
    .filter((/** @type {any} */ t) => t && typeof t.content === 'string')
    .map((/** @type {any} */ t) => ({
      filename: typeof t.filename === 'string' ? t.filename : markUntranslated('dropped file'),
      content: t.content,
      bytes: typeof t.bytes === 'number' ? t.bytes : 0
    }));
}

/**
 * Normalize a draft's `pasteBlobs` field — the captured contents of large
 * pastes collapsed into inline placeholder tokens — into plain records. Like
 * {@link normalizeTextFiles}, it accepts either a plain array or a Y.Array of
 * Y.Maps. Entries without string content or a finite id are dropped.
 * @param {any} raw
 * @returns {PasteBlob[]} Plain paste blobs (empty if none).
 */
export function normalizePasteBlobs(raw) {
  return toPlainList(raw)
    .map((/** @type {any} */ b) => (b && typeof b.get === 'function')
      ? { id: b.get('id'), content: b.get('content'), bytes: b.get('bytes') }
      : b)
    .filter((/** @type {any} */ b) => b && typeof b.content === 'string' && Number.isFinite(Number(b.id)))
    .map((/** @type {any} */ b) => ({
      id: Number(b.id),
      content: b.content,
      bytes: typeof b.bytes === 'number' ? b.bytes : 0
    }));
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
 * @param {any} raw
 * @returns {Draft} The draft (empty text + no attachments/text-files when absent).
 */
export function normalizeDraft(raw) {
  if (!raw) return { text: '', attachments: [], textFiles: [], pasteBlobs: [] };
  const obj = (typeof raw.toJSON === 'function') ? raw.toJSON() : raw;
  const text = (obj && typeof obj.text === 'string') ? obj.text : '';
  return {
    text,
    attachments: normalizeAttachments(obj && obj.attachments),
    textFiles: normalizeTextFiles(obj && obj.textFiles),
    pasteBlobs: normalizePasteBlobs(obj && obj.pasteBlobs)
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
