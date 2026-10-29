//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Theme Manager - Handles the light/dark/system theme setting.
 *
 * There are three *modes*:
 *   - 'system' (default): follow the OS light/dark setting, live.
 *   - 'light' / 'dark':   an explicit override that ignores the OS.
 * A mode resolves to a concrete *theme* ('light' or 'dark') for painting.
 *
 * The three modes are what gets stored, but only Settings offers all three by
 * name. The header button is a plain two-state light switch over them: it flips
 * the theme on screen, and a theme is pinned only while it differs from the OS
 * setting — choosing the OS's own theme stores 'system' instead. So the button
 * can never strand anyone in a fixed theme, and 'system' stays reachable
 * without ever being an option someone has to understand. See toggleTheme().
 *
 * The mode is a machine preference (services/prefs.js): it describes the screen
 * in front of the user, so every desktop window on the server's own machine
 * shares one, kept in settings.json, and any viewer on another machine — a
 * phone, or the desktop app's own window on a server elsewhere — keeps one of
 * its own and never writes back. A change made in one window of the machine
 * reaches the others through the settings broadcast.
 *
 * It is applied before first paint, so it cannot wait for the realm: the page
 * starts from what it was handed (startingMachinePref, which index.html's
 * pre-paint block mirrors) and reconciles when the realm answers. What it can be
 * handed: the machine's mode (window.__machineThemeMode, server-injected), a
 * ?mode= seed from the window that opened this one, the mode the project
 * session stored before the machine had one (window.__projectThemeMode, adopted
 * once by the server's own window), and this device's cache.
 *
 * A ?theme= seed is a colour, not a mode: the native host bakes the last colour
 * it painted into every window's URL so the first frame of a 'system' window
 * matches, and taken as a mode it would pin a window that follows the OS to
 * whichever colour the OS happened to be showing.
 */

import { windowControlURL } from '../../sdk/lib/window-control.js';
import { onDocumentReady } from './document-ready.js';
import { fetchJson } from '../services/http.js';
import {
  ownsServerPrefs, startingMachinePref, cachedMachinePref, setMachinePref, reconcilePref,
} from '../services/prefs.js';

/** The mode's name in the machine realm. */
const THEME_PREF = 'juggler-theme';

/** Announces that the machine realm's mode changed (see prefs.reconcilePref). */
const THEME_PREF_EVENT = 'juggler-theme-pref-changed';

/**
 * This device's record of the OS light/dark setting, in localStorage. Not
 * project-scoped, unlike THEME_KEY_BASE: the OS setting belongs to the device,
 * and every project on it sees the same one. Written whenever the document is
 * painted in 'system' mode, where the painted theme is the OS theme reconciled
 * with the native host. Read by knownSystemTheme().
 */
const SYSTEM_THEME_KEY = 'juggler-system-theme';

/** Concrete themes the document can be painted as. */
const THEMES = {
  DARK: 'dark',
  LIGHT: 'light'
};

/** Selectable modes: 'system' follows the OS; the others pin a theme. */
export const MODES = {
  SYSTEM: 'system',
  LIGHT: 'light',
  DARK: 'dark'
};

/**
 * Fired on document whenever the painted theme or the mode changes, from
 * whatever cause — a click, Settings, the OS, or the host's reconciliation.
 * Anything displaying the current theme should follow this rather than read the
 * mode once. detail: {mode, theme}.
 */
export const THEME_MODE_EVENT = 'theme-mode-changed';

/**
 * Resolve the OS-level colour-scheme preference.
 * @returns {string} 'light' if the OS prefers light, otherwise 'dark'
 * @private
 */
function systemTheme() {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches
    ? THEMES.LIGHT
    : THEMES.DARK;
}

/**
 * The other concrete theme.
 * @param {string} theme - 'dark' or 'light'.
 * @returns {string} 'light' for 'dark', and 'dark' for anything else.
 * @private
 */
function otherTheme(theme) {
  return theme === THEMES.DARK ? THEMES.LIGHT : THEMES.DARK;
}

/** The mode in use, resolved at init and updated on every change. */
let current = MODES.SYSTEM;

/**
 * Get the user's selected mode: 'system' until something says otherwise, so the
 * default is to follow the OS.
 * @returns {string} One of MODES.
 */
export function getMode() {
  return current;
}

/**
 * The concrete theme currently painted on the document ('dark' or 'light'),
 * read straight from the data-theme attribute. Unlike re-resolving 'system' via
 * matchMedia — unreliable in a native macOS window whose prefers-color-scheme is
 * pinned by the window's forced appearance, so it can report the opposite of
 * what's on screen — this returns what is actually
 * displayed, already reconciled with the native host (see applyTheme). Use it
 * when handing a resolved theme to a child window so the child inherits exactly
 * what the source shows rather than a stale matchMedia guess.
 * @returns {string} 'dark' or 'light'.
 */
export function getPaintedTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light'
    ? THEMES.LIGHT
    : THEMES.DARK;
}

/**
 * Whether s is a theme mode the app understands.
 * @param {unknown} s
 * @returns {s is string} True when s is 'system', 'light', or 'dark'.
 * @private
 */
function isMode(s) {
  return s === MODES.SYSTEM || s === MODES.LIGHT || s === MODES.DARK;
}

/**
 * A mode the server injected into the page, if it is one.
 * @param {unknown} m - The injected value.
 * @returns {string|null} One of MODES, or null.
 * @private
 */
function injectedMode(m) {
  return isMode(m) ? m : null;
}

/**
 * The theme *mode* inherited from the window that opened this one (a ?mode= param
 * the native host bakes into the URL). It carries 'system' faithfully, so a
 * window opened from an 'auto' window stays on 'auto' and follows the OS rather
 * than being pinned to whatever the parent was resolving to at the moment. Null
 * when absent.
 * @returns {string|null} One of MODES, or null.
 * @private
 */
function seedMode() {
  try {
    const m = new URL(window.location.href).searchParams.get('mode');
    return isMode(m) ? m : null;
  } catch (_e) {
    return null;
  }
}

/**
 * This client's own stored mode, as known right now: the machine's in the
 * server's own window, this device's copy in any other viewer.
 * @returns {string|null} One of MODES, or null.
 * @private
 */
function storedMode() {
  const m = cachedMachinePref(THEME_PREF, null);
  return isMode(m) ? m : null;
}

/**
 * Record the OS light/dark setting for this device (best-effort).
 * @param {string} theme - The OS theme, 'dark' or 'light'.
 * @private
 */
function rememberSystemTheme(theme) {
  try {
    localStorage.setItem(SYSTEM_THEME_KEY, theme);
  } catch (_e) {
    /* best-effort — a lost record just falls back to the invariant below */
  }
}

/**
 * The OS light/dark setting, as well as this window can know it.
 *
 * matchMedia can't be asked: a native macOS window's forced appearance pins the
 * WKWebView's prefers-color-scheme, and WebKitGTK derives it from the toolkit
 * theme rather than the desktop preference, so in a pinned mode it tends to
 * report the pin back. Instead this uses what the app has already been told:
 *
 *   - in 'system' mode the painted theme IS the OS theme — applyTheme has
 *     reconciled it with the native host, the only reliable reader there is;
 *   - otherwise the value last observed that way, recorded per device;
 *   - failing that, the invariant that a theme is pinned only because it
 *     differs from the OS, so the OS is showing the other one.
 *
 * The record goes stale if the OS setting changes while every window is pinned,
 * which macOS reports to nobody. The cost is one toggle that appears to do
 * nothing, after which the mode is 'system' and the setting is known again.
 * @returns {string} 'dark' or 'light'.
 * @private
 */
function knownSystemTheme() {
  if (getMode() === MODES.SYSTEM) return getPaintedTheme();
  const seen = localStorage.getItem(SYSTEM_THEME_KEY);
  return seen === THEMES.LIGHT || seen === THEMES.DARK
    ? seen
    : otherTheme(getPaintedTheme());
}

/**
 * Store a mode and apply the theme it resolves to. In the server's own window it
 * becomes the machine's, and every desktop window on this computer follows; in
 * any other viewer it stays on that device and the host is left alone.
 * @param {string} mode - One of MODES.
 */
export function setMode(mode) {
  if (!isMode(mode)) return;
  current = mode;
  void setMachinePref(THEME_PREF, mode);
  applyTheme(mode === MODES.SYSTEM ? systemTheme() : mode, mode);
}

/**
 * Flip the theme on screen — the header button's whole behaviour.
 *
 * Two states are offered over the three stored underneath: the theme is pinned
 * only when it differs from the OS setting, and landing on the theme the OS is
 * already showing stores 'system' instead of pinning a matching colour. That
 * keeps the OS followed by default, means a second click always undoes the
 * first, and makes it impossible to get stuck in a fixed theme without ever
 * putting the word 'system' in front of anyone. Settings names all three modes
 * for those who do want to say it outright.
 * @returns {string} The newly-selected mode (one of MODES).
 */
export function toggleTheme() {
  const target = otherTheme(getPaintedTheme());
  const mode = target === knownSystemTheme() ? MODES.SYSTEM : target;
  setMode(mode);
  return mode;
}

/**
 * Paint the document to a resolved theme: set data-theme and the inline <html>
 * background.
 *
 * WebKit caches the canvas colour propagated from html's *CSS* background at
 * first paint and doesn't refresh it from CSS variable changes, so the strip
 * under the transparent macOS titlebar (rendered by the html canvas) stays at
 * the load-time colour. An inline style write bypasses that cache. The value is
 * read back from the just-applied theme's --bg-primary rather than hard-coded,
 * so it can't drift from the theme sheets in tokens/.
 * @param {string} theme - Resolved theme to paint ('dark' or 'light').
 * @private
 */
function paintDocument(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const bgPrimary = getComputedStyle(document.documentElement)
    .getPropertyValue('--bg-primary').trim();
  if (bgPrimary) document.documentElement.style.background = bgPrimary;
}

/**
 * Apply a resolved theme to the document and sync the native window chrome.
 *
 * The native host repaints the NSWindow chrome (background, opacity, titlebar
 * appearance); without this a light page on a dark window flashes dark during
 * every live resize. Handled in cmd/juggler-app/control.go. Only the desktop
 * app that owns this native window can repaint it, via its loopback nativeCtl
 * endpoint — windowControlURL is null for a browser tab or any page without a
 * native host, so we skip the fetch there.
 *
 * In 'system' mode the native host is authoritative for the OS light/dark
 * setting: the WKWebView's prefers-color-scheme can be pinned by the window's
 * forced appearance, so systemTheme() (matchMedia) may be stale. The host
 * clears that forced appearance and reports the true OS theme back; we repaint
 * to whatever it returns.
 * @param {string} theme - Resolved theme to paint ('dark' or 'light').
 * @param {string} mode - The active mode (one of MODES).
 * @private
 */
function applyTheme(theme, mode) {
  paintDocument(theme);
  settled(theme, mode);

  const url = windowControlURL('theme',
    '?theme=' + encodeURIComponent(theme) + '&mode=' + encodeURIComponent(mode));
  if (!url) return;
  fetchJson(url, { method: 'POST', fallback: null })
    .then((data) => {
      if (mode !== MODES.SYSTEM) return;
      // System mode: repaint to the host's authoritative OS theme if it differs
      // from our (possibly appearance-pinned) guess. Don't re-post — the host
      // has already painted its chrome to match.
      const osTheme = data && data.theme;
      if ((osTheme === THEMES.DARK || osTheme === THEMES.LIGHT)
          && osTheme !== document.documentElement.getAttribute('data-theme')) {
        paintDocument(osTheme);
        settled(osTheme, mode);
      }
    });
}

/**
 * Record what a paint settled on and announce it.
 *
 * A paint in 'system' mode is also the app's one sighting of the OS setting, so
 * it is remembered here for the pinned periods when nothing can read it (see
 * knownSystemTheme). The event is dispatched from this single point so every
 * cause of a repaint — a click, Settings, an OS change, the host's echo —
 * reaches the button and the settings control the same way.
 * @param {string} theme - The theme now painted ('dark' or 'light').
 * @param {string} mode - The active mode (one of MODES).
 * @private
 */
function settled(theme, mode) {
  if (mode === MODES.SYSTEM) rememberSystemTheme(theme);
  document.dispatchEvent(new CustomEvent(THEME_MODE_EVENT, { detail: { mode, theme } }));
}

/**
 * Adopt the machine realm's mode when another window of this machine changed it
 * (or, at boot, when the realm knew something the cache did not). A viewer on
 * another machine reads its own copy here, so the host's changes move it only
 * until it has chosen one.
 * @private
 */
function followStoredMode() {
  const mode = storedMode();
  if (mode === null || mode === current) return;
  current = mode;
  applyTheme(mode === MODES.SYSTEM ? systemTheme() : mode, mode);
}

/**
 * Initialize theme on page load
 */
function initTheme() {
  // Where this page starts — the rule index.html's pre-paint block has already
  // painted from (see the module comment and prefs.startingMachinePref). The
  // project session's mode is offered only to the server's own window: it is
  // that machine's choice from before the machine realm held one, adopted once.
  const owner = ownsServerPrefs();
  const start = startingMachinePref({
    owner,
    machine: injectedMode(window.__machineThemeMode),
    inherited: [seedMode(), owner ? injectedMode(window.__projectThemeMode) : null],
    device: storedMode(),
    fallback: MODES.SYSTEM,
  });
  current = start.value;
  applyTheme(current === MODES.SYSTEM ? systemTheme() : current, current);
  if (start.adopt) void setMachinePref(THEME_PREF, current);

  window.addEventListener(THEME_PREF_EVENT, followStoredMode);
  void reconcilePref('machine', THEME_PREF, THEME_PREF_EVENT);

  // In 'system' mode, follow OS light/dark changes live. An explicit
  // light/dark mode pins the theme and ignores the OS.
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (getMode() === MODES.SYSTEM) {
      applyTheme(systemTheme(), MODES.SYSTEM);
    }
  });

  // The embedded desktop webview (notably WebKitGTK on Linux) derives
  // prefers-color-scheme from the app toolkit theme, not the desktop's live
  // light/dark preference, so the matchMedia 'change' above never fires there
  // when the desktop is toggled. The native host watches the OS preference
  // directly and pushes this event; in 'system' mode we re-resolve and repaint
  // (applyTheme re-reads the host's authoritative OS theme). Harmless on
  // platforms that never emit it.
  window.addEventListener('juggler:system-theme-changed', () => {
    if (getMode() === MODES.SYSTEM) {
      applyTheme(systemTheme(), MODES.SYSTEM);
    }
  });
}

// Auto-initialize when module loads. Theming is a viewer affordance; the engine
// worker has no document to theme, so onDocumentReady skips off the main thread.
onDocumentReady(initTheme);
