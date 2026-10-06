//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * UX invariants for the touch (mobile) composer on the composer:
 *
 *   1. On a touch composer a plain Enter inserts a NEWLINE (the onscreen
 *      keyboard's return key) and MUST NOT dispatch a send-message — the user
 *      can no longer accidentally fire the message by pressing return.
 *   2. The touch-only Send button DOES dispatch send-message with the typed
 *      text — it is the send affordance that replaces Enter.
 *   3. The "⋮" overflow button opens the actions sheet, whose rows reuse the
 *      existing handlers: the New Thread row dispatches the /thread command.
 *      Opening the sheet and picking a row closes it. Attach files is NOT in
 *      the sheet: the paperclip stays inline beside Send, where it can be
 *      found, and triggers the hidden file input.
 *   4. The strategy menu opened from inside that sheet is dismissible. It is the
 *      one row that presents a popup of its own, which closes the sheet
 *      mid-presentation and re-parents the selector — a cascade that must still
 *      leave a menu that closes and releases its open-popup token.
 *   5. At the narrowest column the layout allows, every control still lies
 *      inside the composer bubble. A control laid out past the content edge is
 *      a control the user cannot reach.
 *
 * The touch decision normally reads `matchMedia('(hover: none) and
 * (pointer: coarse)')`, which the headless harness cannot drive. So the test
 * forces it via the `_touchComposerOverride` escape hatch the component exposes
 * for exactly this purpose.
 * @module unit-tests/mobile-composer-test
 */

import { initializeRegistries, assert } from '../utilities/test-helpers.js';
import { closeAllPopups, isAnyPopupOpen, __resetPopupManagerForTests } from '../../js/utils/popup-manager.js';
import { COL_MIN_WIDTH_REM } from '../../js/utils/column-resize.js';
import '../../js/components/composer.js';

/**
 * Mount an <composer-box>, force touch mode, and bind its listeners synchronously.
 *
 * render() runs synchronously in connectedCallback (it writes innerHTML) but
 * DEFERS setupListeners() to requestAnimationFrame. The test-pool window is kept
 * hidden, so rAF may never pump — waiting on it would hang. Instead we call
 * setupListeners() directly (the same fallback sendMessage() uses when the frame
 * hasn't fired yet) and neutralise the still-pending rAF call so the listeners
 * aren't bound twice.
 * @returns {{box: any, textarea: HTMLTextAreaElement, container: HTMLElement, sent: Array<any>}} The mounted composer-box, its textarea, the container, and captured send-message details.
 */
function mountTouchComposer() {
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:360px;height:600px;';
  const box = document.createElement('composer-box');
  // Force the touch-composer code path (matchMedia is undrivable headless).
  /** @type {any} */ (box)._touchComposerOverride = true;
  container.appendChild(box); // connectedCallback → render() writes the DOM now
  document.body.appendChild(container);

  // Bind listeners now, then no-op the deferred rAF call so it can't re-bind.
  /** @type {any} */ (box).setupListeners();
  /** @type {any} */ (box).setupListeners = () => {};

  const textarea = /** @type {HTMLTextAreaElement} */ (box.querySelector('textarea'));
  assert(!!textarea, 'composer-box must render a textarea');

  // Capture every send-message the box dispatches.
  /** @type {Array<any>} */
  const sent = [];
  container.addEventListener('send-message', (e) => sent.push(/** @type {CustomEvent} */ (e).detail));

  return { box, textarea, container, sent };
}

/**
 * Yield to the macrotask queue, so one shimmed animation frame can run.
 * @returns {Promise<void>} Resolves after the next macrotask.
 */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

      // Strategy is NOT in the sheet: on touch it is on show in the config
      // strip, which is also the control that changes it.
      assert(!sheet.querySelector('strategy-selector'),
        'strategy-selector must stay in the config strip, not move into the sheet');

      // Clicking New Thread dispatches the /thread command (via _createThread).
      /** @type {HTMLElement} */ (threadRow).click();
      await Promise.resolve();
      assert(sent.length === 1 && /^\/thread\b/.test(sent[0].message),
        `New Thread row must dispatch the /thread command, got ${JSON.stringify(sent.map((s) => s.message))}`);
      assert(!document.querySelector('.actions-sheet'),
        'picking an actions-sheet row must close the sheet');
      passed++;
    } catch (e) {
      failed++;
      errors.push('actions-sheet-new-thread: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      /** @type {any} */ (box)._closeActionsSheet?.();
      container.remove();
    }
  }

  // ── Test 4: the paperclip stays inline on touch and opens the picker ──────
  {
    const { box, container } = mountTouchComposer();
    try {
      const attachBtn = /** @type {HTMLElement|null} */ (box.querySelector('#attach-button'));
      assert(!!attachBtn, 'touch composer must render an #attach-button');
      assert(attachBtn.getBoundingClientRect().width > 0,
        'the attach button must stay visible on touch, not collapse into the sheet');

      const fileInput = /** @type {HTMLInputElement} */ (box.querySelector('.attach-file-input'));
      let pickerOpened = false;
      fileInput.click = () => { pickerOpened = true; };
      attachBtn.click();
      assert(pickerOpened, 'the attach button must trigger the file picker');

      // One way to it, not two: the sheet carries no attach row.
      await /** @type {any} */ (box)._openActionsSheet();
      const attachRow = Array.from(document.querySelectorAll('.actions-sheet-item'))
        .find((r) => /attach/i.test(r.textContent || ''));
      assert(!attachRow, 'the actions sheet must not duplicate the inline attach button');
      passed++;
    } catch (e) {
      failed++;
      errors.push('actions-sheet-attach: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      /** @type {any} */ (box)._closeActionsSheet?.();
      container.remove();
    }
  }

  // ── Test 5: the strategy menu opened from the config strip is dismissible ─
  // The strip's segments are the same selectors the inline row holds, re-homed
  // by _applyConfigPlacement — a re-parent, which disconnects and reconnects
  // the element. That must leave a selector whose menu still presents on
  // <body>, still closes, and still releases its open-popup token (a leaked one
  // makes Escape stop dismissing popups AND stop reaching the running turn for
  // the rest of the session).
  {
    __resetPopupManagerForTests();
    // presentInlineMenu and presentPopup both defer a frame, and the hidden
    // test window may never paint. Drive both off macrotasks instead.
    const realRaf = window.requestAnimationFrame;
    const realCancelRaf = window.cancelAnimationFrame;
    window.requestAnimationFrame = (/** @type {FrameRequestCallback} */ cb) =>
      /** @type {any} */ (setTimeout(() => cb(performance.now()), 0));
    window.cancelAnimationFrame = (/** @type {number} */ id) => clearTimeout(id);
    const { box, container } = mountTouchComposer();
    try {
      const selector = /** @type {any} */ (
        box.querySelector('composer-config-strip strategy-selector'));
      assert(!!selector, 'the strategy selector must be homed in the config strip');

      const strategyBtn = /** @type {HTMLElement|null} */ (
        selector.querySelector('.strategy-selector-button'));
      assert(!!strategyBtn, 'the re-homed selector must render its button');
      /** @type {HTMLElement} */ (strategyBtn).click();
      await tick(); // presentInlineMenu's frame: relocate + present
      await tick(); // presentPopup's own frame: place it

      const menu = document.querySelector('.strategy-dropdown[data-strategy-selector="true"]');
      assert(!!menu, 'the strategy menu must be presented on <body>, not torn down by the re-parent');
      assert(menu.parentElement === document.body,
        'the presented menu must be hosted on <body>');
      const strip = box.querySelector('composer-config-strip');
      assert(!!strip && strip.contains(selector),
        'the selector itself must stay in the config strip');

      // Escape / Back / scrim-tap all route through closeAllPopups.
      closeAllPopups();
      assert(!document.querySelector('.strategy-dropdown[data-strategy-selector="true"]'),
        'dismissing must remove the presented menu');
      assert(!document.querySelector('.popup-sheet-scrim'),
        'dismissing must remove the sheet scrim');
      assert(!isAnyPopupOpen(),
        'dismissing must release the open-popup token (a leak disables Escape for the session)');
      passed++;
    } catch (e) {
      failed++;
      errors.push('actions-sheet-strategy-menu: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      closeAllPopups();
      document.querySelectorAll('.strategy-dropdown[data-strategy-selector="true"], .popup-sheet-scrim')
        .forEach((el) => el.remove());
      /** @type {any} */ (box)._closeActionsSheet?.();
      container.remove();
      window.requestAnimationFrame = realRaf;
      window.cancelAnimationFrame = realCancelRaf;
      __resetPopupManagerForTests();
    }
  }

  // ── Test 6: a narrow column never pushes a control outside the bubble ─────
  // The narrow-column fold (composer.css, `@container (max-width: 46rem)`) is
  // there so the config controls wrap and ellipsise rather than spill: its own
  // comment states that never losing a control beats width stability. A column
  // can be dragged down to COL_MIN_WIDTH_REM, so the invariant has to hold
  // there — a control laid out past the bubble's content edge cannot be tapped.
  {
    const container = document.createElement('div');
    container.style.cssText =
      `position:absolute;left:0;top:0;width:${COL_MIN_WIDTH_REM}rem;`;
    const box = document.createElement('composer-box');
    container.appendChild(box);
    document.body.appendChild(container);
    try {
      // A long model id is the realistic worst case. `.model-name` is capped
      // and ellipsised precisely so it cannot widen the row, so substituting
      // one here changes what is displayed, never what fits.
      const modelName = /** @type {HTMLElement|null} */ (box.querySelector('.model-name'));
      assert(!!modelName, 'the composer must render a .model-name');
      /** @type {HTMLElement} */ (modelName).textContent =
        'anthropic/claude-sonnet-4-5-20260930-thinking-preview';

      const wrapper = /** @type {HTMLElement|null} */ (box.querySelector('composer-box-wrapper'));
      assert(!!wrapper, 'the composer must render a composer-box-wrapper');
      const padRight = parseFloat(getComputedStyle(/** @type {HTMLElement} */ (wrapper)).paddingRight) || 0;
      const contentRight = /** @type {HTMLElement} */ (wrapper).getBoundingClientRect().right - padRight;

      const spilled = Array.from(box.querySelectorAll('input-controls button'))
        .map((el) => ({ el, rect: el.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0) // skip the ones CSS has hidden
        .filter(({ rect }) => rect.right > contentRight + 0.5)
        .map(({ el, rect }) =>
          `${el.id || el.className.split(' ')[0]} (right edge ${Math.round(rect.right)}, bubble ends ${Math.round(contentRight)})`);

      assert(spilled.length === 0,
        `at a ${COL_MIN_WIDTH_REM}rem column every control must lie inside the bubble, but these spilled past it: ${spilled.join('; ')}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push('narrow-column-keeps-controls-reachable: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      container.remove();
    }
  }

  // ── Test 7: the touch composer's config strip, at phone width ────────────
  // The three config controls move out of the controls row and into the strip,
  // leaving a row that cannot overflow. The strip itself must hold one line
  // whatever the model is called: the model segment ellipsises, the other two
  // stay whole, and nothing leaves the bubble.
  {
    const container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:0;top:0;width:390px;';
    const box = document.createElement('composer-box');
    /** @type {any} */ (box)._touchComposerOverride = true;
    container.appendChild(box);
    document.body.appendChild(container);
    try {
      const strip = /** @type {HTMLElement|null} */ (box.querySelector('composer-config-strip'));
      assert(!!strip, 'the touch composer must render a composer-config-strip');

      // All three controls are homed in the strip, in reading order, and the
      // controls row keeps none of them.
      const homed = Array.from(/** @type {HTMLElement} */ (strip).children).map((el) => el.tagName.toLowerCase());
      assert(homed.join(' ') === 'model-selector strategy-selector permission-controls',
        `the strip must hold model, strategy and permissions in that order, got: ${homed.join(' ') || '(empty)'}`);
      assert(!box.querySelector('input-controls-config > *'),
        'the touch controls row must keep none of the config controls');

      // Permissions is last, so no separator is left dangling at the line end.
      const trailing = getComputedStyle(
        /** @type {HTMLElement} */ (strip.lastElementChild), '::after').content;
      assert(trailing === 'none' || trailing === 'normal' || trailing === '""',
        `the last strip segment must not render a trailing separator, got ${trailing}`);

      // A long model id must ellipsise inside the strip, not widen it.
      const modelName = /** @type {HTMLElement|null} */ (box.querySelector('.model-name'));
      assert(!!modelName, 'the strip must render a .model-name');
      /** @type {HTMLElement} */ (modelName).textContent =
        'anthropic/claude-sonnet-4-5-20260930-thinking-preview';

      const wrapper = /** @type {HTMLElement} */ (box.querySelector('composer-box-wrapper'));
      const padRight = parseFloat(getComputedStyle(wrapper).paddingRight) || 0;
      const contentRight = wrapper.getBoundingClientRect().right - padRight;

      const stripRect = /** @type {HTMLElement} */ (strip).getBoundingClientRect();
      assert(stripRect.right <= contentRight + 0.5,
        `the config strip must stay inside the bubble (right edge ${Math.round(stripRect.right)}, bubble ends ${Math.round(contentRight)})`);

      // One line: the strip is no taller than the tallest single segment.
      const tallest = Math.max(...Array.from(/** @type {HTMLElement} */ (strip).children)
        .map((el) => el.getBoundingClientRect().height));
      assert(stripRect.height <= tallest + 1,
        `the config strip must stay on one line (height ${Math.round(stripRect.height)} vs segment ${Math.round(tallest)})`);

      // And the row that is left over holds the three controls that matter, all
      // inside the bubble.
      for (const id of ['more-actions-button', 'attach-button', 'send-button']) {
        const btn = /** @type {HTMLElement|null} */ (box.querySelector('#' + id));
        assert(!!btn, `the touch controls row must render #${id}`);
        const rect = /** @type {HTMLElement} */ (btn).getBoundingClientRect();
        assert(rect.width > 0, `#${id} must be visible on the touch controls row`);
        assert(rect.right <= contentRight + 0.5,
          `#${id} must lie inside the bubble (right edge ${Math.round(rect.right)}, bubble ends ${Math.round(contentRight)})`);
      }
      passed++;
    } catch (e) {
      failed++;
      errors.push('touch-config-strip: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      container.remove();
    }
  }

  return { passed, failed, errors };
}
