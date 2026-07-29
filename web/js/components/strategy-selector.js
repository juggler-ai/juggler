//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import strategyRegistry from '../registries/strategy-registry.js';
import { REGISTRIES_RELOADED } from '../registries/reload-registries.js';
import { presentPopup } from '../utils/popup-surface.js';
import CycleBuffer from '../services/cycle-buffer.js';

/**
 * Strategy Selector - Dropdown component for selecting conversation strategy
 * @typedef {object} StrategyManifestInfo
 * @property {string} id - Strategy ID
 * @property {import('juggler/strategy-type').StrategyManifest} manifest - Strategy manifest
 */

class StrategySelector extends HTMLElement {
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
    /** @type {(() => void)|null} @private - presentPopup release for the open dropdown. */
    this._popupRelease = null;
    /**
     * This selector's own dropdown while open (relocated to <body>), else null.
     * Instance-scoped so render() never finds a sibling's surface: multiple
     * selectors coexist (root + each open sub-thread column).
     * @type {HTMLElement|null} @private
     */
    this._liveDropdown = null;
    /** @type {(() => void)|null} @private */
    this._boundRegistriesReloaded = null;
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
  }

  connectedCallback() {
    this.loadStrategies();
    this.render();
    this.setupListeners();
  }

  disconnectedCallback() {
    if (this._boundRegistriesReloaded) {
      document.removeEventListener(REGISTRIES_RELOADED, this._boundRegistriesReloaded);
      this._boundRegistriesReloaded = null;
    }
    this._bindMetadataObserver(null);
    // Tear down the open dropdown (surface, scrim, observer, dismissal wiring).
    if (this._popupRelease) {
      this._popupRelease();
      this._popupRelease = null;
    }
    this._liveDropdown = null;
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
    // Self-observe the bound conversation's metadata (before the display guards
    // below, which can early-return) so a remote strategy switch repaints us
    // directly rather than relying on a conversation-tab rebuild re-pushing.
    this._bindMetadataObserver(messageThread ? messageThread.conversation : null);
    // The CycleBuffer owns the two guards this used to hand-roll: while a gesture
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
      if (!event.keysChanged?.has?.('currentStrategyId')) return;
      // Re-run the bound-thread sync. The conversation's own metadata observer
      // (setupYjsObservers) refreshes root.currentStrategyId before this fires,
      // so re-reading the thread yields the new id; the CycleBuffer guard inside
      // keeps an in-flight local hold-to-cycle gesture from being clobbered by
      // the echo of its own commit. Re-binding is a no-op here (same
      // conversation), so this never recurses.
      this.setMessageThread(this._messageThread);
    };
    conversation.observeMetadata(this._metadataObserver);
  }

  /** @private */
  setupListeners() {
    // Refresh the menu when strategies are enabled/disabled (catalog toggle
    // or plugin hot reload). The registry is the source of truth; reload from
    // it and re-render so the dropdown reflects the new set of strategies.
    this._boundRegistriesReloaded = () => {
      this.loadStrategies();
      this.render();
    };
    document.addEventListener(REGISTRIES_RELOADED, this._boundRegistriesReloaded);
  }

  /** @private */
  toggleDropdown() {
    if (this._dropdownOpen) {
      this.closeDropdown();
      return;
    }
    this._dropdownOpen = true;
    this.render();

    // presentPopup owns body-append, dismissal wiring, the reposition observer
    // (which also re-anchors on the in-place content refresh in render()), and
    // the anchored-vs-sheet decision.
    requestAnimationFrame(() => {
      const dropdown = /** @type {HTMLElement|null} */(this.querySelector('.strategy-dropdown'));
      const button = /** @type {HTMLElement|null} */(this.querySelector('.strategy-selector-button'));
      if (!dropdown || !button) return;
      dropdown.setAttribute('data-strategy-selector', 'true');
      this._liveDropdown = dropdown;
      this._popupRelease = presentPopup({
        surface: dropdown,
        anchor: button,
        id: 'strategy-selector',
        onClose: () => this.closeDropdown(),
        align: 'left',
        gap: 8,
        insideSelectors: ['strategy-selector', '.strategy-dropdown[data-strategy-selector="true"]'],
      });
    });
  }

  /** @private */
  closeDropdown() {
    if (this._dropdownOpen) {
      this._dropdownOpen = false;
      // Release tears down the surface, scrim, observer and dismissal wiring.
      if (this._popupRelease) {
        this._popupRelease();
        this._popupRelease = null;
      }
      this._liveDropdown = null;
      // Just update button state without full re-render to avoid focus disruption
      const button = this.querySelector('.strategy-selector-button');
      if (button) {
        button.classList.remove('open');
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
    return strategy ? strategy.manifest.name : 'Select Strategy';
  }

  /**
   * Generate the dropdown menu content
   * @returns {string} HTML string for the dropdown menu items
   * @private
   */
  generateDropdownContent() {
    if (this._strategies.length === 0) {
      return `
                <li class="strategy-item unavailable">
                    <p class="strategy-item-description">No strategies available</p>
                </li>
            `;
    }

    return this._strategies.map(({ id, manifest }) => {
      const isActive = id === this._currentStrategyId;
      const colorStyle = manifest.color ? `style="--strategy-color: ${manifest.color}"` : '';

      const iconHtml = manifest.icon
        ? `<span class="strategy-item-icon ${manifest.icon}" aria-hidden="true"></span>`
        : '';

      return `
                <li class="strategy-item ${isActive ? 'active' : ''}" data-strategy-id="${id}" ${colorStyle}>
                    <header class="strategy-item-header">
                        <span class="strategy-item-label">
                            ${iconHtml}
                            <span class="strategy-item-name">${manifest.name}</span>
                        </span>
                        ${isActive ? '<span class="strategy-check">&#10003;</span>' : ''}
                    </header>
                    <p class="strategy-item-description">${manifest.description}</p>
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
    const colorStyle = strategyColor ? `style="--strategy-color: ${strategyColor}"` : '';
    const hasColorAttr = strategyColor ? 'data-has-color="true"' : '';

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
    const liveDropdown = this._liveDropdown;
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
      ? `<nav class="dropdown-menu strategy-dropdown show" id="strategy-dropdown"><menu>${dropdownContent}</menu></nav>`
      : '';

    const buttonIconHtml = strategyIcon
      ? `<span class="strategy-icon ${strategyIcon}" aria-hidden="true"></span>`
      : '';

    this.innerHTML = `
            <button class="strategy-selector-button input-ctrl-btn ${this._dropdownOpen ? 'open' : ''}" id="strategy-button" tabindex="-1" title="Select Strategy" ${colorStyle} ${hasColorAttr}>
                ${buttonIconHtml}
                <span class="strategy-name">${strategyName}</span>
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
    button.classList.toggle('open', this._dropdownOpen);
  }

  /**
   * Wire click handlers on the strategy items under `root`.
   * @param {ParentNode} root - Element containing the `.strategy-item` nodes.
   * @private
   */
  _attachItemListeners(root) {
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
