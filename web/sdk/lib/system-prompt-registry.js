//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * System-prompt preset registry — the single in-memory catalog of prompt
 * presets (built-ins shipped here, plus the presets of enabled extensions and
 * the user's saved presets, merged in at runtime). It lives in core (not the
 * juggler-core extension) so that core seeding/UI can depend on it without a
 * core→extension import; the extension's system-prompt context item depends on
 * core, which is the allowed direction.
 *
 * Module singleton: there is exactly one preset catalog app-wide and `import` is
 * the discovery mechanism (see the frontend-service-style note in CLAUDE.md).
 * @module services/system-prompt-registry
 */

/**
 * @typedef {object} SystemPromptPreset
 * @property {string} id - Unique preset identifier (kebab-case)
 * @property {string} name - Display name
 * @property {string} version - Semantic version
 * @property {string} description - Short description
 * @property {string} content - Full prompt body (identity + working guidance, no env block)
 * @property {string} category - Category: "general", "specialized", "user", or `extension:<extensionId>`
 * @property {string} [categoryLabel] - Caption for the category, when it is not one of the fixed ones (an extension's name)
 * @property {boolean} [builtin] - True for shipped presets; false/absent for user-saved and extension ones
 * @property {PresetSource} [source] - Where the preset comes from; decides which setter replaces it
 * @property {string} [extensionId] - The extension that provides it (`source: 'extension'` only)
 */

/**
 * Where a preset comes from: shipped in this module, provided by an enabled
 * extension's `systemPromptPresets`, or saved by the user. Extension presets
 * can be selected and made the default but not edited or deleted.
 * @typedef {'builtin'|'extension'|'user'} PresetSource
 */

/**
 * The order preset groups are listed in, by source.
 * @type {readonly PresetSource[]}
 */
const SOURCE_ORDER = Object.freeze(/** @type {PresetSource[]} */ (['builtin', 'extension', 'user']));

/** The id of the built-in preset used as the universal fallback. */
export const BUILTIN_DEFAULT_ID = 'default';

class SystemPromptRegistry {
  constructor() {
    // Insertion-ordered: built-ins register first (in declaration order), then
    // extension and user presets are appended. Categories and per-category
    // lists are derived from this map on demand so replacing one source's
    // presets needs no bookkeeping.
    /** @type {Map<string, SystemPromptPreset>} @private */
    this._presets = new Map();
  }

  /**
   * Register a preset (built-in or user).
   * @param {SystemPromptPreset} preset - Preset to register
   * @returns {Promise<void>}
   */
  async register(preset) {
    if (!preset.id || !preset.name || !preset.content || !preset.category) {
      throw new Error('Invalid preset: missing required fields (id, name, content, category)');
    }
    this._presets.set(preset.id, preset);
  }

  /**
   * Get a preset by ID
   * @param {string} id - Preset ID
   * @returns {SystemPromptPreset|undefined} Preset if found
   */
  getPreset(id) {
    return this._presets.get(id);
  }

  /**
   * Get all registered presets
   * @returns {SystemPromptPreset[]} Array of all presets
   */
  getAllPresets() {
    return Array.from(this._presets.values());
  }

  /**
   * Get presets by category
   * @param {string} category - Category name
   * @returns {SystemPromptPreset[]} Presets in that category
   */
  getPresetsByCategory(category) {
    const c = category.toLowerCase();
    return this.getAllPresets().filter(p => (p.category || '').toLowerCase() === c);
  }

  /**
   * Get all categories: the built-in ones, then each extension's, then the
   * user's — first-seen order within each source. Ordered by source rather
   * than by insertion because the extension and user sets are loaded in
   * parallel and each replaces itself whenever it reloads, so insertion order
   * would put the extension groups before or after "User" by which fetch
   * landed last.
   * @returns {string[]} Category names
   */
  getCategories() {
    /** @type {string[]} */
    const seen = [];
    /** @type {Map<string, number>} */
    const rank = new Map();
    for (const p of this._presets.values()) {
      const c = (p.category || '').toLowerCase();
      if (!c || rank.has(c)) continue;
      rank.set(c, SOURCE_ORDER.indexOf(p.source ?? 'builtin'));
      seen.push(c);
    }
    // Array sort is stable, so first-seen order holds within a source.
    return seen.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
  }

  /**
   * Remove every preset of one source.
   * @param {PresetSource} source - The source to clear
   * @private
   */
  _clearSource(source) {
    for (const [id, p] of [...this._presets]) {
      if (p.source === source) this._presets.delete(id);
    }
  }

  /**
   * Replace all user presets with the given list, leaving built-in and
   * extension presets untouched. Called after fetching the user's presets from
   * the server so the registry reflects the latest saved set. User presets are
   * filed under the `user` category and marked `builtin: false`.
   * @param {Array<{id: string, name: string, content: string}>} presets - User presets from the server
   */
  setUserPresets(presets) {
    this._clearSource('user');
    for (const p of (Array.isArray(presets) ? presets : [])) {
      if (!p || !p.id || !p.name || !p.content) continue;
      this._presets.set(p.id, {
        id: p.id,
        name: p.name,
        content: p.content,
        version: '1.0.0',
        description: 'User-saved preset',
        category: 'user',
        builtin: false,
        source: 'user'
      });
    }
  }

  /**
   * Replace all extension presets with the given list, leaving built-in and
   * user presets untouched. Called with the presets of every enabled extension,
   * so a preset of an extension that has been switched off or removed drops out.
   * Each extension's presets are filed under a category of their own,
   * `extension:<extensionId>`, captioned with the extension's name.
   *
   * An id already registered keeps its preset, and the later claimant is
   * dropped with a warning — never a silent last-wins, which would let a
   * second copy of an extension replace an identity the user chose. The list
   * arrives in discovery order, built-in extensions first, so the first is
   * the one the core's own duplicate rule keeps.
   * @param {Array<{id: string, name: string, content: string, description?: string, extensionId: string, extensionName?: string}>} presets - Presets read from extensions, ids already namespaced `<extensionId>/<file-stem>`
   */
  setExtensionPresets(presets) {
    this._clearSource('extension');
    for (const p of (Array.isArray(presets) ? presets : [])) {
      if (!p || !p.id || !p.name || !p.content || !p.extensionId) continue;
      const holder = this._presets.get(p.id);
      if (holder) {
        console.warn(`[SystemPromptRegistry] Preset "${p.id}" from extension "${p.extensionId}" repeats an id already held by ${holder.extensionId ? `extension "${holder.extensionId}"` : `a ${holder.source ?? 'builtin'} preset`}; ignoring it`);
        continue;
      }
      this._presets.set(p.id, {
        id: p.id,
        name: p.name,
        content: p.content,
        version: '1.0.0',
        description: p.description || '',
        category: `extension:${p.extensionId}`,
        categoryLabel: p.extensionName || p.extensionId,
        builtin: false,
        source: 'extension',
        extensionId: p.extensionId
      });
    }
  }
}

const systemPromptRegistry = new SystemPromptRegistry();

/**
 * Neutral, opinion-free working guidance shared by the general-purpose built-in
 * presets. It describes how Juggler operates (the tool loop, code handling, code
 * references) in factual terms that apply to any user and any project — no tone,
 * persona, or workflow preferences. Persona/tone choices belong to whoever
 * writes a custom preset, not to the shipped defaults.
 * @type {string}
 */
const GLOBAL_GUIDANCE =
  '## Responses\n' +
  '- Reply in plain text, Markdown, HTML, or Markdown containing HTML, as best suits the response.\n' +
  '- That covers your reply only. Strings you pass as tool arguments are plain text — never HTML-escape them.\n\n' +
  '## Code\n' +
	'- Match the existing patterns, naming, and formatting of the surrounding code.\n' +
	'- Read the relevant code before changing it.\n' +
	'- When a tool call fails, read the error and adjust your approach.\n\n' +
	'## Code references\n' +
	'Refer to code locations as `file_path:line_number`.';

/** @type {SystemPromptPreset[]} */
const BUILTIN_PRESETS = [
  {
    id: 'default',
    name: 'Default',
    version: '2.0.0',
    description: 'General-purpose coding assistant with neutral working guidance',
    category: 'general',
    builtin: true,
    content: 'You are Juggler, an AI coding assistant.\n\n' + GLOBAL_GUIDANCE
  },
  {
    id: 'minimal',
    name: 'Minimal',
    version: '2.0.0',
    description: 'Just the role — no added guidance',
    category: 'general',
    builtin: true,
    content: 'You are Juggler, a coding assistant.'
  },
  {
    id: 'code-reviewer',
    name: 'Code Reviewer',
    version: '2.0.0',
    description: 'Review-focused: examines changes for correctness, edge cases, and clarity',
    category: 'specialized',
    builtin: true,
    content:
			'You are Juggler, an AI coding assistant focused on reviewing code. Examine changes for ' +
			'correctness, edge cases, and clarity, and explain the reasoning behind each point you raise.\n\n' +
			GLOBAL_GUIDANCE
  }
];

for (const preset of BUILTIN_PRESETS) {
  systemPromptRegistry.register({ ...preset, source: 'builtin' });
}

/**
 * Get the built-in default preset's content — the universal fallback prompt body
 * used when a conversation has no stored prompt text. Available in every context
 * (including the engine) because the built-ins register at module load.
 * @returns {string} Default prompt body (no env block)
 */
export function getDefaultIdentityText() {
  const preset = systemPromptRegistry.getPreset(BUILTIN_DEFAULT_ID);
  return preset ? preset.content : '';
}

export { systemPromptRegistry, SystemPromptRegistry, GLOBAL_GUIDANCE };
