//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The project's bin, as one viewer sees it: how many conversations are in it,
 * roughly how much disk they take, and the requests that list, restore and
 * permanently delete them.
 *
 * Binning a conversation is not here. It takes a live conversation out of the
 * session (worker, map entry, visible tab), so it is `Session.binConversation`,
 * which tells the bin afterwards through {@link ConversationBin#noteBinned}.
 * Restoring is here because the request is a bin operation; the conversation
 * comes back through the server's `restored` broadcast, which the session
 * applies like any other arrival.
 *
 * **Counting each departure once.** The count is adjusted optimistically when
 * this viewer's own request succeeds, so the Bin button reacts before the
 * round trip. The server then broadcasts the same change to every viewer, the
 * sender included, and that broadcast is also how a departure some other viewer
 * caused reaches this one. So a departure this viewer asked for is reported
 * twice, in either order, and one another viewer asked for is reported once. A
 * request marks its id as awaiting its broadcast before it is sent, and
 * {@link ConversationBin#noteLeft} spends that mark instead of counting again.
 * The reply always counts, and is the only one of the two that knows whether
 * the request succeeded.
 *
 * Arrivals need no such mark: a conversation this viewer binned has already
 * left its map when the `binned` broadcast arrives, and the session counts an
 * arrival only for a conversation it still held.
 * @module model/conversation-bin
 */

/**
 * The slice of the API service the bin calls.
 * @typedef {object} BinApi
 * @property {function(string): Promise<void>} restoreConversation - Move a conversation back out of the bin
 * @property {function(): Promise<{binned: Array<{id: string, name: string, lastModifiedAt: string}>, binSizeBytes?: number}>} listBinnedConversations - List the bin
 * @property {function(string): Promise<void>} deleteBinnedConversation - Permanently delete one binned conversation
 * @property {function((number|null)=): Promise<void>} emptyBin - Permanently delete binned conversations: all, or those last active more than N days ago
 */

export default class ConversationBin {
  /**
   * @param {() => BinApi|null} api - The session's API service, read at call
   *   time so a bin outlives the service being swapped or released
   */
  constructor(api) {
    /** @private */
    this._api = api;

    /**
     * Number of conversations currently in the bin. Server-authoritative
     * (adopted from every session manifest), adjusted optimistically between
     * manifests as described in the module doc.
     * @type {number}
     */
    this.count = 0;

    /**
     * Approximate on-disk size, in bytes, of every binned conversation.
     * Server-authoritative but only occasionally refreshed (a low-priority
     * background monitor recomputes it), so treat it as a cosmetic hint, not an
     * exact figure. Adopted from the session manifest and every bin listing; 0
     * means unknown or empty. Drives the "(50 MB)" suffix on the Bin button and
     * the Empty-Bin action.
     * @type {number}
     */
    this.sizeBytes = 0;

    /**
     * Ids whose departure this viewer requested and whose broadcast has not
     * yet been seen.
     * @type {Set<string>}
     * @private
     */
    this._awaitingBroadcast = new Set();
  }

  /**
   * Adopt the server's tally from a session manifest. The manifest is the
   * authority, so any departure still awaiting its broadcast is already in it.
   * @param {{binnedCount?: unknown, binSizeBytes?: unknown}} data - The manifest
   * @returns {void}
   */
  adopt(data) {
    this.count = Number(data?.binnedCount) || 0;
    this.sizeBytes = Number(data?.binSizeBytes) || 0;
    this._awaitingBroadcast.clear();
  }

  /**
   * A conversation entered the bin.
   * @returns {void}
   */
  noteBinned() {
    this.count += 1;
  }

  /**
   * A conversation left the bin, as a broadcast reports it: restored, or
   * permanently deleted. Counted unless it is the echo of this viewer's own
   * request, which counted it already or will when its reply lands.
   * @param {string} id - The conversation that left
   * @returns {void}
   */
  noteLeft(id) {
    if (this._awaitingBroadcast.delete(id)) return;
    this._decrement();
  }

  /**
   * Move a binned conversation back to the active set. The conversation itself
   * appears through the server's `restored` broadcast.
   * @param {string} id - The conversation to restore
   * @returns {Promise<void>}
   */
  restore(id) {
    return this._leave(id, (api) => api.restoreConversation(id));
  }

  /**
   * Permanently delete a single binned conversation.
   * @param {string} id - The conversation to delete
   * @returns {Promise<void>}
   */
  deletePermanently(id) {
    return this._leave(id, (api) => api.deleteBinnedConversation(id));
  }

  /**
   * List binned conversations, most recently modified first. Refreshes the
   * size from the same authoritative reply.
   * @returns {Promise<Array<{id: string, name: string, lastModifiedAt: string}>>} The bin's rows
   */
  async list() {
    const resp = await this._requireApi().listBinnedConversations();
    this.sizeBytes = Number(/** @type {any} */ (resp)?.binSizeBytes) || 0;
    return (resp && resp.binned) || [];
  }

  /**
   * Permanently delete binned conversations: the whole bin, or only those last
   * active before a cutoff. Emptying everything zeroes the tally at once, and
   * the per-item `binned-deleted` broadcasts that follow cannot take it below
   * zero. A partial empty leaves the count to those broadcasts: how many rows
   * matched is the server's to say.
   * @param {number|null} [olderThanDays] - Positive day count for a partial
   *   empty; omit or pass null to empty the entire bin.
   * @returns {Promise<void>}
   */
  async empty(olderThanDays = null) {
    await this._requireApi().emptyBin(olderThanDays);
    if (olderThanDays) return;
    this.count = 0;
    this.sizeBytes = 0;
  }

  /**
   * Send a request that takes `id` out of the bin, counting its departure once
   * (see the module doc). A refused request counts nothing and its error
   * reaches the caller.
   * @param {string} id - The conversation leaving
   * @param {(api: BinApi) => Promise<void>} request - The request to send
   * @returns {Promise<void>}
   * @private
   */
  async _leave(id, request) {
    const api = this._requireApi();
    this._awaitingBroadcast.add(id);
    try {
      await request(api);
    } catch (error) {
      this._awaitingBroadcast.delete(id);
      throw error;
    }
    this._decrement();
  }

  /** @private */
  _decrement() {
    if (this.count > 0) this.count -= 1;
  }

  /**
   * @returns {BinApi} The API service
   * @private
   */
  _requireApi() {
    const api = this._api();
    if (!api) throw new Error('ConversationBin: no API service');
    return api;
  }
}
