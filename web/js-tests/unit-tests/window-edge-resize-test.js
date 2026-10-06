//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A maximised or fullscreen frameless window offers no edge resize.
 *
 * The Wails runtime hit-tests the window edges whenever its resizable flag is
 * on, and the host sets that flag from the window option alone — never on
 * maximise or fullscreen — so a maximised window kept eight resize edges.
 * utils/window-edge-resize.js wraps the runtime's setter so the window state
 * gates whatever the host says. These tests drive it through a stand-in for
 * `window._wails`: a lane has no runtime and no window to maximise.
 *
 *   1. Maximise and fullscreen take the edges away; restoring gives them back.
 *   2. The host's value arriving AFTER maximise cannot re-arm the edges — the
 *      ordering the host really produces (it re-asserts on runtime-ready and on
 *      page load).
 *   3. A host that says "not resizable" stays the ceiling.
 *   4. `data-window-edge-resize` on <html> follows the verdict.
 * @module unit-tests/window-edge-resize-test
 */

import { assert } from '../utilities/test-helpers.js';
import { installEdgeResizeGate } from '../../js/utils/window-edge-resize.js';

/**
 * A stand-in for the runtime object, recording every value its real setter
 * would have received.
 * @returns {{runtime: {setResizable: (v: boolean) => void}, calls: boolean[]}} The stand-in and its log.
 */
function fakeRuntime() {
  /** @type {boolean[]} */
  const calls = [];
  return { runtime: { setResizable: (v) => { calls.push(v); } }, calls };
}

/**
 * Run the window edge-resize suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  const errors = [];

  const root = document.documentElement;
  const hadMarker = root.dataset.windowEdgeResize;

  /**
   * @param {string} name - Case label.
   * @param {() => void} fn - Case body.
   */
  const run = (name, fn) => {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(name + ': ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  run('maximise-and-fullscreen-gate-edges', () => {
    const { runtime, calls } = fakeRuntime();
    const gate = installEdgeResizeGate(runtime);
    assert(gate !== null, 'a runtime with a setter must be wrapped');
    assert(calls.length === 0, `install must push nothing, pushed ${JSON.stringify(calls)}`);

    runtime.setResizable(true); // the host, at runtime-ready
    assert(calls.at(-1) === true, 'a restored window keeps its edges');

    gate.setMaximised(true);
    assert(calls.at(-1) === false, 'maximising must turn the edges off');
    gate.setMaximised(false);
    assert(calls.at(-1) === true, 'restoring must turn them back on');

    gate.setFullscreen(true);
    assert(calls.at(-1) === false, 'fullscreen must turn the edges off');
    gate.setMaximised(true);
    gate.setFullscreen(false);
    assert(calls.at(-1) === false, 'leaving fullscreen into a maximised window must keep them off');
    gate.setMaximised(false);
    assert(calls.at(-1) === true, 'and restoring from there gives them back');
  });

  run('late-host-value-cannot-rearm', () => {
    const { runtime, calls } = fakeRuntime();
    const gate = installEdgeResizeGate(runtime);
    gate.setMaximised(true); // the page learns it was restored maximised
    runtime.setResizable(true); // the host re-asserts on page load
    assert(calls.at(-1) === false,
      `the host's late "resizable" must not re-arm a maximised window's edges, got ${calls.at(-1)}`);
  });

  run('host-false-is-the-ceiling', () => {
    const { runtime, calls } = fakeRuntime();
    const gate = installEdgeResizeGate(runtime);
    runtime.setResizable(false);
    gate.setMaximised(true);
    gate.setMaximised(false);
    assert(calls.at(-1) === false, 'a window the host made non-resizable must stay so after a restore');
  });

  run('marker-follows-verdict', () => {
    const { runtime } = fakeRuntime();
    const gate = installEdgeResizeGate(runtime);
    runtime.setResizable(true);
    assert(root.dataset.windowEdgeResize === '1', 'live edges must be marked on <html>');
    gate.setMaximised(true);
    assert(root.dataset.windowEdgeResize === undefined, 'a maximised window must clear the marker');
  });

  run('no-runtime-is-inert', () => {
    assert(installEdgeResizeGate(undefined) === null, 'no runtime, no gate');
    assert(installEdgeResizeGate({}) === null, 'a runtime without a setter, no gate');
  });

  if (hadMarker === undefined) delete root.dataset.windowEdgeResize;
  else root.dataset.windowEdgeResize = hadMarker;

  return { passed, failed, errors };
}
