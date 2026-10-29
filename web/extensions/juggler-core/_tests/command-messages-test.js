//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests: the messages juggler-core's conversation commands report.
 *
 * A command's result `message` is shown to the user as a notice and never
 * reaches the model, so under en-XA every one of them is translated. Each case
 * drives the real command over stub threads and sessions; errors are digits, so
 * they read as data inside the message.
 * @module unit-tests/command-messages-test
 */

import { underPseudoLocale } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';
import workerManager from '../../../js/services/worker-manager.js';
import { startCompaction, endCompaction } from 'juggler/model';
import ClearCommandType from '../commands/clear-command-type.js';
import CompactCommandType from '../commands/compact-command-type.js';
import DuplicateConversationCommandType from '../commands/duplicate-conversation-command-type.js';
import HandoffCommandType from '../commands/handoff-command-type.js';
import NewConversationCommandType from '../commands/new-conversation-command-type.js';

/** juggler-core's English for these commands, standing in for its catalogue. */
const CORE_TEXT = [
  'Conversation cleared.',
  'Pick a model before compacting.', 'Compaction is already in progress.',
  "Couldn't compact: {error}", 'Nothing to compact yet.',
  "Can't duplicate: this conversation has no session.", "Couldn't duplicate: {error}",
  "Can't hand off: this conversation has no session.",
  'Pick a model before handing off.', "Couldn't hand off: {error}",
  "Couldn't hand off: the new conversation wasn't created.", 'A handoff is already in progress.',
  'Nothing to hand off — continuing in a new conversation.',
  "Can't create a conversation: this conversation has no session.",
  "Couldn't create the conversation: {error}",
];

/**
 * Run a command class against a stub thread and return its result message.
 * @param {any} CommandClass - The command
 * @param {any} messageThread - What it acts on
 * @returns {Promise<string>} The message it reports
 */
async function messageOf(CommandClass, messageThread) {
  const cmd = new CommandClass({ messageThread });
  const result = await cmd.execute([]);
  return String(result?.message);
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated results
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const originalCompact = workerManager.compact;
  try {
    await underPseudoLocale('command-messages-test', async () => {
      /** @type {Record<string, string>} */
      const shown = {};
      const noSession = { conversation: {} };
      const model = { modelConfig: { model: '1' } };

      shown['clear'] = await messageOf(ClearCommandType, {
        clearHistory: () => {},
        conversation: { session: { seedConversationAutoItems: async () => {} } },
      });

      shown['compact, no model'] = await messageOf(CompactCommandType, { conversationId: 'cm1' });
      startCompaction('cm2');
      try {
        shown['compact, pending'] = await messageOf(CompactCommandType, { ...model, conversationId: 'cm2' });
      } finally {
        endCompaction('cm2');
      }
      /** @type {any} */ (workerManager).compact = async () => ({ folded: false, error: '1' });
      shown['compact, worker error'] = await messageOf(CompactCommandType, { ...model, conversationId: 'cm3' });
      /** @type {any} */ (workerManager).compact = async () => ({ folded: false });
      shown['compact, nothing'] = await messageOf(CompactCommandType, { ...model, conversationId: 'cm4' });
      /** @type {any} */ (workerManager).compact = async () => { throw new Error('2'); };
      shown['compact, thrown'] = await messageOf(CompactCommandType, { ...model, conversationId: 'cm5' });

      shown['duplicate, no session'] = await messageOf(DuplicateConversationCommandType, noSession);
      shown['duplicate, failed'] = await messageOf(DuplicateConversationCommandType, {
        conversation: { id: 'd1', session: { duplicateConversation: async () => { throw new Error('3'); } } },
      });

      shown['new, no session'] = await messageOf(NewConversationCommandType, noSession);
      shown['new, failed'] = await messageOf(NewConversationCommandType, {
        conversation: { session: { createConversation: async () => { throw new Error('4'); } } },
      });

      /**
       * A session whose duplicate succeeds, yielding `clone` as the new conversation.
       * @param {any} clone - What getConversation returns for the clone
       * @returns {any} The stub session
       */
      const handoffSession = (clone) => ({
        duplicateConversation: async () => 'h-new',
        setNameIsProvisional: () => {},
        switchConversation: () => {},
        getConversation: () => clone,
      });
      const handoff = (/** @type {any} */ session) => messageOf(HandoffCommandType,
        { ...model, conversation: { id: 'h-src', session } });
      shown['handoff, no session'] = await messageOf(HandoffCommandType, noSession);
      shown['handoff, no model'] = await messageOf(HandoffCommandType,
        { conversation: { id: 'h-src', session: handoffSession(null) } });
      shown['handoff, duplicate failed'] = await handoff({
        duplicateConversation: async () => { throw new Error('5'); },
      });
      shown['handoff, clone missing'] = await handoff(handoffSession(null));
      startCompaction('h-busy');
      try {
        shown['handoff, pending'] = await handoff(handoffSession({ rootMessageThread: { conversationId: 'h-busy' } }));
      } finally {
        endCompaction('h-busy');
      }
      const clone = { rootMessageThread: { conversationId: 'h-clone' } };
      /** @type {any} */ (workerManager).compact = async () => ({ folded: false, error: '6' });
      shown['handoff, worker error'] = await handoff(handoffSession(clone));
      /** @type {any} */ (workerManager).compact = async () => ({ folded: false });
      shown['handoff, nothing'] = await handoff(handoffSession(clone));
      /** @type {any} */ (workerManager).compact = async () => { throw new Error('7'); };
      shown['handoff, thrown'] = await handoff(handoffSession(clone));

      const raw = Object.entries(shown).filter(([, s]) => !isPseudoLocalized(s));
      if (raw.length) throw new Error(`plain English under en-XA: ${JSON.stringify(raw)}`);
    }, { '@juggler/core': CORE_TEXT });
    passed++;
  } catch (e) {
    failed++;
    errors.push(`en-XA: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    /** @type {any} */ (workerManager).compact = originalCompact;
  }

  return { passed, failed, errors };
}
