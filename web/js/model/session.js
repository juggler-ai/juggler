//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import contextItemRegistry from '../registries/context-item-registry.js';
import Conversation from './conversation.js';
import {
  SAVE_DEBOUNCE_MS,
  MAX_MESSAGE_HISTORY,
  DUPLICATE_WHILE_ACTIVE_NOTICE,
  MAX_CONVERSATION_NAME_LENGTH
} from '../utils/constants.js';
import { readFileLoad } from '../services/ops-api.js';
import workerManager from '../services/worker-manager.js';
import ConversationLoadQueue from '../services/conversation-load-queue.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { isEngine } from '../../sdk/lib/client-role.js';
import { recordTape } from '../utils/event-tape.js';
import { setupWorkerCallbacks } from './session-worker-callbacks.js';
import { approvePermittedPendingApprovals } from './conversation-tool-actions.js';
import { ensureUserPresetsLoaded, getDefaultPresetSeed } from '../services/system-prompt-presets.js';
import { BUILTIN_DEFAULT_ID } from '../../sdk/lib/system-prompt-registry.js';


/**
 * @typedef {object} ApiService
 * @property {function(): Promise<SessionData>} getSession - Get session
 * @property {function(): Promise<{active: boolean, conversationIds: string[]}>} getActiveConversations - Conversations actively running a turn (excludes approval-parked)
 * @property {function(object[], string | null, string[]|undefined, Record<string, any>|undefined): Promise<{success: boolean}>} updateSession - Update session state
 * @property {function(Record<string, any>): Promise<{metadata: Record<string, any>}>} patchSessionMetadata - Patch session metadata keys
 * @property {function(string, string=, {lane?: string, duplicateFrom?: string, origin?: string}=): Promise<{id: string, name: string, created: string}>} createConversation - Atomically create a new conversation (POST /api/conversations); duplicateFrom clones that conversation's files server-side before announcing; origin is a gesture label logged for create attribution
 * @property {function(string, string): Promise<{name: string}>} renameConversation - Rename a conversation's on-disk folder
 * @property {function(string, object): Promise<{success: boolean}>} updateConversation - Update single conversation
 * @property {function(string, {permanent?: boolean, reason?: string}=): Promise<void>} deleteConversation - Delete single conversation
 * @property {function(string): Promise<void>} binConversation - Move single conversation to .juggler/bin/
 * @property {function(string): Promise<void>} restoreConversation - Move conversation back from .juggler/bin/
 * @property {function(): Promise<{binned: Array<{id: string, name: string, lastModifiedAt: string}>}>} listBinnedConversations - List binned conversations
 * @property {function(string): Promise<void>} deleteBinnedConversation - Permanently delete a single binned conversation
 * @property {function(): Promise<void>} emptyBin - Permanently delete every binned conversation
 * @property {function(string[]): Promise<null>} reorderConversations - Reorder conversations
 * @property {function(string, Uint8Array): Promise<void>} saveConversationBinary - Save conversation binary state
 */

/**
 * @typedef {object} SessionData
 * @property {string} id - Session ID
 * @property {string} projectPath - Project path
 * @property {string} [platform] - Platform (darwin/linux/windows)
 * @property {object[]} [conversations] - Conversations JSON (legacy v4 format with embedded data)
 * @property {string[]} [conversationOrder] - Conversation IDs in order (v4 format with binary storage)
 * @property {string} activeConversationId - Active conversation ID
 * @property {string} [home] - Backend user-home directory (e.g. /Users/jules)
 * @property {ProviderInfo} providerInfo - Provider information
 * @property {string[]} [messageHistory] - Session-level message history for input navigation
 * @property {Record<string, any>} [metadata] - General-purpose key-value store for frontend flags
 */

/**
 * @typedef {object} ProviderInfo
 * @property {string} provider - Provider name
 * @property {string} model - Model name
 * @property {number} contextWindow - Context window size
 */

/**
 * @typedef {import('./conversation.js').Message} Message
 */

/**
 * @typedef {import('./conversation-document.js').ContextItemJSON} ContextItemJSON
 */

/**
 * @typedef {object} ContextItemUpdates
 * @property {object} [data] - Context item data updates
 */

/**
 * @typedef {object} ConversationServices
 * @property {import('../services/llm-state.js').default} llmState - LLM state manager for tracking processing
 * @property {import('../services/action-executor.js').default} actionExecutor - Action executor for cancellation
 * @property {import('../services/websocket.js').default} wsService - WebSocket service for cancellation
 * NOTE: conversationArea is supplied per-tab via setTabElement(), not through this services object.
 */

/**
 * Session - Client-side session state with auto-save to backend
 *
 * Manages the current session state including context items and messages.
 * Automatically loads from and saves to the backend.
 * @class
 */

/**
 * Hard upper bound on simultaneously-active (non-binned) conversations.
 * Enforced at every creation path (new + duplicate) so the cap is a real
 * invariant, not a button-disable that other paths can sneak past. Hitting it
 * surfaces a "bin some tabs to make room" message at the UI entry point.
 * @type {number}
 */
export const MAX_CONVERSATIONS = 32;

/**
 * User-facing message shown when a creation path is blocked by the cap.
 * Lives next to the constant so the number stays in sync; UI entry points
 * render it via window.showAlert (keeping modal UI out of the model layer).
 * @type {string}
 */
export const CONVERSATION_LIMIT_MESSAGE =
  `You can have at most ${MAX_CONVERSATIONS} conversations open at once. ` +
  'Bin some tabs to make room for new ones.';

class Session {
  /**
   * Create a new session
   * @param {ApiService} apiService - API service instance
   */
  constructor(apiService) {
    /**
     * API service for backend communication
     * @type {ApiService}
     * @private
     */
    this._apiService = apiService;

    /**
     * Conversations map (id -> Conversation instance)
     * @type {Map<string, import('./conversation.js').default>}
     */
    this.conversations = new Map();

    /**
     * IDs that exist on disk (in the server's conversationOrder) but failed to
     * load this session — e.g. transient init timeout. We retain them so they
     * stay in conversationOrder across saves and get retried on next reload,
     * instead of being silently dropped.
     * @type {string[]}
     */
    this._unloadedConversationIds = [];

    /**
     * ID of currently visible conversation (persisted to backend)
     * This tracks which conversation is shown in the UI and is saved to backend.
     * When session loads, it restores the last selected conversation.
     * @type {string|null}
     */
    this.visibleConversationId = null;

    /**
     * Most-recently-used conversation ID list (local only, most-recent first).
     * Used to pick the fallback tab when the visible conversation is deleted.
     * @type {string[]}
     * @private
     */
    this._mruList = [];

    /**
     * Ids of conversations whose local create/duplicate flow is mid-flight.
     * Because the client preallocates ids, entries are registered before the
     * create POST; if the server's `conversations-changed` op="created" echo
     * outruns the HTTP response, applyConversationCreated finds the id here
     * and skips the remote-load path. The local flow owns the insert and will
     * fire `conversation:created` when the worker is ready.
     * @type {Set<string>}
     * @private
     */
    this._pendingCreates = new Set();

    /**
     * Services object passed to Conversation instances
     * Set via setServices() after services are initialized
     * @type {ConversationServices|null}
     * @private
     */
    this._services = null;

    /**
     * Project path
     * @type {string}
     */
    this.projectPath = '';

    /**
     * Platform (darwin/linux/windows)
     * @type {string}
     */
    this.platform = '';

    /**
     * Backend user-home directory (e.g. /Users/jules). Used to safely resolve
     * '~/<path>' in command-approval analyses; without it those paths can only
     * be matched lexically.
     * @type {string}
     */
    this.home = '';

    /**
     * Provider information (provider, model, contextWindow)
     * @type {ProviderInfo|null}
     */
    this.providerInfo = null;

    /**
     * Session-level message history for input navigation
     * Simple array of raw user messages shared across all conversations
     * @type {string[]}
     */
    this.messageHistory = [];

    /**
     * General-purpose key-value store for frontend flags
     * Used for things like hasScannedBuiltinFacts, etc.
     * @type {Record<string, any>}
     */
    this.metadata = {};

    /**
     * Event listeners
     * @type {Map<number, Function>}
     * @private
     */
    this._listeners = new Map();

    /**
     * Next listener ID
     * @type {number}
     * @private
     */
    this._nextListenerId = 1;

    /**
     * Debounce timer for auto-save
     * @type {number|null}
     * @private
     */
    this._saveTimer = null;

    /**
     * Whether session is currently loading
     * @type {boolean}
     * @private
     */
    this._loading = false;

    /**
     * Promise for in-flight load operation
     * Used to prevent duplicate loads and ensure synchronization
     * @type {Promise<void>|null}
     * @private
     */
    this._loadPromise = null;

    /**
     * Whether worker manager has been initialized
     * @type {boolean}
     * @private
     */
    this._workerManagerInitialized = false;

    /** @type {ConversationLoadQueue|null} @private */
    this._loadQueue = null;

    /**
     * Snapshot of conversation names received in the last session manifest
     * (id → name). The backend derives these from the on-disk folder names
     * each time GET /api/session runs, so the UI can render tabs before any
     * Yjs doc hydrates. Renames go through PATCH and update conv.name plus
     * this map locally on success.
     * @type {Record<string, string>}
     * @private
     */
    this._conversationNames = {};

    /**
     * Number of conversations currently in .juggler/bin/. Sourced from
     * GET /api/session (server-authoritative) and adjusted optimistically
     * by bin/restore/delete/empty so the Bin button badge reacts before
     * the broadcast round-trip completes.
     * @type {number}
     */
    this.binnedCount = 0;

    /**
     * Approximate on-disk size, in bytes, of .juggler/trash/ (all binned
     * conversations). Server-authoritative but only occasionally refreshed
     * (a low-priority background monitor recomputes it), so treat it as a
     * cosmetic hint, not an exact figure. Sourced from GET /api/session and
     * the bin listing; 0 means unknown/empty. Drives the "(50 MB)" suffix on
     * the Bin button and the Empty-Bin action.
     * @type {number}
     */
    this.binSizeBytes = 0;
  }

  /**
   * Resolve a conversation's display name from the cached projection of
   * GET /api/session's `conversationNames` map. Returns the empty string
   * if the id is unknown (the conversation hasn't been seen on disk yet).
   * @param {string} id
   * @returns {string} Display name, or '' when no cache entry exists.
   */
  getConversationName(id) {
    return this._conversationNames[id] || '';
  }

  /**
   * Update the cached name for `id`. Used by the rename / create /
   * duplicate flows to surface the canonical name returned by the
   * server immediately, ahead of the next session refresh. The on-disk
   * folder remains the source of truth — this write is overwritten on
   * the next GET /api/session.
   * @param {string} id
   * @param {string} name
   */
  setConversationName(id, name) {
    this._conversationNames[id] = name;
  }

  // ==========================================================================
  // Server diff-event handlers
  // ==========================================================================
  //
  // Each apply* method handles one op of the `conversations-changed`
  // broadcast and mutates local state to match. They are idempotent: when
  // the originator of the action receives its own broadcast echo, the
  // local state already reflects the change and the apply call no-ops.

  /**
   * Apply a `conversations-changed` op="created" event. Loads the new conversation
   * from disk and inserts it at the top of the tab bar.
   * @param {string} id - Server-allocated conversation id
   * @param {string} name - Canonical folder name
   * @returns {Promise<void>}
   */
  async applyConversationCreated(id, name) {
    this.setConversationName(id, name);
    if (this.conversations.has(id)) {
      // Originator (or a prior broadcast) already added this conversation.
      this.notifyConversationChange('conversation:changed', { conversationId: id });
      return;
    }
    if (this._pendingCreates.has(id)) {
      // This client is creating/duplicating this preallocated id. The broadcast
      // echo can arrive before the POST response; skip the remote-load path and
      // let the local flow insert the conversation when it is ready.
      return;
    }
    const conv = await this._loadAndInsertConversation(id, { prepend: true });
    if (conv) this._notify('conversation:created', conv);
  }

  /**
   * Apply a `conversations-changed` op="deleted" event. Tears down the worker and
   * removes the conversation from the active map.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async applyConversationDeleted(id) {
    const conv = await this._dropActiveConversation(id, { clearVisibleIfNoFallback: true });
    if (conv) this._notify('conversation:deleted', conv);
  }

  /**
   * Apply a `conversations-changed` op="renamed" event. Updates the cached folder name
   * and notifies subscribers so tab labels re-render.
   * @param {string} id
   * @param {string} name - Canonical folder name
   * @returns {void}
   */
  applyConversationRenamed(id, name) {
    if (this.getConversationName(id) === name) return;
    this.setConversationName(id, name);
    this.notifyConversationChange('conversation:changed', { conversationId: id });
  }

  /**
   * Apply a `conversations-changed` op="binned" event. Tears down the worker like
   * delete does, removes from the active map, and increments the bin count.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async applyConversationBinned(id) {
    const conv = await this._dropActiveConversation(id, { clearVisibleIfNoFallback: false });
    if (!conv) return;
    this.binnedCount += 1;
    this._notify('conversation:deleted', conv);
  }

  /**
   * Apply a `conversations-changed` op="restored" event. Loads the conversation back
   * into the active map and decrements the bin count.
   * @param {string} id
   * @param {string} name - Canonical folder name
   * @returns {Promise<void>}
   */
  async applyConversationRestored(id, name) {
    this.setConversationName(id, name);
    if (this.conversations.has(id)) return;
    const conv = await this._loadAndInsertConversation(id, { prepend: false });
    if (!conv) return;
    if (this.binnedCount > 0) this.binnedCount -= 1;
    this._notify('conversation:created', conv);
  }

  /**
   * Tear down a conversation's worker and remove it from the active map,
   * MRU list, and (if visible) switch to a fallback. Returns the removed
   * `conv` so the caller can fire the appropriate notify, or null if the
   * id wasn't in the active map.
   * @param {string} id
   * @param {{clearVisibleIfNoFallback: boolean}} opts
   * @returns {Promise<object|null>} Removed conv, or null if not active.
   */
  async _dropActiveConversation(id, { clearVisibleIfNoFallback }) {
    const conv = this.conversations.get(id);
    if (!conv) return null;
    this._loadQueue?.cancel(id);
    await workerManager.destroyConversationAndWorker(conv);
    recordTape('session-mut', id, { op: 'delete', from: '_dropActiveConversation' });
    this.conversations.delete(id);
    this._mruList = this._mruList.filter(x => x !== id);
    if (this.visibleConversationId === id) {
      const fallbackId =
        this._mruList.find(x => this.conversations.has(x)) ??
        this.conversations.keys().next().value;
      if (fallbackId !== undefined) {
        this.switchConversation(fallbackId);
      } else if (clearVisibleIfNoFallback) {
        recordTape('session-mut', null, { op: 'visible', from: '_dropActive-clearFallback' });
        this.visibleConversationId = null;
      }
    }
    return conv;
  }

  /**
   * Load a conversation from disk and insert it into the active map.
   * With `prepend: true` the new entry becomes the first key (tab bar
   * head); with `prepend: false` it is appended via `Map.set` (insertion
   * order puts it at the end). Returns the loaded `conv`, or null if
   * loading failed (the error is logged).
   * @param {string} id
   * @param {{prepend: boolean}} opts
   * @returns {Promise<object|null>} Loaded conv, or null if load failed.
   */
  async _loadAndInsertConversation(id, { prepend }) {
    try {
      const conv = await workerManager.loadExistingConversation(id, this);
      if (prepend) {
        const reordered = new Map();
        reordered.set(id, conv);
        for (const [cid, c] of this.conversations) {
          if (cid !== id) reordered.set(cid, c);
        }
        this.conversations = reordered;
      } else {
        recordTape('session-mut', id, { op: 'set', from: '_loadAndInsertConversation' });
        this.conversations.set(id, conv);
      }
      return conv;
    } catch (error) {
      console.error(`[Session] load failed for ${id}:`, error);
      return null;
    }
  }

  /**
   * Apply a `conversations-changed` op="binned-deleted" event. The only visible
   * effect is the bin-count badge.
   * @param {string} _id
   * @returns {void}
   */
  applyBinnedConversationDeleted(_id) {
    if (this.binnedCount > 0) this.binnedCount -= 1;
  }

  /**
   * Apply a `conversations-changed` op="reordered" event. Rebuilds the
   * conversations Map in the server-provided order. Idempotent: if the
   * local order already matches (we were the originator), no-op.
   * @param {string[]} order - New conversation id order from the server
   * @returns {void}
   */
  applyConversationsReordered(order) {
    if (!Array.isArray(order)) return;

    // Fast path: order matches what we already have → originator echo.
    const localKeys = Array.from(this.conversations.keys());
    if (order.length === localKeys.length &&
        order.every((id, i) => localKeys[i] === id)) {
      return;
    }

    // Rebuild Map in server order. Ids we don't have are skipped — their
    // matching `created` / `restored` event will land separately and
    // insert them. Ids the server didn't mention are appended (defensive;
    // a drag-reorder always carries the full order).
    const next = new Map();
    for (const id of order) {
      const conv = this.conversations.get(id);
      if (conv) next.set(id, conv);
    }
    for (const [id, conv] of this.conversations) {
      if (!next.has(id)) next.set(id, conv);
    }
    this.conversations = next;
    this._notify('conversation:reordered', {});
  }

  /**
   * Subscribe to session changes
   * @param {Function} callback - Callback function (event) => void
   * @returns {Function} Unsubscribe function
   */
  subscribe(callback) {
    const id = this._nextListenerId++;
    this._listeners.set(id, callback);

    return () => {
      this._listeners.delete(id);
    };
  }

  /**
   * Set services object for creating Conversation instances
   * Must be called before loading session or creating conversations
   * @param {ConversationServices} services - Services object
   */
  setServices(services) {
    this._services = services;

    // Register session-wide file change listener
    if (services.wsService) {
      /** @type {import('../services/websocket.js').WSEventCallback} */
      this._fileChangeHandler = (changes) => {
        const conv = this.getVisibleConversation();
        if (!conv) return;
        const fileChanges = /** @type {Array<{path: string, event: string}>} */ (changes);
        for (const contextItem of conv.rootMessageThread.contextItems) {
          const manifest = /** @type {any} */ (contextItem.constructor).MANIFEST;
          if (manifest?.watchesFileChanges && /** @type {any} */ (contextItem).onFileChange) {
            for (const change of fileChanges) {
              /** @type {any} */ (contextItem).onFileChange(change.path, change.event);
            }
          }
        }
      };
      services.wsService.on('file-change', this._fileChangeHandler);

      // When the server changes its loaded project, every connected client
      // must reload to repopulate session state from the new project.
      this._projectChangedHandler = (/** @type {unknown} */ data) => {
        // The engine is persistent across a runtime project switch and, unlike
        // viewers, never reloads (it has no page to reload). It must still
        // repoint its project root: otherwise the explore_code sandbox keeps
        // exposing the PREVIOUS project's root to the model, which then reads /
        // globs the old tree while the header bar shows the new project.
        if (isEngine()) {
          this._applyEngineProjectRoot(/** @type {{projectPath?: string}} */ (data)?.projectPath);
          return;
        }
        // Viewers: hard reload — the worker manager, conversation tabs, context
        // items, and Yjs documents are all keyed off the old project's state and
        // need the teardown/rebuild a fresh page load performs anyway.
        if (typeof window !== 'undefined') window.location.reload();
      };
      services.wsService.on('project-changed', this._projectChangedHandler);

      // The server learns some models' true context window only after the
      // first turn — claudecode reads it from the CLI result event — and then
      // rebroadcasts the provider list. Re-resolve each loaded conversation's
      // cached context window from the fresh list so footers stop showing the
      // cold-start fallback (e.g. 200k for a 1M-window opus) once the real
      // number is known.
      /** @type {import('../services/websocket.js').WSEventCallback} */
      this._providersUpdateHandler = (providers) => {
        const list = /** @type {Array<any>} */ (Array.isArray(providers) ? providers : []);
        for (const conv of this.conversations.values()) {
          if (conv.applyProvidersContextWindow(list)) {
            this._notify('conversation:context-window-updated', conv);
          }
        }
      };
      services.wsService.on('providers-update', this._providersUpdateHandler);
    }
  }

  /**
   * Repoint the engine's project root after a runtime project switch.
   *
   * The engine host captures its project root once at boot (Node: the
   * JUGGLER_PROJECT_ROOT env var; webview: the sandbox HTML template) and,
   * being persistent across SwitchProject, never reloads to pick up a new one.
   * This updates both `session.projectPath` and the live
   * `globalThis.__jugglerProjectRoot` that the explore_code sandbox delegates
   * read per run, so a switched project stops leaking the previous root to the
   * model. No-op-safe for viewers (they hard-reload instead); only the engine
   * realm calls this.
   * @param {string} [newPath] - The switched-to project root ("" = no project)
   */
  _applyEngineProjectRoot(newPath) {
    this.projectPath = newPath || '';
    /** @type {any} */ (globalThis).__jugglerProjectRoot = this.projectPath;
  }

  /**
   * Whether a conversation is mid-turn (LLM busy), read straight from its
   * processingState Yjs metadata. Used only by the busy-barrier in
   * bumpConversation, so a bumped tab tucks beneath the leading run of busy
   * tabs instead of jumping over them.
   * @param {import('./conversation.js').default} [conv]
   * @returns {boolean} True while the conversation is mid-turn (LLM busy)
   * @private
   */
  _isConvBusy(conv) {
    if (!conv) return false;
    if (conv._llmState?.isConversationProcessing?.(conv.id)) return true;
    const state = conv.getMetadata('processingState');
    const status = state && state.status;
    return !!status && status !== 'idle' && status !== 'error' && status !== 'validation-error';
  }

  /**
   * Names of every conversation the server reports as actively running a turn.
   * Read from the authoritative server signal (GET /api/health/active), which
   * excludes turns parked solely on a pending tool approval — those are doing no
   * work and survive a restart intact, so they must not provoke a warning. Used
   * before a destructive action that tears this session down (switching the
   * window to another project). Returns [] if the server can't be reached
   * (fail-open: nothing we can prove is running).
   * @returns {Promise<string[]>} Display names of actively-running conversations
   */
  async busyConversationNames() {
    /** @type {string[]} */
    let ids = [];
    try {
      const health = await this._apiService.getActiveConversations();
      if (health && health.active && Array.isArray(health.conversationIds)) {
        ids = health.conversationIds;
      }
    } catch (_e) {
      return [];
    }
    return ids.map((/** @type {string} */ id) => this.getConversationName(id) || 'Untitled');
  }

  /**
   * Cancel every locally loaded conversation that is currently active, optionally
   * constrained to server-reported active IDs. Resolves after each conversation's
   * worker metadata has settled to idle.
   * @param {string[]} [conversationIds]
   * @returns {Promise<void>}
   */
  async cancelAllActiveConversations(conversationIds) {
    const wanted = Array.isArray(conversationIds) ? new Set(conversationIds) : null;
    const active = [];
    for (const [id, conv] of this.conversations) {
      if (wanted && !wanted.has(id)) continue;
      if (this._isConvBusy(conv) || conv.isProcessing) {
        active.push(conv);
      }
    }
    await Promise.all(active.map((conv) => conv.cancelAndSettle()));
  }

  /**
   * Float a conversation toward the top of the tab list.
   *
   * By default the tab stops just beneath the leading run of busy tabs, so an
   * LLM-driven update can refresh recency without jiggling the active band at
   * the top. Local user sends pass `forceTop: true` because explicit user input
   * should always take priority over that busy-tab barrier.
   *
   * Honours manual drag order otherwise — this only moves the one conversation.
   * Persists via the reorder endpoint (no-op when already in place, which also
   * dedupes the convergent writes other viewers make for the same transition).
   * @param {string} conversationId
   * @param {{forceTop?: boolean}} [options]
   */
  bumpConversation(conversationId, options = {}) {
    if (!this.conversations.has(conversationId)) return;
    const order = Array.from(this.conversations.keys());

    let target = 0;
    if (!options.forceTop) {
      // Target = length of the leading contiguous run of *other* busy tabs.
      for (const id of order) {
        if (id === conversationId) continue;
        if (this._isConvBusy(this.conversations.get(id))) {
          target += 1;
        } else {
          break;
        }
      }
    }

    // A bump only ever floats a conversation UP. If it already sits at or
    // above its barrier-computed ceiling — e.g. a user send force-topped it
    // and its own streaming chunks then trigger an LLM-driven bump while a
    // tab below it is busy — moving it down to the ceiling would demote it,
    // and a recency signal can never mean "less recent".
    const current = order.indexOf(conversationId);
    if (current <= target) return; // at or above its ceiling — no churn, no POST

    const conv = this.conversations.get(conversationId);
    const rebuilt = new Map();
    const without = order.filter(id => id !== conversationId);
    without.splice(target, 0, conversationId);
    for (const id of without) {
      rebuilt.set(id, id === conversationId ? conv : this.conversations.get(id));
    }
    this.conversations = rebuilt;

    this._notify('conversation:reordered', { conversationId });

    // Persist the new ordering. The server merges this (possibly partial)
    // order into the manifest, so a viewer that knows only some conversations
    // never drops the others (see SessionManager.ReorderConversations).
    this._persistOrder('bump reorder');
  }

  /**
   * Get services object (used by test infrastructure)
   * @returns {ConversationServices|null} Services object or null if not set
   */
  getServices() {
    return this._services;
  }

  /**
   * Generate a unique conversation ID matching the backend's conv_<9-char base36> shape.
   * @private
   * @returns {string} Unique conversation ID
   */
  _generateConversationId() {
    const charset = '0123456789abcdefghijklmnopqrstuvwxyz';
    const length = 9;
    let result = '';
    const cryptoObj = globalThis.crypto;
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
      const bytes = new Uint8Array(length);
      cryptoObj.getRandomValues(bytes);
      for (const byte of bytes) {
        result += charset.charAt(byte % charset.length);
      }
    } else {
      for (let i = 0; i < length; i++) {
        result += charset.charAt(Math.floor(Math.random() * charset.length));
      }
    }
    return `conv_${result}`;
  }

  /**
   * Get the visible conversation
   * @returns {import('./conversation.js').default|null} Currently visible conversation or null
   */
  getVisibleConversation() {
    if (!this.visibleConversationId) {
      return null;
    }
    return this.conversations.get(this.visibleConversationId) || null;
  }

  /**
   * Get a conversation by ID
   * @param {string} conversationId - Conversation ID
   * @returns {import('./conversation.js').default|null} Conversation instance or null if not found
   */
  getConversation(conversationId) {
    return this.conversations.get(conversationId) || null;
  }

  /**
   * Notify all listeners of a change
   * @param {string} type - Event type
   * @param {any} data - Event data
   * @private
   */
  _notify(type, data) {
    this._listeners.forEach((callback) => {
      try {
        callback({ type, data, session: this });
      } catch (error) {
        console.error('[Session] Listener error:', error);
      }
    });
  }

  /**
   * Notify listeners about a conversation state change
   * Public method for Conversation instances to trigger session-level notifications
   * Also dispatches a DOM CustomEvent so UI components can listen via document.addEventListener
   * @param {string} type - Event type (e.g., 'conversation:strategy-changed')
   * @param {any} data - Event data
   */
  notifyConversationChange(type, data) {
    this._notify(type, data);

    // Also dispatch as DOM event for UI components that listen via document.
    // The engine worker has no document and no UI listeners — observers fire
    // via _notify regardless, so skipping the DOM event off-thread is safe.
    if (typeof document !== 'undefined') {
      document.dispatchEvent(new CustomEvent(type, { detail: data }));
    }
  }

  /**
   * Read a session metadata key.
   * @param {string} key
   * @returns {any} Metadata value, or undefined when absent
   */
  getMetadata(key) {
    return this.metadata ? this.metadata[key] : undefined;
  }

  /**
   * Apply a metadata patch locally and notify listeners. Values set to null or
   * undefined delete the key.
   * @param {Record<string, any>} patch
   * @param {{remote?: boolean}} [options]
   */
  applySessionMetadataPatch(patch, options = {}) {
    if (!patch || typeof patch !== 'object') return;
    if (!this.metadata) this.metadata = {};
    const keys = [];
    for (const [key, value] of Object.entries(patch)) {
      keys.push(key);
      if (value === null || value === undefined) delete this.metadata[key];
      else this.metadata[key] = value;
    }
    this._notify('session:metadata-changed', {
      keys,
      metadata: patch,
      remote: !!options.remote
    });
    if (keys.includes('sessionPermissionRules') || keys.includes('sessionAllowedPaths')) {
      for (const conversation of this.conversations.values()) {
        const itemTypes = [];
        if (keys.includes('sessionPermissionRules')) itemTypes.push('execute', 'write-file');
        if (keys.includes('sessionAllowedPaths')) itemTypes.push('execute');
        try { approvePermittedPendingApprovals(conversation, { allowViewer: true, itemTypes }); }
        catch (err) { console.error('[Session] permission re-check failed:', err); }
      }
    }
  }

  /**
   * Patch session metadata and broadcast through the backend. The local model is
   * updated optimistically so UI and permission checks react immediately.
   * @param {Record<string, any>} patch
   * @returns {Promise<void>}
   */
  async patchMetadata(patch) {
    this.applySessionMetadataPatch(patch, { remote: false });
    if (typeof this._apiService.patchSessionMetadata === 'function') {
      await this._apiService.patchSessionMetadata(patch);
    } else {
      await this.saveImmediately();
    }
  }


  /**
   * Re-attempt a conversation load that previously errored. Wired to the
   * conversation panel's "Retry" button.
   * @param {string} conversationId
   */
  retryConversationLoad(conversationId) {
    this._loadQueue?.retry(conversationId);
  }

  /**
   * Resolves once the given conversation finishes hydrating. Triggers a load
   * if it's currently 'unloaded'. Used by tests that reload a session and
   * need to read items off a specific conv.
   * @param {string} conversationId
   * @returns {Promise<void>}
   */
  async ensureConversationLoaded(conversationId) {
    const conv = this.conversations.get(conversationId);
    if (!conv) return;
    if (conv.loadState === 'loaded') return;
    if (!this._loadQueue) return;
    if (conv.loadState === 'unloaded') {
      this._loadQueue.prioritize(conversationId);
    } else if (conv.loadState === 'error') {
      this._loadQueue.retry(conversationId);
    }
    try {
      await this._loadQueue.whenLoaded(conversationId);
    } catch (error) {
      console.error(`[Session] Conversation ${conversationId} failed to load:`, error);
    }
  }

  /**
   * Load session from backend
   * Uses promise-based synchronization to prevent race conditions
   * @async
   * @returns {Promise<void>}
   */
  async load() {
    // If already loading, wait for the in-flight load to complete
    if (this._loading && this._loadPromise) {
      console.log('[Session] Load already in progress, waiting for completion');
      return await this._loadPromise;
    }

    this._loading = true;
    this._loadPromise = this._doLoad();

    try {
      await this._loadPromise;
    } finally {
      this._loading = false;
      this._loadPromise = null;
    }
  }

  /**
   * Internal implementation of session loading
   * @async
   * @returns {Promise<void>}
   * @private
   */
  async _doLoad() {
    try {
      // Ensure the context item registry is initialized — Session needs it to
      // create context items and handle actions.
      // @ts-ignore - BaseRegistry has isInitialized() and init() methods
      if (contextItemRegistry && !contextItemRegistry.isInitialized()) {
        // @ts-ignore - BaseRegistry has init() method
        await contextItemRegistry.init();
      }

      const data = await this._apiService.getSession();

      // Populate session-level state BEFORE initialising the worker manager and
      // registering approval callbacks. Session-scoped permission rules
      // (sessionPermissionRules in metadata) and the project root (projectPath)
      // are read by isPermitted → getRulesFor → getSessionRules the moment the
      // engine can receive approval requests from workers. If these fields are
      // still at their constructor defaults ({}/undefined) when the first
      // evaluate-tool arrives, every session-scoped auto-approve rule is
      // invisible — the command is wrongly flagged for approval, and the
      // suggestion engine offers to add the very rule the user already has.
      if (data.projectPath) {
        this.projectPath = data.projectPath;
        // Seed the live project root the explore_code sandbox delegates read.
        // The engine's boot-time root (env / sandbox template) is authoritative
        // until this point; keeping the global in step here means a later
        // project switch (_applyEngineProjectRoot) is the only thing that moves
        // it, and the sandbox never lags the loaded project.
        if (isEngine()) {
          /** @type {any} */ (globalThis).__jugglerProjectRoot = data.projectPath;
        }
      }
      if (data.platform) {
        this.platform = data.platform;
      }
      if (data.home) {
        this.home = data.home;
      }
      if (data.messageHistory) {
        this.messageHistory = data.messageHistory;
      } else {
        this.messageHistory = [];
      }
      this.metadata = data.metadata || {};

      // Initialize worker manager with session config (Pass session for conversation access)
      if (!this._workerManagerInitialized) {
        workerManager.init({
          projectPath: data.projectPath || '',
          // globalThis.location works in both the window (Location) and the
          // engine worker (WorkerLocation); window.* would throw off-thread and
          // abort session load, leaving the worker engine unable to execute tools.
          apiBaseUrl: globalThis.location.origin
        }, this);

        // Set up callbacks for worker requests
        setupWorkerCallbacks(this);

        this._workerManagerInitialized = true;
      }

      // Create stub Conversation instances synchronously so the tab bar
      // renders immediately. session.load() resolves the moment stubs exist
      // — no Yjs hydration is awaited here. Only the visible conv is queued
      // to load (panel shows a spinner overlay until done); other tabs stay
      // 'unloaded' until the user clicks them, at which point
      // switchConversation -> loadQueue.prioritize kicks off their hydration.
      if (data.conversationOrder && data.conversationOrder.length > 0) {
        if (this._loadQueue) {
          this._loadQueue.destroy();
          this._loadQueue = null;
        }

        recordTape('session-mut', null, { op: 'clear', size: this.conversations.size });
        this.conversations.clear();
        this._unloadedConversationIds = [];

        // Conversation names live on the on-disk folder name (parsed by the
        // backend on every GET /api/session) — no client-side title cache.
        const names = /** @type {Record<string, string>} */ (
          (data && /** @type {any} */(data).conversationNames) || {}
        );
        this._conversationNames = { ...names };
        this.binnedCount = Number(/** @type {any} */(data).binnedCount) || 0;
        this.binSizeBytes = Number(/** @type {any} */(data).binSizeBytes) || 0;

        const services = this.getServices();
        if (!services) {
          throw new Error('Cannot load session: services not set (call setServices first)');
        }

        // The engine has no UI and stays fully dormant — it skips stub creation
        // so worker-manager._autoLoadConversation can pull in convs on demand
        // when a yjs-sync arrives from a worker the user has activated. Creating
        // unloaded stubs here would route yjs-sync to a doc whose outbound sync
        // was never activated, silently swallowing the engine's tool-state
        // writes and hanging tool execution.
        if (!isEngine()) {
          for (const convId of data.conversationOrder) {
            const stub = new Conversation(
              convId,
              names[convId] || 'Untitled',
              this,
              services,
              { skipBuiltInContextItems: true, loadState: 'unloaded' }
            );
            recordTape('session-mut', convId, { op: 'set', from: '_doLoad-stub' });
            this.conversations.set(convId, stub);
          }

          if (data.activeConversationId && this.conversations.has(data.activeConversationId)) {
            recordTape('session-mut', data.activeConversationId, { op: 'visible', from: '_doLoad-active' });
            this.visibleConversationId = data.activeConversationId;
          } else {
            const firstId = this.conversations.keys().next().value;
            recordTape('session-mut', firstId ?? null, { op: 'visible', from: '_doLoad-first' });
            this.visibleConversationId = firstId ?? null;
          }

          this._loadQueue = new ConversationLoadQueue({
            session: this,
            workerManager,
            concurrency: 3
          });

          if (this.visibleConversationId) {
            this._loadQueue.prioritize(this.visibleConversationId);
          }

          // Background-load the remaining conversations at low priority so
          // tab-level state (running/awaiting-approval indicators) is visible
          // for every tab on reload, not just the active one. The visible
          // conversation was prioritised above so it still loads first;
          // others trickle in at the queue's concurrency limit.
          const backgroundIds = data.conversationOrder.filter(
            (id) => id !== this.visibleConversationId
          );
          if (backgroundIds.length) {
            this._loadQueue.enqueueAll(backgroundIds);
          }
        }
      } else if (data.projectPath) {
        // Real project with no conversations yet — seed the initial "Main"
        // conversation so the user lands on a usable tab.
        await this._createInitialConversation();
      }
      // No-project mode (empty projectPath): seed nothing. The
      // <no-project-overlay> shows the project picker, and the initial
      // conversation is created once the user opens a real project — the
      // server's project-changed broadcast triggers a full page reload, which
      // re-runs this path with a populated projectPath. Seeding here would
      // build a phantom tab in an ephemeral temp dir whose writes the backend
      // silently discards; worse, createConversation awaits a worker Yjs sync,
      // so a flaky/absent worker connection would hang the whole load and
      // strand the UI with no picker and nowhere to type.

      // Refresh all context items to get fresh content (data from storage is stale)
      this._refreshAllContextItems();

      this._notify('session:loaded', this);

      // Auto-detect AI assistant files on first load (only once per session).
      // Runs after session:loaded so listeners have updated the visible conversation.
      if (!this.metadata.hasScannedAIFiles) {
        const conversation = this.getVisibleConversation();
        if (conversation) {
          this.seedConversationAutoItems(conversation)
            .then(() => {
              this.metadata.hasScannedAIFiles = true;
            });
        } else {
          this.metadata.hasScannedAIFiles = true;
        }
      }

    } catch (error) {
      // Log error with message and stack for debugging
      console.error('[Session] Failed to load:', extractErrorMessage(error));
      if (error instanceof Error && error.stack) {
        console.error('[Session] Stack trace:', error.stack);
      }
      throw error;
    }
  }

  /**
   * Create the initial conversation for an empty session. Delegates to
   * createConversation() so naming ("Task N"), default-model seeding, on-disk
   * rename and order persistence all go through the single code path —
   * no parallel bootstrap that drifts out of sync.
   * @private
   * @async
   */
  async _createInitialConversation() {
    const id = await this.createConversation('', { activate: true, origin: 'initial-bootstrap' });
    recordTape('session-mut', id, { op: 'visible', from: '_createInitialConversation' });
    this.visibleConversationId = id;
  }

  /**
   * Refresh all context items to get fresh content
   *
   * Called after session load to ensure context items have current data,
   * not stale data from when the session was last saved.
   * @private
   */
  _refreshAllContextItems() {
    const allItems = Array.from(this.conversations.values()).flatMap(conv => conv.rootMessageThread.contextItems);

    for (const item of allItems) {
      if (typeof /** @type {any} */ (item).onSessionReload === 'function') {
        /** @type {any} */ (item).onSessionReload();
      }
    }
  }

  /**
   * Save session to backend immediately (no debounce)
   * Use this for critical operations like switching conversations
   * @async
   * @returns {Promise<void>}
   */
  async saveImmediately() {

    // Clear any pending debounced save
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }

    // The engine has no UI and doesn't carry the full session manifest in
    // memory (it skips stub creation in _doLoad and only auto-loads convs
    // it actually receives yjs-syncs for). A save from here would propose
    // conversationOrder=[just the auto-loaded conv] and clobber the disk's
    // full order. Session-level state is the viewer's responsibility.
    if (isEngine()) {
      return;
    }

    try {
      // Integrity check: identify corrupt conversations (duplicate itemIds)
      // Skip corrupt conversations instead of blocking all saves
      /** @type {Set<string>} */
      const corruptConversationIds = new Set();

      for (const conv of this.conversations.values()) {
        // Read items directly from conversation (synced via Yjs)
        const itemsToCheck = conv.rootItems;

        const seen = new Set();
        let isCorrupt = false;
        for (const item of itemsToCheck) {
          const itemId = /** @type {any} */ (item).itemId;
          if (itemId) {
            if (seen.has(itemId)) {
              console.error(`[Session] Corrupt conversation ${conv.id}: duplicate itemId ${itemId} - skipping from save`);
              isCorrupt = true;
              break;
            }
            seen.add(itemId);
          }
        }

        if (isCorrupt) {
          corruptConversationIds.add(conv.id);
        }
      }

      // Log summary if any conversations were skipped
      if (corruptConversationIds.size > 0) {
        console.warn(`[Session] Skipping ${corruptConversationIds.size} corrupt conversation(s) from save: ${Array.from(corruptConversationIds).join(', ')}`);
      }

      // Yield to let any in-flight yjs-sync WebSocket messages from recently-stopped
      // workers land before serializing. When a worker shuts down it flushes a final
      // yjs-sync; the browser receives it as a WebSocket macrotask that may still be
      // queued here if terminate() was called synchronously just before this save.
      await new Promise(resolve => setTimeout(resolve, 0));

      // Serialize conversations (filter out transient, corrupt, and worker-managed conversations)
      const conversationsJson = Array.from(this.conversations.values())
        .filter(conv => !conv._isTransient)
        .filter(conv => !corruptConversationIds.has(conv.id)) // Skip corrupt conversations
        .filter(conv => {
          // Skip conversations with active workers - they handle their own saves
          if (workerManager.isWorkerReady(conv.id)) {
            return false;
          }
          return true;
        })
        .map(conv => conv.toJSON());

      // Names live on the on-disk folder name; conversation order is owned
      // by POST /api/conversations and POST /api/session/conversations/reorder.
      await this._apiService.updateSession(
        conversationsJson,
        this.visibleConversationId ?? null,
        this.messageHistory,
        this.metadata
      );

      this._notify('session:saved', this);
      this._notifyOtherViews();

    } catch (error) {
      console.error('[Session] Failed to save:', error);
      this._notify('session:save-error', error);
    }
  }

  /**
   * Save session to backend (full save - session-level state only)
   *
   * Use this for session-level changes: new conversation, delete conversation,
   * metadata changes, conversation order, etc.
   *
   * Note: Conversation content is saved by workers via workerManager notifications.
   *
   * Debounced to avoid excessive API calls.
   * @async
   * @returns {Promise<void>}
   */
  async save() {
    // Clear existing timer
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
    }

    // Debounce: wait before saving to avoid excessive API calls
    this._saveTimer = setTimeout(async () => {
      await this.saveImmediately();
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Add a message to the session-level message history
   * Used for input navigation (arrow up/down)
   * Deduplicates - if message already exists, removes old occurrence and adds at end
   * @param {string} message - Raw user message to add to history
   */
  addMessageToHistory(message) {
    // Remove any existing occurrence of this message (deduplication)
    const existingIndex = this.messageHistory.indexOf(message);
    if (existingIndex !== -1) {
      this.messageHistory.splice(existingIndex, 1);
    }

    // Add to end (most recent position)
    this.messageHistory.push(message);

    // Limit history size to last 100 messages (FIFO)
    if (this.messageHistory.length > MAX_MESSAGE_HISTORY) {
      this.messageHistory.shift(); // Remove oldest
    }

    // Save to backend
    this.save();
  }

  /**
   * Create a new conversation
   * @param {string} name - Conversation name
   * @param {object} [options] - Options
   * @param {boolean} [options.activate] - Switch to the new conversation immediately
   * @param {string} [options.origin] - Gesture label logged server-side for create
   *   attribution (plus-button, slash-command, initial-bootstrap, duplicate, …)
   * @returns {Promise<string>} New conversation ID
   */
  async createConversation(name, { activate = false, origin = 'unspecified' } = {}) {
    // A create with no caller-supplied name is a blank "Task N" the user will
    // want to name (the + button and the /new command both create this way).
    // When it's also the tab we activate, that's the signal to open inline
    // rename — decided here, once, so every unnamed-create path gets the
    // "name it now" UX without each caller wiring it up. Named creates
    // (copy/move/promote-to-tab) already have a meaningful name and are skipped.
    const wantsRename = activate && !(name && String(name).trim());
    const requestedName = name || `Task ${this.conversations.size + 1}`;

    // Preallocate the id locally so we can mark this create as pending before
    // the POST. The server's `conversations-changed` echo can outrun the HTTP
    // response; with the id known up front, applyConversationCreated skips the
    // remote-load path for our own in-flight create.
    const requestedId = this._generateConversationId();
    this._pendingCreates.add(requestedId);

    let response;
    let conversation;
    try {
      // Atomic server-side create: server creates the folder with the
      // collision-resolved canonical name, appends to order, broadcasts
      // session-changed, and returns the canonical name. By the time this
      // resolves, the name question is permanently answered — no "Untitled"
      // stage, no follow-up rename.
      response = await this._apiService.createConversation(requestedName, requestedId, { origin });
      const { id, name: canonicalName } = response;

      // WorkerManager returns conversation ONLY when fully ready (worker spawned, Yjs active).
      // The worker spawned for this id will find the existing folder via
      // ensureConvDir on its first save, preserving canonicalName on disk.
      conversation = await workerManager.createNewConversation(id, canonicalName, this);

      // Insert at top: rebuild Map so the new conversation is the first entry.
      const reordered = new Map();
      reordered.set(conversation.id, conversation);
      for (const [cid, c] of this.conversations) reordered.set(cid, c);
      recordTape('session-mut', conversation.id, { op: 'set', from: 'createConversation-insertTop' });
      this.conversations = reordered;
    } finally {
      this._pendingCreates.delete(requestedId);
      if (response && response.id !== requestedId) {
        this._pendingCreates.delete(response.id);
      }
    }

    this._notify('conversation:created', conversation);

    if (activate) {
      this.switchConversation(conversation.id);
    }

    // Seed the system prompt from the user's chosen default preset (an explicit,
    // user-controlled session default — replaces the old implicit "copy the
    // prompt forward from the most recent conversation" behaviour).
    await this._seedDefaultSystemPrompt(conversation);

    // Auto-add AI assistant files + seed always-present items (e.g. memory),
    // then clear undo stacks so they aren't undoable.
    // Must await — if clearUndoStacks races with user operations it wipes their undo groups.
    await this.seedConversationAutoItems(conversation);
    await workerManager.clearUndoStacks(conversation.id);

    // Ask the UI to open inline rename on the freshly-activated blank tab. Fired
    // last, once the tab is created, active, and seeded, so the editor positions
    // correctly. Bar-less contexts (the engine worker, the startup initial-
    // conversation created before the bar subscribes) simply have no listener.
    if (wantsRename) {
      this.notifyConversationChange('conversation:rename-requested', { conversationId: conversation.id });
    }

    return conversation.id;
  }


  /**
   * Seed a freshly created conversation's system prompt from the user's chosen
   * default preset. Like the model seed, the resolved body is copied into the
   * conversation's system-prompt item at creation time, so a later change to the
   * default never retargets an existing conversation. When no preset content
   * resolves (e.g. offline), the item's own built-in default fallback applies at
   * build time, so nothing is written.
   * @param {import('./conversation.js').default} conversation
   * @private
   */
  async _seedDefaultSystemPrompt(conversation) {
    try {
      await ensureUserPresetsLoaded();
      const { id, content } = getDefaultPresetSeed();
      // The built-in default is exactly what the system-prompt item already
      // falls back to when its stored text is empty, so writing it would only
      // add doc churn. Write only when the chosen default is a different preset
      // (a user preset or another built-in) whose body must travel in the doc —
      // user presets aren't in the engine's registry, so the content can't be
      // resolved there from the id alone.
      if (!content || id === BUILTIN_DEFAULT_ID) return;
      const targetPromptItem = conversation.rootMessageThread.contextItems.find(f => f.type === 'system-prompt');
      if (targetPromptItem) {
        conversation.rootMessageThread.updateContextItem(targetPromptItem.id, {
          data: { ...targetPromptItem.data, text: content, selectedPresetId: id, isModified: false }
        });
      }
    } catch (err) {
      console.warn('[Session] Could not seed default system prompt:', err);
    }
  }


  /**
   * Generate a unique "<base> (<word>)" name for a derived conversation (a clone
   * via /duplicate, a continuation via /handoff, …). Strips an existing
   * " (<word>)" / " (<word> N)" suffix first so re-deriving doesn't stack
   * "X (copy) (copy)", then appends the suffix and bumps a counter until unique.
   * @param {string} sourceName - Original conversation name
   * @param {string} [word] - Suffix word (default 'copy')
   * @returns {string} Unique suffixed name
   * @private
   */
  _generateUniqueSuffixedName(sourceName, word = 'copy') {
    const existingNames = new Set();
    this.conversations.forEach((conv) => {
      existingNames.add(conv.name);
    });

    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const base = sourceName.replace(new RegExp(`\\s*\\(${escaped}(?:\\s+\\d+)?\\)$`), '');

    const candidate = `${base} (${word})`;
    if (!existingNames.has(candidate)) return candidate;
    let n = 2;
    while (existingNames.has(`${base} (${word} ${n})`)) n++;
    return `${base} (${word} ${n})`;
  }

  /**
   * Duplicate a conversation and add it to the session, inserted right after the source
   * @param {string} conversationId - ID of conversation to duplicate
   * @param {object} [options] - Options
   * @param {string} [options.nameSuffix] - Suffix word for the derived name
   *   (default 'copy'; /handoff passes 'continued' → "X (continued)")
   * @returns {Promise<string|null>} New conversation ID, or null if source not found
   */
  async duplicateConversation(conversationId, { nameSuffix = 'copy' } = {}) {
    const source = this.getConversation(conversationId);
    if (!source) {
      return null;
    }

    // Refuse mid-turn. The server copies the source via FlushConversation,
    // which can't complete while a turn owns the worker run loop (its inner
    // selects don't drain flushReq), so a mid-turn duplicate hangs the HTTP
    // handler until the turn ends and then ships a clone with a `running`
    // item no worker will ever resolve. Cancelling implicitly would surprise
    // the user (and discard their in-flight work), so refuse outright and
    // let them settle or cancel explicitly. Covers every entry point:
    // Cmd-D, the tab context menu's "Duplicate", branch-from-message, and
    // `/duplicate` (which checks first to avoid a second notice).
    if (source.isTurnActive()) {
      source.showWarning(DUPLICATE_WHILE_ACTIVE_NOTICE, 5000);
      return null;
    }

    const requestedName = this._generateUniqueSuffixedName(source.name, nameSuffix);

    const requestedId = this._generateConversationId();
    this._pendingCreates.add(requestedId);
    let response;
    try {
      // 1. Server creates the clone atomically: it copies the source's
      //    persisted files (doc.yjs + txns) into the new folder and only THEN
      //    appends it to conversation order + returns/broadcasts. Because the
      //    copy precedes the announcement, no client (or the clone's own
      //    worker) ever observes an empty clone. The server flushes the
      //    source's worker first, so an open conversation is copied current.
      //    (This replaced a worker→worker copy that raced the clone worker
      //    writing an empty doc over the copy — blank large-conversation clones.)
      response = await this._apiService.createConversation(requestedName, requestedId, {
        duplicateFrom: conversationId,
        origin: 'duplicate'
      });
    } finally {
      this._pendingCreates.delete(requestedId);
      if (response && response.id !== requestedId) {
        this._pendingCreates.delete(response.id);
      }
    }
    const { id: newId, name: canonicalName } = response;

    // 2. Load the now-populated clone from disk.
    const loadedClone = await workerManager.loadExistingConversation(newId, this);
    this.setConversationName(newId, canonicalName);

    // 4. Insert clone right after source (Maps maintain insertion order) and
    //    persist the new ordering via POST /reorder.
    const newConversations = new Map();
    for (const [id, conv] of this.conversations) {
      newConversations.set(id, conv);
      if (id === conversationId) {
        newConversations.set(loadedClone.id, loadedClone);
      }
    }
    this.conversations = newConversations;
    this._persistOrder('duplicate reorder');

    // Clear undo history so user starts fresh (copied items are not undoable)
    // This prevents undoing built-in context items and copied messages
    await workerManager.clearUndoStacks(loadedClone.id);

    this._notify('conversation:created', loadedClone);
    this.save();
    return loadedClone.id;
  }

  /**
   * Persist the current conversation ordering via the reorder endpoint (the sole
   * writer of order). The server merges this (possibly partial) order into the
   * manifest. Failures are logged, not surfaced.
   * @param {string} label - Short context for the error log (e.g. 'bump reorder')
   * @private
   */
  _persistOrder(label) {
    this._apiService.reorderConversations(Array.from(this.conversations.keys()))
      .catch((/** @type {any} */ err) => console.error(`[Session] ${label} persist failed:`, err));
  }

  /**
   * Reorder a conversation by moving it before another conversation
   * @param {string} conversationId - ID of conversation to move
   * @param {string} beforeId - ID of conversation to insert before
   * @returns {boolean} Whether reorder succeeded
   */
  reorderConversation(conversationId, beforeId) {
    if (conversationId === beforeId) {
      return false;
    }

    const conv = this.conversations.get(conversationId);
    if (!conv || !this.conversations.has(beforeId)) {
      return false;
    }

    // Build new Map with conversation moved to new position
    const newConversations = new Map();
    for (const [id, c] of this.conversations) {
      if (id === conversationId) {
        // Skip - will insert at target position
        continue;
      }
      if (id === beforeId) {
        // Insert moved conversation before target
        newConversations.set(conversationId, conv);
      }
      newConversations.set(id, c);
    }

    this.conversations = newConversations;
    this._notify('conversation:reordered', { conversationId, beforeId });

    // POST /reorder is the sole writer of conversation order.
    this._persistOrder('reorder');

    return true;
  }

  /**
   * Move a conversation to the end of the tab list
   * @param {string} conversationId - ID of conversation to move
   * @returns {boolean} Whether move succeeded
   */
  moveConversationToEnd(conversationId) {
    const conv = this.conversations.get(conversationId);
    if (!conv) {
      return false;
    }

    // Delete and re-add to move to end (Map maintains insertion order)
    this.conversations.delete(conversationId);
    this.conversations.set(conversationId, conv);

    this._notify('conversation:reordered', { conversationId, beforeId: null });

    // Persist via the dedicated reorder endpoint (the sole writer of order).
    this._persistOrder('reorder');

    return true;
  }


  /**
   * Bin a conversation. Mirrors deleteConversation locally (cancels
   * loads, destroys worker, drops from the in-memory map, picks a new
   * visible tab) but the backend moves the folder to .juggler/bin/
   * instead of trashing it, so the user can restore it from the Bin
   * modal at any time (the bin never auto-expires).
   * @param {string} conversationId
   * @returns {Promise<boolean>} Whether binning succeeded
   */
  async binConversation(conversationId) {
    const conv = this.conversations.get(conversationId);
    if (!conv) {
      return false;
    }

    this._loadQueue?.cancel(conversationId);
    await workerManager.destroyConversationAndWorker(conv);

    try {
      await this._apiService.binConversation(conversationId);
      this.binnedCount += 1;
    } catch (error) {
      console.error(`[Session] Failed to bin conversation ${conversationId}:`, error);
    }

    this.conversations.delete(conversationId);
    this._mruList = this._mruList.filter(id => id !== conversationId);

    if (this.visibleConversationId === conversationId) {
      const fallbackId =
        this._mruList.find(id => this.conversations.has(id)) ??
        this.conversations.keys().next().value;
      if (fallbackId !== undefined) {
        this.switchConversation(fallbackId);
      } else {
        // Binned the last conversation. Leave the session empty rather than
        // forcing a replacement tab — the user can start a new one with "+".
        this.visibleConversationId = null;
      }
    }

    this._notify('conversation:deleted', conv);
    this._notifyOtherViews();
    return true;
  }

  /**
   * Restore a binned conversation — moves it back to the active set on disk.
   * The new tab will appear via the `conversations-changed` op="restored" broadcast.
   * @param {string} conversationId
   * @returns {Promise<void>}
   */
  async restoreConversation(conversationId) {
    await this._apiService.restoreConversation(conversationId);
    if (this.binnedCount > 0) this.binnedCount -= 1;
  }

  /**
   * List binned conversations (most recently modified first).
   * @returns {Promise<Array<{id: string, name: string, lastModifiedAt: string}>>} bin rows
   */
  async listBinnedConversations() {
    const resp = await this._apiService.listBinnedConversations();
    // Refresh the cached folder size from the same authoritative response so
    // the Bin button and Empty-Bin action reflect the latest server tally.
    this.binSizeBytes = Number(/** @type {any} */ (resp)?.binSizeBytes) || 0;
    return (resp && resp.binned) || [];
  }

  /**
   * Permanently delete a single binned conversation.
   * @param {string} conversationId
   * @returns {Promise<void>}
   */
  async deleteBinnedConversation(conversationId) {
    await this._apiService.deleteBinnedConversation(conversationId);
    if (this.binnedCount > 0) this.binnedCount -= 1;
  }

  /**
   * Permanently delete every binned conversation. The badge resets to 0
   * optimistically; per-item `binned-deleted` broadcasts reconcile peers.
   * @returns {Promise<void>}
   */
  async emptyBin() {
    await this._apiService.emptyBin();
    this.binnedCount = 0;
    this.binSizeBytes = 0;
  }

  /**
   * Delete a conversation
   * @param {string} conversationId - Conversation ID to delete
   * @param {string} [reason] - Attribution tag the server logs with the
   *   delete (e.g. which test or cleanup issued it); omitted for UI deletes
   * @returns {Promise<boolean>} Whether deletion succeeded
   */
  async deleteConversation(conversationId, reason) {
    // Prevent deleting the last conversation
    if (this.conversations.size <= 1) {
      return false;
    }

    const conv = this.conversations.get(conversationId);
    if (!conv) {
      return false;
    }

    this._loadQueue?.cancel(conversationId);

    // Destroy conversation and terminate worker (atomic operation with enforced cleanup order)
    await workerManager.destroyConversationAndWorker(conv);

    // Call backend DELETE endpoint to remove the file
    try {
      await this._apiService.deleteConversation(conversationId, { reason });
    } catch (error) {
      console.error(`[Session] Failed to delete conversation ${conversationId}:`, error);
      // Continue with local cleanup even if backend fails
    }

    this.conversations.delete(conversationId);

    // Prune the deleted conversation from the MRU list
    this._mruList = this._mruList.filter(id => id !== conversationId);

    // If we deleted the visible conversation, switch to the most recently used
    // one that still exists, falling back to the first in Map order.
    // Use switchConversation() so the load queue is prioritized if the
    // target conversation hasn't been loaded yet (otherwise it would sit
    // on the spinner indefinitely).
    if (this.visibleConversationId === conversationId) {
      const fallbackId =
        this._mruList.find(id => this.conversations.has(id)) ??
        this.conversations.keys().next().value;
      if (fallbackId !== undefined) {
        this.switchConversation(fallbackId);
      }
    }

    this._notify('conversation:deleted', conv);
    this._notifyOtherViews();
    // Don't call save() - backend DELETE already updated the session
    return true;
  }

  /**
   * Rename a conversation. Renames the on-disk folder via PATCH; on
   * success updates conv.name and the local manifest cache and emits
   * 'conversation:changed' so the tab bar re-renders. Throws an Error
   * tagged with `.code` ("INVALID" | "COLLISION" | "NOT_FOUND") on
   * non-OK responses so the UI can surface the right message.
   * @param {string} conversationId
   * @param {string} newName
   * @returns {Promise<string>} canonical (post-sanitization) name
   */
  async renameConversation(conversationId, newName) {
    const conv = this.conversations.get(conversationId);
    if (!conv) {
      const err = new Error(`Conversation not found: ${conversationId}`);
      /** @type {any} */ (err).code = 'NOT_FOUND';
      throw err;
    }
    if (!newName || newName.trim() === '') {
      const err = new Error('Conversation name is empty');
      /** @type {any} */ (err).code = 'INVALID';
      throw err;
    }
    // Data-level enforcement of the shared name-length cap. The rename input
    // caps typed input via `maxlength`, but paste and programmatic callers can
    // still overshoot — reject those here rather than letting the server
    // silently truncate the folder name to its filesystem-safety limit.
    if (newName.trim().length > MAX_CONVERSATION_NAME_LENGTH) {
      const err = new Error(
        `Conversation name exceeds ${MAX_CONVERSATION_NAME_LENGTH} characters`
      );
      /** @type {any} */ (err).code = 'INVALID';
      throw err;
    }

    let result;
    try {
      result = await this._apiService.renameConversation(conversationId, newName.trim());
    } catch (e) {
      const msg = String(/** @type {any} */ (e)?.message || e);
      const tagged = new Error(msg);
      if (msg.includes('409')) /** @type {any} */ (tagged).code = 'COLLISION';
      else if (msg.includes('400')) /** @type {any} */ (tagged).code = 'INVALID';
      else if (msg.includes('404')) /** @type {any} */ (tagged).code = 'NOT_FOUND';
      throw tagged;
    }

    const canonical = (result && /** @type {any} */ (result).name) || newName.trim();
    // Update _conversationNames, the single in-memory cache of the on-disk
    // folder name, so `conv.name` (a getter) reflects the rename immediately.
    this.setConversationName(conversationId, canonical);
    this.notifyConversationChange('conversation:changed', { conversationId });
    return canonical;
  }

  /**
   * Re-sync session state from the server.
   * Called when another view notifies us of a session change.
   * @returns {Promise<void>}
   */
  async refreshFromServer() {
    const data = await this._apiService.getSession();
    if (!data.conversationOrder) return;

    const serverOrder = data.conversationOrder;
    const reordered = new Map();

    // Folder names on disk are the source of truth. The cache replaces
    // every existing entry so any conversation rendered via conv.name
    // immediately reflects renames / restores done elsewhere.
    const names = /** @type {Record<string, string>} */ (
      (data && /** @type {any} */(data).conversationNames) || {}
    );
    this._conversationNames = { ...names };
    this.binnedCount = Number(/** @type {any} */(data).binnedCount) || 0;
    this.binSizeBytes = Number(/** @type {any} */(data).binSizeBytes) || 0;
    if (data.metadata) {
      this.metadata = data.metadata;
      this._notify('session:metadata-changed', {
        keys: Object.keys(data.metadata),
        metadata: data.metadata,
        remote: true
      });
    }
    if (data.messageHistory) this.messageHistory = data.messageHistory;

    // Preserve existing conversations in the server's order
    /** @type {import('./conversation.js').default[]} */
    const newlyLoaded = [];
    for (const id of serverOrder) {
      const existing = this.conversations.get(id);
      if (existing) {
        reordered.set(id, existing);
      } else {
        // New conversation from another view (or restored locally) — load
        // it and announce via 'conversation:created' below so conversation-bar
        // creates the <conversation-tab> host element.
        try {
          const conv = await workerManager.loadExistingConversation(id, this);
          reordered.set(id, conv);
          newlyLoaded.push(conv);
        } catch (error) {
          console.error(`[Session] Failed to load new conversation ${id}:`, error);
        }
      }
    }

    // Destroy conversations that were deleted in the other view
    for (const [id, conv] of this.conversations) {
      if (!reordered.has(id)) {
        await workerManager.destroyConversationAndWorker(conv);
      }
    }

    this.conversations = reordered;

    // Announce each newly-loaded conv so subscribers (notably the
    // conversation-bar) build the inner <conversation-tab> host element.
    for (const conv of newlyLoaded) {
      this._notify('conversation:created', conv);
    }

    // If visible conversation was deleted, switch to first.
    // Use switchConversation() so the load queue is prioritized.
    if (this.visibleConversationId && !this.conversations.has(this.visibleConversationId)) {
      const firstId = this.conversations.keys().next().value;
      if (firstId !== undefined) {
        this.switchConversation(firstId);
      }
    }

    this._notify('conversation:reordered', {});
  }

  /**
   * Notify other views that session state has changed.
   * @private
   */
  _notifyOtherViews() {
    this._services?.wsService?.sendSessionChanged?.();
  }

  /**
   * Switch to a different conversation
   * @param {string} conversationId - Conversation ID to switch to
   * @returns {boolean} Whether switch succeeded
   */
  switchConversation(conversationId) {
    const conv = this.getConversation(conversationId);
    if (!conv) {
      return false;
    }

    if (this.visibleConversationId === conversationId) {
      return true; // Already visible
    }

    // Update MRU list: move conversationId to front
    this._mruList = [conversationId, ...this._mruList.filter(id => id !== conversationId)];

    recordTape('session-mut', conversationId, { op: 'visible', from: 'switchConversation' });
    this.visibleConversationId = conversationId;

    // Bump the user's selection to the front of the load queue so a
    // still-loading or errored conv hydrates before background work.
    if (this._loadQueue) {
      if (conv.loadState === 'unloaded') {
        this._loadQueue.prioritize(conversationId);
      } else if (conv.loadState === 'error') {
        this._loadQueue.retry(conversationId);
      }
    }

    // Fetch context window if conversation has a model but no context window
    // Don't await - let it fetch in background and notify when ready
    if (conv.modelConfig && !conv.contextWindow) {
      conv.ensureContextWindow().then(() => {
        // Notify again after context window is fetched so token display updates
        this._notify('conversation:context-window-updated', conv);
      });
    }

    this._notify('conversation:switched', conv);

    // Save to persist activeConversationId
    // This is necessary because page unload saves are unreliable (async operations may not complete)
    this.save();
    return true;
  }

  /**
   * AI assistant files to auto-detect
   * @type {string[]}
   */
  static AI_ASSISTANT_FILES = [
    'CLAUDE.md',
    '.claude.md',
    '.cursorrules',
    'AGENTS.md',
    '.instructions'
  ];

  /**
   * Add AI assistant files that exist in the project
   * Checks each file exists before adding, prevents duplicates via ReadFileFactType.mergeOrReplace
   * @param {import('./conversation.js').default} conversation - Conversation to add files to
   * @param {import('./message-thread.js').default|null} [messageThread] - Target thread; null means root thread
   * @returns {Promise<number>} Number of files added
   * @async
   */
  async addAIAssistantFiles(conversation, messageThread = null) {
    // This is a best-effort optional operation - log and continue if prerequisites aren't met
    if (!conversation) {
      console.debug('[Session] Skipping AI assistant file detection: conversation not ready');
      return 0;
    }

    const mt = messageThread || conversation.rootMessageThread;

    // Check all candidate files in parallel — sequential awaits on disk-read
    // RTT (one HTTP round trip per filename) were a noticeable bottleneck
    // under iframe-pool load, with N tests racing createConversation and
    // each blocking ~K * RTT before the test could continue.
    const candidates = await Promise.all(
      Session.AI_ASSISTANT_FILES.map(async (filename) => {
        try {
          const result = await readFileLoad({ path: filename });
          return result && result.content ? filename : null;
        } catch {
          return null;
        }
      })
    );

    // Add discovered files sequentially so each executeContextItem sees a
    // stable thread state (avoids racing duplicate inserts of the same
    // file-content item; the dedup is checked at insert time).
    let addedCount = 0;
    for (const filename of candidates) {
      if (!filename) continue;
      try {
        await mt.executeContextItem('file-content', { path: filename });
        addedCount++;
      } catch {
        // Skip on failure — best-effort optional operation.
      }
    }

    return addedCount;
  }

  /**
   * Seed every registered context-item type whose manifest declares
   * `autoInstantiate` onto a thread, so it is "always present" without the user
   * adding it (e.g. project memory). Idempotent: each type's `mergeOrReplace`
   * dedups, so re-running reuses the existing instance. A class may gate seeding
   * with a static `shouldAutoInstantiate()` (default: seed unconditionally) —
   * memory uses this to seed only when its file already exists.
   *
   * This is the generic counterpart to {@link addAIAssistantFiles}'s
   * file-existence-gated CLAUDE.md path (which could later migrate onto this
   * capability). Best-effort: a failed seed never blocks conversation creation.
   * @param {import('./conversation.js').default} conversation - Conversation to seed
   * @param {import('./message-thread.js').default|null} [messageThread] - Target thread; null = root
   * @returns {Promise<number>} Number of auto-instantiate types seeded
   * @async
   */
  async seedAutoContextItems(conversation, messageThread = null) {
    if (!conversation) return 0;
    const mt = messageThread || conversation.rootMessageThread;
    let count = 0;
    for (const { id, class: ItemClass } of contextItemRegistry.getAll()) {
      const manifest = /** @type {any} */ (ItemClass).MANIFEST;
      if (!manifest?.autoInstantiate) continue;
      try {
        const gate = /** @type {any} */ (ItemClass).shouldAutoInstantiate;
        if (typeof gate === 'function' && !(await gate.call(ItemClass))) {
          continue;
        }
        await mt.executeContextItem(id, {});
        count++;
      } catch {
        // Best-effort: a failed seed must never block conversation creation.
      }
    }
    return count;
  }

  /**
   * Seed a thread's always-present auto items: the AI assistant files
   * (CLAUDE.md etc.) and every `autoInstantiate` context-item type (e.g.
   * project memory). This is the single source of truth for the seeding that
   * both conversation creation and `/clear` perform — they call this same
   * method so the freshly-created and the just-cleared state never drift.
   * Both halves are idempotent (`mergeOrReplace` dedup), so re-seeding a thread
   * that still holds some of the items reuses them.
   * @param {import('./conversation.js').default} conversation - Conversation to seed
   * @param {import('./message-thread.js').default|null} [messageThread] - Target thread; null = root
   * @returns {Promise<void>}
   * @async
   */
  async seedConversationAutoItems(conversation, messageThread = null) {
    await this.addAIAssistantFiles(conversation, messageThread);
    await this.seedAutoContextItems(conversation, messageThread);
  }

  /**
   * Get session state as plain object
   * @returns {{projectPath: string, conversations: object[], activeConversationId: string | null, messageHistory: string[]}} Session state
   */
  toJSON() {
    return {
      projectPath: this.projectPath,
      conversations: Array.from(this.conversations.values()).map(conv => conv.toJSON()),
      activeConversationId: this.visibleConversationId,
      messageHistory: this.messageHistory
    };
  }

  /**
   * Clean up resources when session is destroyed
   */
  destroy() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }

    // Remove WebSocket listeners registered in _doLoad (all three, not just
    // file-change — project-changed and providers-update would otherwise leak
    // and fire against a destroyed session).
    if (this._services?.wsService) {
      const ws = this._services.wsService;
      if (this._fileChangeHandler) {
        ws.off('file-change', /** @type {import('../services/websocket.js').WSEventCallback} */ (this._fileChangeHandler));
        this._fileChangeHandler = undefined;
      }
      if (this._projectChangedHandler) {
        ws.off('project-changed', /** @type {import('../services/websocket.js').WSEventCallback} */ (this._projectChangedHandler));
        this._projectChangedHandler = undefined;
      }
      if (this._providersUpdateHandler) {
        ws.off('providers-update', this._providersUpdateHandler);
        this._providersUpdateHandler = undefined;
      }
    }

    // Terminate all workers
    workerManager.terminateAll();

    this.conversations.forEach(conv => {
      if (conv.destroy) {
        conv.destroy();
      }
    });
    this.conversations.clear();

    this._listeners.clear();

    // @ts-ignore - Intentional cleanup in destroy method
    this._apiService = null;
    this._services = null;
  }
}

// Export class
export default Session;
