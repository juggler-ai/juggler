//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Todo pin tests — the board's view of the current checklist.
 *
 * Mounted with a hand-built PinContext whose `contextItems` service the test
 * drives, the same way `unit:plan-pin` does; the host's half of that service is
 * asserted in `unit:pinboard-shell`. What is checked here and not there is the
 * behaviour the two task-list pins share through `lib/task-list-pin.js` — so the
 * cases mirror the plan's deliberately, since a change that breaks one silently
 * for the other is exactly what sharing that module risks.
 * @module _tests/todo-pin-test
 */

import TodoPin from '../pins/todo-pin.js';
import TodoContextItem from '../context-items/todo-context-item.js';
import pinboardItemRegistry from '../../../js/registries/pinboard-item-registry.js';
import { createPinControl } from '../../../js/utils/properties-panel-helpers.js';
import { assert } from '../../../js-tests/utilities/test-helpers.js';
import '../../../js/components/properties-panel.js';
import { underPseudoLocale, assertPseudoLocalized } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';

/** juggler-core's English for this pin, standing in for its catalogue. */
const CORE_TEXT = [
  'No active conversation', 'If the conversation contains a TODO list, this shows its current state',
  'From {label}', 'From a parent thread', 'Reveal in conversation',
];

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Run Todo pin tests.
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests(_ctx) {
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

  const pin = new TodoPin();

  /**
   * Mount the pin against a canned lookup result.
   * @param {any} found - What `contextItems.find` should return.
   * @param {object} [options] - How this pin is read.
   * @param {string|null} [options.focused] - The thread the reader is in.
   * @returns {any} The body, controller and the levers a test needs.
   */
  function mount(found, { focused = null } = {}) {
    const body = document.createElement('div');
    document.body.appendChild(body);
    const abort = new AbortController();
    /** @type {(() => void)[]} */
    const listeners = [];
    /** @type {{threadId: string|null, itemId: string|null}[]} */
    const revealed = [];
    /** @type {{type: string, from: any}[]} */
    const finds = [];
    let current = found;

    const services = {
      files: { onChange: () => () => {} },
      contextItems: {
        /**
         * @param {string} type - The context-item type wanted.
         * @param {string|null} [from] - Where the walk should start.
         * @returns {any} The canned result.
         */
        find: (type, from) => {
          finds.push({ type, from });
          return current;
        },
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
        /**
         * @param {string|null} threadId - The thread to reveal.
         * @param {string|null} [itemId] - The row that wrote the list, when it has one.
         * @returns {number} Ignored; push's return value.
         */
        reveal: (threadId, itemId) => revealed.push({ threadId, itemId: itemId ?? null }),
      },
    };

    const controller = /** @type {any} */ (pin.mount(body, /** @type {any} */ ({
      pin: { id: 'pin_test', type: 'todo', config: {} },
      active: {
        project: { path: '/p', displayName: 'p' },
        conversation: { id: 'c1', title: 'Conv' },
        thread: { id: focused },
      },
      services,
      signal: abort.signal,
      updateConfig: async () => {},
    })));

    return {
      body,
      controller,
      revealed,
      finds,
      watchers: () => listeners.length,
      /** @param {any} next - The new lookup result. */
      setFound: (next) => { current = next; },
      fireChange: () => { for (const listener of [...listeners]) listener(); },
      teardown: () => {
        controller.teardown?.();
        abort.abort();
        body.remove();
      },
    };
  }

  /**
   * A lookup result for a todo list owned by a given thread.
   * @param {any[]} todos - The list.
   * @param {object} source - Source overrides.
   * @param {string|null} [source.threadId] - Owning thread.
   * @param {string} [source.label] - Its name.
   * @param {boolean} [source.inherited] - Whether it came from an ancestor.
   * @param {string|null} [source.itemId] - The row that wrote it.
   * @returns {any} The snapshot.
   */
  const todoFound = (todos, source = {}) => ({
    id: 'ci_todo',
    type: 'todo',
    data: { todos },
    source: { threadId: null, label: 'Conv', inherited: false, itemId: null, ...source },
  });

  const twoTodos = [
    { content: 'Read the file', status: 'completed' },
    { content: 'Write the file', status: 'in_progress' },
  ];

  // --- the manifest and its gates ------------------------------------------

  await test('the todo pin is a singleton', () => {
    assert(!pin.allowsMultiple, 'a second todo pin would show the same list twice');
  });

  await test('a todo pin needs a conversation, and says so', () => {
    const reason = pin.canAdd(/** @type {any} */ ({ project: { path: '/p' }, conversation: null }));
    assert(reason === 'No active conversation', `expected the reason, got ${JSON.stringify(reason)}`);
  });

  await test('describe reads nothing, because layout calls it', () => {
    const described = pin.describe({}, { project: { path: '', displayName: '' }, conversation: null, thread: null });
    assert(described.title === 'Todos', `expected 'Todos', got ${described.title}`);
    assert(!described.badge, 'a badge would need the model, which describe may not touch');
  });

  // --- what it draws --------------------------------------------------------

  await test('the checklist renders as a task list', () => {
    const m = mount(todoFound(twoTodos));
    const text = m.body.textContent || '';
    assert(text.includes('Read the file'), `first item missing:\n${text}`);
    assert(text.includes('Write the file'), `second item missing:\n${text}`);
    assert(m.body.querySelectorAll('li.task-list-item').length === 2,
      `expected 2 task rows:\n${m.body.innerHTML}`);
    m.teardown();
  });

  await test('an item keeps its state through the pin', () => {
    const m = mount(todoFound(twoTodos));
    assert(m.body.querySelector('.task-box--in-progress'),
      `in-progress box missing:\n${m.body.innerHTML}`);
    m.teardown();
  });

  await test('no list anywhere says so, briefly', () => {
    const m = mount(null);
    assert((m.body.textContent || '').trim() === 'If the conversation contains a TODO list, this shows its current state',
      `expected the todo empty state, got ${JSON.stringify(m.body.textContent)}`);
    m.teardown();
  });

  await test('an emptied list is no list', () => {
    const m = mount(todoFound([]));
    assert((m.body.textContent || '').trim() === 'If the conversation contains a TODO list, this shows its current state',
      `an empty list is nothing to show: ${JSON.stringify(m.body.textContent)}`);
    m.teardown();
  });

  // --- attribution ----------------------------------------------------------

  await test('the thread you are reading is not named', () => {
    const m = mount(todoFound(twoTodos, { threadId: 't1', label: 'Wire it', inherited: false }));
    assert(!m.body.querySelector('.task-list-pin__source'),
      `naming the thread you are already in is noise:\n${m.body.innerHTML}`);
    m.teardown();
  });

  await test('an inherited list says whose it is', () => {
    const m = mount(todoFound(twoTodos, { threadId: 't1', label: 'Wire it', inherited: true }));
    const source = m.body.querySelector('.task-list-pin__source');
    assert(source && (source.textContent || '') === 'From Wire it',
      `expected the thread's name, got ${JSON.stringify(source?.textContent)}`);
    m.teardown();
  });

  // --- reveal ---------------------------------------------------------------

  await test('reveal is offered but dimmed when there is no list', () => {
    const m = mount(null);
    const actions = m.controller.getActions();
    assert(actions[0].id === 'reveal',
      `reveal stays the primary action, whatever else is offered beside it: ${actions.map((/** @type {any} */ a) => a.id).join(', ')}`);
    assert(actions[0].disabled === true, 'nothing to reveal, so it is dim rather than absent');
    m.teardown();
  });

  await test('reveal points at the thread that owns the list', () => {
    const m = mount(todoFound(twoTodos, { threadId: 't_owner', label: 'Owner', inherited: true }));
    m.controller.getActions()[0].run();
    assert(m.revealed.length === 1 && m.revealed[0].threadId === 't_owner',
      `expected the owning thread, got ${JSON.stringify(m.revealed)}`);
    m.teardown();
  });

  await test('reveal prefers the row that wrote the list', () => {
    // The list draws no tile of its own, so the thread alone is no movement at
    // all for a reader already in it.
    const m = mount(todoFound(twoTodos, { threadId: null, itemId: 'ITEM_todo_row' }));
    m.controller.getActions()[0].run();
    assert(m.revealed.length === 1 && m.revealed[0].itemId === 'ITEM_todo_row',
      `expected the writing row, got ${JSON.stringify(m.revealed)}`);
    m.teardown();
  });

  // --- staying current ------------------------------------------------------

  await test('the tool replacing the list wholesale lands as a replacement', () => {
    const m = mount(todoFound([{ content: 'Old only', status: 'pending' }]));
    m.setFound(todoFound([
      { content: 'New first', status: 'completed' },
      { content: 'New second', status: 'pending' },
    ]));
    m.fireChange();
    const text = m.body.textContent || '';
    assert(text.includes('New first') && text.includes('New second'), `the new list is missing:\n${text}`);
    assert(!text.includes('Old only'), `the replaced list survived:\n${text}`);
    m.teardown();
  });

  await test('a list going away restores the empty state', () => {
    const m = mount(todoFound(twoTodos));
    m.setFound(null);
    m.fireChange();
    assert((m.body.textContent || '').trim() === 'If the conversation contains a TODO list, this shows its current state',
      `expected the empty state back, got ${JSON.stringify(m.body.textContent)}`);
    m.teardown();
  });

  await test('teardown stops listening', () => {
    const m = mount(todoFound(twoTodos));
    assert(m.watchers() === 1, `expected one listener, got ${m.watchers()}`);
    m.teardown();
    assert(m.watchers() === 0, `the pin kept listening after teardown: ${m.watchers()}`);
  });

  // --- it is a view, and only a view ----------------------------------------

  await test('the pin offers no way to tick an item', () => {
    const m = mount(todoFound(twoTodos));
    assert(!m.body.querySelector('input[type=checkbox]:not([disabled])'),
      `the todo tool replaces the list wholesale, so a live checkbox here would race it:\n${m.body.innerHTML}`);
    m.teardown();
  });

  await test('the pin writes nothing back', () => {
    const found = todoFound(twoTodos);
    const before = JSON.stringify(found.data);
    const m = mount(found);
    m.controller.getActions();
    m.fireChange();
    assert(JSON.stringify(found.data) === before,
      'the pin mutated the snapshot it was handed, which a read-only view must not');
    m.teardown();
  });

  // --- it follows the reader, and only the reader ---------------------------

  await test('the todo pin always starts its walk at the thread being read', () => {
    const m = mount(todoFound(twoTodos), { focused: 't_reader' });
    assert(m.finds[0].from === undefined,
      `the pin names no starting thread of its own, got ${JSON.stringify(m.finds[0].from)}`);
    m.teardown();
  });

  await test('reveal is the only action the todo pin offers', () => {
    const m = mount(todoFound(twoTodos));
    const ids = m.controller.getActions().map((/** @type {any} */ a) => a.id);
    assert(ids.length === 1 && ids[0] === 'reveal',
      `one action, and it is the primary one: ${ids.join(', ')}`);
    m.teardown();
  });

  // --- the affordance that puts it there ------------------------------------
  //
  // The checklist draws no transcript card, so the `todo` tool-action row's
  // properties panel is where a user meets it — and the control there is the only
  // way to get it onto the board without hunting through the add picker.

  await test('the todo panel offers to pin the list only when something can take it', () => {
    /**
     * The control the panel builds for whatever the item type names, which is
     * the same call `_renderContextItemControls` and `_renderToolActionControls`
     * both make.
     * @returns {HTMLElement|null} The control, or null when none was offered.
     */
    const control = () => createPinControl(TodoContextItem.getPinSource());

    if (pinboardItemRegistry.getType('todo')) pinboardItemRegistry.reset();
    assert(!control(),
      'with the Todo pin gone, the panel leaves the button out rather than drawing a dead one');

    pinboardItemRegistry.registerClass(TodoPin, { extensionId: 'test' });
    const button = control();
    assert(!!button, 'with the Todo pin enabled, the panel offers to put the list on the board');
    assert(button?.getAttribute('aria-label') === 'Pin to Pinboard',
      'and says what it does without being clicked');
    assert(button?.className === 'properties-panel-btn',
      `it belongs with Re-run and Delete, not in the body: ${button?.className}`);
    assert((button?.textContent || '').includes('Pin to Pinboard'),
      `a control in that block is labelled, not a bare icon: ${button?.textContent}`);
  });

  await test('the panel puts it in the controls block, not in the body', () => {
    pinboardItemRegistry.registerClass(TodoPin, { extensionId: 'test' });
    const panel = /** @type {any} */ (document.createElement('properties-panel'));
    // A tool-action with no result and no thread: every other control gates
    // itself off, leaving whatever the pin seam contributed and nothing else.
    panel._conversation = { toolActionClass: () => TodoContextItem };
    panel._messageThread = null;
    const controls = panel._renderToolActionControls({ get: () => undefined });

    const labels = [...controls.children].map((/** @type {Element} */ c) => c.textContent?.trim());
    assert(labels.length === 1 && labels[0] === 'Pin to Pinboard',
      `the panel's own controls are where it belongs, got [${labels.join(', ')}]`);
  });

  // --- en-XA ----------------------------------------------------------------

  await test('en-XA: the add reason, empty state, source lines and reveal action are translated', async () => {
    await underPseudoLocale('todo-pin-test', async () => {
      /** @type {Record<string, string>} */
      const shown = {};
      shown['add reason'] = String(pin.canAdd(/** @type {any} */ ({ conversation: null })));

      const empty = mount(null);
      shown['empty state'] = (empty.body.textContent || '').trim();
      shown['reveal label'] = String(empty.controller.getActions()[0]?.label);
      empty.teardown();

      const named = mount(todoFound(twoTodos, { threadId: 't1', label: '1', inherited: true }));
      shown['source line'] = String(named.body.querySelector('.task-list-pin__source')?.textContent);
      named.teardown();
      const unnamed = mount(todoFound(twoTodos, { threadId: 't1', label: '', inherited: true }));
      shown['source line, unnamed thread'] = String(unnamed.body.querySelector('.task-list-pin__source')?.textContent);
      unnamed.teardown();

      // The list block: its heading and progress line are the pin's to show
      // translated. Item text is data, so the list items are skipped.
      /** @type {import('../context-items/todo-context-item.js').TodoItem[]} */
      const digitTodos = [{ content: '1', status: 'completed' }, { content: '2', status: 'in_progress' }];
      const block = mount(todoFound(digitTodos));
      const markdown = /** @type {HTMLElement} */ (block.body.querySelector('.markdown'));
      assert(!!markdown, 'the pin drew no todo block');
      assertPseudoLocalized(markdown, { skip: 'li', atLeast: 2, where: 'todo block' });
      block.teardown();

      const raw = Object.entries(shown).filter(([, s]) => !isPseudoLocalized(s));
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);

      // The same list as the model reads it in its context block stays English.
      const item = new TodoContextItem(/** @type {any} */ ({ id: 'ci_todo', session: {}, conversation: {}, messageThread: {} }));
      item.setTodos(digitTodos);
      const context = item.createContextText(/** @type {any} */ ({
        helpers: { xml: (/** @type {string} */ tag, /** @type {string} */ body) => `<${tag}>${body}</${tag}>` },
      }));
      assert(context.includes('# Todo list\nProgress: 1/2 completed\n'),
        `the model's todo heading is not English: ${JSON.stringify(context)}`);
      assert(context.includes('[/] 2 _(in progress)_'),
        `the model's status words are not English: ${JSON.stringify(context)}`);
    }, { '@juggler/core': [...CORE_TEXT, 'Todo list', 'Progress: {completed}/{total} completed'] });
  });

  return { passed, failed, errors };
}
