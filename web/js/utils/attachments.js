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
 * @typedef {{filename:string, content:string, bytes:number, extracted?:boolean}} TextFileSnapshot
 * `extracted` marks content a file viewer's `extract()` produced from a binary
 * file (a dropped PDF): it is already the model-facing text, `<file>` envelope
 * included, rather than the file's own text.
 */

/**
 * @typedef {{mime:string, text:boolean, lines?:number, head?:string, entries?:string[], entryCount?:number}} DropPreview
 * What the drop upload saw of a stored file (handlers.DropPreview): its sniffed
 * type; for text, its line count and first lines; for an archive, its first
 * entries and how many it has.
 */

/**
 * @typedef {{filename:string, path:string, absPath:string, bytes:number, sha256?:string, preview?:DropPreview}} StoredDrop
 * A dropped file too large, or too binary, to inline: uploaded to the project's
 * `.juggler-drops/` (handlers.DropRef). `path` is project-relative; `absPath`
 * is what the model is given, since a worktree conversation's shell runs
 * outside the project root.
 */

/**
 * @typedef {TextFileSnapshot|StoredDrop} DroppedFileEntry
 * One of a draft's dropped files: inline text, or a file stored in the project.
 */

/**
 * Whether a dropped-file entry is stored in the project rather than inline.
 * @param {DroppedFileEntry|Record<string, unknown>} entry
 * @returns {entry is StoredDrop} True for a stored drop.
 */
export function isStoredDrop(entry) {
  const fields = /** @type {Record<string, unknown>} */ (entry);
  return typeof fields.path === 'string' && typeof fields.absPath === 'string' && typeof fields.content !== 'string';
}

/**
 * A stored drop's preview cloned down to its own fields, or undefined when
 * there is none.
 * @param {unknown} raw
 * @returns {DropPreview|undefined} The preview.
 */
function plainDropPreview(raw) {
  /** @type {unknown} */
  const value = raw && typeof raw === 'object' && 'toJSON' in raw && typeof raw.toJSON === 'function' ? raw.toJSON() : raw;
  if (!value || typeof value !== 'object') return undefined;
  const p = /** @type {Record<string, unknown>} */ (value);
  return {
    mime: typeof p.mime === 'string' ? p.mime : '',
    text: p.text === true,
    ...(typeof p.lines === 'number' ? { lines: p.lines } : {}),
    ...(typeof p.head === 'string' ? { head: p.head } : {}),
    ...(Array.isArray(p.entries) ? { entries: p.entries.filter((e) => typeof e === 'string') } : {}),
    ...(typeof p.entryCount === 'number' ? { entryCount: p.entryCount } : {}),
  };
}

/**
 * A stored drop cloned down to its persistable fields, dropping any UI-only
 * state an entry carries while it uploads.
 * @param {StoredDrop} drop
 * @returns {StoredDrop} The plain record.
 */
export function plainStoredDrop(drop) {
  const preview = plainDropPreview(drop.preview);
  return {
    filename: drop.filename,
    path: drop.path,
    absPath: drop.absPath,
    bytes: drop.bytes,
    ...(drop.sha256 ? { sha256: drop.sha256 } : {}),
    ...(preview ? { preview } : {}),
  };
}

/**
 * @typedef {{id:number, content:string, bytes:number}} PasteBlob
 * The full content of a captured large paste, keyed by the inline token id
 * (`#N`) that stands in for it in the draft text. Persisted on the draft so a
 * composer placeholder survives a reload / thread switch / remote client, and
 * so send-time expansion can resolve every token back to its content. See
 * utils/paste-tokens.
 */

/**
 * @typedef {{text: string, attachments: AssetRef[], textFiles: DroppedFileEntry[], pasteBlobs: PasteBlob[]}} Draft
 * A draft carries no timer: a scheduled send leaves the box for the thread's
 * pending queue, where the worker holds it. Any other key on a stored record
 * is not read.
 */

/**
 * Normalize a draft's `textFiles` field — dropped files, inline snapshots and
 * drops stored in the project — into plain records. Like
 * {@link normalizeAttachments}, it accepts either a plain array of plain
 * objects (synced from the Go worker) or a Y.Array of Y.Maps. Entries with
 * neither string content nor a stored path are dropped.
 * @param {unknown} raw
 * @returns {DroppedFileEntry[]} Plain dropped-file entries (empty if none).
 */
export function normalizeTextFiles(raw) {
  /** @type {DroppedFileEntry[]} */
  const out = [];
  for (const entry of toPlainList(raw)) {
    const file = entryFields(entry, ['filename', 'content', 'bytes', 'extracted', 'path', 'absPath', 'sha256', 'preview']);
    const content = file?.content;
    const filename = typeof file?.filename === 'string' ? file.filename : markUntranslated('dropped file');
    const bytes = typeof file?.bytes === 'number' ? file.bytes : 0;
    if (typeof content === 'string') {
      out.push({ filename, content, bytes, ...(file?.extracted === true ? { extracted: true } : {}) });
      continue;
    }
    const path = file?.path;
    const absPath = file?.absPath;
    if (typeof path !== 'string' || !path || typeof absPath !== 'string' || !absPath) continue;
    const preview = plainDropPreview(file?.preview);
    out.push({
      filename, path, absPath, bytes,
      ...(typeof file?.sha256 === 'string' ? { sha256: file.sha256 } : {}),
      ...(preview ? { preview } : {}),
    });
  }
  return out;
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
