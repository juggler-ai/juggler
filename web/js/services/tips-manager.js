//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * TipsManager — the source of truth for onboarding tips: short hints that raise
 * awareness of features a new user is unlikely to stumble on. They are shown by
 * the rolling tip at the foot of a new conversation's starting hint
 * ({@link module:components/empty-hint-tips}); this module just owns the tip list
 * and the persisted "seen" state, which decides the tip that strip opens on.
 *
 * Shortcut tips are *derived* from the {@link module:services/key-shortcut-manager
 * KeyShortcutManager} by id, so their title and key glyph can't drift from the
 * real (rebindable) binding. Feature tips are hand-authored for gestures with no
 * key. "Seen" state follows the person rather than the project or the window
 * (see services/prefs.js): a tip learnt once is learnt, and putting it in a
 * project's session would have every new project teach every tip again.
 * @module services/tips-manager
 */

import keyShortcutManager from './key-shortcut-manager.js';
import { cachedUserPref, setUserPref, notifyPrefChanged, reconcilePref } from './prefs.js';

/** The user preference holding `{ seen: string[] }`. */
const PREF_NAME = 'juggler-tips';

/** Fired on `window` whenever the seen set changes. */
const TIPS_CHANGED_EVENT = 'juggler:tips-changed';

/**
 * A materialized tip ready for display.
 * @typedef {object} Tip
 * @property {string} id - Stable identifier, also the "seen" key.
 * @property {'shortcut'|'feature'} kind - Shortcut tips render a live key glyph.
 * @property {string} title - Short headline.
 * @property {string} body - One-line explanation.
 * @property {string} [shortcutId] - For `kind:'shortcut'`, the KeyShortcutManager
 *   id — the view formats it live so the glyph stays platform-correct.
 */

/**
 * Every tip, in priority order — the order the strip opens on and steps
 * through, so the head of the list is what a user who glances once actually
 * sees. It leads with what makes Juggler different (several conversations at
 * once, and moving between them), then the composer controls reached for every
 * turn, then the occasional ones.
 *
 * A shortcut tip is `{ kind: 'shortcut', id, body }`: its title and key glyph
 * are read live from the shortcut table (an id no longer defined is dropped);
 * the body is authored here so it adds context instead of restating the title.
 * A feature tip is a whole {@link Tip}, for a gesture with no key, limited to
 * gestures verified to exist.
 *
 * Nothing here repeats what the starting hint already says above the strip
 * (send, new line, @ to reference a file, / for commands, drag-and-drop), and a
 * pair of twin commands gets one tip, not two slots in a short rotation.
 * @type {Array<{kind: 'shortcut', id: string, body: string} | Tip>}
 */
const TIPS = [
  { kind: 'shortcut', id: 'new-conversation', body: 'Spin up another conversation and switch to it — run several in parallel.' },
  { kind: 'shortcut', id: 'jump-to-attention', body: 'Jump straight to whichever conversation is waiting on you, landing on its pending approval.' },
  { kind: 'shortcut', id: 'strategy-switch', body: 'Flip the active strategy from the composer; hold to open the full strategy menu.' },
  { kind: 'shortcut', id: 'cycle-model', body: 'Tap to flip back to your previous model; hold to open the full model menu — no mouse needed.' },
  {
    id: 'workspaces',
    kind: 'feature',
    title: 'Workspaces',
    body: 'A workspace is a custom environment for the LLM to work in — e.g. a git worktree, or a copy to try '
      + 'something risky in. Make one at the foot of the conversation list, then start '
      + 'conversations in it or drag them across.',
  },
  { kind: 'shortcut', id: 'toggle-file-editing', body: 'Flip between letting the agent edit files freely and asking you first.' },
  { kind: 'shortcut', id: 'pause-conversation', body: 'Pause after the current step finishes — a non-destructive stop, instead of a hard cancel.' },
  { kind: 'shortcut', id: 'next-tab', body: 'Step through your conversation list without leaving the keyboard; Previous conversation steps back.' },
  { kind: 'shortcut', id: 'cycle-thinking', body: 'Nudge the current model\u2019s thinking level up or down; hold to open the level popover.' },
  { kind: 'shortcut', id: 'find-in-conversation', body: 'Search the text of whatever you\u2019re reading — the conversation, a properties panel, a pin.' },
  {
    id: 'paste-images',
    kind: 'feature',
    title: 'Paste a screenshot',
    body: 'Paste an image straight into the composer to attach it to your prompt.',
  },
  { kind: 'shortcut', id: 'rename-conversation', body: 'Give the current conversation a memorable name, straight from the keyboard.' },
  { kind: 'shortcut', id: 'bin-conversation', body: 'Clear a conversation out of the way — you can restore it from the Bin anytime.' },
];

/**
 * Read the persisted state, tolerant of a missing/corrupt blob.
 * @returns {{seen: string[]}} The merged state.
 * @private
 */
function readState() {
  const raw = cachedUserPref(PREF_NAME, {});
  return {
    seen: Array.isArray(raw.seen) ? raw.seen.filter((/** @type {any} */ x) => typeof x === 'string') : [],
  };
}

/**
 * Persist state, best-effort (a failed write just re-shows the tip next session).
 * @param {{seen: string[]}} state
 * @private
 */
function writeState(state) {
  void setUserPref(PREF_NAME, state);
}

/**
 * Every tip in priority order, with shortcut copy materialized live from the
 * table. Dangling shortcut ids are dropped.
 * @returns {Tip[]} All displayable tips in priority order.
 */
export function allTips() {
  /** @type {Tip[]} */
  const tips = [];
  for (const entry of TIPS) {
    if (entry.kind !== 'shortcut') {
      tips.push(/** @type {Tip} */ (entry));
      continue;
    }
    const def = keyShortcutManager.all().find((d) => d.id === entry.id);
    // Drop a dangling id, and any command with no key on this platform — a tip
    // exists to teach a keystroke, so one we deliberately left unbound here has
    // nothing to teach. (The strip renders the binding live, so a command that
    // keeps a different key here still gets its tip, showing that key.)
    if (!def || keyShortcutManager.getBindings(entry.id).length === 0) continue;
    tips.push({ id: entry.id, kind: 'shortcut', title: def.label, body: entry.body, shortcutId: entry.id });
  }
  return tips;
}

/**
 * @param {string} id
 * @returns {boolean} Whether this tip has been seen.
 */
export function isSeen(id) {
  return readState().seen.includes(id);
}

/**
 * Retire one tip permanently (learn-by-doing: the user performed its action on
 * their own). Idempotent.
 * @param {string} id
 * @returns {void}
 */
export function markSeen(id) {
  const state = readState();
  if (!state.seen.includes(id)) {
    state.seen.push(id);
    writeState(state);
    notifyPrefChanged(TIPS_CHANGED_EVENT);
  }
}

// Ask for this person's seen set at boot. Reads are synchronous by design — a
// strip that opens on an already-learnt tip is a far smaller cost than one that
// cannot render until a round trip finishes.
if (typeof document !== 'undefined') {
  void reconcilePref('user', PREF_NAME, TIPS_CHANGED_EVENT);
}
