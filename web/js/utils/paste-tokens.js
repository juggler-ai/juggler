//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Shared grammar + helpers for composer "pasted-text placeholder" tokens.
 *
 * A large paste is collapsed in the textarea into a run of ordinary characters:
 *
 *     U+2062  "[Pasted #7 · 38.2 KB]"  U+2063
 *     (open)   visible label, plain text   (close)
 *
 * The delimiters are genuinely zero-width/invisible in WebKit and are never
 * typed by users, so they bracket a token without disturbing its metrics; the
 * label is real text carrying the id (`#7`, the join key into a side table of
 * blob contents) and the byte size. Everything here is pure and backend-free so
 * any sender can expand a draft the same way, and so the grammar can be unit-tested in isolation.
 * @module utils/paste-tokens
 */

import { formatBytesUntranslated } from './format.js';

/** Open delimiter — U+2062 INVISIBLE TIMES. */
export const PASTE_TOKEN_OPEN = '\u2062';
/** Close delimiter — U+2063 INVISIBLE SEPARATOR. */
export const PASTE_TOKEN_CLOSE = '\u2063';

/**
 * Source of the token grammar. The `#N` id is the capture group; the size
 * portion accepts any run of characters that are neither a delimiter nor the
 * closing bracket, so the human-readable label stays flexible while the token
 * can never false-nest or swallow following text.
 */
const TOKEN_SOURCE = '\\u2062\\[Pasted #(\\d+) · [^\\u2062\\u2063\\]]*\\]\\u2063';

/**
 * A fresh global RegExp for the token grammar. Callers get their own instance
 * (never a shared one) so concurrent `exec`/`replace` loops can't clobber each
 * other's `lastIndex`.
 * @returns {RegExp} A new global-flag token regex.
 */
function pasteTokenRegex() {
  return new RegExp(TOKEN_SOURCE, 'g');
}

/**
 * @typedef {{id:number, content:string, bytes:number}} PasteBlob
 * A captured paste's full content plus its byte size, keyed by the token id.
 */

/**
 * @typedef {{id:number, start:number, end:number, text:string}} PasteTokenMatch
 * One token occurrence: its id, its `[start, end)` character span in the source
 * string, and the exact matched substring (delimiters included).
 */

/**
 * Coerce a blob side table — a `Map<number, {content, bytes}>` (the live
 * composer table) or an array of `{id, content, bytes}` records (a persisted
 * draft) — into an id→entry Map for lookup. Anything else yields an empty Map.
 * @param {Map<number, {content:string, bytes?:number}>|PasteBlob[]|null|undefined} blobs
 * @returns {Map<number, {content:string, bytes?:number}>} id→entry lookup.
 */
function blobLookup(blobs) {
  if (blobs instanceof Map) return blobs;
  if (Array.isArray(blobs)) {
    /** @type {Map<number, {content:string, bytes?:number}>} */
    const map = new Map();
    for (const b of blobs) {
      if (b && b.id !== null && b.id !== undefined && Number.isFinite(Number(b.id))) map.set(Number(b.id), b);
    }
    return map;
  }
  return new Map();
}

/**
 * Build a token string for `id` labelled with `bytes` (formatted as a compact
 * human size). This is the exact character run inserted into the textarea.
 *
 * The label is English, unit included, whatever the UI language: it is saved in
 * drafts and parsed back by {@link pasteTokenRegex}, whose size portion may not
 * hold a `]` a translated unit could carry, and an unresolvable token reaches
 * the model as its bare label.
 * @param {number} id - Monotonic per-draft token id.
 * @param {number} bytes - Byte size of the captured content, for the label.
 * @returns {string} The delimited token string.
 */
export function makeToken(id, bytes) {
  const size = formatBytesUntranslated(bytes) || `${Math.max(0, bytes | 0)} B`;
  return `${PASTE_TOKEN_OPEN}[Pasted #${id} · ${size}]${PASTE_TOKEN_CLOSE}`;
}

/**
 * Find every token occurrence in `text`, in order.
 * @param {string} text
 * @returns {PasteTokenMatch[]} The matches (empty if none / falsy input).
 */
export function parseTokens(text) {
  /** @type {PasteTokenMatch[]} */
  const out = [];
  if (!text) return out;
  const re = pasteTokenRegex();
  /** @type {RegExpExecArray|null} */
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ id: Number(m[1]), start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  return out;
}

/**
 * Whether `text` contains at least one well-formed token.
 * @param {string} text
 * @returns {boolean} True if any token is present.
 */
export function hasTokens(text) {
  return !!text && pasteTokenRegex().test(text);
}

/**
 * Expand every token in `text` to its full content, in place. A token whose id
 * resolves in `blobs` becomes that blob's content; an unresolvable token (only
 * possible via a corrupted/mixed-version draft) degrades to its bare label with
 * the invisible delimiters stripped, so the result is always plain, legible
 * text with no stray sentinels. This is what a send dispatches.
 * @param {string} text
 * @param {Map<number, {content:string}>|PasteBlob[]|null|undefined} blobs
 * @returns {string} The expanded text.
 */
export function expandPasteTokens(text, blobs) {
  if (!text) return text || '';
  const map = blobLookup(blobs);
  return text.replace(pasteTokenRegex(), (whole, idStr) => {
    const entry = map.get(Number(idStr));
    if (entry && typeof entry.content === 'string') return entry.content;
    return whole.slice(1, -1);
  });
}

/**
 * The next token id to allocate: one past the maximum id present in EITHER the
 * text or the side table. Deriving it from `1 + max` (rather than a count) keeps
 * ids monotonic even after tokens are deleted — the append-only table preserves
 * the high-water mark, so a delete-then-paste never reissues a live id.
 * @param {string} text
 * @param {Map<number, {content:string, bytes?:number}>|PasteBlob[]|null|undefined} blobs
 * @returns {number} The next id (>= 1).
 */
export function nextId(text, blobs) {
  let max = 0;
  for (const t of parseTokens(text)) if (t.id > max) max = t.id;
  for (const id of blobLookup(blobs).keys()) if (id > max) max = id;
  return max + 1;
}

/**
 * Remove stray delimiter characters — any U+2062/U+2063 that is NOT part of a
 * well-formed token whose id resolves in `blobs`. A backstop for the rare paths
 * that dodge the composer's interceptors (autocorrect/spell replace, exotic
 * IME) and leave a half-token behind; the worst survivor is the bracketed label
 * as plain text (ugly, legible, harmless). Well-formed, resolvable tokens are
 * left untouched.
 * @param {string} text
 * @param {Map<number, {content:string, bytes?:number}>|PasteBlob[]|null|undefined} [blobs] - When omitted,
 *   every well-formed token is treated as valid (grammar-only cleanup).
 * @returns {string} The cleaned text (same reference semantics as input).
 */
export function stripStrayDelimiters(text, blobs) {
  if (!text) return text || '';
  if (text.indexOf(PASTE_TOKEN_OPEN) === -1 && text.indexOf(PASTE_TOKEN_CLOSE) === -1) return text;
  const map = blobLookup(blobs);
  const checkResolves = arguments.length > 1 && map.size > 0;
  /** @type {Set<number>} Character indices covered by a valid token. */
  const valid = new Set();
  const re = pasteTokenRegex();
  /** @type {RegExpExecArray|null} */
  let m;
  while ((m = re.exec(text)) !== null) {
    if (checkResolves && !map.has(Number(m[1]))) continue;
    for (let i = m.index; i < m.index + m[0].length; i++) valid.add(i);
  }
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ((ch === PASTE_TOKEN_OPEN || ch === PASTE_TOKEN_CLOSE) && !valid.has(i)) continue;
    out += ch;
  }
  return out;
}
