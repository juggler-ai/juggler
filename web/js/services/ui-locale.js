//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ui-locale — choosing the UI language, and bringing the engine along.
 *
 * The choice is `uiLocale` in the global settings document (settings.json): the
 * person's, not a project's or a window's. A viewer never applies it at
 * runtime. The server writes it into the page with that language's catalogue
 * before the first paint (serveIndex), and web/sdk/lib/i18n.js reads both when
 * it loads — so choosing a language saves it and reloads the window that chose
 * it, and every other window hears the settings broadcast and reloads itself
 * once it is idle ({@link createUILocaleReloader}). Rendering is done once per
 * element throughout the UI, so a live switch would leave the screen half in
 * each language.
 *
 * The engine has no page to be handed anything in, and the same code runs in a
 * webview worker and under Node, so it asks: {@link followUILocale} reads the
 * setting and the catalogues (core and every extension's) over the API and
 * follows the settings broadcast. Extension catalogues in a viewer arrive with
 * the extension list instead (services/extension-catalogs.js).
 * @module services/ui-locale
 */

import { fetchJson } from './http.js';
import wsService from './websocket.js';
import { apiUrl } from '../utils/api-url.js';
import { applyCatalogBody } from './extension-catalogs.js';
import { setLocale, markForTranslation, PSEUDO_LOCALE } from '../../sdk/lib/i18n.js';
import { isDesktopWindow, postWindowControl } from '../../sdk/lib/window-control.js';

/**
 * One entry in the Language menu. An entry with `lang` is a language named in
 * itself: its label is shown as it is and marked as that language. One without
 * has an English source label, translated where the menu is rendered.
 * @typedef {{value: string, label: string, lang?: string}} UILocaleChoice
 */

/**
 * The entry the menu always opens with. English is named in English like every
 * other language is named in itself, so someone who reads only English finds it
 * in a menu drawn in any other language. It also stands for the default (no
 * language chosen), which is English: see {@link uiLocaleMenuValue}.
 * @type {UILocaleChoice}
 */
// i18n-ignore: a language's name in that language, which no catalogue translates
const ENGLISH_CHOICE = Object.freeze({ value: 'en', label: 'English', lang: 'en' });

/**
 * The pseudo-locale's entry, offered in dev mode only.
 * @type {UILocaleChoice}
 */
const PSEUDO_CHOICE = Object.freeze({ value: PSEUDO_LOCALE, label: markForTranslation('Pseudo-locale (en-XA)') });

/**
 * A language's name in that language — "Français" for fr — capitalised as a
 * menu entry is, or the tag itself when the browser cannot name it.
 * @param {string} tag - A BCP 47 tag.
 * @returns {string} The name.
 */
function localeEndonym(tag) {
  try {
    const name = new Intl.DisplayNames([tag], { type: 'language', fallback: 'code' }).of(tag);
    if (!name || name.toLowerCase() === tag.toLowerCase()) return tag;
    return name.charAt(0).toLocaleUpperCase(tag) + name.slice(1);
  } catch {
    return tag;
  }
}

/**
 * The Language menu, in order: English, each available language named in
 * itself, then the pseudo-locale when asked for. The page's own
 * language joins the end when it is none of those, so the menu can show what
 * is in use.
 * @param {ReadonlyArray<string>} available - The server's languages ({@link fetchUILocales}).
 * @param {{pseudo?: boolean, current?: string}} [opts] - Whether to offer the
 *   pseudo-locale; the page's language.
 * @returns {UILocaleChoice[]} The entries.
 */
export function uiLocaleChoices(available, { pseudo = false, current = '' } = {}) {
  /** @type {UILocaleChoice[]} */
  const choices = [ENGLISH_CHOICE];
  for (const tag of available) {
    if (!choices.some((c) => c.value === tag)) choices.push({ value: tag, label: localeEndonym(tag), lang: tag });
  }
  if (pseudo || current === PSEUDO_LOCALE) choices.push(PSEUDO_CHOICE);
  if (current && !choices.some((c) => c.value === current)) {
    choices.push({ value: current, label: localeEndonym(current), lang: current });
  }
  return choices;
}

/**
 * The menu entry that shows a page's language: the language itself, or English
 * for a page with none chosen, since that is what such a page is shown in.
 * @param {string} current - The page's language ({@link pageUILocale}); '' for none.
 * @returns {string} The entry's value.
 */
export function uiLocaleMenuValue(current) {
  return current || ENGLISH_CHOICE.value;
}

/**
 * The UI languages the server has a catalogue for (`GET /api/i18n/locales`),
 * beside English and the pseudo-locale; none when it cannot say.
 * @returns {Promise<string[]>} BCP 47 tags, in the server's order.
 */
export async function fetchUILocales() {
  const body = await fetchJson(apiUrl('/i18n/locales'), { fallback: null });
  const locales = /** @type {any} */ (body)?.locales;
  return Array.isArray(locales) ? locales.filter((l) => typeof l === 'string') : [];
}

/**
 * The UI language this page was served in: '' for the default.
 * @returns {string} A BCP 47 tag, or ''.
 */
export function pageUILocale() {
  if (typeof document === 'undefined') return '';
  return document.documentElement.getAttribute('data-ui-locale') || '';
}

/**
 * Tell the desktop app hosting this window the UI language the page was served
 * in, so its menus, dialogs and choosers speak it too. Sent once as the page
 * loads; a language change reloads the page, which sends it again. A browser tab
 * has no host and sends nothing.
 * @param {string} [locale] - The page's language; '' (the default) is English.
 * @param {(endpoint: string, query: string) => void} [post] - How to post; a test passes a spy.
 * @param {() => boolean} [isDesktop] - Whether a host is there to tell.
 * @returns {void}
 */
export function reportUILocale(locale = pageUILocale(), post = postWindowControl, isDesktop = isDesktopWindow) {
  if (!isDesktop()) return;
  post('locale', '?locale=' + encodeURIComponent(locale || 'en'));
}

/**
 * Whether this window is choosing a language: set from the save until it is
 * known whether this window reloads. One that does stays set, so the settings
 * broadcast of its own choice — which may arrive before the save answers —
 * starts no second reload ({@link createUILocaleReloader}).
 */
let choosing = false;

/**
 * Save the UI language and reload this window into it. Nothing reloads when the
 * page is already in that language.
 * @param {string} locale - A BCP 47 tag, or '' for the default.
 * @param {() => void} [reload] - How to reload; a test passes a spy.
 * @returns {Promise<void>} Resolves once saved (and the reload requested).
 */
export async function chooseUILocale(locale, reload = () => window.location.reload()) {
  choosing = true;
  try {
    await fetchJson(apiUrl('/settings'), { method: 'PUT', body: { uiLocale: locale } });
  } catch (err) {
    choosing = false;
    throw err;
  }
  if (locale !== pageUILocale()) {
    reload();
  } else {
    choosing = false;
  }
}

/**
 * How often a window waiting to reload into a new UI language asks again
 * whether it is idle.
 * @type {number}
 */
const IDLE_RECHECK_MS = 1000;

/**
 * @typedef {object} UILocaleReloader
 * @property {(locale: string) => void} update - Take the UI language from a
 *   settings broadcast. A language other than the page's starts the wait (or
 *   leaves one already waiting alone); the page's own language calls it off.
 * @property {() => boolean} pending - Whether a reload is waiting for the window
 *   to be idle.
 * @property {() => void} dispose - Stop waiting and ignore every later update.
 */

/**
 * Reload this window into a UI language another window chose, once nothing
 * would be lost or interrupted by it.
 *
 * The window is idle when no turn it can see is running, nothing (a modal, a
 * menu) is open over the page, and no keystrokes in a composer are still
 * waiting to be saved as a draft. Until then it asks again every
 * {@link IDLE_RECHECK_MS}, for as long as it takes. It reloads at most once.
 *
 * The window that made the choice reloads straight away instead
 * ({@link chooseUILocale}); while a choice it made is in hand, this stands down.
 * @param {object} opts
 * @param {() => boolean} opts.isBusy - A turn is running.
 * @param {() => boolean} opts.isModalOpen - A modal or menu is open.
 * @param {() => boolean} opts.hasUnsavedDraft - Typing is yet to be saved.
 * @param {() => void} opts.reload - Reload the window.
 * @param {() => string} [opts.pageLocale] - The language the page was served in.
 * @param {() => boolean} [opts.isChoosing] - This window chose a language and
 *   is reloading into it itself.
 * @param {(fn: () => void, ms: number) => any} [opts.setTimer] - Schedule a re-check.
 * @param {(id: any) => void} [opts.clearTimer] - Cancel one.
 * @returns {UILocaleReloader} The reloader.
 */
export function createUILocaleReloader({
  isBusy, isModalOpen, hasUnsavedDraft, reload,
  pageLocale = pageUILocale,
  isChoosing = () => choosing,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
}) {
  let wanted = false;
  let done = false;
  /** @type {any} */
  let timer = null;

  const stop = () => {
    wanted = false;
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const check = () => {
    timer = null;
    if (!wanted || done) return;
    if (isChoosing()) {
      stop();
      return;
    }
    if (isBusy() || isModalOpen() || hasUnsavedDraft()) {
      timer = setTimer(check, IDLE_RECHECK_MS);
      return;
    }
    stop();
    done = true;
    reload();
  };

  return {
    update(locale) {
      if (done) return;
      if ((locale || '') === pageLocale() || isChoosing()) {
        stop();
        return;
      }
      if (wanted) return;
      wanted = true;
      check();
    },
    pending: () => wanted,
    dispose() {
      stop();
      done = true;
    },
  };
}

/** The locale the engine last applied; null before the first. */
let engineLocale = /** @type {string|null} */ (null);

/**
 * Apply a UI language in the engine: fetch its catalogues — core and every
 * extension's — then switch. A later call supersedes one whose fetch is still
 * in flight.
 * @param {string} locale - A BCP 47 tag, or '' for the default.
 * @returns {Promise<void>} Resolves once applied.
 */
async function applyEngineUILocale(locale) {
  const next = locale || '';
  if (next === engineLocale) return;
  engineLocale = next;
  /** @type {any} */
  let body = null;
  if (next) {
    body = await fetchJson(apiUrl(`/i18n/catalog?locale=${encodeURIComponent(next)}`), { fallback: null });
    if (engineLocale !== next) return;
  }
  applyCatalogBody(next, body);
  setLocale(next);
}

/**
 * Take up the UI language in the engine, and follow it when it changes. Call
 * once, at engine start.
 * @returns {Promise<void>} Resolves once the current setting is applied.
 */
export async function followUILocale() {
  wsService.on('settings-changed', (/** @type {any} */ settings) => {
    void applyEngineUILocale(typeof settings?.uiLocale === 'string' ? settings.uiLocale : '');
  });
  const settings = await fetchJson(apiUrl('/settings'), { fallback: null });
  await applyEngineUILocale(typeof settings?.uiLocale === 'string' ? settings.uiLocale : '');
}
