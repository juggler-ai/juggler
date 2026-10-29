//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The change report the model is sent after a program tool's result.
 *
 * The worker builds it in the wire projection (`programChangeReport`,
 * cmd/juggler/worker/program_changes.go) from the call record the engine keeps
 * on the program's tool-action (`displayData.nestedCalls`), so the model is
 * told what changed however the program ended — including a cancel or an engine
 * death, where the program never returns anything. This is its mirror, byte for
 * byte, for the numbers the UI works out itself (`llmTextForItem`).
 * @module utils/program-changes
 */

/** Longest list of changes listed before the rest are counted. */
const MAX_LINES = 50;

/**
 * A stored object as a plain record: a Y.Map's `toJSON()`, a plain object as it
 * is, and an empty record for anything else.
 * @param {unknown} value - A Y.Map, a plain object, or neither.
 * @returns {Record<string, unknown>} Its fields.
 */
function plainRecord(value) {
  /** @type {unknown} */
  const data = value && typeof value === 'object' && 'toJSON' in value && typeof value.toJSON === 'function'
    ? value.toJSON()
    : value;
  return data && typeof data === 'object' ? /** @type {Record<string, unknown>} */ (data) : {};
}

/**
 * The changes a program tool made, as appended to its tool_result: every
 * call that changes things, noted when it failed or never finished. Identical
 * lines (a file edited twice) are listed once, where the first fell, with a
 * count. Reads are never listed.
 * @param {unknown} displayData - The program's displayData, plain or a Y.Map
 * @returns {string} The report, or '' when the record holds no change
 */
export function programChangeReport(displayData) {
  const data = plainRecord(displayData);
  const calls = Array.isArray(data.nestedCalls) ? data.nestedCalls : [];
  /** Each distinct line, by its text, with how many calls it stands for. */
  /** @type {Map<string, number>} */
  const lines = new Map();
  for (const c of calls) {
    const call = plainRecord(c);
    const effect = call.effect;
    if (typeof effect !== 'string' || effect === '') continue;
    const note = call.status === 'ok' ? '' : call.status === 'error' ? ' (failed)' : ' (interrupted)';
    const line = `${effect}${note}`;
    lines.set(line, (lines.get(line) ?? 0) + 1);
  }
  const all = [...lines];
  const kept = all.slice(0, MAX_LINES);
  // Past the cap, the rest are counted in changes, not lines.
  const omitted = typeof data.omittedEffects === 'number' && Number.isInteger(data.omittedEffects) ? data.omittedEffects : 0;
  const extra = all.slice(MAX_LINES).reduce((n, [, count]) => n + count, omitted);
  if (kept.length === 0 && extra === 0) return '';
  let text = '\n\nChanges the program made:'
    + kept.map(([line, count]) => `\n- ${line}${count > 1 ? ` (×${count})` : ''}`).join('');
  if (extra > 0) text += `\n…and ${extra} more`;
  return text;
}
