//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A capability's own English labels — its `MANIFEST.name`, its static type
 * label, the base `getTitle()` — translated in the catalogue of the extension
 * that ships it. `scripts/i18n` extracts every manifest name into that
 * catalogue; the SDK cannot know the owning extension, so the host translates
 * where it reads them.
 * @module capability-label
 */

import contextItemRegistry from '../registries/context-item-registry.js';
import { t } from '../../sdk/lib/i18n.js';

/**
 * Translate a label a capability supplies (its static type label or manifest
 * name) in its own extension's catalogue, then core's.
 * @param {string} label - The capability's English label
 * @param {string|null|undefined} pluginId - The capability's registry id, or null
 * @param {{getExtensionId: (id: string) => string|null}} [registry] - The
 *   registry the capability is registered in; context items by default (a
 *   pinboard item type passes the pinboard item registry)
 * @returns {string} The label in the active locale
 */
export function capabilityLabel(label, pluginId, registry = contextItemRegistry) {
  const namespace = (pluginId && registry.getExtensionId(pluginId)) || undefined;
  return t(label, undefined, { namespace });
}

/**
 * A capability instance's `getTitle()`, in the active locale. A title that is
 * the capability's English manifest name (the base default) is translated in
 * its extension's catalogue; any other title is the plugin's own — already
 * translated, or data such as a path — and is returned as it is.
 * @param {{getTitle: () => string}} item - Context-item or action instance
 * @returns {string} The title
 */
export function capabilityTitle(item) {
  const title = item.getTitle();
  const ctor = item.constructor;
  const manifest = 'MANIFEST' in ctor
    ? /** @type {{id: string, name: string}|undefined} */ (ctor.MANIFEST)
    : undefined;
  return title && title === manifest?.name ? capabilityLabel(title, manifest.id) : title;
}
