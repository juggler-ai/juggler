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

/**
 * The machine's ways in — LAN access and its tunnels — as both places that
 * switch them draw them: a session's Settings → Connectivity and the machine
 * server's sessions page. One row for LAN access and one per tunnel mode, each
 * with its Start or Stop and whether to start it whenever Juggler starts, and
 * under an open one a card per address: its QR, the address as a link with a
 * copy button, and how to use it.
 *
 * Each page hands it how to reach the machine server (ExposureApi) and how it
 * draws a row and a button (ExposureChrome); the cards, checkboxes and error
 * lines are this module's, styled by css/components/connectivity.css.
 *
 * An address the machine server names a session at (a session asking about
 * itself) is that session's card: the session's link first, with the QR — the
 * one a phone scans — and the machine's sessions page under it.
 * @module components/connectivity/exposure-view
 */

import { t, serverText } from '../../../sdk/lib/i18n.js';
import { createCopyButton } from '../../../sdk/lib/copy-button.js';

/**
 * One page of the server at one address, with its QR drawing.
 * @typedef {object} PageLink
 * @property {string} url - The address
 * @property {string} [qr] - SVG markup drawing it as a QR code (internal/qrsvg)
 */

/**
 * One address another device can open, as the machine server names it.
 * @typedef {object} ExposureURL
 * @property {string} url - The address of the machine's sessions page
 * @property {string} [interface] - The network interface it is on (LAN only)
 * @property {string} [qr] - SVG markup drawing the address as a QR code
 * @property {PageLink} [session] - The session that asked, at this address
 */

/**
 * LAN access, as the machine server reports it.
 * @typedef {object} LANState
 * @property {boolean} enabled - Whether devices on this network may come in
 * @property {ExposureURL[]} urls - This machine's addresses on its networks, while enabled
 */

/**
 * One tunnel mode a build registered. Each text field is English, with its
 * translatable message beside it as `<field>Message`.
 * @typedef {object} TunnelMode
 * @property {string} mode - Its id
 * @property {boolean} available - Whether it can start on this machine
 * @property {string} [title] - Its name
 * @property {string} [description] - What it does, and its trade-offs
 * @property {string} [startLabel] - Its start button's label
 * @property {string} [relayNote] - Said of an open link whose traffic is relayed
 * @property {string} [unavailableHint] - Why it cannot start, and what would let it
 */

/**
 * The machine's tunnel: the modes it can open, and the open one, if any.
 * @typedef {object} TunnelState
 * @property {TunnelMode[]} modes - Every mode this build registered
 * @property {{mode: string, url: string, relay: boolean, qr?: string, session?: PageLink}|null} running -
 *   The open tunnel: its mode, link, whether it is relayed, the link's QR
 *   drawing, and the session that asked, through it
 */

/**
 * What opens whenever Juggler starts: LAN access, and one tunnel mode ('' for none).
 * @typedef {{lanOnLaunch: boolean, wanOnLaunch: string}} LaunchState
 */

/**
 * How a page reaches the machine server's ways in. A refusal throws an error
 * carrying the server's reason as `detail`, and the message it was rendered
 * from as `serverMessage`, when it gave one.
 * @typedef {object} ExposureApi
 * @property {() => Promise<LANState>} getLAN - LAN access as it stands.
 * @property {(enabled: boolean) => Promise<LANState>} setLAN - Switches it, answering what is.
 * @property {() => Promise<TunnelState>} getTunnel - The tunnel as it stands.
 * @property {(mode: string) => Promise<TunnelState>} setTunnel - Opens mode, or with '' closes it, answering what is.
 * @property {() => Promise<LaunchState>} getLaunch - What opens at start, as saved.
 * @property {(change: Partial<LaunchState>) => Promise<unknown>} saveLaunch - Saves one key.
 */

/**
 * How a page draws a way in's row and its buttons.
 * @typedef {object} ExposureChrome
 * @property {(title: string, description: string, controls: HTMLElement[], warning: string) => HTMLElement} row -
 *   A row: its title, description and warning, and its controls, top to
 *   bottom. The view appends a row's error line and cards to it.
 * @property {(text: string, kind: 'start'|'stop') => HTMLButtonElement} button - A Start or Stop button.
 */

/**
 * A tunnel mode's copy, as the server wrote it: its message translated, else
 * the English beside it.
 * @param {TunnelMode} mode - The mode.
 * @param {'title'|'description'|'startLabel'|'relayNote'|'unavailableHint'} field - Which text.
 * @returns {string} The text ('' when the mode has none).
 */
function modeText(mode, field) {
  const messages = /** @type {Record<string, {key?: unknown, params?: unknown}|undefined>} */ (/** @type {unknown} */ (mode));
  const message = messages[`${field}Message`];
  return message ? serverText(message, mode[field] || '') : (mode[field] || '');
}

/**
 * What to say when a switch failed: lead, then the server's reason, if it gave
 * one, in the UI's language where it can be.
 * @param {string} lead - The translated "could not" line.
 * @param {unknown} err - What the call threw.
 * @returns {string} The line to show.
 */
function failureText(lead, err) {
  const { detail, serverMessage } = /** @type {{detail?: unknown, serverMessage?: any}} */ (err || {});
  if (typeof detail !== 'string' || !detail) return lead;
  const reason = serverMessage ? serverText(serverMessage, detail) : detail;
  return t('{lead} {reason}', { lead, reason });
}

/**
 * One address as a link with its copy button, under its label when it has one.
 * @param {HTMLElement} into - Where it goes.
 * @param {string} url - The address.
 * @param {string} label - What it opens ('' for no label).
 */
function addressLine(into, url, label) {
  if (label) {
    const name = document.createElement('div');
    name.className = 'connectivity-address-label';
    name.textContent = label;
    into.appendChild(name);
  }
  const row = document.createElement('div');
  row.className = 'connectivity-address-row';
  const link = document.createElement('a');
  link.className = 'connectivity-address-link';
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = url;
  row.appendChild(link);
  row.appendChild(createCopyButton(url, 'connectivity-address-copy', t('Copy address')));
  into.appendChild(row);
}

/**
 * One address another device can open, as a card: the QR drawing of what a
 * phone should open, big enough to scan, and beside it the address as a link
 * with a copy button, then muted lines saying how to use it. With a session
 * link, the card is that session's: its link first, with the QR, and the
 * machine's sessions page under it.
 * @param {{url: string, qr?: string, session?: PageLink}} address - The machine's address, and the session's there.
 * @param {string[]} notes - How to use it, and anything else worth knowing; '' entries are skipped.
 * @returns {HTMLElement} The card.
 */
function addressCard(address, notes) {
  const card = document.createElement('div');
  card.className = 'connectivity-address';
  const scanned = address.session || address;
  if (scanned.qr) {
    const code = document.createElement('div');
    code.className = 'connectivity-qr';
    code.setAttribute('aria-hidden', 'true');
    // The server's own drawing of the address: an <svg> of <rect>s, no text
    // or attributes from anywhere else.
    code.innerHTML = scanned.qr;
    card.appendChild(code);
  }
  const details = document.createElement('div');
  details.className = 'connectivity-address-details';
  if (address.session) {
    addressLine(details, address.session.url, t('This session'));
    addressLine(details, address.url, t('All sessions on this machine'));
  } else {
    addressLine(details, address.url, '');
  }
  for (const text of notes) {
    if (!text) continue;
    const note = document.createElement('div');
    note.className = 'connectivity-address-caption';
    note.textContent = text;
    details.appendChild(note);
  }
  card.appendChild(details);
  return card;
}

/**
 * A way in's "Start whenever Juggler starts" checkbox.
 * @param {boolean} checked - Whether it is saved to start.
 * @param {string} mode - The tunnel mode it stands for, or '' for LAN access.
 * @param {(checked: boolean) => void} onChange - Called with the new state.
 * @returns {HTMLElement} The labelled checkbox.
 */
function launchCheckbox(checked, mode, onChange) {
  const label = document.createElement('label');
  label.className = 'connectivity-launch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  if (mode) input.dataset.mode = mode;
  input.addEventListener('change', () => onChange(input.checked));
  const text = document.createElement('span');
  text.textContent = t('Start whenever Juggler starts');
  label.appendChild(input);
  label.appendChild(text);
  return label;
}

/**
 * An inline error line, hidden while empty.
 * @returns {HTMLElement} The line.
 */
function errorLine() {
  const p = document.createElement('div');
  p.className = 'connectivity-error';
  p.setAttribute('role', 'alert');
  p.hidden = true;
  return p;
}

/**
 * Show message on an error line, or clear it with ''.
 * @param {HTMLElement} line
 * @param {string} message
 */
function showError(line, message) {
  line.textContent = message;
  line.hidden = !message;
}

/**
 * The text an error line in section shows, if it shows one.
 * @param {HTMLElement} section
 * @returns {string} Its text, or ''.
 */
function shownError(section) {
  const line = /** @type {HTMLElement|null} */ (section.querySelector('.connectivity-error'));
  return line?.hidden === false ? line.textContent || '' : '';
}

/**
 * LAN access and the tunnel, drawn into two sections a page owns, and
 * switched through its ExposureApi. A switch in flight owns the sections until
 * it answers: refreshes leave them be, and their controls are held.
 */
export class ExposureView {
  /**
   * @param {object} options
   * @param {HTMLElement} options.lanSection - Where LAN access is drawn.
   * @param {HTMLElement} options.tunnelSection - Where the tunnel modes are drawn.
   * @param {ExposureApi} options.api - How the machine server is reached.
   * @param {ExposureChrome} options.chrome - How the page draws a row and a button.
   * @param {LaunchState} [options.launch] - What opens at start, as last known.
   */
  constructor({ lanSection, tunnelSection, api, chrome, launch = { lanOnLaunch: false, wanOnLaunch: '' } }) {
    /** @private */
    this._lanSection = lanSection;
    /** @private */
    this._tunnelSection = tunnelSection;
    /** @private */
    this._api = api;
    /** @private */
    this._chrome = chrome;
    /** @type {LaunchState} */
    this.launch = launch;
    /** @type {LANState|null} @private - LAN access as last shown. */
    this._lan = null;
    /** @type {TunnelState|null} @private - The tunnel as last shown. */
    this._tunnel = null;
    /** @type {string} @private - What the LAN section last drew, so a refresh that changes nothing redraws nothing. */
    this._lanDrawn = '';
    /** @type {string} @private - Likewise for the tunnel section. */
    this._tunnelDrawn = '';
    /** @type {boolean} @private - A switch is in flight. */
    this._busy = false;
    /**
     * How many choices of what opens at start the viewer has made, so a read
     * asked before the latest is not shown over it.
     * @type {number} @private
     */
    this._launchSaves = 0;
    /**
     * The last switch or choice the viewer made, settled once its answer is shown.
     * @type {Promise<void>}
     */
    this.pending = Promise.resolve();
  }

  /** Hide both sections, as for a viewer who may not switch them. */
  hide() {
    this._lanSection.hidden = true;
    this._tunnelSection.hidden = true;
  }

  /**
   * Fetch and show LAN access, the tunnel and what opens at start. A switch in
   * flight owns the sections until it answers, a choice made while the fetch
   * was out stands over what it answers, and whatever failed to fetch is left
   * as it was.
   * @returns {Promise<void>} Resolves once shown.
   */
  async refresh() {
    const saves = this._launchSaves;
    const [lan, tunnel, launch] = await Promise.all([
      this._api.getLAN().catch(() => null),
      this._api.getTunnel().catch(() => null),
      this._api.getLaunch().catch(() => null),
    ]);
    if (launch && saves === this._launchSaves) {
      this.launch = { lanOnLaunch: !!launch.lanOnLaunch, wanOnLaunch: launch.wanOnLaunch || '' };
    }
    if (this._busy) return;
    if (lan) this._showLAN(lan);
    if (tunnel) this._showTunnel(tunnel);
  }

  /**
   * Show what opens when Juggler starts on the rows already drawn.
   * @param {LaunchState} launch
   */
  showLaunch(launch) {
    this.launch = launch;
    if (this._lan) this._showLAN(this._lan);
    if (this._tunnel) this._showTunnel(this._tunnel);
  }

  /**
   * Save one change to what opens when Juggler starts, shown at once and put
   * back, with why, if the server refuses it. Only the key changed is put
   * back, so a change to the other one meanwhile stands.
   * @private
   * @param {{lanOnLaunch: boolean}|{wanOnLaunch: string}} change - One key.
   * @param {HTMLElement} section - The section whose error line says why.
   * @returns {Promise<void>} Resolves once the answer is shown.
   */
  async _saveLaunch(change, section) {
    const { lanOnLaunch, wanOnLaunch } = this.launch;
    const undo = 'lanOnLaunch' in change ? { lanOnLaunch } : { wanOnLaunch };
    this._launchSaves++;
    this.showLaunch({ ...this.launch, ...change });
    let failure = '';
    try {
      await this._api.saveLaunch(change);
    } catch (err) {
      failure = failureText(t('Your choice could not be saved.'), err);
      this.showLaunch({ ...this.launch, ...undo });
    }
    const line = /** @type {HTMLElement|null} */ (section.querySelector('.connectivity-error'));
    if (line) showError(line, failure);
  }

  /**
   * A Start or Stop button that runs action, held while a switch is in flight.
   * @private
   * @param {string} text
   * @param {'start'|'stop'} kind
   * @param {() => Promise<void>} action
   * @returns {HTMLButtonElement} The button.
   */
  _actionButton(text, kind, action) {
    const b = this._chrome.button(text, kind);
    b.disabled = this._busy;
    b.addEventListener('click', () => {
      this.pending = action();
    });
    return b;
  }

  /**
   * Draw LAN access: one row with its Start or Stop, like each tunnel mode's,
   * and whether to start it whenever Juggler starts, then, while it is on, a
   * card for each of this machine's addresses.
   * @private
   * @param {LANState} lan
   */
  _showLAN(lan) {
    this._lan = lan;
    const section = this._lanSection;
    section.hidden = false;
    const drawn = JSON.stringify([lan, this._busy, this.launch.lanOnLaunch]);
    if (drawn === this._lanDrawn) return;
    this._lanDrawn = drawn;
    const errorText = shownError(section);

    const control = lan.enabled
      ? this._actionButton(t('Stop LAN access'), 'stop', () => this._switchLAN(false))
      : this._actionButton(t('Start LAN access'), 'start', () => this._switchLAN(true));
    const atStart = launchCheckbox(this.launch.lanOnLaunch, '', (on) => {
      this.pending = this._saveLaunch({ lanOnLaunch: on }, section);
    });
    const row = this._chrome.row(t('LAN access'),
      t('Lets phones, tablets and other computers on this network use Juggler here.'),
      [control, atStart],
      t('There is no password: anyone on the network with the address can open, run and stop sessions.'));
    const line = errorLine();
    showError(line, errorText);
    row.appendChild(line);
    if (lan.enabled) {
      const addresses = document.createElement('div');
      addresses.className = 'connectivity-addresses';
      if (lan.urls.length === 0) {
        const none = document.createElement('div');
        none.className = 'connectivity-note';
        none.textContent = t('This machine has no address on a network right now.');
        addresses.appendChild(none);
      }
      for (const u of lan.urls) {
        addresses.appendChild(addressCard(u, [u.session
          ? t('Scan with a phone on the same network to open this session, or open either address on another device.')
          : t('Scan with a phone on the same network, or open the address on another device.')]));
      }
      row.appendChild(addresses);
    }
    section.replaceChildren(row);
  }

  /**
   * Draw the tunnel: a row for each mode with its Start (or why it cannot)
   * and whether to open it whenever Juggler starts, the open one with its card
   * and its Stop. A build with no modes shows nothing.
   * @private
   * @param {TunnelState} tunnel
   */
  _showTunnel(tunnel) {
    this._tunnel = tunnel;
    const section = this._tunnelSection;
    const modes = tunnel.modes || [];
    section.hidden = modes.length === 0;
    const drawn = JSON.stringify([tunnel, this._busy, this.launch.wanOnLaunch]);
    if (drawn === this._tunnelDrawn) return;
    this._tunnelDrawn = drawn;

    const line = errorLine();
    showError(line, shownError(section));
    const warning = t('There is no password: anyone with the link can open, run and stop sessions, from anywhere.');

    const running = tunnel.running;
    const rows = modes.map((m) => {
      const open = running?.mode === m.mode;
      const title = modeText(m, 'title') || m.mode;
      /** @type {HTMLElement|null} */
      let control = null;
      if (open) {
        control = this._actionButton(t('Stop {mode}', { mode: title }), 'stop', () => this._switchTunnel(''));
      } else if (!running) {
        if (m.available) {
          control = this._actionButton(modeText(m, 'startLabel') || t('Open'), 'start', () => this._switchTunnel(m.mode));
        } else {
          control = document.createElement('span');
          control.className = 'connectivity-note';
          control.textContent = modeText(m, 'unavailableHint');
        }
      }
      // One tunnel runs at a time, so one mode is saved to start: ticking one
      // unticks the others, and unticking it saves none.
      const atStart = launchCheckbox(this.launch.wanOnLaunch === m.mode, m.mode, (on) => {
        this.pending = this._saveLaunch({ wanOnLaunch: on ? m.mode : '' }, section);
      });
      const row = this._chrome.row(title, modeText(m, 'description'),
        /** @type {HTMLElement[]} */ ([control, atStart].filter(Boolean)), warning);
      if (open && running) {
        const addresses = document.createElement('div');
        addresses.className = 'connectivity-addresses';
        addresses.appendChild(addressCard(running, [
          running.session
            ? t('Scan with a phone to open this session, or open either link on any device.')
            : t('Scan with a phone, or open the link on any device.'),
          running.relay ? modeText(m, 'relayNote') : '',
        ]));
        row.appendChild(addresses);
      }
      return row;
    });
    section.replaceChildren(line, ...rows);
  }

  /**
   * Turn LAN access on or off, and show the answer — or, if it failed, why,
   * with the switch put back to what is.
   * @private
   * @param {boolean} enabled
   * @returns {Promise<void>} Resolves once shown.
   */
  async _switchLAN(enabled) {
    if (this._busy) return;
    this._busy = true;
    if (this._lan) this._showLAN(this._lan);
    let lan = this._lan;
    let failure = '';
    try {
      lan = await this._api.setLAN(enabled);
    } catch (err) {
      failure = failureText(t('LAN access could not be switched.'), err);
    } finally {
      this._busy = false;
    }
    this._lanDrawn = '';
    if (lan) this._showLAN(lan);
    const line = /** @type {HTMLElement|null} */ (this._lanSection.querySelector('.connectivity-error'));
    if (line) showError(line, failure);
  }

  /**
   * Open the tunnel in mode, or close it with '', and show the answer — or,
   * if it failed, why.
   * @private
   * @param {string} mode
   * @returns {Promise<void>} Resolves once shown.
   */
  async _switchTunnel(mode) {
    if (this._busy) return;
    this._busy = true;
    if (this._tunnel) this._showTunnel(this._tunnel);
    let tunnel = this._tunnel;
    let failure = '';
    try {
      tunnel = await this._api.setTunnel(mode);
    } catch (err) {
      failure = failureText(t('The tunnel could not be opened or closed.'), err);
    } finally {
      this._busy = false;
    }
    if (tunnel) this._showTunnel(tunnel);
    const line = /** @type {HTMLElement|null} */ (this._tunnelSection.querySelector('.connectivity-error'));
    if (line) showError(line, failure);
  }
}
