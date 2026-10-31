//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Popup Surface — the single authority for presenting a button-anchored popup.
 *
 * The single home for the ~20-line dance every transient surface needs
 * (model/strategy/permission pickers, the commands and at-mention/slash
 * autocompletes, context-add and extension dropdowns): append to <body>, wire
 * dismissal via `registerOpenPopup`, place with `positionDropdown`, run a
 * `MutationObserver` to reposition on content change, then unwind all of it on
 * close.
 *
 * Presentation is chosen from a single media query and is the ONLY place that
 * knows the difference between a desktop dropdown and a phone sheet:
 *   - Wide viewport → anchored dropdown next to the trigger (`positionDropdown`
 *     + the reposition observer).
 *   - Narrow viewport (≤ 36rem) → a bottom sheet. Modal sheets (the pickers)
 *     get a dimmed scrim + grabber and dismiss on scrim-tap / Escape / back;
 *     non-modal sheets (caret autocompletes) dock to the bottom without a scrim
 *     so the textarea behind them keeps focus and the typing that drives them
 *     continues. The class `.popup-sheet` carries every sheet visual in CSS.
 *
 * The narrow/wide decision re-runs if the viewport crosses the breakpoint while
 * the popup is open (rotation, window resize), so an open popup is never left
 * in the wrong presentation.
 * @see web/sdk/lib/dropdown-positioning.js — anchored placement maths.
 * @see web/js/utils/popup-manager.js — `registerOpenPopup` dismissal wiring.
 */

import { positionDropdown } from '../../sdk/lib/dropdown-positioning.js';
import { registerOpenPopup } from './popup-manager.js';
import { attachSwipeDismiss } from './swipe-dismiss.js';

/**
 * Viewport width at or below which popups present as bottom sheets. Matches the
 * phone breakpoint used by the rest of the app, and the `.popup-sheet` CSS
 * block: both are in layout/responsive.css.
 * @type {string}
 */
export const SHEET_QUERY = '(width <= 36rem)';

/**
 * Media query for a touch-first device: no hover and a coarse pointer. The JS
 * twin of the touch rules in components/composer.css and the viewport pinning
 * in utils/viewport-fit.js.
 * @type {string}
 */
export const COARSE_POINTER_QUERY = '(hover: none) and (pointer: coarse)';

/**
 * Event a presented surface dispatches (bubbling) the first time it is placed
 * and made visible — the earliest moment anything inside it can take focus.
 * @type {string}
 */
export const POPUP_REVEALED_EVENT = 'popup-revealed';

/**
 * Present an already-built popup surface and wire everything it needs.
 *
 * Call when the popup OPENS; run the returned `release` exactly once when it
 * closes (idempotent). The surface must NOT already be in the DOM — this owns
 * appending it to <body> and removing it on release.
 * @param {object} opts
 * @param {HTMLElement} opts.surface - The popup element to present (detached).
 * @param {HTMLElement} opts.anchor - The trigger element it anchors to (wide).
 * @param {string} opts.id - Unique popup id for mutual exclusion.
 * @param {() => void} opts.onClose - Idempotent close callback.
 * @param {'left'|'right'} [opts.align='left'] - Anchored horizontal alignment.
 * @param {number} [opts.gap=8] - Gap (px) between anchor and dropdown (wide).
 * @param {string[]} [opts.insideSelectors] - Selectors whose subtree counts as
 *   "inside" for outside-click dismissal. Omit for surfaces that keep the
 *   textarea focused (autocompletes) or do their own outside handling.
 * @param {boolean} [opts.reposition=true] - Observe content changes and
 *   reposition while anchored (wide only).
 * @param {boolean} [opts.modal=true] - Sheet flavour on narrow screens: modal
 *   (scrim + grabber, scrim-tap dismisses) or non-modal (docked, no scrim,
 *   does not steal focus). Ignored while anchored.
 * @param {boolean} [opts.nested=false] - Opened from a control inside another
 *   open popup: it does not announce itself, so that popup stays open (see
 *   `registerOpenPopup`).
 * @param {boolean} [opts.restoreFocus=true] - On release, return focus to the
 *   control focused before opening when focus is on <body> or inside the
 *   surface. Off for a surface that never takes focus and is closed because
 *   its field was left: refocusing the field would only reopen it.
 * @param {boolean} [opts.followAnchor=false] - Re-place the surface while
 *   anchored whenever anything scrolls or the window resizes, for an anchor
 *   that sits inside a scrolling box and moves while the surface is open.
 * @returns {() => void} release - Tears down surface, scrim, observer, media
 *   listener and dismissal wiring. Idempotent.
 */
export function presentPopup({
  surface,
  anchor,
  id,
  onClose,
  align = 'left',
  gap = 8,
  insideSelectors,
  reposition = true,
  modal = true,
  nested = false,
  restoreFocus: restoreFocusOnRelease = true,
  followAnchor = false,
}) {
  const focusedBeforeOpen = document.activeElement;
  const returnFocus = focusedBeforeOpen instanceof HTMLElement
    && focusedBeforeOpen !== document.body
    ? focusedBeforeOpen
    : anchor;

  // Hide until first placed. The surface's base `.dropdown-menu` rule pins it
  // to a default top-left corner; appending it now and positioning a frame
  // later (in the rAF below) would paint one frame at that corner before the
  // jump. `visibility: hidden` keeps it laid out and measurable — so
  // positionDropdown can still read its dimensions — without painting it.
  surface.style.visibility = 'hidden';
  document.body.appendChild(surface);

  // Mutual exclusion + Escape + open-state (+ optional outside-click). In sheet
  // mode the scrim is the visible outside target, but the same selector-based
  // handler still resolves taps on it to "outside", so one path serves both.
  const releaseDismiss = registerOpenPopup({ id, onClose, insideSelectors, nested });

  /** @type {HTMLElement|null} */
  let scrim = null;
  /** @type {MutationObserver|null} */
  let observer = null;
  /** @type {HTMLElement|null} Drag handle injected at the top of a modal sheet. */
  let grabber = null;
  /** @type {(() => void)|null} Detaches the grabber's drag, while there is one. */
  let detachGrabberDrag = null;

  const reposToAnchor = () => positionDropdown(surface, anchor, gap, { align });

  // --- Bottom-sheet drag-to-dismiss ---------------------------------------
  // The grabber affords the idiomatic grab-and-drag-down gesture: the sheet
  // tracks the finger down and dismisses once dragged past the threshold,
  // snapping back otherwise. It is the vertical case of `attachSwipeDismiss`,
  // shared with the sidebar drawer and the pinboard panel.
  //
  // The gesture is taken on the grabber rather than on the sheet, and the
  // grabber sets `touch-action: none`, so nothing else is ever competing for it:
  // it claims the first movement outright, with no axis to win and no scroll
  // position to sniff.
  /** Distance (px) past which releasing the drag dismisses the sheet. */
  const SHEET_DISMISS_PX = 90;

  const addGrabber = () => {
    if (grabber) return;
    grabber = document.createElement('div');
    grabber.className = 'popup-sheet-grabber';
    surface.insertBefore(grabber, surface.firstChild);
    detachGrabberDrag = attachSwipeDismiss(grabber, {
      direction: 'down',
      surface,
      thresholdPx: SHEET_DISMISS_PX,
      claim: 'immediate',
      allowMouse: true,
      onDismiss: onClose,
    });
  };
  const removeGrabber = () => {
    if (!grabber) return;
    // Detaching first: it drops any inline transform of its own, including one
    // left by a drag still in progress when the sheet was taken away.
    detachGrabberDrag?.();
    detachGrabberDrag = null;
    grabber.remove();
    grabber = null;
    surface.style.removeProperty('transition');
    surface.style.removeProperty('transform');
  };

  const applyAnchored = () => {
    surface.classList.remove('popup-sheet', 'popup-sheet-modal');
    removeGrabber();
    if (scrim) {
      scrim.remove();
      scrim = null;
    }
    reposToAnchor();
    if (reposition && !observer) {
      observer = new MutationObserver(reposToAnchor);
      observer.observe(surface, { childList: true, subtree: true, characterData: true });
    }
  };

  const applySheet = () => {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    // Drop the anchored inline geometry so the CSS sheet rules govern fully.
    surface.style.removeProperty('--dropdown-x');
    surface.style.removeProperty('--dropdown-y');
    surface.style.removeProperty('max-height');
    surface.classList.add('popup-sheet');
    surface.classList.toggle('popup-sheet-modal', modal);
    // Only modal sheets get the drag handle. Non-modal docked autocompletes
    // (@-mention, slash) are driven by typing and dismissed by the textarea,
    // never by a drag, so a grabber there would be misleading.
    if (modal) {
      addGrabber();
      if (!scrim) {
        scrim = document.createElement('div');
        scrim.className = 'popup-sheet-scrim';
        scrim.addEventListener('click', () => onClose());
        document.body.appendChild(scrim);
      }
    }
  };

  let revealed = false;
  const apply = () => {
    if (mql.matches) applySheet(); else applyAnchored();
    // Placed — reveal it. Harmless to repeat on a breakpoint-crossing re-apply.
    surface.style.removeProperty('visibility');
    // Until now nothing inside could take focus; say so once, for a menu that
    // moves focus in on a keyboard open (utils/menu-roles.js).
    if (!revealed) {
      revealed = true;
      surface.dispatchEvent(new Event(POPUP_REVEALED_EVENT, { bubbles: true }));
    }
  };

  const mql = window.matchMedia(SHEET_QUERY);
  mql.addEventListener('change', apply);

  // A sheet ignores its anchor, so only an anchored surface follows it.
  // `scroll` is captured at the window to hear a scroll in any ancestor box.
  const follow = () => { if (!mql.matches) reposToAnchor(); };
  if (followAnchor) {
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
  }

  // Position after layout so the surface has measurable dimensions. The handle
  // is kept so a release arriving before that frame runs can cancel it —
  // otherwise the placement would fire against a surface already torn down and,
  // in sheet mode, hang a fresh scrim over the page with nothing left to remove
  // it.
  const placementFrame = requestAnimationFrame(apply);

  return () => {
    const focused = document.activeElement;
    const restoreFocus = restoreFocusOnRelease && (focused === null
      || focused === document.body
      || (focused instanceof Node && surface.contains(focused)));

    cancelAnimationFrame(placementFrame);
    mql.removeEventListener('change', apply);
    if (followAnchor) {
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
    }
    if (observer) observer.disconnect();
    if (scrim) scrim.remove();
    // Detach before the surface goes: a sheet dismissed by its own drag is torn
    // down from inside that drag, which still has document listeners out.
    removeGrabber();
    surface.remove();
    releaseDismiss();

    // A popup may take focus with it when it closes. Return that focus to the
    // control used before it opened, but leave a deliberately focused outside
    // control alone.
    if (restoreFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
  };
}

/**
 * A presented inline menu. `surface` is the element now hosted on `<body>` —
 * null before the deferred presentation has run and after `close()`, so a
 * component's in-place refresh path can test it to decide between updating the
 * live menu and re-rendering its own subtree.
 * @typedef {object} InlineMenu
 * @property {HTMLElement|null} surface - The live, relocated surface, or null.
 * @property {() => void} close - Cancel a pending presentation or tear down a
 *   live one. Idempotent.
 */

/**
 * Present a menu a component rendered inside its OWN subtree, relocating it to
 * `<body>` on the next frame.
 *
 * The dropdown selectors (model, strategy, permissions) render their menu as
 * part of `render()` and then hand it to `presentPopup`, which must wait a frame
 * for the markup to lay out. That deferral is the whole difficulty, and it has
 * bitten three times: a component that re-renders — or closes — between
 * scheduling the frame and the frame running leaves the callback holding
 * detached nodes, and presenting those puts a second, unanchored menu on
 * `<body>` that nothing can close. So this owns the frame handle as well as the
 * popup release, cancels the frame on close, and looks the nodes up INSIDE the
 * frame rather than capturing them at schedule time (a re-render between the
 * two then yields the new menu instead of a stale one). A close landing during
 * the presentation itself — while `presentPopup` is on the stack and there is
 * no release yet — is honoured the moment there is something to tear down.
 *
 * The popup id, the marker attribute and the outside-click selectors are all
 * derived from the host's tag name, so the three can't drift apart: a menu is
 * "inside" its own host element or its own marked surface, and one host type
 * owns at most one open menu (`presentPopup`'s id-based mutual exclusion).
 * @param {object} opts
 * @param {HTMLElement} opts.host - The custom element that rendered the menu.
 * @param {string} opts.surfaceSelector - Selector for the menu within `host`.
 * @param {string} opts.anchorSelector - Selector for the trigger within `host`.
 * @param {() => void} opts.onClose - Called when the popup dismisses itself.
 * @param {'left'|'right'} [opts.align='left'] - Anchored horizontal alignment.
 * @param {(surface: HTMLElement) => void} [opts.onPresent] - Run against the
 *   surface just before it is relocated (e.g. attach a delegated listener).
 * @returns {InlineMenu} Handle owning the pending frame and the popup release.
 */
export function presentInlineMenu({ host, surfaceSelector, anchorSelector, onClose, align = 'left', onPresent }) {
  const marker = `data-${host.localName}`;
  /** @type {number|null} */
  let frame = null;
  /** @type {(() => void)|null} */
  let release = null;
  /** @type {HTMLElement|null} */
  let live = null;
  let cancelled = false;

  frame = requestAnimationFrame(() => {
    frame = null;
    if (cancelled) return;
    const surface = /** @type {HTMLElement|null} */ (host.querySelector(surfaceSelector));
    const anchor = /** @type {HTMLElement|null} */ (host.querySelector(anchorSelector));
    if (!surface || !anchor) return;
    surface.setAttribute(marker, 'true');
    live = surface;
    onPresent?.(surface);
    const presented = presentPopup({
      surface,
      anchor,
      id: host.localName,
      onClose,
      align,
      insideSelectors: [host.localName, `${surfaceSelector}[${marker}="true"]`],
    });
    // A close can arrive DURING presentPopup, before it has returned anything to
    // own: it announces itself to the popup manager from inside that call, and a
    // popup closing in response can synchronously close this one too (by
    // re-parenting the host, say, since a re-parent disconnects it). Such a close finds `frame` already null and `release`
    // still null, so it can only set the flag; honouring it here is what stops
    // the teardown being stranded on a handle the host has already dropped —
    // which left the surface and its scrim on <body> with nothing able to
    // remove them.
    if (cancelled) {
      presented();
      live = null;
      return;
    }
    release = presented;
  });

  return {
    get surface() {
      return live;
    },
    close() {
      cancelled = true;
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      if (release) {
        release();
        release = null;
      }
      live = null;
    },
  };
}
