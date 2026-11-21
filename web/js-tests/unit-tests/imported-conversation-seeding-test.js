//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A conversation imported from another agent's transcript is seeded with this
 * project's standing context at its first initialisation, even though it has
 * history.
 *
 * `Conversation.ensureInitialised` treats history as proof that seeding was
 * done long ago — true of every conversation written before the `initialised`
 * flag existed, and the reason it only records the flag for them. An imported
 * conversation has history too, written by an agent that never saw this
 * project's AGENTS.md or memory; the server marks it `importedFrom`, and that
 * marker is what sends it through `session.initialiseConversation` instead.
 * Getting it wrong is silent: the conversation works, and the model simply
 * never reads the project's instructions.
 *
 * The control is a conversation of this session's own with history and no
 * marker, put back in the pre-flag state: it must only be marked initialised,
 * never re-seeded (which would resurrect items its user deleted).
 * @module unit-tests/imported-conversation-seeding
 */

import {
  createTestSession,
  createTestConversation,
  releaseTestConversation,
  assert
} from '../utilities/test-helpers.js';
import { racePatiently, pollPatiently, whyGivingUp } from '../utilities/test-patience.js';
import { laneId, registerOwnConversation } from '../utilities/conversation-claims.js';
import workerManager from '../../js/services/worker-manager.js';
import { fetchJson } from '../../js/services/http.js';
import { apiUrl } from '../../js/utils/api-url.js';
import { createAssistantMessage } from '../../sdk/lib/message.js';

/** Nominal for the import's load: one worker spawn and its initial sync. */
const LOAD_BUDGET_MS = 15000;

/**
 * Import a three-item transcript (user, completed Bash call, assistant) under
 * a source id no earlier run used, tagged with this lane so the test server's
 * ownership ledger lets this lane delete it.
 * @returns {Promise<string>} The new conversation's id
 */
async function importTranscript() {
  const params = new URLSearchParams({ lane: laneId(), reason: 'unit:imported-conversation-seeding' });
  const response = await fetchJson(apiUrl(`/conversations/import?${params}`), {
    method: 'POST',
    body: {
      title: 'Fix the build',
      created: '2026-11-01T09:00:00Z',
      source: { kind: 'claude-code', id: `seeding-test-${laneId()}-${Date.now()}`, digest: 'd1' },
      items: [
        { type: 'user', content: 'the build is broken' },
        { type: 'tool-action', toolUseId: 't1', toolName: 'Bash', toolInput: { command: 'make' }, result: 'ok' },
        { type: 'assistant', content: 'Fixed.' }
      ]
    }
  });
  assert(!!response?.id && response.existing !== true,
    `the import should create a new conversation; got ${JSON.stringify(response)}`);
  registerOwnConversation(response.id);
  return response.id;
}

/**
 * Record the calls into the two seams `ensureInitialised` reaches when it
 * seeds, passing each through to the real method.
 *
 * Asserted through these rather than through a seeded item: every lane shares
 * one test project, so whether it holds an AGENTS.md (and so whether a
 * `file-content` seed appears) is not this test's to decide, and writing one
 * would change what every sibling lane's conversations seed. The seams are
 * the decision under test; `seededFor` landing on '' is the pass having
 * actually run to the end, not merely been entered.
 * @param {any} session - Session to watch
 * @returns {{initialised: string[], seeded: string[], restore: () => void}} The calls, by conversation id
 */
function watchSeeding(session) {
  /** @type {string[]} */ const initialised = [];
  /** @type {string[]} */ const seeded = [];
  const proto = Object.getPrototypeOf(session);
  session.initialiseConversation = (/** @type {any} */ conv, /** @type {any[]} */ ...rest) => {
    initialised.push(conv?.id);
    return proto.initialiseConversation.call(session, conv, ...rest);
  };
  session.seedConversationAutoItems = (/** @type {any} */ conv, /** @type {any[]} */ ...rest) => {
    seeded.push(conv?.id);
    return proto.seedConversationAutoItems.call(session, conv, ...rest);
  };
  return {
    initialised,
    seeded,
    restore: () => {
      delete session.initialiseConversation;
      delete session.seedConversationAutoItems;
    }
  };
}

/**
 * @param {any} mt - Message thread
 * @returns {any[]} Its items' types, in order
 */
function itemTypes(mt) {
  return (mt?.items ?? []).map((/** @type {any} */ it) => it.get('type'));
}

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results with pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const session = await createTestSession();

  // Test 1: the imported conversation loads idle with its history, and its
  // first initialisation seeds it.
  {
    /** @type {string|null} */
    let id = null;
    const watch = watchSeeding(session);
    try {
      id = await importTranscript();
      const convId = id;

      const settled = await racePatiently(workerManager.loader.loadExisting(convId, session), LOAD_BUDGET_MS,
        { what: `the imported conversation ${convId} to load` });
      if (!settled) throw new Error(`the imported conversation did not load — ${await whyGivingUp()}`);
      const conversation = settled.value;
      const mt = conversation.rootMessageThread;

      const loaded = await pollPatiently(() => itemTypes(mt).includes('assistant'),
        { nominalMs: LOAD_BUDGET_MS, intervalMs: 20, what: 'the imported history to arrive' });
      assert(!!loaded, `the imported history never arrived; items: ${JSON.stringify(itemTypes(mt))}`);

      assert(mt.items[0]?.get('itemId') === 'SYSTEM_1',
        `the system prompt must be the first item; got ${JSON.stringify(itemTypes(mt))}`);
      for (const type of ['user', 'tool-action', 'assistant']) {
        assert(itemTypes(mt).includes(type), `the imported ${type} item is missing; items: ${JSON.stringify(itemTypes(mt))}`);
      }
      const action = mt.items.find((/** @type {any} */ it) => it.get('type') === 'tool-action');
      assert(action.get('state') === 'completed',
        `the imported tool-action must stay completed, not be re-run; state=${action.get('state')}`);
      assert(!conversation.isTurnActive() && !conversation.isProcessing,
        `loading an import must not drive a turn; processingState=${JSON.stringify(conversation.processingState)}`);
      assert(!!conversation.getMetadata('importedFrom'), 'precondition: the import carries its importedFrom marker');
      assert(!conversation.initialised, 'precondition: an import arrives uninitialised');

      await conversation.ensureInitialised();

      assert(watch.initialised.includes(convId),
        'ensureInitialised took the history shortcut for an imported conversation — '
        + 'it will never be given the project\'s instruction files or memory');
      assert(watch.seeded.includes(convId), 'initialising the import never ran the seeding pass');
      assert(conversation.seededFor === '', `the seeding pass did not finish for the project; seededFor=${conversation.seededFor}`);
      assert(conversation.initialised === true, 'the import must be initialised after ensureInitialised');
      assert(action.get('state') === 'completed' && !conversation.isTurnActive(),
        'seeding the import must not set its history running');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`an imported conversation is seeded at initialisation: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      watch.restore();
      if (id) await releaseTestConversation(session, id, 'unit:imported-conversation-seeding');
    }
  }

  // Test 2 (control): a conversation with history and no importedFrom marker,
  // in the state every pre-flag conversation is in, is only marked initialised.
  {
    /** @type {string|null} */
    let id = null;
    /** @type {ReturnType<typeof watchSeeding>|null} */
    let watch = null;
    try {
      const conversation = await createTestConversation(session);
      id = conversation.id;
      // An assistant item is history without being something a turn answers.
      conversation.atomicUpdate(() => {
        conversation.rootMessageThread.addEvent(createAssistantMessage('Done long ago.'));
      });
      conversation.initialised = false;
      conversation.seededFor = null;
      assert(!conversation.getMetadata('importedFrom'), 'precondition: the control carries no importedFrom marker');

      watch = watchSeeding(session);
      await conversation.ensureInitialised();

      assert(watch.initialised.length === 0 && watch.seeded.length === 0,
        `a conversation with its own history was re-seeded (initialise: ${watch.initialised.length}, seed: ${watch.seeded.length}) — `
        + 'that resurrects the context items its user deleted');
      // Read through `any`: the checker narrowed the flag at the assignment above
      // and cannot see ensureInitialised write it.
      assert(/** @type {any} */ (conversation).initialised === true, 'the control must still be recorded as initialised');
      assert(conversation.seededFor === null, `the control's seeds must be left alone; seededFor=${conversation.seededFor}`);

      passed++;
    } catch (e) {
      failed++;
      errors.push(`a conversation with its own history is not re-seeded: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      watch?.restore();
      if (id) await releaseTestConversation(session, id, 'unit:imported-conversation-seeding');
    }
  }

  return { passed, failed, errors };
}
