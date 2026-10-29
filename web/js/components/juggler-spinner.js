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
 *   <juggler-spinner style="--size: 2rem"></juggler-spinner>
 *   <juggler-spinner style="--size: 1rem; --duration: 1.2s; color: white"></juggler-spinner>
 *   <juggler-spinner live></juggler-spinner>
 *
 * CSS knobs (set on the host):
 *   --size      — overall diameter         (default 1.5rem)
 *   --duration  — one orbital cycle        (default 1.5s)
 *   color       — club fill                (inherited from the parent's
 *                                           `color`, so the spinner adapts
 *                                           to the surrounding theme by
 *                                           default)
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
 * many tool calls are executing in parallel, and {@link report} tracks what the
 * turn is actually doing — waiting, streaming, or parked on a tool call. Only
 * spinners whose owner can supply those numbers should carry it — a spinner
 * that opts in and is never fed simply rests at the default cascade, which is
 * exactly the non-live appearance.
 */

import JugglerElement from './juggler-element.js';
import { t } from '../../sdk/lib/i18n.js';

// The two paths from juggler-logo.svg, inlined into a single self-contained
// <svg> whose viewBox tightly frames one club (centred at 0,0). We deliberately
// do NOT use a shared <symbol> + <use>: an <svg> that references a <symbol>
// stacks two coordinate systems, and Firefox 149 mis-resolves the viewport for
// the referenced symbol when the outer <svg> has no viewBox and is CSS-sized —
// the clubs render at the wrong scale/offset and scatter off their orbit (the
// bug is gone by FF 153, but users on 149 hit it). A plain <svg> with a single
// viewBox and no symbol indirection is the most portable SVG construct there
// is and every engine maps it identically. Duplicated three times below —
// cheap, and correctness beats sharing one <symbol>.
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
   ================================================================== */

/**
 * On/off per behaviour the `live` attribute unlocks. Each is independent:
 * switching one off returns that aspect of the spinner to its fixed default and
 * leaves the rest working. With all four off, a `live` spinner behaves exactly
 * like a plain one.
 */
const BEHAVIOURS = Object.freeze({
  /** Club count tracks how many tool calls are executing in parallel. */
  count: true,
  /** Orbit/flip speed tracks the work: output flow, or the wait for a tool. */
  rate: true,
  /** The rare fumbled club. */
  drop: true,
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
  /** Fade as a club joins or leaves; matches the CSS opacity transition. */
  fadeMs: 250,
  /** Chance a given eligible turn fumbles a club. Rare on purpose. */
  dropChance: 0.05,
  /** How long a turn must have been running before it can fumble. */
  dropAfterMs: 4000,
  /**
   * Fallback length of the fumble, for when the running animation cannot be
   * measured. The real length is read off the animation itself: the CSS states
   * it as a fraction of `--duration`, and playback rate stretches it further.
   */
  dropMs: 1100,
  /**
   * How far before the bottom of the orbit the club that fumbles should be,
   * in degrees.
   *
   * The club is thrown OUTWARD along its own radius, which only looks like
   * falling near the bottom of the ring — the same offset at the top flings it
   * upward and reads as a glitch. The lead gives the fall time to build while
   * the club drops into the bottom of its throw.
   */
  dropLeadDeg: 55,
  /** Fumbles allowed per app session, across every spinner in the window. */
  dropsPerSession: 1,
  /** Smallest rate change worth applying; anything less is measurement noise. */
  rateDeadband: 0.05,
  /** Deadband for the tool-wait ramp, which is a clean curve rather than a measurement. */
  rampDeadband: 0.01,
  /** Minimum gap between rate applications, so streaming can't drive them. */
  rateIntervalMs: 250,
});

/**
 * Fumbles spent this session, counted across every spinner in the window rather
 * than per element — a spinner is torn down and rebuilt constantly (every
 * footer render, every tab switch), so a per-instance count would reset
 * continuously and the gag would stop being rare. Module scope makes "once"
 * mean once for as long as the window lives.
 *
 * Deliberately NOT persisted. Nothing about the spinner belongs in user
 * settings, so the budget resets when the app does.
 */
let dropsThisSession = 0;

/**
 * Hand the session its fumble allowance back, for tests.
 *
 * The browser suite reuses one JS realm across the sequence of tests a lane
 * runs, and the app arms a fumble on the rising edge of any turn — so any
 * earlier test that ran a turn can spend this window's single allowance before
 * the spinner's own tests get to it, leaving them nothing to arm and no way to
 * tell that from a broken budget. Whether it happens turns on load: an armed
 * fumble refunds itself if its spinner is torn down before it fires, so a slow
 * run is one where the spinner is more likely to still be there at four
 * seconds. Not called in production, where spending the allowance once is the
 * entire point.
 */
export function __resetDropBudgetForTests() {
  dropsThisSession = 0;
}

/**
 * Whether the user has asked for reduced motion.
 * @returns {boolean} True when the reduce preference is set.
 */
function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Markup for one club at slot `index` of a cascade of `count`.
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
 * @returns {string} HTML for one pivot/orbit/club triple.
 */
function clubHTML() {
  return '<span class="spinner-pivot" aria-hidden="true">'
        + `<span class="spinner-orbit"><span class="spinner-club">${CLUB_SVG_HTML}</span></span></span>`;
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
    /** @type {any} @private Pending fumble, armed at the start of a turn. */
    this._dropTimer = 0;
    /** @type {any} @private Pending throttled rate application. */
    this._rateTimer = 0;
    /** @type {number} @private When the rate was last pushed to the animations. */
    this._rateAppliedAt = 0;
    /** @type {{orbits: Animation[], flips: Animation[]}|null} @private Resolved animations; see _invalidateAnimations. */
    this._animCache = null;
  }

  connectedCallback() {
    if (this.childElementCount === 0) this._renderClubs(DEFAULT_CLUBS);
    if (!this.hasAttribute('role')) this.setAttribute('role', 'status');
    // A live spinner stands in front of a running turn, which is work, not a load.
    if (!this.hasAttribute('aria-label')) this.setAttribute('aria-label', this.isLive ? t('Working') : t('Loading'));
    this._observeVisibility();
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
    const asked = Math.round(Number(n));
    const want = Math.max(DEFAULT_CLUBS,
      Math.min(TUNING.maxClubs, Number.isFinite(asked) ? asked : DEFAULT_CLUBS));
    if (want === this._clubs) {
      clearTimeout(this._shrinkTimer);
      this._shrinkTimer = 0;
      return;
    }
    // Fast attack, slow release. Growing is the informative edge — a fan-out of
    // parallel calls should show up the instant it starts — so it applies
    // immediately. Shrinking waits out a quiet period, because a batch drains
    // one call at a time and reacting to each would collapse the cascade in
    // visible steps a fraction of a second apart. The setter is called on every
    // streaming tick, so the timer is re-armed continuously and only fires once
    // the count has genuinely settled.
    if (want > this._clubs) {
      clearTimeout(this._shrinkTimer);
      this._shrinkTimer = 0;
      this._clubs = want;
      this._respace(want);
      return;
    }
    clearTimeout(this._shrinkTimer);
    this._shrinkTimer = setTimeout(() => {
      this._shrinkTimer = 0;
      this._clubs = want;
      this._respace(want);
    }, TUNING.shrinkDelayMs);
  }

  /** @returns {number} Clubs currently in the cascade. */
  get clubs() {
    return this._clubs;
  }

  /**
   * How fast output is arriving, as a multiple of the resting speed.
   *
   * Clamped to [{@link TUNING.minRate}, {@link TUNING.maxRate}] so a stall never freezes the
   * spinner outright (it still has to read as "working") and a burst never
   * blurs it. Ignored entirely on a non-live spinner.
   * @param {number} r - Desired rate multiple.
   */
  set rate(r) {
    this._setRate(r, TUNING.rateDeadband);
  }

  /**
   * Clamp, filter and schedule a new rate.
   * @param {number} r - Desired rate multiple.
   * @param {number} deadband - Smallest change worth applying, for this source.
   * @private
   */
  _setRate(r, deadband) {
    if (!this.isLive || !BEHAVIOURS.rate) return;
    // Number(r) || 1 would be wrong here: a reported rate of exactly 0 is a
    // real stall and must clamp DOWN to the floor, not fall back to full speed.
    const n = Number(r);
    const want = Math.max(TUNING.minRate, Math.min(TUNING.maxRate, Number.isFinite(n) ? n : 1));
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

  /** @returns {number} Rate multiple currently applied. */
  get rate() {
    return this._rate;
  }

  /**
   * How fast output is arriving behind this spinner, in tokens per second.
   *
   * The caller reports the measurement; mapping it onto a speed is this
   * element's business. Zero is meaningful and common — waiting on the network,
   * waiting on the first token — and maps to the floor rather than to a stop:
   * the spinner still has to say "working", just visibly labouring. The scale is
   * linear up to {@link TUNING.fastTokensPerSecond} and flat above it, so the
   * difference between a slow model and a fast one reads clearly while a burst
   * from a very fast one doesn't blur the clubs.
   *
   * A caller that also knows about tool calls should use {@link report} instead,
   * which routes to this mapping when nothing is executing and to the tool-wait
   * ramp when something is — a bare 0 during a tool call would read as a stall.
   * @param {number} tps - Output tokens per second.
   */
  set throughput(tps) {
    this.rate = this._throughputRate(tps);
  }

  /**
   * The speed a given output rate maps to.
   * @param {number} tps - Output tokens per second.
   * @returns {number} Rate multiple.
   * @private
   */
  _throughputRate(tps) {
    const n = Number(tps);
    const flow = Number.isFinite(n) && n > 0 ? n : 0;
    const span = TUNING.maxRate - TUNING.minRate;
    return TUNING.minRate + span * Math.min(1, flow / TUNING.fastTokensPerSecond);
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
   * @private
   */
  _toolWaitRate(ms) {
    const n = Number(ms);
    const waited = Number.isFinite(n) && n > 0 ? n : 0;
    const progress = Math.min(1, waited / TUNING.toolWaitSlowdownMs);
    return TUNING.toolWaitStartRate + (TUNING.minRate - TUNING.toolWaitStartRate) * progress;
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
   *   {@link throughput}). This is the cascade at its liveliest.
   * - **Parked on a tool call** — no output is arriving, but the machine is
   *   working rather than stuck, so the floor would be a lie. The cascade starts
   *   at a healthy clip and tires over a minute (see {@link _toolWaitRate}),
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
    if (!this.isLive || !BEHAVIOURS.rate) return;
    const waiting = typeof toolWaitMs === 'number' && Number.isFinite(toolWaitMs);
    if (waiting) this._setRate(this._toolWaitRate(toolWaitMs), TUNING.rampDeadband);
    else this._setRate(this._throughputRate(throughput), TUNING.rateDeadband);
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
    this._invalidateAnimations();
    // Departing clubs fade out first and detach when the fade is done. They are
    // taken out of the layout pass immediately (spinner-leaving), so the survivors
    // re-space around the count they are heading for rather than shuffling
    // twice.
    const before = Array.from(this.children).filter(el => !el.classList.contains('spinner-leaving'));
    for (let i = before.length; i > count; i--) {
      const leaving = /** @type {HTMLElement} */ (before[i - 1]);
      if (!leaving) continue;
      leaving.classList.add('spinner-leaving', 'spinner-faded');
      setTimeout(() => leaving.remove(), TUNING.fadeMs);
    }
    const survivors = before.slice(0, count);

    /** @type {Element[]} */ const added = [];
    for (let i = survivors.length; i < count; i++) {
      this.insertAdjacentHTML('beforeend', clubHTML());
      const el = this.lastElementChild;
      if (!el) continue;
      el.classList.add('spinner-faded');
      added.push(el);
    }

    // Settle the spacing variables BEFORE touching any animation. --spinner-n feeds
    // the flip's delay calc, and _syncPhase below forces a style recalc — so a
    // sync done first would read the phases of the old spacing.
    this.style.setProperty('--spinner-n', String(count));
    survivors.concat(added).forEach((pivot, i) => placeClub(/** @type {HTMLElement} */ (pivot), i, count));

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
   * Offer this spinner the chance to fumble a club during the turn that is
   * starting. Called once per turn; almost always does nothing.
   *
   * The rarity is the whole point, so the gate is deliberately narrow: live
   * spinners only, at most {@link TUNING.dropsPerSession} per session across
   * the whole window, only on a turn that has run long enough to be worth
   * watching, and then only on a {@link TUNING.dropChance} roll. A user might
   * see this a handful of times; most sessions will never show it.
   *
   * Suppressed under reduced motion, and the budget is not spent when it is —
   * a fumble nobody was shown should not count against a fumble they might
   * later want to see.
   * @returns {void}
   */
  offerDrop() {
    if (!this.isLive || !BEHAVIOURS.drop) return;
    if (this._dropTimer) return; // already armed for this turn; one roll each
    if (dropsThisSession >= TUNING.dropsPerSession) return;
    if (prefersReducedMotion()) return;
    if (Math.random() >= TUNING.dropChance) return;

    // Spend the budget on ARMING, not on firing. The fumble waits out a delay
    // before it happens, and several spinners can be running at once (one per
    // column); if each only counted itself at fire time, they would all pass
    // this check against a total none of them had incremented yet and the
    // session would spend its whole allowance at once. Refunded below if the
    // fumble never actually happens.
    dropsThisSession++;
    this._dropTimer = setTimeout(() => {
      this._dropTimer = 0;
      // Re-check on arrival: the turn may have ended or the spinner been
      // detached during the wait, and a club must never be fumbled onto a
      // moment that has stopped being a busy one. Hand the budget back — an
      // impression nobody saw should not count against one they might.
      const victim = this._pickDropVictim();
      if (!victim || !this.isConnected || this.getClientRects().length === 0) {
        dropsThisSession--;
        return;
      }
      victim.classList.add('spinner-dropping');
      this._invalidateAnimations(); // spinner-dropping rewrites animation-name on that club
      this._reapply(); // before measuring: playback rate is what stretches the fall
      setTimeout(() => {
        victim.classList.remove('spinner-dropping');
        this._invalidateAnimations();
        this._reapply();
      }, this._dropDurationMs(victim));
    }, TUNING.dropAfterMs);
  }

  /**
   * Disarm a fumble that has not fired yet, refunding its reserved impression.
   * @private
   */
  _cancelPendingDrop() {
    if (!this._dropTimer) return;
    clearTimeout(this._dropTimer);
    this._dropTimer = 0;
    dropsThisSession--;
  }

  /**
   * Choose which club fumbles: the one best placed to be falling right now.
   *
   * The drop pushes a club outward along its own radius (see the CSS), and that
   * direction rides the orbit — so it reads as gravity near the bottom of the
   * ring and as a glitch anywhere else. Picking at random meant most fumbles
   * fired at the wrong point on the ring and looked like a stumble in the
   * animation rather than a dropped club.
   *
   * The clubs are evenly spaced, so rather than waiting for the right moment
   * (another timer, and a wait as long as a whole orbit) we take whichever club
   * is closest to {@link TUNING.dropLeadDeg} before the bottom. With three clubs
   * that is never more than 60° off, and every club above three sharpens it.
   *
   * Falls back to a random club when the orbit's phase can't be read — a
   * paused or not-yet-started animation, or an engine without the Web
   * Animations API. A fumble at an unknown phase is still better than none.
   * @returns {Element|null} The club to drop, or null when there are none.
   * @private
   */
  _pickDropVictim() {
    const clubs = Array.from(this.querySelectorAll('.spinner-club'));
    if (clubs.length === 0) return null;
    const random = () => clubs[Math.floor(Math.random() * clubs.length)] || null;

    const { orbits } = this._animations();
    const ref = orbits.find(a => a.currentTime !== null);
    const period = Number(ref?.effect?.getComputedTiming?.().duration);
    if (!ref || !Number.isFinite(period) || period <= 0) return random();

    // Where the whole ring has rotated to. Every orbit animation shares one
    // start time and carries no delay, so any of them speaks for all of them;
    // a club's position on screen is this plus its own static slot angle.
    const spun = ((Number(ref.currentTime) % period) / period) * 360;
    const target = 180 - TUNING.dropLeadDeg; // 0deg is the top of the ring
    let best = null;
    let bestErr = Infinity;
    for (const club of clubs) {
      const pivot = club.closest('.spinner-pivot');
      const slot = parseFloat(/** @type {HTMLElement|null} */ (pivot)?.style.getPropertyValue('--spinner-angle') || '');
      if (!Number.isFinite(slot)) continue;
      // Shortest angular distance to the target, either way round the ring.
      const err = Math.abs((((slot + spun - target) % 360) + 540) % 360 - 180);
      if (err < bestErr) {
        bestErr = err;
        best = club;
      }
    }
    return best || random();
  }

  /**
   * How long the fumble on `club` will actually take, in wall-clock ms.
   *
   * Measured from the running animation rather than assumed, because two things
   * stretch it. The CSS states the length as a fraction of `--duration`, which a
   * host can override; and playback rate scales every animation on the club, so
   * a fumble during a slow tool-call ramp can run several times longer than the
   * nominal length. A fixed timer would strip the class mid-fall and teleport
   * the club back to its slot — the exact snap this is here to avoid. The margin
   * covers a rate change landing mid-fumble; overshooting only leaves a spent
   * class on the element a moment longer.
   * @param {Element} club - The club carrying the drop animation.
   * @returns {number} Milliseconds to let the fumble run.
   * @private
   */
  _dropDurationMs(club) {
    const anims = typeof (/** @type {any} */ (club).getAnimations) === 'function'
      ? /** @type {any} */ (club).getAnimations()
      : [];
    for (const a of anims) {
      if (a.animationName !== 'juggler-spinner-drop') continue;
      const active = Number(a.effect?.getComputedTiming?.().activeDuration);
      const rate = Math.abs(Number(a.playbackRate)) || 1;
      if (Number.isFinite(active) && active > 0) return (active / rate) * 1.2;
    }
    return TUNING.dropMs;
  }

  /**
   * The running animations, split by what they drive. Resolved fresh on each
   * call rather than cached: {@link restart} destroys and rebuilds every
   * animation, so a cached list would go stale the first time the spinner
   * self-heals.
   * @returns {{orbits: Animation[], flips: Animation[]}} Live animation objects.
   * @private
   */
  _animations() {
    if (this._animCache) return this._animCache;
    /** @type {Animation[]} */ const orbits = [];
    /** @type {Animation[]} */ const flips = [];
    for (const el of Array.from(this.querySelectorAll('.spinner-orbit, .spinner-club'))) {
      if (typeof (/** @type {any} */ (el).getAnimations) !== 'function') continue;
      const target = el.classList.contains('spinner-orbit') ? orbits : flips;
      for (const a of el.getAnimations()) target.push(a);
    }
    this._animCache = { orbits, flips };
    return this._animCache;
  }

  /**
   * Forget the resolved animations, so the next caller re-reads them.
   *
   * Must be called wherever the animations are actually rebuilt — a club added
   * or removed, a restart, a class change that alters `animation-name`. The
   * cache exists because `getAnimations()` forces a style flush, and the rate
   * is driven from a Yjs observer several times a second on every visible
   * spinner: resolving it live turned a status update into a synchronous
   * layout, which is enough to make the whole page stutter.
   * @private
   */
  _invalidateAnimations() {
    this._animCache = null;
  }

  /**
   * Put a freshly-inserted club in step with the ones already flying.
   *
   * A new element's animations begin their own timeline at zero, so without
   * this a club added mid-flight orbits at whatever phase the cascade happened
   * to be at when it appeared — visibly out of the cascade. Copying
   * `currentTime` from an existing club is exact, and the CSS keeps handling
   * the rest: every orbit runs with no delay (so matching currentTime IS
   * matching position), and each flip's own `--spinner-phase` delay then places its
   * slow-zone at the bottom of its slot.
   * @param {Element} pivot - The newly-inserted `.spinner-pivot`.
   * @private
   */
  _syncPhase(pivot) {
    const { orbits, flips } = this._animations();
    const orbitRef = orbits.find(a => a.currentTime !== null);
    const flipRef = flips.find(a => a.currentTime !== null);
    const newOrbit = /** @type {any} */ (pivot.querySelector('.spinner-orbit'));
    const newFlip = /** @type {any} */ (pivot.querySelector('.spinner-club'));
    if (orbitRef && newOrbit?.getAnimations) {
      for (const a of newOrbit.getAnimations()) a.currentTime = orbitRef.currentTime;
    }
    if (flipRef && newFlip?.getAnimations) {
      for (const a of newFlip.getAnimations()) a.currentTime = flipRef.currentTime;
    }
  }

  /**
   * Re-apply everything that lives on the Animation objects rather than in CSS.
   *
   * {@link restart} throws the animations away and lets CSS build new ones, so
   * anything set imperatively is lost with them. Phase survives that on its own
   * (the rebuilt animations all start together, and their relative offsets come
   * from the CSS delays), but the playback rate does not — without this a
   * spinner that self-heals after an un-hide would silently drop back to 1×.
   * @private
   */
  _reapply() {
    if (this._rate !== 1) this._applyRate(this._rate);
  }

  /**
   * Set the playback rate of every animation in the cascade.
   *
   * `updatePlaybackRate` rather than a `--duration` rewrite: it preserves each
   * animation's current time and adjusts its start time instead, so the cascade
   * changes speed without jumping. Rewriting `--duration` (or
   * `animation-duration`) re-maps progress against the new duration and makes
   * the clubs lurch. Orbit and flip take the same rate so each club's
   * slow-zone stays pinned to the bottom of its orbit at any speed.
   * @param {number} rate - Multiple of the CSS duration.
   * @private
   */
  _applyRate(rate) {
    const { orbits, flips } = this._animations();
    for (const a of orbits.concat(flips)) {
      if (typeof a.updatePlaybackRate === 'function') a.updatePlaybackRate(rate);
      else a.playbackRate = rate;
    }
  }

  /**
   * Build the cascade from scratch at `count` clubs. Wholesale replacement, so
   * this is only for the initial render — changing the count of a running
   * spinner this way would restart every club's animation from frame 0.
   * @param {number} count - How many clubs to lay out.
   * @private
   */
  _renderClubs(count) {
    this._invalidateAnimations();
    this.style.setProperty('--spinner-n', String(count));
    this.innerHTML = clubHTML().repeat(count);
    Array.from(this.children).forEach((pivot, i) => placeClub(/** @type {HTMLElement} */ (pivot), i, count));
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    // Plain fields rather than this.setTimeout: the setters re-arm these on every
    // streaming tick, and each JugglerElement timer holds a cleanup until the
    // next disconnect.
    clearTimeout(this._shrinkTimer);
    this._shrinkTimer = 0;
    clearTimeout(this._rateTimer);
    this._rateTimer = 0;
    this._invalidateAnimations();
    this._cancelPendingDrop();
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
    // The reflow discarded the old animations and CSS has just built new ones,
    // so anything resolved earlier now points at objects that no longer drive
    // this element.
    this._invalidateAnimations();
    this._reapply(); // the rebuilt animations start at 1×; restore the reported rate
  }
}

customElements.define('juggler-spinner', JugglerSpinner);
