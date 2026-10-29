//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Tasks pin tests — what the board says the project's conversations are running.
 *
 * Mounted with a hand-built PinContext whose `tasks` service the test drives, so
 * a case states what is running rather than arranging for it; the host half —
 * the server's inventory, and what the transcript adds to it — is asserted
 * against real models in `unit:pinboard-tasks`.
 *
 * Two things here are asserted as the features they are rather than as details.
 * The first is that "still looking" and "nothing running" are different states:
 * collapsing them would make the pin claim, every time it mounts, that nothing is
 * running. The second is that no case anywhere in this file can find a task's
 * output in the body, because the pin deliberately has none.
 * @module _tests/tasks-pin-test
 */

import TasksPin from '../pins/tasks-pin.js';
import { assert, waitFor } from '../../../js-tests/utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';

/** juggler-core's English for this pin, standing in for its catalogue. */
const CORE_TEXT = [
  'Running tasks', 'Stop', 'Reveal the action that started {name}', 'Stop {name}',
  '{seconds}s', '{minutes}m', '{hours}h {minutes}m', 'Looking…',
  'Commands running in this project appear here.', "Couldn't check what's running. {error}",
  "Couldn't stop it. {error}", "Only what this project's conversations started, and only while it runs.",
  'background', 'foreground', 'python', 'this conversation', 'Untitled', 'No conversation',
];

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Run Tasks pin tests.
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

  const pin = new TasksPin();
  /**
   * The same pin as the host holds it: through the pinboard contract, which
   * hands every gate its arguments whether or not this type reads them.
   * @type {import('../../../sdk/pinboard-item-type.js').default}
   */
  const hosted = pin;
  /** @type {typeof import('../../../sdk/pinboard-item-type.js').default} */
  const HostedType = TasksPin;

  let nextId = 0;

  /**
   * One running task, as the host's tasks service reports one.
   * @param {string} command - What it is running.
   * @param {object} [overrides] - What this case cares about.
   * @returns {any} The task.
   */
  const task = (command, overrides = {}) => ({
    taskId: `bg-${++nextId}`,
    kind: 'background',
    conversationId: 'c1',
    conversationTitle: 'Fix the parser',
    toolUseId: `call_${nextId}`,
    itemId: `item_${nextId}`,
    threadId: null,
    toolName: 'bash',
    command,
    label: '',
    at: Date.now() - 5000,
    ...overrides,
  });

  /**
   * Mount the pin against a canned task list.
   * @param {any[]|null} list - What `tasks.list` should return, or null for "not asked yet".
   * @param {object} [options] - Failure levers.
   * @param {string} [options.error] - What `tasks.error` should report.
   * @param {Error} [options.stopFails] - Make `tasks.stop` reject with this.
   * @returns {any} The body, controller and the levers a test needs.
   */
  function mount(list, options = {}) {
    const body = document.createElement('div');
    document.body.appendChild(body);
    const abort = new AbortController();
    /** @type {(() => void)[]} */
    const listeners = [];
    /** @type {any[]} */
    const revealed = [];
    /** @type {string[]} */
    const stopped = [];
    let current = list;
    let error = options.error || '';

    const services = {
      files: { onChange: () => () => {} },
      contextItems: { find: () => null, onChange: () => () => {}, reveal: () => {} },
      git: { status: () => null, error: () => '', onChange: () => () => {}, refresh: async () => {} },
      tasks: {
        /** @returns {any[]|null} The running tasks. */
        list: () => current,
        /** @returns {string} The last check's failure. */
        error: () => error,
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
         * @param {any} revealedTask - The task whose action to reveal.
         * @returns {number} Ignored; push's return value.
         */
        reveal: (revealedTask) => revealed.push(revealedTask),
        /**
         * @param {string} taskId - The task to stop.
         * @returns {Promise<void>} Resolves, or rejects when the case says so.
         */
        stop: async (taskId) => {
          stopped.push(taskId);
          if (options.stopFails) throw options.stopFails;
        },
      },
    };

    const controller = /** @type {any} */ (pin.mount(body, /** @type {any} */ ({
      pin: { id: 'pin_test', type: 'tasks', config: {} },
      active: {
        project: { path: '/tmp/proj', displayName: 'proj' },
        conversation: { id: 'c1', title: 'Fix the parser' },
        thread: { id: null },
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
      stopped,
      text: () => body.textContent || '',
      rows: () => [...body.querySelectorAll('.tasks-pin__row')],
      stopButtons: () => /** @type {HTMLButtonElement[]} */ ([...body.querySelectorAll('.tasks-pin__stop')]),
      openButtons: () => /** @type {HTMLButtonElement[]} */ ([...body.querySelectorAll('.tasks-pin__open')]),
      watchers: () => listeners.length,
      /** @param {any[]|null} next - The new task list. */
      setTasks: (next) => { current = next; },
      /** @param {string} next - The new check failure. */
      setError: (next) => { error = next; },
      fireChange: () => { for (const listener of [...listeners]) listener(); },
      teardown: () => {
        try {
          controller.teardown?.();
        } finally {
          abort.abort();
          body.remove();
        }
      },
    };
  }

  // --- the manifest and its gates ------------------------------------------

  await test('the tasks pin is a singleton', () => {
    assert(!pin.allowsMultiple, 'a second copy would list the same tasks twice');
  });

  await test('the list is the project\'s, so it is addable with or without a conversation', () => {
    assert(hosted.canAdd(/** @type {any} */ ({ project: { path: '/p' }, conversation: null })) === true,
      'a project with no conversation open can still have things running');
    assert(hosted.canAdd(/** @type {any} */ ({ conversation: { id: 'c1', title: 'x' } })) === true,
      'and so can one with');
  });

  await test('the tab says what the pin is, and leaves conversations to the groups', () => {
    const described = hosted.describe({}, /** @type {any} */ ({ conversation: { id: 'c1', title: 'Fix the parser' } }));
    assert(described.title === 'Running tasks', `expected 'Running tasks', got ${described.title}`);
    assert(!described.badge && !described.subtitle,
      `each group names its own conversation, got ${JSON.stringify(described)}`);
  });

  await test('a request to show the tasks reaches this pin, and nothing else does', () => {
    assert(TasksPin.canPinSource(/** @type {any} */ ({ kind: 'tasks' })) === true, 'tasks should be pinnable');
    assert(TasksPin.canPinSource(/** @type {any} */ ({ kind: 'plan' })) === false, 'a plan is not tasks');
    assert(TasksPin.canPinSource(/** @type {any} */ (null)) === false, 'nothing is not tasks');
    const config = HostedType.configFromSource(/** @type {any} */ ({ kind: 'tasks' }));
    assert(!!config && Object.keys(config).length === 0, `expected an empty config, got ${JSON.stringify(config)}`);
  });

  // --- the three states -----------------------------------------------------

  await test('before an answer it says it is looking, not that nothing is running', () => {
    const m = mount(null);
    const text = m.text();
    assert(text.includes('Looking'), `expected the looking state:\n${text}`);
    assert(!text.includes('Nothing running'),
      `it has not asked yet, so it cannot say nothing is running:\n${text}`);
    m.teardown();
  });

  await test('an empty answer says nothing is running', () => {
    const m = mount([]);
    const text = m.text();
    assert(text.includes('Commands running in this project appear here.'),
      `expected the empty state:\n${text}`);
    assert(!text.includes('Looking'), `it has its answer now:\n${text}`);
    m.teardown();
  });

  await test('a running task gets a row showing its command', () => {
    const m = mount([task('npm run build')]);
    assert(m.rows().length === 1, `expected one row, got ${m.rows().length}`);
    assert(m.text().includes('npm run build'), `expected the command:\n${m.text()}`);
    m.teardown();
  });

  await test('every task gets its own row', () => {
    const m = mount([task('npm run build'), task('tail -f log'), task('sleep 60')]);
    assert(m.rows().length === 3, `expected three rows, got ${m.rows().length}`);
    m.teardown();
  });

  // --- groups ---------------------------------------------------------------

  await test('tasks are grouped under the conversation that started them', () => {
    const m = mount([
      task('npm run build'),
      task('make test', { conversationId: 'c2', conversationTitle: 'Release prep' }),
      task('tail -f log'),
    ]);
    const groups = [...m.body.querySelectorAll('.tasks-pin__group')];
    assert(groups.length === 2, `expected two groups, got ${groups.length}`);
    const titles = groups.map((g) => g.querySelector('.tasks-pin__title')?.textContent);
    assert(titles[0] === 'Fix the parser' && titles[1] === 'Release prep',
      `expected each conversation named in list order, got ${JSON.stringify(titles)}`);
    assert(groups[0].querySelectorAll('.tasks-pin__row').length === 2,
      'both of the first conversation\'s tasks belong in its group');
    m.teardown();
  });

  await test('the conversation being read is marked, and only it', () => {
    const m = mount([task('a'), task('b', { conversationId: 'c2', conversationTitle: 'Release prep' })]);
    const markers = /** @type {HTMLElement[]} */ ([...m.body.querySelectorAll('.tasks-pin__here')]);
    const [here, other] = markers;
    if (!here || !other) throw new Error(`expected a marker in each conversation's group, got ${markers.length}`);
    assert(!here.hidden && here.textContent === 'this conversation',
      `expected the active conversation marked, got ${JSON.stringify(here.textContent)}`);
    assert(!!other.hidden, 'another conversation must not be marked as this one');
    m.teardown();
  });

  await test('a task no conversation started is grouped as such', () => {
    const m = mount([task('dev server', { conversationId: '', conversationTitle: '' })]);
    const title = m.body.querySelector('.tasks-pin__title')?.textContent;
    assert(title === 'No conversation', `expected it said, got ${JSON.stringify(title)}`);
    m.teardown();
  });

  // --- what a row says ------------------------------------------------------

  await test('without the transcript to name its tool, how it runs is said instead', () => {
    const m = mount([task('make test', { kind: 'foreground', toolName: '' })]);
    const shown = m.body.querySelector('.tasks-pin__kind')?.textContent || '';
    assert(shown === 'foreground', `expected the kind, got ${JSON.stringify(shown)}`);
    assert(m.body.querySelector('.tasks-pin__tool') === null, 'there is no tool name to show');
    m.teardown();
  });

  await test("a monitor's label is shown beside its command", () => {
    const m = mount([task('tail -f build.log', { toolName: 'Monitor', label: 'Watching the build' })]);
    assert(m.text().includes('Watching the build'), `expected the label:\n${m.text()}`);
    m.teardown();
  });

  await test('a task with no label shows nothing in its place', () => {
    const m = mount([task('sleep 60')]);
    assert(m.body.querySelector('.tasks-pin__label') === null,
      'an absent label must not leave an empty element behind');
    m.teardown();
  });

  await test('the tool a command came from is named beside it', () => {
    const m = mount([task('npm run build', { toolName: 'bash' })]);
    const shown = m.body.querySelector('.tasks-pin__tool')?.textContent || '';
    assert(shown === 'bash', `expected the tool named, got ${JSON.stringify(shown)}`);
    m.teardown();
  });

  await test('a task with no command of its own is not made to say its tool twice', () => {
    const m = mount([task('', { toolName: 'Monitor' })]);
    const command = m.body.querySelector('.tasks-pin__command')?.textContent || '';
    assert(command === 'Monitor', `the tool stands in for the missing command, got ${JSON.stringify(command)}`);
    assert(m.body.querySelector('.tasks-pin__tool') === null,
      'and is not then repeated underneath itself');
    m.teardown();
  });

  await test('a long command is cut short rather than filling the board', () => {
    const long = `echo ${'x'.repeat(400)}`;
    const m = mount([task(long)]);
    const shown = m.body.querySelector('.tasks-pin__command')?.textContent || '';
    assert(shown.length < long.length, `expected it shortened, got ${shown.length} of ${long.length}`);
    assert(shown.endsWith('…'), `expected an ellipsis, got ${JSON.stringify(shown.slice(-8))}`);
    m.teardown();
  });

  await test('how long it has been running is shown', () => {
    const m = mount([task('sleep 60', { at: Date.now() - 90000 })]);
    const shown = m.body.querySelector('.tasks-pin__elapsed')?.textContent || '';
    assert(shown === '1m', `expected '1m' for 90 seconds, got ${JSON.stringify(shown)}`);
    m.teardown();
  });

  await test('a task too new to have a timestamp shows no elapsed time rather than nonsense', () => {
    const m = mount([task('sleep 60', { at: Infinity })]);
    assert(m.body.querySelector('.tasks-pin__elapsed') === null,
      'an unknown start time must not render as an elapsed time');
    m.teardown();
  });

  // --- reveal ---------------------------------------------------------------

  await test('a row is a real button that reveals the task it stands for', () => {
    const m = mount([task('npm run build', { taskId: 'bg-start', toolUseId: 'call_start' })]);
    const [open] = m.openButtons();
    assert(open instanceof HTMLElement && open.tagName === 'BUTTON',
      'the row must be a button, not a clickable div');
    open.click();
    assert(m.revealed.length === 1 && m.revealed[0].taskId === 'bg-start'
      && m.revealed[0].toolUseId === 'call_start' && m.revealed[0].conversationId === 'c1',
    `expected the task handed to reveal whole, got ${JSON.stringify(m.revealed)}`);
    m.teardown();
  });

  await test('each row reveals its own task, in its own conversation', () => {
    const m = mount([
      task('first', { taskId: 'bg-first' }),
      task('second', { taskId: 'bg-second', conversationId: 'c2', conversationTitle: 'Other' }),
    ]);
    m.openButtons()[1].click();
    assert(m.revealed[0].taskId === 'bg-second' && m.revealed[0].conversationId === 'c2',
      `expected the second, got ${JSON.stringify(m.revealed)}`);
    m.teardown();
  });

  await test('a click reveals the task as it is now, not as its card was built', () => {
    const m = mount([task('npm run build', { taskId: 'bg-move', threadId: null })]);
    m.setTasks([task('npm run build', { taskId: 'bg-move', threadId: 'thread_later' })]);
    m.fireChange();
    m.openButtons()[0].click();
    assert(m.revealed[0].threadId === 'thread_later',
      `expected the current task, got ${JSON.stringify(m.revealed[0])}`);
    m.teardown();
  });

  // --- stop -----------------------------------------------------------------

  await test('Stop asks the host to stop that task', async () => {
    const m = mount([task('sleep 60', { taskId: 'bg-target' }), task('sleep 90')]);
    m.stopButtons()[0].click();
    await waitFor(() => m.stopped.length > 0, 'the stop to be requested');
    assert(m.stopped[0] === 'bg-target', `expected the clicked task, got ${JSON.stringify(m.stopped)}`);
    m.teardown();
  });

  await test('a Stop in flight dims rather than inviting a second click', () => {
    const m = mount([task('sleep 60')]);
    const [button] = m.stopButtons();
    button.click();
    assert(button.disabled, 'the control must be disabled while the stop is outstanding');
    m.teardown();
  });

  await test("a Stop that fails says so and keeps the error's own words", async () => {
    const m = mount([task('sleep 60')], { stopFails: new Error('shell registry unreachable') });
    m.stopButtons()[0].click();
    await waitFor(() => m.text().includes('shell registry unreachable'), 'the failure to be reported');
    const text = m.text();
    assert(text.includes("Couldn't stop it"), `expected a plain-English lead:\n${text}`);
    // The list is still there: a stop that failed does not mean the task went.
    assert(m.rows().length === 1, 'a failed stop must not empty the list');
    m.teardown();
  });

  // --- the check failing ----------------------------------------------------

  await test('a failed check is reported with its error text, beside the last list', () => {
    const m = mount([task('npm run build')], { error: 'connection refused' });
    const text = m.text();
    assert(text.includes("Couldn't check what's running"), `expected a plain-English lead:\n${text}`);
    assert(text.includes('connection refused'), `expected the underlying error kept:\n${text}`);
    // A check that failed is not evidence the tasks stopped.
    assert(m.rows().length === 1, 'the last known list must survive a failed check');
    m.teardown();
  });

  // --- what it claims -------------------------------------------------------

  await test('it says what the list covers, even when it has something to show', () => {
    const m = mount([task('npm run build')]);
    const text = m.text();
    assert(text.includes("this project's conversations started"),
      `the pin must say whose tasks these are:\n${text}`);
    assert(text.includes('while it runs'),
      `and that a finished task is not here:\n${text}`);
    m.teardown();
  });

  await test('it says so with an empty list too, which is where the claim matters most', () => {
    const m = mount([]);
    const text = m.text();
    assert(text.includes("this project's conversations started"),
      `an empty card is the reading most likely to be over-generalised:\n${text}`);
    // A board is furnished with this tab before anything has ever run, so the
    // empty card is the one most users meet first: it has to say what it is for.
    assert(text.includes('appear here'),
      `and it must say what will appear in it:\n${text}`);
    m.teardown();
  });

  await test('no task output reaches the pin', () => {
    // The pin shows no output at all — that is the whole reason it reveals the
    // tool action instead. A row carrying output would be a new place for a
    // secret to appear, on a surface that may be open in another window.
    const m = mount([task('printenv', { output: 'AWS_SECRET_ACCESS_KEY=hunter2' })]);
    assert(!m.text().includes('hunter2'),
      `output must never reach the board:\n${m.text()}`);
    m.teardown();
  });

  // --- staying current ------------------------------------------------------

  await test('it redraws when the host says the list changed', () => {
    const m = mount([task('npm run build')]);
    assert(m.rows().length === 1, 'expected the first list');
    m.setTasks([]);
    m.fireChange();
    assert(m.text().includes('Commands running in this project appear here.'),
      `expected the empty state after the task ended:\n${m.text()}`);
    m.teardown();
  });

  await test('a task appearing shows up without a remount', () => {
    const m = mount([]);
    m.setTasks([task('npm run build')]);
    m.fireChange();
    assert(m.rows().length === 1, `expected the new task, got ${m.rows().length} rows`);
    m.teardown();
  });

  await test('update() redraws against the new context', () => {
    const m = mount([task('npm run build')]);
    m.setTasks([task('npm test'), task('npm run watch')]);
    m.controller.update({
      pin: { id: 'pin_test', type: 'tasks', config: {} },
      active: {
        project: { path: '/tmp/proj', displayName: 'proj' },
        conversation: { id: 'c2', title: 'Another' },
        thread: { id: null },
      },
      services: m.services,
      signal: new AbortController().signal,
      updateConfig: async () => {},
    });
    assert(m.rows().length === 2, `expected the new list, got ${m.rows().length} rows`);
    m.teardown();
  });

  await test('teardown stops watching', () => {
    const m = mount([task('npm run build')]);
    assert(m.watchers() === 1, `expected one watcher, got ${m.watchers()}`);
    m.teardown();
    assert(m.watchers() === 0, `expected none after teardown, got ${m.watchers()}`);
  });

  // --- en-XA ----------------------------------------------------------------

  await test('en-XA: the tab, every state, groups, row controls, kinds, elapsed times and errors are translated', async () => {
    await underPseudoLocale('tasks-pin-test', async () => {
      /** @type {Record<string, string>} */
      const shown = {};
      /**
       * Gather what a mounted body shows. Commands, tools and labels are the
       * task's own words — data — so they are left out.
       * @param {string} where - The state's name.
       * @param {HTMLElement} body - The pin's body.
       */
      const collect = (where, body) => {
        shownStrings(body, '.tasks-pin__command, .tasks-pin__tool, .tasks-pin__label, .tasks-pin__title')
          .forEach((s, i) => { shown[`${where} ${i}`] = s; });
      };

      shown['tab title'] = String(pin.describe().title);

      const looking = mount(null);
      collect('looking', looking.body);
      looking.teardown();

      const empty = mount([]);
      collect('empty', empty.body);
      empty.teardown();

      const now = Date.now();
      const running = mount([
        task('7', { toolName: '7', label: '7', conversationTitle: '7', at: now - 5000 }),
        task('7', { toolName: '7', conversationTitle: '7', at: now - 90000 }),
        task('', { toolName: '7', conversationTitle: '7', at: now - 3700000 }),
        task('7', { toolName: '', kind: 'foreground', conversationTitle: '7', at: now - 1000 }),
        task('7', { toolName: '', kind: 'python', conversationId: 'c2', conversationTitle: '', at: now - 1000 }),
        task('7', { toolName: '', conversationId: '', conversationTitle: '', at: now - 1000 }),
      ], { error: '7' });
      assert(running.body.querySelectorAll('.tasks-pin__elapsed').length === 6, 'expected six elapsed times');
      // A group's name is the conversation's — data — except where it has none,
      // and then the words standing in for it are the pin's own.
      [...running.body.querySelectorAll('.tasks-pin__title')]
        .map((el) => el.textContent || '')
        .filter((title) => title !== '7')
        .forEach((title, i) => { shown[`fallback title ${i}`] = title; });
      assert(running.body.querySelector('.tasks-pin__error'), 'expected the check error');
      collect('running', running.body);
      running.teardown();

      const failing = mount([task('7')], { stopFails: new Error('7') });
      failing.stopButtons()[0].click();
      await waitFor(() => failing.body.querySelector('.tasks-pin__error') !== null, 'the stop failure');
      collect('stop failed', failing.body);
      failing.teardown();

      assert(Object.keys(shown).length > 12, `too little was checked: ${JSON.stringify(shown)}`);
      const raw = Object.entries(shown).filter(([, s]) => !isPseudoLocalized(s));
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    }, { '@juggler/core': CORE_TEXT });
  });

  return { passed, failed, errors };
}
