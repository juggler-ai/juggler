//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * KeyShortcutManager + file-editing-permission unit tests.
 *
 * Covers the central shortcut table, platform-agnostic binding matching, the
 * customisation override seam, platform-correct display formatting, and the
 * shared file-editing toggle the "toggle file editing" shortcut drives. Tests
 * are platform-independent: display/matching assertions branch on the same
 * exported {@link isMac} the manager itself uses. Nothing registers a handler on
 * a real dispatchable id, so the shared singleton's handler map is never
 * clobbered for other suites.
 * @module unit-tests/key-shortcut-manager-test
 */

import { assert } from '../utilities/test-helpers.js';
import keyShortcutManager, { isMac, eventMatchesBinding, formatBindingForPlatform } from '../../js/services/key-shortcut-manager.js';
import {
  isFileEditingAllowed,
  toggleFileEditing,
  setFileEditingAllowed,
  isDefaultFileEditingOn,
  setDefaultFileEditingOn,
  DEFAULT_FILE_EDITING_META_KEY,
  WRITE_FILE_ITEM_TYPE,
} from '../../js/services/file-editing-permission.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * Build a fake KeyboardEvent carrying only the props eventMatchesBinding reads.
 * @param {object} overrides - Property overrides.
 * @returns {any} A minimal event-like object.
 */
function evt(overrides) {
  return { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: '', ...overrides };
}

/**
 * A minimal MessageThread stand-in backing the file-write permission rules with
 * a plain array — matches the getRulesFor/addRule/removeRule surface the helper
 * uses.
 * @returns {any} The fake thread.
 */
function fakeThread() {
  let rules = [];
  let n = 1;
  return {
    getRulesFor(type) { return rules.filter((r) => r.type === type); },
    addRule(type, rule) { rules.push({ id: `r${n++}`, type, ...rule }); },
    removeRule(id) { rules = rules.filter((r) => r.id !== id); },
    allRules() { return rules; },
  };
}

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Aggregated results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  const mac = isMac();
  // The command modifier for this platform, as an event-prop override.
  const modProp = mac ? { metaKey: true } : { ctrlKey: true };

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ── Definition table ────────────────────────────────────────────────
  await run('all() lists the expected command ids', () => {
    const ids = keyShortcutManager.all().map((d) => d.id);
    for (const id of ['jump-to-attention', 'new-conversation', 'bin-conversation',
      'toggle-file-editing', 'pause-conversation', 'undo', 'redo', 'zoom-in', 'zoom-out',
      'show-shortcuts', 'toggle-tool-grouping', 'strategy-switch', 'cycle-model',
      'cycle-thinking', 'open-model-picker']) {
      assert(ids.includes(id), `expected shortcut "${id}" in the table`);
    }
  });

  await run('byCategory() groups without dropping any shortcut', () => {
    const groups = keyShortcutManager.byCategory();
    const grouped = groups.reduce((n, g) => n + g.shortcuts.length, 0);
    assert(grouped === keyShortcutManager.all().length, 'grouped count must equal total');
    const cats = groups.map((g) => g.category);
    assert(new Set(cats).size === cats.length, 'each category should appear once');
  });

  // prev/next-tab pair a mac-only chord with a key that ships everywhere, so the
  // command itself is no longer platform-restricted — only one of its keys is.
  await run('prev/next-tab pair the mac-only ⌥⌘↑/↓ chord with Page Up/Down', () => {
    const ids = keyShortcutManager.all().map((d) => d.id);
    assert(ids.includes('prev-tab') && ids.includes('next-tab'), 'tab-nav commands present');
    // Asked for an EXPLICIT platform, so these hold whatever host runs the suite.
    const macPrev = keyShortcutManager.getBindings('prev-tab', true);
    const macNext = keyShortcutManager.getBindings('next-tab', true);
    assert(macPrev.length === 2 && macPrev[0].mod && macPrev[0].alt && macPrev[0].key === 'ArrowUp',
      'mac prev-tab leads with Mod+Alt+ArrowUp');
    assert(macNext.length === 2 && macNext[0].mod && macNext[0].alt && macNext[0].key === 'ArrowDown',
      'mac next-tab leads with Mod+Alt+ArrowDown');
    assert(macPrev[1].key === 'PageUp' && macNext[1].key === 'PageDown',
      'the Page keys follow the chord on macOS');
    // Off macOS the ⌥⌘ chord isn't shipped (Ctrl+Alt+Up collides with screen
    // rotation), so the Page key is all there is — and it is now the advertised one.
    const winPrev = keyShortcutManager.getBindings('prev-tab', false);
    const winNext = keyShortcutManager.getBindings('next-tab', false);
    assert(winPrev.length === 1 && winPrev[0].key === 'PageUp', 'off macOS prev-tab is PageUp alone');
    assert(winNext.length === 1 && winNext[0].key === 'PageDown', 'off macOS next-tab is PageDown alone');
    // The advertised binding follows the host platform.
    assert(keyShortcutManager.getBinding('prev-tab').key === (mac ? 'ArrowUp' : 'PageUp'),
      'the advertised prev-tab key suits the host');
    assert(formatBindingForPlatform(macPrev[0], true) === '⌥⌘↑', `prev-tab mac label wrong: ${formatBindingForPlatform(macPrev[0], true)}`);
    assert(formatBindingForPlatform(macNext[0], true) === '⌥⌘↓', `next-tab mac label wrong: ${formatBindingForPlatform(macNext[0], true)}`);
    assert(formatBindingForPlatform(macPrev[1], true) === '⇞', `PageUp mac glyph wrong: ${formatBindingForPlatform(macPrev[1], true)}`);
    assert(formatBindingForPlatform(winNext[0], false) === 'Page Down', `PageDown label wrong: ${formatBindingForPlatform(winNext[0], false)}`);
  });

  // The Page keys are bare, so every modifier has to disqualify them: Shift+Page
  // selects a page of text in the composer, and the command modifier is free for
  // anything else to claim.
  await run('a bare Page key switches conversation, a modified one does not', () => {
    const prev = keyShortcutManager.getBindings('prev-tab', mac).find((b) => b.key === 'PageUp');
    const next = keyShortcutManager.getBindings('next-tab', mac).find((b) => b.key === 'PageDown');
    assert(eventMatchesBinding(prev, evt({ key: 'PageUp' })), 'PageUp should match prev-tab');
    assert(eventMatchesBinding(next, evt({ key: 'PageDown' })), 'PageDown should match next-tab');
    assert(!eventMatchesBinding(prev, evt({ key: 'PageDown' })), 'PageDown must not step backwards');
    assert(!eventMatchesBinding(prev, evt({ shiftKey: true, key: 'PageUp' })),
      'Shift+PageUp is a text selection, not a conversation switch');
    assert(!eventMatchesBinding(prev, evt({ ...modProp, key: 'PageUp' })), 'Mod+PageUp is left alone');
    assert(!eventMatchesBinding(prev, evt({ altKey: true, key: 'PageUp' })), 'Alt+PageUp is left alone');
  });

  await run('toggle-tool-grouping is Mod+Alt+G and survives the ⌥ glyph remap', () => {
    const grouping = keyShortcutManager.getBinding('toggle-tool-grouping');
    assert(grouping.mod && grouping.alt && grouping.key === 'g', 'tool grouping is Mod+Alt+G');
    assert(formatBindingForPlatform(grouping, true) === '⌥⌘G',
      `mac label wrong: ${formatBindingForPlatform(grouping, true)}`);
    assert(formatBindingForPlatform(grouping, false) === 'Ctrl+Alt+G',
      `non-mac label wrong: ${formatBindingForPlatform(grouping, false)}`);
    // macOS reports the Option-modified glyph in `key` (⌥G → '©'), so the chord
    // only matches via the physical-code fallback.
    assert(eventMatchesBinding(grouping, evt({ ...modProp, altKey: true, key: '©', code: 'KeyG' })),
      'matches through the Option glyph via e.code');
    assert(!eventMatchesBinding(grouping, evt({ ...modProp, key: 'g' })),
      'bare Mod+G (find-next) must not toggle grouping');
  });

  await run('byCategoryForPlatform lists a command wherever it has a key', () => {
    const idsIn = (groups) => groups.flatMap((g) => g.shortcuts.map((s) => s.id));
    const onMac = idsIn(keyShortcutManager.byCategoryForPlatform(true));
    const offMac = idsIn(keyShortcutManager.byCategoryForPlatform(false));
    // Tab-nav keeps a key on both platforms (the Page keys), so both listings show
    // it — with the platform-restricted chord dropped from the non-mac one.
    assert(onMac.includes('prev-tab') && offMac.includes('prev-tab'), 'tab-nav is listed on both platforms');
    assert(onMac.includes('undo') && offMac.includes('undo'), 'unrestricted commands appear on both');
    assert(keyShortcutManager.getBindings('prev-tab', false).length === 1,
      'the non-mac listing shows only the keys that ship there');
    // byCategory() (unfiltered) still lists everything.
    assert(idsIn(keyShortcutManager.byCategory()).includes('prev-tab'), 'byCategory lists every command');
  });

  // ── Binding matching (platform-aware) ───────────────────────────────
  await run('undo matches Mod+Z but not Mod+Shift+Z', () => {
    const undo = keyShortcutManager.getBinding('undo');
    assert(eventMatchesBinding(undo, evt({ ...modProp, key: 'z' })), 'Mod+Z should match undo');
    assert(!eventMatchesBinding(undo, evt({ ...modProp, shiftKey: true, key: 'z' })),
      'Mod+Shift+Z should NOT match undo (shift is significant)');
  });

  await run('redo matches Mod+Shift+Z but not Mod+Z', () => {
    const redo = keyShortcutManager.getBinding('redo');
    assert(eventMatchesBinding(redo, evt({ ...modProp, shiftKey: true, key: 'z' })), 'Mod+Shift+Z should match redo');
    assert(!eventMatchesBinding(redo, evt({ ...modProp, key: 'z' })), 'Mod+Z should NOT match redo');
  });

  await run('a bare key (no mod) does not match a mod binding', () => {
    const undo = keyShortcutManager.getBinding('undo');
    assert(!eventMatchesBinding(undo, evt({ key: 'z' })), 'Z alone should not match undo');
  });

  await run('a mod binding tolerates the other command modifier being held too', () => {
    const undo = keyShortcutManager.getBinding('undo');
    // Both meta and ctrl set is how the header shortcut test dispatches
    // platform-agnostically; a command-modifier binding must still fire.
    assert(eventMatchesBinding(undo, evt({ metaKey: true, ctrlKey: true, key: 'z' })),
      'Cmd+Ctrl+Z should still match undo');
  });

  await run('a modifier-less binding rejects an extra command modifier', () => {
    const strat = keyShortcutManager.getBinding('strategy-switch'); // {shift:true, key:'Tab'}
    assert(eventMatchesBinding(strat, evt({ shiftKey: true, key: 'Tab' })), 'Shift+Tab should match strategy-switch');
    assert(!eventMatchesBinding(strat, evt({ ...modProp, shiftKey: true, key: 'Tab' })),
      'Mod+Shift+Tab should not match a modifier-less binding');
  });

  await run('strategy-switch matches the Linux ISO_Left_Tab keysym via e.code', () => {
    const strat = keyShortcutManager.getBinding('strategy-switch'); // {shift:true, key:'Tab'}
    // Linux/WebKit2GTK delivers Shift+Tab with the ISO_Left_Tab keysym, so `key`
    // is not 'Tab'; the physical `code` is still 'Tab' and must carry the match.
    assert(eventMatchesBinding(strat, evt({ shiftKey: true, key: 'ISO_Left_Tab', code: 'Tab' })),
      'Shift+ISO_Left_Tab with code Tab should match strategy-switch');
    // The code fallback must not bypass the modifier gate: an extra command
    // modifier still disqualifies the modifier-less binding.
    assert(!eventMatchesBinding(strat, evt({ ...modProp, shiftKey: true, key: 'ISO_Left_Tab', code: 'Tab' })),
      'Mod+Shift+ISO_Left_Tab must still be rejected');
  });

  await run('zoom-in folds the shifted "+" onto "=" and ignores Shift', () => {
    const zoomIn = keyShortcutManager.getBinding('zoom-in');
    assert(eventMatchesBinding(zoomIn, evt({ ...modProp, key: '=' })), 'Mod+= should match zoom-in');
    assert(eventMatchesBinding(zoomIn, evt({ ...modProp, key: '+' })), 'Mod++ should match zoom-in');
    assert(eventMatchesBinding(zoomIn, evt({ ...modProp, shiftKey: true, key: '+' })),
      'Mod+Shift++ should match zoom-in (shift not significant)');
  });

  await run('show-shortcuts matches Mod+/', () => {
    const showShortcuts = keyShortcutManager.getBinding('show-shortcuts');
    assert(showShortcuts.mod && showShortcuts.key === '/', 'show-shortcuts is Mod+/');
    assert(eventMatchesBinding(showShortcuts, evt({ ...modProp, key: '/' })),
      'Mod+/ should match show-shortcuts');
  });

  await run('alt bindings match the macOS Option glyph via the code fallback', () => {
    const cycleModel = keyShortcutManager.getBinding('cycle-model');
    assert(cycleModel.mod && cycleModel.alt && cycleModel.key === 'm', 'cycle-model is Mod+Alt+M');
    // Windows/Linux report the base letter in `key`.
    assert(eventMatchesBinding(cycleModel, evt({ ...modProp, altKey: true, key: 'm', code: 'KeyM' })),
      'Mod+Alt+m should match cycle-model');
    // macOS reports the Option-modified glyph ('µ' for ⌥M, '†' for ⌥T) — the
    // physical `code` carries the match there.
    assert(eventMatchesBinding(cycleModel, evt({ ...modProp, altKey: true, key: 'µ', code: 'KeyM' })),
      'Mod+Alt+µ (macOS ⌥M glyph) should match cycle-model via code');
    const cycleThinking = keyShortcutManager.getBinding('cycle-thinking');
    assert(eventMatchesBinding(cycleThinking, evt({ ...modProp, altKey: true, key: '†', code: 'KeyT' })),
      'Mod+Alt+† (macOS ⌥T glyph) should match cycle-thinking via code');
    // The code fallback is Alt-only: without Alt the glyph must not match.
    assert(!eventMatchesBinding(cycleModel, evt({ ...modProp, key: 'µ', code: 'KeyM' })),
      'no Alt ⇒ no code fallback');
    // And the wrong physical key must not match even with the modifiers right.
    assert(!eventMatchesBinding(cycleModel, evt({ ...modProp, altKey: true, key: 'µ', code: 'KeyN' })),
      'a different code must not match');
  });

  // Cycling the model (⌥⌘M) and opening the picker (⇧⌥⌘M) are one Shift apart,
  // and an omitted shift is TOLERANT — so cycle-model pins shift:false or the
  // Shift-ed chord fires both. It would win, too: the cycler matches on its own
  // capture listener, ahead of the command table.
  await run('Shift disambiguates cycling the model from opening the picker', () => {
    const cycle = keyShortcutManager.getBinding('cycle-model');
    const open = keyShortcutManager.getBinding('open-model-picker');
    assert(open.mod && open.alt && open.shift === true && open.key === 'm',
      'open-model-picker is Mod+Alt+Shift+M');
    const shifted = evt({ ...modProp, altKey: true, shiftKey: true, key: 'm', code: 'KeyM' });
    assert(eventMatchesBinding(open, shifted), '⇧⌥⌘M should open the picker');
    assert(!eventMatchesBinding(cycle, shifted), '⇧⌥⌘M must not also reach the cycler');
    const plain = evt({ ...modProp, altKey: true, key: 'm', code: 'KeyM' });
    assert(eventMatchesBinding(cycle, plain), '⌥⌘M should still cycle the model');
    assert(!eventMatchesBinding(open, plain), '⌥⌘M must not open the picker');
  });

  await run('open-model-picker fires from a text field, dispatched by the manager', () => {
    const def = keyShortcutManager.all().find((d) => d.id === 'open-model-picker');
    assert(!!def && def.allowInInput === true,
      'the composer is where it is pressed, so it must fire inside an input');
    assert(!def.external,
      'one press, one action — nothing here needs a hold gesture to dispatch it');
  });

  await run('an unwanted Alt modifier blocks the match', () => {
    const newConv = keyShortcutManager.getBinding('new-conversation');
    assert(eventMatchesBinding(newConv, evt({ ...modProp, key: 'n' })), 'Mod+N should match new-conversation');
    assert(!eventMatchesBinding(newConv, evt({ ...modProp, altKey: true, key: 'n' })),
      'Mod+Alt+N should not match a non-Alt binding');
  });

  // New tab (⌘N) vs New window (⇧⌘N) must not overlap: new-conversation pins
  // shift:false so ⇧⌘N doesn't also open a tab, and new-window owns ⇧⌘N.
  await run('Shift disambiguates New tab (⌘N) from New window (⇧⌘N)', () => {
    const newConv = keyShortcutManager.getBinding('new-conversation');
    const newWin = keyShortcutManager.getBinding('new-window');
    assert(!eventMatchesBinding(newConv, evt({ ...modProp, shiftKey: true, key: 'n' })),
      'Mod+Shift+N must NOT match new-conversation');
    assert(eventMatchesBinding(newWin, evt({ ...modProp, shiftKey: true, key: 'n' })),
      'Mod+Shift+N should match new-window');
    assert(!eventMatchesBinding(newWin, evt({ ...modProp, key: 'n' })),
      'bare Mod+N must NOT match new-window');
  });

  // A browser keeps ⌘N/Ctrl+N for its own New window and never delivers it to
  // the page, so in a browser tab the primary binding cannot fire at all. The
  // ⌥N/Alt+N alias is the key that reaches the command on every surface.
  await run('new-conversation answers to its Alt+N alias as well as Mod+N', () => {
    const bindings = keyShortcutManager.getBindings('new-conversation');
    assert(bindings.length === 2, `expected primary + alias, got ${bindings.length}`);
    const matches = (e) => bindings.some((b) => eventMatchesBinding(b, e));
    assert(matches(evt({ ...modProp, key: 'n' })), 'Mod+N should still create a conversation');
    assert(matches(evt({ altKey: true, key: 'n' })), 'Alt+N should create a conversation');
    // macOS reports the Option-modified glyph (⌥N is the '˜' dead key), so the
    // physical `code` carries the match there.
    assert(matches(evt({ altKey: true, key: '˜', code: 'KeyN' })),
      'macOS ⌥N glyph should match the alias via code');
    // The alias is Alt ALONE: with the command modifier down neither binding
    // matches, so ⌥⌘N/Ctrl+Alt+N stays free for a future command.
    assert(!matches(evt({ ...modProp, altKey: true, key: 'n', code: 'KeyN' })),
      'Mod+Alt+N must match neither the binding nor its alias');
    // getBinding stays the single advertised combo (tooltips show one key).
    const advertised = keyShortcutManager.getBinding('new-conversation');
    assert(advertised.mod && !advertised.alt && advertised.key === 'n',
      'the advertised binding is still Mod+N');
    // A command without aliases reports exactly its one binding.
    assert(keyShortcutManager.getBindings('undo').length === 1, 'unaliased command has one binding');
    assert(keyShortcutManager.getBindings('does-not-exist').length === 0, 'unknown id has no bindings');
  });

  await run('a user override replaces a command\u2019s keys, aliases included', () => {
    keyShortcutManager.setBinding('new-conversation', { mod: true, key: 'k' });
    try {
      const bindings = keyShortcutManager.getBindings('new-conversation');
      assert(bindings.length === 1, 'an overridden command answers only to the chosen key');
      assert(eventMatchesBinding(bindings[0], evt({ ...modProp, key: 'k' })), 'the override matches');
      assert(!bindings.some((b) => eventMatchesBinding(b, evt({ altKey: true, key: 'n' }))),
        'the shipped alias is gone once the user picks their own key');
    } finally {
      keyShortcutManager.setBinding('new-conversation', null);
    }
    assert(keyShortcutManager.getBindings('new-conversation').length === 2, 'clearing restores the defaults');
  });

  // ── Display formatting (platform-correct) ───────────────────────────
  await run('formatBinding renders platform-correct labels', () => {
    assert(keyShortcutManager.formatBinding('undo') === (mac ? '⌘Z' : 'Ctrl+Z'),
      `undo label wrong: ${keyShortcutManager.formatBinding('undo')}`);
    assert(keyShortcutManager.formatBinding('redo') === (mac ? '⇧⌘Z' : 'Ctrl+Shift+Z'),
      `redo label wrong: ${keyShortcutManager.formatBinding('redo')}`);
    assert(keyShortcutManager.formatBinding('bin-conversation') === (mac ? '⌘⌫' : 'Ctrl+Backspace'),
      `bin label wrong: ${keyShortcutManager.formatBinding('bin-conversation')}`);
    assert(keyShortcutManager.formatBinding('zoom-in') === (mac ? '⌘+' : 'Ctrl++'),
      `zoom-in label wrong: ${keyShortcutManager.formatBinding('zoom-in')}`);
    assert(keyShortcutManager.formatBinding('does-not-exist') === '', 'unknown id formats to empty string');
    // formatBindings renders the whole key set (primary first), so a listing can
    // show an alias that formatBinding's single advertised combo would hide.
    const combos = keyShortcutManager.formatBindings('new-conversation');
    assert(combos.length === 2, `expected two labels, got: ${combos.join(', ')}`);
    assert(combos[0] === keyShortcutManager.formatBinding('new-conversation'), 'the advertised combo leads');
    assert(combos[1] === (mac ? '⌥N' : 'Alt+N'), `alias label wrong: ${combos[1]}`);
    assert(keyShortcutManager.formatBindings('does-not-exist').length === 0, 'unknown id formats to no labels');
  });

  // formatBindingForPlatform renders for an EXPLICIT platform, independent of
  // the running host — the seam the About-Juggler help corpus uses to describe
  // shortcuts for session.platform rather than the client's navigator.
  await run('formatBindingForPlatform renders both platforms regardless of host', () => {
    const redo = keyShortcutManager.getBinding('redo');
    assert(formatBindingForPlatform(redo, true) === '⇧⌘Z', `mac redo wrong: ${formatBindingForPlatform(redo, true)}`);
    assert(formatBindingForPlatform(redo, false) === 'Ctrl+Shift+Z', `non-mac redo wrong: ${formatBindingForPlatform(redo, false)}`);
    const bin = keyShortcutManager.getBinding('bin-conversation');
    assert(formatBindingForPlatform(bin, true) === '⌘⌫', `mac bin wrong: ${formatBindingForPlatform(bin, true)}`);
    assert(formatBindingForPlatform(bin, false) === 'Ctrl+Backspace', `non-mac bin wrong: ${formatBindingForPlatform(bin, false)}`);
    // And it agrees with the navigator-based instance method on this host.
    assert(formatBindingForPlatform(redo, mac) === keyShortcutManager.formatBinding('redo'),
      'explicit-platform formatter should match formatBinding on this host');
  });

  // ── Customisation override seam ─────────────────────────────────────
  await run('setBinding overrides and reverts the effective binding', () => {
    const original = keyShortcutManager.getBinding('undo');
    try {
      keyShortcutManager.setBinding('undo', { mod: true, key: 'y' });
      assert(keyShortcutManager.getBinding('undo').key === 'y', 'override should take effect');
      assert(keyShortcutManager.formatBinding('undo') === (mac ? '⌘Y' : 'Ctrl+Y'), 'display reflects override');
    } finally {
      keyShortcutManager.setBinding('undo', null);
    }
    assert(keyShortcutManager.getBinding('undo').key === original.key, 'clearing reverts to default');
  });

  // ── register() guards (no real handler mutation) ────────────────────
  await run('register() ignores unknown and external ids, returning a noop', () => {
    const a = keyShortcutManager.register('no-such-shortcut', () => true);
    const b = keyShortcutManager.register('strategy-switch', () => true); // external — rejected
    assert(typeof a === 'function' && typeof b === 'function', 'register always returns an unregister function');
    // Neither call should throw or take effect; nothing to assert beyond the noop.
    a();
    b();
  });

  // ── File-editing permission toggle ──────────────────────────────────
  await run('toggleFileEditing turns editing on then off', () => {
    const mt = fakeThread();
    assert(isFileEditingAllowed(mt) === false, 'starts disallowed');

    assert(toggleFileEditing(mt) === true, 'first toggle returns the new (on) state');
    assert(isFileEditingAllowed(mt) === true, 'editing now allowed');
    const on = mt.getRulesFor(WRITE_FILE_ITEM_TYPE).filter((r) => r.kind === 'boolean');
    assert(on.length === 1 && on[0].value === true && on[0].scope === 'conversation',
      'exactly one conversation-scoped value:true rule');

    assert(toggleFileEditing(mt) === false, 'second toggle returns the new (off) state');
    assert(isFileEditingAllowed(mt) === false, 'editing now disallowed');
    assert(mt.getRulesFor(WRITE_FILE_ITEM_TYPE).filter((r) => r.kind === 'boolean').length === 0,
      'no boolean rules remain when off');
  });

  await run('toggleFileEditing normalises a stale value:false rule when turning on', () => {
    const mt = fakeThread();
    mt.addRule(WRITE_FILE_ITEM_TYPE, { kind: 'boolean', value: false, scope: 'conversation' });
    assert(isFileEditingAllowed(mt) === false, 'value:false is not "allowed"');
    assert(toggleFileEditing(mt) === true, 'toggle turns editing on');
    const booleans = mt.getRulesFor(WRITE_FILE_ITEM_TYPE).filter((r) => r.kind === 'boolean');
    assert(booleans.length === 1 && booleans[0].value === true, 'stale rule replaced by a single value:true');
  });

  await run('setFileEditingAllowed sets an explicit state idempotently', () => {
    const mt = fakeThread();
    assert(setFileEditingAllowed(mt, true) === true, 'enabling returns true');
    assert(isFileEditingAllowed(mt) === true, 'editing allowed after enable');
    // Re-enabling must not stack duplicate rules.
    setFileEditingAllowed(mt, true);
    assert(mt.getRulesFor(WRITE_FILE_ITEM_TYPE).filter((r) => r.kind === 'boolean').length === 1,
      'still exactly one boolean rule after a redundant enable');
    assert(setFileEditingAllowed(mt, false) === false, 'disabling returns false');
    assert(isFileEditingAllowed(mt) === false, 'editing disallowed after disable');
    assert(mt.getRulesFor(WRITE_FILE_ITEM_TYPE).filter((r) => r.kind === 'boolean').length === 0,
      'no boolean rules remain when disabled');
  });

  // ── Per-project "edits on by default" preference ────────────────────
  await run('default-file-editing preference round-trips through session metadata', () => {
    const meta = {};
    const session = {
      getMetadata(key) { return meta[key]; },
      patchMetadata(patch) { Object.assign(meta, patch); },
    };
    assert(isDefaultFileEditingOn(session) === false, 'off when unset');
    setDefaultFileEditingOn(session, true);
    assert(meta[DEFAULT_FILE_EDITING_META_KEY] === true, 'preference persisted under the metadata key');
    assert(isDefaultFileEditingOn(session) === true, 'reads back on');
    setDefaultFileEditingOn(session, false);
    assert(isDefaultFileEditingOn(session) === false, 'reads back off');
    // Null-safe: no session, or one without patchMetadata, must not throw.
    assert(isDefaultFileEditingOn(null) === false, 'null session reads off');
    setDefaultFileEditingOn(null, true);
    setDefaultFileEditingOn({}, true);
  });

  return { passed, failed, errors };
}
