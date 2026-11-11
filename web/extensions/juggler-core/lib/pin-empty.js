//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * What a pin says when it has nothing to show.
 *
 * A board is furnished with its tabs before there is anything to put in them, so
 * an empty card is the first thing most of these pins are ever seen as — and a
 * card that renders nothing at all is indistinguishable from one that is broken.
 * The line says what the card is for, in the place the content will appear, so
 * the answer arrives where the question was asked.
 *
 * Centred, and no heading: the pin's name is already on its tab and in the
 * toolbar above it, and repeating it here would be the third time. One line for a
 * card whose contents explain themselves; a sentence or two where the empty card
 * is the only place the feature is ever explained.
 * @module lib/pin-empty
 */

import { createElement, injectStylesOnce } from 'juggler/ui';

// `flex: 1 1 auto` is what centres it: every pin's root is a flex column of the
// card's full height, so the line takes the room the content is not using.
injectStylesOnce('pin-empty-styles', `
.pin-empty {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  justify-content: center;
  min-height: 4rem;
  padding: var(--space-16);
  color: var(--text-secondary);
  text-align: center;
  text-wrap: balance;
}
`);

/**
 * The empty state for a pin: centred text saying what will appear here.
 * @param {string} text - A sentence or two, ending in a full stop.
 * @returns {HTMLElement} The element to put in the pin's body.
 */
export function pinEmpty(text) {
  return createElement('div', 'pin-empty', text);
}
