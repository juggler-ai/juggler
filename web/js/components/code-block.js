//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import JugglerElement from './juggler-element.js';
import { registerContextMenuProvider, codeReferenceMenuItem } from '../services/context-menu-service.js';
import { isAbsolutePath } from '../utils/code-selection.js';
import { copyToClipboard } from '../../sdk/lib/clipboard.js';
import { highlightCode } from '../../sdk/lib/syntax-highlight.js';
import { showAlert } from './modal-dialog.js';
import { t } from '../../sdk/lib/i18n.js';
import { escapeHtml } from '../../sdk/lib/html.js';

/**
 * Code block component with syntax highlighting and copy functionality.
 * Highlighting goes through the shared `highlightCode` engine (Prism-backed,
 * with a safe escaped-text fallback) — the same one used by tile summaries and
 * properties-panel subsections.
 */
class CodeBlock extends JugglerElement {
  static get observedAttributes() {
    return ['language', 'code'];
  }

  connectedCallback() {
    // Drawn on the first connect, in the UI language of that moment, and
    // redrawn after that only by an attribute change: a move keeps the
    // highlighting it did and a Copied! it is showing.
    if (!this.firstElementChild) this.render();
  }

  attributeChangedCallback() {
    // A detached block waits for its first connect to draw.
    if (this.isConnected) this.render();
  }

  get language() {
    return this.getAttribute('language') || 'plaintext';
  }

  get code() {
    return this.getAttribute('code') || '';
  }

  async copyCode() {
    try {
      await copyToClipboard(this.code);
      this.showCopiedFeedback();
    } catch (error) {
      console.error('[CodeBlock] Failed to copy:', error);
      await showAlert(/** @type {Error} */ (error).message, t('Copy Failed'));
    }
  }

  showCopiedFeedback() {
    const button = /** @type {HTMLElement|null} */(this.querySelector('.copy-btn'));
    if (button) {
      const originalText = button.textContent;
      button.textContent = t('✓ Copied!');
      button.classList.add('copied');
      setTimeout(() => {
        button.textContent = originalText;
        button.classList.remove('copied');
      }, 2000);
    }
  }

  render() {
    const highlightedHTML = highlightCode(this.code, this.language);

    this.innerHTML = `
            <header class="code-header">
                <span class="language">${escapeHtml(this.language)}</span>
                <button class="copy-btn" type="button">${escapeHtml(t('Copy'))}</button>
            </header>
            <pre class="code-block-pre"><code class="syntax-highlight language-${escapeHtml(this.language)}">${highlightedHTML}</code></pre>
        `;
    const copyBtn = this.querySelector('.copy-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => this.copyCode());
    }
  }
}

customElements.define('code-block', CodeBlock);

// Right-click menu for code blocks: copy the raw code (and the file path when
// the block carries one). Reads off the <code-block> element's own attributes.
//
// The paste-reference row is offered here rather than left to the text-edit
// menu, which this provider is reached before and so would hide. A block renders
// one flat <pre>, not numbered rows, so the reference names the file and quotes
// the selection without claiming line numbers it cannot know.
registerContextMenuProvider({
  match: (start) => start?.closest('code-block') || null,
  build: (subject) => {
    const code = subject.getAttribute('code') || '';
    const filePath = subject.getAttribute('data-file-path') || '';
    /** @type {import('../services/context-menu-service.js').ContextMenuItem[]} */
    const items = [{
      label: t('Copy code'),
      disabled: !code,
      onClick: () => { void copyToClipboard(code).catch(() => {}); },
    }];
    if (filePath) {
      items.push({
        label: t('Copy file path'),
        onClick: () => { void copyToClipboard(filePath).catch(() => {}); },
      });
      const paste = codeReferenceMenuItem({
        path: filePath,
        outOfRoot: isAbsolutePath(filePath),
        within: subject,
      });
      if (paste) items.push(paste);
    }
    return items;
  },
});
