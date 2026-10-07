//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Concurrency-limited orchestrator for lazy conversation hydration.
 *
 * Stubs are created by Session._doLoad before any id lands here; the queue
 * decides *when* to call workerManager.loader.loadExisting(). The conv's
 * loadState transitions through 'loading' → 'loaded' (or 'error') and the
 * session emits 'conversation:loadstate-changed' so listeners (tab bar,
 * conversation panel) can re-render. Failures retain the id on the session
 * (session.retainUnloadedConversationId) so it survives saveImmediately and
 * gets retried on the next reload.
 *
 * The loader's in-flight map dedupes concurrent loads for the same id,
 * so this queue does not need its own dedupe.
 */

/**
 * @typedef {object} LoadQueueLoader
 * @property {(id: string, session: import('../model/session.js').default) => Promise<import('../model/conversation.js').default>} loadExisting Hydrate the conversation's Yjs doc by spawning its backend worker
 */

class ConversationLoadQueue {
  /**
   * @param {object} opts
   * @param {import('../model/session.js').default} opts.session
   * @param {LoadQueueLoader} opts.loader - Normally `workerManager.loader`
   * @param {number} [opts.concurrency=3] - max in-flight loads
   */
  constructor({ session, loader, concurrency = 3 }) {
    // Without this every load would fail later as an ordinary load failure,
    // which reads as the conversation's fault rather than the caller's.
    if (typeof loader?.loadExisting !== 'function') {
      throw new TypeError('ConversationLoadQueue needs a loader with loadExisting (workerManager.loader)');
    }
    /** @type {import('../model/session.js').default} @private */
    this._session = session;
    /** @type {LoadQueueLoader} @private */
    this._loader = loader;
    /** @type {number} @private */
    this._concurrency = Math.max(1, concurrency);

    /** @type {string[]} @private */
    this._pending = [];
    /** @type {Map<string, Promise<void>>} @private */
    this._inflight = new Map();
    /** @type {Set<string>} @private */
    this._loaded = new Set();
    /** @type {Set<string>} @private */
    this._errored = new Set();
    /** @type {Map<string, Array<{resolve: () => void, reject: (err: any) => void}>>} @private */
    this._waiters = new Map();
    /** @type {boolean} @private */
    this._destroyed = false;
  }

  /**
   * Enqueue ids in order. Existing pending entries for the same id keep
   * their position (first-wins).
   * @param {string[]} ids
   */
  enqueueAll(ids) {
    for (const id of ids) this._enqueue(id);
    this._pump();
  }

  /**
   * Move id to the front of the pending list. Doesn't cancel an in-flight
   * load — that one's nearly done anyway.
   * @param {string} id
   */
  prioritize(id) {
    if (this._destroyed) return;
    if (this._loaded.has(id) || this._inflight.has(id)) return;
    const idx = this._pending.indexOf(id);
    if (idx !== -1) this._pending.splice(idx, 1);
    this._pending.unshift(id);
    this._pump();
  }

  /**
   * Re-attempt a previously-errored id at the front of the queue.
   * @param {string} id
   */
  retry(id) {
    if (this._destroyed) return;
    this._errored.delete(id);
    this._loaded.delete(id);
    this.prioritize(id);
  }

  /**
   * Drop a pending id (e.g. when a still-loading conversation is deleted).
   * An already-in-flight load runs to completion; worker termination is
   * the worker manager's job.
   *
   * The id is forgotten entirely, verdict included. A cancel accompanies the
   * conversation leaving the session — binned, or released — and the same id
   * can come back (restored from the bin) as a fresh unloaded stub wanting a
   * fresh worker. Remembering the old verdict makes prioritize() and _enqueue()
   * decline that stub as already-loaded, and nothing else writes loadState: the
   * tab spins on 'unloaded' with no load behind it and no timeout to end it.
   * @param {string} id
   */
  cancel(id) {
    const idx = this._pending.indexOf(id);
    if (idx !== -1) this._pending.splice(idx, 1);
    this._loaded.delete(id);
    this._errored.delete(id);
    const waiters = this._waiters.get(id);
    if (waiters) {
      const err = new Error(`Conversation ${id} load cancelled`);
      for (const w of waiters) w.reject(err);
      this._waiters.delete(id);
    }
  }

  /**
   * Resolves once the given id finishes loading. Rejects on load error or
   * cancel. Rejects synchronously if the id isn't queued.
   * @param {string} id
   * @returns {Promise<void>}
   */
  whenLoaded(id) {
    if (this._loaded.has(id)) return Promise.resolve();
    if (this._errored.has(id)) {
      return Promise.reject(new Error(`Conversation ${id} failed to load`));
    }
    if (!this._inflight.has(id) && !this._pending.includes(id)) {
      return Promise.reject(new Error(`Conversation ${id} not in queue`));
    }
    return new Promise((resolve, reject) => {
      let arr = this._waiters.get(id);
      if (!arr) {
        arr = [];
        this._waiters.set(id, arr);
      }
      arr.push({ resolve, reject });
    });
  }

  destroy() {
    this._destroyed = true;
    this._pending.length = 0;
    for (const [, arr] of this._waiters) {
      const err = new Error('Load queue destroyed');
      for (const w of arr) w.reject(err);
    }
    this._waiters.clear();
  }

  // ---- internal ----

  /**
   * @param {string} id
   * @private
   */
  _enqueue(id) {
    if (this._destroyed) return;
    if (this._loaded.has(id)) return;
    if (this._inflight.has(id)) return;
    if (this._pending.includes(id)) return;
    this._pending.push(id);
  }

  /** @private */
  _pump() {
    if (this._destroyed) return;
    while (this._inflight.size < this._concurrency && this._pending.length > 0) {
      const id = this._pending.shift();
      if (id === undefined) break;
      this._startLoad(id);
    }
  }

  /**
   * @param {string} id
   * @private
   */
  _startLoad(id) {
    if (this._inflight.has(id) || this._loaded.has(id)) return;

    const conv = this._session.conversations.get(id);
    if (conv) conv.setLoadState('loading');

    const promise = (async () => {
      try {
        await this._loader.loadExisting(id, this._session);
        if (this._destroyed) return;
        this._loaded.add(id);
        this._errored.delete(id);
        const c = this._session.conversations.get(id);
        if (c) c.setLoadState('loaded');
        this._resolveWaiters(id);
      } catch (error) {
        if (this._destroyed) return;
        console.error(`[ConversationLoadQueue] Load failed for ${id} — retaining in order for next reload:`, error);
        this._errored.add(id);
        // Retain the id so saveImmediately keeps it in
        // conversationOrder; the next reload will retry.
        this._session.retainUnloadedConversationId?.(id);
        const c = this._session.conversations.get(id);
        if (c) c.setLoadState('error');
        this._rejectWaiters(id, error);
      } finally {
        this._inflight.delete(id);
        this._pump();
      }
    })();

    this._inflight.set(id, promise);
  }

  /**
   * @param {string} id
   * @private
   */
  _resolveWaiters(id) {
    const arr = this._waiters.get(id);
    if (!arr) return;
    this._waiters.delete(id);
    for (const w of arr) w.resolve();
  }

  /**
   * @param {string} id
   * @param {any} err
   * @private
   */
  _rejectWaiters(id, err) {
    const arr = this._waiters.get(id);
    if (!arr) return;
    this._waiters.delete(id);
    for (const w of arr) w.reject(err);
  }
}

export default ConversationLoadQueue;
