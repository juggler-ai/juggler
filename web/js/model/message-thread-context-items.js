//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Context-item lifecycle extracted from MessageThread. Pure-function helpers
 * that take the MessageThread instance (`mt`) as first argument. The class
 * methods become one-line delegators.
 * @module model/message-thread-context-items
 */

import { plainToYMap, convertToYType, yGetRecord, isItemView } from './item-accessor.js';
import { createContextItemMessage } from '../../sdk/lib/message.js';
import contextItemRegistry from '../registries/context-item-registry.js';
import workerManager from '../services/worker-manager.js';

/**
 * @typedef {import('./message-thread.js').default} MessageThread
 * @typedef {import('juggler/context-item').default} ContextItem
 * @typedef {{id: string, type: string, data: Record<string, unknown>}} ContextItemDescriptor
 */

/**
 * Derive the `{id, type, data}` descriptor for a context item from a thread
 * item Y.Map, or null if the item is not a context item. Context items live
 * as standalone item Y.Maps (`itemId`, no `toolUseId`).
 * @param {unknown} item - Thread item Y.Map
 * @param {string} [wantId] - If set, only match a context item with this id
 * @returns {ContextItemDescriptor|null} Descriptor, or null if not a context item
 */
function contextItemDescriptor(item, wantId) {
  if (!isItemView(item)) return null;
  const id = item.get('itemId');
  if (id && !item.get('toolUseId')) {
    if (wantId !== undefined && id !== wantId) return null;
    return {
      id,
      type: item.get('type') || 'unknown',
      data: yGetRecord(item, 'data') ?? {}
    };
  }
  return null;
}

/**
 * Instantiate a context item from its descriptor and wire its change handler.
 * @param {MessageThread} mt - MessageThread instance
 * @param {ContextItemDescriptor} descriptor
 * @returns {import('juggler/context-item').default|null} Instantiated item, or null if creation failed
 */
function instantiateContextItem(mt, descriptor) {
  const contextItem = contextItemRegistry.createItem(descriptor, mt.conversation._session, mt.conversation, mt);
  if (contextItem) {
    contextItem.onContentChange = () => {
      handleContextItemContentChanged(mt, contextItem.id, contextItem);
    };
  }
  return contextItem;
}

/**
 * Read context items from the thread's items array. Instances are
 * transient wrappers around CRDT data — fresh objects on every call.
 * @param {MessageThread} mt - MessageThread instance
 * @returns {import('juggler/context-item').default[]} Context items
 */
export function getContextItems(mt) {
  const contextItems = [];
  for (const item of mt.items) {
    const descriptor = contextItemDescriptor(item);
    if (!descriptor) continue;
    try {
      const contextItem = instantiateContextItem(mt, descriptor);
      if (contextItem) contextItems.push(contextItem);
    } catch {
      // Ignore context items that fail to load
    }
  }
  // Pin system-positioned items (system prompt, memory, skills) to the front.
  // Keyed on contextPosition, NOT preventUserDeletion: the latter means only
  // "the user can't delete this" (system prompt alone), and must not double as
  // the display-ordering signal.
  const isSystemPositioned = (/** @type {ContextItem} */ ci) =>
    /** @type {typeof import('juggler/context-item').default} */ (ci.constructor).MANIFEST?.contextPosition === 'system';
  contextItems.sort(
    (a, b) => (isSystemPositioned(b) ? 1 : 0) - (isSystemPositioned(a) ? 1 : 0)
  );
  return contextItems;
}

/**
 * @param {MessageThread} mt
 * @param {string} itemId
 * @returns {import('juggler/context-item').default|undefined} Context item instance
 */
export function getContextItem(mt, itemId) {
  for (const item of mt.items) {
    const descriptor = contextItemDescriptor(item, itemId);
    if (!descriptor) continue;
    try {
      const contextItem = instantiateContextItem(mt, descriptor);
      if (contextItem) return contextItem;
    } catch {
      // Ignore context items that fail to load
    }
  }
  return undefined;
}

/**
 * @param {MessageThread} mt
 * @param {import('juggler/context-item').default} contextItem
 */
export function addContextItem(mt, contextItem) {
  if (!contextItem || typeof contextItem.toJSON !== 'function') {
    console.error(`[ESSENTIAL] [MessageThread] Attempted to add invalid context item: ${JSON.stringify(contextItem)}`);
    throw new Error('Cannot add context item: not a valid ContextItem instance');
  }
  const itemJSON = contextItem.toJSON();
  const items = mt.items;
  const existingIndex = items.findIndex(
    item => item.get('itemId') === contextItem.id
  );
  if (existingIndex >= 0) {
    const ymap = items[existingIndex];
    mt.conversation.atomicUpdate(() => {
      ymap.set('type', itemJSON.type);
      if (itemJSON.data !== undefined) ymap.set('data', convertToYType(itemJSON.data));
    });
  } else {
    const newMsg = createContextItemMessage({
      itemId: contextItem.id,
      isNew: true,
      itemType: itemJSON.type,
      data: itemJSON.data
    });
    mt.insertAt(mt.length, plainToYMap(newMsg));
  }
}

/**
 * @param {MessageThread} mt
 * @param {string} itemId
 */
export function removeContextItem(mt, itemId) {
  const contextItem = getContextItem(mt, itemId);
  if (!contextItem) {
    throw new Error(`Context item not found: ${itemId}`);
  }
  if (contextItem.preventUserDeletion()) {
    throw new Error(`Cannot delete context item: ${contextItem.type}`);
  }
  // User-deleting a context item is its own logical undo step. Force a
  // fresh undo group on the worker so undo doesn't unexpectedly reverse
  // an unrelated mutation that happened in the prior capture window.
  workerManager.stopUndoCapturing(mt.conversation.id);
  const itemIndex = mt.findIndexByItemId(itemId);
  if (itemIndex >= 0) {
    mt.conversation.atomicUpdate(() => {
      mt.deleteAt(itemIndex);
    });
  }
  if (contextItem.destroy) {
    contextItem.destroy();
  }
}

/**
 * @param {MessageThread} mt
 */
export function clearContextItems(mt) {
  const contextItems = getContextItems(mt);
  for (const item of contextItems) {
    if (item.destroy) {
      item.destroy();
    }
  }
  const items = mt.items;
  /** @type {number[]} */
  const itemIndices = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].get('itemId') && !items[i].get('toolUseId')) {
      itemIndices.push(i);
    }
  }
  mt.conversation.atomicUpdate(() => {
    for (const index of [...itemIndices].reverse()) {
      mt.deleteAt(index);
    }
  });
}

/**
 * @param {MessageThread} mt
 * @param {string} itemId
 * @param {{data?: object}} updates
 */
export function updateContextItem(mt, itemId, updates) {
  const ymap = mt.findByItemId(itemId);
  if (!ymap) return;
  mt.conversation.atomicUpdate(() => {
    if (updates.data !== undefined) {
      const mergedData = { ...(yGetRecord(ymap, 'data') ?? {}), ...updates.data };
      ymap.set('data', convertToYType(mergedData));
    }
  });
}

/**
 * @param {MessageThread} mt
 * @param {string} itemTypeId
 * @param {Record<string, unknown>} params
 * @param {object} [options]
 * @returns {Promise<{id: string|null, type: string, created: boolean, error?: string}>} Result
 */
export async function executeContextItem(mt, itemTypeId, params, options) {
  const { executeContextItem: exec } = await import('../services/context-item-utilities.js');
  return exec(mt, mt.conversation, itemTypeId, params, options);
}

/**
 * @param {MessageThread} mt
 * @param {string} itemTypeId
 * @param {Record<string, unknown>} params
 * @returns {Promise<{id: string|null, type: string, created: boolean, error?: string}>} Result
 */
export async function executeContextItemIntoPending(mt, itemTypeId, params) {
  const { executeContextItemIntoPending: exec } = await import('../services/context-item-utilities.js');
  return exec(mt, mt.conversation, itemTypeId, params);
}

/**
 * @param {MessageThread} mt
 * @param {string} itemId
 * @returns {Promise<void>}
 */
export async function refreshContextItem(mt, itemId) {
  const { refreshContextItem: refresh } = await import('../services/context-item-utilities.js');
  return refresh(mt, mt.conversation, itemId);
}

/**
 * The single factory for the SYSTEM_1 system-prompt placeholder message — one
 * source of truth for its shape, shared by every thread-initialization path.
 * @returns {object} Plain context-item message for SYSTEM_1
 */
function createSystemPromptPlaceholder() {
  return createContextItemMessage({
    itemId: 'SYSTEM_1',
    isNew: false,
    itemType: 'system-prompt',
    data: { text: '', selectedPresetId: 'default', isModified: false },
    preventUserDeletion: true
  });
}

/**
 * Compose the ordered list of items a newly-created SUB-THREAD should be seeded
 * with — just the caller-supplied `initialItems`, nothing built-in.
 *
 * A sub-thread's starting context (system prompt, agents files, memory) is
 * cloned from its PARENT by the worker — eagerly in createThread and lazily on
 * first turn for client-created threads (SeedThreadFromParent /
 * SeedThreadIfUnseeded in cmd/juggler/worker). The clone is a full system-prompt
 * item with a FRESH id (never the canonical SYSTEM_1, which stays root-only via
 * initBuiltInContextItems / ensureSystemPromptPlaceholder). So this JS helper
 * seeds nothing built-in itself — the worker is the single owner of the seed
 * predicate — but is kept as the single seam JS thread-creation routes through,
 * so a future JS-side built-in seed has one home.
 * @param {{initialItems?: object[]}} [opts]
 * @returns {object[]} Plain messages to insert into the new thread, in order
 */
export function buildThreadInitialItems({ initialItems = [] } = {}) {
  return [...initialItems];
}

/**
 * Initialize built-in context items (system prompt). Called once by the
 * creating client on new conversation creation.
 * @param {MessageThread} mt
 */
export function initBuiltInContextItems(mt) {
  mt.insertAt(0, plainToYMap(createSystemPromptPlaceholder()));
  mt._systemPromptPlaceholderEnsured = true;
}

/**
 * Ensure the root system-prompt placeholder exists. Used only by the creating
 * client's new-conversation flow (no-op if SYSTEM_1 is already present). Sub-
 * threads do NOT use this — they are seeded atomically at creation.
 * @param {MessageThread} mt
 */
export function ensureSystemPromptPlaceholder(mt) {
  if (mt._systemPromptPlaceholderEnsured) return;
  mt._systemPromptPlaceholderEnsured = true;
  if (!mt.findByItemId('SYSTEM_1')) {
    mt.insertAt(0, plainToYMap(createSystemPromptPlaceholder()));
  }
}

/**
 * @param {MessageThread} mt
 * @param {string} itemId
 * @param {import('juggler/context-item').default} [changedItem]
 * @returns {Promise<void>}
 */
export async function handleContextItemContentChanged(mt, itemId, changedItem) {
  const { handleContextItemContentChanged: handle } = await import('../services/context-item-utilities.js');
  return handle(mt, mt.conversation, itemId, changedItem);
}

/**
 * @param {MessageThread} mt
 * @returns {Promise<Set<string>>} Set of new context item IDs
 */
export async function refreshContextItemsAndDetectChanges(mt) {
  const { refreshContextItemsAndDetectChanges: refresh } = await import('../services/context-item-utilities.js');
  return refresh(mt);
}
