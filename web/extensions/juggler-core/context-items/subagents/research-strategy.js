//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import SubagentStrategyType from './subagent-strategy.js';
import { RESEARCH_GUIDANCE } from './research-prompt.js';

/**
 * Everything the `Research` sub-agent may call: the network tools, plus enough
 * read-only local access to check what the project actually depends on.
 *
 * An allow-list rather than a category filter, because the point of this
 * sub-agent is the network loop — a read tool that isn't one of these belongs to
 * `Explore`, and letting them drift together is what would make the model's
 * choice between the two tools arbitrary. No `bash`, no writes.
 * @type {readonly string[]}
 */
const RESEARCH_TOOLS = Object.freeze([
  'WebSearch',
  'WebFetch',
  'read',
  'grep',
  'glob'
]);

/**
 * The strategy the `Research` sub-agent runs under: the network, plus what is
 * actually installed here.
 *
 * Owned by `ResearchAgentContextItem` (registered through its `getStrategies()`
 * hook and forced hidden), so it never appears in any user-facing strategy list.
 * @augments {SubagentStrategyType}
 */
export default class ResearchSubagentStrategyType extends SubagentStrategyType {
  /**
   * Strategy manifest. `hidden` is forced true at registration; it is declared
   * here too so reading this file tells you what it is.
   * @type {import('juggler/strategy-type').StrategyManifest}
   */
  static MANIFEST = {
    id: 'subagent-research',
    name: 'Research (sub-agent)',
    version: '1.0.0',
    description: 'Web research for a delegated Research run — search and fetch, plus read-only local lookups.',
    author: 'Juggler Team',
    hidden: true,
    showsApprovalControls: false
  };

  /** @type {string} */
  static GUIDANCE = RESEARCH_GUIDANCE;

  /**
   * Only {@link RESEARCH_TOOLS}, and never a withheld one.
   * @override
   * @param {import('juggler/strategy-type').ToolDefinition[]} tools - All available tools
   * @returns {import('juggler/strategy-type').ToolDefinition[]} Filtered tools
   */
  filterTools(tools) {
    return this.withoutWithheld(tools).filter(t => RESEARCH_TOOLS.includes(t.name));
  }
}
