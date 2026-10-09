//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import contextItemRegistry from '../registries/context-item-registry.js';
import strategyRegistry from '../registries/strategy-registry.js';
import commandRegistry from '../registries/command-registry.js';
import infoCardRegistry from '../registries/info-card-registry.js';
import pinboardItemRegistry from '../registries/pinboard-item-registry.js';
import fileViewerRegistry from '../registries/file-viewer-registry.js';
import hookRegistry from '../registries/hook-registry.js';
import { reloadRegistries, REGISTRIES_RELOADED } from '../registries/reload-registries.js';
import {
  fetchExtensions,
  fetchExtensionLocations,
  fetchDisabledPluginIds,
  fetchPluginAttribution,
} from '../services/extensions.js';
import { fetchJson, httpErrorText } from '../services/http.js';
import { showConfirm, showNotice } from './modal-dialog.js';
import { addFilePath } from '../utils/properties-panel-helpers.js';
import JugglerElement from './juggler-element.js';
import { renderMarkdown, looksLikeMarkdown } from '../../sdk/lib/markdown.js';
import { ExtensionSettingsEditor } from './settings/extensions-settings.js';
import { apiUrl } from '../utils/api-url.js';
import { getAppSession } from '../utils/app-session.js';

/**
 * @typedef {object} CapCard
 * @property {string} url - Served URL of the capability module
 * @property {'context-item'|'strategy'|'command'|'info-card'|'file-viewer'|'pinboard-item'|'hook'} itemType - Capability type
 * @property {string|null} id - Capability id (null if it failed to register)
 * @property {string} name - Display name
 * @property {string} description - Short description
 * @property {string} version - Capability version
 * @property {boolean} registered - Whether the capability loaded into a registry
 * @property {string|null} failed - Load error message, if the module failed to import
 * @property {boolean} disabled - Effective disabled state (own id or inherited from extension)
 * @property {boolean} inherited - Disabled solely because the whole extension is off
 * @property {string|null} path - Absolute on-disk path of the module file, or null when it has no revealable file (embedded builtin)
 */

/**
 * @typedef {object} ExtCard
 * @property {import('../services/extensions.js').ExtensionManifest} manifest - Extension manifest
 * @property {string} source - Provenance: 'builtin' | 'user'
 * @property {string|null} error - Manifest parse/validate error, if any
 * @property {string|null} extId - Extension id
 * @property {boolean} extDisabled - Whether the whole extension is disabled
 * @property {CapCard[]} caps - Bundled capabilities
 * @property {string|null} manifestPath - Absolute on-disk path of juggler.extension.json, or null when embedded (no revealable file)
 */

/** Capability-type → response key + display type. */
const CAP_TYPES = /** @type {const} */ ([
  ['contextItems', 'context-item'],
  ['strategies', 'strategy'],
  ['commands', 'command'],
  ['infoCards', 'info-card'],
  ['fileViewers', 'file-viewer'],
  ['pinboardItems', 'pinboard-item'],
  ['hooks', 'hook'],
]);

/**
 * Every capability registry, with the itemType it holds. Deliberately one list:
 * the catalog sweeps the registries three times over (ids, entries by URL, load
 * failures), and keeping a separate list per sweep is how `fileViewerRegistry`
 * came to be in two of them and not the third — a file viewer that failed to
 * import then had neither an id nor an error, and its row vanished silently.
 */
const ALL_REGISTRIES = /** @type {ReadonlyArray<readonly [any, string]>} */ ([
  [contextItemRegistry, 'context-item'],
  [strategyRegistry, 'strategy'],
  [commandRegistry, 'command'],
  [infoCardRegistry, 'info-card'],
  [fileViewerRegistry, 'file-viewer'],
  [pinboardItemRegistry, 'pinboard-item'],
  [hookRegistry, 'hook'],
]);

/** Human labels for an extension's provenance. */
const SOURCE_LABELS = /** @type {Record<string, string>} */ ({
  builtin: 'built-in',
  user: 'user',
});

/**
 * Plain-language explanation for each known capability/extension permission.
 * Permissions are a *declaration* of the system access an extension's code uses
 * — surfaced with these descriptions so the badges aren't cryptic. They are
 * disclosure to inform the user's trust decision, not a sandbox the host
 * enforces (extensions run with full app privileges).
 */
const PERMISSION_INFO = /** @type {Record<string, string>} */ ({
  'filesystem.read': 'Read files and directories on your computer',
  'filesystem.write': 'Create, modify, and delete files on your computer',
  'shell.exec': 'Run shell commands on your computer',
  'web.fetch': 'Fetch content from the web over the network',
  'llm.generate': 'Generate text with a language model (uses your provider credits)',
});

/** Capability itemType → tree sub-heading, in display order under an extension. */
const CAP_SECTIONS = /** @type {ReadonlyArray<readonly [string, string]>} */ ([
  ['strategy', 'Strategies'],
  ['context-item', 'Context Items'],
  ['command', 'Commands'],
  ['info-card', 'Info Cards'],
  ['file-viewer', 'File Viewers'],
  ['pinboard-item', 'Pinboard Items'],
  ['hook', 'Hooks'],
]);

/**
 * Tree key for the group holding switched-off ids nothing installed provides.
 * Not an extension — it owns no manifest and can't be toggled as a unit — but it
 * sits at the same level so the ids inside it get ordinary capability rows.
 */
const ORPHAN_KEY = 'ext:\u0000not-installed';

/** Stand-in card for the orphan group, so orphan rows share the capability row shape. */
const ORPHAN_CARD = /** @type {ExtCard} */ (/** @type {unknown} */ ({
  manifest: null, source: '', error: null, extId: null,
  extDisabled: false, caps: [], manifestPath: null,
}));

/** Human label for a capability itemType (singular, title-cased). */
const TYPE_LABELS = /** @type {Record<string, string>} */ ({
  'context-item': 'Context Item',
  strategy: 'Strategy',
  command: 'Command',
  'info-card': 'Info Card',
  'file-viewer': 'File Viewer',
  'pinboard-item': 'Pinboard Item',
  hook: 'Hook',
});

/**
 * Compute the next disabled-id list after toggling one id on or off. Adding is
 * idempotent (Set semantics); removing clears the id. The id may be a capability
 * id or an extension id — both live in the same flat disabled list.
 * @param {string[]} current - Current disabled ids
 * @param {string} targetId - Capability or extension id being toggled
 * @param {boolean} shouldEnable - true to enable (remove), false to disable (add)
 * @returns {string[]} The next disabled-id list
 */
export function computeNextDisabled(current, targetId, shouldEnable) {
  const set = new Set(current);
  if (shouldEnable) set.delete(targetId);
  else set.add(targetId);
  return [...set];
}

/**
 * The disabled ids that match nothing currently installed.
 *
 * The disabled list is a flat set of bare ids, and a row can only offer to
 * re-enable an id it can still see: a capability whose module produced no
 * registry entry has no id on its card, so its own row cannot reach the config
 * entry holding it off. These ids get rows of their own instead, in the tree's
 * `Not installed` group — without them, switching such a capability off is a
 * one-way door out of the UI, recoverable only by editing config.json by hand.
 *
 * An id is orphaned when nothing claims it: no installed extension, no
 * capability on a card, and no registry. That covers an extension that has been
 * uninstalled, and a capability that stopped loading while switched off.
 *
 * `knownIds` is what keeps the group honest. Not every installed capability
 * appears on a card — a user slash command is synthesised rather than served
 * from an extension, so no card lists it and it has a manager of its own. Such
 * an id is installed and reachable, and filing it here would be the catalog
 * reporting its own blind spot as the user's problem.
 * @param {ExtCard[]} cards - The built extension cards
 * @param {Set<string>|string[]} disabledIds - Disabled ids from config
 * @param {Set<string>} [knownIds] - Ids the registries hold, on a card or not
 * @returns {string[]} Orphaned ids, sorted, so the render order is stable
 */
export function collectOrphanedDisabled(cards, disabledIds, knownIds = new Set()) {
  const live = new Set(knownIds);
  for (const card of cards) {
    if (card.extId) live.add(card.extId);
    for (const cap of card.caps) {
      if (cap.id) live.add(cap.id);
    }
  }
  return [...disabledIds].filter((id) => !live.has(id)).sort();
}

/**
 * @typedef {object} PluginAttribution
 * @property {string} [extension] - Id of the extension that provided the capability
 * @property {string} [file] - Base name of the capability's module file
 * @property {string} [type] - Capability type ('context-item', 'strategy', …)
 * @property {string} [name] - Human label the capability's manifest carried
 */

/**
 * Find what the config remembers about the capability a served URL points at.
 *
 * Matched on extension id, capability type and module BASE NAME — never on the
 * served URL. A user extension's URL carries an epoch segment that changes every
 * time extensions are rescanned, so a stored URL would stop matching as soon as
 * anything was installed. Within one extension and one type, the base name is
 * unique, which is all this needs; requiring the extension to match as well
 * stops another extension's identically-named file from claiming the id.
 * @param {Record<string, PluginAttribution>} attribution - Config's id → description map
 * @param {string|null} extId - Id of the extension declaring this URL
 * @param {string} itemType - Capability type of the declaring slot
 * @param {string} url - Served URL of the capability module
 * @returns {{id: string, entry: PluginAttribution}|null} The remembered id and description
 */
function findAttribution(attribution, extId, itemType, url) {
  if (!extId) return null;
  const file = url.split('/').pop();
  if (!file) return null;
  for (const [id, entry] of Object.entries(attribution)) {
    if (entry?.extension === extId && entry.type === itemType && entry.file === file) {
      return { id, entry };
    }
  }
  return null;
}

/**
 * Merge the extension catalog (metadata + served URLs) with per-capability
 * registry state (registered / disabled / failed) into renderable card models.
 * Pure: no DOM, no fetch — so it is unit-testable in isolation.
 * @param {import('../services/extensions.js').Extension[]} extensions - From fetchExtensions()
 * @param {Map<string, {id: string, manifest: any, itemType: string, disabled: boolean}>} entriesByPath - Registry entries keyed by served URL
 * @param {Map<string, string>} failedByPath - Load errors keyed by served URL
 * @param {Set<string>} disabledIds - Disabled capability/extension ids from config
 * @param {Record<string, PluginAttribution>} [attribution] - What each switched-off id was, from config
 * @returns {ExtCard[]} One card per extension
 */
export function buildExtensionCards(extensions, entriesByPath, failedByPath, disabledIds, attribution = {}) {
  return extensions.map((ext) => {
    const extId = ext.manifest?.id ?? null;
    const extDisabled = !!extId && disabledIds.has(extId);

    /** @type {CapCard[]} */
    const caps = [];
    for (const [key, itemType] of CAP_TYPES) {
      const urls = ext.capabilities?.[key] || [];
      for (const url of urls) {
        const reg = entriesByPath.get(url);
        const failed = failedByPath.get(url) ?? null;
        // With no registry entry the module is not loading, so its id — which
        // lives inside that module — is unknowable from here. What the config
        // remembered when the capability was switched off is the only way back.
        const remembered = reg ? null : findAttribution(attribution, extId, itemType, url);
        const capId = reg?.id ?? remembered?.id ?? null;
        const selfDisabled = !!capId && disabledIds.has(capId);
        caps.push({
          url,
          itemType: /** @type {'context-item'|'strategy'|'command'|'info-card'|'file-viewer'|'pinboard-item'|'hook'} */ (itemType),
          id: capId,
          name: reg?.manifest?.name || remembered?.entry.name || url.split('/').pop() || url,
          description: reg?.manifest?.description || '',
          version: reg?.manifest?.version || '',
          registered: !!reg,
          failed,
          disabled: selfDisabled || extDisabled,
          inherited: extDisabled && !selfDisabled,
          path: ext.files?.[url] ?? null,
        });
      }
    }

    return {
      manifest: ext.manifest,
      source: ext.source,
      error: ext.error || null,
      extId,
      extDisabled,
      caps,
      manifestPath: ext.manifestPath ?? null,
    };
  });
}

/**
 * PluginCatalog — the Extensions view.
 *
 * Shows one card per installed extension (built-in core, user, and project),
 * with its metadata, bundled capabilities, and failed-load diagnostics. Each
 * extension and each capability has an enable/disable toggle; toggling writes
 * the merged disabled-id list to the config endpoint, then re-initialises the
 * registries in place (the same path as plugin hot reload) so the change takes
 * effect without a reload.
 * @class
 * @augments JugglerElement
 */
class PluginCatalog extends JugglerElement {
  constructor() {
    super();

    /** @type {ExtCard[]} */
    this._cards = [];

    /** @type {Set<string>} */
    this._disabledIds = new Set();

    /**
     * What the config remembers about each switched-off id, so a row can still
     * name itself once its module stops loading.
     * @type {Record<string, PluginAttribution>}
     */
    this._attribution = {};

    /** @type {Array<{path: string, error: string}>} */
    this._failedModules = [];

    /**
     * Disabled ids no installed extension or loaded capability claims. Kept so
     * a capability that stopped loading while switched off can still be
     * switched back on (see {@link collectOrphanedDisabled}).
     * @type {string[]}
     */
    this._orphanedDisabled = [];

    /**
     * Guards against overlapping toggles re-entering the re-init path.
     * @type {boolean}
     */
    this._busy = false;

    /**
     * Key of the currently selected sidebar entry (`ext:<id>` for an extension,
     * `cap:<itemType>:<id|url>` for a capability), or null before first render.
     * @type {string|null}
     */
    this._selectedKey = null;

    /**
     * The left sidebar scroll container, retained so a toggle can rebuild its
     * entries in place (preserving scroll) instead of tearing down the view.
     * @type {HTMLElement|null}
     */
    this._sidebar = null;

    /**
     * The right detail pane, retained so selecting an entry swaps only its
     * contents (the sidebar and its scroll position stay put).
     * @type {HTMLElement|null}
     */
    this._detailPanel = null;

    /**
     * The first load+render, retained so an outside caller (revealCapability)
     * can wait for the catalog to be ready instead of racing it.
     * @type {Promise<void>|null}
     */
    this._ready = null;

    /**
     * Keys of extension tree nodes whose children are expanded. `null` means
     * "not yet initialised" — the first render expands every extension so the
     * tree opens fully revealed; thereafter the user's collapses are remembered.
     * @type {Set<string>|null}
     */
    this._expanded = null;

  }

  /** Called when the component is inserted into the DOM. */
  connectedCallback() {
    this.classList.add('plugin-catalog');
    this._ready = this._init();
    // Re-read the catalog after any registry rebuild — a watched file changed,
    // another client toggled a capability, or Reload was pressed. Without it an
    // open catalog keeps showing the pre-reload cards. A reload triggered by
    // this catalog's own toggle already refreshes the cards; _busy marks that
    // window, so skip the duplicate pass.
    this.onDocument(REGISTRIES_RELOADED, () => {
      if (this._busy) return;
      this._loadData().then(() => this.render()).catch((err) => {
        console.warn('[PluginCatalog] Could not refresh after reload:', err);
      });
    });
  }

  /**
   * Select one capability's entry from outside the catalog — the deep-link the
   * properties-panel header badge follows. Waits for the first load so a click
   * arriving while the catalog is still fetching still lands on the right row,
   * and scrolls the row into view since the target is usually well down the tree.
   * @param {string} itemType - Capability type, e.g. 'context-item'
   * @param {string} capId - The capability's registry id
   * @returns {Promise<boolean>} True when the capability was found and selected
   */
  async revealCapability(itemType, capId) {
    if (this._ready) await this._ready;
    const key = `cap:${itemType}:${capId}`;
    if (!this._buildEntries().some((e) => e.key === key)) return false;
    this._select(key);
    const row = /** @type {HTMLElement|null} */ (this._sidebar?.querySelector('.plugin-tree-row.selected') ?? null);
    row?.scrollIntoView?.({ block: 'nearest' });
    return true;
  }

  /**
   * Load data then render. Kept separate from connectedCallback so tests can
   * drive it without mounting.
   * @private
   * @returns {Promise<void>}
   */
  async _init() {
    await this._loadData();
    this.render();
  }

  /**
   * Assemble the card models: extension metadata from the catalog endpoint,
   * cross-referenced with the three registries' loaded/disabled/failed state.
   * @private
   * @returns {Promise<void>}
   */
  async _loadData() {
    const extensions = await fetchExtensions();
    this._disabledIds = await this._fetchConfig();
    this._attribution = await fetchPluginAttribution();

    const entriesByPath = this._collectRegistryEntries();
    const failedByPath = this._collectFailed();

    this._cards = buildExtensionCards(
      extensions, entriesByPath, failedByPath, this._disabledIds, this._attribution);
    this._failedModules = [...failedByPath.entries()].map(([path, error]) => ({ path, error }));
    this._orphanedDisabled = collectOrphanedDisabled(
      this._cards, this._disabledIds, this._collectRegistryIds());

    // A capability its extension declares that neither registered nor failed,
    // and that the config remembers nothing about, is a row we can only label
    // with its filename — so say which. Silently accepting it would make a
    // registry that loses entries indistinguishable from an extension that
    // never shipped them, and that is the shape of a real fault.
    const missing = this._cards.flatMap((c) => c.caps.filter((cap) => !cap.id && !cap.failed));
    if (missing.length > 0) {
      console.warn('[PluginCatalog] Declared but not registered, so unidentifiable:',
        missing.map((cap) => cap.url));
    }
  }

  /**
   * What we can say about each id being switched off, for the config to remember
   * once the module that defines it stops loading. Gathered from the live rows,
   * which is the only moment any of it is knowable.
   * @param {string[]} ids - The ids being switched off
   * @returns {Record<string, PluginAttribution>} Description keyed by capability id
   * @private
   */
  _attributionFor(ids) {
    /** @type {Record<string, PluginAttribution>} */
    const hints = {};
    const wanted = new Set(ids);
    for (const card of this._cards) {
      for (const cap of card.caps) {
        if (!cap.id || !wanted.has(cap.id)) continue;
        hints[cap.id] = {
          extension: card.extId ?? undefined,
          file: cap.url.split('/').pop(),
          type: cap.itemType,
          name: cap.name,
        };
      }
    }
    return hints;
  }

  /**
   * Build a served-URL → registry-entry map across all three registries,
   * including disabled capabilities (still loaded, still have a manifest).
   * @private
   * @returns {Map<string, {id: string, manifest: any, itemType: string, disabled: boolean}>} Registry entries keyed by served URL
   */
  _collectRegistryEntries() {
    /** @type {Map<string, {id: string, manifest: any, itemType: string, disabled: boolean}>} */
    const byPath = new Map();
    for (const [reg, itemType] of ALL_REGISTRIES) {
      for (const m of reg.getCatalogManifests()) {
        if (m.modulePath) {
          byPath.set(m.modulePath, { id: m.id, manifest: m.manifest, itemType, disabled: m.disabled });
        }
      }
    }
    return byPath;
  }

  /**
   * Every capability id the registries hold, enabled or disabled, whether or not
   * it has a served URL to hang a row on. Used only to decide what is genuinely
   * not installed — see {@link collectOrphanedDisabled}.
   * @private
   * @returns {Set<string>} Known capability ids across all registries
   */
  _collectRegistryIds() {
    const ids = new Set();
    for (const [reg] of ALL_REGISTRIES) {
      for (const m of reg.getCatalogManifests()) ids.add(m.id);
    }
    return ids;
  }

  /**
   * Collect failed module loads (served URL → error) across all registries.
   * @private
   * @returns {Map<string, string>} Load errors keyed by served URL
   */
  _collectFailed() {
    /** @type {Map<string, string>} */
    const failed = new Map();
    for (const [reg] of ALL_REGISTRIES) {
      for (const { path, error } of reg.getFailedModules()) {
        failed.set(path, error);
      }
    }
    return failed;
  }

  /**
   * The set of ids switched off for this project, through the same accessor the
   * registries use — so the rows can never disagree with the registries about
   * what is off, and a rebuild reads the config once between them.
   * @private
   * @returns {Promise<Set<string>>} The disabled-id set
   */
  async _fetchConfig() {
    return await fetchDisabledPluginIds() || new Set();
  }

  /**
   * Persist the set of ids that should be switched off. The server splits that
   * across its stored disabled/enabled lists, so the UI states an outcome and
   * never has to know how a default-off plugin is countermanded.
   * @param {string[]} disabledList - The ids to switch off
   * @param {Record<string, PluginAttribution>} [attribution] - What those ids are, for the config to remember
   * @private
   * @returns {Promise<void>}
   */
  async _persist(disabledList, attribution = {}) {
    await fetchJson(apiUrl('/config/plugins'), {
      method: 'PUT',
      body: { disabled: disabledList, attribution },
      errorPrefix: 'Failed to save extension config',
    });
  }

  /**
   * Fetch authoritative server activity before a registry-affecting toggle.
   * @private
   * @returns {Promise<{active: boolean, conversationIds: string[]}>} Active flag and active conversation IDs
   */
  async _fetchActiveHealth() {
    const data = await fetchJson(apiUrl('/health/active'), { fallback: null });
    if (!data) return { active: false, conversationIds: [] };
    return {
      active: !!data.active,
      conversationIds: Array.isArray(data.conversationIds) ? data.conversationIds : [],
    };
  }

  /**
   * If any conversation has a live turn, ask the operator before cancelling all
   * local active conversations and applying the extension-set change.
   * @private
   * @returns {Promise<boolean>} true when it is safe to persist the toggle
   */
  async _quiesceBeforeToggle() {
    const health = await this._fetchActiveHealth();
    if (!health.active) return true;

    const count = health.conversationIds.length || 1;
    const confirmed = await showConfirm(
      `${count} conversation${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} running. ` +
      'Changing extensions will stop them so the capability set can be safely rebuilt.',
      'Stop conversations and apply extension change?',
      { confirmText: 'Stop & apply', cancelText: 'Cancel', danger: true }
    );
    if (!confirmed) return false;

    const session = getAppSession();
    if (session?.cancelAllActiveConversations) {
      await session.cancelAllActiveConversations(health.conversationIds);
    }

    // Worker truth is authoritative. If another client started work, or a local
    // conversation was not loaded here, do not persist into a still-active engine.
    const after = await this._fetchActiveHealth();
    if (after.active) {
      throw new Error('Could not stop all active conversations; extension change was not applied.');
    }
    return true;
  }

  /**
   * Re-initialise the three registries from the (now updated) config — the same
   * teardown/rebuild used by plugin hot reload, so a toggle applies live. Shared
   * `reloadRegistries()` also announces the change (REGISTRIES_RELOADED) so the
   * strategy menu and other registry-backed UI refresh.
   * @private
   * @returns {Promise<void>}
   */
  async _reinitRegistries() {
    await reloadRegistries();
  }

  /**
   * Toggle one-or-more capability/extension ids on/off together: persist,
   * re-init registries, reload data, refresh the cards in place. Multiple ids
   * travel together so a strategy and the context items it owns enable/disable
   * as a unit. Overlapping toggles are ignored while one is in flight so the
   * live re-init isn't re-entered.
   * @param {string|string[]} target - Capability/extension id, or a set of ids to toggle together
   * @param {boolean} shouldEnable - true to enable, false to disable
   * @private
   * @returns {Promise<void>}
   */
  async _toggle(target, shouldEnable) {
    const ids = (Array.isArray(target) ? target : [target]).filter(Boolean);
    if (this._busy || ids.length === 0) return;
    this._busy = true;
    try {
      let next = [...this._disabledIds];
      for (const id of ids) {
        next = computeNextDisabled(next, id, shouldEnable);
      }
      // Describe what is being switched off while its module is still loaded —
      // afterwards its id is only a string in a list, and nothing can say what
      // it was. Switching ON needs no hint: the server prunes the entry with it.
      const hints = shouldEnable ? {} : this._attributionFor(ids);
      if (!await this._quiesceBeforeToggle()) return;
      await this._persist(next, hints);
      await this._reinitRegistries();
      await this._loadData();
      this._refreshCards();
    } catch (err) {
      console.error('[PluginCatalog] Failed to apply toggle:', err);
      showNotice(`Couldn't apply the extension change. ${httpErrorText(err)}`);
    } finally {
      this._busy = false;
    }
  }

  /** Render the catalog as a master/detail view. */
  render() {
    this.innerHTML = '';
    this.appendChild(this._renderHeader());

    this._refreshBanners();

    const entries = this._buildEntries();
    if (entries.length === 0) {
      this.appendChild(this._createElement('div', 'catalog-empty', 'No extensions installed'));
      return;
    }

    // Default to (or recover) a valid selection.
    const firstEntry = entries[0];
    if (firstEntry && !entries.some((e) => e.key === this._selectedKey)) {
      this._selectedKey = firstEntry.key;
    }

    const main = this._createElement('div', 'catalog-main');
    this._sidebar = this._renderSidebar(entries);
    this._detailPanel = this._createElement('div', 'catalog-detail-panel');
    main.appendChild(this._sidebar);
    main.appendChild(this._detailPanel);
    this.appendChild(main);
    this._renderDetailInto(entries);

    // Install-location paths (async footer).
    this._renderLocations();
  }

  /**
   * Build the catalog header: title, extension/capability counts, and a short
   * explanation of what the view is for.
   * @returns {HTMLElement} The header element
   * @private
   */
  _renderHeader() {
    const header = this._createElement('header', 'catalog-header');
    const left = this._createElement('div', 'catalog-header-left');
    left.appendChild(this._createElement('h2', 'catalog-title', 'Extensions'));
    const extCount = this._cards.length;
    // Counts what the tree shows, so the subtitle can't claim capabilities the
    // list omits (see _buildEntries).
    const capCount = this._buildEntries().filter((e) => e.kind === 'cap').length;
    left.appendChild(this._createElement('div', 'catalog-subtitle',
      `${extCount} extension${extCount === 1 ? '' : 's'}, ${capCount} capabilities`));
    header.appendChild(left);

    const right = this._createElement('div', 'catalog-header-right');
    right.appendChild(this._createElement('p', 'catalog-explanation',
      'Add your own extensions to ~/.juggler/extensions.'));
    right.appendChild(this._renderReloadButton());
    header.appendChild(right);
    return header;
  }

  /**
   * Build the explicit Reload control. Edited extensions reload on their own
   * when the watcher sees the write; this is the deterministic version for
   * anything it can't see (a change behind a symlink it never registered, a
   * file restored from outside the tree).
   * @returns {HTMLElement} The reload button
   * @private
   */
  _renderReloadButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-ghost catalog-reload';
    button.textContent = 'Reload extensions';
    button.title = 'Re-import every extension from disk';
    button.disabled = this._busy;
    button.addEventListener('click', () => { void this._requestReload(button); });
    return button;
  }

  /**
   * Ask the SERVER to reload extensions, rather than calling reloadRegistries()
   * here. The engine worker keeps its own copy of every capability module, so a
   * viewer-local reload would leave tools running the previous code; the
   * server's plugin-changed broadcast reaches both realms, and its epoch bump is
   * what actually forces the edited files to be re-imported. Everything after
   * the POST therefore happens on the broadcast path, not here.
   * @param {HTMLButtonElement} button - The clicked button, held disabled for the round trip
   * @private
   * @returns {Promise<void>}
   */
  async _requestReload(button) {
    if (this._busy) return;
    // Only the button is held, not `_busy`: that flag suppresses the catalog's
    // reload listener (a toggle refreshes its own cards), and setting it here
    // would race the broadcast and swallow the very refresh this asked for.
    button.disabled = true;
    try {
      await fetchJson(apiUrl('/extensions/reload'), { method: 'POST' });
    } catch (err) {
      showNotice(`Couldn't reload extensions. ${httpErrorText(err)}`);
    } finally {
      button.disabled = false;
    }
  }

  /**
   * Flatten the card models into selectable sidebar entries: one per extension
   * and one per standalone capability. Each entry knows its owning extension
   * (`extKey`) and, for capabilities, its type section, so `_fillSidebar` can
   * render them as a tree. The flat order is extension-then-its-capabilities
   * so `entries[0]` is the first extension — a sensible default selection.
   *
   * Every capability the extension declares gets a row, and every switched-off
   * id gets a row — nothing the user can act on is ever left out of the tree.
   * A capability that FAILED to import keeps its row and reads `failed`; one the
   * registry never registered keeps its row and reads `unknown`, which is a
   * fault worth seeing rather than hiding. Ids switched off that nothing
   * installed provides are gathered under {@link ORPHAN_KEY} with ordinary,
   * clickable rows: the row IS the control bound to the id, so dropping it is
   * what makes switching something off a one-way door.
   * @returns {Array<{key: string, kind: 'extension'|'cap', extKey: string, section: string, label: string, card: ExtCard, cap?: CapCard, disabled: boolean, failed: boolean, status: string}>} One entry per extension and per shown capability
   * @private
   */
  _buildEntries() {
    /** @type {ReturnType<PluginCatalog['_buildEntries']>} */
    const entries = [];

    for (const card of this._cards) {
      const extKey = `ext:${card.extId || card.manifest?.name || 'extension'}`;
      entries.push({
        key: extKey,
        kind: 'extension',
        extKey,
        section: 'Extensions',
        label: card.manifest?.name || card.extId || 'Extension',
        card,
        disabled: card.extDisabled,
        failed: !!card.error,
        status: card.error ? 'error' : (card.extDisabled ? 'off' : ''),
      });

      for (const [itemType, section] of CAP_SECTIONS) {
        for (const cap of card.caps) {
          if (cap.itemType !== itemType) continue;
          entries.push({
            key: `cap:${itemType}:${cap.id || cap.url}`,
            kind: 'cap',
            extKey,
            section,
            label: cap.name,
            card,
            cap,
            disabled: cap.disabled,
            failed: !!cap.failed,
            status: cap.failed ? 'failed' : (cap.disabled ? 'off' : ''),
          });
        }
      }
    }

    for (const id of this._orphanedDisabled) {
      const was = this._attribution[id];
      entries.push({
        key: `cap:orphan:${id}`,
        kind: 'cap',
        extKey: ORPHAN_KEY,
        section: 'Switched off',
        label: was?.name || id,
        card: ORPHAN_CARD,
        cap: /** @type {CapCard} */ (/** @type {unknown} */ ({
          url: '', itemType: 'orphan', id, name: id, description: '', version: '',
          registered: false, failed: null, disabled: true, inherited: false, path: null,
        })),
        disabled: true,
        failed: false,
        status: 'off',
      });
    }
    return entries;
  }

  /**
   * Build the left sidebar: a scroll container filled with the extension tree.
   * @param {ReturnType<PluginCatalog['_buildEntries']>} entries - Sidebar entries
   * @returns {HTMLElement} The sidebar element
   * @private
   */
  _renderSidebar(entries) {
    const sidebar = this._createElement('div', 'catalog-sidebar');
    this._fillSidebar(sidebar, entries);
    return sidebar;
  }

  /**
   * Fill (or refill) the sidebar with the extension tree: each extension is a
   * top-level node, its capabilities nested beneath under per-type sub-headings
   * (Strategies, Context Items, Commands), shown only while the node is
   * expanded. Replacing the children in place preserves the container's scroll
   * position, so a toggle's refresh doesn't jump the tree (no save/restore
   * scroll hack).
   * @param {HTMLElement} sidebar - The sidebar scroll container
   * @param {ReturnType<PluginCatalog['_buildEntries']>} entries - Sidebar entries
   * @private
   */
  _fillSidebar(sidebar, entries) {
    // First real render seeds expansion: every extension open.
    if (this._expanded === null) {
      this._expanded = new Set(entries.filter((e) => e.kind === 'extension').map((e) => e.key));
    }

    const tree = this._createElement('div', 'plugin-tree');
    for (const ext of entries.filter((e) => e.kind === 'extension')) {
      const node = this._createElement('div', 'plugin-tree-node');
      const isOpen = this._expanded.has(ext.key);
      node.appendChild(this._renderTreeExtension(ext, isOpen));

      if (isOpen) {
        const children = this._createElement('div', 'plugin-tree-children');
        const caps = entries.filter((e) => e.kind === 'cap' && e.extKey === ext.key);
        for (const [, section] of CAP_SECTIONS) {
          const inSection = caps.filter((e) => e.section === section);
          if (inSection.length === 0) continue;
          children.appendChild(this._createElement('div', 'plugin-tree-section', section));
          for (const cap of inSection) children.appendChild(this._renderTreeCap(cap));
        }
        if (caps.length === 0) {
          children.appendChild(this._createElement('div', 'plugin-tree-empty', 'No capabilities'));
        }
        node.appendChild(children);
      }
      tree.appendChild(node);
    }

    // Switched-off ids nothing installed claims, in a group of their own. Always
    // expanded: it exists only while it has contents, and its whole purpose is
    // to put the toggle in reach.
    const orphans = entries.filter((e) => e.extKey === ORPHAN_KEY);
    if (orphans.length > 0) {
      const node = this._createElement('div', 'plugin-tree-node');
      const header = this._createElement('div', 'plugin-tree-row plugin-tree-ext plugin-tree-row-off');
      header.appendChild(this._createElement('span', 'plugin-tree-caret', '▾'));
      header.appendChild(this._createElement('span', 'plugin-tree-label', 'Not installed'));
      node.appendChild(header);
      const children = this._createElement('div', 'plugin-tree-children');
      for (const orphan of orphans) children.appendChild(this._renderTreeCap(orphan));
      node.appendChild(children);
      tree.appendChild(node);
    }
    sidebar.replaceChildren(tree);
  }

  /**
   * Render an extension's tree row: an expand/collapse caret plus the
   * selectable extension label and an on/off toggle. The caret toggles the
   * children; the label selects the extension; the toggle enables/disables it.
   * @param {ReturnType<PluginCatalog['_buildEntries']>[number]} entry - Extension entry
   * @param {boolean} isOpen - Whether this extension's children are expanded
   * @returns {HTMLElement} The row element
   * @private
   */
  _renderTreeExtension(entry, isOpen) {
    const row = this._createElement('div', 'plugin-tree-row plugin-tree-ext');
    row.dataset.key = entry.key;
    if (entry.key === this._selectedKey) row.classList.add('selected');
    if (entry.failed) row.classList.add('plugin-tree-row-failed');
    else if (entry.disabled) row.classList.add('plugin-tree-row-off');

    const caret = this._createElement('span', 'plugin-tree-caret', isOpen ? '▾' : '▸');
    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleExpanded(entry.key);
    });
    row.appendChild(caret);

    row.appendChild(this._createElement('span', 'plugin-tree-label', entry.label));
    row.appendChild(this._renderToggleBadge(entry));
    row.addEventListener('click', () => this._select(entry.key));
    return row;
  }

  /**
   * Render a capability's tree row: an indented, selectable leaf with an on/off
   * toggle (no caret — capabilities have no children of their own in the tree; a
   * strategy's owned items live in its detail).
   * @param {ReturnType<PluginCatalog['_buildEntries']>[number]} entry - Capability entry
   * @returns {HTMLElement} The row element
   * @private
   */
  _renderTreeCap(entry) {
    const row = this._createElement('div', 'plugin-tree-row plugin-tree-leaf');
    row.dataset.key = entry.key;
    if (entry.key === this._selectedKey) row.classList.add('selected');
    if (entry.failed) row.classList.add('plugin-tree-row-failed');
    else if (entry.disabled) row.classList.add('plugin-tree-row-off');
    row.appendChild(this._createElement('span', 'plugin-tree-label', entry.label));
    row.appendChild(this._renderToggleBadge(entry));
    row.addEventListener('click', () => this._select(entry.key));
    return row;
  }

  /**
   * Render the on/off toggle badge for a tree row — the primary enable/disable
   * control (there is no toggle in the detail pane). It reads as a status pill
   * and acts as a button: clicking flips the row's enabled state in place,
   * carrying any context items a strategy owns along with it.
   *
   * Non-interactive states, each of which says why in its tooltip:
   * - `failed` — the module didn't load; nothing to toggle.
   * - `unknown` — nothing to write to the config list, so the state can't be
   *   read or changed: an extension whose manifest declares no id, or a declared
   *   capability the registry never registered (its id lives in the module, and
   *   the module isn't loading). The row still shows, because a declared
   *   capability that isn't loading is a fault worth seeing.
   * - a capability whose extension is off — it can't be enabled on its own;
   *   the badge shows `off` but is inert (enable the extension first).
   *
   * The click is stopped from bubbling so toggling doesn't also select the row.
   * @param {ReturnType<PluginCatalog['_buildEntries']>[number]} entry - Tree entry
   * @returns {HTMLElement} The badge/button element
   * @private
   */
  _renderToggleBadge(entry) {
    if (entry.failed) {
      return this._createElement('span', 'plugin-tree-toggle plugin-tree-toggle-failed', 'failed');
    }

    const isExt = entry.kind === 'extension';
    const id = isExt ? entry.card.extId : entry.cap?.id;
    const enabled = !entry.disabled;
    const canToggle = !!id && (isExt || !entry.card.extDisabled);

    const badge = document.createElement('button');
    badge.type = 'button';
    badge.dataset.testid = `toggle-${entry.key}`;

    if (!id) {
      badge.className = 'plugin-tree-toggle plugin-tree-toggle-unknown';
      badge.textContent = 'unknown';
      badge.disabled = true;
      badge.title = "This extension declares no id, so it can't be switched on or off.";
      return badge;
    }

    badge.className = `plugin-tree-toggle plugin-tree-toggle-${enabled ? 'on' : 'off'}`;
    badge.textContent = enabled ? 'on' : 'off';

    if (!canToggle) {
      badge.disabled = true;
      badge.title = 'Enable the extension to toggle this capability';
    } else {
      badge.title = enabled ? 'Click to disable' : 'Click to enable';
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggle([id], !enabled);
      });
    }
    return badge;
  }

  /**
   * Expand or collapse one extension node, then rebuild the tree in place. Only
   * the sidebar tree changes — the detail pane and selection are untouched.
   * @param {string} extKey - The extension entry key to toggle
   * @private
   */
  _toggleExpanded(extKey) {
    if (!this._expanded) this._expanded = new Set();
    if (this._expanded.has(extKey)) this._expanded.delete(extKey);
    else this._expanded.add(extKey);
    if (this._sidebar) this._fillSidebar(this._sidebar, this._buildEntries());
  }

  /**
   * Select a sidebar entry: highlight its tree row and swap the detail pane to
   * its contents. Only `.selected` flags and the detail pane change — the
   * sidebar element and its scroll position are untouched.
   * @param {string} key - The entry key to select
   * @private
   */
  _select(key) {
    this._selectedKey = key;
    const entries = this._buildEntries();

    // Reveal the selection: ensure its owning extension is expanded so the row
    // exists to highlight (covers cross-links from the detail pane into a
    // currently-collapsed extension). Rebuild the tree when expansion changed,
    // otherwise just move the `.selected` flag.
    const entry = entries.find((e) => e.key === key);
    if (this._sidebar && entry && this._expanded && !this._expanded.has(entry.extKey)) {
      this._expanded.add(entry.extKey);
      this._fillSidebar(this._sidebar, entries);
    } else if (this._sidebar) {
      this._sidebar.querySelectorAll('.plugin-tree-row').forEach((el) => {
        el.classList.toggle('selected', /** @type {HTMLElement} */ (el).dataset.key === key);
      });
    }
    this._renderDetailInto(entries);
    if (this._detailPanel) this._detailPanel.scrollTop = 0;
  }

  /**
   * Render the detail pane for the current selection into `this._detailPanel`.
   * @param {ReturnType<PluginCatalog['_buildEntries']>} entries - Sidebar entries
   * @private
   */
  _renderDetailInto(entries) {
    if (!this._detailPanel) return;
    const entry = entries.find((e) => e.key === this._selectedKey);
    if (!entry) {
      this._detailPanel.replaceChildren(
        this._createElement('div', 'catalog-detail-empty', 'Select an item to view its details'));
      return;
    }
    const detail = entry.extKey === ORPHAN_KEY
      ? this._renderOrphanDetail(String(entry.cap?.id))
      : entry.kind === 'extension'
        ? this._renderExtensionDetail(entry.card)
        : this._renderCapDetailFull(/** @type {CapCard} */ (entry.cap), entry.card);
    this._detailPanel.replaceChildren(detail);
  }

  /**
   * Rebuild the sidebar entries and detail pane in place after a toggle. The
   * set of entries is unchanged (a toggle only flips disabled state), so the
   * sidebar element keeps its identity and scroll position; only its rows and
   * the detail contents are rebuilt. Falls back to a full render if the layout
   * hasn't been built yet.
   * @private
   */
  _refreshCards() {
    if (!this._sidebar || !this._sidebar.isConnected) {
      this.render();
      return;
    }
    this._refreshBanners();
    const entries = this._buildEntries();
    if (!entries.some((e) => e.key === this._selectedKey)) {
      this._selectedKey = entries[0]?.key ?? null;
    }
    this._fillSidebar(this._sidebar, entries);
    this._renderDetailInto(entries);
  }

  /**
   * Rebuild the failed-load banner in place, above the master/detail area.
   * Shared by the full render and the post-toggle refresh so the two can't
   * disagree about when it is shown.
   * @private
   */
  _refreshBanners() {
    for (const existing of Array.from(this.querySelectorAll('.catalog-failed-banner'))) {
      existing.remove();
    }
    const main = this.querySelector('.catalog-main');
    /** @param {HTMLElement} node */
    const place = (node) => {
      if (main) this.insertBefore(node, main);
      else this.appendChild(node);
    };
    if (this._failedModules.length > 0) place(this._renderFailedBanner());
  }

  /**
   * Detail for a switched-off id nothing installed provides. Its row carries the
   * toggle, so this only has to say why the id is sitting in a group of its own.
   * @param {string} id - The switched-off capability or extension id
   * @returns {HTMLElement} The detail element
   * @private
   */
  _renderOrphanDetail(id) {
    const was = this._attribution[id];
    const container = this._createElement('div', 'plugin-detail-container');
    const header = this._createElement('div', 'plugin-detail-header');
    const titleRow = this._createElement('div', 'plugin-title-row');
    titleRow.appendChild(this._createElement('h3', 'plugin-detail-name', was?.name || id));
    const badges = this._createElement('div', 'plugin-badges');
    badges.appendChild(this._createElement('span', 'plugin-badge ext-cap-status-disabled', 'disabled'));
    titleRow.appendChild(badges);
    header.appendChild(titleRow);

    const idRow = this._createElement('div', 'plugin-id-container');
    idRow.appendChild(this._createElement('span', 'plugin-id-label', 'ID:'));
    idRow.appendChild(this._createElement('code', 'plugin-id-value', id));
    header.appendChild(idRow);

    if (was?.extension) {
      const fromRow = this._createElement('div', 'plugin-detail-from');
      fromRow.appendChild(this._createElement('span', 'plugin-id-label', 'Was provided by:'));
      fromRow.appendChild(this._createElement('code', 'plugin-id-value', was.extension));
      header.appendChild(fromRow);
    }

    header.appendChild(this._createProse('div', 'plugin-description',
      'Nothing installed provides this. Its extension was removed, or it stopped ' +
      'loading while switched off. Switching it on clears it from the list.'));
    container.appendChild(header);
    return container;
  }

  /**
   * Render the failed-load diagnostics banner.
   * @returns {HTMLElement} The banner element
   * @private
   */
  _renderFailedBanner() {
    const banner = this._createElement('div', 'catalog-failed-banner');
    banner.appendChild(this._createElement('div', 'catalog-failed-title',
      `${this._failedModules.length} capability module(s) failed to load`));
    for (const { path, error } of this._failedModules) {
      const entry = this._createElement('div', 'catalog-failed-entry');
      entry.appendChild(this._createElement('code', 'catalog-failed-path', path));
      entry.appendChild(this._createElement('span', 'catalog-failed-error', error));
      banner.appendChild(entry);
    }
    return banner;
  }

  /**
   * Render the detail pane for a whole extension: identity, source, an explained
   * permissions section, and a list of the capabilities it bundles (each
   * selectable). Enabling/disabling is done from the tree's on/off badge, not
   * here — the detail pane only reports state.
   * @param {ExtCard} card - Card model
   * @returns {HTMLElement} The detail element
   * @private
   */
  _renderExtensionDetail(card) {
    const container = this._createElement('div', 'plugin-detail-container');

    const header = this._createElement('div', 'plugin-detail-header');
    const titleRow = this._createElement('div', 'plugin-title-row');
    titleRow.appendChild(this._createElement('h3', 'plugin-detail-name',
      card.manifest?.name || card.extId || 'Extension'));

    const badges = this._createElement('div', 'plugin-badges');
    if (card.manifest?.version) {
      badges.appendChild(this._createElement('span', 'plugin-badge plugin-version', `v${card.manifest.version}`));
    }
    if (card.manifest?.author) {
      badges.appendChild(this._createElement('span', 'plugin-badge plugin-author', card.manifest.author));
    }
    badges.appendChild(this._createElement('span', `plugin-badge ext-source ext-source-${card.source}`,
      SOURCE_LABELS[card.source] || card.source));
    if (card.extDisabled) {
      badges.appendChild(this._createElement('span', 'plugin-badge ext-cap-status-disabled', 'disabled'));
    }
    titleRow.appendChild(badges);
    header.appendChild(titleRow);

    if (card.extId) {
      const idRow = this._createElement('div', 'plugin-id-container');
      idRow.appendChild(this._createElement('span', 'plugin-id-label', 'ID:'));
      idRow.appendChild(this._createElement('code', 'plugin-id-value', card.extId));
      header.appendChild(idRow);
    }
    container.appendChild(header);

    const content = this._createElement('div', 'plugin-detail-content');
    if (card.error) {
      content.appendChild(this._createElement('div', 'ext-card-error-msg', card.error));
    }
    const file = this._renderSourceFileSection(card.manifestPath, 'Manifest File');
    if (file) content.appendChild(file);
    const perms = this._permissionsSection(card.manifest?.permissions);
    if (perms) content.appendChild(perms);
    if (card.extId && Array.isArray(card.manifest?.settings) && card.manifest.settings.length > 0) {
      const owners = new Set(card.manifest.settings.map((setting) => setting.capability).filter(Boolean));
      const classes = card.caps
        .filter((cap) => owners.has(`${cap.itemType}:${cap.id}`))
        .map((cap) => this._classFor(cap));
      content.appendChild(new ExtensionSettingsEditor(card.manifest, {},
        { view: this._settingsViewFor(classes) }).render());
    }
    if (card.caps.length > 0) content.appendChild(this._renderBundledCaps(card));
    container.appendChild(content);

    return container;
  }

  /**
   * Render a "Source File" section showing the module/manifest's on-disk path
   * with our standard file-path control (copy + reveal-in-Finder, right-click
   * Open/Reveal/Copy). Returns null when there is no revealable file (e.g. an
   * extension embedded in the production binary).
   * @param {string|null} filePath - Absolute on-disk path, or null
   * @param {string} [title] - Section heading (default 'Source File')
   * @returns {HTMLElement|null} The section, or null if no path
   * @private
   */
  _renderSourceFileSection(filePath, title = 'Source File') {
    if (!filePath) return null;
    const section = this._createElement('section', 'plugin-section');
    const head = this._createElement('header', 'plugin-section-header');
    head.appendChild(this._createElement('h5', 'plugin-section-title', title));
    section.appendChild(head);
    addFilePath(section, filePath);
    return section;
  }

  /**
   * Render the "Bundled Capabilities" section of an extension's detail: a
   * selectable row per capability. Clicking a row navigates to that
   * capability's detail.
   * @param {ExtCard} card - Owning extension card
   * @returns {HTMLElement} The section element
   * @private
   */
  _renderBundledCaps(card) {
    const section = this._createElement('section', 'plugin-section');
    const head = this._createElement('header', 'plugin-section-header');
    head.appendChild(this._createElement('h5', 'plugin-section-title', 'Bundled Capabilities'));
    head.appendChild(this._createElement('div', 'plugin-section-explanation',
      'The strategies, context items, and commands this extension provides. Select one to see its details.'));
    section.appendChild(head);

    const list = this._createElement('div', 'ext-cap-list');
    for (const cap of card.caps) {
      list.appendChild(this._renderBundledCapRow(cap));
    }
    section.appendChild(list);
    return section;
  }

  /**
   * Render a single selectable capability row inside an extension's detail.
   * @param {CapCard} cap - Capability model
   * @returns {HTMLElement} The row element
   * @private
   */
  _renderBundledCapRow(cap) {
    const row = this._createElement('div', 'ext-cap ext-cap-link');
    if (cap.failed) row.classList.add('ext-cap-failed');
    else if (cap.disabled) row.classList.add('ext-cap-disabled');

    const main = this._createElement('div', 'ext-cap-main');
    main.appendChild(this._createElement('span', 'ext-cap-name', cap.name));
    main.appendChild(this._createElement('span',
      `ext-cap-type ext-cap-type-${cap.itemType}`, TYPE_LABELS[cap.itemType] || cap.itemType));
    if (cap.failed) {
      main.appendChild(this._createElement('span', 'ext-cap-status ext-cap-status-failed', 'failed to load'));
    } else if (cap.disabled) {
      main.appendChild(this._createElement('span', 'ext-cap-status ext-cap-status-disabled',
        cap.inherited ? 'disabled (extension off)' : 'disabled'));
    }
    row.appendChild(main);
    if (cap.description) row.appendChild(this._createElement('div', 'ext-cap-desc', cap.description));
    if (cap.id || cap.url) {
      row.addEventListener('click', () => this._select(`cap:${cap.itemType}:${cap.id || cap.url}`));
    }
    return row;
  }

  /**
   * Render the full detail pane for a single capability: identity, description,
   * an explained permissions section, tool definitions, and strategy
   * recommendations. Enabling/disabling is done from the tree's on/off badge,
   * not here — the detail pane only reports state.
   * @param {CapCard} cap - Capability model
   * @param {ExtCard} card - Owning extension card
   * @returns {HTMLElement} The detail element
   * @private
   */
  _renderCapDetailFull(cap, card) {
    const container = this._createElement('div', 'plugin-detail-container');
    container.dataset.pluginType = cap.itemType;

    const header = this._createElement('div', 'plugin-detail-header');
    const titleRow = this._createElement('div', 'plugin-title-row');
    titleRow.appendChild(this._createElement('h3', 'plugin-detail-name', cap.name));

    const badges = this._createElement('div', 'plugin-badges');
    badges.appendChild(this._createElement('span',
      `plugin-badge ext-cap-type ext-cap-type-${cap.itemType}`, TYPE_LABELS[cap.itemType] || cap.itemType));
    if (cap.version) {
      badges.appendChild(this._createElement('span', 'plugin-badge plugin-version', `v${cap.version}`));
    }
    if (cap.failed) {
      badges.appendChild(this._createElement('span', 'plugin-badge ext-cap-status-failed', 'failed to load'));
    } else if (cap.disabled) {
      badges.appendChild(this._createElement('span', 'plugin-badge ext-cap-status-disabled',
        cap.inherited ? 'disabled (extension off)' : 'disabled'));
    }
    titleRow.appendChild(badges);
    header.appendChild(titleRow);

    if (cap.id) {
      const idRow = this._createElement('div', 'plugin-id-container');
      idRow.appendChild(this._createElement('span', 'plugin-id-label', 'ID:'));
      idRow.appendChild(this._createElement('code', 'plugin-id-value', cap.id));
      header.appendChild(idRow);
    }

    const extName = card.manifest?.name || card.extId;
    if (extName) {
      const fromRow = this._createElement('div', 'plugin-detail-from');
      fromRow.appendChild(this._createElement('span', 'plugin-id-label', 'From extension:'));
      const link = this._createElement('span', 'plugin-detail-from-link', extName);
      link.addEventListener('click',
        () => this._select(`ext:${card.extId || card.manifest?.name}`));
      fromRow.appendChild(link);
      header.appendChild(fromRow);
    }

    if (cap.description) {
      header.appendChild(this._createProse('div', 'plugin-description', cap.description));
    }
    container.appendChild(header);

    const content = this._createElement('div', 'plugin-detail-content');
    if (cap.failed) {
      content.appendChild(this._createElement('div', 'ext-cap-error', cap.failed));
    }
    const file = this._renderSourceFileSection(cap.path);
    if (file) content.appendChild(file);
    // Settings the extension declared for this capability (`capability:
    // "<itemType>:<id>"`) are shown here as well as on the extension's page —
    // one stored value, two places to reach it.
    const ItemClass = this._classFor(cap);
    const capKey = `${cap.itemType}:${cap.id}`;
    if (card.extId && cap.id
      && (card.manifest?.settings || []).some((setting) => setting.capability === capKey)) {
      content.appendChild(new ExtensionSettingsEditor(card.manifest, {},
        { capability: capKey, view: this._settingsViewFor([ItemClass]) }).render());
    }

    if (ItemClass) {
      const perms = this._renderPermissions(ItemClass);
      if (perms) content.appendChild(perms);
      const tools = this._renderToolDefinitions(ItemClass);
      if (tools) content.appendChild(tools);
      if (cap.itemType === 'strategy') {
        content.appendChild(this._renderStrategyGuidance(ItemClass));
        const recs = this._renderStrategyRecommendations(ItemClass);
        if (recs) content.appendChild(recs);
      }
    }

    if (content.children.length === 0) {
      content.appendChild(this._createElement('div', 'catalog-detail-empty',
        'No further details for this capability.'));
    }
    container.appendChild(content);
    return container;
  }

  /**
   * Render an explained permissions section: each permission badge paired with
   * a plain-language description of the access it grants, under a heading that
   * says what permissions are. Returns null when there are none.
   * @param {string[]|undefined} permissions - Permission identifiers
   * @returns {HTMLElement|null} The section, or null if no permissions
   * @private
   */
  _permissionsSection(permissions) {
    if (!Array.isArray(permissions) || permissions.length === 0) return null;

    const section = this._createElement('section', 'plugin-section');
    const head = this._createElement('header', 'plugin-section-header');
    head.appendChild(this._createElement('h5', 'plugin-section-title', 'Permissions'));
    head.appendChild(this._createElement('div', 'plugin-section-explanation',
      'What this extension declares it does with your computer — so you can decide whether to trust it. '
      + 'This is disclosure, not a limit the app enforces; enabled extensions run with full privileges.'));
    section.appendChild(head);

    const list = this._createElement('div', 'permissions-explained');
    for (const p of permissions) {
      const item = this._createElement('div', 'permission-explained-item');
      item.appendChild(this._createElement('code', 'permission-badge', p));
      item.appendChild(this._createElement('span', 'permission-explained-desc',
        PERMISSION_INFO[p] || 'Custom permission required by this extension'));
      list.appendChild(item);
    }
    section.appendChild(list);
    return section;
  }

  /**
   * The settings-editor `view` hook for a set of capability classes: each class
   * that defines a static `settingsView(values)` describes how its own text
   * settings should display (see `SettingView` in `extensions-settings.js`).
   * @param {any[]} classes - Loaded capability classes (undefined entries ignored)
   * @returns {((values: Record<string, unknown>) => Record<string, any>)|undefined} The hook, or undefined when no class offers one
   * @private
   */
  _settingsViewFor(classes) {
    const views = classes.filter((C) => typeof C?.settingsView === 'function');
    if (views.length === 0) return undefined;
    return (values) => Object.assign({}, ...views.map((C) => C.settingsView(values) || {}));
  }

  /**
   * Resolve the loaded class for a capability via its registry, including
   * disabled items — a disabled capability keeps its class, so its detail pane
   * shows the full properties (permissions, tools, recommendations) rather than
   * hiding them while it's off.
   * @param {CapCard} cap - Capability model
   * @returns {any} The class, or undefined
   * @private
   */
  _classFor(cap) {
    if (!cap.id) return undefined;
    if (cap.itemType === 'strategy') return strategyRegistry.getIncludingDisabled(cap.id);
    if (cap.itemType === 'command') return commandRegistry.getIncludingDisabled(cap.id);
    if (cap.itemType === 'info-card') return infoCardRegistry.getIncludingDisabled(cap.id);
    if (cap.itemType === 'file-viewer') return fileViewerRegistry.getIncludingDisabled(cap.id);
    if (cap.itemType === 'pinboard-item') return pinboardItemRegistry.getIncludingDisabled(cap.id);
    if (cap.itemType === 'hook') return hookRegistry.getIncludingDisabled(cap.id);
    return contextItemRegistry.getIncludingDisabled(cap.id);
  }

  /**
   * Render an install-locations footer: where extensions live on disk, so a
   * developer knows where to drop new ones.
   * @private
   * @returns {Promise<void>}
   */
  async _renderLocations() {
    try {
      const loc = await fetchExtensionLocations();
      const rows = [
        ['Extensions (global)', loc.userExtensions],
      ].filter(([, p]) => p);
      if (rows.length === 0) return;

      const footer = this._createElement('div', 'catalog-plugin-dirs');
      footer.appendChild(this._createElement('span', 'catalog-plugin-dirs-label', 'Install locations: '));
      for (const [label, p] of rows) {
        footer.appendChild(this._createElement('code', 'catalog-plugin-dir-path', `${label}: ${p}`));
      }
      this.appendChild(footer);
    } catch {
      // Silently skip if location info is unavailable.
    }
  }

  /**
   * Render the required-permissions section for a capability class.
   * @param {any} ItemClass - Plugin class
   * @returns {HTMLElement|null} The section, or null if no permissions
   * @private
   */
  _renderPermissions(ItemClass) {
    if (!ItemClass || !ItemClass.MANIFEST) return null;
    return this._permissionsSection(ItemClass.MANIFEST.permissions);
  }

  /**
   * Render what a strategy says to the model: its declared `GUIDANCE`, verbatim.
   *
   * Always rendered, because "nothing" is the answer most people come here for.
   * A strategy's description tells you which tools it withholds and which calls
   * it approves; only this tells you whether it also steers the model, and the
   * text is shown rather than described so the two cannot drift apart.
   * @param {any} ItemClass - Strategy class
   * @returns {HTMLElement} The section
   * @private
   */
  _renderStrategyGuidance(ItemClass) {
    const declared = typeof ItemClass?.GUIDANCE === 'string' ? ItemClass.GUIDANCE.trim() : '';

    const section = this._createElement('section', 'plugin-section');
    const header = this._createElement('header', 'plugin-section-header');
    header.appendChild(this._createElement('h5', 'plugin-section-title', 'What it tells the model'));
    header.appendChild(this._createElement('div', 'plugin-section-explanation',
      'Text this strategy adds to the conversation when you switch to it. It is an ordinary message, '
      + 'not a change to the system prompt, and it is everything the model is told about the strategy.'));
    section.appendChild(header);

    section.appendChild(declared
      ? this._createElement('pre', 'strategy-guidance-text', declared)
      : this._createElement('div', 'strategy-guidance-none',
        'Nothing. This strategy says nothing to the model — it only decides which tools the model is '
        + 'offered and which of its calls need your approval.'));
    return section;
  }

  /**
   * Render strategy recommendations section.
   * @param {any} ItemClass - Strategy class
   * @returns {HTMLElement|null} The section, or null if none
   * @private
   */
  _renderStrategyRecommendations(ItemClass) {
    if (!ItemClass || !ItemClass.MANIFEST || !ItemClass.MANIFEST.recommendations) return null;
    const rec = ItemClass.MANIFEST.recommendations;
    const section = this._createElement('section', 'plugin-section');

    const header = this._createElement('header', 'plugin-section-header');
    header.appendChild(this._createElement('h5', 'plugin-section-title', 'Strategy Recommendations'));
    section.appendChild(header);

    const container = this._createElement('div', 'strategy-recommendations');

    if (rec.recommendedFor && rec.recommendedFor.length > 0) {
      const group = this._createElement('div', 'recommendation-group');
      group.appendChild(this._createElement('div', 'recommendation-label', 'Recommended For:'));
      const list = this._createElement('div', 'recommendation-badges');
      for (const item of rec.recommendedFor) {
        list.appendChild(this._createElement('span', 'recommendation-badge', item));
      }
      group.appendChild(list);
      container.appendChild(group);
    }

    if (rec.approach) {
      const group = this._createElement('div', 'recommendation-group');
      group.appendChild(this._createElement('div', 'recommendation-label', 'Approach:'));
      group.appendChild(this._createProse('div', 'approach-text', rec.approach));
      container.appendChild(group);
    }

    section.appendChild(container);
    return section;
  }

  /**
   * Render tool definitions (what the LLM can call) for a capability class.
   * @param {any} ItemClass - Plugin class
   * @returns {HTMLElement|null} The section, or null if no tools
   * @private
   */
  _renderToolDefinitions(ItemClass) {
    if (!ItemClass || typeof ItemClass.getToolDefinitions !== 'function') return null;
    const tools = ItemClass.getToolDefinitions();
    if (!tools || tools.length === 0) return null;

    const section = this._createElement('section', 'plugin-section');
    const header = this._createElement('header', 'plugin-section-header');
    header.appendChild(this._createElement('h5', 'plugin-section-title', 'Tools'));
    section.appendChild(header);

    const list = this._createElement('div', 'tools-list');
    for (const tool of tools) {
      const toolEl = this._createElement('div', 'tool-item');

      const toolHeader = this._createElement('div', 'tool-header');
      toolHeader.appendChild(this._createElement('code', 'tool-name', tool.name));
      if (tool.category) {
        toolHeader.appendChild(this._createElement('span', `tool-category tool-category-${tool.category}`, tool.category));
      }
      toolEl.appendChild(toolHeader);

      if (tool.description) {
        toolEl.appendChild(this._createElement('div', 'tool-description', tool.description));
      }

      if (tool.input_schema?.properties) {
        const required = tool.input_schema.required || [];
        const params = this._createElement('div', 'tool-params-list');
        for (const [propName, propDef] of Object.entries(tool.input_schema.properties)) {
          const prop = /** @type {{type?: string, description?: string}} */ (propDef);
          const param = this._createElement('div', 'tool-param');
          const paramHeader = this._createElement('div', 'tool-param-header');
          paramHeader.appendChild(this._createElement('code', 'tool-param-name', propName));
          if (prop.type) {
            paramHeader.appendChild(this._createElement('span', 'tool-param-type', prop.type));
          }
          const reqClass = required.includes(propName) ? 'tool-param-required' : 'tool-param-optional';
          paramHeader.appendChild(this._createElement('span', reqClass,
            required.includes(propName) ? 'required' : 'optional'));
          param.appendChild(paramHeader);
          if (prop.description) {
            const desc = this._createElement('div', 'tool-param-description');
            desc.textContent = prop.description;
            param.appendChild(desc);
          }
          params.appendChild(param);
        }
        toolEl.appendChild(params);
      }

      list.appendChild(toolEl);
    }
    section.appendChild(list);
    return section;
  }

  /**
   * Create a DOM element with optional class and text content.
   * @param {string} tag - HTML tag name
   * @param {string} [className] - CSS class name(s)
   * @param {string} [textContent] - Text content
   * @returns {HTMLElement} Created element
   * @private
   */
  _createElement(tag, className, textContent) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (textContent !== undefined) el.textContent = textContent;
    return el;
  }

  /**
   * Create an element holding author-facing prose (a capability description or a
   * strategy's "Approach" copy). When the text reads as markdown — or simply
   * spans multiple paragraphs — it is rendered through the shared markdown
   * formatter so paragraphs, lists, `code`, and links display properly; plain
   * one-liners fall back to `textContent` unchanged, so ordinary descriptions
   * are never reflowed. `renderMarkdown` sanitises its own output (tags,
   * attributes, and URL schemes), so assigning it to innerHTML is safe.
   *
   * Use a block-level tag: markdown emits block elements (`<p>`, `<ul>`), which
   * are invalid nested inside a `<p>`.
   * @param {string} tag - Wrapper tag (must be block-level)
   * @param {string} className - CSS class(es)
   * @param {string} text - Prose to render (plain or markdown)
   * @returns {HTMLElement} The created element
   * @private
   */
  _createProse(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    const str = text ?? '';
    // Treat a blank-line paragraph break as markdown too: textContent would
    // collapse it to a space, so multi-paragraph prose needs the renderer.
    if (looksLikeMarkdown(str) || /\n\s*\n/.test(str)) {
      el.classList.add('markdown');
      el.innerHTML = renderMarkdown(str, { escapeXml: true });
    } else {
      el.textContent = str;
    }
    return el;
  }
}

customElements.define('plugin-catalog', PluginCatalog);

export default PluginCatalog;
