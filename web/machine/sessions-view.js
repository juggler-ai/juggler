//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The machine server's sessions page: the sessions this machine runs, and a
 * way to open, stop, retry or dismiss each, plus launching a new one from the
 * machine's recent projects, a typed path, or a new folder it makes.
 *
 * Everything it does goes through the control API it is given, and every
 * page it sends this tab to through the `navigate` it is given, so it runs as
 * well against stand-ins as against the server.
 *
 * In a browser, a session opens in this tab, as a link does — a modified click
 * on its Open link still gives it a tab of its own — and a session launched
 * from here takes this tab to it once it runs. The session's header has a
 * button back to this page.
 *
 * In a desktop app's window the page is that window's empty state, and the app
 * is its `host`: a session opens in the same window, by asking the host to show
 * it there, and the host's folder chooser and dropped folders open projects too.
 * A window on another computer's server, restored at launch, opens again the
 * project whose session it showed when the app last quit (`host.reopen`).
 *
 * On this machine's server the window's header has a server chooser: the
 * servers the app finds on the network, this computer, and a typed address,
 * any of which the app then shows in the window (`host.switchServer`). The
 * app shows another computer's server as this page with that server's page
 * framed in it (`framed`): the header, naming that server, stays this page's,
 * and the body is the frame alone, to which the app's menu commands the page
 * acts on are passed on (`relayFramerEvents`, on the framed side).
 *
 * A running session's whole row opens it, as its Open link does; the link stays
 * the keyboard's way in, so the row adds no second control around the others.
 *
 * A session is served at its project's link, /p/<key>/, an address that
 * outlives the session; its id is only the control API's handle. Open carries
 * the link, for copying and bookmarking. While a project has no running
 * session, the server serves this page at its link instead, told to open the
 * project (`config.open`): the page opens it and reloads the link, which is
 * then the session — or, for a visitor another site sent (`config.confirm`),
 * asks first.
 *
 * The page asks for the list as it mounts, and shows the app's spinner in its
 * place until the first answer.
 *
 * A viewer on this machine (`config.local`) also gets the server itself —
 * whether the desktop app or a terminal started it — and the machine's ways in:
 * LAN access and each tunnel mode, with Start and Stop, the address cards and
 * whether each opens whenever Juggler starts — drawn by the same ExposureView
 * as a session's Settings → Connectivity, through the control API. A viewer
 * off this machine gets none of it, since only this machine may switch them.
 *
 * Every page of this server is addressed through {@link pageURL}, so a page
 * that came over a rendezvous link opens its sessions through the link.
 * @module machine/sessions-view
 */

import { t, formatRelativeTime } from '../sdk/lib/i18n.js';
import { DROPDOWN_ARROW_SVG, OPEN_IN_NEW_SVG } from '../js/utils/icons.js';
import { extractErrorMessage, errorText } from '../sdk/lib/error-utils.js';
import { ControlApiError } from './control-api.js';
import { pageURL } from '../js/utils/page-url.js';
import { ExposureView } from '../js/components/connectivity/exposure-view.js';
import { presentPopup, POPUP_REVEALED_EVENT } from '../js/utils/popup-surface.js';

/** How many recent projects the page offers. */
const RECENTS_SHOWN = 8;

/**
 * @typedef {import('./control-api.js').Session} Session
 * @typedef {import('./control-api.js').PageConfig} PageConfig
 * @typedef {{
 *   listSessions: () => Promise<Session[]>,
 *   openSession: (project: string, options?: {wait?: boolean}) => Promise<Session>,
 *   stopSession: (id: string) => Promise<void>,
 *   recents: () => Promise<import('./control-api.js').Recents>,
 *   createFolder: (parent: string, name: string) => Promise<string>,
 *   getLAN?: () => Promise<import('./control-api.js').LANState>,
 *   setLAN?: (enabled: boolean) => Promise<import('./control-api.js').LANState>,
 *   getTunnel?: () => Promise<import('./control-api.js').TunnelState>,
 *   setTunnel?: (mode: string) => Promise<import('./control-api.js').TunnelState>,
 *   getLaunch?: () => Promise<import('./control-api.js').LaunchState>,
 *   setLaunch?: (change: Partial<import('./control-api.js').LaunchState>) => Promise<unknown>,
 *   getStatus?: () => Promise<import('../js/components/connectivity/exposure-view.js').ServerStatus>,
 * }} ControlApi
 * @typedef {{
 *   attach: (id: string, project: string, link: string) => Promise<void>,
 *   answerClose: (token: string) => Promise<void>,
 *   pickDirectory?: () => Promise<string|null>,
 *   takesDroppedFolders?: boolean,
 *   switchServer?: (address: string) => Promise<void>,
 *   discover?: () => Promise<FoundServer[]>,
 *   openURL?: (url: string) => void,
 *   reopen?: () => Promise<string>,
 * }} NativeHost
 *   The desktop app (native-host.js). attach is told the session's project too,
 *   which the app keeps for the window. The folder chooser, dropped folders and
 *   switchServer — with discover, the servers the app has found on the network
 *   to switch to — are there only on this machine's server's page; reopen only
 *   on a server by URL's, answering the project whose session the window
 *   showed when the app last quit ('' for none), which the page opens again.
 *   switchServer has the app show, in this window, the sessions page of the
 *   server at an address ('' for this machine's), and rejects with why it will
 *   not. openURL opens an address in the system browser, which a click on a
 *   link to it in the window's WebView would not.
 * @typedef {{name: string, url: string, version?: string}} FoundServer
 *   A server another computer announces on the network, as the app found it:
 *   the name it announced, and the address it answered at, which is what
 *   choosing it hands the app.
 * @typedef {{server: string, frameCtl: string, theme?: string, mode?: string}} FramedServer
 *   Another computer's server, which a desktop window on it shows framed in
 *   this machine's page: its address (an http(s) origin), the control address
 *   the app made for the page framed (frameCtl, which reaches only what a
 *   window on a server by URL may ask), and the theme and mode this page was
 *   opened with, which the framed page is handed too.
 */

/**
 * Whether a click is the browser's to act on — a modified or non-primary one,
 * which gives a link a tab or window of its own — rather than the page's.
 * @param {MouseEvent} event - The click.
 * @returns {boolean} True for a click the page leaves alone.
 */
function browsersClick(event) {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

/**
 * The last segment of a path, for a project's display name.
 * @param {string} p - A folder path, POSIX or Windows.
 * @returns {string} Its last segment (the path itself if it has none).
 */
function baseName(p) {
  return p.split(/[\\/]+/).filter(Boolean).at(-1) ?? p;
}

/**
 * Where a new folder is offered: beside the most recent project, since the
 * next one is usually its sibling, else the home folder, which the server
 * expands.
 * @param {string[]} recents - Recent projects, most recent first.
 * @returns {string} A parent folder, never empty.
 */
function defaultParent(recents) {
  const last = recents[0] || '';
  const cut = Math.max(last.lastIndexOf('/'), last.lastIndexOf('\\'));
  return cut > 0 ? last.slice(0, cut) : '~';
}

/**
 * A distance in time, in the largest unit that keeps it whole enough to read.
 * @param {number} ms - Signed milliseconds from now (negative is past).
 * @returns {string} "5 minutes ago", "in 4 seconds", ….
 */
function relative(ms) {
  const s = Math.round(ms / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return formatRelativeTime(s, 'second');
  if (abs < 3600) return formatRelativeTime(Math.round(s / 60), 'minute');
  if (abs < 86400) return formatRelativeTime(Math.round(s / 3600), 'hour');
  return formatRelativeTime(Math.round(s / 86400), 'day');
}

/**
 * What a session is doing, as the page shows it: a running session is busy or
 * idle; any other state is its own.
 * @param {Session} s - The session.
 * @returns {string} busy, idle, starting, stopping, restarting or error.
 */
function displayState(s) {
  if (s.state === 'running') return s.busy ? 'busy' : 'idle';
  return s.state;
}

/**
 * The line under a session's name saying what it is doing.
 * @param {Session} s - The session.
 * @param {number} now - The time now, in ms.
 * @returns {string} Its status line.
 */
function statusText(s, now) {
  switch (displayState(s)) {
    case 'busy':
      return t('Working');
    case 'idle':
      return s.lastActive
        ? t('Idle · last active {when}', { when: relative(Date.parse(s.lastActive) - now) })
        : t('Idle');
    case 'starting':
      return t('Starting…');
    case 'stopping':
      return t('Stopping…');
    case 'restarting': {
      const when = s.nextRestartAt ? relative(Math.max(0, Date.parse(s.nextRestartAt) - now)) : '';
      const retry = when ? t('Crashed · restarting {when}', { when }) : t('Crashed · restarting');
      if (!s.restarts) return retry;
      return `${retry} · ${t('{count, plural, one {restarted # time} other {restarted # times}}', { count: s.restarts })}`;
    }
    case 'error':
      return s.error ? t('Stopped: {reason}', { reason: s.error }) : t('Stopped');
    default:
      return s.state;
  }
}

/**
 * Build an element.
 * @param {string} tag - Tag name.
 * @param {{className?: string, text?: string, attrs?: Record<string, string>}} [props] - Class, text and attributes.
 * @param {Array<Node|null|false>} [children] - Children, skipping falsy ones.
 * @returns {HTMLElement} The element.
 */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs || {})) node.setAttribute(k, v);
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

/**
 * An icon from the app's set, as a decorative element.
 * @param {string} svg - Its SVG markup (a constant from icons.js).
 * @returns {HTMLElement} A span holding it.
 */
function icon(svg) {
  const span = el('span', { className: 'ms-icon', attrs: { 'aria-hidden': 'true' } });
  span.innerHTML = svg;
  return span;
}

/**
 * A refusal from the control API as ExposureView reads one: the server's
 * reason as `detail`, and the message it was rendered from.
 * @param {unknown} err - What a call threw.
 * @returns {{detail: string, serverMessage: unknown}} The refusal.
 */
function exposureFailure(err) {
  return {
    detail: err instanceof Error ? err.message : '',
    serverMessage: err instanceof ControlApiError ? err.serverMessage : null,
  };
}

/**
 * The machine's ways in through the control API (ExposureApi), each refusal
 * read as ExposureView reads one.
 * @param {Required<ControlApi>} api - The control API.
 * @returns {import('../js/components/connectivity/exposure-view.js').ExposureApi} The calls.
 */
function controlExposureApi(api) {
  /**
   * @template T
   * @param {() => Promise<T>} call
   * @returns {Promise<T>} Its answer, or its refusal re-read.
   */
  const asExposure = async (call) => {
    try {
      return await call();
    } catch (err) {
      throw exposureFailure(err);
    }
  };
  return {
    getServer: () => asExposure(() => api.getStatus()),
    getLAN: () => asExposure(() => api.getLAN()),
    setLAN: (enabled) => asExposure(() => api.setLAN(enabled)),
    getTunnel: () => asExposure(() => api.getTunnel()),
    setTunnel: (mode) => asExposure(() => api.setTunnel(mode)),
    getLaunch: () => asExposure(() => api.getLaunch()),
    saveLaunch: (change) => asExposure(() => api.setLaunch(change)),
  };
}

/**
 * A way in's row as this page draws it (ExposureChrome): its title,
 * description and warning on the left, its controls on the right.
 * @param {string} title
 * @param {string} description
 * @param {HTMLElement[]} controls - Top to bottom.
 * @param {string} warning - What opening it exposes.
 * @returns {HTMLElement} The row.
 */
function exposureRow(title, description, controls, warning) {
  return el('div', { className: 'ms-exposure-row' }, [
    el('div', { className: 'ms-exposure-info' }, [
      el('div', { className: 'ms-exposure-title', text: title }),
      description ? el('p', { className: 'ms-lan-note', text: description }) : null,
      warning ? el('p', { className: 'connectivity-warning', text: warning }) : null,
    ]),
    el('div', { className: 'ms-exposure-controls' }, controls),
  ]);
}

/**
 * A way in's Start or Stop as this page draws it (ExposureChrome).
 * @param {string} text
 * @param {'start'|'stop'} kind
 * @returns {HTMLButtonElement} The button.
 */
function exposureButton(text, kind) {
  return /** @type {HTMLButtonElement} */ (el('button', {
    className: `ms-button ${kind === 'stop' ? 'ms-button-quiet' : 'ms-button-primary'}`,
    text,
    attrs: { type: 'button' },
  }));
}

/**
 * The host a server's address names, for its title.
 * @param {string} server - The server's address.
 * @returns {string} Its host name, or the address itself if it names none.
 */
function hostOf(server) {
  try {
    return new URL(server).hostname || server;
  } catch {
    return server;
  }
}

/**
 * Whether two addresses are one server's: the same origin.
 * @param {string} a
 * @param {string} b
 * @returns {boolean} True when both parse to the same origin.
 */
function sameServer(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * The framed server's sessions page, as the frame loads it: embedded, with the
 * control address meant for it, and this page's theme.
 * @param {FramedServer} framed - The server framed.
 * @returns {string} Its address.
 */
function framedPageURL({ server, frameCtl, theme = '', mode = '' }) {
  let url = `${new URL(server).origin}/?embed=1&external=1&nativeCtl=${encodeURIComponent(frameCtl)}`;
  if (theme) url += `&theme=${encodeURIComponent(theme)}`;
  if (mode) url += `&mode=${encodeURIComponent(mode)}`;
  return url;
}

/**
 * The app's menu commands the sessions page acts on, which a framed window
 * passes on to the page it frames: Open, which goes to the page's field for
 * opening a project.
 */
const PAGE_COMMANDS = ['juggler:open-project'];

/**
 * Take the app's menu commands that the page framing this one passes on
 * (postMessage `{type, detail}`) as the app's own: each is dispatched on win
 * as the event the app dispatches. Only the framer is heard, and only the
 * commands the page acts on (PAGE_COMMANDS).
 * @param {Window} win - This page's window.
 * @param {Window} framer - The window framing it.
 * @returns {() => void} Stops listening.
 */
export function relayFramerEvents(win, framer) {
  const onMessage = (/** @type {MessageEvent} */ event) => {
    if (event.source !== framer || framer === win) return;
    const data = /** @type {{type?: unknown, detail?: unknown}|null} */ (event.data);
    const type = data && typeof data === 'object' ? data.type : null;
    if (typeof type !== 'string' || !PAGE_COMMANDS.includes(type)) return;
    win.dispatchEvent(new CustomEvent(type, { detail: data?.detail ?? null }));
  };
  win.addEventListener('message', onMessage);
  return () => win.removeEventListener('message', onMessage);
}

/**
 * The window's title: the page, and the server it shows.
 * @param {PageConfig} config - What the server handed the page.
 * @param {FramedServer|null} [framed] - The server framed, if any.
 * @returns {string} The title.
 */
export function pageTitle(config, framed = null) {
  const host = framed ? hostOf(framed.server) : config.host;
  return host ? t('Sessions on {host} · Juggler', { host }) : t('Sessions · Juggler');
}

/**
 * Where the page is: the machine its server runs on, or, for a page framing
 * another computer's server, that server's host — by its name alone, after
 * the page's title — or this computer, for a server that names no machine.
 * @param {PageConfig} config - What the server handed the page.
 * @param {string} [server] - The address of the server framed, if any.
 * @returns {string} Its name, as the header bar shows it.
 */
export function serverLocation(config, server = '') {
  const host = server ? hostOf(server) : config.host;
  return host || t('This computer');
}

/**
 * Which server this page is, for the header bar beside the wordmark: the
 * page's title, then where it is (serverLocation) — as the server chooser's
 * own button, when the window has one, else as text — and the server's
 * version, which a page framing another computer's server has none of its own
 * to show.
 * @param {PageConfig} config - What the server handed the page.
 * @param {{server?: string, chooser?: HTMLElement|null}} [options] - The
 *   address of the server framed, and the chooser's button, which names
 *   where the page is itself.
 * @returns {HTMLElement} The title block.
 */
export function serverTitle(config, { server = '', chooser = null } = {}) {
  return el('div', { className: 'ms-header' }, [
    el('div', { className: 'ms-title' }, [
      el('h1', { text: t('Sessions') }),
      chooser || el('p', { className: 'ms-subtitle', text: serverLocation(config, server) }),
    ]),
    !server && config.version ? el('span', { className: 'ms-version', text: config.version }) : null,
  ]);
}

/**
 * Mount the sessions page into root and load it.
 * @param {HTMLElement} root - Where the page goes.
 * @param {object} options
 * @param {ControlApi} options.api - The control API.
 * @param {PageConfig} options.config - What the server handed the page.
 * @param {(url: string) => void} [options.navigate] - Sends this tab to a page.
 * @param {() => void} [options.reload] - Loads this page's address again.
 * @param {(ms: number) => Promise<void>} [options.sleep] - Waits ms.
 * @param {(message: string) => boolean} [options.confirm] - Asks the user a yes/no question.
 * @param {() => number} [options.now] - The time now, in ms.
 * @param {number} [options.pollMs] - How often to refresh the list (0: never by itself).
 * @param {NativeHost|null} [options.host] - The desktop app whose window shows
 *   the page: a session opens in this window through it. Null in a browser.
 * @param {string} [options.notice] - Something to tell the user as the page
 *   opens: why the window shows this page rather than what it was opened for.
 * @param {HTMLElement|null} [options.header] - The header bar's slot for which
 *   server this is, which the page fills (serverTitle) with the server chooser
 *   beside it when the host can switch servers. None for a page with no header.
 * @param {FramedServer|null} [options.framed] - Another computer's server,
 *   which the page shows framed in its body in place of its own: its own
 *   server is then asked nothing but the window's servers are still chosen
 *   here. Only for a page the host may switch, on this machine's server.
 * @param {(message: {type: string, detail: unknown}, origin: string) => void} [options.postToFrame]
 *   Hands a menu command to the framed page at origin, the framed server's.
 * @returns {{refresh: () => Promise<void>, dispose: () => void, readonly pending: Promise<void>}} The page:
 *   refresh it now, take it down, or wait for the last switch of a way in to be shown.
 */
export function mountSessionsPage(root, {
  api,
  config,
  navigate = (url) => { window.location.assign(url); },
  reload = () => { window.location.reload(); },
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  confirm = (message) => window.confirm(message),
  now = () => Date.now(),
  pollMs = 2000,
  host = null,
  notice = '',
  header = null,
  framed = null,
  postToFrame,
}) {
  /** @type {Session[]} */
  let sessions = [];
  /** @type {string[]} */
  let recents = [];
  /** @type {Record<string, string>} */
  let recentLinks = {};
  /** @type {ControlApiError|null} */
  let unreachable = null;
  /** Whether a list has arrived: until one has, the page cannot say there are none. */
  let listed = false;
  /** IDs with a stop or dismiss in flight, whose actions are held. */
  const pending = new Set();
  let disposed = false;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;

  root.replaceChildren();
  const banner = el('div', { className: 'ms-banner-slot', attrs: { role: 'status' } });
  // What a project's link is opening, while it opens.
  const opening = el('p', { className: 'ms-lan-note ms-opening', attrs: { role: 'status' } });
  opening.hidden = true;

  const input = /** @type {HTMLInputElement} */ (el('input', {
    className: 'ms-launch-input',
    attrs: {
      type: 'text',
      name: 'project',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: t('/path/to/project or ~/project'),
      'aria-label': t('Project folder'),
    },
  }));
  const launchButton = el('button', { className: 'ms-button ms-button-primary', text: t('Open'), attrs: { type: 'submit' } });
  const browseButton = host?.pickDirectory
    ? button(t('Browse…'), 'ms-button-quiet ms-launch-browse', () => { void browse(); })
    : null;
  const launchError = el('p', { className: 'ms-launch-error', attrs: { role: 'alert' } });
  const form = /** @type {HTMLFormElement} */ (el('form', { className: 'ms-launch' }, [input, launchButton, browseButton]));
  const recentsList = el('ul', { className: 'ms-recents', attrs: { 'aria-label': t('Recent projects') } });
  const launchSection = el('section', { className: 'ms-section' }, [
    el('h2', { text: t('Open a project') }),
    form,
    launchError,
  ]);
  // The recent projects, under every other way of opening one; hidden while
  // there are none to offer.
  const recentsSection = el('section', { className: 'ms-section ms-recents-section' }, [
    el('h2', { text: t('Recent') }),
    recentsList,
  ]);

  const folderParent = /** @type {HTMLInputElement} */ (el('input', {
    className: 'ms-launch-input ms-folder-parent',
    attrs: {
      type: 'text',
      name: 'parent',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': t('Where to create it'),
    },
  }));
  folderParent.value = defaultParent([]);
  /** Whether the user has chosen the parent, which the recents then leave alone. */
  let parentChosen = false;
  folderParent.addEventListener('input', () => { parentChosen = true; });
  const folderName = /** @type {HTMLInputElement} */ (el('input', {
    className: 'ms-launch-input ms-folder-name',
    attrs: {
      type: 'text',
      name: 'name',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: t('Folder name'),
      'aria-label': t('Folder name'),
    },
  }));
  const folderBrowse = host?.pickDirectory
    ? button(t('Browse…'), 'ms-button-quiet ms-folder-browse', () => { void browseParent(); })
    : null;
  const folderError = el('p', { className: 'ms-launch-error ms-folder-error', attrs: { role: 'alert' } });
  const folderForm = /** @type {HTMLFormElement} */ (el('form', { className: 'ms-launch ms-new-folder' }, [
    folderParent,
    folderName,
    folderBrowse,
    el('button', { className: 'ms-button ms-button-primary', text: t('Create'), attrs: { type: 'submit' } }),
  ]));
  const folderSection = el('section', { className: 'ms-section' }, [
    el('h2', { text: t('New folder') }),
    folderForm,
    folderError,
  ]);

  const count = el('span', { className: 'ms-sessions-count' });
  const sessionsList = el('ul', { className: 'ms-sessions' });
  const sessionsSection = el('section', { className: 'ms-section' }, [
    el('h2', {}, [document.createTextNode(t('Running')), count]),
    sessionsList,
  ]);

  // The server chooser, in the header bar beside the server's name: the
  // servers the app has found on the network, this computer, and a typed
  // address, any of which the app then shows in this window. It is built once
  // and presented (presentPopup) while open, so the servers found are kept
  // current while it is closed too.
  const canSwitch = !!(header && host?.switchServer);
  const connectInput = /** @type {HTMLInputElement} */ (el('input', {
    className: 'ms-launch-input ms-connect-input',
    attrs: {
      type: 'text',
      name: 'address',
      autocomplete: 'off',
      spellcheck: 'false',
      inputmode: 'url',
      placeholder: t('Server address, e.g. http://devbox:3939'),
      'aria-label': t('Server address'),
    },
  }));
  const connectError = el('p', { className: 'ms-launch-error ms-connect-error', attrs: { role: 'alert' } });
  const connectForm = /** @type {HTMLFormElement} */ (el('form', { className: 'ms-launch ms-connect' }, [
    connectInput,
    el('button', { className: 'ms-button ms-button-primary', text: t('Connect'), attrs: { type: 'submit' } }),
  ]));
  // This computer, and the server framed when it is none the app has found;
  // then the servers the app has found on the network, hidden while there
  // are none.
  const hereList = el('ul', { className: 'ms-chooser-list ms-chooser-here' });
  const foundLabel = el('p', { className: 'ms-chooser-label', text: t('Found on this network') });
  const foundList = el('ul', { className: 'ms-chooser-list ms-found', attrs: { 'aria-label': t('Found on this network') } });
  // How a computer comes to be listed, said only while none is.
  const foundHint = el('p', { className: 'ms-lan-note ms-found-hint', text: t('Other computers appear here when their LAN access is on.') });
  foundLabel.hidden = true;
  foundList.hidden = true;
  foundHint.hidden = true;
  const chooserId = 'ms-server-chooser';
  const chooser = canSwitch
    ? el('div', {
      className: 'dropdown-menu show ms-chooser',
      attrs: { id: chooserId, role: 'dialog', 'aria-label': t('Choose a server') },
    }, [
      hereList,
      host?.discover ? foundLabel : null,
      host?.discover ? foundList : null,
      host?.discover ? foundHint : null,
      connectForm,
      connectError,
    ])
    : null;
  // Where the window is, as the button that changes it: its name, and the
  // arrow the app's other dropdowns open by.
  const switchButton = canSwitch
    ? /** @type {HTMLButtonElement} */ (el('button', {
      className: 'ms-button ms-button-quiet ms-server-switch',
      attrs: { type: 'button', title: t('Change server…') },
    }, [
      el('span', { className: 'ms-server-label', text: serverLocation(config, framed?.server) }),
      icon(DROPDOWN_ARROW_SVG),
    ]))
    : null;
  if (switchButton) {
    switchButton.addEventListener('click', () => {
      if (releaseChooser) closeChooser();
      else openChooser();
    });
    switchButton.setAttribute('aria-haspopup', 'dialog');
    switchButton.setAttribute('aria-expanded', 'false');
    switchButton.setAttribute('aria-controls', chooserId);
  }
  header?.replaceChildren(serverTitle(config, { server: framed?.server, chooser: switchButton }));
  /** @type {(() => void)|null} - Takes the open chooser down; null while it is closed. */
  let releaseChooser = null;
  /** @type {FoundServer[]} */
  let found = [];

  // The machine's ways in, for a viewer on this machine: the two sections are
  // wrappers the layout looks through, so their rows are spaced alike.
  const api0 = /** @type {Required<ControlApi>} */ (api);
  const serverBox = el('div', { className: 'ms-exposure-way' });
  const lanBox = el('div', { className: 'ms-exposure-way' });
  const tunnelBox = el('div', { className: 'ms-exposure-way' });
  serverBox.hidden = true;
  lanBox.hidden = true;
  tunnelBox.hidden = true;
  const exposure = config.local && api.getLAN && !framed
    ? new ExposureView({
      serverSection: api.getStatus ? serverBox : undefined,
      lanSection: lanBox,
      tunnelSection: tunnelBox,
      api: controlExposureApi(api0),
      chrome: { row: exposureRow, button: exposureButton },
      openAddress: host?.openURL,
    })
    : null;
  const exposureSection = exposure
    ? el('section', { className: 'ms-section ms-exposure' }, [
      el('h2', { text: t('Connectivity') }),
      serverBox,
      lanBox,
      tunnelBox,
    ])
    : null;

  /** @type {HTMLIFrameElement|null} */
  let frame = null;
  const frameOrigin = framed ? new URL(framed.server).origin : '';
  if (framed) {
    // The framed server's page is the body, and nothing of this server's.
    const where = hostOf(framed.server);
    frame = /** @type {HTMLIFrameElement} */ (el('iframe', {
      className: 'ms-frame',
      attrs: { src: framedPageURL(framed), title: t('Sessions on {host}', { host: where }) },
    }));
    if (notice) root.append(el('p', { className: 'ms-launch-error ms-frame-notice', attrs: { role: 'alert' }, text: notice }));
    root.append(frame);
  } else {
    // Two columns, which a wide window sets side by side (sessions.css): the
    // sessions and every way of opening one — a project, a new folder, a
    // recent project — and the machine's ways in. With no ways in, there is
    // one.
    root.append(banner, el('div', { className: 'ms-column ms-main' },
      [opening, sessionsSection, launchSection, folderSection, recentsSection]));
    if (exposureSection) root.append(el('div', { className: 'ms-column ms-side' }, [exposureSection]));
  }
  const toFrame = postToFrame || ((message, origin) => { frame?.contentWindow?.postMessage(message, origin); });

  /**
   * Show why the app would not switch servers, or clear it.
   * @param {string} message - The reason ('' clears it).
   */
  function showConnectError(message) {
    connectError.textContent = message;
    connectError.hidden = !message;
  }
  showConnectError('');

  /**
   * Ask the app to show, in this window, the server at address ('' for this
   * computer's), saying why if it will not. The app reloads the window once
   * it has; until then the chooser is taken down.
   * @param {string} address - The server's address, as typed or as found.
   * @returns {Promise<void>} Resolves once the app has answered.
   */
  async function switchTo(address) {
    if (!host?.switchServer) return;
    showConnectError('');
    try {
      await host.switchServer(address);
    } catch (err) {
      showConnectError(err instanceof Error ? errorText(err) : t('Could not connect to that server.'));
      return;
    }
    closeChooser();
  }

  connectForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const address = connectInput.value.trim();
    if (!address) {
      connectInput.focus();
      return;
    }
    void switchTo(address);
  });

  /**
   * One server the chooser offers: its whole row is the choice, which hands
   * the app the server's address. The server the window shows is marked as
   * current, and is no choice.
   * @param {string} className - The row's class.
   * @param {string} url - The server's address ('' for this computer).
   * @param {string} name - What the server is called.
   * @param {string} where - Under its name: where it is.
   * @param {boolean} current - Whether the window shows it.
   * @returns {HTMLElement} Its list item.
   */
  function choiceRow(className, url, name, where, current) {
    const choice = /** @type {HTMLButtonElement} */ (el('button', { className: 'ms-chooser-choice', attrs: { type: 'button' } }, [
      el('span', { className: 'ms-recent-main' }, [
        el('span', { className: 'ms-recent-name', text: name }),
        where ? el('span', { className: 'ms-found-address', text: where }) : null,
      ]),
      current ? el('span', { className: 'ms-chooser-mark', text: t('Current') }) : null,
    ]));
    if (current) {
      choice.disabled = true;
      choice.setAttribute('aria-current', 'true');
    } else {
      choice.addEventListener('click', () => { void switchTo(url); });
    }
    return el('li', { className, attrs: { 'data-url': url } }, [choice]);
  }

  /** Redraw the chooser's servers from the last the app found. */
  function renderChooser() {
    const shown = framed ? framed.server : '';
    const listed = !!shown && found.some((s) => sameServer(s.url, shown));
    hereList.replaceChildren(...[
      choiceRow('ms-chooser-local', '', t('This computer'), config.host || '', !framed),
      shown && !listed ? choiceRow('ms-chooser-shown', shown, hostOf(shown), shown, true) : null,
    ].filter((x) => x !== null));
    foundList.replaceChildren(...found.map((s) => choiceRow('ms-found-server', s.url, s.name,
      s.version ? `${s.url} · ${s.version}` : s.url, !!shown && sameServer(s.url, shown))));
    foundList.hidden = found.length === 0;
    foundLabel.hidden = found.length === 0;
    foundHint.hidden = found.length > 0;
  }

  /**
   * Escape takes the open chooser down.
   * @param {KeyboardEvent} event
   */
  const onChooserKey = (event) => {
    if (event.key === 'Escape' && releaseChooser) {
      event.preventDefault();
      closeChooser();
    }
  };

  /** Open the server chooser under its button, and ask the app what it finds. */
  function openChooser() {
    if (!chooser || !switchButton || releaseChooser || disposed) return;
    showConnectError('');
    renderChooser();
    releaseChooser = presentPopup({
      surface: chooser,
      anchor: switchButton,
      id: chooserId,
      onClose: closeChooser,
      align: 'right',
      insideSelectors: ['.ms-chooser', '.ms-server-switch'],
    });
    switchButton.setAttribute('aria-expanded', 'true');
    document.addEventListener('keydown', onChooserKey);
    void refreshFound();
  }

  /** Take the server chooser down, if it is open. */
  function closeChooser() {
    const release = releaseChooser;
    if (!release) return;
    releaseChooser = null;
    document.removeEventListener('keydown', onChooserKey);
    switchButton?.setAttribute('aria-expanded', 'false');
    release();
  }
  // Once it is on screen, the address box takes the keyboard.
  chooser?.addEventListener(POPUP_REVEALED_EVENT, () => { connectInput.focus(); });

  /**
   * Show why a launch failed, or clear it.
   * @param {string} message - The reason ('' clears it).
   */
  function showLaunchError(message) {
    launchError.textContent = message;
    launchError.hidden = !message;
  }
  showLaunchError(notice || openingNotice());

  /**
   * What the page says as it opens, for how it was reached: a project link
   * that names no project it knows.
   * @returns {string} The notice ('' for none).
   */
  function openingNotice() {
    if (config.openMissing) {
      return t('This link is for a project this computer has not opened recently. Open the project here and its link will work again.');
    }
    return '';
  }

  /**
   * Show why a new folder could not be made or opened, or clear it.
   * @param {string} message - The reason ('' clears it).
   */
  function showFolderError(message) {
    folderError.textContent = message;
    folderError.hidden = !message;
  }
  showFolderError('');

  /**
   * Show session id in this window, through the host. A refusal says why.
   * @param {string} id - The session's ID.
   * @param {string} project - Its project.
   * @param {string} link - Where it is served, its project's link.
   * @param {(message: string) => void} [report] - Where a refusal is shown.
   * @returns {Promise<boolean>} Whether the host took it.
   */
  async function attach(id, project, link, report = showLaunchError) {
    if (!host) return false;
    try {
      await host.attach(id, project, link);
      return true;
    } catch (err) {
      report(err instanceof Error ? errorText(err) : t('The session could not be opened in this window.'));
      return false;
    }
  }

  /**
   * @typedef {object} LaunchOptions
   * @property {() => Promise<string>} [make] - Makes the folder first, and
   *   answers the path to open; without it the project is opened as given.
   * @property {(message: string) => void} [report] - Where a failure is shown.
   */

  /**
   * Launch (or find) the session for project and show it in this window,
   * through the host.
   * @param {string} project - The folder, as given.
   * @param {LaunchOptions} [options]
   * @returns {Promise<boolean>} Whether it opened.
   */
  async function launchHere(project, { make, report = showLaunchError } = {}) {
    try {
      const sess = await api.openSession(make ? await make() : project);
      return await attach(sess.id, sess.project || project, sess.link, report);
    } catch (err) {
      report(err instanceof Error ? errorText(err) : t('The session could not be started.'));
      return false;
    }
  }

  /** Open the folder the host's chooser picks, if one is picked. */
  async function browse() {
    if (!host?.pickDirectory) return;
    const picked = await host.pickDirectory();
    if (picked) await launch(picked);
  }

  /** Take the folder the host's chooser picks, if one is picked, as the new folder's parent. */
  async function browseParent() {
    if (!host?.pickDirectory) return;
    const picked = await host.pickDirectory();
    if (!picked) return;
    folderParent.value = picked;
    parentChosen = true;
  }

  /**
   * Launch (or find) the session for project and take the user to it.
   * @param {string} project - The folder, as given.
   * @param {LaunchOptions} [options]
   * @returns {Promise<boolean>} Whether it opened.
   */
  async function launch(project, options = {}) {
    const report = options.report || showLaunchError;
    report('');
    if (host) return launchHere(project, options);
    try {
      const sess = await api.openSession(options.make ? await options.make() : project);
      navigate(pageURL(sess.link));
      await refresh();
      return true;
    } catch (err) {
      report(err instanceof Error ? errorText(err) : t('The session could not be started.'));
      return false;
    }
  }

  /**
   * Open again, in this window, the session the app says the window showed
   * when it last quit. It goes by the session's project, not its id, since
   * the server may have restarted since. A session that will not open leaves
   * the window on this page, saying why.
   * @param {() => Promise<string>} ask - The host's reopen.
   */
  async function reopenLast(ask) {
    let project = '';
    try {
      project = await ask();
    } catch {
      return;
    }
    if (!project || disposed) return;
    await launch(project, {
      report: (message) => showLaunchError(message
        ? t('The session for {project} could not be reopened: {error}', { project, error: message })
        : ''),
    });
  }

  /**
   * Open the project whose link this page was served at, and reload the link,
   * which is then its session — in a desktop window too, whose page the link
   * already is. A spawn in flight is waited for, and a restart waited out until
   * it is due; the link is reloaded only once the session runs, since until
   * then it serves this page again. One that will not open leaves the page
   * saying why.
   * @param {string} project - The folder.
   */
  async function openLinked(project) {
    const name = baseName(project);
    opening.replaceChildren(t('Opening {name}…', { name }));
    opening.hidden = false;
    showLaunchError('');
    for (;;) {
      /** @type {Session} */
      let sess;
      try {
        sess = await api.openSession(project, { wait: true });
      } catch (err) {
        if (disposed) return;
        opening.hidden = true;
        showLaunchError(err instanceof Error ? errorText(err) : t('The session could not be started.'));
        return;
      }
      if (disposed) return;
      if (sess.state === 'running') {
        reload();
        return;
      }
      if (sess.state !== 'restarting') {
        opening.hidden = true;
        showLaunchError(sess.error || t('The session could not be started.'));
        return;
      }
      opening.replaceChildren(t('Waiting for {name} to restart…', { name }));
      const due = sess.nextRestartAt ? Date.parse(sess.nextRestartAt) - now() : NaN;
      await sleep(Number.isFinite(due) && due > 0 ? due : 1000);
      if (disposed) return;
    }
  }

  /**
   * Offer to open the project whose link this page was served at, rather than
   * open it: the visitor was sent here from another site.
   * @param {string} project - The folder.
   */
  function offerLinked(project) {
    opening.replaceChildren(button(t('Open {name}', { name: baseName(project) }), 'ms-button-primary ms-opening-confirm',
      () => { void openLinked(project); }));
    opening.hidden = false;
  }

  folderForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const parent = folderParent.value.trim();
    const name = folderName.value.trim();
    if (!parent) {
      folderParent.focus();
      return;
    }
    if (!name) {
      folderName.focus();
      return;
    }
    const opened = await launch(`${parent}/${name}`, {
      make: () => api.createFolder(parent, name),
      report: showFolderError,
    });
    if (opened) folderName.value = '';
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const project = input.value.trim();
    if (!project) {
      input.focus();
      return;
    }
    if (await launch(project)) input.value = '';
  });

  /**
   * Stop (or dismiss) a session, asking first when a turn is running in it.
   * @param {Session} s - The session.
   * @param {boolean} ask - Whether a running turn needs a yes first.
   */
  async function stop(s, ask) {
    if (ask && s.busy && !confirm(t('A turn is running in {name}. Stop the session anyway?', { name: baseName(s.project) }))) {
      return;
    }
    pending.add(s.id);
    render();
    try {
      await api.stopSession(s.id);
    } catch (err) {
      showLaunchError(err instanceof Error ? errorText(err) : t('The session could not be stopped.'));
    } finally {
      pending.delete(s.id);
    }
    await refresh();
  }

  /**
   * A link that opens a session.
   * @param {Session} s - The session.
   * @param {string} className - The link's class.
   * @returns {HTMLElement} The link.
   */
  function openLink(s, className) {
    return sessionLink(s, `ms-button ms-button-primary ${className}`,
      [icon(OPEN_IN_NEW_SVG), el('span', { text: t('Open') })]);
  }

  /**
   * Open a session as its link does: in this tab in a browser; in a desktop
   * window, this window, through the host.
   * @param {Session} s - The session.
   */
  function openSession(s) {
    if (host) void attach(s.id, s.project, s.link);
    else navigate(pageURL(s.link));
  }

  /**
   * A link to a session, at its project's link, so one copied or bookmarked
   * from here outlives the session: this tab in a browser, as a plain link
   * goes; in a desktop window, this window, through the host.
   * @param {Session} s - The session.
   * @param {string} className - The link's classes.
   * @param {Array<Node>} children - What it shows.
   * @returns {HTMLElement} The link.
   */
  function sessionLink(s, className, children) {
    const a = el('a', { className, attrs: { href: pageURL(s.link) } }, children);
    if (host) {
      a.addEventListener('click', (event) => {
        event.preventDefault();
        void attach(s.id, s.project, s.link);
      });
    }
    return a;
  }

  /**
   * A button that runs onClick.
   * @param {string} label - Its text.
   * @param {string} className - Its classes.
   * @param {() => void} onClick - What it does.
   * @param {boolean} [disabled] - Whether it is held.
   * @returns {HTMLButtonElement} The button.
   */
  function button(label, className, onClick, disabled = false) {
    const b = /** @type {HTMLButtonElement} */ (el('button', { className: `ms-button ${className}`, text: label, attrs: { type: 'button' } }));
    b.disabled = disabled;
    b.addEventListener('click', onClick);
    return b;
  }

  /**
   * One session's row.
   * @param {Session} s - The session.
   * @returns {HTMLElement} Its list item.
   */
  function sessionRow(s) {
    const state = displayState(s);
    const held = pending.has(s.id);
    /** @type {Array<HTMLElement>} */
    const actions = [];
    if (state === 'busy' || state === 'idle') {
      actions.push(openLink(s, 'ms-session-open'));
      actions.push(button(t('Stop'), 'ms-button-quiet ms-session-stop', () => { void stop(s, true); }, held));
    } else if (state === 'restarting') {
      actions.push(button(t('Stop'), 'ms-button-quiet ms-session-stop', () => { void stop(s, false); }, held));
    } else if (state === 'error') {
      actions.push(button(t('Retry'), 'ms-button-primary ms-session-retry', () => { void launch(s.project); }, held));
      actions.push(button(t('Dismiss'), 'ms-button-quiet ms-session-dismiss', () => { void stop(s, false); }, held));
    }
    const openable = state === 'busy' || state === 'idle';
    const item = el('li', {
      className: openable ? 'ms-session ms-session-openable' : 'ms-session',
      attrs: { 'data-session-id': s.id, 'data-state': state },
    }, [
      el('span', { className: 'ms-dot', attrs: { 'aria-hidden': 'true' } }),
      el('div', { className: 'ms-session-main' }, [
        el('div', { className: 'ms-session-name', text: baseName(s.project) }),
        el('div', { className: 'ms-path', text: s.project }),
        el('div', { className: 'ms-session-status', text: statusText(s, now()) }),
      ]),
      el('div', { className: 'ms-actions' }, actions),
    ]);
    if (openable) {
      item.addEventListener('click', (event) => {
        // The row's own controls do their own thing, and a drag that selected
        // text (a path to copy) is not a click on the row.
        if (/** @type {Element} */ (event.target).closest('a, button, input')) return;
        if (!(window.getSelection()?.isCollapsed ?? true)) return;
        openSession(s);
      });
    }
    return item;
  }

  // Asks of the app overlap when one takes longer than a poll (it asks each
  // server it found whether it still answers), so each is numbered, and an
  // answer older than the one shown is dropped.
  let foundAsked = 0;
  let foundShown = 0;

  /**
   * Ask the app which servers it has found on the network, and redraw the
   * chooser's list. One it cannot answer leaves the list as last shown: the
   * address field is there either way.
   * @returns {Promise<void>} Resolves once redrawn.
   */
  async function refreshFound() {
    if (!chooser || !host?.discover) return;
    const asked = ++foundAsked;
    /** @type {FoundServer[]} */
    let servers;
    try {
      servers = await host.discover();
    } catch {
      return;
    }
    if (disposed || asked < foundShown) return;
    foundShown = asked;
    found = (servers || []).filter((x) => x && typeof x.url === 'string' && typeof x.name === 'string');
    renderChooser();
  }

  /**
   * One recent project's row, and its Open: a link to the project's link when
   * the server named one, which a plain click opens here as the button would.
   * @param {string} project - The folder.
   * @returns {HTMLElement} Its list item.
   */
  function recentRow(project) {
    const link = recentLinks[project];
    /** @type {HTMLElement} */
    let open;
    if (link) {
      open = el('a', { className: 'ms-button ms-button-quiet ms-recent-open', text: t('Open'), attrs: { href: pageURL(link) } });
      open.addEventListener('click', (event) => {
        if (!host && browsersClick(event)) return;
        event.preventDefault();
        void launch(project);
      });
    } else {
      open = button(t('Open'), 'ms-button-quiet ms-recent-open', () => { void launch(project); });
    }
    return el('li', { className: 'ms-recent', attrs: { 'data-project': project } }, [
      el('div', { className: 'ms-recent-main' }, [
        el('div', { className: 'ms-recent-name', text: baseName(project) }),
        el('div', { className: 'ms-path', text: project }),
      ]),
      open,
    ]);
  }

  /**
   * The recent projects to offer: those with no session under Running, which
   * already shows each of those, whatever its state.
   * @returns {string[]} At most RECENTS_SHOWN folders, most recent first.
   */
  function recentsToOffer() {
    const listed = new Set(sessions.map((s) => s.project));
    return recents.filter((p) => !listed.has(p)).slice(0, RECENTS_SHOWN);
  }

  /** Redraw the lists and notices from the last answers. */
  function render() {
    if (unreachable) {
      const outOfDate = unreachable.status === 401;
      banner.replaceChildren(el('div', { className: 'ms-unreachable' }, [
        el('span', {
          text: outOfDate
            ? t('This page belongs to a Juggler server that has since restarted. Reload it to continue.')
            : t('Can’t reach Juggler on this machine. Trying again…'),
        }),
        outOfDate ? button(t('Reload'), 'ms-button-quiet', () => window.location.reload()) : null,
      ]));
    } else {
      banner.replaceChildren();
    }

    count.textContent = sessions.length ? ` ${sessions.length}` : '';
    count.setAttribute('aria-label', t('{count, plural, one {# session} other {# sessions}}', { count: sessions.length }));
    if (!listed) {
      sessionsList.setAttribute('aria-busy', 'true');
      // Kept across redraws, so a retry does not restart its animation.
      if (!sessionsList.querySelector('.ms-sessions-loading')) {
        sessionsList.replaceChildren(el('li', { className: 'ms-sessions-loading' }, [
          el('juggler-spinner', { attrs: { 'aria-label': t('Loading sessions…') } }),
        ]));
      }
    } else if (sessions.length) {
      sessionsList.removeAttribute('aria-busy');
      sessionsList.replaceChildren(...sessions.map(sessionRow));
    } else {
      sessionsList.removeAttribute('aria-busy');
      sessionsList.replaceChildren(el('li', {
        className: 'ms-sessions-empty',
        text: t('No sessions are running. Open a project below to start one.'),
      }));
    }

    const offered = recentsToOffer();
    recentsList.replaceChildren(...offered.map(recentRow));
    recentsSection.hidden = offered.length === 0;
  }

  /**
   * Ask the server for everything the page shows — the sessions, and the
   * machine's ways in with what opens at start, a failure of which leaves
   * them as last shown, since the sessions list says when the server cannot
   * be reached — and redraw. The app is asked for the servers it has found
   * too, but not waited for: that can take it seconds, and the list of them
   * is drawn whenever it answers. A page framing another computer's server
   * shows nothing of this one's, and asks it for nothing.
   * @returns {Promise<void>} Resolves once the sessions and ways in are redrawn.
   */
  async function refresh() {
    void refreshFound();
    if (framed) return;
    await Promise.all([refreshSessions(), exposure ? exposure.refresh() : null]);
  }

  /**
   * Ask the server for the sessions and recent projects, and redraw.
   * @returns {Promise<void>} Resolves once redrawn.
   */
  async function refreshSessions() {
    try {
      const [list, known] = await Promise.all([api.listSessions(), api.recents()]);
      sessions = list || [];
      recents = known?.paths || [];
      recentLinks = known?.links || {};
      listed = true;
      if (!parentChosen) folderParent.value = defaultParent(recents);
      unreachable = null;
    } catch (err) {
      unreachable = err instanceof ControlApiError ? err : new ControlApiError(0, extractErrorMessage(err));
    }
    if (!disposed) render();
  }

  /** Refresh, then again after pollMs, while the page is shown. */
  function schedule() {
    if (disposed || !pollMs) return;
    timer = setTimeout(async () => {
      timer = null;
      if (!document.hidden) await refresh();
      schedule();
    }, pollMs);
  }

  const onVisible = () => {
    if (!document.hidden) void refresh();
  };
  document.addEventListener('visibilitychange', onVisible);
  // A folder dropped on the window: the host reads its path off the drag and
  // announces it here, since the page is never told one.
  const onFolderDropped = (/** @type {Event} */ e) => {
    const path = /** @type {CustomEvent} */ (e).detail?.path;
    if (typeof path === 'string' && path) void launch(path);
  };
  // The host announces a close of the window and holds it until the page
  // answers, quoting the announcement's token. This page keeps nothing that
  // needs saving first, so the answer goes at once.
  const onCloseRequested = (/** @type {Event} */ e) => {
    const token = /** @type {CustomEvent} */ (e).detail?.ackToken;
    if (host && typeof token === 'string') void host.answerClose(token);
  };
  // The app's menu commands the page acts on (PAGE_COMMANDS): Open goes to
  // the field for opening a project — the framed page's, in a page framing
  // one, which is handed the command at its server's origin alone.
  const onPageCommand = (/** @type {Event} */ e) => {
    if (framed) {
      try {
        toFrame({ type: e.type, detail: /** @type {CustomEvent} */ (e).detail ?? null }, frameOrigin);
      } catch {
        // A detail that cannot be posted is a command the framed page is not
        // handed.
      }
      return;
    }
    if (e.type === 'juggler:open-project') {
      input.focus();
      input.select();
    }
  };
  for (const type of PAGE_COMMANDS) window.addEventListener(type, onPageCommand);
  if (host) window.addEventListener('juggler:window-close-requested', onCloseRequested);
  // A folder dropped is this machine's, and means nothing to a server framed.
  if (host?.takesDroppedFolders && !framed) window.addEventListener('juggler:folder-dropped', onFolderDropped);
  if (!framed) render();
  void refresh();
  schedule();
  if (!framed) {
    if (host?.reopen) void reopenLast(host.reopen);
    if (config.open && config.confirm) offerLinked(config.open);
    else if (config.open) void openLinked(config.open);
  }

  return {
    refresh,
    get pending() {
      return exposure?.pending ?? Promise.resolve();
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('juggler:folder-dropped', onFolderDropped);
      window.removeEventListener('juggler:window-close-requested', onCloseRequested);
      for (const type of PAGE_COMMANDS) window.removeEventListener(type, onPageCommand);
      closeChooser();
    },
  };
}
