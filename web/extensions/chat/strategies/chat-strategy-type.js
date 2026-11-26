//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import StrategyType, { APPROVAL_POLICY } from 'juggler/strategy-type';
import { markUntranslated } from 'juggler/i18n';

/**
 * Every tool a chat may call: search the web, read a page, and ask the user.
 * An allow-list rather than a category filter, because chat is not a weaker
 * coding mode — it has no use for the project's files at all, so a read tool
 * that is not one of these does not belong in it.
 * @type {readonly string[]}
 */
export const CHAT_TOOLS = Object.freeze(['WebSearch', 'WebFetch', 'AskUserQuestion']);

/**
 * The tools a chat runs without asking: the two network reads. AskUserQuestion
 * is not among them — its "approval" is the user's answer.
 * @type {readonly string[]}
 */
const AUTO_APPROVED = Object.freeze(['WebSearch', 'WebFetch']);

/**
 * Chat — a plain conversation with an assistant that can look things up.
 *
 * Only {@link CHAT_TOOLS} reach the model, and the web tools run without a
 * prompt, so a question never stops for an approval. The conversation's
 * chrome is stripped down to the message box: every control
 * `MANIFEST.ui.hide` can name is hidden, the strategy picker becomes a chip
 * that still switches strategy, and tool runs are always folded into one row.
 * A conversation created on this strategy, or switched to it before its first
 * message, starts with the extension's own identity, `presets/assistant.md`,
 * and without the project's instruction files: they are about working on the
 * code, which a chat cannot do. The user's global instruction files, which
 * are about the person, and project memory are seeded as for any strategy.
 * @augments {StrategyType}
 */
export default class ChatStrategyType extends StrategyType {
  /**
   * Strategy manifest.
   * @type {import('juggler/strategy-type').StrategyManifest}
   */
  static MANIFEST = {
    id: 'chat',
    name: 'Chat',
    version: '1.0.0',
    description: 'A plain conversation that can search the web, but cannot read or change the project',
    author: 'Juggler Team',
    color: 'var(--accent-green)',
    icon: 'icon-search',
    order: 10,
    // Nothing it can call needs a permission toggle.
    showsApprovalControls: false,
    defaultPreset: './assistant',
    projectInstructions: false,
    ui: {
      hide: [
        'commands', 'prompt-history', 'skills', 'send-later',
        'log', 'tokens', 'add-context', 'undo-redo', 'duplicate', 'continue'
      ],
      strategySelector: 'chip',
      toolGrouping: 'always'
    },
    recommendations: {
      recommendedFor: [
        'Everyday questions and explanations',
        'Researching a topic on the web',
        'Writing and editing prose',
        'Talking a decision through'
      ],
      exampleTriggers: [
        'what is...',
        'look up...',
        'help me write...',
        'should I...'
      ],
      approach: 'Web search, page fetch and questions to the user only, all but the questions auto-approved. Nothing in the project can be read, run or changed.',
      tradeoffs: {
        pros: [
          'Never stops for an approval',
          'Cannot touch the project',
          'A simpler conversation view'
        ],
        cons: [
          'Cannot read, run or change anything in the project',
          'To work on code, switch to Default'
        ]
      }
    }
  };

  /**
   * What a chat tells the model when it starts, injected by the base
   * `onActivate`. The citation rule matches the Research sub-agent's: a claim
   * that came from the web carries the link it came from.
   * @type {string}
   */
  static GUIDANCE = markUntranslated(
    'CHAT MODE: this is a conversation, not a coding task. You can search the web, fetch '
    + 'pages and ask the user questions; you cannot read or change the project. '
    + 'Cite a URL for every claim drawn from a search result or fetched page — link the source.'
  );

  /**
   * Only {@link CHAT_TOOLS}.
   * @override
   * @param {import('juggler/strategy-type').ToolDefinition[]} tools - Every available tool
   * @returns {import('juggler/strategy-type').ToolDefinition[]} The chat tools among them
   */
  filterTools(tools) {
    return tools.filter(t => CHAT_TOOLS.includes(t.name));
  }

  /**
   * Run web search and fetch without asking. Everything else — the user's own
   * questions, and any call the tool marks as a deliberate checkpoint — falls
   * through to the usual decision.
   * @override
   * @param {{toolName: string, interactionKind: string, autoApprovable: boolean}} info - Call context
   * @returns {'approve'|'require-approval'|'default'} The policy decision
   */
  getApprovalPolicy({ toolName, interactionKind, autoApprovable }) {
    if (interactionKind === 'elicitation' || !autoApprovable) return APPROVAL_POLICY.DEFAULT;
    return AUTO_APPROVED.includes(toolName) ? APPROVAL_POLICY.APPROVE : APPROVAL_POLICY.DEFAULT;
  }
}
