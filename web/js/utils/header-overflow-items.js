//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What the header's "…" menu offers.
 *
 * Usually only what a narrow header has folded out of its row: zoom and help.
 * A Windows or Linux desktop window is different. It has no menu bar — Linux
 * sets none, and Windows' frameless window never shows one — so there "…" is
 * always in the row and is the app menu, in the place Edge and Chrome put
 * theirs: the Session menu's commands, Settings and About, and the Exit (Quit
 * on Linux) that is the only way to close every window at once and have the
 * next launch bring them all back. The labels are the native menu's own
 * English, so the two share their translations.
 * @module utils/header-overflow-items
 */

import { markForTranslation } from '../../sdk/lib/i18n.js';
import { postWindowControl } from '../../sdk/lib/window-control.js';
import { openSettings } from '../services/settings-launcher.js';
import { zoomIn, zoomOut } from './zoom-manager.js';

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
 * Whether the narrow header has folded zoom and help out of its row — one
 * container query folds both, so their first wrapper answers for all of them.
 * @returns {boolean} True while they are folded.
 */
function headerFolded() {
  const wrapper = document.querySelector('.header-foldable');
  return !!wrapper && getComputedStyle(wrapper).display === 'none';
}

/** @returns {boolean} True on a device with no hover, and so likely no keyboard. */
function isTouch() {
  return window.matchMedia('(hover: none)').matches;
}

/**
 * @param {string} type - The event the native menu dispatches for the same command.
 * @param {EventTarget} [target] - Where it is dispatched.
 */
function dispatch(type, target = window) {
  target.dispatchEvent(new CustomEvent(type));
}

/**
 * The rows of the "…" menu, in order.
 * @param {object} [options] - Every option defaults to the live page; tests pass their own.
 * @param {'windows'|'linux'|null} [options.platform] - See {@link appMenuPlatform}.
 * @param {() => boolean} [options.folded] - Whether zoom and help are folded out of the row.
 * @param {() => boolean} [options.touch] - Whether the device has no hover.
 * @param {(action: string) => void} [options.post] - The native window-control transport.
 * @returns {HeaderOverflowItem[]} The rows, separators between groups.
 */
export function headerOverflowItems({
  platform = appMenuPlatform(),
  folded = headerFolded,
  touch = isTouch,
  post = postWindowControl,
} = {}) {
  // The app menu shows the folded rows only while they are folded; elsewhere
  // "…" is on screen only then.
  const unfolded = platform ? () => !folded() : () => false;
  /** @type {HeaderOverflowItem[]} */
  const foldedRows = [
    { label: markForTranslation('Decrease font size'), shortcutId: 'zoom-out', run: () => zoomOut(), omit: unfolded },
    { label: markForTranslation('Increase font size'), shortcutId: 'zoom-in', run: () => zoomIn(), omit: unfolded },
    {
      label: markForTranslation('Tips & keyboard shortcuts'),
      shortcutId: 'show-shortcuts',
      run: () => openSettings('shortcuts'),
      // The same reason the touch header drops the help button: a keyboard
      // reference is a dead end on a device with no keyboard.
      omit: () => unfolded() || touch(),
    },
  ];
  if (!platform) return foldedRows;
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
    ...foldedRows,
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
