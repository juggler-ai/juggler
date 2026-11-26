//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What the header's "…" popup offers.
 *
 * Usually only what a narrow header has folded out of its row — zoom, theme,
 * window border, sound and help — and those as the buttons themselves, lent to
 * the popup while it is open ({@link foldedControls}), not as menu rows: zoom is
 * pressed again and again, and theme, border and sound show their state.
 *
 * A Windows or Linux desktop window has menu rows too. It has no menu bar —
 * Linux sets none, and Windows' frameless window never shows one — so there "…"
 * is always in the row and is the app menu, in the place Edge and Chrome put
 * theirs: the Session menu's commands, Settings and About, and the Exit (Quit
 * on Linux) that is the only way to close every window at once and have the
 * next launch bring them all back. The labels are the native menu's own
 * English, so the two share their translations.
 * @module utils/header-overflow-items
 */

import { markForTranslation } from '../../sdk/lib/i18n.js';
import { postWindowControl } from '../../sdk/lib/window-control.js';
import { openSettings } from '../services/settings-launcher.js';

/** @typedef {import('./header-overflow-menu.js').HeaderOverflowItem} HeaderOverflowItem */

/**
 * The desktop platform whose window has "…" as its app menu, if this page is
 * one: a Windows or Linux desktop window. Null on macOS, whose menu bar has the
 * app commands, and in a browser tab, whose browser has its own.
 * @param {HTMLElement} [root] - The document element carrying the window flags.
 * @returns {'windows'|'linux'|null} The platform, or null where "…" is not the app menu.
 */
export function appMenuPlatform(root = document.documentElement) {
  if (root.dataset.windowMode !== '1') return null;
  const platform = root.dataset.windowPlatform;
  return platform === 'windows' || platform === 'linux' ? platform : null;
}

/**
 * Whether the narrow header has folded its foldable controls out of its row —
 * one container query folds them all, so their first wrapper answers for all
 * of them.
 * @param {ParentNode} root - Where the header is.
 * @returns {boolean} True while they are folded.
 */
function headerFolded(root) {
  const wrapper = root.querySelector('header-actions .header-foldable');
  return !!wrapper && getComputedStyle(wrapper).display === 'none';
}

/** @returns {boolean} True on a device with no hover, and so likely no keyboard. */
function isTouch() {
  return window.matchMedia('(hover: none)').matches;
}

/**
 * The header's controls the "…" popup shows: the `.header-foldable` wrappers a
 * narrow header has folded out of its row, in row order, for the popup to hold
 * while it is open and hand back when it closes. None while the row has room.
 * Help never — not even then — on a device with no hover: a keyboard reference
 * is a dead end there, which is why the touch header drops its button too.
 * @param {object} [options] - Every option defaults to the live page; tests pass their own.
 * @param {ParentNode} [options.root] - Where the header is.
 * @param {(root: ParentNode) => boolean} [options.folded] - Whether the row has folded them.
 * @param {() => boolean} [options.touch] - Whether the device has no hover.
 * @returns {HTMLElement[]} The wrappers to show.
 */
export function foldedControls({ root = document, folded = headerFolded, touch = isTouch } = {}) {
  if (!folded(root)) return [];
  const wrappers = /** @type {HTMLElement[]} */ ([...root.querySelectorAll('header-actions .header-foldable')]);
  return touch() ? wrappers.filter((w) => !w.querySelector('.help-button')) : wrappers;
}

/**
 * @param {string} type - The event the native menu dispatches for the same command.
 * @param {EventTarget} [target] - Where it is dispatched.
 */
function dispatch(type, target = window) {
  target.dispatchEvent(new CustomEvent(type));
}

/**
 * The menu rows of the "…" popup, in order: the app menu's, where "…" is one,
 * and none anywhere else.
 * @param {object} [options] - Every option defaults to the live page; tests pass their own.
 * @param {'windows'|'linux'|null} [options.platform] - See {@link appMenuPlatform}.
 * @param {(action: string) => void} [options.post] - The native window-control transport.
 * @returns {HeaderOverflowItem[]} The rows, separators between groups.
 */
export function headerOverflowItems({
  platform = appMenuPlatform(),
  post = postWindowControl,
} = {}) {
  if (!platform) return [];
  return [
    {
      label: markForTranslation('New Conversation'),
      shortcutId: 'new-conversation',
      run: () => dispatch('juggler:new-conversation', document),
    },
    { label: markForTranslation('New Window'), shortcutId: 'new-window', run: () => dispatch('juggler:new-window') },
    { separator: true },
    { label: markForTranslation('Open or connect to a new session...'), run: () => dispatch('juggler:open-project') },
    { separator: true },
    { label: markForTranslation('Settings'), shortcutId: 'open-settings', run: () => openSettings() },
    { label: markForTranslation('About Juggler'), run: () => dispatch('juggler:open-about') },
    { separator: true },
    {
      label: platform === 'windows' ? markForTranslation('Exit') : markForTranslation('Quit'),
      shortcutId: 'quit',
      run: () => post('quit'),
    },
  ];
}
