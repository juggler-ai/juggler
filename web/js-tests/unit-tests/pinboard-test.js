//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Pinboard store + item-type registry unit tests.
 *
 * The board is server-backed session state shared by every viewer, edited with
 * semantic operations that the server merges. The client's whole job is to keep
 * its copy true: sanitize anything off the wire, send well-formed ops, adopt what
 * comes back, and notify only when the board actually differs. `window.fetch` is
 * stubbed (and restored in a finally) per the convention in recent-models-test;
 * websocket pushes are simulated with `wsService._emit`, as in
 * keyless-signin-status-test.
 * @module unit-tests/pinboard-test
 */

import { assert } from '../utilities/test-helpers.js';
import pinboardStore from '../../js/services/pinboard-store.js';
import pinboardView from '../../js/services/pinboard-view.js';
import pinboardItemRegistry from '../../js/registries/pinboard-item-registry.js';
import wsService from '../../js/services/websocket.js';
import PinboardItemType from 'juggler/pinboard-item-type';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * Stub `window.fetch`, recording every call. The handler decides the response.
 * @param {(url: string, opts: any) => any} handler - Response factory.
 * @returns {{calls: {url: string, opts: any}[], restore: () => void}} The
 *   recorded calls and a restore function (call in a finally).
 */
function stubFetch(handler) {
  const orig = window.fetch;
  /** @type {{url: string, opts: any}[]} */
  const calls = [];
  window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ opts) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts);
  });
  return { calls, restore: () => { window.fetch = orig; } };
}

/**
 * Seed the store with exactly `pins` by loading against a stubbed server.
 * @param {any[]} pins - Raw entries the fake GET returns.
 * @returns {Promise<void>}
 */
async function seed(pins) {
  pinboardStore.reset();
  const stub = stubFetch(() => ({ ok: true, json: async () => ({ pins }) }));
  try {
    await pinboardStore.load();
  } finally {
    stub.restore();
  }
}

/**
 * Render a board as its id order, which is what most assertions are about.
 * @param {any[]} pins - The board.
 * @returns {string} Comma-separated pin ids.
 */
const order = (pins) => pins.map((/** @type {any} */ p) => p.id).join(',');

/**
 * The board edits among a stub's calls. `stubFetch` replaces `window.fetch`
 * wholesale, so it records every request the realm makes while it is installed,
 * not only the one under test. That is harmless where a stub lives for a
 * microtask and wrong where one is held open — a viewer reloads its board
 * whenever the session tells it to, and such a reload is not this removal.
 * @param {{calls: {url: string, opts: any}[]}} stub - A stub from `stubFetch`.
 * @returns {{url: string, opts: any}[]} Only the operations POSTs.
 */
const boardWrites = (stub) => stub.calls.filter((c) => c.url.includes('/pinboard/operations'));

/**
 * Every call a stub saw, for an assertion that has to say what else turned up.
 * @param {{calls: {url: string, opts: any}[]}} stub - A stub from `stubFetch`.
 * @returns {string} One line naming each call, or `none`.
 */
const callList = (stub) => stub.calls.map((c) => `${c.opts?.method ?? 'GET'} ${c.url}`).join(', ') || 'none';

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Aggregated results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await run('load() sanitizes malformed pins', async () => {
    // The board is long-lived state written by many versions of many extensions,
    // so nothing off the wire is trusted to have the shape it should.
    await seed([
      { id: 'pin_a', type: 'file', config: { path: 'a.go' }, addedAt: '2026-08-27T12:00:00Z' },
      { id: 'pin_b', type: 'file' },                    // no config ⇒ {}
      { id: 'pin_c', type: 'file', config: 'nope' },    // non-object config ⇒ {}
      { type: 'file' },                                 // no id ⇒ dropped
      { id: 'pin_d' },                                  // no type ⇒ dropped
      { id: '', type: 'file' },                         // empty id ⇒ dropped
      null,                                             // junk ⇒ dropped
    ]);
    const pins = pinboardStore.get();
    assert(order(pins) === 'pin_a,pin_b,pin_c', `expected three sanitized pins, got ${order(pins)}`);
    assert(pins[0].addedAt === '2026-08-27T12:00:00Z', 'addedAt round-trips');
    assert(JSON.stringify(pins[1].config) === '{}', `missing config must become {}, got ${JSON.stringify(pins[1].config)}`);
    assert(JSON.stringify(pins[2].config) === '{}', `non-object config must become {}, got ${JSON.stringify(pins[2].config)}`);
  });

  await run('load() with a non-array payload yields an empty board', async () => {
    await seed(/** @type {any} */ ('not-an-array'));
    assert(pinboardStore.get().length === 0, 'a non-array pins value must sanitize to []');
  });

  await run('add() posts one add op and adopts the returned board', async () => {
    await seed([]);
    const stub = stubFetch(() => ({
      ok: true,
      json: async () => ({ pins: [{ id: 'pin_srv', type: 'file', config: { path: 'a.go' } }] }),
    }));
    let pin;
    try {
      pin = await pinboardStore.add('file', { path: 'a.go' });
    } finally {
      stub.restore();
    }
    assert(stub.calls.length === 1, `expected exactly one request, got ${stub.calls.length}`);
    // The board is named on every request: a project has several, and the docked
    // panel is only the one this document happens to be reading.
    assert(stub.calls[0].url === '/api/session/pinboard/operations?board=main',
      `wrong endpoint: ${stub.calls[0].url}`);
    assert(stub.calls[0].opts?.method === 'POST', 'edits are POSTed');
    const body = JSON.parse(stub.calls[0].opts.body);
    assert(Array.isArray(body.operations) && body.operations.length === 1,
      `expected one operation, got ${stub.calls[0].opts.body}`);
    const op = body.operations[0];
    assert(op.op === 'add' && op.type === 'file' && op.config.path === 'a.go',
      `malformed add op: ${JSON.stringify(op)}`);
    // The id is minted client-side; that is what makes a retried add idempotent
    // on the server rather than a second pin.
    assert(typeof op.id === 'string' && op.id.startsWith('pin_'),
      `add must mint a pin_ id, got ${op.id}`);
    assert(!('index' in op), 'an add with no index must not send one');
    // The server's board wins, not the optimistic guess — there is only one
    // implementation of the merge semantics and it is not this one.
    assert(order(pinboardStore.get()) === 'pin_srv',
      `the response board must be adopted, got ${order(pinboardStore.get())}`);
    assert(pin === null, 'add() returns null when the server board has no pin with that id');
  });

  await run('remove/move/updateConfig send their own op shapes', async () => {
    await seed([{ id: 'pin_a', type: 'file' }, { id: 'pin_b', type: 'file' }]);
    const stub = stubFetch(() => ({ ok: true, json: async () => ({ pins: [] }) }));
    try {
      await pinboardStore.remove('pin_a');
      await pinboardStore.move('pin_b', 0);
      await pinboardStore.updateConfig('pin_b', { path: 'z.go' });
    } finally {
      stub.restore();
    }
    const ops = stub.calls.map((c) => JSON.parse(c.opts.body).operations[0]);
    assert(ops[0].op === 'remove' && ops[0].id === 'pin_a', `bad remove op: ${JSON.stringify(ops[0])}`);
    assert(ops[1].op === 'move' && ops[1].id === 'pin_b' && ops[1].index === 0,
      `bad move op: ${JSON.stringify(ops[1])}`);
    assert(ops[2].op === 'update' && ops[2].config.path === 'z.go',
      `bad update op: ${JSON.stringify(ops[2])}`);
  });

  await run('an empty batch sends nothing', async () => {
    await seed([{ id: 'pin_a', type: 'file' }]);
    const stub = stubFetch(() => ({ ok: true, json: async () => ({ pins: [] }) }));
    try {
      await pinboardStore.applyOperations([]);
    } finally {
      stub.restore();
    }
    assert(stub.calls.length === 0, 'an empty batch must not hit the network');
    assert(order(pinboardStore.get()) === 'pin_a', 'an empty batch must not disturb the board');
  });

  await run('a failed edit rejects and leaves the board alone', async () => {
    // An edit is a user action. Swallowing its failure would leave the user
    // looking at a board that does not exist.
    await seed([{ id: 'pin_a', type: 'file' }]);
    const stub = stubFetch(() => ({ ok: false, status: 400, json: async () => ({ error: 'nope' }) }));
    let threw = false;
    try {
      await pinboardStore.remove('pin_a');
    } catch {
      threw = true;
    } finally {
      stub.restore();
    }
    assert(threw, 'a rejected edit must reject, not resolve silently');
    assert(order(pinboardStore.get()) === 'pin_a', 'a failed edit must not change the local board');
  });

  await run('a pinboard-changed push adopts another viewer\'s board', async () => {
    await seed([{ id: 'pin_a', type: 'file' }]);
    wsService._emit('pinboard-changed', { board: 'main', pins: [
      { id: 'pin_b', type: 'file' },
      { id: 'pin_a', type: 'file' },
      { id: 'junk' },
    ] });
    assert(order(pinboardStore.get()) === 'pin_b,pin_a',
      `a push must be adopted and sanitized, got ${order(pinboardStore.get())}`);
  });

  // A broadcast goes to every viewer of the project, because the server cannot
  // know which board any of them is reading — which board it is about is in the
  // frame, and ignoring the rest is this end's job. Without that, arranging a
  // detached window would rearrange the docked panel.
  await run('a push about another board is not this document\'s board', async () => {
    await seed([{ id: 'pin_a', type: 'file' }]);
    let notifications = 0;
    const unsubscribe = pinboardStore.subscribe(() => { notifications++; });
    try {
      wsService._emit('pinboard-changed', {
        board: 'board_elsewhere',
        pins: [{ id: 'pin_z', type: 'file' }],
      });
      assert(order(pinboardStore.get()) === 'pin_a',
        `another board's push must be ignored, board became ${order(pinboardStore.get())}`);
      assert(notifications === 0, `and must notify nobody, got ${notifications}`);
    } finally {
      unsubscribe();
    }
  });

  await run('subscribers fire on change and not on an identical board', async () => {
    // Every edit is broadcast back to the viewer that made it. Re-notifying on an
    // identical board would rebuild the tabs and lose the user's place.
    await seed([{ id: 'pin_a', type: 'file' }]);
    let notifications = 0;
    const unsubscribe = pinboardStore.subscribe(() => { notifications++; });
    try {
      wsService._emit('pinboard-changed', { board: 'main', pins: [{ id: 'pin_a', type: 'file' }] });
      assert(notifications === 0, 'an identical board must not notify');
      wsService._emit('pinboard-changed', { board: 'main', pins: [{ id: 'pin_a', type: 'file' }, { id: 'pin_b', type: 'file' }] });
      assert(notifications === 1, `a changed board must notify once, got ${notifications}`);
      wsService._emit('pinboard-changed', { board: 'main', pins: [{ id: 'pin_b', type: 'file' }, { id: 'pin_a', type: 'file' }] });
      assert(notifications === 2, `a reorder is a change, got ${notifications} notifications`);
    } finally {
      unsubscribe();
    }
    wsService._emit('pinboard-changed', { board: 'main', pins: [] });
    assert(notifications === 2, 'unsubscribe must stop notifications');
  });

  await run('a throwing subscriber does not stop the others', async () => {
    await seed([]);
    let reached = false;
    const off1 = pinboardStore.subscribe(() => { throw new Error('boom'); });
    const off2 = pinboardStore.subscribe(() => { reached = true; });
    try {
      wsService._emit('pinboard-changed', { board: 'main', pins: [{ id: 'pin_a', type: 'file' }] });
    } finally {
      off1();
      off2();
    }
    assert(reached, 'one broken subscriber must not deny the rest the update');
  });

  await run('registry resolves a source to the first type that accepts it', async () => {
    class RefusingPin extends PinboardItemType {
      static MANIFEST = {
        id: 'test-refusing-pin',
        name: 'Refusing',
        version: '1.0.0',
        description: 'Accepts nothing',
      };
      mount() {}
    }
    class FilePin extends PinboardItemType {
      static MANIFEST = {
        id: 'test-file-pin',
        name: 'File',
        version: '1.0.0',
        description: 'Accepts files',
        instances: 'multiple',
      };
      static canPinSource(source) { return source?.kind === 'file'; }
      static configFromSource(source) { return { path: source.path }; }
      mount() {}
    }
    class ThrowingPin extends PinboardItemType {
      static MANIFEST = {
        id: 'test-throwing-pin',
        name: 'Throwing',
        version: '1.0.0',
        description: 'Explodes when asked',
      };
      static canPinSource() { throw new Error('boom'); }
      mount() {}
    }

    // Start from an empty registry, so this case is asserting about the types it
    // registered and not about whatever a lane happened to leave behind. The
    // shipped `file` pin accepts a file source too, and it is registered before
    // any probe — so without this the winner is decided by which suite ran first
    // in this iframe.
    pinboardItemRegistry.reset();

    // Registration order decides who wins, so put the thrower first: one broken
    // item type must not deny every other type its source.
    const registrations = [
      pinboardItemRegistry.registerClass(/** @type {any} */ (ThrowingPin), { modulePath: '(test)' }),
      pinboardItemRegistry.registerClass(/** @type {any} */ (RefusingPin), { modulePath: '(test)' }),
      pinboardItemRegistry.registerClass(/** @type {any} */ (FilePin), { modulePath: '(test)' }),
    ];
    try {
      for (const reg of registrations) {
        assert(reg.registered, `registerClass refused a probe: ${reg.reason}`);
      }

      const resolved = pinboardItemRegistry.resolveSource({ kind: 'file', path: '/tmp/a.go' });
      if (!resolved) throw new Error('a file source must resolve to the file pin');
      assert(resolved.typeId === 'test-file-pin', `wrong type won: ${resolved.typeId}`);
      assert(resolved.config.path === '/tmp/a.go', `wrong config: ${JSON.stringify(resolved.config)}`);

      assert(pinboardItemRegistry.resolveSource({ kind: 'nothing-pins-this' }) === null,
        'an unpinnable source must resolve to null, not throw');

      // The instance is a renderer shared by every pin of its type, so the
      // registry must hand out the same one rather than build one per lookup.
      const first = pinboardItemRegistry.getType('test-file-pin');
      if (!first) throw new Error('the registered file pin must be gettable by id');
      assert(first === pinboardItemRegistry.getType('test-file-pin'), 'instances must be reused');
      assert(first.allowsMultiple === true, 'instances:multiple must be readable off the instance');
      assert(first.describe({}, /** @type {any} */ ({})).title === 'File',
        'describe() defaults to the manifest name');
      // A pin whose extension is gone is an ordinary state, not an error: the
      // board keeps it and renders a placeholder.
      assert(pinboardItemRegistry.getType('no-such-type') === null,
        'an unknown type id must be null, not a throw');
    } finally {
      pinboardItemRegistry.reset();
    }
  });

  await run('a catch-all type is asked only after every narrower one has declined', async () => {
    // The shipped `file` pin accepts every live file and is registered before any
    // extension's, so first-acceptor-wins by registration order handed it sources
    // that a narrower type was built for — a .cmajorpatch opened as raw text.
    class CatchAllPin extends PinboardItemType {
      static MANIFEST = {
        id: 'test-catch-all-pin',
        name: 'Anything',
        version: '1.0.0',
        description: 'Accepts every file',
        sourceFallback: true,
      };
      static canPinSource(source) { return source?.kind === 'file'; }
      static configFromSource(source) { return { path: source.path, via: 'catch-all' }; }
      mount() {}
    }
    class NarrowPin extends PinboardItemType {
      static MANIFEST = {
        id: 'test-narrow-pin',
        name: 'Narrow',
        version: '1.0.0',
        description: 'Accepts one suffix only',
      };
      static canPinSource(source) { return source?.path?.endsWith('.probe') === true; }
      static configFromSource(source) { return { path: source.path, via: 'narrow' }; }
      mount() {}
    }

    pinboardItemRegistry.reset();
    // The catch-all goes FIRST, which is the arrangement that used to decide it.
    const registrations = [
      pinboardItemRegistry.registerClass(/** @type {any} */ (CatchAllPin), { modulePath: '(test)' }),
      pinboardItemRegistry.registerClass(/** @type {any} */ (NarrowPin), { modulePath: '(test)' }),
    ];
    try {
      for (const reg of registrations) {
        assert(reg.registered, `registerClass refused a probe: ${reg.reason}`);
      }

      const claimed = pinboardItemRegistry.resolveSource({ kind: 'file', path: '/tmp/a.probe' });
      if (!claimed) throw new Error('a .probe source must resolve to something');
      assert(claimed.typeId === 'test-narrow-pin',
        `a type built for this source must beat the catch-all that registered first, got: ${claimed.typeId}`);
      assert(claimed.config.via === 'narrow', 'the winning type must be the one that built the config');

      // And the catch-all still catches what nothing else wants — being asked last
      // is not the same as not being asked.
      const unclaimed = pinboardItemRegistry.resolveSource({ kind: 'file', path: '/tmp/a.go' });
      if (!unclaimed) throw new Error('an unclaimed file source must still resolve');
      assert(unclaimed.typeId === 'test-catch-all-pin',
        `the fallback must take what nothing claims, got: ${unclaimed.typeId}`);
    } finally {
      pinboardItemRegistry.reset();
    }
  });

  /**
   * Register default-pin probes against an empty registry, so these cases assert
   * about the types they registered rather than about the shipped pins a lane may
   * have left behind.
   * @returns {void}
   */
  function registerFurnishProbes() {
    class LatePin extends PinboardItemType {
      static MANIFEST = {
        id: 'test-late-pin',
        name: 'Late',
        version: '1.0.0',
        description: 'A starting tab, second',
        order: 20,
        defaultPin: true,
      };
      mount() {}
    }
    class EarlyPin extends PinboardItemType {
      static MANIFEST = {
        id: 'test-early-pin',
        name: 'Early',
        version: '1.0.0',
        description: 'A starting tab, first',
        order: 10,
        defaultPin: true,
      };
      mount() {}
    }
    class AskedForPin extends PinboardItemType {
      static MANIFEST = {
        id: 'test-asked-for-pin',
        name: 'Asked for',
        version: '1.0.0',
        description: 'Only ever added on purpose',
      };
      mount() {}
    }
    pinboardItemRegistry.reset();
    // Registered out of order on purpose: the tabs must come out in manifest
    // order, not in the order the extension's glob happened to load them.
    for (const Probe of [LatePin, AskedForPin, EarlyPin]) {
      const reg = pinboardItemRegistry.registerClass(/** @type {any} */ (Probe), { modulePath: '(test)' });
      assert(reg.registered, `registerClass refused a probe: ${reg.reason}`);
    }
  }

  await run('a new board is furnished with its starting tabs, in manifest order', async () => {
    await seed([]);
    registerFurnishProbes();
    const stub = stubFetch((url, opts) => {
      if (url.startsWith('/api/session/pinboard/seed')) {
        return { ok: true, json: async () => ({ board: 'main', seed: true }) };
      }
      const ops = JSON.parse(opts.body).operations;
      return {
        ok: true,
        json: async () => ({
          pins: ops.map((/** @type {any} */ op) => ({ id: op.id, type: op.type, config: op.config })),
        }),
      };
    });
    try {
      await pinboardView.furnish();
    } finally {
      stub.restore();
      pinboardItemRegistry.reset();
      pinboardView.reset();
    }

    assert(stub.calls.length === 2, `expected a claim and one batch, got ${stub.calls.length}`);
    assert(stub.calls[0].url === '/api/session/pinboard/seed?board=main',
      `the claim must name its board: ${stub.calls[0].url}`);
    assert(stub.calls[0].opts?.method === 'POST', 'the claim is a POST — asking spends it');
    // One batch, not one request per tab: a board being furnished should appear
    // as a board rather than as tabs arriving one at a time.
    const ops = JSON.parse(stub.calls[1].opts.body).operations;
    assert(ops.map((/** @type {any} */ o) => o.type).join(',') === 'test-early-pin,test-late-pin',
      `wrong starting tabs: ${ops.map((/** @type {any} */ o) => o.type).join(',')}`);
    assert(ops.every((/** @type {any} */ o) => o.op === 'add' && String(o.id).startsWith('pin_')),
      `every starting tab is a client-minted add: ${JSON.stringify(ops)}`);
    assert(pinboardStore.get().length === 2, 'the furnished board must be adopted');
  });

  await run('a board that is nobody else\'s to furnish is left exactly as it was', async () => {
    await seed([{ id: 'pin_a', type: 'file' }]);
    registerFurnishProbes();
    const stub = stubFetch(() => ({ ok: true, json: async () => ({ board: 'main', seed: false }) }));
    try {
      await pinboardView.furnish();
    } finally {
      stub.restore();
      pinboardItemRegistry.reset();
      pinboardView.reset();
    }
    assert(stub.calls.length === 1, `a refused claim must write nothing, got ${stub.calls.length} requests`);
    assert(order(pinboardStore.get()) === 'pin_a',
      `the board must be untouched, got ${order(pinboardStore.get())}`);
  });

  await run('with nothing to furnish a board with, the claim is not spent', async () => {
    await seed([]);
    // The registry fills after the extensions arrive. A claim spent while it was
    // empty would furnish the board with nothing and never be offered again.
    pinboardItemRegistry.reset();
    const stub = stubFetch(() => ({ ok: true, json: async () => ({ board: 'main', seed: true }) }));
    try {
      await pinboardView.furnish();
    } finally {
      stub.restore();
      pinboardView.reset();
    }
    assert(stub.calls.length === 0, `nothing should have been asked, got ${stub.calls.length} requests`);
  });

  await run('a claim that fails leaves the board alone rather than complaining', async () => {
    await seed([{ id: 'pin_a', type: 'file' }]);
    registerFurnishProbes();
    const stub = stubFetch(() => ({ ok: false, status: 500, text: async () => 'nope' }));
    let status = '';
    try {
      await pinboardView.furnish();
      status = pinboardView.getStatus();
    } finally {
      stub.restore();
      pinboardItemRegistry.reset();
      pinboardView.reset();
    }
    assert(stub.calls.length === 1, 'a failed claim must not go on to write pins');
    assert(status === '', `an unfurnished board is an empty board, not a complaint: got "${status}"`);
    assert(order(pinboardStore.get()) === 'pin_a', 'the board must be untouched');
  });

  {
    /**
     * Register one probe whose willRemove behaves as the case asks.
     * @param {(config: any, options: any) => Promise<void>} willRemove - Its release hook.
     * @returns {void}
     */
    const registerReleaseProbe = (willRemove) => {
      class ReleasePin extends PinboardItemType {
        static MANIFEST = {
          id: 'test-release-pin',
          name: 'Release probe',
          version: '1.0.0',
          description: 'A pin that exists only in this test',
        };

        /**
         * @param {any} config - The stored config.
         * @returns {any} The config as this type wants to see it.
         */
        normalizeConfig(config) {
          return { ...config, normalized: true };
        }

        /**
         * @param {any} config - The normalized config.
         * @param {any} options - The active context.
         * @returns {Promise<void>} Resolves when the release is done.
         */
        async willRemove(config, options) {
          await willRemove(config, options);
        }

        mount() {}
      }
      pinboardItemRegistry.reset();
      const reg = pinboardItemRegistry.registerClass(/** @type {any} */ (ReleasePin), { modulePath: '(test)' });
      assert(reg.registered, `registerClass refused the probe: ${reg.reason}`);
    };

    await run('removing a pin offers its type the chance to release what it started', async () => {
      await seed([{ id: 'pin_r', type: 'test-release-pin', config: { port: 3939 } }]);
      /** @type {any[]} */
      const released = [];
      registerReleaseProbe(async (config, options) => { released.push({ config, options }); });
      const stub = stubFetch(() => ({ ok: true, json: async () => ({ pins: [] }) }));
      try {
        await pinboardView.remove('pin_r', /** @type {any} */ ({ conversation: { id: 'conv_1' } }));
      } finally {
        stub.restore();
        pinboardItemRegistry.reset();
        pinboardView.reset();
      }

      assert(released.length === 1, `expected exactly one release, got ${released.length}`);
      // Normalized, like every other config a type is handed: what it stored may
      // be several versions old, and this is not the moment to find that out.
      assert(released[0].config.port === 3939 && released[0].config.normalized === true,
        `the release hook must get the normalized config: ${JSON.stringify(released[0].config)}`);
      assert(released[0].options.active?.conversation?.id === 'conv_1',
        'the release hook must get the active context the panel had');
      assert(boardWrites(stub).length === 1, `the pin must still have been removed (${callList(stub)})`);
    });

    await run('a release that throws does not keep the pin', async () => {
      await seed([{ id: 'pin_r', type: 'test-release-pin', config: {} }]);
      registerReleaseProbe(async () => { throw new Error('probe refused to let go'); });
      const stub = stubFetch(() => ({ ok: true, json: async () => ({ pins: [] }) }));
      try {
        await pinboardView.remove('pin_r');
      } finally {
        stub.restore();
        pinboardItemRegistry.reset();
        pinboardView.reset();
      }
      assert(boardWrites(stub).length === 1,
        `a pin the user asked to be rid of goes whatever its type thinks (${callList(stub)})`);
      assert(pinboardStore.get().length === 0, 'the board must have been adopted from the response');
    });

    await run('a release that never finishes does not hold the removal open', async () => {
      // The real wait is the point: a Remove button an extension can make hang
      // is not a Remove button, so the removal has to go ahead on its own. This
      // case therefore sits out the release deadline once — and that makes it the
      // one place in the suite where `window.fetch` is stubbed for two whole
      // seconds while the realm carries on being a live viewer. A board reload is
      // one broadcast or one periodic poll away at any moment and lands as a GET
      // inside that window, so one is performed deliberately here: whatever else
      // turns up, exactly one board write is the removal.
      await seed([{ id: 'pin_r', type: 'test-release-pin', config: {} }]);
      registerReleaseProbe(() => new Promise(() => {}));
      const stub = stubFetch(() => ({ ok: true, json: async () => ({ pins: [] }) }));
      try {
        const removal = pinboardView.remove('pin_r');
        // Called directly rather than provoked with the `project-changed`
        // broadcast that is one of its real causes: that event is also handled by
        // session.js, which answers it with `window.location.reload()`, and
        // firing it here would take the lane's whole realm down with it.
        await pinboardStore.load();
        await removal;
      } finally {
        stub.restore();
        pinboardItemRegistry.reset();
        pinboardView.reset();
      }
      assert(
        stub.calls.length > boardWrites(stub).length,
        `the reload must land inside the release window or this case proves nothing: ${callList(stub)}`
      );
      // Board writes, not raw fetches. The count still reports, and names every
      // call, because zero would mean the release deadline never fired at all.
      assert(
        boardWrites(stub).length === 1,
        `the removal must go ahead without the type that would not finish; the board was written `
        + `${boardWrites(stub).length} times (calls during the release window: ${callList(stub)})`
      );
      assert(
        pinboardStore.get().length === 0,
        `and the board must be the one the server sent back; it holds ${pinboardStore.get().length} pins`
      );
    });
  }

  await run('PinboardItemType cannot be instantiated directly', async () => {
    let threw = false;
    try {
      new /** @type {any} */ (PinboardItemType)();
    } catch {
      threw = true;
    }
    assert(threw, 'the abstract base class must refuse construction');
  });

  pinboardStore.reset();
  return { passed, failed, errors };
}
