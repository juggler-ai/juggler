//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import LoadingOverlay from './loading-overlay.js';
import { markForTranslation } from '../../sdk/lib/i18n.js';

/**
 * Duration to show only the spinner before surfacing the message. Immediately
 * announcing a lost connection is alarming for the brief WS blips that recover
 * on their own.
 * @type {number}
 */
const SPINNER_ONLY_MS = 5000;

/**
 * The line the overlay opens on, before any tier is reached. Deliberately the
 * plainest thing that is true: most drops are a blip that recovers on its own,
 * and the wording for a wait that has gone wrong is worth having only when the
 * wait actually has.
 * @type {string}
 */
const OPENING_LINE = 'Reconnecting.';

/**
 * Wording for the wait as it drags on, mild to resigned, ordered longest wait
 * first. Each threshold is time the previous line spent in view (see
 * `LoadingOverlay._tick`), so every rung is one somebody has read before the
 * next one replaces it.
 * @type {ReadonlyArray<{afterMs: number, line: string}>}
 */
const MESSAGE_TIERS = Object.freeze([
  { afterMs: 8 * 60 * 1000, line: 'This isn’t going very well.' },
  { afterMs: 3 * 60 * 1000, line: 'Still trying.' },
  { afterMs: 60 * 1000, line: 'Lost the server.' },
  { afterMs: 20 * 1000, line: 'Still reconnecting.' },
]);

/**
 * Wording for the wait, restated as it drags on.
 * @param {number} waitedMs - Time spent waiting for the connection to return.
 * @returns {string} The line to show.
 */
function messageForWait(waitedMs) {
  const tier = MESSAGE_TIERS.find((candidate) => waitedMs >= candidate.afterMs);
  return tier ? tier.line : OPENING_LINE;
}

/**
 * DisconnectionOverlay
 *
 * The {@link LoadingOverlay} configured for a connection that has gone: a
 * message describing the wait, a retry countdown on its own line, and the server
 * URL it is trying to reach. The message restates itself as the wait grows (see
 * {@link MESSAGE_TIERS}), on time the page spent waiting IN VIEW — the rule that
 * makes the ladder worth climbing, and the base class's to enforce.
 *
 * It covers the whole window, header included, so in a desktop window it also
 * stands in for the header: it drags the window (window-chrome.css), and it
 * offers Stop trying and Close window. The frameless Windows and Linux caption
 * buttons stay above it (see LoadingOverlay#show).
 */
class DisconnectionOverlay extends LoadingOverlay {
  /**
   * The ways out are for a desktop window only. A browser tab has its own
   * chrome to close or move it by, cannot close itself, and has no stand-in to
   * become — so there, both are left out and the overlay offers none.
   * @param {object} [options] - The ways out of the wait this window has.
   * @param {(() => unknown)|null} [options.onClose] - Close the window.
   * @param {(() => unknown)|null} [options.onGiveUp] - Stop reconnecting now.
   */
  constructor({ onClose = null, onGiveUp = null } = {}) {
    /** @type {import('./loading-overlay.js').LoadingOverlayAction[]} */
    const actions = [];
    if (onGiveUp) actions.push({ label: markForTranslation('Stop trying'), onClick: onGiveUp });
    if (onClose) actions.push({ label: markForTranslation('Close window'), onClick: onClose });
    super({
      variant: 'disconnected',
      graceMs: SPINNER_ONLY_MS,
      lineForWait: messageForWait,
      detailLine: true,
      hostLine: true,
      actions
    });

    /** @type {number|null} @private */
    this._countdownInterval = null;
  }

  /**
   * Take the overlay off screen, and the countdown with it.
   */
  hide() {
    if (this._countdownInterval) {
      clearInterval(this._countdownInterval);
      this._countdownInterval = null;
    }
    super.hide();
  }

  /**
   * Start a countdown to the next retry, on its own line below the message.
   * @param {number} delayMs - Delay in milliseconds until next retry
   */
  startCountdown(delayMs) {
    // Clear any existing countdown
    if (this._countdownInterval) {
      clearInterval(this._countdownInterval);
    }

    let secondsRemaining = Math.ceil(delayMs / 1000);

    // Only show a number when there's an actual multi-second wait; anything
    // imminent leaves the line blank rather than flashing "1s".
    const updateCountdown = () => {
      this.setDetail(secondsRemaining > 1 ? `Retrying in ${secondsRemaining}s` : '');
    };

    // Show initial countdown
    updateCountdown();

    // Update every second
    this._countdownInterval = window.setInterval(() => {
      secondsRemaining--;
      if (secondsRemaining <= 0) {
        if (this._countdownInterval) {
          clearInterval(this._countdownInterval);
          this._countdownInterval = null;
        }
        this.setDetail('');
      } else {
        updateCountdown();
      }
    }, 1000);
  }
}

export default DisconnectionOverlay;
