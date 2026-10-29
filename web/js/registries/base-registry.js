//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { resolveAssetUrl, importModuleUrl } from '../utils/asset-url.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { REQUIRED_MANIFEST_FIELDS, validateManifest } from '../../sdk/lib/manifest.js';
import { fetchDisabledPluginIds } from '../services/extensions.js';

/**
 * Extract the served URL from a capability descriptor. Tolerates a bare path
 * string for callers/tests that predate the `{path, extensionId}` descriptor.
 * @param {import('../services/extensions.js').CapabilityRef|string} descriptor
 * @returns {string} The served URL of the module
 */
function descriptorPath(descriptor) {
  return typeof descriptor === 'string' ? descriptor : descriptor.path;
}

/**
 * What every class a registry holds has: a static MANIFEST naming its id.
 * @typedef {{MANIFEST?: {id: string}}} RegistrableClass
 */

/**
 * @template {RegistrableClass} T
 * @typedef {object} LoadedEntry
 * @property {string} id - Capability id from the class MANIFEST
 * @property {T} ItemClass - The loaded class
 * @property {string} modulePath - Served URL the class was loaded from
 * @property {string|null} extensionId - id of the owning extension
 * @property {number} index - Position in the precedence-ordered descriptor list
 */

/**
 * BaseRegistry - Abstract base class for registry systems
 *
 * Provides common functionality for loading, validating, and managing
 * classes that use the manifest pattern (context items, actions, tools, etc.)
 * @abstract
 * @template {RegistrableClass} T
 */
class BaseRegistry {
  /**
   * Create a new registry
   * @param {string} name - Registry name for logging
   * @param {string[]} requiredManifestFields - Required fields in manifest
   */
  constructor(name, requiredManifestFields = REQUIRED_MANIFEST_FIELDS) {
    if (new.target === BaseRegistry) {
      throw new Error('BaseRegistry is abstract and cannot be instantiated directly');
    }

    /**
     * Registry name for logging
     * @type {string}
     * @protected
     */
    this.name = name;

    /**
     * Map of item ID to item class
     * @type {Map<string, T>}
     * @protected
     */
    this.items = new Map();

    /**
     * Map of item ID to module path
     * @type {Map<string, string>}
     * @protected
     */
    this.modulePaths = new Map();

    /**
     * Map of item ID to the id of the extension that provided it (null when the
     * capability has no owning extension). Used for grouping, precedence, and
     * the catalog UI.
     * @type {Map<string, string|null>}
     * @protected
     */
    this.itemExtensions = new Map();

    /**
     * Required manifest fields
     * @type {string[]}
     * @protected
     */
    this.requiredManifestFields = requiredManifestFields;

    /**
     * Whether the registry has been initialized
     * @type {boolean}
     * @protected
     */
    this.initialized = false;

    /**
     * The load pass currently running, shared by every caller that arrives
     * while it is in flight. `initialized` only turns true once a pass has
     * finished, so without this a second caller sees a cold registry and starts
     * a duplicate pass — imports, validation and config fetches included.
     * @type {Promise<void>|null}
     * @protected
     */
    this._initInFlight = null;

    /**
     * Module paths that failed to load during init (path -> error message)
     * @type {Map<string, string>}
     * @protected
     */
    this._failedModules = new Map();

    /**
     * Items that are loaded but disabled via config (id -> class)
     * @type {Map<string, T>}
     * @protected
     */
    this._disabledItems = new Map();

    /**
     * The resolved disabled-id set from the last `_applyDisabledFilter` pass,
     * kept so registration that happens AFTER init (registerClass — user slash
     * commands, item-owned strategies) is filtered by the same set the
     * module-loaded capabilities were. Empty until the first pass, which is the
     * right default: nothing is known to be off yet.
     * @type {Set<string>}
     * @protected
     */
    this._disabledIds = new Set();
  }

  /**
   * Get module paths to load
   *
   * Subclasses must implement this to return capability descriptors. Each is
   * `{path, extensionId}` — the served URL of the module and the id of the
   * extension that owns it (null when the capability has no owning extension).
   * The capability ID is extracted from each class's MANIFEST.id property.
   * May be async to support fetching extension paths from the backend.
   * @abstract
   * @returns {import('../services/extensions.js').CapabilityRef[]|Promise<import('../services/extensions.js').CapabilityRef[]>} Capability descriptors to load
   * @protected
   */
  getModulePaths() {
    throw new Error('Subclass must implement getModulePaths()');
  }

  /**
   * Validate a class
   *
   * Can be overridden by subclasses for additional validation. The manifest
   * itself is checked by the shared SDK validator, so a class rejected here and
   * a class rejected by its own constructor fail for the same reasons and say
   * so in the same words.
   * @param {unknown} ItemClass - Class to validate
   * @throws {Error} If class is invalid
   * @protected
   */
  validateClass(ItemClass) {
    if (typeof ItemClass !== 'function') {
      throw new Error(`${this.name} item must be a class`);
    }

    validateManifest(ItemClass, this.requiredManifestFields);
  }

  /**
   * Initialize the registry by loading all items.
   *
   * Callers arriving while a pass is running share it rather than starting
   * their own: a turn's tool list inits this registry, and read-only sub-agents
   * dispatch their turns together, so a cold registry could otherwise be loaded
   * four times over on the one engine thread they share.
   * @async
   * @returns {Promise<void>}
   */
  async init() {
    if (this.initialized) {
      return;
    }
    if (!this._initInFlight) {
      this._initInFlight = this._runInitPass().finally(() => { this._initInFlight = null; });
    }
    return this._initInFlight;
  }

  /**
   * Load and resolve every capability module. One pass; {@link init} owns
   * whether a pass is needed and who waits on it.
   * @async
   * @returns {Promise<void>}
   * @private
   */
  async _runInitPass() {
    // getModulePaths() may be async (it fetches the extension catalog). The
    // returned descriptors are ordered by precedence (low→high).
    const descriptors = await this.getModulePaths();

    // Pass 1 — import + validate every module concurrently, with graceful
    // degradation. Loading is order-independent; collisions are resolved
    // deterministically afterward so a parallel race can't pick the winner.
    const settled = await Promise.allSettled(
      descriptors.map(descriptor => this._importDescriptor(descriptor))
    );

    this._failedModules.clear();
    /** @type {LoadedEntry<T>[]} */
    const loaded = [];
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        loaded.push({ ...result.value, index });
      } else {
        const descriptor = /** @type {import('../services/extensions.js').CapabilityRef} */ (descriptors[index]);
        const failedPath = descriptorPath(descriptor);
        const errorMsg = result.reason?.message || String(result.reason);
        this._failedModules.set(failedPath, errorMsg);
        console.error(
          `[${this.name}] Failed to load plugin ${failedPath}:`,
          result.reason
        );
      }
    });

    // Pass 2 — resolve loaded entries into this.items by precedence.
    this._resolveLoaded(loaded);

    if (this._failedModules.size > 0) {
      console.warn(`[${this.name}] ${this._failedModules.size} plugin(s) failed to load`);
    }

    // Apply disabled plugin filtering
    await this._applyDisabledFilter();

    this.initialized = true;
  }

  /**
   * Resolve loaded entries into the registry, settling duplicate capability ids
   * by precedence (descriptor order). The lowest-precedence entry holds the id;
   * any other entry claiming the same id is a surfaced load error and is
   * ignored — never a silent last-write-wins.
   * @param {LoadedEntry<T>[]} loaded - Successfully imported entries
   * @private
   */
  _resolveLoaded(loaded) {
    /** @type {Map<string, LoadedEntry<T>[]>} */
    const groups = new Map();
    for (const entry of loaded) {
      const group = groups.get(entry.id);
      if (group) group.push(entry);
      else groups.set(entry.id, [entry]);
    }

    for (const [id, group] of groups) {
      group.sort((a, b) => a.index - b.index);
      const winner = /** @type {LoadedEntry<T>} */ (group[0]); // lowest-precedence holder wins
      for (let i = 1; i < group.length; i++) {
        const candidate = /** @type {LoadedEntry<T>} */ (group[i]); // bounded by i < group.length
        this._failedModules.set(candidate.modulePath,
          `duplicate capability id "${id}" already provided by "${winner.extensionId}"`);
        console.error(
          `[${this.name}] Duplicate capability id "${id}" from ${candidate.modulePath} ` +
          `(extension "${candidate.extensionId}") collides with "${winner.extensionId}"; ignoring`
        );
      }
      this.items.set(id, winner.ItemClass);
      this.modulePaths.set(id, winner.modulePath);
      this.itemExtensions.set(id, winner.extensionId);
    }
  }

  /**
   * Fetch the disabled plugin ids from config and split the loaded capabilities
   * between `items` (enabled) and `_disabledItems` (loaded but switched off).
   *
   * Idempotent, and it has to be: a `reset()` landing mid-load — app startup
   * racing the `plugin-changed` broadcast that a config write triggers — drops
   * the shared in-flight pass and starts a second one beside it, so two run in
   * full against one registry. It therefore moves capabilities BOTH ways and
   * never rebuilds a map from scratch: re-deriving `_disabledItems` from `items`
   * would lose every capability the previous pass had already moved out of
   * `items`, leaving it in neither map. Such a capability is not enabled and not
   * disabled but gone, and the catalog row it backs loses its id, its name and
   * its toggle.
   * @private
   * @returns {Promise<void>}
   */
  async _applyDisabledFilter() {
    try {
      const disabledSet = await fetchDisabledPluginIds();
      // Config unreachable and never yet read: leave the split exactly as it
      // stands rather than guessing, so a blip can't switch anything on or off.
      if (!disabledSet) return;
      this._disabledIds = disabledSet;

      /**
       * @param {string} id - Capability id
       * @returns {boolean} Whether that capability is switched off
       */
      const isDisabled = (id) => this._isDisabledId(id, this.itemExtensions.get(id) ?? null);

      for (const [id, ItemClass] of [...this.items]) {
        if (!isDisabled(id)) continue;
        this._disabledItems.set(id, ItemClass);
        this.items.delete(id);
        console.info(`[${this.name}] Plugin "${id}" is disabled via config`);
      }

      for (const [id, ItemClass] of [...this._disabledItems]) {
        if (isDisabled(id)) continue;
        this._disabledItems.delete(id);
        this.items.set(id, ItemClass);
      }
    } catch {
      // Config endpoint may not exist yet — silently skip
    }
  }

  /**
   * Whether a capability is switched off for this project.
   *
   * A capability is disabled when either its OWN id or the id of the extension
   * that provides it appears in the disabled set — so a whole extension is
   * switched off by listing its extension id, without enumerating every
   * capability it bundles.
   * @param {string} id - Capability id
   * @param {string|null} extensionId - Id of the providing extension, if any
   * @returns {boolean} True when the capability should not be live
   * @protected
   */
  _isDisabledId(id, extensionId) {
    return this._disabledIds.has(id) || (!!extensionId && this._disabledIds.has(extensionId));
  }

  /**
   * Import and validate a single capability module. Returns a LoadedEntry; does
   * NOT register it (collision resolution happens later in _resolveLoaded).
   * @async
   * @param {import('../services/extensions.js').CapabilityRef|string} descriptor - Capability descriptor (or bare path)
   * @returns {Promise<{id: string, ItemClass: T, modulePath: string, extensionId: string|null}>} Loaded entry
   * @throws {Error} If module cannot be loaded or is invalid
   * @private
   */
  async _importDescriptor(descriptor) {
    const modulePath = descriptorPath(descriptor);
    const extensionId = typeof descriptor === 'string' ? null : (descriptor.extensionId ?? null);
    // Errors propagate to the caller (Promise.allSettled in load()), which logs
    // the failure with full descriptor context — don't log here too or every
    // failed plugin is reported twice.
    // Prefix embedded builtin paths with the versioned asset prefix for cache
    // busting; disk-served plugin/extension paths are left untouched.
    const resolvedPath = resolveAssetUrl(modulePath);
    const module = /** @type {{default?: unknown}} */ (await importModuleUrl(resolvedPath));

    if (!module.default) {
      throw new Error(`${this.name} module ${modulePath} does not have a default export`);
    }

    // Validate class (this also ensures MANIFEST exists)
    this.validateClass(module.default);

    // A class that has passed this registry's validation is one it holds.
    const ItemClass = /** @type {T} */ (module.default);
    const id = ItemClass.MANIFEST?.id;

    if (!id) {
      throw new Error(`${this.name} class in ${modulePath} has no MANIFEST.id`);
    }

    return { id, ItemClass, modulePath, extensionId };
  }

  /**
   * Register an already-loaded class directly, bypassing module import. This is
   * the seam for capability sources that synthesise classes in-process rather
   * than importing a module URL (e.g. user-defined slash commands built from
   * markdown definitions). Call it AFTER `init()` so it can detect collisions
   * against the module-loaded set.
   *
   * A class whose id collides with an already-registered (or config-disabled)
   * capability is NOT registered — it is recorded as a failed module so the id's
   * existing owner keeps it, and the collision is surfaced in the manager UI.
   * This enforces the rule that a late-registered capability may never shadow a
   * module-loaded one (a user command can't shadow a built-in command; an
   * item-owned strategy can't shadow a file-based strategy).
   *
   * A class whose id the project has switched off is kept but not made live: it
   * joins the disabled set, so the catalog lists it with a working toggle. That
   * is a different outcome from a collision and is reported as one — `disabled`
   * rather than `reason` — and it never enters the failed-module list, because
   * being switched off is a choice, not a fault.
   * @param {T} ItemClass - The class to register (must have a valid MANIFEST)
   * @param {{extensionId?: string|null, modulePath?: string}} [opts] - Attribution
   * @returns {{registered: boolean, id?: string, reason?: string, disabled?: boolean}} Outcome
   */
  registerClass(ItemClass, { extensionId = null, modulePath = '' } = {}) {
    try {
      this.validateClass(ItemClass);
    } catch (err) {
      const msg = extractErrorMessage(err);
      this._failedModules.set(modulePath || '(registerClass)', msg);
      return { registered: false, reason: msg };
    }
    // validateClass has established that MANIFEST is there.
    const id = /** @type {{id: string}} */ (ItemClass.MANIFEST).id;
    if (this.items.has(id) || this._disabledItems.has(id)) {
      const reason = this.collisionMessage(id);
      this._failedModules.set(modulePath || id, reason);
      return { registered: false, id, reason };
    }

    this.modulePaths.set(id, modulePath);
    this.itemExtensions.set(id, extensionId);

    // Config applies to a late registration exactly as it does to a loaded
    // module. The disabled filter has already run by the time this is called
    // (it is the last thing init() does, and every caller registers after that),
    // so without this a user slash command or an item-owned strategy the user
    // switched off would come back on at every rebuild. Not a failure: the
    // capability is kept, attributed and catalogued as disabled, so its row can
    // switch it on again.
    if (this._isDisabledId(id, extensionId)) {
      this._disabledItems.set(id, ItemClass);
      return { registered: false, id, disabled: true };
    }

    this.items.set(id, ItemClass);
    return { registered: true, id };
  }

  /**
   * The message shown when {@link registerClass} is handed an id that is already
   * taken. Generic by default, since every registry shares this path; a registry
   * whose capabilities the user names directly (commands) overrides it to say so
   * in the user's own vocabulary.
   * @param {string} id - The colliding capability id
   * @returns {string} Human-readable explanation of what was skipped and why
   * @protected
   */
  collisionMessage(id) {
    return `A capability with the id "${id}" is already registered (built-in or from an extension), so this one was skipped.`;
  }

  /**
   * Get an item class by ID
   * @param {string} id - Item ID
   * @returns {T|undefined} Item class or undefined if not found
   */
  get(id) {
    return this.items.get(id);
  }

  /**
   * Get an item class by ID, including items disabled via config. A disabled
   * capability is still loaded and retains its class (MANIFEST, tool
   * definitions, recommendations) — it is merely filtered out of `this.items`.
   * The catalog uses this so a disabled item's properties stay fully visible.
   * @param {string} id - Item ID
   * @returns {T|undefined} Item class (enabled or disabled), or undefined
   */
  getIncludingDisabled(id) {
    return this.items.get(id) ?? this._disabledItems.get(id);
  }

  /**
   * The id of the extension that provided a capability (null when it has no
   * owning extension, or the id isn't registered). Lets one registry attribute a
   * capability it derives from another's — an item-owned strategy is registered
   * under the extension that ships the item.
   * @param {string} id - Item ID
   * @returns {string|null} Owning extension id, or null
   */
  getExtensionId(id) {
    return this.itemExtensions.get(id) ?? null;
  }

  /**
   * Check if an item exists
   * @param {string} id - Item ID
   * @returns {boolean} True if item exists
   */
  has(id) {
    return this.items.has(id);
  }

  /**
   * Test seam: the live map of enabled items, for a test that takes one out
   * and puts it back.
   * @returns {Map<string, T>} The registry's own map, not a copy
   */
  __itemsForTests() {
    return this.items;
  }

  /**
   * Get all registered item IDs
   * @returns {string[]} Array of item IDs
   */
  getIds() {
    return Array.from(this.items.keys());
  }

  /**
   * Get all registered items as array of {id, class} objects
   * @returns {Array<{id: string, class: T}>} Array of items
   */
  getAll() {
    return Array.from(this.items.entries()).map(([id, ItemClass]) => ({
      id,
      class: ItemClass
    }));
  }

  /**
   * Get all manifests
   * @returns {Array<{id: string, manifest: NonNullable<T['MANIFEST']>, modulePath: string, extensionId: string|null}>} Array of manifests
   */
  getManifests() {
    return this.getAll().map(({ id, class: ItemClass }) => {
      return {
        id,
        // Every registered class passed validateClass, which requires a MANIFEST.
        manifest: /** @type {NonNullable<T['MANIFEST']>} */ (ItemClass.MANIFEST),
        modulePath: this.modulePaths.get(id) || '',
        extensionId: this.itemExtensions.get(id) ?? null
      };
    });
  }

  /**
   * Check if registry is initialized
   * @returns {boolean} True if initialized
   */
  isInitialized() {
    return this.initialized;
  }

  /**
   * Reset the registry so it can be re-initialized (e.g., for plugin hot reload).
   * Clears all loaded items, module paths, failed modules, and disabled items.
   */
  reset() {
    this.initialized = false;
    // Drop the running pass too: it was started against the state this reset
    // just invalidated. Left in place it would be handed to every later caller,
    // and the registry would keep serving the plugin set the user just changed.
    this._initInFlight = null;
    this.items.clear();
    this.modulePaths.clear();
    this.itemExtensions.clear();
    this._failedModules.clear();
    this._disabledItems.clear();
    // _disabledIds is deliberately NOT cleared: it is knowledge about config,
    // not registry contents, and the next init() replaces it wholesale. Clearing
    // it would make the window between reset and that pass claim nothing is
    // switched off, which is exactly when registerClass runs.
  }

  /**
   * Get list of modules that failed to load
   * @returns {Array<{path: string, error: string}>} Array of failed modules with error messages
   */
  getFailedModules() {
    return Array.from(this._failedModules.entries()).map(([path, error]) => ({ path, error }));
  }

  /**
   * Check if a module path failed to load
   * @param {string} modulePath - Module path to check
   * @returns {boolean} True if the module failed to load
   */
  hasFailedModule(modulePath) {
    return this._failedModules.has(modulePath);
  }

  /**
   * Get all disabled items (loaded but excluded via config)
   * @returns {Array<{id: string, class: T}>} Array of disabled items
   */
  getDisabledItems() {
    return Array.from(this._disabledItems.entries()).map(([id, ItemClass]) => ({
      id,
      class: ItemClass
    }));
  }

  /**
   * Get manifests for every loaded capability — both the enabled ones and the
   * ones excluded via config — each tagged with a `disabled` flag and its owning
   * extension id. This is the single source the extensions catalog uses to show
   * a complete, attributed inventory (a disabled capability is still loaded and
   * has a manifest; it is merely filtered out of `this.items`).
   * @returns {Array<{id: string, manifest: NonNullable<T['MANIFEST']>, modulePath: string, extensionId: string|null, disabled: boolean}>} Enabled and disabled capability entries
   */
  getCatalogManifests() {
    const enabled = this.getManifests().map(m => ({ ...m, disabled: false }));
    const disabled = Array.from(this._disabledItems.entries()).map(([id, ItemClass]) => ({
      id,
      manifest: /** @type {NonNullable<T['MANIFEST']>} */ (ItemClass.MANIFEST),
      modulePath: this.modulePaths.get(id) || '',
      extensionId: this.itemExtensions.get(id) ?? null,
      disabled: true
    }));
    return [...enabled, ...disabled];
  }
}

export default BaseRegistry;
