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
import { hasNativeHost, pickDirectory, pickFile } from '../../sdk/lib/window-control.js';
import { focusWhenShown } from '../utils/focus.js';
import { projectsOpenInNewWindow } from '../utils/project-open-mode.js';
import { showAlert, showConfirm } from './modal-dialog.js';
import { isOpeningProject, openProjectInWindow } from './project-opening.js';

/**
 * @typedef {(path: string) => Promise<{valid: boolean, path?: string, error?: string, current?: boolean}>} ValidateFn
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
  // Where the native chooser opens. A picker asking about a file in the open
  // project says so; the project picker names none, because it is asking where a
  // new project is and the last place the app looked is the better guess.
  startDir = '',
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
        <path-input ${dirsOnly ? 'dirs-only ' : ''}placeholder="${placeholder}"${currentPath ? ` value="${currentPath.replace(/"/g, '&quot;')}"` : ''} class="pp-path-input"></path-input>
        ${hasNativeHost() ? '<button class="pp-btn pp-btn-browse" type="button">Browse…</button>' : ''}
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
    label.textContent = 'Recent sessions';
    recentsEl.appendChild(label);
    for (const path of filtered) {
      const btn = document.createElement('button');
      btn.className = 'pp-recent-item';
      btn.textContent = path;
      btn.title = path;
      btn.addEventListener('click', async () => {
        pathInputEl.value = path;
        // A click opens the entry: it does exactly what the primary confirm
        // button does — which, in the desktop switching case, is open a NEW
        // window (confirmAction === doNewWindow when confirmOpensNewWindow), not
        // switch this window in place. Route through confirmAction, never doOpen
        // directly, so both entry points stay in lockstep across window modes.
        // A path that no longer checks out stays in the field with the reason.
        if (!validate) {
          openBtn.disabled = path.trim().length === 0;
          syncNewWindowBtn();
          confirmAction();
          return;
        }
        if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
        setStatus('checking', 'Checking…');
        const gen = ++validationGen;
        try {
          const result = await validate(path);
          if (gen !== validationGen) return;
          if (result.valid) {
            setStatus('valid', result.current ? 'This is the current project' : (result.path || path));
            confirmAction();
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
        setStatus('valid', result.current ? 'This is the current project' : (result.path || val));
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
  // the OS chooser — folders only for the project picker, either for a picker
  // asking about a file — and feeds the result through the same value+validate
  // path typing uses, so the rest of the flow is identical. The panel's
  // own title is reused as the chooser's, so the sheet says what was asked.
  const browseBtn = /** @type {HTMLButtonElement|null} */ (panel.querySelector('.pp-btn-browse'));
  if (browseBtn) {
    browseBtn.addEventListener('click', async () => {
      const chosen = dirsOnly ? await pickDirectory() : await pickFile(title, startDir);
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

  // Pre-populated with the current folder path (via the path-input `value`
  // attribute above): prime the confirm/validation state so the button reflects
  // that seeded value straight away, rather than staying disabled until the
  // user first edits (path-change only fires on user input, not initial value).
  if (currentPath) {
    if (validate) {
      triggerValidation(currentPath);
    } else {
      openBtn.disabled = currentPath.trim().length === 0;
      syncNewWindowBtn();
    }
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
    await showAlert(msg, 'Open in new window');
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
  // A project already on its way into this window: the overlay covers the
  // buttons, but not the native menu's ⌘O, which arrives here directly.
  if (isOpeningProject()) return;

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

  const newWindows = projectsOpenInNewWindow();
  const switching = !!currentPath;
  // On the native desktop app, choosing a *different* project opens it in its
  // own new window, so the current project and its tabs stay exactly where they
  // are and nothing the user is looking at vanishes. In-place load is used where
  // a new window isn't an option — (a) filling an empty no-project window,
  // (b) browser / PWA / phone clients, which can't spawn a window, and (c) a
  // desktop window on a server the app did not start, whose paths may be on
  // another machine (the picker copy explains the tab-set change there).
  const newWindowOnly = newWindows && switching;
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
    onNewWindow: newWindows ? openInNewWindow : null,
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

  if (!chosen || isOpeningProject()) return;

  // Switching projects tears this window's session down server-side, abandoning
  // any in-flight turn. Warn before discarding busy conversations.
  const busy = session ? await session.busyConversationNames() : [];
  if (busy.length > 0) {
    const list = busy.map((n) => `• ${n}`).join('\n');
    const noun = busy.length === 1 ? 'conversation is' : 'conversations are';
    const ok = await showConfirm(
      `${busy.length} ${noun} still working:\n\n${list}\n\nSwitching projects will stop and discard this work. Continue?`,
      'Switch project?',
      { confirmText: 'Switch project', cancelText: 'Stay', danger: true },
    );
    if (!ok) return;
  }

  try {
    await openProjectInWindow(chosen, () => apiService.openProject(chosen), currentPath);
    // Server broadcasts `project-changed`; session listener triggers full reload.
  } catch (err) {
    const msg = extractUserMessage(err);
    await showAlert(msg, 'Open project');
  }
}

/**
 * The folder the panel offers to create in: wherever the last project came
 * from, since the next one is usually a sibling of the last. Falls back to the
 * home directory, which the server expands.
 * @param {string[]} recents - Recent project paths, most-recent first.
 * @returns {string} A parent folder path, never empty.
 */
function defaultParentFolder(recents) {
  const last = (recents && recents[0]) || '';
  const cut = Math.max(last.lastIndexOf('/'), last.lastIndexOf('\\'));
  return cut > 0 ? last.slice(0, cut) : '~';
}

/**
 * Join for display only — the two halves travel to the server separately and
 * are joined there. Follows whichever separator the parent is already written
 * with, so a Windows path does not grow a forward slash in the preview.
 * @param {string} parent
 * @param {string} name
 * @returns {string} The path the folder would be created at.
 */
function previewPath(parent, name) {
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return parent.replace(/[/\\]+$/, '') + sep + name;
}

/**
 * Why a folder name cannot be used, or "" when it can. Mirrors the server's
 * rules (`HandleNewProject`) so the reason arrives as you type rather than as a
 * rejected request.
 * @param {string} name - The trimmed folder name.
 * @returns {string} A reason, or "" when the name is fine.
 */
function folderNameProblem(name) {
  if (name === '.' || name === '..') return 'That names the parent folder, not a new one';
  if (/[/\\]/.test(name)) return 'A name cannot contain a slash — it is created inside the folder above';
  return '';
}

/**
 * Open the "new project folder" panel: make a folder and open it as the
 * project, so starting from nothing does not mean going out to the Finder to
 * create a folder and coming back.
 *
 * Anchored to the header project chip, like the picker it sits beside.
 * @param {string[]} [recents] - Recent project paths, used only to guess where
 *   the new folder should go.
 * @returns {void}
 */
export function openNewProjectPanel(recents = []) {
  // Toggle, like every other button popup. Before the first await so a rapid
  // second click cannot race a half-built panel.
  if (closePopupById('new-project')) return;
  if (isOpeningProject()) return;

  const anchor = /** @type {HTMLElement|null} */ (document.getElementById('project-path-chip'));
  if (!anchor) {
    console.warn('[project-picker] no anchor (#project-path-chip) found; cannot open the new-project panel');
    return;
  }

  const parentValue = defaultParentFolder(recents);
  const panel = document.createElement('div');
  panel.className = 'pp-panel pp-panel-popup';
  panel.innerHTML = `
    <div class="pp-header">
      <span class="pp-title">New project folder</span>
      <span class="pp-subtitle">Creates an empty folder and opens it.</span>
    </div>
    <div class="pp-body">
      <div class="pp-input-row">
        <path-input dirs-only placeholder="Where to create it…" value="${parentValue.replace(/"/g, '&quot;')}" class="pp-path-input"></path-input>
        ${hasNativeHost() ? '<button class="pp-btn pp-btn-browse" type="button">Browse…</button>' : ''}
      </div>
      <input type="text" class="pp-name-input" placeholder="Folder name" spellcheck="false" autocomplete="off">
      <div class="pp-status" aria-live="polite"></div>
    </div>
    <div class="pp-footer">
      <button class="pp-btn pp-btn-open" disabled>Create</button>
    </div>
  `;

  const pathInputEl = /** @type {import('./path-input.js').default & HTMLElement} */ (
    panel.querySelector('path-input')
  );
  const nameEl = /** @type {HTMLInputElement} */ (panel.querySelector('.pp-name-input'));
  const statusEl = /** @type {HTMLElement} */ (panel.querySelector('.pp-status'));
  const createBtn = /** @type {HTMLButtonElement} */ (panel.querySelector('.pp-btn-open'));

  /**
   * Show the path that would be created, or the reason it would not be. The
   * preview is the whole validation UI: seeing the absolute path is what tells
   * someone the folder is going where they think it is.
   * @returns {void}
   */
  function sync() {
    const parent = pathInputEl.value.trim();
    const name = nameEl.value.trim();
    if (!parent || !name) {
      statusEl.className = 'pp-status pp-status--idle';
      statusEl.textContent = '';
      createBtn.disabled = true;
      return;
    }
    const problem = folderNameProblem(name);
    if (problem) {
      statusEl.className = 'pp-status pp-status--invalid';
      statusEl.textContent = problem;
      createBtn.disabled = true;
      return;
    }
    statusEl.className = 'pp-status pp-status--valid';
    statusEl.textContent = previewPath(parent, name);
    createBtn.disabled = false;
  }

  pathInputEl.addEventListener('path-change', sync);
  nameEl.addEventListener('input', sync);

  const browseBtn = /** @type {HTMLButtonElement|null} */ (panel.querySelector('.pp-btn-browse'));
  if (browseBtn) {
    browseBtn.addEventListener('click', async () => {
      const chosen = await pickDirectory();
      if (!chosen) return;
      pathInputEl.value = chosen;
      sync();
    });
  }

  // `onClose` is how every dismissal the surface owns — Escape, a click outside,
  // the sheet's scrim and its drag — asks for the panel to go away, so it has to
  // be the teardown itself. The guard makes it idempotent and lets it stand in
  // for `release` everywhere, including a close arriving before presentPopup has
  // returned one.
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
    id: 'new-project',
    onClose: close,
    align: 'left',
    insideSelectors: ['.pp-panel', '#project-path-chip', '.path-input-menu'],
  });
  if (closed) release();

  /** @returns {Promise<void>} */
  async function create() {
    if (createBtn.disabled) return;
    createBtn.disabled = true;
    const parent = pathInputEl.value.trim();
    const name = nameEl.value.trim();
    try {
      // A freshly made folder is never the one already loaded, so no current
      // path is passed: success always means a reload is coming.
      const resp = await openProjectInWindow(name, () => apiService.createProject(parent, name));
      if (!resp) {
        createBtn.disabled = false;
        return;
      }
      // Server broadcasts `project-changed`; session listener triggers full reload.
      close();
    } catch (err) {
      // An existing folder is reported against the path, never adopted: the
      // request was to create something, and opening someone else's work
      // instead is a different decision.
      createBtn.disabled = false;
      await showAlert(extractUserMessage(err), 'New project folder');
    }
  }

  createBtn.addEventListener('click', () => void create());
  nameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !createBtn.disabled) void create();
  });
  pathInputEl.addEventListener('keydown', (e) => {
    // Only when the completion dropdown is closed, which owns Enter while open.
    if (e.key === 'Enter' && !document.querySelector('.completions-menu')) nameEl.focus();
  });

  focusWhenShown(nameEl, { delay: 50 });
}
