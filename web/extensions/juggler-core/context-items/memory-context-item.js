//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
// Memory is the PROJECT's, not the workspace's: `.juggler/MEMORY.md` is a
// relative path, and a conversation working in a worktree must still remember
// what the project knows — nothing of Juggler's own is written into a workspace
// root (a fresh worktree would acquire an untracked `.juggler/`, and removing
// the tree would destroy the facts). These ops therefore run unscoped, in the
// project, which is what `this.ops` would refuse to do. `shouldAutoInstantiate`
// is static besides, and has no item to ask.
// eslint-disable-next-line no-restricted-imports
import { readFile, writeFile, stat } from 'juggler/ops';
import { createElement, injectStylesOnce } from 'juggler/ui';
import { translator, markUntranslated } from 'juggler/i18n';
import { parseMemory, appendEntry, removeEntry, removeMatching } from '../lib/memory-format.js';
import { toolActionResult } from '../lib/tool-action-result.js';

const t = translator('@juggler/core');

/**
 * Last-known-good memory content per path. A transient read failure on an
 * existing file serves this instead of '' (see `_read`), which is what stops a
 * blip from destroying the store: every write is a read-modify-write that
 * reserializes the WHOLE file, so a read that wrongly reported '' would make the
 * next `remember` overwrite every existing fact with a single bullet.
 *
 * Keyed by the FILE, not the path string (`lastGoodKey`). The default path is
 * relative, and the server resolves it against whichever project is open at
 * call time — while this module outlives a project switch, because the engine
 * is persistent across one and its registry reload gets back the same module
 * instance. Keyed by the bare path, the last project's facts would be the
 * "last-known-good" of the next project's file, so one transient read failure
 * after a switch would hand them to the next `remember`, which would write them
 * into the new project's memory. One entry per memory file used in this realm's
 * life.
 * @type {Map<string, string>}
 */
const lastGoodMemory = new Map();

/**
 * The `lastGoodMemory` key for a memory path: an absolute path as it stands, a
 * relative one qualified by the project it resolves in. Null when a relative
 * path's project is unknown, in which case nothing is cached or served — a file
 * that cannot be named cannot have a last-known-good.
 * @param {string} path - The memory path the item was given
 * @param {string|undefined} projectRoot - The open project, as the session reports it
 * @returns {string|null} The key, or null to bypass the cache
 */
function lastGoodKey(path, projectRoot) {
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return path;
  return projectRoot ? `${projectRoot}\u0000${path}` : null;
}

/**
 * Project memory — agent-writable, user-visible durable facts.
 *
 * SEMANTICS (the FILE is the store; the injected block is a per-conversation snapshot):
 *  - Persisted to `.juggler/MEMORY.md` (private, gitignored, hand-editable).
 *  - The block this conversation injects is FROZEN at seed time: when the item
 *    auto-instantiates, `onToolCall` snapshots the parsed entries into
 *    `this.data.entries` (persisted in the shared conversation doc), and
 *    `createContextText` renders that snapshot for the life of the conversation.
 *  - Injected at the `system` position, so it rides the cached system prefix.
 *    Freezing is what makes that safe. A live read would put every
 *    remember/forget — from another conversation, another tab, or a hand edit on
 *    disk — into the system block of EVERY open conversation at once, and each
 *    would then re-read its entire context at the uncached rate on its next
 *    turn. One edit, N cold conversations. A snapshot costs a running
 *    conversation nothing; the new fact reaches new conversations instead.
 *  - The properties panel reads the file LIVE. It is the curation UI: it must
 *    show what is actually stored, not what this conversation happens to inject.
 *
 * Skills freeze the same way, for the same reason — see `skill-context-item.js`.
 *
 * The single `memory` tool exposes two actions, `remember` and `forget`
 * (revise = forget + remember). Following the `plan` plugin's idiom, the
 * operations are a single tool keyed on an `action` enum rather than two
 * separately-named tools: the framework routes tool execution by MANIFEST id
 * (response-handler resolves `actionId = ActionClass.MANIFEST.id`), so the tool
 * name is not available inside `execute()` to discriminate two tools on one
 * class.
 * @class
 * @augments ContextItem
 */
class MemoryContextItem extends ContextItem {
  /** @type {import('juggler/context-item').ContextItemManifest} */
  static MANIFEST = {
    id: 'memory',
    name: 'Project Memory',
    version: '1.0.0',
    description: 'Durable, user-visible project memory the assistant maintains across conversations',
    author: 'Juggler Team',
    idPrefix: 'MEM',
    requiresApproval: false,
    userAddable: false,
    autoInstantiate: true,
    watchesFileChanges: true,
    syntheticToolName: 'memory',
    contextPosition: /** @type {const} */ ('system'),
    exampleData: { path: '.juggler/MEMORY.md' }
  };

  /** Default on-disk location for project memory (relative to project root). */
  static DEFAULT_PATH = '.juggler/MEMORY.md';

  /**
   * Badge for the remember/forget tool-ACTION (the write event). The standing
   * store card overrides the instance method below with the library glyph, so
   * the event and the store it feeds read as visually distinct items rather
   * than two identical "memory" rows.
   * @returns {{color: string, icon?: string}} Badge options
   */
  static getBadgeOptions() {
    return { color: 'memory', icon: 'icon-edit-file' };
  }

  /**
   * Badge for the standing memory STORE card — the persistent library of facts.
   * Distinct glyph from the action's edit badge (see static override above).
   * @returns {{color: string, icon?: string}} Badge options
   */
  getBadgeOptions() {
    return { color: 'memory', icon: 'icon-book' };
  }

  /**
   * A memory write is idempotent bookkeeping — re-running replays the same
   * remember/forget with nothing new to observe, so offer no "Re-run" control.
   * @returns {boolean} False — re-running this item type is a no-op.
   */
  static isRerunnable() {
    return false;
  }

  /**
   * Single `memory` tool with a remember/forget action (see class doc for why
   * a single action-keyed tool rather than two tools).
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definitions
   */
  static getToolDefinitions() {
    return [
      {
        name: 'memory',
        category: 'meta', // internal durable state, not a project-source mutation
        description:
					markUntranslated('Record or remove a durable project fact in long-term memory, injected at the start of ' +
					'every future conversation. "remember" stores one concise durable fact (a build/test ' +
					'command, a convention, a correction the user made); "forget" removes one now stale or ' +
					'wrong. NOT for ephemeral within-task state.'),
        input_schema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['remember', 'forget'],
              description: markUntranslated('Whether to add a fact ("remember") or remove matching facts ("forget")')
            },
            fact: {
              type: 'string',
              description: markUntranslated('The durable one-line fact to record (required for "remember")')
            },
            match: {
              type: 'string',
              description: markUntranslated('Case-insensitive substring identifying the entry/entries to remove (required for "forget")')
            }
          },
          required: ['action']
        }
      }
    ];
  }

  /**
   * Singleton: one memory item per thread. Reuse the existing instance.
   * @static
   * @param {Record<string, any>} _newParams - Parameters for the new request
   * @param {ContextItem[]} existingItems - All existing items of this type
   * @returns {import('juggler/context-item').MergeOrReplaceResult|null} Merge result or null to create
   */
  static mergeOrReplace(_newParams, existingItems) {
    if (existingItems.length > 0) {
      return { action: 'reuse', item: /** @type {ContextItem} */ (existingItems[0]) }; // bounded: length>0
    }
    return null;
  }

  /** @returns {string} Item title */
  getTitle() {
    return t('Project Memory');
  }

  /**
   * On-disk path for this memory instance. Defaults to the project's
   * `.juggler/MEMORY.md`; an alternate path (e.g. a global `~/.juggler/MEMORY.md`)
   * can be pinned via `data.path`, which is what makes a second, global-scope
   * instance a trivial registration later.
   * @returns {string} Resolved memory file path
   * @private
   */
  _memoryPath() {
    const path = this.data?.path;
    return (typeof path === 'string' && path) || MemoryContextItem.DEFAULT_PATH;
  }

  /** @returns {string} Today's date as `YYYY-MM-DD` */
  _today() {
    return /** @type {string} */ (new Date().toISOString().split('T')[0]); // bounded: ISO string always contains 'T'
  }

  /**
   * Determine authoritatively whether a file is genuinely absent. `stat` is
   * called WITHOUT the abort signal so existence stays checkable even when the
   * read was aborted; it returns `{exists:false}` for a missing file and does
   * not throw. If stat itself fails, existence cannot be confirmed — treat the
   * file as present (transient), not absent.
   * @param {string} path - File path
   * @returns {Promise<boolean>} True only when the file is confirmed missing
   * @private
   */
  async _fileAbsent(path) {
    try {
      const s = await stat({ path });
      return !!s && s.exists === false;
    } catch {
      return false;
    }
  }

  /**
   * Read the memory file, treating a genuinely absent file as empty. A
   * transient IO failure on an EXISTING file is not a state change, and must
   * never be reported as one: `execute` feeds this straight into `appendEntry` /
   * `removeMatching`, which reserialize the entire file from what they are
   * given, so returning '' for a file that does exist would silently delete
   * every stored fact on the next write. Serving the last-known-good content
   * keeps the read-modify-write honest.
   * @param {string} path - File path
   * @returns {Promise<string>} File content, last-known-good, or ''
   * @private
   */
  async _read(path) {
    const key = lastGoodKey(path, this.session?.projectPath);
    try {
      const r = await readFile({ path }, this.signal);
      const content = r && typeof r.content === 'string' ? r.content : '';
      if (key) lastGoodMemory.set(key, content);
      return content;
    } catch {
      // Genuine absence (ENOENT) returns '' — and any stale cache is dropped.
      if (await this._fileAbsent(path)) {
        if (key) lastGoodMemory.delete(key);
        return '';
      }
      // Existing-but-unreadable (or existence unconfirmable): serve last-good.
      return (key && lastGoodMemory.get(key)) ?? '';
    }
  }

  /**
   * Write the memory file. The backend `writeFile` creates parent directories
   * as needed, so a brand-new `.juggler/MEMORY.md` is created on first write.
   * @param {string} path - File path
   * @param {string} content - Canonical content to write
   * @returns {Promise<void>}
   * @private
   */
  async _write(path, content) {
    // The memory path is app-configured (never an LLM-invented path), so it is
    // trusted even when it resolves outside the project root (e.g. a global
    // ~/.juggler/MEMORY.md). Mark it approved so the backend's out-of-scope
    // write guard admits it; for the default in-project path this is a no-op.
    await writeFile({ path, content, outOfRootApproved: true });
    // A successful write is the new last-known-good for transient-failure reads.
    const key = lastGoodKey(path, this.session?.projectPath);
    if (key) lastGoodMemory.set(key, content);
  }

  /**
   * Gate for auto-instantiation: only seed a memory item when the file already
   * exists, so empty projects gain no item (and unrelated conversations stay
   * unchanged). A first `remember` creates the file but adds no item to its own
   * conversation, whose system prompt stays as it began; from then on new
   * conversations seed it here. Mirrors how CLAUDE.md is auto-added only when
   * present.
   * @param {string} [path] - Path to probe (defaults to the project memory file)
   * @returns {Promise<boolean>} True if the memory file exists
   */
  static async shouldAutoInstantiate(path = MemoryContextItem.DEFAULT_PATH) {
    try {
      const s = await stat({ path });
      return !!(s && s.exists);
    } catch {
      return false;
    }
  }

  /**
   * Seed the memory item by FREEZING the stored entries into the conversation
   * doc. Runs when the item auto-instantiates at the start of a conversation
   * (via executeContextItem → handleToolCall). Write-once: a later reuse
   * (mergeOrReplace) that re-enters
   * here keeps the original snapshot, so the injected block — and the cached
   * system prefix it rides — never moves under a running conversation.
   * @param {string} _toolName - Tool name (unused)
   * @param {Record<string, any>} _params - Tool parameters (unused)
   * @returns {Promise<void>}
   */
  async onToolCall(_toolName, _params) {
    if (!Array.isArray(this.data.entries)) {
      this.data.entries = await this._snapshotEntries();
    }
  }

  /**
   * Project the stored file to the minimal record frozen into the doc: one
   * `{date, text}` row per entry, exactly what the block renders. Kept small so
   * the persisted snapshot stays compact and its serialization stable — an
   * absent date is stored as `''` rather than null to keep the round-trip
   * through the doc plain-JSON.
   * @returns {Promise<Array<{date: string, text: string}>>} Snapshot rows
   * @private
   */
  async _snapshotEntries() {
    const { entries } = parseMemory(await this._read(this._memoryPath()));
    return entries.map((e) => ({ date: e.date || '', text: e.text }));
  }

  /**
   * The entries this conversation advertises: the FROZEN snapshot captured at
   * seed time (`this.data.entries`). Falls back to a live read only when no
   * snapshot was recorded (a direct call that skipped seeding, e.g. a unit
   * test), so those paths still work without a doc round-trip.
   * @returns {Promise<Array<{date: string|null, text: string}>>} Advertised entries
   * @private
   */
  async _effectiveEntries() {
    if (Array.isArray(this.data.entries)) {
      return /** @type {any} */ (this.data.entries);
    }
    const { entries } = parseMemory(await this._read(this._memoryPath()));
    return entries;
  }

  /**
   * Validate tool parameters.
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    const action = toolInput.action;
    if (action !== 'remember' && action !== 'forget') {
      return { valid: false, error: markUntranslated('Parameter "action" must be "remember" or "forget"') };
    }
    if (action === 'remember') {
      const fact = toolInput.fact;
      if (typeof fact !== 'string' || fact.trim() === '') {
        return { valid: false, error: markUntranslated('remember requires a non-empty "fact"') };
      }
    } else {
      const match = toolInput.match;
      if (typeof match !== 'string' || match === '') {
        return { valid: false, error: markUntranslated('forget requires a "match" string') };
      }
    }
    return { valid: true, params: toolInput };
  }

  /**
   * Memory writes are frictionless — never gated behind approval.
   * @override
   * @param {Record<string, unknown>} _toolInput - Tool input parameters
   * @returns {boolean} Always true
   */
  isPermitted(_toolInput) {
    return true;
  }

  /**
   * Execute a remember/forget action against the on-disk memory file. Only the
   * file changes: this conversation's block, or its absence when the
   * conversation began without a memory item, stays exactly as it was, because
   * adding one mid-conversation would move the cached system prefix. The write
   * reaches new conversations.
   * @param {Record<string, any>} params - Validated params
   * @returns {Promise<{action: string, fact?: string, match?: string, removed?: string[], entryCount: number}>} Result
   */
  async execute(params) {
    const path = this._memoryPath();
    const existing = await this._read(path);

    if (params.action === 'remember') {
      const fact = String(params.fact || '').trim();
      const updated = appendEntry(existing, fact, this._today());
      await this._write(path, updated);
      return { action: 'remember', fact, entryCount: parseMemory(updated).entries.length };
    }

    if (params.action === 'forget') {
      const match = String(params.match || '');
      const { content, removed } = removeMatching(existing, match);
      await this._write(path, content);
      return { action: 'forget', match, removed, entryCount: parseMemory(content).entries.length };
    }

    throw new Error(markUntranslated(`Unknown memory action: ${params.action}`));
  }

  /**
   * Format the outcome for the LLM tool_result and simple display.
   * @override
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    if (!outcome.success) {
      return this.failureSummary(markUntranslated(`Memory update failed: ${outcome.error}`));
    }
    const r = /** @type {{action?: string, fact?: string, match?: string, removed?: string[]}} */ (outcome.result || {});
    if (r.action === 'forget') {
      if (!r.removed || r.removed.length === 0) {
        return this.successSummary(markUntranslated(`No memory entry matched "${r.match}"`));
      }
      const noun = r.removed.length === 1 ? 'entry' : 'entries';
      return this.successSummary(markUntranslated(`Forgot ${r.removed.length} memory ${noun}: ${r.removed.join('; ')}`));
    }
    return this.successSummary(markUntranslated(`Remembered: ${r.fact}`));
  }

  /**
   * Render the memory block for the system prompt from the FROZEN snapshot
   * captured at seed time, so the block is byte-stable across every turn,
   * reload, and viewer of this conversation and rides the prompt cache. It
   * reflects what memory held when this conversation started; later writes
   * anywhere reach NEW conversations. Empty/absent memory contributes nothing.
   * @override
   * @param {object} _contextParams - Runtime execution context (unused)
   * @returns {Promise<string>} Context text, or '' when there are no entries
   */
  async createContextText(_contextParams) {
    const entries = await this._effectiveEntries();
    if (entries.length === 0) {
      return '';
    }
    const lines = entries.map((e) => (e.date ? `- [${e.date}] ${e.text}` : `- ${e.text}`));
    return markUntranslated(
      '=== Project Memory ===\n' +
			'Durable facts you have recorded for this project (maintained via the memory tool):\n\n' +
			lines.join('\n')
    );
  }

  /**
   * Status UI. With no actionStatus this is the persistent item card; with one
   * it is a remember/forget tool-action.
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} [actionStatus] - Execution status
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config
   */
  getStatusUI(actionStatus) {
    // Standing store card: state, not an event. Names what it is and that it
    // reaches the model, so it never reads as a duplicate of the action below.
    if (!actionStatus) {
      return { typeName: t('Project Memory'), summary: t('Durable facts — in context since this conversation began') };
    }
    // Tool-action row: the write event. A verb typeName ('Remember'/'Forget')
    // plus the edit badge distinguishes it from the 'Project Memory' store.
    // Built from the structured `result` (what `execute` returned, as stored),
    // never from `content`, which is the model's English. Storage keeps a
    // `removed` list of more than five as `removedCount` alone.
    if (actionStatus.success) {
      const r = /** @type {{action?: string, fact?: string, match?: string, removed?: string[], removedCount?: number}} */ (actionStatus.result || {});
      if (r.action === 'forget') {
        const match = r.match ?? '';
        let summary;
        if (r.removed && r.removed.length) {
          summary = r.removed.join('; ');
        } else if (typeof r.removedCount === 'number' && r.removedCount > 0) {
          summary = t('Removed {count, plural, one {# entry} other {# entries}} matching “{match}”.', { count: r.removedCount, match });
        } else {
          summary = t('No match for “{match}”', { match });
        }
        return { typeName: t('Forget'), summary, status: /** @type {const} */ ('success') };
      }
      return { typeName: t('Remember'), summary: `${r.fact}`, status: /** @type {const} */ ('success') };
    }
    if (actionStatus.error) {
      // The model's English error, shown as it was.
      return { typeName: t('Memory'), summary: actionStatus.error, status: /** @type {const} */ ('error') };
    }
    return { typeName: t('Memory'), summary: t('Memory') };
  }

  /**
   * Properties panel for a remember/forget tool-ACTION (the write event).
   * Renders a purpose-built view of what was remembered/forgotten — never the
   * raw JSON request that the default `renderToolActionDetails` dumps, and
   * never the current-memory list (that lives on the standing 'Project Memory'
   * store card). Owns its whole display, so the generic Result section is
   * suppressed.
   * @override
   * @param {HTMLElement} wrapper - Section wrapper to append into
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx - Render context
   * @returns {{skipResultSection: boolean}} Always suppresses the generic result section
   */
  renderToolActionDetails(wrapper, ctx) {
    const { toolAction, input } = ctx;
    const result = toolActionResult(toolAction);
    const fullResult = result.fullResult;
    const resultData = fullResult?.result;
    /** @type {Record<string, unknown>} */
    const data = resultData && typeof resultData === 'object' ? /** @type {Record<string, unknown>} */ (resultData) : {};
    const action = input.action || data.action;

    const panel = createElement('div', 'memory-action');

    /**
     * @param {string} label - Chip text
     * @param {string} kind - 'add' | 'remove' for accent colour
     * @returns {HTMLElement} Verb chip element
     */
    const verbChip = (label, kind) => createElement('div', `memory-action-verb memory-action-verb--${kind}`, label);
    /**
     * @param {string} text - Fact / message text
     * @param {string} [extra] - Optional extra class (e.g. 'muted')
     * @returns {HTMLElement} Fact block element
     */
    const factBlock = (text, extra) => createElement('div', `memory-action-fact${extra ? ' ' + extra : ''}`, text);

    // Terminal failure / cancellation — show the outcome, nothing else.
    if (result.isError || result.cancelled) {
      const banner = createElement(
        'div',
        `memory-action-banner ${result.cancelled ? 'cancelled' : 'error'}`,
        // An error is the model's English, shown as it was.
        result.cancelled ? t('Cancelled') : (fullResult?.error || result.content || t('Memory update failed'))
      );
      panel.appendChild(banner);
      wrapper.appendChild(panel);
      return { skipResultSection: true };
    }

    if (action === 'forget') {
      const match = input.match ?? data.match ?? '';
      const removed = Array.isArray(data.removed) ? data.removed : null;
      const removedCount = removed ? removed.length
        : (typeof data.removedCount === 'number' ? data.removedCount : null);

      if (removedCount === 0) {
        panel.appendChild(verbChip(t('No change'), 'remove'));
        panel.appendChild(factBlock(t('No memory entry matched “{match}”.', { match }), 'muted'));
      } else {
        panel.appendChild(verbChip(t('Forgot'), 'remove'));
        if (removed) {
          const ul = createElement('ul', 'memory-action-removed');
          for (const text of removed) ul.appendChild(createElement('li', '', text));
          panel.appendChild(ul);
        } else {
          const count = removedCount ?? 0;
          panel.appendChild(factBlock(t('Removed {count, plural, one {# entry} other {# entries}} matching “{match}”.', { count, match })));
        }
      }
    } else {
      // remember (default)
      panel.appendChild(verbChip(t('Remembered'), 'add'));
      panel.appendChild(factBlock(String(input.fact ?? data.fact ?? '')));
    }

    const entryCount = typeof data.entryCount === 'number' ? data.entryCount : null;
    const note = entryCount === null
      ? t('Project memory is carried into every new conversation.')
      : t('Project memory now holds {count, plural, one {# fact} other {# facts}}. New conversations start with all of them.', { count: entryCount });
    panel.appendChild(createElement('div', 'memory-action-note', note));

    wrapper.appendChild(panel);
    return { skipResultSection: true };
  }

  /**
   * Properties panel: the user-facing view of exactly what is in memory, with
   * per-entry delete. Reads the file live and re-renders after edits.
   * @override
   * @returns {HTMLElement} Panel element
   */
  createPropertiesPanelElement() {
    const container = createElement('div', 'memory-ci-expanded');
    // Fire-and-forget async populate (sync signature, like file-content).
    this._renderPanel(container);
    return container;
  }

  /**
   * Populate (or refresh) the panel from the live file.
   * @param {HTMLElement} container - Panel container to fill
   * @returns {Promise<void>}
   * @private
   */
  async _renderPanel(container) {
    const content = await this._read(this._memoryPath());
    const { entries } = parseMemory(content);
    container.textContent = '';

    container.appendChild(
      createElement('div', 'memory-panel-note', t('Durable facts the assistant maintains across conversations. Shown live from {file}; each conversation is given the list as it stood when that conversation began, so changes here reach new conversations. Delete entries here, or edit the file by hand.', { file: this._memoryPath() }))
    );

    if (entries.length === 0) {
      container.appendChild(
        createElement('div', 'memory-empty', t('No facts recorded yet.'))
      );
      return;
    }

    const list = createElement('ul', 'memory-list');
    for (const entry of entries) {
      const li = createElement('li', 'memory-entry');
      if (entry.date) {
        li.appendChild(createElement('span', 'memory-date', entry.date));
      }
      li.appendChild(createElement('span', 'memory-text', entry.text));

      const del = document.createElement('button');
      del.className = 'memory-delete icon-btn';
      del.title = t('Forget this');
      del.innerHTML = '<span class="icon-trashcan"></span>';
      del.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const cur = await this._read(this._memoryPath());
        const { content: next } = removeEntry(cur, entry);
        await this._write(this._memoryPath(), next);
        this._renderPanel(container);
      });
      li.appendChild(del);

      list.appendChild(li);
    }
    container.appendChild(list);
  }

  /**
   * Nudge the host to re-render this item's UI when the memory file changes
   * externally (a remember in another tab, or a hand edit). The INJECTED block
   * is deliberately unaffected — it is the snapshot frozen at seed time, and
   * moving it here is precisely the cross-conversation cache bust the freeze
   * exists to prevent. Only the panel, which reads the file live, shows the
   * change.
   * @param {string} changedPath - Path that changed
   */
  onFileChange(changedPath) {
    if (typeof changedPath === 'string' && changedPath.replace(/\\/g, '/').endsWith('MEMORY.md')) {
      if (typeof this.onContentChange === 'function') {
        this.onContentChange();
      }
    }
  }
}

const MEMORY_STYLES = `
.memory-ci-expanded { display: flex; flex-direction: column; gap: 0.5rem; }
.memory-panel-note {
  font-size: var(--font-size-sm); line-height: 1.5;
  color: var(--text-tertiary, var(--text-secondary));
}
.memory-empty {
  padding: 1rem; font-size: var(--font-size-base);
  color: var(--context-item-text-secondary, var(--text-secondary));
}

/* Remember/forget tool-action properties panel */
.memory-action { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.25rem 0; }
.memory-action-verb {
  align-self: flex-start;
  font-size: var(--font-size-xs); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
  padding: 0.125rem 0.5rem; border-radius: var(--radius-pill);
  background: var(--bg-raised, rgba(127, 127, 127, 0.15));
  color: var(--text-secondary);
}
.memory-action-verb--add { color: var(--accent-green); }
.memory-action-verb--remove { color: var(--accent-red); }
.memory-action-fact {
  font-size: var(--font-size-md); line-height: 1.5;
  color: var(--context-item-text, var(--text-primary));
  padding: 0.5rem 0.75rem; border-radius: var(--radius-lg);
  background: var(--bg-secondary, rgba(127, 127, 127, 0.08));
  border-left: 2px solid var(--ci-family-memory, #c2410c);
  white-space: pre-wrap; word-break: break-word;
}
.memory-action-fact.muted {
  color: var(--text-tertiary, var(--text-secondary));
  font-style: italic; border-left-color: transparent;
}
.memory-action-removed { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.25rem; }
.memory-action-removed li {
  font-size: var(--font-size-base); line-height: 1.5;
  color: var(--text-secondary);
  padding: 0.375rem 0.625rem; border-radius: var(--radius-lg);
  background: var(--bg-secondary, rgba(127, 127, 127, 0.08));
  text-decoration: line-through; text-decoration-color: var(--accent-red);
}
.memory-action-note { font-size: var(--font-size-sm); color: var(--text-tertiary, var(--text-secondary)); }
.memory-action-banner { font-size: var(--font-size-base); line-height: 1.5; padding: 0.5rem 0.75rem; border-radius: var(--radius-lg); }
.memory-action-banner.error { color: var(--accent-red); background: rgba(248, 81, 73, 0.1); }
.memory-action-banner.cancelled { color: var(--text-secondary); background: var(--bg-secondary, rgba(127, 127, 127, 0.08)); }
.memory-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.375rem; }
.memory-entry {
  display: flex; align-items: baseline; gap: 0.5rem;
  font-size: var(--font-size-base); line-height: 1.5;
  color: var(--context-item-text, var(--text-primary));
}
.memory-date {
  flex-shrink: 0; font-family: var(--font-mono); font-size: var(--font-size-xs);
  opacity: 0.6; white-space: nowrap;
}
.memory-text { flex: 1; min-width: 0; }
.memory-delete { flex-shrink: 0; opacity: 0.5; transition: opacity 0.15s; }
.memory-delete:hover { opacity: 1; }
`;

injectStylesOnce('memory-styles', MEMORY_STYLES);

export default MemoryContextItem;
