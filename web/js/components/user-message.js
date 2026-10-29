//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseMessage from './base-message.js';
import apiService from '../services/api.js';
import { createImageThumb } from '../utils/image-lightbox.js';
import { applyCollapsible } from '../utils/collapsible.js';
import { renderMarkdownWrapped, decorateCodeBlocks, looksLikeMarkdown } from '../../sdk/lib/markdown.js';
import { t } from '../../sdk/lib/i18n.js';

/**
 * Character count above which an over-long user message is clamped behind a
 * Show more toggle. Higher than the thread tile's limit because the message
 * bubble is wider, so more chars are needed to fill the clamp height.
 */
const USER_MESSAGE_MAX_CHARS = 1000;

/**
 * User message component - simple text bubble without icon layout. When the
 * user item carries image attachments, a thumbnail grid is rendered below the
 * text (or alone, for an image-only message).
 *
 * When {@link looksLikeMarkdown} finds a Markdown construct, the text is
 * rendered through the same renderer/sanitizer as assistant messages, in
 * `escapeXml: true` mode (the untrusted-input mode also used for thread goals
 * in utils/thread-display.js): links, emphasis, lists and code render as
 * formatted output, while any literal `<...>` is neutralised to inert text
 * rather than parsed as HTML / a custom element. Plain text is shown verbatim
 * via `textContent` (mono, whitespace-significant), so prose is never reflowed
 * into the sans font or reinterpreted as formatting. Either way the raw source
 * is untouched: copy, rollback, branch and edit-into-composer all read
 * `this.content` / the data model, never this rendered DOM.
 */
class UserMessage extends BaseMessage {
  // Re-render on attachments changes too (immutable in practice, but keeps the
  // bubble correct if the synced item is ever replaced in place).
  static get observedAttributes() {
    return ['content', 'attachments'];
  }

  /**
   * Render the message
   * @override
   */
  render() {
    const article = document.createElement('article');
    article.className = 'user';

    const attachments = this._getAttachments();

    // Text (when present) sits in its own block. For a message with
    // attachments it sits above the image grid; for an image-only message it's
    // omitted so no empty text node renders. The block is also the clamp
    // target for the collapse/expand affordance below.
    /** @type {HTMLElement|null} */
    let text = null;
    if (this.content) {
      text = document.createElement('div');
      text.className = 'user-message-text';
      if (looksLikeMarkdown(this.content)) {
        // Markdown: render in escapeXml mode (untrusted input). The `.markdown`
        // wrapper carries the formatted (sans-font) styling; the raw source
        // stays on the `content` attribute, which copy/rollback/branch read.
        text.innerHTML = renderMarkdownWrapped(this.content, { escapeXml: true });
        decorateCodeBlocks(text);
      } else {
        // Plain text: verbatim, whitespace-significant, mono. The `.plain` class
        // supplies pre-wrap; stray `*`/`_`/`#` stay literal, no reflow.
        text.classList.add('plain');
        text.textContent = this.content;
      }
      article.appendChild(text);
    }

    if (attachments.length > 0) {
      article.appendChild(this._buildAttachmentGrid(attachments));
    }

    this._appendCopyButton(article, () => this.content);
    this.replaceChildren(article);

    // Clamp an extremely long message behind a Show more toggle. No-op for
    // ordinary-length text, so short bubbles are unaffected. The gate is a
    // character count (see collapsible.js); the higher limit than the thread
    // tile reflects the wider bubble, which needs more chars to fill the clamp
    // height.
    if (text) applyCollapsible(text, { key: this.itemId || '', maxChars: USER_MESSAGE_MAX_CHARS });
  }

  /**
   * Parse the JSON attachment refs carried on the `attachments` attribute.
   * @returns {Array<{id:string,mime:string,filename:string,bytes:number,width:number,height:number}>} The attachment refs (empty if none/invalid).
   * @private
   */
  _getAttachments() {
    const raw = this.getAttribute('attachments');
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((ref) => ref && ref.id) : [];
    } catch {
      return [];
    }
  }

  /**
   * Build the image grid: one lazy-loading <img> per attachment, sized down to
   * a thumbnail (CSS) while preserving intrinsic aspect ratio via the
   * width/height attributes. Clicking an image opens it full-size.
   * @param {Array<{id:string,mime:string,filename:string,bytes:number,width:number,height:number}>} attachments
   * @returns {HTMLElement} The image-grid container element.
   * @private
   */
  _buildAttachmentGrid(attachments) {
    const grid = document.createElement('div');
    grid.className = 'user-message-attachments';

    const conversationId = this._getConversation()?.id || '';

    for (const ref of attachments) {
      grid.appendChild(createImageThumb({
        src: apiService.assetURL(conversationId, ref.id),
        alt: ref.filename || t('attachment'),
        className: 'user-message-attachment',
        width: ref.width,
        height: ref.height,
      }));
    }

    return grid;
  }
}

customElements.define('user-message', UserMessage);
