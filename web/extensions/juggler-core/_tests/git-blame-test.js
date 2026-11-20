//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Git pin blame tests — the diff viewer's blame gutter as Changes and History
 * offer it: the toggle asks for the file's blame at the right revision, each
 * run of one commit's lines is named once, and a cell is a way to that commit.
 * @module _tests/git-blame-test
 */

import GitPin from '../pins/git-pin.js';
import { assert, waitFor } from '../../../js-tests/utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';
import { changesOf, commitOf, historyOf, mountPin, shaOf, treeOf } from './git-pin-helpers.js';

/** The commit the fixture's lines come from. */
const BLAMED = shaOf(5);

/**
 * A blame of the helpers' patch (new lines 84 and 85): every line up to 84
 * from BLAMED, line 85 not committed.
 * @returns {any} The blame.
 */
const blameOf = () => ({
  repo: '',
  path: 'src/a.go',
  rev: '',
  commits: [
    { sha: BLAMED, author: 'Ann', date: 1_700_000_000, summary: 'Adds the renderer' },
    { sha: '', author: '', date: 0, summary: '' },
  ],
  lines: [...Array(84).fill(0), 1],
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
    }
  }

  const pin = new GitPin();

  /**
   * @param {any} m - The mounted pin.
   * @returns {any[]} The blame reads asked, in order.
   */
  const blames = (m) => m.reads().filter((/** @type {any} */ r) => r.kind === 'blame').map((/** @type {any} */ r) => r.options);
  /**
   * @param {Element} scope - Where the viewer is.
   * @returns {HTMLElement[]} Its blame cells, in order.
   */
  const cells = (scope) => /** @type {HTMLElement[]} */ ([...scope.querySelectorAll('.line-blame')]);

  /**
   * Mount in Changes with one unstaged file and one staged, and select one.
   * @param {string} key - The row to select.
   * @returns {Promise<any>} The mounted pin, its diff drawn.
   */
  const changesOn = async (key) => {
    const m = mountPin(pin, {
      place: 'changes',
      changes: changesOf([
        { path: 'src/a.go', index: '.', worktree: 'M', unstaged: { added: 1, removed: 0 } },
        { path: 'src/b.go', index: 'M', worktree: '.', staged: { added: 1, removed: 0 } },
        { path: 'new.md', index: '?', worktree: '?' },
      ]),
      blame: blameOf(),
    });
    const row = /** @type {HTMLElement} */ (await waitFor(
      () => m.body.querySelector(`.git-changes__row[data-key="${CSS.escape(key)}"]`), `row ${key}`));
    row.click();
    await waitFor(() => m.body.querySelector('.git-changes__viewer .diff-line'), 'the diff');
    return m;
  };

  await test('Changes: Blame asks the working tree\u2019s blame and names each run once', async () => {
    const m = await changesOn('changes:src/a.go');
    const viewer = /** @type {Element} */ (m.body.querySelector('.git-changes__viewer'));
    assert(cells(viewer).length === 0, 'no gutter until it is asked for');
    /** @type {HTMLElement} */ (m.body.querySelector('.git-changes__crumb .diff-blame-btn')).click();
    await waitFor(() => blames(m).length === 1, 'a blame read');
    const asked = blames(m)[0];
    assert(asked.blame?.path === 'src/a.go' && asked.blame?.rev === '', `the working tree's: ${JSON.stringify(asked)}`);
    await waitFor(() => cells(viewer).some((c) => c.dataset.sha === BLAMED), 'the gutter');
    const [first, second] = /** @type {[HTMLElement, HTMLElement]} */ (cells(viewer));
    assert(Boolean(first && second), `a cell per line: ${cells(viewer).length}`);
    assert((first.textContent || '').includes(BLAMED.slice(0, 7)) && (first.textContent || '').includes('Ann'),
      `line 84 names its commit: ${first.textContent}`);
    assert((first.title || '').includes('Adds the renderer'), `and its subject: ${first.title}`);
    assert((second.textContent || '') === 'Not committed' && !second.dataset.sha, `line 85 is not committed: ${second.outerHTML}`);
    m.teardown();
  });

  await test('Changes: a staged file is blamed in the index; an untracked one is shown whole, with no diff', async () => {
    const m = await changesOn('staged:src/b.go');
    const viewer = /** @type {HTMLElement} */ (m.body.querySelector('.git-changes__viewer'));
    /** @type {HTMLElement} */ (m.body.querySelector('.git-changes__crumb .diff-blame-btn')).click();
    await waitFor(() => blames(m).length === 1, 'a blame read');
    assert(blames(m)[0].blame?.rev === '@staged', `the index's: ${JSON.stringify(blames(m)[0])}`);

    /** @type {HTMLElement} */ (m.body.querySelector('.git-changes__row[data-key="untracked:new.md"]')).click();
    const file = /** @type {HTMLElement} */ (m.body.querySelector('.git-changes__file'));
    assert(file.hidden === false && viewer.hidden === true, 'the file viewer stands in for the diff');
    assert(!m.diffs().some((/** @type {any} */ d) => d.path === 'new.md'), 'an untracked file asks no diff');

    /** @type {HTMLElement} */ (m.body.querySelector('.git-changes__row[data-key="staged:src/b.go"]')).click();
    assert(file.hidden === true && viewer.hidden === false, 'a tracked file is a diff again');
    m.teardown();
  });

  await test('History: Blame asks the commit\u2019s blame, and a cell selects that commit', async () => {
    const m = mountPin(pin, {
      place: 'history',
      log: historyOf(20),
      commit: (/** @type {string} */ rev) => commitOf(rev),
      worktrees: { repo: '', trees: [treeOf({ main: true, current: true, head: shaOf(0) })] },
      blame: blameOf(),
    });
    const row = /** @type {HTMLElement} */ (await waitFor(() => m.body.querySelector('.git-history__row[data-index="0"]'), 'row 0'));
    row.click();
    const detail = /** @type {Element} */ (m.body.querySelector('.git-history__detail'));
    const toggle = /** @type {HTMLElement} */ (await waitFor(() => detail.querySelector('.diff-blame-btn'), 'the commit\u2019s diff'));
    toggle.click();
    await waitFor(() => blames(m).length === 1, 'a blame read');
    assert(blames(m)[0].blame?.rev === shaOf(0) && blames(m)[0].blame?.path === 'src/a.go',
      `at the commit: ${JSON.stringify(blames(m)[0])}`);
    const cell = /** @type {HTMLElement} */ (await waitFor(() => detail.querySelector(`.line-blame[data-sha="${BLAMED}"]`), 'the gutter'));
    cell.click();
    await waitFor(() => m.body.querySelector('.git-history__row[data-index="5"]')?.getAttribute('aria-selected') === 'true',
      'the blamed commit to be selected');
    m.teardown();
  });

  await test('en-XA: the blame gutter speaks the user\u2019s language', async () => {
    await underPseudoLocale('git-blame-test', async () => {
      const m = await changesOn('changes:src/a.go');
      const viewer = /** @type {Element} */ (m.body.querySelector('.git-changes__viewer'));
      /** @type {HTMLElement} */ (m.body.querySelector('.git-changes__crumb .diff-blame-btn')).click();
      await waitFor(() => cells(viewer).some((c) => c.dataset.sha === BLAMED), 'the gutter');
      const shown = [
        ...shownStrings(/** @type {Element} */ (m.body.querySelector('.git-changes__crumb .diff-blame-btn'))),
        ...cells(viewer).flatMap((c) => [c.title, c.dataset.sha ? '' : c.textContent || '']).filter(Boolean),
      ];
      // The fixture's id, author and subject are data.
      const data = /\b[a][0-9a-f]{6}\b|\bAnn\b|Adds the renderer/g;
      const raw = shown.filter((x) => !isPseudoLocalized(x) && /[A-Za-z]/.test(x.replace(data, '')));
      assert(shown.length >= 3, `expected the gutter to show text: ${JSON.stringify(shown)}`);
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
      m.teardown();
    });
  });

  return { passed, failed, errors };
}
