//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Yjs observer wiring for Conversation. Factory function that registers
 * the items and metadata observers, returns a cleanup function the
 * constructor stashes on the instance.
 * @module model/conversation-observers
 */

import {
  approvePermittedPendingApprovals,
} from './conversation-tool-actions.js';
import { extractInsertedItemIds } from './thread-navigation.js';
import strategyRegistry from '../registries/strategy-registry.js';
import workerManager from '../services/worker-manager.js';
import { isViewer } from '../../sdk/lib/client-role.js';
import { recordTape } from '../utils/event-tape.js';
import { bytesToBase64 } from '../utils/base64.js';
import { isCompactionPending, maybePromoteHandoffThread } from '../utils/compaction-utils.js';
import { findLastAssistantTxnId } from '../utils/transaction-anchor.js';

/**
 * Auto-compact threshold: when authoritative provider input-token usage
 * reaches this fraction of the model's context window, the next observed
 * items-array delta fires /compact automatically.
 */
const AUTO_COMPACT_THRESHOLD = 0.85;

/**
 * Wire up the items and metadata observers on the conversation's Yjs doc.
 * Returns a cleanup function that unregisters both observers.
 *
 * Side effects: installs `_yjsItemsObserver` and `_yjsMetadataObserver`
 * on the conversation.
 * @param {any} c - Conversation instance
 * @returns {() => void} Cleanup function
 */
export function setupYjsObservers(c) {
  // Clean up existing observers first (defensive — supports re-setup)
  if (c._yjsItemsObserver) {
    c._doc.root.unobserveDeep(c._yjsItemsObserver);
  }
  if (c._yjsMetadataObserver) {
    c._doc.unobserveMetadata(c._yjsMetadataObserver);
  }

  // Initialize document as client (no UndoManager on main thread - worker owns it)
  c._doc.initializeAsClient();

  // Register sync callback to send updates to worker
  c._doc.setOnSyncBroadcast(
    (/** @type {Uint8Array} */ update, /** @type {{engineDerived?: boolean} | undefined} */ opts) => {
      // Convert Uint8Array to base64 string for Go compatibility
      // (Go's json.Unmarshal expects base64 for []byte fields)
      const base64Bytes = bytesToBase64(update);
      // Forward the engine-derived marker so the worker can apply this
      // update with a non-tracked origin and the UndoManager skips it.
      // See ENGINE_DERIVED_ORIGIN in document-sync-manager.js.
      /** @type {{type: string, [key: string]: unknown}} */
      const msg = {
        type: 'yjs-sync',
        bytes: base64Bytes
      };
      if (opts?.engineDerived) msg.engineDerived = true;
      workerManager.sendToWorker(c.id, msg);
    }
    // No onUndoStateChange callback - main thread receives undo state FROM worker
  );

  // IMPORTANT: Do NOT call activateSync() here - it must be called AFTER construction completes
  // and worker is ready. Connection is activated by worker manager after spawn.

  // Observe items changes → notify session for UI updates + execute approved tools.
  // Context items live in the items array, so this observer handles context item
  // changes too.
  c._yjsItemsObserver = (/** @type {any[]} */ events, /** @type {any} */ transaction) => {
    // Skip if still initializing or already in observer
    if (c._initializing || c._inItemsObserver) {
      return;
    }

    try {
      c._inItemsObserver = true;
      // Wake up any waiting loops (e.g., waitForApproval)
      c._emitStateChange();

      // observeDeep gives an array of events. The first event for Y.Array-level
      // changes (inserts/deletes) is a YArrayEvent with changes.delta.
      // Nested Y.Map changes produce YMapEvent entries.
      const arrayEvent = events.find(e => e.changes?.delta);

      // Inter-tick gap (gapMs) surfaces the single engine WebView falling
      // behind under load — the engine-throughput hypothesis. Guarded so
      // the Date.now() bookkeeping is zero-cost when tracing is off.
      if (/** @type {any} */ (globalThis).__jugglerTrace) {
        const nowTick = Date.now();
        const gapMs = c._lastObserverTickTs ? nowTick - c._lastObserverTickTs : 0;
        c._lastObserverTickTs = nowTick;
        recordTape('yjs-observer', c.id, {
          local: !!transaction.local,
          eventCount: events.length,
          hasDelta: !!arrayEvent,
          gapMs
        });
      }

      // Extract inserted message IDs from Yjs delta
      const insertedItemIds = extractInsertedItemIds(arrayEvent?.changes?.delta || []);

      // Auto-recents for live LLM/worker changes. User sends are bumped
      // synchronously at the action site with forceTop; this observer path
      // is only for remote, non-user item changes and uses the default busy
      // barrier. Gate on loadState so initial hydration/background load
      // doesn't reorder tabs just because old history arrived from disk.
      if (isViewer() && !transaction.local && c.loadState === 'loaded' && isLLMRecentsChange(c, events, insertedItemIds)) {
        c._session.bumpConversation?.(c.id);
      }

      // Check if any context items were inserted/changed
      const hasContextItems = checkForContextItemChanges(arrayEvent);

      // SYSTEM_1 (root-only) is NOT reconciled here. It's seeded atomically at
      // root creation (initBuiltInContextItems / ensureSystemPromptPlaceholder)
      // in the same Yjs transaction, so undo/redo/peer-sync stay consistent
      // without a reactive observer. Sub-threads carry no SYSTEM_1.

      // React to conversation being cleared: reset processing state.
      // "Cleared" means no user-deletable content remains — the sticky
      // system-prompt placeholder (preventUserDeletion) survives /clear,
      // so the root is never length 0 after a clear. Key off content,
      // not raw length.
      if (arrayEvent &&
                c._rootMessageThread.items.every((/** @type {any} */ it) => it.get('preventUserDeletion'))) {
        c._iterationCount = 0;
        c._llmState.stop(c.id);
      }

      // Notify session for UI updates
      c._session.notifyConversationChange('conversation:changed', {
        conversationId: c.id,
        insertedItemIds: insertedItemIds
      });

      // Also notify context-items:changed if context items were affected
      if (hasContextItems) {
        c._session.notifyConversationChange('context-items:changed', null);
      }

      // Auto-compact: viewer-only. maybeAutoCompact reads the last
      // assistant's transaction blob and fires /compact when its
      // inputTokens crosses the threshold relative to the budget.
      if (isViewer()) {
        maybeAutoCompact(c);
        // /handoff completion: when this tab's handoff summary thread finishes,
        // promote its result into the parked first user message. Cheap scan,
        // fires both live (worker writes result) and on reload hydration.
        maybePromoteHandoffThread(c._rootMessageThread);
      }
    } catch (err) {
      console.error('[Conversation] Items observer error (corrupt data?):', err);
      // Still notify UI so the conversation is visible and deletable
      c._session.notifyConversationChange('conversation:changed', {
        conversationId: c.id,
        insertedItemIds: []
      });
    } finally {
      c._inItemsObserver = false;
    }
  };
  c._doc.root.observeDeep(c._yjsItemsObserver);

  // Observe metadata changes → notify when specific fields change.
  // The conversation name lives on the on-disk folder name (mutated via
  // the rename API), not in Yjs metadata.
  c._yjsMetadataObserver = (/** @type {{keysChanged: Set<string>}} */ event) => {
    if (!event.keysChanged) return;

    // Check all relevant metadata keys
    const relevantKeys = ['defaultModelConfig', 'currentStrategyId', 'conversationPermissionRules', 'conversationAllowedPaths', 'processingState', 'completedTurns', 'undoState'];
    const changedRelevantKey = Array.from(event.keysChanged).some(key =>
      relevantKeys.includes(key)
    );

    if (changedRelevantKey) {
      // Notify for general UI updates
      c._session.notifyConversationChange('conversation:changed', {
        conversationId: c.id,
        metadataKeys: Array.from(event.keysChanged)
      });
    }

    // Specific reactions to key changes
    if (event.keysChanged.has('defaultModelConfig')) {
      const config = c.getMetadata('defaultModelConfig');
      if (config) {
        c._fetchContextWindow(config);
      } else {
        c._rootMessageThread.contextWindow = null;
      }
    }

    if (event.keysChanged.has('processingState') && c.processingState?.status === 'idle' && isViewer()) {
      // The items observer sees the final assistant write while the worker is
      // still busy, so maybeAutoCompact deliberately declines there. Retry on
      // the authoritative idle transition; otherwise no later item mutation may
      // occur and the next user turn can resend an already-full context.
      maybeAutoCompact(c);
    }

    if (event.keysChanged.has('currentStrategyId')) {
      const newStrategyId = c.getMetadata('currentStrategyId');
      const root = c._rootMessageThread;
      if (newStrategyId && newStrategyId !== root.currentStrategyId) {
        // Track the active strategy and (re)build its instance so the UI — and
        // the engine, which shares this observer — operate on the right
        // strategy. The onActivate lifecycle hook is NOT fired here: session-
        // wide flow runs only in the engine, driven by the worker at turn-start
        // (run-strategy-hook), never in an elected viewer.
        root.currentStrategyId = newStrategyId;
        root.strategy = strategyRegistry.createStrategy(newStrategyId, root);
      }
      c._session.notifyConversationChange('conversation:strategy-changed', {
        conversation: c,
        strategyId: newStrategyId
      });
    }

    if (event.keysChanged.has('conversationPermissionRules') || event.keysChanged.has('conversationAllowedPaths')) {
      approvePermittedPendingApprovals(c);
    }

    // The strategy's onWorkerIdle hook is NOT fired from this observer. The
    // worker owns the idle transition and dispatches the hook to the engine
    // (run-strategy-hook) when the root conversation goes idle, so it runs
    // exactly once — no per-viewer ownership election.

    // No manual yjs-update sending - GenericSyncProvider handles it!
  };
  c._doc.observeMetadata(c._yjsMetadataObserver);

  return function cleanup() {
    if (c._yjsItemsObserver) {
      c._doc.root.unobserveDeep(c._yjsItemsObserver);
      c._yjsItemsObserver = null;
    }
    if (c._yjsMetadataObserver) {
      c._doc.unobserveMetadata(c._yjsMetadataObserver);
      c._yjsMetadataObserver = null;
    }
  };
}

/**
 * @param {any} c - Conversation instance
 * @param {any[]} events - Yjs observeDeep events
 * @param {string[]} insertedItemIds - Item ids inserted by the array delta
 * @returns {boolean} True when the remote change should bump LLM recency
 */
function isLLMRecentsChange(c, events, insertedItemIds) {
  if (hasNonUserInsertion(c, insertedItemIds)) return true;
  // Streaming text usually mutates the `content` field of an existing assistant
  // message before the final response inserts/settles anything. Treat those
  // remote field changes as LLM activity too, so a streaming tab becomes recent
  // while work is visibly happening.
  for (const event of events || []) {
    if (!event.keysChanged?.has?.('content')) continue;
    const target = event.target;
    if (target?.get?.('type') !== 'user') return true;
  }
  return false;
}

/**
 * @param {any} c - Conversation instance
 * @param {string[]} insertedItemIds - Item ids inserted by the array delta
 * @returns {boolean} True when any inserted item is not a user message
 */
function hasNonUserInsertion(c, insertedItemIds) {
  if (!insertedItemIds?.length) return false;
  for (const id of insertedItemIds) {
    const item = c.findItemById?.(id);
    if (!item?.get) continue;
    const type = item.get('type');
    if (type && type !== 'user') return true;
  }
  return false;
}

/**
 * Fire /compact when the most recent root-thread turn's prompt size
 * crosses the auto-compact threshold. The authoritative number lives
 * in the LLM transaction blob on disk; we look it up lazily through
 * the worker, keyed by the transactionId of the most recent root
 * item. A sub-thread's blobs live under that thread's items and
 * never trigger compaction of the parent.
 *
 * The fetch is debounced by transactionId on the conversation
 * instance so back-to-back items-observer ticks don't stack
 * duplicate requests.
 * @param {any} c - Conversation instance
 * @returns {void}
 */
function maybeAutoCompact(c) {
  try {
    if (!c?.id) return;
    if (isCompactionPending(c.id)) return;

    const root = c._rootMessageThread;
    const txnId = findLastAssistantTxnId(root?.items);
    if (!txnId) return;

    const budget = Number(root?.contextWindow) || 0;
    if (budget <= 0) return;

    // Don't compact mid-turn — wait for the worker to settle so the
    // compaction transaction lands on a stable conversation. The
    // check is here rather than after the fetch so we don't even
    // ask for a blob we'd ignore. Read processingState directly (the
    // durable worker-written signal), via the normalising getter.
    const status = c.processingState?.status;
    if (status && status !== 'idle') return;

    // Debounce per-txnId. If we've already evaluated this anchor
    // (compacted or under-threshold) skip the round-trip.
    if (c._autoCompactCheckedTxnId === txnId) return;
    c._autoCompactCheckedTxnId = txnId;

    import('../services/worker-manager.js').then(({ default: workerManager }) => {
      return workerManager.getTransaction(c.id, txnId);
    }).then((/** @type {any} */ blob) => {
      const anchored = Number(blob?.inputTokens) || 0;
      if (anchored <= 0) return;
      if (anchored / budget < AUTO_COMPACT_THRESHOLD) return;
      return import('../services/slash-command-handler.js').then(({ default: handler }) => {
        handler.execute('/compact', root).catch(() => { /* surfaced as a status message */ });
      });
    }).catch(() => { /* best-effort */ });
  } catch (err) {
    // Auto-compact is best-effort: a failure here must never break
    // the items observer. Log and move on.
    console.warn('[auto-compact] skipped:', err);
  }
}

/**
 * Detect whether any context items were affected by an items array delta.
 * Pure helper used by the items observer.
 * @param {any} event - Yjs array observe event (may be undefined)
 * @returns {boolean} True if context items were inserted or deleted
 */
export function checkForContextItemChanges(event) {
  if (!event?.changes?.delta) return false;

  for (const change of event.changes.delta) {
    if (change.insert) {
      const inserted = Array.isArray(change.insert) ? change.insert : [change.insert];
      for (const item of inserted) {
        if (item && typeof item === 'object' && typeof item.get === 'function') {
          // Mirror contextItemDescriptor's two discriminators (the single
          // source of truth for "is this a context item"): a direct context
          // item has an itemId but is not a tool-use/tool-action, and a
          // tool-action counts only when it produced a context result.
          // Keying the first branch off itemId alone matched EVERY item
          // (messages and tool-actions all carry one), so the tool-action
          // branch below was dead and non-context tool-actions falsely fired.
          if (item.get('itemId') && !item.get('toolUseId')) {
            return true;
          }
          if (item.get('type') === 'tool-action') {
            const result = item.get('result');
            if (result?.get?.('resultType') === 'context') {
              return true;
            }
          }
        }
      }
    }
    if (change.delete) {
      // Can't know what was deleted, but if we're deleting it might be a context item
      return true;
    }
  }
  return false;
}
