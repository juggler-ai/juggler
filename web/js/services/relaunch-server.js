//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Relaunching the machine server into the build installed in its place, as a
 * page offers it: the sessions page straight from the machine server
 * (web/machine/control-api.js relaunch), a project's page through its own
 * session (services/api.js relaunchMachine).
 *
 * A relaunch stops every session, so it is asked for quietly first — the
 * server relaunches only if no conversation runs a turn and no background task
 * runs — and only a server with work running asks the user, saying what would
 * stop, before it is relaunched whatever runs.
 * @module services/relaunch-server
 */

import { t } from '../../sdk/lib/i18n.js';

/**
 * The work a relaunch would stop, as the server counts it (machineserver.BusyWork).
 * @typedef {{conversations: number, tasks: number}} Running
 */

/**
 * The work a refused quiet relaunch says runs, if err is that refusal.
 * @param {unknown} err - What the relaunch threw.
 * @returns {Running|null} The work that runs; null for any other failure.
 */
export function runningOf(err) {
  const body = err && typeof err === 'object' ? /** @type {{body?: unknown}} */ (err).body : null;
  const running = body && typeof body === 'object' ? /** @type {{running?: unknown}} */ (body).running : null;
  if (!running || typeof running !== 'object') return null;
  const r = /** @type {{conversations?: unknown, tasks?: unknown}} */ (running);
  return { conversations: Number(r.conversations) || 0, tasks: Number(r.tasks) || 0 };
}

/**
 * What a relaunch would stop, said to the user before it is relaunched anyway.
 * @param {Running} running - The work that runs.
 * @returns {string} The warning.
 */
export function relaunchStopsText({ conversations, tasks }) {
  if (conversations && tasks) {
    return t('{conversations, plural, one {A conversation is still working} other {# conversations are still working}} and {tasks, plural, one {a background task is running} other {# background tasks are running}}. Relaunching will stop them all.', { conversations, tasks });
  }
  if (tasks) {
    return t('{n, plural, one {A background task is still running. Relaunching will stop it.} other {# background tasks are still running. Relaunching will stop them.}}', { n: tasks });
  }
  return t('{n, plural, one {A conversation is still working. Relaunching will stop and discard it.} other {# conversations are still working. Relaunching will stop and discard them.}}', { n: Math.max(conversations, 1) });
}

/**
 * Relaunch the machine server: quietly if no work runs in it, and otherwise
 * once the user has agreed to what it stops.
 * @param {object} options
 * @param {(options?: {quiet?: boolean}) => Promise<void>} options.relaunch -
 *   Asks the server; with quiet it refuses a server with work running, its
 *   error's body saying what runs.
 * @param {(warning: string) => Promise<boolean>} options.confirm - Asks the
 *   user, with what would stop; true relaunches anyway.
 * @returns {Promise<boolean>} Whether the server is relaunching; false when
 *   the user kept it.
 * @throws {unknown} What the relaunch threw, for any other refusal.
 */
export async function relaunchMachineServer({ relaunch, confirm }) {
  try {
    await relaunch({ quiet: true });
    return true;
  } catch (err) {
    const running = runningOf(err);
    if (!running) throw err;
    if (!(await confirm(relaunchStopsText(running)))) return false;
  }
  await relaunch();
  return true;
}
