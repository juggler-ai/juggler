//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Renaming a conversation, in place over its tab.
 *
 * The editor itself is the shared one (utils/inline-rename.js); what is here is
 * everything true of a conversation and not of anything else that gets renamed —
 * when a rename is allowed at all, how long a name may be, what the server says
 * when it refuses one, and the offer to hand naming back to the model.
 * @module components/conversation-rename
 */

import { MAX_CONVERSATION_NAME_LENGTH } from '../utils/constants.js';
import { openInlineRename } from '../utils/inline-rename.js';
import { showAlert } from './modal-dialog.js';
import { errorText } from '../../sdk/lib/error-utils.js';
import { t } from '../../sdk/lib/i18n.js';

// How long a press of Auto-name shows the label on its own say-so. The server's
// `naming-started` replaces the mark with one of its own within a moment; this
// only bounds a request the worker quietly declined (Session.setAutoNaming).
const AUTO_NAME_PRESS_TIMEOUT_MS = 15_000;

/**
 * Open the rename editor for `conversation` over its tab.
 *
 * Does nothing for a conversation still loading. Renaming a stub would race the
 * worker's metadata: the rename writes to the doc, then the worker's first
 * metadata observer fires and clobbers the new name with the disk-loaded one.
 * The user waits until hydration finishes (the panel spinner makes this state
 * visible).
 * @param {HTMLElement} tab - The tab `<li>` the editor opens over.
 * @param {object} args
 * @param {import('../model/session.js').default} args.session - The conversation's session.
 * @param {import('../model/conversation.js').default} args.conversation - The conversation being renamed.
 * @param {string} [args.initialValue] - Seed value for the input, overriding
 *   the conversation's name. The new-tab flow passes the canonical name to avoid
 *   a refresh race where the input briefly shows the wrong value.
 * @param {() => void} args.onClose - Called once the editor has gone, however it
 *   went.
 * @returns {boolean} Whether the editor opened.
 */
export function openConversationRename(tab, { session, conversation, initialValue, onClose }) {
  if (conversation.loadState !== 'loaded') return false;

  openInlineRename(tab, {
    value: initialValue ?? conversation.name,
    // UI-level enforcement of the shared name-length cap: the browser blocks
    // further typed input at the limit. This editor backs both rename and the
    // "name a new conversation" flow, so both paths are covered here. The data
    // level (Session.renameConversation) is the backstop for paste/programmatic
    // input that can exceed maxlength.
    maxLength: MAX_CONVERSATION_NAME_LENGTH,

    commit: async (newName) => {
      try {
        await session.renameConversation(conversation.id, newName);
        return '';
      } catch (e) {
        const code = /** @type {any} */ (e)?.code;
        // A name already taken is the one refusal the user can answer, so it
        // is the one that keeps the editor open. A name the server calls
        // invalid closes it: the editor has nothing to add that the empty
        // result doesn't already say.
        if (code === 'COLLISION') {
          return t('“{name}” is already used by another conversation.', { name: newName });
        }
        if (code !== 'INVALID') {
          await showAlert(
            t("Couldn't rename the conversation: {error}", { error: errorText(e) }),
            t('Rename failed')
          );
        }
        return '';
      }
    },

    // "Auto-name": hand off to the model to name the tab from the first
    // message instead of typing a name. Only offered once the conversation has
    // a first user message to derive from — for a brand-new empty tab there's
    // nothing to name, and the request would be a server-side no-op, so the
    // button is omitted entirely (the empty actions row then collapses).
    // pointerdown preventDefault keeps focus on the input so the button press
    // doesn't trigger a blur→commit of the current (unchanged) value first. The
    // server renames + broadcasts, which updates the tab; we mark the tab as
    // being named and close the editor.
    actions: ({ close }) => {
      if (!conversation.hasAutoNameSource()) return null;
      const autoNameBtn = document.createElement('button');
      autoNameBtn.type = 'button';
      autoNameBtn.className = 'conversation-bar-tab-auto-name';
      autoNameBtn.textContent = t('Auto-name');
      autoNameBtn.title = t('Let the model name this conversation from your first message');
      autoNameBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); });
      autoNameBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // The user handed naming back to the model, so the tab's name is
        // provisional again — mark it before requesting, so a later /handoff of
        // this conversation stays eligible for a derived title.
        session.setNameIsProvisional(conversation.id, true);
        // Say so before the server does: its round trip is long enough for the
        // press to look like it did nothing. Marked ahead of close(), whose
        // render is the one that paints it.
        session.setAutoNaming(conversation.id, true, { timeoutMs: AUTO_NAME_PRESS_TIMEOUT_MS });
        session.requestAutoName(conversation.id);
        close();
      });
      return autoNameBtn;
    },

    onClose,
  });
  return true;
}
