//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Compaction utilities shared by the /compact plugin and the auto-compact
 * observer.
 */

import {
  createUserMessage
} from '../../sdk/lib/message.js';

/**
 * @typedef {import('../../sdk/lib/message.js').Message} Message
 * @typedef {import('../model/message-thread.js').MessageThread} MessageThread
 */

/**
 * The Go worker owns the canonical summarization prompt and ships it to the
 * browser in the "ready" bootstrap (setBootstrapSummarizationPrompt). Until that
 * arrives — and for callers running outside a connected worker, e.g. extensions
 * in the engine realm — defaultSummarizationPrompt() returns the byte-identical
 * fallback below. A Go parity test asserts the fallback matches the Go constant,
 * so the two can never drift.
 * @type {string|null}
 */
let bootstrapSummarizationPrompt = null;

/**
 * Record the worker-owned summarization prompt received in the "ready"
 * bootstrap. Idempotent; the value is a server-wide constant.
 * @param {string} prompt - Prompt text from the worker
 */
export function setBootstrapSummarizationPrompt(prompt) {
  if (typeof prompt === 'string' && prompt.length > 0) {
    bootstrapSummarizationPrompt = prompt;
  }
}

/**
 * Default summarization prompt used by the compact commands. Prefers the
 * worker-provided text (Go is authoritative); falls back to the baked-in copy.
 * @returns {string} Summarization prompt text
 */
export function defaultSummarizationPrompt() {
  if (bootstrapSummarizationPrompt !== null) {
    return bootstrapSummarizationPrompt;
  }
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
 * Fold a conversation's history into a summarization sub-thread — the shared
 * entry point behind /compact and /handoff. The fold itself is performed by the
 * worker (the single Go fold, shared with the proactive auto-compaction
 * trigger): this sends the `compact` op and resolves with the worker's result
 * once the fast fold has committed. The worker relocates the conversational
 * history into a new bounded-compaction thread (leaving the leading standing
 * context — agents files, memory, the sticky system prompt — at the parent),
 * summarises it, and merges fold + summary into one undo group.
 *
 * Callers must first settle the conversation (cancelAndSettle) and guard against
 * concurrent compactions (isCompactionPending); the command framework does both
 * for `mutatesConversation` commands, and also closes the undo capture window so
 * the fold starts a fresh group.
 * @param {string} conversationId - Conversation whose worker performs the fold
 * @param {object} [opts]
 * @param {boolean} [opts.handoffPromote] - Tag the fold so the browser promotes
 *   its result into a continued tab's parked first message (/handoff)
 * @returns {Promise<{ folded: boolean, error?: string }>} The worker's outcome:
 *   `folded` is false when there was nothing to fold.
 */
export async function compactConversation(conversationId, { handoffPromote = false } = {}) {
  const { default: workerManager } = await import('../services/worker-manager.js');
  return workerManager.compact(conversationId, { handoffPromote });
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

