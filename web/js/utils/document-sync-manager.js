//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * DocumentSyncManager - Unified manager for Yjs document sync
 *
 * Consolidates all Yjs sync concerns into one place:
 * - Y.Doc lifecycle
 * - Bidirectional sync protocol
 * - State persistence
 *
 * This class is DATA-MODEL AGNOSTIC - it knows nothing about conversations,
 * items, context items, etc. It just manages Yjs documents.
 *
 * Usage:
 *   const syncManager = new DocumentSyncManager(doc);
 *   syncManager.initializeAsClient();
 */

import * as Y from '../vendor/yjs.mjs';
import { YJS_SYNC_BATCH_MS, YJS_SYNC_BATCH_MAX_MS } from './constants.js';

/**
 * Fraction of wall-clock time applying batches is allowed to consume, as a
 * divisor: the next batching window is the last batch's cost times this, so
 * cost/window settles at 1/COST_BUDGET_DIVISOR. At 8, a batch that takes 6ms or
 * less to apply leaves the window at its YJS_SYNC_BATCH_MS floor, so only a
 * genuinely expensive render widens it.
 */
const COST_BUDGET_DIVISOR = 8;

/**
 * Smoothing factor for the cost estimate (weight given to the newest sample).
 * Batch costs are spiky — a structural render or a tab activation costs many
 * times what a streaming token does — and pinning the window wide for one
 * outlier would be worse than the stutter it avoids. This tracks a sustained
 * change within a few batches while damping a single spike.
 */
const COST_SMOOTHING = 0.4;

/**
 * Idle gap (milliseconds) after which the cost estimate is discarded. Widening
 * the window pays off only while updates arrive back-to-back; carrying a stale
 * estimate across a quiet period would delay the first update of the next burst
 * by up to the cap, which is exactly the update a user is most likely to be
 * waiting on (their own message being echoed back).
 */
const COST_IDLE_RESET_MS = 1000;

/**
 * Consecutive batch failures tolerated before the manager stops trying to carry
 * on and reports the fault as unrecoverable. A single failure is usually one bad
 * render that the next update renders straight past, so tearing the conversation
 * down for it would be worse than the glitch. A run of them means the document
 * has reached a state this client cannot display incrementally, and nothing but
 * fresh state will clear it.
 */
const MAX_CONSECUTIVE_SYNC_FAILURES = 3;

/**
 * Origin sentinel for Yjs transactions whose writes are pure derivations of
 * already-undoable state (e.g. the engine's tool-action reducer writing
 * PENDING / approvalOptions / displayData in response to observing an
 * inserted tool-action). The sync manager forwards this marker to the
 * broadcast callback so the transport can flag the outgoing update; the
 * worker then applies it with a non-tracked origin and the UndoManager
 * skips it. Without this, every undo would pop only the most recent
 * derivation and the engine would immediately re-derive — making undo a
 * visible no-op.
 * @type {string}
 */
export const ENGINE_DERIVED_ORIGIN = 'engine-derived';

/**
 * Byte length of a Yjs update that carries nothing at all — no structs and an
 * empty delete set. Measured from an empty document rather than hard-coded, so
 * it tracks whatever encoder version Yjs uses. A diff of exactly this length
 * means the peer already holds everything this doc has.
 *
 * Longer is the only safe reading of "has something to say": Yjs writes the
 * whole delete set into every update regardless of the target state vector, and
 * a deletion advances no clock, so a delete made while the link was down shows
 * up in the diff's bytes and nowhere in the state vectors.
 * @type {number}
 */
const EMPTY_UPDATE_LENGTH = Y.encodeStateAsUpdate(new Y.Doc()).length;

/**
 * What the sync manager knows about an outgoing update beyond its bytes.
 * @typedef {object} SyncBroadcastOptions
 * @property {boolean} [engineDerived] - The update's origin was
 *   ENGINE_DERIVED_ORIGIN.
 * @property {number} [sinceEditMs] - Milliseconds since this doc's previous
 *   local edit, on a local edit that has one. The worker groups edits into undo
 *   steps by this rather than by when it applies them, which a loaded machine
 *   can space far further apart than the user made them.
 */

/**
 * @typedef {(bytes: Uint8Array, opts?: SyncBroadcastOptions) => void} SyncBroadcastCallback
 */

/**
 * @typedef {object} SyncFault
 * @property {'merge'|'apply'} phase - Which half of the batch failed. `merge` is
 *   pure and the document has not seen the bytes; `apply` means Yjs integrated
 *   the update and the UI fan-out threw afterwards.
 * @property {any} error - What was thrown.
 * @property {number} bytes - Size of the payload involved.
 * @property {number} consecutive - How many batches have now failed in a row.
 * @property {boolean} unrecoverable - Set once the run passes
 *   MAX_CONSECUTIVE_SYNC_FAILURES: this client can no longer display the
 *   document by applying deltas to it, and needs fresh state.
 */

/**
 * @typedef {(fault: SyncFault) => void} SyncFaultCallback
 */

class DocumentSyncManager {
  /**
   * Create a new document sync manager
   * @param {import('yjs').Doc} doc - The Y.Doc to manage
   */
  constructor(doc) {
    /** @type {import('yjs').Doc} */
    this.doc = doc;

    /** @type {boolean} */
    this._connected = false;

    /** @type {boolean} */
    this._initialized = false;

    // Callbacks
    /** @type {SyncBroadcastCallback|null} */
    this.onSyncBroadcast = null;

    /**
     * Where a failed batch is reported. Applying a batch runs the whole UI
     * fan-out synchronously, so this is the only place a render fault in a
     * conversation's inbound path can be observed at all — nothing downstream
     * of Y.applyUpdate knows the update was meant to arrive.
     * @type {SyncFaultCallback|null}
     */
    this.onSyncFault = null;

    /**
     * Batches that have failed back-to-back. Reset by the first one that
     * applies cleanly, so an isolated bad render costs nothing.
     * @type {number}
     */
    this._consecutiveFailures = 0;

    // Batching state for incoming updates
    /** @type {Uint8Array[]} */
    this._pendingUpdates = [];

    /** @type {number|null} */
    this._batchTimer = null;

    /**
     * Smoothed cost of applying one batch (milliseconds), and when the last one
     * was applied. Together these set the next batching window.
     * @type {number}
     */
    this._batchCostMs = 0;

    /** @type {number} */
    this._lastBatchAt = 0;

    /**
     * When this doc last made a local edit the worker's undo tracks
     * (performance.now()), or null before the first. Engine-derived writes are
     * not tracked there, so they neither carry nor move it.
     * @type {number|null}
     */
    this._lastLocalEditAt = null;

    /**
     * The clock local edits are timed by, and batch costs and idle gaps read
     * from, in milliseconds. Per document, so a test can hold one
     * conversation's clock still across edits it means as made together
     * without touching any other — on a slow enough core the synchronous work
     * one edit sets off spaces the next further apart than any undo window,
     * however quickly they were issued — and can say what a batch cost
     * without burning that much of a real core.
     * @type {() => number}
     */
    this.now = () => performance.now();

    // Update handler for sync (bound to preserve 'this')
    /** @type {(update: Uint8Array, origin: any) => void} */
    this._updateHandler = (update, origin) => {
      // Don't broadcast updates that came from remote (avoid echo)
      if (origin !== this && this.onSyncBroadcast) {
        if (origin === ENGINE_DERIVED_ORIGIN) {
          this.onSyncBroadcast(update, { engineDerived: true });
          return;
        }
        const now = this.now();
        const previous = this._lastLocalEditAt;
        this._lastLocalEditAt = now;
        this.onSyncBroadcast(update, previous === null ? undefined : { sinceEditMs: Math.round(now - previous) });
      }
    };
  }

  /**
   * Initialize as client (sync only)
   * Does NOT connect immediately - call activateSync() when ready
   */
  initializeAsClient() {
    if (this._initialized) {
      throw new Error('[DocumentSyncManager] Already initialized');
    }
    this._initialized = true;
  }

  /**
   * Activate sync (client side, after worker is ready). Idempotent.
   *
   * `broadcastInitialState` defaults to true: encode the doc state and
   * ship it to the worker, picking up any local additions the browser
   * made before activation (e.g. a newly-created conv's system prompt or
   * AI-assistant context items). For conversations loaded from disk the
   * worker already has the full state, so pass false to skip the encode
   * + charCodeAt/btoa broadcast — it can block the main thread for
   * hundreds of ms on large docs.
   * @param {{ broadcastInitialState?: boolean }} [opts]
   */
  activateSync({ broadcastInitialState = true } = {}) {
    if (this._connected) return;
    this.doc.on('update', this._updateHandler);
    this._connected = true;
    if (broadcastInitialState && this.onSyncBroadcast) {
      this.onSyncBroadcast(Y.encodeStateAsUpdate(this.doc));
    }
  }

  /**
   * Re-encode the entire doc and broadcast it to the worker on demand.
   *
   * Unlike activateSync (idempotent, fires its initial-state push at most once),
   * this can be called any time to repair a worker whose doc is missing state the
   * client already holds — the outbound-sync gap behind the missing-model
   * self-heal (Conversation.trySelfHealMissingModel). It sends through the same
   * broadcast sink as incremental updates, so it works even if the incremental
   * `doc.on('update')` handler was never attached. No-op when no broadcast sink is wired.
   */
  broadcastFullState() {
    if (this.onSyncBroadcast) {
      this.onSyncBroadcast(Y.encodeStateAsUpdate(this.doc));
    }
  }

  /**
   * The ops this doc holds that a peer whose state is `remoteStateVector`
   * lacks — a delta, never full state; the vector argument is what makes it
   * one. Returns null when the peer is already up to date, so callers send
   * nothing rather than a two-byte no-op.
   *
   * This is the outbound half of the reconnect resync: the worker's answer to a
   * resync-request carries its state vector, and this turns it into exactly the
   * ops the worker is missing — the edits made here while the socket was down,
   * which the transport discarded.
   * @param {Uint8Array} remoteStateVector - The peer's encoded Yjs state vector.
   * @returns {Uint8Array|null} The ops the peer lacks, or null if it has them all.
   */
  updateSince(remoteStateVector) {
    const update = Y.encodeStateAsUpdate(this.doc, remoteStateVector);
    return update.length > EMPTY_UPDATE_LENGTH ? update : null;
  }

  /**
   * Apply a sync update from remote.
   *
   * Batches rapid updates to reduce main thread blocking during streaming, over
   * a window that widens as applying a batch gets more expensive.
   *
   * The widening is what keeps a long streamed message from degrading. Applying
   * a batch runs the entire UI fan-out synchronously inside Y.applyUpdate — the
   * Yjs observers, the conversation:changed dispatch, and every component
   * re-render they reach — and an assistant bubble re-renders by re-parsing its
   * whole accumulated markdown and replacing its whole subtree. That is O(n) in
   * the length of a message that grows to n, so at a fixed window it costs
   * O(n²) over a turn and the stutter gets worse the longer the model talks.
   * Batching on a window proportional to what the last batch actually cost
   * bounds the total at a fixed fraction of wall-clock time instead.
   *
   * Measured cost, rather than message length, because length is a poor proxy
   * for it: tables and fenced code blocks cost several times what the same
   * weight of prose does, and the whole point is to track the real thing. It
   * also calibrates itself to the machine, and it costs nothing off the main
   * thread — the engine worker has no DOM to render into, so its batches stay
   * cheap and its window stays at the floor.
   *
   * Deliberately here and not in the components that do the expensive work:
   * conversation-area measures element heights and the reader's scroll anchor
   * either side of the content update, synchronously, to glide the growing
   * bubble and hold the reader's place. Deferring the render out from between
   * those two measurements breaks both. Coalescing at the source keeps every
   * consumer's timing assumptions intact, and keeps the trailing edge free:
   * pending updates are always applied, only later, which matters because
   * nothing downstream guarantees a final re-render once a turn ends.
   * @param {Uint8Array} update - The update bytes to apply
   */
  applySyncUpdate(update) {
    this._pendingUpdates.push(update);

    if (this._batchTimer === null) {
      // Bare setTimeout/clearTimeout are globals in both the window and a
      // module worker; window.* would throw off the main thread.
      this._batchTimer = setTimeout(() => {
        this._applyBatchedUpdates();
      }, this._nextBatchDelay());
    }
  }

  /**
   * How long to wait before applying the batch now being accumulated.
   * @returns {number} Delay in milliseconds, between the floor and the cap.
   * @private
   */
  _nextBatchDelay() {
    // An update arriving after a quiet spell starts a new burst rather than
    // continuing the last one, so it gets the floor regardless of how expensive
    // the previous burst's batches were.
    if (this._lastBatchAt && this.now() - this._lastBatchAt > COST_IDLE_RESET_MS) {
      this._batchCostMs = 0;
    }
    const target = this._batchCostMs * COST_BUDGET_DIVISOR;
    return Math.min(YJS_SYNC_BATCH_MAX_MS, Math.max(YJS_SYNC_BATCH_MS, target));
  }

  /**
   * Flush all pending updates immediately (synchronously)
   * Use this before reading state that depends on recently received updates
   */
  flushPendingUpdates() {
    if (this._batchTimer !== null) {
      clearTimeout(this._batchTimer);
      this._batchTimer = null;
    }
    this._applyBatchedUpdates();
  }

  /**
   * Apply all pending updates as a single merged update.
   *
   * Every observer, and so every component re-render they reach, runs
   * synchronously inside Y.applyUpdate, so a throw from anywhere in the UI
   * fan-out arrives here. It must not be allowed to leave: an exception
   * escaping into the batch timeout takes this conversation's inbound stream
   * with it while its outbound half — a separate path, through
   * doc.on('update') — carries on working. That pair reads as a conversation
   * frozen mid-turn which still accepts messages and never answers them, and
   * because the fan-out is per-document it strands exactly one conversation
   * while every other one in the same client stays healthy.
   *
   * The two failures are not the same thing and are not treated the same. A
   * merge is pure and the document has not seen the bytes, so they go back on
   * the queue and the next batch retries them. An apply that throws has already
   * integrated the structs — Yjs runs observers after integration — so the
   * document DOES hold the update and only the fan-out failed; re-applying it
   * would change nothing, so it is dropped.
   *
   * Either way the fault is reported rather than swallowed, and a run of them
   * is reported as unrecoverable instead of discarding renders in silence for
   * the life of the page.
   * @private
   */
  _applyBatchedUpdates() {
    this._batchTimer = null;

    if (this._pendingUpdates.length === 0) {
      return;
    }

    const updates = this._pendingUpdates;
    this._pendingUpdates = [];

    // Merge all pending updates into one to reduce deserialization overhead
    let merged;
    try {
      merged = Y.mergeUpdates(updates);
    } catch (err) {
      this._noteSyncFault('merge', err, updates.reduce((n, u) => n + u.length, 0));
      // Nothing consumed them, so they are still owed to the document: put them
      // back ahead of anything that arrived while this ran, and schedule the
      // retry rather than waiting for traffic that may never come — a stalled
      // conversation produces no next update to ride in on. Only while the run
      // is short. A merge is deterministic, so past the threshold retrying is
      // just a timer burning the main thread on bytes that will never decode.
      if (this._consecutiveFailures < MAX_CONSECUTIVE_SYNC_FAILURES) {
        this._pendingUpdates = updates.concat(this._pendingUpdates);
        this._batchTimer = setTimeout(() => {
          this._applyBatchedUpdates();
        }, this._nextBatchDelay());
      }
      return;
    }

    // Apply once with 'this' as origin to prevent echo. The observers, and so
    // every re-render they trigger, run synchronously inside this call, which is
    // what makes timing it a measurement of the whole UI tick and not just of
    // Yjs. Layout and paint land after it, so this reads slightly low — it
    // tracks the term that actually grows with message length.
    const startedAt = this.now();
    try {
      Y.applyUpdate(this.doc, merged, this);
      this._consecutiveFailures = 0;
    } catch (err) {
      this._noteSyncFault('apply', err, merged.length);
    } finally {
      // Timed in a finally because a fan-out that threw part way through still
      // spent the time, and sizing the next window off a stale estimate would
      // describe a batch this document no longer resembles.
      const cost = this.now() - startedAt;
      this._batchCostMs = this._batchCostMs
        ? this._batchCostMs * (1 - COST_SMOOTHING) + cost * COST_SMOOTHING
        : cost;
      this._lastBatchAt = this.now();
    }
  }

  /**
   * Count a failed batch and report it.
   *
   * The reporter is wired to the fault channel that reaches the server log,
   * because this runs in a viewer whose console cannot be opened: a fault
   * nobody records here is a conversation that stops updating for no stated
   * reason.
   * @param {'merge'|'apply'} phase - Which half of the batch failed.
   * @param {any} error - What was thrown.
   * @param {number} bytes - Size of the payload involved.
   * @private
   */
  _noteSyncFault(phase, error, bytes) {
    this._consecutiveFailures++;
    if (!this.onSyncFault) return;
    try {
      this.onSyncFault({
        phase,
        error,
        bytes,
        consecutive: this._consecutiveFailures,
        unrecoverable: this._consecutiveFailures >= MAX_CONSECUTIVE_SYNC_FAILURES
      });
    } catch {
      // A reporter that throws must not become the thing that kills sync.
    }
  }

  // ========================================================================
  // LIFECYCLE
  // ========================================================================

  /**
   * Check if sync is active
   * @returns {boolean} True if sync is active
   */
  isConnected() {
    return this._connected;
  }

  /**
   * Destroy the manager and cleanup resources
   */
  destroy() {
    // Apply any pending updates before destroying
    if (this._batchTimer !== null) {
      clearTimeout(this._batchTimer);
      this._applyBatchedUpdates();
    }

    // Stop listening to updates
    if (this._connected) {
      this.doc.off('update', this._updateHandler);
      this._connected = false;
    }

    // Clear callbacks
    this.onSyncBroadcast = null;

    this._initialized = false;
  }
}

export default DocumentSyncManager;
