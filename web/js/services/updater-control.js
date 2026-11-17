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
 * The result of a restart request.
 * @typedef {object} RestartResult
 * @property {'ok'|'busy'|'error'|'absent'} status - The restart outcome.
 * @property {number} [busy] - In-flight turn count (status === 'busy').
 * @property {string} [message] - Human-readable reason (busy/error).
 */

/**
 * Relaunch into the staged update. On the first attempt the app returns 409 if
 * any conversation is still running a turn; the caller confirms and re-calls
 * with force=true. Success quits the app (no meaningful response), so an ok
 * result just means the restart was accepted.
 * @param {{force?: boolean}} [opts] - force=true skips the busy check.
 * @returns {Promise<RestartResult>} The restart outcome.
 */
export async function requestRestart({ force = false } = {}) {
  const url = windowControlURL('updater', force ? '?op=restart&force=1' : '?op=restart');
  if (!url) return { status: 'absent' };
  try {
    await fetchJson(url, { method: 'POST' });
    return { status: 'ok' };
  } catch (err) {
    if (!(err instanceof HttpError)) {
      return { status: 'error', message: extractErrorMessage(err) };
    }
    const body = err.body && typeof err.body === 'object' ? err.body : {};
    if (err.status === 409) {
      // messageText is the prompt as a message, for the viewer's language;
      // message is its English.
      return { status: 'busy', busy: body.busy, message: serverText(bodyServerMessage({ message: body.messageText }), body.message) };
    }
    return { status: 'error', message: serverText(bodyServerMessage(body), body.error) || t('Restart failed (HTTP {status})', { status: err.status }) };
  }
}
