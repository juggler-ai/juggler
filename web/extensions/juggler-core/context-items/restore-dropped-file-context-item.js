//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { translator, markUntranslated } from 'juggler/i18n';
import { droppedFileText } from './dropped-file-context-item.js';

const t = translator('@juggler/core');

/**
 * RestoreDroppedFileContextItem — hand a dropped file's content back to the
 * model after it has left its context.
 *
 * A dropped file has no path on disk: its bytes live only in its
 * `dropped-file` item. drop_context_items therefore hides that item rather
 * than deleting it, and a /compact fold names the ones it swallowed; both
 * point here. The content comes back as this call's tool result — appended at
 * the end of the conversation, so the cached prefix is untouched — rather than
 * by un-hiding the item where it stands, which would re-read everything after
 * it. The item is found anywhere in the conversation, folds included.
 * @class
 * @augments ContextItem
 */
class RestoreDroppedFileContextItem extends ContextItem {
  static MANIFEST = {
    id: 'restore-dropped-file',
    name: 'Restore Dropped File',
    version: '1.0.0',
    description: 'Return the content of a file the user dropped into the conversation',
    author: 'Juggler Team',
    requiresApproval: false
  };

  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'read', icon: 'icon-document' };
  }

  /** @returns {string} Short type label */
  static getTypeName() {
    return t('Restore dropped file');
  }

  /**
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definitions
   */
  static getToolDefinitions() {
    return [{
      name: 'restore_dropped_file',
      category: 'read',
      description: markUntranslated('Return the content of a file the user dropped into the conversation that is no longer in context. Such files are not on disk; use the itemId named where the file was removed.'),
      input_schema: {
        type: 'object',
        properties: {
          itemId: {
            type: 'string',
            description: markUntranslated('The dropped file\'s item id (e.g. "DROP_3")')
          }
        },
        required: ['itemId']
      }
    }];
  }

  /**
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    if (!toolInput.itemId || typeof toolInput.itemId !== 'string') {
      return { valid: false, error: 'Missing required parameter: itemId' };
    }
    return { valid: true, params: toolInput };
  }

  /**
   * @param {Record<string, unknown>} params - Prepared params
   * @returns {Promise<Record<string, unknown>>} `{filename, text}` of the restored file
   */
  async execute(params) {
    const itemId = /** @type {string} */ (params.itemId);
    const item = /** @type {any} */ (this.conversation)?.findItemById?.(itemId);
    if (!item || item.get('type') !== 'dropped-file') {
      throw new Error(markUntranslated(`No dropped file with itemId "${itemId}" in this conversation.`));
    }
    const raw = item.get('data');
    const data = typeof raw?.toJSON === 'function' ? raw.toJSON() : (raw || {});
    const text = droppedFileText(data);
    if (!text) {
      throw new Error(markUntranslated(`The dropped file "${itemId}" is empty.`));
    }
    return { filename: String(data.filename || ''), text };
  }

  /**
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    if (!outcome.success) {
      return this.failureSummary(outcome.error || markUntranslated('Failed to restore the dropped file'));
    }
    const result = /** @type {{text: string}} */ (outcome.result);
    return this.successSummary(result.text);
  }

  /**
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Action status
   * @param {Record<string, unknown>} toolInput - Original tool input
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config
   */
  getStatusUI(actionStatus, toolInput) {
    const itemId = String(toolInput?.itemId || '');
    return this.buildStatusUI(actionStatus, {
      typeName: RestoreDroppedFileContextItem.getTypeName(),
      pending: t('Restoring {itemId}...', { itemId }),
      success: t('Restored {itemId}', { itemId }),
      failurePrefix: t('Failed to restore dropped file')
    });
  }
}

export default RestoreDroppedFileContextItem;
