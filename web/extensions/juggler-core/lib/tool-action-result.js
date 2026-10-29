//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading a tool action's stored outcome from `renderToolActionDetails`.
 *
 * A field of a tool action holds a Y type when it arrived through the document
 * and a plain object when it was set locally before conversion, so every reader
 * copes with both. These read one field at a time: a result can hold a whole
 * file, and materialising all of it to reach one flag would copy it.
 * @module lib/tool-action-result
 */

/** @typedef {import('../../../sdk/lib/message.js').ToolActionResult} ToolActionResult */

/**
 * A stored value as plain data: a Y type's `toJSON()`, anything else as it is.
 * @param {unknown} value - A value read from a Y.Map, or an already-plain one
 * @returns {unknown} The plain equivalent
 */
function plainValue(value) {
  if (value && typeof value === 'object' && 'toJSON' in value && typeof value.toJSON === 'function') {
    return value.toJSON();
  }
  return value;
}

/**
 * One field of a Y.Map or a plain object, as plain data.
 * @param {unknown} holder - A Y.Map, a plain object, or nothing
 * @param {string} key - The field to read
 * @returns {unknown} The field's plain value, or undefined
 */
function plainField(holder, key) {
  if (!holder || typeof holder !== 'object') return undefined;
  const value = 'get' in holder && typeof holder.get === 'function'
    ? holder.get(key)
    : /** @type {Record<string, unknown>} */ (holder)[key];
  return plainValue(value);
}

/**
 * The tool action's whole result, as plain data. Prefer
 * {@link toolActionResultField} where one field is all that is needed.
 * @param {import('yjs').Map<unknown>|null|undefined} toolAction - The tool action
 * @returns {ToolActionResult} The result, or an empty object when the action has none yet
 */
export function toolActionResult(toolAction) {
  const value = plainValue(toolAction?.get('result'));
  return value && typeof value === 'object' ? /** @type {ToolActionResult} */ (value) : {};
}

/**
 * One field of the tool action's result, as plain data.
 * @template {keyof ToolActionResult} K
 * @param {import('yjs').Map<unknown>|null|undefined} toolAction - The tool action
 * @param {K} key - The result field to read
 * @returns {ToolActionResult[K]|undefined} The field, or undefined when the action has no result yet
 */
export function toolActionResultField(toolAction, key) {
  return /** @type {ToolActionResult[K]|undefined} */ (plainField(toolAction?.get('result'), key));
}

/**
 * A field of the tool action's result that {@link ToolActionResult} does not
 * declare — one a result recorded by an older build may carry — as plain data,
 * for the caller to narrow.
 * @param {import('yjs').Map<unknown>|null|undefined} toolAction - The tool action
 * @param {string} key - The result field to read
 * @returns {unknown} The field, or undefined
 */
export function toolActionResultValue(toolAction, key) {
  return plainField(toolAction?.get('result'), key);
}

/**
 * The tool's own result data (`fullResult.result`), as plain data. Its shape is
 * the plugin's, so the caller narrows each field it reads.
 * @param {import('yjs').Map<unknown>|null|undefined} toolAction - The tool action
 * @returns {Record<string, unknown>} The data, or an empty object when there is none
 */
export function toolActionResultData(toolAction) {
  const data = toolActionResultField(toolAction, 'fullResult')?.result;
  return data && typeof data === 'object' ? /** @type {Record<string, unknown>} */ (data) : {};
}

/**
 * The tool action's display data, as plain data.
 * @param {import('yjs').Map<unknown>|null|undefined} toolAction - The tool action
 * @returns {Record<string, unknown>} The display data, or an empty object when it has none
 */
export function toolActionDisplayData(toolAction) {
  const value = plainValue(toolAction?.get('displayData'));
  return value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
}

/**
 * A field of an input the model wrote, as display text. The model can put any
 * JSON in any field, so a value that is not a string is shown as it stringifies.
 * @param {Record<string, unknown>} input - The tool call's input
 * @param {string} key - The field to read
 * @returns {string} The field as text, or '' when it is absent or empty
 */
export function inputText(input, key) {
  const value = input[key];
  return value ? String(value) : '';
}
