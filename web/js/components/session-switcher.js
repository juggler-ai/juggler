//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The session switcher: the machine's open sessions, most recently used
 * first, then its recent projects, then the ways of opening another — one
 * list, in one code path, wherever it shows. A project page drops it under its
 * chip as a popover (session-popover.js), and ⌘K walks it; the server page
 * (web/machine/sessions-view.js) is it, filling the window.
 *
 * The switcher decides nothing about where a pick goes. It is handed a source
 * — the sessions and recents as the machine server's events feed sends them,
 * and which session, if any, is this window's — and the actions its host
 * binds: a project page's go in place through the desktop app, the server
 * page's through its control API.
 * @module components/session-switcher
 */

import { t } from '../../sdk/lib/i18n.js';
import {
  attentionCounts, baseName, initials, inLifecycle, lifecycleText, relative,
} from '../utils/session-attention.js';
import { workspaceTint } from '../utils/workspace-colour.js';
import { formatBindingLabel, isMac } from '../services/key-shortcut-manager.js';

/**
 * A chord with the platform's command modifier, as this platform writes it.
 * @param {string} key - The key, as KeyboardEvent.key names it.
 * @returns {string} ⌘O on a Mac, Ctrl+O elsewhere.
 */
function chord(key) {
  return formatBindingLabel({ mod: true, key }, isMac());
}

/**
 * @typedef {import('../services/sessions-feed.js').Session} Session
 * @typedef {import('../services/sessions-feed.js').Recents} Recents
 * @typedef {{kind: 'session', key: string, session: Session, here: boolean, elsewhere: boolean}} SessionItem
 *   An open session: here when it is this window's, elsewhere when another
 *   viewer holds it.
 * @typedef {{kind: 'recent', key: string, path: string, link: string, used: string, waiting: number}} RecentItem
 *   A recent project with no session open.
 * @typedef {{kind: 'action', key: string, action: 'open'|'new'|'path', path?: string}} ActionItem
 *   A way of opening another: the folder chooser (or a typed path), a new
 *   folder, or the path typed in the filter.
 * @typedef {SessionItem|RecentItem|ActionItem} SwitcherItem
 * @typedef {{text: string, tone?: 'waiting'|'failed'|'working', only?: 'desk'|'touch'}} StatusPart
 *   One part of a status line, in its colour; a part only one kind of pointer
 *   is told.
 * @typedef {{sessions: Session[], recents: Recents, ownLink: string}} SwitcherSource
 *   What the switcher lists: the machine's sessions and recent projects, and
 *   this window's session's link ('' where no row is this window).
 * @typedef {object} SwitcherActions
 *   What a pick does, bound by the switcher's host. A promise an action answers
 *   holds its row in its pending state (starting or stopping) until it settles.
 * @property {(s: Session, o: {newWindow: boolean}) => void|Promise<unknown>} goSession - Go to an open session.
 * @property {(r: RecentItem, o: {newWindow: boolean}) => void|Promise<unknown>} openRecent - Open a recent project.
 * @property {(s: Session) => void|Promise<unknown>} stop - Stop a session, or dismiss a failed one.
 * @property {(s: Session) => void|Promise<unknown>} retry - Open a failed session's project again.
 * @property {() => Promise<string|null>} [pickFolder] - The host's folder chooser,
 *   which can make a folder too; the path picked, or null.
 * @property {(path: string, o: {create: boolean}) => void|Promise<unknown>} openPath - Open
 *   a typed path, or make it first.
 * @property {() => void} [close] - Take the popover down (Esc, Cancel).
 */

/** How many recent projects the switcher offers. */
const RECENTS_SHOWN = 8;

/**
 * Whether a session is one ⌘K may land on: not failed, crashed or leaving.
 * @param {Session} s - The session.
 * @returns {boolean} True when it can be gone to.
 */
function reachable(s) {
  return s.state !== 'error' && s.state !== 'stopping' && s.state !== 'restarting';
}

/**
 * The time a session was last viewed, for ordering; never-viewed ones last,
 * the newest of those first.
 * @param {Session} s - The session.
 * @returns {[number, number]} Its sort keys, larger first.
 */
function useKeys(s) {
  return [Date.parse(s.lastViewed || '') || 0, Date.parse(s.startedAt || '') || 0];
}

/**
 * What the switcher lists: Open — the sessions, most recently used first —
 * then Recent — the recent projects with no session, most recently used
 * first — then the ways of opening another, filtered by every term of the
 * query (name, path, or what a session works on). With no folder chooser, a
 * query that is a path (~ or /) is a row that opens it.
 * @param {object} o
 * @param {Session[]} o.sessions - The machine's sessions.
 * @param {Recents} o.recents - Its recent projects.
 * @param {string} o.ownLink - This window's session's link; '' for none.
 * @param {string} o.query - The filter as typed.
 * @param {boolean} o.canPickFolder - Whether the host has a folder chooser.
 * @returns {SwitcherItem[]} The rows, in order.
 */
export function switcherItems({ sessions, recents, ownLink, query, canPickFolder }) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  /**
   * @param {...string} hay
   * @returns {boolean} Whether every term is in it.
   */
  const matches = (...hay) => {
    const s = hay.join(' ').toLowerCase();
    return terms.every((term) => s.includes(term));
  };
  /** @type {SwitcherItem[]} */
  const items = [];
  const byUse = [...sessions].sort((a, b) => {
    const [ua, sa] = useKeys(a);
    const [ub, sb] = useKeys(b);
    return ub - ua || sb - sa;
  });
  for (const s of byUse) {
    if (!matches(baseName(s.project), s.project, s.attention?.workingOn || '')) continue;
    const here = !!ownLink && s.link === ownLink;
    items.push({ kind: 'session', key: `s:${s.id}`, session: s, here, elsewhere: !here && (s.viewers || 0) > 0 });
  }
  const open = new Set(sessions.map((s) => s.project));
  const offered = (recents?.paths || []).filter((p) => !open.has(p)).slice(0, RECENTS_SHOWN);
  for (const path of offered) {
    if (!matches(baseName(path), path)) continue;
    items.push({
      kind: 'recent',
      key: `r:${path}`,
      path,
      link: recents.links?.[path] || '',
      used: recents.used?.[path] || '',
      waiting: recents.waiting?.[path] || 0,
    });
  }
  const typed = query.trim();
  if (!canPickFolder && /^[~/]/.test(typed)) items.push({ kind: 'action', key: 'act:path', action: 'path', path: typed });
  items.push({ kind: 'action', key: 'act:open', action: 'open' });
  items.push({ kind: 'action', key: 'act:new', action: 'new' });
  return items;
}

/**
 * Where the selection starts: the first row with a query, else this window's
 * row — so ↵, or letting go of ⌘ having walked nowhere, stays put — else the
 * first row.
 * @param {SwitcherItem[]} items - The rows.
 * @param {string} query - The filter as typed.
 * @returns {number} Its index.
 */
export function defaultSelection(items, query) {
  if (query.trim()) return 0;
  return Math.max(0, items.findIndex((it) => it.kind === 'session' && it.here));
}

/**
 * The rows ⌘K walks, in order: this window's, where it is listed, then the
 * open sessions it could go to, most recently used first — never a failed one
 * or one leaving — then Recent. The walk starts on this window, so the first
 * K after the opening one lights the session used before it, and walking all
 * the way round comes back to stay.
 * @param {SwitcherItem[]} items - The rows.
 * @returns {number[]} Their indices.
 */
export function cycleOrder(items) {
  const here = items.findIndex((it) => it.kind === 'session' && it.here);
  const away = items.flatMap((it, i) => {
    if (it.kind === 'recent') return [i];
    if (it.kind !== 'session' || it.here || !reachable(it.session)) return [];
    return [i];
  });
  return here < 0 ? away : [here, ...away];
}

/**
 * A session's status line, in parts: a running one's waits and failures in
 * their colours, whether it works (on what, where known) or idles, and how many
 * conversations it has; one between lives says which; a failed one says how,
 * and that ↵ retries it (a touch is told to tap). Dismissing it is the
 * footer's ⌘⌫, or on the server page the row's own button.
 * @param {Session} s - The session.
 * @returns {StatusPart[]} The parts, in order.
 */
export function statusParts(s) {
  if (s.state === 'error') {
    return [
      { text: s.error || t('Stopped'), tone: 'failed' },
      { text: t('↵ to retry'), only: 'desk' },
      { text: t('tap to retry'), only: 'touch' },
    ];
  }
  if (inLifecycle(s)) return [{ text: lifecycleText(s, Date.now()) }];
  const c = attentionCounts(s);
  /** @type {StatusPart[]} */
  const parts = [];
  if (c.waiting) parts.push({ text: t('{count, plural, one {# waiting} other {# waiting}}', { count: c.waiting }), tone: 'waiting' });
  if (c.failed) parts.push({ text: t('{count, plural, one {# failed} other {# failed}}', { count: c.failed }), tone: 'failed' });
  const on = s.attention?.workingOn || '';
  if (c.working && on) parts.push({ text: t('working on “{name}”', { name: on }), tone: 'working' });
  else if (c.working) parts.push({ text: t('working'), tone: 'working' });
  else parts.push({ text: t('idle') });
  if (s.conversations) {
    parts.push({ text: t('{count, plural, one {# conversation} other {# conversations}}', { count: s.conversations }) });
  }
  return parts;
}

/**
 * One part of a status line, in its colour, or shown to one kind of pointer
 * only. No part has both.
 * @param {StatusPart} p - The part.
 * @returns {HTMLElement} Its span.
 */
function statusSpan(p) {
  if (p.tone === 'waiting') return el('span', 'ss-tone-waiting', p.text);
  if (p.tone === 'failed') return el('span', 'ss-tone-failed', p.text);
  if (p.tone === 'working') return el('span', 'ss-tone-working', p.text);
  if (p.only === 'desk') return el('span', 'ss-desk-only', p.text);
  if (p.only === 'touch') return el('span', 'ss-touch-only', p.text);
  return el('span', '', p.text);
}

/* Material Symbols paths, on the 0 -960 960 960 view box. */
const ICON_PATHS = {
  search: 'M784-120 532-372q-30 24-69 38t-83 14q-109 0-184.5-75.5T120-580q0-109 75.5-184.5T380-840q109 0 184.5 75.5T640-580q0 44-14 83t-38 69l252 252-56 56ZM380-400q75 0 127.5-52.5T560-580q0-75-52.5-127.5T380-760q-75 0-127.5 52.5T220-580q0 75 52.5 127.5T380-400Z',
  folder: 'M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640H447l-80-80H160v480l96-320h684L837-217q-8 26-29.5 41.5T760-160H160Zm84-80h516l72-240H316l-72 240Zm0 0 72-240-72 240Zm-84-400v-80 80Z',
  newFolder: 'M560-320h80v-80h80v-80h-80v-80h-80v80h-80v80h80v80ZM160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Zm0-80h640v-400H447l-80-80H160v480Zm0 0v-480 480Z',
  window: 'M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h640q33 0 56.5 23.5T880-720v480q0 33-23.5 56.5T800-160H160Zm0-80h640v-400H160v400Z',
};

/**
 * An icon, as a decorative element: the svg in a span that carries its class.
 * @param {keyof typeof ICON_PATHS} name - Which.
 * @returns {HTMLElement} It.
 */
function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 -960 960 960');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICON_PATHS[name]);
  svg.append(path);
  const span = el('span', 'ss-icon', [], { 'aria-hidden': 'true' });
  span.append(svg);
  return span;
}

/**
 * Build an element.
 * @param {string} tag - Tag name.
 * @param {string} className - Its classes ('' for none).
 * @param {string|Array<Node|string|null|false|undefined>} [content] - Its
 *   text, or its children, skipping falsy ones.
 * @param {Record<string, string>} [attrs] - Its attributes.
 * @returns {HTMLElement} The element.
 */
function el(tag, className, content = [], attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (typeof content === 'string') node.textContent = content;
  else for (const c of content) if (c) node.append(c);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/**
 * A project's tile: its initials on its hue, hashed from its link — the hue
 * says which project, never how it is doing.
 * @param {string} name - The project's folder name.
 * @param {string} hueKey - Its link, or its path where it has none.
 * @param {boolean} [dim] - Whether it is a project with no session.
 * @returns {HTMLElement} The tile in its wrap, which carries the marks.
 */
function tile(name, hueKey, dim = false) {
  const face = el('span', dim ? 'ss-tile ss-tile-dim' : 'ss-tile', initials(name));
  face.style.setProperty('--ss-tint', workspaceTint(hueKey));
  const wrap = el('span', 'ss-tile-wrap', [], { 'aria-hidden': 'true' });
  wrap.append(face);
  return wrap;
}

/**
 * Whether a key event carries the platform's command modifier (⌘, or Ctrl).
 * @param {KeyboardEvent|MouseEvent} e - The event.
 * @returns {boolean} True when it does.
 */
function commandHeld(e) {
  return e.metaKey || e.ctrlKey;
}

/**
 * The switcher's element, its filter, its rows and its keys. Mounted as a
 * popover (`popover`: Esc closes it, and a phone shows it as a sheet with a
 * title and Cancel) or as the server page's body (`page`: Esc clears the
 * filter). The rows are rebuilt only when what they show changes — a click
 * fires only when its press and release land on one element, so a row
 * replaced between them by a feed update would swallow it — and the selection
 * follows its row's key through a rebuild.
 */
export class SessionSwitcher {
  /**
   * @param {object} o
   * @param {'popover'|'page'} o.mode - Where it is mounted.
   * @param {() => SwitcherSource} o.source - What it lists, read at each refresh.
   * @param {SwitcherActions} o.actions - What a pick does.
   * @param {boolean} [o.canPickFolder] - Whether the host has a folder chooser.
   * @param {boolean} [o.inApp] - Whether a new window is a window (else a tab).
   * @param {() => number} [o.now] - The time now, in ms.
   */
  constructor({ mode, source, actions, canPickFolder = false, inApp = canPickFolder, now = () => Date.now() }) {
    this._mode = mode;
    this._source = source;
    this._actions = actions;
    this._canPickFolder = canPickFolder;
    this._inApp = inApp;
    this._now = now;
    /** @type {SwitcherItem[]} */
    this._items = [];
    this._sel = 0;
    this._query = '';
    /** @type {string|null} The row asking "stop anyway?". */
    this._confirmKey = null;
    /** @type {string|null} The action row showing its path field. */
    this._fieldKey = null;
    /** @type {Map<string, 'starting'|'stopping'>} Rows an action holds. */
    this._pending = new Map();
    this._gesture = false;
    this._shown = '';

    this.input = /** @type {HTMLInputElement} */ (el('input', 'ss-input', [], {
      type: 'text',
      spellcheck: 'false',
      autocomplete: 'off',
      role: 'combobox',
      'aria-expanded': 'true',
      'aria-autocomplete': 'list',
      placeholder: mode === 'popover' ? t('Switch to a session or project…') : t('Find a session or project…'),
      'aria-label': t('Find a session or project'),
    }));
    this._search = el('div', 'ss-search');
    this._search.append(icon('search'), this.input);
    this._list = el('div', 'ss-list', [], { role: 'listbox', 'aria-label': t('Sessions') });
    this._foot = el('div', 'ss-foot');
    /** The switcher's element. */
    this.el = el('div', mode === 'popover' ? 'ss ss--popover' : 'ss ss--page');
    if (mode === 'popover') {
      const bar = el('div', 'ss-sheetbar');
      const title = el('span', 'ss-sheet-title', t('Switch to'));
      const cancel = el('button', 'ss-sheet-cancel', t('Cancel'), { type: 'button' });
      cancel.addEventListener('click', () => this._actions.close?.());
      bar.append(title, cancel);
      this.el.append(bar);
    }
    this.el.append(this._search, this._list, this._foot);
    this._list.id = `ss-list-${mode}`;
    this.input.setAttribute('aria-controls', this._list.id);

    this._onInput = () => {
      this._query = this.input.value;
      this._confirmKey = null;
      this._fieldKey = null;
      this._render(true);
    };
    this._onKey = (/** @type {KeyboardEvent} */ e) => this._key(e);
    this._onMouseDown = (/** @type {MouseEvent} */ e) => {
      // The filter keeps the keyboard while the pointer works the list.
      if (!(/** @type {Element} */ (e.target)).closest('input, button')) e.preventDefault();
    };
    // In the popover the lit row follows the pointer, as in a menu. Only a
    // pointer that has moved counts: the mousemove a browser sends when the
    // list scrolls or opens under a still pointer would take the row the
    // keys or the default chose. On the page the lit row is the keys' alone
    // and the pointer only shows where a click would land (.ss-row:hover).
    /** @type {{x: number, y: number}|null} */
    this._pointer = null;
    this._onMouseMove = (/** @type {MouseEvent} */ e) => {
      if (this._mode !== 'popover') return;
      const was = this._pointer;
      this._pointer = { x: e.screenX, y: e.screenY };
      if (!was || (was.x === e.screenX && was.y === e.screenY)) return;
      const row = /** @type {HTMLElement|null} */ ((/** @type {Element} */ (e.target)).closest('.ss-row'));
      const i = row ? Number(row.dataset.index) : -1;
      if (i >= 0 && i !== this._sel) this.select(i, false);
    };
    this._onClick = (/** @type {MouseEvent} */ e) => this._click(e);
    this.input.addEventListener('input', this._onInput);
    this.input.addEventListener('keydown', this._onKey);
    this._list.addEventListener('mousedown', this._onMouseDown);
    this._list.addEventListener('mousemove', this._onMouseMove);
    this._list.addEventListener('click', this._onClick);
  }

  /**
   * The rows as drawn.
   * @returns {SwitcherItem[]} They.
   */
  get items() {
    return this._items;
  }

  /**
   * The lit row's index.
   * @returns {number} It.
   */
  get selected() {
    return this._sel;
  }

  /**
   * Show it fresh: no filter, no confirm or field, the selection on its
   * default row — this window's, where there is one. In the hold-to-cycle
   * gesture (`gesture`) the filter is shown but not focused, since nothing
   * can be typed while ⌘ is held; otherwise the filter takes the keyboard.
   * @param {{gesture?: boolean}} [o]
   */
  open({ gesture = false } = {}) {
    this._query = '';
    this.input.value = '';
    this._confirmKey = null;
    this._fieldKey = null;
    this._shown = '';
    this._pointer = null;
    this.setGesture(gesture);
    this._render(true);
    this._list.scrollTop = 0;
    if (!gesture) this.input.focus({ preventScroll: true });
  }

  /**
   * Enter or leave the gesture's HUD look.
   * @param {boolean} on - Whether ⌘ is held.
   */
  setGesture(on) {
    this._gesture = on;
    this.el.classList.toggle('ss--gesture', on);
    this._paintFoot();
  }

  /** Read the source again and redraw what changed. */
  refresh() {
    this._render(false);
  }

  /**
   * Show or hide the filter: hidden where there is nothing to filter, only
   * the ways of opening a folder.
   * @param {boolean} on - Whether it is shown.
   */
  showFilter(on) {
    this._search.hidden = !on;
  }

  /** Give the filter the keyboard. */
  focus() {
    this.input.focus({ preventScroll: true });
  }

  /**
   * ⌘K again: light the next row of the walk, wrapping.
   * @returns {boolean} False when there is nothing to walk.
   */
  step() {
    const walk = cycleOrder(this._items);
    if (!walk.length) return false;
    const at = walk.indexOf(this._sel);
    this.select(walk[(at + 1) % walk.length] ?? 0, true);
    return true;
  }

  /**
   * Light a row.
   * @param {number} i - Its index, clamped to the list.
   * @param {boolean} [scroll] - Whether to bring it into view.
   */
  select(i, scroll = true) {
    this._sel = Math.max(0, Math.min(i, this._items.length - 1));
    for (const row of /** @type {NodeListOf<HTMLElement>} */ (this._list.querySelectorAll('.ss-row'))) {
      const on = Number(row.dataset.index) === this._sel;
      row.setAttribute('aria-selected', String(on));
      if (on) {
        this.input.setAttribute('aria-activedescendant', row.id);
        if (scroll) row.scrollIntoView?.({ block: 'nearest' });
      }
    }
    this._paintFoot();
  }

  /**
   * Do what the lit row is for, as ↵ does.
   * @param {{newWindow?: boolean}} [o] - Whether a window of its own was asked for.
   */
  pickSelected({ newWindow = false } = {}) {
    const it = this._items[this._sel];
    if (it) this._pick(it, { newWindow });
  }

  /** Stop listening. */
  destroy() {
    this.input.removeEventListener('input', this._onInput);
    this.input.removeEventListener('keydown', this._onKey);
    this._list.removeEventListener('mousedown', this._onMouseDown);
    this._list.removeEventListener('mousemove', this._onMouseMove);
    this._list.removeEventListener('click', this._onClick);
  }

  /**
   * Redraw the rows from the source, unless nothing they show has changed.
   * @param {boolean} resetSel - Put the selection on its default row rather
   *   than keep it on the row it was on.
   * @private
   */
  _render(resetSel) {
    const prevKey = this._items[this._sel]?.key;
    const src = this._source();
    this._items = switcherItems({ ...src, query: this._query, canPickFolder: this._canPickFolder });
    const now = this._now();
    const shown = JSON.stringify([
      this._items.map((it) => (it.kind === 'session' ? [it.key, it.here, it.elsewhere, it.session] : it)),
      this._query, this._confirmKey, this._fieldKey, [...this._pending], Math.floor(now / 60000),
    ]);
    if (shown !== this._shown) {
      this._shown = shown;
      this._draw(now);
    }
    let i = resetSel ? -1 : this._items.findIndex((it) => it.key === (this._fieldKey || prevKey));
    if (i < 0) i = defaultSelection(this._items, this._query);
    this.select(i, resetSel);
  }

  /**
   * Build the rows.
   * @param {number} now - The time now, in ms.
   * @private
   */
  _draw(now) {
    const frag = document.createDocumentFragment();
    /** @type {string|null} */
    let section = null;
    const matched = this._items.some((it) => it.kind !== 'action');
    this._items.forEach((it, i) => {
      const heading = it.kind === 'session' ? 'open' : it.kind === 'recent' ? 'recent' : 'action';
      if (heading !== section) {
        if (heading === 'action') {
          if (this._query.trim() && !matched) {
            const empty = el('div', 'ss-empty', t('No session matches “{query}”.', { query: this._query.trim() }));
            frag.append(empty);
          } else if (i > 0) {
            const rule = el('div', 'ss-rule', [], { role: 'presentation' });
            frag.append(rule);
          }
        } else {
          const title = el('div', 'ss-heading', heading === 'open' ? t('Open', undefined, { context: 'sessions running now' }) : t('Recent'), { role: 'presentation' });
          frag.append(title);
        }
        section = heading;
      }
      const row = it.kind === 'session' ? this._sessionRow(it)
        : it.kind === 'recent' ? this._recentRow(it, now) : this._actionRow(it);
      row.dataset.index = String(i);
      row.dataset.key = it.key;
      row.id = `ss-${this._mode}-row-${i}`;
      frag.append(row);
    });
    this._list.replaceChildren(frag);
    const field = /** @type {HTMLInputElement|null} */ (this._list.querySelector('.ss-field input'));
    field?.focus();
  }

  /**
   * A row: its tile, its name over its line, and its end.
   * @param {HTMLElement} wrap - The tile, in its wrap.
   * @param {HTMLElement} top - Its name and any tag.
   * @param {HTMLElement|null} sub - Its line under the name, if any.
   * @param {Array<HTMLElement|null>} end - What its end holds.
   * @param {boolean} [action] - Whether it is a way of opening another.
   * @returns {HTMLElement} The row.
   * @private
   */
  _row(wrap, top, sub, end, action = false) {
    const main = el('div', 'ss-main');
    main.append(top);
    if (sub) main.append(sub);
    const tail = el('div', 'ss-end');
    for (const part of end) if (part) tail.append(part);
    const row = el('div', action ? 'ss-row ss-row-action' : 'ss-row', [], { role: 'option' });
    row.append(wrap, main, tail);
    return row;
  }

  /**
   * An open session's row: its tile and marks, its name, path and tag, its
   * status line (or the confirm a stop asks), and — on the page — its Stop
   * button at the end.
   * @param {SessionItem} it
   * @returns {HTMLElement} The row.
   * @private
   */
  _sessionRow(it) {
    const s = it.session;
    const pending = this._pending.get(it.key);
    const name = baseName(s.project);
    const wrap = tile(name, s.link || s.project);
    if (pending || inLifecycle(s)) {
      const spinner = el('juggler-spinner', 'ss-tile-spinner');
      wrap.append(spinner);
    } else {
      const c = attentionCounts(s);
      if (c.waiting) {
        const badge = el('span', 'ss-badge ss-badge-waiting', String(c.waiting));
        wrap.append(badge);
      } else if (c.failed || s.state === 'error') {
        const badge = el('span', 'ss-badge ss-badge-failed', '!');
        wrap.append(badge);
      }
      if (c.working && s.state === 'running') {
        const dot = el('span', 'ss-badge ss-badge-working');
        wrap.append(dot);
      }
    }
    const top = el('div', 'ss-top');
    const label = el('span', 'ss-name', name);
    const where = el('span', 'ss-top-path ss-path', s.project, { title: s.project });
    top.append(label, where);
    if (it.here) {
      const here = el('span', 'ss-tag ss-tag-here', t('this window'));
      top.append(here);
    } else if (it.elsewhere) {
      const other = el('span', 'ss-tag ss-tag-other', [icon('window'), t('other window')], { title: t('Open in another window') });
      top.append(other);
    }
    /** @type {HTMLElement} */
    let sub;
    if (this._confirmKey === it.key) {
      sub = this._confirmLine(it);
    } else if (pending) {
      sub = el('div', 'ss-sub', pending === 'starting' ? t('Starting…') : t('Stopping…'));
    } else {
      sub = el('div', 'ss-sub');
      // The middle dots between the parts are the stylesheet's.
      for (const p of statusParts(s)) sub.append(statusSpan(p));
    }
    const meta = el('span', 'ss-meta');
    // Stopping is the page's to offer, as a button that says so: a × reads as
    // hiding the row, not ending the session. The popover is for switching, so
    // a stray click there never ends one (⌘⌫ still does, said in its footer).
    /** @type {HTMLElement|null} */
    let stop = null;
    if (this._mode === 'page' && s.state !== 'stopping' && !pending) {
      const failed = s.state === 'error';
      stop = el('button', 'ss-mini ss-stop', failed ? t('Dismiss') : t('Stop'), {
        type: 'button',
        tabindex: '-1',
        'aria-label': failed ? t('Dismiss {name}', { name }) : t('Stop {name}', { name }),
      });
    }
    return this._row(wrap, top, sub, [meta, stop]);
  }

  /**
   * The inline confirm a stop of a working session asks, in place of its
   * status line.
   * @param {SessionItem} it
   * @returns {HTMLElement} The line.
   * @private
   */
  _confirmLine(it) {
    const text = it.here ? t('Stop this window’s session? A turn is running.') : t('A turn is running. Stop it anyway?');
    const line = el('div', 'ss-confirm');
    const ask = el('span', 'ss-confirm-text', text);
    const yes = el('button', 'ss-mini ss-mini-danger', t('Stop'), { type: 'button', 'data-confirm': 'yes' });
    const no = el('button', 'ss-mini', t('Keep'), { type: 'button', 'data-confirm': 'no' });
    line.append(ask, yes, no);
    return line;
  }

  /**
   * A recent project's row: its dimmed tile, its name, its path — or, when
   * its session ended with conversations waiting, how many — and its age.
   * @param {RecentItem} it
   * @param {number} now - The time now, in ms.
   * @returns {HTMLElement} The row.
   * @private
   */
  _recentRow(it, now) {
    const name = baseName(it.path);
    const pending = this._pending.get(it.key);
    const wrap = tile(name, it.link || it.path, true);
    if (pending) {
      const spinner = el('juggler-spinner', 'ss-tile-spinner');
      wrap.append(spinner);
    } else if (it.waiting) {
      const badge = el('span', 'ss-badge ss-badge-waiting', String(it.waiting));
      wrap.append(badge);
    }
    /** @type {HTMLElement} */
    let sub;
    if (pending) {
      sub = el('div', 'ss-sub', t('Starting…'));
    } else if (it.waiting) {
      sub = el('div', 'ss-sub ss-tone-waiting', t('{count, plural, one {? # conversation was waiting on you when it closed} other {? # conversations were waiting on you when it closed}}', { count: it.waiting }), { title: it.path });
    } else {
      sub = el('div', 'ss-sub ss-path', it.path);
    }
    const top = el('div', 'ss-top');
    const label = el('span', 'ss-name', name);
    top.append(label);
    const at = Date.parse(it.used);
    const age = Number.isNaN(at) ? null : el('span', 'ss-meta', relative(at - now));
    return this._row(wrap, top, sub, [age]);
  }

  /**
   * A way of opening another: the folder chooser, a new folder, or a typed
   * path — with, in place of a chooser, its path field when asked for.
   * @param {ActionItem} it
   * @returns {HTMLElement} The row.
   * @private
   */
  _actionRow(it) {
    const text = it.action === 'open' ? t('Open folder…')
      : it.action === 'new' ? t('New folder…') : t('Open {path}', { path: it.path || '' });
    const top = el('div', 'ss-top');
    const label = el('span', 'ss-action-name', text);
    top.append(label);
    const face = el('span', 'ss-tile ss-tile-action', [icon(it.action === 'new' ? 'newFolder' : 'folder')]);
    const wrap = el('span', 'ss-tile-wrap', [], { 'aria-hidden': 'true' });
    wrap.append(face);
    const field = this._fieldKey === it.key ? this._pathField(it) : null;
    const hint = it.action === 'open' && this._canPickFolder ? el('kbd', 'ss-meta', chord('o')) : null;
    return this._row(wrap, top, field, [hint], true);
  }

  /**
   * The path field an action row shows where there is no folder chooser.
   * @param {ActionItem} it
   * @returns {HTMLElement} The field and its button.
   * @private
   */
  _pathField(it) {
    const create = it.action === 'new';
    const field = /** @type {HTMLInputElement} */ (el('input', 'ss-field-input', [], {
      type: 'text',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': create ? t('New folder’s path') : t('Folder’s path'),
      placeholder: create ? t('e.g., {example}', { example: '~/code/my-new-project' }) : t('e.g., {example}', { example: '~/code/some-project' }),
    }));
    field.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        void this._openPath(field.value, create);
      } else if (e.key === 'Escape' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        this._fieldKey = null;
        this._render(false);
        this.focus();
        if (e.key === 'ArrowUp') this.select(this._sel - 1);
        if (e.key === 'ArrowDown') this.select(this._sel + 1);
      }
    });
    const go = el('button', 'ss-mini', create ? t('Create') : t('Open'), { type: 'button', 'data-field-go': '1' });
    go.addEventListener('click', () => { void this._openPath(field.value, create); });
    const box = el('div', 'ss-field');
    box.append(field, go);
    return box;
  }

  /**
   * The filter's keys.
   * @param {KeyboardEvent} e
   * @private
   */
  _key(e) {
    const it = this._items[this._sel];
    const mod = commandHeld(e);
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault();
      this._confirmKey = null;
      this._render(false);
      this.select(this._sel + 1);
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault();
      this._confirmKey = null;
      this._render(false);
      this.select(this._sel - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!it) return;
      if (it.kind === 'session' && this._confirmKey === it.key) void this._stop(it);
      else this._pick(it, { newWindow: mod });
    } else if (e.key === 'Escape') {
      if (this._confirmKey) {
        e.preventDefault();
        e.stopPropagation();
        this._confirmKey = null;
        this._render(false);
      } else if (this._mode === 'popover') {
        e.preventDefault();
        e.stopPropagation();
        this._actions.close?.();
      } else if (this._query) {
        e.preventDefault();
        this.input.value = '';
        this._onInput();
      }
    } else if (mod && e.key === 'Backspace') {
      e.preventDefault();
      if (it?.kind === 'session') this._remove(it);
    } else if (mod && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      e.stopPropagation();
      this.openFolder();
    } else if (e.key === 'Tab') {
      e.preventDefault();
    }
  }

  /**
   * The list's own keys — ↑↓, ↵ and ⌘↵, ⌘⌫ — pressed outside the filter. The
   * server page passes on those pressed with nothing else holding the
   * keyboard, so the footer's hints hold wherever focus is.
   * @param {KeyboardEvent} e
   * @returns {boolean} Whether it was one of them, and is taken.
   */
  listKey(e) {
    if (e.altKey || e.shiftKey) return false;
    const mod = commandHeld(e);
    const listKey = (!mod && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))
      || e.key === 'Enter' || (mod && e.key === 'Backspace');
    if (!listKey) return false;
    this._key(e);
    return true;
  }

  /** Do what Open folder… does: the folder chooser, or its path field. */
  openFolder() {
    const it = this._items.find((x) => x.key === 'act:open');
    if (it) {
      this.select(this._items.indexOf(it));
      this._pick(it, { newWindow: false });
    }
  }

  /**
   * A click in the list: a confirm's buttons, a Stop, or a row.
   * @param {MouseEvent} e
   * @private
   */
  _click(e) {
    const target = /** @type {Element} */ (e.target);
    const row = /** @type {HTMLElement|null} */ (target.closest('.ss-row'));
    if (!row) return;
    const it = this._items[Number(row.dataset.index)];
    if (!it) return;
    const confirm = /** @type {HTMLElement|null} */ (target.closest('[data-confirm]'));
    if (confirm && it.kind === 'session') {
      if (confirm.dataset.confirm === 'yes') void this._stop(it);
      else {
        this._confirmKey = null;
        this._render(false);
      }
      return;
    }
    if (target.closest('.ss-stop') && it.kind === 'session') {
      this._remove(it);
      return;
    }
    if (target.closest('.ss-field')) return;
    this.select(Number(row.dataset.index), false);
    this._pick(it, { newWindow: commandHeld(e) });
  }

  /**
   * Do what a row is for.
   * @param {SwitcherItem} it
   * @param {{newWindow: boolean}} o
   * @private
   */
  _pick(it, { newWindow }) {
    if (it.kind === 'session') {
      const s = it.session;
      if (s.state === 'error') this._hold(it.key, 'starting', this._actions.retry(s));
      else if (reachable(s) && !this._pending.has(it.key)) void this._actions.goSession(s, { newWindow });
    } else if (it.kind === 'recent') {
      if (!this._pending.has(it.key)) this._hold(it.key, 'starting', this._actions.openRecent(it, { newWindow }));
    } else if (it.action === 'path') {
      void this._openPath(it.path || '', false);
    } else if (this._actions.pickFolder && this._canPickFolder) {
      void this._chooseFolder();
    } else {
      this._fieldKey = it.key;
      this._render(false);
    }
  }

  /**
   * Hold a row in a pending state until what an action answered settles.
   * @param {string} key - The row.
   * @param {'starting'|'stopping'} state - What it says meanwhile.
   * @param {unknown} result - The action's answer.
   * @private
   */
  _hold(key, state, result) {
    if (!(result instanceof Promise)) return;
    this._pending.set(key, state);
    this._render(false);
    const release = () => {
      this._pending.delete(key);
      this._render(false);
    };
    result.then(release, release);
  }

  /**
   * Stop or ⌘⌫: dismiss a failed session; stop any other, asking first only
   * when a turn is running in it.
   * @param {SessionItem} it
   * @private
   */
  _remove(it) {
    const s = it.session;
    if (s.state === 'stopping' || this._pending.has(it.key)) return;
    if (s.state !== 'error' && attentionCounts(s).working && this._confirmKey !== it.key) {
      this._confirmKey = it.key;
      this._render(false);
      return;
    }
    void this._stop(it);
  }

  /**
   * Stop (or dismiss) a session.
   * @param {SessionItem} it
   * @returns {Promise<void>} Resolves once asked.
   * @private
   */
  async _stop(it) {
    this._confirmKey = null;
    this._hold(it.key, 'stopping', Promise.resolve(this._actions.stop(it.session)));
  }

  /**
   * The host's folder chooser, then open what it picked.
   * @returns {Promise<void>} Resolves once asked.
   * @private
   */
  async _chooseFolder() {
    const picked = await this._actions.pickFolder?.();
    if (picked) await this._actions.openPath(picked, { create: false });
  }

  /**
   * Open a typed path, or make it first.
   * @param {string} path - As typed.
   * @param {boolean} create - Whether to make it.
   * @returns {Promise<void>} Resolves once asked.
   * @private
   */
  async _openPath(path, create) {
    const typed = path.trim();
    if (!typed) return;
    this._fieldKey = null;
    this._render(false);
    await this._actions.openPath(typed, { create });
  }

  /**
   * The footer's key hints for the lit row.
   * @private
   */
  _paintFoot() {
    /**
     * @param {string} key
     * @param {string} what
     * @returns {HTMLElement} One hint.
     */
    const hint = (key, what) => el('span', '', [el('kbd', '', key), ` ${what}`]);
    if (this._gesture) {
      this._foot.replaceChildren(hint('K', t('next')), hint(isMac() ? '⌘' : 'Ctrl', t('let go to switch')), hint('esc', t('cancel')));
      return;
    }
    const it = this._items[this._sel];
    const page = this._mode === 'page';
    const elsewhere = this._inApp ? t('new window') : t('new tab');
    /** @type {HTMLElement[]} */
    const parts = [];
    if (it?.kind === 'session') {
      if (this._confirmKey === it.key) parts.push(hint('↵', t('stop')), hint('esc', t('keep it')));
      else if (it.session.state === 'error') parts.push(hint('↵', t('retry')), hint(chord('Backspace'), t('dismiss')));
      else if (it.here) parts.push(hint('↵', t('stay here')), hint(chord('Backspace'), t('stop')));
      else if (it.elsewhere && this._inApp) parts.push(hint('↵', t('raise its window')), hint(chord('Backspace'), t('stop')));
      else parts.push(hint('↵', page ? t('open') : t('switch here')), hint(chord('Enter'), elsewhere), hint(chord('Backspace'), t('stop')));
    } else if (it?.kind === 'recent') {
      parts.push(hint('↵', page ? t('open') : t('open here')), hint(chord('Enter'), elsewhere));
    } else if (it) {
      parts.push(hint('↵', this._canPickFolder || it.action === 'path' ? t('choose') : t('type a path')));
    }
    if (!page) parts.push(hint('esc', t('close')));
    this._foot.replaceChildren(...parts);
  }
}
