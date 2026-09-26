//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What the machine was doing when a test failed.
 *
 * A test that waited and did not get what it wanted has two explanations — the
 * code is wrong, or nothing ran — and for most of this suite's history a failure
 * block could not tell them apart. The load average was reconstructed afterwards
 * from the suite's wall time, or guessed at, or simply asserted; a run was
 * declared void on the strength of a re-run passing, which is the one reading
 * that proves least.
 *
 * Two numbers settle it, and both are taken only once something has already
 * failed, so a passing run pays nothing:
 *
 * - **the load average**, from the server, because a page cannot read one;
 * - **the timer grid**, measured here, because a lane's clock is not the
 *   machine's. The pool window is permanently hidden and two separate mechanisms
 *   coarsen a hidden page's DOM timers to a one-second grid (see
 *   `unthrottleHiddenPageTimers` and `ensureHiddenPoolWebViewSized`,
 *   `cmd/juggler/app`). When either stops taking, every wait in the run is
 *   charged a tick and the suite looks uniformly, inexplicably slow.
 *
 * The two are different faults with opposite fixes, and a failure block that
 * carries both needs no re-run to tell them apart.
 * @module utilities/machine-load
 */

/**
 * Links in the timer chain. Past ten, WebKit's nesting-based alignment applies,
 * so a chain this long crosses the threshold and keeps measuring after it.
 */
const PROBE_LINKS = 16;

/**
 * Ceiling on the probe. A throttled chain costs a second per link, and this runs
 * while a failure message is being assembled — the same budget the tape fetches
 * come out of. Stopping early costs nothing, because the slowest link already
 * says what the grid is.
 */
const PROBE_BUDGET_MS = 2500;

/**
 * A single link costing longer than this is not a busy machine — it is a grid.
 * Zero-delay timers cost a fraction of a millisecond unthrottled and jitter to a
 * few milliseconds under load; nothing between that and a quarter second.
 */
const GRID_SUSPECT_MS = 250;

/**
 * Measure the lane's timer grid: chain zero-delay timers and keep the worst
 * single hop.
 *
 * The worst link is the reading that matters, not the total. A total divides the
 * cheap links before the nesting threshold in with the taxed ones after it and
 * lands halfway between the two answers; the slowest hop IS the grid quantum,
 * which is either a millisecond or a second and never in between.
 * @returns {Promise<{links: number, worstMs: number, totalMs: number}>} What the chain cost.
 */
export async function measureTimerGrid() {
  const started = Date.now();
  let worstMs = 0;
  let links = 0;
  while (links < PROBE_LINKS) {
    const linkStart = Date.now();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    const cost = Date.now() - linkStart;
    if (cost > worstMs) worstMs = cost;
    links++;
    if (Date.now() - started > PROBE_BUDGET_MS) break;
  }
  return { links, worstMs, totalMs: Date.now() - started };
}

/**
 * Ask the server for the machine's load average.
 *
 * Bounded and non-throwing for the same reason the project-size probe is: this
 * runs while building a failure message, often for a test that failed because
 * something wedged, and a diagnostic must never become the thing that stalls the
 * lane.
 * @returns {Promise<{available: boolean, line: string, perCpu: number}|null>} The reading, or null if it could not be read.
 */
export async function fetchMachineLoad() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 1500);
  try {
    const resp = await fetch('/api/test/machine', { signal: ctrl.signal });
    if (!resp.ok) return null;
    const body = await resp.json();
    return {
      available: Boolean(body?.available),
      line: typeof body?.line === 'string' ? body.line : '',
      perCpu: Number(body?.perCpu) || 0
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * The lines a failure block carries about the machine it ran on: what the load
 * average was, and what a timer cost in this lane.
 * @param {{available: boolean, line: string, perCpu: number}|null} load - Result of fetchMachineLoad, already awaited by the caller.
 * @param {{links: number, worstMs: number, totalMs: number}|null} grid - Result of measureTimerGrid, already awaited by the caller.
 * @returns {string[]} Lines ready to append to a failure block.
 */
export function machineLoadLines(load, grid) {
  /** @type {string[]} */
  const lines = [];

  lines.push(`  ${load?.line || 'MACHINE LOAD: unreadable (the /api/test/machine probe did not answer)'}`);

  if (grid) {
    const verdict = grid.worstMs >= GRID_SUSPECT_MS
      ? ` — a hop this long is a TIMER GRID, not load: every wait in this run is being charged a tick, and the page is ${window.innerWidth}x${window.innerHeight} (no size means the pool's web view never took one, a size means the hidden-page alignment is still on)`
      : ' (normal — this lane\'s clock is the one it asked for)';
    lines.push(`  TIMER GRID: slowest of ${grid.links} chained zero-delay timers was ${grid.worstMs}ms, ${grid.totalMs}ms for the chain${verdict}`);
  }

  return lines;
}

/**
 * Take both readings and render them. The two probes overlap: one is an HTTP
 * round-trip and the other is a chain of timers, so running them together costs
 * the longer of the two rather than their sum.
 * @returns {Promise<string[]>} Lines ready to append to a failure block.
 */
export async function machineLoadReport() {
  const [load, grid] = await Promise.all([
    fetchMachineLoad(),
    measureTimerGrid().catch(() => null)
  ]);
  return machineLoadLines(load, grid);
}
