//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The machine server's sessions page: the session switcher
 * (components/session-switcher.js) filling the window, as a project page drops
 * it under its chip — the sessions this machine runs, each to open, stop,
 * retry or dismiss, then its recent projects, then Open folder… and New
 * folder… — with a filter over them that ⌘K (Ctrl+K) reaches from anywhere on
 * the page.
 *
 * Everything it does goes through the control API it is given, and every
 * page it sends this tab to through the `navigate` and `openTab` it is given,
 * so it runs as well against stand-ins as against the server.
 *
 * In a browser, a session opens in this tab, and with ⌘ (Ctrl) held in a tab
 * of its own; a project launched from here takes this tab to its session once
 * it runs. Open folder… and New folder… are a typed path, which the server
 * opens, or makes and then opens. The session's header has a button back to
 * this page.
 *
 * In a desktop app's window the page is that window's empty state, and the app
 * is its `host`: a session opens in the same window, by asking the host to show
 * it there, and the host's folder chooser — which can make a folder too — and
 * dropped folders open projects. A window on another computer's server,
 * restored at launch, opens again the project whose session it showed when the
 * app last quit (`host.reopen`).
 *
 * The page acts on the switcher's picks (its actions) and decides nothing of
 * what it lists: it hands the switcher the sessions and recents of each
 * snapshot, from the events stream or the poll, and has it redraw.
 *
 * On this machine's server the window's header has a server chooser: the
 * servers the app finds on the network, this computer, and a typed address,
 * any of which the app then shows in the window (`host.switchServer`). The
 * app shows another computer's server as this page with that server's page
 * framed in it (`framed`): the header, naming that server, stays this page's,
 * and the body is the frame alone, to which the app's menu commands the page
 * acts on are passed on (`relayFramerEvents`, on the framed side).
 *
 * A session is served at its project's link, /p/<key>/, an address that
 * outlives the session; its id is only the control API's handle. A session or
 * recent project opened in a tab of its own is opened at its link, for copying
 * and bookmarking. While a project has no running
 * session, the server serves this page at its link instead, told to open the
 * project (`config.open`): the page opens it and reloads the link, which is
 * then the session — or, for a visitor another site sent (`config.confirm`),
 * asks first.
 *
 * The page asks for the list as it mounts, and shows the app's spinner in the
 * switcher's place until the first answer.
 *
 * What it shows then follows what there is (layout): the switcher, under its
 * filter, while there are sessions or recent projects; else — a first run — the
 * switcher's ways of opening a folder alone, with no filter, under a welcome in
 * a desktop window on this computer, for a newcomer, and under a line of
 * introduction anywhere else, for a visitor who came by address and knows why.
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

import { t } from '../sdk/lib/i18n.js';
import { CHECK_SVG, COMPUTER_SVG, DESKTOP_SVG, DROPDOWN_ARROW_SVG } from '../js/utils/icons.js';
import { extractErrorMessage, errorText } from '../sdk/lib/error-utils.js';
import { ControlApiError } from './control-api.js';
import { pageURL } from '../js/utils/page-url.js';
import { ExposureView } from '../js/components/connectivity/exposure-view.js';
import { presentPopup, POPUP_REVEALED_EVENT } from '../js/utils/popup-surface.js';
import { createCopyButton } from '../sdk/lib/copy-button.js';
import { followSessionsFeed } from '../js/services/sessions-feed.js';
import { baseName } from '../js/utils/session-attention.js';
import { SessionSwitcher } from '../js/components/session-switcher.js';
import { isMac } from '../js/services/key-shortcut-manager.js';

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
 *   events?: (onSnapshot: (snapshot: import('./control-api.js').Snapshot) => void, signal: AbortSignal) => Promise<void>,
 * }} ControlApi
 * @typedef {{
 *   attach: (id: string, project: string, link: string, conversation?: string) => Promise<void>,
 *   answerClose: (token: string) => Promise<void>,
 *   pickDirectory?: () => Promise<string|null>,
 *   takesDroppedFolders?: boolean,
 *   switchServer?: (address: string) => Promise<void>,
 *   discover?: () => Promise<Discovered>,
 *   openURL?: (url: string) => void,
 *   reopen?: () => Promise<string>,
 * }} NativeHost
 *   The desktop app (native-host.js). attach is told the session's project too,
 *   which the app keeps for the window, and may name one of the session's
 *   conversations for its page to open on. The folder chooser, dropped folders and
 *   switchServer — with discover, the servers the app has found on the network
 *   to switch to — are there only on this machine's server's page; reopen only
 *   on a server by URL's, answering the project whose session the window
 *   showed when the app last quit ('' for none), which the page opens again.
 *   switchServer has the app show, in this window, the sessions page of the
 *   server at an address ('' for this machine's), and rejects with why it will
 *   not. openURL opens an address in the system browser, which a click on a
 *   link to it in the window's WebView would not.
 * @typedef {{name: string, url: string, urls?: string[], version?: string}} FoundServer
 *   A server another computer announces on the network, as the app found it:
 *   the name it announced, and the address it answered at, which is what
 *   choosing it hands the app, among every address it was announced at — any
 *   of which a window on it may be on.
 * @typedef {{servers: FoundServer[], firewall?: boolean}} Discovered
 *   What the app has found on the network: the servers, and firewall when the
 *   app has heard no computer but this one on a system (Linux) whose host
 *   firewall may be dropping the others' answers unseen.
 * @typedef {{server: string, frameCtl: string, name?: string, theme?: string, mode?: string}} FramedServer
 *   Another computer's server, which a desktop window on it shows framed in
 *   this machine's page: its address (an http(s) origin), the control address
 *   the app made for the page framed (frameCtl, which reaches only what a
 *   window on a server by URL may ask), the name the server gave its machine
 *   when the app asked it, which the page shows it by, and the theme and mode
 *   this page was opened with, which the framed page is handed too.
 */

/**
 * Where a new folder at a typed path goes: its parent and its name. A bare
 * name goes in the home folder, which the server expands.
 * @param {string} path - The folder's path, as typed.
 * @returns {{parent: string, name: string}} Where to make it.
 */
function splitFolder(path) {
  const bare = path.replace(/[/\\]+$/, '');
  const cut = Math.max(bare.lastIndexOf('/'), bare.lastIndexOf('\\'));
  if (cut < 0) return { parent: '~', name: bare };
  return { parent: cut === 0 ? bare.charAt(0) : bare.slice(0, cut), name: bare.slice(cut + 1) };
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
    className: `btn btn-sm ${kind === 'stop' ? 'btn-secondary' : 'btn-primary'}`,
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
 * A server's address as its row in the server chooser shows it: host and
 * port. The scheme is left off when it is plain http, as every server found
 * is, and a link-local zone's URL escape ("%25") reads as the "%" it stands
 * for. An address with more than a host to it is shown whole. Parsed by hand,
 * since URL refuses an IPv6 address with a zone.
 * @param {string} server - The server's address.
 * @returns {string} What the row shows.
 */
function shownAddress(server) {
  const bare = /^http:\/\/([^/?#]+)\/?$/i.exec(server);
  return bare?.[1] ? bare[1].replace(/%25/g, '%') : server;
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
 * Whether a server found is the one at address: at any address it was
 * announced at, not only the one it answered at.
 * @param {FoundServer} server - The server found.
 * @param {string} address - The address.
 * @returns {boolean} True when address is one of the server's.
 */
function isServerAt(server, address) {
  return sameServer(server.url, address) || (server.urls || []).some((u) => sameServer(u, address));
}

/**
 * What the chooser says while the app has heard no computer but this one on
 * a system whose host firewall may be dropping the others' answers
 * (Discovered): the port to let in, and the commands that do it under ufw and
 * firewalld, each to copy — as a Linux server's LAN access says what to let
 * in for others to reach it.
 * @returns {HTMLElement} The note.
 */
function firewallHint() {
  return el('div', { className: 'ms-lan-note ms-found-firewall' }, [
    el('div', { text: t('If no other computer appears, this computer’s firewall may be blocking their answers: allow UDP port 5353. With ufw or firewalld, these do that:') }),
    ...[
      'sudo ufw allow 5353/udp',
      'sudo firewall-cmd --permanent --add-service=mdns && sudo firewall-cmd --reload',
    ].map((command) => el('div', { className: 'connectivity-address-row' }, [
      el('code', { className: 'connectivity-command', text: command }),
      createCopyButton(command, 'connectivity-address-copy', t('Copy command')),
    ])),
  ]);
}

/**
 * The theme a page painted before its first frame (web/shell/window-shell.html),
 * to hand the page it frames, which is to wear it: the colour, and the mode —
 * always one, so the framed page's own server's never decides it. A paint
 * following the system is in system mode, whatever mode it was handed.
 * @param {DOMStringMap|Record<string, string|undefined>} dataset - The page's root's dataset.
 * @returns {{theme: string, mode: string}} The colour painted, and the mode.
 */
export function paintedTheme(dataset) {
  const theme = dataset.theme || '';
  const mode = dataset.themeMode || (dataset.themeSystem === '1' ? 'system' : theme);
  return { theme, mode };
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
 * passes on to the page it frames: Open, which runs the switcher's Open
 * folder….
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
  const host = framed ? framedName(framed) : config.host;
  return host ? t('Sessions on {host} · Juggler', { host }) : t('Sessions · Juggler');
}

/**
 * What a framed server is called: the name it gave its machine, else the host
 * its address names.
 * @param {FramedServer} framed - The server framed.
 * @returns {string} Its name.
 */
function framedName(framed) {
  return framed.name || hostOf(framed.server);
}

/**
 * Where the page is: the machine its server runs on, or, for a page framing
 * another computer's server, that server's name (framedName) — by itself,
 * after the page's title — or this computer, for a server that names no
 * machine.
 * @param {PageConfig} config - What the server handed the page.
 * @param {FramedServer|null} [framed] - The server framed, if any.
 * @returns {string} Its name, as the header bar shows it.
 */
function serverLocation(config, framed = null) {
  const host = framed ? framedName(framed) : config.host;
  return host || t('This computer');
}

/**
 * Which server this page is, for the header bar beside the wordmark: the
 * page's title, then where it is (serverLocation) — as the server chooser's
 * own button, when the window has one, else as text — and the server's
 * version, which a page framing another computer's server has none of its own
 * to show.
 * @param {PageConfig} config - What the server handed the page.
 * @param {{framed?: FramedServer|null, chooser?: HTMLElement|null}} [options] -
 *   The server framed, if any, and the chooser's button, which names where
 *   the page is itself.
 * @returns {HTMLElement} The title block.
 */
export function serverTitle(config, { framed = null, chooser = null } = {}) {
  return el('div', { className: 'ms-header' }, [
    el('div', { className: 'ms-title' }, [
      el('h1', { className: 'text-truncate', text: t('Sessions') }),
      chooser || el('p', { className: 'ms-subtitle text-truncate', text: serverLocation(config, framed) }),
    ]),
    !framed && config.version ? el('span', { className: 'ms-version', text: config.version }) : null,
  ]);
}

/**
 * Mount the sessions page into root and load it.
 * @param {HTMLElement} root - Where the page goes.
 * @param {object} options
 * @param {ControlApi} options.api - The control API.
 * @param {PageConfig} options.config - What the server handed the page.
 * @param {(url: string) => void} [options.navigate] - Sends this tab to a page.
 * @param {(url: string) => void} [options.openTab] - Opens a page in a tab of its own.
 * @param {() => void} [options.reload] - Loads this page's address again.
 * @param {(ms: number) => Promise<void>} [options.sleep] - Waits ms.
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
  openTab = (url) => { window.open(url, '_blank', 'noopener'); },
  reload = () => { window.location.reload(); },
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
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
  /** @type {import('./control-api.js').Recents} */
  let recents = { paths: [], links: {}, waiting: {} };
  /** @type {ControlApiError|null} */
  let unreachable = null;
  /** Whether a list has arrived: until one has, the page cannot say there are none. */
  let listed = false;
  let disposed = false;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  /** Whether the events stream is delivering: the poll then leaves the sessions to it. */
  let streaming = false;
  /** @type {AbortController|null} Stops following the events stream. */
  let stream = null;

  root.replaceChildren();
  const banner = el('div', { className: 'ms-banner-slot', attrs: { role: 'status' } });
  // What a project's link is opening, while it opens.
  const opening = el('p', { className: 'ms-lan-note ms-opening', attrs: { role: 'status' } });
  opening.hidden = true;
  const launchError = el('p', { className: 'ms-launch-error', attrs: { role: 'alert' } });

  // The switcher: the sessions, the recent projects and the ways of opening
  // another, the page's one list. Until the first list arrives, the app's
  // spinner stands in its place.
  const switcher = framed ? null : new SessionSwitcher({
    mode: 'page',
    source: () => ({ sessions, recents, ownLink: '' }),
    actions: {
      goSession: (s, { newWindow }) => openSession(s, newWindow),
      openRecent: (r, { newWindow }) => {
        if (!host && newWindow && r.link) {
          openTab(pageURL(r.link));
          return undefined;
        }
        return launch(r.path);
      },
      retry: (s) => launch(s.project),
      stop: (s) => stop(s),
      pickFolder: host?.pickDirectory,
      openPath: (path, { create }) => {
        if (!create) return launch(path);
        const { parent, name } = splitFolder(path);
        return launch(path, { make: () => api.createFolder(parent, name) });
      },
    },
    canPickFolder: !!host?.pickDirectory,
    inApp: !!host,
    now,
  });
  const loading = el('div', { className: 'ms-sessions-loading', attrs: { 'aria-busy': 'true' } }, [
    el('juggler-spinner', { attrs: { 'aria-label': t('Loading sessions…') } }),
  ]);
  const switcherSection = el('section', { className: 'ms-section ms-switcher' }, [
    loading,
    switcher ? switcher.el : null,
    // A folder dropped on a desktop window opens it (onFolderDropped), which
    // nothing on screen would otherwise say.
    host?.takesDroppedFolders ? el('p', { className: 'ms-lan-note ms-drop-hint', text: t('You can also drop a folder onto this window.') }) : null,
  ]);

  // A first run in a desktop window on this computer (layout): the wordmark and
  // a word on what Juggler is head the page, over the same controls as ever.
  const welcome = el('div', { className: 'ms-welcome' }, [
    // i18n-ignore: the product name, which the wordmark spells out
    el('div', { className: 'ms-welcome-logo', attrs: { role: 'img', 'aria-label': 'Juggler' } }),
    el('p', { text: t('Juggler is an AI coding agent built for transparency, control and fast iteration.') }),
    el('p', { text: t('To begin, open a project folder below: an existing codebase, or a new folder for something fresh. If you haven’t connected an AI provider yet, Juggler will help you set one up.') }),
  ]);
  // A first run anywhere else — a browser tab, or a window on another
  // computer's server — is a more knowing visitor's: a line saying so, over
  // the typed path and the new folder.
  const intro = el('p', {
    className: 'ms-lan-note ms-intro',
    text: config.host
      ? t('Nothing has been opened on {host} yet. Open a project folder by its path, or create a new one.', { host: config.host })
      : t('Nothing has been opened here yet. Open a project folder by its path, or create a new one.'),
  });

  // What the page is while a project opens: its spinner, naming the project,
  // in place of everything else (showLaunching). Starting a session spawns a
  // server, which takes a second or two.
  const launchingName = el('p', { className: 'ms-launch-busy-text' });
  const launchingPanel = el('div', { className: 'ms-launch-busy', attrs: { role: 'status' } }, [
    el('juggler-spinner', { attrs: { 'aria-hidden': 'true' } }),
    launchingName,
  ]);
  launchingPanel.hidden = true;

  // The server chooser, in the header bar beside the server's name: the
  // servers the app has found on the network, this computer, and a typed
  // address, any of which the app then shows in this window. It is built once
  // and presented (presentPopup) while open, so the servers found are kept
  // current while it is closed too.
  const canSwitch = !!(header && host?.switchServer);
  const chooserId = 'ms-server-chooser';
  const connectInputId = `${chooserId}-address`;
  const connectInput = /** @type {HTMLInputElement} */ (el('input', {
    className: 'ms-launch-input ms-connect-input',
    attrs: {
      id: connectInputId,
      type: 'text',
      name: 'address',
      autocomplete: 'off',
      spellcheck: 'false',
      inputmode: 'url',
      placeholder: t('e.g., {example}', { example: 'http://devbox:3939' }),
      'aria-label': t('Server address'),
    },
  }));
  const connectError = el('p', { className: 'ms-launch-error ms-connect-error', attrs: { role: 'alert' } });
  const connectForm = /** @type {HTMLFormElement} */ (el('form', { className: 'ms-launch ms-connect' }, [
    connectInput,
    el('button', { className: 'btn btn-sm btn-primary', text: t('Connect'), attrs: { type: 'submit' } }),
  ]));
  // Three parts, each set off from the next: this computer; the servers on
  // the network — the one framed, found or not, then those the app has found
  // — and how one comes to be listed while no other is; and the address box,
  // under its label, for any other.
  const hereList = el('ul', { className: 'ms-chooser-list ms-chooser-here' });
  const foundList = el('ul', { className: 'ms-chooser-list ms-found', attrs: { 'aria-label': t('Found on this network') } });
  const foundHint = el('p', { className: 'ms-lan-note ms-found-hint', text: t('Other computers appear here when their LAN access is on.') });
  const foundFirewall = firewallHint();
  foundList.hidden = true;
  foundHint.hidden = true;
  foundFirewall.hidden = true;
  const chooser = canSwitch
    ? el('div', {
      className: 'dropdown-menu is-open ms-chooser',
      attrs: { id: chooserId, role: 'dialog', 'aria-label': t('Choose a server') },
    }, [
      el('div', { className: 'ms-chooser-section' }, [hereList]),
      host?.discover
        ? el('div', { className: 'ms-chooser-section' }, [
          el('p', { className: 'ms-chooser-label caps-label', text: t('Found on this network') }),
          foundList,
          foundHint,
          foundFirewall,
        ])
        : null,
      el('div', { className: 'ms-chooser-section ms-chooser-connect' }, [
        el('label', { className: 'ms-chooser-label caps-label', text: t('Server address'), attrs: { for: connectInputId } }),
        connectForm,
        connectError,
      ]),
    ])
    : null;
  // Where the window is, as the button that changes it: its name, and the
  // arrow the app's other dropdowns open by. This computer's own server is
  // This computer, as the chooser's own row names it, never its host.
  const switchButton = canSwitch
    ? /** @type {HTMLButtonElement} */ (el('button', {
      className: 'btn btn-sm btn-secondary ms-server-switch',
      attrs: { type: 'button', title: t('Change server…') },
    }, [
      el('span', { className: 'ms-server-label text-truncate', text: framed ? serverLocation(config, framed) : t('This computer') }),
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
  header?.replaceChildren(serverTitle(config, { framed, chooser: switchButton }));
  /** @type {(() => void)|null} - Takes the open chooser down; null while it is closed. */
  let releaseChooser = null;
  /** @type {FoundServer[]} */
  let found = [];
  // Whether the app's last answer suspected a firewall here (Discovered).
  let firewalled = false;
  // The name the server framed was last found under, kept through an ask
  // that misses it; '' until it is found.
  let shownName = '';

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
      el('h2', { className: 'caps-label', text: t('Connectivity') }),
      serverBox,
      lanBox,
      tunnelBox,
    ])
    : null;
  const mainColumn = el('div', { className: 'ms-column ms-main' });
  const sideColumn = exposureSection ? el('div', { className: 'ms-column ms-side' }, [exposureSection]) : null;

  /** @type {HTMLIFrameElement|null} */
  let frame = null;
  const frameOrigin = framed ? new URL(framed.server).origin : '';
  if (framed) {
    // The framed server's page is the body, and nothing of this server's.
    const where = framedName(framed);
    frame = /** @type {HTMLIFrameElement} */ (el('iframe', {
      className: 'ms-frame',
      attrs: { src: framedPageURL(framed), title: t('Sessions on {host}', { host: where }) },
    }));
    if (notice) root.append(el('p', { className: 'ms-launch-error ms-frame-notice', attrs: { role: 'alert' }, text: notice }));
    root.append(frame);
  } else {
    // Two columns, which a wide window sets side by side (sessions.css): the
    // switcher — the sessions and every way of opening one — and the machine's
    // ways in. With no ways in, there is one. Which parts show is layout's.
    root.append(banner, mainColumn);
    if (sideColumn) root.append(sideColumn);
    root.append(launchingPanel);
  }

  /** The project opening, while the page is its spinner ('' for none). */
  let launchingProject = '';

  /**
   * Show the page as its spinner while project opens, or ('') as itself again.
   * @param {string} project - The folder opening ('' for none).
   */
  function showLaunching(project) {
    launchingProject = project;
    launchingName.textContent = project ? t('Opening {name}…', { name: baseName(project) }) : '';
    layout();
  }

  /**
   * Shape the page to what it has to show:
   * - opening a project: its spinner alone (showLaunching);
   * - until the first list: that list's spinner, and nothing to act on yet;
   * - sessions open, or recent projects: the switcher, under its filter;
   * - nothing open and nothing recent, a first run: the switcher's ways of
   *   opening a folder alone, with no filter, and the machine's ways in, under
   *   the welcome in a desktop window on this computer, in one column centred
   *   in it, and under a line saying so anywhere else.
   */
  function layout() {
    if (framed) return;
    const state = launchingProject ? 'launching'
      : !listed ? 'loading'
        : sessions.length || recents.paths.length ? 'listing' : 'first-run';
    const welcoming = state === 'first-run' && !!host?.pickDirectory;
    root.classList.toggle('ms-welcoming', welcoming);
    launchingPanel.hidden = state !== 'launching';
    banner.hidden = state === 'launching';
    mainColumn.hidden = state === 'launching';
    welcome.hidden = !welcoming;
    intro.hidden = state !== 'first-run' || welcoming;
    loading.hidden = state !== 'loading';
    if (switcher) {
      switcher.el.hidden = state === 'loading';
      switcher.showFilter(state !== 'first-run');
    }
    // The ways in wait for the first list too, unless it is not coming, since
    // that list decides whether the page is laid out as a first run.
    if (sideColumn) sideColumn.hidden = state === 'launching' || (state === 'loading' && !unreachable);
    const order = [welcome, intro, opening, launchError, switcherSection];
    // Moved only when the order changes, since a move takes the keyboard's focus.
    if (order.some((part, i) => mainColumn.children[i] !== part)) mainColumn.append(...order);
  }
  // A page the browser brings back from its cache, as Back does after a
  // session opened in this tab, is the page again, not a spinner.
  const onPageShow = (/** @type {PageTransitionEvent} */ e) => {
    if (e.persisted) showLaunching('');
  };
  window.addEventListener('pageshow', onPageShow);
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
   * computer's), saying why if it will not. Once the app has taken it, the
   * window is navigated to that server's page, and the chooser is left open
   * until it goes with this page: taking it down retracts the entry it pushed
   * for the Back button (history.back(), popup-manager.js), and a history
   * traversal cancels the app's navigation still under way.
   * @param {string} address - The server's address, as typed or as found.
   * @returns {Promise<void>} Resolves once the app has answered.
   */
  async function switchTo(address) {
    if (!host?.switchServer) return;
    showConnectError('');
    try {
      await host.switchServer(address);
    } catch (err) {
      // A refusal is the app's to explain; any other failure is the browser's,
      // in words that mean nothing to the user.
      showConnectError(err instanceof ControlApiError ? errorText(err) : t('Could not connect to that server.'));
    }
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
   * the app the server's address. A row is the server's icon, its name over
   * where it is, the version it answered with, and a tick on the server the
   * window shows, which is no choice.
   * @param {string} className - The row's class.
   * @param {string} url - The server's address ('' for this computer).
   * @param {{name: string, where: string, current: boolean, version?: string}} server -
   *   What it is called, where it is (shown under the name), whether the
   *   window shows it, and its version.
   * @returns {HTMLElement} Its list item.
   */
  function choiceRow(className, url, { name, where, current, version }) {
    const address = where ? el('span', { className: 'ms-found-address text-truncate', text: url ? shownAddress(where) : where }) : null;
    if (address && url) address.title = where;
    const mark = current ? el('span', { className: 'ms-chooser-mark', attrs: { title: t('Current') } }, [icon(CHECK_SVG)]) : null;
    const choice = /** @type {HTMLButtonElement} */ (el('button', { className: 'ms-chooser-choice', attrs: { type: 'button' } }, [
      el('span', { className: 'ms-chooser-icon' }, [icon(url ? DESKTOP_SVG : COMPUTER_SVG)]),
      el('span', { className: 'ms-recent-main' }, [
        el('span', { className: 'ms-recent-name text-truncate', text: name }),
        address,
      ]),
      version ? el('span', { className: 'ms-version ms-chooser-version', text: version }) : null,
      mark,
    ]));
    if (current) {
      choice.disabled = true;
      choice.setAttribute('aria-current', 'true');
    } else {
      choice.addEventListener('click', () => { void switchTo(url); });
    }
    return el('li', { className, attrs: { 'data-url': url } }, [choice]);
  }

  /** The servers the chooser's rows were last drawn from, as renderChooser keys them. */
  let chooserShown = '';

  /**
   * Redraw the chooser's servers from the last the app found, and name the
   * server framed in the header as it was found: the window's address alone
   * says only where it is.
   *
   * This computer stands alone in the top section. The network's list holds
   * every other server: first the one framed, if any — found or not, so its
   * row holds still as asks find and miss it — then the rest found.
   *
   * The rows are rebuilt only when what they show changes: a click fires only
   * when the press and the release land on the same element, so a row
   * replaced between them — by the answer that comes seconds after the
   * chooser opens, or a poll's — swallows the click.
   */
  function renderChooser() {
    const shown = framed ? framed.server : '';
    const current = shown ? found.find((s) => isServerAt(s, shown)) : undefined;
    if (current) shownName = current.name;
    const label = switchButton?.querySelector('.ms-server-label');
    if (label && shown) label.textContent = shownName || serverLocation(config, framed);
    const others = found.filter((s) => s !== current);
    const key = JSON.stringify([shown, shownName, found.map((s) => [s.url, s.name, s.version || '', s.urls || []])]);
    if (key !== chooserShown) {
      chooserShown = key;
      hereList.replaceChildren(
        choiceRow('ms-chooser-local', '', { name: t('This computer'), where: config.host || '', current: !framed }),
      );
      foundList.replaceChildren(...[
        current ? choiceRow('ms-found-server', current.url, { name: current.name, where: current.url, current: true, version: current.version }) : null,
        framed && !current ? choiceRow('ms-found-server', shown, { name: shownName || framedName(framed), where: shown, current: true }) : null,
        ...others.map((s) => choiceRow('ms-found-server', s.url, { name: s.name, where: s.url, current: false, version: s.version })),
      ].filter((x) => x !== null));
    }
    foundList.hidden = !shown && found.length === 0;
    foundHint.hidden = others.length > 0;
    foundFirewall.hidden = !firewalled || others.length > 0;
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

  /** Whether a launch is in flight, while which another is not started. */
  let launching = false;

  /**
   * Launch (or find) the session for project and take the user to it. The
   * page is its spinner from the moment it is asked; one that fails is the
   * page again, saying why, and one that opens leaves the spinner up while
   * the window goes to the session.
   * @param {string} project - The folder, as given.
   * @param {LaunchOptions} [options]
   * @returns {Promise<boolean>} Whether it opened.
   */
  async function launch(project, options = {}) {
    if (launching) return false;
    launching = true;
    const report = options.report || showLaunchError;
    report('');
    showLaunching(project);
    let opened = false;
    try {
      opened = await (host ? launchHere(project, options) : launchInTab(project, options));
    } finally {
      launching = false;
      if (!opened && !disposed) showLaunching('');
    }
    return opened;
  }

  /**
   * Launch (or find) the session for project and take this tab to it.
   * @param {string} project - The folder, as given.
   * @param {LaunchOptions} [options]
   * @returns {Promise<boolean>} Whether it opened.
   */
  async function launchInTab(project, { make, report = showLaunchError } = {}) {
    try {
      const sess = await api.openSession(make ? await make() : project);
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
    opening.replaceChildren(button(t('Open {name}', { name: baseName(project) }), 'btn-primary ms-opening-confirm',
      () => { void openLinked(project); }));
    opening.hidden = false;
  }

  /**
   * Stop (or dismiss) a session. The switcher asks first, in its row, when a
   * turn is running in it.
   * @param {Session} s - The session.
   * @returns {Promise<void>} Resolves once stopped and the list asked for again.
   */
  async function stop(s) {
    try {
      await api.stopSession(s.id);
    } catch (err) {
      showLaunchError(err instanceof Error ? errorText(err) : t('The session could not be stopped.'));
    }
    await refresh();
  }

  /**
   * Open a session: in a desktop window, this window, through the host; in a
   * browser, this tab — or, asked for (⌘ or Ctrl held), a tab of its own — at
   * its project's link, which outlives the session.
   * @param {Session} s - The session.
   * @param {boolean} newWindow - Whether a tab of its own was asked for.
   * @returns {Promise<boolean>|undefined} The attach, in a desktop window.
   */
  function openSession(s, newWindow) {
    if (host) return attach(s.id, s.project, s.link);
    if (newWindow) openTab(pageURL(s.link));
    else navigate(pageURL(s.link));
    return undefined;
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
    const b = /** @type {HTMLButtonElement} */ (el('button', { className: `btn btn-sm ${className}`, text: label, attrs: { type: 'button' } }));
    b.disabled = disabled;
    b.addEventListener('click', onClick);
    return b;
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
    /** @type {Discovered} */
    let answer;
    try {
      answer = await host.discover();
    } catch {
      return;
    }
    if (disposed || asked < foundShown) return;
    foundShown = asked;
    found = (answer?.servers || []).filter((x) => x && typeof x.url === 'string' && typeof x.name === 'string');
    firewalled = answer?.firewall === true;
    renderChooser();
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
        outOfDate ? button(t('Reload'), 'btn-secondary', () => window.location.reload()) : null,
      ]));
    } else {
      banner.replaceChildren();
    }

    // The switcher rebuilds only the rows whose content changed, so a click in
    // flight as a poll or the stream redraws it still lands.
    if (listed) {
      loading.remove();
      switcher?.refresh();
    }
    layout();
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
      takeSnapshot({ sessions: list, recents: known });
    } catch (err) {
      unreachable = err instanceof ControlApiError ? err : new ControlApiError(0, extractErrorMessage(err));
      if (!disposed) render();
    }
  }

  /**
   * Show the sessions and recents of a snapshot, as asked for or as the
   * events stream pushed it.
   * @param {{sessions?: Session[]|null, recents?: Partial<import('./control-api.js').Recents>|null}} snapshot
   */
  function takeSnapshot(snapshot) {
    sessions = snapshot.sessions || [];
    recents = {
      paths: snapshot.recents?.paths || [],
      links: snapshot.recents?.links || {},
      waiting: snapshot.recents?.waiting || {},
      used: snapshot.recents?.used || {},
    };
    listed = true;
    unreachable = null;
    if (!disposed) render();
  }

  /**
   * Follow the server's events stream while the page is up, drawing each
   * snapshot it pushes. One that fails or ends is opened again after a wait
   * (EVENTS_RETRY_MIN, doubling to EVENTS_RETRY_MAX), and until it is the
   * poll asks for the sessions as it always has. A page framing another
   * computer's server follows nothing of this one's.
   */
  async function follow() {
    if (framed || !api.events) return;
    stream = new AbortController();
    await followSessionsFeed({
      open: api.events,
      onSnapshot: (snapshot) => {
        streaming = true;
        takeSnapshot(snapshot);
      },
      // The poll covers the sessions until the stream is back.
      onDown: () => { streaming = false; },
      signal: stream.signal,
      sleep,
    });
  }

  /**
   * What the poll asks for: everything refresh does, but the sessions and
   * recents while the events stream brings them.
   * @returns {Promise<void>} Resolves once redrawn.
   */
  async function poll() {
    if (!streaming) return refresh();
    void refreshFound();
    if (exposure) await exposure.refresh();
  }

  /** Poll, then again after pollMs, while the page is shown. */
  function schedule() {
    if (disposed || !pollMs) return;
    timer = setTimeout(async () => {
      timer = null;
      if (!document.hidden) await poll();
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
  // The app's menu commands the page acts on (PAGE_COMMANDS): Open is the
  // switcher's Open folder… — the folder chooser in a desktop window, its path
  // field in a browser — or the framed page's, in a page framing one, which is
  // handed the command at its server's origin alone.
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
    if (e.type === 'juggler:open-project') switcher?.openFolder();
  };
  // ⌘K (Ctrl+K) puts the cursor in the switcher's filter from anywhere on the
  // page, as it brings the switcher up over a project page. With nothing
  // holding the keyboard — focus on the page itself, as after a click on a row
  // or none at all — the list's own keys work it, as its footer says.
  const onSwitcherKey = (/** @type {KeyboardEvent} */ e) => {
    if (!switcher || switcher.el.hidden || e.defaultPrevented) return;
    const mod = isMac() ? e.metaKey : e.ctrlKey;
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      switcher.focus();
      return;
    }
    const unheld = e.target === document.body || e.target === document.documentElement;
    if (unheld && !launchingProject && !releaseChooser) switcher.listKey(e);
  };
  if (switcher) document.addEventListener('keydown', onSwitcherKey);
  for (const type of PAGE_COMMANDS) window.addEventListener(type, onPageCommand);
  if (host) window.addEventListener('juggler:window-close-requested', onCloseRequested);
  // A folder dropped is this machine's, and means nothing to a server framed.
  if (host?.takesDroppedFolders && !framed) window.addEventListener('juggler:folder-dropped', onFolderDropped);
  if (!framed) render();
  void refresh();
  schedule();
  void follow();
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
      stream?.abort();
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('keydown', onSwitcherKey);
      switcher?.destroy();
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('juggler:folder-dropped', onFolderDropped);
      window.removeEventListener('juggler:window-close-requested', onCloseRequested);
      for (const type of PAGE_COMMANDS) window.removeEventListener(type, onPageCommand);
      closeChooser();
    },
  };
}
