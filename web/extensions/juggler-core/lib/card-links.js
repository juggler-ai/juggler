//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The paths a card's status row names, as links that open them on the Pinboard.
 *
 * Two kinds: a path the item knows (a read's file, a search's folder) is linked
 * outright by {@link cardFile}; a command line, whose paths are only words
 * in it, is opted in by {@link commandLine} for the host to scan. Either way the
 * link is the element a file reference in a reply is, so a click, a key and a
 * right-click on it do the same thing everywhere.
 * @module lib/card-links
 */

import { basename } from 'juggler/item-utils';
import { htmlSlots } from 'juggler/i18n';
import { createFileRefLink, createHighlightedCode, withNodes } from 'juggler/ui';
import { absolutePathKey } from '../context-items/path-approval.js';

/** A POSIX, drive-letter or UNC absolute path, as absolutePathKey writes one. */
const ABSOLUTE_RE = /^(\/|[A-Za-z]:\/)/;

/**
 * A link in one placeholder of a translated message: the params that put the
 * slot in the `t()` call, and the function that fills it in the result.
 *
 *     const slot = linkSlot('file', () => link());
 *     return slot.fill(t('Created {file}', slot.params));
 *
 * The link is built per fill, since an element can only be in one place.
 * @param {string} name - The placeholder.
 * @param {() => string|Node} link - Builds what goes in it.
 * @returns {{params: Record<string, unknown>, fill: (message: string) => HTMLElement}} The pair.
 */
export function linkSlot(name, link) {
  return {
    params: htmlSlots({ [name]: '' }),
    fill: (message) => withNodes(message, { [name]: link() }),
  };
}

/**
 * A path a card names, ready for its status row.
 *
 * `link(label)` is the path as a link to it, showing `label` (`options.label`
 * by default). A relative path resolves against the tree the item works in —
 * its conversation's workspace, else the project — which is where the tool
 * resolved it. With no path, or no root to resolve a relative one against, it
 * is the bare label. `slot` puts that link in a message's `{slotName}`
 * placeholder.
 * @param {import('juggler/context-item').default} item - The item drawing the card.
 * @param {string} path - The path, as the tool was given it or reported it; '' for none.
 * @param {object} [options]
 * @param {string} [options.slotName] - The placeholder `slot` fills (default `file`).
 * @param {string} [options.fallback] - The name shown when there is no path.
 * @param {string} [options.label] - What the link shows (default: the name).
 * @returns {{name: string, link: (label?: string) => HTMLElement|string, slot: ReturnType<typeof linkSlot>}}
 *   The path's last segment, the link builder, and its message slot.
 */
export function cardFile(item, path, { slotName = 'file', fallback = '', label: shown = '' } = {}) {
  const name = basename(path) || path || fallback;
  /**
   * @param {string} [label] - What the link shows
   * @returns {HTMLElement|string} The link, or the bare label
   */
  const link = (label = shown || name) => {
    if (!path) return label;
    const root = item.getWorkspaceRoot?.() || /** @type {any} */ (item.session)?.projectPath;
    const absolute = absolutePathKey(root ? { projectPath: root } : null, path);
    return ABSOLUTE_RE.test(absolute) ? createFileRefLink(label, absolute) : label;
  };
  return { name, link, slot: linkSlot(slotName, link) };
}

/**
 * Text and elements side by side, as one summary element — a link with a
 * suffix such as `…` or a warning after it.
 * @param {...(string|Node)} parts - What to show, in order.
 * @returns {HTMLElement} A span holding them.
 */
export function inlineSummary(...parts) {
  const span = document.createElement('span');
  span.append(...parts);
  return span;
}

/**
 * A highlighted command line, opted in with `data-file-refs` so the host turns
 * the paths it names into links to the files.
 * @param {string} command - The command as the card shows it.
 * @returns {HTMLElement} The highlighted command.
 */
export function commandLine(command) {
  const el = createHighlightedCode(command, 'bash');
  el.setAttribute('data-file-refs', '');
  return el;
}
