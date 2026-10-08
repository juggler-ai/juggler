//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * File pin tests — the pinboard's live view of a path.
 *
 * Against the REAL backend filesystem: the pin's whole claim is that it shows
 * what is on disk now, and a faked read layer would assert nothing about that.
 * Files are written under the shared fixture with a `_filepin_` prefix, since
 * sibling pool lanes share one directory and unit suites get no fixture reset.
 *
 * The pin is mounted with a hand-built PinContext rather than through the board,
 * so a test can hold the file-change service and fire it. The host's half of that
 * service — the websocket subscription and the project-relative-to-absolute
 * resolution — is asserted in `unit:pinboard-shell`, against the host that owns
 * it. Which viewer claims a `.png` or a `.pdf` belongs to `unit:file-view`; what
 * is asserted here is that the pin hands the file to that machinery at all rather
 * than rendering bytes itself.
 * @module _tests/file-pin-test
 */

import FilePin from '../pins/file-pin.js';
import { fetchLiveFile, renderLiveFileBody } from '../lib/live-file.js';
import { writeFileOp } from '../../../js/services/ops-api.js';
import pinboardItemRegistry from '../../../js/registries/pinboard-item-registry.js';
import { addFilePath } from 'juggler/ui';
import { assert } from '../../../js-tests/utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * A mounted pin, with the levers a test needs: the body it filled, the
 * file-change listener it registered, and its controller.
 * @typedef {object} MountedPin
 * @property {HTMLElement} body - The container the pin filled.
 * @property {import('juggler/pinboard-item-type').PinController} controller - What mount returned.
 * @property {(changes: {path: string, event: string}[]) => void} fireChange - Deliver a file change.
 * @property {() => number} watchers - How many file-change listeners are live.
 * @property {() => void} teardown - Tear the pin down and abort its signal.
 */

/**
 * Run File pin tests.
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

  const pin = new FilePin();
  const base = `${ctx.fixtureDir}/_filepin`;

  /**
   * Write a file under the fixture and hand back its absolute path.
   * @param {string} name - File name, unique to its test.
   * @param {string} content - What to put in it.
   * @returns {Promise<string>} The absolute path.
   */
  async function writeFixture(name, content) {
    const path = `${base}_${name}`;
    await writeFileOp({ path, content });
    return path;
  }

  /**
   * Mount the pin against a config, with a file-change service the test drives.
   * @param {Record<string, any>} config - The pin's config.
   * @param {{conversationId?: string}} [options] - Active-context details.
   * @returns {MountedPin} The mounted pin and its levers.
   */
  function mount(config, options = {}) {
    const body = document.createElement('div');
    body.style.cssText = 'position:fixed;left:-10000px;top:0;width:400px;height:300px';
    document.body.appendChild(body);

    const abort = new AbortController();
    /** @type {((changes: any[]) => void)[]} */
    const listeners = [];

    const controller = /** @type {any} */ (pin.mount(body, {
      pin: { id: 'pin_test', type: 'file', config },
      active: {
        project: { path: ctx.fixtureDir, displayName: 'fixture' },
        conversation: options.conversationId ? { id: options.conversationId, title: '' } : null,
        thread: null,
      },
      services: {
        files: {
          onChange: (listener) => {
            listeners.push(listener);
            return () => {
              const at = listeners.indexOf(listener);
              if (at >= 0) listeners.splice(at, 1);
            };
          },
        },
      },
      signal: abort.signal,
      updateConfig: async () => {},
    }));

    return {
      body,
      controller,
      fireChange: (changes) => { for (const listener of [...listeners]) listener(changes); },
      watchers: () => listeners.length,
      teardown: () => {
        try {
          controller?.teardown?.();
        } finally {
          abort.abort();
          body.remove();
        }
      },
    };
  }

  /**
   * Wait for the pin's body to say something. The read is a real round-trip, so
   * there is nothing to await on directly.
   *
   * Losing the loading placeholder is not enough to wait for: `<file-view>`
   * paints its own content a frame or more later, so between the two the body
   * has neither the placeholder nor any text. Every case here expects content,
   * so wait for content — on a loaded pool that gap is wide enough to read.
   * @param {HTMLElement} body - The pin's body.
   * @param {number} [timeout] - How long to give it.
   * @returns {Promise<string>} The body's text.
   */
  async function settled(body, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const text = body.textContent || '';
      if (!body.querySelector('.file-content-loading') && text.trim()) return text;
      await new Promise((r) => { setTimeout(r, 20); });
    }
    throw new Error(`pin never finished loading (showed "${body.textContent}")`);
  }

  // ========================================================================
  // Config: normalization, dedupe, and what may become a pin
  // ========================================================================

  await test('a path is collapsed to one spelling', () => {
    assert(pin.normalizeConfig({ path: '/a//b/./c.txt' })?.path === '/a/b/c.txt',
      'repeated separators and `.` segments are collapsed');
    assert(pin.normalizeConfig({ path: '/a/b/../c.txt' })?.path === '/a/c.txt',
      '`..` is resolved against the segment before it');
    assert(pin.normalizeConfig({ path: '  /a/b.txt  ' })?.path === '/a/b.txt',
      'surrounding whitespace is not part of a path');
    assert(pin.normalizeConfig({ path: '/../etc' })?.path === '/etc',
      '`..` cannot walk above an absolute root');
  });

  await test('a trailing separator is what makes a pin a directory', () => {
    const dir = pin.normalizeConfig({ path: '/a/b/' });
    assert(dir?.path === '/a/b' && dir?.isDirectory === true,
      `a trailing slash means directory and is not kept in the path, got ${JSON.stringify(dir)}`);
    const file = pin.normalizeConfig({ path: '/a/b' });
    assert(file?.path === '/a/b' && file?.isDirectory === undefined,
      `without one it is a file and says nothing about directories, got ${JSON.stringify(file)}`);
  });

  await test('a config with no path is refused rather than pinned empty', () => {
    assert(pin.normalizeConfig({ path: '' }) === null, 'an empty path is not a pin');
    assert(pin.normalizeConfig({ path: '   ' }) === null, 'nor is whitespace');
    assert(pin.normalizeConfig({}) === null, 'nor is a config with no path at all');
    assert(pin.normalizeConfig({ path: 42 }) === null, 'nor is something that is not a string');
  });

  await test('two spellings of one file are one pin', () => {
    const a = /** @type {any} */ (pin.normalizeConfig({ path: '/a/b/../b/c.txt' }));
    const b = /** @type {any} */ (pin.normalizeConfig({ path: '/a//b/c.txt' }));
    assert(pin.isSameConfig(a, b), 'normalization is what makes the dedupe work');
    assert(!pin.isSameConfig(a, { path: '/a/b/d.txt' }), 'different files stay different pins');
  });

  await test('a live file is pinnable and a snapshot is not', () => {
    assert(FilePin.canPinSource({ kind: 'file', path: '/a/b.txt', presentation: 'live' }),
      'the live file a properties panel offers is exactly what this pin is for');
    assert(FilePin.canPinSource({ kind: 'file', path: '/a/b.txt' }),
      'a source that says nothing about presentation gets the live pin');
    assert(!FilePin.canPinSource({ kind: 'file', path: '/a/b.txt', presentation: 'snapshot' }),
      'a snapshot is a different promise, and taking it quietly would be worse than declining');
    assert(!FilePin.canPinSource({ kind: 'context-item', path: '/a/b.txt' }),
      'and this pin knows nothing about other kinds of source');
    assert(!FilePin.canPinSource({ kind: 'file', path: '  ' }), 'an empty path is not a source');
  });

  await test('a source becomes a config through the same normalization', () => {
    const config = FilePin.configFromSource({ kind: 'file', path: '/a//b/../b/c.txt', presentation: 'live' });
    assert(config?.path === '/a/b/c.txt',
      `pinning from a panel and from the picker must agree, got ${JSON.stringify(config)}`);

    // A folder pinned from a surface that knows it is one — a workspace root —
    // must become the listing pin, not a pin that tries to read a directory as
    // bytes. The picker says the same thing with a trailing slash.
    const folder = FilePin.configFromSource(
      { kind: 'file', path: '/a/b/work', isDirectory: true, presentation: 'live' });
    assert(folder?.isDirectory === true && folder?.path === '/a/b/work',
      `a source that says it is a folder pins as one, got ${JSON.stringify(folder)}`);
  });

  await test('describe reads the config and never the disk', () => {
    const described = pin.describe({ path: '/a/b/main.go' }, /** @type {any} */ ({}));
    assert(described.title === 'main.go', `the tab says the file, got "${described.title}"`);
    assert(described.path === '/a/b/main.go',
      `the toolbar is handed the file itself, got "${described.path}"`);
    assert(!described.subtitle,
      `the path is the toolbar's title now, not a second line, got "${described.subtitle}"`);
    assert(pin.describe({ path: '/a/b' , isDirectory: true }, /** @type {any} */ ({})).title === 'b/',
      'a directory says so in its title');
  });

  await test('describe resolves a relative path against the project', () => {
    const active = /** @type {any} */ ({ project: { path: '/proj' } });
    const described = pin.describe({ path: 'src/main.go' }, active);
    // The path is what the host opens, copies and reveals, so a relative one
    // would name a file nothing outside the app could find.
    assert(described.path === '/proj/src/main.go',
      `expected the resolved path, got "${described.path}"`);
  });

  await test('a path that names its own location is never joined onto the project', () => {
    const active = /** @type {any} */ ({ project: { path: '/proj' } });
    assert(pin.describe({ path: 'C:\\src\\main.go' }, active).path === 'C:\\src\\main.go',
      'a Windows drive path is absolute, and the backend reports native paths');
    assert(pin.describe({ path: '\\\\server\\share\\main.go' }, active).path === '\\\\server\\share\\main.go',
      'so is a UNC share');
  });

  await test('a pin needs a project to resolve against', () => {
    assert(pin.canAdd(/** @type {any} */ ({ project: { path: '/x' } })) === true, 'with a project, addable');
    assert(pin.canAdd(/** @type {any} */ ({ project: { path: '' } })) === 'No project',
      'without one, the picker says why rather than hiding the entry');
  });

  // ========================================================================
  // Rendering a real file
  // ========================================================================

  await test('a pinned file shows what is on disk, through the file viewer', async () => {
    const path = await writeFixture('plain.txt', 'alpha\nbeta\ngamma\n');
    const mounted = mount({ path });
    try {
      await settled(mounted.body);
      assert(!!mounted.body.querySelector('file-view'),
        'the pin hands the file to the viewer machinery rather than rendering bytes itself');
      assert((mounted.body.textContent || '').includes('beta'),
        `and what it renders is the file, got "${mounted.body.textContent}"`);
    } finally {
      mounted.teardown();
    }
  });

  await test('a pinned file says which file its lines belong to', async () => {
    // What lets a selection over those lines be quoted into the composer as a
    // reference. The numbering is the rendered rows' own; this is the other half
    // — the path those numbers are numbers in.
    const path = await writeFixture('coderef.txt', 'alpha\nbeta\ngamma');
    const mounted = mount({ path });
    try {
      await settled(mounted.body);
      const rows = [...mounted.body.querySelectorAll('.ci-line[data-line]')];
      assert(rows.length === 3, `the lines a reference would name are the rendered rows, got ${rows.length}`);
      // Resolved the way a selection resolves it: from a line, upwards.
      const host = rows[0]?.closest('[data-code-ref-path]');
      assert(!!host, 'a rendered line can find the file it belongs to');
      assert(host?.getAttribute('data-code-ref-path') === '_filepin_coderef.txt',
        `a file under the project is named relative to it, got "${host?.getAttribute('data-code-ref-path')}"`);
      assert(!host?.hasAttribute('data-code-ref-absolute'),
        'and is not marked as living outside it');
    } finally {
      mounted.teardown();
    }
  });

  await test('a pin outside the project is named in full', async () => {
    // A pin may point anywhere, and a path stripped of a root it was never under
    // would name a different file — so one outside says so and is printed whole.
    const outside = ctx.fixtureDir.replace(/[\\/][^\\/]+$/, '');
    assert(outside && outside !== ctx.fixtureDir, 'the fixture must have a parent to point at');
    const mounted = mount({ path: outside, isDirectory: true });
    try {
      await settled(mounted.body);
      const host = mounted.body.querySelector('[data-code-ref-path]');
      assert(!!host?.hasAttribute('data-code-ref-absolute'),
        'a path above the project root is marked out-of-root');
      assert(host?.getAttribute('data-code-ref-path') === outside,
        `and keeps its own spelling, got "${host?.getAttribute('data-code-ref-path')}"`);
    } finally {
      mounted.teardown();
    }
  });

  await test('a pinned directory lists what is in it', async () => {
    await writeFixture('dir/inside.txt', 'here');
    const mounted = mount({ path: `${base}_dir`, isDirectory: true });
    try {
      const text = await settled(mounted.body);
      assert(text.includes('inside.txt'), `a directory pin lists its entries, got "${text}"`);
      assert(!mounted.body.querySelector('file-view'),
        'a listing is not a file, so no viewer is asked to show one');
    } finally {
      mounted.teardown();
    }
  });

  await test('a big file is shown whole, not cut short', async () => {
    const total = 2600;
    const lines = Array.from({ length: total }, (_, i) => `line ${i + 1}`).join('\n');
    const path = await writeFixture('big.txt', lines);
    const mounted = mount({ path });
    try {
      await settled(mounted.body);
      // Past the read op's own default ceiling, so a pin that did not ask for
      // the whole file would stop at 2000 with a note saying so.
      const numbers = [...mounted.body.querySelectorAll('.ci-line')]
        .map((line) => Number(line.dataset.line));
      assert(numbers.length > 0, 'the pin rendered no lines at all');
      assert(numbers[0] === 1, `the file starts at line ${numbers[0]}, want 1`);
      const note = mounted.body.querySelector('.file-pin__note');
      assert(!note, `nothing was cut short, so there is nothing to note, got "${note?.textContent}"`);
      // Long enough to be windowed, so the last line arrives by scrolling
      // rather than by being in the DOM already; the scroll extent is what says
      // the whole file is there.
      //
      // A window stands at its full height only once it has measured a row, and
      // that measurement is a tick behind the content it measures — so the
      // height is something the block settles on, not something it renders
      // with. Poll for it on the same terms as the content above: an extent
      // that never grows still fails, and reports what it was stuck at.
      const view = mounted.body.querySelector('.ci-code-lines');
      const rowHeight = mounted.body.querySelector('.ci-line')?.getBoundingClientRect().height || 0;
      assert(rowHeight > 0, 'could not measure a row');
      const wanted = total * rowHeight;
      const deadline = Date.now() + 5000;
      let height = view?.getBoundingClientRect().height || 0;
      while (Date.now() < deadline && Math.abs(height - wanted) >= rowHeight * 2) {
        await new Promise((r) => { setTimeout(r, 20); });
        height = view?.getBoundingClientRect().height || 0;
      }
      assert(Math.abs(height - wanted) < rowHeight * 2,
        `the block is ${height}px tall, want ${total} rows of ${rowHeight}px`);
    } finally {
      mounted.teardown();
    }
  });

  await test('a path with nothing at it says so, and says which path', async () => {
    const missing = `${base}_never_written.txt`;
    const mounted = mount({ path: missing });
    try {
      const text = await settled(mounted.body);
      assert(text.includes('File not found'), `expected the missing state, got "${text}"`);
      assert(text.includes(missing), 'and the path it could not find, so the user can see the typo');
    } finally {
      mounted.teardown();
    }
  });

  await test('a read that fails says why, rather than that the file is missing', async () => {
    // The read op answers a missing file with `exists: false` and throws for
    // everything else — a refused path, an unreadable file. Those are not "not
    // found", and saying so sends the user looking for a file that is there.
    const reason = 'path "/elsewhere/x.png" is outside the working directory';
    const refuse = async () => { throw new Error(reason); };
    const result = await fetchLiveFile('/elsewhere/x.png', {
      ops: /** @type {any} */ ({ stat: refuse, readFile: refuse, getTree: refuse }),
    });
    const body = document.createElement('div');
    renderLiveFileBody(body, result);
    const text = body.textContent || '';
    assert(!text.includes('File not found'), `a refused read is not a missing file, got "${text}"`);
    assert(text.includes(reason) && text.includes('/elsewhere/x.png'),
      `it names the path and the reason, got "${text}"`);
  });

  await test('a file deleted or renamed under a pin turns into the missing state', async () => {
    const path = await writeFixture('doomed.txt', 'here for now');
    const mounted = mount({ path });
    try {
      assert((await settled(mounted.body)).includes('here for now'), 'it starts by showing the file');

      // Deleting through the test route is what a rename looks like from the
      // pin's side: the path it holds stops resolving.
      const url = `/api/test/delete-file?dir=${encodeURIComponent(ctx.fixtureDir)}`
        + `&path=${encodeURIComponent('_filepin_doomed.txt')}`;
      const response = await fetch(url, { method: 'POST' });
      assert(response.ok, 'the fixture file must actually be removed for this to prove anything');

      mounted.fireChange([{ path, event: 'remove' }]);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !(mounted.body.textContent || '').includes('File not found')) {
        await new Promise((r) => { setTimeout(r, 20); });
      }
      assert((mounted.body.textContent || '').includes('File not found'),
        `a pin on a file that has gone says so, got "${mounted.body.textContent}"`);
    } finally {
      mounted.teardown();
    }
  });

  /**
   * Poll a pin's body until it says something, or give up.
   * @param {HTMLElement} body - The pin's body.
   * @param {string} wanted - Text to wait for.
   * @param {number} timeout - How long to give it.
   * @returns {Promise<boolean>} Whether it appeared.
   */
  async function eventually(body, wanted, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if ((body.textContent || '').includes(wanted)) return true;
      await new Promise((r) => { setTimeout(r, 20); });
    }
    return (body.textContent || '').includes(wanted);
  }

  // The fixture is not reset between runs, so a file one run makes appear would
  // already be there for the next.
  const unique = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  await test('a missing file that appears later is shown, with no change event to say so', async () => {
    // The agent writing a file and pinning it in one turn: the two run in
    // parallel, the pin reads first, and a file outside what the watcher can see
    // arrives without a word.
    const name = `late_${unique}.txt`;
    const mounted = mount({ path: `${base}_${name}` });
    try {
      assert((await settled(mounted.body)).includes('File not found'), 'it starts missing');
      await writeFixture(name, 'arrived after all');
      assert(await eventually(mounted.body, 'arrived after all', 5000),
        `the pin shows the file once it exists, got "${mounted.body.textContent}"`);
    } finally {
      mounted.teardown();
    }
  });

  await test('a missing file is not checked for while the pin cannot be seen', async () => {
    const name = `hidden_${unique}.txt`;
    const mounted = mount({ path: `${base}_${name}` });
    try {
      assert((await settled(mounted.body)).includes('File not found'), 'it starts missing');
      mounted.body.style.display = 'none';
      await writeFixture(name, 'there while nobody looked');
      await new Promise((r) => { setTimeout(r, 1200); });
      assert((mounted.body.textContent || '').includes('File not found'),
        `a hidden pin waits rather than reading, got "${mounted.body.textContent}"`);

      mounted.body.style.display = '';
      assert(await eventually(mounted.body, 'there while nobody looked', 8000),
        `shown again, it picks the file up, got "${mounted.body.textContent}"`);
    } finally {
      mounted.teardown();
    }
  });

  await test('a torn-down pin stops checking for its missing file', async () => {
    const name = `abandoned_${unique}.txt`;
    const mounted = mount({ path: `${base}_${name}` });
    try {
      assert((await settled(mounted.body)).includes('File not found'), 'it starts missing');
      // The controller alone, leaving the body attached and visible, so the only
      // thing that can stop the check is the teardown.
      mounted.controller.teardown?.();
      await writeFixture(name, 'too late');
      await new Promise((r) => { setTimeout(r, 1200); });
      assert(!(mounted.body.textContent || '').includes('too late'),
        `a torn-down pin must not keep reading, got "${mounted.body.textContent}"`);
    } finally {
      mounted.teardown();
    }
  });

  // ========================================================================
  // Staying current
  // ========================================================================

  await test('a change to the pinned file re-reads it', async () => {
    const path = await writeFixture('watched.txt', 'before');
    const mounted = mount({ path });
    try {
      assert((await settled(mounted.body)).includes('before'), 'it starts with what was there');
      await writeFileOp({ path, content: 'after' });
      mounted.fireChange([{ path, event: 'write' }]);

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !(mounted.body.textContent || '').includes('after')) {
        await new Promise((r) => { setTimeout(r, 20); });
      }
      assert((mounted.body.textContent || '').includes('after'),
        `the pin follows the file, got "${mounted.body.textContent}"`);
    } finally {
      mounted.teardown();
    }
  });

  await test('a change to some other file is ignored', async () => {
    const path = await writeFixture('quiet.txt', 'undisturbed');
    const mounted = mount({ path });
    try {
      await settled(mounted.body);
      await writeFileOp({ path, content: 'changed behind its back' });
      mounted.fireChange([{ path: `${base}_somebody_else.txt`, event: 'write' }]);
      await new Promise((r) => { setTimeout(r, 400); });
      assert((mounted.body.textContent || '').includes('undisturbed'),
        'a pin that re-read on every file change would be a poll with extra steps');
    } finally {
      mounted.teardown();
    }
  });

  await test('a directory pin follows the files inside it', async () => {
    const mounted = mount({ path: `${base}_dir`, isDirectory: true });
    try {
      const before = await settled(mounted.body);
      assert(!before.includes('appeared.txt'), 'the new file is not there to begin with');

      // A file inside the directory is the directory changing.
      await writeFileOp({ path: `${base}_dir/appeared.txt`, content: 'new' });
      mounted.fireChange([{ path: `${base}_dir/appeared.txt`, event: 'create' }]);

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !(mounted.body.textContent || '').includes('appeared.txt')) {
        await new Promise((r) => { setTimeout(r, 20); });
      }
      assert((mounted.body.textContent || '').includes('appeared.txt'),
        `a directory pin re-lists when something inside it changes, got "${mounted.body.textContent}"`);
    } finally {
      mounted.teardown();
    }
  });

  await test('Refresh re-reads a change the watcher never mentioned', async () => {
    const path = await writeFixture('unwatched.txt', 'first');
    const mounted = mount({ path });
    try {
      await settled(mounted.body);
      await writeFileOp({ path, content: 'second' });
      const refresh = mounted.controller.getActions?.().find((a) => a.id === 'refresh');
      assert(!!refresh, 'the pin offers Refresh, because the watcher cannot see everything');
      await refresh?.run();
      assert((mounted.body.textContent || '').includes('second'),
        `Refresh must actually re-read, got "${mounted.body.textContent}"`);
    } finally {
      mounted.teardown();
    }
  });

  await test('tearing a pin down stops it listening', async () => {
    const path = await writeFixture('tidy.txt', 'x');
    const mounted = mount({ path });
    await settled(mounted.body);
    assert(mounted.watchers() === 1, 'a mounted pin is watching its file');
    mounted.teardown();
    assert(mounted.watchers() === 0, 'and a torn-down one is not');
  });

  await test('the toolbar offers only what the host cannot', async () => {
    const path = await writeFixture('actions.txt', 'x');
    const mounted = mount({ path });
    try {
      await settled(mounted.body);
      const actions = mounted.controller.getActions?.() || [];
      // Opening, copying and revealing the path belong to the host, which offers
      // them for any pin that names one — and offers them the same way here as
      // in a properties panel. Re-reading the file is this pin's alone.
      assert(actions.map((a) => a.id).join(',') === 'refresh',
        `expected Refresh alone, got ${JSON.stringify(actions.map((a) => a.id))}`);
      assert(actions[0].primary === true && actions[0].icon === 'refresh',
        'it is drawn as the refresh glyph, in the toolbar rather than the overflow');
      assert(actions.every((a) => typeof a.run === 'function' && a.label),
        'every action has words and something to do');
    } finally {
      mounted.teardown();
    }
  });

  // ========================================================================
  // What a pin is, and is not
  // ========================================================================

  await test('a pin holds a path and never the file', async () => {
    const secret = 'nothing-in-board-state-should-say-this';
    const path = await writeFixture('bytes.txt', secret);
    const config = /** @type {any} */ (pin.normalizeConfig({ path }));
    const mounted = mount(config);
    try {
      assert((await settled(mounted.body)).includes(secret), 'the pin can see the file');
      assert(Object.keys(config).sort().join(',') === 'path',
        `and its config is the path alone, got ${JSON.stringify(config)}`);
      assert(!JSON.stringify(config).includes(secret),
        'board state is shared and long-lived; file bytes have no business in it');
    } finally {
      mounted.teardown();
    }
  });

  await test('a pin reads outside the project, because the pin is the grant', async () => {
    // The board is scoped to the project session, and a pin is something the
    // user named on purpose — the same footing as an `@`-mention, which reads
    // outside the root for as long as it exists. So a pin keeps reading until it
    // is removed, and removing it is how you stop. A pin above the project root
    // is the cheapest honest proof: it needs no grant and there is none.
    // Either separator: the fixture path is whatever the backend calls native,
    // which on Windows is `C:\…\browser-test-x`.
    const outside = ctx.fixtureDir.replace(/[\\/][^\\/]+$/, '');
    assert(outside && outside !== ctx.fixtureDir, 'the fixture must have a parent to point at');
    const mounted = mount({ path: outside, isDirectory: true });
    try {
      const text = await settled(mounted.body);
      assert(!text.includes('File not found'),
        `a pin outside the project root still reads, got "${text}"`);
    } finally {
      mounted.teardown();
    }
  });

  await test('a pin the agent made reads outside the project too', async () => {
    // A pin shows the file to the person looking at the board and to nothing
    // else — no byte of it reaches the model — so who asked for it changes
    // nothing about what it may show.
    const outside = ctx.fixtureDir.replace(/[\\/][^\\/]+$/, '');
    assert(outside && outside !== ctx.fixtureDir, 'the fixture must have a parent to point at');
    const mounted = mount({ path: outside, isDirectory: true, agentRequested: true });
    try {
      const text = await settled(mounted.body);
      assert(!text.includes('File not found') && !text.includes("Couldn't read"),
        `an agent-made pin outside the project root still reads, got "${text}"`);
    } finally {
      mounted.teardown();
    }
  });

  // ========================================================================
  // The dialog that asks which file
  // ========================================================================

  /**
   * Open the pin's configure dialog and hand back the levers to answer it.
   * @returns {{panel: HTMLElement, input: any, answer: Promise<Record<string, any>|null>, abort: AbortController}} The open dialog.
   */
  function openDialog() {
    const abort = new AbortController();
    const answer = pin.configure({
      active: {
        project: { path: ctx.fixtureDir, displayName: 'fixture' },
        conversation: null,
        thread: null,
      },
      signal: abort.signal,
    });
    const panel = /** @type {HTMLElement} */ (document.querySelector('.pp-overlay .pp-panel'));
    return { panel, input: panel?.querySelector('path-input'), answer, abort };
  }

  await test('the file dialog takes a typed path', async () => {
    const { panel, input, answer, abort } = openDialog();
    try {
      assert(!!panel, 'the dialog opens');
      // "View" is the word that answers the question the label raises: a pin is
      // somewhere to watch a file, not a way to put one in front of the agent.
      assert(panel.querySelector('.pp-title')?.textContent === 'Add a file to view',
        'and says what it is asking for');

      const typed = `${base}_dialog.txt`;
      input.value = typed;
      input.dispatchEvent(new CustomEvent('path-change', { bubbles: true, detail: { value: typed } }));
      /** @type {HTMLButtonElement} */ (panel.querySelector('.pp-btn-open')).click();

      const config = await answer;
      assert(config?.path === typed,
        `the pin is stored against the path that was typed, got ${JSON.stringify(config)}`);
      assert(!document.querySelector('.pp-overlay'), 'and the dialog is gone');
    } finally {
      abort.abort();
    }
  });

  // A browser tab has no native host to open an OS chooser with, so the button
  // is absent rather than present and inert — the typed path with its
  // completions is the way to answer everywhere.
  await test('without a native host the dialog is the text field alone', async () => {
    const { panel, answer, abort } = openDialog();
    try {
      assert(!!panel.querySelector('path-input'), 'the field is always there');
      assert(!panel.querySelector('.pp-btn-browse'),
        'a page with no native host must not offer a chooser it cannot open');
    } finally {
      abort.abort();
      await answer;
    }
  });

  await test('cancelling the file dialog pins nothing', async () => {
    const { panel, answer, abort } = openDialog();
    try {
      /** @type {HTMLButtonElement} */ (panel.querySelector('.pp-btn-cancel')).click();
      assert(await answer === null, 'a cancelled dialog is not an error, it is no pin');
      assert(!document.querySelector('.pp-overlay'), 'and it takes itself away');
    } finally {
      abort.abort();
    }
  });

  // ========================================================================
  // The affordance that creates one
  // ========================================================================

  await test('the Pin to Pinboard button appears only when something can pin', () => {
    const wrapper = document.createElement('div');
    /**
     * @param {HTMLElement} el - The rendered row.
     * @returns {Element|null} The pin button, if the row offered one.
     */
    const pinButton = (el) => el.querySelector('[aria-label="Pin to Pinboard"]');

    const registered = pinboardItemRegistry.getType('file');
    if (registered) pinboardItemRegistry.reset();
    addFilePath(wrapper, '/a/b.txt', undefined, { pin: '/a/b.txt' });
    assert(!pinButton(wrapper),
      'with nothing enabled to take the file, the button is absent rather than inert');

    pinboardItemRegistry.registerClass(FilePin, { extensionId: 'test' });
    const withProvider = document.createElement('div');
    addFilePath(withProvider, '/a/b.txt', undefined, { pin: '/a/b.txt' });
    const button = pinButton(withProvider);
    assert(!!button, 'with the File pin enabled, the row offers to pin the file');
    assert(button?.getAttribute('title') === 'Pin to Pinboard',
      'and says what it does without being clicked');

    const noPin = document.createElement('div');
    addFilePath(noPin, '/a/b.txt');
    assert(!pinButton(noPin),
      'a path row that was not given a path to pin offers nothing — a relative path is not an identity');

    // Handing a folder to the OS and showing it where it lives are one act, so a
    // directory's row is the same row without the Open button rather than the
    // same button twice under two names.
    const folder = document.createElement('div');
    addFilePath(folder, '/a/work', undefined, { pin: '/a/work', directory: true });
    assert(!folder.querySelector('[aria-label="Open file"]'),
      'a folder is not offered an Open of its own, which is what Reveal already does');
    assert(folder.querySelector('[aria-label="Copy path to clipboard"]') && folder.querySelector('reveal-button'),
      'but keeps the two that mean something for a folder');
    assert(!!pinButton(folder), 'and can be put on the board like anything else');
  });

  return { passed, failed, errors };
}
