//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The error row's Provider settings offer, which appears only on a failure the
 * worker classified as an authentication or setup problem, and its Choose
 * another model offer, which only a setup problem (a provider that can't run on
 * this machine) carries.
 *
 * The classification is the worker's (`data.errorKind`) and the row only reads
 * the verdict — matching on the error text here would put the taxonomy in two
 * places and let them disagree. Unlike Retry the offer is not gated on the error
 * being last: opening settings can never damage a transcript, and the fix for an
 * expired sign-in is somewhere else entirely, which is exactly what a first-time
 * reader of one of these errors does not know.
 * @module unit-tests/auth-error-action-test
 */

import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale, assertPseudoLocalized } from '../utilities/pseudo-locale.js';
import '../../js/components/error-message.js';
import { registerSettingsOpener } from '../../js/services/settings-launcher.js';
import {
  buildElementMap,
  identifyElementsToKeep,
  removeDeletedElements,
  positionElements,
} from '../../js/components/conversation-area-rendering.js';

/**
 * A plain-object stand-in for a conversation item Y.Map.
 * @param {Record<string, any>} fields - The item's fields
 * @returns {{get: (key: string) => any}} A Y.Map-shaped item
 */
function item(fields) {
  return { get: (key) => fields[key] };
}

/**
 * An error item carrying the worker's `data` blob as a JSON string, which is one
 * of the shapes it genuinely arrives in.
 * @param {string} id - Item id
 * @param {Record<string, any>|null} data - The item's data blob, or null for none
 * @returns {{get: (key: string) => any}} A Y.Map-shaped error item
 */
function errorItem(id, data) {
  return item({
    itemId: id,
    type: 'error',
    content: `boom ${id}`,
    data: data ? JSON.stringify(data) : undefined,
  });
}

/** An auth failure exactly as the worker now reports one. */
const AUTH_DATA = { provider: 'claudecode', model: 'sonnet', duration: 1200, errorKind: 'auth' };

/** A provider that cannot run on this machine, as the worker reports one. */
const SETUP_DATA = { provider: 'claudecode', model: 'sonnet', duration: 3, errorKind: 'setup' };

/**
 * A `model-selector` that only counts opens. Its `open` is an own property, so
 * it shadows the real component's method whether or not that is defined here.
 * @returns {HTMLElement & {opened: number}} The stand-in selector
 */
function fakeSelector() {
  const el = /** @type {any} */ (document.createElement('model-selector'));
  el.opened = 0;
  el.open = () => { el.opened++; };
  return el;
}

/**
 * Mount a message list with the trailing managed non-item the diff positions
 * against.
 * @param {HTMLElement} [parent] - Where to mount it; the document body by default
 * @returns {{list: HTMLElement, render: (items: any[]) => void, teardown: () => void}} The mounted list and a render pass over it
 */
function mountList(parent) {
  const list = document.createElement('div');
  const anchor = document.createElement('div');
  anchor.className = 'thread-result-final';
  list.appendChild(anchor);
  if (parent && !parent.isConnected) document.body.appendChild(parent);
  (parent || document.body).appendChild(list);

  return {
    list,
    render(items) {
      const currentElements = buildElementMap(list);
      removeDeletedElements(currentElements, identifyElementsToKeep(items, currentElements));
      positionElements(null, list, anchor, items, currentElements);
    },
    teardown() {
      list.remove();
    },
  };
}

/**
 * @param {HTMLElement} list - The mounted message list
 * @param {string} id - Item id
 * @param {string} cls - Action button class
 * @returns {HTMLElement|null} That action's button on the row, if it has one
 */
function actionButton(list, id, cls) {
  return list.querySelector(`error-message[message-id="${id}"] .${cls}`);
}

/**
 * Run auth error action tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test counts and errors
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * Run one test case and collect its outcome.
   * @param {string} name - Test case name
   * @param {() => void} fn - Test case body
   */
  function test(name, fn) {
    try { fn(); passed++; }
    catch (e) { failed++; errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  }

  test('an auth failure offers Provider settings', () => {
    const { list, render, teardown } = mountList();
    try {
      render([errorItem('ERR_AUTH', AUTH_DATA)]);
      const btn = actionButton(list, 'ERR_AUTH', 'error-settings-btn');
      assert(!!btn, 'an authentication failure must offer the settings that fix it');
      assert(!!btn.textContent,
        `the action must be labelled, got ${btn.textContent}`);
    } finally {
      teardown();
    }
  });

  test('an ordinary failure does not', () => {
    const { list, render, teardown } = mountList();
    try {
      // Same shape, no classification: the row must not guess from the text.
      render([errorItem('ERR_PLAIN', { provider: 'claudecode', duration: 12 })]);
      assert(!actionButton(list, 'ERR_PLAIN', 'error-settings-btn'),
        'an unclassified failure has no reason to send anyone to settings');
      assert(!!actionButton(list, 'ERR_PLAIN', 'error-retry-btn'),
        'precondition: an ordinary last-item error still offers Retry');
    } finally {
      teardown();
    }
  });

  test('an error with no data at all is handled', () => {
    const { list, render, teardown } = mountList();
    try {
      render([errorItem('ERR_BARE', null)]);
      assert(!actionButton(list, 'ERR_BARE', 'error-settings-btn'),
        'an error carrying no data must render without one');
    } finally {
      teardown();
    }
  });

  test('settings reads before Retry', () => {
    const { list, render, teardown } = mountList();
    try {
      render([errorItem('ERR_AUTH', AUTH_DATA)]);
      const row = list.querySelector('error-message[message-id="ERR_AUTH"] .error-message-actions');
      assert(!!row, 'the action row must exist');
      const classes = Array.from(row.children).map((c) => c.className);
      // Retrying an expired sign-in only reproduces it, so the action that
      // actually fixes the cause has to come first.
      assert(classes[0].includes('error-settings-btn'),
        `settings must lead the action row, got ${JSON.stringify(classes)}`);
      assert(classes[1].includes('error-retry-btn'),
        `retry must follow it, got ${JSON.stringify(classes)}`);
    } finally {
      teardown();
    }
  });

  test('the offer survives the error no longer being last', () => {
    const { list, render, teardown } = mountList();
    try {
      render([errorItem('ERR_AUTH', AUTH_DATA)]);
      assert(!!actionButton(list, 'ERR_AUTH', 'error-retry-btn'),
        'precondition: the auth error starts out last');

      render([errorItem('ERR_AUTH', AUTH_DATA), errorItem('ERR_2', null)]);
      assert(!actionButton(list, 'ERR_AUTH', 'error-retry-btn'),
        'Retry withdraws once the conversation has moved past the error');
      assert(!!actionButton(list, 'ERR_AUTH', 'error-settings-btn'),
        'the sign-in still needs fixing wherever the error sits');
    } finally {
      teardown();
    }
  });

  test('pressing it opens the providers tab', () => {
    const { list, render, teardown } = mountList();
    /** @type {string[]} */
    const opened = [];
    const restore = registerSettingsOpener((tab) => { opened.push(tab || ''); });
    try {
      render([errorItem('ERR_AUTH', AUTH_DATA)]);
      const btn = actionButton(list, 'ERR_AUTH', 'error-settings-btn');
      assert(!!btn, 'precondition: the action is present');
      btn.click();
      assert(opened.length === 1, `expected one settings open, got ${opened.length}`);
      assert(opened[0] === 'providers',
        `settings must open on the providers tab, got ${JSON.stringify(opened[0])}`);
    } finally {
      restore();
      teardown();
    }
  });

  test('a setup failure offers another model, then settings, then Retry', () => {
    const { list, render, teardown } = mountList();
    try {
      render([errorItem('ERR_SETUP', SETUP_DATA)]);
      const row = list.querySelector('error-message[message-id="ERR_SETUP"] .error-message-actions');
      assert(!!row, 'a setup failure must carry an action row');
      const classes = Array.from(row.children).map((c) => c.className);
      // A missing install reads to a new user as "Juggler needs this", so the
      // way round it has to read first, before the way to fix it.
      assert(classes[0]?.includes('error-model-btn'),
        `choosing another model must lead, got ${JSON.stringify(classes)}`);
      assert(classes[1]?.includes('error-settings-btn'),
        `settings must follow it, got ${JSON.stringify(classes)}`);
      assert(classes[2]?.includes('error-retry-btn'),
        `retry comes last, got ${JSON.stringify(classes)}`);
      const btn = actionButton(list, 'ERR_SETUP', 'error-model-btn');
      assert(!!btn?.textContent,
        `the action must be labelled, got ${btn?.textContent}`);
    } finally {
      teardown();
    }
  });

  test('neither an auth nor an ordinary failure offers another model', () => {
    const { list, render, teardown } = mountList();
    try {
      render([errorItem('ERR_AUTH', AUTH_DATA), errorItem('ERR_PLAIN', { provider: 'openai', duration: 12 })]);
      assert(!actionButton(list, 'ERR_AUTH', 'error-model-btn'), 'an auth failure keeps its own actions');
      assert(!actionButton(list, 'ERR_PLAIN', 'error-model-btn'), 'an unclassified failure has no reason to');
    } finally {
      teardown();
    }
  });

  test('the setup offers survive the error no longer being last', () => {
    const { list, render, teardown } = mountList();
    try {
      render([errorItem('ERR_SETUP', SETUP_DATA), errorItem('ERR_2', null)]);
      assert(!!actionButton(list, 'ERR_SETUP', 'error-model-btn'), 'another model is still the way round it');
      assert(!!actionButton(list, 'ERR_SETUP', 'error-settings-btn'), 'settings still fixes it');
    } finally {
      teardown();
    }
  });

  test('choosing another model opens the picker in the error\'s own column', () => {
    // Two columns, each with its own selector, as a sub-thread beside its parent
    // has. The row must open the one that drives the model it failed on.
    const elsewhere = document.createElement('div');
    const otherSelector = fakeSelector();
    elsewhere.appendChild(otherSelector);
    document.body.appendChild(elsewhere);

    const column = document.createElement('div');
    const ownSelector = fakeSelector();
    const { list, render, teardown } = mountList(column);
    column.appendChild(ownSelector);
    try {
      render([errorItem('ERR_SETUP', SETUP_DATA)]);
      const btn = actionButton(list, 'ERR_SETUP', 'error-model-btn');
      assert(!!btn, 'precondition: the action is present');
      btn.click();
      assert(ownSelector.opened === 1, `the column's own picker must open once, got ${ownSelector.opened}`);
      assert(otherSelector.opened === 0, `another column's picker must stay shut, got ${otherSelector.opened}`);
    } finally {
      teardown();
      column.remove();
      elsewhere.remove();
    }
  });

  test('choosing another model never reaches for a picker outside the error\'s own tab', () => {
    // A row whose column has no selector of its own must not go looking through
    // the whole document: whichever picker it found there drives some other
    // conversation's model.
    const elsewhere = document.createElement('div');
    const otherSelector = fakeSelector();
    elsewhere.appendChild(otherSelector);
    document.body.appendChild(elsewhere);

    const column = document.createElement('div');
    const { list, render, teardown } = mountList(column);
    try {
      render([errorItem('ERR_SETUP', SETUP_DATA)]);
      const btn = actionButton(list, 'ERR_SETUP', 'error-model-btn');
      assert(!!btn, 'precondition: the action is present');
      btn.click();
      assert(otherSelector.opened === 0,
        `a picker outside the row's own conversation must stay shut, got ${otherSelector.opened}`);
    } finally {
      teardown();
      column.remove();
      elsewhere.remove();
    }
  });

  // Under en-XA everything the row adds to the provider's text is translated:
  // the unreachable lead and every action. The provider's text is data.
  try {
    await underPseudoLocale('auth-error-action-test', () => {
      const { list, render, teardown } = mountList();
      try {
        const unreachable = item({ itemId: 'ERR_NET', type: 'error', content: 'dial tcp: connection refused',
          data: JSON.stringify(SETUP_DATA) });
        render([unreachable]);
        const row = /** @type {Element} */ (list.querySelector('error-message[message-id="ERR_NET"]'));
        assert(!!row.querySelector('.error-message-lead'), 'no unreachable lead');
        for (const cls of ['error-model-btn', 'error-settings-btn', 'error-retry-btn']) {
          assert(!!actionButton(list, 'ERR_NET', cls), `no ${cls}`);
        }
        assertPseudoLocalized(row, { skip: '.message-text', atLeast: 7, where: 'unreachable setup failure, last' });
      } finally {
        teardown();
      }
    });
    passed++;
  } catch (e) {
    failed++;
    errors.push(`en-XA: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
