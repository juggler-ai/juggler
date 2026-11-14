//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The `accounts` ops of a server whose provider accounts are exactly the
 * providers it publishes as configured — each its type's default account — for
 * a test of the Providers tab that is about something other than accounts. The
 * Providers tab draws its cards from these ops alone, so a test that stubs
 * fetch has to answer them.
 *
 * The list follows every `providers-update` the test publishes, so a provider
 * that stops being configured (switched off, say) stops being an account, as
 * it would on a server.
 * @module utilities/accounts-backend
 */

import wsService from '../../js/services/websocket.js';

/**
 * Serve the accounts ops for a provider list.
 * @param {any[]} providers - The published provider list to start from.
 * @returns {{answer: (url: unknown, init: any) => any, dispose: () => void}}
 *   answer is the response to an accounts op, or null for any other request;
 *   dispose stops following the published list.
 */
export function accountsBackend(providers) {
  let published = providers;
  const off = wsService.on('providers-update', (/** @type {unknown} */ data) => {
    if (Array.isArray(data)) published = data;
  });
  const accounts = () => published
    .filter((p) => p && (p.credentialed ?? p.available ?? !!p.keySource))
    .map((p) => ({
      id: p.name,
      type: p.type || p.name,
      typeDisplayName: p.displayName,
      displayName: p.displayName,
      isDefault: !p.type || p.type === p.name,
      keySource: p.keySource || '',
      envVarName: p.envVarName || '',
      registered: true,
    }));
  return {
    answer(url, init) {
      if (!String(url).includes('/api/ops/call')) return null;
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.toolId !== 'accounts') return null;
      const data = body.operation === 'types'
        ? { types: [] }
        : { accounts: accounts(), candidates: [] };
      return { ok: true, status: 200, json: async () => ({ success: true, data }) };
    },
    dispose: off,
  };
}
