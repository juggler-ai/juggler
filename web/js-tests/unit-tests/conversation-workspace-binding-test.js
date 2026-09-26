//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Working in the tree a conversation is bound to.
 *
 * Once a binding exists, everything the conversation does has to land in the
 * tree it names rather than in the project: the tools it runs, the commands it
 * streams, the files its seeds read, the paths it is implicitly allowed, and
 * the environment block its turn carries. A binding it cannot honour must be
 * refused out loud rather than quietly fall back to the project, which is the
 * one failure that would look like success.
 * @module unit-tests/conversation-workspace-binding-test
 */

import { waitFor, assert } from '../utilities/test-helpers.js';
import { budgetFor } from '../utilities/test-deadline.js';
import { fetchJson } from '../../js/services/http.js';
import { shellExecuteStreaming } from '../../js/services/shell-streaming.js';
import { writeFileOp } from '../../js/services/ops-api.js';
import { createBoundOps } from '../../sdk/ops.js';
import {
  registerWorkspace,
  patchWorkspace,
  unregisterWorkspace,
  isWorkspaceUsable
} from '../../js/services/workspaces.js';
import { rebindConversation } from '../../js/services/workspace-rebinding.js';
import {
  isShellCommandPermitted,
  isShellCommandCatastrophic
} from '../../extensions/juggler-core/context-items/execute/command-permission.js';
import { setupRows } from '../../js/services/workspace-places.js';
import { ensureWorkspaceBanner, removeAllElements } from '../../js/components/conversation-area-rendering.js';
import { followSession, setGitWorkspace } from '../../js/services/git-workspace.js';
import gitStatusCache from '../../js/services/git-status-cache.js';
import {
  runWorkspaceSuite,
  bannerFor,
  columnFor,
  fileTurnsUp,
  makeConversation,
  promptFor,
  queryIn,
  readIn,
  seededFile,
  workspaceRow
} from '../utilities/conversation-workspace-helpers.js';

/**
 * This suite makes and removes directories directly in the shared fixture root,
 * which a sibling lane walking the project reads as they come and go, so no
 * other lane may be in flight while it runs.
 * @type {boolean}
 */
export const needsExclusiveRun = true;

/**
 * Run the conversation-workspace-binding tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  return runWorkspaceSuite('conversation-workspace-binding-test', async ({ run, session, projectPath, registeredId, release }) => {
    await run('the load brings the session the workspace table', async () => {
      const row = session.workspaces.find((/** @type {any} */ w) => w.id === registeredId);
      assert(row,
        `the loaded session holds the workspace the server was told about, got ${JSON.stringify(session.workspaces)}`);
      assert(row.root === projectPath,
        `carrying where it is, got ${JSON.stringify(row.root)}`);
      assert(row.state === 'ready' && row.available === true,
        `and whether it can be worked in, got ${JSON.stringify(row)}`);
    });

    await run('a workspaces-changed broadcast replaces the table', async () => {
      // The table is session state like the pinboard: the server republishes the
      // whole thing after every edit, which is what carries a provisioning →
      // ready flip to a window that is only watching.
      const ws = /** @type {any} */ (session._services.wsService);
      const saved = session.workspaces;
      try {
        ws.emit('workspaces-changed', { workspaces: [workspaceRow('ws_broadcast', '/tmp/broadcast')] });
        assert(session.workspaces.length === 1 && session.workspaces[0].id === 'ws_broadcast',
          `the broadcast's table is the table, got ${JSON.stringify(session.workspaces)}`);

        ws.emit('workspaces-changed', { workspaces: [] });
        assert(session.workspaces.length === 0,
          `including when it is empty — the last workspace being unregistered is an edit like any other, got ${JSON.stringify(session.workspaces)}`);
      } finally {
        session.workspaces = saved;
      }
    });

    await run('an unusable binding refuses rather than falling back to the project', async () => {
      // The four refusals the server makes in WorkspaceLookup.Usable. They have
      // to agree: a stale binding that quietly resolved to the project root
      // would edit the wrong tree and look exactly like working.
      const saved = session.workspaces;
      session.workspaces = [
        workspaceRow('ws_ready', '/tmp/ready'),
        workspaceRow('ws_building', '/tmp/building', { state: 'provisioning', available: false }),
        workspaceRow('ws_done', '/tmp/done', { state: 'closed' }),
        workspaceRow('ws_gone', '/tmp/gone', { available: false })
      ];
      try {
        assert(session.workspaceRoot('') === session.projectPath,
          `naming no workspace is the project, as it was before workspaces existed, got ${JSON.stringify(session.workspaceRoot(''))}`);
        assert(session.workspaceRoot('ws_ready') === '/tmp/ready',
          `a ready workspace is its root, got ${JSON.stringify(session.workspaceRoot('ws_ready'))}`);
        assert(session.workspaceRoot('ws_building') === null,
          `one still being built is nowhere to work yet, got ${JSON.stringify(session.workspaceRoot('ws_building'))}`);
        assert(session.workspaceRoot('ws_done') === null,
          `nor is one somebody finished with, got ${JSON.stringify(session.workspaceRoot('ws_done'))}`);
        assert(session.workspaceRoot('ws_gone') === null,
          `nor one whose root has gone, got ${JSON.stringify(session.workspaceRoot('ws_gone'))}`);
        assert(session.workspaceRoot('ws_never_registered') === null,
          `and an id the session never heard of is an error, not the project, got ${JSON.stringify(session.workspaceRoot('ws_never_registered'))}`);
        assert(session.getWorkspace('') === null,
          'the default workspace has no row to find — a caller that wants its root already has the project path');

        // And the three surfaces that ask this question agree, row for row.
        // They used to decide it separately and one of them had drifted: the
        // picker read the state and not the root, so a workspace whose tree
        // had been deleted went on being offered as somewhere to start work.
        const offered = new Set(setupRows(session)
          .filter((/** @type {any} */ row) => row.kind === 'workspace')
          .map((/** @type {any} */ row) => row.id));
        for (const row of session.workspaces) {
          const usable = isWorkspaceUsable(row);
          assert(usable === (session.workspaceRoot(row.id) !== null),
            `${row.id}: the binding resolver disagrees with the predicate (usable=${usable})`);
          assert(usable === offered.has(row.id),
            `${row.id}: the picker disagrees with the predicate (usable=${usable}, offered=${offered.has(row.id)})`);
        }
        assert(offered.size === 1 && offered.has('ws_ready'),
          `exactly the one usable row is offered, got ${JSON.stringify([...offered])}`);
      } finally {
        session.workspaces = saved;
      }
    });

    await run('a conversation works in the tree its binding names', async () => {
      const saved = session.workspaces;
      session.workspaces = [workspaceRow('ws_tree', '/tmp/tree')];
      try {
        const bound = await makeConversation(session, 'bound-to-a-tree', { workspaceId: 'ws_tree' });
        release(bound);
        assert(bound.workspaceRoot === '/tmp/tree',
          `a bound conversation resolves its own root, got ${JSON.stringify(bound.workspaceRoot)}`);

        bound.workspaceId = '';
        assert(bound.workspaceRoot === session.projectPath,
          `and one bound to nothing works in the project, got ${JSON.stringify(bound.workspaceRoot)}`);
      } finally {
        session.workspaces = saved;
      }
    });

    await run('a tool runs in the tree its conversation is bound to', async () => {
      // A real second tree, registered with the real server: `src/` is in the
      // fixture and `greeter.js` exists only inside it, so a read of
      // `greeter.js` that resolves anywhere else finds nothing. That is the
      // point of the case — an op that quietly ran in the project would be
      // indistinguishable from a working one if the file existed in both.
      const made = await registerWorkspace({
        root: `${projectPath}/src`, label: 'src, as a tree of its own', state: 'ready'
      });
      const id = made.id;
      // The row the server just made, put on the client's table by hand: a unit
      // test's wsService is a mock, so no `workspaces-changed` broadcast arrives
      // here. What that transport does is pinned by the two cases above; this
      // one is about where the operation lands.
      const saved = session.workspaces;
      session.workspaces = [...saved, made];
      try {
        const bound = await makeConversation(session, 'reads-in-its-tree', { workspaceId: id });
        release(bound);
        const inTree = await readIn(session, bound, 'greeter.js');
        assert(inTree.exists !== false,
          `a bound conversation's read resolves against its workspace, got ${JSON.stringify(inTree)}`);
        assert(typeof inTree.content === 'string' && inTree.content.length > 0,
          `and comes back with the file's bytes, got ${JSON.stringify(inTree.content)}`);

        const unbound = await makeConversation(session, 'reads-in-the-project');
        release(unbound);
        const inProject = await readIn(session, unbound, 'greeter.js');
        assert(inProject.exists === false,
          `while the project holds no such file, which is what makes the case above mean anything, got ${JSON.stringify(inProject)}`);
      } finally {
        session.workspaces = saved;
        // Swallowed rather than thrown from a finally, where it would replace
        // whichever assertion actually failed with a tidying-up error.
        await unregisterWorkspace(id).catch(() => {});
      }
    });

    await run('a streaming command runs in the tree too, and refuses a binding it cannot honour', async () => {
      // The bash tool's output streams, so it rides the WebSocket rather than
      // /api/ops/call — a second transport, which has to confine a command the
      // same way the first one does or the most destructive tool is the one
      // running in the wrong place.
      const made = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: { root: `${projectPath}/src`, label: 'src, for a command', state: 'ready' }
      });
      const id = made.workspace.id;
      const saved = session.workspaces;
      session.workspaces = [...saved, made.workspace];
      try {
        const bound = await makeConversation(session, 'runs-in-its-tree', { workspaceId: id });
        release(bound);

        const marker = `ws-shell-${Math.random().toString(36).slice(2, 8)}.txt`;
        const ran = await shellExecuteStreaming(
          { command: `echo made-here > ${marker}` }, () => {}, undefined, id);
        assert(ran.success, `the command ran, got ${JSON.stringify(ran)}`);

        const landed = await readIn(session, bound, marker);
        assert(landed.exists !== false,
          `and what it wrote is in the conversation's tree, got ${JSON.stringify(landed)}`);

        const unbound = await makeConversation(session, 'looks-in-the-project');
        release(unbound);
        const elsewhere = await readIn(session, unbound, marker);
        assert(elsewhere.exists === false,
          `and nowhere else, got ${JSON.stringify(elsewhere)}`);

        const refused = await shellExecuteStreaming(
          { command: 'echo this must not run' }, () => {}, undefined, 'ws_never_registered');
        assert(refused.success === false && refused.error,
          `an id the session never heard of is refused rather than run in the project, got ${JSON.stringify(refused)}`);
      } finally {
        session.workspaces = saved;
        await fetchJson(`/api/session/workspaces/${id}`, { method: 'DELETE', fallback: null });
      }
    });

    await run('a command cancelled mid-flight is killed, not merely abandoned', async () => {
      // Everything a provider does while a workspace is being built runs through
      // this facade, and Cancel is only honest if the command actually dies: a
      // fifteen-minute `npm ci` that keeps going after the panel says it stopped
      // is the one outcome the cancel story cannot survive. The server kills the
      // process group when a request context is cancelled, and the facade's job
      // is to carry the caller's signal that far.
      const made = await registerWorkspace({
        root: `${projectPath}/src`, label: 'src, for a cancelled command', state: 'ready'
      });
      const id = made.id;
      const saved = session.workspaces;
      session.workspaces = [...saved, made];
      const ops = createBoundOps(() => ({ workspaceId: id }));
      const tag = Math.random().toString(36).slice(2, 8);
      const started = `ws-cancel-started-${tag}.txt`;
      const release = `ws-cancel-release-${tag}.txt`;
      const finished = `ws-cancel-finished-${tag}.txt`;
      // The command waits for a file this case writes, rather than for a clock.
      // A command that slept between its two markers could be beaten by a slow
      // enough machine — the abort landing after it had already finished, and
      // the marker it duly wrote reading as a cancel that did not bite — and
      // the answer to that is not a longer sleep, which only moves the machine
      // that loses. Nothing here can write the second marker until this case
      // releases it, and it is released only after the abort has settled. So a
      // surviving command writes that marker however slow the machine is, and a
      // killed one cannot write it however fast.
      try {
        const controller = new AbortController();
        const running = ops.shell(
          { command: `echo yes > ${started}; while [ ! -e ${release} ]; do sleep 0.1; done; echo yes > ${finished}` },
          controller.signal
        );
        // Collected rather than assigned to a local: an assignment made inside
        // the rejection handler is invisible to the type checker, which then
        // reads every test of it as comparing null against null.
        /** @type {any[]} */
        const rejections = [];
        const settled = running.then(() => {}, (error) => { rejections.push(error); });

        // Abort only once the command has demonstrably begun. Aborting before
        // there is a process to kill leaves the second marker missing for a
        // reason that has nothing to do with cancelling anything, which is a
        // pass this case must not be able to score.
        assert(await fileTurnsUp(ops, started, budgetFor(5000)),
          'the command never started, so there was nothing for the abort to prove');
        controller.abort();
        await settled;

        assert(rejections.length === 1,
          `aborting rejects the operation rather than resolving it, got ${rejections.length} rejections`);
        assert(/abort/i.test(String(rejections[0]?.name ?? rejections[0])),
          `and rejects with the caller's abort rather than some later failure, got ${String(rejections[0])}`);

        // Everything that was going to stop has stopped by now. Anything still
        // in that loop is something the cancel did not reach, and this is what
        // lets it say so.
        await ops.writeFile({ path: release, content: 'go' });
        // A release that was never written would hold the second marker back on
        // its own, and this case would pass without a single process having
        // been killed. It is the same guard the first marker gets above.
        assert(await fileTurnsUp(ops, release, budgetFor(3000)),
          'the release the command waits on was never written, so nothing below is a test of anything');
        assert(!(await fileTurnsUp(ops, finished, budgetFor(3000))),
          'and the command died with it — the second marker means it ran to completion in a tree nobody was watching any more');
      } finally {
        session.workspaces = saved;
        await unregisterWorkspace(id).catch(() => {});
      }
    });

    await run('a checkpoint writes one key of a workspace without disturbing the rest', async () => {
      // How a provider records what it has built as it builds it. Each step
      // writes only its own key, because the alternative — restating the whole
      // of `meta` every time — is a read-modify-write across the wire that two
      // windows, or two steps, can lose each other's progress through.
      const made = await registerWorkspace({
        root: `${projectPath}/src`,
        label: 'src, being checkpointed',
        state: 'provisioning',
        meta: { dir: '/tmp/half-built' }
      });
      try {
        const afterFirst = await patchWorkspace(made.id, { meta: { treeAdded: true } });
        assert(afterFirst.meta?.dir === '/tmp/half-built' && afterFirst.meta?.treeAdded === true,
          `a checkpoint merges into meta rather than replacing it, got ${JSON.stringify(afterFirst.meta)}`);

        const afterSecond = await patchWorkspace(made.id, { meta: { dir: null }, state: 'ready' });
        assert(!('dir' in (afterSecond.meta ?? {})),
          `and a null value deletes its key, got ${JSON.stringify(afterSecond.meta)}`);
        assert(afterSecond.meta?.treeAdded === true,
          `while leaving the keys it said nothing about, got ${JSON.stringify(afterSecond.meta)}`);
        assert(afterSecond.state === 'ready' && afterSecond.label === 'src, being checkpointed',
          `and the fields outside meta patch the same way, got ${JSON.stringify(afterSecond)}`);
      } finally {
        await unregisterWorkspace(made.id).catch(() => {});
      }
    });


    await run('the seeds find and read the assistant files of the bound tree', async () => {
      // The whole reason a conversation is seeded late is that its AGENTS.md is
      // whichever tree it works in — so this is the case the deferral was for.
      // The probe and the read are asserted together because threading one
      // without the other is worse than threading neither: a conversation would
      // be seeded with the name of the workspace's file and the contents of the
      // project's.
      const made = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: { root: `${projectPath}/src`, label: 'src, with instructions of its own', state: 'ready' }
      });
      const id = made.workspace.id;
      const saved = session.workspaces;
      session.workspaces = [...saved, made.workspace];
      try {
        // `.cursorrules` is an assistant file the project root does not have, so
        // a probe that resolves anywhere but the workspace finds nothing to seed,
        // and a read that does comes back missing.
        const marker = `# only in the workspace ${Math.random().toString(36).slice(2, 8)}`;
        await writeFileOp({ path: '.cursorrules', content: marker }, undefined, undefined, id);

        const bound = await makeConversation(session, 'seeded-from-its-tree', { workspaceId: id });
        release(bound);
        const seeded = bound.rootMessageThread.contextItems
          .filter((/** @type {any} */ item) => item.type === 'file-content');
        const rules = seeded.find((/** @type {any} */ item) => item.data.path === '.cursorrules');
        assert(rules,
          `the conversation is seeded with its own tree's assistant files, got ${JSON.stringify(seeded.map((/** @type {any} */ i) => i.data.path))}`);

        const text = await rules.createContextText({});
        assert(text.includes(marker),
          `and the item it seeded reads them from that tree, got ${JSON.stringify(text)}`);
      } finally {
        session.workspaces = saved;
        await fetchJson(`/api/session/workspaces/${id}`, { method: 'DELETE', fallback: null });
      }
    });

    await run('a conversation moved to another tree reads that tree\'s instructions', async () => {
      // Deferring initialisation exists so that a conversation is never seeded
      // out of a tree it does not work in. A rebind puts it straight back into
      // that state: the binding moves, everything that travels by id follows it,
      // and the assistant file the model actually reads stays a frozen snapshot
      // of the tree it has left. The stranded-conversation banner performs this
      // move today, so this is not a hypothetical.
      const stamp = Math.random().toString(36).slice(2, 8);
      const from = `rebind-from-${stamp}`;
      const to = `rebind-to-${stamp}`;
      const fromMarker = `# instructions of the tree it started in ${stamp}`;
      const toMarker = `# instructions of the tree it moved to ${stamp}`;
      const onlyThere = `# a file the tree it left never had ${stamp}`;
      const project = createBoundOps(() => ({ workspaceId: '' }));
      await writeFileOp({ path: `${from}/AGENTS.md`, content: fromMarker });
      await writeFileOp({ path: `${to}/AGENTS.md`, content: toMarker });
      await writeFileOp({ path: `${to}/.cursorrules`, content: onlyThere });
      const madeFrom = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: { root: `${projectPath}/${from}`, label: 'where it started', state: 'ready' }
      });
      const madeTo = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: { root: `${projectPath}/${to}`, label: 'where it moved to', state: 'ready' }
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, madeFrom.workspace, madeTo.workspace];
      try {
        const moved = await makeConversation(session, 'moved-to-another-tree',
          { workspaceId: madeFrom.workspace.id });
        release(moved);
        const agents = seededFile(moved, 'AGENTS.md');
        assert(agents, 'the conversation is seeded with the assistant file of the tree it was made in');

        // A seeded item snapshots itself on its first request render, and that
        // snapshot reaches the document. Taking it here is what makes this a
        // case about a conversation carrying another tree's bytes rather than
        // one about a wrapper held too long.
        const before = await agents.createContextText({ forRequest: true });
        assert(before.includes(fromMarker),
          `and reads it while it works there, got ${JSON.stringify(before)}`);
        await waitFor(() => typeof seededFile(moved, 'AGENTS.md')?.data.content === 'string',
          { description: 'the snapshot to reach the document' });

        const result = await rebindConversation(moved, madeTo.workspace.id);
        assert(result.done, `the move is allowed, got ${JSON.stringify(result.message)}`);

        await waitFor(() => (seededFile(moved, 'AGENTS.md')?.data.content || '') !== before,
          { description: 'the move to take the snapshot again' });
        const after = await seededFile(moved, 'AGENTS.md').createContextText({});
        assert(after.includes(toMarker),
          `a conversation that moved reads the instructions of the tree it moved to, got ${JSON.stringify(after)}`);

        // The other half of the same question: instructions the new tree has and
        // the old one never did apply to this conversation now, and it has no
        // item for them at all until the move goes looking.
        const arrived = seededFile(moved, '.cursorrules');
        assert(arrived, 'and is seeded with the assistant files only the new tree has');
        assert((await arrived.createContextText({})).includes(onlyThere),
          'which it reads from that tree');
      } finally {
        session.workspaces = saved;
        await fetchJson(`/api/session/workspaces/${madeFrom.workspace.id}`, { method: 'DELETE', fallback: null });
        await fetchJson(`/api/session/workspaces/${madeTo.workspace.id}`, { method: 'DELETE', fallback: null });
        await project.copyTree({ to: '.', delete: [from, to] });
      }
    });

    await run('a file the new tree does not have keeps the bytes it was seeded with', async () => {
      // A file that is not there reads as "File does not exist", which is an
      // answer and not a snapshot. Freezing that over the real one would destroy
      // the only copy the conversation had of instructions its user may well
      // still want — so a snapshot is only ever replaced by another snapshot.
      const stamp = Math.random().toString(36).slice(2, 8);
      const had = `rebind-had-${stamp}`;
      const lacks = `rebind-lacks-${stamp}`;
      const marker = `# instructions only the tree it left ever had ${stamp}`;
      const project = createBoundOps(() => ({ workspaceId: '' }));
      await writeFileOp({ path: `${had}/AGENTS.md`, content: marker });
      // The destination has instructions of its own under a different name, and
      // none at all under this one. Its arrival is also the barrier this case
      // needs: an item can only be seeded after the move has finished refreshing
      // the items that were already there.
      await writeFileOp({ path: `${lacks}/.cursorrules`, content: `# different instructions ${stamp}` });
      const madeHad = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: { root: `${projectPath}/${had}`, label: 'a tree with instructions', state: 'ready' }
      });
      const madeLacks = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: { root: `${projectPath}/${lacks}`, label: 'a tree with none', state: 'ready' }
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, madeHad.workspace, madeLacks.workspace];
      try {
        const moved = await makeConversation(session, 'moved-somewhere-barer',
          { workspaceId: madeHad.workspace.id });
        release(moved);
        const agents = seededFile(moved, 'AGENTS.md');
        assert(agents, 'the conversation is seeded with the assistant file of the tree it was made in');
        await agents.createContextText({ forRequest: true });
        await waitFor(() => typeof seededFile(moved, 'AGENTS.md')?.data.content === 'string',
          { description: 'the snapshot to reach the document' });

        const result = await rebindConversation(moved, madeLacks.workspace.id);
        assert(result.done, `the move is allowed, got ${JSON.stringify(result.message)}`);
        await waitFor(() => seededFile(moved, '.cursorrules'),
          { description: 'the move to finish, which the new tree\'s own instructions arriving proves' });

        const after = await seededFile(moved, 'AGENTS.md').createContextText({});
        assert(after.includes(marker),
          `the snapshot survives a move to a tree without the file, got ${JSON.stringify(after)}`);
      } finally {
        session.workspaces = saved;
        await fetchJson(`/api/session/workspaces/${madeHad.workspace.id}`, { method: 'DELETE', fallback: null });
        await fetchJson(`/api/session/workspaces/${madeLacks.workspace.id}`, { method: 'DELETE', fallback: null });
        await project.copyTree({ to: '.', delete: [had, lacks] });
      }
    });

    await run('a conversation is not moved out from under a turn in flight', async () => {
      // Finishing with a workspace is refused mid-turn because removing a tree
      // under a running agent loses work. A move is the same hazard in different
      // clothes: the turn carries on, and its next operation lands in a tree it
      // never agreed to work in.
      const made = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: { root: `${projectPath}/src`, label: 'somewhere else entirely', state: 'ready' }
      });
      const id = made.workspace.id;
      const saved = session.workspaces;
      session.workspaces = [...saved, made.workspace];
      try {
        const busy = await makeConversation(session, 'busy-where-it-is');
        release(busy);
        Object.defineProperty(busy, 'isProcessing', { get: () => true, configurable: true });

        const refused = await rebindConversation(busy, id);
        assert(!refused.done, `a move is refused while a turn is running, got ${JSON.stringify(refused)}`);
        assert((busy.workspaceId || '') === '',
          `and the conversation is left where it was, got ${JSON.stringify(busy.workspaceId)}`);

        Object.defineProperty(busy, 'isProcessing', { get: () => false, configurable: true });
        const allowed = await rebindConversation(busy, id);
        assert(allowed.done && busy.workspaceId === id,
          `and goes once the turn is over, got ${JSON.stringify(allowed)}`);
      } finally {
        session.workspaces = saved;
        await fetchJson(`/api/session/workspaces/${id}`, { method: 'DELETE', fallback: null });
      }
    });

    await run('a sandboxed script is told the tree its conversation works in', async () => {
      // query_code's `projectRoot` is the one root the model is handed rather
      // than confined by: nothing downstream checks the paths a script builds
      // from it. Left at the session's project while the same script's `fs` had
      // followed the conversation, every path it computed would name a tree its
      // own reads could not reach.
      const made = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: { root: `${projectPath}/src`, label: 'src, for a script', state: 'ready' }
      });
      const id = made.workspace.id;
      const saved = session.workspaces;
      session.workspaces = [...saved, made.workspace];
      try {
        const bound = await makeConversation(session, 'queries-in-its-tree', { workspaceId: id });
        release(bound);
        // The binding is contracted POSIX-style, so compare it that way — on
        // Windows the session's own path is native and would never match.
        const posix = (/** @type {string} */ p) => p.replace(/\\/g, '/');
        const inTree = await queryIn(session, bound, 'return projectRoot;');
        assert(inTree.result === `${posix(projectPath)}/src`,
          `the script's root is the conversation's workspace, got ${JSON.stringify(inTree.result)}`);

        const unbound = await makeConversation(session, 'queries-in-the-project');
        release(unbound);
        const inProject = await queryIn(session, unbound, 'return projectRoot;');
        assert(inProject.result === posix(session.projectPath),
          `while a conversation bound to nothing still gets the project, as it always did, got ${JSON.stringify(inProject.result)}`);

        // A root is believed, so a binding that cannot be resolved refuses the
        // run outright. Falling back to the project would hand the model a tree
        // its own ops are refusing, which reads as the tool working.
        bound.workspaceId = 'ws_never_registered';
        let refusal = null;
        try {
          await queryIn(session, bound, 'return projectRoot;');
        } catch (e) {
          refusal = e instanceof Error ? e.message : String(e);
        }
        assert(refusal !== null,
          'a binding the session cannot honour refuses the run rather than substituting the project');
      } finally {
        session.workspaces = saved;
        await fetchJson(`/api/session/workspaces/${id}`, { method: 'DELETE', fallback: null });
      }
    });

    await run('a bound conversation is implicitly allowed its own tree, not the project', async () => {
      // The implicit allowed root is what decides whether a write needs asking
      // about. Left as the project, a worktree conversation would have to
      // approve every edit to the tree it was made to work in, while edits to
      // the main tree went through silently — exactly backwards.
      const saved = session.workspaces;
      session.workspaces = [workspaceRow('ws_perm', '/tmp/perm-tree')];
      try {
        const bound = await makeConversation(session, 'allowed-its-own-tree', { workspaceId: 'ws_perm' });
        release(bound);
        const allowed = bound.rootMessageThread.getAllowedPaths();
        assert(allowed[0] === '/tmp/perm-tree',
          `the conversation's own tree is the implicit root, got ${JSON.stringify(allowed)}`);
        assert(!allowed.includes(session.projectPath),
          `and the project is not implicitly writable from inside a worktree, got ${JSON.stringify(allowed)}`);

        bound.workspaceId = '';
        assert(bound.rootMessageThread.getAllowedPaths()[0] === session.projectPath,
          `while a conversation bound to nothing is allowed the project, as it always was, got ${JSON.stringify(bound.rootMessageThread.getAllowedPaths())}`);

        bound.workspaceId = 'ws_never_registered';
        assert(!bound.rootMessageThread.getAllowedPaths().includes(session.projectPath),
          `and a binding that cannot be honoured grants nothing, rather than quietly granting the project, got ${JSON.stringify(bound.rootMessageThread.getAllowedPaths())}`);
      } finally {
        session.workspaces = saved;
      }
    });

    await run('a bound conversation\'s shell commands are judged in the tree they run in', async () => {
      // The server runs a bound conversation's commands at the workspace root
      // (ops.scope.Root()), so that is the radius a destructive one has to be
      // measured by. Measured against the project instead, the guard protects a
      // tree the command will not touch and leaves the one it will wide open:
      // wiping the whole worktree reads as a routine subdirectory delete.
      const saved = session.workspaces;
      session.workspaces = [workspaceRow('ws_shell', '/tmp/shell-tree')];
      try {
        const bound = await makeConversation(session, 'commands-judged-where-they-run', { workspaceId: 'ws_shell' });
        release(bound);
        const messageThread = bound.rootMessageThread;

        assert(isShellCommandCatastrophic('rm -rf /tmp/shell-tree', { messageThread, session }),
          'deleting the worktree entire is catastrophic: it is the tree the conversation works in');
        assert(isShellCommandCatastrophic('rm -rf .', { messageThread, session }),
          'and so is deleting the directory the command runs in, named relatively');

        // The project keeps its protection too. It is the tree the conversation
        // came from and every other conversation is still working in, so moving
        // into a worktree must not make wiping it an ordinary delete. Named in
        // the session's own spelling — on Windows that is the native
        // backslash form the model is handed, which a POSIX shell reads as
        // escapes, so the floor has to recognise a path the tokenizer has
        // collapsed.
        assert(isShellCommandCatastrophic(`rm -rf ${session.projectPath}`, { messageThread, session }),
          'the project is still protected from a conversation working elsewhere');

        // A genuine subdirectory of the tree it works in stays auto-approvable:
        // the floor only ever adds a prompt, and `rm -rf ./build` is routine.
        assert(!isShellCommandCatastrophic('rm -rf ./build', { messageThread, session }),
          'a subdirectory delete inside the worktree is still ordinary');

        // Reads of the main tree do not start asking. The server widens a bound
        // request's read boundary with the project, so a command naming a path
        // in it is as approvable from the worktree as it was from the project.
        // Forward-slashed: a command carrying a native Windows path is held back
        // for the human whatever tree it names, since the POSIX shell that will
        // run it reads those separators as escapes.
        const posix = (/** @type {string} */ p) => p.replace(/\\/g, '/');
        assert(isShellCommandPermitted(`cat ${posix(session.projectPath)}/package.json`, { messageThread, session }),
          'a bound conversation can still read the tree it branched from without asking');
      } finally {
        session.workspaces = saved;
      }
    });

    await run('a bound transcript opens by saying which tree it is', async () => {
      // Everything below the banner happened somewhere other than the project,
      // and nothing else on screen says so — the window title, the project chip
      // and the file pins all still show the project, deliberately.
      const saved = session.workspaces;
      session.workspaces = [workspaceRow('ws_shown', '/tmp/shown-tree', { label: 'feat/tunnels' })];
      try {
        const bound = await makeConversation(session, 'says-where-it-works', { workspaceId: 'ws_shown' });
        release(bound);

        const banner = bannerFor(bound);
        assert(banner, 'a bound conversation says where it is working');
        assert(banner?.querySelector('.workspace-banner-label')?.textContent === 'feat/tunnels',
          `by the name the user gave the workspace, got ${JSON.stringify(banner?.textContent)}`);
        assert(banner?.querySelector('.workspace-banner-root')?.textContent === '/tmp/shown-tree',
          `and the tree it actually resolves to, got ${JSON.stringify(banner?.textContent)}`);
        assert(banner === banner?.parentElement?.firstElementChild,
          'at the top of the transcript, above the items it scopes');

        // The line names a place; everything else about that place — what kind
        // of thing it is, how the tree is doing, the ways of finishing with it —
        // is the panel's. So the line opens the panel, rather than being the one
        // mention of a workspace there is no way through.
        const open = /** @type {any} */ (banner?.querySelector('.workspace-banner-open'));
        assert(open, 'and the name is a way to the workspace, not merely a note that there is one');
        open.click();
        assert(session.selection?.kind === 'workspace' && session.selection?.id === 'ws_shown',
          `clicking it selects the same workspace the strip's box selects, got ${JSON.stringify(session.selection)}`);
        session.switchConversation(bound.id);

        const where = /** @type {HTMLElement|null} */ (banner?.querySelector('.workspace-banner-root'));
        assert(where?.dataset.filePath === '/tmp/shown-tree',
          'and the root carries the hook the right-click Open / Reveal / Copy menu reads, as every other path on screen does');

        // A sub-thread column is a lens on part of the same conversation, so it
        // works in the same tree; saying so again in every thread would be noise.
        assert(bannerFor(bound, { _threadYMap: {} }) === null,
          'and only once — a sub-thread column shares the conversation it hangs off');
      } finally {
        session.workspaces = saved;
      }
    });

    await run('a conversation in the project says nothing, and one bound to nowhere says that', async () => {
      const saved = session.workspaces;
      session.workspaces = [workspaceRow('ws_quiet', '/tmp/quiet-tree', { label: 'quiet' })];
      try {
        const project = await makeConversation(session, 'works-in-the-project');
        release(project);
        assert(bannerFor(project) === null,
          'the project is where a conversation has always worked, and needs no announcing');

        // What a binding that cannot be honoured must never do is NAME a tree
        // the conversation cannot reach — which is what this said nothing at all
        // to avoid, back when saying nothing was the only other option. The
        // banner for an unresolvable binding names no tree, because there is no
        // row left to name one from; it reports the state, which silence leaves
        // the user to discover through a turn that fails.
        const bound = await makeConversation(session, 'bound-to-a-ghost', { workspaceId: 'ws_quiet' });
        release(bound);
        assert(bannerFor(bound), 'a workspace it can work in is announced');

        bound.workspaceId = 'ws_never_registered';
        const stranded = bannerFor(bound);
        assert(stranded?.classList.contains('workspace-banner-stranded'),
          'while a binding the session cannot resolve is reported as the loss it is');
        assert(!/quiet-tree|ws_never_registered/.test(stranded?.textContent ?? ''),
          `naming neither a tree it cannot reach nor an id that means nothing to anyone, got ${JSON.stringify(stranded?.textContent)}`);
      } finally {
        session.workspaces = saved;
      }
    });

    await run('the environment block names the tree the turn will run in', async () => {
      // The model plans against this block. Left at the project, every absolute
      // path it wrote would name a tree its own tools were not working in —
      // and, unlike a bad op, nothing downstream would refuse it.
      const saved = session.workspaces;
      session.workspaces = [workspaceRow('ws_env', '/tmp/env-tree', { label: 'env' })];
      try {
        const bound = await makeConversation(session, 'says-so-in-its-prompt', { workspaceId: 'ws_env' });
        release(bound);
        const prompt = promptFor(session, bound);
        assert(prompt.includes('Working directory: /tmp/env-tree'),
          `a bound conversation works in its workspace, got ${JSON.stringify(prompt)}`);
        assert(prompt.includes(`Project directory: ${session.projectPath}`),
          `and is told the project too, which it may still read, got ${JSON.stringify(prompt)}`);

        const project = await makeConversation(session, 'says-nothing-extra');
        release(project);
        const plain = promptFor(session, project);
        assert(plain.includes(`Working directory: ${session.projectPath}`),
          `while an unbound conversation reads exactly as it did before workspaces existed, got ${JSON.stringify(plain)}`);
        assert(!plain.includes('Project directory:'),
          `with no second line to say the same thing twice — the block's bytes are a cache key, got ${JSON.stringify(plain)}`);

        // A binding the session cannot resolve has no root to state. The turn is
        // refused server-side either way; naming the project here would be the
        // one answer that reads as working.
        bound.workspaceId = 'ws_never_registered';
        const stale = promptFor(session, bound);
        assert(!stale.includes('Working directory: /tmp/env-tree')
          && !stale.includes(`Working directory: ${session.projectPath}`),
        `an unresolvable binding names no working directory at all, got ${JSON.stringify(stale)}`);
      } finally {
        session.workspaces = saved;
      }
    });

    await run('the git surfaces follow the visible conversation into its tree', async () => {
      // The card counts, the review lists and the diff reads — one on top of
      // another in the pin. They follow the conversation together or the pin
      // shows the name of one tree and the bytes of another, which is why they
      // share one answer to "which tree" rather than each deciding.
      const made = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: { root: `${projectPath}/src`, label: 'src, as git sees it', state: 'ready' }
      });
      const id = made.workspace.id;
      const saved = session.workspaces;
      const wasVisible = session.visibleConversationId;
      session.workspaces = [...saved, made.workspace];
      /** @type {(() => void)|null} */
      let unfollow = null;
      try {
        const bound = await makeConversation(session, 'git-in-its-tree', { workspaceId: id });
        release(bound);
        const project = await makeConversation(session, 'git-in-the-project');
        release(project);

        unfollow = followSession(session);

        session.switchConversation(bound.id);
        gitStatusCache.reset();
        const inTree = await gitStatusCache.refresh();
        assert(inTree?.root === `${projectPath}/src`,
          `the status is read in the visible conversation's tree, got ${JSON.stringify(inTree?.root)}`);

        session.switchConversation(project.id);
        gitStatusCache.reset();
        const inProject = await gitStatusCache.refresh();
        assert(inProject?.root === projectPath,
          `and follows a switch back to a conversation working in the project, got ${JSON.stringify(inProject?.root)}`);
      } finally {
        if (unfollow) unfollow();
        setGitWorkspace('');
        gitStatusCache.reset();
        if (wasVisible) session.switchConversation(wasVisible);
        session.workspaces = saved;
        await fetchJson(`/api/session/workspaces/${id}`, { method: 'DELETE', fallback: null });
      }
    });

    await run('the item diff leaves the banner where it is', async () => {
      // The banner is a managed non-item: it carries no message-id, so an
      // id-keyed diff that did not know about it would delete it on the first
      // render and it would never be seen again.
      const saved = session.workspaces;
      session.workspaces = [workspaceRow('ws_kept', '/tmp/kept-tree', { label: 'kept' })];
      try {
        const bound = await makeConversation(session, 'keeps-its-banner', { workspaceId: 'ws_kept' });
        release(bound);

        const { area, list } = columnFor(bound);
        ensureWorkspaceBanner(area, list);
        const stray = document.createElement('div');
        stray.setAttribute('message-id', 'item-1');
        list.insertBefore(stray, list.querySelector('conversation-footer'));

        removeAllElements(list);
        assert(list.querySelector('.conversation-workspace-banner'),
          'clearing the transcript to empty leaves the banner standing');
        assert(!list.querySelector('[message-id="item-1"]'),
          'while the items it stands above are gone, which is what makes that mean anything');
      } finally {
        session.workspaces = saved;
      }
    });

  });
}
