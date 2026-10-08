//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import contextItemRegistry from './context-item-registry.js';
import strategyRegistry from './strategy-registry.js';
import commandRegistry from './command-registry.js';
import infoCardRegistry from './info-card-registry.js';
import pinboardItemRegistry from './pinboard-item-registry.js';
import fileViewerRegistry from './file-viewer-registry.js';
import workspaceProviderRegistry from './workspace-provider-registry.js';
import { resetExtensionsCache } from '../services/extensions.js';
import { resetUserCommandsCache } from '../services/user-commands.js';
import { resetSkillsCache } from '../services/skills.js';
import { markRegistriesReady } from './registry-ready.js';
import { getAppSession } from '../utils/app-session.js';
import { statusHoldsTurn } from '../model/processing-status.js';

/**
 * Event dispatched on `document` after the capability registries have been torn
 * down and rebuilt from the current extension catalog + config. UI that caches
 * registry contents (the strategy selector's menu, etc.) listens for this and
 * reloads from the registries — it is the single signal that the set of enabled
 * strategies / context items / commands may have changed.
 * @type {string}
 */
export const REGISTRIES_RELOADED = 'registries-reloaded';

/** @type {Promise<void>|null} */
let reloadInFlight = null;
let reloadRequested = false;

/**
 * @returns {import('../model/session.js').default[]} Locally reachable app/engine sessions
 */
function getLiveSessions() {
  const sessions = [];
  const appSession = getAppSession();
  const engineSession = /** @type {any} */ (globalThis).engineApp?.getSession?.();
  if (appSession) sessions.push(appSession);
  if (engineSession && engineSession !== appSession) sessions.push(engineSession);
  return sessions;
}

/**
 * How long the rebuild will defer to a running turn before going ahead anyway.
 * The deferral exists to keep registry maps immutable across an observed turn,
 * which is worth a wait but never worth a deadlock: every status this waits on
 * is written by the worker, so anything that leaves one set — a crashed worker,
 * a tool that never returns — would otherwise wedge the rebuild, and with it
 * every enable/disable in the catalog, for the life of the page.
 * @type {number}
 */
const QUIESCENCE_TIMEOUT_MS = 30000;

/**
 * Whether a conversation is running a turn we should wait for.
 *
 * A conversation parked on a tool approval is deliberately NOT busy. The worker
 * publishes `processing_tools` for as long as the user deliberates, so a status
 * check alone never clears; the turn is parked on the user, executes nothing,
 * and can sit there indefinitely. The server's activity signal
 * (GET /api/health/active) subtracts the same case, and the plugin catalog asks
 * it before starting a toggle — so counting an approval-parked conversation as
 * busy here would block a rebuild the catalog had already been told was safe.
 * @param {import('../model/conversation.js').default} conv
 * @returns {boolean} True while the conversation is running a turn
 */
export function isConversationBusy(conv) {
  if (!statusHoldsTurn(conv.processingState?.status)) return false;
  return !conv.isAwaitingApproval?.();
}

/**
 * @returns {boolean} True when any local session has a busy conversation
 */
function anyLocalConversationBusy() {
  for (const session of getLiveSessions()) {
    for (const conv of session.conversations?.values?.() || []) {
      if (isConversationBusy(conv)) return true;
    }
  }
  return false;
}

/**
 * Wait for every locally-observed turn to finish, giving up after
 * {@link QUIESCENCE_TIMEOUT_MS}. Expiry is reported, not silent: a rebuild that
 * went ahead over a turn is the explanation for anything odd that turn then
 * sees, and there is nowhere else that would say so.
 * @returns {Promise<void>}
 */
async function waitForLocalQuiescence() {
  const deadline = Date.now() + QUIESCENCE_TIMEOUT_MS;
  while (anyLocalConversationBusy()) {
    if (Date.now() >= deadline) {
      console.warn(
        `[registries] A turn was still running after ${QUIESCENCE_TIMEOUT_MS}ms; ` +
        'rebuilding the capability registries anyway.'
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Initialize the capability registries in dependency order (strategies
 * first — they gate the whole flow), then flip the registries-ready gate.
 *
 * The single shared boot/rebuild sequence: first-boot (app.js / engine-app.js)
 * and hot-reload (rebuildRegistriesNow) both call it, so the order and the ready
 * signal never drift. markRegistriesReady() runs even when an init throws, so a
 * broken plugin can't permanently hang the system-prompt gate; it is idempotent
 * after the first call, so the gate stays resolved across reloads.
 * @returns {Promise<void>}
 */
export async function initAllRegistries() {
  try {
    await strategyRegistry.init();
    await contextItemRegistry.init();
    registerItemOwnedStrategies();
    await commandRegistry.init();
    // File viewers run in BOTH realms — render() in the viewer, extract() in the
    // engine worker — so unlike info cards this registry is initialised
    // unconditionally.
    await fileViewerRegistry.init();
    // Info cards and pinboard items touch the DOM and only render in the viewer —
    // never init these registries (which would import DOM-touching modules) in the
    // engine worker, which has no document.
    if (typeof document !== 'undefined') {
      await infoCardRegistry.init();
      await pinboardItemRegistry.init();
      // Workspace providers are viewer-only for the same reason, one step
      // removed: their whole lifecycle is user-driven, and the engine resolves a
      // workspace from the session's row without asking whoever made it.
      await workspaceProviderRegistry.init();
    }
  } finally {
    markRegistriesReady();
  }
}

/**
 * Register the strategy classes context items own (see `ContextItem.getStrategies`),
 * forcing each hidden so it never reaches a user-facing strategy list. This is
 * what lets a delegating item be a subagent: its delegated child runs under a
 * tool filter and approval policy the item defines, pinned by id from
 * `buildSubthreadSpec`.
 *
 * Placed here, between the two registries' inits, for three reasons:
 *   - `strategyRegistry.init()` has already run, so file-based strategies hold
 *     their ids and win any collision — item-owned registration is purely
 *     additive, never a shadow.
 *   - `contextItemRegistry.init()` has already run, so the classes to ask exist
 *     and the config-disabled ones are already filtered out (a disabled item
 *     contributes no strategy).
 *   - `rebuildRegistriesNow()` resets both registries and re-runs this whole
 *     sequence, so hot-reload and extension enable/disable are covered by doing
 *     this here and nowhere else.
 *
 * A class that throws or collides is reported through the registry's failed-module
 * list (surfaced in the Extensions catalog) and skipped — one broken subagent
 * never takes the boot sequence with it.
 *
 * Exported for the unit-test harness, which initialises the two registries
 * directly rather than through this module's sequence; production code should
 * reach it via `initAllRegistries()`.
 * @returns {void}
 */
export function registerItemOwnedStrategies() {
  for (const { id, class: ItemClass } of contextItemRegistry.getAll()) {
    let classes;
    try {
      classes = /** @type {any} */ (ItemClass).getStrategies?.() || [];
    } catch (err) {
      console.error(`[registries] Context item "${id}" failed to provide strategies:`, err);
      continue;
    }
    for (const StrategyClass of classes) {
      const manifest = /** @type {any} */ (StrategyClass)?.MANIFEST;
      if (!manifest) {
        console.error(`[registries] Context item "${id}" returned a strategy with no MANIFEST`);
        continue;
      }
      // Forced, not merely expected: an item-owned strategy is an implementation
      // detail of a tool, and the user picks the tool by its name — never the
      // strategy by its id.
      manifest.hidden = true;
      strategyRegistry.registerClass(StrategyClass, {
        extensionId: contextItemRegistry.getExtensionId(id),
        modulePath: ''
      });
    }
  }
}

/**
 * The registry rebuild currently in flight, if any.
 *
 * Mutating callers (the command editor, the skills tab) start a rebuild without
 * awaiting it on purpose: it defers to local quiescence, so blocking on it would
 * hold a dialog open across a whole turn. That leaves a window in which the
 * registries have been reset and not yet rebuilt. Nothing in the app needs to
 * hold there — every reader is either awaiting the registries-ready gate or
 * repaints on {@link REGISTRIES_RELOADED}. A test harness running suite after
 * suite in one realm does need to: the window would otherwise stretch into the
 * next suite, which would find capabilities that were registered a moment ago
 * simply absent.
 * @returns {Promise<void>} Resolves once no rebuild is outstanding.
 */
export function whenRegistriesSettled() {
  return reloadInFlight || Promise.resolve();
}

/**
 * Snapshot every capability module that failed to import, across the registries,
 * keyed by served URL. A capability that throws on import is dropped silently —
 * it simply isn't in the registry afterwards — so this is the only way to see
 * that a reload half-worked.
 * @returns {Map<string, string>} Load error keyed by served module URL
 */
export function collectFailedModules() {
  /** @type {Map<string, string>} */
  const failed = new Map();
  const registries = [
    strategyRegistry,
    contextItemRegistry,
    commandRegistry,
    fileViewerRegistry,
    infoCardRegistry,
    pinboardItemRegistry,
    workspaceProviderRegistry,
  ];
  for (const reg of registries) {
    for (const { path, error } of reg.getFailedModules()) {
      failed.set(path, error);
    }
  }
  return failed;
}

/**
 * Diff two failure snapshots, returning only what is newly broken. A module that
 * failed the same way before is NOT included: an extension the user has left
 * broken must not re-announce itself every time something unrelated reloads.
 * A different error message for the same module counts as new — the file was
 * edited and still doesn't load, which is worth saying again.
 * @param {Map<string, string>} previous - Snapshot from the last reload
 * @param {Map<string, string>} current - Snapshot from this reload
 * @returns {Array<{path: string, error: string}>} Newly failed modules, in registry order
 */
export function newlyFailedModules(previous, current) {
  /** @type {Array<{path: string, error: string}>} */
  const fresh = [];
  for (const [path, error] of current) {
    if (previous.get(path) !== error) fresh.push({ path, error });
  }
  return fresh;
}

/** @returns {Promise<void>} */
async function rebuildRegistriesNow() {
  resetExtensionsCache();
  resetUserCommandsCache();
  resetSkillsCache();
  strategyRegistry.reset();
  contextItemRegistry.reset();
  commandRegistry.reset();
  fileViewerRegistry.reset();
  // Viewer-only registries; the engine worker never inits them, so only reset
  // them where a document exists (initAllRegistries applies the same realm gate).
  if (typeof document !== 'undefined') {
    infoCardRegistry.reset();
    pinboardItemRegistry.reset();
    workspaceProviderRegistry.reset();
  }
  // reset/re-init is deferred to local quiescence, so no turn assembles a
  // prompt against a half-reset registry set.
  await initAllRegistries();
  // UI listens for this DOM event to refresh; the engine worker has no document
  // and reloads its registries directly, so the dispatch is viewer-only.
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent(REGISTRIES_RELOADED));
  }
}

/**
 * Tear down and rebuild all three capability registries from the current
 * extension catalog and plugin config, then announce the change.
 *
 * This is the one path shared by plugin hot reload (a changed/added extension on
 * disk) and the Extensions catalog's enable/disable toggles, so both apply live
 * and both notify dependent UI. The cached `/api/extensions` catalog is dropped
 * first so a freshly linked extension or edited manifest is re-fetched.
 *
 * Registry maps are immutable for the duration of any locally observed turn: if
 * a reload arrives while a conversation is busy, the reset/re-init is deferred
 * until the worker metadata reaches idle. Multiple reload requests coalesce into
 * one rebuild after the quiescent boundary.
 * @returns {Promise<void>}
 */
export async function reloadRegistries() {
  reloadRequested = true;
  if (reloadInFlight) return reloadInFlight;

  reloadInFlight = (async () => {
    while (reloadRequested) {
      reloadRequested = false;
      await waitForLocalQuiescence();
      await rebuildRegistriesNow();
    }
  })();

  try {
    await reloadInFlight;
  } finally {
    reloadInFlight = null;
  }
}
