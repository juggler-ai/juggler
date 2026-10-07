//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Conversation loader: makes the Conversation objects a WorkerManager's workers
 * serve, and tears them down again.
 *
 * The WorkerManager is the transport. It spawns workers, waits for them to
 * report ready and carries their messages. The loader sits one level above it
 * and uses only its public surface (`spawnWorker`, `waitForWorkerReady`,
 * `reattach`, `terminate`, `session`). It builds the Conversation, puts it in
 * the session before its worker can speak, and finishes the creation or load
 * contract once the worker is up. There are four ways in:
 *
 * - {@link ConversationLoader#createNew}: a conversation the server has just
 *   allocated, with no state on disk.
 * - {@link ConversationLoader#loadExisting}: one the server holds on disk.
 * - {@link ConversationLoader#autoLoad}: the engine loading a conversation it
 *   heard about from a yjs-sync or resync-offer, backing off on failure.
 * - {@link ConversationLoader#destroy}: the reverse. The conversation is torn
 *   down, then its worker entry dropped.
 *
 * `createNew` and `loadExisting` share one in-flight map keyed by id, so a
 * create that lands on a load already running for the same id joins it
 * instead of racing it. In the engine that is the ordinary case; see
 * `createNew`.
 *
 * Each WorkerManager owns one loader (`workerManager.loader`), because the
 * manager's inbound router starts auto-loads and must start them on its own
 * loader.
 * @module services/conversation-loader
 */

import { base64ToBytes } from '../utils/base64.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { fetchJson } from './http.js';
import { apiUrl } from '../utils/api-url.js';

/**
 * How long to wait after a failed auto-load before trying that conversation
 * again, and the ceiling that wait grows to.
 *
 * An auto-load is triggered by a yjs-sync for a conversation this realm does
 * not know, and the worker pushes state ahead of every tool dispatch and every
 * redrive — so while anything is happening the trigger arrives continuously. A
 * conversation that keeps failing to load therefore retries at round-trip
 * cadence indefinitely, working hardest exactly when whatever is stopping it
 * loading is at its worst.
 *
 * Backing off rather than capping is deliberate: a conversation that never
 * loads is one whose tools can never run, so there is no attempt count at which
 * giving up is the right answer. The delay doubles to the ceiling and stays
 * there, which costs two attempts a minute for a conversation that is never
 * coming back and nothing at all for the common case, where the first retry
 * succeeds.
 */
const AUTO_LOAD_RETRY_BASE_MS = 500;
const AUTO_LOAD_RETRY_MAX_MS = 30000;

/**
 * Builds, loads and destroys conversations on behalf of one WorkerManager.
 */
export class ConversationLoader {
  /**
   * @param {import('./worker-manager.js').WorkerManager} workerManager - The
   *   transport this loader spawns workers through.
   */
  constructor(workerManager) {
    /**
     * @type {import('./worker-manager.js').WorkerManager}
     * @private
     */
    this._wm = workerManager;

    /**
     * In-flight creates and loads, by conversation id. One map for both, so a
     * create and a load of the same id resolve to the same conversation.
     * @type {Map<string, Promise<import('../model/conversation.js').default>>}
     * @private
     */
    this._inFlight = new Map();

    /**
     * In-flight auto-loads, by conversation id, with the yjs-sync bytes that
     * arrived while each was running. Applied once the load completes.
     * @type {Map<string, {promise: Promise<void>, queuedBytes: string[]}>}
     * @private
     */
    this._pendingAutoLoads = new Map();

    /**
     * Auto-load failures per conversation, so a repeated one backs off instead
     * of retrying on every sync. Cleared for a conversation the moment one of
     * its loads succeeds.
     * @type {Map<string, {failures: number, lastAttemptAt: number}>}
     * @private
     */
    this._autoLoadFailures = new Map();
  }

  /**
   * Forget every in-flight create, load and auto-load, and every recorded
   * failure. Called by `WorkerManager#terminateAll` in test teardown: a promise
   * left in the in-flight map would make the next test's create of a reused id
   * join a conversation that no longer exists.
   * @returns {void}
   */
  reset() {
    this._inFlight.clear();
    this._pendingAutoLoads.clear();
    this._autoLoadFailures.clear();
  }

  /**
   * The auto-load running for a conversation, if any.
   * @param {string} conversationId - Conversation ID
   * @returns {Promise<void>|null} Settles when that load has finished, whichever
   *   way it went; null when none is running.
   */
  pendingAutoLoad(conversationId) {
    return this._pendingAutoLoads.get(conversationId)?.promise ?? null;
  }

  // ==========================================================================
  // Create
  // ==========================================================================

  /**
   * Create a brand new conversation with no prior state on disk.
   * Caller must already have allocated the id and final name via
   * `POST /api/conversations` (the server creates the on-disk folder
   * with the canonical name before this is called). Returns a fully
   * initialized conversation with worker ready.
   * @param {string} id - Server-allocated conversation id
   * @param {string} name - Server-canonical conversation name (folder name on disk)
   * @param {import('../model/session.js').default} session - Parent session
   * @param {{workspaceId?: string}} [options] - The tree it will work in, which
   *   is where in the tab bar it belongs — see `Session#_placeNewConversation`
   * @returns {Promise<import('../model/conversation.js').default>} Fully initialized conversation
   */
  async createNew(id, name, session, { workspaceId = '' } = {}) {
    const Conversation = (await import('../model/conversation.js')).default;

    // Check if already creating (lock via in-flight promise). In the ENGINE this
    // is the normal path, not a rarity: the worker the server spawns for the new
    // conversation flushes its first yjs-sync before the create's HTTP response
    // gets back here, and a sync for an unknown conversation makes the engine
    // auto-load it (autoLoad → loadExisting, which registers here). So the
    // create joins a LOAD, which — reading a conversation that already exists —
    // seeds no built-in items. Finish the creation contract explicitly, or the
    // conversation is born without its system prompt: no editable prompt in the
    // panel, and every sub-thread clones a starting context that has none.
    const existingPromise = this._inFlight.get(id);
    if (existingPromise) {
      const conversation = await existingPromise;
      await this._ensureNewConversationSystemPrompt(conversation);
      return conversation;
    }

    // Start creation (atomic)
    const promise = this._doCreateNew(name, session, id, Conversation, workspaceId);
    this._inFlight.set(id, promise);

    try {
      const conversation = await promise;
      return conversation;
    } finally {
      this._inFlight.delete(id);
    }
  }

  /**
   * Give a brand-new conversation the root system-prompt placeholder, once its
   * worker's items array is in the browser doc. Seeding before the array lands
   * builds a rival root["items"] that Yjs conflict resolution then discards,
   * taking SYSTEM_1 with it — see {@link _waitForItemsArray}. Idempotent, so it
   * is safe on a conversation that already has one.
   * @param {import('../model/conversation.js').default} conversation - The new conversation
   * @returns {Promise<void>}
   * @private
   */
  async _ensureNewConversationSystemPrompt(conversation) {
    await this._waitForItemsArray(conversation);
    conversation.rootMessageThread.ensureSystemPromptPlaceholder();
  }

  /**
   * Internal implementation of new conversation creation
   * @param {string} name - Conversation name
   * @param {import('../model/session.js').default} session - Parent session
   * @param {string} id - Generated conversation ID
   * @param {typeof import('../model/conversation.js').default} Conversation - Conversation class
   * @param {string} [workspaceId] - The tree it will work in, if it is one
   * @returns {Promise<import('../model/conversation.js').default>} Fully initialized conversation
   * @private
   */
  async _doCreateNew(name, session, id, Conversation, workspaceId = '') {
    try {
      // 1. Create conversation instance
      const services = session.getServices();
      if (!services) {
        throw new Error('Cannot create conversation: services not set');
      }

      // The browser DOES NOT initialize the system-prompt placeholder yet —
      // doing it here would create root["items"] in the browser doc, racing
      // the worker's own ensureItems() and dropping SYSTEM_1 ~half the time.
      // The worker creates the items Y.Array in handleInit and ships it via
      // yjs-sync; the browser's ensureSystemPromptPlaceholder() below adds
      // SYSTEM_1 to that *existing* array.
      // Built carrying the workspace it is for, so it reports that binding from
      // the moment it exists. The durable write happens in initialiseConversation
      // once the worker is up, which is several renders of the tab bar away —
      // and the bar groups the strip by this answer.
      const conversation = new Conversation(id, name, session, /** @type {import('../model/session.js').ConversationServices} */ (services), { skipBuiltInContextItems: true, workspaceId });

      // CRITICAL: Add to session BEFORE spawning worker. Worker sends yjs-sync
      // messages immediately and the message handler needs to find the
      // conversation. It goes in at the TOP — of the bar, or of its workspace's
      // box — so any render that fires while the worker is still spawning
      // (broadcast echo, etc.) sees the new tab in its final position rather
      // than briefly painting it at the end of the bar, or briefly dragging a
      // workspace's whole box up there with it.
      session.adoptConversation(id, conversation, { atHead: true, workspaceId, from: 'loader.createNew' });

      // 2. Spawn worker with full metadata (LoadFromDisk: false)
      const workerInit = conversation.getWorkerInitData();
      const initData = {
        id: conversation.id,
        name: conversation.name,
        created: conversation.created,
        modelConfig: workerInit.modelConfig,
        loadFromDisk: false  // New conversation - don't load from disk
      };
      await this._wm.spawnWorker(conversation.id, initData);

      // 3. Wait for ready (no metadata expected). The worker has now flushed
      // its initial yjs-sync (with the items Y.Array creation), so the
      // browser doc's items reference is the worker's array.
      await this._wm.waitForWorkerReady(conversation.id);

      // Browser-side sync application is batched on a timer, and under load
      // the worker's initial yjs-sync (which CREATES root["items"]) can still
      // be in flight when waitForWorkerReady resolves — 'ready' is sent after
      // that sync, but the two are applied through independent batched paths.
      // A one-shot flush only applies syncs that have already arrived; if the
      // array-bearing sync hasn't, doc.root["items"] is still absent and
      // ensureSystemPromptPlaceholder() below creates a SECOND, competing
      // root["items"] in the browser doc. Yjs Map-conflict resolution then
      // keeps the worker's array and discards the browser's, dropping SYSTEM_1
      // with it — the "system-prompt missing at [0]" flake seen under multi-
      // conversation load. Positively WAIT for the worker's array so SYSTEM_1
      // is always inserted into THAT array, never a rival one.
      await this._waitForItemsArray(conversation);

      // 4. Activate Yjs sync (registers update handler, sends current state).
      conversation.activateYjsSync();

      // 5. Insert the system-prompt placeholder into the (now-present) items
      // array. ensureSystemPromptPlaceholder() is a no-op if SYSTEM_1 already
      // exists — safe to call regardless of whether worker pre-loaded items.
      await this._ensureNewConversationSystemPrompt(conversation);

      return conversation;
    } catch (error) {
      console.error(`[ConversationLoader] Failed to create conversation ${id}:`, error);
      this._wm.terminate(id);
      throw error;
    }
  }

  /**
   * Wait until the worker's root["items"] Y.Array has arrived and been applied
   * to the browser doc. This is the precondition for seeding SYSTEM_1: inserting
   * the system-prompt placeholder while the array is still absent creates a
   * competing browser-side root["items"], which Yjs Map-conflict resolution
   * later discards in favour of the worker's — dropping SYSTEM_1. Flushes the
   * batched sync buffer on each check so a just-arrived sync is applied
   * promptly. Bounded so a pathological worker that never ships an array can't
   * hang conversation creation; on timeout the caller proceeds anyway and
   * ensureSystemPromptPlaceholder creates the array locally, accepting the
   * risk above.
   * @param {import('../model/conversation.js').default} conversation
   * @param {number} [timeoutMs=2000] - Max time to wait for the array to sync.
   * @returns {Promise<boolean>} True once the items array is present, false on timeout.
   * @private
   */
  async _waitForItemsArray(conversation, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    conversation.flushPendingSyncs();
    while (!conversation.hasRootItemsArray) {
      if (Date.now() >= deadline) {
        console.warn(`[ConversationLoader] items array not synced within ${timeoutMs}ms for ${conversation.id}; SYSTEM_1 may create a local array`);
        return false;
      }
      await new Promise(r => setTimeout(r, 10));
      conversation.flushPendingSyncs();
    }
    return true;
  }

  // ==========================================================================
  // Load
  // ==========================================================================

  /**
   * Load an existing conversation from disk using its ID.
   * Backend extracts metadata from the .yjs file and sends it in the ready message.
   * @param {string} conversationId - Conversation ID
   * @param {import('../model/session.js').default} session - Parent session
   * @returns {Promise<import('../model/conversation.js').default>} Fully initialized conversation
   */
  async loadExisting(conversationId, session) {
    const Conversation = (await import('../model/conversation.js')).default;

    // Check if already loading (lock via in-flight promise)
    const existingPromise = this._inFlight.get(conversationId);
    if (existingPromise) {
      console.warn(`[ConversationLoader] Duplicate load for ${conversationId} - waiting for in-flight`);
      return await existingPromise;
    }

    const promise = this._doLoadExisting(conversationId, session, Conversation);
    this._inFlight.set(conversationId, promise);

    try {
      const conversation = await promise;
      return conversation;
    } finally {
      this._inFlight.delete(conversationId);
    }
  }

  /**
   * Internal implementation of existing conversation loading
   * @param {string} conversationId - Conversation ID
   * @param {import('../model/session.js').default} session - Parent session
   * @param {typeof import('../model/conversation.js').default} Conversation - Conversation class
   * @returns {Promise<import('../model/conversation.js').default>} Fully initialized conversation
   * @private
   */
  async _doLoadExisting(conversationId, session, Conversation) {
    try {
      // 1. Get services first
      const services = session.getServices();
      if (!services) {
        throw new Error('Cannot load conversation: services not set');
      }

      // 2. Reuse the stub created by Session._doLoad if present — replacing it
      // would break tab-element bindings and tab-bar references. Auto-load
      // and other direct callers fall through to create a fresh one.
      let conversation = session.conversations.get(conversationId);
      if (!conversation) {
        conversation = new Conversation(
          conversationId,
          '',  // populated from metadata after worker ready
          session,
          services,
          { skipBuiltInContextItems: true }
        );
        // Must be in the session before spawnWorker — yjs-sync messages from
        // the worker arrive immediately and need to find it.
        session.adoptConversation(conversationId, conversation, { from: 'loader.loadExisting' });
      }

      // 3. Spawn worker with LoadFromDisk flag
      const initData = {
        id: conversationId,
        loadFromDisk: true  // Backend will load from disk and send metadata
      };
      // A worker entry outlives the Conversation object that owns the
      // document. Session._doLoad replaces every conversation with a fresh,
      // EMPTY one but leaves the manager's entries alone, so spawnWorker's
      // "already exists" short-circuit would skip the init — and an init is
      // the only thing that asks the worker for state. Re-attach explicitly:
      // the worker answers this document's state vector with the ops it lacks.
      if (!conversation.hasRootItemsArray) {
        this._wm.reattach(conversationId, initData);
      }
      await this._wm.spawnWorker(conversationId, initData);

      // 4. Wait for ready and get metadata from backend
      const metadata = await this._wm.waitForWorkerReady(conversationId);
      if (!metadata) {
        throw new Error(`Worker did not provide metadata for existing conversation ${conversationId}`);
      }

      // 5. Populate stub with metadata (properties are mutable). The name
      // comes from the on-disk folder name, populated when the manifest
      // was loaded — don't overwrite it from worker metadata.
      const metadataObj = /** @type {{ created?: string; defaultModelConfig?: any; currentStrategyId?: string }} */ (metadata);
      const defaultModelConfig = metadataObj.defaultModelConfig ?? null;
      conversation.created = metadataObj.created || new Date().toISOString();
      conversation.restoreWorkerMetadata({
        modelConfig: defaultModelConfig,
        currentStrategyId: metadataObj.currentStrategyId || 'default'
      });

      // Fetch context window if model is set (fire-and-forget)
      if (defaultModelConfig) {
        // Use ensureContextWindow which internally calls _fetchContextWindow
        conversation.ensureContextWindow();
      }

      // Note: Permissions come from worker Yjs sync, no need to set here

      // Browser-side sync application is batched on a 50ms timer; the worker's
      // initial yjs-sync (with the loaded items array and all messages) may
      // have arrived but not yet been applied. Flush so callers that read
      // conv.rootItems immediately after this call see the synced state.
      conversation.flushPendingSyncs();

      // 6. Activate Yjs sync. All yjs-sync was captured from the start, so the
      // doc is already complete here.
      conversation.activateYjsSync();

      // Cover callers that bypass the load queue (clone, refreshFromServer).
      if (conversation.loadState !== 'loaded') {
        conversation.setLoadState('loaded');
      }

      return conversation;
    } catch (error) {
      console.error(`[ConversationLoader] Failed to load conversation ${conversationId}:`, error);
      // Keep the stub in session.conversations with loadState=error so the
      // panel can render a retry affordance and the next reload retries.
      // Dropping it instead would lose the conversation permanently.
      const stub = session.conversations.get(conversationId);
      if (stub && stub.loadState !== 'error') stub.setLoadState('error');
      this._wm.terminate(conversationId);
      throw error;
    }
  }

  // ==========================================================================
  // Destroy
  // ==========================================================================

  /**
   * Destroy conversation and terminate worker (atomic operation)
   * Enforces proper cleanup order: stop operations → destroy resources → terminate worker
   * @param {import('../model/conversation.js').default} conversation - Conversation to destroy
   * @returns {Promise<void>}
   */
  async destroy(conversation) {
    const conversationId = conversation.id;

    try {
      // 1. Destroy conversation resources (this also stops active operations)
      //    Conversation.destroy() calls llmState.stop() and cancelPendingApprovals()
      conversation.destroy();

      // 2. Terminate worker
      this._wm.terminate(conversationId);
    } catch (error) {
      console.error(`[ConversationLoader] Error destroying ${conversationId}:`, error);
      // Still terminate worker even if conversation cleanup failed
      this._wm.terminate(conversationId);
      throw error;
    }
  }

  // ==========================================================================
  // Engine auto-load
  // ==========================================================================

  /**
   * How long a conversation must be left alone after `failures` consecutive
   * failed auto-loads: doubling from the base, up to the ceiling.
   * @param {number} failures - Consecutive failed loads for this conversation.
   * @returns {number} Milliseconds to wait before the next attempt.
   */
  autoLoadRetryDelayMs(failures) {
    // The first failure is the documented race — the worker's first-init
    // 'ready' arriving before it has processed our init — and the next sync is
    // exactly when it will have. Retry that one immediately; only a SECOND
    // failure says something is actually wrong.
    if (failures <= 1) return 0;
    return Math.min(AUTO_LOAD_RETRY_MAX_MS, AUTO_LOAD_RETRY_BASE_MS * 2 ** (failures - 2));
  }

  /**
   * Auto-load a conversation that the engine doesn't know about yet.
   * Queues yjs-sync bytes and applies them after load completes.
   * Deduplicates concurrent loads for the same conversation.
   *
   * The bytes are optional: an incidental yjs-sync arrives with the ops that
   * prompted the load and must not lose them, but a resync-offer is only a
   * pointer to a conversation, and the load itself brings the state.
   * @param {string} conversationId - Conversation to load
   * @param {string} [base64Bytes] - Base64-encoded yjs-sync bytes to apply once loaded
   * @returns {void}
   */
  autoLoad(conversationId, base64Bytes) {
    // Skip internal conversations
    if (conversationId.startsWith('_internal:')) return;

    const existing = this._pendingAutoLoads.get(conversationId);
    if (existing) {
      // Load already in flight — just queue the bytes
      if (base64Bytes !== undefined) existing.queuedBytes.push(base64Bytes);
      return;
    }

    // A conversation that has just failed to load is left alone until its
    // backoff elapses. The bytes go with it: they are an update to a document
    // this realm does not have, and the load itself is what brings the state.
    const failure = this._autoLoadFailures.get(conversationId);
    if (failure && Date.now() - failure.lastAttemptAt < this.autoLoadRetryDelayMs(failure.failures)) {
      return;
    }

    /** @type {string[]} */
    const queuedBytes = base64Bytes === undefined ? [] : [base64Bytes];

    const promise = (async () => {
      try {
        const session = this._wm.session;
        if (!session) return;
        console.log(`[ConversationLoader] Auto-loading unknown conversation ${conversationId}`);
        const conversation = await this.loadExisting(conversationId, session);
        // It loaded: whatever was wrong has passed, so the next unrelated blip
        // gets the fast first retry rather than an inherited backoff.
        this._autoLoadFailures.delete(conversationId);

        // Apply all queued yjs-sync updates
        for (const b64 of queuedBytes) {
          conversation.handleYjsSyncMessage(base64ToBytes(b64));
        }
      } catch (err) {
        const failures = (this._autoLoadFailures.get(conversationId)?.failures ?? 0) + 1;
        this._autoLoadFailures.set(conversationId, { failures, lastAttemptAt: Date.now() });
        console.error(
          `[ConversationLoader] Failed to auto-load conversation ${conversationId} (attempt ${failures}, next no sooner than ${this.autoLoadRetryDelayMs(failures)}ms):`,
          err
        );
        // The engine's console is invisible in headless runs, and a repeated
        // auto-load failure means no tool execution for the conversation —
        // worth a server-side trace. The endpoint only exists in test mode, so
        // gate the call behind the test flag rather than firing a request that
        // 404s in production (over the studio tunnel that 404 is a visible
        // console line). Fire-and-forget.
        if (/** @type {any} */ (globalThis).JUGGLER_TEST_MODE) {
          void fetchJson(apiUrl('/test/debug-log'), {
            method: 'POST',
            body: {
              where: 'engine-auto-load-failed',
              conversationId,
              error: extractErrorMessage(err)
            },
            fallback: null,
          });
        }
        // The first failure is usually a race: the worker's first-init
        // 'ready' (triggered by whichever client booted the worker) lands in
        // our entry before the worker has processed *our* init, so we get a
        // ready without metadata. Drop the stub so the next yjs-sync
        // re-triggers autoload — by then the worker is initialized and our
        // init takes the "Client attached" path with metadata.
        this._wm.session?.forgetConversation(conversationId, 'engine-auto-load-failed');
      } finally {
        this._pendingAutoLoads.delete(conversationId);
      }
    })();

    this._pendingAutoLoads.set(conversationId, { promise, queuedBytes });
  }
}
