//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Footer status messages keep their numbers attached to their units.
 *
 * The footer's busy line wraps, and its content is mostly counts: "1,024
 * tokens", "48 KB", "95% cached", "attempt 3/5". A wrap in any of those spaces
 * strands the number on one line and its unit on the next, where it reads as a
 * different quantity. Every such space is a non-breaking one, and the clause
 * separator carries one too so the bullet never opens a line. Both are
 * invisible in the source, so they are pinned here.
 * @module unit-tests/status-message-format-test
 */

import { StatusMessageBuilder } from '../../js/services/status-message-builder.js';
import { formatTokens } from '../../js/utils/format.js';
import { assert } from '../utilities/test-helpers.js';

/** Non-breaking space, spelled out so the assertions below are readable. */
const NBSP = '\u00A0';

/**
 * A count as the builder writes it — the app-wide compact form. Below its
 * thousands threshold that form defers to the host locale, whose grouping is
 * its own business ("1,024" here, "1024" under POSIX as a CI runner has), and
 * none of that is what these assertions are about. Spelling "1,024" into them
 * tested the runner's locale.
 * @param {number} n - The count.
 * @returns {string} The count as it appears in a status message.
 */
const count = (n) => formatTokens(n);

/**
 * @typedef {object} TestResult
 * @property {number} passed - Passing assertion count
 * @property {number} failed - Failing assertion count
 * @property {string[]} errors - Collected error messages
 */

/**
 * Run status-message formatting tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Case name
   * @param {() => void} fn - Assertions to run
   */
  function test(name, fn) {
    try { fn(); passed++; }
    catch (/** @type {any} */ e) { failed++; errors.push(`${name}: ${e.message}`); }
  }

  test('an output-only count is bound to its unit', () => {
    const message = StatusMessageBuilder.buildStreamingStatus({ outputTokens: 1024 });
    assert(message.includes(`${count(1024)}${NBSP}tokens`), `status message = "${message}", want a non-breaking space before "tokens"`);
  });

  test('a single token still reads singular, and still bound', () => {
    const message = StatusMessageBuilder.buildStreamingStatus({ outputTokens: 1 });
    assert(message.includes(`1${NBSP}token`), `status message = "${message}"`);
  });

  test('an input → output pair keeps the arrow with the count before it', () => {
    const message = StatusMessageBuilder.buildStreamingStatus({ inputTokens: 2000, outputTokens: 30 });
    assert(message.includes(`${count(2000)}${NBSP}→ 30${NBSP}tokens`), `status message = "${message}"`);
  });

  test('the cached clause holds together', () => {
    const message = StatusMessageBuilder.buildStreamingStatus({ inputTokens: 2000, cachedTokens: 1800, outputTokens: 30 });
    assert(message.includes(`(90%${NBSP}cached)${NBSP}→ 30${NBSP}tokens`), `status message = "${message}"`);
  });

  test('token counts are compact, not raw integers', () => {
    const message = StatusMessageBuilder.buildStreamingStatus({ inputTokens: 128000, cachedTokens: 120000, outputTokens: 4096 });
    assert(message.includes(`128k (94%${NBSP}cached)${NBSP}→ 4k${NBSP}tokens`), `status message = "${message}"`);
  });

  test('an upload size is bound to its unit', () => {
    const message = StatusMessageBuilder.buildUploadingStatus({ payloadSize: 48 * 1024 });
    assert(message.includes(`48${NBSP}KB`), `status message = "${message}"`);
  });

  test('the clause separator never opens a line', () => {
    const message = StatusMessageBuilder.buildStreamingStatus({ inputTokens: 2000, cachedTokens: 1800, outputTokens: 30, elapsedTime: 4000 });
    assert(!message.includes(' ·'), `status message = "${message}", want a non-breaking space before every bullet`);
    assert(message.includes(`${NBSP}· `), `status message = "${message}", want clauses separated by a bullet`);
  });

  test('no count in any built message is left splittable from its unit', () => {
    const messages = [
      StatusMessageBuilder.buildStreamingStatus({ inputTokens: 2000, cachedTokens: 1800, outputTokens: 30, elapsedTime: 90000 }),
      StatusMessageBuilder.buildStreamingStatus({ inputTokens: 1_500_000, cachedTokens: 1_200_000, outputTokens: 12_000, elapsedTime: 3000 }),
      StatusMessageBuilder.buildStreamingStatus({ outputTokens: 5, elapsedTime: 3000 }),
      StatusMessageBuilder.buildUploadingStatus({ payloadSize: 1_500_000, elapsedTime: 3000 }),
    ];
    for (const message of messages) {
      const splittable = message.match(/\d[,.\d]*[kM]?%? (tokens?|KB|cached|·|→)/);
      assert(!splittable, `"${message}" can wrap between "${splittable?.[0]}" — use a non-breaking space`);
    }
  });

  /**
   * The lead clause of a streaming status built from a provider activity snapshot.
   * @param {string} description - Provider activity snapshot
   * @returns {string} The status message up to its first clause separator
   */
  const activityLead = (description) =>
    StatusMessageBuilder.buildStreamingStatus({ description }).split(`${NBSP}· `)[0];

  test('a reasoning summary shows its heading, not its body', () => {
    const lead = activityLead('**Inspecting the footer**\n\nI am reading how the status line is rendered.');
    assert(lead === 'Inspecting the footer', `lead = ${JSON.stringify(lead)}`);
  });

  test('a heading still streaming in shows no dangling marker', () => {
    const lead = activityLead('**Inspecting the fo');
    assert(lead === 'Inspecting the fo', `lead = ${JSON.stringify(lead)}`);
  });

  test('inline markdown inside an activity label is rendered as plain text', () => {
    const lead = activityLead('Checking `status.js` and **footer** [rendering](https://example.com) ~~now~~ *here*');
    assert(lead === 'Checking status.js and footer rendering now here', `lead = ${JSON.stringify(lead)}`);
  });

  test('a markdown heading or bullet prefix is dropped', () => {
    assert(activityLead('## Planning the fix') === 'Planning the fix', `lead = ${JSON.stringify(activityLead('## Planning the fix'))}`);
    assert(activityLead('- Planning the fix') === 'Planning the fix', `lead = ${JSON.stringify(activityLead('- Planning the fix'))}`);
  });

  test('underscores and asterisks inside words are left alone', () => {
    const lead = activityLead('Reading my_var_name and a*b*c');
    assert(lead === 'Reading my_var_name and a*b*c', `lead = ${JSON.stringify(lead)}`);
  });

  test('a label wrapped whole in emphasis is unwrapped', () => {
    const lead = activityLead('**Thinking**');
    assert(lead === 'Thinking', `lead = ${JSON.stringify(lead)}`);
  });

  return { passed, failed, errors };
}
