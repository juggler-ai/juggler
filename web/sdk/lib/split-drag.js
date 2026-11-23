//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * A handle on the line between two panes, dragged to move it — the mechanics
 * every split shares, whatever it stores and however it styles the panes.
 *
 * The drag's moves and its release are heard on the window, not the handle.
 * With the pointer captured they reach the handle and bubble there anyway; a
 * browser that fails to capture without saying so delivers them to whatever
 * is under the pointer, which only the window is sure to hear.
 * @module sdk/lib/split-drag
 */

/**
 * The root font size, in CSS pixels: what one rem is at the app's current
 * zoom, for a width stored in rem.
 * @returns {number} Pixels per rem.
 */
export function remPx() {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/**
 * @typedef {object} SplitDragOptions
 * @property {() => DOMRect} box - The region the line divides, read at each move.
 * @property {'x'|'y'|(() => 'x'|'y')} [axis='x'] - Which way the line moves:
 *   'x' for panes side by side. A function is asked when a drag starts, for a
 *   layout that turns with the room it has.
 * @property {(share: number, px: number) => void} onMove - The pointer moved:
 *   where it is across `box`, as a share of it (unclamped) and in pixels from
 *   its start edge.
 * @property {() => void} [onStart] - A drag began.
 * @property {() => void} [onEnd] - The drag ended, for storing where it left the line.
 * @property {(direction: -1|1) => void} [onStep] - An arrow key along the axis
 *   while the handle has focus: -1 for Left or Up, 1 for Right or Down. The key
 *   goes no further, so the keys of what holds the handle are left alone.
 * @property {() => void} [onReset] - A double-click: put the line back.
 * @property {string} [draggingClass] - A class the handle wears during a drag.
 */

/**
 * Make `handle` move a split.
 * @param {HTMLElement} handle - The handle, on the line it moves.
 * @param {SplitDragOptions} options - What a drag does.
 * @returns {() => void} Detaches it, ending a drag under way.
 */
export function attachSplitDrag(handle, { box, axis = 'x', onMove, onStart, onEnd, onStep, onReset, draggingClass }) {
  /** @type {(() => void)|null} */
  let endDrag = null;

  /** @param {PointerEvent} event - The press. */
  const onDown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    // A drag whose release went unheard ends here rather than running beside this one.
    endDrag?.();
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // No active pointer of that id: the window listeners still carry the drag.
    }
    const pointerId = event.pointerId;
    const across = (typeof axis === 'function' ? axis() : axis) === 'x';
    if (draggingClass) handle.classList.add(draggingClass);
    onStart?.();

    /** @param {PointerEvent} move - The drag. */
    const move = (move) => {
      if (move.pointerId !== pointerId) return;
      const b = box();
      const px = across ? move.clientX - b.left : move.clientY - b.top;
      const size = across ? b.width : b.height;
      onMove(size > 0 ? px / size : 0, px);
    };
    const finish = () => {
      endDrag = null;
      if (draggingClass) handle.classList.remove(draggingClass);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      onEnd?.();
    };
    /** @param {PointerEvent} e - The release. */
    const up = (e) => {
      if (e.pointerId === pointerId) finish();
    };
    endDrag = finish;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  /** @param {KeyboardEvent} event - A key on the handle. */
  const onKey = (event) => {
    if (!onStep) return;
    const across = (typeof axis === 'function' ? axis() : axis) === 'x';
    const back = across ? 'ArrowLeft' : 'ArrowUp';
    const forward = across ? 'ArrowRight' : 'ArrowDown';
    if (event.key !== back && event.key !== forward) return;
    event.preventDefault();
    event.stopPropagation();
    onStep(event.key === back ? -1 : 1);
  };
  const onDouble = () => onReset?.();

  handle.addEventListener('pointerdown', onDown);
  handle.addEventListener('keydown', onKey);
  handle.addEventListener('dblclick', onDouble);
  return () => {
    endDrag?.();
    handle.removeEventListener('pointerdown', onDown);
    handle.removeEventListener('keydown', onKey);
    handle.removeEventListener('dblclick', onDouble);
  };
}
