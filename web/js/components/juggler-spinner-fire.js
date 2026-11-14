//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The fire on a `<juggler-spinner>`'s clubs, lit once the conversation behind
 * it is long. The spinner owns one {@link SpinnerFire} and tells it the context
 * size; everything about the fire — when it lights, how big it burns, its
 * markup, keeping it upright, putting it out — lives here.
 *
 * The look is CSS ("Fire" in patterns/spinner.css): the markup below hangs
 * inside each `.spinner-club`, and three nested wrappers run the club's own
 * rotations backwards so the flames burn upward whatever the club is doing.
 * That only holds while each wrapper reads exactly the time of the rotation
 * it undoes, which is the one thing this controller has to keep true.
 * @module components/juggler-spinner-fire
 */

import { animationNamed, matchClock } from '../utils/animation-clock.js';

/** When the fire lights and how it grows. Compile-time, like the spinner's own tuning. */
const FIRE = Object.freeze({
  /** Context size, in tokens, at which the clubs catch fire. */
  fromTokens: 250000,
  /** Context size at which the flames reach {@link FIRE.maxIntensity}. */
  fullTokens: 750000,
  /** Flame size on first catching, as a multiple of the CSS flame. */
  minIntensity: 0.6,
  /** Largest the flames grow. */
  maxIntensity: 1.25,
  /** Intensity steps, so a context creeping up a token at a time leaves the flames alone. */
  step: 0.05,
  /**
   * How long the fire takes to die back into the wick before its markup is
   * removed; the CSS going-out transition (--duration-slower).
   */
  outMs: 300,
});

/**
 * The fire on one club, appended inside its `.spinner-club`. Only present while
 * the spinner burns: the animations it carries are not free, and a spinner that
 * never burns should not run them.
 */
const FIRE_HTML = '<span class="spinner-fire"><span class="spinner-fire-unspin"><span class="spinner-fire-upright">'
  + '<span class="spinner-fire-lean"><span class="spinner-fire-glow"></span>'
  + '<span class="spinner-flame"></span><span class="spinner-flame"></span></span></span></span></span>';

/**
 * The fire's wrappers whose animations run on the cascade's clock, and so take
 * its playback rate. The flicker keeps its own: fire does not slow down when
 * the juggler does.
 */
export const FIRE_CLOCKED = '.spinner-fire-unspin, .spinner-fire-upright, .spinner-fire-lean';

/**
 * Flame intensity for a context size: none below the threshold, then a linear
 * ramp across the range, in {@link FIRE.step} steps.
 * @param {number} tokens - Context size.
 * @returns {number} Intensity, or 0 for no fire.
 */
function fireIntensity(tokens) {
  const n = Number(tokens);
  if (!Number.isFinite(n) || n < FIRE.fromTokens) return 0;
  const f = Math.min(1, (n - FIRE.fromTokens) / (FIRE.fullTokens - FIRE.fromTokens));
  const raw = FIRE.minIntensity + f * (FIRE.maxIntensity - FIRE.minIntensity);
  return Math.round(raw / FIRE.step) * FIRE.step;
}

/**
 * Put a club's fire on its club's clocks: the unspin on the club's flip (same
 * delay, so same time is same angle), the upright and lean wrappers on its
 * orbit. Called once the club's own clocks are right.
 * @param {Element} club - A `.spinner-club` carrying fire.
 */
function syncToClub(club) {
  const flip = animationNamed(club, 'juggler-spinner-spin');
  const orbit = animationNamed(club.parentElement, 'juggler-spinner-orbit');
  matchClock(club.querySelector('.spinner-fire-unspin'), flip);
  matchClock(club.querySelector('.spinner-fire-upright'), orbit);
  matchClock(club.querySelector('.spinner-fire-lean'), orbit);
}

export default class SpinnerFire {
  /**
   * @param {HTMLElement} host - The spinner.
   * @param {() => void} onAnimationsChanged - Called after fire is added to or
   *   removed from the clubs, so the spinner can re-read its animations and
   *   give the new ones its playback rate.
   */
  constructor(host, onAnimationsChanged) {
    /** @private */ this._host = host;
    /** @private */ this._changed = onAnimationsChanged;
    /** @type {number} @private Flame intensity shown; 0 when not on fire. */
    this._intensity = 0;
    /** @type {any} @private Pending removal of a fire that has gone out. */
    this._outTimer = 0;
  }

  /** @returns {boolean} Whether the clubs are burning. */
  get lit() {
    return this._intensity > 0;
  }

  /** @returns {string} Fire markup for a club joining the cascade now. */
  get clubMarkup() {
    return this.lit ? FIRE_HTML : '';
  }

  /**
   * How long the conversation's context is, in tokens. Lights, resizes or puts
   * out the fire to match.
   * @param {number} tokens - Context size.
   */
  setContext(tokens) {
    const want = fireIntensity(tokens);
    if (want === this._intensity) return;
    const wasLit = this.lit;
    this._intensity = want;
    if (want > 0) this._host.style.setProperty('--spinner-fire-intensity', want.toFixed(2));
    if (want > 0 && !wasLit) this._ignite();
    else if (want === 0) this._extinguish();
  }

  /**
   * Bring the fire on a club that has just joined a burning cascade into step.
   * Its markup came with it ({@link clubMarkup}); call once the club's own
   * orbit and flip are in phase.
   * @param {Element} club - The new `.spinner-club`.
   */
  join(club) {
    if (this.lit) syncToClub(club);
  }

  /**
   * The spinner is leaving the document. A fire still dying down is put out
   * now: its timer goes with the spinner, and markup left behind would run its
   * animations unseen once reattached.
   */
  dispose() {
    if (this._outTimer) this._remove();
  }

  /**
   * Light every club. The fire is built unlit (the CSS holds it at scale 0) and
   * committed with a synchronous reflow before `is-on-fire` goes on, so the
   * flare-up has a state to run from — a reflow rather than a frame, because an
   * occluded window delivers no frames.
   * @private
   */
  _ignite() {
    this._cancelRemoval();
    for (const club of Array.from(this._host.querySelectorAll('.spinner-club'))) {
      if (club.querySelector('.spinner-fire')) continue; // still dying down: relit where it stands
      club.insertAdjacentHTML('beforeend', FIRE_HTML);
      syncToClub(club);
    }
    this._changed();
    void this._host.offsetHeight;
    this._host.classList.add('is-on-fire');
  }

  /**
   * Put the fire out: it dies back into the wick, then its markup goes.
   * @private
   */
  _extinguish() {
    this._host.classList.remove('is-on-fire');
    this._cancelRemoval();
    this._outTimer = setTimeout(() => this._remove(), FIRE.outMs);
  }

  /**
   * Remove the fire markup, unless the fire has been relit meanwhile.
   * @private
   */
  _remove() {
    this._cancelRemoval();
    if (this.lit) return;
    for (const fire of Array.from(this._host.querySelectorAll('.spinner-fire'))) fire.remove();
    this._changed();
  }

  /** @private */
  _cancelRemoval() {
    clearTimeout(this._outTimer);
    this._outTimer = 0;
  }
}
