//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Moving a conversation that has already started to another workspace.
 *
 * The binding itself is one write to the conversation's metadata, and almost
 * everything follows it for free: an operation travels by workspace id and the
 * server resolves it per call, so the tools, the allowed roots, the prompt's
 * environment block and the git surfaces are all looking at the new tree the
 * moment the write lands.
 *
 * What does not follow is whatever was read out of a tree and written into the
 * conversation at the time — the assistant files it was seeded with are frozen
 * snapshots, and a conversation moved to another tree would go on showing the
 * model the instructions of the tree it left. Deferring initialisation exists to
 * stop a conversation being seeded from the wrong tree; a move is the one thing
 * that can put it back into that state.
 *
 * The folder grants are frozen in the same way and for the same reason: "allow
 * this folder" stores the absolute path it was given. Those have to be rewritten
 * rather than re-read, and the move is the only moment that knows both trees.
 *
 * So the write and the catch-up live in one function, and callers move a
 * conversation by calling it rather than by assigning the id. Doing half of this
 * is not a mistake a caller should be able to make.
 * @module services/workspace-rebinding
 */

import { posixNormalize } from 'juggler/utils/path-containment';
import { SCOPE_SESSION } from '../model/scoped-permission-store.js';

/**
 * Why this move would be refused, or '' if nothing stands in its way.
 *
 * The rules themselves, asked without moving anything, because a caller that
 * puts a question to the user before moving has to know the question is worth
 * asking. A confirmation raised over a conversation that cannot move asks
 * whether to do something it is about to refuse to do, which is a worse way of
 * saying no than saying no.
 *
 * `rebindConversation` asks this again at the moment it writes. A gesture and
 * the press that confirms it are two different times, a turn can start in
 * between, and a service whose safety lives in its callers has none.
 * @param {any} conversation - The conversation that would move.
 * @param {string} workspaceId - Where it would go; '' is the project.
 * @returns {string} What stops it, in a sentence that stands on its own, or ''.
 */
export function whyNotRebind(conversation, workspaceId) {
  const session = conversation?.session;
  if (!session) return `Couldn't move the conversation: it has no session.`;

  // Going nowhere is refused by nothing: the move is already true.
  const target = workspaceId || '';
  const from = conversation.workspaceId || '';
  if (from === target) return '';

  // A running turn is refused only a move that changes its tree. Into or out of
  // a group, its next operation lands exactly where it would have — and a turn
  // parked on an approval is "running" for as long as the user takes to answer.
  if (conversation.isProcessing === true && !sameTree(session, from, target)) {
    return `Couldn't move the conversation: it's in the middle of a turn.`;
  }

  if (target && !session.workspaceRoot(target)) {
    return `Couldn't move the conversation: that workspace can't be worked in.`;
  }

  return '';
}

/**
 * Whether moving this conversation there is worth asking the user about first.
 *
 * A move is confirmed because it changes where a conversation's files and
 * commands happen, under an agent that may be relying on them. Two workspaces
 * that resolve to the same tree — a group and the project
 * it is rooted at, or two groups — share all of that, and a move between them
 * changes only which box the tab is drawn in. Nothing about that needs a
 * second look.
 *
 * Decided from the places rather than from their providers, so it answers for
 * any pair of kinds, including ones an extension adds, without either having to
 * declare anything. A place that cannot be resolved is always asked about: the
 * dialog is where a move that is about to be refused says why.
 * @param {any} conversation - The conversation that would move.
 * @param {string} workspaceId - Where it would go; '' is the project.
 * @returns {boolean} True when the move should be confirmed.
 */
export function moveNeedsConfirmation(conversation, workspaceId) {
  return !sameTree(conversation?.session, conversation?.workspaceId || '', workspaceId || '');
}

/**
 * Whether two workspaces are the same tree — so that a conversation working in
 * one is working on exactly the files it would be in the other. A group and the
 * project it is rooted at are; a worktree and the repository it was made from
 * are not.
 *
 * By root alone. A root resolves only for a workspace that can be worked in
 * (`Session#workspaceRoot`), and the server reports a row it cannot open as
 * unavailable, so every root compared here is a tree on the server's machine
 * and two equal roots are one tree.
 * @param {any} session - The session both belong to.
 * @param {string} a - One workspace id; '' is the project.
 * @param {string} b - The other.
 * @returns {boolean} True only when both resolve, to the same root.
 */
export function sameTree(session, a, b) {
  if (a === b) return true;
  const rootA = session?.workspaceRoot?.(a);
  const rootB = session?.workspaceRoot?.(b);
  if (!rootA || !rootB) return false;
  return trimSlash(rootA) === trimSlash(rootB);
}

/**
 * Move a conversation to another workspace.
 *
 * Refused while the conversation has a turn in flight, for the reason finishing
 * with a workspace is: the running turn's next operation would land in a tree it
 * never agreed to work in — unless the move stays in the same tree, where it
 * would not (see `sameTree`). Refused, too, for a target that cannot be worked in —
 * moving a conversation from one unusable place to another is not a way out.
 * Both refusals are `whyNotRebind`'s, so that what is checked here and what a
 * caller can check before asking the user are the same rules.
 *
 * What the tree being left holds stays in it. A move is a change of where the
 * conversation works, not a copy: the files are still on the disk, under the
 * path they were always under.
 * @param {any} conversation - The conversation to move.
 * @param {string} workspaceId - Where it works now; '' is the project.
 * @returns {Promise<{done: boolean, message?: string}>} What happened, and why not.
 */
export async function rebindConversation(conversation, workspaceId) {
  const refusal = whyNotRebind(conversation, workspaceId);
  if (refusal) return { done: false, message: refusal };

  const target = workspaceId || '';
  const from = conversation.workspaceId || '';
  if (from === target) return { done: true };

  // Within one tree there is nothing to catch up on: the grants already name
  // it and every snapshot was taken from it. Leaving them alone is also what
  // lets such a move happen mid-turn without editing the context under it.
  if (sameTree(conversation.session, from, target)) {
    conversation.workspaceId = target;
    return { done: true };
  }

  const leaving = conversation.rootMessageThread?.getWorkingRoot?.() ?? null;
  conversation.workspaceId = target;
  reRootGrants(conversation, leaving);
  await refreshWorkspaceDerived(conversation);
  return { done: true };
}

/**
 * Move the conversation's folder grants into the tree it now works in.
 *
 * A grant is an absolute path, frozen when the user gave it. Left alone by a
 * move it describes the wrong tree twice over: the folder the conversation
 * actually works in is no longer granted, so it asks again for work it was
 * already trusted with, and the grant it still holds goes on authorising the
 * tree it was moved out of — which is the one place the move said it had
 * finished with. So a grant at or below the tree being left is rewritten to the
 * same place in the tree being entered, and a grant that was never in that tree
 * is left exactly as it is: it was granted for somewhere else, and somewhere
 * else has not moved.
 *
 * The two scopes are treated differently because they belong to different
 * things. A conversation-scoped grant is this conversation's and is rewritten in
 * place. A SESSION-scoped one is the project's — every other conversation in it
 * holds the same grant and none of them have moved — so it is copied down to
 * this conversation re-rooted rather than edited, which leaves the others
 * untouched.
 * @param {any} conversation - The conversation that has just moved.
 * @param {string|null} leaving - The root it worked in until a moment ago.
 * @returns {void}
 */
function reRootGrants(conversation, leaving) {
  const messageThread = conversation.rootMessageThread;
  const entering = messageThread?.getWorkingRoot?.() ?? null;
  if (!messageThread || !leaving || !entering || leaving === entering) return;

  const from = trimSlash(leaving);
  const to = trimSlash(entering);

  for (const entry of messageThread.getAllowedPathEntries()) {
    // The implicit root is the tree itself and is derived per call, so it has
    // already moved; it is not stored and cannot be rewritten.
    if (entry.implicit) continue;
    const moved = underRoot(entry.path, from, to);
    if (!moved) continue;

    // Either the grant is already held — a move back to a tree this
    // conversation has been in before — or it has collapsed into the implicit
    // root. Both mean the rewrite has nothing to add, and adding it anyway is
    // how a conversation moved back and forth accumulates copies of one grant.
    const alreadyHeld = messageThread.getAllowedPaths().includes(moved);

    if (entry.scope === SCOPE_SESSION) {
      if (!alreadyHeld) messageThread.addAllowedPath(moved);
      continue;
    }
    if (alreadyHeld) messageThread.removeAllowedPath(entry.id);
    else messageThread.updateAllowedPath(entry.id, moved);
  }
}

/**
 * @param {string} p - A directory path.
 * @returns {string} It, without a trailing separator.
 */
function trimSlash(p) {
  const normalized = posixNormalize(p);
  return normalized.endsWith('/') && normalized !== '/' ? normalized.slice(0, -1) : normalized;
}

/**
 * The same place in another tree, for a path at or below the first one.
 *
 * Compared as written, after normalisation, rather than through the folding
 * `isPathInsideAllowedRoots` does for matching. A grant whose spelling
 * differs from the root's only in case — possible on Windows alone — is simply
 * not recognised as being in the tree, and is then left alone. That is the
 * behaviour a move had before any of this, so the cost of missing one is a
 * grant that stays where it was, never a grant pointed somewhere nobody asked
 * for.
 * @param {string} path - The granted path.
 * @param {string} from - The root being left, without a trailing separator.
 * @param {string} to - The root being entered, without a trailing separator.
 * @returns {string|null} Where the grant belongs now, or null if it was not in that tree.
 */
function underRoot(path, from, to) {
  const target = trimSlash(path || '');
  if (!target) return null;
  if (target === from) return to;
  return target.startsWith(from + '/') ? to + target.slice(from.length) : null;
}

/**
 * Bring what the conversation read out of its old tree up to date with the new
 * one.
 *
 * Two halves, in this order. First the items already here are told, and each
 * decides for itself what that means — a seeded file re-takes its snapshot from
 * the new tree. Then seeding adds the assistant files the new tree has and the
 * old one did not: it is idempotent and *reuses* an item that is already there,
 * data and snapshot intact, so it can only ever add. Refreshing first is what
 * keeps the two from overlapping, since an item seeded a moment ago has nothing
 * to catch up on.
 *
 * Both halves are best-effort. A move that reported failure because one file
 * could not be re-read would leave the conversation bound to the new tree
 * anyway — worse than a snapshot that is one file out of date and says so in
 * the panel.
 * @param {any} conversation - The conversation that has just moved.
 * @returns {Promise<void>} When everything that could catch up has.
 */
async function refreshWorkspaceDerived(conversation) {
  // Every thread, not just the root one. A conversation is bound as a whole and
  // most of what one reads is read inside a sub-thread, where a delegated task
  // opened the files — those items hold the old tree's bytes exactly as the
  // root's do. A compaction fold is skipped: its transcript is frozen and read
  // as inert data, so re-taking a snapshot inside one would edit history.
  for (const thread of conversation.getAllMessageThreads?.() ?? []) {
    if (thread?.container?.get?.('boundedCompaction') === true) continue;
    for (const item of thread.contextItems ?? []) {
      try {
        await item.onWorkspaceChanged?.();
      } catch (error) {
        // One item that cannot catch up must not stop the rest from trying —
        // but it is a snapshot of the wrong tree, so it is worth a line.
        console.warn('[Workspaces] a context item could not follow the move:', error);
      }
    }
  }

  try {
    await conversation.session.seedConversationAutoItems(conversation);
  } catch {
    // Best-effort, as it is at creation: the tree may be unreadable, and a
    // conversation with one assistant file missing still works.
  }
}
