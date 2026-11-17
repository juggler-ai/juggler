//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Git pin worktree action tests — what a workspace tree, a plain tree and the
 * main tree offer in the Refs place, and the fall back to following when a
 * pinned tree has gone. The switcher is git-worktrees-test's. The fake
 * services are git-pin-helpers'.
 * @module _tests/git-tree-actions-test
 */

import GitPin from '../pins/git-pin.js';
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
   * @param {any} m - The mounted pin.
   * @param {string} path - A tree's path.
   */
  const pickRow = (m, path) => {
    const row = /** @type {HTMLElement|null} */ (m.body.querySelector(`.git-refs__row[data-key="${CSS.escape(`wt:${path}`)}"]`));
    if (!row) throw new Error(`no row for ${path}`);
    row.click();
  };
  /**
   * @param {any} m - The mounted pin.
   * @returns {HTMLButtonElement[]} The detail's action buttons.
   */
  const actions = (m) => /** @type {HTMLButtonElement[]} */ ([...m.body.querySelectorAll('.git-refs__detail .git-refs__act')]);
  /**
   * @param {any} m - The mounted pin.
   * @param {string} label - The start of a button's label.
   * @returns {HTMLButtonElement} The button.
   */
  const action = (m, label) => {
    const found = actions(m).find((b) => (b.textContent || '').startsWith(label));
    if (!found) throw new Error(`no action "${label}": ${JSON.stringify(actions(m).map((b) => b.textContent))}`);
    return found;
  };
  /**
   * @param {string} status - The HTTP status.
   * @returns {Error} A refused read, as the host rejects one.
   */
  const refused = (status) => Object.assign(new Error('/tmp/wt-plain is no longer a worktree of this repository.'), { status: Number(status) });

  await test('a workspace tree offers exactly its provider’s endings, and runs the one chosen', async () => {
    const m = await mounted();
    pickRow(m, '/tmp/wt-ws');
    const labels = actions(m).map((b) => b.textContent);
    const finish = labels.slice(labels.indexOf('Merge into develop'));
    assert(JSON.stringify(finish) === JSON.stringify(['Merge into develop', 'Discard branch and tree…']), `endings: ${JSON.stringify(labels)}`);
    assert(!labels.some((l) => /Adopt|Lock|Remove/.test(l || '')), `no plain-tree actions: ${JSON.stringify(labels)}`);
    assert((m.body.querySelector('.git-refs__acts-head')?.textContent || '') === 'Finish', 'headed Finish');
    action(m, 'Merge into develop').click();
    for (let i = 0; i < 6; i++) await nextTask();
    const call = m.workspaceCalls().find((/** @type {any} */ c) => c.call === 'finish');
    assert(call && call.args[0] === 'ws_feat' && call.args[1] === 'merge', `finish ${JSON.stringify(m.workspaceCalls())}`);
    m.teardown();
  });

  await test('a plain tree offers Adopt, Lock and Remove; removing a dirty one asks, then forces', async () => {
    const m = await mounted();
    pickRow(m, '/tmp/wt-plain');
    action(m, 'Adopt as a Juggler workspace');
    action(m, 'Lock');
    m.holdRuns(true);
    action(m, 'Remove worktree…').click();
    const ask = document.querySelector('.git-pop')?.textContent || '';
    assert(ask.includes('3 changed files'), `the confirm says it is dirty: ${ask}`);
    assert(m.runs().length === 0, 'nothing runs before the confirm');
    /** @type {HTMLElement} */ (document.querySelector('.git-pop .git-pop__ok')).click();
    const op = m.runs()[0]?.op;
    assert(op?.kind === 'worktree-remove' && op.worktree === '/tmp/wt-plain' && op.force === true, `op ${JSON.stringify(op)}`);
    m.teardown();
  });

  await test('the main tree cannot be removed', async () => {
    const m = await mounted();
    pickRow(m, '/tmp/proj');
    assert(action(m, 'The main worktree can’t be removed').disabled, 'disabled');
    assert(!actions(m).some((b) => /Remove worktree/.test(b.textContent || '')), 'and no Remove');
    m.teardown();
  });

  await test('a refused read of a pinned tree falls back to following, and says so', async () => {
    const m = await mounted({
      config: { workspace: 'wt:gone', follow: false },
      worktrees: (/** @type {any} */ opts) => (opts.workspace === 'wt:gone' ? refused('400') : { repo: '', trees: [main] }),
    });
    const saved = m.configs().at(-1);
    assert(saved && !('workspace' in saved) && !('follow' in saved), `follows again: ${JSON.stringify(m.configs())}`);
    const toast = m.body.querySelector('.git-pin__toast:not([hidden])')?.textContent || '';
    assert(toast.includes('That worktree is gone'), `toast: ${toast}`);
    m.teardown();
  });

  await test('a refused changes read of a pinned tree falls back to following too', async () => {
    const m = await mounted({ place: 'changes', config: { workspace: 'wt:gone' }, changes: refused('400') });
    const saved = m.configs().at(-1);
    assert(saved && !('workspace' in saved), `follows again: ${JSON.stringify(m.configs())}`);
    m.teardown();
  });

  return { passed, failed, errors };
}
