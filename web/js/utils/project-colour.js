//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The colour a project is known by: what its windows are bordered in
 * (utils/window-border.js), and what its tile wears on the session switcher
 * and the project chip — one colour per project wherever it shows, so a
 * window and its row are matched at a glance.
 *
 * A project is named by its storage key (`window.__projectKey` on its own
 * page, `projectKey` on a sessions row; core.ProjectStorageKey), a hash of its
 * path: stable across restarts and ports, new on a move or rename.
 *
 * Every project has an automatic colour, a stable hash of its key onto the
 * palette, which nothing stores. Two projects can land on one colour; the user
 * settles that by picking another for one of them, and only those picks are
 * stored — one `Machine`-realm map (services/prefs.js), key to colour name, so
 * every window of a project on this computer recolours at once, and a remote
 * viewer keeps its own picks. Names, not shades, are stored: the shades are
 * `--project-colour-<name>` in both theme files, which may retune them without
 * moving anyone's choice.
 *
 * The same path on two machines is the same key, so a remote `~/code/x` and a
 * local `~/code/x` share their automatic colour. Picks do not cross: the
 * desktop's live in its settings.json and a remote viewer's in its own
 * storage, which is per origin — except over the studio relay, where one
 * origin fronts every machine and a viewer's pick for the path holds on all of
 * them.
 * @module utils/project-colour
 */

import { markForTranslation, t } from '../../sdk/lib/i18n.js';
import { cachedMachinePref, setMachinePref, notifyPrefChanged, reconcilePref } from '../services/prefs.js';
import { fnv1a } from './workspace-colour.js';

/**
 * The palette, in the order the automatic colour indexes it and the border
 * menu shows it. Appending a colour moves automatic colours, so the order and
 * the length only ever change on purpose. Keep in step with the
 * `--project-colour-*` tokens in css/tokens/theme-dark.css and theme-light.css.
 */
export const PROJECT_COLOURS = Object.freeze([
  'orange', 'yellow', 'lime', 'green', 'teal', 'blue', 'purple', 'pink',
]);

/** What each colour is called, for its swatch's name. */
const COLOUR_NAMES = {
  orange: markForTranslation('Orange'),
  yellow: markForTranslation('Yellow'),
  lime: markForTranslation('Lime'),
  green: markForTranslation('Green'),
  teal: markForTranslation('Teal'),
  blue: markForTranslation('Blue'),
  purple: markForTranslation('Purple'),
  pink: markForTranslation('Pink'),
};

/** The `Machine` preference holding the picked colours: key → colour name. */
export const PROJECT_COLOURS_PREF = 'juggler-project-colours';

/** Fired on window whenever a project's colour may have changed. */
export const PROJECT_COLOURS_EVENT = 'juggler:project-colours-changed';

/**
 * How many picks are kept. The map is one value in settings.json's `ui`
 * section, which caps a value's size (core.MergeUIPrefs), and a write over it
 * would be refused whole — so the oldest pick makes room for a new one.
 */
const MAX_PICKS = 200;

/**
 * This page's project key, as its server injected it.
 * @returns {string} The key, or '' on a page with no project.
 */
export function thisProjectKey() {
  return (typeof window === 'undefined' ? '' : window.__projectKey) || '';
}

/**
 * Whether a name is one of the palette's colours.
 * @param {unknown} name - The candidate.
 * @returns {name is string} True for a palette colour.
 */
function isColour(name) {
  return typeof name === 'string' && PROJECT_COLOURS.includes(name);
}

/**
 * A project's automatic colour: its key hashed onto the palette.
 * @param {string} key - The project's storage key.
 * @returns {string} A palette colour name.
 */
export function automaticProjectColour(key) {
  return PROJECT_COLOURS[fnv1a(key) % PROJECT_COLOURS.length] ?? 'teal';
}

/**
 * Every project's picked colour, as known now. Anything that is not a palette
 * colour — a name a later build retired, a damaged value — counts as no pick.
 * @returns {Record<string, string>} Key → colour name.
 */
function picks() {
  const stored = cachedMachinePref(PROJECT_COLOURS_PREF, null);
  /** @type {Record<string, string>} */
  const out = {};
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out;
  for (const [key, name] of Object.entries(stored)) {
    if (key && isColour(name)) out[key] = name;
  }
  return out;
}

/**
 * The colour picked for a project, if one was.
 * @param {string} key - The project's storage key.
 * @returns {string|null} A palette colour name, or null for automatic.
 */
export function pickedProjectColour(key) {
  return (key && picks()[key]) || null;
}

/**
 * A project's colour: the one picked for it, else its automatic one.
 * @param {string} key - The project's storage key.
 * @returns {string} A palette colour name.
 */
export function projectColour(key) {
  return pickedProjectColour(key) ?? automaticProjectColour(key);
}

/**
 * The CSS value a colour is drawn with, in the theme on screen.
 * @param {string} name - A palette colour name.
 * @returns {string} A `var()` of its token.
 */
export function projectColourValue(name) {
  return `var(--project-colour-${isColour(name) ? name : PROJECT_COLOURS[0]})`;
}

/**
 * A colour's name, in the UI language.
 * @param {string} name - A palette colour name.
 * @returns {string} What it is called.
 */
export function projectColourLabel(name) {
  return isColour(name) ? t(COLOUR_NAMES[/** @type {keyof typeof COLOUR_NAMES} */ (name)]) : name;
}

/**
 * Pick a project's colour for every window of it on this machine, or go back
 * to its automatic one.
 * @param {string} key - The project's storage key.
 * @param {string|null} name - A palette colour name, or null for automatic.
 * @returns {Promise<void>} Resolves when the write has been sent.
 */
export function setProjectColour(key, name) {
  if (!key) return Promise.resolve();
  const next = picks();
  // Deleted first either way, so a re-pick moves to the end and is the last to
  // make room.
  delete next[key];
  if (isColour(name)) next[key] = name;
  const keys = Object.keys(next);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_PICKS))) delete next[old];
  const written = setMachinePref(PROJECT_COLOURS_PREF, Object.keys(next).length ? next : null);
  notifyPrefChanged(PROJECT_COLOURS_EVENT);
  return written;
}

// Ask for the picks at boot; a pick made in another window arrives with the
// settings document and is announced on the same event.
if (typeof document !== 'undefined') {
  void reconcilePref('machine', PROJECT_COLOURS_PREF, PROJECT_COLOURS_EVENT);
}
