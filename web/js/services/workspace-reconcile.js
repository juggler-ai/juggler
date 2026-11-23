//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The once-per-run pass that squares the workspace table with what is on disk.
 *
 * A restart ends every actor while leaving every artifact behind, so the table a
 * session loads describes a world that has moved on: provisions that were
 * running are not running any more, and trees a provider made may have been
 * removed by hand since. Only the browser can settle that — reconciling means
 * asking each provider what it can find, and providers are extensions.
 *
 * But there is no leader among clients, so this runs under the server's claim:
 * the first caller to offer is told yes and every later one is told no. Without
 * it, three open windows would each run `git worktree prune` at each other.
 * @module services/workspace-reconcile
 */

import { createBoundOps } from '../../sdk/ops.js';
import { providerContext } from './provider-context.js';
import { whenRegistriesReady } from '../registries/registry-ready.js';
import workspaceProviderRegistry from '../registries/workspace-provider-registry.js';
import { listWorkspaces, patchWorkspace, unregisterWorkspace, claimWorkspaceReconcile } from './workspaces.js';

/**
 * @typedef {object} ReconcilePass
 * @property {boolean} ran - Whether this client did the work
 * @property {string} [reason] - Why it did not, when it did not
 * @property {string[]} cleaned - Ids of interrupted provisions undone and removed
 * @property {string[]} closed - Ids tombstoned because they no longer describe what they claim
 * @property {Array<{providerId: string, result: any}>} reports - What each provider found
 */

/**
 * Square the table with reality, once per run of the server and once more
 * whenever every window has been closed.
 *
 * Two jobs, in order. First, every row still marked `provisioning` is undone:
 * provisioning is browser-driven, so no provisioner survives either of those
 * moments and such a row is stale **by definition** rather than by any timeout
 * — the second moment is what catches a provision interrupted by a page reload,
 * which no restart ever comes along to clear. Its provider is asked to
 * `cleanupPartial()` it from the checkpoints it left, and the row goes with it.
 * Then each provider is asked to `reconcile()` its remaining rows.
 *
 * What it does NOT do is act on what reconcile reports. Orphans in either
 * direction are returned for the caller to show; removing a tree a user may
 * still want is a decision that belongs to the user, not to a pass that runs
 * unprompted at startup.
 *
 * Rows whose provider is not loaded are left strictly alone — not cleaned, not
 * reconciled, not reported. An extension the user disabled must cost them the
 * provider's features, never the places it made.
 * @param {any} session - The loaded session.
 * @returns {Promise<ReconcilePass>} What this pass did.
 */
export async function reconcileWorkspaces(session) {
  /** @type {ReconcilePass} */
  const pass = { ran: false, cleaned: [], closed: [], reports: [] };

  // The engine realm runs a ConnectionManager too, and has no provider registry
  // — it resolves a workspace from the session's row without asking whoever made
  // it. Letting it offer would spend a claim that answers yes exactly once, on a
  // client that can do none of the work.
  if (typeof document === 'undefined') {
    pass.reason = 'not a viewer';
    return pass;
  }

  await whenRegistriesReady();

  // The same argument one step further in: a viewer with no providers loaded can
  // clean nothing and confirm nothing, so taking the claim would only stop the
  // window that CAN from having it.
  if (workspaceProviderRegistry.getIds().length === 0) {
    pass.reason = 'no workspace providers are loaded';
    return pass;
  }

  if (!(await claimWorkspaceReconcile())) {
    pass.reason = 'another client is reconciling';
    return pass;
  }
  pass.ran = true;

  // Asked of the server rather than read from `session.workspaces`: this runs at
  // load, and the point of it is what the table says now.
  const workspaces = await listWorkspaces();
  const ctx = providerContext(session, { ops: createBoundOps(() => ({})), baseWorkspaceId: '' });

  for (const workspace of workspaces) {
    if (workspace.state !== 'provisioning') continue;
    const provider = workspaceProviderRegistry.createProvider(workspace.providerId ?? '');
    if (!provider) continue;
    try {
      // Pinned per row: what a half-built workspace left behind may be beside the
      // workspace it was being made from rather than beside the project, and this
      // pass is rooted at the project.
      const outcome = await provider.cleanupPartial(workspace, {
        ...ctx,
        baseOps: createBoundOps(() => ({ workspaceId: workspace.baseWorkspaceId ?? '' })),
        baseWorkspaceId: workspace.baseWorkspaceId ?? ''
      });
      if (outcome?.removed) {
        await unregisterWorkspace(workspace.id);
        pass.cleaned.push(workspace.id);
      }
    } catch (error) {
      // A provider that cannot tidy up leaves its row exactly where it was, for
      // the user to deal with. Losing the row as well would lose the only record
      // that anything was ever started.
      console.warn('[Workspaces] cleanup of an interrupted provision failed:', error);
    }
  }

  const surviving = await listWorkspaces();
  for (const providerId of workspaceProviderRegistry.getIds()) {
    const mine = surviving.filter(ws => ws.providerId === providerId && ws.state !== 'closed');
    if (mine.length === 0) continue;
    const provider = workspaceProviderRegistry.createProvider(providerId);
    try {
      const result = await provider?.reconcile(mine, ctx);
      pass.reports.push({ providerId, result });
      pass.closed.push(...await tombstoneOrphans(result));
    } catch (error) {
      console.warn(`[Workspaces] ${providerId} could not reconcile:`, error);
    }
  }

  return pass;
}

/**
 * Close the rows a provider says are no longer what they claim to be.
 *
 * Only those. A row whose place has simply gone is reported and left: the
 * server's own `stat` marks it unavailable, its conversations are told, and a
 * place can come back — an unmounted disk, a `git worktree prune` somebody
 * regrets. What is closed here is the other kind, where the place is still there
 * and still works, so **nothing downstream would ever notice**: every operation
 * succeeds, against something the conversation never chose.
 *
 * Closing is not removing. The artifact is untouched and the row still resolves,
 * to a reason rather than to a root, which is what the banner reads.
 * @param {any} result - What the provider reported.
 * @returns {Promise<string[]>} The ids that were closed.
 */
async function tombstoneOrphans(result) {
  /** @type {string[]} */
  const closed = [];
  for (const orphan of result?.orphanedWorkspaces ?? []) {
    if (!orphan?.tombstone || !orphan.id) continue;
    try {
      await patchWorkspace(orphan.id, {
        state: 'closed',
        meta: { closedReason: String(orphan?.reason ?? '') }
      });
      closed.push(orphan.id);
    } catch (error) {
      console.warn('[Workspaces] a row that has moved on could not be closed:', error);
    }
  }
  return closed;
}
