//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseMessage from './base-message.js';
import { createStreamingMarkdown } from '../utils/streaming-markdown.js';
import { stripThinkingTags } from '../utils/content-utils.js';
import { decorateFileRefs } from '../utils/file-refs.js';
import '../utils/icon-message-renderer.js';

/**
 * Assistant message component - icon + markdown content with streaming support
 */
class AssistantMessage extends BaseMessage {
  /**
   * Renders the body, re-parsing only the part of the reply still in flight.
   * Rebuilt by render(), which replaces the element the renderer writes into.
   * @type {{update: (text: string) => void}|null}
   * @private
   */
  _stream = null;

  /**
   * Whether this component supports streaming updates
   * @returns {boolean} True, this component supports streaming
   * @protected
   * @override
   */
  _supportsStreaming() {
    return true;
  }

  /**
   * Render the message
   * @override
   */
  render() {
    const article = document.createElement('article');
    article.className = 'assistant';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content-box';
    // The renderer owns this element, and gives it the `markdown` class.
    const body = document.createElement('div');
    contentDiv.appendChild(body);

    article.appendChild(contentDiv);

    this._appendCopyButton(article, () => stripThinkingTags(this.content));

    this.replaceChildren(article);

    // An assistant reply is Markdown by definition, so it never falls back to
    // verbatim the way a provider's raw reasoning can, and its own inline HTML
    // is left for the renderer's sanitizer rather than escaped up front.
    this._stream = createStreamingMarkdown(body, {
      escapeXml: false,
      detect: false,
      decorate: (holder) => { void decorateFileRefs(holder, this._fileRefContext()); },
    });
    this._stream.update(stripThinkingTags(this.content));
  }

  /**
   * Efficient content update for streaming - only updates content, not entire element
   * @protected
   * @override
   */
  _updateContent() {
    if (!this._stream || !this.querySelector('.message-content-box')) {
      this.render();
      return;
    }
    this._stream.update(stripThinkingTags(this.content));
  }

  /**
   * Update from Yjs item data (called by conversation-area)
   * @param {any} item - The Yjs item
   */
  updateFromItem(item) {
    if (!item) return;
    const newContent = item.get('content') || '';
    if (!this._setStreamContent(newContent)) return;
    // Hide when the message has no visible text (e.g. a turn that was only tool calls)
    this.style.display = newContent.trim().length > 0 ? '' : 'none';
  }
}

customElements.define('assistant-message', AssistantMessage);
