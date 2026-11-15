//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests: what a live file shows the user, under en-XA.
 *
 * The missing and unreadable states, an empty directory listing and the
 * size/lines/items annotation beside a path are UI text, so each is translated.
 * Paths and the read op's own error words are data, so they are digits here;
 * the size's unit is a message, so it is translated too.
 * Every read is stubbed through `ops`, so nothing touches the disk.
 * @module unit-tests/live-file-test
 */

import { underPseudoLocale } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';
import { fetchLiveFile, renderLiveFileBody, liveFileInfo } from '../lib/live-file.js';

/** juggler-core's English for this module, standing in for its catalogue. */
const CORE_TEXT = [
  "Couldn't read {path}: {error}",
  'File not found: {path}',
  '(empty)',
  'unknown error',
  '{count, plural, one {{count} item} other {{count} items}}',
  '{size} | {count, plural, one {{count} line} other {{count} lines}}',
];

/**
 * @param {string} message - What the stubbed ops throw
 * @returns {any} Ops whose every read fails with `message`
 */
function refusingOps(message) {
  const refuse = async () => { throw new Error(message); };
  return { stat: refuse, readFile: refuse, getTree: refuse };
}

/**
 * @param {import('../lib/live-file.js').LiveFileResult} result - A live read
 * @returns {string} The text renderLiveFileBody draws for it
 */
function drawn(result) {
  const body = document.createElement('div');
  renderLiveFileBody(body, result);
  return (body.textContent || '').trim();
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated results
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  try {
    await underPseudoLocale('live-file-test', async () => {
      /** @type {Record<string, string>} */
      const shown = {};

      shown.missing = drawn({ path: '/7/7', isDirectory: false, exists: false, content: '' });
      shown.refused = drawn(await fetchLiveFile('/7/7', { ops: refusingOps('7') }));
      const wordless = await fetchLiveFile('/7/7', { ops: refusingOps('') });
      shown.wordless = drawn(wordless);
      shown.emptyDirectory = drawn({ path: '/7/', isDirectory: true, exists: true, content: '' });

      shown.items = liveFileInfo({ path: '/7/', isDirectory: true, exists: true, content: '', totalLines: 7 });
      // The size is a message of its own, nested in the annotation's.
      shown.lines = liveFileInfo({ path: '/7', isDirectory: false, exists: true, content: '', size: 7777, totalLines: 7 });

      const raw = Object.entries(shown).filter(([, s]) => !s || !isPseudoLocalized(s));
      if (raw.length) throw new Error(`plain English under en-XA: ${JSON.stringify(Object.fromEntries(raw))}`);
    }, { '@juggler/core': CORE_TEXT });
    passed++;
  } catch (/** @type {any} */ e) {
    failed++;
    errors.push(`en-XA: ${e.message}`);
  }

  // `userInitiated` lifts the project-root containment on the read, so it is
  // something a caller asserts about a user gesture, never something it gets by
  // saying nothing.
  try {
    /** @type {Array<Record<string, any>>} */
    const asked = [];
    const record = async (/** @type {Record<string, any>} */ params) => { asked.push(params); return { exists: true, content: '' }; };
    const ops = /** @type {any} */ ({ stat: record, readFile: record, getTree: record });
    await fetchLiveFile('/elsewhere/x.txt', { ops });
    if (!asked.length || asked.some((p) => p.userInitiated !== false)) {
      throw new Error(`a read nobody vouched for went out as ${JSON.stringify(asked)}`);
    }
    asked.length = 0;
    await fetchLiveFile('/elsewhere/x.txt', { ops, userInitiated: true });
    if (!asked.length || asked.some((p) => p.userInitiated !== true)) {
      throw new Error(`a user-initiated read went out as ${JSON.stringify(asked)}`);
    }
    passed++;
  } catch (/** @type {any} */ e) {
    failed++;
    errors.push(`userInitiated default: ${e.message}`);
  }

  // Every op is a round trip, and over a remote link each one is felt: a file
  // is one read, not a stat and then a read. A folder named without its
  // trailing slash is learned from that same read, which answers for it
  // instead of refusing it, and only then listed.
  try {
    /** @type {string[]} */
    const calls = [];
    const ops = /** @type {any} */ ({
      stat: async () => { calls.push('stat'); return { exists: true, isDirectory: false }; },
      readFile: async (/** @type {Record<string, any>} */ params) => {
        calls.push('readFile');
        if (params.reportDirectory !== true) throw new Error('path is a directory, not a file');
        return params.path === '/7/folder'
          ? { path: params.path, exists: true, isDirectory: true }
          : { path: params.path, exists: true, content: 'x', size: 1, totalLines: 1 };
      },
      getTree: async () => { calls.push('getTree'); return { content: 'tree', fileCount: 2, dirCount: 1 }; },
    });

    const file = await fetchLiveFile('/7/file.txt', { ops });
    if (calls.join() !== 'readFile' || file.content !== 'x' || file.isDirectory) {
      throw new Error(`a file took ${JSON.stringify(calls)} and read as ${JSON.stringify(file)}`);
    }
    calls.length = 0;
    const folder = await fetchLiveFile('/7/folder', { ops });
    if (calls.join() !== 'readFile,getTree' || !folder.isDirectory || folder.content !== 'tree' || folder.totalLines !== 3) {
      throw new Error(`a folder took ${JSON.stringify(calls)} and read as ${JSON.stringify(folder)}`);
    }
    passed++;
  } catch (/** @type {any} */ e) {
    failed++;
    errors.push(`one request per file: ${e.message}`);
  }

  return { passed, failed, errors };
}
