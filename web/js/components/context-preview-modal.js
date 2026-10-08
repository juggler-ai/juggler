//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { ContextBuilder } from '../services/context-builder.js';
import { escapeHtml } from '../../sdk/lib/html.js';
import { copyToClipboard } from '../../sdk/lib/clipboard.js';
import { markPopupOpen } from '../utils/popup-manager.js';
import { fadeOutScrims } from '../utils/modal-scrim.js';
import { showAlert } from './modal-dialog.js';
import { CHECK_SVG, withAttrs } from '../utils/icons.js';

/**
 * ContextPreviewModal - Modal for previewing the full LLM context
 *
 * Shows the complete assembled context that will be sent to the LLM,
 * with section navigation sidebar, a byte-size readout, and copy-to-clipboard.
 * The readout is bytes rather than tokens because the client ships no encoder;
 * the exact token count lives on the conversation footer behind the modal.
 * @typedef {import('juggler/context-item').default} ContextItemInstance
 * @typedef {import('../services/api.js').Message} Message
 */

/**
 * @typedef {object} ContextSection
 * @property {string} type - Section type (system, context-items-header, context-item, conversation-message, etc.)
 * @property {string} label - Human-readable label for navigation
 * @property {number} offset - Character offset where section starts
 * @property {number} length - Length of section content in characters
 * @property {string} [role] - Message role (user, assistant, etc.) for conversation messages
 * @property {number} [itemIndex] - Index of context item (for context item sections)
 */
class ContextPreviewModal extends HTMLElement {
  constructor() {
    super();
    /** @type {string} @private */
    this._contextText = '';
    /** @type {ContextSection[]} @private */
    this._sections = [];
    /** @type {(() => void)|null} @private */
    this._releasePopupOpen = null;
  }

  connectedCallback() {
    this.render();
  }

  /**
   * Show the context preview modal
   * @async
   * @param {{ session: import('../model/session.js').default, messageThread: import('../model/message-thread.js').default }} options - Preview options
   */
  async show(options) {
    const { session, messageThread } = options;

    if (!session || !messageThread) {
      throw new Error('[ContextPreviewModal] session and messageThread are required');
    }

    // Check that context has messages to preview
    if (messageThread.getMessages().length === 0) {
      throw new Error('[ContextPreviewModal] No messages available to preview');
    }

    // Build context from messageThread
    const contextWindow = messageThread.conversation.contextWindow || 200000;
    const builder = new ContextBuilder({ messageThread, session, contextWindow });

    // Render text with sections for UI preview
    const { text, sections } = await builder.renderTextWithSections();

    // Store context data
    this._contextText = text;
    this._sections = /** @type {ContextSection[]} */(sections);

    // Show modal and update content
    this.style.display = 'flex';
    // Escape and the browser/mobile Back button dismiss via popup-manager.
    if (!this._releasePopupOpen) {
      this._releasePopupOpen = markPopupOpen(() => this.hide());
    }
    this.updateContent();
  }

  /**
   * Hide the modal
   */
  hide() {
    fadeOutScrims(this);
    this.style.display = 'none';
    if (this._releasePopupOpen) {
      this._releasePopupOpen();
      this._releasePopupOpen = null;
    }
  }

  render() {
    this.innerHTML = `
      <modal-backdrop class="context-preview-backdrop" id="backdrop"></modal-backdrop>
      <modal-panel class="context-preview-container">
        <header class="context-preview-header">
          <div class="context-preview-title-row">
            <h2 class="context-preview-title">Context Preview</h2>
            <span class="context-preview-size" id="size-readout"></span>
          </div>
          <div class="context-preview-actions">
            <button class="context-preview-copy-button" id="copy-button" title="Copy to clipboard">
              <svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="currentColor">
                <path d="M360-240q-33 0-56.5-23.5T280-320v-480q0-33 23.5-56.5T360-880h360q33 0 56.5 23.5T800-800v480q0 33-23.5 56.5T720-240H360Zm0-80h360v-480H360v480ZM200-80q-33 0-56.5-23.5T120-160v-520h80v520h440v80H200Zm160-240v-480 480Z"/>
              </svg>
              Copy
            </button>
            <button class="close-button" id="close-button" title="Close (Esc)" aria-label="Close"><span class="icon-close"></span></button>
          </div>
        </header>
        <main class="context-preview-body">
          <nav class="context-preview-sidebar" id="sidebar">
            <!-- Section navigation will be populated here -->
          </nav>
          <section class="context-preview-content" id="content" tabindex="0">
            <pre id="context-text"></pre>
          </section>
        </main>
      </modal-panel>
    `;

    this.setupEventListeners();
  }

  setupEventListeners() {
    // Close on backdrop click
    const backdrop = this.querySelector('#backdrop');
    backdrop?.addEventListener('click', () => {
      this.hide();
    });

    // Close button
    const closeButton = this.querySelector('#close-button');
    closeButton?.addEventListener('click', () => {
      this.hide();
    });

    // Copy button
    const copyButton = this.querySelector('#copy-button');
    copyButton?.addEventListener('click', async () => {
      await this.copyToClipboard();
    });

    // Content area keyboard navigation
    const contentArea = this.querySelector('#content');
    if (contentArea instanceof HTMLElement) {
      contentArea.addEventListener('keydown', /** @param {Event} e */ (e) => {
        // Type guard: keydown events are always KeyboardEvent
        const keyEvent = /** @type {KeyboardEvent} */ (e);
        this.handleContentKeyDown(keyEvent, contentArea);
      });
    }
  }

  /**
   * Handle keyboard navigation in content area
   * @private
   * @param {KeyboardEvent} e - The keyboard event
   * @param {HTMLElement} contentArea - The content area element
   */
  handleContentKeyDown(e, contentArea) {
    const scrollAmount = contentArea.clientHeight;

    switch (e.key) {
      case 'PageDown':
        e.preventDefault();
        contentArea.scrollBy({ top: scrollAmount, behavior: 'smooth' });
        break;
      case 'PageUp':
        e.preventDefault();
        contentArea.scrollBy({ top: -scrollAmount, behavior: 'smooth' });
        break;
      case 'Home':
        e.preventDefault();
        contentArea.scrollTo({ top: 0, behavior: 'smooth' });
        break;
      case 'End':
        e.preventDefault();
        contentArea.scrollTo({ top: contentArea.scrollHeight, behavior: 'smooth' });
        break;
      case 'ArrowDown':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          contentArea.scrollTo({ top: contentArea.scrollHeight, behavior: 'smooth' });
        }
        break;
      case 'ArrowUp':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          contentArea.scrollTo({ top: 0, behavior: 'smooth' });
        }
        break;
    }
  }

  /**
   * Update the content display with current context
   * @private
   */
  updateContent() {
    // Honest byte size. Token count would require an encoder we don't ship;
    // the conversation footer behind this modal carries the real number from
    // the most recent transaction blob.
    const sizeEl = this.querySelector('#size-readout');
    if (sizeEl) {
      const kb = this._contextText.length / 1024;
      sizeEl.textContent = kb >= 10 ? `${kb.toFixed(0)} KB` : `${kb.toFixed(1)} KB`;
    }

    this.renderContextWithAnchors();
    this.renderSectionNav();
  }

  /**
   * Render context text with color-coded sections and navigation anchors
   * @private
   */
  renderContextWithAnchors() {
    const textElement = this.querySelector('#context-text');
    if (!textElement) {
      return;
    }

    // Build text with colored spans and anchor spans injected at section boundaries
    const parts = [];
    let lastOffset = 0;

    // Sort sections by offset
    const sortedSections = [...this._sections].sort((a, b) => a.offset - b.offset);

    sortedSections.forEach((section, index) => {
      // Add text before this section (if any) with color from previous section
      if (section.offset > lastOffset) {
        const textBefore = this._contextText.substring(lastOffset, section.offset);
        const prevSection = index > 0 ? sortedSections[index - 1] : null;
        const colorClass = prevSection ? this.getColorClass(prevSection.type, prevSection.role, prevSection.itemIndex) : '';

        if (colorClass) {
          const span = document.createElement('span');
          span.className = colorClass;
          span.textContent = textBefore;
          parts.push(span);
        } else {
          parts.push(document.createTextNode(textBefore));
        }
      }

      // Add anchor span (invisible)
      const anchor = document.createElement('span');
      anchor.id = `section-${section.offset}`;
      anchor.style.position = 'relative';
      anchor.style.top = '-1.5rem'; // Offset for padding
      parts.push(anchor);

      lastOffset = section.offset;
    });

    // Add remaining text with color from last section
    if (lastOffset < this._contextText.length) {
      const textAfter = this._contextText.substring(lastOffset);
      const lastSection = sortedSections[sortedSections.length - 1];
      const colorClass = lastSection ? this.getColorClass(lastSection.type, lastSection.role, lastSection.itemIndex) : '';

      if (colorClass) {
        const span = document.createElement('span');
        span.className = colorClass;
        span.textContent = textAfter;
        parts.push(span);
      } else {
        parts.push(document.createTextNode(textAfter));
      }
    }

    // Clear and append all parts
    textElement.innerHTML = '';
    parts.forEach(part => textElement.appendChild(part));
  }

  /**
   * Get CSS class for section color coding
   * @private
   * @param {string} sectionType
   * @param {string} [role] - Message role for conversation-message sections
   * @param {number} [itemIndex] - Context item index for alternating colors
   * @returns {string} CSS class name for the section
   */
  getColorClass(sectionType, role, itemIndex) {
    // System sections - blue-ish
    if (sectionType === 'system' || sectionType === 'plan-mode' || sectionType === 'separator') {
      return 'context-system';
    }

    // Context item sections - alternating green colors
    if (sectionType === 'context-items-header' || sectionType === 'context-items-empty') {
      return 'context-items-section';
    }

    if (sectionType === 'context-item') {
      // Alternate between two green colors
      return itemIndex !== undefined && itemIndex % 2 === 0 ? 'context-item-even' : 'context-item-odd';
    }

    // Conversation sections - need to distinguish user vs assistant
    if (sectionType === 'conversation-header' || sectionType === 'current-header') {
      return 'context-history-header';
    }

    if (sectionType === 'conversation-message' || sectionType === 'current') {
      // Color based on message role
      if (role === 'user') {
        return 'context-user';
      } else if (role === 'assistant') {
        return 'context-assistant';
      } else if (role === 'context-item-result' || role === 'action-result' || role === 'drop-result') {
        return 'context-result';
      }
      return 'context-message'; // Fallback
    }

    return '';
  }

  /**
   * Render the section navigation sidebar
   * @private
   */
  renderSectionNav() {
    const sidebar = this.querySelector('#sidebar');
    if (!sidebar) {
      return;
    }

    // Filter sections for navigation (only show main headers + individual context items)
    const navSections = this._sections.filter(section => {
      // Show system sections
      if (section.type === 'system' || section.type === 'plan-mode') {
        return true;
      }
      // Show context items header and individual context items
      if (section.type === 'context-items-header' || section.type === 'context-item' || section.type === 'context-items-empty') {
        return true;
      }
      // Show conversation header and current instruction header
      if (section.type === 'conversation-header' || section.type === 'current-header') {
        return true;
      }
      return false;
    });

    // Group sections by category
    /** @type {{ system: ContextSection[], contextItems: ContextSection[], conversation: ContextSection[] }} */
    const groups = {
      system: [],
      contextItems: [],
      conversation: []
    };

    navSections.forEach(section => {
      if (section.type === 'system' || section.type === 'plan-mode') {
        groups.system.push(section);
      } else if (section.type === 'context-item' || section.type === 'context-items-header' || section.type === 'context-items-empty') {
        groups.contextItems.push(section);
      } else if (section.type === 'conversation-header' || section.type === 'current-header') {
        groups.conversation.push(section);
      }
    });

    const html = [];

    // System sections
    if (groups.system.length > 0) {
      html.push('<div class="section-group">');
      html.push('<div class="section-group-title">System</div>');
      groups.system.forEach(section => {
        html.push(`<button class="section-link" data-offset="${section.offset}">${escapeHtml(section.label)}</button>`);
      });
      html.push('</div>');
    }

    // Context Items sections
    if (groups.contextItems.length > 0) {
      html.push('<div class="section-group">');
      html.push('<div class="section-group-title">Context Items</div>');
      groups.contextItems.forEach(section => {
        html.push(`<button class="section-link" data-offset="${section.offset}">${escapeHtml(section.label)}</button>`);
      });
      html.push('</div>');
    }

    // Conversation sections (both history and current instruction)
    if (groups.conversation.length > 0) {
      html.push('<div class="section-group">');
      html.push('<div class="section-group-title">Conversation</div>');
      groups.conversation.forEach(section => {
        html.push(`<button class="section-link" data-offset="${section.offset}">${escapeHtml(section.label)}</button>`);
      });
      html.push('</div>');
    }

    sidebar.innerHTML = html.join('');

    // Add click handlers
    const links = sidebar.querySelectorAll('.section-link');
    links.forEach(link => {
      link.addEventListener('click', () => {
        const offset = parseInt(link.getAttribute('data-offset') || '0', 10);
        this.scrollToOffset(offset);
      });
    });
  }


  /**
   * Copy context to clipboard
   * @private
   * @returns {Promise<void>}
   */
  async copyToClipboard() {
    try {
      await copyToClipboard(this._contextText);

      // Show feedback
      const copyButton = this.querySelector('#copy-button');
      if (copyButton) {
        const originalText = copyButton.innerHTML;
        // 20px, the size of the copy icon it stands in for.
        copyButton.innerHTML = `
          ${withAttrs(CHECK_SVG, { width: '20px', height: '20px' })}
          Copied!
        `;
        copyButton.classList.add('copied');

        setTimeout(() => {
          copyButton.innerHTML = originalText;
          copyButton.classList.remove('copied');
        }, 2000);
      }
    } catch (err) {
      console.error('[ContextPreviewModal] Failed to copy to clipboard:', err);
      await showAlert(/** @type {Error} */ (err).message, 'Copy Failed');
    }
  }

  /**
   * Scroll to a specific character offset in the context
   * @private
   * @param {number} offset - Character offset
   */
  scrollToOffset(offset) {
    const anchor = this.querySelector(`#section-${offset}`);
    if (anchor) {
      anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
}

customElements.define('context-preview-modal', ContextPreviewModal);
