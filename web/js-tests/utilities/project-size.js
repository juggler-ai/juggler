//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * How big the shared project was when a test failed.
 *
 * Every lane in the browser pool works inside ONE session on disk, so the
 * number of conversations in it is a property of the whole run rather than of
 * any one test. Two very different runs fail tests: a healthy one, where the
 * per-suite cleanup keeps the project at a handful of conversations, and one
 * where cleanup has stopped working and the project is marching toward
 * MAX_CONVERSATIONS (32) with every lane hydrating a Yjs doc per conversation
 * on every session load. They want opposite fixes, and nothing in a failure
 * message has ever distinguished them — so a failing test reports the size it
 * failed at, and the sizes this lane saw on its way there.
 * @module utilities/project-size
 */

/**
 * Sizes this lane has seen, one entry per completed session load.
 * @type {number[]}
 */
const observations = [];

/**
 * Cap on the series. A lane runs a few hundred loads at most, but a bound
 * keeps a diagnostic from being the thing that grows without limit.
 */
const MAX_OBSERVATIONS = 400;

/**
 * Record the project size one session load saw. Called from createTestSession
 * — the single seam every unit suite and every integration test reaches a
 * loaded Session through.
 * @param {number} n - Conversations in the shared project at that moment.
 * @returns {void}
 */
export function noteProjectSize(n) {
  if (!Number.isFinite(n)) return;
  if (observations.length < MAX_OBSERVATIONS) observations.push(n);
}

/**
 * Render this lane's series as one line: how many loads it has done, the
 * range of sizes they saw, and the most recent few in order. The trajectory
 * is what separates "the project was always small" from "it grew under us".
 * @returns {string} A one-line summary, or a note that no load has happened.
 */
export function projectSizeSeries() {
  if (observations.length === 0) return 'no session load recorded in this lane';
  const min = Math.min(...observations);
  const max = Math.max(...observations);
  const recent = observations.slice(-12).join(',');
  return `loads=${observations.length} min=${min} max=${max} recent=[${recent}]`;
}

/**
 * Ask the server how big the shared project is right now.
 *
 * Bounded and non-throwing for the same reason the worker-tape fetch is: this
 * runs while building a failure message, often for a test that failed because
 * the server or a worker wedged, and a diagnostic must never be the thing that
 * stalls the lane.
 * @returns {Promise<{count: number, binned: number, ids: string[]}|null>} The live size, or null if it could not be read.
 */
export async function fetchProjectSize() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 1500);
  try {
    const resp = await fetch('/api/session', { signal: ctrl.signal });
    if (!resp.ok) return null;
    const body = await resp.json();
    const ids = Array.isArray(body?.conversationOrder) ? body.conversationOrder : [];
    return { count: ids.length, binned: Number(body?.binnedCount) || 0, ids };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * The two lines a failure message carries: the project's size at the moment
 * of the failure, and the sizes this lane saw over its life.
 * @param {{count: number, binned: number, ids: string[]}|null} live - Result of fetchProjectSize, already awaited by the caller.
 * @returns {string[]} Lines ready to append to a failure block.
 */
export function projectSizeLines(live) {
  const now = live
    ? `${live.count} conversation(s), ${live.binned} binned — [${live.ids.join(', ')}]`
    : 'unreadable (the /api/session probe did not answer)';
  return [
    `  PROJECT SIZE at failure: ${now}`,
    `  PROJECT SIZE seen by this lane: ${projectSizeSeries()}`
  ];
}
