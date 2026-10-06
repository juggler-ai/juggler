//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * escape-behaviour — what the Escape key does, and the preference that chooses.
 *
 * Escape is a "back out one level" key with a priority ladder. The first rung
 * that applies wins:
 *
 *   1. A popup/menu/modal/sheet is open → it is dismissed (popup-manager stops
 *      the key at document, so nothing below ever sees it).
 *   2. An inline editor is active (tab rename, pattern edit, find bar, a
 *      hold-to-cycle gesture) → that edit is cancelled, and the key stops there.
 *   3. The visible conversation is running → the STOP rung, configurable here.
 *   4. Nothing is running → the PROMPT rung, configurable here.
 *   5. None of the above did anything → leave fullscreen (macOS desktop window).
 *
 * Rungs 1 and 2 are not negotiable: Escape must always back out of a transient
 * thing, so a preference can only ever change rungs 3 and 4. That keeps the
 * option set small and unable to break dismissal.
 *
 * Rung 5 is AppKit's own meaning of Escape, which the native window has handed
 * to the page (`DisableEscapeExitsFullscreen`) precisely so that it sits BELOW
 * the rest: left to AppKit, the press that stopped a turn also threw the window
 * out of fullscreen. The window refuses every Escape-driven exit, including the
 * one WebKit runs for a key the page did not preventDefault, so this rung is
 * the only way Escape leaves fullscreen. (Claiming the key with preventDefault
 * would not do instead: several handlers read `defaultPrevented` as "someone
 * else took this press" and would stand down.) It is guarded twice, because Escape is a key people hit
 * several times in a row:
 *   - It never follows another Escape within {@link ESCAPE_QUIET_MS}: the
 *     second press of a burst is the user still backing out of the first thing,
 *     not asking for the window back.
 *   - The press after a stop — whether Escape stopped the turn or it ended on
 *     its own a moment before — is swallowed outright for the same period. It
 *     clears nothing and leaves nothing: the user was reaching for the turn,
 *     and the draft in the box is the correction they were writing.
 *
 * The rule the presets are built around:
 *
 *   A single Escape press NEVER both stops a turn and clears the prompt, and
 *   while a turn is running Escape only touches the prompt if stopping is not
 *   bound to the key at all (the 'clear-only' preset).
 *
 * Text in the composer during a run is nearly always a correction being drafted
 * because the agent is going wrong ("no, use the other API") — deleting it on
 * the way to stopping the turn would be destructive in exactly the state where
 * the user is most engaged. So under every preset that stops, the first press
 * leaves the draft alone.
 *
 * Everything about the feature lives in this one module — the preset table, the
 * persistence, the key handling both Escape call sites delegate to, and the
 * settings control that edits it — so changing the behaviour or adding a preset
 * is a single-file change. That is why a service module builds a settings row:
 * colocation of the whole feature beats a tidier layer boundary here.
 * @module services/escape-behaviour
 */

import { cachedUserPref, setUserPref, notifyPrefChanged, reconcilePref } from './prefs.js';
import { isMac, formatBindingForPlatform } from './key-shortcut-manager.js';
import { postWindowControl, hasNativeHost } from '../../sdk/lib/window-control.js';

/** The user preference holding the chosen preset id. */
const PREF_KEY = 'juggler-escape-behaviour';

/** Fired on window whenever the preference changes, so open views re-render. */
export const ESCAPE_BEHAVIOUR_EVENT = 'juggler:escape-behaviour-changed';

/**
 * How long a `double-press` gesture stays armed. Generous on purpose: a window
 * tight enough to feel like a "double click" makes a deliberate, unhurried
 * second press silently fail, which reads as the key being broken. Accidental
 * arming is cleaned up by the disarm-on-any-other-input rule below long before
 * this expires.
 */
const DOUBLE_PRESS_WINDOW_MS = 1500;

/**
 * How long a burst of Escapes, or the settling after a stop, keeps the key off
 * the prompt rung's clear and off the fullscreen rung. Long enough to cover a
 * hurried double or triple tap; short enough that a deliberate press after
 * looking at the result is never swallowed.
 */
export const ESCAPE_QUIET_MS = 1000;

/**
 * What Escape does while the visible conversation is running.
 * - `stop`: hard cancel at once (Shift+Escape pauses instead).
 * - `pause`: polite pause — the step finishes, then it rests (Shift+Escape hard cancels).
 * - `two-step`: first press pauses, a second press escalates to a hard cancel.
 * - `double-press`: first press only arms the gesture, a second one stops.
 * - `clear`: never stops; clears the prompt exactly as it does when idle.
 * - `none`: does nothing at all.
 * @typedef {'stop'|'pause'|'two-step'|'double-press'|'clear'|'none'} EscapeRunningMode
 */

/**
 * What Escape does when nothing is running.
 * - `clear`: clear the prompt as an undoable edit (Ctrl/Cmd+Z restores it).
 * - `none`: leave the draft alone.
 * @typedef {'clear'|'none'} EscapeIdleMode
 */

/**
 * One selectable Escape behaviour.
 * @typedef {object} EscapePreset
 * @property {string} id - Stable identifier, persisted as the preference value.
 * @property {string} label - Name shown in the settings picker.
 * @property {string} description - Sentence shown under the picker. `{esc}` and
 *   `{shiftEsc}` are substituted with the platform-correct key labels.
 * @property {EscapeRunningMode} running - Behaviour while a turn is running.
 * @property {EscapeIdleMode} idle - Behaviour when nothing is running.
 */

/**
 * The selectable behaviours, in the order they're offered. Ordered from most to
 * least eager to stop, so the picker reads as a single "how hard is it to
 * cancel by accident" axis.
 *
 * Shift+Escape is not independently configurable: under every preset it is the
 * *other* stop — the counterpart to whatever the plain key does — so the polite
 * Pause always has a chord, and the presets that decline to stop still leave one
 * keyboard route to stopping cleanly.
 * @type {EscapePreset[]}
 */
export const ESCAPE_PRESETS = [
  {
    id: 'stop',
    label: 'Stop immediately',
    description: '{esc} stops the turn at once; {shiftEsc} pauses instead '
      + '(the current step finishes, then it rests). With nothing running, {esc} clears the prompt.',
    running: 'stop',
    idle: 'clear',
  },
  {
    id: 'pause',
    label: 'Pause instead of stopping',
    description: '{esc} pauses — the current step finishes and records its result, then it rests at idle; '
      + 'nothing is cancelled. {shiftEsc} stops outright. With nothing running, {esc} clears the prompt.',
    running: 'pause',
    idle: 'clear',
  },
  {
    id: 'two-step',
    label: 'Pause, then stop',
    description: 'The first {esc} pauses; pressing it again while the pause is pending stops outright. '
      + '{shiftEsc} stops on the first press. With nothing running, {esc} clears the prompt.',
    running: 'two-step',
    idle: 'clear',
  },
  {
    id: 'double-press',
    label: 'Press Escape twice to stop',
    description: 'One {esc} does nothing; pressing it twice quickly stops the turn. '
      + '{shiftEsc} pauses. With nothing running, {esc} clears the prompt.',
    running: 'double-press',
    idle: 'clear',
  },
  {
    id: 'clear-only',
    label: 'Never stop — only clear the prompt',
    description: '{esc} never touches a running turn; it always clears the prompt (undoably). '
      + 'Stop from the footer button, or pause with {shiftEsc}.',
    running: 'clear',
    idle: 'clear',
  },
  {
    id: 'inert',
    label: 'Never stop, never clear',
    description: '{esc} only dismisses menus and dialogs — it leaves both the turn and the prompt alone. '
      + 'Stop from the footer button, or pause with {shiftEsc}.',
    running: 'none',
    idle: 'none',
  },
];

/** The shipped default: the behaviour Juggler had before the preference existed. */
const DEFAULT_PRESET_ID = 'stop';

/**
 * The chosen preset, falling back to the default for a missing, corrupt, or
 * retired stored id.
 * @returns {EscapePreset} The active preset.
 */
export function getEscapePreset() {
  const id = cachedUserPref(PREF_KEY, DEFAULT_PRESET_ID);
  return ESCAPE_PRESETS.find((p) => p.id === id)
    ?? /** @type {EscapePreset} */ (ESCAPE_PRESETS.find((p) => p.id === DEFAULT_PRESET_ID));
}

/**
 * Choose a preset and notify listeners. An unknown id is ignored rather than
 * stored, so the preference can never be poisoned into a fallback loop.
 * @param {string} id - A preset id from {@link ESCAPE_PRESETS}.
 * @returns {void}
 */
export function setEscapePreset(id) {
  if (!ESCAPE_PRESETS.some((p) => p.id === id)) return;
  // Switching away mid-gesture would strand the armed state (and its cue) under
  // a preset that can never consume it.
  disarm();
  void setUserPref(PREF_KEY, id);
  notifyPrefChanged(ESCAPE_BEHAVIOUR_EVENT);
}

/**
 * A preset's description with the platform-correct key labels substituted.
 * @param {EscapePreset} preset
 * @returns {string} The description for this platform.
 */
export function describeEscapePreset(preset) {
  const mac = isMac();
  const esc = formatBindingForPlatform({ key: 'Escape' }, mac);
  const shiftEsc = formatBindingForPlatform({ shift: true, key: 'Escape' }, mac);
  return preset.description.replaceAll('{esc}', esc).replaceAll('{shiftEsc}', shiftEsc);
}

// ---------------------------------------------------------------------------
// The double-press gesture
// ---------------------------------------------------------------------------

/** @type {boolean} True while a first `double-press` Escape is waiting for its second. */
let armed = false;

/** @type {ReturnType<typeof setTimeout>|null} */
let armTimer = null;

/** @type {HTMLElement|null} The on-screen "press again" cue, while armed. */
let cueEl = null;

/**
 * Any input that isn't another Escape means the user moved on, so an accidental
 * first press doesn't stay live behind their typing.
 * @param {KeyboardEvent} e
 * @returns {void}
 */
function onForeignKey(e) {
  if (e.key !== 'Escape') disarm();
}

/**
 * Arm the gesture: show the cue and start listening for the things that cancel
 * it. Both disarm listeners are added in the CAPTURE phase, which is safe to do
 * from inside the very keydown that arms us — document's capture phase has
 * already passed for that event, so the new listener cannot see it and
 * immediately undo the arming.
 * @returns {void}
 */
function arm() {
  disarm();
  armed = true;
  armTimer = setTimeout(disarm, DOUBLE_PRESS_WINDOW_MS);
  document.addEventListener('keydown', onForeignKey, true);
  document.addEventListener('pointerdown', disarm, true);
  showCue();
}

/**
 * Drop the gesture and every trace of it. Idempotent, so every exit path can
 * call it unconditionally.
 * @returns {void}
 */
function disarm() {
  armed = false;
  if (armTimer) { clearTimeout(armTimer); armTimer = null; }
  document.removeEventListener('keydown', onForeignKey, true);
  document.removeEventListener('pointerdown', disarm, true);
  hideCue();
}

/**
 * Show the "press Escape again" cue. Without it the first press looks like the
 * key doing nothing, which reads as a bug rather than as a safety catch. It is
 * a plain body-level element, NOT a popup: registering it with popup-manager
 * would make the second Escape dismiss the cue instead of stopping the turn.
 * @returns {void}
 */
function showCue() {
  hideCue();
  if (typeof document === 'undefined' || !document.body) return;
  const mac = isMac();
  const el = document.createElement('div');
  el.className = 'escape-arm-cue';
  el.setAttribute('role', 'status');
  el.textContent = `Press ${formatBindingForPlatform({ key: 'Escape' }, mac)} again to stop`;
  document.body.appendChild(el);
  cueEl = el;
}

/**
 * Remove the cue if one is showing.
 * @returns {void}
 */
function hideCue() {
  cueEl?.remove();
  cueEl = null;
}

/** @returns {boolean} True while a first press is waiting for its second (tests). */
export function isDoublePressArmed() {
  return armed;
}

/**
 * Drop any armed gesture and every timing the quiet periods read. Exported for
 * tests and for teardown paths that want a clean slate; ordinary use disarms
 * itself.
 * @returns {void}
 */
export function resetEscapeGesture() {
  disarm();
  lastPress = null;
  lastPressAt = -Infinity;
  previousPressAt = -Infinity;
  settleUntil = -Infinity;
  wasRunning = false;
}

// ---------------------------------------------------------------------------
// The fullscreen rung and its quiet periods
// ---------------------------------------------------------------------------

/**
 * The native window this page sits in, as far as the fullscreen rung needs it:
 * a clock, whether the window is fullscreen, and how to leave it.
 * @typedef {object} EscapeHost
 * @property {() => number} now - Milliseconds on a monotonic clock.
 * @property {() => boolean} isFullscreen - True while the window is fullscreen.
 * @property {() => void} leaveFullscreen - Take the window out of fullscreen.
 */

/**
 * The real host. Only a macOS desktop window has the rung: that is the platform
 * whose Escape left fullscreen before the window handed the key to the page,
 * and the only one with a native host to ask. `data-window-fullscreen` is kept
 * by window-fullscreen.js.
 * @type {EscapeHost}
 */
const NATIVE_HOST = {
  now: () => performance.now(),
  isFullscreen: () => isMac() && hasNativeHost()
    && document.documentElement.dataset.windowFullscreen === '1',
  leaveFullscreen: () => postWindowControl('control', '?action=unfullscreen'),
};

/** @type {EscapeHost} */
let host = NATIVE_HOST;

/**
 * Replace the native host — a hand-moved clock and a pretend window — or restore
 * it with null.
 * @param {EscapeHost|null} stand - The stand-in, or null for the real one.
 * @returns {void}
 */
export function __setEscapeHostForTests(stand) {
  host = stand ?? NATIVE_HOST;
}

/** @type {Event|null} The press last counted, so one press is never counted twice. */
let lastPress = null;
/** Clock reading of the latest Escape press. */
let lastPressAt = -Infinity;
/** Clock reading of the press before it — what the press guard compares against. */
let previousPressAt = -Infinity;
/** Until this clock reading, Escape is settling after a stop and does nothing. */
let settleUntil = -Infinity;
/** Whether the visible conversation was running when last looked at. */
let wasRunning = false;

/**
 * Count an Escape press. Called from a window capture listener, which sees every
 * press — including the ones a popup takes and stops at document, which never
 * reach {@link handleEscapeKey} but are still the first of a burst — and again
 * from the handler, for a press that arrived without being dispatched.
 * @param {Event} event - The keydown.
 * @returns {void}
 */
function countPress(event) {
  if (event === lastPress) return;
  lastPress = event;
  previousPressAt = lastPressAt;
  lastPressAt = host.now();
}

/**
 * Start the settle period: the presses that follow a stop are the user still
 * reaching for the turn.
 * @returns {void}
 */
function settle() {
  settleUntil = host.now() + ESCAPE_QUIET_MS;
}

/**
 * Note whether the visible conversation is running, settling the key when a
 * turn has just come to rest — but only under a preset whose Escape stops
 * turns. Under one that never does, no press was ever reaching for the turn,
 * so there is nothing to protect.
 * @returns {boolean} Whether it is running now.
 */
function observeRunning() {
  const running = !!app()?.shouldHandleEscape?.();
  const mode = getEscapePreset().running;
  if (wasRunning && !running && mode !== 'clear' && mode !== 'none') settle();
  wasRunning = running;
  return running;
}

/** Stops the current turn watch. */
let unwatchTurns = () => {};

/**
 * Watch a session for turns coming to rest, so a press racing a turn's natural
 * end settles exactly as one that stopped it would. Each call replaces the
 * previous watch.
 * @param {{onLLMStatusChange: (fn: (id: string) => void) => () => void}} session
 * @returns {() => void} Stops watching.
 */
export function watchTurnsForEscape(session) {
  unwatchTurns();
  const unsubscribe = session.onLLMStatusChange(() => { observeRunning(); });
  unwatchTurns = () => {
    unsubscribe();
    unwatchTurns = () => {};
  };
  return unwatchTurns;
}

/**
 * The fullscreen rung: leave fullscreen if this press is a deliberate, lone one
 * that nothing above it wanted.
 * @param {KeyboardEvent} event - The keydown.
 * @returns {boolean} True when the window was asked to leave fullscreen.
 */
function leaveFullscreen(event) {
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
  if (host.now() - previousPressAt < ESCAPE_QUIET_MS) return false;
  if (!host.isFullscreen()) return false;
  host.leaveFullscreen();
  return true;
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') countPress(e);
  }, true);
}

// ---------------------------------------------------------------------------
// The key handler
// ---------------------------------------------------------------------------

/**
 * The app facade the handler acts through. Read live rather than captured: the
 * Escape call sites are wired up before `window.jugglerApp` exists.
 * @returns {any} The app singleton, or undefined before boot.
 */
function app() {
  // @ts-ignore - jugglerApp is added dynamically in app.js
  return typeof window === 'undefined' ? undefined : window.jugglerApp;
}

/**
 * Hard cancel from a vantage: a sub-thread's own column interrupts that thread
 * and leaves it open; the root column stops everything and closes open
 * sub-threads.
 * @param {string|null} focusedThreadId - Thread id of the column the stop came from.
 * @returns {void}
 */
function hardStop(focusedThreadId) {
  settle();
  app()?.cancelLLMOperation?.(focusedThreadId, { source: 'escape' });
}

/**
 * Request a polite stop (Pause): the work in this column and everything below it
 * finishes and records its real result, then rests before the next LLM turn.
 * Nothing is cancelled, interrupted or closed. No `toggle`, so pressing it again
 * re-affirms the pause rather than lifting it (that is the footer Pause button's
 * job).
 * @param {string|null} focusedThreadId - Vantage the press came from; the pause
 *   is scoped to it, exactly as a stop is.
 * @returns {void}
 */
function politeStop(focusedThreadId) {
  settle();
  app()?.cancelLLMOperation?.(focusedThreadId, { polite: true });
}

/**
 * @param {string|null} focusedThreadId - Vantage the press came from.
 * @returns {boolean} True when a Pause already stands over that column.
 */
function isPausePending(focusedThreadId) {
  const state = app()?.getVisibleConversation?.()?.politeStopState?.(focusedThreadId ?? null);
  return state === 'pending' || state === 'paused';
}

/**
 * Clear the prompt as an undoable edit, so a mis-pressed Escape can't silently
 * lose a draft.
 * @param {() => any} getComposer - Accessor for the composer to clear.
 * @returns {boolean} True if there was text to clear.
 */
function clearPrompt(getComposer) {
  const composer = getComposer();
  if (composer && typeof composer.clearTextUndoable === 'function') {
    return !!composer.clearTextUndoable();
  }
  return false;
}

/**
 * Handle an Escape keypress on rungs 3 to 5 of the ladder.
 *
 * Callers must already have let the higher rungs win — an open popup or an
 * inline editor owns the key and this is never reached (composer.js checks
 * `isAnyPopupOpen()`; conversation-tab.js returns on `suppressedByOverlay()`).
 * @param {KeyboardEvent} event - The keydown being handled.
 * @param {object} [ctx] - The vantage this press came from.
 * @param {string|null} [ctx.focusedThreadId] - Thread id of the column/composer
 *   the press came from; null for the root vantage.
 * @param {() => any} [ctx.getComposer] - Accessor for the composer to clear.
 * @param {boolean} [ctx.canLeaveFullscreen] - False when the caller has a rung
 *   of its own to take if this one declines, so the press must not also leave
 *   fullscreen.
 * @returns {boolean} True when the press was acted on (or deliberately swallowed).
 */
export function handleEscapeKey(event, {
  focusedThreadId = null,
  getComposer = () => null,
  canLeaveFullscreen = true,
} = {}) {
  countPress(event);
  // Auto-repeat: holding the key down must not fire the gesture over and over.
  // A held Escape is never an intent to stop twice, and under `double-press` it
  // would arm and immediately consume its own repeat.
  if (event.repeat) return false;

  const preset = getEscapePreset();
  const running = observeRunning();

  let acted;
  if (running) {
    acted = handleWhileRunning(event, preset.running, focusedThreadId, getComposer);
  } else if (armed) {
    // A gesture armed against a turn that has since ended must NOT fall through
    // to the idle rung: a double-tap racing the turn's natural end would wipe
    // the draft, which is the very failure the gesture exists to prevent.
    disarm();
    return true;
  } else if (host.now() < settleUntil) {
    // The same failure without the gesture: the press after a stop, or after
    // the turn ended a beat before it, is the user still reaching for the turn.
    return true;
  } else {
    acted = preset.idle === 'clear' ? clearPrompt(getComposer) : false;
  }

  if (acted || !canLeaveFullscreen) return acted;
  return leaveFullscreen(event);
}

/**
 * The stop rung: what a press does while the visible conversation is running.
 * @param {KeyboardEvent} event - The keydown being handled.
 * @param {EscapeRunningMode} mode - The active preset's running behaviour.
 * @param {string|null} focusedThreadId - Vantage the press came from.
 * @param {() => any} getComposer - Accessor for the composer.
 * @returns {boolean} True when the press was acted on.
 */
function handleWhileRunning(event, mode, focusedThreadId, getComposer) {
  const shift = event.shiftKey;
  switch (mode) {
    case 'stop':
      if (shift) politeStop(focusedThreadId);
      else hardStop(focusedThreadId);
      return true;

    case 'pause':
      if (shift) hardStop(focusedThreadId);
      else politeStop(focusedThreadId);
      return true;

    case 'two-step':
      // Shift is the one-press escape hatch. Otherwise the pending Pause IS the
      // armed state — it survives a reload and shows in the footer, so the
      // ladder needs no gesture state of its own.
      if (shift || isPausePending(focusedThreadId)) hardStop(focusedThreadId);
      else politeStop(focusedThreadId);
      return true;

    case 'double-press':
      if (shift) { politeStop(focusedThreadId); return true; }
      if (armed) { disarm(); hardStop(focusedThreadId); return true; }
      arm();
      return true;

    case 'clear':
      // Stopping isn't bound to the key at all under this preset, so clearing
      // the prompt mid-run is unambiguous rather than destructive.
      if (shift) { politeStop(focusedThreadId); return true; }
      return clearPrompt(getComposer);

    case 'none':
      if (shift) { politeStop(focusedThreadId); return true; }
      return false;

    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// The settings control
// ---------------------------------------------------------------------------

/**
 * Build the "Escape key" row for the keyboard-shortcuts settings tab: the
 * preset picker plus a live description of what both Escape chords do under the
 * current choice. Shaped like the rows around it (`provider-field` card with an
 * info column and a control column) so it sits in the list without special
 * casing there.
 * @returns {HTMLElement} The settings row.
 */
export function buildEscapeBehaviourRow() {
  const row = document.createElement('div');
  row.className = 'settings-group provider-field shortcut-row escape-behaviour-row';

  const info = document.createElement('div');
  info.className = 'provider-info';
  const nameEl = document.createElement('div');
  nameEl.className = 'provider-name';
  nameEl.textContent = 'Escape key';
  const desc = document.createElement('div');
  desc.className = 'provider-description';
  info.appendChild(nameEl);
  info.appendChild(desc);

  const ctrl = document.createElement('div');
  ctrl.className = 'provider-control';
  const select = document.createElement('select');
  select.className = 'settings-select';
  select.setAttribute('aria-label', 'What the Escape key does');
  for (const preset of ESCAPE_PRESETS) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.label;
    select.appendChild(option);
  }
  ctrl.appendChild(select);

  /** Reflect the stored preference into the picker and the description. */
  const sync = () => {
    const preset = getEscapePreset();
    select.value = preset.id;
    desc.textContent = describeEscapePreset(preset);
  };
  select.addEventListener('change', () => setEscapePreset(select.value));
  // Another window (or the picker itself) changing the pref re-syncs the row.
  window.addEventListener(ESCAPE_BEHAVIOUR_EVENT, sync);
  sync();

  row.appendChild(info);
  row.appendChild(ctrl);
  return row;
}

// Ask for this person's chosen preset at boot. A keypress in the first few
// milliseconds gets the default preset, which is the shipped behaviour rather
// than a wrong one.
if (typeof document !== 'undefined') {
  void reconcilePref('user', PREF_KEY, ESCAPE_BEHAVIOUR_EVENT);
}
