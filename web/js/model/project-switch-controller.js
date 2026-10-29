//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What a realm does when the server switches its loaded project at runtime —
 * the session's answer to the `project-changed` broadcast.
 *
 * A viewer hard-reloads: the worker manager, conversation tabs, context items
 * and Yjs documents are all keyed off the old project, and a fresh page load is
 * the teardown and rebuild they need anyway.
 *
 * The engine has no page to reload and is persistent across the switch, so it
 * does by hand what a reload would have done for it, in three steps:
 *
 * 1. **Repoint the root**, synchronously: `session.projectPath`, the live
 *    `globalThis.__jugglerProjectRoot` the query_code sandbox falls back to, and
 *    the worker manager's config.
 * 2. **Release the previous project's conversations** — one
 *    `registry.reset()` after the worker bookkeeping and the documents are
 *    torn down.
 * 3. **Reseed the project-scoped session state** from the new project's
 *    manifest, then re-judge any approval a conversation parked in between.
 *
 * The controller reaches the session only through {@link ProjectSwitchHost},
 * which the session builds. Every entry is read at call time, so a test that
 * replaces the session's registry or API service is replacing it here too.
 * @module model/project-switch-controller
 */

import workerManager from '../services/worker-manager.js';
import { isEngine } from '../../sdk/lib/client-role.js';
import { toSandboxRoot } from '../../sdk/lib/sandbox-runner.js';
import { approvePermittedPendingApprovals } from './conversation-tool-actions.js';

/**
 * What the controller may ask of the session.
 * @typedef {object} ProjectSwitchHost
 * @property {() => string} projectPath - The session's project root ('' = no project)
 * @property {(path: string) => void} setProjectPath - Record a new project root on the session
 * @property {() => import('./conversation-registry.js').default} registry - The session's open conversations
 * @property {() => Promise<import('./session.js').SessionData>} fetchManifest - `GET /api/session` for the loaded project
 * @property {(data: import('./session.js').SessionData) => void} adoptManifest - Adopt a manifest's session-level state as a remote change (`SessionPersistence.adoptManifest`)
 */

export default class ProjectSwitchController {
  /**
   * @param {ProjectSwitchHost} host - The session's side of the controller
   */
  constructor(host) {
    /** @private */
    this._host = host;
  }

  /**
   * `project-changed`: the server changed its loaded project, so this realm
   * must repopulate its session state from the new one (see the module doc for
   * why the engine and a viewer do it differently).
   * @param {unknown} data - {projectPath}
   */
  projectChanged(data) {
    if (isEngine()) {
      // Fire-and-forget: the reseed it kicks off guards its own failures,
      // and the websocket callback must not block on a session refetch.
      void this.apply(/** @type {{projectPath?: string}} */ (data)?.projectPath);
      return;
    }
    if (typeof window !== 'undefined') window.location.reload();
  }

  /**
   * Repoint the engine's project root after a runtime project switch.
   *
   * The engine host captures its project root once at boot (Node: the
   * JUGGLER_PROJECT_ROOT env var; webview: the sandbox HTML template) and,
   * being persistent across SwitchProject, never reloads to pick up a new one.
   * This updates both `session.projectPath` and the live
   * `globalThis.__jugglerProjectRoot` that the query_code sandbox delegates fall
   * back to per run (a tool names its conversation's own root, so the global is
   * what answers a caller with none), so a switched project stops leaking the
   * previous root to the model. Only the engine realm calls this.
   *
   * The path is repointed synchronously (callers and the sandbox read it
   * immediately); the rest of the project-scoped state a viewer gets free from
   * its reload is reseeded asynchronously — see {@link _reseed}, whose promise
   * is returned so callers that care can await the full switch.
   * @param {string} [newPath] - The switched-to project root ("" = no project)
   * @returns {Promise<void>} Resolves once the project-scoped state is reseeded
   */
  apply(newPath) {
    const host = this._host;
    host.setProjectPath(newPath || '');
    const projectPath = host.projectPath();
    Object.assign(globalThis, { __jugglerProjectRoot: toSandboxRoot(projectPath) });
    workerManager.setProjectPath(projectPath);
    this._releaseConversations();
    return this._reseed();
  }

  /**
   * Release the previous project's conversations from the engine on a switch.
   *
   * Conversations are project-bound (transcript folder, Yjs doc, context
   * items), and the server already dropped them as part of the switch
   * (`conversationCache.CloseAllConversations`). A viewer sheds them by
   * reloading; the persistent engine would otherwise hold every doc it had
   * touched for the rest of the process, and judge their parked approvals
   * against the NEXT project's permission rules.
   *
   * Only client-side bookkeeping is torn down: `workerManager.terminateAll`
   * clears local worker tracking without killing the server-lifetime workers,
   * which deliberately outlive a switch. If one of those is still live and
   * syncs again, the ordinary auto-load path rebuilds the conversation against
   * the loaded project — the authority for what exists.
   * @private
   */
  _releaseConversations() {
    workerManager.terminateAll();
    const registry = this._host.registry();
    for (const conv of registry.conversations.values()) {
      try {
        conv.destroy?.();
      } catch (err) {
        console.error('[Session] Failed to release a conversation on project switch:', err);
      }
    }
    registry.reset();
  }

  /**
   * Re-read the project-scoped session state after a project switch — the work
   * a viewer gets for free by hard-reloading into a fresh `SessionPersistence.load`.
   *
   * `session.metadata` is where session-scoped permission rules
   * (`sessionPermissionRules`) and folder grants (`sessionAllowedPaths`) live,
   * and it belongs to ONE project's `session.json`. The engine is persistent
   * across a switch, so without this it keeps serving the previous project's
   * rules while `projectPath` already names the new one — the two halves
   * `isPermitted` reads disagree. A command matching a standing rule of the
   * switched-to project is then wrongly parked for approval, and the suggestion
   * engine offers to add the very rule the user already has; conversely the old
   * project's folder grants would still authorise commands here.
   *
   * Metadata is REPLACED, not patched: a switch means a different session.json,
   * so a key absent from the new project must disappear rather than linger.
   * A switch that lands while this is in flight wins — the late response is
   * dropped rather than reinstating the project we just left.
   * @returns {Promise<void>} Resolves once metadata/history are reseeded
   * @private
   */
  async _reseed() {
    const host = this._host;
    const requestedFor = host.projectPath();
    /** @type {import('./session.js').SessionData|null} */
    let data = null;
    try {
      data = await host.fetchManifest();
    } catch (error) {
      console.error('[Session] Failed to reload session state after a project switch:', error);
      return;
    }
    if (host.projectPath() !== requestedFor) return;

    host.adoptManifest(data);

    // The switch already released the previous project's conversations, so this
    // covers the race window between that and the metadata landing: a worker
    // that syncs in between auto-loads a conversation which evaluates its
    // approvals against the outgoing rules. Re-judge them against the loaded
    // project's, so a command covered by a standing rule here stops waiting on
    // an approval it never needed.
    for (const conversation of host.registry().conversations.values()) {
      try {
        approvePermittedPendingApprovals(conversation, {
          allowViewer: true,
          itemTypes: ['execute', 'write-file']
        });
      } catch (err) {
        console.error('[Session] permission re-check failed after a project switch:', err);
      }
    }
  }
}
