//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Header controls: undo/redo buttons, project-path-display, and the network
 * button's connected-clients count.
 * The buttons live once in .app-header and operate on the currently visible
 * conversation.
 * @module utils/header-controls
 */

import keyShortcutManager from '../services/key-shortcut-manager.js';
import wsService from '../services/websocket.js';
import { hasNativeHost } from '../../sdk/lib/window-control.js';
import { fetchJson } from '../services/http.js';
import { showAlert } from '../components/modal-dialog.js';
import { apiUrl } from './api-url.js';
import { projectsOpenInNewWindow } from './project-open-mode.js';
import { statusHoldsTurn } from '../model/processing-status.js';

/**
 * @typedef {import('../model/session.js').default} Session
 * @typedef {import('../model/conversation.js').default} Conversation
 */

/**
 * @typedef {object} ClientsEventSource
 * @property {(type: 'clients-changed', fn: (data: any) => void) => void} on - Start hearing joins and leaves.
 * @property {(type: 'clients-changed', fn: (data: any) => void) => void} off - Stop hearing them.
 */

/**
 * How many of the connected viewers are windows of their own. A detached
 * pinboard connects as a viewer like any other, but it is part of the window it
 * was popped out of (it names that window as its owner), not somebody else
 * sharing the session.
 * @param {Array<{ownerViewerId?: string}>|undefined} clients - The server's viewer list.
 * @returns {number} The count, including this window.
 */
function windowsOfTheirOwn(clients) {
  return (clients || []).filter((c) => !c.ownerViewerId).length;
}

/**
 * The server's count of connected windows, including this one; null when it
 * cannot be read.
 * @returns {Promise<number|null>} The count.
 */
async function fetchClientCount() {
  const c = await fetchJson(apiUrl('/connectivity'), { fallback: null });
  return c ? windowsOfTheirOwn(c.clients) : null;
}

/**
 * Show on the network button how many OTHER clients share this session. The
 * server's count includes this one, so one is subtracted; alone, the button is
 * plain "Network settings" with no count. The count is a badge over the icon
 * (or, where the header has room, a "N connected" label) and is also spoken in
 * the button's title and accessible name.
 * @param {HTMLElement} button - The header's #network-button.
 * @param {{events?: ClientsEventSource, seed?: () => Promise<number|null>}} [options]
 *   Where joins and leaves are heard (the session socket by default), and how
 *   the starting count is read (the /connectivity endpoint by default).
 * @returns {{ready: Promise<void>, dispose: () => void}} `ready` settles once
 *   the starting count is shown; `dispose` stops listening.
 */
export function bindNetworkClients(button, { events = wsService, seed = fetchClientCount } = {}) {
  const clients = /** @type {HTMLElement|null} */ (button.querySelector('.network-button__clients'));
  const count = /** @type {HTMLElement|null} */ (button.querySelector('.network-button__count'));

  const show = (/** @type {number|null|undefined} */ total) => {
    const others = Math.max(0, (total || 1) - 1);
    const label = others === 0
      ? 'Network settings'
      : `Network settings — ${others} other client${others === 1 ? '' : 's'} connected`;
    button.title = label;
    button.setAttribute('aria-label', label);
    if (count) count.textContent = String(others);
    if (clients) clients.hidden = others === 0;
    // Lets a wide header turn the badge into a "N connected" label.
    button.classList.toggle('has-clients', others > 0);
  };

  let disposed = false;
  const onChange = (/** @type {any} */ data) => show(windowsOfTheirOwn(data?.clients));
  events.on('clients-changed', onChange);
  // The join broadcast may have fired before this listener was attached, so
  // read the authoritative count once. A later clients-changed corrects an
  // offline seed failure — and wins over a seed that resolves after it.
  let heard = false;
  const heardFirst = () => { heard = true; };
  events.on('clients-changed', heardFirst);
  const ready = seed().then((total) => {
    events.off('clients-changed', heardFirst);
    if (!disposed && !heard && total !== null) show(total);
  });
  return {
    ready,
    dispose: () => {
      disposed = true;
      events.off('clients-changed', onChange);
      events.off('clients-changed', heardFirst);
    },
  };
}

/**
 * Wire up header controls (undo/redo, project path, network clients count).
 * @param {Session} session
 */
export function setupHeaderControls(session) {
  const undoBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('control-undo-button'));
  const redoBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('control-redo-button'));
  const pathDisplay = /** @type {HTMLElement|null} */ (document.getElementById('project-path-display'));
  const pathChip = /** @type {HTMLButtonElement|null} */ (document.getElementById('project-path-chip'));
  const pathLabel = /** @type {HTMLElement|null} */ (pathDisplay?.querySelector('.ppd-path') ?? null);
  const newWindowBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('project-new-window-button'));

  /** @type {Conversation|null} */
  let currentConversation = null;
  /** @type {((event: any) => void) | null} */
  let metadataObserver = null;

  // The conversation is running whenever the worker's authoritative
  // processingState.status is a turn phase rather than a resting status
  // (model/processing-status.js) — the top-level
  // projection reports a running status while ANY of its threads holds a claim,
  // for the whole busy span (LLM call, tool execution, approval waits). That is
  // the right scope here: undo/redo roll the WHOLE document back, so one live
  // run anywhere in it is reason enough to lock them out. Reading the doc
  // metadata (not the local llmState projection) means viewers that didn't
  // initiate the turn lock out too.
  const isBusy = () => statusHoldsTurn(currentConversation?.processingState?.status);

  // A button disabled by a running turn says so; one disabled because there is
  // nothing to step through needs no explanation and keeps its plain name.
  const BUSY_TITLE = 'Unavailable while the agent is running';
  const updateButtons = () => {
    const busy = isBusy();
    const canUndo = !busy && !!currentConversation?.canUndo();
    const canRedo = !busy && !!currentConversation?.canRedo();
    if (undoBtn) {
      undoBtn.disabled = !canUndo;
      undoBtn.title = busy ? BUSY_TITLE : 'Undo';
    }
    if (redoBtn) {
      redoBtn.disabled = !canRedo;
      redoBtn.title = busy ? BUSY_TITLE : 'Redo';
    }
  };

  const bindToVisible = () => {
    const visible = session.getVisibleConversation();
    if (visible === currentConversation) {
      updateButtons();
      return;
    }
    // Detach old observer
    if (metadataObserver && currentConversation) {
      currentConversation.unobserveMetadata(metadataObserver);
      metadataObserver = null;
    }
    currentConversation = visible;
    if (currentConversation) {
      metadataObserver = (event) => {
        if (event.keysChanged?.has?.('undoState') || event.keysChanged?.has?.('processingState')) {
          updateButtons();
        }
      };
      currentConversation.observeMetadata(metadataObserver);
    }
    updateButtons();
  };

  // Both the header path chip and the native Session ▸ Open… menu event open the
  // same project picker; the module is imported lazily so the picker (and its
  // deps) stay off the initial header render path.
  const openPicker = async () => {
    const { openProjectPicker } = await import('../components/project-picker.js');
    openProjectPicker(session.projectPath || '', session);
  };

  const updateProjectPath = (/** @type {string} */ projectPath) => {
    if (!pathDisplay || !pathLabel) return;
    if (!projectPath) {
      pathLabel.textContent = 'Set project folder';
      if (pathChip) pathChip.title = 'Click to set the project folder';
      pathDisplay.classList.add('is-empty');
    } else {
      pathLabel.textContent = projectPath;
      if (pathChip) {
        // On the desktop app, opening another project spawns a new window and
        // leaves this one untouched; in a browser/PWA, or a desktop window on a
        // server the app did not start, it switches in place (each folder
        // carries its own tabs).
        pathChip.title = projectsOpenInNewWindow()
          ? `Current project folder: ${projectPath}\n`
            + 'Click to open another project in a new window — this one stays put.'
          : `Current project folder: ${projectPath}\n`
            + 'Click to switch to a different project folder';
      }
      pathDisplay.classList.remove('is-empty');
    }
  };

  if (undoBtn) {
    undoBtn.addEventListener('click', async () => {
      if (currentConversation) {
        await currentConversation.undo();
        updateButtons();
      }
    });
  }
  if (redoBtn) {
    redoBtn.addEventListener('click', async () => {
      if (currentConversation) {
        await currentConversation.redo();
        updateButtons();
      }
    });
  }
  // The chip is a real button opted out of the header drag region (CSS
  // --wails-draggable: no-drag), so a plain click reliably opens the picker —
  // no pointer-drag disambiguation needed.
  if (pathChip) {
    pathChip.addEventListener('click', openPicker);
  }

  // Inline "open new window" button. Spawns a fresh juggler window in
  // no-project mode (the user then picks a folder). Only a native desktop
  // window has a host able to do this; in a remote browser tab apiService
  // .newWindow() is a no-op and the button is hidden by CSS anyway.
  const openNewWindow = async () => {
    try {
      const { default: apiService } = await import('../services/api.js');
      await apiService.newWindow();
    } catch (err) {
      const { extractUserMessage } = await import('../../sdk/lib/error-utils.js');
      await showAlert(extractUserMessage(err), 'New window');
    }
  };
  if (newWindowBtn) {
    newWindowBtn.addEventListener('click', openNewWindow);
  }
  // ⇧⌘N / Ctrl+Shift+N — same action as the button. Desktop only: a plain browser
  // tab has no native host to open a window, so we return false and leave ⇧⌘N to
  // the browser (its own new-window/incognito) rather than swallowing it as a
  // no-op. On the desktop this is the sole handler for the chord — the native File
  // ▸ New Window menu item shares the accelerator for display and click.
  keyShortcutManager.register('new-window', () => {
    if (!hasNativeHost()) return false;
    void openNewWindow();
    return true;
  });

  // The native Session ▸ New Window menu item and its ⇧⌘N accelerator dispatch this
  // event on the focused window. The native accelerator preempts the webview
  // keydown in the desktop app, so the keyShortcutManager binding above only runs
  // in browser tabs; routing the menu/keyboard case back through openNewWindow()
  // means such a window carries THIS window's live theme and font size to the
  // child — the same single path as the header button, never a global last-used
  // seed.
  window.addEventListener('juggler:new-window', () => { void openNewWindow(); });

  const networkButton = document.getElementById('network-button');
  if (networkButton) bindNetworkClients(networkButton);

  // Native menu (Session ▸ Open…) bridges to the picker via this event, since the
  // Go side can't import the JS module directly. Same entry point as the
  // header path-display click above.
  window.addEventListener('juggler:open-project', openPicker);

  // Keyboard shortcuts (undo / redo) — bindings and platform handling live in the
  // KeyShortcutManager; here we only supply the behaviour. Each returns truthy
  // only when it actually acts, so the manager preventDefaults exactly then (and
  // a no-op — busy, or nothing to undo — falls through untouched). The manager's
  // own input-field guard keeps ⌘Z out of the composer, which has native undo.
  keyShortcutManager.register('undo', () => {
    if (!currentConversation || isBusy() || !currentConversation.canUndo()) return false;
    void currentConversation.undo().then(updateButtons);
    return true;
  });
  keyShortcutManager.register('redo', () => {
    if (!currentConversation || isBusy() || !currentConversation.canRedo()) return false;
    void currentConversation.redo().then(updateButtons);
    return true;
  });

  // Subscribe to session events to keep buttons + path display fresh
  session.subscribe(/** @param {{type: string}} event */ (event) => {
    switch (event.type) {
      case 'session:loaded':
        updateProjectPath(session.projectPath || '');
        bindToVisible();
        break;
      case 'conversation:changed':
      case 'conversation:switched':
      case 'conversation:created':
      case 'conversation:deleted':
        bindToVisible();
        break;
    }
  });

  // Initial state
  updateProjectPath(session.projectPath || '');
  bindToVisible();
}
