//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * tool-grouping-pref — the "collapse tool runs" display preference.
 *
 * When on, a run of adjacent tool-use rows in a column is drawn as ONE group
 * tile; selecting it opens the run's rows in the next column. This is purely a
 * display choice — nothing about it is written to the conversation document.
 *
 * It belongs to the client that toggled it, like the zoom and theme buttons it
 * sits beside in the header: the `window` realm (services/prefs.js), so a
 * desktop window keeps its own choice in the project's session under its window
 * role, and a remote browser keeps its own on its device without writing back.
 * Flipping it in one window never redraws another window, another project, or
 * the desktop a phone dialled into.
 * @module utils/tool-grouping-pref
 */

import { cachedWindowPref, setWindowPref, notifyPrefChanged, reconcilePref } from '../services/prefs.js';

const PREF_KEY = 'juggler-tool-grouping';

/** Fired on window whenever the preference changes, so open views re-render. */
export const TOOL_GROUPING_EVENT = 'juggler:tool-grouping-changed';

/**
 * Whether adjacent tool-use rows should be collapsed into group tiles.
 * Defaults to off: the flat transcript is what a new user should see first.
 * @returns {boolean} True when grouping is enabled.
 */
export function isToolGroupingEnabled() {
  return cachedWindowPref(PREF_KEY, false) === true;
}

/**
 * Set the preference and notify listeners.
 * The local cache changes at once; the realm write is debounced, so the server
 * holds the previous value until the returned promise resolves.
 * @param {boolean} enabled - True to collapse tool runs into group tiles.
 * @returns {Promise<void>} Resolves when the write has been sent.
 */
export function setToolGroupingEnabled(enabled) {
  const written = setWindowPref(PREF_KEY, !!enabled);
  notifyPrefChanged(TOOL_GROUPING_EVENT);
  return written;
}

/**
 * Flip the preference.
 * @returns {boolean} The new state.
 */
export function toggleToolGrouping() {
  const next = !isToolGroupingEnabled();
  void setToolGroupingEnabled(next);
  return next;
}

// Ask for this window's choice at boot; a transcript already drawn re-renders on
// the event when the answer differs from what was cached.
if (typeof document !== 'undefined') {
  void reconcilePref('window', PREF_KEY, TOOL_GROUPING_EVENT);
}
