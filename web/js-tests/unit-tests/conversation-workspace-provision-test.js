//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Building the place a conversation will work in.
 *
 * A provision makes something on disk, so every way it can stop half way is a
 * case here: cancelled, aborted inside a step, or interrupted by a restart that
 * leaves only the checkpoints behind. Each must leave nothing, and say so. The
 * places on offer are the other half — which of them can be worked in, which
 * could be made, and how a row whose probe failed reads.
 * @module unit-tests/conversation-workspace-provision-test
 */

import { assert } from '../utilities/test-helpers.js';
import { fetchJson } from '../../js/services/http.js';
import { writeFileOp } from '../../js/services/ops-api.js';
import { createBoundOps } from '../../sdk/ops.js';
import { registerWorkspace, unregisterWorkspace, listWorkspaces } from '../../js/services/workspaces.js';
import { provisionWorkspace, recordProgress } from '../../js/services/workspace-provisioning.js';
import { rebindConversation } from '../../js/services/workspace-rebinding.js';
import {
  PROJECT_ROW_ID,
  NEW_ROW_PREFIX,
  setupRows
} from '../../js/services/workspace-places.js';
import workspaceProviderRegistry from '../../js/registries/workspace-provider-registry.js';
import { buildPlaceRows } from '../../js/components/workspace-setup-form.js';
import {
  runWorkspaceSuite,
  FixtureProvider,
  abandonProvision,
  fileTurnsUp,
  makeConversation,
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
 * Run the conversation-workspace-provision tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  return runWorkspaceSuite('conversation-workspace-provision-test', async ({ run, session, projectPath, release }) => {
    await run('a step that keeps talking updates its line rather than adding another', async () => {
      // A provider with a slow step has two things to say and one line to say
      // them on: what the step is, and how it is going. Appending would turn a
      // clone that reports its percentage into a thousand-line wall, and the
      // step it belongs to would scroll away from the answer.
      /** @type {{step: string, detail: string}[]} */
      const lines = [];
      recordProgress(lines, 'Making the directory', '/tmp/somewhere');
      recordProgress(lines, 'Setting it up', 'a-hook');
      recordProgress(lines, 'Setting it up', 'fetching the submodules');
      recordProgress(lines, 'Setting it up', 'linked node_modules');

      assert(lines.length === 2,
        `the same step said four times is one line, got ${JSON.stringify(lines)}`);
      assert(lines[1].detail === 'linked node_modules',
        `showing the latest thing it said, got ${JSON.stringify(lines[1])}`);

      // A step that comes back later is a new step, not the old one continuing:
      // the list is what has happened, in order, and folding two visits of the
      // same name together would report the second as the first.
      recordProgress(lines, 'Making the directory', '/tmp/elsewhere');
      assert(lines.length === 3,
        `while the same name after another step is a step of its own, got ${JSON.stringify(lines)}`);
    });

    await run('a workspace provider is built from the registry, and a missing one is simply missing', async () => {
      // The registry is asked for providers by id, and the id comes off a
      // workspace row that outlives whatever made it. So the miss is not an
      // error case — it is what a user gets for disabling an extension after
      // making a worktree with it, and it must cost them the provider rather
      // than the workspace.
      //
      // From an empty registry, because the suite is handed one that already
      // has the fixture provider in it and `registerClass` refuses an id that
      // is taken: asked without the reset, this would be proving the refusal.
      workspaceProviderRegistry.reset();
      const registration = workspaceProviderRegistry.registerClass(FixtureProvider, {
        extensionId: 'test',
        modulePath: '(test)'
      });
      assert(registration.registered,
        `registerClass refused the fixture provider: ${registration.reason}`);

      const provider = workspaceProviderRegistry.createProvider(FixtureProvider.MANIFEST.id, session);
      assert(provider instanceof FixtureProvider,
        `the registry builds the class it was given, got ${provider?.constructor?.name}`);
      assert(provider?.getSetupLabel() === 'Somewhere else',
        `a provider with no setupLabel is offered under its name, got ${provider?.getSetupLabel()}`);

      assert(workspaceProviderRegistry.createProvider('nothing-of-the-sort', session) === undefined,
        'while a provider nothing registered comes back as nothing, rather than throwing');
    });

    await run('the seeds also read the instructions of a tree the provider names', async () => {
      // A workspace root is not always the only place whose instructions apply.
      // A worktree of a subrepo, and a folder inside the project, both leave the
      // project's own AGENTS.md unread when the root is the only place probed.
      // The host cannot work out which other place counts — walking up from a
      // worktree reaches the user's home directory, not the project — so the
      // provider is asked, and the host still owns which names count, the
      // content-hash dedup and the skip for what the user pinned themselves.
      const stamp = Math.random().toString(36).slice(2, 8);
      const elsewhere = `instructions-${stamp}`;
      const marker = `# instructions from the place the provider named ${stamp}`;
      const ownMarker = `# instructions of the workspace itself ${stamp}`;
      await writeFileOp({ path: `${elsewhere}/.cursorrules`, content: marker });
      // Writing the workspace's own file is also what makes its root exist,
      // which the server insists on before anything may be worked in there.
      await writeFileOp({ path: `folder-${stamp}/.instructions`, content: ownMarker });

      const made = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: {
          root: `${projectPath}/folder-${stamp}`,
          label: 'a folder with instructions above it',
          state: 'ready',
          providerId: 'fixture-workspace-provider'
        }
      });
      const id = made.workspace.id;
      const saved = session.workspaces;
      session.workspaces = [...saved, made.workspace];
      FixtureProvider.extraRoots = [`${projectPath}/${elsewhere}`];
      try {
        const bound = await makeConversation(session, `seeded-from-above-${stamp}`, { workspaceId: id });
        release(bound);

        const files = bound.rootMessageThread.contextItems
          .filter((/** @type {any} */ item) => item.type === 'file-content');
        const named = files.find(
          (/** @type {any} */ item) => item.data.path === `${projectPath}/${elsewhere}/.cursorrules`);
        assert(named,
          `the conversation is seeded from the directory the provider named, got ${JSON.stringify(files.map((/** @type {any} */ i) => i.data.path))}`);

        // The path is absolute because it is outside the tree the conversation
        // works in: a workspace-relative `../` would read as a file of the
        // workspace's own, both to the model and in the properties panel.
        const text = await named.createContextText({});
        assert(text.includes(marker),
          `and reads it from there rather than from its own root, got ${JSON.stringify(text)}`);

        // Nearest last. What the tree says for itself is the last word, so it
        // sits below the wider instructions rather than above them.
        const own = files.findIndex((/** @type {any} */ item) => item.data.path === '.instructions');
        assert(own > files.indexOf(named),
          `and the workspace's own instructions are seeded after the wider ones, got ${JSON.stringify(files.map((/** @type {any} */ i) => i.data.path))}`);
      } finally {
        FixtureProvider.extraRoots = [];
        session.workspaces = saved;
        await fetchJson(`/api/session/workspaces/${id}`, { method: 'DELETE', fallback: null });
      }
    });

    await run('a provision builds the place, registers it ready, and can be taken back', async () => {
      const name = `fixture-ws-${Math.random().toString(36).slice(2, 8)}`;
      const dir = `${projectPath}/${name}`;
      const projectOps = createBoundOps(() => ({}));

      const outcome = await provisionWorkspace({
        session,
        providerId: FixtureProvider.MANIFEST.id,
        values: { dir }
      });
      try {
        assert(outcome.workspace.state === 'ready',
          `a finished provision leaves a ready row, got ${outcome.workspace.state}`);
        assert(outcome.workspace.root === dir,
          `rooted where the provider said, got ${outcome.workspace.root}`);
        assert(outcome.workspace.label === 'made by the fixture',
          `labelled as the provider named it, got ${outcome.workspace.label}`);
        assert(outcome.workspace.providerId === FixtureProvider.MANIFEST.id,
          `attributed to the provider that built it, got ${outcome.workspace.providerId}`);

        // Through the new workspace's own id, which only resolves because the
        // row reached `ready` — the same path a bound conversation's tools take.
        const inside = createBoundOps(() => ({ workspaceId: outcome.workspace.id }));
        assert((await inside.stat({ path: 'made-here.txt' })).exists,
          'and the thing it built is really there');
      } finally {
        await outcome.undo();
      }

      assert(!(await projectOps.stat({ path: `${name}/made-here.txt` })).exists,
        'undo runs the same compensations and removes what was built');
      const remaining = await listWorkspaces();
      assert(!remaining.some(ws => ws.id === outcome.workspace.id),
        'and takes the row off the table with it');
    });

    await run('a provision leaves the kind of place to the server', async () => {
      // What a kind means is the server's: it records one for a registration
      // that names none, and refuses one it cannot open. A browser that wrote a
      // kind itself would be a second copy of that rule, free to disagree.
      const name = `fixture-kind-${Math.random().toString(36).slice(2, 8)}`;
      /** @type {any[]} */
      const registered = [];
      const realFetch = window.fetch;
      window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
        if (String(url).endsWith('/api/session/workspaces') && init?.method === 'POST') {
          registered.push(JSON.parse(String(init.body)));
        }
        return realFetch(url, init);
      });
      /** @type {any} */
      let outcome = null;
      try {
        outcome = await provisionWorkspace({
          session,
          providerId: FixtureProvider.MANIFEST.id,
          values: { dir: `${projectPath}/${name}` }
        });
      } finally {
        window.fetch = realFetch;
      }
      try {
        assert(registered.length === 1,
          `the provision registers its row once, got ${registered.length} registrations`);
        assert(!('kind' in registered[0]),
          `and names no kind, got ${JSON.stringify(registered[0])}`);
        assert(outcome.workspace.kind === 'local',
          `the row records the kind the server gave it, got ${JSON.stringify(outcome.workspace.kind)}`);
      } finally {
        await outcome?.undo();
      }
    });

    await run('cancelling mid-provision rejects and leaves nothing behind', async () => {
      // The claim the whole feature is sold on: a mis-click costs nothing. It
      // has to be true of the disk as well as of the table, which is why this
      // looks for the directory afterwards rather than trusting the row count.
      const name = `fixture-cancel-${Math.random().toString(36).slice(2, 8)}`;
      const dir = `${projectPath}/${name}`;
      const projectOps = createBoundOps(() => ({}));
      const controller = new AbortController();

      const running = provisionWorkspace({
        session,
        providerId: FixtureProvider.MANIFEST.id,
        values: { dir, stallMs: 2000 },
        signal: controller.signal
      });
      /** @type {any[]} */
      const rejections = [];
      const settled = running.then(() => {}, (error) => { rejections.push(error); });

      assert(await fileTurnsUp(projectOps, name, 5000),
        'the provision never got as far as making anything, so cancelling it proves nothing');
      controller.abort();
      await settled;

      assert(rejections.length === 1,
        `a cancelled provision rejects rather than resolving, got ${rejections.length} rejections`);
      assert(!(await projectOps.stat({ path: name })).exists,
        'and the directory it had already made is gone again');
      // By the tree this provision was building, not by its provider: the table
      // is the whole project's, and every other case's workspaces are on it.
      const remaining = await listWorkspaces();
      assert(!remaining.some(ws => ws.root === dir),
        'and no half-built row is left on the table');
    });

    await run('an abort inside a step still unwinds the thing that step made', async () => {
      // The window an inverse pushed AFTER its step falls through. The command
      // makes the directory and then keeps running; the abort rejects the
      // operation, so a provider that records its undo on the next line never
      // records it at all, and the directory it made outlives the provision
      // that made it. Recording before the step is what closes that, and this
      // case is what fails if the ordering is ever quietly reversed.
      const name = `fixture-window-${Math.random().toString(36).slice(2, 8)}`;
      const dir = `${projectPath}/${name}`;
      const projectOps = createBoundOps(() => ({}));
      const controller = new AbortController();

      const running = provisionWorkspace({
        session,
        providerId: FixtureProvider.MANIFEST.id,
        values: { dir, dirStallMs: 2000 },
        signal: controller.signal
      });
      /** @type {any[]} */
      const rejections = [];
      const settled = running.then(() => {}, (error) => { rejections.push(error); });

      assert(await fileTurnsUp(projectOps, name, 5000),
        'the step never made its directory, so there is no window to land in');
      controller.abort();
      await settled;

      assert(rejections.length === 1,
        `the provision is abandoned at the abort, got ${rejections.length} rejections`);
      assert(!(await projectOps.stat({ path: name })).exists,
        'and the directory that existed at the instant of the abort is removed anyway');
    });

    await run('a provision interrupted by a restart is undone from its checkpoints alone', async () => {
      // No closure survives a restart, so the compensation stack cannot be the
      // whole story: what is left is the row, its `meta`, and whatever reached
      // disk. This runs the same provision to each checkpoint boundary, throws
      // the closures away, and asks the provider to undo it from `meta` — which
      // is exactly what the load-time sweep will do.
      const projectOps = createBoundOps(() => ({}));
      const provider = workspaceProviderRegistry.createProvider(FixtureProvider.MANIFEST.id, session);
      const cleanupCtx = {
        session,
        ops: projectOps,
        baseWorkspaceId: '',
        signal: new AbortController().signal,
        rollback: { push: () => {} },
        checkpoint: async () => {},
        progress: () => {}
      };

      // Boundary one: the directory is made, the marker is not.
      const firstName = `fixture-restart-a-${Math.random().toString(36).slice(2, 8)}`;
      const firstDir = `${projectPath}/${firstName}`;
      const first = await abandonProvision(session, { dir: firstDir, dirStallMs: 2000 },
        () => fileTurnsUp(projectOps, firstName, 5000).then(() => {}));
      try {
        assert(first?.meta?.dir === firstDir && first?.meta?.marked === undefined,
          `the row records the step it reached and no further, got ${JSON.stringify(first?.meta)}`);
        assert((await projectOps.stat({ path: firstName })).exists,
          'and what it built is still on disk, which is the mess to be cleared');

        const cleaned = await provider?.cleanupPartial(first, cleanupCtx);
        assert(cleaned?.removed === true,
          `cleanupPartial reports it dealt with the row, got ${JSON.stringify(cleaned)}`);
        assert(!(await projectOps.stat({ path: firstName })).exists,
          'and leaves the same nothing behind that cancelling would have');
      } finally {
        await unregisterWorkspace(first.id).catch(() => {});
      }

      // Boundary two: both steps landed; the row was simply never flipped to ready.
      const secondName = `fixture-restart-b-${Math.random().toString(36).slice(2, 8)}`;
      const secondDir = `${projectPath}/${secondName}`;
      const second = await abandonProvision(session, { dir: secondDir });
      try {
        assert(second?.meta?.marked === true,
          `the row records having got as far as the marker, got ${JSON.stringify(second?.meta)}`);
        assert((await projectOps.stat({ path: `${secondName}/made-here.txt` })).exists,
          'and the marker really is there, so removing it means something');

        await provider?.cleanupPartial(second, cleanupCtx);
        assert(!(await projectOps.stat({ path: secondName })).exists,
          'cleanupPartial removes the later step and the earlier one together');
      } finally {
        await unregisterWorkspace(second.id).catch(() => {});
      }

      // A checkpoint is written BEFORE the step it describes, so `meta` routinely
      // claims a step that never happened. Undoing that must be uneventful.
      const ghostName = `fixture-restart-c-${Math.random().toString(36).slice(2, 8)}`;
      const ghost = await registerWorkspace({
        kind: 'local',
        root: `${projectPath}/${ghostName}`,
        providerId: FixtureProvider.MANIFEST.id,
        state: 'provisioning',
        meta: { dir: `${projectPath}/${ghostName}`, marked: true }
      });
      try {
        const cleaned = await provider?.cleanupPartial(ghost, cleanupCtx);
        assert(cleaned?.removed === true,
          `a checkpoint describing a step that never landed cleans up quietly, got ${JSON.stringify(cleaned)}`);
      } finally {
        await unregisterWorkspace(ghost.id).catch(() => {});
      }
    });

    await run('a probe that failed does not become the row it was probing', async () => {
      // `detail` describes the place; `problem` says why nobody could describe
      // it. They are separate fields precisely so this cannot happen: the row's
      // detail line is where a reader looks for WHERE a place is, and a stale
      // row whose tree had gone once rendered an HTTP status there.
      const rows = [{
        kind: 'workspace',
        id: 'ws_probe_failed',
        label: 'feat/tunnels',
        detail: '/tmp/juggler-feat-tunnels'
      }];
      const failure = 'workspace feat/tunnels is missing its root: /tmp/juggler-feat-tunnels';
      const group = buildPlaceRows({
        rows,
        selection: PROJECT_ROW_ID,
        label: 'Workspace',
        statusFor: () => ({ label: 'feat/tunnels', problem: failure, statusFailed: true, available: false }),
        onSelect: () => {}
      });

      const note = group.querySelector('.setup-row-detail');
      assert(note?.textContent === '/tmp/juggler-feat-tunnels',
        `the line says where the place is, got ${JSON.stringify(note?.textContent)}`);

      // Not dropped, though — it is the only thing that says why the row is
      // dimmed, and the underlying text is never ours to throw away.
      const element = /** @type {HTMLElement|null} */ (group.querySelector('.setup-row'));
      assert(element?.title === failure,
        `and the failure is still reachable, got ${JSON.stringify(element?.title)}`);
      assert(element?.classList.contains('setup-row-away'),
        'and the row reads as somewhere that cannot be worked in');

      // A probe that succeeded is unchanged: its detail is the description, and
      // there is nothing to put in a tooltip.
      const fine = buildPlaceRows({
        rows,
        selection: PROJECT_ROW_ID,
        label: 'Workspace',
        statusFor: () => ({ label: 'feat/tunnels', detail: 'on feat/tunnels · clean', available: true }),
        onSelect: () => {}
      });
      assert(fine.querySelector('.setup-row-detail')?.textContent === 'on feat/tunnels · clean',
        'a working probe still describes the place');
      // A probe answers in a sentence and the fallback is an address, and the
      // two are not set alike: monospace is what makes a path scannable and
      // what makes a sentence look like program output.
      assert(fine.querySelector('.setup-row-detail')?.classList.contains('setup-row-said'),
        'and is marked as the sentence it is');
      assert(!note?.classList.contains('setup-row-said'),
        'while the address the row falls back to is not');
      assert(!(/** @type {HTMLElement|null} */ (fine.querySelector('.setup-row'))?.title),
        'and carries no tooltip, because nothing went wrong');
    });

    await run('the setup offers the project, then what exists, then what could be made', async () => {
      const saved = session.workspaces;
      session.workspaces = [
        workspaceRow('ws_usable', '/tmp/usable', { label: 'already there' }),
        workspaceRow('ws_half', '/tmp/half', { state: 'provisioning' }),
        workspaceRow('ws_over', '/tmp/over', { state: 'closed' }),
        workspaceRow('ws_gone', '/tmp/gone', { available: false })
      ];
      try {
        const rows = setupRows(session);
        assert(rows[0]?.kind === 'project' && rows[0]?.id === PROJECT_ROW_ID,
          `the project is always the first row, got ${JSON.stringify(rows[0])}`);
        assert(rows[0]?.detail === session.projectPath,
          `and says where it is, got ${JSON.stringify(rows[0]?.detail)}`);

        const offered = rows.map((/** @type {any} */ row) => row.id);
        assert(offered.includes('ws_usable'),
          `a workspace that can be worked in is offered, got ${JSON.stringify(offered)}`);
        assert(!offered.includes('ws_half') && !offered.includes('ws_over'),
          `while one still being built and one finished with are not — both refuse every op, got ${JSON.stringify(offered)}`);
        // A ready row whose tree has gone refuses every operation just as
        // surely, and says so nowhere: offering it is offering somewhere the
        // first command will fail.
        assert(!offered.includes('ws_gone'),
          `nor is one whose root is not there, got ${JSON.stringify(offered)}`);

        // Every loaded provider, by name rather than by position: which
        // provider registered first is nobody's guarantee, and an assertion
        // that reads the first "New…" row is asserting the load order of the
        // extensions rather than the rule it says it is testing.
        const newRows = rows.filter((/** @type {any} */ row) => row.kind === 'new');
        const newIds = newRows.map((/** @type {any} */ row) => row.id);
        for (const providerId of workspaceProviderRegistry.getIds()) {
          assert(newIds.includes(`${NEW_ROW_PREFIX}${providerId}`),
            `each loaded provider offers a row to make one with; ${providerId} did not, got ${JSON.stringify(newIds)}`);
        }
        const made = newRows.find(
          (/** @type {any} */ row) => row.id === `${NEW_ROW_PREFIX}${FixtureProvider.MANIFEST.id}`);
        assert(made, `including this test's own, got ${JSON.stringify(newIds)}`);
        assert(made?.label === 'Somewhere else',
          `labelled as the provider asks to be offered, got ${JSON.stringify(made?.label)}`);
        assert(rows.indexOf(made) > rows.findIndex((/** @type {any} */ r) => r.id === 'ws_usable'),
          'and is offered below what already exists, which is the common path');
      } finally {
        session.workspaces = saved;
      }
    });

    await run('a place is built with nothing bound to it, and a conversation moves in afterwards', async () => {
      // The two acts, in the order the app performs them: the place is made
      // with no conversation in the question, and something is moved into it
      // once it is there. Whoever is waiting on the provision is told what it
      // is waiting on as it goes — a provider's slow step is minutes long, and
      // a wait with nothing said is a wait nobody can tell from a hang.
      const name = `provision-bind-${Math.random().toString(36).slice(2, 8)}`;
      const dir = `${projectPath}/${name}`;
      const projectOps = createBoundOps(() => ({}));
      const conversation = await makeConversation(session, 'moves-into-a-workspace');
      release(conversation);

      /** @type {string[]} */
      const announced = [];
      const saved = session.workspaces;
      try {
        const outcome = await provisionWorkspace({
          session,
          providerId: FixtureProvider.MANIFEST.id,
          values: { dir },
          onProgress: (/** @type {string} */ step) => {
            if (announced.at(-1) !== step) announced.push(step);
          }
        });
        assert(announced.includes('Making the directory'),
          `whoever is waiting is told what it is waiting on as it goes, got ${JSON.stringify(announced)}`);
        assert((await projectOps.stat({ path: `${name}/made-here.txt` })).exists,
          'the place really was built');

        const moved = await rebindConversation(conversation, outcome.workspace.id);
        assert(moved.done === true,
          `and a conversation moves into it, got ${JSON.stringify(moved)}`);
        assert(conversation.workspaceId === outcome.workspace.id,
          `which is where it works from then on, got ${JSON.stringify(conversation.workspaceId)}`);

        // Out again before the place is taken back: undo removes the tree, and
        // a conversation left standing in it would be pointed at ground that
        // has gone.
        await rebindConversation(conversation, '');
        await outcome.undo();

        assert(!(await projectOps.stat({ path: name })).exists,
          'undo runs the same compensations the cancel would have, and the tree is gone');
        const remaining = await listWorkspaces();
        assert(!remaining.some(ws => ws.id === outcome.workspace.id),
          'and takes the row off the table with it');
      } finally {
        session.workspaces = saved;
        await projectOps.shell({ command: `rm -rf ${name}` }).catch(() => {});
      }
    });

    await run('a provision called off and one that cannot finish both leave nothing, and only one has something to say', async () => {
      // The two endings a form has to tell apart. Both unwind the same way, and
      // what separates them is what comes back: a cancel is what the user asked
      // for and has nothing to explain, while a failure has to arrive carrying
      // the provider's own words, because they are the only thing that says
      // which field to correct.
      const name = `provision-cancel-${Math.random().toString(36).slice(2, 8)}`;
      const dir = `${projectPath}/${name}`;
      const projectOps = createBoundOps(() => ({}));
      const controller = new AbortController();

      const creating = provisionWorkspace({
        session,
        providerId: FixtureProvider.MANIFEST.id,
        values: { dir, stallMs: 2000 },
        signal: controller.signal
      });
      /** @type {any[]} */
      const cancelled = [];
      const settled = creating.then(() => {}, (error) => { cancelled.push(error); });

      assert(await fileTurnsUp(projectOps, name, 5000),
        'the provision never started, so cancelling it proves nothing');
      controller.abort();
      await settled;

      assert(cancelled.length === 1,
        `cancelling hands back no workspace, got ${cancelled.length} rejections`);
      assert(!(await projectOps.stat({ path: name })).exists,
        'and what had been built is unwound');

      // The provider gets part way and then cannot go on, which is the other
      // way a form's Create ends without a place to show for it.
      const failName = `provision-failed-${Math.random().toString(36).slice(2, 8)}`;
      /** @type {any} */
      let failure = null;
      try {
        await provisionWorkspace({
          session,
          providerId: FixtureProvider.MANIFEST.id,
          values: { dir: `${projectPath}/${failName}`, failWith: 'fatal: invalid reference: develop' }
        });
      } catch (error) {
        failure = error;
      }
      assert(failure, 'a provision that cannot finish hands back no workspace either');
      assert(failure?.message === 'fatal: invalid reference: develop',
        `and this time it comes back in the provider's own words, got ${JSON.stringify(failure?.message)}`);
      assert(!(await projectOps.stat({ path: failName })).exists,
        'with the part it had built already unwound, not left for someone to find');
    });

  });
}
