//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The `thoroughness` dial both sub-agent tools expose.
 *
 * It is the one knob a caller genuinely needs: how much of its budget the child
 * should spend before answering. Everything else about a sub-agent run — its
 * tools, its brief, the shape of its answer — is fixed by the tool it belongs
 * to, and a caller cannot usefully tune those from outside.
 * @module context-items/subagents/thoroughness
 */

/**
 * @typedef {'quick'|'medium'|'thorough'} Thoroughness
 */

/**
 * How each level is expressed to the child, as one line appended to its seed.
 * Its keys ARE the vocabulary — the schema enum and the normalizer both derive
 * from them, so a level can't exist without an instruction to go with it.
 */
const EFFORT = Object.freeze({
  quick: 'Answer as soon as you can support an answer — a few searches, not an audit.',
  medium: 'Confirm what you find in a second place before you conclude.',
  thorough: 'Be exhaustive: follow every lead to its source before you conclude, and say what you ruled out.'
});

/**
 * Allowed values, in ascending effort. Also the tool schema's enum.
 * @type {readonly Thoroughness[]}
 */
const THOROUGHNESS_LEVELS = Object.freeze(
  /** @type {Thoroughness[]} */ (Object.keys(EFFORT))
);

/** @type {Thoroughness} */
const DEFAULT_THOROUGHNESS = 'medium';

/**
 * Normalize a caller-supplied thoroughness to a known level.
 * @param {unknown} value - Raw value from the tool input
 * @returns {Thoroughness} One of {@link THOROUGHNESS_LEVELS}
 */
function normalizeThoroughness(value) {
  const level = /** @type {Thoroughness} */ (typeof value === 'string' ? value.toLowerCase() : '');
  return THOROUGHNESS_LEVELS.includes(level) ? level : DEFAULT_THOROUGHNESS;
}

/**
 * The effort instruction for a level, ready to append to a seed prompt.
 * @param {unknown} value - Raw or normalized thoroughness
 * @returns {string} One line of instruction
 */
export function effortInstruction(value) {
  return EFFORT[normalizeThoroughness(value)];
}

/**
 * The shared schema fragment for the `thoroughness` argument, so both tools
 * describe the dial identically.
 * @returns {{type: string, enum: string[], default: string, description: string}} JSON Schema property
 */
export function thoroughnessSchema() {
  return {
    type: 'string',
    enum: [...THOROUGHNESS_LEVELS],
    default: DEFAULT_THOROUGHNESS,
    description: 'How much effort to spend before answering: "quick" for a first solid answer, "medium" (default) to corroborate it, "thorough" to be exhaustive.'
  };
}
