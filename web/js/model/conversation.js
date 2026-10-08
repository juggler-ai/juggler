//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import ResponseHandler from '../services/response-handler.js';
import wsService from '../services/websocket.js';
import providersCache from '../services/providers-cache.js';
import recentModels from '../services/recent-models.js';
import { AbortError } from 'juggler/strategy-type';
import { DEFAULT_TRUNCATION_BUDGET } from 'juggler/context-item';
import { CHARS_PER_TOKEN } from '../utils/token-estimate.js';
import ConversationDocument from './conversation-document.js';
import slashCommandHandler from '../services/slash-command-handler.js';
import workerManager from '../services/worker-manager.js';
import toolExecutor from '../services/tool-executor.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { isConversationalItemType } from '../../sdk/lib/message.js';
import MessageThread from './message-thread.js';
import { plainToYMap, plain } from './item-accessor.js';
import { settleRunCancelled } from './run-records.js';
import { statusHoldsTurn } from './processing-status.js';
import strategyRegistry from '../registries/strategy-registry.js';
import contextItemRegistry from '../registries/context-item-registry.js';
import { TURN_CANCELLED_NOTICE } from '../utils/constants.js';
import { recordTape } from '../utils/event-tape.js';
import { ENGINE_DERIVED_ORIGIN } from '../utils/document-sync-manager.js';
import {
  findThreadForArray,
  findParentInArray,
  threadAncestry,
  walkThreads,
  findItemByIdRecursive,
  hasUnsettledToolInTree,
  hasPendingApprovalInTree
} from './thread-navigation.js';
import {
  saveAutoApprovalPermission,
} from './conversation-tool-actions.js';
import { setupYjsObservers } from './conversation-observers.js';
import { CONVERSATION_RULES_KEY, CONVERSATION_PATHS_KEY } from './message-thread-permissions.js';
import {
  waitForApproval as orchestrationWaitForApproval,
  continueThread as orchestrationContinueThread,
} from './conversation-orchestration.js';

/**
 * Doc-metadata key naming the workspace a conversation works in. The Go worker
 * reads the same key and puts it on every LLM request, so the turn's provider
 * is spawned where the conversation's work is (see `worker/workspace_binding.go`).
 */
export const WORKSPACE_ID_KEY = 'workspaceId';

/**
 * Doc-metadata key recording that a conversation's workspace has been chosen
 * and its root-relative seeding has run.
 */
export const INITIALISED_KEY = 'initialised';

/**
 * Doc-metadata key naming the tree the seeding pass has already been run
 * against — `''` for the project, absent for a conversation that has never been
 * seeded at all. Seeding happens before the binding does, so this is what says
 * whether the pass that would run at the binding has anything left to do.
 */
export const SEEDED_FOR_KEY = 'seededFor';

/**
 * Cancel-settle poll interval: how often _waitForCancellation re-checks
 * whether the worker and local actions have gone idle.
 */
const CANCEL_POLL_MS = 16;

/**
 * Hard ceiling on the cancel-settle wait so a wedged worker doesn't hang
 * the UI forever. Cancel + idle normally completes in <100ms.
 */
const CANCEL_CEILING_MS = 5000;

/**
 * The share of the model's context window a single tool result may occupy.
 * {@link DEFAULT_TRUNCATION_BUDGET} against a 200k window, so a model of that
 * size is bounded exactly as the flat constant bounded it.
 */
const TOOL_RESULT_WINDOW_FRACTION = 0.0375;

/**
 * Ceiling on a single tool result whatever the window claims. Past this a read
 * is costing more to carry for the rest of the conversation than reading the
 * rest of the file later would cost, and an implausible window figure from a
 * provider cannot turn one result into the whole request.
 */
const MAX_TRUNCATION_BUDGET = 200000;

/**
 * @typedef {import('./session.js').default} Session
 */

/**
 * @typedef {import('../../sdk/lib/message.js').Message} Message
 */

/**
 * Model configuration: a concrete (provider, model) pair.
 * @typedef {object} ModelConfig
 * @property {string} [provider] - Provider name (e.g., 'anthropic', 'openai', 'google')
 * @property {string} [model] - Model identifier (e.g., 'claude-sonnet-4-20250514')
 * @property {string} [thinking] - Optional canonical thinking level ('off'|'low'|'medium'|'high'|'max'); absent ⇒ provider default. Inherits atomically with the model down the thread tree.
 */

/**
 * Execute permission pattern entry
 * @typedef {object} ExecutePermissionPattern
 * @property {string} pattern - The pattern string (e.g., 'npm *', 'git *')
 * @property {boolean} enabled - Whether this pattern is currently enabled
 */

/**
 * Conversation permissions configuration
 * @typedef {object} ConversationPermissions
 * @property {boolean} writeFile - Whether file writes are auto-approved
 * @property {ExecutePermissionPattern[]} execute - Shell command patterns that are auto-approved
 */

/**
 * Conversation - Represents a single conversation thread
 *
 * Each conversation owns its own ResponseHandler to ensure complete
 * isolation between concurrent conversations.
 *
 * ARCHITECTURE:
 * - conversation.items[] is the single source of truth (messages + transaction markers)
 * - Transaction markers are embedded in the list when LLM calls complete
 * - getMessages() and getTransactions() filter items[] to return each type
 * - Streaming and tool execution are managed directly by the Conversation class
 * - ResponseHandler processes tool calls and manages the agentic loop
 * @class
 */

class Conversation {
  /**
   * @param {string} id - Unique conversation ID
   * @param {string} name - Display name
   * @param {Session} session - Parent session
   * @param {object} services - Required services
   * @param {import('../services/llm-state.js').default} services.llmState
   * @param {import('../services/action-executor.js').default} services.actionExecutor - Action executor for cancellation
   * @param {object} [options] - Optional configuration
   * @param {boolean} [options.isTransient=false] - If true, conversation won't be persisted to backend
   * @param {string} [options.strategyId] - Strategy ID to use (defaults to 'default')
   * @param {boolean} [options.skipBuiltInContextItems=false] - If true, skip initializing built-in context items (for loaded conversations)
   * @param {'unloaded'|'loading'|'loaded'|'error'} [options.loadState='loaded'] - Initial lazy-load lifecycle state. Stubs created during session bootstrap pass 'unloaded'; freshly-created conversations default to 'loaded'.
   * @param {string} [options.workspaceId] - The tree this conversation is being created to work in. Reported as its binding until the durable one is written — see {@link Conversation#workspaceId}.
   */
  constructor(id, name, session, services, options = {}) {
    // Identity
    /** @type {string} */
    this.id = id;

    /** @type {Session} */
    this._session = session;

    // Seed the session's name cache so `this.name` (a getter) resolves
    // for newly-created conversations before the next GET /api/session
    // refresh. The on-disk folder name (resolved server-side by
    // ScanConvDirs and shipped as `conversationNames`) is the source of
    // truth; this cache is its in-memory projection.
    if (name && session && !session.getConversationName(id)) {
      session.setConversationName(id, name);
    }

    /** @type {string} */
    this.created = new Date().toISOString();

    /** @type {boolean} - If true, this conversation is not persisted to backend */
    this._isTransient = options.isTransient || false;

    /** @type {'unloaded'|'loading'|'loaded'|'error'} @private - per-client lazy-load state, not Yjs */
    this._loadState = options.loadState || 'loaded';

    /** @type {string} @private - the workspace it was created for, until the doc carries one */
    this._createdForWorkspaceId = typeof options.workspaceId === 'string' ? options.workspaceId : '';

    // Data - all state lives in Yjs document (use getters/setters for access)
    /** @type {ConversationDocument} - Yjs document for main thread (source of truth for conversation state) */
    this._doc = new ConversationDocument(id, 'user:main');

    /** @type {MessageThread} - Root message thread (operates on _doc.root) */
    this._rootMessageThread = new MessageThread(this, this._doc.root, null, options.strategyId);


    /** @type {Set<string>} @private - Tool-actions with handleNewToolAction in flight */
    this._handlingNewToolAction = new Set();

    /** @type {boolean} @private - Flag to prevent observers from firing during construction */
    this._initializing = true;

    // Initialize document as client (no UndoManager, sync only)
    // and set up Yjs observers
    this._setupYjsObservers();

    // LLM call state
    /** @type {number} - Current iteration in agentic loop */
    this._iterationCount = 0;

    // Permission system - controls auto-approval of actions.
    // permissions is a getter that reads from Yjs metadata (no stored field).

    // Services
    /** @type {import('../services/llm-state.js').default} */
    this._llmState = services.llmState;

    /** @type {import('../services/action-executor.js').default} @private */
    this._actionExecutor = services.actionExecutor;

    /** @type {import('../components/conversation-tab.js').default|null} @private */
    this._tabElement = null;

    // Each conversation owns its own ResponseHandler so streaming state
    // can't bleed across conversations.

    /** @type {ResponseHandler} */
    this._responseHandler = new ResponseHandler({
      conversation: this
    });

    // State change listeners for event-based approval waiting
    // Transient (not persisted) - used to wake up waitForApproval() callers
    /** @type {Set<() => void>} @private */
    this._stateChangeListeners = new Set();

    // Yjs observers for automatic event emission (stored for cleanup)
    /** @type {((events: any[], transaction: any) => void)|null} @private */
    this._yjsItemsObserver = null;
    /** @type {((event: any) => void)|null} @private */
    this._yjsMetadataObserver = null;

    /** @type {boolean} @private - Guard flag to prevent recursive observer calls */
    this._inItemsObserver = false;

    // Initialize built-in context items (system prompt)
    // Skip for loaded conversations - items come from worker Yjs sync
    if (!options.skipBuiltInContextItems) {
      this._initBuiltInContextItems();
    }

    // Mark initialization as complete - observers can now fire
    this._initializing = false;
  }

  // ========================================================================
  // YJS OBSERVERS AND SYNCHRONIZATION
  // ========================================================================
  // Observer wiring lives in conversation-observers.js. The factory below
  // installs items + metadata observers on c._doc and returns a cleanup
  // function. The class stores the returned cleanup as _yjsCleanup.

  _setupYjsObservers() {
    this._yjsCleanup = setupYjsObservers(this);
  }


  /**
   * Save auto-approval permission for a 'yes-always' response.
   * @param {any} ymap - The tool-action Y.Map
   * @param {import('./message-thread.js').default} messageThread
   */
  _saveAutoApprovalPermission(ymap, messageThread) {
    saveAutoApprovalPermission(this, ymap, messageThread);
  }



  // ── Thread Navigation (thin wrappers around thread-navigation.js) ──

  /**
   * Resolve which MessageThread contains a given Y.Map item.
   * @param {*} ymap - The Y.Map item
   * @returns {MessageThread} The matching message thread
   */
  _resolveMessageThreadForMap(ymap) {
    const parent = ymap?.parent;
    return parent ? this._resolveMessageThreadForArray(parent) : this._rootMessageThread;
  }

  /**
   * Resolve which MessageThread owns the given Y.Array.
   * @param {*} yarray - The Y.Array that fired the event
   * @returns {MessageThread} The matching message thread
   */
  _resolveMessageThreadForArray(yarray) {
    const rootArr = this._doc.root.get('items');
    if (yarray === rootArr) return this._rootMessageThread;
    const found = findThreadForArray(rootArr, yarray);
    if (found) return new MessageThread(this, found, found.get('itemId'));
    return this._rootMessageThread;
  }

  /**
   * Find the parent thread's Y.Map for a given threadItemId.
   * @param {string} threadItemId - Thread item ID
   * @returns {*|null} The parent thread Y.Map, or null if at root
   */
  findParentContainer(threadItemId) {
    return findParentInArray(this._rootMessageThread.yarray, threadItemId);
  }

  /**
   * Get all MessageThread instances: root + nested threads.
   * @returns {MessageThread[]} All message threads
   */
  getAllMessageThreads() {
    /** @type {MessageThread[]} */
    const threads = [this._rootMessageThread];
    this._forEachThreadContext(thread => threads.push(thread));
    return threads;
  }

  /**
   * Walk all thread contexts, calling callback for each.
   * @param {(thread: MessageThread) => void} callback
   * @private
   */
  _forEachThreadContext(callback) {
    walkThreads(this._rootMessageThread.items, (threadYMap) => {
      callback(new MessageThread(this, threadYMap, threadYMap.get('itemId')));
    });
  }

  /**
   * Find an item by itemId across the entire thread tree.
   * @param {string} id - Item ID to find
   * @returns {*|null} Y.Map or null
   */
  findItemById(id) {
    return findItemByIdRecursive(this._rootMessageThread.items, id);
  }

  /**
   * Resolve the MessageThread for a given threadItemId.
   * @param {string|null|undefined} threadItemId - Thread item ID, or null/undefined for root
   * @returns {MessageThread} The matching message thread
   */
  resolveMessageThread(threadItemId) {
    if (!threadItemId) {
      return this._rootMessageThread;
    }
    const threadItem = this.findItemById(threadItemId);
    if (threadItem && threadItem.get('type') === 'thread') {
      return new MessageThread(this, threadItem, threadItemId);
    }
    throw new Error(`[BUG] Thread item not found: ${threadItemId}`);
  }

  /**
   * Find the MessageThread that contains a tool-action with the given toolUseId.
   * Searches root items, then thread items.
   * @param {string} toolUseId
   * @returns {MessageThread|null} The MessageThread containing the tool-action, or null
   */
  findMessageThreadForToolUse(toolUseId) {
    // Check root items
    for (const item of this._rootMessageThread.items) {
      if (item.get('type') === 'tool-action' && item.get('toolUseId') === toolUseId) {
        return this._rootMessageThread;
      }
    }
    // Search all threads recursively
    /** @type {MessageThread|null} */
    let found = null;
    this._forEachThreadContext(thread => {
      if (found) return;
      for (const item of thread.items) {
        if (item.get('type') === 'tool-action' && item.get('toolUseId') === toolUseId) {
          found = thread;
          return;
        }
      }
    });
    return found;
  }

  /**
   * Whether this conversation has any content. A conversation has content
   * once any item has been stamped with a transactionId (i.e. at least one
   * LLM round-trip has run).
   * @returns {boolean} True if conversation has at least one stamped item
   */
  hasContent() {
    for (const item of this._rootMessageThread.items) {
      if (item.get?.('transactionId')) return true;
    }
    return false;
  }

  /**
   * Whether this conversation has a first root user message the auto-namer can
   * derive a conversation title from. Mirrors the worker's `firstRootUserMessageText`:
   * the first root-level user item, non-empty once its text is trimmed. False
   * for a freshly created tab with no messages yet (or an image-only first
   * message), so callers can hide the "auto-name now" control when it would be
   * a no-op.
   * @returns {boolean} True if there is a non-empty first user message.
   */
  hasAutoNameSource() {
    for (const item of this._rootMessageThread.items) {
      if (item.get?.('type') === 'user') {
        return (item.get?.('content') || '').trim() !== '';
      }
    }
    return false;
  }

  /**
   * Whether the root items Y.Array exists in this client's document yet. The
   * worker creates it and it arrives over sync, so a caller that must not race
   * that (see ConversationLoader#_waitForItemsArray) waits on this rather than
   * reaching into the document.
   * @returns {boolean} True once the root items array is present.
   */
  get hasRootItemsArray() {
    return !!this._doc?.root?.get('items');
  }

  /**
   * Read-only accessor for the root items array.
   * Used for rendering bootstrap (e.g., connection-manager on reconnect).
   * @returns {Array<any>} Root items array
   */
  get rootItems() {
    return this._rootMessageThread.items;
  }

  /**
   * Human-readable conversation name. Derived from the session-level
   * `_conversationNames` cache, which mirrors the on-disk folder name
   * shipped by GET /api/session.
   * @returns {string} Current display name, or '' if not yet known.
   */
  get name() {
    return this._session ? this._session.getConversationName(this.id) : '';
  }

  /**
   * The current model config, read from Yjs metadata via the root message thread.
   * @returns {any} The model config object
   */
  get modelConfig() {
    return this._rootMessageThread.modelConfig;
  }

  /**
   * The root MessageThread for this conversation.
   * @returns {import('./message-thread.js').default} The root message thread
   */
  get rootMessageThread() {
    return this._rootMessageThread;
  }

  /**
   * Whether this conversation is parked on a tool approval anywhere in its tree.
   *
   * This is the subtraction that turns the published status into a useful notion
   * of "busy". The worker keeps publishing `processing_tools` for the whole time
   * the user deliberates over an approval, so a status check alone reports a
   * parked conversation as busy indefinitely — it executes nothing and can sit
   * there for as long as the user likes. The server's own activity signal
   * (GET /api/health/active) subtracts exactly this case; callers that must
   * agree with it read this rather than re-deriving it.
   *
   * The whole tree is searched, so an approval parked deep inside a sub-thread
   * still counts.
   * @returns {boolean} True while a tool-action anywhere below is awaiting approval
   */
  isAwaitingApproval() {
    return hasPendingApprovalInTree(this.rootMessageThread?.items);
  }

  /**
   * Get config data needed to initialize a worker. The model is the only piece
   * of conversation state init carries: strategy, permission rules and allowed
   * paths all live in the Yjs doc and reach the worker by sync, so sending them
   * here would only be a second, ignored copy of them.
   * @returns {{modelConfig: any}} Worker init data
   */
  getWorkerInitData() {
    return {
      modelConfig: this._rootMessageThread.modelConfig || null
    };
  }

  /**
   * Restore strategy from worker-loaded metadata.
   * @param {string} strategyId
   */
  restoreStrategyFromWorker(strategyId) {
    // The metadata observer handles strategy instance creation.
    // This just ensures the in-memory state is consistent during
    // initial load when metadata is applied via worker sync.
    const root = this._rootMessageThread;
    if (strategyId && strategyId !== root.currentStrategyId) {
      root.currentStrategyId = strategyId;
      root.strategy = strategyRegistry.createStrategy(strategyId, root);
    }
  }

  /**
   * Restore metadata from worker-loaded conversation.
   *
   * IMPORTANT: do NOT write modelConfig back to Yjs here. The worker just
   * loaded its doc from disk and is broadcasting that state via yjs-sync;
   * by the time the loader's loadExisting calls this, the local doc already has the
   * worker's modelConfig (flushPendingUpdates was just called). Writing it
   * again produces a redundant Yjs update that RACES against concurrent
   * writers: a viewer auto-loading the conversation would write its stale
   * modelConfig back over a `set-model` another viewer makes at the same
   * moment, leaving the wrong modelConfig in the document. yjs-sync
   * delivers the authoritative value; no JS-side write needed.
   * @param {{modelConfig?: any, currentStrategyId?: string}} metadata
   */
  restoreWorkerMetadata(metadata) {
    if (metadata.currentStrategyId) {
      this.restoreStrategyFromWorker(metadata.currentStrategyId);
    }
  }

  /**
   * Run a user-driven delete with full orchestration: cancels pending
   * approvals, stops processing, seals the undo group around the delete, and
   * announces a span removal so the column footer can offer an undo.
   *
   * Every user-facing multi-item delete goes through here, so the announcement
   * cannot be forgotten by a new call site.
   *
   * Intentionally does NOT call `cancelAndSettle()` — that would also
   * cancel any in-flight tool actions, but rerun/edit flows orchestrate
   * an action *immediately after* this delete and would have it cancelled
   * out from under them. Only the LLM turn is stopped here; deletion of
   * specific items is the caller's contract.
   * @param {import('./message-thread.js').default} messageThread
   * @param {() => number} deleteFn - Performs the delete, returns items removed
   * @returns {number} How many items were deleted
   * @private
   */
  _deleteWithCleanup(messageThread, deleteFn) {
    messageThread.cancelPendingApprovals();

    if (this._llmState &&
            this._llmState.isConversationProcessing(this.id)) {
      this.stopProcessing('items deleted');
    }

    // Seal the undo group on both sides. The worker's UndoManager merges
    // whatever lands inside its capture window, so without this the delete can
    // share a group with an unrelated neighbouring edit — and an Undo offer
    // that silently reverses one of those too is worse than no offer at all.
    workerManager.stopUndoCapturing(this.id);
    const removed = deleteFn();
    workerManager.stopUndoCapturing(this.id);

    // Every delete that took something out is offered back, one item included:
    // rewinding to a last message that never got its reply removes exactly
    // one, and a rewind with no confirmation reads as one that did nothing.
    if (removed > 0) {
      this._session?.notifyConversationChange?.('conversation:items-removed', {
        conversation: this,
        messageThread,
        removed,
      });
    }
    return removed;
  }

  /**
   * Delete items from fromIndex to end (inclusive) with full cleanup.
   * @param {import('./message-thread.js').default} messageThread
   * @param {number} fromIndex
   * @returns {number} How many items were deleted
   */
  deleteRangeWithCleanup(messageThread, fromIndex) {
    return this._deleteWithCleanup(messageThread, () => messageThread.deleteRange(fromIndex));
  }

  /**
   * Delete every user-deletable item after index (exclusive) with full cleanup.
   * @param {import('./message-thread.js').default} messageThread
   * @param {number} index
   * @returns {number} How many items were deleted
   */
  deleteAfterWithCleanup(messageThread, index) {
    return this._deleteWithCleanup(messageThread, () => messageThread.deleteAfter(index));
  }

  /**
   * Delete every user-deletable item before index (exclusive) with full cleanup.
   * @param {import('./message-thread.js').default} messageThread
   * @param {number} index
   * @returns {number} How many items were deleted
   */
  deleteUpToWithCleanup(messageThread, index) {
    return this._deleteWithCleanup(messageThread, () => messageThread.deleteUpTo(index));
  }

  /**
   * Cancel all pending approvals across root and all threads.
   */
  cancelAllPendingApprovals() {
    // Cancel in root and all threads recursively
    this._rootMessageThread.cancelPendingApprovals();
    this._forEachThreadContext(thread => thread.cancelPendingApprovals());
  }


  // =========================================================================
  // Strategy/LLM Orchestration — delegates to ./conversation-orchestration.js
  // =========================================================================

  /**
   * @param {import('./message-thread.js').default} mt
   * @param {string} toolUseId
   * @returns {Promise<string>} 'yes', 'no', 'yes-always', or 'cancel'
   */
  async waitForApproval(mt, toolUseId) { return orchestrationWaitForApproval(this, mt, toolUseId); }

  /**
   * @param {import('./message-thread.js').default} mt
   * @param {(() => void)} [beforeContinue] - Run only if the continue goes ahead.
   * @returns {Promise<boolean>} True when a continuation was dispatched
   */
  async continueThread(mt, beforeContinue) { return orchestrationContinueThread(this, mt, beforeContinue); }

  /** @private */
  _initBuiltInContextItems() {
    this._rootMessageThread.initBuiltInContextItems();
  }

  /**
   * Whether ANY of this conversation's threads is currently processing.
   *
   * The conversation-wide question: is there work here at all. Several threads
   * can be running at once — a parent and its read-only children — so a caller
   * deciding what to do about ONE thread (send to it, continue it, offer it a
   * button) must ask isThreadProcessing instead, or a busy sibling refuses work
   * the worker would have taken.
   * @returns {boolean} Whether the conversation is currently processing
   */
  get isProcessing() {
    return this._llmState.isConversationProcessing(this.id);
  }

  /**
   * Whether ONE thread is currently being driven.
   * @param {string|null} [threadItemId] - Thread item id (null/omitted = root)
   * @returns {boolean} True while that thread has a run in flight
   */
  isThreadProcessing(threadItemId) {
    return this._llmState.isThreadProcessing(this.id, threadItemId ?? null);
  }

  // ========================================================================
  // BASIC GETTERS AND STATE ACCESS
  // ========================================================================

  /**
   * Get parent session
   * @returns {Session} Parent session instance
   */
  get session() {
    return this._session;
  }

  /**
   * Whether this conversation is a local scratch copy that is never persisted
   * to the backend (and so never appears in the saved conversation order).
   * @returns {boolean} True for a transient conversation.
   */
  get isTransient() {
    return this._isTransient;
  }

  /**
   * Lazy-load lifecycle state (per-client view state, not Yjs).
   * @returns {'unloaded'|'loading'|'loaded'|'error'} Current state in the lazy-load FSM
   */
  get loadState() {
    return this._loadState;
  }

  /**
   * Current worker processing state from the Yjs doc metadata.
   * Includes `activity` ('' | 'calling_llm' | 'awaiting_llm'), `status`, and the
   * Pause projection — `politeStops` (one entry per paused thread, each
   * reporting whether it has `landed`) and its conversation-wide `politePending`
   * alias, the server-authoritative source for the "Pausing…" and "Paused" cues
   * across reloads.
   * Read-only — the worker is the sole writer.
   * @returns {{activity?: string, status?: string, [key: string]: unknown} | undefined} Plain object snapshot of the worker's processingState, or undefined when nothing has been written yet
   */
  get processingState() {
    if (!this._doc) return undefined;
    const raw = this._doc.metadata.get('processingState');
    if (!raw) return undefined;
    return plain(raw);
  }

  /**
   * Monotonic count of worker turns that have completed (reached idle). The
   * worker bumps it atomically on every idle transition (see
   * cmd/juggler/worker/worker.go sendStatus), so it is a durable fence that
   * survives Yjs sync batching: even when a fast turn's busy→idle window
   * coalesces into a single broadcast, this value still advances. Observe
   * *this* to detect "a turn happened" — never the transient `status` edge,
   * which can be batched away entirely.
   * @returns {number} Completed-turn count (0 before the worker first idles)
   */
  get completedTurns() {
    return Number(this._doc?.metadata.get('completedTurns')) || 0;
  }

  /**
   * Character budget for a single tool result's LLM-facing output. Items read
   * it through `ContextItem#truncationBudget()` / `truncateForLLM()` rather
   * than reaching in here, so the conversation stays the one place the budget
   * can grow a policy (per-model window, per-turn call count).
   *
   * The budget is a share of the model's own window, floored at the default so
   * a small or unreported window behaves as it always has. One result may take
   * {@link TOOL_RESULT_WINDOW_FRACTION} of the window, which is what 30k chars
   * is to the 200k window the constant was chosen against — held steady, a
   * model with room to spare reads a large file in one call instead of paging
   * through it, and a turn's worth of reads still cannot crowd out the
   * conversation.
   * @returns {number} Maximum characters of tool output to hand the LLM
   */
  get truncationBudget() {
    const window = Number(this.contextWindow);
    if (!Number.isFinite(window) || window <= 0) return DEFAULT_TRUNCATION_BUDGET;
    const scaled = Math.round(window * CHARS_PER_TOKEN * TOOL_RESULT_WINDOW_FRACTION);
    return Math.min(MAX_TRUNCATION_BUDGET, Math.max(DEFAULT_TRUNCATION_BUDGET, scaled));
  }

  /**
   * Transition the lazy-load lifecycle and notify the session so listeners
   * (tab bar, conversation panel) can re-render. No-op when the state is
   * unchanged.
   * @param {'unloaded'|'loading'|'loaded'|'error'} state
   */
  setLoadState(state) {
    if (this._loadState === state) return;
    this._loadState = state;
    this._session?.notifyConversationChange?.('conversation:loadstate-changed', {
      conversationId: this.id,
      loadState: state
    });
  }

  /**
   * Set the tab element that shows this conversation, and start the status
   * observer that turns worker processing-state frames into LLM status.
   *
   * The conversation writes nothing into the tab or its columns. The tab hands
   * its own columns the conversation, paints status from its own subscription
   * to {@link onStatusChange}, and scrolls on `conversation:turn-requested`.
   * @param {import('../components/conversation-tab.js').default} tabElement
   */
  setTabElement(tabElement) {
    this._tabElement = tabElement;
    this._llmState.registerConversation(this);
  }

  /**
   * Get the tab element for this conversation
   * @returns {import('../components/conversation-tab.js').default|null} Tab element or null
   */
  getTabElement() {
    return this._tabElement;
  }

  /**
   * Get the composer element for this conversation
   * @returns {HTMLElement|null} Composer element or null
   *     */
  _getComposer() {
    if (!this._tabElement) {
      return null;
    }
    return this._tabElement.getComposer();
  }

  /**
   * The thread-item id an composer is currently bound to (null for root),
   * or null when there is no box.
   * @param {any} composer
   * @returns {string|null} The bound thread-item id, or null.
   * @private
   */
  _composerThreadId(composer) {
    return (composer && 'threadItemId' in composer) ? (composer.threadItemId ?? null) : null;
  }

  /**
   * The thread-item id a send is targeting (null for root), taking the
   * MessageThread when given and falling back to the explicit id.
   * @param {import('./message-thread.js').MessageThread|null|undefined} messageThread
   * @param {string|null} threadItemId
   * @returns {string|null} The targeted thread-item id, or null for root.
   * @private
   */
  _targetThreadId(messageThread, threadItemId) {
    return (messageThread?.threadItemId ?? threadItemId) ?? null;
  }

  // ========== APPROVAL MANAGEMENT ==========

  /**
   * Enable auto-approve mode for headless testing.
   * When enabled, all approval requests are immediately granted.
   * @param {boolean} enabled - Whether to auto-approve all actions
   */
  setAutoApprove(enabled) {
    this._autoApprove = enabled;
  }

  // ========== APPROVAL MANAGEMENT ==========

  /**
   * @returns {Promise<void>} Resolves on next state change
   *     */
  _waitForStateChange() {
    return new Promise(resolve => {
      /** @type {() => void} */
      const listener = () => {
        this._stateChangeListeners.delete(listener);
        resolve();
      };
      this._stateChangeListeners.add(listener);
    });
  }

  _emitStateChange() {
    for (const listener of this._stateChangeListeners) {
      listener();
    }
  }

  /**
   * Re-run a tool action. Resets it locally and re-evaluates immediately.
   * Also tells the worker (for batchCompleteSignal reset if strategy loop is active).
   * @param {string} toolUseId - The tool use to re-run
   */
  async retryToolApproval(toolUseId) {
    // Tools whose result IS the user's input (e.g. AskUserQuestion) must be
    // re-asked on re-run, not silently replayed with the stored answer. Ask
    // the owning plugin which behaviour applies.
    const ActionClass = this._toolActionClass(toolUseId);
    if (ActionClass?.rerunRequiresReprompt?.()) {
      // Re-ask path: worker resets to 'pending' and clears result +
      // approvalResponse so the approval/question UI re-renders. The user's
      // fresh answer then drives execution exactly like a first-time ask.
      workerManager.retryToolApproval(this.id, toolUseId);
      return;
    }
    // Re-run path: worker clears the result (the "has been run" flag) and
    // sets state='approved'. The document change triggers the observer which
    // re-evaluates and re-executes the tool.
    workerManager.retryToolAction(this.id, toolUseId);
  }

  /**
   * Resolve the context-item plugin class that owns a tool-action. Public
   * accessor for UI (e.g. the properties panel gating the Re-run control on
   * {@link ContextItem.isRerunnable}). Delegates to {@link _toolActionClass}.
   * @param {string} toolUseId
   * @returns {any} The plugin class, or undefined if not found
   */
  toolActionClass(toolUseId) {
    return this._toolActionClass(toolUseId);
  }

  /**
   * Resolve the context-item plugin class that owns a tool-action, searching
   * all threads (the tool-action may live in a sub-thread).
   * @param {string} toolUseId
   * @returns {any} The plugin class, or undefined if not found
   * @private
   */
  _toolActionClass(toolUseId) {
    for (const thread of this.getAllMessageThreads()) {
      const toolAction = thread.getToolAction(toolUseId);
      if (toolAction) {
        return contextItemRegistry.getByToolName(toolAction.get('toolName'));
      }
    }
    return undefined;
  }

  // ========================================================================
  // Undo/Redo (Yjs CRDT operations)
  // ========================================================================

  /**
   * Undo the last operation in the conversation
   * @returns {Promise<boolean>} True if undo was successful
   */
  async undo() {
    if (!workerManager.isWorkerReady(this.id)) {
      return false;
    }
    const result = await workerManager.undo(this.id);
    // Flush any pending Yjs updates so state is current after undo
    this._doc.flushPendingUpdates();
    return result;
  }

  /**
   * Apply every sync update that has arrived but is still sitting in the
   * document's batch timer, so the caller reads the freshest doc.
   *
   * The escape hatch for code that must act on state the worker pushed ahead of
   * a command through the same ordered mailbox: applySyncUpdate batches behind a
   * timer, so without this the item the command refers to may have arrived and
   * not yet been applied.
   * @returns {void}
   */
  flushPendingSyncs() {
    this._doc?.flushPendingUpdates?.();
  }

  /**
   * Redo the last undone operation
   * @returns {Promise<boolean>} True if redo was successful
   */
  async redo() {
    if (!workerManager.isWorkerReady(this.id)) {
      return false;
    }
    const result = await workerManager.redo(this.id);
    // Flush any pending Yjs updates so state is current after redo
    this._doc.flushPendingUpdates();
    return result;
  }

  /**
   * Check if undo is available - Query worker for undo state
   * @returns {boolean} True if can undo
   */
  canUndo() {
    // Query worker manager for cached undo state
    // Worker is the source of truth for undo (main thread has no UndoManager)
    return workerManager.canUndo(this.id);
  }

  /**
   * Check if redo is available - Query worker for redo state
   * @returns {boolean} True if can redo
   */
  canRedo() {
    // Query worker manager for cached redo state
    // Worker is the source of truth for undo (main thread has no UndoManager)
    return workerManager.canRedo(this.id);
  }

  // ========================================================================
  // Message Editing (Pure Yjs CRDT operations)
  // ========================================================================

  /**
   * Get response handler
   * @returns {ResponseHandler} Response handler instance
   */
  get responseHandler() {
    return this._responseHandler;
  }

  // =========================================================================
  // Metadata Observation API (delegates to _doc)
  // =========================================================================

  /**
   * Observe metadata changes on the conversation document
   * @param {(event: any, transaction: any) => void} callback
   */
  observeMetadata(callback) {
    this._doc.observeMetadata(callback);
  }

  /**
   * Stop observing metadata changes
   * @param {(event: any, transaction: any) => void} callback
   */
  unobserveMetadata(callback) {
    this._doc.unobserveMetadata(callback);
  }

  /**
   * Get a metadata value by key
   * @param {string} key
   * @returns {any} The metadata value
   */
  getMetadata(key) {
    return this._doc.metadata.get(key);
  }

  /**
   * Set a metadata value. Authored under the conversation's authorId.
   * @param {string} key
   * @param {*} value
   */
  setMetadata(key, value) {
    this._doc.setMetadata(key, value);
  }

  /**
   * Get all metadata entries as an iterator
   * @returns {IterableIterator<[string, any]>} Metadata entries
   */
  getMetadataEntries() {
    return this._doc.metadata.entries();
  }

  /**
   * The workspace this conversation works in — where its tools run and where
   * its provider is spawned. `''` is the project itself, which is what every
   * conversation meant before workspaces existed.
   *
   * It lives in doc metadata, so it rides a clone (the server copies doc.yjs
   * whole) and sits outside the UndoManager's `items` scope — no undo can take
   * a conversation's workspace away from it mid-turn.
   *
   * Until that metadata is written, a conversation created for a workspace
   * answers with the workspace it was created for. The write happens once the
   * worker has spawned, and a conversation is in the session's map — and so in
   * the tab bar, which groups the strip by this very answer — several renders
   * before that. Without the fallback those renders draw a new tab flat in the
   * strip and its box a member short, and the tab then jumps into the box a
   * moment later. So placing a conversation and binding it have to be one
   * transaction, and the doc write is the slower half of it.
   * @returns {string} The bound workspace id, or '' for the project.
   */
  get workspaceId() {
    const id = this.getMetadata(WORKSPACE_ID_KEY);
    if (typeof id === 'string') return id;
    return this._createdForWorkspaceId;
  }

  /**
   * Bind this conversation to a workspace. Written once, when the conversation
   * is initialised — see {@link Session#initialiseConversation}, which is the
   * only thing that should call this.
   * @param {string} id - The workspace id, or '' for the project.
   */
  set workspaceId(id) {
    this.setMetadata(WORKSPACE_ID_KEY, typeof id === 'string' ? id : '');
  }

  /**
   * The directory this conversation works in, resolved from its binding against
   * the session's workspace table.
   *
   * `null` means the binding cannot be honoured — the workspace is still being
   * built, was closed, has lost its root, or the session has never heard of it.
   * That is not the same as the project, and must never be treated as it:
   * running in the project root because a binding went stale edits the wrong
   * tree and looks exactly like working. See {@link Session#workspaceRoot},
   * which refuses the same four ways the server does.
   * @returns {string|null} The root to work in, or null if the binding is unusable.
   */
  get workspaceRoot() {
    return this.session.workspaceRoot(this.workspaceId);
  }

  /**
   * Whether a provider spawned as a subprocess would run in the right place for
   * this conversation. See {@link Session#workspaceHostsLocalProviders}: it is
   * the model picker's question, asked of where this conversation works.
   * @returns {boolean} True when a CLI provider can serve this conversation.
   */
  get workspaceHostsLocalProviders() {
    return this.session.workspaceHostsLocalProviders(this.workspaceId);
  }

  /**
   * Whether this conversation has been initialised: its workspace chosen and
   * its root-relative seeds run.
   *
   * An explicit flag rather than an inference from the document, because both
   * tempting inferences are wrong. An EMPTY system-prompt item is the most
   * common fully-initialised state (the default preset writes nothing), and an
   * ABSENT one is what `worker-manager.js`'s merge-race guard exists to treat
   * as a fault — if absence became legal, that guard could no longer tell a
   * conversation waiting to be seeded from one that lost its system prompt.
   * @returns {boolean} True once the conversation has been initialised.
   */
  get initialised() {
    return this.getMetadata(INITIALISED_KEY) === true;
  }

  /**
   * @param {boolean} value - True once the seeds have run.
   */
  set initialised(value) {
    this.setMetadata(INITIALISED_KEY, value === true);
  }

  /**
   * Whether this conversation has yet to be recorded as initialised, which is
   * what the root-relative passes wait for.
   *
   * Not merely the absence of {@link initialised}, because that absence is also
   * what every conversation written before the flag existed looks like. Those
   * have history behind them and a binding that resolves to the project, which
   * is where they have always worked — the choice was made, and the only thing
   * left to do about it is {@link ensureInitialised} recording that it was. A
   * conversation with something in it is never asked this.
   * @returns {boolean} True while the conversation still has to choose.
   */
  get awaitingSetup() {
    if (this.initialised) return false;
    return !this._hasConversationalHistory();
  }

  /**
   * The tree this conversation's seeds were built for, or null if they never
   * have been.
   *
   * Distinct from {@link initialised}, and deliberately so: the seeds are built
   * for whichever tree is on offer, which is a question answered long before the
   * conversation commits to working anywhere. When the two agree at binding
   * time, the pass has already run against the right tree and must not run
   * again — re-running it would resurrect seeds the user deleted while looking
   * at them.
   * @returns {string|null} A workspace id, `''` for the project, or null.
   */
  get seededFor() {
    const value = this.getMetadata(SEEDED_FOR_KEY);
    return typeof value === 'string' ? value : null;
  }

  /**
   * @param {string|null} value - The tree just seeded for, or null to forget.
   */
  set seededFor(value) {
    this.setMetadata(SEEDED_FOR_KEY, typeof value === 'string' ? value : null);
  }

  /**
   * The tree this conversation works in, or — before it is bound to anything —
   * the one it is about to.
   *
   * The binding is the answer for every conversation that has one, and the only
   * answer anything durable may use. An unbound conversation is a different
   * case: it is showing the context its first turn would carry, built out of the
   * tree currently on offer, and a reader of those items that resolved them
   * against the project instead would show the right filenames holding the wrong
   * bytes.
   * @returns {string} A workspace id, or '' for the project.
   */
  get workingWorkspaceId() {
    if (this.initialised) return this.workspaceId;
    // An uninitialised conversation is one written before the flag existed. Its
    // seeds, if it has any, were built for whatever it was seeded against; its
    // binding is the answer for everything else.
    return this.seededFor ?? this.workspaceId;
  }

  /**
   * Where {@link workingWorkspaceId} lands on disk, with the same null-means-
   * refuse contract as {@link workspaceRoot}.
   * @returns {string|null} The root, or null if it cannot be honoured.
   */
  get workingWorkspaceRoot() {
    const id = this.workingWorkspaceId;
    return id === this.workspaceId ? this.workspaceRoot : (this.session?.workspaceRoot?.(id) ?? null);
  }

  /**
   * Initialise this conversation if it has not been already: the commit hop
   * every path that puts content into a conversation takes first, so the
   * seeding runs against the workspace the conversation is going to work in
   * rather than whichever one it was created next to.
   *
   * Idempotent and safe to race — an already-initialised conversation returns
   * immediately, and concurrent callers share the one in-flight pass.
   * @returns {Promise<void>}
   */
  async ensureInitialised() {
    if (this.initialised) return;

    // A conversation with history behind it was initialised long before the
    // flag existed — every conversation already on disk is in exactly this
    // state, and seeding one again would resurrect the items its user had
    // deleted and clear the undo history behind their work. Record what is
    // already true instead, so it is only ever asked once.
    if (this._hasConversationalHistory()) {
      this.initialised = true;
      return;
    }

    // Everything else is a conversation from before the flag with nothing in it
    // yet. It works where it is bound, which it has been since it was created.
    await this.session?.initialiseConversation?.(this);
  }

  /**
   * Whether anything has actually been said in this conversation. Counted with
   * `isConversationalItemType` rather than by item count: a conversation is
   * never empty in the document — standing context items are seeded into it —
   * and the mention reads a send makes are context items too, so counting those
   * would make a first message look like history.
   * @returns {boolean} True when the conversation holds real history.
   * @private
   */
  _hasConversationalHistory() {
    const items = this.rootMessageThread?.items || [];
    for (const item of items) {
      if (isConversationalItemType(item?.get?.('type'))) return true;
    }
    return false;
  }

  /**
   * Run a Yjs mutation atomically under the conversation's authorId. The
   * sanctioned entry point for any code outside this class that needs to
   * modify the Yjs document — do not reach through `_doc.doc.transact`.
   * @param {() => void} txFn
   */
  atomicUpdate(txFn) {
    this._doc.doc.transact(txFn, this._doc.authorId);
  }

  /**
   * Run a Yjs mutation atomically, tagged as engine-derived rather than
   * authored. Use this — never `atomicUpdate` — for writes that are pure
   * derivations of state the engine just observed (stamping `executor`,
   * `approvalOptions`, `displayData`, `reviewStatus`, the APPROVED→RUNNING
   * claim). The worker's UndoManager skips this origin, so undoing the
   * originating item pops the item itself instead of peeling off a derivation
   * the engine would immediately recompute.
   * @param {() => void} txFn
   */
  engineDerivedUpdate(txFn) {
    this._doc.doc.transact(txFn, ENGINE_DERIVED_ORIGIN);
  }

  /** @returns {string} The authorId this conversation tags its writes with. */
  get authorId() {
    return this._doc.authorId;
  }

  // =========================================================================
  // Thread Transaction API
  // =========================================================================

  /**
   * Stop a single thread's subtree — the one primitive behind every "stop a
   * thread" affordance (parent tile button, an in-thread footer Stop): worker
   * truth first, then settle the run.
   *
   * Crucially, the worker-cancel SCOPE equals the settle TARGET. We preempt the
   * single conversation worker only when this thread's subtree is what it is
   * actually driving — the live processing column is this thread or one of its
   * descendants, or a tool-action in the subtree is awaiting approval
   * (`_threadOwnsActiveWork`). A dormant/queued thread owns no in-flight work,
   * so stopping it must NOT kill whatever unrelated thread the worker is running
   * — we just settle its run. (Today only one thread runs at a time; this
   * scoping is also what makes the model correct once threads run in parallel.)
   *
   * When we do preempt: cancelAllPendingApprovals() rejects any browser-side
   * approval dialogs in the subtree, then cancelAndSettle() cancels the in-flight
   * turn (the worker cancels its tools, writing state='cancelled') and waits for
   * the worker to go idle, so a live tool can no longer keep the subtree "busy".
   * The worker settles the run it was driving on its way out, so the settle here
   * only bites for a thread it never started — one spawned and left queued,
   * whose caller would otherwise wait forever. The thread itself stays perfectly
   * able to run again.
   * @param {*} threadYMap - The Yjs Y.Map for the thread item
   * @returns {Promise<void>}
   */
  async cancelThread(threadYMap) {
    await this.interruptThread(threadYMap);
    this.atomicUpdate(() => {
      settleRunCancelled(threadYMap, () => this._nextItemId());
    });
  }

  /**
   * Interrupt a thread's in-flight work and leave its run OPEN: cancel any
   * pending approvals in its subtree and preempt the worker turn it owns, but
   * record no outcome. The thread reads as still working, so its column keeps
   * the composer and the user can carry on with it.
   *
   * This is the "stop from the thread's own vantage" action: Escape while
   * focused in the sub-thread, and the sub-thread's footer Stop, both route
   * here. Settling the run as cancelled — which is what a parked caller reads
   * to stop waiting — happens only when the thread is stopped from its PARENT's
   * vantage: `cancelThread` (the parent tile's Stop) or `settleOpenSubThreads`
   * (a root/parent Escape).
   * @param {*} threadYMap - The thread Y.Map.
   * @returns {Promise<void>}
   */
  async interruptThread(threadYMap) {
    if (this._threadOwnsActiveWork(threadYMap)) {
      this.cancelAllPendingApprovals();
      await this.cancelAndSettle('thread interrupt');
    }
  }

  /**
   * Settle every sub-thread's open run as cancelled. This is the settling half
   * of a root/parent-vantage stop (Escape while focused on the root, the root
   * footer Stop): the caller has already preempted the worker turn; this marks
   * the runs as no longer in flight, which is what a parked parent reads to stop
   * waiting. A run that already settled is left as it is, and no summary is
   * written. Threads at every nesting depth are walked.
   * @returns {void}
   */
  settleOpenSubThreads() {
    /** @type {any[]} */
    const open = [];
    walkThreads(this._rootMessageThread.items, (threadYMap) => {
      open.push(threadYMap);
    });
    if (open.length === 0) return;
    this.atomicUpdate(() => {
      for (const t of open) settleRunCancelled(t, () => this._nextItemId());
    });
  }

  /**
   * Whether the conversation worker's current activity belongs to this thread's
   * subtree — i.e. stopping this thread should preempt the worker rather than
   * only settle its run. True when (a) a tool-action anywhere in the subtree is
   * awaiting approval, or (b) a running thread is this thread itself or one of
   * its descendants. False for a dormant/queued thread while unrelated siblings
   * run: that thread owns no in-flight work.
   *
   * Every running thread is considered, not just the one the top-level
   * projection names — a parent and its read-only children run together, and a
   * subtree with any of them in it owns work worth preempting.
   * @param {*} threadYMap - The thread Y.Map.
   * @returns {boolean} True if the worker is driving this subtree.
   * @private
   */
  _threadOwnsActiveWork(threadYMap) {
    if (!threadYMap || typeof threadYMap.get !== 'function') return false;
    const items = threadYMap.get('items');
    if (hasPendingApprovalInTree(items)) return true;
    const own = threadYMap.get('itemId');
    for (const liveId of Object.keys(this._llmState?.getLiveThreadMessages(this.id) || {})) {
      if (!liveId) continue; // the root thread is nobody's descendant
      if (liveId === own) return true;
      if (items && findItemByIdRecursive(items.toArray(), liveId)) return true;
    }
    return false;
  }

  /**
   * Interrupt the sub-thread the conversation's projected run names, if any.
   *
   * ONE thread, because the caller is a keypress: this is the fallback for a
   * bare Escape, where nobody has said which column they meant. The held
   * status thread (`llmState.getStatusThreadId`) sticks to a thread while it
   * runs, so parallel siblings streaming together do not retarget it mid-press;
   * with several live it can differ between windows, and the user can press
   * again, or use a column's own Stop, to reach the others.
   * When it points at a sub-thread, that thread is INTERRUPTED
   * (`interruptThread`): the worker turn is preempted but the thread stays
   * open, so its column keeps the composer and the user can keep interacting
   * with it.
   *
   * Must be called BEFORE any llmState.stop()/idle write, since those clear the
   * status threadId. Returns false (caller falls back to the root-turn cancel)
   * when the projected run is the root or nothing is processing.
   * @returns {Promise<boolean>} True if a sub-thread was interrupted.
   */
  async cancelActiveTurn() {
    const activeThreadId = this._llmState?.getStatusThreadId(this.id) ?? null;
    if (!activeThreadId) return false;
    const threadItem = this.findItemById(activeThreadId);
    if (!threadItem || threadItem.get?.('type') !== 'thread') return false;
    await this.interruptThread(threadItem);
    return true;
  }

  // =========================================================================
  // Move / copy items primitive
  // =========================================================================
  //
  // The single shape every relocation uses: snapshot via toJSON → rebuild via
  // plainToYMap → insert at destination → (move only) delete from source. The
  // shape /compact already used, generalised so compact, expand-in-place,
  // promote-to-tab and the Move/Copy picker are all thin callers.

  /**
   * Deep-clone a toJSON snapshot, minting a fresh itemId for the node and
   * every descendant so a copy collides with nothing. Uses `minter` (a
   * conversation's _nextItemId) so cross-doc copies live in the dest id space.
   * @param {any} snapshot - Plain object/array/primitive from toJSON.
   * @param {() => string} minter - Fresh-id generator.
   * @returns {any} Re-id'd deep clone.
   * @private
   */
  _remintItemIds(snapshot, minter) {
    if (Array.isArray(snapshot)) {
      return snapshot.map(s => this._remintItemIds(s, minter));
    }
    if (snapshot && typeof snapshot === 'object') {
      /** @type {Record<string, any>} */
      const out = {};
      for (const [k, v] of Object.entries(snapshot)) {
        out[k] = this._remintItemIds(v, minter);
      }
      if (Object.prototype.hasOwnProperty.call(out, 'itemId')) {
        out.itemId = minter();
      }
      return out;
    }
    return snapshot;
  }

  /**
   * Normalise indices: dedupe, drop out-of-range, sort ascending.
   * @param {number[]} indices
   * @param {number} length
   * @returns {number[]} Cleaned, ascending index list.
   * @private
   */
  _normalizeIndices(indices, length) {
    return [...new Set(indices)]
      .filter(i => Number.isInteger(i) && i >= 0 && i < length)
      .sort((a, b) => a - b);
  }

  /**
   * Move items at `indices` from `source` into `dest` at `position`.
   *
   * Same-doc → ONE atomic, undoable transaction (insert + delete together).
   * Cross-doc is NOT one transaction (undo can't cross docs) and is handled by
   * the promote-to-tab path (step 9); this method throws on a cross-doc call so
   * callers don't silently get a non-atomic move.
   * @param {import('./message-thread.js').default} source - Source message thread.
   * @param {number[]} indices - Indices in source to move.
   * @param {import('./message-thread.js').default} dest - Destination message thread.
   * @param {number} [position] - Insert index in dest (defaults to end).
   * @returns {number} Count of items moved.
   */
  moveItems(source, indices, dest, position) {
    const sorted = this._normalizeIndices(indices, source.length);
    if (!sorted.length) return 0;
    if (source.conversation._doc.doc !== dest.conversation._doc.doc) {
      throw new Error('moveItems: cross-doc moves are not atomic — use the promote-to-tab path');
    }
    const snapshots = sorted.map(i => source.items[i].toJSON());
    const insertPos = position ?? dest.length;
    const sameContainer = source.container === dest.container;
    this.atomicUpdate(() => {
      // Delete from source first (descending) so indices stay valid.
      for (let k = sorted.length - 1; k >= 0; k--) source.deleteAt(/** @type {number} */ (sorted[k]));
      // When moving within one container, deletions before the insert point
      // shift it left.
      let pos = insertPos;
      if (sameContainer) {
        pos -= sorted.filter(i => i < insertPos).length;
      }
      const ymaps = snapshots.map(s => plainToYMap(s));
      const arr = dest.ensureYarray();
      arr.insert(Math.max(0, Math.min(pos, arr.length)), ymaps);
    });
    return sorted.length;
  }

  /**
   * Copy items at `indices` from `source` into `dest` at `position`, minting
   * fresh itemIds for every copied node. Same-doc → one atomic transaction.
   * @param {import('./message-thread.js').default} source - Source message thread.
   * @param {number[]} indices - Indices in source to copy.
   * @param {import('./message-thread.js').default} dest - Destination message thread.
   * @param {number} [position] - Insert index in dest (defaults to end).
   * @returns {number} Count of items copied.
   */
  copyItems(source, indices, dest, position) {
    const sorted = this._normalizeIndices(indices, source.length);
    if (!sorted.length) return 0;
    if (source.conversation._doc.doc !== dest.conversation._doc.doc) {
      throw new Error('copyItems: cross-doc copies are not atomic — use the promote-to-tab path');
    }
    const minter = () => dest.conversation._nextItemId();
    const snapshots = sorted.map(i => this._remintItemIds(source.items[i].toJSON(), minter));
    const insertPos = position ?? dest.length;
    this.atomicUpdate(() => {
      const ymaps = snapshots.map(s => plainToYMap(s));
      const arr = dest.ensureYarray();
      arr.insert(Math.max(0, Math.min(insertPos, arr.length)), ymaps);
    });
    return sorted.length;
  }

  /**
   * Expand a thread in place: splice its items back into the parent at the
   * thread's index and drop the tile. The inverse of folding a selection into
   * a sub-thread (compact / move-into-thread). Same-doc → ONE atomic, fully
   * undoable transaction.
   *
   * Refuses to expand a thread with live/unsettled work in its subtree (mirror
   * of compact's skip of un-resulted threads) so we never strand a running
   * tool at the parent level.
   * @param {string} threadItemId - The thread to expand.
   * @returns {boolean} True if expanded.
   */
  expandThread(threadItemId) {
    const threadYMap = this.findItemById(threadItemId);
    if (!threadYMap || threadYMap.get?.('type') !== 'thread') return false;
    if (hasUnsettledToolInTree(threadYMap.get('items'))) return false;

    const parentContainer = this.findParentContainer(threadItemId);
    const parentThread = parentContainer
      ? new MessageThread(this, parentContainer, parentContainer.get('itemId'))
      : this._rootMessageThread;
    const idx = parentThread.findIndexByItemId(threadItemId);
    if (idx < 0) return false;

    // Flatten the thread's items into the parent. Drop the thread's own
    // SYSTEM_1 placeholder: every container (root or a parent thread) already
    // owns exactly one, so carrying the child's up would duplicate it. Only the
    // placeholder is stripped; every other item moves up unchanged.
    const nested = threadYMap.get('items');
    const snapshots = (nested?.toArray?.() || [])
      .map((/** @type {any} */ it) => it.toJSON())
      .filter((/** @type {{itemId?: string, type?: string}} */ it) => !(it.itemId === 'SYSTEM_1' || it.type === 'system-prompt'));

    // Nothing to splice means this would be a delete wearing expand's name: the
    // tile goes and nothing takes its place, so whatever the tile itself
    // carried — a compaction fold's summary is the case that bites — is gone
    // with no route back. Expand only ever trades a tile for its contents.
    if (!snapshots.length) return false;

    this.atomicUpdate(() => {
      parentThread.deleteAt(idx);
      const ymaps = snapshots.map((/** @type {any} */ s) => plainToYMap(s));
      parentThread.ensureYarray().insert(idx, ymaps);
    });
    return true;
  }

  /**
   * Prepare item snapshots for insertion into a new conversation root. Root-only
   * system-prompt placeholders are omitted because the destination root already
   * owns its SYSTEM_1; every remaining item gets fresh IDs in the destination
   * conversation's id space.
   * @param {any[]} items - Source Y.Map items.
   * @param {Conversation} destConversation - Destination conversation.
   * @returns {any[]} Plain snapshots ready for plainToYMap.
   * @private
   */
  _snapshotsForNewRoot(items, destConversation) {
    return items
      .map((/** @type {any} */ it) => it.toJSON())
      .filter((/** @type {any} */ it) => this._isRootTopLevelItem(it))
      .map((/** @type {any} */ it) => this._remintItemIds(it, () => destConversation._nextItemId()));
  }

  /**
   * Whether a plain item snapshot may live at the TOP LEVEL of a conversation
   * root. The `SYSTEM_1` / `system-prompt` placeholder is the one thread-specific
   * item that must be dropped when flattening a sub-thread into a new root: the
   * destination root seeds its own, so a copied one would duplicate the system
   * prompt.
   * @param {any} plain - Plain snapshot from a Y.Map's toJSON().
   * @returns {boolean} True if the item belongs at a conversation root top level.
   * @private
   */
  _isRootTopLevelItem(plain) {
    if (!plain) return false;
    if (plain.itemId === 'SYSTEM_1' || plain.type === 'system-prompt') return false;
    return true;
  }

  /**
   * Copy tab-level state that should follow promoted/copied content into a new
   * root conversation.
   * @param {Conversation} destConversation - Destination conversation.
   * @param {import('./message-thread.js').default} sourceThread - Source thread for effective model config.
   * @returns {void}
   * @private
   */
  _copyNewTabState(destConversation, sourceThread) {
    if (sourceThread.modelConfig) destConversation.setModelConfig({ ...sourceThread.modelConfig });
    const convRules = this.getMetadata(CONVERSATION_RULES_KEY);
    const convPaths = this.getMetadata(CONVERSATION_PATHS_KEY);
    if (convRules !== undefined) {
      destConversation.setMetadata(CONVERSATION_RULES_KEY, plain(convRules));
    }
    if (convPaths !== undefined) {
      destConversation.setMetadata(CONVERSATION_PATHS_KEY, plain(convPaths));
    }
  }

  /**
   * Copy arbitrary items into a new top-level conversation tab. Cross-doc copies
   * are necessarily two-document operations; the new conversation gets fresh itemIds and
   * root-owned context, and the source document is unchanged.
   * @param {import('./message-thread.js').default} source - Source message thread.
   * @param {number[]} indices - Source indices to copy.
   * @param {{activate?: boolean, name?: string}} [options]
   * @returns {Promise<string|null>} New conversation ID, or null when nothing copied.
   */
  async copyItemsToNewTab(source, indices, options = {}) {
    const sorted = this._normalizeIndices(indices, source.length);
    if (!sorted.length || !this.session?.createConversation) return null;
    const sourceItems = sorted.map(i => source.items[i]);
    const hasCopyableItem = sourceItems.some((/** @type {any} */ it) => this._isRootTopLevelItem(it.toJSON()));
    if (!hasCopyableItem) return null;

    const newId = await this.session.createConversation(options.name || 'Copied items', {
      activate: !!options.activate,
      origin: 'copy-items',
      // The copied items are about the tree this conversation works in, so the
      // tab they land in works there too.
      workspaceId: this.workspaceId
    });
    const newConv = this.session.getConversation(newId);
    if (!newConv) return null;
    const snapshots = this._snapshotsForNewRoot(sourceItems, newConv);

    newConv.atomicUpdate(() => {
      const arr = newConv.rootMessageThread.ensureYarray();
      arr.insert(arr.length, snapshots.map((/** @type {any} */ s) => plainToYMap(s)));
    });

    this._copyNewTabState(newConv, source);
    if (options.activate) this.session.switchConversation?.(newId);
    return newId;
  }

  /**
   * Move arbitrary items into a new top-level conversation tab. This is an
   * explicit two-step cross-doc move: copy into the new doc, then delete from
   * the source doc. Undo cannot cross the document boundary.
   * @param {import('./message-thread.js').default} source - Source message thread.
   * @param {number[]} indices - Source indices to move.
   * @param {{activate?: boolean, name?: string}} [options]
   * @returns {Promise<string|null>} New conversation ID, or null when not moved.
   */
  async moveItemsToNewTab(source, indices, options = {}) {
    const sorted = this._normalizeIndices(indices, source.length);
    if (!sorted.length) return null;
    const newId = await this.copyItemsToNewTab(source, sorted, options);
    if (!newId) return null;
    source.transact(() => source.removeItemsAt(sorted));
    return newId;
  }

  /**
   * Promote a sub-thread into a new top-level conversation tab.
   *
   * Cross-document undo cannot be atomic, so this is intentionally a COPY-style
   * promote: the original thread remains in place and the new conversation receives fresh
   * itemIds. UX can offer a separate "remove original" action later, but this
   * primitive never pretends that a cross-doc move is undoable.
   *
   * State carry-over policy:
   *   - Items: copied into the new root, fresh itemIds recursively. Every thread
   *     is isolated and carries everything it needs in its own items.
   *   - SYSTEM_1: new conversation owns its root context; promoted SYSTEM_1
   *     placeholders are dropped — the new root seeds its own system prompt.
   *   - modelConfig: source thread's effective modelConfig becomes new root config.
   *   - permissionRules/allowedPaths: conversation-scoped metadata is copied.
   *     Session-scoped permissions already belong to the project and remain shared.
   * @param {string} threadItemId - Thread item ID to promote.
   * @param {{activate?: boolean, name?: string}} [options]
   * @returns {Promise<string|null>} New conversation ID, or null if not promoted.
   */
  async promoteThreadToNewTab(threadItemId, options = {}) {
    const threadYMap = this.findItemById(threadItemId);
    if (!threadYMap || threadYMap.get?.('type') !== 'thread') return null;
    if (hasUnsettledToolInTree(threadYMap.get('items'))) return null;
    if (!this.session?.createConversation) return null;

    const sourceThread = this.resolveMessageThread(threadItemId);
    const nested = threadYMap.get('items');
    const sourceItems = nested?.toArray?.() || [];
    // Every thread is isolated and carries its own history, so the promoted
    // items are exactly the thread's own items.
    const promotedItems = sourceItems;
    const hasCopyableItem = promotedItems.some((/** @type {any} */ it) => this._isRootTopLevelItem(it.toJSON()));
    if (!hasCopyableItem) return null;

    const goal = threadYMap.get('goal') || 'Promoted thread';
    const newId = await this.session.createConversation(options.name || goal, {
      activate: !!options.activate,
      origin: 'promote-thread',
      // A promoted thread carries on the work it was already doing, in the
      // tree it was already doing it in.
      workspaceId: this.workspaceId
    });
    const newConv = this.session.getConversation(newId);
    if (!newConv) return null;

    const snapshots = this._snapshotsForNewRoot(promotedItems, newConv);

    newConv.atomicUpdate(() => {
      const root = newConv.rootMessageThread;
      const arr = root.ensureYarray();
      arr.insert(arr.length, snapshots.map((/** @type {any} */ s) => plainToYMap(s)));
    });

    this._copyNewTabState(newConv, sourceThread);

    if (options.activate) this.session.switchConversation?.(newId);
    return newId;
  }

  // =========================================================================
  // Status Message API (delegates to _llmState)
  // =========================================================================

  /**
   * The shared LLM state service, for callers that need this conversation's
   * live turn status — the status message and its thread, throughput, live
   * input usage, "is it processing". Read-only: everything that CHANGES the
   * status goes through the conversation's own methods, so a view can't start
   * or stop a turn behind the model's back.
   * @returns {import('../services/llm-state.js').default} The LLM state service.
   */
  get llmState() {
    return this._llmState;
  }

  /**
   * Subscribe to status changes for THIS conversation. The callback takes no
   * argument — the conversation is the one you subscribed to — and fires after
   * every start/stop/reset/updateStatus tick, including the per-usage-chunk
   * ticks a streaming turn emits. Query {@link llmState} for the new state.
   * @param {() => void} fn - Called on each status change for this conversation.
   * @returns {() => void} Unsubscribe function.
   */
  onStatusChange(fn) {
    if (typeof this._llmState?.addStatusObserver !== 'function') return () => {};
    return this._llmState.addStatusObserver((/** @type {string} */ id) => {
      if (id === this.id) fn();
    });
  }

  /**
   * Set a custom status message for this conversation
   * @param {string} statusText
   */
  setStatusMessage(statusText) {
    this._llmState.updateStatus(this.id, 'custom', { message: statusText });
  }



  // ========================================================================
  // MESSAGE SENDING AND LLM INTERACTION
  // ========================================================================

  /**
   * Send a message in this conversation
   * @param {string} userMessage - User's message content
   * @param {string|null} [threadItemId] - Thread item ID if sending from a thread column
   * @param {import('./message-thread.js').MessageThread} [messageThread] - Column-scoped message thread
   * @param {{preemptProcessing?: boolean, consumeComposer?: boolean, interpretCommands?: boolean, attachments?: Array<{id:string,mime:string,filename:string,bytes:number,width:number,height:number}>, skills?: string[]}} [options] -
   *   When `preemptProcessing` is set, an in-flight turn is cancelled-and-settled
   *   (worker truth) before this message is delivered, instead of the message
   *   being silently dropped by the "already processing" guard. A visible notice
   *   is shown if a live turn was actually cancelled. `attachments` carries
   *   content-addressed asset references (uploaded images) to store on the user
   *   item.
   *
   *   The two `false` options are for a message the user never typed into a box —
   *   a review submitted from a Pinboard, and anything else generated whole.
   *   `consumeComposer: false` says this send has no claim on the composer: its
   *   text, draft, pasted blobs and armed schedule belong to a message that has
   *   not been sent, so the box is not cleared, the history the up-arrow walks is
   *   not added to, and a later validation failure restores nothing over it.
   *   `interpretCommands: false` says the text is a message whatever it starts
   *   with, so generated text that happens to begin with `/` is sent rather than
   *   run.
   * @returns {Promise<string|null>} null when the message was delivered (or a
   *   slash command was handled); otherwise a short reason describing which
   *   guard dropped it. The drop is silent for users (the UI guard normally
   *   catches it first); the test harness checks the reason so a dropped
   *   message fails the test at the send, not as a downstream fence timeout.
   */
  async sendMessage(userMessage, threadItemId = null, messageThread, options = {}) {
    const consumeComposer = options.consumeComposer !== false;

    // Check for slash commands first (these work even when processing)
    if (options.interpretCommands !== false && userMessage.startsWith('/')) {
      // Capture composer before command runs — commands may change the active column
      const composer = this._getComposer();
      const boundBefore = this._composerThreadId(composer);
      // Clear the box BEFORE running the command, not after. A command like
      // /handoff clones the conversation part-way through execute(), and the
      // clone is taken from the source's persisted draft — so if the command
      // text is still sitting in the box when the snapshot happens, it
      // reappears prefilled in the new conversation's input. Clearing first
      // means the clone captures an empty draft. Gated on the same pattern
      // slashCommandHandler.execute() treats as handled (`/foo`, not a bare
      // "/" or "/123"), so genuinely-unhandled input still falls through to a
      // normal send and survives a validation failure in the box. Guarded so a
      // scheduled send firing on a hidden thread doesn't wipe the visible
      // column's in-progress draft. (A command that sets a draft — 'draft' run
      // mode's setDraft side effect — runs after this, so it isn't clobbered.)
      //
      // Only clear when the box's current text IS this command — i.e. the user
      // typed `/foo` and submitted it, so the box holds exactly what we're about
      // to consume. When the command was invoked another way (picked from the
      // slash/commands menu, a scheduled or programmatic send) the box instead
      // holds an unrelated in-progress draft; clearInput() would destroy it
      // non-undoably (setText('') wipes the native undo stack), so leave it be.
      const boxText = (composer && typeof (/** @type {any} */ (composer).getText) === 'function')
        ? /** @type {any} */ (composer).getText().trim()
        : '';
      if (/^\/[a-zA-Z]/.test(userMessage)
          && boxText === userMessage.trim()
          && composer && typeof (/** @type {any} */ (composer).clearInput) === 'function'
          && boundBefore === this._targetThreadId(messageThread, threadItemId)) {
        /** @type {any} */ (composer).clearInput();
      }
      // A command is content too: /clear re-seeds, /handoff clones, and both
      // want a conversation that has already chosen where it works.
      await this.ensureInitialised();
      const result = await slashCommandHandler.execute(userMessage, messageThread);
      if (result.handled) {
        if (result.message) {
          this.showWarning(result.message, 3000);
        }
        if (result.sideEffects) {
          this._handleCommandSideEffects(result.sideEffects);
        }
        return null;
      }
    }

    // Refuse to start an LLM turn when no strategy is enabled. Every strategy
    // ships in `@juggler/core`; with it (or all strategy plugins) disabled
    // there is nothing to drive a turn, so the worker/engine would otherwise
    // spin the inert fallback to no effect. Tell the user — at the moment
    // they try to send — and leave their message in the box. Slash commands
    // were already handled above, so the Extensions settings stay reachable.
    if (!strategyRegistry.hasAnyStrategy()) {
      this.showWarning("Can't start a conversation — the core Juggler extension is turned off. Re-enable it in Extensions settings to continue.", 8000);
      return 'no strategy enabled';
    }

    // Refuse a turn whose selected model belongs to a provider that is not
    // currently available — Claude Code toggled off, an API key removed, etc.
    // The model picker blocks *selecting* such a model, but a conversation can
    // already be sitting on one: selection is sticky and a later provider
    // toggle never retargets it. Without this guard the turn reaches the
    // backend, which rejects it with a developer string ("provider X is not
    // enabled"). Catch it at the send site and offer the same fix the picker
    // does. Slash commands were handled above, so settings stay reachable.
    // Fresh install with no API key: the model picker is empty, nothing is
    // selected, and the worker would bounce with an unsatisfiable "select a
    // model" warning. Surface the real problem — no provider configured — with a
    // jump to Provider Settings. Fire only when there is genuinely nothing to
    // send with: no model already selected AND a positive "cache received and
    // empty" signal (an un-hydrated startup, or a conversation that already has a
    // model, never trips this — the latter is handled just below).
    const selectedConfig = messageThread?.modelConfig || this.modelConfig;
    const hasSelectedModel = !!(selectedConfig && selectedConfig.provider);
    if (!hasSelectedModel && providersCache.hasReceived() && !providersCache.hasAvailableProvider()) {
      await this._showNoProviderConfigured();
      return 'no provider configured';
    }

    const unavailableProvider = this._unavailableSelectedProvider(messageThread);
    if (unavailableProvider) {
      await this._showProviderUnavailable(unavailableProvider);
      return 'provider unavailable';
    }

    // Refuse a turn whose provider Juggler would spawn as a subprocess here,
    // for a conversation that works somewhere this machine only reaches over a
    // wire. The picker does not offer that pairing, but a selection is sticky
    // and a rebind never retargets it — and the failure is the quiet kind: the
    // CLI runs in a directory that is not the one the turn's file operations
    // use, and the answers merely stop making sense.
    const strandedProvider = this._providerNeedingALocalWorkspace(messageThread);
    if (strandedProvider) {
      this.showWarning(
        `Can't send: ${strandedProvider.displayName || strandedProvider.name} runs on this machine, and this conversation works in ${this.workspaceRoot || 'another workspace'}. Pick a model that runs over the network.`,
        8000);
      return 'provider cannot reach this workspace';
    }

    // A conversation whose workspace cannot be worked in is refused here, in a
    // sentence, rather than in the engine. The composer knows nothing about
    // workspaces, so a message typed after somebody else finished with one went
    // through, cleared the box, started a turn, and died in the server with
    // "workspace X was closed" — which is the same refusal, arriving too late to
    // be any use. The ways out are the two buttons on the banner above the
    // transcript, which is what the sentence points at.
    const unusable = this._unusableWorkspace();
    if (unusable) {
      this.showWarning(
        `Can't send: ${unusable}. Use the banner above the transcript to say where this conversation should work.`,
        8000);
      return 'workspace cannot be worked in';
    }

    // Refuse an unreachable worker BEFORE the box is cleared below. A send is
    // fire-and-forget over the socket: with the link down `sendWorkerMessage`
    // drops the frame and returns a `false` nobody reads, so clearing first and
    // discovering it afterwards would take the message and lose it. Checked
    // ahead of the processing branches so a link drop reports itself as one
    // rather than as a busy turn.
    if (!workerManager.isWorkerReady(this.id)) {
      this.showWarning('Still connecting to the engine — try again in a moment.', 5000);
      return 'worker not ready';
    }

    // When a turn is already in flight ON THE THREAD BEING SENT TO, the message
    // is QUEUED rather than refused — the worker parks it in that thread's
    // pendingItems and drains it at the next boundary (see
    // worker/pending_items.go). Asked of the target thread alone: a busy
    // sibling is not this thread's turn, and queueing behind one would hold a
    // message the worker was ready to run. The only path that still can't queue
    // is the worker-less fallback (it would start a second concurrent strategy
    // on the main thread), so it keeps refusing.
    const targetBusy = this.isThreadProcessing(this._targetThreadId(messageThread, threadItemId));
    const isQueueing = targetBusy && workerManager.isWorkerReady(this.id);
    if (options.preemptProcessing) {
      await this.cancelAndSettle('new message preempted');
    } else if (targetBusy && !isQueueing) {
      return `conversation ${this.id} is processing`;
    }

    // The send is going through, so this is the conversation's commit: bind and
    // seed it before the worker writes the message or starts the turn, so the
    // turn meets a conversation whose standing context is already there. Placed
    // after the refusals — a message that was turned away has put nothing into
    // the conversation, and must not make a choice on the user's behalf.
    await this.ensureInitialised();

    // Save the message before clearing, so a refusal can hand it back or resend
    // it. The WHOLE message: the box is about to be emptied and the worker has
    // written nothing, so this record is the only copy of the images too. It
    // also carries whether handing it BACK is allowed: a message the box never
    // held is one the box must never be given, however the send ends.
    this._pendingUserMessage = {
      content: userMessage,
      attachments: options.attachments || [],
      restorable: consumeComposer,
    };

    // Validation passed locally - now clear the input. Only clear the box when
    // it is showing the thread we sent to: a scheduled send fired from the
    // model on a hidden thread must not wipe the visible column's draft.
    const composer = consumeComposer ? this._getComposer() : null;
    if (composer && typeof (/** @type {any} */ (composer).clearInput) === 'function'
        && this._composerThreadId(composer) === this._targetThreadId(messageThread, threadItemId)) {
      /** @type {any} */ (composer).clearInput();
    }

    // Cancel any pending approval dialogs for this conversation — but NOT
    // when queueing: a message typed while a tool awaits approval must not
    // dismiss that approval; the queued message waits its turn.
    if (!isQueueing) {
      messageThread?.cancelPendingApprovals();
    }

    // Add to session-level message history for input navigation. An image-only
    // send has empty text — don't push a blank entry into up-arrow history.
    // History is the box's own: it is what has been typed into it, and pressing
    // up must not walk back into text that was generated elsewhere.
    if (consumeComposer && userMessage) {
      this._session.addMessageToHistory({ content: userMessage, attachments: options.attachments || [] });
    }

    // Auto-recents: a send is a genuine local user action, so float this
    // conversation to the absolute top of the tab list now. This is the ONLY
    // user-action bump trigger — driven from the action site, never from
    // observing replicated Yjs state, so loading/refreshing a window (pure
    // hydration, no send) leaves every window's settled order untouched.
    this._session.bumpConversation?.(this.id, { forceTop: true });

    // Announce the turn the moment the user sends, so the tab can move to the
    // end of the conversation rather than making them wait out the round-trip
    // to see anything happen (conversation-tab.js scrolls its root column on
    // this). This is the responsiveness half only: the guarantee that the
    // message is shown is rule 3/8b in conversation-area-selection.js, which
    // runs when the message itself lands in the DOM.
    this.announceTurnRequested();

    // Route to worker - the worker owns the strategy loop. Turns are driven
    // exclusively by the Go worker; there is no viewer-side fallback loop.
    if (workerManager.isWorkerReady(this.id)) {
      workerManager.sendMessage(this.id, userMessage, messageThread?.threadItemId || threadItemId, options.attachments, options.skills);
      const acceptedConfig = messageThread?.modelConfig || this.modelConfig;
      if (acceptedConfig?.provider && acceptedConfig?.model) {
        recentModels.record(acceptedConfig.provider, acceptedConfig.model, acceptedConfig.thinking, acceptedConfig.serviceTier);
      }
      // Worker will emit state patches that update proxy, which triggers UI updates
      // Processing state is managed by worker via state patches
      return null;
    }

    // Reachable at the top of this method but not now: the only gap is the
    // `preemptProcessing` cancel above, which the socket can die across. The
    // box has been cleared by this point, so hand the text back before
    // refusing — the user retries with their message still in front of them.
    this.showWarning('Still connecting to the engine — try again in a moment.', 5000);
    this.restorePendingMessage();
    return 'worker not ready';
  }


  /** @type {Set<Function>} */
  _stopHandlers = new Set();

  /**
   * Missing-model self-heal one-shot latch (see trySelfHealMissingModel): set
   * when a "no-model" validation error triggers a model-config resync +
   * auto-resend (see services/llm-state.js), cleared on the next accepted turn.
   * Prevents a resend loop if the self-heal doesn't take.
   * @type {boolean}
   */
  _modelSelfHealAttempted = false;

  /**
   * The message a send handed to the worker, held from the moment the box is
   * cleared until the worker accepts the turn. One record, text and images
   * together, because a refusal has to hand back (or resend) the whole message
   * and nothing else is holding either half by then.
   *
   * `restorable` is what separates the two kinds of sender. A composer send is
   * restorable: the box was emptied on its behalf and a refusal owes it back. A
   * generated send is not: the box never held this text, and writing it there on
   * a failure would replace whatever the user is in the middle of. Resending is
   * unaffected either way — a refused turn is worth retrying whoever wrote it.
   * @type {{content: string, attachments: Array<import('../utils/attachments.js').AssetRef>, restorable?: boolean}|null}
   */
  _pendingUserMessage = null;

  /**
   * Optimistic Pause marks, keyed as the worker keys its own: `''` is the root
   * thread, and every mark stands over its thread and everything nested below
   * it. Local-only, and only until the worker's marks reach the doc — they are
   * the truth, and `politeStopState` drops these the moment it can read one.
   * @type {Set<string>}
   */
  _politeStops = new Set();

  /**
   * Finish processing and clean up
   *     */
  _finishProcessing() {
    // Stopping tells the status observers, so the tab drops its spinner.
    this._llmState.stop(this.id);
    this._session.notifyConversationChange('processing:stopped', this.id);
  }

  /**
   * Announce that a turn has been asked for in this conversation, on the
   * session feed as `conversation:turn-requested`. The tab showing it scrolls
   * to the end on it; the model itself touches no view.
   */
  announceTurnRequested() {
    this._session?.notifyConversationChange('conversation:turn-requested', { conversationId: this.id });
  }

  /**
   * Handle an error during processing
   * @param {string} message - Error message
   */
  _handleError(message) {
    console.error(`[Conversation] Error: ${message}`);

    // The Go worker writes the error item via Yjs sync.

    this._finishProcessing();
  }

  /**
   * Handle cancellation
   *     */
  _handleCancellation() {
    this._finishProcessing();
  }

  /**
   * Handle retry notification for this conversation
   * @param {number} attempt - Current retry attempt
   * @param {number} maxRetries - Maximum retries
   * @param {string} [reason] - Reason for retry (e.g., 'timeout', 'network')
   */
  handleRetry(attempt, maxRetries, reason) {
    if (!this._llmState.isConversationProcessing(this.id)) {
      return;
    }

    this._llmState.updateStatus(this.id, 'retry', {
      attempt,
      maxRetries,
      reason
    });
  }

  /**
   * Handle streaming error notification from backend
   * @param {string} errorMessage - Detailed error message from LLM provider
   */
  handleStreamingError(errorMessage) {
    if (!this._llmState.isConversationProcessing(this.id)) {
      return;
    }

    // The Go worker writes the error item via Yjs sync.

    this._llmState.updateStatus(this.id, 'error', {
      message: errorMessage
    });
  }

  /**
   * Handle final response from backend. Only the usage is read: the Go worker
   * owns the turn — it writes the response's blocks and decides what follows —
   * so the viewer's part is recording the counts against the right thread.
   * @param {import('./message-thread.js').MessageThread} messageThread - The thread the response is for
   * @param {{inputTokens?: number, outputTokens?: number, cachedTokens?: number}} usage - Token counts (cachedTokens: prompt tokens served from cache)
   */
  handleResponse(messageThread, { inputTokens = 0, outputTokens = 0, cachedTokens = 0 }) {
    // Check if this conversation is still processing
    if (!this._llmState.isConversationProcessing(this.id)) {
      console.warn('[Conversation] handleResponse called but conversation not processing');
      return;
    }

    try {
      // Update status, against the thread this response is for. Omitting the
      // thread would target the conversation's projected run — the single
      // thread it nominates as its headline — which is this one only by
      // coincidence once several threads run at once, and a token count filed
      // under a sibling is a meter reporting another thread's prompt.
      this._llmState.updateStatus(this.id, 'processing_tools', {
        inputTokens,
        outputTokens,
        cachedTokens
      }, messageThread?.threadItemId ?? null);

      // The Go worker owns the turn: it adds text/thinking blocks during
      // streaming (processStreamChunk) and drives tool execution. The status
      // update above is all the viewer needs to do here.
    } catch (error) {
      console.error('[Conversation] Error in handleResponse:', error);
      this._handleError(extractErrorMessage(error));
    }
  }

  // ========================================================================
  // ERROR HANDLING AND CANCELLATION
  // ========================================================================

  /**
   * Handle error for this conversation
   * @param {string} error - Error message
   */
  handleError(error) {
    console.error(`[ESSENTIAL] [Conversation] Error in ${this.id}: ${error}`);

    if (!this._llmState.isConversationProcessing(this.id)) {
      return;
    }

    // Detect cancellation (case-insensitive, various formats)
    const isCancellation = error === 'Request cancelled by user' ||
            (typeof error === 'string' && error.toLowerCase().includes('cancel'));
    if (isCancellation) {
      this._handleCancellation();
    } else {
      this._handleError(error);
    }
  }

  /**
   * Handle shouldContinue request from provider (iteration control callback)
   * This is called when the backend sends a should_continue_request message,
   * which happens after each turn in the tool execution loop.
   * @param {{requestId: string, turnNumber: number, toolCallCount: number}} data - Request data
   */
  async handleShouldContinueRequest(data) {
    const { requestId } = data;
    // Turns are driven by the Go worker; the viewer applies no per-turn
    // iteration control, so always continue.
    wsService.sendShouldContinueResponse(requestId, true, '');
  }

  /**
   * Handle tool execution request from claudecode provider.
   * This is called when the backend sends a tool_use_request message,
   * which happens when claudecode's MCP handler receives a tools/call.
   *
   * Uses ToolExecutor for routing - same code path as workers and strategy loop.
   * @param {{requestId: string, toolUseId: string, toolName: string, toolInput: {[key: string]: unknown}}} data - Tool request data
   */
  async handleToolUseRequest(data) {
    const { requestId, toolUseId, toolName, toolInput } = data;

    // Ensure spinner is showing during claudecode tool execution
    if (!this.isProcessing) {
      this._llmState.start(this.id);
    }
    this._llmState.updateStatus(this.id, 'processing_tools');

    try {
      // Execute via ToolExecutor - handles routing, approval flow internally.
      // onApproved fires when the user approves so the server can start its execution timeout.
      const result = await toolExecutor.executeToolCall(
        { id: toolUseId, name: toolName, input: toolInput || {} },
        this._responseHandler,
        this._rootMessageThread,
        { onApproved: () => wsService.sendToolStarted(requestId) }
      );

      // Extract content and status from result
      /** @type {'success'|'error'|'cancelled'} */
      let resultStatus = 'success';
      let content = 'Tool executed successfully';
      let category = '';

      if (result.resultStatus) {
        resultStatus = /** @type {'success'|'error'|'cancelled'} */ (result.resultStatus);
      } else if (result.success === false) {
        resultStatus = 'error';
      }

      if (result.content) {
        content = result.content;
      } else if (!result.success && result.error) {
        content = /** @type {string} */ (result.error);
      }

      if (result.category) {
        category = /** @type {string} */ (result.category);
      }

      // Send response back to server
      wsService.sendToolResponse(requestId, content, resultStatus, category);
    } catch (error) {
      // AbortError means user cancelled - this vetoes continuation
      if (error instanceof AbortError) {
        wsService.sendToolResponse(requestId, '__ABORT__', 'cancelled', '');
        return;
      }

      // Send regular error response back to server
      wsService.sendToolResponse(
        requestId,
        extractErrorMessage(error),
        'error',
        ''
      );
    }
  }

  /**
   * Register a cleanup function to be called when stopProcessing() fires.
   * Returns an unregister function. Used by strategies to abort their own
   * in-progress operations without coupling conversation.js to strategy internals.
   * @param {Function} fn - Cleanup function
   * @returns {() => void} Unregister function
   */
  registerStopHandler(fn) {
    this._stopHandlers.add(fn);
    return () => this._stopHandlers.delete(fn);
  }

  /**
   * Fire only the registered stop handlers — e.g. the plan strategy aborting
   * its _driveExecution controller — WITHOUT the rest of stopProcessing's
   * teardown. The engine calls this when the worker reports the conversation
   * was cancelled, so engine-driven strategy execution (onWorkerIdle) unwinds
   * promptly. The worker has already cancelled the tools/turn; running full
   * stopProcessing here would loop a cancel back to the worker.
   */
  cancelStrategyExecution() {
    for (const fn of this._stopHandlers) fn();
  }

  /**
   * Stop all processing for this conversation (actions, LLM calls, etc.).
   * For a user-visible cancellation, use addCancellationMessage() instead,
   * which stops processing and posts a cancellation message.
   * @param {string} [reason] - What caused the stop, for the worker's log. Every
   *   caller names its gesture so a cancelled turn is attributable after the fact.
   */
  stopProcessing(reason) {
    // Call all registered stop handlers (e.g. plan strategy aborting its drive controller).
    for (const fn of this._stopHandlers) fn();

    // Cancel all running actions (shells, etc.) via action executor
    this._actionExecutor.cancelAllActions();

    // Cancel worker if active
    if (workerManager.isWorkerReady(this.id)) {
      workerManager.cancel(this.id, reason);
    }
  }

  /**
   * Request a polite stop (Pause) over a thread and everything below it: the
   * work in flight there finishes and records its real result, then rests before
   * the next LLM turn. Deliberately does NOT call stopProcessing /
   * cancelAllActions / cancelAllPendingApprovals / addCancellationMessage —
   * polite is uniformly non-destructive; it interrupts nothing and leaves every
   * thread open. It only sends the `pause` message and adds the optimistic local
   * mark that renders the Pause button active until the worker's own lands.
   * @param {string|null} [threadItemId] - The column the Pause came from; null
   *   (the root) pauses the whole conversation.
   */
  requestPoliteStop(threadItemId = null) {
    if (!workerManager.isWorkerReady(this.id)) return;
    const id = threadItemId || '';
    workerManager.pause(this.id, id);
    this._politeStops.add(id);
  }

  /**
   * Lift the Pause standing over a thread — the inverse of requestPoliteStop,
   * and what makes the button a toggle: press to pause, press again to resume.
   * A no-op unless a pause actually covers this thread.
   *
   * It lifts ancestors' marks too, because that is the only honest reading of a
   * press: a column covered by its parent's pause says Paused, and lifting the
   * mark the label refers to is what the user is asking for. Deliberately NOT
   * reachable from shift+Escape — that shortcut only ever requests a pause.
   * @param {string|null} [threadItemId] - The column the press came from.
   */
  cancelPoliteStop(threadItemId = null) {
    const id = threadItemId || '';
    if (this.politeStopState(id) === 'none') return;
    if (workerManager.isWorkerReady(this.id)) workerManager.unpause(this.id, id);
    for (const mark of [...this._politeStops]) {
      if (this._politeStopCovers(mark, id)) this._politeStops.delete(mark);
    }
  }

  /**
   * What a Pause currently means for one column.
   *
   * Server-authoritative: the worker publishes its marks as
   * `processingState.politeStops`, each reporting whether it has `landed` — so
   * this survives a page reload, and a pause that has taken is distinguishable
   * from one still winding down. The local marks are only the optimistic cue
   * covering the window between the click and the worker's first frame carrying
   * it; a local mark whose conversation is no longer running is dropped, since
   * the request it stands for reached a worker with nothing to pause.
   * @param {string|null} [threadItemId] - The column asking; null is the root.
   * @returns {'none'|'pending'|'paused'} `pending` while covered work is still
   *   finishing, `paused` once everything under the mark has come to rest.
   */
  politeStopState(threadItemId = null) {
    const published = this.processingState?.politeStops;
    const synced = /** @type {Record<string, {landed?: boolean}>|null} */ (
      published && typeof published === 'object' ? published : null
    );
    // The overwhelmingly common case, and the one that must cost nothing: no
    // pause anywhere, so no ancestry walk.
    if (!synced && this._politeStops.size === 0) return 'none';

    const chain = threadAncestry(this._rootMessageThread?.items ?? [], threadItemId || '');
    let covered = false;
    let landed = true;
    for (const mark of chain) {
      const entry = synced ? synced[mark === '' ? 'root' : mark] : null;
      if (!entry) continue;
      covered = true;
      if (entry.landed !== true) landed = false;
    }
    if (covered) {
      // The worker's marks have arrived; the optimistic ones have done their job.
      for (const mark of chain) this._politeStops.delete(mark);
      return landed ? 'paused' : 'pending';
    }
    if (!chain.some((mark) => this._politeStops.has(mark))) return 'none';
    if (!this.isTurnActive()) {
      for (const mark of chain) this._politeStops.delete(mark);
      return 'none';
    }
    return 'pending';
  }

  /**
   * Whether a Pause is still winding this column's work down.
   * @param {string|null} [threadItemId] - The column asking; null is the root.
   * @returns {boolean} True while covered work is still finishing.
   */
  isPolitePending(threadItemId = null) {
    return this.politeStopState(threadItemId) === 'pending';
  }

  /**
   * Whether a Pause has landed over this column: everything under the mark has
   * come to rest, and nothing runs here again until it is lifted.
   * @param {string|null} [threadItemId] - The column asking; null is the root.
   * @returns {boolean} True when this column is paused.
   */
  isPolitePaused(threadItemId = null) {
    return this.politeStopState(threadItemId) === 'paused';
  }

  /**
   * Whether a mark on one thread stands over another.
   * @param {string} markThreadId - The thread the mark names ('' is the root).
   * @param {string} threadItemId - The thread being asked about.
   * @returns {boolean} True when the mark covers that thread.
   * @private
   */
  _politeStopCovers(markThreadId, threadItemId) {
    if (markThreadId === '') return true;
    return threadAncestry(this._rootMessageThread?.items ?? [], threadItemId).includes(markThreadId);
  }

  /**
   * Whether a turn is currently in flight on this conversation.
   *
   * Synchronous snapshot of the same two truth sources `cancelAndSettle`
   * settles on, so callers that only want to REFUSE a mid-turn action (rather
   * than cancel it) can check without awaiting. See `cancelAndSettle` for the
   * rationale on each source, and `model/processing-status.js` for how this
   * question differs from the conversation's other busy questions.
   * @returns {boolean} true if the worker is mid-turn OR a frontend-driven
   *   tool action is still running.
   */
  isTurnActive() {
    return statusHoldsTurn(this.processingState?.status) || this._actionExecutor.hasRunningActions();
  }

  /**
   * Cancel any in-flight processing AND wait for it to settle.
   *
   * This is the architectural chokepoint that any code wanting to mutate the
   * conversation while a turn might be live should call. Without it, callers
   * race the worker / action-executor and can snapshot mid-flight state into
   * permanent Yjs items (e.g. a bash tool stuck `state: 'running'` inside a
   * compacted sub-thread).
   *
   * Truth sources (in order):
   *   1. Worker's `processingState.status` in the Yjs metadata — the worker
   *      is the single writer and this reflects whatever phase it is in
   *      (preparing/streaming/processing_tools/mock-paused/idle/etc.).
   *      `llmState.isProcessing` is a UI projection that only models
   *      production statuses, so we cannot use it alone — e.g. it does not
   *      recognise the test-only `mock-paused` status and would report
   *      "idle" while the worker is actually parked.
   *   2. `_actionExecutor.hasRunningActions()` — any frontend-driven tool
   *      action (bash/edit/etc.) still mid-flight.
   *
   * Resolves once both are quiet. Idempotent — if nothing is in flight it
   * resolves on the next microtask. Reactive on the Yjs metadata observer
   * the worker already writes through; the poll is a safety net for the
   * action-executor side which does not (yet) push events.
   * @param {string} [reason] - What caused the cancel, for the worker's log.
   * @returns {Promise<void>}
   */
  async cancelAndSettle(reason) {
    const settled = () => !this.isTurnActive();

    if (settled()) return;

    // Something is in flight and we're about to cancel it. Surface that so
    // the preemption is never silent — every caller (the new-thread button, the
    // slash menu) reaches the user through this one notice.
    this.showWarning(TURN_CANCELLED_NOTICE, 5000);

    this.stopProcessing(reason);

    if (settled()) return;

    await new Promise((resolve) => {
      const finish = () => {
        if (!finished && settled()) {
          finished = true;
          clearInterval(pollId);
          clearTimeout(timeoutId);
          this.unobserveMetadata(metaObserver);
          resolve(undefined);
        }
      };
      let finished = false;
      const metaObserver = (/** @type {any} */ event) => {
        if (event.keysChanged?.has?.('processingState')) finish();
      };
      this.observeMetadata(metaObserver);
      const pollId = setInterval(finish, CANCEL_POLL_MS);
      const timeoutId = setTimeout(() => {
        if (finished) return;
        finished = true;
        clearInterval(pollId);
        this.unobserveMetadata(metaObserver);
        resolve(undefined);
      }, CANCEL_CEILING_MS);
    });
  }

  /**
   * Add a cancellation message
   * Called when user cancels an operation
   * @param {string} [reason] - The gesture behind the stop, for the worker's log.
   */
  addCancellationMessage(reason = 'stop') {
    this.stopProcessing(reason);
    this._handleCancellation();
  }

  // ========================================================================
  // CONFIGURATION (MODEL, STRATEGY, PERMISSIONS)
  // ========================================================================

  /**
   * Set the LLM model configuration for this conversation
   * @param {ModelConfig|null} config - Model configuration (provider and model)
   * @returns {void}
   */
  setModelConfig(config) {
    const root = this._rootMessageThread;
    const changed = root.modelConfig?.provider !== config?.provider ||
                        root.modelConfig?.model !== config?.model;

    if (changed) {
      // Setter writes to Yjs metadata; the metadata observer
      // handles _fetchContextWindow and contextWindow clearing.
      root.modelConfig = config;
    }
  }



  /**
   * Ensure context window is fetched for current model
   * @async
   */
  async ensureContextWindow() {
    if (this.modelConfig && !this.contextWindow) {
      await this._fetchContextWindow(this.modelConfig);
    }
  }

  /**
   * Fetch and store the context window for the current model
   * @param {ModelConfig|null} modelConfig - Model configuration
   *     */
  async _fetchContextWindow(modelConfig) {
    if (!modelConfig) return;
    const { provider, model } = modelConfig;
    if (!provider || !model) return;
    // Resolve the window from the WS-pushed provider list — the single source
    // of truth, mirrored client-side in providersCache. waitForFirst() covers
    // the cold-start race (the conversation loads before the first push lands);
    // every client is seeded a providers-update on connect, so it never hangs.
    // A model whose window isn't in the list yet (e.g. a live-API-only model
    // before the first refresh completes) simply stays unset and is backfilled
    // by applyProvidersContextWindow on the next push — no REST round-trip, so
    // no transient 404 in the console.
    const list = await providersCache.waitForFirst();
    if (this.applyProvidersContextWindow(list)) {
      this._session.notifyConversationChange('conversation:context-window-updated', this);
    }
  }

  /**
   * Re-resolve the cached context window from a freshly pushed provider list
   * (the `providers-update` WS event). The value captured at modelConfig time
   * can be a cold-start fallback — claudecode only learns a model's true
   * window from the first turn's CLI result event, then the server
   * rebroadcasts the list — so this lets the footer correct itself once the
   * real number arrives.
   * @param {Array<any>} providers - Provider list from providers-update.
   * @returns {boolean} True when the cached context window changed.
   */
  applyProvidersContextWindow(providers) {
    const config = this.modelConfig;
    if (!config?.provider || !config?.model) return false;
    const provider = providers.find((/** @type {any} */ p) => p?.name === config.provider);
    const model = provider?.modelsWithContext?.find((/** @type {any} */ m) => m?.id === config.model);
    const next = model?.contextWindow;
    if (!next || next === this.contextWindow) return false;
    this.contextWindow = next;
    return true;
  }

  // ========================================================================
  // ID GENERATION
  // ========================================================================

  /**
   * Generate a unique message ID using timestamp + random suffix.
   * This prevents conflicts when undo/redo restores old IDs while new messages are created.
   * @returns {string} Unique message ID (e.g., "msg-1705693200000-a3f2")
   *     */
  _nextItemId() {
    // Use timestamp + random suffix for uniqueness
    // This ensures IDs from undo/redo (which restore old IDs) won't conflict with new ones
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 6);
    return `msg-${timestamp}-${random}`;
  }

  /**
   * Serialize conversation to JSON (metadata only - content is in Yjs binary)
   * @returns {{
   *   id: string,
   *   name: string,
   *   created: string
   * }} JSON representation of conversation
   */

  // ========================================================================
  // SERIALIZATION AND CLONING
  // ========================================================================

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      created: this.created
    };
  }

  // ========================================================================
  // UI INTERACTION
  // ========================================================================

  /**
   * Resolve the effective model for a send and return the matching provider
   * cache entry when that provider is known to be unavailable, else null.
   *
   * Conservative on purpose: returns null (allow the send) when no model is
   * selected, or when the provider isn't in the cache at all (a cold cache or
   * a provider that no longer exists). We only refuse on a positive
   * "this provider exists and is not available" signal, so an incomplete local
   * cache never blocks a turn.
   * @param {MessageThread} [messageThread] Thread being sent into, if any.
   * @returns {import('../services/providers-cache.js').Provider|null} The unavailable provider's cache entry, or null to allow the send.
   * @private
   */
  _unavailableSelectedProvider(messageThread) {
    const config = messageThread?.modelConfig || this.modelConfig;
    if (!config || !config.provider) return null;
    const entry = providersCache.get().find(p => p.name === config.provider);
    // Refuse only on a positive "exists and is unavailable" signal. A missing
    // `available` field (partial fixture, pre-`available` payload) is treated as
    // unknown → allow, so incomplete local state never blocks a turn.
    if (!entry || entry.available !== false) return null;
    return entry;
  }

  /**
   * The selected provider when it is one Juggler spawns as a subprocess and
   * this conversation works somewhere that cannot host one.
   *
   * Asked of the live provider list and the live binding, because both move
   * independently of the selection: a conversation picks claudecode in the
   * project and is then bound elsewhere, and nothing retargets the model.
   * @param {any} messageThread - The thread being sent to, whose config wins.
   * @returns {import('../services/providers-cache.js').Provider|null} The stranded provider, or null to allow the send.
   * @private
   */
  _providerNeedingALocalWorkspace(messageThread) {
    if (this.workspaceHostsLocalProviders !== false) return null;
    const config = messageThread?.modelConfig || this.modelConfig;
    if (!config?.provider) return null;
    const entry = providersCache.get().find(p => p.name === config.provider);
    return /** @type {any} */ (entry)?.spawnsLocalProcess ? entry : null;
  }

  /**
   * Why the place this conversation works in cannot be worked in, if it cannot.
   *
   * These are the server's own refusals, said early: `workspaceRoot` makes the
   * same four checks `WorkspaceLookup.Usable` makes, and answers null rather than
   * the project for exactly the reason a send must not go through — a binding
   * that quietly resolved to the project would edit the wrong tree and look like
   * working.
   *
   * A workspace still being BUILT is not this. It is not a binding that cannot
   * be honoured, it is one that does not exist yet, and the dialog that is
   * building it shows it being built.
   * @returns {string} The reason, ready to read, or '' when there is nothing wrong.
   * @private
   */
  _unusableWorkspace() {
    const id = this.workspaceId || '';
    if (!id || this.workspaceRoot) return '';

    const workspace = this.session?.getWorkspace?.(id) ?? null;
    if (workspace?.state === 'provisioning') return '';
    if (!workspace) return 'there is no record of the workspace this conversation works in';

    const named = workspace.label || workspace.root || 'it';
    if (workspace.state === 'closed') {
      const closedBy = typeof workspace.meta?.closedBy === 'string' ? workspace.meta.closedBy : '';
      return `the workspace ${named} was finished with${closedBy ? ` by ${closedBy}` : ''}`;
    }
    return `the workspace ${named} is not where it was`;
  }

  /**
   * Explain that the selected model's provider is unavailable and offer the
   * same fix the model picker shows at selection time (`_showSelectionProblem`):
   * the provider's auth hint plus a jump to Provider Settings. Falls back to a
   * toast if the confirm dialog isn't wired up.
   * @param {import('../services/providers-cache.js').Provider} provider
   * @private
   */
  async _showProviderUnavailable(provider) {
    const label = provider.displayName || provider.name;
    const hint = (provider.authHint || '').trim();
    const message = hint
      ? `Can't send: ${label} is not available — ${hint}. Re-enable it in Provider Settings or pick another model.`
      : `Can't send: ${label} is not available. Re-enable it in Provider Settings or pick another model.`;
    await this._offerProviderSettings(message, 'Model unavailable');
  }

  /**
   * Explain that no AI provider is configured yet and offer a jump to Provider
   * Settings. Fired on the first-send path when the providers cache is known to
   * be empty (no API key, Claude Code not enabled) — the model picker has
   * nothing selectable, so the generic "select a model" warning is unactionable.
   * @private
   */
  async _showNoProviderConfigured() {
    const message =
      'No AI provider is configured yet — add an API key (or enable Claude Code) in Provider Settings to start chatting.';
    await this._offerProviderSettings(message, 'No provider configured');
  }

  /**
   * Show a message with an offer to jump to Provider Settings, falling back to a
   * toast warning if the confirm dialog isn't wired up.
   *
   * The view layer imports these dialogs as module functions; the model reaches
   * for the `window.*` aliases on purpose, so a headless model never hard-depends
   * on a component module and keeps working when no UI is mounted at all.
   * @param {string} message - Body text for the confirm dialog / toast
   * @param {string} title - Confirm-dialog title
   * @private
   */
  async _offerProviderSettings(message, title) {
    const showConfirm = /** @type {any} */ (window).showConfirm;
    if (typeof showConfirm !== 'function') {
      this.showWarning(message, 8000);
      return;
    }
    const goToSettings = await showConfirm(message, title, {
      confirmText: 'Go to provider settings',
      cancelText: 'Cancel',
    });
    if (goToSettings && typeof (/** @type {any} */ (window).openSettings) === 'function') {
      /** @type {any} */ (window).openSettings('providers');
    }
  }

  /**
   * Show a warning message to the user, through the composer that serves this
   * conversation.
   *
   * With no composer there is nowhere to put it and the warning is lost, so the
   * drop records itself. Every caller here is a refusal the user is owed an
   * explanation for, and a warning that vanished silently reads — in a test
   * failure block, and in a bug report — exactly like one that was never raised.
   * The tape carries the conversation id, so the block shows it beside the
   * assertion that went looking for a notice.
   *
   * It deliberately does NOT reach for the app-level `showNotice` instead. A
   * conversation without a composer usually has another surface already saying
   * this in place — a setup form puts the cursor on the very field that is
   * missing — and a document-level modal raised over it takes the focus that
   * surface just placed.
   * @param {string} message - Warning message to display
   * @param {number} [duration] - Duration to show warning in milliseconds (default: 3000)
   */
  showWarning(message, duration = 3000) {
    const composer = this._getComposer();
    if (composer && 'showWarning' in composer && typeof composer.showWarning === 'function') {
      /** @type {any} */ (composer).showWarning(message, duration);
      return;
    }
    recordTape('warning-dropped', this.id, { message, hasTab: Boolean(this._tabElement) });
    console.warn('[Conversation] warning with no composer to show it:', message);
  }

  /**
   * Handle declarative side-effects returned by command plugins.
   * This is the single point where commands' declared intents are dispatched
   * to the host application (UI, session, etc.).
   * @param {import('juggler/command-type').CommandSideEffect[]} sideEffects
   * @returns {void}
   * @private
   */
  _handleCommandSideEffects(sideEffects) {
    for (const effect of sideEffects) {
      const data = effect.data || {};
      switch (effect.type) {
        case 'openThread': {
          const tabElement = /** @type {any} */ (this._tabElement);
          if (tabElement) {
            tabElement.openThread(data.threadId);
          }
          break;
        }
        case 'setDraft': {
          // A user command in 'draft' run mode expanded its template into the
          // composer for editing before send. Commands never touch the DOM;
          // they declare intent and the host splices it in, caret at the end.
          const composer = /** @type {any} */ (this._getComposer());
          if (composer && typeof composer.setDraft === 'function') {
            composer.setDraft(String(data.text ?? ''));
          } else if (composer && typeof composer.setText === 'function') {
            composer.setText(String(data.text ?? ''));
          }
          break;
        }
        case 'openCommandManager': {
          // The /commands manager is app-level UI, so the model only asks for
          // it; app.js opens the dialog on this event.
          this._session?.notifyConversationChange('command-manager:open-requested', { conversationId: this.id });
          break;
        }
      }
    }
  }

  /**
   * The missing-model self-heal: try to recover from a "no-model" validation error. The worker's doc
   * resolved no model, yet this client is displaying a real one: the model write
   * never reached the worker (the outbound-sync gap — see session.js).
   * Re-broadcast our full doc state (which carries defaultModelConfig) so the
   * worker's doc gets the model, then resend the pending message ONCE. A
   * one-shot latch prevents a loop if the resend also bounces; it is cleared by
   * {@link armSelfHeal} on the next accepted turn. Ordering holds because the
   * resync and the resend ride the same FIFO worker channel, so the model lands
   * before re-validation.
   * @param {string|null} threadItemId - Thread the failed turn belonged to.
   * @returns {boolean} True if a resync + resend was issued, false if the error
   *   is not self-healable here (latch spent, no local model, nothing pending).
   */
  trySelfHealMissingModel(threadItemId) {
    if (this._modelSelfHealAttempted) return false;
    const cfg = this.modelConfig;
    const pending = this._pendingUserMessage;
    if (!cfg || !cfg.provider || !cfg.model || !pending || this._isEmptyMessage(pending)) return false;
    this._modelSelfHealAttempted = true;
    this.resyncToWorker();
    this.resendToWorker(pending, threadItemId);
    return true;
  }

  /**
   * Re-arm the self-heal latch, so a genuinely new divergence much later can
   * heal again rather than being suppressed forever. Called when a turn is
   * accepted, which is the proof the divergence (if any) is resolved.
   * @returns {void}
   */
  armSelfHeal() {
    this._modelSelfHealAttempted = false;
  }

  /**
   * Put the refused message back into the composer after a send failure —
   * text and images together, since that is what the user sent and the box was
   * cleared of both. Restoring the images is also what keeps their bytes alive:
   * a bounced send wrote no item, so the persisted draft becomes the only thing
   * referencing them (see the worker's CollectDraftAssetIDs).
   *
   * A send that never took the box (`consumeComposer: false`) is dropped here
   * instead: there is nothing to give back, and the box is busy holding
   * something else. Absent means restorable, so the only way to lose a message
   * is to ask for it.
   * @returns {void}
   */
  restorePendingMessage() {
    const message = this._pendingUserMessage;
    this._pendingUserMessage = null;
    if (!message || message.restorable === false || this._isEmptyMessage(message)) return;
    const composer = this._getComposer();
    if (composer && typeof (/** @type {any} */ (composer).restoreMessage) === 'function') {
      /** @type {any} */ (composer).restoreMessage(message);
    }
  }

  /**
   * Whether a pending message holds nothing worth restoring or resending.
   * Judged on BOTH halves: an image-only send has empty text, so a text-only
   * test would read it as nothing and drop the images it was holding.
   * @param {{content?: string, attachments?: Array<any>}|null} message - The pending message, if any.
   * @returns {boolean} True when there is nothing to hand back.
   * @private
   */
  _isEmptyMessage(message) {
    if (!message) return true;
    return !(message.content || '').trim() && !(message.attachments || []).length;
  }

  /**
   * Handle Yjs sync message from worker
   * @param {Uint8Array} bytes - Sync message bytes
   */
  handleYjsSyncMessage(bytes) {
    this._doc.applySyncUpdate(bytes);
  }

  /**
   * This conversation's Yjs state vector, sent to the worker on reconnect to
   * request a differential catch-up of any updates missed while disconnected.
   * @returns {Uint8Array} The encoded Yjs state vector.
   */
  getYjsStateVector() {
    return this._doc.getStateVector();
  }

  /**
   * The second half of the reconnect resync: apply the ops the worker sent
   * back, then return the ops the worker itself is missing.
   *
   * Both halves are deltas. The returned update is everything this doc holds
   * that `workerStateVector` does not cover — the edits made here while the
   * socket was down, which the transport dropped and nothing else replays.
   *
   * Applying first cannot lose a concurrent local edit. A Yjs update only ever
   * adds ops: merging the worker's delta can neither remove nor rewrite a local
   * op, so an edit made between the apply and the diff is still in the doc when
   * the diff is taken, and it is absent from the worker's vector, so the diff
   * carries it. An edit made after the diff is taken is broadcast live by the
   * doc's own update handler, the link being up again by then. And an edit the
   * worker made after it snapshotted its vector arrives on the ordinary
   * broadcast path, so excluding it here loses nothing either.
   * @param {Uint8Array|null} delta - Ops the worker sent for us to apply.
   * @param {Uint8Array} workerStateVector - The worker's encoded state vector.
   * @returns {Uint8Array|null} Ops the worker lacks, or null if it lacks none.
   */
  applyResyncResponse(delta, workerStateVector) {
    if (delta && delta.length > 0) {
      this._doc.applySyncUpdate(delta);
      // applySyncUpdate batches behind a timer; flush so the diff below is
      // taken against a doc that already holds the worker's ops rather than
      // handing them straight back.
      this._doc.flushPendingUpdates();
    }
    return this._doc.updateSince(workerStateVector);
  }

  /**
   * Activate Yjs sync for bidirectional sync with worker.
   * Called by worker manager after worker is ready.
   * Note: activateSync() is idempotent - it only connects once.
   * @param {{ broadcastInitialState?: boolean }} [opts]
   */
  activateYjsSync(opts) {
    this._doc.activateSync(opts);
  }

  /**
   * Re-broadcast this conversation's full doc state to its worker: the repair
   * for a worker whose doc is missing a write this client already holds (the
   * outbound-sync gap). Two callers, both of which detect the gap by its
   * consequence rather than by watching the transport:
   *   - the "no-model" divergence (trySelfHealMissingModel) — the worker resolved no model though
   *     this client is displaying one. Full state includes `defaultModelConfig`,
   *     so the next send validates.
   *   - a tool command the engine declined because the worker is behind on that
   *     tool (worker-manager-protocols resyncWorkerBehindTool), which would
   *     otherwise have the worker fail a tool this engine has already run.
   */
  resyncToWorker() {
    this._doc.broadcastFullState();
  }

  /**
   * Resend a message straight to the worker — the missing-model self-heal's one-shot auto-retry
   * after resyncToWorker(). Deliberately bypasses the local sendMessage guards:
   * they already passed for the original send, and this must ride the same FIFO
   * worker channel immediately after the resync so the model config lands before
   * the resend is re-validated. No-op if the worker isn't ready.
   *
   * Carries the attachments, because the refused attempt consumed nothing: a
   * `no-model` send is bounced before the worker appends the user item, so the
   * refs are unreferenced rather than spent and the resend is the first thing to
   * record them.
   * @param {{content?: string, attachments?: Array<any>}} message - The pending message to resend.
   * @param {string|null} [threadItemId] - Target thread, or null for root.
   */
  resendToWorker(message, threadItemId = null) {
    if (workerManager.isWorkerReady(this.id)) {
      workerManager.sendMessage(this.id, message.content || '', threadItemId, message.attachments);
    }
  }

  // ========================================================================
  // CLEANUP AND DESTRUCTION
  // ========================================================================

  /**
   * Clean up resources when conversation is destroyed
   */
  destroy() {
    // Stop any active LLM processing
    if (this._llmState && this._llmState.isConversationProcessing(this.id)) {
      this._llmState.stop(this.id);
    }

    // Unregister from LLM state — this tears down the per-conversation Yjs
    // metadata observer registered in setTabElement(). Without it the observer
    // (and its captured conversation) leak for the app's lifetime.
    this._llmState?.unregisterConversation?.(this.id);


    // Clean up all local context items
    this._rootMessageThread.contextItems.forEach(contextItem => {
      if (contextItem && typeof contextItem.destroy === 'function') {
        contextItem.destroy();
      }
    });

    // Wake up any waiting loops so they can exit
    this._emitStateChange();

    // Clean up Yjs observers before destroying doc
    this._yjsCleanup?.();
    this._yjsCleanup = null;

    // Clean up Y.Doc (includes sync manager cleanup)
    if (this._doc) {
      this._doc.destroy();
    }

    // No need to clear items - destroy() is final cleanup, worker will be terminated
  }

}

// Export class
export default Conversation;
