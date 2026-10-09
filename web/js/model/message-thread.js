//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * MessageThread - Encapsulates all item operations for a column.
 *
 * Root and thread conversations get identical MessageThread instances
 * pointing at different Y.Map containers, so consumers never need to ask
 * "am I root or thread?".
 */
import * as Y from '../vendor/yjs.mjs';
import { plainToYMap, convertToYType } from './item-accessor.js';
import { itemRunSettled, promoteThreadView } from './thread-alias.js';
import {
  createToolActionMessage,
  createErrorMessage,
  createUserMessage,
  createSystemReminderMessage,
  createThreadMessage,
  TOOL_STATES,
  ACTION_STATES,
  isToolActionMessage,
  isThreadMessage
} from '../../sdk/lib/message.js';
import strategyRegistry from '../registries/strategy-registry.js';
import contextItemRegistry from '../registries/context-item-registry.js';
import workerManager from '../services/worker-manager.js';
import { submitPendingRequest } from '../services/thread-orchestrator.js';
import * as permissionsHelpers from './message-thread-permissions.js';
import * as contextItemHelpers from './message-thread-context-items.js';
import { recordTape } from '../utils/event-tape.js';
import { normalizeDraft, normalizeAttachments, normalizeTextFiles, normalizePasteBlobs, normalizeScheduledSendMode } from '../utils/attachments.js';
import { normalizeReviewDraft } from '../utils/review-draft.js';

/**
 * @typedef {import('../../sdk/lib/message.js').Message} Message
 * @typedef {import('../../sdk/lib/message.js').ToolActionMessage} ToolActionMessage
 * @typedef {import('../../sdk/lib/message.js').ToolActionResult} ToolActionResult
 */

/**
 * Filter out corrupt (non-Y.Map) entries from a raw items array, warning per drop.
 * @param {Array<any>|null|undefined} raw - Raw entries from a Y.Array.toArray()
 * @param {string} label - Noun for the warning ("item" / "pending item")
 * @returns {Array<any>} Only the well-formed Y.Map entries
 */
function filterCorruptItems(raw, label) {
  return /** @type {Array<any>} */ ((raw || []).filter((/** @type {any} */ item) => {
    if (item && typeof item === 'object' && typeof item.get === 'function') return true;
    console.warn(`[MessageThread] Skipping corrupt ${label} (not a Y.Map):`, item);
    return false;
  }));
}

export default class MessageThread {
  /**
   * @param {import('./conversation.js').default} conversation - Parent conversation
   * @param {*} container - Y.Map container (doc.root or thread Y.Map) that holds an 'items' Y.Array
   * @param {string|null} threadItemId - Thread item ID (null for root)
   * @param {string|null} [strategyId] - Explicit strategy id; when null/omitted the
   *   effective strategy is resolved by walking up to the conversation (a
   *   sub-thread inherits unless it carries its own override).
   */
  constructor(conversation, container, threadItemId, strategyId = null) {
    /** @type {*} */
    this.container = container;
    /** @type {string|null} */
    this.threadItemId = threadItemId;
    /** @type {import('./conversation.js').default} */
    this.conversation = conversation;

    // Resolve the effective strategy when one wasn't explicitly supplied so a
    // sub-thread inherits its parent's (ultimately the conversation's) strategy
    // unless it carries its own override — mirrors getEffectiveModelConfig.
    const resolvedStrategyId = strategyId ?? this.getEffectiveStrategyId();
    /** @type {string} */
    this.currentStrategyId = resolvedStrategyId;
    /** @type {import('juggler/strategy-type').default} */
    this.strategy = strategyRegistry.createStrategy(resolvedStrategyId, this);

    /** @type {boolean} @private */
    this._systemPromptPlaceholderEnsured = false;
  }

  /** @returns {string} Conversation ID (stable identifier for dedup/tracking) */
  get conversationId() { return this.conversation.id; }

  /**
   * Whether THIS thread is being driven. A busy sibling is not this thread's
   * business — the worker takes work on an idle thread while others run — so
   * this is the question every per-thread affordance asks.
   * @returns {boolean} Whether this thread has a run in flight
   */
  get isProcessing() { return this.conversation.isThreadProcessing(this.threadItemId); }

  /**
   * Get the effective model config, walking up the parent chain.
   * Thread → parent thread → ... → conversation metadata.
   * @returns {import('./conversation.js').ModelConfig|null} Effective model config
   */
  get modelConfig() {
    return this.getEffectiveModelConfig();
  }

  /**
   * Get only this thread's own model config override (not inherited).
   * Returns null if this thread inherits from its parent.
   * For root, returns the conversation metadata value.
   * @returns {import('./conversation.js').ModelConfig|null} This thread's own override, or null if inheriting
   */
  get ownModelConfig() {
    if (!this.threadItemId) {
      // Root thread — own config is the conversation-level DEFAULT metadata.
      const config = this.conversation.getMetadata('defaultModelConfig');
      return config !== undefined ? config : null;
    }
    const raw = this.container.get('modelConfig');
    if (!raw) return null;
    // Convert Y.Map to plain object if needed
    if (raw && typeof raw.toJSON === 'function') {
      return raw.toJSON();
    }
    return raw;
  }

  /**
   * Set model config. For root: writes to conversation metadata.
   * For threads: sets override on the thread's Y.Map (or removes it if null).
   * @param {import('./conversation.js').ModelConfig|null} value
   */
  set modelConfig(value) {
    if (!this.threadItemId) {
      // Root thread — write the conversation-level DEFAULT metadata.
      this.conversation.setMetadata('defaultModelConfig', value);
    } else {
      this.transact(() => {
        if (value === null || value === undefined) {
          this.container.delete('modelConfig');
        } else {
          this.container.set('modelConfig', convertToYType(value));
        }
      });
    }
  }

  /**
   * Resolve the effective model config by walking up the parent chain.
   * @returns {import('./conversation.js').ModelConfig|null} Resolved model config from thread chain
   */
  getEffectiveModelConfig() {
    // Walk parent containers iteratively — never construct a MessageThread for
    // ancestors (mirrors getEffectiveStrategyId; keeps hot paths allocation-
    // light). A Y.Map override is unwrapped via toJSON(); a plain object passes
    // through.
    let container = this.threadItemId ? this.container : null;
    let itemId = this.threadItemId;
    while (container && itemId) {
      const raw = container.get('modelConfig');
      if (raw) return typeof raw.toJSON === 'function' ? raw.toJSON() : raw;
      const parent = this.conversation.findParentContainer(itemId);
      if (!parent) break; // parent is the root — fall through to metadata
      container = parent;
      itemId = parent.get('itemId');
    }
    // Root level — conversation-level DEFAULT (`defaultModelConfig`).
    const config = this.conversation.getMetadata('defaultModelConfig');
    return config !== undefined ? config : null;
  }

  /**
   * Resolve the effective strategy id, walking up the parent chain:
   * thread override → parent thread → … → conversation metadata → 'default'.
   * Mirrors getEffectiveModelConfig so a sub-thread inherits the conversation's
   * strategy (e.g. root YOLO) unless it sets its own override.
   * @returns {string} The effective strategy id
   */
  getEffectiveStrategyId() {
    // Walk parent containers iteratively — never construct a MessageThread (or
    // its strategy instance) for ancestors. This runs in the ctor and on hot
    // reconcile paths (getAllMessageThreads), so it must stay allocation-light.
    let container = this.threadItemId ? this.container : null;
    let itemId = this.threadItemId;
    while (container && itemId) {
      const own = container.get('currentStrategyId');
      if (own) return /** @type {string} */ (own);
      const parent = this.conversation.findParentContainer(itemId);
      if (!parent) break; // parent is the root — fall through to metadata
      container = parent;
      itemId = parent.get('itemId');
    }
    const meta = this.conversation.getMetadata('currentStrategyId');
    return meta ? /** @type {string} */ (meta) : 'default';
  }

  /**
   * Whether this thread was spawned by a delegating tool (a subagent call)
   * rather than by the user or the create_thread meta-tool. Read from the
   * `delegated` flag the worker stamps on the thread Y.Map at creation, the same
   * flag `withinDelegatedThread` reads server-side to stop a delegated child
   * starting a further delegation.
   *
   * A delegated child is not user-steerable by design: its strategy is chosen by
   * the tool that called it, so the UI hides that column's strategy control
   * rather than offering a switch that would fight the tool for it.
   * @returns {boolean} True for a thread spawned by tool delegation
   */
  get isDelegated() {
    return this.threadItemId ? this.container.get('delegated') === true : false;
  }

  /**
   * The unsent composer-box draft for this thread — its text, its staged image
   * attachments, any dropped text files, AND the paste-blob side table backing
   * inline paste placeholders, as a single
   * `{text, attachments, textFiles, pasteBlobs}` record. Stored on the thread container
   * (sub-threads) or conversation metadata (root). Because every part is one
   * persisted object, a quit/restart restores the whole draft or nothing:
   * "text kept, attachments/text-files lost" is not expressible. See
   * utils/attachments.normalizeDraft.
   * @returns {import('../utils/attachments.js').Draft} The draft text, attachments, and text files.
   */
  get draft() {
    const raw = this.threadItemId
      ? this.container.get('draft')
      : this.conversation.getMetadata('draft');
    return normalizeDraft(raw);
  }

  /**
   * @param {{text?: string, attachments?: import('../utils/attachments.js').AssetRef[], textFiles?: import('../utils/attachments.js').TextFileSnapshot[], pasteBlobs?: import('../utils/attachments.js').PasteBlob[], scheduledSendAt?: number|null, scheduledSendMode?: import('../utils/attachments.js').ScheduledSendMode}|null} value
   */
  set draft(value) {
    const text = (value && typeof value.text === 'string') ? value.text : '';
    const attachments = normalizeAttachments(value && value.attachments);
    const textFiles = normalizeTextFiles(value && value.textFiles);
    const pasteBlobs = normalizePasteBlobs(value && value.pasteBlobs);
    const rawWhen = value && value.scheduledSendAt;
    const scheduledSendAt = (typeof rawWhen === 'number' && Number.isFinite(rawWhen)) ? rawWhen : null;
    const scheduledSendMode = normalizeScheduledSendMode(scheduledSendAt, value && value.scheduledSendMode);
    // A pending scheduled send counts as content: a record carrying one is not
    // empty, so storing it can never drop the timer on the floor. The composer
    // disarms rather than leave a timer over an empty box, so this holds for
    // writers that clear text and schedule in separate steps, not for a state
    // the user can reach.
    // Paste blobs deliberately do NOT keep an otherwise-empty draft alive: they
    // are an append-only side table for the token characters, and with no text
    // there is no token left to resolve, so an empty box GCs them.
    const empty = !text && attachments.length === 0 && textFiles.length === 0 && scheduledSendAt === null;
    /** @type {{text: string, attachments: import('../utils/attachments.js').AssetRef[], textFiles: import('../utils/attachments.js').TextFileSnapshot[], pasteBlobs: import('../utils/attachments.js').PasteBlob[], scheduledSendAt?: number, scheduledSendMode?: import('../utils/attachments.js').ScheduledSendMode}} */
    const record = { text, attachments, textFiles, pasteBlobs };
    // The mode rides along only for the non-default wait, and only while armed:
    // an absent field reads back as 'delay', so nothing has to clear it.
    if (scheduledSendAt !== null) record.scheduledSendAt = scheduledSendAt;
    if (scheduledSendMode === 'turn-end') record.scheduledSendMode = scheduledSendMode;
    if (this.threadItemId) {
      this.transact(() => {
        if (empty) {
          this.container.delete('draft');
        } else {
          this.container.set('draft', convertToYType(record));
        }
      });
    } else {
      // Root: conversation metadata. No metadata-delete exists, so an empty
      // draft is stored as the empty record rather than deleted.
      this.conversation.setMetadata('draft', empty ? { text: '', attachments: [], textFiles: [], pasteBlobs: [] } : record);
    }
  }

  /**
   * The unsent working-tree review for this thread: the comments written against
   * the diff and not yet sent. Stored the same way the composer draft is — on
   * the thread container for a sub-thread, in conversation metadata for the root
   * — because it is the same kind of thing, unsent input belonging to one
   * destination, and it must survive a tab switch, a detached board and a
   * restart exactly as the composer's does.
   *
   * It is a separate key rather than part of `draft` precisely because the two
   * are sent separately: a review is one message of its own, and folding it into
   * the composer record would make discarding one discard the other.
   * @returns {import('../utils/review-draft.js').ReviewDraft} The comments, always well-formed.
   */
  get gitReviewDraft() {
    const raw = this.threadItemId
      ? this.container.get('gitReviewDraft')
      : this.conversation.getMetadata('gitReviewDraft');
    return normalizeReviewDraft(raw);
  }

  /**
   * @param {{comments?: import('../utils/review-draft.js').ReviewComment[]}|null} value -
   *   The draft to store; null or a draft with no comments clears it.
   */
  set gitReviewDraft(value) {
    const record = normalizeReviewDraft(value);
    const empty = record.comments.length === 0;
    if (this.threadItemId) {
      this.transact(() => {
        if (empty) {
          this.container.delete('gitReviewDraft');
        } else {
          this.container.set('gitReviewDraft', convertToYType(record));
        }
      });
    } else {
      // Root: conversation metadata, which has no delete — so an emptied review
      // is stored as the empty record, exactly as the composer draft is.
      this.conversation.setMetadata('gitReviewDraft', record);
    }
  }

  /**
   * Watch this thread's review draft for changes, including ones made in another
   * window: a detached board and the window it came from write the same record
   * through the same document, so each has to see the other's comments arrive.
   *
   * Returns its own unsubscribe rather than taking the listener back, because a
   * sub-thread's `MessageThread` is a fresh wrapper every time it is resolved —
   * there is no instance for a later `unobserve` call to find the registration on.
   * @param {() => void} listener - Called after the draft may have changed.
   * @returns {() => void} Unsubscribe.
   */
  observeGitReviewDraft(listener) {
    /** @param {any} event - The Y.Map event. */
    const observer = (event) => {
      if (event?.keysChanged?.has?.('gitReviewDraft')) listener();
    };
    if (this.threadItemId) {
      // A thread-container write fires no metadata observer, so the container is
      // what has to be watched — the items observers are on the items array and
      // never see a field written beside it.
      this.container.observe(observer);
      return () => this.container.unobserve(observer);
    }
    this.conversation.observeMetadata(observer);
    return () => this.conversation.unobserveMetadata(observer);
  }

  /**
   * Get the Y.Array of items inside this container.
   * Returns undefined if items haven't been created yet (before first sync).
   * @returns {*} The Y.Array or undefined
   */
  get yarray() {
    return this.container.get('items');
  }

  /**
   * Get or create the Y.Array of items inside this container.
   * @returns {*} The Y.Array (guaranteed to exist after this call)
   */
  ensureYarray() {
    let arr = this.container.get('items');
    if (!arr) {
      arr = new Y.Array();
      this.transact(() => {
        this.container.set('items', arr);
      });
    }
    return arr;
  }

  // ── Read ──────────────────────────────────────────────────────────

  /**
   * Get items array — filters out corrupt (non-Y.Map) entries
   * @returns {Array<any>} Filtered items array
   */
  get items() {
    const arr = this.yarray;
    if (!arr) return [];
    return filterCorruptItems(arr.toArray(), 'item');
  }

  /** @returns {number} Item count */
  get length() {
    const arr = this.yarray;
    return arr ? arr.length : 0;
  }

  /**
   * When this thread last changed, as Unix ms. Derived rather than stored:
   * nothing records a conversation-level modification time in the doc, so the
   * newest item `timestamp` the worker stamped is the only recency signal
   * there is. Items are appended in order, so the scan runs back from the end
   * and stops at the first dated one — items the client inserts optimistically
   * carry no timestamp until the worker echoes them back.
   * @returns {number} Unix ms, or 0 when the thread holds no dated item
   */
  get lastActivityAt() {
    const items = this.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const raw = items[i]?.get?.('timestamp');
      if (!raw) continue;
      const ms = new Date(String(raw)).getTime();
      if (!isNaN(ms)) return ms;
    }
    return 0;
  }

  /**
   * Get the queued (pending) items for this thread — parked in a `pendingItems`
   * Y.Array that is a sibling of `items` on this container (see
   * worker/pending_items.go). Mostly the user messages the worker parks when a
   * send arrives mid-turn, but it can also hold at-mention / dropped-file reads
   * the client enqueues alongside such a message (see {@link enqueuePendingItem})
   * so the reads stay grouped with their message through promotion. None of them
   * are part of the conversation or the LLM context until the worker promotes the
   * queue at a turn boundary. Mirrors `items`: filters out corrupt non-Y.Map entries.
   * @returns {Array<any>} Pending item Y.Maps (empty if none queued)
   */
  get pendingItems() {
    const arr = this.container.get('pendingItems');
    if (!arr) return [];
    return filterCorruptItems(arr.toArray(), 'pending item');
  }

  /**
   * The rows a column renders for this thread, and a key that changes whenever
   * they do: the item ids in order, then the queued ones. A column re-renders
   * only when the key differs from the one it last rendered. Content changes
   * inside an item do not move the key, because the item's own observers
   * repaint its row.
   * @returns {{items: Array<any>, key: string}} The items (a fresh array) and their key.
   */
  renderSnapshot() {
    const items = this.items;
    const ids = (/** @type {Array<any>} */ list) => list.map((item) => item.get('itemId') ?? '').join(',');
    return { items, key: `${ids(items)}|pending:${ids(this.pendingItems)}` };
  }

  /**
   * The thread's goal: the header its column shows. A thread's `goal` moves
   * with its latest call, so this is the session as it stands; a single call's
   * own label is `itemGoal` (`thread-alias.js`). Empty for the root.
   * @returns {string} The goal, or ''.
   */
  get goal() {
    if (!this.threadItemId) return '';
    const goal = this.container.get('goal');
    return typeof goal === 'string' ? goal : '';
  }

  /**
   * Find item by itemId
   * @plugin-api
   * @param {string} id
   * @returns {*|null} Y.Map or null
   */
  findByItemId(id) {
    return this.items.find(item => item.get('itemId') === id) || null;
  }

  /**
   * Find item index by itemId
   * @param {string} id
   * @returns {number} -1 if not found
   */
  findIndexByItemId(id) {
    return this.items.findIndex(item => item.get('itemId') === id);
  }

  // ── Query ───────────────────────────────────────────────────────

  /**
   * Get messages for rendering (currently equivalent to items).
   * @returns {Message[]} Messages for rendering
   */
  getMessages() {
    return /** @type {Message[]} */ (this.items);
  }

  /**
   * Get a tool-action message by toolUseId.
   * @param {string} toolUseId - Tool use ID to find
   * @returns {ToolActionMessage|undefined} The tool-action message, or undefined
   */
  getToolAction(toolUseId) {
    return /** @type {ToolActionMessage|undefined} */ (
      this.items.find(m => isToolActionMessage(/** @type {Message} */ (m)) && m.get('toolUseId') === toolUseId)
    );
  }

  /**
   * Check if tool-action has a result
   * @param {string} toolUseId - Tool use ID
   * @returns {boolean} True if tool-action has result
   */
  hasToolResult(toolUseId) {
    const toolAction = this.getToolAction(toolUseId);
    if (!toolAction) return false;
    const result = toolAction.get('result');
    if (result === null || result === undefined) return false;
    const content = result.get ? result.get('content') : result.content;
    const cancelled = result.get ? result.get('cancelled') : result.cancelled;
    return content !== undefined || cancelled === true;
  }

  /**
   * Get pending approval messages
   * @returns {ToolActionMessage[]} Pending approvals
   */
  getPendingApprovalMessages() {
    return /** @type {ToolActionMessage[]} */ (
      this.items.filter(m =>
        isToolActionMessage(/** @type {Message} */ (m)) &&
            m.get('state') === TOOL_STATES.PENDING
      )
    );
  }

  /**
   * Check if any items are currently busy (running tool-actions or active threads).
   * Used to block input while the model is executing.
   * @returns {boolean} True if any items are busy
   */
  hasBusyItems() {
    // Read once: the getter rebuilds and re-filters the array, and an alias
    // resolves against the siblings it stands among.
    const items = this.items;
    for (const m of items) {
      // Tool-action: APPROVED (ready to claim) or RUNNING (claimed,
      // executing) means work is in flight.
      if (isToolActionMessage(/** @type {Message} */ (m))) {
        const state = m.get('state');
        if (state === TOOL_STATES.APPROVED || state === TOOL_STATES.RUNNING) {
          return true;
        }
      }
      // Thread: a run that has not settled is a sub-thread still working.
      // Asked of the run, not of `result` — a summary outlives the run that
      // wrote it, so a thread carrying one may well be running again. Asked of
      // the ITEM, so an alias answers for the call it stands for: it owns no
      // transcript and no summary of its own, and the thread question would read
      // it as working for as long as it sits here.
      if (isThreadMessage(/** @type {Message} */ (m)) && !itemRunSettled(m, items)) {
        return true;
      }
    }
    return false;
  }

  // ── Mutate ────────────────────────────────────────────────────────

  /**
   * Insert an item at a specific index
   * @param {number} index
   * @param {*} ymap - Y.Map to insert (already converted)
   */
  insertAt(index, ymap) {
    this.ensureYarray().insert(index, [ymap]);
  }

  /**
   * Append a message to this thread's `pendingItems` queue, get-or-creating the
   * array on the container (the same sibling-of-`items` array the worker parks
   * queued user messages in; see worker/pending_items.go).
   *
   * Used to ride at-mention / dropped-file reads alongside a user message that is
   * being QUEUED while a turn is in flight: enqueuing the reads here (before the
   * worker appends the queued user message) means `promotePendingItems` moves the
   * whole group into `items` together — the reads landing as a contiguous block
   * immediately before their message. If the reads went into `items` directly
   * (as they do on an idle send), they would land now while the message is
   * promoted only at the next turn boundary, with the in-flight turn's output
   * wedged between them.
   *
   * The array is get-or-created exactly as the worker does it, so whichever side
   * writes first wins the key and the other reuses it (the client always writes
   * before dispatching its send, so the worker's later append sees this array).
   * @plugin-api
   * @param {any} message - Plain message object (converted to Y.Map via plainToYMap)
   */
  enqueuePendingItem(message) {
    this._ensureItemId(message);
    this.transact(() => {
      let arr = this.container.get('pendingItems');
      if (!arr) {
        arr = new Y.Array();
        this.container.set('pendingItems', arr);
      }
      arr.insert(arr.length, [plainToYMap(message)]);
    });
  }

  /**
   * Delete count items starting at index
   * @param {number} index
   * @param {number} [count]
   */
  deleteAt(index, count = 1) {
    const arr = this.yarray;
    if (!arr || index < 0 || index >= arr.length) return;
    arr.delete(index, count);
  }

  /**
   * Find an item by its itemId and delete it.
   *
   * Deleting one item deletes one item, threads included. A thread called more
   * than once has one parent item per call, and they are separate items: the
   * user selected one of them, so the others must still be there afterwards.
   *
   * Deleting the item that owns the transcript is the case that needs work. Its
   * other views hold no transcript of their own (see model/thread-alias.js), so
   * one left pointing at nothing is a tile with nothing to show and a call the
   * wire can only answer with an error. The transcript is handed to the oldest
   * of them instead (promoteThreadView), in the same transaction as the delete —
   * so one undo puts it back exactly as it was.
   * @plugin-api
   * @param {string} id
   * @returns {boolean} true if the item was found and deleted
   */
  deleteItemById(id) {
    const index = this.findIndexByItemId(id);
    if (index < 0) return false;
    const target = this.items[index];
    if (target?.get?.('type') !== 'thread' || target.get('aliasOf')) {
      this.deleteAt(index);
      return true;
    }
    this.transact(() => {
      promoteThreadView(target, this.yarray);
      this.deleteAt(this.findIndexByItemId(id));
    });
    return true;
  }

  /**
   * Remove an item by id from wherever it lives — the committed `items` array or
   * the `pendingItems` queue. This is the container-aware delete the properties
   * panel uses, so a selected queued message can be removed from the queue exactly
   * like any other item is deleted.
   * @plugin-api
   * @param {string} id
   * @returns {boolean} true if the item was found and removed
   */
  removeItemById(id) {
    const pendingArr = this.container.get('pendingItems');
    if (pendingArr) {
      const raw = pendingArr.toArray() || [];
      const idx = raw.findIndex((/** @type {any} */ it) =>
        it && typeof it.get === 'function' && it.get('itemId') === id);
      if (idx >= 0) {
        this.transact(() => { pendingArr.delete(idx, 1); });
        return true;
      }
    }
    return this.deleteItemById(id);
  }

  /**
   * Delete all user-deletable items before the given index.
   * Skips items with preventUserDeletion. Iterates in reverse to preserve indices.
   *
   * The sweep is one transaction, so it reaches the worker as a single update
   * and lands as a single undo group. Deleting item-by-item instead would leave
   * grouping to the worker UndoManager's capture window, which it measures on
   * arrival — a long sweep straddling that window splits into several groups
   * and one undo then restores only part of it.
   * @param {number} index - Items before this index are deleted
   * @returns {number} How many items were deleted
   */
  deleteUpTo(index) {
    const items = this.items;
    let deleted = 0;
    this.transact(() => {
      for (let i = index - 1; i >= 0; i--) {
        if (!items[i]?.get('preventUserDeletion')) {
          this.deleteAt(i);
          deleted++;
        }
      }
    });
    return deleted;
  }

  /**
   * Delete all user-deletable items after the given index (exclusive).
   * Skips items with preventUserDeletion. Iterates in reverse to preserve indices.
   * One transaction, for the reason given on {@link deleteUpTo}.
   * @param {number} index - Items after this index are deleted
   * @returns {number} How many items were deleted
   */
  deleteAfter(index) {
    const items = this.items;
    let deleted = 0;
    this.transact(() => {
      for (let i = items.length - 1; i > index; i--) {
        if (!items[i]?.get('preventUserDeletion')) {
          this.deleteAt(i);
          deleted++;
        }
      }
    });
    return deleted;
  }

  /**
   * Delete items at specified indices (in any order).
   * Indices are sorted descending to preserve positions during deletion.
   * @param {number[]} indices
   */
  removeItemsAt(indices) {
    const arr = this.yarray;
    if (!arr) return;
    const sorted = [...indices].filter(i => i >= 0 && i < arr.length).sort((a, b) => b - a);
    for (const i of sorted) {
      arr.delete(i, 1);
    }
  }

  /**
   * Delete items from fromIndex to end. Pure yjs array mutation.
   * Callers needing orchestration (cancel approvals, stop processing)
   * should use conversation.deleteRangeWithCleanup() instead.
   * @param {number} fromIndex
   * @returns {number} How many items were deleted
   */
  deleteRange(fromIndex) {
    if (fromIndex < 0 || fromIndex >= this.items.length) return 0;

    const arr = this.ensureYarray();
    const deleteCount = arr.length - fromIndex;
    if (deleteCount > 0) {
      arr.delete(fromIndex, deleteCount);
    }
    return deleteCount;
  }

  /**
   * Delete all items
   */
  clear() {
    const arr = this.yarray;
    if (!arr) return;
    const length = arr.length;
    if (length > 0) {
      arr.delete(0, length);
    }
  }

  // ── Transaction wrapper ─────────────────────────────────────────────

  /**
   * Run a function inside a Yjs transaction with proper author attribution.
   * This is the public API for plugins that need atomic multi-step mutations,
   * and the route every mutation in this class takes: the document is the
   * conversation's, so `Conversation.atomicUpdate` is the only sanctioned way
   * to write it and this is that door for thread-scoped code.
   * @plugin-api
   * @param {() => void} fn - Function to execute inside the transaction
   */
  transact(fn) {
    this.conversation.atomicUpdate(fn);
  }

  /**
   * Run fn as a single transaction, then assert invariants in dev mode.
   * Use this instead of transact() when writing multi-step mutations in plugins.
   * @plugin-api
   * @param {() => void} fn
   */
  mutate(fn) {
    this.transact(fn);
    if (typeof window !== 'undefined' && /** @type {any} */ (window).__jugglerDevMode) {
      try { this.assertInvariants(); }
      catch (e) { console.error('[invariant violation after mutate()]', e); }
    }
  }

  // ── Invariant checking ───────────────────────────────────────────────

  /**
   * Assert all known invariants for this thread. Throws if any are violated.
   * Call from tests after every mutation step.
   * @plugin-api
   */
  assertInvariants() {
    if (this.threadItemId) {
      // A sub-thread MAY own a system-prompt item — its own cloned copy, seeded
      // from the parent at creation with a FRESH id — but never the canonical
      // literal SYSTEM_1, which is root-only (cloning with a fresh id is what
      // avoids duplicate-id collisions across threads).
      if (this.findByItemId('SYSTEM_1') !== null)
        throw new Error(`[${this.threadItemId}] sub-thread must not own SYSTEM_1`);
    } else if (this.findByItemId('SYSTEM_1') === null) {
      // The root thread owns exactly one SYSTEM_1 system-prompt placeholder.
      throw new Error('[root] SYSTEM_1 missing');
    }
    const arr = this.yarray;
    if (!arr) return;
    const seen = new Set();
    for (const item of arr.toArray()) {
      const id = item?.get?.('itemId');
      if (id && seen.has(id)) throw new Error(`Duplicate itemId: ${id}`);
      if (id) seen.add(id);
    }
  }

  // ── Item observation ─────────────────────────────────────────────────

  /**
   * Observe shallow item array changes (insertions and deletions).
   * @plugin-api
   * @param {(event: any) => void} fn
   */
  observeItems(fn) { this.yarray?.observe(fn); }

  /** @param {(event: any) => void} fn */
  unobserveItems(fn) { this.yarray?.unobserve(fn); }

  /**
   * Observe deep changes to items, including nested Y.Map field mutations.
   * @plugin-api
   * @param {(events: any[], transaction: any) => void} fn
   */
  observeItemsDeep(fn) { this.yarray?.observeDeep(fn); }

  /** @param {(events: any[], transaction: any) => void} fn */
  unobserveItemsDeep(fn) { this.yarray?.unobserveDeep(fn); }

  // ── Item field updates ──────────────────────────────────────────────

  /**
   * Update a single field on the item at index
   * @param {number} index
   * @param {string} field
   * @param {*} value
   */
  updateItemField(index, field, value) {
    const yarray = this.ensureYarray();
    if (index < 0 || index >= yarray.length) return;
    this.transact(() => {
      const ymap = yarray.get(index);
      if (ymap instanceof Y.Map) {
        ymap.set(field, convertToYType(value));
      }
    });
  }

  // ── Event/message operations ──────────────────────────────────────

  /**
   * Add a message/event to the end of the items list.
   * Assigns a unique itemId and validates uniqueness.
   * @plugin-api
   * @param {any} message - Plain object to add (converted to Y.Map via plainToYMap)
   */
  addEvent(message) {
    this._insertEventAt(message, undefined);
  }

  /**
   * Insert a message at a position
   * @param {any} message - Plain object to insert (converted to Y.Map via plainToYMap)
   * @param {number} [index] - Position to insert at (undefined = append to end)
   */
  _insertEventAt(message, index) {
    // A pre-existing itemId means this is a restore/move — guard against
    // colliding with a live item. A fresh message gets one minted.
    if (this._ensureItemId(message)) {
      const itemId = /** @type {any} */ (message).itemId;
      const existing = this.items.find(item => item.get('itemId') === itemId);
      if (existing) {
        throw new Error(`[BUG] Duplicate itemId ${itemId}! Type: ${message.type}`);
      }
    }

    // Assert unique toolUseId for tool-action messages
    if (isToolActionMessage(message) && message.toolUseId) {
      const toolUseId = message.toolUseId;
      const existing = this.items.find(item =>
        isToolActionMessage(/** @type {Message} */ (item)) && item.get('toolUseId') === toolUseId
      );
      if (existing) {
        throw new Error(`[BUG] Duplicate toolUseId ${toolUseId}! Type: ${message.type}`);
      }
    }

    const insertIndex = index !== undefined ? index : this.length;
    this.insertAt(insertIndex, plainToYMap(message));
  }

  /**
   * Single owner of the "every item is addressable by a non-empty itemId"
   * invariant. Mints an id when one is missing. Both insertion mechanisms
   * route through here — `_insertEventAt` (append to a live thread) and
   * `buildThreadYMap` (seed items into a detached nested array before the
   * thread exists). The latter can't call `addEvent` because there is no live
   * thread to scan/insert into yet; sharing this helper keeps the invariant in
   * one place so no seed path (compaction's summary message, sub-thread seeds)
   * can land an unselectable id-less item.
   * @param {any} message - Plain object; mutated in place to carry an itemId.
   * @returns {boolean} True if the message already had an itemId.
   */
  _ensureItemId(message) {
    if (/** @type {any} */ (message).itemId) return true;
    /** @type {any} */ (message).itemId = this.conversation._nextItemId();
    return false;
  }

  /**
   * Insert a plain object item at a specific index (converts to Y.Map).
   * Routes through `_ensureItemId` so the item is always addressable/selectable.
   * @param {number} index - Index to insert at
   * @param {any} item - Plain object item
   */
  insertItem(index, item) {
    this._ensureItemId(item);
    this.insertAt(index, plainToYMap(item));
  }

  // ── Tool-action lifecycle ────────────────────────────────────────────

  /**
   * Append a tool-action message.
   * @plugin-api
   * @param {object} data - Data for tool-action message
   * @param {string} data.toolUseId - Unique ID for this tool action
   * @param {string} data.toolName - Name of the tool being called
   * @param {Record<string, unknown>} [data.toolInput] - Input parameters
   * @param {string} [data.contextItemId] - Context item ID
   * @param {import('../../sdk/lib/message.js').ToolState} [data.state] - Tool lifecycle state
   * @param {object} [data.approvalOptions] - Approval options for UI
   * @param {object} [data.displayData] - Display data for UI
   * @param {ToolActionResult|null} [data.result] - Result (null = pending)
   * @returns {ToolActionMessage} The created tool-action message
   */
  appendToolAction(data) {
    const message = createToolActionMessage(data);
    this.addEvent(message);
    return message;
  }

  /**
   * Complete a tool-action by setting its result.
   * @plugin-api
   * @param {string} toolUseId - Tool use ID to find
   * @param {ToolActionResult} result - Result to set
   */
  completeToolAction(toolUseId, result) {
    const toolAction = this.getToolAction(toolUseId);
    if (!toolAction) return;

    const yarray = this.ensureYarray();
    const index = this.items.findIndex(item => item.get('toolUseId') === toolUseId);
    if (index >= 0 && index < yarray.length) {
      const finalState = result.cancelled ? TOOL_STATES.CANCELLED : TOOL_STATES.COMPLETED;
      // A tool that returned images passes AssetRefs on `result.attachments`.
      // Store them at the item level (the same field user attachments use) so
      // serialization, GC retention, and the worker's image-part emission all
      // treat them identically — and keep them out of the stored `result` blob
      // to avoid duplicating the refs.
      // The tool-hook record is item-level for the same reason: the worker
      // reads it beside the result (its notes ride inside the tool_result), and
      // beforeTool hooks write it before there is a result at all.
      const { attachments, hooks, ...resultRest } = /** @type {any} */ (result || {});
      // displayData is by far the largest thing a tool-action carries: an edit's
      // diff holds the whole file both before and after. It reaches here twice —
      // once on the item, set by the approval flow, and again nested inside
      // fullResult — so it is MOVED out of the result blob rather than copied
      // alongside it, leaving the document one copy however the action was
      // approved. Everything reads the item-level field; nothing reads the
      // stored fullResult.displayData.
      const { displayData: promotedDisplayData, ...fullResultRest } = resultRest.fullResult || {};
      if (promotedDisplayData) {
        resultRest.fullResult = /** @type {import('../../sdk/lib/message.js').ActionFullResult} */ (
          fullResultRest
        );
      }
      // Set state and result atomically so the observer (and the Go worker)
      // never see state=completed/cancelled without a result, or vice versa.
      this.transact(() => {
        const ymap = yarray.get(index);
        if (ymap instanceof Y.Map) {
          ymap.set('state', finalState);
          ymap.set('result', convertToYType(resultRest));
          if (Array.isArray(attachments) && attachments.length) {
            ymap.set('attachments', convertToYType(attachments));
          }
          if (Array.isArray(hooks)) {
            ymap.set('hooks', convertToYType(hooks));
          }
          // Promote it onto the YMap so the properties panel can render diffs for
          // auto-approved actions, where the approval flow never set the
          // item-level field. When that field is already set the promoted copy is
          // simply dropped — it is the same diff.
          if (promotedDisplayData && !ymap.get('displayData')) {
            ymap.set('displayData', convertToYType(promotedDisplayData));
          }
        }
      });
    }
  }

  /**
   * Update the lifecycle state of a tool action.
   * @param {string} toolUseId
   * @param {import('../../sdk/lib/message.js').ToolState} state
   * @param {{ifState?: string}} [options] - Optional CAS on current state
   */
  updateToolActionState(toolUseId, state, { ifState } = {}) {
    this.transact(() => {
      const items = this.items;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (isToolActionMessage(/** @type {Message} */ (item)) && item.get('toolUseId') === toolUseId) {
          if (ifState !== undefined && (item.get('state') ?? '') !== ifState) break;
          item.set('state', state);
          break;
        }
      }
    });
  }

  /**
   * Get the tool-actions a refusal answers for: the ones parked awaiting
   * approval, and the ones the engine has not evaluated yet.
   *
   * The unevaluated half is what separates this from
   * {@link getPendingApprovalMessages}, which answers the different question of
   * what is on screen asking. A batch is appended all at once and evaluated one
   * call at a time, so while the first prompt is up its siblings are still at
   * state "" — they carry no approval form and nothing is showing for them, but
   * they are every bit as unstarted, and moments later the engine parks them
   * too.
   * @returns {ToolActionMessage[]} Parked and unstarted tool-actions
   */
  getRefusableApprovalMessages() {
    return /** @type {ToolActionMessage[]} */ (
      this.items.filter(m => {
        if (!isToolActionMessage(/** @type {Message} */ (m))) return false;
        const state = m.get('state') ?? '';
        return state === TOOL_STATES.PENDING || state === '';
      })
    );
  }

  /**
   * Refuse every call in this thread that has not started: the parked ones and
   * the ones still awaiting evaluation.
   *
   * This is the cascade behind "denying any call denies the batch". It has to
   * reach the unevaluated calls or it does not implement that policy at all:
   * cancelling only what is parked leaves the siblings to be parked a moment
   * later, so the person who refused the batch is asked again about the rest,
   * and the turn rests on those prompts because the worker rests while any
   * tool-action is non-terminal.
   *
   * Calls that are executing (approved/running) are deliberately left alone.
   * They have a process behind them, and stopping those is the cancel path's
   * job — it aborts the execution as well as writing the state.
   */
  cancelPendingApprovals() {
    for (const toolUse of this.getRefusableApprovalMessages()) {
      this.resolveApproval(toolUse.get('toolUseId'), 'cancel');
    }
  }

  /**
   * Resolve a pending approval. Pure yjs mutation — the Go worker observes
   * the approval state change and commands the engine to execute
   * (`execute-tool`), cascade-cancel (`cancel-tool`), and persist permissions.
   * @plugin-api
   * @param {string} toolUseId
   * @param {string} response - 'yes', 'no', 'yes-always', or 'cancel'
   * @param {{approvalRules?: Array<{kind: string, value: any, scope?: string}>, approvalAllowedPaths?: string[], approvalItemType?: string, source?: 'user'|'strategy'|'rule'}} [extra]
   *   For 'yes-always': the exact permission rules (and owning itemType) and/or
   *   the allowed-paths roots the chosen suggestion should persist. Omit for a
   *   bare 'yes-always' — the framework then derives the grant from the plugin's
   *   narrowest `getApprovalSuggestions` entry.
   *   `source` records approval provenance for the UI, naming the approving
   *   body: `user` (a human clicked approve), `strategy` (the active strategy
   *   approved it — a force-approve strategy or an out-of-band reviewer), or
   *   `rule` (a saved permission rule). Stamped on the tool-action only for an
   *   approval, never a cancel.
   * @returns {boolean} True when the resolution was written. False when the
   *   tool-action is missing or has already settled — another path (a rule
   *   sync, a strategy reviewer, a peer) resolved it first, so NOTHING is
   *   written here: no `approvalResponse`, and hence no permission grant. A
   *   caller that offered the user a "don't ask again" button must treat false
   *   as "the grant did not persist" rather than assume success.
   *
   *   Which states count as resolvable differs by direction, and the asymmetry
   *   is the point. An APPROVAL requires a call parked at PENDING: it answers
   *   the options the engine derived when it parked the call, and there is
   *   nothing to say yes to before that. A REFUSAL also settles a call the
   *   engine has not evaluated yet (state ""), because refusing needs to know
   *   nothing about the call — and because nothing else ever will: the batch
   *   cascade is the only thing that looks at those siblings, and leaving one
   *   behind parks the turn on a prompt its user already refused.
   */
  resolveApproval(toolUseId, response, extra = {}) {
    const message = this.getToolAction(toolUseId);
    if (!message) return false;

    const isCancel = response === 'no' || response === 'cancel';
    const state = message.get('state') ?? '';
    if (state !== TOOL_STATES.PENDING && !(isCancel && state === '')) return false;

    recordTape('approval', this.conversationId, { toolUseId, response });
    // Write APPROVED (not RUNNING): the frontend reducer atomically claims
    // APPROVED → RUNNING and then launches execution. Writing RUNNING directly
    // would skip the claim and re-fire on every displayData tick.
    const newState = isCancel ? TOOL_STATES.CANCELLED : TOOL_STATES.APPROVED;

    const messageToolUseId = message.get('toolUseId');
    const yarray = this.ensureYarray();
    const index = this.items.findIndex(item => item.get('toolUseId') === messageToolUseId);
    if (index < 0 || index >= yarray.length) return false;

    // Write state + result in a single transaction so the Go worker never sees
    // state=cancelled without a result (races checkToolsComplete otherwise).
    let written = false;
    this.transact(() => {
      const ymap = yarray.get(index);
      if (!(ymap instanceof Y.Map)) return;

      if (!isCancel) {
        ymap.set('approvalResponse', response);
        // Persist the chosen suggestion's rules so the permission saved by the
        // observer matches exactly what the button offered (no re-derivation).
        if (extra.approvalRules && extra.approvalItemType) {
          ymap.set('approvalRules', convertToYType(extra.approvalRules));
          ymap.set('approvalItemType', extra.approvalItemType);
        }
        // Persist the chosen suggestion's allowed-paths grant (alternative to
        // rules) the same way — the observer adds these folders verbatim.
        if (extra.approvalAllowedPaths && extra.approvalAllowedPaths.length > 0) {
          ymap.set('approvalAllowedPaths', convertToYType(extra.approvalAllowedPaths));
        }
        // Record the approving body (user / strategy / rule) so the UI can show
        // who approved this call. Approval only — a cancel has no source.
        if (extra.source) ymap.set('approvalSource', extra.source);
      }
      ymap.set('state', newState);

      if (newState === TOOL_STATES.CANCELLED) {
        ymap.set('result', convertToYType({
          content: 'Action was cancelled.',
          isError: false,
          cancelled: true,
          fullResult: { state: ACTION_STATES.CANCELLED }
        }));
      }
      written = true;
    });
    return written;
  }

  /**
   * Refuse a parked call without stopping the turn.
   *
   * The counterpart to {@link resolveApproval} for automation standing in where
   * there is no person to ask. A refusal settles the call as a FAILED one —
   * state `completed`, result flagged `isError` — so the model sees a tool that
   * did not work and can route around it.
   *
   * The distinction from a denial is load-bearing. `resolveApproval(id, 'no')`
   * writes state `cancelled`, and the worker's reducer reads a cancelled member
   * of a tool batch as a human denial, which stops the automatic loop
   * (`anyBatchCancelled` in thread_reducer.go) — a person who denies a call
   * means "stop", not "carry on without it". Automation refusing on an absent
   * user's behalf means the opposite, so it refuses through this method and the
   * loop continues.
   *
   * Only acts while the call is still PENDING; anything else has already been
   * resolved by another path (the user, a rule sync, a peer) and is left alone.
   * @plugin-api
   * @param {string} toolUseId - The parked call to refuse
   * @param {string} [reason] - Handed to the model verbatim as the tool's error
   *   result. Say what could not be done, so the model can work around it.
   * @returns {boolean} True when the refusal was written. False when the call is
   *   missing or has already left PENDING.
   */
  refuseApproval(toolUseId, reason = 'Refused: this call needed approval and nothing here can grant it.') {
    const message = this.getToolAction(toolUseId);
    if (!message || message.get('state') !== TOOL_STATES.PENDING) return false;

    recordTape('approval', this.conversationId, { toolUseId, response: 'refuse' });
    this.completeToolAction(toolUseId, { content: reason, isError: true });
    return true;
  }

  /**
   * Wait for user to approve/deny a tool use.
   * @param {string} toolUseId
   * @returns {Promise<string>} 'yes', 'no', 'yes-always', or 'cancel'
   */
  async waitForApproval(toolUseId) {
    return this.conversation.waitForApproval(this, toolUseId);
  }

  /**
   * Continue the conversation without a user message.
   * @param {(() => void)} [beforeContinue] - Run only if the continue goes ahead
   *   (past the busy guards, before the worker is told). For callers that must
   *   change the transcript to make their continue meaningful.
   * @returns {Promise<boolean>} True when a continuation was dispatched.
   */
  async continue(beforeContinue) {
    return this.conversation.continueThread(this, beforeContinue);
  }

  /**
   * Create a child thread, run it to completion, and return the result.
   * This is the public API for plugins to create sub-threads — callers
   * do not need to know about the worker or execution engine.
   * Optional `strategyId` / `modelConfig` overrides are stamped on the new
   * thread's Y.Map (the worker applies them in createThread), so the child runs
   * under a different strategy (e.g. read-only) or model than this thread —
   * used by user-defined subthread commands.
   * @plugin-api
   * @param {{goal: string, prompt: string, isContinuation?: boolean, signal?: AbortSignal|null, strategyId?: string, modelConfig?: object|null}} options - `goal` is a short UI label; `prompt` is the complete task.
   * @returns {Promise<{threadItemId: string, result: string}>} Thread item ID and result
   * @throws {Error} If thread creation fails or is cancelled
   */
  async runInThread({ goal, prompt, isContinuation = false, signal = null, strategyId = '', modelConfig = null }) {
    return submitPendingRequest(this, 'createThread', (reqMap) => {
      reqMap.set('goal', goal);
      reqMap.set('prompt', prompt);
      if (this.threadItemId !== null && this.threadItemId !== undefined) {
        reqMap.set('parentThreadItemId', this.threadItemId);
      }
      if (strategyId) reqMap.set('strategyId', strategyId);
      // modelConfig rides as a JSON string (a simple scalar the worker snapshot
      // reads without nested Y.Map decoding).
      if (modelConfig && typeof modelConfig === 'object') {
        reqMap.set('modelConfig', JSON.stringify(modelConfig));
      }
      reqMap.set('isContinuation', isContinuation === true);
    }, signal ?? undefined);
  }

  /**
   * Create a child thread and auto-continue the LLM in it.
   * @returns {Promise<string|null>} The new thread's item ID, or null if cancelled
   */
  async continueInNewThread() {
    try {
      const { threadItemId } = await this.runInThread({
        goal: 'Continuation',
        prompt: '',
        isContinuation: true
      });
      return threadItemId;
    } catch (/** @type {any} */ err) {
      if (err.name !== 'AbortError') console.error('[continueInNewThread]', err);
      return null;
    }
  }

  /**
   * Bind a background task's output to this thread. The worker streams the
   * task's new stdout into this thread as turn-boundary messages — queued while
   * a turn is in flight, auto-waking the thread when idle — until the task exits
   * or is stopped.
   *
   * Generic: any plugin holding a background-task id (from the shell
   * run-in-background op) can request delivery; the Monitor tool is the first
   * consumer. Fire-and-forget — returns immediately and the binding outlives
   * this call; the underlying pendingRequest resolves only when the task ends,
   * which the caller does not await.
   *
   * The owning conversation id is stamped onto the request. The background-task
   * registry is process-global and keyed by task id alone, while this entry is
   * doc state that a clone (/duplicate, /handoff) inherits verbatim, so the
   * worker needs the stamp to tell "my own binding, re-adopt it after a
   * restart" from "a clone's inherited binding, leave the task to its owner"
   * (see deliveryIsForeign in cmd/juggler/worker/pending_requests.go).
   * @param {{taskId: string, label?: string}} opts - Task id and a display label shown with each batch.
   */
  requestTaskOutputDelivery({ taskId, label = '' }) {
    submitPendingRequest(this, 'deliverTaskOutput', (reqMap) => {
      reqMap.set('taskId', taskId);
      reqMap.set('label', label);
      reqMap.set('convId', this.conversation.id);
    }).catch(() => { /* fire-and-forget: cancellation/teardown is not an error here */ });
  }

  /**
   * Find this thread's `deliverTaskOutput` pendingRequests entry bound to a
   * given background-task id. Read-only — it never lazily creates the array
   * (unlike {@link ensurePendingRequests}), so it is safe to call from a render
   * path. O(n) over the small pending-requests queue.
   * @param {string} taskId - Background task id (from the shell run-in-background op).
   * @returns {any|null} The entry Y.Map, or null if no binding exists.
   */
  findTaskDeliveryEntry(taskId) {
    if (!taskId) return null;
    const requests = this.container.get('pendingRequests');
    if (!requests || typeof requests.length !== 'number') return null;
    for (let i = 0; i < requests.length; i++) {
      const entry = requests.get(i);
      if (!entry || typeof entry.get !== 'function') continue;
      if (entry.get('kind') !== 'deliverTaskOutput') continue;
      const req = entry.get('request');
      if (req?.get?.('taskId') === taskId) return entry;
    }
    return null;
  }

  /**
   * Live status of the background-output binding for `taskId`, derived purely
   * from the worker-maintained `deliverTaskOutput` entry status (reactive doc
   * state, NOT the originating tool-action's frozen outcome):
   *   - `requested`/`claimed` → `'active'` (pump running)
   *   - `cancelled` → `'stopped'` (killed)
   *   - `completed`/`error` → `'ended'` (exited on its own)
   * Returns null when no binding exists. Read-only — safe to call during render.
   * @param {string} taskId - Background task id.
   * @returns {'active'|'ended'|'stopped'|null} Binding status, or null.
   */
  getTaskDeliveryStatus(taskId) {
    const entry = this.findTaskDeliveryEntry(taskId);
    if (!entry) return null;
    switch (entry.get('status')) {
      case 'requested':
      case 'claimed':
        return 'active';
      case 'cancelled':
        return 'stopped';
      case 'completed':
      case 'error':
        return 'ended';
      default:
        return null;
    }
  }

  /**
   * Stop a running background-output binding: flip `cancelRequested` on its
   * `deliverTaskOutput` entry. The worker's pending-request loop observes the
   * flag, stops the pump, kills the task, and stamps the entry `cancelled`
   * (see `cancelPendingEntry` in `cmd/juggler/worker/pending_requests.go`) — so
   * the kill needs zero new worker code. Mirrors the abort path in
   * {@link submitPendingRequest}. No-op if the binding is missing or already
   * terminal. This is an action-site mutation (e.g. a Stop button click), never
   * called from a render path.
   * @param {string} taskId - Background task id.
   * @returns {boolean} True if a cancel was requested.
   */
  cancelTaskOutputDelivery(taskId) {
    const entry = this.findTaskDeliveryEntry(taskId);
    if (!entry) return false;
    const status = entry.get('status');
    if (status === 'completed' || status === 'error' || status === 'cancelled') return false;
    if (entry.get('cancelRequested')) return false;
    this.conversation.atomicUpdate(() => {
      entry.set('cancelRequested', true);
    });
    return true;
  }

  /**
   * Observe this thread's pendingRequests array, invoking `cb` on every entry
   * change (claim, completion, cancellation). Returns an unsubscribe function.
   * Used by UI that mirrors a `deliverTaskOutput` binding's live status without
   * polling. No-op (returns a no-op unsubscribe) when the array does not exist.
   * @param {() => void} cb - Called on any deep change to the array.
   * @returns {() => void} Unsubscribe function.
   */
  observePendingRequests(cb) {
    const requests = this.container.get('pendingRequests');
    if (!requests || typeof requests.observeDeep !== 'function') return () => {};
    requests.observeDeep(cb);
    return () => requests.unobserveDeep(cb);
  }

  /**
   * Summarise a compaction (/compact or /handoff) fold again.
   *
   * Only a fold has a summary worth regenerating. An ordinary thread's summary
   * is whatever its last run came to rest on, so a different summary is a
   * message away — ask, and the reply becomes the summary. A fold has no runs:
   * it is frozen transcript that the folded-compaction summariser summarised
   * once, with its own prompt, reading the thread's items as inert data.
   *
   * Routed straight to that summariser rather than through an ordinary turn,
   * which would append a "summarise this" instruction into the very transcript
   * being summarised. No-op on root and on anything that is not a fold.
   * @returns {Promise<void>}
   */
  async resummariseFold() {
    if (!this.threadItemId) return;
    if (this.container?.get?.('boundedCompaction') !== true) return;
    await workerManager.resummarizeCompactionThread(this.conversation.id, this.threadItemId);
  }

  /**
   * Clear conversational history (messages, tool actions, events) while
   * preserving sticky parent-level items the user can't delete — today just
   * the system-prompt placeholder (preventUserDeletion), which carries the
   * user's system prompt. Same blocklist-by-persistence rule as compact and
   * deleteUpTo/deleteAfter, so /clear can never wipe the system prompt.
   *
   * Wrapped in one transaction so the whole sweep is a single undo group and
   * one peer-sync event. The items observer resets processing state when only
   * preventUserDeletion items remain.
   */
  clearHistory() {
    this.cancelPendingApprovals();
    this.transact(() => this.deleteAfter(-1));
  }

  // ── Convenience (message creation + addEvent) ──────────────────────

  /**
   * Add an error message
   * @param {string} message - Error text
   */
  addErrorMessage(message) {
    if (message && message.trim()) {
      this.addEvent(createErrorMessage({ message }));
    }
  }

  /**
   * Add a user message
   * @param {string} text - User message text
   */
  addUserMessage(text) {
    this.addEvent(createUserMessage(text));
  }

  /**
   * Add a system-reminder message — a durable meta-instruction in the
   * conversation stream (the provider maps it to the user role). Strategies use
   * this (via injectGuidance) to steer a turn without authoring system-prompt
   * text. It persists in the doc, so it reaches the LLM on the production worker
   * path, not just the fallback.
   * @plugin-api
   * @param {string} content - Reminder text
   * @param {string} [source] - Optional provenance tag (e.g. 'strategy')
   */
  addSystemReminder(content, source) {
    if (content && content.trim()) {
      this.addEvent(createSystemReminderMessage({ content, source }));
    }
  }

  // ── Thread insertion ────────────────────────────────────────────────

  /**
   * Build a thread Y.Map with a pre-populated nested items array.
   * Call this inside a transact() block — it does not create its own transaction.
   * Use insertAt() to place the returned Y.Map in the items array.
   * @plugin-api
   * @param {object} threadData - Plain object from createThreadMessage()
   * @param {object[]} [initialItems] - Plain objects to pre-populate the thread's items array
   * @returns {*} Y.Map ready to pass to insertAt()
   */
  buildThreadYMap(threadData, initialItems = []) {
    const threadYMap = plainToYMap(threadData);
    const nestedArray = new Y.Array();
    for (const item of initialItems) {
      // Same invariant as addEvent, enforced by the same helper: every seeded
      // item is addressable by an itemId. Snapshots and fixed-id placeholders
      // (SYSTEM_1) already carry one; a freshly-created message (e.g.
      // compaction's summarization prompt) gets one minted here so it renders
      // with a real message-id and stays selectable/deletable.
      if (item && typeof item === 'object') this._ensureItemId(item);
      nestedArray.push([plainToYMap(item)]);
    }
    threadYMap.set('items', nestedArray);
    return threadYMap;
  }

  /**
   * Insert a thread item with a nested items Y.Array at a specific index, and
   * atomically seed any caller-supplied initial items in the SAME transaction.
   * A sub-thread is born EMPTY (no SYSTEM_1) unless the caller passes seed items
   * — its system prompt comes from the root thread at LLM-call time (see
   * buildThreadInitialItems). Thread, nested array, and any seed are one Yjs
   * transaction written by the creating client, so undo/redo/peer-sync all see
   * one atomic unit.
   * @param {number} index - Position to insert
   * @param {*} threadData - Thread message (plain object from createThreadMessage)
   * @param {object[]} [initialItems] - Extra items to seed after the built-ins
   * @returns {*} The nested Y.Array for the thread's child conversation
   */
  insertThread(index, threadData, initialItems = []) {
    const seed = contextItemHelpers.buildThreadInitialItems({ initialItems });
    /** @type {*} */
    let nestedItems = null;
    this.transact(() => {
      const ymap = this.buildThreadYMap(threadData, seed);
      this.ensureYarray().insert(index, [ymap]);
      nestedItems = ymap.get('items');
    });
    return nestedItems;
  }

  /**
   * Ergonomic chokepoint for creating a sub-thread: builds the thread message,
   * applies any extra fields, and inserts it atomically with its seeded initial
   * items via insertThread. This is the single front door for JS-side thread
   * creation — route new creation paths (commands, plugins) through it rather
   * than hand-assembling a thread message. Every thread is isolated; a sub-thread
   * is born empty and draws its system prompt from root at LLM-call time.
   * @plugin-api
   * @param {object} [opts]
   * @param {string} [opts.goal] - Thread goal/description
   * @param {object[]} [opts.initialItems] - Extra items to seed after the built-ins
   * @param {number} [opts.index] - Insert position (defaults to end)
   * @param {object} [opts.extra] - Additional fields merged onto the thread message (e.g. strategyCreated, draft)
   * @returns {{threadId: string, items: *}} The new thread's id and nested Y.Array
   */
  createSubThread({ goal = 'Thread', initialItems = [], index, extra = {} } = {}) {
    const threadData = createThreadMessage({ goal });
    Object.assign(threadData, extra);
    const items = this.insertThread(index ?? this.length, threadData, initialItems);
    return { threadId: /** @type {any} */ (threadData).itemId, items };
  }


  // ── Strategy ─────────────────────────────────────────────────────

  /**
   * Set the strategy for this message thread
   * @param {string} strategyId - Strategy ID to use
   */
  setStrategy(strategyId) {
    if (this.getEffectiveStrategyId() === strategyId) {
      // Already the effective strategy (own or inherited) — nothing to pin.
      return;
    }

    if (this.threadItemId) {
      // Sub-thread override — write to this thread's own Y.Map, mirroring the
      // per-thread modelConfig override. Tool evaluation mints a fresh
      // MessageThread that resolves this via getEffectiveStrategyId, so the
      // engine's approval gate (getApprovalPolicy) sees the sub-thread strategy.
      // No metadata observer fires for a thread-map write, so rebuild this
      // instance's strategy inline to keep the bound selector consistent.
      this.transact(() => {
        this.container.set('currentStrategyId', strategyId);
      });
      this.currentStrategyId = strategyId;
      this.strategy = strategyRegistry.createStrategy(strategyId, this);
      return;
    }

    // Root: pure metadata write — the metadata observer handles strategy
    // instance creation and notification.
    this.conversation.setMetadata('currentStrategyId', strategyId);
  }

  // ── Permissions ──────────────────────────────────────────────────
  // Generic rule storage + allowed-paths live in message-thread-permissions.js.
  // Per-plugin interpretation (glob matching, boolean flags, etc.) lives in
  // each context-item's own isPermitted / getApprovalSuggestions.

  /**
   * @returns {import('./message-thread-permissions.js').PermissionRule[]} All rules (flat)
   */
  getAllRules() { return permissionsHelpers.getAllRules(this); }

  /**
   * @param {string} itemType Owning context-item id
   * @returns {import('./message-thread-permissions.js').PermissionRule[]} Rules for this plugin
   */
  getRulesFor(itemType) { return permissionsHelpers.getRulesFor(this, itemType); }

  /**
   * @param {string} itemType Owning context-item id
   * @param {Partial<import('./message-thread-permissions.js').PermissionRule> & {kind: string, value: any}} rule New rule (id/enabled defaulted)
   * @returns {import('./message-thread-permissions.js').PermissionRule} The added or re-enabled rule
   */
  addRule(itemType, rule) { return permissionsHelpers.addRule(this, itemType, rule); }

  /**
   * @param {string} ruleId Rule id
   * @returns {boolean} true if a rule was removed
   */
  removeRule(ruleId) { return permissionsHelpers.removeRule(this, ruleId); }

  /**
   * @param {string} ruleId Rule id
   * @param {Partial<import('./message-thread-permissions.js').PermissionRule>} patch Partial update
   * @returns {boolean} true if the rule was found and updated
   */
  updateRule(ruleId, patch) { return permissionsHelpers.updateRule(this, ruleId, patch); }

  /**
   * @param {string} ruleId Rule id
   * @param {'session'|'conversation'} scope Target permission scope
   * @returns {boolean} true if moved or already in that scope
   */
  setRuleScope(ruleId, scope) { return permissionsHelpers.setRuleScope(this, ruleId, scope); }

  /** @param {string} itemType Owning context-item id */
  clearRules(itemType) { permissionsHelpers.clearRules(this, itemType); }

  /**
   * Return the owning plugin's permission scope policy.
   * @param {string} itemType Owning permission item type
   * @returns {{allowedScopes: Array<'session'|'conversation'>, defaultScope: 'session'|'conversation'}} Scope policy
   */
  getPermissionScopePolicy(itemType) {
    for (const { class: Klass } of contextItemRegistry.getAll()) {
      if (/** @type {any} */ (Klass).MANIFEST?.id !== itemType) continue;
      const policy = /** @type {any} */ (Klass).getPermissionScopePolicy?.();
      if (policy) return policy;
    }
    return { allowedScopes: ['session', 'conversation'], defaultScope: 'conversation' };
  }

  /**
   * The directory this conversation works in — its workspace root when bound to
   * one, the project path when not, and null when a binding cannot be honoured.
   * What a relative path is resolved against, and the radius a destructive
   * command is measured by.
   * @returns {string|null} Working root
   */
  getWorkingRoot() { return permissionsHelpers.getWorkingRoot(this); }

  /** @returns {import('./message-thread-permissions.js').AllowedPathEntry[]} Allowed path entries */
  getAllowedPathEntries() { return permissionsHelpers.getAllowedPathEntries(this); }

  /**
   * @returns {string[]} Allowed filesystem roots
   */
  getAllowedPaths() { return permissionsHelpers.getAllowedPaths(this); }

  /**
   * Explicit (user-added) allowed roots, WITHOUT the implicit project root.
   * Sent to read/search/tree backend ops, which are already rooted at the
   * server's live project path — see getExplicitAllowedPaths.
   * @returns {string[]} Explicit allowed roots
   */
  getExplicitAllowedPaths() { return permissionsHelpers.getExplicitAllowedPaths(this); }

  /** @param {string[]} paths New allowed-paths list */
  setAllowedPaths(paths) { permissionsHelpers.setAllowedPaths(this, paths); }

  /**
   * @param {string} p Path to add
   * @param {{scope?: 'session'|'conversation'}} [options]
   * @returns {boolean} true if added (false if already present)
   */
  addAllowedPath(p, options) { return permissionsHelpers.addAllowedPath(this, p, options); }

  /**
   * @param {string} p Path or id to remove
   * @returns {boolean} true if removed
   */
  removeAllowedPath(p) { return permissionsHelpers.removeAllowedPath(this, p); }

  /**
   * @param {string} oldPath Existing entry path or id
   * @param {string} newPath Replacement value
   * @returns {boolean} true if the entry was found and updated
   */
  updateAllowedPath(oldPath, newPath) { return permissionsHelpers.updateAllowedPath(this, oldPath, newPath); }

  /**
   * @param {string} idOrPath Path entry id or path string
   * @param {'session'|'conversation'} scope Target permission scope
   * @returns {boolean} true if moved or already in that scope
   */
  setAllowedPathScope(idOrPath, scope) { return permissionsHelpers.setAllowedPathScope(this, idOrPath, scope); }

  // ── Context items ──────────────────────────────────────────────────
  // CRUD and lifecycle live in message-thread-context-items.js.

  /** @returns {import('juggler/context-item').default[]} Context items */
  get contextItems() { return contextItemHelpers.getContextItems(this); }

  /**
   * @plugin-api
   * @param {string} itemId
   * @returns {import('juggler/context-item').default|undefined} Context item instance
   */
  getContextItem(itemId) { return contextItemHelpers.getContextItem(this, itemId); }

  /**
   * @plugin-api
   * @param {import('juggler/context-item').default} contextItem
   */
  addContextItem(contextItem) { contextItemHelpers.addContextItem(this, contextItem); }

  /**
   * @plugin-api
   * @param {string} itemId
   */
  removeContextItem(itemId) { contextItemHelpers.removeContextItem(this, itemId); }

  clearContextItems() { contextItemHelpers.clearContextItems(this); }

  /**
   * @plugin-api
   * @param {string} itemId
   * @param {{data?: object}} updates
   */
  updateContextItem(itemId, updates) { contextItemHelpers.updateContextItem(this, itemId, updates); }

  /**
   * @plugin-api
   * @param {string} itemTypeId
   * @param {Record<string, any>} params
   * @param {object} [options]
   * @returns {Promise<{id: string|null, type: string, created: boolean, error?: string}>} Result
   */
  async executeContextItem(itemTypeId, params, options) {
    return contextItemHelpers.executeContextItem(this, itemTypeId, params, options);
  }

  /**
   * Execute a context item and enqueue its message onto this thread's
   * `pendingItems` queue instead of the committed `items` array. Used for
   * at-mention / dropped-file reads that accompany a message being QUEUED while a
   * turn is in flight, so the worker promotes the reads together with the
   * message (see {@link enqueuePendingItem}).
   * @plugin-api
   * @param {string} itemTypeId
   * @param {Record<string, any>} params
   * @returns {Promise<{id: string|null, type: string, created: boolean, error?: string}>} Result
   */
  async executeContextItemIntoPending(itemTypeId, params) {
    return contextItemHelpers.executeContextItemIntoPending(this, itemTypeId, params);
  }

  /**
   * @param {string} itemId
   * @returns {Promise<void>}
   */
  async refreshContextItem(itemId) {
    return contextItemHelpers.refreshContextItem(this, itemId);
  }

  initBuiltInContextItems() { contextItemHelpers.initBuiltInContextItems(this); }

  ensureSystemPromptPlaceholder() { contextItemHelpers.ensureSystemPromptPlaceholder(this); }

  /**
   * @param {string} itemId
   * @param {import('juggler/context-item').default} [changedItem]
   * @returns {Promise<void>}
   */
  async _handleContextItemContentChanged(itemId, changedItem) {
    return contextItemHelpers.handleContextItemContentChanged(this, itemId, changedItem);
  }

  /** @returns {Promise<Set<string>>} Set of new context item IDs */
  async _refreshContextItemsAndDetectChanges() {
    return contextItemHelpers.refreshContextItemsAndDetectChanges(this);
  }

}

/**
 * Create a message thread for a column.
 * Both `container` and `threadItemId` are required; passing either as falsy throws.
 * @param {import('./conversation.js').default} conversation
 * @param {*} container - Y.Map container for the thread
 * @param {string} threadItemId - Thread item ID
 * @returns {MessageThread} Column-scoped message thread
 */
export function createMessageThread(conversation, container, threadItemId) {
  if (!container || !threadItemId) {
    throw new Error(`createMessageThread requires both container and threadItemId (got container=${!!container}, threadItemId=${!!threadItemId})`);
  }
  return new MessageThread(conversation, container, threadItemId);
}

export { MessageThread };
