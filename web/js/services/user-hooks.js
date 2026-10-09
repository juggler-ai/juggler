//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * User-hooks service — fetches the declarative hook files in `~/.juggler/hooks/`
 * from the backend. `GET /api/user-hooks` returns every discovered file with its
 * parsed frontmatter and body; a malformed one carries an `error` string rather
 * than being dropped. The format, and why there is no project scope, are
 * `core/user_hooks.go`'s.
 * @module services/user-hooks
 */

import { fetchJson } from './http.js';
import { apiUrl } from '../utils/api-url.js';

/**
 * @typedef {object} UserHookFrontmatter
 * @property {string} [description] - What the hook does
 * @property {'beforeTool'|'afterTool'} [event] - When it runs
 * @property {string} [tool] - Comma-separated tool names; empty = every tool
 * @property {string} [input] - Regex tested against the call's input JSON
 * @property {string} [result] - Regex tested against the result text (afterTool)
 * @property {'true'|'false'} [isError] - Failed or successful calls only (afterTool)
 * @property {'deny'|'ask'} [verdict] - Ruling (beforeTool); absent = add the body as a note
 * @property {'always'|'once-per-thread'} [repeat] - Note repetition
 */

/**
 * @typedef {object} UserHookDef
 * @property {string} name - Hook name (= filename sans .md; its id)
 * @property {'user'} scope - Provenance scope
 * @property {string} path - Absolute on-disk path
 * @property {UserHookFrontmatter} frontmatter - Parsed frontmatter
 * @property {string} body - The note (or, for a verdict, the reason)
 * @property {string} [error] - Set when the file failed to parse/validate
 */

/** @type {UserHookDef[]|null} */
let cached = null;

/**
 * Fetch the user-hook catalog from the backend (cached after first call).
 * @returns {Promise<UserHookDef[]>} Discovered hooks (may include invalid ones with `error`)
 */
export async function fetchUserHooks() {
  if (cached) return cached;
  const result = await fetchJson(apiUrl('/user-hooks'), {
    errorPrefix: '[UserHooks] Failed to fetch user hooks',
    fallback: null,
  });
  if (result === null) return [];
  cached = Array.isArray(result) ? result : [];
  return cached;
}

/**
 * Reset the cached catalog. Called by reload-registries.js and tests so a
 * subsequent fetch re-reads the backend.
 */
export function resetUserHooksCache() {
  cached = null;
}
