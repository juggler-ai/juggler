//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Telling the Go harness a test is still making progress.
 *
 * The harness waits for each test's result, and the only bound it can honestly
 * apply is "the lane has stopped reporting": a fixed wall-clock wait fails a
 * test that is merely slow, which on a slow core is every long one. The lane
 * already knows when its test moves (the runner's stall watchdog), so it says
 * so, and the harness waits on for as long as it keeps hearing it
 * (`runOneBrowserTest`, `tests/integration/browser`).
 * @module js-tests/utilities/progress-report
 */

import { apiUrl } from '../../js/utils/api-url.js';

/**
 * At most one report per test this often. The harness's silence window is
 * minutes, so a report a second is far more than it needs, and cheap enough
 * that a lane on a slow core does not spend its time reporting.
 */
const REPORT_EVERY_MS = 1000;

/**
 * The page's own `fetch`, taken before any test runs. Suites stub
 * `window.fetch` and some reject whatever they do not expect, so a report sent
 * through the global would land in the stub whenever it fell inside one's
 * lifetime, and fail that suite for the harness's own traffic.
 */
const pageFetch = window.fetch.bind(window);

/** The name the harness queued the running test under; '' between tests. */
let queuedName = '';
let lastReportedAt = 0;

/**
 * Name the test this lane is now running, as the harness queued it
 * (`integration:…`, `unit:…`): the name its result is posted under, which
 * the runners below it do not carry.
 * @param {string} name - The queued name, or '' once it has finished.
 */
export function setReportedTest(name) {
  queuedName = name;
  lastReportedAt = 0;
}

/**
 * Say that the running test is still making progress. Fire-and-forget: a
 * report that fails costs the harness one data point, and must never become
 * the thing a test waits on.
 */
export function reportTestProgress() {
  const name = queuedName;
  const now = Date.now();
  if (!name || now - lastReportedAt < REPORT_EVERY_MS) return;
  lastReportedAt = now;
  void pageFetch(apiUrl('/test/progress'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  }).catch(() => {});
}
