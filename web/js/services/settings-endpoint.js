//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Where this page reads and saves the global settings document (settings.json)
 * and asks which UI languages there are.
 *
 * A session's page asks its own server: `/api/settings` and `/api/i18n/locales`
 * (utils/api-url.js). The machine server's sessions page has no session, and
 * asks the machine server instead (`/api/server/settings`, which saves only the
 * sections that are this computer's, and `/api/server/i18n/locales`), with the
 * control API's credential. That page says so once, at start
 * ({@link useMachineSettings}); nothing else ever does, so a session's page is
 * untouched by this module.
 *
 * Every caller that reads or writes the document or the language list builds
 * its request here: services/prefs.js (the user and machine realms, and
 * getGlobalSettings), services/settings-api.js (updateSettings) and
 * services/ui-locale.js.
 * @module services/settings-endpoint
 */

import { apiUrl } from '../utils/api-url.js';

/**
 * The machine server's settings, when this page is the sessions page: the
 * control API's root, the headers its calls carry, the server's version, and
 * the name of another computer's server the page shows framed ('' for none).
 * @type {{base: string, headers: Record<string, string>, version: string, framed: string}|null}
 */
let machine = null;

/**
 * Send this page's settings to the machine server: the control API's root
 * (e.g. `/api/server`, below any reverse-proxy base), the headers every call
 * carries (its credential), and the server's version, which Settings → Updates
 * shows. Called once by the sessions page, before anything reads a setting.
 * @param {{base: string, headers?: Record<string, string>, version?: string}} route
 * @returns {void}
 */
export function useMachineSettings({ base, headers = {}, version = '' }) {
  machine = { base, headers: { ...headers }, version, framed: '' };
}

/**
 * Say that the sessions page shows another computer's server framed, by the
 * name it shows it by: Settings, which is this computer's, says so.
 * @param {string} name - The framed server's name.
 * @returns {void}
 */
export function noteFramedServer(name) {
  if (machine) machine.framed = name;
}

/**
 * What the sessions page's Settings says of where it is: the machine server's
 * version, and the framed server's name ('' for none). Empty on a session's page.
 * @returns {{version: string, framed: string}} It.
 */
export function machineSettingsInfo() {
  return { version: machine?.version || '', framed: machine?.framed || '' };
}

/**
 * Whether this page's settings are the machine server's (the sessions page),
 * rather than a session's.
 * @returns {boolean} True on the sessions page.
 */
export function settingsAreMachines() {
  return machine !== null;
}

/**
 * The settings document's URL.
 * @returns {string} The URL to GET and PUT.
 */
export function settingsUrl() {
  return machine ? `${machine.base}/settings` : apiUrl('/settings');
}

/**
 * The URL listing the UI languages there is a catalogue for.
 * @returns {string} The URL to GET.
 */
export function localesUrl() {
  return machine ? `${machine.base}/i18n/locales` : apiUrl('/i18n/locales');
}

/**
 * The headers a settings request carries beyond its content type: the
 * machine server's credential on the sessions page, none on a session's (whose
 * fetch shim adds its own).
 * @returns {Record<string, string>} Headers to add.
 */
export function settingsHeaders() {
  return machine ? { ...machine.headers } : {};
}

/**
 * Forget the machine server's route — a test's way back to a session page's.
 * @returns {void}
 */
export function __resetSettingsEndpointForTests() {
  machine = null;
}
