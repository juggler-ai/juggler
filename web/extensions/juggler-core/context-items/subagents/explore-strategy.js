//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import SubagentStrategyType from './subagent-strategy.js';
import { EXPLORE_GUIDANCE } from './explore-prompt.js';

/**
 * Tools that reach the network. Withheld from Explore because they are
 * Research's job: the two sub-agents each withhold what the other is for, which
 * is what makes the model's choice between them unambiguous rather than a coin
 * toss between two similar-sounding tools.
 * @type {readonly string[]}
 */
const NETWORK_TOOLS = Object.freeze(['WebSearch', 'WebFetch']);

/**
 * The strategy the `Explore` sub-agent runs under: this repository, no network.
 *
 * Owned by `ExploreAgentContextItem` (registered through its `getStrategies()`
 * hook and forced hidden), so it never appears in any user-facing strategy list.
 * @augments {SubagentStrategyType}
 */
export default class ExploreSubagentStrategyType extends SubagentStrategyType {
  /**
   * Strategy manifest. `hidden` is forced true at registration; it is declared
   * here too so reading this file tells you what it is.
   * @type {import('juggler/strategy-type').StrategyManifest}
   */
  static MANIFEST = {
    id: 'subagent-explore',
    name: 'Explore (sub-agent)',
    version: '1.0.0',
    description: 'Read-only codebase investigation for a delegated Explore run — no network, no edits.',
    author: 'Juggler Team',
    hidden: true,
    showsApprovalControls: false
  };

  /** @type {string} */
  static GUIDANCE = EXPLORE_GUIDANCE;

  /**
   * Read and meta tools, minus the withheld set, minus the network — plus
   * `bash`.
   *
   * `bash` is a decision, not an oversight. It is category `write`, so a plain
   * read-only filter drops it wholesale; but an explorer with no `git log` and
   * no `git blame` is meaningfully worse at the questions people actually ask
   * ("when did this change, and why"). It is exposed on the same terms as
   * everything else here: the permission system's existing verdict decides, and
   * anything it would have asked a human about is refused rather than run — see
   * `SubagentStrategyType.getApprovalPolicy`.
   * @override
   * @param {import('juggler/strategy-type').ToolDefinition[]} tools - All available tools
   * @returns {import('juggler/strategy-type').ToolDefinition[]} Filtered tools
   */
  filterTools(tools) {
    return this.withoutWithheld(tools).filter(t =>
      !NETWORK_TOOLS.includes(t.name) &&
      (t.name === 'bash' || t.category === 'read' || t.category === 'meta'));
  }
}
