//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The machine server's events stream — every session it runs, with what waits
 * in each, and its recent projects — as its readers take it: the sessions page
 * straight from the machine server (web/machine/control-api.js), and a
 * project's page through its own session, which relays it
 * (GET /api/machine/events; services/machine-feed.js).
 *
 * The stream is server-sent events, read with fetch rather than an
 * EventSource, which could carry a credential only in the address. Each
 * `sessions` event is a {@link Snapshot}; comments keep it alive. A stream
 * the server ends to relaunch ends with a `relaunching` event, so its reader
 * knows the server is coming back rather than gone.
 * @module services/sessions-feed
 */

/**
 * A session as the machine server lists it (machineserver.Session).
 * @typedef {object} Session
 * @property {string} id - Its handle in the control API (stop, attach). It is
 *   minted at every open, so it is no address.
 * @property {string} project - The project folder it runs.
 * @property {string} [projectKey] - Its project's storage key, the name its
 *   page knows it by (window.__projectKey): what its colour is kept under
 *   (utils/project-colour.js).
 * @property {string} link - Where it is served: its project's link, /p/<key>/,
 *   which outlives it and serves the project's next session.
 * @property {'starting'|'running'|'stopping'|'restarting'|'error'} state - Where its child is in its life.
 * @property {string} [error] - Why it failed, or how its child last ended.
 * @property {{key?: unknown, params?: unknown}} [message] - The error as the
 *   UI shows it translated (serverText), where the server has the words for it.
 * @property {boolean} [relaunchNeeded] - It failed because another build is
 *   installed in the server's place, which only relaunching the server takes up.
 * @property {string} startedAt - When it was opened.
 * @property {boolean} busy - A turn is running in it.
 * @property {string} [lastActive] - When it was last seen running a turn, or a
 *   conversation in it last started or stopped working or waiting.
 * @property {number} [restarts] - How often a crashed child has been respawned.
 * @property {string} [nextRestartAt] - When a restarting session next tries.
 * @property {SessionAttention} [attention] - What its child last reported of
 *   its conversations; absent until it first has.
 * @property {number} [conversations] - How many conversations its project
 *   has; absent until its child has been asked.
 * @property {string} [lastViewed] - When a viewer last arrived at it: the
 *   order of use, most recent first; absent until one has.
 * @property {number} [viewers] - How many viewers hold it now: windows, tabs
 *   and terminals.
 */

/**
 * A conversation that is not idle, as a session's child reports it
 * (internal/attention.Conversation).
 * @typedef {object} AttentionItem
 * @property {string} id - The conversation's id.
 * @property {string} [name] - Its name.
 * @property {'waiting'|'working'|'failed'} state - What it is doing.
 * @property {'approval'|'question'} [wait] - What a waiting one waits for.
 * @property {string} [since] - When it entered that state.
 * @property {string} [excerpt] - The question, the tool call, or the error.
 */

/**
 * A session's attention (machineserver.SessionAttention).
 * @typedef {object} SessionAttention
 * @property {number} waiting - Conversations waiting on the user.
 * @property {number} working - Conversations with a turn working.
 * @property {number} failed - Conversations whose last turn failed.
 * @property {AttentionItem[]} items - The waiting and failed ones, oldest first.
 * @property {string} [workingOn] - The oldest working one's name; absent when
 *   none works.
 */

/**
 * The machine's recent projects, as the machine server serves them.
 * @typedef {object} Recents
 * @property {string[]} paths - The folders, most recent first.
 * @property {Record<string, string>} links - Each folder's project link,
 *   /p/<key>/ (absent for a folder the server named none for).
 * @property {Record<string, string>} [keys] - Each folder's project storage
 *   key, as Session.projectKey has it (absent from an older server).
 * @property {Record<string, number>} [waiting] - How many of a folder's
 *   conversations were waiting on the user when its session last ended
 *   (absent for a folder with none).
 * @property {Record<string, string>} [used] - When each folder was last opened
 *   or left (absent for a folder with no time recorded).
 */

/**
 * What the events stream sends whenever it changes: the sessions and the
 * recents, as GET /sessions and GET /recents answer them, and what a relaunch
 * of the server would take up.
 * @typedef {object} Snapshot
 * @property {Session[]} sessions - Every session, oldest first.
 * @property {Recents} recents - The recent projects.
 * @property {string} [installedBuild] - The build installed in the server's
 *   place, which it opens no session from until it is relaunched; '' or absent
 *   while it is the server's own.
 */

/** What reading a stream to its end answers when the server ended it to relaunch. */
const RELAUNCHING = 'relaunching';

/**
 * The wait before a feed is opened again after it failed or ended, doubling
 * with each failure from the first to the second.
 */
const FEED_RETRY_MIN = 1000;
const FEED_RETRY_MAX = 30_000;

/**
 * A recents answer with every field filled in.
 * @param {unknown} raw - As the server sent it.
 * @returns {Recents} The recents.
 */
export function asRecents(raw) {
  const body = /** @type {Partial<Recents>|null} */ (raw) || {};
  return {
    paths: body.paths || [], links: body.links || {}, keys: body.keys || {}, waiting: body.waiting || {}, used: body.used || {},
  };
}

/**
 * What a server-sent event says: a snapshot, if it is a sessions event, or
 * that the server is relaunching.
 * @param {string} block - One event's lines, without the blank line ending it.
 * @returns {Snapshot|typeof RELAUNCHING|null} Its snapshot, or RELAUNCHING;
 *   null for a comment, another event, or data that is not one.
 */
function streamEvent(block) {
  let name = '';
  /** @type {string[]} */
  const data = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (name === RELAUNCHING) return RELAUNCHING;
  if (name !== 'sessions' || !data.length) return null;
  try {
    const body = JSON.parse(data.join('\n'));
    return {
      sessions: Array.isArray(body?.sessions) ? body.sessions : [],
      recents: asRecents(body?.recents),
      installedBuild: typeof body?.installedBuild === 'string' ? body.installedBuild : '',
    };
  } catch {
    return null;
  }
}

/**
 * Read an events stream to its end, handing onSnapshot each snapshot it
 * sends, however the network cuts it into chunks. A read that breaks rejects
 * as the reader does.
 * @param {ReadableStream<Uint8Array>} body - The response's body.
 * @param {(snapshot: Snapshot) => void} onSnapshot - Takes each snapshot.
 * @returns {Promise<typeof RELAUNCHING|undefined>} Resolves when the stream
 *   ends: RELAUNCHING when the server ended it to relaunch.
 */
export async function readSessionsStream(body, onSnapshot) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  /** @type {typeof RELAUNCHING|undefined} */
  let ended;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return ended;
    // The server ends its lines with \n alone (machineserver/events.go).
    buffered += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffered.indexOf('\n\n')) >= 0) {
      const event = streamEvent(buffered.slice(0, end));
      buffered = buffered.slice(end + 2);
      if (event === RELAUNCHING) ended = RELAUNCHING;
      else if (event) onSnapshot(event);
    }
  }
}

/**
 * Follow a feed until signal aborts: open it, hand onSnapshot each snapshot,
 * and when it fails or ends say so (onDown) and open it again after a wait —
 * FEED_RETRY_MIN, doubling to FEED_RETRY_MAX, back to the least once a
 * snapshot arrives. A stream the server ended to relaunch says that instead
 * (onRelaunching), and is opened again after the least wait, as the server
 * is coming back.
 * @param {object} options
 * @param {(onSnapshot: (snapshot: Snapshot) => void, signal: AbortSignal) => Promise<typeof RELAUNCHING|void>} options.open -
 *   Follows the stream once, until it ends (resolves, with RELAUNCHING for a
 *   relaunch) or breaks (rejects).
 * @param {(snapshot: Snapshot) => void} options.onSnapshot - Takes each snapshot.
 * @param {() => void} [options.onDown] - Told each time the stream has gone.
 * @param {() => void} [options.onRelaunching] - Told when the server ended the
 *   stream to relaunch; onDown by default.
 * @param {AbortSignal} options.signal - Stops following.
 * @param {(ms: number) => Promise<void>} [options.sleep] - Waits ms.
 * @returns {Promise<void>} Resolves once signal has aborted.
 */
export async function followSessionsFeed({
  open,
  onSnapshot,
  onDown = () => {},
  onRelaunching = onDown,
  signal,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
}) {
  let wait = FEED_RETRY_MIN;
  while (!signal.aborted) {
    let ended;
    try {
      ended = await open((snapshot) => {
        wait = FEED_RETRY_MIN;
        onSnapshot(snapshot);
      }, signal);
    } catch {
      // Opened again below.
    }
    if (ended === RELAUNCHING) {
      onRelaunching();
      wait = FEED_RETRY_MIN;
    } else {
      onDown();
    }
    if (signal.aborted) return;
    await sleep(wait);
    wait = Math.min(wait * 2, FEED_RETRY_MAX);
  }
}
