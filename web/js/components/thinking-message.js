//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseMessage from './base-message.js';
import { stripThinkingTags } from '../utils/content-utils.js';
import { wrapWithIcon } from '../utils/icon-message-renderer.js';
import { iconOptionsForItem } from '../utils/item-badge.js';
import { formatTokens } from '../utils/format.js';
import { t } from '../../sdk/lib/i18n.js';
import { createStreamingMarkdown } from '../utils/streaming-markdown.js';

/**
 * Estimated token count at or below which a thinking block is shown inline.
 * @type {number}
 */
export const SHORT_THINKING_TOKENS = 100;

/**
 * Rough token estimate for thinking text, shared by the summary label and the
 * inline threshold so the two can never disagree.
 * @param {string} clean - Thinking text with tags stripped.
 * @returns {number} Estimated tokens.
 */
function estimateTokens(clean) {
  return Math.ceil(clean.length / 4);
}

/**
 * Thinking message component, in one of two forms chosen by length:
 *
 * - **Inline** (at most {@link SHORT_THINKING_TOKENS}): the text itself, with no
 *   icon or badge, in the shared `.llm-description` style. Short blocks are
 *   usually a sentence addressed as much to the user as to the model, and take
 *   no more room than the summary line would.
 * - **Summary**: a yellow icon and "Thinking · N tokens"; the full text is in
 *   the properties panel.
 *
 * A block that streams past the threshold switches from inline to summary.
 * Either form selects the item and opens the same properties panel.
 */
class ThinkingMessage extends BaseMessage {
  /**
   * Inline body renderer, rebuilt by render(). Null in summary form.
   * @type {{update: (text: string) => void}|null}
   * @private
   */
  _stream = null;

  _supportsStreaming() {
    return true;
  }

  /**
   * Whether the given content should be shown inline.
   * @param {string} clean - Thinking text with tags stripped.
   * @returns {boolean} True for a short block.
   * @private
   */
  _isShort(clean) {
    return estimateTokens(clean) <= SHORT_THINKING_TOKENS;
  }

  /**
   * Returns "Thinking · N tokens" label, or just "Thinking" when content is empty.
   * @param {string} clean - Thinking text with tags stripped.
   * @returns {string} Summary label for the thread display
   * @private
   */
  _tokenLabel(clean) {
    if (!clean.length) return t('Thinking');
    const count = estimateTokens(clean);
    return t('{count, plural, one {Thinking · {tokens} token} other {Thinking · {tokens} tokens}}',
      { count, tokens: formatTokens(count) });
  }

  render() {
    const clean = stripThinkingTags(this.content);
    const article = document.createElement('article');
    article.className = 'thinking';
    this._stream = null;

    if (this._isShort(clean)) {
      article.classList.add('thinking-inline');
      const contentDiv = document.createElement('div');
      contentDiv.className = 'message-content-box llm-description';
      const body = document.createElement('div');
      contentDiv.appendChild(body);
      article.appendChild(contentDiv);
      this.replaceChildren(article);
      // Same choice the properties panel makes for reasoning: Markdown only
      // when a construct is present, otherwise the text as it arrived.
      this._stream = createStreamingMarkdown(body, { escapeXml: true });
      this._stream.update(clean);
      return;
    }

    const contentDiv = document.createElement('div');
    const span = document.createElement('span');
    span.className = 'thinking-summary';
    span.textContent = this._tokenLabel(clean);
    contentDiv.appendChild(span);

    article.appendChild(wrapWithIcon(contentDiv, iconOptionsForItem(null, { fallbackType: 'thinking' })));

    this.replaceChildren(article);
  }

  _updateContent() {
    const clean = stripThinkingTags(this.content);
    const short = this._isShort(clean);
    if (short && this._stream && this.querySelector('article.thinking-inline')) {
      this._stream.update(clean);
      return;
    }
    const span = this.querySelector('.thinking-summary');
    if (!short && span) {
      span.textContent = this._tokenLabel(clean);
      return;
    }
    this.render();
  }

  /**
   * Update from Yjs item data (called by conversation-area)
   * @param {any} item - The Yjs item
   */
  updateFromItem(item) {
    if (!item) return;
    this._setStreamContent(item.get('content') || '');
  }
}

customElements.define('thinking-message', ThinkingMessage);
