//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Engine Application - Headless browser that handles tool execution and context rendering.
 * Connects as role=engine via WebSocket. Responds to worker requests for
 * context items and tool definitions. Executes tools when tool-action items
 * appear in Yjs. Does NOT create any UI components.
 * @module engine-app
 */

import LLMState from './services/llm-state.js';
import ConnectionManager from './services/connection-manager.js';
import { reloadRegistries, initAllRegistries } from './registries/reload-registries.js';
import wsService from './services/websocket.js';
import actionExecutor from './services/action-executor.js';
import workerManager from './services/worker-manager.js';
import { runOneShot } from './engine-one-shot.js';

/**
 * How often the engine tells the server its realm is still running. Must stay
 * well inside the server's engineLivenessWindow (engine_liveness.go) so an
 * ordinary scheduling hiccup or one dropped beat never reads as death.
 */
const ENGINE_HEARTBEAT_MS = 5000;

/**
 * Headless engine app that handles tool execution and context rendering.
 * No UI - just responds to worker requests and executes tools.
 */
class EngineApp {
  constructor() {
    /** @type {import('./services/llm-state.js').default|null} @private */
    this._llmState = null;
    /** @type {ConnectionManager|null} @private */
    this._connectionManager = null;
    /** @type {ReturnType<typeof setInterval>|null} @private */
    this._heartbeatTimer = null;

    this.init();
  }

  /** @private */
  init() {
    if (typeof document === 'undefined') {
      // Engine worker: no document to wait on, boot immediately.
      this.setup();
    } else if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.setup());
    } else {
      this.setup();
    }
  }

  /** @private */
  async setup() {
    console.info('[Engine] Initializing engine...');

    // Initialize registries (needed for context items, tools, strategies).
    // Signal readiness once the initial init attempt settles — even on failure,
    // so the system-prompt gate can never permanently hang a turn.
    await initAllRegistries();

    // Listen for extension file/config changes. The reload path defers any
    // registry reset until local turns are idle, so tools are never removed
    // from under an in-flight execution.
    wsService.on('plugin-changed', async () => {
      console.info('[Engine] Plugin changed — reloading registries');
      await reloadRegistries();
      console.info('[Engine] Plugin registries reloaded');
    });

    // The enabled/disabled capability set is per-project — the server resolves
    // it with core.LoadConfig(projectPath) — so a project switch changes which
    // context items, strategies and commands should be registered. A viewer
    // picks that up by reloading the page; the engine is persistent across the
    // switch and would otherwise keep serving the previous project's set,
    // offering the model tools this project disables (or withholding ones it
    // enables). Same deferred reload as a plugin toggle.
    wsService.on('project-changed', async () => {
      console.info('[Engine] Project changed — reloading registries');
      await reloadRegistries();
      console.info('[Engine] Project registries reloaded');
    });

    // Initialize services
    this._llmState = new LLMState();

    this._connectionManager = new ConnectionManager({
      llmState: this._llmState,
      onServerMessage: (data) => this._handleServerMessage(data),
      services: {
        llmState: this._llmState,
        actionExecutor,
        wsService
      }
    });

    // Connect with engine role
    await this._connectionManager.setup();

    this._startHeartbeat();

    console.info('[Engine] Engine initialized and connected');
    if (typeof window !== 'undefined') {
      /** @type {any} */ (window).__engineReady = true;
    }
    // Optional ready hook. The engine-worker host installs this on globalThis
    // to relay readiness to the main thread; unset in the WebView, where the
    // window flag above is the signal.
    const onReady = /** @type {any} */ (globalThis).__onEngineReady;
    if (typeof onReady === 'function') onReady();
  }

  /**
   * The engine realm's session, for callers holding this engine rather than
   * being handed one. Null before setup.
   * @returns {import('./model/session.js').default|null} The session, or null.
   */
  getSession() {
    return this._connectionManager?.getSession?.() ?? null;
  }

  /**
   * Start announcing that this realm is running.
   *
   * The server treats an engine as attached only while it keeps hearing from it
   * (cmd/juggler/server/engine_liveness.go), because the socket alone proves
   * nothing: WebKit runs the WebSocket in the network process, so a hidden
   * WebView whose page has been suspended still answers at the transport while
   * executing no tools. This timer runs in the module worker, so it stops
   * exactly when the thing it vouches for stops — which is the point.
   *
   * Every other message the engine sends refreshes the same stamp; this only
   * covers an engine with nothing to say.
   * @private
   */
  _startHeartbeat() {
    if (this._heartbeatTimer) return;
    wsService.sendEngineHeartbeat();
    this._heartbeatTimer = setInterval(() => wsService.sendEngineHeartbeat(), ENGINE_HEARTBEAT_MS);
  }

  /**
   * Release a conversation the user has thrown away, if this engine is holding
   * one.
   *
   * The engine never let go of a conversation once it had loaded it: the Yjs
   * document, its observers and the worker entry survived deletion, binning and
   * project switches, so a long-lived engine accumulated every conversation it
   * had ever been synced — in the one realm that has to stay responsive, and
   * where an exhausted WebView is indistinguishable from a wedged one.
   *
   * Deleted and binned conversations are the unambiguous case: the user has
   * removed them, their server-side worker is gone, and nothing will ask this
   * engine to run a tool in them again. `binned-deleted` (emptied from the bin)
   * is included for the engine that was restarted while something sat in the
   * bin and picked it up from a later sync.
   *
   * Every other op is left alone. `restored` in particular needs no work: the
   * next yjs-sync for that conversation loads it back through the same lazy path
   * that loaded it the first time.
   * @param {{op?: string, id?: string}} data - The conversations-changed diff
   * @private
   */
  _releaseRemovedConversation({ op, id }) {
    if (!id) return;
    if (op !== 'deleted' && op !== 'binned' && op !== 'binned-deleted') return;
    const session = this.getSession();
    if (!session) return;
    void Promise.resolve(session.releaseConversation(id))
      .then((released) => {
        if (released) console.info(`[Engine] Released ${op} conversation ${id}`);
      })
      .catch((err) => {
        // A release that fails leaves the conversation held, which is the state
        // we started from — never let it take the message handler down with it.
        console.warn(`[Engine] Couldn't release ${op} conversation ${id}:`, err);
      });
  }

  /**
   * Handle server messages - route worker messages
   * @param {any} data
   * @private
   */
  _handleServerMessage(data) {
    // Route worker messages to workerManager
    if (data.type === 'worker-message') {
      workerManager.handleWorkerMessageFromWS(data);
      return;
    }

    if (data.type === 'session-metadata-changed') {
      const session = this.getSession();
      session?.applySessionMetadataPatch?.(data.metadata || {}, { remote: true });
      return;
    }

    // The engine loads conversations lazily via the loader's autoLoad when it
    // receives yjs-sync from active workers, so it must NOT apply the op-tagged
    // conversations-changed diff the way a viewer does — that would load every
    // conversation, which is exactly what the engine's empty
    // session.conversations exists to avoid. The generic session-changed is a
    // viewer refresh and means nothing here.
    //
    // The ops that REMOVE a conversation are the exception, and they run in the
    // other direction: they release something the engine already holds.
    if (data.type === 'conversations-changed') {
      this._releaseRemovedConversation(data);
      return;
    }
    if (data.type === 'session-changed') {
      return;
    }

    // Handle tool_use_request (from claudecode provider)
    if (data.type === 'tool_use_request') {
      const conversationId = data.conversationId;
      if (!conversationId || !this._connectionManager) return;
      const session = this._connectionManager.getSession();
      if (!session) return;
      const conversation = session.getConversation(conversationId);
      if (conversation) {
        conversation.handleToolUseRequest(data);
      }
      return;
    }

    // Handle should_continue_request
    if (data.type === 'should_continue_request') {
      const conversationId = data.conversationId;
      if (!conversationId || !this._connectionManager) return;
      const session = this._connectionManager.getSession();
      if (!session) return;
      const conversation = session.getConversation(conversationId);
      if (conversation) {
        conversation.handleShouldContinueRequest(data);
      }
      return;
    }

    // One unattended run, start to finish. It is addressed to the engine
    // because only the engine can seed a conversation (see engine-one-shot.js),
    // and the caller is blocked on the single reply it sends.
    if (data.type === 'run-one-shot') {
      // Handed the realm's readiness rather than waited on here: runOneShot owes
      // the caller exactly one reply, including when the wait is what failed.
      runOneShot(this.getSession(), data, this._connectionManager?.whenReadyToRun?.());
      return;
    }

    // Ignore other message types (the engine doesn't need UI routing)
  }
}

// Initialize engine.
//
// The globals are a debugging convenience for a page that has a console, and
// neither production host is one: the engine runs in a module worker or under
// Node, and neither has a `window`. So nothing may depend on reaching the engine
// through a global — the module-scope `engine` here, and the server messages it
// handles, are the only ways in.
const engine = new EngineApp();
if (typeof window !== 'undefined') {
  /** @type {any} */ (window).__jugglerEngine = engine;
  /** @type {any} */ (window).engineApp = engine;
}
