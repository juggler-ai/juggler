//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Putting a stored user message back into the composer — the rewind and branch
 * paths, which delete a message and hand it back for editing and re-sending.
 *
 * A message is one unit (text + image attachments), and the box it lands in is
 * not an empty box: it may hold a typed draft, and that draft may hold a
 * collapsed paste placeholder. The placeholder is what makes a raw
 * `textarea.value = text` write insufficient, and neither half of that is
 * visible from the textarea alone:
 *
 *   • While a placeholder exists the textarea renders its own text
 *     TRANSPARENT and a mirror div behind it paints the pills. A write that
 *     doesn't resync the mirror leaves the restored message invisible under
 *     the previous draft's pills.
 *   • The token reconciler holds a known-good baseline and REVERTS any edit
 *     that damaged a placeholder's interior. A write that doesn't re-baseline
 *     leaves the restored message one keystroke away from being replaced by
 *     the draft it was supposed to overwrite.
 *
 * So these tests drive `restoreMessage()` — the composer's door for this — and
 * pin what the box has to look like afterwards: the message visible, the
 * reconciler baselined, the overwritten draft retrievable from history, the
 * attachment set replaced wholesale, and the Send button live.
 * @module unit-tests/composer-restore-message-test
 */

import { initializeRegistries, assert } from '../utilities/test-helpers.js';
import { capturePaste } from '../../js/components/composer-paste-tokens.js';
import '../../js/components/composer.js';

/** A paste well past the capture threshold, so it collapses to a placeholder. */
const BIG_PASTE = 'const answer = 42;\n'.repeat(200);

/**
 * Mount a <composer-box> with the minimum wiring `restoreMessage()` touches: a
 * session to take the overwritten draft into history, and a message thread to
 * persist the restored draft onto.
 *
 * render() runs synchronously in connectedCallback but DEFERS setupListeners()
 * to requestAnimationFrame, and the test-pool window is hidden so rAF may never
 * pump. Bind directly and neutralise the pending call, as composer-send-latch
 * does.
 * @returns {{box: any, textarea: HTMLTextAreaElement, container: HTMLElement, history: Array<any>, drafts: Array<any>}} The mounted box, its textarea, the container, the history entries it recorded, and the drafts it persisted.
 */
function mountComposer() {
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:600px;height:600px;';
  const box = document.createElement('composer-box');
  container.appendChild(box);
  document.body.appendChild(container);

  /** @type {any} */ (box).setupListeners();
  /** @type {any} */ (box).setupListeners = () => {};

  /** @type {Array<any>} */
  const history = [];
  /** @type {any} */ (box).session = { addMessageToHistory: (/** @type {any} */ m) => history.push(m) };

  /** @type {Array<any>} */
  const drafts = [];
  /** @type {any} */ (box)._messageThread = {
    conversationId: 'conv-restore',
    set draft(value) { drafts.push(value); },
    get draft() { return drafts[drafts.length - 1] || null; }
  };

  const textarea = /** @type {HTMLTextAreaElement} */ (box.querySelector('textarea'));
  assert(!!textarea, 'composer-box must render a textarea');

  return { box, textarea, container, history, drafts };
}

/**
 * Type one character at the end of the box the way a keyboard would: append it
 * and fire the `input` the reconciler listens on.
 * @param {HTMLTextAreaElement} textarea
 * @param {string} ch
 */
function typeCharacter(textarea, ch) {
  textarea.value += ch;
  textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Run the composer restore-message test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  // ── Test 1: restoring over a draft that holds a paste placeholder ─────────
  {
    const { box, textarea, container, history } = mountComposer();
    try {
      // The draft being overwritten: a line of typing plus a large paste that
      // collapsed into a placeholder.
      textarea.value = 'about this: ';
      textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
      capturePaste(box, BIG_PASTE);

      const draftText = textarea.value;
      assert(!!box._pasteMirror, 'precondition: the captured paste must raise the token mirror');
      assert(textarea.classList.contains('paste-mirrored'),
        'precondition: the textarea must be in transparent-text mode while a placeholder exists');
      assert(box._pasteBlobs.size === 1, `precondition: one blob captured, got ${box._pasteBlobs.size}`);

      box.restoreMessage({ content: 'the earlier message', attachments: [] });

      assert(textarea.value === 'the earlier message',
        `the restored text must be in the box, got ${JSON.stringify(textarea.value)}`);
      // Visible, not painted under the previous draft's pills.
      assert(!box._pasteMirror,
        'the token mirror must be torn down — the restored message has no placeholders in it');
      assert(!textarea.classList.contains('paste-mirrored'),
        'the textarea must be back to opaque text, or the restored message is invisible');
      // Baselined, so the next keystroke is judged against the restored text.
      assert(box._pasteLastValue === 'the earlier message',
        `the reconciler must be re-baselined to the restored text, got ${JSON.stringify(box._pasteLastValue)}`);

      typeCharacter(textarea, '!');
      assert(textarea.value === 'the earlier message!',
        `typing after a restore must not revert to the overwritten draft, got ${JSON.stringify(textarea.value)}`);

      // The overwritten draft is not lost — ArrowUp retrieves it, with the
      // placeholder expanded, since its blob does not outlive the draft.
      assert(history.length === 1, `the overwritten draft must be saved to history once, got ${history.length}`);
      assert(history[0].content === ('about this: ' + BIG_PASTE).trim(),
        `history must hold the overwritten draft, expanded, got ${JSON.stringify(history[0].content.slice(0, 80))}`);
      assert(draftText !== history[0].content, 'precondition: the draft held a placeholder, not the paste');
      passed++;
    } catch (e) {
      failed++;
      errors.push('restore-over-placeholder-draft: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      container.remove();
    }
  }

  // ── Test 2: a message is one unit — text and attachments move together ────
  {
    const { box, textarea, container, history, drafts } = mountComposer();
    try {
      const ref = { id: 'sha-restore-1', mime: 'image/png', filename: 'pixel.png', bytes: 12, width: 1, height: 1 };
      box.restoreMessage({ content: 'look at this', attachments: [ref] });

      assert(textarea.value === 'look at this',
        `the restored text must be in the box, got ${JSON.stringify(textarea.value)}`);
      assert(box._pendingAttachments.length === 1 && box._pendingAttachments[0].id === ref.id,
        `the message's attachment must be staged, got ${JSON.stringify(box._pendingAttachments)}`);
      const sendBtn = box.querySelector('#send-button');
      assert(!!sendBtn && !sendBtn.classList.contains('is-empty'),
        'the Send button must be live once a message has been restored into the box');
      const persisted = drafts[drafts.length - 1];
      assert(!!persisted && persisted.text === 'look at this' && persisted.attachments.length === 1,
        `the restored message must be persisted as the draft, got ${JSON.stringify(persisted)}`);
      assert(history.length === 0, `an empty box has no draft to save, got ${history.length} history entries`);

      // Restoring a message that carries no images clears the staged ones —
      // the attachment set follows the message, it is not merged into it.
      box.restoreMessage({ content: 'and this', attachments: [] });
      assert(box._pendingAttachments.length === 0,
        `restoring a message with no attachments must clear the staged ones, got ${box._pendingAttachments.length}`);
      assert(history.length === 1 && history[0].content === 'look at this',
        `the replaced draft must go to history, got ${JSON.stringify(history)}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push('restore-replaces-the-whole-message: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      container.remove();
    }
  }

  return { passed, failed, errors };
}
