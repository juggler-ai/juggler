//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Client for the in-app updater, reached over the native window-control
 * endpoint (`/win/<id>/updater?op=…`). The updater itself lives in the desktop
 * *app* process (a private build overlay), not the server that served this page,
 * so — like minimise/close/pick-directory — the only way to it is the loopback
 * control endpoint baked into the window URL as `nativeCtl`.
 *
 * Every call is null-safe: in a plain browser tab (or any page opened without a
 * native host) `windowControlURL` returns null and these resolve to the
 * "no updater" answer, so the update UI degrades to the server-side version
 * notice alone. All ops are POST, matching every other control call.
 */

/**
 * @typedef {object} UpdaterState
 * @property {boolean} present - Whether this build has an in-app updater at all.
 * @property {string} [state] - updater state: idle | checking | up-to-date |
 *   available | downloading | verifying | installing | ready | error.
 * @property {string} [version] - Target release version.
 * @property {string} [appVersion] - This app bundle's version (skew detection).
 * @property {number} [written] - Bytes downloaded so far.
 * @property {number} [total] - Total bytes to download (<=0 ⇒ indeterminate).
 * @property {string} [error] - Last error message, when state === 'error'.
 * @property {import('./http.js').ServerMessage} [errorMessage] - `error` as a
 *   message, for serverText(), when the failure has one.
 * @property {string} [errorStage] - Which phase produced `error`: check |
 *   download | verify | install.
 * @property {boolean} [appManagedServer] - Whether this window's server was
 *   spawned by the app (and so is replaced by the bundle swap).
 * @property {string} [downloadURL] - Where this release can be downloaded by
 *   hand, for when updating in place has failed.
 * @property {boolean} [openDialog] - The page should open the update dialog on
 *   this snapshot: the app's last update never finished installing.
 * @property {boolean} [cancelling] - A cancelled update is finishing a step that
 *   can't be interrupted; what it staged is then discarded.
 * @property {RelaunchOffer} [relaunch] - A relaunch on offer: the binaries the
 *   app launched from are another build now. Absent when there is none.
 */

/**
 * @typedef {object} RelaunchOffer
 * @property {boolean} app - The app's own binary is another build now.
 * @property {boolean} server - The server binary it starts is another build now.
 * @property {string} [version] - The version the app's new binary carries.
 */

import { windowControlURL } from '../../sdk/lib/window-control.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { fetchJson, HttpError, bodyServerMessage } from './http.js';
import { t, serverText } from '../../sdk/lib/i18n.js';

/** The "no in-app updater" answer used whenever there is no native host. */
const ABSENT = /** @type {UpdaterState} */ ({ present: false });

/**
 * Read the current updater snapshot for this window. Never rejects — returns the
 * absent state on any error or when there is no native host.
 * @returns {Promise<UpdaterState>} The current snapshot, or the absent state.
 */
export async function getUpdaterState() {
  const url = windowControlURL('updater', '?op=state');
  if (!url) return ABSENT;
  const data = await fetchJson(url, { method: 'POST', fallback: null });
  return data && typeof data === 'object' ? data : ABSENT;
}

/**
 * Kick (or retry) the background download+stage flow. No-op without a native
 * host. The result arrives via the pushed `juggler:updater-status` snapshot, not
 * a return value.
 *
 * Pass `auto: true` for a kick the page decided to make on its own rather than
 * one the user clicked for: the app then keeps any failure to the log instead of
 * surfacing it, so an update server that is down doesn't raise an error nobody
 * asked to see. Clicks leave it false and get the error reported.
 * @param {{auto?: boolean}} [opts] - auto=true marks a self-initiated kick.
 * @returns {Promise<void>}
 */
export async function startInstall({ auto = false } = {}) {
  const url = windowControlURL('updater', auto ? '?op=install&auto=1' : '?op=install');
  if (!url) return;
  // Transient failures are ignored — the next pushed snapshot reflects reality.
  await fetchJson(url, { method: 'POST', fallback: null });
}

/**
 * Run a check-only probe: ask the in-app updater whether a newer release exists
 * without starting a download. No-op without a native host. The result arrives
 * via the pushed `juggler:updater-status` snapshot, not a return value — so this
 * reveals availability (button/dialog update) but never triggers an install.
 * @returns {Promise<void>}
 */
export async function startCheck() {
  const url = windowControlURL('updater', '?op=check');
  if (!url) return;
  // Transient failures are ignored — the next pushed snapshot reflects reality.
  await fetchJson(url, { method: 'POST', fallback: null });
}

/**
 * Stop the update that is downloading, or discard the one downloaded and
 * waiting for a restart; the release is then offered again. Resolves once the
 * app has carried it out, so a snapshot read afterwards is the outcome. A
 * refusal — the restart into the update has already begun, and the app is
 * about to quit — leaves the state as it was, which the next snapshot shows.
 * No-op without a native host.
 * @returns {Promise<void>}
 */
export async function cancelUpdate() {
  const url = windowControlURL('updater', '?op=cancel');
  if (!url) return;
  await fetchJson(url, { method: 'POST', fallback: null });
}

/**
 * The result of a restart request.
 * @typedef {object} RestartResult
 * @property {'ok'|'kept'|'error'|'absent'} status - The restart outcome:
 *   `kept` when the user, asked, kept working.
 * @property {string} [message] - Human-readable reason (error).
 */

/**
 * Relaunch into the staged update. When that would stop work — a conversation
 * running a turn, a background task — the app asks the user first, natively,
 * as Cmd+Q does, and answers only once they have. Success quits the app (no
 * meaningful response), so an ok result just means the restart was accepted.
 * @returns {Promise<RestartResult>} The restart outcome.
 */
export async function requestRestart() {
  const url = windowControlURL('updater', '?op=restart');
  return postQuit(url, (status) => t('Restart failed (HTTP {status})', { status }));
}

/**
 * Relaunch the app from the binary installed now, which the app offers (the
 * `relaunch` field of {@link getUpdaterState}) once it is another build than
 * the one running. Asks and answers as {@link requestRestart} does.
 * @returns {Promise<RestartResult>} The relaunch outcome.
 */
export async function requestRelaunch() {
  const url = windowControlURL('relaunch', '');
  return postQuit(url, (status) => t('Relaunch failed (HTTP {status})', { status }));
}

/**
 * POST a request that quits the app into whatever launches next, and read the
 * app's answer: accepted, kept (409: the user, asked, kept working), or failed.
 * @param {string|null} url - The control URL, null without a native host.
 * @param {(status: number) => string} failed - The failure text for an HTTP
 *   status that came with no reason.
 * @returns {Promise<RestartResult>} The outcome.
 */
async function postQuit(url, failed) {
  if (!url) return { status: 'absent' };
  try {
    await fetchJson(url, { method: 'POST' });
    return { status: 'ok' };
  } catch (err) {
    if (!(err instanceof HttpError)) {
      return { status: 'error', message: extractErrorMessage(err) };
    }
    const body = err.body && typeof err.body === 'object' ? err.body : {};
    if (err.status === 409) return { status: 'kept' };
    return { status: 'error', message: serverText(bodyServerMessage(body), body.error) || failed(err.status) };
  }
}
