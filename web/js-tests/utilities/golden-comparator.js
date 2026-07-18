//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Golden Comparator - Document snapshot normalization and comparison
 *
 * Normalizes document state for deterministic golden data comparison.
 * Replaces non-deterministic fields (IDs, timestamps) with placeholders.
 * @module integration/golden-comparator
 */



/**
 * @typedef {object} NormalizedItem
 * @property {string} type - Item type
 * @property {string} [content] - Content (for user/assistant messages)
 * @property {string} [toolUseId] - Normalized tool use ID ($TOOL_1, etc.)
 * @property {string} [toolName] - Tool name
 * @property {Record<string, any>} [toolInput] - Tool input parameters
 * @property {string} [state] - Tool lifecycle state
 * @property {{content: string, isError: boolean, contextItemId?: string}|string} [result] - Tool result (normalized) or thread result string
 * @property {string} [itemId] - Normalized item ID ($ITEM_1, etc.)
 * @property {string} [message] - Error message text (for error items)
 */

/**
 * @typedef {object} DocumentSnapshot
 * @property {NormalizedItem[]} items - Normalized items
 * @property {Record<string, any>} [metadata] - Relevant metadata
 */

/**
 * Raw item from conversation (Y.Map)
 * @typedef {import('../../model/message.js').YMapItem & {type: string, content?: string, toolUseId?: string, toolName?: string, toolInput?: object|string, state?: string, result?: object|string|null, itemId?: string, contextItemId?: string, data?: object, message?: string}} RawItem
 */

/**
 * Raw context item data from Yjs
 * @typedef {object} RawContextItemData
 * @property {string} id - Context item ID
 * @property {string} type - Context item type
 * @property {object} data - Context item data
 */

/**
 * Sort object keys recursively for deterministic JSON serialization.
 * @param {any} obj - Object to sort
 * @returns {any} Object with sorted keys
 */
function sortObjectKeys(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }
  /** @type {Record<string, any>} */
  const sorted = {};
  const keys = Object.keys(obj).sort();
  for (const key of keys) {
    sorted[key] = sortObjectKeys(obj[key]);
  }
  return sorted;
}

/**
 * ID normalization context for consistent mapping across a snapshot.
 */
class IdNormalizer {
  constructor() {
    /** @type {Map<string, string>} @private */
    this._toolIdMap = new Map();
    /** @type {number} @private */
    this._toolCounter = 0;

    /** @type {Map<string, string>} @private */
    this._itemIdMap = new Map();
    /** @type {number} @private */
    this._itemCounter = 0;

    /** @type {Map<string, string>} @private */
    this._convIdMap = new Map();
    /** @type {number} @private */
    this._convCounter = 0;
  }

  /**
   * Normalize a tool use ID.
   * @param {string} toolUseId - Original tool use ID
   * @returns {string} Normalized ID like $TOOL_1
   */
  normalizeToolId(toolUseId) {
    if (!toolUseId) return toolUseId;
    if (!this._toolIdMap.has(toolUseId)) {
      this._toolCounter++;
      this._toolIdMap.set(toolUseId, `$TOOL_${this._toolCounter}`);
    }
    return /** @type {string} */ (this._toolIdMap.get(toolUseId));
  }

  /**
   * Normalize a context item ID.
   * @param {string} itemId - Original context item ID
   * @returns {string} Normalized ID like $ITEM_1
   */
  normalizeItemId(itemId) {
    if (!itemId) return itemId;
    if (!this._itemIdMap.has(itemId)) {
      this._itemCounter++;
      this._itemIdMap.set(itemId, `$ITEM_${this._itemCounter}`);
    }
    return /** @type {string} */ (this._itemIdMap.get(itemId));
  }

  /**
   * Normalize a conversation ID.
   * @param {string} conversationId - Original conversation ID
   * @returns {string} Normalized ID like $CONV_0
   */
  normalizeConversationId(conversationId) {
    if (!conversationId) return conversationId;
    if (!this._convIdMap.has(conversationId)) {
      // Use 0-based indexing for conversations (consistent with test operations)
      const index = this._convCounter;
      this._convCounter++;
      this._convIdMap.set(conversationId, `$CONV_${index}`);
    }
    return /** @type {string} */ (this._convIdMap.get(conversationId));
  }

  /**
   * Register a conversation ID without normalizing.
   * Useful for pre-populating the map with known conversation order.
   * @param {string} conversationId - Conversation ID to register
   * @param {number} index - Index to use (0-based)
   */
  registerConversationId(conversationId, index) {
    if (!this._convIdMap.has(conversationId)) {
      this._convIdMap.set(conversationId, `$CONV_${index}`);
      if (index >= this._convCounter) {
        this._convCounter = index + 1;
      }
    }
  }

  /**
   * Normalize IDs within a content string.
   * @param {string} content - Content string
   * @returns {string} Content with IDs normalized
   */
  normalizeContent(content) {
    if (!content) return content;
    let result = content;

    // Replace known context item IDs in content
    for (const [original, normalized] of this._itemIdMap.entries()) {
      // Escape special regex characters
      const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(escaped, 'g'), normalized);
    }

    // Replace known tool IDs in content
    for (const [original, normalized] of this._toolIdMap.entries()) {
      const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(escaped, 'g'), normalized);
    }

    return result;
  }
}

/**
 * Normalize a conversation document for golden comparison.
 * Replaces non-deterministic fields with placeholders.
 * @param {import('../../model/conversation.js').default} conversation - Conversation to snapshot
 * @returns {DocumentSnapshot} Normalized document snapshot
 */
export function normalizeDocumentSnapshot(conversation) {
  const normalizer = new IdNormalizer();

  // First pass: collect all IDs from items (items are Y.Maps). Skip thread
  // items: the worker stores toolUseId/toolName/toolInput on thread Y.Maps
  // as internal LLM-replay plumbing (cmd/juggler/worker/strategy.go), but
  // the normalized output suppresses these fields, so counting them here
  // would shift $TOOL_N numbering for real tool-action items.
  const items = /** @type {RawItem[]} */ (conversation.rootItems || []);
  for (const item of items) {
    const type = item.get('type');
    const toolUseId = item.get('toolUseId');
    if (toolUseId && type !== 'thread') {
      normalizer.normalizeToolId(toolUseId);
    }
    const itemId = item.get('itemId');
    if (itemId) {
      normalizer.normalizeItemId(itemId);
    }
    const contextItemId = item.get('contextItemId');
    if (contextItemId) {
      normalizer.normalizeItemId(contextItemId);
    }
  }

  // Second pass: normalize items for golden comparison.
  /** @type {NormalizedItem[]} */
  const normalizedItems = items.map(item => normalizeItem(item, normalizer));

  // Extract metadata
  const metadata = {};
  const rootModelConfig = conversation.rootMessageThread.modelConfig;
  if (rootModelConfig) {
    metadata.modelConfig = rootModelConfig;
  }

  return {
    items: normalizedItems,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined
  };
}

/**
 * Normalize a single item.
 * @param {RawItem} item - Item to normalize
 * @param {IdNormalizer} normalizer - ID normalizer
 * @returns {NormalizedItem} Normalized item
 */
function normalizeItem(item, normalizer) {
  const type = item.get('type');
  /** @type {NormalizedItem} */
  const normalized = {
    type
  };

  // Content (for user/assistant messages)
  const content = item.get('content');
  if (content !== undefined && content !== null) {
    normalized.content = normalizer.normalizeContent(content);
  }

  // Tool action fields. For LLM-created thread items the worker also
  // persists toolUseId/toolName/toolInput on the Y.Map so the paired
  // tool_use block can be replayed to the LLM (cmd/juggler/worker/strategy.go).
  // That's internal plumbing — surface it on tool-action items only, not
  // on threads, where the golden assertions express the user-visible shape.
  const toolUseId = item.get('toolUseId');
  if (toolUseId && type !== 'thread') {
    normalized.toolUseId = normalizer.normalizeToolId(toolUseId);
  }
  const toolName = item.get('toolName');
  if (toolName && type !== 'thread') {
    normalized.toolName = toolName;
  }
  const rawToolInput = item.get('toolInput');
  if (rawToolInput !== undefined && type !== 'thread') {
    // Convert Y.Map to plain object if needed, then parse if string
    const toolInputValue = rawToolInput?.toJSON ? rawToolInput.toJSON() : rawToolInput;
    /** @type {Record<string, any>} */
    let toolInput;
    if (typeof toolInputValue === 'string') {
      try {
        toolInput = /** @type {Record<string, any>} */ (JSON.parse(toolInputValue));
      } catch {
        toolInput = { _raw: toolInputValue };
      }
    } else {
      toolInput = /** @type {Record<string, any>} */ (toolInputValue);
    }
    // Sort keys for deterministic comparison
    normalized.toolInput = sortObjectKeys(toolInput);
  }
  const state = item.get('state');
  if (state) {
    normalized.state = state;
  }

  // Result field — thread items store a plain string, tool-actions store {content, isError}
  const result = item.get('result');
  if (result !== undefined && result !== null) {
    if (type === 'thread') {
      // Thread result is a plain string (the thread's outcome)
      const resultStr = (typeof result === 'string') ? result : (result?.toJSON ? JSON.stringify(result.toJSON()) : String(result));
      normalized.result = normalizer.normalizeContent(resultStr);
    } else {
      // Tool result (may be a Y.Map or JSON string encoding {content, isError})
      /** @type {{content?: string, isError?: boolean, contextItemId?: string}} */
      let resultObj;
      if (typeof result === 'string') {
        try {
          resultObj = JSON.parse(result);
        } catch {
          // Keep as string wrapped in object
          resultObj = { content: result, isError: false };
        }
      } else if (result?.get) {
        // Y.Map - extract fields via .get()
        resultObj = {
          content: result.get('content'),
          isError: result.get('isError'),
          contextItemId: result.get('contextItemId')
        };
      } else {
        resultObj = /** @type {{content?: string, isError?: boolean, contextItemId?: string}} */ (result);
      }
      if (typeof resultObj === 'object' && resultObj !== null) {
        normalized.result = {
          content: normalizer.normalizeContent(resultObj.content || ''),
          isError: resultObj.isError || false
        };
        // Include contextItemId in result if present
        if (resultObj.contextItemId) {
          normalized.result.contextItemId = normalizer.normalizeItemId(resultObj.contextItemId);
        }
      }
    }
  }

  // Error message text
  const message = item.get('message');
  if (message !== undefined && type === 'error') {
    normalized.message = message;
  }

  // Context item reference - only include itemId for context items and threads
  // (not regular messages or tool-actions, where itemId is just an internal
  // tracking ID not relevant for golden comparison)
  const itemId = item.get('itemId');
  if (itemId && type !== 'tool-action' && !['user', 'assistant', 'thinking', 'error', 'system'].includes(type)) {
    normalized.itemId = normalizer.normalizeItemId(itemId);
  }

  // Nested items inside a thread Y.Map. Surface them on the normalized
  // shape so tests can assert what the compaction sweep actually moved
  // into the sub-thread — without this, a test only sees `result` and
  // can't tell if items were lost or duplicated.
  if (type === 'thread') {
    const boundedCompaction = item.get('boundedCompaction');
    if (boundedCompaction !== undefined) normalized.boundedCompaction = boundedCompaction;
    const compactionPromptItemId = item.get('compactionPromptItemId');
    if (compactionPromptItemId) {
      normalized.compactionPromptItemId = normalizer.normalizeItemId(compactionPromptItemId);
    }
    const nested = item.get('items');
    if (nested && typeof nested.toArray === 'function') {
      normalized.items = nested.toArray().map(
        /**
         * @param {any} child
         * @returns {any} The normalized child item.
         */
        (child) => normalizeItem(child, normalizer)
      );
    }
  }

  return normalized;
}

/**
 * Recursively drop fields from `actual` that aren't named in `expected`.
 * Arrays are filtered element-wise (assumes same length); primitives pass
 * through. Lets the golden comparator be partial at every level of the
 * tree without each test having to list every field.
 * @param {any} actual
 * @param {any} expected
 * @returns {any} `actual` pruned to only the keys/elements present in `expected`.
 */
function filterByExpected(actual, expected) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return actual;
    return expected.map((/** @type {any} */ e, /** @type {number} */ i) => filterByExpected(actual[i], e));
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') return actual;
    /** @type {Record<string, any>} */
    const out = {};
    for (const key of Object.keys(expected)) {
      out[key] = filterByExpected(/** @type {Record<string, any>} */ (actual)[key], expected[key]);
    }
    return out;
  }
  return actual;
}

/**
 * Non-throwing counterpart to {@link assertDocumentGolden}: does `actual` match
 * the golden `expected` under the same recursive key-filter? Used as a wait
 * predicate so a test can fence on the EXACT final shape its assertion checks,
 * rather than a weaker proxy (e.g. item count) that a mid-sync document can
 * satisfy with the wrong items.
 * @param {DocumentSnapshot} actual - Actual document snapshot
 * @param {DocumentSnapshot} expected - Expected golden data
 * @returns {boolean} True if actual matches expected
 */
export function documentMatchesGolden(actual, expected) {
  const filteredActual = filterByExpected(actual, expected);
  return JSON.stringify(sortObjectKeys(filteredActual)) === JSON.stringify(sortObjectKeys(expected));
}

/**
 * Non-throwing counterpart to {@link assertItemsExist}: do the first
 * `expectedItems.length` items of `actual` match each expected item's named
 * fields? Used as a wait predicate (see {@link documentMatchesGolden}).
 * @param {DocumentSnapshot} actual - Actual document snapshot
 * @param {Partial<NormalizedItem>[]} expectedItems - Expected items (partial match)
 * @returns {boolean} True if every expected item matches at its position
 */
export function itemsMatchExpected(actual, expectedItems) {
  for (let i = 0; i < expectedItems.length; i++) {
    const actualItem = actual.items[i];
    if (!actualItem) return false;
    for (const [key, value] of Object.entries(expectedItems[i])) {
      const actualValue = /** @type {Record<string, unknown>} */ (actualItem)[key];
      if (JSON.stringify(actualValue) !== JSON.stringify(value)) return false;
    }
  }
  return true;
}

/**
 * Assert that actual document state matches expected golden data.
 * @param {DocumentSnapshot} actual - Actual document snapshot
 * @param {DocumentSnapshot} expected - Expected golden data
 * @param {string} testName - Test name for error reporting
 * @throws {Error} If document state doesn't match
 */
export function assertDocumentGolden(actual, expected, testName) {
  // Recursive key-filter: at every level of the tree, only keep actual
  // fields that the expected object also names. Lets tests opt in to
  // detailed assertions (e.g. thread.items) without forcing every other
  // test to spell out fields it doesn't care about.
  const filteredActual = filterByExpected(actual, expected);

  const actualJson = JSON.stringify(sortObjectKeys(filteredActual), null, 2);
  const expectedJson = JSON.stringify(sortObjectKeys(expected), null, 2);

  if (actualJson !== expectedJson) {
    throw new Error(
      `[${testName}] Document mismatch!\n\n` +
			`=== EXPECTED ===\n${expectedJson}\n\n` +
			`=== ACTUAL ===\n${actualJson}\n\n` +
			`=== END ===`
    );
  }
}

/**
 * Assert that specific items exist in the document.
 * Useful for partial assertions when full golden comparison is too strict.
 * @param {DocumentSnapshot} actual - Actual document snapshot
 * @param {Partial<NormalizedItem>[]} expectedItems - Expected items (partial match)
 * @param {string} testName - Test name for error reporting
 * @throws {Error} If expected items not found
 */
export function assertItemsExist(actual, expectedItems, testName) {
  for (let i = 0; i < expectedItems.length; i++) {
    const expected = expectedItems[i];
    const actualItem = actual.items[i];

    if (!actualItem) {
      throw new Error(
        `[${testName}] Missing item at index ${i}\n${_summarizeItems(actual.items)}`
      );
    }

    for (const [key, value] of Object.entries(expected)) {
      const actualValue = /** @type {Record<string, unknown>} */ (actualItem)[key];
      const expectedValue = value;

      if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
        throw new Error(
          `[${testName}] Item[${i}].${key} mismatch!\n` +
					`Expected: ${JSON.stringify(expectedValue)}\n` +
					`Actual:   ${JSON.stringify(actualValue)}\n` +
					_summarizeItems(actual.items)
        );
      }
    }
  }
}

/**
 * Render a one-line-per-item summary of an items list for failure messages.
 * Shows index, type, and a short representative field (content / toolName / result).
 * @param {Array<Record<string, unknown>>} items
 * @returns {string} Multiline string with "Actual items:" header and one line per item.
 * @private
 */
function _summarizeItems(items) {
  const lines = ['  Actual items:'];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const t = it.type;
    const tag = it.toolName ? `tool=${it.toolName}` : '';
    const state = it.state ? ` state=${it.state}` : '';
    let content = '';
    if (typeof it.content === 'string') {
      content = it.content.length > 60 ? it.content.slice(0, 57) + '...' : it.content;
      content = JSON.stringify(content);
    } else if (it.result !== undefined) {
      const r = typeof it.result === 'string' ? it.result : JSON.stringify(it.result);
      content = `result=${r.length > 60 ? r.slice(0, 57) + '...' : r}`;
    }
    lines.push(`    [${i}] ${t}${tag ? ' ' + tag : ''}${state}${content ? ' ' + content : ''}`);
  }
  return lines.join('\n');
}

/**
 * Capture document snapshot for generating golden data.
 * Use this during test development to capture the actual state
 * and paste it into your test as expectedDocument.
 * @param {import('../../model/conversation.js').default} conversation - Conversation to snapshot
 * @returns {string} JSON string formatted for pasting into test file
 */
export function captureGoldenData(conversation) {
  const snapshot = normalizeDocumentSnapshot(conversation);
  return JSON.stringify(snapshot, null, '\t');
}

/**
 * Log document snapshot to console for debugging.
 * Call this in a test to see what the actual document state is.
 * @param {import('../../model/conversation.js').default} conversation - Conversation to snapshot
 * @param {string} [label] - Optional label for the log
 */
export function logDocumentSnapshot(conversation, label = 'Document Snapshot') {
  console.warn(`\n=== ${label} ===\n${captureGoldenData(conversation)}\n=== END ===\n`);
}

// Export for use in test harness
if (typeof window !== 'undefined') {
  // @ts-ignore - expose for test harness
  window.__integrationTestHelpers = {
    normalizeDocumentSnapshot,
    assertDocumentGolden,
    assertItemsExist,
    captureGoldenData,
    logDocumentSnapshot
  };
}
