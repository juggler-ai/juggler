//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { markUntranslated } from 'juggler/i18n';

/**
 * ThreadContextItem - UI rendering for the create_thread tool.
 *
 * Execution is handled by the Go worker (sync tool).
 * This plugin provides tool definitions, badge options, and summary formatting.
 * @class
 * @augments ContextItem
 */
class ThreadContextItem extends ContextItem {
  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'thread', icon: 'icon-thread' };
  }

  /** @returns {string} Short type label shown on the item badge and panel header */
  static getTypeName() {
    return 'Thread';
  }

  static MANIFEST = {
    id: 'thread',
    name: 'Create Thread',
    version: '1.0.0',
    description: 'Create a nested sub-conversation (thread)',
    author: 'Juggler',
    requiresApproval: false,
    workerManaged: true, // Execution handled by Go worker, not browser
    // Delegation is decided by the worker as it reads the model's response,
    // so a program's call could only run inline.
    composable: false
  };

  /**
   * Get tool definitions for the create_thread action
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definitions
   */
  static getToolDefinitions() {
    return [
      {
        name: 'create_thread',
        category: 'write',
        description: markUntranslated('Run one focused sub-task in an isolated sub-conversation; only its last message returns. The child cannot see this conversation, so `prompt` must be self-contained. The user can open a thread and work in it: talk to it, approve its plan or tool calls, answer its questions, carry it on after it finishes — and what it does later also reports back here. So a task the user wants to steer themselves belongs in a thread too. `resultSpec` says what the final message must contain; `goal` is only the UI label. Every result opens with the thread\'s session name — pass it back as `session` to continue that thread. One task per thread, never a task list, and never tell it to spawn threads of its own.'),
        input_schema: {
          type: 'object',
          properties: {
            goal: {
              type: 'string',
              description: markUntranslated('Very short, single-line, user-facing label (for example, "Trace auth flow"). No instructions, background, or output requirements here.')
            },
            prompt: {
              type: 'string',
              description: markUntranslated('The complete, self-contained task: every relevant fact, path, symbol, decision, and constraint. The required shape of the answer goes in `resultSpec`, not here.')
            },
            resultSpec: {
              type: 'string',
              description: markUntranslated('Optional return contract for the child\'s last message: what it must contain and how to structure it (for example, "each match as `file:line — description`"). Do not repeat the task here.')
            },
            session: {
              type: 'string',
              description: markUntranslated('Optional session name of a thread you already ran here: your prompt continues that thread, which keeps everything it has read and worked out. Omit it to start a fresh thread.')
            }
          },
          required: ['goal', 'prompt']
        }
      }
    ];
  }

  /**
   * Format result for display
   * @param {import('juggler/context-item').Outcome} outcome
   * @returns {import('juggler/context-item').ItemSummary} Display summary
   */
  getSummary(outcome) {
    if (!outcome.success) {
      return this.failureSummary(outcome.error || 'Failed to create thread');
    }

    return this.successSummary(markUntranslated('Thread completed'), { icon: '▼' });
  }
}

export default ThreadContextItem;
