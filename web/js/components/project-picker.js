//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The path picker panel: a path typed (with completions), browsed for with the
 * native chooser, or taken from a list of recents. Context-item and pin add
 * dialogs present it (files allowed, with Cancel).
 */

import './path-input.js';
import { hasNativeHost, pickDirectory, pickFile } from '../../sdk/lib/window-control.js';
import { focusWhenShown } from '../utils/focus.js';
import { t } from '../../sdk/lib/i18n.js';
import { escapeHtml } from '../../sdk/lib/html.js';

/**
 * @typedef {{
 *   recents?: string[] | Promise<string[]>,
 *   currentPath?: string,
 *   showCancel?: boolean,
 *   title?: string,
 *   subtitle?: string,
 *   placeholder?: string,
 *   dirsOnly?: boolean,
 *   confirmLabel?: string,
 *   startDir?: string,
 * }} PickerPanelOptions
 * @typedef {{ element: HTMLElement, promise: Promise<string|null>, cancel: () => void }} PickerPanel
 */

/**
 * Build a path-picker panel element. The confirm button enables on any
 * non-empty input.
 * Resolves with the chosen path string, or null if cancelled.
 * @param {PickerPanelOptions} opts
 * @returns {PickerPanel} Panel element, promise that resolves with path or null, and cancel fn
 */
export function buildPickerPanel({
  recents = [],
  currentPath = '',
  showCancel = true,
  title = t('Open project folder'),
  subtitle = '',
  placeholder = t('Path to project folder…'),
  dirsOnly = true,
  confirmLabel = t('Open'),
  // Where the native chooser opens, for a picker asking about a file.
  startDir = '',
} = {}) {
  /** @type {(v: string|null) => void} */
  let resolve = () => {};
  const promise = /** @type {Promise<string|null>} */ (new Promise((r) => { resolve = r; }));

  const panel = document.createElement('div');
  panel.className = 'pp-panel';
  panel.innerHTML = `
    <div class="pp-header">
      <span class="pp-title">${escapeHtml(title)}</span>
      ${subtitle ? `<span class="pp-subtitle">${escapeHtml(subtitle)}</span>` : ''}
    </div>
    <div class="pp-body">
      <div class="pp-input-row">
        <path-input ${dirsOnly ? 'dirs-only ' : ''}placeholder="${escapeHtml(placeholder)}"${currentPath ? ` value="${escapeHtml(currentPath)}"` : ''} class="pp-path-input"></path-input>
        ${hasNativeHost() ? `<button class="pp-btn pp-btn-browse" type="button">${escapeHtml(t('Browse…'))}</button>` : ''}
      </div>
      <div class="pp-recents" hidden></div>
    </div>
    <div class="pp-footer">
      ${showCancel ? `<button class="pp-btn pp-btn-cancel">${escapeHtml(t('Cancel'))}</button>` : ''}
      <button class="pp-btn pp-btn-open" disabled>${escapeHtml(confirmLabel)}</button>
    </div>
  `;

  const pathInputEl = /** @type {import('./path-input.js').default & HTMLElement} */ (
    panel.querySelector('path-input')
  );
  const recentsEl = /** @type {HTMLElement} */ (panel.querySelector('.pp-recents'));
  const cancelBtn = /** @type {HTMLButtonElement|null} */ (panel.querySelector('.pp-btn-cancel'));
  const openBtn = /** @type {HTMLButtonElement} */ (panel.querySelector('.pp-btn-open'));

  /**
   * Enable the confirm button for whatever the field holds.
   * @param {string} value
   * @returns {void}
   */
  const sync = (value) => {
    openBtn.disabled = value.trim().length === 0;
  };

  // --- recents ---
  // `recents` may be an array (rendered now) or a Promise (the picker opens
  // immediately and the list fills in when it resolves), so a caller presents
  // the picker synchronously, with no network wait before it appears.
  /**
   * @param {string[]} list
   * @returns {void}
   */
  const renderRecents = (list) => {
    recentsEl.innerHTML = '';
    const filtered = list.filter((p) => p && p !== currentPath).slice(0, 8);
    if (filtered.length === 0) {
      recentsEl.setAttribute('hidden', '');
      return;
    }
    recentsEl.removeAttribute('hidden');
    const label = document.createElement('div');
    label.className = 'pp-recents-label';
    label.textContent = t('Recent sessions');
    recentsEl.appendChild(label);
    for (const path of filtered) {
      const btn = document.createElement('button');
      btn.className = 'pp-recent-item';
      btn.textContent = path;
      btn.title = path;
      // A click opens the entry: exactly what the confirm button does.
      btn.addEventListener('click', () => {
        pathInputEl.value = path;
        sync(path);
        doOpen();
      });
      recentsEl.appendChild(btn);
    }
  };

  if (recents && typeof (/** @type {any} */ (recents)).then === 'function') {
    /** @type {Promise<string[]>} */ (recents).then(renderRecents).catch(() => renderRecents([]));
  } else {
    renderRecents(/** @type {string[]} */ (recents) || []);
  }

  pathInputEl.addEventListener('path-change', (e) => {
    sync(/** @type {CustomEvent<{value:string}>} */ (e).detail.value);
  });

  // Native "Browse…" button (desktop app only; absent in a browser tab). Opens
  // the OS chooser — folders only for a folder picker, either for a picker
  // asking about a file — and feeds the result into the field as typing does.
  // The panel's own title is reused as the chooser's, so the sheet says what
  // was asked.
  const browseBtn = /** @type {HTMLButtonElement|null} */ (panel.querySelector('.pp-btn-browse'));
  if (browseBtn) {
    browseBtn.addEventListener('click', async () => {
      const chosen = dirsOnly ? await pickDirectory() : await pickFile(title, startDir);
      if (!chosen) return;
      pathInputEl.value = chosen;
      sync(chosen);
    });
  }

  /** @returns {void} */
  function doOpen() {
    if (openBtn.disabled) return;
    const val = pathInputEl.value.trim();
    if (!val) return;
    resolve(val);
  }

  openBtn.addEventListener('click', doOpen);
  pathInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !openBtn.disabled) {
      // An Enter the field consumed took a completion; it is not also a confirm.
      if (!e.defaultPrevented) doOpen();
    }
  });

  /** @returns {void} */
  function cancel() {
    resolve(null);
  }

  if (cancelBtn) cancelBtn.addEventListener('click', cancel);

  // Pre-populated with currentPath (via the path-input `value` attribute
  // above): path-change only fires on user input, so the button is primed for
  // the seeded value here.
  sync(currentPath);

  focusWhenShown(pathInputEl, { delay: 50 });

  return { element: panel, promise, cancel };
}
