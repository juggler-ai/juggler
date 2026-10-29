//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <info-rail> — the ambient stack of "info cards" parked in the empty sidebar
 * space just above the Bin (Usage, Git status, …). Each card gets the same chrome:
 * an eyebrow label, a × that hides it (bring it back from the info-cards menu the
 * rail heads the stack with), and a content region the card fills itself. The
 * gate-1 enabled card instances are supplied by
 * {@link module:services/info-cards-manager}; the cards themselves are plugins of
 * the `@juggler/core` extension.
 *
 * The rail also hosts the {@link module:components/info-cards-button|"i" menu} as
 * the first child of its stack, so the control rides immediately above the cards
 * it manages, and stays reachable to bring hidden cards back when no card is up.
 *
 * The rail asks for exactly the height its cards need (`flex: 0 0 auto`) and the
 * tab list takes everything above it, so the list runs right down to the topmost
 * card: it scrolls only when the column is genuinely full, never beside space it
 * could have used. What the cards don't get to win is the whole column — CSS caps
 * the rail at a share of it (`max-height`), and that resolved cap, not the rail's
 * own box, is the budget {@link InfoRail#_fitCount} measures against. Reading its
 * own height instead would be circular now that its height is its content: a rail
 * showing one card would measure room for one card and could never take a dropped
 * one back.
 *
 * Two limits, in this order. {@link MAX_CARDS} caps how many cards are ever
 * mounted, so a tall window doesn't hand the sidebar over to them. Then geometry:
 * cards stack top-priority-first and, below the first, are shown *whole or not at
 * all* — any that don't fully fit the budget are dropped from the tail. The first
 * card is the exception; rather than leave a card-sized hole above the Bin it is
 * kept and allowed to run off the rail's top edge, faded, while enough of it stays
 * visible to be worth reading.
 *
 * A single ResizeObserver watches the column (for the budget: sidebar drag, window
 * resize) and every mounted card (for content that grows after it was measured),
 * and reconciles synchronously — the observer runs after layout but before paint,
 * so a shrink never paints a half-clipped card. Surviving cards are reused across
 * reconciles, so tip rotation isn't reset as the sidebar resizes.
 *
 * Nothing polls the rail. A dropped card is torn down, so a periodic re-fit would
 * rebuild — and remount, and refetch — every card that doesn't fit, once per tick.
 * A card that comes and goes with the conversation says so instead, through its
 * `watchContent`, which the rail keeps for every enabled card mounted or not.
 *
 * Not an ARIA live region — rotating tip text would spam a screen reader.
 * @module components/info-rail
 */

import { providers, isHidden, hideCard, INFO_CARDS_CHANGED_EVENT } from '../services/info-cards-manager.js';
import infoCardRegistry from '../registries/info-card-registry.js';
import { capabilityLabel } from '../utils/capability-label.js';
import { WORD_OF_MOUTH_CARD } from './word-of-mouth.js';
import { t } from '../../sdk/lib/i18n.js';
import './info-cards-button.js';
import JugglerElement from './juggler-element.js';

/**
 * How much of the top card has to stay visible, in rem, for showing it clipped to
 * beat showing nothing. Twice the fade the CSS signs the cut with
 * (`--info-card-fade`), so there is always as much solid card as faded card —
 * below that the whole thing is fade and reads as a rendering fault. Under this,
 * the rail is visibly just its "i" row and no space looks unaccounted for.
 * @type {number}
 */
const MIN_CLIPPED_REVEAL_REM = 3;

/**
 * How many cards may be on screen at once, taken highest-priority-first. The rail
 * is ambient furniture: past a few cards the sidebar stops being a list of
 * conversations with something in the space below it. A count is the cheap half of
 * the limit — the CSS cap on the rail's height is the half that holds in a short
 * window, where even this many wouldn't fit.
 * @type {number}
 */
const MAX_CARDS = 3;

/**
 * The runtime shape of a mounted card — an {@link import('juggler/info-card-type').default}
 * instance. Cards expose their manifest metadata as instance getters (id, name,
 * eyebrow) alongside the lifecycle methods.
 * @typedef {import('juggler/info-card-type').default} InfoCardProvider
 */

class InfoRail extends JugglerElement {
  constructor() {
    super();
    /**
     * The cards currently in the DOM, in priority order (top → bottom).
     * @type {Array<{provider: InfoCardProvider, card: HTMLElement, teardown: () => void}>}
     * @private
     */
    this._mounted = [];
    /** @type {boolean} @private Reentrancy guard: a reconcile must not nest. */
    this._reconciling = false;
    /** @type {import('../model/session.js').default|undefined} @private */
    this._session = undefined;
    /** @type {HTMLElement|null} @private The "i" menu heading the stack. */
    this._cardsButton = null;
    /**
     * Watches the sidebar column's box (the budget) and every mounted card's box
     * (content that grows after it was measured). The sole re-fit trigger.
     * @type {ResizeObserver|null} @private
     */
    this._resizeObserver = null;
    /**
     * Each enabled card's `watchContent` teardown, for this rail's session. A
     * card with nothing to show is never mounted, so this — not the mount — is
     * how a card that comes and goes with the conversation gets back in.
     * @type {Map<InfoCardProvider, () => void>} @private
     */
    this._watches = new Map();
  }

  connectedCallback() {
    // The "i" menu leads the stack, so it sits immediately above the topmost card
    // (and just above the Bin when no card is showing). Appended before any card,
    // and cards only ever append after it, so it stays first.
    if (!this._cardsButton) {
      this._cardsButton = document.createElement('info-cards-button');
      this.appendChild(this._cardsButton);
    }

    this.onWindow(INFO_CARDS_CHANGED_EVENT, () => this._reconcile());

    // Reconcile SYNCHRONOUSLY: a ResizeObserver callback runs after layout but
    // before paint, so dropping a card that no longer fits here means the clipped
    // frame is never painted. This observer is the ONLY thing that drives a
    // re-fit, and it covers every way the fit can change: the column's box for the
    // budget (the sidebar drag, the window resizing), and each mounted card's box
    // for content that grows after it was measured. Nothing polls the rail — a
    // periodic re-fit would tear down and rebuild every card that doesn't fit,
    // once per tick (see _reconcile).
    //
    // The COLUMN is what's watched, not the rail: the rail's height is now its own
    // content, so watching it would be watching our own output — and every card we
    // mounted or dropped would call us back to decide it again. Nothing the rail
    // does changes the column's height, so there is no path back into this. A
    // dropped card is unobserved before it leaves the DOM, so its removal queues no
    // callback either.
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this._reconcile());
      if (this.parentElement) this._resizeObserver.observe(this.parentElement);
      this.addCleanup(() => {
        this._resizeObserver?.disconnect();
        this._resizeObserver = null;
      });
    }
    this._reconcile();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._teardownAll();
    this._stopWatches();
  }

  /**
   * Supply the owning conversation session to newly mounted card providers.
   * @param {import('../model/session.js').default} session
   * @returns {void}
   */
  setSession(session) {
    if (this._session === session) return;
    this._session = session;
    this._teardownAll();
    // A watch follows the session it was handed, so a new session needs new ones.
    this._stopWatches();
    this._reconcile();
  }

  /**
   * Watch every enabled card that offers to say when its `hasContent` answer
   * may have changed, and stop watching the ones no longer enabled. Keyed by
   * instance, so a reloaded extension's new card is watched afresh.
   * @param {InfoCardProvider[]} enabled - The cards not hidden by the user.
   * @private
   */
  _syncWatches(enabled) {
    const wanted = new Set(enabled);
    for (const [provider, stop] of this._watches) {
      if (wanted.has(provider)) continue;
      this._watches.delete(provider);
      try { stop(); } catch { /* card cleanup is best-effort */ }
    }
    for (const provider of enabled) {
      if (this._watches.has(provider) || typeof provider.watchContent !== 'function') continue;
      let stop;
      try {
        stop = provider.watchContent(this._session, () => this._reconcile());
      } catch {
        stop = undefined;
      }
      this._watches.set(provider, typeof stop === 'function' ? stop : () => {});
    }
  }

  /** @private */
  _stopWatches() {
    for (const stop of this._watches.values()) {
      try { stop(); } catch { /* card cleanup is best-effort */ }
    }
    this._watches.clear();
  }

  /** @private */
  _teardownAll() {
    for (const entry of this._mounted) this._teardownEntry(entry);
    this._mounted = [];
  }

  /**
   * Tear down one card entry: stop its content, remove it from the DOM.
   * Unobserved BEFORE it leaves the DOM, so the removal doesn't queue a resize
   * callback that would reconcile again and rebuild the card we just dropped.
   * @param {{provider: InfoCardProvider, card: HTMLElement, teardown: () => void}} entry
   * @private
   */
  _teardownEntry(entry) {
    this._resizeObserver?.unobserve(entry.card);
    try { entry.teardown(); } catch { /* card cleanup is best-effort */ }
    entry.card.remove();
  }

  /**
   * The height the rail is allowed to take, in px — the cap CSS puts on it, not the
   * rail's own box. Its box is its content now, so measuring that would only ever
   * confirm the cards already up: a rail showing one card would find room for one
   * card and never take a dropped one back.
   *
   * getComputedStyle reports max-height as specified rather than used (it isn't one
   * of the properties whose resolved value is the used value), so a percentage
   * arrives here still a percentage and is resolved against the containing block —
   * the column's content box. Both forms are handled, so the share stays written
   * once, in CSS, whichever units it is written in.
   * @returns {number} The budget, falling back to the column's full height if the
   *   rail is uncapped.
   * @private
   */
  _budget() {
    const column = this.parentElement ? this.parentElement.clientHeight : this.clientHeight;
    const cap = getComputedStyle(this).maxHeight;
    const value = parseFloat(cap);
    if (!Number.isFinite(value)) return column;
    return cap.endsWith('%') ? (column * value) / 100 : Math.min(value, column);
  }

  /**
   * How many of the currently-mounted cards, taken from the top (highest priority),
   * fully fit the rail's budget — summing each card's own offsetHeight plus the
   * inter-card gap. offsetHeight is a card's true rendered height even while the
   * parent is clipping it, so this is engine-independent (unlike scrollHeight, which
   * ignores the top-edge overflow our bottom-aligned stack produces). The "i" menu
   * shares the stack, so its own height (and the gap below it) comes off the budget
   * first — it is never the thing that gets dropped.
   *
   * When not even the first card fits, it is kept anyway and left to overflow,
   * provided {@link MIN_CLIPPED_REVEAL_REM} of the rail is there to show it in. The
   * stack is bottom-aligned, so what overflows leaves past the rail's TOP edge and
   * the card keeps the end its content builds towards. Dropping it instead is what
   * leaves a card-sized hole above the Bin that reads as a card failing to render.
   * @returns {{count: number, clipped: boolean}} How many leading cards to keep, and
   *   whether the topmost of them overflows the rail.
   * @private
   */
  _fitCount() {
    const cs = getComputedStyle(this);
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const gap = parseFloat(cs.rowGap) || 0;
    const buttonHeight = this._cardsButton ? this._cardsButton.offsetHeight : 0;
    const available = this._budget() - padY - (buttonHeight > 0 ? buttonHeight + gap : 0);
    let used = 0;
    let count = 0;
    for (const entry of this._mounted) {
      const next = used + (count === 0 ? 0 : gap) + entry.card.offsetHeight;
      if (next > available + 1) break;
      used = next;
      count += 1;
    }
    if (count === 0 && this._mounted.length > 0) {
      const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      if (available >= MIN_CLIPPED_REVEAL_REM * remPx) return { count: 1, clipped: true };
    }
    // Anything kept by the loop fits whole, so only the forced card is ever clipped.
    return { count, clipped: false };
  }

  /**
   * Show the enabled, has-content cards top-priority-first — at most
   * {@link MAX_CARDS} of them, and of those only the ones that FULLY fit the
   * budget, since a card is shown whole or not at all. Surviving cards are reused
   * (so tip rotation isn't reset as the sidebar resizes); only the lowest-priority
   * cards that no longer fit are removed. Run synchronously from the
   * ResizeObserver so a shrink never paints a clipped card.
   * @private
   */
  _reconcile() {
    if (!this.isConnected || this._reconciling) return;
    this._reconciling = true;
    try {
      // The count limit, applied before anything is built: providers() is already
      // sorted by descending priority, so this keeps the cards worth the room and
      // the rest are never mounted at all. Geometry then trims what's left.
      const enabled = providers().filter((p) => !isHidden(p.id));
      this._syncWatches(enabled);
      const eligible = enabled
        .filter((p) => typeof p.hasContent !== 'function' || p.hasContent(this._session))
        .slice(0, MAX_CARDS);
      // The one-time "spread the word" ask is built in rather than a plugin, and
      // only takes a slot the extension cards leave free.
      if (eligible.length < MAX_CARDS && !isHidden(WORD_OF_MOUTH_CARD.id) && WORD_OF_MOUTH_CARD.hasContent()) {
        eligible.push(/** @type {any} */ (WORD_OF_MOUTH_CARD));
      }

      // Reconcile the mounted set to the eligible providers, in priority order,
      // reusing existing cards so their state (tip rotation) survives.
      const existing = new Map(this._mounted.map((e) => [e.provider.id, e]));
      /** @type {Array<{provider: InfoCardProvider, card: HTMLElement, teardown: () => void}>} */
      const next = [];
      // Walk the stack placing each card after the "i" menu in priority order,
      // but move ONLY the cards genuinely out of position — the same rule the
      // conversation bar's tab reorder follows. Re-inserting a connected node is
      // a remove+insert: it restarts the card's CSS animations, and a card that
      // moves between a click's mousedown and mouseup swallows that click. This
      // reconciles on every doc change while a turn streams, so an unconditional
      // re-append would churn the whole stack ~100 times a second.
      let expected = this._cardsButton ? this._cardsButton.nextSibling : this.firstChild;
      for (const provider of eligible) {
        let entry = existing.get(provider.id);
        if (entry) {
          existing.delete(provider.id);
        } else {
          const built = this._buildCard(provider);
          entry = { provider, card: built.card, teardown: built.teardown };
          // Watch the new card so content that grows past the space it was
          // measured into triggers a re-fit rather than being clipped.
          this._resizeObserver?.observe(entry.card);
        }
        if (entry.card !== expected) {
          this.insertBefore(entry.card, expected);
        }
        expected = entry.card.nextSibling;
        next.push(entry);
      }
      for (const stale of existing.values()) this._teardownEntry(stale);
      this._mounted = next;

      // Keep only the top cards that fully fit, and drop the rest from the tail
      // (the lower-priority ones). Measured by summing each card's own offsetHeight
      // rather than reading scrollHeight: with the stack bottom-aligned it overflows
      // the *top* edge, and scrollHeight doesn't count start-edge overflow in every
      // engine (Chrome reports none) — so scrollHeight would silently miss the clip.
      const { count: fit, clipped } = this._fitCount();
      while (this._mounted.length > fit) {
        const dropped = this._mounted.pop();
        if (dropped) this._teardownEntry(dropped);
      }
      // Let CSS fade the top card's cut edge. Safe to set from here: a mask paints,
      // it doesn't lay out, so it can't resize the rail back into this observer.
      this.toggleAttribute('data-clipped', clipped);
      // Left in the column even with nothing to show: it shrinks to the "i" row —
      // the only way back for a card hidden by its × — and to nothing at all once
      // that row hides itself too.
    } finally {
      this._reconciling = false;
    }
  }

  /**
   * Build one card: shared chrome (eyebrow + × close) around the provider's
   * content region.
   * @param {InfoCardProvider} provider
   * @returns {{card: HTMLElement, teardown: () => void}} The card element and its
   *   content teardown.
   * @private
   */
  _buildCard(provider) {
    const card = document.createElement('div');
    card.className = 'info-card';
    card.setAttribute('role', 'note');
    card.dataset.cardId = provider.id;

    const header = document.createElement('div');
    header.className = 'info-card__header';

    const eyebrow = document.createElement('span');
    eyebrow.className = 'info-card__eyebrow';
    // A manifest literal, extracted into the owning extension's catalogue.
    eyebrow.textContent = capabilityLabel(provider.eyebrow, provider.id, infoCardRegistry);
    header.appendChild(eyebrow);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'info-card__close';
    const hideLabel = t('Hide {name}', { name: capabilityLabel(provider.name, provider.id, infoCardRegistry) });
    close.setAttribute('aria-label', hideLabel);
    close.title = hideLabel;
    close.textContent = '×';
    close.addEventListener('click', (e) => { e.stopPropagation(); hideCard(provider.id); });
    header.appendChild(close);

    card.appendChild(header);

    const content = document.createElement('div');
    content.className = 'info-card__content';
    card.appendChild(content);

    let cleanup;
    try {
      cleanup = provider.mount(content, this._session);
    } catch {
      cleanup = undefined;
    }
    const teardown = typeof cleanup === 'function' ? cleanup : () => {};
    return { card, teardown };
  }
}

customElements.define('info-rail', InfoRail);
