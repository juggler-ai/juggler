//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Viewer fault reporting.
 *
 * The viewer runs in a window whose console cannot be opened in a release
 * build, so a fault that reaches nothing but `console.error` reaches nobody. The
 * engine already routes its own faults to the app log from inside its worker
 * (engine-worker-runtime.js); this is the viewer's half of that, and the sink
 * every guarded callback reports through.
 *
 * It matters most on the Yjs fan-out. Every observer, and so every component
 * re-render, runs synchronously inside Y.applyUpdate, so one component throwing
 * mid-render aborts the whole transaction: the observers after it never run, and
 * without a report the only evidence is a conversation that quietly stops
 * updating.
 * @module utils/fault-report
 */

import { extractErrorMessage } from '../../sdk/lib/error-utils.js';

/**
 * Cap on reports sent per page load. A fault on the render path repeats on every
 * update, and a stream of identical stacks costs more than it says — the first
 * few carry the whole diagnosis.
 */
const MAX_FAULT_REPORTS = 50;

let faultReports = 0;

/** @type {((fault: {source: string, message: string, stack?: string, detail?: object}) => void)|null} */
let sink = null;

/**
 * Wire the transport faults are reported through. Called once during startup;
 * until it is, faults still reach the console, so a fault raised before the
 * socket exists is not lost.
 * @param {((fault: {source: string, message: string, stack?: string, detail?: object}) => void)|null} fn - The sink.
 */
export function setFaultSink(fn) {
  sink = fn;
}

/**
 * Report a fault, naming where it came from.
 * @param {string} source - What was running, e.g. 'yjs-observer' or 'unhandledrejection'.
 * @param {unknown} error - What was thrown.
 * @param {object} [detail] - Anything that narrows it down, e.g. a conversation id.
 */
export function reportFault(source, error, detail) {
  const err = error instanceof Error ? error : null;
  const message = extractErrorMessage(error);
  const stack = err?.stack;

  // The console line is unconditional: it is all a developer with dev tools
  // open needs, and it survives the cap and a missing sink.
  console.error(`[fault] ${source}: ${message}`, detail ?? '', err ?? '');

  if (faultReports++ >= MAX_FAULT_REPORTS || !sink) return;
  try {
    sink({ source, message, stack, detail });
  } catch {
    // Reporting a fault must never raise one.
  }
}

/**
 * Wrap a callback so it reports what it throws instead of throwing it at its
 * caller.
 *
 * For Yjs observers the caller is Yjs itself, part way through applying an
 * update, which is why containment belongs here rather than around the apply:
 * an observer that throws into Yjs takes the rest of that transaction's
 * observers with it, so one component's render bug blanks parts of the UI that
 * have nothing to do with it. Contained, the failure costs one component's
 * re-render and nothing else.
 *
 * Deliberately not applied to work that must be transactional — this is for
 * the fan-out, where each consumer is independent and a failure is a display
 * problem, not a correctness one.
 * @template {unknown[]} A
 * @template R
 * @param {string} source - What to name this callback in a report.
 * @param {(...args: A) => R} fn - The callback to wrap.
 * @returns {(...args: A) => (R|undefined)} The wrapped callback.
 */
export function guarded(source, fn) {
  return (/** @type {A} */ ...args) => {
    try {
      return fn(...args);
    } catch (err) {
      reportFault(source, err);
      return undefined;
    }
  };
}
