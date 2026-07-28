//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @typedef {object} FooterState
 * @property {boolean} isProcessing - LLM is actively processing (includes "waiting for user approval" — in that case statusMessage describes the wait)
 * @property {boolean} canContinue - Whether continue is possible (has messages)
 * @property {string} [statusMessage] - Optional status message when processing
 * @property {boolean} [showSpinner] - Whether to show the spinner animation (default true)
 * @property {string} [nextSteps] - Optional next steps guidance
 * @property {boolean} [showAddContextItem] - Whether to show the Add Context Item button
 * @property {boolean} [showCloseThread] - Whether to show the "Close with generated summary" button (open thread with content, idle only)
 * @property {boolean} [showCloseWithLastMessage] - Whether to show the "Close with last message" button (open thread whose last message is an assistant reply, idle only)
 * @property {boolean} [showDuplicateTab] - Whether to show the duplicate tab button (root thread only)
 * @property {string} [busyItemMessageId] - message-id of the busy thread item, enables clicking footer to select it
 * @property {boolean} [politePending] - A polite stop (Pause) is in progress: render the Pause button active until the worker rests
 */

/**
 * ConversationFooter - footer element at the end of a conversation.
 *
 * Token counts are read on-demand from the transaction blob of the most
 * recent assistant message in this thread (see findLastAssistantTxnId).
 * Nothing is persisted in Yjs: the blob on disk is the only record.
 * A small per-element cache keyed by transactionId avoids refetching
 * on every items-array event.
 */
import { findLastAssistantTxnId } from '../utils/transaction-anchor.js';
import providersCache from '../services/providers-cache.js';

const TOKEN_UPDATE_DEBOUNCE_MS = 2000;

class ConversationFooter extends HTMLElement {
  /** @type {import('../model/message-thread.js').default} */
  _messageThread = /** @type {any} */ (null);
  /** @type {(() => void)|null} */
  _unsubscribe = null;
  /**
   * Unsubscribe from the LLMState status-observer feed. Separate from
   * `_unsubscribe` (session events): the status observer fires on every
   * mid-turn usage update, driving the live-growing meter without the 2s
   * event debounce.
   * @type {(() => void)|null}
   */
  _statusUnsubscribe = null;

  /**
   * Cache of resolved transaction-blob token totals, keyed by
   * transactionId. Lookups are global to the element instance
   * (same conversation for the element's lifetime, so no key
   * collision risk).
   * @type {Map<string, {inputTokens: number, cachedTokens: number, inputTokensApproximate: boolean}|null>}
   * @private
   */
  _blobTokenCache = new Map();

  /**
   * Transaction id currently being fetched, or empty string.
   * Used to avoid stacking duplicate in-flight fetches.
   * @type {string}
   * @private
   */
  _pendingTxnId = '';

  /**
   * Debounce timer for event-driven token refreshes. Conversation/status
   * updates can arrive many times per second while the LLM streams; delaying
   * the refresh keeps the last stable count visible instead of briefly
   * clearing it on each transaction-blob cache miss.
   * @type {number|undefined}
   * @private
   */
  _tokenUpdateTimer = undefined;

  disconnectedCallback() {
    if (this._unsubscribe) { this._unsubscribe(); this._unsubscribe = null; }
    if (this._statusUnsubscribe) { this._statusUnsubscribe(); this._statusUnsubscribe = null; }
    this._cancelDeferredTokenDisplayUpdate();
  }

  /**
   * Set the message thread and subscribe to session events for token refresh.
   * @param {import('../model/message-thread.js').default} mt
   */
  setMessageThread(mt) {
    if (this._unsubscribe) { this._unsubscribe(); this._unsubscribe = null; }
    if (this._statusUnsubscribe) { this._statusUnsubscribe(); this._statusUnsubscribe = null; }
    this._cancelDeferredTokenDisplayUpdate();
    // Defensive: if this element is recycled across threads (or across
    // conversations) the per-txnID cache from the previous thread is no
    // longer relevant. txnIDs are globally unique so collisions are not
    // possible, but a stale entry could be served to the wrong footer
    // for one tick before the new fetch lands.
    this._blobTokenCache.clear();
    this._pendingTxnId = '';
    this._messageThread = mt;
    if (mt) {
      const conversation = mt.conversation;
      const session = conversation?.session;
      if (session) {
        this._unsubscribe = /** @type {() => void} */ (session.subscribe((/** @type {any} */ event) => {
          if (event.type === 'conversation:context-window-updated' && event.data === conversation) {
            this._scheduleTokenDisplayUpdate();
          } else if (event.type === 'contextItems:changed' || event.type === 'conversation:changed') {
            this._scheduleTokenDisplayUpdate();
          }
        }));
      }
      // Mid-turn usage updates arrive on the LLMState status feed (one tick per
      // usage chunk). For a provider that streams authoritative per-step usage
      // we refresh the meter immediately — not through the 2s event debounce —
      // so the bar visibly grows as the turn proceeds. The callback is cheap
      // when nothing changed (token-display.setUsage no-ops on equal input).
      const llmState = conversation?._llmState;
      if (llmState && typeof llmState.addStatusObserver === 'function') {
        this._statusUnsubscribe = /** @type {() => void} */ (llmState.addStatusObserver((/** @type {string} */ id) => {
          // Only models that stream authoritative per-step usage drive the meter
          // from this feed; for the rest the meter stays on the blob anchor
          // refreshed by the (debounced) session events, so skip the per-tick work.
          if (id === conversation.id && this._modelStreamsLiveUsage()) this._updateTokenDisplay();
        }));
      }
    }
    this._updateTokenDisplay();
  }

  /**
   * Whether the visible conversation's model streams authoritative per-step
   * input usage (provider capability, surfaced per model on the WS-pushed
   * provider list). Only such models drive the live-growing meter; others keep
   * the end-of-turn blob anchor.
   * @returns {boolean} True when the current model reports live per-step usage.
   * @private
   */
  _modelStreamsLiveUsage() {
    const cfg = this._messageThread?.conversation?.modelConfig;
    if (!cfg?.provider || !cfg?.model) return false;
    const providerEntry = providersCache.get().find((/** @type {any} */ p) => p?.name === cfg.provider);
    const model = providerEntry?.modelsWithContext?.find((/** @type {any} */ m) => m?.id === cfg.model);
    return !!model?.streamsLiveUsage;
  }

  /**
   * Schedule an event-driven token refresh after a quiet period.
   * @private
   */
  _scheduleTokenDisplayUpdate() {
    this._cancelDeferredTokenDisplayUpdate();
    this._tokenUpdateTimer = window.setTimeout(() => {
      this._tokenUpdateTimer = undefined;
      this._updateTokenDisplay();
    }, TOKEN_UPDATE_DEBOUNCE_MS);
  }

  /** @private */
  _cancelDeferredTokenDisplayUpdate() {
    if (this._tokenUpdateTimer !== undefined) {
      window.clearTimeout(this._tokenUpdateTimer);
      this._tokenUpdateTimer = undefined;
    }
  }

  /**
   * Async-fetch the transaction blob for `txnId` (no-op if already
   * cached or in flight); on success, cache the numbers and
   * re-render so the footer picks them up.
   * @private
   * @param {string} txnId
   */
  async _ensureBlobLoaded(txnId) {
    if (!txnId) return;
    if (this._blobTokenCache.has(txnId)) return;
    if (this._pendingTxnId === txnId) return;
    const thread = this._messageThread;
    const convId = thread?.conversation?.id;
    if (!convId) return;
    this._pendingTxnId = txnId;
    let success = false;
    try {
      const { default: workerManager } = await import('../services/worker-manager.js');
      const blob = /** @type {any} */ (await workerManager.getTransaction(convId, txnId));
      const inputTokens = Number(blob?.inputTokens) || 0;
      const cachedTokens = Number(blob?.cachedTokens) || 0;
      const inputTokensApproximate = blob?.inputTokensApproximate === true;
      if (inputTokens > 0) {
        // Only cache positive results. The blob may not exist yet:
        // the worker stamps transactionId on the streaming assistant
        // item BEFORE SaveBlob runs at end-of-turn, so the footer's
        // first fetch can race the save. Leaving the cache empty
        // lets the next conversation:changed event retry.
        this._blobTokenCache.set(txnId, { inputTokens, cachedTokens, inputTokensApproximate });
        success = true;
      }
    } catch {
      // Network/RPC failure — don't cache. Next render retries.
    } finally {
      if (this._pendingTxnId === txnId) this._pendingTxnId = '';
      if (success && this.isConnected && this._messageThread === thread) {
        this._updateTokenDisplay();
      }
    }
  }

  /** @private */
  _updateTokenDisplay() {
    const thread = this._messageThread;
    const tokenDisplay = this.querySelector('token-display');
    if (!thread || !tokenDisplay) return;

    const conv = thread.conversation;
    const budget = Number(conv?.contextWindow) || 0;
    const processing = !!conv?.isProcessing;

    // Live path: while a provider that reports authoritative per-step usage is
    // streaming, grow the meter against the running input total the worker has
    // stamped into the Yjs processingState, rather than the frozen previous-turn
    // blob anchor. Falls through to the anchor before the first usage chunk
    // arrives (getLiveInputUsage null) and once the turn ends (processing false),
    // so the end-of-turn number takes over seamlessly.
    if (processing && this._modelStreamsLiveUsage()) {
      const live = conv?._llmState?.getLiveInputUsage?.(conv.id);
      if (live) {
        /** @type {any} */ (tokenDisplay).setUsage({
          total: live.inputTokens,
          cached: live.cachedTokens,
          budget,
          processing: true,
        });
        return;
      }
    }

    // Anchor cache hit → render synchronously. Miss → kick a background
    // fetch and leave the existing display alone; clearing to zero while the
    // blob request is in flight causes the footer count to flicker/hide.
    const txnId = findLastAssistantTxnId(this._messageThread?.items);
    let anchor = null;
    if (txnId) {
      if (this._blobTokenCache.has(txnId)) anchor = this._blobTokenCache.get(txnId);
      else {
        this._ensureBlobLoaded(txnId);
        return;
      }
    }

    /** @type {any} */ (tokenDisplay).setUsage({
      total: anchor?.inputTokens ?? 0,
      cached: anchor?.cachedTokens ?? 0,
      budget,
      processing,
      approximate: anchor?.inputTokensApproximate ?? false,
    });
  }

  connectedCallback() {
    this.innerHTML = `
            <footer-processing class="hidden">
                <juggler-spinner></juggler-spinner>
                <span class="llm-busy-text"></span>
                <button class="message-action-btn footer-pause-btn" type="button" title="Pause as soon as possible, without cancelling any operations in progress">
                    <svg class="footer-pause-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M560-200v-560h160v560H560Zm-320 0v-560h160v560H240Z"/></svg>
                    <juggler-spinner class="footer-pause-spinner" style="--size: 1rem"></juggler-spinner>
                    <span class="footer-pause-label">Pause</span>
                </button>
                <button class="message-action-btn footer-stop-btn" type="button" title="Cancel all pending operations and stop">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="m336-280-56-56 144-144-144-143 56-56 144 144 143-144 56 56-144 143 144 144-56 56-143-144-144 144Z"/></svg>
                    Stop
                </button>
            </footer-processing>
            <div class="llm-next-steps hidden"></div>
            <token-display></token-display>
            <footer-idle>
                <div class="footer-idle-row footer-idle-main">
                    <div class="footer-idle-left">
                        <button class="message-action-btn add-context-item-btn hidden">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M440-120v-320H120v-80h320v-320h80v320h320v80H520v320h-80Z"/></svg>
                            Add Context Item
                        </button>
                    </div>
                    <div class="footer-idle-right">
                        <button class="message-action-btn duplicate-to-tab-btn hidden">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M448-160v-305.33L226.67-686.67V-570H160v-230h230v66.67H274l240.67 240.66V-160H448Zm126.67-368-47.34-47.33 158.67-158H570V-800h230v230h-66.67v-116.67L574.67-528Z"/></svg>
                            Duplicate as new tab
                        </button>
                        <button class="message-action-btn continue-btn">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M240-240v-480h66.67v480H240Zm169.33 0 390-240-390-240v480ZM476-363.67v-232.66L665-480 476-363.67ZM476-480Z"/></svg>
                            Continue
                        </button>
                    </div>
                </div>
                <div class="footer-idle-row footer-idle-secondary">
                    <button class="message-action-btn close-thread-last-btn hidden">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z"/></svg>
                        Close with last message
                    </button>
                    <button class="message-action-btn close-thread-summary-btn hidden">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M320-240h320v-80H320v80Zm0-160h320v-80H320v80ZM240-80q-33 0-56.5-23.5T160-160v-640q0-33 23.5-56.5T240-880h320l240 240v480q0 33-23.5 56.5T720-80H240Z"/></svg>
                        Close with generated summary
                    </button>
                </div>
            </footer-idle>
        `;

    const continueBtn = this.querySelector('.continue-btn');
    if (continueBtn) {
      continueBtn.addEventListener('click', () => {
        this._messageThread.continue();
      });
    }

    const duplicateTabBtn = this.querySelector('.duplicate-to-tab-btn');
    if (duplicateTabBtn) {
      duplicateTabBtn.addEventListener('click', () => {
        // Same entry point as the (removed) header button: app.js listens for
        // this on document and duplicates the visible conversation into a new tab.
        this.dispatchEvent(new CustomEvent('duplicate-conversation', {
          bubbles: true,
          composed: true
        }));
      });
    }

    const closeThreadLastBtn = this.querySelector('.close-thread-last-btn');
    if (closeThreadLastBtn) {
      closeThreadLastBtn.addEventListener('click', () => {
        this._messageThread.closeWithLastMessage();
      });
    }

    const closeThreadSummaryBtn = this.querySelector('.close-thread-summary-btn');
    if (closeThreadSummaryBtn) {
      closeThreadSummaryBtn.addEventListener('click', () => {
        this._messageThread.close();
      });
    }

    const addCIBtn = this.querySelector('.add-context-item-btn');
    if (addCIBtn) {
      addCIBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.dispatchEvent(new CustomEvent('context-item-add-requested', {
          bubbles: true,
          composed: true,
          detail: { button: addCIBtn, threadItemId: this._messageThread?.threadItemId ?? null }
        }));
      });
    }

    const processingEl = /** @type {HTMLElement|null} */ (this.querySelector('footer-processing'));
    if (processingEl) {
      processingEl.addEventListener('click', () => {
        const messageId = processingEl.dataset.messageId;
        if (messageId) {
          this.dispatchEvent(new CustomEvent('select-item-requested', {
            bubbles: true,
            composed: true,
            detail: { messageId }
          }));
        }
      });
    }

    const stopBtn = this.querySelector('.footer-stop-btn');
    if (stopBtn) {
      stopBtn.addEventListener('click', (e) => {
        // Don't let the click bubble to footer-processing's select-item handler.
        e.stopPropagation();
        this._stopOwnColumn();
      });
    }

    const pauseBtn = this.querySelector('.footer-pause-btn');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', (e) => {
        // Don't let the click bubble to footer-processing's select-item handler.
        e.stopPropagation();
        this._pauseOwnColumn();
      });
    }

    if (this._messageThread) this._updateTokenDisplay();
  }

  /**
   * Stop the thread this footer belongs to, from THIS column's vantage. The
   * footer-processing block (and so this button) is shown only on a column that
   * is actually processing. A sub-thread column INTERRUPTS that thread (stops
   * the work, leaves it open) — the same own-vantage stop as Escape inside the
   * thread. The root column (threadItemId null) stops everything and closes the
   * open sub-threads. Both route through the vantage-aware cancelLLMOperation.
   * @private
   */
  _stopOwnColumn() {
    const threadItemId = this._messageThread?.threadItemId ?? null;
    // @ts-ignore - jugglerApp is added dynamically in app.js
    if (window.jugglerApp && window.jugglerApp.cancelLLMOperation) {
      // @ts-ignore
      window.jugglerApp.cancelLLMOperation(threadItemId);
    }
  }

  /**
   * Request a polite stop (Pause) for this conversation. Unlike Stop this is
   * non-destructive and vantage-uniform: the current step finishes and records
   * its result, then the worker rests at idle before the next LLM turn — nothing
   * is cancelled and no thread is closed. Routes through the same
   * cancelLLMOperation entry with the polite flag. Passes `toggle: true` so a
   * second click while the Pause is still pending turns it back off — the button
   * is a toggle, unlike the shift+Escape shortcut which only ever requests a pause.
   * @private
   */
  _pauseOwnColumn() {
    const threadItemId = this._messageThread?.threadItemId ?? null;
    // @ts-ignore - jugglerApp is added dynamically in app.js
    if (window.jugglerApp && window.jugglerApp.cancelLLMOperation) {
      // @ts-ignore
      window.jugglerApp.cancelLLMOperation(threadItemId, { polite: true, toggle: true });
    }
  }

  /**
   * Update footer display based on conversation state.
   * This is the ONLY way to change what the footer shows.
   * @param {FooterState} state - Current conversation state
   */
  update(state) {

    const processing = /** @type {HTMLElement|null} */ (this.querySelector('footer-processing'));
    const idle = /** @type {HTMLElement|null} */ (this.querySelector('footer-idle'));
    const text = this.querySelector('.llm-busy-text');
    const nextSteps = /** @type {HTMLElement|null} */ (this.querySelector('.llm-next-steps'));
    const continueBtn = /** @type {HTMLElement|null} */ (this.querySelector('.continue-btn'));
    const duplicateTabBtn = /** @type {HTMLElement|null} */ (this.querySelector('.duplicate-to-tab-btn'));
    const closeThreadLastBtn = /** @type {HTMLElement|null} */ (this.querySelector('.close-thread-last-btn'));
    const closeThreadSummaryBtn = /** @type {HTMLElement|null} */ (this.querySelector('.close-thread-summary-btn'));
    const addCIBtn = /** @type {HTMLElement|null} */ (this.querySelector('.add-context-item-btn'));

    const hide = (/** @type {Element|null} */ el) => el?.classList.add('hidden');
    const show = (/** @type {Element|null} */ el) => el?.classList.remove('hidden');
    const toggle = (/** @type {Element|null} */ el, /** @type {boolean} */ visible) => visible ? show(el) : hide(el);
    // `el.textContent = x` ALWAYS replaces the child text node, even when x is
    // unchanged. update() runs on every streaming tick (many times a second),
    // so an unconditional write churns these nodes ~10×/s. That's harmless for
    // display — but if the user presses on a node that a tick then replaces
    // mid-gesture, the mousedown target is detached before mouseup and the
    // native `click` (which fires on the common ancestor of the two) never
    // reaches the button: the intermittent "first Pause click is ignored" bug.
    // Only write when the value actually changed, so a resting label/button is
    // a stable click target between ticks.
    const setText = (/** @type {Element|null} */ el, /** @type {string} */ value) => {
      if (el && el.textContent !== value) el.textContent = value;
    };

    if (state.isProcessing) {
      show(processing);
      hide(idle);
      setText(text, state.statusMessage || '');
      const spinner = this.querySelector('juggler-spinner');
      if (spinner) toggle(spinner, state.showSpinner !== false);
      if (nextSteps) {
        setText(nextSteps, state.nextSteps || '');
        toggle(nextSteps, !!state.nextSteps);
      }
      if (processing) {
        if (state.busyItemMessageId) {
          /** @type {HTMLElement} */ (processing).dataset.messageId = state.busyItemMessageId;
        } else {
          delete /** @type {HTMLElement} */ (processing).dataset.messageId;
        }
      }
      // Pause pending → render the Pause button in a visibly pending state while
      // the current step finishes: the pause glyph is swapped for a spinner and
      // the label reads "Pausing…". Purely a transient cue derived from the local
      // optimistic flag; it clears the moment the worker reaches idle
      // (state.politePending false), reverting to the plain Pause affordance.
      const pauseBtn = this.querySelector('.footer-pause-btn');
      if (pauseBtn) {
        const pending = !!state.politePending;
        pauseBtn.classList.toggle('active', pending);
        pauseBtn.classList.toggle('pending', pending);
        setText(pauseBtn.querySelector('.footer-pause-label'), pending ? 'Pausing…' : 'Pause');
      }
    } else {
      // Idle state — show appropriate buttons
      hide(processing);
      if (processing) delete /** @type {HTMLElement} */ (processing).dataset.messageId;
      if (nextSteps) { nextSteps.textContent = ''; hide(nextSteps); }

      // A closed thread reopens via the box-shaped affordance in the column's
      // input slot (conversation-area's reopen-box), not a footer button — so
      // a closed thread contributes nothing to the footer's idle row.
      const isClosed = !!this._messageThread.isClosed;
      const showIdle = state.canContinue
                || !!state.showAddContextItem || !!state.showCloseThread
                || !!state.showCloseWithLastMessage || !!state.showDuplicateTab;
      toggle(idle, showIdle);

      const canContinue = !isClosed && state.canContinue;
      toggle(continueBtn, canContinue);
      // Duplicate tab is offered only on a conversation's root thread
      // (the owner sets showDuplicateTab), never on sub-threads.
      toggle(duplicateTabBtn, !!state.showDuplicateTab);

      // Close thread — two explicit closes on an open thread (computed by the
      // owner); the idle/processing split keeps them idle-only. "Last message"
      // only when there's a trailing assistant reply to promote; "generated
      // summary" whenever the thread has content to summarise.
      const showCloseSummary = !isClosed && !!state.showCloseThread;
      const showCloseLast = !isClosed && !!state.showCloseWithLastMessage;
      toggle(closeThreadSummaryBtn, showCloseSummary);
      toggle(closeThreadLastBtn, showCloseLast);

      // Collapse the secondary row when none of its buttons is shown,
      // so the column gap doesn't leave dead space below the main row.
      const secondaryRow = /** @type {HTMLElement|null} */ (this.querySelector('.footer-idle-secondary'));
      toggle(secondaryRow, showCloseSummary || showCloseLast);

      // Add Context Item — visible when thread is open (or main conversation)
      toggle(addCIBtn, !!state.showAddContextItem);
    }
  }
}

customElements.define('conversation-footer', ConversationFooter);

export default ConversationFooter;
