//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * UX invariants for the touch (mobile) composer on the input box:
 *
 *   1. On a touch composer a plain Enter inserts a NEWLINE (the onscreen
 *      keyboard's return key) and MUST NOT dispatch a send-message — the user
 *      can no longer accidentally fire the message by pressing return.
 *   2. The touch-only Send button DOES dispatch send-message with the typed
 *      text — it is the send affordance that replaces Enter.
 *   3. The "+" overflow button opens the actions sheet, whose rows reuse the
 *      existing handlers: the New Thread row dispatches the /thread command and
 *      the Attach image row triggers the hidden file input. Opening the sheet
 *      and picking a row closes it.
 *   4. The strategy selector — hidden from the inline control row on touch — is
 *      relocated into that sheet as a working control: bound to the
 *      conversation's thread it offers every strategy (incl. YOLO), and picking
 *      one pins it via MessageThread.setStrategy. This is how a phone user
 *      switches from the Default strategy to YOLO without a desktop.
 *
 * The touch decision normally reads `matchMedia('(hover: none) and
 * (pointer: coarse)')`, which the headless harness cannot drive. So the test
 * forces it via the `_touchComposerOverride` escape hatch the component exposes
 * for exactly this purpose.
 * @module unit-tests/mobile-composer-test
 */

import { initializeRegistries, assert } from '../utilities/test-helpers.js';
import strategyRegistry from '../../js/registries/strategy-registry.js';
import '../../js/components/input-box.js';
import '../../js/components/strategy-selector.js';

/**
 * Mount an <input-box>, force touch mode, and bind its listeners synchronously.
 *
 * render() runs synchronously in connectedCallback (it writes innerHTML) but
 * DEFERS setupListeners() to requestAnimationFrame. The test-pool window is kept
 * hidden, so rAF may never pump — waiting on it would hang. Instead we call
 * setupListeners() directly (the same fallback sendMessage() uses when the frame
 * hasn't fired yet) and neutralise the still-pending rAF call so the listeners
 * aren't bound twice.
 * @returns {{box: any, textarea: HTMLTextAreaElement, container: HTMLElement, sent: Array<any>}} The mounted input-box, its textarea, the container, and captured send-message details.
 */
function mountTouchComposer() {
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:360px;height:600px;';
  const box = document.createElement('input-box');
  // Force the touch-composer code path (matchMedia is undrivable headless).
  /** @type {any} */ (box)._touchComposerOverride = true;
  container.appendChild(box); // connectedCallback → render() writes the DOM now
  document.body.appendChild(container);

  // Bind listeners now, then no-op the deferred rAF call so it can't re-bind.
  /** @type {any} */ (box).setupListeners();
  /** @type {any} */ (box).setupListeners = () => {};

  const textarea = /** @type {HTMLTextAreaElement} */ (box.querySelector('textarea'));
  assert(!!textarea, 'input-box must render a textarea');

  // Capture every send-message the box dispatches.
  /** @type {Array<any>} */
  const sent = [];
  container.addEventListener('send-message', (e) => sent.push(/** @type {CustomEvent} */ (e).detail));

  return { box, textarea, container, sent };
}

/**
 * @param {HTMLTextAreaElement} textarea
 * @param {Partial<KeyboardEventInit>} init
 */
function pressKey(textarea, init) {
  textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

/**
 * Run the mobile touch-composer test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  const errors = [];

  // ── Test 1: Enter inserts a newline (no send); Send button sends ──────────
  {
    const { box, textarea, container, sent } = mountTouchComposer();
    try {
      textarea.value = 'hello';
      textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
      pressKey(textarea, { key: 'Enter' });

      assert(textarea.value === 'hello\n',
        `touch Enter must insert a newline, got ${JSON.stringify(textarea.value)}`);
      assert(sent.length === 0,
        `touch Enter must NOT dispatch send-message, got ${sent.length}`);

      // The Send button is the send affordance on touch.
      const sendBtn = /** @type {HTMLElement|null} */ (box.querySelector('#send-button'));
      assert(!!sendBtn, 'touch composer must render a #send-button');
      textarea.value = 'send me';
      textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
      /** @type {HTMLElement} */ (sendBtn).click();
      await Promise.resolve();

      assert(sent.length === 1,
        `Send button must dispatch exactly one send-message, got ${sent.length}`);
      assert(sent[0].message === 'send me',
        `Send button must send the typed text, got ${JSON.stringify(sent[0].message)}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push('enter-newline-and-send-button: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      container.remove();
    }
  }

  // ── Test 2: a plain Enter on a NON-touch composer still sends ─────────────
  // Guards the desktop path: the newline behaviour must be gated, not global.
  {
    const { box, textarea, container, sent } = mountTouchComposer();
    try {
      /** @type {any} */ (box)._touchComposerOverride = false; // desktop
      textarea.value = 'desktop send';
      textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
      pressKey(textarea, { key: 'Enter' });
      await Promise.resolve();

      assert(sent.length === 1,
        `desktop Enter must dispatch send-message, got ${sent.length}`);
      assert(sent[0].message === 'desktop send',
        `desktop Enter must send the typed text, got ${JSON.stringify(sent[0].message)}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push('desktop-enter-still-sends: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      container.remove();
    }
  }

  // ── Test 3: "+" sheet lists slash commands + actions; New Thread dispatches ─
  {
    const { box, container, sent } = mountTouchComposer();
    try {
      await /** @type {any} */ (box)._openActionsSheet();

      const sheet = /** @type {HTMLElement|null} */ (document.querySelector('.actions-sheet'));
      assert(!!sheet, 'the "+" button must open an .actions-sheet');

      // The sheet lists slash commands plus the two action rows.
      const commandRows = sheet.querySelectorAll('.menu-item[data-command]');
      assert(commandRows.length > 0, 'actions sheet must list slash-command rows');

      const rows = Array.from(sheet.querySelectorAll('.actions-sheet-item'));
      const threadRow = rows.find((r) => r.textContent?.includes('New Thread') && !r.hasAttribute('data-command'));
      assert(!!threadRow, 'actions sheet must have a "New Thread" action row');

      // The strategy selector is RELOCATED into the sheet (hidden inline on
      // touch), not left in the control row — so it lives in the sheet now,
      // not under the box.
      const strategySel = sheet.querySelector('strategy-selector');
      assert(!!strategySel,
        'strategy-selector must be relocated into the open actions sheet');

      // Clicking New Thread dispatches the /thread command (via _createThread).
      /** @type {HTMLElement} */ (threadRow).click();
      await Promise.resolve();
      assert(sent.length === 1 && /^\/thread\b/.test(sent[0].message),
        `New Thread row must dispatch the /thread command, got ${JSON.stringify(sent.map((s) => s.message))}`);
      assert(!document.querySelector('.actions-sheet'),
        'picking an actions-sheet row must close the sheet');

      // Closing the sheet returns the strategy selector to the inline row.
      const left = box.querySelector('input-controls-left');
      assert(!!left && left.contains(strategySel),
        'strategy-selector must return to the inline control row when the sheet closes');
      passed++;
    } catch (e) {
      failed++;
      errors.push('actions-sheet-new-thread: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      /** @type {any} */ (box)._closeActionsSheet?.();
      container.remove();
    }
  }

  // ── Test 4: the "+" sheet's Attach image row triggers the file picker ─────
  {
    const { box, container } = mountTouchComposer();
    try {
      await /** @type {any} */ (box)._openActionsSheet();
      const attachRow = Array.from(document.querySelectorAll('.actions-sheet-item'))
        .find((r) => r.textContent?.includes('Attach image'));
      assert(!!attachRow, 'actions sheet must have an "Attach image" row');

      const fileInput = /** @type {HTMLInputElement} */ (box.querySelector('.attach-file-input'));
      let pickerOpened = false;
      fileInput.click = () => { pickerOpened = true; };
      /** @type {HTMLElement} */ (attachRow).click();
      assert(pickerOpened, 'Attach image row must trigger the file picker');
      assert(!document.querySelector('.actions-sheet'),
        'picking the Attach image row must close the sheet');
      passed++;
    } catch (e) {
      failed++;
      errors.push('actions-sheet-attach: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      /** @type {any} */ (box)._closeActionsSheet?.();
      container.remove();
    }
  }

  // ── Test 5: switch strategy (Default → YOLO) from the "+" sheet ────────────
  // The relocation only earns its keep if the moved selector still WORKS. Prove
  // the end a phone user cares about: the sheet's strategy-selector is bound to
  // the conversation's thread, lists YOLO, and picking it pins YOLO via
  // MessageThread.setStrategy — the Default→YOLO switch, driven entirely from
  // the touch composer. (The dropdown's open state is reproduced deterministically
  // rather than via toggleDropdown's rAF, which the hidden test window can't pump —
  // the same approach strategy-menu-refresh-test uses.)
  {
    const { box, container } = mountTouchComposer();
    try {
      if (!strategyRegistry.isInitialized()) await strategyRegistry.init();
      assert(strategyRegistry.getAllManifests().some((m) => m.id === 'yolo'),
        'YOLO must be a registered strategy offerable from the mobile sheet');

      await /** @type {any} */ (box)._openActionsSheet();
      const sheet = /** @type {HTMLElement|null} */ (document.querySelector('.actions-sheet'));
      assert(!!sheet, 'the "+" button must open an .actions-sheet');

      const selector = /** @type {any} */ (sheet.querySelector('strategy-selector'));
      assert(!!selector && typeof selector.setMessageThread === 'function',
        'an upgraded strategy-selector must be relocated into the open sheet');

      // Bind a thread starting on the Default strategy; capture the switch the
      // selector makes (MessageThread.setStrategy is the real pin path).
      /** @type {string|null} */
      let pinned = null;
      selector.setMessageThread({
        currentStrategyId: 'default',
        setStrategy: (/** @type {string} */ id) => { pinned = id; },
      });
      assert(selector._currentStrategyId === 'default',
        'selector must start on the Default strategy before the switch');

      // Open the dropdown's end-state and pick YOLO.
      selector._dropdownOpen = true;
      selector.render();
      const yoloItem = /** @type {HTMLElement|null} */ (
        selector.querySelector('.strategy-item[data-strategy-id="yolo"]'));
      assert(!!yoloItem, 'the relocated selector must offer a YOLO item');

      /** @type {HTMLElement} */ (yoloItem).click();
      assert(pinned === 'yolo',
        `picking YOLO in the sheet must pin it via setStrategy, got ${JSON.stringify(pinned)}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push('actions-sheet-strategy-switch: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      /** @type {any} */ (box)._closeActionsSheet?.();
      container.remove();
    }
  }

  return { passed, failed, errors };
}
