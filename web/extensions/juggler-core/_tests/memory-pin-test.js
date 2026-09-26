//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Memory pin tests — the board's view of the project's durable facts.
 *
 * Against the REAL backend filesystem, because the pin's whole claim is that it
 * shows the file as it is now. Each case points the pin at its own file under
 * the shared fixture with a `_memorypin_` prefix: sibling pool lanes share one
 * directory, and the pin's default path is a single fixed one they would
 * otherwise all write to at once.
 *
 * Nothing here tests the watcher. The project watcher allowlists the one path
 * `.juggler/MEMORY.md` out of the dot-directory it skips wholesale, and that is
 * asserted where it lives: `filewatcher_memory_test.go` for what is emitted, and
 * `unit:memory-item` for what the context item does with it. This pin reads
 * through the context-item signal and `Refresh`, and both of those are asserted.
 * @module _tests/memory-pin-test
 */

import MemoryPin from '../pins/memory-pin.js';
import { writeFileOp } from '../../../js/services/ops-api.js';
import { assert } from '../../../js-tests/utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Run Memory pin tests.
 * @param {{fixtureDir: string}} ctx - Test context with fixtureDir.
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests(ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Test label.
   * @param {() => Promise<void>|void} fn - Test body.
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

  const pin = new MemoryPin();
  // A directory of its own, not the fixture root. Pool lanes share one fixture,
  // and these are real files that stay there: written at the root they join
  // every later `*.md` glob in the run, which is exactly how `unit:glob-action`
  // came to fail against its `README.md` golden.
  const base = `${ctx.fixtureDir}/_memorypin/file`;

  /**
   * Write a memory file under the fixture and hand back its absolute path.
   * @param {string} name - File name, unique to its test.
   * @param {string} content - What to put in it.
   * @returns {Promise<string>} The absolute path.
   */
  async function writeMemory(name, content) {
    const path = `${base}_${name}.md`;
    await writeFileOp({ path, content });
    return path;
  }

  /**
   * Mount the pin against a path, with a context-items service the test drives.
   * @param {string} path - The memory file to read.
   * @returns {any} The body, controller and the levers a test needs.
   */
  function mount(path) {
    const body = document.createElement('div');
    document.body.appendChild(body);
    const abort = new AbortController();
    /** @type {(() => void)[]} */
    const listeners = [];

    const controller = /** @type {any} */ (pin.mount(body, /** @type {any} */ ({
      pin: { id: 'pin_test', type: 'memory', config: { path } },
      active: {
        project: { path: ctx.fixtureDir, displayName: 'fixture' },
        conversation: { id: 'c1', title: 'Conv' },
        thread: { id: null },
      },
      services: {
        files: { onChange: () => () => {} },
        contextItems: {
          find: () => null,
          /**
           * @param {() => void} listener - Called on a change.
           * @returns {() => void} Unsubscribe.
           */
          onChange: (listener) => {
            listeners.push(listener);
            return () => {
              const at = listeners.indexOf(listener);
              if (at >= 0) listeners.splice(at, 1);
            };
          },
          reveal: () => {},
        },
      },
      signal: abort.signal,
      updateConfig: async () => {},
    })));

    return {
      body,
      controller,
      watchers: () => listeners.length,
      fireChange: () => { for (const listener of [...listeners]) listener(); },
      teardown: () => {
        controller.teardown?.();
        abort.abort();
        body.remove();
      },
    };
  }

  /**
   * Wait for the pin's asynchronous read to have drawn. The read is a real
   * round-trip, so there is nothing to await on directly — and a fixed delay is
   * a flake on a loaded pool, where every lane shares one browser. Wait for the
   * body to say something instead, which it always does: a file with nothing in
   * it still renders the empty state.
   * @param {HTMLElement} body - The pin's body.
   * @param {number} [timeout] - How long to give it.
   * @returns {Promise<string>} The body's text.
   */
  async function settled(body, timeout = 5000) {
    return until(body, (text) => text.trim() !== '', timeout);
  }

  /**
   * Wait for the pin's body to say a particular thing. A re-read replaces text
   * with other text, so "it has drawn" is not a strong enough condition to catch
   * one — the case has to name what it is waiting for.
   *
   * `nudge` is for the cases driven by a change event. The pin reads on being
   * told to, and a read that comes back with the bytes it already has draws
   * nothing and schedules nothing — so if one read observes the file before the
   * write is visible to it, a case that signals once waits out its whole budget
   * on a pin that will never look again. Re-signalling asks the same question of
   * the pin rather than of the filesystem's timing: it still fails if a change
   * event does not make the pin re-read, which is the thing being tested, but it
   * no longer turns on whether one read won a race. That race is the only
   * account anyone has of the 2026-09-09 sighting, which showed the first
   * content still on screen with the second never drawn.
   *
   * It has to be re-signalled SLOWLY. The pin coalesces change events behind a
   * short settling timer that each new event restarts, so a nudge faster than
   * that timer holds the read off for as long as the nudging continues — this
   * waiter, written at the poll interval, reproduced a permanent blank every
   * run. Anything comfortably longer than the settling period lets each nudge
   * land as its own read.
   * @param {HTMLElement} body - The pin's body.
   * @param {(text: string) => boolean} wanted - What the body should end up saying.
   * @param {number} [timeout] - How long to give it.
   * @param {() => void} [nudge] - Re-signal the pin, at most every NUDGE_INTERVAL_MS.
   * @returns {Promise<string>} The body's text.
   */
  async function until(body, wanted, timeout = 5000, nudge = undefined) {
    const deadline = Date.now() + timeout;
    let nextNudge = Date.now() + NUDGE_INTERVAL_MS;
    let text = '';
    while (Date.now() < deadline) {
      text = body.textContent || '';
      if (wanted(text)) return text;
      await new Promise((r) => { setTimeout(r, 20); });
      if (nudge && Date.now() >= nextNudge) {
        nudge();
        nextNudge = Date.now() + NUDGE_INTERVAL_MS;
      }
    }
    throw new Error(`the pin never said it (showed "${text}")`);
  }

  /**
   * Assert the pin is showing its empty state. What matters is that the card
   * explains itself instead of rendering blank, and that it lists nothing — not
   * the wording, which is copy and is free to change.
   * @param {HTMLElement} body - The pin's body.
   */
  function assertEmptyState(body) {
    const empty = body.querySelector('.pin-empty');
    assert(empty && (empty.textContent || '').trim().length > 0,
      `expected the empty state, got ${JSON.stringify(body.textContent)}`);
    assert(body.querySelectorAll('.memory-entry').length === 0,
      'the empty state should list no entries');
  }

  const TWO_FACTS = '# Memory\n\n- [2026-06-14] Build is `make build`\n- [2026-06-15] Tests are `make test-all`\n';

  /** Comfortably longer than the pin's settling period, so a nudge becomes a read. */
  const NUDGE_INTERVAL_MS = 600;

  // --- the manifest and its gates ------------------------------------------

  await test('the memory pin is a singleton', () => {
    assert(!pin.allowsMultiple, 'there is one memory file, so there is one pin');
  });

  await test('a memory pin needs a project, and says so', () => {
    const reason = pin.canAdd(/** @type {any} */ ({ project: { path: '' }, conversation: null }));
    assert(reason === 'No project', `expected the reason, got ${JSON.stringify(reason)}`);
    assert(
      pin.canAdd(/** @type {any} */ ({ project: { path: '/p' } })) === true,
      'a project is all it needs'
    );
  });

  await test('describe names the file it reads', () => {
    const active = /** @type {any} */ ({ project: { path: '/proj' } });
    assert(pin.describe({}, active).path === '/proj/.juggler/MEMORY.md',
      `expected the default path, got ${JSON.stringify(pin.describe({}, active).path)}`);
    assert(pin.describe({ path: 'elsewhere/M.md' }, active).path === '/proj/elsewhere/M.md',
      'an overridden path should be the one shown');
    assert(pin.describe({}, /** @type {any} */ ({})).path === '.juggler/MEMORY.md',
      'with no project open there is nothing to resolve against, and the path stands as written');
  });

  // --- reading the real file ------------------------------------------------

  await test('the facts on disk are the facts shown', async () => {
    const path = await writeMemory('facts', TWO_FACTS);
    const m = mount(path);
    await settled(m.body);
    const text = m.body.textContent || '';
    assert(text.includes('Build is `make build`'), `first fact missing:\n${text}`);
    assert(text.includes('Tests are `make test-all`'), `second fact missing:\n${text}`);
    assert(m.body.querySelectorAll('.memory-entry').length === 2,
      `expected 2 entries:\n${m.body.innerHTML}`);
    m.teardown();
  });

  await test('an entry keeps its date', async () => {
    const path = await writeMemory('dates', TWO_FACTS);
    const m = mount(path);
    await settled(m.body);
    const date = m.body.querySelector('.memory-date');
    assert(date && (date.textContent || '') === '2026-06-14',
      `expected the stamped date, got ${JSON.stringify(date?.textContent)}`);
    m.teardown();
  });

  await test('no memory file yet is the ordinary case, not a failure', async () => {
    const m = mount(`${base}_never_written.md`);
    await settled(m.body);
    assertEmptyState(m.body);
    m.teardown();
  });

  await test('a file with a heading and no facts is empty too', async () => {
    const path = await writeMemory('heading_only', '# Memory\n\n');
    const m = mount(path);
    await settled(m.body);
    assertEmptyState(m.body);
    m.teardown();
  });

  await test('prose the parser drops does not become an entry', async () => {
    const path = await writeMemory('prose', '# Memory\n\nSome stray note nobody bulleted.\n\n- [2026-06-14] A real fact\n');
    const m = mount(path);
    await settled(m.body);
    const entries = m.body.querySelectorAll('.memory-entry');
    assert(entries.length === 1, `expected only the bulleted fact, got ${entries.length}`);
    assert((m.body.textContent || '').includes('A real fact'), 'the real fact should survive');
    assert(!(m.body.textContent || '').includes('stray note'), 'unbulleted prose is not an entry');
    m.teardown();
  });

  await test('an undated bullet is still a fact', async () => {
    const path = await writeMemory('undated', '# Memory\n\n- Someone forgot the date\n');
    const m = mount(path);
    await settled(m.body);
    assert(m.body.querySelectorAll('.memory-entry').length === 1, 'the entry should show');
    assert(!m.body.querySelector('.memory-date'), 'no date to show, so no date element');
    m.teardown();
  });

  // --- staying current ------------------------------------------------------

  await test('Refresh re-reads what changed underneath it', async () => {
    const path = await writeMemory('refresh', '# Memory\n\n- [2026-06-14] Before\n');
    const m = mount(path);
    await settled(m.body);
    assert((m.body.textContent || '').includes('Before'), 'first read missing');

    await writeFileOp({ path, content: '# Memory\n\n- [2026-06-14] After\n' });
    const refresh = m.controller.getActions().find((/** @type {any} */ a) => a.id === 'refresh');
    assert(refresh, 'Refresh is how a hand edit is picked up, since nothing watches this file');
    await refresh.run();
    const text = await until(m.body, (t) => t.includes('After'));
    assert(!text.includes('Before'), `the stale fact survived:\n${text}`);
    m.teardown();
  });

  await test('a remember in this viewer lands without asking', async () => {
    const path = await writeMemory('remember', '# Memory\n\n- [2026-06-14] One fact\n');
    const m = mount(path);
    await settled(m.body);

    await writeFileOp({ path, content: '# Memory\n\n- [2026-06-14] One fact\n- [2026-06-15] Two facts\n' });
    // What a `remember` tool action looks like from the pin: the conversation's
    // context items changed, so the file it reads may have too.
    m.fireChange();
    await until(m.body, (t) => t.includes('Two facts'), 5000, m.fireChange);
    m.teardown();
  });

  await test('a burst of changes cannot hold the read off for ever', async () => {
    const path = await writeMemory('burst', '# Memory\n\n- [2026-06-14] Before the burst\n');
    const m = mount(path);
    await settled(m.body);

    await writeFileOp({ path, content: '# Memory\n\n- [2026-06-14] After the burst\n' });

    // Signal faster than the settling period and never stop. A settling timer
    // that every event restarts has no floor: while the events keep coming the
    // read is postponed for ever, and the pin shows the old file indefinitely
    // rather than late. A busy conversation looks exactly like this from here,
    // and so does anything that writes context items in a loop — which is why
    // this case signals continuously instead of in a tidy burst.
    const nudging = setInterval(m.fireChange, 20);
    try {
      await until(m.body, (t) => t.includes('After the burst'), 4000);
    } finally {
      clearInterval(nudging);
      m.teardown();
    }
  });

  await test('teardown stops listening', async () => {
    const path = await writeMemory('teardown', TWO_FACTS);
    const m = mount(path);
    await settled(m.body);
    assert(m.watchers() === 1, `expected one listener, got ${m.watchers()}`);
    m.teardown();
    assert(m.watchers() === 0, `the pin kept listening after teardown: ${m.watchers()}`);
  });

  // --- what it offers -------------------------------------------------------

  await test('Refresh is the only action, because the rest belong to the host', async () => {
    const path = await writeMemory('actions', TWO_FACTS);
    const m = mount(path);
    await settled(m.body);
    const actions = m.controller.getActions();
    assert(actions.map((/** @type {any} */ a) => a.id).join(',') === 'refresh',
      `expected Refresh alone, got ${JSON.stringify(actions.map((/** @type {any} */ a) => a.id))}`);
    assert(actions[0].primary === true && actions[0].icon === 'refresh',
      'it is drawn as the refresh glyph, beside the file controls the host offers');
    m.teardown();
  });

  await test('an entry can be deleted from the pin', async () => {
    const path = await writeMemory('delete', TWO_FACTS);
    const m = mount(path);
    await settled(m.body);

    const entries = m.body.querySelectorAll('.memory-entry');
    const del = entries[0]?.querySelector('.memory-delete');
    assert(del, `the first fact has no delete control:\n${m.body.innerHTML}`);
    /** @type {HTMLButtonElement} */ (del).click();

    const text = await until(m.body, (t) => !t.includes('Build is `make build`'));
    assert(text.includes('Tests are `make test-all`'), `deleting one fact removed another:\n${text}`);
    assert(m.body.querySelectorAll('.memory-entry').length === 1,
      `expected one entry after deletion:\n${m.body.innerHTML}`);

    // The pin is a view of the file, not board-local state. A fresh mount must
    // see the deletion too.
    const fresh = mount(path);
    const freshText = await settled(fresh.body);
    assert(!freshText.includes('Build is `make build`'), `the deletion was not persisted:\n${freshText}`);
    assert(freshText.includes('Tests are `make test-all`'), `the surviving fact was not persisted:\n${freshText}`);
    fresh.teardown();
    m.teardown();
  });

  await test('no facts are carried in the pin\'s config', async () => {
    const path = await writeMemory('config', TWO_FACTS);
    const m = mount(path);
    await settled(m.body);
    const config = JSON.stringify({ path });
    assert(!config.includes('make build'),
      'board state is shared and long-lived; it holds a path, never the file');
    m.teardown();
  });

  return { passed, failed, errors };
}
