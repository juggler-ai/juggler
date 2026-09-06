//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * KeyShortcutManager — the single source of truth for every keyboard shortcut a
 * user could conceivably rebind.
 *
 * Design intent (customisation-ready, not yet customisable):
 *   - The definition table {@link SHORTCUT_DEFS} lists ALL command-level
 *     shortcuts centrally. Nothing else in the codebase should hard-code a key
 *     combo for a user-facing command; it should look the binding up here (for
 *     matching) or ask this manager to format it (for display).
 *   - Bindings are platform-agnostic: `mod` resolves to ⌘ on macOS and Ctrl on
 *     Windows/Linux, so one definition covers every platform. {@link formatBinding}
 *     renders the platform-correct label for settings and tooltips.
 *   - Definitions here describe WHAT keys exist. Behaviour is contributed
 *     separately by feature code via {@link KeyShortcutManager#register} — the
 *     same additive-registration pattern used elsewhere — so the edit extension,
 *     the conversation bar, etc. own their own handlers while the key table
 *     stays central.
 *
 * When shortcuts become customisable, only this file changes: swap the static
 * default lookup in {@link KeyShortcutManager#getBinding} for a user-overlay
 * (localStorage / server prefs) keyed by definition id. Everything downstream
 * already reads through that method.
 * @module services/key-shortcut-manager
 */

import { isAnyPopupOpen } from '../utils/popup-manager.js';

/**
 * A platform-agnostic key binding.
 * @typedef {object} KeyBinding
 * @property {boolean} [mod] - The primary command modifier: ⌘ on macOS, Ctrl elsewhere.
 * @property {boolean|undefined} [shift] - Require Shift (true), forbid it (false),
 *   or don't care (undefined). "Don't care" matters for keys like zoom whose
 *   glyph is reached with Shift on some layouts.
 * @property {boolean} [alt] - Require the Alt/Option modifier.
 * @property {string} key - The `KeyboardEvent.key` this binds to, normalized
 *   (single letters lower-case; named keys like 'Backspace'/'Tab' verbatim).
 * @property {string} [displayKey] - Overrides the glyph shown to the user
 *   (e.g. '+' for the '=' key).
 * @property {'mac'} [platform] - Restrict this KEY to a platform family. A
 *   command is bound where its keys are: on any other platform this binding is
 *   not dispatched, not listed and not advertised, so a key we deliberately
 *   left unbound there is never shown. A command whose every binding is
 *   restricted this way disappears from that platform's listings entirely.
 */

/**
 * A shortcut definition — the central, customisable record for one command.
 * @typedef {object} ShortcutDef
 * @property {string} id - Stable identifier used by handlers and tooltips.
 * @property {string} label - Human-readable command name.
 * @property {string} description - One-line explanation for the settings page.
 * @property {string} category - Grouping label for the settings page.
 * @property {KeyBinding} defaultBinding - The shipped binding (future: overridable).
 * @property {KeyBinding[]} [aliasBindings] - Additional shipped keys that trigger
 *   the same command. For a command whose primary chord is unreachable on some
 *   surfaces — a browser reserves ⌘N/Ctrl+N for its own New window and never
 *   delivers it to the page — an alias keeps the command operable there without
 *   giving up the chord that is right everywhere else. The primary binding is
 *   what tooltips advertise; {@link KeyShortcutManager#getBindings} returns the
 *   whole set for matching, and the settings page lists all of them.
 * @property {boolean|'empty'} [allowInInput] - Whether the command may fire while
 *   focus is in a text field. `false` (default): never — don't steal keys while
 *   the user is typing. `true`: always. `'empty'`: only when the field is empty,
 *   so a live edit still runs natively (e.g. ⌘⌫ deletes to line start in a
 *   non-empty composer, but bins the conversation when the composer is empty).
 * @property {boolean} [external] - This shortcut's dispatch is owned by a
 *   dedicated controller (e.g. the strategy switcher's hold-to-cycle UX). The
 *   manager still lists it (settings, tooltips) but never dispatches it — the
 *   owner reads {@link KeyShortcutManager#getBinding} and matches itself via
 *   {@link eventMatchesBinding}.
 */

/** @returns {boolean} True on macOS-family platforms (⌘ is the command modifier). */
export function isMac() {
  return typeof navigator !== 'undefined'
    && /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');
}

/**
 * Normalize a `KeyboardEvent.key` for binding comparison: letters lower-case,
 * and the shifted twins of the zoom keys folded onto their base glyph so a
 * binding matches regardless of Shift/layout ('+' → '=', '_' → '-').
 * @param {string} key
 * @returns {string} The normalized key for comparison.
 */
function normalizeKey(key) {
  if (!key) return '';
  if (key === '+') return '=';
  if (key === '_') return '-';
  return key.length === 1 ? key.toLowerCase() : key;
}

/**
 * Does a keyboard event satisfy a binding, accounting for the platform meaning
 * of `mod`? Exported so external controllers (strategy switcher) match against
 * the same central bindings instead of re-hard-coding keys.
 * @param {KeyBinding} binding
 * @param {KeyboardEvent} e
 * @returns {boolean} True when the event satisfies the binding on this platform.
 */
export function eventMatchesBinding(binding, e) {
  const primary = isMac() ? e.metaKey : e.ctrlKey; // the command modifier (⌘ / Ctrl)
  const secondary = isMac() ? e.ctrlKey : e.metaKey; // the other one (⌃ / Meta)
  if (binding.mod) {
    // A command-modifier binding just needs its modifier down; the other one
    // being held too is tolerated (⌘Z and ⌘⌃Z both undo).
    if (!primary) return false;
  } else if (primary || secondary) {
    // A modifier-less binding (e.g. Shift+Tab) must have BOTH command
    // modifiers idle, so ⌃Shift+Tab never triggers a plain-Shift+Tab command.
    return false;
  }
  if (binding.shift !== undefined && !!binding.shift !== e.shiftKey) return false;
  if (!!binding.alt !== e.altKey) return false;
  if (normalizeKey(e.key) === normalizeKey(binding.key)) return true;
  // Physical-key fallback for Tab. On Linux the desktop app's WebKit2GTK webview
  // receives Shift+Tab as the X11 `ISO_Left_Tab` keysym, so `e.key` is not the
  // plain 'Tab' this binding names and the comparison above misses — leaving the
  // strategy-switch chord to fall through to native focus traversal. `e.code`
  // reports the physical key independent of Shift and layout, so it is 'Tab' for
  // the hardware Tab key regardless of the keysym; match on it. The Shift/mod
  // gates above already ran, so this never widens the match beyond the intended
  // modifier combination.
  if (binding.key === 'Tab' && e.code === 'Tab') return true;
  // macOS reports the Option-MODIFIED glyph in `key` (⌥M → 'µ', ⌥T → '†'), so
  // an Alt binding on a plain letter/digit would never match there by `key`
  // alone. Fall back to the physical `code` ('KeyM'/'Digit5') for those
  // bindings. Fallback only — the `key` comparison above stays authoritative,
  // so non-macOS layouts (which report the base letter) are unaffected, and
  // the physical-position assumption in `code` only kicks in where `key` has
  // already been remapped away from anything a binding could name.
  if (binding.alt && typeof e.code === 'string') {
    const k = normalizeKey(binding.key);
    if (/^[a-z]$/.test(k) && e.code === `Key${k.toUpperCase()}`) return true;
    if (/^[0-9]$/.test(k) && e.code === `Digit${k}`) return true;
  }
  return false;
}

/**
 * macOS modifier/named-key glyphs, in Apple's canonical display order.
 * @type {Record<string, string>}
 */
const MAC_KEY_GLYPHS = {
  Backspace: '⌫', Delete: '⌦', Tab: '⇥', Enter: '↵', Return: '↵',
  Escape: '⎋', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  PageUp: '⇞', PageDown: '⇟',
  ' ': 'Space', Space: 'Space',
};

/**
 * Verbose key names for the Windows/Linux "Ctrl+…" style.
 * @type {Record<string, string>}
 */
const NAMED_KEY_LABELS = {
  ' ': 'Space', Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down',
  ArrowLeft: 'Left', ArrowRight: 'Right',
  PageUp: 'Page Up', PageDown: 'Page Down',
};

/**
 * Does a binding ship on the given platform? A binding without a `platform` is
 * every platform's.
 * @param {KeyBinding} binding
 * @param {boolean} mac - True to ask about macOS, false about Windows/Linux.
 * @returns {boolean} True when the binding is bound there.
 */
function bindingShipsOn(binding, mac) {
  return !binding.platform || (binding.platform === 'mac') === mac;
}

/**
 * The glyph/label for a binding's key on an explicit platform. Pure.
 * @param {KeyBinding} binding
 * @param {boolean} mac - True for macOS glyphs, false for Windows/Linux labels.
 * @returns {string} The glyph/label for the binding's key.
 */
function keyGlyphFor(binding, mac) {
  if (binding.displayKey) return binding.displayKey;
  const key = binding.key;
  if (mac && MAC_KEY_GLYPHS[key]) return MAC_KEY_GLYPHS[key];
  if (!mac && NAMED_KEY_LABELS[key]) return NAMED_KEY_LABELS[key];
  return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * Render a binding for an EXPLICIT platform (⌘⇧Z on macOS, "Ctrl+Shift+Z" on
 * Windows/Linux), independent of the running client's navigator. Use when the
 * target platform is known from data rather than the live client — e.g. building
 * a platform-specific help corpus from `session.platform`. Pure; the instance
 * {@link KeyShortcutManager#formatKeyBinding} delegates here with `isMac()`.
 * @param {KeyBinding} binding
 * @param {boolean} mac - True to render for macOS, false for Windows/Linux.
 * @returns {string} The platform-correct key label.
 */
export function formatBindingForPlatform(binding, mac) {
  const keyGlyph = keyGlyphFor(binding, mac);
  if (mac) {
    // Apple order: ⌃ ⌥ ⇧ ⌘ — we use ⌥ ⇧ ⌘.
    let out = '';
    if (binding.alt) out += '⌥';
    if (binding.shift) out += '⇧';
    if (binding.mod) out += '⌘';
    return out + keyGlyph;
  }
  const parts = [];
  if (binding.mod) parts.push('Ctrl');
  if (binding.alt) parts.push('Alt');
  if (binding.shift) parts.push('Shift');
  parts.push(keyGlyph);
  return parts.join('+');
}

/**
 * The central shortcut table. Add a customisable command here and nowhere else.
 * @type {ShortcutDef[]}
 */
const SHORTCUT_DEFS = [
  {
    id: 'jump-to-attention',
    label: 'Jump to conversation needing attention',
    description: 'Switch to the next conversation waiting on you; select its first '
      + 'pending approval, or scroll to the end if it just needs a look.',
    category: 'Conversations',
    defaultBinding: { mod: true, key: 'j' },
    allowInInput: true,
  },
  {
    id: 'new-conversation',
    label: 'New conversation',
    description: 'Create a new conversation and switch to it.',
    category: 'Conversations',
    // shift:false is load-bearing: an omitted shift is *tolerant* (see
    // eventMatchesBinding), so ⌘N and ⇧⌘N would both match — and ⇧⌘N is the New
    // window chord. Pinning shift off keeps this to bare ⌘N so New window opens a
    // window instead of a tab.
    defaultBinding: { mod: true, shift: false, key: 'n' },
    // ⌥N/Alt+N is the alias that works on every surface. Browsers reserve
    // ⌘N/Ctrl+N for their own New window and never deliver it to the page, so in
    // a browser tab the binding above cannot fire at all — only the desktop app
    // reaches this command by that chord, via its native Session ▸ New Tab
    // accelerator. No browser claims ⌥N, and it is free of native text-editing
    // meaning, so it is safe to bind app-wide rather than per-surface.
    aliasBindings: [{ alt: true, key: 'n' }],
    allowInInput: true,
  },
  {
    id: 'new-window',
    label: 'New window',
    description: 'Open a new app window. Desktop app only — in a plain browser tab '
      + 'the key is left to the browser.',
    category: 'Conversations',
    defaultBinding: { mod: true, shift: true, key: 'n' },
    allowInInput: true,
  },
  {
    id: 'prev-tab',
    label: 'Previous conversation',
    description: 'Switch to the conversation above in the tab list (wraps around).',
    category: 'Conversations',
    // ⌥⌘↑/↓ is the established "move between tabs" gesture on the Mac (Discord,
    // others), and macOS is the only place it ships: the Windows/Linux twin,
    // Ctrl+Alt+Up/Down, collides with Intel's screen-rotation hotkeys (and some
    // Linux workspace switching). The binding's `platform` keeps that chord out
    // of the dispatcher and the listings elsewhere, so it is never advertised
    // where it does nothing.
    defaultBinding: { mod: true, alt: true, key: 'ArrowUp', platform: 'mac' },
    // Page Up/Down is the cross-platform key, and off macOS the only one — which
    // is why the command is bound everywhere while that chord is not. Nothing
    // else in the app uses the Page keys: the transcript scroller isn't
    // focusable, so outside a text field they do nothing at all.
    //
    // shift:false is load-bearing (an omitted shift is *tolerant*, see
    // eventMatchesBinding): ⇧⇞ selects a page of text in the composer and stays
    // native. Plain ⇞ there does not — see allowInInput below.
    aliasBindings: [{ shift: false, key: 'PageUp' }],
    // Works while typing. ⌥⌘↑ has no native text-editing meaning (plain ⌘↑ jumps
    // to document start, but the Option makes it distinct), so it never steals a
    // cursor movement; the Page key does take paging away from a long draft, and
    // that trade is deliberate — the composer holds focus almost all the time, so
    // a tab-switch key that stood down there would be a key that never fires.
    allowInInput: true,
  },
  {
    id: 'next-tab',
    label: 'Next conversation',
    description: 'Switch to the conversation below in the tab list (wraps around).',
    category: 'Conversations',
    defaultBinding: { mod: true, alt: true, key: 'ArrowDown', platform: 'mac' },
    aliasBindings: [{ shift: false, key: 'PageDown' }],
    allowInInput: true,
  },
  {
    id: 'bin-conversation',
    label: 'Move conversation to bin',
    description: 'Move the current conversation to the bin.',
    category: 'Conversations',
    // Fires from the composer only when it's empty, so it works when you'd press
    // it (the composer is focused most of the time) without hijacking ⌘⌫ /
    // Ctrl+Backspace "delete to line start" while there's text to delete.
    defaultBinding: { mod: true, key: 'Backspace' },
    allowInInput: 'empty',
  },
  {
    id: 'toggle-file-editing',
    label: 'Toggle file edit permission',
    description: 'Allow or ask-before file edits for the current conversation.',
    category: 'Conversations',
    defaultBinding: { mod: true, key: 'e' },
    allowInInput: true,
  },
  {
    id: 'rename-conversation',
    label: 'Rename conversation',
    description: 'Rename the current conversation (opens the tab\u2019s inline name '
      + 'editor). Also on Return when the tab bar itself is focused.',
    category: 'Conversations',
    // F2 is the cross-platform rename key (Explorer/most tree views on
    // Windows/Linux; unclaimed on macOS, so it's safe to bind app-wide). It has
    // no native meaning in a text field, so allowInInput lets it fire straight
    // from the composer. The Return alias is dispatched by the conversation bar
    // itself, scoped to tab-list focus (see conversation-bar.js keydown).
    defaultBinding: { key: 'F2' },
    allowInInput: true,
  },
  {
    id: 'pause-conversation',
    label: 'Pause conversation',
    description: 'Stops as soon as possible without interrupting any tool'
      + ' uses or in-flight LLM responses. Trades places with plain Escape under'
      + ' some Escape-key behaviours (see below).',
    category: 'Conversations',
    // Dispatched externally: both Escape keydown handlers (conversation-tab.js and
    // composer.js) delegate to escape-behaviour.js, which routes Shift+Escape to
    // whichever stop the plain key isn't bound to — a polite pause under the
    // default. The manager lists it (Settings, tooltips, onboarding tip) but never
    // dispatches it.
    defaultBinding: { shift: true, key: 'Escape' },
    allowInInput: true,
    external: true,
  },
  {
    id: 'find-in-conversation',
    label: 'Find in conversation',
    description: 'Open the find bar to search for text in the current conversation.',
    category: 'Search',
    // Works while typing in the composer — the find bar is a search overlay, so
    // it must be reachable without first leaving the text field.
    defaultBinding: { mod: true, key: 'f' },
    allowInInput: true,
  },
  {
    id: 'undo',
    label: 'Undo',
    description: 'Undo the last change in the current conversation.',
    category: 'Editing',
    // Not in text fields — the composer has its own native undo.
    defaultBinding: { mod: true, shift: false, key: 'z' },
    allowInInput: false,
  },
  {
    id: 'redo',
    label: 'Redo',
    description: 'Redo the last undone change in the current conversation.',
    category: 'Editing',
    defaultBinding: { mod: true, shift: true, key: 'z' },
    allowInInput: false,
  },
  {
    id: 'zoom-in',
    label: 'Zoom in',
    description: 'Increase the interface zoom level.',
    category: 'View',
    defaultBinding: { mod: true, key: '=', displayKey: '+' },
    allowInInput: true,
  },
  {
    id: 'zoom-out',
    label: 'Zoom out',
    description: 'Decrease the interface zoom level.',
    category: 'View',
    defaultBinding: { mod: true, key: '-', displayKey: '−' },
    allowInInput: true,
  },
  {
    id: 'toggle-tool-grouping',
    label: 'Group consecutive tool uses',
    description: 'Collapse runs of adjacent tool uses into a single group item, or '
      + 'show them individually again.',
    category: 'View',
    // ⌥⌘G / Ctrl+Alt+G — G for "group"; bare ⌘G is find-next everywhere, so the
    // Option is load-bearing. Fires from the composer (allowInInput) since it is
    // a display-only toggle you reach for while typing, and the command modifier
    // means it never lands as typed text.
    defaultBinding: { mod: true, alt: true, key: 'g' },
    allowInInput: true,
  },
  {
    id: 'toggle-pinboard',
    label: 'Toggle Pinboard',
    description: 'Open or close the pinboard \u2014 the tabbed panel of pinned items '
      + 'behind the right edge of the window.',
    category: 'View',
    // ⌥⌘P / Ctrl+Alt+P — P for pinboard, in the same ⌥⌘ family as the other
    // panel/mode toggles (⌥⌘G, ⌥⌘M, ⌥⌘T). Bare ⌘P is Print in every browser and
    // ⇧⌘P is Firefox's private window, so the Option is load-bearing. Fires from
    // the composer: the command modifier means it never lands as typed text.
    defaultBinding: { mod: true, alt: true, key: 'p' },
    allowInInput: true,
    // Dispatched by the pinboard shell rather than the loop below, because the
    // board holds a popup token while it is open and this command has to fire
    // over its OWN overlay to close it — which the blanket overlay suppression
    // here cannot express.
    external: true,
  },
  {
    id: 'show-shortcuts',
    label: 'Show keyboard shortcuts',
    description: 'Open Settings to this Keyboard shortcuts tab.',
    category: 'View',
    // ⌘/ (Ctrl+/) is the near-universal "show shortcuts" chord (Slack, GitHub,
    // Gmail). It fires from the composer (allowInInput) since it is invoked with
    // the command modifier rather than as ordinary typed text.
    defaultBinding: { mod: true, key: '/' },
    allowInInput: true,
  },
  {
    id: 'strategy-switch',
    label: 'Switch strategy',
    description: 'Cycle the active strategy; hold to open the strategy menu.',
    category: 'Conversations',
    defaultBinding: { shift: true, key: 'Tab' },
    external: true,
  },
  {
    id: 'cycle-model',
    label: 'Switch model',
    description: 'Cycle through recently-used models; hold to open the model menu.',
    category: 'Conversations',
    // ⌥⌘M / Ctrl+Alt+M — bare ⌘M is macOS minimize, so the Option is load-bearing.
    // Dispatched externally by the hold-to-cycle model controller.
    // shift:false is load-bearing too: an omitted shift is *tolerant* (see
    // eventMatchesBinding), so ⇧⌥⌘M would match this as well as open-model-picker
    // — and the cycler matches on its own capture listener, ahead of the command
    // table. Pinning shift off keeps the two chords apart.
    defaultBinding: { mod: true, alt: true, shift: false, key: 'm' },
    allowInInput: true,
    external: true,
  },
  {
    id: 'cycle-thinking',
    label: 'Switch thinking level',
    description: 'Cycle the current model\u2019s thinking level; hold to open the level popover.',
    category: 'Conversations',
    // ⌥⌘T / Ctrl+Alt+T — bare ⌘T is the browser new-tab key, deliberately avoided.
    // Dispatched externally by the hold-to-cycle thinking controller.
    defaultBinding: { mod: true, alt: true, key: 't' },
    allowInInput: true,
    external: true,
  },
  {
    id: 'open-model-picker',
    label: 'Open model picker',
    description: 'Open the model picker and leave it open, so the list can be read '
      + 'rather than cycled. Type to filter, arrows to move, Enter to pick, Escape to close.',
    category: 'Conversations',
    // ⇧⌥⌘M / Ctrl+Alt+Shift+M — the Shift-ed twin of the model cycler's chord,
    // which pins shift:false so exactly one of the two fires. The Option is
    // inherited from that pairing and is load-bearing anyway: bare ⌘M is macOS
    // minimize.
    defaultBinding: { mod: true, alt: true, shift: true, key: 'm' },
    // Pressed from the composer, which is where the model being picked is about
    // to be used.
    allowInInput: true,
  },
];

/**
 * @param {EventTarget|null} target
 * @returns {boolean} True when the target is a text field / editable element.
 */
function isEditableTarget(target) {
  const el = /** @type {HTMLElement|null} */ (target);
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/**
 * @param {EventTarget|null} target
 * @returns {boolean} True when the editable target holds no text (nothing to edit).
 */
function isEditableEmpty(target) {
  const el = /** @type {any} */ (target);
  if (!el) return true;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return (el.value ?? '').length === 0;
  if (el.isContentEditable) return (el.textContent ?? '').length === 0;
  return true;
}

class KeyShortcutManager {
  constructor() {
    /** @type {Map<string, ShortcutDef>} @private */
    this._defs = new Map(SHORTCUT_DEFS.map((d) => [d.id, d]));
    /**
     * Future user overrides (id → binding). Empty today; {@link getBinding}
     * already prefers it, so making shortcuts customisable is a localized change.
     * @type {Map<string, KeyBinding>} @private
     */
    this._overrides = new Map();
    /** @type {Map<string, function(KeyboardEvent): (boolean|undefined)>} @private */
    this._handlers = new Map();
    /** @type {boolean} @private */
    this._installed = false;
    this._onKeyDown = this._onKeyDown.bind(this);
  }

  /** Install the single global keydown dispatcher. Idempotent. */
  install() {
    if (this._installed || typeof document === 'undefined') return;
    this._installed = true;
    document.addEventListener('keydown', this._onKeyDown);
  }

  /**
   * Whether app-level command shortcuts and background/window-level navigation
   * handlers must stand down right now because an overlay (modal, settings
   * panel, dropdown) owns interaction. The SINGLE source of truth for "is a
   * popup capturing the keyboard": the central dispatcher below consults it, and
   * the document-level navigation handlers that act on the app BEHIND focus
   * (conversation arrow-nav, tab-list nav) call it too — instead of each one
   * re-deriving the answer, or forgetting to. Element-scoped handlers (a
   * focused input, a menu's own keys) don't need it: they only fire when their
   * own surface is focused, which by definition IS the active layer.
   *
   * Escape/Back are deliberately NOT gated here — they're the dismissal gesture,
   * owned by popup-manager, which stops Escape at document before background
   * handlers see it.
   * @returns {boolean} True when an overlay is open and global shortcuts should not fire.
   */
  suppressedByOverlay() {
    return isAnyPopupOpen();
  }

  /** @returns {ShortcutDef[]} All definitions in declared order. */
  all() {
    return [...this._defs.values()];
  }

  /**
   * Definitions grouped by category, preserving declaration order within and
   * across groups. Handy for the settings page. Includes every command,
   * regardless of platform — use {@link byCategoryForPlatform} to hide commands
   * that aren't bound on the target platform.
   * @returns {Array<{category: string, shortcuts: ShortcutDef[]}>} Groups in declaration order.
   */
  byCategory() {
    return this._groupByCategory([...this._defs.values()]);
  }

  /**
   * Like {@link byCategory}, but drops commands that have no key at all on the
   * target platform, so a listing never shows a command with a binding it doesn't
   * actually have there. Derived from the bindings rather than declared: a
   * command keeps its row as long as one of its keys ships on that platform (the
   * tab-nav pair keeps Page Up/Down off macOS, having given up ⌥⌘↑/↓). Used by
   * the settings tab and the About-Juggler help corpus.
   * @param {boolean} mac - True to build the macOS listing, false for Windows/Linux.
   * @returns {Array<{category: string, shortcuts: ShortcutDef[]}>} Groups in declaration order.
   */
  byCategoryForPlatform(mac) {
    const defs = [...this._defs.values()].filter((d) => this.getBindings(d.id, mac).length > 0);
    return this._groupByCategory(defs);
  }

  /**
   * Group a definition list by category, preserving declaration order.
   * @param {ShortcutDef[]} defs
   * @returns {Array<{category: string, shortcuts: ShortcutDef[]}>} Groups in order.
   * @private
   */
  _groupByCategory(defs) {
    /** @type {Array<{category: string, shortcuts: ShortcutDef[]}>} */
    const groups = [];
    for (const def of defs) {
      let group = groups.find((g) => g.category === def.category);
      if (!group) { group = { category: def.category, shortcuts: [] }; groups.push(group); }
      group.shortcuts.push(def);
    }
    return groups;
  }

  /**
   * The binding a command is *advertised* by — the one tooltips, tips and the
   * lead keycap show. A user override if one exists (future), else the first
   * shipped key that exists on this platform, so a command whose primary chord is
   * macOS-only advertises its cross-platform key elsewhere instead of a chord
   * that does nothing.
   * @param {string} id
   * @returns {KeyBinding|null} The advertised binding, or null when the command has no key here.
   */
  getBinding(id) {
    return this.getBindings(id)[0] ?? null;
  }

  /**
   * Every key that triggers a command on a platform: its default binding followed
   * by any shipped aliases, minus those bound on the other platform only. This is
   * what the dispatcher matches against — {@link getBinding} stays the single
   * binding a command is advertised by. A user override replaces the command's
   * keys outright, so an overridden command has no aliases and no platform
   * filtering: the key the user chose is the key the command answers to.
   * @param {string} id
   * @param {boolean} [mac] - Which platform to ask about; defaults to the running one.
   * @returns {KeyBinding[]} All triggering bindings, or [] if the id is unknown.
   */
  getBindings(id, mac = isMac()) {
    if (this._overrides.has(id)) return [/** @type {KeyBinding} */ (this._overrides.get(id))];
    const def = this._defs.get(id);
    if (!def) return [];
    return [def.defaultBinding, ...(def.aliasBindings ?? [])].filter((b) => bindingShipsOn(b, mac));
  }

  /**
   * Set a user override for a command's binding. Not yet wired to any UI or
   * persistence — present so the customisation seam exists in exactly one place.
   * @param {string} id
   * @param {KeyBinding|null} binding - null clears the override (revert to default).
   */
  setBinding(id, binding) {
    if (binding) this._overrides.set(id, binding);
    else this._overrides.delete(id);
  }

  /**
   * @param {string} id
   * @returns {string} The command's label, or the id if unknown.
   */
  label(id) {
    return this._defs.get(id)?.label ?? id;
  }

  /**
   * Render a command's current binding for the running platform (⌘⇧Z on macOS,
   * "Ctrl+Shift+Z" on Windows/Linux). Empty string if the command is unknown.
   * @param {string} id
   * @returns {string} The platform-correct key label, or '' if the id is unknown.
   */
  formatBinding(id) {
    const binding = this.getBinding(id);
    return binding ? this.formatKeyBinding(binding) : '';
  }

  /**
   * Render every key that triggers a command (primary first, then aliases) for
   * the running platform. For listings that show a command's full key set, where
   * {@link formatBinding}'s single advertised combo would hide an alias.
   * @param {string} id
   * @returns {string[]} One platform-correct label per binding; [] if unknown.
   */
  formatBindings(id) {
    return this.getBindings(id).map((binding) => this.formatKeyBinding(binding));
  }

  /**
   * Render an arbitrary binding for the running platform.
   * @param {KeyBinding} binding
   * @returns {string} The platform-correct key label.
   */
  formatKeyBinding(binding) {
    return formatBindingForPlatform(binding, isMac());
  }

  /**
   * Register the behaviour for a command. The handler returns truthy when it
   * acted on the event, in which case the manager calls preventDefault/
   * stopPropagation; a falsy return leaves the event to propagate (so an
   * inapplicable command — nothing to undo, no flagged conversation — is a
   * transparent no-op). Registering an unknown or `external` id is ignored.
   * @param {string} id
   * @param {function(KeyboardEvent): (boolean|undefined)} handler
   * @returns {function(): void} An unregister function.
   */
  register(id, handler) {
    const def = this._defs.get(id);
    if (!def) {
      console.warn(`[KeyShortcutManager] register(): unknown shortcut "${id}"`);
      return () => {};
    }
    if (def.external) {
      console.warn(`[KeyShortcutManager] register(): "${id}" is externally dispatched`);
      return () => {};
    }
    this._handlers.set(id, handler);
    // A registered command is only reachable once the global dispatcher is
    // listening; install lazily so any registrar (header controls, zoom, the
    // conversation commands) activates it without a separate wiring step.
    this.install();
    return () => {
      if (this._handlers.get(id) === handler) this._handlers.delete(id);
    };
  }

  /**
   * @param {KeyboardEvent} e
   * @private
   */
  _onKeyDown(e) {
    if (e.isComposing || e.keyCode === 229) return; // IME in progress
    // An open overlay owns the keyboard: no rebindable command fires behind it.
    // (Escape is not in the command table — popup-manager owns dismissal.)
    if (this.suppressedByOverlay()) return;
    const editable = isEditableTarget(e.target);
    for (const def of this._defs.values()) {
      if (def.external) continue;
      const handler = this._handlers.get(def.id);
      if (!handler) continue;
      if (editable) {
        // In a text field, only fire if the command opts in — and for the
        // 'empty' policy, only when there's no text the keystroke would edit.
        if (!def.allowInInput) continue;
        if (def.allowInInput === 'empty' && !isEditableEmpty(e.target)) continue;
      }
      // Any of the command's keys fires it — the advertised binding or a shipped
      // alias for surfaces where that binding never arrives. getBindings() is
      // scoped to the running platform, so a chord we left unbound here (⌥⌘↑ off
      // macOS) is not among them.
      if (!this.getBindings(def.id).some((binding) => eventMatchesBinding(binding, e))) continue;
      const acted = handler(e);
      if (acted) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
  }
}

/** The shared singleton. */
const keyShortcutManager = new KeyShortcutManager();
export default keyShortcutManager;
