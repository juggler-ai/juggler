//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import Conversation from './conversation.js';
import {
  UNTITLED_BASE,
  UNTITLED_NAME_RE,
  untitledName,
  uniqueSuffixedName,
  PROVISIONAL_NAME_KEY
} from './conversation-naming.js';
import {
  MAX_MESSAGE_HISTORY,
  HANDOFF_WHILE_ACTIVE_NOTICE,
  MAX_CONVERSATION_NAME_LENGTH
} from '../utils/constants.js';
import workerManager from '../services/worker-manager.js';
import { markForTranslation, t } from '../../sdk/lib/i18n.js';
import { isEngine } from '../../sdk/lib/client-role.js';
import { recordTape } from '../utils/event-tape.js';
import { isTabReorderEnabled } from '../utils/attention-manager.js';
import { approvePermittedPendingApprovals } from './conversation-tool-actions.js';
import { isWorkspaceUsable, patchWorkspace, reorderWorkspaces } from '../services/workspaces.js';
import { placeForNewConversation, placementForNewConversation, takesTheHead } from '../services/workspace-provisioning.js';
import ConversationBin from './conversation-bin.js';
import { busyState } from './processing-status.js';
import ConversationSyncReducer from './conversation-sync-reducer.js';
import ConversationRegistry from './conversation-registry.js';
import ProjectSwitchController from './project-switch-controller.js';
import SessionPersistence, { normalizeHistoryEntry } from './session-persistence.js';
import SessionEvents from './session-events.js';
import { seedCreationDefaults, seedConversationAutoItems as seedAutoItems } from './conversation-seeder.js';

/**
 * How long a duplicate waits for the source worker's flush ack before copying
 * without it. The ack is normally one round-trip; this bounds a duplicate the
 * user is waiting on when the worker is slow to answer.
 * @type {number}
 */
const DUPLICATE_FLUSH_ACK_TIMEOUT_MS = 5000;

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
 * @property {boolean} [projectHostsLocalProviders] - Whether the project itself can host a provider Juggler spawns; the rows each carry their own
 */

/**
 * One registered workspace, as the server reports it — the row, verbatim, from
 * `cmd/juggler/core/workspace.go`, plus what its workspace can do
 * (`workspace.Row` in `cmd/juggler/workspace/resolver.go`). Kind and Root are
 * carried on the row rather than asked of whichever extension made it, so a
 * workspace stays resolvable while its provider is disabled, uninstalled, or
 * simply failing to load.
 *
 * The default workspace is NOT one of these: it has no row, its id is '', and
 * its root is {@link Session#projectPath}.
 * @typedef {object} Workspace
 * @property {string} id - Server-assigned, stable for the workspace's life
 * @property {string} kind - Stored as registered and read only by the server; 'local' is this machine
 * @property {string} root - Absolute path to the tree
 * @property {string} [label] - What the UI calls it, e.g. "feat/tunnels"
 * @property {string} [place] - Where its box sits in the tab bar: 'head', or the conversation it sits behind. Empty or absent is a row with no place recorded, drawn by its first member instead
 * @property {string} [providerId] - Extension owning its lifecycle; empty for one nobody manages
 * @property {string} [baseWorkspaceId] - The workspace it was provisioned from; empty means the default
 * @property {string} state - 'provisioning' | 'ready' | 'closed'
 * @property {Record<string, any>} [meta] - The provider's own record of what it built; opaque here
 * @property {boolean} [available] - Whether its root was there when the server last looked
 * @property {boolean} [stale] - Provisioning, but nothing is provisioning it
 * @property {boolean} [hostsLocalProviders] - Whether a provider Juggler spawns as a subprocess can run there; computed by the server on every read
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
 * @property {import('../services/worker-manager.js').default} workerManager - The worker transport each Conversation sends its commands through
 * @property {import('../services/websocket.js').default} wsService - WebSocket service; the Session subscribes its server-push listeners on it (setServices). Conversation does not read it.
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
 * User-facing message shown when a creation path is blocked by the cap, in
 * English with a `{max}` placeholder for {@link MAX_CONVERSATIONS}. Translated
 * where it is drawn (`services/app-notices.js`), keeping modal UI out of the
 * model layer.
 * @type {string}
 */
export const CONVERSATION_LIMIT_MESSAGE = markForTranslation(
  'You can have at most {max} conversations open at once. Bin some tabs to make room for new ones.');

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
     * than newer. {@link SessionPersistence#refreshFromServer} is the only reader.
     * @type {Set<string>}
     * @private
     */
    this._removedPendingConfirm = new Set();

    /**
     * The view's answer to "is the user part-way through a message in this
     * conversation?", installed by the window's tab bar
     * ({@link Session#setComposerTextProbe}). Null in a realm with no composers
     * — the engine, a detached board — where there is no draft to protect.
     * @type {((conversationId: string) => boolean)|null}
     * @private
     */
    this._composerTextProbe = null;

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
     * Whether the project itself can host a provider Juggler spawns — the
     * answer each row in {@link Session#workspaces} carries for itself, which
     * the project, having no row, is sent beside the table with the load.
     * Undefined until the load says.
     * @type {boolean|undefined}
     */
    this.projectHostsLocalProviders = undefined;

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
     * The session's event feed. The session, its extracts and every
     * Conversation announce on it; components listen through
     * {@link subscribe}.
     * @type {SessionEvents}
     */
    this.events = new SessionEvents(this);

    /**
     * Unsubscribe functions for the server-push listeners setServices put on
     * the socket, released by setServices itself and by destroy().
     * @type {Array<() => void>}
     * @private
     */
    this._socketSubscriptions = [];

    /** @type {import('../services/conversation-load-queue.js').default|null} @private */
    this._loadQueue = null;

    /**
     * Conversations the auto-namer is working on, each with the timer that
     * expires its mark (see setAutoNaming). Created on first use.
     * @type {Map<string, ReturnType<typeof setTimeout>>|undefined}
     * @private
     */
    this._autoNaming = undefined;

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
      notify: (type, data) => this.events.notify(type, data),
      notifyChange: (type, data) => this.events.notify(type, data),
      loadAtHead: (id) => this._loadIntoHead(id),
      drop: (id, opts) => this._dropActiveConversation(id, opts),
      reorder: (ids) => this.registry.arrange(ids),
      follow: (id) => { this.switchConversation(id); },
      shouldFollow: (from) => this.shouldFollowRequest(from),
      setAutoNaming: (id, active) => this.setAutoNaming(id, active),
      get bin() { return session.bin; }
    });

    /**
     * What this realm does when the server switches project at runtime: a
     * viewer reloads, the persistent engine repoints its root, releases the
     * old project's conversations and reseeds the new one's session state.
     * @type {ProjectSwitchController}
     */
    this.projectSwitch = new ProjectSwitchController({
      projectPath: () => this.projectPath,
      setProjectPath: (path) => { this.projectPath = path; },
      registry: () => this.registry,
      fetchManifest: () => this._apiService.getSession(),
      adoptManifest: (data) => this.persistence.adoptManifest(data, { notify: true })
    });

    /**
     * The load from and the save to the server: the manifest read, the
     * refresh another view asks for, and the debounced save of session-level
     * state. Each host entry is read at call time, so a test that replaces the
     * registry, the API service or the load queue replaces it here too.
     * @type {SessionPersistence}
     */
    this.persistence = new SessionPersistence({
      session: () => this,
      state: () => this,
      api: () => this._apiService,
      registry: () => this.registry,
      bin: () => this.bin,
      services: () => this.getServices(),
      removedPendingConfirm: () => this._removedPendingConfirm,
      loadQueue: () => this._loadQueue,
      setLoadQueue: (queue) => { this._loadQueue = queue; },
      notify: (type, data) => this.events.notify(type, data),
      requestLoad: (id) => this._requestConversationLoad(id),
      switchTo: (id) => this.switchConversation(id),
      foldArrivals: (settled, arrivals) => this._foldArrivals(settled, arrivals),
      createInitialConversation: () => this._createInitialConversation(),
      visibleConversation: () => this.getVisibleConversation(),
      seedAutoItems: (conversation) => this.seedConversationAutoItems(conversation),
      patchMetadata: (patch) => this.applySessionMetadataPatch(patch)
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
   * The open conversations switched to in this window, most recently used
   * first. See {@link ConversationRegistry#recentlyUsed}.
   * @returns {string[]} Their ids.
   */
  get recentlyUsedConversationIds() {
    return this.registry.recentlyUsed();
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
    return !this._composerTextProbe?.(from);
  }

  /**
   * Let the view answer whether a conversation's composer holds unsent text,
   * which {@link shouldFollowRequest} reads. The session holds no element: the
   * view that owns the composers answers by conversation id.
   * @param {(conversationId: string) => boolean} probe - True while that conversation's box holds text.
   * @returns {() => void} Detaches the probe, if it is still the one installed.
   */
  setComposerTextProbe(probe) {
    this._composerTextProbe = probe;
    return () => {
      if (this._composerTextProbe === probe) this._composerTextProbe = null;
    };
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
    conv.cancelLocalActions();
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
    this.events.notify('session:workspaces-changed', this.workspaces);

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
        const stub = this.buildConversation(
          id,
          this.registry.name(id) || UNTITLED_BASE,
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
        this.events.notify('conversation:created', stub);
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
      // entry silently strands them. Torn down like any removed conversation:
      // the stub owns a document and its observers, and a tab that showed it
      // registered it with the LLM state.
      //
      // Only a stub still 'unloaded' — one the load never reached. A load that
      // got going marks its stub 'error' before it throws (loadExisting), and
      // that one stays, as the retry affordance.
      const stub = this.registry.get(id);
      if (stubbed && stub?.loadState === 'unloaded') {
        await this._teardownConversation(stub, '_loadIntoHead-stub-failed');
        this.events.notify('conversation:deleted', stub);
      }
      return null;
    }
  }

  /**
   * Build a Conversation of this session, seeding the session's name cache
   * with `name` when it has none for the id yet — so `conversation.name` (a
   * getter over that cache) resolves for a conversation the next
   * GET /api/session has not listed. The on-disk folder name is the source of
   * truth and the cache its projection, which is why the session writes it and
   * the conversation only reads it.
   * @param {string} id - Conversation id
   * @param {string} name - Its name, if the session does not know one
   * @param {ConversationServices} services - What it is built with (getServices)
   * @param {object} [options] - The Conversation constructor's options
   * @returns {Conversation} The conversation, not yet in the registry
   */
  buildConversation(id, name, services, options = {}) {
    if (name && !this.getConversationName(id)) {
      this.setConversationName(id, name);
    }
    return new Conversation(id, this, services, options);
  }

  /**
   * Listen to the session's event feed ({@link SessionEvents#subscribe}): to
   * every event, `subscribe(cb)`, or to one type, `subscribe(type, cb)`.
   * Kept on the session on purpose: extensions subscribe through it, so it is
   * extension API rather than a pass-through to tidy away.
   * @overload
   * @param {import('./session-events.js').SessionEventListener} callback - Called with each event.
   * @returns {() => void} Stops this subscription.
   */
  /**
   * @overload
   * @param {import('./session-events.js').SessionEventType} type - The one type to hear.
   * @param {import('./session-events.js').SessionEventListener} callback - Called with each event of that type.
   * @returns {() => void} Stops this subscription.
   */
  /**
   * @param {any} typeOrCallback - A type, or the callback for everything.
   * @param {import('./session-events.js').SessionEventListener} [callback] - The callback, when a type is given.
   * @returns {() => void} Stops this subscription.
   */
  subscribe(typeOrCallback, callback) {
    return this.events.subscribe(typeOrCallback, /** @type {any} */ (callback));
  }

  /**
   * Set services object for creating Conversation instances
   * Must be called before loading session or creating conversations
   * @param {ConversationServices} services - Services object
   */
  setServices(services) {
    // Services may be set again; the new socket's subscriptions replace the
    // old ones rather than joining them.
    this._releaseSocketSubscriptions();
    this._services = services;

    const ws = services.wsService;
    if (ws) {
      this._socketSubscriptions = [
        ws.on('file-change', (changes) => this._onFileChange(changes)),
        ws.on('project-changed', (data) => this.projectSwitch.projectChanged(data)),
        ws.on('providers-update', (providers) => this._onProvidersUpdate(providers)),
        ws.on('workspaces-changed', (data) => this._onWorkspacesChanged(data))
      ];
    }
  }

  /**
   * Drop every server-push subscription setServices took.
   * @private
   */
  _releaseSocketSubscriptions() {
    const subscriptions = this._socketSubscriptions;
    this._socketSubscriptions = [];
    for (const unsubscribe of subscriptions) unsubscribe();
  }

  /**
   * `file-change`: hand each change to the visible conversation's context
   * items that watch files.
   * @param {unknown} changes - Array of {path, event}
   * @private
   */
  _onFileChange(changes) {
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
  }

  /**
   * `providers-update`. The server learns some models' true context window
   * only after the first turn — claudecode reads it from the CLI result event —
   * and then rebroadcasts the provider list. Re-resolve each loaded
   * conversation's cached context window from the fresh list so footers stop
   * showing the cold-start fallback (e.g. 200k for a 1M-window opus) once the
   * real number is known.
   * @param {unknown} providers - The provider list
   * @private
   */
  _onProvidersUpdate(providers) {
    const list = /** @type {Array<any>} */ (Array.isArray(providers) ? providers : []);
    for (const conv of this.conversations.values()) {
      if (conv.applyProvidersContextWindow(list)) {
        this.events.notify('conversation:context-window-updated', conv);
      }
    }
  }

  /**
   * `workspaces-changed`. The workspace table is session state like the
   * pinboard, not a per-device preference: the server owns it and republishes
   * the whole table after every edit, so a window that is only watching still
   * sees a workspace appear, become usable, and be finished with. Replaced
   * whole rather than merged — an empty list is an edit like any other (the
   * last workspace being unregistered), so it cannot be read as "nothing to
   * say".
   * @param {unknown} data - {workspaces}
   * @private
   */
  _onWorkspacesChanged(data) {
    const list = /** @type {{workspaces?: Workspace[]}} */ (data)?.workspaces;
    this.workspaces = Array.isArray(list) ? list : [];
    this.events.notify('session:workspaces-changed', this.workspaces);
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
      this.events.notify('session:workspaces-changed', this.workspaces);
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
   * These are the refusals the server makes in `WorkspaceLookup.Usable`, and
   * they have to agree: what the client shows and what the operation does must
   * not be two different answers. Two of the server's — a kind it cannot open,
   * and a `stat` of the root — arrive here as `available`, which the server
   * computes on every read and carries on every broadcast.
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
   * The server answers it, for the project with the load and for each
   * workspace on its row: whether the workspace has a directory on this
   * machine to spawn in. One that does not would have the CLI run in a
   * directory that is not the one every file operation of that turn uses, and
   * the user would find out through answers that made no sense.
   *
   * A missing answer — a row the table no longer holds, a load that did not
   * say — is yes. Not a fallback so much as an acknowledgement: a binding the
   * client cannot read is refused by the server for a reason it can state, and
   * disabling every CLI model over an answer we do not have would be a
   * refusal we could not explain.
   * @param {string} id - Workspace id, '' for the project.
   * @returns {boolean} True when a spawned provider would run in the right place.
   */
  workspaceHostsLocalProviders(id) {
    if (!id) return this.projectHostsLocalProviders !== false;
    return this.getWorkspace(id)?.hostsLocalProviders !== false;
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
    const busy = busyState(conv);
    return busy.running || busy.turn;
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
      if (this._isConvBusy(conv)) {
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

    this.events.notify('conversation:reordered', { conversationId });

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
    this.events.notify('session:metadata-changed', {
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
      await this.persistence.saveImmediately();
    }
  }

  /**
   * Ask for a conversation to be hydrated, by whichever route this session has.
   *
   * The load queue is built by {@link SessionPersistence#load} from the server's
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
   * Save session-level state to the backend, debounced
   * ({@link SessionPersistence#save}). The call extensions make after changing
   * session metadata; conversation content is saved by each worker.
   * @returns {Promise<void>}
   */
  async save() {
    this.persistence.save();
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
      // broadcasts it, and the persistence's refreshFromServer re-slots the map into what it
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

    this.events.notify('conversation:created', conversation);

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
      this.events.notify('conversation:rename-requested', { conversationId: conversation.id });
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
      source.showWarning(t(HANDOFF_WHILE_ACTIVE_NOTICE), 5000);
      return null;
    }

    const requestedName = this._generateUniqueSuffixedName(source.name, nameSuffix);

    // The server copies the source from its worker, and an edit made here is
    // only in the worker once its yjs-sync frame has been dispatched there. An
    // acked flush-persistence is the barrier: the worker takes inbound messages
    // in order, so every frame sent before it has been applied by the time it
    // answers — without this, a duplicate taken just after an edit (the
    // initialised flag a fresh conversation writes last) copies the document
    // from before it. Skipped mid-turn, where the server snapshots the live
    // document instead and the worker's loop may not answer promptly.
    if (!source.isTurnActive() && workerManager.isWorkerReady(conversationId)) {
      try {
        await workerManager.flushPersistence(conversationId, DUPLICATE_FLUSH_ACK_TIMEOUT_MS);
      } catch (err) {
        console.warn(`[Session] Duplicating ${conversationId} without a flush barrier:`, err);
      }
    }

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

    this.events.notify('conversation:created', clone);
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
   *
   * Never from the engine. Its registry holds only the conversations it has
   * loaded, in the order they arrived, which is not the tab order; merged, it
   * re-slots those conversations into one another's places — a send from the
   * new_conversation tool would carry any busy conversation the engine has
   * loaded down to the slot of whichever one it loaded first. The order is the
   * viewers' to write, as
   * the rest of session state is (see SessionPersistence#saveImmediately).
   * @private
   */
  _persistOrder(label, moved = '') {
    if (isEngine()) return;
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
    this.events.notify('session:workspaces-changed', this.workspaces);
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
      this.events.notify('conversation:reordered', { conversationId: moved, beforeId: null });
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
      this.events.notify('session:workspaces-changed', this.workspaces);
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
    this.events.notify('conversation:reordered', { conversationId, beforeId });

    // POST /reorder is the sole writer of conversation order.
    this._persistOrder('reorder', conversationId);

    return true;
  }

  /**
   * Put the conversations that turned up mid-refresh back into the order.
   *
   * Two paths can insert while {@link SessionPersistence#refreshFromServer} is awaiting its loads — a
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
    this.events.notify('conversation:deleted', conv);
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
    this.events.notify('conversation:deleted', conv);
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
   * Whether the auto-namer is working on a conversation's name — the tab then
   * reads "Auto-naming…" in place of it.
   * @param {string} conversationId - Conversation to ask about.
   * @returns {boolean} True between a naming's start and its end.
   */
  isAutoNaming(conversationId) {
    return this._autoNaming?.has(conversationId) ?? false;
  }

  /**
   * Mark a conversation as being auto-named, or as no longer being. Set by the
   * server's `naming-started` / `naming-ended` broadcasts, and ahead of them by
   * the Auto-name button, so the press shows at once.
   *
   * Every mark expires: the end travels on a socket that can drop, and a tab
   * that says "Auto-naming…" for good is worse than one that stops early. The
   * default outlasts the server's whole naming budget (autoNameTimeout, 90s); a
   * caller marking ahead of the server passes something shorter, which the
   * server's own `naming-started` then replaces.
   * @param {string} conversationId - Conversation to mark.
   * @param {boolean} active - True while it is being named.
   * @param {{timeoutMs?: number}} [opts]
   * @returns {void}
   */
  setAutoNaming(conversationId, active, { timeoutMs = 120_000 } = {}) {
    if (!conversationId) return;
    const marks = this._autoNaming ??= new Map();
    const was = marks.has(conversationId);
    clearTimeout(marks.get(conversationId));
    if (active) {
      marks.set(conversationId, setTimeout(() => this.setAutoNaming(conversationId, false), timeoutMs));
    } else {
      marks.delete(conversationId);
    }
    if (was !== active) {
      this.events.notify('conversation:auto-naming', { conversationId, active });
    }
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
    this.events.notify('conversation:renamed', { conversationId });
    return canonical;
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
    const leftId = this.loadedConversationId;

    recordTape('session-mut', conversationId, { op: 'visible', from: 'switchConversation' });
    this.registry.select({ kind: 'conversation', id: conversationId });
    if (leavingWorkspace) {
      this.events.notify('workspace:selected', null);
    }

    if (alreadyVisible) {
      return true; // Already visible
    }

    // Coming back from a workspace panel is not an already-visible switch even
    // when it lands on the conversation that was behind it: the panel was what
    // was on screen, so the tab has to be shown and announced like any other.

    // The conversation left is the one used before this, whether or not it was
    // ever switched to: the one a launch opens on is put on screen without a
    // switch, and Ctrl+Tab's first answer after leaving it is that one.
    if (leftId && leftId !== conversationId) this.registry.touch(leftId);
    this.registry.touch(conversationId);

    // Bump the user's selection to the front of the load queue so a
    // still-loading or errored conv hydrates before background work.
    if (conv.loadState === 'unloaded') {
      this._requestConversationLoad(conversationId);
    } else if (conv.loadState === 'error') {
      this._requestConversationLoad(conversationId, { retry: true });
    }

    // Fetch the context window if the conversation has a model but no window
    // yet, in the background. The conversation announces
    // `conversation:context-window-updated` itself when it resolves one, naming
    // itself, so a switch away in the meantime changes nothing.
    if (conv.modelConfig && !conv.contextWindow) {
      conv.ensureContextWindow().catch((/** @type {unknown} */ err) => {
        console.warn(`[Session] context window for ${conversationId} not resolved:`, err);
      });
    }

    this.events.notify('conversation:switched', conv);

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
    this.events.notify('workspace:selected', workspace);
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

    this.persistence.cancelPendingSave();

    if (this._autoNaming) {
      for (const timer of this._autoNaming.values()) clearTimeout(timer);
      this._autoNaming.clear();
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

    // Remove the socket listeners registered in setServices: left behind, they
    // fire against a destroyed session on every broadcast.
    this._releaseSocketSubscriptions();

    // Terminate all workers
    workerManager.terminateAll();

    this.registry.conversations.forEach(conv => {
      if (conv.destroy) {
        conv.destroy();
      }
    });
    this.registry.clear('destroy');

    this.events.clear();

    // @ts-ignore - Intentional cleanup in destroy method
    this._apiService = null;
    this._services = null;
  }
}

// Export class
export default Session;
