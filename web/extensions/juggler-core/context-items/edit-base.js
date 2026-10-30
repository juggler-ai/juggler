//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { formatDisplayPath } from 'juggler/item-utils';
import { isPathInsideAllowedRoots, canonicalRoot } from 'juggler/utils/path-containment';
import { renderWriteFilePermissionSection } from './edit/permission-section.js';
import { tildeify } from './path-approval.js';
import { translator, markUntranslated } from 'juggler/i18n';
import { uploadAssetText } from 'juggler/ops';

const t = translator('@juggler/core');

/**
 * The single `itemType` used by every edit-family plugin. The rule shape is
 * `{kind: 'boolean', value: true|false}`; a single enabled rule means "allow
 * file writes". We use one shared itemType so the toggle in the UI affects
 * write-file / replace-text / etc. uniformly, matching the previous UX.
 */
const EDIT_ITEM_TYPE = 'write-file';

/**
 * Common parameter aliases for edit operations.
 * LLMs may use various names for the same parameter.
 */
const OLD_CONTENT_ALIASES = ['old_str', 'oldContent', 'old', 'pattern', 'search', 'oldText', 'searchText'];
const NEW_CONTENT_ALIASES = ['new_str', 'newContent', 'new', 'replacement', 'replace', 'newText', 'replacementText', 'content', 'text', 'new_content'];

/**
 * Base class for all file editing actions
 * Provides common validation, diff handling, and result formatting
 * @abstract
 */
class EditBase extends ContextItem {
  /** @returns {{allowedScopes: Array<'conversation'>, defaultScope: 'conversation'}} Permission scope policy */
  static getPermissionScopePolicy() {
    return { allowedScopes: ['conversation'], defaultScope: 'conversation' };
  }

  /**
   * Normalize a parameter by checking for known aliases.
   * Returns the value from the first matching alias, or undefined if none found.
   * @protected
   * @param {Record<string, any>} params - Raw parameters
   * @param {string[]} aliases - List of aliases to check (in priority order)
   * @param {string} [prefixFallback] - Optional prefix for fallback matching (e.g., 'old', 'new')
   * @returns {any} The parameter value, or undefined if not found
   */
  static _findParamByAlias(params, aliases, prefixFallback) {
    // Check explicit aliases first
    for (const alias of aliases) {
      if (params[alias] !== undefined) {
        return params[alias];
      }
    }
    // Fallback: check for any param starting with prefix
    if (prefixFallback) {
      const key = Object.keys(params).find(k => k.toLowerCase().startsWith(prefixFallback.toLowerCase()));
      if (key) {
        return params[key];
      }
    }
    return undefined;
  }

  /**
   * Normalize old content parameter from various aliases to a standard field.
   * Accepts: old_str, oldContent, old, pattern, search, oldText, searchText
   * @protected
   * @param {Record<string, any>} params - Raw parameters
   * @returns {string|undefined} Normalized old content value
   */
  static _normalizeOldContent(params) {
    return EditBase._findParamByAlias(params, OLD_CONTENT_ALIASES, 'old');
  }

  /**
   * Normalize new content parameter from various aliases to a standard field.
   * Accepts: new_str, newContent, new, replacement, replace, newText, etc.
   * @protected
   * @param {Record<string, any>} params - Raw parameters
   * @returns {string|undefined} Normalized new content value
   */
  static _normalizeNewContent(params) {
    return EditBase._findParamByAlias(params, NEW_CONTENT_ALIASES, 'new');
  }

  /**
   * Get permission key for file editing actions
   *
   * All file editing actions use 'write-file' permission.
   * @override
   * @param {Record<string, unknown>} _toolInput - Tool input (unused)
   * @returns {string} Permission key
   */
  getPermissionKey(_toolInput) {
    return 'write-file';
  }

  /**
   * Extract the target path from a tool input, tolerating the `file_path`
   * alias LLMs sometimes emit (mirrors {@link normalizeFilePath} without
   * mutating the caller's object). Returns '' when no usable path is present.
   * @protected
   * @param {Record<string, unknown>} toolInput - Tool input parameters
   * @returns {string} The target path, or '' if none
   */
  static _editPath(toolInput) {
    if (!toolInput || typeof toolInput !== 'object') return '';
    const p = toolInput.path ?? toolInput.file_path;
    return typeof p === 'string' ? p : '';
  }

  /**
   * Does this write target sit inside the project root or the user's standing
   * allowed-paths grant? A path we can't read is treated as out-of-root so the
   * write prompts.
   * @protected
   * @param {string} path - Target path
   * @returns {boolean} True if the path is within an allowed root
   */
  _isPathAllowed(path) {
    if (!path) return false;
    const mt = this.messageThread;
    if (!mt) return false;
    return isPathInsideAllowedRoots(
      path,
      mt.getAllowedPaths(),
      this.session?.home || '',
      this.session?.platform || ''
    );
  }

  /**
   * Wrap a backend edit-family write so the backend's defence-in-depth check
   * (AuthorizeOutOfScopeWrite) admits it: `outOfRootApproved:true` is added to
   * params ONLY when the target is outside the allowed roots. Reaching execute()
   * at all means approval was granted — {@link isPermitted} rejects out-of-root
   * standing rules, so an out-of-root write can only arrive here via an explicit
   * modal approval, and the action-executor throws before execute() otherwise.
   * So this marks a genuinely user-approved write without ever trusting a
   * standing rule.
   *
   * The grant itself is not returned, because it is not this call's to describe:
   * the write goes out through `this.ops`, which carries the explicit grants and
   * the workspace the item works in. Adding the implicit root on top of those
   * would be redundant — the backend roots that write's PathScope at the
   * workspace (or the project) itself — and carries the hazard
   * `getToolAllowedRoots` exists to avoid: an engine that has outlived a project
   * switch holds the PREVIOUS root, and would re-authorise writes across the old
   * tree.
   * @protected
   * @param {Record<string, any>} params - Backend op params (must include `path`)
   * @returns {Record<string, any>} The params to send
   */
  _authorizeWrite(params) {
    const path = typeof params?.path === 'string' ? params.path : '';
    if (path && !this._isPathAllowed(path)) {
      return { ...params, outOfRootApproved: true };
    }
    return params;
  }

  /**
   * Check if write-file actions are auto-approved.
   *
   * TWO conditions must both hold: (1) an enabled `{kind:'boolean', value:true}`
   * rule exists under the shared `write-file` itemType (the "allow file edits"
   * toggle), AND (2) the target path resolves inside the project root or the
   * user's allowed-paths grant. The toggle alone is deliberately NOT sufficient
   * for an out-of-root write: otherwise one "don't ask again" on an innocuous
   * in-project write would silently auto-approve writes to `C:\`, `~`, or
   * anywhere on disk (issues #23/#24). An out-of-root write always prompts until
   * the user explicitly grants that folder.
   * @override
   * @param {Record<string, unknown>} toolInput - Tool input parameters
   * @returns {boolean} True if the write is auto-approved
   */
  isPermitted(toolInput) {
    const mt = this.messageThread;
    if (!mt) return false;
    const toggleOn = mt.getRulesFor(EDIT_ITEM_TYPE)
      .some(r => r.kind === 'boolean' && r.value === true && r.scope !== 'session');
    if (!toggleOn) return false;
    return this._isPathAllowed(EditBase._editPath(toolInput));
  }

  /**
   * Directory portion of a path, handling both `/` and `\` separators (the
   * backend reports native OS paths).
   * @protected
   * @param {string} p - File path
   * @returns {string} The parent directory, or '' if none
   */
  static _dirname(p) {
    if (!p) return '';
    const trimmed = p.replace(/[/\\]+$/, '');
    const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    return idx <= 0 ? '' : trimmed.slice(0, idx);
  }

  /**
   * Offer "don't ask again" choices for a write that isn't yet auto-approved.
   *
   * In-root writes (or writes whose path we can't read) need only the shared
   * "allow file edits" toggle, so there is a single suggestion — same as the
   * original single-toggle UX.
   *
   * An out-of-root write is different: the toggle alone will NOT auto-approve
   * it (see {@link isPermitted}), so we offer, narrowest first:
   *   1. allow file edits AND add this file's folder to the allowed paths — the
   *      grant that actually stops future prompts here (and, since the list is
   *      shared, widens shell access too). Only offered when the folder
   *      canonicalises to a grantable absolute root ({@link canonicalRoot}
   *      returns null for `~`, `$`-bearing, over-broad, or Windows drive paths).
   *   2. allow file edits only — which will keep prompting for this and other
   *      out-of-root writes; the label says so.
   *
   * Returns `[]` when the write is already permitted (no prompt appears).
   *
   * The labels are UI text: the buttons are built in the engine, which follows
   * the UI language, and stored with the item, so they are translated here.
   * @override
   * @param {Record<string, unknown>} toolInput - Tool input parameters
   * @returns {import('juggler/context-item').ApprovalSuggestion[]} Suggestions, narrowest first
   */
  getApprovalSuggestions(toolInput) {
    if (!this.messageThread || this.isPermitted(toolInput)) return [];
    /** @type {{kind: 'boolean', value: true, scope: 'conversation'}} */
    const allowRule = { kind: 'boolean', value: true, scope: 'conversation' };
    const path = EditBase._editPath(toolInput);

    // In-root (toggle merely off) or path unknown: the write only needs the
    // file-edit toggle.
    if (!path || this._isPathAllowed(path)) {
      return [{ itemType: EDIT_ITEM_TYPE, rules: [allowRule], label: t('file edits') }];
    }

    // Out-of-root: two tiers.
    const home = this.session?.home || '';
    /** @type {import('juggler/context-item').ApprovalSuggestion[]} */
    const suggestions = [];
    const folder = canonicalRoot(EditBase._dirname(path), home);
    if (folder) {
      suggestions.push({
        itemType: EDIT_ITEM_TYPE,
        rules: [allowRule],
        allowedPaths: [folder],
        label: t('file edits + allow {folder}', { folder: tildeify(folder, home) })
      });
    }
    suggestions.push({
      itemType: EDIT_ITEM_TYPE,
      rules: [allowRule],
      label: t('file edits (writes outside the project still prompt)')
    });
    return suggestions;
  }

  /**
   * Render the file-write permission UI for the permission-controls popup.
   * Lazy-loads the section module to avoid pulling the DOM-touching code
   * into worker / engine contexts that never call this method.
   * @override
   * @param {import('../../../js/model/message-thread.js').MessageThread} messageThread Owning thread
   * @returns {{id: string, element: HTMLElement, dispose: () => void}} Permission section
   */
  static getPermissionSection(messageThread) {
    return renderWriteFilePermissionSection(messageThread);
  }

  /**
   * Build standard approval config for edit actions
   * @protected
   * @param {string} path - File path being edited
   * @param {{startLineNumber?: number} & Record<string, unknown>} diffData - Diff data, sides inline or
   *   stored (see {@link EditBase#_storeDiffSnapshot})
   * @returns {import('juggler/context-item').ApprovalConfig} Approval config
   */
  _buildApprovalConfig(path, diffData) {
    // When the target is outside the project root + allowed paths, make that
    // unmistakable: show the full absolute path as the title (not `./`-prefixed,
    // which would read as project-relative) and a warning message. This is
    // exactly the case #24 needed the user to notice.
    const outOfRoot = path && !this._isPathAllowed(path);
    return {
      title: outOfRoot ? path : formatDisplayPath(path),
      message: outOfRoot ? t('⚠ Write outside the project folder: {path}', { path }) : '',
      display: {
        diffData: {
          ...diffData,
          path: path,
          startLineNumber: diffData.startLineNumber || 1
        }
      }
    };
  }

  /**
   * The diff to record for a change from `oldContent` to `newContent`. Each
   * non-empty side is stored as a text asset in the conversation's asset store
   * and named by its id (`oldRef` / `newRef`), so the conversation carries the
   * ids and the line counts rather than the whole file twice; identical text is
   * stored once however many edits name it. An empty side stays inline as ''.
   *
   * Storing is an optimisation, never a reason for the edit to fail: with no
   * conversation to store into, or if either upload fails, both sides are kept
   * inline, which every reader draws as well.
   * @protected
   * @param {string} path - The file's path
   * @param {string} oldContent - The whole file before
   * @param {string} newContent - The whole file after
   * @param {number} [startLineNumber=1] - The first line's number
   * @returns {Promise<Record<string, unknown>>} The diffData
   */
  async _storeDiffSnapshot(path, oldContent, newContent, startLineNumber = 1) {
    const inline = { oldContent, newContent, path, startLineNumber };
    const conversationId = this.conversation?.id;
    if (!conversationId) return inline;
    const store = (/** @type {string} */ text) => (text === ''
      ? Promise.resolve(null)
      : uploadAssetText(conversationId, text, this.signal).then((ref) => ref.id));
    let refs;
    try {
      refs = await Promise.all([store(oldContent), store(newContent)]);
    } catch (error) {
      console.warn(`[edit] diff kept inline, storing it failed: ${error instanceof Error ? error.message : String(error)}`);
      return inline;
    }
    const [oldRef, newRef] = refs;
    const stats = EditBase._lineStats(oldContent, newContent);
    return {
      ...(oldRef ? { oldRef } : { oldContent: '' }),
      ...(newRef ? { newRef } : { newContent: '' }),
      path,
      startLineNumber,
      ...(stats ? { added: stats.added, removed: stats.removed } : {})
    };
  }

  /**
   * Format edit result with standard structure
   * @protected
   * @param {string} path - File path that was edited
   * @param {string} details - Detailed description of what was edited
   * @returns {import('juggler/context-item').ItemSummary} Formatted result object for display
   */
  _formatEditResult(path, details) {
    return this.successSummary(markUntranslated(`Edited file: ${path}`), { details });
  }

  /**
   * Count the lines added and removed between two versions of a file, using the
   * same LCS-of-lines notion as the diff viewer (equal lines are the longest
   * common subsequence; everything else is an add or a remove). Cheap to render
   * as a `+A / -B` diffstat beside the filename.
   *
   * The common leading/trailing lines are trimmed before the LCS pass, so the
   * cost scales with the size of the *changed region*, not the whole file — a
   * two-line edit in an 8,000-line file diffs two lines, not eight thousand.
   * Returns null only if the differing region itself is pathologically large,
   * in which case the caller omits the indicator rather than stalling.
   * @protected
   * @param {string|undefined|null} oldText - Previous file content ('' / nullish = new file)
   * @param {string|undefined|null} newText - Written file content
   * @returns {{added: number, removed: number}|null} Line diffstat, or null if too large
   */
  static _lineStats(oldText, newText) {
    // Strip a single trailing newline before splitting so a file's terminating
    // newline doesn't count as an extra empty line — otherwise a brand-new
    // 3-line file (ending in `\n`) would report `+4`. Doing it to both sides
    // keeps unchanged trailing content cancelling out in the LCS.
    const norm = (/** @type {string|undefined|null} */ t) => (t ? String(t).replace(/\n$/, '') : '');
    const o = norm(oldText);
    const nw = norm(newText);
    const oldLines = o === '' ? [] : o.split('\n');
    const newLines = nw === '' ? [] : nw.split('\n');

    // Trim the common prefix and suffix: identical leading/trailing lines are
    // part of the LCS and contribute nothing to added/removed, so dropping them
    // is lossless and shrinks the LCS table to just the changed span. This is
    // what lets a small edit inside a huge file stay cheap enough to show.
    let lo = 0;
    let oHi = oldLines.length;
    let nHi = newLines.length;
    while (lo < oHi && lo < nHi && oldLines[lo] === newLines[lo]) lo++;
    while (oHi > lo && nHi > lo && oldLines[oHi - 1] === newLines[nHi - 1]) { oHi--; nHi--; }

    const m = oHi - lo;
    const n = nHi - lo;
    if (m === 0) return { added: n, removed: 0 };
    if (n === 0) return { added: 0, removed: m };
    // Guard against a genuinely huge changed region (e.g. a full rewrite of a
    // large file): the LCS table is O(m·n). Past this budget skip the stat
    // rather than block the UI.
    if (m * n > 6_000_000) return null;

    // LCS length via a rolling row (we only need the count, not the alignment).
    let prev = new Array(n + 1).fill(0);
    for (let i = 1; i <= m; i++) {
      const cur = new Array(n + 1).fill(0);
      const oi = oldLines[lo + i - 1];
      for (let j = 1; j <= n; j++) {
        cur[j] = oi === newLines[lo + j - 1]
          ? /** @type {number} */ (prev[j - 1]) + 1
          : Math.max(/** @type {number} */ (prev[j]), /** @type {number} */ (cur[j - 1]));
      }
      prev = cur;
    }
    const lcs = /** @type {number} */ (prev[n]);
    return { added: n - lcs, removed: m - lcs };
  }

  /**
   * Derive a `{added, removed}` line diffstat for a completed edit's status
   * tile. Prefers the counts a stored diff records, then the diff/content
   * preview persisted inline in `displayData` (items written before the sides
   * were stored apart), and falls back to the `linesAdded`/`linesRemoved` the
   * action recorded at execute time.
   * @protected
   * @param {any} displayData - The tool-action displayData (diffData / contentData)
   * @param {any} result - The action result (may carry linesAdded/linesRemoved)
   * @returns {{added: number, removed: number}|null} Line diffstat, or null
   */
  static _editStats(displayData, result) {
    const diff = displayData?.diffData;
    if (diff && typeof diff.added === 'number' && typeof diff.removed === 'number') {
      return { added: diff.added, removed: diff.removed };
    }
    if (diff && typeof diff.oldContent === 'string' && typeof diff.newContent === 'string') {
      return EditBase._lineStats(diff.oldContent, diff.newContent);
    }
    const contentData = displayData?.contentData;
    if (contentData && typeof contentData.content === 'string') {
      return EditBase._lineStats('', contentData.content);
    }
    if (result && (typeof result.linesAdded === 'number' || typeof result.linesRemoved === 'number')) {
      return { added: result.linesAdded || 0, removed: result.linesRemoved || 0 };
    }
    return null;
  }

  /**
   * Build a rich status-summary element: a badge-shaped `+A -B` diffstat
   * (coloured green/red) followed by the filename label. Used by the
   * edit-family `getStatusUI` success branch so a completed write/edit shows
   * at a glance how much changed. The stat badge sits right after the type
   * badge the status renderer prepends, mirroring its lozenge shape.
   *
   * DOM-only; called solely from the browser status renderer. Falls back to the
   * bare label when there is no net line change (or stats are unavailable), so a
   * whitespace-only or metadata edit doesn't render an empty `+0 -0`.
   * @protected
   * @param {string} label - Primary text (e.g. `Updated foo.js`)
   * @param {{added: number, removed: number}|null} [stats] - Line diffstat
   * @returns {HTMLElement|string} Rich summary element, or the plain label
   */
  static _editStatSummary(label, stats) {
    if (!stats || (!stats.added && !stats.removed)) return label;

    const wrap = document.createElement('span');
    wrap.className = 'action-edit-summary';

    const stat = document.createElement('span');
    // The shared lozenge shape (not a type badge, so not that class — the
    // icon row hoists the first type badge it finds), restyled for digits.
    stat.className = 'item-lozenge action-edit-stat';
    if (stats.added) {
      const add = document.createElement('span');
      add.className = 'action-edit-stat-add';
      add.textContent = `+${stats.added}`;
      stat.appendChild(add);
    }
    if (stats.removed) {
      const del = document.createElement('span');
      del.className = 'action-edit-stat-del';
      del.textContent = `-${stats.removed}`;
      stat.appendChild(del);
    }
    wrap.appendChild(stat);

    const nameEl = document.createElement('span');
    nameEl.className = 'action-edit-summary-name';
    nameEl.textContent = label;
    wrap.appendChild(nameEl);

    return wrap;
  }

}

export default EditBase;
