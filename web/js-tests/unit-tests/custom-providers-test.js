//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Provider accounts on the Providers tab, custom endpoints among them: every
 * account is a provider registered under its own id, so a conversation picks
 * an account by picking one of its models.
 *
 * Two halves of one story. The first is what a conversation does when the
 * provider it names has gone — an account removed. The second is the tab
 * itself: one card per account and none for a type with no account, no on/off
 * switch anywhere, the logins found on this machine offered rather than added,
 * and the add flow.
 * @module unit-tests/custom-providers-test
 */

import { assert, waitFor, nextTask } from '../utilities/test-helpers.js';
import { budgetFor } from '../utilities/test-deadline.js';
import '../../js/components/model-selector.js';
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

const ENDPOINT_TYPE = 'openai-compatible';

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
 * An endpoint account as the list operation reports it, overridable per test.
 * @param {object} [over] - Fields to change.
 * @returns {any} The account.
 */
function endpoint(over = {}) {
  return {
    id: 'custom-acme',
    type: ENDPOINT_TYPE,
    typeDisplayName: 'OpenAI-compatible endpoint',
    displayName: 'Acme Gateway',
    category: 'custom',
    isDefault: false,
    keySource: '',
    envVarName: 'CUSTOM_ACME_API_KEY',
    settings: { baseURL: 'https://gateway.acme.test/v1', headers: {} },
    registered: true,
    ...over,
  };
}

/**
 * A type's default account, as the list operation reports it.
 * @param {string} id - The type, and so the id.
 * @param {string} name - Its name.
 * @param {object} [over] - Fields to change.
 * @returns {any} The account.
 */
function defaultAccount(id, name, over = {}) {
  return {
    id, type: id, typeDisplayName: name, displayName: name, category: 'api_key', isDefault: true, registered: true, ...over,
  };
}

/** @returns {any[]} The types the add menu is offered. */
function types() {
  return [
    { name: 'anthropic', displayName: 'Anthropic', category: 'api_key', hasDefaultAccount: true, acceptsExtra: true },
    { name: 'claudecode', displayName: 'Claude Code', category: 'subscription', hasDefaultAccount: true, acceptsExtra: false },
    { name: 'ollama', displayName: 'Ollama', category: 'local', hasDefaultAccount: true, acceptsExtra: false },
    { name: ENDPOINT_TYPE, displayName: 'OpenAI-compatible endpoint', category: 'custom', hasDefaultAccount: false, acceptsExtra: true },
  ];
}

/** @returns {any[]} The published provider list the tab is handed. */
function providers() {
  return [
    { name: 'anthropic', displayName: 'Anthropic', authType: 'api_key', configKeyName: 'anthropic_api_key', envVarName: 'ANTHROPIC_API_KEY', modelsWithContext: [] },
    { name: 'claudecode', displayName: 'Claude Code', authType: 'toggle', configKeyName: '', credentialed: true, available: true, modelsWithContext: [] },
    { name: 'ollama', displayName: 'Ollama', authType: 'toggle', configKeyName: '', credentialed: false, modelsWithContext: [] },
    { name: 'custom-acme', type: ENDPOINT_TYPE, displayName: 'Acme Gateway', configKeyName: 'custom_acme_api_key', available: true, modelsWithContext: [{ id: 'm1', contextWindow: 1000, maxOutputTokens: 100 }] },
    { name: 'custom-lab', type: ENDPOINT_TYPE, displayName: 'Lab box', configKeyName: 'custom_lab_api_key', available: true, modelsWithContext: [] },
  ];
}

/**
 * Mount a real ProvidersTab over a fake host, with the accounts ops served from
 * an in-memory list, and a scroller whose position can be read back.
 * @param {object} [opts] - Scenario knobs.
 * @param {any[]} [opts.accounts] - The accounts there are.
 * @param {any[]} [opts.candidates] - The logins offered.
 * @param {any[]} [opts.providers] - The published provider list.
 * @param {number} [opts.usage] - How many conversations use any account.
 * @param {any[]} [opts.catalog] - What the models.dev catalogue lists.
 * @param {(params: any) => Promise<any>} [opts.preview] - Answers the add form's preview.
 * @returns {{tab: any, host: any, scrollWrites: number[], ops: any[], state: any, restore: () => void}}
 *   The tab, its host, anything written to the scroller, the operations posted, and the list.
 */
function mountTab(opts = {}) {
  const host = /** @type {any} */ (document.createElement('div'));
  const scroller = document.createElement('div');
  scroller.className = 'settings-content';
  let top = 0;
  /** @type {number[]} */
  const scrollWrites = [];
  // Records anything written to the scroll offset. Nothing should be: a save
  // that replaces no DOM has no position to save and restore.
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => top,
    set: (/** @type {number} */ v) => { top = v; scrollWrites.push(v); },
    configurable: true,
  });
  scroller.innerHTML = '<div id="provider-fields-container"></div>';
  host.appendChild(scroller);
  document.body.appendChild(host);

  const published = opts.providers || providers();
  const state = {
    accounts: opts.accounts || [defaultAccount('claudecode', 'Claude Code', { category: 'subscription' }), endpoint()],
    candidates: opts.candidates || [],
  };
  /** @type {any[]} */
  const ops = [];
  const originalFetch = window.fetch;
  const ok = (/** @type {any} */ data) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
  window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
    if (!String(url).includes('/api/ops/call')) return { ok: true, status: 200, json: async () => ({}) };
    const body = JSON.parse(String(init.body));
    ops.push(body);
    const p = body.params || {};
    if (body.toolId === 'customProviders') return ok({ providers: opts.catalog || [] });
    const list = () => ({ accounts: state.accounts, candidates: state.candidates });
    switch (body.operation) {
      case 'types': return ok({ types: types() });
      case 'preview': {
        if (opts.preview) return ok(await opts.preview(p));
        const type = types().find(ty => ty.name === p.type);
        const isDefault = !!type?.hasDefaultAccount && !state.accounts.some(a => a.id === p.type);
        if (isDefault) return ok({ id: p.type, displayName: type.displayName, isDefault });
        return ok({ id: p.type === ENDPOINT_TYPE ? 'custom-new' : `${p.type}-2`, displayName: `${type?.displayName} (2)`, isDefault });
      }
      case 'usage': return ok({ conversations: opts.usage || 0 });
      case 'save': {
        if (p.id) {
          state.accounts = state.accounts.map(a => (a.id === p.id
            ? { ...a, ...(p.displayName !== undefined ? { displayName: p.displayName } : {}), settings: { ...a.settings, ...p.settings } }
            : a));
          return ok({ id: p.id, ...list() });
        }
        const id = p.type === ENDPOINT_TYPE ? 'custom-new' : p.type;
        state.accounts = [...state.accounts, { ...defaultAccount(id, p.displayName), type: p.type, settings: p.settings }];
        return ok({ id, ...list() });
      }
      case 'remove':
        state.accounts = state.accounts.filter(a => a.id !== p.id);
        return ok(list());
      case 'setKey':
        state.accounts = state.accounts.map(a => (a.id === p.id ? { ...a, keySource: p.apiKey ? 'credentials' : '' } : a));
        return ok({ id: p.id, ...list() });
      case 'addCandidate': {
        const c = state.candidates.find(x => x.key === p.key);
        state.candidates = state.candidates.filter(x => x.key !== p.key);
        state.accounts = [...state.accounts, defaultAccount(c.accountId, c.displayName)];
        return ok({ id: c.accountId, ...list() });
      }
      default: return ok(list());
    }
  });

  const tab = new ProvidersTab(host);
  // The shell's own loadConfig: re-reads config and providers, and rebuilds the
  // fields only when asked to.
  host.loadConfig = async (/** @type {boolean} */ renderFields = true) => {
    tab.onConfigLoaded({ config: { keys: {} }, providers: published }, renderFields);
    return true;
  };
  tab.onConfigLoaded({ config: { keys: {} }, providers: published }, true);
  host.tab = tab;

  return {
    tab,
    host,
    scrollWrites,
    ops,
    state,
    restore: () => {
      tab.dispose();
      window.fetch = originalFetch;
      host.remove();
    },
  };
}

/**
 * @param {Element} root - Where to look.
 * @param {string} id - The account id.
 * @returns {HTMLElement|null} Its card.
 */
const cardOf = (root, id) => /** @type {HTMLElement|null} */ (root.querySelector(`.account-card[data-provider="${id}"]`));

/**
 * Wait for the account list to have been drawn, over the cards the tab draws
 * from the provider list while it asks, and return one account's card.
 * @param {any} root - The mounted host.
 * @param {string} id - The account.
 * @returns {Promise<HTMLElement>} Its card.
 */
async function drawn(root, id) {
  await waitFor(() => !!root.tab?.accountList && !!cardOf(root, id), {
    timeoutMs: budgetFor(2000), description: `the account list, and the card of ${id}`,
  });
  return /** @type {HTMLElement} */ (cardOf(root, id));
}

/**
 * @param {Element} root - Where to look.
 * @param {string} className - The input's hook class.
 * @returns {HTMLInputElement} The input.
 */
function input(root, className) {
  const el = /** @type {HTMLInputElement|null} */ (root.querySelector(`.${className}`));
  assert(!!el, `no .${className}`);
  return el;
}

/**
 * Type into a field and leave it, which is when a card saves.
 * @param {Element} root - Where to look.
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
 * Open a card's ⋯ menu and pick a row.
 * @param {HTMLElement} card - The card.
 * @param {'Rename'|'Remove'} label - The row.
 */
function pickFromMenu(card, label) {
  /** @type {HTMLElement} */ (card.querySelector('.account-menu-button')).click();
  // By position, not by its words, which a locale changes: Rename, then Remove.
  const rows = [...document.querySelectorAll('.account-menu .menu-item')];
  const row = label === 'Rename' ? rows[0] : rows.find(el => el.classList.contains('menu-item-danger'));
  assert(rows.length === 2 && !!row, `the ⋯ menu has no ${label}`);
  // The menu is appended to <body> while the settings panel covers the window
  // at --z-modal: anything lower paints behind it, and the ⋯ button does nothing
  // a user can see.
  const menu = /** @type {HTMLElement} */ (document.querySelector('.account-menu'));
  const modal = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--z-modal'), 10);
  const z = parseInt(getComputedStyle(menu).zIndex, 10);
  assert(z > modal, `the ⋯ menu paints behind the settings panel (z-index ${getComputedStyle(menu).zIndex}, panel ${modal})`);
  /** @type {HTMLElement} */ (row).click();
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

  await run('the page has a card per account, none for a type with no account, and no on/off switch', async () => {
    const { host, restore } = mountTab();
    try {
      const acme = await drawn(host, 'custom-acme');
      assert(!!cardOf(host, 'claudecode'), 'a detected default account has no card');
      // Every built-in is registered, so all of them are in the provider list,
      // and a page that drew one card each was eighteen cards long.
      assert(!cardOf(host, 'anthropic') && !cardOf(host, 'ollama'),
        'a type with no account has a card of its own; it belongs under Add an account');
      assert(!host.querySelector('.provider-toggle, .toggle-switch, input[type="checkbox"]:not(.settings-model-visibility-check)'),
        'an account has an on/off switch; there are only Add and Remove');
      assert(acme.classList.contains('provider-field') && acme.classList.contains('settings-group'),
        `the card is ${acme.className}, not the settings card shell`);
      assert(!!acme.querySelector('.account-menu-button'), 'the card has no ⋯ menu');
      // The id is shown, and is not a field: every conversation names it.
      const id = acme.querySelector('.account-id');
      assert(!!id && id.textContent === 'custom-acme' && id.tagName !== 'INPUT', `the account id reads "${id?.textContent}"`);
      // The way to add one is on the page, not behind a button.
      await waitFor(() => !!host.querySelector('.account-add .account-type[data-type="anthropic"]'), {
        timeoutMs: budgetFor(2000), description: 'the kinds of account, shown without being asked for',
      });
    } finally {
      restore();
    }
  });

  await run('an endpoint is configured on its card: base URL, headers, key and models', async () => {
    const { host, restore } = mountTab();
    try {
      const card = await drawn(host, 'custom-acme');
      assert(input(card, 'account-url-input').value === 'https://gateway.acme.test/v1', 'the base URL is not on the card');
      assert(!!card.querySelector('.account-header-add'), 'the headers cannot be edited');
      assert(!!card.querySelector('.account-key-input'), 'the API key is not on the card');
      assert(!!card.querySelector('.settings-model-visibility'),
        'the models, and their limits, are configured somewhere other than the account they belong to');
      // The model list spans the card, after the two columns.
      const children = Array.from(card.children).map(c => c.className);
      const at = (/** @type {string} */ cls) => children.findIndex(c => c.split(' ').includes(cls));
      assert(at('account-models') > at('provider-control') && at('provider-control') > at('provider-info'),
        `the card's children are ${JSON.stringify(children)}`);
    } finally {
      restore();
    }
  });

  await run('editing the base URL saves that setting and no other', async () => {
    const { host, ops, restore } = mountTab();
    try {
      const card = await drawn(host, 'custom-acme');
      typeAndLeave(card, 'account-url-input', 'https://other.acme.test/v1');
      const call = await awaitOp(ops, 'save');
      assert(call.toolId === 'accounts' && call.params.id === 'custom-acme', `saved through ${JSON.stringify(call)}`);
      assert(JSON.stringify(call.params.settings) === JSON.stringify({ baseURL: 'https://other.acme.test/v1' }),
        `sent settings ${JSON.stringify(call.params.settings)}, want the URL alone`);
      assert(!('displayName' in call.params), 'a URL edit also wrote the name');
    } finally {
      restore();
    }
  });

  await run('leaving a field untouched saves nothing', async () => {
    const { host, ops, restore } = mountTab();
    try {
      const card = await drawn(host, 'custom-acme');
      typeAndLeave(card, 'account-url-input', 'https://gateway.acme.test/v1');
      await nextTask();
      assert(!ops.some(c => c.operation === 'save'), 'an unchanged field was written');
    } finally {
      restore();
    }
  });

  await run('an endpoint’s key is stored through the account’s own operation', async () => {
    const { host, ops, restore } = mountTab();
    try {
      const card = await drawn(host, 'custom-acme');
      const key = input(card, 'account-key-input');
      key.value = 'sk-typed';
      key.dispatchEvent(new Event('input', { bubbles: true }));
      /** @type {HTMLElement} */ (card.querySelector('.account-key-save')).click();
      const call = await awaitOp(ops, 'setKey');
      assert(call.params.id === 'custom-acme' && call.params.apiKey === 'sk-typed', `sent ${JSON.stringify(call.params)}`);
      assert(!ops.some(c => c.operation === 'save'), 'the key went out with the endpoint definition');
      await waitFor(() => !/** @type {HTMLElement} */ (card.querySelector('.provider-active-badge')).hidden, {
        timeoutMs: budgetFor(2000), description: 'the key to be reported as active',
      });
      assert(!/** @type {HTMLElement} */ (card.querySelector('.account-key-delete')).hidden,
        'a stored key cannot be deleted, though an endpoint may need none');
    } finally {
      restore();
    }
  });

  await run('a key coming from the environment says so, and is not editable here', async () => {
    const { host, restore } = mountTab({ accounts: [endpoint({ keySource: 'env' })] });
    try {
      const card = await drawn(host, 'custom-acme');
      assert(input(card, 'account-key-input').disabled, 'an env key can be overwritten here');
      assert((card.textContent || '').includes('CUSTOM_ACME_API_KEY'), 'the card does not name the variable');
      const chip = card.querySelector('.account-chip-source');
      assert(!!chip && !(/** @type {HTMLElement} */ (chip)).hidden && (chip.textContent || '').includes('CUSTOM_ACME_API_KEY'),
        `the card is not marked as coming from the variable — got ${JSON.stringify(chip?.textContent)}`);
    } finally {
      restore();
    }
  });

  await run('request headers are edited as names and values, and saved as a set', async () => {
    const { host, ops, restore } = mountTab({ accounts: [endpoint({ settings: { baseURL: 'https://a.test/v1', headers: { 'X-Tenant': 'one' } } })] });
    try {
      const card = await drawn(host, 'custom-acme');
      /** @type {HTMLElement} */ (card.querySelector('.account-header-add')).click();
      const rows = card.querySelectorAll('.account-header-row');
      const fresh = rows[rows.length - 1];
      /** @type {HTMLInputElement} */ (fresh.querySelector('.account-header-name')).value = 'X-Route';
      typeAndLeave(fresh, 'account-header-value', 'eu');
      const call = await awaitOp(ops, 'save');
      assert(JSON.stringify(call.params.settings.headers) === JSON.stringify({ 'X-Tenant': 'one', 'X-Route': 'eu' }),
        `sent headers ${JSON.stringify(call.params.settings)}`);
    } finally {
      restore();
    }
  });

  await run('a header with no name is refused rather than silently dropped', async () => {
    const { host, ops, restore } = mountTab();
    try {
      const card = await drawn(host, 'custom-acme');
      /** @type {HTMLElement} */ (card.querySelector('.account-header-add')).click();
      typeAndLeave(card, 'account-header-value', 'orphan');
      await nextTask();
      assert(!ops.some(c => c.operation === 'save'), 'a nameless header was written');
      const status = card.querySelector('.provider-subfield-status[data-kind="error"]');
      assert(!!status && !!status.textContent, 'the refusal gave no reason');
    } finally {
      restore();
    }
  });

  await run('an account that did not register still has a card, and says why', async () => {
    const { host, restore } = mountTab({
      accounts: [endpoint({ registered: false, problem: 'base URL "nope" must start with http:// or https://', settings: { baseURL: 'nope' } })],
      providers: providers().filter(p => p.name !== 'custom-acme'),
    });
    try {
      const card = await drawn(host, 'custom-acme');
      const problem = card.querySelector('.account-problem');
      assert(!!problem && (problem.textContent || '').includes('http://'), `the card does not say why — got "${problem?.textContent}"`);
      assert(input(card, 'account-url-input').value === 'nope', 'the offending URL is not editable');
      assert(!card.querySelector('.settings-model-visibility'), 'an unregistered account offers a model list it cannot have');
    } finally {
      restore();
    }
  });

  await run('renaming saves the name alone and changes nothing else on the page', async () => {
    const { host, ops, scrollWrites, restore } = mountTab();
    try {
      const card = await drawn(host, 'custom-acme');
      const other = cardOf(host, 'claudecode');
      const url = input(card, 'account-url-input');
      pickFromMenu(card, 'Rename');
      const field = input(card, 'account-rename-input');
      assert(field.value === 'Acme Gateway', `the rename field starts at ${JSON.stringify(field.value)}`);
      field.value = 'Acme (EU)';
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      const call = await awaitOp(ops, 'save');
      assert(JSON.stringify(call.params) === JSON.stringify({ id: 'custom-acme', displayName: 'Acme (EU)' }),
        `the rename sent ${JSON.stringify(call.params)}`);
      await waitFor(() => card.querySelector('.provider-name')?.textContent === 'Acme (EU)', {
        timeoutMs: budgetFor(2000), description: 'the card to carry its new name',
      });
      assert(cardOf(host, 'custom-acme') === card && cardOf(host, 'claudecode') === other, 'a rename rebuilt a card');
      assert(input(card, 'account-url-input') === url, 'a rename rebuilt the fields on the card');
      assert(scrollWrites.length === 0, `something scrolled the pane: ${JSON.stringify(scrollWrites)}`);
    } finally {
      restore();
    }
  });

  await run('removing asks plainly, saying how many conversations use the account', async () => {
    const { host, ops, scrollWrites, restore } = mountTab({ usage: 3 });
    const modal = stubModal(true);
    try {
      const card = await drawn(host, 'custom-acme');
      const other = cardOf(host, 'claudecode');
      pickFromMenu(card, 'Remove');
      await awaitOp(ops, 'remove');
      assert(modal.asked && modal.asked.message === 'Remove Acme Gateway? 3 conversations use it.',
        `the confirm read ${JSON.stringify(modal.asked?.message)}`);
      assert(modal.asked.confirmText === 'Remove', `the confirm button reads ${JSON.stringify(modal.asked.confirmText)}`);
      await waitFor(() => !cardOf(host, 'custom-acme'), { timeoutMs: budgetFor(2000), description: 'the card to go' });
      assert(cardOf(host, 'claudecode') === other, 'removing one account rebuilt another');
      assert(scrollWrites.length === 0, `something scrolled the pane: ${JSON.stringify(scrollWrites)}`);
    } finally {
      modal.restore();
      restore();
    }
  });

  await run('an account no conversation uses is removed on a bare question', async () => {
    const { host, ops, restore } = mountTab({ usage: 0 });
    const modal = stubModal(false);
    try {
      pickFromMenu(await drawn(host, 'custom-acme'), 'Remove');
      await waitFor(() => !!modal.asked, { timeoutMs: budgetFor(2000), description: 'the confirm to be asked' });
      assert(modal.asked.message === 'Remove Acme Gateway?', `the confirm read ${JSON.stringify(modal.asked.message)}`);
      await nextTask();
      assert(!ops.some(c => c.operation === 'remove'), 'a declined remove was carried out');
      assert(!!cardOf(host, 'custom-acme'), 'a declined remove took the card');
    } finally {
      modal.restore();
      restore();
    }
  });

  await run('logins on this machine are tiles among the kinds of account, added on a pick and never before', async () => {
    const { host, ops, restore } = mountTab({
      candidates: [
        { key: 'ollama', type: 'ollama', accountId: 'ollama', displayName: 'Ollama', reason: 'removed' },
        { key: 'claudecode:/home/u/.claude-work', type: 'claudecode', accountId: 'claudecode-work', displayName: 'Claude Code (work)', reason: 'found', path: '/home/u/.claude-work', label: 'a@b.test' },
      ],
    });
    try {
      await drawn(host, 'custom-acme');
      const tileFor = (/** @type {string} */ key) => /** @type {HTMLButtonElement|null} */ (host.querySelector(`.account-add .account-type[data-key="${key}"]`));
      await waitFor(() => !!tileFor('ollama'), { timeoutMs: budgetFor(2000), description: 'the removed default offered in the grid' });
      assert(!cardOf(host, 'ollama'), 'a found login was added without being asked');

      // In its kind's group, and offered once: the removed default stands in for
      // its type rather than beside it.
      const grid = [...host.querySelectorAll('.account-types > *')];
      const groupOf = (/** @type {Element} */ el) => {
        const before = grid.slice(0, grid.indexOf(el)).filter(g => g.classList.contains('account-type-group'));
        return before[before.length - 1]?.textContent;
      };
      assert(groupOf(/** @type {Element} */ (tileFor('ollama'))) === 'Local servers', `the removed Ollama sits under ${groupOf(/** @type {Element} */ (tileFor('ollama')))}`);
      assert(!host.querySelector('.account-type[data-type="ollama"]:not([data-key])'), 'Ollama is offered twice: as itself and as its removed account');
      const work = /** @type {HTMLElement} */ (tileFor('claudecode:/home/u/.claude-work'));
      assert(groupOf(work) === 'Subscriptions', `the found Claude Code login sits under ${groupOf(work)}`);
      assert((work.textContent || '').includes('a@b.test') && (work.textContent || '').includes('/home/u/.claude-work'),
        `the found login does not say who or where: ${JSON.stringify(work.textContent)}`);

      /** @type {HTMLElement} */ (tileFor('ollama')).click();
      const call = await awaitOp(ops, 'addCandidate');
      assert(call.params.key === 'ollama', `the pick sent ${JSON.stringify(call.params)}`);
      await drawn(host, 'ollama');
      await waitFor(() => !tileFor('ollama'), { timeoutMs: budgetFor(2000), description: 'the added login to leave the grid' });
      assert(!!tileFor('claudecode:/home/u/.claude-work'), 'adding one login took the other off offer');
    } finally {
      restore();
    }
  });

  await run('adding an account: the kind first, then its form, then a card', async () => {
    const { host, ops, restore } = mountTab();
    try {
      await drawn(host, 'custom-acme');
      await waitFor(() => !!host.querySelector('.account-type'), { timeoutMs: budgetFor(2000), description: 'the type picker' });
      const groups = [...host.querySelectorAll('.account-type-group')].map(g => g.textContent);
      assert(JSON.stringify(groups) === JSON.stringify(['API keys', 'Local servers', 'Custom']),
        `the groups are ${JSON.stringify(groups)}`);
      // Claude Code has its default account and takes no other yet.
      assert(!host.querySelector('.account-type[data-type="claudecode"]'), 'a type that can take no account is offered');

      /** @type {HTMLElement} */ (host.querySelector('.account-type[data-type="anthropic"]')).click();
      await waitFor(() => !!host.querySelector('.account-add-form[data-type="anthropic"]'), {
        timeoutMs: budgetFor(2000), description: 'picking a type to open its form',
      });
      const form = /** @type {HTMLElement} */ (host.querySelector('.account-add-form[data-type="anthropic"]'));
      assert((host.querySelector('.account-add-id')?.textContent || '').includes('anthropic'),
        `the form does not show the id the account takes: ${host.querySelector('.account-add-id')?.textContent}`);
      /** @type {HTMLElement} */ (host.querySelector('.account-add-save')).click();
      await nextTask();
      assert(!ops.some(c => c.operation === 'save'), 'an API-key account was added with no key');

      input(form, 'account-add-key').value = 'sk-ant';
      /** @type {HTMLElement} */ (host.querySelector('.account-add-save')).click();
      const call = await awaitOp(ops, 'save');
      assert(JSON.stringify(call.params) === JSON.stringify({ type: 'anthropic', displayName: 'Anthropic', apiKey: 'sk-ant' }),
        `Add sent ${JSON.stringify(call.params)}`);
      await drawn(host, 'anthropic');
      await waitFor(() => !host.querySelector('.account-add-form') && !!host.querySelector('.account-add .account-types'), {
        timeoutMs: budgetFor(2000), description: 'the form to give way to the kinds of account again',
      });
    } finally {
      restore();
    }
  });

  await run('an endpoint with no URL is refused before anything is written', async () => {
    const { host, ops, restore } = mountTab();
    try {
      await drawn(host, 'custom-acme');
      await waitFor(() => !!host.querySelector(`.account-type[data-type="${ENDPOINT_TYPE}"]`), {
        timeoutMs: budgetFor(2000), description: 'the type picker',
      });
      /** @type {HTMLElement} */ (host.querySelector(`.account-type[data-type="${ENDPOINT_TYPE}"]`)).click();
      await waitFor(() => !!host.querySelector('.account-add-name'), { timeoutMs: budgetFor(2000), description: 'the endpoint form' });
      input(host, 'account-add-name').value = 'Acme';
      /** @type {HTMLElement} */ (host.querySelector('.account-add-save')).click();
      await nextTask();
      assert(!ops.some(c => c.operation === 'save'), 'an endpoint with no URL was written anyway');
      const status = host.querySelector('.provider-subfield-status[data-kind="error"]');
      assert(!!status && !!status.textContent, 'the form gave no reason for refusing');
    } finally {
      restore();
    }
  });

  await run('naming a provider the catalogue knows fills in its base URL', async () => {
    const { host, restore } = mountTab({
      catalog: [
        { id: 'baseten', name: 'Baseten', api: 'https://inference.baseten.co/v1' },
        { id: 'chutes', name: 'Chutes', api: 'https://llm.chutes.ai/v1' },
      ],
    });
    try {
      await drawn(host, 'custom-acme');
      await waitFor(() => !!host.querySelector(`.account-type[data-type="${ENDPOINT_TYPE}"]`), {
        timeoutMs: budgetFor(2000), description: 'the type picker',
      });
      /** @type {HTMLElement} */ (host.querySelector(`.account-type[data-type="${ENDPOINT_TYPE}"]`)).click();
      await waitFor(() => !!host.querySelector('.account-add-name'), { timeoutMs: budgetFor(2000), description: 'the endpoint form' });
      const name = input(host, 'account-add-name');
      const url = input(host, 'account-add-url');
      await waitFor(() => (name.list?.options.length ?? 0) === 2, {
        timeoutMs: budgetFor(2000), description: 'the name field to offer the catalogued providers',
      });
      const type = (/** @type {string} */ value) => {
        name.value = value;
        name.dispatchEvent(new Event('input', { bubbles: true }));
      };
      type('baseten');
      assert(url.value === 'https://inference.baseten.co/v1', `naming Baseten filled ${JSON.stringify(url.value)}`);
      type('Chutes');
      assert(url.value === 'https://llm.chutes.ai/v1', `a filled-in URL did not follow the name: ${JSON.stringify(url.value)}`);
      type('Chutes Lab');
      assert(url.value === '', `a filled-in URL outlived the name that chose it: ${JSON.stringify(url.value)}`);
      url.value = 'https://proxy.internal/v1';
      type('Baseten');
      assert(url.value === 'https://proxy.internal/v1', `a typed URL was replaced: ${JSON.stringify(url.value)}`);
    } finally {
      restore();
    }
  });

  await run('the id a new account shows is the server’s latest answer, never an overtaken one', async () => {
    /** @type {Array<{params: any, answer: (preview: any) => void}>} */
    const asked = [];
    const { host, restore } = mountTab({
      preview: (params) => new Promise((answer) => { asked.push({ params, answer }); }),
    });
    try {
      await drawn(host, 'custom-acme');
      await waitFor(() => !!host.querySelector('.account-type[data-type="anthropic"]'), {
        timeoutMs: budgetFor(2000), description: 'the type picker',
      });
      /** @type {HTMLElement} */ (host.querySelector('.account-type[data-type="anthropic"]')).click();
      await waitFor(() => asked.length === 1, { timeoutMs: budgetFor(2000), description: 'the form to ask what an add makes' });
      asked[0].answer({ id: 'anthropic-2', displayName: 'Anthropic (2)', isDefault: false });
      await waitFor(() => !!host.querySelector('.account-add-name'), { timeoutMs: budgetFor(2000), description: 'the form' });
      const name = input(host, 'account-add-name');
      const idLine = () => host.querySelector('.account-add-id')?.textContent || '';
      assert(name.value === 'Anthropic (2)' && idLine().includes('anthropic-2'),
        `the form opened as ${JSON.stringify(name.value)} with ${JSON.stringify(idLine())}`);

      const type = (/** @type {string} */ value) => {
        name.value = value;
        name.dispatchEvent(new Event('input', { bubbles: true }));
      };
      type('Anthropic (t)');
      type('Anthropic (team)');
      await waitFor(() => asked.length === 3, { timeoutMs: budgetFor(2000), description: 'a preview per keystroke' });
      asked[2].answer({ id: 'anthropic-team', displayName: 'Anthropic (team)', isDefault: false });
      await waitFor(() => idLine().includes('anthropic-team'), { timeoutMs: budgetFor(2000), description: 'the latest id' });
      asked[1].answer({ id: 'anthropic-t', displayName: 'Anthropic (t)', isDefault: false });
      await nextTask();
      assert(idLine().includes('anthropic-team') && !idLine().includes('anthropic-t.'),
        `an overtaken answer replaced the latest: ${JSON.stringify(idLine())}`);
    } finally {
      restore();
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
        const fail = { config: false, settings: false, switch: true, ops: false };
        let startOK = false;
        const ok = (/** @type {any} */ body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
        const bad = (/** @type {any} */ body) => ({
          ok: false, status: 500, statusText: '', json: async () => body, text: async () => (body ? JSON.stringify(body) : ''),
        });
        const accounts = () => [
          // API key: none set, one stored, one from the environment.
          { id: 'p1', type: 'p1', typeDisplayName: '1', displayName: '1', isDefault: true, keySource: '', registered: true },
          { id: 'p2', type: 'p2', typeDisplayName: '2', displayName: '20', isDefault: true, keySource: 'credentials', registered: true },
          { id: 'p3', type: 'p3', typeDisplayName: '3', displayName: '3', isDefault: true, keySource: 'env', envVarName: '9', registered: true },
          // OAuth: signed in (with who), signed out, the device flow both ways.
          { id: 'p4', type: 'p4', typeDisplayName: '4', displayName: '4', isDefault: true, keySource: 'codex_cli', accountLabel: '1@2', registered: true },
          { id: 'p5', type: 'p5', typeDisplayName: '5', displayName: '5', isDefault: true, registered: true },
          { id: 'p6', type: 'p6', typeDisplayName: '6', displayName: '6', isDefault: true, registered: true },
          { id: 'p7', type: 'p7', typeDisplayName: '7', displayName: '7', isDefault: true, registered: true },
          // Keyless: a hint, a switch, the host and path rows.
          { id: 'p9', type: 'p9', typeDisplayName: '9', displayName: '9', isDefault: true, registered: true },
          { id: 'p10', type: 'p10', typeDisplayName: '10', displayName: '10', isDefault: true, registered: true },
          { id: 'ollama', type: 'ollama', typeDisplayName: '12', displayName: '12', isDefault: true, registered: true },
          { id: 'claudecode', type: 'claudecode', typeDisplayName: '13', displayName: '13', isDefault: true, registered: true },
          // An endpoint, and an account this build cannot use.
          { id: 'custom-1', type: ENDPOINT_TYPE, typeDisplayName: '15', displayName: '16', keySource: 'credentials', registered: true, settings: { baseURL: 'https://1.2.3.4/', headers: { 1: '2' } } },
          { id: 'p2-2', type: 'p2', typeDisplayName: '2', displayName: '21', registered: false, problem: 'This version of Juggler cannot use this account.', problemMessage: { key: 'This version of Juggler cannot use this account.' } },
        ];
        const list = {
          accounts: accounts(),
          candidates: [
            { key: 'p14', type: 'p14', accountId: 'p14', displayName: '14', reason: 'removed' },
            { key: 'custom-2', type: ENDPOINT_TYPE, accountId: 'custom-2', displayName: '17', reason: 'switched-off' },
            { key: 'p5:/1', type: 'p5', accountId: 'p5-1', reason: 'found', path: '/1', label: '2' },
          ],
        };
        const typeList = [
          { name: 'p1', displayName: '1', category: 'api_key', hasDefaultAccount: true, acceptsExtra: true },
          { name: 'p5', displayName: '5', category: 'subscription', hasDefaultAccount: true, acceptsExtra: true },
          { name: 'p18', displayName: '18', category: 'local', hasDefaultAccount: true, acceptsExtra: false },
          { name: 'p14', displayName: '14', category: 'local', hasDefaultAccount: true, acceptsExtra: false },
          {
            name: ENDPOINT_TYPE, displayName: '15', category: 'custom', hasDefaultAccount: false, acceptsExtra: true,
            // The server's own blurb, sent as the message it was rendered from.
            description: 'A gateway, a tenant or a server speaking the OpenAI API',
            descriptionMessage: { key: 'A gateway, a tenant or a server speaking the OpenAI API' },
          },
        ];
        // Every failure the server reports is the digit 7; a switch failure says
        // nothing at all, so the tab's own fallback is what shows.
        window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
          const u = String(url);
          const method = (init && init.method) || 'GET';
          calls.push(`${method} ${u}`);
          if (u.includes('/api/ops/call')) {
            const body = JSON.parse(init.body);
            if (body.operation === 'types') return ok({ success: true, data: { types: typeList } });
            if (body.operation === 'preview') return ok({ success: true, data: { id: body.params.type === ENDPOINT_TYPE ? 'custom-2' : `${body.params.type}-2`, displayName: '', isDefault: false } });
            if (body.operation === 'usage') return ok({ success: true, data: { conversations: 2 } });
            if (body.operation === 'catalog') return ok({ success: true, data: { providers: [] } });
            if (fail.ops && body.operation !== 'list') return ok({ success: false, error: '7' });
            return ok({ success: true, data: { id: 'p1', ...list } });
          }
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
          return options.type === 'confirm' ? !options.message?.includes('20') : undefined;
        };

        const models = () => [
          { id: '1', contextWindow: 1000, maxOutputTokens: 100 },
          { id: '2', contextWindow: 1500, maxOutputTokens: 150, providerContextWindow: 1000, providerMaxOutputTokens: 100 },
          { id: '3', contextWindow: 1200, maxOutputTokens: 120, fromAPI: true },
          { id: '4', contextWindow: 512, maxOutputTokens: 100, windowAssumed: true },
        ];
        const providers = () => [
          { name: 'p1', displayName: '1', description: '2', configKeyName: 'p1_key', apiKeyURL: 'https://1.2.3.4/', keySource: '', envVarName: '', modelsWithContext: models() },
          { name: 'p2', displayName: '20', configKeyName: 'p2_key', keySource: 'credentials', envVarName: '8', modelsWithContext: [] },
          { name: 'p3', displayName: '3', configKeyName: 'p3_key', keySource: 'env', envVarName: '9', modelsWithContext: [] },
          { name: 'p4', displayName: '4', authType: 'oauth_bearer', available: true, modelsWithContext: [] },
          { name: 'p5', displayName: '5', authType: 'oauth_bearer', available: false },
          { name: 'p6', displayName: '6', authType: 'oauth_bearer', available: false, signInMethod: 'github_device' },
          { name: 'p7', displayName: '7', authType: 'oauth_bearer', available: true, signInMethod: 'github_device' },
          { name: 'p9', displayName: '9', configKeyName: '', credentialed: true, authHint: '5' },
          { name: 'p10', displayName: '10', configKeyName: '', credentialed: true, switchTo: { reason: '6', displayName: '11' } },
          { name: 'ollama', displayName: '12', configKeyName: '', credentialed: true },
          { name: 'claudecode', displayName: '13', configKeyName: '', credentialed: true },
          { name: 'p18', displayName: '18', configKeyName: '', credentialed: false },
          { name: 'custom-1', displayName: '16', configKeyName: 'custom_1_api_key', available: false, authHint: '19', modelsWithContext: [] },
        ];

        document.body.appendChild(host);
        /** @type {string[]} */
        const transient = [];
        // Every string the tab ever shows, so the transient ones (Saving…,
        // Checking…, Starting…, Switching…) are judged too. A string with no
        // letters in it is data, not English.
        const literal = '#ollama-host-input, .account-copilot-host, .account-url-input, .account-header-name, .account-add-url';
        // The ⋯ and × glyphs, and the lines that carry an id or a name with
        // letters in it, are checked by hand below.
        const skip = '.provider-name, .provider-description, .account-id, .account-problem, .account-chip:not(.account-chip-source), '
          + '.account-type-name, .account-type-description, .account-type-detail, .account-add-id, '
          + '.account-menu-button, .account-add-back, .account-header-remove, .settings-model-visibility-name, .settings-model-visibility-count, '
          + `.model-limit-input, .provider-switch-reason, [data-provider="p9"] .account-status, ${literal}`;
        observer = new MutationObserver(() => {
          for (const s of shownStrings(host, skip)) {
            const text = strip(s);
            if (/[A-Za-z]/.test(text) && !isPseudoLocalized(text) && !transient.includes(s)) transient.push(s);
          }
        });
        observer.observe(host, { subtree: true, childList: true, characterData: true, attributes: true });

        tab = new ProvidersTab(host);
        host.loadConfig = async () => true;
        tab.onConfigLoaded({ config: { keys: { p2: true } }, providers: providers() }, true);
        await waitFor(() => !!tab.accountList && !!cardOf(host, 'custom-1') && !!host.querySelector('.account-type-found'), {
          timeoutMs: budgetFor(2000), description: 'the accounts and the found logins to be drawn',
        });

        // Names, descriptions, ids, model ids, numbers and addresses are data;
        // their elements' own labels are checked one by one below.
        /**
         * Every element matching selector carries attr as a message.
         * @param {string} selector
         * @param {string} attr
         * @param {string} where
         */
        const checkAttr = (selector, attr, where) => {
          const nodes = [...host.querySelectorAll(selector)];
          assert(nodes.length > 0, `nothing matches ${selector} (${where})`);
          for (const node of nodes) {
            const v = node.getAttribute(attr) || '';
            assert(isPseudoLocalized(v), `${selector} ${attr} is plain English (${where}): ${JSON.stringify(v)}`);
          }
        };
        /**
         * Every limit field's title and aria-label is a message.
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
          const tenant = host.querySelector('.account-copilot-host')?.getAttribute('placeholder') || '';
          assert(tenant.includes('github.com') && isPseudoLocalized(tenant.replace('github.com', '')),
            `the GitHub host placeholder is plain English (${where}): ${JSON.stringify(tenant)}`);
        };
        const dialogCount = (/** @type {number} */ n, /** @type {string} */ description) =>
          waitFor(() => dialogs.length >= n, { timeoutMs: budgetFor(4000), description });
        const inCard = (/** @type {string} */ id, /** @type {string} */ selector) =>
          /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (cardOf(host, id)).querySelector(selector));
        /**
         * Wait for a card's field to report a failure on its status line.
         * @param {string} id - The account.
         * @param {string} description - What failed.
         * @returns {Promise<void>} Resolves once it does.
         */
        const fieldRefused = (id, description) => waitFor(
          () => !!/** @type {HTMLElement} */ (cardOf(host, id)).querySelector('.provider-subfield-status[data-kind="error"]'),
          { timeoutMs: budgetFor(2000), description });

        check('as drawn');
        checkAttr('.account-menu-button', 'aria-label', 'as drawn');
        checkAttr('.account-header-remove', 'aria-label', 'as drawn');
        assert(!!inCard('p4', '.account-status') && !!inCard('p5', '.account-status'),
          'the OAuth status lines were not drawn');
        assert(!!host.querySelector('.provider-switch-notice'), 'the switch notice was not drawn');
        assert(!!host.querySelector('#claudecode-binary-input'), 'the Claude Code path row was not drawn');
        assert(!!host.querySelector('.model-window-assumed'), 'the assumed marker was not drawn');
        assert(!!host.querySelector('.account-label:not([hidden])'), 'who is signed in was not drawn');
        const why = cardOf(host, 'p2-2')?.querySelector('.account-problem')?.textContent || '';
        assert(isPseudoLocalized(why), `the unusable account does not say why in the reader's language: ${JSON.stringify(why)}`);

        // A key typed, then refused.
        fail.ops = true;
        const key = /** @type {HTMLInputElement} */ (host.querySelector('#p1-key'));
        key.value = '0';
        key.dispatchEvent(new Event('input'));
        check('key typed');
        inCard('p1', '.account-key-save').click();
        await fieldRefused('p1', 'the refused key to say so');
        fail.ops = false;

        // The model list: a model hidden, then a limit and a hide that fail.
        const list1 = /** @type {HTMLDetailsElement} */ (cardOf(host, 'p1')?.querySelector('details.settings-model-visibility'));
        assert(list1.open, 'a list with an assumed window did not open');
        const box = /** @type {HTMLInputElement} */ (list1.querySelector('[data-model="1"] .settings-model-visibility-check'));
        box.checked = false;
        box.dispatchEvent(new Event('change'));
        await nextTask();
        const count = list1.querySelector('.settings-model-visibility-count')?.textContent || '';
        assert(isPseudoLocalized(count), `the shown count is plain English: ${JSON.stringify(count)}`);
        fail.settings = true;
        const limit = /** @type {HTMLInputElement} */ (list1.querySelector('[data-model="1"] [data-limit="contextWindow"]'));
        limit.value = '2000';
        limit.dispatchEvent(new Event('change'));
        const status = /** @type {HTMLElement} */ (list1.querySelector('.settings-model-visibility-status'));
        await waitFor(() => !status.hidden, { timeoutMs: budgetFor(2000), description: 'the limit save to fail' });
        const limitError = status.textContent;
        assert(isPseudoLocalized(limitError || ''), `the limit failure is plain English: ${JSON.stringify(limitError)}`);
        fail.settings = false;
        const filter = /** @type {HTMLInputElement} */ (list1.querySelector('.settings-model-visibility-filter'));
        filter.value = '0';
        filter.dispatchEvent(new Event('input'));
        check('model list filtered to nothing');

        // A host saved, cleared and refused; a CLI path saved, cleared and refused.
        for (const [id, values] of /** @type {Array<[string, string[]]>} */ ([
          ['#ollama-host-input', ['1.2.3.4', '', '5.6.7.8']],
          ['#claudecode-binary-input', ['/1/2', '', '/3']],
        ])) {
          const field = /** @type {HTMLInputElement} */ (host.querySelector(id));
          const line = /** @type {HTMLElement} */ (field.closest('.provider-input-wrapper')?.nextElementSibling);
          for (const [i, value] of values.entries()) {
            fail.config = i === 2;
            const before = line.textContent;
            field.value = value;
            field.dispatchEvent(new Event('blur'));
            await waitFor(() => !!line.textContent && line.textContent !== before && !line.textContent.includes('\u2026'), {
              timeoutMs: budgetFor(2000), description: `${id} to report ${JSON.stringify(value)}`,
            });
          }
        }
        fail.config = false;

        // The GitHub device flow: a host refused, a sign-in that cannot start,
        // one GitHub denies, and a sign-out that fails.
        const hostInput = /** @type {HTMLInputElement} */ (inCard('p6', '.account-copilot-host'));
        hostInput.value = '1.2.3.4';
        hostInput.dispatchEvent(new Event('blur'));
        await fieldRefused('p6', 'the refused host to say so');
        hostInput.value = 'github.com';
        inCard('p6', '.provider-control .btn-primary').click();
        await dialogCount(1, 'the sign-in that could not start to be reported');
        startOK = true;
        inCard('p6', '.provider-control .btn-primary').click();
        await dialogCount(2, 'the denied sign-in to be reported');
        inCard('p7', '.provider-control .btn-danger').click();
        await dialogCount(4, 'the sign-out to be confirmed, then its failure reported');

        // An endpoint's settings and key, saved and refused.
        const endpointCard = /** @type {HTMLElement} */ (cardOf(host, 'custom-1'));
        fail.ops = true;
        typeAndLeave(endpointCard, 'account-url-input', 'https://5.6.7.8/');
        await waitFor(() => !!endpointCard.querySelector('.provider-subfield-status[data-kind="error"]'), {
          timeoutMs: budgetFor(2000), description: 'the refused URL to say so',
        });
        /** @type {HTMLElement} */ (endpointCard.querySelector('.account-key-delete')).click();
        fail.ops = false;
        check('endpoint saves refused');

        // Re-checking a sign-in, and a keyless provider's status.
        for (const name of ['p4', 'p9']) {
          const before = calls.length;
          inCard(name, '.settings-recheck-btn').click();
          await waitFor(() => calls.slice(before).some(c => c.endsWith('/providers/refresh')), {
            timeoutMs: budgetFor(2000), description: `${name}'s re-check to ask for a refresh`,
          });
          wsService._emit('providers-update', providers());
          await waitFor(() => !host.querySelector('.settings-recheck-btn.spinning'), {
            timeoutMs: budgetFor(2000), description: `${name}'s re-check to finish`,
          });
        }

        // Rename, and Remove both ways: declined (it names conversations), and
        // carried out but refused.
        inCard('p3', '.account-menu-button').click();
        const menuRows = [...document.querySelectorAll('.account-menu .menu-item')];
        assert(menuRows.length === 2 && menuRows.every(el => isPseudoLocalized(el.textContent || '')),
          `the ⋯ menu is plain English: ${JSON.stringify(menuRows.map(el => el.textContent))}`);
        /** @type {HTMLElement} */ (menuRows[0]).click();
        check('renaming');
        /** @type {HTMLInputElement} */ (host.querySelector('.account-rename-input')).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        pickFromMenu(/** @type {HTMLElement} */ (cardOf(host, 'p2')), 'Remove');
        await dialogCount(5, 'the remove confirm');
        fail.ops = true;
        pickFromMenu(/** @type {HTMLElement} */ (cardOf(host, 'p3')), 'Remove');
        await dialogCount(7, 'the remove to be confirmed, then its failure reported');
        fail.ops = false;

        // Found: what each login on offer says about itself, and an add refused.
        const found = [...host.querySelectorAll('.account-type-found')];
        const titles = found.map(el => el.querySelector('.account-type-name')?.textContent || '');
        assert(titles.some(s => s.includes('·') && isPseudoLocalized(s)), `a found login's title is plain English: ${JSON.stringify(titles)}`);
        const offeredWhy = found.map(el => el.querySelector('.account-type-description')?.textContent || '');
        assert(offeredWhy.length === 3 && offeredWhy.every(s => isPseudoLocalized(s)),
          `a login on offer says why in plain English: ${JSON.stringify(offeredWhy)}`);
        fail.ops = true;
        /** @type {HTMLElement} */ (found[0]).click();
        await dialogCount(8, 'the refused add to be reported');
        fail.ops = false;

        // Add an account: the grid, an API-key form refused for want of a key,
        // an endpoint's form refused for want of a URL, and an OAuth type's form.
        await waitFor(() => !!host.querySelector('.account-type'), { timeoutMs: budgetFor(2000), description: 'the type picker' });
        check('type picker');
        const blurb = host.querySelector(`.account-type[data-type="${ENDPOINT_TYPE}"]:not([data-key]) .account-type-description`)?.textContent || '';
        assert(isPseudoLocalized(blurb), `the endpoint type's blurb is plain English: ${JSON.stringify(blurb)}`);
        for (const type of ['p1', ENDPOINT_TYPE, 'p5', 'p18']) {
          /** @type {HTMLElement} */ (host.querySelector(`.account-type[data-type="${type}"]:not([data-key])`)).click();
          await waitFor(() => !!host.querySelector(`.account-add-form[data-type="${type}"]`), {
            timeoutMs: budgetFor(2000), description: `${type}'s form`,
          });
          const idLine = host.querySelector('.account-add-id')?.textContent || '';
          assert(isPseudoLocalized(idLine.replace(/(p\d+|custom)(-\d+)?/, '')),
            `the ${type} form's id line is plain English: ${JSON.stringify(idLine)}`);
          if (type === 'p1' || type === ENDPOINT_TYPE) {
            /** @type {HTMLElement} */ (host.querySelector('.account-add-save')).click();
            await waitFor(() => !!host.querySelector('.account-add .provider-subfield-status[data-kind="error"]'), {
              timeoutMs: budgetFor(2000), description: `${type}'s form to refuse`,
            });
          }
          check(`${type} form`);
          checkAttr('.account-add-back', 'aria-label', `${type} form`);
          /** @type {HTMLElement} */ (host.querySelector('.account-add-back')).click();
        }
        /** @type {HTMLElement} */ (host.querySelector('.account-type[data-type="p5"]:not([data-key])')).click();
        await waitFor(() => !!host.querySelector('.account-add-save'), { timeoutMs: budgetFor(2000), description: 'p5\'s form' });
        fail.ops = true;
        /** @type {HTMLElement} */ (host.querySelector('.account-add-save')).click();
        await waitFor(() => !!host.querySelector('.account-add-status')?.textContent, {
          timeoutMs: budgetFor(2000), description: 'the refused add to say so',
        });
        fail.ops = false;
        check('add refused');
        /** @type {HTMLElement} */ (host.querySelector('.account-add-cancel')).click();

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
        const rawDialogs = dialogs.flatMap(d => [d.title, d.message, d.confirmText].filter(Boolean))
          .filter(s => s !== 'GitHub Copilot' && !isPseudoLocalized(String(s).replace(/: 7$/, '').replace(/ 7$/, '')));
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
