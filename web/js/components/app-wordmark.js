//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { dragGuard } from '../utils/drag-guard.js';
import JugglerElement from './juggler-element.js';
import { t } from '../../sdk/lib/i18n.js';

/**
 * The header bar's wordmark: the one element a session's page and the server's
 * sessions page both put at the head of their header, and the About box's
 * button. Its drawing is the header's `.logo` (layout/app-shell.css), which the
 * markup gives it; a click, Enter or Space asks for the About box with
 * `juggler:open-about`, the event the desktop app's "About Juggler" menu item
 * dispatches, so whichever page holds an `<about-modal>` opens it.
 *
 * It is part of the window's drag region, and the release that ends a window
 * drag arrives as a click, which it lets pass.
 *
 * The server's sessions page loads this and the About box without the import
 * map a session's page has, so neither may reach a bare `juggler/*` specifier
 * (TestSessionsPageModulesResolveWithoutAnImportMap).
 * @module components/app-wordmark
 */
class AppWordmark extends JugglerElement {
  connectedCallback() {
    this.classList.add('logo');
    this.setAttribute('role', 'button');
    this.setAttribute('aria-label', t('About Juggler'));
    this.tabIndex = 0;
    const drag = dragGuard();
    this.on(this, 'pointerdown', drag.watch);
    this.on(this, 'click', () => { if (!drag.dragged()) this._openAbout(); });
    this.on(this, 'keydown', (/** @type {Event} */ e) => {
      const key = /** @type {KeyboardEvent} */ (e).key;
      if (key !== 'Enter' && key !== ' ') return;
      e.preventDefault();
      this._openAbout();
    });
  }

  /** @private */
  _openAbout() {
    window.dispatchEvent(new CustomEvent('juggler:open-about'));
  }
}

customElements.define('app-wordmark', AppWordmark);
