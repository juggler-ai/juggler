//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The sessions page's header buttons: zoom − and +, the theme's light switch
 * and, for a viewer on this machine, Settings — drawn and behaving as a
 * session's header draws them (index.html, services/ui-event-manager.js).
 *
 * The theme and zoom are the page's own (utils/theme-manager.js and
 * utils/zoom-manager.js keep them for it on this device), and the app is told
 * of each change, as a session's page tells it, so its next window starts from
 * them. The native menu's Zoom In and Zoom Out (`juggler:zoom-in`,
 * `juggler:zoom-out`) and the same shortcuts as a session's work here too, and
 * Cmd/Ctrl+, opens Settings.
 *
 * Settings here are this computer's (components/settings-panel.js, on the
 * sessions page): loaded only when first opened, since a page that never opens
 * them should not pay for the panel.
 *
 * A page framing another computer's server hands that page its theme and zoom
 * whenever either changes ({@link APPEARANCE_EVENT}), and the framed page wears
 * them ({@link followFramerAppearance}).
 * @module machine/header-buttons
 */

import { toggleTheme, setMode, getMode, MODES, THEME_MODE_EVENT } from '../js/utils/theme-manager.js';
import { zoomIn, zoomOut, getCurrentZoom, setZoomLevel } from '../js/utils/zoom-manager.js';
import { renderThemeButton } from '../js/utils/theme-button.js';
import keyShortcutManager from '../js/services/key-shortcut-manager.js';
import { openSettings } from '../js/services/settings-launcher.js';
import { t } from '../sdk/lib/i18n.js';

/**
 * What a page framing another computer's server tells the framed page when its
 * theme or zoom changes (relayFramerEvents, sessions-view.js), with
 * `{mode, zoom}`: the theme mode and the root font-size percentage.
 */
export const APPEARANCE_EVENT = 'juggler:appearance';

/**
 * The theme and zoom the page wears now, as {@link APPEARANCE_EVENT} carries them.
 * @returns {{mode: string, zoom: number}} The mode and zoom.
 */
export function currentAppearance() {
  return { mode: getMode(), zoom: getCurrentZoom() };
}

/** Settings loading into the page, or loaded; null until first asked for. */
let settingsLoaded = /** @type {Promise<unknown>|null} */ (null);

/**
 * Open this computer's Settings, loading the panel on first use — the one
 * with the tabs that need no session (components/machine-settings-panel.js),
 * whose modules this page can load without an import map. A load that fails
 * is reported, and the next click tries again.
 * @param {string} [tab] - The tab to open on.
 * @returns {Promise<void>} Resolves once it is open, or the load has failed.
 */
export async function openMachineSettings(tab) {
  if (!settingsLoaded) settingsLoaded = import('../js/components/machine-settings-panel.js');
  try {
    await settingsLoaded;
  } catch (err) {
    settingsLoaded = null;
    console.error('[sessions page] could not load Settings:', err);
    return;
  }
  openSettings(tab);
}

/**
 * One of the header's icon buttons.
 * @param {string} className - Its own class, which draws its glyph (layout/app-shell.css).
 * @param {string} label - What it does, for its tooltip and assistive technology.
 * @returns {HTMLButtonElement} The button.
 */
function iconButton(className, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `btn-ghost btn-icon-header ${className}`;
  button.title = label;
  button.setAttribute('aria-label', label);
  return button;
}

/**
 * Draw the header buttons into slot and wire them.
 * @param {HTMLElement} slot - Where they go, at the header's end before the caption buttons.
 * @param {object} options
 * @param {boolean} options.settings - Whether to offer Settings: a viewer on this machine only.
 * @param {(appearance: {mode: string, zoom: number}) => void} [options.onAppearance] -
 *   Told the theme and zoom whenever either changes.
 * @param {(tab?: string) => (void|Promise<void>)} [options.open] - Opens Settings; a test passes a spy.
 * @returns {() => void} Takes them down.
 */
export function mountHeaderButtons(slot, { settings, onAppearance = () => {}, open = openMachineSettings }) {
  const zoomOutButton = iconButton('zoom-out-button', t('Decrease font size'));
  zoomOutButton.id = 'zoom-out-button';
  const zoomInButton = iconButton('zoom-in-button', t('Increase font size'));
  zoomInButton.id = 'zoom-in-button';
  const zoomGroup = document.createElement('div');
  zoomGroup.className = 'header-zoom';
  zoomGroup.setAttribute('role', 'group');
  zoomGroup.setAttribute('aria-label', t('Font size'));
  zoomGroup.append(zoomOutButton, zoomInButton);

  const themeButton = iconButton('theme-button', '');
  themeButton.id = 'theme-button';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 -960 960 960');
  svg.setAttribute('aria-hidden', 'true');
  svg.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'path'));
  themeButton.appendChild(svg);
  renderThemeButton(themeButton);

  const viewGroup = document.createElement('div');
  viewGroup.className = 'header-group';
  viewGroup.append(zoomGroup, themeButton);
  const controls = document.createElement('div');
  controls.className = 'header-actions-controls';
  controls.appendChild(viewGroup);

  /** @type {Array<() => void>} */
  const undo = [];
  const listen = (/** @type {EventTarget} */ target, /** @type {string} */ type, /** @type {EventListener} */ fn) => {
    target.addEventListener(type, fn);
    undo.push(() => target.removeEventListener(type, fn));
  };
  const told = () => onAppearance(currentAppearance());
  const stepIn = () => { zoomIn(); told(); };
  const stepOut = () => { zoomOut(); told(); };

  listen(zoomInButton, 'click', stepIn);
  listen(zoomOutButton, 'click', stepOut);
  listen(window, 'juggler:zoom-in', stepIn);
  listen(window, 'juggler:zoom-out', stepOut);
  undo.push(keyShortcutManager.register('zoom-in', () => { stepIn(); return true; }));
  undo.push(keyShortcutManager.register('zoom-out', () => { stepOut(); return true; }));
  listen(themeButton, 'click', () => { toggleTheme(); });
  // Follow the theme rather than assume the click caused it: Settings and the
  // OS change it too.
  listen(document, THEME_MODE_EVENT, () => {
    renderThemeButton(themeButton);
    told();
  });

  if (settings) {
    const settingsButton = iconButton('settings-button', t('Settings'));
    settingsButton.id = 'settings-button';
    const appGroup = document.createElement('div');
    appGroup.className = 'header-group header-group--app';
    appGroup.appendChild(settingsButton);
    controls.appendChild(appGroup);
    listen(settingsButton, 'click', () => { void open(); });
    undo.push(keyShortcutManager.register('open-settings', () => { void open(); return true; }));
    undo.push(keyShortcutManager.register('show-shortcuts', () => { void open('shortcuts'); return true; }));
  }

  slot.replaceChildren(controls);
  return () => {
    for (const fn of undo.splice(0)) fn();
    slot.replaceChildren();
  };
}

/**
 * Wear the theme and zoom the page framing this one hands it
 * ({@link APPEARANCE_EVENT}, dispatched on win by relayFramerEvents).
 * @param {Window} win - This page's window.
 * @returns {() => void} Stops following.
 */
export function followFramerAppearance(win) {
  const onAppearance = (/** @type {Event} */ e) => {
    const detail = /** @type {{mode?: unknown, zoom?: unknown}|null} */ (/** @type {CustomEvent} */ (e).detail);
    const mode = detail?.mode;
    if (mode === MODES.SYSTEM || mode === MODES.LIGHT || mode === MODES.DARK) {
      if (mode !== getMode()) setMode(mode);
    }
    const zoom = detail?.zoom;
    if (typeof zoom === 'number' && zoom > 0 && zoom !== getCurrentZoom()) setZoomLevel(zoom);
  };
  win.addEventListener(APPEARANCE_EVENT, onAppearance);
  return () => win.removeEventListener(APPEARANCE_EVENT, onAppearance);
}
