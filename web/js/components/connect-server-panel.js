//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The "Connect to a server" panel: type the address of a Juggler server on
 * another computer, and the desktop app opens a window onto it — one it reopens
 * at launch exactly as it does a project window.
 *
 * Desktop only: the window is the app's to open, through its control endpoint.
 * And only from a window on this computer's own server. The app refuses
 * `connect` to a window that is itself on a server by URL: a page another
 * computer's server sent may move its window only within that server (to one
 * of its sessions, or back to its page — juggler-app/control.go's
 * windowActions), never point it at a different one. So such a window is told
 * where to go instead of being offered a field that cannot work.
 * @module components/connect-server-panel
 */

import apiService from '../services/api.js';
import { extractUserMessage } from '../../sdk/lib/error-utils.js';
import { presentPopup } from '../utils/popup-surface.js';
import { closePopupById } from '../utils/popup-manager.js';
import { hasNativeHost } from '../../sdk/lib/window-control.js';
import { focusWhenShown } from '../utils/focus.js';
import { showAlert } from './modal-dialog.js';
import { t } from '../../sdk/lib/i18n.js';
import { escapeHtml } from '../../sdk/lib/html.js';

/**
 * Whether this window can connect to a server: a desktop window on a server
 * the app resolved itself, not one it opened by URL.
 * @param {boolean} [nativeHost] - Whether the page has a native host.
 * @returns {boolean} True when the panel can be offered.
 */
export function canConnectToServer(nativeHost = hasNativeHost()) {
  return nativeHost && document.documentElement.dataset.externalServer !== '1';
}

/**
 * Open the panel, placed under the header's project path. A second call while it is open closes it, as every button popup
 * does. A browser tab has no native host and nothing happens; a window on a
 * server by URL is told to connect from a new window.
 * @param {object} [options]
 * @param {(address: string) => Promise<unknown>} [options.connect] - Asks the
 *   app for the window.
 * @param {boolean} [options.nativeHost] - Whether the page has a native host.
 * @returns {Promise<void>}
 */
export async function openConnectServerPanel({
  connect: requestWindow = (address) => apiService.connectServer(address),
  nativeHost = hasNativeHost(),
} = {}) {
  // Toggle, before the first await, so a rapid second activation cannot race a
  // half-built panel.
  if (closePopupById('connect-server')) return;
  if (!nativeHost) return;
  if (!canConnectToServer(nativeHost)) {
    await showAlert(
      t('This window shows a server on another computer, so it cannot connect to a different one. Open a new window and connect from there.'),
      t('Connect to a server'),
    );
    return;
  }

  const anchor = /** @type {HTMLElement|null} */ (document.getElementById('project-path-chip'));
  if (!anchor) {
    console.warn('[connect-server] no anchor (#project-path-chip) found; cannot open the panel');
    return;
  }

  const panel = document.createElement('div');
  panel.className = 'pp-panel pp-panel-popup';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('Connect to a server'));
  panel.innerHTML = `
    <div class="pp-header">
      <span class="pp-title">${escapeHtml(t('Connect to a server'))}</span>
      <span class="pp-subtitle">${escapeHtml(t('Opens a window onto Juggler running on another computer. Like a project window, it reopens when Juggler starts.'))}</span>
    </div>
    <div class="pp-body">
      <input type="text" class="pp-address-input field-input" placeholder="${escapeHtml(t('Server address, e.g. http://devbox:3939'))}" spellcheck="false" autocomplete="off" autocapitalize="off" inputmode="url">
      <div class="pp-status" aria-live="polite"></div>
    </div>
    <div class="pp-footer">
      <button class="pp-btn pp-btn-open" disabled>${escapeHtml(t('Connect'))}</button>
    </div>
  `;

  const addressEl = /** @type {HTMLInputElement} */ (panel.querySelector('.pp-address-input'));
  const statusEl = /** @type {HTMLElement} */ (panel.querySelector('.pp-status'));
  const connectBtn = /** @type {HTMLButtonElement} */ (panel.querySelector('.pp-btn-open'));

  /**
   * @param {'idle'|'checking'|'invalid'} state
   * @param {string} [message]
   * @returns {void}
   */
  const setStatus = (state, message = '') => {
    // Whole literals, so the stylesheet checks can read which classes share
    // this element.
    statusEl.className = state === 'checking' ? 'pp-status pp-status--checking'
      : state === 'invalid' ? 'pp-status pp-status--invalid'
        : 'pp-status pp-status--idle';
    statusEl.textContent = message;
  };

  addressEl.addEventListener('input', () => {
    connectBtn.disabled = addressEl.value.trim() === '';
    setStatus('idle');
  });

  // `onClose` is how every dismissal the surface owns asks for the panel to go
  // away, so it is the teardown itself; the guard makes it idempotent and lets
  // it stand in for `release`, including a close arriving before presentPopup
  // has returned one.
  /** @type {(() => void)|null} */
  let release = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    release?.();
  };

  release = presentPopup({
    surface: panel,
    anchor,
    id: 'connect-server',
    onClose: close,
    align: 'left',
    insideSelectors: ['.pp-panel', '#project-path-chip'],
  });
  if (closed) release();

  /** @returns {Promise<void>} */
  async function connect() {
    const address = addressEl.value.trim();
    if (connectBtn.disabled || !address) return;
    connectBtn.disabled = true;
    // The app waits a few seconds for the server before it opens either the
    // window or a page saying it could not reach it; this panel closes as soon
    // as the app has the request, so it never waits on that.
    setStatus('checking', t('Connecting…'));
    try {
      await requestWindow(address);
      close();
    } catch (err) {
      connectBtn.disabled = false;
      setStatus('invalid', extractUserMessage(err));
    }
  }

  connectBtn.addEventListener('click', () => void connect());
  addressEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void connect();
  });

  focusWhenShown(addressEl, { delay: 50 });
}
