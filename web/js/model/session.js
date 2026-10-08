//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import contextItemRegistry from '../registries/context-item-registry.js';
import Conversation from './conversation.js';
import {
  UNTITLED_BASE,
  UNTITLED_NAME_RE,
  untitledName,
  uniqueSuffixedName,
  PROVISIONAL_NAME_KEY
} from './conversation-naming.js';
import {
  SAVE_DEBOUNCE_MS,
  MAX_MESSAGE_HISTORY,
  DUPLICATE_WHILE_ACTIVE_NOTICE,
  MAX_CONVERSATION_NAME_LENGTH
} from '../utils/constants.js';
import { normalizeAttachments } from '../utils/attachments.js';
import workerManager from '../services/worker-manager.js';
import ConversationLoadQueue from '../services/conversation-load-queue.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { isEngine } from '../../sdk/lib/client-role.js';
import { toSandboxRoot } from '../../sdk/lib/sandbox-runner.js';
import { recordTape } from '../utils/event-tape.js';
import { reportFault } from '../utils/fault-report.js';
import { isTabReorderEnabled } from '../utils/attention-manager.js';
import { setupWorkerCallbacks, setupViewerWorkerCallbacks } from './session-worker-callbacks.js';
import { approvePermittedPendingApprovals } from './conversation-tool-actions.js';
import { isWorkspaceUsable, patchWorkspace, reorderWorkspaces } from '../services/workspaces.js';
import { placeForNewConversation, placementForNewConversation, takesTheHead } from '../services/workspace-provisioning.js';
import ConversationBin from './conversation-bin.js';
import { statusHoldsTurn } from './processing-status.js';
import ConversationSyncReducer from './conversation-sync-reducer.js';
import ConversationRegistry from './conversation-registry.js';
import { seedCreationDefaults, seedConversationAutoItems as seedAutoItems } from './conversation-seeder.js';

/**
 * The rename route's documented refusals (PATCH
 * /api/session/conversations/{id}/name), keyed by HTTP status, as the `.code`
 * renameConversation tags its error with. Any other status carries no code.
 * @type {ReadonlyMap<number, 'INVALID'|'NOT_FOUND'|'COLLISION'>}
 */
const RENAME_ERROR_CODES = new Map(/** @type {const} */ ([
  [400, 'INVALID'],
  [404, 'NOT_FOUND'],
  [409, 'COLLISION'],
]));

/**
 * @typedef {object} ApiService
 * @property {function(): Promise<SessionData>} getSession - Get session
 * @property {function(): Promise<{active: boolean, conversationIds: string[]}>} getActiveConversations - Conversations actively running a turn (excludes approval-parked)
 * @property {function(string | null, HistoryMessage[]|undefined, Record<string, any>|undefined): Promise<{success: boolean}>} updateSession - Update session state
 * @property {function(Record<string, any>): Promise<{metadata: Record<string, any>}>} patchSessionMetadata - Patch session metadata keys
 * @property {function(string, string=, {lane?: string, duplicateFrom?: string, origin?: string, focus?: boolean, focusFrom?: string, place?: string, after?: string}=): Promise<{id: string, name: string, created: string}>} createConversation - Atomically create a new conversation (POST /api/conversations); duplicateFrom clones that conversation's files server-side before announcing; origin is a gesture label logged for create attribution; focus broadcasts a "focus" op asking viewers to switch to the new conversation, attributed to focusFrom; place is 'head', 'after' or 'end' and after names the conversation to sit behind for 'after'
 * @property {function(string, string): Promise<{name: string}>} renameConversation - Rename a conversation's on-disk folder
 * @property {function(string, object): Promise<{success: boolean}>} updateConversation - Update single conversation
 * @property {function(string, {permanent?: boolean, reason?: string}=): Promise<void>} deleteConversation - Delete single conversation
 * @property {function(string): Promise<void>} binConversation - Move single conversation to .juggler/bin/
 * @property {function(string): Promise<void>} restoreConversation - Move conversation back from .juggler/bin/
 * @property {function(): Promise<{binned: Array<{id: string, name: string, lastModifiedAt: string}>}>} listBinnedConversations - List binned conversations
 * @property {function(string): Promise<void>} deleteBinnedConversation - Permanently delete a single binned conversation
 * @property {function((number|null)=): Promise<void>} emptyBin - Permanently delete binned conversations: all of them, or only those last active more than N days ago
 * @property {function(string[], string=): Promise<null>} reorderConversations - Reorder conversations, naming the one a drag moved
 * @property {function(string, Uint8Array): Promise<void>} saveConversationBinary - Save conversation binary state
 */

/**
 * @typedef {object} SessionData
 * @property {string} id - Session ID
 * @property {string} projectPath - Project path
 * @property {string} [platform] - Platform (darwin/linux/windows)
 * @property {string[]} [conversationOrder] - Conversation IDs in order (v4 format with binary storage)
 * @property {string} activeConversationId - Active conversation ID
 * @property {string} [home] - Backend user-home directory (e.g. /Users/jules)
 * @property {ProviderInfo} providerInfo - Provider information
 * @property {Array<string|HistoryMessage>} [messageHistory] - Session-level message history for input navigation. Entries may be legacy bare strings until normalized.
 * @property {Record<string, any>} [metadata] - General-purpose key-value store for frontend flags
 * @property {Workspace[]} [workspaces] - The registered workspaces; absent until one is made
 * @property {Record<string, {hostsLocalProviders?: boolean}>} [workspaceKinds] - What each kind of workspace can do; registered at server startup and fixed for the run
 */

/**
 * One registered workspace, as the server reports it — the row, verbatim, from
 * `cmd/juggler/core/workspace.go`. Kind and Root are carried on the row rather
 * than asked of whichever extension made it, so a workspace stays resolvable
 * while its provider is disabled, uninstalled, or simply failing to load.
 *
 * The default workspace is NOT one of these: it has no row, its id is '', and
 * its root is {@link Session#projectPath}.
 * @typedef {object} Workspace
 * @property {string} id - Server-assigned, stable for the workspace's life
 * @property {string} kind - Selects the ops backend; 'local' today
 * @property {string} root - Absolute path, in terms the kind understands
 * @property {string} [label] - What the UI calls it, e.g. "feat/tunnels"
 * @property {string} [place] - Where its box sits in the tab bar: 'head', or the conversation it sits behind. Empty or absent is a row with no place recorded, drawn by its first member instead
 * @property {string} [providerId] - Extension owning its lifecycle; empty for one nobody manages
 * @property {string} [baseWorkspaceId] - The workspace it was provisioned from; empty means the default
 * @property {string} state - 'provisioning' | 'ready' | 'closed'
 * @property {Record<string, any>} [meta] - The provider's own record of what it built; opaque here
 * @property {boolean} [available] - Whether its root was there when the server last looked
 * @property {boolean} [stale] - Provisioning, but nothing is provisioning it
 */

/**
 * @typedef {object} ProviderInfo
 * @property {string} provider - Provider name
 * @property {string} model - Model name
 * @property {number} contextWindow - Context window size
 */

/**
 * One entry in the session-level prompt history (up/down-arrow navigation).
 * The persisted shape of a sent user message: expanded prose plus any image
 * attachments. This mirrors a committed user item's fields on purpose — history
 * carries a denormalized copy of the message, not a bespoke type — so anything
 * that consumes a message can consume a history entry. Draft-only affordances
 * (paste-placeholder blobs) are NOT part of a sent message and stay out.
 * @typedef {{content: string, attachments: import('../utils/attachments.js').AssetRef[]}} HistoryMessage
 */

/**
 * @typedef {import('./conversation.js').Message} Message
 */

/**
 * @typedef {import('./conversation-document.js').ContextItemJSON} ContextItemJSON
 */

/**
 * @typedef {object} ContextItemUpdates
 * @property {object} [data] - Context item data updates
 */

/**
 * @typedef {object} ConversationServices
 * @property {import('../services/llm-state.js').default} llmState - LLM state manager for tracking processing
 * @property {import('../services/action-executor.js').default} actionExecutor - Action executor for cancellation
 * @property {import('../services/websocket.js').default} wsService - WebSocket service; the Session subscribes its server-push listeners on it (setServices). Conversation does not read it.
 * NOTE: conversationArea is supplied per-tab via setTabElement(), not through this services object.
 */

/**
 * Session - Client-side session state with auto-save to backend
 *
 * Manages the current session state including context items and messages.
 * Automatically loads from and saves to the backend.
 * @class
 */

/**
 * Hard upper bound on simultaneously-active (non-binned) conversations.
 * Enforced at every creation path (new + duplicate) so the cap is a real
 * invariant, not a button-disable that other paths can sneak past. Hitting it
 * surfaces a "bin some tabs to make room" message at the UI entry point.
 * @type {number}
 */
export const MAX_CONVERSATIONS = 32;

/**
 * Coerce one persisted history entry into a {@link HistoryMessage}. Tolerates
 * the legacy shape (a bare string, from before history stored attachments) by
 * wrapping it as `{content, attachments: []}`, and defends against a
 * malformed/null entry by degrading to an empty message. Attachments are run
 * through {@link normalizeAttachments} so they are always plain AssetRefs.
 * @param {unknown} entry - A raw entry from the persisted messageHistory array.
 * @returns {HistoryMessage} The normalized entry.
 */
export function normalizeHistoryEntry(entry) {
  if (typeof entry === 'string') return { content: entry, attachments: [] };
  if (entry && typeof entry === 'object') {
    const e = /** @type {{content?: unknown, attachments?: unknown}} */ (entry);
    return {
      content: typeof e.content === 'string' ? e.content : '',
      attachments: normalizeAttachments(e.attachments)
    };
  }
  return { content: '', attachments: [] };
}

/**
 * User-facing message shown when a creation path is blocked by the cap.
 * Lives next to the constant so the number stays in sync; UI entry points
 * render it via window.showAlert (keeping modal UI out of the model layer).
 * @type {string}
 */
export const CONVERSATION_LIMIT_MESSAGE =
  `You can have at most ${MAX_CONVERSATIONS} conversations open at once. ` +
  'Bin some tabs to make room for new ones.';

class Session {
  /**
   * Create a new session
   * @param {ApiService} apiService - API service instance
   */
  constructor(apiService) {
    /**
     * API service for backend communication
     * @type {ApiService}
     * @private
     */
    this._apiService = apiService;

    /**
     * Set once destroy() has run, so a second call is a no-op.
     * @type {boolean}
     * @private
     */
    this._destroyed = false;

    /**
     * The open conversations: their tab-bar order, what is on screen, the
     * most-recently-used list and the name cache. The session decides what
     * happens to the list and the registry records it; it is the only writer.
     * `switchConversation` and `selectWorkspace` are the ways to move the
     * selection.
     * @type {ConversationRegistry}
     */
    this.registry = new ConversationRegistry();

    /**
     * In-flight {@link Session#initialiseConversation} passes, by conversation
     * id. The commit hop is on every path that puts content into a conversation
     * — a send, a mention, a drop — so two of them can arrive together on a
     * conversation that has not been initialised yet. They share the one pass
     * rather than each seeding the conversation again.
     * @type {Map<string, Promise<void>>}
     * @private
     */
    this._initialising = new Map();

    /**
     * Ids this client has removed locally whose removal the server has not yet
     * acknowledged — the bin or delete request is still on the wire.
     *
     * A removal is local-first: the conversation leaves the map, then the
     * request goes out. For the width of that request the two disagree, and the
     * manifest is still the server's answer — the server serializes session
     * state on one goroutine that drains reads ahead of queued writes, so a GET
     * issued after the removal request can be answered before it. A refresh
     * reading that manifest finds an id it doesn't hold, takes it for a
     * conversation another viewer just made, and loads it back.
     *
     * So the map is not the whole of what this client knows: an id in here was
     * removed deliberately, and a manifest that still lists it is stale rather
     * than newer. {@link Session#refreshFromServer} is the only reader.
     * @type {Set<string>}
     * @private
     */
    this._removedPendingConfirm = new Set();

    /**
     * Services object passed to Conversation instances
     * Set via setServices() after services are initialized
     * @type {ConversationServices|null}
     * @private
     */
    this._services = null;

    /**
     * Project path
     * @type {string}
     */
    this.projectPath = '';

    /**
     * The workspaces this session has registered — every place a conversation
     * can work other than the project itself. The server owns the table; this
     * is a copy of it, replaced whole by the load and by each
     * `workspaces-changed` broadcast.
     *
     * The default workspace is deliberately not in here. It has no row, its id
     * is '' and its root is {@link Session#projectPath}, so putting it in the
     * list would make "is this workspace registered" and "is this the project"
     * the same question.
     * @type {Workspace[]}
     */
    this.workspaces = [];

    /**
     * What each KIND of workspace can do, keyed by kind name — the part a row
     * does not carry, because it belongs to the transport rather than to the
     * place. Sent once with the load: kinds are registered when the server
     * starts and cannot change under a running client.
     * @type {Record<string, {hostsLocalProviders?: boolean}>}
     */
    this.workspaceKinds = {};

    /**
     * Platform (darwin/linux/windows)
     * @type {string}
     */
    this.platform = '';

    /**
     * Backend user-home directory (e.g. /Users/jules). Used to safely resolve
     * '~/<path>' in command-approval analyses; without it those paths can only
     * be matched lexically.
     * @type {string}
     */
    this.home = '';

    /**
     * Provider information (provider, model, contextWindow)
     * @type {ProviderInfo|null}
     */
    this.providerInfo = null;

    /**
     * Session-level message history for input navigation.
     * Normalized {@link HistoryMessage} entries shared across all conversations.
     * @type {HistoryMessage[]}
     */
    this.messageHistory = [];

    /**
     * General-purpose key-value store for frontend flags
     * Used for things like hasScannedBuiltinFacts, etc.
     * @type {Record<string, any>}
     */
    this.metadata = {};

    /**
     * Event listeners
     * @type {Map<number, Function>}
     * @private
     */
    this._listeners = new Map();

    /**
     * Next listener ID
     * @type {number}
     * @private
     */
    this._nextListenerId = 1;

    /**
     * Debounce timer for auto-save
     * @type {number|null}
     * @private
     */
    this._saveTimer = null;

    /**
     * Whether session is currently loading
     * @type {boolean}
     * @private
     */
    this._loading = false;

    /**
     * Promise for in-flight load operation
     * Used to prevent duplicate loads and ensure synchronization
     * @type {Promise<void>|null}
     * @private
     */
    this._loadPromise = null;

    /**
     * Whether worker manager has been initialized
     * @type {boolean}
     * @private
     */
    this._workerManagerInitialized = false;

    /** @type {ConversationLoadQueue|null} @private */
    this._loadQueue = null;

    /**
     * The project's bin: its count and size, and the requests that list,
     * restore and permanently delete what is in it.
     * @type {ConversationBin}
     */
    this.bin = new ConversationBin(() => this._apiService);

    const session = this;
    /**
     * The reducer for the server's `conversations-changed` broadcast, and the
     * echo and focus bookkeeping it needs. Each host entry is read at call
     * time, so a test that replaces one of these methods on the session is
     * replacing it for the reducer too.
     * @type {ConversationSyncReducer}
     */
    this.sync = new ConversationSyncReducer({
      holds: (id) => this.registry.has(id),
      order: () => this.registry.ids(),
      setName: (id, name) => this.setConversationName(id, name),
      notify: (type, data) => this._notify(type, data),
      notifyChange: (type, data) => this.notifyConversationChange(type, data),
      loadAtHead: (id) => this._loadIntoHead(id),
      drop: (id, opts) => this._dropActiveConversation(id, opts),
      reorder: (ids) => this.registry.arrange(ids),
      follow: (id) => { this.switchConversation(id); },
      shouldFollow: (from) => this.shouldFollowRequest(from),
      get bin() { return session.bin; }
    });
  }

  /**
   * The open conversations, in tab-bar order — the registry's map, read-only.
   * There is no setter: the list is written through {@link registry} alone.
   * @returns {ReadonlyMap<string, import('./conversation.js').default>} The live map.
   */
  get conversations() {
    return this.registry.conversations;
  }

  /**
   * What is on screen. See {@link ConversationRegistry#selection}.
   * @returns {import('./conversation-registry.js').Selection|null} The selection.
   */
  get selection() {
    return this.registry.selection;
  }

  /**
   * The conversation that stays loaded and is reopened next time — never what
   * decides what is showing. See {@link ConversationRegistry#loadedConversationId}.
   * @returns {string|null} The id.
   */
  get loadedConversationId() {
    return this.registry.loadedConversationId;
  }

  /**
   * Resolve a conversation's display name from the cached projection of
   * GET /api/session's `conversationNames` map. Returns the empty string
   * if the id is unknown (the conversation hasn't been seen on disk yet).
   * @param {string} id
   * @returns {string} Display name, or '' when no cache entry exists.
   */
  getConversationName(id) {
    return this.registry.name(id);
  }

  /**
   * Update the cached name for `id`. Used by the rename / create /
   * duplicate flows to surface the canonical name returned by the
   * server immediately, ahead of the next session refresh. The on-disk
   * folder remains the source of truth — this write is overwritten on
   * the next GET /api/session.
   * @param {string} id
   * @param {string} name
   */
  setConversationName(id, name) {
    this.registry.setName(id, name);
  }

  /**
   * Decide whether this viewer follows a request from a conversation. A request
   * to move the user is only allowed when the user is actually watching that
   * conversation and has not started composing: switching away from a different
   * tab, or covering a half-typed message, loses the user's place and draft
   * context. An unattributed request (no `from`) is followed unconditionally.
   * @param {string} from - Conversation that requested the presentation change.
   * @returns {boolean} True when the request may be followed.
   */
  shouldFollowRequest(from) {
    if (!from) return true;
    if (this.visibleConversationId !== from) return false;
    const tab = this.getConversation(from)?.getTabElement?.();
    return !tab?.hasComposerText?.();
  }

  /**
   * Release a conversation this realm holds but has no further reason to.
   *
   * The engine's counterpart to the viewer's delete/bin handling. The engine
   * loads a conversation lazily — the first time a worker syncs one to it — and
   * otherwise never lets go: the Yjs document, its observers and the worker
   * entry stay for the process lifetime, across project switches, including
   * conversations the user threw away long ago. That is unbounded growth in the
   * one realm that has to stay responsive, and a WebView out of memory presents
   * exactly like a wedged realm.
   *
   * In-flight work is cancelled rather than waited out. These executions have
   * nowhere left to report — the server-side worker is gone and the document
   * beneath them is about to be destroyed — so running them to completion writes
   * a result into a torn-down doc. A command the worker dispatches in the race
   * window finds no loaded conversation and is declined with `conv-not-loaded`,
   * which the worker reads as "the engine could not reach the tool" and holds
   * rather than blames (engineUnreachableReasons, worker/tool_command_state.go).
   *
   * Viewer-only state (the visible conversation, the tab fallback) is
   * deliberately untouched: a viewer reaches the same teardown through
   * the `deleted` broadcast ({@link ConversationSyncReducer#deleted}), which
   * owns those.
   * @param {string} id - Conversation to release
   * @returns {Promise<boolean>} True if a loaded conversation was released
   */
  async releaseConversation(id) {
    const conv = this.registry.get(id);
    if (!conv) return false;
    /** @type {any} */ (conv)._actionExecutor?.cancelConversationActions?.(id);
    await this._teardownConversation(conv, 'releaseConversation');
    return true;
  }

  /**
   * The teardown both removal paths share — {@link Session#releaseConversation}
   * and {@link Session#_dropActiveConversation}: stop any queued load, destroy
   * the worker, then remove it from the registry. Each caller adds only what is
   * its own (an action cancel; a fallback selection).
   * @param {any} conv - The loaded conversation being removed
   * @param {string} from - Caller, for the tape
   * @returns {Promise<void>}
   * @private
   */
  async _teardownConversation(conv, from) {
    this._loadQueue?.cancel(conv.id);
    await workerManager.loader.destroy(conv);
    this.registry.remove(conv.id, from);
  }

  /**
   * Tear down a conversation's worker and remove it from the active map,
   * MRU list, and (if visible) switch to a fallback. Returns the removed
   * `conv` so the caller can fire the appropriate notify, or null if the
   * id wasn't in the active map.
   * @param {string} id
   * @param {{clearVisibleIfNoFallback: boolean}} opts
   * @returns {Promise<object|null>} Removed conv, or null if not active.
   */
  async _dropActiveConversation(id, { clearVisibleIfNoFallback }) {
    const conv = this.registry.get(id);
    if (!conv) return null;
    await this._teardownConversation(conv, '_dropActiveConversation');
    // The one being dropped may be the conversation behind a workspace panel
    // rather than the one on screen, and it needs replacing either way.
    if (this.loadedConversationId === id) {
      const fallbackId = this.registry.fallback();
      if (fallbackId !== undefined) {
        this.switchConversation(fallbackId);
      } else if (clearVisibleIfNoFallback) {
        recordTape('session-mut', null, { op: 'visible', from: '_dropActive-clearFallback' });
        this.registry.clearSelection();
      }
    }
    return conv;
  }

  /**
   * Take ownership of a conversation this session did not build itself.
   *
   * The worker manager constructs a Conversation and must have it findable in
   * the active map BEFORE it spawns the worker (the first yjs-sync arrives
   * immediately), so the entry lands from outside — but the map is the tab-bar
   * order, written only through the registry, so it lands through here. `atHead`
   * puts the tab where a brand-new
   * conversation belongs — the front of the bar, or the front of its workspace's
   * box when it is bound to one (see {@link placeForNewConversation}) — and it
   * must be there from its first render, not after the spawn completes.
   * @param {string} id - Conversation id
   * @param {import('./conversation.js').default} conv - The conversation to insert
   * @param {{atHead?: boolean, workspaceId?: string, from?: string}} [opts] - `workspaceId`
   *   is the tree it will work in, which decides where the front is; `from`
   *   labels the tape entry
   */
  adoptConversation(id, conv, { atHead = false, workspaceId = '', from = 'adoptConversation' } = {}) {
    if (atHead) {
      this._placeNewConversation(id, conv, workspaceId, from);
    } else {
      this.registry.insert(id, conv, from);
    }
  }

  /**
   * Put a brand-new conversation into the tab-bar order.
   *
   * Where it goes is {@link placeForNewConversation}'s answer, and the whole of
   * the arithmetic here is turning that index into the full order the registry
   * arranges. Idempotent, because it is run twice for one conversation: once
   * when the worker manager adopts it, and again when the create that asked for
   * it returns — the second is what settles the order if anything moved in
   * between, and it must not shuffle the tab along on its way past.
   * @param {string} id - Conversation id
   * @param {import('./conversation.js').default} conv - The conversation being placed
   * @param {string} [workspaceId] - The tree it will work in, if it is one
   * @param {string} [from] - Caller, for the tape entry its arrival leaves
   * @private
   */
  _placeNewConversation(id, conv, workspaceId = '', from = '_placeNewConversation') {
    const index = placeForNewConversation(this, workspaceId, { ignore: id });
    const ids = this.registry.ids().filter(existing => existing !== id);
    ids.splice(index, 0, id);
    this.registry.arrange(ids, new Map([[id, conv]]), from);

    // Stored from here rather than from the server's own create, which is told
    // only that the conversation goes at the front of the order. Whether that
    // also makes it the top of the *bar* turns on whether it is drawn inside a
    // box, and the binding that decides it is this client's to know.
    for (const workspace of this._takeTheHeadFromBoxes(id, workspaceId)) {
      patchWorkspace(workspace, { place: id }).catch((error) => {
        console.error("[Session] Couldn't store where the workspace box was pushed down to:", error);
      });
    }
  }

  /**
   * Hand the head of the bar to a conversation that has just arrived at it.
   *
   * The head is one position and one thing holds it — the topmost tab, or a box
   * whose row names it. A conversation created outside every box goes to the top
   * of the flat order, which is the top of the bar, so the boxes that were at the
   * head are behind it now and their rows are rewritten to say so. One started
   * inside a box is drawn in it, never above it, and takes nothing.
   *
   * The arrival counterpart of {@link Session#_reanchorBoxesBeforeMove}: a box is
   * placed by what is above it, so something new above it moves it exactly as
   * something leaving does. Without this a box at the head stays pinned there and
   * every new tab appears underneath it, which is not what "new tabs go to the
   * top" means anywhere else in the bar.
   *
   * Rewritten locally so the strip redraws with the tab. Storing it is the
   * caller's, because the rewrite is what a test can ask about on its own and a
   * round trip is not.
   * @param {string} id - The conversation that has taken the head.
   * @param {string} [workspaceId] - The tree it will work in, if it is one.
   * @returns {string[]} The workspaces whose place changed, for storing.
   * @private
   */
  _takeTheHeadFromBoxes(id, workspaceId = '') {
    if (!takesTheHead(this, workspaceId)) return [];

    const displaced = (this.workspaces ?? []).filter(row => row.place === 'head');
    if (displaced.length === 0) return [];

    this.workspaces = this.workspaces.map(row =>
      (row.place === 'head' ? { ...row, place: id } : row));
    this._notify('session:workspaces-changed', this.workspaces);

    return displaced.map(row => row.id);
  }

  /**
   * Drop an entry from the active map without tearing anything down.
   *
   * For a conversation that never finished arriving — an auto-load that came
   * back without metadata, say — where the entry is expected to be re-made on
   * the next sync. A conversation that really is going away goes through
   * {@link Session#releaseConversation} or the delete/bin paths instead: those
   * destroy the worker and the document, which this deliberately does not, and
   * the MRU list is left alone here for the same reason.
   * @param {string} id - Conversation id
   * @param {string} [from] - Label for the tape entry
   * @returns {boolean} True if an entry was dropped
   */
  forgetConversation(id, from = 'forgetConversation') {
    return this.registry.forget(id, from);
  }

  /**
   * Load a conversation from disk into the head of the tab bar: the arrival
   * path for a conversation another viewer created or restored (the sync
   * reducer's `loadAtHead`). Returns the loaded `conv`, or null if loading
   * failed (the error is logged).
   * @param {string} id
   * @returns {Promise<object|null>} Loaded conv, or null if load failed.
   * @private
   */
  async _loadIntoHead(id) {
    // Claim the head slot BEFORE the load, not after it. The loader's
    // loadExisting seeds its own entry (adoptConversation) and then
    // awaits a worker spawn that can take seconds — so ordering the map only on
    // completion leaves the tab parked at the END of the bar for the whole load
    // and then jumps it to the top. An unloaded stub here is the same entry
    // loadExisting reuses, so every render in between paints the tab in its
    // final position. Mirrors the local-create path (loader.createNew).
    let stubbed = false;
    if (!this.registry.has(id)) {
      const services = this.getServices();
      if (services) {
        const stub = new Conversation(
          id,
          this.registry.name(id) || UNTITLED_BASE,
          this,
          services,
          { skipBuiltInContextItems: true, loadState: 'unloaded' }
        );
        this.registry.arrange([id], new Map([[id, stub]]), '_loadIntoHead-stub');
        stubbed = true;
        // Announce it now, not when the worker lands. Subscribers paint from the
        // map but only inside a render, and they render on notifies — so holding
        // the announcement back for the spawn leaves the tab strip unchanged for
        // the whole load, and unchanged forever if it fails. That is the Undo
        // that visibly does nothing until an unrelated event repaints the bar.
        // The stub is a first-class tab: it draws its own spinner and hydrates
        // when selected. The notify the load fires on completion rebinds this
        // same entry rather than adding a second one.
        this._notify('conversation:created', stub);
      }
    }

    try {
      const conv = await workerManager.loader.loadExisting(id, this);
      this.registry.arrange([id], new Map([[id, conv]]), '_loadIntoHead');
      return conv;
    } catch (error) {
      console.error(`[Session] load failed for ${id}:`, error);
      // Drop the placeholder we put at the head — a conversation that never
      // loaded must not leave a permanent dead tab at the top of the bar. It was
      // announced on the way in, so announce the removal too: subscribers hold
      // per-conversation elements keyed off the create, and dropping the map
      // entry silently strands them.
      const stub = this.registry.get(id);
      if (stubbed && stub?.loadState === 'unloaded') {
        this.registry.remove(id, '_loadIntoHead-stub-failed');
        this._notify('conversation:deleted', stub);
      }
      return null;
    }
  }

  /**
   * Subscribe to session changes
   * @param {Function} callback - Callback function (event) => void
   * @returns {Function} Unsubscribe function
   */
  subscribe(callback) {
    const id = this._nextListenerId++;
    this._listeners.set(id, callback);

    return () => {
      this._listeners.delete(id);
    };
  }

  /**
   * Set services object for creating Conversation instances
   * Must be called before loading session or creating conversations
   * @param {ConversationServices} services - Services object
   */
  setServices(services) {
    this._services = services;

    // Register session-wide file change listener
    if (services.wsService) {
      /** @type {import('../services/websocket.js').WSEventCallback} */
      this._fileChangeHandler = (changes) => {
        const conv = this.getVisibleConversation();
        if (!conv) return;
        const fileChanges = /** @type {Array<{path: string, event: string}>} */ (changes);
        for (const contextItem of conv.rootMessageThread.contextItems) {
          const manifest = /** @type {any} */ (contextItem.constructor).MANIFEST;
          if (manifest?.watchesFileChanges && /** @type {any} */ (contextItem).onFileChange) {
            for (const change of fileChanges) {
              /** @type {any} */ (contextItem).onFileChange(change.path, change.event);
            }
          }
        }
      };
      services.wsService.on('file-change', this._fileChangeHandler);

      // When the server changes its loaded project, every connected client
      // must reload to repopulate session state from the new project.
      this._projectChangedHandler = (/** @type {unknown} */ data) => {
        // The engine is persistent across a runtime project switch and, unlike
        // viewers, never reloads (it has no page to reload). It must still
        // repoint its project root: otherwise the query_code sandbox keeps
        // exposing the PREVIOUS project's root to the model, which then reads /
        // globs the old tree while the header bar shows the new project.
        if (isEngine()) {
          // Fire-and-forget: the reseed it kicks off guards its own failures,
          // and the websocket callback must not block on a session refetch.
          void this._applyEngineProjectRoot(/** @type {{projectPath?: string}} */ (data)?.projectPath);
          return;
        }
        // Viewers: hard reload — the worker manager, conversation tabs, context
        // items, and Yjs documents are all keyed off the old project's state and
        // need the teardown/rebuild a fresh page load performs anyway.
        if (typeof window !== 'undefined') window.location.reload();
      };
      services.wsService.on('project-changed', this._projectChangedHandler);

      // The server learns some models' true context window only after the
      // first turn — claudecode reads it from the CLI result event — and then
      // rebroadcasts the provider list. Re-resolve each loaded conversation's
      // cached context window from the fresh list so footers stop showing the
      // cold-start fallback (e.g. 200k for a 1M-window opus) once the real
      // number is known.
      /** @type {import('../services/websocket.js').WSEventCallback} */
      this._providersUpdateHandler = (providers) => {
        const list = /** @type {Array<any>} */ (Array.isArray(providers) ? providers : []);
        for (const conv of this.conversations.values()) {
          if (conv.applyProvidersContextWindow(list)) {
            this._notify('conversation:context-window-updated', conv);
          }
        }
      };
      services.wsService.on('providers-update', this._providersUpdateHandler);

      // The workspace table is session state like the pinboard, not a per-device
      // preference: the server owns it and republishes the whole table after
      // every edit, so a window that is only watching still sees a workspace
      // appear, become usable, and be finished with. Replaced whole rather than
      // merged — an empty list is an edit like any other (the last workspace
      // being unregistered), so it cannot be read as "nothing to say".
      /** @type {import('../services/websocket.js').WSEventCallback} */
      this._workspacesChangedHandler = (data) => {
        const list = /** @type {{workspaces?: Workspace[]}} */ (data)?.workspaces;
        this.workspaces = Array.isArray(list) ? list : [];
        this._notify('session:workspaces-changed', this.workspaces);
      };
      services.wsService.on('workspaces-changed', this._workspacesChangedHandler);
    }
  }

  /**
   * The registered workspace with this id.
   *
   * The default workspace is deliberately not one of them: it has no row, and a
   * caller needing its root already holds {@link Session#projectPath}. Asking
   * for '' here is a miss, not the project — the same rule the server applies
   * in `Session.FindWorkspace`.
   * @param {string} id - Workspace id
   * @returns {Workspace|null} The workspace, or null when the session has no such row
   */
  getWorkspace(id) {
    if (!id) return null;
    return this.workspaces.find(ws => ws.id === id) || null;
  }

  /**
   * Call a workspace something else.
   *
   * The label is the whole of what a workspace is called — nothing on disk is
   * named after it, and no two workspaces have to differ — so this is a plain
   * write, and the only refusals come from the server (a row that has been
   * closed, a label longer than it will store).
   *
   * The table is updated here as well as by the broadcast that follows, so the
   * box shows the new name the moment the server takes it rather than a round
   * trip later. The broadcast is still the authority: it replaces this copy
   * whole, and every other window hears it the same way.
   * @param {string} workspaceId - The workspace to rename.
   * @param {string} label - What to call it.
   * @returns {Promise<Workspace>} The row as it now stands.
   */
  async renameWorkspace(workspaceId, label) {
    const stored = await patchWorkspace(workspaceId, { label });
    const rows = this.workspaces ?? [];
    const at = rows.findIndex(row => row.id === workspaceId);
    if (at !== -1) {
      this.workspaces = rows.map((row, i) => (i === at ? stored : row));
      this._notify('session:workspaces-changed', this.workspaces);
    }
    return stored;
  }

  /**
   * Where a binding says to work: the root a conversation's tools run in, its
   * provider is spawned in, and its seeds are read from.
   *
   * `''` is the project, which is what every conversation meant before
   * workspaces existed. Any other id must resolve to a workspace that can
   * actually be worked in, and the answer when it cannot is `null` — never the
   * project. A stale binding quietly resolving to the project root would edit
   * the wrong tree and look exactly like working.
   *
   * These are the same four refusals the server makes in
   * `WorkspaceLookup.Usable`, and they have to agree: what the client shows and
   * what the operation does must not be two different answers. The server's
   * fourth is a `stat` of the root; here it is `available`, which is that stat,
   * recomputed at every load and carried on every broadcast.
   * @param {string} id - Workspace id, '' for the project
   * @returns {string|null} The root to work in, or null if the binding cannot be honoured
   */
  workspaceRoot(id) {
    if (!id) return this.projectPath;
    const ws = this.getWorkspace(id);
    return isWorkspaceUsable(ws) ? ws.root : null;
  }

  /**
   * Whether a workspace can host a provider Juggler spawns as a subprocess — a
   * CLI agent, run in the conversation's own directory.
   *
   * The project can, and so can anything on this machine. A workspace reached
   * over a wire cannot: the CLI would run here, in a directory that is not the
   * one every file operation of that turn uses, and the user would find out
   * through answers that made no sense.
   *
   * A kind nobody described answers yes. Not a fallback so much as an
   * acknowledgement: a kind this client has never heard of has no backend
   * either, so the turn is already going to be refused for a reason the server
   * can state — and disabling every CLI model over an answer we do not have
   * would be a refusal we could not explain.
   * @param {string} id - Workspace id, '' for the project.
   * @returns {boolean} True when a spawned provider would run in the right place.
   */
  workspaceHostsLocalProviders(id) {
    if (!id) return true;
    const kind = this.getWorkspace(id)?.kind;
    if (!kind) return true;
    return this.workspaceKinds[kind]?.hostsLocalProviders !== false;
  }

  /**
   * Repoint the engine's project root after a runtime project switch.
   *
   * The engine host captures its project root once at boot (Node: the
   * JUGGLER_PROJECT_ROOT env var; webview: the sandbox HTML template) and,
   * being persistent across SwitchProject, never reloads to pick up a new one.
   * This updates both `session.projectPath` and the live
   * `globalThis.__jugglerProjectRoot` that the query_code sandbox delegates fall
   * back to per run (a tool names its conversation's own root, so the global is
   * what answers a caller with none), so a switched project stops leaking the
   * previous root to the model. No-op-safe for viewers (they hard-reload
   * instead); only the engine realm calls this.
   *
   * The path is repointed synchronously (callers and the sandbox read it
   * immediately); the rest of the project-scoped state a viewer gets free from
   * its reload is reseeded asynchronously — see
   * {@link _reseedProjectScopedState}, whose promise is returned so callers
   * that care can await the full switch.
   * @param {string} [newPath] - The switched-to project root ("" = no project)
   * @returns {Promise<void>} Resolves once the project-scoped state is reseeded
   */
  _applyEngineProjectRoot(newPath) {
    this.projectPath = newPath || '';
    /** @type {any} */ (globalThis).__jugglerProjectRoot =
      toSandboxRoot(this.projectPath);
    workerManager.setProjectPath(this.projectPath);
    this._releaseProjectScopedConversations();
    return this._reseedProjectScopedState();
  }

  /**
   * Release the previous project's conversations from the engine on a switch.
   *
   * Conversations are project-bound (transcript folder, Yjs doc, context
   * items), and the server already dropped them as part of the switch
   * (`conversationCache.CloseAllConversations`). A viewer sheds them by
   * reloading; the persistent engine would otherwise hold every doc it had
   * touched for the rest of the process, and judge their parked approvals
   * against the NEXT project's permission rules.
   *
   * Only client-side bookkeeping is torn down: `workerManager.terminateAll`
   * clears local worker tracking without killing the server-lifetime workers,
   * which deliberately outlive a switch. If one of those is still live and
   * syncs again, the ordinary auto-load path rebuilds the conversation against
   * the loaded project — the authority for what exists.
   * @private
   */
  _releaseProjectScopedConversations() {
    workerManager.terminateAll();
    for (const conv of this.registry.conversations.values()) {
      try {
        conv.destroy?.();
      } catch (err) {
        console.error('[Session] Failed to release a conversation on project switch:', err);
      }
    }
    this.registry.reset();
  }

  /**
   * Adopt the session-level state a manifest (`GET /api/session`) carries:
   * platform, home, message history and metadata. The one reader of those
   * fields, shared by the first load, the post-project-switch reseed and every
   * refresh, so all three agree on what an absent field means.
   *
   * The manifest is the authority, so absent means EMPTY, not "keep what we
   * had": the server omits `metadata` when the map is empty (`omitempty` on
   * core.Session) and sends `messageHistory: null` when there is none, so a
   * reader that kept its old value on absence would hold stale state after
   * another viewer cleared it. Platform and home are facts about the machine
   * and are only overwritten by a value.
   * @param {SessionData} data - The manifest
   * @param {{notify: boolean}} opts - notify: announce the metadata to
   *   subscribers as a remote change (false only for the first load, which has
   *   no prior state to change from)
   * @private
   */
  _applyManifestState(data, { notify }) {
    if (data.platform) this.platform = data.platform;
    if (data.home) this.home = data.home;
    this.messageHistory = Array.isArray(data.messageHistory)
      ? data.messageHistory.map(normalizeHistoryEntry)
      : [];
    const metadata = data.metadata || {};
    this.metadata = metadata;
    if (notify) {
      this._notify('session:metadata-changed', {
        keys: Object.keys(metadata),
        metadata,
        remote: true
      });
    }
  }

  /**
   * Re-read the project-scoped session state after a project switch — the work
   * a viewer gets for free by hard-reloading into a fresh `_doLoad`.
   *
   * `session.metadata` is where session-scoped permission rules
   * (`sessionPermissionRules`) and folder grants (`sessionAllowedPaths`) live,
   * and it belongs to ONE project's `session.json`. The engine is persistent
   * across a switch, so without this it keeps serving the previous project's
   * rules while `projectPath` already names the new one — the two halves
   * `isPermitted` reads disagree. A command matching a standing rule of the
   * switched-to project is then wrongly parked for approval, and the suggestion
   * engine offers to add the very rule the user already has; conversely the old
   * project's folder grants would still authorise commands here.
   *
   * Metadata is REPLACED, not patched: a switch means a different session.json,
   * so a key absent from the new project must disappear rather than linger.
   * A switch that lands while this is in flight wins — the late response is
   * dropped rather than reinstating the project we just left.
   * @returns {Promise<void>} Resolves once metadata/history are reseeded
   * @private
   */
  async _reseedProjectScopedState() {
    const requestedFor = this.projectPath;
    /** @type {SessionData|null} */
    let data = null;
    try {
      data = await this._apiService.getSession();
    } catch (error) {
      console.error('[Session] Failed to reload session state after a project switch:', error);
      return;
    }
    if (this.projectPath !== requestedFor) return;

    this._applyManifestState(data, { notify: true });

    // The switch already released the previous project's conversations, so this
    // covers the race window between that and the metadata landing: a worker
    // that syncs in between auto-loads a conversation which evaluates its
    // approvals against the outgoing rules. Re-judge them against the loaded
    // project's, so a command covered by a standing rule here stops waiting on
    // an approval it never needed.
    for (const conversation of this.conversations.values()) {
      try {
        approvePermittedPendingApprovals(conversation, {
          allowViewer: true,
          itemTypes: ['execute', 'write-file']
        });
      } catch (err) {
        console.error('[Session] permission re-check failed after a project switch:', err);
      }
    }
  }

  /**
   * Whether a conversation is mid-turn (LLM busy ANYWHERE in it), read straight
   * from its processingState Yjs metadata — the top-level projection, which
   * reports a non-idle status while any of its threads holds a run.
   * Conversation-wide on purpose: this orders TABS, and a tab is busy if
   * anything inside it is. Used only by the busy-barrier in bumpConversation,
   * so a bumped tab tucks beneath the leading run of busy tabs instead of
   * jumping over them.
   * @param {import('./conversation.js').default} [conv]
   * @returns {boolean} True while the conversation is mid-turn (LLM busy)
   * @private
   */
  _isConvBusy(conv) {
    if (!conv) return false;
    if (conv.llmState?.isConversationProcessing?.(conv.id)) return true;
    return statusHoldsTurn(conv.getMetadata('processingState')?.status);
  }

  /**
   * Names of every conversation the server reports as actively running a turn.
   * Read from the authoritative server signal (GET /api/health/active), which
   * excludes turns parked solely on a pending tool approval — those are doing no
   * work and survive a restart intact, so they must not provoke a warning. Used
   * before a destructive action that tears this session down (switching the
   * window to another project). Returns [] if the server can't be reached
   * (fail-open: nothing we can prove is running).
   * @returns {Promise<string[]>} Display names of actively-running conversations
   */
  async busyConversationNames() {
    /** @type {string[]} */
    let ids = [];
    try {
      const health = await this._apiService.getActiveConversations();
      if (health && health.active && Array.isArray(health.conversationIds)) {
        ids = health.conversationIds;
      }
    } catch (_e) {
      return [];
    }
    return ids.map((/** @type {string} */ id) => this.getConversationName(id) || UNTITLED_BASE);
  }

  /**
   * Cancel every locally loaded conversation that is currently active, optionally
   * constrained to server-reported active IDs. Resolves after each conversation's
   * worker metadata has settled to idle.
   * @param {string[]} [conversationIds]
   * @returns {Promise<void>}
   */
  async cancelAllActiveConversations(conversationIds) {
    const wanted = Array.isArray(conversationIds) ? new Set(conversationIds) : null;
    const active = [];
    for (const [id, conv] of this.conversations) {
      if (wanted && !wanted.has(id)) continue;
      if (this._isConvBusy(conv) || conv.isProcessing) {
        active.push(conv);
      }
    }
    await Promise.all(active.map((conv) => conv.cancelAndSettle('plugin catalog')));
  }

  /**
   * Float a conversation toward the top of the tab list.
   *
   * Two callers, and only two: a local user send (`forceTop: true`, from the
   * send action site — explicit user input outranks the busy-tab barrier), and
   * the attention manager when a conversation reaches one of its two edges, a
   * turn coming to rest or an approval parking. Nothing else may call this. In
   * particular a turn's own writes must not: they arrive several times a second
   * and would drag the list around for as long as the turn ran.
   *
   * By default the tab stops just beneath the leading run of busy tabs, so a
   * finished conversation refreshes recency without jiggling the active band at
   * the top.
   *
   * Honours manual drag order otherwise — this only moves the one conversation.
   * Persists via the reorder endpoint (no-op when already in place, which also
   * dedupes the convergent writes other viewers make for the same transition).
   *
   * The `tabReorder` attention pref switches the whole thing off, which is why
   * the gate sits here rather than at either call site: it's the one choke point
   * both bumps pass through. The pref is per-window, so it stops THIS window
   * initiating bumps — a window with it on still persists its own, and this one
   * follows the resulting reordered event like any other remote order change.
   * @param {string} conversationId
   * @param {{forceTop?: boolean}} [options]
   */
  bumpConversation(conversationId, options = {}) {
    if (!isTabReorderEnabled()) return;
    if (!this.registry.has(conversationId)) return;
    const order = this.registry.ids();

    let target = 0;
    if (!options.forceTop) {
      // Target = length of the leading contiguous run of *other* busy tabs.
      for (const id of order) {
        if (id === conversationId) continue;
        if (this._isConvBusy(this.registry.get(id) ?? undefined)) {
          target += 1;
        } else {
          break;
        }
      }
    }

    // A bump only ever floats a conversation UP. If it already sits at or
    // above its barrier-computed ceiling — e.g. a user send force-topped it
    // and its turn then came to rest while a tab below it is still busy —
    // moving it down to the ceiling would demote it,
    // and a recency signal can never mean "less recent".
    const current = order.indexOf(conversationId);
    if (current <= target) return; // at or above its ceiling — no churn, no POST

    // While it still has a neighbour to hand its boxes' place to: a bump is a
    // move like any other as far as a box anchored to it is concerned, and
    // nothing about a turn coming to rest is a reason to move a workspace.
    this._reanchorBoxesBeforeMove(conversationId);

    const without = order.filter(id => id !== conversationId);
    without.splice(target, 0, conversationId);
    this.registry.arrange(without);

    this._notify('conversation:reordered', { conversationId });

    // Persist the new ordering. The server merges this (possibly partial)
    // order into the manifest, so a viewer that knows only some conversations
    // never drops the others (see SessionManager.ReorderConversations).
    this._persistOrder('bump reorder', conversationId);
  }

  /**
   * Get services object (used by test infrastructure)
   * @returns {ConversationServices|null} Services object or null if not set
   */
  getServices() {
    return this._services;
  }

  /**
   * Subscribe to status changes for EVERY conversation in this session — the
   * feed the tab indicators and the attention alerts paint from. The callback
   * receives the conversation id that changed; query that conversation's
   * `llmState` for the new state.
   *
   * The service is session-wide, so this works from an empty session and stays
   * correct as conversations come and go: a subscriber needs no re-wire when
   * the first conversation arrives.
   *
   * This feed reads the `processingState` metadata key alone, so a change
   * to the doc — a tool action going pending, say — produces no tick here. It
   * is not interchangeable with `conversation:changed` (`subscribe`), which the
   * items observer emits synchronously inside the writing Yjs transaction:
   * drive doc-state logic from that one, and keep those handlers read-only and
   * unbatched, since rAF or microtask coalescing discards the synchrony that
   * makes them deterministic.
   *
   * Callers must subscribe after
   * {@link setServices} — which connection-manager calls before anything can
   * see the session — or they get an inert unsubscribe.
   * @param {(conversationId: string) => void} fn - Called with the changed id.
   * @returns {() => void} Unsubscribe function.
   */
  onLLMStatusChange(fn) {
    const llmState = /** @type {any} */ (this._services)?.llmState;
    if (typeof llmState?.addStatusObserver !== 'function') return () => {};
    return llmState.addStatusObserver(fn);
  }

  /**
   * Generate a unique conversation ID matching the backend's conv_<9-char base36> shape.
   * @private
   * @returns {string} Unique conversation ID
   */
  _generateConversationId() {
    const charset = '0123456789abcdefghijklmnopqrstuvwxyz';
    const length = 9;
    let result = '';
    const cryptoObj = globalThis.crypto;
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
      const bytes = new Uint8Array(length);
      cryptoObj.getRandomValues(bytes);
      for (const byte of bytes) {
        result += charset.charAt(byte % charset.length);
      }
    } else {
      for (let i = 0; i < length; i++) {
        result += charset.charAt(Math.floor(Math.random() * charset.length));
      }
    }
    return `conv_${result}`;
  }

  /**
   * The conversation on screen, or null when something else is.
   *
   * Read from the selection rather than stored, so it cannot disagree with it:
   * while a workspace panel is showing there is no visible conversation, even
   * though {@link loadedConversationId} still names the one behind it.
   * @returns {string|null} The id, or null.
   */
  get visibleConversationId() {
    return this.registry.visibleConversationId;
  }

  /**
   * The workspace whose panel is on screen, or null when a conversation is.
   * @returns {string|null} The id, or null.
   */
  get visibleWorkspaceId() {
    return this.registry.visibleWorkspaceId;
  }

  /**
   * Get the visible conversation
   * @returns {import('./conversation.js').default|null} Currently visible conversation or null
   */
  getVisibleConversation() {
    if (!this.visibleConversationId) {
      return null;
    }
    return this.registry.get(this.visibleConversationId);
  }

  /**
   * Get a conversation by ID
   * @param {string} conversationId - Conversation ID
   * @returns {import('./conversation.js').default|null} Conversation instance or null if not found
   */
  getConversation(conversationId) {
    return this.registry.get(conversationId);
  }

  /**
   * Notify all listeners of a change.
   *
   * Each listener is contained, as on the socket's emitter: its throw goes to
   * the fault sink and the fan-out carries on, because subscribers are
   * independent and a release viewer has no console to read the throw in.
   * @param {string} type - Event type
   * @param {any} data - Event data
   * @private
   */
  _notify(type, data) {
    this._listeners.forEach((callback) => {
      try {
        callback({ type, data, session: this });
      } catch (error) {
        reportFault(`session-listener:${type}`, error);
      }
    });
  }

  /**
   * Notify listeners about a conversation state change. The public door for
   * Conversation instances to announce on the session feed, which is the only
   * place it goes: a component that wants it calls {@link subscribe}.
   * @param {string} type - Event type (e.g., 'conversation:strategy-changed')
   * @param {any} data - Event data
   */
  notifyConversationChange(type, data) {
    this._notify(type, data);
  }

  /**
   * Read a session metadata key.
   * @param {string} key
   * @returns {any} Metadata value, or undefined when absent
   */
  getMetadata(key) {
    return this.metadata ? this.metadata[key] : undefined;
  }

  /**
   * Apply a metadata patch locally and notify listeners. Values set to null or
   * undefined delete the key.
   * @param {Record<string, any>} patch
   * @param {{remote?: boolean}} [options]
   */
  applySessionMetadataPatch(patch, options = {}) {
    if (!patch || typeof patch !== 'object') return;
    if (!this.metadata) this.metadata = {};
    const keys = [];
    for (const [key, value] of Object.entries(patch)) {
      keys.push(key);
      if (value === null || value === undefined) delete this.metadata[key];
      else this.metadata[key] = value;
    }
    this._notify('session:metadata-changed', {
      keys,
      metadata: patch,
      remote: !!options.remote
    });
    if (keys.includes('sessionPermissionRules') || keys.includes('sessionAllowedPaths')) {
      for (const conversation of this.conversations.values()) {
        const itemTypes = [];
        if (keys.includes('sessionPermissionRules')) itemTypes.push('execute', 'write-file');
        if (keys.includes('sessionAllowedPaths')) itemTypes.push('execute');
        try { approvePermittedPendingApprovals(conversation, { allowViewer: true, itemTypes }); }
        catch (err) { console.error('[Session] permission re-check failed:', err); }
      }
    }
  }

  /**
   * Patch session metadata and broadcast through the backend. The local model is
   * updated optimistically so UI and permission checks react immediately.
   * @param {Record<string, any>} patch
   * @returns {Promise<void>}
   */
  async patchMetadata(patch) {
    this.applySessionMetadataPatch(patch, { remote: false });
    if (typeof this._apiService.patchSessionMetadata === 'function') {
      await this._apiService.patchSessionMetadata(patch);
    } else {
      await this.saveImmediately();
    }
  }


  /**
   * Ask for a conversation to be hydrated, by whichever route this session has.
   *
   * The load queue is built by {@link Session#_doLoad} from the server's
   * conversationOrder, so a session that opened with no conversations has none.
   * It can still acquire unhydrated stubs afterwards — a restore, or another
   * viewer's create — and those show a spinner until something asks for the
   * load. Routing every ask through here means the absence of a queue costs
   * concurrency limiting, not the load itself.
   *
   * The direct call is the one the queue would have made. The loader's
   * in-flight map dedupes concurrent requests for an id, so a click while a
   * load is already in flight joins it rather than starting a second.
   * @param {string} conversationId - Conversation to hydrate
   * @param {{retry?: boolean}} [opts] - `retry` re-attempts a load that errored
   * @returns {Promise<void>} Resolves once the load settles
   * @private
   */
  async _requestConversationLoad(conversationId, { retry = false } = {}) {
    const conv = this.conversations.get(conversationId);
    if (!conv || conv.loadState === 'loaded') return;

    if (this._loadQueue) {
      if (retry) this._loadQueue.retry(conversationId);
      else this._loadQueue.prioritize(conversationId);
      return;
    }

    if (conv.loadState === 'loading') return;
    conv.setLoadState('loading');
    try {
      await workerManager.loader.loadExisting(conversationId, this);
      this.conversations.get(conversationId)?.setLoadState('loaded');
    } catch (error) {
      // The server's order still lists it, so the next reload retries it; the
      // tab stays, showing the error and a Retry.
      console.error(`[Session] Load failed for ${conversationId}:`, error);
      this.conversations.get(conversationId)?.setLoadState('error');
    }
  }

  /**
   * Re-attempt a conversation load that previously errored. Wired to the
   * conversation panel's "Retry" button.
   * @param {string} conversationId
   */
  retryConversationLoad(conversationId) {
    this._requestConversationLoad(conversationId, { retry: true });
  }

  /**
   * Resolves once the given conversation finishes hydrating. Triggers a load
   * if it's currently 'unloaded'. Used by tests that reload a session and
   * need to read items off a specific conv.
   * @param {string} conversationId
   * @returns {Promise<void>}
   */
  async ensureConversationLoaded(conversationId) {
    const conv = this.conversations.get(conversationId);
    if (!conv) return;
    if (conv.loadState === 'loaded') return;
    const requested = this._requestConversationLoad(conversationId, { retry: conv.loadState === 'error' });
    if (!this._loadQueue) {
      await requested;
      return;
    }
    try {
      await this._loadQueue.whenLoaded(conversationId);
    } catch (error) {
      console.error(`[Session] Conversation ${conversationId} failed to load:`, error);
    }
  }

  /**
   * Load session from backend
   * Uses promise-based synchronization to prevent race conditions
   * @async
   * @returns {Promise<void>}
   */
  async load() {
    // If already loading, wait for the in-flight load to complete
    if (this._loading && this._loadPromise) {
      console.log('[Session] Load already in progress, waiting for completion');
      return await this._loadPromise;
    }

    this._loading = true;
    this._loadPromise = this._doLoad();

    try {
      await this._loadPromise;
    } finally {
      this._loading = false;
      this._loadPromise = null;
    }
  }

  /**
   * Internal implementation of session loading
   * @async
   * @returns {Promise<void>}
   * @private
   */
  async _doLoad() {
    try {
      // Ensure the context item registry is initialized — Session needs it to
      // create context items and handle actions.
      // @ts-ignore - BaseRegistry has isInitialized() and init() methods
      if (contextItemRegistry && !contextItemRegistry.isInitialized()) {
        // @ts-ignore - BaseRegistry has init() method
        await contextItemRegistry.init();
      }

      const data = await this._apiService.getSession();

      // Populate session-level state BEFORE initialising the worker manager and
      // registering approval callbacks. Session-scoped permission rules
      // (sessionPermissionRules in metadata) and the project root (projectPath)
      // are read by isPermitted → getRulesFor → getSessionRules the moment the
      // engine can receive approval requests from workers. If these fields are
      // still at their constructor defaults ({}/undefined) when the first
      // evaluate-tool arrives, every session-scoped auto-approve rule is
      // invisible — the command is wrongly flagged for approval, and the
      // suggestion engine offers to add the very rule the user already has.
      if (data.projectPath) {
        this.projectPath = data.projectPath;
        // Seed the live project root the query_code sandbox delegates read.
        // The engine's boot-time root (env / sandbox template) is authoritative
        // until this point; keeping the global in step here means a later
        // project switch (_applyEngineProjectRoot) is the only thing that moves
        // it, and the sandbox never lags the loaded project.
        if (isEngine()) {
          /** @type {any} */ (globalThis).__jugglerProjectRoot =
            toSandboxRoot(data.projectPath);
        }
      }
      // The workspace table belongs in this block for the same reason as the
      // project root, and is the more dangerous of the two to leave late: it is
      // what a conversation's binding resolves against, and an unresolved
      // binding means the work goes to the project instead of the tree it was
      // meant for. Every edit after this arrives as a workspaces-changed
      // broadcast; this is the one that sets the table up.
      this.workspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
      this.workspaceKinds = data.workspaceKinds && typeof data.workspaceKinds === 'object'
        ? data.workspaceKinds
        : {};
      this._applyManifestState(data, { notify: false });

      // Initialize worker manager with session config (Pass session for conversation access)
      if (!this._workerManagerInitialized) {
        workerManager.init({
          projectPath: data.projectPath || '',
          // globalThis.location works in both the window (Location) and the
          // engine worker (WorkerLocation); window.* would throw off-thread and
          // abort session load, leaving the worker engine unable to execute tools.
          apiBaseUrl: globalThis.location.origin
        }, this);

        // Set up callbacks for worker requests, by role. Context rendering and
        // tool definitions belong to the engine — a viewer holding those
        // callbacks answers the worker's broadcast requests as well, and the
        // turn then runs on whichever realm's replica replied first. A viewer
        // handles approvals and nothing else.
        if (isEngine()) {
          setupWorkerCallbacks(this);
        } else {
          setupViewerWorkerCallbacks(this);
        }

        this._workerManagerInitialized = true;
      }

      // Create stub Conversation instances synchronously so the tab bar
      // renders immediately. session.load() resolves the moment stubs exist
      // — no Yjs hydration is awaited here. Only the visible conv is queued
      // to load (panel shows a spinner overlay until done); other tabs stay
      // 'unloaded' until the user clicks them, at which point
      // switchConversation -> loadQueue.prioritize kicks off their hydration.
      if (data.conversationOrder && data.conversationOrder.length > 0) {
        if (this._loadQueue) {
          this._loadQueue.destroy();
          this._loadQueue = null;
        }

        this.registry.clear('_doLoad');

        // Conversation names live on the on-disk folder name (parsed by the
        // backend on every GET /api/session) — no client-side title cache.
        const names = /** @type {Record<string, string>} */ (
          (data && /** @type {any} */(data).conversationNames) || {}
        );
        this.registry.adoptNames(names);
        this.bin.adopt(/** @type {any} */ (data));

        const services = this.getServices();
        if (!services) {
          throw new Error('Cannot load session: services not set (call setServices first)');
        }

        // The engine has no UI and stays fully dormant — it skips stub creation
        // so the loader's autoLoad can pull in convs on demand
        // when a yjs-sync arrives from a worker the user has activated. Creating
        // unloaded stubs here would route yjs-sync to a doc whose outbound sync
        // was never activated, silently swallowing the engine's tool-state
        // writes and hanging tool execution.
        if (!isEngine()) {
          for (const convId of data.conversationOrder) {
            const stub = new Conversation(
              convId,
              names[convId] || UNTITLED_BASE,
              this,
              services,
              { skipBuiltInContextItems: true, loadState: 'unloaded' }
            );
            this.registry.insert(convId, stub, '_doLoad-stub');
          }

          if (data.activeConversationId && this.registry.has(data.activeConversationId)) {
            recordTape('session-mut', data.activeConversationId, { op: 'visible', from: '_doLoad-active' });
            this.registry.select({ kind: 'conversation', id: data.activeConversationId });
          } else {
            const firstId = this.registry.ids()[0];
            recordTape('session-mut', firstId ?? null, { op: 'visible', from: '_doLoad-first' });
            this.registry.select(firstId ? { kind: 'conversation', id: firstId } : null);
          }

          this._loadQueue = new ConversationLoadQueue({
            session: this,
            loader: workerManager.loader,
            concurrency: 3
          });

          if (this.loadedConversationId) {
            this._loadQueue.prioritize(this.loadedConversationId);
          }

          // Background-load the remaining conversations at low priority so
          // tab-level state (running/awaiting-approval indicators) is visible
          // for every conversation on reload, not just the active one. The visible
          // conversation was prioritised above so it still loads first;
          // others trickle in at the queue's concurrency limit.
          const backgroundIds = data.conversationOrder.filter(
            (id) => id !== this.loadedConversationId
          );
          if (backgroundIds.length) {
            this._loadQueue.enqueueAll(backgroundIds);
          }
        }
      } else if (data.projectPath) {
        // Real project with no conversations yet — seed the initial "Main"
        // conversation so the user lands on a usable tab.
        await this._createInitialConversation();
      }
      // No-project mode (empty projectPath): seed nothing. The
      // <no-project-overlay> shows the project picker, and the initial
      // conversation is created once the user opens a real project — the
      // server's project-changed broadcast triggers a full page reload, which
      // re-runs this path with a populated projectPath. Seeding here would
      // build a phantom tab in an ephemeral temp dir whose writes the backend
      // silently discards; worse, createConversation awaits a worker Yjs sync,
      // so a flaky/absent worker connection would hang the whole load and
      // strand the UI with no picker and nowhere to type.

      // Refresh all context items to get fresh content (data from storage is stale)
      this._refreshAllContextItems();

      this._notify('session:loaded', this);

      // Auto-detect AI assistant files on first load (only once per session).
      // Runs after session:loaded so listeners have updated the visible conversation.
      //
      // Skipped for a conversation still waiting to be told where it works:
      // seeding it here would put the project's assistant files into a
      // conversation that has not chosen a tree yet, and its own initialisation
      // seeds the right ones anyway.
      if (!this.metadata.hasScannedAIFiles) {
        const conversation = this.getVisibleConversation();
        if (conversation && !conversation.awaitingSetup) {
          this.seedConversationAutoItems(conversation)
            .then(() => {
              this.metadata.hasScannedAIFiles = true;
            });
        } else {
          this.metadata.hasScannedAIFiles = true;
        }
      }

    } catch (error) {
      // Log error with message and stack for debugging
      console.error('[Session] Failed to load:', extractErrorMessage(error));
      if (error instanceof Error && error.stack) {
        console.error('[Session] Stack trace:', error.stack);
      }
      throw error;
    }
  }

  /**
   * Create the initial conversation for an empty session. Delegates to
   * createConversation() so naming ("Untitled N"), default-model seeding, on-disk
   * rename and order persistence all go through the single code path —
   * no parallel bootstrap that drifts out of sync.
   * @private
   * @async
   */
  async _createInitialConversation() {
    const id = await this.createConversation('', { activate: true, origin: 'initial-bootstrap' });
    recordTape('session-mut', id, { op: 'visible', from: '_createInitialConversation' });
    this.registry.select({ kind: 'conversation', id });
  }

  /**
   * Refresh all context items to get fresh content
   *
   * Called after session load to ensure context items have current data,
   * not stale data from when the session was last saved.
   * @private
   */
  _refreshAllContextItems() {
    const allItems = Array.from(this.conversations.values()).flatMap(conv => conv.rootMessageThread.contextItems);

    for (const item of allItems) {
      if (typeof /** @type {any} */ (item).onSessionReload === 'function') {
        /** @type {any} */ (item).onSessionReload();
      }
    }
  }

  /**
   * Save session to backend immediately (no debounce)
   * Use this for critical operations like switching conversations
   * @async
   * @returns {Promise<void>}
   */
  async saveImmediately() {

    // Clear any pending debounced save
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }

    // The engine has no UI and doesn't carry the full session manifest in
    // memory (it skips stub creation in _doLoad and only auto-loads convs
    // it actually receives yjs-syncs for). A save from here would propose
    // conversationOrder=[just the auto-loaded conv] and clobber the disk's
    // full order. Session-level state is the viewer's responsibility.
    if (isEngine()) {
      return;
    }

    try {
      // Only session-level state travels here. Each conversation's content is
      // saved by its own worker; names live on the on-disk folder name; and
      // conversation order is owned by POST /api/conversations and POST
      // /api/session/conversations/reorder.
      await this._apiService.updateSession(
        this.loadedConversationId ?? null,
        this.messageHistory,
        this.metadata
      );

      this._notify('session:saved', this);
      this._notifyOtherViews();

    } catch (error) {
      console.error('[Session] Failed to save:', error);
      this._notify('session:save-error', error);
    }
  }

  /**
   * Save session to backend (full save - session-level state only)
   *
   * Use this for session-level changes: new conversation, delete conversation,
   * metadata changes, conversation order, etc.
   *
   * Note: Conversation content is saved by workers via workerManager notifications.
   *
   * Debounced to avoid excessive API calls.
   * @async
   * @returns {Promise<void>}
   */
  async save() {
    // Clear existing timer
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
    }

    // Debounce: wait before saving to avoid excessive API calls
    this._saveTimer = setTimeout(async () => {
      await this.saveImmediately();
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Add a message to the session-level message history.
   * Used for input navigation (arrow up/down). Accepts a {@link HistoryMessage}
   * or a bare string (wrapped as text with no attachments), normalizing either
   * to the stored shape.
   *
   * Deduplicates on `content` (the message identity): an existing entry with the
   * same text is removed and the new one re-added at the most-recent position,
   * so a resend floats to the top AND carries its latest attachments.
   * @param {HistoryMessage|string} message - User message to add to history.
   */
  addMessageToHistory(message) {
    const entry = normalizeHistoryEntry(message);

    // Remove any existing entry with the same text (dedup on content identity).
    const existingIndex = this.messageHistory.findIndex((e) => e.content === entry.content);
    if (existingIndex !== -1) {
      this.messageHistory.splice(existingIndex, 1);
    }

    // Add to end (most recent position)
    this.messageHistory.push(entry);

    // Limit history size to last 100 messages (FIFO)
    if (this.messageHistory.length > MAX_MESSAGE_HISTORY) {
      this.messageHistory.shift(); // Remove oldest
    }

    // Save to backend
    this.save();
  }

  /**
   * Create a new conversation
   * @param {string} name - Conversation name
   * @param {object} [options] - Options
   * @param {boolean} [options.activate] - Switch to the new conversation immediately
   * @param {string} [options.origin] - Gesture label logged server-side for create
   *   attribution (plus-button, slash-command, initial-bootstrap, duplicate, …)
   * @param {boolean} [options.focus] - Ask the server to broadcast a "focus" op
   *   after "created" asking viewers to switch to the new conversation. For a
   *   headless creator (the engine's new_conversation tool) that cannot move
   *   viewer focus locally; distinct from `activate`, which switches THIS client.
   * @param {string} [options.focusFrom] - Conversation the focus request comes
   *   from. Each viewer follows only when it is watching that conversation with
   *   an empty composer (see {@link shouldFollowRequest}).
   * @param {string} [options.workspaceId] - The workspace the new conversation
   *   works in. A conversation born from another is born bound to the same one:
   *   the work it was spawned to do is about the files in that tree.
   * @returns {Promise<string>} New conversation ID
   */
  async createConversation(name, {
    activate = false,
    origin = 'unspecified',
    focus = false,
    focusFrom = '',
    workspaceId = ''
  } = {}) {
    // A create with no caller-supplied name is a blank "Untitled N" the user will
    // want to name (the + button and the /new command both create this way).
    // When it's also the tab we activate, that's the signal to open inline
    // rename — decided here, once, so every unnamed-create path gets the
    // "name it now" UX without each caller wiring it up. Named creates
    // (copy/move/promote-to-tab) already have a meaningful name and are skipped.
    const wantsRename = activate && !(name && String(name).trim());
    const requestedName = name || this._nextUntitledName();

    // Preallocate the id locally so we can mark this create as ours before the
    // POST. The server's `conversations-changed` echo can outrun the HTTP
    // response; with the id known up front, the sync reducer skips the
    // remote-load path for our own in-flight create.
    const requestedId = this._generateConversationId();
    this.sync.beginLocalCreate(requestedId);

    let response;
    let conversation;
    try {
      // Atomic server-side create: server creates the folder with the
      // collision-resolved canonical name, appends to order, broadcasts
      // session-changed, and returns the canonical name. By the time this
      // resolves, the name question is permanently answered — no "Untitled"
      // stage, no follow-up rename.
      // Where it goes travels with the create. The server keeps the order and
      // broadcasts it, and refreshFromServer re-slots the map into what it
      // sent — so a placement the server was not told about is undone by its
      // own echo a moment later, and lost entirely by the next launch.
      const { where: place, after } = placementForNewConversation(this, workspaceId);
      response = await this._apiService.createConversation(requestedName, requestedId, { origin, focus, focusFrom, place, after });
      const { id, name: canonicalName } = response;

      // WorkerManager returns conversation ONLY when fully ready (worker spawned, Yjs active).
      // The worker spawned for this id will find the existing folder via
      // ensureConvDir on its first save, preserving canonicalName on disk.
      conversation = await workerManager.loader.createNew(id, canonicalName, this, { workspaceId });

      // Settle the order the adoption already put it in: at the top of the bar,
      // or at the top of its workspace's box.
      this._placeNewConversation(conversation.id, conversation, workspaceId, 'createConversation-place');
    } finally {
      this.sync.endLocalCreate(requestedId, response?.id);
    }

    this._notify('conversation:created', conversation);

    if (activate) {
      this.switchConversation(conversation.id);
    }

    // Seeded here, at creation, where the conversation is nobody's yet and there
    // is nothing of the user's to write over.
    await seedCreationDefaults(this, conversation);

    // Bound and seeded now, against the tree it was created for: the project
    // folder, or the workspace whose box it was started in. A conversation is
    // never asked this afterwards, so there is no window in which it is open
    // with no answer and nothing for a later hop to fill in — it shows what its
    // first turn would carry from the moment it exists.
    await this.initialiseConversation(conversation, { workspaceId });

    // Ask the UI to open inline rename on the freshly-activated tab. Fired
    // last, once the tab is created, active, and settled, so the editor positions
    // correctly. Bar-less contexts (the engine worker, the startup initial-
    // conversation created before the bar subscribes) simply have no listener.
    if (wantsRename) {
      this.notifyConversationChange('conversation:rename-requested', { conversationId: conversation.id });
    }

    return conversation.id;
  }


  /**
   * Initialise a conversation: bind it to its workspace, run every seed that
   * depends on where it works, and record that it has been done.
   *
   * The binding is what this step is for. The seeds it runs are root-relative —
   * the assistant files are the bound tree's, a different branch's in a worktree
   * — so they are built for a tree before this, and rebuilt whenever the tree on
   * offer changes; what arrives here is the answer becoming final.
   *
   * Which is why the pass is skipped when the conversation has already been
   * seeded for the tree it is binding to. This runs at the first content of a
   * conversation the user may have spent a long time setting up, looking at the
   * very items it would add, and running it again over its own output would
   * resurrect the ones they deleted.
   *
   * Idempotent, and safe for racing triggers: an initialised conversation
   * returns at once, and concurrent callers all await the one in-flight pass.
   * @param {import('./conversation.js').default} conversation - The conversation to initialise.
   * @param {{workspaceId?: string}} [patch] - The choices being committed.
   * @returns {Promise<void>}
   */
  async initialiseConversation(conversation, patch = {}) {
    if (!conversation || conversation.initialised) return;
    const inFlight = this._initialising.get(conversation.id);
    if (inFlight) return inFlight;

    const pass = (async () => {
      if (patch.workspaceId) conversation.workspaceId = patch.workspaceId;

      // Asked BEFORE the seeds, because the seeds put undo groups on the stack
      // themselves and would otherwise be the answer.
      const usersOwnHistory = conversation.canUndo?.() === true;

      // Auto-add the bound tree's AI assistant files + seed always-present
      // items (e.g. memory) — unless that has already been done for this very
      // tree, in which case the document is already the answer.
      const boundTo = conversation.workspaceId || '';
      if (conversation.seededFor !== boundTo) {
        await this.seedConversationAutoItems(conversation, null, { workspaceId: boundTo });
        conversation.seededFor = boundTo;
      }

      // Clear the undo stacks so what we just seeded is not undoable — but only
      // when the stack is ours to clear. A conversation written before the flag
      // existed initialises at its next content, by which time its user may have
      // spent months working in it, and wiping their undo history to hide our
      // own items costs far more than leaving those items undoable.
      // Must await — if clearUndoStacks races with user operations it wipes
      // their undo groups.
      if (!usersOwnHistory) await workerManager.clearUndoStacks(conversation.id);

      // Last, so a conversation is only ever "initialised" once everything that
      // word promises is actually in the document.
      conversation.initialised = true;
    })();

    this._initialising.set(conversation.id, pass);
    try {
      await pass;
    } finally {
      this._initialising.delete(conversation.id);
    }
  }

  /**
   * Seed a thread's always-present auto items (the assistant files of the tree
   * it works in, and every `autoInstantiate` context-item type). The policy is
   * `seedConversationAutoItems` in `conversation-seeder.js`; this is the door
   * that initialisation, rebinding, `/clear` and the Add Context Item menu go
   * through, so each reaches the same seeds.
   * @param {import('./conversation.js').default} conversation - Conversation to seed
   * @param {import('./message-thread.js').default|null} [messageThread] - Target thread; null = root
   * @param {{workspaceId?: string}} [options] - Which tree to probe; defaults to the conversation's own binding
   * @returns {Promise<{assistantFiles: number, autoItems: number}>} How many of each half were added
   */
  seedConversationAutoItems(conversation, messageThread = null, options = {}) {
    return seedAutoItems(this, conversation, messageThread, options);
  }

  /**
   * Pick the default "Untitled N" name for a fresh, unnamed conversation: the
   * smallest positive N whose "Untitled N" isn't already in use by an open
   * conversation. Numbering from the existing names (not `conversations.size`)
   * keeps the guess collision-free after any tab is closed or archived — a
   * count-based `size + 1` re-suggests a still-live number the moment the tab
   * count drifts below the highest Untitled number (e.g. closing "Untitled 3" of 1..6
   * would make `size + 1` land on the still-open "Untitled 6"), forcing the server
   * to hand back "Untitled 6 (copy)". The server's uniqueName still resolves any
   * genuine cross-lane race, but for the common single-viewer case this returns
   * a name it accepts verbatim.
   * @returns {string} An unused "Untitled N" name
   * @private
   */
  _nextUntitledName() {
    const used = new Set();
    this.conversations.forEach((conv) => {
      const m = UNTITLED_NAME_RE.exec(conv.name || '');
      if (m) used.add(Number(m[1]));
    });
    let n = 1;
    while (used.has(n)) n++;
    return untitledName(n);
  }

  /**
   * Generate a unique "<base> (<word>)" name for a derived conversation (a clone
   * via /duplicate, a continuation via /handoff, …), collision-checked against
   * the names this session currently holds. Suffix stacking, the name-length
   * cap, and the counter series all live in uniqueSuffixedName.
   * @param {string} sourceName - Original conversation name
   * @param {string} [word] - Suffix word (default 'copy')
   * @returns {string} Unique suffixed name
   * @private
   */
  _generateUniqueSuffixedName(sourceName, word = 'copy') {
    const existingNames = new Set();
    this.conversations.forEach((conv) => {
      existingNames.add(conv.name);
    });
    return uniqueSuffixedName(sourceName, word, (name) => existingNames.has(name));
  }

  /**
   * Duplicate a conversation and add it to the session, inserted right after the source
   * @param {string} conversationId - ID of conversation to duplicate
   * @param {object} [options] - Options
   * @param {string} [options.nameSuffix] - Suffix word for the derived name
   *   (default 'copy'; /handoff passes 'continued' → "X (continued)")
   * @param {boolean} [options.refuseWhileActive] - When true, decline (with a
   *   notice) if the source has a turn in flight instead of forking it live.
   *   Default false: plain duplicate/branch fork a running conversation, and the
   *   clone loads stopped. /handoff opts in because its follow-up is an LLM turn
   *   that a half-forked, still-running source can't cleanly seed.
   * @returns {Promise<string|null>} New conversation ID, or null if source not found
   */
  async duplicateConversation(conversationId, { nameSuffix = 'copy', refuseWhileActive = false } = {}) {
    const source = this.getConversation(conversationId);
    if (!source) {
      return null;
    }

    // Forking a running conversation is safe: the server snapshots the live doc
    // in-memory (race-free, no flush through the busy run loop) and marks the
    // copy so it loads stopped rather than auto-resuming the in-flight turn. Some
    // callers (/handoff) still opt out via refuseWhileActive and wait for a
    // settled source instead.
    if (refuseWhileActive && source.isTurnActive()) {
      source.showWarning(DUPLICATE_WHILE_ACTIVE_NOTICE, 5000);
      return null;
    }

    const requestedName = this._generateUniqueSuffixedName(source.name, nameSuffix);

    // Bracketed like createConversation's, and for as long: until the clone is
    // in the map where this flow puts it. An echo that lands after the POST
    // returns but before the load has adopted the clone would otherwise load it
    // a second time at the head of the bar and announce it twice.
    const requestedId = this._generateConversationId();
    this.sync.beginLocalCreate(requestedId);
    let response;
    /** @type {import('./conversation.js').default|null} */
    let loadedClone = null;
    try {
      // 1. Server creates the clone atomically: it copies the source's
      //    persisted files (doc.yjs + txns) into the new folder and only THEN
      //    appends it to conversation order + returns/broadcasts. Because the
      //    copy precedes the announcement, no client (or the clone's own
      //    worker) ever observes an empty clone. The server flushes the
      //    source's worker first, so an open conversation is copied current.
      //    (A worker→worker copy would race the clone's worker writing an
      //    empty doc over the copy, blanking large-conversation clones.)
      response = await this._apiService.createConversation(requestedName, requestedId, {
        duplicateFrom: conversationId,
        origin: 'duplicate'
      });
      const { id: newId, name: canonicalName } = response;

      // 2. Load the now-populated clone from disk.
      const loaded = await workerManager.loader.loadExisting(newId, this);
      loadedClone = loaded;
      this.setConversationName(newId, canonicalName);

      // 3. Insert clone right after source.
      /** @type {string[]} */
      const withClone = [];
      for (const id of this.registry.ids()) {
        if (id === loaded.id) continue;
        withClone.push(id);
        if (id === conversationId) withClone.push(loaded.id);
      }
      this.registry.arrange(withClone, new Map([[loaded.id, loaded]]), 'duplicateConversation');
    } finally {
      this.sync.endLocalCreate(requestedId, response?.id);
    }
    // Set whenever the bracket completed without throwing.
    const clone = /** @type {import('./conversation.js').default} */ (loadedClone);

    // 4. Persist the new ordering via POST /reorder.
    this._persistOrder('duplicate reorder');

    // Clear undo history so user starts fresh (copied items are not undoable)
    // This prevents undoing built-in context items and copied messages
    await workerManager.clearUndoStacks(clone.id);

    this._notify('conversation:created', clone);
    this.save();
    return clone.id;
  }

  /**
   * Persist the current conversation ordering via the reorder endpoint (the sole
   * writer of order). The server merges this (possibly partial) order into the
   * manifest. Failures are logged, not surfaced.
   * @param {string} label - Short context for the error log (e.g. 'bump reorder')
   * @param {string} [moved] - The one conversation this reorder moved, where it
   *   moved one. The server re-anchors any box placed behind it, so that a box
   *   keeps the place it is drawn in — the same rule applied here for the redraw,
   *   applied there for every other viewer and for the next load.
   * @private
   */
  _persistOrder(label, moved = '') {
    this._apiService.reorderConversations(this.registry.ids(), moved)
      .catch((/** @type {any} */ err) => console.error(`[Session] ${label} persist failed:`, err));
  }

  /**
   * Hand a box's place on before the conversation it sits behind moves away.
   *
   * A box is placed by a neighbour rather than a number, and the neighbour is an
   * ordinary tab with nothing drawn on it to say a box is anchored there. So
   * dragging that one tab would otherwise move two things: the tab, because that
   * is what was asked for, and the box, because the place it is drawn at is read
   * off the tab that just left. One drag, one thing moved — the box keeps where
   * it is drawn, and the anchor it keeps that place by is bookkeeping the user
   * never sees.
   *
   * The place is handed to the conversation ahead of the one leaving, which is
   * what the box is still sitting behind once it has gone, and to 'head' when
   * there is nothing ahead of it. This is {@link reanchorBoxesAt}'s rule on the
   * server, which the delete path has always applied; a move is the same
   * departure as a delete as far as a box anchored to it is concerned.
   *
   * Rewritten locally so the strip redraws at once. The server applies the same
   * rule to the order it is sent and broadcasts the table, so nothing is patched
   * from here and there is nothing to race with a box's own move.
   * @param {string} conversationId - The conversation about to move.
   * @returns {void}
   * @private
   */
  _reanchorBoxesBeforeMove(conversationId) {
    if (!this.workspaces?.some?.(row => row.place === conversationId)) return;

    const order = this.registry.ids();
    const at = order.indexOf(conversationId);
    const inherits = at > 0 ? order[at - 1] : 'head';

    this.workspaces = this.workspaces.map(row =>
      (row.place === conversationId ? { ...row, place: inherits } : row));
    this._notify('session:workspaces-changed', this.workspaces);
  }

  /**
   * Take the tab bar's word for the whole arrangement: the conversation order
   * and where every box sits, written in one go.
   *
   * The strip drawn under a drag is the arrangement the user picked, and this is
   * that arrangement being recorded: every conversation's place, and every drawn
   * box's, in one call. Deriving it a second time from the one thing the drop
   * landed in front of moves the box the drop touched and leaves every other one
   * to a fallback that reads the conversation list — so a box nobody dragged
   * follows a tab that moved, and the strip settles somewhere the preview never
   * showed. One arrangement, written once, cannot disagree with itself.
   *
   * A place is a neighbour rather than an index, so the writes below commute:
   * the order goes to the reorder endpoint and each box's place to its own row,
   * in whichever order they arrive.
   * @param {{order: string[], places: Map<string, string>, moved?: string}} arrangement - The strip as drawn: every conversation top to bottom, and each drawn box against the conversation it now sits behind, or 'head'.
   * @returns {boolean} Whether any of it was news.
   */
  applyStripArrangement({ order, places, moved = '' }) {
    const current = this.registry.ids();
    const known = new Set(current);
    const next = order.filter(id => known.has(id));

    // A conversation created while the drag was held is not in the strip the
    // drop is describing — the bar holds its renders for the length of a
    // gesture. It keeps the neighbour it has rather than being swept to the end.
    const listed = new Set(next);
    let previous = '';
    for (const id of current) {
      if (!listed.has(id)) next.splice(previous ? next.indexOf(previous) + 1 : 0, 0, id);
      previous = id;
    }

    const orderChanged = current.length !== next.length || current.some((id, i) => next[i] !== id);
    if (orderChanged) {
      this.registry.arrange(next);
      this._notify('conversation:reordered', { conversationId: moved, beforeId: null });
      // Sent without naming what moved: the server re-anchors boxes around the
      // conversation a reorder moved, which is the very rule being replaced
      // here. Every drawn box's place is in this arrangement explicitly, so
      // there is nothing left to infer and nothing to infer it differently.
      this._persistOrder('arrangement');
    }

    // Boxes take the strip's order too. Two boxes with no conversation between
    // them sit in the same place and are drawn in table order — the only thing
    // left to tell them apart (see `workspaceGroups`) — so the table is kept in
    // the order the strip has them, on the server as well as here. Here alone
    // settles nothing: every workspace edit anywhere broadcasts the table, and
    // the broadcast replaces this copy whole, so an order held only in this
    // window is taken away by the next one.
    const rows = this.workspaces ?? [];
    const byId = new Map(rows.map(row => [row.id, row]));
    /** @type {any[]} */
    const reordered = [];
    /** @type {string[]} */
    const repositioned = [];
    for (const [workspaceId, place] of places) {
      const row = byId.get(workspaceId);
      if (!row) continue;
      if (row.place === place) {
        reordered.push(row);
        continue;
      }
      repositioned.push(workspaceId);
      reordered.push({ ...row, place });
    }
    // A workspace with no box drawn — closed, or being built — is not in the
    // strip to have an opinion about, and keeps both its place and its row.
    for (const row of rows) if (!places.has(row.id)) reordered.push(row);

    const resequenced = rows.some((row, i) => row.id !== reordered[i]?.id);
    const tableChanged = rows.length !== reordered.length
      || rows.some((row, i) => row !== reordered[i]);
    if (tableChanged) {
      this.workspaces = reordered;
      this._notify('session:workspaces-changed', this.workspaces);
    }

    for (const workspaceId of repositioned) {
      patchWorkspace(workspaceId, { place: places.get(workspaceId) }).catch((error) => {
        console.error("[Session] Couldn't store where the workspace box was moved to:", error);
      });
    }
    if (resequenced) {
      reorderWorkspaces(reordered.map(row => row.id)).catch((error) => {
        console.error("[Session] Couldn't store the order the workspace boxes were left in:", error);
      });
    }

    return orderChanged || tableChanged;
  }

  /**
   * Reorder a conversation by moving it before another conversation
   * @param {string} conversationId - ID of conversation to move
   * @param {string} beforeId - ID of conversation to insert before
   * @returns {boolean} Whether reorder succeeded
   */
  reorderConversation(conversationId, beforeId) {
    if (conversationId === beforeId) {
      return false;
    }

    if (!this.registry.has(conversationId) || !this.registry.has(beforeId)) {
      return false;
    }

    // While it still has a neighbour to hand its boxes' place to.
    this._reanchorBoxesBeforeMove(conversationId);

    // Move the conversation to sit immediately before `beforeId`.
    const order = this.registry.ids().filter(id => id !== conversationId);
    order.splice(order.indexOf(beforeId), 0, conversationId);
    this.registry.arrange(order);
    this._notify('conversation:reordered', { conversationId, beforeId });

    // POST /reorder is the sole writer of conversation order.
    this._persistOrder('reorder', conversationId);

    return true;
  }

  /**
   * Put the conversations that turned up mid-refresh back into the order.
   *
   * Two paths can insert while `refreshFromServer` is awaiting its loads — a
   * create and a restore — and the order it was rebuilding knows nothing about
   * either. Each arrival goes where it would have gone had it arrived at any
   * other moment: {@link placeForNewConversation}'s answer, which is the head of
   * the bar for a conversation of the project's and its own box for one bound to
   * a workspace. A refresh is a coincidence of timing, and must not be the thing
   * that decides where a tab lives.
   *
   * Arrivals are folded in last-first so that several claiming one place end up
   * in the order they arrived.
   * @param {Map<string, any>} settled - The order the server sent, as rebuilt.
   * @param {[string, any][]} arrivals - What turned up while that was being built.
   * @returns {Map<string, any>} The two together.
   * @private
   */
  _foldArrivals(settled, arrivals) {
    if (arrivals.length === 0) return settled;

    const order = [...settled];
    for (const entry of [...arrivals].reverse()) {
      const view = { conversations: new Map(order), workspaces: this.workspaces };
      order.splice(placeForNewConversation(view, entry[1]?.workspaceId || ''), 0, entry);
    }
    return new Map(order);
  }

  /**
   * Bin a conversation. Mirrors deleteConversation locally (cancels
   * loads, destroys worker, drops from the in-memory map, picks a new
   * visible tab) but the backend moves the folder to .juggler/bin/
   * instead of trashing it, so the user can restore it from the Bin
   * modal at any time (the bin never auto-expires).
   * @param {string} conversationId
   * @returns {Promise<boolean>} Whether binning succeeded
   */
  async binConversation(conversationId) {
    // Tear down worker + map entry and pick a fallback tab up-front. Binning the
    // last conversation leaves the session empty (clearVisibleIfNoFallback) —
    // the user starts a new one with "+".
    // Marked before the map entry goes, so no window exists in which the
    // conversation is absent from both the map and the tombstones and a refresh
    // could read it back off the manifest.
    this._removedPendingConfirm.add(conversationId);

    const conv = await this._dropActiveConversation(conversationId, { clearVisibleIfNoFallback: true });
    if (!conv) {
      this._removedPendingConfirm.delete(conversationId);
      return false;
    }

    // The worker is already destroyed, so the folder is released before the
    // backend moves it to .juggler/bin/. Local removal is unconditional, so a
    // failed bin request still leaves the tab gone (logged, not surfaced).
    //
    // The tombstone is retired the moment the request settles, and not before:
    // the server answers only once the move and the manifest write have both
    // run, so any read issued after this line already reflects the bin. It is
    // retired on failure too — the request is no longer in flight, and the
    // manifest has become the better authority on a conversation this client
    // believes it binned and the server may never have.
    try {
      await this._apiService.binConversation(conversationId);
      this.bin.noteBinned();
    } catch (error) {
      console.error(`[Session] Failed to bin conversation ${conversationId}:`, error);
    } finally {
      this._removedPendingConfirm.delete(conversationId);
    }

    // Other viewers learn of this from the server's `conversations-changed`
    // op="binned" broadcast, which the bin endpoint sends once the folder has
    // actually moved. Announcing it a second time over `session-changed` would
    // make every viewer — this one included, since the broadcast goes to the
    // sender too — re-read the whole manifest, and a manifest read is answered
    // ahead of a queued bin write. The reply can still list this conversation,
    // and a refresh treats an id it doesn't hold as one to load.
    this._notify('conversation:deleted', conv);
    return true;
  }

  /**
   * Delete a conversation
   * @param {string} conversationId - Conversation ID to delete
   * @param {string} [reason] - Attribution tag the server logs with the
   *   delete (e.g. which test or cleanup issued it); omitted for UI deletes
   * @returns {Promise<boolean>} Whether deletion succeeded
   */
  async deleteConversation(conversationId, reason) {
    // Prevent deleting the last conversation
    if (this.conversations.size <= 1) {
      return false;
    }

    // Tombstoned for the width of the request, as binConversation explains.
    this._removedPendingConfirm.add(conversationId);

    // Cancel the load, destroy the worker, drop from the active map, and switch
    // to the MRU fallback tab. The size>1 guard above means a fallback always
    // exists, so clearVisibleIfNoFallback is irrelevant here (kept false).
    const conv = await this._dropActiveConversation(conversationId, { clearVisibleIfNoFallback: false });
    if (!conv) {
      this._removedPendingConfirm.delete(conversationId);
      return false;
    }

    // Call backend DELETE endpoint to remove the file. The worker is already
    // destroyed, and local removal already happened, so a failed request still
    // leaves the tab gone (logged, not surfaced).
    try {
      await this._apiService.deleteConversation(conversationId, { reason });
    } catch (error) {
      console.error(`[Session] Failed to delete conversation ${conversationId}:`, error);
    } finally {
      this._removedPendingConfirm.delete(conversationId);
    }

    // Carried to other viewers by the server's `conversations-changed`
    // op="deleted" broadcast, for the reasons given in binConversation.
    this._notify('conversation:deleted', conv);
    // Don't call save() - backend DELETE already updated the session
    return true;
  }

  /**
   * Request an on-demand tab-title derivation for a conversation.
   * Fire-and-forget: the worker re-derives a title from the conversation's first
   * user message and the server renames + broadcasts the change, which arrives
   * via the normal conversations-changed path. A no-op before the conversation
   * has a first user message.
   * @param {string} conversationId - Conversation to auto-name.
   * @param {object} [opts]
   * @param {boolean} [opts.force] - True (default) for a user-requested
   *   "auto-name now". False for a background request (/handoff), which the
   *   server applies only while the name is machine-derived and auto-naming is
   *   enabled.
   * @returns {void}
   */
  requestAutoName(conversationId, { force = true } = {}) {
    if (!this.conversations.has(conversationId)) return;
    workerManager.requestAutoName(conversationId, { force });
  }

  /**
   * Record whether a conversation's name is still provisional — the single write
   * seam for the `isProvisionalName` doc-metadata marker the server's auto-namer
   * reads. Set it true when a name is generated on the user's behalf (the
   * "Auto-name" button, /handoff's "(continued)" tab) to keep the conversation
   * eligible for a derived title; clear it when the user types a name of their
   * own. The value rides in the doc, so it persists, syncs to every view, and is
   * inherited by a duplicate through the server-side doc copy.
   * @param {string} conversationId - Conversation to mark.
   * @param {boolean} isProvisional - True while the name may still be replaced.
   * @returns {void}
   */
  setNameIsProvisional(conversationId, isProvisional) {
    this.conversations.get(conversationId)?.setMetadata(PROVISIONAL_NAME_KEY, !!isProvisional);
  }

  /**
   * Rename a conversation. Renames the on-disk folder via PATCH; on
   * success updates conv.name and the local manifest cache and emits
   * 'conversation:changed' so the tab bar re-renders. Throws an Error
   * tagged with `.code` ("INVALID" | "COLLISION" | "NOT_FOUND") on
   * non-OK responses so the UI can surface the right message.
   * @param {string} conversationId
   * @param {string} newName
   * @returns {Promise<string>} canonical (post-sanitization) name
   */
  async renameConversation(conversationId, newName) {
    const conv = this.conversations.get(conversationId);
    if (!conv) {
      const err = new Error(`Conversation not found: ${conversationId}`);
      /** @type {any} */ (err).code = 'NOT_FOUND';
      throw err;
    }
    if (!newName || newName.trim() === '') {
      const err = new Error('Conversation name is empty');
      /** @type {any} */ (err).code = 'INVALID';
      throw err;
    }
    // Data-level enforcement of the shared name-length cap. The rename input
    // caps typed input via `maxlength`, but paste and programmatic callers can
    // still overshoot — reject those here rather than letting the server
    // silently truncate the folder name to its filesystem-safety limit.
    if (newName.trim().length > MAX_CONVERSATION_NAME_LENGTH) {
      const err = new Error(
        `Conversation name exceeds ${MAX_CONVERSATION_NAME_LENGTH} characters`
      );
      /** @type {any} */ (err).code = 'INVALID';
      throw err;
    }

    let result;
    try {
      result = await this._apiService.renameConversation(conversationId, newName.trim());
    } catch (e) {
      // The code comes from the response status (HttpError.status), never from
      // the message: the server's 500 quotes the OS error, which names both
      // folders and so the new name, and a name may well contain "409".
      const msg = String(/** @type {any} */ (e)?.message || e);
      const tagged = new Error(msg, { cause: e });
      const code = RENAME_ERROR_CODES.get(/** @type {any} */ (e)?.status);
      if (code) /** @type {any} */ (tagged).code = code;
      throw tagged;
    }

    const canonical = (result && /** @type {any} */ (result).name) || newName.trim();
    // The name is now the user's, so the auto-namer must never replace it. This
    // is the only client entry point for a rename, so it is the only place a
    // hand-typed name enters the system. See PROVISIONAL_NAME_KEY.
    this.setNameIsProvisional(conversationId, false);
    // Update the registry's name cache, the single in-memory copy of the
    // on-disk folder name, so `conv.name` (a getter) reflects the rename
    // immediately.
    this.setConversationName(conversationId, canonical);
    this.notifyConversationChange('conversation:renamed', { conversationId });
    return canonical;
  }

  /**
   * Re-sync session state from the server.
   * Called when another view notifies us of a session change.
   * @returns {Promise<void>}
   */
  async refreshFromServer() {
    // Taken before the GET, because the GET is already part of the window: only
    // ids held when the refresh began can be judged against the manifest it
    // returns. Anything that arrives after this line is newer than what was
    // read, and this rebuild has no opinion about it.
    const knownAtEntry = new Set(this.registry.ids());

    // The map alone would have this rebuild undo removals still in flight: an id
    // this client has binned is absent from the map and present in a manifest
    // read before the bin landed, which is indistinguishable from a conversation
    // another viewer has just created. Tombstones tell the two apart.
    //
    // Both ends of the window are checked, because a removal can be confirmed at
    // any point during a refresh. This snapshot catches one tombstoned before
    // the GET went out and retired before its reply came back; the live set,
    // read at the point of use below, catches one tombstoned while the GET was
    // in flight. Neither check subsumes the other.
    const tombstonedAtEntry = new Set(this._removedPendingConfirm);

    const data = await this._apiService.getSession();
    if (!data.conversationOrder) return;

    const serverOrder = data.conversationOrder;
    /** @type {Map<string, import('./conversation.js').default>} */
    const reordered = new Map();

    // Folder names on disk are the source of truth, but a conversation this
    // refresh is about to remove keeps its last known name until it is gone
    // (ConversationRegistry#mergeNames).
    const names = /** @type {Record<string, string>} */ (
      (data && /** @type {any} */(data).conversationNames) || {}
    );
    this.registry.mergeNames(names);
    this.bin.adopt(/** @type {any} */ (data));
    this._applyManifestState(data, { notify: true });

    // The manifest, not the rebuild's own success, says what still exists:
    // judging by `reordered` would destroy a conversation the server still
    // lists whose load merely failed.
    const serverIds = new Set(serverOrder);

    // Preserve existing conversations in the server's order
    /** @type {import('./conversation.js').default[]} */
    const newlyLoaded = [];
    for (const id of serverOrder) {
      const existing = this.registry.get(id);
      if (existing) {
        reordered.set(id, existing);
        // A stub nothing is hydrating stays on the spinner until the user
        // clicks it. The manifest just said the conversation is real, so ask.
        if (existing.loadState === 'unloaded') this._requestConversationLoad(id);
        continue;
      }
      // Listed by the server, gone from the map, and removed on purpose: this
      // client binned or deleted it and the request has not settled. The
      // manifest predates the removal rather than outranking it, so leave it
      // out — the rebuild below then drops it from the order too.
      if (tombstonedAtEntry.has(id) || this._removedPendingConfirm.has(id)) continue;

      // New conversation from another view (or restored locally) — load
      // it and announce via 'conversation:created' below so conversation-bar
      // creates the <conversation-tab> host element.
      try {
        const conv = await workerManager.loader.loadExisting(id, this);
        reordered.set(id, conv);
        newlyLoaded.push(conv);
      } catch (error) {
        console.error(`[Session] Failed to load new conversation ${id}:`, error);
      }
    }

    // Destroy conversations that were deleted in the other view
    for (const [id, conv] of this.registry.conversations) {
      if (serverIds.has(id) || !knownAtEntry.has(id)) continue;
      await workerManager.loader.destroy(conv);
    }

    // Fold in whatever arrived while the loads above were awaiting.
    const arrivals = Array.from(this.registry.conversations)
      .filter(([id]) => !reordered.has(id) && !knownAtEntry.has(id));

    // Through the registry like every other change to the list, so what the
    // manifest took away is taped and leaves the most-recently-used list.
    this.registry.replace(this._foldArrivals(reordered, arrivals), 'refreshFromServer');

    // Announce each newly-loaded conv so subscribers (notably the
    // conversation-bar) build the inner <conversation-tab> host element.
    for (const conv of newlyLoaded) {
      this._notify('conversation:created', conv);
    }

    // If visible conversation was deleted, switch to first.
    // Use switchConversation() so the load queue is prioritized.
    if (this.loadedConversationId && !this.registry.has(this.loadedConversationId)) {
      const firstId = this.registry.ids()[0];
      if (firstId !== undefined) {
        this.switchConversation(firstId);
      }
    }

    this._notify('conversation:reordered', {});
  }

  /**
   * Notify other views that session-level state has changed, so they re-read it.
   *
   * For session-level metadata only — messageHistory, metadata flags, the
   * visible conversation — which is exactly what PUT /session writes, and its
   * only caller is the save that issues that PUT. A conversation-list mutation
   * must NOT travel this way: it is announced by the server's own
   * `conversations-changed` broadcast, which names the conversation and the op,
   * and which every client applies idempotently.
   *
   * The distinction is not cosmetic. This lands as `session-changed`, whose
   * only handling is a full {@link Session#refreshFromServer} — a manifest read
   * that the server may answer ahead of a write still queued behind it. Used to
   * announce a removal, it invites a reply that still lists the conversation,
   * and the refresh loads back what the removal just took out.
   * @private
   */
  _notifyOtherViews() {
    this._services?.wsService?.sendSessionChanged?.();
  }

  /**
   * Switch to a different conversation
   * @param {string} conversationId - Conversation ID to switch to
   * @returns {boolean} Whether switch succeeded
   */
  switchConversation(conversationId) {
    const conv = this.getConversation(conversationId);
    if (!conv) {
      return false;
    }

    // The strip has one selection, so naming a conversation is the whole of
    // putting it on screen: whatever held it before stops holding it by the
    // same write, with nothing to remember to clear.
    const leavingWorkspace = this.selection?.kind === 'workspace';
    const alreadyVisible = this.visibleConversationId === conversationId;

    recordTape('session-mut', conversationId, { op: 'visible', from: 'switchConversation' });
    this.registry.select({ kind: 'conversation', id: conversationId });
    if (leavingWorkspace) {
      this._notify('workspace:selected', null);
    }

    if (alreadyVisible) {
      return true; // Already visible
    }

    // Coming back from a workspace panel is not an already-visible switch even
    // when it lands on the conversation that was behind it: the panel was what
    // was on screen, so the tab has to be shown and announced like any other.

    this.registry.touch(conversationId);

    // Bump the user's selection to the front of the load queue so a
    // still-loading or errored conv hydrates before background work.
    if (conv.loadState === 'unloaded') {
      this._requestConversationLoad(conversationId);
    } else if (conv.loadState === 'error') {
      this._requestConversationLoad(conversationId, { retry: true });
    }

    // Fetch context window if conversation has a model but no context window
    // Don't await - let it fetch in background and notify when ready
    if (conv.modelConfig && !conv.contextWindow) {
      conv.ensureContextWindow().then(() => {
        // Notify again after context window is fetched so token display updates
        this._notify('conversation:context-window-updated', conv);
      });
    }

    this._notify('conversation:switched', conv);

    // Save to persist activeConversationId
    // This is necessary because page unload saves are unreliable (async operations may not complete)
    this.save();
    return true;
  }

  /**
   * Show a workspace instead of a conversation.
   *
   * A box in the tab strip is selected the way a tab is, and what it selects is
   * the workspace itself: the place, rather than anyone working in it. So the
   * panel it shows is about the tree, and the conversation that was on screen
   * stays the one to come back to.
   * @param {string} workspaceId - Which workspace to show.
   * @returns {boolean} Whether it is now showing.
   */
  selectWorkspace(workspaceId) {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) {
      return false;
    }
    if (this.visibleWorkspaceId === workspaceId) {
      return true; // Already showing
    }

    this.registry.select({ kind: 'workspace', id: workspaceId });
    this._notify('workspace:selected', workspace);
    return true;
  }


  /**
   * Get session state as plain object
   * @returns {{projectPath: string, conversations: object[], activeConversationId: string | null, messageHistory: HistoryMessage[]}} Session state
   */
  toJSON() {
    return {
      projectPath: this.projectPath,
      conversations: Array.from(this.conversations.values()).map(conv => conv.toJSON()),
      activeConversationId: this.loadedConversationId,
      messageHistory: this.messageHistory
    };
  }

  /**
   * Clean up resources when session is destroyed
   */
  destroy() {
    // Idempotent: destroy() terminates every worker through the shared
    // workerManager singleton, so a second call would reach past this session
    // and tear down whatever has since taken its place.
    if (this._destroyed) return;
    this._destroyed = true;

    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }

    // Stop background hydration before anything else. The queue holds this
    // session and re-pumps itself from the finally{} of every load, so one
    // left running outlives destroy(): each load it goes on to complete spawns
    // a worker and puts a fresh Conversation — its own Yjs doc, its own update
    // observer — back into the map destroy() has already walked and cleared,
    // where nothing will ever destroy it.
    if (this._loadQueue) {
      this._loadQueue.destroy();
      this._loadQueue = null;
    }

    // Remove WebSocket listeners registered in setServices (all four, not just
    // file-change — the others would otherwise leak and fire against a
    // destroyed session).
    if (this._services?.wsService) {
      const ws = this._services.wsService;
      if (this._fileChangeHandler) {
        ws.off('file-change', /** @type {import('../services/websocket.js').WSEventCallback} */ (this._fileChangeHandler));
        this._fileChangeHandler = undefined;
      }
      if (this._projectChangedHandler) {
        ws.off('project-changed', /** @type {import('../services/websocket.js').WSEventCallback} */ (this._projectChangedHandler));
        this._projectChangedHandler = undefined;
      }
      if (this._providersUpdateHandler) {
        ws.off('providers-update', this._providersUpdateHandler);
        this._providersUpdateHandler = undefined;
      }
      if (this._workspacesChangedHandler) {
        ws.off('workspaces-changed', this._workspacesChangedHandler);
        this._workspacesChangedHandler = undefined;
      }
    }

    // Terminate all workers
    workerManager.terminateAll();

    this.registry.conversations.forEach(conv => {
      if (conv.destroy) {
        conv.destroy();
      }
    });
    this.registry.clear('destroy');

    this._listeners.clear();

    // @ts-ignore - Intentional cleanup in destroy method
    this._apiService = null;
    this._services = null;
  }
}

// Export class
export default Session;
