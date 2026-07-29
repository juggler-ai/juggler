//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Worker Manager - Manages conversation workers via WebSocket.
 * Routes messages to workers running on the backend server.
 * Each conversation gets its own dedicated worker for orchestration.
 * @module services/worker-manager
 */

import wsService from './websocket.js';
import * as protocols from './worker-manager-protocols.js';
import { recordTape } from '../utils/event-tape.js';
import { bytesToBase64, base64ToBytes } from '../utils/base64.js';
import { isEngine } from '../../sdk/lib/client-role.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { setBootstrapSummarizationPrompt } from '../utils/compaction-utils.js';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * @typedef {object} WorkerEntry
 * @property {string} conversationId - Associated conversation ID
 * @property {boolean} ready - Whether worker has initialized
 * @property {Array<Function>} readyCallbacks - Callbacks waiting for ready state
 * @property {object|null} [metadata] - Metadata extracted from ready message (for existing conversations)
 * @property {boolean} [loadFromDisk] - Whether this entry was spawned with loadFromDisk:true
 */

/**
 * @typedef {object} WorkerMessage
 * @property {string} type - Message type
 * @property {object} [patch] - State patch data
 * @property {number[]} [update] - Yjs update
 * @property {number[]} [bytes] - Yjs sync message bytes (from y-generic-sync)
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
 * @property {boolean} [canUndo] - Whether undo is available (for undo-state messages)
 * @property {boolean} [canRedo] - Whether redo is available (for undo-state messages)
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
class WorkerManager {
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
     * Map of conversation ID to in-flight creation/load promises
     * Used to prevent duplicate spawns during async operations
     * @type {Map<string, Promise<import('../model/conversation.js').default>>}
     * @private
     */
    this._creating = new Map();

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
     * Callback for subthread-spec build requests (delegatesToSubthread tools)
     * @type {((request: object, conversationId: string) => void)|null}
     * @private
     */
    this._onSubthreadSpecRequest = null;

    /**
     * Callback for subthread-error fallback requests (onSubthreadError)
     * @type {((request: object, conversationId: string) => void)|null}
     * @private
     */
    this._onSubthreadErrorRequest = null;

    /**
     * In-flight auto-load promises for unknown conversations (conversationId -> Promise).
     * Prevents duplicate loads and queues yjs-sync bytes until load completes.
     * @type {Map<string, {promise: Promise<void>, queuedBytes: string[]}>}
     * @private
     */
    this._pendingAutoLoads = new Map();

    /**
     * Pending strategy-driven thread creation requests (requestId -> {resolve, reject})
     * @type {Map<string, {resolve: Function, reject: Function}>}
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
    // Route to existing message handler
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
   * Set callback for subthread-error fallback requests from workers (engine-only).
   * @param {(request: object, conversationId: string) => void} callback
   */
  setOnSubthreadErrorRequest(callback) {
    this._onSubthreadErrorRequest = callback;
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
      loadFromDisk: !!serializedConversation.loadFromDisk
    };
    this._workers.set(conversationId, entry);

    // Wait for ready with timeout. 60s — large CRDT loads, WS write congestion
    // during initial cold start, or a backgrounded tab can blow past anything
    // tighter. A timeout here drops the conversation from session, so be
    // generous: a longer wait is strictly better than losing user data.
    /** @type {Promise<void>} */
    const readyPromise = new Promise((resolve, reject) => {
      entry.readyCallbacks.push((/** @type {object|null} */ _metadata) => {
        resolve();  // Ignore metadata here - caller uses _waitForWorkerReady to get it
      });
      setTimeout(() => {
        if (!entry.ready) {
          reject(new Error('Worker initialization timeout'));
        }
      }, WORKER_READY_TIMEOUT_MS);
    });

    // Send init message via WebSocket (or alternate transport)
    wsService.sendWorkerMessage(conversationId, {
      type: 'init',
      conversation: serializedConversation,
      config: this._config
    });

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
   * Terminate a worker for a conversation.
   * Removes from local tracking. Backend worker cleanup happens via HTTP DELETE
   * (which calls workerManager.Remove() in HandleDeleteConversation).
   * @param {string} conversationId - Conversation ID
   */
  terminate(conversationId) {
    this._workers.delete(conversationId);
  }

  /**
   * Terminate all workers and reset internal bookkeeping. Used by test
   * teardown so a new test starts with empty state — leaving _creating
   * promises around would block a subsequent createNewConversation that
   * happened to reuse the same id.
   */
  terminateAll() {
    this._workers.clear();
    this._creating.clear();
    this._spawning.clear();
    this._pendingAutoLoads.clear();

    // Reject outstanding thread requests so their awaiters unwind instead of
    // hanging forever, then drop them.
    for (const pending of this._pendingThreadRequests.values()) {
      try {
        const err = new Error('Worker manager terminated');
        err.name = 'AbortError';
        pending.reject(err);
      } catch { /* ignore */ }
    }
    this._pendingThreadRequests.clear();

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
   * Send message to a specific worker via WebSocket
   * Waits for worker to be ready before sending
   * @param {string} conversationId - Conversation ID
   * @param {{type: string, [key: string]: unknown}} message - Message to send
   * @returns {Promise<void>}
   */
  async sendToWorker(conversationId, message) {
    const entry = this._workers.get(conversationId);
    if (!entry) {
      console.warn(`[WorkerManager] No worker found for ${conversationId}`);
      return;
    }

    // Wait for ready if not already
    if (!entry.ready) {
      await this._waitForWorkerReady(conversationId);
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
   * Send an onSubthreadError fallback result back to the worker.
   * @param {string} conversationId - Conversation ID
   * @param {string} requestId - Request ID
   * @param {string} result - Fallback tool_result text ('' → use default)
   */
  sendSubthreadErrorResponse(conversationId, requestId, result) {
    protocols.sendSubthreadErrorResponse(this, conversationId, requestId, result);
  }


  /**
   * Request user message send
   * @param {string} conversationId - Conversation ID
   * @param {string} text - Message text
   * @param {string|null} [threadItemId] - Thread item ID if sending from a thread column
   * @param {Array<{id:string,mime:string,filename:string,bytes:number,width:number,height:number}>} [attachments] -
   *   Content-addressed asset references (uploaded images) to store on the user item.
   */
  sendMessage(conversationId, text, threadItemId, attachments) {
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
    this.sendToWorker(conversationId, { type: 'send-message', text, threadItemId: threadItemId || undefined, attachments: refs });
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
   */
  cancel(conversationId) {
    this.sendToWorker(conversationId, { type: 'cancel' });
  }

  /**
   * Request a polite stop (Pause): let the current step finish and record its
   * real result, then rest at idle before the next LLM turn. Non-destructive —
   * the worker latches this and cancels nothing. Distinct WS message type so the
   * hot mid-turn wait-loop selects can branch on Type without parsing a payload.
   * @param {string} conversationId - Conversation ID
   */
  pause(conversationId) {
    this.sendToWorker(conversationId, { type: 'pause' });
  }

  /**
   * Cancel a pending polite stop (Pause): clear the worker's pause latch so the
   * current turn continues to its next boundary instead of resting at idle. Sent
   * when the Pause button is toggled back off before the pause takes effect.
   * Symmetric to pause; a no-op on the worker if the latch was already consumed.
   * @param {string} conversationId - Conversation ID
   */
  unpause(conversationId) {
    this.sendToWorker(conversationId, { type: 'unpause' });
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
      this._pendingThreadRequests.set(requestId, {
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
   * Send a command to worker and wait for acknowledgment
   * @param {string} conversationId - Conversation ID
   * @param {{type: string, [key: string]: unknown}} message - Message to send (will have ackId added)
   * @param {number} [timeout=5000] - Timeout in ms
   * @returns {Promise<*>} Resolves with result from worker (if any)
   * @private
   */
  _sendWithAck(conversationId, message, timeout = 5000) {
    return new Promise((resolve, reject) => {
      // Salt the ackId with this instance id. The worker broadcasts its ack to
      // ALL registered clients (callbacks.broadcast), and _handleAck matches
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
   * Handle acknowledgment from worker
   * @param {string} ackId - Acknowledgment ID
   * @param {*} [result] - Optional result from worker
   * @private
   */
  _handleAck(ackId, result) {
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
   */
  repositionContextItemPlaceholder(conversationId, itemId) {
    protocols.repositionContextItemPlaceholder(this, conversationId, itemId);
  }

  /**
   * Check if a worker exists for a conversation
   * @param {string} conversationId - Conversation ID
   * @returns {boolean} True if worker exists
   */
  hasWorker(conversationId) {
    return this._workers.has(conversationId);
  }

  /**
   * On WebSocket reconnect, ask every ready worker for the Yjs ops this client
   * missed while the socket was down — computed as the delta since each
   * conversation's current state vector. This is the cheap catch-up path:
   * applying a delta we already have is a Yjs no-op, and it avoids re-sending
   * full document state (or reloading the page) on every transient link drop,
   * which is what made the remote tunnel burn gigabytes and stop updating.
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
   * Check if a worker is ready
   * @param {string} conversationId - Conversation ID
   * @returns {boolean} True if worker exists and is ready
   */
  isWorkerReady(conversationId) {
    const entry = this._workers.get(conversationId);
    return entry ? entry.ready : false;
  }

  /**
   * Resolve when the worker for the given conversation is ready.
   * Resolves immediately if already ready; otherwise queues onto the
   * existing readyCallbacks list so we get the first 'ready' message.
   * @param {string} conversationId - Conversation ID
   * @returns {Promise<void>}
   */
  whenReady(conversationId) {
    return new Promise((resolve, reject) => {
      const entry = this._workers.get(conversationId);
      if (!entry) {
        reject(new Error(`No worker for conversation ${conversationId}`));
        return;
      }
      if (entry.ready) {
        resolve();
        return;
      }
      entry.readyCallbacks.push(() => resolve());
    });
  }


  /**
   * Handle message from worker
   * @param {string} conversationId - Conversation ID
   * @param {WorkerMessage} data - Message data
   * @private
   */
  _handleWorkerMessage(conversationId, data) {
    const entry = this._workers.get(conversationId);

    switch (data.type) {
      case 'ready':
        // The worker owns the canonical summarization prompt and ships it with
        // every "ready" (server-wide constant, independent of this entry).
        if (data.summarizationPrompt) {
          setBootstrapSummarizationPrompt(data.summarizationPrompt);
        }
        if (entry) {
          // If this entry was spawned with loadFromDisk:true, a ready message
          // without metadata came from another client's init (e.g. the viewer
          // creating a new conversation). Ignore it — the metadata-bearing ready
          // (sent by the Go worker in response to OUR loadFromDisk init) will
          // arrive shortly.
          if (entry.loadFromDisk && !data.metadata) {
            break;
          }
          entry.ready = true;
          // Store metadata if provided (for loadExistingConversation flow)
          entry.metadata = data.metadata || null;
          for (const callback of entry.readyCallbacks) {
            callback(entry.metadata);
          }
          entry.readyCallbacks = [];

          // Activate bidirectional sync. Skip the initial state broadcast
          // for load-from-disk: the worker already has the full state
          // and encoding+broadcasting it back blocks the main thread
          // for hundreds of ms on large docs. New conversations have
          // local additions that still need the broadcast.
          if (this._session) {
            const conversation = this._session.conversations.get(conversationId);
            if (conversation) {
              conversation.activateYjsSync({ broadcastInitialState: !entry.loadFromDisk });
            }
          }
        }
        break;

      case 'yjs-sync': {
        // Handle Yjs sync messages from worker
        // Unified sync protocol - all sync goes through YjsConversationSync
        if (!data.bytes) {
          console.warn(`[WorkerManager] Missing bytes for yjs-sync`);
          break;
        }
        const conversation = this._session?.conversations.get(conversationId);
        if (!conversation) {
          // Auto-load is engine-only: the engine is the single execution
          // place — it needs every conversation loaded so it can execute
          // tools and run worker-dispatched strategy hooks regardless of which
          // viewer created the conv. Viewers must NOT auto-load: a viewer
          // shows only the conversations the user explicitly opened and runs no
          // session-wide flow, so loading siblings' convs would be pure waste.
          if (isEngine()) {
            this._autoLoadConversation(conversationId, /** @type {string} */ (/** @type {unknown} */ (data.bytes)));
          }
          break;
        }
        // data.bytes is base64-encoded from Go's JSON marshaling of []byte
        const bytes = base64ToBytes(/** @type {string} */ (/** @type {unknown} */ (data.bytes)));
        conversation.handleYjsSyncMessage(bytes);
        break;
      }

      case 'render-context-items-request':
        // Engine-only; runs async (ensures the conversation is loaded before
        // rendering, mirroring the tool/strategy command handlers). Guard the
        // promise so a load failure surfaces instead of an unhandled rejection.
        protocols.handleRenderContextItemsRequest(this, conversationId, data).catch((err) => {
          console.error('[WorkerManager] render-context-items-request failed:', err);
        });
        break;

      case 'request-tools':
        protocols.handleRequestTools(this, conversationId, data);
        break;

      case 'build-subthread-spec':
        // Worker asks the engine to build a subthread spec for a delegating
        // tool call (engine-only). Runs async and self-replies; guard the
        // promise so a load failure surfaces instead of an unhandled rejection.
        protocols.handleBuildSubthreadSpec(this, conversationId, data).catch((err) => {
          console.error('[WorkerManager] build-subthread-spec failed:', err);
        });
        break;

      case 'subthread-error':
        // Worker asks the engine to run a delegating tool's onSubthreadError
        // fallback for an open-ended delegated child (engine-only).
        protocols.handleSubthreadError(this, conversationId, data).catch((err) => {
          console.error('[WorkerManager] subthread-error failed:', err);
        });
        break;

      case 'approval-request':
        protocols.handleApprovalRequest(this, conversationId, data);
        break;

      case 'run-strategy-hook':
        // Worker-driven strategy lifecycle hook (engine-only). Runs async and
        // self-replies; guard the promise so a viewer-role assertion or load
        // failure surfaces instead of becoming an unhandled rejection.
        protocols.handleRunStrategyHook(this, conversationId, data).catch((err) => {
          console.error('[WorkerManager] run-strategy-hook failed:', err);
        });
        break;

      case 'evaluate-tool': {
        // Worker-commanded tool evaluation (engine-only): run handleNewToolAction
        // for the given tool-action by id, then ack the outcome so the worker can
        // gate its dedup on a confirmation instead of fire-and-forget. A throw or
        // a no-op (could-not-act) acks ok=false so the worker re-drives.
        const toolUseId = /** @type {string} */ (data.toolUseId);
        protocols.handleEvaluateTool(this, conversationId, toolUseId)
          .then((ok) => protocols.sendToolCommandAck(this, conversationId, 'evaluate-tool', toolUseId, ok !== false))
          .catch((err) => {
            console.error('[WorkerManager] evaluate-tool failed:', err);
            protocols.sendToolCommandAck(this, conversationId, 'evaluate-tool', toolUseId, false);
          });
        break;
      }

      case 'execute-tool': {
        // Worker-commanded tool execution (engine-only): claim approved→running
        // and run the side effect for the given tool-action by id, then ack the
        // outcome. handleExecuteTool awaits execution, so an ok=true ack means the
        // tool ran to a terminal result; a throw or no-op acks ok=false to re-drive.
        const toolUseId = /** @type {string} */ (data.toolUseId);
        protocols.handleExecuteTool(this, conversationId, toolUseId)
          .then((ok) => protocols.sendToolCommandAck(this, conversationId, 'execute-tool', toolUseId, ok !== false))
          .catch((err) => {
            console.error('[WorkerManager] execute-tool failed:', err);
            protocols.sendToolCommandAck(this, conversationId, 'execute-tool', toolUseId, false);
          });
        break;
      }

      case 'cancel-tool':
        // Worker-commanded cancellation (engine-only): abort an in-flight
        // execution for the given tool-action by id.
        protocols.handleCancelTool(this, conversationId, /** @type {string} */ (data.toolUseId)).catch((err) => {
          console.error('[WorkerManager] cancel-tool failed:', err);
        });
        break;

      case 'cancel-strategy-execution': {
        // Worker cancelled — abort engine-driven strategy execution (plan
        // driver) by firing the conversation's stop handlers.
        const sec = this._session?.conversations.get(conversationId);
        sec?.cancelStrategyExecution?.();
        break;
      }

      case 'create-thread-response': {
        const requestId = /** @type {string} */ (data.requestId);
        const pending = this._pendingThreadRequests.get(requestId);
        if (pending) {
          this._pendingThreadRequests.delete(requestId);
          if (data.error) {
            const err = new Error(/** @type {string} */ (data.error));
            if (data.cancelled) {
              err.name = 'AbortError';
            }
            pending.reject(err);
          } else {
            pending.resolve({
              threadItemId: /** @type {string} */ (/** @type {any} */ (data).threadItemId),
              result: /** @type {string} */ (data.result)
            });
          }
        }
        break;
      }

      case 'error':
        // Just log error - conversation will handle via Yjs state
        console.error(`[WorkerManager] Worker error for ${conversationId}:`, data.message, data.stack);
        break;

      case 'validation-error': {
        // Show validation error in input box warning
        if (!data.message) {
          break;
        }
        const validationConv = /** @type {!import('../model/session.js').default} */ (this._session).conversations.get(conversationId);
        if (!validationConv) {
          console.warn(`[WorkerManager] No conversation found for ${conversationId}`);
          break;
        }
        validationConv.showWarning(data.message);
        validationConv.restorePendingMessage();
        break;
      }

      case 'status':
        // Processing state syncs via Yjs metadata (doc.metadata.processingState),
        // which LLMState observes directly — nothing to handle here.
        break;

      case 'ack':
        // Handle command acknowledgment
        if (data.ackId) {
          this._handleAck(data.ackId, data.result);
        }
        break;

      case 'undo-state':
        // Undo state syncs via Yjs metadata (doc.metadata.undoState), which UI
        // components observe directly — nothing to handle here.
        break;

      case 'save-error':
        // Worker failed to save - log the error
        console.error(`[WorkerManager] Save failed for ${conversationId}:`, data.error);
        break;

      default:
        // Ignore debug messages (debug-init-received, etc.) in production
        if (!data.type?.startsWith('debug-')) {
          console.warn(`[WorkerManager] Unknown message from worker ${conversationId}:`, data.type);
        }
    }
  }

  // ========== UNDO/REDO OPERATIONS ==========

  /**
   * Undo the last operation
   * @param {string} conversationId - Conversation ID
   * @returns {Promise<boolean>} True if undo was successful
   */
  async undo(conversationId) {
    return await this._sendWithAck(conversationId, { type: 'undo' });
  }

  /**
   * Redo the last undone operation
   * @param {string} conversationId - Conversation ID
   * @returns {Promise<boolean>} True if redo was successful
   */
  async redo(conversationId) {
    return await this._sendWithAck(conversationId, { type: 'redo' });
  }

  /**
   * Clear undo/redo stacks (for testing purposes)
   * @param {string} conversationId - Conversation ID
   * @returns {Promise<boolean>} True when complete
   */
  async clearUndoStacks(conversationId) {
    // Test-only setup call; patient like ping() — a loaded pool can hold the
    // worker's inbound queue past the default 5s without anything being wrong.
    return await this._sendWithAck(conversationId, { type: 'clear-undo-stacks' }, 15000);
  }

  /**
   * Reopen a completed thread by clearing its result field.
   * The operation is performed Go-side with authorID origin so it is undoable.
   * @param {string} conversationId - Conversation ID
   * @param {string} threadItemId - Thread item ID
   * @returns {Promise<boolean>} True if the thread was reopened
   */
  async reopenThread(conversationId, threadItemId) {
    return await this._sendWithAck(conversationId, { type: 'reopen-thread', threadItemId });
  }

  /**
   * Close an open thread by promoting its trailing assistant message as the
   * result — the cheap, no-LLM-turn close. Performed Go-side with authorID
   * origin so it is undoable.
   * @param {string} conversationId - Conversation ID
   * @param {string} threadItemId - Thread item ID
   * @returns {Promise<boolean>} True if the thread was closed
   */
  async closeThreadWithLastMessage(conversationId, threadItemId) {
    return await this._sendWithAck(conversationId, { type: 'close-thread-with-last-message', threadItemId });
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
    const result = await this._sendWithAck(conversationId, {
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
    const result = await this._sendWithAck(conversationId, {
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

  /**
   * Test-only synchronization barrier. The ack returns only after the worker
   * has drained its inbound queue (every prior message processed, every
   * observer fired) AND flushed its outbound Yjs batcher. Resolves on the
   * next microtask so the main-thread Yjs observers triggered by that final
   * sync have a chance to run before the caller's next line.
   * @param {string} conversationId - Conversation ID
   * @returns {Promise<void>}
   */
  async ping(conversationId) {
    // Patient timeout: the barrier legitimately takes as long as the worker's
    // inbound queue is deep — under the 9-lane test pool a heavy undo storm
    // can push a full drain past the default 5s. The per-test hard timeout
    // remains the fail-fast bound for a genuinely wedged worker.
    await this._sendWithAck(conversationId, { type: 'ping' }, 30000);
    await Promise.resolve();
  }

  // ============================================================================
  // Test Harness Methods
  // ============================================================================

  /**
   * Test-only: force the worker to persist its conversation state to disk now,
   * bypassing the SaveDebounceTime debounce, and resolve once the write has
   * completed (the worker acks after saveStateToDisk returns). Lets persistence
   * tests do a deterministic mutate → save → destroy → reload without sleeping
   * past the 2s debounce, which races the save on slow/contended CI runners.
   * @param {string} conversationId - Conversation ID
   * @returns {Promise<void>}
   */
  async flushPersistence(conversationId) {
    // Patient like ping(): a loaded pool can push the save behind a deep inbound
    // queue. The per-test hard timeout remains the fail-fast bound.
    await this._sendWithAck(conversationId, { type: 'flush-persistence' }, 30000);
  }

  /**
   * Set mock LLM responses for testing.
   * When set, the worker's callLLM() will return these responses instead of calling real LLM.
   * @param {string} conversationId - Conversation ID
   * @param {Array<{blocks: Array<{type: string, content?: string, text?: string, thinking?: string, toolUseId?: string, toolName?: string, toolInput?: object}>, stopReason: string, inputTokens?: number, outputTokens?: number}>} responses - Mock responses to inject
   * @returns {Promise<void>}
   */
  async setMockResponses(conversationId, responses) {
    recordTape('mock-llm', conversationId, { action: 'set', count: responses.length });
    // Use _sendWithAck to ensure worker receives and processes mock responses
    // before tests start sending messages
    await this._sendWithAck(conversationId, {
      type: 'set-mock-responses',
      responses
    }, 5000);
  }

  /**
   * Release a paused mock response. Worker uses MockResponse.PauseBeforeReturn
   * to hold a response between streaming and return — this releases that hold.
   * Idempotent: extra releases are coalesced by the worker's buffered channel.
   * @param {string} conversationId - Conversation ID
   * @returns {void}
   */
  releaseMock(conversationId) {
    this.sendToWorker(conversationId, { type: 'release-mock' });
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
   * into one. Awaited by the caller so the marker is on the wire before the
   * bracketed mutations' yjs-sync frames (same ordered channel), guaranteeing
   * the snapshot reflects state before the first write.
   * @param {string} conversationId - Conversation ID
   * @returns {Promise<void>}
   */
  async beginUndoCoalescing(conversationId) {
    await this.sendToWorker(conversationId, { type: 'begin-undo-coalesce' });
  }

  /**
   * Close the undo-coalescing bracket: collapse every undo group added since
   * {@link beginUndoCoalescing} into a single group, so the bracketed operation
   * reverts in one undo. Ack'd so the caller can await the merge completing.
   * @param {string} conversationId - Conversation ID
   * @returns {Promise<boolean>} Resolves when the worker has merged the groups
   */
  async endUndoCoalescing(conversationId) {
    return await this._sendWithAck(conversationId, { type: 'end-undo-coalesce' });
  }

  /**
   * Simulate WebSocket disconnection for testing.
   * Temporarily closes the WebSocket connection to test reconnection handling.
   * @param {string} _conversationId - Conversation ID (unused, disconnect is global)
   * @returns {Promise<void>}
   */
  async simulateDisconnect(_conversationId) {
    // Signal WebSocket service to disconnect
    await wsService.simulateDisconnect();
  }

  /**
   * Trigger WebSocket reconnection for testing.
   * Re-establishes connection after simulateDisconnect().
   * @param {string} _conversationId - Conversation ID (unused, reconnect is global)
   * @returns {Promise<void>}
   */
  async reconnect(_conversationId) {
    // Signal WebSocket service to reconnect
    await wsService.reconnect();
  }

  // ============================================================================
  // Lifecycle Management (Promise-Based)
  // ============================================================================

  /**
   * Wait for worker to be ready
   * @param {string} conversationId - Conversation ID
   * @param {number} [timeoutMs=WORKER_READY_TIMEOUT_MS] - Timeout in milliseconds
   * @returns {Promise<object|null>} Metadata from ready message (null for new conversations)
   * @private
   */
  async _waitForWorkerReady(conversationId, timeoutMs = WORKER_READY_TIMEOUT_MS) {
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
    });
  }

  /**
   * Create a brand new conversation with no prior state on disk.
   * Caller must already have allocated the id and final name via
   * `POST /api/conversations` (the server creates the on-disk folder
   * with the canonical name before this is called). Returns a fully
   * initialized conversation with worker ready.
   * @param {string} id - Server-allocated conversation id
   * @param {string} name - Server-canonical conversation name (folder name on disk)
   * @param {import('../model/session.js').default} session - Parent session
   * @returns {Promise<import('../model/conversation.js').default>} Fully initialized conversation
   */
  async createNewConversation(id, name, session) {
    const Conversation = (await import('../model/conversation.js')).default;

    // Check if already creating (lock via in-flight promise)
    const existingPromise = this._creating.get(id);
    if (existingPromise) {
      console.warn(`[WorkerManager] Duplicate create for ${id} - waiting for in-flight`);
      return await existingPromise;
    }

    // Start creation (atomic)
    const promise = this._doCreateNew(name, session, id, Conversation);
    this._creating.set(id, promise);

    try {
      const conversation = await promise;
      return conversation;
    } finally {
      this._creating.delete(id);
    }
  }

  /**
   * Internal implementation of new conversation creation
   * @param {string} name - Conversation name
   * @param {import('../model/session.js').default} session - Parent session
   * @param {string} id - Generated conversation ID
   * @param {typeof import('../model/conversation.js').default} Conversation - Conversation class
   * @returns {Promise<import('../model/conversation.js').default>} Fully initialized conversation
   * @private
   */
  async _doCreateNew(name, session, id, Conversation) {
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
      const conversation = new Conversation(id, name, session, /** @type {import('../model/session.js').ConversationServices} */ (services), { skipBuiltInContextItems: true });

      // CRITICAL: Add to session BEFORE spawning worker. Worker sends yjs-sync
      // messages immediately and the message handler needs to find the
      // conversation. Insert at the TOP (mutating in place so callers holding
      // a reference to session.conversations stay valid) — any render that
      // fires while the worker is still spawning (broadcast echo, etc.) then
      // sees the new tab in its final position rather than briefly painting
      // it at the end of the bar.
      const existingEntries = Array.from(session.conversations.entries());
      session.conversations.clear();
      session.conversations.set(id, conversation);
      for (const [cid, c] of existingEntries) {
        if (cid !== id) session.conversations.set(cid, c);
      }

      // 2. Spawn worker with full metadata (LoadFromDisk: false)
      const workerInit = conversation.getWorkerInitData();
      const initData = {
        id: conversation.id,
        name: conversation.name,
        created: conversation.created,
        modelConfig: workerInit.modelConfig,
        currentStrategyId: workerInit.currentStrategyId,
        permissionRules: workerInit.permissionRules,
        allowedPaths: workerInit.allowedPaths,
        loadFromDisk: false  // New conversation - don't load from disk
      };
      await this._spawnWorker(conversation.id, initData);

      // 3. Wait for ready (no metadata expected). The worker has now flushed
      // its initial yjs-sync (with the items Y.Array creation), so the
      // browser doc's items reference is the worker's array.
      await this._waitForWorkerReady(conversation.id);

      // Browser-side sync application is batched on a timer, and under load
      // the worker's initial yjs-sync (which CREATES root["items"]) can still
      // be in flight when _waitForWorkerReady resolves — 'ready' is sent after
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
      conversation.rootMessageThread.ensureSystemPromptPlaceholder();

      return conversation;
    } catch (error) {
      console.error(`[WorkerManager] Failed to create conversation ${id}:`, error);
      this.terminate(id);
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
   * hang conversation creation; on timeout the caller falls through to the old
   * behaviour (ensureSystemPromptPlaceholder creates the array), which is no
   * worse than before this wait existed.
   * @param {import('../model/conversation.js').default} conversation
   * @param {number} [timeoutMs=2000] - Max time to wait for the array to sync.
   * @returns {Promise<boolean>} True once the items array is present, false on timeout.
   * @private
   */
  async _waitForItemsArray(conversation, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    conversation._doc.flushPendingUpdates();
    while (!conversation._doc.root.get('items')) {
      if (Date.now() >= deadline) {
        console.warn(`[WorkerManager] items array not synced within ${timeoutMs}ms for ${conversation.id}; SYSTEM_1 may create a local array`);
        return false;
      }
      await new Promise(r => setTimeout(r, 10));
      conversation._doc.flushPendingUpdates();
    }
    return true;
  }

  /**
   * Load an existing conversation from disk using its ID.
   * Backend extracts metadata from the .yjs file and sends it in the ready message.
   * @param {string} conversationId - Conversation ID
   * @param {import('../model/session.js').default} session - Parent session
   * @returns {Promise<import('../model/conversation.js').default>} Fully initialized conversation
   */
  async loadExistingConversation(conversationId, session) {
    const Conversation = (await import('../model/conversation.js')).default;

    // Check if already loading (lock via in-flight promise)
    const existingPromise = this._creating.get(conversationId);
    if (existingPromise) {
      console.warn(`[WorkerManager] Duplicate load for ${conversationId} - waiting for in-flight`);
      return await existingPromise;
    }

    const promise = this._doLoadExisting(conversationId, session, Conversation);
    this._creating.set(conversationId, promise);

    try {
      const conversation = await promise;
      return conversation;
    } finally {
      this._creating.delete(conversationId);
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
        // Must be in session.conversations before _spawnWorker — yjs-sync
        // messages from the worker arrive immediately and need to find it.
        session.conversations.set(conversationId, conversation);
      }

      // 3. Spawn worker with LoadFromDisk flag
      const initData = {
        id: conversationId,
        loadFromDisk: true  // Backend will load from disk and send metadata
      };
      await this._spawnWorker(conversationId, initData);

      // 4. Wait for ready and get metadata from backend
      const metadata = await this._waitForWorkerReady(conversationId);
      if (!metadata) {
        throw new Error(`Worker did not provide metadata for existing conversation ${conversationId}`);
      }

      // 5. Populate stub with metadata (properties are mutable). The name
      // lives on the on-disk folder name now, populated when the manifest
      // was loaded — don't overwrite it from worker metadata.
      const metadataObj = /** @type {{ created?: string; defaultModelConfig?: any; currentStrategyId?: string }} */ (metadata);
      const defaultModelConfig = metadataObj.defaultModelConfig ?? null;
      conversation.created = metadataObj.created || new Date().toISOString();
      conversation.restoreWorkerMetadata({
        modelConfig: defaultModelConfig,
        currentStrategyId: metadataObj.currentStrategyId || 'default'
      });

      // Fetch context window if model is set (fire-and-forget, matches fromJSON behavior)
      if (defaultModelConfig) {
        // Use ensureContextWindow which internally calls _fetchContextWindow
        conversation.ensureContextWindow();
      }

      // Note: Permissions come from worker Yjs sync, no need to set here

      // Browser-side sync application is batched on a 50ms timer; the worker's
      // initial yjs-sync (with the loaded items array and all messages) may
      // have arrived but not yet been applied. Flush so callers that read
      // conv.rootItems immediately after this call see the synced state.
      conversation._doc.flushPendingUpdates();

      // 6. Activate Yjs sync. All yjs-sync was captured from the start, so the
      // doc is already complete here.
      conversation.activateYjsSync();

      // Cover callers that bypass the load queue (clone, refreshFromServer).
      if (conversation.loadState !== 'loaded') {
        conversation.setLoadState('loaded');
      }

      return conversation;
    } catch (error) {
      console.error(`[WorkerManager] Failed to load conversation ${conversationId}:`, error);
      // Keep the stub in session.conversations with loadState=error so the
      // panel can render a retry affordance and the next reload retries.
      // Dropping it instead would lose the conversation permanently.
      const stub = session.conversations.get(conversationId);
      if (stub && stub.loadState !== 'error') stub.setLoadState('error');
      this.terminate(conversationId);
      throw error;
    }
  }

  /**
   * Spawn a worker for a conversation (internal helper)
   * @param {string} conversationId - Conversation ID
   * @param {{loadFromDisk?: boolean, [key: string]: unknown}} serializedConversation - Serialized conversation data
   * @returns {Promise<void>} Resolves when init message is sent
   * @private
   */
  async _spawnWorker(conversationId, serializedConversation) {
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

  /**
   * Destroy conversation and terminate worker (atomic operation)
   * Enforces proper cleanup order: stop operations → destroy resources → terminate worker
   * @param {import('../model/conversation.js').default} conversation - Conversation to destroy
   * @returns {Promise<void>}
   */
  async destroyConversationAndWorker(conversation) {
    const conversationId = conversation.id;

    try {
      // 1. Destroy conversation resources (this also stops active operations)
      //    Conversation.destroy() calls llmState.stop() and cancelPendingApprovals()
      conversation.destroy();

      // 2. Terminate worker
      this.terminate(conversationId);
    } catch (error) {
      console.error(`[WorkerManager] Error destroying ${conversationId}:`, error);
      // Still terminate worker even if conversation cleanup failed
      this.terminate(conversationId);
      throw error;
    }
  }

  /**
   * Auto-load a conversation that the engine doesn't know about yet.
   * Queues yjs-sync bytes and applies them after load completes.
   * Deduplicates concurrent loads for the same conversation.
   * @param {string} conversationId - Conversation to load
   * @param {string} base64Bytes - Base64-encoded yjs-sync bytes to queue
   * @private
   */
  _autoLoadConversation(conversationId, base64Bytes) {
    // Skip internal conversations
    if (conversationId.startsWith('_internal:')) return;

    const existing = this._pendingAutoLoads.get(conversationId);
    if (existing) {
      // Load already in flight — just queue the bytes
      existing.queuedBytes.push(base64Bytes);
      return;
    }

    /** @type {string[]} */
    const queuedBytes = [base64Bytes];

    const promise = (async () => {
      try {
        if (!this._session) return;
        console.log(`[WorkerManager] Auto-loading unknown conversation ${conversationId}`);
        const conversation = await this.loadExistingConversation(conversationId, this._session);

        // Apply all queued yjs-sync updates
        for (const b64 of queuedBytes) {
          conversation.handleYjsSyncMessage(base64ToBytes(b64));
        }
      } catch (err) {
        console.error(`[WorkerManager] Failed to auto-load conversation ${conversationId}:`, err);
        // The engine's console is invisible in headless runs, and a repeated
        // auto-load failure means no tool execution for the conversation —
        // worth a server-side trace. The endpoint only exists in test mode, so
        // gate the call behind the test flag rather than firing a request that
        // 404s in production (over the studio tunnel that 404 is a visible
        // console line). Fire-and-forget.
        if (/** @type {any} */ (globalThis).JUGGLER_TEST_MODE) {
          fetch('/api/test/debug-log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              where: 'engine-auto-load-failed',
              conversationId,
              error: extractErrorMessage(err)
            })
          }).catch(() => {});
        }
        // The first failure is usually a race: the worker's first-init
        // 'ready' (triggered by whichever client booted the worker) lands in
        // our entry before the worker has processed *our* init, so we get a
        // ready without metadata. Drop the stub so the next yjs-sync
        // re-triggers autoload — by then the worker is initialized and our
        // init takes the "Client attached" path with metadata.
        if (this._session) this._session.conversations.delete(conversationId);
      } finally {
        this._pendingAutoLoads.delete(conversationId);
      }
    })();

    this._pendingAutoLoads.set(conversationId, { promise, queuedBytes });
  }
}

// Singleton instance
const workerManager = new WorkerManager();

export default workerManager;
