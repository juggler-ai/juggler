//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Push an overlay off the screen with a finger. Shared by every surface a phone
 * puts over the page: the conversation drawer swipes left, the pinboard panel
 * swipes right, a bottom sheet is dragged down by its grabber. They differ in
 * which way they leave and what else is competing for the gesture, and in
 * nothing else — so they go away the same way, and there is one place to fix it
 * when a browser disagrees about who owns a touch.
 *
 * The surface tracks the finger 1:1 and, released past the threshold, dismisses;
 * anything short snaps back. The transform is inline only while the finger is
 * down — dropping it hands the surface back to its CSS transition, which glides
 * it home or the rest of the way out once the caller's `onDismiss` takes the
 * open class off.
 *
 * A mouse never swipes a whole surface. Each of them has a scrim, an Escape and
 * a button, and inside them a mouse drag already means something else (selecting
 * text, reordering a tab) — so a surface-wide gesture is touch and pen only. A
 * dedicated handle has no such ambiguity and takes a mouse too (`allowMouse`).
 *
 * Two rules decide whether the gesture is ours, and both matter on a surface
 * with scrolling content:
 *
 *   The first decisive movement claims an axis and keeps it. A drag down the
 *   drawer is the tab list scrolling, and once released the pointer is dropped
 *   for good rather than reconsidered as the finger travels.
 *
 *   On a surface that asks for it, a drag starting over something which can
 *   still scroll the way the finger is going belongs to that scroller. The
 *   pinboard's content is a two-axis scroll box whose commonest occupant is a
 *   code block wider than a phone: a rightward drag there is the reader
 *   scrolling back to the left margin, right up until the margin is reached, and
 *   only then the board leaving. That is the same handoff a nested scroller gets
 *   natively, and the panel needs it stated because it cannot declare
 *   `touch-action: pan-y` the way the drawer does — that would forbid horizontal
 *   panning for everything inside it. A surface whose `touch-action` already
 *   forbids panning on the swipe axis leaves it off: there is no native scroll
 *   to defer to, so deferring would only lose the gesture to a scroll box that
 *   was never going to move.
 *
 * `touch-action` alone would not hold the gesture anyway. A real finger drifts
 * across its own axis, and a browser is entitled to read that drift as the start
 * of a scroll — which cancels the pointer and leaves the surface springing back
 * mid-swipe. Cancelling the touchmove once the swipe owns the gesture is what
 * actually holds it, and the listener is registered up front and non-passive
 * because a browser decides whether a touch can be blocked when the finger
 * lands, not once it has moved.
 * @module utils/swipe-dismiss
 */

/** Movement (px) before a drag commits to an axis. */
const DEFAULT_SLOP_PX = 10;

/** How far past the release the click a swipe leaves behind is swallowed. */
const CLICK_SWALLOW_MS = 100;

/**
 * How much a box must have left to scroll before the gesture is conceded to it.
 * A hair of sub-pixel overflow — padding plus rounding — is not a reader with
 * somewhere to go.
 */
const SCROLL_ROOM_MIN_PX = 4;

/**
 * Which way a surface leaves, as the axis it travels and the sign of that
 * travel. `translateX`/`translateY` and the scroll handoff both read off this.
 * @type {Record<'left'|'right'|'up'|'down', {axis: 'x'|'y', sign: 1|-1}>}
 */
const DIRECTIONS = {
  left: { axis: 'x', sign: -1 },
  right: { axis: 'x', sign: 1 },
  up: { axis: 'y', sign: -1 },
  down: { axis: 'y', sign: 1 },
};

/**
 * @typedef {object} SwipeDismissOptions
 * @property {'left'|'right'|'up'|'down'} direction - Which way the surface leaves.
 * @property {() => void} onDismiss - Called when a swipe finishes past the threshold.
 * @property {number} thresholdPx - How far the surface must travel to dismiss on release.
 * @property {HTMLElement} [surface] - The element that moves. Defaults to the element listened on; give it when the grab handle is not the surface.
 * @property {() => boolean} [isActive] - Whether the surface is currently dismissible. Called on every press, so it can read live layout, and again when the drag would claim its axis, so something that took the pointer in between (a row lifted for a reorder) keeps it. Default always.
 * @property {number} [slopPx] - Movement before the drag commits to an axis. Ignored when `claim` is `'immediate'`.
 * @property {'axis'|'immediate'} [claim] - How the gesture is won: `'axis'` (default) waits out the slop and takes only a decisive move along `direction`; `'immediate'` takes the first move, for a dedicated handle that nothing else competes for.
 * @property {string} [exclude] - Selector for descendants whose drags belong to them — resize grips, drag handles, inline editors.
 * @property {boolean} [yieldToScroll] - Concede a press that lands on a descendant with room to scroll the dismissing way. For a surface that permits native panning on the swipe axis; default false.
 * @property {boolean} [allowMouse] - Take mouse drags as well as touch and pen. For a dedicated handle, where a drag can mean nothing else; default false.
 */

/**
 * Let a surface be swiped away.
 * @param {HTMLElement} element - The element the gesture is taken on: the whole surface, or the handle that drags it.
 * @param {SwipeDismissOptions} options - Which way it goes, and who else wants the gesture.
 * @returns {() => void} Detach. Safe to call mid-drag, and idempotent.
 */
export function attachSwipeDismiss(element, options) {
  const {
    direction,
    onDismiss,
    thresholdPx,
    surface = element,
    isActive = () => true,
    slopPx = DEFAULT_SLOP_PX,
    claim = 'axis',
    exclude = '',
    yieldToScroll = false,
    allowMouse = false,
  } = options;
  const { axis, sign } = DIRECTIONS[direction];

  /** @type {number|null} The pointer being tracked, if any. */
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  /** Travel along the axis, in the dismissing direction and never behind it. */
  let travel = 0;
  /** Whether the drag has won its axis and owns the transform. */
  let swiping = false;
  /** Set briefly after a real swipe, to swallow the click it leaves behind. */
  let swipeJustOccurred = false;

  /** Drop the tracked pointer and hand the transform back to CSS. */
  const release = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onCancel);
    pointerId = null;
    swiping = false;
    travel = 0;
    surface.style.removeProperty('transition');
    surface.style.removeProperty('transform');
  };

  /**
   * Whether something between the finger and the surface can still scroll the
   * way the finger is going, and so has the better claim on this gesture.
   * @param {HTMLElement|null} target - Where the pointer went down.
   * @returns {boolean} Whether to leave the gesture alone.
   */
  const scrollerWantsIt = (target) => {
    for (let node = target; node && node !== element; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      const overflow = axis === 'x' ? style.overflowX : style.overflowY;
      if (overflow !== 'auto' && overflow !== 'scroll') continue;
      const position = axis === 'x' ? node.scrollLeft : node.scrollTop;
      const extent = axis === 'x'
        ? node.scrollWidth - node.clientWidth
        : node.scrollHeight - node.clientHeight;
      // A finger moving the dismissing way drags the content with it, which
      // moves the box's own viewport the other way. So a leftward or upward
      // swipe has somewhere to go while content remains past the far edge, and
      // a rightward or downward one while the box is scrolled off its start.
      const room = sign < 0 ? extent - position : position;
      if (room > SCROLL_ROOM_MIN_PX) return true;
    }
    return false;
  };

  /** @param {Event} ev */
  const onMove = (ev) => {
    const e = /** @type {PointerEvent} */ (ev);
    if (e.pointerId !== pointerId) return;
    const moveX = e.clientX - startX;
    const moveY = e.clientY - startY;
    const along = axis === 'x' ? moveX : moveY;
    const across = axis === 'x' ? moveY : moveX;
    if (!swiping) {
      if (claim === 'axis') {
        if (Math.abs(along) < slopPx && Math.abs(across) < slopPx) return;
        // Anything but a decisive move the dismissing way is someone else's
        // gesture — a scroll, a tap that wandered — so the pointer is dropped
        // for good rather than reconsidered as the finger travels.
        if (sign * along <= Math.abs(across)) {
          release();
          return;
        }
      }
      // Asked again at the claim: a press that began dismissible can have been
      // taken since by something else on the surface.
      if (!isActive()) {
        release();
        return;
      }
      swiping = true;
      surface.style.transition = 'none'; // track the finger 1:1
    }
    travel = Math.max(0, sign * along);
    surface.style.transform = axis === 'x'
      ? `translateX(${sign * travel}px)`
      : `translateY(${sign * travel}px)`;
  };

  /**
   * End the gesture: dismiss if it travelled far enough, snap back otherwise.
   * @param {boolean} leavesClick - Whether a click will follow. A finger lifted
   *   off a control leaves one; a cancelled gesture doesn't.
   */
  const finish = (leavesClick) => {
    const dismiss = swiping && travel >= thresholdPx;
    if (swiping && leavesClick) {
      swipeJustOccurred = true;
      setTimeout(() => { swipeJustOccurred = false; }, CLICK_SWALLOW_MS);
    }
    release();
    if (dismiss) onDismiss();
  };

  /** @param {Event} ev */
  const onUp = (ev) => {
    if (/** @type {PointerEvent} */ (ev).pointerId === pointerId) finish(true);
  };

  /** @param {Event} ev */
  const onCancel = (ev) => {
    // Something upstream took the touch. Past the threshold the intent was
    // already unambiguous, so honour it rather than springing back.
    if (/** @type {PointerEvent} */ (ev).pointerId === pointerId) finish(false);
  };

  /** @param {Event} ev */
  const onTouchMove = (ev) => {
    if (swiping) ev.preventDefault();
  };

  /** @param {Event} ev */
  const onDown = (ev) => {
    const e = /** @type {PointerEvent} */ (ev);
    if (pointerId !== null || !isActive()) return;
    if (e.pointerType === 'mouse' && !allowMouse) return;
    const target = /** @type {HTMLElement|null} */ (e.target);
    if (exclude && target?.closest(exclude)) return;
    if (yieldToScroll && scrollerWantsIt(target)) return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    travel = 0;
    // Track on the document: a re-render mid-drag would take the pointerdown
    // target — and with it the implicit touch capture — out of the DOM,
    // stranding the gesture. Tab-reorder drags listen there too.
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
  };

  // A swipe leaves behind a click on whatever it started over, which would do
  // whatever that thing does on the way out. Swallow that one click. Document
  // capture runs before any listener inside the surface whatever the order they
  // were added in; the window matches the equivalent guard on reorder drags
  // (`_dragJustOccurred` in conversation-bar.js).
  /** @param {Event} ev */
  const onClickCapture = (ev) => {
    if (!swipeJustOccurred) return;
    ev.stopPropagation();
    ev.preventDefault();
  };

  element.addEventListener('pointerdown', onDown);
  element.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('click', onClickCapture, true);

  return () => {
    release();
    swipeJustOccurred = false;
    element.removeEventListener('pointerdown', onDown);
    element.removeEventListener('touchmove', onTouchMove);
    document.removeEventListener('click', onClickCapture, true);
  };
}
