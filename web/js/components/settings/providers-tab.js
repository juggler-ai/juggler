//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   https://juggler.studio
//
//   This program is free software: you can redistribute it and/or modify it under the terms of
//   the GNU Affero General Public License as published by the Free Software Foundation, either
//   version 3 of the License, or (at your option) any later version. This program is distributed
//   in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
//   warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the LICENSE file or
//   <https://www.gnu.org/licenses/agpl-3.0.html> for full terms.

import wsService from '../../services/websocket.js';
import providersCache from '../../services/providers-cache.js';
import {
  accountsList,
  accountsDiscover,
  accountsTypes,
  accountsAddCandidate,
} from '../../services/ops-api.js';
import { showAlert } from '../modal-dialog.js';
import { t } from '../../../sdk/lib/i18n.js';
import { errorText } from '../../../sdk/lib/error-utils.js';
import { buildModelVisibilityRow } from './model-visibility-row.js';
import { buildAccountCard } from './account-card.js';
import { accountKind } from './account-controls.js';
import { buildAddPanel } from './account-add-panel.js';

/**
 * "Providers" tab: the user's provider accounts, and under them the way to add
 * one.
 *
 * - **Accounts**: one card per account (account-card.js). An account is a
 *   registered provider whose name is the account id, and each is its own group
 *   in the model menu, so a conversation picks its account by picking a model.
 *   A type with no account has no card; it is reached through Add an account.
 * - **Add an account**: always open (account-add-panel.js) — a grid of the
 *   types, then the type's form. The candidates — a default account the user
 *   removed, an endpoint custom-providers.json had switched off, a further
 *   login found on disk — are tiles in that grid, added with one pick.
 *
 * The list comes from the `accounts` ops, and only from them: the server alone
 * decides what is an account. Every op answers with the whole list, and the
 * page is brought into line with it in place: cards are added, removed and
 * updated individually, and nothing a save touches moves anything else on the
 * page. A list fetched before an op answered is older than that answer, so it
 * is dropped.
 *
 * Seeded from the shared loadConfig() fetch. `updateAllButtons` is also invoked
 * by the shell's close() after its panel-wide secret-input sweep.
 */
export class ProvidersTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope and
   *   the owner of loadConfig(), which this tab calls to re-sync after a save).
   */
  constructor(host) {
    /** @type {any} @private */
    this.host = host;
    /** @type {any} @private */
    this.config = {};
    /** @type {any[]} @private */
    this.providers = [];
    /** @type {import('../../services/ops-api.js').AccountList|null} @private - The list, once it has arrived. */
    this.accountList = null;
    /** @type {import('../../services/ops-api.js').AccountType[]} @private */
    this.types = [];
    /** @type {Map<string, ReturnType<typeof buildAccountCard> & {kind: string}>} @private */
    this.cards = new Map();
    /** @type {{accounts: HTMLElement, empty: HTMLElement}|null} @private */
    this.sections = null;
    /** @type {import('./account-add-panel.js').AddPanel|null} @private - The add panel, once drawn. */
    this.addPanel = null;
    // One per drawn model list: writes a freshly published catalogue onto the
    // controls already on screen. Keyed by provider name, dropped on a redraw.
    /** @type {Map<string, (models: any[]) => void>} @private */
    this._modelRowUpdaters = new Map();

    // A deep link (revealModel) can arrive before the panel's config load has
    // drawn anything, so it waits on the first draw and the list that follows.
    /** @type {() => void} @private */
    this._markFieldsRendered = () => {};
    /** @type {Promise<void>} @private */
    this._fieldsRendered = new Promise((resolve) => { this._markFieldsRendered = resolve; });
    /** @type {Promise<void>} @private */
    this._accountsRefreshed = Promise.resolve();
    /** @type {number} @private - Counts the lists applied, so a fetch can tell it was overtaken. */
    this._listGeneration = 0;
    /** @type {Map<string, Promise<void>>} @private - The fetches in flight, by kind, so one is never asked for twice at once. */
    this._inFlight = new Map();

    // Hidden models and per-model limits are global settings, so another window
    // can change them, and the server folds both into the catalogue it
    // republishes. That republication is how the change arrives.
    /** @type {(() => void)|null} @private - Drops the providers-update subscription; null while not taken. */
    this._providersUpdateOff = null;
    this.connect();
  }

  /** Follow the published catalogue. Idempotent; taken again after dispose(). */
  connect() {
    if (this._providersUpdateOff) return;
    this._providersUpdateOff = wsService.on('providers-update', (providers) => {
      if (!Array.isArray(providers)) return;
      for (const provider of providers) {
        if (!provider || !provider.name) continue;
        const update = this._modelRowUpdaters.get(provider.name);
        if (update) {
          update(Array.isArray(provider.modelsWithContext) ? provider.modelsWithContext : []);
          continue;
        }
        // An account whose models arrived after its card was drawn — one just
        // added — gets its list now.
        const card = this.cards.get(provider.name);
        if (card && Array.isArray(provider.modelsWithContext) && provider.modelsWithContext.length) {
          this._replaceProvider(provider);
          card.redrawModels();
        }
      }
    });
  }

  /**
   * Tab became visible: pick up accounts added or removed since it was drawn,
   * and look again for logins on this machine.
   */
  show() {
    this._refreshAll();
  }

  /** Panel closed: an abandoned add form must not be there on reopen. */
  close() {
    this.addPanel?.reset();
  }

  /** Element disconnected: drop the providers-update subscription and what the cards hold. */
  dispose() {
    this._providersUpdateOff?.();
    this._providersUpdateOff = null;
    for (const card of this.cards.values()) card.dispose();
  }

  /**
   * Receive the shared loadConfig() payload: store config and providers, (on a
   * full render) draw the tab, and otherwise bring the drawn cards into line.
   * @param {{config: object, providers: any[]}} data
   * @param {boolean} renderFields
   */
  onConfigLoaded(data, renderFields) {
    this.config = data.config;
    this.providers = data.providers;
    if (renderFields) this.renderProviderFields();
    else this._syncCards();
    this.updateAllButtons();
  }

  /**
   * Draw the tab from what is in hand, and ask for the account list.
   */
  renderProviderFields() {
    const container = this.host.querySelector('#provider-fields-container');
    if (!container) return;
    container.innerHTML = '';
    for (const card of this.cards.values()) card.dispose();
    this.cards.clear();
    this._modelRowUpdaters.clear();
    this.addPanel = null;

    const heading = (/** @type {string} */ text) => {
      const el = document.createElement('div');
      el.className = 'settings-section-heading caps-label-lg';
      el.textContent = text;
      return el;
    };
    const note = (/** @type {string} */ text) => {
      const el = document.createElement('p');
      el.className = 'settings-description';
      el.textContent = text;
      return el;
    };

    const accounts = document.createElement('div');
    accounts.className = 'account-list';
    const empty = document.createElement('div');
    empty.className = 'account-empty';
    empty.textContent = t('No accounts yet. Add one below.');

    this.addPanel = buildAddPanel({
      types: () => this.types,
      providerFor: (name) => this._providerFor(name),
      accounts: () => this._accounts(),
      candidates: () => this.accountList?.candidates || [],
      onAdded: async (list) => {
        await this.host.loadConfig?.(false);
        this._applyList(list);
      },
      addCandidate: (key) => this._addCandidate(key),
    });
    const add = document.createElement('section');
    add.className = 'account-add-section';
    add.append(
      heading(t('Add an account')),
      note(t('Pick what kind of account to set up. Logins already on this machine are listed too, ready to add with one click.')),
      this.addPanel.element,
    );

    container.append(
      heading(t('Accounts')),
      note(t('Each account is its own group in the model menu, so a conversation uses the account whose model you pick.')),
      accounts,
      empty,
      add,
    );
    this.sections = { accounts, empty };

    this._syncCards();
    this._refreshAll();
    this._markFieldsRendered();
  }

  /**
   * Fetch the list, then look again for logins on this machine — which can
   * mean asking a CLI about each, so it follows the list rather than holding
   * it up.
   * @private
   */
  _refreshAll() {
    this._accountsRefreshed = this._refreshAccounts();
    this._accountsRefreshed.then(() => this._refreshAccounts(true));
  }

  /**
   * Open one model's row and focus its Context window field: the destination
   * of the "assumed" marker in the model picker and of a compaction notice
   * about an assumed window.
   * @param {string} providerName - Provider the model belongs to
   * @param {string} modelId - Model id, as the row's data-model carries it
   * @returns {Promise<boolean>} True if the field existed and now has focus
   */
  async revealModel(providerName, modelId) {
    await this._fieldsRendered;
    await this._accountsRefreshed;
    const card = this.cards.get(providerName)?.element;
    const details = /** @type {HTMLDetailsElement|null} */ (card?.querySelector('details.settings-model-visibility') ?? null);
    const row = Array.from(details ? details.querySelectorAll('.settings-model-visibility-row') : [])
      .find((el) => /** @type {HTMLElement} */ (el).dataset.model === modelId);
    const field = /** @type {HTMLInputElement|null} */ (row?.querySelector('[data-limit="contextWindow"]') ?? null);
    if (!details || !row || !field) return false;
    details.open = true;
    // A filter left over from an earlier visit could be hiding the row.
    const filter = /** @type {HTMLInputElement|null} */ (details.querySelector('.settings-model-visibility-filter'));
    if (filter && filter.value) {
      filter.value = '';
      filter.dispatchEvent(new Event('input'));
    }
    row.scrollIntoView({ block: 'center' });
    field.focus();
    return true;
  }

  /**
   * Bring every key row into line with what is stored. The panel calls it on
   * close, after clearing the unsaved key fields.
   */
  updateAllButtons() {
    for (const card of this.cards.values()) card.refresh();
  }

  /**
   * The accounts to draw: none until the list has arrived.
   * @returns {any[]} The accounts, in order.
   * @private
   */
  _accounts() {
    return this.accountList?.accounts || [];
  }

  /**
   * The published status of a provider.
   * @param {string} name - The provider (account) id.
   * @returns {any} The status, or undefined.
   * @private
   */
  _providerFor(name) {
    return this.providers.find((p) => p.name === name);
  }

  /**
   * Swap a fresh status into the provider list.
   * @param {any} provider - The fresh status.
   * @private
   */
  _replaceProvider(provider) {
    const at = this.providers.findIndex((p) => p.name === provider.name);
    if (at === -1) this.providers = [...this.providers, provider];
    else this.providers = this.providers.map((p, i) => (i === at ? provider : p));
  }

  /**
   * Fetch the account list and bring the page into line with it. Called when
   * the tab is drawn and whenever it is shown again, which is how a change made
   * in another window arrives.
   * @param {boolean} [discover] - Look again for logins on this machine first.
   * @returns {Promise<void>} Settles once the list is drawn, or the fetch failed.
   * @private
   */
  _refreshAccounts(discover = false) {
    const kind = discover ? 'discover' : 'list';
    const pending = this._inFlight.get(kind);
    if (pending) return pending;
    const generation = this._listGeneration;
    const run = (async () => {
      try {
        const [list, types] = await Promise.all([
          discover ? accountsDiscover() : accountsList(),
          this.types.length ? Promise.resolve({ types: this.types }) : accountsTypes(),
        ]);
        if (Array.isArray(types?.types) && types.types !== this.types) {
          this.types = types.types;
          this.addPanel?.refresh();
        }
        // Overtaken by a list an op answered with since this was asked for.
        if (generation !== this._listGeneration) return;
        if (JSON.stringify(list) === JSON.stringify(this.accountList)) return;
        this._applyList(list);
      } catch (error) {
        console.error('[SettingsPanel] Could not list provider accounts:', error);
        if (!this.accountList && this.sections) {
          this.sections.empty.textContent = t('Couldn’t list the accounts. {error}', { error: errorText(error) });
          this.sections.empty.hidden = false;
        }
      } finally {
        this._inFlight.delete(kind);
      }
    })();
    this._inFlight.set(kind, run);
    return run;
  }

  /**
   * Take a list an op answered with as the truth, and redraw from it.
   * @param {any} list - The list.
   * @private
   */
  _applyList(list) {
    if (!list || !Array.isArray(list.accounts)) return;
    this._listGeneration++;
    if (this.sections) this.sections.empty.textContent = t('No accounts yet. Add one below.');
    this.accountList = {
      accounts: list.accounts,
      candidates: Array.isArray(list.candidates) ? list.candidates : [],
    };
    this._syncCards();
    this.addPanel?.refresh();
  }

  /**
   * Match the drawn cards to the accounts in hand: update the ones that stay,
   * take out the ones that went, add the new ones in their place. A card whose
   * kind changed — its provider registered, say — has its controls rebuilt.
   * @private
   */
  _syncCards() {
    const root = this.sections?.accounts;
    if (!root) return;
    const accounts = this._accounts();
    const live = new Set(accounts.map((a) => a.id));
    for (const [id, card] of this.cards) {
      if (live.has(id)) continue;
      card.dispose();
      card.element.remove();
      this.cards.delete(id);
      this._modelRowUpdaters.delete(id);
    }
    /** @type {Element|null} */
    let previous = null;
    for (const account of accounts) {
      let card = this.cards.get(account.id);
      const kind = accountKind(account, this._providerFor(account.id));
      if (!card) {
        card = { ...this._buildCard(account), kind };
        this.cards.set(account.id, card);
      } else if (card.kind !== kind) {
        card.update(account);
        card.kind = kind;
        card.redraw();
      } else {
        card.update(account);
      }
      // Moved only when out of place, so a card holding focus is left alone.
      /** @type {Element|null} */
      const expected = previous ? previous.nextElementSibling : root.firstElementChild;
      if (expected !== card.element) {
        if (previous) previous.after(card.element);
        else root.prepend(card.element);
      }
      previous = card.element;
    }
    if (this.sections) this.sections.empty.hidden = !this.accountList || accounts.length > 0;
  }

  /**
   * Build one account's card.
   * @param {any} account - The account.
   * @returns {ReturnType<typeof buildAccountCard>} The card.
   * @private
   */
  _buildCard(account) {
    return buildAccountCard(account, {
      providerFor: (id) => this._providerFor(id),
      config: () => this.config,
      modelRow: (provider) => {
        // A redraw that draws no list must leave no updater writing to the
        // one it replaced.
        this._modelRowUpdaters.delete(provider.name);
        return buildModelVisibilityRow(provider, (update) => {
          this._modelRowUpdaters.set(provider.name, update);
        });
      },
      recheck: (id) => this._recheck(id),
      setSignedIn: (id, available, hint) => {
        const provider = this._providerFor(id);
        if (provider) this._replaceProvider({ ...provider, available, authHint: hint, authHintMessage: null });
        this.cards.get(id)?.redraw();
        this._accountsRefreshed = this._refreshAccounts();
      },
      onSwitched: (providers) => {
        this.providers = providers;
        this._syncCards();
        for (const card of this.cards.values()) card.redraw();
        this._accountsRefreshed = this._refreshAccounts();
      },
      reloadConfig: () => this.host.loadConfig(false),
      applyList: (list) => this._applyList(list),
      reportError: (message) => { showAlert(message, t('Providers')); },
    });
  }

  /**
   * Ask the server to look at an account again, and redraw its card from the
   * list it answers with, which it computed after being asked. The same list
   * reaches every model selector as a push, so newly available models appear
   * there without this tab's help.
   * @param {string} id - The account id.
   * @private
   */
  async _recheck(id) {
    const fresh = (await providersCache.refresh()).find((p) => p.name === id);
    if (fresh) this._replaceProvider(fresh);
    this.cards.get(id)?.redraw();
    this._accountsRefreshed = this._refreshAccounts();
  }

  /**
   * Add a login on offer, and redraw from the list the add answers with.
   * @param {string} key - The candidate's key.
   * @returns {Promise<void>} Settles once it is added, or the failure is reported.
   * @private
   */
  async _addCandidate(key) {
    try {
      const list = await accountsAddCandidate({ key });
      await this.host.loadConfig?.(false);
      this._applyList(list);
    } catch (error) {
      await showAlert(t('Couldn’t add it. {error}', { error: errorText(error) }), t('Providers'));
    }
  }
}
