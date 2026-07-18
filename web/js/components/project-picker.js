//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Project picker — a modal that lets the user open a different project
 * folder by typing a path or selecting from the user-level recents list.
 *
 * `buildPickerPanel` is the shared core, used both here (modal with Cancel),
 * by <no-project-overlay> (inline, no cancel), and by context-item add dialogs
 * (no validation, files allowed).
 */

import './path-input.js';
import apiService from '../services/api.js';
import { extractUserMessage } from '../../sdk/lib/error-utils.js';
import { presentPopup } from '../utils/popup-surface.js';
import { closePopupById } from '../utils/popup-manager.js';
import { hasNativeHost, pickDirectory } from '../../sdk/lib/window-control.js';
import { focusWhenShown } from '../utils/focus.js';

/**
 * @typedef {(path: string) => Promise<{valid: boolean, path?: string, error?: string}>} ValidateFn
 * @typedef {{
 *   recents?: string[] | Promise<string[]>,
 *   currentPath?: string,
 *   showCancel?: boolean,
 *   title?: string,
 *   subtitle?: string,
 *   placeholder?: string,
 *   dirsOnly?: boolean,
 *   confirmLabel?: string,
 *   confirmOpensNewWindow?: boolean,
 *   validate?: ValidateFn | null,
 *   onNewWindow?: ((path: string) => void) | null,
 *   newWindowLabel?: string
 * }} PickerPanelOptions
 * @typedef {{ element: HTMLElement, promise: Promise<string|null>, cancel: () => void }} PickerPanel
 */

/**
 * Build a path-picker panel element.
 * When `validate` is provided, the confirm button stays disabled until validation
 * passes and a live status is shown. Without it, the button enables on any
 * non-empty input.
 * Resolves with the chosen path string, or null if cancelled.
 * @param {PickerPanelOptions} opts
 * @returns {PickerPanel} Panel element, promise that resolves with path or null, and cancel fn
 */
export function buildPickerPanel({
  recents = [],
  currentPath = '',
  showCancel = true,
  title = 'Open project folder',
  subtitle = '',
  placeholder = 'Path to project folder…',
  dirsOnly = true,
  confirmLabel = 'Open',
  // When true, the primary confirm button launches the chosen folder in a new
  // window (via onNewWindow) instead of resolving a path for an in-place load,
  // and the separate secondary new-window button is suppressed as redundant.
  confirmOpensNewWindow = false,
  validate = null,
  onNewWindow = null,
  newWindowLabel = 'Open in new window',
} = {}) {
  /** @type {(v: string|null) => void} */
  let resolve = () => {};
  const promise = /** @type {Promise<string|null>} */ (new Promise((r) => { resolve = r; }));

  const panel = document.createElement('div');
  panel.className = 'pp-panel';
  panel.innerHTML = `
    <div class="pp-header">
      <span class="pp-title">${title}</span>
      ${subtitle ? `<span class="pp-subtitle">${subtitle}</span>` : ''}
    </div>
    <div class="pp-body">
      <div class="pp-input-row">
        <path-input ${dirsOnly ? 'dirs-only ' : ''}placeholder="${placeholder}" class="pp-path-input"></path-input>
        ${dirsOnly && hasNativeHost() ? '<button class="pp-btn pp-btn-browse" type="button">Browse…</button>' : ''}
      </div>
      <div class="pp-status" aria-live="polite"${validate ? '' : ' hidden'}></div>
      <div class="pp-recents" hidden></div>
    </div>
    <div class="pp-footer">
      ${showCancel ? '<button class="pp-btn pp-btn-cancel">Cancel</button>' : ''}
      ${onNewWindow && !confirmOpensNewWindow ? `<button class="pp-btn pp-btn-newwindow" disabled>${newWindowLabel}</button>` : ''}
      <button class="pp-btn pp-btn-open" disabled>${confirmLabel}</button>
    </div>
  `;

  const pathInputEl = /** @type {import('./path-input.js').default & HTMLElement} */ (
    panel.querySelector('path-input')
  );
  const statusEl = /** @type {HTMLElement} */ (panel.querySelector('.pp-status'));
  const recentsEl = /** @type {HTMLElement} */ (panel.querySelector('.pp-recents'));
  const cancelBtn = /** @type {HTMLButtonElement|null} */ (panel.querySelector('.pp-btn-cancel'));
  const openBtn = /** @type {HTMLButtonElement} */ (panel.querySelector('.pp-btn-open'));
  const newWindowBtn = /** @type {HTMLButtonElement|null} */ (panel.querySelector('.pp-btn-newwindow'));

  // Last validated absolute path (set when validation passes). Preferred over
  // the raw input for the new-window launch so the child gets a clean abs path.
  let lastValidPath = '';

  // --- recents ---
  // `recents` may be an array (rendered now) or a Promise (the picker opens
  // immediately and the list fills in when it resolves). The Promise form lets
  // the caller present the picker synchronously — no network wait before the
  // popup appears — exactly like every other button popup.
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
    label.textContent = 'Recent folders';
    recentsEl.appendChild(label);
    for (const path of filtered) {
      const btn = document.createElement('button');
      btn.className = 'pp-recent-item';
      btn.textContent = path;
      btn.title = path;
      btn.addEventListener('click', () => {
        pathInputEl.value = path;
        if (validate) {
          triggerValidation(path);
        } else {
          openBtn.disabled = path.trim().length === 0;
          syncNewWindowBtn();
        }
      });
      btn.addEventListener('dblclick', async () => {
        pathInputEl.value = path;
        if (!validate) { doOpen(); return; }
        if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
        setStatus('checking', 'Checking…');
        const gen = ++validationGen;
        try {
          const result = await validate(path);
          if (gen !== validationGen) return;
          if (result.valid) {
            setStatus('valid', result.path || path);
            doOpen();
          } else {
            setStatus('invalid', result.error || 'Invalid path');
          }
        } catch (_err) {
          if (gen !== validationGen) return;
          setStatus('invalid', 'Could not check path');
        }
      });
      recentsEl.appendChild(btn);
    }
  };

  if (recents && typeof (/** @type {any} */ (recents)).then === 'function') {
    /** @type {Promise<string[]>} */ (recents).then(renderRecents).catch(() => renderRecents([]));
  } else {
    renderRecents(/** @type {string[]} */ (recents) || []);
  }

  // --- live validation (only when validate fn is provided) ---
  /** @type {ReturnType<typeof setTimeout>|null} */
  let debounceTimer = null;
  let validationGen = 0;

  /**
   * @param {'idle'|'checking'|'valid'|'invalid'} state
   * @param {string} [message]
   * @returns {void}
   */
  function setStatus(state, message = '') {
    statusEl.className = 'pp-status pp-status--' + state;
    statusEl.textContent = message;
    openBtn.disabled = state !== 'valid';
    if (state === 'valid') lastValidPath = message;
    syncNewWindowBtn();
  }

  /**
   * Keep the optional "Open in new window" button enabled in lockstep with the
   * primary Open button (same validity gate).
   * @returns {void}
   */
  function syncNewWindowBtn() {
    if (newWindowBtn) newWindowBtn.disabled = openBtn.disabled;
  }

  /**
   * @param {string} raw
   * @returns {void}
   */
  function triggerValidation(raw) {
    const val = raw.trim();
    if (!val) { setStatus('idle', ''); return; }
    setStatus('checking', 'Checking…');
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => checkPath(val), 200);
  }

  /**
   * @param {string} val
   * @returns {Promise<void>}
   */
  async function checkPath(val) {
    if (!validate) return;
    const gen = ++validationGen;
    try {
      const result = await validate(val);
      if (gen !== validationGen) return;
      if (result.valid) {
        setStatus('valid', result.path || val);
      } else {
        setStatus('invalid', result.error || 'Invalid path');
      }
    } catch (_err) {
      if (gen !== validationGen) return;
      setStatus('invalid', 'Could not check path');
    }
  }

  pathInputEl.addEventListener('path-change', (e) => {
    const val = /** @type {CustomEvent<{value:string}>} */ (e).detail.value;
    if (validate) {
      triggerValidation(val);
    } else {
      openBtn.disabled = val.trim().length === 0;
      syncNewWindowBtn();
    }
  });

  // Native "Browse…" button (desktop app only; absent in a browser tab). Opens
  // the OS folder chooser and feeds the result through the same value+validate
  // path a recents click uses, so the rest of the flow is identical.
  const browseBtn = /** @type {HTMLButtonElement|null} */ (panel.querySelector('.pp-btn-browse'));
  if (browseBtn) {
    browseBtn.addEventListener('click', async () => {
      const chosen = await pickDirectory();
      if (!chosen) return;
      pathInputEl.value = chosen;
      if (validate) {
        triggerValidation(chosen);
      } else {
        openBtn.disabled = chosen.trim().length === 0;
        syncNewWindowBtn();
      }
    });
  }

  /** @returns {void} */
  function doOpen() {
    if (openBtn.disabled) return;
    const val = pathInputEl.value.trim();
    if (!val) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    resolve(val);
  }

  /**
   * Launch the chosen folder in a new window instead of switching this one.
   * Hands the path to the caller-supplied onNewWindow, then dismisses the
   * picker (resolve(null)) — this window keeps its current project.
   * @returns {void}
   */
  function doNewWindow() {
    if (!onNewWindow || (newWindowBtn && newWindowBtn.disabled)) return;
    const val = (lastValidPath || pathInputEl.value.trim());
    if (!val) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    onNewWindow(val);
    resolve(null);
  }

  // The primary button either loads in place or opens a new window, depending
  // on the caller's mode; the secondary button (when present) always opens new.
  const confirmAction = confirmOpensNewWindow ? doNewWindow : doOpen;
  openBtn.addEventListener('click', confirmAction);
  if (newWindowBtn) newWindowBtn.addEventListener('click', doNewWindow);
  pathInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !openBtn.disabled) {
      // Only trigger the confirm action when the completion dropdown is hidden.
      if (!document.querySelector('.completions-menu')) confirmAction();
    }
  });

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      resolve(null);
    });
  }

  /** @returns {void} */
  function cancel() {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    resolve(null);
  }

  focusWhenShown(pathInputEl, { delay: 50 });

  return { element: panel, promise, cancel };
}

/**
 * Launch a project folder in a brand-new, independent window/process. Errors
 * (e.g. the project is already open in another instance) surface as an alert.
 * Exported so both the modal picker and the no-project overlay can reuse it.
 * @param {string} path - Project folder to open in the new window
 * @returns {Promise<void>}
 */
async function openInNewWindow(path) {
  try {
    await apiService.newWindow(path);
  } catch (err) {
    const msg = extractUserMessage(err);
    await window.showAlert(msg, 'Open in new window');
  }
}

/**
 * Open the project picker, anchored to the header project chip.
 *
 * Presented through the shared `presentPopup` surface, so it is one consistent
 * mechanism with every other button popup: an anchored dropdown on desktop, a
 * bottom sheet (scrim + grabber + drag-to-dismiss) on a phone. presentPopup
 * owns body-append, Escape/outside-click dismissal, the reposition observer,
 * and the narrow-screen decision — so this function holds none of it.
 * @param {string} currentPath - Currently-loaded project path (may be "")
 * @param {import('../model/session.js').default | null} [session] - Current
 *   session, used to warn before switching away from a project with in-flight
 *   work.
 * @returns {Promise<void>}
 */
export async function openProjectPicker(currentPath, session) {
  // Toggle: a second activation while the picker is open dismisses it, matching
  // every other button popup. The one shared primitive does this — no
  // picker-local open-state flag. Must run before the first await so a rapid
  // second click can't race a half-built picker.
  if (closePopupById('project-picker')) return;

  const anchor = /** @type {HTMLElement|null} */ (document.getElementById('project-path-chip'));
  if (!anchor) {
    console.warn('[project-picker] no anchor (#project-path-chip) found; cannot open picker');
    return;
  }

  // Load recents in the background and let the panel fill them in when they
  // arrive — the picker must NOT await a network round-trip before presenting,
  // or it would open a window (wider on a high-latency mobile/remote link)
  // where a second tap races the pending open and dismisses it. Every other
  // popup opens synchronously on click; this now does too.
  const recents = apiService.getRecents()
    .then((resp) => (resp && resp.paths) || [])
    .catch((err) => {
      console.warn('[project-picker] failed to load recents:', err);
      return [];
    });

  const inWindowMode = document.documentElement.dataset.windowMode === '1';
  const switching = !!currentPath;
  // On the native desktop app, switching to a *different* project no longer
  // tears this window down: the chosen folder opens in its own new window, so
  // the current project and its tabs stay exactly where they are and nothing
  // the user is looking at vanishes. In-place load survives only where a new
  // window isn't an option — (a) filling an empty no-project window, and
  // (b) browser / PWA / phone clients, which can't spawn a window and so must
  // reuse this one (the picker copy explains the tab-set change there).
  const newWindowOnly = inWindowMode && switching;
  const { element, promise, cancel } = buildPickerPanel({
    recents,
    currentPath,
    title: newWindowOnly ? 'Open project folder'
      : switching ? 'Switch project folder'
        : 'Open project folder',
    confirmLabel: newWindowOnly ? 'Open'
      : switching ? 'Switch' : 'Open',
    subtitle: newWindowOnly
      ? ''
      : switching
        ? 'The tabs in a juggler session are stored inside the project folder. Switching '
          + 'to a different folder will reload the tabs from that folder (or create a '
          + 'new empty session in it).'
        : '',
    // Dismissal is the surface's job (outside-click / Esc / scrim / drag),
    // so the panel needs no in-body Cancel button.
    showCancel: false,
    confirmOpensNewWindow: newWindowOnly,
    validate: (path) => apiService.checkProject(path),
    onNewWindow: inWindowMode ? openInNewWindow : null,
  });
  // Marks this panel as a presented surface (fixed, var-positioned) without
  // touching the plain centred-card `.pp-panel` used by inline consumers.
  element.classList.add('pp-panel-popup');

  const release = presentPopup({
    surface: element,
    anchor,
    id: 'project-picker',
    onClose: () => cancel(),
    align: 'left',
    // The path-input completion menu portals to <body>; its selector is
    // "inside" so picking a completion doesn't dismiss the picker.
    insideSelectors: ['.pp-panel', '#project-path-chip', '.path-input-menu'],
  });

  const chosen = await promise;
  release();

  if (!chosen) return;

  // Switching projects tears this window's session down server-side, abandoning
  // any in-flight turn. Warn before discarding busy conversations.
  const busy = session ? await session.busyConversationNames() : [];
  if (busy.length > 0) {
    const list = busy.map((n) => `• ${n}`).join('\n');
    const noun = busy.length === 1 ? 'conversation is' : 'conversations are';
    const ok = await window.showConfirm(
      `${busy.length} ${noun} still working:\n\n${list}\n\nSwitching projects will stop and discard this work. Continue?`,
      'Switch project?',
      { confirmText: 'Switch project', cancelText: 'Stay', danger: true },
    );
    if (!ok) return;
  }

  try {
    await apiService.openProject(chosen);
    // Server broadcasts `project-changed`; session listener triggers full reload.
  } catch (err) {
    const msg = extractUserMessage(err);
    await window.showAlert(msg, 'Open project');
  }
}
