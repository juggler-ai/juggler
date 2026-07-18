//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
/* eslint-disable jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns, jsdoc/require-returns-description, jsdoc/require-property-description, jsdoc/escape-inline-tags */
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Generic permission storage with two scopes:
 *
 *   - session:      project-wide, stored as JSON in session.metadata
 *   - conversation: this conversation tab, stored in the conversation Yjs doc
 *
 * Plugins consume a merged view via `messageThread.getRulesFor(...)` and
 * remain scope-agnostic. UI code can inspect/toggle `scope`.
 * @module model/message-thread-permissions
 */

import { approvePermittedPendingApprovals } from './conversation-tool-actions.js';

/**
 * @typedef {'session'|'conversation'} PermissionScope
 */

/**
 * @typedef {object} PermissionRule
 * @property {string} id
 * @property {string} itemType
 * @property {string} kind
 * @property {any} value
 * @property {PermissionScope} [scope]
 */

/**
 * @typedef {object} AllowedPathEntry
 * @property {string} id
 * @property {string} path
 * @property {PermissionScope} [scope]
 * @property {boolean} [implicit] Derived project-root entry: always present, session-wide, not editable or removable.
 */

export const SCOPE_SESSION = 'session';
export const SCOPE_CONVERSATION = 'conversation';

export const SESSION_RULES_KEY = 'sessionPermissionRules';
export const SESSION_PATHS_KEY = 'sessionAllowedPaths';
export const CONVERSATION_RULES_KEY = 'conversationPermissionRules';
export const CONVERSATION_PATHS_KEY = 'conversationAllowedPaths';

function newRuleId() {
  return 'r_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function newPathId() {
  return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** @param {any} mt @param {string} itemType @param {PermissionScope|undefined} requested @returns {PermissionScope} */
function defaultScopeFor(mt, itemType, requested) {
  const policy = mt.getPermissionScopePolicy?.(itemType);
  if (requested && policy?.allowedScopes?.includes?.(requested)) return requested;
  if (policy?.allowedScopes && !policy.allowedScopes.includes(policy.defaultScope)) return policy.allowedScopes[0] || SCOPE_CONVERSATION;
  return policy?.defaultScope || SCOPE_CONVERSATION;
}

/** @param {any} mt @param {string} itemType @param {PermissionScope} scope @returns {boolean} */
function scopeAllowedFor(mt, itemType, scope) {
  const policy = mt.getPermissionScopePolicy?.(itemType);
  return !policy?.allowedScopes || policy.allowedScopes.includes(scope);
}

/** @param {any} v @returns {any} */
function plain(v) { return v?.toJSON ? v.toJSON() : v; }

/** @param {any} mt @returns {Record<string, any>} */
function sessionMetadata(mt) {
  return mt.conversation?.session?.metadata || {};
}

/** @param {any} mt @returns {PermissionRule[]} */
function getSessionRules(mt) {
  const stored = sessionMetadata(mt)[SESSION_RULES_KEY];
  return Array.isArray(stored) ? stored.map(r => normalizeRule(r, SCOPE_SESSION)) : [];
}

/** @param {any} mt @returns {PermissionRule[]} */
function getConversationRules(mt) {
  const stored = plain(mt.conversation.getMetadata(CONVERSATION_RULES_KEY));
  if (Array.isArray(stored)) return stored.map(r => normalizeRule(r, SCOPE_CONVERSATION));
  return getDefaultRules(mt).map(r => normalizeRule(r, SCOPE_CONVERSATION));
}

/** @param {any} r @param {PermissionScope} fallbackScope @returns {PermissionRule} */
function normalizeRule(r, fallbackScope) {
  return {
    id: r.id || syntheticRuleId(r),
    itemType: r.itemType,
    kind: r.kind,
    value: r.value,
    scope: r.scope === SCOPE_SESSION ? SCOPE_SESSION : fallbackScope
  };
}

/** @param {any} mt @returns {PermissionRule[]} */
export function getAllRules(mt) {
  return [...getSessionRules(mt), ...getConversationRules(mt)];
}

/** @param {any} mt @param {string} itemType @returns {PermissionRule[]} */
export function getRulesFor(mt, itemType) {
  return getAllRules(mt).filter(r => r.itemType === itemType);
}

/** @param {any} a @param {any} b @returns {boolean} */
function sameRuleIdentity(a, b) {
  return a.itemType === b.itemType && a.kind === b.kind && a.value === b.value;
}

/** @param {any} mt @param {PermissionRule[]} rules */
function saveConversationRules(mt, rules) {
  const normalized = rules.map(r => normalizeRule(r, SCOPE_CONVERSATION));
  mt.conversation.setMetadata(CONVERSATION_RULES_KEY, normalized);
  approvePermittedPendingApprovals(mt.conversation, {
    allowViewer: true,
    itemTypes: [...new Set(normalized.map(r => r.itemType))]
  });
}

/** @param {any} mt @param {PermissionRule[]} rules */
function saveSessionRules(mt, rules) {
  const session = mt.conversation?.session;
  const normalized = rules.map(r => normalizeRule(r, SCOPE_SESSION));
  if (session?.patchMetadata) session.patchMetadata({ [SESSION_RULES_KEY]: normalized });
  else if (session) session.metadata = { ...(session.metadata || {}), [SESSION_RULES_KEY]: normalized };
}

/** @param {any} mt @param {PermissionScope} scope @returns {PermissionRule[]} */
function readRulesByScope(mt, scope) {
  return scope === SCOPE_SESSION ? getSessionRules(mt) : getConversationRules(mt);
}

/** @param {any} mt @param {PermissionScope} scope @param {PermissionRule[]} rules */
function saveRulesByScope(mt, scope, rules) {
  if (scope === SCOPE_SESSION) saveSessionRules(mt, rules);
  else saveConversationRules(mt, rules);
}

/**
 * Add a new rule. Defaults to conversation scope unless `rule.scope` is set.
 * Dedupe checks both scopes so identical rules are not shown twice.
 * @param {any} mt
 * @param {string} itemType
 * @param {Partial<PermissionRule> & {kind: string, value: any}} rule
 * @returns {PermissionRule}
 */
export function addRule(mt, itemType, rule) {
  const scope = defaultScopeFor(mt, itemType, rule.scope);
  const desired = normalizeRule({ ...rule, id: rule.id || newRuleId(), itemType, scope }, scope);
  const existing = getAllRules(mt).find(r => sameRuleIdentity(r, desired));
  if (existing) return existing;
  const rules = readRulesByScope(mt, scope);
  rules.push(desired);
  saveRulesByScope(mt, scope, rules);
  return desired;
}

/** @param {any} mt @param {string} ruleId @returns {{scope: PermissionScope, rules: PermissionRule[], index: number}|null} */
function locateRule(mt, ruleId) {
  for (const scope of /** @type {PermissionScope[]} */ ([SCOPE_SESSION, SCOPE_CONVERSATION])) {
    const rules = readRulesByScope(mt, scope);
    const index = rules.findIndex(r => r.id === ruleId);
    if (index !== -1) return { scope, rules, index };
  }
  return null;
}

/** @param {any} mt @param {string} ruleId @returns {boolean} */
export function removeRule(mt, ruleId) {
  const hit = locateRule(mt, ruleId);
  if (!hit) return false;
  const next = hit.rules.slice();
  next.splice(hit.index, 1);
  saveRulesByScope(mt, hit.scope, next);
  return true;
}

/** @param {any} mt @param {string} ruleId @param {Partial<PermissionRule>} patch @returns {boolean} */
export function updateRule(mt, ruleId, patch) {
  const hit = locateRule(mt, ruleId);
  if (!hit) return false;
  const next = hit.rules.slice();
  const cur = /** @type {PermissionRule} */ (next[hit.index]);
  next[hit.index] = normalizeRule({ ...cur, ...patch, id: cur.id, itemType: cur.itemType }, hit.scope);
  saveRulesByScope(mt, hit.scope, next);
  return true;
}

/** @param {any} mt @param {string} ruleId @param {PermissionScope} targetScope @returns {boolean} */
export function setRuleScope(mt, ruleId, targetScope) {
  const target = targetScope === SCOPE_SESSION ? SCOPE_SESSION : SCOPE_CONVERSATION;
  const hit = locateRule(mt, ruleId);
  if (!hit) return false;
  if (hit.scope === target) return true;
  const rule = normalizeRule({ ...hit.rules[hit.index], scope: target }, target);
  if (!scopeAllowedFor(mt, rule.itemType, target)) return false;
  const sourceNext = hit.rules.slice();
  sourceNext.splice(hit.index, 1);
  const targetRules = readRulesByScope(mt, target);
  const duplicate = targetRules.find(r => sameRuleIdentity(r, rule));
  // Write the destination before removing the source so live popup renderers
  // never see the row disappear and re-enter at a different position.
  if (!duplicate) saveRulesByScope(mt, target, [...targetRules, rule]);
  saveRulesByScope(mt, hit.scope, sourceNext);
  return true;
}

/** @param {any} mt @param {string} itemType */
export function clearRules(mt, itemType) {
  saveConversationRules(mt, getConversationRules(mt).filter(r => r.itemType !== itemType));
  saveSessionRules(mt, getSessionRules(mt).filter(r => r.itemType !== itemType));
}

// ============================================================================
// Allowed paths
// ============================================================================

/** @param {any} mt @returns {AllowedPathEntry[]} */
function getSessionPathEntries(mt) {
  const stored = sessionMetadata(mt)[SESSION_PATHS_KEY];
  return Array.isArray(stored) ? stored.map(p => normalizePathEntry(p, SCOPE_SESSION)) : [];
}

/** @param {any} mt @returns {AllowedPathEntry[]} */
function getConversationPathEntries(mt) {
  const stored = plain(mt.conversation.getMetadata(CONVERSATION_PATHS_KEY));
  if (Array.isArray(stored)) return stored.map(p => normalizePathEntry(p, SCOPE_CONVERSATION));
  return getDefaultAllowedPaths(mt).map(path => ({ id: defaultPathId(path), path, scope: SCOPE_CONVERSATION }));
}

/** @param {any} p @param {PermissionScope} fallbackScope @returns {AllowedPathEntry} */
function normalizePathEntry(p, fallbackScope) {
  if (typeof p === 'string') return { id: defaultPathId(p), path: p, scope: fallbackScope };
  return {
    id: p.id || defaultPathId(p.path || ''),
    path: p.path || p.value || '',
    scope: p.scope === SCOPE_SESSION ? SCOPE_SESSION : fallbackScope
  };
}

/** @param {string} path @returns {string} */
function defaultPathId(path) { return `path:${path}`; }

/**
 * The project root is an implicit, always-present, session-wide allowed path
 * derived from `session.projectPath`. It is never persisted and cannot be
 * toggled or removed — every tab in the project shares it.
 * @param {any} mt @returns {AllowedPathEntry|null}
 */
function getProjectRootEntry(mt) {
  const projectPath = mt.conversation?.session?.projectPath;
  if (!projectPath) return null;
  return { id: defaultPathId(projectPath), path: projectPath, scope: SCOPE_SESSION, implicit: true };
}

/** @param {any} mt @returns {AllowedPathEntry[]} */
export function getAllowedPathEntries(mt) {
  const root = getProjectRootEntry(mt);
  const stored = [...getSessionPathEntries(mt), ...getConversationPathEntries(mt)].filter(p => p.path);
  if (!root) return stored;
  // The implicit project root is listed first; any stored entry equal to it
  // (e.g. a legacy per-tab copy) collapses into the implicit one.
  return [root, ...stored.filter(p => p.path !== root.path)];
}

/** @param {any} mt @returns {string[]} */
export function getAllowedPaths(mt) {
  return getAllowedPathEntries(mt).map(p => p.path);
}

/**
 * The explicit (user-added) allowed-path grants only — session- and
 * conversation-scoped entries WITHOUT the implicit project-root entry.
 *
 * This is what travels to the non-approval-gated read/search/tree backend ops
 * as `allowedPaths`. Those ops build their PathScope rooted at the server's
 * LIVE project path (handlers.NewOpsAPI(s.ProjectPath)), so the project root is
 * already supplied authoritatively server-side and re-sending a client copy is
 * redundant — and, after a runtime project switch, unsafe: the engine is
 * persistent across SwitchProject and keeps its boot-time `session.projectPath`,
 * so the implicit root here would be the PREVIOUS project and would re-authorise
 * reads/globs/greps across the old tree. Sending explicit grants only keeps the
 * server the sole authority for the project boundary.
 * @param {any} mt @returns {string[]}
 */
export function getExplicitAllowedPaths(mt) {
  return getAllowedPathEntries(mt).filter(p => !p.implicit).map(p => p.path);
}

/** @param {any} mt @param {AllowedPathEntry[]} paths */
function saveConversationPathEntries(mt, paths) {
  mt.conversation.setMetadata(CONVERSATION_PATHS_KEY, paths.map(p => normalizePathEntry(p, SCOPE_CONVERSATION)));
  approvePermittedPendingApprovals(mt.conversation, { allowViewer: true, itemTypes: ['execute'] });
}

/** @param {any} mt @param {AllowedPathEntry[]} paths */
function saveSessionPathEntries(mt, paths) {
  const session = mt.conversation?.session;
  const normalized = paths.map(p => normalizePathEntry(p, SCOPE_SESSION));
  if (session?.patchMetadata) session.patchMetadata({ [SESSION_PATHS_KEY]: normalized });
  else if (session) session.metadata = { ...(session.metadata || {}), [SESSION_PATHS_KEY]: normalized };
}

/** @param {any} mt @param {PermissionScope} scope @returns {AllowedPathEntry[]} */
function readPathEntriesByScope(mt, scope) {
  return scope === SCOPE_SESSION ? getSessionPathEntries(mt) : getConversationPathEntries(mt);
}

/** @param {any} mt @param {PermissionScope} scope @param {AllowedPathEntry[]} paths */
function savePathEntriesByScope(mt, scope, paths) {
  if (scope === SCOPE_SESSION) saveSessionPathEntries(mt, paths);
  else saveConversationPathEntries(mt, paths);
}

/** @param {any} mt @param {string[]} paths */
export function setAllowedPaths(mt, paths) {
  saveConversationPathEntries(mt, paths.map(path => ({ id: defaultPathId(path), path, scope: SCOPE_CONVERSATION })));
}

/** @param {any} mt @param {string} p @param {{scope?: PermissionScope}} [options] @returns {boolean} */
export function addAllowedPath(mt, p, options = {}) {
  const normalized = (p || '').trim();
  if (!normalized) return false;
  if (getAllowedPathEntries(mt).some(entry => entry.path === normalized)) return false;
  const scope = options.scope === SCOPE_SESSION ? SCOPE_SESSION : SCOPE_CONVERSATION;
  /** @type {AllowedPathEntry} */
  const entry = { id: newPathId(), path: normalized, scope };
  savePathEntriesByScope(mt, scope, [...readPathEntriesByScope(mt, scope), entry]);
  return true;
}

/** @param {any} mt @param {string} idOrPath @returns {{scope: PermissionScope, paths: AllowedPathEntry[], index: number}|null} */
function locatePath(mt, idOrPath) {
  for (const scope of /** @type {PermissionScope[]} */ ([SCOPE_SESSION, SCOPE_CONVERSATION])) {
    const paths = readPathEntriesByScope(mt, scope);
    const index = paths.findIndex(p => p.id === idOrPath || p.path === idOrPath);
    if (index !== -1) return { scope, paths, index };
  }
  return null;
}

/** @param {any} mt @param {string} idOrPath @returns {boolean} */
export function removeAllowedPath(mt, idOrPath) {
  const hit = locatePath(mt, idOrPath);
  if (!hit) return false;
  const next = hit.paths.slice();
  next.splice(hit.index, 1);
  savePathEntriesByScope(mt, hit.scope, next);
  return true;
}

/** @param {any} mt @param {string} idOrPath @param {string} newPath @returns {boolean} */
export function updateAllowedPath(mt, idOrPath, newPath) {
  const normalized = (newPath || '').trim();
  if (!normalized) return false;
  const hit = locatePath(mt, idOrPath);
  if (!hit) return false;
  const next = hit.paths.slice();
  next[hit.index] = { ...(/** @type {AllowedPathEntry} */ (next[hit.index])), path: normalized };
  savePathEntriesByScope(mt, hit.scope, next);
  return true;
}

/** @param {any} mt @param {string} idOrPath @param {PermissionScope} targetScope @returns {boolean} */
export function setAllowedPathScope(mt, idOrPath, targetScope) {
  const target = targetScope === SCOPE_SESSION ? SCOPE_SESSION : SCOPE_CONVERSATION;
  const hit = locatePath(mt, idOrPath);
  if (!hit) return false;
  if (hit.scope === target) return true;
  /** @type {AllowedPathEntry} */
  const entry = { ...(/** @type {AllowedPathEntry} */ (hit.paths[hit.index])), scope: target };
  const sourceNext = hit.paths.slice();
  sourceNext.splice(hit.index, 1);
  const targetPaths = readPathEntriesByScope(mt, target);
  const duplicate = targetPaths.find(p => p.path === entry.path);
  // Write destination first so open popup row-order snapshots keep the row in
  // place while scope changes.
  if (!duplicate) savePathEntriesByScope(mt, target, [...targetPaths, entry]);
  savePathEntriesByScope(mt, hit.scope, sourceNext);
  return true;
}

// ============================================================================
// Strategy defaults
// ============================================================================

/** @param {any} mt @returns {PermissionRule[]} */
export function getDefaultRules(mt) {
  const manifest = mt.strategy?.getManifest?.();
  const defaults = Array.isArray(manifest?.defaultRules) ? manifest.defaultRules : [];
  return defaults.map((/** @type {any} */ r) => ({
    id: r.id || syntheticRuleId(r),
    itemType: r.itemType,
    kind: r.kind,
    value: r.value,
    scope: SCOPE_CONVERSATION
  }));
}

/** @param {any} r @returns {string} */
function syntheticRuleId(r) {
  const v = typeof r.value === 'string' ? r.value : JSON.stringify(r.value);
  return `default:${r.itemType}:${r.kind}:${v}`;
}

/**
 * Strategy-provided default conversation paths. The project root is NOT included
 * here — it is surfaced implicitly and session-wide by `getProjectRootEntry`.
 * @param {any} mt @returns {string[]}
 */
export function getDefaultAllowedPaths(mt) {
  const manifest = mt.strategy?.getManifest?.();
  return Array.isArray(manifest?.defaultAllowedPaths) ? [...manifest.defaultAllowedPaths] : [];
}
