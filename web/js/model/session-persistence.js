//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * How a session reaches the server: reading the manifest (`GET /api/session`)
 * in, and writing session-level state back out.
 *
 * - **The load** ({@link SessionPersistence#load}) runs once at a time. It
 *   adopts the manifest's session-level state, initialises the worker manager
 *   for this realm's role, and builds a stub conversation for every tab with a
 *   load queue to hydrate them — the engine excepted, which builds none.
 * - **The refresh** ({@link SessionPersistence#refreshFromServer}) re-reads the
 *   manifest when another view says session state changed, and rebuilds the
 *   conversation list from it without undoing removals still on the wire.
 * - **The save** ({@link SessionPersistence#save}) is debounced, and carries
 *   only session-level state: the visible conversation, the prompt history and
 *   the metadata. Each conversation's content is saved by its own worker.
 *
 * Where a new arrival goes in the bar is not decided here: the refresh asks
 * the session ({@link SessionPersistenceHost#foldArrivals}), which owns
 * placement because it reads the workspace table.
 *
 * The persistence reaches the session only through {@link SessionPersistenceHost},
 * which the session builds. Every entry is read at call time, so a test that
 * replaces the session's registry, API service or load queue is replacing it
 * here too.
 * @module model/session-persistence
 */

import contextItemRegistry from '../registries/context-item-registry.js';
import { UNTITLED_BASE } from './conversation-naming.js';
import { SAVE_DEBOUNCE_MS } from '../utils/constants.js';
import workerManager from '../services/worker-manager.js';
import ConversationLoadQueue from '../services/conversation-load-queue.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { isEngine } from '../../sdk/lib/client-role.js';
import { toSandboxRoot } from '../../sdk/lib/sandbox-runner.js';
import { recordTape } from '../utils/event-tape.js';
import { setupWorkerCallbacks } from './session-worker-callbacks.js';
import { normalizeAttachments } from '../utils/attachments.js';

/** @typedef {import('./session.js').default} Session */
/** @typedef {import('./conversation.js').default} Conversation */
/** @typedef {import('./session.js').SessionData} SessionData */
/** @typedef {import('./session.js').HistoryMessage} HistoryMessage */

/**
 * The session-level fields the manifest sets, as the session holds them.
 * @typedef {object} PersistedState
 * @property {string} projectPath - The project root ('' until the manifest sets it)
 * @property {import('./session.js').Workspace[]} workspaces - The registered workspaces
 * @property {boolean|undefined} projectHostsLocalProviders - Whether the project can host a provider Juggler spawns
 * @property {string} platform - darwin/linux/windows
 * @property {string} home - The backend user's home directory
 * @property {HistoryMessage[]} messageHistory - The prompt history
 * @property {Record<string, unknown>} metadata - The frontend flags
 */

/**
 * The conversation folder names a session manifest carries, by id; a name that
 * is not a string is left out.
 * @param {unknown} data - The manifest
 * @returns {Record<string, string>} The names
 */
function conversationNamesOf(data) {
  const raw = data && typeof data === 'object' && 'conversationNames' in data ? data.conversationNames : undefined;
  /** @type {Record<string, string>} */
  const names = {};
  if (!raw || typeof raw !== 'object') return names;
  for (const [id, name] of Object.entries(raw)) {
    if (typeof name === 'string') names[id] = name;
  }
  return names;
}

/**
 * What the persistence may ask of the session.
 * @typedef {object} SessionPersistenceHost
 * @property {() => Session} session - The session itself, handed whole to the collaborators that take one: the worker manager, its loader, the load queue and each stub Conversation
 * @property {() => PersistedState} state - The session's manifest-backed fields, read and written in place
 * @property {() => import('./session.js').ApiService} api - The session's API service
 * @property {() => import('./conversation-registry.js').default} registry - The session's open conversations
 * @property {() => import('./conversation-bin.js').default} bin - The project's bin
 * @property {() => import('./session.js').ConversationServices|null} services - What each Conversation is built with (`Session.getServices`)
 * @property {() => ReadonlySet<string>} removedPendingConfirm - Ids this client removed whose removal the server has not acknowledged
 * @property {() => ConversationLoadQueue|null} loadQueue - The queue hydrating stubs, if the load built one
 * @property {(queue: ConversationLoadQueue|null) => void} setLoadQueue - Record the load's queue on the session
 * @property {<K extends import('./session-events.js').SessionEventType>(type: K, data: import('./session-events.js').SessionEventPayloads[K]) => void} notify - Announce on the session's event feed
 * @property {(id: string) => Promise<void>} requestLoad - Ask for a stub to be hydrated (`Session._requestConversationLoad`)
 * @property {(id: string) => boolean} switchTo - Put a conversation on screen (`Session.switchConversation`)
 * @property {(settled: Map<string, Conversation>, arrivals: [string, Conversation][]) => Map<string, Conversation>} foldArrivals - Place what arrived mid-refresh (`Session._foldArrivals`)
 * @property {() => Promise<void>} createInitialConversation - Seed the first conversation of an empty project
 * @property {() => Conversation|null} visibleConversation - The conversation on screen (`Session.getVisibleConversation`)
 * @property {(conversation: Conversation) => Promise<unknown>} seedAutoItems - Seed a conversation's assistant files and auto items (`Session.seedConversationAutoItems`)
 * @property {(patch: Record<string, unknown>) => void} patchMetadata - Apply a metadata patch locally and announce it (`Session.applySessionMetadataPatch`); the next save carries it
 */

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

export default class SessionPersistence {
  /**
   * @param {SessionPersistenceHost} host - The session's side of the persistence
   */
  constructor(host) {
    /** @private */
    this._host = host;

    /**
     * Debounce timer for auto-save
     * @type {ReturnType<typeof setTimeout>|null}
     * @private
     */
    this._saveTimer = null;

    /**
     * The load in flight, which a second caller joins rather than repeats.
     * @type {Promise<void>|null}
     * @private
     */
    this._loadPromise = null;

    /**
     * Whether the worker manager has been initialised. It is a page-wide
     * singleton, so only the first load does it.
     * @type {boolean}
     * @private
     */
    this._workerManagerInitialized = false;
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
   */
  adoptManifest(data, { notify }) {
    const state = this._host.state();
    if (data.platform) state.platform = data.platform;
    if (data.home) state.home = data.home;
    state.messageHistory = Array.isArray(data.messageHistory)
      ? data.messageHistory.map(normalizeHistoryEntry)
      : [];
    const metadata = data.metadata || {};
    state.metadata = metadata;
    if (notify) {
      this._host.notify('session:metadata-changed', {
        keys: Object.keys(metadata),
        metadata,
        remote: true
      });
    }
  }

  /**
   * Load the session from the backend. A call while a load is in flight joins
   * it rather than starting a second.
   * @returns {Promise<void>}
   */
  async load() {
    if (this._loadPromise) {
      console.log('[Session] Load already in progress, waiting for completion');
      return await this._loadPromise;
    }

    this._loadPromise = this._doLoad();
    try {
      await this._loadPromise;
    } finally {
      this._loadPromise = null;
    }
  }

  /**
   * The load itself; call it through {@link SessionPersistence#load}, which
   * keeps it to one at a time.
   * @returns {Promise<void>}
   * @private
   */
  async _doLoad() {
    const host = this._host;
    try {
      // Ensure the context item registry is initialized — Session needs it to
      // create context items and handle actions.
      // @ts-ignore - BaseRegistry has isInitialized() and init() methods
      if (contextItemRegistry && !contextItemRegistry.isInitialized()) {
        // @ts-ignore - BaseRegistry has init() method
        await contextItemRegistry.init();
      }

      const data = await host.api().getSession();
      const state = host.state();

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
        state.projectPath = data.projectPath;
        // Seed the live project root the query_code sandbox delegates read.
        // The engine's boot-time root (env / sandbox template) is authoritative
        // until this point; keeping the global in step here means the sandbox
        // never lags the loaded project.
        if (isEngine()) {
          Object.assign(globalThis, { __jugglerProjectRoot: toSandboxRoot(data.projectPath) });
        }
      }
      // The workspace table belongs in this block for the same reason as the
      // project root, and is the more dangerous of the two to leave late: it is
      // what a conversation's binding resolves against, and an unresolved
      // binding means the work goes to the project instead of the tree it was
      // meant for. Every edit after this arrives as a workspaces-changed
      // broadcast; this is the one that sets the table up.
      state.workspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
      state.projectHostsLocalProviders = typeof data.projectHostsLocalProviders === 'boolean'
        ? data.projectHostsLocalProviders
        : undefined;
      this.adoptManifest(data, { notify: false });

      // Initialize worker manager with session config (Pass session for conversation access)
      if (!this._workerManagerInitialized) {
        workerManager.init({
          projectPath: data.projectPath || '',
        }, host.session());

        // Set up callbacks for worker requests, engine only. Context rendering
        // and tool definitions belong to the engine — a viewer holding those
        // callbacks answers the worker's broadcast requests as well, and the
        // turn then runs on whichever realm's replica replied first.
        if (isEngine()) {
          setupWorkerCallbacks(host.session());
        }

        this._workerManagerInitialized = true;
      }

      // Create stub Conversation instances synchronously so the tab bar
      // renders immediately. The load resolves the moment stubs exist — no
      // Yjs hydration is awaited here. Only the visible conv is queued to load
      // (panel shows a spinner overlay until done); other tabs stay 'unloaded'
      // until the user clicks them, at which point switchConversation ->
      // loadQueue.prioritize kicks off their hydration.
      if (data.conversationOrder && data.conversationOrder.length > 0) {
        host.loadQueue()?.destroy();
        host.setLoadQueue(null);

        const registry = host.registry();
        registry.clear('_doLoad');

        // Conversation names live on the on-disk folder name (parsed by the
        // backend on every GET /api/session) — no client-side title cache.
        const names = conversationNamesOf(data);
        registry.adoptNames(names);
        host.bin().adopt(data);

        const services = host.services();
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
            const stub = host.session().buildConversation(
              convId,
              names[convId] || UNTITLED_BASE,
              services,
              { skipBuiltInContextItems: true, loadState: 'unloaded' }
            );
            registry.insert(convId, stub, '_doLoad-stub');
          }

          if (data.activeConversationId && registry.has(data.activeConversationId)) {
            recordTape('session-mut', data.activeConversationId, { op: 'visible', from: '_doLoad-active' });
            registry.select({ kind: 'conversation', id: data.activeConversationId });
          } else {
            const firstId = registry.ids()[0];
            recordTape('session-mut', firstId ?? null, { op: 'visible', from: '_doLoad-first' });
            registry.select(firstId ? { kind: 'conversation', id: firstId } : null);
          }

          const queue = new ConversationLoadQueue({
            session: host.session(),
            loader: workerManager.loader,
            concurrency: 3
          });
          host.setLoadQueue(queue);

          const loadedId = registry.loadedConversationId;
          if (loadedId) {
            queue.prioritize(loadedId);
          }

          // Background-load the remaining conversations at low priority so
          // tab-level state (running/awaiting-approval indicators) is visible
          // for every conversation on reload, not just the active one. The visible
          // conversation was prioritised above so it still loads first;
          // others trickle in at the queue's concurrency limit.
          const backgroundIds = data.conversationOrder.filter((id) => id !== loadedId);
          if (backgroundIds.length) {
            queue.enqueueAll(backgroundIds);
          }
        }
      } else if (data.projectPath) {
        // Real project with no conversations yet — seed the initial "Main"
        // conversation so the user lands on a usable tab.
        await host.createInitialConversation();
      }
      // An empty projectPath seeds nothing: a tab there would live in an
      // ephemeral temp dir whose writes the backend silently discards, and
      // createConversation awaits a worker Yjs sync, so a flaky or absent
      // worker connection would hang the whole load.

      // Refresh all context items to get fresh content (data from storage is stale)
      this._refreshAllContextItems();

      host.notify('session:loaded', host.session());

      // Runs after session:loaded so listeners have updated the visible conversation.
      void this._scanAssistantFilesOnce();

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
   * Seed the visible conversation's AI assistant files, once per session: the
   * `hasScannedAIFiles` metadata flag records that it has been done, written
   * through the patch API so its listeners hear it, and only once the seeding
   * succeeded — a failed one is logged and tried again on the next load.
   *
   * Skipped for a conversation still waiting to be told where it works:
   * seeding it here would put the project's assistant files into a
   * conversation that has not chosen a tree yet, and its own initialisation
   * seeds the right ones anyway. With nothing to seed, the scan counts as done.
   * @returns {Promise<void>} Settles once the scan is done or has failed; never rejects.
   * @private
   */
  async _scanAssistantFilesOnce() {
    const host = this._host;
    if (host.state().metadata.hasScannedAIFiles) return;
    const conversation = host.visibleConversation();
    if (conversation && !conversation.awaitingSetup) {
      try {
        await host.seedAutoItems(conversation);
      } catch (error) {
        console.warn('[Session] Seeding the assistant files failed:', extractErrorMessage(error));
        return;
      }
    }
    host.patchMetadata({ hasScannedAIFiles: true });
  }

  /**
   * Refresh all context items to get fresh content
   *
   * Called after session load to ensure context items have current data,
   * not stale data from when the session was last saved.
   * @private
   */
  _refreshAllContextItems() {
    const allItems = Array.from(this._host.registry().conversations.values())
      .flatMap(conv => conv.rootMessageThread.contextItems);

    for (const item of allItems) {
      if ('onSessionReload' in item && typeof item.onSessionReload === 'function') {
        item.onSessionReload();
      }
    }
  }

  /**
   * Save session to backend immediately (no debounce), taking any pending
   * debounced save with it. Use this for critical operations like page close.
   * @returns {Promise<void>}
   */
  async saveImmediately() {
    this.cancelPendingSave();

    // The engine has no UI and doesn't carry the full session manifest in
    // memory (it skips stub creation in _doLoad and only auto-loads convs
    // it actually receives yjs-syncs for). A save from here would propose
    // conversationOrder=[just the auto-loaded conv] and clobber the disk's
    // full order. Session-level state is the viewer's responsibility.
    if (isEngine()) {
      return;
    }

    const host = this._host;
    try {
      // Only session-level state travels here. Each conversation's content is
      // saved by its own worker; names live on the on-disk folder name; and
      // conversation order is owned by POST /api/conversations and POST
      // /api/session/conversations/reorder.
      const state = host.state();
      await host.api().updateSession(
        host.registry().loadedConversationId ?? null,
        state.messageHistory,
        state.metadata
      );

      host.notify('session:saved', host.session());
      this._notifyOtherViews();

    } catch (error) {
      console.error('[Session] Failed to save:', error);
      host.notify('session:save-error', error);
    }
  }

  /**
   * Save session-level state to the backend, debounced to avoid excessive API
   * calls: a burst of saves inside {@link SAVE_DEBOUNCE_MS} is one request.
   * @returns {void}
   */
  save() {
    this.cancelPendingSave();
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      void this.saveImmediately();
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Drop a debounced save that has not fired yet, if there is one.
   * @returns {void}
   */
  cancelPendingSave() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
  }

  /**
   * Re-sync session state from the server.
   * Called when another view notifies us of a session change.
   * @returns {Promise<void>}
   */
  async refreshFromServer() {
    const host = this._host;
    const registry = host.registry();

    // Taken before the GET, because the GET is already part of the window: only
    // ids held when the refresh began can be judged against the manifest it
    // returns. Anything that arrives after this line is newer than what was
    // read, and this rebuild has no opinion about it.
    const knownAtEntry = new Set(registry.ids());

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
    const tombstonedAtEntry = new Set(host.removedPendingConfirm());

    const data = await host.api().getSession();
    if (!data.conversationOrder) return;

    const serverOrder = data.conversationOrder;
    /** @type {Map<string, Conversation>} */
    const reordered = new Map();

    // Folder names on disk are the source of truth, but a conversation this
    // refresh is about to remove keeps its last known name until it is gone
    // (ConversationRegistry#mergeNames).
    registry.mergeNames(conversationNamesOf(data));
    host.bin().adopt(data);
    this.adoptManifest(data, { notify: true });

    // The manifest, not the rebuild's own success, says what still exists:
    // judging by `reordered` would destroy a conversation the server still
    // lists whose load merely failed.
    const serverIds = new Set(serverOrder);

    // Preserve existing conversations in the server's order
    /** @type {Conversation[]} */
    const newlyLoaded = [];
    for (const id of serverOrder) {
      const existing = registry.get(id);
      if (existing) {
        reordered.set(id, existing);
        // A stub nothing is hydrating stays on the spinner until the user
        // clicks it. The manifest just said the conversation is real, so ask.
        if (existing.loadState === 'unloaded') host.requestLoad(id);
        continue;
      }
      // Listed by the server, gone from the map, and removed on purpose: this
      // client binned or deleted it and the request has not settled. The
      // manifest predates the removal rather than outranking it, so leave it
      // out — the rebuild below then drops it from the order too.
      if (tombstonedAtEntry.has(id) || host.removedPendingConfirm().has(id)) continue;

      // New conversation from another view (or restored locally) — load
      // it and announce via 'conversation:created' below so conversation-bar
      // creates the <conversation-tab> host element.
      try {
        const conv = await workerManager.loader.loadExisting(id, host.session());
        reordered.set(id, conv);
        newlyLoaded.push(conv);
      } catch (error) {
        console.error(`[Session] Failed to load new conversation ${id}:`, error);
      }
    }

    // Destroy conversations that were deleted in the other view
    for (const [id, conv] of registry.conversations) {
      if (serverIds.has(id) || !knownAtEntry.has(id)) continue;
      await workerManager.loader.destroy(conv);
    }

    // Fold in whatever arrived while the loads above were awaiting.
    const arrivals = Array.from(registry.conversations)
      .filter(([id]) => !reordered.has(id) && !knownAtEntry.has(id));

    // Through the registry like every other change to the list, so what the
    // manifest took away is taped and leaves the most-recently-used list.
    registry.replace(host.foldArrivals(reordered, arrivals), 'refreshFromServer');

    // Announce each newly-loaded conv so subscribers (notably the
    // conversation-bar) build the inner <conversation-tab> host element.
    for (const conv of newlyLoaded) {
      host.notify('conversation:created', conv);
    }

    // If visible conversation was deleted, switch to first.
    // Use switchConversation() so the load queue is prioritized.
    const loadedId = registry.loadedConversationId;
    if (loadedId && !registry.has(loadedId)) {
      const firstId = registry.ids()[0];
      if (firstId !== undefined) {
        host.switchTo(firstId);
      }
    }

    host.notify('conversation:reordered', {});
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
   * only handling is a full {@link SessionPersistence#refreshFromServer} — a
   * manifest read that the server may answer ahead of a write still queued
   * behind it. Used to announce a removal, it invites a reply that still lists
   * the conversation, and the refresh loads back what the removal just took out.
   * @private
   */
  _notifyOtherViews() {
    this._host.services()?.wsService?.sendSessionChanged?.();
  }
}
