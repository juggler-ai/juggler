//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Native window-control transport — theme repaint, title, minimise/maximise/
 * close, and "new window". These drive the *native window* that hosts this
 * page, which is not necessarily the server that served it.
 *
 * The only thing that can drive a native window is the desktop app that owns it:
 * it bakes its own loopback control endpoint into the window's URL as the
 * `nativeCtl` query param. A plain browser tab — or any page opened without that
 * param — has no native host, so these calls are no-ops (windowControlURL
 * returns null and callers skip).
 *
 * The value carries the secret that authorises control requests, in its path,
 * so every endpoint built from it carries it too. It must never leave this
 * window: not into a link, a report, or a URL handed to another page.
 *
 * Resolved once at module load — the owner bakes the value into the URL and it
 * never changes for the life of the document.
 */
import { t } from './i18n.js';

const CONTROL_BASE = (() => {
  // The engine worker has no window and is never a native-hosted window, so it
  // has no control endpoint — bail before touching window.location.
  if (typeof window === 'undefined') return null;
  const param = new URL(window.location.href).searchParams.get('nativeCtl');
  // Trailing slash stripped so callers append '/theme' etc. unconditionally.
  return param ? param.replace(/\/+$/, '') : null;
})();

/**
 * The window-control protocol this page speaks: the actions it relies on the
 * app hosting it for. The server's copy is `machineserver.WindowProtocol`,
 * whose comment says what each number adds; the two are kept equal
 * (TestWindowProtocolMatchesThePage).
 */
export const WINDOW_PROTOCOL = 2;

/**
 * What the app hosting this page says of itself, beside `nativeCtl`: its
 * window-control protocol (`ctlProtocol`) and version (`appVersion`). An app
 * that says neither predates both, and speaks protocol 1. Null without a host.
 * @type {{protocol: number, version: string}|null}
 */
const HOST_APP = (() => {
  if (CONTROL_BASE === null) return null;
  const query = new URL(window.location.href).searchParams;
  const protocol = Number.parseInt(query.get('ctlProtocol') || '', 10);
  return { protocol: protocol > 0 ? protocol : 1, version: query.get('appVersion') || '' };
})();

/**
 * The window-control protocol of the app hosting this page: 1 for an app too
 * old to say, 0 for no host (a browser tab).
 * @returns {number} The protocol.
 */
export function hostWindowProtocol() {
  return HOST_APP?.protocol ?? 0;
}

/**
 * The version of the app hosting this page, as it says: '' for an app too old
 * to say, or no host.
 * @returns {string} The version.
 */
export function hostAppVersion() {
  return HOST_APP?.version ?? '';
}

/**
 * Whether the app hosting this page speaks an older window-control protocol
 * than the page: some actions the page posts to it will be refused, and the
 * page falls back on what that app can do and says the app wants updating.
 * False without a host.
 * @returns {boolean} True for an older app.
 */
export function hostIsOlder() {
  return HOST_APP !== null && HOST_APP.protocol < WINDOW_PROTOCOL;
}

/**
 * Whether the app hosting this page is older than project links (protocol
 * 1): it cannot move its window to a session (attach) or to its server's page
 * (server-page), so the page moves the window itself (hostedPageURL).
 * @returns {boolean} True for such an app.
 */
export function hostMovesNoWindow() {
  return HOST_APP !== null && HOST_APP.protocol < 2;
}

/**
 * The address of path on this page's server, as this window's next page:
 * carrying what the app hosting it put in this page's own address — window
 * mode, the control endpoint and what the app says of itself — so the page it
 * loads is still that app's window. Only for this window's own navigation:
 * the control endpoint must never reach another page.
 * @param {string} path - The path on this page's server, with any query.
 * @returns {string} The address.
 */
export function hostedPageURL(path) {
  const target = new URL(path, window.location.href);
  const own = new URL(window.location.href).searchParams;
  for (const key of ['window', 'nativeCtl', 'ctlProtocol', 'appVersion', 'external']) {
    const value = own.get(key);
    if (value !== null && !target.searchParams.has(key)) target.searchParams.set(key, value);
  }
  return target.toString();
}

/**
 * Build the URL for a native window-control endpoint, or null when this page has
 * no native host to control (a browser tab, or any non-app window). Callers must
 * skip the request when this returns null.
 * @param {string} endpoint - 'theme' | 'title' | 'control' | 'new'
 * @param {string} [query] - optional query string including the leading '?'
 * @returns {string|null} the URL to POST to, or null if there is no native host
 */
export function windowControlURL(endpoint, query = '') {
  return CONTROL_BASE ? `${CONTROL_BASE}/${endpoint}${query}` : null;
}

/**
 * POST to a native window-control endpoint — best-effort, one-way, fire-and-
 * forget. A no-op when this page has no native host to control (a browser tab,
 * where windowControlURL returns null). Failures are swallowed: these signals
 * drive the native window and have nothing to recover from.
 * @param {string} endpoint - 'theme' | 'title' | 'attention' | 'open' | ...
 * @param {string} [query] - optional query string including the leading '?'
 * @returns {void}
 */
export function postWindowControl(endpoint, query = '') {
  const url = windowControlURL(endpoint, query);
  if (url) void fetch(url, { method: 'POST' }).catch(() => {});
}

/**
 * Bring this window to the front. Used when something in another window points
 * at this one — a detached pinboard revealing a thread in the conversation,
 * which happens in the window that owns the board, not the one that was clicked.
 *
 * The native host raises the real window; a browser tab can only ask, and a
 * browser that declines to raise a window nobody clicked on is within its
 * rights. Best-effort in both directions, because the reveal itself has already
 * happened either way.
 * @returns {void}
 */
export function raiseThisWindow() {
  const url = windowControlURL('control', '?action=raise');
  if (url) {
    void fetch(url, { method: 'POST' }).catch(() => {});
    return;
  }
  try {
    window.focus();
  } catch {
    // Nothing to recover: the window stays where it is.
  }
}

/**
 * Close the window this page is in. Used when the window has nothing left to
 * show — a detached pinboard whose conversation has been deleted, which is a
 * window onto something that is not there any more.
 *
 * The native host closes the real window. A browser window opened by script can
 * close itself; a tab the user opened cannot, and a browser that refuses is
 * within its rights — so a caller must leave behind a page worth reading rather
 * than treat this as done.
 * @returns {void}
 */
export function closeThisWindow() {
  const url = windowControlURL('control', '?action=close');
  if (url) {
    void fetch(url, { method: 'POST' }).catch(() => {});
    return;
  }
  try {
    window.close();
  } catch {
    // Nothing to recover: the window stays where it is.
  }
}

/**
 * Tell the native host that this page has finished flushing its drafts, so the
 * close/quit it announced may proceed. The host is blocked waiting for this —
 * unlike the other control signals it is a reply, not a command, and the token
 * identifies which announcement it answers so a stale reply can't release a
 * later one.
 *
 * A no-op without a native host (a browser tab has nothing waiting on it, and
 * pagehide covers that case instead). Failures are swallowed: the host bounds
 * its own wait, so a dropped reply costs a timeout, never a hang.
 * @param {string} token - The ackToken from the close-requested event.
 * @returns {Promise<void>}
 */
export async function reportDraftsFlushed(token) {
  const url = windowControlURL('drafts-flushed', `?token=${encodeURIComponent(token)}`);
  if (!url) return;
  try {
    await fetch(url, { method: 'POST' });
  } catch {
    // Nothing to recover: the host times out and quits regardless.
  }
}

/**
 * Hand the native host the paths from a file drop on this window, so it can
 * resolve which project folder they name and announce it back.
 *
 * The paths arrive in the page because that is where the native side delivers
 * them, but only the host can act on them: it holds the filesystem, the other
 * windows, and the recents list. Which of the paths (if any) names a project is
 * the host's decision, not this page's.
 *
 * A no-op without a native host: a browser tab is never told a dropped path in
 * the first place, because WebKit withholds it from the page.
 * @param {string[]} paths - Filesystem paths from the drop, in drop order.
 * @returns {Promise<void>}
 */
export async function reportFolderDropped(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return;
  const query = paths
    .filter((p) => typeof p === 'string' && p !== '')
    .map((p) => `path=${encodeURIComponent(p)}`)
    .join('&');
  if (!query) return;
  const url = windowControlURL('folder-dropped', `?${query}`);
  if (!url) return;
  try {
    await fetch(url, { method: 'POST' });
  } catch {
    // Nothing to recover: a dropped folder that never arrived leaves the
    // window exactly as it was, which is a state the user can see and retry.
  }
}

/**
 * Whether this page is hosted in a native desktop-app window (window-mode) as
 * opposed to a plain browser tab. Reads the `windowMode` document flag the host
 * bakes onto <html>, which drives the browser-tab vs desktop-window UX split
 * (title reporting, dock-bounce vs tab-title badge). Distinct from
 * {@link hasNativeHost}, which reports whether a control endpoint exists.
 * @returns {boolean} True when running as a native desktop-app window.
 */
export function isDesktopWindow() {
  return typeof document !== 'undefined'
    && document.documentElement.dataset.windowMode === '1';
}

/**
 * Whether this page is hosted in a native desktop-app window (as opposed to a
 * plain browser tab). Used to gate native-only affordances like the folder
 * picker's "Browse…" button.
 * @returns {boolean} True when a native control host is present.
 */
export function hasNativeHost() {
  return CONTROL_BASE !== null;
}

/**
 * Ask the native host for a path (desktop app only).
 * @param {string} action - The control action naming which chooser to open.
 * @param {string} [query] - Query string to pass along, e.g. '?title=Pin%20a%20File'.
 * @returns {Promise<string|null>} The chosen path, or null.
 * @private
 */
async function pickPath(action, query = '') {
  const url = windowControlURL(action, query);
  if (!url) return null;
  try {
    const resp = await fetch(url, { method: 'POST' });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data && typeof data.path === 'string' && data.path ? data.path : null;
  } catch {
    return null;
  }
}

/**
 * Open the native folder chooser (desktop app only) and resolve with the chosen
 * absolute path, or null if there is no native host or the user cancelled.
 * @returns {Promise<string|null>} The chosen directory path, or null.
 */
export async function pickDirectory() {
  return pickPath('pick-directory', '?title=' + encodeURIComponent(t('Open project folder')));
}

/**
 * Open the native file chooser (desktop app only) and resolve with the chosen
 * absolute path, or null if there is no native host or the user cancelled.
 *
 * A directory is a valid answer here: everything that asks for a file path — a
 * pin, a context item — takes one, so Browse reaches everything the typed path
 * does.
 * @param {string} [title] - The chooser's title; defaults to the host's.
 * @param {string} [dir] - Absolute path to open in. Without it the chooser opens
 *   wherever this app last was, which for a file in the open project is rarely
 *   the project. A path that is not there is ignored by the host.
 * @returns {Promise<string|null>} The chosen path, or null.
 */
export async function pickFile(title = '', dir = '') {
  const query = new URLSearchParams();
  if (title) query.set('title', title);
  if (dir) query.set('dir', dir);
  const q = query.toString();
  return pickPath('pick-file', q ? `?${q}` : '');
}

/**
 * Save a file to the user's disk.
 *
 * In the desktop app the native host shows its Save dialog, suggesting `name`,
 * and writes the file itself — the WebView does not handle downloads. In a
 * browser, including a remote viewer, the file is downloaded under `name`, and
 * the browser decides where it goes. Either way the bytes go no further than
 * this machine: to the local host, or into a Blob.
 * @param {string} name - The suggested file name.
 * @param {string} content - The file's contents.
 * @param {string} [mime] - Its type, for a browser download.
 * @returns {Promise<string|null>} Where it went — the chosen path in the desktop
 *   app, the file name for a browser download — or null if the user cancelled.
 * @throws {Error} When the desktop host could not save it.
 */
export async function saveFile(name, content, mime = 'text/plain') {
  const url = windowControlURL('save-file', `?${new URLSearchParams({ name })}`);
  if (url) {
    const resp = await fetch(url, { method: 'POST', body: content });
    /** @type {{path?: string, error?: string}|null} */
    const data = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error(data?.error || `Save failed (${resp.status})`);
    return data && typeof data.path === 'string' && data.path ? data.path : null;
  }
  const href = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    // The click starts the download from the URL; revoking it in the same task
    // can cancel that in some engines, so it is left a while first.
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
  }
  return name;
}

/**
 * Top-level domains a scheme-less bare-domain href is recognised by: every
 * two-letter ccTLD (`co.uk`, `example.io`, `example.de`) plus the common
 * generic ones. A dotted first segment ending in anything else — `foo.bar/x`,
 * `v1.2/notes.md` — is a directory, not a host, and stays relative.
 * @type {RegExp}
 */
const KNOWN_TLD =
  /^([a-z]{2}|com|org|net|edu|gov|mil|int|info|biz|dev|app|xyz|tech|online|site|blog|page|cloud|store|shop|news|wiki)$/i;

/**
 * Decide whether a clicked anchor should be opened externally, and with what
 * URL — the safety net for links in rendered markdown (LLM/user/tool output).
 *
 * Two cases must open in the system browser rather than navigate the app's
 * webview off its page:
 *  - An explicit cross-origin `http(s)` link (`[repo](https://github.com/u/r)`).
 *  - A *scheme-less* bare-domain link (`[repo](github.com/u/r)`). marked parses
 *    that as a relative href, so the browser resolves it same-origin
 *    (`http://<app>/github.com/u/r`) — a plain click would tear the app off its
 *    page. We recover the author's intent from the raw href and re-qualify it to
 *    `https://`.
 *
 * Everything else (in-page `#hash`, genuine relative paths, same-origin explicit
 * links, non-web schemes) returns null so the default behaviour is left intact.
 * @param {string} rawHref - The anchor's unresolved `getAttribute('href')`.
 * @param {string} resolvedHref - The anchor's resolved `.href` (absolute).
 * @param {string} [currentOrigin] - Origin to treat as "this app" (defaults to
 *   the current document's origin).
 * @returns {string|null} The URL to open externally, or null to leave the click alone.
 */
export function externalURLFromHref(rawHref, resolvedHref, currentOrigin) {
  const origin = currentOrigin
    ?? (typeof window !== 'undefined' ? window.location.origin : '');
  const trimmed = (rawHref || '').trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  // Scheme-less, non-absolute href: a candidate bare external domain. Only
  // re-qualify when the first segment is a real-looking host — dotted, ending
  // in a known TLD — AND there's a path after it (or a `www.` prefix), so
  // relative paths like `readme.md`, `foo.bar/x` and `v1.2/notes.md` stay
  // relative while `github.com/u/r` and `www.example.com` open externally.
  // Guessing wrong in this direction is the cheap one: a relative path that
  // isn't a real file makes the OS-open op a silent no-op, where a misread
  // directory name would send the user's browser somewhere they never asked for.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  if (!hasScheme && !trimmed.startsWith('/') && !trimmed.startsWith('?')) {
    const firstSeg = trimmed.split(/[/?#]/, 1)[0] || '';
    const host = firstSeg.replace(/:\d+$/, '');
    const labels = host.split('.');
    const looksDomain = labels.length > 1
      && labels.every((label) => /^[a-z0-9-]+$/i.test(label))
      && KNOWN_TLD.test(labels[labels.length - 1] || '');
    const hasPath = trimmed.length > firstSeg.length;
    const isWww = /^www\./i.test(firstSeg);
    return looksDomain && (hasPath || isWww) ? `https://${trimmed}` : null;
  }

  // Explicit scheme (or absolute path): only intercept cross-origin web links.
  let url;
  try {
    url = new URL(resolvedHref);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.origin === origin) return null;
  return resolvedHref;
}

/**
 * Decide whether a clicked anchor points at a *local project file* that should
 * be opened with the host OS's default handler, and return the project-relative
 * path to open — the companion to {@link externalURLFromHref} for the other half
 * of the "an LLM-authored link hijacked my window" problem.
 *
 * Markdown-rendered output (LLM/tool/user) routinely emits relative links to
 * on-disk files, e.g. `[report](.juggler/…/txn_…-context-report.md)`. That
 * anchor is same-origin and scheme-less, so a plain click navigates the webview
 * to `http://<app>/.juggler/…` — a path the server does not serve, so it
 * replaces the whole app with a bare "404 page not found" the user cannot back
 * out of (no browser chrome in a native window). The click handler instead
 * hands the path to the OS-open op, which resolves it against the project
 * working dir (server-side, confined) and opens it like a double-click.
 *
 * Returns the decoded, project-relative path (leading slashes stripped) for a
 * same-origin http(s) navigation that would leave the app's page; null for
 * external links (handled by {@link externalURLFromHref}), in-page `#hash`
 * anchors, non-web schemes, and links back to the app root itself.
 * @param {string} rawHref - The anchor's unresolved `getAttribute('href')`.
 * @param {string} resolvedHref - The anchor's resolved `.href` (absolute).
 * @param {string} [currentOrigin] - Origin to treat as "this app" (defaults to
 *   the current document's origin).
 * @returns {string|null} The project-relative path to open, or null to leave the click alone.
 */
export function localFilePathFromHref(rawHref, resolvedHref, currentOrigin) {
  const origin = currentOrigin
    ?? (typeof window !== 'undefined' ? window.location.origin : '');
  const trimmed = (rawHref || '').trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  // External links (explicit cross-origin, or a scheme-less bare domain like
  // `github.com/u/r`) open in the system browser via externalURLFromHref — they
  // are never local files. Deferring to it keeps the two halves in one source.
  if (externalURLFromHref(rawHref, resolvedHref, origin)) return null;

  let url;
  try {
    url = new URL(resolvedHref);
  } catch {
    return null;
  }
  // Only a same-origin web navigation reaches the app's own server; anything
  // else (mailto:, file:, a cross-origin host) is left to default handling.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.origin !== origin) return null;

  // A link back to the app root itself (or a pure `?query` on the current page)
  // is not a file to open — only a path below the root is.
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  return rel === '' ? null : rel;
}

/**
 * Open a URL outside the current document. A native app window POSTs to its
 * loopback `open` endpoint so WebKit hands the URL to the system browser
 * (target=_blank on a plain `http://<ip>` link is otherwise swallowed by a
 * native WebView); a browser tab — with no native host — opens a new tab.
 * @param {string} url - The URL to open externally.
 */
export function openExternalURL(url) {
  const ctl = windowControlURL('open', `?url=${encodeURIComponent(url)}`);
  if (ctl) {
    void fetch(ctl, { method: 'POST' }).catch(() => {});
    return;
  }
  window.open(url, '_blank', 'noopener');
}
