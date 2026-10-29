//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @file ConversationDocument - Yjs CRDT wrapper for conversations
 *
 * Provides high-level API for conversation state management using Yjs.
 * Undo/redo is handled by the worker thread.
 *
 * Unified storage architecture:
 * - root: Y.Map containing 'items' Y.Array (ordered conversation flow)
 * - metadata: Y.Map for model config, strategy, etc.
 * - Context items are stored as ContextItemMessage items in the items array with inline data
 */

import * as Y from '../vendor/yjs.mjs';
import DocumentSyncManager from '../utils/document-sync-manager.js';
import { reportFault } from '../utils/fault-report.js';

/**
 * ConversationDocument - CRDT-based conversation state
 *
 * Uses Yjs for conflict-free collaborative editing. Contains:
 * - root: Y.Map containing 'items' Y.Array (unified storage)
 * - metadata: Y.Map for model config, strategy, etc.
 */
export class ConversationDocument {
  /**
   * @param {string} conversationId - Unique conversation ID
   * @param {string} authorId - Current author ID (e.g., "user:jules")
   */
  constructor(conversationId, authorId) {
    this.conversationId = conversationId;
    this.authorId = authorId;

    this.doc = new Y.Doc();

    /** @type {*} */
    this.root = this.doc.getMap('root');
    /** @type {*} */
    this.metadata = this.doc.getMap('metadata');

    /** @type {DocumentSyncManager} */
    // @ts-ignore - Yjs type mismatch between vendor version and imports
    this._syncManager = new DocumentSyncManager(this.doc);

    // A batch that fails is this conversation's inbound stream missing an
    // update, so the report has to name which conversation it was: the symptom
    // is one conversation frozen among healthy ones, and without the id the log
    // says only that something somewhere failed to render.
    this._syncManager.onSyncFault = (fault) => {
      reportFault(`yjs-${fault.phase}`, fault.error, {
        convId: this.conversationId,
        bytes: fault.bytes,
        consecutive: fault.consecutive,
        unrecoverable: fault.unrecoverable
      });
    };
  }

  // ========================================================================
  // SYNC
  // ========================================================================

  /**
   * Initialize as client (sync only)
   */
  initializeAsClient() {
    this._syncManager.initializeAsClient();
  }

  /**
   * Set the callback invoked for sync broadcasts.
   * @param {(bytes: Uint8Array, opts?: { engineDerived?: boolean }) => void} onSyncBroadcast
   */
  setOnSyncBroadcast(onSyncBroadcast) {
    this._syncManager.onSyncBroadcast = onSyncBroadcast;
  }

  /**
   * Activate sync (after worker is ready)
   * @param {{ broadcastInitialState?: boolean }} [opts]
   */
  activateSync(opts) {
    this._syncManager.activateSync(opts);
  }

  /**
   * Re-broadcast the full doc state to the worker on demand (the missing-model
   * self-heal, Conversation.trySelfHealMissingModel). See
   * DocumentSyncManager.broadcastFullState.
   */
  broadcastFullState() {
    this._syncManager.broadcastFullState();
  }

  /**
   * Apply a sync update from remote
   * @param {Uint8Array} update
   */
  applySyncUpdate(update) {
    this._syncManager.applySyncUpdate(update);
  }

  /**
   * Flush all pending sync updates immediately
   * Use after undo/redo to ensure state is current before reading
   */
  flushPendingUpdates() {
    this._syncManager.flushPendingUpdates();
  }

  /**
   * @returns {boolean} True if sync is active
   */
  isSyncActive() {
    return this._syncManager.isConnected();
  }

  /**
   * Encode this document's Yjs state vector — the compact summary of which
   * ops it already holds. Sent to the worker on reconnect so it can reply
   * with only the ops we're missing (differential catch-up) instead of
   * full document state.
   * @returns {Uint8Array} The encoded Yjs state vector.
   */
  getStateVector() {
    return Y.encodeStateVector(this.doc);
  }

  /**
   * The ops this document holds that a peer with `remoteStateVector` lacks.
   * See DocumentSyncManager.updateSince — a delta, never full state.
   * @param {Uint8Array} remoteStateVector - The peer's encoded Yjs state vector.
   * @returns {Uint8Array|null} The ops the peer lacks, or null if it has them all.
   */
  updateSince(remoteStateVector) {
    return this._syncManager.updateSince(remoteStateVector);
  }

  // ========================================================================
  // MUTATIONS
  // ========================================================================

  /**
   * Set metadata field
   * @param {string} key
   * @param {*} value
   */
  setMetadata(key, value) {
    this.doc.transact(() => {
      this.metadata.set(key, value);
    }, this.authorId);
  }

  /** @returns {object} JSON representation */
  toJSON() {
    const items = this.root.get('items');
    return {
      items: items
        ? items.toArray().map((/** @type {any} */ item) =>
          item instanceof Y.Map ? item.toJSON() : item
        )
        : [],
      metadata: Object.fromEntries(this.metadata.entries())
    };
  }

  // ========================================================================
  // OBSERVERS
  // ========================================================================

  /** @param {(event: any, transaction: any) => void} callback */
  observeMetadata(callback) { this.metadata.observe(callback); }

  /** @param {(event: any, transaction: any) => void} callback */
  unobserveMetadata(callback) { this.metadata.unobserve(callback); }

  destroy() {
    this._syncManager.destroy();
    this.doc.destroy();
  }
}

export default ConversationDocument;
