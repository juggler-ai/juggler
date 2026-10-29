//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Which thread's context item a surface outside the transcript should show — the
 * reader's thread first, then each ancestor up to the root.
 *
 * A plan made inside a sub-thread belongs to that sub-thread and to nothing above
 * it, so a surface looking for "the plan" finds the nearest one that exists rather
 * than aggregating several threads' plans into a claim no thread is making. The
 * Pinboard's plan and todo pins resolve through this, and so does the sidebar's
 * progress card that opens them: two surfaces that disagreed about whose plan was
 * current would send the reader from one plan to another.
 * @module services/nearest-context-item
 */

/**
 * Fired on `document` when the thread the user is reading changes, carrying
 * `{threadItemId}` (null for a root column). Column selection lives in the tab
 * and not in session state, so this is the only notice a surface outside the
 * conversation gets that the focused thread has moved.
 */
export const THREAD_FOCUS_CHANGED = 'juggler:thread-focus-changed';

/**
 * The thread the reader is in, in the conversation on screen. A root column has
 * no thread item of its own, which is what null means here. Column selection is
 * view state rather than session state, so the active tab is the only place that
 * knows it.
 * @returns {string|null} The focused thread item's id, or null for the root.
 */
export function focusedThreadItemId() {
  const tab = /** @type {any} */ (document.querySelector('conversation-tab.active'));
  return tab?.getFocusedThreadItemId?.() ?? null;
}

/**
 * The threads to look in for a context item, nearest first: the thread being
 * read, then each ancestor, ending at the root — which owns no thread item of its
 * own and is therefore null. This is the ownership order the columns show.
 * @param {any} conversation - The conversation being read.
 * @param {string|null} threadItemId - The focused thread, null for the root.
 * @returns {(string|null)[]} Thread ids nearest-first, always ending with null.
 */
function threadAncestry(conversation, threadItemId) {
  /** @type {(string|null)[]} */
  const chain = [];
  const seen = new Set();
  let id = threadItemId;
  // A malformed tree must not spin here; the guard costs one Set.
  while (id && !seen.has(id)) {
    seen.add(id);
    chain.push(id);
    const parent = conversation.findParentContainer?.(id);
    id = parent ? parent.get('itemId') : null;
  }
  chain.push(null);
  return chain;
}

/**
 * The nearest context item of a type, walking from a thread up through its
 * ancestors. What comes back is the live item, not a copy: a caller handing it
 * to code it does not own copies it first.
 * @param {any} conversation - The conversation to look in.
 * @param {string} type - The context-item type id, e.g. 'plan'.
 * @param {string|null} threadItemId - The thread to start at, null for the root.
 * @returns {{item: any, thread: any, threadId: string|null}|null} The item, the
 *   thread that owns it and that thread's id; null if no thread in the chain has one.
 */
export function findNearestContextItem(conversation, type, threadItemId) {
  if (!conversation) return null;
  for (const threadId of threadAncestry(conversation, threadItemId)) {
    let thread;
    try {
      // resolveMessageThread throws for an id that is not a thread item, which
      // a stale focus can easily hold.
      thread = conversation.resolveMessageThread(threadId);
    } catch {
      continue;
    }
    const item = thread?.contextItems?.find((/** @type {{type: string}} */ ci) => ci.type === type);
    if (item) return { item, thread, threadId };
  }
  return null;
}

/**
 * The nearest context item of a type for the reader: in the conversation on
 * screen, starting at the thread they are in. What the Plan and Todo pins show.
 * @param {any} session - The window's session.
 * @param {string} type - The context-item type id, e.g. 'plan'.
 * @returns {{item: any, thread: any, threadId: string|null}|null} As {@link findNearestContextItem}.
 */
export function findReaderContextItem(session, type) {
  const conversation = session?.getVisibleConversation?.() || null;
  if (!conversation) return null;
  return findNearestContextItem(conversation, type, focusedThreadItemId());
}

/**
 * Hear about the reader moving between threads.
 * @param {(threadItemId: string|null) => void} listener - Called with the thread now being read.
 * @returns {() => void} Stop listening.
 */
export function onReaderThreadChange(listener) {
  const onFocus = (/** @type {Event} */ e) => listener(/** @type {CustomEvent} */ (e).detail?.threadItemId ?? null);
  document.addEventListener(THREAD_FOCUS_CHANGED, onFocus);
  return () => document.removeEventListener(THREAD_FOCUS_CHANGED, onFocus);
}
