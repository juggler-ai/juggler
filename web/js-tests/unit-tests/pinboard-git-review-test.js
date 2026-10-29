//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What a pin gets when it asks for a review: `services.git.review()` and
 * `services.git.diff()`, end to end from the pin's hand to the HTTP request.
 *
 * The ambient card and the explicit review are two different questions asked of
 * the same repository, and this suite exists to keep them apart. The card is
 * polled, bounded and best-effort; a review is asked for, says what it could not
 * reach, and is never smoothed over into a claim the server did not make. So the
 * cases that matter are the ones where an answer must be refused rather than
 * shown: a caller that cancelled, a pin that has gone away, a project that
 * changed while the answer was in flight.
 *
 * Driven through a probe item type registered only here, the same way
 * `unit:pinboard-tasks` does, because the thing under test is the context a pin
 * is handed and not any of the pieces behind it.
 * @module unit-tests/pinboard-git-review-test
 */

import { initializeRegistries, assert, waitFor, nextTask } from '../utilities/test-helpers.js';
import { isolateFocus } from '../utilities/isolate-focus.js';
import pinboardItemRegistry from '../../js/registries/pinboard-item-registry.js';
import PinboardItemType from 'juggler/pinboard-item-type';
import gitStatusCache from '../../js/services/git-status-cache.js';
import gitReviewService from '../../js/services/git-review-service.js';
import '../../js/components/pinboard-content.js';
import { createReviewPanel } from '../../js/components/review-panel.js';

/** The context the probe was mounted with. */
const probe = { context: /** @type {any} */ (null) };

/** A pin type whose whole purpose is to hand back the context it was given. */
class GitProbePin extends PinboardItemType {
  static MANIFEST = {
    id: 'git-review-probe',
    name: 'Git review probe',
    version: '1.0.0',
    description: 'A pin that exists only in this test',
    instances: 'multiple',
  };

  /**
   * @param {HTMLElement} container - The body region to fill.
   * @param {any} pinContext - The pin, the active snapshot and the host services.
   * @returns {{teardown: () => void}} The controller.
   */
  mount(container, pinContext) {
    probe.context = pinContext;
    container.textContent = 'git review probe';
    return { teardown: () => {} };
  }
}

/** The project this fixture pretends to be in. */
const PROJECT = '/tmp/pinboard-git-review';

/** One repository's worth of ambient status, as the card reads it. */
const STATUS = {
  root: PROJECT,
  repos: [{
    path: '', changed: 2, staged: 1, conflicted: 0, total: 2, added: 12, removed: 3,
    branch: 'develop', upstream: 'origin/develop', head: 'a'.repeat(40), initial: false,
    ahead: 0, behind: 0, stashes: 0, detached: false, truncated: false,
    files: [{ path: 'README.md', index: 'M', worktree: '.', added: 4, removed: 1 }],
  }],
};

/**
 * The manifest the review endpoint answers with: a root repository whose files
 * are listed, and a nested one git could not read — which is listed anyway,
 * because "I could not read this" and "there is nothing here" are different
 * things and only one of them is true.
 * @returns {any} A fresh copy, so a case that mutates one cannot reach the next.
 */
const manifest = () => ({
  root: PROJECT,
  complete: true,
  warnings: [],
  repos: [
    {
      path: '', changed: 2, staged: 1, conflicted: 0, total: 2, added: 12, removed: 3,
      branch: 'develop', upstream: 'origin/develop', head: 'a'.repeat(40), initial: false,
      ahead: 0, behind: 0, stashes: 0, detached: false, truncated: false, complete: true,
      files: [
        { path: 'README.md', index: 'M', worktree: '.', added: 4, removed: 1 },
        { path: 'web/js/app.js', index: '.', worktree: 'M', added: 8, removed: 2 },
      ],
    },
    {
      path: 'vendor/tool', changed: 0, staged: 0, conflicted: 0, total: 0, added: 0, removed: 0,
      branch: '', upstream: '', head: '', initial: false, ahead: 0, behind: 0, stashes: 0,
      detached: false, truncated: false, complete: false,
      error: 'not a git repository', files: [],
    },
  ],
});

/**
 * One file's patch, as the diff endpoint answers.
 * @returns {any} A fresh copy.
 */
const patch = () => ({
  repo: '', path: 'README.md', status: 'modified',
  binary: false, truncated: false, added: 1, removed: 1,
  revision: 'sha256:9f1c',
  hunks: [{
    oldStart: 3, oldLines: 3, newStart: 3, newLines: 3, heading: '',
    lines: [
      { kind: 'context', oldLine: 3, newLine: 3, text: 'A line that stayed' },
      { kind: 'remove', oldLine: 4, text: 'A line that went' },
      { kind: 'add', newLine: 4, text: 'A line that arrived' },
    ],
  }],
});

/**
 * What a promise did, without the throwing: a settled promise's outcome as data,
 * so a case can assert on a rejection it expected without wrapping every line.
 * @param {Promise<any>} promise - The promise to watch.
 * @returns {{done: boolean, value: any, error: any}} Filled in as it settles.
 */
function watch(promise) {
  /** @type {{done: boolean, value: any, error: any}} */
  const state = { done: false, value: null, error: null };
  promise.then(
    (value) => { state.value = value; state.done = true; },
    (error) => { state.error = error; state.done = true; }
  );
  return state;
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1200px;height:800px;';
  document.body.appendChild(container);

  // A lane reuses one JS realm across suites, so start from a known registry and
  // hand back one with no probe types in it.
  pinboardItemRegistry.reset();
  pinboardItemRegistry.registerClass(GitProbePin, { extensionId: 'test' });
  probe.context = null;
  gitStatusCache.reset();
  gitReviewService.reset();

  // --- the fake server ------------------------------------------------------

  /** Every review request seen, whether it was answered or not. */
  const reviews = [];
  /** Every diff request seen, as its query named it. */
  const diffs = [];
  /** Requests the transport actually cancelled, by endpoint. */
  const cancelled = [];
  /** What `/api/git/review` answers with next. */
  let reviewBody = manifest();
  /** When set, the next review fails with this instead of answering. */
  let reviewFailure = '';
  /** While set, requests wait for it — so a case can act while one is in flight. */
  /** @type {{promise: Promise<void>, release: () => void}|null} */
  let gate = null;

  /** @returns {{promise: Promise<void>, release: () => void}} A gate to hold the next request open with. */
  function openGate() {
    /** @type {() => void} */
    let release = () => {};
    const promise = new Promise((resolve) => { release = () => resolve(); });
    gate = { promise, release };
    return gate;
  }

  /**
   * Hold a request until the gate is released — and, like the real transport,
   * reject it if the caller cancels while it waits. A stub that ignored the
   * signal would let a cancelled request answer, which is exactly the bug the
   * cancellation cases are here to catch.
   * @param {string} endpoint - Which endpoint is waiting, for the record.
   * @param {AbortSignal|undefined} signal - The request's signal, if it has one.
   * @returns {Promise<void>} Resolves when the gate opens.
   */
  async function held(endpoint, signal) {
    if (!gate) return;
    const waiting = gate.promise;
    await new Promise((resolve, reject) => {
      const onAbort = () => {
        cancelled.push(endpoint);
        reject(new DOMException('The user aborted a request.', 'AbortError'));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      waiting.then(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve(undefined);
      });
    });
  }

  const originalFetch = window.fetch;
  /**
   * Answer the three git endpoints, and — the part that matters — hand every
   * other URL to the real fetch. A stub that answers everything swallows the
   * harness's own result POST, and the suite then hangs for a minute looking
   * exactly like a dead pool.
   * @param {any} input - The request URL or Request.
   * @param {any} [init] - The request options.
   * @returns {Promise<any>} The response.
   */
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!url.includes('/api/git/')) return originalFetch(input, init);
    const signal = /** @type {AbortSignal|undefined} */ (init?.signal);

    if (url.includes('/api/git/status')) {
      return new window.Response(JSON.stringify(STATUS), { status: 200 });
    }
    if (url.includes('/api/git/review')) {
      reviews.push(url);
      await held('review', signal);
      if (reviewFailure) {
        return new window.Response(JSON.stringify({ error: reviewFailure }), { status: 502 });
      }
      return new window.Response(JSON.stringify(reviewBody), { status: 200 });
    }
    if (url.includes('/api/git/diff')) {
      const query = new URLSearchParams(url.split('?')[1] || '');
      diffs.push({ repo: query.get('repo'), path: query.get('path') });
      await held('diff', signal);
      return new window.Response(JSON.stringify(patch()), { status: 200 });
    }
    return originalFetch(input, init);
  };

  /** @type {any} */
  let content = null;

  /**
   * The active-context snapshot the panel hands the content band. No
   * conversation: a review is a property of the project, which is what lets a
   * board read one in a window that has no conversation in it at all.
   * @returns {any} The snapshot.
   */
  const activeContext = () => ({
    project: { path: PROJECT, displayName: 'pinboard-git-review' },
    conversation: null,
    thread: { id: null },
  });

  /**
   * The service under test, as a pin receives it.
   * @returns {any} `services.git`.
   */
  const service = () => probe.context.services.git;

  try {
    content = /** @type {any} */ (document.createElement('pinboard-content'));
    container.appendChild(content);
    content.setPin({ id: 'pin_probe', type: 'git-review-probe', config: {} }, activeContext());
    await waitFor(() => probe.context, 'the probe pin never mounted');

    // --- the manifest ---------------------------------------------------------

    await run('a review comes back as the manifest the server sent', async () => {
      const review = await service().review();
      assert(review.root === PROJECT, `expected the project root, got ${JSON.stringify(review.root)}`);
      assert(review.complete === true, 'the server said the review was complete');
      assert(Array.isArray(review.warnings) && review.warnings.length === 0,
        `expected no warnings, got ${JSON.stringify(review.warnings)}`);
      assert(review.repos.length === 2, `expected both repositories, got ${review.repos.length}`);
      const root = review.repos[0];
      assert(root.path === '', `the root repository is named by '', got ${JSON.stringify(root.path)}`);
      assert(root.branch === 'develop', `expected the branch carried, got ${JSON.stringify(root.branch)}`);
      assert(root.files.length === 2, `expected both files, got ${JSON.stringify(root.files)}`);
      assert(root.files[1].path === 'web/js/app.js', 'the file list is the manifest\'s own order');
    });

    await run('a repository git could not read arrives with its reason', async () => {
      const review = await service().review();
      const nested = review.repos.find((/** @type {any} */ r) => r.path === 'vendor/tool');
      assert(!!nested, 'a repository that could not be read is still a repository under review');
      assert(nested.complete === false, 'it cannot claim to be complete');
      assert(nested.error === 'not a git repository',
        `git's own complaint must survive the trip, got ${JSON.stringify(nested.error)}`);
    });

    await run('an incomplete review keeps its warnings', async () => {
      reviewBody = manifest();
      reviewBody.complete = false;
      reviewBody.warnings = ['the project repository: 5000 of 9000 changed files listed'];
      const review = await service().review();
      assert(review.complete === false, 'a review that says it is partial must stay partial');
      assert(review.warnings.length === 1 && review.warnings[0].includes('5000 of 9000'),
        `the warning is what makes the gap legible: ${JSON.stringify(review.warnings)}`);
      reviewBody = manifest();
    });

    await run('a body that never said it was complete is not treated as complete', async () => {
      reviewBody = { root: PROJECT, repos: [] };
      const review = await service().review();
      assert(review.complete === false,
        'completeness is a claim the server makes; silence is not it');
      assert(Array.isArray(review.warnings), 'warnings is always an array, so nothing has to guard it');
      assert(Array.isArray(review.repos), 'and so is repos');
      reviewBody = manifest();
    });

    // --- one question, however many askers ------------------------------------

    await run('two callers at once cost one review', async () => {
      const open = openGate();
      const before = reviews.length;
      const first = service().review();
      const second = service().review();
      await waitFor(() => reviews.length > before, 'the review was never requested');
      // The second caller has no event of its own to wait for. Three task hops
      // let it reach the service, so a second request would be counted.
      for (let i = 0; i < 3; i++) await nextTask();
      open.release();
      gate = null;
      const [a, b] = await Promise.all([first, second]);
      assert(reviews.length === before + 1,
        `two surfaces asking at the same moment must run git once, got ${reviews.length - before} requests`);
      assert(a.repos.length === b.repos.length, 'both callers get the same answer');
    });

    await run('one caller cancelling does not cancel the review the other is waiting for', async () => {
      const open = openGate();
      const before = cancelled.length;
      const asked = reviews.length;
      const abort = new AbortController();
      const cancelledCall = watch(service().review({ signal: abort.signal }));
      const kept = watch(service().review());
      // Counted from where this case started, not from zero: every case before
      // this one left requests behind, and a wait that is already satisfied is a
      // wait that cancels the request before it was ever made.
      await waitFor(() => reviews.length > asked, 'the review was never requested');
      abort.abort();
      await waitFor(() => cancelledCall.done, 'the cancelled caller never settled');
      assert(cancelledCall.done && cancelledCall.error?.name === 'AbortError',
        `the caller that cancelled gets its cancellation, got ${JSON.stringify(cancelledCall.error?.name)}`);
      assert(!kept.done, 'the other caller is still waiting for the answer it asked for');
      open.release();
      gate = null;
      await waitFor(() => kept.done, 'the surviving caller never got its review');
      assert(kept.value?.repos?.length === 2, 'and it is the whole answer');
      assert(cancelled.length === before, 'the shared request must not be cancelled out from under it');
    });

    // --- an answer that must be refused ---------------------------------------

    await run('a pin that has gone away stops waiting for its review', async () => {
      const open = openGate();
      const asked = reviews.length;
      const pending = watch(service().review());
      await waitFor(() => reviews.length > asked, 'the review was never requested');
      // Replacing the pin aborts the mount's signal, which is what a pin that
      // forgot to pass one of its own relies on.
      content.setPin({ id: 'pin_second', type: 'git-review-probe', config: {} }, activeContext());
      await waitFor(() => probe.context.pin.id === 'pin_second', 'the second pin never mounted');
      await waitFor(() => pending.done, 'the abandoned review never settled');
      assert(pending.done && pending.error?.name === 'AbortError',
        `a review nobody is left to read is cancelled, got ${JSON.stringify(pending.error?.name)}`);
      open.release();
      gate = null;
      // Let the released request and its abort listeners drain before the next case.
      for (let i = 0; i < 3; i++) await nextTask();
    });

    await run('a review that outlived the tree it was about is refused rather than shown', async () => {
      const open = openGate();
      const asked = reviews.length;
      const pending = watch(service().review());
      await waitFor(() => reviews.length > asked, 'the review was never requested');
      // Called directly rather than provoked with the `project-changed`
      // broadcast that is one of its causes: that event is also handled by
      // session.js, which answers it with `window.location.reload()`, and firing
      // it here would take the lane's whole realm down with it. The other cause
      // is the user moving to a conversation bound somewhere else, which resets
      // this the same way and for the same reason.
      gitReviewService.reset();
      open.release();
      gate = null;
      await waitFor(() => pending.done, 'the review never settled');
      assert(pending.value === null,
        `another tree's manifest must not be handed over: ${JSON.stringify(pending.value)}`);
      assert(String(pending.error?.message || '').toLowerCase().includes('tree'),
        `and the caller is told why, got ${JSON.stringify(pending.error?.message)}`);
    });

    await run('a failed review leaves the card saying what it last knew', async () => {
      await service().refresh();
      await waitFor(() => service().status(), 'the ambient status never arrived');
      reviewFailure = 'git is not installed';
      let failure = null;
      try {
        await service().review();
      } catch (err) {
        failure = err;
      }
      reviewFailure = '';
      assert(failure, 'a review that failed must say so rather than resolving with nothing');
      assert(String(failure.message || '').includes('git is not installed'),
        `the underlying text is never dropped, got ${JSON.stringify(String(failure.message))}`);
      assert(service().status()?.repos?.length === 1,
        'the card is a separate read and keeps what it last knew');
      assert(service().error() === '',
        `a review failing is not the card failing, got ${JSON.stringify(service().error())}`);
    });

    // --- one file at a time ---------------------------------------------------

    await run('a diff names the repository and the file it is for', async () => {
      const before = diffs.length;
      await service().diff('vendor/tool', 'src/a b.txt');
      assert(diffs.length === before + 1, 'the patch is asked for, not assembled from the manifest');
      const asked = diffs[diffs.length - 1];
      assert(asked.repo === 'vendor/tool', `expected the repository named, got ${JSON.stringify(asked.repo)}`);
      assert(asked.path === 'src/a b.txt', `expected the file named, got ${JSON.stringify(asked.path)}`);
    });

    await run('a patch arrives with its hunks intact', async () => {
      const diff = await service().diff('', 'README.md');
      assert(diff.status === 'modified', `expected the status, got ${JSON.stringify(diff.status)}`);
      assert(diff.revision === 'sha256:9f1c', 'the fingerprint a comment is anchored to must survive');
      assert(diff.hunks.length === 1, `expected one hunk, got ${diff.hunks.length}`);
      const kinds = diff.hunks[0].lines.map((/** @type {any} */ line) => line.kind);
      assert(JSON.stringify(kinds) === JSON.stringify(['context', 'remove', 'add']),
        `expected the lines in order, got ${JSON.stringify(kinds)}`);
    });

    await run('cancelling a file selection cancels the request itself', async () => {
      const open = openGate();
      const before = cancelled.length;
      const asked = diffs.length;
      const abort = new AbortController();
      const pending = watch(service().diff('', 'README.md', { signal: abort.signal }));
      await waitFor(() => diffs.length > asked, 'the diff was never requested');
      abort.abort();
      await waitFor(() => pending.done, 'the cancelled diff never settled');
      assert(pending.error?.name === 'AbortError',
        `expected the cancellation, got ${JSON.stringify(pending.error?.name)}`);
      assert(cancelled.length === before + 1,
        'a patch is one surface\'s request, so cancelling it must reach the server');
      open.release();
      gate = null;
      // Let the released request and its abort listeners drain before the next case.
      for (let i = 0; i < 3; i++) await nextTask();
    });

    await run('a diff left running by a pin that has gone is cancelled with it', async () => {
      const open = openGate();
      const before = cancelled.length;
      const asked = diffs.length;
      const pending = watch(service().diff('', 'README.md'));
      await waitFor(() => diffs.length > asked, 'the diff was never requested');
      content.setPin({ id: 'pin_third', type: 'git-review-probe', config: {} }, activeContext());
      await waitFor(() => probe.context.pin.id === 'pin_third', 'the third pin never mounted');
      await waitFor(() => pending.done, 'the abandoned diff never settled');
      assert(pending.error?.name === 'AbortError',
        `expected the cancellation, got ${JSON.stringify(pending.error?.name)}`);
      assert(cancelled.length === before + 1, 'and the request goes with the pin');
      open.release();
      gate = null;
      // Let the released request and its abort listeners drain before the next case.
      for (let i = 0; i < 3; i++) await nextTask();
    });

    await run('a patch that outlived the tree it was about is refused rather than shown', async () => {
      const open = openGate();
      const asked = diffs.length;
      const pending = watch(service().diff('', 'README.md'));
      await waitFor(() => diffs.length > asked, 'the diff was never requested');
      gitReviewService.reset();
      open.release();
      gate = null;
      await waitFor(() => pending.done, 'the diff never settled');
      assert(pending.value === null,
        `another tree's patch must not be handed over: ${JSON.stringify(pending.value)}`);
      assert(String(pending.error?.message || '').toLowerCase().includes('tree'),
        `and the caller is told why, got ${JSON.stringify(pending.error?.message)}`);
    });

    // --- where the board is ----------------------------------------------------

    await run('a board with no conversation still reviews the project', async () => {
      assert(probe.context.active.conversation === null,
        'this whole suite runs without one, which is what makes the next line mean anything');
      const review = await service().review();
      assert(review.repos.length === 2,
        'a review is a property of the project, so a detached board asks the server itself');
    });

    // --- taking focus ----------------------------------------------------------

    await run('taking focus moves the rail and nothing above it', async () => {
      // The panel is the body of a pin, and the board holding it is parked off
      // the right edge of the workspace by a transform until it has slid in. A
      // plain focus() there makes the browser scroll every ancestor to reveal
      // it — and `.app-main` is `overflow: hidden`, which is a scroll box with
      // the scrollbar taken away. The columns lurch left, the sliding panel
      // overshoots with them, and it springs back when the transform settles.
      // So focus must scroll the rail it landed in, and nothing outside it.
      const workspace = document.createElement('div');
      workspace.style.cssText = 'position:relative;width:600px;height:400px;overflow:hidden';
      const parked = document.createElement('div');
      parked.style.cssText =
        'position:absolute;top:0;right:0;width:500px;height:100%;transform:translateX(100%)';
      workspace.appendChild(parked);
      container.appendChild(workspace);

      const panel = createReviewPanel({
        scopeLabel: 'working tree',
        loadPatch: async () => ({ hunks: [] }),
        review: { draft: () => null },
      });
      parked.appendChild(panel.element);
      // Enough files that the last one is well below the fold of a rail that
      // has to scroll to show it.
      panel.setManifest({
        complete: true,
        warnings: [],
        groups: [{
          key: '',
          files: Array.from({ length: 60 }, (_, i) => ({ repo: '', path: `src/file-${i}.js` })),
        }],
      });

      try {
        const rows = panel.element.querySelectorAll('.review-panel__file');
        assert(rows.length === 60, `the rail must hold every file, got ${rows.length}`);
        const rail = /** @type {HTMLElement} */ (panel.element.querySelector('.review-panel__rail'));
        const active = /** @type {HTMLElement} */ (
          panel.element.querySelector('.review-panel__file[aria-current="true"]'));
        assert(active === rows[0], 'the first file is the one a fresh manifest lands on');
        assert(rail.scrollHeight > rail.clientHeight,
          'the rail must overflow, or there is no scrolling here to get wrong');

        // Send the rail past the active row, so revealing it is a scroll that
        // has to happen.
        rail.scrollTop = rail.scrollHeight;
        // What focus() was asked for, rather than what the browser did with it:
        // this page never paints, so WebKit never runs the rendering update its
        // scroll-into-view happens in, and every assertion about where the
        // workspace ended up passes here whether the bug is present or not.
        // The request is the part this code controls, so the request is what is
        // checked.
        const focus = isolateFocus();
        try {
          panel.focus();
        } finally {
          focus.restore();
        }
        const asked = focus.requests.map((r) => r.options);

        assert(asked.length === 1, `focus went to one place, got ${asked.length}`);
        assert(asked[0]?.preventScroll === true,
          'focus must not be what scrolls the workspace: the board is still off its right edge');
        // And because it asked for that, revealing the row is now this panel's
        // job. Scrolling the rail is our own code, so it has happened by now.
        const railBox = rail.getBoundingClientRect();
        const rowBox = active.getBoundingClientRect();
        assert(rowBox.top >= railBox.top - 1 && rowBox.bottom <= railBox.bottom + 1,
          'the rail must scroll to the row focus went to, or focus is somewhere nobody can see'
          + ` — rail scrollTop ${rail.scrollTop} of ${rail.scrollHeight}/${rail.clientHeight},`
          + ` rail ${railBox.top}..${railBox.bottom}, row ${rowBox.top}..${rowBox.bottom}`);
      } finally {
        panel.destroy();
        workspace.remove();
      }
    });
  } finally {
    // Drain every stub in a finally, so a case that throws cannot strand one for
    // every later suite in this realm.
    gate?.release();
    gate = null;
    window.fetch = originalFetch;
    content?.remove();
    container.remove();
    pinboardItemRegistry.reset();
    gitStatusCache.reset();
    gitReviewService.reset();
    probe.context = null;
  }

  return { passed, failed, errors };
}
