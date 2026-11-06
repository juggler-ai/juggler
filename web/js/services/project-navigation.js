//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Where a project's page goes when the user picks a project, or a
 * conversation in one, from the session switcher (components/session-popover.js),
 * ⇧⌘J or ⌘1–9 ({@link goTo}).
 *
 * A window belongs to a server and shows its page or one of its sessions, so
 * a pick switches the window in place:
 * - This project: the conversation is shown here, landed on as ⌘J lands. A
 *   project has one window, so a new one asked for is this.
 * - A desktop window, on this machine's server or a server by URL: the drafts
 *   typed here go to disk, as for a close, and the app shows the session in
 *   this window (`attach`), which replaces this page — or, when another window
 *   already shows that project, raises that one at the conversation and leaves
 *   this one as it was. A refusal is shown.
 *   Leaving a project this way is closing its window: an idle session retires
 *   once no window shows it, a busy one runs on.
 * - A new window asked for (⌘-click, ⌘↵) on this machine's server: the app
 *   opens one onto the project, or raises the one already on it. A window on a
 *   server by URL may open no window onto a project, so it attaches.
 * - A browser tab: this page goes to the project's link, `?c=` naming the
 *   conversation, as the sessions page's own links go; a new window asked for
 *   is a tab of its own.
 *
 * The page's session and its draft flush are bound once
 * (bindProjectNavigation); a caller names only where to go.
 * @module services/project-navigation
 */

import { t } from '../../sdk/lib/i18n.js';
import { basePath } from '../utils/api-url.js';
import { pageURL } from '../utils/page-url.js';
import { projectsOpenInNewWindow } from '../utils/project-open-mode.js';
import { hasNativeHost } from '../../sdk/lib/window-control.js';
import { revealLinkedConversation } from './conversation-commands.js';
import { uiPort } from './ui-port.js';

/** Dispatched on window by the desktop app when it raises this window at a conversation; detail: {conversation}. */
const OPEN_CONVERSATION_EVENT = 'juggler:open-conversation';

/**
 * @typedef {object} Destination
 * @property {string} link - The project's link, /p/<key>/.
 * @property {string} project - The project's folder.
 * @property {string} [sessionId] - Its session's id on this page's server.
 * @property {string} [conversation] - One of its conversations, or '' for none.
 * @property {boolean} [newWindow] - The user asked for a window of its own (⌘↵, ⌘-click).
 * @typedef {object} AttachTarget
 * @property {string} sessionId - The session's id.
 * @property {string} project - Its project's folder.
 * @property {string} link - Its project's link.
 * @property {string} conversation - The conversation to open it on, or ''.
 * @typedef {object} NavigationDeps
 * @property {any} [session] - This page's session.
 * @property {'tab'|'url'|'local'} [surface] - Where the page is: a browser tab,
 *   a desktop window on a server by URL, or one on this machine's server.
 * @property {string} [ownLink] - This project's link.
 * @property {(session: any, id: string) => Promise<void>} [reveal] - Lands on a conversation as ⌘J does.
 * @property {(url: string) => void} [assign] - Sends this page to an address.
 * @property {(url: string) => void} [openTab] - Opens an address in a tab of its own.
 * @property {(o: {project: string, conversation: string}) => Promise<boolean>} [newWindow] - Has the
 *   app open a window, or raise the one on that project.
 * @property {() => Promise<void>} [flushDrafts] - Puts the drafts typed here on disk.
 * @property {(o: AttachTarget) => Promise<boolean>} [attach] - Has the app show
 *   a session in this window; true when it raised another window instead.
 * @property {(message: string) => void} [showError] - Says why a move was refused.
 */

/** @type {{session: any, flushDrafts: () => Promise<void>}} */
const bound = { session: null, flushDrafts: async () => {} };

/**
 * Bind the page's session and the way to put its drafts on disk, which goTo
 * uses unless told otherwise.
 * @param {{session?: any, flushDrafts?: () => Promise<void>}} parts - Any of them.
 * @returns {void}
 */
export function bindProjectNavigation({ session, flushDrafts }) {
  if (session !== undefined) bound.session = session;
  if (flushDrafts) bound.flushDrafts = flushDrafts;
}

/**
 * Put the drafts typed here on disk, as the page's bound flush does.
 * @returns {Promise<void>} Resolves once they are.
 */
export function flushBoundDrafts() {
  return bound.flushDrafts();
}

/**
 * Where this page is.
 * @returns {'tab'|'url'|'local'} A browser tab (a rendezvous link's page too),
 *   a desktop window on a server by URL, or one on this machine's server.
 */
export function navigationSurface() {
  if (!hasNativeHost()) return 'tab';
  return projectsOpenInNewWindow() ? 'local' : 'url';
}

/**
 * This project's link, /p/<key>/, as the machine server lists it.
 * @returns {string} The link.
 */
export function ownProjectLink() {
  return `${basePath()}/`;
}

/**
 * Have the app open a window onto a project at a conversation, or raise the
 * one already on it.
 * @param {{project: string, conversation: string}} o - Which.
 * @returns {Promise<boolean>} True when it raised one.
 */
async function appWindow(o) {
  const { default: apiService } = await import('./api.js');
  return await apiService.newWindow(o);
}

/**
 * Have the app show a session in this window.
 * @param {AttachTarget} o - Which.
 * @returns {Promise<boolean>} True when it raised another window instead.
 */
async function appAttach(o) {
  const { default: apiService } = await import('./api.js');
  return await apiService.attachWindow(o);
}

/**
 * Say why a move was refused, as a notice; the console when no UI is mounted.
 * @param {string} message - Why.
 * @returns {void}
 */
function noticeError(message) {
  const port = uiPort();
  if (port) port.notice(message);
  else console.warn(message);
}

/**
 * Go to a project, or a conversation in one.
 * @param {Destination} to - Where.
 * @param {NavigationDeps} [deps] - How; the page's own by default.
 * @returns {Promise<void>} Resolves once gone, or asked for.
 */
export async function goTo(to, deps = {}) {
  const {
    session = bound.session,
    surface = navigationSurface(),
    ownLink = ownProjectLink(),
    reveal = revealLinkedConversation,
    assign = (url) => { window.location.assign(url); },
    openTab = (url) => { window.open(url, '_blank', 'noopener'); },
    newWindow = appWindow,
    flushDrafts = bound.flushDrafts,
    attach = appAttach,
    showError = noticeError,
  } = deps;
  const conversation = to.conversation || '';

  if (to.link === ownLink) {
    if (!conversation || !session?.conversations?.has(conversation)) return;
    session.switchConversation(conversation);
    await reveal(session, conversation);
    return;
  }

  if (surface === 'tab') {
    const url = pageURL(conversation ? `${to.link}?c=${encodeURIComponent(conversation)}` : to.link);
    if (to.newWindow) openTab(url);
    else assign(url);
    return;
  }

  // This window stays as it is: nothing to flush.
  if (to.newWindow && surface === 'local') {
    await newWindow({ project: to.project, conversation });
    return;
  }

  await flushDrafts();
  try {
    // Answers whether another window was raised; otherwise this page is on
    // its way out, replaced by the session's.
    await attach({ sessionId: to.sessionId || '', project: to.project, link: to.link, conversation });
  } catch (err) {
    showError(err instanceof Error ? err.message : t('Could not open that project'));
  }
}

/**
 * Have the app show this window's server's page in it.
 * @returns {Promise<void>} Resolves once the app has taken it.
 */
async function appServerPage() {
  const { default: apiService } = await import('./api.js');
  await apiService.showServerPage();
}

/**
 * Show this window's server's page in it, in place of the session it showed:
 * where a window goes once that session is stopped from its switcher, since
 * it has nothing else to show. The drafts are the caller's to have put on disk
 * first, while the session could still take them. A desktop window has the
 * app show the page in place, saying why if it will not; a browser tab goes
 * to the page.
 * @param {NavigationDeps & {serverPage?: () => Promise<void>}} [deps] - How;
 *   the page's own by default.
 * @returns {Promise<void>} Resolves once gone, or asked for.
 */
export async function moveToServerPage(deps = {}) {
  const {
    surface = navigationSurface(),
    assign = (url) => { window.location.assign(url); },
    serverPage = appServerPage,
    showError = noticeError,
  } = deps;
  if (surface === 'tab') {
    assign(pageURL('/'));
    return;
  }
  try {
    await serverPage();
  } catch (err) {
    showError(err instanceof Error ? err.message : t('Could not show the server page'));
  }
}

/**
 * Land on a conversation the desktop app named when it raised this window
 * ({@link OPEN_CONVERSATION_EVENT}): a pick of this project made in another
 * window, which goes to this one rather than to a second window onto it.
 * @param {EventTarget} [target] - Where the app dispatches it.
 * @returns {() => void} Stops listening.
 */
export function listenForOpenConversation(target = window) {
  /** @param {Event} event */
  const onOpen = (event) => {
    const id = /** @type {CustomEvent} */ (event).detail?.conversation;
    if (typeof id !== 'string' || !id) return;
    void goTo({ link: ownProjectLink(), project: bound.session?.projectPath || '', conversation: id });
  };
  target.addEventListener(OPEN_CONVERSATION_EVENT, onOpen);
  return () => target.removeEventListener(OPEN_CONVERSATION_EVENT, onOpen);
}
