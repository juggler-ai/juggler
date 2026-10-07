//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <no-project-overlay> — full-area placeholder shown when no project is
 * loaded. It is the first thing a new user sees, so it carries the ways into a
 * project (open an existing folder, create a new one, drop one on the window),
 * the recents a returning user actually came back for, and a live statement of
 * whether an AI provider is connected — the one prerequisite that otherwise
 * fails silently at the first message.
 *
 * What it shows is derived from live state and nothing else: no first-run flag
 * is persisted. A window with no provider and no recents is someone's first
 * launch and gets the explanation; a window with recents is someone who just
 * closed a project and gets their list, not a lecture.
 */

import apiService from '../services/api.js';
import wsService from '../services/websocket.js';
import providersCache from '../services/providers-cache.js';
import { openSettings } from '../services/settings-launcher.js';
import { extractUserMessage } from '../../sdk/lib/error-utils.js';
import { hasNativeHost, reportFolderDropped } from '../../sdk/lib/window-control.js';
import { showAlert } from './modal-dialog.js';
import { openProjectInWindow } from './project-opening.js';

/** How many recent folders the panel offers before it stops being a shortlist. */
const RECENTS_SHOWN = 5;

/** How many providers are named before the rest become a count. */
const PROVIDERS_NAMED = 2;

class NoProjectOverlay extends HTMLElement {
  constructor() {
    super();
    /** @type {import('../model/session.js').default|null} @private */
    this._session = null;
    /** @type {Function|null} @private */
    this._unsubscribe = null;
    /** @type {boolean} @private */
    this._rendered = false;
    /** @type {string[]} @private */
    this._recents = [];
    /** @type {((data: unknown) => void)|null} @private */
    this._providersUpdateHandler = null;
    /** @type {((event: Event) => void)|null} @private */
    this._folderDropHandler = null;
    /** @type {Record<string, Function>|null} @private */
    this._nativeDragHooks = null;
  }

  connectedCallback() {
    // The cache has no change event of its own, so the live feed it is built
    // from is what a status line subscribes to (same idiom as model-selector).
    this._providersUpdateHandler = () => this._renderProviderStatus();
    wsService.on('providers-update', this._providersUpdateHandler);

    // A folder dropped on an empty window. The native host reads the path off
    // the drag pasteboard and announces it here, because the page is never told
    // one: WebKit withholds the filesystem path from every file drag.
    this._folderDropHandler = (/** @type {any} */ e) => {
      const path = e?.detail?.path;
      if (typeof path === 'string' && path) void this._open(path);
    };
    window.addEventListener('juggler:folder-dropped', this._folderDropHandler);

    this._installNativeDragHooks();
  }

  disconnectedCallback() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    if (this._providersUpdateHandler) {
      wsService.off('providers-update', this._providersUpdateHandler);
      this._providersUpdateHandler = null;
    }
    if (this._folderDropHandler) {
      window.removeEventListener('juggler:folder-dropped', this._folderDropHandler);
      this._folderDropHandler = null;
    }
    this._removeNativeDragHooks();
  }

  /**
   * Take over the hooks the native side calls during a file drag. It reaches the
   * page by ExecJS onto `window._wails` — `handleDragEnter`, `handleDragLeave`
   * and `handleDragOver` while a drag is over the window, and
   * `handlePlatformFileDrop` with the paths once it is released.
   *
   * The Wails runtime installs its own versions and none of them can work here.
   * Each ends in an outbound RPC to `/wails/runtime`, a route only the Wails
   * asset server answers, whereas this page is served by Juggler's own server —
   * so the dropped paths reach the page and go no further. Its drop handler also
   * hit-tests the drop point with `elementFromPoint`, against coordinates the
   * native side measured in window points, which page zoom has already made a
   * different unit. Ours read the paths straight off the argument list and let
   * the host decide what they name, so neither the missing route nor the
   * coordinates come into it.
   *
   * Installed from `connectedCallback`, which runs after `/wails/runtime.js` —
   * the first script in `<body>`, so its module has already evaluated and these
   * replace the runtime's rather than being replaced by them.
   * @private
   */
  _installNativeDragHooks() {
    const w = /** @type {any} */ (window);
    w._wails = w._wails || {};
    this._nativeDragHooks = {
      handleDragEnter: () => this._setDropActive(true),
      handleDragLeave: () => this._setDropActive(false),
      // Where in the window the folder is hovering decides nothing: all of it
      // accepts a drop, so there is no target to hit-test for.
      handleDragOver: () => this._setDropActive(true),
      handlePlatformFileDrop: (/** @type {string[]} */ paths) => {
        this._setDropActive(false);
        // A window showing a project has native drop switched off, so this is
        // only reachable while the overlay is up. Guarded anyway: a drop is a
        // one-way action, and one aimed at a project that is already open is
        // not what the gesture meant.
        if (this.hidden) return;
        void reportFolderDropped(paths);
      },
    };
    Object.assign(w._wails, this._nativeDragHooks);
  }

  /**
   * Give back any hook still ours, so a replaced one is left alone.
   * @private
   */
  _removeNativeDragHooks() {
    const w = /** @type {any} */ (window);
    if (!this._nativeDragHooks || !w._wails) {
      this._nativeDragHooks = null;
      return;
    }
    for (const [name, fn] of Object.entries(this._nativeDragHooks)) {
      if (w._wails[name] === fn) delete w._wails[name];
    }
    this._nativeDragHooks = null;
  }

  /**
   * Mark the window as holding a folder, which the panel reads to outline
   * itself. Never while the overlay is hidden: there is nothing to drop onto.
   * @param {boolean} active - Whether a folder is currently over the window.
   * @private
   */
  _setDropActive(active) {
    this.classList.toggle('folder-drop-active', active && !this.hidden);
  }

  /**
   * @param {import('../model/session.js').default} session
   */
  setSession(session) {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    this._session = session;
    this._refresh();
    if (session) {
      this._unsubscribe = session.subscribe(/** @param {{type: string}} event */ (event) => {
        if (
          event.type === 'project:changed'
          || event.type === 'session:loaded'
          || event.type === 'conversation:created'
          || event.type === 'conversation:deleted'
        ) {
          this._refresh();
        }
      });
    }
  }

  /** @private */
  _refresh() {
    const empty = !this._session || !this._session.projectPath;

    // The sidebar and the tab column are hidden by one class on <body>, whose
    // rule lives beside this element's own CSS. Writing inline display on each
    // sibling instead would mean this element deciding, from the outside, what
    // "visible" means for two components that style themselves — and the reset
    // to `''` would silently clear any display those components ever set.
    document.body.classList.toggle('no-project', empty);

    if (!empty) {
      this.hidden = true;
      this._rendered = false;
      this.innerHTML = '';
      return;
    }

    this.hidden = false;

    if (!this._rendered) {
      this._rendered = true;
      this._render();
      void this._loadRecents();
      void this._awaitProviders();
    }
  }

  /** @private */
  _render() {
    // Drag-and-drop of a folder needs the native host to read the dropped
    // path — the page is never told one. Offering it in a browser tab or on a
    // remote client would be advertising something that silently does nothing,
    // and on a remote client the folder is on the wrong machine entirely.
    const canDropFolders = hasNativeHost();

    this.innerHTML = `
      <section class="onboarding-panel" aria-label="Welcome to Juggler">
        <div class="onboarding-logo" role="img" aria-label="Juggler"></div>
        <h1 class="np-heading">Welcome to Juggler</h1>
        <p class="np-lead">
          Juggler is an AI coding agent designed around transparency, control, and fast iteration.
          It works inside one project folder at a time.
        </p>

        <div class="np-actions">
          <button type="button" class="np-action np-action--primary np-open">Open an existing folder…</button>
          <button type="button" class="np-action np-new">Create a new folder to work in…</button>
        </div>

        ${canDropFolders ? '<p class="np-drop-hint">Or drag a folder onto this window.</p>' : ''}

        <div class="np-recents" hidden></div>

        <p class="np-explainer">
          A project folder is just a folder on your computer — a codebase, or an empty
          folder to start something in. Juggler works inside it and nowhere else.
        </p>

        <div class="np-provider" aria-live="polite"></div>

        <p class="np-footnote">
          Once a project is open, ask Juggler about itself — it explains its own tools and
          features. Or browse the
          <button type="button" class="onboarding-link np-shortcuts">keyboard shortcuts</button>.
        </p>
      </section>
    `;

    this._on('.np-open', async () => {
      const { openProjectPicker } = await import('./project-picker.js');
      openProjectPicker(this._session?.projectPath || '', this._session);
    });

    this._on('.np-new', async () => {
      const { openNewProjectPanel } = await import('./project-picker.js');
      openNewProjectPanel(this._recents);
    });

    this._on('.np-shortcuts', () => openSettings('shortcuts'));

    this._renderProviderStatus();
  }

  /**
   * Bind a click handler to one element inside the panel, if it is there.
   * @param {string} selector
   * @param {() => void|Promise<void>} handler
   * @returns {void}
   * @private
   */
  _on(selector, handler) {
    const el = this.querySelector(selector);
    if (el) el.addEventListener('click', () => void handler());
  }

  /**
   * Load the recents list and, if there is one, show it and drop the
   * first-launch explanation — someone with recents has been here before.
   * @returns {Promise<void>}
   * @private
   */
  async _loadRecents() {
    /** @type {string[]} */
    let paths = [];
    try {
      const resp = await apiService.getRecents();
      paths = (resp && resp.paths) || [];
    } catch (err) {
      console.warn('[no-project-overlay] failed to load recents:', err);
    }
    this._recents = paths;
    if (!this._rendered) return;

    const host = /** @type {HTMLElement|null} */ (this.querySelector('.np-recents'));
    if (!host) return;

    const shown = paths.slice(0, RECENTS_SHOWN);
    if (shown.length === 0) return;

    host.innerHTML = '';
    const label = document.createElement('div');
    label.className = 'np-recents-label';
    label.textContent = 'Recent';
    host.appendChild(label);

    for (const path of shown) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'np-recent';
      btn.textContent = path;
      btn.title = path;
      btn.addEventListener('click', () => void this._open(path));
      host.appendChild(btn);
    }
    host.removeAttribute('hidden');

    this._setReturning();
  }

  /**
   * Trim the panel to what a returning user needs: they know what a project
   * folder is, and their list is the thing they came back for. The welcome
   * heading goes too, with nothing in its place — an empty window already says
   * no project is open.
   * @returns {void}
   * @private
   */
  _setReturning() {
    this.querySelector('.np-heading')?.setAttribute('hidden', '');
    this.querySelector('.np-lead')?.setAttribute('hidden', '');
    this.querySelector('.np-explainer')?.setAttribute('hidden', '');
  }

  /**
   * Wait for a settled provider snapshot before drawing the status line.
   *
   * `waitForReady`, never `waitForFirst`: the connect seed is pre-compute, and
   * a line drawn from it says "no provider connected" to someone who has three.
   * @returns {Promise<void>}
   * @private
   */
  async _awaitProviders() {
    try {
      await providersCache.waitForReady();
    } catch {
      return;
    }
    this._renderProviderStatus();
  }

  /**
   * Draw the provider line from whatever the cache holds now. Silent until the
   * first settled snapshot arrives, so the panel never flashes a wrong verdict.
   * @returns {void}
   * @private
   */
  _renderProviderStatus() {
    const host = /** @type {HTMLElement|null} */ (this.querySelector('.np-provider'));
    if (!host) return;

    if (!providersCache.hasReceived()) {
      host.innerHTML = '';
      return;
    }

    const names = providersCache.get()
      .filter((p) => p.available && (p.modelsWithContext?.length ?? 0) > 0)
      .map((p) => p.displayName);

    host.innerHTML = '';
    const dot = document.createElement('span');
    dot.className = 'np-provider-dot';
    host.appendChild(dot);

    const text = document.createElement('span');
    text.className = 'np-provider-text';

    if (names.length === 0) {
      host.classList.add('np-provider--none');
      text.textContent = 'No AI provider connected. Juggler needs one before it can answer.';
      host.appendChild(text);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'onboarding-link np-connect';
      btn.textContent = 'Connect one';
      btn.addEventListener('click', () => openSettings('providers'));
      host.appendChild(btn);
      return;
    }

    host.classList.remove('np-provider--none');
    const named = names.slice(0, PROVIDERS_NAMED).join(', ');
    const rest = names.length - PROVIDERS_NAMED;
    text.textContent = rest > 0 ? `Connected: ${named} and ${rest} more` : `Connected: ${named}`;
    host.appendChild(text);
  }

  /**
   * Open a folder as the project. Switching from the empty state abandons
   * nothing, so this needs none of the picker's busy-conversation warning.
   * @param {string} path
   * @returns {Promise<void>}
   * @private
   */
  async _open(path) {
    try {
      await openProjectInWindow(path, () => apiService.openProject(path));
      // The server broadcasts `project-changed`; the session listener reloads.
    } catch (err) {
      await showAlert(extractUserMessage(err), 'Open project');
    }
  }
}

customElements.define('no-project-overlay', NoProjectOverlay);
export default NoProjectOverlay;
