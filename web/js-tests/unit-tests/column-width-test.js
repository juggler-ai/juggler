//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Column width persistence.
 *
 * A dragged column width belongs to the window (services/prefs.js), so it is
 * kept in the project's session and survives the app being relaunched onto a
 * different port. What that costs is a round trip, and a column cannot wait for
 * one to have a width — so a mount applies the cached width at once and takes
 * the session's answer when it arrives.
 *
 * These pin both halves, and the rule that keeps the second from being
 * destructive: a width a column was merely GIVEN is never written back, or the
 * first window to open would stamp its default over the width another window
 * had stored and this one had not yet heard about.
 * @module unit-tests/column-width-test
 */

import { waitFor } from '../utilities/test-helpers.js';
import { budgetFor } from '../utilities/test-deadline.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed number of passing assertions
 * @property {number} failed number of failing assertions
 * @property {string[]} errors list of error messages from failing assertions
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const { setupColumnResize, startingColumnWidthRem, columnWidthAtDepth, applyColumnWidthRem } =
    await import('../../js/utils/column-resize.js');
  const { setDevicePref, __resetPrefsForTests } = await import('../../js/services/prefs.js');

  /**
   * @param {string} label
   * @param {() => void|Promise<void>} fn
   */
  const run = async (label, fn) => {
    try { await fn(); passed++; }
    catch (e) { failed++; errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  let seq = 0;
  const uniqueName = () => `juggler-test-width-${Date.now().toString(36)}-${seq++}`;

  /** @type {Array<{url: string, method: string}>} */
  let calls = [];
  /** @type {Record<string, any>} */
  let realm = {};
  const realFetch = window.fetch;

  /**
   * A column with the resize handle the wiring looks for.
   * @returns {HTMLElement} The mounted element, to be removed by the caller.
   */
  const makeColumn = () => {
    const column = document.createElement('div');
    column.appendChild(document.createElement('col-resize-handle'));
    document.body.appendChild(column);
    return column;
  };

  try {
    window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
      calls.push({ url: String(url), method: (init && init.method) || 'GET' });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ui: realm }),
        json: async () => ({ ui: realm }),
      };
    });

    await run('a cached width is applied without waiting for the session', () => {
      __resetPrefsForTests();
      calls = [];
      realm = {};
      const name = uniqueName();
      setDevicePref(name, 42);
      const column = makeColumn();
      try {
        setupColumnResize(column, name, 12.5, 30);
        // Synchronously, in the same turn as the mount: this is the whole point
        // of keeping a cache in front of an asynchronous store.
        if (column.style.width !== '42rem') {
          throw new Error(`width = ${column.style.width}, want 42rem`);
        }
      } finally {
        column.remove();
      }
    });

    await run('the default is used when this window has stored nothing', () => {
      __resetPrefsForTests();
      calls = [];
      realm = {};
      const column = makeColumn();
      try {
        setupColumnResize(column, uniqueName(), 12.5, 30);
        if (column.style.width !== '30rem') {
          throw new Error(`width = ${column.style.width}, want the caller's 30rem default`);
        }
      } finally {
        column.remove();
      }
    });

    await run('a width stored only in the session arrives and is applied', async () => {
      __resetPrefsForTests();
      calls = [];
      const name = uniqueName();
      realm = { [name]: 55 };
      const column = makeColumn();
      try {
        setupColumnResize(column, name, 12.5, 30);
        await waitFor(() => column.style.width === '55rem', {
          timeoutMs: budgetFor(2000),
          description: "the session's stored width to reach the column",
        });
        // And the arrival is not a choice the user made, so nothing goes back.
        if (calls.some((c) => c.method === 'PUT')) {
          throw new Error('applying a width the session already held wrote it back again');
        }
      } finally {
        column.remove();
      }
    });

    await run('a default is never written back over what a window has stored', async () => {
      __resetPrefsForTests();
      calls = [];
      realm = {};
      const column = makeColumn();
      try {
        setupColumnResize(column, uniqueName(), 12.5, 30);
        await waitFor(() => calls.some((c) => c.method === 'GET'), {
          timeoutMs: budgetFor(2000),
          description: 'the session to be asked for the width',
        });
        if (calls.some((c) => c.method === 'PUT')) {
          throw new Error('a column that was merely given a default stored it');
        }
      } finally {
        column.remove();
      }
    });

    // The width a window with nothing stored starts at. It is arithmetic on the
    // room available, because whether a given width fits is a fact about the
    // window: leave less than the properties panel's 30rem floor beside the
    // conversation and the first panel the user opens arrives part-way off the
    // right-hand edge, which `column-container` answers with a sideways
    // scrollbar rather than a narrower panel.
    await run('the starting width leaves the properties panel its floor', () => {
      // 1520px at a 16px root is 95rem, which is the app's own default window
      // width: 15 for the tab sidebar, 50 for the conversation, 30 for the
      // panel. The window was sized from these figures, so it comes out exact.
      const wide = startingColumnWidthRem(1520, 16);
      if (wide !== 50) throw new Error(`at 1520px: ${wide}rem, want 50rem`);

      // Narrower: the conversation gives up the difference, not the panel.
      const snug = startingColumnWidthRem(1400, 16);
      if (snug !== 42.5) throw new Error(`at 1400px: ${snug}rem, want 42.5rem`);
    });

    await run('the starting width stays within its two bounds', () => {
      // Wider than any conversation needs to be: the rest goes to the panel.
      const huge = startingColumnWidthRem(4000, 16);
      if (huge !== 50) throw new Error(`at 4000px: ${huge}rem, want the 50rem ceiling`);

      // Narrower than all three can fit. Something has to overflow at this
      // size; the conversation still gets the CSS flex basis, not a sliver.
      const tiny = startingColumnWidthRem(900, 16);
      if (tiny !== 30) throw new Error(`at 900px: ${tiny}rem, want the 30rem floor`);
    });

    // Widths are stored in rem so they track the app zoom, and this is computed
    // in rem for the same reason: at 200% zoom the same window holds half as
    // many rem, and the starting width has to be the smaller number.
    await run('the starting width is in rem, so it follows the zoom', () => {
      // The same window at 200%: 47.5rem all in, so the conversation is back to
      // its floor rather than holding the 50rem it had at 100%.
      const zoomed = startingColumnWidthRem(1520, 32);
      if (zoomed !== 30) throw new Error(`at 1520px/32px rem: ${zoomed}rem, want 30rem`);
    });

    // Conversation columns keep one width per depth in the chain — the root, the
    // thread opened from it, the thread opened from that — and a depth nothing
    // has been stored for copies the deepest one that has.
    await run('a stored width is read per depth, a deeper one copying the deepest stored', () => {
      const cases = /** @type {Array<[any, number, number|null]>} */ ([
        [42, 0, 42], [42, 3, 42],
        [[30, 45], 0, 30], [[30, 45], 1, 45], [[30, 45], 4, 45],
        [[null, null, 40], 1, null], [[null, null, 40], 2, 40], [[null, null, 40], 5, 40],
        [[30, null, 40], 1, 30],
        [null, 0, null], [[], 2, null],
      ]);
      for (const [stored, depth, want] of cases) {
        const got = columnWidthAtDepth(stored, depth);
        if (got !== want) {
          throw new Error(`${JSON.stringify(stored)} at depth ${depth}: ${got}, want ${want}`);
        }
      }
    });

    /**
     * Columns at depths 0..n-1, side by side in one container as a tab holds them.
     * @param {string} name
     * @param {number} n
     * @returns {{columns: HTMLElement[], remove: () => void}} The columns, and their teardown.
     */
    const mountChain = (name, n) => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const columns = [];
      for (let depth = 0; depth < n; depth++) {
        const column = document.createElement('div');
        column.appendChild(document.createElement('col-resize-handle'));
        container.appendChild(column);
        setupColumnResize(column, name, 12.5, 30, depth);
        columns.push(column);
      }
      return { columns, remove: () => container.remove() };
    };

    await run('widening one depth leaves the columns at the others alone', () => {
      __resetPrefsForTests();
      realm = {};
      const name = uniqueName();
      const { columns: [root, thread], remove } = mountChain(name, 2);
      try {
        applyColumnWidthRem(thread, name, 44);
        if (root.style.width !== '30rem') {
          throw new Error(`root = ${root.style.width} after the thread was widened, want its 30rem`);
        }
        if (thread.style.width !== '44rem') throw new Error(`thread = ${thread.style.width}, want 44rem`);
      } finally {
        remove();
      }
      // Nor does it reach a root column built later — another conversation's,
      // or this one's when its tab is shown again.
      const again = mountChain(name, 3);
      try {
        const widths = again.columns.map((c) => c.style.width);
        if (widths.join() !== '30rem,44rem,44rem') {
          throw new Error(`rebuilt chain = ${widths.join()}, want 30rem,44rem,44rem`);
        }
      } finally {
        again.remove();
      }
    });

    await run('a deeper column that copies a depth follows it, one with its own width does not', () => {
      __resetPrefsForTests();
      realm = {};
      const name = uniqueName();
      const { columns: [, thread, inner], remove } = mountChain(name, 3);
      try {
        applyColumnWidthRem(thread, name, 44);
        if (inner.style.width !== '44rem') {
          throw new Error(`inner = ${inner.style.width} after its parent depth was widened, want 44rem`);
        }
        applyColumnWidthRem(inner, name, 50);
        applyColumnWidthRem(thread, name, 40);
        if (inner.style.width !== '50rem') {
          throw new Error(`inner = ${inner.style.width} after being given its own width, want 50rem`);
        }
      } finally {
        remove();
      }
    });

    /**
     * Dispatch a mouse pointer event, as the browser would deliver it to `target`.
     * @param {EventTarget} target
     * @param {string} type
     * @param {number} x
     */
    const pointerAt = (target, type, x) => {
      target.dispatchEvent(new PointerEvent(type, {
        pointerId: 1, pointerType: 'mouse', clientX: x, clientY: 10, bubbles: true, cancelable: true,
      }));
    };

    // A browser can fail to capture the pointer without saying so — Chrome does,
    // in a document whose tree was swapped out from under the pointer — and then
    // delivers the drag's moves and its release to whatever is under the pointer
    // instead of the handle. The drag must still follow the pointer and end.
    await run('a drag follows the pointer and ends when its events reach other elements', () => {
      __resetPrefsForTests();
      realm = {};
      const column = makeColumn();
      const elsewhere = document.createElement('div');
      document.body.appendChild(elsewhere);
      try {
        setupColumnResize(column, uniqueName(), 12.5, 30);
        const handle = /** @type {HTMLElement} */ (column.querySelector('col-resize-handle'));
        pointerAt(handle, 'pointerdown', 100);
        pointerAt(elsewhere, 'pointermove', 180);
        if (column.style.width === '30rem') {
          throw new Error('a move delivered to another element did not resize the column');
        }
        pointerAt(elsewhere, 'pointerup', 180);
        if (handle.classList.contains('dragging')) {
          throw new Error('a release delivered to another element left the handle dragging');
        }
        const ended = column.style.width;
        pointerAt(elsewhere, 'pointermove', 300);
        if (column.style.width !== ended) {
          throw new Error(`the column kept following the pointer after the release (${ended} -> ${column.style.width})`);
        }
      } finally {
        column.remove();
        elsewhere.remove();
      }
    });

    // The same document never tells the handle the pointer has left it, while it
    // still says where the pointer went: pointerover keeps arriving.
    await run('the hover clears when the pointer is over something else, leave or no leave', () => {
      __resetPrefsForTests();
      realm = {};
      const column = makeColumn();
      const elsewhere = document.createElement('div');
      document.body.appendChild(elsewhere);
      try {
        setupColumnResize(column, uniqueName(), 12.5, 30);
        const handle = /** @type {HTMLElement} */ (column.querySelector('col-resize-handle'));
        pointerAt(handle, 'pointerover', 100);
        pointerAt(handle, 'pointerenter', 100);
        if (!handle.classList.contains('hovered')) throw new Error('hovering the handle did not highlight it');
        pointerAt(elsewhere, 'pointerover', 300);
        if (handle.classList.contains('hovered')) {
          throw new Error('the handle stayed highlighted with the pointer over another element');
        }
      } finally {
        column.remove();
        elsewhere.remove();
      }
    });

    await run('a single stored width is every depth\'s, as a window that stored one before has', () => {
      __resetPrefsForTests();
      realm = {};
      const name = uniqueName();
      setDevicePref(name, 42);
      const { columns, remove } = mountChain(name, 3);
      try {
        const widths = columns.map((c) => c.style.width);
        if (widths.join() !== '42rem,42rem,42rem') throw new Error(`chain = ${widths.join()}, want 42rem each`);
      } finally {
        remove();
      }
    });
  } finally {
    // Each case used a preference name of its own, so nothing is left behind
    // that another lane could read; the module cache is shared within a lane,
    // so that does have to go.
    window.fetch = realFetch;
    __resetPrefsForTests();
  }

  return { passed, failed, errors };
}
