//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What happens to a conversation's warning when there is no composer to put it
 * in.
 *
 * `Conversation.showWarning` is the model's one route to the user, and fourteen
 * callers depend on it — every one of them a refusal the user is owed an
 * explanation for. A conversation reaches it with no composer often enough to
 * matter: one whose tab was never opened, one mid-rebuild, one in a column that
 * hides its input. The warning is genuinely lost in that case, and the point of
 * these tests is that the loss leaves a record: a dropped warning and a warning
 * that was never raised produce identical failure blocks otherwise, which is
 * what made `visible warnings: []` unreadable.
 *
 * The conversations here carry only what `showWarning` reads. Building a real
 * one costs a `session.persistence.load()`, a worker spawn and a `/api/providers` fetch,
 * all load-sensitive under the iframe pool and none of them on this path.
 * @module unit-tests/warning-fallback-test
 */

import { assert } from '../utilities/test-helpers.js';
import Conversation from '../../js/model/conversation.js';
import SessionEvents from '../../js/model/session-events.js';
import { __dumpTapeForTests } from '../../js/utils/event-tape.js';
import '../../js/components/conversation-tab.js';

/**
 * A conversation with the real `showWarning` and a session feed of its own,
 * carrying a unique id so the tape can be read back for this case alone. Given
 * a tab, the feed is answered by the real tab's handler run against it, so the
 * stand-in need only say what composer it shows.
 * @param {any} tab - A stand-in tab (`getComposer()`), or null for a conversation that has none
 * @returns {any} A conversation ready to be warned
 */
function conversationWith(tab) {
  const conv = Object.create(Conversation.prototype);
  conv.id = `CONV_WARNING_${Math.random().toString(36).slice(2)}`;
  const events = new SessionEvents(/** @type {any} */ ({}));
  if (tab) {
    const answer = /** @type {any} */ (customElements.get('conversation-tab')).prototype._answerModelRequest;
    events.subscribe((event) => {
      if (event.data?.conversationId === conv.id) answer.call(tab, event);
    });
  }
  conv._session = { events };
  return conv;
}

/**
 * The `warning-dropped` entries this conversation left on the tape.
 * @param {any} conv - The conversation to read the tape for
 * @returns {any[]} Matching tape entries, oldest first
 */
function dropsFor(conv) {
  return __dumpTapeForTests(conv.id).filter(e => e.kind === 'warning-dropped');
}

/**
 * Run the warning-routing tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test counts and errors
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * Run one case with the realm's console and trace flag restored afterwards.
   * A unit suite shares its realm with every suite that ran before it, so the
   * tape gate is set here rather than assumed.
   * @param {string} name - Test case name
   * @param {() => void} fn - Test case body
   */
  function test(name, fn) {
    const w = /** @type {any} */ (window);
    const priorTrace = w.__jugglerTrace;
    const priorWarn = console.warn;
    w.__jugglerTrace = true;
    console.warn = () => {};
    try { fn(); passed++; }
    catch (e) { failed++; errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
    finally {
      console.warn = priorWarn;
      w.__jugglerTrace = priorTrace;
    }
  }

  test('the composer shows the warning, and the drop is not recorded', () => {
    /** @type {Array<{message: string, duration: number}>} */
    const shown = [];
    const composer = {
      showWarning: (/** @type {string} */ m, /** @type {number} */ d) => { shown.push({ message: m, duration: d }); },
    };
    const conv = conversationWith({ getComposer: () => composer });
    conv.showWarning('The turn was cancelled', 5000);

    assert(shown.length === 1, `composer must be told exactly once, got ${shown.length}`);
    assert(shown[0].message === 'The turn was cancelled', `message must arrive intact, got ${shown[0].message}`);
    assert(shown[0].duration === 5000, `duration must arrive intact, got ${shown[0].duration}`);
    assert(dropsFor(conv).length === 0,
      `a warning that was shown must not be recorded as dropped, got ${JSON.stringify(dropsFor(conv))}`);
  });

  test('a conversation whose tab was never opened records the drop', () => {
    const conv = conversationWith(null);
    conv.showWarning('No AI provider is configured yet', 8000);

    const dropped = dropsFor(conv);
    assert(dropped.length === 1, `a dropped warning must leave one tape entry, got ${dropped.length}`);
    assert(String(dropped[0].summary.message).includes('No AI provider is configured yet'),
      `the entry must carry the message the user did not get, got ${JSON.stringify(dropped[0].summary)}`);
    assert(dropped[0].summary.hasTab === false,
      'and say the conversation had no tab at all, which is a different fault from a tab with no box');
  });

  test('a tab whose column hides its input records the drop, and says it had a tab', () => {
    // getComposer() returns null for a column carrying no `composer-box`.
    const conv = conversationWith({ getComposer: () => null });
    conv.showWarning('Wait for the current turn to finish', 3000);

    const dropped = dropsFor(conv);
    assert(dropped.length === 1, `a tab with no composer box must record the drop, got ${dropped.length} entries`);
    assert(dropped[0].summary.hasTab === true,
      'the entry must distinguish this from a conversation that was never opened');
  });

  test('the drop is filed under the conversation, so a failure block shows it', () => {
    // The runner dumps the tape filtered by the conversation ids a failing test
    // touched. An entry recorded against no conversation would be filtered out
    // of the one block anyone reads.
    const conv = conversationWith(null);
    const other = conversationWith(null);
    conv.showWarning('Still connecting to the engine', 5000);

    assert(__dumpTapeForTests(conv.id).some(e => e.kind === 'warning-dropped'),
      'the drop must be filed under the conversation that dropped it');
    assert(dropsFor(other).length === 0,
      "and must not appear under another conversation's id");
  });

  test('a drop raises no notice of its own', () => {
    // Deliberate: a conversation with no composer usually has another surface
    // already saying this in place — the setup panel puts the cursor on the very
    // field that is missing — and a document-level notice raised over it takes
    // the focus that surface just placed. Routing the fallback to `showNotice`
    // breaks `unit:conversation-workspace-panel` for exactly that reason.
    const before = document.querySelectorAll('modal-dialog.is-notice.show').length;
    const conv = conversationWith(null);
    conv.showWarning('Still connecting to the engine', 5000);

    const after = document.querySelectorAll('modal-dialog.is-notice.show').length;
    assert(after === before, `a dropped warning must raise no notice, went from ${before} to ${after}`);
  });

  return { passed, failed, errors };
}
