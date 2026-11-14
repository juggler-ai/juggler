//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Sign-in state on the card of a CLI or a login-backed account.
 *
 * An account that is there but cannot serve a turn — a CLI installed and added
 * but not signed in, a subscription whose login lapsed — has its models gone
 * from the menu, and without a word on its card the first news of it is a
 * failed turn. So such a card shows the hint the server sends, with a re-check.
 * Being unusable never takes the card away: that is what Remove is for, and an
 * expired sign-in must not look like something the user removed.
 * @module unit-tests/keyless-signin-status-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import { budgetFor } from '../utilities/test-deadline.js';
import wsService from '../../js/services/websocket.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { underPseudoLocale } from '../utilities/pseudo-locale.js';
import '../../js/components/settings-panel.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

const SIGN_IN_HINT = "Claude Code isn't signed in. Run claude in a terminal and use /login.";
const NOT_INSTALLED_HINT = 'Claude Code CLI not found — install it, or enter the path to claude.';

/**
 * A keyless provider row, in whichever of the three states a test needs.
 * @param {{available: boolean, credentialed: boolean, authHint?: string}} state - Row state
 * @returns {any} A provider entry shaped like /api/providers serves one
 */
function keylessProvider(state) {
  return {
    name: 'fake-cli',
    displayName: 'Fake CLI',
    description: 'Stands in for a CLI-backed provider.',
    authType: 'toggle',
    // An empty configKeyName is what routes a provider to the keyless field.
    configKeyName: '',
    envVarName: '',
    apiKeyURL: '',
    keySource: '',
    available: state.available,
    credentialed: state.credentialed,
    authHint: state.authHint || '',
    modelsWithContext: [{ id: 'fake-model', contextWindow: 1000, maxOutputTokens: 100, fromAPI: false }],
  };
}

/**
 * One account per provider, as the accounts list op reports them.
 * @param {any[]} providers - The providers that are accounts
 * @returns {any[]} The accounts
 */
function accountsOf(providers) {
  return providers.map((p) => ({
    id: p.name, type: p.name, typeDisplayName: p.displayName, displayName: p.displayName,
    isDefault: true, keySource: p.keySource, registered: true,
  }));
}

/**
 * Install a fake backend for the endpoints the settings panel's load fans out
 * over.
 * @param {any[]} providers - The provider list to serve
 * @param {any[]} accounts - The account list to serve
 * @returns {{restore: () => void}} Handle for cleanup
 */
function installFetch(providers, accounts) {
  const orig = window.fetch;
  window.fetch = /** @type {any} */ (async (url) => {
    const u = String(url);
    const ok = (/** @type {any} */ body) => ({ ok: true, status: 200, json: async () => body });
    if (u === '/api/config') return ok({ configDir: '/tmp/juggler-test' });
    if (u === '/api/providers') return ok({ providers, ready: true });
    if (u === '/api/default-model') return ok({ provider: 'fake-cli', model: 'fake-model' });
    if (u === '/api/cheap-model') return ok({ provider: 'fake-cli', model: 'fake-model' });
    if (u.includes('/api/ops/call')) {
      return ok({ success: true, data: { accounts, candidates: [], dismissed: [], types: [] } });
    }
    if (u === '/api/connectivity') {
      return ok({ clientCount: 0, clients: [] });
    }
    return { ok: false, status: 404, statusText: 'Not Found', text: async () => '', json: async () => ({}) };
  });
  return { restore: () => { window.fetch = orig; } };
}

/**
 * Run keyless sign-in status tests.
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Aggregated test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test case name
   * @param {() => Promise<void>} fn - Test case body
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
   * Mount a settings-panel showing one provider in the given state.
   * @param {any} provider - The provider entry to render
   * @param {(el: any) => Promise<void>} body - Assertions against the open panel
   * @param {boolean} [isAccount] - Whether the account list names it
   */
  const withPanel = async (provider, body, isAccount = true) => {
    const backend = installFetch([provider], accountsOf(isAccount ? [provider] : []));
    const priorShowModal = /** @type {any} */ (window).showModal;
    /** @type {any} */ (window).showModal = async () => {};
    // The settled list arrives over the WebSocket; seed the cache the same way
    // the server's post-refresh broadcast does.
    wsService._emit('providers-update', [provider]);
    wsService._emit('providers-ready', true);
    const el = /** @type {any} */ (document.createElement('settings-panel'));
    document.body.appendChild(el);
    try {
      await el.open();
      await body(el);
    } finally {
      el.close();
      el.remove();
      /** @type {any} */ (window).showModal = priorShowModal;
      backend.restore();
    }
  };

  /**
   * Wait for the account list to have been drawn.
   * @param {any} el - The open panel
   * @returns {Promise<void>} Resolves once the list is in
   */
  const listed = (el) => waitFor(() => !!el._tabs.providers.accountList, {
    timeoutMs: budgetFor(2000), description: 'the account list to arrive',
  });

  await run('a healthy account shows its card and nothing to report', async () => {
    await withPanel(keylessProvider({ available: true, credentialed: true }), async (el) => {
      await listed(el);
      assert(!!el.querySelector('.account-card[data-provider="fake-cli"]'), 'the account has no card');
      assert(!el.querySelector('#provider-fields-container .toggle-switch'), 'the card has an on/off switch');
      assert(!el.querySelector('#fake-cli-status'),
        'an account with nothing to report must not grow a status line');
    });
  });

  await run('a provider that is not an account has no card', async () => {
    await withPanel(keylessProvider({ available: false, credentialed: false }), async (el) => {
      await listed(el);
      assert(!el.querySelector('[data-provider="fake-cli"]'), 'a provider that is not an account has a card');
    }, false);
  });

  await run('an account that cannot serve keeps its card and says why', async () => {
    const provider = keylessProvider({ available: false, credentialed: true, authHint: SIGN_IN_HINT });
    await withPanel(provider, async (el) => {
      await listed(el);
      const status = el.querySelector('#fake-cli-status');
      assert(!!status, 'an unusable account must say so on its card');
      assert((status.textContent || '').includes('/login'),
        `the card must carry the remediation, got ${status.textContent}`);

      const refresh = el.querySelector('#provider-fields-container .settings-recheck-btn');
      assert(!!refresh, 'the card must offer a re-check');
      assert((refresh.getAttribute('aria-label') || '').includes('Fake CLI'),
        `the re-check must name its provider, got ${refresh.getAttribute('aria-label')}`);
    });
  });

  await run('a provider with nothing installed is not offered a sign-in re-check', async () => {
    // A CLI that isn't installed reports through the same line, so its
    // re-check must not claim to be checking a sign-in.
    const provider = keylessProvider({ available: false, credentialed: true, authHint: NOT_INSTALLED_HINT });
    await withPanel(provider, async (el) => {
      await listed(el);
      const status = el.querySelector('#fake-cli-status');
      assert(!!status && status.textContent === NOT_INSTALLED_HINT,
        `the card must carry the hint as given, got ${status?.textContent}`);
      const refresh = el.querySelector('#provider-fields-container .settings-recheck-btn');
      assert(!!refresh, 'the card must offer a re-check');
      const words = `${refresh.title} ${refresh.getAttribute('aria-label')}`;
      assert(!/sign-in/i.test(words), `a keyless re-check must not mention a sign-in, got "${words}"`);
      assert(words.includes('Fake CLI'), `the re-check must still name its provider, got "${words}"`);
    });
  });

  /**
   * An OAuth provider (the Codex plan, Copilot): its login lives in another app.
   * @param {{available: boolean, authHint?: string}} state - Row state
   * @returns {any} A provider entry shaped like /api/providers serves one
   */
  const oauthProvider = (state) => ({
    name: 'fake-plan',
    displayName: 'Fake Plan',
    description: 'Stands in for a subscription login.',
    authType: 'oauth_bearer',
    authSource: 'fake_src',
    configKeyName: '',
    envVarName: '',
    apiKeyURL: '',
    keySource: '',
    available: state.available,
    credentialed: state.available,
    authHint: state.authHint || '',
    modelsWithContext: [{ id: 'fake-plan-model', contextWindow: 1000, maxOutputTokens: 100, fromAPI: false }],
  });

  await run('a signed-in login account shows its status and no switch', async () => {
    await withPanel(oauthProvider({ available: true, authHint: 'Signed in' }), async (el) => {
      await listed(el);
      assert(!!el.querySelector('#fake-plan-status'), 'a login account must show its sign-in status');
      assert(!el.querySelector('#provider-fields-container .toggle-switch'), 'the card has an on/off switch');
    });
  });

  await run('a signed-out login account keeps its card and says how to sign in', async () => {
    // Signed out is not removed: the card stays, and says what to do.
    await withPanel(oauthProvider({ available: false, authHint: 'Sign in with codex login' }), async (el) => {
      await listed(el);
      const status = el.querySelector('#fake-plan-status');
      assert(!!status && (status.textContent || '').includes('codex login'),
        'the signed-out card must still say how to sign in');
    });
  });

  // The description and the hint are the server's wording: the English in
  // `description` / `authHint`, and the messages they were rendered from in
  // `descriptionMessage` / `authHintMessage`, which the row translates. The
  // stand-in catalogue plays the part of the server's.
  await run('under en-XA a row shows its server description and hint translated', async () => {
    const keylessDescription = 'Stands in for a CLI-backed provider.';
    const oauthDescription = 'Stands in for a subscription login.';
    const oauthHint = 'Signed in via the stand-in app';
    const keyless = {
      ...keylessProvider({ available: false, credentialed: true, authHint: SIGN_IN_HINT }),
      descriptionMessage: { key: keylessDescription },
      authHintMessage: { key: SIGN_IN_HINT },
    };
    const oauth = {
      ...oauthProvider({ available: true, authHint: oauthHint }),
      descriptionMessage: { key: oauthDescription },
      authHintMessage: { key: oauthHint },
    };
    await underPseudoLocale('keyless-signin-messages', async () => {
      for (const provider of [keyless, oauth]) {
        await withPanel(provider, async (el) => {
          const row = el.querySelector(`[data-provider="${provider.name}"]`);
          assert(!!row, `the ${provider.name} row must render`);
          const shown = (row.querySelector('.provider-description')?.textContent || '');
          assert(isPseudoLocalized(shown),
            `the description must be translated, got ${JSON.stringify(shown)}`);
          const status = el.querySelector(`#${provider.name}-status`)?.textContent || '';
          assert(isPseudoLocalized(status),
            `the hint must be translated, got ${JSON.stringify(status)}`);
        });
      }
    }, { 'keyless-signin-stub': [keylessDescription, oauthDescription, oauthHint, SIGN_IN_HINT] });
  });

  return { passed, failed, errors };
}
