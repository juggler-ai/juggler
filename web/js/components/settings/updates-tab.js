//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   https://juggler.studio
//
//   This program is free software: you can redistribute it and/or modify it under the terms of
//   the GNU Affero General Public License as published by the Free Software Foundation, either
//   version 3 of the License, or (at your option) any later version. This program is distributed
//   in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
//   warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the LICENSE file or
//   <https://www.gnu.org/licenses/agpl-3.0.html> for full terms.

import { getUpdaterState, startCheck } from '../../services/updater-control.js';
import * as settingsApi from '../../services/settings-api.js';
import { errorText } from '../../../sdk/lib/error-utils.js';
import { t, markForTranslation } from '../../../sdk/lib/i18n.js';

/**
 * The three update modes, matching core.UpdateMode* on the server. Labels and
 * descriptions are English source text, translated where the radios are built.
 * @type {Array<{value: string, label: string, description: string}>}
 */
const MODES = [
  {
    value: 'automatic',
    label: markForTranslation('Automatic'),
    description: markForTranslation('Check periodically and download updates in the background.'),
  },
  {
    value: 'notify',
    label: markForTranslation('Notify only'),
    description: markForTranslation('Check periodically and show an Update button, but never download automatically.'),
  },
  {
    value: 'off',
    label: markForTranslation('Off'),
    description: markForTranslation('Never check automatically. You can still check manually below.'),
  },
];

/**
 * Updates tab: shows version info, lets the user pick an update mode
 * (Automatic / Notify only / Off, backed by GET/PUT /api/settings), and offers a
 * manual "Check for updates" button (POST /api/update-status/check, plus the
 * in-app updater's check-only op when present). It fetches its own data in
 * show(); it does not use the shell's shared loadConfig payload.
 */
export class UpdatesTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope).
   */
  constructor(host) {
    /** @type {HTMLElement} @private */
    this.host = host;
    /** @type {string} @private — the mode last persisted/loaded, for revert on error. */
    this._mode = 'automatic';
    /** @type {boolean} @private — whether an in-app updater is present. */
    this._updaterPresent = false;
    /**
     * @type {string} @private — the package manager that installs this build's
     * updates (the server's update-status `managedBy`), or '' when it updates itself.
     */
    this._managedBy = '';
  }

  /** Build the static tab DOM and wire persistent listeners. */
  render() {
    const container = this.host.querySelector('#updates-form');
    if (!container) return;
    container.innerHTML = '';

    // ── Version info ────────────────────────────────────────────────────
    const versionBlock = document.createElement('div');
    versionBlock.className = 'settings-group provider-field updates-version-row';
    const versionInfo = document.createElement('div');
    versionInfo.className = 'provider-info';
    const versionName = document.createElement('div');
    versionName.className = 'provider-name';
    versionName.textContent = t('Version');
    const versionDesc = document.createElement('div');
    versionDesc.className = 'provider-description';
    versionDesc.id = 'updates-version-info';
    versionDesc.textContent = t('Loading…');
    versionInfo.appendChild(versionName);
    versionInfo.appendChild(versionDesc);
    versionBlock.appendChild(versionInfo);
    container.appendChild(versionBlock);

    // ── Update mode radios ──────────────────────────────────────────────
    const modeHeading = document.createElement('div');
    modeHeading.className = 'settings-section-heading caps-label-lg';
    modeHeading.textContent = t('When updates are available');
    container.appendChild(modeHeading);

    const modeGroup = document.createElement('div');
    modeGroup.className = 'settings-form updates-mode-group';
    modeGroup.setAttribute('role', 'radiogroup');
    modeGroup.setAttribute('aria-label', t('Update mode'));
    for (const mode of MODES) {
      const row = document.createElement('label');
      row.className = 'settings-group provider-field updates-mode-row';
      row.dataset.mode = mode.value;

      const info = document.createElement('div');
      info.className = 'provider-info';
      const name = document.createElement('div');
      name.className = 'provider-name';
      name.textContent = t(mode.label);
      const desc = document.createElement('div');
      desc.className = 'provider-description';
      desc.textContent = t(mode.description);
      info.appendChild(name);
      info.appendChild(desc);

      const ctrl = document.createElement('div');
      ctrl.className = 'provider-control';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'updates-mode';
      input.className = 'updates-mode-radio';
      input.value = mode.value;
      input.addEventListener('change', () => {
        if (input.checked) void this._setMode(mode.value);
      });
      ctrl.appendChild(input);

      row.appendChild(info);
      row.appendChild(ctrl);
      modeGroup.appendChild(row);
    }
    container.appendChild(modeGroup);

    // ── Manual check ────────────────────────────────────────────────────
    const actions = document.createElement('div');
    actions.className = 'settings-group provider-field updates-check-row';
    const actionInfo = document.createElement('div');
    actionInfo.className = 'provider-info';
    const status = document.createElement('div');
    status.className = 'provider-description';
    status.id = 'updates-check-status';
    status.textContent = '';
    actionInfo.appendChild(status);

    const actionCtrl = document.createElement('div');
    actionCtrl.className = 'provider-control';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'updates-check-btn';
    btn.className = 'btn btn-sm btn-primary';
    btn.textContent = t('Check for updates');
    btn.addEventListener('click', () => void this._checkNow());
    actionCtrl.appendChild(btn);

    actions.appendChild(actionInfo);
    actions.appendChild(actionCtrl);
    container.appendChild(actions);
  }

  /**
   * Tab became visible: fetch the version info. The update mode is not read here
   * — the panel hands the settings document to every tab, so the radios are
   * already showing it.
   */
  show() {
    void this._loadVersion();
  }

  /**
   * Element disconnected: nothing to release. Its listeners are on the radios
   * and button it drew into `#updates-form`, which go with the panel; it arms
   * no timer and subscribes to nothing — the settings document reaches it
   * through onSettingsChanged(), and a check in flight only writes into that
   * same DOM when it lands.
   */
  dispose() {}

  /**
   * Fetch version info from /api/update-status (and the in-app updater snapshot,
   * when present) and render it into the version line.
   * @private
   */
  async _loadVersion() {
    // Offline — show what little we have.
    /** @type {any} */
    const status = await settingsApi.getUpdateStatus({ fallback: {} });
    const updater = await getUpdaterState();
    this._updaterPresent = !!updater.present;
    this._applyManaged(status);
    this._renderVersion(status, updater);
  }

  /**
   * Fit the mode choices to who installs updates. A package manager's install
   * never downloads its own, so "Automatic" is not offered and a saved
   * "automatic" reads as the notify choice it behaves as; "Off" still stops the
   * scheduled checks.
   * @private
   * @param {any} status - An /api/update-status result.
   */
  _applyManaged(status) {
    const managedBy = typeof status.managedBy === 'string' ? status.managedBy : '';
    this._managedBy = managedBy;
    for (const mode of MODES) {
      const row = /** @type {HTMLElement|null} */ (
        this.host.querySelector(`.updates-mode-row[data-mode="${mode.value}"]`));
      if (!row) continue;
      if (mode.value === 'automatic') row.hidden = !!managedBy;
      if (mode.value !== 'notify') continue;
      const name = row.querySelector('.provider-name');
      const desc = row.querySelector('.provider-description');
      if (name) name.textContent = managedBy ? t('Tell me about new versions') : t(mode.label);
      if (desc) {
        desc.textContent = managedBy
          ? t('Check periodically and say when a new version is out. Install it through {packageManager}.',
            { packageManager: managedBy })
          : t(mode.description);
      }
    }
    this._reflectMode(this._mode);
  }

  /**
   * The sentence for an available update: where to get it, when that is not here.
   * @private
   * @param {string} version
   * @returns {string} The translated sentence.
   */
  _availableText(version) {
    return this._managedBy
      ? t('Version {version} is available — update it through {packageManager}.',
        { version, packageManager: this._managedBy })
      : t('Version {version} is available.', { version });
  }

  /**
   * @private
   * @param {any} status - The /api/update-status result.
   * @param {import('../../services/updater-control.js').UpdaterState} updater
   */
  _renderVersion(status, updater) {
    const el = this.host.querySelector('#updates-version-info');
    if (!el) return;
    const current = status.currentVersion || (updater && updater.appVersion) || t('unknown');
    const latest = status.latestVersion || '';
    // Whole sentences, each one message, joined with a space.
    const parts = [t('Current version {version}.', { version: current })];
    if (status.updateAvailable && latest) {
      parts.push(this._availableText(latest));
    } else if (status.unpublished) {
      // No comparison was made, and latest is usually newer than this build —
      // so it is reported as what it is, never as the version being run.
      parts.push(latest
        ? t('Latest release is {version}; a build from source is never offered updates.', { version: latest })
        : t('A build from source is never offered updates.'));
    } else if (latest) {
      parts.push(t('This is the latest version ({version}).', { version: latest }));
    } else {
      parts.push(t('No update information yet.'));
    }
    // App-bundle / server skew: an in-app updater whose bundle version differs
    // from the viewed server (a server started outside the app), mirroring
    // update-notice.js's _hasServerSkew. Updating the app won't touch that server.
    if (updater && updater.present && updater.appVersion && status.currentVersion
      && updater.appVersion !== status.currentVersion) {
      parts.push(t('The app bundle is v{appVersion}, but this server is {serverVersion}; '
        + 'updating the app won\'t update a server started outside it.',
      { appVersion: updater.appVersion, serverVersion: status.currentVersion }));
    }
    el.textContent = parts.join(' ');
  }

  /**
   * The settings document changed, here or in another window. The radios are one
   * focusable group, so they are left alone while the user is inside it — writing
   * `.checked` across them mid-arrow-key would move the selection under them, and
   * the choice they are making is the one that should win.
   * @param {any} settings - The whole settings document.
   */
  onSettingsChanged(settings) {
    const mode = (settings.updates && settings.updates.mode) || 'automatic';
    this._mode = mode;
    // activeElement rather than a `:focus` match: `:focus` only matches while the
    // DOCUMENT itself has focus, so it reports nothing in a window sitting behind
    // another — or under a test runner — and the guard would quietly never hold.
    const radios = Array.from(this.host.querySelectorAll('.updates-mode-radio'));
    if (radios.some((radio) => radio === document.activeElement)) return;
    this._reflectMode(mode);
  }

  /**
   * Reflect a mode value onto the radios.
   * @private
   * @param {string} mode
   */
  _reflectMode(mode) {
    // "Automatic" is hidden on a managed install, where it behaves as notify.
    const shown = this._managedBy && mode === 'automatic' ? 'notify' : mode;
    const radios = this.host.querySelectorAll('.updates-mode-radio');
    radios.forEach((r) => {
      const input = /** @type {HTMLInputElement} */ (r);
      input.checked = input.value === shown;
    });
  }

  /**
   * Persist a new mode via PUT /api/settings, reverting the radios on failure.
   * @private
   * @param {string} mode
   */
  async _setMode(mode) {
    const prev = this._mode;
    this._mode = mode;
    try {
      const data = await settingsApi.updateSettings({ updates: { mode } });
      const saved = (data && data.updates && data.updates.mode) || mode;
      this._mode = saved;
      this._reflectMode(saved);
    } catch (err) {
      // Revert the UI to the last-known-good mode.
      this._mode = prev;
      this._reflectMode(prev);
      this._setStatus(t('Couldn\'t save the update setting ({error}).', { error: errorText(err) }));
    }
  }

  /**
   * Run a manual check: POST /api/update-status/check (server notice) plus — when
   * an in-app updater is present — its check-only op (reveal availability without
   * downloading). Surfaces the result inline; opens the update dialog when an
   * update is found.
   * @private
   */
  async _checkNow() {
    const btn = /** @type {HTMLButtonElement|null} */ (this.host.querySelector('#updates-check-btn'));
    if (btn) btn.disabled = true;
    this._setStatus(t('Checking…'));
    try {
      // Kick the in-app updater's check-only probe first (fire-and-forget; the
      // result arrives via the pushed snapshot the header button consumes).
      if (this._updaterPresent && !this._managedBy) void startCheck();

      const status = await settingsApi.checkForUpdate();
      if (!status.error) this._applyManaged(status);
      if (status.error) {
        this._setStatus(t('Couldn’t reach the update server. Try again later.'));
      } else if (status.updateAvailable) {
        this._setStatus(this._availableText(status.latestVersion || ''));
        // Surface the full dialog (with download/install affordances) — unless
        // the update is the package manager's to install, which the line says.
        if (!this._managedBy) window.dispatchEvent(new CustomEvent('juggler:open-update-dialog'));
      } else if (status.unpublished) {
        this._setStatus(status.latestVersion
          ? t('Latest release is {version}; a build from source is never offered updates.', { version: status.latestVersion })
          : t('A build from source is never offered updates.'));
      } else {
        this._setStatus(t('You’re on the latest version.'));
      }
      const updater = await getUpdaterState();
      this._renderVersion(status, updater);
    } catch (err) {
      this._setStatus(t('Check failed ({error}).', { error: errorText(err) }));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /**
   * @private
   * @param {string} text
   */
  _setStatus(text) {
    const el = this.host.querySelector('#updates-check-status');
    if (el) el.textContent = text;
  }
}
