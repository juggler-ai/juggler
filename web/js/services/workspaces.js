//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Writing to the session's workspace table.
 *
 * The table itself is read from {@link Session#workspaces}, which the load fills
 * and every broadcast replaces. This module is the other direction: the calls
 * that put a row there, move it along, and take it away again. They are here
 * rather than on `Session` because the caller is the provisioning host, not the
 * model — a row exists before anything in the browser is bound to it, and often
 * before the thing it describes exists on disk.
 *
 * Nothing here updates {@link Session#workspaces} itself. Every one of these
 * endpoints broadcasts the whole table, and the session's `workspaces-changed`
 * handler applies it — so a client that also wrote the row locally would be
 * holding a second, briefly-different copy of state the server owns. The
 * returned row is the server's answer to this call, for a caller that needs the
 * assigned id immediately; it is not the table.
 * @module services/workspaces
 */

import { fetchJson } from './http.js';
import { apiUrl } from '../utils/api-url.js';

/**
 * Whether a workspace can be worked in.
 *
 * The one place this is decided on the client. It was written out separately at
 * three surfaces — the binding resolver, the composer chip and the new
 * conversation's picker — and they drifted: the picker checked the state and
 * not the root, so a workspace whose tree had been deleted went on being
 * offered as somewhere to start work, described by the error from the request
 * that failed against it. A predicate spelled out at each call site is a
 * predicate that will differ at one of them.
 *
 * It answers the same question as the server's `WorkspaceLookup.Usable`, which
 * stays the authority — this cannot be shared with Go, so the two are kept
 * deliberately alike and the server refuses again for anything that gets past
 * here. What this is for is not offering the user something that will be
 * refused.
 *
 * Both non-ready states refuse every operation, and a root that is not there
 * refuses them just as completely while saying nothing about itself. Absent
 * availability is treated as available: a row from a server that has not
 * answered yet is not evidence of a missing tree.
 * @param {import('../model/session.js').Workspace|null|undefined} workspace - The row, or nothing.
 * @returns {workspace is import('../model/session.js').Workspace} True when
 *   operations against it would be honoured — and, for a caller about to read
 *   the row, that there is a row to read.
 */
export function isWorkspaceUsable(workspace) {
  if (!workspace) return false;
  return workspace.state === 'ready' && workspace.available !== false;
}

/**
 * A change to one workspace. Every field is optional and an omitted one leaves
 * what is there alone, so a provider can record that it has built one thing
 * without restating a row it has not finished building.
 *
 * `meta` merges key by key rather than replacing, and a `null` value deletes its
 * key. That is what lets two checkpoints — or two windows — write different keys
 * without either erasing the other's.
 * @typedef {object} WorkspacePatch
 * @property {string} [label] - What the UI calls it.
 * @property {string} [root] - Where it is, once that is known.
 * @property {string} [state] - 'provisioning' | 'ready' | 'closed'.
 * @property {string} [place] - Where its box sits in the tab bar: 'head', or the conversation it sits behind.
 * @property {Record<string, any>} [meta] - Keys to merge into the provider's own record.
 */

/**
 * Every registered workspace.
 *
 * A viewer has the table already, so this is for the two callers that want what
 * the server holds right now rather than what this window was last told: the
 * reconcile pass, and a place list as it opens.
 *
 * It is also the only thing that re-checks whether each root is still there.
 * That makes the call worth making for its effect alone — the answer arrives
 * separately, as the `workspaces-changed` broadcast every viewer gets.
 * @returns {Promise<import('../model/session.js').Workspace[]>} The table.
 */
export async function listWorkspaces() {
  const answer = await fetchJson(apiUrl('/session/workspaces'));
  return answer?.workspaces ?? [];
}

/**
 * Put a workspace on the table.
 *
 * Registering comes FIRST, before anything is built: a provision that dies half
 * way through then leaves a row saying what was started, rather than an
 * unrecorded half-made tree for its user to find months later. So the usual call
 * names a state of `provisioning` and no root at all.
 *
 * The server names the row unless the caller does. Naming one is for putting
 * back a row a conversation is still bound to — a table lost with its
 * `session.json`, where the binding survives in the conversation's own document
 * and the id is all of it that does. Any other id is refused as already
 * registered.
 * @param {Partial<import('../model/session.js').Workspace>} workspace - The row to create; without an id the server assigns one.
 * @returns {Promise<import('../model/session.js').Workspace>} The row as stored, id included.
 */
export async function registerWorkspace(workspace) {
  const answer = await fetchJson(apiUrl('/session/workspaces'), { method: 'POST', body: workspace });
  return answer.workspace;
}

/**
 * Change part of one workspace.
 * @param {string} id - The workspace to change.
 * @param {WorkspacePatch} patch - What to change about it.
 * @returns {Promise<import('../model/session.js').Workspace>} The row as it now stands.
 */
export async function patchWorkspace(id, patch) {
  const answer = await fetchJson(apiUrl(`/session/workspaces/${encodeURIComponent(id)}`), {
    method: 'PATCH',
    body: patch
  });
  return answer.workspace;
}

/**
 * Rewrite the order the table is held in.
 *
 * Two boxes with no conversation between them sit in the same place, and the
 * table's order is the only thing that says which is drawn first — so a drag
 * that swaps them has nothing on either row to write, and this is what it
 * writes instead. Ids the table does not have are ignored; rows not named keep
 * their order behind the ones that are.
 * @param {string[]} ids - The workspaces in the order their boxes are drawn.
 * @returns {Promise<import('../model/session.js').Workspace[]>} The table as it now stands.
 */
export async function reorderWorkspaces(ids) {
  const answer = await fetchJson(apiUrl('/session/workspaces/reorder'), {
    method: 'POST',
    body: { ids }
  });
  return answer?.workspaces ?? [];
}

/**
 * Remove a row outright.
 *
 * What rolling back a provision does, and the only case where forgetting is the
 * right answer: the workspace was never finished, so nothing can have been bound
 * to it. Anything a user has worked in is closed instead: tombstoned, so the id
 * keeps resolving for a conversation still bound to it.
 * @param {string} id - The workspace to forget.
 * @returns {Promise<void>} When it is gone.
 */
export async function unregisterWorkspace(id) {
  await fetchJson(apiUrl(`/session/workspaces/${encodeURIComponent(id)}`), { method: 'DELETE' });
}

/**
 * Ask to be the client that reconciles the table against what is on disk.
 *
 * Answers yes at most once per run of the server, and the claim is spent by
 * asking. Reconciling means asking each provider what it can find, and providers
 * are extensions living in the browser — but there is no leader among clients,
 * so without this every open window would run it, and two of them would race
 * each other's destructive git commands over the same trees.
 * @returns {Promise<boolean>} Whether this client should reconcile.
 */
export async function claimWorkspaceReconcile() {
  const answer = await fetchJson(apiUrl('/session/workspaces/reconcile'), { method: 'POST' });
  return answer?.reconcile === true;
}
