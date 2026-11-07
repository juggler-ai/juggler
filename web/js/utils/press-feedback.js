//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Press feedback: every button in the app answers a press the same way — a
 * quick dip, then a spring back on release, overshooting rest by a tenth of
 * the dip before it settles.
 *
 * One delegated listener rather than a rule per stylesheet, so a button any
 * component or extension draws presses like the rest without opting in. It is
 * a Web Animation of `scale` rather than a CSS `:active` rule because a CSS
 * spring lives in `transition`, which any component's own `transition`
 * replaces; an animation composes over whatever the stylesheets say, and
 * `scale` over whatever `transform` they set. So no stylesheet gives a button
 * a press of its own (press-feedback-test asserts it).
 *
 * The dip is a few pixels whatever the button's size: an icon button shrinks
 * by about an eighth, a wide row by a sliver. A press is held for at least
 * {@link MIN_HOLD_MS} so a quick click still shows. Nothing moves under
 * prefers-reduced-motion, on a disabled button, or inside `data-press="none"`.
 * @module utils/press-feedback
 */

/** The id of the dip's animation, for `getAnimations()`. */
export const PRESS_ANIMATION_ID = 'press';
/** The id of the spring back's animation. */
export const RELEASE_ANIMATION_ID = 'press-release';

const PRESSABLE = 'button, [role="button"], input[type="button"], input[type="submit"]';

/** How far the edge of a button moves in, at most, in px. */
const DIP_PX = 4;
/** The deepest dip, as a fraction of the button's size, for the smallest buttons. */
const MAX_DIP = 0.12;
const PRESS_MS = 90;
const PRESS_EASING = 'cubic-bezier(0.3, 0.7, 0.4, 1)';
const RELEASE_MS = 520;
const MIN_HOLD_MS = 90;

/**
 * A damped spring's progress from 0 to 1 over the release, sampled for
 * linear keyframes: damping 0.6 overshoots by about a tenth, and at 20 rad/s
 * it has settled within the release's duration.
 * @param {number} steps - Keyframes after the first.
 * @returns {number[]} Progress at each keyframe, ending at exactly 1.
 */
function springCurve(steps = 24) {
  const zeta = 0.6;
  const omega = 20;
  const damped = omega * Math.sqrt(1 - zeta * zeta);
  const seconds = RELEASE_MS / 1000;
  const curve = [];
  for (let i = 0; i <= steps; i++) {
    const t = (seconds * i) / steps;
    curve.push(1 - Math.exp(-zeta * omega * t) * (Math.cos(damped * t) + (zeta * omega / damped) * Math.sin(damped * t)));
  }
  curve[steps] = 1;
  return curve;
}

const SPRING = springCurve();

/** @type {Map<HTMLElement, {press: Animation, dip: number, at: number}>} */
const held = new Map();

/**
 * @param {EventTarget|null} target - Where the press landed.
 * @returns {HTMLElement|null} The button it presses, if it may move.
 */
function pressable(target) {
  if (!(target instanceof Element)) return null;
  const el = target.closest(PRESSABLE);
  if (!(el instanceof HTMLElement)) return null;
  if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') return null;
  if (el.closest('[data-press="none"]')) return null;
  return el;
}

/**
 * @param {HTMLElement} el - The button.
 * @returns {number|null} The scale it dips to; null when it has no size.
 */
function dipFor(el) {
  const box = el.getBoundingClientRect();
  const longest = Math.max(box.width, box.height);
  if (longest <= 0) return null;
  return 1 - Math.min(MAX_DIP, DIP_PX / longest);
}

/**
 * @param {HTMLElement} el - The button being pressed.
 */
function press(el) {
  if (held.has(el) || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const dip = dipFor(el);
  if (dip === null) return;
  for (const running of el.getAnimations()) {
    if (running.id === RELEASE_ANIMATION_ID) running.cancel();
  }
  const anim = el.animate([{ scale: '1' }, { scale: String(dip) }],
    { duration: PRESS_MS, easing: PRESS_EASING, fill: 'forwards', id: PRESS_ANIMATION_ID });
  held.set(el, { press: anim, dip, at: performance.now() });
}

/**
 * Spring every held button back, each once it has been held long enough.
 */
function releaseAll() {
  for (const [el, entry] of held) {
    held.delete(el);
    const wait = Math.max(0, MIN_HOLD_MS - (performance.now() - entry.at));
    setTimeout(() => {
      if (!el.isConnected) {
        entry.press.cancel();
        return;
      }
      const frames = SPRING.map((p) => ({ scale: String(entry.dip + (1 - entry.dip) * p) }));
      frames[frames.length - 1] = { scale: '1' };
      const release = el.animate(frames, { duration: RELEASE_MS, easing: 'linear', id: RELEASE_ANIMATION_ID });
      // Started at the dip, so dropping the held dip under it shows no seam.
      entry.press.cancel();
      release.finished.then(() => release.cancel(), () => {});
    }, wait);
  }
}

/** @param {PointerEvent} e */
function onPointerDown(e) {
  if (e.button !== 0) return;
  const el = pressable(e.target);
  if (el) press(el);
}

/** @param {KeyboardEvent} e */
function onKeyDown(e) {
  if ((e.key !== ' ' && e.key !== 'Enter') || e.repeat) return;
  const el = pressable(e.target);
  if (el) press(el);
}

/** @param {KeyboardEvent} e */
function onKeyUp(e) {
  if (e.key === ' ' || e.key === 'Enter') releaseAll();
}

let installs = 0;

/**
 * Give every button in this document the shared press. Idempotent: each call
 * returns its own uninstall, and the listeners go when the last is called.
 * @returns {() => void} Uninstall.
 */
export function installPressFeedback() {
  if (installs++ === 0) {
    document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('pointerup', releaseAll, true);
    window.addEventListener('pointercancel', releaseAll, true);
    document.addEventListener('dragstart', releaseAll, true);
    window.addEventListener('blur', releaseAll);
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--installs > 0) return;
    releaseAll();
    document.removeEventListener('pointerdown', onPointerDown, { capture: true });
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('pointerup', releaseAll, true);
    window.removeEventListener('pointercancel', releaseAll, true);
    document.removeEventListener('dragstart', releaseAll, true);
    window.removeEventListener('blur', releaseAll);
  };
}
