//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Putting CSS animations on a shared clock.
 *
 * An element inserted beside others that are already animating starts its
 * animations at its own zero, so anything meant to move in step with them —
 * a club joining a juggling cascade, the fire on that club — is out of phase
 * from the moment it appears. Copying `currentTime` across is exact: for two
 * animations with the same duration, the same time is the same point in the
 * cycle, and any per-element `animation-delay` keeps its offset on top.
 *
 * Every helper tolerates an engine without the Web Animations API (and a
 * missing element), and then does nothing: out of phase is the worst outcome.
 * @module utils/animation-clock
 */

/**
 * The animations running on `el` itself (not its descendants).
 * @param {Element|null|undefined} el - The animated element.
 * @returns {Animation[]} Its animations, or none.
 */
export function animationsOf(el) {
  return typeof el?.getAnimations === 'function' ? el.getAnimations() : [];
}

/**
 * The CSS animation called `name` running on `el`.
 * @param {Element|null|undefined} el - The animated element.
 * @param {string} name - The `@keyframes` name.
 * @returns {Animation|undefined} The animation, if it is running there.
 */
export function animationNamed(el, name) {
  return animationsOf(el).find((a) => /** @type {CSSAnimation} */ (a).animationName === name);
}

/**
 * Set every animation on `el` to the time `ref` is at.
 * @param {Element|null|undefined} el - The element to bring into step.
 * @param {Animation|null|undefined} ref - The animation to take the time from.
 */
export function matchClock(el, ref) {
  if (!ref || ref.currentTime === null) return;
  for (const a of animationsOf(el)) a.currentTime = ref.currentTime;
}
