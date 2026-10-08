//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import apiService from './api.js';
import wsService from './websocket.js';
import workerManager from './worker-manager.js';
import Session from '../model/session.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { isEngine } from '../../sdk/lib/client-role.js';
import { followSession } from './git-workspace.js';
import { reconcileWorkspaces } from './workspace-reconcile.js';
import { setAppPhase } from './app-phase.js';

/**
 * @typedef {object} ConnectionManagerOptions
 * @property {HTMLElement|null} [conversationBar] - Conversation bar element (null for engine)
 * @property {import('./llm-state.js').default} llmState - LLM state manager
 * @property {function(ServerMessage): void} onServerMessage - Callback for server messages
 * @property {function(): void} [onSessionInitialized] - Optional callback after session is created
 * @property {import('../model/session.js').ConversationServices} services - Services for Conversation instances
 * @property {{show: () => void, hide: () => void, startCountdown: (delayMs: number) => void}|null} [disconnectionOverlay] - Overlay for connection loss (null for engine)
 */

/**
 * @typedef {object} ServerMessage
 * @property {string} type - Message type
 * @property {string} conversationId - Conversation ID
 * @property {unknown} data - Message data
 */

/**
 * ConnectionManager
 *
 * Manages WebSocket connections and session initialization.
 * Handles connection lifecycle and status updates.
 * @class
 */
class ConnectionManager {
  /**
   * @param {ConnectionManagerOptions} options - Configuration options
   */
  constructor(options) {
    this._conversationBar = options.conversationBar || null;
    this._llmState = options.llmState;
    this._onServerMessage = options.onServerMessage;
    this._onSessionInitialized = options.onSessionInitialized;
    this._services = options.services;

    /** @type {import('../model/session.js').default|null} @private */
    this._session = null;

    /** @type {Promise<void>|null} @private - The one session load, from the moment it is started */
    this._sessionLoad = null;

    // What `this._session` being non-null does NOT tell anyone: the Session is
    // assigned before its load is awaited, and workerManager.init runs at the
    // end of that load. Until this is true there is a session that cannot spawn
    // a worker, so an 'open' arriving now is the first connection still
    // settling rather than a reconnect to catch up on.
    /** @type {boolean} @private */
    this._sessionLoaded = false;

    /** @type {function|null} @private */
    this._unsubscribe = null;

    /** @type {(() => void)|null} @private - Stops the git surfaces following this window's visible conversation */
    this._unfollowGit = null;

    /** @type {Map<string, import('./websocket.js').WSEventCallback>} @private */
    this._wsCallbacks = new Map();

    /** @type {{show: () => void, hide: () => void, startCountdown: (delayMs: number) => void}|null} @private */
    this._disconnectionOverlay = options.disconnectionOverlay || null;

    // Settled when the session has finished loading, which is the point at which
    // the realm can spawn a worker: workerManager.init runs at the end of that
    // load and nothing before it. Created here rather than at load time because
    // the thing that waits on it — a run dispatched off the socket registering —
    // can arrive before the load has been started at all.
    /** @type {(value?: any) => void} @private */
    this._markSessionReady = () => {};
    /** @type {(reason?: any) => void} @private */
    this._markSessionUnusable = () => {};
    /** @type {Promise<void>} @private */
    this._sessionReady = new Promise((resolve, reject) => {
      this._markSessionReady = resolve;
      this._markSessionUnusable = reject;
    });
    // Nobody may be waiting when it settles, and a rejection with no handler is
    // an unhandled rejection. This one is always handled; the waiters get their
    // own derived promise and their own copy of the reason.
    this._sessionReady.catch(() => {});
  }

  /**
   * Get the current session
   * @returns {import('../model/session.js').default|null} Current session instance or null if not initialized
   */
  getSession() {
    return this._session;
  }

  /**
   * Settles when this realm can actually run something.
   *
   * `getSession()` is non-null well before that: `_loadSession` assigns
   * the Session synchronously and *then* awaits its load, so a caller that
   * checks for a session finds one that cannot yet spawn a worker. Rejects with
   * the load's own error if the load failed, because that failure is permanent —
   * nothing retries it — and every later attempt to use the realm will fail for
   * that reason whatever it reports.
   * @returns {Promise<void>} Settles when the session has loaded, or rejects with why it did not
   */
  whenReadyToRun() {
    return this._sessionReady;
  }

  /**
   * Setup WebSocket connection and event handlers
   * @returns {Promise<void>} Completes after initial setup
   */
  async setup() {
    // Register every listener BEFORE connecting. In the juggler.studio remote
    // path, wsService.connect() adopts the bootstrap's already-open DataChannel
    // and flushes its buffered handoff frames SYNCHRONOUSLY — the one-shot
    // 'session' init frame and the 'open' event are emitted before connect()
    // returns. If connect() ran first those would hit zero listeners and be
    // dropped, stranding the UI at "No session loaded". (The normal WS path is
    // indifferent to the order: its events can't fire until a later task.)

    // Handle session initialization
    const sessionCallback = /** @type {any} */ (async () => {
      await this._initializeSession();
    });
    this._wsCallbacks.set('session', sessionCallback);
    wsService.on('session', sessionCallback);

    // Handle connection events
    const openCallback = /** @type {any} */ (async () => {
      await this._handleOpen();
    });
    this._wsCallbacks.set('open', openCallback);
    wsService.on('open', openCallback);

    const closeCallback = /** @type {any} */ (() => {
      if (this._disconnectionOverlay) this._disconnectionOverlay.show();
    });
    this._wsCallbacks.set('close', closeCallback);
    wsService.on('close', closeCallback);

    // Handle reconnection attempt notifications
    const reconnectAttemptCallback = /** @type {any} */ ((/** @type {{attempt: number, delayMs: number}} */ data) => {
      if (this._disconnectionOverlay) this._disconnectionOverlay.startCountdown(data.delayMs);
    });
    this._wsCallbacks.set('reconnect-attempt', reconnectAttemptCallback);
    wsService.on('reconnect-attempt', reconnectAttemptCallback);

    const errorCallback = /** @type {any} */ ((/** @type {Error} */ error) => {
      console.error('[ConnectionManager] WebSocket error:', error);
    });
    this._wsCallbacks.set('error', errorCallback);
    wsService.on('error', errorCallback);

    // Handle incoming messages
    const messageCallback = (/** @type {any} */ data) => {
      this._onServerMessage(data);
    };
    this._wsCallbacks.set('message', messageCallback);
    wsService.on('message', messageCallback);

    // Handle retry notifications
    const retryCallback = (/** @type {any} */ data) => {
      this._handleRetryNotification(data);
    };
    this._wsCallbacks.set('retry', retryCallback);
    wsService.on('retry', retryCallback);

    // Handle streaming error notifications
    const streamingErrorCallback = (/** @type {any} */ data) => {
      this._handleStreamingError(data);
    };
    this._wsCallbacks.set('streaming-error', streamingErrorCallback);
    wsService.on('streaming-error', streamingErrorCallback);

    // Connect only now that all listeners are registered. The studio adopt path
    // flushes buffered realtime frames and emits 'open' synchronously inside
    // connect(); registering first guarantees the flushed 'session' frame is
    // delivered. Don't call _initializeSession here — the 'session'/'open'
    // handlers above drive it once the connection is established.
    wsService.connect();
  }

  /**
   * Handle the link coming up — either for the first time, or after a drop.
   * @returns {Promise<void>} Completes once the connection has been accounted for
   * @private
   */
  async _handleOpen() {
    // The link is up, so whatever the overlay was reporting is over.
    if (this._disconnectionOverlay) this._disconnectionOverlay.hide();

    // Either the first connection, or one that arrived while the first load was
    // still in flight — on the studio adopt path the flushed 'session' frame and
    // 'open' are emitted in the same synchronous stretch, so both happen. Load
    // the session (once, however many routes ask) and stop there: the load reads
    // the very manifest the catch-up below would, and running that catch-up now
    // would spawn workers against a manager whose init the load has not reached.
    // (A load that finished assigned the session before awaiting anything, so
    // the second test only ever fails together with the first.)
    const session = this._session;
    if (!this._sessionLoaded || !session) {
      await this._initializeSession();
      return;
    }
    // This 'open' is a reconnect, and websocket.js only releases one for a
    // link that came back to the SAME server instance — so everything this
    // page holds is still valid, merely behind. Catch up on the two things
    // that went stale while the socket was down and that nothing replays:
    //   - each conversation's Yjs document, via a state-vector diff in both
    //     directions (the worker's ops we missed, and the edits made here
    //     that the transport discarded);
    //   - the session manifest, whose conversation list, names, order and
    //     metadata are maintained only by broadcasts that were delivered to
    //     a closed socket.
    workerManager.resyncReadyConversations();
    // Viewer-only. The engine holds no session manifest worth refreshing (it
    // renders no tab bar and auto-loads a conversation the moment a sync for
    // it arrives), and re-driving its loads from here would have it eagerly
    // load the whole project on every blip instead.
    if (isEngine()) return;
    workerManager.reinitPendingConversations();
    try {
      await session.refreshFromServer();
    } catch (error) {
      console.error('[ConnectionManager] Couldn\'t refresh the session after reconnect:', extractErrorMessage(error));
    }
  }

  /**
   * Handle retry notification from backend
   * @param {any} data - Retry data
   * @private
   */
  _handleRetryNotification(data) {
    if (!this._session) {
      return;
    }

    // Route to specific conversation if conversationId is provided
    const conversationId = data.conversationId;
    if (conversationId) {
      const conversation = this._session.getConversation(conversationId);
      if (conversation) {
        conversation.handleRetry(data.attempt, data.maxRetries, data.reason);
      }
    }
  }

  /**
   * Handle streaming error notification from backend
   * @param {any} data - Error data with message and conversationId
   * @private
   */
  _handleStreamingError(data) {
    if (!this._session) {
      return;
    }

    // Route to specific conversation if conversationId is provided
    const conversationId = data.conversationId;
    if (conversationId) {
      const conversation = this._session.getConversation(conversationId);
      if (conversation) {
        conversation.handleStreamingError(data.message);
      }
    }
  }

  /**
   * Load the session, once, and settle when it has finished loading.
   *
   * Every route to a connection asks for this — the 'session' init frame and
   * 'open' both do, and on the studio adopt path both arrive in the same
   * synchronous stretch. They share the one load and wait on the one promise,
   * so "the session exists" and "the session has loaded" cannot come apart in
   * the callers.
   * @returns {Promise<void>} Completes when the session load has finished
   * @private
   */
  async _initializeSession() {
    if (!this._sessionLoad) {
      this._sessionLoad = this._loadSession();
    }
    await this._sessionLoad;
  }

  /**
   * Create the session and load it. Call it through {@link ConnectionManager#_initializeSession},
   * which is what keeps it to one.
   * @returns {Promise<void>}
   * @private
   */
  async _loadSession() {
    setAppPhase('session');

    // Create session instance
    this._session = new Session(apiService);

    // CRITICAL: Set services BEFORE loading
    // This allows Conversation instances to be created during load
    this._session.setServices(this._services);

    // Setup session subscription
    this._setupSessionSubscription();

    // Point this window's git surfaces at whichever tree the visible
    // conversation works in. Here rather than in a card or a pin because it is
    // the window's answer, not any one surface's: they share it, and they must.
    this._unfollowGit = followSession(this._session);

    // Load session data from backend.
    //
    // Every failure takes the one recovery path below, whatever it says. There
    // is no "session missing" case to single out: GET /api/session is
    // registered unconditionally and its handler has no not-found answer (see
    // HandleGetSession), so a 404 here comes from a request the load
    // makes afterwards — and reloading the page would only repeat that request,
    // in a loop, with the user unable to reach the picker.
    let loadError = null;
    try {
      await this._session.load();
    } catch (error) {
      const errorMessage = extractErrorMessage(error);
      // Don't strand the UI on a failed load. Fall through to wire the
      // session into the UI anyway: the <no-project-overlay> project
      // picker is the user's recovery path (opening a project triggers a
      // full reload that retries the load), and we surface the failure
      // explicitly below rather than silently bricking with no controls.
      console.error('[ConnectionManager] Session load failed:', errorMessage);
      loadError = errorMessage;
    }

    // Square the workspace table with what is actually on disk — interrupted
    // provisions undone, vanished trees reported. Deliberately not awaited: it
    // waits on the registries and then talks to providers, and none of that
    // should stand between the user and their conversations. It claims the job
    // from the server, so however many windows are open it happens once.
    if (!loadError) {
      reconcileWorkspaces(this._session).catch((error) => {
        console.warn('[ConnectionManager] Workspace reconcile failed:', error);
      });
    }

    // Release anything holding for a realm it can run in — with the reason, if
    // there isn't one. A load that threw leaves the worker manager uninitialised
    // for good, so reporting that now is the difference between a caller being
    // told what went wrong and being told what noticed.
    if (loadError) {
      this._markSessionUnusable(new Error(`the engine could not load its session: ${loadError}`));
    } else {
      this._sessionLoaded = true;
      this._markSessionReady();
    }

    // Notify app that session is initialized (so it can create session-dependent services)
    if (this._onSessionInitialized) {
      this._onSessionInitialized();
    }

    // Give conversation bar access to session
    // This will create conversation-tab elements for all conversations
    if (this._conversationBar) {
      /** @type {any} */ (this._conversationBar).setSession(this._session);
    }

    // Startup is over: there is something real on screen, so the overlay that
    // was standing in for it goes. Said here rather than on the success path
    // above because a load that FAILED has also finished starting up — the
    // project picker wired in just now is the recovery, and it is no use behind
    // a spinner.
    setAppPhase('ready');

    if (loadError && typeof window !== 'undefined') {
      // Surface the failure now that the picker overlay (wired above) is
      // available as the recovery path. Viewer-only — the engine worker
      // has no alert UI.
      /** @type {any} */ (window).showAlert?.(
        `Couldn't load the session: ${loadError}\n\nPick a project to try again.`,
        'Session load failed'
      );
    }
  }

  /**
   * Setup session subscription to handle state changes
   * @private
   */
  _setupSessionSubscription() {
    if (!this._session) {
      console.error('[ConnectionManager] Cannot setup subscription: session is null');
      return;
    }

    // UI updates are owned by the per-tab components, which subscribe for
    // themselves: conversation-bar handles tab visibility, and conversation-tab
    // repaints its columns (on `session:loaded` too). All that is left here is
    // reporting a failed save.
    this._unsubscribe = this._session.subscribe(/** @param {{type: string, data: unknown}} event */ (event) => {
      if (event.type === 'session:save-error') {
        console.error('[ConnectionManager] Failed to save session:', event.data);
      }
    });
  }

  /**
   * Cleanup resources
   */
  destroy() {
    // Unsubscribe from session events
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }

    if (this._unfollowGit) {
      this._unfollowGit();
      this._unfollowGit = null;
    }

    // Remove every WebSocket listener registered in setup(). Iterating the map
    // (rather than hand-listing event names) guarantees none leak when the set
    // of registered events changes.
    if (wsService) {
      for (const [event, callback] of this._wsCallbacks) {
        wsService.off(/** @type {any} */ (event), callback);
      }
      this._wsCallbacks.clear();
    }

    // Clear references
    this._session = null;
    this._sessionLoad = null;
    this._sessionLoaded = false;
  }
}

export default ConnectionManager;
