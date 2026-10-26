//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Scheduled send: the composer's clock button and its picker.
 *
 * The picker keeps no timer of its own. Each choice is one call to the
 * composer's `sendMessage({schedule})`, which hands the message to the worker
 * as a held send; the worker queues it and fires it. So what is tested here is
 * what the picker draws (under en-XA), the refusal of a scheduled slash
 * command, and that each choice asks for the right hold.
 * @module unit-tests/scheduled-send-test
 */

import { initializeRegistries, assert } from '../utilities/test-helpers.js';
import {
  updateScheduleButton,
} from '../../js/components/composer-schedule.js';
import { closeAllPopups, __resetPopupManagerForTests } from '../../js/utils/popup-manager.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import '../../js/components/composer.js';
import MessageThread from '../../js/model/message-thread.js';

/**
 * A stand-in for MessageThread with a plain `draft` record.
 * @returns {any} A stub message thread.
 */
function makeStubThread() {
  /** @type {any} */
  let record = { text: '', attachments: [], textFiles: [], pasteBlobs: [] };
  /** @type {any} */
  const thread = {
    conversationId: 'conv-1',
    threadItemId: null,
    getContextItems: () => [],
    // Never queued; the real placement, so a stubbed writer below is the one it calls.
    sendWillQueue: false,
    addSendContext(/** @type {any} */ reads) { return MessageThread.prototype.addSendContext.call(this, reads); },
    executeContextItem: async () => {},
    executeContextItemIntoPending: async () => {},
    get draft() {
      return record;
    },
    set draft(value) {
      if (!value) {
        record = { text: '', attachments: [], textFiles: [], pasteBlobs: [] };
        return;
      }
      record = {
        text: value.text || '',
        attachments: value.attachments || [],
        textFiles: value.textFiles || [],
        pasteBlobs: value.pasteBlobs || [],
      };
    },
  };
  return thread;
}

/**
 * Mount a <composer-box> bound to a stub thread.
 *
 * render() runs synchronously in connectedCallback but DEFERS setupListeners()
 * to requestAnimationFrame, and the test-pool window never paints, so rAF may
 * never pump. Bind directly and neutralise the pending call, as
 * composer-send-latch-test does.
 * @returns {{box: any, textarea: HTMLTextAreaElement, container: HTMLElement, thread: any, scheduleBtn: HTMLButtonElement}} The mounted box and its parts.
 */
function mountComposer() {
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:600px;height:600px;';
  const box = document.createElement('composer-box');
  container.appendChild(box);
  document.body.appendChild(container);

  /** @type {any} */ (box).setupListeners();
  /** @type {any} */ (box).setupListeners = () => {};

  const thread = makeStubThread();
  /** @type {any} */ (box)._messageThread = thread;

  const textarea = /** @type {HTMLTextAreaElement} */ (box.querySelector('textarea'));
  assert(!!textarea, 'composer-box must render a textarea');
  const scheduleBtn = /** @type {HTMLButtonElement} */ (box.querySelector('.schedule-send-btn'));
  assert(!!scheduleBtn, 'composer-box must render a schedule-send button');

  return { box, textarea, container, thread, scheduleBtn };
}

/**
 * Run the scheduled-send test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  const errors = [];

  // ── Test 1: every state the clock button and picker draw, under en-XA ─────
  // Walks the button over a non-empty box, the picker with and without a
  // running turn and at zero delay, and the refusal of a scheduled slash
  // command. A wall-clock time is Intl's output (data), so any `H:MM` in a
  // shown string is mapped to a digit before the check. The clock button's own
  // aria-label is composer.js's markup, so only the title this module sets is
  // read from it.
  {
    __resetPopupManagerForTests();
    const { box, textarea, container, thread, scheduleBtn } = mountComposer();
    try {
      /** @type {string[]} */
      const shown = [];
      const SKIP = '.schedule-stepper-btn, .schedule-stepper-value';
      /** @param {Element|null} el */
      const collect = (el) => {
        assert(!!el, 'expected an element to read');
        shown.push(...shownStrings(/** @type {Element} */ (el), SKIP));
        for (const b of /** @type {Element} */ (el).querySelectorAll('.schedule-stepper-btn')) {
          shown.push(b.getAttribute('aria-label') || '<no aria-label>');
        }
      };
      const openPicker = async () => {
        closeAllPopups();
        await box._schedulePopup.open();
        const menu = document.querySelector('#schedule-send-menu');
        assert(!!menu, 'the picker did not open');
        shown.push(menu?.getAttribute('aria-label') || '<no aria-label>');
        return /** @type {HTMLElement} */ (menu);
      };

      await underPseudoLocale('scheduled-send-test', async () => {
        textarea.value = 'scheduled text';
        updateScheduleButton(box);
        shown.push(scheduleBtn.getAttribute('title') || '');

        let menu = await openPicker();
        collect(menu);
        /** @type {HTMLElement} */ (menu.querySelector('.schedule-stepper-btn')).click();
        assert(/** @type {HTMLButtonElement} */ (menu.querySelector('.schedule-confirm-btn')).disabled,
          'a zero delay must disable the confirm button');
        collect(menu);

        thread.conversation = { isTurnActive: () => true };
        menu = await openPicker();
        collect(menu);
        closeAllPopups();

        const warnings = /** @type {string[]} */ ([]);
        box.showWarning = (/** @type {string} */ m) => { warnings.push(m); };
        textarea.value = '/compact now';
        const reason = await box.sendMessage({ schedule: { notBefore: Date.now() + 60000 } });
        assert(reason === 'slash command scheduled', `a scheduled slash command must be refused, got ${reason}`);
        assert(warnings.length === 1, `the refusal must say why, got ${JSON.stringify(warnings)}`);
        shown.push(...warnings);
      });

      const raw = shown
        .map((s) => s.replace(/\d{1,2}[:.]\d{2}/g, '0'))
        .filter((s) => !isPseudoLocalized(s));
      assert(shown.length >= 20, `expected at least 20 strings, found ${shown.length}`);
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push('en-XA: ' + (e instanceof Error ? `${e.message}\n${e.stack}` : String(e)));
    } finally {
      closeAllPopups();
      container.remove();
      __resetPopupManagerForTests();
    }
  }

  // ── Test 2: the picker hands the send to the worker, arming nothing here ──
  {
    __resetPopupManagerForTests();
    const { box, textarea, container, thread, scheduleBtn } = mountComposer();
    try {
      /** @type {any[]} */
      const calls = [];
      box.sendMessage = async (/** @type {any} */ opts) => { calls.push(opts); return null; };
      textarea.value = 'scheduled text';
      updateScheduleButton(box);
      thread.conversation = { isTurnActive: () => true };

      await box._schedulePopup.open();
      let menu = /** @type {HTMLElement} */ (document.querySelector('#schedule-send-menu'));
      const before = Date.now();
      /** @type {HTMLElement} */ (menu.querySelector('.schedule-confirm-btn')).click();
      const notBefore = calls[0]?.schedule?.notBefore;
      assert(typeof notBefore === 'number' && Math.abs(notBefore - (before + 3600000)) < 5000,
        `confirm must send held ~1h out, got ${JSON.stringify(calls[0])}`);

      await box._schedulePopup.open();
      menu = /** @type {HTMLElement} */ (document.querySelector('#schedule-send-menu'));
      /** @type {HTMLElement} */ (menu.querySelector('.schedule-turn-end-btn')).click();
      assert(calls[1]?.schedule?.hold === 'run-end',
        `"Run at end of turn" must send held for the run's end, got ${JSON.stringify(calls[1])}`);

      assert(!scheduleBtn.classList.contains('armed'), 'the clock button has no armed look');
      passed++;
    } catch (e) {
      failed++;
      errors.push('picker-sends-held: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      closeAllPopups();
      container.remove();
      __resetPopupManagerForTests();
    }
  }

  return { passed, failed, errors };
}
