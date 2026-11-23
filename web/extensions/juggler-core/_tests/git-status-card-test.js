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
import { gitClient, __resetGitStatus } from '../lib/git-client.js';
import { servicesFor } from '../../../js/services/extension-services.js';
import { setVisibleWorkspace } from '../../../js/services/visible-workspace.js';
import pinboardItemRegistry from '../../../js/registries/pinboard-item-registry.js';
import pinboardStore from '../../../js/services/pinboard-store.js';
import pinboardView from '../../../js/services/pinboard-view.js';
import { assert, nextTask, waitFor } from '../../../js-tests/utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';

/** juggler-core's English for this card, standing in for its catalogue. */
const CORE_TEXT = [
  'Checking…', 'No git repository', 'No changed files', 'Workspace: {workspace}',
  'Open Git in the Pinboard', 'Open Git', 'Open {repo} in Git',
  '{count} changed', '{count} staged', '{count, plural, one {# conflict} other {# conflicts}}', 'repo',
  'Detached head', 'No branch', '{count} ahead', '{count} behind', '{ahead} ahead, {behind} behind',
  'Upstream {upstream}: {divergence}',
];

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Whether a request is the git tool's status read.
 * @param {any} url - The request URL.
 * @param {any} [opts] - The request options.
 * @returns {boolean} Whether it is.
 */
function isGitStatus(url, opts) {
  if (!String(url).includes('/api/ops/client')) return false;
  const call = JSON.parse(opts?.body || '{}');
  return call.toolId === 'git' && call.operation === 'status';
}

/**
 * The git tool's answer, as the client entry sends it: the status, or a
 * refusal with the server's words.
 * @param {any} status - What the read answers, or an Error to refuse it with.
 * @returns {any} The response.
 */
function gitAnswer(status) {
  const body = status instanceof Error ? { success: false, error: status.message } : { success: true, data: status };
  return { ok: true, json: async () => body };
}

/**
 * Run Git status card tests.
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests(_ctx) {
  // The window's status cache, as the card reads it: reset, read and held
  // through a client of a surface that lives for the whole run.
  const life = new AbortController();
  const probe = gitClient(servicesFor(null, life.signal), life.signal);
  const gitStatusCache = {
    reset: __resetGitStatus,
    refresh: () => probe.refresh(),
    get: () => probe.status(),
  };

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
    conflicted: 0,
    total: 0,
    added: 0,
    removed: 0,
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
   * @param {any} status - What the git tool's status should answer.
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
      if (isGitStatus(target, opts)) {
        state.gitRequests++;
        return gitAnswer(status);
      }
      if (target.includes('/pinboard/operations')) {
        for (const op of JSON.parse(opts.body).operations) {
          if (op.op === 'add' && !board.some((p) => p.id === op.id)) {
            board.push({ id: op.id, type: op.type, config: op.config || {} });
          }
          const pin = op.op === 'update' ? board.find((p) => p.id === op.id) : null;
          if (pin) pin.config = op.config;
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
    const cardLife = new AbortController();
    const mounted = card.mount(contentEl, undefined, { services: servicesFor(null, cardLife.signal), signal: cardLife.signal });
    const stopCard = () => { mounted?.(); cardLife.abort(); };

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
      // What the card says, its tooltips and accessible names included: the
      // counts' breakdown is said only there.
      says: () => [contentEl.textContent || '', ...[...contentEl.querySelectorAll('[title], [aria-label]')]
        .flatMap((el) => [el.getAttribute('title') || '', el.getAttribute('aria-label') || ''])].join(' | '),
      launcher: () => contentEl.querySelector('.git-status-card__launch'),
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
      if (isGitStatus(url, opts)) return gitAnswer(new Error('workspace ws_gone was closed'));
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
      if (!isGitStatus(url, opts)) return original(url, opts);
      await gate;
      return gitAnswer(answer);
    });
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      window.fetch = original;
      setVisibleWorkspace('');
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
      setVisibleWorkspace('ws_other');
      await nextTask();
      assert(!m.text().includes('Checking…'),
        `the last answer stays up while the new one is read, got ${JSON.stringify(m.text())}`);
      assert(m.says().includes('2 changed'), `got ${JSON.stringify(m.says())}`);
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
    setVisibleWorkspace('ws_gone');
    held.release();
    await gitStatusCache.refresh();
    await nextTask();
    assert(m.text().includes('was closed'), `expected the refusal, got ${JSON.stringify(m.text())}`);
    assert(!m.says().includes('2 changed'), `and not the old tree's counts, got ${JSON.stringify(m.says())}`);
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
    assert(m.says().includes('No changed files'), `got ${JSON.stringify(m.says())}`);
    m.teardown();
  });

  await test('a dirty repo is one line: a file count, its breakdown on hover, a zero side left out', async () => {
    const m = await mount({ root: '/tmp/proj', repos: [repo({ changed: 2, staged: 1, total: 3 })] });
    const files = m.contentEl.querySelector('.git-status-card__files');
    assert(files?.textContent === '3' && files.getAttribute('title') === '2 changed, 1 staged',
      `the count, and its breakdown: ${files?.outerHTML}`);
    assert(m.contentEl.querySelectorAll('.git-status-card__line').length === 1, `one line: ${m.contentEl.innerHTML}`);

    const stagedOnly = await mount({ root: '/tmp/proj', repos: [repo({ staged: 1, total: 1 })] });
    const staged = stagedOnly.contentEl.querySelector('.git-status-card__files');
    assert(staged?.getAttribute('title') === '1 staged' && staged.classList.contains('git-status-card__files--staged'),
      `a zero side is left out entirely, and only staged files say so by their colour: ${staged?.outerHTML}`);
    stagedOnly.teardown();
    m.teardown();
  });

  await test('a repo says its branch, its drift from upstream, and a conflict before anything else', async () => {
    const m = await mount({ root: '/tmp/proj', repos: [repo({
      branch: 'develop', upstream: 'origin/develop', ahead: 2, behind: 1, changed: 1, conflicted: 1, total: 1,
    })] });
    const q = (/** @type {string} */ sel) => m.contentEl.querySelector(sel);
    assert(q('.git-status-card__branch')?.textContent === 'develop', `the branch: ${m.contentEl.innerHTML}`);
    const sync = q('.git-status-card__sync');
    assert(sync?.textContent === '21' && sync.getAttribute('title') === 'Upstream origin/develop: 2 ahead, 1 behind',
      `ahead then behind, said in full on hover: ${sync?.outerHTML}`);
    const files = q('.git-status-card__files');
    assert(files?.classList.contains('git-status-card__files--conflicted') && files.getAttribute('title') === '1 conflict, 1 changed',
      `the conflict colours the count and leads its breakdown: ${files?.outerHTML}`);
    m.teardown();

    const level = await mount({ root: '/tmp/proj', repos: [repo({ upstream: 'origin/main', changed: 1, total: 1 })] });
    assert(!level.contentEl.querySelector('.git-status-card__sync'), 'a branch level with its upstream shows no drift');
    level.teardown();
  });

  await test('a clean lone repo still shows its branch; several clean ones only say so', async () => {
    const lone = await mount({ root: '/tmp/proj', repos: [repo({ branch: 'develop' })] });
    assert(lone.contentEl.querySelector('.git-status-card__branch')?.textContent === 'develop'
      && lone.says().includes('No changed files'), `got ${lone.contentEl.innerHTML}`);
    lone.teardown();
    const several = await mount({ root: '/tmp/proj', repos: [repo(), repo({ path: 'sub' })] });
    assert(!several.contentEl.querySelector('.git-status-card__branch') && several.text().includes('No changed files'),
      `got ${several.contentEl.innerHTML}`);
    several.teardown();
  });

  await test('a lone repo at the root goes unlabelled, and nested repos do not', async () => {
    const lone = await mount({ root: '/tmp/proj', repos: [repo({ changed: 1, total: 1 })] });
    assert(!lone.contentEl.querySelector('.git-status-card__repo'),
      `one repo at the root needs no label:\n${lone.contentEl.innerHTML}`);
    lone.teardown();

    const nested = await mount({
      root: '/tmp/proj',
      repos: [repo({ path: '', changed: 1, total: 1 }), repo({ path: 'juggler', changed: 1, total: 1 })],
    });
    const labels = [...nested.contentEl.querySelectorAll('.git-status-card__repo')]
      .map((/** @type {any} */ el) => el.textContent);
    assert(labels.includes('proj') && labels.includes('juggler'),
      `expected both repos named, got ${JSON.stringify(labels)}`);
    nested.teardown();
  });

  // The card follows the visible conversation; a tab switch can move it from the
  // project to a worktree, and every state it can be in must say which.
  await test('a workspace tree is named above every state, and the project is not', async () => {
    const badges = (/** @type {any} */ m) => [...m.contentEl.querySelectorAll('.git-status-card__repo')]
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
    assert(m.says().includes('1 changed'), 'and the card still says what it always said');
    m.teardown();
    const nested = await mount({ root: '/tmp/proj', repos: [repo({ changed: 1, total: 1 }), repo({ path: 'juggler', changed: 1, total: 1 })] });
    assert(!nested.contentEl.querySelector('button.git-status-card__repo'), 'nor do its repository badges');
    nested.teardown();
  });

  await test('with the Git pin enabled, the whole card becomes the way in', async () => {
    enableGitPin();
    const m = await mount({ root: '/tmp/proj', repos: [repo({ changed: 1, total: 1 })] });
    const button = m.launcher();
    assert(!!button, 'with a pin that accepts the git source, the card offers to open it');
    assert(button?.tagName === 'BUTTON', `expected a real button, got ${button?.tagName}`);
    assert(button?.getAttribute('aria-label') === 'Open Git in the Pinboard',
      `expected a literal label, got ${JSON.stringify(button?.getAttribute('aria-label'))}`);
    assert(Boolean(m.contentEl.querySelector('.git-status-card__go')), 'an arrow says the card goes somewhere');
    assert(m.says().includes('1 changed'), 'and the counts are still what it reads as');
    m.teardown();
  });

  await test('the card offers the same way in whether or not anything changed', async () => {
    enableGitPin();
    const m = await mount({ root: '/tmp/proj', repos: [repo()] });
    assert(m.launcher()?.getAttribute('aria-label') === 'Open Git in the Pinboard',
      `got ${JSON.stringify(m.launcher()?.getAttribute('aria-label'))}`);
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

  await test('a repository badge opens the pin on that repository; the rest of the card leaves it where it is', async () => {
    enableGitPin();
    const m = await mount({
      root: '/tmp/proj',
      repos: [repo({ path: '', changed: 1, total: 1 }), repo({ path: 'juggler', changed: 1, total: 1 })],
    });
    const badgeFor = (/** @type {string} */ name) => /** @type {HTMLButtonElement|undefined} */ ([...m.contentEl.querySelectorAll('button.git-status-card__repo')]
      .find((b) => b.textContent === name));
    assert(Boolean(badgeFor('juggler') && badgeFor('proj')), `each repository's badge is a button:\n${m.contentEl.innerHTML}`);

    badgeFor('juggler')?.click();
    await waitFor(() => m.server.board.length > 0 && pinboardView.getActivePinId() === m.server.board[0]?.id, 'the pin to be added and revealed');
    assert(m.server.board.length === 1 && m.server.board[0].config.repo === 'juggler',
      `a new pin opens on the nested repository: ${JSON.stringify(m.server.board)}`);
    assert(pinboardView.getActivePinId() === m.server.board[0].id, 'and is revealed');

    /** @type {any} */ (m.launcher()).click();
    await nextTask();
    assert(m.server.board.length === 1 && m.server.board[0].config.repo === 'juggler',
      `the card elsewhere reveals it on the repository it shows: ${JSON.stringify(m.server.board)}`);

    badgeFor('proj')?.click();
    await waitFor(() => !('repo' in (m.server.board[0]?.config || {})), 'the pin to move to the root repository');
    assert(m.server.board.length === 1 && !('repo' in m.server.board[0].config),
      `the root repository's badge moves the same pin back to the root: ${JSON.stringify(m.server.board)}`);
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
    const secondLife = new AbortController();
    const secondMounted = card.mount(second, undefined, { services: servicesFor(null, secondLife.signal), signal: secondLife.signal });
    const stopSecond = () => { secondMounted?.(); secondLife.abort(); };
    await nextTask();

    // Both surfaces share one in-flight fetch and one snapshot, which is the
    // whole reason the cache is in the host rather than in each surface.
    assert(m.server.gitRequests <= before + 1,
      `a second surface should not multiply the git invocations: ${before} → ${m.server.gitRequests}`);
    assert(Boolean(second.querySelector('.git-status-card__clean-tick')),
      `and it paints from the shared snapshot at once:\n${second.innerHTML}`);

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
        ['drifted, conflicted', { root: '/tmp/1', repos: [repo({ upstream: '6', ahead: 1, behind: 2, changed: 1, staged: 1, conflicted: 1, total: 2 })] }],
        ['detached', { root: '/tmp/1', repos: [repo({ branch: '', detached: true, changed: 1, total: 1 })] }],
        ['no branch', { root: '/tmp/1', repos: [repo({ branch: '' })] }],
      ]);
      for (const withPin of [false, true]) {
        if (withPin) enableGitPin(); else pinboardItemRegistry.reset();
        for (const [, status] of states) {
          const m = await mount(status);
          // Names and numbers are data: the badges, a branch's name, the drift's
          // and the lines' digits. Their tooltips are words, and are checked.
          const data = '.git-status-card__repo, .git-status-card__branch:not(.git-status-card__branch--none), .git-status-card__sync, .git-status-card__files';
          shown.push(...shownStrings(m.contentEl, data));
          for (const node of m.contentEl.querySelectorAll('.git-status-card__repo[title], .git-status-card__sync[title], .git-status-card__files[title]')) {
            // A badge's title is its name unless it names a workspace.
            if (node.matches('.git-status-card__repo') && node.getAttribute('title') === node.textContent) continue;
            shown.push(String(node.getAttribute('title')));
          }
          m.teardown();
        }
      }
      // The repository badges above are data, but one at a root with no folder
      // name is labelled in the card's own words.
      const unnamed = await mount({ root: '', repos: [repo({ changed: 3, total: 3 }), repo({ path: '5', staged: 4, total: 4 })] });
      shown.push(unnamed.contentEl.querySelector('.git-status-card__repo')?.textContent || '');
      unnamed.teardown();
      const raw = shown.filter((s) => !isPseudoLocalized(s));
      assert(shown.length >= 20, `expected the states to show text, got ${JSON.stringify(shown)}`);
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    }, { '@juggler/core': CORE_TEXT });
  });

  return { passed, failed, errors };
}
