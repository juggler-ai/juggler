//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import searchBackendRegistry from '../../registries/search-backend-registry.js';
import { REGISTRIES_RELOADED } from '../../registries/reload-registries.js';
import { backendKey, effectiveSearchOrder, readBackendSetup, saveSearchOrder } from '../../services/web-search-backends.js';
import { buildToggleRow } from './notifications-tab.js';
import { showNotice } from '../modal-dialog.js';
import { startReorderDrag } from '../../utils/reorder-drag.js';
import { createDragGrip, pointerMayGrab } from '../../utils/drag-grip.js';
import { errorText } from '../../../sdk/lib/error-utils.js';
import { t } from '../../../sdk/lib/i18n.js';

/**
 * Where a backend stands, which decides the control its row carries:
 * `ready` can be switched on or off here; `setup` lacks a setting it needs (a
 * key, a server URL) and links to its page in Extensions; `off` is switched
 * off in Extensions and links there to turn it on.
 * @typedef {'ready'|'setup'|'off'} BackendState
 */

/**
 * @typedef {object} BackendRow
 * @property {string} key - What the setting stores it as, `<extension id>/<MANIFEST id>`
 * @property {string} id - The backend's MANIFEST id, which its page in Extensions is found by
 * @property {string} name - Display name, translated
 * @property {string} description - Description, translated
 * @property {BackendState} state - What the row offers
 * @property {boolean} hasSettings - Whether its extension page has settings for it
 */

/**
 * Web search tab: which search backends the WebSearch tool uses, and in what
 * order (`webSearch.order` in settings.json).
 *
 * The backends in use come first, in the order they are tried, each dragged
 * by its grip (or moved with Alt+↑/↓ on its switch) to change it — the
 * reorder gesture the sidebar and the pinboard use, utils/reorder-drag.js.
 * Below them is every other installed backend. A backend can be switched on
 * here only once it can search: one still missing its key, or whose extension
 * is switched off, carries a link to its page in Extensions instead, since
 * that is the only place either is put right.
 *
 * A key in the stored order whose backend is not ready keeps its place in the
 * setting (so a key cleared and set again brings it back where it was) but is
 * drawn with the others, not among the ones in use. Switching off the last
 * backend in use stores an empty order: no backend, not the default.
 *
 * The order arrives with the settings document (onSettingsChanged), so another
 * window's change shows here without a fetch. Which settings each backend has
 * filled in is read when the tab is shown — which is how coming back from
 * Extensions with a key entered finds the backend ready — and when the
 * registries reload. Every redraw swaps in a list built whole, so nothing is
 * cleared while a read is out.
 */
export class WebSearchTab {
  /**
   * @param {HTMLElement & {open?: (tab?: string, options?: object) => Promise<void>}} host - The settings-panel element.
   */
  constructor(host) {
    /** @type {HTMLElement & {open?: (tab?: string, options?: object) => Promise<void>}} @private */
    this.host = host;
    /** @type {string[]} @private — the order as stored (or the default). */
    this._order = effectiveSearchOrder(undefined);
    /**
     * Backend keys missing a setting they need, or null before the first read
     * (when nothing is drawn, rather than switches that turn into links).
     * @type {Set<string>|null} @private
     */
    this._needsSetup = null;
    /** @type {Set<string>} @private — backend keys with any setting on their page. */
    this._withSettings = new Set();
    /** @type {number} @private — the latest settings read; an older one is dropped. */
    this._readGeneration = 0;
    /** @type {boolean} @private — a drag is live: redraws wait for it. */
    this._dragging = false;
    /** @type {boolean} @private */
    this._renderDeferred = false;
    /** @type {string|null} @private — the backend key a keyboard move is carrying. */
    this._focusAfterSave = null;
    /** @type {() => void} @private — reads afresh when the registries reload. */
    this._onReloaded = () => { void this.refresh(); };
    /** @type {boolean} @private */
    this._connected = false;
  }

  /** @returns {void} */
  connect() {
    if (this._connected || typeof document === 'undefined') return;
    this._connected = true;
    document.addEventListener(REGISTRIES_RELOADED, this._onReloaded);
  }

  /** @returns {void} */
  dispose() {
    if (!this._connected) return;
    this._connected = false;
    document.removeEventListener(REGISTRIES_RELOADED, this._onReloaded);
  }

  /** Tab became visible: a key may have been entered in Extensions since. */
  show() {
    void this.refresh();
  }

  /**
   * @param {any} settings - The whole settings document
   * @returns {void}
   */
  onSettingsChanged(settings) {
    this._order = effectiveSearchOrder(settings?.webSearch?.order);
    this.render();
  }

  /**
   * Read which backends have the settings they need, then redraw.
   * @returns {Promise<void>} Settles once drawn
   */
  async refresh() {
    const generation = ++this._readGeneration;
    const { needsSetup, withSettings } = await readBackendSetup();
    if (generation !== this._readGeneration) return;
    this._needsSetup = needsSetup;
    this._withSettings = withSettings;
    this.render();
  }

  /**
   * Every installed backend: the ones in use in the user's order, then the rest
   * by name.
   * @returns {{inUse: BackendRow[], rest: BackendRow[]}} Rows to draw
   * @private
   */
  _rows() {
    const needsSetup = this._needsSetup ?? new Set();
    /** @type {Map<string, BackendRow>} */
    const byKey = new Map();
    for (const { id, manifest, disabled, extensionId } of searchBackendRegistry.getCatalogManifests()) {
      // Only an extension's backend can be stored: a key names its extension.
      if (!extensionId) continue;
      const key = backendKey(extensionId, id);
      // A backend's manifest text is in its own extension's catalogue.
      const namespace = extensionId;
      byKey.set(key, {
        key,
        id,
        name: t(manifest.name, undefined, { namespace }),
        description: t(manifest.description, undefined, { namespace }),
        state: disabled ? 'off' : needsSetup.has(key) ? 'setup' : 'ready',
        hasSettings: this._withSettings.has(key)
      });
    }
    /** @type {BackendRow[]} */
    const inUse = [];
    for (const key of this._order) {
      const row = byKey.get(key);
      if (row?.state === 'ready') inUse.push(row);
    }
    const used = new Set(inUse.map((row) => row.key));
    const rest = [...byKey.values()].filter((row) => !used.has(row.key)).sort((a, b) => a.name.localeCompare(b.name));
    return { inUse, rest };
  }

  /** Draw the list. */
  render() {
    const container = this.host.querySelector('#web-search-form');
    if (!container || this._needsSetup === null) return;
    if (this._dragging) {
      this._renderDeferred = true;
      return;
    }

    const { inUse, rest } = this._rows();
    if (inUse.length === 0 && rest.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'settings-description';
      empty.textContent = t('No search services are installed.');
      container.replaceChildren(empty);
      return;
    }

    const inUseKeys = inUse.map((row) => row.key);
    /** @type {HTMLElement[]} */
    const parts = [];

    parts.push(this._heading(t('In use')));
    if (inUse.length > 0) {
      const hint = document.createElement('p');
      hint.className = 'settings-description';
      hint.textContent = t('Tried top first. Drag to change the order.');
      parts.push(hint);
    }
    const list = document.createElement('div');
    list.className = 'web-search-order';
    for (const row of inUse) list.appendChild(this._orderedRow(row, inUseKeys, list));
    if (inUse.length === 0) {
      const none = document.createElement('p');
      none.className = 'settings-description';
      none.textContent = t('None: web search is unavailable until one is switched on.');
      list.appendChild(none);
    }
    parts.push(list);

    if (rest.length > 0) {
      parts.push(this._heading(t('Not in use')));
      const others = document.createElement('div');
      others.className = 'web-search-others';
      for (const row of rest) others.appendChild(this._otherRow(row, inUseKeys));
      parts.push(others);
    }
    container.replaceChildren(...parts);
  }

  /**
   * @param {string} text - Heading text
   * @returns {HTMLElement} The heading
   * @private
   */
  _heading(text) {
    const heading = document.createElement('div');
    heading.className = 'settings-section-heading caps-label-lg';
    heading.textContent = text;
    return heading;
  }

  /**
   * A row among the backends in use: a grip to drag it by, its switch (on),
   * and a link to its settings when it has any.
   * @param {BackendRow} row - The backend
   * @param {string[]} inUseKeys - The keys in use, in order
   * @param {HTMLElement} list - The list it is dragged within
   * @returns {HTMLElement} The row
   * @private
   */
  _orderedRow(row, inUseKeys, list) {
    const { row: el, input } = buildToggleRow(row.name, row.description, true, (on) => {
      if (!on) void this._save(this._withReady(inUseKeys.filter((key) => key !== row.key)));
    });
    el.classList.add('web-search-row', 'is-ordered');
    el.dataset.backend = row.key;
    input.setAttribute('aria-label', t('Use {name}', { name: row.name }));
    // Reordering has to be reachable without a pointer: the switch is the row's
    // one focus stop, so it carries the keys.
    input.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
    input.addEventListener('keydown', (e) => {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      const at = inUseKeys.indexOf(row.key);
      const to = at + (e.key === 'ArrowUp' ? -1 : 1);
      if (to < 0 || to >= inUseKeys.length) return;
      this._focusAfterSave = row.key;
      void this._save(this._withReady(moved(inUseKeys, at, to)));
    });
    el.prepend(createDragGrip());
    if (row.hasSettings) el.querySelector('.provider-control')?.prepend(this._link(row, t('Settings')));
    el.addEventListener('pointerdown', (e) => this._beginDrag(/** @type {PointerEvent} */ (e), el, list, inUseKeys));
    return el;
  }

  /**
   * A row below the backends in use: its switch (off) when it is ready to
   * search, else a link to where it is put right.
   * @param {BackendRow} row - The backend
   * @param {string[]} inUseKeys - The keys in use, in order
   * @returns {HTMLElement} The row
   * @private
   */
  _otherRow(row, inUseKeys) {
    if (row.state !== 'ready') {
      const description = row.state === 'off'
        ? t('{description} It is switched off in Extensions for this project.', { description: row.description })
        : row.description;
      const el = buildLinkRow(row.name, description);
      el.classList.add('web-search-row');
      el.dataset.backend = row.key;
      el.querySelector('.provider-control')?.append(this._link(row, row.state === 'off' ? t('Turn on') : t('Set up')));
      return el;
    }
    const { row: el, input } = buildToggleRow(row.name, row.description, false, (on) => {
      if (on) void this._save(this._withReady([...inUseKeys, row.key]));
    });
    el.classList.add('web-search-row');
    el.dataset.backend = row.key;
    input.setAttribute('aria-label', t('Use {name}', { name: row.name }));
    if (row.hasSettings) el.querySelector('.provider-control')?.prepend(this._link(row, t('Settings')));
    return el;
  }

  /**
   * A button that opens the backend's page in Extensions.
   * @param {BackendRow} row - The backend
   * @param {string} label - Button text
   * @returns {HTMLButtonElement} The button
   * @private
   */
  _link(row, label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm btn-ghost';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      void this.host.open?.('extensions', { capability: { itemType: 'search-backend', id: row.id } });
    });
    return btn;
  }

  /**
   * Start dragging a row in use to a new place. A press on the switch or a
   * button is theirs, not a grab.
   * @param {PointerEvent} start - The pointerdown
   * @param {HTMLElement} el - The row pressed
   * @param {HTMLElement} list - The list of rows in use
   * @param {string[]} inUseKeys - The keys in use, in order
   * @private
   */
  _beginDrag(start, el, list, inUseKeys) {
    if (start.button !== 0 || start.ctrlKey || inUseKeys.length < 2) return;
    const target = /** @type {HTMLElement|null} */ (start.target);
    if (target?.closest?.('button, input, label, a')) return;
    if (!pointerMayGrab(start)) return;
    startReorderDrag(start, {
      item: el,
      items: () => /** @type {HTMLElement[]} */ (Array.from(list.querySelectorAll(':scope > .web-search-row'))),
      strip: list,
      // The copy is parked beside the list, not in it, so it is not one of the
      // rows measured and rearranged around it.
      ghostHost: /** @type {HTMLElement} */ (list.parentElement),
      scrollContainer: /** @type {HTMLElement|null} */ (this.host.querySelector('.settings-content')),
      axis: 'y',
      classes: { ghost: 'drag-ghost', source: 'drag-source', dragging: 'is-dragging' },
      prepareGhost: (clone) => {
        // A copy of a row is not the row: it must not answer to its backend id
        // or own a duplicate of its switch's id.
        clone.removeAttribute('data-backend');
        for (const node of Array.from(clone.querySelectorAll('[id], [for]'))) {
          node.removeAttribute('id');
          node.removeAttribute('for');
        }
      },
      onDragStart: () => { this._dragging = true; },
      onDragEnd: () => {
        this._dragging = false;
        if (this._renderDeferred) {
          this._renderDeferred = false;
          this.render();
        }
      },
      onCommit: ({ fromIndex, toIndex }) => {
        if (fromIndex === toIndex) return;
        // Saved after onDragEnd has run, so the new order draws at once.
        queueMicrotask(() => { void this._save(this._withReady(moved(inUseKeys, fromIndex, toIndex))); });
      },
    });
  }

  /**
   * The order to store for a new list of ready backends in use. The stored
   * keys that are not ready now keep their slots — so a backend whose key or
   * extension comes back returns where it was — and the slots the ready ones
   * held take the new list in order; any left over go at the end.
   * @param {string[]} readyOrder - Ready backend keys in use, first choice first
   * @returns {string[]} The order to store
   * @private
   */
  _withReady(readyOrder) {
    const shown = new Set(this._rows().inUse.map((row) => row.key));
    const placing = new Set(readyOrder);
    const queue = [...readyOrder];
    /** @type {string[]} */
    const next = [];
    for (const key of this._order) {
      if (!shown.has(key) && !placing.has(key)) {
        next.push(key);
        continue;
      }
      const taken = queue.shift();
      if (taken !== undefined) next.push(taken);
    }
    return [...next, ...queue];
  }

  /**
   * Store an order, showing it at once and putting the old one back if the
   * server refuses.
   * @param {string[]} order - Backend keys, first choice first; empty for none
   * @returns {Promise<void>}
   * @private
   */
  async _save(order) {
    const previous = this._order;
    this._order = order;
    this.render();
    this._restoreFocus();
    try {
      this._order = await saveSearchOrder(order);
    } catch (err) {
      this._order = previous;
      showNotice(t("Couldn't save the web search order. {error}", { error: errorText(err) }));
    }
    this.render();
    this._restoreFocus();
    this._focusAfterSave = null;
  }

  /**
   * After a keyboard move redraws the list, put focus back on the switch that
   * was moved, so a second Alt+arrow keeps moving it.
   * @private
   */
  _restoreFocus() {
    const key = this._focusAfterSave;
    if (!key) return;
    const input = /** @type {HTMLInputElement|null} */ (
      this.host.querySelector(`#web-search-form .web-search-row[data-backend="${CSS.escape(key)}"] input`));
    input?.focus();
  }
}

/**
 * A settings row with a name, a description, and an empty control slot — the
 * shape of buildToggleRow's, for a row whose control is a link.
 * @param {string} name - Row title
 * @param {string} description - Row description
 * @returns {HTMLElement} The row
 */
function buildLinkRow(name, description) {
  const row = document.createElement('div');
  row.className = 'settings-group provider-field';
  const info = document.createElement('div');
  info.className = 'provider-info';
  const nameEl = document.createElement('div');
  nameEl.className = 'provider-name';
  nameEl.textContent = name;
  const desc = document.createElement('div');
  desc.className = 'provider-description';
  desc.textContent = description;
  info.append(nameEl, desc);
  const ctrl = document.createElement('div');
  ctrl.className = 'provider-control';
  row.append(info, ctrl);
  return row;
}

/**
 * @param {string[]} list - Keys
 * @param {number} from - Index to move
 * @param {number} to - Index it should end at
 * @returns {string[]} A new list with the move made
 */
function moved(list, from, to) {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}
