//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * How the Git pin's places run a write and answer its failure: each write goes
 * through `git.run`, whose end every place hears as a change; a refusal
 * says what to do next — a ref that moved is read again, a branch out in
 * another tree offers that tree, conflicts offer Changes, and changes in the
 * way offer to stash them and try again. Every place's writes, Changes' too,
 * are answered here, so one failure reads alike wherever it happened (the
 * rules are pins/git/toast's).
 * @module pins/git/actions
 */

import { translator } from 'juggler/i18n';
import { errorText } from 'juggler/ui';
import { chooseAction } from './popover.js';
import { baseName } from './refs-model.js';

const t = translator('@juggler/core');

/**
 * @typedef {import('./refs-model.js').TreeView} TreeView
 * @typedef {import('../../lib/git-client.js').GitClient} GitClient
 * @typedef {import('../../lib/git-client.js').GitOp} GitOp
 * @typedef {import('../../lib/git-client.js').GitJob} GitJob
 */

/**
 * @typedef {object} ActionsHost
 * @property {() => GitClient} git - The pin's git service, as it now is.
 * @property {() => string} repo - The repository the pin shows.
 * @property {() => {workspace?: string}} workspaceOption - The tree option for every call.
 * @property {import('./toast.js').PinToast} toast - The pin's toast.
 * @property {HTMLElement} element - The place, where a question hangs when what asked has gone.
 * @property {() => boolean} live - Whether the place is still mounted.
 * @property {() => void} reread - Read what a write may have changed.
 * @property {() => number} dirty - The viewed tree's changed files.
 * @property {() => TreeView[]} trees - The worktrees, as last read.
 * @property {(tree: TreeView) => void} viewTree - Show that tree.
 */

/**
 * @typedef {object} PlaceActions
 * @property {(e: any) => void} explain - Say what a refused or failed write means, and offer the next step.
 * @property {(op: Record<string, any>, onError?: (e: any) => boolean) => Promise<GitJob|null>} run -
 *   Run one write (without its repository), then read again; `onError` takes a
 *   failure it understands. The finished job, or null when it failed.
 * @property {(op: Record<string, any>, retry: string) => Promise<GitJob|null>} runPastChanges -
 *   Run a write local changes can be in the way of, offering to stash them; `retry`
 *   is the words of the button that does.
 * @property {(op: Record<string, any>, name: string, anchor: Element) => void} switchTo -
 *   Switch the viewed tree, asking first what to do with its changes.
 */

/**
 * A model's items as a menu's rows: a header is a disabled row, and a
 * disabled row's reason goes in its label. A divider is drawn only between
 * two rows: the models put one between groups whether or not a group came out
 * empty.
 * @param {import('./refs-model.js').RefItem[]} items - The items.
 * @param {(action: {type: string, [field: string]: any}) => void} choose - Carries out a chosen row's action.
 * @returns {any[]} The rows.
 */
export function menuRows(items, choose) {
  const shown = items.filter((item, at) => !item.separator
    || (at > 0 && !items[at - 1]?.separator && items.slice(at + 1).some((after) => !after.separator)));
  return shown.map((item) => {
    if (item.separator) return { separator: true };
    if (item.header) return { label: item.label, disabled: true };
    let label = item.label || '';
    if (item.disabled && item.hint) label = t('{label} — {hint}', { label, hint: item.hint });
    return {
      label,
      disabled: item.disabled,
      danger: item.danger,
      checked: item.checked,
      onClick: () => { if (item.action) choose(item.action); },
    };
  });
}

/**
 * Check a submodule out at the commit its repository records, and offer to
 * put it back where it was: the update leaves the branch it had out alone, so
 * switching the submodule's own repository back to that branch — or that
 * commit, detached — undoes it. One that was not checked out has nowhere to go
 * back to.
 * @param {(op: Record<string, any>) => Promise<GitJob|null>} run - Runs one
 *   write, saying why when it fails; the finished job, or null.
 * @param {import('./toast.js').PinToast} toast - The pin's toast.
 * @param {string} repo - The repository whose submodule it is.
 * @param {string} path - The submodule's path within it.
 * @returns {Promise<void>} Settles once the update has ended.
 */
export async function updateSubmodule(run, toast, repo, path) {
  const job = await run({ kind: 'submodule-update', repo, path });
  if (!job) return;
  const { sha = '', branch = '' } = job.result || {};
  const own = repo ? `${repo}/${path}` : path;
  toast.show(t('Updated submodule {name}', { name: path }), sha ? () => {
    void run(branch ? { kind: 'switch', repo: own, branch } : { kind: 'switch', repo: own, rev: sha, detach: true });
  } : undefined);
}

/**
 * @param {ActionsHost} host - What the actions work through.
 * @returns {PlaceActions} The actions.
 */
export function createActions(host) {
  /** @type {PlaceActions['explain']} */
  const explain = (e) => {
    const kind = e?.kind;
    if (kind === 'stale') {
      host.reread();
      host.toast.error(t('That changed since this list was read, so nothing was done. Here it is as it is now.'));
    } else if (kind === 'checked-out') {
      const path = e.job?.worktree || '';
      const view = host.trees().find((v) => v.tree.path === path);
      const name = view?.name || baseName(path);
      host.toast.error(t('{branch} is checked out in {name}', { branch: e.job?.branch || '', name }),
        view && typeof view.viewId === 'string'
          ? { label: t('Go to worktree “{name}”', { name }), run: () => host.viewTree(view) }
          : undefined);
    } else if (kind === 'conflicts') {
      // The banner says so, with what to do about them, once the tree is read again.
    } else {
      host.toast.error(errorText(e));
    }
  };

  // What a write changed is read again by every place once it ends: the pin's
  // git service tells them all (tree-events.js), so a run does not reread here.
  /** @type {PlaceActions['run']} */
  const run = async (op, onError) => {
    // Another write: what the toast said about the last one has had its say.
    host.toast.userActed();
    try {
      return await host.git().run(/** @type {GitOp} */ ({ repo: host.repo(), ...op }), host.workspaceOption());
    } catch (e) {
      if (host.live() && !onError?.(e)) explain(e);
      return null;
    }
  };

  /** @type {PlaceActions['runPastChanges']} */
  const runPastChanges = (op, retry) => run(op, (e) => {
    if (e?.kind !== 'dirty') return false;
    host.toast.error(t('Your changes are in the way.'), {
      label: retry,
      run: () => { void runPastChanges({ ...op, dirty: 'stash' }, retry); },
    });
    return true;
  });

  /** @type {PlaceActions['switchTo']} */
  const switchTo = (op, name, anchor) => {
    /**
     * @param {'carry'|'stash'|null} dirty - What to do with the changes.
     */
    const go = (dirty) => {
      void runPastChanges({ kind: 'switch', ...op, ...(dirty ? { dirty } : {}) }, t('Stash them, then switch'))
        .then((job) => {
          if (job?.result?.stash) host.toast.show(t('Switched to {name}. Your changes are in a stash.', { name }));
        });
    };
    const changed = host.dirty();
    if (changed > 0) {
      chooseAction(anchor, host.element, {
        title: t('Switch to {name} with {count, plural, one {# changed file} other {# changed files}}', { name, count: changed }),
        choices: [
          { id: 'carry', label: t('Bring the changes along') },
          { id: 'stash', label: t('Stash them, then switch') },
        ],
        onChoose: (id) => go(id === 'stash' ? 'stash' : 'carry'),
      });
    } else {
      go(null);
    }
  };

  return { explain, run, runPastChanges, switchTo };
}
