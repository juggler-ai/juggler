//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * DuckDuckGo HTML scraping, and the domain filtering the WebSearch item
 * applies to every search backend's results.
 *
 * Every function here is pure: HTML in, results out. That is the point of the
 * split — the DuckDuckGo backend owns the request and the retry ladder, the
 * item the fallback and the rendering, and none of those are needed to test
 * the scraper. This is a RELATIVE import
 * inside the extension — never a `juggler/*` SDK bare specifier — so it works
 * in the engine worker without touching the SDK import-map seams.
 * @module juggler-core/context-items/web-search/ddg-parser
 */

/**
 * @typedef {object} WebSearchResultItem
 * @property {string} title - Result title
 * @property {string} url - Result URL
 * @property {string} description - Result description/snippet
 */

/**
 * Parse a DuckDuckGo HTML response.
 *
 * The engine runs inside a Web Worker, which has no `document`/`DOMParser`,
 * so the markup is split into per-result blocks and scraped with bounded
 * regexes. Each hit is wrapped in an element carrying a standalone `result`
 * class (e.g. `<div class="result results_links ...">`); within a block the
 * link comes from `.result__a`, the title from `.result__title` (falling back
 * to the link text), and the snippet from `.result__snippet`.
 *
 * Returns an empty array when the markup contains no result blocks. Callers
 * distinguish a genuine empty result set from a blocked/captcha page via
 * {@link looksLikeNoResults} rather than treating every empty parse as an error.
 * @param {string} content - Raw HTML response
 * @returns {WebSearchResultItem[]} Parsed results (possibly empty)
 */
export function parseDuckDuckGoResponse(content) {
  /** @type {WebSearchResultItem[]} */
  const results = [];

  for (const block of splitResultBlocks(content)) {
    const url = extractAttr(block, 'result__a', 'href');
    if (url === null) {
      continue;
    }

    const titleHtml = extractElementHtml(block, 'result__title');
    const title = htmlToText(
      titleHtml !== null ? titleHtml : (extractElementHtml(block, 'result__a') || '')
    );

    const snippetHtml = extractElementHtml(block, 'result__snippet');
    const description = snippetHtml !== null ? htmlToText(snippetHtml) : '';

    results.push({ title, url, description });
  }

  return results;
}

/**
 * Detect DuckDuckGo's genuine "no results" page — a valid results page that
 * simply had no hits — as opposed to a rate-limit/captcha challenge page.
 * DuckDuckGo marks the former with a `no-results` container; a response with
 * zero result blocks and no such marker is treated as blocked and is worth
 * retrying.
 * @param {string} content - Raw HTML response
 * @returns {boolean} True if the page is a genuine empty result set
 */
export function looksLikeNoResults(content) {
  return /\bclass\s*=\s*"[^"]*\bno-results\b[^"]*"/i.test(content);
}

/**
 * Slice HTML into per-result blocks at each element whose class list contains
 * a standalone `result` class. Each block runs to the next block start (or end
 * of input), so the title/link/snippet scrapers stay scoped to one result.
 * @param {string} content - Raw HTML response
 * @returns {string[]} Per-result HTML fragments
 */
function splitResultBlocks(content) {
  const blockStart = /<(?:div|tr|li|article)\b[^>]*\bclass\s*=\s*"[^"]*\bresult\b[^"]*"[^>]*>/gi;
  /** @type {number[]} */
  const starts = [];
  let m;
  while ((m = blockStart.exec(content)) !== null) {
    starts.push(m.index);
  }

  return starts.map((start, i) =>
    content.slice(start, i + 1 < starts.length ? starts[i + 1] : content.length)
  );
}

/**
 * Read an attribute off the first tag in `html` carrying `className`.
 * @param {string} html - HTML fragment
 * @param {string} className - Class to locate (e.g. `result__a`)
 * @param {string} attr - Attribute name (e.g. `href`)
 * @returns {string|null} Decoded attribute value, or null if absent
 */
function extractAttr(html, className, attr) {
  const open = new RegExp(`<[a-z][a-z0-9]*\\b[^>]*\\bclass\\s*=\\s*"[^"]*\\b${className}\\b[^"]*"[^>]*>`, 'i');
  const tag = open.exec(html);
  if (!tag) {
    return null;
  }
  const a = new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"`, 'i').exec(tag[0]);
  return a ? decodeEntities(/** @type {string} */ (a[1])) : null; // bounded: mandatory capture group
}

/**
 * Return the inner HTML of the first element in `html` carrying `className`,
 * up to that element's first matching close tag.
 * @param {string} html - HTML fragment
 * @param {string} className - Class to locate
 * @returns {string|null} Inner HTML, or null if no such element
 */
function extractElementHtml(html, className) {
  const open = new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*\\bclass\\s*=\\s*"[^"]*\\b${className}\\b[^"]*"[^>]*>`, 'i');
  const tag = open.exec(html);
  if (!tag) {
    return null;
  }
  const rest = html.slice(tag.index + tag[0].length);
  const close = new RegExp(`</${tag[1]}\\s*>`, 'i').exec(rest);
  return close ? rest.slice(0, close.index) : rest;
}

/**
 * Strip tags and decode entities from an HTML fragment — the worker-safe
 * equivalent of reading `Element.textContent.trim()`.
 * @param {string} html - HTML fragment
 * @returns {string} Plain text
 */
function htmlToText(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * Decode the HTML entities DuckDuckGo emits (named + numeric). `&amp;` is
 * decoded last so an encoded entity like `&amp;lt;` survives as `&lt;`.
 * @param {string} s - Text possibly containing entities
 * @returns {string} Decoded text
 */
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * Check if host matches domain pattern (ported from Go)
 * @param {string} host - Hostname to check
 * @param {string} pattern - Domain pattern
 * @returns {boolean} True if matches
 */
export function matchesDomain(host, pattern) {
  if (host === pattern) {
    return true;
  }
  return host.endsWith('.' + pattern);
}

/**
 * Apply domain filters to results. A result whose URL does not parse is
 * dropped, since neither filter can be answered for it.
 * @template {{url: string}} T
 * @param {T[]} results - Search results
 * @param {string[]} [allowedDomains] - Allowed domains
 * @param {string[]} [blockedDomains] - Blocked domains
 * @returns {T[]} Filtered results
 */
export function filterResults(results, allowedDomains, blockedDomains) {
  return results.filter(result => {
    try {
      const resultUrl = new URL(result.url);
      const host = resultUrl.hostname.toLowerCase();

      // Check blocked domains
      if (blockedDomains && blockedDomains.length > 0) {
        for (const domain of blockedDomains) {
          if (matchesDomain(host, domain.toLowerCase())) {
            return false;
          }
        }
      }

      // Check allowed domains
      if (allowedDomains && allowedDomains.length > 0) {
        let allowed = false;
        for (const domain of allowedDomains) {
          if (matchesDomain(host, domain.toLowerCase())) {
            allowed = true;
            break;
          }
        }
        if (!allowed) return false;
      }

      return true;
    } catch {
      // Invalid URL, filter out
      return false;
    }
  });
}
