//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What the window looks like while the app is starting up: the clubs over a
 * dimmed window, and — only once the wait has gone on long enough to be worth
 * explaining — a line naming the phase it is in.
 *
 * Two things here are worth more than the rest. The first is that this overlay
 * is OPAQUE where the reconnect one is a scrim: that is what keeps the
 * "No session loaded" line the sidebar renders out of a launch it was never
 * about — it is the right thing to say about a session that failed to arrive,
 * and the wrong thing to greet a launch with — and it is why nothing else has
 * to be hidden for the duration. The second is that `ready` is a one-way door:
 * a reconnect hours later must not put the startup overlay back over a window
 * the user is working in.
 *
 * The suite drives `_tick` by hand (the real one-second interval is cleared at
 * mount) so a ten-minute wait costs milliseconds.
 * @module unit-tests/startup-overlay-test
 */

import { assert } from '../utilities/test-helpers.js';
import StartupOverlay from '../../js/components/startup-overlay.js';
import appPhase, { setAppPhase, labelForPhase } from '../../js/services/app-phase.js';

/**
 * Force `document.hidden` for this lane. The headless test page is itself never
 * visible — every lane is an iframe in a window the runner keeps hidden — so
 * without this the overlay would correctly refuse to advance and every reveal
 * assertion would be vacuous. An own property shadows the prototype getter and
 * `delete` puts the real one back.
 * @param {boolean} hidden - What `document.hidden` should report.
 */
function forceHidden(hidden) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
}

/**
 * Mount an overlay at a phase and take its clock off the real timer.
 * @param {'starting'|'extensions'|'connecting'|'session'} phase - Phase to start in.
 * @returns {StartupOverlay} A mounted overlay, ticked only on demand.
 */
function mountOverlay(phase) {
  appPhase.__resetForTests();
  setAppPhase(phase);
  const overlay = new StartupOverlay();
  overlay.show();
  const self = /** @type {any} */ (overlay);
  clearInterval(self._waitTimer);
  self._waitTimer = null;
  return overlay;
}

/**
 * Run the overlay's clock forward by whole ticks.
 * @param {StartupOverlay} overlay - The mounted overlay.
 * @param {number} ms - How much time passes, in one-second ticks.
 */
function tickFor(overlay, ms) {
  const self = /** @type {any} */ (overlay);
  for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
    self._lastTickAt = Date.now() - 1000;
    self._tick();
  }
}

/**
 * The line currently on the overlay.
 * @param {StartupOverlay} overlay - The mounted overlay.
 * @returns {string} The message text.
 */
function lineOn(overlay) {
  const el = /** @type {any} */ (overlay)._messageElement;
  return el ? el.textContent : '';
}

/**
 * Whether the message block has been revealed (the spinner-only grace is over).
 * @param {StartupOverlay} overlay - The mounted overlay.
 * @returns {boolean} True once the wording is on screen.
 */
function revealed(overlay) {
  const el = /** @type {any} */ (overlay)._infoElement;
  return !!el && el.classList.contains('loading-overlay__info--visible');
}

/**
 * Run the startup-overlay tests.
 * @param {any} _ctx - Test context (unused).
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Test name
   * @param {() => Promise<void>|void} fn - Test body
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
  }

  const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden');
  const hadHiddenAttribute = document.documentElement.hasAttribute('data-doc-hidden');
  document.documentElement.removeAttribute('data-doc-hidden');
  forceHidden(false);

  /** @type {StartupOverlay|null} */
  let overlay = null;

  try {
    await test('the window it covers is blank, not dimmed', () => {
      overlay = mountOverlay('extensions');
      const startup = /** @type {HTMLElement} */ (/** @type {any} */ (overlay)._element);
      const reconnect = document.createElement('div');
      reconnect.className = 'loading-overlay';
      reconnect.dataset.loadingOverlay = 'disconnected';
      document.body.appendChild(reconnect);

      // A colour with any transparency at all in it leaves the empty sidebar
      // and its "No session loaded" line showing through as a ghost, which is
      // the whole thing this overlay is here to stop.
      assert(!/rgba|\/\s*0?\.\d/.test(getComputedStyle(startup).backgroundColor),
        `startup must be opaque, got "${getComputedStyle(startup).backgroundColor}"`);
      // Whereas a connection that dropped has work behind it worth seeing.
      assert(/rgba|\/\s*0?\.\d/.test(getComputedStyle(reconnect).backgroundColor),
        `a reconnect stays a scrim, got "${getComputedStyle(reconnect).backgroundColor}"`);

      reconnect.remove();
      overlay.hide();
      overlay = null;
    });

    await test('an ordinary launch is a spinner and nothing else', () => {
      overlay = mountOverlay('extensions');
      tickFor(overlay, 1000);
      assert(!revealed(overlay),
        'a launch that takes a moment must not explain itself; the clubs are the whole of it');
      overlay.hide();
      overlay = null;
    });

    await test('a launch that drags on says what it is waiting for', () => {
      overlay = mountOverlay('extensions');
      tickFor(overlay, 2000);
      assert(revealed(overlay), 'past the grace period the line must be on screen');
      assert(lineOn(overlay) === labelForPhase('extensions'),
        `expected the phase's own label, got "${lineOn(overlay)}"`);

      setAppPhase('connecting');
      assert(lineOn(overlay) === 'Connecting',
        `the line must follow the phase, got "${lineOn(overlay)}"`);
      setAppPhase('session');
      assert(lineOn(overlay) === 'Loading session',
        `and keep following it, got "${lineOn(overlay)}"`);

      overlay.hide();
      overlay = null;
    });

    await test('a window nobody is looking at explains nothing', () => {
      overlay = mountOverlay('extensions');
      forceHidden(true);
      tickFor(overlay, 10 * 60 * 1000);
      assert(!revealed(overlay),
        'ten minutes behind another window is not ten minutes of waiting');
      forceHidden(false);
      overlay.hide();
      overlay = null;
    });

    await test('a loaded session takes the overlay away', () => {
      overlay = mountOverlay('session');
      const element = /** @type {any} */ (overlay)._element;
      assert(!!element && element.isConnected, 'the overlay is on screen while the session loads');

      setAppPhase('ready');

      assert(!element.isConnected, 'and off it once the session is loaded');
      overlay = null;
    });

    await test('nothing puts the overlay back over a running app', () => {
      overlay = mountOverlay('session');
      setAppPhase('ready');
      // What a dropped connection an hour later would try to say. The
      // disconnection overlay is what answers for that; this one is done.
      setAppPhase('connecting');
      assert(appPhase.get() === 'ready', 'once the app is up it stays up');
      assert(!document.querySelector('[data-loading-overlay="startup"]'),
        'and nothing puts the startup overlay back over a window in use');
      overlay = null;
    });

    await test('the overlay painted before the scripts ran is the one that is used', () => {
      appPhase.__resetForTests();
      setAppPhase('extensions');
      // What index.html serves: the dimmed window, already on screen, waiting to
      // be taken over rather than replaced.
      const painted = document.createElement('div');
      painted.className = 'loading-overlay';
      painted.dataset.loadingOverlay = 'startup';
      painted.innerHTML = `
        <div class="loading-overlay__content notice">
          <div class="loading-overlay__info">
            <div class="loading-overlay__message notice__title"></div>
          </div>
        </div>`;
      document.body.appendChild(painted);

      overlay = new StartupOverlay();
      overlay.show();
      const self = /** @type {any} */ (overlay);
      clearInterval(self._waitTimer);
      self._waitTimer = null;

      assert(document.querySelectorAll('[data-loading-overlay="startup"]').length === 1,
        'adopting it, not building a second one over the top');
      assert(self._element === painted, 'and the one on screen is the one that was painted');

      overlay.hide();
      overlay = null;
      assert(!painted.isConnected, 'which is also the one that goes when startup ends');
    });
  } finally {
    if (overlay) /** @type {StartupOverlay} */ (overlay).hide();
    appPhase.__resetForTests();
    if (hiddenDescriptor) {
      Object.defineProperty(document, 'hidden', hiddenDescriptor);
    } else {
      // @ts-expect-error - removing the shadowing own property restores the real getter
      delete document.hidden;
    }
    document.documentElement.toggleAttribute('data-doc-hidden', hadHiddenAttribute);
  }

  return { passed, failed, errors };
}
