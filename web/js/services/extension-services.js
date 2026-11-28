//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The host services an extension surface is handed — a pin's `services`, an
 * info card's `mount(contentEl, session, {services})`, a workspace provider's
 * `ctx.services`. One object for all three, described in `juggler/services`.
 *
 * Every service is built against a {@link ServicesHost}: the lifetime of what
 * it was handed for, the session, where that surface is reading, and how to
 * call into it. The Pinboard supplies its own (the board's snapshot, and its
 * notifications held while the board is closed); {@link sessionServicesHost}
 * is the one everything else gets, following the visible conversation.
 *
 * What is the pin's alone is not here: its config, its view state and the
 * active-context snapshot stay on the pin's context.
 *
 * Some services end in the view — pointing the conversation at a row, opening
 * the workspace dialogs, putting text in a composer. This is a service, and the
 * view is components, so those go through {@link registerServicesView}, which
 * the Pinboard's content module calls as it loads.
 * @module services/extension-services
 */

import wsService from './websocket.js';
import { clientOp } from './api.js';
import jobsService from './jobs-service.js';
import { createTopicsService } from './topics.js';
import { visibleWorkspaceId, onVisibleWorkspaceChange } from './visible-workspace.js';
import { shellListProcesses, shellStopProcess } from './ops-api.js';
import { findNearestContextItem, focusedThreadItemId, THREAD_FOCUS_CHANGED } from './nearest-context-item.js';
import { satelliteLink } from './pinboard-link.js';
import { workspaceFinishOptions } from './workspace-provisioning.js';
import { probeSetupAdoptions, adoptSetupRow, adoptionRowFor } from './workspace-places.js';
import workspaceProviderRegistry from '../registries/workspace-provider-registry.js';
import { isPinboardView } from '../utils/view-mode.js';
import { reviewDraftBoundsError } from '../utils/review-draft.js';
import { formatReviewMessage } from '../utils/review-message.js';
import { itemField } from '../../sdk/lib/message.js';
import { errorText } from '../../sdk/lib/error-utils.js';
import { t } from '../../sdk/lib/i18n.js';
import { displayConversationName } from '../model/conversation-naming.js';
import { itemGoal } from '../model/thread-alias.js';

/** @typedef {import('juggler/services').Services} Services */
/** @typedef {import('juggler/services').Task} Task */
/** @typedef {import('./ops-api.js').ProcessInfo} ProcessInfo */

/**
 * Where a surface is reading.
 * @typedef {object} ServicesView
 * @property {string} projectPath - The project root, '' for none
 * @property {string} conversationId - The conversation, '' for none
 * @property {string|null} threadId - The thread, null for the root
 */

/**
 * Hand one piece of news to an extension's function.
 * @callback ServicesNotify
 * @param {(...args: any[]) => void} fn - The extension's function.
 * @param {any[]} args - What to hand it.
 * @param {string} what - What it is, for the log when it throws.
 * @returns {void}
 */

/**
 * What a surface supplies for its services to be built against.
 * @typedef {object} ServicesHost
 * @property {AbortSignal} signal - Ends every subscription made through them
 * @property {() => any} session - The session, or null
 * @property {() => ServicesView} view - Where the surface is reading, now
 * @property {(listener: () => void) => (() => void)} onViewMove - Called after
 *   `view()` names another conversation or thread
 * @property {ServicesNotify} [notify] - How to call the extension; defaults to
 *   a call that logs a throw
 * @property {(listener: () => void, what: string, signal: AbortSignal) => void} [coalesce] -
 *   Deliver a burst as one call, for the context-item firehose; defaults to `notify`
 * @property {(listener: (...args: any[]) => void) => void} [dropPending] - Forget
 *   news `coalesce` still holds for a listener that has unsubscribed
 */

/**
 * The view's half: what only the components can do.
 * @typedef {object} ServicesViewPort
 * @property {(target: {kind: string, id: string|null, thread?: string|null}) => void} revealInConversation - Point the columns at a thread, an item or a tool call
 * @property {(conversation: any, target: {kind: string, id: string|null, thread?: string|null}) => {kind: string, id: string|null}} resolveToolTarget - A tool-call reveal as the row or thread it lands on
 * @property {(session: any, conversationId: string) => Promise<boolean>} showConversation - Bring a conversation forward, switching to it
 * @property {(thread: any, text: string) => boolean} pasteIntoThreadComposer - Insert text into a thread's composer; false when there is none
 * @property {(thread: any, text: string) => Promise<void>} composeForThread - Hand text to a thread: its composer, or sent as a message
 * @property {(session: any, options: {providerId?: string, values?: Record<string, unknown>}) => Promise<any>} openWorkspaceCreate - Open the workspace create dialog
 * @property {(session: any, workspace: any, option: any) => Promise<any>} carryOutWorkspaceFinish - Carry out one of a workspace's endings, asking as the panel would
 */

/** @type {ServicesViewPort|null} */
let viewPort = null;

/**
 * Register the view's half. Returns the function that puts the previous one back.
 * @param {ServicesViewPort|null} port - The view's functions.
 * @returns {() => void} Restorer.
 */
export function registerServicesView(port) {
  const previous = viewPort;
  viewPort = port;
  return () => { viewPort = previous; };
}

/** @type {ServicesNotify} */
function notifyDirectly(fn, args, what) {
  try {
    fn(...args);
  } catch (err) {
    console.error(`[Services] An extension failed to handle ${what}:`, err);
  }
}

/**
 * End `stop` with the signal as well as by hand. Safe to call twice.
 * @param {AbortSignal} signal - The lifetime.
 * @param {() => void} stop - The teardown.
 * @returns {() => void} The teardown, once-only.
 */
function tiedTo(signal, stop) {
  let stopped = false;
  const end = () => {
    if (stopped) return;
    stopped = true;
    signal.removeEventListener('abort', end);
    stop();
  };
  if (signal.aborted) end();
  else signal.addEventListener('abort', end, { once: true });
  return end;
}

/**
 * A detached copy of a context item's data. Context-item data is plain JSON by
 * construction, so a round trip is enough, and it fails closed on anything that
 * turns out not to be.
 * @param {any} data - The item's stored data.
 * @returns {Record<string, any>} A copy, or an empty object if it would not clone.
 */
function cloneData(data) {
  try {
    return JSON.parse(JSON.stringify(data ?? {}));
  } catch {
    return {};
  }
}

/**
 * The transcript row that stands for a context item of this type in a thread:
 * the last call of the tool that shares the item's type, skipping a row whose
 * result is a context item (the renderer draws nothing for one). Some items —
 * the plan, the todo list — draw no tile, and this row is their whole presence.
 * @param {any} thread - The MessageThread to scan.
 * @param {string} type - The context-item type, which is also the tool's name.
 * @returns {string|null} The row's item id, or null.
 */
function writingRowId(thread, type) {
  const items = thread?.items;
  if (!Array.isArray(items)) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (itemField(item, 'type') !== 'tool-action') continue;
    if (itemField(item, 'toolName') !== type) continue;
    if (itemField(itemField(item, 'result'), 'resultType') === 'context') continue;
    const itemId = itemField(item, 'itemId');
    return typeof itemId === 'string' && itemId ? itemId : null;
  }
  return null;
}

/**
 * What to call a thread: the name its own column header shows, and the
 * conversation's title for the root.
 * @param {any} conversation - The conversation being read.
 * @param {string|null} threadItemId - The thread, null for the root.
 * @returns {string} A name to show, or '' when the thread was never named.
 */
export function threadLabel(conversation, threadItemId) {
  if (!threadItemId) return conversation?.name ? displayConversationName(conversation.name) : '';
  try {
    const ymap = conversation.findItemById?.(threadItemId);
    return ymap ? (itemGoal(ymap) || '') : '';
  } catch {
    return '';
  }
}

/**
 * The tool action a tool call left in a conversation, or null. Tool-call ids
 * repeat across threads — `call_1` is in every sub-thread — so the thread named
 * is searched first, and the rest only when it holds no such call.
 *
 * Reads fields one at a time and never calls `toJSON`: a background command's
 * result holds its accumulated output.
 * @param {any} conversation - The conversation model, loaded or not.
 * @param {string|null} threadId - The thread it ran in, null for the root.
 * @param {string} toolUseId - The tool call.
 * @returns {any} The action's Yjs map, or null.
 */
export function findToolAction(conversation, threadId, toolUseId) {
  if (!conversation || !toolUseId) return null;
  const threads = conversation.getAllMessageThreads?.() || [];
  /**
   * @param {any} thread - One thread of the conversation.
   * @returns {any} The call's action in it, or null.
   */
  const inThread = (thread) => {
    for (const ymap of thread?.items || []) {
      if (typeof ymap?.get !== 'function') continue;
      if (ymap.get('type') === 'tool-action' && ymap.get('toolUseId') === toolUseId) return ymap;
    }
    return null;
  };
  const named = threads.find((/** @type {any} */ thread) => (thread.threadItemId || null) === (threadId || null));
  const found = named ? inThread(named) : null;
  if (found) return found;
  for (const thread of threads) {
    if (thread === named) continue;
    const other = inThread(thread);
    if (other) return other;
  }
  return null;
}

/**
 * Run one read under both signals that may end it: the surface's lifetime, and
 * whatever the caller passed for the request itself. Both listeners come off
 * the moment the read settles, because the lifetime outlives every read.
 * @template T
 * @param {AbortSignal} mount - The surface's lifetime.
 * @param {AbortSignal|undefined} caller - The signal the caller passed, if any.
 * @param {(signal: AbortSignal) => Promise<T>} read - The read to run.
 * @returns {Promise<T>} What it answered.
 */
async function linkedRequest(mount, caller, read) {
  const child = new AbortController();
  const abort = () => child.abort();
  if (mount.aborted || caller?.aborted) abort();
  else {
    mount.addEventListener('abort', abort);
    caller?.addEventListener('abort', abort);
  }
  try {
    return await read(child.signal);
  } finally {
    mount.removeEventListener('abort', abort);
    caller?.removeEventListener('abort', abort);
  }
}

/**
 * A root as rows and tree listings may spell it — either separator, a trailing
 * one, a drive letter in either case — reduced to one spelling to compare.
 * @param {unknown} path - An absolute path.
 * @returns {string} Its comparable form, '' for none.
 */
function rootKey(path) {
  const text = typeof path === 'string' ? path.replace(/\\/g, '/').replace(/\/+$/, '') : '';
  return /^[A-Za-z]:/.test(text) ? text.toLowerCase() : text;
}

// --- the process inventory ---------------------------------------------------

/**
 * The project's running processes, as last heard: one for the window, however
 * many surfaces watch it. The socket is listened to only while one does, and
 * what was heard is forgotten when the last one leaves — a list nobody kept up
 * to date is not a list to hand the next watcher.
 */
export const taskInventory = {
  /** @type {ProcessInfo[]|null} Null until something has come back. */
  processes: null,
  /** The last listing's failure, kept beside the last answer. */
  error: '',
  /** Counts frames, so a listing fetched before the latest frame cannot overwrite it. */
  frames: 0,
  /** @type {Set<() => void>} */
  watchers: new Set(),
  /** @type {(() => void)|null} */
  unlisten: null,

  /**
   * Ask the server for the whole inventory — for the first watcher, and after
   * the socket comes back. A frame that lands while this is out wins.
   * @returns {Promise<void>}
   */
  async fetch() {
    const framesBefore = this.frames;
    try {
      const answer = await shellListProcesses();
      if (this.frames !== framesBefore) return;
      this.processes = Array.isArray(answer?.processes) ? answer.processes : [];
      this.error = '';
    } catch (err) {
      this.error = errorText(err);
    }
    this.tell();
  },

  /** Tell every watcher the list may have changed. */
  tell() {
    for (const watcher of [...this.watchers]) watcher();
  },

  /**
   * Watch it. Listening starts with the first watcher and stops after the last.
   * @param {() => void} watcher - Called when it may have changed.
   * @returns {() => void} Stop watching.
   */
  watch(watcher) {
    this.watchers.add(watcher);
    if (!this.unlisten) {
      /** @param {any} data */
      const onFrame = (data) => {
        this.frames++;
        this.processes = Array.isArray(data?.processes) ? data.processes : [];
        this.error = '';
        this.tell();
      };
      const onOpen = () => { void this.fetch(); };
      wsService.on('processes-changed', onFrame);
      wsService.on('open', onOpen);
      this.unlisten = () => {
        wsService.off('processes-changed', onFrame);
        wsService.off('open', onOpen);
      };
      void this.fetch();
    }
    return () => {
      this.watchers.delete(watcher);
      if (this.watchers.size || !this.unlisten) return;
      this.unlisten();
      this.unlisten = null;
      this.processes = null;
      this.error = '';
    };
  },
};

// --- the services ------------------------------------------------------------

/**
 * Build the services for one surface.
 * @param {ServicesHost} host - What the surface supplies.
 * @returns {Services} The services.
 */
export function createExtensionServices(host) {
  const { signal } = host;
  const notify = host.notify || notifyDirectly;
  const coalesce = host.coalesce || ((/** @type {() => void} */ fn, /** @type {string} */ what) => notify(fn, [], what));
  const session = () => /** @type {any} */ (host.session());
  const conversation = () => {
    const id = host.view().conversationId;
    return id ? session()?.getConversation?.(id) ?? null : null;
  };

  /**
   * Point the conversation at something. In a detached board there are no
   * columns, so it goes to the window the board came from.
   * @param {{kind: string, id: string|null}} target - The thread or item.
   */
  const reveal = (target) => {
    if (isPinboardView()) {
      const conversationId = host.view().conversationId;
      if (target.kind === 'thread') satelliteLink.revealThread(target.id, conversationId);
      else if (target.id) satelliteLink.revealItem(target.id, conversationId);
      return;
    }
    viewPort?.revealInConversation(target);
  };

  /**
   * @param {string} id - The conversation.
   * @returns {Promise<boolean>} Whether it is on screen.
   */
  const show = async (id) => (viewPort ? viewPort.showConversation(session(), id) : false);

  /**
   * The thread a review is written to and read from: the one being read.
   * Resolved when asked, because both halves of it move under a surface.
   * @returns {any} The thread, or null when there is no conversation.
   */
  const reviewThread = () => {
    const conv = conversation();
    if (!conv) return null;
    try {
      // resolveMessageThread throws for an id that is not a thread item, which
      // a stale view can easily hold.
      return conv.resolveMessageThread(host.view().threadId ?? null);
    } catch {
      return null;
    }
  };

  /**
   * One process as a task, with what the transcript knows laid over it.
   * @param {ProcessInfo} process - The server's entry.
   * @returns {Task} The task.
   */
  const describeProcess = (process) => {
    const conversationId = process.convId || '';
    const s = session();
    const conv = conversationId ? s?.getConversation?.(conversationId) : null;
    const name = conversationId ? (s?.getConversationName?.(conversationId) || conv?.name || '') : '';
    const action = findToolAction(conv, process.threadId || null, process.toolUseId || '');
    return {
      taskId: process.id,
      kind: process.kind,
      conversationId,
      conversationTitle: name ? displayConversationName(name) : '',
      threadId: process.threadId || null,
      toolUseId: process.toolUseId || '',
      itemId: action ? String(itemField(action, 'itemId') || '') : '',
      toolName: action ? String(action.get('toolName') || '') : '',
      command: process.command || '',
      label: (action ? String(itemField(action.get('toolInput'), 'description') || '') : '') || process.label || '',
      at: Number.isFinite(process.startedAt) ? process.startedAt : Infinity,
    };
  };

  /**
   * @param {string} id - A workspace id.
   * @returns {any} Its row, or null.
   */
  const row = (id) => (session()?.workspaces ?? []).find((/** @type {any} */ w) => w.id === id) ?? null;

  return {
    files: {
      onChange: (listener) => {
        const handler = (/** @type {any} */ changes) => {
          if (!Array.isArray(changes) || !changes.length) return;
          const root = (host.view().projectPath || '').replace(/\/+$/, '');
          const resolved = changes.map((/** @type {any} */ change) => ({
            path: root && !/^(?:[/\\]|[A-Za-z]:[/\\])/.test(String(change.path)) ? `${root}/${change.path}` : change.path,
            event: change.event,
          }));
          notify(listener, [resolved], 'a file change');
        };
        wsService.on('file-change', handler);
        return tiedTo(signal, () => wsService.off('file-change', handler));
      },
    },

    contextItems: {
      find: (type, from) => {
        const conv = conversation();
        if (!conv) return null;
        const focused = from === undefined ? (host.view().threadId ?? null) : from;
        const found = findNearestContextItem(conv, type, focused);
        if (!found) return null;
        const { item, thread, threadId } = found;
        let itemId = null;
        try {
          itemId = writingRowId(thread, type);
        } catch {
          itemId = null;
        }
        return {
          id: item.id,
          type: item.type,
          // A copy, so an extension cannot write through it into the conversation.
          data: cloneData(item.data),
          source: { threadId, label: threadLabel(conv, threadId), inherited: threadId !== focused, itemId },
        };
      },
      onChange: (listener) => {
        /** @param {any} event - A session event. */
        const onSession = (event) => {
          if (event.type !== 'context-items:changed' && event.type !== 'conversation:changed') return;
          // Every other conversation in the session emits these too; without this
          // a turn streaming in a tab nobody is looking at would re-read at the
          // sync rate.
          const changed = event.data?.conversationId;
          if (changed && changed !== (host.view().conversationId || '')) return;
          coalesce(listener, 'a context-item change', signal);
        };
        const unsubscribeSession = session()?.subscribe?.(onSession) || null;
        // Moving between threads is one deliberate act, not a stream.
        const onFocus = () => notify(listener, [], 'a thread-focus change');
        document.addEventListener(THREAD_FOCUS_CHANGED, onFocus);
        return tiedTo(signal, () => {
          unsubscribeSession?.();
          document.removeEventListener(THREAD_FOCUS_CHANGED, onFocus);
          host.dropPending?.(listener);
        });
      },
      reveal: (threadId, itemId) => reveal(itemId ? { kind: 'item', id: itemId } : { kind: 'thread', id: threadId ?? null }),
    },

    tasks: {
      // Built afresh on every call, so mutating what it handed out cannot reach
      // the next reader. The conversation being read comes first; within that,
      // newest first.
      list: () => {
        if (!taskInventory.processes) return null;
        const activeId = host.view().conversationId || '';
        const tasks = taskInventory.processes.map(describeProcess);
        tasks.sort((a, b) => (Number(b.conversationId === activeId) - Number(a.conversationId === activeId))
          || (b.at - a.at)
          || a.taskId.localeCompare(b.taskId));
        return tasks;
      },
      error: () => taskInventory.error,
      onChange: (listener) => {
        // Frames repeat the whole table, and most of a burst says what the last
        // one said; and a move to another conversation reorders it. Each
        // watcher is told only when what it would read has changed.
        let last = '';
        const check = () => {
          const signature = JSON.stringify({
            processes: taskInventory.processes && taskInventory.processes.map((p) => p.id),
            active: host.view().conversationId || '',
            error: taskInventory.error,
          });
          if (signature === last) return;
          last = signature;
          notify(listener, [], 'a task change');
        };
        const unwatch = taskInventory.watch(check);
        const unmove = host.onViewMove(check);
        return tiedTo(signal, () => { unwatch(); unmove(); });
      },
      reveal: (task) => {
        if (typeof task === 'string') {
          reveal({ kind: 'item', id: task });
          return undefined;
        }
        // Handed back so a caller can tell when the reveal has landed.
        return (async () => {
          const conversationId = task?.conversationId || host.view().conversationId || '';
          const threadId = task?.threadId ?? null;
          if (isPinboardView()) {
            satelliteLink.revealToolAction(task?.toolUseId || '', threadId, conversationId);
            return;
          }
          if (!viewPort || !(await show(conversationId))) return;
          const conv = session()?.getConversation?.(conversationId);
          viewPort.revealInConversation(task?.toolUseId
            ? viewPort.resolveToolTarget(conv, { kind: 'tool', id: task.toolUseId, thread: threadId })
            : { kind: 'thread', id: threadId });
        })();
      },
      stop: async (taskId) => {
        // A Monitor's task is owned by its delivery binding, and cancelling that
        // is what stops it; anything else the server stops.
        const process = (taskInventory.processes || []).find((candidate) => candidate.id === taskId);
        if (process?.kind === 'background' && process.convId) {
          const conv = session()?.getConversation?.(process.convId);
          const thread = (conv?.getAllMessageThreads?.() || [])
            .find((/** @type {any} */ candidate) => (candidate.threadItemId || null) === (process.threadId || null));
          if (thread?.cancelTaskOutputDelivery?.(taskId)) return;
        }
        await shellStopProcess({ id: taskId });
      },
    },

    review: {
      draft: () => {
        const thread = reviewThread();
        return thread ? thread.reviewDraft : null;
      },
      onChange: (listener) => {
        /** @type {(() => void)|null} */
        let detach = null;
        const bind = () => {
          detach?.();
          detach = null;
          const thread = reviewThread();
          if (thread) detach = thread.observeReviewDraft(() => notify(listener, [], 'a review-draft change'));
        };
        bind();
        // A move puts a different draft in front of the surface: re-point, and
        // say so, since nothing was written to announce it.
        const unmove = host.onViewMove(() => {
          bind();
          notify(listener, [], 'a move to another review draft');
        });
        return tiedTo(signal, () => { unmove(); detach?.(); detach = null; });
      },
      // Refuses rather than trims, checking before anything is written, so a
      // refused save leaves the previous draft exactly as it was.
      save: async (draft) => {
        const thread = reviewThread();
        if (!thread) throw new Error(t('There is no conversation open to keep review comments in.'));
        const problem = reviewDraftBoundsError(draft);
        if (problem) throw new Error(problem);
        thread.reviewDraft = draft;
      },
      clear: async () => {
        const thread = reviewThread();
        if (!thread) throw new Error(t('There is no conversation open to keep review comments in.'));
        thread.reviewDraft = null;
      },
      // Into the thread's composer; else to the window a detached board came
      // from; else sent as one ordinary message. The comments are never cleared.
      compose: async () => {
        const thread = reviewThread();
        if (!thread) throw new Error(t('There is no conversation open to put a review in.'));
        const draft = thread.reviewDraft;
        if (!draft.comments.length) throw new Error(t('There are no review comments to hand over.'));
        const text = formatReviewMessage(draft);
        if (viewPort?.pasteIntoThreadComposer(thread, text)) return;
        if (isPinboardView()
          && satelliteLink.compose(text, thread.conversation.id, thread.threadItemId ?? null)) return;
        if (!viewPort) throw new Error(t('There is no conversation open to put a review in.'));
        await viewPort.composeForThread(thread, text);
      },
    },

    workspaces: {
      list: () => (session()?.workspaces ?? []).map((/** @type {any} */ w) => ({
        id: w.id, label: w.label ?? '', root: w.root ?? '', providerId: w.providerId ?? '',
        state: w.state ?? '', meta: JSON.parse(JSON.stringify(w.meta ?? {})),
      })),
      followed: () => visibleWorkspaceId(),
      onChange: (listener) => {
        const onSession = (/** @type {any} */ event) => {
          if (['session:workspaces-changed', 'conversation:created', 'conversation:deleted', 'conversation:renamed', 'conversation:switched'].includes(event.type)) {
            notify(listener, [], 'a workspace change');
          }
        };
        const unsubscribe = session()?.subscribe?.(onSession) || null;
        const unfollow = onVisibleWorkspaceChange(() => notify(listener, [], 'a followed-tree change'));
        return tiedTo(signal, () => { unsubscribe?.(); unfollow?.(); });
      },
      forTree: (tree) => {
        const named = Array.isArray(tree?.rows) ? new Set(tree.rows) : null;
        const at = rootKey(tree?.path);
        for (const w of session()?.workspaces ?? []) {
          if (!w || w.state === 'closed') continue;
          if (named ? !named.has(w.id) : (!at || rootKey(w.root) !== at)) continue;
          const provider = workspaceProviderRegistry.createProvider(w.providerId ?? '');
          try {
            if (provider?.holdsTree(w, { path: String(tree?.path ?? ''), branch: String(tree?.branch ?? '') })) return String(w.id);
          } catch (err) {
            console.error(`[Services] Workspace provider "${w.providerId}" failed to say whether it holds a tree:`, err);
          }
        }
        return '';
      },
      conversationsOf: (id) => {
        const s = session();
        if (!s?.conversations) return [];
        return [...s.conversations.values()]
          .filter((/** @type {any} */ c) => (c.workspaceId || '') === id)
          .map((/** @type {any} */ c) => ({ id: c.id, title: s.getConversationName?.(c.id) || c.name || '' }));
      },
      // A board window draws no conversations, so it asks the window it was
      // torn from to show this one.
      showConversation: async (id) => {
        if (isPinboardView()) return satelliteLink.selectConversation(id);
        return show(id);
      },
      create: async (request) => {
        if (!session() || !viewPort) return { created: false };
        return viewPort.openWorkspaceCreate(session(), { providerId: request?.providerId, values: request?.values });
      },
      finishOptions: (id) => {
        const w = row(id);
        if (!w || !session()) return { options: [] };
        return workspaceFinishOptions(session(), w);
      },
      finish: async (id, optionId) => {
        const w = row(id);
        if (!w || !session() || !viewPort) return null;
        const option = workspaceFinishOptions(session(), w).options.find((o) => o.id === optionId);
        if (!option) return null;
        return viewPort.carryOutWorkspaceFinish(session(), w, option);
      },
      adopt: async (tree) => {
        if (!session()) return null;
        await probeSetupAdoptions(session(), signal);
        const offer = adoptionRowFor(tree);
        return offer ? adoptSetupRow(session(), offer) : null;
      },
      startConversation: async (request) => {
        const s = session();
        if (!s) throw new Error('No session to start a conversation in.');
        const id = await s.createConversation(request?.name || '', { activate: true, origin: 'pin', workspaceId: request?.workspace || '' });
        await s.getConversation(id)?.sendMessage(request?.message || '');
        return id;
      },
    },

    topics: createTopicsService(signal, { notify }),

    ops: {
      client: (toolId, operation, params, options) => linkedRequest(signal, options?.signal,
        (linked) => clientOp(toolId, operation, params || {}, options?.workspace || '', linked)),
    },

    jobs: {
      list: (options) => jobsService.list(options?.workspace),
      wait: (id, options) => jobsService.wait(id, options?.workspace),
      cancel: (id, options) => jobsService.cancel(id, options?.workspace),
      answer: (id, reply, options) => jobsService.answer(id, reply, options?.workspace),
      watch: (listener, options) => tiedTo(signal, jobsService.onJob(options?.workspace,
        (job) => notify(listener, [JSON.parse(JSON.stringify(job))], 'a job change'))),
    },
  };
}

/**
 * The host for a surface that reads whatever the window shows: the visible
 * conversation, and the thread focused in it. Info cards and workspace
 * providers are built on this.
 * @param {any} session - The session, or null.
 * @param {AbortSignal} signal - The lifetime of what it is for.
 * @returns {ServicesHost} The host.
 */
function sessionServicesHost(session, signal) {
  return {
    signal,
    session: () => session,
    view: () => ({
      projectPath: session?.projectPath || '',
      conversationId: session?.visibleConversationId || '',
      threadId: focusedThreadItemId(),
    }),
    onViewMove: (listener) => {
      const onSession = (/** @type {any} */ event) => {
        if (event?.type === 'conversation:switched') listener();
      };
      const unsubscribe = session?.subscribe?.(onSession) || null;
      document.addEventListener(THREAD_FOCUS_CHANGED, listener);
      return () => {
        unsubscribe?.();
        document.removeEventListener(THREAD_FOCUS_CHANGED, listener);
      };
    },
  };
}

/**
 * The services for a surface that follows the window.
 * @param {any} session - The session, or null.
 * @param {AbortSignal} signal - The lifetime of what they are for.
 * @returns {Services} The services.
 */
export function servicesFor(session, signal) {
  return createExtensionServices(sessionServicesHost(session, signal));
}
