//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The worktree switcher the Git pin's branch button opens: every tree of the
 * repository the pin can show — its name, its branch or detached commit, its
 * changes, the conversation working in it, and which one is in view — then
 * Switch branch here…, New worktree… and Follow the conversation's workspace.
 *
 * Picking a tree fixes the pin to it; Follow undoes that. It draws what it is
 * given and is drawn again (`update`) when a fresh worktree read arrives.
 * @module pins/git/worktree-switcher
 */

import { translator } from 'juggler/i18n';
import { createElement } from 'juggler/ui';
import { icon } from './icons.js';
import { closePopover, openPopover } from './popover.js';

const t = translator('@juggler/core');

/**
 * @typedef {import('./refs-model.js').TreeView} TreeView
 */

/**
 * @typedef {object} SwitcherHost
 * @property {() => TreeView[]} trees - The trees as last read, annotated.
 * @property {() => boolean} following - Whether the pin follows the conversation's workspace.
 * @property {(tree: TreeView) => void} view - Fix the pin to this tree.
 * @property {() => void} switchBranch - Show the branches, to check one out here.
 * @property {() => void} newWorktree - Start a new git-worktree workspace.
 * @property {() => void} toggleFollow - Follow, or stop following.
 */

/**
 * @param {TreeView} v - A tree.
 * @returns {string} Its changes in a glyph: ●N, ✓ when clean, ? when unknown.
 */
function changesMark(v) {
  if (v.tree.dirty === null) return '?';
  return v.tree.dirty ? `●${v.tree.dirty}` : '✓';
}

/**
 * Open the switcher by its anchor.
 * @param {Element} anchor - The branch button.
 * @param {Element} fallback - Where to hang it if the anchor has gone.
 * @param {SwitcherHost} host - What it shows and does.
 * @returns {{update: () => void}} Redraw it, while it is open.
 */
export function openWorktreeSwitcher(anchor, fallback, host) {
  const surface = createElement('div', 'git-switcher');
  surface.setAttribute('role', 'menu');

  /**
   * @param {string} cls - Its class.
   * @param {string} [act] - Its `data-act`.
   * @returns {HTMLButtonElement} A row button.
   */
  const button = (cls, act) => {
    const b = /** @type {HTMLButtonElement} */ (createElement('button', cls));
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    if (act) b.dataset.act = act;
    return b;
  };

  const draw = () => {
    /** @type {HTMLElement[]} */
    const children = [createElement('div', 'git-pop__title', t('Worktrees'))];
    for (const v of host.trees()) {
      if (typeof v.viewId !== 'string') continue;
      const b = button('git-switcher__tree');
      b.dataset.path = v.tree.path;
      if (v.tree.current) b.setAttribute('aria-current', 'true');
      const line = createElement('span', 'git-switcher__line');
      line.append(icon(v.tree.main ? 'repo' : 'wt'), createElement('span', 'git-switcher__name text-truncate', v.name),
        createElement('span', 'git-switcher__mark', changesMark(v)));
      if (v.tree.current) {
        const eye = createElement('span', 'git-switcher__viewing');
        eye.title = t('Viewing');
        eye.append(icon('eye'));
        line.append(eye);
      }
      const sub = createElement('span', 'git-switcher__sub text-truncate');
      sub.append(createElement('span', 'git-switcher__head',
        v.tree.branch && !v.tree.detached ? v.tree.branch : t('{sha} detached', { sha: v.tree.head.slice(0, 7) })));
      const conversation = v.conversations[0];
      if (conversation) {
        const conv = createElement('span', 'git-switcher__conv');
        conv.append(icon('chat'), document.createTextNode(conversation.title));
        sub.append(conv);
      }
      b.append(line, sub);
      b.addEventListener('click', () => {
        closePopover();
        host.view(v);
      });
      children.push(b);
    }
    children.push(createElement('div', 'git-switcher__sep'));
    const branch = button('git-switcher__act', 'branch');
    branch.append(icon('branch'), document.createTextNode(t('Switch branch here…')));
    branch.addEventListener('click', () => {
      closePopover();
      host.switchBranch();
    });
    const fresh = button('git-switcher__act', 'new');
    fresh.append(icon('wt'), document.createTextNode(t('New worktree…')));
    fresh.addEventListener('click', () => {
      closePopover();
      host.newWorktree();
    });
    const follow = button('git-switcher__act', 'follow');
    follow.setAttribute('role', 'menuitemcheckbox');
    follow.setAttribute('aria-checked', String(host.following()));
    follow.append(createElement('span', '', t('Follow the conversation’s workspace')),
      createElement('span', 'git-switcher__check', host.following() ? '✓' : ''));
    follow.addEventListener('click', () => {
      closePopover();
      host.toggleFollow();
    });
    children.push(branch, fresh, createElement('div', 'git-switcher__sep'), follow);
    surface.replaceChildren(...children);
  };

  draw();
  openPopover(anchor, fallback, surface);
  /** @type {HTMLElement|null} */ (surface.querySelector('[aria-current="true"]') || surface.querySelector('button'))?.focus();
  return {
    update: () => {
      if (surface.isConnected) draw();
    },
  };
}
