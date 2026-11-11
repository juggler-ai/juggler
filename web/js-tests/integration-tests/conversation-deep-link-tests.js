//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Test: a project page opened at `?c=<conversationId>` lands on
 * that conversation.
 *
 * The lane hosts the whole of index.html in a frame (only a test server lets it
 * be framed), with the project's stored active conversation set to another one
 * first, so the stored choice cannot pass the test by chance. The frame must
 * open on the linked conversation by itself — nothing here switches it — make it
 * the project's active conversation, as choosing its tab does, and take `c` out
 * of its address, so a reload opens where the user is rather than where the
 * link pointed. A link naming no conversation the project holds opens the page
 * as a plain load does, and is taken out of the address too.
 *
 * The stored active conversation is the project's, shared by every lane on the
 * server, so the test runs with no sibling lane (needsExclusiveRun).
 * @module integration-tests/conversation-deep-link-tests
 */

import { pollPatiently, whyGivingUp } from '../utilities/test-patience.js';
import { budgetFor } from '../utilities/test-deadline.js';
import { serverPath, apiUrl } from '../../js/utils/api-url.js';
import { fetchJson } from '../../js/services/http.js';

/**
 * Wait for `probe` to be truthy within the test's deadline, or throw.
 * @template T
 * @param {() => T} probe
 * @param {string} what - What is awaited, for the failure.
 * @param {number} [nominalMs]
 * @returns {Promise<T>} The probe's truthy value.
 */
async function until(probe, what, nominalMs = 10000) {
  const got = await pollPatiently(() => {
    try { return probe(); } catch { return null; }
  }, { nominalMs: budgetFor(nominalMs), intervalMs: 50, what });
  if (!got) throw new Error(`timed out waiting for ${what} — ${await whyGivingUp()}`);
  return /** @type {T} */ (got);
}

/**
 * Host the app shell in an offscreen frame at `search`, and wait for it to have
 * loaded the session and drawn its active tab.
 * @param {string} search - The query string, with its `?`.
 * @param {string} heldId - A conversation the project holds, which the loaded session must list.
 * @returns {Promise<{frame: HTMLIFrameElement, win: any, doc: Document, session: any}>} The frame and its shell.
 */
async function hostShell(search, heldId) {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1280px;height:800px;border:0';
  frame.src = serverPath('/') + search;
  document.body.appendChild(frame);
  const win = /** @type {any} */ (frame.contentWindow);
  const session = await until(() => win.jugglerApp?.getSession()?.conversations.get(heldId) && win.jugglerApp.getSession(),
    'the shell to load the session', 20000);
  const doc = /** @type {Document} */ (frame.contentDocument);
  await until(() => doc.querySelector('conversation-tab.is-active'), 'the shell to draw its active tab', 20000);
  return { frame, win, doc, session };
}

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const conversationDeepLinkTest = {
  name: 'conversation-deep-link',
  description: 'A project page opened at ?c=<id> lands on that conversation, makes it the active one and drops c from its address',
  fixture: 'unit-test-fixture',
  timeoutMs: 60000,
  needsExclusiveRun: true,

  llmResponses: [],
  operations: [],

  customAssertions: async (conversation, ctx) => {
    const harness = /** @type {any} */ (ctx?.harness);
    const target = conversation.id;

    // Store another conversation as the project's active one.
    const elsewhere = await harness.createConversation('Elsewhere', []);
    harness.switchConversation(elsewhere);
    await harness.innerHarness.session.persistence.saveImmediately();
    const before = await fetchJson(apiUrl('/session'));
    if (before?.activeConversationId === target) {
      throw new Error(`setup: the stored active conversation is still the linked one (${target})`);
    }

    const linked = await hostShell(`?c=${encodeURIComponent(target)}`, target);
    try {
      const active = /** @type {any} */ (linked.doc.querySelector('conversation-tab.is-active'));
      const failures = [];
      if (linked.session.visibleConversationId !== target) {
        failures.push(`the shell opened on ${linked.session.visibleConversationId}, not the linked ${target} (stored: ${before?.activeConversationId})`);
      }
      if (active?.getConversation?.()?.id !== target) {
        failures.push(`the active tab holds ${active?.getConversation?.()?.id}, not the linked ${target}`);
      }
      if (new URLSearchParams(linked.win.location.search).has('c')) {
        failures.push(`c is still in the shell's address: ${linked.win.location.search}`);
      }
      if (failures.length) throw new Error(failures.join('\n  '));

      // The link is the user choosing that tab: it becomes the project's
      // active conversation, as a switch makes it.
      // The probe is synchronous: it asks the server one GET at a time and
      // judges the latest answer.
      /** @type {string|null|undefined} */
      let stored;
      let asking = false;
      await until(() => {
        if (!asking) {
          asking = true;
          fetchJson(apiUrl('/session'))
            .then((/** @type {any} */ d) => { stored = d?.activeConversationId; }, () => {})
            .finally(() => { asking = false; });
        }
        return stored === target;
      }, 'the linked conversation to be stored as the active one');
    } finally {
      linked.frame.remove();
    }

    const missing = await hostShell('?c=conv_no_such_conversation', target);
    try {
      const shown = missing.session.visibleConversationId;
      if (!shown || !missing.session.conversations.has(shown)) {
        throw new Error(`a link to no conversation left the shell showing ${shown}`);
      }
      if (new URLSearchParams(missing.win.location.search).has('c')) {
        throw new Error(`a link to no conversation stayed in the shell's address: ${missing.win.location.search}`);
      }
    } finally {
      missing.frame.remove();
    }
  },
};

export const tests = [conversationDeepLinkTest];
