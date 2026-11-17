//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Git pin primary tests — `primaryOf`'s order, as a table: which one action the
 * head offers for each state of a repository, and the words for a running
 * network write's progress.
 * @module _tests/git-primary-test
 */

import { primaryOf, progressText } from '../pins/git/primary.js';
import { assert } from '../../../js-tests/utilities/test-helpers.js';
import { changesOf } from './git-pin-helpers.js';

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
    }
  }

  const tracked = { upstream: 'origin/develop', remotes: 1 };
  const running = (/** @type {object} */ overrides = {}) => ({
    id: 'job_1', workspace: '', repo: '', kind: 'push', commands: [], state: 'running', output: '', errorKind: '', result: {}, ...overrides,
  });

  /**
   * One row of the table: a state, and the kind, label and enabled-ness wanted.
   * @type {{name: string, state: any, kind: string, label: RegExp, disabled?: boolean, spin?: boolean, job?: boolean}[]}
   */
  const rows = [
    {
      name: 'a running push keeps the Push it was started from, spinning and held, with the job',
      state: { read: changesOf([], { ...tracked, ahead: 2 }), changed: 0, staged: 0, conflicts: 0, committing: false, fetching: false,
        job: running({ progress: { phase: 'Writing objects', percent: 45, done: 45, total: 100 } }) },
      kind: 'push', label: /^Push 2$/, spin: true, disabled: true, job: true,
    },
    {
      name: 'a running write that is not the primary leaves it as it was, the job alongside',
      state: { read: changesOf([], { ...tracked, ahead: 2 }), changed: 1, staged: 1, conflicts: 0, committing: false, fetching: false, job: running({ kind: 'fetch' }) },
      kind: 'commit', label: /^Commit 1$/, spin: false, disabled: false, job: true,
    },
    {
      name: 'an operation in progress with conflicts left shows them, and offers nothing remote',
      state: { read: changesOf([], { ...tracked, ahead: 3, operation: 'rebase' }), changed: 2, staged: 0, conflicts: 2, committing: false, fetching: false, job: null },
      kind: 'resolve', label: /^2 conflicts$/, disabled: false,
    },
    {
      name: 'an operation in progress with none left, staged or not, is Continue',
      state: { read: changesOf([], { ...tracked, ahead: 3, operation: 'merge' }), changed: 2, staged: 2, conflicts: 0, committing: false, fetching: false, job: null },
      kind: 'continue', label: /^Continue$/, disabled: false,
    },
    {
      name: 'a running network write rides along with an operation\u2019s action',
      state: { read: changesOf([], { ...tracked, operation: 'merge' }), changed: 1, staged: 0, conflicts: 1, committing: false, fetching: false, job: running({ kind: 'fetch' }) },
      kind: 'resolve', label: /^1 conflict$/, job: true,
    },
    {
      name: 'something staged is a commit, ahead or not',
      state: { read: changesOf([], { ...tracked, ahead: 3 }), changed: 2, staged: 2, conflicts: 0, committing: false, fetching: false, job: null },
      kind: 'commit', label: /^Commit 2$/, disabled: false,
    },
    {
      name: 'a commit already out disables Commit',
      state: { read: changesOf([], tracked), changed: 1, staged: 1, conflicts: 0, committing: true, fetching: false, job: null },
      kind: 'commit', label: /^Commit 1$/, disabled: true,
    },
    {
      name: 'a branch with no upstream is published',
      state: { read: changesOf([], { upstream: '', remotes: 1 }), changed: 0, staged: 0, conflicts: 0, committing: false, fetching: false, job: null },
      kind: 'publish', label: /^Publish$/,
    },
    {
      name: 'ahead and behind is a pull, not a push',
      state: { read: changesOf([], { ...tracked, ahead: 1, behind: 2 }), changed: 0, staged: 0, conflicts: 0, committing: false, fetching: false, job: null },
      kind: 'pull', label: /^Pull$/,
    },
    {
      name: 'ahead is a push of that many',
      state: { read: changesOf([], { ...tracked, ahead: 3 }), changed: 0, staged: 0, conflicts: 0, committing: false, fetching: false, job: null },
      kind: 'push', label: /^Push 3$/,
    },
    {
      name: 'behind is a pull of that many',
      state: { read: changesOf([], { ...tracked, behind: 4 }), changed: 0, staged: 0, conflicts: 0, committing: false, fetching: false, job: null },
      kind: 'pull', label: /^Pull 4$/,
    },
    {
      name: 'up to date is a fetch',
      state: { read: changesOf([], tracked), changed: 0, staged: 0, conflicts: 0, committing: false, fetching: false, job: null },
      kind: 'fetch', label: /^Fetch$/, disabled: false, spin: false,
    },
    {
      name: 'a fetch nobody asked for spins Fetch and holds it',
      state: { read: changesOf([], tracked), changed: 0, staged: 0, conflicts: 0, committing: false, fetching: true, job: null },
      kind: 'fetch', label: /^Fetch$/, disabled: true, spin: true,
    },
    {
      name: 'a repository with no remote stops at the commit button',
      state: { read: changesOf([], { upstream: '', ahead: 0, remotes: 0 }), changed: 0, staged: 0, conflicts: 0, committing: false, fetching: false, job: null },
      kind: 'none', label: /^Clean$/, disabled: true,
    },
    {
      name: 'a detached HEAD with nothing to do fetches rather than publishing',
      state: { read: changesOf([], { branch: '', detached: true, upstream: '', remotes: 1 }), changed: 0, staged: 0, conflicts: 0, committing: false, fetching: false, job: null },
      kind: 'fetch', label: /^Fetch$/,
    },
    {
      name: 'an auto fetch running does not take over the primary',
      state: { read: changesOf([], { ...tracked, ahead: 1 }), changed: 0, staged: 0, conflicts: 0, committing: false, fetching: true, job: null },
      kind: 'push', label: /^Push 1$/,
    },
  ];

  for (const row of rows) {
    await test(row.name, () => {
      const p = primaryOf(row.state);
      assert(p.kind === row.kind, `kind = ${p.kind}, want ${row.kind}`);
      assert(row.label.test(p.label), `label = ${p.label}, want ${row.label}`);
      if (row.disabled !== undefined) assert(p.disabled === row.disabled, `disabled = ${p.disabled}`);
      if (row.spin !== undefined) assert(Boolean(p.spin) === row.spin, `spin = ${p.spin}`);
      assert(Boolean(p.job) === Boolean(row.job), `job = ${p.job?.kind}`);
    });
  }

  await test('a progress reading reads as the phase, how far, and the rate', () => {
    const text = progressText({ phase: 'Receiving objects', percent: 45, done: 450, total: 1000, rate: '2.00 MiB/s' });
    assert(text === 'Receiving objects 45% (450/1000), 2.00 MiB/s', `text = ${text}`);
    const remote = progressText({ phase: 'Enumerating objects', remote: true, percent: -1, done: 5 });
    assert(remote === 'Remote: Enumerating objects: 5', `remote text = ${remote}`);
    const unknown = progressText({ phase: 'Frobbing widgets', percent: 10, done: 1, total: 10 });
    assert(unknown.startsWith('Frobbing widgets 10%'), `an unknown phase is not shown as git said it: ${unknown}`);
    assert(progressText(undefined) === '', 'no reading is not empty');
  });

  return { passed, failed, errors };
}
