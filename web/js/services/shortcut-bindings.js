//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Wires the session-scoped command shortcuts to their behaviour. The key table
 * itself lives in the KeyShortcutManager; here we only attach handlers for the
 * conversation-level commands, which need the live session. Other commands
 * (undo/redo, zoom, strategy-switch) register themselves from the components
 * that own them.
 * @module services/shortcut-bindings
 */

import keyShortcutManager from './key-shortcut-manager.js';
import {
  createNewConversation,
  binActiveConversation,
  renameActiveConversation,
  jumpToAttentionConversation,
  toggleActiveFileEditing,
} from './conversation-commands.js';
import { markSeen } from './tips-manager.js';
import { getModelSelector } from './model-cycler.js';
import findBar from '../components/find-bar.js';

/**
 * Register the conversation command handlers and install the global dispatcher.
 * Idempotent: re-registering (e.g. on reconnect with a fresh session) simply
 * rebinds the handlers to the current session.
 *
 * Learn-by-doing: a shortcut whose id also names an onboarding tip retires that
 * tip the moment the user actually uses the key — so a user already fluent with
 * ⌘J/⌘N/etc. is never told about it. For commands that report whether they acted
 * (jump/toggle), we only retire on a real action, so an inapplicable press (no
 * flagged conversation) doesn't spend the tip.
 * @param {import('../model/session.js').default} session
 * @returns {void}
 */
export function registerConversationShortcuts(session) {
  // new/bin always "handle" the key (they attempt on the visible conversation);
  // jump/toggle report whether they acted so an inapplicable press falls through.
  keyShortcutManager.register('new-conversation', () => { createNewConversation(); markSeen('new-conversation'); return true; });
  keyShortcutManager.register('bin-conversation', () => { binActiveConversation(); markSeen('bin-conversation'); return true; });
  keyShortcutManager.register('rename-conversation', () => { renameActiveConversation(); markSeen('rename-conversation'); return true; });
  // Prev/next-tab (Page Up/Down everywhere, ⌥⌘↑/↓ on macOS) reuse the conversation
  // bar's existing cycle path: the same juggler:cycle-tab event the native
  // Ctrl+Tab accelerator fires, which moves to the adjacent tab (wrapping) and
  // commits focus to its composer. Always "handles" the key.
  keyShortcutManager.register('prev-tab', () => {
    window.dispatchEvent(new CustomEvent('juggler:cycle-tab', { detail: { direction: 'prev' } }));
    markSeen('prev-tab');
    return true;
  });
  keyShortcutManager.register('next-tab', () => {
    window.dispatchEvent(new CustomEvent('juggler:cycle-tab', { detail: { direction: 'next' } }));
    markSeen('next-tab');
    return true;
  });
  keyShortcutManager.register('jump-to-attention', () => {
    const acted = jumpToAttentionConversation(session);
    if (acted) markSeen('jump-to-attention');
    return acted;
  });
  keyShortcutManager.register('toggle-file-editing', () => {
    const acted = toggleActiveFileEditing(session);
    if (acted) markSeen('toggle-file-editing');
    return acted;
  });
  // Find-in-conversation opens/refocuses the find bar against the active
  // conversation-area column (the focused column of the visible tab). ⌘F never
  // closes — it opens if closed and focuses+selects-all if already open, so
  // repeated presses behave like the platform find field (Esc / ✕ close). Falls
  // through (returns false) when there's no conversation column to search, so
  // the browser's native find still works on empty/project-picker views.
  keyShortcutManager.register('find-in-conversation', () => {
    const tab = /** @type {any} */ (document.querySelector('conversation-tab.active'));
    const column = tab?.getActiveConversationColumn?.();
    if (!column) return false;
    findBar.open(column);
    markSeen('find-in-conversation');
    return true;
  });
  // Opens the model picker and leaves it open — the counterpart to ⌥⌘M, which
  // shows the same picker as a HUD that closes with the modifiers. The picker
  // takes the keyboard itself once open (filter, arrows, Enter, Escape) from a
  // document-capture listener, so nothing further is wired here. Targets the
  // same selector the cyclers do: the focused column's, so a sub-thread composer
  // drives its own. Falls through (returns false) where there is no selector at
  // all — the project picker, an empty window.
  keyShortcutManager.register('open-model-picker', () => {
    const selector = getModelSelector();
    if (!selector) return false;
    selector.open();
    return true;
  });
  keyShortcutManager.install();
}
