//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What a conversation with no history says before its first message: the
 * composer gestures a first-time user has no way to guess and the keys that
 * move between conversations, then one rolling tip
 * ({@link module:components/empty-hint-tips}) for everything past those.
 *
 * Two places show it, and exactly one of them at a time. A conversation with
 * nothing to ask floats it over the empty background (`conversation-empty-hint`,
 * positioned from {@link module:components/conversation-area}); a conversation
 * still being asked where it works carries it inside the setup card instead, so
 * the question and the instructions read as one block. Both take the stack from
 * here, because two copies of the same lines is how the overlay and the
 * card start disagreeing about what the composer does.
 *
 * It is read every time a conversation is opened before its first message, so it
 * stays plain instruction rather than voice; the composer's own placeholder
 * carries that.
 * @module components/empty-hint-stack
 */

import keyShortcutManager, { formatBindingLabel, isMac } from '../services/key-shortcut-manager.js';
import { escapeHtml } from '../../sdk/lib/html.js';
import { t } from '../../sdk/lib/i18n.js';
import './empty-hint-tips.js';

/**
 * The key a conversation-stepping command answers to, as the hint names it: the
 * last of its bindings, which by default is the cross-platform Page key rather
 * than the macOS-only chord it is advertised by elsewhere — the hint teaches
 * the one key that works everywhere. A user override is the command's only
 * binding, so a rebinding shows here as it is.
 * @param {string} id - `prev-tab` or `next-tab`.
 * @returns {string} The key's label, or '' when the command has no key here.
 */
function pageKey(id) {
  const bindings = keyShortcutManager.getBindings(id);
  const binding = bindings[bindings.length - 1];
  return binding ? keyShortcutManager.formatKeyBinding(binding) : '';
}

/**
 * The hint's content as one block.
 *
 * The key glyphs come from the shortcut formatter, so they read ↵ / ⇧↵ on macOS
 * and Enter / Shift+Enter elsewhere. Neither row is true on a touch composer,
 * where Enter inserts a newline and sending is a button — those rows and the
 * drag-and-drop line are hidden by the same `(hover: none) and (pointer:
 * coarse)` media query the composer keys its behaviour off. So are the
 * conversation-switching rows, which a touch screen has no keys for; Ctrl+Tab's
 * row is left out altogether in a browser tab, which keeps that key for itself.
 *
 * Everything sits in one `.empty-hint-stack` so the overlay's fit test can
 * measure the content as a single block.
 * @returns {string} The stack's markup.
 */
export function emptyHintStackMarkup() {
  const mac = isMac();
  const send = formatBindingLabel({ key: 'Enter' }, mac);
  const newline = formatBindingLabel({ key: 'Enter', shift: true }, mac);
  const prevTab = pageKey('prev-tab');
  const nextTab = pageKey('next-tab');
  const recentTab = keyShortcutManager.formatBinding('recent-tab');
  const switchRow = prevTab && nextTab ? `
        <div class="empty-hint-row empty-hint-row--nav empty-hint-pointer">
          <span class="empty-hint-key-pair"><span class="empty-hint-key">${escapeHtml(prevTab)}</span><span class="empty-hint-key">${escapeHtml(nextTab)}</span></span><span class="empty-hint-label">${escapeHtml(t('Switch conversation'))}</span>
        </div>` : '';
  const recentRow = recentTab ? `
        <div class="empty-hint-row empty-hint-row--nav empty-hint-pointer">
          <span class="empty-hint-key">${escapeHtml(recentTab)}</span><span class="empty-hint-label">${escapeHtml(t('Previous conversation'))}</span>
        </div>` : '';
  return `
    <div class="empty-hint-stack">
      <p class="empty-hint-lead empty-hint-lead--title">${escapeHtml(t('Type your message below'))}</p>
      <div class="empty-hint-keys">
        <div class="empty-hint-row empty-hint-pointer">
          <span class="empty-hint-key">${send}</span><span class="empty-hint-label">${escapeHtml(t('Send'))}</span>
        </div>
        <div class="empty-hint-row empty-hint-pointer">
          <span class="empty-hint-key">${newline}</span><span class="empty-hint-label">${escapeHtml(t('New line'))}</span>
        </div>
        <div class="empty-hint-row">
          <span class="empty-hint-key">@</span><span class="empty-hint-label">${escapeHtml(t('Reference a file'))}</span>
        </div>
        <div class="empty-hint-row">
          <span class="empty-hint-key">/</span><span class="empty-hint-label">${escapeHtml(t('Run a command'))}</span>
        </div>${switchRow}${recentRow}
      </div>
      <p class="empty-hint-lead empty-hint-pointer">${escapeHtml(t('Drag-and-drop a file or image to attach it'))}</p>
      <empty-hint-tips class="empty-hint-tips"></empty-hint-tips>
    </div>
  `;
}
