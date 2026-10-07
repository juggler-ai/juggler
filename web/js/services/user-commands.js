//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * User-commands service — fetches the declarative user-defined slash-command
 * catalog from the backend.
 *
 * A user command is a markdown file (YAML frontmatter + prompt-template body)
 * under `~/.juggler/commands/` (user scope) or `<project>/.juggler/commands/`
 * (project scope). `GET /api/user-commands` returns every discovered definition
 * with its parsed frontmatter and body — malformed ones carry an `error` string
 * rather than being dropped. This service is the single frontend entry point the
 * command registry and the manager UI read.
 * @module services/user-commands
 */

import { fetchJson } from './http.js';
import { apiUrl } from '../utils/api-url.js';

/**
 * Allowed command name (= filename sans .md): lowercase, starting with a
 * letter, using only letters, digits, and hyphens. Mirrors the server's
 * userCommandNamePattern (core/user_commands.go) — the single frontend
 * definition; the editor dialog and the define_command tool both use it.
 * @type {RegExp}
 */
export const USER_COMMAND_NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * @typedef {object} UserCommandFrontmatter
 * @property {string} [description] - Menu help text (required; absence flags the command invalid)
 * @property {string} [argsHint] - Ghost-text hint shown after accepting the command
 * @property {string} [run] - Execution mode: 'send' (default) | 'draft' | 'subthread'
 * @property {string} [strategy] - Strategy id override (subthread only)
 * @property {string} [provider] - Provider serving the model override (subthread only)
 * @property {string} [model] - Model id override (subthread only; resolved by id when no provider is given)
 * @property {string} [thinking] - Thinking level for the model override (subthread only)
 * @property {string} [serviceTier] - Serving tier for the model override (subthread only)
 * @property {string} [icon] - Menu icon CSS class
 * @property {string} [goal] - Thread goal label (subthread only)
 */

/**
 * @typedef {object} UserCommandDef
 * @property {string} name - Command name (= filename sans .md; the slash id)
 * @property {'user'|'project'} scope - Provenance scope
 * @property {string} path - Absolute on-disk path
 * @property {UserCommandFrontmatter} frontmatter - Parsed frontmatter
 * @property {string} body - Prompt-template body
 * @property {string} [error] - Set when the file failed to parse/validate
 */

/** @type {UserCommandDef[]|null} */
let cached = null;

/**
 * Fetch the user-command catalog from the backend (cached after first call).
 * @returns {Promise<UserCommandDef[]>} Discovered commands (may include invalid ones with `error`)
 */
export async function fetchUserCommands() {
  if (cached) {
    return cached;
  }
  const result = await fetchJson(apiUrl('/user-commands'), {
    errorPrefix: '[UserCommands] Failed to fetch user commands',
    fallback: null,
  });
  if (result === null) return [];
  cached = Array.isArray(result) ? result : [];
  return cached;
}

/**
 * The registerable definitions: valid (no `error`) commands with project scope
 * shadowing user scope on a name collision. This is what the command registry
 * synthesises classes from — the manager UI reads the raw {@link fetchUserCommands}
 * list instead so it can show broken and shadowed definitions.
 * @returns {Promise<UserCommandDef[]>} Registerable definitions, project-shadowed
 */
export async function getRegisterableUserCommands() {
  const all = await fetchUserCommands();
  /** @type {Map<string, UserCommandDef>} */
  const byName = new Map();
  for (const def of all) {
    if (def.error) continue; // broken definition — not registerable
    const existing = byName.get(def.name);
    // Project scope wins over user scope; otherwise first-seen holds.
    if (!existing || (existing.scope === 'user' && def.scope === 'project')) {
      byName.set(def.name, def);
    }
  }
  return Array.from(byName.values());
}

/**
 * Write (create or overwrite) a user command via the backend. Returns the
 * server response: the saved command on success, or `{errors}` (field→message)
 * on a 400 validation failure. Throws only on a transport/5xx error.
 * @param {'user'|'project'} scope - Target scope
 * @param {string} name - Command name (validated server-side)
 * @param {{description?: string, argsHint?: string, run?: string, strategy?: string, provider?: string, model?: string, thinking?: string, serviceTier?: string, icon?: string, goal?: string, template: string}} body - Write request
 * @returns {Promise<{ok: boolean, status: number, data: any}>} Result envelope
 */
export async function writeUserCommand(scope, name, body) {
  const response = await fetch(apiUrl(`/user-commands/${encodeURIComponent(scope)}/${encodeURIComponent(name)}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { ok: response.ok, status: response.status, data };
}

/**
 * Delete a user command via the backend. Idempotent (a missing file succeeds).
 * @param {'user'|'project'} scope - Target scope
 * @param {string} name - Command name
 * @returns {Promise<boolean>} True on success
 */
export async function deleteUserCommand(scope, name) {
  const response = await fetch(apiUrl(`/user-commands/${encodeURIComponent(scope)}/${encodeURIComponent(name)}`), {
    method: 'DELETE',
  });
  return response.ok;
}

/**
 * Reset the cached catalog. Called by reload-registries.js and tests so a
 * subsequent fetch re-reads the backend.
 */
export function resetUserCommandsCache() {
  cached = null;
}
