//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Panels a distribution adds to the machine server's sessions page. The
 * machine server lists every module in machine/panels/ of its asset tree in the
 * page's config (pagePanels in machineserver/page.go), and the page's script
 * imports them all as it starts (web/machine/sessions-page.js), waiting on
 * none; each adds itself here with registerPagePanel as it loads, and the page
 * (web/machine/sessions-view.js) gives each one a section of its own in its
 * main column — under the welcome and over the switcher, or at the foot under
 * the switcher (PagePanel.place) — in the order they registered. The stock
 * tree has none.
 *
 * The page hides a panel's section while it has nothing to act on yet (its
 * first list is loading) and while a project opens, and tells the panel, as it
 * changes, which of its two shapes the page has: a first run — nothing open,
 * nothing recent — or a listing. What the panel shows in each, nothing
 * included, is its own.
 *
 * A panel module imports this one by its path in the tree
 * (`../../sdk/lib/page-panels.js` from machine/panels/), so it shares the
 * page's registry. The page has no import map: `juggler/*` specifiers do not
 * resolve on it.
 * @module sdk/lib/page-panels
 */

/** @typedef {'first-run'|'listing'} PanelState */

/**
 * Where on the page a panel's section goes: 'main' under the welcome and over
 * the switcher, 'foot' under the switcher, at the foot of the main column.
 * @typedef {'main'|'foot'} PanelPlace
 */

/**
 * What the page lends a panel as it mounts it.
 * @typedef {object} PanelContext
 * @property {{request?: (method: string, path: string, body?: unknown) => Promise<unknown>}} api -
 *   The machine server's control API, as the page reaches it. request calls
 *   any route under /api/server — a distribution's own there among them
 *   (machineserver.ExtraRoutes) — and answers with the decoded JSON body, or
 *   null for none.
 * @property {{token: string, version?: string, host?: string, local?: boolean, base?: string}} config -
 *   What the server handed the page: local is whether its viewer is on this
 *   machine, which alone may do what a route behind Host.LocalOnly does.
 * @property {object|null} host - The desktop app whose window shows the page;
 *   null in a browser.
 * @property {PanelPrefs} prefs - The panel's own preferences.
 * @property {(options: PanelDialogOptions) => PanelDialog} dialog - Open a
 *   modal dialog over the page, in the app's own dialog chrome, for the panel
 *   to fill.
 */

/**
 * @typedef {object} PanelDialogOptions
 * @property {string} title - The dialog's title, which names it to assistive
 *   technology too.
 * @property {string} [className] - A class for the dialog's panel, for the
 *   panel's own styling of what it puts in it (its width, say).
 * @property {() => void} [onClose] - Called once, however it closed: its close
 *   button, Escape, Back, a click on the scrim behind it, or close().
 */

/**
 * A dialog a panel opened (PanelContext.dialog): a title and close button the
 * page draws, then the panel's own body, which scrolls, over its footer, whose
 * buttons sit at the end. Tab stays in it while it is open.
 * @typedef {object} PanelDialog
 * @property {HTMLElement} body - Where the panel puts what the dialog says.
 * @property {HTMLElement} footer - Where the panel puts the dialog's buttons.
 * @property {() => void} close - Take it down; idempotent.
 * @property {boolean} closed - Whether it has closed.
 */

/**
 * A panel's preferences: Machine-realm ones (shared by every desktop window on
 * this computer; a remote viewer keeps its own), kept apart from every other
 * panel's and the page's by the panel's id.
 * @typedef {object} PanelPrefs
 * @property {(name: string, fallback?: unknown) => unknown} get - The value as
 *   known right now, or fallback while none is.
 * @property {(name: string, value: unknown) => Promise<void>} set - Store any
 *   JSON-serialisable value; null forgets it.
 * @property {(name: string, fn: (value: unknown) => void) => () => void} watch -
 *   Call fn with the value whenever it may have changed: once the realm has
 *   been read, if it knew better than get did, and as it changes elsewhere.
 *   Returns what stops it.
 */

/**
 * What a mounted panel hands back, both parts optional.
 * @typedef {object} PanelHandle
 * @property {(state: PanelState) => void} [layout] - Told the page's shape once
 *   its first list has arrived, and whenever it changes.
 * @property {() => void} [unmount] - Called as the page is taken down.
 */

/**
 * @typedef {object} PagePanel
 * @property {string} id - Names the panel: its section's data-panel, and the
 *   one registration a second of the same id is dropped for.
 * @property {PanelPlace} [place] - Where its section goes; 'main' by default.
 * @property {(container: HTMLElement, context: PanelContext) => PanelHandle|void} mount -
 *   Builds the panel into container, its section. A throw costs the panel
 *   its section and nothing else.
 */

/**
 * Something that hands each panel to fn: every one registered so far at once,
 * and every later one as it registers. Returns what stops it.
 * @typedef {(fn: (panel: PagePanel) => void) => () => void} PanelSource
 */

/** @type {PagePanel[]} */
const panels = [];
/** @type {Set<(panel: PagePanel) => void>} */
const watchers = new Set();

/**
 * Add a panel to the sessions page: to one already mounted, and to every page
 * mounted after.
 * @param {PagePanel} panel - The panel.
 */
export function registerPagePanel(panel) {
  if (panels.some((p) => p.id === panel.id)) return;
  panels.push(panel);
  for (const fn of watchers) fn(panel);
}

/**
 * The registered panels, as a PanelSource: the page's default.
 * @type {PanelSource}
 */
export function watchPagePanels(fn) {
  for (const panel of panels) fn(panel);
  watchers.add(fn);
  return () => { watchers.delete(fn); };
}
