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
 * stop, before it is relaunched whatever runs. The words are the server's
 * (machineserver.BusyWork.Prompt), the same the desktop app asks a quit or a
 * relaunch in, naming each task and its project. This stays a page's question,
 * not the app's native one, because a browser tab asks it too.
 * @module services/relaunch-server
 */

import { serverText } from '../../sdk/lib/i18n.js';
import { bodyServerMessage } from './http.js';

/**
 * What a refused quiet relaunch says would stop, if err is that refusal: the
 * server's prompt, or — from a server too old to send one — its refusal.
 * @param {unknown} err - What the relaunch threw.
 * @returns {string|null} The warning; null for any other failure.
 */
function warningOf(err) {
  const body = err && typeof err === 'object' ? /** @type {{body?: unknown}} */ (err).body : null;
  if (!body || typeof body !== 'object') return null;
  const b = /** @type {{running?: unknown, prompt?: unknown, error?: unknown}} */ (body);
  if (!b.running || typeof b.running !== 'object') return null;
  return serverText(bodyServerMessage({ message: b.prompt }), '').trim()
    || serverText(bodyServerMessage(b), typeof b.error === 'string' ? b.error : '');
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
    const warning = warningOf(err);
    if (warning === null) throw err;
    if (!(await confirm(warning))) return false;
  }
  await relaunch();
  return true;
}
