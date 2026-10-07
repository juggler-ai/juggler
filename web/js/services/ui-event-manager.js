//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { presentPopup } from '../utils/popup-surface.js';
import { markPopupOpen } from '../utils/popup-manager.js';
import { attachSwipeDismiss } from '../utils/swipe-dismiss.js';
import { holdLifted } from '../utils/reorder-drag.js';
import { openSettings } from './settings-launcher.js';
import { showNotice } from '../components/modal-dialog.js';

/**
 * @typedef {object} EventListener
 * @property {HTMLElement|Document|Window} element - Element with listener
 * @property {string} event - Event type
 * @property {function} handler - Event handler function
 * @property {object} [options] - Event listener options
 */

import { toggleTheme, getPaintedTheme, THEME_MODE_EVENT } from '../utils/theme-manager.js';

/**
 * Header theme-button presentation per painted theme: the Material Symbols
 * glyph (light_mode / dark_mode, viewBox 0 -960 960 960) and the tooltip,
 * which names the theme on screen and the one a click moves to.
 *
 * The button is a light switch, so it deals only in the two colours — the
 * 'system' mode behind them is Settings' business, and the button shows
 * whichever colour system resolved to. See toggleTheme() in theme-manager.js.
 * @type {Record<string, {path: string, title: string}>}
 */
const THEME_BUTTON_UI = {
  light: {
    path: 'M579-381q41-41 41-99t-41-99q-41-41-99-41t-99 41q-41 41-41 99t41 99q41 41 99 41t99-41Zm-240.5 42.5Q280-397 280-480t58.5-141.5Q397-680 480-680t141.5 58.5Q680-563 680-480t-58.5 141.5Q563-280 480-280t-141.5-58.5ZM200-450H40v-60h160v60Zm720 0H760v-60h160v60ZM450-760v-160h60v160h-60Zm0 720v-160h60v160h-60ZM262-658l-100-97 43-44 96 100-39 41Zm494 496-98-100 41-41 99 98-42 43Zm-99-537 98-99 44 42-99 98-43-41ZM162-205l99-98 42 42-98 99-43-43Zm318-275Z',
    title: 'Theme: Light — click for Dark'
  },
  dark: {
    path: 'M480-120q-150 0-255-105T120-480q0-150 105-255t255-105q8 0 17 .5t23 1.5q-36 32-56 79t-20 99q0 90 63 153t153 63q52 0 99-18.5t79-51.5q1 12 1.5 19.5t.5 14.5q0 150-105 255T480-120Zm0-60q109 0 190-67.5T771-406q-25 11-53.67 16.5Q688.67-384 660-384q-114.69 0-195.34-80.66Q384-545.31 384-660q0-24 5-51.5t18-62.5q-98 27-162.5 109.5T180-480q0 125 87.5 212.5T480-180Zm-4-297Z',
    title: 'Theme: Dark — click for Light'
  }
};
import { toggleSound, isSoundEnabled, ATTENTION_PREFS_EVENT } from '../utils/attention-manager.js';
import { isToolGroupingEnabled, toggleToolGrouping, TOOL_GROUPING_EVENT } from '../utils/tool-grouping-pref.js';
import { zoomIn, zoomOut } from '../utils/zoom-manager.js';
import { setupHeaderOverflowMenu } from '../utils/header-overflow-menu.js';
import { isAutoNameEnabled } from './auto-name-setting.js';
import keyShortcutManager from './key-shortcut-manager.js';

/**
 * UIEventManager
 *
 * Manages all DOM event listeners with proper cleanup tracking.
 * Centralizes event handling and ensures no memory leaks.
 * @class
 */
class UIEventManager {
  /**
   * @param {object} options - Configuration options
   * @param {function(string, string|null, *, Array<*>=, string[]=): void} options.onSendMessage - Callback when user sends message (message, threadItemId, messageThread, attachments, skills)
   * @param {function(object): Promise<void>} options.onContextItemAction - Callback for context item actions
   * UI elements (conversationControls, contextPanel, conversationArea, composer) are per-tab.
   */
  constructor(options) {
    this._onSendMessage = options.onSendMessage;
    this._onContextItemAction = options.onContextItemAction;

    /** @type {Array<{element: EventTarget, event: string, handler: EventListenerOrEventListenerObject, options?: boolean|AddEventListenerOptions}>} @private */
    this._listeners = [];

    /** @type {import('../model/session.js').default|null} @private */
    this._session = null;

    /** @type {(() => void)|null} @private */
    this._unregisterZoomIn = null;

    /** @type {(() => void)|null} @private */
    this._unregisterZoomOut = null;

    /** @type {(() => void)|null} @private */
    this._unregisterShowShortcuts = null;

    /** @type {(() => void)|null} @private */
    this._unregisterOpenSettings = null;

    /** @type {(() => void)|null} @private */
    this._unregisterToolGrouping = null;

    /** @type {{dispose: () => void}|null} @private */
    this._overflowMenu = null;

    /**
     * Popup-manager token, held for as long as the sidebar drawer is open.
     * @type {(() => void)|null} @private
     */
    this._releaseSidebarPopup = null;

    /**
     * Detaches the drawer's swipe-to-dismiss. Owned here rather than in
     * `_listeners`, which holds listener tuples a detach cannot be reduced to.
     * @type {(() => void)|null} @private
     */
    this._detachSidebarSwipe = null;
  }

  /**
   * Setup all event handlers
   */
  setupAll() {
    this._setupInputHandler();
    this._setupContextItemActions();
    this._setupZoomButtons();
    this._setupThemeButton();
    this._setupBellButton();
    this._setupToolGroupingButton();
    this._setupNetworkButton();
    this._setupHelpButton();
    this._setupSettingsButton();
    this._setupOverflowButton();
    this._setupSidebarToggle();
  }

  /**
   * Setup input handler for sending messages.
   * Listen at document level since composer-box is per-tab.
   * @private
   */
  _setupInputHandler() {
    // Listen for send-message event from composer-box (bubbles up)
    /** @param {Event} event */
    const handler = (event) => {
      const detail = /** @type {any} */ (event).detail;
      this._onSendMessage(detail.message, detail.threadItemId || null, detail.messageThread || null, detail.attachments || [], detail.skills || []);
    };

    document.addEventListener('send-message', handler);
    this._listeners.push({
      element: document,
      event: 'send-message',
      handler: handler
    });
  }

  /**
   * Setup context item action handlers.
   * Listen at document level since properties-panel is per-tab.
   * @private
   */
  _setupContextItemActions() {
    // Listen for context item actions from properties-panel (bubbles up)
    /** @param {Event} event */
    const contextItemActionHandler = (event) => {
      this._onContextItemAction(/** @type {any} */ (event).detail);
    };

    document.addEventListener('context-item-action', contextItemActionHandler);
    this._listeners.push({
      element: document,
      event: 'context-item-action',
      handler: contextItemActionHandler
    });

    // Listen for context-item-add-requested event from context panel (bubbles up)
    /** @param {Event} event */
    const contextItemAddRequestedHandler = async (event) => {
      await this._handleContextItemAddRequested(/** @type {any} */ (event).detail);
    };

    document.addEventListener('context-item-add-requested', contextItemAddRequestedHandler);
    this._listeners.push({
      element: document,
      event: 'context-item-add-requested',
      handler: contextItemAddRequestedHandler
    });

  }

  /**
   * Setup zoom in/out handlers.
   *
   * Three entry points drive the same font-size zoom:
   *   - the header bar's −/+ buttons (click),
   *   - the native View ▸ Zoom In/Out menu items, which dispatch the
   *     `juggler:zoom-in` / `juggler:zoom-out` CustomEvents (the menu owns the
   *     Cmd +/− accelerators in the desktop app), and
   *   - browser-style Cmd/Ctrl +/− keypresses, for windows with no native menu
   *     (a plain browser tab). preventDefault stops the browser's own page zoom.
   * @private
   */
  _setupZoomButtons() {
    const zoomInButton = document.getElementById('zoom-in-button');
    const zoomOutButton = document.getElementById('zoom-out-button');

    if (zoomInButton) {
      const handler = () => zoomIn();
      zoomInButton.addEventListener('click', handler);
      this._listeners.push({ element: zoomInButton, event: 'click', handler });
    }

    if (zoomOutButton) {
      const handler = () => zoomOut();
      zoomOutButton.addEventListener('click', handler);
      this._listeners.push({ element: zoomOutButton, event: 'click', handler });
    }

    const zoomInEvent = () => zoomIn();
    window.addEventListener('juggler:zoom-in', zoomInEvent);
    this._listeners.push({ element: window, event: 'juggler:zoom-in', handler: zoomInEvent });

    const zoomOutEvent = () => zoomOut();
    window.addEventListener('juggler:zoom-out', zoomOutEvent);
    this._listeners.push({ element: window, event: 'juggler:zoom-out', handler: zoomOutEvent });

    // Cmd/Ctrl +/− keypresses (for windows with no native menu — a plain browser
    // tab). Bindings + platform handling live in the KeyShortcutManager; the
    // binding's '='/'-' keys fold in the shifted '+'/'_' and layout variants, and
    // returning truthy makes the manager preventDefault the browser's page zoom.
    this._unregisterZoomIn = keyShortcutManager.register('zoom-in', () => { zoomIn(); return true; });
    this._unregisterZoomOut = keyShortcutManager.register('zoom-out', () => { zoomOut(); return true; });
    this._unregisterShowShortcuts = keyShortcutManager.register('show-shortcuts', () => {
      openSettings('shortcuts');
      return true;
    });
    this._unregisterOpenSettings = keyShortcutManager.register('open-settings', () => {
      openSettings();
      return true;
    });
  }

  /**
   * Setup theme button handler
   * @private
   */
  _setupThemeButton() {
    const themeButton = document.getElementById('theme-button');

    if (!themeButton) {
      console.error('[UIEventManager] Theme button not found');
      return;
    }

    // Show the theme on screen, and flip it on each click.
    this._renderThemeButton(themeButton);
    const handler = () => {
      toggleTheme();
    };
    themeButton.addEventListener('click', handler);
    this._listeners.push({
      element: themeButton,
      event: 'click',
      handler: handler
    });

    // Follow the theme rather than assume the click caused it: Settings can
    // change it, and in 'system' mode so can the OS and the native host's
    // reconciliation, which lands a frame after the click that triggered it.
    const themeHandler = () => this._renderThemeButton(themeButton);
    document.addEventListener(THEME_MODE_EVENT, themeHandler);
    this._listeners.push({ element: document, event: THEME_MODE_EVENT, handler: themeHandler });
  }

  /**
   * Paint the theme button's icon and tooltip for the theme on screen.
   * @param {HTMLElement} button - The theme button element.
   * @private
   */
  _renderThemeButton(button) {
    const ui = THEME_BUTTON_UI[getPaintedTheme()] || THEME_BUTTON_UI.dark;
    if (!ui) return;
    button.querySelector('path')?.setAttribute('d', ui.path);
    button.title = ui.title;
    button.setAttribute('aria-label', ui.title);
  }

  /**
   * Setup the bell button — the header on/off for notification sounds. Mirrors
   * the theme button: a header toggle backed by a per-window localStorage pref.
   * The click toggles the `sound` pref (and unlocks audio for the session); the
   * crossed-bell styling stays in sync with the settings panel's checkbox via
   * the shared prefs-changed event. Crossed bell = sounds off.
   * @private
   */
  _setupBellButton() {
    const bellButton = document.getElementById('bell-button');
    if (!bellButton) {
      console.error('[UIEventManager] Bell button not found');
      return;
    }

    const reflect = () => {
      const on = isSoundEnabled();
      bellButton.classList.toggle('is-muted', !on);
      bellButton.setAttribute('title', 'Toggle notification sounds on/off');
      bellButton.setAttribute('aria-pressed', String(on));
    };

    const handler = () => {
      toggleSound();
      reflect();
    };
    bellButton.addEventListener('click', handler);
    this._listeners.push({ element: bellButton, event: 'click', handler });

    // Keep in sync when the settings panel (or another control) changes the pref.
    const prefsHandler = () => reflect();
    window.addEventListener(ATTENTION_PREFS_EVENT, prefsHandler);
    this._listeners.push({ element: window, event: ATTENTION_PREFS_EVENT, handler: prefsHandler });

    reflect();
  }

  /**
   * Setup the tool-grouping button — the header on/off for collapsing a run of
   * adjacent tool-use rows into one group tile. Mirrors the bell button: a
   * header toggle backed by a localStorage pref, re-reflected from the shared
   * pref-changed event so any other control that flips it stays in sync. The
   * open columns re-render themselves off the same event (conversation-tab).
   * The keyboard shortcut flips the same pref; the button reflects it either
   * way, since both routes go through the pref's change event.
   * @private
   */
  _setupToolGroupingButton() {
    const groupingButton = document.getElementById('tool-grouping-button');
    if (!groupingButton) {
      console.error('[UIEventManager] Tool grouping button not found');
      return;
    }

    const reflect = () => {
      const on = isToolGroupingEnabled();
      // `is-active` also swaps which of the button's two glyphs is shown (see
      // .tool-grouping-button in app-shell.css): each depicts the transcript's
      // current state — folded or unfolded.
      groupingButton.classList.toggle('is-active', on);
      groupingButton.setAttribute('title', on
        ? 'Consecutive tool uses are grouped — click to show them individually'
        : 'Group consecutive tool uses');
      groupingButton.setAttribute('aria-pressed', String(on));
    };

    const handler = () => {
      toggleToolGrouping();
      reflect();
    };
    groupingButton.addEventListener('click', handler);
    this._listeners.push({ element: groupingButton, event: 'click', handler });

    const prefsHandler = () => reflect();
    window.addEventListener(TOOL_GROUPING_EVENT, prefsHandler);
    this._listeners.push({ element: window, event: TOOL_GROUPING_EVENT, handler: prefsHandler });

    this._unregisterToolGrouping = keyShortcutManager.register('toggle-tool-grouping', () => {
      toggleToolGrouping();
      return true;
    });

    reflect();
  }

  /**
   * Setup network button handler
   * @private
   */
  _setupNetworkButton() {
    const networkButton = document.getElementById('network-button');

    if (!networkButton) {
      console.error('[UIEventManager] Network button not found');
      return;
    }

    // Open settings panel with connectivity tab when clicked
    const handler = () => {
      openSettings('connectivity');
    };
    networkButton.addEventListener('click', handler);
    this._listeners.push({
      element: networkButton,
      event: 'click',
      handler: handler
    });
  }

  /**
   * Setup help button handler — opens the Settings panel on its Keyboard
   * shortcuts tab, the passive reference surface for the onboarding tips.
   * @private
   */
  _setupHelpButton() {
    const helpButton = document.getElementById('help-button');

    if (!helpButton) {
      console.error('[UIEventManager] Help button not found');
      return;
    }

    const handler = () => {
      openSettings('shortcuts');
    };
    helpButton.addEventListener('click', handler);
    this._listeners.push({
      element: helpButton,
      event: 'click',
      handler: handler
    });
  }

  /**
   * Setup settings button handler
   * @private
   */
  _setupSettingsButton() {
    const settingsButton = document.getElementById('settings-button');

    if (!settingsButton) {
      console.error('[UIEventManager] Settings button not found');
      return;
    }

    // Open settings panel when clicked
    const handler = () => {
      openSettings();
    };
    settingsButton.addEventListener('click', handler);
    this._listeners.push({
      element: settingsButton,
      event: 'click',
      handler: handler
    });
  }

  /**
   * Setup the "…" overflow button, which CSS shows only when the header is too
   * narrow for every control. Its rows run the same actions as the buttons it
   * stands in for (zoom −/+ and help).
   * @private
   */
  _setupOverflowButton() {
    const overflowButton = document.getElementById('header-overflow-button');
    if (!overflowButton) {
      console.error('[UIEventManager] Overflow button not found');
      return;
    }
    this._overflowMenu = setupHeaderOverflowMenu(overflowButton, [
      { label: 'Decrease font size', shortcutId: 'zoom-out', run: () => zoomOut() },
      { label: 'Increase font size', shortcutId: 'zoom-in', run: () => zoomIn() },
      {
        label: 'Tips & keyboard shortcuts',
        shortcutId: 'show-shortcuts',
        run: () => openSettings('shortcuts'),
        // The same reason the touch header drops the help button: a keyboard
        // reference is a dead end on a device with no keyboard.
        omit: () => window.matchMedia('(hover: none)').matches,
      },
    ]);
  }

  /**
   * Setup the conversation-sidebar drawer toggle (narrow viewports only).
   *
   * On wide screens the sidebar is a static column and the hamburger button
   * is CSS-hidden, so this is inert there. On narrow screens the sidebar
   * becomes an off-canvas drawer driven entirely by the `sidebar-open` class
   * on <body>: the hamburger toggles it, and the backdrop, a swipe, Escape, the
   * Back button and selecting a conversation close it. Pure ephemeral view
   * state — no domain/Yjs state.
   * @private
   */
  _setupSidebarToggle() {
    const toggleButton = document.getElementById('sidebar-toggle-button');
    const backdrop = document.getElementById('sidebar-backdrop');
    const sidebar = document.getElementById('conversation-bar');

    /** @param {boolean} open */
    const setOpen = (open) => {
      document.body.classList.toggle('sidebar-open', open);
      toggleButton?.setAttribute('aria-expanded', open ? 'true' : 'false');
      // The open drawer is one of the overlays a phone puts over the page, so it
      // holds a popup token for as long as it is up. That is what makes the
      // mobile/browser Back button dismiss it instead of navigating away from
      // the conversation, and what gives it its Escape — both route through
      // popup-manager's closeAllPopups, which calls the handler below.
      //
      // Releasing before re-taking keeps this at one token even if the drawer is
      // set to a state it already holds; the single sentinel history entry
      // survives that swap, since its retraction is deferred a macrotask and
      // re-checks whether anything is open.
      this._releaseSidebarPopup?.();
      this._releaseSidebarPopup = open ? markPopupOpen(close) : null;
    };
    const isOpen = () => document.body.classList.contains('sidebar-open');
    const close = () => setOpen(false);

    if (toggleButton) {
      const handler = () => setOpen(!isOpen());
      toggleButton.addEventListener('click', handler);
      this._listeners.push({ element: toggleButton, event: 'click', handler });
    }

    if (backdrop) {
      backdrop.addEventListener('click', close);
      this._listeners.push({ element: backdrop, event: 'click', handler: close });
    }

    // Selecting a conversation inside the drawer should dismiss it, just like a
    // tap on the backdrop. But any tap that enters inline rename must keep the
    // drawer OPEN: the rename editor is a body-level overlay anchored to the
    // tab's on-screen rect, so closing the drawer slides that tab off-canvas and
    // the overlay lands clipped at the viewport edge (and tearing the editor down
    // with the drawer would make rename impossible). Two taps enter rename:
    // tapping the ALREADY-active tab's name, and creating a conversation ("+")
    // while auto-naming is OFF. With auto-naming ON the "+" opens no editor — it
    // names the tab "Untitled N" and focuses the composer — so the drawer must
    // get out of the way, otherwise it covers the composer it just focused. So
    // only dismiss on a tap that leaves nothing to edit here: a tab other than
    // the active one's name, or a "+" that won't prompt for a name.
    //
    // CAPTURE PHASE is load-bearing: the tab's own bubble-phase click handler
    // calls switchConversation(), which synchronously notifies the bar and
    // re-renders, flipping `.active` onto the tapped tab. A bubble-phase listener
    // here would therefore always see the tapped tab as already-active and never
    // close. Running in capture, before that switch, lets `.active` still report
    // the pre-tap state the logic below assumes.
    if (sidebar) {
      /** @param {Event} e */
      const handler = (e) => {
        if (!isOpen()) return;
        const target = /** @type {HTMLElement|null} */ (e.target);
        if (target?.closest('.inline-rename')) return;
        if (target?.closest('.conversation-add-item')) {
          if (isAutoNameEnabled()) close();
          return;
        }
        const tab = target?.closest('.conversation-tab');
        const renames = tab?.classList.contains('active') && !!target?.closest('.conversation-tab-name');
        if (tab && !renames) close();
      };
      sidebar.addEventListener('click', handler, true);
      this._listeners.push({ element: sidebar, event: 'click', handler, options: true });
      this._setupSidebarSwipe(sidebar, isOpen, close);
    }
  }

  /**
   * Swipe the drawer away — a leftward drag anywhere on it.
   *
   * The gesture itself is `attachSwipeDismiss`, shared with the pinboard panel
   * and the phone bottom sheet, so the surfaces a phone puts over the page all
   * go away the same way. What is local to the drawer is what it concedes.
   *
   * A vertical drag is the tab list scrolling and must stay the browser's, which
   * the axis claim leaves alone — and is also why the drawer declares
   * `touch-action: pan-y` rather than `none`. Drags starting on the resize grip
   * or the rename editor belong to those. A tab or a workspace box lifted for a
   * reorder by a held finger (utils/reorder-drag.js) owns the pointer from the
   * lift, so the swipe stands aside while one is lifted — asked again when the
   * swipe would claim, which is after any lift. A press that has not lifted is
   * still the drawer's to swipe: it moves past the hold's tolerance before the
   * swipe's slop, and lets go as it does. Nothing inside the bar
   * scrolls horizontally, and `pan-y` forbids a horizontal pan in any case, so
   * there is no scroller here to hand the gesture to.
   *
   * Drawer mode only: on a wide viewport the bar is a static column
   * (`position: relative`), with nothing to slide out of the way.
   * @param {HTMLElement} sidebar - The conversation-bar element.
   * @param {() => boolean} isOpen - Whether the drawer is currently open.
   * @param {() => void} close - Closes the drawer.
   * @private
   */
  _setupSidebarSwipe(sidebar, isOpen, close) {
    this._detachSidebarSwipe = attachSwipeDismiss(sidebar, {
      direction: 'left',
      thresholdPx: 60,
      isActive: () => isOpen() && window.getComputedStyle(sidebar).position === 'absolute'
        && !holdLifted(),
      exclude: 'col-resize-handle, .inline-rename',
      onDismiss: close,
    });
  }

  /**
   * Handle context item add requested event
   * @param {{button: HTMLElement, threadItemId?: string|null}} detail - Event detail
   * @private
   */
  async _handleContextItemAddRequested(detail) {
    const { button, threadItemId } = detail;

    // Remove any existing dropdown
    const existingDropdown = document.querySelector('.context-item-add-dropdown');
    if (existingDropdown) {
      existingDropdown.remove();
      return;
    }

    // CRITICAL: Validate button element exists and has valid dimensions
    // This prevents the bug where document.getElementById() returns a button from a hidden tab
    if (!button) {
      console.error('[UIEventManager] context-item-add-requested event missing button element');
      return;
    }

    const buttonRect = button.getBoundingClientRect();
    if (buttonRect.width === 0 || buttonRect.height === 0) {
      console.error('[UIEventManager] Button has zero dimensions - likely from hidden tab', button);
      return;
    }

    // Create dropdown menu
    const dropdown = document.createElement('nav');
    dropdown.className = 'dropdown-menu context-item-add-dropdown show';
    dropdown.setAttribute('role', 'menu');

    // presentPopup (wired at the end of this method) returns the single
    // teardown; `close` runs it from every dismissal path (selection, outside
    // click, Escape). Declared up front so the item handlers below can call it.
    /** @type {(() => void)|null} */
    let release = null;
    const close = () => { if (release) { release(); release = null; } };

    // No heading: the button that opened it already says what the menu is for,
    // so every row is a choice.
    const menu = document.createElement('menu');

    // "AI assistant files" special action, offered once the conversation is
    // bound. Before that it is both redundant and wrong: the assistant files are
    // already there, built for the tree the conversation works in, while this
    // pass would read the project — and then stand in the way of the real ones, because the
    // insert-time dedup matches on path and would reuse what it had added.
    const visible = this._getSession()?.getVisibleConversation?.();
    if (visible?.awaitingSetup !== true) {
      const aiFilesItem = document.createElement('li');
      aiFilesItem.className = 'menu-item';
      aiFilesItem.setAttribute('role', 'menuitem');
      aiFilesItem.textContent = 'AI assistant files';
      aiFilesItem.addEventListener('click', async () => {
        await this._addAIAssistantFiles(threadItemId);
        close();
      });
      menu.appendChild(aiFilesItem);
    }

    // Get all user-addable context items
    const contextItemRegistry = (await import('../registries/context-item-registry.js')).default;
    const allItemTypeIds = contextItemRegistry.getIds();

    for (const itemTypeId of allItemTypeIds) {
      const ItemClass = contextItemRegistry.get(itemTypeId);
      if (ItemClass && ItemClass.MANIFEST && ItemClass.MANIFEST.userAddable === true) {
        const manifest = ItemClass.MANIFEST;

        const item = document.createElement('li');
        item.className = 'menu-item';
        item.setAttribute('role', 'menuitem');
        item.textContent = manifest.name;

        item.addEventListener('click', async () => {
          // Get session and conversation
          const session = this._getSession();
          if (!session) {
            console.error('[UIEventManager] Cannot add context item: no session');
            close();
            return;
          }

          const conversation = session.getVisibleConversation();
          if (!conversation) {
            console.error('[UIEventManager] Cannot add context item: no visible conversation');
            close();
            return;
          }

          // If the item class requires upfront user input, collect it now
          let params = {};
          if (typeof /** @type {any} */ (ItemClass).showAddDialog === 'function') {
            params = await /** @type {any} */ (ItemClass).showAddDialog({
              startDir: conversation.workspaceRoot,
              localTree: conversation.workspaceHostsLocalProviders,
            });
            if (params === null) {
              close();
              return;
            }
          }

          // Create context item in the thread the footer belongs to
          const messageThread = threadItemId
            ? conversation.resolveMessageThread(threadItemId)
            : conversation.rootMessageThread;
          try {
            await messageThread.executeContextItem(itemTypeId, params);
          } catch (err) {
            console.error(`[UIEventManager] Error adding context item:`, err);
          }

          close();
        });

        menu.appendChild(item);
      }
    }

    dropdown.appendChild(menu);

    // presentPopup owns body-append, dismissal wiring (outside-click via
    // insideSelectors + Escape + mutual exclusion), the reposition observer,
    // and the anchored-vs-sheet decision. Its release is the single teardown.
    release = presentPopup({
      surface: dropdown,
      anchor: button,
      id: 'context-item-add-dropdown',
      onClose: close,
      insideSelectors: ['.context-item-add-dropdown'],
    });
  }

  /**
   * Detect and add AI assistant files (CLAUDE.md, .cursorrules, etc.)
   * @param {string|null} [threadItemId] - Target thread; null means root thread
   * @private
   * @async
   */
  async _addAIAssistantFiles(threadItemId = null) {
    const session = this._getSession();
    if (!session) {
      console.error('[UIEventManager] Cannot add AI files: no session');
      return;
    }

    const conversation = session.getVisibleConversation();
    if (!conversation) {
      console.error('[UIEventManager] Cannot add AI files: no visible conversation');
      return;
    }

    const messageThread = threadItemId
      ? conversation.resolveMessageThread(threadItemId)
      : conversation.rootMessageThread;
    const { assistantFiles: addedCount } = await session.seedConversationAutoItems(conversation, messageThread);
    // A bound conversation is seeded with these files already, so a click that
    // adds nothing is the common case — and without a word it reads as a dead
    // menu item.
    showNotice(addedCount === 0
      ? 'No assistant files to add — they are already in context, or this project has none.'
      : `Added ${addedCount} assistant file${addedCount === 1 ? '' : 's'} to context.`);
  }

  /**
   * The current session, or null before one is set. Populated via setSession()
   * (called by JugglerApp once the session exists).
   * @returns {import('../model/session.js').default|null} Session instance or null if not set
   * @private
   */
  _getSession() {
    return this._session || null;
  }

  /**
   * Set session reference for event handlers
   * @param {import('../model/session.js').default} session - Session instance
   */
  setSession(session) {
    this._session = session;
  }

  /**
   * Remove all event listeners for cleanup
   */
  destroy() {
    for (const listener of this._listeners) {
      listener.element.removeEventListener(
        listener.event,
        /** @type {EventListenerOrEventListenerObject} */(listener.handler),
        listener.options
      );
    }
    this._listeners = [];
    this._unregisterZoomIn?.();
    this._unregisterZoomOut?.();
    this._unregisterShowShortcuts?.();
    this._unregisterOpenSettings?.();
    this._unregisterToolGrouping?.();
    this._overflowMenu?.dispose();
    this._overflowMenu = null;
    this._detachSidebarSwipe?.();
    this._detachSidebarSwipe = null;
    this._releaseSidebarPopup?.();
    this._releaseSidebarPopup = null;
  }
}

export default UIEventManager;
