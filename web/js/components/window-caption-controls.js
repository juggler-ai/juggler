//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Caption controls — minimise / maximise-restore / close buttons for the
 * frameless Windows and Linux windows.
 *
 * The desktop window strips the native title bar on Windows (Win32 caption) and
 * Linux (GTK decorations) — see cmd/juggler-app/window_frame_{windows,linux}.go
 * — so the app's own header fills the top of the window, matching the frameless
 * macOS look. macOS keeps its native traffic lights via the transparent
 * MacTitleBar, so it needs no HTML controls; Windows and Linux are the platforms
 * left without window buttons, which this element supplies. The buttons and
 * their glyphs are shared across both; only the CSS chrome differs (flat
 * full-height caption on Windows, rounded Adwaita-style buttons on Linux).
 *
 * Inert everywhere else:
 *   - Remote browsers and the macOS window: CSS keeps the element
 *     `display: none` (it only shows under [data-window-platform="windows"] and
 *     ["linux"] in window-mode), and connectedCallback bails before wiring
 *     anything.
 *
 * Buttons drive the native window through the window-control endpoint (see
 * _control / window-control.js). The maximise glyph flips to a "restore" glyph
 * while the window is maximised, kept in sync with the native state via the
 * runtime's maximise events (which also fire when the user double-clicks the
 * drag region or uses Win+Up).
 */

import { windowControlURL } from '../../sdk/lib/window-control.js';
import { fetchJson } from '../services/http.js';
import JugglerElement from './juggler-element.js';
import { t } from '../../sdk/lib/i18n.js';
import { escapeHtml } from '../../sdk/lib/html.js';
import { glyphSvg } from './window-caption-glyphs.js';

class WindowCaptionControls extends JugglerElement {
  connectedCallback() {
    const root = document.documentElement;
    // Only the frameless in-process windows (Windows, Linux) get caption
    // buttons. Bail in remote browsers, the macOS window (native traffic
    // lights), and any non-window tab.
    const platform = root.dataset.windowPlatform;
    if (root.dataset.windowMode !== '1' || (platform !== 'windows' && platform !== 'linux')) {
      return;
    }
    // Buttons drive the native window through the loopback /api/window/
    // control endpoint (see _control). The Wails runtime is only consulted
    // for best-effort inbound maximise events, so we don't require it.
    const wails = /** @type {any} */ (window).wails || {};

    if (this.childElementCount === 0) {
      const minimiseHtml = escapeHtml(t('Minimise'));
      const maximiseHtml = escapeHtml(t('Maximise'));
      const closeHtml = escapeHtml(t('Close'));
      this.innerHTML = `
                <button type="button" class="window-caption-btn" data-action="minimise"
                        aria-label="${minimiseHtml}" title="${minimiseHtml}">${glyphSvg('minimise')}</button>
                <button type="button" class="window-caption-btn" data-action="maximise"
                        aria-label="${maximiseHtml}" title="${maximiseHtml}">${glyphSvg('maximise')}</button>
                <button type="button" class="window-caption-btn window-caption-btn--close" data-action="close"
                        aria-label="${closeHtml}" title="${closeHtml}">${glyphSvg('close')}</button>
            `;
    }

    this._maxBtn = this.querySelector('[data-action="maximise"]');
    this.on(this, 'click', (e) => {
      // The click can land on a button or the SVG glyph inside it; both
      // expose closest(). Walk up to the button carrying the action.
      const node = e.target;
      const btn = (node instanceof HTMLElement || node instanceof SVGElement)
        ? node.closest('[data-action]') : null;
      const action = btn?.getAttribute('data-action');
      if (action) this._control(action);
    });

    // Best-effort: reflect OS-driven maximise changes (snap, Win+Up,
    // double-click drag region) onto the glyph. These inbound events are
    // injected by the native side and work even though the outbound
    // Window.* RPC does not, so we keep the subscription when present.
    if (wails.Events?.On) {
      this.addCleanup(wails.Events.On('common:WindowMaximise', () => this._renderMaxGlyph(true)));
      this.addCleanup(wails.Events.On('common:WindowUnMaximise', () => this._renderMaxGlyph(false)));
    }
    // Seed the glyph from the current native state.
    this._control('state');
  }

  /**
   * Drive the native window via the window-control endpoint (the in-process
   * server today, or the desktop app's loopback endpoint via nativeCtl), then
   * sync the maximise/restore glyph from the reported state. The Wails
   * runtime's Window.* RPC can't be used here — it routes through
   * /wails/runtime, which our plain-http page load bypasses.
   * @param {string} action - minimise | maximise | close | state
   */
  _control(action) {
    const url = windowControlURL('control', '?action=' + encodeURIComponent(action));
    if (!url) return; // no native host to drive
    // A window closing or a transient failure leaves nothing to sync.
    fetchJson(url, { method: 'POST', fallback: null })
      .then((data) => { if (data) this._renderMaxGlyph(!!data.maximised); });
  }

  /** @param {boolean} maximised */
  _renderMaxGlyph(maximised) {
    if (!this._maxBtn) return;
    this._maxBtn.innerHTML = glyphSvg(maximised ? 'restore' : 'maximise');
    const label = maximised ? t('Restore') : t('Maximise');
    this._maxBtn.setAttribute('aria-label', label);
    this._maxBtn.setAttribute('title', label);
  }
}

customElements.define('window-caption-controls', WindowCaptionControls);
