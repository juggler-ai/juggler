//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Plan pin tests — the board's view of the current plan.
 *
 * The pin is mounted with a hand-built PinContext whose `contextItems` service
 * the test drives, so a case can say exactly which thread owns the plan and what
 * the pin should then claim about it. The host's half of that service — the walk
 * up the real thread ancestry, the label, the snapshot copy — is asserted in
 * `unit:pinboard-shell` against the host that owns it, and is not re-faked here.
 *
 * What matters most is attribution. The plan draws no transcript card, so this
 * pin is the only place a standing plan is visible; a plan shown without saying
 * it belongs to a parent thread is the one failure that would actively mislead.
 * @module _tests/plan-pin-test
 */

import PlanPin from '../pins/plan-pin.js';
import PlanContextItem from '../context-items/plan-context-item.js';
import pinboardItemRegistry from '../../../js/registries/pinboard-item-registry.js';
import { createPinControl } from '../../../js/utils/properties-panel-helpers.js';
import { assert } from '../../../js-tests/utilities/test-helpers.js';
import { underPseudoLocale, assertPseudoLocalized } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';

/** juggler-core's English for this pin, standing in for its catalogue. */
const CORE_TEXT = [
  'No active conversation', 'If the conversation contains a plan, this shows its current state',
  'From {label}', 'From a parent thread', 'Reveal in conversation',
];

/** juggler-core's English for the plan block the pin draws (`lib/task-lists.js`). */
const BLOCK_TEXT = [
  'Plan', 'Plan: {title}', 'Status: {status} | Progress: {completed}/{total} completed',
  'planning', 'approved', 'executing', 'completed', 'Result: {result}',
];

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Run Plan pin tests.
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

  const pin = new PlanPin();

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
         * @param {string|null} [itemId] - The row that wrote the plan, when it has one.
         * @returns {number} Ignored; push's return value.
         */
        reveal: (threadId, itemId) => revealed.push({ threadId, itemId: itemId ?? null }),
      },
    };

    const controller = /** @type {any} */ (pin.mount(body, /** @type {any} */ ({
      pin: { id: 'pin_test', type: 'plan', config: {} },
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
      services,
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
   * A lookup result for a plan owned by a given thread.
   * @param {any[]} steps - The plan's steps.
   * @param {object} source - Source overrides.
   * @param {string|null} [source.threadId] - Owning thread.
   * @param {string} [source.label] - Its name.
   * @param {boolean} [source.inherited] - Whether it came from an ancestor.
   * @param {string|null} [source.itemId] - The row that wrote it.
   * @returns {any} The snapshot.
   */
  const planFound = (steps, source = {}) => ({
    id: 'ci_plan',
    type: 'plan',
    data: { title: 'Ship it', status: 'executing', steps },
    source: { threadId: null, label: 'Conv', inherited: false, itemId: null, ...source },
  });

  const twoSteps = [
    { content: 'First step', status: 'completed', threadItemId: null, result: null },
    { content: 'Second step', status: 'pending', threadItemId: null, result: null },
  ];

  // --- the manifest and its gates ------------------------------------------

  await test('the plan pin is a singleton', () => {
    assert(!pin.allowsMultiple, 'a second plan pin would show the same plan twice');
  });

  await test('a plan pin needs a conversation, and says so', () => {
    const reason = pin.canAdd(/** @type {any} */ ({ project: { path: '/p' }, conversation: null }));
    assert(reason === 'No active conversation', `expected the reason, got ${JSON.stringify(reason)}`);
    assert(
      pin.canAdd(/** @type {any} */ ({ conversation: { id: 'c1' } })) === true,
      'a conversation is all it needs'
    );
  });

  await test('describe reads nothing, because layout calls it', () => {
    const described = pin.describe({}, { project: { path: '', displayName: '' }, conversation: null, thread: null });
    assert(described.title === 'Plan', `expected 'Plan', got ${described.title}`);
    assert(!described.badge, 'a badge would need the model, which describe may not touch');
  });

  // --- what it draws --------------------------------------------------------

  await test('the plan renders as a task list', () => {
    const m = mount(planFound(twoSteps));
    const text = m.body.textContent || '';
    assert(text.includes('First step'), `first step missing:\n${text}`);
    assert(text.includes('Second step'), `second step missing:\n${text}`);
    assert(m.body.querySelectorAll('li.task-list-item').length === 2,
      `expected 2 task rows:\n${m.body.innerHTML}`);
    m.teardown();
  });

  await test('a step keeps its state through the pin', () => {
    const m = mount(planFound(twoSteps));
    assert(m.body.querySelector('.task-box--completed'), `completed box missing:\n${m.body.innerHTML}`);
    m.teardown();
  });

  await test('no plan anywhere says so, briefly', () => {
    const m = mount(null);
    assert((m.body.textContent || '').trim() === 'If the conversation contains a plan, this shows its current state',
      `expected the plan empty state, got ${JSON.stringify(m.body.textContent)}`);
    m.teardown();
  });

  await test('a plan with no steps is no plan', () => {
    const m = mount(planFound([]));
    assert((m.body.textContent || '').trim() === 'If the conversation contains a plan, this shows its current state',
      `an empty step list is not a plan: ${JSON.stringify(m.body.textContent)}`);
    m.teardown();
  });

  // --- attribution ----------------------------------------------------------

  await test('the thread you are reading is not named', () => {
    const m = mount(planFound(twoSteps, { threadId: 't1', label: 'Wire the parser', inherited: false }));
    assert(!m.body.querySelector('.task-list-pin__source'),
      `naming the thread you are already in is noise:\n${m.body.innerHTML}`);
    m.teardown();
  });

  await test('an inherited plan says whose it is', () => {
    const m = mount(planFound(twoSteps, { threadId: 't1', label: 'Wire the parser', inherited: true }));
    const source = m.body.querySelector('.task-list-pin__source');
    assert(source, `an inherited plan must be attributed:\n${m.body.innerHTML}`);
    assert((source.textContent || '') === 'From Wire the parser',
      `expected the thread's name, got ${JSON.stringify(source.textContent)}`);
    m.teardown();
  });

  await test('an inherited plan from an unnamed thread still says it is inherited', () => {
    const m = mount(planFound(twoSteps, { threadId: 't1', label: '', inherited: true }));
    const source = m.body.querySelector('.task-list-pin__source');
    assert(source && (source.textContent || '') === 'From a parent thread',
      `expected the fallback, got ${JSON.stringify(source?.textContent)}`);
    m.teardown();
  });

  // --- reveal ---------------------------------------------------------------

  await test('reveal is offered but dimmed when there is no plan', () => {
    const m = mount(null);
    const actions = m.controller.getActions();
    assert(actions[0].id === 'reveal',
      `reveal stays the primary action, whatever else is offered beside it: ${actions.map((/** @type {any} */ a) => a.id).join(', ')}`);
    assert(actions[0].primary === true, 'reveal is the primary action, not an overflow entry');
    assert(actions[0].disabled === true, 'nothing to reveal, so it is dim rather than absent');
    m.teardown();
  });

  await test('reveal points at the thread that owns the plan, not the one being read', () => {
    const m = mount(planFound(twoSteps, { threadId: 't_owner', label: 'Owner', inherited: true }));
    const actions = m.controller.getActions();
    assert(actions[0].disabled !== true, 'there is a plan, so reveal works');
    actions[0].run();
    assert(m.revealed.length === 1 && m.revealed[0].threadId === 't_owner',
      `expected the owning thread, got ${JSON.stringify(m.revealed)}`);
    m.teardown();
  });

  await test('a plan on the root thread reveals the root', () => {
    const m = mount(planFound(twoSteps, { threadId: null, inherited: true }));
    m.controller.getActions()[0].run();
    assert(m.revealed.length === 1 && m.revealed[0].threadId === null,
      `expected null for the root, got ${JSON.stringify(m.revealed)}`);
    m.teardown();
  });

  await test('reveal prefers the row that wrote the plan', () => {
    // A plan draws no tile of its own, so the thread alone is no movement at all
    // for a reader already in it — which, for a root-thread plan, is everyone.
    const m = mount(planFound(twoSteps, { threadId: null, itemId: 'ITEM_plan_row' }));
    m.controller.getActions()[0].run();
    assert(m.revealed.length === 1 && m.revealed[0].itemId === 'ITEM_plan_row',
      `expected the writing row, got ${JSON.stringify(m.revealed)}`);
    assert(m.revealed[0].threadId === null,
      'and the thread is still passed, as the fallback for a plan with no row');
    m.teardown();
  });

  // --- staying current ------------------------------------------------------

  await test('a context-item change re-reads', () => {
    const m = mount(planFound([{ content: 'Only step', status: 'pending', threadItemId: null, result: null }]));
    assert((m.body.textContent || '').includes('Only step'), 'first render missing');
    m.setFound(planFound([{ content: 'Replaced step', status: 'pending', threadItemId: null, result: null }]));
    m.fireChange();
    const text = m.body.textContent || '';
    assert(text.includes('Replaced step'), `the change did not land:\n${text}`);
    assert(!text.includes('Only step'), `the old plan survived:\n${text}`);
    m.teardown();
  });

  await test('a plan appearing where there was none replaces the empty state', () => {
    const m = mount(null);
    assert((m.body.textContent || '').trim() === 'If the conversation contains a plan, this shows its current state', 'expected the empty state first');
    m.setFound(planFound(twoSteps));
    m.fireChange();
    assert((m.body.textContent || '').includes('First step'), 'the new plan did not appear');
    m.teardown();
  });

  await test('a plan going away restores the empty state', () => {
    const m = mount(planFound(twoSteps));
    m.setFound(null);
    m.fireChange();
    assert((m.body.textContent || '').trim() === 'If the conversation contains a plan, this shows its current state',
      `expected the empty state back, got ${JSON.stringify(m.body.textContent)}`);
    m.teardown();
  });

  await test('an update re-reads, since the thread being read may have moved', () => {
    const m = mount(planFound(twoSteps));
    m.setFound(planFound([{ content: 'Sub-thread step', status: 'pending', threadItemId: null, result: null }],
      { threadId: 't2', label: 'Sub', inherited: false }));
    m.controller.update({
      pin: { id: 'pin_test', type: 'plan', config: {} },
      active: {
        project: { path: '/p', displayName: 'p' },
        conversation: { id: 'c1', title: 'Conv' },
        thread: { id: 't2' },
      },
      services: m.services,
      signal: new AbortController().signal,
      updateConfig: async () => {},
    });
    assert((m.body.textContent || '').includes('Sub-thread step'),
      `update did not re-read:\n${m.body.textContent}`);
    m.teardown();
  });

  await test('teardown stops listening', () => {
    const m = mount(planFound(twoSteps));
    assert(m.watchers() === 1, `expected one listener, got ${m.watchers()}`);
    m.teardown();
    assert(m.watchers() === 0, `the pin kept listening after teardown: ${m.watchers()}`);
  });

  // --- it is a view, and only a view ----------------------------------------

  await test('the pin writes nothing back', () => {
    const found = planFound(twoSteps);
    const before = JSON.stringify(found.data);
    const m = mount(found);
    m.controller.getActions();
    m.fireChange();
    assert(JSON.stringify(found.data) === before,
      'the pin mutated the snapshot it was handed, which a read-only view must not');
    m.teardown();
  });

  await test('the pin offers no way to change a step', () => {
    const m = mount(planFound(twoSteps));
    assert(!m.body.querySelector('input[type=checkbox]:not([disabled])'),
      `a live checkbox would be a second, quieter way to change an approved plan:\n${m.body.innerHTML}`);
    m.teardown();
  });

  // --- it follows the reader, and only the reader ---------------------------

  await test('the pin always starts its walk at the thread being read', () => {
    const m = mount(planFound(twoSteps), { focused: 't_reader' });
    assert(m.finds[0].from === undefined,
      `the pin names no starting thread of its own, got ${JSON.stringify(m.finds[0].from)}`);
    m.teardown();
  });

  await test('reveal is the only action, so the tab draws no overflow', () => {
    const m = mount(planFound(twoSteps));
    const ids = m.controller.getActions().map((/** @type {any} */ a) => a.id);
    assert(ids.length === 1 && ids[0] === 'reveal',
      `one action, and it is the primary one: ${ids.join(', ')}`);
    m.teardown();
  });

  // --- the affordance that puts it there ------------------------------------
  //
  // The plan draws no transcript card, so the `plan` tool-action row's properties
  // panel is where a user meets it — and the control there is the only way to get
  // it onto the board without hunting through the add picker.

  await test('the plan panel offers to pin the plan only when something can take it', () => {
    /**
     * The control the panel builds for whatever the item type names, which is
     * the same call `_renderContextItemControls` and `_renderToolActionControls`
     * both make.
     * @returns {HTMLElement|null} The control, or null when none was offered.
     */
    const control = () => createPinControl(PlanContextItem.getPinSource());

    if (pinboardItemRegistry.getType('plan')) pinboardItemRegistry.reset();
    assert(!control(),
      'with the Plan pin gone, the panel leaves the button out rather than drawing a dead one');

    pinboardItemRegistry.registerClass(PlanPin, { extensionId: 'test' });
    const button = control();
    assert(!!button, 'with the Plan pin enabled, the panel offers to put the plan on the board');
    assert(button?.getAttribute('aria-label') === 'Pin to Pinboard',
      'and says what it does without being clicked');
    assert(button?.className === 'properties-panel-btn',
      `it belongs with Re-run and Delete, not in the body: ${button?.className}`);
    assert((button?.textContent || '').includes('Pin to Pinboard'),
      `a control in that block is labelled, not a bare icon: ${button?.textContent}`);
  });

  // --- en-XA ----------------------------------------------------------------

  await test('en-XA: the add reason, empty state, source lines and reveal action are translated', async () => {
    await underPseudoLocale('plan-pin-test', async () => {
      /** @type {Record<string, string>} */
      const shown = {};
      shown['add reason'] = String(pin.canAdd(/** @type {any} */ ({ conversation: null })));

      const empty = mount(null);
      shown['empty state'] = (empty.body.textContent || '').trim();
      shown['reveal label'] = String(empty.controller.getActions()[0]?.label);
      empty.teardown();

      const named = mount(planFound(twoSteps, { threadId: 't1', label: '1', inherited: true }));
      shown['source line'] = String(named.body.querySelector('.task-list-pin__source')?.textContent);
      shown['reveal label, with a plan'] = String(named.controller.getActions()[0]?.label);
      named.teardown();
      const unnamed = mount(planFound(twoSteps, { threadId: 't1', label: '', inherited: true }));
      shown['source line, unnamed thread'] = String(unnamed.body.querySelector('.task-list-pin__source')?.textContent);
      unnamed.teardown();

      // The plan block: its heading, status line and result line are the
      // pin's to show translated. Step text is data, so the list items are
      // skipped and the result line inside one is read on its own.
      const digitPlan = {
        title: '7', status: 'executing', steps: [
          { content: '1', status: 'completed', threadItemId: null, result: '9' },
          { content: '2', status: 'pending', threadItemId: null, result: null },
        ],
      };
      const block = mount({ ...planFound(digitPlan.steps), data: digitPlan });
      const markdown = /** @type {HTMLElement} */ (block.body.querySelector('.markdown'));
      assert(!!markdown, 'the pin drew no plan block');
      assertPseudoLocalized(markdown, { skip: 'li', atLeast: 2, where: 'plan block' });
      // The item reads as its step text, '1', run straight into the result line.
      const resultLine = (markdown.querySelector('li')?.textContent || '').trim().replace(/^1/, '').trim();
      assert(isPseudoLocalized(resultLine), `result line ${JSON.stringify(resultLine)}`);
      block.teardown();

      const raw = Object.entries(shown).filter(([, s]) => !isPseudoLocalized(s));
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);

      // The same plan as the model reads it, in its context block and in a
      // step action's echo, stays English.
      const item = new PlanContextItem(/** @type {any} */ ({ id: 'ci_plan', session: {}, conversation: {}, messageThread: {} }));
      item.data = digitPlan;
      const context = item.createContextText(/** @type {any} */ ({
        helpers: { xml: (/** @type {string} */ tag, /** @type {string} */ body) => `<${tag}>${body}</${tag}>` },
      }));
      const echo = item.getSummary({
        success: true,
        prepared: { valid: true, params: { action: 'complete_step', index: 1 } },
        result: { index: 1, oldStatus: 'in_progress', newStatus: 'completed', completed: 1, total: 2, planSnapshot: digitPlan },
      }).feedbackForLLM ?? '';
      for (const [where, text] of Object.entries({ context, echo })) {
        assert(text.includes('# Plan: 7\nStatus: executing | Progress: 1/2 completed\n'),
          `${where}: the model's plan heading is not English: ${JSON.stringify(text)}`);
        assert(text.includes('   Result: 9'), `${where}: the model's result line is not English: ${JSON.stringify(text)}`);
      }
    }, { '@juggler/core': [...CORE_TEXT, ...BLOCK_TEXT] });
  });

  return { passed, failed, errors };
}
