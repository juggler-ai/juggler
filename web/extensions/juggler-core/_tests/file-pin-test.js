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
import { writeFile } from '../../../js/services/ops-api.js';
import pinboardItemRegistry from '../../../js/registries/pinboard-item-registry.js';
import { addFilePath } from 'juggler/ui';
import { assert, waitFor } from '../../../js-tests/utilities/test-helpers.js';
import { underPseudoLocale } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';

/** juggler-core's English for this pin, standing in for its catalogue. */
const CORE_TEXT = [
  'No project', 'File', 'Add a file to view', 'File or folder path…', 'Add', 'Loading…', 'Refresh',
  '{shown, plural, one {First line of {total}.} other {First {shown} lines of {total}.}}',
];

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
    await writeFile({ path, content });
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
      // The file pin uses the file-change service alone.
      services: /** @type {import('juggler/pinboard-item-type').PinServices} */ ({
        files: {
          onChange: (listener) => {
            listeners.push(listener);
            return () => {
              const at = listeners.indexOf(listener);
              if (at >= 0) listeners.splice(at, 1);
            };
          },
        },
      }),
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
   * @returns {Promise<string>} The body's text.
   */
  function settled(body) {
    return waitFor(() => {
      const text = body.textContent || '';
      return !body.querySelector('.file-content-loading') && text.trim() ? text : '';
    }, () => `the pin to finish loading (it shows "${body.textContent}")`);
  }

  /**
   * Watch a pin's arrival check through the one call each round makes on the
   * body, `checkVisibility`. A round that finds the body hidden does what it
   * does about that synchronously, before the microtask queued from inside the
   * call runs — so any timer set between the two is one that round scheduled.
   * @param {HTMLElement} body - The pin's body.
   * @returns {{hidden: () => number, scheduledWhileHidden: () => number, restore: () => void}}
   *   Rounds that found the body hidden, how many of those scheduled a timer,
   *   and a way to stop watching.
   */
  function watchArrivalCheck(body) {
    let hidden = 0;
    let scheduledWhileHidden = 0;
    let timers = 0;
    const win = /** @type {any} */ (window);
    const realSetTimeout = win.setTimeout;
    win.setTimeout = (/** @type {any[]} */ ...args) => {
      timers++;
      return realSetTimeout(...args);
    };
    /** @type {any} */ (body).checkVisibility = (/** @type {any} */ options) => {
      const visible = HTMLElement.prototype.checkVisibility.call(body, options);
      if (!visible) {
        hidden++;
        const before = timers;
        queueMicrotask(() => { if (timers > before) scheduledWhileHidden++; });
      }
      return visible;
    };
    return {
      hidden: () => hidden,
      scheduledWhileHidden: () => scheduledWhileHidden,
      restore: () => {
        win.setTimeout = realSetTimeout;
        delete (/** @type {any} */ (body)).checkVisibility;
      },
    };
  }

  /**
   * Answer the ops calls for some paths by hand. Every stat is held until the
   * test answers it, so a test decides exactly when each round of a pin's
   * arrival check gets its reply; every read answers at once that nothing is
   * there. Calls for any other path go to the backend.
   *
   * A reply is resolved through promises alone, with no network and no task in
   * between, so two stats answered one after the other in the same task reach
   * their pins in that order.
   * @param {string[]} paths - The paths to answer for.
   * @returns {{stats: (path: string) => number, answer: (path: string, present: boolean) => void, restore: () => void}}
   *   How many stats each path has had, a way to answer its oldest held one, and a
   *   way to stop answering.
   */
  function holdStats(paths) {
    const win = /** @type {any} */ (window);
    const realFetch = win.fetch;
    /** @type {Map<string, {stats: number, held: ((present: boolean) => void)[]}>} */
    const byPath = new Map(paths.map((p) => [p, { stats: 0, held: [] }]));
    /**
     * @param {any} data - The op's data.
     * @returns {any} Enough of a Response for the ops client.
     */
    const reply = (data) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
    win.fetch = (/** @type {any} */ url, /** @type {any} */ init) => {
      const request = String(url).includes('/ops/call') ? JSON.parse(init.body) : null;
      const entry = request && byPath.get(request.params?.path);
      if (!entry) return realFetch(url, init);
      if (request.operation !== 'stat') return Promise.resolve(reply({ path: request.params.path, exists: false }));
      entry.stats++;
      return new Promise((resolve) => {
        entry.held.push((/** @type {boolean} */ present) => resolve(reply({ exists: present, isDirectory: false })));
      });
    };
    /**
     * @param {string} path - One of the paths.
     * @returns {{stats: number, held: ((present: boolean) => void)[]}} Its record.
     */
    const of = (path) => /** @type {any} */ (byPath.get(path));
    return {
      stats: (path) => of(path).stats,
      answer: (path, present) => {
        const next = of(path).held.shift();
        assert(!!next, `a stat for ${path} to answer`);
        next?.(present);
      },
      restore: () => {
        win.fetch = realFetch;
        for (const entry of byPath.values()) for (const held of entry.held.splice(0)) held(false);
      },
    };
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
    assert(outside !== '' && outside !== ctx.fixtureDir, 'the fixture must have a parent to point at');
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
      const numbers = /** @type {HTMLElement[]} */ ([...mounted.body.querySelectorAll('.ci-line')])
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
      const height = () => view?.getBoundingClientRect().height || 0;
      await waitFor(() => Math.abs(height() - wanted) < rowHeight * 2,
        () => `the block to stand ${total} rows of ${rowHeight}px tall (it is ${height()}px)`);
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
      await waitFor(() => (mounted.body.textContent || '').includes('File not found'),
        () => `a pin on a file that has gone to say so (it shows "${mounted.body.textContent}")`);
    } finally {
      mounted.teardown();
    }
  });

  /**
   * Wait for a pin's body to say something.
   * @param {HTMLElement} body - The pin's body.
   * @param {string} wanted - Text to wait for.
   * @param {string} what - What its appearing means, for the failure.
   * @param {number} timeout - Nominal time to give it.
   * @returns {Promise<boolean>} True, once it has appeared.
   */
  function eventually(body, wanted, what, timeout) {
    return waitFor(() => (body.textContent || '').includes(wanted),
      () => `${what} (it shows "${body.textContent}")`, timeout);
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
      await eventually(mounted.body, 'arrived after all', 'the pin to show the file once it exists', 5000);
    } finally {
      mounted.teardown();
    }
  });

  await test('a hidden pin stops checking for its missing file until it is shown', async () => {
    const name = `hidden_${unique}.txt`;
    const mounted = mount({ path: `${base}_${name}` });
    const arrival = watchArrivalCheck(mounted.body);
    try {
      assert((await settled(mounted.body)).includes('File not found'), 'it starts missing');
      mounted.body.style.display = 'none';
      await waitFor(() => arrival.hidden() > 0, 'a round of the arrival check to find the pin hidden', 8000);
      // The round that found the pin hidden is the check's last until it is
      // shown: it set no timer, so nothing is left to read the file written next.
      assert(arrival.scheduledWhileHidden() === 0,
        `a round that finds the pin hidden must not schedule another, but ${arrival.scheduledWhileHidden()} of ${arrival.hidden()} did`);
      await writeFixture(name, 'there while nobody looked');
      assert((mounted.body.textContent || '').includes('File not found'),
        `a hidden pin waits rather than reading, got "${mounted.body.textContent}"`);

      mounted.body.style.display = '';
      await eventually(mounted.body, 'there while nobody looked', 'the pin, shown again, to pick the file up', 8000);
    } finally {
      arrival.restore();
      mounted.teardown();
    }
  });

  // Against a pin left mounted beside it, whose stats are answered the same way
  // straight after: whatever the torn-down pin would have done with its answer
  // it would have done before the control does the same with its own.
  for (const present of [true, false]) {
    await test(`a stat in flight when the pin is torn down, answering ${present ? 'present' : 'missing'}, neither draws nor checks again`, async () => {
      const doomedPath = `${base}_inflight_${present}_${unique}.txt`;
      const controlPath = `${base}_inflight_control_${present}_${unique}.txt`;
      const ops = holdStats([doomedPath, controlPath]);
      const doomed = mount({ path: doomedPath });
      const control = mount({ path: controlPath });
      try {
        // The first stat is the read's own probe; the second is the arrival
        // check's first round, held in flight.
        await waitFor(() => ops.stats(doomedPath) === 1 && ops.stats(controlPath) === 1, 'both pins to probe their path');
        ops.answer(doomedPath, false);
        ops.answer(controlPath, false);
        assert((await settled(doomed.body)).includes('File not found'), 'it starts missing');
        assert((await settled(control.body)).includes('File not found'), 'and so does its control');
        await waitFor(() => ops.stats(doomedPath) === 2 && ops.stats(controlPath) === 2,
          'both arrival checks to have a stat in flight', 8000);

        doomed.controller.teardown?.();
        const shown = doomed.body.textContent;
        ops.answer(doomedPath, present);
        ops.answer(controlPath, present);

        await waitFor(() => ops.stats(controlPath) > 2,
          `the control to act on its answer (${present ? 'read the file' : 'check again'})`, 8000);
        assert(ops.stats(doomedPath) === 2,
          `a torn-down pin's stat answering ${present ? 'present' : 'missing'} must start nothing, but it made ${ops.stats(doomedPath) - 2} more call(s)`);
        assert(doomed.body.textContent === shown,
          `and draws nothing, but it went from "${shown}" to "${doomed.body.textContent}"`);
      } finally {
        doomed.teardown();
        control.teardown();
        ops.restore();
      }
    });
  }

  await test('a torn-down pin waiting to be shown stays quiet when it is', async () => {
    const doomedPath = `${base}_parked_${unique}.txt`;
    const controlPath = `${base}_parked_control_${unique}.txt`;
    const ops = holdStats([doomedPath, controlPath]);
    const doomed = mount({ path: doomedPath });
    const control = mount({ path: controlPath });
    const doomedArrival = watchArrivalCheck(doomed.body);
    const controlArrival = watchArrivalCheck(control.body);
    try {
      doomed.body.style.display = 'none';
      control.body.style.display = 'none';
      await waitFor(() => ops.stats(doomedPath) === 1 && ops.stats(controlPath) === 1, 'both pins to probe their path');
      ops.answer(doomedPath, false);
      ops.answer(controlPath, false);
      await waitFor(() => doomedArrival.hidden() > 0 && controlArrival.hidden() > 0,
        'both arrival checks to find their pin hidden', 8000);

      doomed.controller.teardown?.();
      doomed.body.style.display = '';
      control.body.style.display = '';

      await waitFor(() => ops.stats(controlPath) > 1, 'the control, shown, to check again', 8000);
      assert(ops.stats(doomedPath) === 1,
        `a torn-down pin must not check when shown, but it made ${ops.stats(doomedPath) - 1} more stat(s)`);
    } finally {
      controlArrival.restore();
      doomedArrival.restore();
      doomed.teardown();
      control.teardown();
      ops.restore();
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
      await writeFile({ path, content: 'after' });
      mounted.fireChange([{ path, event: 'write' }]);
      await eventually(mounted.body, 'after', 'the pin to follow the file', 5000);
    } finally {
      mounted.teardown();
    }
  });

  await test('a change to some other file is ignored', async () => {
    const path = await writeFixture('quiet.txt', 'undisturbed');
    const mounted = mount({ path });
    try {
      await settled(mounted.body);
      await writeFile({ path, content: 'changed behind its back' });
      // A change the pin takes up is answered synchronously, by scheduling the
      // debounced re-read, so whether it scheduled anything is known the moment
      // the change has been delivered.
      /**
       * @param {string} changed - The path to report changed.
       * @returns {number} How many timers delivering the change scheduled.
       */
      const deliver = (changed) => {
        const win = /** @type {any} */ (window);
        const realSetTimeout = win.setTimeout;
        let scheduled = 0;
        win.setTimeout = (/** @type {any[]} */ ...args) => {
          scheduled++;
          return realSetTimeout(...args);
        };
        try {
          mounted.fireChange([{ path: changed, event: 'write' }]);
        } finally {
          win.setTimeout = realSetTimeout;
        }
        return scheduled;
      };
      assert(deliver(`${base}_somebody_else.txt`) === 0,
        'a pin that re-read on every file change would be a poll with extra steps');
      assert((mounted.body.textContent || '').includes('undisturbed'), 'and it still shows what it read');

      // The same lever on the pinned file does schedule a re-read, which shows
      // the content written behind its back — so the silence above was the pin
      // declining the change, not a delivery that reached nothing.
      assert(deliver(path) > 0, 'a change to the pinned file schedules a re-read');
      await eventually(mounted.body, 'changed behind its back', 'the pin to re-read its own file', 5000);
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
      await writeFile({ path: `${base}_dir/appeared.txt`, content: 'new' });
      mounted.fireChange([{ path: `${base}_dir/appeared.txt`, event: 'create' }]);
      await eventually(mounted.body, 'appeared.txt',
        'a directory pin to re-list when something inside it changes', 5000);
    } finally {
      mounted.teardown();
    }
  });

  await test('a sustained burst of changes does not hold the re-read off until it ends', async () => {
    const path = await writeFixture('busy.txt', 'before the burst');
    const mounted = mount({ path });
    try {
      assert((await settled(mounted.body)).includes('before the burst'), 'it starts with what was there');
      await writeFile({ path, content: 'during the burst' });

      // Time is a queue this test owns. Every timer the pin schedules while a
      // change is being delivered goes into it instead of to the browser, and
      // runs only when the test moves the queue's clock past it — so a burst of
      // any length takes no real time and is the same on any machine.
      const win = /** @type {any} */ (window);
      const realSetTimeout = win.setTimeout;
      const realClearTimeout = win.clearTimeout;
      let now = 0;
      // Far above any id the browser hands out, so a pin clearing one of these
      // after the test has given the real timers back cancels nothing real.
      let nextId = 1e9;
      /** @type {Map<number, {at: number, fn: () => void}>} */
      const queue = new Map();
      const deliver = () => {
        win.setTimeout = (/** @type {() => void} */ fn, /** @type {number} */ ms) => {
          const id = nextId++;
          queue.set(id, { at: now + (ms || 0), fn });
          return id;
        };
        try {
          mounted.fireChange([{ path, event: 'write' }]);
        } finally {
          win.setTimeout = realSetTimeout;
        }
      };
      let reReads = 0;
      /** @param {number} ms - How far to move the clock. */
      const advance = (ms) => {
        const end = now + ms;
        for (;;) {
          /** @type {[number, {at: number, fn: () => void}] | null} */
          let due = null;
          for (const [id, entry] of queue) {
            if (entry.at <= end && (due === null || entry.at < due[1].at)) due = [id, entry];
          }
          if (due === null) break;
          queue.delete(due[0]);
          now = due[1].at;
          reReads++;
          due[1].fn();
        }
        now = end;
      };

      // A change every 100ms for three seconds: closer together than the pin's
      // 150ms settling time for twenty times as long, as a watcher on a busy
      // tree reports them on a slow core.
      // Cancelling is the queue's for the whole burst, not just each delivery:
      // a timer the pin set in one delivery may be cancelled by a later one, or
      // by another of its timers as the clock runs.
      win.clearTimeout = (/** @type {any} */ id) => {
        if (!queue.delete(id)) realClearTimeout(id);
      };
      try {
        for (let t = 0; t < 3000; t += 100) {
          deliver();
          advance(100);
        }
      } finally {
        win.clearTimeout = realClearTimeout;
      }
      assert(reReads > 0,
        'three seconds of changes 100ms apart never let the pin re-read — it shows the old file for as long as the burst lasts');
      await eventually(mounted.body, 'during the burst', 'the re-read the burst let through to show the file', 5000);
      queue.clear();
    } finally {
      mounted.teardown();
    }
  });

  await test('Refresh re-reads a change the watcher never mentioned', async () => {
    const path = await writeFixture('unwatched.txt', 'first');
    const mounted = mount({ path });
    try {
      await settled(mounted.body);
      await writeFile({ path, content: 'second' });
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
      assert(actions[0]?.primary === true && actions[0]?.icon === 'refresh',
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
    assert(outside !== '' && outside !== ctx.fixtureDir, 'the fixture must have a parent to point at');
    const mounted = mount({ path: outside, isDirectory: true });
    try {
      const text = await settled(mounted.body);
      assert(!text.includes('File not found'),
        `a pin outside the project root still reads, got "${text}"`);
    } finally {
      mounted.teardown();
    }
  });

  await test('a pin the agent made is refused outside the project, and says so', async () => {
    // The agent pins without asking, so its pin is held to the agent's own
    // reach: the project. Reading past that would put any file on the machine —
    // a key, a token — in front of whoever can see the board, remote viewers
    // included, on nobody's say-so. The user pinning the same path is the grant.
    const outside = ctx.fixtureDir.replace(/[\\/][^\\/]+$/, '');
    assert(outside !== '' && outside !== ctx.fixtureDir, 'the fixture must have a parent to point at');
    const fixtureName = ctx.fixtureDir.slice(outside.length + 1);
    const mounted = mount({ path: outside, isDirectory: true, agentRequested: true });
    try {
      const text = await settled(mounted.body);
      assert(text.includes('outside this project'), `the refusal says why, got "${text}"`);
      assert(!text.includes(fixtureName), `and lists nothing of what is there, got "${text}"`);
    } finally {
      mounted.teardown();
    }
  });

  await test('a pin the agent made reads inside the project', async () => {
    const path = await writeFixture('agent-pinned.txt', 'the agent may show this');
    const mounted = mount({ path, agentRequested: true });
    try {
      const text = await settled(mounted.body);
      assert(text.includes('the agent may show this'), `an agent-made pin inside the project reads, got "${text}"`);
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
    assert(folder.querySelector('[aria-label="Copy path to clipboard"]') !== null && folder.querySelector('reveal-button') !== null,
      'but keeps the two that mean something for a folder');
    assert(!!pinButton(folder), 'and can be put on the board like anything else');
  });

  // ========================================================================
  // en-XA
  // ========================================================================

  await test('en-XA: the add reason, tab, dialog, loading state, cut-short note and Refresh are translated', async () => {
    await underPseudoLocale('file-pin-test', async () => {
      /** @type {Record<string, string>} */
      const shown = {};
      shown['add reason'] = String(pin.canAdd(/** @type {any} */ ({ project: { path: '' } })));
      shown['tab title'] = String(pin.describe({}, /** @type {any} */ ({ project: { path: '/1' } })).title);

      // The dialog's own words. Its Cancel and Browse buttons are the picker's.
      const { panel, input, answer, abort } = openDialog();
      try {
        shown['dialog title'] = String(panel.querySelector('.pp-title')?.textContent);
        shown['dialog placeholder'] = String(input?.getAttribute('placeholder'));
        shown['dialog confirm'] = String(panel.querySelector('.pp-btn-open')?.textContent).trim();
      } finally {
        abort.abort();
        await answer;
      }

      // Every read is answered here, and cut short, so the note has to speak.
      const realFetch = window.fetch;
      window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
        if (!String(url).includes('/ops/call')) return realFetch(url, init);
        const { operation } = JSON.parse(init.body);
        const data = operation === 'stat'
          ? { exists: true, isDirectory: false }
          : { path: '/1/2.txt', exists: true, content: '1\n2', lineCount: 2, totalLines: 7 };
        return new window.Response(JSON.stringify({ success: true, data }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
      try {
        const mounted = mount({ path: '/1/2.txt' });
        try {
          shown.loading = String(mounted.body.querySelector('.file-content-loading')?.textContent);
          await waitFor(() => mounted.body.querySelector('.file-pin__note'),
            () => `the cut-short note (the pin shows "${mounted.body.textContent}")`);
          shown['cut-short note'] = String(mounted.body.querySelector('.file-pin__note')?.textContent);
          shown['refresh action'] = String(mounted.controller.getActions?.()[0]?.label);
        } finally {
          mounted.teardown();
        }
      } finally {
        window.fetch = realFetch;
      }

      const raw = Object.entries(shown).filter(([, s]) => !isPseudoLocalized(s));
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    }, { '@juggler/core': CORE_TEXT });
  });

  return { passed, failed, errors };
}
