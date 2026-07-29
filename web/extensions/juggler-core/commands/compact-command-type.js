//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import CommandType from 'juggler/command-type';
import {
  isCompactionPending,
  startCompaction,
  endCompaction,
  compactConversation
} from 'juggler/model';

/**
 * Compact command — collapse the entire conversation into a sub-thread.
 *
 * The fold is performed worker-side (the single Go fold, shared with
 * auto-compaction): every content item is moved into a new bounded-compaction
 * thread that the worker summarises via `return_result`. The conversation then
 * contains exactly one thread tile whose `result` is the summary. Standard undo
 * reverses fold + summary as one group.
 */
class CompactCommandType extends CommandType {
  static MANIFEST = {
    id: 'compact',
    name: 'Compact',
    version: '1.0.0',
    description: 'Compact the entire conversation into a summary thread',
    icon: 'icon-compact',
    mutatesConversation: true
  };

  /**
   * Execute the compact command
   * @param {string[]} _args - Command arguments (unused)
   * @returns {Promise<import('juggler/command-type').CommandResult>} Command result
   */
  async execute(_args) {
    if (!this.messageThread?.modelConfig) {
      return { handled: true, message: 'Please select a model before compacting', error: true };
    }

    const mt = /** @type {import('../../../js/model/message-thread.js').MessageThread} */ (this.messageThread);

    if (isCompactionPending(mt.conversationId)) {
      return { handled: true, message: 'Compaction already in progress', error: true };
    }

    startCompaction(mt.conversationId);

    try {
      // The fold is worker-side now (the single Go fold): the worker relocates
      // conversational history into a bounded-compaction thread, keeps the
      // leading standing context (agents files, memory, system prompt) at the
      // parent, and summarises it. `folded` is false when there was nothing to
      // fold; `error` carries a worker-side failure reason.
      const { folded, error } = await compactConversation(mt.conversationId);
      if (error) {
        return { handled: true, message: `Compaction failed: ${error}`, error: true };
      }
      if (!folded) {
        return { handled: true, message: 'Nothing to compact', error: true };
      }

      return { handled: true };
    } catch (error) {
      const { extractErrorMessage: extractErr } = await import('juggler/ui');
      return {
        handled: true,
        message: `Compaction failed: ${extractErr(error)}`,
        error: true
      };
    } finally {
      endCompaction(mt.conversationId);
    }
  }
}

export default CompactCommandType;
