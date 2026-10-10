//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { windowControlURL } from '../../sdk/lib/window-control.js';
import { conversationAssetURL } from '../../sdk/file-source.js';
import { getPaintedTheme, getMode } from '../utils/theme-manager.js';
import { getCurrentZoom } from '../utils/zoom-manager.js';
import { fetchJson } from './http.js';
import { apiUrl } from '../utils/api-url.js';

/**
 * The full session payload returned by GET /api/session. Mirrors the shape
 * Session._doLoad consumes — id/projectPath/platform/home/providerInfo/
 * conversationOrder/activeConversationId/messageHistory/metadata — so the
 * concrete APIService is assignable to the Session constructor's structural
 * ApiService type (they share this getSession return).
 * @typedef {object} SessionContext
 * @property {string} id - Session ID
 * @property {string} projectPath - Project root directory path
 * @property {string} [platform] - Platform (darwin/linux/windows)
 * @property {string} [home] - Backend user-home directory (e.g. /Users/jules)
 * @property {string[]} [conversationOrder] - Conversation IDs in order (v4 binary storage)
 * @property {string} activeConversationId - Active conversation ID
 * @property {{provider: string, model: string, contextWindow: number}} providerInfo - Provider information
 * @property {Array<string|import('../model/session.js').HistoryMessage>} [messageHistory] - Session-level message history for input navigation (legacy entries may be bare strings)
 * @property {Record<string, any>} [metadata] - General-purpose key-value store for frontend flags
 * @property {import('../model/session.js').Workspace[]} [workspaces] - The registered workspaces; absent until one is made
 */

/**
 * @typedef {object} ContextItemData
 * @property {string} id - Context item ID (e.g., "CI_1", "META_1")
 * @property {string} type - Context item type (e.g., "code", "tree", "git")
 * @property {object} data - Context item-specific data (structure varies by type)
 */

/**
 * @typedef {object} Message
 * @property {'user'|'assistant'|'error'|'action-result'} role - Message role
 * @property {string} content - Message text content
 * @property {string} timestamp - ISO 8601 timestamp
 * @property {string} [actionId] - Action ID (for action-result messages)
 * @property {string} [details] - Additional details (for action-result messages)
 */

/**
 * @typedef {object} SessionMetadata
 * @property {string} id - Session UUID
 * @property {string} projectPath - Project directory path
 * @property {string} createdAt - ISO 8601 timestamp
 * @property {string} updatedAt - ISO 8601 timestamp
 */

/**
 * @typedef {object} HealthResponse
 * @property {string} status - Health status ("ok" or error message)
 * @property {string} version - Application version
 */

/**
 * @typedef {object} GitFileStatus
 * @property {string} path - File path relative to its repository.
 * @property {string} [oldPath] - Former path for a rename or copy.
 * @property {string} index - Staged status letter ("M", "A", "D", …), "." when unmodified.
 * @property {string} worktree - Working-tree status letter, "?" for untracked, "." when unmodified.
 * @property {boolean} [conflicted] - Whether this is an unmerged entry.
 * @property {number} [added] - Added tracked text lines; absent for untracked/binary files.
 * @property {number} [removed] - Removed tracked text lines; absent for untracked/binary files.
 */

/**
 * @typedef {object} GitRepoStatus
 * @property {string} path - Repo location relative to the project root ("" for the root repo).
 * @property {number} changed - Count of files with working-tree changes (incl. untracked).
 * @property {number} staged - Count of files with staged (index) changes.
 * @property {number} conflicted - Count of files with unresolved merges.
 * @property {number} total - Count of files git reported, listed in `files` or not.
 * @property {number} added - Added tracked text lines relative to HEAD.
 * @property {number} removed - Removed tracked text lines relative to HEAD.
 * @property {string} branch - Current branch, "" on a detached head.
 * @property {string} upstream - Tracking branch, "" when there is none.
 * @property {string} head - Full HEAD object id, "" before the first commit.
 * @property {boolean} initial - Whether the repository has no commits yet.
 * @property {number} ahead - Commits this branch has that its upstream does not.
 * @property {number} behind - Commits its upstream has that this branch does not.
 * @property {number} stashes - Entries in the stash.
 * @property {boolean} detached - Whether HEAD is detached rather than on a branch.
 * @property {GitFileStatus[]} files - The changed files, bounded server-side.
 * @property {boolean} truncated - Whether the tree holds more files than `files` lists.
 */

/**
 * @typedef {GitRepoStatus & {complete: boolean, error?: string, base?: string, target?: string, baseName?: string}} GitReviewRepo
 *   One repository in a review manifest: everything the card reports about it,
 *   plus whether that is the whole story and git's own complaint when it is not.
 *   A repository git could not read is listed all the same. For any scope but the
 *   default, `base` and `target` are the object ids the scope resolved to there
 *   (`target` only when the new side is a commit), and `baseName` the branch
 *   `@branch` settled on.
 */

/**
 * @typedef {object} GitScope
 * @property {string} input - The scope as asked for, e.g. '@uncommitted' or 'main...HEAD'.
 * @property {'worktree'|'index'|'unstaged'|'commits'} kind - Which two states it compares.
 * @property {string} label - The comparison in words.
 */

/**
 * @typedef {object} GitReview
 * @property {string} root - Absolute project root path.
 * @property {boolean} complete - Whether every repository and file was reached.
 * @property {string[]} warnings - What the review could not reach, in sentences.
 * @property {GitScope} [scope] - What was compared.
 * @property {GitReviewRepo[]} repos - Every repository found, root repo first.
 */

/**
 * @typedef {object} GitDiffLine
 * @property {string} kind - "context", "add" or "remove".
 * @property {number} [oldLine] - Line number on the old side; absent for an added line.
 * @property {number} [newLine] - Line number on the new side; absent for a removed line.
 * @property {string} text - The line, with no leading +/-/space.
 */

/**
 * @typedef {object} GitDiffHunk
 * @property {number} oldStart - First line this hunk covers on the old side.
 * @property {number} oldLines - Lines it covers there.
 * @property {number} newStart - First line it covers on the new side.
 * @property {number} newLines - Lines it covers there.
 * @property {string} [heading] - The section git names in the `@@` line, often absent.
 * @property {GitDiffLine[]} lines - The hunk's lines, in file order.
 */

/**
 * @typedef {object} GitFileDiff
 * @property {string} repo - Repository the file belongs to, "" for the root repo.
 * @property {string} path - File path relative to that repository.
 * @property {string} [oldPath] - Former path, for a rename or copy.
 * @property {string} status - modified, added, deleted, renamed, copied, typechange,
 *   conflicted, untracked or unchanged.
 * @property {boolean} binary - Whether git judged it binary; no patch text is invented for one.
 * @property {boolean} [conflicted] - Whether the index holds unmerged stages for it.
 * @property {boolean} truncated - Whether the patch was cut short; the counts still describe all of it.
 * @property {number} added - Added lines.
 * @property {number} removed - Removed lines.
 * @property {string} revision - Fingerprint of every byte this response describes,
 *   including the bytes past a ceiling that were never returned.
 * @property {number} context - Unchanged lines carried around each change. What the
 *   request asked for, or the server's default; a reader can be shown less than
 *   this from the patch alone, but more takes another request.
 * @property {string} [oldMode] - Git's six-digit mode on the old side, when it differs.
 * @property {string} [newMode] - Git's six-digit mode on the new side, when it differs.
 * @property {GitDiffHunk[]} hunks - The patch, hunk by hunk.
 */

/**
 * REST API service for Juggler backend
 * @class
 */
/**
 * The seeds every new native window is opened with. `mode` is what the child
 * adopts (so 'system'/'auto' survives into it instead of collapsing to whatever
 * it currently resolves to), `theme` is the concrete colour it paints on its
 * first frame to avoid a flash, and `zoom` only seeds a child whose session has
 * no saved size of its own.
 * @returns {URLSearchParams} The theme, mode and zoom hand-off.
 */
function newWindowParams() {
  return new URLSearchParams({
    theme: getPaintedTheme(),
    mode: getMode(),
    zoom: String(getCurrentZoom()),
  });
}

/**
 * The `?workspace=` a git read carries, or nothing at all.
 *
 * Absent means the project server-side, exactly as it does for an operation, so
 * an unbound conversation's reads are the same requests they always were.
 * @param {string} [workspaceId] - Workspace to read, '' or omitted for the project.
 * @returns {string} The query string to append, or ''.
 */
function gitWorkspaceQuery(workspaceId) {
  return workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : '';
}

class APIService {
  /**
   * @param {string} endpoint
   * @param {{method?: string, body?: any, headers?: Record<string, string>, signal?: AbortSignal}} [options]
   * @returns {Promise<any>} Parsed JSON response or null
   * @private
   */
  async request(endpoint, options = {}) {
    try {
      return await fetchJson(apiUrl(endpoint), options);
    } catch (error) {
      console.error(`[API] Request failed for ${endpoint}:`, error);
      throw error;
    }
  }

  /**
   * Get health status of the API
   * @returns {Promise<HealthResponse>} Health response with status and version
   */
  async getHealth() {
    return await this.request('/health');
  }

  /**
   * Get the conversations that are actively running a turn. Turns parked solely
   * on a pending tool approval are NOT reported — they survive a restart intact,
   * so callers warning before a destructive action (project switch, quit) must
   * not treat them as busy.
   * @returns {Promise<{active: boolean, conversationIds: string[]}>} Active flag and conversation IDs
   */
  async getActiveConversations() {
    return await this.request('/health/active');
  }

  /**
   * Get the session with all its data
   * @returns {Promise<SessionContext>} Complete session context with all data
   */
  async getSession() {
    return await this.request('/session');
  }

  /**
   * Update session-level state (active conversation, message history, metadata).
   * Conversation names live on the on-disk folder name and travel via GET
   * /api/session's `conversationNames` and PATCH /session/conversations/{id}/name.
   * Conversation order is owned by POST /api/conversations (create) and POST
   * /api/session/conversations/reorder.
   * @param {string|null} activeConversationId
   * @param {import('../model/session.js').HistoryMessage[]} [messageHistory] - Session-level message history for input navigation
   * @param {Record<string, any>} [metadata] - General-purpose key-value store for frontend flags
   * @returns {Promise<{success: boolean}>} Success indicator
   */
  async updateSession(activeConversationId, messageHistory, metadata) {
    return await this.request('/session', {
      method: 'PUT',
      body: {
        activeConversationId,
        messageHistory,
        metadata
      }
    });
  }

  /**
   * Patch session-level metadata without replacing unrelated session state.
   * @param {Record<string, any>} metadata Metadata keys to set; null deletes a key
   * @returns {Promise<{metadata: Record<string, any>}>} Changed metadata keys
   */
  async patchSessionMetadata(metadata) {
    return await this.request('/session/metadata', {
      method: 'PATCH',
      body: { metadata }
    });
  }

  /**
   * Atomically create a new conversation. Server creates the on-disk folder
   * with the collision-resolved canonical name; the folder is the source of
   * truth for the display name, so do not issue a rename PATCH for the
   * returned name.
   * @param {string} name - Requested display name (server may append " (copy N)" on collision)
   * @param {string} [id] - Optional preallocated conversation id
   * @param {{lane?: string, reason?: string, duplicateFrom?: string, origin?: string, focus?: boolean, focusFrom?: string, place?: string, after?: string}} [options] - lane
   *   identifies the creating test lane for the test-mode ownership ledger;
   *   reason tags the create with the current test's name so a suite-end leak
   *   dump names the culprit test; duplicateFrom makes the server clone that
   *   conversation's files into the new folder before announcing it; origin is
   *   a gesture label (e.g. plus-button, slash-command, initial-bootstrap) the
   *   server logs for create attribution — the only way to name the gesture
   *   behind a "phantom" create after the fact; focus makes the server broadcast
   *   a "focus" op after "created" asking viewers to switch to the new
   *   conversation (used by the headless engine, which can't move viewer focus);
   *   focusFrom names the conversation that asked, so each viewer can decide
   *   whether to follow; place is 'head', 'after' or 'end' and after names the
   *   conversation to sit behind for 'after', which is how a conversation
   *   created in a workspace box lands beside the rest of that box.
   * @returns {Promise<{id: string, name: string, created: string}>} Conversation id, canonical name actually written to disk, and ISO 8601 creation timestamp.
   */
  async createConversation(name, id, options = {}) {
    const params = new URLSearchParams();
    if (options.lane) params.set('lane', options.lane);
    if (options.reason) params.set('reason', options.reason);
    const qs = params.size > 0 ? `?${params}` : '';
    return await this.request(`/conversations${qs}`, {
      method: 'POST',
      body: {
        name,
        ...(id ? { id } : {}),
        // duplicateFrom makes the server clone the source's files (doc.yjs +
        // txns) into the new folder before announcing it — see
        // Session.duplicateConversation.
        ...(options.duplicateFrom ? { duplicateFrom: options.duplicateFrom } : {}),
        // origin labels the gesture that triggered this create so the server
        // log can attribute it (phantom "Untitled N" tabs otherwise name no source).
        ...(options.origin ? { origin: options.origin } : {}),
        // focus makes the server broadcast a "focus" op after "created" asking
        // viewers to switch to the new conversation. Used by a headless creator
        // (the engine's new_conversation tool) that can't move viewer focus
        // locally; a plain viewer create omits it and activates its own tab.
        // focusFrom rides along so viewers can apply their own follow policy.
        ...(options.focus ? { focus: true } : {}),
        ...(options.focusFrom ? { focusFrom: options.focusFrom } : {}),
        // place and after say where this one goes in the stored order: 'head',
        // 'end', or 'after' the conversation named alongside it. Omitting both
        // means the head of the bar, where a project conversation belongs.
        ...(options.place ? { place: options.place } : {}),
        ...(options.after ? { after: options.after } : {})
      }
    });
  }

  /**
   * Rename a conversation. Backend renames the on-disk folder atomically.
   * @param {string} conversationId
   * @param {string} name - desired human-readable name
   * @returns {Promise<{name: string}>} canonical (post-sanitization) name
   * @throws {Error} on 400 (invalid), 404 (unknown), 409 (collision), or 5xx
   */
  async renameConversation(conversationId, name) {
    return await this.request(`/session/conversations/${encodeURIComponent(conversationId)}/name`, {
      method: 'PATCH',
      body: { name }
    });
  }

  /**
   * Update a single conversation within a session
   * @param {string} conversationId
   * @param {object} conversationData - Full conversation object
   * @returns {Promise<{success: boolean}>} Success indicator
   */
  async updateConversation(conversationId, conversationData) {
    return await this.request(`/session/conversations/${conversationId}`, {
      method: 'PUT',
      body: conversationData
    });
  }

  /**
   * Delete a single conversation from a session
   * @param {string} conversationId
   * @param {{permanent?: boolean, reason?: string, lane?: string}} [options] -
   *   reason is an attribution tag the server logs with the delete; lane
   *   identifies the requesting test lane for the test-mode ownership guard
   * @returns {Promise<void>}
   */
  async deleteConversation(conversationId, options = {}) {
    const params = new URLSearchParams();
    if (options.permanent) params.set('permanent', 'true');
    if (options.reason) params.set('reason', options.reason);
    if (options.lane) params.set('lane', options.lane);
    const qs = params.size > 0 ? `?${params}` : '';
    return await this.request(`/session/conversations/${conversationId}${qs}`, {
      method: 'DELETE'
    });
  }

  /**
   * Bin a conversation — moves its folder to .juggler/bin/.
   * Reversible via restoreConversation until it is auto-purged.
   * @param {string} conversationId
   * @param {{lane?: string}} [options] - lane identifies the requesting
   *   test lane for the test-mode ownership guard (binning tears down the
   *   worker exactly like delete)
   * @returns {Promise<void>}
   */
  async binConversation(conversationId, options = {}) {
    const qs = options.lane ? `?lane=${encodeURIComponent(options.lane)}` : '';
    return await this.request(`/session/conversations/${encodeURIComponent(conversationId)}/bin${qs}`, {
      method: 'POST'
    });
  }

  /**
   * Move a conversation out of .juggler/bin/ back to the active set.
   * @param {string} conversationId
   * @returns {Promise<void>}
   */
  async restoreConversation(conversationId) {
    return await this.request(`/session/binned-conversations/${encodeURIComponent(conversationId)}/restore`, {
      method: 'POST'
    });
  }

  /**
   * List binned conversations, most-recently-modified first.
   * @returns {Promise<{binned: Array<{id: string, name: string, lastModifiedAt: string}>}>} binned list keyed under `binned`
   */
  async listBinnedConversations() {
    return await this.request('/session/binned-conversations');
  }

  /**
   * Permanently delete a single binned conversation (via OS trash).
   * @param {string} conversationId
   * @returns {Promise<void>}
   */
  async deleteBinnedConversation(conversationId) {
    return await this.request(`/session/binned-conversations/${encodeURIComponent(conversationId)}`, {
      method: 'DELETE'
    });
  }

  /**
   * Permanently delete binned conversations (via OS trash) — the whole bin, or
   * only the conversations whose last activity is older than a cutoff.
   * @param {number|null} [olderThanDays] - Positive day count to delete only
   *   conversations last active more than that many days ago; omit or pass null
   *   to empty the entire bin.
   * @returns {Promise<void>}
   */
  async emptyBin(olderThanDays = null) {
    const qs = olderThanDays ? `?olderThanDays=${encodeURIComponent(String(olderThanDays))}` : '';
    return await this.request(`/session/binned-conversations${qs}`, {
      method: 'DELETE'
    });
  }

  /**
   * Save conversation as binary Yjs data
   * @param {string} conversationId
   * @param {Uint8Array} yjsData - Binary Yjs state
   * @returns {Promise<void>}
   */
  async saveConversationBinary(conversationId, yjsData) {
    const url = apiUrl(`/session/conversations/${conversationId}`);
    await fetchJson(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: yjsData,
      errorPrefix: 'Failed to save conversation binary'
    });
  }

  /**
   * Reorder conversations within a session
   * @param {string[]} conversationOrder - Array of conversation IDs in desired order
   * @param {string} [moved] - The one conversation a drag moved, where the
   *   reorder is a move. A workspace box is placed by the conversation it sits
   *   behind, so the server needs the mover by name to let the box keep where it
   *   is drawn — two adjacent tabs swapping look the same either way round, so
   *   it cannot be read back off the order. Omitted for a reorder that is not
   *   one conversation moving, which leaves every box's place alone.
   * @returns {Promise<null>} Null on success
   */
  async reorderConversations(conversationOrder, moved = '') {
    return await this.request('/session/reorder', {
      method: 'PUT',
      body: { order: conversationOrder, moved }
    });
  }

  /**
   * @typedef {object} Provider
   * @property {string} name - Provider name
   * @property {string} displayName - Display name
   * @property {boolean} available - Whether API key is configured
   * @property {string} [model] - Model name
   */

  /**
   * Get list of available providers
   * @returns {Promise<{providers: Provider[]}>} Available LLM providers with their status
   */
  async getProviders() {
    return await this.request('/providers');
  }

  /**
   * Get the concrete model a new conversation should be seeded with, computed
   * from the live provider list. Empty strings when no provider is usable yet.
   * Captured at creation time so a later preference change never retargets an
   * existing conversation.
   * @returns {Promise<{provider: string, model: string}>} The concrete default model, with empty strings when none is available yet
   */
  async getDefaultModel() {
    return await this.request('/default-model');
  }

  /**
   * Get the user's saved system-prompt presets and the chosen default preset id.
   * Built-in presets ship in the frontend; the caller merges the two sets. An
   * empty defaultId means "fall back to the built-in default preset".
   * @returns {Promise<{presets: Array<{id: string, name: string, content: string}>, defaultId: string}>} User presets and default id
   */
  async getSystemPromptPresets() {
    return await this.request('/system-prompt-presets');
  }

  /**
   * Save the current prompt body as a new named user preset.
   * @param {string} name - Display name for the preset
   * @param {string} content - Full prompt body to store
   * @returns {Promise<{success: boolean, preset?: {id: string, name: string, content: string}, error?: string}>} The created preset (with its generated id)
   */
  async saveSystemPromptPreset(name, content) {
    return await this.request('/system-prompt-presets', {
      method: 'POST',
      body: { name, content }
    });
  }

  /**
   * Delete a user preset by id (idempotent; built-in ids are ignored server-side).
   * @param {string} id - User preset id
   * @returns {Promise<{success: boolean, error?: string}>} Result
   */
  async deleteSystemPromptPreset(id) {
    return await this.request(`/system-prompt-presets/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
  }

  /**
   * Update the name and content of an existing user preset by id.
   * @param {string} id - User preset id
   * @param {string} name - Display name for the preset
   * @param {string} content - Full prompt body to store
   * @returns {Promise<{success: boolean, preset?: {id: string, name: string, content: string}, error?: string}>} The updated preset
   */
  async updateSystemPromptPreset(id, name, content) {
    return await this.request(`/system-prompt-presets/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: { name, content }
    });
  }

  /**
   * Set which preset (built-in or user) new conversations are seeded from. An
   * empty id clears the explicit default (reverting to the built-in default).
   * @param {string} id - Preset id to make the session default
   * @returns {Promise<{success: boolean, error?: string}>} Result
   */
  async setDefaultSystemPromptPreset(id) {
    return await this.request('/system-prompt-presets/default', {
      method: 'PUT',
      body: { id }
    });
  }

  /**
   * Summarise the working tree of every git repo under the tree named (root repo
   * plus nested subrepos/submodules). Best-effort: repos whose status can't be
   * read are omitted, and an empty repo list means no git repository was found.
   * @param {string} [workspaceId] - Workspace to read, '' or omitted for the project.
   * @param {{signal?: AbortSignal}} [options] - Cancellation, for a speculative read nobody is waiting on any more.
   * @returns {Promise<{root: string, workspace?: string, repos: GitRepoStatus[]}>} The root read, the
   *   workspace's name when that root is not the project, and its per-repo status.
   */
  async getGitStatus(workspaceId = '', options = {}) {
    return await this.request(`/git/status${gitWorkspaceQuery(workspaceId)}`,
      { signal: options.signal });
  }

  /**
   * Read the review manifest: every repository under the project and every file
   * in each of them, freshly. Unlike {@link APIService#getGitStatus} this is the
   * question asked in earnest — nothing is skipped for being expensive, and
   * whatever it still could not reach comes back as `complete: false` and a
   * warning saying so rather than as a shorter list.
   * @param {{signal?: AbortSignal, workspaceId?: string, scope?: string}} [options] - Cancellation,
   *   which tree to read, and what to compare ('' or omitted for the working tree
   *   against HEAD; the server refuses a scope it cannot read with a 400).
   * @returns {Promise<GitReview>} The manifest.
   */
  async getGitReview(options = {}) {
    const query = new URLSearchParams();
    if (options.workspaceId) query.set('workspace', options.workspaceId);
    if (options.scope) query.set('scope', options.scope);
    const qs = query.toString();
    return await this.request(`/git/review${qs ? `?${qs}` : ''}`, { signal: options.signal });
  }

  /**
   * Read one file's change within a scope — by default its whole working-tree
   * change against HEAD, index and worktree folded together, which is the same
   * comparison the status card's line counts come from.
   * @param {string} repo - Repository relative to the project root, "" for the root repo.
   * @param {string} path - File relative to that repository.
   * @param {{signal?: AbortSignal, workspaceId?: string, contextLines?: number, scope?: string}} [options] -
   *   Cancellation, which tree to read, how many unchanged lines to carry around
   *   each change (-1 for the whole file; omitted takes the server's default), and
   *   what to compare, as for {@link APIService#getGitReview}. The answer reports
   *   the width it was produced at.
   * @returns {Promise<GitFileDiff>} The file's patch and what happened to it.
   */
  async getGitDiff(repo, path, options = {}) {
    const query = new URLSearchParams({ repo, path });
    if (options.workspaceId) query.set('workspace', options.workspaceId);
    if (typeof options.contextLines === 'number') query.set('context', String(options.contextLines));
    if (options.scope) query.set('scope', options.scope);
    return await this.request(`/git/diff?${query.toString()}`, { signal: options.signal });
  }

  /**
   * Check whether a path exists and is a directory without switching projects.
   * @param {string} path - Path to check (~ is expanded server-side)
   * @returns {Promise<{valid: boolean, path?: string, error?: string}>} Check result
   */
  async checkProject(path) {
    return await this.request(`/project/check?path=${encodeURIComponent(path)}`);
  }

  /**
   * Open or switch to a project folder.
   * @param {string} path - Absolute or relative project path
   * @returns {Promise<{projectPath: string}>} Resolves with the absolute path of the now-loaded project.
   */
  async openProject(path) {
    return await this.request('/project', {
      method: 'POST',
      body: { path }
    });
  }

  /**
   * Create a folder and open it as the project.
   *
   * The folder is made directly inside `parent`, which must already exist — a
   * mistyped parent is refused rather than built, so a typo cannot leave empty
   * folders behind. An existing folder of that name is a conflict, never a
   * silent switch onto someone else's work.
   * @param {string} parent - Absolute or ~-relative folder to create it in
   * @param {string} name - Folder name; no slashes, not "." or ".."
   * @returns {Promise<{projectPath: string}>} Resolves with the absolute path of the now-loaded project.
   */
  async createProject(parent, name) {
    return await this.request('/project/new', {
      method: 'POST',
      body: { parent, name }
    });
  }

  /**
   * Open a new desktop window onto a project. Only works in the native desktop
   * app, which handles it via its loopback nativeCtl endpoint by opening
   * another in-process window; a plain browser tab has no native host, so this
   * is a no-op there.
   * @param {string} [path] - Optional project folder for the new window. When
   *   omitted the new window starts in no-project mode and shows the picker.
   * @returns {Promise<void>} Resolves once the launch was requested.
   */
  async newWindow(path = '') {
    const params = newWindowParams();
    if (path) params.set('project', path);
    const url = windowControlURL('new', `?${params.toString()}`);
    if (!url) return; // no native host (browser tab) — nothing to open
    await fetchJson(url, { method: 'POST', errorPrefix: 'Could not open a new window' });
  }

  /**
   * Open a detached pinboard in a native window of its own. Desktop only, like
   * {@link APIService#newWindow} — a browser tab opens the same URL itself.
   *
   * No project is named: the app puts the new window on the same server as the
   * one that asked, which is what puts the board and the conversation it is a
   * view of on one project.
   * @param {string} owner - The viewer id the board sends its reveals to.
   * @param {string} board - The board this window is a view of.
   * @param {string} [pin] - The pin it opens on.
   * @param {string} [conversation] - The conversation it is a view of.
   * @param {import('./pinboard-link.js').FrameHint|null} [frame] - Where the
   *   board is on screen in this window, for the new one to open near.
   * @returns {Promise<void>} Resolves once the launch was requested.
   */
  async openPinboardWindow(owner, board, pin = '', conversation = '', frame = null) {
    const params = newWindowParams();
    params.set('view', 'pinboard');
    params.set('owner', owner);
    params.set('board', board);
    if (pin) params.set('pin', pin);
    if (conversation) params.set('conversation', conversation);
    // Where the board is now, so the window opens as that board moving out of
    // this one rather than as a new window arriving from nowhere. All six or
    // none: the page size is what gives the rect a scale, and half a
    // measurement places nothing.
    if (frame) {
      params.set('panelX', String(frame.x));
      params.set('panelY', String(frame.y));
      params.set('panelW', String(frame.width));
      params.set('panelH', String(frame.height));
      params.set('pageW', String(frame.viewWidth));
      params.set('pageH', String(frame.viewHeight));
    }
    const url = windowControlURL('new', `?${params.toString()}`);
    if (!url) return; // no native host (browser tab) — nothing to open
    await fetchJson(url, { method: 'POST', errorPrefix: "Couldn't open that board" });
  }

  /**
   * Close the current project (return to no-project mode).
   * @returns {Promise<{projectPath: string}>} Resolves with an empty projectPath.
   */
  async closeProject() {
    return await this.request('/project', { method: 'DELETE' });
  }

  /**
   * Get the user-level recent project paths.
   * @returns {Promise<{paths: string[]}>} Resolves with the recents list, most-recent first.
   */
  async getRecents() {
    return await this.request('/recents');
  }

  /**
   * Remove one path from the recents list.
   * @param {string} path
   * @returns {Promise<null>} Resolves with null on success.
   */
  async removeRecent(path) {
    return await this.request('/recents', {
      method: 'DELETE',
      body: { path }
    });
  }

  /**
   * Upload a raw image File/Blob to a conversation's content-addressed asset
   * store. The bytes are the request body; the mime type rides in Content-Type.
   * @param {string} conversationId - Conversation ID
   * @param {File|Blob} file - Image file/blob to upload (image/* only)
   * @returns {Promise<{id:string,mime:string,filename:string,bytes:number,width:number,height:number}>}
   *   The stored asset reference.
   */
  async uploadAsset(conversationId, file) {
    const url = apiUrl(`/session/conversations/${encodeURIComponent(conversationId)}/assets`);
    return await fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
      errorPrefix: 'Asset upload failed'
    });
  }

  /**
   * URL of the GET route that streams a stored asset's bytes (for rendering).
   *
   * The bytes are loaded by the browser as an `<img src>`, which cannot carry
   * the `X-Juggler-Token` header the fetch() shim adds to /api requests. So the
   * per-instance token rides as a `?token=` query param instead — exactly as
   * the WebSocket dial does (services/websocket.js) — and the server accepts it
   * for this read-only asset route (see isAssetGetRequest in api_auth.go).
   * @param {string} conversationId - Conversation ID
   * @param {string} sha - Asset id (content hash) = AssetRef.id
   * @returns {string} The asset GET URL (token-bearing when a token is present).
   */
  assetURL(conversationId, sha) {
    return conversationAssetURL(conversationId, sha);
  }

}

// Export singleton instance
const apiService = new APIService();
export default apiService;
