//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { createElement, injectStylesOnce, formatTokens, extractErrorMessage } from 'juggler/ui';
import { createTextBlock } from 'juggler/item-utils';
import { systemPromptRegistry, getDefaultIdentityText } from '../../../sdk/lib/system-prompt-registry.js';
import { showPresetBrowser } from './system-prompt/preset-browser.js';
import { translator, markUntranslated, markForTranslation } from 'juggler/i18n';

const t = translator('@juggler/core');

/**
 * How an MCP server's reported status is named in the tool list. A value
 * missing here is shown as it came.
 * @type {Record<string, string>}
 */
const MCP_STATUS_LABELS = {
  running: markForTranslation('running'),
  starting: markForTranslation('starting'),
  stopped: markForTranslation('stopped'),
  failed: markForTranslation('failed'),
  untrusted: markForTranslation('not trusted'),
  disabled: markForTranslation('disabled'),
};

/**
 * An MCP server's status as the tool list shows it.
 * @param {string} status - The reported status
 * @returns {string} Its translated name, or the value itself when unknown
 */
function mcpStatusLabel(status) {
  const label = Object.prototype.hasOwnProperty.call(MCP_STATUS_LABELS, status) ? MCP_STATUS_LABELS[status] : '';
  return label ? t(label) : status;
}

// ============================================================================
// Styles
// ============================================================================

const SYSTEM_PROMPT_STYLES = `
.system-prompt-ci-expanded {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.system-prompt-preset-btn {
  margin-top: 0.5rem;
  padding: 0.375rem 0.75rem;
  font-size: var(--font-size-sm);
  background-color: var(--accent-blue);
  color: var(--text-on-accent);
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background-color 150ms ease;
  align-self: flex-start;
}
.system-prompt-preset-btn:hover {
  background-color: var(--accent-blue-light);
}
.system-prompt-textarea {
  width: 100%;
  padding: 1rem;
  font-size: var(--font-size-base);
  font-family: var(--font-mono);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  resize: vertical;
  min-height: 6rem;
  line-height: 1.5;
}
.system-prompt-textarea:focus {
  outline: none;
  border-color: var(--field-focus-border);
  box-shadow: var(--field-focus-halo);
  background: var(--bg-raised);
}
.system-prompt-textarea::placeholder {
  color: var(--text-tertiary);
  opacity: 0.8;
}
.system-prompt-preview-sections {
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}
.system-prompt-section {
  border-radius: var(--radius-2xl);
  overflow: hidden;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
}
.system-prompt-section-header {
  display: flex;
  align-items: center;
  padding: 0.375rem 0.625rem;
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-color);
}
.system-prompt-section-body {
  padding: 0.625rem;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}
.system-prompt-section-body .ci-text-block {
  opacity: 0.85;
}
/* Tools section: a plain list, because its job is to be scanned for a name that
   should be there and isn't. */
.system-prompt-tools {
  display: flex;
  flex-direction: column;
  /* Rows shrink to their text rather than stretching to the column. A row's
     tooltip is its description, and a full-width row would hang that tooltip
     off to the right of a short name, nowhere near the word it describes. */
  align-items: flex-start;
  gap: 0.1rem;
}
.system-prompt-tools > * {
  max-width: 100%;
}
.system-prompt-tools-count {
  color: var(--text-tertiary);
  margin-bottom: 0.35rem;
}
.system-prompt-tools-group {
  margin-top: 0.5rem;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
}
.system-prompt-tools-group:first-child {
  margin-top: 0;
}
.system-prompt-tool {
  padding: 0 0 0 0.75rem;
  border: none;
  background: none;
  font: inherit;
  font-family: var(--font-mono);
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.system-prompt-tool:hover,
.system-prompt-tool:focus-visible {
  color: var(--text-primary);
  text-decoration: underline;
}
.system-prompt-tools-withheld {
  display: flex;
  flex-direction: column;
  /* Rows still shrink to their text, but the block spans the section so the rule
     that separates it from the offered tools spans it too. */
  align-items: flex-start;
  align-self: stretch;
  gap: 0.1rem;
  margin-top: 0.75rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--border-divider);
}
.system-prompt-tool-withheld {
  color: var(--text-tertiary);
  text-decoration: line-through;
}
.system-prompt-tool-withheld:hover,
.system-prompt-tool-withheld:focus-visible {
  color: var(--text-secondary);
  text-decoration: line-through underline;
}
.system-prompt-tools-silent {
  margin-top: 0.5rem;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--accent-yellow);
}
.system-prompt-tools-drift {
  margin-bottom: 0.35rem;
  color: var(--accent-yellow);
}
.system-prompt-tools-notice {
  margin-bottom: 0.35rem;
  line-height: 1.4;
  white-space: normal;
  color: var(--accent-yellow);
}
/* Preset browser + manage-presets dropdowns -------------------------------
   Self-contained rows (no shared .menu-item dependency) so the layout reads
   like a tidy macOS menu: a leading check/icon column keeps every label on one
   vertical line, the name flexes, and trailing controls sit flush right. */
.system-prompt-preset-dropdown,
.system-prompt-manage-dropdown {
  min-width: 16rem;
  max-width: 22rem;
}
.system-prompt-preset-dropdown menu,
.system-prompt-manage-dropdown menu {
  display: flex;
  flex-direction: column;
  gap: 0.0625rem;
}
.sp-preset-category {
  padding: 0.5rem 0.625rem 0.25rem;
  padding-left: calc(0.625rem + 1.125rem + 0.5rem);
  font-size: var(--font-size-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-tertiary);
  cursor: default;
  -webkit-user-select: none;
  user-select: none;
}
.sp-preset-category:first-child {
  padding-top: 0.125rem;
}
.sp-preset-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.625rem;
  border-radius: var(--radius-popup-item);
  color: var(--text-primary);
  cursor: pointer;
  transition: background 120ms ease;
}
.sp-preset-row:hover {
  background: var(--bg-raised);
}
/* A row reached from the keyboard lights up as a hovered one does — the row
   itself for an action, the row around it for a preset's name. */
.sp-preset-row[role="menuitem"]:focus-visible,
.sp-preset-row:has(> .sp-preset-row-name:focus-visible) {
  background: var(--bg-raised);
  outline: none;
}
.sp-preset-row-name:focus-visible {
  outline: none;
}
.sp-preset-row.sp-preset-static {
  cursor: default;
}
.sp-preset-row-icon {
  flex-shrink: 0;
  width: 1.125rem;
  height: 1.125rem;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-blue);
}
.sp-preset-row-icon svg {
  width: 1rem;
  height: 1rem;
  fill: currentColor;
}
.sp-preset-row.sp-preset-action .sp-preset-row-icon {
  color: var(--text-tertiary);
}
.sp-preset-row-name {
  flex: 1;
  min-width: 0;
  font-size: var(--font-size-md);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sp-preset-row.is-selected .sp-preset-row-name {
  font-weight: 600;
}
.sp-preset-default-badge {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--accent-blue);
  white-space: nowrap;
}
.sp-preset-setdefault-btn,
.sp-preset-delete-btn {
  font-size: var(--font-size-xs);
  padding: 0.15rem 0.55rem;
  border: 0.0625rem solid var(--border-color);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  white-space: nowrap;
  opacity: 0;
  transition: opacity 120ms ease, color 120ms ease, border-color 120ms ease, background 120ms ease;
}
.sp-preset-row:hover .sp-preset-setdefault-btn,
.sp-preset-row:focus-within .sp-preset-setdefault-btn,
.sp-preset-row:hover .sp-preset-delete-btn,
.sp-preset-row:focus-within .sp-preset-delete-btn {
  opacity: 1;
}
.sp-preset-setdefault-btn:hover {
  color: var(--text-primary);
  border-color: var(--text-tertiary);
  background: var(--bg-secondary);
}
.sp-preset-delete-btn {
  border-color: transparent;
}
.sp-preset-delete-btn:hover {
  color: var(--error-color);
  border-color: var(--error-color);
}
.sp-preset-separator {
  height: 0.0625rem;
  background: var(--border-divider, var(--border-color));
  margin: 0.375rem 0.25rem;
}
.sp-preset-empty {
  padding: 0.4rem 0.625rem;
  padding-left: calc(0.625rem + 1.125rem + 0.5rem);
  color: var(--text-tertiary);
  font-size: var(--font-size-base);
  font-style: italic;
}
`;

injectStylesOnce('system-prompt-styles', SYSTEM_PROMPT_STYLES);

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build the auto-appended environment block. Pure: the caller supplies the
 * date so the block is a function of durable conversation state, not the live
 * clock (a conversation resumed across midnight must rebuild identical bytes).
 *
 * `projectPath` is stated only when it is somewhere other than the working
 * directory — which is to say only for a conversation bound to a workspace,
 * whose reads are widened to the project but whose work is not. A conversation
 * bound to nothing rebuilds the same three lines it always did, which matters
 * because these bytes head every prompt and are therefore a cache key.
 * @param {string} workingDir - Where this conversation's tools run
 * @param {string} projectPath - The project, when it differs from the working directory
 * @param {string} platform - Platform (darwin/linux/windows)
 * @param {string} today - Date as `YYYY-MM-DD`, pinned to conversation start
 * @returns {string} Environment XML block
 */
function buildEnvBlock(workingDir, projectPath, platform, today) {
  // The model's text: English whatever the UI language.
  const project = projectPath && projectPath !== workingDir
    ? markUntranslated(`\nProject directory: ${projectPath}`)
    : '';
  return markUntranslated(`<env>
Working directory: ${workingDir || 'unknown'}${project}
Platform: ${platform || 'unknown'}
Today's date: ${today}
</env>`);
}

// ============================================================================
// SystemPromptContextItem
// ============================================================================

/**
 * SystemPromptContextItem - Editable system prompt with presets
 *
 * Allows users to customize the base identity sent to the LLM.
 * The properties panel shows the editable identity text and a sectioned
 * preview of the full assembled system prompt (identity + env + rules + strategy).
 * @class
 * @augments ContextItem
 */
class SystemPromptContextItem extends ContextItem {
  /**
   * Context item manifest
   * @static
   * @type {import('juggler/context-item').ContextItemManifest}
   */
  static MANIFEST = {
    id: 'system-prompt',
    name: 'System Prompt',
    version: '1.0.0',
    description: 'Base system instructions for the LLM',
    author: 'Juggler Team',
    idPrefix: 'SYSTEM',
    preventUserDeletion: true,
    contextPosition: 'system'
  };

  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'meta' };
  }

  /** @returns {import('juggler/context-item').ResultStatusMessage} Status UI config */
  getStatusUI() {
    return { typeName: t('System Prompt'), summary: this.getTitle() };
  }

  /**
   * @param {import('juggler/context-item').ItemContext} context - Item context
   */
  constructor(context) {
    super(context);

    // presentPopup release for whichever preset surface is open — browser or
    // manage. Owned here, written by system-prompt/preset-browser.js: one slot
    // is what makes opening either close the other.
    /** @type {(() => void)|null} @private */
    this._dropdownRelease = null;

    /** @type {ReturnType<typeof setTimeout>|null} @private */
    this._persistTimer = null;

    // Apply defaults on the instance so buildPrompt/getTitle/UI always have values,
    // even when the Yjs store has empty data (e.g. brand new conversation).
    if (this.data.selectedPresetId === undefined) {
      this.data.selectedPresetId = 'default';
    }
    if (this.data.isModified === undefined) {
      this.data.isModified = false;
    }
  }

  /**
   * Resolve the effective prompt body. The stored text in the doc is the source
   * of truth — selecting a preset copies its body into `data.text`, so the build
   * never needs the preset registry (which would be absent in the engine for
   * user presets). Empty stored text (a fresh placeholder) falls back to the
   * built-in `default` preset content, which is registered everywhere.
   * @returns {string} Prompt body text
   */
  _getEffectiveText() {
    const text = this.data.text;
    if (typeof text === 'string' && text) return text;
    return getDefaultIdentityText();
  }

  /**
   * Persist current data to Yjs via the messageThread API.
   * Debounced for textarea input; called immediately for preset selection.
   * @private
   * @param {boolean} [immediate] - Skip debounce
   */
  _persistData(immediate) {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }

    const doWrite = () => {
      if (this.messageThread) {
        this.messageThread.updateContextItem(this.id, { data: { ...this.data } });
      }
    };

    if (immediate) {
      doWrite();
    } else {
      this._persistTimer = setTimeout(doWrite, 300);
    }
  }

  /**
   * Get item title
   * @returns {string} Item title
   */
  getTitle() {
    const presetId = this.data.selectedPresetId;
    if (typeof presetId === 'string' && presetId && !this.data.isModified) {
      const preset = systemPromptRegistry.getPreset(presetId);
      if (preset && preset.id !== 'default') {
        // A preset's name is data, shown as it is stored.
        return t('System Prompt ({name})', { name: preset.name });
      }
    }
    if (this.data.isModified) {
      return t('System Prompt (Custom)');
    }
    return t('System Prompt');
  }

  /**
   * Create properties panel view
   *
   * Shows an editable textarea for the identity text, a preset selector,
   * and a sectioned read-only preview of the full assembled system prompt.
   * @returns {HTMLElement} Properties panel element
   */
  createPropertiesPanelElement() {
    const container = createElement('div', 'system-prompt-ci-expanded');

    // All sections rendered as panels
    const sections = this._buildPreviewSections(container);
    container.appendChild(sections);

    return container;
  }

  /**
   * In-place update hook the properties panel calls (via its `_liveUpdater`)
   * for same-item changes, instead of rebuilding the panel. Rebuilding would
   * recreate the identity textarea from scratch, discarding a manual drag-resize
   * height plus the user's focus and caret — visible when the first edit flips
   * `isModified` and shifts the title scalar the panel diffs on.
   *
   * The editable textarea already reflects the user's own keystrokes, so while
   * it holds focus we leave it entirely untouched. When the change came from
   * elsewhere (preset apply, undo) and the field is not being edited, we sync its
   * value from the effective text. Returning true tells the panel the update is
   * handled and no rebuild is needed.
   * @param {HTMLElement} content - The context-item body element holding the panel
   * @returns {boolean} True — the update was handled in place
   */
  updatePropertiesPanel(content) {
    const textArea = /** @type {HTMLTextAreaElement|null} */ (
      content.querySelector('.system-prompt-textarea')
    );
    if (textArea && document.activeElement !== textArea) {
      const effective = this._getEffectiveText();
      if (textArea.value !== effective) textArea.value = effective;
    }
    return true;
  }

  /**
   * Build the sectioned preview showing all system prompt layers.
   * The Identity section is editable (preset button + textarea);
   * all other sections are read-only.
   * @private
   * @param {HTMLElement} container - Root properties panel container (for preset dropdown)
   * @returns {HTMLElement} Preview sections container
   */
  _buildPreviewSections(container) {
    const wrapper = createElement('div', 'system-prompt-preview-sections');

    // Section 1: Identity (editable — preset button + textarea)
    this._addIdentitySection(wrapper, container);

    // Section 2: Environment (strip <env> tags for display). Pin the date to
    // the conversation's creation timestamp so the preview matches the bytes
    // that get hashed (a live clock here would diverge from buildPrompt).
    const today = (this.conversation?.created || new Date().toISOString()).split('T')[0] || '';
    const envBlock = buildEnvBlock(
      this._workingDir(), this.session?.projectPath || '', this.session?.platform || '', today);
    const envDisplay = envBlock.replace(/^<env>\n?/, '').replace(/\n?<\/env>$/, '');
    this._addPreviewSection(wrapper, 'environment', t('Environment info'), envDisplay);

    // Section 3: Rules (from other system-position context items)
    const rulesContent = this._gatherRulesContent();
    if (rulesContent) {
      this._addPreviewSection(wrapper, 'rules', t('Rules'), rulesContent);
    }

    // Section 4: Extension guidance — the enabled extensions' aggregated
    // system-prompt contributions (tone, tool-preference, query_code, etc.).
    // Aggregation is async; fill the section once it resolves, or drop it.
    // Strategies contribute no system-prompt text (they inject messages), so
    // there is no strategy section here.
    const extSection = this._addPreviewSection(wrapper, 'extensions', t('Extension guidance'), t('Loading…'));
    this._fillExtensionGuidance(extSection);

    // Section 5: Tools. The prompt is only half of what the model is handed —
    // the other half is the tool list, and it is the half with no other home in
    // the document. A tool that is missing here was never offered, whatever the
    // model later claims about it.
    const toolsSection = this._addPreviewSection(wrapper, 'tools', t('Tools'), t('Loading…'));
    this._fillToolInventory(toolsSection);

    return wrapper;
  }

  /**
   * Build the Identity section with preset button and editable textarea.
   * @private
   * @param {HTMLElement} parent - Sections wrapper
   * @param {HTMLElement} container - Root properties panel container (for preset dropdown)
   */
  _addIdentitySection(parent, container) {
    const section = createElement('div', 'system-prompt-section');
    section.dataset.sectionId = 'identity';

    const header = createElement('div', 'system-prompt-section-header');
    header.textContent = t('Identity');
    section.appendChild(header);

    const body = createElement('div', 'system-prompt-section-body');

    // Editable textarea
    const textArea = document.createElement('textarea');
    textArea.className = 'system-prompt-textarea';
    textArea.placeholder = t('Enter system prompt identity text...');
    textArea.rows = 6;
    textArea.value = this._getEffectiveText();
    textArea.setAttribute('autocorrect', 'off');
    textArea.setAttribute('autocapitalize', 'off');
    textArea.spellcheck = false;

    textArea.oninput = (e) => {
      const newText = /** @type {HTMLTextAreaElement} */(e.target).value;
      this.data.text = newText;

      if (this.data.selectedPresetId) {
        this.data.isModified = true;
      }

      this._persistData();
    };

    body.appendChild(textArea);

    // Preset selector button
    const presetBtn = document.createElement('button');
    presetBtn.textContent = t('Select a preset');
    presetBtn.className = 'system-prompt-preset-btn';
    presetBtn.setAttribute('aria-haspopup', 'menu');
    presetBtn.setAttribute('aria-expanded', 'false');
    presetBtn.onclick = (e) => { e.stopPropagation(); showPresetBrowser(this, presetBtn, container); };
    body.appendChild(presetBtn);
    section.appendChild(body);
    parent.appendChild(section);
  }

  /**
   * Gather content from other system-position context items (rules etc.)
   * @private
   * @returns {string} Combined rules content
   */
  _gatherRulesContent() {
    const items = this.messageThread?.contextItems || [];
    const parts = [];

    for (const item of items) {
      const ctor = /** @type {{MANIFEST?: {contextPosition?: string}}} */ (item.constructor);
      if (ctor.MANIFEST?.contextPosition === 'system' && item.type !== 'system-prompt') {
        const text = item.data?.text;
        if (text) {
          parts.push(text);
        }
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Add a preview section with a distinct title bar and content area.
   * @private
   * @param {HTMLElement} parent - Parent container
   * @param {string} sectionId - Section identifier for updates
   * @param {string} label - Section header label
   * @param {string} content - Section content (rendered as markdown)
   * @returns {HTMLElement} The created section element
   */
  _addPreviewSection(parent, sectionId, label, content) {
    const section = createElement('div', 'system-prompt-section');
    section.dataset.sectionId = sectionId;

    const header = createElement('div', 'system-prompt-section-header');
    header.textContent = label;
    section.appendChild(header);

    const body = createElement('div', 'system-prompt-section-body');
    const textBlock = createTextBlock(content);
    body.appendChild(textBlock);
    section.appendChild(body);

    parent.appendChild(section);
    return section;
  }

  /**
   * Asynchronously fill the "Extension guidance" preview section with the
   * aggregated enabled-extension contributions. Removes the section entirely if
   * there is no contribution (so the panel doesn't show an empty box).
   * @private
   * @param {HTMLElement} section - The section element to fill or remove
   * @returns {Promise<void>}
   */
  async _fillExtensionGuidance(section) {
    try {
      const { buildExtensionSystemPromptContributions } = await import('../../../js/services/extensions.js');
      const text = await buildExtensionSystemPromptContributions();
      const body = section.querySelector('.system-prompt-section-body');
      if (!body) return;
      if (!text || !text.trim()) {
        section.remove();
        return;
      }
      body.replaceChildren(createTextBlock(text));
    } catch {
      section.remove();
    }
  }

  /**
   * Fill the Tools section with the tools this thread offers the model.
   *
   * The list comes from `buildToolInventory`, the same call the turn path uses
   * to decide what to send, so this cannot show one set while another is sent.
   * Four things are surfaced that nothing else in the UI says out loud: which
   * MCP server each tool came from, which tools the thread's strategy is holding
   * back (a withheld tool looks exactly like a missing one from the outside),
   * any MCP server that is configured but not currently serving, and whether the
   * MCP extension is switched off — in which case those servers are running,
   * healthy, and publishing to nobody.
   * @private
   * @param {HTMLElement} section - The section element to fill or remove
   * @returns {Promise<void>}
   */
  async _fillToolInventory(section) {
    const body = section.querySelector('.system-prompt-section-body');
    if (!body) return;
    try {
      const { buildToolInventory, groupToolsByOrigin, parseMcpToolName } =
        await import('../../../js/services/thread-tool-inventory.js');
      const { isMcpExtensionDisabled, MCP_DISABLED_NOTICE } =
        await import('../../../js/services/mcp-availability.js');
      const inventory = await buildToolInventory(this.messageThread);
      const servers = await this._loadMcpServerStatus();
      const drift = await this._toolDriftSinceLastTurn(inventory.offered);
      const mcpNotice = await isMcpExtensionDisabled() ? MCP_DISABLED_NOTICE : '';

      body.replaceChildren();
      body.appendChild(this._buildToolInventoryView(
        inventory, groupToolsByOrigin(inventory.offered), servers, parseMcpToolName, drift, mcpNotice
      ));
    } catch (err) {
      // Never leave "Loading…" sitting there: a panel that can't answer should
      // say so, since silence here reads as "no tools".
      body.replaceChildren(createTextBlock(
        t("Couldn't read the tool list.\n\n{error}", { error: extractErrorMessage(err) })
      ));
    }
  }

  /**
   * MCP server status, keyed by name. Best-effort: a server list we can't fetch
   * simply means no status annotations, not a broken section.
   * @private
   * @returns {Promise<Map<string, {status?: string, error?: string, toolCount?: number}>>} Status by server name
   */
  async _loadMcpServerStatus() {
    /** @type {Map<string, {status?: string, error?: string, toolCount?: number}>} */
    const byName = new Map();
    try {
      const { mcpListServers } = await import('juggler/ops');
      const res = await mcpListServers();
      for (const s of (res?.servers || [])) byName.set(String(s.name), s);
    } catch {
      // No MCP ops available (or none configured) — leave the map empty.
    }
    return byName;
  }

  /**
   * How this thread's live tool list differs from the one the last turn actually
   * sent.
   *
   * This panel renders in the viewer while turns are built in the engine worker,
   * and each holds its own MCP snapshot — so the list shown here is a
   * reconstruction, and a reconstruction that can silently disagree with what
   * was sent is worse than no panel at all. Comparing against the recorded blob
   * turns that risk into a visible statement. A difference is usually not a bug:
   * a server that finished connecting after the last turn genuinely does have
   * tools the model has not been offered yet, which is exactly the state that
   * makes a model insist a tool doesn't exist.
   * @private
   * @param {Array<any>} offered - Tools currently on offer for this thread
   * @returns {Promise<{changes: string, detail: string}|null>} The difference as a summary and its per-name detail, or null when there is nothing to compare against
   */
  async _toolDriftSinceLastTurn(offered) {
    try {
      const { findLastRoundTripTxnId } = await import('../../../js/utils/transaction-anchor.js');
      const txnId = findLastRoundTripTxnId(this.messageThread?.items);
      const convId = this.messageThread?.conversation?.id;
      if (!txnId || !convId) return null;

      const { default: workerManager } = await import('../../../js/services/worker-manager.js');
      const blob = /** @type {any} */ (await workerManager.getTransaction(convId, txnId));
      const sent = blob?.input?.tools;
      if (!Array.isArray(sent)) return null;

      const { diffToolNames, formatToolDrift, toolDriftDetail } =
        await import('../../../js/services/thread-tool-inventory.js');
      const drift = diffToolNames(sent, offered);
      return { changes: formatToolDrift(drift), detail: toolDriftDetail(drift) };
    } catch {
      // No blob, no worker, no comparison — the list still stands on its own.
      return null;
    }
  }

  /**
   * Render the inventory: a count line, one group per origin, then the withheld
   * group and any silent MCP servers.
   * @private
   * @param {{offered: Array<any>, withheld: Array<any>, strategyName: string}} inventory - What is offered and what isn't
   * @param {Array<{title: string, server: string|null, tools: Array<any>, tokens: number}>} groups - Offered tools, grouped
   * @param {Map<string, {status?: string, error?: string, toolCount?: number}>} servers - MCP status by server name
   * @param {(name: string) => {server: string, tool: string}|null} parseMcp - MCP name splitter
   * @param {{changes: string, detail: string}|null} drift - Difference from the last turn's recorded tool list
   * @param {string} [mcpNotice] - English line to show, translated, above the MCP servers (the extension being off — core's `MCP_DISABLED_NOTICE`), or '' when there is nothing to say
   * @returns {HTMLElement} The section body content
   */
  _buildToolInventoryView(inventory, groups, servers, parseMcp, drift, mcpNotice = '') {
    const wrap = createElement('div', 'system-prompt-tools');

    // The schemas are the bulk of what every turn pays before the user has
    // typed anything, and nothing else in the UI says so until after a turn has
    // been sent. Stating it here is what makes the cost of a tool — or of a
    // talkative MCP server — something you can see and act on, since this panel
    // is already where tools are switched off.
    const tokens = groups.reduce((sum, group) => sum + group.tokens, 0);
    const count = createElement('div', 'system-prompt-tools-count');
    count.textContent = t(
      '{count, plural, one {{count} tool available to the model · ~{tokens} tokens} other {{count} tools available to the model · ~{tokens} tokens}}',
      { count: inventory.offered.length, tokens: formatTokens(tokens) }
    );
    count.title = t('Estimated tokens (~4 characters per token), sent on every turn.');
    wrap.appendChild(count);

    if (drift?.changes) {
      const line = createElement('div', 'system-prompt-tools-drift');
      line.textContent = t('{changes} since the last turn — the model has not been offered this list yet.', { changes: drift.changes });
      line.title = drift.detail;
      wrap.appendChild(line);
    }

    // Servers below will read "running" whatever this says, so it goes first.
    if (mcpNotice && servers.size) {
      const line = createElement('div', 'system-prompt-tools-notice');
      line.textContent = t(mcpNotice);
      wrap.appendChild(line);
    }

    for (const group of groups) {
      const heading = createElement('div', 'system-prompt-tools-group');
      const status = group.server ? servers.get(group.server)?.status : '';
      heading.textContent = status && status !== 'running'
        ? t('{title} · ~{tokens} — {status}', { title: group.title, tokens: formatTokens(group.tokens), status: mcpStatusLabel(status) })
        : t('{title} · ~{tokens}', { title: group.title, tokens: formatTokens(group.tokens) });
      wrap.appendChild(heading);

      for (const tool of group.tools) {
        const parts = group.server ? parseMcp(String(tool?.name || '')) : null;
        wrap.appendChild(this._buildToolRow(
          String(tool?.name || ''),
          parts ? parts.tool : String(tool?.name || ''),
          String(tool?.description || ''),
          group.server
        ));
      }
    }

    // Configured MCP servers that contributed nothing. Without this the section
    // is simply missing a group, which looks identical to never having set the
    // server up at all. A running server that contributed nothing is the case
    // worth spelling out: on its own "MCP · linear — running" reads as healthy,
    // when what it means is that its tools stopped somewhere before the model.
    for (const [name, status] of servers) {
      if (groups.some((g) => g.server === name)) continue;
      const row = createElement('div', 'system-prompt-tools-silent');
      const detail = status?.error ? String(status.error).split('\n')[0] : '';
      const state = status?.status || '';
      row.textContent = t(
        '{state, select, running {MCP · {server} — running, tools not offered} none {MCP · {server} — not running} other {MCP · {server} — {status}}}{hasDetail, select, yes {: {detail}} other {}}',
        {
          state: state === 'running' ? 'running' : (state ? 'other' : 'none'),
          server: name,
          status: mcpStatusLabel(state),
          hasDetail: detail ? 'yes' : 'no',
          detail
        }
      );
      wrap.appendChild(row);
    }

    // Withheld tools get their own block below a rule, rather than one more
    // heading appended to the offered groups. These rows are built by the same
    // code as an offered tool and differ only by a strikethrough, so a scrolled
    // or narrow panel that leaves the heading off-screen reads as a list of
    // tools the model has — which is exactly the wrong conclusion.
    if (inventory.withheld.length) {
      // The strategy's manifest name, drawn as given: an extension has no
      // route to the strategy registry's scoped label.
      const by = { by: inventory.strategyName ? 'yes' : 'no', strategy: inventory.strategyName };
      const block = createElement('div', 'system-prompt-tools-withheld');
      const heading = createElement('div', 'system-prompt-tools-group');
      heading.textContent = t('{by, select, yes {Withheld by {strategy} — not offered to the model} other {Withheld — not offered to the model}}', by);
      block.appendChild(heading);
      for (const tool of inventory.withheld) {
        const name = String(tool?.name || '');
        const row = this._buildToolRow(
          name,
          name,
          String(tool?.description || ''),
          parseMcp(name)?.server ?? null,
          t('{by, select, yes {Withheld by {strategy} — the model cannot call this.} other {Withheld — the model cannot call this.}}', by)
        );
        row.classList.add('system-prompt-tool-withheld');
        block.appendChild(row);
      }
      wrap.appendChild(block);
    }

    return wrap;
  }

  /**
   * One tool row, which doubles as a link to wherever that tool is configured:
   * an MCP tool leads to its server's settings (where its per-tool checkbox
   * lives), anything else to the extension that defines it. Reading a tool's
   * name is usually the moment you want to go and do something about it.
   * @private
   * @param {string} toolName - The LLM-facing tool name
   * @param {string} label - What to show (MCP tools drop the server prefix their heading already carries)
   * @param {string} description - Tooltip text
   * @param {string|null} server - Owning MCP server, or null for a built-in
   * @param {string} [note] - Leads the tooltip when the row needs qualifying (a withheld tool reads exactly like an available one otherwise)
   * @returns {HTMLElement} The row element
   */
  _buildToolRow(toolName, label, description, server, note = '') {
    const row = createElement('button', 'system-prompt-tool');
    /** @type {HTMLButtonElement} */ (row).type = 'button';
    row.textContent = label;
    const where = server ? t('Configure "{server}"', { server }) : t('Show where this tool is defined');
    row.title = [note, description, where].filter(Boolean).join('\n\n');
    row.addEventListener('click', () => { void this._openToolDefinition(toolName, server); });
    return row;
  }

  /**
   * Send the user to where a tool is configured.
   *
   * MCP tools all share one context-item id, so the extensions catalog would
   * land every one of them on the MCP bridge itself — true, and no help at all
   * when the question is "why isn't my server's tool here". Those go to the
   * server's own settings instead; everything else goes to the extension that
   * defines it, reusing the catalog deep-link the item badges already use.
   * @private
   * @param {string} toolName - The LLM-facing tool name
   * @param {string|null} server - Owning MCP server, or null for a built-in
   * @returns {Promise<void>}
   */
  async _openToolDefinition(toolName, server) {
    const openSettings = /** @type {any} */ (globalThis).openSettings;
    if (typeof openSettings !== 'function') return;

    if (server) {
      openSettings('mcp', { mcpServer: server });
      return;
    }

    try {
      const { itemClassForTool } = await import('juggler/registry');
      const ItemClass = /** @type {any} */ (itemClassForTool(toolName));
      const id = ItemClass?.MANIFEST?.id;
      if (id) {
        openSettings('extensions', { capability: { itemType: 'context-item', id } });
        return;
      }
    } catch {
      // Fall through: the Extensions tab on its own is still a useful landing.
    }
    openSettings('extensions');
  }

  /**
   * Create context text for LLM
   *
   * System prompt context item should not be included as a context item.
   * The system prompt is built separately by the context builder.
   * @param {object} _contextParams - Runtime execution context (unused)
   * @param {number} [_contextParams.budgetHint] - Optional token budget hint for truncation
   * @param {import('juggler/context-item').ModelConfig|null} [_contextParams.modelConfig] - Model configuration
   * @param {import('../../../sdk/lib/formatting-helpers.js').FormattingHelpers} _contextParams.helpers - Formatting utilities
   * @returns {string} Empty string (not included as context item)
   */
  createContextText(_contextParams) {
    return '';
  }

  /**
   * Where this conversation's turn will actually run, for the environment block.
   *
   * The workspace root when it is bound to one, the project when it is not, and
   * `''` when the binding cannot be honoured — still being created, closed, its
   * root gone, or an id the session never heard of. That last case deliberately
   * does NOT fall back to the project: the block is the one root the model is
   * handed rather than confined by, so naming the project would have it plan
   * against a tree its own tools are refusing, which reads as the tool working.
   * The turn itself is refused server-side for the same reason.
   * @returns {string} The working directory, or '' when there is no honest answer.
   * @private
   */
  _workingDir() {
    if (!this.getWorkspaceId()) return this.session?.projectPath || '';
    return this.getWorkspaceRoot() || '';
  }

  /**
   * Build the identity and environment block of the system prompt.
   *
   * Called by context builder as the base of the system prompt.
   * Behavioral guidance is appended by context-builder from the active strategy.
   * Tool definitions are provided via native function calling API.
   * @returns {string} Identity and environment block
   */
  buildPrompt() {
    const identityText = this._getEffectiveText();
    const today = (this.conversation?.created || new Date().toISOString()).split('T')[0] || '';
    const projectPath = this.session?.projectPath || '';
    const workingDir = this._workingDir();
    if (!workingDir) {
      // Field diagnostic: an empty working directory makes the env block read
      // "Working directory: unknown", which invites the model to invent an
      // absolute path. The session should be loaded (projectPath set) before
      // any prompt is built; log if that invariant is ever violated. A bound
      // conversation whose workspace has gone reaches this honestly, and its
      // turn is refused server-side before the block can mislead anyone.
      console.warn('[SystemPrompt] building env block with no working directory — "Working directory: unknown"');
    }
    const envBlock = buildEnvBlock(workingDir, projectPath, this.session?.platform || '', today);
    return identityText + '\n\n' + envBlock;
  }
}

export default SystemPromptContextItem;
