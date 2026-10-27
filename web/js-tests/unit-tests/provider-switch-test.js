//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Switching to the provider a server is really for — UI tests.
 *
 * A provider can publish `switchTo`: another provider that understands the
 * server it is pointed at better. The case is LocalAI pointed at LM Studio. It
 * lists LM Studio's models but can read none of their context windows, so every
 * one is assumed to be 8192 tokens and nothing on screen says that the provider
 * is the wrong one.
 *
 * Pinned here: the provider's settings card says so and offers the switch, and
 * only when the provider publishes one; the button asks the server for the
 * switch by the provider's name; and the model picker offers the same switch on
 * the current model's card, moving the conversation onto the same model under
 * the new provider.
 * @module unit-tests/provider-switch-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import wsService from '../../js/services/websocket.js';
import { ProvidersTab } from '../../js/components/settings/providers-tab.js';
import '../../js/components/model-picker/model-picker.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

const SWITCH = {
  provider: 'lmstudio',
  displayName: 'LM Studio (local)',
  reason: "This server is LM Studio, not LocalAI. LocalAI can't read LM Studio's context windows, so every model here is assumed to have 8192 tokens.",
};

/**
 * Route window.fetch to a backend that accepts the switch.
 * @param {{reject?: boolean}} [opts] - `reject` fails the switch with a 409.
 * @returns {{restore: () => void, calls: Array<{method: string, url: string, body: any}>}} Fake backend.
 */
function installFetch(opts = {}) {
  const orig = window.fetch;
  /** @type {Array<{method: string, url: string, body: any}>} */
  const calls = [];
  window.fetch = /** @type {any} */ (async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url: u, body });
    if (u === '/api/providers/switch' && method === 'POST') {
      if (opts.reject) {
        const error = { error: 'LocalAI (local) no longer needs switching.' };
        return { ok: false, status: 409, text: async () => JSON.stringify(error), json: async () => error };
      }
      return { ok: true, json: async () => ({ success: true, provider: 'lmstudio' }) };
    }
    return { ok: true, json: async () => ({}) };
  });
  return { restore: () => { window.fetch = orig; }, calls };
}

/**
 * Let non-awaitable async chains settle, via MessageChannel rather than
 * `setTimeout(0)` (see model-limits-test.js for why).
 * @returns {Promise<void>} Resolves once the queued chains have run.
 */
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => { channel.port1.close(); resolve(undefined); };
      channel.port2.postMessage(undefined);
    });
  }
};

/**
 * LocalAI as the server publishes it when it is pointed at LM Studio.
 * @param {boolean} withSwitch - Whether it names a successor.
 * @returns {any} A provider status object.
 */
function localAI(withSwitch) {
  return {
    name: 'localai',
    displayName: 'LocalAI (local)',
    description: '',
    authType: 'toggle',
    configKeyName: '',
    envVarName: '',
    apiKeyURL: '',
    keySource: '',
    available: true,
    credentialed: true,
    ...(withSwitch ? { switchTo: SWITCH } : {}),
    modelsWithContext: [{ id: 'qwen3.6-35b-a3b-mtp', contextWindow: 8192, maxOutputTokens: 1638, windowAssumed: true }],
  };
}

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Aggregated test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => Promise<void>} fn
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

  /**
   * Render a ProvidersTab holding one provider, run body, then clean up.
   * @param {any} provider
   * @param {{reject?: boolean}} opts
   * @param {(host: HTMLElement, backend: ReturnType<typeof installFetch>) => Promise<void>} body
   */
  const withTab = async (provider, opts, body) => {
    const backend = installFetch(opts);
    const host = document.createElement('div');
    const container = document.createElement('div');
    container.id = 'provider-fields-container';
    host.appendChild(container);
    document.body.appendChild(host);
    try {
      const tab = new ProvidersTab(/** @type {any} */ (host));
      /** @type {any} */ (tab).providers = [provider];
      /** @type {any} */ (tab).config = {};
      tab.renderProviderFields();
      await body(host, backend);
    } finally {
      host.remove();
      backend.restore();
    }
  };

  /**
   * @param {ReturnType<typeof installFetch>} backend
   * @returns {Array<any>} Bodies of the switch requests made.
   */
  const switchCalls = (backend) => backend.calls
    .filter((c) => c.url === '/api/providers/switch' && c.method === 'POST')
    .map((c) => c.body);

  await run('the settings card says the server is the wrong kind and offers the switch', async () => {
    await withTab(localAI(true), {}, async (host, backend) => {
      const notice = host.querySelector('[data-provider="localai"] .provider-switch-notice');
      assert(notice, 'no switch notice on a provider that publishes switchTo');
      assert((notice.textContent || '').includes(SWITCH.reason), `the notice does not give the reason: ${notice.textContent}`);
      const button = /** @type {HTMLButtonElement|null} */ (notice.querySelector('button'));
      assert(button && /Switch to LM Studio \(local\)/.test(button.textContent || ''),
        `the button should name the provider it switches to; got ${JSON.stringify(button?.textContent)}`);

      button.click();
      await settle();
      const sent = switchCalls(backend);
      assert(sent.length === 1 && sent[0].from === 'localai',
        `the switch request was ${JSON.stringify(sent)}, want one naming localai`);

      // A recompute that started before the switch can publish first; the card
      // waits for the list that shows the switch, and is redrawn from that.
      wsService._emit('providers-update', [localAI(true)]);
      await settle();
      assert(host.querySelector('.provider-switch-notice'), 'a stale list was taken for the switched one');
      const off = localAI(false);
      off.credentialed = false;
      off.available = false;
      wsService._emit('providers-update', [off]);
      // The card redraws once the switch request has answered AND this list has
      // arrived, which is more async hops than any fixed number of ticks.
      await waitFor(() => !host.querySelector('.provider-switch-notice'),
        { description: 'the card to be redrawn from the switched list, without the notice' });
      const toggle = /** @type {HTMLInputElement|null} */ (host.querySelector('#localai-toggle'));
      assert(toggle && !toggle.checked, 'LocalAI still reads as switched on after the switch');
    });
  });

  await run('a provider with nothing better to switch to shows no notice', async () => {
    await withTab(localAI(false), {}, async (host) => {
      assert(!host.querySelector('.provider-switch-notice'), 'a switch was offered with no successor published');
    });
  });

  await run('a refused switch says why and can be tried again', async () => {
    await withTab(localAI(true), { reject: true }, async (host) => {
      const notice = host.querySelector('.provider-switch-notice');
      const button = /** @type {HTMLButtonElement} */ (notice.querySelector('button'));
      button.click();
      await settle();
      assert(!button.disabled, 'the button stayed disabled after a failed switch');
      const status = notice.querySelector('.provider-switch-status');
      assert(status && /no longer needs switching/.test(status.textContent || ''),
        `the failure is not shown; got ${JSON.stringify(status?.textContent)}`);
    });
  });

  // The picker is where the user meets the assumed window, so it offers the
  // same switch — and moves the conversation along with it: the model id is
  // the server's own, so it names the same model under either provider.
  await run('the picker offers the switch and moves this conversation onto the new provider', async () => {
    const backend = installFetch();
    // Rendered once and never connected, as the picker's own suite drives it:
    // connecting renders and wires it, so a second render() would wire it twice.
    const el = /** @type {any} */ (document.createElement('model-picker'));
    try {
      el.providers = [localAI(true)];
      el.value = { provider: 'localai', model: 'qwen3.6-35b-a3b-mtp' };
      el.render();
      /** @type {any[]} */
      const picked = [];
      el.addEventListener('change', (/** @type {CustomEvent} */ e) => picked.push(e.detail));

      const button = /** @type {HTMLButtonElement|null} */ (el.querySelector('.model-provider-switch'));
      assert(button, 'the current-model card offers no switch');
      assert(/LM Studio \(local\)/.test(button.textContent || '') || /LM Studio \(local\)/.test(button.closest('.model-current-switch')?.textContent || ''),
        'the card does not name the provider it would switch to');
      button.click();
      await settle();

      const sent = switchCalls(backend);
      assert(sent.length === 1 && sent[0].from === 'localai', `switch request was ${JSON.stringify(sent)}`);
      assert(picked.length === 1 && picked[0]?.provider === 'lmstudio' && picked[0]?.model === 'qwen3.6-35b-a3b-mtp',
        `the conversation was moved to ${JSON.stringify(picked)}, want lmstudio/qwen3.6-35b-a3b-mtp`);

      const plain = /** @type {any} */ (document.createElement('model-picker'));
      plain.providers = [localAI(false)];
      plain.value = { provider: 'localai', model: 'qwen3.6-35b-a3b-mtp' };
      plain.render();
      assert(!plain.querySelector('.model-provider-switch'), 'the switch is offered with no successor published');
    } finally {
      backend.restore();
    }
  });

  return { passed, failed, errors };
}
