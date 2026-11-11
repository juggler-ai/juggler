//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Edit-family plugins' permission-controls UI fragment.
 * @module juggler-core/context-items/edit/permission-section
 */

import { translator } from 'juggler/i18n';
import { escapeHtml } from 'juggler/ui';
import {
  WRITE_FILE_ITEM_TYPE as ITEM_TYPE,
  isFileEditingAllowed,
  toggleFileEditing,
} from '../../../../js/services/file-editing-permission.js';

const t = translator('@juggler/core');

/** Material "check" glyph — shown when file editing is allowed. Matches the pill's CHECK_ICON. */
const TICK_SVG = '<svg viewBox="0 -960 960 960" aria-hidden="true"><path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z"/></svg>';
/** Material "lock" glyph — shown when each edit is gated behind a prompt. Matches the pill's LOCK_ICON. */
const LOCK_SVG = '<svg viewBox="0 -960 960 960" aria-hidden="true"><path d="M240-640h360v-80q0-50-35-85t-85-35q-50 0-85 35t-35 85h-80q0-83 58.5-141.5T480-920q83 0 141.5 58.5T680-720v80h40q33 0 56.5 23.5T800-560v400q0 33-23.5 56.5T720-80H240q-33 0-56.5-23.5T160-160v-400q0-33 23.5-56.5T240-640Zm0 480h480v-400H240v400Zm296.5-143.5Q560-327 560-360t-23.5-56.5Q513-440 480-440t-56.5 23.5Q400-393 400-360t23.5 56.5Q447-280 480-280t56.5-23.5ZM240-160v-400 400Z"/></svg>';

/**
 * @param {import('../../../../js/model/message-thread.js').MessageThread} messageThread Owning thread
 * @returns {{id: string, element: HTMLElement, dispose: () => void}} Permission section
 */
export function renderWriteFilePermissionSection(messageThread) {
  const section = document.createElement('section');
  section.className = 'permission-section permission-section-write-file';
  section.dataset.itemType = ITEM_TYPE;

  /** Render the toggle. Edit permission is intentionally scoped to this conversation only. */
  function render() {
    const allowed = isFileEditingAllowed(messageThread);
    section.innerHTML = `
      <button class="permission-btn input-ctrl-btn permission-toggle-btn write-file-btn ${allowed ? 'allowed' : 'ask'}"
              role="switch" aria-checked="${allowed ? 'true' : 'false'}"
              title="${escapeHtml(t('Toggle file write permission for this conversation. Writes outside the project and allowed paths always prompt.'))}" data-shortcut-id="toggle-file-editing">
        <span class="permission-toggle-icon">${allowed ? TICK_SVG : LOCK_SVG}</span>
        <span>${escapeHtml(allowed ? t('File editing allowed in allowed paths') : t('File edits prompt for confirmation'))}</span>
      </button>
    `;
    const btn = section.querySelector('.write-file-btn');
    if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); toggleFileEditing(messageThread); });
  }

  /** @param {any} event */
  const observer = (event) => {
    if (event.keysChanged.has('permissionRules') || event.keysChanged.has('conversationPermissionRules')) render();
  };
  messageThread.conversation.observeMetadata(observer);

  render();
  return {
    id: ITEM_TYPE,
    element: section,
    dispose: () => {
      messageThread.conversation.unobserveMetadata(observer);
    }
  };
}
