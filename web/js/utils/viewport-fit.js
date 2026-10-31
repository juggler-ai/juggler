//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Mobile keyboard viewport fit.
 *
 * `<app-container>` is `position: fixed; inset: 0`, so it's sized to the LAYOUT
 * viewport — which the on-screen keyboard does not shrink. Left alone, the
 * browser's response to focusing the composer (pinned near the bottom) is to
 * scroll the whole page up so the field clears the keyboard, carrying the
 * `.app-header` and its tab menu off the top of the screen.
 *
 * Instead we pin `<app-container>` to the VISUAL viewport: its height tracks
 * `visualViewport.height` (which the keyboard does shrink) and its top tracks
 * `visualViewport.offsetTop`. The container's flex column reflows inside the
 * smaller box — the header keeps its place (`flex-shrink: 0`) and `.app-main`
 * (`flex: 1`) absorbs the loss, shrinking the conversation area so the composer
 * sits just above the keyboard with the header still on screen. When the
 * keyboard closes the visual viewport returns to full height and the inline
 * styles relax back to the CSS `inset: 0`.
 *
 * It also publishes the visible height as `--visual-viewport-height` on the
 * root, which the bottom sheets cap their height by: a sheet lives on <body>,
 * outside the pinned container, and is sized against the viewport.
 *
 * Touch-only: gated on the same `(hover: none) and (pointer: coarse)` query as
 * the touch-composer rules in components/composer.css, so desktop pinch-zoom — which
 * moves the visual viewport — never reshapes the app.
 *
 * `top`/`height` are used rather than a `transform`: a transform on the
 * container would establish a containing block for any `position: fixed`
 * descendant (popups, sheets), re-anchoring them to the container instead of the
 * viewport.
 * @module utils/viewport-fit
 */

import { COARSE_POINTER_QUERY } from './popup-surface.js';

/**
 * Begin pinning `<app-container>` to the visual viewport on touch devices.
 * No-op on non-touch devices or where `visualViewport` is unavailable.
 */
export function initViewportFit() {
  const vv = window.visualViewport;
  if (!vv) return;
  if (!window.matchMedia(COARSE_POINTER_QUERY).matches) return;

  const container = document.querySelector('app-container');
  if (!(container instanceof HTMLElement)) return;

  let raf = 0;
  const apply = () => {
    raf = 0;
    // The height actually visible, keyboard and browser bar off it, for
    // whatever must fit on screen whole: a bottom sheet caps its height by it
    // (components/popup-sheet.css). Published always, not only while shrunk —
    // `vh` overstates the visible height whenever the browser bar shows.
    document.documentElement.style.setProperty('--visual-viewport-height', `${vv.height}px`);
    // Only deviate from the CSS `inset: 0` when the visual viewport is actually
    // smaller than (or pushed down from) the layout viewport — i.e. a keyboard
    // (or other inset) is present. Otherwise clear the inline styles so the
    // resting layout stays purely CSS-driven.
    const shrunk = window.innerHeight - vv.height > 1 || vv.offsetTop > 1;
    if (shrunk) {
      container.style.height = `${vv.height}px`;
      container.style.top = `${vv.offsetTop}px`;
    } else {
      container.style.height = '';
      container.style.top = '';
    }
  };
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(apply);
  };

  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  apply();
}
