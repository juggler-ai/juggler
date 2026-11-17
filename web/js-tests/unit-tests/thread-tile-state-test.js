//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What a thread tile claims about itself, against what its state actually is.
 *
 * Two claims, both read without being read consciously. The icon pulse is the
 * only moving pixel on a resting tile, so it is taken as "this is working"
 * whatever the text beside it says. The Stop is the only affordance a parent
 * column has while a run is open — no Continue, nothing processing to stop,
 * Escape with nothing to cancel — so a tile that withholds it is a conversation
 * with no way forward but a root Escape.
 *
 * Driven through the real component and the real classifier, because both bugs
 * this pins lived in the gap between them: `getThreadStatus` said `errored`, and
 * the tile pulsed anyway and offered no way out.
 * @module unit-tests/thread-tile-state-test
 */

import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { getThreadStatus, paintThreadSummary } from '../../js/utils/thread-display.js';
import '../../js/components/thread-message.js';
import contextItemRegistry from '../../js/registries/context-item-registry.js';

/**
 * @param {unknown} e
 * @returns {string} the message to surface for an assertion failure
 */
function msg(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} the aggregate test result
 */
export async function runTests() {
  const Y = await import('../../js/vendor/yjs.mjs');
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {Record<string, any>} fields - Item fields.
   * @returns {any} a Y.Map shaped like a conversation item
   */
  const item = (fields) => {
    const m = new Y.Map();
    for (const [k, v] of Object.entries(fields)) m.set(k, v);
    return m;
  };

  /**
   * Build one thread item, live in a document, with the given fields and nested
   * items — the shape the tile reads.
   * @param {Record<string, any>} fields - Fields on the thread itself.
   * @param {Array<Record<string, any>>} [nested] - Items inside the thread.
   * @returns {any} The thread Y.Map.
   */
  const thread = (fields, nested = []) => {
    const doc = new Y.Doc();
    const root = doc.getArray('items');
    const t = new Y.Map();
    doc.transact(() => {
      root.insert(0, [t]);
      t.set('type', 'thread');
      t.set('itemId', 'T1');
      t.set('goal', 'Read the config');
      const items = new Y.Array();
      t.set('items', items);
      for (const [k, v] of Object.entries(fields)) t.set(k, v);
      for (const n of nested) items.push([item(n)]);
    });
    return t;
  };

  /** The fields that mark a thread as standing for one call, with that call's run still open. */
  const openRunFields = {
    runToolUseId: 'tu-1', runToolName: 'create_thread', runToolInput: { goal: 'Read the config' },
  };
  /** The invocation item that open run was started by. */
  const openRunItem = {
    type: 'user', itemId: 'inv-0', content: 'read it', runToolUseId: 'tu-1', runStatus: '', runResult: '',
  };

  // One fixture per state the tile can be in, each paired with the two claims it
  // should make: whether it has work outstanding (the pulse), and whether there
  // is something for a Stop to act on.
  const states = [
    {
      name: 'running', kind: 'running', pulses: true, stop: true,
      thread: () => thread({}),
      live: { byThread: { T1: 'Streaming • 250 tokens' } },
    },
    {
      name: 'pending', kind: 'pending', pulses: true, stop: true,
      thread: () => thread({ needsStrategyRun: true }),
      live: null,
    },
    {
      name: 'paused', kind: 'paused', pulses: true, stop: true,
      thread: () => thread({}, [{ type: 'tool-action', itemId: 'ta-1', toolName: 'bash', state: 'pending' }]),
      live: null,
    },
    {
      // Nothing of this thread's own is moving, but a sibling's is and the
      // worker admits threads as capacity allows: its turn is coming.
      name: 'queued', kind: 'queued', pulses: true, stop: false,
      thread: () => thread({}),
      live: { byThread: { T2: 'Streaming • 250 tokens' } },
    },
    {
      // The incident: a delegated child stopped by a usage cap. Its run never
      // settled, so the caller that made the call is parked on it and nothing is
      // coming to free it — this tile is the only place that can.
      name: 'errored, run still open', kind: 'errored', pulses: false, stop: true,
      thread: () => thread(openRunFields, [openRunItem,
        { type: 'error', itemId: 'e-1', content: 'usage limit reached' }]),
      live: null,
    },
    {
      // The same label with nobody waiting behind it. A Stop here would act on
      // nothing, so offering one is a claim that there is a way out of a state
      // that needs no way out.
      name: 'errored, no run open', kind: 'errored', pulses: false, stop: false,
      thread: () => thread({}, [{ type: 'error', itemId: 'e-1', content: 'usage limit reached' }]),
      live: null,
    },
    {
      name: 'unfinished', kind: 'unfinished', pulses: false, stop: true,
      thread: () => thread(openRunFields, [openRunItem]),
      live: null,
    },
    {
      name: 'idle', kind: 'idle', pulses: false, stop: false,
      thread: () => thread({}),
      live: null,
    },
  ];

  // --- 1: the pulse marks work outstanding, and the Stop marks a way out ---
  for (const state of states) {
    try {
      const t = state.thread();
      const classified = getThreadStatus(t, state.live);
      assert(classified.kind === state.kind,
        `fixture '${state.name}' classified as '${classified.kind}' — the fixture, not the tile, is wrong`);

      const tile = /** @type {any} */ (document.createElement('thread-message'));
      document.body.appendChild(tile);
      try {
        tile.updateFromItem(t, state.live);
        const busy = tile.querySelector('article')?.getAttribute('data-processing') === 'true';
        assert(busy === state.pulses, state.pulses
          ? `a '${state.name}' thread has work outstanding, so its icon must pulse`
          : `a '${state.name}' thread is not working — the pulse would be the only moving pixel in the state, `
            + `saying the opposite of the label beside it ("${classified.message}")`);

        const stop = !!tile.querySelector('.thread-stop-btn');
        assert(stop === state.stop, state.stop
          ? `a '${state.name}' thread has something to stop or an open run to settle, and this tile is where the `
            + 'user gets at it — a parent column parked on an open run has no other affordance'
          : `a '${state.name}' thread has neither work in flight nor an open run, so a Stop would act on nothing`);
      } finally {
        tile.remove();
      }
      passed++;
    } catch (e) { failed++; errors.push(`${state.name}: ${msg(e)}`); }
  }

  // --- 2: the Stop on a thread nothing is driving says what it does ---
  // It settles the run; it stops no work, because there is none. "Stop this
  // thread" would describe an action the click does not perform.
  try {
    const t = thread(openRunFields, [openRunItem, { type: 'error', itemId: 'e-1', content: 'usage limit reached' }]);
    const tile = /** @type {any} */ (document.createElement('thread-message'));
    document.body.appendChild(tile);
    try {
      tile.updateFromItem(t, null);
      const label = tile.querySelector('.thread-stop-btn')?.getAttribute('aria-label') || '';
      assert(label === 'Stop waiting for this thread',
        `a Stop that only settles an open run must say so; got "${label}"`);
    } finally {
      tile.remove();
    }
    passed++;
  } catch (e) { failed++; errors.push(`stop label: ${msg(e)}`); }

  // --- 3: a tile at rest showing its summary claims nothing ---
  try {
    const t = thread({ result: 'The config lives in config.go.' });
    const tile = /** @type {any} */ (document.createElement('thread-message'));
    document.body.appendChild(tile);
    try {
      tile.updateFromItem(t, null);
      assert(getThreadStatus(t, null).showSummary === true, 'a thread at rest with a result shows its summary');
      assert(tile.querySelector('article')?.getAttribute('data-processing') !== 'true',
        'a tile showing the answer it came back with is finished');
      assert(!tile.querySelector('.thread-stop-btn'),
        'and there is nothing left to stop');
    } finally {
      tile.remove();
    }
    passed++;
  } catch (e) { failed++; errors.push(`summary tile: ${msg(e)}`); }

  // --- 4: the mark tracks a state change that adds or removes no spinner ---
  // queued → idle is the transition with nothing else to notice it by: neither
  // state has a spinner and neither offers a Stop, so a tile that keys its
  // structure on those alone keeps the mark it was built with.
  try {
    const t = thread({});
    const tile = /** @type {any} */ (document.createElement('thread-message'));
    document.body.appendChild(tile);
    try {
      /** @returns {boolean} whether the tile face is marked as work outstanding. */
      const busy = () => tile.querySelector('article')?.getAttribute('data-processing') === 'true';

      tile.updateFromItem(t, { byThread: { T2: 'Streaming • 250 tokens' } });
      assert(busy(), 'a thread waiting its turn is work outstanding');
      tile.setLiveStatus(null);
      assert(!busy(), 'once nothing is running at all, the thread is at rest and the mark clears');
      tile.setLiveStatus({ byThread: { T2: 'Streaming • 250 tokens' } });
      assert(busy(), 'and it comes back when the conversation does');
    } finally {
      tile.remove();
    }
    passed++;
  } catch (e) { failed++; errors.push(`mark tracks both ways: ${msg(e)}`); }

  // --- 5: a running tile's spinner reads the run as the thread's footer does ---
  // The tile's spinner stands for the same run as the sub-thread's own footer
  // spinner, so it must juggle the same clubs, at the same speed, on the same
  // fire. Nothing on screen says when it doesn't — it just rests at the plain
  // cascade — so this is the only thing that notices.
  try {
    const now = Date.now();
    /**
     * @param {any} t - The thread Y.Map.
     * @param {number} throughput - Tokens/sec the conversation's llmState reports for T1.
     * @returns {any} the running tile, inside a column whose conversation reports `throughput`.
     */
    const runningTile = (t, throughput) => {
      const column = document.createElement('conversation-area');
      Object.defineProperty(column, 'conversation', {
        value: {
          id: 'c1',
          llmState: {
            getThroughput: (/** @type {string} */ _c, /** @type {string} */ id) => (id === 'T1' ? throughput : 0),
            getLiveInputUsage: () => null,
          },
          resolveMessageThread: () => ({ getEffectiveModelConfig: () => null }),
        },
      });
      const tile = /** @type {any} */ (document.createElement('thread-message'));
      column.appendChild(tile);
      tile.updateFromItem(t, { byThread: { T1: 'Running tools' } });
      return tile;
    };
    const tool = (/** @type {string} */ id) => ({
      type: 'tool-action', itemId: id, toolName: 'bash', state: 'running', runningStartedAt: now,
    });

    const fanOut = runningTile(thread({}, [tool('ta-1'), tool('ta-2'), tool('ta-3'), tool('ta-4'), tool('ta-5')]), 0);
    const parked = fanOut.querySelector('juggler-spinner.thread-status-spinner');
    assert(parked?.hasAttribute('live'), 'a running tile\'s spinner must be live to report the run at all');
    assert(parked.clubs === 5, `five tool calls running in the thread juggle five clubs, got ${parked.clubs}`);

    const streaming = runningTile(thread({ contextTokens: 400000 }), 120);
    const fast = streaming.querySelector('juggler-spinner.thread-status-spinner');
    assert(fast.rate === 2, `output arriving at 120 tok/s runs the cascade at full speed, got ${fast.rate}`);
    assert(!!fast.style.getPropertyValue('--spinner-fire-intensity'),
      'a thread whose transcript is past the fire threshold burns on its tile as in its column');
    passed++;
  } catch (e) { failed++; errors.push(`live spinner: ${msg(e)}`); }

  // --- 6: under en-XA, every state the tile draws is translated ---
  // The goal, the summary and a running thread's live line are data (the call's
  // goal, the child's answer, the footer's own wording), so those elements are
  // skipped; everything else — status lines, Stop's text, title and aria-label,
  // the cost pair — must be pseudo-localised. Collected across every state and
  // asserted once, so a failure lists all of it.
  // The lozenge depends on whether the lane's registry has loaded juggler-core:
  // with it, the name is the thread capability's `getTypeName()`, translated
  // in @juggler/core's catalogue; without it, core's own `Thread`. The test
  // fixes the first so it does not hang on which suites ran in this lane
  // before it, and hands that word to the stand-in @juggler/core catalogue (a
  // scoped lookup never searches the test's own namespace).
  const registryOriginal = { get: contextItemRegistry.get, getExtensionId: contextItemRegistry.getExtensionId };
  const threadCapability = class { static getTypeName() { return 'Thread'; } static MANIFEST = { id: 'thread', name: 'Create Thread' }; };
  contextItemRegistry.get = /** @type {any} */ ((/** @type {string} */ id) => (id === 'thread' ? threadCapability : registryOriginal.get.call(contextItemRegistry, id)));
  contextItemRegistry.getExtensionId = (id) => (id === 'thread' ? '@juggler/core' : registryOriginal.getExtensionId.call(contextItemRegistry, id));
  try {
    /** @type {string[]} */
    const raw = [];
    let checked = 0;
    await underPseudoLocale('test-thread-tile', () => {
      /**
       * @param {Element} root
       * @param {string} where
       * @param {string} skip
       */
      const collect = (root, where, skip) => {
        const shown = shownStrings(root, skip);
        checked += shown.length;
        for (const s of shown) if (!isPseudoLocalized(s)) raw.push(`${where}: ${s}`);
      };
      /**
       * @param {any} t
       * @param {any} live
       * @param {string} where
       * @param {string} skip
       */
      const drawTile = (t, live, where, skip) => {
        const tile = /** @type {any} */ (document.createElement('thread-message'));
        document.body.appendChild(tile);
        try {
          tile.updateFromItem(t, live);
          collect(tile, where, skip);
        } finally {
          tile.remove();
        }
      };
      for (const state of states) {
        const t = state.thread();
        t.set('goal', '1');
        drawTile(t, state.live, state.name,
          state.kind === 'running' ? '.thread-goal, .thread-status-message > span' : '.thread-goal');
      }
      // At rest with a summary and the cost pair it closes on.
      drawTile(thread({ goal: '1', result: '2', contextTokens: 3, resultTokens: 4 }), null, 'summary',
        '.thread-goal, .thread-summary');
      // A settled run with no result: "Idle" from the run record.
      drawTile(thread({ ...openRunFields, goal: '1' }, [{ ...openRunItem, runStatus: 'completed' }]), null,
        'settled, no result', '.thread-goal');
      // The panel's body painted with no status at all.
      const bare = document.createElement('div');
      paintThreadSummary(bare, '');
      collect(bare, 'not summarised', '');
    }, { '@juggler/core': ['Thread'] });
    assert(checked >= 20, `expected the walk to see at least 20 strings, saw ${checked}`);
    assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    passed++;
  } catch (e) { failed++; errors.push(`en-XA: ${msg(e)}`); } finally {
    Object.assign(contextItemRegistry, registryOriginal);
  }

  return { passed, failed, errors };
}
