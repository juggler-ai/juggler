//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What the board can honestly say the project's conversations are running.
 *
 * `services.tasks` is the server's process inventory — fetched once when the
 * first pin watches, then replaced whole by every `processes-changed` frame —
 * with what the transcript knows laid over it for labels. The server decides
 * what is listed; the transcript never does. The case that pins it is "a stale
 * snapshot does not resurrect a task the server does not list", because the
 * durable snapshot beside a tool action freezes at whatever it last said.
 *
 * Against real conversation and thread models with real Yjs items, because the
 * shape the labels are read from — a tool action whose result also holds the
 * command's accumulated output — is exactly what a hand-built fake would get
 * wrong in its own favour.
 *
 * Driven through a probe item type registered only here, the same way
 * `unit:pinboard-shell` does.
 * @module unit-tests/pinboard-tasks-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  assert,
  waitFor
} from '../utilities/test-helpers.js';
import { createUserMessage, createAssistantMessage } from '../../sdk/lib/message.js';
import pinboardItemRegistry from '../../js/registries/pinboard-item-registry.js';
import wsService, { WebSocketService } from '../../js/services/websocket.js';
import PinboardItemType from 'juggler/pinboard-item-type';
import { resolveToolTarget } from '../../js/components/pinboard-content.js';

/** The context the probe was mounted with. */
const probe = { context: /** @type {any} */ (null) };

/** A pin type whose whole purpose is to hand back the context it was given. */
class TaskProbePin extends PinboardItemType {
  static MANIFEST = {
    id: 'task-probe',
    name: 'Task probe',
    version: '1.0.0',
    description: 'A pin that exists only in this test',
    instances: 'multiple',
  };

  /**
   * @param {HTMLElement} container - The body region to fill.
   * @param {any} pinContext - The pin, the active snapshot and the host services.
   * @returns {{teardown: () => void}} The controller.
   */
  mount(container, pinContext) {
    probe.context = pinContext;
    container.textContent = 'task probe';
    return { teardown: () => {} };
  }
}

/** The project this fixture pretends to be in. */
const PROJECT = '/tmp/pinboard-tasks';

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  await initializeRegistries();

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

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1200px;height:800px;';
  document.body.appendChild(container);

  // A lane reuses one JS realm across suites, so start from a known registry and
  // hand back one with no probe types in it.
  pinboardItemRegistry.reset();
  pinboardItemRegistry.registerClass(TaskProbePin, { extensionId: 'test' });
  probe.context = null;

  // --- the fake server ------------------------------------------------------

  /**
   * What the inventory holds, as the server would list it.
   * @type {any[]}
   */
  let inventory = [];
  /** How many listings were asked for. */
  let listings = 0;
  /** Every stopProcess request seen. */
  const stops = [];
  /** When set, the next listing fails with this. */
  let opFailure = '';
  /** When set, the listing waits for this before answering. */
  /** @type {Promise<void>|null} */
  let listingGate = null;

  const originalFetch = window.fetch;
  /**
   * Answer the two ops this service uses, and — the part that matters — hand
   * every other URL to the real fetch. A stub that answers everything swallows
   * the harness's own result POST, and the suite then hangs for a minute looking
   * exactly like a dead pool.
   * @param {any} input - The request URL or Request.
   * @param {any} [init] - The request options.
   * @returns {Promise<any>} The response.
   */
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!url.includes('/api/ops/call')) return originalFetch(input, init);

    const body = JSON.parse(String(init?.body || '{}'));
    if (body.toolId !== 'shell') return originalFetch(input, init);

    if (body.operation === 'listProcesses') {
      listings++;
      const answer = inventory.map((p) => ({ ...p }));
      if (listingGate) await listingGate;
      if (opFailure) {
        return new window.Response(JSON.stringify({ success: false, error: opFailure }), { status: 200 });
      }
      return new window.Response(JSON.stringify({ success: true, data: { processes: answer } }), { status: 200 });
    }
    if (body.operation === 'stopProcess') {
      stops.push(body.params);
      return new window.Response(
        JSON.stringify({ success: true, data: { id: body.params.id, stopped: true } }),
        { status: 200 }
      );
    }
    return originalFetch(input, init);
  };

  /**
   * Deliver a `processes-changed` frame through the socket's own route, as the
   * server's would arrive.
   * @param {any[]} processes - The whole inventory.
   */
  const pushFrame = (processes) => {
    inventory = processes;
    const route = /** @type {any} */ (WebSocketService.TYPED_MESSAGE_ROUTES)['processes-changed'];
    route(wsService, { type: 'processes-changed', processes: processes.map((p) => ({ ...p })) });
  };

  /** @type {any} */
  let session = null;
  /** @type {any} */
  let conversation = null;
  /** @type {any} */
  let other = null;
  /** @type {any} */
  let content = null;
  /** @type {(() => void)|null} */
  let watching = null;

  let clock = 1;

  /**
   * Put one tool action on a thread, exactly as the worker leaves it.
   * @param {any} thread - The thread to append to.
   * @param {object} spec - What this action is.
   * @param {string} spec.tool - The tool name.
   * @param {string} spec.command - The command it ran.
   * @param {string} spec.toolUseId - The tool call.
   * @param {string} [spec.taskId] - The background task id it was handed, if any.
   * @param {string} [spec.description] - Monitor's label for it.
   * @param {string} [spec.snapshotStatus] - A durable `displayData.backgroundTask` status.
   * @returns {string} The action's item id.
   */
  function addAction(thread, spec) {
    const { tool, command, toolUseId, taskId, description, snapshotStatus } = spec;
    /** @type {any} */
    const input = { command };
    if (description !== undefined) input.description = description;

    // A background run's result carries the task receipt — and, once it has been
    // running a while, the command's accumulated output beside it. It is here so
    // the walk is measured against the real shape, where reaching a field
    // through toJSON() would copy every byte the command has produced.
    /** @type {any} */
    const result = {
      isError: false,
      fullResult: {
        success: true,
        result: taskId
          ? { task_id: taskId, status: 'running', output: `SECRET_TOKEN=hunter2\n${'y'.repeat(4096)}` }
          : { stdout: 'done' },
      },
    };

    const message = thread.appendToolAction({
      toolUseId, toolName: tool, toolInput: input, state: 'completed', result,
    });

    const items = thread.items;
    const ymap = items[items.length - 1];
    ymap.set('timestamp', new Date(1700000000000 + clock * 1000).toISOString());
    if (snapshotStatus) {
      ymap.set('displayData', { backgroundTask: { taskId, status: snapshotStatus, output: '' } });
    }
    clock++;
    return ymap.get('itemId') || message.itemId;
  }

  /**
   * One inventory entry, as the server lists it.
   * @param {string} id - Its id.
   * @param {any} [fields] - Everything else.
   * @returns {any} The entry.
   */
  const proc = (id, fields = {}) => ({
    id, kind: 'background', command: `run ${id}`, startedAt: 1700000000000 + clock++ * 1000, ...fields,
  });

  /**
   * The active-context snapshot the panel hands the content band.
   * @param {any} conv - The conversation being read.
   * @returns {any} The snapshot.
   */
  const activeContext = (conv) => ({
    project: { path: PROJECT, displayName: 'pinboard-tasks' },
    conversation: { id: conv.id, title: conv.name },
    thread: { id: null },
  });

  /** @returns {any} `services.tasks`, as a pin receives it. */
  const service = () => probe.context.services.tasks;

  /**
   * Wait for the list to say what `ok` wants, failing with what it said instead.
   * @param {(list: any[]|null) => boolean} ok - The condition.
   * @param {string} what - What is being waited for.
   * @returns {Promise<any[]>} The list.
   */
  const listWhere = async (ok, what) => {
    await waitFor(() => ok(service().list()), `${what}; list is ${JSON.stringify(service().list())}`);
    return service().list();
  };

  /**
   * @param {any[]|null} list - A task list.
   * @param {string} id - The task id to look for.
   * @returns {any} The task, or undefined.
   */
  const find = (list, id) => (list || []).find((t) => t.taskId === id);

  try {
    session = await createTestSession();
    other = await createApprovalTestConversation(session);
    session.setConversationName(other.id, 'Other work');
    conversation = await createApprovalTestConversation(session);
    session.setConversationName(conversation.id, 'Running things');
    const root = conversation.rootMessageThread;
    const doc = conversation._doc.doc;

    /** @type {string} */
    let subThread = '';
    doc.transact(() => {
      root.addEvent(createUserMessage('Start some things'));
      subThread = root.createSubThread({
        goal: 'Run the build',
        initialItems: [createAssistantMessage('Starting.')],
      }).threadId;
    }, conversation._doc.authorId);
    const sub = conversation.resolveMessageThread(subThread);

    content = /** @type {any} */ (document.createElement('pinboard-content'));
    container.appendChild(content);
    content.setSession(session);
    content.setPin({ id: 'pin_probe', type: 'task-probe', config: {} }, activeContext(conversation));
    await waitFor(() => probe.context, 'the probe pin never mounted');

    // --- before anything is asked --------------------------------------------

    await run('nothing has been asked yet, so the list is null rather than empty', () => {
      assert(service().list() === null,
        `"nothing running" is a claim; before a listing the answer is null, got ${JSON.stringify(service().list())}`);
      assert(listings === 0, 'nobody is watching, so nothing should have been asked');
    });

    watching = service().onChange(() => {});

    await run('the first watcher asks for the inventory once', async () => {
      await listWhere((l) => Array.isArray(l), 'the first listing to land');
      assert(listings === 1, `expected one listing, got ${listings}`);
      assert(service().list().length === 0, 'an empty inventory is running nothing');
    });

    // --- what is listed is what the server says --------------------------------

    await run('a frame replaces the list, across every conversation', async () => {
      addAction(root, { tool: 'bash', command: 'npm run build', toolUseId: 'call_1', taskId: 'bg-build' });
      pushFrame([
        proc('bg-build', { command: 'npm run build', convId: conversation.id, toolUseId: 'call_1' }),
        proc('shell-fg', { kind: 'foreground', command: 'make test', convId: other.id, toolUseId: 'call_9' }),
      ]);
      const list = await listWhere((l) => (l || []).length === 2, 'both processes to be listed');
      const fg = find(list, 'shell-fg');
      assert(fg.kind === 'foreground', `expected a foreground command, got ${fg.kind}`);
      assert(fg.conversationId === other.id, `expected it under its own conversation, got ${fg.conversationId}`);
      assert(fg.conversationTitle === 'Other work', `expected its conversation named, got ${JSON.stringify(fg.conversationTitle)}`);
    });

    await run('the conversation being read comes first', () => {
      const list = service().list();
      assert(list[0].conversationId === conversation.id,
        `expected this conversation's task first, got ${JSON.stringify(list.map((/** @type {any} */ t) => t.conversationId))}`);
    });

    await run('a loaded transcript lends the row, the tool and the label', async () => {
      const itemId = addAction(root, {
        tool: 'Monitor', command: 'tail -f build.log', toolUseId: 'call_2', taskId: 'bg-monitor',
        description: 'Watching the build',
      });
      pushFrame([...inventory, proc('bg-monitor', { command: 'tail -f build.log', convId: conversation.id, toolUseId: 'call_2' })]);
      const list = await listWhere((l) => !!find(l, 'bg-monitor'), 'the monitor to be listed');
      const found = find(list, 'bg-monitor');
      assert(found.itemId === itemId, `expected the spawning action, got ${found.itemId}`);
      assert(found.toolName === 'Monitor', `expected the tool named, got ${found.toolName}`);
      assert(found.label === 'Watching the build', `expected the label, got ${JSON.stringify(found.label)}`);
    });

    await run('a tool-call id repeated in a sub-thread resolves to the thread named', async () => {
      // `call_1` is also the root's build; the thread is what tells them apart.
      const subItem = addAction(sub, { tool: 'bash', command: 'npm test', toolUseId: 'call_1', taskId: 'bg-sub' });
      pushFrame([...inventory, proc('bg-sub', { command: 'npm test', convId: conversation.id, threadId: subThread, toolUseId: 'call_1' })]);
      const list = await listWhere((l) => !!find(l, 'bg-sub'), 'the sub-thread task to be listed');
      const found = find(list, 'bg-sub');
      assert(found.threadId === subThread, `expected the owning thread ${subThread}, got ${found.threadId}`);
      assert(found.itemId === subItem, `expected the sub-thread's own row, got ${found.itemId}`);
      assert(find(list, 'bg-build').itemId !== subItem, "the root's call_1 must not resolve to the sub-thread's row");
    });

    await run('reveal resolves a tool call to its row, in the thread named', () => {
      const target = resolveToolTarget(conversation, { kind: 'tool', id: 'call_1', thread: subThread });
      assert(target.kind === 'item' && target.id === find(service().list(), 'bg-sub').itemId,
        `expected the sub-thread's row, got ${JSON.stringify(target)}`);
      const missing = resolveToolTarget(conversation, { kind: 'tool', id: 'call_nope', thread: subThread });
      assert(missing.kind === 'thread' && missing.id === subThread,
        `a call with no row falls back to its thread, got ${JSON.stringify(missing)}`);
    });

    await run('a stale snapshot does not resurrect a task the server does not list', async () => {
      addAction(root, {
        tool: 'bash', command: 'sleep 9999', toolUseId: 'call_3', taskId: 'bg-ghost', snapshotStatus: 'running',
      });
      pushFrame(inventory.filter((p) => p.id !== 'bg-build'));
      const list = await listWhere((l) => !find(l, 'bg-build'), 'the ended task to leave');
      assert(!find(list, 'bg-ghost'),
        `the server is the only thing that knows what is running: ${JSON.stringify(list.map((/** @type {any} */ t) => t.taskId))}`);
      assert(!!find(list, 'bg-monitor'), 'the remaining tasks must survive one of them ending');
    });

    await run("the command's output never reaches the pin", () => {
      const serialised = JSON.stringify(service().list());
      assert(!serialised.includes('hunter2'),
        `a task's accumulated output must stay in the model:\n${serialised.slice(0, 400)}`);
      assert(!serialised.includes('yyyy'),
        `and so must its bulk — the walk reads fields, it does not copy results:\n${serialised.length} chars`);
    });

    await run('the list handed out is a copy', () => {
      const first = service().list();
      first.push({ taskId: 'bg-invented' });
      first[0].command = 'changed';
      const second = service().list();
      assert(!find(second, 'bg-invented'), 'a caller mutating the list must not change what the next one reads');
      assert(second[0].command !== 'changed', 'nor a task in it');
    });

    await run('reading another conversation reorders the list and says so', async () => {
      let told = 0;
      const stop = service().onChange(() => { told++; });
      content.setActiveContext(activeContext(other));
      await waitFor(() => told > 0, 'the watchers to be told');
      stop();
      const list = service().list();
      assert(list[0].conversationId === other.id,
        `expected the other conversation first now, got ${JSON.stringify(list.map((/** @type {any} */ t) => t.conversationId))}`);
      content.setActiveContext(activeContext(conversation));
    });

    // --- stopping -------------------------------------------------------------

    await run('stopping a plain task asks the server to stop it by id', async () => {
      const before = stops.length;
      await service().stop('bg-sub');
      assert(stops.length === before + 1, `expected one stop, got ${stops.length - before}`);
      assert(stops[stops.length - 1].id === 'bg-sub', `expected the named task, got ${JSON.stringify(stops[stops.length - 1])}`);
    });

    await run('stopping a foreground command in another conversation asks the server too', async () => {
      const before = stops.length;
      await service().stop('shell-fg');
      assert(stops.length === before + 1 && stops[stops.length - 1].id === 'shell-fg',
        `expected the foreground command stopped by id, got ${JSON.stringify(stops.slice(before))}`);
    });

    await run("a Monitor's task is stopped through its delivery binding", async () => {
      const original = root.cancelTaskOutputDelivery;
      /** @type {string[]} */
      const cancelled = [];
      root.cancelTaskOutputDelivery = (/** @type {string} */ id) => { cancelled.push(id); return true; };
      try {
        const before = stops.length;
        await service().stop('bg-monitor');
        assert(cancelled.includes('bg-monitor'), 'the binding owns the monitor and must be the one to stop it');
        assert(stops.length === before, 'and the server must not be asked as well');
      } finally {
        root.cancelTaskOutputDelivery = original;
      }
    });

    // --- failure and catching up ---------------------------------------------

    await run('a failed listing is reported and the last list is kept', async () => {
      const before = service().list().length;
      opFailure = 'connection refused';
      wsService._emit('open', {});
      await waitFor(() => service().error(), 'the failure to be recorded');
      assert(service().error().includes('connection refused'),
        `expected the underlying text kept, got ${JSON.stringify(service().error())}`);
      assert(service().list().length === before, 'a listing that failed is not evidence the tasks stopped');
      opFailure = '';
    });

    await run('the next frame clears the failure', async () => {
      pushFrame(inventory);
      await waitFor(() => service().error() === '', 'the error to clear');
    });

    await run('a frame landing while a listing is out wins', async () => {
      /** @type {() => void} */
      let release = () => {};
      listingGate = new Promise((resolve) => { release = () => resolve(); });
      inventory = [proc('bg-old')];
      const asked = listings;
      wsService._emit('open', {});
      await waitFor(() => listings > asked, 'the listing to be asked for');
      pushFrame([proc('bg-new')]);
      await listWhere((l) => !!find(l, 'bg-new'), 'the frame to land');
      listingGate = null;
      release();
      // Give the stale answer every chance to land before checking it did not.
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      assert(!find(service().list(), 'bg-old') && !!find(service().list(), 'bg-new'),
        `the older listing overwrote the newer frame: ${JSON.stringify(service().list())}`);
    });

    // --- watching -------------------------------------------------------------

    await run('with nobody watching, frames are not listened to', async () => {
      watching?.();
      watching = null;
      // The probe pin never subscribed, so the suite's watcher was the last.
      pushFrame([proc('bg-unheard')]);
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      assert(!find(service().list(), 'bg-unheard'), 'a frame reached a board nobody is watching');
    });
  } finally {
    // Drain every stub in a finally, so a case that throws cannot strand one for
    // every later suite in this realm.
    try {
      watching?.();
    } finally {
      window.fetch = originalFetch;
      content?.remove();
      container.remove();
      pinboardItemRegistry.reset();
      probe.context = null;
    }
  }

  return { passed, failed, errors };
}
