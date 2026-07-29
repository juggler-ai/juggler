//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import CommandType from 'juggler/command-type';
import { extractErrorMessage } from 'juggler/ui';
import { compactConversation, isCompactionPending } from 'juggler/model';

/**
 * Handoff command — hand this conversation off to a fresh "(continued)" tab that
 * begins with a handoff summary, ready to keep working with a clean context.
 *
 * Flow (see the design notes on each seam):
 *  1. Duplicate the source conversation into a new tab named "<name> (continued)".
 *     Duplication is a server-side file copy, so image/file references in the
 *     copied history stay valid for the summarization turn — and it leaves the
 *     ORIGINAL tab completely untouched. Duplication refuses mid-turn, which is
 *     exactly the guard we want (a handoff mid-turn is surfaced as a notice).
 *  2. Switch to the clone immediately.
 *  3. Fold the clone's copied history into a summary thread tagged
 *     `handoffPromote` (reusing /compact's machinery). The worker summarises it
 *     and writes the result; the tab shows a "generating…" thread meanwhile.
 *  4. When the result lands, the items observer's maybePromoteHandoffThread
 *     replaces the thread with a PARKED first user message carrying the summary.
 *     Parked = the message is posted but no turn starts (only sendMessage /
 *     needsStrategyRun start turns), so the tab waits for Continue or a
 *     follow-up.
 *
 * Like /new and /duplicate this is a tab-level operation on the session, so it
 * does NOT set `mutatesConversation` — a handoff must never cancel a turn in the
 * current tab (duplication already refuses if one is running).
 */
class HandoffCommandType extends CommandType {
  static MANIFEST = {
    id: 'handoff',
    name: 'Summarise this conversation into a new tab',
    version: '1.0.0',
    description: 'Summarise this conversation into a new tab to continue work',
    icon: 'icon-compact'
  };

  /**
   * Execute the handoff command
   * @param {string[]} _args - Command arguments (unused)
   * @returns {Promise<import('juggler/command-type').CommandResult>} Command result
   */
  async execute(_args) {
    const source = this.messageThread?.conversation;
    const session = source?.session;
    if (!session) {
      return { handled: true, message: 'No session available', error: true };
    }

    // The summary is an LLM turn, so the clone needs a model. Fail early with the
    // same guidance /compact gives rather than minting an un-runnable tab.
    if (!this.messageThread?.modelConfig) {
      return { handled: true, message: 'Please select a model before handing off', error: true };
    }

    let newId;
    try {
      // Server-side copy → valid file refs, source left intact. Named
      // "<source> (continued)" up front so there's no "(copy)" flicker.
      newId = await session.duplicateConversation(source.id, { nameSuffix: 'continued' });
    } catch (error) {
      return { handled: true, message: `Handoff failed: ${extractErrorMessage(error)}`, error: true };
    }
    if (!newId) {
      // Null clone is duplicateConversation's mid-turn refusal (or a missing
      // source): it already surfaced its own notice, so stay quiet.
      return { handled: true };
    }

    // Bring the parked "(continued)" tab into view so the user watches the
    // summary generate and lands on it ready to continue.
    session.switchConversation(newId);

    const clone = session.getConversation(newId);
    const cloneMt = clone?.rootMessageThread;
    if (!cloneMt) {
      return { handled: true, message: 'Handoff failed: continued tab unavailable', error: true };
    }

    // Defensive: a fresh clone should never be mid-compaction, but honour the
    // same single-flight guard the compaction path uses.
    if (isCompactionPending(cloneMt.conversationId)) {
      return { handled: true, message: 'Handoff already in progress', error: true };
    }

    try {
      // Fold the clone's copied history worker-side (the single Go fold).
      // `handoffPromote` tags the thread so maybePromoteHandoffThread turns the
      // finished result into the parked first user message of the continued tab.
      const { folded, error } = await compactConversation(cloneMt.conversationId, { handoffPromote: true });
      if (error) {
        return { handled: true, message: `Handoff failed: ${error}`, error: true };
      }
      if (!folded) {
        // Empty source — nothing to summarise. Leave the (empty) continued tab
        // in place for the user to start typing in.
        return { handled: true, message: 'Nothing to hand off — continuing in a fresh tab', error: true };
      }
    } catch (error) {
      return { handled: true, message: `Handoff failed: ${extractErrorMessage(error)}`, error: true };
    }

    return { handled: true };
  }
}

export default HandoffCommandType;
