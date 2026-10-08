//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * An id the load queue has cancelled can be loaded again.
 *
 * Binning a conversation cancels its queue entry (Session._dropActiveConversation);
 * restoring it puts an 'unloaded' stub back in the map and a click on the tab
 * asks the queue to hydrate it. The queue therefore has to treat a cancelled id
 * as one it knows nothing about — a queue that still remembers the id as loaded
 * declines the request, nothing writes loadState, and 'unloaded' renders the
 * same spinner as 'loading' with no timeout behind it: the panel spins for as
 * long as the tab exists.
 *
 * The queue's collaborators are both stubbed. What is under test is which
 * requests the queue acts on, and a stub makes that exact rather than dependent
 * on a worker spawn.
 * @module unit-tests/load-queue-recycle
 */

import { assert } from '../utilities/test-helpers.js';
import ConversationLoadQueue from '../../js/services/conversation-load-queue.js';

/**
 * The parts of a Conversation the queue touches: it writes loadState and reads
 * nothing else.
 * @param {string} id - Conversation id
 * @returns {{id: string, loadState: string, setLoadState: (s: string) => void}} Stub conv
 */
function stubConversation(id) {
  return {
    id,
    loadState: 'unloaded',
    /** @param {string} s - New load state */
    setLoadState(s) { this.loadState = s; }
  };
}

/**
 * A session stub holding stub conversations.
 * @param {string[]} ids - Conversation ids to hold
 * @returns {{conversations: Map<string, any>}} Stub session
 */
function stubSession(ids) {
  /** @type {Map<string, any>} */
  const conversations = new Map();
  for (const id of ids) conversations.set(id, stubConversation(id));
  return { conversations };
}

/**
 * A loader stub that records every hydration request and settles it
 * however the test says.
 * @param {(id: string, attempt: number) => Promise<any>} handler - Per-call outcome
 * @returns {{calls: string[], loadExisting: (id: string, session: any) => Promise<any>}} Stub loader
 */
function stubWorkerManager(handler) {
  /** @type {string[]} */
  const calls = [];
  return {
    calls,
    /**
     * @param {string} id - Conversation to hydrate
     * @param {any} _session - Owning session (unused)
     * @returns {Promise<any>} The stubbed outcome
     */
    loadExisting(id, _session) {
      calls.push(id);
      return handler(id, calls.filter((c) => c === id).length);
    }
  };
}

/**
 * Resolve once `predicate` holds, or reject at the deadline — so a regression
 * fails the test rather than hanging the lane to its budget.
 * @param {() => boolean} predicate - Condition to wait for
 * @param {string} what - Message for the timeout
 * @param {number} [ms] - Patience budget
 * @returns {Promise<void>} Resolves when the predicate holds
 */
async function until(predicate, what, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(what);
    await new Promise((r) => { setTimeout(r, 5); });
  }
}

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run all load-queue recycle tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results with pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  // Test 1: a cancelled id that had already loaded can be loaded again. This is
  // bin-then-restore: the conversation loaded once, the bin cancelled it, and
  // the restored tab's first click has to reach the worker manager.
  {
    try {
      const session = stubSession(['c1']);
      const manager = stubWorkerManager(async () => ({ id: 'c1' }));
      const queue = new ConversationLoadQueue({ session, loader: manager });

      queue.enqueueAll(['c1']);
      await until(() => session.conversations.get('c1').loadState === 'loaded',
        'precondition: the first load never completed');
      assert(manager.calls.length === 1, `precondition: exactly one load so far, got ${manager.calls.length}`);

      // The bin: cancel the entry and drop the conversation, then restore it as
      // a fresh unloaded stub, exactly as Session does.
      queue.cancel('c1');
      session.conversations.set('c1', stubConversation('c1'));

      queue.prioritize('c1');
      await until(() => manager.calls.length === 2,
        'a cancelled id was never hydrated again — the queue still counts it as loaded, so the restored tab spins forever');
      await until(() => session.conversations.get('c1').loadState === 'loaded',
        'the restored conversation never reached loaded');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`a cancelled id can load again: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Test 2: cancelling an id that had failed clears the failure too, so
  // whenLoaded() reports on the new attempt rather than rejecting on the old
  // one. Waiters are the only way a caller can tell a load apart from a stall.
  {
    try {
      const session = stubSession(['c2']);
      const manager = stubWorkerManager(async (_id, attempt) => {
        if (attempt === 1) throw new Error('spawn refused');
        return { id: 'c2' };
      });
      const queue = new ConversationLoadQueue({ session, loader: manager });

      queue.enqueueAll(['c2']);
      await until(() => session.conversations.get('c2').loadState === 'error',
        'precondition: the first load never failed');

      queue.cancel('c2');
      session.conversations.set('c2', stubConversation('c2'));
      queue.prioritize('c2');

      await queue.whenLoaded('c2');
      assert(session.conversations.get('c2').loadState === 'loaded',
        'the second attempt must leave the conversation loaded');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`a cancelled id forgets its failure: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { passed, failed, errors };
}
