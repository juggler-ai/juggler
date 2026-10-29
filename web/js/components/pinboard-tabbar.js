//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <pinboard-tabbar> — the pinboard's middle band: one tab per pin, and a `+` that
 * never moves. Tabs wrap onto as many rows as they need. The board is a tall
 * narrow column with height to spare and width to spare nowhere, so a second row
 * of tabs costs less than hiding half of them behind a pair of arrows — and every
 * pin stays readable and one click away at any board width.
 *
 * The `+` is the strip's last child and pinned to the top, so it holds the same
 * corner however many rows the tabs take.
 *
 * It renders and reports, and decides nothing: selecting, removing and reordering
 * are emitted as events for {@link module:components/pinboard-panel} to route
 * through the host service. The board is shared state, and a tab strip is not the
 * place that edits it.
 *
 * Each visual tab is a wrapper holding a `role="tab"` button and a separate remove
 * button beside it — never one interactive control inside another. The wrapper is
 * `role="presentation"` so the tablist still sees only tabs.
 * @module components/pinboard-tabbar
 */

import JugglerElement from './juggler-element.js';
import { startReorderDrag } from '../utils/reorder-drag.js';
import { createDragGrip, pointerMayGrab } from '../utils/drag-grip.js';
import { t } from '../../sdk/lib/i18n.js';

/** The id the active tab labels — the one body the panel mounts into. */
export const PINBOARD_BODY_ID = 'pinboard-body';

/** Material "add" icon, for the `+`. */
const ADD_ICON_PATH = 'M440-440H200v-80h240v-240h80v240h240v80H520v240h-80v-240Z';

class PinboardTabbar extends JugglerElement {
  constructor() {
    super();
    /** @type {Array<{id: string, title: string, badge?: string}>} @private */
    this._tabs = [];
    /** @type {string|null} @private */
    this._activeId = null;
    /** @type {HTMLElement|null} @private */
    this._list = null;
    /** @type {HTMLButtonElement|null} @private */
    this._addButton = null;
    /** @type {boolean} @private Whether a reorder drag is arranging the strip. */
    this._dragging = false;
    /** @type {boolean} @private Whether a board change arrived while it was. */
    this._renderDeferred = false;
  }

  connectedCallback() {
    this._build();
    this.render();
  }

  /**
   * Show these tabs, with this one selected.
   * @param {Array<{id: string, title: string, badge?: string}>} tabs - One entry per pin, in board order.
   * @param {string|null} activeId - The selected pin's id.
   * @returns {void}
   */
  setTabs(tabs, activeId) {
    this._tabs = tabs;
    this._activeId = activeId;
    this.render();
  }

  /**
   * The `+` button, so the panel can anchor the add picker to it and put focus
   * back on it when the picker closes.
   * @returns {HTMLButtonElement|null} The add button.
   */
  getAddButton() {
    return this._addButton;
  }

  /**
   * Build the fixed chrome once: the wrapping tablist, and the `+` beside it.
   * @private
   */
  _build() {
    if (this._list) return;

    const list = document.createElement('div');
    list.className = 'pinboard-tabbar__list';
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-label', t('Pinned items'));

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'pinboard-tabbar__add';
    add.title = t('Add pin');
    add.setAttribute('aria-label', t('Add pin'));
    add.setAttribute('aria-haspopup', 'menu');
    add.setAttribute('aria-expanded', 'false');
    // eslint-disable-next-line juggler/escape-html-interpolation -- ADD_ICON_PATH is this module's constant path data
    add.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" aria-hidden="true"><path d="${ADD_ICON_PATH}"/></svg>`;
    this.on(add, 'click', () => this._emit('pinboard-add', {}));

    this.append(list, add);
    this._list = list;
    this._addButton = add;

    this.on(list, 'keydown', (e) => this._onKeyDown(/** @type {KeyboardEvent} */ (e)));
  }

  /**
   * Reconcile the tab elements with the current board. Tabs are reused by pin id
   * so a board change made elsewhere doesn't restart animations or swallow a
   * click that landed between press and release.
   */
  render() {
    const list = this._list;
    if (!list) return;
    // A drag has the strip arranged as the drop would leave it. Reconciling
    // against board order mid-gesture would snatch the tabs back from under the
    // pointer, so a change arriving now is drawn when the drag lets go.
    if (this._dragging) {
      this._renderDeferred = true;
      return;
    }

    /** @type {Map<string, HTMLElement>} */
    const existing = new Map();
    for (const el of Array.from(list.children)) {
      const id = /** @type {HTMLElement} */ (el).dataset.pinId;
      if (id) existing.set(id, /** @type {HTMLElement} */ (el));
    }

    let expected = list.firstChild;
    for (const tab of this._tabs) {
      const wrapper = existing.get(tab.id) || this._buildTab(tab.id);
      existing.delete(tab.id);
      this._fillTab(wrapper, tab);
      if (wrapper !== expected) list.insertBefore(wrapper, expected);
      expected = wrapper.nextSibling;
    }
    for (const stale of existing.values()) stale.remove();
  }

  /**
   * Build one tab: the selectable button, and the remove control beside it.
   * @param {string} pinId - The pin this tab stands for.
   * @returns {HTMLElement} The wrapper element.
   * @private
   */
  _buildTab(pinId) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pinboard-tab';
    wrapper.setAttribute('role', 'presentation');
    wrapper.dataset.pinId = pinId;
    wrapper.addEventListener('pointerdown', (e) => this._beginDrag(e, wrapper));
    // Selection is the whole tab's, not the button's. A tab is a button with a
    // grip beside it, and both of them look like the tab to whoever clicked:
    // landing on the grip and getting nothing is the tab refusing a click aimed
    // squarely at it. The bin is the one part that means something else, and it
    // stops its own click below.
    wrapper.addEventListener('click', () => this._emit('pinboard-select', { pinId }));

    // The grip a finger drags by — the shared one (utils/drag-grip.js). A touch
    // has no hover to reveal an affordance and no way to say "this is a drag and
    // not a scroll"; the grip's `touch-action: none` is what says it, and is why
    // a touch may only start a reorder from here.
    const grip = createDragGrip();

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pinboard-tab__button';
    button.id = `pinboard-tab-${pinId}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', PINBOARD_BODY_ID);
    // Reordering has to be reachable without a pointer, and the strip is the only
    // place that says so.
    button.setAttribute('aria-keyshortcuts', 'Alt+ArrowLeft Alt+ArrowRight');
    button.innerHTML = '<span class="pinboard-tab__label"></span><span class="pinboard-tab__badge" hidden></span>';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'pinboard-tab__remove';
    // A bin, not a cross: the tab goes and so does the pin behind it, which is
    // the same promise the conversation tabs' bin makes.
    remove.innerHTML = '<span class="icon-trashcan"></span>';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      this._emit('pinboard-remove', { pinId });
    });

    wrapper.append(grip, button, remove);
    return wrapper;
  }

  /**
   * Write a tab's current label, badge and selected state.
   * @param {HTMLElement} wrapper - The tab wrapper.
   * @param {{id: string, title: string, badge?: string}} tab - What it should say.
   * @private
   */
  _fillTab(wrapper, tab) {
    const active = tab.id === this._activeId;
    const button = /** @type {HTMLElement} */ (wrapper.querySelector('.pinboard-tab__button'));
    const label = /** @type {HTMLElement} */ (wrapper.querySelector('.pinboard-tab__label'));
    const badge = /** @type {HTMLElement} */ (wrapper.querySelector('.pinboard-tab__badge'));
    const remove = /** @type {HTMLElement} */ (wrapper.querySelector('.pinboard-tab__remove'));

    wrapper.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    // Roving tabindex: one stop for the whole strip, and the arrow keys move
    // within it.
    button.tabIndex = active ? 0 : -1;
    // No tooltip: it would only repeat the label the tab is already showing.
    label.textContent = tab.title;
    badge.textContent = tab.badge || '';
    badge.hidden = !tab.badge;
    // The label is for anything that cannot see a bin. A tooltip would only put
    // the same words under the pointer, on a control whose glyph has never
    // needed them.
    remove.setAttribute('aria-label', t('Remove {title} from Pinboard', { title: tab.title }));
  }

  /**
   * ARIA tabs keyboard behaviour, activating as it goes: the arrows move focus
   * and show the tab they land on, Enter/Space says so again for anyone who
   * expected to have to. Alt+arrow moves the tab itself.
   *
   * Showing the tab straight away is what the same arrows do everywhere else on
   * the board, and a strip whose arrows only pointed at tabs would be the one
   * place they mean something weaker. The cost is a pin mounted in passing on
   * the way to the far end of a wide board, which is a pin doing the work it was
   * pinned to do.
   * @param {KeyboardEvent} e - The keydown.
   * @private
   */
  _onKeyDown(e) {
    const button = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest?.('.pinboard-tab__button'));
    if (!button) return;
    const pinId = /** @type {string} */ (/** @type {HTMLElement} */ (button.parentElement).dataset.pinId);
    const index = this._tabs.findIndex((t) => t.id === pinId);
    if (index < 0) return;

    /** @param {number} to - Index to focus and show. */
    const goTo = (to) => {
      const buttons = Array.from(this.querySelectorAll('.pinboard-tab__button'));
      const at = Math.max(0, Math.min(buttons.length - 1, to));
      /** @type {HTMLElement|undefined} */ (buttons[at])?.focus();
      // Focus first: selecting redraws the strip, and the tab being moved to
      // should be the one holding its tab stop by the time it does.
      const tab = this._tabs[at];
      if (tab) this._emit('pinboard-select', { pinId: tab.id });
    };

    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        const delta = e.key === 'ArrowLeft' ? -1 : 1;
        if (e.altKey) this._emit('pinboard-move', { pinId, index: index + delta });
        else goTo(index + delta);
        break;
      }
      case 'Home':
        goTo(0);
        break;
      case 'End':
        goTo(this._tabs.length - 1);
        break;
      case 'Enter':
      case ' ':
        this._emit('pinboard-select', { pinId });
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  /**
   * Drag a tab to reorder it, on the strip's own gesture.
   *
   * A mouse grabs anywhere on the tab; a finger or a pen must grab the grip.
   * Nothing else claims a touch here, so without that gate the browser keeps the
   * gesture for its own (pan, zoom, a long-press menu) and cancels the drag
   * before it crosses its threshold — and were it not cancelled, every tap that
   * drifted five pixels would reorder the board.
   *
   * The strip wraps, so the drag is read in both axes and in reading order
   * across rows: the tabs rearrange into the order the drop would produce
   * rather than showing a marker predicting it. The move is emitted once, on
   * release, and the click that follows still selects the tab — having moved a
   * pin, looking at it is what you wanted.
   * @param {Event} e - The pointerdown.
   * @param {HTMLElement} wrapper - The tab being pressed.
   * @private
   */
  _beginDrag(e, wrapper) {
    const start = /** @type {PointerEvent} */ (e);
    if (start.button !== 0) return;
    // A macOS ctrl-click is a secondary click and arrives as button 0. It opens
    // a menu, which swallows the release, so it must not be taken for a grab.
    if (start.ctrlKey) return;
    const target = /** @type {HTMLElement|null} */ (start.target);
    // The bin removes the pin; grabbing the tab out from under that press would
    // take the click with it.
    if (target?.closest?.('.pinboard-tab__remove')) return;
    if (!pointerMayGrab(start)) return;
    const pinId = /** @type {string} */ (wrapper.dataset.pinId);
    if (this._tabs.findIndex((t) => t.id === pinId) < 0 || this._tabs.length < 2) return;
    const list = this._list;
    if (!list) return;

    startReorderDrag(start, {
      // The wrapper moves, and the wrapper answers to the click — so it also
      // takes the pointer, by default. A click goes to the common ancestor of
      // the press and the release, and capture is what the release retargets
      // to: capturing anywhere else would put the click above the listener,
      // wherever the press had landed.
      item: wrapper,
      items: () => /** @type {HTMLElement[]} */ (Array.from(list.children)),
      strip: list,
      // The clone is parked on the strip itself rather than in the list, so it
      // is not one of the tabs being measured and rearranged around it.
      ghostHost: this,
      axis: 'xy',
      wrap: true,
      classes: { ghost: 'drag-ghost', source: 'drag-source', dragging: 'is-dragging' },
      prepareGhost: (clone) => {
        // A copy of a tab is not a tab: it must not answer to a pin id, own a
        // duplicate of its button's id, or look selected to anything asking.
        clone.removeAttribute('data-pin-id');
        for (const el of Array.from(clone.querySelectorAll('[id], [aria-selected]'))) {
          el.removeAttribute('id');
          el.removeAttribute('aria-selected');
        }
      },
      onDragStart: () => { this._dragging = true; },
      onDragEnd: () => {
        this._dragging = false;
        // Draw whatever arrived while the strip was busy — including, after a
        // move, the board order this drag just asked for.
        if (this._renderDeferred) {
          this._renderDeferred = false;
          this.render();
        }
      },
      onCommit: ({ toIndex }) => this._emit('pinboard-move', { pinId, index: toIndex }),
    });
  }

  /**
   * @param {string} type - Event name.
   * @param {Record<string, any>} detail - What happened.
   * @private
   */
  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  }
}

customElements.define('pinboard-tabbar', PinboardTabbar);
