//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The colour a workspace is known by.
 *
 * Boxes in the tab strip are all the same shape and mostly the same size, and
 * the one thing telling them apart is a name that is often a branch — three of
 * which can share their first twenty characters and all of which ellipsise. A
 * hue is read before a word is, so it is what makes a box findable in a strip
 * of them.
 *
 * Derived from the id rather than stored on the row: it costs no field, no
 * migration and no round trip, it is the same colour in every window and after
 * every reload, and there is no state to go stale. The cost is that two
 * workspaces can land on one hue — which is a nuisance and not a bug, the name
 * being what actually identifies a box.
 *
 * The colours themselves are `--workspace-tint-N` in `css/tokens/theme-dark.css`
 * and `theme-light.css`: each slot is one of the context-item presets, in the
 * same order in both themes, so a hue keeps its identity and changes only its
 * depth. This file picks a slot and knows nothing about what is in it.
 * @module utils/workspace-colour
 */

/** How many `--workspace-tint-N` the token file defines. Keep the two in step. */
const TINT_COUNT = 8;

/**
 * A stable 32-bit hash of a string: FNV-1a, which is small, has no
 * dependencies and scatters ids that differ in one character — a real
 * consideration here, where ids are generated in a batch and share a prefix.
 * Nothing depends on the exact hash beyond its being stable, so the one thing
 * this must never do is change: every workspace (and every project's automatic
 * border colour, utils/project-colour.js) would swap colour on upgrade, which
 * is the whole of what the colour is for.
 * @param {string} text - What to hash.
 * @returns {number} An unsigned 32-bit hash.
 */
export function fnv1a(text) {
  const s = String(text ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    // The FNV prime by shift-and-add: a plain `* 16777619` overflows a double's
    // exact-integer range and quietly stops being the hash it is named after.
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    hash >>>= 0;
  }
  return hash;
}

/**
 * Which tint a workspace uses: a slot picked by {@link fnv1a} of its id.
 * @param {string} workspaceId - The row's id.
 * @returns {string} A CSS value naming one of the theme's tints.
 */
export function workspaceTint(workspaceId) {
  return `var(--workspace-tint-${(fnv1a(workspaceId) % TINT_COUNT) + 1})`;
}
