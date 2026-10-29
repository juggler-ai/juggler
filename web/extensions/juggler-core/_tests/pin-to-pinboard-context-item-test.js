//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import PinToPinboardContextItem from '../context-items/pin-to-pinboard-context-item.js';
import { assert, waitFor } from '../../../js-tests/utilities/test-helpers.js';
import pinboardStore from '../../../js/services/pinboard-store.js';
import pinboardView from '../../../js/services/pinboard-view.js';
import { underPseudoLocale } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';

/** juggler-core's English for this plugin, standing in for its catalogue. */
const CORE_TEXT = [
  'Pin to Pinboard', 'pinned', 'Pinning…', 'item', 'Could not pin that', 'Show on Pinboard',
  'Type', 'unknown', 'Parameters', 'None.', 'Cancelled',
];

/**
 * Test the agent-facing contract and its realm-neutral pinboard request.
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Test name.
   * @param {() => Promise<void>|void} fn - Test body.
   * @returns {Promise<void>} Resolves after the test is recorded.
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (err) {
      failed++;
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const item = new PinToPinboardContextItem(/** @type {any} */ ({
    id: 'PIN_test',
    session: {},
    conversation: { id: 'conversation-one' },
    messageThread: {},
  }));

  await test('a card drawn before any tool list was built still names its pin', async () => {
    // A fresh copy of the module is a page that has just loaded: nothing has
    // built a tool list in it yet, so the catalog the label is read from is
    // empty while the transcript is drawn.
    const { default: Fresh } = await import(
      `../context-items/pin-to-pinboard-context-item.js?fresh=${Date.now()}`);
    const fresh = new Fresh(/** @type {any} */ ({
      id: 'PIN_fresh',
      session: {},
      conversation: { id: 'conversation-one' },
      messageThread: {},
    }));
    const path = '/tmp/brewshot/panel-1280-light.png';
    const ui = fresh.getStatusUI(/** @type {any} */ ({
      success: true,
      result: { pin: 'agent_file', type: 'file', parameters: { path } },
    }));
    const link = /** @type {HTMLElement} */ (ui.summary);
    await waitFor(() => link.textContent === path,
      () => `the card to name the file, not its pin type (it says "${link.textContent}")`);
  });

  // The tool reads the installed pin types before every tool list is built, and
  // its whole job is to name them, so nothing below means anything until it has.
  await PinToPinboardContextItem.prepareToolDefinitions();

  await test('the schema stays open to any installed pinboard item type', () => {
    const [definition] = PinToPinboardContextItem.getToolDefinitions();
    if (!definition) throw new Error('the tool should define itself');
    assert(definition.name === 'pin_to_pinboard', 'the tool should have its stable public name');
    const { type: typeSchema, parameters: parametersSchema } =
      /** @type {Record<string, Record<string, unknown>|undefined>} */ (definition.input_schema.properties);
    if (!typeSchema || !parametersSchema) throw new Error('the schema should declare type and parameters');
    assert(!typeSchema.enum,
      'type must not be a closed enum — an extension-installed type has no entry to add itself to');
    assert(parametersSchema.type === 'object',
      'parameters should accept whatever shape the requested type expects');
    assert(!parametersSchema.properties,
      'parameters must not be pinned to one type\'s shape (file\'s, or any other\'s)');
    assert(!definition.input_schema.properties.config, 'persisted pin config must not be public input');
  });

  await test('the description names every installed type, with file last', () => {
    const [definition] = PinToPinboardContextItem.getToolDefinitions();
    if (!definition) throw new Error('the tool should define itself');
    const bullets = definition.description.split('\n').filter((line) => line.startsWith('- `'));
    const ids = bullets.map((line) => line.slice(3, line.indexOf('`', 3)));

    // A model can only pick a type it has been told about. When `file` was the
    // only one named, every request became a file pin — a `.cmajorpatch` included.
    assert(ids.includes('file'), 'the description should name the file type');
    assert(ids.includes('plan') && ids.includes('git'),
      'the description should name the types that are not file, or the model cannot choose them');
    assert(ids[ids.length - 1] === 'file',
      'file is the fallback and must be listed last, so a narrower type is read first');

    assert(/`path`\s*\(string, required\)/.test(definition.description),
      'each type should carry its own parameters, not a shared prose paragraph');
    assert(definition.description.includes('No parameters.'),
      'a type that takes nothing should say so, rather than leaving the model to guess');
  });

  await test('validation dispatches to the selected type', async () => {
    /**
     * @param {import('juggler/context-item').ValidationResult} result - A validation result.
     * @returns {Record<string, unknown>|undefined} Its normalized `parameters`, when an object.
     */
    const parametersOf = (result) => {
      const parameters = result.params?.parameters;
      return parameters && typeof parameters === 'object'
        ? /** @type {Record<string, unknown>} */ (parameters) : undefined;
    };
    assert(!(await item.validate({ type: '', parameters: { url: 'http://localhost:3000' } })).valid,
      'a missing type should be rejected');
    assert(!(await item.validate({ type: 'not-installed-here', parameters: 'not-an-object' })).valid,
      'a type\'s parameters must still be an object');
    const generic = await item.validate({ type: 'not-installed-here', parameters: { url: 'http://localhost:3000' } });
    assert(generic.valid, 'a type installed after the catalog was read should still be accepted');
    assert(parametersOf(generic)?.url === 'http://localhost:3000',
      'a type with no descriptor should have its parameters forwarded unchanged');
    assert(!(await item.validate({ type: 'file', parameters: {} })).valid,
      'file parameters need a path');
    const valid = await item.validate({ type: 'file', parameters: { path: ' ./docs//report.html ' } });
    assert(valid.valid, 'a file path should be accepted');
    assert(parametersOf(valid)?.path === 'docs/report.html', 'the file adapter should normalize its path');
  });

  await test('execute adds idempotently and requests an attributed reveal', async () => {
    const originalFetch = globalThis.fetch;
    /** @type {any} */
    let requestBody = null;
    globalThis.fetch = /** @type {any} */ (async (/** @type {unknown} */ _url, /** @type {{body: string}} */ options) => {
      requestBody = JSON.parse(options.body);
      const op = requestBody.operations[0];
      return { ok: true, json: async () => ({ pins: [{ id: op.id, type: op.type, config: op.config }] }) };
    });
    try {
      const params = { type: 'file', parameters: { path: 'docs/report.html' } };
      const first = await item.execute(params);
      const firstID = first.pin;
      await item.execute(params);
      assert(requestBody.operations[0].id === firstID, 'the same request should mint the same pin id');
      assert(requestBody.operations[0].type === 'file', 'the adapter should select the File pin');
      assert(requestBody.operations.length === 2 && requestBody.operations[1].op === 'update',
        'an idempotent retry should restore the expected config');
      assert(requestBody.operations[0].config.path === 'docs/report.html', 'the adapter should produce File config');
      assert(requestBody.operations[0].config.agentRequested === true,
        'the File pin should preserve that its path did not come from a user gesture');
      assert(requestBody.reveal.pin === firstID, 'the added pin should be the one requested for reveal');
      assert(requestBody.reveal.from === 'conversation-one', 'the reveal should be attributed to its conversation');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // A type with no descriptor: the id is deliberately one no extension can install,
  // so this stays the "unknown type" path on a machine with extra extensions.
  await test('execute forwards an undescribed type\'s own parameters as its config', async () => {
    const originalFetch = globalThis.fetch;
    /** @type {any} */
    let requestBody = null;
    globalThis.fetch = /** @type {any} */ (async (/** @type {unknown} */ _url, /** @type {{body: string}} */ options) => {
      requestBody = JSON.parse(options.body);
      const op = requestBody.operations[0];
      return { ok: true, json: async () => ({ pins: [{ id: op.id, type: op.type, config: op.config }] }) };
    });
    try {
      const result = await item.execute({ type: 'not-installed-here', parameters: { thing: 'synths/pluck' } });
      assert(requestBody.operations[0].type === 'not-installed-here', 'a type with no descriptor should still be selected');
      assert(requestBody.operations[0].config.thing === 'synths/pluck',
        'that type\'s own parameters should reach it unexamined — its normalizeConfig validates them, not this tool');
      assert(requestBody.operations[0].config.agentRequested === true,
        'an undescribed type\'s pin should still be marked as agent-requested');
      assert(result.type === 'not-installed-here', 'execute should report back the requested type');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test('a past call offers no Re-run', () => {
    assert(PinToPinboardContextItem.isRerunnable() === false,
      're-running asks for the pin the call already made, so the control would do nothing');
  });

  /**
   * Run `fn` against a board the fake server holds, with a clean viewer state
   * either side, capturing every batch of operations sent.
   * @param {Array<{id: string, type: string, config: Record<string, any>}>} board - Starting pins.
   * @param {(sent: any[][]) => Promise<void>} fn - The test body.
   * @returns {Promise<void>} Resolves when done.
   */
  async function withBoard(board, fn) {
    const originalFetch = globalThis.fetch;
    /** @type {any[]} */
    let pins = board.map((pin) => ({ ...pin }));
    /** @type {any[][]} */
    const sent = [];
    globalThis.fetch = /** @type {any} */ (async (/** @type {unknown} */ _url, /** @type {{body?: string}|undefined} */ options) => {
      const body = options?.body ? JSON.parse(options.body) : null;
      if (body?.operations) {
        sent.push(body.operations);
        for (const op of body.operations) {
          if (op.op === 'add' && !pins.some((pin) => pin.id === op.id)) {
            pins = [...pins, { id: op.id, type: op.type, config: op.config }];
          }
        }
      }
      return { ok: true, json: async () => ({ pins }) };
    });
    pinboardStore.reset();
    pinboardView.reset();
    try {
      await pinboardStore.load();
      sent.length = 0;
      await fn(sent);
    } finally {
      globalThis.fetch = originalFetch;
      pinboardStore.reset();
      pinboardView.reset();
    }
  }

  const made = { pin: 'agent_made', type: 'not-installed-here', parameters: { thing: 'synths/pluck' } };
  const madeConfig = { thing: 'synths/pluck', agentRequested: true };

  await test('the card\'s label opens the Pinboard on the pin', async () => {
    await withBoard([{ id: 'other', type: 'git', config: {} }, { id: made.pin, type: made.type, config: madeConfig }], async (sent) => {
      const ui = item.getStatusUI(/** @type {any} */ ({ success: true, result: made }));
      const link = /** @type {HTMLElement} */ (ui.summary);
      assert(link instanceof HTMLElement && link.tagName === 'BUTTON',
        'the label should be a button, so the conversation treats a click on it as a control');
      assert(link.textContent === made.type, 'the link should still read as the pin\'s label');
      link.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert(pinboardView.isOpen(), 'clicking the label should open the Pinboard');
      assert(pinboardView.getActivePinId() === made.pin, 'and select the pin the call made');
      assert(sent.length === 0, 'a pin still on the board should be revealed, not added again');
    });
  });

  await test('showing a pin the user removed puts it back under the same id', async () => {
    await withBoard([], async (sent) => {
      const ui = item.getStatusUI(/** @type {any} */ ({ success: true, result: made }));
      /** @type {HTMLElement} */ (ui.summary).click();
      await waitFor(() => pinboardView.isOpen(), 'the Pinboard to open on the restored pin');
      const [add] = sent.flat();
      assert(add?.op === 'add' && add.id === made.pin && add.type === made.type,
        'the pin should be restored with its own id, so the next click finds it');
      assert(JSON.stringify(add.config) === JSON.stringify(madeConfig),
        'and with the config the agent made it with, agentRequested included');
      assert(pinboardView.getActivePinId() === made.pin, 'the restored pin should be the one shown');
    });
  });

  await test('the properties panel offers Show on Pinboard for a pin that was made', async () => {
    const wrapper = document.createElement('div');
    const toolAction = { get: (/** @type {string} */ key) => (key === 'result' ? { fullResult: { result: made } } : null) };
    const out = item.renderToolActionDetails(wrapper, /** @type {any} */ ({
      input: { type: made.type, parameters: made.parameters },
      helpers: { addSubsection: () => {} },
      toolAction,
    }));
    const [control] = out.controls;
    assert(!!control?.textContent?.includes('Show on Pinboard'), 'the panel should carry a Show on Pinboard control');

    const unmade = item.renderToolActionDetails(wrapper, /** @type {any} */ ({
      input: { type: made.type, parameters: made.parameters },
      helpers: { addSubsection: () => {} },
      toolAction: { get: () => ({ isError: true, fullResult: {} }) },
    }));
    assert(unmade.controls.length === 0, 'a call that made no pin has nothing to show');
  });

  // What the tool shows the user is translated; what the model reads is not.
  // Types, ids and errors are digits, so they read as data inside a message.
  await test('en-XA: every row state, the link and the panel are translated; the model\'s text stays English', async () => {
    await underPseudoLocale('pin-to-pinboard-test', async () => {
      /** @type {Record<string, string>} */
      const shown = {};
      /**
       * @param {string} name
       * @param {any} ui
       */
      const row = (name, ui) => {
        shown[`${name} row`] = String(ui?.summary);
        shown[`${name} type name`] = String(ui?.typeName);
      };
      row('unstarted', item.getStatusUI(null));
      row('pending', item.getStatusUI(/** @type {any} */ ({ pending: true })));
      row('done, nothing named', item.getStatusUI(/** @type {any} */ ({ success: true, result: {} })));
      row('failed', item.getStatusUI(/** @type {any} */ ({ success: false, error: '9' })));
      row('cancelled', item.getStatusUI(/** @type {any} */ ({ success: false, cancelled: true })));
      shown['type name (static)'] = PinToPinboardContextItem.getTypeName();

      // The link's text is the pin's own label (data); its tooltip is ours.
      const linked = item.getStatusUI(/** @type {any} */ ({ success: true, result: { pin: 'agent_1', type: '2', parameters: {} } }));
      shown['linked type name'] = String(linked.typeName);
      shown['link tooltip'] = /** @type {HTMLElement} */ (linked.summary).title;

      // The panel with no type and no parameters draws only our own words.
      const wrapper = document.createElement('div');
      item.renderToolActionDetails(wrapper, /** @type {any} */ ({
        input: { type: '', parameters: {} },
        helpers: {
          addSubsection: (/** @type {any} */ _w, /** @type {string} */ label, /** @type {string} */ text) => {
            shown[`panel heading ${label}`] = label;
            shown[`panel body under ${label}`] = text;
          },
        },
        toolAction: { get: () => null },
      }));

      const raw = Object.entries(shown).filter(([, s]) => !isPseudoLocalized(s));
      assert(!raw.length, `plain English under en-XA: ${JSON.stringify(Object.fromEntries(raw))}`);
      assert(String(shown['failed row']).includes('9'), 'the failed row should still carry the model\'s error');

      // The model's text is unchanged English under any UI language.
      const pinned = item.getSummary(/** @type {any} */ ({ success: true, result: {} }));
      assert(pinned.summary === 'Pinned the item and asked the user’s Pinboard to show it.',
        `the model's result changed: ${JSON.stringify(pinned.summary)}`);
      const notPinned = item.getSummary(/** @type {any} */ ({ success: false }));
      assert(notPinned.summary.includes('Could not pin that'), `the model's failure changed: ${JSON.stringify(notPinned.summary)}`);
      const invalid = await item.validate({ type: '' });
      assert(invalid.error === 'Which pin type? Name one of the installed types.',
        `the model's validation error changed: ${JSON.stringify(invalid.error)}`);
    }, { '@juggler/core': CORE_TEXT });
  });

  return { passed, failed, errors };
}
