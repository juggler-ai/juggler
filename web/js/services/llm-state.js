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
 * @property {string} [phase] - Provider-emitted retry, cache, or notice status
 * @property {string} [description] - Current provider activity snapshot
 * @property {number} [startTime] - Start time in milliseconds (for elapsed time calculation)
 * @property {number} [elapsedTime] - Elapsed time in milliseconds (calculated from startTime)
 */

/**
 * Quiet stretch after which an output-token count that has stopped advancing is
 * reported as no flow at all, rather than coasting on the last known rate.
 */
const THROUGHPUT_STALL_MS = 2000;

/**
 * Weight given to the newest observation in the throughput moving average.
 * Low, because provider chunks arrive lumpily and an unsmoothed rate is mostly
 * noise.
 */
const THROUGHPUT_SMOOTHING = 0.3;

/**
 * Key one thread's run by. The root thread has no item id, so it keys on the
 * empty string — the shape every caller already passes around for "the root
 * column" (`messageThread.threadItemId || null`).
 * @param {string|null|undefined} threadItemId
 * @returns {string} Thread key
 */
function threadKey(threadItemId) {
  return threadItemId || '';
}

/**
 * The runs a processingState frame describes, keyed by thread.
 *
 * `processingState.runs` is the source of truth — one entry per thread holding
 * an LLM claim (see model/SCHEMA.md). A frame carrying only the top-level
 * projection still describes exactly one run, on the thread its `threadItemId`
 * names, so synthesize that rather than reading the frame as idle. Mirrors the
 * worker's own `runsView` (cmd/juggler/worker/activity_state.go).
 * @param {any} state - processingState frame
 * @returns {Record<string, any>} Run frames keyed by thread key
 */
function runsView(state) {
  const runs = state?.runs;
  if (runs && typeof runs === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [key, entry] of Object.entries(runs)) {
      if (entry && typeof entry === 'object') {
        out[threadKey(/** @type {any} */ (entry).threadItemId ?? (key === 'root' ? '' : key))] = entry;
      }
    }
    return out;
  }
  if (!state?.activity) return {};
  return { [threadKey(state.threadItemId)]: state };
}

/**
 * LLMState - Centralized state management for LLM loop
 *
 * Manages processing state for LLM conversations, and announces every change
 * to its status observers ({@link addStatusObserver}). It holds no view: a tab
 * that paints a conversation's status subscribes to that conversation's feed
 * (`Conversation#onStatusChange`) and reads the state back from here.
 *
 * State is held per RUN — one conversation, one thread — because a conversation
 * can be driving several threads at once (a parent and its read-only children).
 * The conversation-wide getters answer "is anything running here", which is what
 * the tab badge, the busy barrier and the Escape ladder ask; the thread-scoped
 * getters answer "is THIS column running", which is what a spinner asks.
 *
 * Note: Iteration limits are enforced by Strategy plugins.
 */
class LLMState {
  constructor() {
    /**
     * Status messages are THE source of truth for processing state.
     * If a run has a message, that thread is processing. If not, it's not.
     * This makes it structurally impossible to show a spinner without a message.
     * @type {Map<string, Map<string, string>>} @private conversationId -> threadKey -> status message
     */
    this._statusMessages = new Map();

    /** @type {Map<string, Map<string, StatusData>>} @private conversationId -> threadKey -> current status data */
    this._statusData = new Map();

    /** @type {Map<string, number>} @private Map of conversationId -> animation frame ID for elapsed time updates */
    this._animationFrames = new Map();

    /** @type {Map<string, (event: any) => void>} @private Map of conversationId -> Yjs metadata observer */
    this._metadataObservers = new Map();

    /** @type {Map<string, import('../model/conversation.js').default>} @private Map of conversationId -> conversation instance */
    this._conversations = new Map();

    /**
     * Which run the conversation-wide getters answer for. Sticks to the thread
     * it named while that thread still holds a live run, so the projection's
     * churn between live siblings (the worker re-projects on every write) reads
     * as no change; it re-targets only when the named thread rests. With
     * several siblings live, two clients can hold different answers.
     * @type {Map<string, string|null>} @private conversationId -> threadItemId (null = root)
     */
    this._statusThreadIds = new Map();

    /** @type {Set<(conversationId: string) => void>} @private Observers notified whenever a conversation's processing state changes */
    this._statusObservers = new Set();

    /** @type {Map<string, Map<string, {tokens: number, at: number, rate: number}>>} @private conversationId -> threadKey -> last output-token sample and the rate derived from it */
    this._throughput = new Map();
  }

  /**
   * The per-thread map for a conversation, created on demand.
   * @template T
   * @param {Map<string, Map<string, T>>} store
   * @param {string} conversationId
   * @returns {Map<string, T>} The conversation's per-thread map
   * @private
   */
  _perThread(store, conversationId) {
    let byThread = store.get(conversationId);
    if (!byThread) {
      byThread = new Map();
      store.set(conversationId, byThread);
    }
    return byThread;
  }

  /**
   * The thread key the conversation-wide getters answer for.
   * @param {string} conversationId
   * @returns {string} Thread key of the projected run
   * @private
   */
  _projectedKey(conversationId) {
    return threadKey(this._statusThreadIds.get(conversationId));
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
   * Register a conversation: start the Yjs metadata observer that turns worker
   * processing-state frames into status.
   * @param {import('../model/conversation.js').default} conversation - The conversation.
   */
  registerConversation(conversation) {
    this._setupMetadataObserver(conversation.id, conversation);
  }

  /**
   * Unregister a conversation: tear down its Yjs metadata observer.
   * @param {string} conversationId - Conversation ID
   */
  unregisterConversation(conversationId) {
    this._cleanupMetadataObserver(conversationId);
  }

  /**
   * Get whether LLM is currently active (any conversation processing)
   * @returns {boolean} True if any conversation is currently processing
   */
  get isActive() {
    for (const byThread of this._statusMessages.values()) {
      if (byThread.size > 0) return true;
    }
    return false;
  }

  /**
   * The status message for the conversation's projected run — what a single
   * status line describing the whole conversation should say. A column asking
   * about its own thread wants getThreadStatusMessage instead.
   * @param {string} conversationId - Conversation ID
   * @returns {string} The status message, or empty string if not processing
   */
  getStatusMessage(conversationId) {
    return this.getThreadStatusMessage(conversationId, this._statusThreadIds.get(conversationId));
  }

  /**
   * The status message for ONE thread's run: what that column's spinner says,
   * elapsed digit and token counts included. Empty when that thread is not the
   * one running — a sibling being driven is not this thread's business.
   * @param {string} conversationId - Conversation ID
   * @param {string|null} [threadItemId] - Thread item id (null/omitted = root)
   * @returns {string} The status message, or empty string when this thread is idle
   */
  getThreadStatusMessage(conversationId, threadItemId) {
    const key = threadKey(threadItemId);
    const message = this._statusMessages.get(conversationId)?.get(key) || '';
    if (!message) return '';
    // Render seam: status strings are stored unadorned. Error/cancelled are
    // terminal notices and render verbatim; every other status is a live
    // in-progress label and gets the single trailing busy marker here — the one
    // place the ellipsis is added.
    const type = this._statusData.get(conversationId)?.get(key)?.type;
    if (type === 'error' || type === 'cancelled') return message;
    return StatusMessageBuilder.withBusyMarker(message);
  }

  /**
   * Every running thread's status line, keyed by thread item id ('' for root).
   * The snapshot a surface takes once and asks about several threads — a column
   * paints its own footer from it and its child tiles from the same object, so
   * a tile and the sub-thread's own footer always read identically.
   * @param {string} conversationId - Conversation ID
   * @returns {Record<string, string>} Status line per live thread; empty when nothing is running
   */
  getLiveThreadMessages(conversationId) {
    /** @type {Record<string, string>} */
    const out = {};
    for (const key of this._statusMessages.get(conversationId)?.keys() || []) {
      const message = this.getThreadStatusMessage(conversationId, key);
      if (message) out[key] = message;
    }
    return out;
  }

  /**
   * Get the thread item ID that the conversation's status is held on.
   * One answer for readers that can only act on one column — which column to
   * reveal, which run a bare Escape interrupts. Not "the only thread running".
   * Sticks to the thread it named while that thread still runs (see
   * _handleProcessingStateChange), so parallel siblings taking turns to write
   * frames do not move it; two windows can hold different answers while
   * several siblings run.
   * @param {string} conversationId - Conversation ID
   * @returns {string|null} The thread item ID, or null if status targets root
   */
  getStatusThreadId(conversationId) {
    return this._statusThreadIds.get(conversationId) ?? null;
  }

  /**
   * Live per-step input usage for ONE thread's in-flight turn, or null.
   *
   * Returns the running prompt-token total the worker has stamped into that
   * run's processingState entry (input plus its cached portion) while the
   * thread is being driven and at least one usage chunk has arrived. Callers
   * that want a meter to grow through the turn read this; it is null when the
   * thread is idle or before the provider has reported any usage. Per thread
   * because a context meter measures one transcript: a child's prompt is not
   * the parent's. Only meaningful for models whose provider sets
   * streamsLiveUsage — other providers may report a number here that isn't fit
   * for the context meter, so gate on that flag.
   *
   * The cached portion is null when the step carried no cache figure at all:
   * unknown, not a miss. A reported 0 comes back as 0.
   * @param {string} conversationId - Conversation ID
   * @param {string|null} [threadItemId] - Thread item id (null/omitted = root)
   * @returns {{inputTokens: number, cachedTokens: number|null}|null} Live usage, or null when idle or no usage reported yet.
   */
  getLiveInputUsage(conversationId, threadItemId) {
    const data = this._statusData.get(conversationId)?.get(threadKey(threadItemId));
    const inputTokens = data?.inputTokens;
    if (typeof inputTokens !== 'number' || inputTokens <= 0) return null;
    const cached = data?.cachedTokens;
    return {
      inputTokens,
      cachedTokens: typeof cached === 'number' && cached >= 0 ? cached : null,
    };
  }

  /**
   * How fast output is currently arriving, in tokens per second.
   *
   * Derived from the running `outputTokens` count the worker stamps into the
   * Yjs processingState: each write is a real observation, so the delta between
   * two of them over the elapsed wall time is a genuine rate rather than an
   * estimate. Smoothed across samples, because chunk sizes are lumpy and the
   * raw per-chunk rate swings wildly enough to be useless.
   *
   * Returns 0 whenever nothing is actually streaming — parked on a tool call,
   * preparing a request, waiting on the network, or simply idle. That zero is
   * the honest answer, not a placeholder: during a slow tool call no output IS
   * arriving. Callers should render it as "barely moving", never as "broken".
   * Asked of one thread: a column's spinner reports the flow into the run it is
   * showing, not the sum of everything the conversation happens to be doing.
   * @param {string} conversationId - Conversation ID
   * @param {string|null} [threadItemId] - Thread item id (null/omitted = root)
   * @returns {number} Tokens per second, or 0 when no output is flowing.
   */
  getThroughput(conversationId, threadItemId) {
    const key = threadKey(threadItemId);
    // Only the streaming phase carries token flow. Every other phase has a
    // legitimate reason to report nothing, and inferring a rate from a stale
    // sample would invent movement that isn't happening.
    if (this._statusData.get(conversationId)?.get(key)?.type !== 'streaming') return 0;
    const sample = this._throughput.get(conversationId)?.get(key);
    if (!sample) return 0;
    // A sample that has stopped advancing is a stall, not a held rate — decay
    // it to zero rather than coasting on the last good number.
    if (Date.now() - sample.at > THROUGHPUT_STALL_MS) return 0;
    return sample.rate;
  }

  /**
   * Fold one `outputTokens` observation into the conversation's rate estimate.
   *
   * Only advancing counts produce a sample: the elapsed-time ticker re-stamps
   * the status roughly once a second with the token fields preserved, and
   * treating those as observations would divide a zero delta by real time and
   * read every turn as a stall.
   * @param {string} conversationId - Conversation ID
   * @param {string} key - Thread key the sample belongs to
   * @param {number|undefined} outputTokens - Running output-token count, if reported.
   * @private
   */
  _sampleThroughput(conversationId, key, outputTokens) {
    if (typeof outputTokens !== 'number' || outputTokens < 0) return;
    const now = Date.now();
    const samples = this._perThread(this._throughput, conversationId);
    const prev = samples.get(key);
    // First sample of a turn, or a count that went backwards (a new turn reusing
    // the entry): anchor on it without emitting a rate.
    if (!prev || outputTokens < prev.tokens) {
      samples.set(key, { tokens: outputTokens, at: now, rate: 0 });
      return;
    }
    const dt = now - prev.at;
    const dTokens = outputTokens - prev.tokens;
    if (dTokens === 0 || dt <= 0) return;
    const instant = (dTokens / dt) * 1000;
    // Exponential moving average. Weighted towards history so the rate glides
    // between chunk arrivals instead of spiking with each one.
    const rate = prev.rate > 0
      ? prev.rate + THROUGHPUT_SMOOTHING * (instant - prev.rate)
      : instant;
    samples.set(key, { tokens: outputTokens, at: now, rate });
  }

  /**
   * Start LLM processing for a specific conversation
   * - Sets status message (this IS the processing state)
   * - Tells the status observers, so the tab showing it shows its spinner
   * - Adopts the worker's shared start time (or hides the digit when absent)
   * - Starts/restarts elapsed time timer
   * @param {string} conversationId - ID of conversation being processed
   * @param {number} [startedAt] - Backend Unix millis timestamp when processing began
   * @param {string|null} [threadItemId] - Thread being driven (null/omitted = root)
   */
  start(conversationId, startedAt, threadItemId) {
    const key = threadKey(threadItemId);
    const dataByThread = this._perThread(this._statusData, conversationId);
    // Ensure statusData exists
    let statusData = dataByThread.get(key);
    if (!statusData) {
      statusData = { type: 'preparing' };
      dataByThread.set(key, statusData);
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
    this._perThread(this._statusMessages, conversationId).set(key, message);

    // Tell the observers (the tab showing it among them)
    this._notifyStatusObservers(conversationId);
  }

  /**
   * Tell every status observer that a conversation's status changed. The tab
   * showing the conversation is one of them (see conversation-tab.js
   * `setConversation`), and it reads the new state back from here.
   * @param {string} conversationId - Conversation ID
   * @private
   */
  _notifyStatusObservers(conversationId) {
    for (const fn of this._statusObservers) fn(conversationId);
  }

  /**
   * Stop LLM processing for a specific conversation
   * - Clears status message (this IS what stops processing)
   * - Tells the status observers, so the tab showing it drops its spinner
   * - Cleans up status data for this conversation
   * - Stops elapsed time timer
   * @param {string} conversationId - ID of conversation that finished processing
   */
  stop(conversationId) {
    // Clear status message - THIS is what makes isProcessing false
    this._statusMessages.delete(conversationId);
    this._statusData.delete(conversationId);
    this._statusThreadIds.delete(conversationId);
    this._throughput.delete(conversationId);

    // Stop elapsed time timer
    this._stopElapsedTimeTimer(conversationId);

    // Tell the observers (the tab showing it among them)
    this._notifyStatusObservers(conversationId);
  }

  /**
   * Stop ONE thread's run, leaving its live siblings alone. A thread coming to
   * rest under a conversation still driving others is the ordinary case now, so
   * the whole-conversation `stop` is reserved for the paths that genuinely end
   * everything — a hard cancel, a destroy, a frame with nothing running at all.
   * @param {string} conversationId - Conversation ID
   * @param {string} key - Thread key that finished
   * @private
   */
  _stopThread(conversationId, key) {
    this._statusMessages.get(conversationId)?.delete(key);
    this._statusData.get(conversationId)?.delete(key);
    this._throughput.get(conversationId)?.delete(key);
    if (!this.isConversationProcessing(conversationId)) {
      this._stopElapsedTimeTimer(conversationId);
    }
    this._notifyStatusObservers(conversationId);
  }

  /**
   * Whether ANY thread of this conversation is currently processing — the
   * question the tab badge, the Escape ladder and the tab ordering ask.
   * A conversation is processing if and only if some run has a status message.
   * @param {string} conversationId - Conversation ID to check
   * @returns {boolean} True if the conversation is currently processing
   */
  isConversationProcessing(conversationId) {
    return (this._statusMessages.get(conversationId)?.size ?? 0) > 0;
  }

  /**
   * Whether ONE thread is currently processing. What a column asks before
   * refusing an action of its own: a sibling being driven is no reason to
   * refuse work here.
   * @param {string} conversationId - Conversation ID to check
   * @param {string|null} [threadItemId] - Thread item id (null/omitted = root)
   * @returns {boolean} True if that thread has a run in flight
   */
  isThreadProcessing(conversationId, threadItemId) {
    return !!this._statusMessages.get(conversationId)?.get(threadKey(threadItemId));
  }

  /**
   * Update status for one of a conversation's runs and update UI
   * @param {string} conversationId - Conversation ID
   * @param {string} statusType - Type of status (streaming, preparing, waiting, processing_tools, retry, error, cancelled, empty, uploading, custom)
   * @param {Partial<StatusData>} [data] - Additional status data
   * @param {string|null} [threadItemId] - Thread the status describes; omitted targets the projected run
   */
  updateStatus(conversationId, statusType, data = {}, threadItemId) {
    // Runtime validation: 'custom' status requires a message
    if (statusType === 'custom' && !data.message) {
      throw new Error('LLMState.updateStatus: "custom" status requires data.message');
    }

    // Callers with no thread in hand (the websocket response handlers) mean the
    // conversation's projected run — the same one getStatusMessage answers for.
    const key = threadItemId === undefined ? this._projectedKey(conversationId) : threadKey(threadItemId);

    // Get existing status data for start time
    const dataByThread = this._perThread(this._statusData, conversationId);
    const existingStatusData = dataByThread.get(key);
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
    // Provider labels merge like the token counts: preserved across the rAF
    // tick's otherwise-empty `data`, reset on a status transition so lifecycle
    // state replacement naturally clears stale provider activity.
    const mergedPhase = data.phase !== undefined ? data.phase : (sameStatus ? existingStatusData?.phase : undefined);
    const mergedDescription = data.description !== undefined ? data.description : (sameStatus ? existingStatusData?.description : undefined);

    /** @type {StatusData} */
    const statusData = {
      type: statusType,
      ...data,
      inputTokens: mergedInput,
      outputTokens: mergedOutput,
      cachedTokens: mergedCached,
      phase: mergedPhase,
      description: mergedDescription,
      startTime: startTime,
      elapsedTime: elapsedTime
    };

    // Store status data
    dataByThread.set(key, statusData);

    // Build and store status message - THIS is the source of truth
    const message = this._buildStatusMessage(statusType, statusData);
    this._perThread(this._statusMessages, conversationId).set(key, message);

    // Tell the observers (the tab showing it among them)
    this._notifyStatusObservers(conversationId);
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

      // Continue only if still processing (some run has a status message)
      if (this.isConversationProcessing(conversationId)) {
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
   * Re-stamp every running thread's elapsed digit.
   * Called by the timer every second. One ticker per conversation drives all of
   * its runs: each carries its own anchor, so two threads that started a minute
   * apart each count from their own start.
   * @param {string} conversationId - Conversation ID
   * @private
   */
  _updateElapsedTime(conversationId) {
    const dataByThread = this._statusData.get(conversationId);
    if (!dataByThread) return;

    for (const [key, statusData] of [...dataByThread]) {
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
        description: statusData.description,
        elapsedTime: elapsedTime,
        // Preserve retry-specific fields
        attempt: statusData.attempt,
        maxRetries: statusData.maxRetries,
        reason: statusData.reason,
        // Preserve custom message (required for 'custom' status type)
        message: statusData.message
      }, key);
    }
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
   * Handle processing state change from Yjs metadata.
   *
   * `processingState.runs` is the source of truth: one frame per thread that
   * holds a claim, each describing itself. This fans them out to one run apiece
   * and retires any thread that has dropped out of the registry since the last
   * write. The top-level fields are a projection of one of those runs, so they
   * are read only for the thread the projection names and for the frames no run
   * appears in at all — a rest, or a terminal error, which is one run's last
   * word about itself.
   * @param {string} conversationId - Conversation ID
   * @param {{status: string, message?: string, code?: string, threadItemId?: string, activity?: string, runs?: object, startedAt?: number, inputTokens?: number, outputTokens?: number, cachedTokens?: number, phase?: string, description?: string}|null} state - Processing state
   * @private
   */
  _handleProcessingStateChange(conversationId, state) {
    if (!state || !state.status) {
      // No state or invalid state - stop processing
      this.stop(conversationId);
      return;
    }

    const runs = runsView(state);
    const live = new Set(Object.keys(runs));

    // Track which thread the projection names, for the single-answer readers.
    // The projection is fickle: while several runs are live it names whichever
    // one wrote the frame, so it alternates between siblings several times a
    // second. To the single-answer readers that churn is not a change of
    // answer — a thread they have named keeps being named until it rests, and
    // only then does the frame's projection get to re-target. Two windows
    // watching the same conversation can therefore settle on different
    // siblings; each still names a live run, which is the guarantee these
    // readers need.
    if (!this._statusThreadIds.has(conversationId) ||
        !live.has(threadKey(this._statusThreadIds.get(conversationId)))) {
      this._statusThreadIds.set(conversationId, state.threadItemId || null);
    }

    // Retire every thread that no longer holds a run. Scoped one thread at a
    // time: a child finishing under a still-streaming parent must take its own
    // spinner down and nothing else.
    for (const key of [...(this._statusMessages.get(conversationId)?.keys() || [])]) {
      if (!live.has(key)) this._stopThread(conversationId, key);
    }

    if (live.size === 0) {
      // Nothing holds a claim, so this frame is the resting or failing run's
      // own last word, and the top-level fields are all there is of it.
      this._applyRunFrame(conversationId, threadKey(state.threadItemId), state);
      // A conversation that came fully to rest names no live column any more.
      // The worker leaves threadItemId in place on a resting frame (a released
      // claim keeps naming what it was released from), but callers that act on
      // it — which column to reveal, which run a bare Escape interrupts — must
      // not be handed a thread that has stopped.
      if (!this.isConversationProcessing(conversationId)) {
        this._statusThreadIds.delete(conversationId);
      }
      return;
    }
    for (const key of live) this._applyRunFrame(conversationId, key, runs[key]);
  }

  /**
   * Apply ONE run's frame — its status, elapsed anchor and token counts — to
   * that thread's spinner state.
   * @param {string} conversationId - Conversation ID
   * @param {string} key - Thread key the frame describes
   * @param {any} frame - The run's own fields (or the top-level frame, when no run holds a claim)
   * @private
   */
  _applyRunFrame(conversationId, key, frame) {
    const { status, message } = frame;
    if (!status) return;

    // Sample output throughput here rather than in updateStatus: this is the
    // one path driven by an actual worker write, so every call is a real
    // observation of how much output has arrived and when.
    this._sampleThroughput(conversationId, key, typeof frame.outputTokens === 'number'
      ? frame.outputTokens
      : undefined);

    // Pull running token counts off the Yjs state so every observing client
    // renders the same spinner text. The worker writes these into the run's
    // own entry from the "progress" / "usage" stream chunks; before they're set
    // the fields are undefined and the formatter prints just "Receiving" with
    // no count.
    const tokenData = {
      inputTokens: typeof frame.inputTokens === 'number' ? frame.inputTokens : undefined,
      outputTokens: typeof frame.outputTokens === 'number' ? frame.outputTokens : undefined,
      cachedTokens: typeof frame.cachedTokens === 'number' ? frame.cachedTokens : undefined,
      // Provider startup and activity snapshots are separate from the scalar
      // activity operation claim.
      phase: typeof frame.phase === 'string' ? frame.phase : undefined,
      // Each frame is a complete lifecycle snapshot. An absent description
      // therefore clears the prior activity; elapsed ticks preserve it
      // separately by passing the stored value back to updateStatus().
      description: typeof frame.description === 'string' ? frame.description : ''
    };
    const threadItemId = key || null;

    // Map worker status to LLMState actions
    // Status values: preparing, streaming, processing_tools, retrying,
    // compacting, idle, error, validation-error
    switch (status) {
      case 'preparing': {
        // A turn was accepted, so the model divergence (if any) is resolved —
        // re-arm the missing-model self-heal's one-shot latch.
        this._conversations.get(conversationId)?.armSelfHeal?.();
        this.start(conversationId, frame.startedAt, threadItemId);
        this.updateStatus(conversationId, 'preparing', tokenData, threadItemId);
        break;
      }

      case 'streaming':
        this.start(conversationId, frame.startedAt, threadItemId);
        this.updateStatus(conversationId, 'streaming', tokenData, threadItemId);
        break;

      case 'processing_tools':
        this.start(conversationId, frame.startedAt, threadItemId);
        this.updateStatus(conversationId, 'processing_tools', tokenData, threadItemId);
        break;

      case 'retrying':
        this.start(conversationId, frame.startedAt, threadItemId);
        this.updateStatus(conversationId, 'custom', { ...tokenData, message: message || 'Retrying' }, threadItemId);
        break;

      // A summarizer run (/compact, /handoff, or context recovery). Its LLM
      // calls are hidden, so this frame — and the elapsed digit riding on it —
      // is the only progress the user sees for the whole run.
      case 'compacting':
        this.start(conversationId, frame.startedAt, threadItemId);
        this.updateStatus(conversationId, 'custom', { ...tokenData, message: message || 'Summarizing conversation' }, threadItemId);
        break;

      case 'idle':
        // Processing complete - stop spinner
        this._stopThread(conversationId, key);
        break;

      case 'error':
        // Terminal, and a rest: the worker releases the claim on this status and
        // drops the run from the registry in the same frame (statusHoldsClaim,
        // cmd/juggler/worker/activity_state.go), so no idle frame follows to take
        // the spinner down afterwards. What went wrong is already a durable error
        // item in the transcript, which is where it is read; a status line
        // repeating it would be the one part of the conversation still moving.
        this._stopThread(conversationId, key);
        break;

      case 'validation-error': {
        const conversation = this._conversations.get(conversationId);

        // The missing-model self-heal — recover from the "no-model"
        // divergence: the worker's doc resolved no model, yet this client is
        // displaying a real one. The conversation owns the resync + one-shot
        // resend (see
        // trySelfHealMissingModel); a true return means the turn is on its way
        // again and there is nothing to warn about.
        if (conversation && frame.code === 'no-model'
            && conversation.trySelfHealMissingModel(threadItemId)) {
          this._stopThread(conversationId, key);
          break;
        }

        // Not self-healable (no code match, no local model, nothing pending, or
        // the self-heal was already spent): surface the warning and restore the
        // user's text so they can act on it.
        if (conversation) {
          conversation.showWarning(message || 'Validation error');
          conversation.restorePendingMessage();
        }
        this._stopThread(conversationId, key);
        break;
      }

      default:
        console.warn(`[LLMState] Unknown status: ${status}`);
    }
  }
}

export default LLMState;
