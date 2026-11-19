//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The Git pin's head line, above every place: `repo / branch`, two buttons
 * read as one name — the repository, which opens the menu of the tree's
 * repositories when it holds more than one and is plain text otherwise, and the
 * branch (or the sha and "detached"), which opens the worktree switcher; then
 * how far the branch is from
 * its upstream — with a struck-through cloud when the fetch made unasked
 * failed — how many files are changed, and Refresh; then, at the right, the
 * commands a wide pin has room for (Fetch, Pull, Push, Stash, Branch), the
 * primary action and the ⋯ menu. A running write spins in the button that
 * started it, which stays where it is. Refresh is the line's one spinner
 * besides: it turns for its own read, for the unasked fetch and for a running
 * write — which its tooltip describes, and a click on it then stops — so the
 * line grows nothing while work runs. The pin asks the board for
 * no toolbar: this line is its header. While
 * an operation is in progress the line carries `data-operation`, its kind,
 * and is tinted.
 *
 * It draws what it is told. The Changes place reads the tree and says what is
 * in it, `primaryOf` chooses the action, and the pin says what the buttons do,
 * through `handlers`.
 * @module pins/git/head
 */

import { markForTranslation, translator } from 'juggler/i18n';
import { createElement } from 'juggler/ui';
import { icon } from './icons.js';
import { createMenuSelect } from './menu-select.js';
import { commandOf, progressText, runningLabel } from './primary.js';

/** @typedef {import('./primary.js').Primary} Primary */

const t = translator('@juggler/core');

/** One turn of the refresh spin, in milliseconds: its animation's duration in pins/git/styles. */
const SPIN_TURN_MS = 1200;

/**
 * @typedef {object} HeadState
 * @property {string} repoName - The repository's name.
 * @property {import('juggler/pinboard-item-type').PinGitChanges|null} read - Its last changes read.
 * @property {number} changed - Changed files.
 * @property {Primary} primary - The action.
 * @property {boolean} fetching - The repository is being fetched unasked.
 * @property {string} offline - Why that fetch failed; '' when it did not.
 */

/**
 * @typedef {'fetch'|'pull'|'push'|'stash-save'|'branch-create'} HeadAction
 */

/**
 * @typedef {object} HeadHandlers
 * @property {(anchor: HTMLElement) => void} branch - The branch button.
 * @property {(anchor: HTMLElement) => void} more - The ⋯ button.
 * @property {(anchor: HTMLElement) => void} primary - The primary button.
 * @property {() => void} cancel - Refresh, pressed while a network write runs: stop it.
 * @property {(repo: string) => void} repo - Another repository was picked.
 * @property {(action: HeadAction, anchor: HTMLElement) => void} action - One of the command buttons.
 * @property {() => Promise<unknown>|void} refresh - The refresh button; it spins until this settles.
 */

/**
 * @typedef {object} Head
 * @property {HTMLElement} element - The line.
 * @property {HTMLButtonElement} branchButton - What the switcher hangs off.
 * @property {HTMLButtonElement} moreButton - What the ⋯ menu hangs off.
 * @property {HTMLButtonElement} primaryButton - What the primary's popovers hang off.
 * @property {HeadHandlers} handlers - What the buttons do; set by the pin and the places.
 * @property {(repos: {value: string, label: string}[], value: string) => void} setRepos - The repository menu's choices, and which is shown.
 * @property {(state: HeadState) => void} update - Draw this.
 */

/**
 * The commands a wide pin offers as buttons beside the primary, most wanted
 * first: the stylesheet shows each from a width (`data-rank`), and a command
 * the primary is already offering is not offered twice.
 */
const COMMANDS = /** @type {const} */ ([
  { id: 'fetch', icon: 'fetch', label: markForTranslation('Fetch'), title: markForTranslation('Fetch from the remotes') },
  { id: 'pull', icon: 'down', label: markForTranslation('Pull'), title: markForTranslation('Pull from the upstream') },
  { id: 'push', icon: 'up', label: markForTranslation('Push'), title: markForTranslation('Push to the upstream') },
  { id: 'stash-save', icon: 'stash', label: markForTranslation('Stash'), title: markForTranslation('Stash all changes…') },
  { id: 'branch-create', icon: 'plus', label: markForTranslation('Branch'), title: markForTranslation('New branch…') },
]);

/**
 * @returns {Head} An empty head line.
 */
export function createHead() {
  const element = createElement('div', 'git-pin__head');
  /** @type {HeadHandlers} */
  const handlers = {
    branch: () => {}, more: () => {}, primary: () => {}, cancel: () => {}, repo: () => {}, action: () => {}, refresh: () => {},
  };
  // `repo / branch`: each half is its own button, opening its own chooser. The
  // repository half is disabled — text, without a chevron — while the tree
  // holds one repository, and the branch half is absent until the first read.
  const ref = createElement('span', 'git-pin__ref');
  const repoPicker = createMenuSelect({
    className: 'git-pin__seg git-pin__repo',
    label: t('Repository'),
    onChoose: (value) => handlers.repo(value),
    bare: true,
  });
  repoPicker.element.disabled = true;
  const slash = createElement('span', 'git-pin__slash', '/');
  slash.setAttribute('aria-hidden', 'true');
  const branchButton = /** @type {HTMLButtonElement} */ (createElement('button', 'git-pin__seg git-pin__branch'));
  branchButton.type = 'button';
  branchButton.setAttribute('aria-haspopup', 'true');
  const branchText = createElement('span', 'git-pin__branch-text text-truncate');
  branchButton.append(branchText, icon('chev'));
  branchButton.hidden = true;
  slash.hidden = true;
  ref.append(repoPicker.element, slash, branchButton);
  /** @type {{value: string, label: string}[]} */
  let repoChoices = [];
  let repoName = '';
  /**
   * Name the repository shown: from the menu's choices once they include it,
   * from the head's own state until then.
   * @param {string} value - Its path.
   */
  const drawRepo = (value) => {
    const listed = repoChoices.some((c) => c.value === value);
    repoPicker.set(listed ? repoChoices : [{ value, label: repoName }], value);
    // A squeezed pin drops the name when it is not a chooser and the branch
    // is there to stand for it (`data-repo-optional`, pins/git/styles).
    ref.toggleAttribute('data-repo-optional', repoPicker.element.disabled && !branchButton.hidden);
  };
  const sync = createElement('span', 'git-pin__sync');
  const dirtyCount = createElement('span', 'git-pin__stat git-pin__dirty');
  const spacer = createElement('span', 'git-pin__spacer');
  const commands = createElement('span', 'git-pin__commands');
  /** @type {Map<string, HTMLButtonElement>} */
  const commandButtons = new Map();
  /** @type {Map<string, {own: Element, spin: Element}>} Each command's glyph, and the spinner that stands in for it while it runs. */
  const commandGlyphs = new Map();
  COMMANDS.forEach((command, index) => {
    const b = /** @type {HTMLButtonElement} */ (createElement('button', 'git-pin__command btn btn-sm btn-ghost'));
    b.type = 'button';
    b.dataset.command = command.id;
    b.dataset.rank = String(index + 1);
    b.title = t(command.title);
    const own = icon(command.icon);
    commandGlyphs.set(command.id, { own, spin: icon('sync') });
    b.append(own, createElement('span', '', t(command.label)));
    b.addEventListener('click', () => handlers.action(command.id, b));
    commandButtons.set(command.id, b);
    commands.append(b);
  });
  const primary = /** @type {HTMLButtonElement} */ (createElement('button', 'git-pin__primary btn btn-sm'));
  primary.type = 'button';
  const refreshButton = /** @type {HTMLButtonElement} */ (createElement('button', 'git-pin__refresh btn btn-icon btn-sm btn-ghost'));
  refreshButton.type = 'button';
  refreshButton.append(icon('sync'), createElement('span', 'git-pin__refresh-stop', '✕'));
  const moreButton = /** @type {HTMLButtonElement} */ (createElement('button', 'git-pin__more btn btn-icon btn-xs btn-ghost', '⋯'));
  moreButton.type = 'button';
  moreButton.title = t('More');
  moreButton.setAttribute('aria-label', t('More'));
  element.append(ref, sync, dirtyCount, refreshButton, spacer, commands, primary, moreButton);

  branchButton.addEventListener('click', () => handlers.branch(branchButton));
  moreButton.addEventListener('click', () => handlers.more(moreButton));
  primary.addEventListener('click', () => handlers.primary(primary));

  // Refresh is the line's one sign of work: it turns while its own read is
  // out, while the repository is fetched unasked, and while a network write
  // runs — when it says what the write is doing, shows ✕ under the pointer,
  // and a click stops the write rather than reading again. `aria-busy` is the
  // work, set until it has ended. The spin is the picture of it, and finishes
  // the turn it is on, so a read answered within a frame still turns once
  // rather than not visibly at all.
  /** Its own read is out. */
  let refreshing = false;
  /** A network write, or a fetch nobody asked for, is running. */
  let working = false;
  /** A network write is running, which a click stops. */
  let stoppable = false;
  /** When the spin began, to end it at the end of a turn. */
  let spinStarted = 0;
  /** @type {ReturnType<typeof setTimeout>|null} The spin's end, once the work has settled. */
  let spinEnd = null;
  const drawSpin = () => {
    const busy = refreshing || working;
    if (busy) refreshButton.setAttribute('aria-busy', 'true');
    else refreshButton.removeAttribute('aria-busy');
    const spinning = refreshButton.classList.contains('git-pin__refresh--spin');
    if (busy) {
      if (spinEnd !== null) clearTimeout(spinEnd);
      spinEnd = null;
      if (!spinning) {
        spinStarted = performance.now();
        refreshButton.classList.add('git-pin__refresh--spin');
      }
    } else if (spinning && spinEnd === null) {
      const turned = (performance.now() - spinStarted) % SPIN_TURN_MS;
      spinEnd = setTimeout(() => {
        spinEnd = null;
        refreshButton.classList.remove('git-pin__refresh--spin');
      }, SPIN_TURN_MS - turned);
    }
  };
  /** @param {string} words - Its tooltip and name. */
  const nameRefresh = (words) => {
    refreshButton.title = words;
    refreshButton.setAttribute('aria-label', words);
  };
  nameRefresh(t('Refresh'));
  refreshButton.addEventListener('click', () => {
    if (stoppable) {
      handlers.cancel();
      return;
    }
    if (refreshing) return;
    refreshing = true;
    drawSpin();
    void Promise.resolve(handlers.refresh()).catch(() => {}).finally(() => {
      refreshing = false;
      drawSpin();
    });
  });

  /**
   * One count beside the branch: a glyph, the number, and a word saying what
   * it counts, which a narrow pin drops; the tooltip says it all regardless.
   * @param {string} cls - Its class.
   * @param {string} glyph - The glyph.
   * @param {number} count - The number.
   * @param {string} word - What it counts.
   * @param {string} title - The whole of it, as a sentence.
   * @returns {HTMLElement} The count.
   */
  const stat = (cls, glyph, count, word, title) => {
    const el = createElement('span', `git-pin__stat ${cls}`);
    el.append(createElement('span', 'git-pin__stat-glyph', glyph), createElement('span', 'git-pin__stat-num', String(count)),
      createElement('span', 'git-pin__stat-word', word));
    el.title = title;
    el.setAttribute('aria-label', title);
    return el;
  };

  return {
    element,
    branchButton,
    moreButton,
    primaryButton: primary,
    handlers,
    setRepos: (repos, value) => {
      repoPicker.element.disabled = repos.length < 2;
      repoChoices = repos;
      drawRepo(value);
    },
    update: ({ repoName: name, read, changed, primary: action, fetching, offline }) => {
      if (read?.operation) element.dataset.operation = read.operation;
      else delete element.dataset.operation;
      repoName = name;
      slash.hidden = !read;
      branchButton.hidden = !read;
      drawRepo(repoPicker.value());
      branchText.replaceChildren();
      if (read) {
        if (read.detached || !read.branch) {
          branchText.append(createElement('span', 'git-pin__branch-name', (read.head?.sha || '').slice(0, 7)),
            createElement('span', 'git-pin__detached', ` ${t('detached')}`));
        } else {
          branchText.append(createElement('span', 'git-pin__branch-name', read.branch));
        }
      }
      branchButton.title = t('Switch worktree or branch');
      sync.replaceChildren();
      if (read?.upstream) {
        const upstream = read.upstream;
        if (read.ahead) {
          sync.append(stat('git-pin__ahead', '↑', read.ahead, t('to push'),
            t('{count, plural, one {# commit} other {# commits}} to push to {upstream}', { count: read.ahead, upstream })));
        }
        if (read.behind) {
          sync.append(stat('git-pin__behind', '↓', read.behind, t('to pull'),
            t('{count, plural, one {# commit} other {# commits}} to pull from {upstream}', { count: read.behind, upstream })));
        }
        if (!read.ahead && !read.behind) {
          const ok = createElement('span', 'git-pin__stat git-pin__sync-ok');
          ok.append(createElement('span', 'git-pin__stat-glyph', '✓'), createElement('span', 'git-pin__stat-word', t('up to date')));
          ok.title = t('Up to date with {upstream}', { upstream });
          sync.append(ok);
        }
      } else if (read?.branch && read.remotes) {
        const none = createElement('span', 'git-pin__stat git-pin__sync-none', t('unpublished'));
        none.title = t('This branch has no upstream: Publish pushes it to a remote');
        sync.append(none);
      }
      if (offline && !fetching) {
        const mark = createElement('span', 'git-pin__offline');
        mark.title = t("Couldn't fetch: {reason}", { reason: offline });
        mark.setAttribute('aria-label', mark.title);
        mark.append(icon('offline'));
        sync.append(mark);
      }
      dirtyCount.replaceChildren();
      dirtyCount.hidden = !changed;
      if (changed) {
        const words = t('{count, plural, one {# changed file} other {# changed files}}', { count: changed });
        dirtyCount.append(createElement('span', 'git-pin__stat-glyph', '●'), createElement('span', 'git-pin__stat-num', String(changed)),
          createElement('span', 'git-pin__stat-word', t('changed')));
        dirtyCount.title = words;
        dirtyCount.setAttribute('aria-label', words);
      }
      const running = action.job || null;
      working = Boolean(running) || fetching;
      stoppable = Boolean(running);
      refreshButton.classList.toggle('git-pin__refresh--stop', stoppable);
      drawSpin();
      if (running) {
        const progress = progressText(running.progress);
        nameRefresh(t('{doing} — click to stop', { doing: progress ? `${runningLabel(running)} · ${progress}` : runningLabel(running) }));
      } else {
        nameRefresh(fetching ? t('Fetching — the first time this repository is shown') : t('Refresh'));
      }
      const offered = commandOf(action.kind);
      /** @type {Record<string, boolean>} */
      const usable = {
        fetch: Boolean(read?.remotes),
        pull: Boolean(read?.upstream),
        // With no upstream yet, a push publishes the branch.
        push: Boolean(read?.branch && read.remotes),
        'stash-save': changed > 0,
        'branch-create': Boolean(read),
      };
      for (const [id, b] of commandButtons) {
        const mine = running?.kind === id;
        b.hidden = id === offered;
        b.disabled = !usable[id] || mine;
        b.classList.toggle('git-pin__command--spin', mine);
        b.setAttribute('aria-busy', String(mine));
        const glyphs = commandGlyphs.get(id);
        const want = mine ? glyphs?.spin : glyphs?.own;
        const have = mine ? glyphs?.own : glyphs?.spin;
        if (want && have?.isConnected) have.replaceWith(want);
      }
      primary.classList.toggle('btn-primary', action.tone === 'primary');
      primary.classList.toggle('btn-ghost', action.tone !== 'primary');
      primary.classList.toggle('git-pin__primary--spin', Boolean(action.spin));
      primary.disabled = action.disabled;
      primary.dataset.kind = action.kind;
      primary.title = action.title || '';
      primary.replaceChildren(...(action.icon ? [icon(action.icon)] : []), document.createTextNode(action.label));
    },
  };
}
