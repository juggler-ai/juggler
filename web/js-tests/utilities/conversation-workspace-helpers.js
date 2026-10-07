//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What every conversation-workspace suite is built out of.
 *
 * The binding's cases are spread over several files because one file is one
 * suite, and a suite of ninety cases has no headroom left on a loaded machine.
 * The fixtures they share — a workspace row, a conversation ready to be sent
 * to, the readers that run a real tool in it, and the seed counters — live
 * here so that spreading them costs no duplication.
 * @module unit-tests/conversation-workspace-helpers
 */

import {
  initializeRegistries,
  createTestSession,
  releaseTestConversation,
  waitForWorkerReady
} from '../utilities/test-helpers.js';
import { DEFAULT_FILE_EDITING_META_KEY } from '../../js/services/file-editing-permission.js';
import { fetchJson } from '../../js/services/http.js';
import { pingWorker } from './worker-test-hooks.js';
import contextItemRegistry from '../../js/registries/context-item-registry.js';
import { createBoundOps } from '../../sdk/ops.js';
import { registerWorkspace, patchWorkspace, listWorkspaces } from '../../js/services/workspaces.js';
import { provisionWorkspace } from '../../js/services/workspace-provisioning.js';
import { rebindConversation } from '../../js/services/workspace-rebinding.js';
import WorkspaceProvider from '../../sdk/workspace-provider.js';
import workspaceProviderRegistry from '../../js/registries/workspace-provider-registry.js';
import { ensureWorkspaceBanner } from '../../js/components/conversation-area-rendering.js';
import { relativePath } from '../../extensions/juggler-core/lib/workspace-paths.js';
import { apiUrl } from '../../js/utils/api-url.js';

/**
 * A workspace row as the client-side table holds it, for the cases that seed
 * one directly rather than registering it with the server.
 * @param {string} id - Workspace id.
 * @param {string} root - Where it is.
 * @param {object} [extra] - State, availability, label — whatever the case is about.
 * @returns {any} The row.
 */
export function workspaceRow(id, root, extra = {}) {
  return { id, kind: 'local', root, state: 'ready', available: true, ...extra };
}

/**
 * A conversation, ready to be sent to: model configured and its worker up.
 * @param {any} session - The test session.
 * @param {string} name - Conversation name.
 * @param {object} [options] - Passed through to createConversation.
 * @returns {Promise<any>} The conversation.
 */
export async function makeConversation(session, name, options = {}) {
  const id = await session.createConversation(name, options);
  const conversation = session.conversations.get(id);
  if (!conversation) throw new Error(`conversation ${id} was created but is not in the session`);
  conversation.setModelConfig({ provider: 'test-provider', model: 'test-model' });
  await waitForWorkerReady(id);
  return conversation;
}

/**
 * Read a file through the real `read` tool, as a turn in this conversation would.
 *
 * The path is deliberately relative: which tree it lands in is the whole
 * question, and only a relative path asks it.
 * @param {any} session - The test session.
 * @param {any} conversation - The conversation whose tools these are.
 * @param {string} path - Path relative to wherever the conversation works.
 * @returns {Promise<any>} The read result.
 */
export async function readIn(session, conversation, path) {
  const ReadFile = /** @type {any} */ (contextItemRegistry.getByToolName('read'));
  if (!ReadFile) throw new Error('the read tool is not registered');
  const item = new ReadFile({
    id: 'read-file',
    session,
    conversation,
    messageThread: conversation.rootMessageThread
  });
  return item.execute({ path });
}

/**
 * Run a script through the real `query_code` tool, as a turn in this
 * conversation would.
 * @param {any} session - The test session.
 * @param {any} conversation - The conversation whose tools these are.
 * @param {string} code - The script body.
 * @returns {Promise<any>} The tool result.
 */
export async function queryIn(session, conversation, code) {
  const QueryCode = /** @type {any} */ (contextItemRegistry.getByToolName('query_code'));
  if (!QueryCode) throw new Error('the query_code tool is not registered');
  const item = new QueryCode({
    id: 'query-code',
    session,
    conversation,
    messageThread: conversation.rootMessageThread
  });
  return item.execute({ code });
}

/**
 * Wait for a file to turn up in a workspace, and say whether it did.
 *
 * It answers rather than throws because the cases below ask it in both
 * directions — once to know a command has really started, and once to prove a
 * cancelled one never finished. An absence is a result there, not a failure.
 * @param {any} ops - Operations already scoped to the workspace to look in.
 * @param {string} path - Path relative to that workspace's root.
 * @param {number} timeoutMs - How long to keep looking.
 * @returns {Promise<boolean>} Whether it turned up inside the window.
 */
export async function fileTurnsUp(ops, path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if ((await ops.stat({ path })).exists) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return false;
}

/**
 * The directory, named the way a command can use it: relative to the tree the
 * operations it is handed to are pinned to.
 *
 * A workspace root is absolute, and an absolute path on Windows is `C:\src\app`
 * — which a POSIX shell reads as one word with every separator escaped away, so
 * the directory lands somewhere nobody asked for and the provision looks to
 * have built nothing. The shipped providers name everything relative to where
 * the command already stands, and the fixture has to do the same or it is
 * testing a provider no real one resembles.
 * @param {string} root - The tree the operations are pinned to.
 * @param {string} dir - Where the workspace is going, absolutely.
 * @returns {string} A path a command can use.
 */
function commandPath(root, dir) {
  return (root && relativePath(root, dir)) || dir;
}

/**
 * Where the base workspace's operations are standing, as the session knows it.
 * @param {any} ctx - A hook's context.
 * @returns {string} The root, or '' when the session cannot say.
 */
function rootOf(ctx) {
  return ctx?.session?.workspaceRoot?.(ctx?.baseWorkspaceId ?? '') ?? '';
}

/**
 * A workspace provider that makes a real directory, in real steps.
 *
 * It is deliberately not the smallest thing that would satisfy the registry.
 * The interesting properties of the class are all about a provision that stops
 * half way — so this one takes two irreversible steps, checkpoints before each,
 * and pushes a compensation after each. Its two undo paths are written
 * separately, from the closures and from `meta`, precisely so a test can catch
 * them disagreeing; a fixture that shared one implementation between them could
 * not fail the test it exists for.
 */
export class FixtureProvider extends WorkspaceProvider {
  static MANIFEST = {
    id: 'fixture-workspace-provider',
    name: 'Somewhere else',
    version: '1.0.0',
    description: 'Makes a directory, in steps, so a test can interrupt it',
    recommendations: {
      bestFor: 'a test that wants to read its own advice back',
      avoidFor: 'anything anybody is relying on',
      notes: ['The directory is the whole of it; nothing else is made.']
    }
  };

  /**
   * @param {any} values - dir, and optionally a stallMs to be interrupted during
   * @returns {string} Where it is going
   */
  plannedRoot(values) {
    return values.dir;
  }

  /**
   * Two fields, which is enough to ask the two questions a host has of a form —
   * what does it say, and may it be submitted — and to ask for a provision slow
   * enough to be interrupted from a view that has only the form to drive it.
   * @param {HTMLElement} container - The panel section's body
   */
  renderSetup(container) {
    const field = document.createElement('input');
    field.type = 'text';
    field.id = 'fixture-dir';
    field.value = '';
    container.appendChild(field);
    this._field = field;

    const stall = document.createElement('input');
    stall.type = 'text';
    stall.id = 'fixture-stall';
    stall.value = '';
    container.appendChild(stall);
    this._stall = stall;
  }

  /**
   * @returns {any} What the form says, and whether Create may be pressed
   */
  getSetupValue() {
    const dir = this._field?.value ?? '';
    const stallMs = Number(this._stall?.value ?? '') || 0;
    if (!dir) return { valid: false, values: {}, invalidFieldId: 'fixture-dir' };
    return { valid: true, values: stallMs ? { dir, stallMs } : { dir } };
  }

  /**
   * Make a directory, then put a file in it, checkpointing before each and
   * pushing the inverse after each.
   * @param {any} values - dir, stallMs, and whether to forget a compensation
   * @param {any} ctx - The host's provisioning context
   * @returns {Promise<any>} The workspace it built
   */
  async provision(values, ctx) {
    const { dir, stallMs = 0, dirStallMs = 0 } = values;
    const here = commandPath(rootOf(ctx), dir);

    // Both records of how to undo this step go in BEFORE the step, so there is
    // no instant at which the directory exists and nothing knows how to remove
    // it. `rm -rf` rather than `rm -r` for the same reason from the other side:
    // the compensation will sometimes run for a step that never happened.
    ctx.progress('Making the directory', dir);
    await ctx.checkpoint({ dir });
    ctx.rollback.push(async () => {
      // A step that cannot be taken back: a tree something else has open, a
      // permission that has gone, a disk that is full. The stack must go on
      // down past it, and somebody has to be told what survived.
      if (values.rollbackFailsWith) throw new Error(values.rollbackFailsWith);
      await ctx.ops.shell({ command: `rm -rf "${here}"` }, ctx.signal);
    });
    // `dirStallMs` keeps the command running after it has made the directory,
    // so a cancel can land INSIDE this step rather than between steps. That is
    // the only way to reach the window an inverse pushed after its step falls
    // through — the abort rejects the operation, and the line that would have
    // recorded the undo is never reached.
    const linger = dirStallMs ? `; sleep ${dirStallMs / 1000}` : '';
    await ctx.ops.shell({ command: `mkdir -p "${here}"${linger}` }, ctx.signal);

    if (stallMs) {
      // The slow step every real provider has — a dependency install, a clone —
      // and the one a cancel usually has to land in the middle of.
      ctx.progress('Waiting about', `${stallMs}ms`);
      await ctx.ops.shell({ command: `sleep ${stallMs / 1000}` }, ctx.signal);
    }

    // The other way a provision ends without a workspace: the branch already
    // exists, the host is down, the disk is full. It throws here rather than at
    // the top so that there is something built for the failure to unwind.
    if (values.failWith) throw new Error(values.failWith);

    ctx.progress('Writing the marker');
    await ctx.checkpoint({ marked: true });
    ctx.rollback.push(async () => {
      await ctx.ops.shell({ command: `rm -f "${here}/made-here.txt"` }, ctx.signal);
    });
    await ctx.ops.shell({ command: `echo yes > "${here}/made-here.txt"` }, ctx.signal);

    return { workspace: { root: dir, label: 'made by the fixture', meta: { dir, marked: true } } };
  }

  /**
   * What the case under way wants `status()` to add to the base class's answer.
   *
   * Static and explicit for the same reason `report` is: status is asked of this
   * provider by sweeps belonging to cases about something else, and a fixture
   * that volunteered a dirty tree would put a warning in front of them.
   * @type {any}
   */
  static reported = null;

  /**
   * What the case under way wants this provider to fall over with when asked
   * how its tree is doing. A provider that throws has said nothing about the
   * tree, which is a different answer from "clean" and has to be tested as one.
   * @type {string|null}
   */
  static statusError = null;

  /**
   * @param {any} workspace - The row to report on
   * @param {any} ctx - Operations pinned to it, and a signal
   * @returns {Promise<any>} The base answer, with whatever the case added
   */
  async status(workspace, ctx) {
    if (FixtureProvider.statusError) throw new Error(FixtureProvider.statusError);
    const answer = await super.status(workspace, ctx);
    return FixtureProvider.reported ? { ...answer, ...FixtureProvider.reported } : answer;
  }

  /**
   * What the case under way wants this provider to say it is holding.
   *
   * Static and explicit like the other two, and for a sharper reason: the move
   * dialog asks this of the tree a conversation is leaving, so a fixture that
   * volunteered a list would put an offer to copy files in front of a case that
   * was only moving a conversation. `null` is the base class's answer — no
   * opinion, which sends the host to git.
   * @type {any}
   */
  static holds = null;

  /**
   * @param {any} workspace - The row to account for
   * @param {any} ctx - Operations pinned to it, and a signal
   * @returns {Promise<any>} What the case set, or no opinion at all
   */
  async heldWork(workspace, ctx) {
    void workspace;
    void ctx;
    return FixtureProvider.holds;
  }

  /**
   * Extra directories the case under way wants this provider to name as holding
   * instructions that count where its workspaces are.
   *
   * Static and explicit like the three above, and for the widest reason of any
   * of them: seeding happens on every bind, so a fixture that volunteered a
   * directory of its own accord would put an extra context item into every case
   * that makes a conversation.
   * @type {string[]}
   */
  static extraRoots = [];

  /**
   * @param {any} workspace - The row about to be seeded for
   * @param {any} ctx - Operations pinned to it, and a signal
   * @returns {string[]} What the case set, or nothing to add
   */
  instructionRoots(workspace, ctx) {
    void workspace;
    void ctx;
    return FixtureProvider.extraRoots;
  }

  /**
   * Whatever the case under way wants reconcile to report.
   *
   * Static and deliberately explicit: reconcile is asked about this provider's
   * rows in cases that are about something else entirely, and a fixture that
   * reported an orphan of its own accord would close rows underneath them.
   * @type {any}
   */
  static report = null;

  /**
   * @param {any[]} workspaces - This provider's rows
   * @param {any} ctx - Operations rooted at the project
   * @returns {Promise<any>} What the case set, or a clean bill of health
   */
  async reconcile(workspaces, ctx) {
    void ctx;
    return FixtureProvider.report ?? {
      orphanedWorkspaces: [],
      orphanedArtifacts: [],
      confirmed: workspaces.map(workspace => workspace.id)
    };
  }

  /**
   * Three endings: one that finishes with the workspace, and two that only
   * report, so a case about what the chip ASKS never has to let the fixture
   * tear a directory down to find out. Plus one action that is not an ending at
   * all — `note` keeps the workspace in use, which is what the host groups rows
   * by, so a fixture with none could not show the grouping working.
   * @param {any} workspace - The row being finished with
   * @returns {any[]} The ways to end it
   */
  finishOptions(workspace) {
    void workspace;
    return [
      {
        id: 'done',
        label: 'Done with it',
        danger: true,
        description: 'Removes the directory.'
      },
      {
        id: 'note',
        label: 'Leave a note',
        keepsWorkspace: true,
        description: 'Writes a line into the workspace and leaves it in use.',
        prompt: {
          label: 'Note',
          placeholder: 'One line',
          hint: 'It is written into the workspace as it stands.'
        }
      },
      {
        id: 'leave',
        label: 'Leave it be',
        description: 'Nothing changes on disk.'
      },
      ...(FixtureProvider.discardDescription
        ? [{
          id: 'discard',
          label: 'Discard it',
          danger: true,
          description: FixtureProvider.discardDescription
        }]
        : [])
    ];
  }

  /**
   * What the case under way wants a discard to say it would cost.
   *
   * Static and inert by default like the rest: the banner's Undo looks for a
   * `discard` ending to borrow a sentence from, and the three endings above
   * deliberately include none — a provider that offers no discard is its own
   * case, and the fixture has to be able to be both.
   * @type {string|null}
   */
  static discardDescription = null;

  /**
   * What the host last asked this provider to do, and what it collected for it.
   * @type {any}
   */
  static lastFinish = null;

  /**
   * How many times it has been asked, for the cases about a second press.
   * @type {number}
   */
  static finishCalls = 0;

  /**
   * What the case under way wants an ending to fall over with.
   *
   * The failure a real provider has no say in: `ctx.ops.shell` REJECTS when the
   * command could not be run at all — a root that has gone, a backend that
   * answered with an error, the deadline — as opposed to resolving `success:
   * false` for a command that ran and failed. Both are ordinary, and only one of
   * them used to reach the user.
   * @type {string|null}
   */
  static finishError = null;

  /**
   * How long an ending should take, so a case can press the button twice while
   * the first press is still in flight.
   * @type {number}
   */
  static finishDelayMs = 0;

  /**
   * @param {any} workspace - The row being finished with
   * @param {string} actionId - Which ending
   * @param {any} ctx - Operations pinned to the workspace, and a signal
   * @returns {Promise<any>} Whether it is finished with
   */
  async finish(workspace, actionId, ctx) {
    FixtureProvider.lastFinish = { actionId, input: ctx?.input };
    FixtureProvider.finishCalls++;
    if (FixtureProvider.finishDelayMs) {
      await new Promise(resolve => setTimeout(resolve, FixtureProvider.finishDelayMs));
    }
    if (FixtureProvider.finishError) throw new Error(FixtureProvider.finishError);
    if (actionId === 'note') return { done: false, message: `noted: ${ctx?.input?.message ?? ''}` };
    if (actionId === 'leave') return { done: false, message: 'left it be' };
    if (actionId !== 'done') return { done: false, message: `no such ending: ${actionId}` };
    const dir = workspace.meta?.dir;
    // Through the base operations, because this provider's own are pinned to
    // the very directory being removed: a command that ran there would be
    // standing on the ground it is taking away, which Windows refuses outright.
    const ops = ctx.baseOps ?? ctx.ops;
    await ops.shell({ command: `rm -rf "${commandPath(rootOf(ctx), dir)}"` }, ctx.signal);
    return { done: true, message: `removed ${dir}` };
  }

  /**
   * The same undo, reconstructed from `meta` alone — no closure survived.
   *
   * Written out separately from the compensations above rather than sharing an
   * implementation with them, because a provider whose two paths quietly drift
   * apart is the fault these tests exist to catch, and a fixture that cannot
   * drift cannot catch it.
   * @param {any} workspace - The half-built row
   * @param {any} ctx - Operations rooted at the project
   * @returns {Promise<any>} Whether anything is left
   */
  async cleanupPartial(workspace, ctx) {
    const dir = workspace.meta?.dir;
    if (!dir) return { removed: false, message: 'nothing was checkpointed' };
    // Against the project, because the sweep this runs in is rooted there
    // whatever the row was built from.
    const here = commandPath(ctx?.session?.projectPath ?? '', dir);
    // `-f` and `-rf` throughout: a checkpoint is written BEFORE the step it
    // describes, so `meta` routinely names a file that was never created.
    await ctx.ops.shell({ command: `rm -f "${here}/made-here.txt"` }, ctx.signal);
    await ctx.ops.shell({ command: `rm -rf "${here}"` }, ctx.signal);
    return { removed: true, message: `removed ${dir}` };
  }
}

/**
 * Build a workspace the way the create dialog does: no conversation in the
 * question, and the row put on this window's table by hand because the
 * broadcast that would bring it has not arrived yet.
 * @param {any} session - The session it belongs to.
 * @param {string} providerId - Whose form would have been filled in.
 * @param {any} values - What that form would have said.
 * @param {object} [options] - Anything else `provisionWorkspace` takes.
 * @returns {Promise<any>} The provision outcome: the row, and its undo.
 */
export async function buildWorkspace(session, providerId, values, options = {}) {
  const outcome = await provisionWorkspace({ session, providerId, values, ...options });
  if (session && !session.workspaces?.some?.((/** @type {any} */ row) => row.id === outcome.workspace.id)) {
    session.workspaces = [...(session.workspaces ?? []), outcome.workspace];
  }
  return outcome;
}

/**
 * Build a workspace and move a conversation into it — the two acts the setup
 * panel used to perform as one, now done the way the app does them: the place
 * is made first and something is moved into it afterwards.
 * @param {any} session - The session it belongs to.
 * @param {any} conversation - The conversation to bind.
 * @param {string} providerId - Whose form would have been filled in.
 * @param {any} values - What that form would have said.
 * @returns {Promise<any>} The workspace it built and bound to.
 */
export async function buildWorkspaceFor(session, conversation, providerId, values) {
  const outcome = await buildWorkspace(session, providerId, values);
  await rebindConversation(conversation, outcome.workspace.id);
  return outcome.workspace;
}

/**
 * Provision until something interrupts it, the way a restart interrupts one:
 * the row survives, whatever reached disk survives, and the closures do not.
 *
 * It drives the provider directly rather than through the host, because the
 * host's whole job is to unwind — and the state this exists to produce is the
 * one nothing got to unwind. `rollback.push` therefore drops what it is given,
 * which is precisely what a dead tab does with it.
 * @param {any} session - The test session.
 * @param {any} values - Passed to the provider's provision().
 * @param {(() => Promise<void>)} [interruptAfter] - Awaited, then the signal is aborted.
 * @returns {Promise<any>} The row as the server holds it, mid-provision.
 */
export async function abandonProvision(session, values, interruptAfter) {
  const provider = workspaceProviderRegistry.createProvider(FixtureProvider.MANIFEST.id, session);
  if (!provider) throw new Error('the fixture provider is not registered');
  const row = await registerWorkspace({
    kind: 'local',
    root: values.dir,
    providerId: FixtureProvider.MANIFEST.id,
    state: 'provisioning'
  });
  const controller = new AbortController();
  const settled = provider.provision(values, {
    session,
    ops: createBoundOps(() => ({})),
    baseWorkspaceId: '',
    signal: controller.signal,
    rollback: { push: () => {} },
    checkpoint: async (metaPatch) => { await patchWorkspace(row.id, { meta: metaPatch }); },
    progress: () => {}
  }).then(() => {}, () => {});
  if (interruptAfter) {
    await interruptAfter();
    controller.abort();
  }
  await settled;
  return (await listWorkspaces()).find(ws => ws.id === row.id);
}

/**
 * Build the system prompt a turn in this conversation would send.
 * @param {any} session - The test session.
 * @param {any} conversation - The conversation whose turn it would be.
 * @returns {string} The identity and environment block.
 */
export function promptFor(session, conversation) {
  const SystemPrompt = /** @type {any} */ (contextItemRegistry.get('system-prompt'));
  if (!SystemPrompt) throw new Error('the system-prompt item is not registered');
  const item = new SystemPrompt({
    id: 'SYSTEM_1',
    session,
    conversation,
    messageThread: conversation.rootMessageThread
  });
  return item.buildPrompt();
}

/**
 * The top of a column's item list, as `conversation-area` builds it: the
 * normal-order inner container with the footer the item diff anchors on.
 * @param {any} conversation - The conversation the column shows.
 * @param {object} [state] - Column state the banner asks about (`_threadYMap`).
 * @returns {{area: any, list: HTMLElement}} A stub column and its list.
 */
export function columnFor(conversation, state = {}) {
  const list = document.createElement('div');
  list.appendChild(document.createElement('conversation-footer'));
  const area = {
    _conversation: conversation,
    _messageThread: conversation?.rootMessageThread,
    _threadYMap: null,
    _isGroupColumn: false,
    ...state
  };
  return { area, list };
}

/**
 * Render a column's workspace banner and hand back what it put there.
 * @param {any} conversation - The conversation the column shows.
 * @param {object} [state] - Column state, as for {@link columnFor}.
 * @returns {HTMLElement|null} The banner, or null when the column shows none.
 */
export function bannerFor(conversation, state = {}) {
  const { area, list } = columnFor(conversation, state);
  ensureWorkspaceBanner(area, list);
  return /** @type {HTMLElement|null} */ (list.querySelector('.conversation-workspace-banner'));
}

/**
 * Wait for the worker's last word on the undo stack to reach the document.
 *
 * One ping makes the worker close its undo-capture window and flush its Yjs
 * batcher — the undo state is emitted before the ack — and flushing pending
 * inbound updates applies that frame synchronously, so `canUndo()` reads
 * current state on the next line rather than measuring a sleep.
 * @param {any} conversation - The conversation whose stack is in question.
 * @returns {Promise<void>} When the document is current.
 */
export async function syncUndoState(conversation) {
  await pingWorker(conversation.id);
  conversation._doc.flushPendingUpdates();
}

/**
 * A conversation's seeded file item for a path, as the document holds it now.
 *
 * Item instances are transient wrappers around CRDT data — fresh objects on
 * every read — so a case that wants to know what the next turn would see has to
 * ask again rather than hold one from before.
 * @param {any} conversation - The conversation to look in.
 * @param {string} path - The path it was seeded for.
 * @returns {any} The item, or undefined.
 */
export function seededFile(conversation, path) {
  return conversation.rootMessageThread.contextItems.find(
    (/** @type {any} */ item) => item.type === 'file-content' && item.data.path === path);
}

/**
 * Count the calls the seeding pass makes, for the "exactly once" cases.
 * @param {any} session - The test session.
 * @returns {{calls: () => number, restore: () => void}} The counter and its undo.
 */
export function countSeeds(session) {
  const original = session.seedConversationAutoItems.bind(session);
  let calls = 0;
  session.seedConversationAutoItems = async (/** @type {any[]} */ ...args) => {
    calls++;
    return original(...args);
  };
  return {
    calls: () => calls,
    restore: () => { session.seedConversationAutoItems = original; }
  };
}

/**
 * Put the fixture provider in the registry, unless it is already there.
 *
 * A lane is one JS realm running suite after suite and nothing resets this
 * registry between them, so a registration outlives the suite that made it —
 * and `registerClass` refuses an id that is taken rather than replacing it.
 * Asking only when the id is free therefore says "there is a fixture provider
 * here now", which is what every caller wants, whichever suite ran first.
 * @returns {void}
 */
export function ensureFixtureProvider() {
  if (workspaceProviderRegistry.get(FixtureProvider.MANIFEST.id)) return;
  workspaceProviderRegistry.registerClass(FixtureProvider, { extensionId: 'test', modulePath: '(test)' });
}

/**
 * The preamble and teardown every conversation-workspace suite shares.
 *
 * One file is one suite, and the binding has far more about it than one suite
 * can carry inside its budget, so the cases are spread over several files.
 * What each of them needs first is the same: a session, the project's path,
 * and a workspace already on the server's table before the session loads — so
 * that the load has a table to bring back and the payload can be wrong in a
 * way a case notices. The file-editing default is the one seed that leaves a
 * visible mark, so it is switched on here and put back at the end.
 *
 * The fixture provider is put in the registry here for the same reason the
 * workspace row is made here: a lane runs these suites in whatever order the
 * runner picks, and every one of them provisions, finishes or moves through
 * the registry. Registering only when the id is free leaves the case that
 * proves `registerClass` registers free to prove it from a reset registry.
 * @param {string} label - The suite, for the release audit trail.
 * @param {(kit: any) => Promise<void>} defineCases - Runs the suite's cases.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runWorkspaceSuite(label, defineCases) {
  await initializeRegistries();
  ensureFixtureProvider();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} caseLabel - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
   */
  const run = async (caseLabel, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${caseLabel}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const projectPath = (await fetchJson(apiUrl('/session'))).projectPath;
  const registered = await fetchJson(apiUrl('/session/workspaces'), {
    method: 'POST',
    body: { root: projectPath, label: 'a tree of this suite\'s own', state: 'ready' }
  });
  const registeredId = registered.workspace.id;

  /** @type {any} */
  let session = null;
  /** @type {any} */
  let fileEditingWas;
  /** @type {string[]} */
  const created = [];
  /** @param {any} conversation - The conversation to release at the end. */
  const release = (conversation) => { if (conversation) created.push(conversation.id); };

  try {
    session = await createTestSession();
    fileEditingWas = session.getMetadata(DEFAULT_FILE_EDITING_META_KEY);
    session.applySessionMetadataPatch({ [DEFAULT_FILE_EDITING_META_KEY]: true });
    await defineCases({ run, session, projectPath, registeredId, release });
  } finally {
    if (session) {
      session.applySessionMetadataPatch({ [DEFAULT_FILE_EDITING_META_KEY]: fileEditingWas ?? null });
      for (const id of created) {
        await releaseTestConversation(session, id, label);
      }
    }
    await fetchJson(apiUrl(`/session/workspaces/${registeredId}`), { method: 'DELETE', fallback: null });
  }

  return { passed, failed, errors };
}
