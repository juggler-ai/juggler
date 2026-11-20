//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Git pin tests for an operation in progress: the banner above the places and
 * what it says, its Continue, Skip, Abort and Quit, the head's primary while it is in
 * progress, and the commit box standing aside. The fake services are
 * git-pin-helpers'.
 * @module _tests/git-operation-test
 */

import GitPin from '../pins/git-pin.js';
import { assert, waitFor } from '../../../js-tests/utilities/test-helpers.js';
import { underPseudoLocale } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';
import { changesOf, confirmPop, mountPin, shaOf } from './git-pin-helpers.js';

/** The commit a rebase stopped on, and where its branch was before it. */
const PICKED = shaOf(5);
const FROM = shaOf(9);

/** Two files in conflict, and one already resolved. */
const CONFLICTED = [
  { path: 'src/a.js', index: 'U', worktree: 'U', conflicted: true },
  { path: 'src/b.js', index: 'U', worktree: 'U', conflicted: true },
];
const RESOLVED = [{ path: 'src/a.js', index: 'M', worktree: '.', staged: { added: 1, removed: 1 } }];

/**
 * A tree rebasing feat onto develop, stopped at commit 2 of 4.
 * @param {any[]} files - Its changed files.
 * @param {object} [stopped] - What else the operation says.
 * @returns {any} Its changes.
 */
const rebasing = (files, stopped = {}) => changesOf(files, {
  branch: '', detached: true, operation: 'rebase',
  stopped: { kind: 'rebase', branch: 'feat', other: 'develop', otherSha: shaOf(1), commit: { sha: PICKED, subject: 'Teach it' }, step: 2, steps: 4, from: FROM, ...stopped },
});

/**
 * A tree merging topic into main.
 * @param {any[]} files - Its changed files.
 * @returns {any} Its changes.
 */
const merging = (files) => changesOf(files, {
  branch: 'main', operation: 'merge', stopped: { kind: 'merge', branch: 'main', other: 'topic', otherSha: shaOf(2) },
});

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
      for (const pop of document.querySelectorAll('.git-pop, .juggler-context-menu')) pop.remove();
    }
  }

  const pin = new GitPin();

  /**
   * @param {any} m - The mounted pin.
   * @returns {HTMLElement|null} The banner, while it is shown.
   */
  const banner = (m) => /** @type {HTMLElement|null} */ (m.body.querySelector('.git-op:not([hidden])'));
  /**
   * @param {any} m - The mounted pin.
   * @returns {string} The banner's words.
   */
  const bannerText = (m) => banner(m)?.querySelector('.git-op__text')?.textContent || '';
  /**
   * @param {any} m - The mounted pin.
   * @param {'continue'|'skip'|'abort'|'quit'} which - Which button.
   * @returns {HTMLButtonElement} It.
   */
  const button = (m, which) => {
    const found = /** @type {HTMLButtonElement|null} */ (m.body.querySelector(`.git-op__${which}`));
    if (!found) throw new Error(`no ${which} button`);
    return found;
  };
  /**
   * @param {any} m - The mounted pin.
   * @returns {HTMLButtonElement} The head's primary.
   */
  const primary = (m) => /** @type {HTMLButtonElement} */ (m.body.querySelector('.git-pin__primary'));
  /**
   * @param {any} m - The mounted pin.
   * @returns {string} The toast's words, '' when none is up.
   */
  const toastText = (m) => m.body.querySelector('.git-pin__toast:not([hidden]) .git-pin__toast-text')?.textContent || '';
  /**
   * Mount in Changes on these changes, and wait for the banner.
   * @param {any} changes - What `changes()` answers.
   * @returns {Promise<any>} The mounted pin.
   */
  const mounted = async (changes) => {
    const m = mountPin(pin, { place: 'changes', changes });
    await waitFor(() => banner(m) && bannerText(m), 'the banner');
    return m;
  };

  await test('a rebase says what it rebases onto, how far it has got, its conflicts and what it set aside', async () => {
    const m = await mounted(rebasing(CONFLICTED, { setAside: shaOf(7) }));
    const text = bannerText(m);
    assert(text.includes('Rebasing feat onto develop') && text.includes('commit 2 of 4') && text.includes('2 conflicts'), `banner: ${text}`);
    assert(text.includes('your changes are set aside until it finishes'), `the set-aside changes: ${text}`);
    assert(!button(m, 'skip').hidden, 'a rebase can skip');
    assert(m.body.querySelector('.git-pin__head')?.getAttribute('data-operation') === 'rebase', 'the head is marked');
    m.teardown();
  });

  await test('a merge names both branches and offers no Skip; a pick names its commit', async () => {
    const m = await mounted(merging([]));
    assert(bannerText(m).includes('Merging topic into main'), `banner: ${bannerText(m)}`);
    assert(button(m, 'skip').hidden === true, 'a merge has nothing to skip');
    m.teardown();

    const p = await mounted(changesOf([], {
      operation: 'cherry-pick', stopped: { kind: 'cherry-pick', branch: 'develop', commit: { sha: PICKED, subject: 'Teach it' } },
    }));
    assert(bannerText(p).includes(`Cherry-picking ${PICKED.slice(0, 7)} “Teach it”`), `banner: ${bannerText(p)}`);
    p.teardown();
  });

  await test('Continue waits for the conflicts; the primary is them, then Continue, which sends the operation seen', async () => {
    const m = await mounted(rebasing(CONFLICTED));
    const hint = /** @type {HTMLElement|null} */ (m.body.querySelector('.git-op__hint'));
    assert(button(m, 'continue').disabled && !hint?.hidden && hint?.textContent === 'Resolve the conflicts first',
      `Continue is disabled, and says why beside it: ${hint?.textContent}`);
    assert(primary(m).dataset.kind === 'resolve' && (primary(m).textContent || '').includes('2 conflicts'), `primary: ${primary(m).textContent}`);
    assert(Boolean(m.body.querySelector('.git-commit__go')?.hasAttribute('disabled')), 'the commit button stands aside');
    assert((m.body.querySelector('.git-commit__op')?.textContent || '').includes('Continue'), 'the commit box says Continue finishes it');

    primary(m).click();
    await waitFor(() => m.body.querySelector('.git-changes__row[data-key="conflicts:src/a.js"][aria-selected="true"]'),
      'the first conflict to be selected');

    m.setChanges(rebasing(RESOLVED));
    m.emitChange();
    await waitFor(() => primary(m).dataset.kind === 'continue' && !button(m, 'continue').disabled, 'Continue once nothing is unmerged');
    m.setChanges(changesOf(RESOLVED));
    primary(m).click();
    await waitFor(() => m.runs().length === 1, 'the continue');
    const op = m.runs()[0].op;
    assert(op.kind === 'operation-continue' && op.operation === 'rebase', `sent ${JSON.stringify(op)}`);
    await waitFor(() => toastText(m) === 'Rebase finished', 'the finished toast');
    await waitFor(() => !banner(m), 'the banner to go once a read has nothing in progress');
    assert(!m.body.querySelector('.git-pin__head')?.hasAttribute('data-operation'), 'the head is no longer marked');
    m.teardown();
  });

  await test('Abort asks first, saying where the branch goes back to, then aborts', async () => {
    const m = await mounted(rebasing(CONFLICTED));
    button(m, 'abort').click();
    const ask = /** @type {Element} */ (await waitFor(() => document.querySelector('.git-pop .git-pop__text'), 'the question'));
    assert((ask.textContent || '') === `Abort the rebase? Resolutions so far are lost; feat goes back to ${FROM.slice(0, 7)}.`, `asked: ${ask.textContent}`);
    assert(m.runs().length === 0, 'nothing is sent before the answer');
    m.setChanges(changesOf([]));
    /** @type {HTMLElement} */ (document.querySelector('.git-pop .git-pop__ok')).click();
    await waitFor(() => m.runs().length === 1, 'the abort');
    const op = m.runs()[0].op;
    assert(op.kind === 'operation-abort' && op.operation === 'rebase', `sent ${JSON.stringify(op)}`);
    await waitFor(() => toastText(m) === 'Rebase aborted — back where you started', 'the aborted toast');
    m.teardown();
  });

  await test('Skip asks, skips, and a refusal for conflicts offers to show them', async () => {
    const m = await mounted(rebasing(RESOLVED));
    m.holdRuns(true);
    button(m, 'skip').click();
    assert(!m.runs().length, 'skipping a commit asks first');
    assert(confirmPop().includes('left out'), 'and says its change is dropped');
    await waitFor(() => m.runs().length === 1, 'the skip');
    assert(m.runs()[0].op.kind === 'operation-skip' && m.runs()[0].op.operation === 'rebase', `sent ${JSON.stringify(m.runs()[0].op)}`);
    assert(button(m, 'continue').disabled && button(m, 'abort').disabled, 'the banner waits while it runs');
    m.failRun(0, { kind: 'conflicts', message: 'Stopped with conflicts.' });
    const show = /** @type {Element} */ (await waitFor(() => m.body.querySelector('.git-pin__toast:not([hidden]) .git-pin__toast-action:not([hidden])'), 'Show them'));
    assert(show.textContent === 'Show them', `the toast offers ${show.textContent}`);
    assert(m.body.querySelector('.git-pin__toast:not([hidden])')?.classList.contains('git-pin__toast--warn'),
      'stopping on conflicts is a warning, which stays until it is dealt with');
    assert(!button(m, 'continue').disabled, 'the banner can be used again');
    m.teardown();
  });

  await test('a pick stopped between commits says so, and offers Continue and Quit, which forgets it without asking', async () => {
    const m = await mounted(changesOf([], {
      operation: 'cherry-pick', stopped: { kind: 'cherry-pick', branch: 'develop', between: true, left: 1 },
    }));
    const text = bannerText(m);
    assert(text.includes('A cherry-pick stopped between commits') && text.includes('1 more commit to go'), `banner: ${text}`);
    assert(button(m, 'skip').hidden === true && button(m, 'abort').hidden === true, 'nothing to skip, and no rewinding to before the first');
    assert(!button(m, 'continue').hidden && !button(m, 'quit').hidden, 'Continue for the rest, Quit to forget them');

    m.setChanges(changesOf([]));
    button(m, 'quit').click();
    await waitFor(() => m.runs().length === 1, 'the quit');
    const op = m.runs()[0].op;
    assert(op.kind === 'operation-quit' && op.operation === 'cherry-pick', `sent ${JSON.stringify(op)}`);
    await waitFor(() => toastText(m) === 'Cherry-pick forgotten — nothing else changed', 'the forgotten toast');
    m.teardown();

    const stoppedOn = await mounted(changesOf([], {
      operation: 'cherry-pick', stopped: { kind: 'cherry-pick', branch: 'develop', commit: { sha: PICKED, subject: 'Teach it' }, left: 1 },
    }));
    assert(button(stoppedOn, 'quit').hidden === true && !button(stoppedOn, 'abort').hidden, 'a pick stopped on a commit is aborted, not quit');
    stoppedOn.teardown();
  });

  /** The pin's own words the case below draws, registered pseudo-localised. */
  const CORE_TEXT = [
    '{kind, select, rebase {Rebasing {branch} onto {other}} merge {Merging {other} into {branch}} cherry-pick {Cherry-picking {sha} “{subject}”} other {Reverting {sha} “{subject}”}}',
    'commit {step} of {steps}', '{count, plural, one {# conflict} other {# conflicts}}',
    'your changes are set aside until it finishes', 'Continue', 'Skip', 'Abort', 'Resolve the conflicts first',
    '{kind, select, rebase {Abort the rebase? Resolutions so far are lost; {branch} goes back to {sha}.} merge {Abort the merge? Resolutions so far are lost; {branch} goes back to {sha}.} cherry-pick {Abort the cherry-pick? Resolutions so far are lost; {branch} goes back to {sha}.} other {Abort the revert? Resolutions so far are lost; {branch} goes back to {sha}.}}',
    'Cancel',
  ];

  await test('en-XA: the banner and its question speak the user\u2019s language', async () => {
    await underPseudoLocale('git-operation-test', async () => {
      const m = await mounted(rebasing(CONFLICTED, { setAside: shaOf(7) }));
      button(m, 'abort').click();
      await waitFor(() => document.querySelector('.git-pop .git-pop__text'), 'the question');
      const shown = [
        bannerText(m), button(m, 'continue').textContent || '', m.body.querySelector('.git-op__hint')?.textContent || '',
        button(m, 'skip').textContent || '', button(m, 'abort').textContent || '',
        ...[...document.querySelectorAll('.git-pop .git-pop__text, .git-pop button')].map((el) => el.textContent || ''),
      ];
      // Branch names and short ids are data, not words.
      const data = /\b(feat|develop)\b|\b[a-f0-9]{7}\b/g;
      /**
       * @param {string} s - A string shown.
       * @returns {string[]} Its parts between the banner's separators.
       */
      const parts = (s) => s.split(' · ');
      const raw = shown.flatMap(parts).map((x) => x.trim())
        .filter((x) => x && !isPseudoLocalized(x) && /[A-Za-z]/.test(x.replace(data, '')));
      assert(shown.every(Boolean), `expected text: ${JSON.stringify(shown)}`);
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
      m.teardown();
    }, { '@juggler/core': CORE_TEXT });
  });

  return { passed, failed, errors };
}
