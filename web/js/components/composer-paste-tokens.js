//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * composer-paste-tokens — the composer's pasted-text placeholder tokens, for
 * composer.js.
 *
 * A large paste collapses into an inline placeholder token — a run of ordinary
 * characters (invisible delimiters bracketing a visible label) that behaves as
 * text in every way (undoable, single-backspace-deletable, selectable,
 * copyable) yet renders as a styled pill. The full content lives in the
 * append-only `_pasteBlobs` table and is inlined at its exact position at send
 * time, so the model/stored message is identical to a plain paste. See
 * utils/paste-tokens.js for the grammar and the pure helpers.
 *
 * This module owns the composer-side machinery: the capture thresholds, the
 * atomic-token editing rules (a token is deleted whole, never entered), the
 * clipboard expansion on copy/cut, and the mirror overlay that draws the pill
 * behind the textarea.
 *
 * Each function takes the Composer element as its first argument and reads or
 * writes its state through it, mirroring conversation-area-rendering.js.
 * @module components/composer-paste-tokens
 */

import {
  makeToken,
  parseTokens,
  hasTokens,
  expandPasteTokens,
  nextId as nextPasteId,
  stripStrayDelimiters,
  PASTE_TOKEN_OPEN,
  PASTE_TOKEN_CLOSE
} from '../utils/paste-tokens.js';
import { looksBinary } from './composer-attachments.js';
import { formatCodeReference } from '../../sdk/lib/context-item-utils.js';

/**
 * A pasted-text payload at or above EITHER threshold is captured into an inline
 * placeholder token instead of flooding the textarea: ~2,500 characters (about
 * one screenful) or 40 lines. Below both, the paste lands as ordinary text
 * exactly as before. Tuned by feel — a modest snippet stays inline; a source
 * file or a long log collapses to a chip.
 */
const PASTE_CHIP_MIN_CHARS = 2_500;

/** Line-count companion to {@link PASTE_CHIP_MIN_CHARS}. */
const PASTE_CHIP_MIN_LINES = 40;

/**
 * Whether a pasted text payload is large enough to capture into a placeholder
 * token rather than land as ordinary text. Either threshold trips it; a
 * payload that decodes as binary is also captured (defensive — don't flood the
 * box with mojibake).
 * @param {string} text
 * @returns {boolean} True to capture, false to paste normally.
 */
export function shouldCapturePaste(text) {
  if (looksBinary(text)) return true;
  if (text.length >= PASTE_CHIP_MIN_CHARS) return true;
  // Count newlines rather than splitting (cheaper on a big blob).
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return lines >= PASTE_CHIP_MIN_LINES;
}

/**
 * UTF-8 byte size of a string, for the token label.
 * @param {string} str
 * @returns {number} Byte length.
 */
function pasteByteLength(str) {
  try { return new Blob([str]).size; } catch { return str.length; }
}

/**
 * Capture `content` as an inline placeholder: allocate (or reuse, on an exact
 * content match) a token id, store the blob, and insert the token string at
 * the caret. The insert goes through the native editing path so Cmd+Z undoes
 * the capture as one edit; the blob stays in the append-only table until GC.
 * @param {any} composer - Composer instance
 * @param {string} content
 */
export function capturePaste(composer, content) {
  const textarea = /** @type {HTMLTextAreaElement|null} */ (composer.querySelector('textarea'));
  if (!textarea) return;
  const bytes = pasteByteLength(content);
  // Dedup: identical content already captured reuses that id (double-paste
  // gives two tokens sharing one blob; both expand at send). Exact === only.
  let id = null;
  for (const [existingId, blob] of composer._pasteBlobs) {
    if (blob.content === content) { id = existingId; break; }
  }
  if (id === null) {
    id = nextPasteId(textarea.value, composer._pasteBlobs);
    composer._pasteBlobs.set(id, { content, bytes });
  }
  insertAtCaret(composer, textarea, makeToken(id, bytes));
}

/**
 * Insert `text` at the caret, preferring the native undoable path
 * (execCommand) and falling back to a direct value splice where the host
 * rejects the command (older engines, headless test window). Leaves the caret
 * after the inserted text, and settles the box around it — mirror, autosize,
 * Send button, persisted draft — exactly as a typed edit would.
 *
 * The composer's only insert-at-caret primitive, so anything putting generated
 * text into the box goes through it: replacing the whole value instead would
 * silently destroy a draft the user was part-way through, and would not be one
 * undo away from where they were.
 * @param {any} composer - Composer instance
 * @param {HTMLTextAreaElement} textarea
 * @param {string} text
 */
export function insertAtCaret(composer, textarea, text) {
  textarea.focus();
  const before = textarea.value;
  // Baseline the reconciler to the pre-insert value: execCommand fires `input`
  // synchronously below, and it must compare against what the box holds NOW —
  // never a stale base that would make it revert this trusted insert.
  composer._pasteLastValue = before;
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
  if (!ok || textarea.value === before) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    textarea.value = before.slice(0, start) + text + before.slice(end);
    const pos = start + text.length;
    try { textarea.setSelectionRange(pos, pos); } catch { /* non-fatal */ }
  }
  afterTokenMutation(composer, textarea);
}

/**
 * Write a code reference into a composer at its caret, on its own line.
 *
 * Insertion, never replacement: the draft the user was part-way through is the
 * thing this must not cost them, and one undo takes the quote back out. Nothing
 * is sent — the block ends on an empty line, which is where they say what they
 * wanted to ask.
 * @param {any} composer - Composer instance
 * @param {import('../utils/code-selection.js').CodeSelection|object} reference - What to quote.
 * @returns {boolean} True when the text landed.
 */
export function insertCodeReference(composer, reference) {
  const textarea = /** @type {HTMLTextAreaElement|null} */ (composer?.querySelector?.('textarea'));
  if (!textarea) return false;
  const caret = textarea.selectionStart ?? textarea.value.length;
  const before = textarea.value.slice(0, caret);
  // The header must start a line to be read as one, so a caret left mid-sentence
  // gets a break first rather than the reference spliced into the sentence.
  const lead = before !== '' && !before.endsWith('\n') ? '\n' : '';
  insertAtCaret(composer, textarea, lead + formatCodeReference(reference));
  return true;
}

/**
 * Delete the `[start, end)` character range, preferring the native undoable
 * path (select + execCommand('delete')) with a direct-splice fallback.
 * @param {any} composer - Composer instance
 * @param {HTMLTextAreaElement} textarea
 * @param {number} start
 * @param {number} end
 */
function deleteRange(composer, textarea, start, end) {
  textarea.focus();
  const before = textarea.value;
  // Baseline the reconciler to the pre-delete value (see _insertAtCaret): the
  // token in [start, end) is fully inside the change, so the delete reads as
  // legitimate rather than a partial-interior edit to revert.
  composer._pasteLastValue = before;
  try { textarea.setSelectionRange(start, end); } catch { /* non-fatal */ }
  let ok = false;
  try { ok = document.execCommand('delete', false); } catch { ok = false; }
  if (!ok || textarea.value === before) {
    textarea.value = before.slice(0, start) + before.slice(end);
    try { textarea.setSelectionRange(start, start); } catch { /* non-fatal */ }
  }
  afterTokenMutation(composer, textarea);
}

/**
 * Replace a token with its full content in place (undoable). Cmd+Z afterwards
 * restores the placeholder: the token characters come back and the append-only
 * table still resolves them.
 * @param {any} composer - Composer instance
 * @param {HTMLTextAreaElement} textarea
 * @param {import('../utils/paste-tokens.js').PasteTokenMatch} tok
 */
function expandToken(composer, textarea, tok) {
  const entry = composer._pasteBlobs.get(tok.id);
  const content = entry ? entry.content : tok.text.slice(1, -1);
  textarea.focus();
  try { textarea.setSelectionRange(tok.start, tok.end); } catch { /* non-fatal */ }
  const before = textarea.value;
  // Baseline the reconciler to the pre-expand value (see _insertAtCaret): the
  // token is fully inside the replaced range, so expansion reads as legitimate.
  composer._pasteLastValue = before;
  let ok = false;
  try { ok = document.execCommand('insertText', false, content); } catch { ok = false; }
  if (!ok || textarea.value === before) {
    textarea.value = before.slice(0, tok.start) + content + before.slice(tok.end);
    const pos = tok.start + content.length;
    try { textarea.setSelectionRange(pos, pos); } catch { /* non-fatal */ }
  }
  afterTokenMutation(composer, textarea);
}

/**
 * Atomicity for placeholder tokens under Backspace/Delete/Arrow keys. Returns
 * true (and prevents the default) when it acted on a token, false to let the
 * key behave normally. A fast no-op when the text holds no tokens.
 * @param {any} composer - Composer instance
 * @param {KeyboardEvent} e
 * @param {HTMLTextAreaElement} textarea
 * @returns {boolean} Whether the key was handled as a token operation.
 */
export function handleTokenKeydown(composer, e, textarea) {
  const key = e.key;
  if (key !== 'Backspace' && key !== 'Delete' && key !== 'ArrowLeft' && key !== 'ArrowRight') return false;
  const value = textarea.value;
  if (!hasTokens(value)) return false;
  const collapsed = textarea.selectionStart === textarea.selectionEnd;
  if (!collapsed) return false; // selection-based edits: snapping keeps endpoints out
  const p = textarea.selectionStart;
  const tokens = parseTokens(value);

  if (key === 'Backspace' || key === 'Delete') {
    // Any delete that ABUTS a token in the delete direction — plain, Shift,
    // word (Alt, or Ctrl off macOS) or line (Meta) — would otherwise chew into
    // the label, so remove the whole token as one unit instead.
    const tok = key === 'Backspace'
      ? tokens.find((t) => t.end === p)
      : tokens.find((t) => t.start === p);
    if (!tok) return false;
    e.preventDefault();
    deleteRange(composer, textarea, tok.start, tok.end);
    return true;
  }

  // Plain arrows skip a token as one unit. Modified arrows (word/line move,
  // shift-select) fall through to native motion; the selection-snapper then
  // bounces any caret/endpoint that landed inside a token back to a boundary.
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
  const tok = key === 'ArrowLeft'
    ? tokens.find((t) => t.end === p)
    : tokens.find((t) => t.start === p);
  if (!tok) return false;
  e.preventDefault();
  const to = key === 'ArrowLeft' ? tok.start : tok.end;
  try { textarea.setSelectionRange(to, to); } catch { /* non-fatal */ }
  composer._pasteLastCaret = to;
  return true;
}

/**
 * copy/cut handler: when the selection contains any token, write the EXPANDED
 * text (tokens replaced by their content) to the clipboard and, for cut,
 * delete the selection undoably. When the selection holds no token the browser
 * does its normal thing. This keeps sentinel characters from ever leaving the
 * composer — a paste back into another Juggler box re-captures naturally.
 * @param {any} composer - Composer instance
 * @param {ClipboardEvent} e
 * @param {HTMLTextAreaElement} textarea
 * @param {boolean} isCut
 */
export function onClipboardCopyCut(composer, e, textarea, isCut) {
  if (composer._pasteBlobs.size === 0) return;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  if (start === end) return;
  const selected = textarea.value.slice(start, end);
  if (!hasTokens(selected)) return;
  if (!e.clipboardData) return;
  e.preventDefault();
  const expanded = expandPasteTokens(selected, composer._pasteBlobs);
  e.clipboardData.setData('text/plain', expanded);
  if (isCut) deleteRange(composer, textarea, start, end);
}

/**
 * Length of the common leading run of two strings.
 * @param {string} a
 * @param {string} b
 * @returns {number} The shared-prefix length.
 */
function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * Whether the single contiguous edit that turned `prev` into `cur` cut into a
 * token's interior (as opposed to leaving tokens whole — typing outside them,
 * or deleting one entirely). A textarea `input` is always one contiguous
 * replacement, so the changed span in `prev` is `[prefix, prev.len - suffix)`;
 * a token that overlaps that span but isn't fully inside it was damaged.
 * @param {string} prev - The last known-good value.
 * @param {string} cur - The current value after the edit.
 * @returns {{start:number, end:number}|null} The damaged span in `prev`, or null.
 */
function damagedTokenSpan(prev, cur) {
  const pre = commonPrefixLen(prev, cur);
  let sfx = 0;
  const maxSfx = Math.min(prev.length - pre, cur.length - pre);
  while (sfx < maxSfx && prev[prev.length - 1 - sfx] === cur[cur.length - 1 - sfx]) sfx++;
  const chgStart = pre;
  const chgEnd = prev.length - sfx; // [chgStart, chgEnd) is the edited span in prev
  for (const t of parseTokens(prev)) {
    const overlaps = t.start < chgEnd && t.end > chgStart;
    const contained = t.start >= chgStart && t.end <= chgEnd;
    if (overlaps && !contained) return t;
  }
  return null;
}

/**
 * Turn the textarea's value into `target` as one native edit, so it lands on
 * the browser's undo stack. Assigning `textarea.value` would wipe that stack
 * outright — every earlier edit, not just this one — so the direct write is
 * only the fallback for a host that rejects the command or a textarea that
 * isn't focused (execCommand edits whatever IS focused). The edit replaces the
 * single span between the two values' common prefix and suffix. The `input`
 * it fires is ignored by the reconciler (`_pasteRepairing`).
 * @param {any} composer - Composer instance
 * @param {HTMLTextAreaElement} textarea
 * @param {string} target
 */
function replaceValueUndoably(composer, textarea, target) {
  const cur = textarea.value;
  if (cur === target) return;
  if (document.activeElement === textarea) {
    const pre = commonPrefixLen(cur, target);
    let sfx = 0;
    const maxSfx = Math.min(cur.length - pre, target.length - pre);
    while (sfx < maxSfx && cur[cur.length - 1 - sfx] === target[target.length - 1 - sfx]) sfx++;
    const insert = target.slice(pre, target.length - sfx);
    composer._pasteRepairing = true;
    composer._snappingSelection = true;
    try {
      textarea.setSelectionRange(pre, cur.length - sfx);
      // An empty insertText is a no-op on WebKit, so a pure removal deletes.
      if (insert) document.execCommand('insertText', false, insert);
      else document.execCommand('delete', false);
    } catch { /* fall back below */ } finally {
      composer._pasteRepairing = false;
      composer._snappingSelection = false;
    }
  }
  if (textarea.value !== target) textarea.value = target;
}

/** Native history commands, keyed by the `inputType` of the input they fire. */
const HISTORY_COMMANDS = /** @type {Record<string, string>} */ ({ historyUndo: 'undo', historyRedo: 'redo' });

/**
 * How many further undo/redo steps the reconciler may take, in the user's
 * direction, to get past a state that holds a broken token. One is enough for
 * the pair this module itself creates (a damaging edit and its repair); the
 * rest is headroom.
 */
const MAX_HISTORY_HOPS = 4;

/**
 * Reconcile the textarea after an `input` so a placeholder's contents can never
 * be edited — only deleted whole. Three layers:
 *  1. If the edit cut into a token's interior (a path that dodged the
 *     caret/selection interceptors — autocorrect, dictation, drag-drop, exotic
 *     IME), REVERT to the last known-good value: the edit simply doesn't take,
 *     and the captured content is never silently lost.
 *  2. Otherwise strip any orphaned delimiter characters as a final safety net,
 *     then adopt the current value as the new known-good base.
 *  3. Both repairs are native edits, so they sit on the undo stack after the
 *     edit they repair. Undo therefore walks back INTO the broken state first;
 *     an undo/redo that lands on one keeps going in the same direction instead
 *     of repairing it, since a repair would push a new step and trap Cmd+Z in a
 *     loop between the broken state and its fix.
 * @param {any} composer - Composer instance
 * @param {HTMLTextAreaElement} textarea
 * @param {string} [inputType] - The `inputType` of the input being reconciled.
 * @returns {boolean} True if the value was changed (reverted, cleaned or stepped).
 */
export function reconcileTokens(composer, textarea, inputType) {
  // The input fired by this function's own repair edit: the caller settles it.
  if (composer._pasteRepairing) return false;
  const cur = textarea.value;
  const prev = composer._pasteLastValue;
  const curHasDelims = cur.indexOf(PASTE_TOKEN_OPEN) !== -1 || cur.indexOf(PASTE_TOKEN_CLOSE) !== -1;
  // Fast path: no tokens are or were in play — nothing to guard.
  if (!curHasDelims && !hasTokens(prev)) { composer._pasteLastValue = cur; return false; }

  const damaged = (!composer._pasteComposing && hasTokens(prev)) ? damagedTokenSpan(prev, cur) : null;
  const cleaned = damaged ? cur : stripStrayDelimiters(cur, composer._pasteBlobs);
  if (!damaged && cleaned === cur) {
    composer._pasteLastValue = cur;
    composer._pasteLastCaret = textarea.selectionStart;
    return false;
  }

  if (stepPastBrokenHistory(composer, textarea, inputType)) return true;

  if (damaged) {
    // Reject the edit: restore the last good value, park the caret at the
    // start of the token that was hit (a boundary, never its interior).
    replaceValueUndoably(composer, textarea, prev);
    composer._snappingSelection = true;
    try { textarea.setSelectionRange(damaged.start, damaged.start); } catch { /* non-fatal */ }
    composer._snappingSelection = false;
    composer._pasteLastValue = prev;
    composer._pasteLastCaret = damaged.start;
    return true;
  }

  // Edit is legitimate, but left stray delimiters (half a token from a path
  // this couldn't revert): strip them and adopt the result as the new base.
  const at = Math.min(textarea.selectionStart, cleaned.length);
  replaceValueUndoably(composer, textarea, cleaned);
  composer._snappingSelection = true;
  try { textarea.setSelectionRange(at, at); } catch { /* non-fatal */ }
  composer._snappingSelection = false;
  composer._pasteLastValue = cleaned;
  composer._pasteLastCaret = at;
  return true;
}

/**
 * Take one history step with the hop depth raised, so the `input` it fires
 * re-enters {@link reconcileTokens} bounded by {@link MAX_HISTORY_HOPS}.
 * @param {any} composer - Composer instance
 * @param {HTMLTextAreaElement} textarea
 * @param {string} command - 'undo' or 'redo'.
 * @param {number} hops - The depth this step is taken at.
 * @returns {boolean} Whether the step moved the value.
 */
function historyStep(composer, textarea, command, hops) {
  const before = textarea.value;
  composer._pasteHistoryHops = hops + 1;
  try {
    document.execCommand(command, false);
  } catch { /* nothing further in that direction */ } finally {
    composer._pasteHistoryHops = hops;
  }
  return textarea.value !== before;
}

/**
 * When an undo/redo has surfaced a broken token, take one more history step in
 * the same direction. The step fires its own `input`, which re-enters
 * {@link reconcileTokens} and either adopts the result or steps again.
 *
 * WebKit refuses a history command issued while a NATIVE one (the Edit menu's
 * Undo, i.e. Cmd+Z in the desktop app) is still dispatching its `input`, so a
 * refused step is retried on the next task, once that command has finished.
 * The broken state is on screen for that one task; if the retry finds nothing
 * further in that direction, the state is repaired instead.
 * @param {any} composer - Composer instance
 * @param {HTMLTextAreaElement} textarea
 * @param {string} [inputType]
 * @returns {boolean} True if the history step owns this state (taken or queued).
 */
function stepPastBrokenHistory(composer, textarea, inputType) {
  const command = inputType ? HISTORY_COMMANDS[inputType] : undefined;
  if (!command || document.activeElement !== textarea) return false;
  const hops = composer._pasteHistoryHops || 0;
  if (hops >= MAX_HISTORY_HOPS) return false;
  if (historyStep(composer, textarea, command, hops)) return true;
  const broken = textarea.value;
  setTimeout(() => {
    // The user has moved on: their own edit is reconciled in its own right.
    if (textarea.value !== broken || document.activeElement !== textarea) return;
    if (historyStep(composer, textarea, command, hops)) return;
    reconcileTokens(composer, textarea); // no further history: repair in place
    syncPasteMirror(composer);
  }, 0);
  return true;
}

/**
 * Hit-test a viewport point against the mirror's rendered token pills, mapping
 * a hit to its token in text order. Used for click-to-expand, which can't rely
 * on the caret (a click inside a token is snapped to a boundary before `click`
 * fires).
 * @param {any} composer - Composer instance
 * @param {number} x - Client X.
 * @param {number} y - Client Y.
 * @returns {{token: import('../utils/paste-tokens.js').PasteTokenMatch, span: Element}|null}
 *   The hit token and its rendered pill span, or null.
 */
export function tokenAtPoint(composer, x, y) {
  if (!composer._pasteMirror) return null;
  const textarea = /** @type {HTMLTextAreaElement|null} */ (composer.querySelector('textarea'));
  if (!textarea) return null;
  const spans = composer._pasteMirror.querySelectorAll('.paste-token');
  const tokens = parseTokens(textarea.value);
  const n = Math.min(spans.length, tokens.length);
  for (let i = 0; i < n; i++) {
    const span = spans[i];
    const tok = tokens[i];
    if (!span || !tok) continue;
    const r = span.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { token: tok, span };
  }
  return null;
}

/**
 * Expand a token in response to a click, with a visible acknowledgement. The
 * insert of a large blob is synchronous and can briefly block the main thread,
 * so paint a "busy" state on the pill FIRST (forcing a layout flush), then run
 * the expansion on a later frame so that state is on screen before the block.
 * @param {any} composer - Composer instance
 * @param {HTMLTextAreaElement} textarea
 * @param {import('../utils/paste-tokens.js').PasteTokenMatch} tok
 * @param {Element} [span] - The pill span to flag as busy.
 */
export function expandTokenWithFeedback(composer, textarea, tok, span) {
  if (span) {
    span.classList.add('expanding');
    void (/** @type {HTMLElement} */ (span)).offsetHeight; // force the state to paint
  }
  const run = () => {
    // Re-resolve the token by id from the CURRENT text: the defer opens a small
    // window in which positions could shift, so never expand a stale span.
    const cur = parseTokens(textarea.value);
    const fresh = cur.find((t) => t.id === tok.id && t.start === tok.start) || cur.find((t) => t.id === tok.id);
    if (fresh) expandToken(composer, textarea, fresh);
  };
  // A click means the view is frontmost, so rAF is not throttled here; a double
  // rAF guarantees the busy state has painted before the blocking insert.
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(run));
  } else {
    setTimeout(run, 0);
  }
}

/**
 * Shared tail for every token-text mutation (capture, expand, delete, cut):
 * refresh the mirror, re-measure the textarea, update the empty-sensitive
 * controls, and persist the draft immediately (a discrete event, like an
 * attachment add).
 * @param {any} composer - Composer instance
 * @param {HTMLTextAreaElement} textarea
 */
function afterTokenMutation(composer, textarea) {
  // A capture/expand/delete/cut is trusted, so it becomes the reconciler's new
  // known-good base (an execCommand mutation also fires input, which must not
  // then see the pre-mutation value and revert it).
  composer._pasteLastValue = textarea.value;
  composer._pasteLastCaret = textarea.selectionStart;
  syncPasteMirror(composer);
  composer.autoResize(textarea);
  composer._updateSendButtonState();
  composer._persistDraft();
  composer._completions?.handleInput();
}

// ── Token mirror overlay ───────────────────────────────────────────────

/**
 * Rebuild or tear down the backdrop mirror to match the current text. With no
 * tokens the mirror is hidden and the textarea is a plain, fully ordinary
 * textarea — all mirror risk is confined to the moments a placeholder exists.
 * @param {any} composer - Composer instance
 */
export function syncPasteMirror(composer) {
  const textarea = /** @type {HTMLTextAreaElement|null} */ (composer.querySelector('textarea'));
  if (!textarea) return;
  const tokens = parseTokens(textarea.value);
  if (tokens.length === 0) {
    teardownPasteMirror(composer, textarea);
    return;
  }
  ensurePasteMirror(composer, textarea);
  renderPasteMirror(composer, textarea.value, tokens);
  syncMirrorMetrics(composer, textarea);
}

/**
 * Show the mirror div render() places behind the textarea, switch the textarea
 * to transparent-text mode, and wire the resize + selection-snapping listeners.
 * Nothing here may change the textarea's layout or its siblings: it runs right
 * after the capture's undoable insert, and Gecko drops a textarea's undo
 * history whenever it rebuilds its frame.
 * @param {any} composer - Composer instance
 * @param {HTMLTextAreaElement} textarea
 */
function ensurePasteMirror(composer, textarea) {
  if (composer._pasteMirror) return;
  const mirror = /** @type {HTMLElement|null} */ (composer.querySelector('.paste-mirror'));
  if (!mirror) return;
  mirror.hidden = false;
  composer._pasteMirror = mirror;
  textarea.classList.add('paste-mirrored');
  if (typeof ResizeObserver === 'function') {
    composer._pasteMirrorRO = new ResizeObserver(() => syncMirrorMetrics(composer, textarea));
    composer._pasteMirrorRO.observe(textarea);
  }
  // Selection snapping: an endpoint strictly inside a token snaps outward, so
  // you can select ACROSS a token but never INTO it (also keeps typing/caret
  // out of the label). Throttled to a microtask-ish guard via a reentrancy flag.
  composer._pasteSelectionListener = () => snapSelectionOutOfTokens(composer, textarea);
  document.addEventListener('selectionchange', composer._pasteSelectionListener);
}

/**
 * Hide and empty the mirror and restore the plain-textarea state. Idempotent.
 * @param {any} composer - Composer instance
 * @param {HTMLTextAreaElement} [textarea]
 */
export function teardownPasteMirror(composer, textarea) {
  const ta = textarea || /** @type {HTMLTextAreaElement|null} */ (composer.querySelector('textarea'));
  if (composer._pasteMirrorRO) {
    composer._pasteMirrorRO.disconnect();
    composer._pasteMirrorRO = null;
  }
  if (composer._pasteSelectionListener) {
    document.removeEventListener('selectionchange', composer._pasteSelectionListener);
    composer._pasteSelectionListener = null;
  }
  if (composer._pasteMirror) {
    composer._pasteMirror.hidden = true;
    composer._pasteMirror.textContent = '';
    composer._pasteMirror = null;
  }
  if (ta) {
    ta.classList.remove('paste-mirrored');
    if (ta.style.cursor) ta.style.cursor = ''; // drop any hover pointer cursor
  }
}

/**
 * Render the mirror's content: the same character string as the textarea, with
 * each token wrapped in a styled `.paste-token` span. Because the label is real
 * text and the span carries only metric-safe styling, both layers lay out
 * identically by construction.
 * @param {any} composer - Composer instance
 * @param {string} text
 * @param {import('../utils/paste-tokens.js').PasteTokenMatch[]} tokens
 */
function renderPasteMirror(composer, text, tokens) {
  const mirror = composer._pasteMirror;
  if (!mirror) return;
  mirror.textContent = '';
  let last = 0;
  for (const t of tokens) {
    if (t.start > last) mirror.appendChild(document.createTextNode(text.slice(last, t.start)));
    const span = document.createElement('span');
    span.className = 'paste-token';
    span.textContent = t.text; // full token incl. invisible delimiters
    mirror.appendChild(span);
    last = t.end;
  }
  // A trailing newline needs a following character for pre-wrap to show the
  // final empty line; mirror the textarea by appending the remainder plus a
  // sentinel space when it ends on a newline.
  let tail = text.slice(last);
  if (tail.endsWith('\n')) tail += '\u200b';
  if (tail) mirror.appendChild(document.createTextNode(tail));
}

/**
 * Copy the textarea's box metrics and scroll onto the mirror so the two layers
 * overlap exactly. Computed styles are copied (rather than assumed from CSS) so
 * the mirror inherits the textarea's real font, regardless of theme.
 * @param {any} composer - Composer instance
 * @param {HTMLTextAreaElement} textarea
 */
function syncMirrorMetrics(composer, textarea) {
  const mirror = composer._pasteMirror;
  if (!mirror) return;
  const cs = window.getComputedStyle(textarea);
  for (const prop of [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
    'letterSpacing', 'lineHeight', 'textTransform', 'textIndent', 'tabSize',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'
  ]) {
    // @ts-ignore indexed style write
    mirror.style[prop] = cs[prop];
  }
  mirror.style.top = `${textarea.offsetTop}px`;
  mirror.style.left = `${textarea.offsetLeft}px`;
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.height = `${textarea.clientHeight}px`;
  mirror.scrollTop = textarea.scrollTop;
}

/**
 * Snap a selection endpoint that lands strictly inside a token outward to the
 * token boundary. Guarded against reentrancy (setting the range re-fires
 * selectionchange) and a no-op when nothing needs snapping.
 * @param {any} composer - Composer instance
 * @param {HTMLTextAreaElement} textarea
 */
export function snapSelectionOutOfTokens(composer, textarea) {
  if (composer._snappingSelection || composer._pasteComposing) return;
  if (document.activeElement !== textarea) return;
  if (!hasTokens(textarea.value)) return;
  const tokens = parseTokens(textarea.value);
  let s = textarea.selectionStart;
  let en = textarea.selectionEnd;

  // Collapsed caret: it must never rest INSIDE a token. Snap it out in the
  // direction of travel (a word/line jump or Home/End that landed in a label
  // continues past it), falling back to the nearer edge when direction is
  // ambiguous. This is what makes the interior unreachable by the caret, so no
  // keystroke or paste can target it.
  if (s === en) {
    let p = s;
    for (const t of tokens) {
      if (p > t.start && p < t.end) {
        const movingRight = p >= composer._pasteLastCaret;
        p = movingRight ? t.end : t.start;
        break;
      }
    }
    if (p !== s) {
      composer._snappingSelection = true;
      try { textarea.setSelectionRange(p, p); } catch { /* non-fatal */ } finally { composer._snappingSelection = false; }
    }
    composer._pasteLastCaret = textarea.selectionStart;
    return;
  }

  // Range selection: snap each endpoint outward so you can select ACROSS a
  // token but never INTO it (also keeps a subsequent typed replacement whole).
  const dir = textarea.selectionDirection;
  for (const t of tokens) {
    if (s > t.start && s < t.end) s = (s - t.start) <= (t.end - s) ? t.start : t.end;
    if (en > t.start && en < t.end) en = (en - t.start) <= (t.end - en) ? t.start : t.end;
  }
  if (s !== textarea.selectionStart || en !== textarea.selectionEnd) {
    if (s > en) { const tmp = s; s = en; en = tmp; }
    composer._snappingSelection = true;
    try {
      textarea.setSelectionRange(s, en, dir === 'none' ? undefined : dir);
    } catch { /* non-fatal */ } finally {
      composer._snappingSelection = false;
    }
  }
  composer._pasteLastCaret = textarea.selectionStart;
}
