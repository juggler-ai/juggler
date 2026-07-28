//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { StatusMessageBuilder } from './status-message-builder.js';

// The elapsed-time ticker uses requestAnimationFrame in the viewer. The engine
// worker has no rAF, so fall back to a timer there — it only needs ~1Hz updates.
const requestFrame = typeof requestAnimationFrame === 'function'
  ? (/** @type {FrameRequestCallback} */ cb) => requestAnimationFrame(cb)
  : (/** @type {FrameRequestCallback} */ cb) => setTimeout(() => cb(Date.now()), 250);
const cancelFrame = typeof cancelAnimationFrame === 'function'
  ? (/** @type {number} */ id) => cancelAnimationFrame(id)
  : (/** @type {number} */ id) => clearTimeout(id);

/**
 * @typedef {object} StatusData
 * @property {string} type - Status type (streaming, preparing, waiting, processing_tools, executing_action, retry, error, cancelled, uploading, custom)
 * @property {number} [inputTokens] - Tokens sent to LLM
 * @property {number} [outputTokens] - Tokens received from LLM
 * @property {number} [cachedTokens] - Prompt tokens served from cache (OpenAI)
 * @property {number} [attempt] - Current retry attempt
 * @property {number} [maxRetries] - Maximum retry attempts
 * @property {string} [reason] - Reason for retry
 * @property {string} [message] - Error or custom message
 * @property {number} [payloadSize] - Payload size in bytes (for uploading status)
 * @property {string} [phase] - Provider-emitted phase label shown before the first token (e.g. "Starting Claude Code")
 * @property {number} [startTime] - Start time in milliseconds (for elapsed time calculation)
 * @property {number} [elapsedTime] - Elapsed time in milliseconds (calculated from startTime)
 */

/**
 * LLMState - Centralized state management for LLM loop
 *
 * Manages processing state and UI updates for LLM conversations.
 * Per-conversation tab tracking ensures each conversation's UI updates independently.
 *
 * Note: Iteration limits are enforced by Strategy plugins.
 */
class LLMState {
  constructor() {
    /** @type {Map<string, HTMLElement>} @private Map of conversationId -> conversation-tab element */
    this._conversationTabs = new Map();

    /**
     * Status messages are THE source of truth for processing state.
     * If a conversation has a message, it's processing. If not, it's not.
     * This makes it structurally impossible to show a spinner without a message.
     * @type {Map<string, string>} @private Map of conversationId -> status message
     */
    this._statusMessages = new Map();

    /** @type {Map<string, StatusData>} @private Map of conversationId -> current status data */
    this._statusData = new Map();

    /** @type {Map<string, number>} @private Map of conversationId -> animation frame ID for elapsed time updates */
    this._animationFrames = new Map();

    /** @type {Map<string, number>} @private Map of conversationId -> last activity timestamp */
    this._lastActivityTime = new Map();

    /** @type {Map<string, (event: any) => void>} @private Map of conversationId -> Yjs metadata observer */
    this._metadataObservers = new Map();

    /** @type {Map<string, import('../model/conversation.js').default>} @private Map of conversationId -> conversation instance */
    this._conversations = new Map();

    /** @type {Map<string, string|null>} @private Map of conversationId -> threadItemId the current status targets (null = root) */
    this._statusThreadIds = new Map();

    /** @type {Set<(conversationId: string) => void>} @private Observers notified whenever a conversation's processing state changes */
    this._statusObservers = new Set();
  }

  /**
   * Subscribe to per-conversation status changes (start/stop/reset/updateStatus).
   * The callback fires with the conversationId whose state changed; query
   * isConversationProcessing() to read the new state.
   * @param {(conversationId: string) => void} fn
   * @returns {() => void} Unsubscribe function
   */
  addStatusObserver(fn) {
    this._statusObservers.add(fn);
    return () => this._statusObservers.delete(fn);
  }

  /**
   * Register a conversation tab for UI updates
   * Sets up Yjs metadata observer for processing state
   * @param {string} conversationId - Conversation ID
   * @param {HTMLElement} tabElement - The conversation-tab element
   */
  registerConversationTab(conversationId, tabElement) {
    this._conversationTabs.set(conversationId, tabElement);

    // Get conversation instance from tab
    // @ts-ignore - _conversation is on conversation-tab
    const conversation = tabElement._conversation;
    if (conversation) {
      this._setupMetadataObserver(conversationId, conversation);
    }
  }

  /**
   * Unregister a conversation tab
   * Cleans up Yjs metadata observer
   * @param {string} conversationId - Conversation ID
   */
  unregisterConversationTab(conversationId) {
    this._conversationTabs.delete(conversationId);
    this._cleanupMetadataObserver(conversationId);
  }

  /**
   * Get conversation area for a specific conversation
   * @param {string} conversationId - Conversation ID
   * @returns {HTMLElement|null} The conversation area element or null if not found
   * @private
   */
  _getConversationArea(conversationId) {
    const tab = this._conversationTabs.get(conversationId);
    if (!tab) {
      return null;
    }
    // @ts-ignore - getConversationArea is a method on conversation-tab
    return tab.getConversationArea();
  }

  /**
   * Get whether LLM is currently active (any conversation processing)
   * @returns {boolean} True if any conversation is currently processing
   */
  get isActive() {
    return this._statusMessages.size > 0;
  }

  /**
   * Get the current status message for a conversation.
   * @param {string} conversationId - Conversation ID
   * @returns {string} The status message, or empty string if not processing
   */
  getStatusMessage(conversationId) {
    const message = this._statusMessages.get(conversationId) || '';
    if (!message) return '';
    // Render seam: status strings are stored unadorned. Error/cancelled are
    // terminal notices and render verbatim; every other status is a live
    // in-progress label and gets the single trailing busy marker here — the one
    // place the ellipsis is added.
    const type = this._statusData.get(conversationId)?.type;
    if (type === 'error' || type === 'cancelled') return message;
    return StatusMessageBuilder.withBusyMarker(message);
  }

  /**
   * Get the thread item ID that the current status targets.
   * @param {string} conversationId - Conversation ID
   * @returns {string|null} The thread item ID, or null if status targets root
   */
  getStatusThreadId(conversationId) {
    return this._statusThreadIds.get(conversationId) ?? null;
  }

  /**
   * Live per-step input usage for the in-flight turn, or null.
   *
   * Returns the running prompt-token total the worker has stamped into the Yjs
   * processingState (input plus its cached portion) while the conversation is
   * processing and at least one usage chunk has arrived. Callers that want a
   * meter to grow through the turn read this; it is null when the conversation
   * is idle or before the provider has reported any usage. Only meaningful for
   * models whose provider sets streamsLiveUsage — other providers may report a
   * number here that isn't fit for the context meter, so gate on that flag.
   * @param {string} conversationId - Conversation ID
   * @returns {{inputTokens: number, cachedTokens: number}|null} Live usage, or null when idle or no usage reported yet.
   */
  getLiveInputUsage(conversationId) {
    if (!this.isConversationProcessing(conversationId)) return null;
    const data = this._statusData.get(conversationId);
    const inputTokens = data?.inputTokens;
    if (typeof inputTokens !== 'number' || inputTokens <= 0) return null;
    const cached = data?.cachedTokens;
    return {
      inputTokens,
      cachedTokens: typeof cached === 'number' && cached > 0 ? cached : 0,
    };
  }

  /**
   * Start LLM processing for a specific conversation
   * - Sets status message (this IS the processing state)
   * - Shows busy indicator for this conversation's tab
   * - Adopts the worker's shared start time (or hides the digit when absent)
   * - Starts/restarts elapsed time timer
   * @param {string} conversationId - ID of conversation being processed
   * @param {number} [startedAt] - Backend Unix millis timestamp when processing began
   */
  start(conversationId, startedAt) {
    // Ensure statusData exists
    let statusData = this._statusData.get(conversationId);
    if (!statusData) {
      statusData = { type: 'preparing' };
      this._statusData.set(conversationId, statusData);
    }

    // startTime is ENTIRELY the worker's shared anchor — never a local clock.
    // The worker writes one `startedAt` into the doc's processingState
    // (cmd/juggler/worker/worker.go) so every client renders the same elapsed
    // digit, and it removes the field while a turn is parked on a human approval
    // (so the wait isn't counted). We mirror it verbatim: present → show
    // `now - startedAt`; absent → undefined → the formatter shows no digit. We
    // deliberately do NOT backfill Date.now() — a local fallback is exactly the
    // multi-client divergence this whole mechanism exists to prevent, and it
    // would also resurrect the digit during an approval wait.
    statusData.startTime = startedAt;

    // Start elapsed time timer (safe to call multiple times, clears existing first)
    this._startElapsedTimeTimer(conversationId);

    // Build and store status message - THIS is what makes isProcessing true
    const message = this._buildStatusMessage(statusData.type, statusData);
    this._statusMessages.set(conversationId, message);

    // Update UI
    this._notifyConversationArea(conversationId);
  }

  /**
   * Notify the conversation tab to sync layout and update footers.
   * Uses syncWithStatus() (Rule B: ensures the thread column opens before footer
   * updates fire, so the spinner appears in the correct column).
   * Falls back to updateAllFooters() for tabs without syncWithStatus().
   * @param {string} conversationId - Conversation ID
   * @private
   */
  _notifyConversationArea(conversationId) {
    const tab = this._conversationTabs.get(conversationId);
    if (tab) {
      if ('syncWithStatus' in tab) {
        const threadId = this.getStatusThreadId(conversationId);
        (/** @type {any} */ (tab)).syncWithStatus(threadId);
      } else if ('updateAllFooters' in tab) {
        (/** @type {any} */ (tab)).updateAllFooters();
      }
    }
    for (const fn of this._statusObservers) fn(conversationId);
  }

  /**
   * Stop LLM processing for a specific conversation
   * - Clears status message (this IS what stops processing)
   * - Hides busy indicator for this conversation's tab
   * - Cleans up status data for this conversation
   * - Stops elapsed time timer
   * @param {string} conversationId - ID of conversation that finished processing
   */
  stop(conversationId) {
    // Clear status message - THIS is what makes isProcessing false
    this._statusMessages.delete(conversationId);
    this._statusData.delete(conversationId);
    this._statusThreadIds.delete(conversationId);

    // Stop elapsed time timer
    this._stopElapsedTimeTimer(conversationId);

    // Update UI
    this._notifyConversationArea(conversationId);
  }

  /**
   * Check if a specific conversation is currently processing.
   * A conversation is processing if and only if it has a status message.
   * @param {string} conversationId - Conversation ID to check
   * @returns {boolean} True if the conversation is currently processing
   */
  isConversationProcessing(conversationId) {
    return !!this._statusMessages.get(conversationId);
  }

  /**
   * Update status for a conversation and update UI
   * @param {string} conversationId - Conversation ID
   * @param {string} statusType - Type of status (streaming, preparing, waiting, processing_tools, retry, error, cancelled, empty, uploading, custom)
   * @param {Partial<StatusData>} [data] - Additional status data
   */
  updateStatus(conversationId, statusType, data = {}) {
    // Runtime validation: 'custom' status requires a message
    if (statusType === 'custom' && !data.message) {
      throw new Error('LLMState.updateStatus: "custom" status requires data.message');
    }

    // Get existing status data for start time
    const existingStatusData = this._statusData.get(conversationId);
    const startTime = existingStatusData?.startTime;

    // Elapsed time, or undefined when there is no shared anchor (idle, or parked
    // on an approval — the worker removes startedAt in both cases). The formatter
    // omits the digit when this is undefined.
    const elapsedTime = startTime !== undefined ? Date.now() - startTime : undefined;

    // Token fields (input/output/cached) live in the Yjs processingState and
    // flow in via _handleProcessingStateChange. We preserve them across calls
    // that don't pass them — e.g. the rAF tick re-stamps elapsedTime every
    // second with otherwise-empty `data`, and would otherwise blank the
    // running token count between Yjs metadata writes. Only merged when the
    // statusType is unchanged; a transition (preparing→streaming, etc.)
    // resets tokens since the new phase starts with none.
    const sameStatus = existingStatusData?.type === statusType;
    const mergedInput = data.inputTokens !== undefined ? data.inputTokens : (sameStatus ? existingStatusData?.inputTokens : undefined);
    const mergedOutput = data.outputTokens !== undefined ? data.outputTokens : (sameStatus ? existingStatusData?.outputTokens : undefined);
    const mergedCached = data.cachedTokens !== undefined ? data.cachedTokens : (sameStatus ? existingStatusData?.cachedTokens : undefined);
    // Phase merges like the token counts: preserved across the rAF tick's
    // otherwise-empty `data`, reset on a status transition (a new phase starts
    // fresh) so a stale "Waiting…" can't linger into processing_tools.
    const mergedPhase = data.phase !== undefined ? data.phase : (sameStatus ? existingStatusData?.phase : undefined);

    /** @type {StatusData} */
    const statusData = {
      type: statusType,
      ...data,
      inputTokens: mergedInput,
      outputTokens: mergedOutput,
      cachedTokens: mergedCached,
      phase: mergedPhase,
      startTime: startTime,
      elapsedTime: elapsedTime
    };

    // Store status data
    this._statusData.set(conversationId, statusData);

    // Build and store status message - THIS is the source of truth
    const message = this._buildStatusMessage(statusType, statusData);
    this._statusMessages.set(conversationId, message);

    // Update UI
    this._notifyConversationArea(conversationId);
  }

  /**
   * Build status message from status type and data
   * @param {string} statusType - Status type
   * @param {StatusData} data - Status data
   * @returns {string} Human-readable status message for the UI
   * @private
   */
  _buildStatusMessage(statusType, data) {
    switch (statusType) {
      case 'streaming':
        return StatusMessageBuilder.buildStreamingStatus(data);
      case 'preparing':
        return StatusMessageBuilder.buildPreparingStatus(data);
      case 'waiting':
        return StatusMessageBuilder.buildWaitingStatus(data);
      case 'uploading':
        return StatusMessageBuilder.buildUploadingStatus((/** @type {any} */ (data)));
      case 'processing_tools':
        return StatusMessageBuilder.buildProcessingToolsStatus(data);
      case 'executing_action':
        return StatusMessageBuilder.buildExecutingActionStatus(data);
      case 'retry':
        return StatusMessageBuilder.buildRetryStatus((/** @type {any} */ (data)));
      case 'error':
        return StatusMessageBuilder.buildErrorStatus(data.message || 'Unknown error');
      case 'cancelled':
        return StatusMessageBuilder.buildCancelledStatus();
      case 'custom':
        // Runtime validation ensures message exists for 'custom' type
        return StatusMessageBuilder.buildCustomStatus(data.message || '', data);
      case 'empty':
        return StatusMessageBuilder.buildEmptyStatus();
      default:
        console.error(`[LLMState] Unknown status type: ${statusType}`);
        return '';
    }
  }

  /**
   * Start elapsed time animation for a conversation
   * Updates status approximately every second with current elapsed time using requestAnimationFrame
   * @param {string} conversationId - Conversation ID
   * @private
   */
  _startElapsedTimeTimer(conversationId) {
    // Clear any existing animation first
    this._stopElapsedTimeTimer(conversationId);

    // Update immediately
    this._updateElapsedTime(conversationId);

    // Start animation frame loop
    let lastTime = Date.now();

    const animate = () => {
      const now = Date.now();
      // Update approximately every second
      if (now - lastTime >= 1000) {
        this._updateElapsedTime(conversationId);
        lastTime = now;
      }

      // Continue only if still processing (has status message)
      if (this._statusMessages.has(conversationId)) {
        const frameId = requestFrame(animate);
        this._animationFrames.set(conversationId, frameId);
      }
    };

    const frameId = requestFrame(animate);
    this._animationFrames.set(conversationId, frameId);
  }

  /**
   * Stop elapsed time animation for a conversation
   * @param {string} conversationId - Conversation ID
   * @private
   */
  _stopElapsedTimeTimer(conversationId) {
    const frameId = this._animationFrames.get(conversationId);
    if (frameId !== undefined) {
      cancelFrame(frameId);
      this._animationFrames.delete(conversationId);
    }
  }

  /**
   * Update elapsed time for a conversation
   * Called by timer every second to update status display
   * @param {string} conversationId - Conversation ID
   * @private
   */
  _updateElapsedTime(conversationId) {
    // Only update if conversation is still processing (has status message)
    if (!this._statusMessages.has(conversationId)) {
      return;
    }

    const statusData = this._statusData.get(conversationId);
    if (!statusData) {
      return;
    }

    // Current elapsed time, or undefined when there is no shared anchor (the
    // worker removes startedAt at idle and while parked on an approval), so the
    // rAF tick shows no digit during an approval wait instead of counting it.
    const elapsedTime = statusData.startTime !== undefined
      ? Date.now() - statusData.startTime
      : undefined;

    // Update status with current elapsed time, preserving all existing fields
    this.updateStatus(conversationId, statusData.type, {
      inputTokens: statusData.inputTokens,
      outputTokens: statusData.outputTokens,
      cachedTokens: statusData.cachedTokens,
      phase: statusData.phase,
      elapsedTime: elapsedTime,
      // Preserve retry-specific fields
      attempt: statusData.attempt,
      maxRetries: statusData.maxRetries,
      reason: statusData.reason,
      // Preserve custom message (required for 'custom' status type)
      message: statusData.message
    });
  }

  /**
   * Setup Yjs metadata observer for a conversation
   * Observes processingState changes and updates UI reactively
   * @param {string} conversationId - Conversation ID
   * @param {import('../model/conversation.js').default} conversation - Conversation instance
   * @private
   */
  _setupMetadataObserver(conversationId, conversation) {
    // Clean up existing observer first
    this._cleanupMetadataObserver(conversationId);

    // Store conversation reference
    this._conversations.set(conversationId, conversation);

    // Create observer for processingState changes
    const observer = (/** @type {any} */ event) => {
      if (event.keysChanged.has('processingState')) {
        const state = conversation.getMetadata('processingState');
        this._handleProcessingStateChange(conversationId, state);
      }
    };

    // Register observer
    conversation.observeMetadata(observer);
    this._metadataObservers.set(conversationId, observer);

    // Read initial state
    const initialState = conversation.getMetadata('processingState');
    if (initialState) {
      this._handleProcessingStateChange(conversationId, initialState);
    }
  }

  /**
   * Cleanup Yjs metadata observer for a conversation
   * @param {string} conversationId - Conversation ID
   * @private
   */
  _cleanupMetadataObserver(conversationId) {
    const observer = this._metadataObservers.get(conversationId);
    const conversation = this._conversations.get(conversationId);

    if (observer && conversation) {
      conversation.unobserveMetadata(observer);
      this._metadataObservers.delete(conversationId);
    }

    this._conversations.delete(conversationId);
  }

  /**
   * Handle processing state change from Yjs metadata
   * @param {string} conversationId - Conversation ID
   * @param {{status: string, message?: string, code?: string, threadItemId?: string, startedAt?: number, inputTokens?: number, outputTokens?: number, cachedTokens?: number, phase?: string}|null} state - Processing state
   * @private
   */
  _handleProcessingStateChange(conversationId, state) {
    if (!state || !state.status) {
      // No state or invalid state - stop processing
      this.stop(conversationId);
      return;
    }

    const { status, message } = state;

    // Track which thread (if any) this status targets
    this._statusThreadIds.set(conversationId, state.threadItemId || null);

    // Pull running token counts off the Yjs state so every observing client
    // renders the same spinner text. The worker writes these into
    // processingState from the "progress" / "usage" stream chunks; before
    // they're set the fields are undefined and the formatter prints just
    // "Receiving" with no count.
    const tokenData = {
      inputTokens: typeof state.inputTokens === 'number' ? state.inputTokens : undefined,
      outputTokens: typeof state.outputTokens === 'number' ? state.outputTokens : undefined,
      cachedTokens: typeof state.cachedTokens === 'number' ? state.cachedTokens : undefined,
      // Provider phase label (cold-start progress); the worker writes it into
      // processingState from "status" stream chunks. Undefined until the
      // provider emits one — the formatter then falls back to "Receiving".
      phase: typeof state.phase === 'string' ? state.phase : undefined
    };

    // Map worker status to LLMState actions
    // Status values: preparing, streaming, idle, error, validation-error
    switch (status) {
      case 'preparing': {
        // A turn was accepted, so the model divergence (if any) is resolved —
        // clear Guard A's one-shot self-heal latch so a genuinely new divergence
        // much later can heal again rather than being suppressed forever.
        const conv = this._conversations.get(conversationId);
        if (conv) conv._modelSelfHealAttempted = false;
        this.start(conversationId, state.startedAt);
        this.updateStatus(conversationId, 'preparing', tokenData);
        break;
      }

      case 'streaming':
        this.start(conversationId, state.startedAt);
        this.updateStatus(conversationId, 'streaming', tokenData);
        break;

      case 'processing_tools':
        this.start(conversationId, state.startedAt);
        this.updateStatus(conversationId, 'processing_tools', tokenData);
        break;

      case 'retrying':
        this.start(conversationId, state.startedAt);
        this.updateStatus(conversationId, 'custom', { ...tokenData, message: state.message || 'Retrying' });
        break;

      case 'idle':
        // Processing complete - stop spinner
        this.stop(conversationId);
        break;

      case 'error':
        this.updateStatus(conversationId, 'error', { message: message || 'Unknown error' });
        break;

      case 'validation-error': {
        const conversation = this._conversations.get(conversationId);

        // Guard A — self-heal the "no-model" divergence. The worker's doc
        // resolved no model, yet this client is displaying a real one: the model
        // write never reached the worker (the outbound-sync gap — see
        // session.js). Re-broadcast our full doc state (which carries
        // defaultModelConfig) so the worker's doc gets the model, then resend the
        // pending message ONCE. A per-conversation latch prevents a loop if the
        // resend also bounces; it is cleared on the next accepted turn
        // ('preparing'). Ordering holds because the resync and the resend ride
        // the same FIFO worker channel, so the model lands before re-validation.
        if (conversation && state.code === 'no-model' && !conversation._modelSelfHealAttempted) {
          const cfg = conversation.modelConfig;
          const pending = conversation._pendingUserMessage;
          if (cfg && cfg.provider && cfg.model && pending) {
            conversation._modelSelfHealAttempted = true;
            conversation.resyncToWorker();
            conversation.resendToWorker(pending, state.threadItemId || null);
            this.stop(conversationId);
            break;
          }
        }

        // Not self-healable (no code match, no local model, nothing pending, or
        // the self-heal was already spent): surface the warning and restore the
        // user's text so they can act on it.
        if (conversation) {
          conversation.showWarning(message || 'Validation error');
          conversation.restorePendingMessage();
        }
        this.stop(conversationId);
        break;
      }

      default:
        console.warn(`[LLMState] Unknown status: ${status}`);
    }
  }
}

export default LLMState;
