//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Drag one item of a strip to a new place in it. Shared by the conversation
 * sidebar's stacked tabs and the pinboard's wrapping tab strip, which want the
 * same gesture and differ only in geometry.
 *
 * A press becomes a drag only past a threshold, so an ordinary click still does
 * whatever a click does. Past it, the item is replaced in the flow by an
 * invisible placeholder and a clone floats free under the pointer; the
 * remaining items animate into the arrangement the drop would produce, so the
 * strip shows the result rather than a marker predicting it. Release commits
 * once, with where the item landed, and the caller does the editing — a strip
 * is not the place that owns the order.
 *
 * Where a drop lands is read from the items themselves, which is enough for a
 * strip that is one list of them. A strip that is several — the conversation
 * bar draws a list per workspace, boxed, with a gutter round each — has
 * positions inside no list at all, and the nearest item cannot say which list
 * they belong to. That strip passes `dropPlaceAt` and answers from its own
 * geometry instead.
 *
 * The siblings move by FLIP: the placeholder is put where it would land, every
 * item is measured before and after, and each is transformed back to where it
 * was and released. Nothing here computes an offset from a row height, so a
 * strip that wraps is not a special case — an item crossing from the end of one
 * row to the start of the next travels the diagonal it actually travels.
 *
 * A strip of nested lists also has the containers the lists are drawn in, which
 * are not places to drop but are pushed about by every shift all the same. The
 * caller names them (`groups`) and they glide with the items; an item inside
 * one glides only by what it moves within it, since the container's transform
 * already carries it the rest of the way. Both run on one transition, so the
 * two add up to the item's whole journey at every frame of it.
 *
 * Pointer events are taken on the document rather than on the item: a strip
 * that re-renders mid-drag takes the pointerdown target out of the DOM, and
 * with it the implicit capture, stranding the gesture.
 *
 * A finger has no hover and arrives already meaning "scroll", so a strip that
 * offers no grip asks a touch or pen press to HOLD first (the `hold` option).
 * Held still for the hold time it lifts: the clone comes up and the page stops
 * scrolling under it. A finger that moves past the tolerance first was
 * scrolling, and the gesture steps aside before it has touched anything. A lift
 * let go where it was is a long-press, which the strip is told about so it can
 * open a menu. A mouse never holds: it drags past the threshold, as before.
 *
 * Stopping the scroll cannot be done from pointer events at all — panning is
 * not their default action — so it is done by cancelling `touchmove`, from a
 * listener registered when this module loads. WebKit only honours a cancel from
 * a non-passive listener that was in place before the touch began, and only if
 * it cancels the first touchmove that would have scrolled: so while a press is
 * held still, its tremor's touchmoves are cancelled too, and the moment it moves
 * past the tolerance they are not. This is the part a desktop test lane cannot
 * reach — it never scrolls — and is checked on a phone.
 * @module utils/reorder-drag
 */

/** How far a pointer must travel before a press becomes a drag. */
const DEFAULT_THRESHOLD_PX = 5;

/** Held presses still waiting or lifted. While any is, the strip's own menu is not a right-click's. */
let liveHolds = 0;

/** Held presses that have lifted their item and are dragging it. */
let liftedHolds = 0;

/** Gestures that currently own the touch, so the page must not scroll under them. */
let scrollBlockers = 0;

document.addEventListener('touchmove', (e) => {
  if (scrollBlockers > 0 && e.cancelable) e.preventDefault();
}, { passive: false });

/**
 * Whether a held press is in progress — waiting for its hold, or lifted.
 *
 * A long-press is also how Android asks for a context menu, and it would open
 * one over a row the finger is in the middle of lifting. The context-menu
 * service is told to stand down while this is true (see
 * registerContextMenuSuppressor); the strip opens its own menu when a lift is
 * let go where it was.
 * @returns {boolean} True while one is.
 */
export function holdGestureLive() {
  return liveHolds > 0;
}

/**
 * Whether a held press has lifted its item — not merely landed and waiting.
 *
 * What a surface the strip sits on asks before claiming a gesture of its own:
 * a drawer that swipes away must not take a lifted row with it, but must still
 * swipe from a press that has not lifted, which is every press until it has.
 * @returns {boolean} True while one has.
 */
export function holdLifted() {
  return liftedHolds > 0;
}

/** How close to an edge the pointer must be for the strip to scroll itself. */
const EDGE_HOTZONE_PX = 30;

/** The fastest one frame of edge-scrolling may travel. */
const MAX_SCROLL_STEP_PX = 18;

/**
 * Only auto-scroll a genuinely overflowing strip. A hair of sub-pixel overflow
 * (bottom padding plus rounding) must not make a fully-fitting one creep while
 * you drag near its edge.
 */
const SCROLL_OVERFLOW_MIN_PX = 4;

/** Groups a shift has set gliding, whose transforms {@link settledRect} takes out of what is inside them. */
const glided = new WeakSet();

/**
 * An element's box where the layout has it, with whatever transform it is
 * moving under taken back out.
 *
 * The strip is rearranged by FLIP: each item is inverted to where it was and
 * released to animate to where it now is, so for the length of that animation
 * `getBoundingClientRect` answers with a position between the two. A drop read
 * from that is a drop read against the strip the user has stopped looking at,
 * and the answer is a whole slot out — which is most of a gesture, since a
 * pointer reports faster than the animation finishes and every shift starts
 * another one.
 *
 * The same goes for a group the element is drawn inside: its glide carries
 * everything in it. So the element's own translation is taken out, and so is
 * that of every ancestor a shift has set gliding — and no other ancestor's,
 * since a transform this module did not apply (a drawer sliding the whole
 * sidebar) moves the pointer's target along with it and is part of the answer.
 *
 * Only the translation is taken back out, translation being all that is ever
 * applied here.
 * @param {Element} element - The element to measure.
 * @returns {DOMRect} Its box where the layout puts it, animation or no animation.
 */
export function settledRect(element) {
  const rect = element.getBoundingClientRect();
  let dx = 0;
  let dy = 0;
  for (let el = /** @type {Element|null} */ (element); el; el = el.parentElement) {
    if (el !== element && !glided.has(el)) continue;
    const { transform } = getComputedStyle(el);
    if (!transform || transform === 'none') continue;
    const m = new DOMMatrixReadOnly(transform);
    dx += m.e;
    dy += m.f;
  }
  if (!dx && !dy) return rect;
  return new DOMRect(rect.left - dx, rect.top - dy, rect.width, rect.height);
}

/**
 * @typedef {object} ReorderDragOptions
 * @property {HTMLElement} item - The element being dragged.
 * @property {() => HTMLElement[]} items - The reorderable items, in strip order. Called live, and must exclude the floating clone. They need not share a parent: a strip built from nested lists is read as one sequence, and the item lands in the list its new neighbour is in.
 * @property {() => HTMLElement[]} [groups] - Containers the items are drawn inside that are not places to drop but are moved by a shift — a box round a nested list. Called live. They glide with the items rather than jumping, and the stylesheet's transition must cover them with the items' own timing.
 * @property {HTMLElement} [captureTarget] - Which element takes the pointer. Must be the one carrying the click handler. Defaults to the item.
 * @property {HTMLElement|null} [strip] - The element holding the items, marked while a drag is live so a stylesheet can gate its transitions. Defaults to the item's parent, which is only right for a flat strip: where the items live in nested lists, name the element the stylesheet looks for.
 * @property {HTMLElement} [ghostHost] - Where the clone is parked. Defaults to the item's parent; give a host outside any clipping scroll box.
 * @property {HTMLElement|null} [scrollContainer] - The strip's scroll box, for edge auto-scrolling. Omit for a strip that does not scroll.
 * @property {'x'|'y'|'xy'} [axis] - Which way the clone follows the pointer, and which distance arms the threshold. Default `'y'`.
 * @property {boolean} [wrap] - Whether the strip wraps onto more than one row, which decides how a drop position is read. Default `false`.
 * @property {boolean} [readCentre] - Read the drop from the middle of the clone rather than from the pointer, along the axes it travels, so that where the item was picked up does not move where it lands. Default `false`.
 * @property {(clientX: number, clientY: number) => {parent: HTMLElement|null, anchor: Element|null}|null} [dropPlaceAt] - Where a pointer here would drop, for a strip the items alone do not describe: nested lists the pointer is inside or outside of, or slots that are not items. Returning null falls back to reading the items along the axis, which is also what happens when this is not given.
 * @property {number} [thresholdPx] - How far to move before this is a drag.
 * @property {{ghost?: string, source?: string, dragging?: string}} [classes] - Class for the clone, for the placeholder left behind, and for the strip while a drag is live.
 * @property {(clone: HTMLElement) => void} [prepareGhost] - Scrub the clone before it is shown — identity attributes, transient state.
 * @property {(detail: {item: HTMLElement, fromIndex: number, toIndex: number, parent: HTMLElement|null, anchor: Element|null}) => void} [onCommit] - The drop landed somewhere new. `toIndex` indexes the strip WITHOUT the dragged item; a strip of nested lists should read `anchor` instead, which names what the item landed in front of — null for the end of `parent`.
 * @property {{ms: number, tolerancePx: number, onHeldRelease?: (point: {clientX: number, clientY: number}) => void}} [hold] - For a touch or pen press: how long it must be held still before it lifts, how far it may stray meanwhile before it is taken for a scroll, and what to do when a lift is let go where it was. A hold of 0 lifts at the press. Ignored for a mouse.
 * @property {() => void} [onDragStart] - The threshold was passed, or the hold lifted the item.
 * @property {(detail: {dragged: boolean, moved: boolean}) => void} [onDragEnd] - The gesture is over: whether it ever became a drag, and whether it committed.
 */

/**
 * @typedef {object} ReorderDragHandle
 * @property {() => boolean} isActive - Whether the threshold has been passed and a drag is live.
 * @property {() => void} cancel - Abandon the gesture, committing nothing.
 */

/**
 * Begin a reorder gesture from a pointerdown.
 *
 * The caller decides what counts as a grab — which button, which descendants
 * are excluded, whether touch needs a handle — and calls this once it has.
 * @param {PointerEvent} event - The pointerdown that started it.
 * @param {ReorderDragOptions} options - The strip, and what to do with the result.
 * @returns {ReorderDragHandle} A handle on the gesture.
 */
export function startReorderDrag(event, options) {
  const {
    item,
    items,
    groups,
    captureTarget = item,
    strip = /** @type {HTMLElement} */ (item.parentElement),
    ghostHost = /** @type {HTMLElement} */ (item.parentElement),
    scrollContainer = null,
    axis = 'y',
    wrap = false,
    readCentre = false,
    dropPlaceAt,
    thresholdPx = DEFAULT_THRESHOLD_PX,
    hold,
    classes = {},
    prepareGhost,
    onCommit,
    onDragStart,
    onDragEnd,
  } = options;

  const ghostClass = classes.ghost || 'drag-ghost';
  const sourceClass = classes.source || 'drag-source';
  const draggingClass = classes.dragging || 'is-dragging';

  const startOrder = items();
  const fromIndex = startOrder.indexOf(item);

  /**
   * @typedef {object} DropPlace
   * @property {HTMLElement|null} parent - The list the item would land in.
   * @property {Element|null} anchor - What it would land in front of, or null for the end of that list.
   */

  /** Where the drop last read, as an index into the strip without the item. Reported to the caller. */
  let dropIndex = fromIndex < 0 ? 0 : fromIndex;

  /**
   * Where the placeholder actually is. An index is not enough to say: a strip
   * of nested lists puts the same index in two different lists — the slot in
   * front of an empty list's last line and the slot at the end of the list
   * before it are one position apart in the reading order and no positions
   * apart in the count — and the whole point of the drag is which list the
   * item ends up in.
   * @type {DropPlace}
   */
  let placed = { parent: item.parentElement, anchor: item.nextElementSibling };

  /**
   * Where it began, so that a drop back into its own slot is not a move.
   * @type {DropPlace}
   */
  const home = placed;

  let active = false;
  let finished = false;
  /** @type {HTMLElement|null} */
  let ghost = null;
  /** @type {number|null} */
  let autoScrollRaf = null;
  let lastClientX = event.clientX;
  let lastClientY = event.clientY;
  /** From the pointer to the middle of the clone, for `readCentre`; set when the clone is made. */
  let centreOffsetX = 0;
  let centreOffsetY = 0;

  // The hold. `pending` is a press waiting to lift; `lifted` is one that has.
  const holding = !!hold && (event.pointerType === 'touch' || event.pointerType === 'pen');
  let pending = holding;
  let lifted = false;
  /** How far the pointer has strayed from the press, at most. */
  let travelled = 0;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let holdTimer = null;
  let blocking = false;

  /** @param {boolean} on - Whether this gesture owns the touch. */
  const blockScroll = (on) => {
    if (on === blocking) return;
    blocking = on;
    scrollBlockers += on ? 1 : -1;
  };

  // Where the placeholder goes back to if the gesture is abandoned.
  const homeParent = item.parentElement;
  const homeNext = item.nextSibling;

  /**
   * Take the pointer for the rest of the gesture.
   *
   * Capture retargets the release, and the click the browser fires afterwards
   * goes to the common ancestor of the press and the release — so capture taken
   * anywhere but the element carrying the click handler puts that click out of
   * its reach. Hence `captureTarget`, which for a strip whose item is a wrapper
   * around the clickable thing is not the item.
   *
   * It is taken at the threshold rather than at the press for the same reason
   * the DOM is left alone below it: a press that stays a click must leave no
   * trace for the click to trip over. Nothing here depends on holding it — the
   * listeners are on the document either way.
   */
  const capturePointer = () => {
    try {
      captureTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer that has already been released cannot be captured.
    }
  };

  /**
   * Build the clone that travels, and hide the original in place.
   *
   * The clone is `position: fixed` on a host outside the strip's own clipping,
   * so it can leave the strip. Its anchor is the item's resting rect, so
   * translating it by the pointer delta keeps it under the finger exactly.
   *
   * `left`/`top` on a fixed element resolve against the viewport only while no
   * ancestor establishes a containing block for fixed positioning — and a
   * `transform` anywhere on the path does establish one (the phone sidebar
   * slides in under exactly that). Feeding it viewport coordinates there drops
   * the clone a whole header's height from the finger. So place it at the
   * origin, measure where that origin actually landed, and offset from there:
   * correct under either regime, and it stays correct for any transform,
   * filter or containment added to the path later.
   */
  const createGhost = () => {
    const rect = item.getBoundingClientRect();
    const clone = /** @type {HTMLElement} */ (item.cloneNode(true));
    clone.classList.add(ghostClass);
    clone.setAttribute('aria-hidden', 'true');
    clone.style.transform = 'none';
    clone.style.left = '0';
    clone.style.top = '0';
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    try {
      prepareGhost?.(clone);
    } catch (err) {
      console.error('[ReorderDrag] Could not prepare the drag clone:', err);
    }
    ghostHost.appendChild(clone);
    const origin = clone.getBoundingClientRect();
    clone.style.left = `${rect.left - origin.left}px`;
    clone.style.top = `${rect.top - origin.top}px`;
    ghost = clone;
    item.classList.add(sourceClass);
    // The clone travels by the pointer's delta from the press, so its middle
    // stays this far from the pointer for the whole gesture — on the axes it
    // travels. On one it is held to, the pointer is read as it is.
    if (readCentre) {
      if (axis !== 'y') centreOffsetX = rect.left + rect.width / 2 - event.clientX;
      if (axis !== 'x') centreOffsetY = rect.top + rect.height / 2 - event.clientY;
    }
  };

  /**
   * Which position in the strip — counted without the dragged item — a pointer
   * here would drop into.
   *
   * A strip on one line is read along its axis: an item is passed once the
   * pointer is beyond its midpoint. A strip that wraps is read the way its
   * order reads, across rows: an item is passed if the pointer is below its row
   * entirely, or on its row and past its midpoint. So a pointer in the gutter
   * to the right of a short row lands at the end of that row rather than
   * skipping to the next.
   * @param {number} clientX - Pointer x in client coordinates.
   * @param {number} clientY - Pointer y in client coordinates.
   * @returns {number} The target index.
   */
  const indexAt = (clientX, clientY) => {
    const others = items().filter((el) => el !== item);
    for (let i = 0; i < others.length; i++) {
      const box = settledRect(/** @type {HTMLElement} */ (others[i]));
      if (wrap) {
        if (clientY >= box.bottom) continue;
        if (clientY < box.top || clientX < box.left + box.width / 2) return i;
        continue;
      }
      const past = axis === 'x'
        ? clientX < box.left + box.width / 2
        : clientY < box.top + box.height / 2;
      if (past) return i;
    }
    return others.length;
  };

  /**
   * Where an index puts the item: which list, and in front of what.
   *
   * The list is taken from the item being landed in front of, so that a strip
   * built from more than one list still moves the item into the list it is
   * landing in — inserting before a node that is not a child of the current
   * parent throws, which would strand the gesture mid-move.
   *
   * Reading the list off the anchor like this can only ever be right for a
   * strip whose lists tile the space they are read in. Where they do not — a
   * nested list drawn as a box with a margin round it, so that there are
   * pointer positions inside the strip and outside every list — the nearest
   * item is a bad witness: past the end of the strip the nearest item is the
   * last one, and if the last one lives in a box then a drop in the gutter
   * below that box reads as a drop inside it. Such a strip passes
   * `dropPlaceAt` and answers the question from its own geometry.
   * @param {number} index - The target index, without the dragged item.
   * @returns {DropPlace} The list and the node to land in front of.
   */
  const placeAt = (index) => {
    const others = items().filter((el) => el !== item);
    const anchor = others[index] || null;
    return {
      parent: anchor?.parentElement || others[others.length - 1]?.parentElement || item.parentElement,
      anchor
    };
  };

  /**
   * Which position in the strip the item has ended up in, for a caller that
   * counts rather than one that reads the anchor. An anchor that is not an item
   * at all — a whole nested list a drop landed in front of — has no index to
   * be, and counts as the end.
   * @param {DropPlace} place - Where the item is going.
   * @returns {number} The index into the strip without the dragged item.
   */
  const indexOfPlace = (place) => {
    if (!place.anchor) return items().filter((el) => el !== item).length;
    const at = items().filter((el) => el !== item).indexOf(/** @type {HTMLElement} */ (place.anchor));
    return at >= 0 ? at : items().filter((el) => el !== item).length;
  };

  /**
   * Show the arrangement the drop would produce: put the placeholder where it
   * would land, then FLIP everything from where it was to where it now is.
   * @param {DropPlace} place - Where the item is going.
   */
  const shiftTo = (place) => {
    const boxes = new Set(groups?.() ?? []);
    const moving = [...new Set([...boxes, ...items()])].filter((el) => el !== item);
    /** @type {Map<HTMLElement, DOMRect>} */
    const first = new Map();
    for (const el of moving) first.set(el, el.getBoundingClientRect());

    place.parent?.insertBefore(item, place.anchor);

    // Where everything is going, not where the animations already running have
    // it at this instant: the inversion below replaces those transforms, so
    // measuring through them would count the same offset twice and start the
    // travel from somewhere it has never been. Every glide comes off before
    // anything is measured, because a group's carries what is inside it.
    for (const el of moving) {
      el.style.transition = 'none';
      el.style.transform = 'none';
    }
    /** @type {Map<HTMLElement, {dx: number, dy: number}>} */
    const travel = new Map();
    for (const el of moving) {
      const start = /** @type {DOMRect} */ (first.get(el));
      const end = el.getBoundingClientRect();
      travel.set(el, { dx: start.left - end.left, dy: start.top - end.top });
    }

    for (const el of moving) {
      let { dx, dy } = /** @type {{dx: number, dy: number}} */ (travel.get(el));
      // The nearest group it is drawn in carries it that group's distance
      // (and any group above that one's), so it travels only the rest.
      let holder = el.parentElement;
      while (holder && !boxes.has(holder)) holder = holder.parentElement;
      const carried = holder ? travel.get(holder) : undefined;
      if (carried) {
        dx -= carried.dx;
        dy -= carried.dy;
      }
      if (boxes.has(el)) glided.add(el);
      el.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : '';
    }
    // Two frames: one for the browser to accept the inverted position as the
    // starting point, one for the transition to run from it.
    requestAnimationFrame(() => {
      for (const el of moving) {
        el.style.transition = '';
        el.style.transform = '';
      }
    });
  };

  /**
   * Read the drop position, and rearrange if it has changed. The pointer is
   * moved to the middle of the clone first when the strip reads from there.
   * @param {number} pointerX - Pointer x in client coordinates.
   * @param {number} pointerY - Pointer y in client coordinates.
   */
  const recompute = (pointerX, pointerY) => {
    const clientX = pointerX + centreOffsetX;
    const clientY = pointerY + centreOffsetY;
    const asked = dropPlaceAt?.(clientX, clientY) ?? null;
    const index = asked ? indexOfPlace(asked) : indexAt(clientX, clientY);
    const place = asked ?? placeAt(index);
    // Already there: inserting before the node it already precedes moves
    // nothing, and doing it every frame churns the DOM for no reason.
    if (place.parent === placed.parent && place.anchor === placed.anchor) {
      dropIndex = index;
      return;
    }
    dropIndex = index;
    placed = place;
    shiftTo(place);
  };

  /** Scroll the strip while the pointer rests near one of its edges. */
  const updateAutoScroll = () => {
    if (finished || !scrollContainer) {
      stopAutoScroll();
      return;
    }
    const horizontal = axis === 'x';
    const rect = scrollContainer.getBoundingClientRect();
    const overflow = horizontal
      ? scrollContainer.scrollWidth - scrollContainer.clientWidth
      : scrollContainer.scrollHeight - scrollContainer.clientHeight;
    const along = horizontal ? lastClientX : lastClientY;
    const nearStart = along - (horizontal ? rect.left : rect.top);
    const nearEnd = (horizontal ? rect.right : rect.bottom) - along;
    const scrolled = horizontal ? scrollContainer.scrollLeft : scrollContainer.scrollTop;
    const visible = horizontal ? scrollContainer.clientWidth : scrollContainer.clientHeight;
    const total = horizontal ? scrollContainer.scrollWidth : scrollContainer.scrollHeight;

    let delta = 0;
    if (overflow > SCROLL_OVERFLOW_MIN_PX) {
      if (nearStart < EDGE_HOTZONE_PX && scrolled > 0) {
        delta = -Math.ceil(MAX_SCROLL_STEP_PX * (1 - Math.max(0, nearStart) / EDGE_HOTZONE_PX));
      } else if (nearEnd < EDGE_HOTZONE_PX && scrolled + visible < total) {
        delta = Math.ceil(MAX_SCROLL_STEP_PX * (1 - Math.max(0, nearEnd) / EDGE_HOTZONE_PX));
      }
    }
    if (delta === 0) {
      autoScrollRaf = null;
      return;
    }
    if (horizontal) scrollContainer.scrollLeft += delta;
    else scrollContainer.scrollTop += delta;
    // The drop position can change when the strip moves under a pointer that
    // has not. The clone sits outside the scroll box, so it stays under the
    // pointer on its own — there is nothing to reposition here.
    recompute(lastClientX, lastClientY);
    autoScrollRaf = requestAnimationFrame(updateAutoScroll);
  };

  const maybeStartAutoScroll = () => {
    if (scrollContainer && autoScrollRaf === null) {
      autoScrollRaf = requestAnimationFrame(updateAutoScroll);
    }
  };

  const stopAutoScroll = () => {
    if (autoScrollRaf !== null) {
      cancelAnimationFrame(autoScrollRaf);
      autoScrollRaf = null;
    }
  };

  /**
   * Whether the pointer has travelled far enough to mean a drag.
   * @param {number} dx - Distance moved in x.
   * @param {number} dy - Distance moved in y.
   * @returns {boolean} True once this is a drag.
   */
  const passedThreshold = (dx, dy) => {
    if (axis === 'x') return Math.abs(dx) >= thresholdPx;
    if (axis === 'y') return Math.abs(dy) >= thresholdPx;
    return Math.hypot(dx, dy) >= thresholdPx;
  };

  /** Put every trace of the drag away, leaving the strip as the caller found it. */
  const cleanUp = () => {
    stopAutoScroll();
    ghost?.remove();
    ghost = null;
    item.classList.remove(sourceClass);
    for (const el of [...items(), ...(groups?.() ?? [])]) {
      el.style.transition = '';
      el.style.transform = '';
    }
    strip?.classList.remove(draggingClass);
    try {
      captureTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Already released, or never held — either way there is nothing to give back.
    }
  };

  /** Pick the item up: the threshold was passed, or the hold ran out. */
  const begin = () => {
    active = true;
    capturePointer();
    strip?.classList.add(draggingClass);
    createGhost();
    try {
      onDragStart?.();
    } catch (err) {
      console.error('[ReorderDrag] Drag start handler failed:', err);
    }
  };

  /** The hold ran out with the finger still down and still: lift. */
  const lift = () => {
    holdTimer = null;
    if (finished || !pending) return;
    pending = false;
    lifted = true;
    liftedHolds++;
    begin();
    if (ghost) ghost.style.transform = 'scale(1.02)';
  };

  /** @param {PointerEvent} move - A pointermove. */
  const onMove = (move) => {
    if (finished) return;
    // A gesture can lose its release. A native context menu, an OS window
    // switch, or a pointer that leaves the webview all swallow the pointerup,
    // and a gesture still listening for one arms itself on the next stray
    // movement — the item then follows a pointer with nothing held down, and
    // there is no release coming to put it back. A move reporting no button is
    // that gesture's proof it is over.
    if (move.buttons === 0) {
      finish(false);
      return;
    }
    const dx = move.clientX - event.clientX;
    const dy = move.clientY - event.clientY;
    travelled = Math.max(travelled, Math.hypot(dx, dy));
    if (pending) {
      // Still waiting on the hold: a tremor is a finger holding still, and
      // anything more is a finger scrolling — which is the browser's.
      if (travelled > /** @type {NonNullable<typeof hold>} */ (hold).tolerancePx) finish(false);
      return;
    }
    if (!active) {
      if (!passedThreshold(dx, dy)) return;
      begin();
    }

    lastClientX = move.clientX;
    lastClientY = move.clientY;
    if (ghost) {
      const tx = axis === 'y' ? 0 : dx;
      const ty = axis === 'x' ? 0 : dy;
      ghost.style.transform = `translate(${tx}px, ${ty}px) scale(1.02)`;
    }
    recompute(move.clientX, move.clientY);
    maybeStartAutoScroll();
  };

  /**
   * End the gesture.
   * @param {boolean} commit - Whether a landing counts, or is being abandoned.
   */
  const finish = (commit) => {
    if (finished) return;
    finished = true;
    if (holdTimer !== null) clearTimeout(holdTimer);
    if (holding) liveHolds--;
    if (lifted) liftedHolds--;
    blockScroll(false);
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onCancel);

    // Whether the item is somewhere else, asked of where it actually sits: the
    // same index can be two places in a strip of nested lists, and a drop into
    // another list at the same index is the most consequential move there is.
    const moved = active && commit && fromIndex >= 0
      && (placed.parent !== home.parent || placed.anchor !== home.anchor);
    // The strip may be showing an arrangement nobody asked for, and it has to go
    // back before anything measures it — but only when the item is genuinely
    // somewhere else. insertBefore is a remove and an insert even when the node
    // is already exactly there, and doing that on pointerup tears the element
    // out from under the click the browser is about to fire: the click never
    // arrives, and every CSS animation on the element restarts. So a press that
    // stayed a click, and a drag that wandered back into its own slot, both
    // leave the DOM strictly untouched.
    // The anchor is read at the press and the strip is not ours alone: the item
    // that followed this one can have been removed by the time the gesture is
    // abandoned, and insertBefore against a node that is no longer a child
    // throws. Everything below is the tidying up — the clone, the classes, the
    // listeners, the owner's drag flag — so a throw here would leave the strip
    // stranded mid-gesture for good. Fall back to the end of the strip, which
    // is where a home anchor that no longer exists now is.
    if (active && !moved && item.nextSibling !== homeNext) {
      const anchor = homeNext && homeNext.parentNode === homeParent ? homeNext : null;
      homeParent?.insertBefore(item, anchor);
    }
    cleanUp();

    if (moved) {
      try {
        onCommit?.({ item, fromIndex, toIndex: dropIndex, parent: placed.parent, anchor: placed.anchor });
      } catch (err) {
        console.error('[ReorderDrag] Commit handler failed:', err);
      }
    }
    try {
      onDragEnd?.({ dragged: active, moved });
    } catch (err) {
      console.error('[ReorderDrag] Drag end handler failed:', err);
    }
    // A lift let go where it was: the long-press, not a drag.
    if (commit && lifted && !moved && travelled < thresholdPx) {
      try {
        hold?.onHeldRelease?.({ clientX: lastClientX, clientY: lastClientY });
      } catch (err) {
        console.error('[ReorderDrag] Held-release handler failed:', err);
      }
    }
  };

  /** @param {PointerEvent} up - The release. */
  const onUp = (up) => {
    lastClientX = up.clientX;
    lastClientY = up.clientY;
    finish(true);
  };
  const onCancel = () => finish(false);

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onCancel);

  if (holding) {
    liveHolds++;
    blockScroll(true);
    const ms = /** @type {NonNullable<typeof hold>} */ (hold).ms;
    if (ms <= 0) lift();
    else holdTimer = setTimeout(lift, ms);
  }

  return {
    isActive: () => active && !finished,
    cancel: () => finish(false),
  };
}
