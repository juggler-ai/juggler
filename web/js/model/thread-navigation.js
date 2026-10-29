//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Thread Navigation Utilities
 *
 * Pure functions for navigating the thread tree structure in Yjs documents.
 * These walk Y.Arrays and Y.Maps without depending on Conversation or
 * MessageThread instances.
 */

import { TOOL_STATES, itemField } from '../../sdk/lib/message.js';
import { arrayItems, isItemView } from './item-accessor.js';

/** @typedef {import('./item-accessor.js').ItemView} ItemView */

/**
 * Whether a value is a thread item.
 * @param {unknown} item - An element of an items array
 * @returns {item is ItemView} True for a thread item
 */
function isThreadItem(item) {
  return isItemView(item) && item.get('type') === 'thread';
}

/**
 * Extract message IDs of newly inserted items from a Yjs delta.
 * @param {unknown} delta - Yjs delta array
 * @returns {string[]} Array of itemIds that were inserted
 */
export function extractInsertedItemIds(delta) {
  /** @type {string[]} */
  const itemIds = [];
  if (!Array.isArray(delta)) return itemIds;

  for (const change of delta) {
    const insert = itemField(change, 'insert');
    if (!Array.isArray(insert)) continue;
    for (const item of insert) {
      const id = itemField(item, 'itemId');
      if (typeof id === 'string' && id) itemIds.push(id);
    }
  }
  return itemIds;
}

/**
 * Find which thread Y.Map owns a given Y.Array by searching recursively.
 * @param {unknown} arr - Y.Array to search within
 * @param {unknown} targetArray - The Y.Array we're looking for
 * @returns {ItemView|null} The thread Y.Map that owns targetArray, or null
 */
export function findThreadForArray(arr, targetArray) {
  for (const item of arrayItems(arr)) {
    if (!isThreadItem(item)) continue;
    const threadItems = item.get('items');
    if (threadItems === targetArray) {
      return item;
    }
    if (threadItems) {
      const found = findThreadForArray(threadItems, targetArray);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Find the parent thread Y.Map for a given threadItemId.
 * Returns null if the thread is at the root level (direct child of rootArr).
 * Returns undefined if not found in the subtree.
 * @param {unknown} arr - Y.Array to search within
 * @param {string} targetId - The threadItemId to find the parent for
 * @returns {ItemView|null|undefined} Parent Y.Map, null if at root level, undefined if not found
 */
export function findParentInArray(arr, targetId) {
  if (!arr) return undefined;
  for (const item of arrayItems(arr)) {
    if (!isThreadItem(item)) continue;
    if (item.get('itemId') === targetId) {
      return null; // Found at this level — parent is the container above
    }
    const threadItems = item.get('items');
    if (threadItems) {
      for (const child of arrayItems(threadItems)) {
        if (isThreadItem(child) && child.get('itemId') === targetId) {
          return item; // This thread Y.Map is the parent
        }
      }
      const found = findParentInArray(threadItems, targetId);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * The chain of threads standing over one thread, from the thread itself up to
 * the root: `[threadItemId, …ancestors, '']`, where `''` is the root thread.
 *
 * A Pause mark names one thread and stands over everything nested below it, so
 * this is what answers "does that mark cover this column". A thread the walk
 * cannot find is read as top-level, which keeps a root mark covering it.
 * @param {unknown[]} items - Root items array to search.
 * @param {string} threadItemId - Thread to walk up from; '' is the root itself.
 * @returns {string[]} Thread ids from the named thread up to the root.
 */
export function threadAncestry(items, threadItemId) {
  if (!threadItemId) return [''];
  /**
   * @param {unknown[]} arr - Items to search.
   * @param {string[]} path - Ids of the threads owning arr, innermost first.
   * @returns {string[]|null} The chain, or null when this subtree lacks it.
   */
  const walk = (arr, path) => {
    for (const item of arr) {
      if (!isThreadItem(item)) continue;
      const id = item.get('itemId') ?? '';
      if (id === threadItemId) return [id, ...path, ''];
      const nested = item.get('items');
      const found = nested ? walk(arrayItems(nested), [id, ...path]) : null;
      if (found) return found;
    }
    return null;
  };
  return walk(items, []) || [threadItemId, ''];
}

/**
 * Walk all thread items recursively, calling callback for each.
 * @param {unknown[]} items - Items to walk
 * @param {(threadYMap: ItemView) => void} callback - Called with each thread Y.Map
 */
export function walkThreads(items, callback) {
  for (const item of items) {
    if (!isThreadItem(item)) continue;
    const threadItems = item.get('items');
    if (!threadItems) continue;
    callback(item);
    walkThreads(arrayItems(threadItems), callback);
  }
}

/**
 * Determine whether a subtree of items contains a tool-action awaiting user
 * approval (state `pending`/`awaiting_approval`), searching recursively through
 * nested threads. This is the single source of truth for propagating the
 * "needs your input" highlight from a deeply-nested sub-thread up to every
 * ancestor tile and the conversation tab — so the visual route from the tab to
 * the required action is unbroken regardless of nesting depth.
 * @param {unknown} items - Items to
 *   search. Accepts a plain JS array (MessageThread.items) or a Y.Array
 *   (threadYMap.get('items')).
 * @returns {boolean} True if any descendant tool-action is pending approval.
 */
export function hasPendingApprovalInTree(items) {
  return anyPendingApproval(items, true);
}

/**
 * The narrower sibling of {@link hasPendingApprovalInTree}: whether a subtree
 * contains a tool-action that is parked AND has nobody but the user left to
 * resolve it — i.e. no strategy reviewer currently has it in hand.
 *
 * A parked call a strategy's `onToolPending` reviewer is still working on may
 * yet be approved without the user ever seeing it, so it is not (yet) something
 * to interrupt them about. This is the question the attention alert asks, as
 * opposed to the highlight, which marks everything parked.
 * @param {unknown} items - Items to
 *   search (plain JS array or Y.Array).
 * @returns {boolean} True if any descendant tool-action is parked with no
 *   review in flight.
 */
export function hasUnattendedPendingApprovalInTree(items) {
  return anyPendingApproval(items, false);
}

/**
 * Whether a tool-action's `reviewStatus` says a strategy reviewer is in flight
 * for it. The field is a Y.Map in the doc and a plain object in the fixtures
 * that stand in for one, so read it both ways.
 * @param {ItemView} item - A tool-action item (Y.Map or plain).
 * @returns {boolean} True while a review is running on this call.
 * @private
 */
function isUnderReview(item) {
  return !!itemField(item.get('reviewStatus'), 'busy');
}

/**
 * The itemId of the first tool-action awaiting approval anywhere in a subtree,
 * in document order (depth-first through nested threads) — the approval
 * jump-to-attention lands on, which may sit several threads deep.
 * @param {unknown} items - Items to
 *   search (plain JS array or Y.Array).
 * @returns {string|null} The approval's itemId, or null when nothing is parked.
 */
export function findFirstPendingApprovalId(items) {
  return firstPendingApproval(items, true)?.get('itemId') ?? null;
}

/**
 * Shared walk behind the two pending-approval predicates.
 * @param {unknown} items - Items to search.
 * @param {boolean} countUnderReview - Whether a parked call a strategy reviewer
 *   currently has in hand counts.
 * @returns {boolean} True if any descendant tool-action qualifies.
 * @private
 */
function anyPendingApproval(items, countUnderReview) {
  return firstPendingApproval(items, countUnderReview) !== null;
}

/**
 * The first descendant tool-action awaiting approval, depth-first.
 * @param {unknown} items - Items to search.
 * @param {boolean} countUnderReview - Whether a parked call a strategy reviewer
 *   currently has in hand counts.
 * @returns {ItemView|null} The qualifying tool-action item, or null.
 * @private
 */
function firstPendingApproval(items, countUnderReview) {
  for (const item of arrayItems(items)) {
    if (!isItemView(item)) continue;
    const type = item.get('type');
    if (type === 'tool-action') {
      const state = item.get('state');
      // 'awaiting_approval' is a legacy/defensive alias for PENDING that some
      // callers still stamp; treat it as pending here too.
      if (state === TOOL_STATES.PENDING || state === 'awaiting_approval') {
        if (countUnderReview || !isUnderReview(item)) return item;
      }
    } else if (type === 'thread') {
      const found = firstPendingApproval(item.get('items'), countUnderReview);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Determine whether a subtree of items contains a NON-TERMINAL tool-action
 * (state is anything other than `completed`/`cancelled` — i.e. pending,
 * approved, running, or unset), searching recursively through nested threads.
 * This is the broader sibling of `hasPendingApprovalInTree`: it answers "is
 * there live work anywhere under here", not just "is something awaiting
 * approval". Mirror of the Go worker's terminality check (findThreadWith-
 * IncompleteTool / cancelToolsInArray).
 * @param {unknown} items - Items to
 *   search (plain JS array or Y.Array).
 * @returns {boolean} True if any descendant tool-action is non-terminal.
 */
export function hasUnsettledToolInTree(items) {
  for (const item of arrayItems(items)) {
    if (!isItemView(item)) continue;
    const type = item.get('type');
    if (type === 'tool-action') {
      const state = item.get('state');
      if (state !== TOOL_STATES.COMPLETED && state !== TOOL_STATES.CANCELLED) return true;
    } else if (type === 'thread') {
      if (hasUnsettledToolInTree(item.get('items'))) return true;
    }
  }
  return false;
}

/**
 * Survey the tool-actions actually EXECUTING in a subtree, searching
 * recursively through nested threads.
 *
 * The narrow sibling of `hasUnsettledToolInTree`: that one asks "is anything
 * unfinished under here" and counts a tool sitting at a pending approval or
 * waiting to be claimed; this one counts only `running` — work the machine is
 * doing this instant. That distinction is the point. The tool executor fires
 * consecutive read/meta calls as one parallel batch (see services/tool-executor),
 * so this number is genuinely how many things are in flight at once: 1 for a
 * lone bash, several for a read fan-out. Anything looser would count queued work
 * as concurrent and overstate it.
 *
 * Recursing through `thread` items means the count picks up work in sub-threads
 * for free, so it stays correct if threads ever run concurrently rather than
 * one at a time.
 *
 * `oldestStart` is the claim stamp (`runningStartedAt`, written by
 * claimRunning) of the longest-running of those tools — how long the machine
 * has been waiting on the thing it is still waiting on, as opposed to how long
 * the turn has been going. A running tool with no stamp (an older doc, or a
 * claim whose stamp hasn't replicated yet) contributes nothing, which reads as
 * "just started" rather than inventing an age for it.
 *
 * Both numbers come from ONE walk on purpose: the callers ask on every
 * streaming tick, and a second traversal of the whole tree to answer the
 * second half of the same question is exactly the work that made this hot.
 * @param {unknown} items - Items to
 *   search (plain JS array or Y.Array).
 * @returns {{count: number, oldestStart: number}} How many descendant
 *   tool-actions are running, and the earliest claim stamp among them (0 when
 *   none is running or none carries a stamp).
 */
export function runningToolsInTree(items) {
  let count = 0;
  let oldestStart = 0;
  for (const item of arrayItems(items)) {
    if (!isItemView(item)) continue;
    const type = item.get('type');
    if (type === 'tool-action') {
      if (item.get('state') !== TOOL_STATES.RUNNING) continue;
      count++;
      const startedAt = Number(item.get('runningStartedAt'));
      if (Number.isFinite(startedAt) && startedAt > 0
          && (oldestStart === 0 || startedAt < oldestStart)) {
        oldestStart = startedAt;
      }
    } else if (type === 'thread') {
      const nested = runningToolsInTree(item.get('items'));
      count += nested.count;
      if (nested.oldestStart > 0 && (oldestStart === 0 || nested.oldestStart < oldestStart)) {
        oldestStart = nested.oldestStart;
      }
    }
  }
  return { count, oldestStart };
}

/**
 * Find an item by itemId, searching recursively through nested threads.
 * @param {unknown[]} items - Items to search
 * @param {string} id - Item ID to find
 * @returns {ItemView|null} Y.Map or null
 */
export function findItemByIdRecursive(items, id) {
  for (const item of items) {
    if (!isItemView(item)) continue;
    if (item.get('itemId') === id) {
      return item;
    }
    if (item.get('type') === 'thread') {
      const threadItems = item.get('items');
      if (threadItems) {
        const found = findItemByIdRecursive(arrayItems(threadItems), id);
        if (found) return found;
      }
    }
  }
  return null;
}
