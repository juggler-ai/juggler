//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseMessage from './base-message.js';
import apiService from '../services/api.js';
import { openImageLightbox } from '../utils/image-lightbox.js';
import { applyCollapsible } from '../utils/collapsible.js';
import { renderMarkdownWrapped, decorateCodeBlocks } from '../../sdk/lib/markdown.js';

/**
 * User message component - simple text bubble without icon layout. When the
 * user item carries image attachments, a thumbnail grid is rendered below the
 * text (or alone, for an image-only message).
 *
 * The text is rendered as Markdown (same renderer/sanitizer as assistant
 * messages, `escapeXml: true`) so links, emphasis, lists and code the user
 * typed or pasted render nicely instead of as raw source — while any literal
 * `<...>` the user typed is shown as inert text rather than parsed as HTML.
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
      text.innerHTML = renderMarkdownWrapped(this.content, { escapeXml: true });
      decorateCodeBlocks(text);
      article.appendChild(text);
    }

    if (attachments.length > 0) {
      article.appendChild(this._buildAttachmentGrid(attachments));
    }

    this._appendCopyButton(article, () => this.content);
    this.replaceChildren(article);

    // Now attached — clamp an extremely long message behind a Show more toggle.
    // No-op for ordinary-length text, so short bubbles are unaffected.
    if (text) applyCollapsible(text, { key: this.itemId || '' });
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
      const src = apiService.assetURL(conversationId, ref.id);
      const img = document.createElement('img');
      img.className = 'user-message-attachment';
      img.src = src;
      img.alt = ref.filename || 'attachment';
      img.loading = 'lazy';
      // Intrinsic dimensions let the browser reserve the right box and derive
      // the aspect ratio before the bytes load (CSS caps the display size).
      if (ref.width) img.width = ref.width;
      if (ref.height) img.height = ref.height;
      img.addEventListener('click', () => openImageLightbox(src, img.alt));
      grid.appendChild(img);
    }

    return grid;
  }
}

customElements.define('user-message', UserMessage);

export default UserMessage;
