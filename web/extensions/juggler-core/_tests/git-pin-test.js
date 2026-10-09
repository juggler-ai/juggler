//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Git pin tests — the board's review of the working tree.
 *
 * Mounted with a hand-built PinContext whose `git` and `review` services the
 * test drives, so a case can state a tree and a draft exactly rather than
 * arranging for git to be in that state. One case goes through the real service
 * to the real server, which is what proves the two halves agree about the shape
 * they pass.
 * @module _tests/git-pin-test
 */

import GitPin from '../pins/git-pin.js';
import gitReviewService from '../../../js/services/git-review-service.js';
import { assert } from '../../../js-tests/utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Run Git pin tests.
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Test results.
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

  /** @returns {Promise<void>} Resolved once the pending promise chains have run. */
  const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

  /**
   * A repo with everything filled in, so a case overrides only what it is about.
   * @param {Partial<import('juggler/pinboard-item-type').PinGitReviewRepo>} [overrides] - What this case cares about.
   * @returns {any} The repo.
   */
  const repo = (overrides = {}) => ({
    path: '',
    changed: 0,
    staged: 0,
    total: 0,
    branch: 'develop',
    upstream: '',
    head: '1111111111111111111111111111111111111111',
    initial: false,
    ahead: 0,
    behind: 0,
    stashes: 0,
    conflicted: 0,
    added: 0,
    removed: 0,
    detached: false,
    files: [],
    truncated: false,
    complete: true,
    ...overrides,
  });

  /**
   * A review manifest with one root repository holding these files.
   * @param {any[]} files - The changed files.
   * @param {object} [overrides] - Manifest-level overrides.
   * @returns {any} The manifest.
   */
  const manifestOf = (files, overrides = {}) => ({
    root: '/tmp/proj',
    complete: true,
    warnings: [],
    repos: [repo({ changed: files.length, total: files.length, files })],
    ...overrides,
  });

  /**
   * A server patch for one file, with one context line and one addition.
   * @param {string} path - The file.
   * @param {object} [overrides] - What this case cares about.
   * @returns {any} The patch.
   */
  const patchOf = (path, overrides = {}) => ({
    repo: '',
    path,
    status: 'modified',
    binary: false,
    conflicted: false,
    truncated: false,
    added: 1,
    removed: 0,
    revision: 'rev1',
    hunks: [{
      oldStart: 84,
      oldLines: 1,
      newStart: 84,
      newLines: 2,
      heading: '',
      lines: [
        { kind: 'context', oldLine: 84, newLine: 84, text: 'const hunks = computeDiff();' },
        { kind: 'add', newLine: 85, text: 'this.renderComments(hunks);' },
      ],
    }],
    ...overrides,
  });

  /**
   * Mount the pin against canned review answers and a canned draft.
   * @param {object} [options] - What this case needs.
   * @param {any} [options.manifest] - What `git.review()` answers with.
   * @param {any} [options.reviewError] - What `git.review()` fails with from the
   *   outset, for a read that never succeeded once.
   * @param {any} [options.draft] - What `review.draft()` answers with; null for
   *   a board with no conversation to keep comments on.
   * @param {(repo: string, path: string) => any} [options.patch] - What
   *   `git.diff()` answers with, per file.
   * @returns {any} The body, controller and the levers a test needs.
   */
  function mount(options = {}) {
    const body = document.createElement('div');
    body.style.width = '60rem';
    body.style.position = 'absolute';
    body.style.left = '-9999px';
    document.body.appendChild(body);
    const abort = new AbortController();

    let manifest = options.manifest === undefined ? manifestOf([]) : options.manifest;
    /** @type {any} */
    let reviewFailure = options.reviewError || null;
    let reviews = 0;
    /** @type {{repo: string, path: string}[]} */
    const diffs = [];
    /** @type {{resolve: (patch: any) => void, reject: (e: any) => void, repo: string, path: string}[]} */
    const pending = [];
    let holdDiffs = false;

    let draft = options.draft === undefined ? { version: 1, base: 'head', comments: [] } : options.draft;
    /** @type {(() => void)[]} */
    const draftListeners = [];
    /** @type {any[]} */
    const saves = [];
    let clears = 0;
    let composes = 0;
    /** @type {any} */
    let saveFailure = null;
    /** @type {any} */
    let composeFailure = null;

    const services = {
      files: { onChange: () => () => {} },
      contextItems: { find: () => null, onChange: () => () => {}, reveal: () => {} },
      git: {
        status: () => null,
        error: () => '',
        onChange: () => () => {},
        refresh: async () => {},
        review: async () => {
          reviews++;
          if (reviewFailure) throw reviewFailure;
          return manifest;
        },
        /**
         * @param {string} repoPath - The repository.
         * @param {string} filePath - The file within it.
         * @returns {Promise<any>} Its patch.
         */
        diff: (repoPath, filePath) => {
          diffs.push({ repo: repoPath, path: filePath });
          if (!holdDiffs) {
            const made = options.patch ? options.patch(repoPath, filePath) : patchOf(filePath);
            return made instanceof Error ? Promise.reject(made) : Promise.resolve(made);
          }
          return new Promise((resolve, reject) => {
            pending.push({ resolve, reject, repo: repoPath, path: filePath });
          });
        },
      },
      review: {
        draft: () => (draft ? JSON.parse(JSON.stringify(draft)) : null),
        /**
         * @param {() => void} listener - Called when the draft may have changed.
         * @returns {() => void} Unsubscribe.
         */
        onChange: (listener) => {
          draftListeners.push(listener);
          return () => {
            const at = draftListeners.indexOf(listener);
            if (at >= 0) draftListeners.splice(at, 1);
          };
        },
        /**
         * @param {any} next - The draft to write.
         * @returns {Promise<void>} Resolved once written.
         */
        save: async (next) => {
          if (saveFailure) throw saveFailure;
          saves.push(next);
          draft = { version: 1, base: 'head', comments: next.comments };
          for (const listener of [...draftListeners]) listener();
        },
        clear: async () => {
          clears++;
          draft = { version: 1, base: 'head', comments: [] };
          for (const listener of [...draftListeners]) listener();
        },
        // The host puts the review in the prompt and leaves the comments alone,
        // so this stub records the call and changes no draft.
        compose: async () => {
          composes++;
          if (composeFailure) throw composeFailure;
        },
      },
    };

    const controller = /** @type {any} */ (pin.mount(body, /** @type {any} */ ({
      pin: { id: 'pin_test', type: 'git', config: {} },
      active: {
        project: { path: '/tmp/proj', displayName: 'proj' },
        conversation: draft === null ? null : { id: 'c1', title: 'Conv' },
        thread: { id: null },
      },
      services,
      signal: abort.signal,
      updateConfig: async () => {},
    })));

    return {
      body,
      controller,
      services,
      text: () => body.textContent || '',
      reviews: () => reviews,
      diffs: () => diffs,
      pending: () => pending,
      saves: () => saves,
      clears: () => clears,
      composes: () => composes,
      draft: () => draft,
      settle,
      holdDiffs: (/** @type {boolean} */ hold) => { holdDiffs = hold; },
      setManifest: (/** @type {any} */ next) => { manifest = next; },
      failReview: (/** @type {any} */ e) => { reviewFailure = e; },
      failSave: (/** @type {any} */ e) => { saveFailure = e; },
      failCompose: (/** @type {any} */ e) => { composeFailure = e; },
      setDraft: (/** @type {any} */ next) => {
        draft = next;
        for (const listener of [...draftListeners]) listener();
      },
      /** @returns {any[]} The file rows, in order. */
      rows: () => [...body.querySelectorAll('.review-panel__file')],
      /** @returns {any} The active file row. */
      active: () => body.querySelector('.review-panel__file[aria-current="true"]'),
      /** @returns {any} The mounted diff viewer, if there is one. */
      viewer: () => body.querySelector('diff-viewer'),
      /** @returns {any[]} Every mounted diff viewer, to be counted. */
      viewers: () => [...body.querySelectorAll('diff-viewer')],
      /** @returns {any} The open comment editor, if there is one. */
      editor: () => body.querySelector('.review-panel__editor'),
      teardown: () => {
        controller.teardown?.();
        abort.abort();
        body.remove();
      },
    };
  }

  /**
   * Mount, and wait for the manifest and the first file's patch to land.
   * @param {object} [options] - Passed to `mount`.
   * @returns {Promise<any>} The mounted pin.
   */
  async function mounted(options = {}) {
    const m = mount(options);
    await settle();
    await settle();
    return m;
  }

  // --- the manifest and its gates ------------------------------------------

  await test('the git pin is a singleton', () => {
    assert(!pin.allowsMultiple, 'two git pins would show the same tree twice');
  });

  await test('a git pin needs a project, and says so', () => {
    const reason = pin.canAdd(/** @type {any} */ ({ project: { path: '' }, conversation: null }));
    assert(reason === 'No project', `expected the reason, got ${JSON.stringify(reason)}`);
    assert(pin.canAdd(/** @type {any} */ ({ project: { path: '/p' } })) === true,
      'a project is all it needs — a git pin does not need a conversation');
  });

  await test('the tab says Git and the body says what it is for', () => {
    const described = pin.describe();
    assert(described.title === 'Git', `expected 'Git', got ${described.title}`);
    assert(described.subtitle === 'Review changes',
      `the pin is the review surface and should say so, got ${JSON.stringify(described.subtitle)}`);
    // The branch would be the obvious badge, and describe gets no services to
    // find it with. Plan and Todo hit the same wall; the body says it instead.
    assert(!described.badge, 'a badge would need the service, which describe is not given');
  });

  await test('the git working tree is a pinnable source, and nothing else is', () => {
    assert(GitPin.canPinSource(/** @type {any} */ ({ kind: 'git' })) === true, 'git should be pinnable');
    assert(GitPin.canPinSource(/** @type {any} */ ({ kind: 'file', path: '/p/a.js' })) === false,
      'a file belongs to the File pin, not this one');
    assert(GitPin.configFromSource(/** @type {any} */ ({ kind: 'git' })) !== null,
      'a git source should produce a config');
    assert(GitPin.configFromSource(/** @type {any} */ ({ kind: 'file' })) === null,
      'a source it rejects should produce no config');
  });

  // --- what it draws --------------------------------------------------------

  await test('nothing read yet is not no repository', () => {
    const m = mount({ manifest: manifestOf([]) });
    assert(m.text().trim() === 'Checking…', `expected 'Checking…', got ${JSON.stringify(m.text())}`);
    m.teardown();
  });

  await test('a project without git says so plainly', async () => {
    const m = await mounted({ manifest: { root: '/tmp/proj', complete: true, warnings: [], repos: [] } });
    assert(m.text().trim() === 'No git repository.', `got ${JSON.stringify(m.text())}`);
    m.teardown();
  });

  await test('a clean tree shows its branch and says nothing changed', async () => {
    const m = await mounted({ manifest: manifestOf([], { repos: [repo({ branch: 'main' })] }) });
    const text = m.text();
    assert(text.includes('main'), `branch missing:\n${text}`);
    assert(text.includes('Nothing changed.'), `expected the clean state:\n${text}`);
    assert(m.rows().length === 0, 'a clean tree has no file rows');
    assert(m.diffs().length === 0, 'and nothing to ask for a patch of');
    m.teardown();
  });

  await test('the scope is named, and never left to be guessed at', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.', added: 3, removed: 1 }]),
    });
    const scope = m.body.querySelector('.review-panel__scope');
    assert(scope?.textContent?.includes('Working tree against HEAD'),
      `the one comparison this ships with has to be named:\n${scope?.textContent}`);
    assert(scope?.textContent?.includes('1 file'), `the file count is missing:\n${scope?.textContent}`);
    assert(!scope?.textContent?.includes('so far'),
      `a complete review states a total, not a floor:\n${scope?.textContent}`);
    m.teardown();
  });

  // The pin follows the visible conversation, so the same pin shows the project
  // and then a worktree. The tree's name comes with the review it describes.
  await test('a workspace tree is named in the scope, and the project is not', async () => {
    const files = [{ path: 'a.js', index: 'M', worktree: '.', added: 1, removed: 0 }];
    const tree = await mounted({ manifest: manifestOf(files, { workspace: 'feat/tunnels' }) });
    const treeScope = tree.body.querySelector('.review-panel__scope')?.textContent || '';
    assert(treeScope.includes('Working tree of feat/tunnels against HEAD'),
      `a worktree's review must say whose tree it is:\n${treeScope}`);
    tree.teardown();

    const empty = await mounted({ manifest: { root: '/tmp/wt', workspace: 'scratch', complete: true, warnings: [], repos: [] } });
    assert(empty.text().trim() === 'No git repository in scratch.', `got ${JSON.stringify(empty.text())}`);
    empty.teardown();

    const project = await mounted({ manifest: manifestOf(files) });
    const projectScope = project.body.querySelector('.review-panel__scope')?.textContent || '';
    assert(projectScope.includes('Working tree against HEAD') && !projectScope.includes(' of '),
      `the project's review names no workspace:\n${projectScope}`);
    project.teardown();
  });

  // --- one file at a time ---------------------------------------------------

  await test('mounting asks for a review and loads only the first file', async () => {
    const m = await mounted({
      manifest: manifestOf([
        { path: 'a.js', index: 'M', worktree: '.' },
        { path: 'b.js', index: '.', worktree: 'M' },
        { path: 'c.js', index: '.', worktree: '?' },
      ]),
    });
    assert(m.reviews() === 1, `expected one review on mount, got ${m.reviews()}`);
    assert(m.rows().length === 3, `expected three file rows, got ${m.rows().length}`);
    assert(m.diffs().length === 1,
      `a dirty tree must not build a diff per file, got ${JSON.stringify(m.diffs())}`);
    assert(m.diffs()[0].path === 'a.js', `expected the first file, got ${m.diffs()[0].path}`);
    assert(m.active()?.textContent?.includes('a.js'), 'the first file should be the selected one');
    assert(m.viewer(), `a selected file should be drawn:\n${m.body.innerHTML}`);
    m.teardown();
  });

  await test('selecting another file loads that one, and only then', async () => {
    const m = await mounted({
      manifest: manifestOf([
        { path: 'a.js', index: 'M', worktree: '.' },
        { path: 'b.js', index: '.', worktree: 'M' },
      ]),
    });
    m.rows()[1].click();
    await settle();
    assert(m.diffs().length === 2, `expected a second request, got ${JSON.stringify(m.diffs())}`);
    assert(m.diffs()[1].path === 'b.js', `expected b.js, got ${m.diffs()[1].path}`);
    assert(m.active()?.textContent?.includes('b.js'), 'the clicked row should become current');
    assert(m.text().includes('b.js'), `the diff should name the file it drew:\n${m.text()}`);
    m.teardown();
  });

  await test('a large dirty tree draws one diff, however much of it is walked', async () => {
    // The request count is the cheap half of this and is covered above. This is
    // the other half: the rail can be arbitrarily long, but the DOM holds one
    // patch at a time, and walking the rail reuses that one rather than leaving
    // a viewer behind at every file visited.
    const files = Array.from({ length: 40 }, (_, at) => ({
      path: `src/dir${at}/file${at}.js`,
      index: 'M',
      worktree: '.',
    }));
    const m = await mounted({ manifest: manifestOf(files) });
    assert(m.rows().length === 40, `expected a row per file, got ${m.rows().length}`);
    assert(m.viewers().length === 1,
      `a dirty tree must not build a diff per file, got ${m.viewers().length}`);

    for (const at of [7, 19, 39]) {
      m.rows()[at].click();
      await settle();
    }
    assert(m.viewers().length === 1,
      `walking the rail must reuse the one viewer, got ${m.viewers().length}`);
    assert(m.active()?.textContent?.includes('file39.js'), 'the last file walked to should be current');
    assert(m.diffs().length === 4,
      `expected one request per file visited, got ${JSON.stringify(m.diffs().map((d) => d.path))}`);
    m.teardown();
  });

  await test('a file is named by its repository as well as its path', async () => {
    const m = await mounted({
      manifest: {
        root: '/tmp/proj',
        complete: true,
        warnings: [],
        repos: [
          repo({ path: '', changed: 1, total: 1, files: [{ path: 'src/main.go', index: 'M', worktree: '.' }] }),
          repo({
            path: 'vendor/lib',
            branch: 'main',
            changed: 1,
            total: 1,
            files: [{ path: 'src/main.go', index: 'M', worktree: '.' }],
          }),
        ],
      },
    });
    assert(m.rows().length === 2, `both files should be listed, got ${m.rows().length}`);
    m.rows()[1].click();
    await settle();
    assert(m.diffs().length === 2, `expected the second repo's file to be asked for: ${JSON.stringify(m.diffs())}`);
    assert(m.diffs()[1].repo === 'vendor/lib' && m.diffs()[1].path === 'src/main.go',
      `two src/main.go are two files, not one: ${JSON.stringify(m.diffs()[1])}`);
    const labels = m.rows().map((/** @type {any} */ r) => r.getAttribute('aria-label') || '');
    assert(labels[0] !== labels[1],
      `two rows reading identically are indistinguishable aloud: ${JSON.stringify(labels)}`);
    assert(labels[1].includes('vendor/lib'), `the nested repo belongs in the label: ${labels[1]}`);
    m.teardown();
  });

  await test('a patch that outlived its selection is not drawn', async () => {
    const m = mount({
      manifest: manifestOf([
        { path: 'a.js', index: 'M', worktree: '.' },
        { path: 'b.js', index: '.', worktree: 'M' },
      ]),
    });
    m.holdDiffs(true);
    await settle();
    m.rows()[1].click();
    await settle();
    assert(m.pending().length === 2, `expected both reads out, got ${m.pending().length}`);
    // The first file's patch lands last. It is an answer to a question nobody is
    // asking any more, and drawing it would show b.js's row over a.js's diff.
    m.pending()[1].resolve(patchOf('b.js'));
    await settle();
    m.pending()[0].resolve(patchOf('a.js'));
    await settle();
    assert(m.viewer()?.textContent?.includes('b.js'),
      `the selected file's diff should stand:\n${m.viewer()?.textContent}`);
    assert(!m.viewer()?.textContent?.includes('a.js'),
      `a stale answer must not replace it:\n${m.viewer()?.textContent}`);
    m.teardown();
  });

  await test('a file whose patch fails says so and keeps the rail', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
      patch: () => new Error('git: index locked'),
    });
    const text = m.text();
    assert(text.includes("Couldn't load this diff."), `expected the plain-English lead:\n${text}`);
    assert(text.includes('git: index locked'), `the underlying error must survive:\n${text}`);
    assert(m.rows().length === 1, 'the file list is still worth showing');
    m.teardown();
  });

  // --- refresh --------------------------------------------------------------

  await test('refresh asks again and keeps the file that was being read', async () => {
    const m = await mounted({
      manifest: manifestOf([
        { path: 'a.js', index: 'M', worktree: '.' },
        { path: 'b.js', index: '.', worktree: 'M' },
      ]),
    });
    m.rows()[1].click();
    await settle();
    const actions = m.controller.getActions();
    assert(actions.some((/** @type {any} */ a) => a.id === 'refresh'),
      `Refresh is how the user asks again, got ${actions.map((/** @type {any} */ a) => a.id).join(', ')}`);
    await actions.find((/** @type {any} */ a) => a.id === 'refresh').run();
    await settle();
    assert(m.reviews() === 2, `expected a second review, got ${m.reviews()}`);
    assert(m.active()?.textContent?.includes('b.js'),
      'a refresh that moved the selection would lose the reader\'s place');
    const last = m.diffs()[m.diffs().length - 1];
    assert(last.path === 'b.js', `and the patch is re-read, not reused: ${JSON.stringify(m.diffs())}`);
    m.teardown();
  });

  await test('a file that went away takes the selection with it', async () => {
    const m = await mounted({
      manifest: manifestOf([
        { path: 'a.js', index: 'M', worktree: '.' },
        { path: 'b.js', index: '.', worktree: 'M' },
      ]),
    });
    m.rows()[1].click();
    await settle();
    m.setManifest(manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]));
    await m.controller.getActions().find((/** @type {any} */ a) => a.id === 'refresh').run();
    await settle();
    assert(m.rows().length === 1, `expected the one remaining file, got ${m.rows().length}`);
    assert(m.active()?.textContent?.includes('a.js'),
      'with the read file gone, the first one is the only honest selection');
    m.teardown();
  });

  await test('a failed refresh keeps the last good review on screen', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
    });
    m.failReview(new Error('network error'));
    await m.controller.getActions().find((/** @type {any} */ a) => a.id === 'refresh').run();
    await settle();
    const text = m.text();
    assert(text.includes('a.js'), `blanking the panel loses more than staleness costs:\n${text}`);
    assert(text.includes("Couldn't refresh.") && text.includes('network error'),
      `and it says why it is stale, with the error intact:\n${text}`);
    m.teardown();
  });

  await test('a first read that fails says so instead of claiming a clean tree', async () => {
    // Armed before the mount, because the pin asks the moment it is mounted.
    const m = await mounted({ reviewError: new Error('git: command not found') });
    const text = m.text();
    assert(!text.includes('Nothing changed.'),
      `a failure is not a clean tree, and must never be drawn as one:\n${text}`);
    assert(text.includes("Couldn't read the working tree.") && text.includes('git: command not found'),
      `expected the lead and the underlying error:\n${text}`);
    m.teardown();
  });

  await test('an incomplete review says what it could not reach', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }], {
        complete: false,
        warnings: ['0 of 431 changed files listed in vendor/lib.'],
      }),
    });
    const text = m.text();
    assert(text.includes('0 of 431 changed files listed in vendor/lib.'),
      `the server's own words are the warning, verbatim:\n${text}`);
    const warnings = m.body.querySelector('.review-panel__warnings');
    assert(warnings, `an incomplete review has to say so prominently:\n${m.body.innerHTML}`);
    assert(text.includes('1 file so far'),
      `and the count it does show is a floor, not a total:\n${text}`);
    m.teardown();
  });

  await test('a repository git could not read is listed with its reason', async () => {
    const m = await mounted({
      manifest: {
        root: '/tmp/proj',
        complete: false,
        warnings: [],
        repos: [repo({
          path: 'vendor/lib',
          complete: false,
          error: 'fatal: not a git repository',
        })],
      },
    });
    assert(m.text().includes('fatal: not a git repository'),
      `dropping it would turn "I could not read this" into "there is nothing here":\n${m.text()}`);
    m.teardown();
  });

  // --- keyboard -------------------------------------------------------------

  await test('the file rail moves under the arrow keys', async () => {
    const m = await mounted({
      manifest: manifestOf([
        { path: 'a.js', index: 'M', worktree: '.' },
        { path: 'b.js', index: '.', worktree: 'M' },
        { path: 'c.js', index: '.', worktree: '?' },
      ]),
    });
    const rows = m.rows();
    // Focus is observed rather than read back from `document.activeElement`. The
    // lanes in one window share a single focused frame, so a sibling lane
    // focusing anything takes this document's active element to its body — which
    // makes reading it back a measure of what else is running.
    /** @type {any[]} */
    const focused = [];
    for (const row of rows) row.focus = () => { focused.push(row); };

    /**
     * @param {any} row - The row to send the key to.
     * @param {string} key - The key.
     * @returns {Promise<void>} Resolved once the selection has moved.
     */
    const press = async (row, key) => {
      row.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      await settle();
    };

    await press(rows[0], 'ArrowDown');
    assert(m.active() === rows[1], `Down should move to the next file, got ${m.active()?.textContent}`);
    assert(focused[focused.length - 1] === rows[1], 'and focus should go with it');
    assert(rows[1].tabIndex === 0 && rows[0].tabIndex === -1 && rows[2].tabIndex === -1,
      `Tab should reach the row being read and no other, got ${rows.map((/** @type {any} */ r) => r.tabIndex)}`);

    await press(rows[1], 'End');
    assert(m.active() === rows[2], `End should reach the last file, got ${m.active()?.textContent}`);
    await press(rows[2], 'Home');
    assert(m.active() === rows[0], `Home should come back to the first, got ${m.active()?.textContent}`);
    m.teardown();
  });

  await test('the rail leaves Left and Right to the Pinboard', async () => {
    const m = await mounted({
      manifest: manifestOf([
        { path: 'a.js', index: 'M', worktree: '.' },
        { path: 'b.js', index: '.', worktree: 'M' },
      ]),
    });
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    m.rows()[0].dispatchEvent(event);
    assert(!event.defaultPrevented,
      'Left and Right change pins; a rail that swallowed them would trap the reader in one');
    m.teardown();
  });

  // --- comments -------------------------------------------------------------

  await test('an anchor opens an editor that saves a comment where it was written', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
    });
    const anchor = m.viewer().querySelector('.diff-comment-btn[data-line="85"]');
    assert(anchor, `an annotatable diff offers an anchor per line:\n${m.viewer().innerHTML}`);
    anchor.click();
    await settle();
    const editor = m.editor();
    assert(editor, `clicking an anchor should open an editor:\n${m.body.innerHTML}`);
    const textarea = editor.querySelector('textarea');
    assert(textarea, 'and the editor has a labelled textarea');
    assert(editor.textContent.includes('new line 85'),
      `the editor says what it is about:\n${editor.textContent}`);

    textarea.value = 'Split this into two methods.';
    editor.querySelector('.review-panel__save').click();
    await settle();

    const saved = m.saves();
    assert(saved.length === 1, `expected one save, got ${saved.length}`);
    const comment = saved[0].comments[0];
    assert(comment.body === 'Split this into two methods.', `body missing: ${JSON.stringify(comment)}`);
    assert(comment.side === 'new' && comment.startLine === 85 && comment.endLine === 85,
      `the anchor is the comment's address: ${JSON.stringify(comment)}`);
    assert(comment.path === 'a.js' && comment.repo === '', `the file is part of it: ${JSON.stringify(comment)}`);
    assert(comment.revision === 'rev1',
      `without the revision nothing can tell later that the file moved on: ${JSON.stringify(comment)}`);
    assert(comment.lineText.join('\n').includes('this.renderComments(hunks);'),
      `the quote is what is left once the file changes: ${JSON.stringify(comment.lineText)}`);
    assert(!m.editor(), 'a saved comment closes its editor');
    m.teardown();
  });

  await test('a refused save keeps the words on screen and says why', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
    });
    m.failSave(new Error('A comment holds at most 8000 characters; this one has 9001.'));
    m.viewer().querySelector('.diff-comment-btn[data-line="85"]').click();
    await settle();
    const textarea = m.editor().querySelector('textarea');
    textarea.value = 'Too long, apparently.';
    m.editor().querySelector('.review-panel__save').click();
    await settle();

    assert(m.editor(), 'the editor stays open — the text has nowhere else to be');
    assert(m.editor().querySelector('textarea').value === 'Too long, apparently.',
      'and the words are still there');
    assert(m.editor().textContent.includes('this one has 9001'),
      `with the underlying reason intact:\n${m.editor().textContent}`);
    m.teardown();
  });

  await test('Escape abandons a comment and gives the anchor back', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
    });
    const anchor = m.viewer().querySelector('.diff-comment-btn[data-line="85"]');
    anchor.click();
    await settle();
    // Observed, not read back from `document.activeElement`: see the rail's own
    // keyboard case for why that is a measure of the other lanes.
    let refocused = false;
    anchor.focus = () => { refocused = true; };
    const textarea = m.editor().querySelector('textarea');
    textarea.value = 'Never mind.';
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    assert(!m.editor(), 'Escape should close the editor');
    assert(m.saves().length === 0, 'and write nothing');
    assert(refocused, 'and focus belongs back on the anchor it came from');
    m.teardown();
  });

  await test('a saved comment is drawn against its line and counted on its row', async () => {
    const m = await mounted({
      manifest: manifestOf([
        { path: 'a.js', index: 'M', worktree: '.' },
        { path: 'b.js', index: '.', worktree: 'M' },
      ]),
      draft: {
        version: 1,
        base: 'head',
        comments: [{
          id: 'c_1',
          repo: '',
          path: 'a.js',
          side: 'new',
          startLine: 85,
          endLine: 85,
          lineText: ['this.renderComments(hunks);'],
          body: 'Keep annotation state outside the renderer.',
          revision: 'rev1',
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    });
    assert(m.viewer().textContent.includes('Keep annotation state outside the renderer.'),
      `the comment belongs against the line it is about:\n${m.viewer().textContent}`);
    const counts = m.rows().map((/** @type {any} */ r) => r.querySelector('.review-panel__count')?.textContent || '');
    assert(counts[0] === '1', `the file with the comment should count it, got ${JSON.stringify(counts)}`);
    assert(counts[1] === '', 'and the file without one should say nothing');
    assert(m.rows()[0].getAttribute('aria-label')?.includes('1 comment'),
      `the count has to be readable aloud too: ${m.rows()[0].getAttribute('aria-label')}`);
    m.teardown();
  });

  await test('a comment on another file is not drawn over this one', async () => {
    const m = await mounted({
      manifest: manifestOf([
        { path: 'a.js', index: 'M', worktree: '.' },
        { path: 'b.js', index: '.', worktree: 'M' },
      ]),
      draft: {
        version: 1,
        base: 'head',
        comments: [{
          id: 'c_1',
          repo: '',
          path: 'b.js',
          side: 'new',
          startLine: 85,
          endLine: 85,
          lineText: [],
          body: 'Belongs to b.js alone.',
          revision: 'rev1',
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    });
    assert(!m.viewer().textContent.includes('Belongs to b.js alone.'),
      `a.js is the file on screen:\n${m.viewer().textContent}`);
    m.teardown();
  });

  await test('deleting a comment writes the rest back', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
      draft: {
        version: 1,
        base: 'head',
        comments: [
          {
            id: 'c_1',
            repo: '',
            path: 'a.js',
            side: 'new',
            startLine: 85,
            endLine: 85,
            lineText: [],
            body: 'First.',
            revision: 'rev1',
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: 'c_2',
            repo: '',
            path: 'a.js',
            side: 'file',
            lineText: [],
            body: 'Second.',
            revision: 'rev1',
            createdAt: 2,
            updatedAt: 2,
          },
        ],
      },
    });
    m.viewer().querySelector('.diff-comment[data-id="c_1"] .diff-comment-delete').click();
    await settle();
    const saved = m.saves();
    assert(saved.length === 1, `expected the remainder written back, got ${saved.length}`);
    assert(saved[0].comments.length === 1 && saved[0].comments[0].id === 'c_2',
      `only the deleted one should go: ${JSON.stringify(saved[0].comments.map((/** @type {any} */ c) => c.id))}`);
    m.teardown();
  });

  await test('editing a comment reopens it with its own words', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
      draft: {
        version: 1,
        base: 'head',
        comments: [{
          id: 'c_1',
          repo: '',
          path: 'a.js',
          side: 'new',
          startLine: 85,
          endLine: 85,
          lineText: ['this.renderComments(hunks);'],
          body: 'First thought.',
          revision: 'rev1',
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    });
    m.viewer().querySelector('.diff-comment[data-id="c_1"] .diff-comment-edit').click();
    await settle();
    const textarea = m.editor()?.querySelector('textarea');
    assert(textarea?.value === 'First thought.',
      `an edit starts from what is there, got ${JSON.stringify(textarea?.value)}`);
    textarea.value = 'Second thought.';
    m.editor().querySelector('.review-panel__save').click();
    await settle();
    const comments = m.saves()[0].comments;
    assert(comments.length === 1 && comments[0].id === 'c_1',
      `an edit replaces the comment rather than adding one: ${JSON.stringify(comments)}`);
    assert(comments[0].body === 'Second thought.', `the new words should stick: ${JSON.stringify(comments[0])}`);
    assert(comments[0].createdAt === 1, 'and it is still the comment it was');
    m.teardown();
  });

  await test('a file with no lines to comment on can still be commented on', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'logo.png', index: 'M', worktree: '.' }]),
      patch: () => patchOf('logo.png', { binary: true, hunks: [], added: 0, removed: 0 }),
    });
    assert(m.viewer().textContent.includes('Binary file'),
      `it should say why there are no lines:\n${m.viewer().textContent}`);
    const whole = m.body.querySelector('.review-panel__file-comment');
    assert(whole, `a file with no line to hang a comment on still needs one:\n${m.body.innerHTML}`);
    whole.click();
    await settle();
    m.editor().querySelector('textarea').value = 'Is this meant to be here?';
    m.editor().querySelector('.review-panel__save').click();
    await settle();
    const comment = m.saves()[0].comments[0];
    assert(comment.side === 'file' && comment.startLine === undefined,
      `a whole-file comment names no line: ${JSON.stringify(comment)}`);
    m.teardown();
  });

  await test('a conflicted file stays selectable and says what it is', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'U', worktree: 'U', conflicted: true }]),
      patch: () => patchOf('a.js', { conflicted: true, status: 'conflicted' }),
    });
    assert(m.rows().length === 1 && m.viewer(), 'a conflict is still worth reading');
    assert(m.viewer().textContent.includes('Unresolved merge conflict'),
      `and it should say so:\n${m.viewer().textContent}`);
    m.teardown();
  });

  await test('each row is coloured by what happened to the file', async () => {
    const m = await mounted({
      manifest: manifestOf([
        { path: 'src/kept.js', index: 'M', worktree: '.' },
        { path: 'src/new.js', index: 'A', worktree: '.' },
        { path: 'src/gone.js', index: 'D', worktree: '.' },
        { path: 'src/loose.js', index: '.', worktree: '?' },
        { path: 'src/moved.js', oldPath: 'src/was.js', index: 'R', worktree: '.' },
        { path: 'src/clash.js', index: 'U', worktree: 'U', conflicted: true },
      ]),
    });
    const tones = m.rows().map((/** @type {any} */ row) => row.dataset.tone || '');
    assert(JSON.stringify(tones) === JSON.stringify(
      ['modified', 'added', 'removed', 'added', 'renamed', 'conflicted']),
    `each kind of change is marked as its own: ${JSON.stringify(tones)}`);
    // Two tones, two colours, in both the places a row shows one: the marks are
    // painted, not merely recorded.
    const colour = (/** @type {number} */ at, /** @type {string} */ part) =>
      getComputedStyle(m.rows()[at].querySelector(`.review-panel__${part}`)).color;
    assert(colour(1, 'code') !== colour(2, 'code'),
      `added and removed letters must not read alike: ${colour(1, 'code')}`);
    assert(colour(1, 'name') !== colour(2, 'name'),
      `nor their names: ${colour(1, 'name')}`);
    assert(colour(1, 'name') !== colour(1, 'dir'),
      `and the tint is on the name, the directory staying quiet: ${colour(1, 'name')}`);
    m.teardown();
  });

  await test('a renamed file is read under its new name and says where it came from', async () => {
    const m = await mounted({
      manifest: manifestOf([{
        path: 'web/js/components/review-panel.js',
        oldPath: 'web/js/components/changed-files.js',
        index: 'R',
        worktree: '.',
      }]),
    });
    const row = m.rows()[0];
    assert(row.querySelector('.review-panel__code')?.textContent === 'R ',
      `git's own letter for a rename: ${JSON.stringify(row.querySelector('.review-panel__code')?.textContent)}`);
    assert(row.querySelector('.review-panel__name')?.textContent === 'review-panel.js',
      `a row is read for where the file is now: ${row.querySelector('.review-panel__name')?.textContent}`);
    // Both names, because "Renamed" without the old one does not say from what.
    assert(row.getAttribute('aria-label')?.includes('from web/js/components/changed-files.js'),
      `the row should say where it moved from: ${row.getAttribute('aria-label')}`);
    assert(row.title === 'web/js/components/changed-files.js → web/js/components/review-panel.js',
      `and show both on hover: ${JSON.stringify(row.title)}`);
    const head = m.body.querySelector('.review-panel__diff-path');
    assert(head?.textContent === 'web/js/components/changed-files.js → web/js/components/review-panel.js',
      `the diff names the move it is showing: ${JSON.stringify(head?.textContent)}`);
    m.teardown();
  });

  // --- the draft ------------------------------------------------------------

  await test('the footer counts the batch and offers the two things to do with it', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
      draft: {
        version: 1,
        base: 'head',
        comments: [
          {
            id: 'c_1', repo: '', path: 'a.js', side: 'new', startLine: 85, endLine: 85,
            lineText: [], body: 'One.', revision: 'rev1', createdAt: 1, updatedAt: 1,
          },
          {
            id: 'c_2', repo: '', path: 'a.js', side: 'file',
            lineText: [], body: 'Two.', revision: 'rev1', createdAt: 2, updatedAt: 2,
          },
        ],
      },
    });
    const footer = m.body.querySelector('.review-panel__footer');
    assert(footer?.textContent?.includes('2 draft comments'),
      `expected the batch counted, got ${JSON.stringify(footer?.textContent)}`);
    assert(footer.querySelector('.review-panel__compose') && footer.querySelector('.review-panel__discard'),
      `both buttons act on the draft, so they live with it:\n${footer.innerHTML}`);

    footer.querySelector('.review-panel__compose').click();
    await settle();
    assert(m.composes() === 1, `expected one hand-over, got ${m.composes()}`);
    // Handing the feedback over is not spending it: it is text in a box, which
    // the reader can still cut down or delete, so the batch is theirs until they
    // discard it.
    assert(m.draft().comments.length === 2, 'the comments stay on the draft');
    assert(m.body.querySelector('.review-panel__footer')?.textContent?.includes('2 draft comments'),
      'and the footer goes on counting them');
    m.teardown();
  });

  await test('the buttons say what they will do, and the primary one looks like one', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
    });
    m.viewer().querySelectorAll('.diff-comment-btn')[0].click();
    await settle();

    // "Save" says where the words go, which is the one thing a reader cannot
    // guess: a comment is kept on a batch and nothing is said to anyone yet.
    const save = m.editor().querySelector('.review-panel__save');
    assert(save.textContent === 'Add to feedback',
      `a new comment joins the batch: ${JSON.stringify(save.textContent)}`);

    // The primary action must not be drawn as the secondary one beside it.
    // Identical fills are what made this read as a disabled button.
    const cancel = m.editor().querySelector('.review-panel__cancel');
    const fill = (/** @type {Element} */ node) => getComputedStyle(node).backgroundColor;
    assert(fill(save) !== fill(cancel),
      `the accented button is drawn exactly like the one that cancels it: both ${fill(save)}`);
    assert(getComputedStyle(save).color !== getComputedStyle(cancel).color,
      'and carries its own text colour with it');

    m.editor().querySelector('textarea').value = 'A first thought.';
    m.editor().querySelector('.review-panel__save').click();
    await settle();

    // Editing one is not adding one — the comment is replaced in place — so the
    // button may not claim a second comment is about to appear.
    m.viewer().querySelector('.diff-comment-edit')?.click();
    await settle();
    const editing = m.editor()?.querySelector('.review-panel__save');
    assert(editing?.textContent === 'Save changes',
      `an edit replaces what is there: ${JSON.stringify(editing?.textContent)}`);
    m.teardown();
  });

  await test('the footer says where the feedback is going', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
      draft: {
        version: 1,
        base: 'head',
        comments: [{
          id: 'c_1', repo: '', path: 'a.js', side: 'file',
          lineText: [], body: 'One.', revision: 'rev1', createdAt: 1, updatedAt: 1,
        }],
      },
    });
    // It lands in the prompt for the reader to read back and edit, so the label
    // has to promise that rather than an action that has already happened.
    const button = m.body.querySelector('.review-panel__compose');
    assert(button?.textContent === 'Paste feedback into prompt',
      `the footer must say where the batch goes: ${JSON.stringify(button?.textContent)}`);
    m.teardown();
  });

  await test('one comment is one comment', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
      draft: {
        version: 1,
        base: 'head',
        comments: [{
          id: 'c_1', repo: '', path: 'a.js', side: 'file',
          lineText: [], body: 'Only.', revision: 'rev1', createdAt: 1, updatedAt: 1,
        }],
      },
    });
    assert(m.body.querySelector('.review-panel__footer')?.textContent?.includes('1 draft comment'),
      `expected the singular, got ${JSON.stringify(m.body.querySelector('.review-panel__footer')?.textContent)}`);
    m.teardown();
  });

  await test('a hand-over that fails leaves every comment where it was', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
      draft: {
        version: 1,
        base: 'head',
        comments: [{
          id: 'c_1', repo: '', path: 'a.js', side: 'file',
          lineText: [], body: 'Still unsaid.', revision: 'rev1', createdAt: 1, updatedAt: 1,
        }],
      },
    });
    m.failCompose(new Error('worker rejected the message'));
    m.body.querySelector('.review-panel__compose').click();
    await settle();
    const text = m.text();
    assert(text.includes("Couldn't put the feedback in the prompt.") && text.includes('worker rejected the message'),
      `expected the lead and the underlying error:\n${text}`);
    assert(m.draft().comments.length === 1, 'and the comments are still there — they have not been said yet');
    assert(m.body.querySelector('.review-panel__footer'), 'so the footer stays too');
    m.teardown();
  });

  await test('Discard throws the batch away', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
      draft: {
        version: 1,
        base: 'head',
        comments: [{
          id: 'c_1', repo: '', path: 'a.js', side: 'file',
          lineText: [], body: 'Wrong on reflection.', revision: 'rev1', createdAt: 1, updatedAt: 1,
        }],
      },
    });
    m.body.querySelector('.review-panel__discard').click();
    await settle();
    assert(m.clears() === 1, `expected one clear, got ${m.clears()}`);
    assert(!m.body.querySelector('.review-panel__footer'), 'and nothing left to act on');
    m.teardown();
  });

  await test('a draft saved elsewhere shows up here', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
    });
    assert(!m.body.querySelector('.review-panel__footer'), 'nothing written yet');
    m.setDraft({
      version: 1,
      base: 'head',
      comments: [{
        id: 'c_9', repo: '', path: 'a.js', side: 'new', startLine: 85, endLine: 85,
        lineText: [], body: 'Written in the other window.', revision: 'rev1', createdAt: 1, updatedAt: 1,
      }],
    });
    await settle();
    assert(m.text().includes('Written in the other window.'),
      `a draft is one record, wherever it was written:\n${m.text()}`);
    m.teardown();
  });

  await test('an outdated comment is set aside, never moved', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
      draft: {
        version: 1,
        base: 'head',
        comments: [{
          id: 'c_1', repo: '', path: 'a.js', side: 'new', startLine: 85, endLine: 85,
          lineText: ['the line as it was'], body: 'Written against the old file.',
          revision: 'rev0', createdAt: 1, updatedAt: 1,
        }],
      },
    });
    const stale = m.viewer().querySelector('.diff-file-comment-list.stale');
    assert(stale, `a comment whose file moved on belongs under Outdated:\n${m.viewer().innerHTML}`);
    assert(stale.textContent.includes('the line as it was'),
      `with the code it was written about, which is all that is left of it:\n${stale.textContent}`);
    assert(!m.viewer().querySelector('.diff-comments .diff-comment[data-id="c_1"]'),
      'and never attached to whatever now occupies line 85');
    m.teardown();
  });

  await test('a board with no conversation says so rather than taking comments', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
      draft: null,
    });
    assert(m.viewer(), 'the tree is still worth reading without a conversation');
    assert(!m.viewer().querySelector('.diff-comment-btn'),
      'but there is nowhere to put a comment, so none is offered');
    assert(m.text().includes('No conversation open, so there is nowhere to put a comment.'),
      `and it says why, rather than leaving the reader to wonder:\n${m.text()}`);
    m.teardown();
  });

  // --- staying current ------------------------------------------------------

  await test('a new active context redraws in place rather than remounting', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
    });
    m.controller.update({
      pin: { id: 'pin_test', type: 'git', config: {} },
      active: { project: { path: '/tmp/proj', displayName: 'proj' }, conversation: null, thread: null },
      services: m.services,
      signal: new AbortController().signal,
      updateConfig: async () => {},
    });
    await settle();
    assert(m.rows().length === 1, `the review should survive a context update:\n${m.body.innerHTML}`);
    assert(m.reviews() === 1, `and not re-read the whole tree for it, got ${m.reviews()}`);
    m.teardown();
  });

  await test('teardown stops watching the draft', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
    });
    m.controller.teardown();
    m.setDraft({
      version: 1,
      base: 'head',
      comments: [{
        id: 'c_1', repo: '', path: 'a.js', side: 'file',
        lineText: [], body: 'After the end.', revision: 'rev1', createdAt: 1, updatedAt: 1,
      }],
    });
    await settle();
    assert(!m.text().includes('After the end.'),
      `a torn-down pin should not still be drawing:\n${m.text()}`);
    m.teardown();
  });

  // --- narrow -------------------------------------------------------------

  await test('a docked Pinboard stacks the rail above the diff', async () => {
    const m = await mounted({
      manifest: manifestOf([{ path: 'a.js', index: 'M', worktree: '.' }]),
    });
    m.body.style.width = '20rem';
    const main = /** @type {HTMLElement} */ (m.body.querySelector('.review-panel__main'));
    const rail = /** @type {HTMLElement} */ (m.body.querySelector('.review-panel__rail'));
    const diff = /** @type {HTMLElement} */ (m.body.querySelector('.review-panel__diff'));
    assert(main && rail && diff, 'the panel should have a rail and a diff area');
    // A container query, not a media query: the Pinboard can be 20rem wide on a
    // desktop, so the viewport says nothing about the room this panel has.
    assert(rail.offsetWidth > diff.offsetWidth * 0.5,
      `at 20rem the rail should span the panel rather than share a row with the diff:`
      + ` rail ${rail.offsetWidth}, diff ${diff.offsetWidth}`);
    m.body.style.width = '60rem';
    assert(rail.offsetWidth < diff.offsetWidth,
      `and give way to the diff when there is room: rail ${rail.offsetWidth}, diff ${diff.offsetWidth}`);
    m.teardown();
  });

  await test('a long path costs a row no height, and the name survives it', async () => {
    const m = await mounted({
      manifest: manifestOf([
        { path: 'x/a.js', index: 'M', worktree: '.', added: 126, removed: 43 },
        { path: 'web/js/components/review-panel.js', index: 'M', worktree: '.', added: 126, removed: 43 },
      ]),
    });
    // Both widths, because the rail is at its most cramped on a wide board:
    // there it is a bounded share of the panel, capped at 22rem however wide
    // the window is, and every fixed thing in a row is width the path loses.
    for (const width of ['60rem', '20rem']) {
      m.body.style.width = width;
      const rail = /** @type {HTMLElement} */ (m.body.querySelector('.review-panel__rail'));
      const rows = /** @type {HTMLElement[]} */ ([...m.body.querySelectorAll('.review-panel__row')]);
      const paths = /** @type {HTMLElement[]} */ ([...m.body.querySelectorAll('.review-panel__path')]);
      assert(rows.length === 2 && paths.length === 2, `expected two rows at ${width}`);
      assert(rows[1].offsetHeight === rows[0].offsetHeight,
        `a path too long for the rail must give way, not stack a character per line, at ${width}:`
        + ` short row ${rows[0].offsetHeight}, long row ${rows[1].offsetHeight}`);
      assert(paths[1].offsetWidth > rail.offsetWidth * 0.5,
        `a rail is read for its paths, so most of one belongs to them at ${width}:`
        + ` path ${paths[1].offsetWidth} of rail ${rail.offsetWidth}`);
    }
    // The directory is what gives way. The name is the part that identifies the
    // row, so it is the last thing that may be cut.
    const name = /** @type {HTMLElement} */ (m.body.querySelectorAll('.review-panel__name')[1]);
    assert(name && name.scrollWidth <= name.offsetWidth,
      `the file's own name must stay whole: ${name?.scrollWidth} of ${name?.offsetWidth}`);
    m.teardown();
  });

  // --- against the real service ---------------------------------------------

  await test('the real service hands the pin the shape it expects', async () => {
    const review = await gitReviewService.review();
    assert(review !== null, 'the server should answer a review request');
    assert(typeof review.root === 'string' && Array.isArray(review.repos),
      `expected {root, repos}, got ${JSON.stringify(review)}`);
    assert(typeof review.complete === 'boolean' && Array.isArray(review.warnings),
      `completeness must be stated, not implied: ${JSON.stringify(review)}`);
    for (const found of review.repos) {
      assert(typeof found.path === 'string', `repo.path missing: ${JSON.stringify(found)}`);
      assert(typeof found.branch === 'string' && typeof found.head === 'string',
        `HEAD state missing: ${JSON.stringify(found)}`);
      assert(typeof found.complete === 'boolean', `repo completeness missing: ${JSON.stringify(found)}`);
      assert(Array.isArray(found.files), `files missing: ${JSON.stringify(found)}`);
      for (const file of found.files) {
        assert(typeof file.path === 'string' && typeof file.index === 'string'
          && typeof file.worktree === 'string', `file shape wrong: ${JSON.stringify(file)}`);
      }
    }
  });

  return { passed, failed, errors };
}
