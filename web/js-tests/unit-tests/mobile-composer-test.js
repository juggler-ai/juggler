//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * UX invariants for the touch (mobile) composer:
 *
 *   1. On a touch composer a plain Enter inserts a NEWLINE (the onscreen
 *      keyboard's return key) and MUST NOT dispatch a send-message — the user
 *      can no longer accidentally fire the message by pressing return.
 *   2. The Send button DOES dispatch send-message with the typed text — it is
 *      the send affordance that replaces Enter.
 *   3. The strategy menu opened from the status line is dismissible: it presents
 *      on <body> as a bottom sheet and must still close and release its
 *      open-popup token.
 *   4. At the narrowest column the layout allows, every control still lies
 *      inside the composer bubble. A control laid out past the content edge is
 *      a control the user cannot reach.
 *   5. At every phone width the touch composer IS the desktop composer, at a
 *      finger's size: the same tools on the row inside the bubble — nothing
 *      folded away behind a "more" button — and the same three settings on the
 *      status line under it, each legible, none squeezed out of sight. The
 *      composer is bound as column-builder binds it (conversation, then
 *      thread), so a binding that leaves a control unbound fails here too.
 *
 * The touch decision normally reads `matchMedia('(hover: none) and
 * (pointer: coarse)')`, which the headless harness cannot drive. So the test
 * supplies the answer through the component's `isCoarsePointer` dependency.
 * @module unit-tests/mobile-composer-test
 */

import {
  initializeRegistries, createTestSession, createTestConversation, assert, nextTask,
} from '../utilities/test-helpers.js';
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
  /** @type {any} */ (box).isCoarsePointer = () => true;
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
 * @param {HTMLTextAreaElement} textarea
 * @param {Partial<KeyboardEventInit>} init
 */
function pressKey(textarea, init) {
  textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

/**
 * The left and right edges of an element's content box.
 * @param {Element} el
 * @returns {{left: number, right: number}} Content-box edges in viewport px.
 */
function contentEdges(el) {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return {
    left: r.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0),
    right: r.right - (parseFloat(cs.borderRightWidth) || 0) - (parseFloat(cs.paddingRight) || 0),
  };
}

/**
 * Run the mobile touch-composer test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  await initializeRegistries();
  const session = await createTestSession();
  const conversation = await createTestConversation(session);
  const thread = conversation.rootMessageThread;

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
      /** @type {any} */ (box).isCoarsePointer = () => false; // desktop
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

  // ── Test 3: the strategy menu opened from the status line is dismissible ──
  // On touch the menu presents as a bottom sheet with a scrim. It must still
  // present on <body>, still close, and still release its open-popup token (a
  // leaked one makes Escape stop dismissing popups AND stop reaching the
  // running turn for the rest of the session).
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
        box.querySelector('composer-status-line strategy-selector'));
      assert(!!selector, 'the strategy selector must be in the status line');

      const strategyBtn = /** @type {HTMLElement|null} */ (
        selector.querySelector('.strategy-selector-button'));
      assert(!!strategyBtn, 'the selector must render its button');
      /** @type {HTMLElement} */ (strategyBtn).click();
      await nextTask(); // presentInlineMenu's frame: relocate + present
      await nextTask(); // presentPopup's own frame: place it

      const menu = document.querySelector('.strategy-dropdown[data-strategy-selector="true"]');
      assert(!!menu, 'the strategy menu must be presented on <body>, not torn down by the re-parent');
      assert(menu.parentElement === document.body,
        'the presented menu must be hosted on <body>');
      const line = box.querySelector('composer-status-line');
      assert(!!line && line.contains(selector),
        'the selector itself must stay in the status line');

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
      errors.push('status-line-strategy-menu: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      closeAllPopups();
      document.querySelectorAll('.strategy-dropdown[data-strategy-selector="true"], .popup-sheet-scrim')
        .forEach((el) => el.remove());
      container.remove();
      window.requestAnimationFrame = realRaf;
      window.cancelAnimationFrame = realCancelRaf;
      __resetPopupManagerForTests();
    }
  }

  // ── Test 4: a narrow column never pushes a control outside the bubble ─────
  // A column can be dragged down to COL_MIN_WIDTH_REM, so the invariant has to
  // hold there — a control laid out past the bubble's content edge cannot be
  // tapped. (`unit:composer-row` holds the same invariant, status line
  // included, across the widths in between.)
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

  // ── Test 5: at phone width the touch composer is the desktop composer ─────
  // The tools on the row and the settings on the status line, all of them, at
  // every width a phone gives the composer — and with the expand button, the
  // cache warning, or both on show as well, the row at its longest. One line
  // throughout, bar one case: on a 320px screen with both extras on show, Send
  // may drop under the tray, still at the far end and still inside the bubble.
  /** The row's tools, every one on show on touch as on desktop. */
  const ROW_TOOLS = ['#commands-button', '#skill-button', '.schedule-send-btn', '#attach-button',
    '.new-thread-btn', '#send-button'];
  /** A long-but-real model name: it ellipsises, it never squeezes the others. */
  const LONG_MODEL = 'Claude Sonnet 4.5 (CLI)';
  const phoneCases = ['320px', '360px', '390px', '430px']
    .flatMap((w) => ['', 'expand', 'warning', 'both'].map((x) => /** @type {[string, string]} */ ([w, x])));
  for (const [width, extras] of phoneCases) {
    const name = `phone-layout@${width}${extras ? '+' + extras : ''}`;
    const mayWrap = width === '320px' && extras === 'both';
    const container = document.createElement('div');
    container.style.cssText = `position:absolute;left:0;top:0;width:${width};`;
    const box = /** @type {any} */ (document.createElement('composer-box'));
    box.isCoarsePointer = () => true;
    container.appendChild(box);
    document.body.appendChild(container);
    try {
      // Bound exactly as column-builder binds a column's composer.
      box.setSession(session);
      box.setConversation(conversation);
      box.setMessageThread(thread);
      if (extras === 'expand' || extras === 'both') box.querySelector('.expand-input-btn').hidden = false;
      if (extras === 'warning' || extras === 'both') box.querySelector('#context-cache-warning').hidden = false;
      const modelName = box.querySelector('composer-status-line .model-name');
      if (modelName) modelName.textContent = LONG_MODEL;

      // The row: no "more" button, every tool on show, inside the bubble, on
      // one line, at a finger's height.
      const row = contentEdges(box.querySelector('composer-box-wrapper'));
      /** @type {string[]} */
      const rowFaults = [];
      if (box.querySelector('#more-actions-button')) rowFaults.push('it folds its tools behind a "more" button');
      const rowRects = ROW_TOOLS.map((sel) => {
        const el = box.querySelector(sel);
        const r = el?.getBoundingClientRect();
        if (!el || !r || r.width === 0) rowFaults.push(`${sel} is not on show`);
        else if (r.left < row.left - 0.5 || r.right > row.right + 0.5) {
          rowFaults.push(`${sel} spills (${Math.round(r.left)}–${Math.round(r.right)}, bubble ${Math.round(row.left)}–${Math.round(row.right)})`);
        }
        return r;
      });
      const rowTops = new Set(rowRects.filter((r) => r && r.width > 0)
        .map((r) => Math.round(r.top + r.height / 2)));
      if (rowTops.size > (mayWrap ? 2 : 1)) {
        const tools = Array.from(box.querySelectorAll('input-controls-tools button'))
          .map((el) => [el.id || el.className.split(' ')[0], el.getBoundingClientRect().width])
          .filter(([, w]) => /** @type {number} */ (w) > 0)
          .map(([n, w]) => `${n} ${Math.round(/** @type {number} */ (w))}`);
        rowFaults.push(`it wraps onto ${rowTops.size} lines (row ${Math.round(row.right - row.left)}px: ${tools.join(', ')})`);
      }
      const send = box.querySelector('#send-button').getBoundingClientRect();
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      if (send.height < 2 * rem - 0.5) rowFaults.push(`its tools are not finger-sized (Send is ${send.height}px tall)`);

      // The status line: strategy, permissions and model, each on show, inside
      // the line, and each legible — permissions never clipped, strategy
      // showing its icon or a few characters of its name, the model a few
      // characters of its own.
      const lineEl = box.querySelector('composer-status-line');
      const line = contentEdges(lineEl);
      /** @type {string[]} */
      const lineFaults = [];
      const settings = {
        strategy: box.querySelector('composer-status-line .strategy-selector-button'),
        permissions: box.querySelector('composer-status-line .permission-btn'),
        model: box.querySelector('composer-status-line .model-selector-button'),
      };
      for (const [what, el] of Object.entries(settings)) {
        const r = el?.getBoundingClientRect();
        if (!el || !r || r.width === 0) { lineFaults.push(`${what} is not on show`); continue; }
        if (r.left < line.left - 0.5 || r.right > line.right + 0.5) {
          lineFaults.push(`${what} spills (${Math.round(r.left)}–${Math.round(r.right)}, line ${Math.round(line.left)}–${Math.round(line.right)})`);
        }
      }
      const perm = settings.permissions;
      if (perm && perm.scrollWidth > perm.clientWidth + 1) {
        lineFaults.push(`permissions is clipped (${perm.clientWidth}px of ${perm.scrollWidth}px)`);
      }
      const strategy = settings.strategy;
      if (strategy) {
        if (strategy.scrollWidth > strategy.clientWidth + 1) {
          lineFaults.push(`strategy is clipped (${strategy.clientWidth}px of ${strategy.scrollWidth}px)`);
        }
        const icon = strategy.querySelector('.strategy-icon')?.getBoundingClientRect().width ?? 0;
        const label = strategy.querySelector('.strategy-name')?.getBoundingClientRect().width ?? 0;
        if (icon === 0 && label < 2 * rem) {
          lineFaults.push(`strategy shows neither its icon nor its name (name ${Math.round(label)}px)`);
        }
      }
      const modelLabel = box.querySelector('composer-status-line .model-name')?.getBoundingClientRect().width ?? 0;
      if (modelLabel < 3 * rem) lineFaults.push(`the model's name is squeezed to ${Math.round(modelLabel)}px`);
      const lineTops = new Set(Object.values(settings)
        .map((el) => el?.getBoundingClientRect())
        .filter((r) => r && r.width > 0)
        .map((r) => Math.round(/** @type {DOMRect} */ (r).top + /** @type {DOMRect} */ (r).height / 2)));
      if (lineTops.size > 1) lineFaults.push(`it wraps onto ${lineTops.size} lines`);
      assert(rowFaults.length + lineFaults.length === 0,
        [rowFaults.length ? `the row: ${rowFaults.join('; ')}` : '',
          lineFaults.length ? `the status line: ${lineFaults.join('; ')}` : ''].filter(Boolean).join(' | '));
      assert(lineEl.getBoundingClientRect().top >= box.querySelector('composer-box-wrapper').getBoundingClientRect().bottom - 0.5,
        'the status line must sit under the bubble');
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ` + (e instanceof Error ? e.message : String(e)));
    } finally {
      container.remove();
    }
  }

  return { passed, failed, errors };
}
