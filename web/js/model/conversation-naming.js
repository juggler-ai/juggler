//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Conversation naming — the browser-side SINGLE SOURCE OF TRUTH for the default
 * names an untitled conversation carries before it is titled, for the names
 * derived from another conversation ("<source> (copy)", "<source> (continued)"),
 * and for the doc-metadata key recording whether the current name is still
 * provisional. The placeholder shape is the twin of Go's
 * cmd/juggler/core/conversation_naming.go and worker.metaProvisionalName (the
 * marker key): the client generates the numbered placeholder a fresh
 * conversation requests, the worker seeds the marker from that same shape, and
 * the server's auto-namer reads the marker — so all of them must agree exactly.
 * Go tests read this file and assert they never drift — change both together.
 * @module model/conversation-naming
 */

import { MAX_CONVERSATION_NAME_LENGTH } from '../utils/constants.js';
import { t } from '../../sdk/lib/i18n.js';

/** The bare display/folder fallback for a conversation that has no name yet. */
export const UNTITLED_BASE = 'Untitled';

/**
 * Matches the numbered placeholder shape ("Untitled 7"), anchored end to end.
 * The capture group exposes N so callers can find the smallest unused number.
 */
export const UNTITLED_NAME_RE = /^Untitled (\d+)$/;

/**
 * The numbered placeholder for n (n >= 1), e.g. `untitledName(3)` → "Untitled 3".
 * @param {number} n
 * @returns {string} The numbered placeholder name for n.
 */
export function untitledName(n) {
  return `${UNTITLED_BASE} ${n}`;
}

/**
 * The name to show for a conversation. The placeholder names are stored in
 * English — the server's IsUntitledName and auto-namer match them — so they are
 * translated here, where they are drawn, keeping N as data. Any other name is
 * the user's (or the model's) and is shown as stored.
 * @param {string|null|undefined} name - The stored name.
 * @returns {string} The name in the UI language.
 */
export function displayConversationName(name) {
  if (!name || name === UNTITLED_BASE) return t('Untitled');
  const match = UNTITLED_NAME_RE.exec(name);
  if (match) return t('Untitled {n}', { n: match[1] });
  return name;
}

/**
 * Build the name for a conversation derived from another one — a /duplicate
 * clone ("<source> (copy)"), a /handoff continuation ("<source> (continued)"),
 * … — that is both unique and short enough to survive intact.
 *
 * Three rules, applied in order:
 *  1. Strip an existing " (<word>)" / " (<word> N)" tail off sourceName, so
 *     re-deriving doesn't stack "X (copy) (copy)".
 *  2. Clip the BASE — never the suffix — to keep the whole name within
 *     maxLength. The suffix is the only thing distinguishing the derived tab
 *     from its source, so a source already near the cap gives up its own tail
 *     rather than have "(continued)" chopped to "(contin" by the server's
 *     filesystem-safety truncation (core.SanitizedNameMaxRunes), which cuts
 *     from the end and would otherwise leave the two tabs looking identical.
 *  3. Bump a counter — " (copy 2)", " (copy 3)", … — until isTaken reports the
 *     candidate free. Each candidate is clipped for its own suffix, so a longer
 *     counter tail eats further into the base instead of overflowing the cap.
 * @param {string} sourceName - Name of the conversation being derived from
 * @param {string} word - Suffix word, e.g. 'copy' or 'continued'
 * @param {(name: string) => boolean} isTaken - Reports whether a candidate name is already in use
 * @param {number} [maxLength] - Character cap for the result
 * @returns {string} A unique "<base> (<word>)" name within the cap.
 */
export function uniqueSuffixedName(sourceName, word, isTaken, maxLength = MAX_CONVERSATION_NAME_LENGTH) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const base = (sourceName || '').replace(new RegExp(`\\s*\\(${escaped}(?:\\s+\\d+)?\\)$`), '');

  /**
   * @param {string} suffix - The " (<word>)" / " (<word> N)" tail to append
   * @returns {string} The base clipped to make room for suffix, plus suffix.
   */
  const withSuffix = (suffix) => {
    let clipped = base.slice(0, Math.max(0, maxLength - suffix.length));
    // Don't strand a lone high surrogate when the clip lands mid-pair (an emoji
    // in the name), and drop whitespace the clip exposed so the suffix doesn't
    // float away from the base.
    if (/[\uD800-\uDBFF]$/.test(clipped)) clipped = clipped.slice(0, -1);
    clipped = clipped.trimEnd();
    // Nothing left of the base (empty source, or a suffix that fills the cap on
    // its own): return the bare suffix rather than a name with a leading space,
    // which the server would trim into a different name than we asked for.
    return clipped ? `${clipped}${suffix}` : suffix.trimStart();
  };

  const first = withSuffix(` (${word})`);
  if (!isTaken(first)) return first;
  let n = 2;
  let candidate = withSuffix(` (${word} ${n})`);
  while (isTaken(candidate)) {
    n++;
    candidate = withSuffix(` (${word} ${n})`);
  }
  return candidate;
}

/**
 * Doc-metadata key recording the PROVENANCE of a conversation's name: true while
 * the name is provisional — machine-derived and free to be replaced — false once
 * a human has typed one and the name is theirs. "Untitled 3", "Foo (continued)",
 * and a title the auto-namer wrote are all provisional; only a hand-typed name is
 * committed. (The bare numbered placeholder, which Go's core.IsUntitledName
 * tests for, is only one provisional shape.)
 *
 * The name itself is not in the doc — it is the on-disk folder name — so this is
 * the only record of where it came from, and it is what the server's auto-namer
 * checks before replacing a title. Mirrors Go worker.metaProvisionalName.
 *
 * Write it through {@link module:model/session~Session#setNameIsProvisional}
 * rather than touching metadata directly, so every naming seam goes through one
 * place.
 */
export const PROVISIONAL_NAME_KEY = 'isProvisionalName';
