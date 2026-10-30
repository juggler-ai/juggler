//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import JugglerElement from './juggler-element.js';
import { createCopyButton } from '../utils/properties-panel-helpers.js';
import { fileRefContext } from '../utils/file-refs.js';

/**
 * Attribute marking the element that renders the thread's final item, written
 * by the rendering pass (`conversation-area-rendering.positionElements`) as the
 * item list grows and shrinks. Elements whose affordances only make sense at the
 * end of a thread observe it; for everything else it is inert.
 * @type {string}
 */
export const FINAL_ITEM_ATTR = 'item-final';

/**
 * Base class for message components with shared functionality:
 * - Common attribute getters (itemId, itemIndex, content)
 * - Lifecycle management with proper cleanup (inherited from JugglerElement)
 * - Streaming support hooks
 * @abstract
 */
class BaseMessage extends JugglerElement {
  // === Lifecycle ===

  connectedCallback() {
    this.classList.add('conversation-item');
    this.render();
  }

  /**
   * @param {string} name
   * @param {string|null} oldValue
   * @param {string|null} newValue
   */
  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;

    if (name === 'content') {
      // An explicit attribute write is a seed or a rebuild, and supersedes
      // whatever streaming left on the element.
      this._streamContent = null;
      if (this._supportsStreaming()) {
        this._updateContent();
        return;
      }
    }
    this.render();
  }

  static get observedAttributes() {
    return ['content'];
  }

  // === Common Getters ===

  /** @returns {string|null} The message ID attribute value */
  get itemId() {
    return this.getAttribute('message-id');
  }

  /** @returns {number|null} The item index as a number, or null if not set */
  get itemIndex() {
    const index = this.getAttribute('item-index');
    return index !== null ? parseInt(index, 10) : null;
  }

  /** @returns {boolean} Whether this element renders the thread's final item */
  get isFinalItem() {
    return this.hasAttribute(FINAL_ITEM_ATTR);
  }

  /**
   * The streamed text, held off the DOM.
   *
   * A streaming message's `content` is the whole accumulated reply, rewritten
   * on every delta — tens of kilobytes by the end of a long one. Pushing that
   * through an attribute copies the entire string into the DOM and raises a
   * mutation record for it many times a second, so streaming updates land here
   * and the attribute keeps only the seed value set at creation.
   * @type {string|null}
   * @protected
   */
  _streamContent = null;

  /** @returns {string} The streamed text if any has arrived, else the attribute. */
  get content() {
    return this._streamContent ?? (this.getAttribute('content') || '');
  }

  /**
   * Take a streaming update without writing it to the DOM.
   * @param {string} text - The full accumulated content.
   * @returns {boolean} True if the text changed and _updateContent() ran.
   * @protected
   */
  _setStreamContent(text) {
    if (this.content === text) return false;
    this._streamContent = text;
    this._updateContent();
    return true;
  }

  /**
   * Get conversation reference from parent conversation-area
   * @returns {import('../model/conversation.js').default|null} The conversation instance or null
   * @protected
   */
  _getConversation() {
    const conversationArea = this.closest('conversation-area');
    if (!conversationArea) return null;
    // @ts-ignore - conversation property exists on conversation-area
    return conversationArea.conversation || null;
  }

  /**
   * Get message thread from parent conversation-area
   * @returns {import('../model/message-thread.js').default|null} Message thread or null
   * @protected
   */
  _getMessageThread() {
    const conversationArea = /** @type {any} */ (this.closest('conversation-area'));
    return conversationArea?.getMessageThread?.() || null;
  }

  /**
   * The tree this message's file references resolve in: where its conversation
   * works, asked afresh each time so a message rendered before its row was
   * attached simply decorates nothing until it is.
   * @returns {{root: string, workspaceId: string}} Root '' when not known.
   * @protected
   */
  _fileRefContext() {
    return fileRefContext(this._getMessageThread(), this._getConversation());
  }

  // === Override Points ===

  /**
   * Render the message. Subclasses must implement this.
   * @abstract
   */
  render() {
    throw new Error('Subclass must implement render()');
  }

  /**
   * Whether this component supports streaming updates.
   * If true, content attribute changes will call _updateContent() instead of render().
   * @returns {boolean} True if streaming is supported
   * @protected
   */
  _supportsStreaming() {
    return false;
  }

  /**
   * Update content efficiently during streaming (called when _supportsStreaming() returns true).
   * Default implementation falls back to full render.
   * @protected
   */
  _updateContent() {
    this.render();
  }

  /**
   * Append a hover-reveal copy-to-clipboard button to a message's root
   * `<article>`. The button sits in the upper-right and is revealed by CSS
   * when the pointer hovers the message (see `.message-copy-button`).
   * @param {HTMLElement} article - The message's root element (must be a
   *   positioning context — `position: relative` or similar).
   * @param {() => string} getText - Resolves the text to copy at click time.
   * @protected
   */
  _appendCopyButton(article, getText) {
    article.appendChild(createCopyButton(getText, 'message-copy-button'));
  }

  /**
   * Get the busy state for this message item.
   * Override in subclasses to declare custom busy states.
   * The footer aggregates these to show status without type-specific knowledge.
   * @returns {null|{message: string, spinner: boolean}} null if not busy
   */
  getBusyState() {
    return null;
  }
}

export default BaseMessage;
