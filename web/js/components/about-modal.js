//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { markPopupOpen } from '../utils/popup-manager.js';
import { focusWhenShown } from '../utils/focus.js';
import { fetchJson } from '../services/http.js';
import { LOGO_WITH_NAME_SVG } from '../utils/juggler-logo.js';
import JugglerElement from './juggler-element.js';
import { apiUrl } from '../utils/api-url.js';
import { durationToken } from '../utils/modal-scrim.js';
import { markDialog, trapFocus } from '../utils/dialog-a11y.js';
import { t, markForTranslation, markUntranslated, htmlSlots, withHtml } from '../../sdk/lib/i18n.js';
import { escapeHtml } from '../../sdk/lib/html.js';
import { buildWordOfMouthAsk } from './word-of-mouth-ask.js';

/**
 * AboutModal - Shows information about the application
 *
 * Opens on `juggler:open-about` — which the header's wordmark dispatches
 * (components/app-wordmark.js), and so does the desktop app's "About Juggler"
 * menu item, so the native menu shows this box rather than the platform's own
 * about panel.
 * Displays app name, version, and a brief description with a link to the website.
 */
/** ms between the box opening and the first club leaving the hand. */
const CLUB_LEAD_IN = 600;

/** Shown in place of the version when the server does not give one. */
const UNKNOWN_VERSION = markForTranslation('Unknown');

class AboutModal extends JugglerElement {
  constructor() {
    super();
    /** @type {boolean} @private */
    this._isOpen = false;
    /** @type {string} @private */
    this._version = '';
    /** @type {(() => void)|null} @private */
    this._releasePopupOpen = null;
    /** @type {(() => void)|null} @private */
    this._releaseTrap = null;
    /** @type {Animation[]} @private */
    this._clubAnimations = [];
    /** @type {ReturnType<typeof setTimeout>|null} @private - Ends the exit. */
    this._exitTimer = null;
    // Bumped by every render, so a stale entrance can't start a throw.
    /** @type {number} @private */
    this._renderCount = 0;
  }

  connectedCallback() {
    this.classList.add('modal-shell');
    this.render();
    this.addCleanup(() => this._cancelClubThrows());
    this.addCleanup(() => this._cancelExit());
    this.addCleanup(() => this._releaseFocusTrap());
    this.onWindow('juggler:open-about', () => { void this.open(); });
  }

  /**
   * Fetch version from the API
   * @private
   * @returns {Promise<string>} The version string or 'Unknown' on error
   */
  async _fetchVersion() {
    const data = await fetchJson(apiUrl('/version'), {
      errorPrefix: markUntranslated('[AboutModal] Failed to fetch version'), // only logged: the fallback swallows the error
      fallback: null,
    });
    return data?.version || UNKNOWN_VERSION;
  }

  /**
   * Open the about modal
   */
  async open() {
    // Fetch version if not already loaded
    if (!this._version) {
      this._version = await this._fetchVersion();
    }

    this._isOpen = true;
    this._cancelExit();
    this.render();

    // Escape and the browser/mobile Back button dismiss via popup-manager.
    if (!this._releasePopupOpen) {
      this._releasePopupOpen = markPopupOpen(() => this._close());
    }
    if (!this._releaseTrap) this._releaseTrap = trapFocus(this);
  }

  /** @private */
  _releaseFocusTrap() {
    this._releaseTrap?.();
    this._releaseTrap = null;
  }

  /**
   * Close the about modal. It is closed from this moment — Escape and the
   * shortcuts behind it are released, a second close does nothing — but it
   * stays on screen just long enough to leave (`.is-closing` in
   * about-modal.css), taking no pointer events while it does.
   * @private
   */
  _close() {
    if (!this._isOpen) return;
    this._isOpen = false;
    this._cancelClubThrows();
    this.classList.add('is-closing');
    const exit = Math.max(durationToken('--popup-exit-duration', 160), durationToken('--modal-scrim-fade', 200));
    this._exitTimer = setTimeout(() => {
      this._exitTimer = null;
      this.render();
    }, exit);

    if (this._releasePopupOpen) {
      this._releasePopupOpen();
      this._releasePopupOpen = null;
    }
    this._releaseFocusTrap();
  }

  /** @private */
  _cancelExit() {
    if (this._exitTimer !== null) clearTimeout(this._exitTimer);
    this._exitTimer = null;
    this.classList.remove('is-closing');
  }

  /** @private */
  render() {
    this._cancelClubThrows();
    const renderCount = ++this._renderCount;
    if (!this._isOpen) {
      this.classList.remove('is-closing');
      this.innerHTML = '';
      return;
    }

    const author = { author: '<a href="https://github.com/julianstorer" target="_blank" rel="noopener noreferrer" style="white-space: nowrap">Julian Storer</a>' };
    const version = this._version === UNKNOWN_VERSION ? t(UNKNOWN_VERSION) : this._version;
    // i18n-ignore: the only literal text left is the site's URL, shown as written
    this.innerHTML = `
            <modal-backdrop class="about-backdrop"></modal-backdrop>
            <modal-panel class="about-container">
                <header class="about-header">
                    <div class="about-logo">${LOGO_WITH_NAME_SVG}</div>
                    <span class="about-version">${escapeHtml(version)}</span>
                </header>

                <main class="about-content">
                    <p class="about-description">
                        ${escapeHtml(t('A plugin-powered visual AI coding agent.'))}
                    </p>
                    <p class="about-description">
                        ${withHtml(t('Created in a moment of madness by {author}', htmlSlots(author)), author)}
                    </p>
                    <p class="about-description">
                      ${escapeHtml(t('Juggler is still very new, and I\'d love to hear people\'s opinions about it - please visit the discord group to chat or hear more about the roadmap!'))}
                    </p>
                    <p class="about-link">
                        <a href="https://juggler.studio" target="_blank" rel="noopener noreferrer">https://juggler.studio</a>
                    </p>
                    <p class="about-link">
                        <a href="https://discord.gg/HyqZwKvSMd" target="_blank" rel="noopener noreferrer">${escapeHtml(t('Click here to join the discord server'))}</a>
                    </p>
                </main>

                <footer class="about-footer">
                    <button class="about-button btn-primary" id="about-close">
                        ${escapeHtml(t('Close'))}
                    </button>
                </footer>
            </modal-panel>
        `;

    // The box's heading is the logo, so it is named in words.
    markDialog(this.querySelector('.about-container'), t('About Juggler'));

    // The "spread the word" ask, kept here for good (components/word-of-mouth.js).
    this.querySelector('.about-content')?.appendChild(buildWordOfMouthAsk({ variant: 'about' }));

    // Attach event listeners
    const backdrop = this.querySelector('.about-backdrop');
    if (backdrop) {
      backdrop.addEventListener('click', () => this._close());
    }

    const closeButton = this.querySelector('#about-close');
    if (closeButton) {
      closeButton.addEventListener('click', () => this._close());
      // Focus the close button
      focusWhenShown(/** @type {HTMLElement} */ (closeButton));
    }

    // Opening and clicking the logo both start a short three-club cascade.
    const logo = /** @type {HTMLElement|null} */ (this.querySelector('.about-logo'));
    if (logo) {
      // Keep the full flight inside the SVG's own painting surface; overflow
      // alone does not expand the raster bounds of accelerated SVG animations.
      logo.querySelector('svg')?.setAttribute('viewBox', '-40 -140 176.238 308.263');
      logo.addEventListener('click', () => this._throwClubs(logo));

      // The throw is sized from the logo's on-screen rect, and the panel spends
      // its entrance scaled and lifted, so the first throw waits for it to land
      // — taking the entrance out of the usual lead-in, so the clubs leave the
      // hand when they always did.
      const panel = /** @type {HTMLElement} */ (this.querySelector('.about-container'));
      const entrance = panel.getAnimations().find((a) => 'animationName' in a);
      if (!entrance) {
        this._throwClubs(logo);
      } else {
        const took = Number(entrance.effect?.getComputedTiming().duration) || 0;
        entrance.finished.then(() => {
          if (renderCount === this._renderCount && this._isOpen) this._throwClubs(logo, Math.max(0, CLUB_LEAD_IN - took));
        }, () => {});
      }
    }
  }

  /** @private */
  _cancelClubThrows() {
    for (const animation of this._clubAnimations) animation.cancel();
    this._clubAnimations = [];
  }

  /**
   * Four alternating throws per club, separated by a hand's catching/scooping
   * beat. Travel is sampled from x = lerp(start, end), y = lerp(start, end)
   * - 4h t(1-t): constant horizontal velocity and constant downward acceleration.
   * Rotation is independent, one full turn per flight, with no spin in the hand.
   * All lengths are SVG user units, so the whole cascade scales with the logo.
   * @param {HTMLElement} logo
   * @param {number} [leadIn] - ms before the first club leaves the hand.
   * @private
   */
  _throwClubs(logo, leadIn = CLUB_LEAD_IN) {
    this._cancelClubThrows();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const svg = /** @type {SVGSVGElement} */ (logo.querySelector('svg'));
    const rect = svg.getBoundingClientRect();
    const scale = rect.height / svg.viewBox.baseVal.height;
    const inkTop = rect.top - svg.viewBox.baseVal.y * scale;
    // Reserve half a spinning club plus a small margin at the viewport's top.
    const height = Math.max(0, Math.min(110, (inkTop - 24) / scale));
    const flight = 900;
    const hold = 450;
    const duration = 4 * flight + 3 * hold;

    logo.querySelectorAll('.logo-club').forEach((node, index) => {
      const club = /** @type {SVGGElement} */ (node);
      const box = club.getBBox();
      const homeX = box.x + box.width / 2;
      const homeY = box.y + box.height / 2;
      /** @type {Keyframe[]} */
      const travel = [];
      /** @type {Keyframe[]} */
      const spin = [];
      let x = 0;
      let y = 0;
      let angle = 0;
      /** @type {(time: number, dx: number, dy: number, rotation: number) => void} */
      const frame = (time, dx, dy, rotation) => {
        travel.push({ offset: time / duration, transform: `translate(${dx}px, ${dy}px)` });
        spin.push({ offset: time / duration, transform: `rotate(${rotation}deg)` });
      };

      for (let round = 0; round < 4; round++) {
        const start = round * (flight + hold);
        const right = (round + index) % 2 === 0;
        const targetX = round === 3 ? 0 : (right ? 48 : -18) - homeX;
        const targetY = round === 3 ? 0 : 18 - homeY;
        const turn = right ? 360 : -360;
        for (let step = 0; step <= 24; step++) {
          const t = step / 24;
          frame(start + t * flight, x + (targetX - x) * t,
            y + (targetY - y) * t - 4 * height * t * (1 - t), angle + turn * t);
        }
        angle += turn;
        x = targetX;
        y = targetY;
        if (round < 3) {
          // Catch on the outside, scoop down and inward, then launch across.
          for (let step = 1; step <= 8; step++) {
            const t = step / 8;
            frame(start + flight + t * hold, x + (right ? -12 : 12) * t,
              y + 5 * Math.sin(Math.PI * t), angle);
          }
          x += right ? -12 : 12;
        }
      }
      const options = { duration, delay: leadIn + index * hold, easing: 'linear', fill: /** @type {FillMode} */ ('both') };
      this._clubAnimations.push(
        club.animate(travel, { ...options, id: 'about-club-flight' }),
        /** @type {SVGGElement} */ (club.querySelector('.logo-spin')).animate(spin, { ...options, id: 'about-club-spin' }),
      );
    });
  }
}

customElements.define('about-modal', AboutModal);
