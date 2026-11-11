//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The session switcher over a project page: a popover dropped under the
 * project chip, which is its button. Switching is frequent and must be
 * instant, so it comes two ways.
 *
 * **⌘K is the hold-to-cycle gesture**, as Ctrl+Tab walks the conversations
 * (recent-tab-switcher.js), on the shared {@link HoldToCycleController}. The
 * first press shows the list as a HUD with this window's row lit. Each further
 * K while ⌘ is held lights the next row the walk takes (cycleOrder: this
 * window, the open sessions by use, then Recent); letting go of ⌘ goes to the
 * lit row; Escape changes nothing, and a later release does nothing either; a
 * click picks a row. Nothing can be typed while ⌘ is held, so the HUD's
 * filter waits for the keyboard. Letting go having pressed K only once moves
 * nothing: the HUD settles into the list a click on the chip opens, its
 * filter taking the keyboard where it already stands.
 *
 * **A click on the chip opens the same list to stay**, lit on this window: the
 * filter has the keyboard, and Escape or a click outside leaves the window
 * exactly where it was. The chip is part of the window's drag region too, and
 * the click that ends a window drag by it opens nothing (drag-guard.js).
 * Nothing navigates until something is picked — the
 * machine server retires an idle session about 10 s after its last viewer
 * leaves, so a switcher that moved the window to look would end the project it
 * came from.
 *
 * A pick moves this window in place (project-navigation's goTo), or raises the
 * window already on that project. A recent project, or a failed session
 * retried, is opened first through this page's session (the relay of the
 * machine server's control API): its row says Starting… until it runs, and
 * Escape meanwhile leaves the window where it was. Stopping this window's own
 * session moves the window to its server's page, since there is nothing else
 * for it to show. A browser tab goes to a project's link instead, which opens
 * the project itself.
 * @module components/session-popover
 */

import HoldToCycleController, { popupAwareShouldHandle } from '../services/hold-to-cycle.js';
import { isMac } from '../services/key-shortcut-manager.js';
import { registerOpenPopup } from '../utils/popup-manager.js';
import { dragGuard } from '../utils/drag-guard.js';
import { machineFeed } from '../services/machine-feed.js';
import {
  goTo, moveToServerPage, navigationSurface, ownProjectLink, flushBoundDrafts,
} from '../services/project-navigation.js';
import { pickDirectory } from '../../sdk/lib/window-control.js';
import { uiPort } from '../services/ui-port.js';
import { t } from '../../sdk/lib/i18n.js';
import { SessionSwitcher } from './session-switcher.js';

/** The popup id the popover registers under, and its gesture allows. */
export const SESSION_SWITCHER_POPUP_ID = 'session-switcher';

/** Room kept between the popover and the window's edges, in px. */
const EDGE = 16;

/** The popover's widest, in px (36rem). */
const MAX_WIDTH = 576;

/**
 * Where the popover stands: under the chip, left-aligned with it (less the
 * rows' inset, so their text lines up with the chip's), and kept inside the
 * window, narrowed to fit it.
 * @param {{chipLeft: number, chipBottom: number, viewportWidth: number}} o - The chip's
 *   left and bottom edges and the window's width, in px.
 * @returns {{left: number, top: number, width: number}} Its place and width, in px.
 */
export function placePopover({ chipLeft, chipBottom, viewportWidth }) {
  const width = Math.min(MAX_WIDTH, viewportWidth - 2 * EDGE);
  const left = Math.max(EDGE, Math.min(chipLeft - 8, viewportWidth - width - EDGE));
  return { left, top: chipBottom + 6, width };
}

/**
 * What the popover works with: the page's own by default (createSessionPopover).
 * @typedef {object} PopoverDeps
 * @property {HTMLElement} chip - The project chip, which is its button.
 * @property {{sessions: any[], recents: any, subscribe: (fn: () => void) => () => void}} feed - The machine's sessions.
 * @property {string} ownLink - This window's session's link.
 * @property {'tab'|'url'|'local'} surface - Where the page is (project-navigation's).
 * @property {(to: import('../services/project-navigation.js').Destination) => Promise<void>} go - Moves this window.
 * @property {(project: string) => Promise<any>} open - Opens a project's session and waits for it.
 * @property {(id: string) => Promise<void>} stop - Stops a session, or dismisses a failed one.
 * @property {(parent: string, name: string) => Promise<string>} createFolder - Makes a folder.
 * @property {() => Promise<string|null>} pickFolder - The app's folder chooser.
 * @property {() => Promise<void>} toServerPage - Moves this window to its server's page.
 * @property {(message: string) => void} showError - Says why something failed.
 * @property {() => Promise<void>} [flushDrafts] - Puts the drafts typed here on disk.
 */

export class SessionPopover {
  /** @param {PopoverDeps} deps */
  constructor(deps) {
    this._deps = deps;
    /** @type {SessionSwitcher|null} */
    this._sw = null;
    /** @type {(() => void)|null} Releases the popup registration. */
    this._release = null;
    /** @type {(() => void)|null} Stops hearing the feed. */
    this._unsubscribe = null;
    /** @type {object|null} The move in flight; null once cancelled. */
    this._move = null;
    this._gesture = false;
    this._controller = new HoldToCycleController({
      shortcutId: 'switch-session',
      modifierKeys: [isMac() ? 'Meta' : 'Control'],
      // Window-wide, standing down for any overlay but its own.
      shouldHandle: popupAwareShouldHandle([SESSION_SWITCHER_POPUP_ID]),
      onGestureStart: () => this._open(true),
      onCycle: () => { this._sw?.step(); },
      onCommit: () => this._commitGesture(),
      onSettle: () => this._open(false),
      onCancel: () => this.close(),
    });
    this._chipDrag = dragGuard();
    this._onChip = (/** @type {MouseEvent} */ e) => {
      // A click from the keyboard (detail 0) follows no press to measure.
      if (e.detail > 0 && this._chipDrag.dragged()) return;
      if (this._sw) this.close();
      else this._open(false);
    };
    this._onOpenProject = (/** @type {Event} */ e) => {
      // The app's Open… (⌘O) while the popover is up is its Open folder….
      e.stopImmediatePropagation();
      this._sw?.openFolder();
    };
    this._onGestureClick = (/** @type {MouseEvent} */ e) => {
      if (!this._gesture || !this._sw) return;
      const row = /** @type {HTMLElement|null} */ ((/** @type {Element} */ (e.target)).closest('.session-switcher-row'));
      if (!row) return;
      e.preventDefault();
      e.stopPropagation();
      // A click is the release, arriving by pointer: the one still to come
      // ends nothing.
      this._sw.select(Number(row.dataset.index), false);
      this._controller.commit();
    };
  }

  /** Listen for ⌘K and the chip. */
  init() {
    const { chip } = this._deps;
    chip.setAttribute('aria-haspopup', 'dialog');
    chip.setAttribute('aria-expanded', 'false');
    chip.addEventListener('pointerdown', this._chipDrag.watch);
    chip.addEventListener('click', this._onChip);
    this._controller.init();
  }

  /** Stop listening, taking the popover down. */
  destroy() {
    this.close();
    this._controller.destroy();
    this._deps.chip.removeEventListener('pointerdown', this._chipDrag.watch);
    this._deps.chip.removeEventListener('click', this._onChip);
  }

  /**
   * Whether the popover is up.
   * @returns {boolean} True while it is.
   */
  get isOpen() {
    return this._sw !== null;
  }

  /**
   * Take the popover down. A move still waiting on its session to start is
   * cancelled with it, unless the popover goes because the move is under way.
   * @param {{keepMove?: boolean}} [o]
   */
  close({ keepMove = false } = {}) {
    if (!keepMove) this._move = null;
    const sw = this._sw;
    if (!sw) return;
    this._sw = null;
    this._gesture = false;
    this._controller.cancel();
    this._unsubscribe?.();
    this._unsubscribe = null;
    const release = this._release;
    this._release = null;
    release?.();
    window.removeEventListener('juggler:open-project', this._onOpenProject, { capture: true });
    sw.el.removeEventListener('click', this._onGestureClick, { capture: true });
    sw.destroy();
    sw.el.remove();
    this._deps.chip.setAttribute('aria-expanded', 'false');
  }

  /**
   * Put the popover up — as the gesture's HUD, or to stay — or, already up,
   * show it the other way.
   * @param {boolean} gesture - Whether ⌘ is held.
   * @private
   */
  _open(gesture) {
    if (!this._sw) {
      const { feed, ownLink, surface, chip } = this._deps;
      const sw = new SessionSwitcher({
        mode: 'popover',
        source: () => ({ sessions: feed.sessions, recents: feed.recents, ownLink }),
        actions: this._actions(),
        canPickFolder: surface === 'local',
        inApp: surface !== 'tab',
      });
      sw.el.setAttribute('role', 'dialog');
      sw.el.setAttribute('aria-label', t('Switch session'));
      sw.el.addEventListener('click', this._onGestureClick, { capture: true });
      document.body.append(sw.el);
      this._sw = sw;
      this._place();
      this._unsubscribe = feed.subscribe(() => { this._sw?.refresh(); });
      this._release = registerOpenPopup({
        id: SESSION_SWITCHER_POPUP_ID,
        onClose: () => this.close(),
        insideSelectors: ['.session-switcher--popover', `#${chip.id}`],
      });
      window.addEventListener('juggler:open-project', this._onOpenProject, { capture: true });
      chip.setAttribute('aria-expanded', 'true');
    }
    this._gesture = gesture;
    this._sw?.open({ gesture });
  }

  /**
   * Stand the popover under the chip, inside the window.
   * @private
   */
  _place() {
    if (!this._sw) return;
    const rect = this._deps.chip.getBoundingClientRect();
    const at = placePopover({ chipLeft: rect.left, chipBottom: rect.bottom, viewportWidth: window.innerWidth });
    this._sw.el.style.setProperty('--session-switcher-left', `${at.left}px`);
    this._sw.el.style.setProperty('--session-switcher-top', `${at.top}px`);
    this._sw.el.style.setProperty('--session-switcher-width', `${at.width}px`);
  }

  /**
   * ⌘ let go: go to the lit row.
   * @private
   */
  _commitGesture() {
    const sw = this._sw;
    this._gesture = false;
    if (!sw) return;
    sw.setGesture(false);
    sw.pickSelected();
    this.close({ keepMove: true });
  }

  /**
   * What a pick does, here.
   * @returns {import('./session-switcher.js').SwitcherActions} The actions.
   * @private
   */
  _actions() {
    const d = this._deps;
    return {
      goSession: (s, { newWindow }) => {
        this.close();
        // This window's own row is where it already is.
        if (s.link === d.ownLink) return undefined;
        return d.go({ link: s.link, project: s.project, sessionId: s.id, conversation: '', newWindow });
      },
      openRecent: (r, { newWindow }) => this._openThenGo(r.path, r.link, newWindow),
      retry: (s) => this._openThenGo(s.project, s.link, false),
      stop: (s) => this._stop(s),
      pickFolder: d.surface === 'local' ? d.pickFolder : undefined,
      openPath: async (path, { create }) => {
        let target = path;
        if (create) {
          const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
          try {
            target = await d.createFolder(cut > 0 ? path.slice(0, cut) : '~', path.slice(cut + 1));
          } catch (err) {
            d.showError(err instanceof Error ? err.message : t('The folder could not be created.'));
            return;
          }
        }
        await this._openThenGo(target, '', false);
      },
      close: () => this.close(),
    };
  }

  /**
   * Go to a project with no session running: a browser tab to its link, which
   * opens it; a new window, the app's; otherwise open its session here,
   * waiting for it to run, then move this window to it — unless the popover
   * was taken down meanwhile.
   * @param {string} project - Its folder.
   * @param {string} link - Its link, '' where none is known.
   * @param {boolean} newWindow - Whether a window of its own was asked for.
   * @returns {Promise<void>} Resolves once gone, or given up.
   * @private
   */
  async _openThenGo(project, link, newWindow) {
    const d = this._deps;
    if (d.surface === 'tab' && link) {
      this.close();
      await d.go({ link, project, conversation: '', newWindow });
      return;
    }
    if (newWindow && d.surface === 'local') {
      this.close();
      await d.go({ link: link || '', project, conversation: '', newWindow: true });
      return;
    }
    const move = {};
    this._move = move;
    /** @type {any} */
    let s;
    try {
      s = await d.open(project);
    } catch (err) {
      if (this._move === move) d.showError(err instanceof Error ? err.message : t('The session could not be started.'));
      return;
    }
    if (this._move !== move) return;
    if (s?.state === 'error') {
      d.showError(s.error || t('The session could not be started.'));
      return;
    }
    this.close({ keepMove: true });
    this._move = null;
    await d.go({ link: s.link, project: s.project || project, sessionId: s.id, conversation: '', newWindow });
  }

  /**
   * Stop a session, or dismiss a failed one. This window's own goes to its
   * server's page after, with its drafts on disk first.
   * @param {import('../services/sessions-feed.js').Session} s - The session.
   * @returns {Promise<void>} Resolves once asked.
   * @private
   */
  async _stop(s) {
    const d = this._deps;
    const own = s.link === d.ownLink;
    try {
      if (own) await d.flushDrafts?.();
      await d.stop(s.id);
    } catch (err) {
      d.showError(err instanceof Error ? err.message : t('The session could not be stopped.'));
      return;
    }
    if (!own) return;
    this.close();
    await d.toServerPage();
  }
}

/**
 * The popover on this page's chip, with the page's own feed, navigation and
 * relay.
 * @param {HTMLElement} chip - The project chip.
 * @returns {SessionPopover} It, listening.
 */
export function createSessionPopover(chip) {
  const surface = navigationSurface();
  const api = async () => (await import('../services/api.js')).default;
  const popover = new SessionPopover({
    chip,
    feed: machineFeed(),
    ownLink: ownProjectLink(),
    surface,
    go: (to) => goTo(to),
    open: async (project) => (await api()).openMachineSession(project, { wait: true }),
    stop: async (id) => { await (await api()).stopMachineSession(id); },
    createFolder: async (parent, name) => (await api()).createMachineFolder(parent, name),
    pickFolder: () => pickDirectory(),
    toServerPage: () => moveToServerPage(),
    flushDrafts: () => flushBoundDrafts(),
    showError: (message) => {
      const port = uiPort();
      if (port) port.notice(message);
      else console.warn(message);
    },
  });
  popover.init();
  return popover;
}
