//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Header controls: project-path-display, the network button's
 * connected-clients count, and the window's keyboard undo/redo, which act on
 * the currently visible conversation. (Its Undo/Redo buttons are in the
 * conversation's footer, components/conversation-footer.js.)
 * @module components/header-controls
 */

import keyShortcutManager from '../services/key-shortcut-manager.js';
import wsService from '../services/websocket.js';
import { hasNativeHost } from '../../sdk/lib/window-control.js';
import { fetchJson } from '../services/http.js';
import { uiPort } from '../services/ui-port.js';
import { apiUrl } from '../utils/api-url.js';
import {
  externalServerHost, projectsOpenInNewWindow, sessionsPageUrl, SESSIONS_PAGE_TARGET,
} from '../utils/project-open-mode.js';
import { historyState } from '../utils/conversation-history.js';
import { baseName, initials } from '../utils/session-attention.js';
import { workspaceTint } from '../utils/workspace-colour.js';
import { ownProjectLink } from '../services/project-navigation.js';
import { isPopupOpenById } from '../utils/popup-manager.js';
import { SESSION_SWITCHER_POPUP_ID } from './session-popover.js';
import { t, htmlSlots, withHtml } from '../../sdk/lib/i18n.js';

/**
 * @typedef {import('../model/session.js').default} Session
 */

/**
 * @typedef {object} ClientsEventSource
 * @property {(type: 'clients-changed', fn: (data: any) => void) => void} on - Start hearing joins and leaves.
 * @property {(type: 'clients-changed', fn: (data: any) => void) => void} off - Stop hearing them.
 */

/**
 * @typedef {object} ProjectHost
 * @property {() => Promise<unknown>} [newWindow] - Opens a window on this
 *   machine's server's page.
 * @property {() => Promise<unknown>} [serverPage] - Shows the server's page in
 *   this window.
 */

/**
 * The desktop app, when this page is in a window of its: on this machine's
 * server it opens a window on the server's page, where another project is
 * chosen; in a window on a server by URL (another computer's) it shows that
 * server's page in this window, since a window may not be opened onto a
 * server a page names. Null in a browser.
 * @returns {ProjectHost|null} The host.
 */
function desktopHost() {
  if (!hasNativeHost()) return null;
  const api = async () => (await import('../services/api.js')).default;
  if (!projectsOpenInNewWindow()) {
    return { serverPage: async () => (await api()).showServerPage() };
  }
  return { newWindow: async () => (await api()).newWindow() };
}

/**
 * Let the user choose another project (Session ▸ Open…), which is another
 * session: the server's sessions page — from the desktop app in a window of
 * its own, or in this window when it is on a server by URL — else in a tab.
 * @param {(url: string, target: string) => void} [open] - Opens a URL in a named window.
 * @param {ProjectHost|null} [host] - The desktop app, if this page is in its window.
 * @returns {Promise<void>} Resolves once the sessions page is open.
 */
export async function chooseProject(open = (url, target) => { window.open(url, target); }, host = desktopHost()) {
  if (host?.newWindow) {
    await host.newWindow();
    return;
  }
  if (host?.serverPage) {
    await host.serverPage();
    return;
  }
  open(sessionsPageUrl(), SESSIONS_PAGE_TARGET);
}

/**
 * The window's own answer to Session ▸ Open… (`juggler:open-project`). While
 * the session switcher is up, Open… is its Open folder… and this stands down:
 * it is added at boot, ahead of the switcher's listener, and an engine that
 * runs a target's listeners in the order they were added (WebView2) runs it
 * first whatever the switcher does with the event.
 * @param {() => unknown} [choose] - What it does; chooseProject by default.
 * @returns {() => void} The listener.
 */
export function openProjectCommand(choose = () => chooseProject()) {
  return () => {
    if (isPopupOpenById(SESSION_SWITCHER_POPUP_ID)) return;
    void choose();
  };
}

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
 * Show on the network button where this window's server is and how many OTHER
 * clients share this session. A window on a server the app did not start names
 * that server's host beside the icon: nothing else on screen tells a window
 * onto another computer from one onto this one, and what the agent runs, it
 * runs there. The server's count includes this one, so one is subtracted;
 * alone, the button carries no count. The count is a badge over the icon (or,
 * where the header has room, a "N connected" label) and is also spoken in the
 * button's title and accessible name.
 * @param {HTMLElement} button - The header's #network-button.
 * @param {{events?: ClientsEventSource, seed?: () => Promise<number|null>, host?: string}} [options]
 *   Where joins and leaves are heard (the session socket by default), how the
 *   starting count is read (the /connectivity endpoint by default), and the
 *   host of a server the app did not start ('' for this computer's own).
 * @returns {{ready: Promise<void>, dispose: () => void}} `ready` settles once
 *   the starting count is shown; `dispose` stops listening.
 */
export function bindNetworkClients(button, { events = wsService, seed = fetchClientCount, host = externalServerHost() } = {}) {
  const clients = /** @type {HTMLElement|null} */ (button.querySelector('.network-button__clients'));
  const hostLabel = /** @type {HTMLElement|null} */ (button.querySelector('.network-button__host'));
  if (hostLabel) {
    hostLabel.textContent = host;
    hostLabel.hidden = !host;
  }
  // Lets CSS widen the button to hold the host.
  button.classList.toggle('is-remote', !!host);

  const show = (/** @type {number|null|undefined} */ total) => {
    const others = Math.max(0, (total || 1) - 1);
    const label = host
      ? t('{count, plural, =0 {Network settings — connected to the Juggler server at {host}} one {Network settings — connected to the Juggler server at {host}, with {count} other client} other {Network settings — connected to the Juggler server at {host}, with {count} other clients}}',
        { count: others, host })
      : t('{count, plural, =0 {Network settings} one {Network settings — {count} other client connected} other {Network settings — {count} other clients connected}}',
        { count: others });
    button.title = label;
    button.setAttribute('aria-label', label);
    if (clients) {
      // One sentence with the count in it. The count is the badge; the words
      // around it are the suffix, shown only where the header has room.
      const markup = { number: `<span class="network-button__count">${others}</span>` };
      clients.innerHTML = withHtml(t('{count, plural, other {{number} connected}}', htmlSlots(markup, { count: others })), markup);
      for (const node of Array.from(clients.childNodes)) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        const suffix = document.createElement('span');
        suffix.className = 'network-button__suffix';
        node.replaceWith(suffix);
        suffix.append(node);
      }
      clients.hidden = others === 0;
    }
    // Lets a wide header turn the badge into a "N connected" label.
    button.classList.toggle('has-clients', others > 0);
  };

  // Alone until the server says otherwise; this also names the button in the
  // user's language over the markup's English.
  show(1);

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
 * Name the header's buttons in the user's language. index.html carries their
 * names in English, which is what shows before this script runs; each is
 * replaced here, once, with its translation. A control whose name follows its
 * state (theme, the network count, the pinboard toggle) is named by
 * whatever keeps that state, and is not listed.
 * @param {ParentNode} [root] - Where the header is.
 * @returns {void}
 */
function localizeHeaderMarkup(root = document) {
  /** @type {Array<[string, string|null, string|null]>} id, title, aria-label */
  const names = [
    ['sidebar-toggle-button', t('Toggle conversations'), t('Toggle conversation sidebar')],
    hasNativeHost()
      ? ['project-new-window-button', t('Open a new window'), t('Open a new window')]
      : ['project-new-window-button', t('Open the server page'), t('Open the server page')],
    ['tool-grouping-button', t('Group consecutive tool uses'), t('Group consecutive tool uses')],
    ['header-zoom', null, t('Font size')],
    ['zoom-out-button', t('Decrease font size'), t('Decrease font size')],
    ['zoom-in-button', t('Increase font size'), t('Increase font size')],
    ['bell-button', t('Toggle notification sounds'), t('Toggle notification sounds')],
    ['help-button', t('Tips & keyboard shortcuts'), t('Tips and keyboard shortcuts')],
    ['settings-button', t('Settings'), t('Settings')],
    ['header-overflow-button', t('More'), t('More controls')],
  ];
  for (const [id, title, label] of names) {
    const node = root.querySelector(`#${id}`);
    if (!node) continue;
    if (title !== null) node.setAttribute('title', title);
    if (label !== null) node.setAttribute('aria-label', label);
  }
}

/**
 * Wire up header controls (project path, network clients count) and the
 * window's undo/redo shortcuts.
 * @param {Session} session
 */
export function setupHeaderControls(session) {
  const pathDisplay = /** @type {HTMLElement|null} */ (document.getElementById('project-path-display'));
  const pathChip = /** @type {HTMLElement|null} */ (document.getElementById('project-path-chip'));
  const pathLabel = /** @type {HTMLElement|null} */ (pathDisplay?.querySelector('.ppd-path') ?? null);
  const newWindowBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('project-new-window-button'));
  localizeHeaderMarkup();

  // The chip is the session switcher's button (session-popover.js): the
  // project's tile on its hue, as the switcher's rows draw it, and its whole
  // path — the parent folders muted (.ppd-dir) before the folder's name
  // (.ppd-name) — or, where the header has no room for that, the name alone.
  // The title gives the whole path and the switcher's key.
  const pathTile = /** @type {HTMLElement|null} */ (pathChip?.querySelector('.ss-chip-tile') ?? null);
  let shownPath = '';
  // Tried whole first, and measured in the same frame, so a narrowed label
  // never paints the cut path before its name replaces it.
  const fitPathLabel = () => {
    if (!pathLabel) return;
    const name = baseName(shownPath);
    const dir = name && shownPath.endsWith(name) ? shownPath.slice(0, -name.length) : '';
    const nameEl = document.createElement('span');
    nameEl.className = 'ppd-name';
    nameEl.textContent = dir ? name : shownPath;
    if (!dir) {
      pathLabel.replaceChildren(nameEl);
      return;
    }
    const dirEl = document.createElement('span');
    dirEl.className = 'ppd-dir';
    dirEl.textContent = dir;
    pathLabel.replaceChildren(dirEl, nameEl);
    if (pathLabel.scrollWidth > pathLabel.clientWidth) dirEl.remove();
  };
  // The header's width is what the chip gets to share: watched rather than
  // the chip's, whose width follows the label this sets.
  const pathRoom = pathDisplay?.closest('.app-header') ?? pathDisplay?.parentElement;
  if (pathRoom && pathLabel) new ResizeObserver(fitPathLabel).observe(pathRoom);
  // A web font arriving changes the path's width, not the header's.
  void document.fonts?.ready.then(fitPathLabel);
  const updateProjectPath = (/** @type {string} */ projectPath) => {
    if (!pathDisplay || !pathLabel) return;
    const name = baseName(projectPath);
    shownPath = projectPath;
    fitPathLabel();
    if (pathTile) {
      pathTile.textContent = name ? initials(name) : '';
      pathTile.style.setProperty('--ss-tint', workspaceTint(ownProjectLink()));
    }
    const key = keyShortcutManager.formatBindings('switch-session')[0] || '';
    if (pathChip) {
      pathChip.title = key
        ? t('{path} — switch session ({key})', { path: projectPath, key })
        : t('{path} — switch session', { path: projectPath });
    }
  };

  // A new window, on the server's page, where the user picks a folder: what
  // the inline button, ⇧⌘N and the native menu ask a desktop window for.
  const openNewWindow = async () => {
    try {
      const { default: apiService } = await import('../services/api.js');
      await apiService.newWindow();
    } catch (err) {
      const { extractUserMessage } = await import('../../sdk/lib/error-utils.js');
      await uiPort()?.alert(extractUserMessage(err), t('New window'));
    }
  };
  // The inline button opens that window in the desktop app. A browser tab has
  // no app to open a window, so there the button opens the server's page in a
  // tab of its own instead: a session's way back to it (chooseProject, with no
  // host).
  if (newWindowBtn) {
    newWindowBtn.addEventListener('click', () => {
      void (hasNativeHost() ? openNewWindow() : chooseProject(undefined, null));
    });
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

  // Session ▸ Open… (native menu, ⌘O, the overflow menu) bridges to
  // chooseProject via this event, since the Go side can't import the JS module.
  window.addEventListener('juggler:open-project', openProjectCommand());

  // Keyboard shortcuts (undo / redo), on the visible conversation — bindings and
  // platform handling live in the KeyShortcutManager; here we only supply the
  // behaviour. Each returns truthy only when it actually acts, so the manager
  // preventDefaults exactly then (and a no-op — busy, or nothing to undo — falls
  // through untouched). The manager's own input-field guard keeps ⌘Z out of the
  // composer, which has native undo.
  keyShortcutManager.register('undo', () => {
    const conversation = session.getVisibleConversation();
    if (!historyState(conversation).canUndo) return false;
    void conversation?.undo();
    return true;
  });
  keyShortcutManager.register('redo', () => {
    const conversation = session.getVisibleConversation();
    if (!historyState(conversation).canRedo) return false;
    void conversation?.redo();
    return true;
  });

  // Keep the path display fresh.
  session.subscribe((event) => {
    if (event.type === 'session:loaded') updateProjectPath(session.projectPath || '');
  });

  // Initial state
  updateProjectPath(session.projectPath || '');
}
