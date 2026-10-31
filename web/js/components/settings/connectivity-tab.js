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

import { formatTimeAgo } from '../../utils/format.js';
import wsService from '../../services/websocket.js';
import { ProxySettings } from './proxy-settings.js';
import * as settingsApi from '../../services/settings-api.js';
import { t } from '../../../sdk/lib/i18n.js';
import { ExposureView } from '../connectivity/exposure-view.js';

/** Polling interval (ms) for refreshing the Connectivity tab while it's open. */
const CONNECTIVITY_POLL_MS = 2000;

/**
 * One connected viewer client, as reported by GET /api/connectivity `clients`
 * and the clients-changed event. The `id` lets a client exclude itself.
 * @typedef {object} ClientDescriptor
 * @property {string} id - Server-assigned client id
 * @property {string} origin - "local" (same machine), "lan", or "remote"
 * @property {string} detail - LAN IP, or remote transport label; "" for local
 * @property {string} [name] - Who a remote client is, as its transport named it
 * @property {string} userAgent - Raw User-Agent, when the transport had one
 * @property {number} connectedAt - Connect time, unix milliseconds
 */

/**
 * Human label for a client's origin, e.g. "Same machine", "LAN · 192.168.1.4",
 * or the remote transport name ("Cloudflare Tunnel relay"), which the server
 * supplies and is shown as given — after the caller's name, when its
 * transport named it ("Alice · Direct P2P").
 * @param {ClientDescriptor} c
 * @returns {string} The origin label.
 */
function clientOriginLabel(c) {
  switch (c.origin) {
    case 'local': return t('Same machine');
    case 'lan': return c.detail ? t('LAN · {address}', { address: c.detail }) : t('LAN');
    case 'remote': {
      const transport = c.detail || t('Remote');
      return c.name ? t('{name} · {transport}', { name: c.name, transport }) : transport;
    }
    default: return t('Connected');
  }
}

/**
 * Coarse "Browser · OS" label from a User-Agent, best-effort. Returns '' when
 * nothing recognisable is present (UA parsing is deliberately shallow).
 * @param {string} ua
 * @returns {string} A "Browser · OS" label, or '' when nothing is recognised.
 */
function clientDeviceLabel(ua) {
  if (!ua) return '';
  let os = '';
  if (/iPhone/.test(ua)) os = 'iPhone';
  else if (/iPad/.test(ua)) os = 'iPad';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Macintosh|Mac OS X/.test(ua)) os = 'Mac';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Linux/.test(ua)) os = 'Linux';
  let br = '';
  if (/Edg\//.test(ua)) br = 'Edge';
  else if (/OPR\//.test(ua)) br = 'Opera';
  else if (/Chrome\//.test(ua)) br = 'Chrome';
  else if (/Firefox\//.test(ua)) br = 'Firefox';
  else if (/Safari\//.test(ua)) br = 'Safari';
  return [br, os].filter(Boolean).join(' · ');
}

/**
 * A provider-field row: a title, description and (for a way in) its warning on
 * the left, its controls stacked on the right — how this tab draws a way in's
 * row (ExposureChrome).
 * @param {string} title
 * @param {string} description
 * @param {HTMLElement[]} controls - Top to bottom.
 * @param {string} [warning] - What opening it exposes.
 * @returns {HTMLElement} The row.
 */
function fieldRow(title, description, controls, warning) {
  const row = document.createElement('div');
  row.className = 'settings-group provider-field';
  const info = document.createElement('div');
  info.className = 'provider-info';
  const name = document.createElement('div');
  name.className = 'provider-name';
  name.textContent = title;
  info.appendChild(name);
  if (description) {
    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.textContent = description;
    info.appendChild(desc);
  }
  if (warning) {
    const warn = document.createElement('div');
    warn.className = 'connectivity-warning';
    warn.textContent = warning;
    info.appendChild(warn);
  }
  const ctrl = document.createElement('div');
  ctrl.className = 'provider-control';
  for (const control of controls) ctrl.appendChild(control);
  row.appendChild(info);
  row.appendChild(ctrl);
  return row;
}

/**
 * A small settings button: how this tab draws a way in's Start or Stop
 * (ExposureChrome).
 * @param {string} text
 * @param {'start'|'stop'} kind
 * @returns {HTMLButtonElement} The button.
 */
function settingsButton(text, kind) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `settings-btn ${kind === 'stop' ? 'btn-danger' : 'btn-primary'} small`;
  b.textContent = text;
  return b;
}

/**
 * The session's own routes to the machine server's ways in, which pass each
 * call on naming this session, so each address comes with this session's link
 * there (ExposureApi).
 * @type {import('../connectivity/exposure-view.js').ExposureApi}
 */
const sessionExposureApi = {
  getServer: () => settingsApi.getServer(),
  getLAN: () => settingsApi.getLAN(),
  setLAN: (enabled) => settingsApi.setLAN(enabled),
  getTunnel: () => settingsApi.getTunnel(),
  setTunnel: (mode) => settingsApi.setTunnel(mode),
  getLaunch: () => settingsApi.getLaunch(),
  saveLaunch: (change) => settingsApi.setLaunch(change),
};

/**
 * Connectivity tab: how other devices reach this session, who is connected to
 * it, and the outbound proxy box.
 *
 * LAN access and tunnels are the machine server's, machine-wide; a viewer on
 * this machine switches them here, through this session (`exposure` in the
 * connectivity state says it may), as on the sessions page — both draw them
 * with ExposureView — and chooses which opens whenever Juggler starts, which
 * the machine server saves. Each way in, once open, shows its addresses as cards to
 * scan, click or copy, each leading to this session. Seeded from the shared
 * loadConfig() fetch, then kept current by its own 2 s poll while visible and
 * by the `clients-changed` ws event even between polls.
 */
export class ConnectivityTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope).
   */
  constructor(host) {
    /** @type {HTMLElement} @private */
    this.host = host;
    /**
     * The outbound-proxy box shown at the bottom of this tab. It renders into
     * its own `#proxy-form` container, so the connectivity poll never touches
     * it; this tab just forwards render()/load() to it.
     * @type {ProxySettings} @private
     */
    this._proxy = new ProxySettings(host);
    /** @type {number|undefined} @private */
    this._connectivityPollId = undefined;
    /** @type {{clientCount: number, clients: ClientDescriptor[]}} @private */
    this.connectivity = { clientCount: 1, clients: [] };
    /** @type {boolean} @private - True once the shared loadConfig() has seeded this tab (gates the poll/live-update like the panel's first-load flag did). */
    this._loaded = false;
    /** @type {boolean} @private - True while this tab is the visible one. */
    this._visible = false;

    /** @type {(() => void)|null} @private - Drops the clients-changed subscription; null while not taken. */
    this._clientsChangedOff = null;

    /**
     * LAN access and the tunnel, drawn into the sections the last render made;
     * null before the first.
     * @type {ExposureView|null} @private
     */
    this._exposure = null;
    this.connect();
  }

  /**
   * The last switch or choice the viewer made, settled once its answer is shown.
   * @returns {Promise<void>} It.
   */
  get pending() {
    return this._exposure?.pending ?? Promise.resolve();
  }

  /**
   * Keep the connected-clients box live as viewers join or leave, independent
   * of the 2 s poll (which only runs while this tab is open). Idempotent; taken
   * again after dispose().
   */
  connect() {
    if (this._clientsChangedOff) return;
    this._clientsChangedOff = wsService.on('clients-changed', (/** @type {any} */ data) => {
      this.connectivity.clientCount = data.count;
      this.connectivity.clients = data.clients || [];
      if (this._visible && this._loaded) {
        this._refreshClientsSection();
      }
    });
  }

  /** Build the static DOM the shell owns for this tab (the proxy box). */
  render() {
    this._proxy.render();
  }

  /**
   * Receive the shared loadConfig() payload: store the connectivity state and
   * (on a full render) build the fields.
   * @param {{connectivity: object}} data
   * @param {boolean} renderFields
   */
  onConfigLoaded(data, renderFields) {
    this.connectivity = /** @type {any} */ (data.connectivity);
    this._loaded = true;
    if (renderFields) this.renderConnectivityFields();
    // Shown before this first load landed (the panel opened straight onto
    // this tab): show() could not poll then, so it starts now.
    if (this._visible && this._connectivityPollId === undefined) this._startPoll();
  }

  /**
   * The connectivity state this tab holds — what the panel's config load keeps
   * when its re-read fails, rather than blanking the form already drawn.
   * @returns {object} The current state.
   */
  currentConnectivity() {
    return this.connectivity;
  }

  /**
   * Tab became visible: refresh and arm the background poll, which follows LAN
   * access and tunnels switched elsewhere (the sessions page, another
   * session). Before the first load lands, onConfigLoaded starts it instead.
   */
  show() {
    this._visible = true;
    if (this._loaded) this._startPoll();
  }

  /**
   * Refresh now and every CONNECTIVITY_POLL_MS, replacing any poll running.
   * @private
   */
  _startPoll() {
    clearInterval(this._connectivityPollId);
    this.refreshConnectivity();
    this._connectivityPollId = setInterval(() => this.refreshConnectivity(), CONNECTIVITY_POLL_MS);
  }

  /**
   * The settings document arrived — from the panel's fetch, or because it changed
   * here or in another window, which share the one file. The proxy box owns its
   * own section of it; what opens when Juggler starts is the machine server's,
   * read with LAN access and the tunnel.
   * @param {any} settings - The whole settings document.
   */
  onSettingsChanged(settings) {
    this._proxy.onSettingsChanged(settings);
  }

  /** Tab hidden: stop the background poll. */
  hide() {
    this._visible = false;
    clearInterval(this._connectivityPollId);
    this._connectivityPollId = undefined;
  }

  /** Panel closed: stop the background poll. */
  close() {
    this.hide();
  }

  /** Element disconnected: drop the clients-changed subscription, stop the poll, release the proxy box. */
  dispose() {
    this._clientsChangedOff?.();
    this._clientsChangedOff = null;
    this.hide();
    this._proxy.dispose();
  }

  /**
   * Fetch the current connectivity state and redraw the clients box, which
   * owns no inputs, so every tick can redraw it — that keeps the relative
   * "connected N ago" times and the membership current. Then, where this
   * viewer may switch them, LAN access and the tunnel, redrawn only if they
   * changed.
   * @returns {Promise<void>} Resolves once everything fetched is shown.
   */
  async refreshConnectivity() {
    try {
      const next = await settingsApi.getConnectivity();
      if (!next) return;
      this.connectivity = next;
      this._refreshClientsSection();
      await this._refreshExposure();
    } catch (e) {
      console.error('Failed to refresh connectivity:', e);
    }
  }

  /**
   * Render the Connectivity tab content: the connected-clients box, a
   * standard provider-field row that _refreshClientsSection fills, then the
   * LAN and tunnel sections (shown once there is something this viewer may
   * switch). The sections are layout-transparent wrappers, so every row in
   * the form is spaced alike (settings.css).
   * @private
   */
  renderConnectivityFields() {
    const container = this.host.querySelector('#connectivity-form');
    if (!container) return;
    container.innerHTML = '';

    const clientsSection = document.createElement('div');
    clientsSection.id = 'connectivity-clients-section';
    clientsSection.className = 'settings-group provider-field connectivity-clients';
    container.appendChild(clientsSection);

    const serverSection = document.createElement('div');
    serverSection.id = 'connectivity-server-section';
    serverSection.className = 'connectivity-section';
    serverSection.hidden = true;
    container.appendChild(serverSection);

    const lanSection = document.createElement('div');
    lanSection.id = 'connectivity-lan-section';
    lanSection.className = 'connectivity-section';
    lanSection.hidden = true;
    container.appendChild(lanSection);

    const tunnelSection = document.createElement('div');
    tunnelSection.id = 'connectivity-tunnel-section';
    tunnelSection.className = 'connectivity-section';
    tunnelSection.hidden = true;
    container.appendChild(tunnelSection);
    this._exposure = new ExposureView({
      serverSection,
      lanSection,
      tunnelSection,
      api: sessionExposureApi,
      chrome: { row: fieldRow, button: settingsButton },
      launch: this._exposure?.launch,
    });

    this._refreshClientsSection();
    void this._refreshExposure();
  }

  /**
   * Fetch and show LAN access and the tunnel, if this viewer may switch them;
   * hide both if not. A switch in flight owns the sections until it answers.
   * @private
   * @returns {Promise<void>} Resolves once shown.
   */
  async _refreshExposure() {
    if (!this._exposure) return;
    if (!(/** @type {any} */ (this.connectivity)).exposure) {
      this._exposure.hide();
      return;
    }
    await this._exposure.refresh();
  }

  /**
   * (Re)build the connected-clients box contents in place: a "Connected clients"
   * label on the left, and on the right a list with one line per OTHER client
   * (this window is filtered out by id) — its origin, device, and how long it's
   * been connected — or a muted "none" line. Safe to call before the box exists
   * (no-op) and cheap to call on every poll tick (it owns no inputs).
   * @private
   */
  _refreshClientsSection() {
    const section = this.host.querySelector('#connectivity-clients-section');
    if (!section) return;

    const all = this.connectivity.clients || [];
    // Exclude our own window by id. Before the session id is known (a brief
    // window at startup) nothing matches, so drop one entry so we never count
    // ourselves as an "other" client.
    const selfId = wsService.clientId;
    let others = selfId ? all.filter((c) => c.id !== selfId) : all.slice(1);
    // Oldest first, so the list order stays stable as clients join.
    others = others.slice().sort((a, b) => (a.connectedAt || 0) - (b.connectedAt || 0));

    section.innerHTML = '';

    const info = document.createElement('div');
    info.className = 'provider-info';
    const name = document.createElement('div');
    name.className = 'provider-name';
    name.textContent = t('Connected clients');
    info.appendChild(name);

    const ctrl = document.createElement('div');
    ctrl.className = 'provider-control';

    if (others.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'connectivity-clients-empty';
      empty.textContent = t('No other clients connected');
      ctrl.appendChild(empty);
    } else {
      const list = document.createElement('ul');
      list.className = 'connectivity-client-list';
      for (const c of others) {
        const li = document.createElement('li');
        li.className = 'connectivity-client';

        const dot = document.createElement('span');
        dot.className = `connectivity-client-dot origin-${c.origin || 'unknown'}`;
        li.appendChild(dot);

        const originEl = document.createElement('span');
        originEl.className = 'connectivity-client-origin';
        originEl.textContent = clientOriginLabel(c);
        li.appendChild(originEl);

        // Device + connected-since, muted. Either may be absent.
        const device = clientDeviceLabel(c.userAgent);
        const since = formatTimeAgo(c.connectedAt);
        const metaText = device && since ? t('{device} — {since}', { device, since }) : (device || since);
        if (metaText) {
          const meta = document.createElement('span');
          meta.className = 'connectivity-client-meta';
          meta.textContent = metaText;
          li.appendChild(meta);
        }

        list.appendChild(li);
      }
      ctrl.appendChild(list);
    }

    section.appendChild(info);
    section.appendChild(ctrl);
  }
}
