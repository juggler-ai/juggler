//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Memory format tests.
 *
 * `memory-format.js` is the pure, total parser/serializer for `.juggler/MEMORY.md`.
 * The grammar is a single `# Memory` heading over a flat list of dated bullets:
 *
 *   # Memory
 *
 *   - [2026-06-14] Build is `make build`
 *   - [2026-06-14] Username is jules
 *
 * The parser never throws and silently normalizes slightly-off hand edits
 * (extra blank lines, missing heading, undated bullets). The serializer emits
 * the one canonical shape, so a conforming file round-trips byte-for-byte and a
 * malformed one is tidied on the next write. Non-bullet prose is intentionally
 * dropped — the format is strict (an entry, not a margin note).
 * @module unit-tests/memory-format-test
 */

import {
  parseMemory,
  serializeMemory,
  appendEntry,
  removeEntry,
  removeMatching
} from '../lib/memory-format.js';
import { assert } from '../../../js-tests/utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Run memory-format tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => Promise<void>|void} fn
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
  }

  const CANONICAL =
    '# Memory\n' +
		'\n' +
		'- [2026-06-14] Build is `make build`\n' +
		'- [2026-06-13] Username is jules\n';

  // ---- parse ----

  await test('parses canonical file into dated entries', () => {
    const { entries } = parseMemory(CANONICAL);
    assert(entries.length === 2, `expected 2 entries, got ${entries.length}`);
    assert(entries[0]?.date === '2026-06-14', `date[0]=${entries[0]?.date}`);
    assert(entries[0]?.text === 'Build is `make build`', `text[0]=${entries[0]?.text}`);
    assert(entries[1]?.date === '2026-06-13', `date[1]=${entries[1]?.date}`);
    assert(entries[1]?.text === 'Username is jules', `text[1]=${entries[1]?.text}`);
  });

  await test('empty / whitespace / absent input yields zero entries (never throws)', () => {
    assert(parseMemory('').entries.length === 0, 'empty string');
    assert(parseMemory('   \n\n  ').entries.length === 0, 'whitespace only');
    assert(parseMemory(/** @type {any} */ (null)).entries.length === 0, 'null tolerated');
    assert(parseMemory(/** @type {any} */ (undefined)).entries.length === 0, 'undefined tolerated');
  });

  await test('tolerates missing heading and stray blank lines', () => {
    const messy = '\n\n- [2026-06-14] one\n\n\n- [2026-06-14] two\n';
    const { entries } = parseMemory(messy);
    assert(entries.length === 2, `expected 2, got ${entries.length}`);
    assert(entries[0]?.text === 'one' && entries[1]?.text === 'two', 'texts parsed despite no heading');
  });

  await test('undated bullets are kept with a null date', () => {
    const { entries } = parseMemory('# Memory\n\n- a plain note\n');
    assert(entries.length === 1, `expected 1, got ${entries.length}`);
    assert(entries[0]?.date === null, `expected null date, got ${entries[0]?.date}`);
    assert(entries[0]?.text === 'a plain note', `text=${entries[0]?.text}`);
  });

  await test('non-bullet prose lines are dropped (strict format)', () => {
    const withProse = '# Memory\n\nSome stray prose.\n- [2026-06-14] real entry\nmore prose\n';
    const { entries } = parseMemory(withProse);
    assert(entries.length === 1, `expected 1 entry, got ${entries.length}`);
    assert(entries[0]?.text === 'real entry', `text=${entries[0]?.text}`);
  });

  // ---- serialize ----

  await test('serialize emits the canonical shape', () => {
    const out = serializeMemory([
      { date: '2026-06-14', text: 'Build is `make build`' },
      { date: '2026-06-13', text: 'Username is jules' }
    ]);
    assert(out === CANONICAL, `unexpected:\n--- got ---\n${out}\n--- want ---\n${CANONICAL}`);
  });

  await test('serialize of no entries is the bare heading', () => {
    assert(serializeMemory([]) === '# Memory\n', `got: ${JSON.stringify(serializeMemory([]))}`);
  });

  await test('undated entry serializes without a date bracket', () => {
    const out = serializeMemory([{ date: null, text: 'plain note' }]);
    assert(out === '# Memory\n\n- plain note\n', `got: ${JSON.stringify(out)}`);
  });

  // ---- round-trip ----

  await test('conforming file round-trips byte-for-byte', () => {
    const out = serializeMemory(parseMemory(CANONICAL).entries);
    assert(out === CANONICAL, `round-trip drift:\n--- got ---\n${out}\n--- want ---\n${CANONICAL}`);
  });

  await test('malformed file is normalized on round-trip (idempotent thereafter)', () => {
    const messy = 'random header\n\n-   [2026-06-14]   spaced   \n\n- [2026-06-13] tidy\n';
    const once = serializeMemory(parseMemory(messy).entries);
    const twice = serializeMemory(parseMemory(once).entries);
    assert(once === twice, `normalization not idempotent:\n${once}\n---\n${twice}`);
    assert(once.includes('- [2026-06-14] spaced'), `interior whitespace collapsed: ${once}`);
  });

  // ---- appendEntry ----

  await test('appendEntry adds a dated bullet to an empty file', () => {
    const out = appendEntry('', 'first fact', '2026-06-14');
    assert(out === '# Memory\n\n- [2026-06-14] first fact\n', `got: ${JSON.stringify(out)}`);
  });

  await test('appendEntry appends after existing entries, preserving order', () => {
    const out = appendEntry(CANONICAL, 'third fact', '2026-06-15');
    const { entries } = parseMemory(out);
    assert(entries.length === 3, `expected 3, got ${entries.length}`);
    assert(entries[2]?.text === 'third fact' && entries[2]?.date === '2026-06-15', 'new entry is last');
  });

  // ---- removeEntry ----

  await test('removeEntry deletes one exact displayed item', () => {
    const withSimilar = appendEntry(CANONICAL, 'Build is `make build` elsewhere', '2026-06-15');
    const target = parseMemory(withSimilar).entries[0];
    const { content, removed } = removeEntry(withSimilar, target);
    const { entries } = parseMemory(content);
    assert(removed, 'the displayed entry should be found');
    assert(entries.length === 2, `expected one deletion, got ${entries.length} entries`);
    assert(entries.some((entry) => entry.text.endsWith('elsewhere')), 'a similar entry should survive');
  });

  // ---- removeMatching ----

  await test('removeMatching drops the single matching entry, reports it', () => {
    const { content, removed } = removeMatching(CANONICAL, 'jules');
    assert(removed.length === 1, `expected 1 removed, got ${removed.length}`);
    assert(removed[0] === 'Username is jules', `removed=${removed[0]}`);
    assert(!content.includes('jules'), 'entry gone from content');
    assert(content.includes('make build'), 'other entry retained');
  });

  await test('removeMatching is case-insensitive substring match', () => {
    const { removed } = removeMatching(CANONICAL, 'MAKE BUILD');
    assert(removed.length === 1 && (removed[0] ?? '').includes('make build'), `removed=${JSON.stringify(removed)}`);
  });

  await test('removeMatching removes all entries that match', () => {
    const multi = appendEntry(CANONICAL, 'build something else', '2026-06-15');
    const { removed } = removeMatching(multi, 'build');
    assert(removed.length === 2, `expected 2 removed, got ${removed.length}`);
  });

  await test('removeMatching with no match leaves content unchanged', () => {
    const { content, removed } = removeMatching(CANONICAL, 'nonexistent');
    assert(removed.length === 0, `expected 0 removed, got ${removed.length}`);
    assert(content === CANONICAL, 'content unchanged when nothing matches');
  });

  return { passed, failed, errors };
}
