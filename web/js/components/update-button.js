//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import wsService from '../services/websocket.js';
import { getUpdaterState, startInstall } from '../services/updater-control.js';
import { fetchJson, bodyServerMessage } from '../services/http.js';
import JugglerElement from './juggler-element.js';
import { apiUrl } from '../utils/api-url.js';
import { t, serverText } from '../../sdk/lib/i18n.js';
import { escapeHtml } from '../../sdk/lib/html.js';

/**
 * <update-button> — the single header affordance for updates. It merges the two
 * independent update sources into one pill:
 *
 *   1. The server-side version notice (`/api/update-status` + WS `update-status`)
 *      — present in every build, tells us an update exists and carries the
 *      notice content (title/html/actions) and latest version.
 *   2. The in-app auto-updater (macOS official builds only), reached over the
 *      loopback control endpoint (seed via op=state, live via the pushed
 *      `juggler:updater-status` event) — tells us downloading/verifying/ready
 *      state, progress, and the restart action.
 *
 * The button is hidden until one of the sources says an update matters, styles
 * itself to the live state (Update → Downloading… n% → Restart to update), and
 * on click opens the shared <update-notice> dialog with the merged view-model.
 * It never auto-opens the dialog — the only non-click opener is the app's
 * "Check for Updates…" menu, which fires `juggler:open-update-dialog`.
 *
 * In a browser tab, a free build, or a non-macOS build there is no updater, so
 * the button degrades to the server notice alone and never shows progress.
 */

/** Updater states in which the button should be visible. */
const VISIBLE_STATES = new Set(['available', 'downloading', 'verifying', 'installing', 'ready', 'error']);

class UpdateButton extends JugglerElement {
  constructor() {
    super();
    /** @type {any} @private — latest server update-status */
    this._server = null;
    /** @type {any} @private — latest updater snapshot */
    this._updater = { present: false };
    /** @type {boolean} @private — this window's server is app-spawned (skew calc) */
    this._appManagedServer = true;
    /** @type {boolean} @private — was the pill visible on the last render */
    this._wasVisible = false;
    /** @type {boolean} @private — proactively kicked the updater once already */
    this._autoKicked = false;
    /** @type {number} @private — pending rAF handle for throttled renders */
    this._raf = 0;
    /** @type {HTMLButtonElement} @private — the pill (set in connectedCallback) */
    this._btn = /** @type {HTMLButtonElement} */ (/** @type {unknown} */ (null));
    /** @type {HTMLElement} @private — the pill label span */
    this._labelEl = /** @type {HTMLElement} */ (/** @type {unknown} */ (null));
    /** @type {HTMLElement} @private — the fixed-width download-percent span */
    this._pctEl = /** @type {HTMLElement} */ (/** @type {unknown} */ (null));
  }

  connectedCallback() {
    this.innerHTML = `
      <button type="button" class="update-btn" title="${escapeHtml(t('Update available'))}">
        <span class="update-btn__label">${escapeHtml(t('Update'))}</span>
        <span class="update-btn__pct" aria-hidden="true"></span>
        <span class="update-btn__dot" aria-hidden="true"></span>
      </button>`;
    this._btn = /** @type {HTMLButtonElement} */ (this.querySelector('.update-btn'));
    this._labelEl = /** @type {HTMLElement} */ (this.querySelector('.update-btn__label'));
    this._pctEl = /** @type {HTMLElement} */ (this.querySelector('.update-btn__pct'));
    this.on(this._btn, 'click', () => this._openDialog());

    // Source 1 — server version notice. Seed now and re-seed on every (re)connect.
    this._onWS('update-status', (data) => { this._server = data; this._scheduleRender(); });
    this._onWS('open', () => { void this._seedServer(); void this._seedUpdater(); });
    void this._seedServer();

    // Source 2 — in-app updater. Seed over the control endpoint, then track the
    // pushed snapshots. The app also asks us to open the dialog from its menu.
    void this._seedUpdater();
    this.onWindow('juggler:updater-status', (e) => {
      const detail = /** @type {CustomEvent} */ (e).detail;
      if (detail && typeof detail === 'object') { this._updater = detail; this._scheduleRender(); }
    });
    this.onWindow('juggler:open-update-dialog', () => this._openDialog(true));

    this._scheduleRender();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  /**
   * @private
   * @param {string} type
   * @param {(data: any) => void} cb
   */
  _onWS(type, cb) {
    wsService.on(/** @type {any} */ (type), cb);
    this.addCleanup(() => wsService.off?.(/** @type {any} */ (type), cb));
  }

  /** @private */
  async _seedServer() {
    // Offline — the WS push will seed us when it connects.
    const status = await fetchJson(apiUrl('/update-status'), { fallback: null });
    if (!status) return;
    this._server = status;
    this._scheduleRender();
  }

  /** @private */
  async _seedUpdater() {
    const state = await getUpdaterState();
    this._updater = state;
    if (typeof state.appManagedServer === 'boolean') this._appManagedServer = state.appManagedServer;
    this._scheduleRender();
  }

  /**
   * Fold both sources into the view-model the dialog and label share.
   * @private
   * @param {object} [extra] - Overrides merged onto the model (e.g. upToDate).
   * @returns {import('./update-notice.js').UpdateViewModel} The merged model.
   */
  _viewModel(extra = {}) {
    const s = this._server || {};
    // A package manager installs this build's updates, so an in-app updater
    // that is somehow running is set aside: nothing here may download.
    const managedBy = typeof s.managedBy === 'string' ? s.managedBy : '';
    const u = (!managedBy && this._updater) || { present: false };
    const present = !!u.present;
    const updaterState = present ? (u.state || null) : null;
    const total = Number(u.total) || 0;
    const written = Number(u.written) || 0;
    const pct = present && updaterState === 'downloading' && total > 0
      ? (written / total) * 100
      : null;
    const targetVersion = (present && u.version) ? u.version : (s.latestVersion || '');
    const notice = (s.updateAvailable && s.notice && s.notice.id) ? s.notice : null;
    return /** @type {any} */ ({
      present,
      updaterState,
      pct,
      // The failure in the viewer's language when the app sent it as a message,
      // else the app's English.
      error: serverText(bodyServerMessage({ message: u.errorMessage }), u.error) || null,
      errorStage: u.errorStage || null,
      currentVersion: s.currentVersion || '',
      targetVersion,
      appVersion: u.appVersion || null,
      appManagedServer: this._appManagedServer,
      notice,
      serverUpdateAvailable: !!s.updateAvailable,
      managedBy,
      upToDate: false,
      ...extra,
    });
  }

  /**
   * Whether the merged model warrants showing the button (or a non-up-to-date
   * dialog).
   * @private
   * @param {import('./update-notice.js').UpdateViewModel} vm
   * @returns {boolean} True when an update is worth surfacing.
   */
  _isRelevant(vm) {
    return vm.serverUpdateAvailable || VISIBLE_STATES.has(vm.updaterState || '');
  }

  /**
   * @private
   * @param {import('./update-notice.js').UpdateViewModel} vm
   * @returns {string} The pill's label text for the current state. The download
   *   percentage is rendered separately (see {@link _pctText}) so its changing
   *   digit-count can't reflow the pill.
   */
  _label(vm) {
    if (vm.present) {
      if (vm.updaterState === 'downloading') return t('Downloading update…');
      if (vm.updaterState === 'verifying' || vm.updaterState === 'installing') return t('Preparing update…');
      if (vm.updaterState === 'ready') return t('Update & restart...');
    }
    return t('Update');
  }

  /**
   * The download percentage shown in its own fixed-width span, or '' when there
   * is no determinate percentage to show.
   * @private
   * @param {import('./update-notice.js').UpdateViewModel} vm
   * @returns {string} e.g. '42%', or '' when not downloading / indeterminate.
   */
  _pctText(vm) {
    return vm.present && vm.updaterState === 'downloading' && vm.pct !== null
      ? `${Math.round(vm.pct)}%`
      : '';
  }

  /**
   * Throttle renders to one per frame — progress pushes can arrive ~10/s.
   * @private
   */
  _scheduleRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }

  /**
   * When the server version notice reports an update and this build has an
   * in-app updater still sitting idle (it hasn't run its first post-launch check
   * yet), nudge it to check + download now rather than waiting out its warmup
   * poll (~30s). One-shot per page. This only changes *when* the flow starts —
   * the app already auto-downloads a found update — so it's latency, not policy.
   * No-op in browser / free / non-macOS builds (no updater present) and once the
   * updater has moved past its initial idle state.
   *
   * Marked `auto` because nobody clicked for it: if the update server is
   * unreachable the failure belongs in the log, not in the header.
   * @private
   * @param {import('./update-notice.js').UpdateViewModel} vm
   */
  _maybeAutoKick(vm) {
    if (this._autoKicked) return;
    if (!vm.present || !vm.serverUpdateAvailable) return;
    const st = vm.updaterState || '';
    if (st !== '' && st !== 'idle') return;
    this._autoKicked = true;
    void startInstall({ auto: true });
  }

  /** Draw the element as its state stands. Repeatable. */
  render() {
    const vm = this._viewModel();
    this._maybeAutoKick(vm);
    const visible = this._isRelevant(vm);
    this.hidden = !visible;

    if (visible) {
      this._labelEl.textContent = this._label(vm);
      this._pctEl.textContent = this._pctText(vm);
      const st = vm.updaterState;
      this._btn.classList.toggle('update-btn--ready', vm.present && st === 'ready');
      this._btn.classList.toggle('update-btn--progress',
        vm.present && (st === 'downloading' || st === 'verifying' || st === 'installing'));
      this._btn.classList.toggle('update-btn--error', vm.present && st === 'error');
      // Tint the pill background to download progress when we have a percentage.
      this._btn.style.setProperty('--update-pct', vm.pct === null ? '0%' : `${Math.round(vm.pct)}%`);
      this._btn.title = st === 'ready' ? t('Install the downloaded update and reopen')
        : st === 'error' ? (vm.error || t('Update failed — click for details'))
          : t('Update available');

      // One-shot attention pulse the first time the pill appears.
      if (!this._wasVisible) {
        this._btn.classList.add('update-btn--attention');
        const clear = () => this._btn.classList.remove('update-btn--attention');
        this._btn.addEventListener('animationend', clear, { once: true });
      }
    }
    this._wasVisible = visible;

    // Keep an open dialog in step with the live state. Use the same up-to-date
    // decision as the opener: a bare view-model never carries `upToDate`, so
    // refreshing with one would strip a menu-opened "You're up to date" dialog
    // back into a spurious "…is available" the moment any snapshot arrives.
    const dialog = this._dialog();
    if (dialog && dialog.isOpen()) dialog.refresh(this._dialogVm());
  }

  /**
   * The view-model to hand the dialog: the merged model, plus the explicit
   * up-to-date state when nothing is worth offering (and the updater isn't in an
   * error we'd rather surface). Shared by the "Check for Updates…" opener and the
   * live refresh so a refresh can't strip the up-to-date flag off an open dialog.
   * @private
   * @returns {import('./update-notice.js').UpdateViewModel} The dialog model.
   */
  _dialogVm() {
    const vm = this._viewModel();
    if (!this._isRelevant(vm) && (!vm.present || vm.updaterState !== 'error')) {
      return this._viewModel({ upToDate: true });
    }
    return vm;
  }

  /**
   * @private
   * @returns {any} the singleton <update-notice> dialog, or null.
   */
  _dialog() {
    return document.querySelector('update-notice');
  }

  /**
   * Open the shared dialog with the current merged model.
   * @private
   * @param {boolean} [fromMenu] - True when opened via "Check for Updates…":
   *   show an explicit up-to-date state when there's nothing to offer.
   */
  _openDialog(fromMenu = false) {
    const dialog = this._dialog();
    if (!dialog) return;
    // From the menu, show an explicit up-to-date state when there's nothing to
    // offer; from a header-button click the button was only visible because
    // something is relevant, so the bare model already renders that.
    dialog.open(fromMenu ? this._dialogVm() : this._viewModel());
  }
}

customElements.define('update-button', UpdateButton);
