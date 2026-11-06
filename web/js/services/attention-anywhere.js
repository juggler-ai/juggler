//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ⇧⌘J: the next conversation waiting on the user in any project of this
 * machine — ⌘J's cross-project twin.
 *
 * It takes the first of what needs the user (needsAcross: waiting oldest
 * first, then failed), passing over the conversation already on screen. One
 * in this project is switched to here and
 * landed on as ⌘J lands; one in another project is gone to
 * (project-navigation's goTo). While the machine's feed is unavailable — a
 * server run on its own, or a stream not yet back — it is ⌘J.
 * @module services/attention-anywhere
 */

import { machineFeed } from './machine-feed.js';
import { goTo as navigate, ownProjectLink } from './project-navigation.js';
import { jumpToAttentionConversation, revealLinkedConversation } from './conversation-commands.js';

/**
 * @typedef {object} AnywhereDeps
 * @property {{available: boolean, needs: import('../utils/session-attention.js').Need[]}} [feed] - The machine's needs.
 * @property {string} [ownLink] - This project's link.
 * @property {(to: import('./project-navigation.js').Destination) => Promise<void>} [goTo] - Goes elsewhere.
 * @property {(session: any, id: string) => Promise<void>} [reveal] - Lands as ⌘J does.
 * @property {() => boolean} [fallback] - ⌘J, for when the feed is unavailable.
 */

/**
 * Go to the next conversation waiting on the user, in any project.
 * @param {any} session - This page's session.
 * @param {AnywhereDeps} [deps] - The page's own by default.
 * @returns {boolean} Whether there was one to go to; decided at once, as a
 *   key's handler must, with the going itself under way.
 */
export function jumpToAttentionAnywhere(session, {
  feed = machineFeed(),
  ownLink = ownProjectLink(),
  goTo = navigate,
  reveal = revealLinkedConversation,
  fallback = () => jumpToAttentionConversation(session),
} = {}) {
  if (!feed.available) return fallback();
  const onScreen = session?.visibleConversationId;
  const next = feed.needs.find((n) => !(n.s.link === ownLink && n.item.id === onScreen));
  if (!next) return false;
  if (next.s.link === ownLink) {
    if (!session?.conversations?.has(next.item.id)) return false;
    session.switchConversation(next.item.id);
    void reveal(session, next.item.id);
    return true;
  }
  void goTo({ link: next.s.link, project: next.s.project, sessionId: next.s.id, conversation: next.item.id, newWindow: false });
  return true;
}
