//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Whether a conversation's undo and redo may be taken right now — the one
 * answer the footer's Undo/Redo buttons (components/conversation-footer.js)
 * and the ⌘Z / ⇧⌘Z shortcuts (components/header-controls.js) both act on.
 * @module utils/conversation-history
 */
import { busyState } from '../model/processing-status.js';
import { markForTranslation } from '../../sdk/lib/i18n.js';

/**
 * @typedef {import('../model/conversation.js').default} Conversation
 */

/** What a button disabled by a running turn says, rather than its plain name. */
export const HISTORY_BUSY_TITLE = markForTranslation('Unavailable while the agent is running');

/**
 * Undo and redo roll the WHOLE document back, so one live run anywhere in it —
 * the root thread or any sub-thread, through LLM calls, tool execution and
 * approval waits — locks both out. Read from the worker's processingState in
 * the document (model/processing-status.js), not the local LLM state, so a
 * viewer that did not start the turn is locked out too.
 * @param {Conversation|null|undefined} conversation
 * @returns {{busy: boolean, canUndo: boolean, canRedo: boolean}} Whether a
 *   turn is running, and whether each step can be taken now.
 */
export function historyState(conversation) {
  if (!conversation) return { busy: false, canUndo: false, canRedo: false };
  const busy = busyState(conversation).turn;
  return {
    busy,
    canUndo: !busy && conversation.canUndo(),
    canRedo: !busy && conversation.canRedo(),
  };
}
