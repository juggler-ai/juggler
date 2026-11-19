//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Git pin worktree switcher tests — the switcher the head's branch button
 * opens, and what picking a tree or following writes to the pin's config (a
 * tree picked by hand is `{workspace, follow: false}`, the project tree's id
 * being ''). The worktree actions are git-tree-actions-test's. The fake
 * services are git-pin-helpers'.
 * @module _tests/git-worktrees-test
 */

import GitPin from '../pins/git-pin.js';
import { isolateFocus } from '../../../js-tests/utilities/isolate-focus.js';
import { assert, nextTask } from '../../../js-tests/utilities/test-helpers.js';
import { mountPin, treeOf } from './git-pin-helpers.js';

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Test label.
   * @param {() => Promise<void>|void} fn - Test body.
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    } finally {
      for (const pop of document.querySelectorAll('.git-pop')) pop.remove();
    }
  }

  const pin = new GitPin();

  const main = treeOf({ path: '/tmp/proj', main: true, current: true, branch: 'develop', dirty: 0, tree: '' });
  const plain = treeOf({ path: '/tmp/wt-plain', branch: '', detached: true, head: 'abcdef0123456789', dirty: 3, tree: 'wt:plain' });
  const wsTree = treeOf({ path: '/tmp/wt-ws', branch: 'feat', dirty: null, tree: 'wt:wsraw', rows: ['ws_feat'] });
  const workspaces = {
    rows: [{ id: 'ws_feat', label: 'feat', root: '/tmp/wt-ws', providerId: 'git-worktree', state: 'open', meta: { branch: 'feat' } }],
    conversations: { ws_feat: [{ id: 'c9', title: 'Tunnels' }] },
    finishOptions: {
      ws_feat: { options: [{ id: 'merge', label: 'Merge into develop' }, { id: 'discard', label: 'Discard branch and tree…', danger: true }] },
    },
  };

  /**
   * Mount and wait for the first reads.
   * @param {object} [options] - Passed to `mountPin`.
   * @returns {Promise<any>} The mounted pin.
   */
  const mounted = async (options = {}) => {
    const m = mountPin(pin, { place: 'refs', worktrees: { repo: '', trees: [main, plain, wsTree] }, workspaces, ...options });
    for (let i = 0; i < 6; i++) await nextTask();
    return m;
  };

  /**
   * Open the switcher from the head and wait for its read.
   * @param {any} m - The mounted pin.
   * @returns {Promise<Element>} The switcher.
   */
  const openSwitcher = async (m) => {
    /** @type {HTMLElement} */ (m.body.querySelector('.git-pin__branch')).click();
    for (let i = 0; i < 6; i++) await nextTask();
    const found = document.querySelector('.git-pop.git-switcher');
    if (!found) throw new Error('the switcher did not open');
    return found;
  };
  /**
   * @param {Element} switcher - The switcher.
   * @param {string} path - A tree's path.
   * @returns {HTMLElement} Its entry.
   */
  const entry = (switcher, path) => {
    const found = /** @type {HTMLElement|null} */ (switcher.querySelector(`.git-switcher__tree[data-path="${CSS.escape(path)}"]`));
    if (!found) throw new Error(`no entry for ${path}: ${switcher.textContent}`);
    return found;
  };

  await test('the switcher lists each tree: name, head, changes, conversation, and which is viewed', async () => {
    const m = await mounted();
    const switcher = await openSwitcher(m);
    const mainText = entry(switcher, '/tmp/proj').textContent || '';
    assert(mainText.includes('proj') && mainText.includes('develop') && mainText.includes('✓'), `main: ${mainText}`);
    assert(entry(switcher, '/tmp/proj').getAttribute('aria-current') === 'true', 'the viewed tree is marked');
    const plainText = entry(switcher, '/tmp/wt-plain').textContent || '';
    assert(plainText.includes('wt-plain') && plainText.includes('abcdef0 detached') && plainText.includes('●3'), `plain: ${plainText}`);
    const wsText = entry(switcher, '/tmp/wt-ws').textContent || '';
    assert(wsText.includes('feat') && wsText.includes('?') && wsText.includes('Tunnels'), `workspace tree: ${wsText}`);
    const acts = [...switcher.querySelectorAll('.git-switcher__act')].map((a) => a.getAttribute('data-act'));
    assert(JSON.stringify(acts) === '["branch","new","follow"]', `actions: ${JSON.stringify(acts)}`);
    const ticked = switcher.querySelector('[data-act="follow"]');
    assert(ticked?.getAttribute('aria-checked') === 'true' && Boolean(ticked.querySelector('.git-switcher__check svg')), 'following is ticked');
    m.teardown();
  });

  await test('a redraw of the open switcher keeps focus on the row it was on', async () => {
    const focus = isolateFocus();
    try {
      const m = await mounted();
      const switcher = await openSwitcher(m);
      /**
       * Redraw with `from` focused, and return what the redraw asked to focus.
       * @param {Element|null} from - The row focused before the redraw.
       * @returns {HTMLElement|undefined} The element focus was asked for, if any.
       */
      const redrawFrom = (from) => {
        focus.set(from);
        const before = focus.requests.length;
        m.emitWorkspaces();
        focus.steal();
        return focus.requests.slice(before).at(-1)?.element;
      };
      const oldTree = entry(switcher, '/tmp/wt-plain');
      const onTree = redrawFrom(oldTree);
      assert(onTree?.dataset.path === '/tmp/wt-plain' && switcher.contains(onTree) && onTree !== oldTree,
        `a redraw on a tree refocuses its new row: ${onTree?.outerHTML.slice(0, 80)}`);
      const onAct = redrawFrom(switcher.querySelector('[data-act="new"]'));
      assert(onAct?.dataset.act === 'new' && switcher.contains(onAct), `a redraw on an action refocuses it: ${onAct?.outerHTML.slice(0, 80)}`);
      assert(redrawFrom(null) === undefined, 'a redraw with nothing in the switcher focused asks for no focus');
      m.teardown();
    } finally {
      focus.restore();
    }
  });

  await test('picking a plain tree pins its wt: id, and the reads follow it', async () => {
    const m = await mounted();
    entry(await openSwitcher(m), '/tmp/wt-plain').click();
    for (let i = 0; i < 6; i++) await nextTask();
    const saved = m.configs().at(-1);
    assert(saved?.workspace === 'wt:plain' && saved.follow === false, `config ${JSON.stringify(saved)}`);
    assert(m.reads().at(-1)?.options.workspace === 'wt:plain', `read ${JSON.stringify(m.reads().at(-1))}`);
    m.teardown();
  });

  await test('picking a workspace tree pins the workspace row, not the tree id', async () => {
    const m = await mounted();
    entry(await openSwitcher(m), '/tmp/wt-ws').click();
    for (let i = 0; i < 6; i++) await nextTask();
    const saved = m.configs().at(-1);
    assert(saved?.workspace === 'ws_feat' && saved.follow === false, `config ${JSON.stringify(saved)}`);
    m.teardown();
  });

  await test('picking the tree in view changes nothing, in the switcher or the sidebar', async () => {
    const m = await mounted({ place: 'changes', width: '70rem' });
    entry(await openSwitcher(m), '/tmp/proj').click();
    for (let i = 0; i < 6; i++) await nextTask();
    const row = /** @type {HTMLElement|null} */ (m.body.querySelector('.git-refs__row[data-key="wt:/tmp/proj"] .git-refs__name'));
    if (!row) throw new Error('no sidebar row for the tree in view');
    row.click();
    for (let i = 0; i < 6; i++) await nextTask();
    assert(m.configWrites().length === 0, `the pin was rewritten: ${JSON.stringify(m.configWrites().map((/** @type {any} */ w) => w.config))}`);
    m.teardown();
  });

  await test('a nested repository\u2019s own checkout opens at that repository, not at its tree\u2019s root', async () => {
    const subMain = treeOf({ path: '/tmp/proj/lib', main: true, tree: '', treeRepo: 'lib' });
    const subSide = treeOf({ path: '/tmp/lib-side', current: true, branch: 'side', tree: 'wt:libside' });
    const m = await mounted({ config: { workspace: 'wt:libside', follow: false }, worktrees: { repo: '', trees: [subMain, subSide] } });
    const switcher = await openSwitcher(m);
    const writes = m.configWrites().length;
    const reads = m.changesAsked().length;
    entry(switcher, '/tmp/proj/lib').click();
    for (let i = 0; i < 6; i++) await nextTask();
    // The canned review holds only the root repository, so the pin goes on to
    // that afterwards: what matters is where it was sent.
    const saved = m.configWrites()[writes]?.config;
    assert(saved?.workspace === '' && saved.follow === false && saved.repo === 'lib', `config ${JSON.stringify(saved)}`);
    const asked = m.changesAsked()[reads];
    assert(asked?.workspace === '' && asked.repo === 'lib', `the changes read names the repository: ${JSON.stringify(asked)}`);
    m.teardown();
  });

  await test('picking the project tree pins it as workspace "" with follow off, and reads name it', async () => {
    const viewing = { repo: '', trees: [{ ...main, current: false }, { ...plain, current: true }, wsTree] };
    const m = await mounted({ place: 'changes', config: { workspace: 'wt:plain', follow: false }, worktrees: viewing });
    entry(await openSwitcher(m), '/tmp/proj').click();
    for (let i = 0; i < 6; i++) await nextTask();
    const saved = m.configs().at(-1);
    assert(saved && saved.workspace === '' && saved.follow === false, `config ${JSON.stringify(saved)}`);
    const asked = m.changesAsked().at(-1);
    assert(asked && 'workspace' in asked && asked.workspace === '', `a changes read names the project tree: ${JSON.stringify(asked)}`);
    assert(JSON.stringify(pin.normalizeConfig({ workspace: '', follow: false })) === '{"workspace":"","follow":false}',
      `normalizing keeps it: ${JSON.stringify(pin.normalizeConfig({ workspace: '', follow: false }))}`);
    assert(JSON.stringify(pin.normalizeConfig({ workspace: 'ws1' })) === '{"workspace":"ws1"}', 'an agent-named workspace stays as it was');
    assert(JSON.stringify(pin.normalizeConfig({ workspace: '', follow: true })) === '{}', 'following carries neither key');
    assert(!pin.isSameConfig({ workspace: '', follow: false }, {}), 'pinned to the project is not following');
    m.teardown();
  });

  await test('Follow removes both keys, and turning it off pins the tree in view', async () => {
    const m = await mounted({ config: { workspace: 'wt:plain', follow: false } });
    let switcher = await openSwitcher(m);
    const follow = /** @type {HTMLElement} */ (switcher.querySelector('[data-act="follow"]'));
    assert(follow.getAttribute('aria-checked') === 'false' && !follow.querySelector('.git-switcher__check svg'), `not ticked while pinned: ${follow.outerHTML}`);
    follow.click();
    for (let i = 0; i < 6; i++) await nextTask();
    const following = m.configs().at(-1);
    assert(following && !('workspace' in following) && !('follow' in following), `follow: ${JSON.stringify(following)}`);
    switcher = await openSwitcher(m);
    /** @type {HTMLElement} */ (switcher.querySelector('[data-act="follow"]')).click();
    for (let i = 0; i < 6; i++) await nextTask();
    const pinned = m.configs().at(-1);
    assert(pinned?.workspace === '' && pinned.follow === false, `off pins the followed tree: ${JSON.stringify(pinned)}`);
    m.teardown();
  });

  await test('Switch branch here… shows Refs, and New worktree… opens the git-worktree setup', async () => {
    const m = await mounted({ place: 'changes' });
    /** @type {HTMLElement} */ ((await openSwitcher(m)).querySelector('[data-act="branch"]')).click();
    for (let i = 0; i < 6; i++) await nextTask();
    assert(m.body.querySelector('.git-pin')?.getAttribute('data-place') === 'refs', 'Refs is shown');
    /** @type {HTMLElement} */ ((await openSwitcher(m)).querySelector('[data-act="new"]')).click();
    for (let i = 0; i < 6; i++) await nextTask();
    const call = m.workspaceCalls().find((/** @type {any} */ c) => c.call === 'create');
    assert(call && call.args[0].providerId === 'git-worktree' && !call.args[0].values, `create ${JSON.stringify(m.workspaceCalls())}`);
    m.teardown();
  });

  return { passed, failed, errors };
}
