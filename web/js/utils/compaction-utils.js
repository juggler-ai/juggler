//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Compaction utilities shared by the /compact plugin and the auto-compact
 * observer.
 */

import {
  createUserMessage,
  createThreadMessage,
  isConversationalItemType
} from '../../sdk/lib/message.js';

/**
 * @typedef {import('../../sdk/lib/message.js').Message} Message
 * @typedef {import('../model/message-thread.js').MessageThread} MessageThread
 */

/**
 * Default summarization prompt used by the compact commands.
 * @returns {string} Summarization prompt text
 */
export function defaultSummarizationPrompt() {
  return `You are creating a handoff summary of the conversation so far. Another instance of yourself will use ONLY this summary (plus the most recent messages) to continue the work seamlessly, so completeness matters more than brevity — never drop information you cannot reconstruct later.

First, in <analysis> tags, walk the conversation chronologically: note each user request, each significant action you took, every error hit and how it was resolved, and what is in flight right now. This is your scratchpad.

Then write the summary with these sections:

1. Intent & explicit requests — the user's goals and EVERY explicit instruction or constraint, quoted or closely paraphrased. Do not summarize these away.
2. Files modified — each path, what changed, and why. Include key signatures, identifiers, and snippets verbatim where they matter.
3. Key technical decisions — what was decided and the reasoning, so the choice isn't relitigated.
4. Errors & fixes — problems encountered and their resolutions, so they aren't repeated.
5. Current state — what is done, what is in progress right now.
6. Next step — the immediate next action, which must follow directly from the most recent work above. If continuing an interrupted task, quote the relevant request verbatim. Do not introduce new direction the user didn't ask for.
7. Open issues — anything unresolved or uncertain.

Be precise and technical within each section; compress prose, never facts. Then call return_result, passing the summary (sections 1–7, not the <analysis>) in its "result" argument.`;
}

/**
 * Wrap a message that carries image attachments so any summariser reading its
 * `content` sees a short textual stand-in per attachment ("[image: <name>]")
 * instead of trying to re-embed the image bytes. The wrapper is read-only and
 * delegates everything to the underlying item — it NEVER mutates the doc; the
 * stand-in exists only in the value returned to summarisation callers. Messages
 * without attachments are returned unchanged (identity preserved).
 * @param {Message} item - Message (Y.Map-like, with a `get` accessor)
 * @returns {Message} The original item, or a read-only stand-in wrapper
 */
function withAttachmentStandin(item) {
  const att = item?.get?.('attachments');
  if (!Array.isArray(att) || att.length === 0) return item;
  const standin = att
    .map(a => `\n[image: ${(a && (a.filename || a.id)) || 'image'}]`)
    .join('');
  return /** @type {Message} */ (new Proxy(item, {
    get(target, prop, receiver) {
      if (prop === 'get') {
        return (/** @type {string} */ key) => {
          const v = target.get(key);
          if (key === 'content') return (typeof v === 'string' ? v : '') + standin;
          return v;
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    }
  }));
}

/**
 * Get content messages from a message thread (filtering UI-only types).
 *
 * User messages that carry image attachments are returned as read-only
 * stand-in wrappers whose `content` appends "[image: <filename>]" per
 * attachment — so a summarisation turn built from these messages describes the
 * image by name rather than re-embedding its bytes. The wrapper does not mutate
 * the doc.
 * @param {import('../model/message-thread.js').MessageThread} messageThread - Message thread
 * @returns {Message[]} Content messages
 */
export function getContentMessages(messageThread) {
  if (!messageThread) return [];
  return messageThread.getMessages()
    .filter(m =>
      ['user', 'assistant', 'tool-action', 'thread'].includes(m.get('type'))
    )
    .map(withAttachmentStandin);
}

/** Track pending compactions to prevent duplicates */
const pendingCompactions = new Set();

/**
 * Check if a compaction is already in progress
 * @param {string} conversationId - Conversation ID
 * @returns {boolean} True if compaction in progress
 */
export function isCompactionPending(conversationId) {
  return pendingCompactions.has(conversationId);
}

/**
 * Mark compaction as started
 * @param {string} conversationId - Conversation ID
 */
export function startCompaction(conversationId) {
  pendingCompactions.add(conversationId);
}

/**
 * Mark compaction as finished
 * @param {string} conversationId - Conversation ID
 */
export function endCompaction(conversationId) {
  pendingCompactions.delete(conversationId);
}

/**
 * Fold a message thread's conversational history into a single summarization
 * sub-thread — the shared primitive behind /compact and /handoff.
 *
 * Every content item (messages, tool actions, thinking, AND dynamic context
 * items the LLM produced) is moved into a new thread carrying a summarization
 * prompt; the LEADING run of standing context items (agents files, memory, the
 * sticky system prompt) stays at the parent so the conversation keeps its
 * working context. The thread is seeded with `needsStrategyRun` +
 * `forceTool: 'return_result'`, so the worker answers the prompt and its
 * `result` becomes the summary. The whole move is one Yjs transaction, so undo
 * reverses it atomically.
 *
 * The blocklist-by-persistence rule and leading-context reasoning are described
 * in detail at the /compact call site; this function is the extraction of that
 * body so /handoff can reuse it verbatim (with a `handoffPromote` marker in
 * `threadExtra`). Callers must first settle the conversation
 * (cancelAndSettle) and guard against concurrent compactions
 * (isCompactionPending) — this function only performs the document mutation.
 * @param {MessageThread} mt - Message thread to fold
 * @param {object} [opts]
 * @param {string} [opts.goal] - Thread tile label
 * @param {object} [opts.threadExtra] - Extra fields merged onto the thread
 *   message (e.g. `{ handoffPromote: true }`)
 * @returns {{ threadId: string } | null} The new summary thread's id, or null
 *   when there was nothing to fold.
 */
export function foldConversationIntoSummaryThread(
  mt,
  { goal = 'Compacted conversation history', threadExtra = {} } = {}
) {
  const items = mt.items;

  /** @type {object[]} */
  const snapshots = [];
  /** @type {number[]} */
  const indicesToDelete = [];
  let inLeadingContext = true;
  items.forEach((item, idx) => {
    if (!item || typeof item.toJSON !== 'function') return;
    // Sticky parent-level items (today only the SYSTEM_1 system prompt) stay
    // put and are transparent to the leading run.
    if (item.get?.('preventUserDeletion') === true) return;
    const type = item.get?.('type');
    if (inLeadingContext) {
      if (isConversationalItemType(type)) {
        // First conversational item ends the starting-context run.
        inLeadingContext = false;
      } else if (item.get?.('itemId') && !item.get?.('toolUseId')) {
        // A leading standing context item — keep it at the parent.
        return;
      }
    }
    // Defensive: a thread we ourselves just inserted is content by type but
    // must not be re-swallowed.
    if (item.get?.('noAutoSelect') && type === 'thread' && !item.get?.('result')) return;
    snapshots.push(item.toJSON());
    indicesToDelete.push(idx);
  });

  if (snapshots.length === 0) return null;

  const threadMsg = /** @type {any} */ (createThreadMessage({ goal }));
  threadMsg.needsStrategyRun = true;
  // The user did not ask to drill into the new thread.
  threadMsg.noAutoSelect = true;
  // Force the summarization turn to call return_result rather than replying in
  // plain text (providers without forced-tool support fall back to the
  // plain-text → writeThreadResult path).
  threadMsg.forceTool = 'return_result';
  Object.assign(threadMsg, threadExtra);

  const userMsg = createUserMessage(defaultSummarizationPrompt());
  mt._ensureItemId(userMsg);
  // Mark worker-owned bounded fallback threads and pin the orchestration prompt
  // so canonical history excludes it even if more messages are later appended.
  threadMsg.boundedCompaction = true;
  threadMsg.compactionPromptItemId = userMsg.itemId;

  // Insert where the first content item was, so the thread lands among the
  // content rather than before the preserved leading context items.
  const insertAt = /** @type {number} */ (indicesToDelete[0]);

  // Single Yjs transaction so undo reverses everything atomically.
  mt.transact(() => {
    const threadYMap = mt.buildThreadYMap(threadMsg, [...snapshots, userMsg]);
    for (let i = indicesToDelete.length - 1; i >= 0; i--) {
      mt.deleteAt(/** @type {number} */ (indicesToDelete[i]));
    }
    mt.insertAt(insertAt, threadYMap);
  });

  return { threadId: threadMsg.itemId };
}

/** Guards against a single client double-promoting the same handoff thread. */
const promotingHandoffs = new Set();

/**
 * /handoff completion step: when a summary thread minted by /handoff (tagged
 * `handoffPromote`) has produced its `result`, replace the thread tile with a
 * parked user message carrying that summary — the first message of the new
 * "(continued)" tab. "Parked" is automatic: inserting a user item never starts
 * a turn (only sendMessage / needsStrategyRun do), so the tab waits for the
 * user to press Continue or type a follow-up.
 *
 * Best-effort and idempotent: driven from the items observer, so it fires both
 * when the worker writes the result live and when a reloaded doc hydrates with
 * the result already present. A normal /compact thread carries no
 * `handoffPromote` flag and is never touched.
 * @param {MessageThread} mt - Root message thread of the "(continued)" tab
 * @returns {boolean} True if a thread was promoted this call
 */
export function maybePromoteHandoffThread(mt) {
  try {
    const items = mt?.items;
    if (!items || !items.length) return false;
    for (const item of items) {
      if (item?.get?.('type') !== 'thread') continue;
      if (item.get('handoffPromote') !== true) continue;
      const threadId = item.get('itemId');
      const result = item.get('result');
      // Thread exists but hasn't summarised yet — wait for a later tick.
      if (typeof result !== 'string' || !result.trim()) return false;

      const key = `${mt.conversationId}:${threadId}`;
      if (promotingHandoffs.has(key)) return false;
      promotingHandoffs.add(key);
      try {
        mt.transact(() => {
          const idx = mt.findIndexByItemId(threadId);
          if (idx < 0) return;
          mt.deleteAt(idx);
          const msg = /** @type {any} */ (createUserMessage(result));
          // insertItem mints an itemId (via _ensureItemId) so the message is
          // addressable/selectable; reinsert at the thread's old slot (right
          // after the preserved context items).
          mt.insertItem(idx, msg);
        });
      } finally {
        promotingHandoffs.delete(key);
      }
      return true;
    }
  } catch (err) {
    // Never let a promotion failure break the items observer.
    console.warn('[handoff] promotion skipped:', err);
  }
  return false;
}

