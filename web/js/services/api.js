//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { windowControlURL } from '../../sdk/lib/window-control.js';
import { getTheme } from '../utils/theme-manager.js';

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
 * @property {object[]} [conversations] - Conversations JSON (legacy v4 format with embedded data)
 * @property {string[]} [conversationOrder] - Conversation IDs in order (v4 binary storage)
 * @property {string} activeConversationId - Active conversation ID
 * @property {{provider: string, model: string, contextWindow: number}} providerInfo - Provider information
 * @property {string[]} [messageHistory] - Session-level message history for input navigation
 * @property {Record<string, any>} [metadata] - General-purpose key-value store for frontend flags
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
 * @typedef {object} GitRepoStatus
 * @property {string} path - Repo location relative to the project root ("" for the root repo).
 * @property {number} changed - Count of files with working-tree changes (incl. untracked).
 * @property {number} staged - Count of files with staged (index) changes.
 */

/**
 * REST API service for Juggler backend
 * @class
 */
class APIService {
  constructor() {
    /** @type {string} @private */
    this.baseURL = '/api';
  }

  /**
   * @param {string} endpoint
   * @param {RequestInit} [options]
   * @returns {Promise<any>} Parsed JSON response or null
   * @private
   */
  async request(endpoint, options = {}) {
    const url = `${this.baseURL}${endpoint}`;
    const defaultOptions = {
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const mergedOptions = { ...defaultOptions, ...options };

    try {
      const response = await fetch(url, mergedOptions);

      if (!response.ok) {
        // Try to surface the server's structured error body. Backends
        // commonly return {"error": "..."} JSON; fall back to text or
        // statusText if the body is empty / unparseable.
        let bodyMsg = '';
        try {
          const text = await response.text();
          if (text) {
            try {
              const parsed = JSON.parse(text);
              if (parsed && typeof parsed.error === 'string') {
                bodyMsg = parsed.error;
              } else {
                bodyMsg = text;
              }
            } catch {
              bodyMsg = text;
            }
          }
        } catch {
          /* ignore — fall through to statusText */
        }
        const detail = bodyMsg || response.statusText;
        throw new Error(`HTTP ${response.status}: ${detail}`);
      }

      // Handle 204 No Content responses
      if (response.status === 204) {
        return null;
      }

      // Check if response has content before parsing JSON
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return await response.json();
      }

      // For non-JSON responses, return null
      return null;
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
   * @param {object[]} conversations
   * @param {string|null} activeConversationId
   * @param {string[]} [messageHistory] - Session-level message history for input navigation
   * @param {Record<string, any>} [metadata] - General-purpose key-value store for frontend flags
   * @returns {Promise<{success: boolean}>} Success indicator
   */
  async updateSession(conversations, activeConversationId, messageHistory, metadata) {
    return await this.request('/session', {
      method: 'PUT',
      body: JSON.stringify({
        conversations,
        activeConversationId,
        messageHistory,
        metadata
      })
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
      body: JSON.stringify({ metadata })
    });
  }

  /**
   * Atomically create a new conversation. Server creates the on-disk folder
   * with the collision-resolved canonical name; the folder is the source of
   * truth for the display name, so do not issue a rename PATCH for the
   * returned name.
   * @param {string} name - Requested display name (server may append " (copy N)" on collision)
   * @param {string} [id] - Optional preallocated conversation id
   * @param {{lane?: string, reason?: string, duplicateFrom?: string, origin?: string}} [options] - lane
   *   identifies the creating test lane for the test-mode ownership ledger;
   *   reason tags the create with the current test's name so a suite-end leak
   *   dump names the culprit test; duplicateFrom makes the server clone that
   *   conversation's files into the new folder before announcing it; origin is
   *   a gesture label (e.g. plus-button, slash-command, initial-bootstrap) the
   *   server logs for create attribution — the only way to name the gesture
   *   behind a "phantom" create after the fact.
   * @returns {Promise<{id: string, name: string, created: string}>} Conversation id, canonical name actually written to disk, and ISO 8601 creation timestamp.
   */
  async createConversation(name, id, options = {}) {
    const params = new URLSearchParams();
    if (options.lane) params.set('lane', options.lane);
    if (options.reason) params.set('reason', options.reason);
    const qs = params.size > 0 ? `?${params}` : '';
    return await this.request(`/conversations${qs}`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        ...(id ? { id } : {}),
        // duplicateFrom makes the server clone the source's files (doc.yjs +
        // txns) into the new folder before announcing it — see
        // Session.duplicateConversation.
        ...(options.duplicateFrom ? { duplicateFrom: options.duplicateFrom } : {}),
        // origin labels the gesture that triggered this create so the server
        // log can attribute it (phantom "Task N" tabs otherwise name no source).
        ...(options.origin ? { origin: options.origin } : {})
      })
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
      body: JSON.stringify({ name })
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
      body: JSON.stringify(conversationData)
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
   * Permanently delete every binned conversation (via OS trash).
   * @returns {Promise<void>}
   */
  async emptyBin() {
    return await this.request('/session/binned-conversations', {
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
    const url = `${this.baseURL}/session/conversations/${conversationId}`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream'
      },
      // @ts-ignore - Uint8Array is valid for fetch body but TypeScript types are incomplete
      body: yjsData
    });

    if (!response.ok) {
      throw new Error(`Failed to save conversation binary: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * Reorder conversations within a session
   * @param {string[]} conversationOrder - Array of conversation IDs in desired order
   * @returns {Promise<null>} Null on success
   */
  async reorderConversations(conversationOrder) {
    return await this.request('/session/reorder', {
      method: 'PUT',
      body: JSON.stringify({ order: conversationOrder })
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
      body: JSON.stringify({ name, content })
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
   * Set which preset (built-in or user) new conversations are seeded from. An
   * empty id clears the explicit default (reverting to the built-in default).
   * @param {string} id - Preset id to make the session default
   * @returns {Promise<{success: boolean, error?: string}>} Result
   */
  async setDefaultSystemPromptPreset(id) {
    return await this.request('/system-prompt-presets/default', {
      method: 'PUT',
      body: JSON.stringify({ id })
    });
  }

  /**
   * Summarise the working tree of every git repo under the project (root repo
   * plus nested subrepos/submodules). Best-effort: repos whose status can't be
   * read are omitted, and an empty repo list means no git repository was found.
   * @param {string} [conversationId] - Visible conversation, so the summary
   *   reflects that conversation's dedicated git worktree rather than the base
   *   project root (per-conversation worktree isolation). Omitted ⇒ base project.
   * @returns {Promise<{root: string, repos: GitRepoStatus[]}>} Project root and per-repo status.
   */
  async getGitStatus(conversationId) {
    const qs = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : '';
    return await this.request(`/git/status${qs}`);
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
      body: JSON.stringify({ path })
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
    const params = new URLSearchParams({ theme: getTheme() });
    if (path) params.set('project', path);
    const url = windowControlURL('new', `?${params.toString()}`);
    if (!url) return; // no native host (browser tab) — nothing to open
    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) {
      let msg = `Could not open a new window (HTTP ${res.status})`;
      try {
        const body = await res.json();
        if (body && body.error) msg = body.error;
      } catch (_e) { /* non-JSON error body; keep default message */ }
      throw new Error(msg);
    }
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
      body: JSON.stringify({ path })
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
    const url = `${this.baseURL}/session/conversations/${encodeURIComponent(conversationId)}/assets`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file
    });
    if (!response.ok) {
      let detail = response.statusText;
      try {
        const text = await response.text();
        if (text) {
          try {
            const parsed = JSON.parse(text);
            detail = (parsed && typeof parsed.error === 'string') ? parsed.error : text;
          } catch {
            detail = text;
          }
        }
      } catch {
        /* ignore — fall through to statusText */
      }
      throw new Error(`Asset upload failed (HTTP ${response.status}): ${detail}`);
    }
    return await response.json();
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
    const url = `${this.baseURL}/session/conversations/${encodeURIComponent(conversationId)}/assets/${encodeURIComponent(sha)}`;
    const token = /** @type {{__jugglerToken?: string}} */ (globalThis).__jugglerToken;
    return token ? `${url}?token=${encodeURIComponent(token)}` : url;
  }

}

// Export singleton instance
const apiService = new APIService();
export default apiService;
