//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * prefs — where a UI preference is kept, and who it belongs to.
 *
 * Five realms, one function family apiece:
 *
 * | Realm     | Store                                   | Belongs to                     |
 * |-----------|-----------------------------------------|--------------------------------|
 * | `Device`  | localStorage, key scoped by project     | one origin — so one port       |
 * | `Window`  | the session, under this window's role   | one window of one project      |
 * | `Project` | the session, at the top level           | every window of one project    |
 * | `Machine` | settings.json; a remote viewer's own    | the screen, speakers and keys  |
 * |           | copy in its localStorage                | in front of the user           |
 * | `User`    | settings.json                           | this person, in every project, |
 * |           |                                         | on every device                |
 *
 * **Choosing one.** Ask who would be surprised if another client changed it. A
 * preference about the hardware being looked at — sound, the Escape key, how a
 * diff is laid out on this screen — is `Machine`: every desktop window on this
 * computer shares it, and a phone or laptop viewing remotely keeps its own,
 * because muting a phone must not mute the desktop it dialled into. `User` is
 * for what is true of the person whatever they are holding (a tip they have
 * already seen). Geometry is `Window`; what one project's windows should agree
 * on is `Project`.
 *
 * **Why three of them are server-side.** localStorage is partitioned by ORIGIN,
 * and a Juggler window's origin is `http://127.0.0.1:<port>`. The port is not
 * stable: the machine server takes 3939, or the first free port after it when
 * something else is listening there, so it depends on what else was running at
 * its start. A relaunch that lands on a different port hands
 * the window a different — and usually empty — localStorage, and every
 * preference kept there appears to have reverted. Namespacing the KEY cannot
 * help with that; it is the whole STORE that was swapped. Storing server-side
 * can.
 *
 * **What makes an asynchronous store usable at render time.** Every `set` writes
 * the localStorage mirror synchronously as well, and every read of the realm
 * writes what it learns back to it. localStorage stops being the store and
 * becomes a warm cache: `cachedWindowPref` and its siblings answer instantly
 * from it, and `getWindowPref` reconciles when the realm replies. The worst case
 * on a port change is a brief flash of the default instead of a setting silently
 * lost. (services/recent-models.js is the same shape: a synchronous cached read
 * with a refresh behind it.)
 *
 * **Who wins when the two disagree.** In the server's own desktop window (see
 * {@link ownsServerPrefs}) the realm does: it is the store, and the mirror is
 * only a cache of it. In any other viewer the device does, and the realm's value
 * is merely where a device that has never chosen one starts. That covers a phone
 * or laptop over the LAN or a tunnel, and equally the desktop app's own window
 * when the server it is viewing runs on another machine: native or not, what it
 * changes belongs to the computer in front of the user. A remote viewer never
 * writes back: one pinch on a phone would otherwise resize the desktop window it
 * dialled into, and a second remote device would fight the first over one shared
 * value. It sends nothing at all, and the server refuses the session realms'
 * writes anyway (see localViewerOnly in cmd/juggler/server/network.go) — the
 * mirror is that device's store, and it keeps its own copy.
 *
 * The `User` realm is the exception to the paragraph above: settings.json is one
 * document for everyone who can reach the server, its route takes a remote write,
 * so it ranks the same way for every client.
 *
 * The `Machine` realm keeps its values in that same document, in the same `ui`
 * section, but ranks like `Window`. Since its route accepts remote writes, the
 * rule is enforced here: a remote viewer's value never leaves the device. It is
 * kept under a key of its own, so the user realm's mirror writes do not
 * overwrite it.
 *
 * Theme and zoom are machine preferences too, with one difference: they are
 * applied before the page paints (index.html, with the machine's values
 * injected by serveIndex), because a late correction to a root font size
 * reflows everything visibly. So they start from {@link startingMachinePref}
 * rather than waiting for the realm, and reconcile afterwards ({@link reconcilePref}).
 * @module services/prefs
 */

import { fetchJson } from './http.js';
import wsService from './websocket.js';
import { windowRole, WINDOW_ROLE_MAIN } from '../utils/view-mode.js';
import { isDesktopWindow } from '../../sdk/lib/window-control.js';
import { apiUrl } from '../utils/api-url.js';

/**
 * How long a write waits for its neighbours before going to the server.
 *
 * A column drag calls `set` on every pointer move, so an immediate request per
 * call would rewrite the session manifest once a frame. The mirror is still
 * written synchronously — only the request waits — so nothing reading the
 * preference sees the delay.
 */
const WRITE_DELAY_MS = 300;

/** @typedef {'window'|'project'|'user'|'machine'} ServerRealm */

/**
 * Where each server-side realm lives and what its mirror is keyed by.
 *
 * The mirror key follows what the realm is shared by, so the cache is as warm as
 * it can be: a window's is scoped to this project AND this window, a project's
 * to this project, and a user's not at all — the last of which also means the
 * preferences that were already stored under a bare key (tips, the bell) find
 * their own values there on the first frame after an upgrade. A machine
 * preference shares the user's key on the desktop, where the two are one
 * document; a remote viewer's is its own store and gets a key of its own.
 * @type {Record<ServerRealm, {url: () => string, key: (name: string) => string}>}
 */
const REALMS = {
  window: {
    url: () => apiUrl(`/session/ui-prefs?role=${encodeURIComponent(windowRole())}`),
    key: (name) => scopedKey(name),
  },
  project: {
    url: () => apiUrl('/session/ui-prefs?scope=project'),
    key: (name) => (projectKey() ? `${name}:${projectKey()}` : name),
  },
  user: {
    url: () => apiUrl('/settings'),
    key: (name) => name,
  },
  machine: {
    url: () => apiUrl('/settings'),
    key: (name) => (ownsServerPrefs() ? name : `${name}@viewer`),
  },
};

/**
 * Whether this page is the server's own desktop window: a native window on the
 * machine the server runs on, which owns the server-side realms rather than
 * keeping a copy of its own.
 *
 * Being a native window is not enough. The desktop app also opens windows on a
 * server somewhere else (Connect to Server, --url), and those are remote viewers
 * however native they look. The server says which a page is (serveIndex marks a
 * page `data-remote-viewer` by the same test its write guard applies), so the
 * page and the guard cannot disagree.
 * @returns {boolean} True only in a desktop window on the server's own machine.
 */
export function ownsServerPrefs() {
  return isDesktopWindow() && !isRemoteViewer();
}

/**
 * The realm whose server document holds `realm`'s values. Only `machine`
 * borrows: it lives in the user realm's settings document, so the two share one
 * read, one cache and one write queue.
 * @param {ServerRealm} realm
 * @returns {ServerRealm} The realm that owns the document.
 * @private
 */
function home(realm) {
  return realm === 'machine' ? 'user' : realm;
}

/**
 * Whether this page views the server from another machine (serveIndex marks
 * it), so the session realms' routes will refuse its writes.
 * @returns {boolean} True in a viewer on another machine.
 * @private
 */
function isRemoteViewer() {
  return typeof document !== 'undefined' && document.documentElement.dataset.remoteViewer === '1';
}

/**
 * Whether this client keeps its own copy of a preference instead of sharing the
 * desktop's. A machine preference: anywhere but the server's own desktop
 * window, since its route takes anyone's write. A window or project preference:
 * in a viewer on another machine, which the session's routes refuse — a browser
 * tab on the server's own machine still writes them.
 * @param {ServerRealm} realm
 * @returns {boolean} True when this client's value never leaves it.
 * @private
 */
function keepsOwnCopy(realm) {
  if (realm === 'machine') return !ownsServerPrefs();
  if (realm === 'user') return false;
  return isRemoteViewer();
}

/**
 * Each realm's document once read, plus anything written since.
 * @type {Map<ServerRealm, Record<string, any>>}
 */
const documents = new Map();
/**
 * The in-flight (or settled) read per realm, so N callers make one request.
 * @type {Map<ServerRealm, Promise<Record<string, any>>>}
 */
const reads = new Map();
/**
 * Whether the last read of a realm actually reached the server.
 * @type {Map<ServerRealm, boolean>}
 */
const reachable = new Map();
/**
 * The writes waiting to go out, per realm.
 * @type {Map<ServerRealm, {patch: Record<string, any>, timer: any, promise: Promise<void>, resolve: () => void}>}
 */
const writes = new Map();
/**
 * The whole global settings document, as last read or broadcast.
 *
 * The `user` realm's URL *is* the settings document, of which this module owns one
 * section (`ui`). Keeping the rest of it rather than discarding it is what lets
 * the settings panel — which reads the other sections — share this module's single
 * fetch instead of making its own.
 * @type {Record<string, any>|null}
 */
let settingsDoc = null;
/**
 * Who to tell when the whole document changes.
 * @type {Set<(settings: Record<string, any>) => void>}
 */
const settingsWatchers = new Set();

/**
 * Which CustomEvent announces each realm preference, keyed `realm:name`.
 *
 * Nothing registers here on purpose: the entries are learned from the
 * {@link reconcilePref} call every manager already makes at boot, which names its
 * preference and its event in one breath. That is what lets
 * {@link adoptUserRealmDocument} announce a preference changed in another window
 * without this module knowing what any of them are for.
 * @type {Map<string, string>}
 */
const announcements = new Map();

/**
 * This project's storage key, as the server injected it into the page.
 * @returns {string} The key, or '' on a page the server injected none into.
 * @private
 */
function projectKey() {
  return (typeof window === 'undefined' ? '' : window.__projectKey) || '';
}

/**
 * Namespace a localStorage key by the loaded project, and by this window when it
 * is not the ordinary one.
 *
 * The page origin identifies the machine server, not a project: every session
 * it runs is served from that one origin under /s/<id>/, and a viewer arriving
 * over the studio relay sees a single origin for every project on every machine
 * it connects to. Unnamespaced, this project would read whatever another one
 * left behind. The server injects the key pre-paint; a page with none
 * falls back to the bare key.
 *
 * A detached board is its own window with its own appearance, but localStorage
 * is shared by every document on the origin — so a board gets its role appended
 * and the Juggler shell keeps the plain key.
 * @param {string} base - The unscoped key, e.g. 'juggler-zoom'.
 * @returns {string} The key to read and write.
 */
export function scopedKey(base) {
  const key = projectKey();
  const scoped = key ? `${base}:${key}` : base;
  const role = windowRole();
  return role === WINDOW_ROLE_MAIN ? scoped : `${scoped}@${role}`;
}

/**
 * Resolve which stored value a freshly-opened page should adopt.
 *
 * The window-scoped hints (a mode carried across a same-window reload, a seed
 * the native host baked into the URL of a window it opened) keep their middle
 * position either way; what flips is which store bookends them — the project's
 * session in a desktop window, this device's own in a remote browser. The hints
 * are all absent in a remote browser anyway, since only the native host creates
 * them, so the two orders differ exactly where they should.
 *
 * Every source is either a usable value or null; the first usable one wins.
 * @param {object} sources - Candidate values, each already validated or null.
 * @param {boolean} sources.desktop - True in a native desktop window.
 * @param {any} sources.session - The server-side value for this client.
 * @param {any} sources.device - This device's stored value (localStorage).
 * @param {any[]} [sources.windowScoped] - Window-scoped hints, best first.
 * @param {any} [sources.fallback] - Returned when nothing is stored anywhere.
 * @returns {any} The value to adopt.
 */
export function resolvePref({ desktop, session, device, windowScoped = [], fallback = null }) {
  const ordered = desktop
    ? [session, ...windowScoped, device]
    : [device, ...windowScoped, session];
  return ordered.find((value) => value !== null && value !== undefined) ?? fallback;
}

/**
 * Where a machine preference that is applied before first paint starts, and
 * whether this window should store that value as its own.
 *
 * The theme and the zoom resolve synchronously from what the page was handed —
 * the server-injected machine value, the hints the native host baked into the
 * URL, this device's cache — so they cannot wait for the machine realm.
 * This is the rule they share, and index.html's pre-paint block mirrors it:
 *
 *   - A value of the client's own wins: the machine's, in the server's own
 *     window; this device's copy, in any other viewer.
 *   - Otherwise a value handed to this window (an inherited seed, and in the
 *     server's own window whatever this origin's cache holds) is used and
 *     stored, so the machine — or the device — has one from now on. The plain
 *     default never is: stored, it would read as a choice nobody made.
 *   - Otherwise a viewer on another machine starts from the host's value but
 *     does not keep it, so it follows the host until the user chooses.
 * @param {object} sources - Candidate values, each already validated or null.
 * @param {boolean} sources.owner - True in the server's own desktop window
 *   ({@link ownsServerPrefs}).
 * @param {any} sources.machine - The machine realm's value, as injected.
 * @param {any[]} [sources.inherited] - Values handed to this window, best first.
 * @param {any} sources.device - This device's cached value.
 * @param {any} sources.fallback - The default.
 * @returns {{value: any, adopt: boolean}} The value to start from, and whether
 *   to store it.
 */
export function startingMachinePref({ owner, machine, inherited = [], device, fallback }) {
  /**
   * @param {any} v
   * @returns {boolean} Whether v is a value.
   */
  const known = (v) => v !== null && v !== undefined;
  const own = owner ? machine : device;
  if (known(own)) return { value: own, adopt: false };
  const handed = (owner ? [...inherited, device] : inherited).find(known);
  if (known(handed)) return { value: handed, adopt: handed !== fallback };
  if (!owner && known(machine)) return { value: machine, adopt: false };
  return { value: fallback, adopt: false };
}

/**
 * Best-effort broadcast of a named UI-pref change on `window`, so live views can
 * re-sync without waiting for an unrelated render.
 * @param {string} eventName - The CustomEvent name to dispatch.
 * @returns {void}
 */
export function notifyPrefChanged(eventName) {
  try {
    window.dispatchEvent(new CustomEvent(eventName));
  } catch {
    /* no window / CustomEvent — nothing to notify */
  }
}

/**
 * Read a JSON value out of a Web Storage area, tolerant of a missing or corrupt
 * one.
 * @param {Storage|null} store
 * @param {string} key
 * @param {any} fallback
 * @returns {any} The parsed value, or `fallback`.
 * @private
 */
function readStore(store, key, fallback) {
  try {
    const raw = JSON.parse((store && store.getItem(key)) || 'null');
    return raw === null ? fallback : raw;
  } catch {
    return fallback;
  }
}

/**
 * Write a JSON value into a Web Storage area, best-effort: a full or
 * unavailable store just means this value is not remembered.
 * @param {Storage|null} store
 * @param {string} key
 * @param {any} value
 * @returns {void}
 * @private
 */
function writeStore(store, key, value) {
  try {
    if (store) store.setItem(key, JSON.stringify(value));
  } catch {
    /* best-effort */
  }
}

/**
 * This device's value for a preference — meaning this origin's, which is to say
 * this port's. Also the store the three server-side realms mirror into, so a
 * preference and its mirror share one cell by design.
 * @param {string} name - The preference name.
 * @param {any} [fallback] - Returned when nothing is stored.
 * @returns {any} The stored value, or `fallback`.
 */
export function getDevicePref(name, fallback = null) {
  return readStore(typeof localStorage === 'undefined' ? null : localStorage, scopedKey(name), fallback);
}

/**
 * Store a preference against this device.
 * @param {string} name - The preference name.
 * @param {any} value - Any JSON-serialisable value.
 * @returns {void}
 */
export function setDevicePref(name, value) {
  writeStore(typeof localStorage === 'undefined' ? null : localStorage, scopedKey(name), value);
}

/**
 * Read one realm's mirror, falling back to the bare, unscoped key.
 *
 * That fallback is the migration path: every preference moved into a realm was
 * stored under its bare name before, so a value left behind by an older build is
 * found once and promoted by {@link getRealmPref}. Nothing is deleted, and it
 * only ever reaches the origin the user happens to boot on — a value stranded in
 * another port's store is unreachable, because a page cannot enumerate other
 * origins. A remote viewer's machine preference has no such past: its bare key
 * is the user realm's mirror of the desktop's value, not a choice of its own.
 * @param {ServerRealm} realm
 * @param {string} name
 * @returns {any} The mirrored value, or null.
 * @private
 */
function readMirror(realm, name) {
  const store = typeof localStorage === 'undefined' ? null : localStorage;
  const key = REALMS[realm].key(name);
  const mirrored = readStore(store, key, null);
  if (mirrored !== null) return mirrored;
  return key === name || realm === 'machine' ? null : readStore(store, name, null);
}

/**
 * @param {ServerRealm} realm
 * @param {string} name
 * @param {any} value
 * @returns {void}
 * @private
 */
function writeMirror(realm, name, value) {
  writeStore(typeof localStorage === 'undefined' ? null : localStorage, REALMS[realm].key(name), value);
}

/**
 * Fetch one realm's whole document, once. Every preference in a realm arrives in
 * the same reply, so a page hydrates all of them for one round trip however many
 * managers ask.
 *
 * A realm that cannot be reached reads as empty rather than as an error: the
 * mirror then carries the answer, which is the same degradation a remote viewer
 * lives in permanently.
 * @param {ServerRealm} realm
 * @returns {Promise<Record<string, any>>} The realm's stored preferences.
 * @private
 */
function readRealm(realm) {
  let pending = reads.get(realm);
  if (!pending) {
    pending = fetchJson(REALMS[realm].url(), { fallback: null }).then((doc) => {
      reachable.set(realm, !!doc);
      // The user realm reads the settings document, and this module owns only its
      // `ui` section; the rest is kept for whoever asks via getGlobalSettings.
      if (realm === 'user' && doc) settingsDoc = doc;
      const stored = doc && typeof doc.ui === 'object' && doc.ui ? doc.ui : {};
      // Anything written while the read was in flight is newer than what came
      // back, so it stays on top.
      const merged = { ...stored, ...(documents.get(realm) || {}) };
      documents.set(realm, merged);
      // A viewer keeping its own copy holds its own values in these cells; the
      // realm's are only where it starts, so they must not overwrite them.
      if (!keepsOwnCopy(realm)) {
        for (const [name, value] of Object.entries(stored)) writeMirror(realm, name, value);
      }
      return merged;
    });
    reads.set(realm, pending);
  }
  return pending;
}

/**
 * @param {ServerRealm} realm
 * @param {string} name
 * @param {any} fallback
 * @returns {Promise<any>} The value this client should use.
 * @private
 */
async function getRealmPref(realm, name, fallback) {
  const device = readMirror(realm, name);
  const stored = await readRealm(home(realm));
  const value = stored[name] === undefined ? null : stored[name];
  // The user realm is one document for every client that can reach it, so there
  // is no device-first ordering to apply; the other three are the desktop's own.
  const desktop = realm === 'user' || ownsServerPrefs();

  // Nothing in the realm but something on this device: a value an older build
  // left in localStorage. Adopt it and write it up, so the next launch — on
  // whatever port — finds it in the realm. One way, and only once, since the
  // write puts it in this realm's document too.
  if (desktop && value === null && device !== null && reachable.get(home(realm))) {
    void setRealmPref(realm, name, device);
    return device;
  }
  // Only a stored value is mirrored. The fallback is the caller's default:
  // mirrored, the next read would find it on this device with nothing in the
  // realm, adopt it above as an older build's value and write it up.
  const known = resolvePref({ desktop, session: value, device });
  if (desktop && known !== null && known !== undefined) writeMirror(realm, name, known);
  return known ?? fallback;
}

/**
 * @param {ServerRealm} realm
 * @param {string} name
 * @param {any} fallback
 * @returns {any} What is known about this preference right now.
 * @private
 */
function cachedRealmPref(realm, name, fallback) {
  const stored = documents.get(home(realm));
  // A null reads as "not stored", here and everywhere else: it is what a
  // forgotten preference leaves behind, and what a corrupt one degrades to.
  const value = stored && stored[name] !== undefined && stored[name] !== null ? stored[name] : null;
  const mirrored = readMirror(realm, name);
  // A remote viewer's own copy outranks the desktop's, which is only where a
  // viewer that has never chosen starts.
  if (keepsOwnCopy(realm)) return mirrored ?? value ?? fallback;
  if (value !== null) return value;
  return mirrored === null ? fallback : mirrored;
}

/**
 * @param {ServerRealm} realm
 * @param {string} name
 * @param {any} value
 * @returns {Promise<void>} Resolves once the write has reached the server (or
 *   been refused, which is a remote viewer's ordinary state).
 * @private
 */
function setRealmPref(realm, name, value) {
  writeMirror(realm, name, value);
  // The settings route takes a remote write, so for the machine realm it is
  // this check, not the server, that keeps a phone's choice off the desktop.
  // The session realms' routes would refuse it; there is no point asking.
  if (keepsOwnCopy(realm)) return Promise.resolve();
  const doc = home(realm);
  const stored = documents.get(doc) || {};
  stored[name] = value;
  documents.set(doc, stored);
  return queueWrite(doc, name, value);
}

/**
 * @param {ServerRealm} realm
 * @param {string} name
 * @param {any} value
 * @returns {Promise<void>} Resolves when the batch this joined has been sent.
 * @private
 */
function queueWrite(realm, name, value) {
  let batch = writes.get(realm);
  if (!batch) {
    /** @type {() => void} */
    let resolve = () => {};
    const promise = new Promise((r) => { resolve = /** @type {() => void} */ (r); });
    batch = { patch: {}, timer: null, promise, resolve };
    writes.set(realm, batch);
  }
  batch.patch[name] = value;
  if (batch.timer) clearTimeout(batch.timer);
  batch.timer = setTimeout(() => { void flushRealm(realm); }, WRITE_DELAY_MS);
  return batch.promise;
}

/**
 * Send one realm's waiting writes as a single partial update.
 * @param {ServerRealm} realm
 * @returns {Promise<void>} Resolves when the request has settled.
 * @private
 */
async function flushRealm(realm) {
  const batch = writes.get(realm);
  if (!batch) return;
  writes.delete(realm);
  if (batch.timer) clearTimeout(batch.timer);
  // A refusal (a remote viewer's 403) and a failure are the same thing here:
  // this device keeps its own copy in the mirror either way.
  await fetchJson(REALMS[realm].url(), { method: 'PUT', body: { ui: batch.patch }, fallback: null });
  batch.resolve();
}

/**
 * Send everything waiting, whatever its timer says.
 * @returns {void}
 * @private
 */
function flushAll() {
  for (const realm of [...writes.keys()]) void flushRealm(/** @type {ServerRealm} */ (realm));
}

// The global settings document enters this window here, and only here. Every
// project's server shares one settings.json, so a change made in another window —
// or by another project's server — arrives as a broadcast carrying the whole
// document; a reconnect re-reads it, because nothing could have been delivered
// while the socket was down. Owning the subscription next to the cache is what
// keeps "what are the settings now" a question with one answer. Both
// subscriptions are page-lifetime and never released, by design: the cache they
// feed lives as long as the page.
if (typeof window !== 'undefined') {
  wsService.on('settings-changed', (/** @type {any} */ settings) => {
    adoptGlobalSettings(settings || {});
  });
  // Only a RE-connect re-reads. The first open is this page connecting, when the
  // document is either just-read or about to be: re-reading then is a second
  // request for bytes we have, and its reply can land on top of a newer one and
  // put the window back in the past. A later open means the socket was down, and
  // anything that changed during that gap was never delivered.
  let socketHasOpened = false;
  wsService.on('open', () => {
    if (!socketHasOpened) {
      socketHasOpened = true;
      return;
    }
    void resyncGlobalSettings();
  });
}

// A page being hidden or torn down may not come back, so anything still waiting
// on its timer goes now. This is best-effort by nature: a request started as the
// page closes is not guaranteed to finish, which is the reason the delay is
// short and the mirror is written first.
if (typeof document !== 'undefined') {
  window.addEventListener('pagehide', flushAll);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAll();
  });
}

/**
 * This window's value for a preference, reconciled with the realm.
 * @param {string} name - The preference name.
 * @param {any} [fallback] - Returned when nothing is stored anywhere.
 * @returns {Promise<any>} The value this window should use.
 */
export function getWindowPref(name, fallback = null) {
  return getRealmPref('window', name, fallback);
}

/**
 * Store a preference for this window of this project. A null forgets it.
 * @param {string} name - The preference name.
 * @param {any} value - Any JSON-serialisable value, or null to forget it.
 * @returns {Promise<void>} Resolves when the write has been sent.
 */
export function setWindowPref(name, value) {
  return setRealmPref('window', name, value);
}

/**
 * This window's value as it is known right now, without waiting for the realm —
 * for a read on the render path. Reconcile with {@link getWindowPref}.
 * @param {string} name - The preference name.
 * @param {any} [fallback] - Returned when nothing is known yet.
 * @returns {any} The cached value, or `fallback`.
 */
export function cachedWindowPref(name, fallback = null) {
  return cachedRealmPref('window', name, fallback);
}

/**
 * Store a preference for every window of this project. A null forgets it.
 * @param {string} name - The preference name.
 * @param {any} value - Any JSON-serialisable value, or null to forget it.
 * @returns {Promise<void>} Resolves when the write has been sent.
 */
export function setProjectPref(name, value) {
  return setRealmPref('project', name, value);
}

/**
 * This project's value as it is known right now. See {@link cachedWindowPref}.
 * @param {string} name - The preference name.
 * @param {any} [fallback] - Returned when nothing is known yet.
 * @returns {any} The cached value, or `fallback`.
 */
export function cachedProjectPref(name, fallback = null) {
  return cachedRealmPref('project', name, fallback);
}

/**
 * This person's value for a preference, in every project.
 * @param {string} name - The preference name.
 * @param {any} [fallback] - Returned when nothing is stored anywhere.
 * @returns {Promise<any>} The value to use.
 */
export function getUserPref(name, fallback = null) {
  return getRealmPref('user', name, fallback);
}

/**
 * Store a preference against this person, for every project. A null forgets it.
 * @param {string} name - The preference name.
 * @param {any} value - Any JSON-serialisable value, or null to forget it.
 * @returns {Promise<void>} Resolves when the write has been sent.
 */
export function setUserPref(name, value) {
  return setRealmPref('user', name, value);
}

/**
 * This person's value as it is known right now. See {@link cachedWindowPref}.
 * @param {string} name - The preference name.
 * @param {any} [fallback] - Returned when nothing is known yet.
 * @returns {any} The cached value, or `fallback`.
 */
export function cachedUserPref(name, fallback = null) {
  return cachedRealmPref('user', name, fallback);
}

/**
 * Store a preference for the machine this client is running on. From a desktop
 * window it reaches every desktop window on this computer; from a remote viewer
 * it stays on that device. A null forgets it.
 * @param {string} name - The preference name.
 * @param {any} value - Any JSON-serialisable value, or null to forget it.
 * @returns {Promise<void>} Resolves when the write has been sent, or at once in
 *   a remote viewer, which sends nothing.
 */
export function setMachinePref(name, value) {
  return setRealmPref('machine', name, value);
}

/**
 * This machine's value as it is known right now. See {@link cachedWindowPref}.
 * @param {string} name - The preference name.
 * @param {any} [fallback] - Returned when nothing is known yet.
 * @returns {any} The cached value, or `fallback`.
 */
export function cachedMachinePref(name, fallback = null) {
  return cachedRealmPref('machine', name, fallback);
}

/**
 * Read a preference from its realm and announce it if the realm knew something
 * the cache did not.
 *
 * Every manager that answers synchronously needs exactly this at boot: it
 * renders from the cache, and a value that arrives late has to reach the views
 * already on screen. It takes the realm as an argument rather than being one
 * function per realm because the managers differ only in which realm they name.
 * A redundant event is harmless — it is a re-sync signal, not a change record —
 * so the comparison is a plain one rather than anything shape-aware.
 * @param {ServerRealm} realm - The realm the preference lives in.
 * @param {string} name - The preference name.
 * @param {string} eventName - The CustomEvent to fire when it differs.
 * @returns {Promise<any>} The realm's value.
 */
export function reconcilePref(realm, name, eventName) {
  announcements.set(`${realm}:${name}`, eventName);
  const before = JSON.stringify(cachedRealmPref(realm, name, null) ?? null);
  return getRealmPref(realm, name, null).then((value) => {
    if (JSON.stringify(value ?? null) !== before) notifyPrefChanged(eventName);
    return value;
  });
}

/**
 * The whole global settings document, fetched once for this page.
 *
 * Every window shares one settings.json, so the document is read once and then
 * kept current by {@link adoptGlobalSettings} rather than refetched: a reader gets
 * this module's cache, and a change made anywhere arrives over the socket. Callers
 * that want to follow it add themselves with {@link onGlobalSettings}.
 * @returns {Promise<Record<string, any>>} The document, or {} if unreachable.
 */
export async function getGlobalSettings() {
  await readRealm('user');
  return settingsDoc || {};
}

/**
 * Follow the global settings document: `cb` is called with the whole of it every
 * time it changes.
 * @param {(settings: Record<string, any>) => void} cb
 * @returns {void}
 */
export function onGlobalSettings(cb) {
  settingsWatchers.add(cb);
}

/**
 * Stop following the global settings document.
 * @param {(settings: Record<string, any>) => void} cb
 * @returns {void}
 */
export function offGlobalSettings(cb) {
  settingsWatchers.delete(cb);
}

/**
 * Adopt a settings document the server has published: fold its `ui` section into
 * this module's cache and hand the whole of it to everything following it.
 *
 * The one place a new document enters this window, whichever section of it moved.
 * Before this existed the `ui` prefs and the settings panel each subscribed to the
 * same broadcast and kept their own copy, which is two answers to "what are the
 * settings now" and no guarantee they agreed.
 * @param {Record<string, any>} doc - The whole settings document.
 * @returns {string[]} The `ui` preference names whose value changed here.
 */
export function adoptGlobalSettings(doc) {
  const settings = doc && typeof doc === 'object' ? doc : {};
  settingsDoc = settings;
  const changed = adoptUserPrefs(settings.ui || {});
  for (const cb of settingsWatchers) {
    try {
      cb(settings);
    } catch (err) {
      // One bad follower must not stop the others being told.
      console.error('[Juggler] a settings watcher threw:', err);
    }
  }
  return changed;
}

/**
 * Re-read the settings document from the server and adopt it.
 *
 * For a reconnect: while the socket was down no broadcast could arrive, so what
 * this window holds may be old — and the read is memoised for the life of the
 * page, which is what makes asking again a deliberate act rather than a refetch.
 * @returns {Promise<void>} Resolves once the document has been adopted.
 */
export async function resyncGlobalSettings() {
  reads.delete('user');
  const doc = await fetchJson(REALMS.user.url(), { fallback: null });
  if (!doc) return; // unreachable — keep what we have
  reachable.set('user', true);
  reads.set('user', Promise.resolve(documents.get('user') || {}));
  adoptGlobalSettings(doc);
}

/**
 * Adopt the `ui` section of a settings document the server has published, and
 * announce every preference whose value it changes.
 *
 * settings.json is one file for every project's server, and this module reads it
 * exactly once per page: the read is memoised for the life of the window, because
 * a preference store that refetched would be answering render-path reads over the
 * network. That memo is correct for the window that did the writing and wrong for
 * every other one — so instead of invalidating it, the new document is folded into
 * the cache it already resolved. A window therefore converges on a change made
 * somewhere else without a single extra request.
 *
 * Preferences still waiting on their write timer are left alone: they are newer
 * than anything the server can have broadcast, and this is the same precedence
 * {@link readRealm} gives them when a read lands mid-write. A key the document no
 * longer carries was forgotten by whoever wrote it, so it is cleared here too —
 * including the mirror, which would otherwise keep answering with it.
 * @param {Record<string, any>} ui - The document's `ui` section, whole.
 * @returns {string[]} The preference names whose value changed in this window.
 * @private
 */
function adoptUserPrefs(ui) {
  /** @type {ServerRealm} */
  const realm = 'user';
  const incoming = ui && typeof ui === 'object' ? ui : {};
  const pending = writes.get(realm)?.patch || {};
  // Mutated in place rather than replaced: readRealm's memoised promise resolved
  // with this very object, so a fresh one would leave getUserPref answering from
  // the document as it was when the page loaded.
  let doc = documents.get(realm);
  if (!doc) {
    doc = {};
    documents.set(realm, doc);
  }
  /**
   * @param {any} a
   * @param {any} b
   * @returns {boolean} Whether the two are the same stored value.
   */
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  /** @type {string[]} */
  const changed = [];
  const names = new Set([...Object.keys(incoming), ...Object.keys(doc)]);
  for (const name of names) {
    if (name in pending) continue;
    const value = name in incoming ? incoming[name] : null;
    if (same(doc[name], value)) continue;
    doc[name] = value;
    writeMirror(realm, name, value);
    changed.push(name);
  }
  // One event can speak for several preferences (diff-view-prefs has two), so it
  // is fired once however many of its keys moved.
  // A machine preference lives in this document too. A remote viewer holding its
  // own copy is told anyway: the event only asks it to re-sync.
  const events = new Set();
  for (const name of changed) {
    const eventName = announcements.get(`${realm}:${name}`) ?? announcements.get(`machine:${name}`);
    if (eventName) events.add(eventName);
  }
  for (const eventName of events) notifyPrefChanged(eventName);
  return changed;
}

/**
 * Forget every realm read, cached document and waiting write.
 *
 * For tests only, and only because this module deliberately caches for the life
 * of the page: a suite that stands in for the server has to be able to start
 * each case from nothing.
 * @returns {void}
 */
export function __resetPrefsForTests() {
  for (const batch of writes.values()) {
    if (batch.timer) clearTimeout(batch.timer);
    batch.resolve();
  }
  writes.clear();
  documents.clear();
  reads.clear();
  reachable.clear();
  settingsDoc = null;
}
