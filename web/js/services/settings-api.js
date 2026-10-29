//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The REST calls the settings panel and its tabs make, one function per
 * endpoint, so a view states what it wants rather than how to ask for it.
 *
 * Every JSON call goes through {@link fetchJson} and keeps its failure policy:
 * a function throws an {@link import('./http.js').HttpError} on a non-OK
 * response unless its {@link RequestPolicy} carries a `fallback`, in which case
 * it resolves to that instead. `errorPrefix` prefixes the thrown message, as it
 * does there. A policy is passed through as given, so a `fallback` of
 * `undefined` still counts as one.
 * @module services/settings-api
 */

import { fetchJson } from './http.js';
import { apiUrl } from '../utils/api-url.js';

/**
 * How a call reports a failure — the failure-policy half of fetchJson's options.
 * @typedef {object} RequestPolicy
 * @property {string} [errorPrefix] - Translated prefix for the thrown message (or the warning, with a fallback).
 * @property {any} [fallback] - Resolve to this on failure instead of throwing.
 */

/**
 * The model chosen for a role (default, cheap, decision), as the server reports it.
 * @typedef {object} ModelChoice
 * @property {string} [provider] - Provider name; empty for Automatic.
 * @property {string} [model] - Model id; empty for Automatic.
 * @property {string} [thinking] - Reasoning level; empty for the model's default.
 * @property {string} [serviceTier] - Serving tier; empty for standard.
 * @property {boolean} [explicit] - False when the server chooses (Automatic).
 * @property {boolean} [disabled] - Cheap model only: the user wants none.
 * @property {boolean} [available] - Decision model only: whether it can serve now.
 * @property {{provider: string, model: string}} [autoResolved] - Cheap model only: what Automatic resolved to.
 */

/**
 * The default model as GET /api/default-model reports it: provider and model
 * are always present, both empty while the server chooses (Automatic).
 * @typedef {ModelChoice & {provider: string, model: string}} DefaultModelChoice
 */

/**
 * The answer a provider sign-in endpoint gives: `success` false carries `error`.
 * @typedef {{success?: boolean, error?: string, [field: string]: any}} SuccessEnvelope
 */

// ── /api/config (credentials.json) ─────────────────────────────────────────

/**
 * GET /api/config: the stored configuration (which keys exist, provider hosts,
 * the background-job switches).
 * @param {RequestPolicy} [policy]
 * @returns {Promise<any>} The config object.
 */
export function getConfig(policy = {}) {
  return fetchJson(apiUrl('/config'), { ...policy });
}

/**
 * PUT /api/config with one key. The server merges a PUT into what is stored,
 * so every other key keeps its value; an empty string clears a stored key.
 * @param {string} key - The wire name (snake_case), e.g. `auto_name_disabled`.
 * @param {any} value - The value to store.
 * @param {RequestPolicy} [policy]
 * @returns {Promise<any>} The server's answer (usually nothing).
 */
export function setConfig(key, value, policy = {}) {
  return fetchJson(apiUrl('/config'), { method: 'PUT', body: { [key]: value }, ...policy });
}

/**
 * POST /api/config/provider-enabled: switch a keyless or sign-in provider on or
 * off. The server queues a provider recompute, whose providers-update reaches
 * every model selector.
 * @param {string} provider - Provider name.
 * @param {boolean} enabled
 * @param {RequestPolicy} [policy]
 * @returns {Promise<any>} The server's answer.
 */
export function setProviderEnabled(provider, enabled, policy = {}) {
  return fetchJson(apiUrl('/config/provider-enabled'), {
    method: 'POST',
    body: { provider, enabled },
    ...policy,
  });
}

// ── /api/settings (settings.json) ──────────────────────────────────────────

/**
 * PUT /api/settings with a partial document. The server merges it section by
 * section and answers with the whole document as stored.
 * @param {object} patch - The sections to change, e.g. `{updates: {mode}}`.
 * @param {RequestPolicy} [policy]
 * @returns {Promise<any>} The settings document after the write.
 */
export function updateSettings(patch, policy = {}) {
  return fetchJson(apiUrl('/settings'), { method: 'PUT', body: patch, ...policy });
}

// ── Providers ──────────────────────────────────────────────────────────────

/**
 * GET /api/providers: the published provider catalogue. `ready` is false while
 * the server's first refresh is still running.
 * @param {RequestPolicy} [policy]
 * @returns {Promise<{providers?: any[], ready?: boolean}>} The catalogue payload.
 */
export function getProviders(policy = {}) {
  return fetchJson(apiUrl('/providers'), { ...policy });
}

/**
 * GET /api/providers/copilot/host: the GitHub host Copilot signs in against.
 * @param {RequestPolicy} [policy]
 * @returns {Promise<SuccessEnvelope|null>} `{success, host}`.
 */
export function getCopilotHost(policy = {}) {
  return fetchJson(apiUrl('/providers/copilot/host'), { ...policy });
}

/**
 * POST /api/providers/copilot/host: store the GitHub host.
 * @param {string} host - e.g. `github.com`.
 * @returns {Promise<SuccessEnvelope|null>} `{success}` or `{success: false, error}`.
 */
export function setCopilotHost(host) {
  return fetchJson(apiUrl('/providers/copilot/host'), { method: 'POST', body: { host } });
}

/**
 * POST /api/providers/copilot/device/start: begin a GitHub device-code sign-in.
 * @param {string} host - GitHub host to sign in against.
 * @returns {Promise<SuccessEnvelope|null>} `{success, userCode, verificationUri, deviceCode, interval}`.
 */
export function startCopilotDeviceLogin(host) {
  return fetchJson(apiUrl('/providers/copilot/device/start'), { method: 'POST', body: { host } });
}

/**
 * POST /api/providers/copilot/device/poll: ask whether the device code was authorized.
 * @param {string} deviceCode - From {@link startCopilotDeviceLogin}.
 * @param {string} host - The host the flow was started against.
 * @returns {Promise<SuccessEnvelope|null>} `{success, status}`; status is authorized, pending, slow_down, expired or denied.
 */
export function pollCopilotDeviceLogin(deviceCode, host) {
  return fetchJson(apiUrl('/providers/copilot/device/poll'), {
    method: 'POST',
    body: { deviceCode, host },
  });
}

/**
 * POST /api/providers/copilot/signout: forget the GitHub login Juggler stored.
 * @returns {Promise<SuccessEnvelope|null>} `{success}` or `{success: false, error}`.
 */
export function signOutCopilot() {
  return fetchJson(apiUrl('/providers/copilot/signout'), { method: 'POST' });
}

// ── Model roles ────────────────────────────────────────────────────────────

/**
 * GET /api/default-model: the model new conversations start on.
 * @param {RequestPolicy} [policy]
 * @returns {Promise<DefaultModelChoice>} The choice.
 */
export function getDefaultModel(policy = {}) {
  return fetchJson(apiUrl('/default-model'), { ...policy });
}

/**
 * PUT /api/default-model. An empty provider/model returns it to Automatic.
 * @param {ModelChoice} choice
 * @returns {Promise<any>} The server's answer.
 */
export function setDefaultModel(choice) {
  return fetchJson(apiUrl('/default-model'), { method: 'PUT', body: choice });
}

/**
 * GET /api/cheap-model: the model background jobs spend.
 * @param {RequestPolicy} [policy]
 * @returns {Promise<ModelChoice|null>} The choice.
 */
export function getCheapModel(policy = {}) {
  return fetchJson(apiUrl('/cheap-model'), { ...policy });
}

/**
 * PUT /api/cheap-model. `disabled: true` means none; an empty provider/model
 * returns it to Automatic.
 * @param {ModelChoice} choice
 * @returns {Promise<any>} The server's answer.
 */
export function setCheapModel(choice) {
  return fetchJson(apiUrl('/cheap-model'), { method: 'PUT', body: choice });
}

/**
 * GET /api/decision-model: the model that answers yes/no questions with probabilities.
 * @param {RequestPolicy} [policy]
 * @returns {Promise<ModelChoice|null>} The choice.
 */
export function getDecisionModel(policy = {}) {
  return fetchJson(apiUrl('/decision-model'), { ...policy });
}

/**
 * PUT /api/decision-model. An empty provider/model clears it.
 * @param {{provider: string, model: string}} choice
 * @returns {Promise<any>} The server's answer.
 */
export function setDecisionModel(choice) {
  return fetchJson(apiUrl('/decision-model'), { method: 'PUT', body: choice });
}

// ── Connectivity ───────────────────────────────────────────────────────────

/**
 * GET /api/connectivity: the clients connected to this session, and whether
 * this viewer may switch LAN access and tunnels here (`exposure`).
 * @param {RequestPolicy} [policy]
 * @returns {Promise<any>} The connectivity state.
 */
export function getConnectivity(policy = {}) {
  return fetchJson(apiUrl('/connectivity'), { ...policy });
}

/**
 * One address another device can open, with the server's QR drawing of it.
 * @typedef {object} ExposureURL
 * @property {string} url - The address
 * @property {string} [interface] - The network interface it is on (LAN only)
 * @property {string} [qr] - SVG markup drawing the address as a QR code
 * @property {{url: string, qr?: string}} [session] - This session at the address, with its QR
 */

/**
 * LAN access, as the machine server reports it.
 * @typedef {object} LANState
 * @property {boolean} enabled - Whether devices on this network may come in
 * @property {ExposureURL[]} urls - This machine's addresses on its networks, while enabled
 */

/**
 * One tunnel mode a build registered. Each text field is English, with its
 * translatable message beside it as `<field>Message`.
 * @typedef {object} TunnelMode
 * @property {string} mode - Its id
 * @property {boolean} available - Whether it can start on this machine
 * @property {string} [title] - Its name
 * @property {string} [description] - What it does, and its trade-offs
 * @property {string} [startLabel] - Its start button's label
 * @property {string} [relayNote] - Said of an open link whose traffic is relayed
 * @property {string} [unavailableHint] - Why it cannot start, and what would let it
 */

/**
 * The machine's tunnel: the modes it can open, and the open one, if any.
 * @typedef {object} TunnelState
 * @property {TunnelMode[]} modes - Every mode this build registered
 * @property {{mode: string, url: string, relay: boolean, qr?: string, session?: {url: string, qr?: string}}|null} running -
 *   The open tunnel: its mode, link, whether it is relayed, the link's QR
 *   drawing, and this session through it
 */

/**
 * GET /api/connectivity/lan: this machine's LAN access (the machine server's).
 * @returns {Promise<LANState>} LAN access as it stands.
 */
export function getLAN() {
  return fetchJson(apiUrl('/connectivity/lan'));
}

/**
 * PUT /api/connectivity/lan: let devices on this network in, or not.
 * @param {boolean} enabled
 * @returns {Promise<LANState>} LAN access as it now stands.
 */
export function setLAN(enabled) {
  return fetchJson(apiUrl('/connectivity/lan'), { method: 'PUT', body: { enabled } });
}

/**
 * GET /api/connectivity/tunnel: this machine's tunnel (the machine server's).
 * @returns {Promise<TunnelState>} The tunnel as it stands.
 */
export function getTunnel() {
  return fetchJson(apiUrl('/connectivity/tunnel'));
}

/**
 * PUT /api/connectivity/tunnel: open the tunnel in mode, or close it with ''.
 * @param {string} mode
 * @returns {Promise<TunnelState>} The tunnel as it now stands.
 */
export function setTunnel(mode) {
  return fetchJson(apiUrl('/connectivity/tunnel'), { method: 'PUT', body: { mode } });
}

/**
 * What opens whenever Juggler starts: LAN access, and one tunnel mode ('' for none).
 * @typedef {{lanOnLaunch: boolean, wanOnLaunch: string}} LaunchState
 */

/**
 * GET /api/connectivity/launch: what the machine server opens whenever it starts.
 * @returns {Promise<LaunchState>} The saved choices.
 */
export function getLaunch() {
  return fetchJson(apiUrl('/connectivity/launch'));
}

/**
 * PUT /api/connectivity/launch: save the keys of what opens at start that change.
 * @param {Partial<LaunchState>} change - One key, or both.
 * @returns {Promise<LaunchState>} Both, as now saved.
 */
export function setLaunch(change) {
  return fetchJson(apiUrl('/connectivity/launch'), { method: 'PUT', body: change });
}

// ── Updates ────────────────────────────────────────────────────────────────

/**
 * GET /api/update-status: this build's version and the latest one known.
 * @param {RequestPolicy} [policy]
 * @returns {Promise<any>} The update status.
 */
export function getUpdateStatus(policy = {}) {
  return fetchJson(apiUrl('/update-status'), { ...policy });
}

/**
 * POST /api/update-status/check: check the update server now.
 * @returns {Promise<any>} The fresh update status; `error` is set when the server could not be reached.
 */
export function checkForUpdate() {
  return fetchJson(apiUrl('/update-status/check'), { method: 'POST' });
}

// ── Logs ───────────────────────────────────────────────────────────────────

/**
 * GET /api/logs: this session's log files.
 * @param {RequestPolicy} [policy]
 * @returns {Promise<{files?: any[]}|null>} The file list.
 */
export function listLogs(policy = {}) {
  return fetchJson(apiUrl('/logs'), { ...policy });
}

/**
 * GET /api/logs/content: one log file from `offset` on.
 * @param {string} path - Absolute path of the log file.
 * @param {number} offset - Byte offset to read from.
 * @param {RequestPolicy} [policy]
 * @returns {Promise<{content: string, replaced?: boolean, [field: string]: any}|null>} The content read.
 */
export function getLogContent(path, offset, policy = {}) {
  return fetchJson(apiUrl(`/logs/content?path=${encodeURIComponent(path)}&offset=${offset}`), { ...policy });
}
