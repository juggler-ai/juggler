//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Switching a plugin on or off from a test, and putting it back.
 *
 * The plugin config is the project's (`.juggler/config.json` under the fixture
 * root), so a change reaches every lane of the server and survives the fixture
 * reset, which keeps `.juggler/`. A test that changes it must run exclusively,
 * and the runner restores what it found once the test ends, pass or fail.
 *
 * A config write broadcasts `plugin-changed`, and the engine rebuilds its
 * registries in its own time. Until it has, a turn is offered the tools from
 * before the change, or none at all while the rebuild is in progress. So every
 * write here waits for the engine to say its registries are reloaded
 * (`juggler-registries` on the engine bridge, engine-app.js) before returning.
 * @module js-tests/utilities/plugin-config
 */

import wsService from '../../js/services/websocket.js';
import { apiUrl } from '../../js/utils/api-url.js';
import { budgetFor } from './test-deadline.js';
import { racePatiently } from './test-patience.js';

/** The engine-bridge channel the engine acknowledges a registry reload on. */
export const REGISTRIES_CHANNEL = 'juggler-registries';

/** Nominal time for the engine to rebuild its registries after a config write. */
const RELOAD_NOMINAL_MS = 10000;

/**
 * The project's resolved disabled-plugin list.
 * @returns {Promise<string[]>} Ids switched off for this project
 */
async function readDisabled() {
  const resp = await fetch(apiUrl('/config/plugins'));
  if (!resp.ok) throw new Error(`Couldn't read the plugin config: HTTP ${resp.status}`);
  const data = await resp.json();
  return Array.isArray(data?.disabled) ? data.disabled : [];
}

/**
 * Run `trigger`, then wait for the engine's next registry reload. The listener
 * is in place before the trigger runs, so an acknowledgement that arrives
 * quickly is not missed. The wait rides the test's deadline.
 * @param {() => Promise<void>} trigger - What causes the reload
 * @param {string} what - Named in the failure
 * @returns {Promise<void>} Resolves once the engine reports its registries reloaded
 */
export async function afterEngineReload(trigger, what) {
  /** @type {(ev: any) => void} */
  let handler = () => {};
  const acknowledged = new Promise((resolve) => {
    handler = (ev) => {
      if (ev?.channel === REGISTRIES_CHANNEL) resolve(undefined);
    };
    wsService.on('engine-bridge', handler);
  });
  const budget = budgetFor(RELOAD_NOMINAL_MS);
  try {
    await trigger();
    const settled = await racePatiently(acknowledged, budget, { what: `the engine to reload its registries after ${what}` });
    if (!settled) {
      throw new Error(`the engine did not report its registries reloaded within ${budget}ms of ${what} (nor while the test was still progressing); `
        + `nothing arrived on the '${REGISTRIES_CHANNEL}' engine-bridge channel`);
    }
  } finally {
    wsService.off('engine-bridge', handler);
  }
}

/**
 * Write the resolved disabled list and wait for the engine to load it.
 * @param {string[]} disabled - Ids to switch off
 * @param {string} what - Named in a failure
 * @returns {Promise<void>}
 */
async function writeDisabled(disabled, what) {
  await afterEngineReload(async () => {
    const resp = await fetch(apiUrl('/config/plugins'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled })
    });
    if (!resp.ok) throw new Error(`Couldn't write the plugin config: HTTP ${resp.status}`);
  }, what);
}

/**
 * Switch a plugin on or off for the project, remembering on the harness what the
 * config said before this test first touched it.
 * @param {{_pluginConfigBefore?: string[]}} harness - The test's harness
 * @param {string} pluginId - Plugin id
 * @param {boolean} enabled - Whether it ends up on
 * @returns {Promise<void>} Resolves once the engine has loaded the change
 */
export async function setPluginEnabled(harness, pluginId, enabled) {
  const disabled = await readDisabled();
  harness._pluginConfigBefore ??= [...disabled];
  const next = disabled.filter((id) => id !== pluginId);
  if (!enabled) next.push(pluginId);
  await writeDisabled(next, `switching ${pluginId} ${enabled ? 'on' : 'off'}`);
}

/**
 * Put the plugin config back as the test found it, if the test changed it.
 * @param {{_pluginConfigBefore?: string[]}} harness - The test's harness
 * @returns {Promise<void>} Resolves once the engine has loaded the original config
 */
export async function restorePluginConfig(harness) {
  const before = harness._pluginConfigBefore;
  if (!before) return;
  delete harness._pluginConfigBefore;
  await writeDisabled(before, 'restoring the plugin config');
}
