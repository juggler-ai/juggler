//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @typedef {import('./services/api.js').Message} Message
 * @typedef {import('./services/response-handler.js').default} ResponseHandler
 */

import LLMState from './services/llm-state.js';
import ConnectionManager from './services/connection-manager.js';
import DisconnectionOverlay from './components/disconnection-overlay.js';
import UIEventManager from './services/ui-event-manager.js';
import StrategySwitcher from './services/strategy-switcher.js';
import wsService from './services/websocket.js';
import { reloadRegistries, initAllRegistries } from './registries/reload-registries.js';
import actionExecutor from './services/action-executor.js';
import workerManager from './services/worker-manager.js';
import providersCache from './services/providers-cache.js';
import { setupHeaderControls } from './utils/header-controls.js';
import { registerConversationShortcuts } from './services/shortcut-bindings.js';
import { markSeen } from './services/tips-manager.js';
import { updateWindowTitle } from './utils/window-title.js';
import { initAttention } from './utils/attention-manager.js';
import scheduledSendService from './services/scheduled-send-service.js';
import { initViewportFit } from './utils/viewport-fit.js';
import { openExternalURL, externalURLFromHref } from '../sdk/lib/window-control.js';
import './services/tooltip-manager.js'; // styled hover/focus tooltips (self-installs on import)
import { MAX_CONVERSATIONS, CONVERSATION_LIMIT_MESSAGE } from './model/session.js';
import { normalizeAttachments } from './utils/attachments.js';



/**
 * Main Juggler Application
 *
 * Slim coordinator that delegates to specialized services.
 * Each service handles a single responsibility.
 * @class
 */
class JugglerApp {
  constructor() {
    /** @type {HTMLElement|null} @private */
    this.conversationBar = null;

    // Services
    /** @type {import('./services/llm-state.js').default|null} @private */
    this._llmState = null;
    /** @type {ConnectionManager|null} @private */
    this._connectionManager = null;
    /** @type {UIEventManager|null} @private */
    this._uiEventManager = null;
    /** @type {StrategySwitcher|null} @private */
    this._strategySwitcher = null;

    this.init();
  }

  /** @private */
  init() {
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.setup());
    } else {
      this.setup();
    }
  }

  /** @private */
  flushComposerDrafts() {
    document.querySelectorAll('input-box').forEach((box) => {
      if (typeof (/** @type {any} */ (box).flushDraft) === 'function') {
        /** @type {any} */ (box).flushDraft();
      }
    });
  }

  /**
   * Pause CSS animations while the document is hidden (window minimised, fully
   * occluded, or on another virtual desktop). Reflects `document.hidden` onto a
   * `data-doc-hidden` attribute on <html>, which the stylesheet keys off to set
   * `animation-play-state: paused` everywhere. A hidden window paints nothing a
   * user can see, yet its continuously-running indicators (the busy spinner, the
   * tab/icon pulses) would otherwise keep the WebProcess re-rasterising unseen
   * frames every refresh tick — wasteful in general, and a whole CPU core under
   * software compositing. Animations resume on the next paint when the window
   * becomes visible again.
   * @private
   */
  _initDocumentVisibilityPause() {
    const sync = () => {
      document.documentElement.toggleAttribute('data-doc-hidden', document.hidden);
    };
    document.addEventListener('visibilitychange', sync);
    sync(); // reflect the initial state immediately
  }

  /** @private */
  async setup() {
    // Get component references. contextPanel, conversationArea, and
    // conversationControls are per-tab, not global.
    this.conversationBar = document.querySelector('conversation-bar');

    if (!this.conversationBar) {
      console.error('[Juggler] Failed to find required components');
      return;
    }

    // Boot all capability registries in dependency order and signal
    // registries-ready once the attempt settles — even on failure, so the
    // system-prompt gate can never permanently hang a turn.
    await initAllRegistries();

    // Initialize strategy switcher (Shift+Tab keyboard shortcut)
    this._strategySwitcher = new StrategySwitcher();
    this._strategySwitcher.init();

    // Listen for plugin file changes (hot reload)
    wsService.on('plugin-changed', async () => {
      console.info('[Juggler] Plugin changed — reloading registries');
      await reloadRegistries();
      console.info('[Juggler] Plugin registries reloaded');
    });

    // Initialize services
    this._initializeServices();

    // Setup UI event handlers
    if (this._uiEventManager) {
      this._uiEventManager.setupAll();
    }

    // On touch devices, keep the header (and its tab menu) on screen when the
    // on-screen keyboard opens by fitting <app-container> to the visual viewport
    // instead of letting the browser scroll the whole page up.
    initViewportFit();

    // Pause CSS animations when this window is hidden, so its always-running
    // indicators don't burn CPU re-rasterising frames nobody can see.
    this._initDocumentVisibilityPause();

    // External-link safety net. Markdown-rendered content (LLM and message
    // output) emits bare <a href> anchors at many render sites; a plain
    // target=_blank is swallowed by the native WebView and a same-window
    // navigation would tear the app off its page. One delegated handler hands
    // external links to the system browser via the loopback opener (a no-op
    // fallthrough to a new tab in a plain browser). externalURLFromHref also
    // re-qualifies scheme-less bare-domain links (e.g. [repo](github.com/u/r),
    // which the browser would otherwise resolve same-origin and navigate to).
    // Runs in the bubble phase: explicit per-element handlers (settings,
    // modals) call preventDefault first, so defaultPrevented skips them here
    // — no double-open. Modifier/middle clicks and downloads are left alone.
    document.addEventListener('click', (e) => {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = /** @type {HTMLElement} */ (e.target);
      const anchor = /** @type {HTMLAnchorElement|null} */ (target.closest?.('a[href]'));
      if (!anchor || anchor.hasAttribute('download')) return;
      const external = externalURLFromHref(anchor.getAttribute('href') || '', anchor.href);
      if (!external) return;
      e.preventDefault();
      openExternalURL(external);
    });

    document.addEventListener('duplicate-conversation', () => {
      this._handleDuplicateConversation();
    });

    window.addEventListener('juggler:window-close-requested', () => {
      this.flushComposerDrafts();
    });

    // Rollback and branch handlers
    document.addEventListener('rollback-from-item', (e) => {
      const customEvent = /** @type {CustomEvent} */ (e);
      this._handleRollbackFromItem(customEvent.detail.itemId);
    });

    document.addEventListener('branch-from-item', (e) => {
      const customEvent = /** @type {CustomEvent} */ (e);
      this._handleBranchFromItem(customEvent.detail.itemId);
    });



    // Save on page unload (page close, refresh, navigate away)
    // This ensures UI state like activeConversationId is persisted
    // Using pagehide (not visibilitychange) to avoid saving on browser tab switches
    window.addEventListener('pagehide', () => {
      const session = this._connectionManager?.getSession();
      if (session) {
        this.flushComposerDrafts();
        // Save scroll positions for all conversations before page close
        session.conversations.forEach((conversation) => {
          const tab = conversation.getTabElement();
          const conversationArea = tab?.getConversationArea();
          if (conversationArea) {
            // @ts-ignore - saveScrollPositionImmediately is a method on conversation-area
            conversationArea.saveScrollPositionImmediately();
          }
        });
        // Use saveImmediately to bypass debounce on page close
        session.saveImmediately();
      }
    });

    // Setup WebSocket connection and initialize session
    if (this._connectionManager) {
      await this._connectionManager.setup();
    }
  }

  /**
   * Initialize all service instances
   * @private
   */
  _initializeServices() {
    // Initialize LLM state manager
    this._llmState = new LLMState();

    // Create temporary placeholder for managers that need session
    // These will be properly initialized after session is created
    /** @type {ResponseHandler|null} @private */
    this._responseHandler = null;

    // Initialize connection manager (will call onServerMessage callback).
    // contextPanel, conversationArea, conversationControls, and inputBox are per-tab.
    if (!this.conversationBar) {
      throw new Error('All UI components are required');
    }
    this._connectionManager = new ConnectionManager({
      conversationBar: this.conversationBar,
      disconnectionOverlay: new DisconnectionOverlay(),
      llmState: this._llmState,
      onServerMessage: (data) => this._handleServerMessage(data),
      onSessionInitialized: () => this._initializeSessionServices(),
      // Services for Conversation instances. conversationArea and
      // conversationControls come from each conversation's own tab.
      services: {
        llmState: this._llmState,
        actionExecutor: actionExecutor,
        wsService: wsService
      }
    });

    // Initialize UI event manager with callbacks. UI elements are per-tab, so
    // UIEventManager listens at document level.
    this._uiEventManager = new UIEventManager({
      onSendMessage: (message, threadItemId, messageThread, attachments) => this._sendMessage(message, threadItemId, messageThread, attachments),
      onContextItemAction: (detail) => this._handleContextItemAction(detail)
    });
  }

  /**
   * Initialize session-dependent services
   * Called after session is created
   * @private
   */
  _initializeSessionServices() {
    if (!this._connectionManager) {
      console.error('[Juggler] Cannot initialize session services: connection manager is null');
      return;
    }
    const session = this._connectionManager.getSession();
    if (!session) {
      console.error('[Juggler] Cannot initialize session services: session is null');
      return;
    }

    // Services are set on the session by ConnectionManager before loading.
    // Each Conversation owns its own ResponseHandler, created with the
    // Conversation instance.

    // Give UI event manager access to session
    if (this._uiEventManager) {
      this._uiEventManager.setSession(session);
    }

    // Alert (chime + tab flash + dock/tab notification) when a conversation needs
    // attention while unwatched.
    initAttention(session);

    // Poll every conversation for a due scheduled send ("send after a delay")
    // and fire it — regardless of which thread is currently on screen.
    scheduledSendService.start(session);

    // Wire global header controls (undo/redo + project path)
    setupHeaderControls(session);

    // Attach the conversation-level keyboard command handlers (new/bin/jump/
    // toggle-file-editing) and install the global shortcut dispatcher.
    registerConversationShortcuts(session);

    // Name the native OS window after the session's project path so the
    // macOS "Window" menu can tell windows apart (project switches reload
    // the page, so session:loaded carries the current path each time).
    const syncWindowTitle = () => updateWindowTitle(session.projectPath || '', session.home || '');
    session.subscribe(/** @param {{type: string}} event */ (event) => {
      if (event.type === 'session:loaded') syncWindowTitle();
    });
    syncWindowTitle();

    // Wire the no-project overlay to the session so it can show/hide
    // based on whether a project is loaded.
    const overlay = /** @type {any} */ (document.querySelector('no-project-overlay'));
    if (overlay && typeof overlay.setSession === 'function') {
      overlay.setSession(session);
    }

    // First-run walkthrough — best-effort, never blocks startup.
    void this._maybeShowOnboarding();
  }

  /**
   * Show the first-run walkthrough whenever no AI provider is configured yet.
   * An unconfigured Juggler can't do anything, so we prompt on every launch until
   * a provider exists — provider presence IS the completion signal, so there's no
   * persisted flag. Reuses the existing confirm dialog + Provider Settings panel
   * rather than a bespoke UI.
   * @private
   */
  async _maybeShowOnboarding() {
    // The integration harness never broadcasts a providers-update (RefreshProviders
    // is a no-op in test mode), so onboarding has no meaningful signal and a modal
    // would only interfere with tests. Skip it entirely.
    if (/** @type {any} */ (window).JUGGLER_TEST_MODE) return;
    try {
      // Wait for the SETTLED provider list, not the connect seed: the seed arrives
      // before the server has computed availability, so gating on it would misread a
      // fully-configured user as having no provider. The first refresh always runs
      // at startup, so this resolves shortly after launch.
      await providersCache.waitForReady();

      // A provider is configured — Juggler is usable, nothing to prompt.
      if (providersCache.hasAvailableProvider()) return;

      const showConfirm = /** @type {any} */ (window).showConfirm;
      if (typeof showConfirm !== 'function') return;
      const goToSettings = await showConfirm(
        'Juggler is a visual AI coding workbench. To get started, connect an AI provider — add an API key, or enable Claude Code if you have its CLI installed.',
        'Welcome to Juggler',
        { confirmText: 'Add a provider', cancelText: 'Later' }
      );
      if (goToSettings && typeof (/** @type {any} */ (window).openSettings) === 'function') {
        /** @type {any} */ (window).openSettings('providers');
      }
    } catch {
      /* onboarding is best-effort; never block or crash startup */
    }
  }

  /**
   * Send a message to the LLM
   * @param {string} message - User message
   * @param {string|null} [threadItemId] - Thread item ID if sending from a thread column
   * @param {*} [messageThread] - Column-scoped message thread
   * @param {Array<{id:string,mime:string,filename:string,bytes:number,width:number,height:number}>} [attachments] - Staged image attachments
   * @private
   * @async
   */
  async _sendMessage(message, threadItemId, messageThread, attachments) {
    const conversation = messageThread?.conversation;
    if (!conversation) {
      console.error('[Juggler] Cannot send message: no target conversation');
      return;
    }

    // The conversation owns its own handlers and manages everything;
    // validation (including model selection) happens inside sendMessage().
    conversation.sendMessage(message, threadItemId, messageThread, { attachments: attachments || [] });
  }

  /**
   * Handle server message
   * @param {any} data - Server message data
   * @private
   */
  async _handleServerMessage(data) {
    if (!this._connectionManager) {
      console.error('[Juggler] Cannot handle message: connection manager not initialized');
      return;
    }
    const session = this._connectionManager.getSession();
    if (!session) {
      console.error('[Juggler] Cannot handle message: session not initialized');
      return;
    }

    // Route worker messages to workerManager
    if (data.type === 'worker-message') {
      workerManager.handleWorkerMessageFromWS(data);
      return;
    }

    // Op-tagged conversation-list diff from the server. Carries the
    // minimum payload needed to apply locally; clients apply
    // idempotently so the originator's echo is a no-op.
    if (data.type === 'conversations-changed') {
      const { op, id, name, order } = data;
      switch (op) {
        case 'created':          session.applyConversationCreated(id, name); break;
        case 'deleted':          session.applyConversationDeleted(id); break;
        case 'renamed':          session.applyConversationRenamed(id, name); break;
        case 'binned':           session.applyConversationBinned(id); break;
        case 'restored':         session.applyConversationRestored(id, name); break;
        case 'binned-deleted':   session.applyBinnedConversationDeleted(id); break;
        case 'reordered':        session.applyConversationsReordered(order); break;
        default: console.warn('[Juggler] unknown conversations-changed op:', op);
      }
      return;
    }

    // Targeted session metadata patch. Apply locally without a full
    // session refresh so permission changes sync instantly across tabs.
    if (data.type === 'session-metadata-changed') {
      session.applySessionMetadataPatch(data.metadata || {}, { remote: true });
      return;
    }

    // Session-level metadata (messageHistory, metadata flags) updated
    // by another viewer's PUT /session. Conversation-list changes
    // travel via conversations-changed above; this is a small refresh.
    if (data.type === 'session-changed') {
      this._handleSessionChanged(session);
      return;
    }

    // All messages should include conversationId for routing
    const conversationId = data.conversationId;
    if (!conversationId) {
      // Server response missing conversationId - this is a backend bug
      // Just log it - user can't fix this, and alert dialogs during disconnection are noise
      console.error('[Juggler] Server response missing conversationId - cannot route:', data);
      return;
    }

    // Skip internal operations (e.g., compaction) - they handle their own routing
    if (conversationId.startsWith('_internal:')) {
      return;
    }

    // Get the conversation this message is for
    const conversation = session.getConversation(conversationId);
    if (!conversation) {
      // Internal-consistency event, not user-actionable: a response landed for a
      // conversation that was deleted while the request was in flight. Log it for
      // diagnosis rather than surfacing a raw ID to the user.
      console.warn('[Juggler] Response received for unknown conversation:', conversationId, 'Available:', Array.from(session.conversations.keys()));
      return;
    }

    // Route message to the appropriate conversation
    if (data.type === 'tool_use_request') {
      // Tool execution request from claudecode provider (executes tools via MCP)
      await conversation.handleToolUseRequest(data);
    } else if (data.type === 'tool_use_timeout') {
      // Backend timed out waiting for tool approval - dismiss dialog silently
      // Route to worker if it's handling this conversation
      if (workerManager.isWorkerReady(conversationId)) {
        workerManager.sendApprovalResponse(conversationId, data.toolUseId, 'cancel');
      } else {
        const messageThread = conversation.resolveMessageThread(data.threadItemId);
        messageThread.resolveApproval(data.toolUseId, 'cancel');
      }
    } else if (data.type === 'should_continue_request') {
      // Iteration control callback from provider
      await conversation.handleShouldContinueRequest(data);
    } else if (data.error) {
      // Error - backend may send {error: true, message: "..."} or {error: "message"}
      let errorMsg;
      if (typeof data.error === 'string') {
        errorMsg = data.error;
      } else if (data.message) {
        errorMsg = data.message;
      } else {
        errorMsg = 'Connection error - request failed';
      }
      const messageThread = conversation.resolveMessageThread(data.threadItemId);
      conversation.handleError(messageThread, errorMsg);
    } else if ('blocks' in data || 'inputTokens' in data) {
      // Final response - structured blocks with token counts. The worker
      // handles LLM calls directly; this path serves the main-thread fallback
      // (e.g. claudecode provider callbacks).
      const inputTokens = data.inputTokens || 0;
      const outputTokens = data.outputTokens || 0;
      const cachedTokens = data.cachedTokens || 0;
      const transactionId = data.transactionId;
      const stopReason = data.stopReason || 'end_turn';
      const blocks = data.blocks || [];
      const messageThread = conversation.resolveMessageThread(data.threadItemId);
      await conversation.handleResponse(messageThread, blocks, inputTokens, outputTokens, cachedTokens, transactionId, stopReason);
    } else {
      // Unknown message format - log and notify user
      console.error('[Juggler] Unexpected message format from server:', data);
      const messageThread = conversation.resolveMessageThread(data.threadItemId);
      conversation.handleError(messageThread, 'Received unexpected message format from server');
    }
  }

  /**
   * Handle session-level changes from other views
   * @param {import('./model/session.js').default} session
   * @private
   */
  _handleSessionChanged(session) {
    session.refreshFromServer();
  }

  /**
   * Handle context item action
   * @param {object} detail - Action detail
   * @returns {Promise<void>}
   * @private
   */
  async _handleContextItemAction(detail) {
    /** @type {any} */
    const actionDetail = detail;
    const { action, itemId, threadItemId } = actionDetail;

    if (!this._connectionManager) {
      console.error('[Juggler] Cannot handle context item action: connection manager not initialized');
      return;
    }
    const session = this._connectionManager.getSession();
    if (!session) {
      console.error('[Juggler] Cannot handle context item action: session not initialized');
      return;
    }

    // Update session (auto-saves!)
    switch (action) {
      case 'remove':
      case 'delete': {
        const conv = session.getVisibleConversation();
        if (conv) {
          const messageThread = threadItemId ? conv.resolveMessageThread(threadItemId) : conv.rootMessageThread;
          try { messageThread?.removeContextItem(itemId); } catch { /* not deletable */ }
        }
        break;
      }
      case 'refresh': {
        const conversation = session.getVisibleConversation();
        if (conversation) {
          const messageThread = threadItemId ? conversation.resolveMessageThread(threadItemId) : conversation.rootMessageThread;
          await messageThread?.refreshContextItem(itemId);
        }
        break;
      }
    }
  }

  /**
   * Handle rollback from item ID - rollback to a user message and put its text in the input
   * @param {string} itemId - Item ID to rollback from
   * @private
   */
  _handleRollbackFromItem(itemId) {
    if (!this._connectionManager) {
      console.error('[Juggler] Cannot rollback: connection manager not initialized');
      return;
    }

    const session = this._connectionManager.getSession();
    if (!session) {
      console.error('[Juggler] Cannot rollback: session not initialized');
      return;
    }

    const conversation = session.getVisibleConversation();
    if (!conversation) {
      console.error('[Juggler] No active conversation to rollback');
      return;
    }

    // Get messageThread from active column (supports thread columns)
    const tab = /** @type {any} */ (conversation.getTabElement());
    const messageThread = tab?.getActiveMessageThread?.() || conversation.rootMessageThread;

    // Read items directly from conversation
    const items = messageThread.items;
    const itemIndex = messageThread.findIndexByItemId(itemId);

    const item = /** @type {import('../sdk/lib/message.js').Message|undefined} */ (items[itemIndex]);
    if (itemIndex < 0 || !item || item.get('type') !== 'user') {
      console.error('[Juggler] Item is not a user message');
      return;
    }

    // Snapshot the message's fields BEFORE removing it. A user message is one
    // unit (text + image attachments); deleting the item detaches its nested
    // `attachments` Y.Array, so a post-delete read loses the images — the
    // primitive `content` survives the read but the nested shared type does
    // not. Capture a plain record up-front and restore that.
    const snapshot = {
      content: item.get('content') || '',
      attachments: normalizeAttachments(item.get('attachments')),
    };

    // Remove items with full cleanup (cancel approvals, stop processing)
    conversation.deleteRangeWithCleanup(messageThread, itemIndex);

    // Restore the whole message into the composer. The deleted item's asset
    // blobs stay alive across the rewind via the undo grace (undoableAssetIDs)
    // and the resend re-references them, so they are never GC'd before re-send.
    this._loadMessageIntoInput(conversation, snapshot);
  }

  /**
   * Handle branch from item ID - create a new conversation from this point
   * @param {string} itemId - Item ID to branch from
   * @private
   */
  async _handleBranchFromItem(itemId) {
    if (!this._connectionManager) {
      console.error('[Juggler] Cannot branch: connection manager not initialized');
      return;
    }

    const session = this._connectionManager.getSession();
    if (!session) {
      console.error('[Juggler] Cannot branch: session not initialized');
      return;
    }

    const conversation = session.getVisibleConversation();
    if (!conversation) {
      console.error('[Juggler] No active conversation to branch from');
      return;
    }

    // Get messageThread from active column (supports thread columns)
    const tab = /** @type {any} */ (conversation.getTabElement());
    const messageThread = tab?.getActiveMessageThread?.() || conversation.rootMessageThread;

    // Read items directly from conversation
    const items = messageThread.items;
    const itemIndex = messageThread.findIndexByItemId(itemId);

    const item = /** @type {import('../sdk/lib/message.js').Message|undefined} */ (items[itemIndex]);
    if (itemIndex < 0 || !item) {
      console.error('[Juggler] Item not found for id', itemId);
      return;
    }

    // Duplicate the conversation (creates a clone with new ID)
    const newConvId = await this._duplicateConversationGuarded(session, conversation.id);
    if (!newConvId) {
      return;
    }

    // Switch to the new conversation
    session.switchConversation(newConvId);

    // Get the new conversation and rollback
    const newConv = session.getConversation(newConvId);
    if (newConv) {
      // PURE YJS: Remove items via conversation method (syncs to worker automatically)
      // Note: branch always operates on root of the new conversation
      // Re-resolve index in the new conversation's items
      const newItemIndex = newConv.rootMessageThread.findIndexByItemId(itemId);
      if (newItemIndex < 0) {
        console.error('[Juggler] Item not found in new conversation');
        return;
      }
      newConv.deleteRangeWithCleanup(newConv.rootMessageThread, newItemIndex);

      // For user messages, restore the whole message (text + attachments)
      // into the composer. The branch clone copied the source's asset blobs
      // (server duplicateConversationFiles copies assets/), so the restored
      // refs resolve against the new conversation's asset store.
      if (item.get('type') === 'user') {
        setTimeout(() => {
          this._loadMessageIntoInput(newConv, item);
        }, 50);
      }
    }
  }

  /**
   * Duplicate a conversation, surfacing the conversation-cap message instead
   * of throwing when the limit is hit. Shared by the Cmd-D path and the
   * branch-from-message path so the cap behaves identically everywhere.
   * @param {import('./model/session.js').default} session
   * @param {string} conversationId
   * @returns {Promise<string|null>} New conversation ID, or null if not created
   * @private
   */
  async _duplicateConversationGuarded(session, conversationId) {
    if (session.conversations.size >= MAX_CONVERSATIONS) {
      await /** @type {any} */ (window).showAlert(
        CONVERSATION_LIMIT_MESSAGE,
        'Too many conversations'
      );
      return null;
    }
    return await session.duplicateConversation(conversationId);
  }

  /**
   * Handle duplicate conversation - creates a full copy and switches to it
   * @private
   */
  async _handleDuplicateConversation() {
    if (!this._connectionManager) {
      console.error('[Juggler] Cannot duplicate: connection manager not initialized');
      return;
    }

    const session = this._connectionManager.getSession();
    if (!session) {
      console.error('[Juggler] Cannot duplicate: session not initialized');
      return;
    }

    const conversation = session.getVisibleConversation();
    if (!conversation) {
      console.error('[Juggler] No active conversation to duplicate');
      return;
    }

    const newId = await this._duplicateConversationGuarded(session, conversation.id);
    if (newId) {
      session.switchConversation(newId);
    }
  }

  /**
   * Restore a stored user message into the conversation's composer as an
   * editable draft, preserving any existing draft text in history first.
   *
   * A message is a single unit — its text AND its image attachments — so this
   * takes the message item (or a plain {content, attachments} record) and
   * restores the whole thing. Callers (rewind, branch) hand over the item
   * intact and never reach into individual fields; that is what keeps a new
   * message field (e.g. another attachment kind) from having to be threaded
   * through every move/restore site by hand.
   * @param {import('./model/conversation.js').default} conversation - The conversation
   * @param {{get?: (k:string)=>any, content?: string, attachments?: any}} message - The user message item (Y.Map) or a plain record
   * @private
   */
  _loadMessageIntoInput(conversation, message) {
    // Access input box through the tab element
    const tabElement = conversation.getTabElement();
    if (!tabElement) return;
    const inputBox = tabElement.getInputBox();
    if (!inputBox) return;

    // Pull the message's fields whether it's a Y.Map item or a plain record.
    const read = (/** @type {string} */ key) =>
      (message && typeof message.get === 'function') ? message.get(key) : /** @type {any} */ (message)?.[key];
    const text = read('content') || '';
    const attachments = normalizeAttachments(read('attachments'));

    const textarea = inputBox.querySelector('textarea');
    if (textarea) {
      // Save any existing draft to history before overwriting
      const existingText = textarea.value.trim();
      if (existingText && this._connectionManager) {
        const session = this._connectionManager.getSession();
        if (session) {
          session.addMessageToHistory(existingText);
        }
      }

      textarea.value = text;
      // @ts-ignore - autoResize exists on InputBox custom element
      inputBox.autoResize(textarea);
      textarea.focus();
    }
    // Restore staged image attachments. Always call so restoring a message
    // with no attachments also clears any previously-staged attachments.
    if (typeof (/** @type {any} */ (inputBox).setPendingAttachments) === 'function') {
      /** @type {any} */ (inputBox).setPendingAttachments(attachments);
    }
  }

  /**
   * Check if LLM is currently active
   * @returns {boolean} True if LLM operation is in progress
   */
  isLLMActive() {
    return this._llmState ? this._llmState.isActive : false;
  }

  /**
   * Check if any actions are currently running (e.g. re-run of a tool)
   * @returns {boolean} True if any actions are in progress
   */
  hasRunningActions() {
    return actionExecutor.hasRunningActions();
  }

  /**
   * True if Escape should fire `cancelLLMOperation`. Catches three states:
   * (1) an LLM turn is streaming, (2) a tool action is running outside a
   * turn (e.g. user-triggered re-run), (3) the worker is parked in
   * `activity='awaiting_llm'` waiting for a tool result. (3) is the case
   * where the engine has claimed a tool but its execute() promise is stuck
   * — without this branch, Escape was a no-op and the user couldn't cancel.
   * @returns {boolean} True when Escape should invoke `cancelLLMOperation`
   */
  shouldHandleEscape() {
    if (this.isLLMActive()) return true;
    if (this.hasRunningActions()) return true;
    const session = this._connectionManager?.getSession?.();
    const conv = session?.getVisibleConversation?.();
    if (conv?.processingState?.activity === 'awaiting_llm') return true;
    return false;
  }

  /**
   * Cancel the current LLM operation.
   *
   * Vantage-aware. Stopping from a sub-thread's OWN vantage (Escape while
   * focused in it, its footer Stop / header Cancel) INTERRUPTS it: the worker
   * turn is preempted but the thread stays open, so its input box stays put and
   * the user can keep interacting with it. Stopping from the root/parent vantage
   * stops everything AND closes the open sub-threads (so the input box returns
   * to the root column).
   * @param {string|null} [focusedThreadId] - Thread id of the column the stop
   *   came from (null = root). When omitted/undefined the vantage is unknown and
   *   we fall back to interrupting whichever sub-thread is the live processing
   *   column — so a bare Escape interrupts a running child rather than closing it.
   * @param {{polite?: boolean, toggle?: boolean}} [opts] - When `polite` is true,
   *   request a non-destructive Pause instead of a hard cancel: the current step
   *   finishes and records its real result, then the worker rests at idle before
   *   the next LLM turn. Nothing is cancelled, interrupted, or closed, so the
   *   vantage routing below is skipped entirely (polite is vantage-uniform). When
   *   `toggle` is also true (the Pause button, NOT shift+Escape), a polite request
   *   that arrives while a Pause is already pending cancels it instead — clicking
   *   Pause twice turns it back off.
   */
  async cancelLLMOperation(focusedThreadId = undefined, { polite = false, toggle = false } = {}) {
    if (!this._connectionManager) {
      console.error('[Juggler] Cannot cancel: connection manager not initialized');
      return;
    }
    const session = this._connectionManager.getSession();
    if (!session) {
      console.error('[Juggler] Cannot cancel: session not initialized');
      return;
    }

    // Get visible conversation (the one being cancelled)
    const conversation = session.getVisibleConversation();
    if (!conversation) {
      console.error('[Juggler] Cannot cancel: no visible conversation');
      return;
    }

    // Polite stop (Pause): non-destructive, vantage-uniform. Return BEFORE any
    // destructive branch — it must not cancel approvals, kill actions, stamp a
    // "Cancelled" message, or close sub-threads. The worker latches it and rests
    // at idle at the next boundary; the local cue keeps the Pause button active.
    if (polite) {
      // Toggle sources (the Pause button) cancel a pause that is already pending:
      // a second click turns Pause back off. Non-toggle sources (shift+Escape)
      // only ever request a pause — pressing the shortcut again re-affirms the
      // pending pause rather than cancelling it.
      if (toggle && conversation.isPolitePending()) {
        conversation.cancelPoliteStop();
      } else {
        conversation.requestPoliteStop();
        // Learn-by-doing: retire the onboarding tip the moment the shift+Escape
        // shortcut is actually used (not the Pause button, which is toggle:true).
        if (!toggle) markSeen('pause-conversation');
      }
      return;
    }

    // Sub-thread vantage → interrupt (leave open). Checked FIRST because the
    // unknown-vantage fallback reads the live status threadId, which the stops
    // below would clear.
    if (focusedThreadId === undefined) {
      // Unknown vantage: interrupt the live processing sub-thread if there is one.
      if (await conversation.cancelActiveTurn()) {
        if (this._llmState) this._llmState.stop(conversation.id);
        return;
      }
      focusedThreadId = null; // nothing running in a child → treat as root vantage
    } else if (focusedThreadId) {
      const threadItem = conversation.findItemById(focusedThreadId);
      if (threadItem && threadItem.get?.('type') === 'thread') {
        await conversation.interruptThread(threadItem);
        if (this._llmState) this._llmState.stop(conversation.id);
        return;
      }
    }

    // Capture state before cancellation - don't use for early return!
    // Actions can be running even if LLM is not officially "processing"
    // (e.g., orphaned retries where user retried a cancelled action from history,
    // or a "Re-run command" click that runs outside any LLM turn).
    const wasProcessing = this._llmState?.isConversationProcessing(conversation.id) ?? false;
    const wasRunningActions = actionExecutor.hasRunningActions();
    // Worker is in the post-tool "awaiting_llm" branch when activity is set
    // but no LLM is streaming (e.g. between a rerun's claim and its result).
    // `handleCancel` (worker.go) already does the right thing for that branch
    // — we just need to send it the cancel signal.
    const isAwaitingLLM = conversation.processingState?.activity === 'awaiting_llm';

    // Always cancel pending approval dialogs for this conversation
    conversation.cancelAllPendingApprovals();

    // Always cancel running actions (shells, etc.) regardless of LLM state
    // This ensures actions are stopped during orphaned retries
    actionExecutor.cancelAllActions();

    if (wasProcessing) {
      // Mid-turn cancel: add the user-facing cancellation message AND
      // tell the worker (addCancellationMessage → stopProcessing).
      conversation.addCancellationMessage();
    } else if (wasRunningActions || isAwaitingLLM) {
      // Rerun-stuck branch: the LLM isn't streaming so we don't want a
      // user-facing "Cancelled" message, but the worker is sitting in
      // activity='awaiting_llm' with the tool-action still un-terminated.
      // stopProcessing sends the WS cancel that drives the worker's
      // CancelInFlightToolActions → writes state='cancelled'.
      conversation.stopProcessing();
    }

    // Root/parent vantage: close any open sub-threads so the input box returns
    // to the root column (their worker turn was just preempted above).
    conversation.closeOpenSubThreads();

    // Always ensure clean LLM state - stop() is idempotent
    // This resets the UI even if we weren't officially "processing"
    if (this._llmState) {
      this._llmState.stop(conversation.id);
    }
  }

  /**
   * Cleanup all resources and event listeners
   */
  destroy() {
    // Cleanup services
    scheduledSendService.stop();
    if (this._strategySwitcher) {
      this._strategySwitcher.destroy();
    }
    if (this._uiEventManager) {
      this._uiEventManager.destroy();
    }
    if (this._connectionManager) {
      this._connectionManager.destroy();
    }
  }
}

// Initialize app when script loads
const app = new JugglerApp();

// Export for debugging
window.jugglerApp = app;

// Test mode: poll for pending tests and navigate to headless-test.html to run them
if (window.JUGGLER_TEST_MODE) {
  setInterval(async () => {
    try {
      const resp = await fetch('/api/test/pending');
      if (resp.status === 204) return;
      const entry = await resp.json();
      if (entry.name === '__list__') {
        window.location.href = '/headless-test?list=1';
      } else if (entry.taskId) {
        let url = `/headless-test?task=${encodeURIComponent(entry.taskId)}&projectPath=${encodeURIComponent(entry.projectPath)}&quiet=true`;
        if (entry.model) url += `&model=${encodeURIComponent(entry.model)}`;
        if (entry.provider) url += `&provider=${encodeURIComponent(entry.provider)}`;
        window.location.href = url;
      } else {
        window.location.href = `/headless-test?test=${encodeURIComponent(entry.name)}&projectPath=${encodeURIComponent(entry.projectPath)}`;
      }
    } catch (_) { /* ignore fetch errors */ }
  }, 200);
}
