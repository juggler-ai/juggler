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
import { maybePromoteHandoffThread } from '../utils/compaction-utils.js';

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
      // without a reactive observer. Sub-threads carry a cloned system-prompt
      // item (a fresh id, seeded from the parent by the worker), never the
      // canonical SYSTEM_1.

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

      // /handoff completion: when this tab's handoff summary thread finishes,
      // promote its result into the parked first user message. Cheap scan,
      // fires both live (worker writes result) and on reload hydration.
      // Auto-compaction itself is now worker-side (turn-settle trigger), so the
      // browser no longer measures usage or fires /compact.
      if (isViewer()) {
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

    // Refresh cached derived state BEFORE any notify below. The general
    // conversation:changed is delivered synchronously (session._notify is a
    // plain listener loop) and drives a conversation-tab column rebuild that
    // repaints the bound strategy selector from root.currentStrategyId. That
    // cached field must already hold the new id, or the rebuild reads the stale
    // value, the selector's incoming===current guard skips its render, and a
    // remote strategy switch never shows until the next unrelated doc change.
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
    }

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

    if (event.keysChanged.has('currentStrategyId')) {
      c._session.notifyConversationChange('conversation:strategy-changed', {
        conversation: c,
        strategyId: c.getMetadata('currentStrategyId')
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
