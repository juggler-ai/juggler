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
 *
 * A strategy can override it for its own conversations
 * (`MANIFEST.ui.toolGrouping: 'always' | 'never'`, utils/strategy-chrome.js):
 * grouping is then on, or off, for them whatever the preference says, and the
 * preference is left as it was for every other conversation.
 * @module utils/tool-grouping-pref
 */

import { cachedWindowPref, setWindowPref, notifyPrefChanged, reconcilePref } from '../services/prefs.js';
import { strategyToolGrouping } from './strategy-chrome.js';

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
 * Fired on window when the conversation in view may have started or stopped
 * overriding grouping — it changed, or its strategy did — so the header toggle
 * can show it.
 */
export const TOOL_GROUPING_SCOPE_EVENT = 'juggler:tool-grouping-scope-changed';

/**
 * Say that the conversation in view may have changed whether it overrides
 * grouping. Cheap: the header re-reads and writes only what differs.
 */
export function notifyToolGroupingScope() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(TOOL_GROUPING_SCOPE_EVENT));
}

/**
 * Whether a conversation's strategy overrides the preference
 * (`MANIFEST.ui.toolGrouping`, read off the root thread, whose strategy the
 * whole transcript is shown under).
 * @param {{rootMessageThread?: import('../model/message-thread.js').default}|null|undefined} conversation - The conversation
 * @returns {'always'|'never'|null} The strategy's rule, or null when the preference applies
 */
export function toolGroupingOverride(conversation) {
  return strategyToolGrouping(conversation?.rootMessageThread);
}

/**
 * Whether a conversation's tool runs are drawn folded: as its strategy says,
 * else as this window's preference says. Every reader that draws a transcript
 * asks this rather than {@link isToolGroupingEnabled}, which is only the
 * preference.
 * @param {{rootMessageThread?: import('../model/message-thread.js').default}|null|undefined} conversation - The conversation
 * @returns {boolean} True when grouping applies to it
 */
export function toolGroupingFor(conversation) {
  const override = toolGroupingOverride(conversation);
  return override ? override === 'always' : isToolGroupingEnabled();
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
