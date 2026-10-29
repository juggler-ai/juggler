//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The text of an error or notice item in the UI language. The worker stores
 * the English in `content` and `summary`, and beside it in `data` the messages
 * it was rendered from: `message` renders `content`, and on a notice
 * `summaryMessage` renders `summary`. An error's summary is either its content
 * or the provider's own text pulled out of it, which has no message and is
 * shown as stored. An item saved before the worker sent messages shows its
 * stored English. See SCHEMA.md.
 */

import { serverText } from '../../sdk/lib/i18n.js';
import { itemField } from '../../sdk/lib/message.js';
import { readItemData } from './item-data.js';

/**
 * An item as a Y.Map or as the plain object a snapshot holds.
 * @typedef {{get: (key: string) => unknown}|Record<string, unknown>|null|undefined} TextItem
 */

/**
 * The item with a `get`, whichever shape it came in.
 * @param {TextItem} item
 * @returns {{ get: (key: string) => unknown }} A reader of its fields.
 */
function fields(item) {
  return { get: (key) => itemField(item, key) };
}

/**
 * A message the worker stored in an item's `data`, for `serverText`, which
 * falls back to the stored English for anything that is not one.
 * @param {unknown} value - The stored message
 * @returns {{key?: unknown, params?: unknown, context?: unknown}|undefined} The message, or undefined when it is not an object
 */
function wireMessage(value) {
  return value && typeof value === 'object' ? value : undefined;
}

/**
 * The item's one-line text, translated where the worker sent a message for it.
 * @param {TextItem} item - An error or notice item
 * @returns {string} The summary, or '' when the item has none.
 */
export function itemSummaryText(item) {
  const reader = fields(item);
  const summary = String(reader.get('summary') || '');
  const content = String(reader.get('content') || '');
  const data = readItemData(reader);
  if (data?.summaryMessage) return serverText(wireMessage(data.summaryMessage), summary);
  if (!summary || summary === content) return serverText(wireMessage(data?.message), summary || content);
  return summary;
}

/**
 * The item's full text, translated where the worker sent a message for it.
 * @param {TextItem} item - An error or notice item
 * @returns {string} The content, or '' when the item has none.
 */
export function itemContentText(item) {
  const reader = fields(item);
  return serverText(wireMessage(readItemData(reader)?.message), String(reader.get('content') || ''));
}
