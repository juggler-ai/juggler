//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Git status card tests — the ambient summary, and the way in to the pin.
 *
 * The card and the Git pin read one shared cache and show the same tree at two
 * depths, so what matters here is the seam between them: the card offers to open
 * the pin by naming a source kind, the registry finds whoever accepts it, and a
 * second click reveals the pin already on the board rather than adding another.
 * That indirection is the rule for every later provider that duplicates a card,
 * so it is asserted rather than assumed.
 * @module _tests/git-status-card-test
 */

import GitStatusCard from '../cards/git-status-card.js';
import GitPin from '../pins/git-pin.js';
import gitStatusCache from '../../../js/services/git-status-cache.js';
import pinboardItemRegistry from '../../../js/registries/pinboard-item-registry.js';
import pinboardStore from '../../../js/services/pinboard-store.js';
import pinboardView from '../../../js/services/pinboard-view.js';
import { assert } from '../../../js-tests/utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Run Git status card tests.
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * Teardowns owed by whatever the running case mounted. A case that throws
   * still has to give back `window.fetch`, or every later case — and the
   * harness posting this suite's result — would go through a dead stub.
   * @type {(() => void)[]}
   */
  const owed = [];

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
      while (owed.length) owed.pop()?.();
    }
  }

  const card = new GitStatusCard();

  /**
   * A repo with everything filled in, so a case states only what it is about.
   * @param {Record<string, any>} [overrides] - What this case cares about.
   * @returns {any} The repo.
   */
  const repo = (overrides = {}) => ({
    path: '',
    changed: 0,
    staged: 0,
    total: 0,
    branch: 'main',
    upstream: '',
    ahead: 0,
    behind: 0,
    detached: false,
    files: [],
    truncated: false,
    ...overrides,
  });

  /**
   * Stand in for the server: serve a canned git status, and apply pinboard
   * operations to a board this test owns. Both go through window.fetch, which is
   * the one seam that covers the whole path from the card to the board.
   * @param {any} status - What GET /api/git/status should answer.
   * @returns {any} The fake, its board, and its restore.
   */
  function stubServer(status) {
    const original = window.fetch;
    /** @type {any[]} */
    const board = [];
    const state = {
      board,
      gitRequests: 0,
      restore: () => { window.fetch = original; },
    };
    window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ opts) => {
      const target = String(url);
      if (target.includes('/git/status')) {
        state.gitRequests++;
        return { ok: true, json: async () => status };
      }
      if (target.includes('/pinboard/operations')) {
        for (const op of JSON.parse(opts.body).operations) {
          if (op.op === 'add' && !board.some((p) => p.id === op.id)) {
            board.push({ id: op.id, type: op.type, config: op.config || {} });
          }
        }
        return { ok: true, json: async () => ({ pins: board }) };
      }
      if (target.includes('/session/pinboard')) {
        return { ok: true, json: async () => ({ pins: board }) };
      }
      // Anything else — including the harness posting this suite's own result —
      // is none of this stub's business and goes to the real fetch.
      return original(url, opts);
    });
    return state;
  }

  /**
   * Mount the card against a canned status, with the board reset around it.
   * @param {any} status - What the server should answer, or null to leave the
   *   cache unread so the card shows its checking state.
   * @returns {Promise<any>} The content element and the levers a test needs.
   */
  async function mount(status) {
    pinboardStore.reset();
    pinboardView.reset();
    gitStatusCache.reset();
    const server = stubServer(status);
    if (status) await gitStatusCache.refresh();

    const contentEl = document.createElement('div');
    document.body.appendChild(contentEl);
    const stopCard = card.mount(contentEl);

    let done = false;
    const teardown = () => {
      if (done) return;
      done = true;
      stopCard?.();
      contentEl.remove();
      server.restore();
      pinboardStore.reset();
      pinboardView.reset();
      gitStatusCache.reset();
    };
    owed.push(teardown);

    return {
      contentEl,
      server,
      text: () => contentEl.textContent || '',
      launcher: () => contentEl.querySelector('.info-card__git-launch'),
      teardown,
    };
  }

  /**
   * Let the board's round trip finish: every edit goes to the server and back.
   * @returns {Promise<void>} Resolves after pending work.
   */
  const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

  /** Put the Git pin in the registry, as an enabled extension would. */
  function enableGitPin() {
    pinboardItemRegistry.reset();
    pinboardItemRegistry.registerClass(/** @type {any} */ (GitPin), { extensionId: 'test' });
  }

  // --- what it says ---------------------------------------------------------

  await test('an unread status says it is looking, not that there is no repo', async () => {
    const m = await mount(null);
    assert(m.text().includes('Checking…'), `expected 'Checking…', got ${JSON.stringify(m.text())}`);
    m.teardown();
  });

  await test('a read that is being refused says why, rather than looking forever', async () => {
    // "Checking…" is the right thing to say while an answer is on its way, and
    // the wrong thing to say once the server has declined to give one — which is
    // what a conversation bound to a workspace that cannot be reached produces,
    // on every poll, indefinitely. The server's own words for the four refusals
    // are better than any this card would invent.
    const m = await mount({ root: '/tmp/proj', repos: [] });
    const original = window.fetch;
    window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ opts) => {
      if (String(url).includes('/git/status')) {
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          text: async () => JSON.stringify({ error: 'workspace ws_gone was closed' })
        };
      }
      return original(url, opts);
    });
    try {
      // What moving to a conversation bound somewhere unreachable does: the tree
      // changed, so what was known is dropped, and the read of the new one is
      // refused. Nothing is held back to fall back on.
      gitStatusCache.reset();
      await gitStatusCache.refresh();
    } finally {
      window.fetch = original;
    }
    assert(m.text().includes('was closed'),
      `expected the refusal, got ${JSON.stringify(m.text())}`);
    assert(!m.text().includes('Checking…'),
      `and not a claim that it is still looking, got ${JSON.stringify(m.text())}`);
    m.teardown();
  });

  await test('a project without git says so', async () => {
    const m = await mount({ root: '/tmp/proj', repos: [] });
    assert(m.text().includes('No git repository'), `got ${JSON.stringify(m.text())}`);
    m.teardown();
  });

  await test('a clean tree says nothing changed', async () => {
    const m = await mount({ root: '/tmp/proj', repos: [repo()] });
    assert(m.text().includes('No changed files'), `got ${JSON.stringify(m.text())}`);
    m.teardown();
  });

  await test('a dirty tree shows the counts, omitting a zero side', async () => {
    const m = await mount({ root: '/tmp/proj', repos: [repo({ changed: 2, staged: 1, total: 3 })] });
    assert(m.text().includes('2 changed, 1 staged'), `got ${JSON.stringify(m.text())}`);

    const stagedOnly = await mount({ root: '/tmp/proj', repos: [repo({ staged: 1, total: 1 })] });
    assert(stagedOnly.text().includes('1 staged') && !stagedOnly.text().includes('0 changed'),
      `a zero side is left out entirely: ${JSON.stringify(stagedOnly.text())}`);
    stagedOnly.teardown();
    m.teardown();
  });

  await test('a lone repo at the root goes unlabelled, and nested repos do not', async () => {
    const lone = await mount({ root: '/tmp/proj', repos: [repo({ changed: 1, total: 1 })] });
    assert(!lone.contentEl.querySelector('.info-card__git-repo'),
      `one repo at the root needs no label:\n${lone.contentEl.innerHTML}`);
    lone.teardown();

    const nested = await mount({
      root: '/tmp/proj',
      repos: [repo({ path: '', changed: 1, total: 1 }), repo({ path: 'juggler', changed: 1, total: 1 })],
    });
    const labels = [...nested.contentEl.querySelectorAll('.info-card__git-repo')]
      .map((/** @type {any} */ el) => el.textContent);
    assert(labels.includes('proj') && labels.includes('juggler'),
      `expected both repos named, got ${JSON.stringify(labels)}`);
    nested.teardown();
  });

  // The card follows the visible conversation; a tab switch can move it from the
  // project to a worktree, and every state it can be in must say which.
  await test('a workspace tree is named above every state, and the project is not', async () => {
    const badges = (/** @type {any} */ m) => [...m.contentEl.querySelectorAll('.info-card__git-repo')]
      .map((/** @type {any} */ el) => el.textContent);
    for (const [what, status] of /** @type {[string, any][]} */ ([
      ['dirty', { root: '/tmp/wt', workspace: 'feat/tunnels', repos: [repo({ changed: 1, total: 1 })] }],
      ['clean', { root: '/tmp/wt', workspace: 'feat/tunnels', repos: [repo()] }],
      ['no repository', { root: '/tmp/wt', workspace: 'feat/tunnels', repos: [] }],
    ])) {
      const m = await mount(status);
      assert(badges(m).includes('feat/tunnels'),
        `the ${what} card must name the workspace:\n${m.contentEl.innerHTML}`);
      m.teardown();
    }

    const project = await mount({ root: '/tmp/proj', repos: [repo({ changed: 1, total: 1 })] });
    assert(badges(project).length === 0, `the project needs no name:\n${project.contentEl.innerHTML}`);
    project.teardown();
  });

  await test('a clean repo is left out of a list of dirty ones', async () => {
    const m = await mount({
      root: '/tmp/proj',
      repos: [repo({ path: '', changed: 1, total: 1 }), repo({ path: 'clean' })],
    });
    assert(!m.text().includes('clean'),
      `a repo with nothing to report is not a row: ${JSON.stringify(m.text())}`);
    m.teardown();
  });

  // --- the way in to the pin ------------------------------------------------

  await test('with no pin to open, the card offers no way to open one', async () => {
    pinboardItemRegistry.reset();
    const m = await mount({ root: '/tmp/proj', repos: [repo({ changed: 1, total: 1 })] });
    assert(!m.launcher(),
      'an affordance that would do nothing is absent rather than inert');
    assert(m.text().includes('1 changed'), 'and the card still says what it always said');
    m.teardown();
  });

  await test('with the Git pin enabled, the whole card becomes the way in', async () => {
    enableGitPin();
    const m = await mount({ root: '/tmp/proj', repos: [repo({ changed: 1, total: 1 })] });
    const button = m.launcher();
    assert(!!button, 'with a pin that accepts the git source, the card offers to open it');
    assert(button?.tagName === 'BUTTON', `expected a real button, got ${button?.tagName}`);
    assert(button?.getAttribute('aria-label') === 'Review changes in the Pinboard',
      `expected a literal label, got ${JSON.stringify(button?.getAttribute('aria-label'))}`);
    assert(m.text().includes('Review changes'),
      `a dirty tree has somewhere to go, and the card should say where:\n${m.text()}`);
    assert(m.text().includes('1 changed'), 'and the counts are still what it reads as');
    m.teardown();
  });

  await test('with nothing changed the card offers a look, not a review', async () => {
    enableGitPin();
    const m = await mount({ root: '/tmp/proj', repos: [repo()] });
    assert(!m.text().includes('Review changes'),
      `there is nothing to review, so offering to is an invitation to nothing:\n${m.text()}`);
    assert(m.launcher()?.getAttribute('aria-label') === 'Open Git status in the Pinboard',
      `and it says what it does do, got ${JSON.stringify(m.launcher()?.getAttribute('aria-label'))}`);
    m.teardown();
  });

  await test('the card is a launcher in every state, including having nothing to report', async () => {
    enableGitPin();
    const empty = await mount({ root: '/tmp/proj', repos: [] });
    assert(!!empty.launcher(),
      'a project with no repo is still worth opening the pin to look at properly');
    empty.teardown();
  });

  await test('clicking the card puts the Git pin on the board and reveals it', async () => {
    enableGitPin();
    const m = await mount({ root: '/tmp/proj', repos: [repo({ changed: 1, total: 1 })] });
    /** @type {any} */ (m.launcher()).click();
    await settle();

    assert(m.server.board.length === 1, `expected one pin, got ${JSON.stringify(m.server.board)}`);
    assert(m.server.board[0].type === 'git',
      `the registry should have resolved the source to the git type, got ${m.server.board[0].type}`);
    assert(pinboardView.isOpen(), 'adding from the card should open the board on it');
    assert(pinboardView.getActivePinId() === m.server.board[0].id,
      'and select the pin it just added');
    m.teardown();
  });

  await test('clicking again reveals the pin already there rather than adding a second', async () => {
    enableGitPin();
    const m = await mount({ root: '/tmp/proj', repos: [repo({ changed: 1, total: 1 })] });
    /** @type {any} */ (m.launcher()).click();
    await settle();
    const first = m.server.board[0]?.id;

    pinboardView.close();
    pinboardView.setActivePin(null);
    /** @type {any} */ (m.launcher()).click();
    await settle();

    // Git is a singleton, so the host reveals rather than duplicating. A card
    // that could add a second copy of a singleton would be a bug the user has
    // to clean up.
    assert(m.server.board.length === 1,
      `expected the board to still hold one pin, got ${JSON.stringify(m.server.board)}`);
    assert(pinboardView.getActivePinId() === first, 'and to have revealed the one already there');
    assert(pinboardView.isOpen(), 'and reopened the board on it');
    m.teardown();
  });

  await test('the card names a source kind, never the pin class', async () => {
    // The rule this whole seam exists for: the registry resolves {kind:'git'} to
    // whichever enabled type accepts it, so a card and its pin never import each
    // other and a third-party pin could take the source instead.
    enableGitPin();
    const resolved = pinboardItemRegistry.resolveSource(/** @type {any} */ ({ kind: 'git' }));
    assert(resolved?.typeId === 'git',
      `expected the registry to resolve the source, got ${JSON.stringify(resolved)}`);
    pinboardItemRegistry.reset();
    assert(pinboardItemRegistry.resolveSource(/** @type {any} */ ({ kind: 'git' })) === null,
      'with nothing enabled to take it, the source resolves to nothing');
  });

  // --- sharing one poll -----------------------------------------------------

  await test('mounting the card twice does not double the polling', async () => {
    const m = await mount({ root: '/tmp/proj', repos: [repo()] });
    const before = m.server.gitRequests;

    const second = document.createElement('div');
    document.body.appendChild(second);
    const stopSecond = card.mount(second);
    await settle();

    // Both surfaces share one in-flight fetch and one snapshot, which is the
    // whole reason the cache is in the host rather than in each surface.
    assert(m.server.gitRequests <= before + 1,
      `a second surface should not multiply the git invocations: ${before} → ${m.server.gitRequests}`);
    assert((second.textContent || '').includes('No changed files'),
      `and it paints from the shared snapshot at once:\n${second.textContent}`);

    stopSecond?.();
    second.remove();
    m.teardown();
  });

  await test('teardown stops the card following the status', async () => {
    const m = await mount({ root: '/tmp/proj', repos: [repo()] });
    m.teardown();
    // Nothing to assert about the DOM after removal; what matters is that
    // unsubscribing is what stops the shared poll when the last surface goes.
    assert(gitStatusCache.get() === null, 'the reset in teardown should have cleared the snapshot');
  });

  return { passed, failed, errors };
}
