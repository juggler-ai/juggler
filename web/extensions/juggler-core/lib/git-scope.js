//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * What a Git pin compares, as its config spells it. DOM-free, because the pin's
 * agent descriptor is loaded in the engine worker and spells it too.
 *
 * A scope is a preset or a small subset of `git diff`'s own arguments. The server
 * is what reads one; this only folds the spelling, so that two pins asked for the
 * same comparison are recognised as one pin.
 * @module lib/git-scope
 */

/** The scope a pin with none set reviews: the working tree against HEAD. */
export const DEFAULT_SCOPE = '@uncommitted';

/** How long a scope may be, matching the server's own ceiling. */
export const SCOPE_MAX_LENGTH = 256;

/** How many custom expressions a pin offers again. */
export const RECENT_SCOPES = 8;

/**
 * The comparisons offered by name, in the order the control lists them.
 * @type {ReadonlyArray<{id: string, label: string, description: string}>}
 */
export const SCOPE_PRESETS = Object.freeze([
  { id: '@uncommitted', label: 'Working tree', description: 'Working tree against HEAD, staged and unstaged together' },
  { id: '@staged', label: 'Staged', description: 'Staged against HEAD' },
  { id: '@unstaged', label: 'Unstaged', description: 'Working tree against the index' },
  { id: '@branch', label: 'Branch', description: 'Working tree against the merge-base with the default branch' },
  { id: '@last', label: 'Last commit', description: 'Last commit against its parent' },
]);

/** What the custom field accepts, said once where it is typed. */
export const SCOPE_SYNTAX = 'A git diff expression: main...HEAD, main..feature, HEAD~3, '
  + '--merge-base main, --cached [rev], --worktree';

/**
 * A scope as it is stored: whitespace folded, the default for anything that is
 * not a usable string.
 * @param {unknown} raw - What the config held.
 * @returns {string} The scope.
 */
export function normalizeScope(raw) {
  if (typeof raw !== 'string') return DEFAULT_SCOPE;
  const folded = raw.trim().split(/\s+/).filter(Boolean).join(' ');
  if (!folded || folded.length > SCOPE_MAX_LENGTH) return DEFAULT_SCOPE;
  return folded;
}

/**
 * @param {string} scope - A normalized scope.
 * @returns {{id: string, label: string, description: string}|undefined} Its preset, if it is one.
 */
export function scopePreset(scope) {
  return SCOPE_PRESETS.find((preset) => preset.id === scope);
}

/**
 * What to call a scope in a few words: a preset by its name, an expression as typed.
 * @param {string} scope - A normalized scope.
 * @returns {string} The name.
 */
export function scopeName(scope) {
  return scopePreset(scope)?.label || scope;
}

/**
 * The recent expressions a config remembers, cleaned: strings, folded, unique,
 * never a preset, at most {@link RECENT_SCOPES}.
 * @param {unknown} raw - What the config held.
 * @returns {string[]} The expressions, newest first.
 */
export function normalizeRecent(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {string[]} */
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const scope = normalizeScope(entry);
    if (scope === DEFAULT_SCOPE || scopePreset(scope) || out.includes(scope)) continue;
    out.push(scope);
    if (out.length >= RECENT_SCOPES) break;
  }
  return out;
}

/**
 * A Git pin's parameters as they are stored: the scope, omitted when it is the
 * default so a pin that never chose one keeps the config it always had.
 * @param {Record<string, any>} parameters - What the agent or the user gave.
 * @returns {Record<string, any>} The normalized parameters.
 */
export function normalizeGitPinParameters(parameters) {
  const scope = normalizeScope(parameters?.scope);
  return scope === DEFAULT_SCOPE ? {} : { scope };
}
