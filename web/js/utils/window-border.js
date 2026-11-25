//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * window-border — whether this window is framed in its project's colour, so a
 * user with several windows open can tell at a glance which project each one
 * is.
 *
 * Off until the user turns it on (components/window-border-button.js). It
 * belongs to the window, like the theme and zoom beside it in the header: the
 * `window` realm (services/prefs.js), so each window of each project keeps its
 * own and a remote viewer keeps its own copy. A window opened out of another —
 * a detached board — starts as its opener looks: the opener hands its border
 * over in the new window's address (`?border=1`, as it does its theme and
 * zoom), and the new window keeps it as its own.
 *
 * The border is drawn by the page, the same on every platform and in a browser
 * tab (layout/window-chrome.css). This module only marks `<html>`:
 * `data-window-border` while it is on, `data-window-inactive` while the window
 * does not have the focus, and `--project-colour` with the project's colour
 * (utils/project-colour.js), kept current as either changes. A page with no
 * project — the sessions page, a window with nothing open — has nothing to
 * frame and is left alone.
 * @module utils/window-border
 */

import {
  cachedWindowPref, setWindowPref, notifyPrefChanged, reconcilePref, startingWindowPref,
} from '../services/prefs.js';
import { projectColour, projectColourValue, thisProjectKey, PROJECT_COLOURS_EVENT } from './project-colour.js';
import { onDocumentReady } from './document-ready.js';

const PREF_KEY = 'juggler-window-border';

/** Fired on window whenever this window's border is turned on or off. */
export const WINDOW_BORDER_EVENT = 'juggler:window-border-changed';

/**
 * Whether this window draws its border.
 * @returns {boolean} True when it is on.
 */
export function isWindowBorderOn() {
  return cachedWindowPref(PREF_KEY, false) === true;
}

/**
 * Turn this window's border on or off.
 * @param {boolean} on - True to draw it.
 * @returns {Promise<void>} Resolves when the write has been sent.
 */
export function setWindowBorder(on) {
  const written = setWindowPref(PREF_KEY, !!on);
  notifyPrefChanged(WINDOW_BORDER_EVENT);
  return written;
}

/**
 * The border the window that opened this one handed it (`?border=1`), or null
 * for none.
 * @returns {true|null} True when it was handed one.
 * @private
 */
function seedBorder() {
  try {
    return new URL(window.location.href).searchParams.get('border') === '1' ? true : null;
  } catch (_e) {
    return null;
  }
}

/**
 * Mark `<html>` with this window's border, its project's colour and whether
 * the window has the focus. Exported for tests, which call it after changing
 * either preference.
 * @param {HTMLElement} [root] - The document element.
 * @returns {void}
 */
export function paintWindowBorder(root = document.documentElement) {
  const key = thisProjectKey();
  if (!key) return;
  root.style.setProperty('--project-colour', projectColourValue(projectColour(key)));
  if (isWindowBorderOn()) root.dataset.windowBorder = '1';
  else delete root.dataset.windowBorder;
}

/**
 * @param {boolean} focused - Whether this window has the focus.
 * @returns {void}
 * @private
 */
function markFocus(focused) {
  const root = document.documentElement;
  if (focused) delete root.dataset.windowInactive;
  else root.dataset.windowInactive = '1';
}

/**
 * Start from this window's own border, else the one its opener handed it
 * (kept from then on), and follow both preferences and the focus.
 * @private
 */
function initWindowBorder() {
  if (!thisProjectKey()) return;
  const start = startingWindowPref({ own: cachedWindowPref(PREF_KEY, null), inherited: [seedBorder()], fallback: false });
  if (start.adopt) void setWindowPref(PREF_KEY, start.value);
  paintWindowBorder();
  markFocus(document.hasFocus());
  window.addEventListener('focus', () => markFocus(true));
  window.addEventListener('blur', () => markFocus(false));
  window.addEventListener(WINDOW_BORDER_EVENT, () => paintWindowBorder());
  window.addEventListener(PROJECT_COLOURS_EVENT, () => paintWindowBorder());
  void reconcilePref('window', PREF_KEY, WINDOW_BORDER_EVENT);
}

onDocumentReady(initWindowBorder);
