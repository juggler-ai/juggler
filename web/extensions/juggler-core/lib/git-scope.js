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

import { translator, markForTranslation } from 'juggler/i18n';

const t = translator('@juggler/core');

/** The scope a pin with none set reviews: the working tree against HEAD. */
export const DEFAULT_SCOPE = '@uncommitted';

/**
 * The scope that compares the working tree against the start of a
 * conversation's current turn. It is the one scope that needs a conversation as
 * well as a tree.
 */
export const TURN_SCOPE = '@turn';

/** How long a scope may be, matching the server's own ceiling. */
const SCOPE_MAX_LENGTH = 256;

/** How many custom expressions a pin offers again. */
const RECENT_SCOPES = 8;

/**
 * The comparisons offered by name, in the order the control lists them. Labels
 * and descriptions are English source text, translated where they are drawn.
 * @type {ReadonlyArray<{id: string, label: string, description: string}>}
 */
export const SCOPE_PRESETS = Object.freeze([
  {
    id: '@uncommitted',
    label: markForTranslation('Working tree'),
    description: markForTranslation('Working tree against HEAD, staged and unstaged together'),
  },
  { id: '@staged', label: markForTranslation('Staged'), description: markForTranslation('Staged against HEAD') },
  {
    id: '@unstaged',
    label: markForTranslation('Unstaged'),
    description: markForTranslation('Working tree against the index'),
  },
  {
    id: '@branch',
    label: markForTranslation('Branch'),
    description: markForTranslation('Working tree against the merge-base with the default branch'),
  },
  {
    id: '@last',
    label: markForTranslation('Last commit'),
    description: markForTranslation('Last commit against its parent'),
  },
  {
    id: TURN_SCOPE,
    label: markForTranslation("This turn's changes"),
    description: markForTranslation('Working tree against the start of this turn'),
  },
]);

/** What the custom field accepts, said once where it is typed (English source text). */
export const SCOPE_SYNTAX = markForTranslation('A git diff expression: main...HEAD, main..feature, HEAD~3, '
  + '--merge-base main, --cached [rev], --worktree');

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
 * What to call a scope in a few words: a preset by its name, in the active
 * locale, an expression as typed.
 * @param {string} scope - A normalized scope.
 * @returns {string} The name.
 */
export function scopeName(scope) {
  const preset = scopePreset(scope);
  return preset ? t(preset.label) : scope;
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
 * default so a pin that never chose one keeps the config it always had, and
 * the tree it shows. A pin that follows the visible conversation carries no
 * tree. One the agent opened on a workspace carries `workspace`. One the user
 * fixed to a tree by hand carries `workspace` with `follow: false`, and
 * there `workspace: ''` is the project's tree — the one tree whose id is ''.
 * An {@link TURN_SCOPE} pin carries `conv`, the conversation whose turn it
 * compares: the one named, else the one that asked for the pin. Without either
 * it compares the visible conversation's turn. No other scope carries one.
 * @param {Record<string, unknown>} parameters - What the agent or the user gave.
 * @param {{conversationId?: string}} [origin] - Who asked: the conversation that
 *   opened the pin, when an agent did.
 * @returns {Record<string, unknown>} The normalized parameters.
 */
export function normalizeGitPinParameters(parameters, origin) {
  const scope = normalizeScope(parameters?.scope);
  const workspace = pinnedWorkspace(parameters);
  const byHand = parameters?.follow === false;
  const conv = scope === TURN_SCOPE ? (turnConversation(parameters) || (origin?.conversationId || '').trim()) : '';
  return {
    ...(byHand ? { workspace, follow: false } : workspace ? { workspace } : {}),
    ...(scope === DEFAULT_SCOPE ? {} : { scope }),
    ...(conv ? { conv } : {}),
  };
}

/**
 * The conversation an {@link TURN_SCOPE} pin is fixed to.
 * @param {Record<string, unknown>|null|undefined} parameters - Its config or parameters.
 * @returns {string} The conversation id, '' for one that compares the visible
 *   conversation's turn.
 */
export function turnConversation(parameters) {
  const conv = parameters?.conv;
  return typeof conv === 'string' ? conv.trim() : '';
}

/**
 * Whether a Git pin is fixed to a tree rather than following the visible
 * conversation: it names a workspace, or was fixed by hand (to the project's
 * tree, perhaps, whose id is '').
 * @param {Record<string, unknown>|null|undefined} parameters - Its config or parameters.
 * @returns {boolean} True when it is fixed to a tree.
 */
export function isPinned(parameters) {
  return parameters?.follow === false || pinnedWorkspace(parameters) !== '';
}

/**
 * The workspace a Git pin is fixed to.
 * @param {Record<string, unknown>|null|undefined} parameters - Its config or parameters.
 * @returns {string} The workspace id, '' for the project's tree or for a pin
 *   that follows the visible conversation ({@link isPinned} tells them apart).
 */
export function pinnedWorkspace(parameters) {
  const workspace = parameters?.workspace;
  return typeof workspace === 'string' ? workspace.trim() : '';
}

/**
 * Which tree a Git pin shows, as one comparable string: '' for following, the
 * workspace id for one the agent named, and the id after '=' for one fixed by
 * hand — so the project's tree fixed by hand is not following, and the strings
 * of the first two are the ones pins have always been told apart by.
 * @param {Record<string, unknown>|null|undefined} parameters - Its config or parameters.
 * @returns {string} The key.
 */
export function treeKeyOf(parameters) {
  if (parameters?.follow === false) return `=${pinnedWorkspace(parameters)}`;
  return pinnedWorkspace(parameters);
}
