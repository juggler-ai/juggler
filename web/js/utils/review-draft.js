//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The comments written against a working-tree review, as they are persisted.
 *
 * A review draft lives in the conversation's document beside the composer
 * draft, so the two policies here are about the same thing from two sides.
 * Reading is tolerant: whatever is in the document is normalised into a record
 * every caller can read unconditionally, and a comment that could not be drawn
 * is dropped rather than handed on. Writing is strict: a draft over a ceiling is
 * refused by {@link reviewDraftBoundsError}, never trimmed to fit.
 *
 * Which of the two applies to a given field is decided by who wrote it. The
 * quoted source lines are a copy of code that is also in the file, so they are
 * clamped in silence. The body is what the reader typed, and shortening that
 * quietly is losing their work — so it is refused instead, and the surface that
 * asked keeps the text and shows why.
 * @module utils/review-draft
 */

import { t, formatNumber } from '../../sdk/lib/i18n.js';

/**
 * What a draft may hold before a save is refused, and what a quote is cut to.
 *
 * The two ceilings are not the same kind of number. `comments` and `body` bound
 * a person — they are high enough that reaching one means something has gone
 * wrong rather than that a review was thorough. `quoteLines` and `quoteColumns`
 * bound a machine: a range selection and a minified line respectively, neither
 * of which is authored here.
 */
export const REVIEW_DRAFT_LIMITS = {
  /** Comments in one draft. */
  comments: 500,
  /** Characters in one comment's body. */
  body: 8000,
  /** Lines of quoted source kept against one comment. */
  quoteLines: 100,
  /** Characters kept of any one quoted line. */
  quoteColumns: 1000,
};

/** Where a comment hangs: a side of the diff, or the file as a whole. */
const SIDES = new Set(['old', 'new', 'file']);

/**
 * Whether a stored value names a side a comment can hang on.
 * @param {unknown} side - The stored side.
 * @returns {side is 'old'|'new'|'file'} True for one of {@link SIDES}.
 */
function isSide(side) {
  return typeof side === 'string' && SIDES.has(side);
}

/** The scope a comment with none was written in, spelled the way a Git pin spells it. */
const DEFAULT_SCOPE = '@uncommitted';

/** How long a scope's words may be; they are written by the host, not the reader. */
const SCOPE_LABEL_MAX = 500;

/**
 * One comment written against a line, a range, or a file. A superset of the
 * renderer's `DiffAnnotation` (`web/js/lib/diff-types.js`) — it carries what it
 * takes to find the comment again and to send it, which the renderer does not
 * need and so is not told.
 * @typedef {object} ReviewComment
 * @property {string} id - Identifies the comment for edit and delete
 * @property {string} repo - The repository it belongs to, '' for the project's own
 * @property {string} path - The file, relative to that repository
 * @property {string} [oldPath] - Where the file was, for a rename
 * @property {'old'|'new'|'file'} side - Which side of the diff it hangs on, or
 *   'file' for one about the file rather than any line in it
 * @property {number} [startLine] - First line it covers, absent for a file comment
 * @property {number} [endLine] - Last line it covers, absent for a file comment
 * @property {string[]} lineText - The source it quoted when it was written. All
 *   that is left to show once the file has moved on from it, which is why it is
 *   stored rather than re-read.
 * @property {string} body - What the reader wrote
 * @property {string} revision - The fingerprint of the patch it was written
 *   against. A comment whose file no longer answers to this is outdated, and is
 *   shown as outdated rather than re-anchored.
 * @property {string} [scope] - What the diff it was written on compared, as the
 *   pin asked for it — `@staged`, `main...HEAD`. Absent for the working tree
 *   against HEAD, which is every comment written before there was a choice.
 * @property {string} [scopeLabel] - That comparison in words, with the commits it
 *   came to when it was written: what the line numbers are line numbers of.
 * @property {number} createdAt - Unix ms it was written
 * @property {number} updatedAt - Unix ms it was last edited
 */

/**
 * One thread's unsent review.
 * @typedef {object} ReviewDraft
 * @property {number} version - The record's shape. Always 1; a reader that meets
 *   a number it does not know should refuse the record rather than guess at it.
 * @property {'head'} base - Kept for the record's shape. What each comment
 *   compared is its own `scope`, since one thread's review can span several.
 * @property {ReviewComment[]} comments - The comments, in the order they are shown
 */

/**
 * Anything a Yjs container hands back, as a plain object.
 * @param {unknown} raw - A Y.Map, a plain object, or neither.
 * @returns {Record<string, unknown>|null} The plain form, or null if it is not an object at all.
 */
function toPlain(raw) {
  if (!raw || typeof raw !== 'object') return null;
  /** @type {unknown} */
  const value = 'toJSON' in raw && typeof raw.toJSON === 'function' ? raw.toJSON() : raw;
  return value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : null;
}

/**
 * A stored list as an array, whether it is a Y.Array or a plain one.
 * @param {unknown} raw - A Y.Array, an array, or neither.
 * @returns {unknown[]|null} Its items, or null if it is not a list at all.
 */
function toList(raw) {
  /** @type {unknown} */
  const list = raw && typeof raw === 'object' && 'toArray' in raw && typeof raw.toArray === 'function'
    ? raw.toArray()
    : raw;
  return Array.isArray(list) ? list : null;
}

/**
 * The quoted source of one comment, bounded. A quote is a copy of code the file
 * still holds, so cutting it costs nothing that cannot be read elsewhere.
 * @param {unknown} raw - The stored lines, whatever they turn out to be.
 * @returns {string[]} At most `quoteLines` lines of at most `quoteColumns` each.
 */
function normalizeQuote(raw) {
  const list = toList(raw);
  if (!list) return [];
  return list
    .filter((line) => typeof line === 'string')
    .slice(0, REVIEW_DRAFT_LIMITS.quoteLines)
    .map((line) => line.slice(0, REVIEW_DRAFT_LIMITS.quoteColumns));
}

/**
 * A line number, or undefined for a comment that does not name one.
 * @param {unknown} value - The stored number.
 * @returns {number|undefined} A positive integer, or undefined.
 */
function normalizeLine(value) {
  const line = Number(value);
  return Number.isInteger(line) && line > 0 ? line : undefined;
}

/**
 * One comment, or null if what is stored could not be drawn against a file. A
 * comment with no id cannot be edited or deleted, one with no file has nowhere
 * to hang, and one with nothing written in it is not a comment — so none of the
 * three is worth carrying, and each is dropped rather than shown as a blank.
 * @param {unknown} raw - The stored comment.
 * @returns {ReviewComment|null} The comment, or null.
 */
function normalizeComment(raw) {
  const obj = toPlain(raw);
  if (!obj) return null;
  const id = typeof obj.id === 'string' ? obj.id : '';
  const path = typeof obj.path === 'string' ? obj.path : '';
  const body = typeof obj.body === 'string' ? obj.body : '';
  const side = isSide(obj.side) ? obj.side : '';
  if (!id || !path || !body.trim() || !side) return null;

  const at = Number(obj.createdAt);
  const edited = Number(obj.updatedAt);
  const createdAt = Number.isFinite(at) ? at : 0;
  /** @type {ReviewComment} */
  const comment = {
    id,
    repo: typeof obj.repo === 'string' ? obj.repo : '',
    path,
    side,
    lineText: normalizeQuote(obj.lineText),
    body,
    revision: typeof obj.revision === 'string' ? obj.revision : '',
    createdAt,
    updatedAt: Number.isFinite(edited) ? edited : createdAt,
  };
  if (typeof obj.oldPath === 'string' && obj.oldPath) comment.oldPath = obj.oldPath;
  const scope = typeof obj.scope === 'string' ? obj.scope.trim().split(/\s+/).filter(Boolean).join(' ') : '';
  if (scope && scope !== DEFAULT_SCOPE) {
    comment.scope = scope;
    if (typeof obj.scopeLabel === 'string' && obj.scopeLabel) {
      comment.scopeLabel = obj.scopeLabel.slice(0, SCOPE_LABEL_MAX);
    }
  }
  const startLine = normalizeLine(obj.startLine);
  if (startLine !== undefined) {
    comment.startLine = startLine;
    comment.endLine = normalizeLine(obj.endLine) ?? startLine;
  }
  return comment;
}

/**
 * A stored review draft as something every caller can read unconditionally.
 * Tolerant by design: this is what is already in the document, and hiding a
 * comment that is merely surprising would lose work nobody could get back.
 * @param {unknown} raw - The stored record: a Y.Map, a plain object, or nothing.
 * @returns {ReviewDraft} A well-formed draft, empty if there was nothing usable.
 */
export function normalizeReviewDraft(raw) {
  const stored = toList(toPlain(raw)?.comments);
  const comments = stored
    ? stored.map(normalizeComment).filter((comment) => comment !== null)
    : [];
  // Version and base are answered rather than echoed: there is one shape, and
  // what each comment compared is the comment's own business.
  return { version: 1, base: 'head', comments };
}

/**
 * Why a draft may not be written, or '' if it may. Checked before the record is
 * normalised, so the refusal describes what the caller actually handed over.
 * @param {unknown} draft - The draft a surface wants to save.
 * @returns {string} The complaint, ready to show, or '' when there is none.
 */
export function reviewDraftBoundsError(draft) {
  const comments = draft && typeof draft === 'object' && 'comments' in draft ? draft.comments : undefined;
  if (comments !== undefined && comments !== null && !Array.isArray(comments)) {
    return t('A review draft\'s comments must be a list.');
  }
  // Ungrouped, as the English has always shown them.
  const plain = { useGrouping: false };
  if (Array.isArray(comments) && comments.length > REVIEW_DRAFT_LIMITS.comments) {
    return t('A review holds at most {max} comments; this one has {count}.', {
      max: formatNumber(REVIEW_DRAFT_LIMITS.comments, plain),
      count: formatNumber(comments.length, plain),
    });
  }
  for (const comment of Array.isArray(comments) ? comments : []) {
    const body = comment && typeof comment === 'object' && typeof comment.body === 'string' ? comment.body : '';
    if (body.length > REVIEW_DRAFT_LIMITS.body) {
      return t('A comment holds at most {max} characters; this one has {length}.', {
        max: formatNumber(REVIEW_DRAFT_LIMITS.body, plain),
        length: formatNumber(body.length, plain),
      });
    }
  }
  return '';
}
