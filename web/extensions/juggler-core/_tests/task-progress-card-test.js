//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Progress card tests — when it is there, what its strips say, and the way in
 * to the Plan and Todo pins.
 *
 * The session is a hand-built stand-in exposing only what the card reads: the
 * visible conversation, its threads' context items, and the event feed. The walk
 * up a real thread ancestry is asserted against the real host in
 * `unit:pinboard-shell`, through the same module the card resolves with.
 * @module _tests/task-progress-card-test
 */

import TaskProgressCard, { FOLLOW_MS } from '../cards/task-progress-card.js';
import PlanPin from '../pins/plan-pin.js';
import TodoPin from '../pins/todo-pin.js';
import pinboardItemRegistry from '../../../js/registries/pinboard-item-registry.js';
import pinboardStore from '../../../js/services/pinboard-store.js';
import pinboardView from '../../../js/services/pinboard-view.js';
import { findNearestContextItem } from '../../../js/services/nearest-context-item.js';
import { assert, waitFor, nextTask } from '../../../js-tests/utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';

/** juggler-core's English for this card, standing in for its catalogue. */
const CORE_TEXT = [
  'Plan', 'Todos', '{completed}/{total}',
  'Plan: {completed} of {total, plural, one {# step} other {# steps}} done',
  'Todos: {completed} of {total, plural, one {# item} other {# items}} done',
  'Open the plan in the Pinboard', 'Open the todo list in the Pinboard',
];

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * A plan's data, executing unless said otherwise.
 * @param {string[]} statuses - One status per step.
 * @param {string} [status] - The plan-level status.
 * @returns {any} The plan item's data.
 */
const plan = (statuses, status = 'executing') => ({
  title: 'A plan', status, steps: statuses.map((s, i) => ({ content: `step ${i}`, status: s })),
});

/**
 * A todo list's data.
 * @param {string[]} statuses - One status per item.
 * @returns {any} The todo item's data.
 */
const todos = (statuses) => ({ todos: statuses.map((s, i) => ({ content: `todo ${i}`, status: s })) });

/**
 * A stand-in session whose visible conversation has one root thread holding the
 * given items. `items` is live: a case mutates it and then emits.
 * @param {Array<{type: string, data: any}>} items - The root thread's context items.
 * @returns {any} The session, its items, and a way to emit events.
 */
function fakeSession(items) {
  /** @type {((event: any) => void)[]} */
  const listeners = [];
  const conversation = {
    id: 'c1',
    findParentContainer: () => null,
    /**
     * @param {string|null} id - The thread.
     * @returns {any} The root thread, the only one there is.
     */
    resolveMessageThread: (id) => {
      if (id !== null) throw new Error(`no thread ${id}`);
      return { contextItems: items };
    },
  };
  let visible = /** @type {any} */ (conversation);
  return {
    items,
    getVisibleConversation: () => visible,
    /** @param {any} next - What to show instead. */
    show: (next) => { visible = next; },
    /**
     * @param {(event: any) => void} fn - Listener.
     * @returns {() => void} Unsubscribe.
     */
    subscribe: (fn) => {
      listeners.push(fn);
      return () => { const at = listeners.indexOf(fn); if (at >= 0) listeners.splice(at, 1); };
    },
    /**
     * @param {string} type - Event type.
     * @param {any} [data] - Event data.
     */
    emit: (type, data) => { for (const fn of [...listeners]) fn({ type, data }); },
    listenerCount: () => listeners.length,
  };
}

/**
 * Run progress card tests.
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /** @type {(() => void)[]} */
  const owed = [];

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
    } finally {
      while (owed.length) owed.pop()?.();
    }
  }

  const card = new TaskProgressCard();

  /**
   * Mount the card into a detached-from-layout content region.
   * @param {any} session - The stand-in session.
   * @returns {{contentEl: HTMLElement, rows: () => HTMLElement[], width: (kind: string, state: string) => string}} The content element and levers.
   */
  function mount(session) {
    const contentEl = document.createElement('div');
    document.body.appendChild(contentEl);
    const stop = card.mount(contentEl, session);
    owed.push(() => { stop?.(); contentEl.remove(); });
    return {
      contentEl,
      rows: () => /** @type {HTMLElement[]} */ ([...contentEl.querySelectorAll('.info-card__task-row')]),
      // The strip is the plan/todo pins' own bar (lib/task-lists.js), one
      // segment per state; a state with no items draws no segment.
      width: (/** @type {string} */ kind, /** @type {string} */ state) => /** @type {HTMLElement|null} */ (
        contentEl.querySelector(`.info-card__task-row[data-kind="${kind}"] .task-progress__segment--${state}`))
        ?.style.width ?? 'none',
    };
  }

  /**
   * Stand in for the server's pinboard endpoints, against a board this test owns.
   * @returns {any[]} The board, as the server holds it.
   */
  function stubBoard() {
    pinboardStore.reset();
    pinboardView.reset();
    const original = window.fetch;
    /** @type {any[]} */
    const board = [];
    window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ opts) => {
      const target = String(url);
      if (target.includes('/pinboard/operations')) {
        for (const op of JSON.parse(opts.body).operations) {
          if (op.op === 'add' && !board.some((p) => p.id === op.id)) {
            board.push({ id: op.id, type: op.type, config: op.config || {} });
          }
        }
        return { ok: true, json: async () => ({ pins: board }) };
      }
      if (target.includes('/session/pinboard')) return { ok: true, json: async () => ({ pins: board }) };
      return original(url, opts);
    });
    owed.push(() => {
      window.fetch = original;
      pinboardStore.reset();
      pinboardView.reset();
    });
    return board;
  }

  /** Put the Plan and Todo pins in the registry, as an enabled extension would. */
  function enablePins() {
    pinboardItemRegistry.reset();
    pinboardItemRegistry.registerClass(/** @type {any} */ (PlanPin), { extensionId: 'test' });
    pinboardItemRegistry.registerClass(/** @type {any} */ (TodoPin), { extensionId: 'test' });
    owed.push(() => pinboardItemRegistry.reset());
  }

  // --- when it is there -----------------------------------------------------

  await test('with no conversation, or one with no lists, the card has nothing to show', () => {
    assert(!card.hasContent(undefined), 'no session');
    const empty = fakeSession([]);
    empty.show(null);
    assert(!card.hasContent(empty), 'no visible conversation');
    assert(!card.hasContent(fakeSession([{ type: 'memory', data: {} }])), 'a conversation with no plan or todos');
  });

  await test('a plan or a todo list with work left brings the card in', () => {
    assert(card.hasContent(fakeSession([{ type: 'plan', data: plan(['completed', 'pending']) }])), 'an executing plan');
    assert(card.hasContent(fakeSession([{ type: 'todo', data: todos(['in_progress']) }])), 'an open todo');
  });

  await test('finished lists, and an empty plan, keep it out', () => {
    // A plan all of whose steps have settled is marked completed, failures included.
    assert(!card.hasContent(fakeSession([{ type: 'plan', data: plan(['completed', 'failed'], 'completed') }])),
      'a completed plan');
    assert(!card.hasContent(fakeSession([{ type: 'plan', data: plan([], 'planning') }])), 'a plan with no steps');
    assert(!card.hasContent(fakeSession([{ type: 'todo', data: todos(['completed', 'completed']) }])),
      'a ticked-off todo list');
    assert(!card.hasContent(fakeSession([{ type: 'todo', data: todos([]) }])), 'an empty todo list');
  });

  // --- what it shows ----------------------------------------------------------

  await test('one strip per active list, plan above todos, each filled to its share', () => {
    const m = mount(fakeSession([
      { type: 'todo', data: todos(['completed', 'pending', 'pending', 'pending']) },
      { type: 'plan', data: plan(['completed', 'completed', 'in_progress', 'pending']) },
    ]));
    const kinds = m.rows().map((r) => r.dataset.kind);
    assert(JSON.stringify(kinds) === '["plan","todo"]', `expected plan then todo, got ${JSON.stringify(kinds)}`);
    assert(m.width('plan', 'completed') === '50%', `plan is half done, got ${m.width('plan', 'completed')}`);
    assert(m.width('plan', 'in-progress') === '25%',
      `the step under way has its own segment, got ${m.width('plan', 'in-progress')}`);
    assert(m.width('todo', 'completed') === '25%', `todos a quarter, got ${m.width('todo', 'completed')}`);
    assert(m.width('todo', 'in-progress') === 'none', `nothing under way, got ${m.width('todo', 'in-progress')}`);
    assert((m.rows()[0]?.textContent || '').includes('2/4'), `the count is shown, got ${m.rows()[0]?.textContent}`);
    assert(m.rows()[0]?.getAttribute('aria-label') === 'Plan: 2 of 4 steps done',
      `and read out whole, got ${JSON.stringify(m.rows()[0]?.getAttribute('aria-label'))}`);
  });

  await test('a finished list is dropped while the other is still going', () => {
    const m = mount(fakeSession([
      { type: 'plan', data: plan(['completed'], 'completed') },
      { type: 'todo', data: todos(['pending']) },
    ]));
    const kinds = m.rows().map((r) => r.dataset.kind);
    assert(JSON.stringify(kinds) === '["todo"]', `only the todos are in flight, got ${JSON.stringify(kinds)}`);
  });

  await test('the plan it shows is the nearest one up the reader\u2019s threads', () => {
    // The resolution the Plan pin uses, so the strip and the pin it opens agree.
    const threads = /** @type {Record<string, any>} */ ({
      root: { contextItems: [{ type: 'plan', data: plan(['pending']) }] },
      child: { contextItems: [] },
      grandchild: { contextItems: [{ type: 'plan', data: plan(['completed', 'pending']) }] },
    });
    const parents = /** @type {Record<string, string|null>} */ ({ child: null, grandchild: 'child' });
    const conversation = {
      resolveMessageThread: (/** @type {string|null} */ id) => threads[id ?? 'root'],
      findParentContainer: (/** @type {string} */ id) => (parents[id] ? { get: () => parents[id] } : null),
    };
    assert(findNearestContextItem(conversation, 'plan', 'child')?.threadId === null,
      'a thread without one falls back to the root\u2019s');
    assert(findNearestContextItem(conversation, 'plan', 'grandchild')?.threadId === 'grandchild',
      'a thread with its own shows its own');
    assert(findNearestContextItem(conversation, 'todo', 'grandchild') === null, 'and nothing is invented');
  });

  // --- following the conversation -------------------------------------------

  await test('the strips follow a list as it moves', async () => {
    const session = fakeSession([{ type: 'plan', data: plan(['completed', 'pending', 'pending', 'pending']) }]);
    const m = mount(session);
    assert(m.width('plan', 'completed') === '25%', `one step done, got ${m.width('plan', 'completed')}`);
    assert(m.width('plan', 'in-progress') === 'none', `nothing under way, got ${m.width('plan', 'in-progress')}`);
    // A step starting leaves the done count where it was; the bar still moves.
    session.items[0].data = plan(['completed', 'in_progress', 'pending', 'pending']);
    session.emit('conversation:changed', { conversationId: 'c1' });
    await waitFor(() => m.width('plan', 'in-progress') === '25%',
      { timeoutMs: FOLLOW_MS * 20, description: 'the started step to show' });
    session.items[0].data = plan(['completed', 'completed', 'in_progress', 'pending']);
    session.emit('conversation:changed', { conversationId: 'c1' });
    await waitFor(() => m.width('plan', 'completed') === '50%' && m.width('plan', 'in-progress') === '25%',
      { timeoutMs: FOLLOW_MS * 20, description: 'the strip to move on a step' });
  });

  await test('the rail is told only when the card should come or go', async () => {
    const session = fakeSession([{ type: 'todo', data: todos(['pending', 'pending']) }]);
    let told = 0;
    const stop = card.watchContent(session, () => { told++; });
    owed.push(stop);

    /**
     * Wait past every gathered re-read already armed. A change is re-read on a
     * FOLLOW_MS timer, and timers of equal delay fire in the order they were
     * armed, so a second watch whose own gathered re-read is armed now — and
     * reported, by flipping its card's presence — lands after any re-read the
     * watch under test has pending. That is the later event that would have
     * carried a re-read this case says must tell the rail nothing.
     * @returns {Promise<void>} Resolves once the second watch has been told.
     */
    const pastGatheredRereads = async () => {
      const later = fakeSession([{ type: 'todo', data: todos(['pending']) }]);
      let laterTold = 0;
      const stopLater = card.watchContent(later, () => { laterTold++; });
      try {
        later.items[0].data = todos(['completed']);
        later.emit('conversation:changed', { conversationId: 'c1' });
        await waitFor(() => laterTold === 1,
          { timeoutMs: FOLLOW_MS * 20, description: 'a watch armed afterwards to re-read its change' });
      } finally {
        stopLater();
      }
    };

    // Progress, not presence: the rail is not bothered.
    session.items[0].data = todos(['completed', 'pending']);
    session.emit('conversation:changed', { conversationId: 'c1' });
    await pastGatheredRereads();
    assert(told === 0, `progress alone is not news to the rail, told ${told} times`);

    // Another conversation's change is not this one's.
    session.items[0].data = todos(['completed', 'completed']);
    session.emit('conversation:changed', { conversationId: 'c2' });
    await pastGatheredRereads();
    assert(told === 0, `another conversation's change was taken for this one's, told ${told} times`);

    // A switch is answered at once, and the list is now finished.
    session.emit('conversation:switched', { conversationId: 'c1' });
    assert(told === 1, `the last item ticked takes the card away, told ${told} times`);

    stop();
    assert(session.listenerCount() === 0, 'stopping the watch unsubscribes');
  });

  // --- the way in to the pins -------------------------------------------------

  await test('with no pins to open, the rows are a reading, not a control', () => {
    pinboardItemRegistry.reset();
    const m = mount(fakeSession([{ type: 'plan', data: plan(['pending']) }]));
    assert(m.rows()[0]?.tagName !== 'BUTTON', 'an affordance that would do nothing is absent rather than inert');
  });

  await test('clicking a strip opens its own list in the Pinboard', async () => {
    enablePins();
    const board = stubBoard();
    const m = mount(fakeSession([
      { type: 'plan', data: plan(['pending']) },
      { type: 'todo', data: todos(['pending']) },
    ]));
    const [planRow, todoRow] = m.rows();
    assert(planRow?.tagName === 'BUTTON' && todoRow?.tagName === 'BUTTON', 'with the pins enabled, each row is a button');

    /** @type {any} */ (todoRow).click();
    await nextTask();
    assert(board.length === 1 && board[0].type === 'todo', `the todo row opens the Todo pin, got ${JSON.stringify(board)}`);
    assert(pinboardView.isOpen() && pinboardView.getActivePinId() === board[0].id, 'and shows it');

    /** @type {any} */ (planRow).click();
    await nextTask();
    assert(board.length === 2 && board[1].type === 'plan', `the plan row opens the Plan pin, got ${JSON.stringify(board)}`);
    assert(pinboardView.getActivePinId() === board[1].id, 'and shows it');
  });

  // --- en-XA ------------------------------------------------------------------

  await test('en-XA: every row, with and without a pin to open, is translated', async () => {
    await underPseudoLocale('task-progress-card-test', async () => {
      /** @type {string[]} */
      const shown = [];
      for (const withPins of [false, true]) {
        if (withPins) enablePins(); else pinboardItemRegistry.reset();
        const m = mount(fakeSession([
          { type: 'plan', data: plan(['completed', 'pending']) },
          { type: 'todo', data: todos(['pending']) },
        ]));
        shown.push(...shownStrings(m.contentEl));
        for (const r of m.rows()) shown.push(r.getAttribute('aria-label') || '', r.title);
      }
      const raw = shown.filter((s) => s && !isPseudoLocalized(s));
      assert(shown.length >= 12, `expected the rows to show text, got ${JSON.stringify(shown)}`);
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    }, { '@juggler/core': CORE_TEXT });
  });

  return { passed, failed, errors };
}
