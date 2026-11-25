//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { hostedPageURL, hostMovesNoWindow, windowControlURL } from '../../sdk/lib/window-control.js';
import { conversationAssetURL } from '../../sdk/file-source.js';
import { getPaintedTheme, getMode } from '../utils/theme-manager.js';
import { getCurrentZoom } from '../utils/zoom-manager.js';
import { isWindowBorderOn } from '../utils/window-border.js';
import { fetchJson, HttpError } from './http.js';
import { apiUrl, basePath } from '../utils/api-url.js';
import { t } from '../../sdk/lib/i18n.js';

/**
 * The full session payload returned by GET /api/session. Mirrors the shape
 * SessionPersistence.load consumes — id/projectPath/platform/home/providerInfo/
 * conversationOrder/activeConversationId/messageHistory/metadata — so the
 * concrete APIService is assignable to the Session constructor's structural
 * ApiService type (they share this getSession return).
 * @typedef {object} SessionContext
 * @property {string} id - Session ID
 * @property {string} projectPath - Project root directory path
 * @property {string} [stateDir] - The folder holding the project's local state: <projectPath>/.juggler, or the project's folder outside it
 * @property {string} [platform] - Platform (darwin/linux/windows)
 * @property {string} [home] - Backend user-home directory (e.g. /Users/jules)
 * @property {string[]} [instructionDirs] - Folders holding the user's global AGENTS.md, widest first
 * @property {string[]} [conversationOrder] - Conversation IDs in order (v4 binary storage)
 * @property {string} activeConversationId - Active conversation ID
 * @property {{provider: string, model: string, contextWindow: number}} providerInfo - Provider information
 * @property {Array<string|import('../model/session.js').HistoryMessage>} [messageHistory] - Session-level message history for input navigation (legacy entries may be bare strings)
 * @property {Record<string, any>} [metadata] - General-purpose key-value store for frontend flags
 * @property {import('../model/session.js').Workspace[]} [workspaces] - The registered workspaces; absent until one is made
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
 * @typedef {object} HealthResponse
 * @property {string} status - Health status ("ok" or error message)
 * @property {string} version - Application version
 */

/** @typedef {import('../protocol/server-wire-types.gen.js').Job} Job */
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
 * Call one operation of a registered tool through the client's ops entry
 * (POST /api/ops/client), which acts for the user: it reaches the tools only
 * the user's client may call (the git tool), and the worktrees only they may
 * run in. The agent's tool calls go through POST /api/ops/call instead, which
 * refuses those. A failure throws an Error carrying the server's English as
 * its message, the translatable message as `serverMessage`, and the
 * failure's code, if it has one, as `code`.
 * @param {string} toolId - The tool.
 * @param {string} operation - Its operation.
 * @param {Record<string, any>} params - Its parameters.
 * @param {string} [workspaceId] - The tree, '' or omitted for the project.
 * @param {AbortSignal} [signal] - Cancellation; it reaches the server's work.
 * @returns {Promise<any>} The operation's answer.
 */
export async function clientOp(toolId, operation, params, workspaceId = '', signal) {
  /** @type {any} */
  let resp;
  try {
    resp = await fetchJson(apiUrl('/ops/client'), {
      method: 'POST',
      body: { toolId, operation, params, ...(workspaceId ? { workspaceId } : {}) },
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    // A refusal before any tool ran (no project open, a body the server could
    // not read) comes with an HTTP status, and the same answer shape.
    if (!(err instanceof HttpError) || err.body?.success !== false) throw err;
    resp = err.body;
  }
  if (!resp?.success) {
    /** @type {any} */
    const error = new Error(resp?.error || `${toolId} ${operation} failed`);
    error.serverMessage = resp?.message;
    error.code = resp?.code || '';
    throw error;
  }
  return resp.data;
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
   * so callers warning before a destructive action (quit) must
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
   * @param {import('../model/session.js').HistoryMessage[]} [messageHistory] - Session-level message history for input navigation; omitted, the stored one is kept
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
   * @param {{lane?: string, reason?: string, duplicateFrom?: string, origin?: string, focus?: boolean, focusFrom?: string, place?: string, after?: string, ephemeral?: boolean, agentRun?: string}} [options] - lane
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
   *   created in a workspace box lands beside the rest of that box; ephemeral
   *   and agentRun make an agent run's throwaway conversation.
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
        ...(options.after ? { after: options.after } : {}),
        // ephemeral makes a conversation that never joins the session's list,
        // order or cap, owned by the agent run agentRun names: the server tears
        // it down when that run ends, and refuses it (409) if it already has.
        ...(options.ephemeral ? { ephemeral: true } : {}),
        ...(options.agentRun ? { agentRun: options.agentRun } : {})
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
   * Read a workspace's jobs, of every kind: one by id, or every one running and
   * the last hundred ended, newest first.
   * @param {string} [workspaceId] - Workspace, '' or omitted for the project.
   * @param {string} [id] - The one job to read; a job the server does not have is a 404.
   * @returns {Promise<{jobs?: Job[], job?: Job}>} `{jobs}` for the list, `{job}` for one.
   */
  async getJobs(workspaceId = '', id = '') {
    const query = new URLSearchParams();
    if (workspaceId) query.set('workspace', workspaceId);
    if (id) query.set('id', id);
    const qs = query.toString();
    return await this.request(`/jobs${qs ? `?${qs}` : ''}`);
  }


  /**
   * Ask the server to stop a git write.
   * @param {string} id - The job.
   * @param {string} [workspaceId] - Its workspace, '' or omitted for the project.
   * @returns {Promise<{job: Job}>} The job as it stood once asked.
   */
  async cancelJob(id, workspaceId = '') {
    const query = new URLSearchParams({ id });
    if (workspaceId) query.set('workspace', workspaceId);
    return await this.request(`/jobs/cancel?${query.toString()}`, { method: 'POST' });
  }

  /**
   * Answer the question a git write is waiting on, or decline it. A question
   * answered already, or no longer asked, is a 409.
   * @param {string} id - The job.
   * @param {{prompt: string, answer?: string, decline?: boolean}} reply - The
   *   question's id, and the answer or the decline.
   * @param {string} [workspaceId] - Its workspace, '' or omitted for the project.
   * @returns {Promise<{job: Job}>} The job as it stood once answered.
   */
  async answerJob(id, reply, workspaceId = '') {
    const query = new URLSearchParams({ id });
    if (workspaceId) query.set('workspace', workspaceId);
    return await this.request(`/jobs/answer?${query.toString()}`, { method: 'POST', body: reply });
  }

  /**
   * Open a new desktop window: on the server's page, where a project is
   * chosen, or onto a project of this machine's server, at one of its
   * conversations — unless a window already shows that project, which the app
   * raises at the conversation instead. Only works in the native desktop app,
   * which handles it via its loopback nativeCtl endpoint by opening another
   * in-process window; a plain browser tab has no native host, so this is a
   * no-op there.
   * @param {{project?: string, conversation?: string}} [target] - The project
   *   to open, and the conversation its page opens on; none for the server's page.
   * @returns {Promise<boolean>} True when the app raised the project's window
   *   rather than opening one.
   */
  async newWindow({ project = '', conversation = '' } = {}) {
    const params = newWindowParams();
    if (project) params.set('project', project);
    if (project && conversation) params.set('conversation', conversation);
    const url = windowControlURL('new', `?${params.toString()}`);
    if (!url) return false; // no native host (browser tab) — nothing to open
    const body = await fetchJson(url, { method: 'POST', errorPrefix: t('Could not open a new window') });
    return body?.raised === true;
  }

  /**
   * Show another session of this window's server in this desktop window, in
   * place of this page, as the sessions page's own picks do
   * (web/machine/native-host.js). One project has one window: when another
   * window already shows the project, the app raises that one, at the
   * conversation, and this window stays as it is. A no-op in a browser tab.
   * @param {{sessionId: string, project: string, link: string, conversation?: string}} target - The
   *   session, its project and link (which a window on a server by URL goes
   *   to and is filed with), and the conversation it opens on.
   * @returns {Promise<boolean>} True when the app raised another window; false
   *   when this page is being replaced.
   * @throws {import('./http.js').HttpError} When the app refuses, saying why.
   */
  async attachWindow({ sessionId, project, link, conversation = '' }) {
    if (hostMovesNoWindow()) {
      // An app older than project links cannot move its window: the page
      // does, as that app's own server's page did.
      window.location.assign(hostedPageURL(conversation ? `${link}?c=${encodeURIComponent(conversation)}` : link));
      return false;
    }
    const params = new URLSearchParams({ session: sessionId, project, link });
    if (conversation) params.set('conversation', conversation);
    const url = windowControlURL('attach', `?${params.toString()}`);
    if (!url) return false;
    const body = await fetchJson(url, { method: 'POST', errorPrefix: t('Could not open that project') });
    return body?.raised === true;
  }

  /**
   * Show this window's server's sessions page in it, in place of the session
   * it shows: Session ▸ Open… in a desktop window on a server by URL, and
   * where a window goes once the session it showed is stopped from its
   * switcher — the page whose server chooser reaches other servers. A no-op
   * in a browser tab.
   * @returns {Promise<void>} Resolves once the app has taken it.
   */
  async showServerPage() {
    if (hostMovesNoWindow()) {
      // As attachWindow: the server's page is where this session's link is
      // mounted, its project link's /p/<key> taken off.
      window.location.assign(hostedPageURL(`${basePath().replace(/\/p\/[^/]+$/, '')}/`));
      return;
    }
    const url = windowControlURL('server-page');
    if (!url) return;
    await fetchJson(url, { method: 'POST', errorPrefix: t('Could not show the server page') });
  }

  /**
   * Open (or find) the session of a project on this page's machine, through
   * this session, which passes it on to the machine server: what the
   * switcher's Recent rows, a retry and Open folder… ask for.
   * @param {string} project - The folder, absolute or under ~.
   * @param {{wait?: boolean}} [options] - wait: answer once it runs, or failed.
   * @returns {Promise<import('./sessions-feed.js').Session>} The session.
   * @throws {import('./http.js').HttpError} When the machine refuses, saying why.
   */
  async openMachineSession(project, { wait = false } = {}) {
    return await fetchJson(apiUrl('/machine/sessions'), {
      method: 'POST',
      body: wait ? { project, wait } : { project },
      errorPrefix: t('The session could not be started.'),
    });
  }

  /**
   * Relaunch this page's machine server into the build installed in its
   * place, every session stopping with it, through this session, which passes
   * it on — as a viewer off the machine's, when this page is one, which the
   * machine refuses (403) unless it allows it.
   * @param {{quiet?: boolean}} [options] - quiet: only if no work runs in it;
   *   refused (409) otherwise, with the work that runs (services/relaunch-server.js).
   * @returns {Promise<void>} Resolves once the machine server has begun.
   * @throws {import('./http.js').HttpError} When the machine refuses, saying why.
   */
  async relaunchMachine({ quiet = false } = {}) {
    await fetchJson(apiUrl('/machine/relaunch'), {
      method: 'POST',
      body: quiet ? { quiet } : undefined,
      errorPrefix: t('The Juggler server could not be relaunched.'),
    });
  }

  /**
   * Stop a session of this page's machine, or dismiss a failed one, through
   * this session. A stop of this page's own session is answered at once, and
   * carried out after.
   * @param {string} id - The session's id.
   * @returns {Promise<void>} Resolves once the machine has taken it.
   */
  async stopMachineSession(id) {
    await fetchJson(apiUrl(`/machine/sessions/${encodeURIComponent(id)}`), {
      method: 'DELETE',
      errorPrefix: t('The session could not be stopped.'),
    });
  }

  /**
   * Make a folder on this page's machine, through this session; it opens
   * nothing.
   * @param {string} parent - Where, absolute or under ~.
   * @param {string} name - The new folder's name.
   * @returns {Promise<string>} Its absolute path.
   */
  async createMachineFolder(parent, name) {
    const body = await fetchJson(apiUrl('/machine/folders'), {
      method: 'POST',
      body: { parent, name },
      errorPrefix: t('The folder could not be created.'),
    });
    return /** @type {{path: string}} */ (body).path;
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
    // A board comes out of this window looking as it does, framed included
    // (utils/window-border.js); the app hands only a board the border.
    if (isWindowBorderOn()) params.set('border', '1');
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
    await fetchJson(url, { method: 'POST', errorPrefix: t("Couldn't open that board") });
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
      errorPrefix: t('Asset upload failed')
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
