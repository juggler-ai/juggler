//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Juggler busy spinner — clubs orbiting a central point and flipping on their
 * own axis, evoking a juggling cascade. The clubs are the same shapes used in
 * the Juggler logo.
 *
 * Usage:
 *   <juggler-spinner></juggler-spinner>
 *   <juggler-spinner style="--spinner-size: 2rem"></juggler-spinner>
 *   <juggler-spinner style="--spinner-size: 1rem; --spinner-duration: 1.2s; color: white"></juggler-spinner>
 *   <juggler-spinner live></juggler-spinner>
 *
 * CSS knobs (set on the host):
 *   --spinner-size      — overall diameter         (default 2rem)
 *   --spinner-duration  — one orbital cycle        (default 1.5s)
 *   color               — club fill                (inherited from the parent's
 *                                                   `color`, so the spinner adapts
 *                                                   to the surrounding theme by
 *                                                   default)
 *
 * The clubs are drawn with `fill: currentColor`, so changing `color` on the
 * host (or any ancestor) recolours the spinner — no extra knob needed.
 *
 * ## The `live` attribute
 *
 * By default a spinner is a fixed three-club cascade at a fixed rate: it says
 * "something is happening" and nothing more, which is all a fetch-waiter (the
 * model-selector menu, the settings loader, the skills list) has to say.
 *
 * `live` opts a spinner into reporting the work it sits in front of, so the
 * cascade becomes a readout rather than decoration: {@link clubs} tracks how
 * many tool calls are executing in parallel, {@link report} tracks what the
 * turn is actually doing — waiting, streaming, or parked on a tool call — and
 * {@link contextTokens} sets the clubs on fire once the conversation is long
 * (juggler-spinner-fire.js). Only spinners whose owner can supply those
 * numbers should carry it — a spinner that opts in and is never fed simply
 * rests at the default cascade, which is exactly the non-live appearance.
 */

import JugglerElement from './juggler-element.js';
import SpinnerFire, { FIRE_CLOCKED } from './juggler-spinner-fire.js';
import { animationsOf, matchClock } from '../utils/animation-clock.js';
import { t } from '../../sdk/lib/i18n.js';

// The two paths from juggler-logo.svg, inlined into a single self-contained
// <svg> whose viewBox tightly frames one club (centred at 0,0). We deliberately
// do NOT use a shared <symbol> + <use>: an <svg> that references a <symbol>
// stacks two coordinate systems, and Firefox 149 mis-resolves the viewport for
// the referenced symbol when the outer <svg> has no viewBox and is CSS-sized —
// the clubs render at the wrong scale/offset and scatter off their orbit (the
// bug is gone by FF 153, but users on 149 hit it). A plain <svg> with a single
// viewBox and no symbol indirection is the most portable SVG construct there
// is and every engine maps it identically. Repeated once per club — cheap, and
// correctness beats sharing one <symbol>.
const CLUB_SVG_HTML = `<svg viewBox="-26 -42 52 84" aria-hidden="true"><g transform="translate(-67,-122)"><path d="m 66.033179,116.69934 c -4.412016,4.89314 -12.358013,12.52542 -17.596859,23.54326 -1.987636,4.76634 -5.434859,14.13639 -5.857007,17.71365 l 8.582939,4.81728 c 6.977318,-7.0357 13.098603,-13.43877 17.445963,-25.25324 1.421897,-4.1573 3.06366,-10.49489 4.738729,-16.41967 z"/><path d="m 85.934794,81.917297 c -4.696459,0.08969 -6.548377,5.246501 -4.58162,8.852873 -4.714452,10.23004 -10.939485,20.2839 -13.105143,23.40736 l 5.988781,3.50934 c 1.634814,-3.92835 6.500703,-14.4903 11.935189,-24.419178 3.93831,-0.64312 5.787539,-3.93172 5.368148,-6.871415 -0.303232,-3.07033 -3.343756,-4.571558 -5.605355,-4.47898 z"/></g></svg>`;

/** Clubs in the resting cascade — the count every spinner starts and returns to. */
const DEFAULT_CLUBS = 3;

/* ==================================================================
   Tuning

   Hand-editable knobs for trying the `live` spinner out: switch a
   behaviour off to see the spinner without it, or move a number to
   change how it feels. Compile-time only and deliberately so — none
   of this is user-facing preference and none of it is persisted
   anywhere, so nothing here needs a migration or a settings entry.
   The fire's own numbers live with it, in juggler-spinner-fire.js.
   ================================================================== */

/**
 * On/off per behaviour the `live` attribute unlocks. Each is independent:
 * switching one off returns that aspect of the spinner to its fixed default and
 * leaves the rest working. With all of them off, a `live` spinner behaves
 * exactly like a plain one.
 */
const BEHAVIOURS = Object.freeze({
  /** Club count tracks how many tool calls are executing in parallel. */
  count: true,
  /** Orbit/flip speed tracks the work: output flow, or the wait for a tool. */
  rate: true,
  /** The clubs burn once the conversation's context is long. */
  fire: true,
});

/** Numeric feel of each behaviour. */
const TUNING = Object.freeze({
  /** Widest cascade a `live` spinner will open out to. */
  maxClubs: 7,
  /** Slowest the cascade will run, as a multiple of its CSS duration. */
  minRate: 0.25,
  /** Fastest the cascade will run, as a multiple of its CSS duration. */
  maxRate: 2,
  /** Output rate (tokens/sec) that maps to the top of the rate range. */
  fastTokensPerSecond: 120,
  /** Speed a freshly-started tool call runs at, before any tiring sets in. */
  toolWaitStartRate: 1,
  /** How long a single tool call takes to tire the cascade down to {@link TUNING.minRate}. */
  toolWaitSlowdownMs: 60000,
  /** Quiet period a shrinking club count must hold before the cascade closes up. */
  shrinkDelayMs: 400,
  /** How long a leaving club has to fade before it is detached; outlasts the CSS opacity transition. */
  fadeMs: 250,
  /** Smallest rate change worth applying; anything less is measurement noise. */
  rateDeadband: 0.05,
  /** Deadband for the tool-wait ramp, which is a clean curve rather than a measurement. */
  rampDeadband: 0.01,
  /** Minimum gap between rate applications, so streaming can't drive them. */
  rateIntervalMs: 250,
});

/**
 * `x` held to [lo, hi], with anything that is not a finite number read as
 * `fallback` first.
 * @param {number} x - Value to clamp.
 * @param {number} lo - Floor.
 * @param {number} hi - Ceiling.
 * @param {number} fallback - Stand-in for a non-finite `x`.
 * @returns {number} The clamped value.
 */
function clamp(x, lo, hi, fallback) {
  const n = Number(x);
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : fallback));
}

/**
 * The speed a given output rate maps to.
 *
 * Zero is meaningful and common — waiting on the network, waiting on the first
 * token — and maps to the floor rather than to a stop: the spinner still has to
 * say "working", just visibly labouring. The scale is linear up to
 * {@link TUNING.fastTokensPerSecond} and flat above it, so the difference
 * between a slow model and a fast one reads clearly while a burst from a very
 * fast one doesn't blur the clubs.
 * @param {number} tps - Output tokens per second.
 * @returns {number} Rate multiple.
 */
function throughputRate(tps) {
  const flow = clamp(tps, 0, TUNING.fastTokensPerSecond, 0);
  return TUNING.minRate + (TUNING.maxRate - TUNING.minRate) * (flow / TUNING.fastTokensPerSecond);
}

/**
 * The speed a tool call that has been running for `ms` maps to.
 *
 * A linear glide from {@link TUNING.toolWaitStartRate} down to the floor over
 * {@link TUNING.toolWaitSlowdownMs}, and flat at the floor after that. Linear
 * on purpose: spread over a minute it is about a percent of orbital speed per
 * second, which nobody can see happening — the spinner is only ever noticed to
 * be labouring, never noticed slowing down.
 *
 * The anchor is a fixed rate rather than "whatever speed we were just doing",
 * so every fresh tool call starts from the same place. Carrying the live rate
 * over would be smoother at the handoff but it compounds: a tool that starts
 * while an earlier ramp is part-way down would inherit the tired speed and the
 * cascade could never recover, which is the opposite of the point.
 * @param {number} ms - How long the tool call has been running.
 * @returns {number} Rate multiple.
 */
function toolWaitRate(ms) {
  const progress = clamp(ms, 0, TUNING.toolWaitSlowdownMs, 0) / TUNING.toolWaitSlowdownMs;
  return TUNING.toolWaitStartRate + (TUNING.minRate - TUNING.toolWaitStartRate) * progress;
}

/**
 * Markup for one club.
 *
 * Three nested spans, each owning exactly one transform: the pivot holds the
 * static angle of this club's slot on the orbit, the orbit span holds the
 * shared rotation around the centre, and the club holds its own flip. Splitting
 * the slot angle out of the animation is what lets the cascade re-space to a
 * different club count without the clubs jumping — see the CSS.
 *
 * `aria-hidden` on the pivot matters on a `live` spinner: the host is a
 * `role="status"` region, and clubs come and go as the work behind it changes.
 * Hiding them keeps that churn out of the accessibility tree entirely, so the
 * only thing assistive tech ever sees is the host's fixed "Loading" label — a
 * cascade that grows to seven clubs and back announces nothing.
 *
 * The markup carries no slot: {@link placeClub} sets it.
 * @param {string} extra - Markup to carry inside the club after its svg (the fire).
 * @returns {string} HTML for one pivot/orbit/club triple.
 */
function clubHTML(extra) {
  return '<span class="spinner-pivot" aria-hidden="true">'
        + `<span class="spinner-orbit"><span class="spinner-club">${CLUB_SVG_HTML}${extra}</span></span></span>`;
}

/**
 * Put a club's pivot in its slot on the orbit. Through the CSSOM, never a
 * style attribute in markup: a page whose CSP forbids inline styles (the
 * machine server's sessions page) drops a parsed style attribute, and every
 * club would sit in slot 0.
 * @param {HTMLElement} pivot - The club's .spinner-pivot.
 * @param {number} index - Slot index, 0-based.
 * @param {number} count - Total clubs in the cascade.
 */
function placeClub(pivot, index, count) {
  pivot.style.setProperty('--spinner-angle', `${((360 / count) * index).toFixed(3)}deg`);
  pivot.style.setProperty('--spinner-phase', String(index));
}

class JugglerSpinner extends JugglerElement {
  constructor() {
    super();
    /** @type {number} @private Club count currently laid out. */
    this._clubs = DEFAULT_CLUBS;
    /** @type {number} @private Playback rate currently applied to the animations. */
    this._rate = 1;
    /** @type {any} @private Pending trailing shrink of the club count. */
    this._shrinkTimer = 0;
    /** @type {any} @private Pending throttled rate application. */
    this._rateTimer = 0;
    /** @type {number} @private When the rate was last pushed to the animations. */
    this._rateAppliedAt = 0;
    /** @type {{orbits: Animation[], flips: Animation[], fire: Animation[]}|null} @private Resolved animations; see _animationsChanged. */
    this._animCache = null;
    /** @type {SpinnerFire} @private The fire on the clubs. */
    this._fire = new SpinnerFire(this, () => this._animationsChanged());
  }

  connectedCallback() {
    if (this.childElementCount === 0) this._renderClubs(DEFAULT_CLUBS);
    if (!this.hasAttribute('role')) this.setAttribute('role', 'status');
    // A live spinner stands in front of a running turn, which is work, not a load.
    if (!this.hasAttribute('aria-label')) this.setAttribute('aria-label', this.isLive ? t('Working') : t('Loading'));
    this._observeVisibility();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    // Plain fields rather than this.setTimeout: the setters re-arm these on every
    // streaming tick, and each JugglerElement timer holds a cleanup until the
    // next disconnect.
    this._cancelShrink();
    clearTimeout(this._rateTimer);
    this._rateTimer = 0;
    this._animCache = null;
    this._fire.dispose();
  }

  /**
   * Whether this spinner reports the work behind it (see the `live` attribute
   * in the class doc). A non-live spinner ignores every setter below and never
   * touches the Web Animations API at all.
   * @returns {boolean} True when the host carries the `live` attribute.
   */
  get isLive() {
    return this.hasAttribute('live');
  }

  /* ---- Club count ------------------------------------------------------- */

  /**
   * How many tool calls are executing in parallel behind this spinner.
   *
   * Mapped to club count with {@link DEFAULT_CLUBS} as a floor, so the ordinary
   * case — one tool call at a time — is the same three-club cascade the spinner
   * has always shown, and the cascade only opens out when there is genuinely
   * more in flight than it can normally hold. Capped at {@link TUNING.maxClubs}:
   * beyond that the clubs overlap into a smear and stop reading as juggling.
   * Ignored entirely on a non-live spinner.
   * @param {number} n - Tool calls currently executing.
   */
  set clubs(n) {
    if (!this.isLive || !BEHAVIOURS.count) return;
    const want = clamp(Math.round(Number(n)), DEFAULT_CLUBS, TUNING.maxClubs, DEFAULT_CLUBS);
    // Any new reading supersedes a pending shrink: it is either re-armed below
    // or no longer wanted.
    this._cancelShrink();
    if (want === this._clubs) return;
    // Fast attack, slow release. Growing is the informative edge — a fan-out of
    // parallel calls should show up the instant it starts — so it applies
    // immediately. Shrinking waits out a quiet period, because a batch drains
    // one call at a time and reacting to each would collapse the cascade in
    // visible steps a fraction of a second apart. The setter is called on every
    // streaming tick, so the timer is re-armed continuously and only fires once
    // the count has genuinely settled.
    if (want > this._clubs) {
      this._respace(want);
      return;
    }
    this._shrinkTimer = setTimeout(() => {
      this._shrinkTimer = 0;
      this._respace(want);
    }, TUNING.shrinkDelayMs);
  }

  /** @returns {number} Clubs currently in the cascade. */
  get clubs() {
    return this._clubs;
  }

  /** @private */
  _cancelShrink() {
    clearTimeout(this._shrinkTimer);
    this._shrinkTimer = 0;
  }

  /* ---- Speed ------------------------------------------------------------ */

  /**
   * The speed of the cascade, as a multiple of the resting speed.
   *
   * Clamped to [{@link TUNING.minRate}, {@link TUNING.maxRate}] so a stall never freezes the
   * spinner outright (it still has to read as "working") and a burst never
   * blurs it. Callers reporting a turn use {@link report}, which maps the work
   * onto this. Ignored entirely on a non-live spinner.
   * @param {number} r - Desired rate multiple.
   */
  set rate(r) {
    this._setRate(r, TUNING.rateDeadband);
  }

  /** @returns {number} Rate multiple currently applied. */
  get rate() {
    return this._rate;
  }

  /**
   * Report what the turn behind this spinner is doing right now.
   *
   * Three states, and the speed says which one it is in:
   *
   * - **Waiting** — the turn is in flight but nothing has come back: preparing a
   *   request, waiting on the first token, retrying. No flow and no tool
   *   running, so this lands on the floor and stays there. The spinner labours
   *   for exactly as long as we are stuck.
   * - **Streaming** — output is arriving, so speed tracks how fast (see
   *   {@link throughputRate}). This is the cascade at its liveliest.
   * - **Parked on a tool call** — no output is arriving, but the machine is
   *   working rather than stuck, so the floor would be a lie. The cascade starts
   *   at a healthy clip and tires over a minute (see {@link toolWaitRate}),
   *   measured from the claim stamp of the LONGEST-running tool still going —
   *   not from the start of the turn. That distinction is what makes the
   *   spinner pick up again the moment a slow tool finishes and the next one
   *   starts: the thing we are waiting on is young again, so the cascade is too.
   *
   * Called on every streaming tick, and at least once a second while a turn is
   * running (the elapsed-time ticker), which is what advances the ramp. Ignored
   * entirely on a non-live spinner.
   * @param {object} [work] - What the turn is doing.
   * @param {number} [work.throughput] - Output tokens per second, 0 when nothing is streaming.
   * @param {number|null} [work.toolWaitMs] - How long the longest-running tool call has
   *   been running, or null when no tool is executing.
   */
  report({ throughput = 0, toolWaitMs = null } = {}) {
    const waiting = typeof toolWaitMs === 'number' && Number.isFinite(toolWaitMs);
    if (waiting) this._setRate(toolWaitRate(toolWaitMs), TUNING.rampDeadband);
    else this._setRate(throughputRate(throughput), TUNING.rateDeadband);
  }

  /**
   * Clamp, filter and schedule a new rate.
   * @param {number} r - Desired rate multiple.
   * @param {number} deadband - Smallest change worth applying, for this source.
   * @private
   */
  _setRate(r, deadband) {
    if (!this.isLive || !BEHAVIOURS.rate) return;
    // A rate of exactly 0 is a real stall and clamps DOWN to the floor; only
    // garbage falls back to full speed.
    const want = clamp(r, TUNING.minRate, TUNING.maxRate, 1);
    // The deadband is per-source, because the two sources have opposite
    // problems. Throughput is measured from lumpy provider chunks and jitters
    // constantly, so it gets a wide one: a tight threshold would let that noise
    // through as a re-application on nearly every tick, and the eye cannot read
    // a few percent of orbital speed anyway. The tool-wait ramp is not a
    // measurement but a curve, and a wide deadband would quantise a minute-long
    // glide into a handful of visible steps — so it gets a narrow one.
    if (Math.abs(want - this._rate) < deadband) return;
    this._rate = want;
    this._scheduleRate();
  }

  /**
   * Apply the pending rate, but no more often than {@link TUNING.rateIntervalMs}.
   *
   * The setter is fed from a Yjs observer that fires several times a second,
   * and applying a rate touches every animation in the cascade. Coalescing to
   * one trailing application keeps that off the streaming hot path; the visible
   * result is identical, because `updatePlaybackRate` ramps rather than steps.
   * @private
   */
  _scheduleRate() {
    if (this._rateTimer) return; // an application is already pending; it will read _rate
    const since = Date.now() - this._rateAppliedAt;
    const wait = Math.max(0, TUNING.rateIntervalMs - since);
    this._rateTimer = setTimeout(() => {
      this._rateTimer = 0;
      this._rateAppliedAt = Date.now();
      this._applyRate(this._rate);
    }, wait);
  }

  /**
   * Set the playback rate of every animation on the cascade's clock.
   *
   * `updatePlaybackRate` rather than a `--spinner-duration` rewrite: it preserves each
   * animation's current time and adjusts its start time instead, so the cascade
   * changes speed without jumping. Rewriting `--spinner-duration` (or
   * `animation-duration`) re-maps progress against the new duration and makes
   * the clubs lurch. Orbit and flip take the same rate so each club's
   * slow-zone stays pinned to the bottom of its orbit at any speed, and the
   * fire's counter-rotations take it too so the flames stay upright.
   * @param {number} rate - Multiple of the CSS duration.
   * @private
   */
  _applyRate(rate) {
    const { orbits, flips, fire } = this._animations();
    for (const a of orbits.concat(flips, fire)) {
      if (typeof a.updatePlaybackRate === 'function') a.updatePlaybackRate(rate);
      else a.playbackRate = rate;
    }
  }

  /* ---- Fire ------------------------------------------------------------- */

  /**
   * How large the conversation's context is, in tokens: past a threshold the
   * clubs are on fire, the flames growing with it, and when it drops back — a
   * compaction, say — the fire goes out. See juggler-spinner-fire.js. Ignored
   * entirely on a non-live spinner.
   * @param {number} tokens - Current context size.
   */
  set contextTokens(tokens) {
    if (!this.isLive || !BEHAVIOURS.fire) return;
    this._fire.setContext(tokens);
  }

  /* ---- Layout ----------------------------------------------------------- */

  /**
   * Build the cascade from scratch at `count` clubs. Wholesale replacement, so
   * this is only for the initial render — changing the count of a running
   * spinner this way would restart every club's animation from frame 0.
   * @param {number} count - How many clubs to lay out.
   * @private
   */
  _renderClubs(count) {
    this.innerHTML = clubHTML(this._fire.clubMarkup).repeat(count);
    this._layout(Array.from(this.children), count);
    this._animCache = null;
  }

  /**
   * Grow or shrink the cascade to `count` clubs without disturbing the ones
   * already flying.
   *
   * Re-spacing is just a new `--spinner-angle` per pivot, which the CSS transitions,
   * so the survivors glide to their new slots rather than snapping. Clubs are
   * added at the end and removed from the end, and every survivor keeps its
   * own element — and therefore its own running animation and phase — so
   * nothing resets to frame 0.
   * @param {number} count - Target club count.
   * @private
   */
  _respace(count) {
    this._clubs = count;
    this._animCache = null;
    // Departing clubs fade out first and detach when the fade is done. They are
    // taken out of the layout pass immediately (spinner-leaving), so the survivors
    // re-space around the count they are heading for rather than shuffling
    // twice.
    const before = Array.from(this.children).filter(el => !el.classList.contains('spinner-leaving'));
    for (const leaving of before.slice(count)) {
      leaving.classList.add('spinner-leaving', 'spinner-faded');
      setTimeout(() => leaving.remove(), TUNING.fadeMs);
    }
    const survivors = before.slice(0, count);

    /** @type {Element[]} */ const added = [];
    for (let i = survivors.length; i < count; i++) {
      this.insertAdjacentHTML('beforeend', clubHTML(this._fire.clubMarkup));
      const el = /** @type {Element} */ (this.lastElementChild);
      el.classList.add('spinner-faded');
      added.push(el);
    }

    // Settle the spacing variables BEFORE touching any animation. --spinner-n feeds
    // the flip's delay calc, and _syncPhase below forces a style recalc — so a
    // sync done first would read the phases of the old spacing.
    this._layout(survivors.concat(added), count);

    // The survivors' flip delays have just changed with --spinner-n, which shifts
    // each flip a fraction of a turn in one frame. That shift is deliberate and
    // must NOT be compensated for: the delay is what pins a club's slow-zone to
    // the bottom of its orbit, so holding the old flip angle would keep the
    // clubs looking weightless in their new slots for the rest of the run. A
    // few degrees of extra tumble, once, during a glide nobody is studying is
    // the cheaper price.
    for (const pivot of added) this._syncPhase(pivot);
    this._reapply();

    // Commit the transparent state before clearing it, so the fade has a value
    // to run FROM — dropping the class without this collapses both values into
    // one style recalc and the club simply appears. A synchronous reflow rather
    // than a rAF callback: rAF does not fire at all in an occluded window, and
    // a club that joined while the window was hidden would then be stuck
    // invisible until something else forced a frame.
    if (added.length) {
      void this.offsetHeight;
      for (const pivot of added) pivot.classList.remove('spinner-faded');
    }
  }

  /**
   * Space `pivots` evenly round the ring as a cascade of `count`.
   * @param {Element[]} pivots - The `.spinner-pivot`s, in slot order.
   * @param {number} count - Clubs in the cascade.
   * @private
   */
  _layout(pivots, count) {
    this.style.setProperty('--spinner-n', String(count));
    pivots.forEach((pivot, i) => placeClub(/** @type {HTMLElement} */ (pivot), i, count));
  }

  /**
   * Put a freshly-inserted club in step with the ones already flying.
   *
   * Copying `currentTime` from an existing club is exact, and the CSS keeps
   * handling the rest: every orbit runs with no delay (so matching currentTime
   * IS matching position), and each flip's own `--spinner-phase` delay then
   * places its slow-zone at the bottom of its slot. Any fire the club carries
   * is synced last, to the club's own now-correct clocks.
   * @param {Element} pivot - The newly-inserted `.spinner-pivot`.
   * @private
   */
  _syncPhase(pivot) {
    const { orbits, flips } = this._animations();
    const club = /** @type {Element} */ (pivot.querySelector('.spinner-club'));
    matchClock(pivot.querySelector('.spinner-orbit'), orbits.find(a => a.currentTime !== null));
    matchClock(club, flips.find(a => a.currentTime !== null));
    this._fire.join(club);
  }

  /* ---- Animations ------------------------------------------------------- */

  /**
   * The animations on the cascade's clock, split by what they drive: the
   * orbits, the flips, and the fire's counter-rotations. Cached, because
   * `getAnimations()` forces a style flush and the rate is driven from a Yjs
   * observer several times a second on every visible spinner: resolving it
   * live turned a status update into a synchronous layout, which is enough to
   * make the whole page stutter. Whatever rebuilds animations drops the cache
   * (see {@link _animationsChanged}).
   * @returns {{orbits: Animation[], flips: Animation[], fire: Animation[]}} Live animation objects.
   * @private
   */
  _animations() {
    if (this._animCache) return this._animCache;
    /** @type {Animation[]} */ const orbits = [];
    /** @type {Animation[]} */ const flips = [];
    /** @type {Animation[]} */ const fire = [];
    for (const el of Array.from(this.querySelectorAll(`.spinner-orbit, .spinner-club, ${FIRE_CLOCKED}`))) {
      const target = el.classList.contains('spinner-orbit') ? orbits
        : el.classList.contains('spinner-club') ? flips : fire;
      target.push(...animationsOf(el));
    }
    this._animCache = { orbits, flips, fire };
    return this._animCache;
  }

  /**
   * The set of running animations has changed — fire added or removed, or
   * every animation rebuilt by {@link restart}: forget the resolved list, and
   * give whatever is running now the reported rate.
   * @private
   */
  _animationsChanged() {
    this._animCache = null;
    this._reapply();
  }

  /**
   * Re-apply everything that lives on the Animation objects rather than in CSS.
   *
   * New animations start at 1×, so anything set imperatively is lost when CSS
   * builds them afresh. Phase survives that on its own (the rebuilt animations
   * all start together, and their relative offsets come from the CSS delays),
   * but the playback rate does not — without this a spinner that self-heals
   * after an un-hide would silently drop back to 1×.
   * @private
   */
  _reapply() {
    if (this._rate !== 1) this._applyRate(this._rate);
  }

  /**
   * Self-heal the WKWebView "stuck spinner" bug at the one deterministic moment
   * it matters: when this element actually becomes visible to the user.
   *
   * WebKit freezes a CSS animation whose element was off-layout (its tab or the
   * processing footer was display:none) or occluded (the app was backgrounded)
   * while the animation was declared: when the element is later shown, the
   * orbit/spin animations resume from the start-time that was fixed while hidden
   * and never advance — the spinner appears stuck. Reflowing the element once
   * it is back on-layout (see {@link restart}) rebuilds the animations with a
   * fresh start-time.
   *
   * We do this from the spinner itself rather than asking every caller that
   * shows one (the processing footer, the Pause button, thread-status rows, the
   * model selector, …) to remember to nudge it: an IntersectionObserver reports
   * the exact hidden→shown edge for every show path there is — the `hidden`
   * class coming off, a background tab being revealed, the node scrolled back
   * into view — with no caller coordination. Edge-triggered on `isIntersecting`,
   * so routine status-text updates never restart a spinner that is already
   * running (which would reset it to frame 0 and make it visibly stutter).
   * @private
   */
  _observeVisibility() {
    if (typeof IntersectionObserver === 'undefined') return; // headless / ancient engine: no-op
    let wasVisible = false;
    const io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (!last) return;
      const visible = last.isIntersecting;
      if (visible && !wasVisible) this.restart();
      wasVisible = visible;
    });
    io.observe(this);
    this.addCleanup(() => io.disconnect());
  }

  /**
   * Force this spinner's CSS animations to restart with a fresh start-time via a
   * synchronous display none→reflow→restore. All three steps run in one task, so
   * the hidden frame is never painted and there is no flicker. No-op when the
   * element has no layout box (still hidden) — it heals when next shown.
   */
  restart() {
    if (this.getClientRects().length === 0) return;
    const prev = this.style.display;
    this.style.display = 'none';
    void this.offsetHeight; // commit the display:none, discarding the frozen animations
    this.style.display = prev;
    this._animationsChanged();
  }
}

customElements.define('juggler-spinner', JugglerSpinner);
