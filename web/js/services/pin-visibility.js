//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Whether one mounted pin can be seen, as the board knows it — the
 * `visibility` on its context.
 *
 * Several things can put a pin out of sight at once: the board put away,
 * another tab in front of a retained pin, the window in the background, the pin
 * scrolled out of view. Each is a reason of its own, set and cleared by
 * whatever knows about it, and the pin is in sight only while none holds. A pin
 * is told only when the answer changes, so one reason beginning while another
 * already holds is no news.
 * @module services/pin-visibility
 */

/** @typedef {import('juggler/pinboard-item-type').PinVisibility} PinVisibility */

/**
 * @typedef {object} PinSight
 * @property {PinVisibility} api - What the pin is handed.
 * @property {(reason: string, hidden: boolean) => void} set - One reason the pin
 *   is out of sight began or ended.
 * @property {() => void} end - The pin is gone: drop every listener, and answer
 *   out of sight from now on.
 */

/**
 * @param {object} opts
 * @param {(fn: (visible: boolean) => void, args: [boolean], what: string) => void} opts.notify -
 *   How to call the pin, so one that throws is logged rather than fatal.
 * @param {Iterable<string>} [opts.hidden] - The reasons that already hold.
 * @returns {PinSight} The pin's sight.
 */
export function createPinSight({ notify, hidden = [] }) {
  const reasons = new Set(hidden);
  /** @type {Set<(visible: boolean) => void>} */
  const listeners = new Set();
  let ended = false;
  return {
    api: {
      // A pin that has been torn down is seen by nobody, whatever held before.
      isVisible: () => !ended && reasons.size === 0,
      onChange: (listener) => {
        if (ended) return () => {};
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
    set: (reason, isHidden) => {
      if (ended) return;
      const was = reasons.size === 0;
      if (isHidden) reasons.add(reason);
      else reasons.delete(reason);
      const is = reasons.size === 0;
      if (was === is) return;
      for (const listener of [...listeners]) notify(listener, [is], 'a visibility change');
    },
    end: () => {
      ended = true;
      listeners.clear();
    },
  };
}
