//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Read-before-mutate freshness, derived from the durable conversation
 * transcript.
 *
 * The edit tool refuses to modify an existing file the model hasn't looked at
 * this session (Claude Code-style), and refuses when the file's bytes have
 * changed on disk since the model last saw them — so a blind or stale
 * search-and-replace can't corrupt a file the model is only guessing at. The
 * write tool has no such precondition: its approval UI diffs the file's whole
 * current contents against the proposed ones, so the user sees every byte an
 * overwrite destroys, whereas an edit's approval shows only the changed hunk
 * and says nothing about the rest of the file. Both answers come entirely from
 * state the conversation persists in its Yjs document:
 *
 *  - successful `read`/`write`/`edit`/`batch_read` tool-actions for the path
 *    (the model read, created, or already mutated it), and `query_code`
 *    actions whose sandbox script `fs.readFile`-ed it. Their recorded results
 *    carry `contentHash` — the SHA-256 of the file's raw on-disk bytes that the
 *    backend echoes from every read and mutation — which is compared against
 *    the file's current hash to detect out-of-band change;
 *  - a pinned / at-mentioned file-content context item for the path. A pin is
 *    re-rendered into context at send time, so a pinned file is always treated
 *    as fresh. A mention (or a seeded agents file) is a frozen snapshot that
 *    records no hash, so it counts as seen-but-unverifiable.
 *
 * Because the transcript is durable and shared, freshness survives app
 * relaunch, engine restarts, and additional clients attaching, and reads the
 * same doc in either browser realm — there is no per-process state to lose or
 * keep in sync. A matching record without a stored hash (transcripts written
 * before hashes were recorded) counts as seen-but-unverifiable: the mutation is
 * allowed rather than forcing a spurious re-read.
 * @module context-items/read-history
 */

import { toolInputPath, absolutePathKey } from './path-approval.js';
import { itemField } from 'juggler/model';
import { markUntranslated } from 'juggler/i18n';

/**
 * Canonical comparison key for the freshness guard. macOS (default APFS/HFS+)
 * and Windows resolve `README.md` and `readme.md` to the SAME file, so a read
 * recorded under one spelling must match an edit issued under another — else the
 * guard refuses a file the model demonstrably read as "not read this session".
 * Folds absolutePathKey to lower case on those platforms and returns it verbatim
 * on case-sensitive ones (Linux). Comparison/lock/written-hash keys use this;
 * display paths keep their original case via absolutePathKey directly.
 * @param {object|undefined} session - Session (provides projectPath + platform)
 * @param {string|undefined} path - File path in any form
 * @returns {string} Comparison key, or '' when no path was given
 */
export function pathMatchKey(session, path) {
  const key = absolutePathKey(session, path);
  if (!key) return '';
  const platform = String(/** @type {any} */ (session)?.platform || '').toLowerCase();
  const caseInsensitive = platform === 'darwin' || platform.startsWith('win');
  return caseInsensitive ? key.toLowerCase() : key;
}

/**
 * In-memory, per-realm record of content hashes written by each conversation via
 * a completed edit/write. Each conversation owns a map keyed by canonical
 * absolute path (pathMatchKey).
 *
 * Layered on top of the durable transcript purely to close a timing window:
 * when several edits to the same file execute within one assistant turn, an
 * earlier edit's completed tool-action — which carries its post-edit hash — may
 * not yet be observable in the Yjs transcript when the next edit validates, so
 * the follow-up would see its own sibling's freshly-written bytes as an
 * out-of-band change and be spuriously refused. recordWrittenHash captures every
 * hash this conversation actually wrote, synchronously at execute time. A
 * different conversation cannot use those hashes as read authorization.
 * Bounded per path to cap memory over a long conversation.
 * @type {WeakMap<object, Map<string, Set<string>>>}
 */
let writtenHashes = new WeakMap();

/** Cap on remembered hashes per path, bounding memory over a long session. */
const MAX_WRITTEN_HASHES_PER_PATH = 8;

/**
 * Record a content hash this conversation just wrote to `path`, so a follow-up
 * mutation of the same file within the same assistant turn passes the freshness
 * guard without waiting for the durable transcript to catch up. Safe by
 * construction: only the same conversation can use hashes of bytes it wrote.
 * @param {object|undefined} conversation - Conversation that performed the write
 * @param {object|undefined} session - Session (for path resolution)
 * @param {string|undefined} path - File path that was written
 * @param {string|undefined} hash - The file's on-disk content hash after the write
 * @returns {void}
 */
export function recordWrittenHash(conversation, session, path, hash) {
  if (!conversation || typeof hash !== 'string' || !hash) return;
  const target = pathMatchKey(session, path);
  if (!target) return;
  let paths = writtenHashes.get(conversation);
  if (!paths) {
    paths = new Map();
    writtenHashes.set(conversation, paths);
  }
  let set = paths.get(target);
  if (!set) {
    set = new Set();
    paths.set(target, set);
  }
  set.add(hash);
  // A Set preserves insertion order: evict the oldest once over the cap.
  while (set.size > MAX_WRITTEN_HASHES_PER_PATH) {
    const oldest = /** @type {string} */ (set.values().next().value);
    set.delete(oldest);
  }
}

/**
 * Clear the in-memory written-hash record. Test-only — the store is otherwise
 * process-lifetime and never needs clearing.
 * @returns {void}
 */
export function __resetWrittenHashesForTest() {
  writtenHashes = new WeakMap();
}

/**
 * In-memory record of the reads a running program (run_code) has made through
 * its sandbox `fs` or its read tools (creditProgramRead), by conversation and
 * then by the program's own tool-use id. Each entry is the sandbox
 * filesystem's live `filesRead` map (path → contentHash), so a read counts the
 * moment it is made, not when the program completes and its result reaches
 * the transcript.
 *
 * Only that program's own sub-calls may use it: they run under
 * `code_<program>_<n>`, and a file the program read is not a file the model has
 * seen. Once the program ends the entry is dropped, and its stored result's
 * `filesRead` credits the conversation as query_code's does.
 * @type {WeakMap<object, Map<string, Map<string, string|null>>>}
 */
const programReads = new WeakMap();

/**
 * Register a running program's live read record. Returns the function that
 * ends it, to be called however the program finishes.
 * @param {object|undefined} conversation - Conversation the program runs in
 * @param {string} programId - The program's tool-use id
 * @param {Map<string, string|null>} liveReads - The sandbox fs's filesRead map
 * @returns {() => void} Ends the record
 */
export function beginProgramReads(conversation, programId, liveReads) {
  if (!conversation || !programId) return () => {};
  let programs = programReads.get(conversation);
  if (!programs) {
    programs = new Map();
    programReads.set(conversation, programs);
  }
  programs.set(programId, liveReads);
  return () => {
    if (programs.get(programId) === liveReads) programs.delete(programId);
  };
}

/**
 * The live read record of the running program a sub-call belongs to.
 * @param {object|undefined} conversation - Conversation the call runs in
 * @param {string|undefined} toolUseId - The id it runs under (`code_<program>_<n>`)
 * @returns {Map<string, string|null>|undefined} The program's reads, if it is a program's call
 */
function programReadsFor(conversation, toolUseId) {
  if (!conversation || !toolUseId?.startsWith('code_')) return undefined;
  const programs = programReads.get(conversation);
  if (!programs) return undefined;
  for (const [programId, reads] of programs) {
    if (toolUseId.startsWith(`code_${programId}_`)) return reads;
  }
  return undefined;
}

/**
 * Credit a read a program made through a tool (`tools.read`,
 * `tools.batch_read`) to that program, as its `fs` reads are: the bytes came
 * back to the program in the call's result. Nothing for a call that is not a
 * running program's.
 * @param {object|undefined} conversation - Conversation the call runs in
 * @param {string|undefined} toolUseId - The id the read ran under
 * @param {string|undefined} path - The file read
 * @param {unknown} contentHash - The hash of what it read, when the read has one
 * @returns {void}
 */
export function creditProgramRead(conversation, toolUseId, path, contentHash) {
  const reads = programReadsFor(conversation, toolUseId);
  if (!reads || !path) return;
  reads.set(path, typeof contentHash === 'string' && contentHash ? contentHash : null);
}

/**
 * Fold the live reads of the program a sub-call belongs to into `state`.
 * @param {SeenState} state - Aggregate to update
 * @param {object|undefined} conversation - Conversation instance
 * @param {object|undefined} session - Session (for path resolution)
 * @param {string} target - Canonical key of the path being checked
 * @param {string|undefined} toolUseId - The id the mutation runs under
 * @returns {void}
 */
function collectProgramReads(state, conversation, session, target, toolUseId) {
  const reads = programReadsFor(conversation, toolUseId);
  if (!reads) return;
  for (const [file, hash] of reads) {
    if (pathMatchKey(session, file) !== target) continue;
    state.seen = true;
    if (typeof hash === 'string' && hash) state.hashes.add(hash);
    else state.unverified = true;
  }
}

/**
 * The newest content hash this process recorded for `path`, or undefined if it
 * has written none. The written-hash Set preserves insertion order, so the last
 * entry is the most recent write.
 * @param {object|undefined} conversation - Conversation whose writes to inspect
 * @param {object|undefined} session - Session (for path resolution)
 * @param {string|undefined} path - File path to look up
 * @returns {string|undefined} The most recently recorded hash, or undefined
 */
export function latestWrittenHash(conversation, session, path) {
  const target = pathMatchKey(session, path);
  const set = conversation && target ? writtenHashes.get(conversation)?.get(target) : undefined;
  if (!set || set.size === 0) return undefined;
  let last;
  for (const h of set) last = h;
  return last;
}

/**
 * Choose the staleness baseline (expectedHash) for a mutation that was queued
 * behind a sibling mutation to the same path this turn. `frozenHash` is the
 * baseline captured when this mutation was validated; `currentHash` is the
 * file's freshly-probed on-disk hash just before the real write.
 *
 * Re-base onto `currentHash` only when it is bytes this conversation has seen or
 * written (checkFileFreshness accepts it) — i.e. a sibling's just-applied
 * write, so the backend's expectedHash guard doesn't reject an edit made stale
 * purely by an earlier same-turn sibling. When the current bytes are an unseen
 * out-of-band change, keep `frozenHash` so the backend still refuses.
 * @param {any} conversation - Conversation instance
 * @param {object|undefined} session - Session (for path resolution)
 * @param {string|undefined} path - File path being mutated
 * @param {string} frozenHash - The validation-time baseline
 * @param {string|undefined} currentHash - The file's current on-disk hash
 * @returns {string} The expectedHash to send to the backend
 */
export function restageBaseline(conversation, session, path, frozenHash, currentHash) {
  if (typeof currentHash !== 'string' || !currentHash || currentHash === frozenHash) {
    return frozenHash;
  }
  const fresh = checkFileFreshness(conversation, session, path, currentHash);
  return fresh.ok ? currentHash : frozenHash;
}

/**
 * Per-path serialization of same-file mutations within this process.
 *
 * A single assistant turn can dispatch several edits/writes to one file
 * concurrently. Each freezes its expectedHash baseline at validation time —
 * before any sibling executes — so without serialization the first write lands
 * and every later sibling carries a now-stale baseline the backend rejects.
 * Holding a per-path lock across each mutation's execute forces those siblings
 * to run one at a time; each then re-bases onto the previous sibling's written
 * bytes (see restageBaseline), collapsing a concurrent batch into the
 * already-correct sequential case. Keyed by canonical absolute path, so only
 * mutations to the SAME file serialize — different files never block.
 * @type {Map<string, Promise<void>>}
 */
const pathLocks = new Map();

/**
 * Acquire the per-path mutation lock for `path`. Resolves once any in-flight
 * sibling mutation to the same path has released, and returns a `release`
 * callback the caller MUST invoke (in a finally) when its mutation completes.
 * When the path has no stable canonical key, returns a no-op lock.
 * @param {object|undefined} session - Session (for path resolution)
 * @param {string|undefined} path - File path to serialize on
 * @returns {Promise<{release: () => void}>} The acquired lock handle
 */
export async function acquirePathLock(session, path) {
  const key = pathMatchKey(session, path);
  if (!key) return { release: () => {} };
  const prev = pathLocks.get(key);
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((resolve) => { release = () => resolve(undefined); });
  const mine = (prev || Promise.resolve()).then(() => gate);
  pathLocks.set(key, mine);
  await (prev || Promise.resolve());
  const finish = () => {
    release();
    // Drop the entry when nobody queued behind us, bounding the map. Safe with
    // no interleaving await between release() and this check: a later acquirer
    // synchronously replaces the tail before its first await.
    if (pathLocks.get(key) === mine) pathLocks.delete(key);
  };
  return { release: finish };
}

/**
 * Every tool name a stored sandbox-script action may carry: query_code under
 * each name it has been offered under (a tool-action persists the name that
 * was advertised when it ran), and run_code, whose result records its
 * program's reads the same way.
 * @type {Set<string>}
 */
const QUERY_CODE_TOOLS = new Set(['query_code', 'explore_code', 'run_code']);

/**
 * Tools whose successful completion means the model has seen the file's bytes.
 * `batch_read` is matched via its per-file results (which carry per-file
 * success and hash) rather than its input list, and the sandbox-script tool via
 * the `filesRead` map its result records for every `fs.readFile` its script made.
 * @type {Set<string>}
 */
const SEEN_TOOLS = new Set(['read', 'write', 'edit', 'batch_read', ...QUERY_CODE_TOOLS]);

/**
 * View a Y.Array or plain array as a plain array.
 * @param {any} value - Y.Array, array, or undefined
 * @returns {any[]} Plain array view (empty when not array-like)
 */
function ylist(value) {
  if (!value) return [];
  if (typeof value.toArray === 'function') return value.toArray();
  return Array.isArray(value) ? value : [];
}

/**
 * The ops-layer payload inside a persisted tool-action result. The action
 * pipeline stores the backend's result nested under `fullResult.result`
 * (response-handler wraps it with state/success/displayData); simpler writers
 * store the payload as `fullResult` directly, so fall back to that.
 * @param {any} result - The tool-action's persisted result (Y.Map or object)
 * @returns {any} The ops payload, or undefined
 */
function opsPayload(result) {
  const full = itemField(result, 'fullResult');
  return itemField(full, 'result') ?? full;
}

/**
 * @typedef {object} SeenState
 * @property {boolean} seen - The model has seen this path this session
 * @property {boolean} pinned - A live pin covers the path (always fresh)
 * @property {Set<string>} hashes - Content hashes the model has seen for the path
 * @property {boolean} unverified - Some matching record carries no hash, so staleness can't be proven
 */

/**
 * Collect what the transcript says the model has seen for `path`: whether it
 * was seen at all, via a pin or via tool-actions, and every content hash those
 * records carry.
 * @param {object|undefined} conversation - Conversation instance
 * @param {object|undefined} session - Session (for path resolution)
 * @param {string|undefined} path - File path the mutation targets
 * @returns {SeenState} Aggregated seen-state for the path
 */
function seenState(conversation, session, path) {
  /** @type {SeenState} */
  const state = { seen: false, pinned: false, hashes: new Set(), unverified: false };
  const target = pathMatchKey(session, path);
  if (!conversation || !target) return state;

  const threads = /** @type {any} */ (conversation).getAllMessageThreads?.() || [];
  for (const thread of threads) {
    // 1) User-surfaced context items (pins, at-mentions) carrying a path — in
    //    ANY thread, since subthreads can hold their own pins. A live pin's bytes
    //    are rendered into context at send time, so it always counts as fresh; a
    //    frozen one (a mention, a seeded file) is a snapshot with no recorded
    //    hash, so it proves the file was seen but not what it holds now.
    for (const item of thread.contextItems || []) {
      const data = /** @type {any} */ (item)?.data;
      const p = data?.path;
      if (p && pathMatchKey(session, p) === target) {
        state.seen = true;
        if (data.frozen === true || data.seeded === true) state.unverified = true;
        else state.pinned = true;
      }
    }

    // 2) Prior successful seen-tool actions for this path. Completed + non-error
    //    only, so a not-yet-finished action (including the current mutation's
    //    own pending tool-action) never counts as "seen". The cheap toolInput
    //    path comparison runs before any result field is touched, so
    //    non-matching actions cost almost nothing.
    for (const ymap of thread.items || []) {
      if (typeof ymap.get !== 'function' || ymap.get('type') !== 'tool-action') continue;
      const toolName = ymap.get('toolName');
      if (!SEEN_TOOLS.has(toolName)) continue;
      if (ymap.get('state') !== 'completed') continue;
      const rawInput = ymap.get('toolInput');
      const toolInput = rawInput?.toJSON ? rawInput.toJSON() : rawInput;

      if (toolName === 'batch_read') {
        collectBatchRead(state, session, target, toolInput, ymap);
        continue;
      }
      if (QUERY_CODE_TOOLS.has(toolName)) {
        collectQueryCode(state, session, target, ymap);
        continue;
      }

      const p = toolInputPath(toolInput, true);
      if (!p || pathMatchKey(session, p) !== target) continue;

      const result = ymap.get('result');
      if (!result || itemField(result, 'isError') === true) continue;
      if (itemField(itemField(result, 'fullResult'), 'success') === false) continue;
      const payload = opsPayload(result);
      // A read that found no file proved nothing about its contents.
      if (itemField(payload, 'exists') === false) continue;

      state.seen = true;
      const hash = itemField(payload, 'contentHash');
      if (typeof hash === 'string' && hash) state.hashes.add(hash);
      else state.unverified = true;
    }
  }
  return state;
}

/**
 * Fold a completed batch_read action's per-file results into `state`. Matching
 * prefers the result entries (each records whether THAT file's read succeeded
 * and the hash of what it saw). When the stored result carries no per-file
 * entries — the transcript writer strips large `results` arrays down to a
 * count — an input-listed file on a non-error action counts as
 * seen-but-unverifiable instead, so a big batch still registers as a read.
 * @param {SeenState} state - Aggregate to update
 * @param {object|undefined} session - Session (for path resolution)
 * @param {string} target - Canonical key of the path being checked
 * @param {any} toolInput - The batch_read tool input (files list, used as a cheap pre-filter)
 * @param {any} ymap - The tool-action Y.Map
 * @returns {void}
 */
function collectBatchRead(state, session, target, toolInput, ymap) {
  // Cheap pre-filter on the input list before touching the (larger) result.
  const inputFiles = ylist(toolInput?.files);
  const inInput = inputFiles.some(
    (f) => pathMatchKey(session, /** @type {any} */ (f)?.file_path) === target
  );
  if (inputFiles.length > 0 && !inInput) return;

  const result = ymap.get('result');
  if (!result || itemField(result, 'isError') === true) return;
  const entries = ylist(itemField(opsPayload(result), 'results'));

  if (entries.length === 0) {
    // Per-file entries stripped from storage: trust the input list.
    if (inInput) {
      state.seen = true;
      state.unverified = true;
    }
    return;
  }

  for (const entry of entries) {
    if (itemField(entry, 'success') !== true) continue;
    const file = itemField(entry, 'file');
    if (!file || pathMatchKey(session, String(file)) !== target) continue;
    const fileResult = itemField(entry, 'result');
    if (itemField(fileResult, 'exists') === false) continue;
    state.seen = true;
    const hash = itemField(fileResult, 'contentHash');
    if (typeof hash === 'string' && hash) state.hashes.add(hash);
    else state.unverified = true;
  }
}

/**
 * Entries of a Y.Map or plain object as [key, value] pairs.
 * @param {any} obj - Y.Map, plain object, or undefined
 * @returns {Array<[string, any]>} Entry pairs (empty when not map-like)
 */
function yentries(obj) {
  if (!obj || typeof obj !== 'object') return [];
  if (typeof obj.entries === 'function' && typeof obj.get === 'function') {
    return [...obj.entries()];
  }
  return Object.entries(obj);
}

/**
 * Fold a completed query_code action's recorded reads into `state`. The
 * tool's result carries `filesRead` — path → contentHash for every file the
 * sandbox script's `fs.readFile` pulled — recorded by the query-code item at
 * execute time. The model's own script chose those reads, so they earn full
 * hash credit; grep/glob results are deliberately absent (fragments and names
 * don't show the model the file).
 * @param {SeenState} state - Aggregate to update
 * @param {object|undefined} session - Session (for path resolution)
 * @param {string} target - Canonical key of the path being checked
 * @param {any} ymap - The tool-action Y.Map
 * @returns {void}
 */
function collectQueryCode(state, session, target, ymap) {
  const result = ymap.get('result');
  if (!result || itemField(result, 'isError') === true) return;
  for (const [file, hash] of yentries(itemField(opsPayload(result), 'filesRead'))) {
    if (pathMatchKey(session, file) !== target) continue;
    state.seen = true;
    if (typeof hash === 'string' && hash) state.hashes.add(hash);
    else state.unverified = true;
  }
}

/**
 * Gate a file mutation on transcript-derived freshness. Refuses when the model
 * has never seen the file this session, or when `currentHash` (the file's
 * current on-disk SHA-256, as reported by the backend) matches none of the
 * hashes the model has seen — i.e. the file changed out-of-band since it was
 * last read. Pinned files and hash-less legacy records are treated as fresh.
 * @param {object|undefined} conversation - Conversation instance
 * @param {object|undefined} session - Session (for path resolution)
 * @param {string|undefined} path - File path the mutation targets
 * @param {string|undefined} [currentHash] - Current on-disk content hash, when known
 * @param {string} [toolUseId] - The id the mutation runs under; a run_code
 *   sub-call's id lets it use its program's live reads
 * @returns {{ok: true}|{ok: false, error: string}} Freshness verdict
 */
export function checkFileFreshness(conversation, session, path, currentHash, toolUseId) {
  const state = seenState(conversation, session, path);
  // A hash this conversation wrote earlier this turn proves the file was seen
  // even if that write's tool-action has not surfaced in the durable transcript.
  const target = pathMatchKey(session, path);
  if (target) collectProgramReads(state, conversation, session, target, toolUseId);
  const written = conversation && target ? writtenHashes.get(conversation)?.get(target) : undefined;
  if (!state.seen && !(written && written.size > 0)) {
    return {
      ok: false,
      error: markUntranslated(`Refusing to edit '${path}': it has not been read this session. Read the file first, then retry using its exact current text.`)
    };
  }
  if (state.pinned || state.unverified || !currentHash) return { ok: true };
  if (state.hashes.has(currentHash)) return { ok: true };
  // In-flight sibling edit: the current on-disk bytes match a hash we wrote
  // earlier this turn, whose completing tool-action the transcript may not
  // reflect yet. Trust it — those bytes are our own just-applied write, not an
  // unseen out-of-band change.
  if (written && written.has(currentHash)) return { ok: true };
  return {
    ok: false,
    error: markUntranslated(`Refusing to edit '${path}': the file has changed on disk since it was last read. Re-read the file, then retry against its current content.`)
  };
}

/**
 * Tools whose input names the files they will read, so a call still in flight
 * can be matched to a path before it has a result.
 * @type {Set<string>}
 */
const PENDING_READ_TOOLS = new Set(['read', 'batch_read']);

/**
 * Whether a read of `path` emitted earlier in the same turn as the mutation
 * `toolUseId` has yet to finish.
 *
 * Every call of a turn is evaluated before any of them runs, so an edit issued
 * in one batch after a read of its file is validated while that read has no
 * result — and the transcript, which only credits finished reads, says the file
 * was never seen. The worker runs the edit (a "write" call) only once every
 * earlier call of its turn has settled (tool_ordering.go), so by execute the read
 * has either landed or failed: the guard can be applied there instead. A turn is
 * the calls sharing a `transactionId` in one thread, the worker's own grouping.
 * A read that finished is not counted here; checkFileFreshness already has it,
 * or it failed and proves nothing.
 * @param {object|undefined} conversation - Conversation instance
 * @param {object|undefined} session - Session (for path resolution)
 * @param {string|undefined} path - File path the mutation targets
 * @param {string|undefined} toolUseId - The mutation's own tool-use id
 * @returns {boolean} True when such a read is still unfinished
 */
export function awaitsReadInTurn(conversation, session, path, toolUseId) {
  const target = pathMatchKey(session, path);
  if (!conversation || !target || !toolUseId) return false;
  const threads = /** @type {any} */ (conversation).getAllMessageThreads?.() || [];
  for (const thread of threads) {
    const items = [...(thread.items || [])];
    const own = items.findIndex((m) => typeof m?.get === 'function' &&
      m.get('type') === 'tool-action' && m.get('toolUseId') === toolUseId);
    if (own < 0) continue;
    const turn = items[own].get('transactionId');
    if (!turn) return false;
    for (const ymap of items.slice(0, own)) {
      if (typeof ymap?.get !== 'function' || ymap.get('type') !== 'tool-action') continue;
      if (ymap.get('transactionId') !== turn) continue;
      const toolName = ymap.get('toolName');
      if (!PENDING_READ_TOOLS.has(toolName)) continue;
      const state = ymap.get('state');
      if (state === 'completed' || state === 'cancelled') continue;
      const rawInput = ymap.get('toolInput');
      const toolInput = rawInput?.toJSON ? rawInput.toJSON() : rawInput;
      const paths = toolName === 'batch_read'
        ? ylist(toolInput?.files).map((f) => /** @type {any} */ (f)?.file_path)
        : [toolInputPath(toolInput, true)];
      if (paths.some((p) => p && pathMatchKey(session, p) === target)) return true;
    }
    return false;
  }
  return false;
}
