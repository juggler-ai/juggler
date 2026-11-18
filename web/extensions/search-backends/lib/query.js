//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Narrow a query to one allowed domain with the `site:` operator, which the
 * services that use it understand. With several, or none, the query is left as
 * it is: the WebSearch tool filters every backend's results by domain anyway,
 * so this only spends the result count better.
 * @param {string} query - The query
 * @param {string[]} [allowedDomains] - Domains the results must come from
 * @returns {string} The query to send
 */
export function withSiteFilter(query, allowedDomains) {
  return allowedDomains?.length === 1 ? `${query} site:${allowedDomains[0]}` : query;
}
