//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Popup Manager - Coordinates popup/dropdown closing across components
 *
 * When a popup opens, it should call `notifyPopupOpen()` which broadcasts
 * a 'popup-opened' event. Other popups listen for this event and close themselves.
 *
 * Both the Escape key and the browser/mobile Back button dismiss every open
 * overlay via `closeAllPopups()` — dropdowns/menus react to the emitted
 * 'popup-close-all' event, while modals register a close handler with
 * `markPopupOpen(onClose)`. A single sentinel history entry is pushed while any
 * overlay is open so one Back press clears the whole layer (see the Back-button
 * integration block at the foot of this file).
 *
 * Usage (dropdowns/menus that want mutual exclusion + Escape-to-close):
 * 1. Import: `import { notifyPopupOpen, onOtherPopupOpened } from './popup-manager.js';`
 * 2. When opening a popup: `notifyPopupOpen('my-popup-id');`
 * 3. ON OPEN, register: `this._cleanup = onOtherPopupOpened('my-popup-id', () => closeMyPopup())`
 *    - Closes this popup when another opens, and on Escape.
 *    - Also marks a popup open for `isAnyPopupOpen()` (see below) for the
 *      registration's lifetime, so register on OPEN and run the returned
 *      cleanup on CLOSE — NOT at mount/disconnect.
 *
 * Open-state (`markPopupOpen`/`isAnyPopupOpen`) is the single source of truth
 * for "is something overlaying the page right now". The message input reads it
 * so a popup-dismissing Escape doesn't also cancel a running turn. Modals and
 * context menus call `markPopupOpen(onClose)` directly on open instead of
 * `onOtherPopupOpened`, passing a handler so `closeAllPopups()` can dismiss
 * them too.
 */

/**
 * Event name for popup opened notifications
 * @type {string}
 */
const POPUP_OPENED_EVENT = 'popup-opened';

/**
 * Event name for close-all-popups notifications
 * @type {string}
 */
const POPUP_CLOSE_ALL_EVENT = 'popup-close-all';

/**
 * The currently-open popups/modals, each token → its optional close handler. A
 * popup is open from the moment it acquires a token until it releases it. Lets
 * unrelated components (e.g. the composer) tell whether an Escape keypress is
 * meant to dismiss a popup rather than act on the input behind it. A Map (not a
 * Set) so `closeAllPopups()` can drive each surface's own dismissal — and in
 * LIFO order, since insertion order is preserved.
 * @type {Map<number, (() => void)|null>}
 */
const openPopups = new Map();
let nextPopupToken = 0;

/**
 * Mark a popup/modal as open. Returns a release function to call exactly once
 * when it closes; the release is idempotent, so calling it twice is harmless.
 *
 * Pass `onClose` to opt this surface into unified dismissal: `closeAllPopups()`
 * (which both Escape and the mobile/browser Back button route through) will call
 * it. Dropdowns/menus that dismiss via the `POPUP_CLOSE_ALL` event instead pass
 * nothing.
 * @param {() => void} [onClose] - Idempotent handler that closes this surface.
 * @returns {() => void} Release function that marks the popup closed.
 */
export function markPopupOpen(onClose) {
  const token = nextPopupToken++;
  openPopups.set(token, onClose || null);
  pushOverlayStateIfFirst();
  return () => {
    if (openPopups.delete(token)) releaseOverlayStateIfLast();
  };
}

/**
 * Whether any popup or modal is currently open.
 * @returns {boolean} True if at least one popup/modal is open.
 */
export function isAnyPopupOpen() {
  return openPopups.size > 0;
}

/**
 * Whether any popup/modal is open OTHER than the ones named in `ownIds`. The
 * gate for window-wide shortcuts (the model/thinking cyclers): they must fire
 * over their OWN cycling HUD — which registers as a popup the moment the gesture
 * opens it — while still standing down for any FOREIGN overlay. Two kinds of
 * open popup count as foreign: an id-keyed popup (via {@link registerOpenPopup})
 * whose id is not in `ownIds`, and any id-less popup (a modal registered through
 * {@link markPopupOpen} directly, which has no id to allow-list). Every id-keyed
 * popup adds exactly one entry to both registries, so an `openPopups` count
 * above the id-keyed count means at least one id-less (modal) popup is open too.
 * @param {string[]} [ownIds] - Popup ids that do NOT count as foreign.
 * @returns {boolean} True if a popup outside `ownIds` is open.
 */
export function isForeignPopupOpen(ownIds = []) {
  const own = new Set(ownIds);
  for (const id of openPopupsById.keys()) {
    if (!own.has(id)) return true;
  }
  return openPopups.size > openPopupsById.size;
}

/**
 * TEST-ONLY: force the popup registry back to empty. The multi-iframe test pool
 * reuses one JS realm across the sequence of tests a lane runs, so a prior test
 * that leaked an open-popup registration would otherwise poison this module
 * singleton for the next test — e.g. popup-back-button depends on a clean 0→1
 * baseline because the sentinel push is gated on `openPopups.size === 1`. Not
 * called in production: the app never force-clears popup state (each surface
 * releases its own token on close). Clears the id-map and overlay flags too so
 * the whole module is pristine.
 *
 * The count of self-inflicted history pops still in flight is deliberately NOT
 * cleared: it tracks answers the browser owes us, which no reset can call off.
 * Forgetting one would let a pop from a previous test dismiss this test's
 * overlays — the very race the pool's shared realm makes easy to hit. A stubbed
 * `history.back()` must therefore answer with a `popstate` of its own, as the
 * real API does, or its pop is owed forever. A test that dispatches a synthetic
 * Back press wants that debt settled first: see __settlePopupHistoryForTests.
 */
export function __resetPopupManagerForTests() {
  openPopups.clear();
  openPopupsById.clear();
  overlayStatePushed = false;
  removalScheduled = false;
}

/**
 * TEST-ONLY: wait until the browser has answered every history pop this module
 * asked for, so a test that dispatches a synthetic Back press knows it will be
 * read as one. A pop still owed is consumed rather than treated as a dismissal —
 * correct, and invisible in the app, where the debt is a few milliseconds old and
 * the pop that settles it is genuinely ours. In the pool's shared realm it is a
 * debt one test can run up and the next one pay: whoever dispatches the next
 * `popstate` settles it and gets nothing dismissed.
 *
 * Waits rather than forgets, so a real pop still in flight lands where it
 * belongs; a debt that outlives the budget was owed by something that will never
 * answer (a stubbed `back()`, a traversal with nowhere to go) and is written off.
 * @param {number} [timeoutMs] - How long to wait before writing the debt off.
 * @returns {Promise<void>} Resolves once nothing is owed.
 */
export async function __settlePopupHistoryForTests(timeoutMs = 1000) {
  const until = Date.now() + timeoutMs;
  while (pendingSelfPops > 0 && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  pendingSelfPops = 0;
}

/**
 * Dismiss every open popup/modal. The single "close everything overlaying the
 * page" primitive, routed to by BOTH the Escape key and the browser/mobile Back
 * button. Surfaces that registered an `onClose` with `markPopupOpen` are closed
 * directly, most-recently-opened first (LIFO); dropdowns/menus that wired
 * dismissal through `onOtherPopupOpened` are closed via the `POPUP_CLOSE_ALL`
 * event. The two mechanisms are disjoint, so nothing is closed twice.
 */
export function closeAllPopups() {
  // Snapshot first: each onClose mutates openPopups via its release fn.
  const handlers = [...openPopups.values()].filter(Boolean).reverse();
  for (const onClose of handlers) {
    try {
      /** @type {() => void} */ (onClose)();
    } catch (e) {
      console.error('[PopupManager] close handler failed:', e);
    }
  }
  document.dispatchEvent(new CustomEvent(POPUP_CLOSE_ALL_EVENT));
}

/**
 * The currently-open popup for each id → its close handler. At most ONE entry
 * per id: opening a second popup under an id that's already open closes the
 * first (enforced in registerOpenPopup). This is the single place that makes
 * "you can't stack two of the same popup" true for every caller, instead of
 * each component re-implementing an open-state flag to guard its own button.
 * @type {Map<string, () => void>}
 */
const openPopupsById = new Map();

/**
 * Register `id` as open with its close handler, enforcing one-per-id: if a
 * popup is already open under this id, it is closed first. Returns an unregister
 * fn that only clears the entry if it still points at this handler (so a
 * replacement opened in between is never clobbered).
 * @param {string} id
 * @param {() => void} onClose
 * @returns {() => void} unregister fn that clears this id's entry.
 */
function registerPopupId(id, onClose) {
  const prev = openPopupsById.get(id);
  if (prev && prev !== onClose) prev();
  openPopupsById.set(id, onClose);
  return () => {
    if (openPopupsById.get(id) === onClose) openPopupsById.delete(id);
  };
}

/**
 * Close the open popup with this id, if any. The single shared "toggle off"
 * primitive: a trigger calls this at the top of its open path so a second click
 * dismisses rather than re-opens — no per-component open-state boolean needed.
 * @param {string} id
 * @returns {boolean} true if a popup was open and is now closing.
 */
export function closePopupById(id) {
  const onClose = openPopupsById.get(id);
  if (!onClose) return false;
  onClose();
  return true;
}

/**
 * Notify that a popup has opened, causing other popups to close
 * @param {string} popupId - Unique identifier for the popup that opened
 */
function notifyPopupOpen(popupId) {
  document.dispatchEvent(new CustomEvent(POPUP_OPENED_EVENT, {
    detail: { popupId }
  }));
}

/**
 * Register a handler that will be called when any popup opens OR when Escape is pressed
 * @param {string} ownPopupId - This popup's unique identifier
 * @param {() => void} closeHandler - Callback to close this popup
 * @returns {() => void} Cleanup function to remove the listeners
 */
function onOtherPopupOpened(ownPopupId, closeHandler) {
  // The subscription is registered on open and cleaned up on close, so its
  // lifetime IS the popup's open duration — making this the single place that
  // marks dropdowns/menus open for isAnyPopupOpen(). (Callers MUST register on
  // open, not at mount, or the open-state would stick forever.)
  const releaseOpenState = markPopupOpen();

  /** @param {Event} e */
  const popupHandler = (e) => {
    const event = /** @type {CustomEvent<{popupId: string}>} */(e);
    if (event.detail.popupId !== ownPopupId) {
      closeHandler();
    }
  };

  const closeAllHandler = () => {
    closeHandler();
  };

  document.addEventListener(POPUP_OPENED_EVENT, popupHandler);
  document.addEventListener(POPUP_CLOSE_ALL_EVENT, closeAllHandler);

  return () => {
    releaseOpenState();
    document.removeEventListener(POPUP_OPENED_EVENT, popupHandler);
    document.removeEventListener(POPUP_CLOSE_ALL_EVENT, closeAllHandler);
  };
}

/**
 * Open a transient popup/dropdown and wire its standard dismissal in one call.
 * Call when the popup OPENS; run the returned release exactly once when it
 * closes (typically from your own close() method — the release is idempotent).
 *
 * Centralises everything a button-anchored dropdown needs:
 *   - marks open-state for isAnyPopupOpen(), so an Escape over the message input
 *     dismisses this popup instead of cancelling a running turn;
 *   - mutual exclusion: announces this popup (closing others) and closes itself
 *     when another opens or on Escape;
 *   - optional outside-click dismissal — a click matching none of
 *     `insideSelectors` closes the popup. Omit for popups that keep the message
 *     textarea focused (autocomplete menus) or do their own outside handling.
 * @param {object} opts
 * @param {string} opts.id - Unique popup id (for mutual exclusion).
 * @param {() => void} opts.onClose - Idempotent callback that closes this popup.
 * @param {string[]} [opts.insideSelectors] - CSS selectors whose subtree counts
 *   as "inside". A click matching none of them dismisses the popup. Pass
 *   selectors (not elements): the popup surface is often detached to <body>.
 * @param {boolean} [opts.nested=false] - The popup opens from a control inside
 *   another open popup (a field's completion list in the project picker): it
 *   does not announce itself, so the popup it sits in stays open. It still
 *   closes when another popup opens, and on Escape.
 * @returns {() => void} release - Removes every listener and the open-state.
 */
export function registerOpenPopup({ id, onClose, insideSelectors, nested = false }) {
  // Single-instance: close any popup already open under this id before this one
  // takes its place. Makes stacking structurally impossible for every caller —
  // the behaviour does not depend on each button guarding its own open-state.
  const releaseId = registerPopupId(id, onClose);
  if (!nested) notifyPopupOpen(id);
  const releaseSubscription = onOtherPopupOpened(id, onClose);
  const releaseCore = () => {
    releaseSubscription();
    releaseId();
  };

  if (!insideSelectors || insideSelectors.length === 0) {
    return releaseCore;
  }

  /**
   * @param {Element|null} target
   * @returns {boolean} whether target sits within any "inside" surface
   */
  const isInside = (target) =>
    !!(target && insideSelectors.some((sel) => target.closest?.(sel)));

  // Track where the pressed gesture BEGAN. A native `click` fires on the nearest
  // common ancestor of the mousedown and mouseup targets, so selecting text
  // inside the popup and releasing the button outside it produces a click whose
  // target is <body> — outside every "inside" surface. Keying dismissal off the
  // press location too keeps such a drag-out from closing the popup.
  let pressStartedInside = false;
  /** @param {MouseEvent} e */
  const onPressStart = (e) => {
    pressStartedInside = isInside(/** @type {Element|null} */ (e.target));
  };

  /** @param {MouseEvent} e */
  const onOutsideClick = (e) => {
    const startedInside = pressStartedInside;
    pressStartedInside = false;
    // A click whose target — or whose originating press — is inside any "inside"
    // surface leaves the popup open; closest is absent on non-element targets,
    // so it falls through.
    if (startedInside || isInside(/** @type {Element|null} */ (e.target))) return;
    onClose();
  };
    // Capture phase matches the existing dropdowns: the close listener is added
    // during the opening click's bubble phase, after that click's capture pass
    // has already left document — so it never self-dismisses on the open click.
  document.addEventListener('mousedown', onPressStart, true);
  document.addEventListener('click', onOutsideClick, true);

  return () => {
    releaseCore();
    document.removeEventListener('mousedown', onPressStart, true);
    document.removeEventListener('click', onOutsideClick, true);
  };
}

// ─── Browser / mobile Back-button integration ──────────────────────────────
//
// On mobile the hardware/browser Back button is the instinctive "get rid of
// this" gesture. We make it dismiss whatever overlays the page — without ever
// stealing the Back that navigates away from a clean screen — by pushing ONE
// sentinel history entry while any overlay is open, and treating a `popstate`
// that pops it as a dismissal. One entry per overlay LAYER, not per popup: a
// modal stacked over a menu still costs a single Back press to clear.

const OVERLAY_HISTORY_MARKER = 'jugglerOverlay';

/**
 * Whether a history entry's state carries the overlay sentinel's marker.
 * @param {unknown} state - The entry's `history.state`.
 * @returns {boolean} True when the entry is an overlay sentinel.
 */
function isOverlayState(state) {
  return !!state && typeof state === 'object' && OVERLAY_HISTORY_MARKER in state
    && !!state[OVERLAY_HISTORY_MARKER];
}

/** @type {boolean} Whether our sentinel history entry is currently on top. */
let overlayStatePushed = false;
/** @type {boolean} Whether a deferred sentinel removal is already queued. */
let removalScheduled = false;
/**
 * Sentinel drops we asked for whose `popstate` has not arrived yet.
 *
 * `history.back()` answers in a later task, so the pop it produces is not
 * evidence of a Back press — it is our own retraction reporting in, and the page
 * can have opened another overlay in the meantime. Counted rather than a flag
 * because a rapid open/close/open can leave more than one in flight.
 * @type {number}
 */
let pendingSelfPops = 0;

/**
 * Whether this browsing context takes part in the Back gesture at all — true
 * only where it OWNS the session history, which means only at the top level.
 *
 * An embedded context (an iframe: the test pool's lanes, any future embed)
 * shares one joint session history with the page that framed it and with every
 * sibling frame. A sentinel pushed from here goes onto their stack, so it
 * hijacks the embedder's Back; worse, a `history.back()` any of them makes pops
 * whatever is on top — often ours — and delivers the `popstate` HERE, where
 * nothing distinguishes it from a Back press. The dismissal that follows tears
 * down an overlay this context opened for its own reasons, a millisecond
 * earlier, with nobody having pressed anything. Escape still dismisses.
 * @type {boolean}
 */
let backIntegrationEnabled = typeof window !== 'undefined' && window.top === window;

/**
 * TEST-ONLY: force the Back integration on or off, returning what it was.
 * The pool's lanes are iframes, where it is off, so the suites that test the
 * integration itself switch it on for their own duration.
 * @param {boolean} enabled
 * @returns {boolean} The previous setting, to restore.
 */
export function __setBackIntegrationForTests(enabled) {
  const was = backIntegrationEnabled;
  backIntegrationEnabled = enabled;
  return was;
}

/**
 * Put a sentinel entry on top for the overlay layer, unless one is already there
 * or nothing is open to need it. Pushing also prunes whatever was ahead of the
 * current entry, which is what clears any sentinel a traversal orphaned.
 * @private
 */
function ensureOverlaySentinel() {
  if (!backIntegrationEnabled) return;
  if (openPopups.size === 0 || overlayStatePushed) return;
  try {
    window.history.pushState({ [OVERLAY_HISTORY_MARKER]: true }, '');
    overlayStatePushed = true;
  } catch (e) { /* History API unavailable — Back integration simply off. */ }
}

/**
 * Push the sentinel entry as the overlay layer appears (0 → 1 popups). A second,
 * stacked popup shares the one entry, so only the transition pushes.
 * @private
 */
function pushOverlayStateIfFirst() {
  if (openPopups.size !== 1) return;
  ensureOverlaySentinel();
}

/**
 * Remove the sentinel once the overlay layer is fully gone (→ 0 popups) and it
 * was closed from within the app (button/Escape) rather than by a Back press.
 *
 * Deferred to a macrotask (not just a microtask) so an overlay → overlay
 * transition keeps the single sentinel instead of popping then re-pushing —
 * which would churn history and fire a spurious popstate that tears the new
 * overlay straight back down. The transition can be ASYNC: a confirm dialog
 * whose result opens Settings closes the modal, then resolves its promise
 * several microtasks later before opening the panel. A microtask defer fires
 * `history.back()` inside that gap; a macrotask defer outlasts the whole
 * await-chain microtask drain, so the panel opens (re-incrementing the count)
 * before this re-check runs and finds the layer still occupied.
 * @private
 */
function releaseOverlayStateIfLast() {
  if (!backIntegrationEnabled) return;
  if (openPopups.size > 0 || !overlayStatePushed || removalScheduled) return;
  removalScheduled = true;
  setTimeout(() => {
    removalScheduled = false;
    if (openPopups.size > 0 || !overlayStatePushed) return; // re-opened in the swap
    overlayStatePushed = false;
    pendingSelfPops++;
    try {
      window.history.back();
    } catch (e) {
      pendingSelfPops--; // History API unavailable — nothing will answer.
    }
  }, 0);
}

// A Back press that pops our sentinel while overlays are open IS the dismissal.
// The browser already removed the entry, so clear the flag before closing (so
// the cascade of releases doesn't try to history.back() over it again).
//
// A pop WE asked for is not a Back press, however late it arrives. Between the
// retraction's `history.back()` and its answer the page can have opened another
// overlay, and dismissing on that pop tears down something the user just opened
// — a notice raised moments after a menu closed vanishing before it was read.
// So a pending self-pop is consumed instead, and the sentinel bookkeeping is
// re-derived from where the traversal actually left us rather than assumed: it
// need not be the entry we aimed at, since the target is resolved when the
// traversal is queued and any sentinel pushed in the meantime is jumped over.
// Believing a sentinel is up when it is not is the harmful direction — the next
// Back press would leave the app, and the next retraction would navigate it away
// — so the layer is re-covered when the pop left it bare.
//
// This module is the only thing in the app that touches session history, so
// every popstate is either a Back press or one of ours.
//
// Guarded: this module is transitively imported by context items that load in
// the DOM-less node engine host, where `window` is undefined.
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', (event) => {
    // Not our history, not our gesture: an embedded context reads a pop as the
    // embedder (or a sibling frame) navigating, never as a Back press aimed at
    // an overlay of ours.
    if (!backIntegrationEnabled) return;
    if (pendingSelfPops > 0) {
      pendingSelfPops--;
      // The event carries the state of the entry the traversal landed on — the
      // same thing `history.state` holds, but read from the pop itself, so a
      // stubbed History API is answered by its own stub rather than by whatever
      // the page's real session history happens to be standing on.
      overlayStatePushed = isOverlayState(event.state);
      ensureOverlaySentinel();
      return;
    }
    if (!isAnyPopupOpen()) return;
    overlayStatePushed = false;
    closeAllPopups();
  });
}

// A reload can leave our sentinel as the current entry with nothing actually
// open. Strip the marker so the first Back press navigates normally instead of
// being swallowed dismissing a phantom overlay. Only where the entry can be
// ours: an embedded context pushes none, and must not rewrite an entry belonging
// to the page that framed it.
if (backIntegrationEnabled && typeof window !== 'undefined' && window.history
    && isOverlayState(window.history.state)) {
  try { window.history.replaceState(null, ''); } catch (e) { /* ignore */ }
}

// Global Escape key handler — routes through the same dismissal path as Back.
//
// When a popup owns the Escape, stop the key here so no OTHER document-level
// keydown listener acts on the same press. This module is evaluated at import
// time, so this listener is registered before any runtime-added document
// handler (notably the conversation grid's Escape→cancelLLMOperation in
// conversation-tab.js); without `stopImmediatePropagation`, closeAllPopups()
// would empty the registry and then that later handler — seeing isAnyPopupOpen()
// already false — would go on to interrupt a running turn behind the popup.
// Inner-element handlers (a menu/input's own Escape) fire at the target phase
// before the event ever reaches document, so they are unaffected.
// Guarded like the popstate handler above: `document` is undefined in the
// DOM-less node engine host that imports this module transitively.
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isAnyPopupOpen()) {
      e.stopImmediatePropagation();
      closeAllPopups();
    }
  });
}
