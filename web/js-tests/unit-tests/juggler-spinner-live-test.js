//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tests for the busy spinner's `live` mode: the cascade as a readout of the
 * work behind it rather than a fixed decoration.
 *
 * The invariant that matters most here is the opt-in. Most spinners in the app
 * sit in front of a plain fetch and have no concurrency or throughput to
 * report; they must keep behaving exactly as they always have, so a spinner
 * without the `live` attribute has to ignore every setter outright.
 *
 * Also covers `runningToolsInTree`, the doc-side source of both spinner inputs:
 * it surveys only tools actually executing, so queued or approval-parked work
 * can't be passed off as concurrency, and it dates the wait from the tool still
 * running rather than from the start of the turn.
 * @module unit-tests/juggler-spinner-live
 */

import { TOOL_STATES } from '../../sdk/lib/message.js';
import { runningToolsInTree } from '../../js/model/thread-navigation.js';
import LLMState from '../../js/services/llm-state.js';
// The side-effect import registers the custom element.
import { __resetDropBudgetForTests } from '../../js/components/juggler-spinner.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import { assert, waitFor } from '../utilities/test-helpers.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Minimal Y.Map-ish item exposing `.get(key)`, matching what the tree walkers
 * consume. Nested `items` arrays are passed through as plain arrays, which the
 * walkers accept alongside Y.Arrays.
 * @param {object} fields - Field values keyed by name (e.g. type, state, items).
 * @returns {{get: (k: string) => any}} A Y.Map-like item.
 */
function fakeItem(fields) {
  const m = new Map(Object.entries(fields));
  return { get: (k) => m.get(k) };
}

/**
 * A tool-action item in the given state.
 * @param {string} state - One of TOOL_STATES.
 * @param {number} [runningStartedAt] - Claim stamp, when the tool is running.
 * @returns {{get: (k: string) => any}} Y.Map-like tool-action.
 */
function tool(state, runningStartedAt) {
  return fakeItem({ type: 'tool-action', state, runningStartedAt });
}

/**
 * Mount a spinner in the document so it has layout and real animations.
 * @param {boolean} live - Whether to set the `live` attribute.
 * @returns {any} The mounted element.
 */
function mount(live) {
  const el = /** @type {any} */ (document.createElement('juggler-spinner'));
  if (live) el.setAttribute('live', '');
  document.body.appendChild(el);
  return el;
}

/**
 * Whether this environment asks for reduced motion.
 *
 * The fumble is the one part of the spinner that is decoration rather than
 * instrumentation, so it is suppressed twice under the preference: the CSS
 * leaves `.spinner-dropping` spinning in the ring, and `offerDrop` returns before
 * arming. CI machines report the preference, so the drop cases assert whichever
 * of the two behaviours this machine is entitled to.
 * @returns {boolean} True when the reduce preference is set.
 */
function reducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * Run all live-spinner tests.
 * @returns {Promise<TestResult>} Pass/fail counts and error messages.
 */
export async function runTests() {
  let passed = 0, failed = 0; const errors = [];
  /** @type {any[]} */ const mounted = [];

  // A — runningToolsInTree counts ONLY running tools, and recurses into nested
  // threads. Pending/approved/completed/cancelled are not concurrency.
  try {
    const items = [
      tool(TOOL_STATES.RUNNING),
      tool(TOOL_STATES.RUNNING),
      tool(TOOL_STATES.PENDING),
      tool(TOOL_STATES.COMPLETED),
      tool(TOOL_STATES.CANCELLED),
      fakeItem({ type: 'thread', items: [tool(TOOL_STATES.RUNNING), tool(TOOL_STATES.PENDING)] }),
      fakeItem({ type: 'assistant' }),
    ];
    const n = runningToolsInTree(items).count;
    if (n !== 3) throw new Error(`expected 3 running (2 top-level + 1 nested), got ${n}`);
    if (runningToolsInTree(null).count !== 0) throw new Error('expected 0 for null items');
    if (runningToolsInTree([]).count !== 0) throw new Error('expected 0 for empty items');
    passed++;
  } catch (e) { failed++; errors.push(`runningToolsInTree counts running tools: ${e.message}`); }

  // A2 — the wait is dated from the tool STILL RUNNING, not from the turn. The
  // oldest claim stamp wins, settled work is ignored however old it is, and a
  // stamp only counts while its tool is running — that is what lets the cascade
  // pick up again when a slow tool finishes and a fresh one takes over.
  try {
    const now = Date.now();
    const items = [
      tool(TOOL_STATES.COMPLETED, now - 600000),                       // ancient, but done
      tool(TOOL_STATES.RUNNING, now - 30000),
      tool(TOOL_STATES.RUNNING, now - 5000),
      tool(TOOL_STATES.PENDING, now - 400000),                         // parked, not running
      fakeItem({ type: 'thread', items: [tool(TOOL_STATES.RUNNING, now - 90000)] }),
    ];
    const { count, oldestStart } = runningToolsInTree(items);
    if (count !== 3) throw new Error(`expected 3 running, got ${count}`);
    if (Math.abs(oldestStart - (now - 90000)) > 1)
      throw new Error(`expected the nested 90s-old claim, got ${now - oldestStart}ms ago`);

    // Nothing running → no wait to report, whatever stamps are lying around.
    const settled = runningToolsInTree([tool(TOOL_STATES.COMPLETED, now - 1000)]);
    if (settled.oldestStart !== 0)
      throw new Error(`a settled tree should report no claim, got ${settled.oldestStart}`);

    // Running but unstamped: a real wait we cannot date. Counted, but no age.
    const unstamped = runningToolsInTree([tool(TOOL_STATES.RUNNING)]);
    if (unstamped.count !== 1 || unstamped.oldestStart !== 0)
      throw new Error(`unstamped running tool should count without an age, got ${JSON.stringify(unstamped)}`);
    passed++;
  } catch (e) { failed++; errors.push(`runningToolsInTree dates the live wait: ${e.message}`); }

  // B — the opt-in. A spinner without `live` must ignore clubs and rate
  // entirely: the fetch-waiters around the app depend on staying exactly as
  // they are.
  try {
    const el = mount(false); mounted.push(el);
    if (el.isLive !== false) throw new Error('expected isLive false without the attribute');
    el.clubs = 7;
    el.rate = 2;
    if (el.clubs !== 3) throw new Error(`non-live spinner changed club count to ${el.clubs}`);
    if (el.rate !== 1) throw new Error(`non-live spinner changed rate to ${el.rate}`);
    if (el.children.length !== 3)
      throw new Error(`non-live spinner has ${el.children.length} clubs, expected 3`);
    passed++;
  } catch (e) { failed++; errors.push(`non-live spinner ignores setters: ${e.message}`); }

  // C — growth is immediate (the informative edge) and clamps at both ends.
  // Below the floor stays at the resting three, above the cap stays at seven.
  try {
    const el = mount(true); mounted.push(el);
    if (el.clubs !== 3) throw new Error(`expected resting 3, got ${el.clubs}`);

    el.clubs = 1;
    if (el.clubs !== 3) throw new Error(`one running tool should rest at 3, got ${el.clubs}`);

    el.clubs = 5;
    if (el.clubs !== 5) throw new Error(`expected 5, got ${el.clubs}`);
    if (el.children.length !== 5)
      throw new Error(`expected 5 pivots, got ${el.children.length}`);

    el.clubs = 99;
    if (el.clubs !== 7) throw new Error(`expected clamp to 7, got ${el.clubs}`);
    if (el.children.length !== 7)
      throw new Error(`expected 7 pivots, got ${el.children.length}`);
    passed++;
  } catch (e) { failed++; errors.push(`club count growth and clamping: ${e.message}`); }

  // D — re-spacing writes an even set of slot angles, so the cascade stays
  // evenly distributed at any count rather than bunching.
  try {
    const el = mount(true); mounted.push(el);
    el.clubs = 6;
    const angles = Array.from(el.children).map((/** @type {any} */ p) =>
      parseFloat(p.style.getPropertyValue('--spinner-angle')));
    const expected = [0, 60, 120, 180, 240, 300];
    for (let i = 0; i < expected.length; i++) {
      if (Math.abs(angles[i] - expected[i]) > 0.01)
        throw new Error(`slot ${i}: expected ${expected[i]}deg, got ${angles[i]}deg`);
    }
    const phases = Array.from(el.children).map((/** @type {any} */ p) =>
      p.style.getPropertyValue('--spinner-phase'));
    if (phases.join(',') !== '0,1,2,3,4,5')
      throw new Error(`expected phases 0..5, got ${phases.join(',')}`);
    if (el.style.getPropertyValue('--spinner-n') !== '6')
      throw new Error(`expected --spinner-n 6, got ${el.style.getPropertyValue('--spinner-n')}`);
    passed++;
  } catch (e) { failed++; errors.push(`re-spacing distributes slots evenly: ${e.message}`); }

  // E — shrinking is deferred. A count that drops must NOT collapse the cascade
  // on the spot, or a draining batch would step it down one club at a time.
  try {
    const el = mount(true); mounted.push(el);
    el.clubs = 6;
    el.clubs = 3;
    if (el.clubs !== 6)
      throw new Error(`shrink should be deferred, but count changed to ${el.clubs} immediately`);
    // The shrink lands once the quiet period has passed: wait for it, not for
    // a guess at how long a loaded lane takes to run the timer.
    await waitFor(() => el.clubs === 3, () => `the deferred shrink to 3 (still ${el.clubs}; `
      + `connected ${el.isConnected}, shrink timer ${el._shrinkTimer ? 'armed' : 'none'})`, 3000);
    passed++;
  } catch (e) { failed++; errors.push(`shrink is deferred: ${e.message}`); }

  // F — a re-grow during the quiet period cancels the pending shrink, so a
  // batch that dips and recovers never visibly collapses.
  try {
    const el = mount(true); mounted.push(el);
    el.clubs = 6;
    el.clubs = 4;      // arms the deferred shrink
    el.clubs = 6;      // back up before it fires — must cancel it
    // A control armed just after it, and left to fire: once the control has
    // shrunk, the cancelled shrink's quiet period has passed too, however long
    // this lane's timers took to get there.
    const control = mount(true); mounted.push(control);
    control.clubs = 6;
    control.clubs = 4;
    await waitFor(() => control.clubs === 4, () => `the control's deferred shrink to 4 (still ${control.clubs})`, 3000);
    if (el.clubs !== 6)
      throw new Error(`expected the pending shrink to be cancelled, got ${el.clubs}`);
    passed++;
  } catch (e) { failed++; errors.push(`re-grow cancels pending shrink: ${e.message}`); }

  // G — rate is applied to every animation via updatePlaybackRate, and clamped.
  // This is what keeps the cascade from jumping: nothing rewrites --duration.
  try {
    const el = mount(true); mounted.push(el);

    // Assert that the spinner ASKS every animation for the new rate, rather than
    // reading playbackRate back afterwards. updatePlaybackRate deliberately
    // stages the change (that deferral is the point — it preserves each
    // animation's current time instead of re-mapping progress and jumping), and
    // the browser only commits it on an animation frame. This harness page is
    // hidden — the pool window lives offscreen — so no frames are produced and a
    // staged rate can sit uncommitted indefinitely; reading it back asserted on
    // the compositor rather than on the spinner, and passed only when an
    // incidental style flush happened to commit it.
    //
    // Spied on the prototype, so the record survives the wholesale animation
    // rebuild a spinner performs on its first visibility edge (restart() reflows
    // and CSS builds fresh Animation objects, which _reapply then re-rates).
    const animProto = /** @type {any} */ (globalThis).Animation.prototype;
    const realUpdate = animProto.updatePlaybackRate;
    /** @type {Map<any, number>} Rate each animation was last asked for. */
    const asked = new Map();
    /** @returns {any[]} Every animation currently driving the cascade. */
    const animsNow = () => {
      /** @type {any[]} */ const list = [];
      for (const node of Array.from(el.querySelectorAll('.spinner-orbit, .spinner-club'))) {
        for (const a of /** @type {any} */ (node).getAnimations()) list.push(a);
      }
      return list;
    };
    try {
      animProto.updatePlaybackRate = function (/** @type {number} */ r) {
        asked.set(this, r);
        return realUpdate.call(this, r);
      };

      el.rate = 1.75;
      if (Math.abs(el.rate - 1.75) > 0.001) throw new Error(`expected 1.75, got ${el.rate}`);

      // Pin the expected population: one orbit and one flip per resting club.
      // Without it the check passes on a partial cascade — a rebuild can be
      // caught mid-flight, and "every animation I could see was asked" is
      // vacuously true of the three it happened to see.
      const EXPECTED_ANIMS = 6; // resting 3 clubs × (orbit + flip)


      // Application is coalesced onto a trailing timer, so give it a bounded
      // wait — a timer, not a frame, so it fires on a hidden page.
      // Report on the same set the decision was made from: re-resolving for the
      // message can read a cascade the spinner has since rebuilt, and describe a
      // set that never failed.
      const asking = 1.75;
      // Stated as "was asked, and for the right rate" rather than as a distance
      // test on a missing value: `Math.abs(undefined - r) >= eps` is NaN >= eps,
      // which is false, so an animation that was never asked at all would read
      // as satisfying the assertion.
      const wasAsked = (/** @type {any} */ a) => {
        const r = asked.get(a);
        return typeof r === 'number' && Math.abs(r - asking) < 0.001;
      };
      let count = 0, missed = 0;
      const landed = () => {
        const list = animsNow();
        count = list.length;
        missed = list.filter(a => !wasAsked(a)).length;
        return count === EXPECTED_ANIMS && missed === 0;
      };
      await waitFor(landed, {
        timeoutMs: 1000,
        description: () => `all ${EXPECTED_ANIMS} animations to be asked for 1.75 (saw ${count}, of which ${missed} never were)`,
      });
    } finally {
      animProto.updatePlaybackRate = realUpdate;
    }

    el.rate = 99;
    if (el.rate !== 2) throw new Error(`expected clamp to 2, got ${el.rate}`);
    el.rate = 0;
    if (el.rate !== 0.25) throw new Error(`expected clamp to 0.25, got ${el.rate}`);
    passed++;
  } catch (e) { failed++; errors.push(`rate applies to animations and clamps: ${e.message}`); }

  // H — clubs added mid-flight join in step. Their orbit animation must adopt
  // the cascade's current time, or a new club flies at its own phase.
  try {
    const el = mount(true); mounted.push(el);
    // Put the cascade well off frame 0, so a new club left at its own phase
    // shows as a spread. Set rather than waited for: this page is hidden and
    // produces no frames, so its animations need not advance on their own.
    for (const node of Array.from(el.querySelectorAll('.spinner-orbit, .spinner-club'))) {
      for (const a of /** @type {any} */ (node).getAnimations()) a.currentTime = 500;
    }
    el.clubs = 5;
    const times = [];
    for (const node of Array.from(el.querySelectorAll('.spinner-orbit'))) {
      for (const a of /** @type {any} */ (node).getAnimations()) times.push(a.currentTime);
    }
    if (times.length !== 5) throw new Error(`expected 5 orbit animations, got ${times.length}`);
    const spread = Math.max(...times) - Math.min(...times);
    if (spread > 20)
      throw new Error(`orbit animations out of step by ${spread}ms — new clubs did not sync`);
    passed++;
  } catch (e) { failed++; errors.push(`new clubs join in phase: ${e.message}`); }

  // J — throughput maps onto speed with a floor. A stall must still turn (the
  // spinner's job is to say "working"), and a burst must not exceed the cap.
  try {
    const el = mount(true); mounted.push(el);
    el.throughput = 0;
    if (Math.abs(el.rate - 0.25) > 0.001)
      throw new Error(`a stall should sit at the floor 0.25, got ${el.rate}`);

    el.throughput = 120;   // the reference "fast" rate
    if (Math.abs(el.rate - 2) > 0.001)
      throw new Error(`120 tok/s should reach the cap 2, got ${el.rate}`);

    el.throughput = 100000; // absurd burst
    if (Math.abs(el.rate - 2) > 0.001)
      throw new Error(`a burst should stay capped at 2, got ${el.rate}`);

    el.throughput = 60;    // half the reference → half the span above the floor
    if (Math.abs(el.rate - 1.125) > 0.001)
      throw new Error(`60 tok/s should map to 1.125, got ${el.rate}`);

    // Garbage in must not move the spinner to some arbitrary speed.
    el.throughput = 60;
    const before = el.rate;
    el.throughput = NaN;
    if (Math.abs(el.rate - 0.25) > 0.001)
      throw new Error(`NaN should read as no flow (0.25), got ${el.rate} (was ${before})`);
    passed++;
  } catch (e) { failed++; errors.push(`throughput maps onto rate: ${e.message}`); }

  // K — a non-live spinner ignores throughput too, so the fetch-waiters keep
  // their fixed speed no matter what anyone sets on them.
  try {
    const el = mount(false); mounted.push(el);
    el.throughput = 500;
    if (el.rate !== 1) throw new Error(`non-live spinner changed rate to ${el.rate}`);
    passed++;
  } catch (e) { failed++; errors.push(`non-live spinner ignores throughput: ${e.message}`); }

  // N — report() as the whole speed model: waiting is slow, streaming is quick,
  // and a tool call tires slowly rather than dropping to the floor the instant
  // the tokens stop.
  try {
    const el = mount(true); mounted.push(el);

    // Waiting — turn in flight, nothing back yet. The floor, immediately.
    el.report({ throughput: 0, toolWaitMs: null });
    if (Math.abs(el.rate - 0.25) > 0.001)
      throw new Error(`a waiting turn should sit at the floor 0.25, got ${el.rate}`);

    // Streaming — speed reads off the flow.
    el.report({ throughput: 120 });
    if (Math.abs(el.rate - 2) > 0.001)
      throw new Error(`streaming at 120 tok/s should reach 2, got ${el.rate}`);

    // A tool call starts. No output is arriving, but the machine is working —
    // this must NOT read as the stall it looks like from throughput alone.
    el.report({ throughput: 0, toolWaitMs: 0 });
    if (Math.abs(el.rate - 1) > 0.001)
      throw new Error(`a fresh tool call should run at 1, got ${el.rate}`);

    // ...and tires linearly across the minute.
    el.report({ throughput: 0, toolWaitMs: 30000 });
    if (Math.abs(el.rate - 0.625) > 0.001)
      throw new Error(`30s into a tool call should be half-way down (0.625), got ${el.rate}`);
    el.report({ throughput: 0, toolWaitMs: 60000 });
    if (Math.abs(el.rate - 0.25) > 0.001)
      throw new Error(`60s into a tool call should reach the floor, got ${el.rate}`);
    el.report({ throughput: 0, toolWaitMs: 3600000 });
    if (Math.abs(el.rate - 0.25) > 0.001)
      throw new Error(`an hour in should stay at the floor, got ${el.rate}`);

    // The slow tool finishes and the next one starts: the wait we are dating is
    // young again, so the cascade recovers. This is the behaviour the ramp
    // exists for — one long tool must not slow everything that follows it.
    el.report({ throughput: 0, toolWaitMs: 200 });
    if (el.rate < 0.99)
      throw new Error(`a new tool call should restore full speed, got ${el.rate}`);

    // The slowdown has to be imperceptible: one second of ramp is about a
    // percent of orbital speed, nowhere near a visible lurch.
    el.report({ throughput: 0, toolWaitMs: 20000 });
    const before = el.rate;
    el.report({ throughput: 0, toolWaitMs: 21000 });
    const step = before - el.rate;
    if (!(step > 0) || step > 0.02)
      throw new Error(`one second of ramp should be a small decrease, got ${step}`);

    // A tool call in flight outranks any throughput reading: the wait is the
    // truth of the moment, and the flow number belongs to a phase that ended.
    el.report({ throughput: 120, toolWaitMs: 60000 });
    if (Math.abs(el.rate - 0.25) > 0.001)
      throw new Error(`a tool wait should outrank throughput, got ${el.rate}`);
    passed++;
  } catch (e) { failed++; errors.push(`report drives waiting/streaming/tool speeds: ${e.message}`); }

  // O — a non-live spinner ignores report() as it ignores everything else.
  try {
    const el = mount(false); mounted.push(el);
    el.report({ throughput: 500, toolWaitMs: 120000 });
    if (el.rate !== 1) throw new Error(`non-live spinner changed rate to ${el.rate}`);
    passed++;
  } catch (e) { failed++; errors.push(`non-live spinner ignores report: ${e.message}`); }

  // I — the club count never reaches the accessibility tree. The host is a
  // role=status region, so clubs coming and going must not announce anything.
  try {
    const el = mount(true); mounted.push(el);
    el.clubs = 6;
    if (el.getAttribute('aria-label') !== 'Working')
      throw new Error(`aria-label changed to ${el.getAttribute('aria-label')}`);
    for (const pivot of Array.from(el.children)) {
      if (/** @type {Element} */ (pivot).getAttribute('aria-hidden') !== 'true')
        throw new Error('a club is exposed to assistive tech');
    }
    passed++;
  } catch (e) { failed++; errors.push(`club churn is silent to assistive tech: ${e.message}`); }

  // L — the throughput source itself. The contract that matters is the honest
  // zero: every phase that isn't streaming must report no flow rather than a
  // stale or inferred rate, because a spinner speed is a claim about reality.
  // Sampled and read per thread, so a column reports the flow into the run it
  // is showing rather than whatever some sibling is doing; '' is the root's key.
  try {
    const llm = new LLMState();
    const id = 'conv-throughput';
    const root = '';

    if (llm.getThroughput(id, root) !== 0) throw new Error('idle conversation should report 0');

    // Streaming with output advancing → a positive rate.
    llm.start(id);
    llm.updateStatus(id, 'streaming', { outputTokens: 0 });
    llm._sampleThroughput(id, root, 0);
    // Date the anchor 60ms back, so the next sample measures a real interval.
    const anchor = llm._throughput.get(id)?.get(root);
    if (anchor) anchor.at -= 60;
    llm._sampleThroughput(id, root, 30);
    const streaming = llm.getThroughput(id, root);
    if (!(streaming > 0)) throw new Error(`streaming with advancing tokens should be > 0, got ${streaming}`);

    // A sibling thread has no samples of its own, so it reports no flow — this
    // run's rate is not the conversation's rate.
    if (llm.getThroughput(id, 'other-thread') !== 0)
      throw new Error('a thread with no samples must report 0, not a sibling\'s rate');

    // Same samples, but parked on a tool call → 0. No output is arriving, and
    // claiming otherwise would be the spinner inventing movement.
    llm.updateStatus(id, 'processing_tools', {});
    if (llm.getThroughput(id, root) !== 0)
      throw new Error(`processing_tools should report 0, got ${llm.getThroughput(id, root)}`);

    // A count that stops advancing decays to 0 rather than coasting.
    llm.updateStatus(id, 'streaming', { outputTokens: 30 });
    const stalled = llm._throughput.get(id)?.get(root);
    if (stalled) stalled.at = Date.now() - 60000;
    if (llm.getThroughput(id, root) !== 0)
      throw new Error(`a stalled count should report 0, got ${llm.getThroughput(id, root)}`);

    // Stopping clears the sample, so a later turn can't inherit a stale rate.
    llm.stop(id);
    if (llm._throughput.has(id)) throw new Error('stop() should clear the throughput sample');
    if (llm.getThroughput(id, root) !== 0) throw new Error('a stopped conversation should report 0');
    passed++;
  } catch (e) { failed++; errors.push(`LLMState.getThroughput: ${e.message}`); }

  // P — the fumble picks the club that is about to fall, not any club. The drop
  // is an outward shove along the club's own radius, so it only reads as gravity
  // near the bottom of the ring; fired at the top it flings a club upward.
  try {
    const el = mount(true); mounted.push(el);
    /** @type {any[]} */ const orbits = [];
    for (const node of Array.from(el.querySelectorAll('.spinner-orbit'))) {
      for (const a of /** @type {any} */ (node).getAnimations()) orbits.push(a);
    }
    if (orbits.length !== 3) throw new Error(`expected 3 orbit animations, got ${orbits.length}`);
    const period = Number(orbits[0].effect.getComputedTiming().duration);
    if (!(period > 0)) throw new Error('orbit animation has no measurable period');

    /**
     * Which slot's club the spinner would fumble at a given ring rotation.
     * @param {number} spunDeg - How far the ring has turned from its start.
     * @returns {number} Index of the chosen pivot.
     */
    const victimSlotAt = (spunDeg) => {
      for (const a of orbits) a.currentTime = period * (spunDeg / 360);
      el._invalidateAnimations();
      const victim = el._pickDropVictim();
      return Array.from(el.children).findIndex(p => p.contains(victim));
    };

    // Ring unrotated: clubs sit at 0/120/240deg, and the target (55deg before
    // the bottom, so 125deg) is all but on top of the second one.
    if (victimSlotAt(0) !== 1)
      throw new Error(`unrotated ring should fumble slot 1, got ${victimSlotAt(0)}`);
    // Half a turn on, those same clubs are at 180/300/60 — now the first is the
    // one heading into the bottom of its throw.
    if (victimSlotAt(180) !== 0)
      throw new Error(`half-turned ring should fumble slot 0, got ${victimSlotAt(180)}`);
    // ...and a third of a turn later it is the last one's turn.
    if (victimSlotAt(240) !== 2)
      throw new Error(`two-thirds-turned ring should fumble slot 2, got ${victimSlotAt(240)}`);
    passed++;
  } catch (e) { failed++; errors.push(`the fumble picks a falling club: ${e.message}`); }

  // Q — the fumble is allowed to finish. The class is stripped on a timer, and
  // the animation it belongs to is stated as a fraction of the orbit and then
  // stretched by playback rate — so a fixed timer would cut a slow fumble off
  // mid-fall and teleport the club back into the ring.
  try {
    const el = mount(true); mounted.push(el);
    const club = /** @type {any} */ (el.querySelector('.spinner-club'));
    club.classList.add('spinner-dropping');
    el._invalidateAnimations();
    const drop = club.getAnimations().find((/** @type {any} */ a) => a.animationName === 'juggler-spinner-drop');
    if (reducedMotion()) {
      // The club keeps its place in the cascade: under the preference the class
      // buys the spin alone, and there is no fall to run to completion.
      if (drop) throw new Error('reduced motion must leave the club in the ring');
    } else {
      if (!drop) throw new Error('spinner-dropping did not start a drop animation');

      const full = el._dropDurationMs(club);
      const nominal = Number(drop.effect.getComputedTiming().activeDuration);
      if (!(full >= nominal))
        throw new Error(`allowed ${full}ms for a ${nominal}ms fumble — it would be cut short`);

      // Halve the speed and the fumble takes twice as long in wall time. This is
      // the case that used to snap: a spinner tired by a long tool call runs well
      // below 1x, and the drop is stretched with everything else.
      drop.playbackRate = 0.5;
      const slow = el._dropDurationMs(club);
      if (!(slow > full * 1.8))
        throw new Error(`at half speed expected roughly double (${full}ms → ${slow}ms)`);
    }
    club.classList.remove('spinner-dropping');
    passed++;
  } catch (e) { failed++; errors.push(`the fumble runs to completion at any speed: ${e.message}`); }

  // M — the drop's session budget: the guarantee that stops the gag ever
  // becoming wallpaper.
  //
  // Asserted on the RESERVATION rather than by watching a club actually fall.
  // The fumble is deliberately armed seconds ahead, so waiting for one would
  // sleep the suite through that delay; and the bug this guards against was in
  // the reservation itself — two spinners both passing the budget check before
  // either had incremented it, which in a multi-column layout made "once per
  // session" mean "once per visible spinner". Counting armed spinners tests
  // that directly and instantly.
  //
  // Runs last: it spends the session's allowance, so nothing after it can arm.
  //
  // The allowance is per WINDOW, and a lane's tests share one, so an earlier
  // test that ran a turn may already have spent it — which would leave nothing
  // to arm here and read as a breach of a budget that was in fact working.
  // Take it back before counting.
  __resetDropBudgetForTests();
  const inert = mount(false); mounted.push(inert);
  const dropA = mount(true); mounted.push(dropA);
  const dropB = mount(true); mounted.push(dropB);
  const realRandom = Math.random;
  try {
    Math.random = () => 0; // always inside dropChance, always the first club
    for (let i = 0; i < 500; i++) { inert.offerDrop(); dropA.offerDrop(); dropB.offerDrop(); }
  } finally {
    Math.random = realRandom;
  }

  try {
    const armed = [inert, dropA, dropB].filter(el => el._dropTimer).length;
    if (armed > 1)
      throw new Error(`session budget breached: ${armed} spinners armed a fumble at once`);
    // Under reduced motion nothing arms at all: `offerDrop` turns 500 offers
    // down before the budget is ever consulted.
    const expected = reducedMotion() ? 0 : 1;
    if (armed !== expected)
      throw new Error(`expected ${expected} armed fumble(s)${expected === 0 ? ' under reduced motion' : ''}, got ${armed}`);
    // Nothing may fumble on the spot: a drop that fired the instant a turn
    // began would land on every trivial turn, which is not rare.
    if (document.querySelectorAll('.spinner-dropping').length !== 0)
      throw new Error('a fumble fired immediately instead of waiting out the turn');
    passed++;
  } catch (e) { failed++; errors.push(`drop session budget: ${e.message}`); }

  try {
    if (inert._dropTimer) throw new Error('non-live spinner armed a fumble');
    passed++;
  } catch (e) { failed++; errors.push(`non-live spinner never fumbles: ${e.message}`); }

  // Detaching cancels the armed fumble and refunds its impression, so the
  // budget is not silently spent by a spinner that never showed anything.
  for (const el of mounted) el.remove();

  // N — en-XA: the label a spinner gives itself is translated, whether or not
  // it is `live`; a label the caller set is the caller's and is left alone.
  // Read synchronously at connect — no animation frame is awaited.
  try {
    /** @type {string[]} */
    const raw = [];
    let checked = 0;
    let callerLabel = '';
    await underPseudoLocale('test-juggler-spinner', () => {
      for (const live of [false, true]) {
        const holder = document.createElement('div');
        document.body.appendChild(holder);
        try {
          const el = document.createElement('juggler-spinner');
          if (live) el.setAttribute('live', '');
          holder.appendChild(el);
          const shown = shownStrings(holder);
          checked += shown.length;
          for (const s of shown) if (!isPseudoLocalized(s)) raw.push(`${live ? 'live' : 'plain'}: ${s}`);
        } finally {
          holder.remove();
        }
      }
      const own = document.createElement('juggler-spinner');
      own.setAttribute('aria-label', '9');
      document.body.appendChild(own);
      callerLabel = own.getAttribute('aria-label') || '';
      own.remove();
    });
    assert(checked >= 2, `expected both spinners to show a label, saw ${checked}`);
    assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    assert(callerLabel === '9', `a caller's aria-label is kept, got ${JSON.stringify(callerLabel)}`);
    passed++;
  } catch (e) { failed++; errors.push(`en-XA spinner label: ${e.message}`); }

  // O — a page whose CSP forbids inline styles (the machine server's sessions
  // page: `style-src 'self'`) still gets a laid-out cascade: each club's slot
  // is set through the CSSOM, which CSP allows, never a parsed style attribute,
  // which it blocks.
  try {
    const frame = document.createElement('iframe');
    frame.srcdoc = '<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" '
      + 'content="default-src \'none\'; style-src \'self\'"></head><body></body></html>';
    const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
    document.body.appendChild(frame);
    try {
      await loaded;
      const doc = /** @type {Document} */ (frame.contentDocument);
      const el = document.createElement('juggler-spinner');
      doc.body.appendChild(el);
      const pivots = Array.from(el.querySelectorAll('.spinner-pivot'));
      assert(pivots.length === 3, `expected 3 clubs, got ${pivots.length}`);
      const slots = pivots.map((p) => /** @type {HTMLElement} */ (p).style.getPropertyValue('--spinner-angle').trim());
      const phases = pivots.map((p) => /** @type {HTMLElement} */ (p).style.getPropertyValue('--spinner-phase').trim());
      assert(JSON.stringify(slots) === '["0.000deg","120.000deg","240.000deg"]',
        `club slots under a strict CSP: ${JSON.stringify(slots)}`);
      assert(JSON.stringify(phases) === '["0","1","2"]', `club phases under a strict CSP: ${JSON.stringify(phases)}`);
    } finally {
      frame.remove();
    }
    passed++;
  } catch (e) { failed++; errors.push(`strict CSP spinner: ${e.message}`); }

  return { passed, failed, errors };
}
