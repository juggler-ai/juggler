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

import { errorText } from '../../../sdk/lib/error-utils.js';
import { updateSettings } from '../../services/settings-api.js';
import { t, markForTranslation } from '../../../sdk/lib/i18n.js';

/**
 * The three proxy modes, matching core.ProxyMode* (and httpx.Mode*) on the
 * server. The hint describes the selected mode inline under the picker. Labels
 * and hints are English source text, translated where they are shown.
 * @type {Array<{value: string, label: string, hint: string}>}
 */
const MODES = [
  {
    value: 'system',
    label: markForTranslation('System (recommended)'),
    hint: markForTranslation('Uses the proxy environment variables and the operating-system proxy, falling back to a direct connection when none is set.'),
  },
  {
    value: 'none',
    label: markForTranslation('Direct (no proxy)'),
    hint: markForTranslation('Always connects directly, ignoring any environment or system proxy.'),
  },
  {
    value: 'manual',
    label: markForTranslation('Manual'),
    hint: markForTranslation('Routes through the proxy URL below.'),
  },
];

/**
 * Whether raw is a usable proxy URL: parseable with a host. Mirrors the
 * server-side acceptance (internal/httpx + the PUT validator) so the UI rejects
 * what the backend would reject.
 * @param {string} raw
 * @returns {boolean} True when raw parses as a URL with a host.
 */
function isValidProxyURL(raw) {
  const s = (raw || '').trim();
  if (!s) return false;
  try {
    return !!new URL(s).hostname;
  } catch {
    return false;
  }
}

/**
 * The outbound-proxy box that sits at the bottom of the Connectivity tab: a
 * single provider-field with a 3-way mode picker — System (env + OS proxy) /
 * Direct / Manual — backed by GET/PUT /api/settings under `network.proxy`.
 * Picking Manual reveals a URL field; that mode is persisted only once a valid
 * URL is present.
 *
 * It renders into its own `#proxy-form` container (a sibling of the Connectivity
 * form) so the Connectivity tab's 2 s poll — which rebuilds `#connectivity-form`
 * — never wipes the proxy controls or steals focus from the URL field. The
 * owning Connectivity tab forwards render()/load() to it.
 */
export class ProxySettings {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope).
   */
  constructor(host) {
    /** @type {HTMLElement} @private */
    this.host = host;
    /** @type {string} @private — mode last persisted/loaded, for revert on error. */
    this._mode = 'system';
    /** @type {string} @private — proxy URL last persisted/loaded. */
    this._url = '';
  }

  /** Build the static box DOM and wire persistent listeners. */
  render() {
    const container = this.host.querySelector('#proxy-form');
    if (!container) return;
    container.innerHTML = '';

    const box = document.createElement('div');
    box.className = 'settings-group provider-field';

    // ── Info column ─────────────────────────────────────────────────────
    const info = document.createElement('div');
    info.className = 'provider-info';
    const name = document.createElement('div');
    name.className = 'provider-name';
    name.textContent = t('Outbound proxy');
    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.textContent = t('Route Juggler\'s outbound connections through a proxy. Local addresses (localhost / 127.0.0.1) always bypass it.');
    info.appendChild(name);
    info.appendChild(desc);

    // ── Control column ──────────────────────────────────────────────────
    const ctrl = document.createElement('div');
    ctrl.className = 'provider-control';

    const select = document.createElement('select');
    select.id = 'proxy-mode';
    select.className = 'proxy-mode-select field-input';
    select.setAttribute('aria-label', t('Proxy mode'));
    for (const mode of MODES) {
      const opt = document.createElement('option');
      opt.value = mode.value;
      opt.textContent = t(mode.label);
      select.appendChild(opt);
    }
    select.addEventListener('change', () => void this._onModeChange(select.value));
    ctrl.appendChild(select);

    // Inline hint describing the currently-selected mode.
    const hint = document.createElement('div');
    hint.className = 'provider-description proxy-mode-hint';
    hint.id = 'proxy-mode-hint';
    ctrl.appendChild(hint);

    // ── Manual proxy URL (shown only while Manual is selected) ───────────
    const urlRow = document.createElement('div');
    urlRow.className = 'proxy-url-row';
    urlRow.id = 'proxy-url-row';
    urlRow.hidden = true;

    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.id = 'proxy-url';
    urlInput.className = 'proxy-url-input field-input field-input-sm';
    urlInput.placeholder = t('http://host:port or socks5://host:port');
    urlInput.autocomplete = 'off';
    urlInput.spellcheck = false;
    // Commit on Enter or blur so a partially-typed URL isn't validated per key.
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void this._commitURL(); }
    });
    urlInput.addEventListener('blur', () => void this._commitURL());

    const status = document.createElement('div');
    status.className = 'provider-description proxy-status';
    status.id = 'proxy-status';

    urlRow.appendChild(urlInput);
    urlRow.appendChild(status);
    ctrl.appendChild(urlRow);

    box.appendChild(info);
    box.appendChild(ctrl);
    container.appendChild(box);
  }

  /**
   * Element disconnected: nothing to release. Every listener this box takes is
   * on a control it drew into `#proxy-form`, which goes with the panel, and it
   * arms no timer and subscribes to nothing outside it — the settings document
   * reaches it through the owning tab's onSettingsChanged().
   */
  dispose() {}

  /**
   * The settings document arrived — from the panel's fetch, or because it changed
   * here or in another window. Adopt the proxy section and show it, unless the
   * user is in the middle of one of these two controls: the URL field commits on
   * blur and Enter, so writing to it mid-edit would take a half-typed URL away,
   * and the picker is left alone for as long as it is the thing being used. The
   * cached values are updated either way, so the next reflect — a reopen, or a
   * failed write reverting — uses the truth.
   * @param {any} settings - The whole settings document.
   */
  onSettingsChanged(settings) {
    const proxy = (settings.network && settings.network.proxy) || {};
    this._mode = proxy.mode || 'system';
    this._url = proxy.url || '';
    const active = document.activeElement;
    if (active === this.host.querySelector('#proxy-mode')
      || active === this.host.querySelector('#proxy-url')) return;
    this._reflect();
  }

  /**
   * Reflect the current mode/URL onto the picker and URL field.
   * @private
   */
  _reflect() {
    const select = /** @type {HTMLSelectElement|null} */ (this.host.querySelector('#proxy-mode'));
    if (select) select.value = this._mode;
    const urlInput = /** @type {HTMLInputElement|null} */ (this.host.querySelector('#proxy-url'));
    if (urlInput) urlInput.value = this._url;
    this._setStatus('');
    this._syncModeUI();
  }

  /**
   * Show the URL row and mode hint for the currently-selected mode. Driven by
   * the picker's live value (not the persisted mode) so choosing Manual reveals
   * the field even before a valid URL is committed.
   * @private
   */
  _syncModeUI() {
    const selected = this._selectedMode();
    const urlRow = /** @type {HTMLElement|null} */ (this.host.querySelector('#proxy-url-row'));
    if (urlRow) urlRow.hidden = selected !== 'manual';
    const hint = this.host.querySelector('#proxy-mode-hint');
    const mode = MODES.find((m) => m.value === selected);
    if (hint) hint.textContent = mode ? t(mode.hint) : '';
  }

  /**
   * Handle a mode change. System/Direct persist immediately; Manual only
   * persists once a valid URL is present, revealing and focusing the field.
   * @private
   * @param {string} mode
   */
  async _onModeChange(mode) {
    this._syncModeUI();
    const urlInput = /** @type {HTMLInputElement|null} */ (this.host.querySelector('#proxy-url'));
    if (mode === 'manual') {
      const url = urlInput ? urlInput.value : this._url;
      if (!isValidProxyURL(url)) {
        this._setStatus(t('Enter a proxy URL, e.g. http://127.0.0.1:7890'));
        urlInput?.focus();
        return;
      }
      await this._save('manual', url.trim());
      return;
    }
    // Preserve the typed URL so switching back to Manual keeps it.
    await this._save(mode, this._url);
  }

  /**
   * The mode currently selected on the picker, which can differ from the
   * persisted mode: picking Manual with no valid URL yet leaves the picker on
   * manual without persisting. Falls back to the persisted mode before render.
   * @private
   * @returns {string} The picker's value, or the persisted mode.
   */
  _selectedMode() {
    const select = /** @type {HTMLSelectElement|null} */ (this.host.querySelector('#proxy-mode'));
    return select ? select.value : this._mode;
  }

  /**
   * Commit the URL field (Enter/blur). Only meaningful while Manual is the
   * selected mode — gated on the selection, not the persisted mode, since Manual
   * stays selected but unpersisted until a valid URL is entered. An invalid
   * value surfaces an inline error and is not persisted.
   * @private
   */
  async _commitURL() {
    if (this._selectedMode() !== 'manual') return;
    const urlInput = /** @type {HTMLInputElement|null} */ (this.host.querySelector('#proxy-url'));
    const url = urlInput ? urlInput.value.trim() : '';
    if (url === this._url && this._mode === 'manual') return; // already persisted
    if (!isValidProxyURL(url)) {
      this._setStatus(t('That proxy URL looks invalid — include a scheme, e.g. http://host:port'));
      return;
    }
    await this._save('manual', url);
  }

  /**
   * Persist mode+url via PUT /api/settings, reverting the UI on failure.
   * @private
   * @param {string} mode
   * @param {string} url
   */
  async _save(mode, url) {
    const prevMode = this._mode;
    const prevURL = this._url;
    this._mode = mode;
    this._url = url;
    try {
      const data = await updateSettings({ network: { proxy: { mode, url } } });
      const proxy = (data && data.network && data.network.proxy) || {};
      this._mode = proxy.mode || mode;
      this._url = proxy.url || '';
      this._reflect();
    } catch (err) {
      this._mode = prevMode;
      this._url = prevURL;
      this._reflect();
      this._setStatus(t('Couldn\'t save the proxy setting ({error}).', { error: errorText(err) }));
    }
  }

  /**
   * @private
   * @param {string} text
   */
  _setStatus(text) {
    const el = this.host.querySelector('#proxy-status');
    if (el) el.textContent = text;
  }
}
