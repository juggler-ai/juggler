//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import JugglerElement from './juggler-element.js';
import strategyRegistry from '../registries/strategy-registry.js';
import { REGISTRIES_RELOADED } from '../registries/reload-registries.js';
import { presentInlineMenu } from '../utils/popup-surface.js';
import { attachMenuKeyboard, focusMenuChoice } from '../utils/menu-roles.js';
import { INFO_SVG } from '../utils/icons.js';
import CycleBuffer from '../services/cycle-buffer.js';
import { findLastRoundTripTxnId } from '../utils/transaction-anchor.js';
import { generateToolDefinitions } from '../services/tool-generator.js';
import { buildPrefixFingerprint, classifyContextCacheImpact, CONTEXT_CACHE_IMPACT_CHANGED } from '../services/context-cache-impact.js';
import { contextPositionOf } from '../services/system-prompt-builder.js';
import { openSettings } from '../services/settings-launcher.js';
import { capabilityLabel } from '../utils/capability-label.js';
import { t } from '../../sdk/lib/i18n.js';
import { escapeHtml } from '../../sdk/lib/html.js';

/**
 * Strategy Selector - Dropdown component for selecting conversation strategy
 * @typedef {object} StrategyManifestInfo
 * @property {string} id - Strategy ID
 * @property {import('juggler/strategy-type').StrategyManifest} manifest - Strategy manifest
 */

class StrategySelector extends JugglerElement {
  constructor() {
    super();
    /** @type {import('../model/message-thread.js').default|null} @private */
    this._messageThread = null;
    /**
     * The LIVE strategy id: the committed selection normally, and the previewed
     * hop while a hold-to-cycle gesture is in progress. It drives the dropdown
     * HUD's highlight. The collapsed BUTTON reads `_committedStrategyId` instead
     * while the gesture runs, so the button stays frozen until release.
     * @type {string} @private
     */
    this._currentStrategyId = 'default';
    /**
     * The button's frozen value during a gesture: the committed strategy id
     * snapshotted at `beginCycle`, or null when no gesture is running (the button
     * then reads `_currentStrategyId` directly). See `_buttonStrategyId`.
     * @type {string|null} @private
     */
    this._committedStrategyId = null;
    /**
     * The shared display-defence lifecycle for the hold-to-cycle gesture: while
     * it runs the button is frozen at `_committedStrategyId` and doc-sync is
     * blocked; on commit it pins the landing id against the post-commit sync
     * bounce until the running turn settles. It does not touch the doc. See
     * `beginCycle` / `commitCycle` and the CycleBuffer module doc.
     * @type {CycleBuffer<string>} @private
     */
    this._cycle = new CycleBuffer({
      // Force a re-read once the backstop releases a pin, in case the value we
      // masked reflected a genuine external switch rather than the transient bounce.
      onRelease: () => this.setMessageThread(this._messageThread),
    });
    /** @type {StrategyManifestInfo[]} @private */
    this._strategies = [];
    /** @type {boolean} @private */
    this._dropdownOpen = false;
    /**
     * The open dropdown's presentation handle (pending frame + popup release),
     * else null. Its `surface` is THIS selector's own dropdown while open
     * (relocated to <body>) — instance-scoped so render() never finds a
     * sibling's surface: multiple selectors coexist (root + each open sub-thread
     * column).
     * @type {import('../utils/popup-surface.js').InlineMenu|null} @private
     */
    this._menu = null;
    /**
     * Whether the dropdown is to take the keyboard, on its checked strategy,
     * once presented — asked for (takeKeyboard) before it was.
     * @type {boolean} @private
     */
    this._keyboardOnPresent = false;
    /**
     * Metadata observer on the bound thread's conversation, so a REMOTE strategy
     * switch repaints the button on its own — without waiting for a
     * conversation-tab column rebuild to re-push us. Mirrors how
     * permission-controls self-observes. Null when unbound.
     * @type {((event: {keysChanged: Set<string>}) => void)|null} @private
     */
    this._metadataObserver = null;
    /**
     * The conversation `_metadataObserver` is currently registered on, so we
     * re-bind only when it actually changes (root reuses one MessageThread;
     * sub-threads mint a fresh wrapper on every doc update for the SAME
     * conversation, so keying off the conversation avoids per-tick churn).
     * @type {import('../model/conversation.js').default|null} @private
     */
    this._observedConversation = null;
    // ── Context-cache-bust detection (see services/context-cache-impact.js) ──
    // The composer caution fires when the NEXT send would re-read a large slice
    // of cached context — for ANY reason (a switch to a different model or
    // provider, a staged strategy switch that changes the tool set, a
    // deleted/edited earlier item). Detection is a fingerprint diff against the
    // transcript as it was when the conversation last went idle.
    /**
     * Whether the next send discards a large cached prefix. Computed off the hot
     * path from the cached inputs below; render() reads only this scalar.
     * @type {'none'|'busts-large'}
     * @private
     */
    this._pendingImpact = 'none';
    /**
     * The prefix fingerprint captured when the conversation last went idle — what
     * the provider has cached. Null until tools resolve / first idle. The next
     * send's fingerprint is diffed against this.
     * @type {string[]|null}
     * @private
     */
    this._baseline = null;
    /**
     * Last turn's anchored input tokens (the cached-prefix size), refreshed on
     * bind and each idle transition. The magnitude gate.
     * @type {number}
     * @private
     */
    this._anchorTokens = 0;
    /**
     * The model signature recorded by the anchored turn's transaction blob — the
     * model that actually built the cached prefix. It heads the BASELINE (the
     * live selection heads the current fingerprint), because the two are
     * different claims: what the provider holds versus what the next send would
     * ask for. '' when no turn is anchored, or when the blob predates the field.
     * @type {string}
     * @private
     */
    this._anchorModelSig = '';
    /**
     * The full generated tool set, cached so the per-edit recompute is sync (it
     * changes only on a strategy/plugin toggle, not on item edits).
     * @type {any[]|null}
     * @private
     */
    this._toolsAll = null;
    /**
     * The items Y.Array currently observed for edits/deletes, so we rebind only
     * when the bound thread's array actually changes.
     * @type {any}
     * @private
     */
    this._observedItemsYArray = null;
    /**
     * The deep items observer registered while bound, or null.
     * @type {(() => void)|null}
     * @private
     */
    this._itemsObserver = null;
    /**
     * The sub-thread container Y.Map currently observed for a per-thread model
     * override, so we rebind only when it actually changes. Null for the root
     * thread (its model is conversation metadata) and when unbound.
     * @type {any}
     * @private
     */
    this._observedContainer = null;
    /**
     * The container observer registered while bound to a sub-thread, or null.
     * @type {((event: any) => void)|null}
     * @private
     */
    this._containerObserver = null;
  }

  /**
   * Listening follows the document, the binding does not: a selector removed
   * and later inserted again is still bound to the same thread, and picks its
   * observers back up here — re-reading the thread as it does, since a strategy
   * switch while it was detached reached no observer. (A move keeps its
   * observers throughout; see disconnectedCallback.)
   */
  connectedCallback() {
    this.loadStrategies();
    this.render();
    this.setupListeners();
    if (this._messageThread) this.setMessageThread(this._messageThread);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    // Tear down the open dropdown (surface, scrim, observer, dismissal wiring)
    // and the thread observers — but a MOVE is not a removal. The composer
    // re-parents this element when the pointer type changes, and each move
    // disconnects it, so tearing down here directly would destroy a menu the
    // user just opened, and rebinding would rebaseline the cache-bust caution
    // and clear one that was pending. Deferring one microtask outlasts the
    // synchronous re-insertion: still detached by then means genuinely gone.
    queueMicrotask(() => {
      if (this.isConnected) return;
      this._bindMetadataObserver(null);
      this._bindItemsObserver(null);
      this._bindContainerObserver(null);
      this._menu?.close();
      this._menu = null;
    });
    this._cycle.reset();
  }

  /**
   * Load strategies from registry
   * @private
   */
  loadStrategies() {
    this._strategies = strategyRegistry.getAllManifests();
  }

  /**
   * Set the message thread this strategy selector is bound to
   * @param {import('../model/message-thread.js').default|null} messageThread
   */
  setMessageThread(messageThread) {
    this._messageThread = messageThread;
    // A delegated child runs under a strategy its calling tool pinned — often a
    // hidden one that isn't in the list at all, so the button would read "Select
    // Strategy" and a Shift+Tab would cycle a running sub-agent onto a real
    // strategy. It is not user-steerable by design, so the control goes away.
    this.hidden = messageThread ? messageThread.isDelegated === true : false;
    // Self-observe the bound conversation's metadata (before the display guards
    // below, which can early-return) so a remote strategy switch repaints us
    // directly rather than relying on a conversation-tab rebuild re-pushing.
    this._bindMetadataObserver(messageThread ? messageThread.conversation : null);
    // Observe the bound thread's items so a delete/edit of an earlier message
    // recomputes the cache-bust caution. Rebinds (and refreshes the async cache
    // inputs + baseline) only when the array actually changes, so the constant
    // streaming-repaint calls through here don't stack observers or re-fetch.
    this._bindItemsObserver(messageThread || null);
    // The CycleBuffer owns the two display guards: while a gesture
    // buffers, it rejects everything (the preview owns the display); after a
    // commit it pins the landing id and rejects the transient sync bounce until
    // the running turn settles. conversation-tab rebuilds a fresh MessageThread
    // wrapper and re-runs this on every doc update, so the gate runs constantly
    // while a turn streams — keep the new thread reference for the eventual
    // commit regardless, but only repaint when the buffer accepts the value.
    const incoming = messageThread ? (messageThread.currentStrategyId || 'default') : 'default';
    if (!this._cycle.accepts(incoming)) return;
    // This runs on every doc update, so it fires many times a second while a turn
    // streams (thinking tokens, tool output, …). When the strategy id is
    // unchanged — the overwhelmingly common case — there is nothing to repaint,
    // and a full render() would rebuild the button's innerHTML out from under the
    // pointer, making the collapsed button impossible to click mid-stream. Only
    // re-render when the displayed value actually changes. (The dropdown-open
    // path in render() updates in place and is unaffected either way.)
    if (incoming === this._currentStrategyId) return;
    this._currentStrategyId = incoming;
    this.render();
    // The staged strategy changed (a local pick, a remote switch, or a reload
    // landing on a staged strategy). Its tool set is the prefix fingerprint's
    // head, so re-diff synchronously (tools are cached) — no async needed.
    this._recomputeImpact();
  }

  /**
   * Register (or move) the metadata observer that keeps the button live under a
   * remote strategy switch. Re-binds only when the conversation changes.
   * @param {import('../model/conversation.js').default|null} conversation
   * @private
   */
  _bindMetadataObserver(conversation) {
    if (conversation === this._observedConversation) return;
    if (this._metadataObserver && this._observedConversation) {
      this._observedConversation.unobserveMetadata(this._metadataObserver);
    }
    this._metadataObserver = null;
    this._observedConversation = conversation;
    if (!conversation) return;
    this._metadataObserver = (event) => {
      const keys = event.keysChanged;
      if (!keys) return;
      if (keys.has?.('currentStrategyId')) {
        // Re-run the bound-thread sync. The conversation's own metadata observer
        // (setupYjsObservers) refreshes root.currentStrategyId before this fires,
        // so re-reading the thread yields the new id; the CycleBuffer guard inside
        // keeps an in-flight local hold-to-cycle gesture from being clobbered by
        // the echo of its own commit. Re-binding is a no-op here (same
        // conversation), so this never recurses. setMessageThread re-diffs the
        // cache impact itself when the id actually changed.
        this.setMessageThread(this._messageThread);
      }
      if (keys.has?.('defaultModelConfig')) {
        // The conversation's model changed (this thread inherits it unless it
        // holds its own override). The cached prefix belongs to the OLD model,
        // so re-diff — deliberately without rebaselining: the point is to say
        // so BEFORE the send, while changing your mind is still free.
        this._recomputeImpact();
      }
      if (keys.has?.('completedTurns')) {
        // A turn reached idle. completedTurns is the durable fence the worker
        // bumps once per idle transition (it survives Yjs busy→idle batching,
        // unlike the transient processingState.status edge), so this is the
        // reliable "rebaseline now" signal: the settled transcript is what the
        // provider has cached going into the next turn.
        this._refreshCacheInputs({ rebaseline: true });
      } else if (keys.has?.('processingState') && !this._isIdle() && this._pendingImpact !== 'none') {
        // Best-effort: a send is under way, so drop the (now moot) caution. The
        // authoritative rebaseline lands on the completedTurns bump above.
        this._setImpact('none');
      }
    };
    conversation.observeMetadata(this._metadataObserver);
  }

  /**
   * Whether the bound conversation is idle — nothing running anywhere in it —
   * read from the worker's durable processingState metadata (status 'idle', or
   * unset before the first turn), NOT the transient LLMState runtime flag, so it
   * agrees with the metadata event that drives rebaselining. Conversation-wide
   * because a strategy switch reaches every thread that inherits it, so a run
   * live on any of them is a run the switch could change under.
   * @returns {boolean} True when no turn is in flight
   * @private
   */
  _isIdle() {
    const status = this._messageThread?.conversation?.processingState?.status;
    return !status || status === 'idle';
  }

  /**
   * Register (or move) the deep items observer that recomputes the cache-bust
   * caution when the bound thread's history is edited (delete / edit / insert /
   * reorder). Rebinds only when the underlying Y.Array changes — for the root
   * thread the wrapper is reused, and sub-threads mint a fresh wrapper per doc
   * update over the SAME array, so keying off the array avoids per-tick churn.
   * The rebind is also the once-per-thread hook to refresh the async cache
   * inputs (tool set, anchor tokens) and capture the idle baseline.
   * @param {import('../model/message-thread.js').default|null} thread
   * @private
   */
  _bindItemsObserver(thread) {
    const yarray = thread ? thread.yarray : null;
    if (yarray === this._observedItemsYArray) return;
    if (this._itemsObserver && this._observedItemsYArray) {
      this._observedItemsYArray.unobserveDeep?.(this._itemsObserver);
    }
    this._itemsObserver = null;
    this._observedItemsYArray = yarray;
    if (!yarray) return;
    // Deep so a content edit of an existing item (not just add/remove) is seen.
    // Skip while a turn is streaming: the transcript is churning (assistant
    // tokens, tool output) and the caution is suppressed anyway — recomputing
    // per change would re-render the button on every token. The turn's end
    // rebaselines via the completedTurns bump.
    this._itemsObserver = () => {
      if (this._isIdle()) this._recomputeImpact();
    };
    yarray.observeDeep(this._itemsObserver);
    this._bindContainerObserver(thread);
    this._refreshCacheInputs({ rebaseline: true });
  }

  /**
   * Watch a SUB-thread's own container for a per-thread model override. That key
   * lives on the thread's Y.Map — which sits in the PARENT's items array, not in
   * the array `_bindItemsObserver` watches — so without this a column's own
   * model switch would be the one model switch that never warned. The root
   * thread has no container of its own; its model is conversation metadata and
   * is covered by the `defaultModelConfig` branch of the metadata observer.
   * @param {import('../model/message-thread.js').default|null} thread
   * @private
   */
  _bindContainerObserver(thread) {
    const container = thread?.threadItemId ? thread.container : null;
    if (container === this._observedContainer) return;
    if (this._containerObserver && this._observedContainer) {
      this._observedContainer.unobserve?.(this._containerObserver);
    }
    this._containerObserver = null;
    this._observedContainer = container;
    if (!container) return;
    this._containerObserver = (/** @type {any} */ event) => {
      if (event?.keysChanged?.has?.('modelConfig') && this._isIdle()) this._recomputeImpact();
    };
    container.observe(this._containerObserver);
  }

  /**
   * A stable, order-independent signature of the tool set a strategy exposes:
   * the sorted tool names left after its filterTools runs over the full set.
   * @param {any} strategy - Strategy instance
   * @param {Array<{name: string}>} tools - Full generated tool definitions
   * @returns {string} Sorted, comma-joined tool-name signature
   * @private
   */
  _toolSignature(strategy, tools) {
    const filtered = strategy?.filterTools ? strategy.filterTools(tools) : tools;
    return (filtered || []).map((/** @type {any} */ t) => t?.name || '').sort().join(',');
  }

  /**
   * The effective `provider/model#thinking` the next send would use, resolved
   * through the thread's walk-up inheritance. Heads the prefix fingerprint: a
   * cache entry belongs to one model at one provider, so switching either
   * discards the whole cached prefix — the largest bust there is, and the one no
   * provider reports back to us.
   *
   * The thinking level rides along because Anthropic renders the thinking
   * configuration INTO the prompt, so changing it starts a new prefix and
   * invalidates the message cache unconditionally (tool/system breakpoints too,
   * on models that render it ahead of them). We sign the LEVEL, which is what the
   * user chooses; the provider's own budget clamping (see the anthropic client's
   * thinkingBudgetForLevel) can shift the wire value without a user action, and
   * that is not something a caution about the next send can or should predict.
   * @param {any} thread - The bound message thread
   * @returns {string} The model signature ('' when no model is set)
   * @private
   */
  _modelSignature(thread) {
    return this._configSignature(thread?.getEffectiveModelConfig?.());
  }

  /**
   * Encode a model config as the `provider/model#thinking` signature. Shared by
   * the live selection and the anchor blob so the baseline and the outgoing
   * prefix are always described on identical terms — the fingerprint diff is an
   * equality test on these strings, so one encoding is the whole contract.
   * @param {{provider?: string, model?: string, thinking?: string}|null|undefined} cfg - A model config
   * @returns {string} The signature ('' when there is no config)
   * @private
   */
  _configSignature(cfg) {
    if (!cfg) return '';
    return `${cfg.provider || ''}/${cfg.model || ''}#${cfg.thinking || ''}`;
  }

  /**
   * Resolve what the anchored turn cached: its input tokens (the size of the
   * prefix a switch would discard) and the model that built it. Both come from
   * one read of the transaction blob the footer's meter shows
   * (findLastRoundTripTxnId → blob), so the anchor is measured and attributed
   * from a single source.
   *
   * The model matters as much as the size. The baseline claims what the provider
   * has cached, and only the blob knows that — the live selection is a claim
   * about the NEXT send, and a thread that inherits its model (any sub-thread
   * without an override) has that selection changed under it whenever the
   * conversation's default moves. Reading the head off the live config let a
   * root-level switch silently rewrite what a sub-thread believed it had cached,
   * so returning to the model that genuinely ran read as a bust.
   *
   * Tokens 0 / signature '' when no turn has been anchored (fresh conversation)
   * → the predicate says 'none' and the head falls back to the live selection.
   * @param {any} thread - The bound message thread
   * @returns {Promise<{tokens: number, modelSig: string}>} The anchored turn's size and model
   * @private
   */
  async _resolveAnchor(thread) {
    const none = { tokens: 0, modelSig: '' };
    const txnId = findLastRoundTripTxnId(thread?.items);
    const convId = thread?.conversation?.id;
    if (!txnId || !convId) return none;
    try {
      const { default: workerManager } = await import('../services/worker-manager.js');
      const blob = /** @type {any} */ (await workerManager.getTransaction(convId, txnId));
      return {
        tokens: Number(blob?.inputTokens) || 0,
        modelSig: this._configSignature(blob?.modelConfig)
      };
    } catch {
      return none;
    }
  }

  /**
   * Refresh the async inputs of the cache-bust detector, off the hot render path
   * (generateToolDefinitions and the token-blob lookup are async; render() is
   * sync). Caches the full tool set and the anchored turn's size and model,
   * optionally (re)captures the idle baseline fingerprint, then re-diffs
   * synchronously.
   * Callers: the once-per-thread items rebind, the processing→idle transition,
   * and a registries reload. render() and the per-edit path never await.
   * @param {{rebaseline?: boolean}} [opts] - Recapture the baseline (use on bind / idle)
   * @returns {Promise<void>}
   * @private
   */
  async _refreshCacheInputs({ rebaseline = false } = {}) {
    const thread = this._messageThread;
    if (!thread) { this._baseline = null; this._setImpact('none'); return; }
    // "Did the thread swap under us" is a question about the THREAD, not about
    // the wrapper object: conversation-tab mints a fresh MessageThread for every
    // sub-thread column on every doc update, so the object we started with is
    // routinely replaced mid-await while still describing the same thread. An
    // identity check on the object therefore aborts almost every sub-thread
    // refresh — including the rebaseline that follows a turn, which arrives
    // inside exactly such an update — leaving the baseline frozen forever and
    // the caution stuck on. The root thread reuses one wrapper and never saw it.
    const threadKey = thread.threadItemId || null;
    const swapped = () =>
      !this._messageThread || (this._messageThread.threadItemId || null) !== threadKey;
    try {
      const tools = await generateToolDefinitions();
      if (swapped()) return;
      this._toolsAll = tools;
      const anchor = await this._resolveAnchor(thread);
      if (swapped()) return;
      this._anchorTokens = anchor.tokens;
      this._anchorModelSig = anchor.modelSig;
      // Rebaseline only when idle: mid-turn the transcript is still growing and
      // is not a stable cached prefix. When idle, the current transcript is
      // exactly what the provider has now cached — under the model that sent it,
      // which is the anchor's, not whatever is selected now.
      if ((rebaseline || this._baseline === null) && this._isIdle()) {
        this._baseline = this._buildFingerprint(
          this._anchorModelSig || this._modelSignature(this._messageThread)
        );
      }
      this._recomputeImpact();
    } catch (err) {
      console.error('[StrategySelector] _refreshCacheInputs failed:', err);
    }
  }

  /**
   * Build the OUTGOING prefix fingerprint: the transcript as it stands, headed
   * by the model the next send would use. Sync and cheap (no await) — safe to
   * call on every item edit.
   * @returns {string[]|null} The fingerprint, or null when inputs aren't ready
   * @private
   */
  _buildCurrentFingerprint() {
    return this._buildFingerprint(this._modelSignature(this._messageThread));
  }

  /**
   * Build a prefix fingerprint from cached inputs under a given model: the
   * model signature, the effective strategy's tool-set signature, then one
   * signature per leading `prefix` context item and per history item. The model
   * is a parameter because the baseline and the outgoing prefix share every
   * other term and differ only there — the baseline is headed by the model that
   * cached the transcript, the outgoing one by the model that would send it.
   * Returns null until the tool set has been resolved.
   * @param {string} modelSig - The model signature to head the fingerprint with
   * @returns {string[]|null} The fingerprint, or null when inputs aren't ready
   * @private
   */
  _buildFingerprint(modelSig) {
    const thread = this._messageThread;
    if (!thread || !this._toolsAll) return null;
    const strategy = strategyRegistry.createStrategy(thread.currentStrategyId || 'default', thread);
    const toolsetSig = this._toolSignature(strategy, this._toolsAll);
    // Leading `prefix` context items (frozen pinned/dropped files) are part of the
    // cached prefix now, so a change to them busts from their position.
    const prefixItems = (thread.contextItems || []).filter(
      (/** @type {any} */ ci) => contextPositionOf(ci) === 'prefix'
    );
    return buildPrefixFingerprint({
      modelSig,
      toolsetSig,
      prefixItems,
      items: thread.items
    });
  }

  /**
   * Re-diff the outgoing prefix against the captured baseline and update the
   * cache-impact classification (which announces any flip to the composer). Sync
   * (uses only cached inputs); the hot path for item edits and staged strategy
   * switches.
   * @private
   */
  _recomputeImpact() {
    this._setImpact(!this._isIdle()
      ? 'none'
      : classifyContextCacheImpact({
        baseline: this._baseline,
        current: this._buildCurrentFingerprint(),
        anchorTokens: this._anchorTokens
      }));
  }

  /**
   * Record the current cache-impact classification and, when it flips, announce
   * it so the composer can show or hide its warning. The warning affordance — a
   * round alert beside the send button — lives in composer-box, not here; a
   * bubbling event is the only coupling. Fired only on change, so an unrelated
   * edit that leaves the classification untouched is silent. Deliberately
   * carries no token figure: only whether the loss is large enough to mention.
   * @param {'none'|'busts-large'} next - The new classification
   * @private
   */
  _setImpact(next) {
    if (next === this._pendingImpact) return;
    this._pendingImpact = next;
    this.dispatchEvent(new CustomEvent(CONTEXT_CACHE_IMPACT_CHANGED, {
      bubbles: true,
      detail: { busts: next === 'busts-large' },
    }));
  }

  /** @private */
  setupListeners() {
    // Refresh the menu when strategies are enabled/disabled (catalog toggle
    // or plugin hot reload). The registry is the source of truth; reload from
    // it and re-render so the dropdown reflects the new set of strategies.
    this.onDocument(REGISTRIES_RELOADED, () => {
      this.loadStrategies();
      this.render();
      // A plugin toggle can change the available tool set, so the cached tool
      // signature that heads the prefix fingerprint may differ now — refresh it.
      this._refreshCacheInputs();
    });
  }

  /** @private */
  toggleDropdown() {
    if (this._dropdownOpen) {
      this.closeDropdown();
      return;
    }
    this._dropdownOpen = true;
    this.render();

    // presentInlineMenu owns the deferred relocation; presentPopup beneath it
    // owns body-append, dismissal wiring, the reposition observer (which also
    // re-anchors on the in-place content refresh in render()), and the
    // anchored-vs-sheet decision.
    this._menu = presentInlineMenu({
      host: this,
      surfaceSelector: '.strategy-dropdown',
      anchorSelector: '.strategy-selector-button',
      onClose: () => this.closeDropdown(),
      // The <menu> outlives in-place refreshes (only its rows are replaced), so
      // the keyboard is attached once, here. Opened by the hold-to-cycle gesture
      // it is a HUD, not a focus target: the gesture owns the keys, and focus
      // stays in the composer the user is typing in.
      onPresent: (surface) => {
        const menu = /** @type {HTMLElement|null} */ (surface.querySelector('[role="menu"]'));
        if (!menu) return;
        const takeKeyboard = this._keyboardOnPresent;
        this._keyboardOnPresent = false;
        attachMenuKeyboard(menu, { close: () => this.closeDropdown(), autoFocus: !this._cycle.buffering && !takeKeyboard });
        if (takeKeyboard) focusMenuChoice(menu);
      },
    });
  }

  /**
   * Hand the open dropdown the keyboard, on the checked strategy — for a
   * hold-to-cycle HUD, which leaves focus where the user was typing, settling
   * into an ordinary menu. A dropdown not yet presented takes it once it is.
   */
  takeKeyboard() {
    if (!this._dropdownOpen) return;
    const menu = /** @type {HTMLElement|null} */ (this._menu?.surface?.querySelector('[role="menu"]') ?? null);
    if (menu) focusMenuChoice(menu);
    else this._keyboardOnPresent = true;
  }

  /** @private */
  closeDropdown() {
    this._keyboardOnPresent = false;
    if (this._dropdownOpen) {
      this._dropdownOpen = false;
      // Close cancels a pending relocation, then tears down the surface, scrim,
      // observer and dismissal wiring.
      this._menu?.close();
      this._menu = null;
      // Just update button state without full re-render to avoid focus disruption
      const button = this.querySelector('.strategy-selector-button');
      if (button) {
        button.setAttribute('aria-expanded', 'false');
      }
    }
  }

  /**
   * Select a strategy
   * @param {string} strategyId
   * @private
   */
  selectStrategy(strategyId) {
    // An explicit pick supersedes any in-flight post-commit pin.
    this._cycle.reset();
    if (!this._messageThread) {
      console.error('[StrategySelector] No message thread bound');
      this.closeDropdown();
      return;
    }

    if (this._currentStrategyId === strategyId) {
      this.closeDropdown();
      return;
    }

    // Update the conversation's strategy
    this._writeStrategyToDoc(strategyId);

    // Close dropdown first so render() sees dropdownOpen = false
    this.closeDropdown();

    // Update local display
    this._currentStrategyId = strategyId;
    this.render();
  }

  /**
   * The strategy id the collapsed BUTTON should display: the frozen committed id
   * while a gesture is cycling (so the button doesn't track the previewed hops —
   * those show only in the dropdown HUD), otherwise the live id.
   * @returns {string} The id to show on the button.
   * @private
   */
  _buttonStrategyId() {
    return this._cycle.buffering && this._committedStrategyId !== null
      ? this._committedStrategyId
      : this._currentStrategyId;
  }

  /**
   * Get the current strategy name for display
   * @returns {string} The display name of the current strategy
   * @private
   */
  getCurrentStrategyName() {
    const strategy = this._strategies.find(s => s.id === this._buttonStrategyId());
    return strategy
      ? capabilityLabel(strategy.manifest.name, strategy.id, strategyRegistry)
      : t('Select Strategy');
  }

  /**
   * Generate the dropdown menu content
   * @returns {string} HTML string for the dropdown menu items
   * @private
   */
  generateDropdownContent() {
    if (this._strategies.length === 0) {
      return `
                <li class="strategy-item is-unavailable" role="none">
                    <div class="strategy-item-body" role="menuitem" aria-disabled="true">
                        <p class="strategy-item-description">${escapeHtml(t('No strategies.'))}</p>
                    </div>
                </li>
            `;
    }

    return this._strategies.map(({ id, manifest }) => {
      const isActive = id === this._currentStrategyId;
      const colorStyle = manifest.color ? `style="--strategy-color: ${escapeHtml(manifest.color)}"` : '';

      const iconHtml = manifest.icon
        ? `<span class="strategy-item-icon ${escapeHtml(manifest.icon)}" aria-hidden="true"></span>`
        : '';
      const name = capabilityLabel(manifest.name, id, strategyRegistry);
      const description = capabilityLabel(manifest.description, id, strategyRegistry);

      // The row is two items side by side — choosing the strategy, and opening
      // its details — since a menu item may not contain another control. The
      // <li> is only the row they share, and clicks on the body bubble to it.
      return `
                <li class="strategy-item ${isActive ? 'is-active' : ''}" data-strategy-id="${escapeHtml(id)}" role="none" ${colorStyle}>
                    <div class="strategy-item-body" role="menuitemradio" aria-checked="${isActive}">
                        <header class="strategy-item-header">
                            <span class="strategy-item-label">
                                ${iconHtml}
                                <span class="strategy-item-name">${escapeHtml(name)}</span>
                            </span>
                        </header>
                        <p class="strategy-item-description">${escapeHtml(description)}</p>
                    </div>
                    <button type="button" class="btn btn-icon btn-ghost strategy-info-button" role="menuitem" data-strategy-info-id="${escapeHtml(id)}" title="${escapeHtml(t('View strategy details'))}" aria-label="${escapeHtml(t('View {name} strategy details', { name }))}">${INFO_SVG}</button>
                </li>
            `;
    }).join('');
  }

  /**
   * Get the current strategy's color for visual identification
   * @returns {string|null} The CSS color value or null if not defined
   * @private
   */
  getCurrentStrategyColor() {
    const strategy = this._strategies.find(s => s.id === this._buttonStrategyId());
    return strategy?.manifest.color || null;
  }

  /**
   * Get the current strategy's icon class for display next to its name
   * @returns {string|null} The icon CSS class or null if not defined
   * @private
   */
  getCurrentStrategyIcon() {
    const strategy = this._strategies.find(s => s.id === this._buttonStrategyId());
    return strategy?.manifest.icon || null;
  }

  /**
   * Open the dropdown (for keyboard shortcut)
   */
  open() {
    if (!this._dropdownOpen) {
      this.toggleDropdown();
    }
  }

  /**
   * Close the dropdown (for keyboard shortcut)
   */
  close() {
    this.closeDropdown();
  }

  /**
   * Preview the next strategy (wraps around), keeping the dropdown open. This
   * moves the LIVE id — which drives the dropdown HUD's highlight — but writes
   * nothing to the doc (a running turn never sees an intermediate strategy) and
   * leaves the collapsed button frozen at the committed strategy until release.
   * `render()` refreshes the open menu and its anchor button IN PLACE (see the
   * live-dropdown branch), so cycling never tears the body-hosted popup down and
   * re-presents it.
   */
  cycleNext() {
    if (!this._messageThread || this._strategies.length <= 1) return;

    const currentIndex = this._strategies.findIndex(s => s.id === this._currentStrategyId);
    const nextIndex = (currentIndex + 1) % this._strategies.length;
    const next = this._strategies[nextIndex];
    if (!next) return;

    this._currentStrategyId = next.id;
    this.render();
  }

  /**
   * Persist a strategy id to the bound thread — the doc the engine (and any
   * running turn) reads. Shared by `selectStrategy` and `commitCycle`.
   * @param {string} strategyId
   * @private
   */
  _writeStrategyToDoc(strategyId) {
    this._messageThread?.setStrategy(strategyId);
  }

  /**
   * Begin a hold-to-cycle gesture: snapshot the committed strategy so the button
   * stays frozen on it while the dropdown previews hops, and freeze doc-sync.
   * Idempotent, and supersedes any pin left by a previous commit.
   */
  beginCycle() {
    this._committedStrategyId = this._currentStrategyId;
    this._cycle.begin();
  }

  /**
   * Commit the gesture (modifier released): the previewed id becomes the
   * selection. If it changed, write it to the doc exactly once — so a running
   * turn only ever sees the final choice — and pin it against the post-commit
   * sync bounce until the turn settles. Then repaint the button DIRECTLY (not
   * via the doc-sync path, which the pin may gate). A pure hold-to-peek that
   * landed back on the committed strategy writes nothing.
   */
  commitCycle() {
    const landing = this._currentStrategyId;
    const changed = landing !== this._committedStrategyId;
    this._committedStrategyId = null;
    if (changed) {
      this._cycle.pin(landing);
      this._writeStrategyToDoc(landing);
    } else {
      this._cycle.end();
    }
    this.render();
  }

  /**
   * Abandon the gesture (Escape): nothing was written, so drop the preview and
   * restore the button/dropdown to the committed strategy.
   */
  cancelCycle() {
    this._currentStrategyId = this._committedStrategyId
      ?? (this._messageThread?.currentStrategyId || 'default');
    this._committedStrategyId = null;
    this._cycle.end();
    this.render();
  }

  render() {
    const strategyName = this.getCurrentStrategyName();
    const strategyColor = this.getCurrentStrategyColor();
    const strategyIcon = this.getCurrentStrategyIcon();
    const dropdownContent = this.generateDropdownContent();

    // Build style attribute for color if defined
    const colorStyleHTML = strategyColor ? `style="--strategy-color: ${escapeHtml(strategyColor)}"` : '';
    const hasColorAttrHTML = strategyColor ? 'data-has-color="true"' : '';

    // While open, the dropdown has been relocated out of this element to
    // <body> (see toggleDropdown) and positioned against our button. A
    // re-render here — e.g. the bound thread changed when the conversation
    // switches — must NOT clobber innerHTML: that recreates (detaches) the
    // button the body-hosted menu is anchored to, so the menu's
    // MutationObserver repositions against a detached node (rect = 0) and the
    // menu jumps to the top-left corner, while the button visibly flashes.
    // When the live surface and its anchor button both exist, update the
    // button IN PLACE and refresh + reposition the menu, leaving both intact.
    //
    // Scope to this instance's own surface, never a document-wide query: with a
    // sub-thread open, several selectors coexist and the query would return
    // whichever one is open — so a closed sibling re-rendering (its thread
    // rebuilds on every doc update) rebound the open menu's clicks to its own
    // thread, landing every selection on the wrong thread.
    const liveDropdown = this._menu?.surface ?? null;
    const liveButton = /** @type {HTMLElement|null} */ (
      this.querySelector('.strategy-selector-button'));

    if (this._dropdownOpen && liveDropdown && liveButton) {
      this._updateButton(liveButton, strategyName, strategyColor, strategyIcon);
      const menu = liveDropdown.querySelector('menu');
      if (menu) menu.innerHTML = dropdownContent;
      this._attachItemListeners(liveDropdown);
      // presentPopup's MutationObserver catches this content change and
      // re-anchors the surface (or leaves the sheet untouched on a phone).
      return;
    }

    const dropdownHtml = (this._dropdownOpen && !liveDropdown)
      ? `<nav class="dropdown-menu strategy-dropdown is-open" id="strategy-dropdown"><menu role="menu" aria-label="${escapeHtml(t('Strategy'))}">${dropdownContent}</menu></nav>`
      : '';

    const buttonIconHtml = strategyIcon
      ? `<span class="strategy-icon ${escapeHtml(strategyIcon)}" aria-hidden="true"></span>`
      : '';

    this.innerHTML = `
            <button class="strategy-selector-button input-ctrl-btn btn-ghost" id="strategy-button" tabindex="-1" title="${escapeHtml(t('Select Strategy'))}" aria-haspopup="menu" aria-expanded="${this._dropdownOpen ? 'true' : 'false'}" ${colorStyleHTML} ${hasColorAttrHTML}>
                ${buttonIconHtml}
                <span class="strategy-name text-truncate">${escapeHtml(strategyName)}</span>
            </button>
            ${dropdownHtml}
        `;

    // Attach event listeners
    const button = this.querySelector('#strategy-button');
    if (button) {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleDropdown();
      });
    }

    // Wire the strategy items wherever they now live: the relocated surface
    // when one is open, otherwise the freshly-rendered inner <nav> (which
    // toggleDropdown's rAF moves to <body>, listeners and all).
    if (liveDropdown) {
      const menu = liveDropdown.querySelector('menu');
      if (menu) menu.innerHTML = dropdownContent;
      this._attachItemListeners(liveDropdown);
    } else {
      this._attachItemListeners(this);
    }
  }

  /**
   * Update an existing button's label, colour and open-state in place, without
   * replacing the element. Used while the menu is open so the body-hosted menu
   * keeps a live, attached anchor to position against.
   * @param {HTMLElement} button - The existing `.strategy-selector-button`
   * @param {string} strategyName - Current strategy display name
   * @param {string|null} strategyColor - Current strategy colour, or null
   * @param {string|null} strategyIcon - Current strategy icon class, or null
   * @private
   */
  _updateButton(button, strategyName, strategyColor, strategyIcon) {
    const nameEl = button.querySelector('.strategy-name');
    if (nameEl) nameEl.textContent = strategyName;

    // Sync the leading icon in place so the body-hosted menu's anchor button
    // is never recreated (which would detach the menu's positioning target).
    let iconEl = button.querySelector('.strategy-icon');
    if (strategyIcon) {
      if (!iconEl) {
        iconEl = document.createElement('span');
        iconEl.setAttribute('aria-hidden', 'true');
        button.insertBefore(iconEl, nameEl);
      }
      iconEl.className = `strategy-icon ${strategyIcon}`;
    } else if (iconEl) {
      iconEl.remove();
    }

    if (strategyColor) {
      button.style.setProperty('--strategy-color', strategyColor);
      button.setAttribute('data-has-color', 'true');
    } else {
      button.style.removeProperty('--strategy-color');
      button.removeAttribute('data-has-color');
    }
    button.setAttribute('aria-expanded', String(this._dropdownOpen));
  }

  /**
   * Wire click handlers on the strategy items under `root`.
   * @param {ParentNode} root - Element containing the `.strategy-item` nodes.
   * @private
   */
  _attachItemListeners(root) {
    root.querySelectorAll('.strategy-info-button[data-strategy-info-id]').forEach(button => {
      button.addEventListener('click', event => {
        event.stopPropagation();
        const strategyId = button.getAttribute('data-strategy-info-id');
        if (!strategyId) return;

        this.closeDropdown();
        openSettings('extensions', {
          capability: { itemType: 'strategy', id: strategyId },
        });
      });
    });

    root.querySelectorAll('.strategy-item[data-strategy-id]').forEach(item => {
      item.addEventListener('click', () => {
        const strategyId = item.getAttribute('data-strategy-id');
        if (strategyId) {
          this.selectStrategy(strategyId);
        }
      });
    });
  }
}

customElements.define('strategy-selector', StrategySelector);

export { StrategySelector };
