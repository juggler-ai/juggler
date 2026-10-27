//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Guidance facts — what the app has found out this page that a hint may
 * depend on, reported once by the code that already knows it, so no hint has to
 * find it out again (a hint never fetches, probes or queries anything itself).
 *
 * The usage record ({@link module:services/guidance/usage-signals}) is about
 * the person and lasts; a fact is about the state of things now and lives as
 * long as the page. Like usage, the names are a closed set ({@link FACTS}), so
 * the nudge catalogue can say exactly what it reads.
 *
 * Feature code calls {@link reportFact} and nothing else here.
 * @module services/guidance/facts
 */

/**
 * Every fact, by name, and what its key and value are.
 * @type {Readonly<Record<string, string>>}
 */
export const FACTS = Object.freeze({
  // Key: conversation id. Value: how many agent instruction files
  // (AGENTS.md, CLAUDE.md, …) the conversation seeder found for it.
  'instruction-files': 'conversation id → instruction files found',
});

/** Fired on `window` when a fact is reported. */
export const FACTS_CHANGED_EVENT = 'juggler:guidance-facts-changed';

/** @type {Map<string, Map<string, any>>} */
const known = new Map();

/**
 * Report a fact.
 * @param {string} name - One of {@link FACTS}.
 * @param {string} key - What it is about (see {@link FACTS}).
 * @param {any} value
 * @returns {void}
 */
export function reportFact(name, key, value) {
  if (!Object.prototype.hasOwnProperty.call(FACTS, name)) throw new Error(`unknown guidance fact: ${name}`);
  let byKey = known.get(name);
  if (!byKey) { byKey = new Map(); known.set(name, byKey); }
  if (byKey.get(key) === value) return;
  byKey.set(key, value);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(FACTS_CHANGED_EVENT));
}

/**
 * @param {string} name
 * @param {string|undefined} key
 * @returns {any} The fact, or undefined while nothing has been reported.
 */
export function factFor(name, key) {
  return key === undefined ? undefined : known.get(name)?.get(key);
}

/** The read-only view of facts that guidance rules are given. */
export const facts = Object.freeze({ get: factFor });

/** @typedef {typeof facts} FactsView */
