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
 * @property {string} origin - "local" (the server's own computer), "lan", or "remote"
 * @property {string} detail - LAN IP, or remote transport label; "" for local
 * @property {string} [name] - Who a remote client is, as its transport named it
 * @property {string} userAgent - Raw User-Agent, when the transport had one
 * @property {number} connectedAt - Connect time, unix milliseconds
 */

/**
 * Where this window is, relative to the server it views: what the server
 * says of this window's own connection (`origin`, and `detail` for a remote
 * one), and the name of the computer the server runs on, once read.
 * @typedef {object} ViewerPlace
 * @property {''|'local'|'lan'|'remote'} origin - This window's own origin; '' until known
 * @property {string} transport - How a remote window comes in, as the server labels it
 * @property {string} machine - The server's computer's name; '' when not known
 */

/**
 * Human label for where a client is, relative to the server, which is not
 * necessarily this window's computer: a client on the server's own computer
 * is "This computer" only when this window is there too, else the server's
 * computer, by name once known. Then "LAN · 192.168.1.4", or the remote
 * transport name ("Cloudflare Tunnel relay"), which the server supplies and is
 * shown as given — after the caller's name, when its transport named it
 * ("Alice · Direct P2P").
 * @param {ClientDescriptor} c
 * @param {ViewerPlace} place - Where this window is.
 * @returns {string} The origin label.
 */
function clientOriginLabel(c, place) {
  switch (c.origin) {
    case 'local':
      if (place.origin === 'local') return t('This computer');
      return t('{named, select, yes {The server’s computer, {machine}} other {The server’s computer}}',
        { named: place.machine ? 'yes' : 'no', machine: place.machine });
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
 * What the status row says of the server, relative to this window: a
 * headline naming the computer it runs on, and how this window reaches it —
 * for a server on this computer, who started it, when the machine server says.
 * @param {ViewerPlace} place - Where this window is.
 * @param {import('../connectivity/exposure-view.js').ServerStatus|null} server - The machine server's status, for a window on its computer.
 * @param {string} host - The address this window reaches the server at.
 * @returns {{title: string, description: string}} The row's text.
 */
function serverPlaceText(place, server, host) {
  const named = { named: place.machine ? 'yes' : 'no', machine: place.machine };
  switch (place.origin) {
    case 'local': {
      const title = t('On this computer');
      if (!server) return { title, description: t('This window and the Juggler server run on the same computer.') };
      const params = { pid: server.pid, addr: server.addr };
      return {
        title,
        description: server.appStarted
          ? t('Started by the Juggler app, which restarts it if it stops. Process {pid} on {addr}.', params)
          : t('Started from a terminal. If it stops, restart it there, or let the app start a new one. Process {pid} on {addr}.', params),
      };
    }
    case 'lan':
      return {
        title: t('{named, select, yes {On another computer: {machine}} other {On another computer}}', named),
        description: t('This window reaches it over the local network, at {host}. The agent’s files, commands and tools are on that computer, not this one.', { host }),
      };
    case 'remote':
      return {
        title: t('{named, select, yes {On another computer: {machine}} other {On another computer}}', named),
        description: t('This window reaches it remotely ({transport}). The agent’s files, commands and tools are on that computer, not this one.',
          { transport: place.transport || t('Remote') }),
      };
    default:
      return { title: t('Juggler server'), description: '' };
  }
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
  b.className = `btn btn-sm ${kind === 'stop' ? 'btn-danger' : 'btn-primary'}`;
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
 * Connectivity tab: where the server is relative to this window, who else is
 * connected to the session, how other devices reach it, and the outbound
 * proxy box.
 *
 * Where the server is comes from this window's own entry in the clients
 * list, whose origin the server judged from how this window reached it, so a
 * window onto another computer's server is told so, by that computer's name,
 * and the other clients are placed relative to the server, not to this window.
 *
 * LAN access and tunnels are the machine server's, machine-wide; a viewer on
 * this machine switches them here, through this session (`exposure` in the
 * connectivity state says it may), as on the sessions page — both draw them
 * with ExposureView — and chooses which opens whenever Juggler starts, which
 * the machine server saves. Each way in, once open, shows its addresses as cards to
 * scan, click or copy, each leading to this session. A viewer off the machine
 * is shown the cards of the way it came in by, and no wider one, to read only. Seeded from the shared
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
    /**
     * The machine server's status, as last read; only a window on its
     * computer may read it, and null until it has.
     * @type {import('../connectivity/exposure-view.js').ServerStatus|null} @private
     */
    this._server = null;
    /** @type {string} @private - The server's computer's name, once read; '' until then or when it gives none. */
    this._machine = '';
    /** @type {boolean} @private - Whether the name has been asked for. It is asked once, by a window off that computer. */
    this._machineAsked = false;
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
        this._refreshStatusSection();
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
      await Promise.all([this._refreshPlace(), this._refreshExposure()]);
    } catch (e) {
      console.error('Failed to refresh connectivity:', e);
    }
  }

  /**
   * This window's own entry in the clients list, by id; undefined before the
   * session id is known.
   * @private
   * @returns {ClientDescriptor|undefined} It.
   */
  _self() {
    const selfId = wsService.clientId;
    return selfId ? (this.connectivity.clients || []).find((c) => c.id === selfId) : undefined;
  }

  /**
   * Where this window is, relative to the server: by its own entry's origin,
   * or, before that is known, on the server's computer when it may switch
   * the ways in there (only a window on that computer may).
   * @private
   * @returns {ViewerPlace} It.
   */
  _place() {
    const self = this._self();
    const exposure = !!(/** @type {any} */ (this.connectivity)).exposure;
    const origin = /** @type {ViewerPlace['origin']} */ (self?.origin || (exposure ? 'local' : ''));
    return { origin, transport: self?.origin === 'remote' ? self.detail : '', machine: this._machine };
  }

  /**
   * Read what the status row says of the server — the machine server's
   * status for a window on its computer, the computer's name for one off it —
   * then redraw it and the clients, whose labels depend on it.
   * @private
   * @returns {Promise<void>} Resolves once shown.
   */
  async _refreshPlace() {
    const place = this._place();
    /** @type {Promise<unknown>[]} */
    const reads = [];
    if ((/** @type {any} */ (this.connectivity)).exposure) {
      reads.push(settingsApi.getServer().then((s) => { this._server = s; }, () => {}));
    }
    if (place.origin && place.origin !== 'local' && !this._machineAsked) {
      this._machineAsked = true;
      reads.push(settingsApi.getMachineName().then((name) => { this._machine = name; }, () => {}));
    }
    await Promise.all(reads);
    this._refreshStatusSection();
    this._refreshClientsSection();
  }

  /**
   * (Re)draw the status row: where the server is relative to this window.
   * Safe to call before the row exists (no-op).
   * @private
   */
  _refreshStatusSection() {
    const section = /** @type {HTMLElement|null} */ (this.host.querySelector('#connectivity-server-section'));
    if (!section) return;
    const place = this._place();
    const { title, description } = serverPlaceText(place, place.origin === 'local' ? this._server : null, window.location.host);
    const row = fieldRow(title, description, []);
    row.classList.add('connectivity-server');
    section.replaceChildren(row);
  }

  /**
   * Render the Connectivity tab content. Under "Server Status": where the
   * server is relative to this window (_refreshStatusSection), then the
   * connected-clients box, a standard provider-field row that
   * _refreshClientsSection fills. Under "Other Devices", shown while either
   * has something to show: the LAN and tunnel sections — switches for a
   * window on the server's computer, the way it came in by, to read only, for
   * one off it. The sections are layout-transparent wrappers, so every row in
   * a group is spaced alike (settings.css).
   * @private
   */
  renderConnectivityFields() {
    const container = this.host.querySelector('#connectivity-form');
    if (!container) return;
    container.innerHTML = '';

    const statusHeading = document.createElement('div');
    statusHeading.className = 'settings-section-heading caps-label-lg';
    statusHeading.textContent = t('Server Status');
    container.appendChild(statusHeading);

    const serverSection = document.createElement('div');
    serverSection.id = 'connectivity-server-section';
    serverSection.className = 'connectivity-section';
    container.appendChild(serverSection);

    const clientsSection = document.createElement('div');
    clientsSection.id = 'connectivity-clients-section';
    clientsSection.className = 'settings-group provider-field connectivity-clients';
    container.appendChild(clientsSection);

    const accessHeading = document.createElement('div');
    accessHeading.id = 'connectivity-access-heading';
    accessHeading.className = 'settings-section-heading caps-label-lg';
    accessHeading.textContent = t('Other Devices');
    accessHeading.hidden = true;
    container.appendChild(accessHeading);

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
      lanSection,
      tunnelSection,
      api: sessionExposureApi,
      chrome: { row: fieldRow, button: settingsButton },
      launch: this._exposure?.launch,
    });

    this._refreshStatusSection();
    this._refreshClientsSection();
    void this._refreshExposure();
  }

  /**
   * Fetch and show LAN access and the tunnel: to switch, if this viewer may;
   * else, for a viewer off the server's computer, the way it came in by, to
   * read only; else neither. A switch in flight owns the sections until it
   * answers. The "Other Devices" heading shows while either section does.
   * @private
   * @returns {Promise<void>} Resolves once shown.
   */
  async _refreshExposure() {
    const view = this._exposure;
    if (!view) return;
    const origin = this._place().origin;
    if ((/** @type {any} */ (this.connectivity)).exposure) {
      await view.refresh();
    } else if (origin === 'lan' || origin === 'remote') {
      const wayIn = await settingsApi.getWayIn().catch(() => null);
      if (wayIn) view.showWayIn(wayIn);
    } else {
      view.hide();
    }
    this._refreshAccessHeading();
  }

  /**
   * Show the "Other Devices" heading while the LAN or tunnel section shows.
   * @private
   */
  _refreshAccessHeading() {
    const heading = /** @type {HTMLElement|null} */ (this.host.querySelector('#connectivity-access-heading'));
    if (!heading) return;
    const shown = (/** @type {string} */ id) => {
      const s = /** @type {HTMLElement|null} */ (this.host.querySelector(id));
      return !!s && !s.hidden;
    };
    heading.hidden = !shown('#connectivity-lan-section') && !shown('#connectivity-tunnel-section');
  }

  /**
   * (Re)build the connected-clients box contents in place: a "Connected clients"
   * label and what the list is on the left, and on the right a list with one line per OTHER client
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
    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.textContent = t('Other windows, browsers and phones showing this session through the same server, and where each is.');
    info.appendChild(desc);
    const place = this._place();

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
        originEl.textContent = clientOriginLabel(c, place);
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
