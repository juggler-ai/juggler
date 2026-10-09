//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { extractFileMentionsAsync } from '../components/file-mention-provider.js';
import { expandPasteTokens } from '../utils/paste-tokens.js';
import wsService from './websocket.js';

/**
 * How often the poller sweeps every conversation's threads for a due send.
 * Deliberately coarse: a scheduled send exists to fire a queued command when
 * the next LLM-provider time slice opens, so seconds of slack is irrelevant —
 * a low-frequency poll that never misses beats a precise timer that only runs
 * while its thread happens to be on screen.
 */
const POLL_INTERVAL_MS = 5000;

/**
 * How long after a (re)connect the poller stays quiet before it will fire.
 *
 * A window that was offline across another client's on-time fire wakes holding
 * a STALE doc — its `scheduledSendAt` is still armed because the winner's clear
 * hasn't reached it yet. On reconnect the client asks each worker for the ops it
 * missed (worker-manager.resyncReadyConversations), but that catch-up is an async
 * round-trip; fire before it lands and this window re-sends what another already
 * sent. Since the cross-window claim is per-origin (see the class doc), a separate
 * process — the desktop app vs. a browser opened "to check" — never sees that
 * claim, so nothing else stops the duplicate. Staying quiet for one comfortable
 * catch-up interval after connect lets the peer's clear (or the freshly-synced
 * doc after a reconnect page reload) disarm the schedule first. Coarse on
 * purpose: the whole feature already tolerates seconds of slack.
 */
const CONNECT_SETTLE_MS = 2 * POLL_INTERVAL_MS;

/** Web Lock name serialising the cross-window fire claim. */
const CLAIM_LOCK_NAME = 'juggler-scheduled-send-fire';
/** localStorage key holding recently-claimed fires (shared across same-origin windows). */
const CLAIM_STORE_KEY = 'juggler.scheduledSend.claims';
/** How long a claim lingers before it's pruned — bounds the store's size. */
const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Fired on `document` when the set of conversations carrying an armed schedule
 * changes. The conversation bar paints its per-tab clock from
 * {@link ScheduledSendService.hasArmedSchedule}, and a tab must never walk the
 * thread tree itself: the bar re-renders on every doc change (~100/s while a
 * turn streams) and that walk allocates a MessageThread per thread. The sweep
 * already visits every draft on its own interval, so the set is a by-product of
 * work that was happening anyway.
 */
export const SCHEDULED_SEND_ARMED_EVENT = 'juggler:scheduled-send-armed-changed';

/**
 * ScheduledSendService — the single owner of scheduled-send *firing*.
 *
 * A scheduled send is persisted on a thread's draft record as an instant
 * (`scheduledSendAt`, epoch ms) plus what it is waiting for
 * (`scheduledSendMode`): a `delay` is due once that instant passes, while a
 * `turn-end` wait is due once the conversation has no turn in flight (its
 * instant is only the arming time). The composer only arms/cancels/displays a
 * schedule; it never fires it on a private timer, because such a timer runs
 * only while that thread is the one bound to the column — so a send would
 * silently fail whenever the user was looking at a different thread or tab.
 *
 * Instead this session-wide poller sweeps EVERY conversation's threads on a
 * fixed interval and fires any whose wait is over, whether or not that thread is
 * currently visible anywhere. When the due thread *is* on screen it delegates to
 * that composer (so the send goes out with the live textarea's exact contents);
 * otherwise it sends straight from the persisted draft. The same sweep records
 * which conversations still carry an armed schedule, for the bar's tab clock.
 *
 * Multi-window: the draft lives in the shared (Yjs-replicated) doc, so every
 * open window runs its own poller and would independently fire the same due
 * send — a duplicate. Before firing, each window therefore claims the specific
 * (thread, target-instant) via a Web Lock-guarded localStorage marker; only the
 * winner sends. That covers every same-origin window — including the desktop
 * app's own multiple windows and multiple browser tabs. A genuinely separate
 * process (e.g. the desktop app AND an external browser pointed at the same
 * server at once) shares neither Web Locks nor localStorage, so the ONLY thing
 * standing between two processes and a double-fire is the winner clearing
 * `scheduledSendAt` from the shared doc.
 *
 * That cross-process guard holds only while both processes stay connected: a
 * clear propagates in milliseconds. It breaks when a process is OFFLINE across
 * the fire — asleep, or its socket dropped. It wakes (classically, when the user
 * logs back into the machine) still holding the pre-fire doc, and its poller
 * would re-send before reconnect catch-up delivers the winner's clear. So firing
 * is gated on a settled connection: the poller stays quiet while disconnected and
 * for CONNECT_SETTLE_MS after each (re)connect, giving the missed-ops resync (or
 * a reconnect page reload) time to disarm an already-fired schedule. What's left
 * is only two processes firing near-simultaneously while both online — the
 * replication-lag window the doc clear already bounds to milliseconds.
 */
class ScheduledSendService {
  constructor() {
    /** @type {import('../model/session.js').default|null} @private */
    this._session = null;
    /** @type {number|null} @private */
    this._intervalId = null;
    /**
     * Thread keys with a fire in flight — guards against a second sweep
     * re-entering the same send while its async send is still settling.
     * @type {Set<string>} @private
     */
    this._firing = new Set();
    /**
     * Ids of the conversations that currently have a send armed on at least one
     * of their threads — the conversation bar's tab clock reads this. Refreshed
     * by every sweep and by {@link refreshArmedState} the moment a composer arms
     * or cancels, so the local window paints at once and other windows follow on
     * their next sweep.
     * @type {Set<string>} @private
     */
    this._armedConversationIds = new Set();
    /**
     * Epoch ms of the most recent connect, or null while disconnected. The
     * poller only fires once this is CONNECT_SETTLE_MS in the past, so a window
     * that reconnects holding a stale doc doesn't re-send before catch-up
     * disarms an already-fired schedule. See the class doc.
     * @type {number|null} @private
     */
    this._connectedSince = null;
    /** @type {() => void} @private */
    this._onWsOpen = () => { this._connectedSince = Date.now(); };
    /** @type {() => void} @private */
    this._onWsClose = () => { this._connectedSince = null; };
  }

  /**
   * Begin polling for due scheduled sends. Idempotent — a second call rebinds
   * the session and leaves the single interval running.
   * @param {import('../model/session.js').default} session
   */
  start(session) {
    this._session = session;
    if (this._intervalId !== null) return;
    // Seed the settle clock from the current link: start() runs after the
    // initial session load, so the socket is normally already open — treat that
    // as a fresh connect so the first sweeps wait out CONNECT_SETTLE_MS just
    // like a reconnect would.
    this._connectedSince = wsService.isConnected() ? Date.now() : null;
    wsService.on('open', this._onWsOpen);
    wsService.on('close', this._onWsClose);
    this._intervalId = setInterval(() => this._sweep(), POLL_INTERVAL_MS);
  }

  /** Stop polling and drop the session reference. */
  stop() {
    if (this._intervalId !== null) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    wsService.off('open', this._onWsOpen);
    wsService.off('close', this._onWsClose);
    this._connectedSince = null;
    this._session = null;
    this._firing.clear();
    this._publishArmed(new Set());
  }

  /**
   * True once the link has been continuously connected for CONNECT_SETTLE_MS —
   * long enough for reconnect catch-up to have delivered a peer's schedule
   * clear. While disconnected, or in the settle window right after a connect,
   * the poller must not fire: the doc it would read may be stale.
   * @returns {boolean} True when it's safe to fire against the current doc.
   * @private
   */
  _isSyncSettled() {
    const since = this._connectedSince;
    return since !== null && (Date.now() - since) >= CONNECT_SETTLE_MS;
  }

  /**
   * Whether `conversationId` has a send armed on any of its threads — what the
   * conversation bar paints its tab clock from.
   * @param {string} conversationId
   * @returns {boolean} True while a schedule is armed somewhere in that conversation.
   */
  hasArmedSchedule(conversationId) {
    return this._armedConversationIds.has(conversationId);
  }

  /**
   * Re-read which conversations carry an armed schedule, without firing
   * anything. Called by the composer straight after it arms or cancels, so the
   * tab clock appears (or goes) on the same gesture rather than at the next
   * poll.
   */
  refreshArmedState() {
    this._scan(false);
  }

  /**
   * One poll pass: fire every thread whose wait is over.
   * @private
   */
  _sweep() {
    // Never fire on a stale doc: hold off while disconnected or within the
    // post-connect settle window, so a window that reconnects still holding a
    // pre-fire schedule waits for catch-up to disarm it rather than re-sending.
    // The armed set is still refreshed — it only paints.
    this._scan(this._isSyncSettled());
  }

  /**
   * Walk every thread of every conversation, recording which conversations have
   * a schedule armed and — when `fire` is set — firing the ones whose wait is
   * over. One walk serves both: it is the expensive part (a MessageThread per
   * thread), and the two answers come from the same draft read.
   * @param {boolean} fire - Whether a due schedule should be fired.
   * @private
   */
  _scan(fire) {
    const session = this._session;
    if (!session) return;
    const now = Date.now();
    /** @type {Set<string>} */
    const armed = new Set();
    for (const conversation of session.conversations.values()) {
      let threads;
      try {
        // A conversation still loading (a stub) has no thread tree yet.
        threads = conversation.getAllMessageThreads();
      } catch {
        continue;
      }
      for (const thread of threads) {
        let draft;
        try {
          draft = thread.draft;
        } catch {
          continue;
        }
        const when = draft.scheduledSendAt;
        if (typeof when !== 'number' || !Number.isFinite(when)) continue;
        armed.add(conversation.id);
        if (!fire) continue;
        if (draft.scheduledSendMode === 'turn-end') {
          // Waiting on the turn, not the clock. isTurnActive() reads the
          // worker's own processingState (plus any frontend-driven tool action),
          // so it holds in a window that never started the turn.
          if (conversation.isTurnActive()) continue;
          // A thread holds a claim only while the worker is driving it, so the
          // registry can be empty at a moment when work is demonstrably
          // outstanding — a sub-thread whose run has not settled. Ask the
          // document too: an unsettled child thread is a turn that has not
          // ended, and firing into one queues the message into the run the user
          // meant to stay out of.
          if (typeof thread.hasBusyItems === 'function' && thread.hasBusyItems()) continue;
        } else if (when > now) {
          continue;
        }
        void this._fire(thread);
      }
    }
    this._publishArmed(armed);
    this._reconcileBoundComposers();
  }

  /**
   * Let every on-screen composer re-check its displayed timer against the draft
   * it came from. A composer caches the schedule in memory, and the cache goes
   * stale without that composer being involved at all: another same-origin
   * window can fire the send (claims dedupe the fire, they don't notify), and so
   * can this window's own off-screen path when the due thread had no box bound
   * at the time. Left alone the box keeps a dead timer on show and writes it
   * back on its next draft save.
   *
   * Walked per composer rather than per thread — there are a handful of boxes
   * and potentially hundreds of threads, and each box knows its own.
   * @private
   */
  _reconcileBoundComposers() {
    for (const box of Array.from(document.querySelectorAll('composer-box'))) {
      const reconcile = /** @type {any} */ (box).reconcileScheduledSend;
      if (typeof reconcile === 'function') reconcile.call(box);
    }
  }

  /**
   * Adopt `armed` as the armed-conversation set, announcing it only when it
   * actually changed — this runs on every poll, and the bar repaints every tab
   * on the event.
   * @param {Set<string>} armed
   * @private
   */
  _publishArmed(armed) {
    const previous = this._armedConversationIds;
    if (previous.size === armed.size && [...armed].every((id) => previous.has(id))) return;
    this._armedConversationIds = armed;
    document.dispatchEvent(new CustomEvent(SCHEDULED_SEND_ARMED_EVENT));
  }

  /**
   * Fire one thread's scheduled send. Delegates to the bound composer when the
   * thread is on screen (so the live textarea is what goes out); otherwise
   * sends from the persisted draft. Re-fire is guarded on three levels: an
   * in-process Set (same-window concurrent sweeps), a cross-window claim
   * (other same-origin windows), and clearing `scheduledSendAt` once the send
   * settles (subsequent sweeps everywhere).
   * @param {import('../model/message-thread.js').MessageThread} thread
   * @private
   */
  async _fire(thread) {
    const key = `${thread.conversation.id}::${thread.threadItemId || 'root'}`;
    // The Set alone prevents a re-fire WITHIN this window: a send in flight keeps
    // the key, so the next sweep skips this thread until the send settles and
    // clears/keeps the schedule based on its outcome.
    if (this._firing.has(key)) return;
    this._firing.add(key);
    // Cross-window: claim this exact (thread, armed-instant) so only one
    // same-origin window fires it. `when` is read once, before any await, so a
    // concurrent window claims the identical key. It is the armed instant, not
    // the mode's due time — which is what keeps a turn-end wait claimable again
    // after an earlier one on the same thread has fired. See the class doc.
    const when = thread.draft.scheduledSendAt;
    const claimKey = `${key}@${when}`;
    try {
      if (!(await this._claimFire(claimKey))) return;

      const box = this._findBoundComposer(thread);
      if (box && typeof box.fireScheduledSend === 'function') {
        // On screen: the composer presses Send on its live contents and clears
        // its own scheduled state + draft (synchronously, before its send
        // dispatch), so a later sweep sees no target.
        box.fireScheduledSend();
        return;
      }

      // Off screen: fire from the persisted draft. Expand any inline paste
      // placeholders against the draft's blob table first, exactly as the input
      // box would at send time, so the fired message carries the full content.
      const draft = thread.draft;
      const text = expandPasteTokens(draft.text || '', draft.pasteBlobs).trim();
      const attachments = (draft.attachments || [])
        .filter((a) => a && a.id && !(/** @type {{_uploading?: boolean}} */ (a))._uploading)
        .map(({ id, mime, filename, bytes, width, height }) => ({ id, mime, filename, bytes, width, height }));
      const textFiles = draft.textFiles || [];
      if (!text && attachments.length === 0 && textFiles.length === 0) {
        // Nothing to send — just disarm.
        thread.draft = { text: '', attachments: [], textFiles: [], scheduledSendAt: null };
        return;
      }

      // Mentions and dropped text files become context items BEFORE the user
      // message, mirroring the composer's own send path — including its
      // busy-time behaviour: when a turn is in flight the send is queued, so the
      // reads must ride the same pendingItems queue (via executeContextItemIntoPending)
      // to stay grouped with the message on promotion rather than landing in the
      // live items array now while the message is promoted later. Asked of the
      // thread being sent to, exactly as sendMessage decides to queue. A mention
      // is frozen at its send, as the composer's is.
      const busy = thread.isProcessing ||
        (typeof thread.hasBusyItems === 'function' && thread.hasBusyItems());
      const paths = await extractFileMentionsAsync(text, thread.conversation?.workingWorkspaceId ?? '');
      if (paths.length > 0 || textFiles.length > 0) {
        await Promise.all([
          ...paths.map((p) => busy
            ? thread.executeContextItemIntoPending('file-content', { path: p, frozen: true })
            : thread.executeContextItem('file-content', { path: p, frozen: true })),
          ...textFiles.map((t) => busy
            ? thread.executeContextItemIntoPending('dropped-file', { filename: t.filename, content: t.content })
            : thread.executeContextItem('dropped-file', { filename: t.filename, content: t.content })),
        ]);
      }

      const reason = await thread.conversation.sendMessage(text, thread.threadItemId, thread, { attachments });
      if (reason === null) {
        // Sent (or queued while a turn is live) — clear the leftover draft.
        // conversation.sendMessage only clears an composer bound to THIS
        // thread, and this one isn't on screen.
        thread.draft = { text: '', attachments: [], textFiles: [], scheduledSendAt: null };
      } else if (/worker not ready|still connecting|is processing/i.test(reason)) {
        // Transient (engine still starting, or a worker-less turn in flight at
        // fire time) — leave the schedule armed so the next sweep retries rather
        // than dropping the send, and release the claim so that retry (here or
        // in another window) isn't permanently blocked by it.
        this._releaseClaim(claimKey);
        console.warn('[scheduledSend] send deferred, will retry:', reason);
      } else {
        // A standing refusal (no strategy, provider unavailable, …) — disarm so
        // we don't spin, but keep the text so the user can send it by hand.
        thread.draft = { text: draft.text, attachments: draft.attachments, textFiles, scheduledSendAt: null };
        console.warn('[scheduledSend] send blocked:', reason);
      }
    } catch (err) {
      // Disarm on an unexpected throw so a persistent error can't retry forever;
      // the persisted text stays put.
      try {
        const d = thread.draft;
        thread.draft = { text: d.text, attachments: d.attachments, textFiles: d.textFiles, scheduledSendAt: null };
      } catch { /* ignore */ }
      console.error('[scheduledSend] fire failed:', err);
    } finally {
      this._firing.delete(key);
      // Whatever the outcome, the schedule has usually just been cleared — drop
      // the tab clock now rather than at the next poll.
      this.refreshArmedState();
    }
  }

  /**
   * Find the live `<composer-box>` currently bound to `thread`, if any column is
   * showing it. Matched on logical identity (conversation + thread item), since
   * a fresh MessageThread wrapper is built for the same underlying thread on
   * every doc update.
   * @param {import('../model/message-thread.js').MessageThread} thread
   * @returns {any|null} The bound composer-box element, or null if none is showing it.
   * @private
   */
  _findBoundComposer(thread) {
    const boxes = Array.from(document.querySelectorAll('composer-box'));
    for (const box of boxes) {
      const mt = /** @type {any} */ (box).getMessageThread();
      if (mt && mt.conversationId === thread.conversation.id
          && (mt.threadItemId || null) === (thread.threadItemId || null)) {
        return box;
      }
    }
    return null;
  }

  /**
   * Claim the right to fire `claimKey` on behalf of this window. Returns true if
   * this window won the claim (and should fire), false if another same-origin
   * window already recorded it. The check-and-set is serialised across windows
   * by a Web Lock; without the Web Locks API it degrades to a bare localStorage
   * check-and-set (still dedups non-simultaneous fires), and without storage at
   * all it allows the fire (the in-process Set still blocks same-window doubles).
   * @param {string} claimKey
   * @returns {Promise<boolean>} True if this window won the claim and should fire.
   * @private
   */
  async _claimFire(claimKey) {
    try {
      const locks = (typeof navigator !== 'undefined') ? navigator.locks : null;
      if (locks && typeof locks.request === 'function') {
        return await locks.request(CLAIM_LOCK_NAME, () => this._recordClaimIfNew(claimKey));
      }
    } catch { /* fall through to the lock-free claim */ }
    return this._recordClaimIfNew(claimKey);
  }

  /**
   * Record `claimKey` in the shared localStorage claim store if not already
   * present, pruning stale entries. Returns true when THIS call inserted it.
   * Must run under the Web Lock (or accept a small cross-window TOCTOU race).
   * @param {string} claimKey
   * @returns {boolean} True when this call inserted the claim.
   * @private
   */
  _recordClaimIfNew(claimKey) {
    try {
      const now = Date.now();
      const raw = localStorage.getItem(CLAIM_STORE_KEY);
      const store = raw ? JSON.parse(raw) : {};
      for (const k of Object.keys(store)) {
        if (typeof store[k] !== 'number' || now - store[k] > CLAIM_TTL_MS) delete store[k];
      }
      const already = Object.prototype.hasOwnProperty.call(store, claimKey);
      if (!already) store[claimKey] = now;
      localStorage.setItem(CLAIM_STORE_KEY, JSON.stringify(store));
      return !already;
    } catch {
      // No usable storage (private-mode edge, quota) — allow the fire; the
      // in-process Set still prevents a same-window double-fire.
      return true;
    }
  }

  /**
   * Drop a claim so the fire can be retried (used when a send fails
   * transiently). No-op if storage is unavailable.
   * @param {string} claimKey
   * @private
   */
  _releaseClaim(claimKey) {
    try {
      const raw = localStorage.getItem(CLAIM_STORE_KEY);
      if (!raw) return;
      const store = JSON.parse(raw);
      if (Object.prototype.hasOwnProperty.call(store, claimKey)) {
        delete store[claimKey];
        localStorage.setItem(CLAIM_STORE_KEY, JSON.stringify(store));
      }
    } catch { /* best-effort */ }
  }
}

/** Shared singleton — one poller drives every column. */
const scheduledSendService = new ScheduledSendService();
export default scheduledSendService;
