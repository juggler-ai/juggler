//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Worker Manager: the client's transport to the conversation workers running
 * on the backend server, one worker per conversation.
 *
 * It owns the worker entries (spawn, init, ready, terminate), the outbound
 * commands, and the ack and thread-request bookkeeping their replies settle.
 * Two jobs sit beside it in their own modules:
 *
 * - What each inbound message means is `worker-manager-inbound.js`, one
 *   handler per wire type. {@link WorkerManager#handleWorkerMessageFromWS}
 *   unwraps the envelope and hands it there.
 * - Building, loading and destroying Conversation objects is
 *   `conversation-loader.js`, reached as {@link WorkerManager#loader}.
 *
 * The engine-side request/response protocols are `worker-manager-protocols.js`.
 * @module services/worker-manager
 */

import wsService from './websocket.js';
import * as protocols from './worker-manager-protocols.js';
import { routeWorkerMessage } from './worker-manager-inbound.js';
import { ConversationLoader } from './conversation-loader.js';
import { bytesToBase64 } from '../utils/base64.js';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * @typedef {object} WorkerEntry
 * @property {string} conversationId - Associated conversation ID
 * @property {boolean} ready - Whether worker has initialized
 * @property {Array<Function>} readyCallbacks - Callbacks waiting for ready state
 * @property {Array<(err: Error) => void>} [readyRejectors] - Waiters to fail if the worker reports an error instead of becoming ready
 * @property {object|null} [metadata] - Metadata extracted from ready message (for existing conversations)
 * @property {boolean} [loadFromDisk] - Whether this entry was spawned with loadFromDisk:true
 * @property {{loadFromDisk?: boolean, [key: string]: unknown}} serialized - The conversation data this entry was spawned with, kept so its init can be re-sent (see reinitPendingConversations)
 */

/**
 * @typedef {object} WorkerMessage
 * @property {string} type - Message type
 * @property {object} [patch] - State patch data
 * @property {number[]} [update] - Yjs update
 * @property {number[]} [bytes] - Yjs sync message bytes (from y-generic-sync)
 * @property {number[]} [stateVector] - Worker's Yjs state vector (for resync-response)
 * @property {string} [itemId] - Message ID
 * @property {string} [content] - Content
 * @property {string} [chunkType] - Chunk type
 * @property {string} [requestId] - Request ID
 * @property {string} [ackId] - Acknowledgment ID
 * @property {*} [result] - Result data (for ack messages)
 * @property {string[]} [itemIds] - Context item IDs
 * @property {object} [contextParams] - Context params
 * @property {string} [toolName] - Tool name
 * @property {object} [params] - Params
 * @property {string} [toolUseId] - Tool use ID
 * @property {number} [runningEpoch] - Execution generation for a cancel-tool command (scopes the abort to one incarnation)
 * @property {boolean} [commandDriven] - Tool command: conversation's reactive reducer is disabled
 * @property {object} [toolInput] - Tool input
 * @property {object} [config] - Config
 * @property {object} [payload] - Payload
 * @property {string} [status] - Status
 * @property {string} [message] - Message
 * @property {string} [stack] - Stack trace
 * @property {boolean} [success] - Success flag (for ack messages)
 * @property {string} [error] - Error message (for error/save-error messages)
 * @property {boolean} [cancelled] - Whether the error was due to cancellation
 * @property {object[]} [items] - Items array (for state-reset)
 * @property {object[]} [contextItems] - Context items array (for state-reset)
 * @property {object} [metadata] - Metadata extracted from Yjs (for ready messages when loading existing conversations)
 * @property {string} [summarizationPrompt] - Worker-owned canonical summarization prompt (for ready messages)
 */

/**
 * @typedef {object} WorkerConfig
 * @property {string} projectPath - Project path
 * @property {string} [apiBaseUrl] - API base URL for backend calls
 */

/**
 * @typedef {object} ToolExecutionResult
 * @property {boolean} success - Whether tool execution succeeded
 * @property {*} [content] - Tool result content
 * @property {boolean} [isError] - Whether result is an error
 * @property {string} [error] - Error message if failed
 */

// ============================================================================
// Worker Manager
// ============================================================================

/**
 * Default timeout for a conversation worker to reach the ready state.
 */
const WORKER_READY_TIMEOUT_MS = 60000;

/**
 * Manages conversation workers
 */
export class WorkerManager {
  constructor() {
    /**
     * Map of conversation ID to worker entry
     * @type {Map<string, WorkerEntry>}
     * @private
     */
    this._workers = new Map();

    /**
     * Global config for new workers
     * @type {WorkerConfig|null}
     * @private
     */
    this._config = null;

    /**
     * Reference to session for getting conversation instances
     * @type {import('../model/session.js').default|null}
     * @private
     */
    this._session = null;

    /**
     * Builds, loads and destroys the conversations this manager's workers
     * serve, including the engine's auto-load of conversations it hears about
     * from a sync.
     * @type {ConversationLoader}
     */
    this.loader = new ConversationLoader(this);

    /**
     * Map of conversation ID to in-flight spawn promises
     * Used to prevent duplicate worker spawns during async spawn operations
     * @type {Map<string, Promise<void>>}
     * @private
     */
    this._spawning = new Map();

    /**
     * Callback for approval requests
     * @type {((request: object, conversationId: string) => void)|null}
     * @private
     */
    this._onApprovalRequest = null;

    /**
     * Callback for context requests (to call plugins on main thread)
     * @type {((request: object, conversationId: string) => void)|null}
     * @private
     */
    this._onContextRequest = null;


    /**
     * Callback for tool definitions requests
     * @type {((request: object, conversationId: string) => void)|null}
     * @private
     */
    this._onToolsRequest = null;

    /**
     * Arrival stamps for in-flight context/tools round-trips, keyed by request
     * id, so each reply can tell the worker how long it waited to be picked up
     * and how long the engine then took. Written and released in
     * worker-manager-protocols.js.
     * @type {Map<string, {sentAt: number, receivedAt: number}>}
     * @private
     */
    this._roundTripStamps = new Map();

    /**
     * Callback for subthread-spec build requests (delegatesToSubthread tools)
     * @type {((request: object, conversationId: string) => void)|null}
     * @private
     */
    this._onSubthreadSpecRequest = null;

    /**
     * Pending thread creation requests
     * (requestId -> {conversationId, resolve, reject}). The conversationId is
     * what lets {@link WorkerManager#terminate} unwind the requests belonging to
     * a conversation that is going away; see createThread for why there is no
     * timer.
     * @type {Map<string, {conversationId: string, resolve: Function, reject: Function}>}
     * @private
     */
    this._pendingThreadRequests = new Map();

    /**
     * Pending command acknowledgments (ackId -> {resolve, reject})
     * @type {Map<string, {resolve: Function, reject: Function}>}
     * @private
     */
    this._pendingAcks = new Map();

    /**
     * Counter for generating unique ack IDs
     * @type {number}
     * @private
     */
    this._ackCounter = 0;

    /**
     * Per-instance salt for request/ack ids. The worker broadcasts an ack to
     * every client on a conversation and matches purely by id, while
     * _ackCounter resets to 0 in each client — so a bare counter ("ack_3")
     * collides across clients and a sibling's broadcast ack could resolve the
     * wrong request. Salting with this instance id makes every id globally
     * unique.
     * @type {string}
     * @private
     */
    this._instanceId = 'wm_' + Math.random().toString(36).slice(2, 10);
  }

  /**
   * Initialize the worker manager (Store session reference)
   * @param {WorkerConfig} config - Configuration for workers
   * @param {import('../model/session.js').default} session - Session instance for accessing conversations
   */
  init(config, session) {
    this._config = config;
    this._session = session;
  }

  /**
   * The session whose conversations this manager's workers serve, or null
   * before {@link WorkerManager#init}.
   * @returns {import('../model/session.js').default|null} The session
   */
  get session() {
    return this._session;
  }

  /**
   * Repoint the project root every subsequently-spawned worker is initialised
   * with, after a runtime project switch.
   *
   * `init` runs once per client, but the engine is persistent across
   * SwitchProject and keeps spawning workers afterwards (a yjs-sync for an
   * unknown conversation triggers `loader.autoLoad` → `spawnWorker`).
   * The config is sent verbatim in each worker's `init` message and becomes the
   * worker's `projectPath` server-side, which is what its transcript logs,
   * persistence and transaction store are keyed on — so a stale value writes
   * the new project's conversation into the previous project's directory.
   * No-op before `init` (nothing to repoint yet).
   * @param {string} projectPath - The switched-to project root ("" = no project)
   */
  setProjectPath(projectPath) {
    if (!this._config) return;
    this._config = { ...this._config, projectPath: projectPath || '' };
  }

  /**
   * Handle incoming worker message from WebSocket
   * Unwraps the envelope and routes to internal message handler
   * @param {{type: string, conversationId: string, workerMsgType: string, payload: object}} envelope - Worker message envelope
   */
  handleWorkerMessageFromWS(envelope) {
    const { conversationId, payload } = envelope;
    if (!conversationId || !payload) {
      console.warn('[WorkerManager] Invalid worker message envelope:', envelope);
      return;
    }
    // Parse payload if it's a string (shouldn't happen with json.RawMessage, but check)
    let parsedPayload = payload;
    if (typeof payload === 'string') {
      const payloadStr = /** @type {string} */ (payload);
      try {
        parsedPayload = JSON.parse(payloadStr);
      } catch (err) {
        console.error('[WorkerManager] Failed to parse payload string:', err);
        return;
      }
    }
    this._handleWorkerMessage(conversationId, /** @type {WorkerMessage} */ (parsedPayload));
  }

  /**
   * Set callback for approval requests from workers
   * @param {(request: object, conversationId: string) => void} callback
   */
  setOnApprovalRequest(callback) {
    this._onApprovalRequest = callback;
  }

  /**
   * Set callback for context requests from workers
   * @param {(request: object, conversationId: string) => void} callback
   */
  setOnContextRequest(callback) {
    this._onContextRequest = callback;
  }


  /**
   * Set callback for tool definitions requests from workers
   * @param {(request: object, conversationId: string) => void} callback
   */
  setOnToolsRequest(callback) {
    this._onToolsRequest = callback;
  }


  /**
   * Set callback for subthread-spec build requests from workers (engine-only).
   * @param {(request: object, conversationId: string) => void} callback
   */
  setOnSubthreadSpecRequest(callback) {
    this._onSubthreadSpecRequest = callback;
  }


  /**
   * Internal implementation of worker spawn
   * Sends init message to worker via WebSocket
   * @param {string} conversationId - Conversation ID
   * @param {{loadFromDisk?: boolean, [key: string]: unknown}} serializedConversation - Serialized conversation data
   * @returns {Promise<void>} Resolves when worker is ready
   * @private
   */
  async _doSpawn(conversationId, serializedConversation) {
    if (!this._config) {
      throw new Error('[WorkerManager] Not initialized - call init() first');
    }

    // Create entry to track worker state
    /** @type {WorkerEntry} */
    const entry = {
      conversationId,
      ready: false,
      readyCallbacks: [],
      readyRejectors: [],
      loadFromDisk: !!serializedConversation.loadFromDisk,
      serialized: serializedConversation
    };
    this._workers.set(conversationId, entry);

    // Wait for ready with timeout. 60s — large CRDT loads, WS write congestion
    // during initial cold start, or a backgrounded tab can blow past anything
    // tighter. A timeout here drops the conversation from session, so be
    // generous: a longer wait is strictly better than losing user data.
    /** @type {Promise<void>} */
    const readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Worker initialization timeout'));
      }, WORKER_READY_TIMEOUT_MS);
      entry.readyCallbacks.push((/** @type {object|null} */ _metadata) => {
        clearTimeout(timer);
        resolve();  // Ignore metadata here - caller uses waitForWorkerReady to get it
      });
      // A worker that fails its init reports an error and then says nothing —
      // and the error path unwinds REJECTORS, so a wait registered without one
      // is a wait that answer cannot reach. This is the first wait of a load, so
      // without it the whole timeout above is spent on a conversation the server
      // has already said it cannot open.
      (entry.readyRejectors ??= []).push((/** @type {Error} */ err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // Send init message via WebSocket (or alternate transport)
    this._sendInit(conversationId, serializedConversation);

    try {
      await readyPromise;
    } catch (error) {
      // Clean up on failure
      console.error(`[WorkerManager] Worker failed for ${conversationId}, cleaning up:`, error);
      this._workers.delete(conversationId);
      throw error;
    }
  }

  /**
   * Send a worker its init message, carrying this client's Yjs state vector for
   * the conversation whenever it already holds a document to diff against.
   *
   * The vector is what makes attaching cheap. A worker that is already running
   * answers it with just the ops that vector does not cover, addressed to this
   * client alone — where a vector-less init makes it broadcast its whole
   * document, which for a long conversation is megabytes charged to every other
   * viewer and the engine as well. A client with nothing yet is not a special
   * case to detect: the delta since an empty document is the whole document.
   * @param {string} conversationId - Conversation ID
   * @param {{loadFromDisk?: boolean, [key: string]: unknown}} serializedConversation - Serialized conversation data
   * @returns {boolean} Whether the message reached the transport
   * @private
   */
  _sendInit(conversationId, serializedConversation) {
    /** @type {{type: string, conversation: object, config: object|null, stateVector?: string}} */
    const message = {
      type: 'init',
      conversation: serializedConversation,
      config: this._config
    };
    const conversation = this._session?.conversations.get(conversationId);
    if (conversation) {
      try {
        message.stateVector = bytesToBase64(conversation.getYjsStateVector());
      } catch (err) {
        // Without a vector the worker sends full state, which is correct — just
        // larger. Never let it stop the init.
        console.warn(`[WorkerManager] Couldn't read the state vector for ${conversationId}:`, err);
      }
    }
    return wsService.sendWorkerMessage(conversationId, message);
  }

  /**
   * Terminate a worker for a conversation.
   * Removes from local tracking. Backend worker cleanup happens via HTTP DELETE
   * (which calls workerManager.Remove() in HandleDeleteConversation).
   * @param {string} conversationId - Conversation ID
   */
  terminate(conversationId) {
    this._workers.delete(conversationId);
    // A createThread awaiting this conversation can never be answered now: its
    // reply arrives as a worker message for a worker this manager no longer
    // holds. Unwind it here rather than leaving the awaiter — and the closure
    // graph behind it — parked for the life of the process.
    this._rejectThreadRequests(
      (pending) => pending.conversationId === conversationId,
      `Conversation ${conversationId} was closed while its thread was running`
    );
  }

  /**
   * Reject and drop every pending create-thread request matching `match`.
   * @param {(pending: {conversationId?: string}) => boolean} match - Selector
   * @param {string} message - Rejection message
   * @private
   */
  _rejectThreadRequests(match, message) {
    for (const [requestId, pending] of [...this._pendingThreadRequests]) {
      if (!match(pending)) continue;
      this._pendingThreadRequests.delete(requestId);
      try {
        // AbortError: the thread was not answered, it was called off. Callers
        // already distinguish that from a thread that ran and failed.
        const err = new Error(message);
        err.name = 'AbortError';
        pending.reject(err);
      } catch { /* a rejection handler that throws must not strand the rest */ }
    }
  }

  /**
   * Terminate all workers and reset internal bookkeeping, the loader's
   * included. Used by test teardown so a new test starts with empty state — an
   * in-flight create left in the loader would be joined by a later create that
   * happened to reuse the same id.
   */
  terminateAll() {
    this._workers.clear();
    this._spawning.clear();
    this.loader.reset();

    // Reject outstanding thread requests so their awaiters unwind instead of
    // hanging forever, then drop them.
    this._rejectThreadRequests(() => true, 'Worker manager terminated');

    // Reject each pending ack — the reject wrapper clears its timeout, so the
    // timers don't fire later against torn-down state.
    for (const pending of this._pendingAcks.values()) {
      try {
        pending.reject(new Error('Worker manager terminated'));
      } catch { /* ignore */ }
    }
    this._pendingAcks.clear();
  }


  /**
   * Send a message to a specific worker via WebSocket, once that worker is ready.
   *
   * For a ready worker the message is handed to the socket synchronously, inside
   * this call. For one still starting, it is held until the worker reports ready
   * and then handed over; held sends go out in the order they were made, so
   * messages to one conversation stay in call order either way.
   *
   * The promise says nothing about delivery: it resolves once the message has
   * been handed to the transport — which drops it if the link is down — or
   * immediately when no worker exists for the conversation. It rejects only when
   * a not-yet-ready worker never becomes ready (init failure or ready timeout).
   * Fire-and-forget callers are correct to ignore it; an ack'd request
   * ({@link WorkerManager#sendWithAck}) is how to learn the worker acted.
   * @param {string} conversationId - Conversation ID
   * @param {{type: string, [key: string]: unknown}} message - Message to send
   * @returns {Promise<void>} Resolves on hand-off to the transport, not on delivery
   */
  async sendToWorker(conversationId, message) {
    const entry = this._workers.get(conversationId);
    if (!entry) {
      console.warn(`[WorkerManager] No worker found for ${conversationId}`);
      return;
    }

    // Wait for ready if not already
    if (!entry.ready) {
      await this.waitForWorkerReady(conversationId);
    }

    wsService.sendWorkerMessage(conversationId, message);
  }

  /**
   * Send approval response to worker
   * @param {string} conversationId - Conversation ID
   * @param {string} toolUseId - Tool use ID
   * @param {string} response - Approval response
   */
  sendApprovalResponse(conversationId, toolUseId, response) {
    protocols.sendApprovalResponse(this, conversationId, toolUseId, response);
  }

  /**
   * Send rendered context items response to worker
   * @param {string} conversationId - Conversation ID
   * @param {string} requestId - Request ID
   * @param {Array<{itemId: string, content: string, tokens: number}>} contexts - Rendered context item contexts
   * @param {string} [systemPrompt] - Full system prompt built by frontend
   */
  sendRenderContextItemsResponse(conversationId, requestId, contexts, systemPrompt = '') {
    protocols.sendRenderContextItemsResponse(this, conversationId, requestId, contexts, systemPrompt);
  }


  /**
   * Send tool definitions to worker
   * @param {string} conversationId - Conversation ID
   * @param {string} requestId - Request ID
   * @param {Array<object>} tools - Tool definitions
   */
  sendToolsResult(conversationId, requestId, tools) {
    protocols.sendToolsResult(this, conversationId, requestId, tools);
  }


  /**
   * Send a built subthread spec (or null) back to the worker.
   * @param {string} conversationId - Conversation ID
   * @param {string} requestId - Request ID
   * @param {object|null} spec - SubthreadSpec, or null to run the tool normally
   * @param {string} [error] - Optional error reason (treated as null spec)
   */
  sendBuildSubthreadSpecResponse(conversationId, requestId, spec, error = '') {
    protocols.sendBuildSubthreadSpecResponse(this, conversationId, requestId, spec, error);
  }


  /**
   * Request user message send
   * @param {string} conversationId - Conversation ID
   * @param {string} text - Message text
   * @param {string|null} [threadItemId] - Thread item ID if sending from a thread column
   * @param {Array<{id:string,mime:string,filename:string,bytes:number,width:number,height:number}>} [attachments] -
   *   Content-addressed asset references (uploaded images) to store on the user item.
   * @param {string[]} [skills] - Agent Skill names the user explicitly chose to load
   *   before this turn; the worker injects each as a visible `skill` tool-action.
   */
  sendMessage(conversationId, text, threadItemId, attachments, skills) {
    // Store only the reference fields on the doc item — never raw bytes / data
    // URLs. Omit the key entirely when there are no attachments so the worker
    // writes a byte-identical user item to a plain text message.
    const refs = Array.isArray(attachments) && attachments.length
      ? attachments.map((a) => ({
        id: a.id,
        mime: a.mime,
        filename: a.filename,
        bytes: a.bytes,
        width: a.width,
        height: a.height
      }))
      : undefined;
    const skillNames = Array.isArray(skills) && skills.length ? skills : undefined;
    this.sendToWorker(conversationId, {
      type: 'send-message',
      text,
      threadItemId: threadItemId || undefined,
      attachments: refs,
      skills: skillNames
    });
  }

  /**
   * Request conversation continue
   * @param {string} conversationId - Conversation ID
   * @param {string|null} [threadItemId] - Thread item ID if continuing from a thread column
   */
  continue(conversationId, threadItemId) {
    this.sendToWorker(conversationId, { type: 'send-message', text: '', isContinuation: true, threadItemId: threadItemId || undefined });
  }

  /**
   * Request conversation cancel
   * @param {string} conversationId - Conversation ID
   * @param {string} [reason] - What caused the cancel (`escape`, `stop button`, `undo/redo`, …).
   *   Logged by the worker so a cancelled turn says who stopped it; never shown to the user.
   */
  cancel(conversationId, reason) {
    this.sendToWorker(conversationId, { type: 'cancel', reason });
  }

  /**
   * Request a polite stop (Pause) over a thread and everything below it: the
   * work in flight there finishes and records its real result, then rests before
   * the next LLM turn. Non-destructive — the worker marks this and cancels
   * nothing. Distinct WS message type so the hot mid-turn wait-loop selects can
   * branch on Type without parsing a payload.
   * @param {string} conversationId - Conversation ID
   * @param {string} [threadItemId] - Thread the pause covers; '' (the default)
   *   is the root, which stands over the whole conversation.
   */
  pause(conversationId, threadItemId = '') {
    this.sendToWorker(conversationId, { type: 'pause', threadItemId });
  }

  /**
   * Lift the Pause standing over a thread, so its work carries on to its next
   * boundary instead of resting. Sent when the Pause button is toggled back off,
   * and by Resume. Symmetric to pause; a no-op on the worker when no mark covers
   * that thread.
   * @param {string} conversationId - Conversation ID
   * @param {string} [threadItemId] - Thread whose covering marks are lifted.
   */
  unpause(conversationId, threadItemId = '') {
    this.sendToWorker(conversationId, { type: 'unpause', threadItemId });
  }

  /**
   * Request an on-demand tab-title derivation. The worker re-derives a title
   * from the conversation's first user message and hands off to the server,
   * which renames and broadcasts the change (a no-op before the first user
   * message). Fire-and-forget: the rename arrives via the normal
   * conversations-changed broadcast.
   * @param {string} conversationId - Conversation ID
   * @param {object} [opts]
   * @param {boolean} [opts.force] - True (default) for a user-requested
   *   "auto-name now": renames whatever the tab is called and regardless of the
   *   auto-naming setting. False for a background request (/handoff), which
   *   applies only while the name is still machine-derived (`nameIsAuto`) and
   *   auto-naming is enabled.
   */
  requestAutoName(conversationId, { force = true } = {}) {
    this.sendToWorker(conversationId, { type: 'request-auto-name', force });
  }

  /**
   * Create a sub-thread on the worker (strategy-driven).
   * Blocks until the thread completes and returns its result.
   * @param {string} conversationId - Conversation ID
   * @param {{goal: string, prompt: string, parentThreadItemId?: string|null, isContinuation?: boolean}} options - Thread options
   * @param {AbortSignal} [signal] - Abort signal for cancellation
   * @returns {Promise<{threadItemId: string, result: string}>} Thread result
   */
  createThread(conversationId, { goal, prompt, parentThreadItemId = null, isContinuation = false }, signal) {
    // Salted with this instance id for the same reason as ackId below:
    // create-thread-response is broadcast to all clients and matched by
    // requestId, so a bare per-instance counter collides across clients.
    const requestId = `thread_${this._instanceId}_${++this._ackCounter}`;

    return new Promise((resolve, reject) => {
      /** @type {(() => void)|null} */
      let onAbort = null;
      // Detach the abort listener whenever the request settles — on success
      // (create-thread-response), on error, or on abort. Without this the
      // listener stays wired to the signal for the life of the AbortController,
      // leaking one handler per completed thread.
      const detachAbort = () => {
        if (signal && onAbort) {
          signal.removeEventListener('abort', onAbort);
          onAbort = null;
        }
      };
      // No wall-clock deadline here, unlike sendWithAck's 5s. The two wait for
      // different things: an ack is an immediate receipt, so any silence past a
      // few seconds means the message was lost, whereas this waits for a whole
      // sub-agent run to finish — reading files, calling a model, running its own
      // tools — which legitimately takes minutes and has no honest upper bound.
      // A timer here would abandon a thread that was working perfectly.
      //
      // What ends the wait instead is an event: create-thread-response, the
      // caller's abort, or {@link WorkerManager#terminate} for this conversation.
      // The conversationId is recorded so that last one can find this entry —
      // without it, a conversation torn down mid-thread (closed, deleted, or
      // released by the engine) leaves the awaiter hanging and the entry, with
      // the whole closure graph behind it, in the map for the process lifetime.
      this._pendingThreadRequests.set(requestId, {
        conversationId,
        resolve: (/** @type {*} */ value) => { detachAbort(); resolve(value); },
        reject: (/** @type {Error} */ err) => { detachAbort(); reject(err); },
      });

      // Wire up AbortSignal to reject + cleanup on cancellation
      if (signal) {
        onAbort = () => {
          const pending = this._pendingThreadRequests.get(requestId);
          if (pending) {
            this._pendingThreadRequests.delete(requestId);
            const err = new Error('Operation aborted');
            err.name = 'AbortError';
            pending.reject(err);
          }
        };
        if (signal.aborted) {
          this._pendingThreadRequests.delete(requestId);
          const err = new Error('Operation aborted');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.sendToWorker(conversationId, {
        type: 'create-thread',
        requestId,
        goal,
        prompt,
        threadItemId: parentThreadItemId || undefined,
        isContinuation
      });
    });
  }

  // ========== HIGH-LEVEL OPERATIONS ==========
  // Complex atomic operations that require worker coordination

  /**
   * Clear all history (items and context items) in the worker
   * ATOMIC OPERATION: Clears both items AND context items atomically
   * @param {string} conversationId - Conversation ID
   */
  clearHistory(conversationId) {
    this.sendToWorker(conversationId, { type: 'clear-history' });
  }

  /**
   * Retry a cancelled tool approval
   * @param {string} conversationId - Conversation ID
   * @param {string} toolUseId - Tool use ID to retry
   */
  retryToolApproval(conversationId, toolUseId) {
    protocols.retryToolApproval(this, conversationId, toolUseId);
  }

  /**
   * Update tool-actions with new hash and reposition changed ones to end.
   * Worker finds all tool-actions for the itemId, compares hashes,
   * updates mismatched ones and moves them to the end.
   * @param {string} conversationId - Conversation ID
   * @param {string} itemId - Context item ID to match
   * @param {number} newHash - New content hash
   */
  updateAndRepositionToolActions(conversationId, itemId, newHash) {
    protocols.updateAndRepositionToolActions(this, conversationId, itemId, newHash);
  }

  /**
   * Settle the pending {@link WorkerManager#createThread} a
   * `create-thread-response` answers. A response for a request this client
   * did not make (the worker broadcasts them) or already settled is ignored.
   * @param {string} requestId - The request the response names
   * @param {{error: string, cancelled: boolean}|{threadItemId: string, result: string}} outcome -
   *   The thread's result, or why it has none. A cancelled thread rejects
   *   with an AbortError, so callers can tell it from one that failed.
   * @returns {void}
   */
  settleThreadRequest(requestId, outcome) {
    const pending = this._pendingThreadRequests.get(requestId);
    if (!pending) return;
    this._pendingThreadRequests.delete(requestId);
    if ('error' in outcome) {
      const err = new Error(outcome.error);
      if (outcome.cancelled) err.name = 'AbortError';
      pending.reject(err);
      return;
    }
    pending.resolve({ threadItemId: outcome.threadItemId, result: outcome.result });
  }

  /**
   * Send a command to worker and wait for acknowledgment
   * @param {string} conversationId - Conversation ID
   * @param {{type: string, [key: string]: unknown}} message - Message to send (will have ackId added)
   * @param {number} [timeout=5000] - Timeout in ms
   * @returns {Promise<*>} Resolves with result from worker (if any)
   */
  sendWithAck(conversationId, message, timeout = 5000) {
    return new Promise((resolve, reject) => {
      // Salt the ackId with this instance id. The worker broadcasts its ack to
      // ALL registered clients (callbacks.broadcast), and settleAck matches
      // purely by ackId — so a bare per-instance counter ("ack_3") collides
      // across clients and a sibling conversation's broadcast ack could resolve
      // THIS request's promise with the wrong conversation's result (observed:
      // getTransaction returning another conv's blob). The salt makes ackIds
      // globally unique, so a broadcast ack for another client's request is
      // simply absent from this client's _pendingAcks.
      const ackId = `${this._instanceId}_ack_${++this._ackCounter}`;
      const timeoutId = setTimeout(() => {
        this._pendingAcks.delete(ackId);
        reject(new Error(`[WorkerManager] Ack timeout for ${message.type} (${ackId})`));
      }, timeout);

      this._pendingAcks.set(ackId, {
        resolve: (/** @type {*} */ result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (/** @type {Error} */ err) => {
          clearTimeout(timeoutId);
          reject(err);
        }
      });

      this.sendToWorker(conversationId, { ...message, ackId });
    });
  }


  /**
   * Settle the {@link WorkerManager#sendWithAck} an `ack` answers. An ack for
   * a request this client did not make is ignored.
   * @param {string} ackId - Acknowledgment ID
   * @param {*} [result] - Optional result from worker
   * @returns {void}
   */
  settleAck(ackId, result) {
    const pending = this._pendingAcks.get(ackId);
    if (pending) {
      // Delete before resolve so a duplicate ack (worker can broadcast acks)
      // doesn't re-invoke pending.resolve and any synchronous observers
      // can't see a stale entry mid-callback.
      this._pendingAcks.delete(ackId);
      pending.resolve(result);
    }
  }



  // ========== STATE CHANGE OPERATIONS ==========
  // These notify the worker of state changes. Worker handles saving to backend.




  /**
   * Retry a tool action (reset to pending state)
   * Worker updates its items and saves
   * @param {string} conversationId - Conversation ID
   * @param {string} toolUseId - Tool use ID to retry
   */
  retryToolAction(conversationId, toolUseId) {
    protocols.retryToolAction(this, conversationId, toolUseId);
  }


  /**
   * Update tool action for retry (set approvalOptions and displayData)
   * Called when retrying an action - worker resets to pending, main updates options.
   * @param {string} conversationId - Conversation ID
   * @param {string} toolUseId - Tool use ID
   * @param {object} approvalOptions - Approval options for UI
   * @param {object} [displayData] - Display data for UI
   */
  updateToolActionForRetry(conversationId, toolUseId, approvalOptions, displayData) {
    protocols.updateToolActionForRetry(this, conversationId, toolUseId, approvalOptions, displayData);
  }

  /**
   * Update tool-actions to clear itemId and set placeholder content.
   * Used when repositioning context items - old tool-action becomes placeholder.
   * Worker owns items[], so mutation must happen there.
   * @param {string} conversationId - Conversation ID
   * @param {string} itemId - Context item ID to find and update
   * @param {string} content - Text the detached tool-action shows in place of the item
   */
  repositionContextItemPlaceholder(conversationId, itemId, content) {
    protocols.repositionContextItemPlaceholder(this, conversationId, itemId, content);
  }

  /**
   * Where a conversation's worker entry stands: none at all, spawned and
   * waiting for its `ready`, or ready. Unlike {@link isWorkerReady} this says
   * nothing about the socket; a worker outlives a link drop.
   * @param {string} conversationId - Conversation ID
   * @returns {'absent'|'starting'|'ready'} The entry's state
   */
  workerState(conversationId) {
    const entry = this._workers.get(conversationId);
    if (!entry) return 'absent';
    return entry.ready ? 'ready' : 'starting';
  }

  /**
   * Record a worker's `ready` and release everything waiting on it.
   *
   * One kind of ready is not ours: an entry spawned with `loadFromDisk` waits
   * for the ready that carries metadata, which the worker sends in answer to
   * this client's init. A metadata-less one arriving first came from another
   * client's init (a viewer creating the conversation, say) and is ignored;
   * the one we want follows shortly.
   * @param {string} conversationId - Conversation ID
   * @param {object|null} metadata - The conversation metadata the ready
   *   carried, present when it answers a load from disk
   * @returns {{loadFromDisk: boolean}|null} How the entry was spawned, or null
   *   when there is no entry or the ready was not ours
   */
  markReady(conversationId, metadata) {
    const entry = this._workers.get(conversationId);
    if (!entry) return null;
    if (entry.loadFromDisk && !metadata) return null;
    entry.ready = true;
    entry.metadata = metadata || null;
    for (const callback of entry.readyCallbacks) {
      callback(entry.metadata);
    }
    entry.readyCallbacks = [];
    entry.readyRejectors = [];
    return { loadFromDisk: !!entry.loadFromDisk };
  }

  /**
   * Fail everything waiting on a worker's `ready`, because the worker said it
   * cannot start. A no-op once the worker is ready, or with nobody waiting.
   * @param {string} conversationId - Conversation ID
   * @param {string} message - The worker's reason, given to each waiter
   * @returns {void}
   */
  failPendingReady(conversationId, message) {
    const entry = this._workers.get(conversationId);
    if (!entry || entry.ready || !entry.readyRejectors?.length) return;
    const rejectors = entry.readyRejectors;
    entry.readyRejectors = [];
    entry.readyCallbacks = [];
    const err = new Error(message);
    for (const reject of rejectors) reject(err);
  }

  /**
   * Re-send an init for a conversation whose worker entry this manager still
   * holds, marking the entry not ready until the worker answers it.
   *
   * An entry outlives the Conversation that owns the document, so a fresh,
   * empty Conversation for the same id would otherwise find
   * {@link spawnWorker} short-circuit on the existing entry, and an init is
   * the only thing that asks the worker for state. A no-op when there is no
   * entry, in which case `spawnWorker` sends the init.
   * @param {string} conversationId - Conversation ID
   * @param {{loadFromDisk?: boolean, [key: string]: unknown}} serializedConversation - The init's conversation data
   * @returns {void}
   */
  reattach(conversationId, serializedConversation) {
    const entry = this._workers.get(conversationId);
    if (!entry) return;
    entry.ready = false;
    entry.loadFromDisk = !!serializedConversation.loadFromDisk;
    this._sendInit(conversationId, serializedConversation);
  }

  /**
   * On WebSocket reconnect, open the two-way catch-up with every ready worker:
   * send each conversation's state vector as a resync-request. The worker
   * answers with a `resync-response` carrying the ops this client missed AND its
   * own state vector, which {@link _handleWorkerMessage} turns into the ops the
   * WORKER missed. Both halves are deltas.
   *
   * The inbound half keeps a viewer that briefly lost its WS from silently
   * freezing; the outbound half is the only thing that carries a local edit made
   * during the outage to the worker, since the transport discards outbound
   * frames while the link is down and nothing queues them. Cheap either way:
   * applying a delta we already have is a Yjs no-op, and neither side re-sends
   * full document state, which is what made the remote tunnel burn gigabytes.
   *
   * Runs for viewers and the engine alike — the engine holds a live doc it
   * writes to (its tool-action reducer), and having no page reload to fall back
   * on, this is its only recovery.
   * @returns {void}
   */
  resyncReadyConversations() {
    if (!this._session) return;
    for (const [conversationId, entry] of this._workers) {
      if (!entry.ready) continue;
      const conversation = this._session.conversations.get(conversationId);
      if (!conversation) continue;
      try {
        const vector = conversation.getYjsStateVector();
        this.sendToWorker(conversationId, {
          type: 'resync-request',
          stateVector: bytesToBase64(vector)
        });
      } catch (err) {
        console.warn(`[WorkerManager] resync failed for ${conversationId}:`, err);
      }
    }
  }

  /**
   * On WebSocket reconnect, re-send the init of every conversation still
   * waiting to boot — the other half of the catch-up, covering the
   * conversations {@link resyncReadyConversations} cannot help.
   *
   * A conversation that was spawning when the link dropped had its init
   * discarded by the transport, which queues nothing. Nothing else would ever
   * re-send it: the entry never reaches `ready`, so the resync skips it, and it
   * waits out its boot timeout and fails the load. Re-sending is safe against a
   * worker that did receive the first one — a second init lands on an
   * initialized worker, which answers it as an ordinary attach.
   * @returns {void}
   */
  reinitPendingConversations() {
    for (const [conversationId, entry] of this._workers) {
      if (entry.ready || !entry.serialized) continue;
      this._sendInit(conversationId, entry.serialized);
    }
  }

  /**
   * Whether a worker exists, has booted, and is reachable right now.
   *
   * Two independent facts, and callers need both: `entry.ready` says the worker
   * announced itself, while the socket says we can still talk to it. The worker
   * lives in the server process and outlives any link drop, so a disconnect
   * never clears `entry.ready` — {@link resyncReadyConversations} relies on that
   * to know which conversations to catch up on reconnect. But every caller of
   * this method is guarding a send, and `sendWorkerMessage` discards frames
   * while the socket is down (returning `false` that nobody reads). Reporting
   * "ready" then would let those sends fall silently on the floor; reporting
   * not-ready lets each caller refuse in its own way.
   * @param {string} conversationId - Conversation ID
   * @returns {boolean} True if the worker is ready and the socket is up
   */
  isWorkerReady(conversationId) {
    const entry = this._workers.get(conversationId);
    if (!entry || !entry.ready) return false;
    return wsService.isConnected();
  }

  /**
   * Handle message from worker: hand it to its inbound handler
   * (`worker-manager-inbound.js`).
   * @param {string} conversationId - Conversation ID
   * @param {WorkerMessage} data - Message data
   * @private
   */
  _handleWorkerMessage(conversationId, data) {
    routeWorkerMessage(this, conversationId, data);
  }

  // ========== UNDO/REDO OPERATIONS ==========

  /**
   * Undo the last operation
   * @param {string} conversationId - Conversation ID
   * @returns {Promise<boolean>} True if undo was successful
   */
  async undo(conversationId) {
    return await this.sendWithAck(conversationId, { type: 'undo' });
  }

  /**
   * Redo the last undone operation
   * @param {string} conversationId - Conversation ID
   * @returns {Promise<boolean>} True if redo was successful
   */
  async redo(conversationId) {
    return await this.sendWithAck(conversationId, { type: 'redo' });
  }

  /**
   * Clear undo/redo stacks, so what was just written cannot be undone. The
   * session does this after seeding a new conversation and after duplicating
   * one; tests use it to start from an empty history.
   * @param {string} conversationId - Conversation ID
   * @returns {Promise<boolean>} True when complete
   */
  async clearUndoStacks(conversationId) {
    // Patient: a loaded pool can hold the worker's inbound queue past the
    // default 5s without anything being wrong.
    return await this.sendWithAck(conversationId, { type: 'clear-undo-stacks' }, 15000);
  }

  /**
   * Re-run the folded-compaction summariser over a compaction (/compact or
   * /handoff) thread: the worker clears the committed summary and re-arms the
   * thread's run trigger, so the summary is regenerated from the same source
   * with the summariser's own prompt — nothing is appended to the thread.
   * @param {string} conversationId - Conversation ID
   * @param {string} threadItemId - Compaction thread item ID
   * @returns {Promise<boolean>} True if the thread was re-armed (false when it
   *   is not a compaction thread)
   */
  async resummarizeCompactionThread(conversationId, threadItemId) {
    return await this.sendWithAck(conversationId, { type: 'resummarize-compaction-thread', threadItemId });
  }

  /**
   * Fetch the input/output blob for one LLM round-trip.
   * Resolves to the parsed blob, or null when the worker has no record of
   * that transactionId on disk (e.g. it was GC'd while still referenced
   * elsewhere — defensive only, this should not happen in practice).
   * @param {string} conversationId - Conversation ID
   * @param {string} transactionId - Round-trip id stamped on the originating item
   * @returns {Promise<object|null>} Parsed transaction blob or null
   */
  async getTransaction(conversationId, transactionId) {
    const result = await this.sendWithAck(conversationId, {
      type: 'get-transaction',
      transactionId
    });
    return result ?? null;
  }

  /**
   * Fold the conversation into a compaction summary thread worker-side — the
   * single Go fold shared by /compact, /handoff, and the proactive
   * auto-compaction trigger. The worker performs the fold on its authoritative
   * doc, summarises it, and merges fold + summary into one undo group. Resolves
   * with the worker's result once the (fast) fold has committed; the summary
   * generates afterward and streams in via the normal doc sync.
   * @param {string} conversationId - Conversation whose worker performs the fold
   * @param {{ handoffPromote?: boolean }} [opts]
   * @returns {Promise<{ folded: boolean, error?: string }>} The worker's outcome
   *   (`folded` false when there was nothing to fold)
   */
  async compact(conversationId, { handoffPromote = false } = {}) {
    const result = await this.sendWithAck(conversationId, {
      type: 'compact',
      handoffPromote
    });
    return result ?? { folded: false };
  }

  /**
   * Check if undo is available (reads from Yjs metadata)
   * @param {string} conversationId - Conversation ID
   * @returns {boolean} True if undo is available
   */
  canUndo(conversationId) {
    const conversation = this._session?.conversations.get(conversationId);
    const undoState = conversation?.getMetadata('undoState');
    return undoState?.canUndo ?? false;
  }

  /**
   * Check if redo is available (reads from Yjs metadata)
   * @param {string} conversationId - Conversation ID
   * @returns {boolean} True if redo is available
   */
  canRedo(conversationId) {
    const conversation = this._session?.conversations.get(conversationId);
    const undoState = conversation?.getMetadata('undoState');
    return undoState?.canRedo ?? false;
  }

  // ============================================================================
  // Undo grouping and persistence barriers
  // ============================================================================

  /**
   * Force the worker to persist its conversation state to disk now, bypassing
   * the SaveDebounceTime debounce, and resolve once the write has completed (the
   * worker acks after saveStateToDisk returns).
   *
   * The worker takes inbound messages serially, so every yjs-sync sent before
   * this one is already applied when it runs — which makes the ack a genuine
   * "it's on disk" barrier, not just "it arrived". Quit teardown uses that to
   * confirm rescued drafts landed before the app terminates; persistence tests
   * use it for a deterministic mutate → save → destroy → reload without sleeping
   * past the 2s debounce, which races the save on slow/contended CI runners.
   * @param {string} conversationId - Conversation ID
   * @param {number} [timeoutMs] - Ack timeout. Defaults to a patient 30s, since
   *   a loaded pool can push the save behind a deep inbound queue and the
   *   per-test hard timeout is the fail-fast bound. Teardown callers pass
   *   something far shorter — they have a native quit waiting on them.
   * @returns {Promise<void>}
   */
  async flushPersistence(conversationId, timeoutMs = 30000) {
    await this.sendWithAck(conversationId, { type: 'flush-persistence' }, timeoutMs);
  }

  /**
   * Tell the worker's UndoManager to close its current capture window so the
   * next mutation starts a fresh undo group. Without this, browser-driven
   * mutations issued within the captureTimeout window get merged — undoing
   * then unexpectedly reverses multiple user actions at once.
   * @param {string} conversationId - Conversation ID
   * @returns {void}
   */
  stopUndoCapturing(conversationId) {
    this.sendToWorker(conversationId, { type: 'stop-undo-capturing' });
  }

  /**
   * Open an undo-coalescing bracket: tell the worker to snapshot its undo-stack
   * height now, so every group added until {@link endUndoCoalescing} collapses
   * into one. The marker reaches the worker ahead of the bracketed mutations'
   * yjs-sync frames because both go through {@link sendToWorker}, which keeps
   * one conversation's messages in call order; the snapshot therefore reflects
   * state before the first write whether or not the caller awaits.
   * @param {string} conversationId - Conversation ID
   * @returns {Promise<void>} {@link sendToWorker}'s promise: awaiting it surfaces
   *   a worker that never became ready, so the caller can skip the bracket.
   */
  beginUndoCoalescing(conversationId) {
    return this.sendToWorker(conversationId, { type: 'begin-undo-coalesce' });
  }

  /**
   * Close the undo-coalescing bracket: collapse every undo group added since
   * {@link beginUndoCoalescing} into a single group, so the bracketed operation
   * reverts in one undo. Ack'd so the caller can await the merge completing.
   * @param {string} conversationId - Conversation ID
   * @returns {Promise<boolean>} Resolves when the worker has merged the groups
   */
  async endUndoCoalescing(conversationId) {
    return await this.sendWithAck(conversationId, { type: 'end-undo-coalesce' });
  }

  // ============================================================================
  // Worker lifecycle: the surface ConversationLoader builds on
  // ============================================================================

  /**
   * Wait for a spawned worker to report ready. Rejects at once when there is
   * no entry, when the worker reports an error instead, or at the timeout.
   * @param {string} conversationId - Conversation ID
   * @param {number} [timeoutMs=WORKER_READY_TIMEOUT_MS] - Timeout in milliseconds
   * @returns {Promise<object|null>} Metadata from ready message (null for new conversations)
   */
  async waitForWorkerReady(conversationId, timeoutMs = WORKER_READY_TIMEOUT_MS) {
    const timeout = timeoutMs;
    const entry = this._workers.get(conversationId);
    if (!entry) {
      throw new Error(`Worker not found: ${conversationId}`);
    }
    if (entry.ready) {
      return entry.metadata || null;  // Already ready
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Worker ${conversationId} not ready after ${timeout}ms`));
      }, timeout);

      entry.readyCallbacks.push((/** @type {object|null} */ metadata) => {
        clearTimeout(timer);
        resolve(metadata || null);
      });
      // A worker that fails its init reports an error and then says nothing.
      // Without this the wait runs to its full timeout, and the user watches a
      // spinner for a minute over a failure the server already described.
      (entry.readyRejectors ??= []).push((/** @type {Error} */ err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * Spawn a worker for a conversation: create its entry and send its init. A
   * spawn already in flight for the id is joined, and an existing entry is
   * left alone (see {@link reattach} for re-sending its init).
   * @param {string} conversationId - Conversation ID
   * @param {{loadFromDisk?: boolean, [key: string]: unknown}} serializedConversation - Serialized conversation data
   * @returns {Promise<void>} Resolves once the worker reports ready
   */
  async spawnWorker(conversationId, serializedConversation) {
    // Check if already spawning (lock via in-flight promise)
    if (this._spawning.has(conversationId)) {
      console.warn(`[WorkerManager] Duplicate spawn for ${conversationId} - waiting for in-flight`);
      return await this._spawning.get(conversationId);
    }

    // Check if worker already exists
    if (this._workers.has(conversationId)) {
      console.warn(`[WorkerManager] Worker already exists for ${conversationId} - returning`);
      return;
    }

    // Start spawn (atomic)
    const promise = this._doSpawn(conversationId, serializedConversation);
    this._spawning.set(conversationId, promise);

    try {
      await promise;
    } finally {
      this._spawning.delete(conversationId);
    }
  }
}

// Singleton instance
const workerManager = new WorkerManager();

export default workerManager;
