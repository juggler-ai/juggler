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
import { translator } from 'juggler/i18n';

const t = translator('@juggler/core');

/**
 * Compact command — fold older conversation into a summary thread.
 *
 * The fold is performed worker-side (the single Go fold, shared with
 * auto-compaction): the older history is moved into a new bounded-compaction
 * thread that the worker summarises with its folded-compaction summariser, and
 * the recent conversation stays verbatim after it — how much is the "Keep recent
 * conversation" setting, by the rule the automatic fold uses. `/compact all`
 * folds everything after the standing context instead. Standard undo reverses
 * fold + summary as one group.
 */
class CompactCommandType extends CommandType {
  static MANIFEST = {
    id: 'compact',
    name: 'Compact',
    version: '1.0.0',
    description: 'Fold older conversation into a summary thread, keeping recent turns (all: fold everything)',
    icon: 'icon-compact',
    argsHint: '[all]',
    mutatesConversation: true
  };

  /**
   * Execute the compact command
   * @param {string[]} args - Command arguments: `all`, or none
   * @returns {Promise<import('juggler/command-type').CommandResult>} Command result
   */
  async execute(args) {
    const all = args.length === 1 && args[0]?.toLowerCase() === 'all';
    if (args.length > 0 && !all) {
      return { handled: true, message: t('/compact takes no argument, or "all" to fold everything.'), error: true };
    }
    if (!this.messageThread?.modelConfig) {
      return { handled: true, message: t('Pick a model before compacting.'), error: true };
    }

    const mt = /** @type {import('../../../js/model/message-thread.js').MessageThread} */ (this.messageThread);

    if (isCompactionPending(mt.conversationId)) {
      return { handled: true, message: t('Compaction is already in progress.'), error: true };
    }

    startCompaction(mt.conversationId);

    try {
      // The fold is worker-side (the single Go fold): the worker relocates
      // conversational history into a bounded-compaction thread, keeps the
      // leading standing context (agents files, memory, system prompt) at the
      // parent, and summarises it. `folded` is false when there was nothing to
      // fold — with the recent turns kept, also when what is left over is too
      // small to be worth a summary; `error` carries a worker-side failure reason.
      // The thread folded is the one the command was typed in: a sub-thread's
      // /compact folds that sub-thread's history, and the root's stays as it is.
      const { folded, error } = await compactConversation(mt.conversationId, { threadItemId: mt.threadItemId, keepRecent: !all });
      if (error) {
        return { handled: true, message: t("Couldn't compact: {error}", { error }), error: true };
      }
      if (!folded) {
        return {
          handled: true,
          message: all
            ? t('Nothing to compact yet.')
            : t('Nothing to compact yet — only recent turns. /compact all folds them too.'),
          error: true
        };
      }

      return { handled: true };
    } catch (error) {
      const { extractErrorMessage: extractErr } = await import('juggler/ui');
      return {
        handled: true,
        message: t("Couldn't compact: {error}", { error: extractErr(error) }),
        error: true
      };
    } finally {
      endCompaction(mt.conversationId);
    }
  }
}

export default CompactCommandType;
