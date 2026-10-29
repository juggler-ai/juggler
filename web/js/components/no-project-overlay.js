//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <no-project-overlay> — full-area placeholder shown when no project is
 * loaded. It is the first thing a new user sees, so it carries the ways into a
 * project (open an existing folder, create a new one, drop one on the window,
 * or — in the desktop app — connect to a server on another computer), the recents a returning user actually came back for, and a live statement of
 * whether an AI provider is connected — the one prerequisite that otherwise
 * fails silently at the first message.
 *
 * It is also what a stand-in window shows: a desktop window that cannot show
 * what it is for — a server by URL that does not answer, a locked project — is
 * an empty window's page, opened with `?standIn=` (see services/stand-in.js).
 * The panel then says what the app tells it, with a way to try again and a way
 * out to an ordinary empty window, in place of the welcome. The window keeps its
 * header, its chrome and its folder drop, so it is a window like any other.
 *
 * What it shows is derived from live state and nothing else: no first-run flag
 * is persisted. A window with no provider and no recents is someone's first
 * launch and gets the explanation; a window with recents is someone who just
 * closed a project and gets their list, not a lecture.
 */

import JugglerElement from './juggler-element.js';
import apiService from '../services/api.js';
import wsService from '../services/websocket.js';
import providersCache from '../services/providers-cache.js';
import { openSettings } from '../services/settings-launcher.js';
import { extractUserMessage } from '../../sdk/lib/error-utils.js';
import { t, htmlSlots, withHtml, formatList, serverText } from '../../sdk/lib/i18n.js';
import { escapeHtml } from '../../sdk/lib/html.js';
import { hasNativeHost, reportFolderDropped } from '../../sdk/lib/window-control.js';
import { showAlert } from './modal-dialog.js';
import { openProjectInWindow } from './project-opening.js';
import { canConnectToServer, openConnectServerPanel } from './connect-server-panel.js';
import defaultStandInClient from '../services/stand-in.js';

/** How many recent folders the panel offers before it stops being a shortlist. */
const RECENTS_SHOWN = 5;

/** How many providers are named before the rest become a count. */
const PROVIDERS_NAMED = 2;

/**
 * What a stand-in says under its buttons when "Try again" did not work.
 * @param {string} kind - The stand-in's kind: 'unreachable' | 'locked' | 'failed'
 * @returns {string} The status line, translated
 */
function standInStillStatus(kind) {
  if (kind === 'locked') return t('The project is still locked.');
  if (kind === 'failed') return t('The server still could not be started.');
  return t("The server still isn't answering.");
}

class NoProjectOverlay extends JugglerElement {
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
    /** @type {Record<string, Function>|null} @private */
    this._nativeDragHooks = null;
    /**
     * How this window learns whether it is a stand-in, and acts on it. Replaced
     * by a test with one of its own.
     * @type {import('../services/stand-in.js').StandInClient}
     */
    this.standInClient = defaultStandInClient;
    /**
     * What this window stands in for while it is a stand-in, else null.
     * @type {import('../services/stand-in.js').StandIn|null} @private
     */
    this._standIn = null;
    /** @type {boolean} @private */
    this._retrying = false;
  }

  connectedCallback() {
    // The cache has no change event of its own, so the live feed it is built
    // from is what a status line subscribes to (same idiom as model-selector).
    this.addCleanup(wsService.on('providers-update', () => this._renderProviderStatus()));

    // A folder dropped on an empty window. The native host reads the path off
    // the drag pasteboard and announces it here, because the page is never told
    // one: WebKit withholds the filesystem path from every file drag.
    this.onWindow('juggler:folder-dropped', (/** @type {any} */ e) => {
      const path = e?.detail?.path;
      if (typeof path === 'string' && path) void this._open(path);
    });

    this._installNativeDragHooks();
    this.addCleanup(() => this._removeNativeDragHooks());

    // Put back with the session it already has, which nobody hands it again:
    // take back the feed the disconnect dropped, and catch up on what it missed.
    if (this._session && !this._unsubscribe) {
      this._listen();
      this._refresh();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    // Re-assignable (setSession drops and re-takes it), so a field rather than
    // an addCleanup registration.
    this._stopListening();
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
    this._stopListening();
    this._session = session;
    this._refresh();
    if (this.isConnected) this._listen();
  }

  /** @private */
  _stopListening() {
    this._unsubscribe?.();
    this._unsubscribe = null;
  }

  /**
   * Follow the events that can open or close the project. A no-op without a
   * session or while already listening.
   * @private
   */
  _listen() {
    const session = this._session;
    if (!session || this._unsubscribe) return;
    this._unsubscribe = session.subscribe((/** @type {{type: string}} */ event) => {
      if (
        event.type === 'session:loaded'
        || event.type === 'conversation:created'
        || event.type === 'conversation:deleted'
      ) {
        this._refresh();
      }
    });
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
      // A project opened in a stand-in is the window it is now (the app hears
      // the same from the title report), so it is no longer one.
      this.hidden = true;
      this._rendered = false;
      this._standIn = null;
      this.innerHTML = '';
      return;
    }

    this.hidden = false;

    if (!this._rendered) {
      this._rendered = true;
      if (this.standInClient.requested()) {
        // Nothing is drawn until the app says what the window stands in for:
        // a welcome flashed first would offer a beginner's tour to someone
        // whose server has just gone away.
        void this._askStandIn();
      } else {
        this._showWelcome();
      }
    }
  }

  /**
   * Draw the welcome, and fetch what fills it in.
   * @returns {void}
   * @private
   */
  _showWelcome() {
    this._standIn = null;
    this.render();
    void this._loadRecents();
    void this._awaitProviders();
  }

  /**
   * Ask the app what this window stands in for, and draw that — or the welcome,
   * when it no longer stands in for anything (a page reloaded after leaving).
   * @returns {Promise<void>}
   * @private
   */
  async _askStandIn() {
    const standIn = await this.standInClient.get();
    // A project arrived meanwhile, and the overlay is gone.
    if (!this._rendered) return;
    if (!standIn.kind) {
      this._showWelcome();
      return;
    }
    this._standIn = standIn;
    this.render();
  }

  /** Draw the element as its state stands. Repeatable. */
  render() {
    if (this._standIn) {
      this._renderStandIn(this._standIn);
      return;
    }
    // Drag-and-drop of a folder needs the native host to read the dropped
    // path — the page is never told one. Offering it in a browser tab or on a
    // remote client would be advertising something that silently does nothing,
    // and on a remote client the folder is on the wrong machine entirely.
    const canDropFolders = hasNativeHost();
    // A project can also live on another computer's server — again a window
    // only the desktop app can open (see connect-server-panel.js).
    const canConnect = canConnectToServer();
    const product = 'Juggler'; // i18n-ignore: the product name, which the logo spells out
    const welcomeHtml = escapeHtml(t('Welcome to Juggler'));
    const footnoteMarkup = {
      shortcuts: `<button type="button" class="onboarding-link np-shortcuts">${escapeHtml(t('keyboard shortcuts'))}</button>`,
    };

    this.innerHTML = `
      <section class="onboarding-panel" aria-label="${welcomeHtml}">
        <div class="onboarding-logo" role="img" aria-label="${escapeHtml(product)}"></div>
        <h1 class="np-heading">${welcomeHtml}</h1>
        <p class="np-lead">${escapeHtml(t('Juggler is an AI coding agent designed around transparency, control, and fast iteration. It works inside one project folder at a time.'))}</p>

        <div class="np-actions">
          <button type="button" class="np-action btn-primary np-open">${escapeHtml(t('Open an existing folder…'))}</button>
          <button type="button" class="np-action np-new">${escapeHtml(t('Create a new folder to work in…'))}</button>
          ${canConnect ? `<button type="button" class="np-action np-connect-server">${escapeHtml(t('Connect to a server URL…'))}</button>` : ''}
        </div>

        ${canDropFolders ? `<p class="np-drop-hint">${escapeHtml(t('Or drag a folder onto this window.'))}</p>` : ''}

        <div class="np-recents" hidden></div>

        <p class="np-explainer">${escapeHtml(t('A project folder is just a folder on your computer — a codebase, or an empty folder to start something in. Juggler works inside it and nowhere else.'))}</p>

        <div class="np-provider" aria-live="polite"></div>

        <p class="np-footnote">${withHtml(t('Once a project is open, ask Juggler about itself — it explains its own tools and features. Or browse the {shortcuts}.', htmlSlots(footnoteMarkup)), footnoteMarkup)}</p>
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

    this._on('.np-connect-server', () => openConnectServerPanel());

    this._on('.np-shortcuts', () => openSettings('shortcuts'));

    this._renderProviderStatus();
  }

  /**
   * Draw what a stand-in says: the app's heading and explanation, and the two
   * ways out of it.
   * @param {import('../services/stand-in.js').StandIn} standIn - What the window stands in for
   * @returns {void}
   * @private
   */
  _renderStandIn(standIn) {
    const product = 'Juggler'; // i18n-ignore: the product name, which the logo spells out
    const title = serverText(standIn.title);
    this.innerHTML = `
      <section class="onboarding-panel" data-stand-in="${escapeHtml(standIn.kind)}" aria-label="${escapeHtml(title)}">
        <div class="onboarding-logo" role="img" aria-label="${escapeHtml(product)}"></div>
        <h1 class="np-heading">${escapeHtml(title)}</h1>
        <div class="np-stand-in-message"></div>
        <div class="np-actions">
          <button type="button" class="np-action btn-primary np-stand-in-retry">${escapeHtml(t('Try again'))}</button>
          <button type="button" class="np-action np-stand-in-leave">${escapeHtml(t('Open a local window instead'))}</button>
        </div>
        <p class="np-stand-in-status" aria-live="polite" hidden></p>
      </section>
    `;

    this._drawStandInMessage(standIn);

    this._on('.np-stand-in-retry', () => this._retryStandIn());
    this._on('.np-stand-in-leave', () => this._leaveStandIn());
  }

  /**
   * Fill the stand-in's explanation, replacing whatever it said before.
   * Paragraphs break at blank lines and lines at single breaks, as the app wrote
   * them: a locked project's lock file is on a line of its own.
   * @param {import('../services/stand-in.js').StandIn} standIn - What the window stands in for
   * @returns {void}
   * @private
   */
  _drawStandInMessage(standIn) {
    const host = /** @type {HTMLElement|null} */ (this.querySelector('.np-stand-in-message'));
    if (!host) return;
    host.replaceChildren();
    for (const message of standIn.message || []) {
      for (const paragraph of serverText(message).split(/\n\s*\n/)) {
        const p = document.createElement('p');
        p.className = 'np-stand-in-detail';
        paragraph.split('\n').forEach((line, i) => {
          if (i > 0) p.appendChild(document.createElement('br'));
          p.appendChild(document.createTextNode(line));
        });
        host.appendChild(p);
      }
    }
  }

  /**
   * "Try again". The app opens the real window in this one's place if it can be
   * shown now, so the button stays down when it can; when it still cannot, the
   * panel says so and the button comes back.
   * @returns {Promise<void>}
   * @private
   */
  async _retryStandIn() {
    const button = /** @type {HTMLButtonElement|null} */ (this.querySelector('.np-stand-in-retry'));
    const status = /** @type {HTMLElement|null} */ (this.querySelector('.np-stand-in-status'));
    if (!button || this._retrying) return;
    this._retrying = true;
    button.disabled = true;
    button.textContent = t('Trying…');
    if (status) status.hidden = true;

    let opened = false;
    try {
      opened = await this.standInClient.retry();
    } finally {
      this._retrying = false;
    }
    if (opened) return;
    button.disabled = false;
    button.textContent = t('Try again');
    if (status) {
      status.textContent = standInStillStatus(this._standIn?.kind || '');
      status.hidden = false;
    }

    // The app brought its explanation up to date with the attempt (a lock that
    // changed hands, a server failing for a new reason). Only the explanation is
    // redrawn: the buttons and the status line stay the elements they are, so
    // focus stays on "Try again".
    const now = await this.standInClient.get();
    // A project arrived meanwhile, or the window stopped standing in.
    if (!this._rendered || !this._standIn || !now.kind) return;
    this._standIn = now;
    this._drawStandInMessage(now);
  }

  /**
   * "Open a local window instead": the window becomes the ordinary empty window
   * its page already is, where it stands.
   * @returns {Promise<void>}
   * @private
   */
  async _leaveStandIn() {
    if (!(await this.standInClient.leave())) return;
    if (this._rendered) this._showWelcome();
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
    label.textContent = t('Recent');
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

    const names = providersCache.getChat()
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
      text.textContent = t('No AI provider connected. Juggler needs one before it can answer.');
      host.appendChild(text);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'onboarding-link np-connect';
      btn.textContent = t('Connect one');
      btn.addEventListener('click', () => openSettings('providers'));
      host.appendChild(btn);
      return;
    }

    host.classList.remove('np-provider--none');
    const named = formatList(names.slice(0, PROVIDERS_NAMED));
    const rest = names.length - PROVIDERS_NAMED;
    text.textContent = rest > 0
      ? t('Connected: {named} and {rest, plural, other {# more}}', { named, rest })
      : t('Connected: {named}', { named });
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
      await showAlert(extractUserMessage(err), t('Open project'));
    }
  }
}

customElements.define('no-project-overlay', NoProjectOverlay);
