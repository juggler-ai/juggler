//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What a conversation with no history says before its first message: the four
 * composer gestures a first-time user has no way to guess, then the hint's
 * guidance slot ({@link module:components/juggler-nudge}, surface
 * `empty-hint`, usually empty) and one rolling tip
 * ({@link module:components/empty-hint-tips}) for everything past the composer.
 *
 * Two places show it, and exactly one of them at a time. A conversation with
 * nothing to ask floats it over the empty background (`conversation-empty-hint`,
 * positioned from {@link module:components/conversation-area}); a conversation
 * still being asked where it works carries it inside the setup card instead, so
 * the question and the instructions read as one block. Both take the stack from
 * here, because two copies of the same four lines is how the overlay and the
 * card start disagreeing about what the composer does.
 *
 * It is read every time a conversation is opened before its first message, so it
 * stays plain instruction rather than voice; the composer's own placeholder
 * carries that.
 * @module components/empty-hint-stack
 */

import { formatBindingLabel, isMac } from '../services/key-shortcut-manager.js';
import { escapeHtml } from '../../sdk/lib/html.js';
import { t } from '../../sdk/lib/i18n.js';
import './empty-hint-tips.js';
import './juggler-nudge.js';

/**
 * The hint's content as one block.
 *
 * The key glyphs come from the shortcut formatter, so they read ↵ / ⇧↵ on macOS
 * and Enter / Shift+Enter elsewhere. Neither row is true on a touch composer,
 * where Enter inserts a newline and sending is a button — those rows and the
 * drag-and-drop line are hidden by the same `(hover: none) and (pointer:
 * coarse)` media query the composer keys its behaviour off.
 *
 * Everything sits in one `.empty-hint-stack` so the overlay's fit test can
 * measure the content as a single block.
 * @returns {string} The stack's markup.
 */
export function emptyHintStackMarkup() {
  const mac = isMac();
  const send = formatBindingLabel({ key: 'Enter' }, mac);
  const newline = formatBindingLabel({ key: 'Enter', shift: true }, mac);
  return `
    <div class="empty-hint-stack">
      <p class="empty-hint-lead">${escapeHtml(t('Type your message below'))}</p>
      <div class="empty-hint-keys">
        <div class="empty-hint-row empty-hint-pointer">
          <span class="empty-hint-key">${send}</span><span>${escapeHtml(t('Send'))}</span>
        </div>
        <div class="empty-hint-row empty-hint-pointer">
          <span class="empty-hint-key">${newline}</span><span>${escapeHtml(t('New line'))}</span>
        </div>
        <div class="empty-hint-row">
          <span class="empty-hint-key">@</span><span>${escapeHtml(t('Reference a file'))}</span>
        </div>
        <div class="empty-hint-row">
          <span class="empty-hint-key">/</span><span>${escapeHtml(t('Run a command'))}</span>
        </div>
      </div>
      <p class="empty-hint-lead empty-hint-pointer">${escapeHtml(t('Drag-and-drop a file or image to attach it'))}</p>
      <juggler-nudge surface="empty-hint" class="juggler-nudge empty-hint-nudge" hidden></juggler-nudge>
      <empty-hint-tips class="empty-hint-tips"></empty-hint-tips>
    </div>
  `;
}

export default emptyHintStackMarkup;
