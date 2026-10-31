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
 *
 * A running session's whole row opens it, as its Open link does; the link stays
 * the keyboard's way in, so the row adds no second control around the others.
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
import { OPEN_IN_NEW_SVG } from '../js/utils/icons.js';
import { extractErrorMessage, errorText } from '../sdk/lib/error-utils.js';
import { ControlApiError } from './control-api.js';
import { pageURL } from '../js/utils/page-url.js';
import { ExposureView } from '../js/components/connectivity/exposure-view.js';

/** How many recent projects the page offers. */
const RECENTS_SHOWN = 8;

/**
 * @typedef {import('./control-api.js').Session} Session
 * @typedef {import('./control-api.js').PageConfig} PageConfig
 * @typedef {{
 *   listSessions: () => Promise<Session[]>,
 *   openSession: (project: string) => Promise<Session>,
 *   stopSession: (id: string) => Promise<void>,
 *   recents: () => Promise<string[]>,
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
 *   attach: (id: string) => Promise<void>,
 *   answerClose: (token: string) => Promise<void>,
 *   pickDirectory?: () => Promise<string|null>,
 *   takesDroppedFolders?: boolean,
 *   connect?: (address: string) => Promise<void>,
 *   openURL?: (url: string) => void,
 * }} NativeHost
 *   The desktop app (native-host.js). The folder chooser, dropped folders and
 *   Connect are there only in a window on this machine's server. openURL opens
 *   an address in the system browser, which a click on a link to it in the
 *   window's WebView would not.
 */

/**
 * The URL a session is opened at from this page.
 * @param {string} id - The session's ID.
 * @returns {string} Its path, /s/<id>/, or the rendezvous link's address for it.
 */
function sessionUrl(id) {
  return pageURL(`/s/${encodeURIComponent(id)}/`);
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
 * Mount the sessions page into root and load it.
 * @param {HTMLElement} root - Where the page goes.
 * @param {object} options
 * @param {ControlApi} options.api - The control API.
 * @param {PageConfig} options.config - What the server handed the page.
 * @param {(url: string) => void} [options.navigate] - Sends this tab to a page.
 * @param {(message: string) => boolean} [options.confirm] - Asks the user a yes/no question.
 * @param {() => number} [options.now] - The time now, in ms.
 * @param {number} [options.pollMs] - How often to refresh the list (0: never by itself).
 * @param {NativeHost|null} [options.host] - The desktop app whose window shows
 *   the page: a session opens in this window through it. Null in a browser.
 * @param {string} [options.notice] - Something to tell the user as the page
 *   opens: why the window shows this page rather than what it was opened for.
 * @returns {{refresh: () => Promise<void>, dispose: () => void, readonly pending: Promise<void>}} The page:
 *   refresh it now, take it down, or wait for the last switch of a way in to be shown.
 */
export function mountSessionsPage(root, {
  api,
  config,
  navigate = (url) => { window.location.assign(url); },
  confirm = (message) => window.confirm(message),
  now = () => Date.now(),
  pollMs = 2000,
  host = null,
  notice = '',
}) {
  /** @type {Session[]} */
  let sessions = [];
  /** @type {string[]} */
  let recents = [];
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
  const header = el('header', { className: 'ms-header' }, [
    el('div', { className: 'ms-title' }, [
      el('h1', { text: t('Sessions') }),
      el('p', { className: 'ms-subtitle', text: config.host ? t('Juggler on {host}', { host: config.host }) : t('Juggler on this machine') }),
    ]),
    config.version ? el('span', { className: 'ms-version', text: config.version }) : null,
  ]);
  const banner = el('div', { className: 'ms-banner-slot', attrs: { role: 'status' } });

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

  // Session ▸ Connect to Server…: a desktop window on this machine's server
  // becomes a window onto another computer's.
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
  const connectSection = host?.connect
    ? el('section', { className: 'ms-section' }, [
      el('h2', { text: t('Connect to another computer') }),
      el('p', {
        className: 'ms-lan-note',
        text: t('Juggler on another computer on this network, with LAN access turned on there. This window becomes a window onto it.'),
      }),
      connectForm,
      connectError,
    ])
    : null;

  // The machine's ways in, for a viewer on this machine: the two sections are
  // wrappers the layout looks through, so their rows are spaced alike.
  const api0 = /** @type {Required<ControlApi>} */ (api);
  const serverBox = el('div', { className: 'ms-exposure-way' });
  const lanBox = el('div', { className: 'ms-exposure-way' });
  const tunnelBox = el('div', { className: 'ms-exposure-way' });
  serverBox.hidden = true;
  lanBox.hidden = true;
  tunnelBox.hidden = true;
  const exposure = config.local && api.getLAN
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

  root.append(header, banner, sessionsSection, launchSection, folderSection);
  if (exposureSection) root.append(exposureSection);
  if (connectSection) root.append(connectSection);

  /**
   * Show why the app would not connect, or clear it.
   * @param {string} message - The reason ('' clears it).
   */
  function showConnectError(message) {
    connectError.textContent = message;
    connectError.hidden = !message;
  }
  showConnectError('');

  connectForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const address = connectInput.value.trim();
    if (!address || !host?.connect) {
      connectInput.focus();
      return;
    }
    showConnectError('');
    try {
      await host.connect(address);
    } catch (err) {
      showConnectError(err instanceof Error ? errorText(err) : t('Could not connect to that server.'));
    }
  });

  /**
   * Show why a launch failed, or clear it.
   * @param {string} message - The reason ('' clears it).
   */
  function showLaunchError(message) {
    launchError.textContent = message;
    launchError.hidden = !message;
  }
  showLaunchError(notice);

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
   * @param {(message: string) => void} [report] - Where a refusal is shown.
   * @returns {Promise<boolean>} Whether the host took it.
   */
  async function attach(id, report = showLaunchError) {
    if (!host) return false;
    try {
      await host.attach(id);
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
      return await attach(sess.id, report);
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
      navigate(sessionUrl(sess.id));
      await refresh();
      return true;
    } catch (err) {
      report(err instanceof Error ? errorText(err) : t('The session could not be started.'));
      return false;
    }
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
    if (host) void attach(s.id);
    else navigate(sessionUrl(s.id));
  }

  /**
   * A link to a session: this tab in a browser, as a plain link goes; in a
   * desktop window, this window, through the host.
   * @param {Session} s - The session.
   * @param {string} className - The link's classes.
   * @param {Array<Node>} children - What it shows.
   * @returns {HTMLElement} The link.
   */
  function sessionLink(s, className, children) {
    if (!host) {
      return el('a', { className, attrs: { href: sessionUrl(s.id) } }, children);
    }
    const a = el('a', { className, attrs: { href: sessionUrl(s.id) } }, children);
    a.addEventListener('click', (event) => {
      event.preventDefault();
      void attach(s.id);
    });
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

  /**
   * One recent project's row, and its Open.
   * @param {string} project - The folder.
   * @returns {HTMLElement} Its list item.
   */
  function recentRow(project) {
    return el('li', { className: 'ms-recent', attrs: { 'data-project': project } }, [
      el('div', { className: 'ms-recent-main' }, [
        el('div', { className: 'ms-recent-name', text: baseName(project) }),
        el('div', { className: 'ms-path', text: project }),
      ]),
      button(t('Open'), 'ms-button-quiet ms-recent-open', () => { void launch(project); }),
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
    recentsList.hidden = offered.length === 0;
  }

  /**
   * Ask the server for everything the page shows — the sessions, and the
   * machine's ways in with what opens at start, a failure of which leaves
   * them as last shown, since the sessions list says when the server cannot
   * be reached — and redraw.
   * @returns {Promise<void>} Resolves once redrawn.
   */
  async function refresh() {
    await Promise.all([refreshSessions(), exposure ? exposure.refresh() : null]);
  }

  /**
   * Ask the server for the sessions and recent projects, and redraw.
   * @returns {Promise<void>} Resolves once redrawn.
   */
  async function refreshSessions() {
    try {
      const [list, paths] = await Promise.all([api.listSessions(), api.recents()]);
      sessions = list || [];
      recents = paths || [];
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
  // Session ▸ Connect to Server…, which the app dispatches on this window.
  const onConnectServer = () => connectInput.focus();
  if (host) window.addEventListener('juggler:window-close-requested', onCloseRequested);
  if (host?.takesDroppedFolders) window.addEventListener('juggler:folder-dropped', onFolderDropped);
  if (connectSection) window.addEventListener('juggler:connect-server', onConnectServer);
  render();
  void refresh();
  schedule();

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
      window.removeEventListener('juggler:connect-server', onConnectServer);
    },
  };
}
