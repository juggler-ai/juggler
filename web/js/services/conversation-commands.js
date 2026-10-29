//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Conversation-level command operations, factored out as clean functions so
 * keyboard shortcuts (and any other trigger) invoke behaviour without embedding
 * logic in their key handlers.
 *
 * Create/bin route through the conversation bar's canonical methods (which own
 * the conversation cap, inline-rename, busy-guard and fly-to-bin UX) via a
 * document event, so a shortcut and a click share one code path. Jump owns the
 * interesting decision — which conversation needs you, and whether to land on a
 * pending approval or the end of the thread — and hands the mechanics to the
 * target tab.
 * @module services/conversation-commands
 */

import { getFlaggedConversationIds } from '../utils/attention-manager.js';
import { hasPendingApprovalInTree } from '../model/thread-navigation.js';
import { toggleFileEditing } from './file-editing-permission.js';
import { drawnConversationOrder } from './workspace-provisioning.js';

/**
 * Request creation of a new conversation (and switch to it). Handled by the
 * conversation bar, which enforces the conversation cap and opens inline rename.
 * @returns {void}
 */
export function createNewConversation() {
  document.dispatchEvent(new CustomEvent('juggler:new-conversation'));
}

/**
 * Request moving the currently-visible conversation to the bin. Handled by the
 * conversation bar, which applies the running-turn guard and the fly-to-bin
 * animation before the reversible move.
 * @returns {void}
 */
export function binActiveConversation() {
  document.dispatchEvent(new CustomEvent('juggler:bin-active-conversation'));
}

/**
 * Request inline rename of the currently-visible conversation. Handled by the
 * conversation bar, which opens the tab's inline name editor — the same UX a
 * click on the active tab produces.
 * @returns {void}
 */
export function renameActiveConversation() {
  document.dispatchEvent(new CustomEvent('juggler:rename-active-conversation'));
}

/**
 * Toggle file-editing permission for the currently-visible conversation.
 * @param {import('../model/session.js').default} session
 * @returns {boolean} True if there was a visible conversation to toggle.
 */
export function toggleActiveFileEditing(session) {
  const mt = session.getVisibleConversation()?.rootMessageThread;
  if (!mt) return false;
  toggleFileEditing(mt);
  return true;
}

/**
 * Whether a conversation currently needs the user: it's flagged with an unviewed
 * alert, or it is parked awaiting a tool approval.
 * @param {import('../model/session.js').default} session
 * @param {string} id
 * @returns {boolean} True when the conversation needs attention.
 */
function conversationNeedsAttention(session, id) {
  if (getFlaggedConversationIds().includes(id)) return true;
  const root = session.conversations.get(id)?.rootMessageThread;
  return !!root && hasPendingApprovalInTree(root.items);
}

/**
 * Whether a conversation has a live LLM turn in flight — actively streaming or
 * executing tools, as opposed to merely parked on an approval (which already
 * counts as attention, above). Mirrors the tab's green `.is-running` light, so
 * the fallback cycle visits exactly the tabs showing that indicator.
 * @param {import('../model/session.js').default} session
 * @param {string} id
 * @returns {boolean} True when the conversation's turn is actively running.
 */
function conversationIsRunning(session, id) {
  const conv = session.conversations.get(id);
  if (!conv?.isProcessing) return false;
  const root = conv.rootMessageThread;
  return !(root && hasPendingApprovalInTree(root.items));
}

/**
 * The next conversation satisfying `predicate`, cycling from the one on screen
 * so repeated presses visit each match in turn. Returns null when none match.
 * @param {import('../model/session.js').default} session
 * @param {(id: string) => boolean} predicate
 * @returns {string|null} A conversation id, or null.
 */
function nextConversationMatching(session, predicate) {
  const order = drawnConversationOrder(session);
  if (order.length === 0) return null;
  const start = order.indexOf(session.visibleConversationId ?? '');
  for (let step = 1; step <= order.length; step++) {
    const id = order[(start + step) % order.length];
    if (id && predicate(id)) return id;
  }
  return null;
}

/**
 * The next conversation needing attention, cycling from the one on screen so
 * repeated presses visit each in turn. Returns null when nothing needs you.
 * @param {import('../model/session.js').default} session
 * @returns {string|null} A conversation id, or null.
 */
function nextAttentionConversationId(session) {
  return nextConversationMatching(session, (id) => conversationNeedsAttention(session, id));
}

/**
 * Jump to the next conversation that wants you, in priority order:
 *  1. conversations needing attention (unviewed alert or a parked approval) —
 *     cycled so repeated presses visit each; landing selects the first pending
 *     approval or scrolls to the end of the thread.
 *  2. failing that, conversations with a live LLM turn in flight — cycled the
 *     same way, landing scrolls to the tail where the turn is streaming.
 * Returns false only when neither exists, so an inapplicable press falls through
 * (and doesn't retire the onboarding tip).
 * @param {import('../model/session.js').default} session
 * @returns {boolean} True if a conversation was found and shown.
 */
export function jumpToAttentionConversation(session) {
  const targetId =
    nextAttentionConversationId(session) ??
    nextConversationMatching(session, (id) => conversationIsRunning(session, id));
  if (!targetId) return false;

  const root = session.conversations.get(targetId)?.rootMessageThread;
  const selectApproval = !!root && hasPendingApprovalInTree(root.items);

  session.switchConversation(targetId);

  // The tab activates synchronously on switch, but its first render can be
  // deferred; reveal on the next frame and let the tab retry until its columns
  // are ready.
  const reveal = () => {
    const tab = /** @type {any} */ (document.querySelector('conversation-tab.active'));
    if (tab && typeof tab.revealAttention === 'function') tab.revealAttention(selectApproval);
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(reveal);
  else reveal();
  return true;
}
