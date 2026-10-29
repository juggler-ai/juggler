//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A conversation as a Markdown transcript, for pasting somewhere else.
 *
 * It is the conversation a person read, not the context the model was sent:
 * the user's and the agent's messages in full, under a heading each time the
 * speaker changes, with each tool call reduced to one quoted line naming the
 * tool and what it was asked to do, and each sub-thread to its goal and the
 * answer it handed back. Standing context (system prompt, memory, files),
 * thinking, provider state, reminders and notices are left out — they are
 * either not conversation or not the user's to share.
 *
 * Messages are already Markdown, so their text goes in verbatim.
 * @module utils/conversation-markdown
 */

import {
  isUserMessage,
  isAssistantMessage,
  isToolActionMessage,
  isThreadMessage,
  isErrorMessage,
  itemField
} from '../../sdk/lib/message.js';
import { stripThinkingTags } from './content-utils.js';
import { getThreadDisplayContent } from './thread-display.js';
import { itemGoal } from '../model/thread-alias.js';
import { displayConversationName } from '../model/conversation-naming.js';
import { itemContentText } from './item-text.js';

/**
 * Tool-input fields that say what a call was for, best first. A tool's
 * `description` or `goal` is written for a reader; the rest are the one
 * argument that identifies the call when there is no such sentence.
 * @type {string[]}
 */
const TOOL_SUMMARY_KEYS = ['description', 'goal', 'command', 'file_path', 'path', 'pattern', 'query', 'url'];

/** Longest a tool line's summary may run before it is cut. */
const TOOL_SUMMARY_MAX_CHARS = 160;

/**
 * A plain value from something that may be a Y type.
 * @param {unknown} value - A stored field.
 * @returns {unknown} The value, with a Y type materialised.
 */
function plain(value) {
  return value && typeof value === 'object' && 'toJSON' in value && typeof value.toJSON === 'function'
    ? /** @type {unknown} */ (value.toJSON())
    : value;
}

/**
 * The text of a message item. Content is a string in practice; an array of
 * parts keeps its text parts.
 * @param {unknown} item - Message item.
 * @returns {string} The trimmed text, or `''`.
 */
export function textOf(item) {
  const content = plain(itemField(item, 'content'));
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part
        : (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : '')))
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }
  return '';
}

/**
 * One line saying what a tool call was asked to do.
 * @param {unknown} item - Tool-action item.
 * @returns {string} The summary, or `''` when the input names nothing useful.
 */
export function toolSummary(item) {
  const input = plain(itemField(item, 'toolInput'));
  if (!input || typeof input !== 'object') return '';
  for (const key of TOOL_SUMMARY_KEYS) {
    const value = /** @type {Record<string, unknown>} */ (input)[key];
    if (typeof value !== 'string') continue;
    const line = value.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    return line.length <= TOOL_SUMMARY_MAX_CHARS ? line : `${line.slice(0, TOOL_SUMMARY_MAX_CHARS)}…`;
  }
  return '';
}

/**
 * Quote a block of text, blank lines included, so it stays one blockquote.
 * @param {string} text - The text.
 * @returns {string} The quoted text.
 */
function quote(text) {
  return text.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');
}

/**
 * Render conversation items as a Markdown transcript.
 * @param {ReadonlyArray<import('../../sdk/lib/message.js').Message>} items - Thread items (Y.Maps or plain objects).
 * @param {object} [options] - Options.
 * @param {string} [options.title] - A top-level heading, omitted when empty.
 * @param {import('./thread-display.js').SiblingArray} [options.siblingArray] - The Y.Array the items stand in, which
 *   resolves what a sub-thread item that is a view of another call returned.
 * @returns {string} The transcript, ending in a newline.
 */
export function itemsToMarkdown(items, { title = '', siblingArray } = {}) {
  /** @type {string[]} */
  const blocks = [];
  if (title) blocks.push(`# ${title}`);

  /** @type {'user'|'assistant'|''} */
  let speaker = '';
  /**
   * Open a speaker's section unless they already have the floor.
   * @param {'user'|'assistant'} who - Who is speaking.
   */
  const speak = (who) => {
    if (speaker === who) return;
    speaker = who;
    blocks.push(who === 'user' ? '## User' : '## Assistant');
  };

  for (const item of Array.isArray(items) ? items : []) {
    if (isUserMessage(item)) {
      const text = textOf(item);
      if (!text) continue;
      speak('user');
      blocks.push(text);
    } else if (isAssistantMessage(item)) {
      const text = stripThinkingTags(textOf(item));
      if (!text) continue;
      speak('assistant');
      blocks.push(text);
    } else if (isToolActionMessage(item)) {
      const name = String(itemField(item, 'toolName') || 'tool');
      const summary = toolSummary(item);
      speak('assistant');
      blocks.push(`> **Tool** \`${name}\`${summary ? `: ${summary}` : ''}`);
    } else if (isThreadMessage(item)) {
      const goal = itemGoal(item, siblingArray) || 'Sub-thread';
      const result = getThreadDisplayContent(item, siblingArray).text.trim();
      speak('assistant');
      blocks.push(`> **Sub-thread**: ${goal}${result ? `\n>\n${quote(result)}` : ''}`);
    } else if (isErrorMessage(item)) {
      const text = String(plain(itemField(item, 'message')) || '').trim() || itemContentText(item).trim() || textOf(item);
      if (text) blocks.push(`> **Error**: ${text.replace(/\n/g, '\n> ')}`);
    }
  }

  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}

/**
 * A whole conversation — its root thread, whichever thread is on screen — as a
 * Markdown transcript headed by its name. The conversation must be loaded; an
 * unloaded one has no items to read (see `Session.ensureConversationLoaded`).
 * @param {{rootMessageThread?: {items: import('../../sdk/lib/message.js').Message[], yarray: import('yjs').Array<unknown>|null}|null, name?: string}|null|undefined} conversation - A Conversation model.
 * @returns {string} The transcript, or `''` when there is no conversation.
 */
export function conversationToMarkdown(conversation) {
  const thread = conversation?.rootMessageThread;
  if (!thread) return '';
  const title = conversation.name ? displayConversationName(conversation.name) : '';
  return itemsToMarkdown(thread.items, { title, siblingArray: thread.yarray ?? undefined });
}
