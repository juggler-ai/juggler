//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Read an item's `data` map, whatever shape it arrived in.
 *
 * The worker writes it with `json.Marshal`, so it reaches a reader as a Yjs type
 * when it came through the shared document, as a JSON string when it came
 * through a serialized snapshot, and occasionally as a plain object already.
 * Every consumer would otherwise repeat the same three-way decode, and any one
 * of them getting it wrong shows up as a silently absent field rather than an
 * error.
 * @param {{ get: (key: 'data') => unknown }} message - The conversation item
 * @returns {Record<string, unknown>|null} The decoded data, or null if absent or unreadable.
 */
export function readItemData(message) {
  const raw = message?.get?.('data');
  if (!raw) return null;
  if (typeof raw === 'object' && 'toJSON' in raw && typeof raw.toJSON === 'function') return raw.toJSON();
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : null;
}
