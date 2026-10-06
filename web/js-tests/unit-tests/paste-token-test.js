//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Pasted-text placeholder token tests — the inline-sentinel composer feature.
 *
 * Backend-free, split across the pure grammar and the composer-box behaviour:
 *  1. grammar — makeToken/parseTokens/expandPasteTokens round-trip (Map and
 *     array blob tables), nextId monotonicity, stray-delimiter stripping;
 *  2. persistence — normalizePasteBlobs round-trip + defaults, draft round-trip;
 *  3. capture — threshold boundaries, dedup by content, id counter after a
 *     delete-then-paste;
 *  4. atomicity — Backspace/Delete delete a whole token, Arrow keys skip it;
 *  5. clipboard — copy/cut of a token-bearing selection yields expanded text;
 *  6. send — the dispatched message is the expanded text; MAX_MESSAGE_CHARS is
 *     enforced on the expanded size;
 *  7. mirror — the backdrop mirror renders the same characters with a
 *     `.paste-token` span, and tears down when the last token goes;
 *  8. immutability — a collapsed caret snaps out of a token, an edit into a
 *     token interior is reverted, and a word/line delete removes it whole.
 * @module unit-tests/paste-token-test
 */

import {
  makeToken,
  parseTokens,
  hasTokens,
  expandPasteTokens,
  nextId,
  stripStrayDelimiters,
  PASTE_TOKEN_OPEN,
  PASTE_TOKEN_CLOSE
} from '../../js/utils/paste-tokens.js';
import { normalizePasteBlobs, normalizeDraft } from '../../js/utils/attachments.js';
import { initializeRegistries, assert } from '../utilities/test-helpers.js';
import '../../js/components/composer.js';

/**
 * Mount an <composer-box> offscreen with its listeners bound synchronously (render
 * defers setupListeners to rAF, which never pumps in the hidden test window).
 * Stubs showWarning to capture messages.
 * @returns {{box: any, container: HTMLElement, warnings: string[]}} The box, its container, captured warnings.
 */
function mountComposer() {
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:360px;height:600px;';
  const box = /** @type {any} */ (document.createElement('composer-box'));
  container.appendChild(box);
  document.body.appendChild(container);
  /** @type {any} */ (box).setupListeners?.();
  /** @type {any} */ (box).setupListeners = () => {};
  /** @type {string[]} */
  const warnings = [];
  box.showWarning = (/** @type {string} */ msg) => { warnings.push(msg); };
  return { box, container, warnings };
}

/**
 * Set the textarea value and (optionally) selection on a mounted box.
 * @param {any} box
 * @param {string} value
 * @param {number} [start]
 * @param {number} [end]
 * @returns {HTMLTextAreaElement} The textarea.
 */
function setValue(box, value, start, end) {
  const textarea = box.querySelector('textarea');
  textarea.value = value;
  if (start !== undefined) {
    try { textarea.setSelectionRange(start, end === undefined ? start : end); } catch { /* non-fatal */ }
  }
  return textarea;
}

/**
 * A fake keydown event carrying just what _handleTokenKeydown reads.
 * @param {string} key
 * @returns {any} The fake event, exposing a `defaultPrevented` flag.
 */
function fakeKey(key) {
  return {
    key, isComposing: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }
  };
}

/**
 * Run the paste-token test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts and any error messages.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => Promise<void>|void} fn
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── 1. Grammar ────────────────────────────────────────────────────────────

  await test('makeToken output is matched by parseTokens and round-trips', () => {
    const tok = makeToken(7, 38200);
    assert(tok.startsWith(PASTE_TOKEN_OPEN) && tok.endsWith(PASTE_TOKEN_CLOSE), 'token must be delimited');
    const text = `before ${tok} after`;
    const parsed = parseTokens(text);
    assert(parsed.length === 1, `expected 1 token, got ${parsed.length}`);
    assert(parsed[0].id === 7, `id should be 7, got ${parsed[0].id}`);
    assert(text.slice(parsed[0].start, parsed[0].end) === tok, 'span must cover the token');
    assert(hasTokens(text) && !hasTokens('plain'), 'hasTokens must detect presence');
  });

  await test('expandPasteTokens resolves from a Map and from an array', () => {
    const tok = makeToken(3, 10);
    const text = `x${tok}y`;
    const fromMap = expandPasteTokens(text, new Map([[3, { content: 'BODY' }]]));
    assert(fromMap === 'xBODYy', `map expand wrong: ${JSON.stringify(fromMap)}`);
    const fromArr = expandPasteTokens(text, [{ id: 3, content: 'BODY', bytes: 4 }]);
    assert(fromArr === 'xBODYy', `array expand wrong: ${JSON.stringify(fromArr)}`);
  });

  await test('expandPasteTokens degrades an unresolvable token to a bare label', () => {
    const tok = makeToken(9, 100);
    const out = expandPasteTokens(`a${tok}b`, new Map());
    assert(out.indexOf(PASTE_TOKEN_OPEN) === -1 && out.indexOf(PASTE_TOKEN_CLOSE) === -1,
      `delimiters must be stripped: ${JSON.stringify(out)}`);
    assert(/\[Pasted #9 /.test(out), `legible label must survive: ${JSON.stringify(out)}`);
  });

  await test('nextId is one past the max id in text ∪ table (monotonic)', () => {
    const t1 = makeToken(1, 1);
    const t5 = makeToken(5, 1);
    assert(nextId(`${t1}${t5}`, new Map()) === 6, 'from text');
    assert(nextId('', new Map([[8, { content: 'x' }]])) === 9, 'from table');
    // Table high-water mark survives a token being deleted from the text.
    assert(nextId('', new Map([[3, { content: 'x' }]])) === 4, 'table survives text deletion');
    assert(nextId('', new Map()) === 1, 'empty → 1');
  });

  await test('stripStrayDelimiters removes strays but keeps a valid token', () => {
    const tok = makeToken(2, 5);
    const blobs = new Map([[2, { content: 'z' }]]);
    const dirty = `a${PASTE_TOKEN_OPEN}b${tok}${PASTE_TOKEN_CLOSE}c`;
    const clean = stripStrayDelimiters(dirty, blobs);
    assert(clean.includes(tok), 'the well-formed token must survive');
    assert(clean === `ab${tok}c`, `strays must be removed: ${JSON.stringify(clean)}`);
  });

  // ── 2. Persistence ────────────────────────────────────────────────────────

  await test('normalizePasteBlobs round-trips and drops bad entries', () => {
    const blobs = normalizePasteBlobs([
      { id: 1, content: 'aaa', bytes: 3 },
      { id: '2', content: 'bb', bytes: 2 },
      { id: 3 },                       // no content → dropped
      { content: 'no id' }             // no id → dropped
    ]);
    assert(blobs.length === 2, `expected 2 valid blobs, got ${blobs.length}`);
    assert(blobs[0].id === 1 && blobs[1].id === 2, 'ids coerced to numbers');
    assert(blobs[1].content === 'bb', 'content preserved');
  });

  await test('normalizeDraft round-trips pasteBlobs and defaults to []', () => {
    const draft = normalizeDraft({ text: 'hi', pasteBlobs: [{ id: 4, content: 'body', bytes: 4 }] });
    assert(Array.isArray(draft.pasteBlobs) && draft.pasteBlobs.length === 1, 'blobs round-trip');
    assert(draft.pasteBlobs[0].id === 4 && draft.pasteBlobs[0].content === 'body', 'blob faithful');
    assert(normalizeDraft({ text: 'x' }).pasteBlobs.length === 0, 'absent → []');
    assert(normalizeDraft(null).pasteBlobs.length === 0, 'null → []');
  });

  // ── 3. Capture ────────────────────────────────────────────────────────────

  await test('_shouldCapturePaste trips on either threshold (and on binary)', () => {
    const { box, container } = mountComposer();
    try {
      assert(box._shouldCapturePaste('short') === false, 'small text pastes normally');
      assert(box._shouldCapturePaste('a'.repeat(2500)) === true, 'char threshold');
      assert(box._shouldCapturePaste(('x\n').repeat(40)) === true, 'line threshold');
      assert(box._shouldCapturePaste('abc\u0000def') === true, 'binary is captured defensively');
    } finally {
      container.remove();
    }
  });

  await test('_capturePaste inserts a token and stores the blob', () => {
    const { box, container } = mountComposer();
    try {
      setValue(box, '');
      const body = 'L'.repeat(3000);
      box._capturePaste(body);
      const textarea = box.querySelector('textarea');
      const tokens = parseTokens(textarea.value);
      assert(tokens.length === 1, `expected 1 token in the box, got ${tokens.length}`);
      assert(box._pasteBlobs.size === 1, 'one blob stored');
      assert(box._pasteBlobs.get(tokens[0].id).content === body, 'blob content matches the paste');
    } finally {
      container.remove();
    }
  });

  await test('identical content is deduped to one blob shared by two tokens', () => {
    const { box, container } = mountComposer();
    try {
      setValue(box, '');
      const body = 'D'.repeat(3000);
      box._capturePaste(body);
      box._capturePaste(body);
      const textarea = box.querySelector('textarea');
      const tokens = parseTokens(textarea.value);
      assert(tokens.length === 2, `expected 2 tokens, got ${tokens.length}`);
      assert(tokens[0].id === tokens[1].id, 'both tokens share the deduped id');
      assert(box._pasteBlobs.size === 1, 'still one blob');
    } finally {
      container.remove();
    }
  });

  await test('the id counter stays monotonic after delete-then-paste', () => {
    const { box, container } = mountComposer();
    try {
      setValue(box, '');
      box._capturePaste('A'.repeat(3000)); // id 1
      const textarea = box.querySelector('textarea');
      const firstId = parseTokens(textarea.value)[0].id;
      // Delete the token characters from the text (the blob stays — append-only).
      setValue(box, '');
      box._capturePaste('B'.repeat(3000)); // must NOT reuse id 1
      const secondId = parseTokens(box.querySelector('textarea').value)[0].id;
      assert(secondId === firstId + 1, `id must advance past the deleted token: ${firstId} → ${secondId}`);
      assert(box._pasteBlobs.size === 2, 'the deleted token\'s blob is retained (append-only)');
    } finally {
      container.remove();
    }
  });

  // ── 4. Atomicity ──────────────────────────────────────────────────────────

  await test('Backspace at a token\'s trailing edge deletes the whole token', () => {
    const { box, container } = mountComposer();
    try {
      const tok = makeToken(1, 10);
      box._pasteBlobs.set(1, { content: 'body', bytes: 10 });
      const textarea = setValue(box, `ab${tok}cd`);
      const caret = 2 + tok.length; // just after the token
      const e = fakeKey('Backspace');
      const handled = box._handleTokenKeydown(e, setValue(box, textarea.value, caret, caret));
      assert(handled === true && e.defaultPrevented, 'backspace on a token boundary is handled');
      assert(textarea.value === 'abcd', `whole token must be gone: ${JSON.stringify(textarea.value)}`);
    } finally {
      container.remove();
    }
  });

  await test('Delete at a token\'s leading edge deletes the whole token', () => {
    const { box, container } = mountComposer();
    try {
      const tok = makeToken(1, 10);
      box._pasteBlobs.set(1, { content: 'body', bytes: 10 });
      const textarea = setValue(box, `ab${tok}cd`, 2, 2); // caret just before the token
      const e = fakeKey('Delete');
      const handled = box._handleTokenKeydown(e, textarea);
      assert(handled === true && e.defaultPrevented, 'delete on a token boundary is handled');
      assert(textarea.value === 'abcd', `whole token must be gone: ${JSON.stringify(textarea.value)}`);
    } finally {
      container.remove();
    }
  });

  await test('ArrowLeft/ArrowRight skip a token as a single unit', () => {
    const { box, container } = mountComposer();
    try {
      const tok = makeToken(1, 10);
      box._pasteBlobs.set(1, { content: 'body', bytes: 10 });
      const start = 2;
      const end = 2 + tok.length;
      // ArrowLeft from just after the token → caret jumps to its start.
      let textarea = setValue(box, `ab${tok}cd`, end, end);
      let e = fakeKey('ArrowLeft');
      assert(box._handleTokenKeydown(e, textarea) === true && e.defaultPrevented, 'left is handled');
      assert(textarea.selectionStart === start && textarea.selectionEnd === start,
        `caret should be at token start ${start}, got ${textarea.selectionStart}`);
      // ArrowRight from just before the token → caret jumps to its end.
      textarea = setValue(box, `ab${tok}cd`, start, start);
      e = fakeKey('ArrowRight');
      assert(box._handleTokenKeydown(e, textarea) === true && e.defaultPrevented, 'right is handled');
      assert(textarea.selectionStart === end && textarea.selectionEnd === end,
        `caret should be at token end ${end}, got ${textarea.selectionStart}`);
    } finally {
      container.remove();
    }
  });

  await test('a keystroke with no adjacent token is not intercepted', () => {
    const { box, container } = mountComposer();
    try {
      const tok = makeToken(1, 10);
      box._pasteBlobs.set(1, { content: 'body', bytes: 10 });
      const textarea = setValue(box, `ab${tok}cd`, 1, 1); // caret between 'a' and 'b'
      const e = fakeKey('Backspace');
      assert(box._handleTokenKeydown(e, textarea) === false, 'ordinary backspace is left alone');
      assert(!e.defaultPrevented, 'default is not prevented');
    } finally {
      container.remove();
    }
  });

  // ── 5. Clipboard ──────────────────────────────────────────────────────────

  await test('copy of a token-bearing selection writes expanded text', () => {
    const { box, container } = mountComposer();
    try {
      const tok = makeToken(1, 10);
      box._pasteBlobs.set(1, { content: 'HUGE', bytes: 10 });
      const textarea = setValue(box, `pre ${tok} post`, 0, `pre ${tok} post`.length);
      /** @type {Record<string,string>} */
      const data = {};
      let prevented = false;
      const e = /** @type {any} */ ({
        clipboardData: { setData: (/** @type {string} */ t, /** @type {string} */ v) => { data[t] = v; } },
        preventDefault() { prevented = true; }
      });
      box._onClipboardCopyCut(e, textarea, false);
      assert(prevented, 'copy of a token selection must preventDefault');
      assert(data['text/plain'] === 'pre HUGE post', `clipboard should hold expanded text: ${JSON.stringify(data['text/plain'])}`);
      assert(textarea.value.includes(tok), 'copy must not mutate the textarea');
    } finally {
      container.remove();
    }
  });

  await test('cut of a token-bearing selection expands to the clipboard and removes it', () => {
    const { box, container } = mountComposer();
    try {
      const tok = makeToken(1, 10);
      box._pasteBlobs.set(1, { content: 'HUGE', bytes: 10 });
      const full = `x${tok}y`;
      const textarea = setValue(box, full, 1, 1 + tok.length); // select just the token
      /** @type {Record<string,string>} */
      const data = {};
      const e = /** @type {any} */ ({
        clipboardData: { setData: (/** @type {string} */ t, /** @type {string} */ v) => { data[t] = v; } },
        preventDefault() {}
      });
      box._onClipboardCopyCut(e, textarea, true);
      assert(data['text/plain'] === 'HUGE', `cut clipboard should be expanded: ${JSON.stringify(data['text/plain'])}`);
      assert(textarea.value === 'xy', `cut must remove the token: ${JSON.stringify(textarea.value)}`);
    } finally {
      container.remove();
    }
  });

  // ── 6. Send ───────────────────────────────────────────────────────────────

  await test('sendMessage dispatches the EXPANDED text', async () => {
    const { box, container } = mountComposer();
    try {
      box._messageThread = null; // skip the mention/context-item branch
      const tok = makeToken(1, 10);
      box._pasteBlobs.set(1, { content: 'FULL_BODY', bytes: 10 });
      setValue(box, `hi ${tok}`);
      /** @type {string|null} */
      let sent = null;
      box.addEventListener('send-message', (/** @type {any} */ ev) => { sent = ev.detail.message; });
      const reason = await box.sendMessage();
      assert(reason === null, `send should succeed, got ${JSON.stringify(reason)}`);
      assert(sent === 'hi FULL_BODY', `expanded message expected, got ${JSON.stringify(sent)}`);
    } finally {
      container.remove();
    }
  });

  await test('MAX_MESSAGE_CHARS is enforced on the EXPANDED size', async () => {
    const { box, container, warnings } = mountComposer();
    try {
      box._messageThread = null;
      const tok = makeToken(1, 200000);
      box._pasteBlobs.set(1, { content: 'Z'.repeat(100001), bytes: 200000 });
      setValue(box, tok);
      let dispatched = false;
      box.addEventListener('send-message', () => { dispatched = true; });
      const reason = await box.sendMessage();
      assert(reason === 'message too large', `over-cap send must be rejected, got ${JSON.stringify(reason)}`);
      assert(!dispatched, 'an over-cap message must not be dispatched');
      assert(warnings.some((w) => /too large/i.test(w)), `a size warning is expected: ${JSON.stringify(warnings)}`);
    } finally {
      container.remove();
    }
  });

  // ── 7. Mirror ─────────────────────────────────────────────────────────────

  await test('the mirror renders the same characters with a .paste-token span', () => {
    const { box, container } = mountComposer();
    try {
      setValue(box, '');
      box._capturePaste('M'.repeat(3000));
      const textarea = box.querySelector('textarea');
      assert(box._pasteMirror, 'a mirror must exist while a token is present');
      assert(box._pasteMirror.textContent === textarea.value,
        'the mirror must render the same character string as the textarea');
      assert(box._pasteMirror.querySelector('.paste-token'), 'the token must be wrapped in a .paste-token span');
      assert(textarea.classList.contains('paste-mirrored'), 'the textarea is switched to transparent-text mode');
    } finally {
      container.remove();
    }
  });

  // ── 8. Immutability (caret can't enter, edits can't corrupt) ───────────────

  await test('a collapsed caret is snapped OUT of a token, in the travel direction', () => {
    const { box, container } = mountComposer();
    try {
      const tok = makeToken(1, 10);
      box._pasteBlobs.set(1, { content: 'body', bytes: 10 });
      const start = 2;
      const end = 2 + tok.length;
      const mid = start + Math.floor(tok.length / 2);
      const textarea = setValue(box, `ab${tok}cd`);
      textarea.focus();
      // Moving rightward into the label → snap forward to the token end.
      box._pasteLastCaret = start;
      textarea.setSelectionRange(mid, mid);
      box._snapSelectionOutOfTokens(textarea);
      assert(textarea.selectionStart === end && textarea.selectionEnd === end,
        `rightward caret should snap to token end ${end}, got ${textarea.selectionStart}`);
      // Moving leftward into the label → snap back to the token start.
      box._pasteLastCaret = end + 2;
      textarea.setSelectionRange(mid, mid);
      box._snapSelectionOutOfTokens(textarea);
      assert(textarea.selectionStart === start && textarea.selectionEnd === start,
        `leftward caret should snap to token start ${start}, got ${textarea.selectionStart}`);
      // A caret already outside every token is left untouched.
      textarea.setSelectionRange(1, 1);
      box._snapSelectionOutOfTokens(textarea);
      assert(textarea.selectionStart === 1, 'a caret outside a token must not move');
    } finally {
      container.remove();
    }
  });

  await test('an edit into a token interior is REVERTED (contents are immutable)', () => {
    const { box, container } = mountComposer();
    try {
      const tok = makeToken(1, 10);
      box._pasteBlobs.set(1, { content: 'body', bytes: 10 });
      const good = `hi ${tok} yo`;
      const textarea = setValue(box, good);
      box._pasteLastValue = good;
      // Simulate a path that dodged the interceptors (autocorrect/dictation)
      // inserting a character inside the label.
      const interior = 6; // inside `[Pasted #1 · …]`
      assert(interior > 3 && interior < 3 + tok.length, 'test index must land inside the token');
      textarea.value = good.slice(0, interior) + 'X' + good.slice(interior);
      const changed = box._reconcileTokens(textarea);
      assert(changed === true, 'a damaging edit must be reverted');
      assert(textarea.value === good, `value must be restored: ${JSON.stringify(textarea.value)}`);
      assert(parseTokens(textarea.value).length === 1, 'the token survives intact');
    } finally {
      container.remove();
    }
  });

  await test('edits OUTSIDE a token, and deleting one whole, are accepted (not reverted)', () => {
    const { box, container } = mountComposer();
    try {
      const tok = makeToken(1, 10);
      box._pasteBlobs.set(1, { content: 'body', bytes: 10 });
      const good = `hi ${tok} yo`;
      const textarea = setValue(box, good);
      // Typing after the token is legitimate and re-baselines.
      box._pasteLastValue = good;
      textarea.value = `${good}!`;
      assert(box._reconcileTokens(textarea) === false, 'an outside edit must not be reverted');
      assert(box._pasteLastValue === `${good}!`, 'the base advances to the accepted value');
      // Deleting the whole token (its full span) is legitimate too.
      box._pasteLastValue = good;
      textarea.value = 'hi  yo';
      assert(box._reconcileTokens(textarea) === false, 'deleting a whole token is accepted');
      assert(textarea.value === 'hi  yo', 'the whole-token delete stands');
    } finally {
      container.remove();
    }
  });

  await test('a word/line delete abutting a token removes the whole token', () => {
    const { box, container } = mountComposer();
    try {
      const tok = makeToken(1, 10);
      box._pasteBlobs.set(1, { content: 'body', bytes: 10 });
      const caret = 2 + tok.length; // just after the token
      const textarea = setValue(box, `ab${tok}cd`, caret, caret);
      textarea.focus();
      const e = fakeKey('Backspace');
      e.altKey = true; // Option+Backspace = delete word
      const handled = box._handleTokenKeydown(e, textarea);
      assert(handled === true && e.defaultPrevented, 'a word-delete abutting a token is intercepted');
      assert(textarea.value === 'abcd', `the whole token must be gone, not chewed: ${JSON.stringify(textarea.value)}`);
    } finally {
      container.remove();
    }
  });

  await test('Shift/Ctrl+Backspace and Shift/Ctrl+Delete abutting a token remove it whole', () => {
    const tok = makeToken(1, 10);
    for (const [key, mod] of [['Backspace', 'shiftKey'], ['Backspace', 'ctrlKey'], ['Delete', 'shiftKey'], ['Delete', 'ctrlKey']]) {
      const { box, container } = mountComposer();
      try {
        box._pasteBlobs.set(1, { content: 'body', bytes: 10 });
        const caret = key === 'Backspace' ? 2 + tok.length : 2;
        const textarea = setValue(box, `ab${tok}cd`, caret, caret);
        textarea.focus();
        const e = fakeKey(key);
        e[mod] = true;
        const handled = box._handleTokenKeydown(e, textarea);
        assert(handled === true && e.defaultPrevented, `${mod} ${key} abutting a token is intercepted`);
        assert(textarea.value === 'abcd', `${mod} ${key}: the whole token must be gone: ${JSON.stringify(textarea.value)}`);
      } finally {
        container.remove();
      }
    }
  });

  /**
   * Make an edit through the editing pipeline the way a native one (a
   * keystroke, autocorrect, Cmd/Ctrl+Z) arrives: the edit lands on the undo
   * stack, then the reconciler sees it with no command in flight. Reconciling
   * inside the test's own execCommand instead would make every repair or
   * history step a NESTED execCommand, which Blink refuses outright (WebKit
   * allows it) — the repair would fall back to a value write that wipes the
   * undo stack, a path no native edit takes.
   * @param {any} box
   * @param {HTMLTextAreaElement} textarea
   * @param {string} command - The execCommand to issue.
   * @param {string} inputType - The `inputType` the native edit would carry.
   * @param {string} [value]
   */
  function nativeEdit(box, textarea, command, inputType, value) {
    box._pasteRepairing = true; // the composer's own input listener stands aside
    try {
      document.execCommand(command, false, value);
    } finally {
      box._pasteRepairing = false;
    }
    box._reconcileTokens(textarea, inputType);
  }

  /**
   * Undo until the box reads `target` or the history runs dry, recording every
   * value the undo passes through.
   * @param {any} box
   * @param {HTMLTextAreaElement} textarea
   * @param {string} target
   * @returns {string[]} The values seen after each undo.
   */
  function undoUntil(box, textarea, target) {
    /** @type {string[]} */
    const seen = [];
    for (let i = 0; i < 6 && textarea.value !== target; i++) {
      nativeEdit(box, textarea, 'undo', 'historyUndo');
      seen.push(textarea.value);
    }
    return seen;
  }

  await test('undo still works after an edit into a token interior is reverted', () => {
    const { box, container } = mountComposer();
    try {
      const textarea = setValue(box, '');
      textarea.focus();
      document.execCommand('insertText', false, 'hi ');
      assert(textarea.value === 'hi ', `this window must support execCommand editing: ${JSON.stringify(textarea.value)}`);
      box._capturePaste('U'.repeat(3000));
      const good = textarea.value;
      const tok = parseTokens(good)[0];
      // A path that dodged the interceptors (autocorrect, dictation) writes
      // into the label through the editing pipeline, firing a real input.
      textarea.setSelectionRange(tok.start + 4, tok.start + 5);
      nativeEdit(box, textarea, 'insertText', 'insertReplacementText', 'X');
      assert(textarea.value === good, `the damaging edit must be reverted: ${JSON.stringify(textarea.value)}`);
      const seen = undoUntil(box, textarea, '');
      assert(textarea.value === '', `undo must still walk back to the empty box, saw ${JSON.stringify(seen)}`);
      for (const v of seen) {
        assert(stripStrayDelimiters(v, box._pasteBlobs) === v, `no undo step may surface a broken token: ${JSON.stringify(v)}`);
      }
    } finally {
      container.remove();
    }
  });

  await test('undo still works after stray delimiters are stripped', () => {
    const { box, container } = mountComposer();
    try {
      const textarea = setValue(box, '');
      textarea.focus();
      document.execCommand('insertText', false, 'hi');
      nativeEdit(box, textarea, 'insertText', 'insertText', PASTE_TOKEN_OPEN);
      assert(textarea.value === 'hi', `the stray delimiter must be stripped: ${JSON.stringify(textarea.value)}`);
      const seen = undoUntil(box, textarea, '');
      assert(textarea.value === '', `undo must still walk back to the empty box, saw ${JSON.stringify(seen)}`);
    } finally {
      container.remove();
    }
  });

  await test('the mirror tears down when the last token is removed', () => {
    const { box, container } = mountComposer();
    try {
      setValue(box, '');
      box._capturePaste('N'.repeat(3000));
      assert(box._pasteMirror, 'mirror present with a token');
      setValue(box, ''); // setValue does not sync; drive the sync as the input handler would
      box._syncPasteMirror();
      const textarea = box.querySelector('textarea');
      assert(box._pasteMirror === null, 'mirror must be torn down with no tokens');
      assert(!textarea.classList.contains('paste-mirrored'), 'transparent-text mode is cleared');
    } finally {
      container.remove();
    }
  });

  return { passed, failed, errors };
}
