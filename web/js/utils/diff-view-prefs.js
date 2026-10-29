//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * diff-view-prefs — how diffs are drawn, by default.
 *
 * Two preferences: whether a diff opens side by side or as one unified column,
 * and how many unchanged lines it shows around each change. Both are what a
 * NEW diff starts on. Each viewer can then be set on its own, and while it is,
 * it stops following these — see `diff-viewer.js`, which holds that override for
 * as long as the element lives.
 *
 * They belong to the machine (the `machine` realm, services/prefs.js), beside
 * the bell: side by side suits a wide desktop screen and not a phone viewing it
 * remotely, so every desktop window on this computer shares them and a remote
 * viewer keeps its own. Nothing on the
 * server reads either of them — git is asked for a context width per request,
 * and what it is asked for comes from the viewer, not from here.
 * @module utils/diff-view-prefs
 */

import { cachedMachinePref, setMachinePref, notifyPrefChanged, reconcilePref } from '../services/prefs.js';
import { t } from '../../sdk/lib/i18n.js';

const VIEW_KEY = 'juggler-diff-view';
const CONTEXT_KEY = 'juggler-diff-context';

/** Fired on window whenever either preference changes, so open diffs re-draw. */
export const DIFF_VIEW_PREFS_EVENT = 'juggler:diff-view-changed';

/**
 * The context width meaning "don't cut the file up at all". Stored as -1 rather
 * than a large number so it stays true of a file longer than any number we might
 * have picked, and reaches the renderer as `Infinity`.
 */
export const WHOLE_FILE = -1;

/** How many unchanged lines a diff shows around a change until told otherwise. */
const DEFAULT_CONTEXT_LINES = 3;

/**
 * The context widths offered, in the order they are offered. One list, read by
 * both the control on a viewer and the one in Settings, so the two cannot come
 * to disagree about what is on offer.
 * @type {number[]}
 */
export const CONTEXT_CHOICES = [0, 1, 3, 5, 10, 25, WHOLE_FILE];

/**
 * How a context width reads in a menu, in the UI language — every reader is a
 * menu (the viewer's control and the one in Settings).
 * @param {number} lines - A width from {@link CONTEXT_CHOICES}.
 * @returns {string} Its label.
 */
export function contextLabel(lines) {
  if (lines === WHOLE_FILE) return t('Whole file');
  if (lines === 0) return t('None');
  return t('{count, plural, one {# line} other {# lines}}', { count: lines });
}

/**
 * The stored width as the renderer wants it.
 * @param {number} lines - A stored width, where -1 means the whole file.
 * @returns {number} The width to group hunks at, `Infinity` for the whole file.
 */
export function contextToRender(lines) {
  return lines === WHOLE_FILE ? Infinity : lines;
}

/**
 * How a diff is laid out until told otherwise.
 *
 * Unified is the default, and it is the default on purpose: it is the layout that
 * fits wherever a diff is put, and a first-time reader meeting a diff in a
 * transcript column has not asked for two.
 * @returns {'inline'|'split'} The layout a new viewer starts in.
 */
export function defaultDiffView() {
  return cachedMachinePref(VIEW_KEY, 'inline') === 'split' ? 'split' : 'inline';
}

/**
 * Set the default layout and notify open viewers.
 * @param {'inline'|'split'} view - The layout a new viewer should start in.
 * @returns {void}
 */
export function setDefaultDiffView(view) {
  void setMachinePref(VIEW_KEY, view === 'split' ? 'split' : 'inline');
  notifyPrefChanged(DIFF_VIEW_PREFS_EVENT);
}

/**
 * How many unchanged lines a diff shows around each change until told otherwise.
 * A stored value that is not one of the choices on offer is ignored rather than
 * honoured: it can only have come from a version that offered something else.
 * @returns {number} The width, `-1` for the whole file.
 */
export function defaultDiffContext() {
  const stored = cachedMachinePref(CONTEXT_KEY, DEFAULT_CONTEXT_LINES);
  return CONTEXT_CHOICES.includes(stored) ? stored : DEFAULT_CONTEXT_LINES;
}

/**
 * Set the default context width and notify open viewers.
 * @param {number} lines - A width from {@link CONTEXT_CHOICES}.
 * @returns {void}
 */
export function setDefaultDiffContext(lines) {
  const next = CONTEXT_CHOICES.includes(lines) ? lines : DEFAULT_CONTEXT_LINES;
  void setMachinePref(CONTEXT_KEY, next);
  notifyPrefChanged(DIFF_VIEW_PREFS_EVENT);
}

// Ask for this machine's choices at boot; diffs already drawn re-draw on the event
// when an answer differs from what was cached.
if (typeof document !== 'undefined') {
  void reconcilePref('machine', VIEW_KEY, DIFF_VIEW_PREFS_EVENT);
  void reconcilePref('machine', CONTEXT_KEY, DIFF_VIEW_PREFS_EVENT);
}
