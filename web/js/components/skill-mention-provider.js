//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The `$` skill-mention completion source for {@link CompletionMenu}, plus the
 * send-time extraction helper ({@link extractSkillMentions}) and the per-thread
 * snapshot resolver ({@link getThreadSkillSnapshot}) the composer uses to turn
 * a typed `$name` into an explicit `skill` tool-call before the next model turn.
 *
 * This is the user-directed counterpart to the model's automatic `skill`
 * activation: typing `$tdd` (or picking from the composer skill button) loads
 * that skill through the SAME visible tool-call the model would make, so
 * exact-name resolution, harmless re-load, and read-only permission all carry
 * over unchanged. Candidates come from the conversation's FROZEN skill snapshot
 * (never the live catalog), so the composer can never offer or send a `$name`
 * the `skill` tool would then reject.
 *
 * Skill names are backend-validated to `^[a-z0-9]+(-[a-z0-9]+)*$` (lowercase,
 * digits, single hyphens). The trigger only fires at a mention boundary
 * (start-of-text or after whitespace) over that charset, so `$HOME`, `$PATH`,
 * `echo $x`, and `price: $5` never activate it, and send-time extraction only
 * strips a `$token` whose exact name is in the snapshot.
 * @module components/skill-mention-provider
 */

import { longestCommonPrefix } from './completion-menu.js';
import { getAvailableSkills } from '../services/skills.js';
import { markForTranslation } from '../../sdk/lib/i18n.js';

/**
 * Decide whether a `$` at position `atIdx` in `textBefore` is a skill-mention
 * trigger (vs. a shell variable, price, or `$` embedded in another token).
 *
 * Rule (mirrors the `@` file-mention boundary): the char immediately before the
 * `$` must be start-of-text, ASCII whitespace, or a newline. Everything else
 * (letter, digit, quote, paren, punctuation) means the `$` is part of some
 * other token and must not trigger.
 * @param {string} textBefore - Text from start of the textarea up to the cursor
 * @param {number} atIdx - Index of the `$` in `textBefore`
 * @returns {boolean} True if the `$` is a mention trigger
 */
function isMentionBoundary(textBefore, atIdx) {
  if (atIdx <= 0) return true;
  const prev = textBefore.charAt(atIdx - 1);
  return prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r';
}

/**
 * The per-thread frozen skill snapshot the composer offers and resolves against:
 * the exact set advertised to the model this conversation. Reads the standing
 * Skills context item's frozen list via its public {@link SkillContextItem#getSnapshotSkills}
 * accessor; falls back to the live catalog only when the item has not been
 * seeded yet (a brand-new conversation, where the two are equal by construction).
 * @param {import('../model/message-thread.js').MessageThread|null|undefined} messageThread - The column's message thread
 * @returns {Promise<import('../services/skills.js').SkillMeta[]>} Snapshot skill rows (may be empty)
 */
export async function getThreadSkillSnapshot(messageThread) {
  try {
    const items = /** @type {any} */ (messageThread)?.getContextItems?.() || [];
    const skillItem = items.find(
      (/** @type {any} */ ci) => /** @type {any} */ (ci?.constructor)?.MANIFEST?.id === 'skill'
    );
    if (skillItem?.getSnapshotSkills) {
      const snap = await skillItem.getSnapshotSkills();
      if (Array.isArray(snap)) return snap;
    }
  } catch {
    // Fall through to the live catalog on any thread/instantiation error.
  }
  try {
    return await getAvailableSkills();
  } catch {
    return [];
  }
}

/**
 * Build a `$` skill-mention completion provider bound to one composer's live
 * thread. A factory (not a shared singleton) because the candidate list is
 * per-conversation: each column resolves its own frozen snapshot via `getSkills`,
 * evaluated lazily on every fetch so a thread swap is picked up without rewiring.
 * @param {() => Promise<import('../services/skills.js').SkillMeta[]>} getSkills - Resolves this thread's snapshot rows
 * @returns {import('./completion-menu.js').CompletionProvider} The provider
 */
export function createSkillMentionProvider(getSkills) {
  return {
    id: 'skill-mention',
    emptyLabel: markForTranslation('No matching skills'),

    detect(textBefore) {
      // A `$` at a boundary followed by zero or more name chars, up to the caret.
      const match = textBefore.match(/\$([a-z0-9-]*)$/);
      if (!match) return null;
      if (!isMentionBoundary(textBefore, /** @type {number} */ (match.index))) return null;
      return { anchorPos: /** @type {number} */ (match.index), query: /** @type {string} */ (match[1]) };
    },

    async fetch(query) {
      const skills = (await getSkills()) || [];
      const q = query.toLowerCase();
      return skills
        .filter((s) => s.name.toLowerCase().startsWith(q))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },

    renderItem(skill) {
      return renderSkillMenuItem(skill);
    },

    insert(skill) {
      return '$' + skill.name + ' ';
    },

    tabCompleteReplacement(items, query) {
      const lcp = longestCommonPrefix(items.map((s) => s.name));
      return lcp.length > query.length ? '$' + lcp : null;
    },
  };
}

/**
 * Sanity bound on how many characters of a skill description reach a menu row's
 * DOM. This is NOT the visual truncator — every skill surface ellipsises the
 * description to the popup width in CSS (its own `.menu-item-desc` rule).
 * The cap only guards against a pathologically long description bloating the
 * node; fitting the text to the popup is CSS's job, so it is set generously.
 */
const DESC_MAX = 200;

/**
 * Collapse a description to a single trimmed line, capped at {@link DESC_MAX},
 * so a multi-line or pathologically long description can't distort a menu row.
 * @param {string} text - Raw description
 * @returns {string} One-line, length-bounded description
 */
function oneLineDescription(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= DESC_MAX) return s;
  return s.slice(0, DESC_MAX - 1).trimEnd() + '…';
}

/**
 * Build one skill menu row — mono `$name` then a one-line (length-bounded)
 * description — shared by every skill surface: the `$` completion menu (this
 * provider's `renderItem`) and the composer's button-anchored skill picker
 * (composer-box's `_buildSkillMenu`). The row carries the SAME `menu-item-command`
 * / `menu-item-desc` classes as a slash-command row, so both skill surfaces
 * inherit the slash popup's colour scheme and (in the picker's grid) its
 * justified two-column layout with no bespoke styling. Scope/source is
 * deliberately NOT shown — where a skill lives is noise in a picker. One builder
 * keeps the two surfaces identical; each caller wires its own click/pointer
 * handling onto the returned `<li>`.
 * @param {import('../services/skills.js').SkillMeta} skill - The skill row
 * @returns {HTMLLIElement} The `<li class="menu-item skill-mention-item">` row
 */
export function renderSkillMenuItem(skill) {
  const li = document.createElement('li');
  li.className = 'menu-item skill-mention-item';
  li.dataset.skill = skill.name;

  const name = document.createElement('code');
  name.className = 'menu-item-command';
  name.textContent = '$' + skill.name;
  li.appendChild(name);

  const desc = document.createElement('span');
  desc.className = 'menu-item-desc';
  desc.textContent = oneLineDescription(skill.description || '');
  li.appendChild(desc);

  return li;
}

/**
 * Extract explicit `$name` skill mentions from a message and return the message
 * with those tokens removed, so the trigger syntax is never sent as prose.
 *
 * Two gates, matching {@link isMentionBoundary}'s intent, keep stray `$`s
 * (shell variables, prices) from being eaten:
 *
 *  1. **Boundary** — the `$` must be at start-of-text or directly after
 *     whitespace, and the token must be followed by whitespace or end-of-text.
 *     `foo$tdd`, `$tdd.`, `$5.00` are skipped.
 *  2. **Exact membership** — the token must exactly equal an available skill
 *     name. An unknown `$token` is left verbatim as prose.
 *
 * A matched token consumes one trailing whitespace char so removal leaves no
 * double space; a leftover leading/trailing edge is trimmed. Duplicate mentions
 * collapse to one activation (the `skill` tool is idempotent regardless).
 * @param {string} text - The raw message text
 * @param {Iterable<string>} availableNames - Exact skill names from the snapshot
 * @returns {{names: string[], text: string}} Ordered unique matched names and the trigger-stripped message
 */
export function extractSkillMentions(text, availableNames) {
  const nameSet = availableNames instanceof Set ? availableNames : new Set(availableNames);
  /** @type {string[]} */
  const names = [];
  const seen = new Set();

  // Boundary via lookbehind so match.index stays on the `$`; a trailing
  // whitespace char is consumed (when present) to avoid a doubled space.
  const re = /(?:^|(?<=\s))\$([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s|$)/g;
  const stripped = text.replace(re, (full, name) => {
    if (!nameSet.has(name)) return full; // unknown → leave as prose
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
    return '';
  });

  return { names, text: stripped.trim() };
}
