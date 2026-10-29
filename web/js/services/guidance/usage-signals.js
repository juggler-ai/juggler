//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Usage signals — the one record of what this person has done in the app, kept
 * so guidance can stop explaining what they already know. It is the only place
 * usage is counted: feature code reports an event with {@link recordUsage} at a
 * choke point (the shortcut dispatcher, the slash-command handler, the composer's
 * send path) and never decides anything about guidance itself.
 * What the counts mean is the nudge catalogue's business
 * ({@link module:services/guidance/nudge-catalogue}).
 *
 * The record stays on this machine's settings file, in the `User` realm of
 * services/prefs.js (it is a fact about the person, shared by their windows).
 * Nothing sends it anywhere.
 *
 * It is deliberately small, because a `ui` preference has a size cap and every
 * change is a settings write:
 * - event names are a closed set ({@link isUsageEvent}): a fixed list plus
 *   `shortcut:<id>` and `slash:<id>`;
 * - a count saturates at {@link COUNT_CAP}, and distinct days at
 *   {@link DAY_CAP} — no guidance needs a larger number, and a saturated
 *   counter on a day already known writes nothing;
 * - counts from two windows recorded at once can lose an increment. Guidance
 *   only asks "ever", "a few times" or "on a few days", so that is harmless.
 *
 * A store writes nothing until it has read what was stored (see
 * {@link createUsageStore}'s `hydrate`), so a window whose cache is still empty
 * cannot replace the record with a fresh one.
 * @module services/guidance/usage-signals
 */

import { getUserPref, cachedUserPref, setUserPref, notifyPrefChanged, reconcilePref } from '../prefs.js';

/** The user preference holding the record. */
const PREF_NAME = 'juggler-usage';

/** Preferences an older build kept, read once to seed the first record. */
const LEGACY_TIPS_PREF = 'juggler-tips';
const LEGACY_WORD_OF_MOUTH_PREF = 'juggler-word-of-mouth-usage';

/** Fired on `window` whenever the record changes, here or in another window. */
export const USAGE_CHANGED_EVENT = 'juggler:usage-changed';

/** The largest count kept for one event. */
const COUNT_CAP = 50;

/** The most distinct local days counted for one event. */
const DAY_CAP = 14;

/**
 * Events with no id part. `shortcut:<id>` (a key shortcut that acted) and
 * `slash:<id>` (a slash command that ran) complete the set.
 */
const FIXED_EVENTS = new Set([
  'composer:send',     // a message the user wrote in a composer and sent (not a slash command)
]);

const ID_PREFIXES = ['shortcut:', 'slash:'];

/**
 * @param {string} name
 * @returns {boolean} Whether `name` is an event this store keeps.
 */
export function isUsageEvent(name) {
  if (typeof name !== 'string') return false;
  if (FIXED_EVENTS.has(name)) return true;
  return ID_PREFIXES.some((p) => name.startsWith(p) && /^[a-z0-9][a-z0-9-]*$/i.test(name.slice(p.length)));
}

/**
 * One event's counter: `n` the count, `f` first use (epoch ms), `d` distinct
 * local days, `ld` the last of them (`YYYY-MM-DD`).
 * @typedef {{n: number, f: number, d: number, ld: string}} Counter
 */

/**
 * @typedef {object} UsageState
 * @property {1} v - Shape version.
 * @property {number} since - When this record was started (epoch ms).
 * @property {true} [veteran] - The record was started for someone who had used
 *   an older build, whose usage it never saw.
 * @property {Record<string, Counter>} e - Counters by event name.
 */

/**
 * @param {number} ms
 * @returns {string} The local calendar day, `YYYY-MM-DD`.
 */
function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * @param {any} raw
 * @returns {UsageState|null} A well-formed state, or null for anything else.
 */
function normalise(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== 1 || !raw.e || typeof raw.e !== 'object') return null;
  /** @type {Record<string, Counter>} */
  const e = {};
  for (const [name, c] of Object.entries(raw.e)) {
    if (!isUsageEvent(name) || !c || typeof c !== 'object') continue;
    const counter = /** @type {any} */ (c);
    e[name] = {
      n: Math.min(COUNT_CAP, Math.max(0, Number(counter.n) || 0)),
      f: Number(counter.f) || 0,
      d: Math.min(DAY_CAP, Math.max(0, Number(counter.d) || 0)),
      ld: typeof counter.ld === 'string' ? counter.ld : '',
    };
  }
  return {
    v: 1,
    since: Number(raw.since) || 0,
    ...(raw.veteran === true ? { veteran: true } : {}),
    e,
  };
}

/**
 * The first record for someone this store has never seen, built from what an
 * older build kept: the tips "seen" set (each a shortcut that was used) and the
 * word-of-mouth send days. Either existing means they used the app before this
 * record began, so the record is marked `veteran`.
 * @param {{tips: any, wordOfMouth: any}} legacy - The raw legacy preferences, or nulls.
 * @param {number} now
 * @returns {UsageState} The seeded record.
 */
export function migrateLegacyUsage({ tips, wordOfMouth }, now) {
  /** @type {UsageState} */
  const state = { v: 1, since: now, e: {} };
  const hadTips = !!tips && typeof tips === 'object';
  const hadSends = !!wordOfMouth && Array.isArray(wordOfMouth.days);
  if (hadTips || hadSends) state.veteran = true;
  if (hadTips && Array.isArray(tips.seen)) {
    for (const id of tips.seen) {
      const name = `shortcut:${id}`;
      if (isUsageEvent(name)) state.e[name] = { n: 1, f: now, d: 1, ld: localDay(now) };
    }
  }
  if (hadSends && wordOfMouth.days.length > 0) {
    const days = wordOfMouth.days.filter((/** @type {any} */ d) => typeof d === 'string');
    state.e['composer:send'] = {
      n: Math.min(COUNT_CAP, days.length),
      f: Number(wordOfMouth.first) || now,
      d: Math.min(DAY_CAP, days.length),
      ld: days[days.length - 1] || '',
    };
  }
  return state;
}

/**
 * A usage store over storage the caller supplies. The app has one, bound to
 * preferences (the exports below); tests make their own.
 *
 * Until {@link hydrate} is called the store answers from what it has recorded
 * so far and writes nothing; `hydrate` replays those records onto the stored
 * state and then writes once.
 * @param {object} opts
 * @param {(state: UsageState) => void} opts.save - Persist the whole state.
 * @param {() => number} [opts.now] - Clock (epoch ms).
 * @param {boolean} [opts.strict] - Throw on an unknown event name (tests); otherwise it is ignored.
 * @param {() => void} [opts.onChange] - Called after every change.
 * @returns {{
 *   record: (event: string) => void,
 *   count: (event: string) => number,
 *   first: (event: string) => number|null,
 *   days: (event: string) => number,
 *   any: (prefix: string) => boolean,
 *   isVeteran: () => boolean,
 *   hydrate: (stored: any, legacy?: {tips: any, wordOfMouth: any}) => void,
 *   reload: (stored: any) => void,
 * }} The store.
 */
export function createUsageStore({ save, now = Date.now, strict = false, onChange = () => {} }) {
  /** @type {UsageState} */
  let state = { v: 1, since: now(), e: {} };
  let hydrated = false;
  /** @type {Array<{event: string, at: number}>} */
  let early = [];

  /**
   * Apply one record to `state`.
   * @param {string} event
   * @param {number} at
   * @returns {boolean} Whether anything changed.
   */
  const apply = (event, at) => {
    const day = localDay(at);
    const c = state.e[event];
    if (!c) {
      state.e[event] = { n: 1, f: at, d: 1, ld: day };
      return true;
    }
    let changed = false;
    if (c.n < COUNT_CAP) { c.n++; changed = true; }
    if (c.ld !== day) {
      c.ld = day;
      if (c.d < DAY_CAP) c.d++;
      changed = true;
    }
    return changed;
  };

  const store = {
    /**
     * @param {string} event
     * @returns {void}
     */
    record(event) {
      if (!isUsageEvent(event)) {
        if (strict) throw new Error(`unknown usage event: ${event}`);
        return;
      }
      const at = now();
      if (!hydrated) early.push({ event, at });
      if (!apply(event, at)) return;
      if (hydrated) save(state);
      onChange();
    },
    /**
     * @param {string} event
     * @returns {number} How often it has happened (saturating).
     */
    count(event) { return state.e[event]?.n ?? 0; },
    /**
     * @param {string} event
     * @returns {number|null} When it first happened, or null.
     */
    first(event) { return state.e[event]?.f ?? null; },
    /**
     * @param {string} event
     * @returns {number} On how many distinct local days it has happened (saturating).
     */
    days(event) { return state.e[event]?.d ?? 0; },
    /**
     * @param {string} prefix - e.g. `slash:`.
     * @returns {boolean} Whether any event under `prefix` has happened.
     */
    any(prefix) { return Object.entries(state.e).some(([k, c]) => k.startsWith(prefix) && c.n > 0); },
    /** @returns {boolean} Whether this record began for someone who already used the app. */
    isVeteran() { return state.veteran === true; },
    /**
     * Adopt the stored state (or, when nothing is stored, the one seeded from
     * the legacy preferences), replay what was recorded meanwhile, and write.
     * @param {any} stored - The stored preference, or null.
     * @param {{tips: any, wordOfMouth: any}} [legacy]
     * @returns {void}
     */
    hydrate(stored, legacy) {
      const base = normalise(stored) ?? ((stored === null || stored === undefined) && legacy ? migrateLegacyUsage(legacy, now()) : null);
      state = base ?? { v: 1, since: now(), e: {} };
      hydrated = true;
      for (const { event, at } of early) apply(event, at);
      early = [];
      if (JSON.stringify(state) !== JSON.stringify(stored ?? null)) save(state);
      onChange();
    },
    /**
     * Take a newer stored state written by another window.
     * @param {any} stored
     * @returns {void}
     */
    reload(stored) {
      const next = normalise(stored);
      if (!next || !hydrated) return;
      state = next;
      onChange();
    },
  };
  return store;
}

const appStore = createUsageStore({
  save: (state) => { void setUserPref(PREF_NAME, state); },
  onChange: () => notifyPrefChanged(USAGE_CHANGED_EVENT),
});

/**
 * Report that this person did something. The only way usage reaches guidance.
 * @param {string} event - A name {@link isUsageEvent} accepts.
 * @returns {void}
 */
export function recordUsage(event) { appStore.record(event); }

/**
 * @param {string} event
 * @returns {number} How often it has happened (saturating at {@link COUNT_CAP}).
 */
export function usageCount(event) { return appStore.count(event); }

/**
 * @param {string} event
 * @returns {number|null} When it first happened (epoch ms), or null.
 */
export function usageFirst(event) { return appStore.first(event); }

/**
 * @param {string} event
 * @returns {number} Distinct local days it happened on (saturating at {@link DAY_CAP}).
 */
export function usageDays(event) { return appStore.days(event); }

/**
 * @param {string} prefix
 * @returns {boolean} Whether any event under `prefix` has happened.
 */
function anyUsage(prefix) { return appStore.any(prefix); }

/** @returns {boolean} Whether this person used the app before usage was recorded. */
function isVeteranUser() { return appStore.isVeteran(); }

/** The read-only view of the app's record that guidance rules are given. */
export const usage = Object.freeze({
  count: usageCount,
  first: usageFirst,
  days: usageDays,
  any: anyUsage,
  isVeteran: isVeteranUser,
});

/** @typedef {typeof usage} UsageView */

/**
 * What prefs.js fires when another window changes the stored record. Not
 * {@link USAGE_CHANGED_EVENT}: the store fires that itself after adopting it,
 * and one name for both would have every change re-read itself forever.
 */
const STORED_CHANGED_EVENT = 'juggler:usage-stored-changed';

// Read the stored record (and, the first time, the legacy preferences it is
// seeded from) at boot; another window's change arrives as a preference event.
if (typeof document !== 'undefined') {
  void Promise.all([
    getUserPref(PREF_NAME, null),
    getUserPref(LEGACY_TIPS_PREF, null),
    getUserPref(LEGACY_WORD_OF_MOUTH_PREF, null),
  ]).then(([stored, tips, wordOfMouth]) => {
    appStore.hydrate(stored, { tips, wordOfMouth });
    window.addEventListener(STORED_CHANGED_EVENT, () => appStore.reload(cachedUserPref(PREF_NAME, null)));
    void reconcilePref('user', PREF_NAME, STORED_CHANGED_EVENT);
  }).catch(() => { /* No record this page; guidance stays as for a new user. */ });
}
