//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: the about box opens from the native menu.
 *
 * The macOS application menu's "About Juggler" is wired to dispatch
 * `juggler:open-about` into the focused window's page (cmd/juggler-app/menu.go),
 * so that the app's own about box opens rather than the platform's stock about
 * panel. This asserts the page end of that bridge: the event opens the modal,
 * and it keeps opening on every further click of the menu item. The header's
 * wordmark (components/app-wordmark.js) asks for it with the same event.
 * @module unit-tests/about-menu-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import '../../js/components/about-modal.js';
import '../../js/components/app-wordmark.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const modal = /** @type {any} */ (document.createElement('about-modal'));
  document.body.appendChild(modal);

  /** @returns {HTMLElement|null} The open about panel, if there is one. */
  const panel = () => /** @type {HTMLElement|null} */ (modal.querySelector('.about-container'));

  // The throw is skipped under reduced motion, which CI desktops commonly ask
  // for, so the machine's setting is answered as "no" unless a check says otherwise.
  const realMatchMedia = window.matchMedia;
  /** @type {any} */ (window).matchMedia = (/** @type {string} */ q) => (q === '(prefers-reduced-motion: reduce)'
    ? { matches: false, media: q, addEventListener() {}, removeEventListener() {} }
    : realMatchMedia.call(window, q));

  try {
    // --- 1: nothing is shown until something asks for it ---------------------
    assert(!panel(), 'the about box was open before anything opened it');
    passed++;

    // --- 2: the menu event opens it ------------------------------------------
    window.dispatchEvent(new CustomEvent('juggler:open-about'));
    await waitFor(() => !!panel(), { description: 'the about box to open from the menu event' });
    passed++;

    // --- 3: and it opens again, every time the menu item is picked -----------
    /** @type {HTMLElement} */ (modal.querySelector('#about-close')).click();
    // It is closed at once but leaves on screen, and nothing in it may catch
    // the pointer while it does.
    assert(modal.classList.contains('is-closing') && !!panel(), 'the about box must stay on screen to make its exit');
    assert(getComputedStyle(modal).pointerEvents === 'none', 'a leaving about box must let the pointer through');
    await waitFor(() => !panel(), { description: 'the about box to close' });
    assert(!modal.classList.contains('is-closing'), 'the exit must end once the box has gone');
    window.dispatchEvent(new CustomEvent('juggler:open-about'));
    await waitFor(() => !!panel(), { description: 'the about box to reopen from the menu event' });
    passed++;

    // --- 4: the header's wordmark opens it, by mouse or keyboard -------------
    // One element on a session's page and the server's sessions page alike.
    const wordmark = document.createElement('app-wordmark');
    document.body.appendChild(wordmark);
    try {
      assert(wordmark.getAttribute('role') === 'button' && wordmark.tabIndex === 0 && !!wordmark.getAttribute('aria-label'),
        'the wordmark is not a named button the keyboard can reach');
      assert(wordmark.classList.contains('logo'), 'the wordmark does not wear the header\'s .logo');
      /** @type {HTMLElement} */ (modal.querySelector('#about-close')).click();
      await waitFor(() => !panel(), { description: 'the about box to close' });
      wordmark.click();
      await waitFor(() => !!panel(), { description: 'the about box to open from the wordmark' });
      /** @type {HTMLElement} */ (modal.querySelector('#about-close')).click();
      await waitFor(() => !panel(), { description: 'the about box to close' });
      wordmark.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await waitFor(() => !!panel(), { description: 'the about box to open from Enter on the wordmark' });
    } finally {
      wordmark.remove();
    }
    passed++;

    // Seek the animation synchronously: offscreen lanes need not deliver frames.
    // That goes for the panel's entrance too, which leaves it scaled until it
    // lands, and the geometry asserted below is the settled box's.
    for (const entrance of /** @type {HTMLElement} */ (panel()).getAnimations()) entrance.finish();
    const logo = /** @type {HTMLElement} */ (modal.querySelector('.about-logo'));
    const clubs = [...logo.querySelectorAll('.logo-club')];
    // Lane viewport heights vary. Give the trajectory a known amount of
    // headroom without waiting for an offscreen window to paint.
    const svg = /** @type {SVGSVGElement} */ (logo.querySelector('svg'));
    const originalRect = svg.getBoundingClientRect.bind(svg);
    const view = svg.viewBox.baseVal;
    const actualScale = originalRect().height / view.height;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    assert(Math.abs(actualScale * 28.263 - 2.2 * rem) < 0.1,
      'expanding the flight viewport must preserve the logo ink size');
    assert(getComputedStyle(svg).pointerEvents === 'none',
      'empty flight space must not intercept backdrop clicks');
    const scale = 35.2 / 28.263;
    /** @type {(inkTop: number) => DOMRect} */
    const flightRect = inkTop => new window.DOMRect(200, inkTop + view.y * scale,
      view.width * scale, view.height * scale);
    svg.getBoundingClientRect = () => flightRect(200);
    modal._throwClubs(logo);
    assert(getComputedStyle(panel()).overflow === 'visible', 'the panel clips airborne clubs');
    assert(clubs.length === 3, 'the logo must juggle three clubs');
    const animations = clubs.map(club => club.getAnimations().find(a => a.id === 'about-club-flight'));
    assert(animations.every(Boolean), 'each club needs a juggling trajectory');
    animations.forEach((animation, i) => {
      const effect = /** @type {KeyframeEffect} */ (animation.effect);
      const frames = effect.getKeyframes();
      const first = new window.DOMMatrix(/** @type {string} */ (frames[0].transform));
      const apex = new window.DOMMatrix(/** @type {string} */ (frames[12].transform));
      const catchFrame = new window.DOMMatrix(/** @type {string} */ (frames[24].transform));
      assert(Math.abs(apex.m41 - (first.m41 + catchFrame.m41) / 2) < 0.01,
        'horizontal flight speed must be constant');
      assert(apex.m42 < Math.min(first.m42, catchFrame.m42) - 10,
        'the throw must arc upwards before falling to the opposite hand');
      const last = new window.DOMMatrix(/** @type {string} */ (frames.at(-1).transform));
      assert(last.isIdentity, 'each club must land exactly in its logo space');
      assert(effect.getTiming().delay === 600 + i * 450, 'throws must be staggered by one juggling beat');
      assert(frames.length >= 100, 'clubs must make several throws before landing');
      const box = /** @type {SVGGElement} */ (clubs[i]).getBBox();
      const radius = Math.hypot(box.width, box.height) / 2;
      const view = svg.viewBox.baseVal;
      for (const frame of frames) {
        const matrix = new window.DOMMatrix(/** @type {string} */ (frame.transform));
        const x = box.x + box.width / 2 + matrix.m41;
        const y = box.y + box.height / 2 + matrix.m42;
        assert(x - radius >= view.x && x + radius <= view.x + view.width
          && y - radius >= view.y && y + radius <= view.y + view.height,
        'the SVG viewport must contain the entire spinning club throughout its flight');
      }
    });
    passed++;

    const oldAnimations = animations.slice();
    logo.click();
    assert(oldAnimations.every(a => a.playState === 'idle'), 'replaying must cancel the previous throws');
    assert(clubs.every(club => club.getAnimations().filter(a => a.id === 'about-club-flight').length === 1),
      'replaying must not stack trajectories');
    passed++;

    svg.getBoundingClientRect = () => flightRect(50);
    logo.click();
    const lowFlight = /** @type {KeyframeEffect} */ (clubs[0].getAnimations()[0].effect).getKeyframes();
    const lowApex = new window.DOMMatrix(/** @type {string} */ (lowFlight[12].transform));
    assert(50 + lowApex.m42 * (35.2 / 28.263) >= 20,
      'throws must shrink to fit the viewport headroom');
    svg.getBoundingClientRect = originalRect;
    passed++;

    const originalMatchMedia = window.matchMedia;
    try {
      window.matchMedia = /** @type {any} */ (() => ({ matches: true }));
      logo.click();
      assert(clubs.every(club => club.getAnimations().length === 0),
        'reduced motion must leave the logo still');
    } finally {
      window.matchMedia = originalMatchMedia;
    }
    passed++;
    logo.click();

    /** @type {HTMLElement} */ (modal.querySelector('#about-close')).click();
    assert(clubs.every(club => club.getAnimations().length === 0), 'closing must cancel airborne clubs');
    passed++;

    // --- en-XA: everything the box says is translated ------------------------
    // A box of its own, opened directly, whose /version answer carries no
    // version, so the "Unknown" it shows instead is checked too.
    /** @type {string[]} */
    const shown = [];
    const fresh = /** @type {any} */ (document.createElement('about-modal'));
    try {
      await underPseudoLocale('test-about-modal', async () => {
        const realFetch = window.fetch;
        window.fetch = /** @type {any} */ ((/** @type {any} */ input, /** @type {any} */ init) => (
          String(input?.url ?? input).includes('/version')
            ? Promise.resolve(new window.Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
            : realFetch.call(window, input, init)));
        try {
          document.body.appendChild(fresh);
          await fresh.open();
        } finally {
          window.fetch = realFetch;
        }
        // The logo is the product name; the site URL and the author's name
        // are data, drawn as written.
        shown.push(...shownStrings(fresh,
          '.about-logo, a[href="https://juggler.studio"], a[href="https://github.com/julianstorer"]'));
        assert(shown.length >= 6, `the box drew its text, got ${JSON.stringify(shown)}`);
      });
    } finally {
      fresh.querySelector('#about-close')?.click();
      fresh.remove();
    }
    const raw = shown.filter((s) => !isPseudoLocalized(s));
    assert(raw.length === 0, `plain English under en-XA (about box): ${JSON.stringify(raw)}`);
    passed++;
  } catch (e) {
    failed++;
    errors.push(`about-menu: ${/** @type {any} */ (e)?.message || e}\n${/** @type {any} */ (e)?.stack || ''}`);
  } finally {
    const close = /** @type {HTMLElement|null} */ (modal.querySelector('#about-close'));
    if (close) close.click();
    modal.remove();
    window.matchMedia = realMatchMedia;
  }

  return { passed, failed, errors };
}
