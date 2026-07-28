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

import { extractErrorMessage } from '../../../sdk/lib/error-utils.js';

/**
 * The three proxy modes, matching core.ProxyMode* (and httpx.Mode*) on the
 * server.
 * @type {Array<{value: string, label: string, description: string}>}
 */
const MODES = [
  {
    value: 'system',
    label: 'System (recommended)',
    description: 'Use the proxy environment variables and the operating-system proxy. Falls back to a direct connection when none is set.',
  },
  {
    value: 'none',
    label: 'Direct (no proxy)',
    description: 'Always connect directly, ignoring any environment or system proxy.',
  },
  {
    value: 'manual',
    label: 'Manual',
    description: 'Route through a proxy you specify below.',
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
 * Network tab: picks how Juggler's outbound HTTP reaches the network — System
 * (env + OS proxy) / Direct / Manual — backed by GET/PUT /api/settings under
 * `network.proxy`. Manual reveals a URL field; the mode is persisted only once a
 * valid URL is present. It fetches its own data in show() rather than using the
 * shell's shared loadConfig payload.
 */
export class NetworkTab {
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

  /** Build the static tab DOM and wire persistent listeners. */
  render() {
    const container = this.host.querySelector('#network-form');
    if (!container) return;
    container.innerHTML = '';

    // ── Mode radios ─────────────────────────────────────────────────────
    const modeGroup = document.createElement('div');
    modeGroup.className = 'settings-form network-mode-group';
    modeGroup.setAttribute('role', 'radiogroup');
    modeGroup.setAttribute('aria-label', 'Proxy mode');
    for (const mode of MODES) {
      const row = document.createElement('label');
      row.className = 'settings-group provider-field network-mode-row';

      const info = document.createElement('div');
      info.className = 'provider-info';
      const name = document.createElement('div');
      name.className = 'provider-name';
      name.textContent = mode.label;
      const desc = document.createElement('div');
      desc.className = 'provider-description';
      desc.textContent = mode.description;
      info.appendChild(name);
      info.appendChild(desc);

      const ctrl = document.createElement('div');
      ctrl.className = 'provider-control';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'network-proxy-mode';
      input.className = 'network-mode-radio';
      input.value = mode.value;
      input.addEventListener('change', () => {
        if (input.checked) void this._onModeChange(mode.value);
      });
      ctrl.appendChild(input);

      row.appendChild(info);
      row.appendChild(ctrl);
      modeGroup.appendChild(row);
    }
    container.appendChild(modeGroup);

    // ── Manual proxy URL ────────────────────────────────────────────────
    const urlRow = document.createElement('div');
    urlRow.className = 'settings-group provider-field network-url-row';
    const urlInfo = document.createElement('div');
    urlInfo.className = 'provider-info';
    const urlName = document.createElement('div');
    urlName.className = 'provider-name';
    urlName.textContent = 'Proxy URL';
    const urlDesc = document.createElement('div');
    urlDesc.className = 'provider-description';
    urlDesc.id = 'network-status';
    urlInfo.appendChild(urlName);
    urlInfo.appendChild(urlDesc);

    const urlCtrl = document.createElement('div');
    urlCtrl.className = 'provider-control';
    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.id = 'network-proxy-url';
    urlInput.className = 'settings-input';
    urlInput.placeholder = 'http://host:port or socks5://host:port';
    urlInput.autocomplete = 'off';
    urlInput.spellcheck = false;
    // Commit on Enter or blur so a partially-typed URL isn't validated per key.
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void this._commitURL(); }
    });
    urlInput.addEventListener('blur', () => void this._commitURL());
    urlCtrl.appendChild(urlInput);

    urlRow.appendChild(urlInfo);
    urlRow.appendChild(urlCtrl);
    container.appendChild(urlRow);
  }

  /** Tab became visible: fetch the persisted proxy settings. */
  show() {
    void this._loadSettings();
  }

  /**
   * Load the persisted proxy mode/URL and reflect them.
   * @private
   */
  async _loadSettings() {
    try {
      const resp = await fetch('/api/settings');
      if (!resp.ok) return;
      const data = await resp.json();
      const proxy = (data && data.network && data.network.proxy) || {};
      this._mode = proxy.mode || 'system';
      this._url = proxy.url || '';
      this._reflect();
    } catch {
      /* offline — leave the controls as they are */
    }
  }

  /**
   * Reflect the current mode/URL onto the radios and URL field.
   * @private
   */
  _reflect() {
    const radios = this.host.querySelectorAll('.network-mode-radio');
    radios.forEach((r) => {
      const input = /** @type {HTMLInputElement} */ (r);
      input.checked = input.value === this._mode;
    });
    const urlInput = /** @type {HTMLInputElement|null} */ (this.host.querySelector('#network-proxy-url'));
    if (urlInput) {
      urlInput.value = this._url;
      urlInput.disabled = this._mode !== 'manual';
    }
    this._setStatus('');
  }

  /**
   * Handle a mode radio change. System/Direct persist immediately; Manual only
   * persists once a valid URL is present, revealing and focusing the field.
   * @private
   * @param {string} mode
   */
  async _onModeChange(mode) {
    const urlInput = /** @type {HTMLInputElement|null} */ (this.host.querySelector('#network-proxy-url'));
    if (mode === 'manual') {
      if (urlInput) urlInput.disabled = false;
      const url = urlInput ? urlInput.value : this._url;
      if (!isValidProxyURL(url)) {
        this._setStatus('Enter a proxy URL, e.g. http://127.0.0.1:7890');
        urlInput?.focus();
        return;
      }
      await this._save('manual', url.trim());
      return;
    }
    if (urlInput) urlInput.disabled = true;
    // Preserve the typed URL so switching back to Manual keeps it.
    await this._save(mode, this._url);
  }

  /**
   * The mode currently selected on the radios, which can differ from the
   * persisted mode: picking Manual with no valid URL yet leaves the radio on
   * manual without persisting. Falls back to the persisted mode when no radio
   * is checked (e.g. before first render).
   * @private
   * @returns {string} The checked radio's value, or the persisted mode.
   */
  _selectedMode() {
    let selected = this._mode;
    this.host.querySelectorAll('.network-mode-radio').forEach((r) => {
      const input = /** @type {HTMLInputElement} */ (r);
      if (input.checked) selected = input.value;
    });
    return selected;
  }

  /**
   * Commit the URL field (Enter/blur). Only meaningful while Manual is the
   * selected radio — gated on the selection, not the persisted mode, since
   * Manual stays selected but unpersisted until a valid URL is entered. An
   * invalid value surfaces an inline error and is not persisted.
   * @private
   */
  async _commitURL() {
    if (this._selectedMode() !== 'manual') return;
    const urlInput = /** @type {HTMLInputElement|null} */ (this.host.querySelector('#network-proxy-url'));
    const url = urlInput ? urlInput.value.trim() : '';
    if (url === this._url && this._mode === 'manual') return; // already persisted
    if (!isValidProxyURL(url)) {
      this._setStatus('That proxy URL looks invalid — include a scheme, e.g. http://host:port');
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
      const resp = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ network: { proxy: { mode, url } } }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const proxy = (data && data.network && data.network.proxy) || {};
      this._mode = proxy.mode || mode;
      this._url = proxy.url || '';
      this._reflect();
    } catch (err) {
      this._mode = prevMode;
      this._url = prevURL;
      this._reflect();
      this._setStatus(`Couldn't save the proxy setting (${extractErrorMessage(err)}).`);
    }
  }

  /**
   * @private
   * @param {string} text
   */
  _setStatus(text) {
    const el = this.host.querySelector('#network-status');
    if (el) el.textContent = text;
  }
}
