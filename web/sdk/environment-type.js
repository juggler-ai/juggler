//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * `juggler/environment-type` — base class for **Environment** capabilities.
 *
 * An Environment answers "**where does this conversation's work physically
 * happen**": the default project checkout, a git worktree, a devcontainer, a
 * remote/sandbox root. It is a SEPARATE axis from {@link StrategyType}, which
 * governs loop *autonomy* (read-only / default / yolo). A conversation selects
 * one environment AND one strategy independently, so "run in a worktree"
 * composes with any autonomy level — you can have a read-only worktree, a yolo
 * worktree, or no worktree at all. Bundling worktrees into a Strategy would be a
 * category error: it would consume the single strategy slot and force a choice
 * between "isolated" and "yolo/read-only".
 *
 * An environment drives the core execution-root indirection through
 * {@link bindWorkspace} (see `juggler/ops`): on activation it prepares an
 * alternate root (e.g. `git worktree add` via the `shell` op) and binds it; on
 * deactivation/teardown it unbinds. Core knows nothing about git — it only
 * remaps a conversation's ops onto the bound root(s).
 *
 * ## Lifecycle hooks (called by the host)
 *
 * | Hook | When | Typical work |
 * |------|------|--------------|
 * | `onActivate(prevId)` | this environment becomes active for a conversation | prepare + `bindWorkspace` per repo |
 * | `onDeactivate(nextId)` | the conversation switches to another environment | `unbindWorkspace` |
 * | `onTeardown({permanent})` | the conversation is deleted | remove worktrees; `unbindWorkspace` |
 *
 * A conversation may bind SEVERAL source→workspace pairs (one per git repo it
 * touches) — see {@link bindWorkspace} — which is how one conversation isolates
 * more than one repository at once, the case a single session cwd cannot express.
 * @module juggler/environment-type
 */

import { bindWorkspace, unbindWorkspace } from './ops.js';

/**
 * @typedef {object} EnvironmentManifest
 * @property {string} id - Stable capability id (e.g. "worktree").
 * @property {string} name - Display name.
 * @property {string} version - Semver.
 * @property {string} [description] - One-line description for the selector.
 * @property {string} [author] - Optional author name.
 * @property {string} [icon] - Optional emoji/icon for the selector.
 */

/**
 * Base class for an Environment capability. Subclasses set `static MANIFEST` and
 * implement the lifecycle hooks they need. The framework constructs the instance
 * with the conversation context (`this.messageThread`, `this.conversation`) —
 * the same shape a strategy receives — and invokes the hooks in the engine.
 */
class EnvironmentType {
  /**
   * @param {object} context - Framework-supplied conversation context.
   * @param {import('../js/model/message-thread.js').MessageThread} context.messageThread
   * @param {import('../js/model/conversation.js').default} [context.conversation]
   */
  constructor(context) {
    /** @type {import('../js/model/message-thread.js').MessageThread} */
    this.messageThread = context.messageThread;
    /** @type {import('../js/model/conversation.js').default|undefined} */
    this.conversation = context.conversation;
  }

  /** @returns {EnvironmentManifest} The subclass manifest. */
  getManifest() {
    return /** @type {any} */ (this.constructor).MANIFEST;
  }

  /**
   * Called when this environment becomes active for the conversation. Prepare
   * the execution root(s) and bind them (see {@link bindWorkspace}). Override.
   * @param {string} [_previousEnvironmentId] - The previously-active environment id.
   * @returns {Promise<void>}
   */
  async onActivate(_previousEnvironmentId) {}

  /**
   * Called when the conversation switches away to another environment. Release
   * the binding(s) with {@link unbindWorkspace}. Override if needed.
   * @param {string} [_nextEnvironmentId] - The environment being switched to.
   * @returns {Promise<void>}
   */
  async onDeactivate(_nextEnvironmentId) {}

  /**
   * Called when the conversation is deleted. Tear the environment down (e.g.
   * `git worktree remove`) and unbind. Override if the environment allocates
   * durable resources.
   * @param {{permanent?: boolean}} [_opts] - `permanent` is false for a bin (soft) delete.
   * @returns {Promise<void>}
   */
  async onTeardown(_opts) {}

  /**
   * Bind a source directory to an alternate execution root for this
   * conversation. Call once per repository to isolate. See
   * `juggler/ops` → `bindWorkspace` for the full contract (incl. multi-repo
   * longest-prefix routing).
   * @param {string} sourceRoot - Absolute real source directory (e.g. a repo toplevel).
   * @param {string} workspaceRoot - Absolute alternate execution root for `sourceRoot`.
   * @returns {Promise<{ok: boolean, error?: string}>} The bind result.
   */
  async bindWorkspace(sourceRoot, workspaceRoot) {
    return bindWorkspace(this.messageThread.conversationId, sourceRoot, workspaceRoot);
  }

  /**
   * Clear this conversation's binding for one source, or all when omitted.
   * @param {string} [sourceRoot] - Source to unbind; omit to clear all.
   * @returns {Promise<{ok: boolean, error?: string}>} The unbind result.
   */
  async unbindWorkspace(sourceRoot) {
    return unbindWorkspace(this.messageThread.conversationId, sourceRoot);
  }
}

export default EnvironmentType;
