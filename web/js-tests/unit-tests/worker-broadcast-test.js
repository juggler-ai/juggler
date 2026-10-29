//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What a client does with the messages the worker sends to all of them.
 *
 * `render-context-items-request` and `request-tools` are BROADCAST: they reach
 * every client registered on the conversation, viewers included, and only the
 * engine may answer. A viewer that answers too turns the turn's system prompt
 * into a race between two realms — and the viewer renders from its own replica,
 * which can be behind — while the losing reply reaches a worker that has already
 * taken the other one and is logged as "[roundtrip] … answered a request nothing
 * was waiting for", the line that otherwise means a 30s ContextTimeout was
 * missed.
 *
 * `status` is the other half of the same story: it carries nothing itself, and
 * every client's answer to "is this conversation busy" is read from the doc
 * metadata that the transition it announces has just written — so the inbound
 * batch has to be applied as it lands, or the bin guard, the attention edges and
 * the spinner all answer from one sync window ago.
 * @module unit-tests/worker-broadcast-test
 */

import {
  handleRenderContextItemsRequest,
  handleRequestTools,
  sendRenderContextItemsResponse,
  sendToolsResult,
} from '../../js/services/worker-manager-protocols.js';
import { WorkerManager } from '../../js/services/worker-manager.js';
import { buildToolInventory } from '../../js/services/thread-tool-inventory.js';
import contextItemRegistry from '../../js/registries/context-item-registry.js';
import strategyRegistry from '../../js/registries/strategy-registry.js';
import {
  __holdNextRegistryRebuildForTests,
  anyLocalConversationBusy,
  QUIESCENCE_TIMEOUT_MS,
  reloadRegistries,
  __whenRegistriesSettledForTests,
} from '../../js/registries/reload-registries.js';
import { assert, waitFor } from '../utilities/test-helpers.js';
import { racePatiently } from '../utilities/test-patience.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Build a stand-in WorkerManager that answers both requests and records what it
 * would send to the worker. No `_session`, so the handlers' load preamble
 * resolves to nothing and the callback runs directly.
 * @returns {any} Fake manager
 */
function fakeWorkerManager() {
  /** @type {any[]} */
  const sent = [];
  /** @type {string[]} */
  const asked = [];
  const wm = /** @type {any} */ ({
    sent,
    asked,
    _roundTripStamps: new Map(),
    sendToWorker(/** @type {string} */ _conversationId, /** @type {any} */ message) {
      sent.push(message);
    },
  });
  wm._onContextRequest = (/** @type {any} */ req) => {
    asked.push('context');
    sendRenderContextItemsResponse(wm, 'conv-1', req.requestId, [], 'prompt');
  };
  wm._onToolsRequest = (/** @type {any} */ req) => {
    asked.push('tools');
    sendToolsResult(wm, 'conv-1', req.requestId, []);
  };
  return wm;
}

/**
 * Run fn with the realm set to engine or viewer, restoring the flag after.
 * @param {boolean} engine - True to run as the engine
 * @param {() => Promise<void>|void} fn - Body to run
 * @returns {Promise<void>} Resolves once fn has run and the flag is restored
 */
async function asRealm(engine, fn) {
  const g = /** @type {any} */ (globalThis);
  const had = Object.prototype.hasOwnProperty.call(g, 'JUGGLER_ENGINE');
  const previous = g.JUGGLER_ENGINE;
  if (engine) g.JUGGLER_ENGINE = true;
  else delete g.JUGGLER_ENGINE;
  try {
    await fn();
  } finally {
    if (had) g.JUGGLER_ENGINE = previous;
    else delete g.JUGGLER_ENGINE;
  }
}

/**
 * Run viewer request-guard tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Case name
   * @param {() => Promise<void>|void} fn - Case body
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

  await test('a viewer ignores a broadcast render-context-items-request', async () => {
    const wm = fakeWorkerManager();
    await asRealm(false, async () => {
      await handleRenderContextItemsRequest(wm, 'conv-1', { requestId: 'req-1', sentAt: Date.now() });
    });
    assert(wm.asked.length === 0, `a viewer must not render context, ran: ${wm.asked.join(',')}`);
    assert(wm.sent.length === 0, `a viewer must not answer, sent: ${JSON.stringify(wm.sent)}`);
  });

  await test('the engine answers a render-context-items-request', async () => {
    const wm = fakeWorkerManager();
    await asRealm(true, async () => {
      await handleRenderContextItemsRequest(wm, 'conv-1', { requestId: 'req-2', sentAt: Date.now() });
    });
    assert(wm.sent.length === 1, `expected one reply, got ${wm.sent.length}`);
    assert(
      wm.sent[0].type === 'render-context-items-response' && wm.sent[0].requestId === 'req-2',
      `expected the engine's answer to req-2, got ${JSON.stringify(wm.sent[0])}`
    );
  });

  await test('a viewer ignores a broadcast request-tools', async () => {
    const wm = fakeWorkerManager();
    await asRealm(false, async () => {
      await handleRequestTools(wm, 'conv-1', { requestId: 'req-3', sentAt: Date.now() });
    });
    assert(wm.asked.length === 0, `a viewer must not build a tool list, ran: ${wm.asked.join(',')}`);
    assert(wm.sent.length === 0, `a viewer must not answer, sent: ${JSON.stringify(wm.sent)}`);
  });

  await test('the engine answers a request-tools', async () => {
    const wm = fakeWorkerManager();
    await asRealm(true, async () => {
      await handleRequestTools(wm, 'conv-1', { requestId: 'req-4', sentAt: Date.now() });
    });
    assert(wm.sent.length === 1, `expected one reply, got ${wm.sent.length}`);
    assert(
      wm.sent[0].type === 'tools-result' && wm.sent[0].requestId === 'req-4',
      `expected the engine's answer to req-4, got ${JSON.stringify(wm.sent[0])}`
    );
  });

  // The tool list is worked out from the conversation's own threads and
  // strategy. Asked mid-load, the engine holds only the stub the loader adopted
  // first — an empty document whose root resolves to the default strategy — so
  // a turn whose request beat the load was offered the default strategy's
  // tools, whatever the conversation's strategy was: a read-only thread was
  // offered writes.
  await test('the engine builds a tool list only once the conversation has loaded', async () => {
    const wm = fakeWorkerManager();
    /** @type {() => void} */
    let finishLoad = () => {};
    const loading = new Promise((resolve) => { finishLoad = () => resolve(undefined); });
    const conversation = { loadState: 'loading', flushPendingSyncs: () => {} };
    wm._session = { conversations: new Map([['conv-1', conversation]]) };
    wm.loader = { pendingAutoLoad: (/** @type {string} */ id) => (id === 'conv-1' ? loading : null) };
    /** @type {string[]} */
    const seenLoadStates = [];
    wm._onToolsRequest = (/** @type {any} */ req) => {
      seenLoadStates.push(conversation.loadState);
      sendToolsResult(wm, 'conv-1', req.requestId, []);
    };
    await asRealm(true, async () => {
      const handled = handleRequestTools(wm, 'conv-1', { requestId: 'req-7', sentAt: Date.now() });
      await Promise.resolve();
      assert(seenLoadStates.length === 0, 'the tool list was built while the conversation was still loading');
      conversation.loadState = 'loaded';
      finishLoad();
      await handled;
    });
    assert(
      seenLoadStates.length === 1 && seenLoadStates[0] === 'loaded',
      `expected one tool list, built after the load, got ${JSON.stringify(seenLoadStates)}`
    );
    assert(wm.sent.length === 1 && wm.sent[0].requestId === 'req-7', `expected one reply to req-7, got ${JSON.stringify(wm.sent)}`);
  });

  /**
   * Hold a registry rebuild open between its reset and its re-init, run
   * `during` inside that window, then let the rebuild finish.
   * @param {(release: () => void) => Promise<void>} during - Body; calls `release` to let the rebuild go on
   * @returns {Promise<void>} Resolves once the rebuild has finished
   */
  async function insideRegistryRebuild(during) {
    await __whenRegistriesSettledForTests();
    /** @type {() => void} */
    let release = () => {};
    __holdNextRegistryRebuildForTests(new Promise((resolve) => { release = () => resolve(undefined); }));
    const reloading = reloadRegistries();
    try {
      await waitFor(() => !contextItemRegistry.isInitialized(), 'the rebuild to reset the registries', 5000);
      await during(release);
    } finally {
      release();
      await reloading;
    }
  }

  /** @returns {boolean} Whether the registries a turn's tools and prompt come from are populated */
  const registriesPopulated = () => strategyRegistry.isInitialized() && contextItemRegistry.isInitialized();

  /**
   * Put a conversation running a turn in the engine's session for the length of
   * `body`. The turn is a stand-in whose document announces a change only when
   * told to (`announce`), as a real one does on each transaction.
   * @param {(turn: {processingState: {status: string}, announce: () => void}) => Promise<void>} body
   * @returns {Promise<void>}
   */
  async function withEngineTurn(body) {
    const g = /** @type {any} */ (globalThis);
    const hadEngineApp = Object.prototype.hasOwnProperty.call(g, 'engineApp');
    const previousEngineApp = g.engineApp;
    /** @type {Set<() => void>} */
    const listeners = new Set();
    const turn = {
      processingState: { status: 'streaming' },
      isAwaitingApproval: () => false,
      onDocumentChange: (/** @type {() => void} */ fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      announce: () => { for (const fn of [...listeners]) fn(); },
    };
    const session = {
      conversations: new Map([['conv-1', turn]]),
      events: { subscribe: () => () => {} },
    };
    g.engineApp = { getSession: () => session };
    try {
      await body(turn);
    } finally {
      turn.processingState.status = 'idle';
      turn.announce();
      if (hadEngineApp) g.engineApp = previousEngineApp;
      else delete g.engineApp;
    }
  }


  await test('a tool list requested mid-rebuild is built from the rebuilt registries', async () => {
    await __whenRegistriesSettledForTests();
    const names = (/** @type {Array<Record<string, any>>} */ tools) => tools.map((t) => t.name).sort().join(',');
    const expected = names((await buildToolInventory(null)).offered);
    const wm = fakeWorkerManager();
    /** @type {Array<{populated: boolean, tools: string}>} */
    const built = [];
    /** @type {() => void} */
    let replied = () => {};
    const reply = new Promise((resolve) => { replied = () => resolve(undefined); });
    // Like the real callback, this is async and the handler does not await it.
    wm._onToolsRequest = async (/** @type {any} */ req) => {
      const populated = registriesPopulated();
      const { offered } = await buildToolInventory(null);
      built.push({ populated, tools: names(offered) });
      sendToolsResult(wm, 'conv-1', req.requestId, offered);
      replied();
    };
    await insideRegistryRebuild(async (release) => {
      await asRealm(true, async () => {
        const handled = handleRequestTools(wm, 'conv-1', { requestId: 'req-8', sentAt: Date.now() });
        await new Promise((resolve) => setTimeout(resolve, 0));
        release();
        await handled;
      });
    });
    await racePatiently(reply, 5000, { what: 'the tool list requested mid-rebuild to be sent' });
    assert(built.length === 1, `expected one tool list, got ${built.length}`);
    assert(built[0].populated, 'the tool list was built from registries the rebuild had reset');
    assert(built[0].tools === expected, `expected the full tool list\n  ${expected}\ngot\n  ${built[0].tools}`);
  });

  await test('a context render requested mid-rebuild runs against the rebuilt registries', async () => {
    const wm = fakeWorkerManager();
    /** @type {boolean[]} */
    const populatedAtRender = [];
    wm._onContextRequest = (/** @type {any} */ req) => {
      populatedAtRender.push(registriesPopulated());
      sendRenderContextItemsResponse(wm, 'conv-1', req.requestId, [], 'prompt');
    };
    await insideRegistryRebuild(async (release) => {
      await asRealm(true, async () => {
        const handled = handleRenderContextItemsRequest(wm, 'conv-1', { requestId: 'req-9', sentAt: Date.now() });
        await new Promise((resolve) => setTimeout(resolve, 0));
        release();
        await handled;
      });
    });
    assert(
      populatedAtRender.length === 1 && populatedAtRender[0],
      `expected one render, against populated registries, got ${JSON.stringify(populatedAtRender)}`
    );
  });

  // The requesting turn is itself what a reload waits on before it resets
  // anything, so a request that waited for the whole reload would wait on itself.
  await test('a tool list is served at once while a reload waits for the running turn', async () => {
    await __whenRegistriesSettledForTests();
    /** @type {Promise<void>} */
    let reloading = Promise.resolve();
    await withEngineTurn(async () => {
      reloading = reloadRegistries();
      const wm = fakeWorkerManager();
      await asRealm(true, async () => {
        const handled = handleRequestTools(wm, 'conv-1', { requestId: 'req-10', sentAt: Date.now() });
        await racePatiently(handled, 2000, { what: 'the tool list to be served while the reload waits' });
      });
      assert(
        wm.sent.length === 1 && wm.sent[0].requestId === 'req-10',
        `the tool list must not wait for a reload that is waiting for this turn, sent ${JSON.stringify(wm.sent)}`
      );
      assert(registriesPopulated(), 'a reload waiting for quiescence must leave the registries intact');
    });
    await reloading;
  });

  // The reload hears the turn end from the document, the moment it does, and is
  // not woken by a clock in between: a status that changes without the document
  // saying so is not seen until it does.
  //
  // "No clock" is checked by listing the clocks rather than by waiting to see
  // whether one fires, which a slow core passes vacuously. The wait arms its
  // timers as it starts, synchronously inside `reloadRegistries()`, where no
  // sibling lane can run and arm one of its own.
  await test('a reload waiting for a turn goes ahead when the document says it ended', async () => {
    await __whenRegistriesSettledForTests();
    await withEngineTurn(async (turn) => {
      assert(registriesPopulated() && anyLocalConversationBusy(),
        `precondition: strategies=${strategyRegistry.isInitialized()} items=${contextItemRegistry.isInitialized()} busy=${anyLocalConversationBusy()}`);
      /** @type {() => void} */
      let release = () => {};
      __holdNextRegistryRebuildForTests(new Promise((resolve) => { release = () => resolve(undefined); }));
      const g = /** @type {any} */ (globalThis);
      const { setTimeout: realTimeout, setInterval: realInterval } = g;
      /** @type {string[]} */
      const armed = [];
      g.setTimeout = (/** @type {any[]} */ ...args) => { armed.push(`setTimeout ${args[1]}`); return realTimeout(...args); };
      g.setInterval = (/** @type {any[]} */ ...args) => { armed.push(`setInterval ${args[1]}`); return realInterval(...args); };
      /** @type {Promise<void>} */
      let reloading;
      try {
        reloading = reloadRegistries();
      } finally {
        g.setTimeout = realTimeout;
        g.setInterval = realInterval;
      }
      try {
        assert(armed.length === 1 && armed[0] === `setTimeout ${QUIESCENCE_TIMEOUT_MS}`,
          `the only clock a waiting reload arms is its give-up, got ${JSON.stringify(armed)}`);
        turn.processingState.status = 'idle';
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert(registriesPopulated(), `the reload went ahead before anything announced the turn had ended (strategies=${strategyRegistry.isInitialized()} items=${contextItemRegistry.isInitialized()} busy=${anyLocalConversationBusy()})`);
        turn.announce();
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert(!contextItemRegistry.isInitialized(), 'the reload did not go ahead once the turn was announced idle');
      } finally {
        release();
        await reloading;
      }
    });
  });

  await test('a viewer leaves no round-trip stamp behind for a request it ignored', async () => {
    const wm = fakeWorkerManager();
    // Callbacks that record but never reply: a stamp taken before the role is
    // checked has nothing to release it, so it would still be held here.
    wm._onContextRequest = () => wm.asked.push('context');
    wm._onToolsRequest = () => wm.asked.push('tools');
    await asRealm(false, async () => {
      await handleRenderContextItemsRequest(wm, 'conv-1', { requestId: 'req-5', sentAt: Date.now() });
      await handleRequestTools(wm, 'conv-1', { requestId: 'req-6', sentAt: Date.now() });
    });
    assert(
      wm._roundTripStamps.size === 0,
      `an ignored request must not be stamped, held: ${[...wm._roundTripStamps.keys()].join(',')}`
    );
  });

  await test('a status message applies the sync batch it was announced with', async () => {
    let flushes = 0;
    const manager = new WorkerManager();
    /** @type {any} */ (manager)._session = {
      conversations: new Map([['conv-1', { flushPendingSyncs: () => { flushes++; } }]])
    };

    /** @type {any} */ (manager)._handleWorkerMessage('conv-1', { type: 'status', status: 'streaming' });

    assert(flushes === 1, `a status transition must apply what has arrived, flushed ${flushes} times`);
  });

  return { passed, failed, errors };
}
