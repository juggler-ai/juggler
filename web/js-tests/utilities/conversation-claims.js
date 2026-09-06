//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Conversation ownership claims for the multi-iframe test pool.
 *
 * Every lane shares ONE server session, so "which conversations belong to
 * which lane" is the safety boundary for anything destructive: a test that
 * deletes a conversation another lane is mid-turn on permanently tears down
 * that lane's worker (its doc freezes — e.g. a tool stuck at state=running
 * with no result — and the lane times out). Each lane records the
 * conversations it creates in its own `window.__ownConversationIds`; the
 * union of every lane's set (the iframes are same-origin siblings) is the
 * full claim map, and only UNclaimed conversations are ever safe to delete
 * from another lane.
 *
 * Claims are registered automatically: `installClaimAutoRegistration()`
 * patches the Session creation methods once per lane, so every creation
 * path — test harness, unit test, or a UI component like conversation-bar's
 * "+" button — lands in the registry without each call site remembering to.
 * @module utilities/conversation-claims
 */

import Session from '../../js/model/session.js';
import apiService from '../../js/services/api.js';

/**
 * Stable per-lane id for the test pool. Lazily generated once per page
 * lifecycle and cached on the window so every patched call from this lane tags
 * the same id. Test-only.
 * @returns {string} This lane's id
 */
function laneId() {
  /** @type {any} */ const g = globalThis;
  if (!g.__laneId) {
    g.__laneId = 'lane_' + Math.random().toString(36).slice(2, 10) +
			'_' + Date.now().toString(36);
  }
  return g.__laneId;
}

/**
 * Set the name of the test currently running in this lane. The create-patch
 * tags every conversation it creates with this name (server ?reason=), so a
 * suite-end leak dump names the culprit test instead of only a random lane id.
 * Called by the test runners at the start of each test/suite. Test-only.
 * @param {string} name
 */
export function setCurrentTestName(name) {
  /** @type {any} */ (globalThis).__convCreateReason = name || '';
}

/**
 * The name of the test currently running in this lane, for create attribution.
 * @returns {string} The current test's name, or '' if none has been set.
 */
function currentCreateReason() {
  return /** @type {any} */ (globalThis).__convCreateReason || '';
}

/**
 * Record a conversation as owned by this lane.
 * @param {string} convId
 */
export function registerOwnConversation(convId) {
  /** @type {any} */ const w = window;
  if (!w.__ownConversationIds) {
    w.__ownConversationIds = new Set();
  }
  w.__ownConversationIds.add(convId);
}

/**
 * Drop this lane's claim on a conversation it has already deleted. The
 * suite-end sweep deletes everything still claimed, so a test that releases a
 * conversation of its own accord says so here — otherwise the sweep spends a
 * DELETE apiece chasing ids that are already gone.
 * @param {string} convId
 */
export function forgetOwnConversation(convId) {
  /** @type {any} */ (window).__ownConversationIds?.delete(convId);
}

let _installed = false;

/**
 * Patch the conversation-creating/destroying chokepoints so this lane's
 * identity travels with every call. Idempotent; test pages only — production
 * never loads this module.
 *
 * - apiService.createConversation: tags the create with this lane's id (the
 *   server's test-mode ownership ledger records it — the enforced side of
 *   the claim) and registers the local claim from the response. This is the
 *   single HTTP doorway for creation, so every caller — test harness, unit
 *   test, or a UI component like conversation-bar's "+" button — is covered.
 * - apiService.deleteConversation / binConversation: tag the request with the
 *   lane id so the server can verify this lane owns the conversation. An
 *   untagged or cross-lane delete of an owned conversation is rejected
 *   server-side with 403.
 * - Session.duplicateConversation: duplication runs through the worker (no
 *   HTTP create), so the new id is claimed here. The server can't attribute
 *   it (unowned = unprotected), but the local claim still drives the
 *   BroadcastChannel filter and the unit-suite cleanup.
 */
export function installClaimAutoRegistration() {
  if (_installed) return;
  _installed = true;

  const origCreate = apiService.createConversation.bind(apiService);
  apiService.createConversation = async (name, id, options = {}) => {
    const result = await origCreate(name, id, {
      ...options,
      lane: laneId(),
      // Tag the create with the current test's name so a leaked conversation
      // is attributable even when this lane never registers it locally (a
      // create that succeeded server-side but whose response we never saw).
      reason: options.reason ?? currentCreateReason(),
    });
    if (result?.id) registerOwnConversation(result.id);
    return result;
  };

  const origDelete = apiService.deleteConversation.bind(apiService);
  apiService.deleteConversation = (convId, options = {}) =>
    origDelete(convId, { ...options, lane: laneId() });

  const origBin = apiService.binConversation.bind(apiService);
  apiService.binConversation = (convId, options = {}) =>
    origBin(convId, { ...options, lane: laneId() });

  const origDuplicate = Session.prototype.duplicateConversation;
  Session.prototype.duplicateConversation = async function (...args) {
    const convId = await origDuplicate.apply(this, args);
    if (convId) registerOwnConversation(convId);
    return convId;
  };
}

/**
 * Snapshot this lane's current claims, for created-since diffing.
 * @returns {Set<string>} A copy of the conversation IDs this lane currently claims.
 */
export function snapshotOwnConversationIds() {
  return new Set(/** @type {any} */ (window).__ownConversationIds ?? []);
}

/**
 * Delete (permanently) every conversation this lane claimed since `before`,
 * and release the claims. Used by the unit-suite wrapper so unit tests can't
 * leak conversations into the shared session — accumulated leaks are what
 * march the session toward MAX_CONVERSATIONS and force destructive
 * make-room deletes.
 * @param {Set<string>} before - Snapshot from snapshotOwnConversationIds().
 * @param {string} reason - Attribution tag logged by the server with each delete.
 */
export async function deleteOwnConversationsCreatedSince(before, reason) {
  /** @type {any} */ const owned = /** @type {any} */ (window).__ownConversationIds;
  if (owned) {
    const created = [...owned].filter((id) => !before.has(id));
    for (const id of created) {
      try {
        await apiService.deleteConversation(id, { permanent: true, reason });
      } catch {
        // Already gone (the test deleted it itself, or another cleanup won).
      }
      owned.delete(id);
    }
  }
  // Reconcile against the server's ownership ledger. A create that succeeded
  // server-side but whose response never reached us (dropped or slow — the
  // Windows-runner failure mode) records an owner the local claim set above
  // never saw, so the loop can't delete it and it leaks. Sweep anything the
  // SERVER still attributes to THIS lane: within a lane tests run sequentially
  // and each releases its own conversations, so any residue after our own
  // deletes is this lane's leak, safe to remove. Best-effort — a true residue
  // still trips the Go harness's leak check.
  await reconcileServerOwnedConversations(reason);
}

/**
 * Delete every conversation the server still attributes to THIS lane. Closes
 * the gap where a create is recorded server-side but never registered locally
 * (lost/slow create response), which no local-claim diff can catch.
 * @param {string} reason - Attribution tag for the reconciling deletes.
 */
async function reconcileServerOwnedConversations(reason) {
  /** @type {any} */ const owned = /** @type {any} */ (window).__ownConversationIds;
  const mine = laneId();
  try {
    const resp = await fetch('/api/test/conversation-owners');
    if (!resp.ok) return;
    const body = await resp.json();
    const owners = body?.owners ?? {};
    for (const [id, info] of Object.entries(owners)) {
      // Owners are {lane, reason}; tolerate a bare-string legacy shape too.
      const lane = typeof info === 'string' ? info : /** @type {any} */ (info)?.lane;
      if (lane !== mine) continue; // never touch another lane's live conversation
      try {
        await apiService.deleteConversation(id, { permanent: true, reason: `reconcile:${reason}` });
      } catch {
        // Already gone; ownership was released by the delete above.
      }
      owned?.delete(id);
    }
  } catch {
    // Endpoint unreachable (non-pool run, teardown race): best-effort only.
  }
}

/**
 * Filter conversation IDs down to the ones NO live lane claims — the only
 * ones safe to delete from a lane that doesn't own them. Anything claimed
 * belongs to a test that may be mid-turn.
 * @param {string[]} allIds - Candidate conversation IDs.
 * @param {ArrayLike<any>} [frames] - Windows to collect claims from
 *   (injectable for unit tests; defaults to this page's sibling lanes, or
 *   just this window outside the pool).
 * @returns {string[]} The subset of allIds with no claim, in input order.
 */
export function unclaimedConversationIds(allIds, frames = _siblingFrames()) {
  const claimed = new Set();
  for (let i = 0; i < frames.length; i++) {
    let owned;
    try {
      owned = frames[i].__ownConversationIds;
    } catch {
      continue; // detached/dead frame
    }
    // Claims come from another iframe's realm, so `instanceof Set` would
    // always be false there — duck-type membership via forEach instead.
    if (owned && typeof owned.forEach === 'function') {
      owned.forEach((/** @type {string} */ id) => claimed.add(id));
    }
  }
  return allIds.filter((id) => !claimed.has(id));
}

/**
 * Enumerate the same-origin windows that can hold conversation claims: every
 * lane iframe when running in the pool, else just this window.
 * @returns {any[]} The same-origin windows (lane iframes or this window) that may hold claims.
 */
function _siblingFrames() {
  try {
    if (window.parent && window.parent !== window) {
      const out = [];
      for (let i = 0; i < window.parent.frames.length; i++) out.push(window.parent.frames[i]);
      return out;
    }
  } catch { /* cross-origin parent: treat as standalone */ }
  return [window];
}
