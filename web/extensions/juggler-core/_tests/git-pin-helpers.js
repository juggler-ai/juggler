//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * What the git pin suites share: canned repositories, manifests and patches,
 * and a mount against a hand-built PinContext whose `git` and `review`
 * services a case drives, so it can state a tree and a draft exactly rather
 * than arranging for git to be in that state.
 * @module _tests/git-pin-helpers
 */

/** @typedef {import('../pins/git-pin.js').default} GitPin */

/** @returns {Promise<void>} Resolved once the pending promise chains have run. */
export const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/**
 * A repo with everything filled in, so a case overrides only what it is about.
 * @param {Partial<import('juggler/pinboard-item-type').PinGitReviewRepo>} [overrides] - What this case cares about.
 * @returns {any} The repo.
 */
export const repo = (overrides = {}) => ({
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
export const manifestOf = (files, overrides = {}) => ({
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
export const patchOf = (path, overrides = {}) => ({
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
 * @param {GitPin} pin - The pin type to mount.
 * @param {object} [options] - What this case needs.
 * @param {any} [options.manifest] - What `git.review()` answers with.
 * @param {any} [options.reviewError] - What `git.review()` fails with from the
 *   outset, for a read that never succeeded once.
 * @param {any} [options.draft] - What `review.draft()` answers with; null for
 *   a board with no conversation to keep comments on.
 * @param {(repo: string, path: string) => any} [options.patch] - What
 *   `git.diff()` answers with, per file.
 * @param {Record<string, any>} [options.config] - The pin's config.
 * @returns {any} The body, controller and the levers a test needs.
 */
export function mountPin(pin, options = {}) {
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
  /** @type {any[]} */
  const reviewOptions = [];
  /** @type {any[]} */
  const configs = [];
  /** @type {{repo: string, path: string, options?: any}[]} */
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
      review: async (/** @type {any} */ opts) => {
        reviews++;
        reviewOptions.push(opts || {});
        if (reviewFailure) throw reviewFailure;
        return manifest;
      },
      /**
       * @param {string} repoPath - The repository.
       * @param {string} filePath - The file within it.
       * @param {any} [opts] - What else was asked.
       * @returns {Promise<any>} Its patch.
       */
      diff: (repoPath, filePath, opts) => {
        diffs.push({ repo: repoPath, path: filePath, options: opts });
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
    pin: { id: 'pin_test', type: 'git', config: options.config || {} },
    active: {
      project: { path: '/tmp/proj', displayName: 'proj' },
      conversation: draft === null ? null : { id: 'c1', title: 'Conv' },
      thread: { id: null },
    },
    services,
    signal: abort.signal,
    updateConfig: async (/** @type {any} */ next) => { configs.push(next); },
  })));

  return {
    body,
    controller,
    services,
    text: () => body.textContent || '',
    reviews: () => reviews,
    reviewOptions: () => reviewOptions,
    configs: () => configs,
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
 * @param {GitPin} pin - The pin type to mount.
 * @param {object} [options] - Passed to `mountPin`.
 * @returns {Promise<any>} The mounted pin.
 */
export async function mountedPin(pin, options = {}) {
  const m = mountPin(pin, options);
  await settle();
  await settle();
  return m;
}
