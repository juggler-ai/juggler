//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @typedef {import('./services/api.js').Message} Message
 * @typedef {import('./services/response-handler.js').default} ResponseHandler
 * @typedef {import('./model/session.js').default} Session
 * @typedef {import('./model/message-thread.js').MessageThread} MessageThread
 * @typedef {import('./services/websocket.js').ServerFrame} ServerFrame
 */

/**
 * The `<conversation-bar>` as this file uses it.
 * @typedef {HTMLElement & {getTabElement?: (conversationId: string) => import('./components/conversation-tab.js').default|null}} ConversationBarElement
 */

/**
 * A page-level element the session is handed to once it exists.
 * @typedef {Element & {setSession?: (session: Session) => void}} SessionAwareElement
 */

/**
 * A conversation-scoped reply from the server: no `type` of its own, recognised
 * by its shape — an `error`, or the `blocks`/token counts of a final response.
 * @typedef {object} ConversationReplyFrame
 * @property {string} [type] - Absent, or a type no handler claims
 * @property {string} [conversationId] - Conversation it is for
 * @property {string|null} [threadItemId] - Thread column it is for; absent for the root
 * @property {string|boolean} [error] - The error text, or true with the text in `message`
 * @property {string} [message] - Error text when `error` is true
 * @property {unknown} [blocks] - Structured response blocks
 * @property {number} [inputTokens] - Input token count
 * @property {number} [outputTokens] - Output token count
 * @property {number} [cachedTokens] - Cached token count
 */

/**
 * The `context-item-action` event's detail (properties-panel.js).
 * @typedef {{action: string, itemId: string, threadItemId?: string|null}} ContextItemActionDetail
 */

import LLMState from './services/llm-state.js';
import ConnectionManager from './services/connection-manager.js';
import DisconnectionOverlay from './components/disconnection-overlay.js';
import { watchForLostServer } from './services/server-lost.js';
import StartupOverlay from './components/startup-overlay.js';
import { setAppPhase } from './services/app-phase.js';
import UIEventManager from './services/ui-event-manager.js';
import StrategySwitcher from './services/strategy-switcher.js';
import { ModelCycler, ThinkingCycler } from './services/model-cycler.js';
import wsService from './services/websocket.js';
import { openSettings } from './services/settings-launcher.js';
import { startSetupWizard, ONBOARDING_DISMISSED_PREF } from './components/onboarding/setup-wizard.js';
import { getUserPref, setUserPref } from './services/prefs.js';
import {
  reloadRegistries,
  initAllRegistries,
  collectFailedModules,
  newlyFailedModules,
  anyLocalConversationBusy,
} from './registries/reload-registries.js';
import commandRegistry from './registries/command-registry.js';
import actionExecutor from './services/action-executor.js';
import workerManager from './services/worker-manager.js';
import { CLOSE_FLUSH_ACK_TIMEOUT_MS } from './utils/constants.js';
import providersCache from './services/providers-cache.js';
import { setupHeaderControls } from './components/header-controls.js';
import { registerConversationShortcuts } from './components/shortcut-bindings.js';
import { recordUsage } from './services/guidance/usage-signals.js';
import { updateWindowTitle } from './utils/window-title.js';
import { initAttention } from './utils/attention-manager.js';
import { watchTurnsForEscape, provideEscapeApp } from './services/escape-behaviour.js';
import { provideAppSession } from './utils/app-session.js';
import { initViewportFit } from './utils/viewport-fit.js';
import { reportDraftsFlushed } from '../sdk/lib/window-control.js';
import { installLinkGuard } from './services/link-guard.js';
import { installFileRefLinks } from './services/file-ref-links.js';
import { installSelectionContainment } from './services/selection-containment.js';
import { installFocusModality } from './services/focus-modality.js';
import { isPinboardView } from './utils/view-mode.js';
import { isAnyPopupOpen } from './utils/popup-manager.js';
import { createUILocaleReloader, reportUILocale } from './services/ui-locale.js';
import './services/tooltip-manager.js'; // styled hover/focus tooltips (self-installs on import)
import { MAX_CONVERSATIONS } from './model/session.js';
import { normalizeAttachments } from './utils/attachments.js';
import { itemField } from '../sdk/lib/message.js';
import { showNotice } from './components/modal-dialog.js';
import { failedModulesMessage, showConversationLimitAlert } from './services/app-notices.js';
import { SESSION_MESSAGE_HANDLERS } from './protocol/session-message-handlers.js';
import { markUntranslated } from '../sdk/lib/i18n.js';
import { openCommandManager } from './components/command-editor-dialog.js';
import { exportConversation } from './components/conversation-export-dialog.js';
import { setFaultSink, reportFault } from './utils/fault-report.js';
import { startWordOfMouth } from './components/word-of-mouth.js';

/**
 * Route this page's faults to the app log, and catch the ones nothing else
 * does.
 *
 * At module scope, and before anything else runs, because a fault during
 * startup is exactly the one with no other way to be seen: this window's
 * console cannot be opened in a release build, so a throw that reaches only
 * console.error reaches nobody, and the reader is left with a log showing a
 * server that behaved perfectly.
 */
setFaultSink(({ source, message, stack, detail }) => {
  const convId = detail && 'convId' in detail ? detail.convId : undefined;
  wsService.sendViewerFault({
    source,
    message,
    stack,
    convId: typeof convId === 'string' ? convId : undefined,
    detail: detail ? JSON.stringify(detail) : undefined
  });
});

window.addEventListener('error', (event) => {
  reportFault('window-error', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  reportFault('unhandledrejection', event.reason);
});



/**
 * Failure snapshot from the last registry reload. Held at module scope so the
 * hot-reload notice can announce only what has newly broken.
 * @type {Map<string, string>}
 */
let lastFailedModules = new Map();

/** How long a failed-reload notice stays up: longer than the default, since it carries an error to read. */
const RELOAD_FAILURE_NOTICE_MS = 10000;

/**
 * Announce capability modules that failed to load in the reload just finished.
 * A failed import leaves no other trace in the UI — the capability is simply
 * absent from the registry — so without this an extension being edited can stop
 * working with nothing said. Only NEW failures are shown: a reload that changed
 * nothing about an already-broken extension stays quiet.
 */
function reportNewlyFailedModules() {
  const current = collectFailedModules();
  const fresh = newlyFailedModules(lastFailedModules, current);
  lastFailedModules = current;
  if (fresh.length === 0) return;

  showNotice(failedModulesMessage(fresh), { duration: RELOAD_FAILURE_NOTICE_MS });
}

/**
 * Main Juggler Application
 *
 * Slim coordinator that delegates to specialized services.
 * Each service handles a single responsibility.
 * @class
 */
class JugglerApp {
  constructor() {
    /** @type {ConversationBarElement|null} @private */
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
    /** @type {ModelCycler|null} @private */
    this._modelCycler = null;
    /** @type {ThinkingCycler|null} @private */
    this._thinkingCycler = null;
    /** @type {StartupOverlay|null} @private */
    this._startupOverlay = null;

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

  /**
   * Flush every composer's pending draft into its Yjs doc.
   * @returns {Set<string>} conversation ids that had unsaved keystrokes, i.e.
   *   the ones this call rescued. Callers tearing the page down force those to
   *   disk; the rest were already persisted when the user last stopped typing.
   * @private
   */
  flushComposerDrafts() {
    /** @type {Set<string>} */
    const rescued = new Set();
    document.querySelectorAll('composer-box').forEach((box) => {
      if (typeof box.flushDraft === 'function') {
        const convId = box.flushDraft();
        if (convId) rescued.add(convId);
      }
    });
    return rescued;
  }

  /**
   * Handle the native host's warning that this window is about to close: rescue
   * every pending draft, force the affected conversations to disk, then tell the
   * host it may proceed.
   *
   * The host blocks on that reply, so this must always answer — hence the short
   * per-conversation timeout and allSettled rather than all(). A worker that
   * can't be reached costs its slice of the budget and nothing more; the host
   * bounds the total wait anyway and quits on expiry.
   * @param {string} [token] - Ack token identifying the host's announcement.
   * @private
   */
  async _flushDraftsForClose(token) {
    const rescued = this.flushComposerDrafts();
    // Comfortably inside the host's wait: it would rather quit with a draft in
    // flight than hang on a wedged worker.
    await Promise.allSettled(
      [...rescued].map((id) => workerManager.flushPersistence(id, CLOSE_FLUSH_ACK_TIMEOUT_MS))
    );
    if (token) await reportDraftsFlushed(token);
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
    // While hidden we set data-doc-hidden, which the stylesheet turns into
    // `animation-play-state: paused !important` on everything (power saving).
    // The catch: on a Cmd-Tab back to the app, macOS WKWebView fires window
    // `focus` but NOT `visibilitychange`, so relying on visibilitychange alone
    // leaves the attribute stuck set — and because the pause is `!important`,
    // EVERY animation stays frozen, including spinners created after you return
    // (no display/reflow trick can override `!important`). So the window-`focus`
    // clear below is load-bearing, not a nicety: focus means we're visible, so
    // drop the attribute unconditionally and animations resume immediately.
    document.addEventListener('visibilitychange', () => {
      document.documentElement.toggleAttribute('data-doc-hidden', document.hidden);
    });
    window.addEventListener('focus', () => {
      document.documentElement.removeAttribute('data-doc-hidden');
    });
    document.documentElement.toggleAttribute('data-doc-hidden', document.hidden);
  }

  /** @private */
  async setup() {
    // First thing, ahead of the component lookup and the registry boot below:
    // the host announces a close as soon as the user asks for one, which can be
    // before either has finished, and it waits on the answer. A window closed
    // while booting still has drafts worth rescuing, and _flushDraftsForClose
    // reaches for the composers and the worker only when it runs.
    //
    // Answered in every mode. A detached board has no drafts to flush, but the
    // host waits for an answer either way, so silence here would be charged to
    // every window close.
    window.addEventListener('juggler:window-close-requested', (e) => {
      const token = /** @type {CustomEvent} */ (e).detail?.ackToken;
      void this._flushDraftsForClose(token);
    });

    // Take over the overlay index.html painted before the first frame, and keep
    // it until the session is loaded. It follows the phase itself, so the rest
    // of this method only has to say where it has got to.
    this._startupOverlay = new StartupOverlay();
    this._startupOverlay.show();

    // Get component references. contextPanel, conversationArea, and
    // conversationControls are per-tab, not global.
    this.conversationBar = document.querySelector('conversation-bar');

    if (!this.conversationBar) {
      console.error('[Juggler] Failed to find required components');
      // Nothing below will run, so nothing below will take the overlay down.
      // Whatever is wrong here, a window dimmed for good is not the way to
      // report it.
      setAppPhase('ready');
      return;
    }

    // Boot all capability registries in dependency order and signal
    // registries-ready once the attempt settles — even on failure, so the
    // system-prompt gate can never permanently hang a turn.
    setAppPhase('extensions');
    await initAllRegistries();
    // Baseline for the reload notices below: whatever is already broken at boot
    // is the user's status quo, not news.
    lastFailedModules = collectFailedModules();

    // A detached board has no composer to switch a strategy, model or thinking
    // level for. Everything skipped in this mode is skipped because the surface
    // it acts on is not here — see utils/view-mode.js.
    if (!isPinboardView()) {
      // Initialize strategy switcher (Shift+Tab keyboard shortcut)
      this._strategySwitcher = new StrategySwitcher();
      this._strategySwitcher.init();

      // Same hold-to-cycle gesture for models (⌥⌘M / Ctrl+Alt+M) and thinking
      // levels (⌥⌘T / Ctrl+Alt+T)
      this._modelCycler = new ModelCycler();
      this._modelCycler.init();
      this._thinkingCycler = new ThinkingCycler();
      this._thinkingCycler.init();
    }

    // Listen for plugin file changes (hot reload). The reload itself is silent:
    // the user edited the file, so being told it changed is no news. Only a
    // capability that would not load is worth interrupting for.
    //
    // The user commands are re-read at once, before the full rebuild: that
    // waits for any running turn to end, and a command the define_command tool
    // just wrote mid-turn should not. One cheap fetch, so it is not worth
    // working out from the path whether a command file is what changed.
    wsService.on('plugin-changed', async () => {
      void commandRegistry.refreshUserCommands();
      console.info('[Juggler] Plugin changed — reloading registries');
      await reloadRegistries();
      console.info('[Juggler] Plugin registries reloaded');
      reportNewlyFailedModules();
    });

    // A UI language chosen in another window reaches this one as a settings
    // broadcast; the page is reloaded into it once nothing is running, open or
    // being typed. Drafts go to disk first, as on a window close.
    const localeReloader = createUILocaleReloader({
      isBusy: anyLocalConversationBusy,
      isModalOpen: isAnyPopupOpen,
      hasUnsavedDraft: () => Array.from(document.querySelectorAll('composer-box'))
        .some((box) => box.hasUnsavedDraft?.() === true),
      reload: () => {
        void this._flushDraftsForClose().finally(() => window.location.reload());
      },
    });
    // A page served in the language its URL names (?uiLocale=, which only a
    // test server honours — serveIndex) keeps that language whatever the
    // setting says; the server marks such a page data-ui-locale-pinned.
    const localePinned = document.documentElement.hasAttribute('data-ui-locale-pinned');
    wsService.on('settings-changed', (settings) => {
      if (localePinned) return;
      const uiLocale = settings && typeof settings === 'object' && 'uiLocale' in settings ? settings.uiLocale : undefined;
      localeReloader.update(typeof uiLocale === 'string' ? uiLocale : '');
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

    // Safety net for anchors in rendered markdown: without it a click on one
    // navigates the app's window off its own page. See services/link-guard.js.
    installLinkGuard(document);

    // File paths a reply names in backticks pin that file when clicked. See
    // services/file-ref-links.js.
    installFileRefLinks(document);

    // Keep a mis-aimed swipe from highlighting the whole window: a drag begun on
    // chrome selects nothing, and one begun in a column stays in that column.
    // See services/selection-containment.js.
    installSelectionContainment(document);

    // Show the focus ring only to someone using the keyboard: WebKit shows it
    // on the app's own focus() calls until a click first focuses a text field.
    // See services/focus-modality.js.
    installFocusModality(document);

    if (!isPinboardView()) {
      document.addEventListener('duplicate-conversation', () => {
        this._handleDuplicateConversation();
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
      // A detached board is excluded: it has no composer and no scroll position
      // of its own, and the session state this writes — which conversation is
      // active — belongs to the window the user actually works in.
      window.addEventListener('pagehide', () => {
        const session = this._connectionManager?.getSession();
        if (session) {
          this.flushComposerDrafts();
          // Save scroll positions for all conversations before page close
          session.conversations.forEach((conversation) => {
            const tab = this._tabFor(conversation);
            const conversationArea = tab?.getConversationArea();
            if (conversationArea) {
              // @ts-ignore - saveScrollPositionImmediately is a method on conversation-area
              conversationArea.saveScrollPositionImmediately();
            }
          });
          // Use saveImmediately to bypass debounce on page close
          session.persistence.saveImmediately();
        }
      });
    }

    // Setup WebSocket connection and initialize session
    if (this._connectionManager) {
      setAppPhase('connecting');
      await this._connectionManager.setup();
    } else {
      // No connection manager means no session load, and so nothing that would
      // ever declare the app started.
      setAppPhase('ready');
    }
  }

  /**
   * The live session, for the handful of callers that are not handed one
   * (settings tabs, the plugin catalog, the registry reloader), which ask
   * utils/app-session.js — provided from this. Null before the session loads.
   * @returns {import('./model/session.js').default|null} The session, or null.
   */
  getSession() {
    return this._connectionManager?.getSession() ?? null;
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
    // contextPanel, conversationArea, conversationControls, and composer are per-tab.
    if (!this.conversationBar) {
      throw new Error('All UI components are required');
    }
    this._connectionManager = new ConnectionManager({
      conversationBar: this.conversationBar,
      disconnectionOverlay: new DisconnectionOverlay(),
      showPersistentNotice: (message) => showNotice(message, { duration: 0 }),
      llmState: this._llmState,
      onServerMessage: (data) => this._handleServerMessage(data),
      onSessionInitialized: () => this._initializeSessionServices(),
      // Services for Conversation instances. conversationArea and
      // conversationControls come from each conversation's own tab.
      services: {
        llmState: this._llmState,
        actionExecutor: actionExecutor,
        workerManager,
        wsService: wsService
      }
    });
    // A desktop window onto a server by URL stops reconnecting after a minute
    // and asks the app for its "can't reach the server" stand-in instead.
    watchForLostServer();

    // Initialize UI event manager with callbacks. UI elements are per-tab, so
    // UIEventManager listens at document level.
    this._uiEventManager = new UIEventManager({
      onSendMessage: (message, threadItemId, messageThread, attachments, skills, schedule) => this._sendMessage(message, threadItemId, messageThread, attachments, skills, schedule),
      onContextItemAction: (detail) => this._handleContextItemAction(/** @type {ContextItemActionDetail} */ (detail))
    });
  }

  /**
   * The live session, or null before the app is wired up. Every entry point
   * that acts on the session needs the same two guards; `action` names the
   * caller's job in the diagnostic ("Cannot <action>: session not initialized").
   * @param {string} action - What the caller was about to do
   * @returns {import('./model/session.js').default|null} The session, or null when unavailable
   * @private
   */
  _requireSession(action) {
    if (!this._connectionManager) {
      console.error(`[Juggler] Cannot ${action}: connection manager not initialized`);
      return null;
    }
    const session = this._connectionManager.getSession();
    if (!session) {
      console.error(`[Juggler] Cannot ${action}: session not initialized`);
      return null;
    }
    return session;
  }

  /**
   * The session plus the conversation the user is looking at — what every
   * visible-conversation command (rollback, branch, duplicate, cancel) needs
   * before it can do anything.
   * @param {string} action - What the caller was about to do
   * @returns {{session: import('./model/session.js').default, conversation: import('./model/conversation.js').default}|null} Pair, or null when unavailable
   * @private
   */
  _requireVisibleConversation(action) {
    const session = this._requireSession(action);
    if (!session) return null;
    const conversation = session.getVisibleConversation();
    if (!conversation) {
      console.error(`[Juggler] Cannot ${action}: no visible conversation`);
      return null;
    }
    return { session, conversation };
  }

  /**
   * Initialize session-dependent services
   * Called after session is created
   * @private
   */
  _initializeSessionServices() {
    const session = this._requireSession('initialize session services');
    if (!session) return;

    // Services are set on the session by ConnectionManager before loading.
    // Each Conversation owns its own ResponseHandler, created with the
    // Conversation instance.

    // Give UI event manager access to session
    if (this._uiEventManager) {
      this._uiEventManager.setSession(session);
    }

    // A turn coming to rest settles the Escape key, so a press meant to stop it
    // that lands a beat late neither clears the draft nor leaves fullscreen.
    watchTurnsForEscape(session);

    // A detached board is a second view of a window that is already doing all
    // of this: alerting for the same conversations and answering the same conversation shortcuts. Doing
    // it twice would be heard twice.
    if (!isPinboardView()) {
      // Alert (chime + tab flash + dock/tab notification) when a conversation needs
      // attention while unwatched.
      initAttention(session);

      // Attach the conversation-level keyboard command handlers (new/bin/jump/
      // toggle-file-editing) and install the global shortcut dispatcher.
      registerConversationShortcuts(session);

      // Count days of use and, once, ask the user to spread the word
      // (components/word-of-mouth.js).
      void startWordOfMouth();
    }

    // Wire global header controls (undo/redo + project path)
    setupHeaderControls(session);

    // Name the native OS window after the session's project so the macOS
    // "Window" menu and the Windows/Linux taskbar can tell windows apart
    // (project switches reload the page, so session:loaded carries the
    // current path each time).
    const syncWindowTitle = () => updateWindowTitle(session.projectPath || '');
    // The native host's menus and dialogs follow this page's language.
    reportUILocale();
    session.subscribe((event) => {
      if (event.type === 'session:loaded') syncWindowTitle();
      // A command (/commands) asked for the manager: the model only announces
      // it, because the dialog is app-level UI.
      else if (event.type === 'command-manager:open-requested') openCommandManager();
      // /export asked for its conversation's export dialog, likewise.
      else if (event.type === 'conversation-export:open-requested') {
        const conversation = session.getConversation(event.data?.conversationId || '');
        if (conversation) void exportConversation(conversation);
      }
    });
    syncWindowTitle();

    // Wire the no-project overlay to the session so it can show/hide
    // based on whether a project is loaded.
    const overlay = /** @type {SessionAwareElement|null} */ (document.querySelector('no-project-overlay'));
    if (overlay && typeof overlay.setSession === 'function') {
      overlay.setSession(session);
    }

    // Its counterpart for a loaded project whose last conversation was binned.
    const noConversations = /** @type {SessionAwareElement|null} */ (document.querySelector('no-conversations-overlay'));
    if (noConversations && typeof noConversations.setSession === 'function') {
      noConversations.setSession(session);
    }

    // The panel a selected workspace box shows in place of a conversation.
    const workspacePanel = /** @type {SessionAwareElement|null} */ (document.querySelector('workspace-panel'));
    if (workspacePanel && typeof workspacePanel.setSession === 'function') {
      workspacePanel.setSession(session);
    }

    // Wire the pinboard shell to the session: it resolves the active context its
    // pins render against, and fetches the project's board once there is one.
    const pinboard = /** @type {SessionAwareElement|null} */ (document.querySelector('pinboard-shell'));
    if (pinboard && typeof pinboard.setSession === 'function') {
      pinboard.setSession(session);
    }

    // First-run walkthrough — best-effort, never blocks startup. Not in a
    // detached board: it is opened from a window that is already past it.
    if (!isPinboardView()) {
      void this._maybeShowOnboarding();
    }
  }

  /**
   * Show the first-run walkthrough whenever no AI provider is configured yet.
   * An unconfigured Juggler can't do anything, so we prompt on every launch until
   * a provider exists — provider presence IS the completion signal. The one way
   * to stop being asked is to say so, which is what ONBOARDING_DISMISSED_PREF
   * records: someone who has decided not to connect anything yet is not helped
   * by being asked again every launch.
   * @private
   */
  async _maybeShowOnboarding() {
    try {
      // Wait for the SETTLED provider list, not the connect seed: the seed arrives
      // before the server has computed availability, so gating on it would misread a
      // fully-configured user as having no provider. The first refresh always runs
      // at startup, so this resolves shortly after launch.
      await providersCache.waitForReady();

      // A provider is configured — Juggler is usable, nothing to prompt.
      if (providersCache.hasAvailableProvider()) return;

      if (await getUserPref(ONBOARDING_DISMISSED_PREF, false)) return;

      const outcome = await startSetupWizard({ openProviderSettings: openSettings });
      // Only an explicit "don't ask again" is remembered. Dismissing the window
      // means "not now", and a machine that still cannot run anything should
      // still say so next launch.
      if (outcome === 'dismissForever') await setUserPref(ONBOARDING_DISMISSED_PREF, true);
    } catch {
      /* onboarding is best-effort; never block or crash startup */
    }
  }

  /**
   * Send a message to the LLM
   * @param {string} message - User message
   * @param {string|null} [threadItemId] - Thread item ID if sending from a thread column
   * @param {MessageThread|null} [messageThread] - Column-scoped message thread
   * @param {Array<{id:string,mime:string,filename:string,bytes:number,width:number,height:number}>} [attachments] - Staged image attachments
   * @param {string[]} [skills] - Agent Skill names the user explicitly chose to load before this turn
   * @param {import('./model/conversation.js').SendSchedule|null} [schedule] - Holds the send for later ("Send later")
   * @private
   * @async
   */
  async _sendMessage(message, threadItemId, messageThread, attachments, skills, schedule) {
    const conversation = messageThread?.conversation;
    if (!conversation) {
      console.error('[Juggler] Cannot send message: no target conversation');
      return;
    }

    // The conversation owns its own handlers and manages everything;
    // validation (including model selection) happens inside sendMessage().
    const refusal = await conversation.sendMessage(message, threadItemId, messageThread, { attachments: attachments || [], skills: skills || [], schedule: schedule || undefined });
    // This is the composer's send path — a message the user wrote — so an
    // accepted one that is not a slash command is a use of the app.
    if (refusal === null && !String(message || '').startsWith('/')) recordUsage('composer:send');
  }

  /**
   * Handle server message
   * @param {ServerFrame|ConversationReplyFrame} frame - Server message data
   * @private
   */
  async _handleServerMessage(frame) {
    const session = this._requireSession('handle message');
    if (!session) return;

    // Session-scoped frames carry no conversationId; they are handled before
    // the lookup below. The table is typed per key, so it is looked up as the
    // row for whichever frame type this one names: a handler found under a
    // type is the handler for the frame of that type.
    const sessionHandlers = /** @type {Record<string, ((session: Session, data: ServerFrame) => void)|undefined>} */ (SESSION_MESSAGE_HANDLERS);
    const sessionHandler = frame.type === undefined ? undefined : sessionHandlers[frame.type];
    if (sessionHandler) {
      sessionHandler(session, /** @type {ServerFrame} */ (frame));
      return;
    }
    const data = /** @type {ConversationReplyFrame} */ (frame);

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

    // Conversation-scoped messages are recognised by shape, not by type.
    if (data.error) {
      // Error - backend may send {error: true, message: "..."} or {error: "message"}
      let errorMsg;
      if (typeof data.error === 'string') {
        errorMsg = data.error;
      } else if (data.message) {
        errorMsg = data.message;
      } else {
        // Diagnostic only: handleError logs it; the error item the user sees
        // is written by the Go worker.
        errorMsg = markUntranslated('Connection error - request failed');
      }
      conversation.handleError(errorMsg);
    } else if ('blocks' in data || 'inputTokens' in data) {
      // Final response - structured blocks with token counts. The worker
      // handles LLM calls directly; this path serves the main-thread fallback
      // (e.g. claudecode provider callbacks).
      const messageThread = conversation.resolveMessageThread(data.threadItemId);
      conversation.handleResponse(messageThread, {
        inputTokens: data.inputTokens || 0,
        outputTokens: data.outputTokens || 0,
        cachedTokens: data.cachedTokens || 0
      });
    } else {
      // Unknown message format - log and notify user
      console.error('[Juggler] Unexpected message format from server:', data);
      conversation.handleError(markUntranslated('Received unexpected message format from server'));
    }
  }

  /**
   * Handle context item action
   * @param {ContextItemActionDetail} detail - Action detail
   * @returns {Promise<void>}
   * @private
   */
  async _handleContextItemAction(detail) {
    const { action, itemId, threadItemId } = detail;

    const session = this._requireSession('handle context item action');
    if (!session) return;

    const conversation = session.getVisibleConversation();
    if (!conversation) return;

    // Update session (auto-saves!). `resolveMessageThread` returns the root
    // thread for a null/absent threadItemId, so one call covers both the root
    // and thread columns.
    switch (action) {
      case 'remove':
      case 'delete':
        try { conversation.resolveMessageThread(threadItemId).removeContextItem(itemId); } catch { /* not deletable */ }
        break;
      case 'refresh':
        await conversation.resolveMessageThread(threadItemId).refreshContextItem(itemId);
        break;
    }
  }

  /**
   * The tab showing a conversation in this window, from the tab bar that owns
   * the tabs.
   * @param {import('./model/conversation.js').default} conversation - The conversation
   * @returns {import('./components/conversation-tab.js').default|null} Its tab, or null when it has none
   * @private
   */
  _tabFor(conversation) {
    return this.conversationBar?.getTabElement?.(conversation.id) ?? null;
  }

  /**
   * Locate a message item in the conversation's ACTIVE column — the focused
   * thread column when there is one, the root thread otherwise — which is the
   * vantage every item-level command (rollback, branch) acts from.
   * @param {import('./model/conversation.js').default} conversation - Conversation owning the item
   * @param {string} itemId - Item ID to locate
   * @returns {{messageThread: MessageThread, itemIndex: number, item: import('../sdk/lib/message.js').Message}|null} Location, or null when the item is not in the active column
   * @private
   */
  _resolveActiveThreadItem(conversation, itemId) {
    const tab = this._tabFor(conversation);
    const messageThread = tab?.getActiveMessageThread?.() || conversation.rootMessageThread;
    const itemIndex = messageThread.findIndexByItemId(itemId);
    const item = /** @type {import('../sdk/lib/message.js').Message|undefined} */ (messageThread.items[itemIndex]);
    if (itemIndex < 0 || !item) return null;
    return { messageThread, itemIndex, item };
  }

  /**
   * Handle rollback from item ID - rollback to a user message and put its text in the input
   * @param {string} itemId - Item ID to rollback from
   * @private
   */
  _handleRollbackFromItem(itemId) {
    const target = this._requireVisibleConversation('rollback');
    if (!target) return;
    const { conversation } = target;

    const located = this._resolveActiveThreadItem(conversation, itemId);
    if (!located) {
      console.error('[Juggler] Item not found for id', itemId);
      return;
    }
    const { messageThread, itemIndex, item } = located;
    if (item.get('type') !== 'user') {
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
    const target = this._requireVisibleConversation('branch');
    if (!target) return;
    const { session, conversation } = target;

    const located = this._resolveActiveThreadItem(conversation, itemId);
    if (!located) {
      console.error('[Juggler] Item not found for id', itemId);
      return;
    }
    const { item } = located;

    // Duplicate the conversation (creates a clone with new ID). Exclusive: the
    // copy is cut below, so it must be this fork's alone — refused, not shared,
    // while another duplicate of the source is in flight.
    const newConvId = await this._duplicateConversationGuarded(session, conversation.id, { exclusive: true });
    if (!newConvId) {
      return;
    }

    // Switch to the new conversation
    session.switchConversation(newConvId);

    // Cut the copy at the fork point. Fork is offered only in the root column,
    // and the copy keeps every item id, so the item is found by id in its root.
    const newConv = session.getConversation(newConvId);
    if (newConv) {
      if (!newConv.cutAtForkPoint(itemId)) {
        console.error('[Juggler] Item not found in new conversation');
        return;
      }

      // For user messages, restore the whole message (text + attachments)
      // into the composer. The branch clone copied the source's asset blobs
      // (server duplicateConversationFiles copies assets/), so the restored
      // refs resolve against the new conversation's asset store. A fork at a
      // reply leaves the composer as it is, for the next message.
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
   * @param {{exclusive?: boolean}} [options] - Passed to Session.duplicateConversation
   * @returns {Promise<string|null>} New conversation ID, or null if not created
   * @private
   */
  async _duplicateConversationGuarded(session, conversationId, options) {
    if (session.conversations.size >= MAX_CONVERSATIONS) {
      await showConversationLimitAlert();
      return null;
    }
    return await session.duplicateConversation(conversationId, options);
  }

  /**
   * Handle duplicate conversation - creates a full copy and switches to it
   * @private
   */
  async _handleDuplicateConversation() {
    const target = this._requireVisibleConversation('duplicate');
    if (!target) return;
    const { session, conversation } = target;

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
   *
   * Everything the box has to do about it — preserving the overwritten draft,
   * the caret, the token mirror, the Send button, persistence — belongs to the
   * composer, so this only reads the message and hands it over.
   * @param {import('./model/conversation.js').default} conversation - The conversation
   * @param {import('../sdk/lib/message.js').Message|{content?: string, attachments?: import('./utils/attachments.js').AssetRef[]}} message - The user message item (Y.Map) or a plain record
   * @private
   */
  _loadMessageIntoInput(conversation, message) {
    const tabElement = this._tabFor(conversation);
    if (!tabElement) return;
    const composer = tabElement.getComposer();
    if (!composer) return;

    // The tab's composer is its `<composer-box>`.
    const content = itemField(message, 'content');
    /** @type {import('./components/composer.js').default} */ (composer).restoreMessage({
      content: typeof content === 'string' ? content : '',
      attachments: normalizeAttachments(itemField(message, 'attachments'))
    });
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
   * The conversation the user is looking at, or null before the session is up.
   * The public read for global gestures that act on "whatever is on screen" —
   * {@link shouldHandleEscape} asks it what is running, and the Escape-behaviour
   * service reads its pause latch to decide whether a second press escalates.
   * @returns {import('./model/conversation.js').default|null} The visible conversation, or null.
   */
  getVisibleConversation() {
    return this._connectionManager?.getSession?.()?.getVisibleConversation?.() ?? null;
  }

  /**
   * True if there is something for Escape to stop — the single "is this
   * conversation running" decision behind the stop rung of the Escape ladder
   * (escape-behaviour.js decides what the key then does with that answer).
   *
   * Scoped to the VISIBLE conversation, using the worker-authoritative
   * `processingState.activity` claim: the worker sets it to 'calling_llm' or
   * 'awaiting_llm' for exactly the span a turn is claimed on that conversation
   * (an LLM call is streaming, or a tool — including a re-run's — is mid-flight
   * with an LLM call still owed), and it reads back as none on idle AND on
   * terminal error/cancel. So Escape acts on a turn only while THIS conversation
   * is genuinely running, and takes its idle behaviour in every other case.
   *
   * Deliberately NOT `isLLMActive()`: that is the cross-conversation llmState
   * projection (`_statusMessages.size > 0`), true whenever ANY conversation has
   * a status entry — and a client-side value that can linger after a turn ends.
   * Using it here let a background turn (or a stale entry) swallow a mis-pressed
   * Escape meant to clear an idle composer.
   * @returns {boolean} True when the visible conversation has work Escape could stop.
   */
  shouldHandleEscape() {
    const conv = this.getVisibleConversation();
    const activity = conv?.processingState?.activity;
    if (activity === 'calling_llm' || activity === 'awaiting_llm') return true;
    // A tool action running outside a claimed turn (a "Re-run command" click) is
    // still cancellable even though no LLM turn is claimed on the conversation.
    if (this.hasRunningActions()) return true;
    return false;
  }

  /**
   * Cancel the current LLM operation.
   *
   * Vantage-aware. Stopping from a sub-thread's OWN vantage (Escape while
   * focused in it, or its footer Stop) INTERRUPTS it: the worker
   * turn is preempted but the thread stays open, so its composer stays put and
   * the user can keep interacting with it. Stopping from the root/parent vantage
   * stops everything AND closes the open sub-threads (so the composer returns
   * to the root column).
   * @param {string|null} [focusedThreadId] - Thread id of the column the stop
   *   came from (null = root). When omitted/undefined the vantage is unknown and
   *   we fall back to interrupting whichever sub-thread is the live processing
   *   column — so a bare Escape interrupts a running child rather than closing it.
   * @param {{polite?: boolean, toggle?: boolean, source?: string}} [opts] - When `polite` is true,
   *   request a non-destructive Pause instead of a hard cancel: the work in the
   *   named column and everything below it finishes and records its real result,
   *   then rests before the next LLM turn. Nothing is cancelled, interrupted or
   *   closed, so the destructive vantage routing below is skipped — but the
   *   vantage itself is not: a Pause is scoped exactly like a Stop, and an
   *   unknown vantage means the whole conversation. When `toggle` is also true
   *   (the Pause button, NOT shift+Escape), a polite request that arrives while a
   *   Pause already covers that column lifts it instead — clicking Pause twice
   *   turns it back off. `source` names the gesture behind a hard stop (`escape`,
   *   `stop button`) so the worker's log can attribute the cancel; it reaches the
   *   log and nothing else.
   */
  async cancelLLMOperation(focusedThreadId = undefined, { polite = false, toggle = false, source = 'stop' } = {}) {
    // The visible conversation is the one being cancelled.
    const target = this._requireVisibleConversation('cancel');
    if (!target) return;
    const { conversation } = target;

    // Polite stop (Pause): non-destructive. Return BEFORE any destructive branch
    // — it must not cancel approvals, kill actions, stamp a "Cancelled" message,
    // or close sub-threads. The worker marks the thread and rests it at the next
    // boundary; the local cue keeps the Pause button active until that lands.
    if (polite) {
      // An unknown vantage (a bare shortcut, nobody having said which column)
      // means the conversation: a pause is a request to stop spending, and the
      // whole of it is the safe reading of an unaimed press.
      const pauseThreadId = focusedThreadId ?? null;
      // Toggle sources (the Pause button) lift a pause already covering this
      // column: a second click turns Pause back off. Non-toggle sources
      // (shift+Escape) only ever request a pause — pressing the shortcut again
      // re-affirms it rather than lifting it.
      if (toggle && conversation.politeStopState(pauseThreadId) !== 'none') {
        conversation.cancelPoliteStop(pauseThreadId);
      } else {
        conversation.requestPoliteStop(pauseThreadId);
        // shift+Escape is owned by popup-manager rather than the shortcut
        // dispatcher, so its use is reported here (not the Pause button's,
        // which is toggle:true).
        if (!toggle) recordUsage('shortcut:pause-conversation');
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
      conversation.addCancellationMessage(source);
    } else if (wasRunningActions || isAwaitingLLM) {
      // Rerun-stuck branch: the LLM isn't streaming so we don't want a
      // user-facing "Cancelled" message, but the worker is sitting in
      // activity='awaiting_llm' with the tool-action still un-terminated.
      // stopProcessing sends the WS cancel that drives the worker's
      // CancelInFlightToolActions → writes state='cancelled'.
      conversation.stopProcessing(source);
    }

    // Root/parent vantage: settle every sub-thread run still open, so nothing
    // parked on one keeps waiting (their worker turn was preempted above).
    conversation.settleOpenSubThreads();

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
    if (this._strategySwitcher) {
      this._strategySwitcher.destroy();
    }
    if (this._modelCycler) {
      this._modelCycler.destroy();
    }
    if (this._thinkingCycler) {
      this._thinkingCycler.destroy();
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

// The app's declared dependents: modules that act on the app without being
// handed it (utils/app-session.js, services/escape-behaviour.js).
provideAppSession(() => app.getSession());
provideEscapeApp(app);

// Export for debugging, and for extensions and the hosted-shell tests
window.jugglerApp = app;
