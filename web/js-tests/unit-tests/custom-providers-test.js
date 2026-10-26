//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Custom providers: the user's own named endpoints, each registered as its own
 * provider id.
 *
 * Two halves of one story. The first is what a conversation does when the
 * provider it names has been deleted — a state only custom providers can reach,
 * since a built-in never disappears. The second is the card that configures one,
 * which sits in the Providers tab among the built-in providers because that is
 * what an endpoint is.
 * @module unit-tests/custom-providers-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import { budgetFor } from '../utilities/test-deadline.js';
import '../../js/components/model-selector.js';
import {
  deriveEndpointId,
  buildEndpointCard,
  buildAddEndpointForm,
} from '../../js/components/settings/custom-endpoint-card.js';
import { ProvidersTab } from '../../js/components/settings/providers-tab.js';
import wsService from '../../js/services/websocket.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { underPseudoLocale, assertPseudoLocalized, shownStrings } from '../utilities/pseudo-locale.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Failure messages.
 */

/** The id rule the server enforces, restated so the tests check against it. */
const SERVER_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * A connected selector holding one live custom endpoint, with network and
 * background refresh work disabled.
 * @returns {any} Connected model selector.
 */
function makeSelector() {
  const el = /** @type {any} */ (document.createElement('model-selector'));
  el.fetchProviders = async () => {};
  el._refreshProvidersInBackground = () => {};
  el.providers = [{
    name: 'custom-keep',
    displayName: 'Keeper',
    available: true,
    modelsWithContext: [{ id: 'm2', displayName: 'Model Two', contextWindow: 1000 }],
  }];
  el.conversation = { setModelConfig: (/** @type {any} */ config) => { el._written = config; } };
  document.body.appendChild(el);
  return el;
}

/**
 * Run fn with window.showModal replaced, returning whatever it was asked to
 * present (null when it was never called).
 * @param {() => Promise<void>} fn - The action under test.
 * @param {boolean} [answer] - What to answer the dialog with.
 * @returns {Promise<any>} The options the dialog was asked for, or null.
 */
async function captureDialog(fn, answer = false) {
  /** @type {any} */
  let asked = null;
  const original = /** @type {any} */ (window).showModal;
  /** @type {any} */ (window).showModal = async (/** @type {any} */ options) => {
    asked = options;
    return answer;
  };
  try {
    await fn();
  } finally {
    /** @type {any} */ (window).showModal = original;
  }
  return asked;
}

/**
 * Replace window.showModal for as long as the caller needs it, recording what it
 * was asked to present. Unlike captureDialog, this outlives the call that opens
 * the dialog — a click handler asks for one several awaits later.
 * @param {boolean} answer - What to answer with.
 * @returns {{asked: any, restore: () => void}} The record, and the way back.
 */
function stubModal(answer) {
  const original = /** @type {any} */ (window).showModal;
  const record = {
    /** @type {any} */
    asked: null,
    restore: () => { /** @type {any} */ (window).showModal = original; },
  };
  /** @type {any} */ (window).showModal = async (/** @type {any} */ options) => {
    record.asked = options;
    return answer;
  };
  return record;
}

/**
 * One endpoint as the list operation reports it, overridable per test.
 * @param {object} [over] - Fields to change.
 * @returns {any} The endpoint row.
 */
function endpoint(over = {}) {
  return {
    id: 'acme',
    providerId: 'custom-acme',
    displayName: 'Acme Gateway',
    url: 'https://gateway.acme.test/v1',
    headers: {},
    enabled: true,
    registered: true,
    hasKey: false,
    keySource: '',
    envVarName: 'CUSTOM_ACME_API_KEY',
    ...over,
  };
}

/**
 * Mount a card with the ops layer stubbed at fetch, so what is asserted is the
 * request the card actually posts.
 * @param {any} row - The endpoint to draw.
 * @param {object} [opts] - Scenario knobs.
 * @param {any} [opts.provider] - The published provider status, when it registered.
 * @returns {{card: HTMLElement, ops: any[], applied: any[], restore: () => void}}
 *   The mounted card, the operations posted, the lists handed back to the tab.
 */
function mountCard(row, { provider } = {}) {
  /** @type {any[]} */
  const ops = [];
  /** @type {any[]} */
  const applied = [];
  const originalFetch = window.fetch;
  window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
    const body = init && init.body ? JSON.parse(String(init.body)) : null;
    if (String(url).includes('/api/ops/call')) ops.push(body);
    return { ok: true, status: 200, json: async () => ({ success: true, data: { endpoints: [] } }) };
  });

  const built = buildEndpointCard(row, {
    providerFor: () => provider,
    // Stands in for the shared model list every provider card gets — what
    // matters here is that the card asks for it, not what it builds.
    modelRow: (p) => {
      const el = document.createElement('div');
      el.className = 'model-visibility';
      el.dataset.provider = p.name;
      return el;
    },
    applyEndpoints: (endpoints) => { applied.push({ endpoints }); },
    refreshProviders: async () => {},
    onRemoved: (endpoints) => { applied.push({ endpoints, removed: true }); },
    reportError: () => {},
  });
  const card = built.element;
  document.body.appendChild(card);

  return {
    card,
    ops,
    applied,
    restore: () => {
      window.fetch = originalFetch;
      card.remove();
    },
  };
}

/**
 * Mount a real ProvidersTab over a fake host, with the ops layer stubbed at
 * fetch and a scroller whose position can be read back.
 * @param {any[]} endpoints - What the list operation answers with.
 * @returns {{tab: any, host: any, scrollWrites: number[], ops: any[], restore: () => void}}
 *   The tab, its host, anything written to the scroller, and the operations posted.
 */
function mountTab(endpoints) {
  const host = /** @type {any} */ (document.createElement('div'));
  const scroller = document.createElement('div');
  scroller.className = 'settings-content';
  let top = 0;
  /** @type {number[]} */
  const scrollWrites = [];
  // Records anything written to the scroll offset. Nothing should be: a save
  // that replaces no DOM has no position to save and restore, and code that felt
  // the need to would be evidence it had torn something down.
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => top,
    set: (/** @type {number} */ v) => { top = v; scrollWrites.push(v); },
    configurable: true,
  });
  scroller.innerHTML = '<div id="provider-fields-container"></div>';
  host.appendChild(scroller);
  document.body.appendChild(host);

  const providers = [
    { name: 'anthropic', displayName: 'Anthropic', configKeyName: 'anthropic_api_key', modelsWithContext: [] },
    { name: 'custom-acme', displayName: 'Acme Gateway', configKeyName: 'custom_acme_api_key', available: true, modelsWithContext: [{ id: 'm1', contextWindow: 1000, maxOutputTokens: 100 }] },
  ];

  /** @type {any[]} */
  const ops = [];
  let listed = endpoints;
  const originalFetch = window.fetch;
  window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
    const body = init && init.body ? JSON.parse(String(init.body)) : null;
    if (String(url).includes('/api/ops/call')) {
      ops.push(body);
      if (body.operation === 'remove') listed = listed.filter(e => e.id !== body.params.id);
      if (body.operation === 'save') {
        // What the server answers with: the entry as stored, and — since an
        // endpoint that is switched off is unregistered — whether it registered.
        listed = listed.map(e => (e.id === body.params.id
          ? { ...e, ...body.params, registered: (body.params.enabled ?? e.enabled) !== false }
          : e));
      }
      if (body.operation === 'setKey') {
        listed = listed.map(e => ({ ...e, hasKey: !!body.params.apiKey, keySource: body.params.apiKey ? 'credentials' : '' }));
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: { endpoints: listed } }) };
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) };
  });

  const tab = new ProvidersTab(host);
  // The shell's own loadConfig: re-reads config and providers, and rebuilds the
  // fields only when asked to.
  host.loadConfig = async (/** @type {boolean} */ renderFields = true) => {
    tab.onConfigLoaded({ config: { keys: {} }, providers }, renderFields);
    return true;
  };
  tab.onConfigLoaded({ config: { keys: {} }, providers }, true);

  return {
    tab,
    host,
    scrollWrites,
    ops,
    restore: () => {
      window.fetch = originalFetch;
      host.remove();
    },
  };
}

/**
 * @param {HTMLElement} root - Where to look.
 * @param {string} className - The input's hook class.
 * @returns {HTMLInputElement} The input.
 */
function input(root, className) {
  const el = /** @type {HTMLInputElement|null} */ (root.querySelector(`.${className}`));
  assert(!!el, `no .${className} on the card`);
  return el;
}

/**
 * Type into a field and leave it, which is when the card saves.
 * @param {HTMLElement} root - Where to look.
 * @param {string} className - The input's hook class.
 * @param {string} value - What to type.
 */
function typeAndLeave(root, className, value) {
  const el = input(root, className);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('blur'));
}

/**
 * Wait for an operation to have been posted.
 * @param {any[]} ops - The recorded posts.
 * @param {string} operation - The operation name to wait for.
 * @returns {Promise<any>} The recorded post.
 */
async function awaitOp(ops, operation) {
  await waitFor(() => ops.some(c => c && c.operation === operation), {
    timeoutMs: budgetFor(2000),
    description: `a ${operation} operation to be posted`,
  });
  return ops.find(c => c.operation === operation);
}

/**
 * @param {object} _ctx
 * @returns {Promise<TestResult>} Aggregated test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => void|Promise<void>} fn
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

  await run('a model whose provider has been deleted says so', async () => {
    const el = makeSelector();
    try {
      const asked = await captureDialog(async () => {
        await el.selectProviderAndModel('custom-gone', 'm1');
      });
      assert(!!asked, 'selecting a model from a deleted provider must report it, not fail silently');
      assert(asked.title === 'Problem selecting model',
        `dialog title was "${asked.title}"`);
      assert(String(asked.message).includes('custom-gone'),
        `the message must name the provider that is missing — got "${asked.message}"`);
      assert(asked.confirmText === 'Go to provider settings',
        `the way out must be the settings offer — got "${asked.confirmText}"`);
      assert(el._written === undefined, 'nothing may be written for a provider that does not exist');
    } finally {
      el.remove();
    }
  });

  await run('a model on a live provider is selected without a word', async () => {
    const el = makeSelector();
    try {
      const asked = await captureDialog(async () => {
        await el.selectProviderAndModel('custom-keep', 'm2');
      });
      assert(!asked, 'an ordinary selection must not present a dialog');
      assert(el._written && el._written.provider === 'custom-keep' && el._written.model === 'm2',
        `the selection must reach the conversation — got ${JSON.stringify(el._written)}`);
    } finally {
      el.remove();
    }
  });

  await run('an endpoint is configured in one card, in the same grammar as every other provider', () => {
    const { card, restore } = mountCard(endpoint(), {
      provider: { name: 'custom-acme', displayName: 'Acme Gateway', available: true, modelsWithContext: [{ id: 'm1' }] },
    });
    try {
      // The same card as a built-in provider's, or it does not belong in the tab
      // it now sits in.
      assert(card.classList.contains('provider-field') && card.classList.contains('settings-group'),
        `the card is ${card.className} — a provider card is a settings-group provider-field`);
      assert(!card.querySelector('[class*="mcp-"]'),
        'the card is wearing MCP server-manager classes, which is what made it look like a different app');

      assert(input(card, 'custom-endpoint-url-input').value === 'https://gateway.acme.test/v1',
        'the base URL is not on the card');
      assert(input(card, 'custom-endpoint-name-input').value === 'Acme Gateway', 'the name is not on the card');
      assert(!!card.querySelector('.custom-endpoint-key-input'), 'the API key is not on the card');
      assert(!!card.querySelector('.model-visibility'),
        'the models, and their limits, are configured somewhere other than the endpoint they belong to');
      assert(!!card.querySelector('.custom-endpoint-remove'), 'there is no way to remove the endpoint');

      // The model list spans the card, like every provider card's, rather than
      // squeezing long model ids into the control column; Remove stays under it.
      const children = Array.from(card.children).map(c => c.className);
      const at = (/** @type {string} */ cls) => children.findIndex(c => c.split(' ').includes(cls));
      assert(at('custom-endpoint-models') > at('provider-control') && at('provider-control') >= 0
        && at('custom-endpoint-actions') > at('custom-endpoint-models'),
      `the card's children are ${JSON.stringify(children)} — want the model list, then Remove, after the two columns`);

      // The provider id is shown, and is not a field: it cannot be edited,
      // because every conversation and every stored model choice names it.
      const id = card.querySelector('.custom-endpoint-id');
      assert(!!id && id.textContent === 'custom-acme', `the provider id reads "${id?.textContent}"`);
      assert(id?.tagName !== 'INPUT', 'the permanent provider id is offered as an editable field');
      assert(card.querySelectorAll('input[type="text"]:not([disabled])').length >= 2,
        'the card has no editable fields at all');
    } finally {
      restore();
    }
  });

  await run('an endpoint is configured in one place, not two', async () => {
    const host = /** @type {any} */ (document.createElement('div'));
    host.innerHTML = '<div id="provider-fields-container"></div>';
    host.loadConfig = async () => {};
    document.body.appendChild(host);

    const originalFetch = window.fetch;
    window.fetch = /** @type {any} */ (async (/** @type {any} */ url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).includes('/api/ops/call')
        ? { success: true, data: { endpoints: [endpoint()] } }
        : { success: true, data: {} }),
    }));

    try {
      const tab = new ProvidersTab(host);
      tab.onConfigLoaded({
        config: { keys: {} },
        providers: [
          { name: 'anthropic', displayName: 'Anthropic', configKeyName: 'anthropic_api_key', modelsWithContext: [] },
          // The endpoint registers as a provider, so it is in this list too.
          { name: 'custom-acme', displayName: 'Acme Gateway', configKeyName: 'custom_acme_api_key', available: true, modelsWithContext: [{ id: 'm1', contextWindow: 1000, maxOutputTokens: 100 }] },
        ],
      }, true);

      await waitFor(() => !!host.querySelector('.custom-endpoint'), {
        timeoutMs: budgetFor(2000),
        description: 'the endpoint section to be drawn',
      });

      assert(!!host.querySelector('#anthropic-key'), 'the built-in providers stopped being rendered');
      // The whole point of the fold-in: the endpoint had a card here AND a row
      // in a tab of its own, with the key settable in both and the models only
      // in one.
      assert(!host.querySelector('#custom-acme-key'),
        'the endpoint has a second, half-furnished card among the built-in providers');
      const cards = host.querySelectorAll('.custom-endpoint[data-endpoint-id="acme"]');
      assert(cards.length === 1, `the endpoint has ${cards.length} cards, want exactly one`);
      assert(!!host.querySelector('.custom-endpoint-add-open'), 'there is no way to add an endpoint');
    } finally {
      window.fetch = originalFetch;
      host.remove();
    }
  });

  await run('saving a key on an endpoint rebuilds nothing else', async () => {
    const { host, ops, restore } = mountTab([endpoint()]);
    try {
      await waitFor(() => !!host.querySelector('.custom-endpoint'), {
        timeoutMs: budgetFor(2000),
        description: 'the endpoint section to be drawn',
      });
      // Held by identity, not by selector: a rebuild would replace these nodes
      // even though the same markup came back.
      const builtIn = host.querySelector('#anthropic-key');
      const card = host.querySelector('.custom-endpoint');
      const key = input(host, 'custom-endpoint-key-input');

      key.value = 'sk-typed';
      key.dispatchEvent(new Event('input', { bubbles: true }));
      /** @type {HTMLElement} */ (host.querySelector('.custom-endpoint-key-save')).click();
      await awaitOp(ops, 'setKey');
      await waitFor(() => {
        const badge = /** @type {HTMLElement|null} */ (host.querySelector('.custom-endpoint .provider-active-badge'));
        return !!badge && badge.style.display !== 'none';
      }, { timeoutMs: budgetFor(2000), description: 'the key to be reported as active' });

      // The whole page used to be rebuilt for this, which threw the pane back to
      // the top and shut every model list on it.
      assert(host.querySelector('#anthropic-key') === builtIn,
        'saving one endpoint’s key rebuilt the built-in providers above it');
      assert(host.querySelector('.custom-endpoint') === card,
        'saving a key rebuilt the card it was typed into');
    } finally {
      restore();
    }
  });

  await run('removing an endpoint takes out its card and leaves the page alone', async () => {
    const { host, ops, scrollWrites, restore } = mountTab([endpoint(), endpoint({ id: 'lab', providerId: 'custom-lab', displayName: 'Lab box' })]);
    try {
      await waitFor(() => host.querySelectorAll('.custom-endpoint').length === 2, {
        timeoutMs: budgetFor(2000),
        description: 'both endpoint cards to be drawn',
      });
      const builtIn = host.querySelector('#anthropic-key');
      const kept = host.querySelector('.custom-endpoint[data-endpoint-id="lab"]');

      const confirmed = stubModal(true);
      try {
        /** @type {HTMLElement} */ (host.querySelector('.custom-endpoint[data-endpoint-id="acme"] .custom-endpoint-remove')).click();
        await awaitOp(ops, 'remove');
      } finally {
        confirmed.restore();
      }

      await waitFor(() => !host.querySelector('.custom-endpoint[data-endpoint-id="acme"]'), {
        timeoutMs: budgetFor(2000),
        description: 'the removed endpoint’s card to go',
      });
      assert(host.querySelector('#anthropic-key') === builtIn,
        'removing an endpoint rebuilt the built-in providers above it');
      assert(host.querySelector('.custom-endpoint[data-endpoint-id="lab"]') === kept,
        'removing one endpoint rebuilt another');
      assert(!!host.querySelector('.custom-endpoint-add-open'), 'the way to add another went with it');
      assert(scrollWrites.length === 0, `something scrolled the pane: ${JSON.stringify(scrollWrites)}`);
    } finally {
      restore();
    }
  });

  await run('switching an endpoint off changes that card and nothing around it', async () => {
    const { host, ops, scrollWrites, restore } = mountTab([endpoint()]);
    try {
      await waitFor(() => !!host.querySelector('.custom-endpoint .model-visibility'), {
        timeoutMs: budgetFor(2000),
        description: 'the endpoint card and its model list to be drawn',
      });
      const builtIn = host.querySelector('#anthropic-key');
      const card = host.querySelector('.custom-endpoint');
      const url = input(host, 'custom-endpoint-url-input');

      const toggle = /** @type {HTMLInputElement} */ (host.querySelector('.custom-endpoint-toggle'));
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change'));
      await awaitOp(ops, 'save');
      // Switched off means unregistered, so the models it can no longer serve go.
      await waitFor(() => !host.querySelector('.custom-endpoint .model-visibility'), {
        timeoutMs: budgetFor(2000),
        description: 'the model list to go with the endpoint',
      });

      // Every one of these is the same object it was: nothing was torn down and
      // rebuilt, which is the only reason the pane cannot move under the user.
      assert(host.querySelector('#anthropic-key') === builtIn,
        'switching an endpoint off rebuilt the built-in providers above it');
      assert(host.querySelector('.custom-endpoint') === card, 'the card was rebuilt around its own switch');
      assert(host.querySelector('.custom-endpoint-url-input') === url, 'the fields on the card were rebuilt');
      assert(host.querySelector('.custom-endpoint-toggle') === toggle,
        'the switch was replaced by a copy of itself, so it loses focus on every click');
      // Nothing needs its scroll position saving and restoring, because nothing
      // it could be measured against was replaced.
      assert(scrollWrites.length === 0,
        `something scrolled the pane: ${JSON.stringify(scrollWrites)}`);
    } finally {
      restore();
    }
  });

  await run('an endpoint that did not register still has a card, and says why', () => {
    const { card, restore } = mountCard(endpoint({
      registered: false,
      url: 'nope',
      error: 'base URL "nope" must start with http:// or https://',
    }));
    try {
      const problem = card.querySelector('.custom-endpoint-problem');
      assert(!!problem && String(problem.textContent).includes('http://'),
        `the reason it isn’t working must be on the card — got "${problem?.textContent}"`);
      // The card exists precisely so this can be corrected.
      assert(input(card, 'custom-endpoint-url-input').value === 'nope', 'the offending URL is not editable');
      assert(!card.querySelector('.model-visibility'),
        'an endpoint that never registered is offering a model list it cannot have');
    } finally {
      restore();
    }
  });

  await run('a registered endpoint that will not answer reports what the provider said', () => {
    const { card, restore } = mountCard(endpoint(), {
      provider: {
        name: 'custom-acme',
        available: false,
        authHint: 'Couldn’t load the model list from Acme Gateway.',
        modelsWithContext: [],
      },
    });
    try {
      // The old status dot went green for any enabled endpoint with a URL that
      // parsed. Whether the endpoint answers is the only health an arbitrary
      // endpoint offers, and it is the model list that reports it.
      const problem = card.querySelector('.custom-endpoint-problem');
      assert(!!problem && String(problem.textContent).includes('model list'),
        `a registered endpoint that cannot serve must say so — got "${problem?.textContent}"`);
    } finally {
      restore();
    }
  });

  await run('a switched-off endpoint keeps its card, its URL and its key row', () => {
    const { card, restore } = mountCard(endpoint({ enabled: false, registered: false, hasKey: true, keySource: 'credentials' }));
    try {
      const toggle = /** @type {HTMLInputElement} */ (card.querySelector('.custom-endpoint-toggle'));
      assert(!!toggle && !toggle.checked, 'the switch does not report the endpoint as off');
      assert(input(card, 'custom-endpoint-url-input').value === 'https://gateway.acme.test/v1',
        'switching an endpoint off lost its URL');
      // The key is stored against the endpoint id, not the registry, so it stays
      // reachable while the endpoint is unregistered.
      assert(!input(card, 'custom-endpoint-key-input').disabled,
        'the key of a switched-off endpoint cannot be changed');
      assert(card.querySelector('.custom-endpoint-problem')?.textContent === '',
        'a deliberately switched-off endpoint is being reported as a problem');
    } finally {
      restore();
    }
  });

  await run('the id is derived from the name, and never asked for', () => {
    assert(deriveEndpointId('Acme Gateway', []) === 'acme-gateway',
      `“Acme Gateway” derived ${deriveEndpointId('Acme Gateway', [])}`);
    assert(deriveEndpointId('Acme', ['acme']) === 'acme-2', 'a name already in use must take the next free id');
    assert(deriveEndpointId('Acme', ['acme', 'acme-2']) === 'acme-3', 'the next free id was not free');
    for (const name of ['', '   ', '…', '3rd party', 'Ω', 'a'.repeat(80), 'Acme -- EU (2)']) {
      const derived = deriveEndpointId(name, []);
      assert(SERVER_ID_PATTERN.test(derived) && derived.length <= 40,
        `“${name}” derived “${derived}”, which the server would refuse`);
    }
    assert(SERVER_ID_PATTERN.test(deriveEndpointId('Acme', Array.from({ length: 12 }, (_, i) => (i ? `acme-${i + 1}` : 'acme')))),
      'a long run of clashes derived an id the server would refuse');
  });

  await run('the add form asks for a name and a URL, and shows the id those become', () => {
    const form = buildAddEndpointForm({ takenIds: [], onAdded: () => {}, onCancel: () => {} });
    document.body.appendChild(form);
    try {
      const name = input(form, 'custom-endpoint-add-name');
      assert(!!form.querySelector('.custom-endpoint-add-url'), 'the form does not ask for a URL');
      // One name field. The id used to be a second one, called "Name", which
      // could never be changed afterwards.
      assert(form.querySelectorAll('input[type="text"]').length === 2,
        `the form has ${form.querySelectorAll('input[type="text"]').length} fields, want a name and a URL`);
      assert(!form.querySelector('.custom-endpoint-transport-input, select'),
        'the form offers a transport choice, but an endpoint is only ever a URL');
      assert(!form.querySelector('[class*="scope"]'),
        'the form offers a scope, and endpoints are global only');

      name.value = 'Acme Gateway';
      name.dispatchEvent(new Event('input', { bubbles: true }));
      const shown = form.querySelector('.custom-endpoint-add-id');
      assert(!!shown && String(shown.textContent).includes('custom-acme-gateway'),
        `the id it will register as must be shown before it is fixed — got "${shown?.textContent}"`);
    } finally {
      form.remove();
    }
  });

  await run('adding writes one endpoint under the derived id', async () => {
    /** @type {any[]} */
    const ops = [];
    /** @type {any[]} */
    const applied = [];
    const originalFetch = window.fetch;
    window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
      const body = init && init.body ? JSON.parse(String(init.body)) : null;
      if (String(url).includes('/api/ops/call')) ops.push(body);
      return { ok: true, status: 200, json: async () => ({ success: true, data: { endpoints: [] } }) };
    });
    const form = buildAddEndpointForm({
      takenIds: ['acme'],
      onAdded: (endpoints) => { applied.push({ endpoints }); },
      onCancel: () => {},
    });
    document.body.appendChild(form);
    try {
      const name = input(form, 'custom-endpoint-add-name');
      name.value = 'Acme';
      name.dispatchEvent(new Event('input', { bubbles: true }));
      input(form, 'custom-endpoint-add-url').value = 'https://second.acme.test/v1';
      /** @type {HTMLElement} */ (form.querySelector('.custom-endpoint-add-save')).click();

      const call = await awaitOp(ops, 'save');
      assert(call.params.id === 'acme-2',
        `the id clashed with one in use and was not moved on — sent ${JSON.stringify(call.params.id)}`);
      assert(call.params.displayName === 'Acme' && call.params.url === 'https://second.acme.test/v1',
        `the endpoint was sent as ${JSON.stringify(call.params)}`);
      assert(call.params.enabled === true, 'a new endpoint should be switched on');
      await waitFor(() => applied.length > 0, {
        timeoutMs: budgetFor(2000),
        description: 'the new list to reach the tab',
      });
      assert(Array.isArray(applied[0].endpoints), 'the new list must reach the tab that holds the section');
    } finally {
      window.fetch = originalFetch;
      form.remove();
    }
  });

  await run('adding with no URL is refused before anything is written', async () => {
    /** @type {any[]} */
    const ops = [];
    const originalFetch = window.fetch;
    window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
      if (String(url).includes('/api/ops/call')) ops.push(init && init.body ? JSON.parse(String(init.body)) : null);
      return { ok: true, status: 200, json: async () => ({ success: true, data: { endpoints: [] } }) };
    });
    const form = buildAddEndpointForm({ takenIds: [], onAdded: () => {}, onCancel: () => {} });
    document.body.appendChild(form);
    try {
      const name = input(form, 'custom-endpoint-add-name');
      name.value = 'Acme';
      name.dispatchEvent(new Event('input', { bubbles: true }));
      /** @type {HTMLElement} */ (form.querySelector('.custom-endpoint-add-save')).click();
      await new Promise(r => setTimeout(r, 0));
      assert(ops.length === 0, 'an endpoint with no URL was written anyway');
      const status = form.querySelector('.provider-subfield-status[data-kind="error"]');
      assert(!!status && String(status.textContent).length > 0, 'the form gave no reason for refusing');
    } finally {
      window.fetch = originalFetch;
      form.remove();
    }
  });

  await run('editing the base URL saves that field and no other', async () => {
    const { card, ops, restore } = mountCard(endpoint());
    try {
      typeAndLeave(card, 'custom-endpoint-url-input', 'https://eu.acme.test/v1');
      const call = await awaitOp(ops, 'save');
      assert(call.params.id === 'acme' && call.params.url === 'https://eu.acme.test/v1',
        `the edit was sent as ${JSON.stringify(call.params)}`);
      // A card that saves a field at a time cannot overwrite the rest of the
      // endpoint with whatever it happened to be showing.
      assert(!('displayName' in call.params) && !('headers' in call.params),
        `the URL edit carried the whole endpoint with it: ${JSON.stringify(call.params)}`);
      assert(ops.filter(c => c.operation === 'save').length === 1,
        'one edit posted more than one write');
    } finally {
      restore();
    }
  });

  await run('leaving a field untouched saves nothing', async () => {
    const { card, ops, restore } = mountCard(endpoint());
    try {
      input(card, 'custom-endpoint-url-input').dispatchEvent(new Event('blur'));
      input(card, 'custom-endpoint-name-input').dispatchEvent(new Event('blur'));
      await new Promise(r => setTimeout(r, 0));
      assert(ops.length === 0, `passing through a field wrote to the server: ${JSON.stringify(ops)}`);
    } finally {
      restore();
    }
  });

  await run('the key is stored through the endpoint’s own operation, never with its definition', async () => {
    const { card, ops, restore } = mountCard(endpoint());
    try {
      const key = input(card, 'custom-endpoint-key-input');
      key.value = 'sk-typed';
      key.dispatchEvent(new Event('input', { bubbles: true }));
      const save = /** @type {HTMLElement} */ (card.querySelector('.custom-endpoint-key-save'));
      assert(save.style.display !== 'none', 'a typed key offers no way to save it');
      save.click();

      const call = await awaitOp(ops, 'setKey');
      assert(call.params.id === 'acme' && call.params.apiKey === 'sk-typed',
        `setKey was sent ${JSON.stringify(call.params)}`);
      assert(!ops.some(c => c.operation === 'save'),
        'the key was written into the definitions, which are not where a secret belongs');
    } finally {
      restore();
    }
  });

  await run('a stored key shows as active and can be deleted', async () => {
    const { card, ops, restore } = mountCard(endpoint({ hasKey: true, keySource: 'credentials' }));
    try {
      const badge = /** @type {HTMLElement} */ (card.querySelector('.provider-active-badge'));
      assert(!!badge && badge.style.display !== 'none', 'a stored key is not reported as active');
      const del = /** @type {HTMLElement} */ (card.querySelector('.custom-endpoint-key-delete'));
      assert(del.style.display !== 'none', 'a stored key offers no way to delete it');
      del.click();
      const call = await awaitOp(ops, 'setKey');
      assert(call.params.apiKey === '', `deleting sent ${JSON.stringify(call.params)}`);
    } finally {
      restore();
    }
  });

  await run('a key coming from the environment says so, and is not editable here', () => {
    const { card, restore } = mountCard(endpoint({ hasKey: true, keySource: 'env' }));
    try {
      const key = input(card, 'custom-endpoint-key-input');
      assert(key.disabled, 'a key set in the environment can be typed over, which would do nothing');
      assert(String(key.placeholder).includes('CUSTOM_ACME_API_KEY'),
        `the field must name where the key is coming from — got "${key.placeholder}"`);
      const hint = card.querySelector('.key-source-hint');
      assert(!!hint && String(hint.textContent).includes('CUSTOM_ACME_API_KEY'),
        'the key source is not explained');
    } finally {
      restore();
    }
  });

  await run('removing asks first, and names what it will forget', async () => {
    const { card, ops, applied, restore } = mountCard(endpoint());
    try {
      const remove = /** @type {HTMLElement} */ (card.querySelector('.custom-endpoint-remove'));
      const cancelled = stubModal(false);
      try {
        remove.click();
        await waitFor(() => cancelled.asked !== null, {
          timeoutMs: budgetFor(2000),
          description: 'the removal confirmation to be presented',
        });
      } finally {
        cancelled.restore();
      }
      const asked = cancelled.asked;
      assert(String(asked.message).includes('Acme Gateway'), 'the confirmation must name what is being removed');
      assert(String(asked.message).includes('limits'),
        'the confirmation must say that the models’ limits and hiding go with it');
      assert(ops.length === 0, 'a cancelled removal wrote anyway');

      const confirmed = stubModal(true);
      try {
        remove.click();
        await awaitOp(ops, 'remove');
      } finally {
        confirmed.restore();
      }
      const call = ops.find(c => c.operation === 'remove');
      assert(call.params.id === 'acme', `remove was sent ${JSON.stringify(call.params)}`);
      await waitFor(() => applied.length > 0, {
        timeoutMs: budgetFor(2000),
        description: 'the new list to reach the tab',
      });
      assert(applied.some(a => a.removed), 'the tab was never told the endpoint had gone');
    } finally {
      restore();
    }
  });

  await run('switching an endpoint off writes the switch, and puts it back if that fails', async () => {
    const { card, ops, restore } = mountCard(endpoint());
    try {
      const toggle = /** @type {HTMLInputElement} */ (card.querySelector('.custom-endpoint-toggle'));
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change'));
      const call = await awaitOp(ops, 'save');
      assert(call.params.enabled === false && call.params.id === 'acme',
        `the switch was sent as ${JSON.stringify(call.params)}`);
    } finally {
      restore();
    }
  });

  await run('a switch the server refuses goes back to what the server kept', async () => {
    const originalFetch = window.fetch;
    window.fetch = /** @type {any} */ (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: false, error: 'nope' }),
    }));
    const { element: card } = buildEndpointCard(endpoint(), {
      providerFor: () => undefined,
      modelRow: () => null,
      applyEndpoints: () => {},
      refreshProviders: async () => {},
      onRemoved: () => {},
      reportError: () => {},
    });
    document.body.appendChild(card);
    try {
      const toggle = /** @type {HTMLInputElement} */ (card.querySelector('.custom-endpoint-toggle'));
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change'));
      // A switch left showing "off" against a provider the picker still offers
      // is a lie about the state of the app.
      await waitFor(() => toggle.checked, {
        timeoutMs: budgetFor(2000),
        description: 'the refused switch to go back',
      });
    } finally {
      window.fetch = originalFetch;
      card.remove();
    }
  });

  await run('request headers are edited as names and values, and saved as a set', async () => {
    const { card, ops, restore } = mountCard(endpoint({ headers: { 'X-Tenant': 'eu' } }));
    try {
      assert(card.querySelectorAll('.custom-endpoint-header-row').length === 1,
        'the endpoint’s existing header is not shown');
      /** @type {HTMLElement} */ (card.querySelector('.custom-endpoint-header-add')).click();
      const rows = card.querySelectorAll('.custom-endpoint-header-row');
      assert(rows.length === 2, 'adding a header row did not add a row');

      const added = rows[1];
      const name = /** @type {HTMLInputElement} */ (added.querySelector('.custom-endpoint-header-name'));
      const value = /** @type {HTMLInputElement} */ (added.querySelector('.custom-endpoint-header-value'));
      name.value = 'X-Route';
      value.value = 'fast';
      value.dispatchEvent(new Event('blur'));

      const call = await awaitOp(ops, 'save');
      assert(call.params.headers['X-Tenant'] === 'eu' && call.params.headers['X-Route'] === 'fast',
        `headers were sent as ${JSON.stringify(call.params.headers)}`);
    } finally {
      restore();
    }
  });

  await run('a header with no name is refused rather than silently dropped', async () => {
    const { card, ops, restore } = mountCard(endpoint());
    try {
      /** @type {HTMLElement} */ (card.querySelector('.custom-endpoint-header-add')).click();
      const row = card.querySelector('.custom-endpoint-header-row');
      const value = /** @type {HTMLInputElement} */ (row?.querySelector('.custom-endpoint-header-value'));
      value.value = 'fast';
      value.dispatchEvent(new Event('blur'));
      await new Promise(r => setTimeout(r, 0));
      assert(ops.length === 0, 'a header with no name was sent anyway');
      const status = card.querySelector('.provider-subfield-status[data-kind="error"]');
      assert(!!status && String(status.textContent).includes('name'),
        `the reason must be given — got "${status?.textContent}"`);
    } finally {
      restore();
    }
  });

  await run('under en-XA the card and the add form show no plain English', async () => {
    const originalFetch = window.fetch;
    /** @type {HTMLElement[]} */
    const mounted = [];
    /** @type {MutationObserver[]} */
    const observers = [];
    try {
      await underPseudoLocale('custom-providers-test', async () => {
        // Every failure the server reports is the digit 7, so a message that
        // carries it is still judged as a message.
        let fail = false;
        window.fetch = /** @type {any} */ (async () => ({
          ok: true,
          status: 200,
          json: async () => (fail
            ? { success: false, error: '7' }
            : { success: true, data: { endpoints: [] } }),
        }));

        /** @type {string[]} */
        const statuses = [];
        /**
         * Record every status line and switch note the root ever shows, so the
         * transient ones (Saving…, Saved) are judged too.
         * @param {HTMLElement} root
         */
        const watch = (root) => {
          const observer = new MutationObserver(() => {
            for (const el of root.querySelectorAll('.provider-subfield-status, .custom-endpoint-toggle-note')) {
              const text = (el.textContent || '').trim();
              if (text && !statuses.includes(text)) statuses.push(text);
            }
          });
          observer.observe(root, { subtree: true, childList: true, characterData: true });
          observers.push(observer);
        };
        /** @type {string[]} */
        const reported = [];
        /**
         * @param {any} row
         * @param {any} [provider]
         * @returns {HTMLElement} The mounted card.
         */
        const mount = (row, provider) => {
          const { element } = buildEndpointCard(row, {
            providerFor: () => provider,
            modelRow: () => null,
            applyEndpoints: () => {},
            refreshProviders: async () => {},
            onRemoved: () => {},
            reportError: (message) => { reported.push(message); },
          });
          document.body.appendChild(element);
          mounted.push(element);
          watch(element);
          return element;
        };
        /**
         * @param {Element} root
         * @param {string} selector
         * @param {string} attr
         */
        const assertAttr = (root, selector, attr) => {
          const nodes = [...root.querySelectorAll(selector)];
          assert(nodes.length > 0, `nothing matches ${selector}`);
          for (const node of nodes) {
            const value = node.getAttribute(attr) || '';
            assert(isPseudoLocalized(value), `${selector} ${attr} is plain English: ${JSON.stringify(value)}`);
          }
        };
        /**
         * Wait for the status line of the field holding `el` to settle on `kind`.
         * @param {Element} el - A control in the field.
         * @param {string} kind - 'ok' or 'error'.
         * @param {string} description
         * @param {string} [not] - A text it must have moved on from.
         * @returns {Promise<void>}
         */
        const awaitStatus = (el, kind, description, not) => waitFor(() => {
          const status = el.closest('.provider-subfield')?.querySelector('.provider-subfield-status');
          return !!status && /** @type {HTMLElement} */ (status).dataset.kind === kind && status.textContent !== not;
        }, { timeoutMs: budgetFor(2000), description });

        // The heading is the endpoint's name and the code its provider id; the
        // name input's placeholder is the id, the URL's an example URL, the
        // header name's an example header, and the remove button a × — all data
        // or non-words, so their own labels are checked one by one below.
        const cardSkip = '.provider-name, .custom-endpoint-id, .custom-endpoint-name-input, '
          + '.custom-endpoint-url-input, .custom-endpoint-header-name, .custom-endpoint-header-remove';
        const checkCard = (/** @type {HTMLElement} */ card, /** @type {string} */ where) => {
          assertPseudoLocalized(card, { skip: cardSkip, atLeast: 8, where });
          assertAttr(card, '.custom-endpoint-id', 'title');
          assertAttr(card, '.custom-endpoint-name-input', 'aria-label');
          assertAttr(card, '.custom-endpoint-url-input', 'aria-label');
        };

        // A registered endpoint with a header and no key.
        const card = mount(endpoint({
          id: '7', providerId: 'custom-7', displayName: '42', url: 'https://1.2.3.4/1', headers: { 5: '6' },
        }), { name: 'custom-7', available: true, modelsWithContext: [] });
        assert(card.querySelector('.custom-endpoint-problem')?.textContent === '',
          'a healthy endpoint shows a problem');
        checkCard(card, 'card');
        assertAttr(card, '.custom-endpoint-header-name', 'aria-label');
        assertAttr(card, '.custom-endpoint-header-remove', 'aria-label');

        // A header row being added, then refused for having no name.
        /** @type {HTMLElement} */ (card.querySelector('.custom-endpoint-header-add')).click();
        checkCard(card, 'header being added');
        assertAttr(card, '.custom-endpoint-header-remove', 'aria-label');
        const rows = card.querySelectorAll('.custom-endpoint-header-row');
        const newValue = /** @type {HTMLInputElement} */ (rows[rows.length - 1].querySelector('.custom-endpoint-header-value'));
        newValue.value = '8';
        newValue.dispatchEvent(new Event('blur'));
        await awaitStatus(newValue, 'error', 'the nameless header to be refused');
        /** @type {HTMLElement} */ (rows[rows.length - 1].querySelector('.custom-endpoint-header-remove')).click();
        await new Promise(r => setTimeout(r, 0));

        // A field saved, then a field that fails to save.
        const url = input(card, 'custom-endpoint-url-input');
        typeAndLeave(card, 'custom-endpoint-url-input', 'https://1.2.3.4/2');
        await awaitStatus(url, 'ok', 'the URL to be saved');
        fail = true;
        typeAndLeave(card, 'custom-endpoint-url-input', 'https://1.2.3.4/3');
        await awaitStatus(url, 'error', 'the URL save to fail');

        // The switch, refused.
        const toggle = /** @type {HTMLInputElement} */ (card.querySelector('.custom-endpoint-toggle'));
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change'));
        await waitFor(() => !!card.querySelector('.custom-endpoint-toggle-note')?.textContent, {
          timeoutMs: budgetFor(2000), description: 'the refused switch to say why',
        });

        // A key typed and refused, then saved.
        const key = input(card, 'custom-endpoint-key-input');
        key.value = '0';
        key.dispatchEvent(new Event('input', { bubbles: true }));
        checkCard(card, 'key typed');
        /** @type {HTMLElement} */ (card.querySelector('.custom-endpoint-key-save')).click();
        await awaitStatus(key, 'error', 'the key save to fail');
        fail = false;
        /** @type {HTMLElement} */ (card.querySelector('.custom-endpoint-key-save')).click();
        await awaitStatus(key, 'ok', 'the key to be saved');

        // Removing: the confirmation, then a removal that fails.
        fail = true;
        const confirm = stubModal(true);
        try {
          /** @type {HTMLElement} */ (card.querySelector('.custom-endpoint-remove')).click();
          await waitFor(() => reported.length > 0, {
            timeoutMs: budgetFor(2000), description: 'the failed removal to be reported',
          });
        } finally {
          confirm.restore();
        }
        fail = false;
        const asked = confirm.asked;
        assert(!!asked, 'removing asked nothing');
        const rawDialog = [asked.title, asked.message, asked.confirmText].filter(s => !isPseudoLocalized(s));
        assert(rawDialog.length === 0, `plain English in the removal confirmation: ${JSON.stringify(rawDialog)}`);
        const rawReported = reported.filter(s => !isPseudoLocalized(s));
        assert(rawReported.length === 0, `plain English in the removal failure: ${JSON.stringify(rawReported)}`);
        checkCard(card, 'after the saves');

        // A stored key: the badge and Delete.
        const stored = mount(endpoint({ id: '7', providerId: 'custom-7', displayName: '42', hasKey: true, keySource: 'credentials' }));
        checkCard(stored, 'stored key');
        /** @type {HTMLElement} */ (stored.querySelector('.custom-endpoint-key-delete')).click();
        await awaitStatus(input(stored, 'custom-endpoint-key-input'), 'ok', 'the key to be deleted');

        // A key from the environment.
        const env = mount(endpoint({ id: '7', providerId: 'custom-7', displayName: '42', hasKey: true, keySource: 'env', envVarName: '9' }));
        assert(!!env.querySelector('.key-source-hint'), 'the environment key has no hint');
        checkCard(env, 'key from the environment');

        // The add form: empty, named, refused for no URL, and failing to add.
        const form = buildAddEndpointForm({ takenIds: [], onAdded: () => {}, onCancel: () => {} });
        document.body.appendChild(form);
        mounted.push(form);
        watch(form);
        const formSkip = '.custom-endpoint-add-url, .custom-endpoint-add-id';
        assertPseudoLocalized(form, { skip: formSkip, atLeast: 6, where: 'add form' });
        assertAttr(form, '.custom-endpoint-add-url', 'aria-label');
        const addName = input(form, 'custom-endpoint-add-name');
        addName.value = '42';
        addName.dispatchEvent(new Event('input', { bubbles: true }));
        // The id is data inside a message: judged with the id taken out.
        const idNote = form.querySelector('.custom-endpoint-add-id')?.textContent || '';
        assert(idNote.includes('custom-endpoint'), `the id note reads ${JSON.stringify(idNote)}`);
        assert(isPseudoLocalized(idNote.replace('custom-endpoint', '')),
          `the id note is plain English: ${JSON.stringify(idNote)}`);
        const addURL = input(form, 'custom-endpoint-add-url');
        /** @type {HTMLElement} */ (form.querySelector('.custom-endpoint-add-save')).click();
        await awaitStatus(addURL, 'error', 'the URL-less add to be refused');
        const refusal = addURL.closest('.provider-subfield')?.querySelector('.provider-subfield-status')?.textContent || '';
        fail = true;
        addURL.value = 'https://1.2.3.4/4';
        /** @type {HTMLElement} */ (form.querySelector('.custom-endpoint-add-save')).click();
        await awaitStatus(addURL, 'error', 'the add to fail', refusal);
        fail = false;
        assertPseudoLocalized(form, { skip: formSkip, where: 'add form after failing' });

        // Saving…, Saved, Deleted, every refusal and every failure.
        assert(statuses.length >= 8, `expected every status line, saw ${JSON.stringify(statuses)}`);
        const rawStatus = statuses.filter(s => !isPseudoLocalized(s));
        assert(rawStatus.length === 0, `plain English status lines: ${JSON.stringify(rawStatus)}`);
      });
    } finally {
      for (const observer of observers) observer.disconnect();
      for (const el of mounted) el.remove();
      window.fetch = originalFetch;
    }
  });

  await run('under en-XA the whole Providers tab shows no plain English, in every state it draws', async () => {
    const originalFetch = window.fetch;
    const originalModal = /** @type {any} */ (window).showModal;
    const originalOpen = window.open;
    const clipboard = /** @type {any} */ (navigator.clipboard);
    const originalWrite = clipboard ? clipboard.writeText : undefined;
    const host = /** @type {any} */ (document.createElement('div'));
    host.innerHTML = '<div id="provider-fields-container"></div>';
    /** @type {MutationObserver|null} */
    let observer = null;
    /** @type {any} */
    let tab = null;
    try {
      await underPseudoLocale('custom-providers-tab-test', async () => {
        // Letter-bearing data the tab shows inside a message: the default local
        // server address and the device-flow verification URL.
        const VERIFY = 'https://1.2.3.4/5';
        const DATA = ['http://localhost:11434', VERIFY];
        const strip = (/** @type {string} */ s) => DATA.reduce((acc, d) => acc.split(d).join(''), s);

        /** @type {string[]} */
        const calls = [];
        const fail = { config: false, settings: false, enable: true, switch: true };
        let startOK = false;
        const ok = (/** @type {any} */ body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
        const bad = (/** @type {any} */ body) => ({
          ok: false, status: 500, statusText: '', json: async () => body, text: async () => (body ? JSON.stringify(body) : ''),
        });
        // Every failure the server reports is the digit 7; a switch failure says
        // nothing at all, so the tab's own fallback is what shows.
        window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
          const u = String(url);
          const method = (init && init.method) || 'GET';
          calls.push(`${method} ${u}`);
          if (u.includes('/api/ops/call')) return ok({ success: true, data: { endpoints: [] } });
          if (u.endsWith('/config/provider-enabled')) return fail.enable ? bad({ error: '7' }) : ok({});
          if (u.endsWith('/config')) return fail.config ? bad({ error: '7' }) : ok({});
          if (u.endsWith('/settings')) return fail.settings ? bad({ error: '7' }) : ok({});
          if (u.endsWith('/providers/switch')) return fail.switch ? bad(null) : ok({ provider: 'p11' });
          if (u.endsWith('/copilot/host')) return method === 'GET' ? ok({}) : ok({ success: false });
          if (u.endsWith('/device/start')) {
            return startOK
              ? ok({ success: true, userCode: '1234', verificationUri: VERIFY, deviceCode: '6', interval: 1 })
              : ok({ success: false });
          }
          if (u.endsWith('/device/poll')) return ok({ success: true, status: 'denied' });
          if (u.endsWith('/copilot/signout')) return ok({ success: false });
          return ok({});
        });
        window.open = /** @type {any} */ (() => null);
        if (clipboard) clipboard.writeText = async () => {};
        /** @type {any[]} */
        const dialogs = [];
        /** @type {any} */ (window).showModal = async (/** @type {any} */ options) => {
          dialogs.push(options);
          return options.type === 'confirm' ? true : undefined;
        };

        const models = () => [
          { id: '1', contextWindow: 1000, maxOutputTokens: 100 },
          { id: '2', contextWindow: 1500, maxOutputTokens: 150, providerContextWindow: 1000, providerMaxOutputTokens: 100 },
          { id: '3', contextWindow: 1200, maxOutputTokens: 120, fromAPI: true },
          { id: '4', contextWindow: 512, maxOutputTokens: 100, windowAssumed: true },
        ];
        const providers = () => [
          // API key: none set, one stored, one from the environment.
          { name: 'p1', displayName: '1', description: '2', configKeyName: 'p1_key', apiKeyURL: 'https://1.2.3.4/', keySource: '', envVarName: '', modelsWithContext: models() },
          { name: 'p2', displayName: '2', configKeyName: 'p2_key', keySource: 'credentials', modelsWithContext: [] },
          { name: 'p3', displayName: '3', configKeyName: 'p3_key', keySource: 'env', envVarName: '9', modelsWithContext: [] },
          // OAuth: signed in, signed out, the device flow both ways, switched off.
          { name: 'p4', displayName: '4', authType: 'oauth_bearer', available: true, modelsWithContext: [] },
          { name: 'p5', displayName: '5', authType: 'oauth_bearer', available: false },
          { name: 'p6', displayName: '6', authType: 'oauth_bearer', available: false, signInMethod: 'github_device' },
          { name: 'p7', displayName: '7', authType: 'oauth_bearer', available: true, signInMethod: 'github_device' },
          { name: 'p8', displayName: '8', authType: 'oauth_bearer', disabled: true },
          // Keyless: on with a server hint (a CLI not found), offering a switch,
          // the two with a host or path row, and one switched off.
          { name: 'p9', displayName: '9', configKeyName: '', credentialed: true, authHint: '5' },
          { name: 'p10', displayName: '10', configKeyName: '', credentialed: true, switchTo: { reason: '6', displayName: '11' } },
          { name: 'ollama', displayName: '12', configKeyName: '', credentialed: true },
          { name: 'claudecode', displayName: '13', configKeyName: '', credentialed: true },
          { name: 'p14', displayName: '14', configKeyName: '', credentialed: false },
        ];

        document.body.appendChild(host);
        /** @type {string[]} */
        const transient = [];
        // Every string the tab ever shows, so the transient ones (Saving…,
        // Checking…, Starting…, Switching…) are judged too. A string with no
        // letters in it is data, not English.
        observer = new MutationObserver(() => {
          for (const s of shownStrings(host, '#ollama-host-input, .copilot-host-field input')) {
            const text = strip(s);
            if (/[A-Za-z]/.test(text) && !isPseudoLocalized(text) && !transient.includes(s)) transient.push(s);
          }
        });
        observer.observe(host, { subtree: true, childList: true, characterData: true, attributes: true });

        tab = new ProvidersTab(host);
        host.loadConfig = async () => true;
        tab.onConfigLoaded({ config: { keys: { p2: true } }, providers: providers() }, true);
        await waitFor(() => !!host.querySelector('.custom-endpoint-add-open'), {
          timeoutMs: budgetFor(2000), description: 'the endpoint section to be drawn',
        });

        // Names, descriptions, model ids, numbers and addresses are data; their
        // elements' own labels are checked one by one below.
        const skip = '.provider-name, .provider-description, .model-visibility-name, .model-visibility-count, '
          + '.model-limit-input, .provider-switch-reason, #p9-oauth-status, #ollama-host-input, .copilot-host-field input';
        /**
         * Every limit field's title and aria-label is a message; its placeholder
         * is the reported number, or a message when there is none.
         * @param {string} where
         */
        const checkLimitFields = (where) => {
          const fields = [...host.querySelectorAll('.model-limit-input')];
          assert(fields.length === 8, `expected 8 limit fields (${where}), found ${fields.length}`);
          for (const f of fields) {
            for (const attr of ['title', 'aria-label']) {
              const v = f.getAttribute(attr) || '';
              assert(isPseudoLocalized(v), `a limit field's ${attr} is plain English (${where}): ${JSON.stringify(v)}`);
            }
          }
        };
        const check = (/** @type {string} */ where) => {
          assertPseudoLocalized(host, { skip, atLeast: 40, where });
          checkLimitFields(where);
          const tenant = host.querySelector('.copilot-host-field input')?.getAttribute('placeholder') || '';
          assert(tenant.includes('github.com') && isPseudoLocalized(tenant.replace('github.com', '')),
            `the GitHub host placeholder is plain English (${where}): ${JSON.stringify(tenant)}`);
        };
        check('as drawn');
        assert(!!host.querySelector('#p4-oauth-status') && !!host.querySelector('#p5-oauth-status'),
          'the OAuth status lines were not drawn');
        assert(!!host.querySelector('.provider-switch-notice'), 'the switch notice was not drawn');
        assert(!!host.querySelector('#claudecode-binary-input'), 'the Claude Code path row was not drawn');
        assert(!!host.querySelector('.model-window-assumed'), 'the assumed marker was not drawn');

        const settle = () => new Promise(r => setTimeout(r, 0));
        const dialogCount = (/** @type {number} */ n, /** @type {string} */ description) =>
          waitFor(() => dialogs.length >= n, { timeoutMs: budgetFor(4000), description });
        const fieldOf = (/** @type {string} */ name) => /** @type {HTMLElement} */ (host.querySelector(`.provider-field[data-provider="${name}"]`));

        // A key typed, then refused; a stored key whose delete fails.
        fail.config = true;
        const key = /** @type {HTMLInputElement} */ (host.querySelector('#p1-key'));
        key.value = '0';
        key.dispatchEvent(new Event('input'));
        check('key typed');
        /** @type {HTMLElement} */ (host.querySelector('#p1-save')).click();
        await dialogCount(1, 'the refused key to be reported');
        /** @type {HTMLElement} */ (host.querySelector('#p2-delete')).click();
        await dialogCount(2, 'the failed delete to be reported');
        // A switch the server refuses.
        const off = /** @type {HTMLInputElement} */ (host.querySelector('#p14-toggle'));
        off.checked = true;
        off.dispatchEvent(new Event('change'));
        await dialogCount(3, 'the refused switch to be reported');

        // The model list: a model hidden, then a limit and a hide that fail.
        const list = /** @type {HTMLDetailsElement} */ (fieldOf('p1').querySelector('details.model-visibility'));
        assert(list.open, 'a list with an assumed window did not open');
        const box = /** @type {HTMLInputElement} */ (list.querySelector('[data-model="1"] .model-visibility-check'));
        box.checked = false;
        box.dispatchEvent(new Event('change'));
        await settle();
        const count = list.querySelector('.model-visibility-count')?.textContent || '';
        assert(isPseudoLocalized(count), `the shown count is plain English: ${JSON.stringify(count)}`);
        fail.settings = true;
        const limit = /** @type {HTMLInputElement} */ (list.querySelector('[data-model="1"] [data-limit="contextWindow"]'));
        limit.value = '2000';
        limit.dispatchEvent(new Event('change'));
        const status = /** @type {HTMLElement} */ (list.querySelector('.model-visibility-status'));
        await waitFor(() => !status.hidden, { timeoutMs: budgetFor(2000), description: 'the limit save to fail' });
        const limitError = status.textContent;
        assert(isPseudoLocalized(limitError || ''), `the limit failure is plain English: ${JSON.stringify(limitError)}`);
        const box2 = /** @type {HTMLInputElement} */ (list.querySelector('[data-model="2"] .model-visibility-check'));
        box2.checked = false;
        box2.dispatchEvent(new Event('change'));
        await waitFor(() => status.textContent !== limitError, { timeoutMs: budgetFor(2000), description: 'the hide to fail' });
        fail.settings = false;
        const filter = /** @type {HTMLInputElement} */ (list.querySelector('.model-visibility-filter'));
        filter.value = '0';
        filter.dispatchEvent(new Event('input'));
        check('model list filtered to nothing');

        // A host saved, cleared and refused; a CLI path saved, cleared and refused.
        for (const [id, values] of /** @type {Array<[string, string[]]>} */ ([
          ['#ollama-host-input', ['1.2.3.4', '', '5.6.7.8']],
          ['#claudecode-binary-input', ['/1/2', '', '/3']],
        ])) {
          const input = /** @type {HTMLInputElement} */ (host.querySelector(id));
          const line = /** @type {HTMLElement} */ (input.closest('.provider-input-wrapper')?.nextElementSibling);
          for (const [i, value] of values.entries()) {
            fail.config = i === 2;
            const before = line.textContent;
            input.value = value;
            input.dispatchEvent(new Event('blur'));
            // Saving… gives way to what happened.
            await waitFor(() => !!line.textContent && line.textContent !== before && !line.textContent.includes('\u2026'), {
              timeoutMs: budgetFor(2000), description: `${id} to report ${JSON.stringify(value)}`,
            });
          }
        }
        fail.config = false;

        // The GitHub device flow: a host refused, a sign-in that cannot start,
        // one GitHub denies, and a sign-out that fails.
        const hostInput = /** @type {HTMLInputElement} */ (host.querySelector('#p6-host'));
        hostInput.value = '1.2.3.4';
        hostInput.dispatchEvent(new Event('change'));
        await dialogCount(4, 'the refused host to be reported');
        /** @type {HTMLElement} */ (fieldOf('p6').querySelector('.btn-primary')).click();
        await dialogCount(5, 'the sign-in that could not start to be reported');
        startOK = true;
        /** @type {HTMLElement} */ (fieldOf('p6').querySelector('.btn-primary')).click();
        await dialogCount(6, 'the denied sign-in to be reported');
        /** @type {HTMLElement} */ (fieldOf('p7').querySelector('.btn-danger')).click();
        await dialogCount(8, 'the sign-out to be confirmed, then its failure reported');

        // Re-checking a sign-in, and a keyless provider's status.
        for (const name of ['p4', 'p9']) {
          const before = calls.length;
          /** @type {HTMLElement} */ (fieldOf(name).querySelector('.settings-btn.icon')).click();
          await waitFor(() => calls.slice(before).some(c => c.endsWith('/providers/refresh')), {
            timeoutMs: budgetFor(2000), description: `${name}'s re-check to ask for a refresh`,
          });
          wsService._emit('providers-update', providers());
          await waitFor(() => !host.querySelector('.settings-btn.icon.spinning'), {
            timeoutMs: budgetFor(2000), description: `${name}'s re-check to finish`,
          });
        }

        // Switching: refused, then done.
        const switchButton = () => /** @type {HTMLButtonElement} */ (host.querySelector('.provider-switch-notice button'));
        const switchStatus = () => host.querySelector('.provider-switch-status')?.textContent || '';
        switchButton().click();
        await waitFor(() => !switchButton().disabled && switchStatus() !== '' && !switchStatus().includes('\u2026'), {
          timeoutMs: budgetFor(2000), description: 'the refused switch to say so',
        });
        const refused = switchStatus();
        fail.switch = false;
        switchButton().click();
        await waitFor(() => switchStatus() !== refused && !switchStatus().includes('\u2026'), {
          timeoutMs: budgetFor(2000), description: 'the switch to be done',
        });
        const switched = providers().map(p => (p.name === 'p10' ? { ...p, credentialed: false } : p));
        wsService._emit('providers-update', switched);
        await waitFor(() => !host.querySelector('.provider-switch-notice'), {
          timeoutMs: budgetFor(5000), description: 'the tab to be redrawn after the switch',
        });
        check('after everything');

        // Every dialog: a reported failure from the server carries its detail,
        // the digit 7, after the tab's own words.
        assert(dialogs.length >= 8, `expected 8 dialogs, saw ${dialogs.length}`);
        const rawDialogs = dialogs.flatMap(d => [d.title, d.message])
          .filter(s => s !== 'GitHub Copilot' && !isPseudoLocalized(String(s).replace(/: 7$/, '')));
        assert(rawDialogs.length === 0, `plain English in a dialog: ${JSON.stringify(rawDialogs)}`);
        assert(transient.length === 0, `plain English shown on the way: ${JSON.stringify(transient)}`);
      });
    } finally {
      if (observer) /** @type {MutationObserver} */ (observer).disconnect();
      if (tab) tab.dispose();
      host.remove();
      window.fetch = originalFetch;
      /** @type {any} */ (window).showModal = originalModal;
      window.open = originalOpen;
      if (clipboard) clipboard.writeText = originalWrite;
    }
  });

  return { passed, failed, errors };
}
