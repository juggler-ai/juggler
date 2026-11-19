//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * How long the pin has been out of sight, so that coming back after a while
 * reads everything again. The pin's watch keeps it current while hidden, but a
 * missed change would otherwise sit there until Refresh is pressed, and a
 * reader coming back after some time is the one most likely to notice.
 *
 * Several things can hide the pin at once — another board tab, the board put
 * away, the window in the background — each a reason of its own. The absence
 * runs from when the first of them began until the last of them ended.
 * @module pins/git/absence
 */

/** How long out of sight before coming back reads everything again. */
export const STALE_AFTER_MS = 30_000;

/** @type {() => number} The clock an absence reads unless given its own. */
let clock = () => Date.now();

/**
 * Put the absences' clock under a test's control; null puts the real one back.
 * Stubbing `Date.now` instead would stop the test harness's own deadlines.
 * @param {(() => number)|null} next - The clock.
 */
export function __setAbsenceClockForTests(next) {
  clock = next || (() => Date.now());
}

/**
 * @typedef {object} Absence
 * @property {(reason: string, hidden: boolean) => void} set - One reason the pin is hidden began or ended.
 * @property {() => boolean} isAway - Whether any reason holds.
 */

/**
 * @param {object} opts
 * @param {() => void} opts.onReturn - Back in sight after more than `after`.
 * @param {number} [opts.after] - The absence that makes a return worth a read.
 * @param {() => number} [opts.now] - The clock.
 * @returns {Absence} The absence.
 */
export function createAbsence({ onReturn, after = STALE_AFTER_MS, now = () => clock() }) {
  /** @type {Set<string>} */
  const reasons = new Set();
  let since = 0;
  return {
    set: (reason, hidden) => {
      const was = reasons.size > 0;
      if (hidden) reasons.add(reason);
      else reasons.delete(reason);
      const is = reasons.size > 0;
      if (!was && is) since = now();
      else if (was && !is && now() - since > after) onReturn();
    },
    isAway: () => reasons.size > 0,
  };
}
