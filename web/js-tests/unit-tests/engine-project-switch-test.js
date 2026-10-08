//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Regression: the persistent engine must repoint its project root when the user
 * switches projects via the picker.
 *
 * The server broadcasts `project-changed` on a runtime switch, but the engine is
 * persistent across it and — unlike viewers — never reloads. It therefore kept
 * its boot-time project root, so `query_code`'s `projectRoot` binding (and the
 * root the LLM reads and globs against) stayed pointed at the PREVIOUS project
 * after a switch: the model saw e.g. "/home/crem/tmp/codex" while the header bar
 * showed "/home/crem/dev/tmp/lc0-eval".
 *
 * The fix routes `project-changed` through `_applyEngineProjectRoot(newPath)` in
 * the engine realm, which repoints both `session.projectPath` and the live
 * `globalThis.__jugglerProjectRoot` the sandbox delegates read per run.
 *
 * The root was only half of it. `session.metadata` — where session-scoped
 * permission rules and folder grants live — belongs to ONE project's
 * session.json, and the engine kept the PREVIOUS project's copy while
 * `projectPath` already named the new one. The two halves `isPermitted` reads
 * then disagree: a command matching a standing `execute` rule of the
 * switched-to project is parked for approval anyway, and the suggestion engine
 * offers to add the very rule the user already has. So the switch also reseeds
 * the project-scoped session state, repoints the worker config, and releases
 * the previous project's conversations.
 * @module unit-tests/engine-project-switch
 */

import { createTestSession, assert } from '../utilities/test-helpers.js';
import workerManager from '../../js/services/worker-manager.js';
import ConversationRegistry from '../../js/model/conversation-registry.js';
import { getRulesFor, getAllowedPaths } from '../../js/model/message-thread-permissions.js';
import ExecuteContextItem from '../../extensions/juggler-core/context-items/execute-context-item.js';

/** The switched-to project used throughout, and the standing rule it owns. */
const NEW_PROJECT = '/home/crem/dev/tmp/lc0-eval';
const RUN_RULE = { id: 'r_run_glob', itemType: 'execute', kind: 'glob', value: './run *', scope: 'session' };

/**
 * Snapshot the project-scoped session state a switch tears down, swapping in
 * disposable stand-ins so driving `_applyEngineProjectRoot` in a test never
 * destroys the harness's own conversations, worker config or metadata.
 * @param {any} session - The test session
 * @param {Record<string, any>} [sessionData] - What the stubbed `GET /api/session` returns
 * @returns {() => void} Restores everything this guarded
 */
function guardSwitchSideEffects(session, sessionData = { metadata: {}, messageHistory: [] }) {
  const saved = {
    getSession: session._apiService.getSession,
    registry: session.registry,
    metadata: session.metadata,
    messageHistory: session.messageHistory,
    platform: session.platform,
    home: session.home,
    config: workerManager._config
  };
  // The registry is the whole of the conversation list — map, selection,
  // names, most-recently-used — so a stand-in for it is a stand-in for all of
  // what a switch releases.
  session.registry = new ConversationRegistry();
  session._apiService.getSession = async () => sessionData;
  return () => {
    session._apiService.getSession = saved.getSession;
    session.registry = saved.registry;
    session.metadata = saved.metadata;
    session.messageHistory = saved.messageHistory;
    session.platform = saved.platform;
    session.home = saved.home;
    workerManager._config = saved.config;
  };
}

/**
 * Drive one engine project switch against a stubbed `GET /api/session`, with
 * every mutated global restored afterwards. The session's real registry is
 * swapped out for one holding `conversations` so the harness's own
 * conversations are never destroyed by the release step.
 * @param {any} session - The test session
 * @param {object} opts - Switch options
 * @param {Record<string, any>} opts.before - Metadata the engine holds from the previous project
 * @param {Record<string, any>} opts.after - Metadata the server returns for the switched-to project
 * @param {Map<string, any>} [opts.conversations] - Stand-in conversation map for the switch
 * @returns {Promise<() => void>} Resolves with a restore function the caller MUST invoke once it has asserted
 */
async function switchProject(session, { before, after, conversations = new Map() }) {
  const g = /** @type {any} */ (globalThis);
  const hadEngine = Object.prototype.hasOwnProperty.call(g, 'JUGGLER_ENGINE');
  const savedEngine = g.JUGGLER_ENGINE;
  const hadRoot = Object.prototype.hasOwnProperty.call(g, '__jugglerProjectRoot');
  const savedRoot = g.__jugglerProjectRoot;
  const savedPath = session.projectPath;
  const unguard = guardSwitchSideEffects(session, {
    projectPath: NEW_PROJECT,
    platform: 'darwin',
    home: '/home/crem',
    messageHistory: [],
    metadata: after
  });

  const restore = () => {
    unguard();
    session.projectPath = savedPath;
    if (hadEngine) g.JUGGLER_ENGINE = savedEngine; else delete g.JUGGLER_ENGINE;
    if (hadRoot) g.__jugglerProjectRoot = savedRoot; else delete g.__jugglerProjectRoot;
  };

  try {
    g.JUGGLER_ENGINE = true;
    session.metadata = before;
    for (const [id, conv] of conversations) session.registry.insert(id, conv, 'test');
    await session._applyEngineProjectRoot(NEW_PROJECT);
  } catch (e) {
    restore();
    throw e;
  }
  return restore;
}

/**
 * A minimal message thread that reads permissions through the REAL helpers, so
 * the assertion exercises the true `session.metadata` → `getSessionRules` →
 * `getRulesFor` → `isPermitted` chain rather than a stubbed shortcut.
 * @param {any} session - The session supplying projectPath + metadata
 * @returns {any} A message-thread stand-in wired to that session
 */
function permissionProbe(session) {
  const conversation = { session, getMetadata: () => undefined, setMetadata: () => {} };
  const mt = {
    conversation,
    // Mirrors the real registry answer: `execute` allows session scope,
    // `write-file` is conversation-only.
    getPermissionScopePolicy: (/** @type {string} */ itemType) => itemType === 'execute'
      ? { allowedScopes: ['session', 'conversation'], defaultScope: 'session' }
      : { allowedScopes: ['conversation'], defaultScope: 'conversation' },
    /**
     * @param {string} itemType - Owning context-item id
     * @returns {any[]} Merged session + conversation rules for that item type
     */
    getRulesFor(itemType) { return getRulesFor(this, itemType); },
    /** @returns {string[]} Allowed filesystem roots */
    getAllowedPaths() { return getAllowedPaths(this); }
  };
  return { conversation, mt };
}

/** @typedef {{passed: number, failed: number, errors: string[]}} TestResult */

/** @returns {Promise<TestResult>} Aggregate pass/fail counts and collected errors. */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const session = await createTestSession();

  /**
   * @param {string} name
   * @param {() => void | Promise<void>} fn
   */
  async function t(name, fn) {
    try { await fn(); passed++; }
    catch (e) { failed++; errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  }

  await t('engine repoints its project root on a project switch (not stale)', async () => {
    const g = /** @type {any} */ (globalThis);
    const hadEngine = Object.prototype.hasOwnProperty.call(g, 'JUGGLER_ENGINE');
    const savedEngine = g.JUGGLER_ENGINE;
    const hadRoot = Object.prototype.hasOwnProperty.call(g, '__jugglerProjectRoot');
    const savedRoot = g.__jugglerProjectRoot;
    const savedPath = session.projectPath;
    const savedApply = session._applyEngineProjectRoot;
    const unguard = guardSwitchSideEffects(session);
    try {
      // Present as the engine realm so isEngine() picks the persistent-engine
      // branch (which never calls window.location.reload — safe to drive here).
      g.JUGGLER_ENGINE = true;
      const newPath = NEW_PROJECT;

      // Core contract: applying an engine project switch repoints BOTH the
      // session path and the live root the query_code sandbox exposes. This
      // runs FIRST — in the unfixed build the method is absent and throws here,
      // so the reload-capable handler exercised below is never reached.
      await session._applyEngineProjectRoot(newPath);
      assert(session.projectPath === newPath, 'session.projectPath repointed to the new project');
      assert(g.__jugglerProjectRoot === newPath, 'live sandbox projectRoot repointed to the new project');

      // Wiring: the project-changed handler must route the engine realm through
      // _applyEngineProjectRoot (rather than ignoring the new path as before).
      let routedWith = null;
      session._applyEngineProjectRoot = (/** @type {string} */ p) => { routedWith = p; };
      try {
        session._projectChangedHandler({ projectPath: newPath });
      } finally {
        session._applyEngineProjectRoot = savedApply;
      }
      assert(routedWith === newPath, 'project-changed routes the engine realm to _applyEngineProjectRoot');
    } finally {
      unguard();
      session.projectPath = savedPath;
      session._applyEngineProjectRoot = savedApply;
      if (hadEngine) g.JUGGLER_ENGINE = savedEngine; else delete g.JUGGLER_ENGINE;
      if (hadRoot) g.__jugglerProjectRoot = savedRoot; else delete g.__jugglerProjectRoot;
    }
  });

  await t('sandbox project root is forward-slashed for a native Windows path', async () => {
    const g = /** @type {any} */ (globalThis);
    const hadRoot = Object.prototype.hasOwnProperty.call(g, '__jugglerProjectRoot');
    const savedRoot = g.__jugglerProjectRoot;
    const savedPath = session.projectPath;
    const unguard = guardSwitchSideEffects(session);
    try {
      // The sandbox binds this global as `projectRoot`, and glob({cwd}) strips
      // it as a prefix from backend results that are always forward-slashed. A
      // native Windows root ("C:\...") would match nothing, so the model would
      // get absolute paths back from a `{cwd: projectRoot}` glob.
      await session._applyEngineProjectRoot('C:\\Users\\crem\\dev\\lc0-eval');
      assert(
        g.__jugglerProjectRoot === 'C:/Users/crem/dev/lc0-eval',
        'live sandbox projectRoot is POSIX-style'
      );
      // session.projectPath itself stays native — it is compared against other
      // native paths elsewhere in the client.
      assert(
        session.projectPath === 'C:\\Users\\crem\\dev\\lc0-eval',
        'session.projectPath keeps the OS-native spelling'
      );
    } finally {
      unguard();
      session.projectPath = savedPath;
      if (hadRoot) g.__jugglerProjectRoot = savedRoot; else delete g.__jugglerProjectRoot;
    }
  });

  // THE REPORTED BUG. The engine held the previous project's session metadata,
  // so a command covered by a standing rule of the switched-to project was
  // parked for approval anyway — and the approval dialog then offered to add
  // the rule the user already had. Metadata must be REPLACED by the loaded
  // project's, never merged: a rule of the project we left must not survive.
  await t('a project switch replaces session metadata with the loaded project\'s', async () => {
    const restore = await switchProject(session, {
      before: {
        sessionPermissionRules: [{ id: 'r_old', itemType: 'execute', kind: 'glob', value: 'make *', scope: 'session' }],
        sessionAllowedPaths: [{ id: 'p_old', path: '/some/other/project/vendor', scope: 'session' }]
      },
      after: { sessionPermissionRules: [RUN_RULE] }
    });
    try {
      const rules = session.getMetadata('sessionPermissionRules') || [];
      assert(rules.length === 1 && rules[0].value === './run *',
        `switched-to project's rules are live, got ${JSON.stringify(rules)}`);
      assert(session.getMetadata('sessionAllowedPaths') === undefined,
        'a key absent from the new project is dropped, not merged forward');
    } finally {
      restore();
    }
  });

  await t('a standing rule of the switched-to project auto-approves at once (no spurious prompt)', async () => {
    const restore = await switchProject(session, {
      before: { sessionPermissionRules: [] },
      after: { sessionPermissionRules: [RUN_RULE] }
    });
    try {
      const { conversation, mt } = permissionProbe(session);
      const item = new ExecuteContextItem({
        id: 'switch-probe',
        session,
        conversation,
        messageThread: mt,
        toolUseId: 'switch-probe'
      });
      // The exact reported command: a leading in-root `cd`, a `2>&1` redirect
      // and a `tail` sink — all stripped by the analyser, leaving `./run test`
      // for the `./run *` rule to match.
      const command = `cd ${NEW_PROJECT} && ./run test 2>&1 | tail -40`;
      assert(item.isPermitted({ command }),
        'a session rule of the loaded project auto-approves instead of parking for approval');
      // The counterpart: reseeding grants exactly the loaded project's rules and
      // nothing wider — a command no rule covers still parks.
      assert(!item.isPermitted({ command: `cd ${NEW_PROJECT} && ./deploy prod` }),
        'a command no rule of the loaded project covers still requires approval');
    } finally {
      restore();
    }
  });

  await t('a project switch repoints the worker config and releases the old conversations', async () => {
    const realConfig = workerManager._config;
    workerManager.init({ projectPath: '/home/crem/tmp/codex', apiBaseUrl: 'http://localhost' }, session);
    let destroyed = 0;
    const stale = new Map([
      ['conv_old_a', { destroy: () => { destroyed++; } }],
      ['conv_old_b', { destroy: () => { destroyed++; } }]
    ]);
    const restore = await switchProject(session, {
      before: { sessionPermissionRules: [] },
      after: { sessionPermissionRules: [RUN_RULE] },
      conversations: stale
    });
    try {
      // A worker spawned after the switch must be told the project it now
      // belongs to — its config is what the server keys the worker's
      // conversation log on, and an empty stale value disables persistence.
      assert(workerManager._config.projectPath === NEW_PROJECT,
        `worker config repointed, got ${workerManager._config.projectPath}`);
      assert(destroyed === 2, `both stale conversations were destroyed, got ${destroyed}`);
      assert(session.conversations.size === 0, 'the previous project\'s conversation map is emptied');
      assert(session.visibleConversationId === null, 'no conversation from the old project stays visible');
    } finally {
      restore();
      workerManager._config = realConfig;
    }
  });

  return { passed, failed, errors };
}
