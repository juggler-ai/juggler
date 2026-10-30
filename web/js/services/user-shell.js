//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Shell commands the user runs from the composer — `! cmd`, or `/shell cmd`.
 *
 * The run costs no model call. The command goes to the same streaming shell the
 * bash tool uses (same shell, same project environment, confined to the
 * conversation's workspace, same refusals), with no approval prompt: the user
 * typed it. When it ends — finished, stopped or refused — its output becomes a
 * `shell-output` context item in the thread it was typed into, and so reaches
 * the model in place, just before the user's next message.
 *
 * Where the item is written is the thread's call, as for an `@`-mention's read
 * ({@link MessageThread#addSendContext}): straight into the transcript when the
 * thread is idle, and onto the pending queue when a turn is in flight, so it
 * lands at the next turn boundary rather than above the turn that was running
 * when it finished. A context item queued with no message asks for no turn.
 *
 * While a command runs, its record is held here so the composer can show it and
 * offer Stop. Held only in this viewer: the shell is started over this viewer's
 * socket and dies with it, so no other viewer could stop it.
 * @module services/user-shell
 */

import { createBoundOps, MAX_EXEC_TIMEOUT_MS } from '../../sdk/ops.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';

/** The context item type a finished run is recorded as. */
export const SHELL_OUTPUT_ITEM_TYPE = 'shell-output';

/**
 * A command the user is running.
 * @typedef {object} UserShellRun
 * @property {string} id - Unique id of this run
 * @property {string} command - The command line as typed
 * @property {number} startedAt - Epoch ms the run started
 * @property {() => void} stop - Stop the command; its output so far is still recorded
 */

/** @type {Map<string, Set<UserShellRun>>} Running commands, keyed by thread. */
const running = new Map();

/** @type {Set<() => void>} */
const listeners = new Set();

let nextId = 0;

/**
 * The key a thread's runs are held under.
 * @param {import('../model/message-thread.js').MessageThread} mt
 * @returns {string} Conversation id and thread id
 */
function threadKey(mt) {
  return `${mt.conversation?.id ?? ''}\u0000${mt.threadItemId ?? ''}`;
}

/** Tell every listener the set of running commands changed. */
function notify() {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (err) {
      console.error('[user-shell] listener threw:', err);
    }
  }
}

/**
 * The command a `! cmd` message asks to run, or null when the message is not
 * one. A `!` with nothing after it is an ordinary message.
 * @param {string} text - The message as typed
 * @returns {string|null} The command line, trimmed, or null
 */
export function shellShortcutCommand(text) {
  const match = /^!\s*(\S[\s\S]*)$/.exec(String(text).trim());
  return match?.[1] ? match[1].trim() : null;
}

/**
 * The commands running in a thread, oldest first.
 * @param {import('../model/message-thread.js').MessageThread|null|undefined} mt
 * @returns {UserShellRun[]} The running commands (empty when none)
 */
export function runningUserShells(mt) {
  if (!mt) return [];
  return [...(running.get(threadKey(mt)) ?? [])];
}

/**
 * Be told whenever a command starts or ends, in any thread.
 * @param {() => void} fn - Called after each change
 * @returns {() => void} Unsubscribe
 */
export function onUserShellsChange(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * The fields of a `shell-output` item, from how the run ended.
 * @param {string} command - The command line as typed
 * @param {Record<string, any>} result - The shell's result, or `{error}` when it could not be started
 * @returns {Record<string, unknown>} The item's params
 */
function shellOutputParams(command, result) {
  const cancelled = Boolean(result.cancelled);
  return {
    command,
    output: typeof result.stdout === 'string' ? result.stdout : '',
    exitCode: cancelled || !Number.isInteger(result.exitCode) ? null : result.exitCode,
    error: cancelled ? '' : (typeof result.error === 'string' ? result.error : ''),
    cancelled,
    outputFile: typeof result.outputFile === 'string' ? result.outputFile : '',
    truncated: Boolean(result.truncated)
  };
}

/**
 * Run a command the user typed into a thread's composer, and record its output
 * in that thread when it ends.
 * @param {import('../model/message-thread.js').MessageThread} mt - The thread it was typed into
 * @param {string} command - The command line as typed
 * @param {object} [deps] - Seams for tests
 * @param {import('../../sdk/ops.js').BoundOps['shellStreaming']} [deps.shellStreaming] - The streaming shell
 * @param {import('../../sdk/ops.js').BoundOps['shell']} [deps.shell] - The blocking shell, used when the socket is down
 * @returns {Promise<void>} Resolves once the output is recorded
 */
export async function runUserShell(mt, command, deps = {}) {
  const conv = mt.conversation;
  const ops = createBoundOps(() => ({ workspaceId: conv?.workingWorkspaceId ?? conv?.workspaceId ?? '' }));
  const shellStreaming = deps.shellStreaming ?? ops.shellStreaming;
  const shell = deps.shell ?? ops.shell;

  const controller = new AbortController();
  /** @type {UserShellRun} */
  const run = {
    id: `user-shell-${++nextId}`,
    command,
    startedAt: Date.now(),
    stop: () => controller.abort()
  };
  const key = threadKey(mt);
  const runs = running.get(key) ?? new Set();
  runs.add(run);
  running.set(key, runs);
  notify();

  // The full timeout the shell allows: a test run or an audit takes minutes,
  // and the user has Stop for anything that should end sooner.
  const params = {
    command,
    timeout: MAX_EXEC_TIMEOUT_MS,
    convId: conv?.id ?? '',
    threadId: mt.threadItemId || ''
  };

  /** @type {Record<string, any>} */
  let result;
  try {
    result = await shellStreaming(params, () => {}, controller.signal);
  } catch (err) {
    if (err instanceof Error && err.message.includes('WebSocket')) {
      try {
        result = await shell(params, controller.signal);
        if (controller.signal.aborted) result = { ...result, cancelled: true };
      } catch (blockingErr) {
        result = controller.signal.aborted ? { cancelled: true } : { error: extractErrorMessage(blockingErr) };
      }
    } else {
      result = { error: extractErrorMessage(err) };
    }
  } finally {
    runs.delete(run);
    if (runs.size === 0) running.delete(key);
    notify();
  }

  const itemParams = shellOutputParams(command, result);
  if (mt.sendWillQueue) {
    await mt.executeContextItemIntoPending(SHELL_OUTPUT_ITEM_TYPE, itemParams);
  } else {
    await mt.executeContextItem(SHELL_OUTPUT_ITEM_TYPE, itemParams);
  }
}
