//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <window-border-button> — the header's control for the window border
 * (utils/window-border.js) and the project's colour (utils/project-colour.js),
 * in the view group beside zoom and theme, in a project's window and in a
 * detached board's.
 *
 * Its icon is a frame drawn in the project's colour whether or not the border
 * is on — solid while it is, dashed while it is not — so the button also says
 * which colour this project is. Its menu is a row of swatches led by "None",
 * and holds two scopes: whether this window has a border is this window's
 * alone ("None" turns it off, any colour turns it on); which colour it is, and
 * "Use automatic colour", are the project's, for every one of its windows on
 * this machine, which recolour at once.
 *
 * On a narrow header the button folds out of the row with zoom and is lent to
 * the "…" popup (utils/header-overflow-menu.js), so its menu may open from
 * inside that one, which stays open under it (presentPopup's `nested: 'auto'`).
 *
 * The menu is a standard `.dropdown-menu` presented by presentPopup, so it has
 * the shared chrome, placement, phone sheet and dismissal.
 * @module components/window-border-button
 */

import { presentPopup } from '../utils/popup-surface.js';
import { applyMenuRoles, attachMenuKeyboard, focusMenuItem } from '../utils/menu-roles.js';
import { t } from '../../sdk/lib/i18n.js';
import {
  PROJECT_COLOURS, PROJECT_COLOURS_EVENT, automaticProjectColour, pickedProjectColour, projectColour,
  projectColourLabel, projectColourValue, setProjectColour, thisProjectKey,
} from '../utils/project-colour.js';
import { isWindowBorderOn, setWindowBorder, WINDOW_BORDER_EVENT } from '../utils/window-border.js';
import JugglerElement from './juggler-element.js';

/** Popup id: opening another popup dismisses this menu, and vice versa. */
const POPUP_ID = 'window-border-menu';

/** A frame, stroked in the project's colour (components/project-colour.css). */
const FRAME_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">'
  + '<rect class="project-colour-button__frame" x="4" y="4" width="16" height="16" rx="3.5"/></svg>';

class WindowBorderButton extends JugglerElement {
  constructor() {
    super();
    /** @type {HTMLButtonElement|null} @private */
    this._button = null;
    /** @type {HTMLElement|null} @private - The open menu's surface. */
    this._menu = null;
    /** @type {(() => void)|null} @private - presentPopup teardown for the open menu. */
    this._release = null;
  }

  connectedCallback() {
    this._build();
    // Per connection, not in _build: the "…" popup lends the button by moving
    // it, and every disconnect drains this element's listeners.
    this.on(/** @type {HTMLButtonElement} */ (this._button), 'click', (e) => {
      e.stopPropagation();
      if (this._release) this._closeMenu();
      else this._openMenu();
    });
    this.onWindow(WINDOW_BORDER_EVENT, () => this.render());
    this.onWindow(PROJECT_COLOURS_EVENT, () => this.render());
    this.render();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._closeMenu();
  }

  /**
   * Build the button once.
   * @private
   */
  _build() {
    if (this._button) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-ghost btn-icon-header project-colour-button';
    btn.id = 'window-border-button';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = FRAME_SVG;
    this.appendChild(btn);
    this._button = btn;
  }

  /**
   * Draw the button, and the menu if it is open, as the preferences stand.
   * @returns {void}
   */
  render() {
    const key = thisProjectKey();
    // A page with no project has no colour to show or border to draw.
    this.hidden = !key;
    if (!this._button || !key) return;
    const on = isWindowBorderOn();
    this.style.setProperty('--project-colour', projectColourValue(projectColour(key)));
    this._button.classList.toggle('is-active', on);
    const title = on ? t('Window border: on') : t('Window border: off');
    this._button.title = title;
    this._button.setAttribute('aria-label', title);
    if (this._menu) this._fillMenu();
  }

  /**
   * Open the menu under the button.
   * @private
   */
  _openMenu() {
    if (!this._button || !thisProjectKey()) return;
    this._closeMenu();
    const menu = document.createElement('nav');
    menu.className = 'dropdown-menu project-colour-menu is-open';
    this._menu = menu;
    this._fillMenu(true);
    this._button.setAttribute('aria-expanded', 'true');
    this._release = presentPopup({
      surface: menu,
      anchor: this._button,
      id: POPUP_ID,
      onClose: () => this._closeMenu(),
      align: 'right',
      gap: 6,
      insideSelectors: ['.project-colour-menu', this._button],
      // Lent to the "…" popup on a narrow header, the button opens this from
      // inside it, which must stay open under it.
      nested: 'auto',
    });
  }

  /**
   * Fill the open menu: the swatches, "None" first, then "Use automatic
   * colour". A refill keeps the keyboard on the row it was on.
   * @param {boolean} [first] - Whether the menu is just opening, when it takes
   *   the focus if a key opened it.
   * @private
   */
  _fillMenu(first = false) {
    if (!this._menu) return;
    const key = thisProjectKey();
    const on = isWindowBorderOn();
    const picked = pickedProjectColour(key);
    const automatic = automaticProjectColour(key);
    const current = picked ?? automatic;
    const list = document.createElement('menu');

    // No visible heading: a row of swatches under the border button says what
    // it is. The project scope is still named to a screen reader. One radio
    // group: "None" while this window has no border, else the colour in use.
    const swatches = document.createElement('li');
    swatches.className = 'project-colour-menu__swatches';
    swatches.setAttribute('role', 'group');
    swatches.setAttribute('aria-label', t('Border colour for this project'));

    const none = document.createElement('span');
    none.className = 'project-colour-swatch project-colour-swatch--none';
    none.dataset.colour = 'none';
    none.setAttribute('role', 'menuitemradio');
    none.setAttribute('aria-checked', String(!on));
    none.title = t('None');
    none.setAttribute('aria-label', t('None'));
    none.addEventListener('click', (e) => {
      e.stopPropagation();
      // "None" is this window's: it hides the border here and leaves the
      // project's colour as it is for its other windows.
      if (isWindowBorderOn()) void setWindowBorder(false);
      // The change event redraws the menu (render).
    });
    swatches.append(none);

    for (const name of PROJECT_COLOURS) {
      const swatch = document.createElement('span');
      swatch.className = 'project-colour-swatch';
      swatch.dataset.colour = name;
      swatch.setAttribute('role', 'menuitemradio');
      swatch.setAttribute('aria-checked', String(on && name === current));
      swatch.style.setProperty('--project-colour', projectColourValue(name));
      if (name === automatic) swatch.classList.add('is-automatic');
      const label = name === automatic
        ? t('{colour} (automatic)', { colour: projectColourLabel(name) })
        : projectColourLabel(name);
      swatch.title = label;
      swatch.setAttribute('aria-label', label);
      swatch.addEventListener('click', (e) => {
        e.stopPropagation();
        // Picking the automatic colour is going back to it, so nothing is
        // stored that the hash already says.
        void setProjectColour(key, name === automatic ? null : name);
        // Picking a colour is asking to see it, so it turns this window's
        // border on.
        if (!isWindowBorderOn()) void setWindowBorder(true);
      });
      swatches.append(swatch);
    }
    list.append(swatches);

    const reset = document.createElement('li');
    reset.className = picked ? 'menu-item' : 'menu-item menu-item-unavailable';
    const resetName = document.createElement('span');
    resetName.className = 'menu-item-name';
    resetName.textContent = t('Use automatic colour');
    reset.append(resetName);
    reset.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pickedProjectColour(key)) void setProjectColour(key, null);
    });
    list.append(reset);

    const focused = Array.from(this._menu.querySelectorAll('[role^="menuitem"]')).indexOf(/** @type {Element} */ (document.activeElement));
    applyMenuRoles(list, t('Window border'));
    this._menu.replaceChildren(list);
    attachMenuKeyboard(list, { close: () => this._closeMenu(), autoFocus: first });
    const again = /** @type {HTMLElement|undefined} */ (list.querySelectorAll('[role^="menuitem"]')[focused]);
    if (focused >= 0 && again) focusMenuItem(list, again);
  }

  /** @private */
  _closeMenu() {
    const release = this._release;
    this._release = null;
    this._menu = null;
    this._button?.setAttribute('aria-expanded', 'false');
    release?.();
  }
}

customElements.define('window-border-button', WindowBorderButton);
