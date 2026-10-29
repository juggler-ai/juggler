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
import { setGitWorkspace } from '../../../js/services/git-workspace.js';
import pinboardItemRegistry from '../../../js/registries/pinboard-item-registry.js';
import pinboardStore from '../../../js/services/pinboard-store.js';
import pinboardView from '../../../js/services/pinboard-view.js';
import { assert, nextTask } from '../../../js-tests/utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';

/** juggler-core's English for this card, standing in for its catalogue. */
const CORE_TEXT = [
  'Checking…', 'No git repository', 'No changed files', 'Workspace: {workspace}',
  'Review changes in the Pinboard', 'Open Git status in the Pinboard',
  'Review changes', 'Open in the Pinboard', 'Review changes →',
  '{count} changed', '{count} staged', '{changed} changed, {staged} staged', 'repo',
];

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
      // Nothing known, and the read refused: nothing is held back to fall back
      // on. (A tab switch reaching the same state is the case further down.)
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

  /**
   * Hold the next status read until the test lets it go, answering `answer` —
   * or refusing, when `answer` is an Error.
   * @param {any} answer - What the read should resolve to.
   * @returns {{release: () => void, restore: () => void}} The levers.
   */
  function holdStatus(answer) {
    const original = window.fetch;
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise((resolve) => { release = () => resolve(undefined); });
    window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ opts) => {
      if (!String(url).includes('/git/status')) return original(url, opts);
      await gate;
      if (answer instanceof Error) {
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          text: async () => JSON.stringify({ error: answer.message }),
        };
      }
      return { ok: true, json: async () => answer };
    });
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      window.fetch = original;
      setGitWorkspace('');
    };
    // Given back before the mount's own teardown, which restores the fetch
    // underneath this one.
    owed.push(restore);
    return { release, restore };
  }

  await test('switching to a conversation in another tree repaints only if the answer differs', async () => {
    // The card follows the visible conversation, and a tab switch is the
    // commonest thing a user does. Dropping to "Checking…" for the length of a
    // `git status` changes the card's height, and the rail and everything
    // above it jump; the same answer should not even touch the DOM.
    const status = { root: '/tmp/proj', repos: [repo({ changed: 2 })] };
    const m = await mount(status);
    const held = holdStatus(status);
    let mutations = 0;
    const observer = new MutationObserver((records) => { mutations += records.length; });
    observer.observe(m.contentEl, { childList: true, subtree: true, characterData: true });
    try {
      setGitWorkspace('ws_other');
      await nextTask();
      assert(!m.text().includes('Checking…'),
        `the last answer stays up while the new one is read, got ${JSON.stringify(m.text())}`);
      assert(m.text().includes('2 changed'), `got ${JSON.stringify(m.text())}`);
      held.release();
      await gitStatusCache.refresh();
      await nextTask();
      assert(mutations === 0, `an identical answer repaints nothing, saw ${mutations} mutations`);
    } finally {
      observer.disconnect();
    }
    held.restore();
    m.teardown();
  });

  await test('a switch whose new tree refuses to be read drops the old tree for the refusal', async () => {
    // Keeping the last answer up is only honest until the new one arrives: if
    // the new tree cannot be read, the old tree's counts would sit under its
    // name indefinitely.
    const m = await mount({ root: '/tmp/proj', repos: [repo({ changed: 2 })] });
    const held = holdStatus(new Error('workspace ws_gone was closed'));
    setGitWorkspace('ws_gone');
    held.release();
    await gitStatusCache.refresh();
    await nextTask();
    assert(m.text().includes('was closed'), `expected the refusal, got ${JSON.stringify(m.text())}`);
    assert(!m.text().includes('2 changed'), `and not the old tree's counts, got ${JSON.stringify(m.text())}`);
    held.restore();
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
    await nextTask();

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
    await nextTask();
    const first = m.server.board[0]?.id;

    pinboardView.close();
    pinboardView.setActivePin(null);
    /** @type {any} */ (m.launcher()).click();
    await nextTask();

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
    await nextTask();

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

  // --- en-XA ----------------------------------------------------------------

  await test('en-XA: every state the card can be in is translated, the server\u2019s refusal is not', async () => {
    await underPseudoLocale('git-status-card-test', async () => {
      /** @type {string[]} */
      const shown = [];
      // Names are digits: the workspace and repo badges are data, the counts are
      // numbers inside a message.
      const states = /** @type {[string, any][]} */ ([
        ['checking', null],
        ['no repository', { root: '/tmp/1', workspace: '2', repos: [] }],
        ['clean', { root: '/tmp/1', workspace: '2', repos: [repo()] }],
        ['dirty, both sides', { root: '/tmp/1', workspace: '2', repos: [repo({ changed: 3, staged: 4, total: 7 })] }],
        ['dirty, changed only', { root: '/tmp/1', repos: [repo({ changed: 3, total: 3 })] }],
        ['dirty, staged only', { root: '/tmp/1', repos: [repo({ path: '5', staged: 4, total: 4 })] }],
      ]);
      for (const withPin of [false, true]) {
        if (withPin) enableGitPin(); else pinboardItemRegistry.reset();
        for (const [, status] of states) {
          const m = await mount(status);
          shown.push(...shownStrings(m.contentEl, '.info-card__git-repo'));
          for (const badge of m.contentEl.querySelectorAll('.info-card__git-repo[title]')) {
            shown.push(String(badge.getAttribute('title')));
          }
          m.teardown();
        }
      }
      // The repository badges above are data, but one at a root with no folder
      // name is labelled in the card's own words.
      const unnamed = await mount({ root: '', repos: [repo({ changed: 3, total: 3 }), repo({ path: '5', staged: 4, total: 4 })] });
      shown.push(unnamed.contentEl.querySelector('.info-card__git-repo')?.textContent || '');
      unnamed.teardown();
      const raw = shown.filter((s) => !isPseudoLocalized(s));
      assert(shown.length >= 20, `expected the states to show text, got ${JSON.stringify(shown)}`);
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    }, { '@juggler/core': CORE_TEXT });
  });

  return { passed, failed, errors };
}
