//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * What every workspace that builds nothing has in common: the group and the
 * subfolder.
 *
 * Nothing was made on disk, so there is nothing for an ending to dispose of and
 * nothing for it to read first. What is left to decide is what becomes of the
 * conversations — handed back to the workspace this one was made from, or sent
 * to the bin — and that choice is the same two endings whatever the place is
 * called. Each subclass words them in its own terms; the endings themselves,
 * and the undo of a provision that died half-way, live here.
 *
 * Kept out of `workspaces/`, whose `*-workspace-provider.js` glob is what the
 * extension loads as providers: this is a base class, not a kind of place.
 * @module lib/unbuilt-workspace-provider
 */

import WorkspaceProvider from 'juggler/workspace-provider';

/**
 * How a subclass words its two endings.
 * @typedef {object} UnbuiltEndingWords
 * @property {{label: string, description: string}} return - Handing the
 *   conversations back to the workspace this one was made from
 * @property {{label: string, description: string}} delete - Sending them to the bin
 */

/**
 * A workspace provider whose workspaces are a row and nothing else.
 * @abstract
 */
class UnbuiltWorkspaceProvider extends WorkspaceProvider {
  /**
   * The words for the two endings, in the subclass's own terms.
   * @abstract
   * @returns {UnbuiltEndingWords} Labels and descriptions.
   * @throws {Error} If not implemented.
   */
  endingWords() {
    throw new Error('endingWords() must be implemented by subclass');
  }

  /**
   * Hand the conversations back, or bin them. Both are offered on the
   * workspace's box: neither touches anything on disk, so there is no tree
   * state for the workspace panel to show before either is chosen.
   * @param {any} workspace - The row being finished with.
   * @returns {any[]} The two endings, the harmless one first.
   */
  finishOptions(workspace) {
    void workspace;
    const words = this.endingWords();
    return [
      { id: 'return', ...words.return, offerOnBox: true },
      { id: 'delete', ...words.delete, danger: true, offerOnBox: true }
    ];
  }

  /**
   * There is nothing to take down; what becomes of the conversations is the
   * host's to carry out, and this says which.
   * @param {any} workspace - The row being finished with.
   * @param {string} actionId - Which ending.
   * @param {any} ctx - The hook's context.
   * @returns {Promise<any>} Finished, and where its conversations go.
   */
  async finish(workspace, actionId, ctx) {
    if (actionId === 'return') return { done: true, conversations: 'return' };
    if (actionId === 'delete') return { done: true, conversations: 'bin' };
    return super.finish(workspace, actionId, ctx);
  }

  /**
   * Nothing was built, so nothing is left.
   * @param {any} workspace - The half-built row.
   * @param {any} ctx - Unused.
   * @returns {Promise<any>} Nothing was left.
   */
  async cleanupPartial(workspace, ctx) {
    void workspace;
    void ctx;
    return { removed: true };
  }
}

export default UnbuiltWorkspaceProvider;
