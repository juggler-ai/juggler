//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The Git pin's Refs place: the repository's worktrees, branches, remote
 * branches, tags and stashes as one list, and the selected one's detail with
 * its actions as buttons — the same actions its ⋯ menu offers, from
 * pins/git/refs-model.
 *
 * **Reads.** `refs`, `worktrees` and `submodules` are read when the place is
 * first shown and each time it is shown again, and after that on a
 * `git-change` naming `refs` or `head` for its repository, on `git-resync`,
 * and after each write it runs. The submodules are read again on any change to
 * the repository, or to a repository inside it, while it has any: a submodule
 * moves when something is checked out in it, which its superproject's refs
 * never show.
 * One read of each kind is out at a time; a change while one is out reads once
 * more when it ends, and a tree or repository switch aborts what is out. While
 * the list is off screen a change is only noted, and it is read once when it
 * comes back (pins/git/reader). A read
 * the pinned tree refuses (it has gone) is the pin's to handle.
 *
 * **Writes** go through `git.run`. One that offers no Undo — a merge, rebase,
 * fast-forward, tag push, stash apply or pop, or prune — asks first. A branch
 * or tag delete asks too, saying whether it leaves commits nothing else
 * reaches; it, and a stash drop, then toasts with Undo. A refusal says what to
 * do next: a branch out in another tree offers that tree, an unmerged branch
 * asks before forcing, changes in the way offer to stash them, and a ref that
 * moved is read again.
 *
 * **Layout** is the Changes place's: list and detail side by side from 34rem,
 * one at a time below it, the place's `data-level` saying which. A full-width
 * pin never shows this place: it shows the list alone beside Changes and
 * History, as a sidebar, where a row's click goes to what it names rather than
 * to its detail: a worktree is viewed, a branch, remote branch or tag shown in
 * History, a stash's changes reviewed, and a submodule opened as the
 * repository. Double-clicking a branch, in either, checks it out.
 *
 * **The filter** (`/`, pins/git/list-filter) narrows the list to the rows
 * whose name holds its text (refs-model's `rowName`); a section with none left
 * loses its header, j/k walk only the rows shown, and the selection stays put.
 * @module pins/git/refs-place
 */

import { translator } from 'juggler/i18n';
import { contextMenuFor, createElement, errorText, openMenuAt } from 'juggler/ui';
import { createActions, menuRows, updateSubmodule } from './actions.js';
import { icon } from './icons.js';
import { measureMode } from './layout.js';
import { askText, closePopover, confirmAction } from './popover.js';
import { createReader } from './reader.js';
import { createListFilter } from './list-filter.js';
import { baseName, menuFor, refsState, rowName, rowOf, sectionsOf, tagRemote, treeAt, viewedTree } from './refs-model.js';
import { openWorktreeSwitcher } from './worktree-switcher.js';
import { createVirtualList, remHeight, WINDOWED_ABOVE } from 'juggler/utils/virtual-list';

const t = translator('@juggler/core');

/**
 * @typedef {import('./refs-model.js').RefsState} RefsState
 * @typedef {import('./refs-model.js').TreeView} TreeView
 * @typedef {import('juggler/pinboard-item-type').PinGitService} PinGitService
 * @typedef {import('juggler/pinboard-item-type').PinWorkspaces} PinWorkspaces
 */

/**
 * @typedef {object} RefsHost
 * @property {() => PinGitService} git - The pin's git service, as it now is.
 * @property {() => PinWorkspaces|undefined} workspaces - The session's workspaces.
 * @property {() => {workspace?: string}} workspaceOption - The tree option for every call.
 * @property {HTMLElement} rootElement - The pin's root.
 * @property {import('./toast.js').PinToast} toast - The pin's toast.
 * @property {() => string} repo - The repository the pin shows.
 * @property {() => number|null} dirtyCount - The viewed tree's changed files, null before they are read.
 * @property {() => boolean} following - Whether the pin follows the conversation's workspace.
 * @property {() => boolean} logOpen - Whether the command log is open.
 * @property {() => void} toggleLog - Open or close it.
 * @property {() => void} toggleFollow - Follow, or stop following, the conversation's workspace.
 * @property {() => void} refreshAll - Read everything again.
 * @property {(kind: 'fetch'|'pull'|'push') => void} network - Fetch, pull or push the repository, as the head's buttons do.
 * @property {() => string[]} folded - The sections folded away, by id.
 * @property {(ids: string[]) => void} setFolded - Remember which sections are folded.
 * @property {(tree: TreeView) => void} viewTree - Show that tree.
 * @property {(scope: string) => void} showScope - Review this scope.
 * @property {(target: {sha: string, stash?: string}) => void} showHistory - Select a
 *   commit in History; a stash (named by its message) as a history of its own.
 * @property {() => void} showChanges - Bring Changes forward.
 * @property {() => void} showRefs - Bring this place forward; in a full pin,
 *   the place the list is a sidebar beside.
 * @property {() => void} levelChanged - The place's `data-level` changed.
 * @property {(e: any) => boolean} treeGone - A read failed: true when it was the
 *   pinned tree going away, which the pin has handled.
 * @property {() => boolean} sidebar - Whether the list is on screen as the full
 *   pin's sidebar rather than as this place.
 * @property {() => boolean} visible - Whether the list is on screen at all: as
 *   this place, or as the sidebar.
 * @property {(repo: string) => void} showRepo - Show another repository of the
 *   tree, by its path in the tree: a submodule opened as one.
 */

/**
 * @typedef {object} RefsPlace
 * @property {HTMLElement} element - The place.
 * @property {() => void} shown - It was brought forward: read it.
 * @property {() => void} refresh - Read again.
 * @property {() => void} setTree - Another tree or repository: watch and read it afresh.
 * @property {(event: KeyboardEvent) => boolean} handleKey - A key outside a text field; true when used.
 * @property {() => void} focus - Focus the list.
 * @property {(ctx: 'repo', anchor: HTMLElement) => void} openMenu - The head's ⋯ menu.
 * @property {(type: 'stash-save'|'branch-create'|'new-worktree', anchor: HTMLElement) => void} act - One
 *   of the ⋯ menu's actions, from a button of the head's own.
 * @property {(anchor: HTMLElement) => void} openSwitcher - The worktrees, to pick one.
 * @property {() => void} teardown - Stop.
 */

/**
 * @param {RefsHost} host - What the place works through.
 * @returns {RefsPlace} The place.
 */
export function createRefsPlace(host) {
  let live = true;
  let opened = false;
  /** @type {import('juggler/pinboard-item-type').PinGitRefs|null} */
  let refs = null;
  /** @type {import('juggler/pinboard-item-type').PinGitWorktrees['trees']} */
  let trees = [];
  /** @type {import('juggler/pinboard-item-type').PinGitSubmodules['submodules']} */
  let submodules = [];
  let readError = '';
  /** @type {string|null} */
  let selected = null;
  /** @type {'list'|'detail'} */
  let level = 'list';
  /** @type {string[]} The shown rows' keys, in order. */
  let order = [];
  /** @type {Map<string, number>} Each shown row's, and section header's, index among the windowed list's items, while it is windowed. */
  let itemIndex = new Map();
  /** @type {{update: () => void}|null} The open switcher, to redraw when a read lands. */
  let switcher = null;
  /** @type {string|null} A section to bring into view once it is drawn. */
  let reveal = null;
  /** What the detail pane was last drawn from, so an unchanged read leaves it (and what hangs off it) alone. */
  let detailSig = '';

  const git = () => host.git();
  const ws = () => host.workspaceOption();

  const element = createElement('div', 'git-refs');
  element.dataset.level = 'list';
  const body = createElement('div', 'git-refs__body');
  const listPane = createElement('section', 'git-refs__list');
  const scroll = createElement('div', 'git-refs__scroll');
  scroll.setAttribute('role', 'listbox');
  scroll.setAttribute('aria-label', t('Refs'));
  scroll.tabIndex = -1;
  const filter = createListFilter({
    label: t('Filter the refs'),
    placeholder: t('Filter by name (/)'),
    root: host.rootElement,
    onChange: () => render(),
  });
  listPane.append(filter.element, scroll);
  /** Over WINDOWED_ABOVE rows the list is drawn a window at a time. */
  const windowed = /** @type {import('juggler/utils/virtual-list').VirtualList<import('juggler/utils/virtual-list').SectionItem>} */ (createVirtualList({
    scroller: scroll,
    spacerClass: 'git-refs__spacer',
    rowHeight: remHeight(1.5),
    headerHeight: remHeight(1.75),
    isHeader: (item) => item.header,
    keyOf: (item) => item.key,
    build: (item) => item.build(),
    decorate: (el, item) => { if (item.row) el.setAttribute('aria-selected', String(item.row === selected)); },
  }));
  const detail = createElement('section', 'git-refs__detail');
  body.append(listPane, detail);
  element.append(body);

  // --- the state -----------------------------------------------------------

  /** @returns {RefsState} What the model is asked about. */
  const state = () => refsState({
    refs,
    trees,
    submodules,
    workspaces: host.workspaces(),
    dirty: host.dirtyCount(),
    following: host.following(),
    logOpen: host.logOpen(),
  });

  // --- reads ---------------------------------------------------------------

  /**
   * @param {any} e - A read's failure.
   */
  const failed = (e) => {
    if (!live || host.treeGone(e)) return;
    readError = errorText(e);
    render();
  };
  const refsReader = createReader(
    (signal) => git().read('refs', { repo: host.repo(), ...ws(), signal }),
    (value) => {
      if (!live) return;
      refs = /** @type {any} */ (value);
      readError = '';
      render();
    },
    failed,
  );
  const treesReader = createReader(
    (signal) => git().read('worktrees', { repo: host.repo(), ...ws(), signal }),
    (value) => {
      if (!live) return;
      trees = /** @type {any} */ (value).trees || [];
      render();
    },
    failed,
  );

  const submodulesReader = createReader(
    (signal) => git().read('submodules', { repo: host.repo(), ...ws(), signal }),
    (value) => {
      if (!live) return;
      submodules = /** @type {any} */ (value).submodules || [];
      render();
    },
    failed,
  );

  /**
   * @param {boolean} [fresh] - Drop what is out.
   */
  const readAll = (fresh = false) => {
    if (!live) return;
    for (const reader of [refsReader, treesReader, submodulesReader]) {
      if (fresh) reader.replace();
      else reader.request();
    }
  };

  // --- writes --------------------------------------------------------------

  const { run, runPastChanges, switchTo } = createActions({
    git,
    repo: () => host.repo(),
    workspaceOption: ws,
    toast: host.toast,
    element,
    live: () => live,
    reread: () => readAll(),
    dirty: () => state().dirty,
    trees: () => state().trees,
    viewTree: (view) => host.viewTree(view),
    showChanges: () => host.showChanges(),
  });

  /**
   * @param {{branch: string, expectSha: string}} a - The branch as listed.
   * @param {Element} anchor - What asked.
   * @param {boolean} force - Delete it unmerged.
   */
  const deleteBranch = (a, anchor, force) => {
    void run({ kind: 'branch-delete', branch: a.branch, expectSha: a.expectSha, ...(force ? { force: true } : {}) }, (e) => {
      if (e?.kind !== 'unmerged') return false;
      confirmAction(anchor.isConnected ? anchor
        : detail.querySelector('.git-refs__act[data-action="branch-delete"]') || element, element, {
        text: t('{name} has commits that are not merged anywhere. Delete it anyway?', { name: a.branch }),
        title: t('Delete unmerged branch'),
        ok: t('Delete'),
        onConfirm: () => deleteBranch(a, anchor, true),
      });
      return true;
    }).then((job) => {
      if (!job) return;
      const sha = job.result?.sha || a.expectSha;
      host.toast.show(t('Deleted {name} (was {sha})', { name: a.branch, sha: sha.slice(0, 7) }), () => {
        void run({ kind: 'ref-restore', ref: `refs/heads/${a.branch}`, sha });
      });
    });
  };

  /**
   * Ask before deleting a branch or tag, saying whether that leaves commits
   * nothing else reaches — read from the repository first, as git's own check
   * (merged into HEAD or its upstream) misses a branch only another branch has
   * merged, and a tag has no check at all. A delete the user agreed to knowing
   * that goes ahead with force; one asked without it (the read failed) still
   * meets git's check.
   * @param {'branch'|'tag'} kind - What is deleted.
   * @param {string} name - Its name.
   * @param {string} sha - The commit it points at.
   * @param {Element} anchor - What asked.
   * @param {(force: boolean) => void} go - Delete it.
   */
  const askDelete = (kind, name, sha, anchor, go) => {
    const ref = kind === 'branch' ? `refs/heads/${name}` : `refs/tags/${name}`;
    const short = sha.slice(0, 7);
    void /** @type {Promise<import('juggler/pinboard-item-type').PinGitStranded>} */ (
      git().read('stranded', { repo: host.repo(), ...ws(), ref })
    ).then((s) => (s.count > 0
      ? t('{kind, select, branch {Delete branch {name}?} other {Delete tag {name}?}} Nothing else reaches {sha}, so {more, select, true {more than {count} commits} other {{count, plural, one {that commit} other {# commits}}}} will be unreachable, and git deletes unreachable commits eventually.',
        { kind, name, sha: short, count: s.count, more: String(Boolean(s.more)) })
      : t('{kind, select, branch {Delete branch {name}?} other {Delete tag {name}?}} {sha} stays reachable from another branch or tag.',
        { kind, name, sha: short })), () => null)
      .then((text) => {
        if (!live) return;
        confirmAction(anchor, element, {
          text: text ?? t("{kind, select, branch {Delete branch {name}?} other {Delete tag {name}?}} Couldn't tell whether anything else reaches {sha}.",
            { kind, name, sha: short }),
          ok: kind === 'branch' ? t('Delete branch') : t('Delete tag'),
          onConfirm: () => go(text !== null),
        });
      });
  };

  /**
   * Ask before a write that offers no Undo, then make it.
   * @param {Element} anchor - What asked.
   * @param {string} text - The question.
   * @param {string} ok - The button that goes ahead.
   * @param {() => void} go - The write.
   */
  const askFirst = (anchor, text, ok, go) => {
    confirmAction(anchor, element, { text, ok, tone: 'primary', onConfirm: go });
  };

  /**
   * @param {string} path - A tree's path.
   * @param {number|null} dirty - Its changed files, null when unknown.
   * @param {boolean} locked - Whether it is locked.
   * @param {Element} anchor - What asked.
   */
  const removeTree = (path, dirty, locked, anchor) => {
    const name = baseName(path);
    const parts = [t('Remove the worktree at {path}?', { path })];
    if (dirty === null) parts.push(t('Its state could not be read; any changes in it are saved first.'));
    else if (dirty > 0) parts.push(t('It has {count, plural, one {# changed file} other {# changed files}}; they are saved first.', { count: dirty }));
    if (locked) parts.push(t('It is locked.'));
    const force = dirty !== 0 || locked;
    confirmAction(anchor, element, {
      text: parts.join(' '),
      title: t('Remove worktree'),
      ok: t('Remove'),
      onConfirm: () => {
        void run({ kind: 'worktree-remove', worktree: path, ...(force ? { force: true } : {}) }).then((job) => {
          if (!job) return;
          const saved = job.result?.saved;
          host.toast.show(saved
            ? t('Removed {name}. Its changes were saved to {saved}.', { name, saved })
            : t('Removed {name}.', { name }));
        });
      },
    });
  };

  /**
   * Push a branch to a branch of any name on any remote, typed as
   * remote/branch — and, if asked, make that its upstream.
   * @param {string} branch - The local branch.
   * @param {Element} anchor - What asked.
   */
  const pushTo = (branch, anchor) => {
    const remotes = (refs?.remotes || []).map((r) => r.name);
    const start = tagRemote(state()) || remotes[0] || '';
    askText(anchor, element, {
      label: t('Push {branch} to', { branch }),
      value: start ? `${start}/${branch}` : '',
      // i18n-ignore: a git ref, shown as typed
      placeholder: `origin/${branch}`,
      ok: t('Push'),
      check: t('Make it the upstream of {branch}', { branch }),
      checked: false,
      onSubmit: (target, track) => {
        const remote = remotes.filter((name) => target.startsWith(`${name}/`)).sort((x, y) => y.length - x.length)[0];
        const name = remote ? target.slice(remote.length + 1) : '';
        if (!remote || !name) {
          host.toast.error(t('{target} is not a remote and a branch, such as origin/{branch}.', { target, branch }));
          return;
        }
        void run({ kind: 'push', branch, remote, name, ...(track ? { track: true } : {}) }).then((job) => {
          if (job) host.toast.show(t('Pushed {branch} to {target}', { branch, target }));
        });
      },
    });
  };

  /**
   * Add a remote, then fetch it, so its branches are listed at once.
   * @param {Element} anchor - What asked.
   */
  const addRemote = (anchor) => {
    const first = !refs?.remotes.length;
    askText(anchor, element, {
      label: t('Add a remote'),
      // i18n-ignore: git's conventional name for a first remote
      value: first ? 'origin' : '',
      placeholder: t('name'),
      ok: t('Add'),
      secondary: { label: t('URL'), placeholder: t('https://… or git@…') },
      onSubmit: (name, _checked, url) => {
        if (!url) {
          host.toast.error(t('A remote needs a URL.'));
          return;
        }
        void run({ kind: 'remote-add', name, url }).then((job) => {
          if (job) host.network('fetch');
        });
      },
    });
  };

  /**
   * Rename a remote, or point it somewhere else, or both: the URL first, so a
   * rename that is refused leaves the change that went through under the name
   * the user saw.
   * @param {string} remote - Its name.
   * @param {string} url - Its URL as read.
   * @param {Element} anchor - What asked.
   */
  const editRemote = (remote, url, anchor) => {
    askText(anchor, element, {
      label: t('Remote {name}', { name: remote }),
      value: remote,
      ok: t('Save'),
      secondary: { label: t('URL'), value: url },
      onSubmit: (name, _checked, nextUrl) => {
        void (async () => {
          if (nextUrl && nextUrl !== url && !await run({ kind: 'remote-set-url', remote, url: nextUrl })) return;
          if (name !== remote) await run({ kind: 'remote-rename', remote, name });
        })();
      },
    });
  };

  /**
   * Carry out one of the model's actions.
   * @param {{type: string, [field: string]: any}} a - The action.
   * @param {Element} anchor - The control it came from, for what it asks.
   */
  const act = (a, anchor) => {
    const workspaces = host.workspaces();
    switch (a.type) {
      case 'refresh': host.refreshAll(); break;
      case 'network': host.network(a.kind); break;
      case 'log': host.toggleLog(); break;
      case 'follow': host.toggleFollow(); break;
      case 'switch': switchTo(a.op, a.name, anchor); break;
      case 'new-worktree':
        void workspaces?.create({ providerId: 'git-worktree', ...(a.values ? { values: a.values } : {}) })
          .then(() => readAll()).catch((e) => host.toast.error(errorText(e)));
        break;
      case 'merge':
        confirmAction(anchor, element, {
          text: t('Merge {rev} into {branch}?', { rev: a.rev, branch: a.into }),
          ok: t('Merge'),
          tone: 'primary',
          check: { label: t('Always make a merge commit (no fast-forward)') },
          onConfirm: (noFF) => {
            void runPastChanges({ kind: 'merge', rev: a.rev, ...(noFF ? { mode: 'no-ff' } : {}) }, t('Stash them, then merge'));
          },
        });
        break;
      case 'squash-merge':
        askFirst(anchor, t('Squash {rev} into {branch}? Its changes are staged as one, for you to commit; no merge is recorded.', { rev: a.rev, branch: a.into }), t('Squash'), () => {
          void run({ kind: 'merge', rev: a.rev, mode: 'squash' }).then((job) => {
            if (!job) return;
            host.toast.show(t('Squashed {rev}: its changes are staged. Commit them to finish.', { rev: a.rev }), undefined,
              { label: t('Show them'), run: () => host.showChanges() });
          });
        });
        break;
      case 'rebase':
        askFirst(anchor, t('Rebase {branch} onto {rev}? Its own commits are rewritten on top of {rev}.', { rev: a.rev, branch: a.into }), t('Rebase'), () => {
          void runPastChanges({ kind: 'rebase', rev: a.rev }, t('Stash them, then rebase'));
        });
        break;
      case 'fast-forward':
        askFirst(anchor, t('Fast-forward {branch} to {upstream}?', { branch: a.branch, upstream: a.upstream }), t('Fast-forward'), () => {
          void run({ kind: 'fast-forward', branch: a.branch, expectSha: a.expectSha });
        });
        break;
      case 'rename':
        askText(anchor, element, {
          label: t('Rename {name}', { name: a.branch }),
          value: a.branch,
          ok: t('Rename'),
          onSubmit: (name) => { if (name !== a.branch) void run({ kind: 'branch-rename', branch: a.branch, name }); },
        });
        break;
      case 'upstream':
        askText(anchor, element, {
          label: t('Upstream of {name} (empty for none)', { name: a.branch }),
          value: a.upstream,
          // i18n-ignore: a git ref, shown as typed
          placeholder: `origin/${a.branch}`,
          ok: t('Set'),
          allowEmpty: true,
          onSubmit: (upstream) => { void run({ kind: 'branch-upstream', branch: a.branch, upstream }); },
        });
        break;
      case 'branch-delete':
        askDelete('branch', a.branch, a.expectSha, anchor, (force) => deleteBranch({ branch: a.branch, expectSha: a.expectSha }, anchor, force));
        break;
      case 'branch-create': {
        const viewed = viewedTree(state());
        askText(anchor, element, {
          label: t('New branch from {name}', { name: viewed?.tree.branch || (viewed?.tree.head || '').slice(0, 7) || 'HEAD' }),
          placeholder: t('branch name'),
          ok: t('Create and switch'),
          onSubmit: (name) => { void run({ kind: 'branch-create', name, switch: true }); },
        });
        break;
      }
      case 'tag-delete':
        askDelete('tag', a.name, a.target, anchor, () => {
          void run({ kind: 'tag-delete', name: a.name, expectSha: a.expectSha }).then((job) => {
            if (!job) return;
            const sha = job.result?.sha || a.expectSha;
            host.toast.show(t('Deleted tag {name}', { name: a.name }), () => {
              void run({ kind: 'ref-restore', ref: `refs/tags/${a.name}`, sha });
            });
          });
        });
        break;
      case 'push-tag':
        askFirst(anchor, a.remote ? t('Push tag {name} to {remote}?', { name: a.name, remote: a.remote }) : t('Push tag {name}?', { name: a.name }), t('Push'), () => {
          void run({ kind: 'push-tag', name: a.name, ...(a.remote ? { remote: a.remote } : {}) }).then((job) => {
            if (job) host.toast.show(t('Pushed tag {name}', { name: a.name }));
          });
        });
        break;
      case 'push-tags':
        askFirst(anchor, a.remote ? t('Push every tag to {remote}?', { remote: a.remote }) : t('Push every tag?'), t('Push all'), () => {
          void run({ kind: 'push-tags', ...(a.remote ? { remote: a.remote } : {}) }).then((job) => {
            if (job) host.toast.show(a.remote ? t('Pushed every tag to {remote}', { remote: a.remote }) : t('Pushed every tag'));
          });
        });
        break;
      case 'push-to': pushTo(a.branch, anchor); break;
      case 'remote-add': addRemote(anchor); break;
      case 'remote-edit': editRemote(a.remote, a.url, anchor); break;
      case 'remote-remove':
        confirmAction(anchor, element, {
          text: t('Remove the remote {name}? Its remote-tracking branches go with it, and branches tracking them lose their upstream. Nothing on the remote itself changes.', { name: a.remote }),
          title: t('Remove remote'),
          ok: t('Remove'),
          onConfirm: () => {
            void run({ kind: 'remote-remove', remote: a.remote }).then((job) => {
              if (job) host.toast.show(t('Removed the remote {name}', { name: a.remote }));
            });
          },
        });
        break;
      case 'view-stash': host.showScope(`${a.stash}^1..${a.stash}`); break;
      case 'submodule-update': void updateSubmodule((op) => run(op), host.toast, host.repo(), a.path); break;
      case 'open-repo': {
        const repo = host.repo();
        host.showRepo(repo ? `${repo}/${a.path}` : a.path);
        break;
      }
      case 'show-history': host.showHistory({ sha: a.sha, ...(a.stash !== undefined ? { stash: a.stash } : {}) }); break;
      case 'stash-apply':
      case 'stash-pop':
        askFirst(anchor, a.type === 'stash-pop'
          ? t('Apply “{message}” to the working tree, and drop it from the stashes?', { message: a.message })
          : t('Apply “{message}” to the working tree? The stash is kept.', { message: a.message }),
        a.type === 'stash-pop' ? t('Pop') : t('Apply'), () => { void run({ kind: a.type, stash: a.stash }); });
        break;
      case 'stash-branch':
        askText(anchor, element, {
          label: t('New branch from this stash'),
          placeholder: t('branch name'),
          ok: t('Create'),
          onSubmit: (name) => { void run({ kind: 'stash-branch', stash: a.stash, name }); },
        });
        break;
      case 'stash-drop':
        void run({ kind: 'stash-drop', stash: a.stash }).then((job) => {
          if (!job) return;
          const stash = job.result?.stash || a.stash;
          const message = job.result?.message ?? a.message;
          host.toast.show(t('Dropped “{message}”', { message }), () => {
            void run({ kind: 'stash-store', stash, message });
          });
        });
        break;
      case 'stash-save':
        askText(anchor, element, {
          label: t('Stash all changes'),
          placeholder: t('Message (optional)'),
          ok: t('Stash'),
          allowEmpty: true,
          check: t('Include untracked files'),
          onSubmit: (message, untracked) => {
            void run({ kind: 'stash-save', ...(message ? { message } : {}), untracked });
          },
        });
        break;
      case 'view-tree': {
        const view = treeAt(state(), a.path);
        if (view && typeof view.viewId === 'string') host.viewTree(view);
        break;
      }
      case 'show-conversation': void workspaces?.showConversation(a.id); break;
      case 'finish':
        void Promise.resolve(workspaces?.finish(a.id, a.option)).then(() => readAll())
          .catch((e) => host.toast.error(errorText(e)));
        break;
      case 'adopt':
        void Promise.resolve(workspaces?.adopt({ path: a.path, branch: a.branch })).then((result) => {
          if (result === null) host.toast.show(t('No workspace provider offers this worktree.'));
          readAll();
        }).catch((e) => host.toast.error(errorText(e)));
        break;
      case 'lock': void run({ kind: 'worktree-lock', worktree: a.path }); break;
      case 'unlock': void run({ kind: 'worktree-unlock', worktree: a.path }); break;
      case 'remove-tree': removeTree(a.path, a.dirty, a.locked, anchor); break;
      case 'prune':
        askFirst(anchor, t('Prune the worktrees whose folders are gone? Only git’s records of them are removed.'), t('Prune'), () => {
          void run({ kind: 'worktree-prune' });
        });
        break;
      default: break;
    }
  };

  /**
   * @param {string} ctx - What the menu is on.
   * @param {string} key - Its key.
   * @param {number} x - Where.
   * @param {number} y - Where.
   * @param {Element} anchor - What it hangs off.
   */
  const openMenu = (ctx, key, x, y, anchor) => {
    openMenuAt(menuRows(menuFor(/** @type {any} */ (ctx), key, state()), (a) => act(a, anchor)), x, y, anchor);
  };

  // --- drawing -------------------------------------------------------------

  /**
   * @param {import('juggler/pinboard-item-type').PinGitSubmodules['submodules'][number]} m - A submodule.
   * @returns {string} Where it is against what is recorded for it, in a few words.
   */
  const submoduleState = (m) => {
    const recorded = m.recorded.slice(0, 7);
    switch (m.state) {
      case 'current': return t('at {sha}', { sha: recorded });
      case 'moved': return t('{head}, not {recorded}', { head: m.branch || (m.head || '').slice(0, 7), recorded });
      case 'uninitialized': return t('not checked out');
      default: return t('in conflict');
    }
  };

  /**
   * @param {string} cls - Its class.
   * @param {string} text - Its words.
   * @param {string} [title] - Its tooltip.
   * @returns {HTMLElement} A small label.
   */
  const span = (cls, text, title) => {
    const el = createElement('span', cls, text);
    if (title) el.title = title;
    return el;
  };

  /**
   * @param {import('./refs-model.js').RefRow} row - The row.
   * @param {RefsState} s - What is known.
   * @returns {HTMLElement} Its element.
   */
  const buildRow = (row, s) => {
    const el = createElement('div', 'git-refs__row');
    el.dataset.key = row.key;
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', String(row.key === selected));
    const name = createElement('span', 'git-refs__name text-truncate');
    if (row.ctx === 'wt') {
      /** @type {TreeView} */
      const v = row.entity;
      el.append(icon(v.tree.main ? 'repo' : 'wt'));
      name.append(span('git-refs__label', v.name),
        span('git-refs__dir', v.tree.branch && !v.tree.detached ? v.tree.branch : t('{sha} detached', { sha: v.tree.head.slice(0, 7) })));
      el.append(name);
      if (v.tree.locked) {
        const lock = icon('lock');
        el.append(span('git-refs__glyph', '', v.tree.lockReason || t('Locked')));
        /** @type {HTMLElement} */ (el.lastChild).append(lock);
      }
      if (v.tree.prunable) el.append(span('git-refs__chip', t('gone'), v.tree.pruneReason || ''));
      if (v.tree.dirty === null) el.append(span('git-refs__dirty', '?', t("Couldn't read its changes")));
      else if (v.tree.dirty > 0) el.append(span('git-refs__dirty', `●${v.tree.dirty}`, t('{count, plural, one {# changed file} other {# changed files}}', { count: v.tree.dirty })));
      const conversation = v.conversations[0];
      if (conversation) {
        const chip = span('git-refs__chip git-refs__chip--conv text-truncate', '', t('Juggler workspace — conversation'));
        chip.append(icon('chat'), document.createTextNode(conversation.title));
        el.append(chip);
      }
      if (v.tree.current) {
        const eye = span('git-refs__glyph git-refs__glyph--viewing', '', t('Viewing'));
        eye.append(icon('eye'));
        el.append(eye);
      }
    } else if (row.ctx === 'branch') {
      const b = row.entity;
      const viewed = viewedTree(s);
      const here = Boolean(b.head || (b.worktree && viewed && b.worktree === viewed.tree.path));
      el.append(span('git-refs__here', here ? '●' : '', here ? t('Checked out here') : ''));
      name.append(span('git-refs__label git-refs__mono', b.name));
      el.append(name);
      if (b.worktree && !here) {
        const where = treeAt(s, b.worktree)?.name || baseName(b.worktree);
        const chip = span('git-refs__chip', '', t('Checked out in {name}', { name: where }));
        chip.append(icon('wt'), document.createTextNode(where));
        el.append(chip);
      }
      if (b.gone) el.append(span('git-refs__chip', t('upstream gone')));
      const nums = [b.ahead ? `↑${b.ahead}` : '', b.behind ? `↓${b.behind}` : ''].filter(Boolean).join('');
      if (nums) el.append(span('git-refs__nums', nums));
    } else if (row.ctx === 'remote') {
      el.append(icon('cloud'));
      name.append(span('git-refs__label git-refs__mono', row.entity.branch.name));
      el.append(name);
    } else if (row.ctx === 'tag') {
      el.append(icon('tag'));
      name.append(span('git-refs__label git-refs__mono', row.entity.name));
      el.append(name);
    } else if (row.ctx === 'submodule') {
      el.append(icon('repo'));
      name.append(span('git-refs__label git-refs__mono', row.entity.path), span('git-refs__dir', submoduleState(row.entity)));
      el.append(name);
    } else {
      el.append(icon('stash'));
      name.append(span('git-refs__label', row.entity.message));
      el.append(name);
    }
    const more = /** @type {HTMLButtonElement} */ (createElement('button', 'git-refs__more btn btn-icon btn-xs', '⋯'));
    more.type = 'button';
    more.title = t('More');
    el.append(more);
    return el;
  };

  /**
   * @param {import('./refs-model.js').RefRow} row - A row.
   * @param {RefsState} s - What is known.
   * @returns {string} What its element is drawn from, beyond the selection.
   */
  const rowSig = (row, s) => {
    if (row.ctx === 'wt') {
      /** @type {TreeView} */
      const v = row.entity;
      return JSON.stringify([v.name, v.tree, v.conversations[0]?.title ?? '']);
    }
    if (row.ctx === 'branch') {
      const b = row.entity;
      return JSON.stringify([b, viewedTree(s)?.tree.path ?? '', b.worktree ? (treeAt(s, b.worktree)?.name ?? '') : '']);
    }
    return JSON.stringify(row.entity);
  };

  /**
   * Fold a section away, or open it again; the pin remembers which are folded.
   * @param {string} id - The section.
   * @param {boolean} fold - Fold it, rather than open it.
   */
  const setFolded = (id, fold) => {
    const next = new Set(host.folded());
    if (fold === next.has(id)) return;
    if (fold) next.add(id);
    else next.delete(id);
    host.setFolded([...next]);
    render();
  };

  const renderList = () => {
    const s = state();
    /** @type {{section: import('./refs-model.js').RefSection, rows: import('./refs-model.js').RefRow[]}[]} */
    const shown = [];
    let shownCount = 0;
    // A folded section keeps its header and drops its rows — unless the filter
    // is looking for something, which it finds in every section.
    const folded = new Set(filter.active() ? [] : host.folded());
    for (const section of sectionsOf(s)) {
      const rows = folded.has(section.id) ? [] : section.rows.filter((row) => filter.matches(rowName(row)));
      if (filter.active() && !rows.length) continue;
      shown.push({ section, rows });
      shownCount += rows.length;
    }
    /**
     * @param {import('./refs-model.js').RefSection} section - The section.
     * @returns {HTMLElement} Its header.
     */
    const buildSect = (section) => {
      const head = createElement('div', 'git-refs__sect');
      head.dataset.section = section.id;
      const fold = /** @type {HTMLButtonElement} */ (createElement('button', 'git-refs__fold'));
      fold.type = 'button';
      fold.setAttribute('aria-expanded', String(!folded.has(section.id)));
      fold.title = folded.has(section.id) ? t('Show {section}', { section: section.title }) : t('Hide {section}', { section: section.title });
      fold.append(icon('chev'), span('git-refs__title caps-label', section.title), span('git-refs__count', String(section.rows.length)));
      head.append(fold);
      const acts = createElement('span', 'git-refs__sect-acts');
      menuFor('section', section.id, s).forEach((item, at) => {
        const b = /** @type {HTMLButtonElement} */ (createElement('button', 'git-refs__sect-act', item.label || ''));
        b.type = 'button';
        b.disabled = Boolean(item.disabled);
        b.dataset.index = String(at);
        acts.append(b);
      });
      head.append(acts);
      return head;
    };
    /**
     * @param {import('./refs-model.js').RefSection} section - An open section with no rows.
     * @returns {string} What it says instead; '' for nothing.
     */
    const noneText = (section) => {
      if (section.rows.length || folded.has(section.id)) return '';
      if (section.id === 'stashes') return t('None');
      // The checkout in view is the only tree, once the trees are read.
      if (section.id === 'worktrees' && s.trees.length) return t('No other worktrees');
      return '';
    };
    /** @type {HTMLElement[]} */
    const children = [];
    /** @type {string[]} */
    const keys = [];
    if (shownCount > WINDOWED_ABOVE) {
      /** @type {import('juggler/utils/virtual-list').SectionItem[]} */
      const items = [];
      itemIndex = new Map();
      for (const { section, rows } of shown) {
        const acts = menuFor('section', section.id, s).map((item) => [item.label, Boolean(item.disabled)]);
        itemIndex.set(`sect:${section.id}`, items.length);
        items.push({
          key: `sect:${JSON.stringify([section.id, section.title, section.rows.length, acts, folded.has(section.id)])}`,
          header: true,
          build: () => buildSect(section),
        });
        for (const row of rows) {
          keys.push(row.key);
          itemIndex.set(row.key, items.length);
          items.push({ key: `${row.key}\u0000${rowSig(row, s)}`, header: false, row: row.key, build: () => buildRow(row, s) });
        }
        const none = noneText(section);
        if (none) items.push({ key: `none:${section.id}`, header: false, build: () => span('git-refs__none', none) });
      }
      windowed.setItems(items);
      children.push(windowed.spacer);
    } else {
      itemIndex = new Map();
      windowed.clear();
      for (const { section, rows } of shown) {
        children.push(buildSect(section));
        for (const row of rows) {
          keys.push(row.key);
          children.push(buildRow(row, s));
        }
        const none = noneText(section);
        if (none) children.push(span('git-refs__none', none));
      }
    }
    if (!refs) {
      children.push(createElement('div', 'git-refs__empty', readError
        ? t("Couldn't read the refs. {error}", { error: readError })
        : t('Checking…')));
    } else {
      if (!keys.length && filter.active()) children.push(createElement('div', 'git-refs__empty', t('Nothing matches')));
      if (refs.truncated) children.push(createElement('div', 'git-refs__error', t('More refs than are listed here.')));
      if (readError) children.push(createElement('div', 'git-refs__error', t("Couldn't refresh. {error}", { error: readError })));
    }
    order = keys;
    if (itemIndex.size && scroll.firstChild === windowed.spacer) {
      // The spacer stays put, so nothing drawn in it loses focus or hover.
      while (windowed.spacer.nextSibling) windowed.spacer.nextSibling.remove();
      scroll.append(...children.slice(1));
    } else {
      scroll.replaceChildren(...children);
    }
    if (itemIndex.size) windowed.render();
  };

  /**
   * @param {[string, string|Node][]} pairs - Terms and what they say.
   * @returns {HTMLElement} A description list.
   */
  const facts = (pairs) => {
    const dl = createElement('dl', 'git-refs__facts');
    for (const [term, value] of pairs) {
      const dd = createElement('dd');
      dd.append(value);
      dl.append(createElement('dt', '', term), dd);
    }
    return dl;
  };

  /**
   * A commit as the detail names it: its id, a link to it in History, and its subject.
   * @param {string} sha - A commit.
   * @param {string} subject - Its subject.
   * @returns {HTMLElement} Both, as one line.
   */
  const tip = (sha, subject) => {
    const line = createElement('span', 'git-refs__tip');
    const link = /** @type {HTMLButtonElement} */ (createElement('button', 'git-refs__sha', sha.slice(0, 7)));
    link.type = 'button';
    link.dataset.sha = sha;
    link.title = t('Show in History');
    line.append(link, document.createTextNode(subject));
    return line;
  };

  const renderDetail = () => {
    const s = state();
    const row = rowOf(s, selected);
    const sig = JSON.stringify([selected, row?.entity ?? null, row ? menuFor(row.ctx, row.key, s) : null]);
    if (sig === detailSig && detail.firstChild) return;
    detailSig = sig;
    const back = /** @type {HTMLButtonElement} */ (createElement('button', 'git-refs__back btn btn-icon btn-xs', '‹'));
    back.type = 'button';
    back.title = t('Back (esc)');
    const crumb = createElement('div', 'git-refs__crumb');
    crumb.append(back);
    if (!row) {
      detail.replaceChildren(crumb, createElement('div', 'git-refs__placeholder', t('Select a worktree, branch, tag or stash.')));
      return;
    }
    const title = createElement('span', 'git-refs__crumb-title text-truncate');
    crumb.append(title);
    const meta = createElement('div', 'git-refs__meta');
    if (row.ctx === 'wt') {
      /** @type {TreeView} */
      const v = row.entity;
      const tree = v.tree;
      title.append(icon(tree.main ? 'repo' : 'wt'), span('git-refs__label', v.name));
      /** @type {string[]} */
      const st = [];
      st.push(tree.dirty === null ? t("couldn't read its changes")
        : tree.dirty ? t('{count, plural, one {# changed file} other {# changed files}}', { count: tree.dirty }) : t('clean'));
      if (tree.upstream) st.push(t('↑{ahead} ↓{behind} {upstream}', { ahead: tree.ahead, behind: tree.behind, upstream: tree.upstream }));
      if (tree.operation) {
        st.push(t('{operation, select, merge {merge in progress} rebase {rebase in progress} cherry-pick {cherry-pick in progress} other {revert in progress}}', { operation: tree.operation }));
      }
      if (tree.locked) st.push(tree.lockReason ? t('locked: {reason}', { reason: tree.lockReason }) : t('locked'));
      if (tree.prunable) st.push(tree.pruneReason ? t('gone: {reason}', { reason: tree.pruneReason }) : t('gone'));
      const juggler = tree.main ? t('the project tree')
        : v.workspace ? (v.conversations.length
          ? t('workspace · {titles}', { titles: v.conversations.map((c) => c.title).join(', ') }) : t('workspace'))
          : v.otherWorkspace ? t('workspace') : t('not a workspace');
      meta.append(facts([
        [t('Path'), tree.path],
        [t('HEAD'), tree.branch && !tree.detached ? tree.branch : t('{sha} (detached)', { sha: tree.head.slice(0, 7) })],
        [t('State'), st.join(' · ')],
        [t('Juggler'), juggler],
      ]));
    } else if (row.ctx === 'branch') {
      const b = row.entity;
      title.append(icon('branch'), span('git-refs__label git-refs__mono', b.name));
      const where = b.worktree ? (treeAt(s, b.worktree)?.name || baseName(b.worktree)) : '';
      meta.append(facts([
        [t('Tip'), tip(b.sha, b.subject)],
        [t('Checked out'), where ? (b.head ? t('{name} (viewing)', { name: where }) : where) : t('nowhere')],
        [t('Upstream'), b.upstream
          ? (b.gone ? t('{upstream} (gone)', { upstream: b.upstream })
            : t('{upstream} · ↑{ahead} ↓{behind}', { upstream: b.upstream, ahead: b.ahead, behind: b.behind }))
          : t('none')],
      ]));
    } else if (row.ctx === 'remote') {
      const r = row.entity;
      title.append(icon('cloud'), span('git-refs__label git-refs__mono', `${r.remote}/${r.branch.name}`));
      meta.append(facts([[t('Tip'), tip(r.branch.sha, r.branch.subject)]]));
    } else if (row.ctx === 'submodule') {
      const m = row.entity;
      title.append(icon('repo'), span('git-refs__label git-refs__mono', m.path));
      meta.append(facts([
        [t('State'), submoduleState(m)],
        [t('Recorded'), span('git-refs__mono', m.recorded.slice(0, 7))],
        [t('HEAD'), m.head
          ? span('git-refs__mono', m.branch ? `${m.branch} · ${m.head.slice(0, 7)}` : m.head.slice(0, 7))
          : t('not checked out')],
        [t('URL'), m.url],
      ]));
    } else if (row.ctx === 'tag') {
      const tag = row.entity;
      title.append(icon('tag'), span('git-refs__label git-refs__mono', tag.name));
      meta.append(facts([
        [t('Commit'), tip(tag.target, tag.subject)],
        [t('Kind'), tag.annotated ? t('annotated') : t('lightweight')],
      ]));
    } else {
      const st = row.entity;
      title.append(icon('stash'), span('git-refs__label git-refs__mono', st.sha.slice(0, 7)));
      meta.append(createElement('div', 'git-refs__message', st.message));
    }
    const acts = createElement('div', 'git-refs__acts');
    menuFor(row.ctx, row.key, s).forEach((item) => {
      if (item.separator) return;
      if (item.header) {
        acts.append(span('git-refs__acts-head caps-label', item.label || ''));
        return;
      }
      const b = /** @type {HTMLButtonElement} */ (createElement('button',
        `git-refs__act btn btn-xs ${item.danger ? 'btn-danger-quiet' : 'btn-neutral'}`, item.checked ? t('{label} ✓', { label: item.label || '' }) : item.label || ''));
      b.type = 'button';
      b.disabled = Boolean(item.disabled);
      if (item.action) b.dataset.action = item.action.type;
      if (item.hint) b.title = item.hint;
      b.addEventListener('click', () => { if (item.action) act(item.action, b); });
      acts.append(b);
    });
    meta.append(acts);
    detail.replaceChildren(crumb, meta);
  };

  const syncLevel = () => {
    if (element.dataset.level !== level) {
      element.dataset.level = level;
      host.levelChanged();
    }
  };

  /**
   * @param {'list'|'detail'} next - The pane stack mode shows.
   */
  const setLevel = (next) => {
    level = next;
    syncLevel();
  };

  const render = () => {
    if (!live) return;
    renderList();
    switcher?.update();
    const sectionAt = reveal ? itemIndex.get(`sect:${reveal}`) : undefined;
    if (sectionAt !== undefined) {
      reveal = null;
      windowed.scrollIntoView(sectionAt, 'start');
    } else if (reveal) {
      const section = scroll.querySelector(`.git-refs__sect[data-section="${reveal}"]`);
      if (section) {
        reveal = null;
        section.scrollIntoView?.({ block: 'start' });
      }
    }
    if (selected && !rowOf(state(), selected)) {
      selected = null;
      setLevel('list');
    }
    renderDetail();
  };

  // --- selection and keys --------------------------------------------------

  /**
   * @param {string|null} key - The row.
   * @param {boolean} [open] - Push the detail too.
   */
  const select = (key, open = false) => {
    selected = key;
    const at = key ? itemIndex.get(key) : undefined;
    if (at !== undefined) {
      windowed.scrollIntoView(at);
      renderDetail();
      if (open) setLevel('detail');
      return;
    }
    for (const row of scroll.querySelectorAll('.git-refs__row')) {
      row.setAttribute('aria-selected', String(row.getAttribute('data-key') === key));
      if (row.getAttribute('data-key') === key) row.scrollIntoView?.({ block: 'nearest' });
    }
    renderDetail();
    if (open) setLevel('detail');
  };

  /**
   * @param {number} by - Rows to move, down positive.
   */
  const move = (by) => {
    if (!order.length) return;
    const at = selected ? order.indexOf(selected) : -1;
    select(order[at < 0 ? 0 : Math.max(0, Math.min(order.length - 1, at + by))] ?? null);
  };

  /**
   * A sidebar row was clicked: go to what it names. A stash's changes are
   * reviewed and a submodule is opened as the repository, so nothing in the
   * sidebar leads to the Refs place, which a full pin never shows.
   * @param {string} key - The row.
   * @param {Element} anchor - The row's element.
   */
  const pick = (key, anchor) => {
    const row = rowOf(state(), key);
    if (!row) return;
    switch (row.ctx) {
      case 'wt':
        if (typeof row.entity.viewId === 'string') host.viewTree(row.entity);
        break;
      case 'branch': host.showHistory({ sha: row.entity.sha }); break;
      case 'remote': host.showHistory({ sha: row.entity.branch.sha }); break;
      case 'tag': host.showHistory({ sha: row.entity.target }); break;
      case 'stash': act({ type: 'view-stash', stash: row.entity.sha }, anchor); break;
      case 'submodule': act({ type: 'open-repo', path: row.entity.path }, anchor); break;
    }
  };

  scroll.addEventListener('click', (event) => {
    const target = /** @type {Element} */ (event.target);
    const fold = target.closest('.git-refs__fold');
    if (fold) {
      const id = fold.closest('.git-refs__sect')?.getAttribute('data-section') || '';
      if (id && !filter.active()) setFolded(id, fold.getAttribute('aria-expanded') === 'true');
      return;
    }
    const sectAct = target.closest('.git-refs__sect-act');
    if (sectAct instanceof HTMLElement) {
      const id = sectAct.closest('.git-refs__sect')?.getAttribute('data-section') || '';
      const item = menuFor('section', id, state())[Number(sectAct.dataset.index)];
      if (item?.action && !item.disabled) act(item.action, sectAct);
      return;
    }
    const row = target.closest('.git-refs__row');
    if (!(row instanceof HTMLElement)) return;
    const key = row.dataset.key || '';
    const more = target.closest('.git-refs__more');
    if (more) {
      const rect = more.getBoundingClientRect();
      const hit = rowOf(state(), key);
      if (hit) openMenu(hit.ctx, key, rect.left, rect.bottom, more);
    } else if (host.sidebar()) {
      // The row is marked as the one last acted on, as a right-click marks it,
      // so the mark follows the pointer rather than staying where a menu left it.
      select(key);
      pick(key, row);
    } else {
      select(key, true);
    }
  });
  // A double-click checks a branch out: a local one here — or, when it is out
  // in another tree, goes there — and a remote one as a local branch tracking
  // it. It is the row's first action, the one its menu leads with, and only
  // when that action is one of those.
  scroll.addEventListener('dblclick', (event) => {
    const target = /** @type {Element} */ (event.target);
    if (target.closest('.git-refs__more')) return;
    const row = target.closest('.git-refs__row');
    if (!(row instanceof HTMLElement)) return;
    const hit = rowOf(state(), row.dataset.key || '');
    if (!hit || (hit.ctx !== 'branch' && hit.ctx !== 'remote')) return;
    const first = menuFor(hit.ctx, hit.key, state())[0];
    if (!first?.action || first.disabled || (first.action.type !== 'switch' && first.action.type !== 'view-tree')) return;
    event.preventDefault();
    act(first.action, row);
  });
  const dropMenu = contextMenuFor(scroll, (target) => {
    const row = target.closest('.git-refs__row');
    if (!(row instanceof HTMLElement)) return null;
    const key = row.dataset.key || '';
    select(key);
    const hit = rowOf(state(), key);
    return hit ? menuRows(menuFor(hit.ctx, key, state()), (a) => act(a, row)) : null;
  });
  detail.addEventListener('click', (event) => {
    const target = /** @type {Element} */ (event.target);
    if (target.closest('.git-refs__back')) {
      setLevel('list');
      return;
    }
    const sha = target.closest('.git-refs__sha');
    if (sha instanceof HTMLElement && sha.dataset.sha) host.showHistory({ sha: sha.dataset.sha });
  });

  // --- the watch -----------------------------------------------------------

  // Off screen — another place shown, or beside one in a pin too narrow for
  // the sidebar — a change is only noted; coming on screen reads everything once.
  /** @type {''|'change'|'resync'} What came while the place was off screen. */
  let missed = '';
  const watchTree = () => git().watch((event) => {
    if (!live || !opened) return;
    if (!host.visible()) {
      if (event.type === 'git-resync') missed = 'resync';
      else if (event.type === 'git-change' && !missed) missed = 'change';
      return;
    }
    if (event.type === 'git-change') {
      const repo = host.repo();
      const mine = event.repos.find((r) => (r.path || '') === repo);
      if (mine && mine.kinds.some((k) => k === 'refs' || k === 'head')) readAll();
      else if (submodules.length && event.repos.some((r) => !repo || (r.path || '') === repo || (r.path || '').startsWith(`${repo}/`))) {
        submodulesReader.request();
      }
    } else if (event.type === 'git-resync') {
      readAll(true);
    }
  }, ws());
  let unwatch = watchTree();
  const unwatchWorkspaces = host.workspaces()?.onChange(() => {
    if (!live) return;
    if (opened) render();
    else switcher?.update();
  });

  return {
    element,
    shown: () => {
      opened = true;
      const caught = missed;
      missed = '';
      readAll(caught === 'resync');
    },
    refresh: () => readAll(),
    setTree: () => {
      if (!live) return;
      unwatch?.();
      unwatch = watchTree();
      refs = null;
      trees = [];
      submodules = [];
      readError = '';
      selected = null;
      setLevel('list');
      render();
      if (opened) readAll(true);
    },
    handleKey: (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return false;
      switch (event.key) {
        case 'j': case 'ArrowDown': move(1); return true;
        case 'k': case 'ArrowUp': move(-1); return true;
        case '/': filter.open(); return true;
        case 'Enter':
          if (!selected) return false;
          if (measureMode(host.rootElement) === 'stack') setLevel('detail');
          else /** @type {HTMLElement|null} */ (detail.querySelector('.git-refs__act:not(:disabled)'))?.focus();
          return true;
        case 'Escape':
          if (level === 'detail') {
            setLevel('list');
            return true;
          }
          return filter.close();
        default:
          return false;
      }
    },
    focus: () => scroll.focus(),
    openMenu: (ctx, anchor) => {
      const rect = anchor.getBoundingClientRect();
      openMenu(ctx, '', rect.left, rect.bottom, anchor);
    },
    act: (type, anchor) => act({ type, ...(type === 'new-worktree' ? { values: null } : {}) }, anchor),
    openSwitcher: (anchor) => {
      switcher = openWorktreeSwitcher(anchor, element, {
        trees: () => state().trees,
        following: () => host.following(),
        view: (view) => host.viewTree(view),
        switchBranch: () => {
          host.showRefs();
          if (host.folded().includes('branches')) host.setFolded(host.folded().filter((id) => id !== 'branches'));
          reveal = 'branches';
          selected = null;
          setLevel('list');
          render();
        },
        newWorktree: () => act({ type: 'new-worktree', values: null }, anchor),
        toggleFollow: () => host.toggleFollow(),
      });
      treesReader.request();
    },
    teardown: () => {
      live = false;
      closePopover();
      dropMenu();
      windowed.destroy();
      unwatch?.();
      unwatchWorkspaces?.();
    },
  };
}
