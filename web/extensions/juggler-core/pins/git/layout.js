//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The Git pin's four modes, as its places' keys and clicks need to know them.
 * The CSS decides the layout with container queries on the pin
 * (pins/git/styles); what Enter, `c` or a click on a Refs row does depends on
 * it too, so the pin reads its size synchronously (`clientWidth` and
 * `clientHeight`, layout reads that need no paint) and gets the same answer.
 *
 * - **chip**, under 5.5rem tall: the head line alone. It is height that makes
 *   one, so a narrow pin in a tall sidebar is a stack, not a chip.
 * - **stack**, under 34rem wide: one pane at a time.
 * - **split**, from 34rem: list and detail side by side.
 * - **full**, wider than 60rem: the Refs list as a sidebar beside them.
 * @module pins/git/layout
 */

/** The height, in rem, below which the pin is a chip. */
const CHIP_BELOW_REM = 5.5;
/** The width, in rem, below which the pin is a stack rather than a split. */
const STACK_BELOW_REM = 34;
/** The width, in rem, past which the pin is full rather than a split. */
const FULL_ABOVE_REM = 60;

/** @typedef {'chip'|'stack'|'split'|'full'} PinMode */

/**
 * @param {HTMLElement} pinRoot - The pin's root.
 * @returns {PinMode} The mode its size puts it in; a split while it has no size.
 */
export function measureMode(pinRoot) {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const width = pinRoot.clientWidth;
  const height = pinRoot.clientHeight;
  if (width <= 0) return 'split';
  if (height > 0 && height < CHIP_BELOW_REM * rem) return 'chip';
  if (width < STACK_BELOW_REM * rem) return 'stack';
  return width > FULL_ABOVE_REM * rem ? 'full' : 'split';
}
