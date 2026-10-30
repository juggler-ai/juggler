//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import CommandType from 'juggler/command-type';
import { extractErrorMessage } from 'juggler/ui';
import { compactConversation, isCompactionPending } from 'juggler/model';
import { translator } from 'juggler/i18n';

const t = translator('@juggler/core');

/**
 * Handoff command — hand this conversation off to a fresh "(continued)" conversation that
 * begins with a handoff summary, ready to keep working with a clean context.
 *
 * Flow (see the design notes on each seam):
 *  1. Duplicate the source conversation into a new one named "<name> (continued)".
 *     Duplication is a server-side file copy, so image/file references in the
 *     copied history stay valid for the summarization turn — and it leaves the
 *     ORIGINAL conversation completely untouched. Duplication refuses mid-turn, which is
 *     exactly the guard we want (a handoff mid-turn is surfaced as a notice).
 *  2. Switch to the clone immediately.
 *  3. Fold the clone's copied history into a summary thread tagged
 *     `handoffPromote` (reusing /compact's machinery). The worker summarises it
 *     and writes the result; the conversation shows a "generating…" thread meanwhile.
 *  4. When the result lands, the items observer's maybePromoteHandoffThread
 *     replaces the thread with a PARKED first user message carrying the summary.
 *     Parked = the message is posted but no turn starts (only sendMessage /
 *     needsStrategyRun start turns), so the conversation waits for Continue or a
 *     follow-up.
 *  5. That promotion also asks for an auto-name: the summary is the continued
 *     tab's first user message, so the model can title it from where the work
 *     actually got to rather than leaving "<source> (continued)". Step 2 marks
 *     the clone's name provisional (setNameIsProvisional) to make it eligible;
 *     the server still applies the user's auto-naming setting, and the derived
 *     name stands if naming is off or fails.
 *
 * Like /new and /duplicate this is a session-level operation, so it
 * does NOT set `mutatesConversation` — a handoff must never cancel a turn in the
 * current conversation (duplication already refuses if one is running).
 */
class HandoffCommandType extends CommandType {
  static MANIFEST = {
    id: 'handoff',
    name: 'Summarise this conversation into a new one',
    version: '1.0.0',
    description: 'Summarise this conversation into a new one to continue work',
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
      return { handled: true, message: t("Can't hand off: no project is open."), error: true };
    }

    // The summary is an LLM turn, so the clone needs a model. Fail early with the
    // same guidance /compact gives rather than minting an un-runnable conversation.
    if (!this.messageThread?.modelConfig) {
      return { handled: true, message: t('Pick a model before handing off.'), error: true };
    }

    let newId;
    try {
      // Server-side copy → valid file refs, source left intact. Named
      // "<source> (continued)" up front so there's no "(copy)" flicker.
      // refuseWhileActive: handoff's next step is an LLM summary turn, so it
      // waits for a settled source rather than forking one mid-turn.
      newId = await session.duplicateConversation(source.id, { nameSuffix: 'continued', refuseWhileActive: true });
    } catch (error) {
      return { handled: true, message: t("Couldn't hand off: {error}", { error: extractErrorMessage(error) }), error: true };
    }
    if (!newId) {
      // Null clone is duplicateConversation's refusal — mid-turn, or while
      // another duplicate of the source is in flight — or a missing source: it
      // already surfaced its own notice, so stay quiet.
      return { handled: true };
    }

    // The "(continued)" name is derived, not chosen: mark it so the auto-namer
    // may replace it with a title drawn from the handoff summary once that
    // summary lands (maybePromoteHandoffThread requests the derivation). Marked
    // unconditionally — the server owns the "is auto-naming enabled" decision, and
    // when it is off the derived "(continued)" name simply stays.
    session.setNameIsProvisional(newId, true);

    // Bring the parked "(continued)" conversation into view so the user watches the
    // summary generate and lands on it ready to continue.
    session.switchConversation(newId);

    const clone = session.getConversation(newId);
    const cloneMt = clone?.rootMessageThread;
    if (!cloneMt) {
      return { handled: true, message: t("Couldn't hand off: the new conversation wasn't created."), error: true };
    }

    // Defensive: a fresh clone should never be mid-compaction, but honour the
    // same single-flight guard the compaction path uses.
    if (isCompactionPending(cloneMt.conversationId)) {
      return { handled: true, message: t('A handoff is already in progress.'), error: true };
    }

    try {
      // Fold the clone's copied history worker-side (the single Go fold).
      // `handoffPromote` tags the thread so maybePromoteHandoffThread turns the
      // finished result into the parked first user message of the continued conversation.
      const { folded, error } = await compactConversation(cloneMt.conversationId, { handoffPromote: true });
      if (error) {
        return { handled: true, message: t("Couldn't hand off: {error}", { error }), error: true };
      }
      if (!folded) {
        // Empty source — nothing to summarise. Leave the (empty) continued conversation
        // in place for the user to start typing in.
        return { handled: true, message: t('Nothing to hand off — continuing in a new conversation.'), error: true };
      }
    } catch (error) {
      return { handled: true, message: t("Couldn't hand off: {error}", { error: extractErrorMessage(error) }), error: true };
    }

    return { handled: true };
  }
}

export default HandoffCommandType;
