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
import findBar, { findPanelFor } from '../components/find-bar.js';

/**
 * Step the visible tab's item selection one item up or down.
 * @param {'prev'|'next'} direction
 * @returns {boolean} True when there was a conversation column to step in.
 */
function stepActiveTabSelection(direction) {
  const tab = /** @type {any} */ (document.querySelector('conversation-tab.active'));
  return tab?.stepItemSelection?.(direction) ?? false;
}

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
  // Move-tab (⇧Page Up/Down) moves the visible tab past its neighbour in the
  // conversation bar. Always "handles" the key, a press at the edge of the tab's
  // list included, so the Shift-ed Page key never falls through to select text
  // in a composer the dispatcher has already judged to have nothing to page.
  keyShortcutManager.register('move-tab-up', () => {
    window.dispatchEvent(new CustomEvent('juggler:move-tab', { detail: { direction: 'up' } }));
    return true;
  });
  keyShortcutManager.register('move-tab-down', () => {
    window.dispatchEvent(new CustomEvent('juggler:move-tab', { detail: { direction: 'down' } }));
    return true;
  });
  // Select-prev/next-item (⌥↑/↓) walk the visible tab's active column the way
  // plain ↑/↓ do from outside a text field, but from anywhere — the composer
  // included, where focus stays put. Falls through where there is no
  // conversation to walk, so the field keeps its own meaning for the key.
  keyShortcutManager.register('select-prev-item', () => stepActiveTabSelection('prev'));
  keyShortcutManager.register('select-next-item', () => stepActiveTabSelection('next'));
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
  // Find opens/refocuses the find bar against the panel the user is in: the
  // nearest find-capable ancestor of whatever holds focus (so a composer means
  // its own column, and a clicked-into properties panel means that panel), else
  // the visible tab's find column. ⌘F never closes — it opens if closed and
  // focuses+selects-all if already open, so repeated presses behave like the
  // platform find field (Esc / ✕ close). Falls through (returns false) when
  // nothing on screen can be searched, so the browser's native find still works
  // on empty/project-picker views.
  //
  // The pinboard is NOT reached from here. An open board holds a popup token and
  // the manager stands every command down behind an overlay, so the board
  // dispatches ⌘F itself, as it does its other chords.
  keyShortcutManager.register('find-in-conversation', () => {
    const tab = /** @type {any} */ (document.querySelector('conversation-tab.active'));
    const panel = findPanelFor(document.activeElement) || tab?.getFindColumn?.();
    if (!panel) return false;
    findBar.open(panel);
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
