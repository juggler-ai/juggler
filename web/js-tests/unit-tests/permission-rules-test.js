//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for the generic permission-rule helpers on MessageThread.
 *
 * These helpers form the plugin-facing contract for auto-approval: each
 * plugin reads its own `itemType` and decides what `kind`/`value` shapes to
 * accept. The helpers themselves treat every rule opaquely. We exercise:
 *
 *   - add / remove / update / clear round-trips
 *   - idempotent re-add (no duplicate created)
 *   - cross-plugin independence (clearing 'execute' leaves 'write-file' alone)
 *   - allowed-paths CRUD + the default falling back to session.projectPath
 * @module unit-tests/permission-rules
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../utilities/test-helpers.js';
import { renderExecutePermissionSection } from '../../extensions/juggler-core/context-items/execute/permission-section.js';

/** @typedef {{passed: number, failed: number, errors: string[]}} TestResult */

/**
 * @returns {Promise<TestResult>} Aggregate pass/fail counts and collected errors.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await initializeRegistries();
  const session = await createTestSession();

  /**
   * @param {string} name
   * @param {() => void | Promise<void>} fn
   */
  async function t(name, fn) {
    try { await fn(); passed++; }
    catch (e) { failed++; errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  }

  // addRule + getRulesFor round-trip
  await t('addRule then getRulesFor returns the rule', async () => {
    const c = await createTestConversation(session);
    const mt = c.rootMessageThread;
    mt.clearRules('execute');
    const created = mt.addRule('execute', { kind: 'glob', value: 'npm *' });
    assert(created.id !== undefined && created.id.length > 0, 'addRule returns id');
    assert(created.scope === 'session', 'plugin default scope is session for execute');
    const found = mt.getRulesFor('execute');
    assert(found.length === 1, `expected 1 rule, got ${found.length}`);
    assert(found[0].kind === 'glob' && found[0].value === 'npm *', 'rule shape preserved');
  });

  // Idempotent re-add: same itemType/kind/value returns existing, doesn't duplicate
  await t('addRule is idempotent on equal kind+value', async () => {
    const c = await createTestConversation(session);
    const mt = c.rootMessageThread;
    mt.clearRules('execute');
    const a = mt.addRule('execute', { kind: 'glob', value: 'git status' });
    const b = mt.addRule('execute', { kind: 'glob', value: 'git status' });
    assert(a.id === b.id, 'returned the same rule');
    assert(mt.getRulesFor('execute').length === 1, 'no duplicate created');
  });

  // removeRule
  await t('removeRule deletes the rule', async () => {
    const c = await createTestConversation(session);
    const mt = c.rootMessageThread;
    mt.clearRules('execute');
    const r = mt.addRule('execute', { kind: 'glob', value: 'ls *' });
    assert(mt.removeRule(r.id) === true, 'removeRule returns true');
    assert(mt.getRulesFor('execute').length === 0, 'rule list empty');
    assert(mt.removeRule('nonexistent') === false, 'unknown id returns false');
  });

  // updateRule
  await t('updateRule patches value', async () => {
    const c = await createTestConversation(session);
    const mt = c.rootMessageThread;
    mt.clearRules('execute');
    const r = mt.addRule('execute', { kind: 'glob', value: 'make *' });
    mt.updateRule(r.id, { value: 'make test' });
    assert(mt.getRulesFor('execute')[0].value === 'make test', 'value updated');
  });

  await t('session scoped rule is merged into other conversations', async () => {
    const a = await createTestConversation(session);
    const b = await createTestConversation(session);
    a.rootMessageThread.clearRules('execute');
    const created = a.rootMessageThread.addRule('execute', { kind: 'glob', value: 'make *', scope: 'session' });
    assert(created.scope === 'session', 'created session scope');
    const seen = b.rootMessageThread.getRulesFor('execute').find(r => r.value === 'make *');
    assert(!!seen, 'second conversation sees session rule');
    assert(seen.scope === 'session', 'merged rule retains session scope');
  });

  await t('setRuleScope moves rule between stores preserving id', async () => {
    const c = await createTestConversation(session);
    const mt = c.rootMessageThread;
    mt.clearRules('execute');
    const r = mt.addRule('execute', { kind: 'glob', value: 'scope-move *', scope: 'conversation' });
    assert(mt.setRuleScope(r.id, 'session') === true, 'move to session succeeds');
    let moved = mt.getRulesFor('execute').find(x => x.id === r.id);
    assert(moved && moved.scope === 'session', 'rule is session scoped after move');
    assert(mt.setRuleScope(r.id, 'conversation') === true, 'move to conversation succeeds');
    moved = mt.getRulesFor('execute').find(x => x.id === r.id);
    assert(moved && moved.scope === 'conversation', 'rule is conversation scoped after move back');
  });

  await t('execute permission UI keeps row order stable on scope toggle', async () => {
    const c = await createTestConversation(session);
    const mt = c.rootMessageThread;
    mt.clearRules('execute');
    const first = mt.addRule('execute', { kind: 'glob', value: 'first *', scope: 'session' });
    mt.addRule('execute', { kind: 'glob', value: 'second *', scope: 'conversation' });
    const section = renderExecutePermissionSection(mt);
    document.body.appendChild(section.element);
    const valuesBefore = Array.from(section.element.querySelectorAll('.pattern-text')).map(el => el.textContent);
    assert(valuesBefore.length === 2, `expected two rows, got ${valuesBefore.length}`);
    mt.setRuleScope(first.id, 'conversation');
    const valuesAfter = Array.from(section.element.querySelectorAll('.pattern-text')).map(el => el.textContent);
    assert(valuesAfter.join('|') === valuesBefore.join('|'), `order changed after scope toggle: before=${valuesBefore.join('|')} after=${valuesAfter.join('|')}`);
    const scopeLabel = section.element.querySelector('.rule-scope-btn')?.textContent;
    assert(scopeLabel === 'This tab', `scope label not updated: ${scopeLabel}`);
    section.dispose();
    section.element.remove();
  });

  await t('execute permission UI updates rows in place without recreating untouched nodes', async () => {
    const c = await createTestConversation(session);
    const mt = c.rootMessageThread;
    mt.clearRules('execute');
    const a = mt.addRule('execute', { kind: 'glob', value: 'alpha *', scope: 'session' });
    const b = mt.addRule('execute', { kind: 'glob', value: 'beta *', scope: 'session' });
    const section = renderExecutePermissionSection(mt);
    document.body.appendChild(section.element);
    /**
     * @param {string} id - Rule id to look up.
     * @returns {Element|null} The matching pattern-row element, or null if not found.
     */
    const rowFor = (id) => section.element.querySelector(`.pattern-row .pattern-text[data-rule-id="${id}"]`)?.closest('.pattern-row') || null;
    const aRowBefore = rowFor(a.id);
    const bRowBefore = rowFor(b.id);
    assert(!!aRowBefore && !!bRowBefore, 'both rows present');
    // Toggling A's scope must update A's row in place and leave B's node alone —
    // a full innerHTML rebuild would replace every node (resetting scroll).
    mt.setRuleScope(a.id, 'conversation');
    assert(rowFor(b.id) === bRowBefore, 'untouched row B kept its DOM node (no full re-render)');
    assert(rowFor(a.id) === aRowBefore, 'changed row A updated in place (same node)');
    assert(rowFor(a.id)?.querySelector('.rule-scope-btn')?.textContent === 'This tab', 'A scope label updated in place');
    // Deleting A removes only A's row; B's node survives.
    mt.removeRule(a.id);
    assert(rowFor(a.id) === null, 'deleted row removed');
    assert(rowFor(b.id) === bRowBefore, 'remaining row B still the same node after a delete');
    section.dispose();
    section.element.remove();
  });

  // Cross-plugin independence
  await t('rules for one itemType do not affect another', async () => {
    const c = await createTestConversation(session);
    const mt = c.rootMessageThread;
    mt.clearRules('execute');
    mt.clearRules('write-file');
    mt.addRule('execute', { kind: 'glob', value: 'npm *' });
    mt.addRule('write-file', { kind: 'boolean', value: true });
    mt.clearRules('execute');
    assert(mt.getRulesFor('execute').length === 0, 'execute cleared');
    assert(mt.getRulesFor('write-file').length === 1, 'write-file untouched');
    assert(mt.getRulesFor('write-file')[0].value === true, 'write-file value preserved');
  });

  // Allowed paths
  await t('allowed paths CRUD', async () => {
    const c = await createTestConversation(session);
    const mt = c.rootMessageThread;
    // The implicit project root is always present; count only user paths.
    const userPaths = () => mt.getAllowedPathEntries().filter(e => !e.implicit);
    // setAllowedPaths([]) clears only conversation scope. Session-scoped paths
    // live in the SHARED backend session metadata and can be left behind by
    // another suite in the same pool subprocess (e.g. permission-popup-refresh),
    // so reset BOTH scopes to a clean baseline — mirroring how the rule tests
    // rely on clearRules() clearing session + conversation.
    mt.setAllowedPaths([]);
    for (const e of mt.getAllowedPathEntries()) {
      if (e.scope === 'session' && !e.implicit) mt.removeAllowedPath(e.id);
    }
    assert(userPaths().length === 0, 'cleared');
    assert(mt.addAllowedPath('~/scratch') === true, 'add returns true');
    assert(mt.addAllowedPath('~/scratch') === false, 're-add returns false');
    assert(userPaths().length === 1, 'no duplicate');
    mt.addAllowedPath('~/code/other');
    mt.updateAllowedPath('~/scratch', '~/scratch2');
    assert(mt.getAllowedPaths().includes('~/scratch2'), 'updated entry present');
    assert(!mt.getAllowedPaths().includes('~/scratch'), 'old entry removed');
    mt.removeAllowedPath('~/scratch2');
    assert(userPaths().length === 1, 'one left');
  });

  await t('project root is an implicit, fixed, session-wide first entry', async () => {
    const c = await createTestConversation(session);
    const mt = c.rootMessageThread;
    mt.setAllowedPaths([]);
    const entries = mt.getAllowedPathEntries();
    const root = entries[0];
    assert(root && root.path === session.projectPath, 'project root is listed first');
    assert(root.implicit === true, 'project root is implicit');
    assert(root.scope === 'session', 'project root is session-wide');
    // Fixed: cannot be removed or re-scoped (no stored entry to locate).
    assert(mt.removeAllowedPath(root.id) === false, 'project root cannot be removed');
    assert(mt.setAllowedPathScope(root.id, 'conversation') === false, 'project root cannot be re-scoped');
    assert(mt.getAllowedPathEntries()[0].path === session.projectPath, 'project root still present and first');
    // Adding the project root explicitly is a no-op (dedupes into implicit).
    assert(mt.addAllowedPath(session.projectPath) === false, 'no duplicate project root');
  });

  // Regression: the tool-transport allowed-roots list must OMIT the implicit
  // project root. Read/search/tree backend ops are rooted at the server's LIVE
  // project path, so re-sending a client project root is redundant — and, after
  // a runtime project switch, unsafe: the persistent engine keeps its boot-time
  // session.projectPath, so an implicit root here would be the PREVIOUS project
  // and would re-authorise reads across the old tree. Explicit grants still flow.
  await t('explicit allowed paths omit the implicit project root but keep grants', async () => {
    const c = await createTestConversation(session);
    const mt = c.rootMessageThread;
    mt.setAllowedPaths([]);
    for (const e of mt.getAllowedPathEntries()) {
      if (e.scope === 'session' && !e.implicit) mt.removeAllowedPath(e.id);
    }
    mt.addAllowedPath('~/grant-a');
    mt.addAllowedPath('~/grant-b', { scope: 'session' });

    const full = mt.getAllowedPaths();
    const explicit = mt.getExplicitAllowedPaths();
    // Display list carries the implicit project root; the tool-transport list
    // does NOT — the server supplies the root authoritatively from live state.
    assert(full.includes(session.projectPath), 'display list includes project root');
    assert(!explicit.includes(session.projectPath), 'explicit list omits project root');
    assert(explicit.includes('~/grant-a'), 'conversation grant survives');
    assert(explicit.includes('~/grant-b'), 'session grant survives');
    assert(explicit.length === full.length - 1, 'explicit = full minus the implicit root');

    // Clean up the session-scoped grant (lives in shared backend metadata).
    mt.removeAllowedPath('~/grant-b');
  });

  await t('session scoped allowed path is merged and movable', async () => {
    const c = await createTestConversation(session);
    const mt = c.rootMessageThread;
    mt.setAllowedPaths([]);
    mt.addAllowedPath('~/shared-root', { scope: 'session' });
    let entry = mt.getAllowedPathEntries().find(p => p.path === '~/shared-root');
    assert(entry && entry.scope === 'session', 'path added to session scope');
    assert(mt.setAllowedPathScope(entry.id, 'conversation') === true, 'path scope move succeeds');
    entry = mt.getAllowedPathEntries().find(p => p.path === '~/shared-root');
    assert(entry && entry.scope === 'conversation', 'path moved to conversation scope');
  });

  // The project root is always surfaced as the implicit first entry.
  await t('allowed paths include session.projectPath', async () => {
    const c = await createTestConversation(session);
    const mt = c.rootMessageThread;
    // Force a fresh read by clearing the stored value.
    mt.conversation._doc.setMetadata('conversationAllowedPaths', undefined);
    const paths = mt.getAllowedPaths();
    assert(paths.length >= 1, 'at least one path');
    assert(paths[0] === session.projectPath, 'project root = session.projectPath');
  });

  return { passed, failed, errors };
}
