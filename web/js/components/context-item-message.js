//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseMessage from './base-message.js';
import { renderResultStatusMessage } from '../../sdk/lib/html.js';
import { wrapWithIcon, TYPE_ICONS } from '../utils/icon-message-renderer.js';
import { iconOptionsForItem } from '../utils/item-badge.js';
import { capabilityLabel, capabilityTitle } from '../utils/capability-label.js';

/**
 * Context item message component - icon + custom content with plugin icon support
 */
class ContextItemMessage extends BaseMessage {
  static get observedAttributes() {
    return ['item-id', 'item-type', 'error', 'color-preset', 'icon'];
  }

  get itemId() {
    return this.getAttribute('item-id');
  }

  get itemType() {
    return this.getAttribute('item-type') || 'unknown';
  }

  get error() {
    return this.getAttribute('error');
  }

  get colorPreset() {
    return this.getAttribute('color-preset') || 'slate';
  }

  get icon() {
    return this.getAttribute('icon');
  }

  render() {
    const article = document.createElement('article');
    article.className = 'context-item';

    // Get context item instance for enhanced rendering
    const messageThread = this._getMessageThread();
    const contextItem = this.itemId ? messageThread?.getContextItem(this.itemId) : null;
    const itemType = contextItem?.type || this.itemType;
    // The manifest name is the capability's English; a bare type id is an identifier.
    const manifest = contextItem?.getManifest?.();
    const manifestName = manifest?.name ? capabilityLabel(manifest.name, manifest.id) : itemType;

    // Handle error case
    if (this.error) {
      const content = renderResultStatusMessage({ typeName: manifestName, summary: this.error, status: 'error' });
      article.appendChild(wrapWithIcon(content, {
        color: 'red',
        iconSvg: TYPE_ICONS.error
      }));
      this.replaceChildren(article);
      return;
    }

    const title = contextItem?.getTitle ? capabilityTitle(contextItem) || '' : '';

    // Icon + colour from the one shared resolver, so this tile and the
    // properties-panel header always paint the same badge.
    const iconOptions = contextItem
      ? iconOptionsForItem(contextItem, { messageThread })
      : { color: this.colorPreset, iconClass: this.icon || undefined, iconSvg: this.icon ? undefined : TYPE_ICONS.context };

    // Build status content via getStatusUI → renderResultStatusMessage
    const statusConfig = contextItem?.getStatusUI?.() ?? { typeName: manifestName, summary: title };
    const content = renderResultStatusMessage(statusConfig);

    article.appendChild(wrapWithIcon(content, iconOptions));

    this.replaceChildren(article);
  }
}

customElements.define('context-item-message', ContextItemMessage);
