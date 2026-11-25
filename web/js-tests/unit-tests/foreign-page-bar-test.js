//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for the desktop app's fallback bar (`js/utils/foreign-page-bar.js`),
 * the bar it lays over a page that is not Juggler's.
 *
 * The app offers the bar to every page it loads, and an offer can reach a page
 * while it is still being parsed — the next page, when the window moved on
 * before the offer ran. Each case loads a page into a same-origin frame, by
 * `document.write`, so a page can be offered the bar part-way through.
 * @module unit-tests/foreign-page-bar-test
 */

import { offerForeignPageBar } from '../../js/utils/foreign-page-bar.js';
import { assert, waitFor } from '../utilities/test-helpers.js';

const BAR_ID = '__juggler-foreign-page-bar';

/** A Juggler page: the header's caption controls are what mark it as one. */
const JUGGLER_BODY = '<body><header><window-caption-controls></window-caption-controls></header><main>Juggler</main></body></html>';
/** A page that is not Juggler's: a server's plain error page. */
const FOREIGN_BODY = '<body><pre>503 session is not running</pre></body></html>';

/** @returns {import('../../js/utils/foreign-page-bar.js').ForeignBarConfig} A configuration as the app hands the bar one. */
function config() {
  const colours = { bg: '#111', raised: '#222', border: '#333', text: '#eee', textSecondary: '#aaa', onAccent: '#fff' };
  return {
    token: 't1', prefix: 'juggler:foreign-page:', canGoBack: true, frameless: true,
    fullscreen: false, maximised: false,
    labels: { page: 'Not Juggler', back: 'Back', minimise: 'Min', maximise: 'Max', restore: 'Restore', close: 'Close' },
    gutter: '80px', strip: '6px', closeHover: '#c42b1c', closeActive: '#b22a1b', colours,
    glyphs: { svg: { viewBox: '0 0 10 10' }, minimise: [], maximise: [], restore: [], close: [] },
  };
}

const offer = offerForeignPageBar;

/**
 * A same-origin frame whose document is open for writing: still loading, its
 * <head> begun and nothing of its body parsed.
 * @returns {{frame: HTMLIFrameElement, win: Window, doc: Document}} The frame, its window and its document.
 */
function loadingFrame() {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const win = /** @type {Window} */ (frame.contentWindow);
  const doc = win.document;
  doc.open();
  doc.write('<!DOCTYPE html><html><head><title>page</title></head>');
  return { frame, win, doc };
}

/**
 * Finish writing doc and wait until it has loaded.
 * @param {Document} doc
 * @param {string} rest
 */
async function finish(doc, rest) {
  doc.write(rest);
  doc.close();
  await waitFor(() => doc.readyState === 'complete', 'the frame to finish loading');
}

/**
 * Run the foreign-page-bar test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  /** @type {string[]} */
  const errors = [];
  let passed = 0;
  let failed = 0;

  /**
   * @param {string} name
   * @param {() => Promise<void>} fn
   */
  const run = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await run('a page that is not Juggler\'s is given the bar', async () => {
    const { frame, win, doc } = loadingFrame();
    try {
      await finish(doc, FOREIGN_BODY);
      offer(config(), win);
      assert(doc.getElementById(BAR_ID) !== null, 'a foreign page was not given the bar');
    } finally {
      frame.remove();
    }
  });

  // The offer that reaches a page before its header is parsed must not judge
  // it by what has been parsed so far: a Juggler page would be left wearing a
  // bar its own later offer never takes away.
  await run('an offer made while a Juggler page loads lays no bar over it', async () => {
    const { frame, win, doc } = loadingFrame();
    try {
      offer(config(), win);
      await finish(doc, JUGGLER_BODY);
      assert(doc.getElementById(BAR_ID) === null, 'a Juggler page offered the bar while loading wears it once loaded');
    } finally {
      frame.remove();
    }
  });

  await run('an offer made while a foreign page loads gives it the bar once loaded', async () => {
    const { frame, win, doc } = loadingFrame();
    try {
      offer(config(), win);
      await finish(doc, FOREIGN_BODY);
      assert(doc.getElementById(BAR_ID) !== null, 'a foreign page offered the bar while loading has none once loaded');
    } finally {
      frame.remove();
    }
  });

  // Each offer answers for the page as it stands: a later offer to a page that
  // has a bar and is Juggler's takes the bar away.
  await run('a later offer takes an earlier bar off a Juggler page', async () => {
    const { frame, win, doc } = loadingFrame();
    try {
      await finish(doc, JUGGLER_BODY);
      const stale = doc.createElement('div');
      stale.id = BAR_ID;
      doc.body.appendChild(stale);
      offer(config(), win);
      assert(doc.getElementById(BAR_ID) === null, 'a Juggler page kept an earlier offer\'s bar');
    } finally {
      frame.remove();
    }
  });

  await run('a later offer to a foreign page leaves exactly one bar', async () => {
    const { frame, win, doc } = loadingFrame();
    try {
      await finish(doc, FOREIGN_BODY);
      offer(config(), win);
      offer({ ...config(), token: 't2' }, win);
      assert(doc.querySelectorAll(`#${BAR_ID}`).length === 1, 'two offers left more than one bar');
    } finally {
      frame.remove();
    }
  });

  return { passed, failed, errors };
}
