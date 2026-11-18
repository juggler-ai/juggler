//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * How a header's theme button looks: a session's (services/ui-event-manager.js)
 * and the sessions page's (web/machine/header-buttons.js) draw it the same.
 * @module utils/theme-button
 */

import { getPaintedTheme } from './theme-manager.js';
import { t, markForTranslation } from '../../sdk/lib/i18n.js';

/**
 * Header theme-button presentation per painted theme: the Material Symbols
 * glyph (light_mode / dark_mode, viewBox 0 -960 960 960) and the tooltip,
 * which names the theme on screen and the one a click moves to.
 *
 * The button is a light switch, so it deals only in the two colours — the
 * 'system' mode behind them is Settings' business, and the button shows
 * whichever colour system resolved to. See toggleTheme() in theme-manager.js.
 * @type {Record<string, {path: string, title: string}>}
 */
const THEME_BUTTON_UI = {
  light: {
    path: 'M579-381q41-41 41-99t-41-99q-41-41-99-41t-99 41q-41 41-41 99t41 99q41 41 99 41t99-41Zm-240.5 42.5Q280-397 280-480t58.5-141.5Q397-680 480-680t141.5 58.5Q680-563 680-480t-58.5 141.5Q563-280 480-280t-141.5-58.5ZM200-450H40v-60h160v60Zm720 0H760v-60h160v60ZM450-760v-160h60v160h-60Zm0 720v-160h60v160h-60ZM262-658l-100-97 43-44 96 100-39 41Zm494 496-98-100 41-41 99 98-42 43Zm-99-537 98-99 44 42-99 98-43-41ZM162-205l99-98 42 42-98 99-43-43Zm318-275Z',
    title: markForTranslation('Theme: Light — click for Dark')
  },
  dark: {
    path: 'M480-120q-150 0-255-105T120-480q0-150 105-255t255-105q8 0 17 .5t23 1.5q-36 32-56 79t-20 99q0 90 63 153t153 63q52 0 99-18.5t79-51.5q1 12 1.5 19.5t.5 14.5q0 150-105 255T480-120Zm0-60q109 0 190-67.5T771-406q-25 11-53.67 16.5Q688.67-384 660-384q-114.69 0-195.34-80.66Q384-545.31 384-660q0-24 5-51.5t18-62.5q-98 27-162.5 109.5T180-480q0 125 87.5 212.5T480-180Zm-4-297Z',
    title: markForTranslation('Theme: Dark — click for Light')
  }
};

/**
 * Paint a theme button's icon and tooltip for the theme on screen. The button
 * holds one inline <svg> with one <path>.
 * @param {HTMLElement} button - The theme button element.
 * @returns {void}
 */
export function renderThemeButton(button) {
  const ui = THEME_BUTTON_UI[getPaintedTheme()] || THEME_BUTTON_UI.dark;
  if (!ui) return;
  button.querySelector('path')?.setAttribute('d', ui.path);
  const title = t(ui.title);
  button.title = title;
  button.setAttribute('aria-label', title);
}
