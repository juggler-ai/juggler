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
 *
 * Rules and allowed paths are two instances of the same two-scope collection
 * ({@link module:model/scoped-permission-store}); only the entry shape, the
 * defaults and the identity test differ. What lives here is that per-kind
 * configuration plus the semantics on top: scope policy, dedupe on add, and
 * the implicit project-root path entry.
 * @module model/message-thread-permissions
 */

import { approvePermittedPendingApprovals } from './conversation-tool-actions.js';
import { createScopedStore, SCOPE_SESSION, SCOPE_CONVERSATION } from './scoped-permission-store.js';

/**
 * @typedef {import('./scoped-permission-store.js').PermissionScope} PermissionScope
 * @typedef {import('./message-thread.js').default} MessageThread
 */

/**
 * @typedef {object} PermissionRule
 * @property {string} id
 * @property {string} itemType
 * @property {string} kind
 * @property {unknown} value
 * @property {PermissionScope} [scope]
 */

/**
 * @typedef {object} AllowedPathEntry
 * @property {string} id
 * @property {string} path
 * @property {PermissionScope} [scope]
 * @property {boolean} [implicit] Derived project-root entry: always present, session-wide, not editable or removable.
 */

const SESSION_RULES_KEY = 'sessionPermissionRules';
const SESSION_PATHS_KEY = 'sessionAllowedPaths';
export const CONVERSATION_RULES_KEY = 'conversationPermissionRules';
export const CONVERSATION_PATHS_KEY = 'conversationAllowedPaths';

function newRuleId() {
  return 'r_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function newPathId() {
  return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * A stored entry's fields; anything that is not an object has none.
 * @param {unknown} value - The stored entry
 * @returns {Record<string, unknown>} Its fields
 */
function fieldsOf(value) {
  return value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
}

/**
 * A stored field as text; anything that is not a string reads as ''.
 * @param {unknown} value - The stored field
 * @returns {string} The text
 */
function textOf(value) {
  return typeof value === 'string' ? value : '';
}

/** @param {MessageThread} mt @param {string} itemType @param {PermissionScope|undefined} requested @returns {PermissionScope} */
function defaultScopeFor(mt, itemType, requested) {
  const policy = mt.getPermissionScopePolicy?.(itemType);
  if (requested && policy?.allowedScopes?.includes?.(requested)) return requested;
  if (policy?.allowedScopes && !policy.allowedScopes.includes(policy.defaultScope)) return policy.allowedScopes[0] || SCOPE_CONVERSATION;
  return policy?.defaultScope || SCOPE_CONVERSATION;
}

/** @param {MessageThread} mt @param {string} itemType @param {PermissionScope} scope @returns {boolean} */
function scopeAllowedFor(mt, itemType, scope) {
  const policy = mt.getPermissionScopePolicy?.(itemType);
  return !policy?.allowedScopes || policy.allowedScopes.includes(scope);
}

/** @param {unknown} entry @param {PermissionScope} fallbackScope @returns {PermissionRule} */
function normalizeRule(entry, fallbackScope) {
  const r = fieldsOf(entry);
  return {
    id: textOf(r.id) || syntheticRuleId(r),
    itemType: textOf(r.itemType),
    kind: textOf(r.kind),
    value: r.value,
    scope: r.scope === SCOPE_SESSION ? SCOPE_SESSION : fallbackScope
  };
}

/** @param {PermissionRule} a @param {PermissionRule} b @returns {boolean} */
function sameRuleIdentity(a, b) {
  return a.itemType === b.itemType && a.kind === b.kind && a.value === b.value;
}

const rulesStore = createScopedStore({
  sessionKey: SESSION_RULES_KEY,
  conversationKey: CONVERSATION_RULES_KEY,
  normalize: normalizeRule,
  sameIdentity: sameRuleIdentity,
  matches: (rule, ruleId) => rule.id === ruleId,
  defaults: mt => getDefaultRules(mt),
  // Session rules are restricted to itemTypes whose owning plugin actually
  // permits session scope. A stored rule under a conversation-only itemType
  // (e.g. `write-file`) is inert — the plugin's `isPermitted` ignores it — yet
  // it would still match {@link addRule}'s dedupe and silently swallow the
  // conversation-scoped grant a "don't ask again" button is trying to write,
  // leaving the permission permanently unflippable for that project. Dropping
  // it on read keeps the stored shape and the enforced shape in agreement. An
  // itemType with no loaded plugin keeps both scopes, so rules belonging to an
  // extension that hasn't registered yet are never discarded.
  sessionAllows: (mt, rule) => scopeAllowedFor(mt, rule.itemType, SCOPE_SESSION),
  afterConversationSave: (mt, rules) => approvePermittedPendingApprovals(mt.conversation, {
    allowViewer: true,
    itemTypes: [...new Set(rules.map(r => r.itemType))]
  })
});

/** @param {MessageThread} mt @returns {PermissionRule[]} */
export function getAllRules(mt) {
  return rulesStore.all(mt);
}

/** @param {MessageThread} mt @param {string} itemType @returns {PermissionRule[]} */
export function getRulesFor(mt, itemType) {
  return getAllRules(mt).filter(r => r.itemType === itemType);
}

/**
 * Add a new rule. Defaults to conversation scope unless `rule.scope` is set.
 * Dedupe checks both scopes so identical rules are not shown twice.
 * @param {MessageThread} mt
 * @param {string} itemType
 * @param {Partial<PermissionRule> & {kind: string, value: unknown}} rule
 * @returns {PermissionRule}
 */
export function addRule(mt, itemType, rule) {
  const scope = defaultScopeFor(mt, itemType, rule.scope);
  const desired = normalizeRule({ ...rule, id: rule.id || newRuleId(), itemType, scope }, scope);
  // Prefer a match in the requested scope, so a rule present in both scopes
  // returns the one the caller asked for rather than whichever is read first.
  const all = getAllRules(mt);
  const existing = all.find(r => sameRuleIdentity(r, desired) && r.scope === scope)
    || all.find(r => sameRuleIdentity(r, desired));
  if (existing) return existing;
  rulesStore.append(mt, desired, scope);
  return desired;
}

/** @param {MessageThread} mt @param {string} ruleId @returns {boolean} */
export function removeRule(mt, ruleId) {
  return rulesStore.remove(mt, ruleId);
}

/** @param {MessageThread} mt @param {string} ruleId @param {Partial<PermissionRule>} patch @returns {boolean} */
export function updateRule(mt, ruleId, patch) {
  return rulesStore.update(mt, ruleId, (cur, scope) =>
    normalizeRule({ ...cur, ...patch, id: cur.id, itemType: cur.itemType }, scope));
}

/** @param {MessageThread} mt @param {string} ruleId @param {PermissionScope} targetScope @returns {boolean} */
export function setRuleScope(mt, ruleId, targetScope) {
  return rulesStore.move(mt, ruleId, targetScope, {
    canMoveTo: (m, rule) => scopeAllowedFor(m, rule.itemType, rule.scope ?? targetScope)
  });
}

/** @param {MessageThread} mt @param {string} itemType */
export function clearRules(mt, itemType) {
  for (const scope of /** @type {PermissionScope[]} */ ([SCOPE_CONVERSATION, SCOPE_SESSION])) {
    rulesStore.save(mt, scope, rulesStore.read(mt, scope).filter(r => r.itemType !== itemType));
  }
}

// ============================================================================
// Allowed paths
// ============================================================================

/** @param {unknown} entry @param {PermissionScope} fallbackScope @returns {AllowedPathEntry} */
function normalizePathEntry(entry, fallbackScope) {
  if (typeof entry === 'string') return { id: defaultPathId(entry), path: entry, scope: fallbackScope };
  const p = fieldsOf(entry);
  return {
    id: textOf(p.id) || defaultPathId(textOf(p.path)),
    path: textOf(p.path) || textOf(p.value),
    scope: p.scope === SCOPE_SESSION ? SCOPE_SESSION : fallbackScope
  };
}

/** @param {string} path @returns {string} */
function defaultPathId(path) { return `path:${path}`; }

const pathsStore = createScopedStore({
  sessionKey: SESSION_PATHS_KEY,
  conversationKey: CONVERSATION_PATHS_KEY,
  normalize: normalizePathEntry,
  sameIdentity: (a, b) => a.path === b.path,
  matches: (entry, idOrPath) => entry.id === idOrPath || entry.path === idOrPath,
  defaults: mt => getDefaultAllowedPaths(mt).map(path => ({ id: defaultPathId(path), path })),
  afterConversationSave: mt => approvePermittedPendingApprovals(mt.conversation, {
    allowViewer: true,
    itemTypes: ['execute']
  })
});

/**
 * The directory this conversation works in: its workspace root when it is bound
 * to one, and the session's project path when it is not.
 *
 * Everything that must agree about where the conversation works asks here, so
 * that it is answered once. A second copy of this expression is how a grant
 * ends up describing one tree while the command it authorises runs in another:
 * the server roots every operation at whatever the request's `workspaceId`
 * resolves to, and a caller that reaches for `session.projectPath` instead is
 * describing the tree a bound conversation left.
 *
 * Null when a binding cannot be honoured — never the project as a fallback, for
 * the reason given on {@link getWorkspaceRootEntry}.
 * @param {MessageThread} mt @returns {string|null}
 */
export function getWorkingRoot(mt) {
  const conversation = mt?.conversation;
  if (!conversation) return null;
  const root = conversation.workspaceId
    ? conversation.workspaceRoot
    : conversation.session?.projectPath;
  return root || null;
}

/**
 * Where this conversation works is implicitly allowed: an always-present entry
 * that is never persisted and cannot be toggled or removed.
 *
 * For a conversation bound to the default workspace that is `session.projectPath`,
 * shared by every conversation in the project — which is what it meant before
 * workspaces existed. A bound conversation's is its workspace root instead, and
 * NOT the project as well: a worktree conversation may read the main tree (the
 * server widens reads for that), but writing to it is a different tree's
 * business and should be asked about like any other out-of-root write.
 *
 * A binding that cannot be honoured yields no implicit root at all, rather than
 * falling back to the project. Every operation this conversation makes is going
 * to be refused by the server anyway, and quietly granting it the project root
 * meanwhile would describe a permission it does not have.
 *
 * This entry is the only one that moves by itself, because it is the only one
 * derived rather than stored. The explicit grants beside it are absolute paths
 * frozen when they were given, so they are rewritten when a conversation moves
 * (`services/workspace-rebinding`): a conversation-scoped grant is re-rooted in
 * place, while a session-scoped one belongs to the project rather than to the
 * conversation and is copied down re-rooted instead of edited.
 * @param {MessageThread} mt @returns {AllowedPathEntry|null}
 */
function getWorkspaceRootEntry(mt) {
  const root = getWorkingRoot(mt);
  if (!root) return null;
  return { id: defaultPathId(root), path: root, scope: SCOPE_SESSION, implicit: true };
}

/** @param {MessageThread} mt @returns {AllowedPathEntry[]} */
export function getAllowedPathEntries(mt) {
  const root = getWorkspaceRootEntry(mt);
  const stored = pathsStore.all(mt).filter(p => p.path);
  if (!root) return stored;
  // The implicit root is listed first; any stored entry equal to it (e.g. a
  // legacy per-tab copy) collapses into the implicit one.
  return [root, ...stored.filter(p => p.path !== root.path)];
}

/** @param {MessageThread} mt @returns {string[]} */
export function getAllowedPaths(mt) {
  return getAllowedPathEntries(mt).map(p => p.path);
}

/**
 * The roots a read may reach without asking: the allowed paths, plus the
 * project when the conversation works in a workspace it can honour.
 *
 * This is the read half of the boundary the server draws for a workspace
 * (`workspace/local.go` scope): rooted at the workspace, with the project
 * added as a READ root so a worktree conversation can consult the tree it
 * branched from. Writes and shell commands keep to {@link getAllowedPaths},
 * where the project is a different tree's business. A binding that cannot be
 * honoured adds nothing, for the reason given on {@link getWorkspaceRootEntry}.
 * @param {MessageThread} mt @returns {string[]}
 */
export function getReadablePaths(mt) {
  const allowed = getAllowedPaths(mt);
  const conversation = mt?.conversation;
  const project = conversation?.session?.projectPath;
  if (!conversation?.workspaceId || !getWorkingRoot(mt) || !project) return allowed;
  return allowed.includes(project) ? allowed : [...allowed, project];
}

/**
 * The explicit (user-added) allowed-path grants only — session- and
 * conversation-scoped entries WITHOUT the implicit root the conversation works
 * in.
 *
 * This is what travels to the backend ops as `allowedPaths`. Those ops build
 * their PathScope rooted at wherever the request's `workspaceId` resolves to
 * server-side — the session's LIVE project path when it names none — so the
 * root is already supplied authoritatively there and re-sending a client copy is
 * redundant — and, after a runtime project switch, unsafe: the engine is
 * persistent across SwitchProject and keeps its boot-time `session.projectPath`,
 * so the implicit root here would be the PREVIOUS project and would re-authorise
 * reads/globs/greps across the old tree. Sending explicit grants only keeps the
 * server the sole authority for the project boundary.
 * @param {MessageThread} mt @returns {string[]}
 */
export function getExplicitAllowedPaths(mt) {
  return getAllowedPathEntries(mt).filter(p => !p.implicit).map(p => p.path);
}

/** @param {MessageThread} mt @param {string[]} paths */
export function setAllowedPaths(mt, paths) {
  pathsStore.save(mt, SCOPE_CONVERSATION, paths.map(path => ({ id: defaultPathId(path), path, scope: SCOPE_CONVERSATION })));
}

/** @param {MessageThread} mt @param {string} p @param {{scope?: PermissionScope}} [options] @returns {boolean} */
export function addAllowedPath(mt, p, options = {}) {
  const normalized = (p || '').trim();
  if (!normalized) return false;
  if (getAllowedPathEntries(mt).some(entry => entry.path === normalized)) return false;
  const scope = options.scope === SCOPE_SESSION ? SCOPE_SESSION : SCOPE_CONVERSATION;
  pathsStore.append(mt, { id: newPathId(), path: normalized, scope }, scope);
  return true;
}

/** @param {MessageThread} mt @param {string} idOrPath @returns {boolean} */
export function removeAllowedPath(mt, idOrPath) {
  return pathsStore.remove(mt, idOrPath);
}

/** @param {MessageThread} mt @param {string} idOrPath @param {string} newPath @returns {boolean} */
export function updateAllowedPath(mt, idOrPath, newPath) {
  const normalized = (newPath || '').trim();
  if (!normalized) return false;
  return pathsStore.update(mt, idOrPath, entry => ({ ...entry, path: normalized }));
}

/** @param {MessageThread} mt @param {string} idOrPath @param {PermissionScope} targetScope @returns {boolean} */
export function setAllowedPathScope(mt, idOrPath, targetScope) {
  return pathsStore.move(mt, idOrPath, targetScope);
}

// ============================================================================
// Strategy defaults
// ============================================================================

/** @param {MessageThread} mt @returns {PermissionRule[]} */
function getDefaultRules(mt) {
  const manifest = mt.strategy?.getManifest?.();
  const defaults = Array.isArray(manifest?.defaultRules) ? manifest.defaultRules : [];
  // A manifest is the strategy author's code, so a rule may carry fields
  // DefaultRule does not declare (an `id`); normalizeRule reads them as stored.
  return defaults.map(r => normalizeRule({ ...r, scope: SCOPE_CONVERSATION }, SCOPE_CONVERSATION));
}

/** @param {{itemType?: unknown, kind?: unknown, value?: unknown}} r @returns {string} */
function syntheticRuleId(r) {
  const v = typeof r.value === 'string' ? r.value : JSON.stringify(r.value);
  return `default:${String(r.itemType)}:${String(r.kind)}:${v}`;
}

/**
 * Strategy-provided default conversation paths. The project root is NOT included
 * here — the root a conversation works in is surfaced implicitly by
 * `getWorkspaceRootEntry`.
 * @param {MessageThread} mt @returns {string[]}
 */
function getDefaultAllowedPaths(mt) {
  const manifest = mt.strategy?.getManifest?.();
  return Array.isArray(manifest?.defaultAllowedPaths) ? [...manifest.defaultAllowedPaths] : [];
}
