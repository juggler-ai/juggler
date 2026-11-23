//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The commit box's Auto-generate: the menu of where to write the message from
 * and what happens once one is picked.
 *
 * The menu lists the conversations that made what is staged, best first (read
 * when it opens, behind a loading row), then the staged diff alone, an agent
 * that explores the changes, and Discuss, which opens a visible conversation
 * seeded with the same context and leaves the field alone. Picking any other
 * source writes the message: Auto-generate becomes Stop, the line under the
 * field shows the agent's progress, and the result replaces the field's text —
 * with Undo on the pin's toast when there was text to replace. A failure is
 * said quietly on that line and the text is left as it was.
 *
 * The generator is made afresh for each pick, so it reads the commit context
 * as it is at that moment, for the Amend the box has ticked then.
 * @module pins/git/generate-menu
 */

import { translator } from 'juggler/i18n';
import { attachMenuKeyboard, createElement, errorText, presentPopup } from 'juggler/ui';
import { createGenerator } from './commit-generate.js';

const t = translator('@juggler/core');

/**
 * @typedef {object} GenerateHost
 * @property {import('./commit-box.js').CommitBox} box - The commit box.
 * @property {() => import('../../lib/git-client.js').GitClient} git - The pin's git service.
 * @property {() => {workspace?: string}} workspaceOption - The tree option for every call.
 * @property {() => string} repo - The repository shown, '' for the root.
 * @property {() => string} root - The tree's absolute path.
 * @property {() => string} treeKey - The tree's workspace id, '' for the project.
 * @property {() => string} conversationId - The visible conversation, '' for none.
 * @property {() => import('juggler/pinboard-item-type').PinWorkspaces|undefined} workspaces - The session's workspaces.
 * @property {import('./toast.js').PinToast} toast - The pin's toast.
 */

/**
 * @typedef {{conv: string, title: string, strong: number, weak: number, prior: number, files: string[]}} Attributed
 */

/**
 * @typedef {object} GenerateControl
 * @property {(anchor: HTMLElement) => void} open - Open the menu off `anchor`.
 * @property {() => void} stop - Stop the message being written.
 * @property {() => void} teardown - Stop everything.
 */

/**
 * @param {GenerateHost} host - What it works through.
 * @returns {GenerateControl} The control.
 */
export function createGenerateControl(host) {
  const { box } = host;
  /** @type {(() => void)|null} */
  let releaseMenu = null;
  /** @type {AbortController|null} */
  let menuAbort = null;
  /** @type {AbortController|null} */
  let running = null;
  /** @type {Attributed[]} The last attribution read, best first. */
  let attributed = [];

  const opts = () => ({ repo: host.repo(), ...host.workspaceOption() });

  const closeMenu = () => {
    const release = releaseMenu;
    releaseMenu = null;
    menuAbort?.abort();
    menuAbort = null;
    release?.();
  };

  /** @returns {string} The repository's absolute path. */
  const repoPath = () => {
    const root = host.root().replace(/\/+$/, '');
    return host.repo() ? `${root}/${host.repo()}` : root;
  };

  const generator = () => createGenerator({
    commitContext: (amend, signal) => /** @type {Promise<any>} */ (host.git().read('commit-context', { ...opts(), amend, signal })),
    digest: (conv, paths, signal) => host.git().digest(conv, paths, { ...opts(), signal }),
    amend: () => box.request().amend,
    repoPath,
    workspaceId: () => host.treeKey(),
  });

  /**
   * @param {any} e - The failure.
   * @returns {string} The line that says so.
   */
  const failure = (e) => t('Couldn’t generate: {reason}', {
    reason: e?.busy ? t('the model is busy, try again') : errorText(e),
  });

  /**
   * Write the message from one source.
   * @param {import('./commit-generate.js').GenerateSource} source - Where from.
   * @param {string} label - The line that says so once it is in.
   */
  const run = async (source, label) => {
    running?.abort();
    const abort = new AbortController();
    running = abort;
    const before = box.request().message;
    box.setGenerating(true);
    box.setSourceLine(t('Generating…'), 'progress');
    try {
      const message = await generator().generate(source, {
        signal: abort.signal,
        onProgress: (line) => { if (running === abort) box.setSourceLine(line, 'progress'); },
      });
      if (running !== abort) return;
      box.replaceMessage(message);
      box.setSourceLine(label, 'source');
      if (before.trim()) {
        host.toast.show(t('Replaced the message with a generated one'), () => {
          box.replaceMessage(before);
          box.setSourceLine('');
        });
      }
    } catch (/** @type {any} */ e) {
      if (running !== abort) return;
      if (e?.name === 'AbortError') box.setSourceLine('');
      else box.setSourceLine(failure(e), 'error');
    } finally {
      if (running === abort) {
        running = null;
        box.setGenerating(false);
      }
    }
  };

  /** Open a visible conversation asked to help with the message. */
  const discuss = async () => {
    const best = attributed[0] ? { conv: attributed[0].conv, files: attributed[0].files } : null;
    try {
      const message = await generator().discussMessage(best);
      const workspaces = host.workspaces();
      if (!workspaces?.startConversation) throw new Error(t('Conversations can’t be started from here.'));
      await workspaces.startConversation({ message, name: t('Commit message'), workspace: host.treeKey() });
    } catch (/** @type {any} */ e) {
      box.setSourceLine(failure(e), 'error');
    }
  };

  /**
   * @param {string} source - The row's `data-source`.
   * @param {string} label - Its words.
   * @param {string} [meta] - Its second, quieter part.
   * @returns {HTMLButtonElement} A row.
   */
  const row = (source, label, meta) => {
    const b = /** @type {HTMLButtonElement} */ (createElement('button', 'menu-item git-gen-menu__item'));
    b.type = 'button';
    b.dataset.source = source;
    b.setAttribute('role', 'menuitem');
    b.append(createElement('span', 'git-gen-menu__label text-truncate', label));
    if (meta) b.append(createElement('span', 'git-gen-menu__meta', meta));
    return b;
  };

  /**
   * Draw the rows: the conversations, or the loading row while they are read.
   * @param {HTMLElement} list - The menu's list.
   * @param {{staged: number, conversations: Attributed[]}|null} read - The attribution, null while it is out.
   */
  const drawRows = (list, read) => {
    /** @type {HTMLElement[]} */
    const rows = [];
    if (!read) {
      const loading = row('', t('Finding the conversations that made it…'));
      loading.classList.add('git-gen-menu__loading');
      loading.disabled = true;
      delete loading.dataset.source;
      rows.push(loading);
    } else if (read.conversations.length) {
      const caption = createElement('div', 'menu-header menu-header-plain caps-label', t('From the conversation that made it'));
      caption.setAttribute('role', 'none');
      rows.push(caption);
      for (const c of read.conversations) {
        rows.push(row(`conv:${c.conv}`, c.title || c.conv,
          t('made {count} of {total} staged', { count: c.files.length, total: read.staged })));
      }
    }
    if (rows.length) rows.push(createElement('div', 'menu-divider'));
    rows.push(row('diff', t('The staged diff alone')),
      row('explore', t('An agent that explores the changes')),
      createElement('div', 'menu-divider'),
      row('discuss', t('Discuss in a new conversation…')));
    list.replaceChildren(...rows);
  };

  /**
   * @param {string} source - The picked row's `data-source`.
   */
  const pick = (source) => {
    closeMenu();
    if (source === 'diff') void run({ kind: 'diff' }, t('Generated from the staged diff'));
    else if (source === 'explore') void run({ kind: 'explore' }, t('Generated from an exploring agent'));
    else if (source === 'discuss') void discuss();
    else if (source.startsWith('conv:')) {
      const c = attributed.find((a) => `conv:${a.conv}` === source);
      if (c) void run({ kind: 'conv', conv: c.conv, title: c.title, files: c.files }, t('Generated from “{title}”', { title: c.title || c.conv }));
    }
  };

  /** @param {HTMLElement} anchor - What asked. */
  const open = (anchor) => {
    if (releaseMenu) {
      closeMenu();
      return;
    }
    if (running || !box.canGenerate()) return;
    const surface = createElement('nav', 'dropdown-menu git-gen-menu is-open');
    const list = createElement('div', 'git-gen-menu__list');
    list.setAttribute('role', 'menu');
    list.setAttribute('aria-label', t('Generate the message from'));
    surface.append(list);
    attributed = [];
    drawRows(list, null);
    const release = presentPopup({
      surface,
      anchor,
      id: 'git-gen-menu',
      onClose: () => { if (releaseMenu === release) closeMenu(); },
      insideSelectors: [surface, '.git-commit__gen', '.git-commit__source'],
      // Inside the commit popover when the box is in one, which then stays open.
      nested: 'auto',
    });
    releaseMenu = release;
    surface.addEventListener('click', (event) => {
      const target = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (event.target).closest('[data-source]'));
      if (target && !(/** @type {HTMLButtonElement} */ (target).disabled)) pick(target.dataset.source || '');
    });
    surface.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
        anchor.focus();
      }
    });
    attachMenuKeyboard(list, { close: closeMenu });

    const abort = new AbortController();
    menuAbort = abort;
    const amend = box.request().amend;
    void /** @type {Promise<any>} */ (host.git().read('attribution', { ...opts(), amend, conv: host.conversationId(), signal: abort.signal }))
      .then((read) => {
        if (abort.signal.aborted) return;
        attributed = read?.conversations || [];
        drawRows(list, { staged: read?.staged || 0, conversations: attributed });
      })
      .catch(() => {
        if (abort.signal.aborted) return;
        drawRows(list, { staged: 0, conversations: [] });
      });
  };

  return {
    open,
    stop: () => running?.abort(),
    teardown: () => {
      closeMenu();
      running?.abort();
      running = null;
    },
  };
}
