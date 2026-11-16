//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Skills service — fetches the Agent Skills catalog from the backend.
 *
 * A skill is a directory following the open Agent Skills standard: a SKILL.md
 * (YAML frontmatter + markdown instructions) plus optional scripts/, references/,
 * and assets/. The backend discovers them across native roots — `.juggler/skills`
 * and `.agents/skills`, in user and project scope — and exposes:
 *
 *   GET /api/skills                         → metadata for every skill (no bodies)
 *   GET /api/skills/{scope}/{source}/{name} → one skill's SKILL.md body + file listing
 *
 * Metadata is always cheap and rides the system prompt (progressive disclosure);
 * a body is loaded only when the model activates the skill via the `skill` tool.
 * Malformed skills carry an `error` string and shadowed ones a `shadowedBy`
 * origin — both surface in the manager UI rather than being dropped.
 *
 * This module works unchanged in a viewer and in the engine worker: `fetch` to a
 * same-origin `/api/*` path carries the `X-Juggler-Token` header via the worker's
 * fetch shim, so no SDK facade / worker twin is required.
 * @module services/skills
 */

import { fetchJson } from './http.js';
import { SEND_LOOKUP_TIMEOUT_MS } from '../utils/constants.js';
import { apiUrl } from '../utils/api-url.js';

/**
 * @typedef {object} SkillFrontmatter
 * @property {string} [name] - Declared skill name (must equal the directory name)
 * @property {string} [description] - What it does AND when to use it (required)
 * @property {string} [license] - License name or bundled file reference
 * @property {string} [compatibility] - Environment requirements
 * @property {string} [allowedTools] - Space-separated pre-approved tools (surfaced read-only; NOT honored in v1)
 * @property {boolean} [disableModelInvocation] - Only the user may start it (`disable-model-invocation: true`)
 */

/**
 * @typedef {object} SkillMeta
 * @property {string} name - Skill name (= directory name; the activation id)
 * @property {string} description - Effective description (from frontmatter)
 * @property {'user'|'project'} scope - Provenance scope
 * @property {'juggler'|'agents'} source - Provenance root within the scope
 * @property {string} path - Absolute on-disk skill directory
 * @property {SkillFrontmatter} frontmatter - Parsed frontmatter
 * @property {boolean} hasScripts - Whether a scripts/ subdirectory exists
 * @property {boolean} hasReferences - Whether a references/ subdirectory exists
 * @property {string} [shadowedBy] - "<scope>-<source>" of the higher-precedence skill that shadows this one
 * @property {string} [error] - Set when the skill failed to parse/validate
 * @property {boolean} [disableModelInvocation] - A conversation's frozen snapshot
 *   row carries the frontmatter flag here, at the top level
 */

/**
 * @typedef {object} SkillFile
 * @property {string} path - Forward-slash path relative to the skill directory
 * @property {number} size - File size in bytes
 */

/**
 * @typedef {object} SkillDetail
 * @property {string} name - Skill name
 * @property {'user'|'project'} scope - Provenance scope
 * @property {'juggler'|'agents'} source - Provenance root
 * @property {string} path - Absolute skill directory
 * @property {string} body - Full SKILL.md instruction body (frontmatter stripped)
 * @property {SkillFile[]} files - Listing of files under the skill directory
 */

/** @type {SkillMeta[]|null} */
let cached = null;

/**
 * Fetch the skill catalog from the backend (metadata only; cached after first
 * call so the system-prompt block stays byte-stable across turns). The cache is
 * dropped by {@link resetSkillsCache} on a registry reload.
 *
 * Time-boxed because the composer resolves `$name` mentions through this on the
 * send path, and a page reload (which a reconnect performs) empties the cache —
 * so the first send after a flaky connection recovers would otherwise wait out
 * the browser's full network timeout with the message still in the box. A
 * failure resolves to an empty list and is NOT cached, so the next call retries.
 * @returns {Promise<SkillMeta[]>} Discovered skills (may include invalid/shadowed ones)
 */
export async function fetchSkills() {
  if (cached) {
    return cached;
  }
  const result = await fetchJson(apiUrl('/skills'), {
    errorPrefix: '[Skills] Failed to fetch skills',
    fallback: null,
    timeoutMs: SEND_LOOKUP_TIMEOUT_MS,
  });
  if (result === null) return [];
  cached = Array.isArray(result) ? result : [];
  return cached;
}

/**
 * The effective skill set the model can activate: valid (no `error`) and not
 * shadowed by a higher-precedence root. Sorted by name for a stable, cache-
 * friendly system-prompt listing. The manager UI reads the raw {@link fetchSkills}
 * list instead so it can also show broken and shadowed skills.
 * @returns {Promise<SkillMeta[]>} Activatable skills, name-sorted
 */
export async function getAvailableSkills() {
  const all = await fetchSkills();
  return all
    .filter((s) => !s.error && !s.shadowedBy)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Whether only the user may start a skill: its author set
 * `disable-model-invocation: true`. Such a skill is offered to `$name` and the
 * composer's picker but kept out of the model's "## Skills" list, and the `skill`
 * tool loads it only on the user's behalf. Reads a catalog row (the flag in its
 * frontmatter) or a conversation's frozen snapshot row (the flag at the top).
 * @param {{disableModelInvocation?: boolean, frontmatter?: SkillFrontmatter}} skill - Catalog or snapshot row
 * @returns {boolean} True when the model may not start it
 */
export function isUserOnlySkill(skill) {
  return skill.disableModelInvocation === true || skill.frontmatter?.disableModelInvocation === true;
}

/**
 * Fetch one skill's SKILL.md body and directory listing.
 * @param {'user'|'project'} scope - Provenance scope
 * @param {'juggler'|'agents'} source - Provenance root
 * @param {string} name - Skill name
 * @returns {Promise<SkillDetail>} The skill body + file listing
 * @throws {Error} On a non-OK response (unknown skill, bad scope/source), the
 *   request's own `HttpError` with no prefix: the settings preview words
 *   it for the user and the `skill` tool in English for the model.
 */
export async function fetchSkillBody(scope, source, name) {
  const url = apiUrl(`/skills/${encodeURIComponent(scope)}/${encodeURIComponent(source)}/${encodeURIComponent(name)}`);
  return await fetchJson(url);
}

/**
 * Reset the cached catalog. Called by reload-registries.js and tests so a
 * subsequent fetch re-reads the backend.
 */
export function resetSkillsCache() {
  cached = null;
}
