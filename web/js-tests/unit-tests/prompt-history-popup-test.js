//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The composer's prompt-history popup, and ⌘S / Ctrl+S save-and-clear.
 *
 * A history entry is one message: its text and its image attachments travel
 * together into the list, out of it, and out of the box when it is cleared.
 * These tests pin that, and the popup's own behaviour:
 *  1. save-and-clear — the box and its images empty, one whole entry is added,
 *     and the ⌘S handler claims the key whether or not a composer has focus;
 *  2. every path that parks the box in history (Escape-clear, restore) keeps the
 *     images and stores pasted placeholders expanded;
 *  3. the popup — newest last, above the filter; picking replaces (parking the
 *     draft), Shift inserts at the caret, the filter narrows and Enter picks the
 *     newest match, a row
 *     can be deleted, an empty history says how to fill it, and under en-XA
 *     nothing is drawn in plain English.
 * @module unit-tests/prompt-history-popup-test
 */

import Session from '../../js/model/session.js';
import keyShortcutManager from '../../js/services/key-shortcut-manager.js';
import { capturePaste } from '../../js/components/composer-paste-tokens.js';
import { initializeRegistries, assert } from '../utilities/test-helpers.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import * as composerModule from '../../js/components/composer.js';

/**
 * The ⌘S handler, read off the module namespace so a missing export fails
 * these tests rather than every suite the executor imports.
 * @returns {boolean} Whether the key was claimed.
 */
const saveAndClearFocusedComposer = () => /** @type {any} */ (composerModule).saveAndClearFocusedComposer();

/** A paste well past the capture threshold, so it collapses to a placeholder. */
const BIG_PASTE = 'const answer = 42;\n'.repeat(200);

/**
 * A sample uploaded image attachment ref.
 * @param {string} id
 * @returns {{id:string,mime:string,filename:string,bytes:number,width:number,height:number}} An AssetRef.
 */
function ref(id) {
  return { id, mime: 'image/png', filename: `${id}.png`, bytes: 100, width: 1, height: 1 };
}

/**
 * A stand-in session running the real history methods over a plain array
 * (oldest first, as Session keeps it), counting saves.
 * @param {Array<any>} [entries]
 * @returns {any} The stand-in.
 */
function historySession(entries = []) {
  const s = /** @type {any} */ ({ messageHistory: [...entries], saves: 0 });
  s.save = () => { s.saves++; };
  s.addMessageToHistory = (/** @type {any} */ m) => Session.prototype.addMessageToHistory.call(s, m);
  s.removeMessageFromHistory = (/** @type {any} */ m) => /** @type {any} */ (Session.prototype).removeMessageFromHistory.call(s, m);
  return s;
}

/**
 * Mount a <composer-box> with listeners bound directly (rAF may never pump in
 * the hidden test window), a history session, and a thread to persist onto.
 * @param {Array<any>} [entries] - History, oldest first.
 * @returns {{box: any, textarea: HTMLTextAreaElement, container: HTMLElement, session: any}} The mounted parts.
 */
function mountComposer(entries = []) {
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:600px;height:600px;';
  const box = /** @type {any} */ (document.createElement('composer-box'));
  container.appendChild(box);
  document.body.appendChild(container);
  box.setupListeners();
  box.setupListeners = () => {};
  const session = historySession(entries);
  box.session = session;
  /** @type {Array<any>} */
  const drafts = [];
  box._messageThread = {
    conversationId: 'conv-history',
    set draft(value) { drafts.push(value); },
    get draft() { return drafts[drafts.length - 1] || null; },
  };
  const textarea = /** @type {HTMLTextAreaElement} */ (box.querySelector('textarea'));
  assert(!!textarea, 'composer-box must render a textarea');
  return { box, textarea, container, session };
}

/**
 * Put text in the box with the caret at its end.
 * @param {HTMLTextAreaElement} textarea
 * @param {string} text
 */
function typeInto(textarea, text) {
  textarea.value = text;
  textarea.selectionStart = textarea.selectionEnd = text.length;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * The ids of a list of AssetRefs, comma-joined.
 * @param {Array<{id: string}>} refs
 * @returns {string} The ids.
 */
const ids = (refs) => (refs || []).map((r) => r.id).join(',');

/**
 * Open the box's history popup and return its surface.
 * @param {any} box
 * @returns {Promise<HTMLElement>} The presented surface.
 */
async function openHistory(box) {
  await box._historyPopup.open();
  const surface = box._historyPopup.surface;
  assert(!!surface, 'the history popup did not open');
  return surface;
}

/**
 * The rows the popup shows, in order.
 * @param {HTMLElement} surface
 * @returns {any[]} The entry rows.
 */
const rowsOf = (surface) => /** @type {any[]} */ (Array.from(surface.querySelectorAll('.history-menu-item')));

/**
 * Run the prompt-history popup test suite.
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
      errors.push(`${name}: ${e instanceof Error ? `${e.message}\n${e.stack}` : String(e)}`);
    }
  }

  // ── 1. Save and clear ─────────────────────────────────────────────────────

  await test('saveAndClear empties the box and its images and keeps both as one entry', () => {
    const { box, textarea, container, session } = mountComposer();
    try {
      typeInto(textarea, 'park this for later');
      box.setPendingAttachments([ref('img-a'), ref('img-b')]);
      assert(box.saveAndClear() === true, 'saveAndClear must report that it acted');
      assert(textarea.value === '', `the box must be empty, got ${JSON.stringify(textarea.value)}`);
      assert(box._pendingAttachments.length === 0,
        `the staged images must be cleared, got ${ids(box._pendingAttachments)}`);
      assert(session.messageHistory.length === 1, `one entry, got ${session.messageHistory.length}`);
      const entry = session.messageHistory[0];
      assert(entry.content === 'park this for later', `entry text: ${JSON.stringify(entry.content)}`);
      assert(ids(entry.attachments) === 'img-a,img-b', `entry images: ${ids(entry.attachments)}`);
    } finally {
      container.remove();
    }
  });

  await test('saveAndClear on an empty box does nothing', () => {
    const { box, container, session } = mountComposer();
    try {
      assert(box.saveAndClear() === false, 'nothing to save must report false');
      assert(session.messageHistory.length === 0, 'an empty box must add no entry');
    } finally {
      container.remove();
    }
  });

  await test('⌘S / Ctrl+S is bound, and acts on the focused composer', () => {
    const binding = /** @type {any} */ (keyShortcutManager.getBinding('save-and-clear-prompt'));
    assert(!!binding && binding.mod === true && binding.key === 's' && !binding.alt,
      `save-and-clear-prompt must be bound to mod+S, got ${JSON.stringify(binding)}`);
    const { textarea, container, session } = mountComposer();
    try {
      typeInto(textarea, 'saved by the key');
      textarea.focus();
      assert(saveAndClearFocusedComposer() === true, 'the handler must claim the key');
      assert(textarea.value === '' && session.messageHistory.length === 1,
        `the focused box must be saved and cleared: ${JSON.stringify(textarea.value)}, ${session.messageHistory.length}`);
    } finally {
      container.remove();
    }
  });

  await test('⌘S with no composer focused leaves every box alone but still claims the key', () => {
    const { textarea, container, session } = mountComposer();
    const other = document.createElement('input');
    container.appendChild(other);
    try {
      typeInto(textarea, 'not focused');
      other.focus();
      assert(saveAndClearFocusedComposer() === true,
        'the handler must claim the key even with nothing to do, or the browser opens Save Page');
      assert(textarea.value === 'not focused', 'an unfocused box must keep its text');
      assert(session.messageHistory.length === 0, 'nothing must be added to history');
    } finally {
      container.remove();
    }
  });

  // ── 2. Every path into history keeps the whole message ────────────────────

  await test('Escape-clear keeps the staged images in the history entry', () => {
    const { box, textarea, container, session } = mountComposer();
    try {
      typeInto(textarea, 'escape me');
      box.setPendingAttachments([ref('esc-img')]);
      box.clearTextUndoable();
      const entry = session.messageHistory[session.messageHistory.length - 1];
      assert(entry?.content === 'escape me' && ids(entry.attachments) === 'esc-img',
        `the cleared message must be saved whole, got ${JSON.stringify(entry)}`);
    } finally {
      container.remove();
    }
  });

  await test('restoreMessage parks the replaced draft with its images', () => {
    const { box, textarea, container, session } = mountComposer();
    try {
      typeInto(textarea, 'replaced draft');
      box.setPendingAttachments([ref('old-img')]);
      box.restoreMessage({ content: 'restored', attachments: [] });
      const entry = session.messageHistory[session.messageHistory.length - 1];
      assert(entry?.content === 'replaced draft' && ids(entry.attachments) === 'old-img',
        `the replaced draft must be saved whole, got ${JSON.stringify(entry)}`);
    } finally {
      container.remove();
    }
  });

  await test('a pasted placeholder is saved expanded, not as a dead token', () => {
    const { box, textarea, container, session } = mountComposer();
    try {
      typeInto(textarea, 'about this: ');
      capturePaste(box, BIG_PASTE);
      assert(box._pasteBlobs.size === 1, 'precondition: the paste must collapse to a placeholder');
      box.saveAndClear();
      const entry = session.messageHistory[0];
      assert(!!entry && entry.content.includes('const answer = 42;') && entry.content.startsWith('about this:'),
        `the entry must hold the pasted text itself, got ${JSON.stringify(entry?.content.slice(0, 80))}`);
    } finally {
      container.remove();
    }
  });

  // ── 3. The popup ──────────────────────────────────────────────────────────

  await test('the history button sits second in the controls, after Commands', () => {
    const { box, container } = mountComposer();
    try {
      const buttons = Array.from(box.querySelectorAll('input-controls-actions > button'));
      const at = buttons.findIndex((b) => b.id === 'history-button');
      assert(at === 1 && buttons[0].id === 'commands-button',
        `history button at index ${at}, after ${buttons[0]?.id}`);
      assert(buttons[at].getAttribute('aria-haspopup') === 'menu', 'the history button must announce a menu');
    } finally {
      container.remove();
    }
  });

  await test('the popup lists entries newest last, above the filter, with their image counts', async () => {
    const { box, container } = mountComposer([
      { content: 'oldest', attachments: [] },
      { content: 'middle', attachments: [ref('m1'), ref('m2')] },
      { content: 'newest', attachments: [] },
    ]);
    try {
      const surface = await openHistory(box);
      const rows = rowsOf(surface);
      const texts = rows.map((r) => r.querySelector('.history-menu-text')?.textContent);
      assert(JSON.stringify(texts) === JSON.stringify(['oldest', 'middle', 'newest']),
        `rows out of order: ${JSON.stringify(texts)}`);
      const order = Array.from(surface.children).map((el) => el.className.split(' ')[0]);
      assert(JSON.stringify(order) === JSON.stringify(['menu-header', 'history-menu-list', 'history-menu-filter']),
        `the header, the list, then the filter: ${JSON.stringify(order)}`);
      assert(!!rows[1].querySelector('.history-menu-attachments')?.textContent?.includes('2'),
        'a row with two images must say so');
      assert(!rows[0].querySelector('.history-menu-attachments'), 'a row with no images shows no count');
    } finally {
      box._historyPopup.close();
      container.remove();
    }
  });

  await test('a long entry is cut short in its row and says how much is hidden', async () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const { box, container } = mountComposer([{ content: long, attachments: [] }]);
    try {
      const surface = await openHistory(box);
      const more = rowsOf(surface)[0].querySelector('.history-menu-more')?.textContent || '';
      assert(more.includes('26'), `a 30-line entry shown at 4 lines must say 26 more, got ${JSON.stringify(more)}`);
    } finally {
      box._historyPopup.close();
      container.remove();
    }
  });

  await test('picking an entry replaces the box and parks the draft, images and all', async () => {
    const { box, textarea, container, session } = mountComposer([
      { content: 'older prompt', attachments: [ref('older-img')] },
    ]);
    try {
      typeInto(textarea, 'work in progress');
      box.setPendingAttachments([ref('wip-img')]);
      const surface = await openHistory(box);
      rowsOf(surface)[0].click();
      assert(textarea.value === 'older prompt', `box text: ${JSON.stringify(textarea.value)}`);
      assert(ids(box._pendingAttachments) === 'older-img', `box images: ${ids(box._pendingAttachments)}`);
      const parked = session.messageHistory.find((/** @type {any} */ e) => e.content === 'work in progress');
      assert(!!parked && ids(parked.attachments) === 'wip-img',
        `the replaced draft must be parked whole, got ${JSON.stringify(parked)}`);
      assert(!box._historyPopup.isOpen, 'picking must close the popup');
    } finally {
      box._historyPopup.close();
      container.remove();
    }
  });

  await test('Shift-picking inserts at the caret and adds the entry\'s images', async () => {
    const { box, textarea, container, session } = mountComposer([
      { content: 'INSERTED', attachments: [ref('ins-img')] },
    ]);
    try {
      typeInto(textarea, 'before  after');
      textarea.selectionStart = textarea.selectionEnd = 'before '.length;
      box.setPendingAttachments([ref('kept-img')]);
      const surface = await openHistory(box);
      rowsOf(surface)[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
      assert(textarea.value === 'before INSERTED after', `box text: ${JSON.stringify(textarea.value)}`);
      assert(ids(box._pendingAttachments) === 'kept-img,ins-img', `box images: ${ids(box._pendingAttachments)}`);
      assert(session.messageHistory.length === 1, 'an insert parks nothing — the draft stays in the box');
    } finally {
      box._historyPopup.close();
      container.remove();
    }
  });

  await test('the filter narrows the rows, Enter picks the newest, ArrowUp enters the list', async () => {
    const { box, textarea, container } = mountComposer([
      { content: 'fix the zebra crossing', attachments: [] },
      { content: 'refactor the parser', attachments: [] },
      { content: 'Zebra stripes in CSS', attachments: [] },
    ]);
    try {
      const surface = await openHistory(box);
      const filter = /** @type {any} */ (surface.querySelector('.history-menu-filter'));
      assert(!!filter, 'the popup must have a filter field');
      filter.value = 'zebra';
      filter.dispatchEvent(new Event('input', { bubbles: true }));
      const texts = rowsOf(surface).map((r) => r.querySelector('.history-menu-text')?.textContent);
      assert(JSON.stringify(texts) === JSON.stringify(['fix the zebra crossing', 'Zebra stripes in CSS']),
        `the filter must match case-insensitively, newest last: ${JSON.stringify(texts)}`);

      // presentPopup reveals the surface a frame after placing it, and frames
      // never pump in a test lane; a hidden row cannot take focus.
      surface.style.removeProperty('visibility');
      const up = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
      filter.dispatchEvent(up);
      const rows = rowsOf(surface);
      assert(up.defaultPrevented && document.activeElement === rows[rows.length - 1],
        'ArrowUp from the filter must move to the newest row, just above it');

      filter.focus();
      filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      assert(textarea.value === 'Zebra stripes in CSS', `Enter must pick the newest match, got ${JSON.stringify(textarea.value)}`);
    } finally {
      box._historyPopup.close();
      container.remove();
    }
  });

  await test('an entry can be deleted from the popup, by its button or the Delete key', async () => {
    const { box, container, session } = mountComposer([
      { content: 'keep me', attachments: [] },
      { content: 'secret token abc123', attachments: [] },
      { content: 'also delete me', attachments: [] },
    ]);
    try {
      const surface = await openHistory(box);
      const secret = rowsOf(surface).find((r) => r.textContent?.includes('secret'));
      const button = /** @type {any} */ (secret?.querySelector('.history-menu-delete') ?? null);
      assert(!!button, 'each row must have a delete button');
      const savesBefore = session.saves;
      button.click();
      assert(!session.messageHistory.some((/** @type {any} */ e) => e.content.includes('secret')),
        'the deleted entry must leave the history');
      assert(session.saves > savesBefore, 'the deletion must be saved');
      assert(box._historyPopup.isOpen, 'deleting must leave the popup open');
      assert(!rowsOf(surface).some((r) => r.textContent?.includes('secret')), 'the row must go');

      const row = rowsOf(surface).find((r) => r.textContent?.includes('also delete'));
      row?.focus();
      row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
      assert(session.messageHistory.length === 1 && session.messageHistory[0].content === 'keep me',
        `the Delete key must remove the focused row's entry: ${JSON.stringify(session.messageHistory)}`);
    } finally {
      box._historyPopup.close();
      container.remove();
    }
  });

  await test('an empty history says how it gets filled', async () => {
    const { box, container } = mountComposer();
    try {
      const surface = await openHistory(box);
      const empty = surface.querySelector('.history-menu-empty')?.textContent || '';
      assert(empty.includes('No prompts yet'), `empty-state text: ${JSON.stringify(empty)}`);
    } finally {
      box._historyPopup.close();
      container.remove();
    }
  });

  await test('en-XA: the history popup draws no plain English', async () => {
    const { box, container } = mountComposer([{ content: '1', attachments: [ref('x')] }]);
    try {
      await underPseudoLocale('prompt-history-popup-test', async () => {
        /** @type {Array<[string, string]>} */
        const shown = [];
        for (const filled of [true, false]) {
          box.session = historySession(filled
            ? [{ content: Array.from({ length: 10 }, (_, i) => String(i)).join('\n'), attachments: [ref('x')] }]
            : []);
          const surface = await openHistory(box);
          try {
            // The empty state names the ⌘S chord, whose key letter is not text.
            const keys = keyShortcutManager.formatBinding('save-and-clear-prompt');
            for (const s of shownStrings(surface, '.history-menu-text')) {
              shown.push([filled ? 'filled' : 'empty', s.replace(keys, '')]);
            }
            assert(shown.length > 0, 'the popup drew nothing');
          } finally {
            box._historyPopup.close();
          }
        }
        // Drawn with no thread bound, as composer-test draws it: the stand-in
        // thread has nothing the placeholder reads.
        box._messageThread = null;
        box.render();
        const button = box.querySelector('#history-button');
        shown.push(['button title', button?.getAttribute('title') || '']);
        shown.push(['button label', button?.getAttribute('aria-label') || '']);
        const raw = shown.filter(([, s]) => !isPseudoLocalized(s));
        assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
      });
    } finally {
      container.remove();
    }
  });

  return { passed, failed, errors };
}
