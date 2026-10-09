//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The places a conversation could work, and what is known about each of them.
 *
 * Three views ask this question and none of them is a conversation being set
 * up: the dialog that makes a workspace, the dialog that moves a conversation
 * into one, and the dialog that puts a lost one back. So this holds no state
 * about any conversation. It holds the list itself, the speculative statuses
 * that make choosing from it an informed act rather than a guess, and the
 * register of things a provider has found on disk that the table does not know
 * about.
 *
 * It is deliberately view-free: everything below can be driven, and is tested,
 * without a single click. Nothing here announces anything either — a view calls
 * a probe and redraws when the promise settles, which is the whole of the
 * contract.
 * @module services/workspace-places
 */

import workspaceProviderRegistry from '../registries/workspace-provider-registry.js';
import { workspaceStatus } from './workspace-provisioning.js';
import { registerWorkspace, isWorkspaceUsable } from './workspaces.js';
import { createBoundOps } from '../../sdk/ops.js';

/** The row id of the project itself: the workspace every conversation has already. */
export const PROJECT_ROW_ID = '';

/** What a "New…" row's id starts with; the rest of it is the provider's id. */
export const NEW_ROW_PREFIX = 'new:';

/** What a row offering something that already exists starts with. */
export const ADOPT_ROW_PREFIX = 'adopt:';

/**
 * The kind that leads the list of ways to make one, whatever order the
 * providers were loaded in.
 *
 * A special case on purpose. A group builds nothing and cannot surprise anyone,
 * so it is the safest thing to be chosen by default, and leading the list is
 * what makes it findable at all behind a button called "New workspace or
 * group". Every other kind keeps the order it was loaded in.
 */
export const LEADING_PROVIDER_ID = 'group';

/**
 * One row of the list of places.
 * @typedef {object} SetupRow
 * @property {'project'|'workspace'|'adopt'|'new'} kind - Which band it belongs to
 * @property {string} id - What the view selects by
 * @property {string} label - What the row says
 * @property {string} [meaning] - What choosing it does, in plain words
 * @property {string} [detail] - Where it is: a path, or what a probe last said
 * @property {string} [providerId] - For a `new` row, whose form it expands into
 */

/** @type {Map<string, any>} Workspace id → its last speculative status. */
const statusCache = new Map();

/** @type {Map<string, {providerId: string, artifact: any}>} Row id → something that exists and has no workspace. */
const adoptable = new Map();

/**
 * The rows of the workspace section, in the order they are offered.
 *
 * Three bands: the project, then every workspace that already exists and can be
 * worked in, then one row per provider that could make another. The middle band
 * is first-class rather than a pooling detail — binding to a worktree that is
 * already built, or a host already known, is the common path, and making a new
 * one is the rare one.
 *
 * A workspace still being built, already finished with, or whose root is not
 * there is not offered: all three refuse every operation, so binding to one
 * would be choosing somewhere that cannot be worked in. The third is not a
 * state but a fact that can reverse — the row stays on the table and comes
 * back here when its tree does.
 * @param {any} session - The session whose table and providers these are.
 * @returns {SetupRow[]} The rows, project first.
 */
export function setupRows(session) {
  /** @type {SetupRow[]} */
  const rows = [{
    kind: 'project',
    id: PROJECT_ROW_ID,
    label: 'The project folder',
    // Where every conversation worked before workspaces existed, said plainly:
    // the reader deciding this has met the word "workspace" for the first time a
    // moment ago, and what they need is what happens to their files. It is named
    // after the place rather than after its place in the list — "Default" told
    // somebody choosing where their work would happen only that we had chosen
    // for them.
    meaning: 'No separate workspace: this conversation works in the project folder itself.',
    detail: session?.projectPath ?? ''
  }];

  for (const workspace of session?.workspaces ?? []) {
    if (!isWorkspaceUsable(workspace)) continue;
    rows.push({
      kind: 'workspace',
      id: workspace.id,
      label: workspace.label || workspace.root,
      detail: workspace.root
    });
  }

  // Places that exist and have no row: the pool, and anything a hand-run
  // command left behind. Between what is registered and what could be made,
  // because that is what it is — something that exists, one click from being
  // usable.
  for (const [id, offer] of adoptable) {
    const root = offer.artifact.workspace?.root;
    const rowFor = (/** @type {any} */ candidate) => candidate.root === root;
    // A live row already offers this place in the band above, so the same place
    // must not also be offered as something to adopt. A tombstone does not: it
    // is a place somebody stopped using, and picking it up again is the whole
    // reason stopping is not deleting.
    if (session?.workspaces?.some?.((/** @type {any} */ row) => rowFor(row) && row.state !== 'closed')) {
      continue;
    }
    const parked = session?.workspaces?.find?.((/** @type {any} */ row) => rowFor(row) && row.state === 'closed');
    rows.push({
      kind: 'adopt',
      id,
      label: offer.artifact.label || offer.artifact.workspace?.root || '',
      detail: offer.artifact.detail || '',
      // Which of the two kinds of found thing this is. A stray tree somebody
      // made by hand and one this project parked last week are both one click
      // from usable and read identically otherwise, and only one of them is
      // somewhere the reader has already been.
      meaning: parked
        ? 'You stopped using this workspace. Adopting it picks up where you left off.'
        : undefined,
      providerId: offer.providerId
    });
  }

  const providerIds = workspaceProviderRegistry.getIds();
  const ordered = [
    ...providerIds.filter((id) => id === LEADING_PROVIDER_ID),
    ...providerIds.filter((id) => id !== LEADING_PROVIDER_ID)
  ];
  for (const providerId of ordered) {
    const provider = workspaceProviderRegistry.createProvider(providerId, session);
    if (!provider) continue;
    rows.push({
      kind: 'new',
      id: `${NEW_ROW_PREFIX}${providerId}`,
      label: provider.getSetupLabel(),
      // What the provider says one of its places is. It is what this row means
      // rather than where it is — nothing is anywhere yet — so it reads on the
      // meaning line, which is the line a reader needs here.
      meaning: provider.getManifest().description,
      providerId
    });
  }

  return rows;
}

/**
 * Ask every listed workspace how it is doing, at once.
 *
 * Speculative by design: a view shows a branch and a dirty flag for rows the
 * user has not selected, which is what makes picking one an informed choice
 * rather than a guess — and why `status()` is documented as having to be cheap.
 * The answers are cached, and the whole sweep rides one signal so that closing
 * the view stops all of it.
 * @param {any} session - The session the workspaces belong to.
 * @param {AbortSignal} [signal] - Abort when the view closes.
 * @returns {Promise<void>} When every row has answered or been abandoned.
 */
export async function probeSetupStatuses(session, signal) {
  const rows = setupRows(session).filter(row => row.kind === 'workspace');
  await Promise.all(rows.map(async (row) => {
    const workspace = session.getWorkspace(row.id);
    if (!workspace) return;
    const status = await workspaceStatus(session, workspace, signal);
    if (signal?.aborted) return;
    statusCache.set(row.id, status);
  }));
}

/**
 * Ask every provider what exists that the table does not know about.
 *
 * This is `reconcile()` used for the half of its job that is an offer rather
 * than a cleanup, and it runs per window rather than under the startup claim:
 * enumerating is read-only by contract — the claim exists so that three windows
 * do not run `git worktree prune` at each other — and a panel opened an hour
 * after startup must show what is there now.
 *
 * It is what makes a pool worth having. A tree that exists and is already built
 * is one click from being somewhere a conversation works, with no pool-release
 * machinery anywhere and no fresh-tree recompile.
 * @param {any} session - The session whose table and providers these are.
 * @param {AbortSignal} [signal] - Abort when the panel closes.
 * @returns {Promise<void>} When every provider has answered or been abandoned.
 */
export async function probeSetupAdoptions(session, signal) {
  const rows = session?.workspaces ?? [];
  await Promise.all(workspaceProviderRegistry.getIds().map(async (providerId) => {
    const provider = workspaceProviderRegistry.createProvider(providerId, session);
    if (!provider) return;
    try {
      // Tombstones go too. A row that has been finished with lays no claim to
      // its artifact — that is what finishing with it meant — but it is the only
      // record of WHERE that artifact is, and a provider that is not told about
      // it cannot even look in the right place: a parked worktree of a
      // repository other than the project went unlisted entirely, because the
      // repository was only ever reached through the rows. Whether a closed row
      // still means anything is the provider's judgement, and both of ours skip
      // them when matching, so their artifacts are offered again.
      const report = await provider.reconcile(
        rows.filter((/** @type {any} */ row) => row.providerId === providerId),
        {
          session,
          ops: createBoundOps(() => ({})),
          baseWorkspaceId: '',
          signal: signal ?? new AbortController().signal,
          rollback: { push: () => {} },
          checkpoint: async () => {},
          progress: () => {}
        });
      if (signal?.aborted) return;
      for (const found of report?.orphanedArtifacts ?? []) {
        const artifact = /** @type {any} */ (found);
        if (!artifact?.workspace?.root) continue;
        const rowId = `${ADOPT_ROW_PREFIX}${providerId}\u0000${artifact.id ?? artifact.workspace.root}`;
        adoptable.set(rowId, { providerId, artifact });
      }
    } catch (error) {
      // A provider that cannot enumerate is not a reason to say anything at
      // all: the view simply offers what it always offered.
      console.warn(`[Places] ${providerId} could not say what exists:`, error);
    }
  }));
}

/**
 * Register something a provider found, so a conversation can be bound to it.
 *
 * Adopting builds nothing and changes nothing on disk — it is the table
 * catching up with a tree that was already there — which is why it is the one
 * row in the panel that acts on a single click.
 *
 * It is also how a lost table is recovered, which is the same act under a
 * different name: `id` registers the place under an id of the caller's choosing
 * rather than a fresh one, so that conversations still bound to that id resolve
 * again instead of being moved one by one to a tree they never left. An id the
 * table already holds is refused by the server, and the refusal is left to
 * reach the caller: quietly registering it as something else would be the one
 * answer nobody could act on.
 * @param {any} session - The session to register it with.
 * @param {string} rowId - The `adopt:` row that was clicked.
 * @param {{id?: string}} [options] - The id to register it under, where the caller has one that matters.
 * @returns {Promise<any>} The registered workspace, or null when the offer has gone.
 */
export async function adoptSetupRow(session, rowId, options = {}) {
  const offer = adoptable.get(rowId);
  if (!offer) return null;

  const registered = await registerWorkspace({
    ...(options?.id ? { id: options.id } : {}),
    root: offer.artifact.workspace.root,
    label: offer.artifact.workspace.label || offer.artifact.label || '',
    providerId: offer.providerId,
    state: 'ready',
    meta: offer.artifact.workspace.meta ?? {}
  });

  // Taken, so no longer on offer. The row a view shows from here is the
  // ordinary workspace row, in the band where every other workspace is.
  adoptable.delete(rowId);
  if (session && !session.workspaces?.some?.((/** @type {any} */ row) => row.id === registered.id)) {
    // The broadcast will bring it too, but the view is on screen now and the
    // click that adopted it has to do something visible.
    session.workspaces = [...(session.workspaces ?? []), registered];
  }
  return registered;
}

/**
 * The last thing a workspace said about itself, if it has been asked.
 * @param {string} workspaceId - The workspace in question.
 * @returns {any} Its status, or undefined while the answer is still coming.
 */
export function cachedSetupStatus(workspaceId) {
  return statusCache.get(workspaceId);
}
