//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import JugglerElement from './juggler-element.js';
import { openExternalURL } from '../../sdk/lib/window-control.js';
import { createButton } from '../../sdk/lib/html.js';
import { markPopupOpen } from '../utils/popup-manager.js';
import { fadeOutScrims } from '../utils/modal-scrim.js';
import { markDialog, trapFocus } from '../utils/dialog-a11y.js';
import { startInstall, requestRestart } from '../services/updater-control.js';
import { showConfirm } from './modal-dialog.js';
import { t, markForTranslation } from '../../sdk/lib/i18n.js';

/**
 * @typedef {object} UpdateAction
 * @property {string} label - Button text.
 * @property {string} url - External URL the button opens.
 * @property {boolean} [primary] - Whether to style this as the primary action.
 */

/**
 * @typedef {object} UpdateNoticeData
 * @property {string} id - Stable notice identifier (keys the in-page dismiss).
 * @property {string} [severity] - "info" | "recommended" | "required".
 * @property {string} [title] - Heading text; a generic default is used if absent.
 * @property {string} [html] - Optional body HTML; a default is generated if absent.
 * @property {UpdateAction[]} [actions] - Buttons to render.
 */

/**
 * The merged view-model the header <update-button> computes and hands to open().
 * It folds the two update sources — the server version notice and the in-app
 * updater — into one shape the dialog renders directly.
 * @typedef {object} UpdateViewModel
 * @property {boolean} present - Whether this build has an in-app updater.
 * @property {string|null} updaterState - idle | checking | up-to-date |
 *   available | downloading | verifying | installing | ready | error, or null.
 * @property {number|null} pct - Download percent (0–100), or null when unknown.
 * @property {string|null} error - Updater error text, when updaterState==='error'.
 * @property {string|null} [errorStage] - Which phase produced `error`: check |
 *   download | verify | install | restart. Decides the plain-English lead.
 * @property {string} [currentVersion] - The viewed server's version.
 * @property {string} [targetVersion] - The version being offered.
 * @property {string|null} [appVersion] - This app bundle's version.
 * @property {boolean} appManagedServer - Whether the app spawned this server.
 * @property {UpdateNoticeData|null} notice - Server-authored notice, if any.
 * @property {boolean} serverUpdateAvailable - Server says a newer version exists.
 * @property {string} [managedBy] - The package manager that installs this
 *   build's updates, or empty when it updates itself. When set the dialog
 *   points there and offers nothing to download or install.
 * @property {boolean} [upToDate] - Menu "Check for Updates" found nothing new.
 */

/** @type {number} */
const TEXT_NODE = 3;
/** @type {number} */
const ELEMENT_NODE = 1;

/** Generic heading used when the manifest doesn't author its own title. */
const DEFAULT_TITLE = markForTranslation('New Juggler Version Available');

/**
 * Plain-English lead for a failure, keyed by the stage that produced it. The
 * stage matters: a check that couldn't reach the server never began an update,
 * so reporting it as a failed update would simply be untrue. Whichever lead
 * applies, the underlying error text is shown beneath it, never replaced by it.
 * @type {Record<string, string>}
 */
const ERROR_LEADS = {
  check: markForTranslation('Couldn’t check for updates.'),
  download: markForTranslation('Couldn’t download the update.'),
  verify: markForTranslation('Couldn’t verify the downloaded update.'),
  install: markForTranslation('Couldn’t install the update.'),
  restart: markForTranslation('Couldn’t restart to finish the update.'),
};

/** Lead used when the failure arrived without a recognised stage. */
const ERROR_LEAD_DEFAULT = markForTranslation('Couldn’t complete the update.');

/**
 * Tags allowed in a server-authored notice body, each mapped to the attributes
 * it may keep. Everything else is unwrapped to its text content; all other
 * attributes (and event handlers) are stripped. The notice HTML comes from our
 * own HTTPS domain but is still treated as untrusted data.
 * @type {Record<string, string[]>}
 */
const ALLOWED_TAGS = {
  A: ['href'],
  P: [],
  BR: [],
  STRONG: [],
  B: [],
  EM: [],
  I: [],
  UL: [],
  OL: [],
  LI: [],
  CODE: [],
  SPAN: [],
};

/**
 * Recursively rebuild a node's children keeping only allowlisted elements and
 * attributes. Disallowed elements are unwrapped (their cleaned children survive
 * as text/markup); comments and other node types are dropped.
 * @param {Node} node - Parent whose children are cleaned.
 * @returns {Node[]} The cleaned, allowlisted child nodes.
 */
function cleanChildren(node) {
  /** @type {Node[]} */
  const out = [];
  node.childNodes.forEach((child) => {
    if (child.nodeType === TEXT_NODE) {
      out.push(document.createTextNode(child.textContent || ''));
      return;
    }
    if (child.nodeType !== ELEMENT_NODE) return;
    const el = /** @type {HTMLElement} */ (child);
    const allowed = ALLOWED_TAGS[el.tagName];
    if (!allowed) {
      out.push(...cleanChildren(el));
      return;
    }
    const safe = document.createElement(el.tagName.toLowerCase());
    allowed.forEach((name) => {
      const v = el.getAttribute(name);
      if (v !== null) safe.setAttribute(name, v);
    });
    if (el.tagName === 'A') {
      const href = safe.getAttribute('href') || '';
      if (!/^https?:\/\//i.test(href)) {
        safe.removeAttribute('href');
      } else {
        safe.setAttribute('rel', 'noopener noreferrer');
      }
    }
    cleanChildren(el).forEach((n) => safe.appendChild(n));
    out.push(safe);
  });
  return out;
}

/**
 * @param {string} html - Untrusted notice body HTML.
 * @returns {DocumentFragment} A fragment containing only allowlisted markup.
 */
function sanitizeHTML(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html || '');
  const frag = document.createDocumentFragment();
  cleanChildren(tpl.content).forEach((n) => frag.appendChild(n));
  return frag;
}

/** Updater states in which a download/stage flow is under way. */
const FLOW_STATES = new Set(['downloading', 'verifying', 'installing', 'ready']);

/**
 * States that mean a page-triggered install has produced a real reaction — the
 * flow has started, finished, or errored, or a Check came back up-to-date. While
 * an optimistic install is pending (see {@link UpdateNotice#_doInstall}) every
 * other state is masked so the dialog holds its in-flight shape; seeing one of
 * these hands control back to the live snapshot. 'available' is deliberately
 * absent — it's the pre-download state a Check leaves behind, and masking it
 * avoids a flicker back to "Update now" between the Check completing and the
 * download starting.
 */
const REACTION_STATES = new Set(['downloading', 'verifying', 'installing', 'ready', 'error', 'up-to-date']);

/**
 * UpdateNotice — the update dialog. It does not decide *when* to show: the
 * header <update-button> owns visibility and opens this imperatively via
 * `open(viewModel)`, passing a merged view-model of both update sources (the
 * server version notice and, when present, the in-app auto-updater). While the
 * dialog is open the button calls `refresh(viewModel)` on every state/progress
 * change so the progress bar and action buttons track the live flow.
 *
 * Rendered as a standard centered app popup (same chrome as about-modal: a
 * modal-backdrop + modal-panel, Escape/backdrop to dismiss). A `required`
 * notice omits the dismissal affordances (no backdrop/Escape close, no Later).
 * Closing only hides it for this page session — the button stays in the header.
 */
class UpdateNotice extends JugglerElement {
  constructor() {
    super();
    /** @type {UpdateViewModel|null} @private — the model currently rendered */
    this._vm = null;
    /** @type {string|null} @private — identity of the current render shape */
    this._renderKey = null;
    /** @type {(() => void)|null} @private */
    this._releasePopupOpen = null;
    /** @type {(() => void)|null} @private — releases the Tab trap while open */
    this._releaseTrap = null;
    /** @type {boolean} @private — a restart is being requested */
    this._restarting = false;
    /** @type {boolean} @private — install requested; show in-flight shape optimistically until a real snapshot reacts */
    this._pendingInstall = false;
  }

  connectedCallback() {
    this.classList.add('modal-shell');
    // An open dialog keeps what it drew across a move, so it takes back the
    // Escape/Back registration the disconnect gave up.
    if (this.isOpen() && !this._releasePopupOpen) {
      this._registerDismissal(this._effectiveVm(/** @type {UpdateViewModel} */ (this._vm)));
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._teardownDismissal();
  }

  /** @returns {boolean} Whether the dialog is currently shown. */
  isOpen() {
    return this._vm !== null;
  }

  /**
   * Open (or re-open) the dialog with the given merged view-model.
   * @param {UpdateViewModel} vm
   */
  open(vm) {
    this._vm = vm;
    const ev = this._effectiveVm(vm);
    this.render(ev);
    this._registerDismissal(ev);
  }

  /**
   * Register the open dialog with popup-manager, replacing any registration it
   * already holds. Dismissible dialogs close via Escape and the browser/mobile
   * Back button (routed through popup-manager); a required notice registers no
   * close handler, so neither gesture can dismiss it. Either way the open
   * dialog holds Tab.
   * @private
   * @param {UpdateViewModel} vm
   */
  _registerDismissal(vm) {
    this._teardownDismissal();
    this._releasePopupOpen = markPopupOpen(this._dismissible(vm) ? () => this._dismiss() : undefined);
    this._releaseTrap = trapFocus(this);
  }

  /**
   * Update the open dialog to a new view-model. A change in render shape (state,
   * capability, notice id) rebuilds the DOM; a pure progress change patches the
   * progress region in place so the bar animates smoothly.
   * @param {UpdateViewModel} vm
   */
  refresh(vm) {
    if (!this.isOpen()) return;
    this._vm = vm;
    // A real reaction to our optimistic install has arrived — stop masking and
    // let the live snapshot drive the dialog again.
    if (this._pendingInstall && vm.present && REACTION_STATES.has(vm.updaterState || '')) {
      this._pendingInstall = false;
    }
    const ev = this._effectiveVm(vm);
    if (this._renderKey !== this._computeRenderKey(ev)) {
      this.render(ev);
      return;
    }
    this._patchProgress(ev);
  }

  /**
   * Fold the optimistic "install requested" state onto a view-model. The moment
   * the user clicks Update now / Retry we want the dialog to show the in-flight
   * shape (disabled primary, indeterminate progress): the real snapshot can be a
   * round-trip away — a Check during the launch warmup, then the download start —
   * and without this the primary button sits unchanged and reads as a dead click.
   * The optimism is dropped in {@link refresh} as soon as a real reaction state
   * arrives.
   * @private
   * @param {UpdateViewModel} vm
   * @returns {UpdateViewModel} vm unchanged, or an in-flight-shaped override.
   */
  _effectiveVm(vm) {
    if (!this._pendingInstall || !vm.present) return vm;
    return { ...vm, updaterState: 'downloading', pct: null };
  }

  /** Close the dialog for this page session (button stays in the header). */
  close() {
    this._dismiss();
  }

  /**
   * @private
   * @param {UpdateViewModel} vm
   * @returns {boolean} True when the dialog may be dismissed.
   */
  _dismissible(vm) {
    // A managed install can only be updated outside the app, so even a required
    // notice must let the user go and do that.
    if (vm.managedBy) return true;
    return !(vm.notice && vm.notice.severity === 'required');
  }

  /**
   * A stable identity for the current render shape. Progress numbers are
   * deliberately excluded so a progress tick patches rather than rebuilds.
   * @private
   * @param {UpdateViewModel} vm
   * @returns {string} An identity string for the render shape.
   */
  _computeRenderKey(vm) {
    return [
      vm.upToDate ? 'uptodate' : '',
      vm.present ? 'present' : 'absent',
      vm.updaterState || '',
      // The failure itself is part of the shape: the status region is built from
      // the stage and the message, so a change in either has to rebuild.
      vm.errorStage || '',
      vm.error || '',
      vm.appManagedServer ? 'managed' : 'external',
      vm.serverUpdateAvailable ? 'server' : '',
      vm.managedBy || '',
      vm.notice ? vm.notice.id : '',
      vm.notice ? vm.notice.severity : '',
    ].join('|');
  }

  /**
   * Build the full dialog DOM for vm.
   * @param {UpdateViewModel} vm
   */
  render(vm) {
    this._renderKey = this._computeRenderKey(vm);
    const dismissible = this._dismissible(vm);
    const severity = vm.notice && vm.notice.severity === 'required'
      ? 'required'
      : vm.notice && vm.notice.severity === 'info' ? 'info' : 'recommended';

    const panel = document.createElement('modal-panel');
    panel.className = `update-notice__panel update-notice--${severity}`;

    const heading = document.createElement('header');
    heading.className = 'update-notice__title';
    heading.textContent = this._title(vm);
    panel.appendChild(heading);
    markDialog(panel, heading);

    panel.appendChild(this._buildBody(vm));

    const status = this._buildStatus(vm);
    if (status) panel.appendChild(status);

    panel.appendChild(this._buildFooter(vm, dismissible));

    const backdrop = document.createElement('modal-backdrop');
    backdrop.className = 'update-notice__backdrop';
    if (dismissible) backdrop.addEventListener('click', () => this._dismiss());

    this.innerHTML = '';
    this.appendChild(backdrop);
    this.appendChild(panel);
  }

  /**
   * @private
   * @param {UpdateViewModel} vm
   * @returns {string} The dialog heading text.
   */
  _title(vm) {
    if (vm.upToDate) return t("You're up to date");
    if (vm.notice && vm.notice.title) return vm.notice.title;
    if (vm.targetVersion) return t('Version {version} is available', { version: vm.targetVersion });
    return t(DEFAULT_TITLE);
  }

  /**
   * @private
   * @param {UpdateViewModel} vm
   * @returns {HTMLElement} The dialog body element.
   */
  _buildBody(vm) {
    const body = document.createElement('div');
    body.className = 'update-notice__body';

    if (vm.upToDate) {
      const p = document.createElement('p');
      p.textContent = vm.currentVersion
        ? t("You're on the latest version ({version}).", { version: vm.currentVersion })
        : t("You're on the latest version.");
      body.appendChild(p);
      return body;
    }

    // The manifest's prose is written for a build that downloads its own
    // updates, so a managed install gets the plain line and its package manager.
    if (vm.notice && vm.notice.html && !vm.managedBy) {
      body.appendChild(sanitizeHTML(vm.notice.html));
    } else {
      const p = document.createElement('p');
      p.textContent = vm.targetVersion
        ? t('Version {version} is now available.', { version: vm.targetVersion })
        : t('A newer version is now available.');
      body.appendChild(p);
    }

    if (vm.managedBy) {
      const managed = document.createElement('p');
      managed.className = 'update-notice__managed';
      managed.textContent = t('Juggler is updated through {packageManager}. Update it there to get this version.',
        { packageManager: vm.managedBy });
      body.appendChild(managed);
    }

    // Edge case 18: the viewed server was started outside the app, so an app
    // update won't touch it. Say so plainly instead of implying "Restart
    // updates your session".
    if (this._hasServerSkew(vm)) {
      const warn = document.createElement('p');
      warn.className = 'update-notice__skew';
      warn.textContent = t("You're connected to a Juggler server started outside the app ({version}). Updating the app won't update that server — restart it to update.",
        { version: vm.currentVersion });
      body.appendChild(warn);
    }
    return body;
  }

  /**
   * Whether the viewed server is external and lags the app bundle version.
   * @private
   * @param {UpdateViewModel} vm
   * @returns {boolean} True when the external server lags the app bundle.
   */
  _hasServerSkew(vm) {
    return !!(vm.present && !vm.appManagedServer && vm.appVersion
      && vm.currentVersion && vm.appVersion !== vm.currentVersion);
  }

  /**
   * Build the live status/progress region, or null when the updater isn't in a
   * flow (nothing to report beyond the body).
   * @private
   * @param {UpdateViewModel} vm
   * @returns {HTMLElement|null} The status region, or null when not in a flow.
   */
  _buildStatus(vm) {
    if (vm.upToDate) return null;
    if (!vm.present) return null;
    if (vm.updaterState === 'error') {
      const region = document.createElement('div');
      region.className = 'update-notice__status update-notice__status--error';
      const text = document.createElement('p');
      text.className = 'update-notice__status-text';
      text.textContent = t(ERROR_LEADS[vm.errorStage || ''] || ERROR_LEAD_DEFAULT);
      region.appendChild(text);
      if (vm.error) {
        const detail = document.createElement('p');
        detail.className = 'update-notice__status-detail';
        detail.textContent = vm.error;
        region.appendChild(detail);
      }
      return region;
    }
    if (!FLOW_STATES.has(vm.updaterState || '')) return null;

    const region = document.createElement('div');
    region.className = 'update-notice__status';

    const bar = document.createElement('div');
    bar.className = 'update-notice__progress';
    const fill = document.createElement('div');
    fill.className = 'update-notice__progress-fill';
    bar.appendChild(fill);
    region.appendChild(bar);

    const text = document.createElement('p');
    text.className = 'update-notice__status-text';
    region.appendChild(text);

    this._applyProgress(region, vm);
    return region;
  }

  /**
   * Patch the progress region's bar + text in place (no rebuild). Confined to
   * the flow states: the error region reuses the same status-text class, and
   * patching it would replace the failure with progress copy.
   * @private
   * @param {UpdateViewModel} vm
   */
  _patchProgress(vm) {
    if (!FLOW_STATES.has(vm.updaterState || '')) return;
    const region = this.querySelector('.update-notice__status');
    if (region) this._applyProgress(/** @type {HTMLElement} */ (region), vm);
  }

  /**
   * @private
   * @param {HTMLElement} region
   * @param {UpdateViewModel} vm
   */
  _applyProgress(region, vm) {
    const fill = /** @type {HTMLElement|null} */ (region.querySelector('.update-notice__progress-fill'));
    const text = region.querySelector('.update-notice__status-text');
    const bar = region.querySelector('.update-notice__progress');
    const indeterminate = vm.updaterState !== 'downloading' || vm.pct === null;
    if (bar) bar.classList.toggle('update-notice__progress--indeterminate', indeterminate);
    if (fill) fill.style.width = indeterminate ? '' : `${Math.max(0, Math.min(100, vm.pct || 0))}%`;
    if (text) {
      if (vm.updaterState === 'ready') {
        text.textContent = t('Update downloaded.');
      } else if (vm.updaterState === 'downloading') {
        text.textContent = vm.pct === null
          ? t('Downloading update…')
          : t('Downloading update… {pct}%', { pct: Math.round(vm.pct) });
      } else {
        text.textContent = t('Preparing update…');
      }
    }
  }

  /**
   * Build the capability-driven footer.
   * @private
   * @param {UpdateViewModel} vm
   * @param {boolean} dismissible
   * @returns {HTMLElement} The footer element with capability-driven buttons.
   */
  _buildFooter(vm, dismissible) {
    const footer = document.createElement('footer');
    footer.className = 'update-notice__footer';

    // A managed install is updated elsewhere: nothing to download or open here.
    if (vm.upToDate || vm.managedBy) {
      footer.appendChild(this._button(t('OK'), 'btn-primary', () => this._dismiss()));
      return footer;
    }

    // "Later" first (left), so the primary action stays rightmost.
    if (dismissible) {
      footer.appendChild(this._button(t('Later'), '', () => this._dismiss()));
    }

    if (!vm.present) {
      // No in-app updater — offer the manifest's external download links.
      /** @type {UpdateAction[]} */ (vm.notice && vm.notice.actions || []).forEach((action) => {
        if (!action || !action.url) return;
        footer.appendChild(
          this._button(action.label || t('Open'), action.primary ? 'btn-primary' : '', () => openExternalURL(action.url)),
        );
      });
      return footer;
    }

    switch (vm.updaterState) {
      case 'ready':
        footer.appendChild(this._button(t('Update & restart'), 'btn-primary', () => this._doRestart()));
        break;
      case 'downloading':
      case 'verifying':
      case 'installing': {
        // In-flight — show a disabled primary so the shape is stable.
        const b = this._button(t('Updating…'), 'btn-primary', () => {});
        b.disabled = true;
        footer.appendChild(b);
        break;
      }
      case 'error':
        // Fall back to a manifest download link, if any, then offer Retry.
        /** @type {UpdateAction[]} */ (vm.notice && vm.notice.actions || []).forEach((action) => {
          if (!action || !action.url) return;
          footer.appendChild(this._button(action.label || t('Open'), '', () => openExternalURL(action.url)));
        });
        footer.appendChild(this._button(t('Retry'), 'btn-primary', () => this._doInstall()));
        break;
      default:
        // available / idle / checking / up-to-date-with-server-notice.
        footer.appendChild(this._button(t('Update now'), 'btn-primary', () => this._doInstall()));
    }
    return footer;
  }

  /**
   * @private
   * @param {string} label
   * @param {string} extraClass
   * @param {() => void} onClick
   * @returns {HTMLButtonElement} The constructed footer button.
   */
  _button(label, extraClass, onClick) {
    return createButton(
      label,
      'update-notice__button' + (extraClass ? ' ' + extraClass : ''),
      onClick,
    );
  }

  /**
   * Trigger (or retry) the background download.
   * @private
   */
  _doInstall() {
    // Flip to the in-flight shape now; the real snapshot (which may be a Check
    // round-trip away during the launch warmup) reconciles this in refresh().
    // Without it the click has no visible effect and reads as dead.
    this._pendingInstall = true;
    if (this._vm) this.render(this._effectiveVm(this._vm));
    void startInstall();
  }

  /**
   * Request a restart, handling the busy-confirm round-trip.
   * @private
   */
  async _doRestart() {
    if (this._restarting) return;
    this._restarting = true;
    try {
      let res = await requestRestart({ force: false });
      if (res.status === 'busy') {
        const proceed = await showConfirm(
          res.message || t('A conversation is still working. Restarting will stop and discard it.'),
          t('Restart to update?'),
          { confirmText: t('Restart anyway'), cancelText: t('Keep working'), danger: true },
        );
        if (!proceed) return;
        res = await requestRestart({ force: true });
      }
      if (res.status === 'error' && this._vm) {
        // Surface the failure in the status region without closing the dialog.
        this._vm = {
          ...this._vm,
          updaterState: 'error',
          error: res.message || null,
          errorStage: 'restart',
        };
        this.render(this._vm);
      }
      // status 'ok' quits the app; nothing more to do.
    } finally {
      this._restarting = false;
    }
  }

  /**
   * Hide the dialog for this page session. The header button remains, so the
   * user can reopen it; a `required` notice never routes here.
   * @private
   */
  _dismiss() {
    this._vm = null;
    this._renderKey = null;
    this._pendingInstall = false;
    fadeOutScrims(this);
    this.innerHTML = '';
    this._teardownDismissal();
  }

  /** @private */
  _teardownDismissal() {
    if (this._releasePopupOpen) {
      this._releasePopupOpen();
      this._releasePopupOpen = null;
    }
    this._releaseTrap?.();
    this._releaseTrap = null;
  }
}

customElements.define('update-notice', UpdateNotice);
