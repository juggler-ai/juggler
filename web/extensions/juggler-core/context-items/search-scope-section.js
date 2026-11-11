//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The search-family plugins' "Search scope" permission-controls fragment: one
 * toggle for whether file search tools (grep, glob, tree) respect .gitignore.
 * The state lives in conversation metadata (see path-approval.js), so it syncs
 * to every peer. Search and Glob both contribute this section; the popup
 * deduplicates by `id`, so a single card renders whichever items are present.
 * @module juggler-core/context-items/search-scope-section
 */

import { translator } from 'juggler/i18n';
import { escapeHtml } from 'juggler/ui';
import {
  GITIGNORE_DISABLED_KEY,
  conversationGitignoreDisabled,
  setGitignoreDisabled,
} from './path-approval.js';

const t = translator('@juggler/core');

/** Material "check" glyph — shown when .gitignore is being respected. */
const TICK_SVG = '<svg viewBox="0 -960 960 960" aria-hidden="true"><path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z"/></svg>';
/** Material "close" glyph — shown when .gitignore is being ignored. */
const CROSS_SVG = '<svg viewBox="0 -960 960 960" aria-hidden="true"><path d="m256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z"/></svg>';

/**
 * Build the ".gitignore search scope" permission section for the popup. It has
 * no `title`, so the host renders no section heading — this is a rarely-needed
 * control and stays a single, self-describing tick/cross toggle line. A low
 * `order` floats its card up to sit just under "Allowed paths", above the
 * command-patterns section.
 * @param {import('../../../js/model/message-thread.js').MessageThread} messageThread - Owning thread
 * @returns {{id: string, order: number, element: HTMLElement, dispose: () => void}} Permission section
 */
export function buildGitignoreSection(messageThread) {
  const conversation = messageThread.conversation;

  const section = document.createElement('section');
  section.className = 'permission-section permission-section-search-scope';

  /** Render the toggle from current conversation metadata. */
  function render() {
    const respected = !conversationGitignoreDisabled(conversation);
    section.innerHTML = `
      <button class="permission-toggle-btn search-scope-btn ${respected ? 'allowed' : 'ask'}"
              role="switch" aria-checked="${respected ? 'true' : 'false'}"
              title="${escapeHtml(t('When on, file search tools (grep, glob, tree) skip files matched by .gitignore.'))}">
        <span class="permission-toggle-icon">${respected ? TICK_SVG : CROSS_SVG}</span>
        <span>${escapeHtml(respected ? t('Respecting .gitignore in file searches') : t('Searching all files (.gitignore off)'))}</span>
      </button>
    `;
    const btn = section.querySelector('.search-scope-btn');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setGitignoreDisabled(conversation, !conversationGitignoreDisabled(conversation));
      });
    }
  }

  /** @param {any} event */
  const observer = (event) => {
    if (event.keysChanged.has(GITIGNORE_DISABLED_KEY)) render();
  };
  conversation.observeMetadata(observer);

  render();
  return {
    id: 'search-scope',
    order: -1,
    element: section,
    dispose: () => {
      conversation.unobserveMetadata(observer);
    },
  };
}
