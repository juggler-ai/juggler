//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * One detection primitive for "will my next send re-read a large slice of the
 * cached conversation?" — surfaced as the composer's context-bust caution.
 *
 * The Anthropic prompt cache prefix is `[tools][system]` followed by the rolling
 * `[history]`; because it is prefix-matched, the next request hits the cache only
 * up to the first position that differs from what was last sent, and re-reads
 * everything after that divergence at full (uncached) price. So the cause of the
 * change is irrelevant — a staged strategy switch that alters the tool set, a
 * deleted or edited earlier message, anything that mutates the prefix — they are
 * all the same event: the outgoing prefix now diverges from the last-sent one
 * above the freshly-appended tail.
 *
 * We model the prefix as an ordered fingerprint. Element 0 is the MODEL: a cache
 * entry belongs to one model at one provider, so changing either discards the
 * whole prefix rather than diverging part-way down it — a different vendor has
 * nothing cached at all, and even a sibling model at the same vendor keys its
 * own entries. The thinking level is signed with it, because providers render
 * the thinking configuration into the prompt itself, so changing the level
 * starts a new prefix exactly as changing the model does. Putting all of that
 * first is what makes it fall out of the same diff: the divergence lands at
 * index 0 and the re-read slice is everything. Element 1
 * is the tool-set signature (the only part of `[tools][system]` a strategy
 * switch changes, since strategy guidance is injected as tail messages, never
 * placed in the system prompt), and the rest is one signature per history item. The baseline is the
 * fingerprint captured when the conversation last went idle (that transcript is
 * exactly what was cached), headed by the model that SENT it rather than the one
 * selected now — a thread that inherits its model has the selection moved under
 * it by an unrelated switch elsewhere, and the cache does not care what is
 * selected, only what ran. Diff current vs baseline: a divergence that *replaces*
 * a cached item (current is not a prefix of baseline) busts the cache from there;
 * the two ways current stays a prefix of baseline both cost nothing — a pure
 * append (a new user message) diverges only past the baseline's end, and a
 * truncation (`/clear`, deleting the tail) diverges only past the shortened
 * current's end, leaving the provider's cache still covering the whole outgoing
 * prefix. Undo restores the transcript, the fingerprint matches the baseline
 * again, and the caution clears.
 *
 * A divergence is necessary but not sufficient to caution: what actually costs is
 * the *size* of the uncached slice re-sent next turn — the previously-cached
 * content re-read from the divergence to the end of its overlap with the cached
 * prefix. Two independent things make that slice cheap, and either one alone
 * clears the caution:
 *   • the divergence sits near the end — editing the last message of a huge
 *     conversation busts the cache but re-reads only a short tail; or
 *   • the whole outgoing context is small — after a `/clear` (or any shrink to a
 *     handful of messages) even a 100%-changed prefix re-reads almost nothing, so
 *     who cares that the cache was lost.
 * Both reduce to the same number: the tokens in the re-read slice. We have one
 * real token measurement (the whole cached prefix, from the last turn's input
 * tokens) and the per-item content lengths baked into the fingerprint, so we
 * apportion that measurement by the content-length fraction that falls in the
 * re-read slice, and caution only when the estimate clears
 * CONTEXT_CACHE_WARNING_TOKENS. (A pure append adds new tail the cache never held,
 * beyond that overlap, so it is not counted — appending never busts.)
 *
 * Items that emit NOTHING to the provider are left out of the fingerprint
 * entirely (see NON_EMITTING_ITEM_TYPES). They are not in the cached prefix, so
 * they cannot move it: signing them would make deleting one — a `notice` a
 * reader tidied away, say — read as a divergence and raise a caution about a
 * bust that never happens.
 * @module services/context-cache-impact
 */

/**
 * Bubbling event the strategy selector fires when its cache-impact
 * classification flips. The composer (composer-box) owns the warning affordance —
 * a round alert beside the send button — so this signal is the only coupling
 * between the two: `detail.busts` is true when the next send would re-read a
 * large slice of cached context, false when it clears.
 * @type {string}
 */
export const CONTEXT_CACHE_IMPACT_CHANGED = 'context-cache-impact-changed';

/**
 * Estimated re-read floor: when the next send would re-read fewer than this many
 * tokens of previously-cached context at full price, the bust is too cheap to
 * caution about (re-warming a small tail next turn costs little). Compared against
 * the apportioned estimate, not the whole cached prefix — so an edit near the end
 * of a long conversation, or any edit in a small one, stays silent. Pure viewer
 * UX — no exact re-read figure is ever shown (the estimate is deliberately
 * approximate), only whether the loss is large enough to mention.
 * @type {number}
 */
const CONTEXT_CACHE_WARNING_TOKENS = 25000;

/**
 * Item types the worker's `itemWireMessages` emits nothing for, so they never
 * reach the provider and are never part of the cached prefix. Excluded from the
 * fingerprint so adding or removing one costs nothing and reads as nothing.
 * @type {ReadonlySet<string>}
 */
const NON_EMITTING_ITEM_TYPES = new Set(['notice']);

/**
 * How many leading fingerprint entries describe the request's shape (the model,
 * then the tool set) rather than a piece of content. They carry no content
 * weight, so the size estimate skips them.
 * @type {number}
 */
const PREFIX_HEAD_ENTRIES = 2;

/**
 * A cheap, stable per-item signature: its id plus a light content fingerprint
 * (type + content length). Deleting, inserting, or reordering items changes the
 * id sequence; most edits change the content length. A content-preserving edit
 * (same length) is deliberately not detected — not worth hashing full bodies on
 * every keystroke for that rare case.
 * @param {{get?: (key: string) => any}} item - A history item (Y.Map or plain)
 * @returns {string} The item signature
 */
function itemSignature(item) {
  const get = item?.get?.bind(item);
  if (!get) return '?';
  const id = String(get('itemId') || get('messageId') || get('transactionId') || '');
  const type = String(get('type') || '');
  const content = get('content');
  const len = typeof content === 'string' ? content.length : 0;
  return `${id}~${type}~${len}`;
}

/**
 * A signature for a leading `prefix` context item: its id, type, and the length
 * of whatever bytes it persists. Adding, removing, or re-pinning one changes the
 * id sequence; a re-snapshot with different bytes changes the length. Same
 * `~<len>` tail encoding as {@link itemSignature}, so {@link signatureWeight}
 * sizes its re-read slice too.
 *
 * This weighs `data.content`, which means it sees exactly the items that keep
 * their bytes in the document — a dropped file, and an `@`-mentioned or
 * auto-seeded file once it has frozen (`file-content-context-item.js`). Those are
 * the ones whose content can change between sends without the conversation
 * moving, so they are the ones worth signing.
 *
 * KNOWN BLIND SPOT: a live pin (a `file-content` item that is not frozen)
 * persists only a path, so it signs as `~0` no matter what the file says, and a
 * change to its bytes is invisible here. That is not an oversight to tidy up
 * cheaply — closing it needs a content signal this module can read synchronously,
 * and the pin deliberately has no watcher (nothing re-reads the file between
 * sends), so there would frequently be nothing current to read. The cost is
 * bounded by the fact that only the file picker makes a live pin — a deliberate
 * act on a file the user wants kept current — whereas mentioned and seeded files
 * are frozen and therefore cannot drift silently at all.
 * @param {{id?: string, type?: string, data?: {content?: unknown}}} ci - A context item instance
 * @returns {string} The context-item signature
 */
function contextItemSignature(ci) {
  const id = String(ci?.id || '');
  const type = String(ci?.type || '');
  const content = ci?.data?.content;
  const len = typeof content === 'string' ? content.length : 0;
  return `ctx:${id}~${type}~${len}`;
}

/**
 * Build the ordered prefix fingerprint: the model, the tool-set signature, then
 * one signature per leading `prefix` context item, then one per history item.
 *
 * The model heads the list because a cache entry is scoped to it (see the module
 * comment): a switch diverges at index 0, so the whole prefix is re-read, which
 * is exactly what happens.
 *
 * Prefix context items (pinned files, dropped files, seeded agents files) sit
 * between tools+system and the growing history, so they ARE part of the cached
 * prefix: adding, removing, or re-pinning one busts the cache from its position,
 * exactly like editing a history item. They precede the history entries here so a
 * divergence in them is measured against everything cached after them.
 * @param {object} args
 * @param {string} [args.modelSig] - The `provider/model#thinking` this prefix belongs to (the next send's for the outgoing one, the anchored turn's for a baseline)
 * @param {string} args.toolsetSig - Sorted tool-name signature under the effective strategy
 * @param {Array<{id?: string, type?: string, data?: {content?: unknown}}>} [args.prefixItems] - The thread's leading `prefix`-position context items
 * @param {Array<{get?: (key: string) => any}>} args.items - The thread's history items
 * @returns {string[]} The prefix fingerprint
 */
export function buildPrefixFingerprint({ modelSig, toolsetSig, prefixItems = [], items }) {
  const fp = ['model:' + (modelSig || ''), 'tools:' + (toolsetSig || '')];
  for (const ci of prefixItems || []) fp.push(contextItemSignature(ci));
  for (const item of items || []) {
    if (NON_EMITTING_ITEM_TYPES.has(String(item?.get?.('type') || ''))) continue;
    fp.push(itemSignature(item));
  }
  return fp;
}

/**
 * Recover a fingerprint entry's content-length weight — the trailing `~<len>`
 * that itemSignature() encodes. Used to size the re-read slice by content, so a
 * bust that re-reads one big message weighs more than one that re-reads several
 * tiny ones. The two head entries ('model:…' and 'tools:…', neither carrying a
 * `~<len>` tail) weigh 0: their real cost lives in the tool definitions and
 * system prompt this module does not track, and a change to either re-reads the
 * whole history after it anyway, so item content dominates the estimate.
 * @param {string|undefined} sig - A fingerprint entry
 * @returns {number} Its content-length weight (0 when none is encoded)
 */
function signatureWeight(sig) {
  if (typeof sig !== 'string') return 0;
  const i = sig.lastIndexOf('~');
  if (i < 0) return 0;
  const len = parseInt(sig.slice(i + 1), 10);
  return Number.isFinite(len) ? len : 0;
}

/**
 * Classify whether the next send re-reads a large slice of cached context, by
 * diffing the outgoing prefix fingerprint against the last-sent baseline and
 * sizing the re-read slice that the divergence creates.
 * @param {object} args
 * @param {string[]|null} args.baseline - Fingerprint captured at the last idle (null when none yet)
 * @param {string[]|null} args.current - Fingerprint of what the next send would build
 * @param {number} args.anchorTokens - Last turn's input tokens (0 when nothing anchored)
 * @returns {'none'|'busts-large'} Impact classification
 */
export function classifyContextCacheImpact({ baseline, current, anchorTokens }) {
  // No baseline (fresh bind / tools not resolved) → nothing cached to lose.
  if (!baseline || !current) return 'none';
  const n = baseline.length;
  // First index where the outgoing prefix diverges from the cached one.
  let d = 0;
  while (d < n && d < current.length && current[d] === baseline[d]) d++;
  // The re-read slice is the previously-cached region the divergence invalidates,
  // as re-sent by the outgoing transcript: current[d .. min(n, current.length)).
  // The min() bound is what makes append and truncation free without special
  // casing — an append leaves d === n (empty slice), and a truncation (/clear,
  // tail-delete) leaves d === current.length (empty slice), so neither re-reads
  // anything. Content past that bound is a genuinely new tail the cache never
  // held, not a re-read, so it is excluded.
  const overlapEnd = Math.min(n, current.length);
  let reReadChars = 0;
  for (let i = d; i < overlapEnd; i++) reReadChars += signatureWeight(current[i]);
  if (reReadChars === 0) return 'none';
  // Size the slice in tokens. anchorTokens measures the whole cached prefix, so
  // anchorTokens / (its content chars) is the last turn's token-per-char density;
  // apply it to the re-read slice's chars. This gates on the tokens actually
  // re-sent, so a bust is silent both when the divergence sits near the end (short
  // slice) and when the whole conversation is now small (few chars to re-read at
  // all) — e.g. right after a /clear.
  let baselineChars = 0;
  for (let i = PREFIX_HEAD_ENTRIES; i < n; i++) baselineChars += signatureWeight(baseline[i]);
  const estReReadTokens = baselineChars > 0
    ? anchorTokens * (reReadChars / baselineChars)
    : 0;
  return estReReadTokens >= CONTEXT_CACHE_WARNING_TOKENS ? 'busts-large' : 'none';
}
