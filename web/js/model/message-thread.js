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
import {
  createToolActionMessage,
  createErrorMessage,
  createUserMessage,
  createSystemReminderMessage,
  createThreadMessage,
  TOOL_STATES,
  ACTION_STATES,
  isToolActionMessage,
  isAssistantMessage,
  isUserMessage,
  isThreadMessage
} from '../../sdk/lib/message.js';
import strategyRegistry from '../registries/strategy-registry.js';
import contextItemRegistry from '../registries/context-item-registry.js';
import workerManager from '../services/worker-manager.js';
import { submitPendingRequest } from '../services/thread-orchestrator.js';
import * as permissionsHelpers from './message-thread-permissions.js';
import * as contextItemHelpers from './message-thread-context-items.js';
import { isThreadClosed } from './thread-navigation.js';
import { recordTape } from '../utils/event-tape.js';
import { normalizeDraft, normalizeAttachments, normalizeTextFiles } from '../utils/attachments.js';

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

    /** @type {number|null} */
    this.contextWindow = null;

    /** @type {boolean} @private */
    this._systemPromptPlaceholderEnsured = false;
  }

  /** @returns {string} Conversation ID (stable identifier for dedup/tracking) */
  get conversationId() { return this.conversation.id; }

  /** @returns {boolean} Whether conversation is currently processing */
  get isProcessing() { return this.conversation.isProcessing; }

  /**
   * Whether this thread is closed (genuinely finished). Derived via the shared
   * isThreadClosed predicate — a non-empty `result` AND no live (non-terminal)
   * tool anywhere in the subtree — so the footer's Reopen/Continue agrees with
   * the tile colour and input-box placement. Root is never closed.
   * @returns {boolean} Whether this thread is closed
   */
  get isClosed() {
    if (!this.threadItemId) return false;
    return isThreadClosed(this.container);
  }

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
      const meta = this.conversation._doc.metadata;
      const config = meta.get('defaultModelConfig');
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
      this.conversation._doc.setMetadata('defaultModelConfig', value);
    } else {
      const doc = this.conversation._doc.doc;
      doc.transact(() => {
        if (value === null || value === undefined) {
          this.container.delete('modelConfig');
        } else {
          this.container.set('modelConfig', convertToYType(value));
        }
      }, this.conversation._doc.authorId);
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
    const config = this.conversation._doc.metadata.get('defaultModelConfig');
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
    const meta = this.conversation._doc.metadata.get('currentStrategyId');
    return meta ? /** @type {string} */ (meta) : 'default';
  }

  /**
   * The unsent input-box draft for this thread — its text, its staged image
   * attachments, AND any dropped text files, as a single
   * `{text, attachments, textFiles}` record. Stored on the thread container
   * (sub-threads) or conversation metadata (root). Because every part is one
   * persisted object, a quit/restart restores the whole draft or nothing:
   * "text kept, attachments/text-files lost" is not expressible. See
   * utils/attachments.normalizeDraft.
   * @returns {import('../utils/attachments.js').Draft} The draft text, attachments, and text files.
   */
  get draft() {
    const raw = this.threadItemId
      ? this.container.get('draft')
      : this.conversation._doc.metadata.get('draft');
    return normalizeDraft(raw);
  }

  /**
   * @param {{text?: string, attachments?: import('../utils/attachments.js').AssetRef[], textFiles?: import('../utils/attachments.js').TextFileSnapshot[], scheduledSendAt?: number|null}|null} value
   */
  set draft(value) {
    const text = (value && typeof value.text === 'string') ? value.text : '';
    const attachments = normalizeAttachments(value && value.attachments);
    const textFiles = normalizeTextFiles(value && value.textFiles);
    const rawWhen = value && value.scheduledSendAt;
    const scheduledSendAt = (typeof rawWhen === 'number' && Number.isFinite(rawWhen)) ? rawWhen : null;
    // A pending scheduled send keeps the draft alive even with no text/
    // attachments — the timer must survive a reload to fire on an empty box.
    const empty = !text && attachments.length === 0 && textFiles.length === 0 && scheduledSendAt === null;
    /** @type {{text: string, attachments: import('../utils/attachments.js').AssetRef[], textFiles: import('../utils/attachments.js').TextFileSnapshot[], scheduledSendAt?: number}} */
    const record = { text, attachments, textFiles };
    if (scheduledSendAt !== null) record.scheduledSendAt = scheduledSendAt;
    if (this.threadItemId) {
      const doc = this.conversation._doc.doc;
      doc.transact(() => {
        if (empty) {
          this.container.delete('draft');
        } else {
          this.container.set('draft', convertToYType(record));
        }
      }, this.conversation._doc.authorId);
    } else {
      // Root: conversation metadata. No metadata-delete exists, so an empty
      // draft is stored as the empty record (matching the prior empty-string
      // behaviour) rather than deleted.
      this.conversation._doc.setMetadata('draft', empty ? { text: '', attachments: [], textFiles: [] } : record);
    }
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
      const doc = this.conversation._doc.doc;
      arr = new Y.Array();
      doc.transact(() => {
        this.container.set('items', arr);
      }, this.conversation._doc.authorId);
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
   * Get the queued (pending) messages for this thread — messages typed while a
   * turn was in flight, parked in a `pendingItems` Y.Array that is a sibling of
   * `items` on this container (worker-owned; see worker/pending_items.go). They
   * are NOT part of the conversation or the LLM context until the worker promotes
   * them at a turn boundary. Mirrors `items`: filters out corrupt non-Y.Map entries.
   * @returns {Array<any>} Pending user-message Y.Maps (empty if none queued)
   */
  get pendingItems() {
    const arr = this.container.get('pendingItems');
    if (!arr) return [];
    return filterCorruptItems(arr.toArray(), 'pending item');
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
    for (const m of this.items) {
      // Tool-action: APPROVED (ready to claim) or RUNNING (claimed,
      // executing) means work is in flight.
      if (isToolActionMessage(/** @type {Message} */ (m))) {
        const state = m.get('state');
        if (state === TOOL_STATES.APPROVED || state === TOOL_STATES.RUNNING) {
          return true;
        }
      }
      // Thread: result=null means sub-thread not done
      if (isThreadMessage(/** @type {Message} */ (m))) {
        const result = m.get('result');
        if (result === null || result === undefined || result === '') {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Check if there are other incomplete tool-actions in the same batch.
   * A "batch" is all tool-actions since the last assistant text message.
   * @param {string} excludeToolUseId - Tool use ID to exclude from check
   * @returns {boolean} True if other incomplete actions exist (pending or cancelled)
   */
  hasOtherIncompleteActionsInBatch(excludeToolUseId) {
    let toolIdx = -1;
    for (let i = 0; i < this.items.length; i++) {
      const item = /** @type {Message} */ (this.items[i]);
      if (isToolActionMessage(item) && item.get('toolUseId') === excludeToolUseId) {
        toolIdx = i;
        break;
      }
    }

    let lastAssistantIdx = -1;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = /** @type {Message} */ (this.items[i]);
      if (isAssistantMessage(item) && item.get('content')) {
        lastAssistantIdx = i;
        break;
      }
    }

    if (toolIdx !== -1 && lastAssistantIdx !== -1 && toolIdx < lastAssistantIdx) {
      return true;
    }

    for (let i = lastAssistantIdx + 1; i < this.items.length; i++) {
      const item = /** @type {Message} */ (this.items[i]);
      if (isToolActionMessage(item)) {
        if (item.get('toolUseId') !== excludeToolUseId) {
          const result = item.get('result');
          if (result === null || result === undefined) return true;
          const cancelled = result.get ? result.get('cancelled') : result.cancelled;
          if (cancelled) return true;
        }
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
   * @plugin-api
   * @param {string} id
   * @returns {boolean} true if the item was found and deleted
   */
  deleteItemById(id) {
    const index = this.findIndexByItemId(id);
    if (index < 0) return false;
    this.deleteAt(index);
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
        const doc = this.conversation._doc.doc;
        doc.transact(() => { pendingArr.delete(idx, 1); }, this.conversation._doc.authorId);
        return true;
      }
    }
    return this.deleteItemById(id);
  }

  /**
   * Delete all user-deletable items before the given index.
   * Skips items with preventUserDeletion. Iterates in reverse to preserve indices.
   * @param {number} index - Items before this index are deleted
   */
  deleteUpTo(index) {
    const items = this.items;
    for (let i = index - 1; i >= 0; i--) {
      if (!items[i]?.get('preventUserDeletion')) {
        this.deleteAt(i);
      }
    }
  }

  /**
   * Delete all user-deletable items after the given index (exclusive).
   * Skips items with preventUserDeletion. Iterates in reverse to preserve indices.
   * @param {number} index - Items after this index are deleted
   */
  deleteAfter(index) {
    const items = this.items;
    for (let i = items.length - 1; i > index; i--) {
      if (!items[i]?.get('preventUserDeletion')) {
        this.deleteAt(i);
      }
    }
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
   */
  deleteRange(fromIndex) {
    if (fromIndex < 0 || fromIndex >= this.items.length) return;

    const arr = this.ensureYarray();
    const deleteCount = arr.length - fromIndex;
    if (deleteCount > 0) {
      arr.delete(fromIndex, deleteCount);
    }
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
   * This is the public API for plugins that need atomic multi-step mutations.
   * @plugin-api
   * @param {() => void} fn - Function to execute inside the transaction
   */
  transact(fn) {
    const cdoc = this.conversation._doc;
    cdoc.doc.transact(fn, cdoc.authorId);
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
      // A sub-thread carries NO SYSTEM_1: its system prompt is sourced from the
      // root thread at LLM-call time. (Legacy docs may still hold one; this
      // invariant guards freshly-created threads, which assertInvariants runs on.)
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
    const doc = this.conversation._doc.doc;
    doc.transact(() => {
      const ymap = yarray.get(index);
      if (ymap instanceof Y.Map) {
        ymap.set(field, convertToYType(value));
      }
    }, this.conversation._doc.authorId);
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
      const doc = this.conversation._doc.doc;
      const finalState = result.cancelled ? TOOL_STATES.CANCELLED : TOOL_STATES.COMPLETED;
      // Set state and result atomically so the observer (and the Go worker)
      // never see state=completed/cancelled without a result, or vice versa.
      doc.transact(() => {
        const ymap = yarray.get(index);
        if (ymap instanceof Y.Map) {
          ymap.set('state', finalState);
          ymap.set('result', convertToYType(result));
          // Promote displayData from fullResult onto the YMap so the properties
          // panel can render diffs for auto-approved actions (where the approval
          // flow never sets displayData on the YMap directly).
          if (result.fullResult?.displayData && !ymap.get('displayData')) {
            ymap.set('displayData', convertToYType(result.fullResult.displayData));
          }
        }
      }, this.conversation._doc.authorId);
    }
  }

  /**
   * Update the lifecycle state of a tool action.
   * @param {string} toolUseId
   * @param {import('../../sdk/lib/message.js').ToolState} state
   * @param {{ifState?: string}} [options] - Optional CAS on current state
   */
  updateToolActionState(toolUseId, state, { ifState } = {}) {
    const doc = this.conversation._doc.doc;
    doc.transact(() => {
      const items = this.items;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (isToolActionMessage(/** @type {Message} */ (item)) && item.get('toolUseId') === toolUseId) {
          if (ifState !== undefined && (item.get('state') ?? '') !== ifState) break;
          item.set('state', state);
          break;
        }
      }
    }, this.conversation._doc.authorId);
  }

  /**
   * Cancel all pending approvals.
   */
  cancelPendingApprovals() {
    const pendingMessages = this.getPendingApprovalMessages();
    for (const toolUse of pendingMessages) {
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
   * @param {{approvalRules?: Array<{kind: string, value: any, scope?: string}>, approvalAllowedPaths?: string[], approvalItemType?: string}} [extra]
   *   For 'yes-always': the exact permission rules (and owning itemType) and/or
   *   the allowed-paths roots the chosen suggestion should persist. Omit for a
   *   bare 'yes-always' — the framework then derives the grant from the plugin's
   *   narrowest `getApprovalSuggestions` entry.
   */
  resolveApproval(toolUseId, response, extra = {}) {
    const message = this.getToolAction(toolUseId);
    if (!message || message.get('state') !== TOOL_STATES.PENDING) return;

    recordTape('approval', this.conversationId, { toolUseId, response });

    const isCancel = response === 'no' || response === 'cancel';
    // Write APPROVED (not RUNNING): the frontend reducer atomically claims
    // APPROVED → RUNNING and then launches execution. Writing RUNNING directly
    // would skip the claim and re-fire on every displayData tick.
    const newState = isCancel ? TOOL_STATES.CANCELLED : TOOL_STATES.APPROVED;

    const messageToolUseId = message.get('toolUseId');
    const yarray = this.ensureYarray();
    const index = this.items.findIndex(item => item.get('toolUseId') === messageToolUseId);
    if (index < 0 || index >= yarray.length) return;

    // Write state + result in a single transaction so the Go worker never sees
    // state=cancelled without a result (races checkToolsComplete otherwise).
    const doc = this.conversation._doc.doc;
    doc.transact(() => {
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
    }, this.conversation._doc.authorId);
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
   * @returns {Promise<void>}
   */
  async continue() {
    return this.conversation.continueThread(this);
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
   * @param {{goal: string, prompt: string, isContinuation?: boolean, signal?: AbortSignal|null, strategyId?: string, modelConfig?: object|null}} options
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
   * @param {{taskId: string, label?: string}} opts - Task id and a display label shown with each batch.
   */
  requestTaskOutputDelivery({ taskId, label = '' }) {
    submitPendingRequest(this, 'deliverTaskOutput', (reqMap) => {
      reqMap.set('taskId', taskId);
      reqMap.set('label', label);
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
   * Whether this open thread can be closed by promoting its last message as
   * the result — i.e. the last effective item (user / assistant / tool-action
   * / nested thread) is a non-empty assistant message. Mirrors the worker's
   * selectThreadFallbackResult so the "Close with last message" footer button
   * appears only when that cheap, no-LLM-turn close will actually succeed.
   * @returns {boolean} True if the thread can be closed with its last message
   */
  get canCloseWithLastMessage() {
    if (!this.threadItemId) return false;
    const items = this.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const m = /** @type {Message} */ (items[i]);
      if (isAssistantMessage(m)) return !!m.get('content');
      if (isUserMessage(m) || isToolActionMessage(m) || isThreadMessage(m)) return false;
      // thinking / context items don't encode the resting state — keep scanning.
    }
    return false;
  }

  /**
   * Close this thread immediately by promoting its trailing assistant message
   * as the result — the cheap, no-LLM-turn close. The worker stamps that text
   * as the thread result, making isClosed true so the input box returns to the
   * parent. No-op if there is no clean trailing assistant reply to promote.
   * @returns {Promise<boolean>} True if the thread was closed
   */
  async closeWithLastMessage() {
    if (!this.threadItemId) return false;
    return await workerManager.closeThreadWithLastMessage(this.conversation.id, this.threadItemId);
  }

  /**
   * Close this thread by asking the LLM to generate a summary and call
   * return_result.
   *
   * Preempts any in-flight turn first (worker-truth cancel+settle) so the
   * summary prompt is never silently dropped by sendMessage's "already
   * processing" guard.
   * @param {string} [summaryText] - Optional user-supplied summary context. When
   *   present it is woven into the prompt; otherwise the LLM auto-summarises.
   * @returns {Promise<void>}
   */
  async close(summaryText) {
    if (!this.threadItemId) return;
    const userText = (summaryText || '').trim();
    const message = userText
      ? `${userText}\n\nAfter responding, call return_result with a concise summary of what was accomplished in its "result" argument.`
      : 'Summarize what was accomplished in this thread concisely, then call return_result with that summary in its "result" argument.';
    await this.conversation.sendMessage(message, this.threadItemId, this, { preemptProcessing: true });
  }

  /**
   * Re-generate this thread's summary: clear the existing result, then re-run
   * the return_result strategy over the thread's current items.
   *
   * The summary is an explicit authored artifact — item edits never change it
   * automatically (only reopen() clears it). This is the explicit "regenerate"
   * lever, alongside hand-editing the Result block and promoting a message via
   * "Use as thread summary". No-op on root.
   * @returns {Promise<void>}
   */
  async resummarize() {
    if (!this.threadItemId) return;
    // Clear the result first (worker-authored so it stays undoable), then ask
    // the LLM to summarise afresh. close() preempts/settles before sending.
    await workerManager.reopenThread(this.conversation.id, this.threadItemId);
    await this.close();
  }

  /**
   * Reopen a closed thread by clearing its result.
   * Routed through Go so the null item has Go's clientID, which is required
   * for the UndoManager's RedoItem to succeed when undoing the clear.
   */
  reopen() {
    if (!this.threadItemId) return;
    workerManager.reopenThread(this.conversation.id, this.threadItemId);
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
    const doc = this.conversation._doc.doc;
    /** @type {*} */
    let nestedItems = null;
    doc.transact(() => {
      const ymap = this.buildThreadYMap(threadData, seed);
      this.ensureYarray().insert(index, [ymap]);
      nestedItems = ymap.get('items');
    }, this.conversation._doc.authorId);
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
      const doc = this.conversation._doc.doc;
      doc.transact(() => {
        this.container.set('currentStrategyId', strategyId);
      }, this.conversation._doc.authorId);
      this.currentStrategyId = strategyId;
      this.strategy = strategyRegistry.createStrategy(strategyId, this);
      return;
    }

    // Root: pure metadata write — the metadata observer handles strategy
    // instance creation and notification.
    this.conversation._doc.setMetadata('currentStrategyId', strategyId);
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
