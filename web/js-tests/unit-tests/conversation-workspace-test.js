//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A conversation's workspace binding, and the seeds that follow it.
 *
 * A conversation's assistant files are relative to a root: they are whichever
 * tree it works in. That is settled before the conversation exists — the project
 * folder, or the workspace whose box it was started in — so it is bound and
 * seeded at birth and shows what its first turn would carry from the moment it
 * is on screen. What changes the answer afterwards is a move, which rebuilds the
 * seeds out of the tree it moved into.
 *
 * These cases pin that: what a conversation has the instant it is created, what
 * a move does to those seeds and what it leaves alone, that seeding confirms
 * rather than repeats — a seed the user deleted stays deleted — and what a
 * conversation born from another inherits.
 * @module unit-tests/conversation-workspace-test
 */

import { waitFor, assert } from '../utilities/test-helpers.js';
import { INITIALISED_KEY } from '../../js/model/conversation.js';
import { fetchJson } from '../../js/services/http.js';
import { writeFile } from '../../js/services/ops-api.js';
import { createBoundOps } from '../../sdk/ops.js';
import { rebindConversation } from '../../js/services/workspace-rebinding.js';
import { placeForNewConversation } from '../../js/services/workspace-provisioning.js';
import workerManager from '../../js/services/worker-manager.js';
import {
  runWorkspaceSuite,
  countSeeds,
  makeConversation,
  seededFile,
  syncUndoState
} from '../utilities/conversation-workspace-helpers.js';

/**
 * This suite makes and removes directories directly in the shared fixture root,
 * which a sibling lane walking the project reads as they come and go, so no
 * other lane may be in flight while it runs.
 * @type {boolean}
 */
export const needsExclusiveRun = true;

/**
 * Run the conversation-workspace tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  return runWorkspaceSuite('conversation-workspace-test', async ({ run, session, projectPath, registeredId, release }) => {
    await run('a conversation is born in the project folder, holding its seeds', async () => {
      // Bound and seeded before it is on screen. Where it works was settled by
      // the act that made it — the "+" at the top of the strip means the project
      // folder — so there is no window in which it is showing one tree's
      // assistant files while working in another.
      const seeds = countSeeds(session);
      /** @type {any} */
      let conversation = null;
      try {
        conversation = await makeConversation(session, 'unseeded');
        release(conversation);
        assert(seeds.calls() === 1,
          `its seeds are built once, at creation, got ${seeds.calls()} seeding pass(es)`);
      } finally {
        seeds.restore();
      }

      assert(conversation.initialised === true,
        `it reports itself initialised, got ${JSON.stringify(conversation.initialised)}`);
      assert(conversation.workspaceId === '',
        `bound to the project folder, got ${JSON.stringify(conversation.workspaceId)}`);
      assert(conversation.seededFor === '',
        `which is also the tree those seeds are for, got ${JSON.stringify(conversation.seededFor)}`);
    });

    await run('nothing a conversation is born with is undoable, however late it is initialised', async () => {
      // The loader seeds the system-prompt placeholder before the conversation
      // is initialised, and that is an undo group of its own. How soon the
      // worker reports it depends on the core: here it has been reported before
      // initialisation asks, as on a slow one or after any pause at all.
      const loader = workerManager.loader;
      const createNew = loader.createNew;
      let reported = false;
      loader.createNew = async (/** @type {any[]} */ ...args) => {
        const born = await createNew.apply(loader, args);
        await syncUndoState(born);
        reported = born.canUndo() === true;
        return born;
      };
      /** @type {any} */
      let conversation = null;
      try {
        conversation = await makeConversation(session, 'born-reported');
        release(conversation);
      } finally {
        loader.createNew = createNew;
      }
      assert(reported, 'precondition: the placeholder\'s undo group had reached the document before initialisation');

      await syncUndoState(conversation);
      assert(conversation.canUndo() === false,
        'the conversation was born with an undoable history, so undo would take its system prompt away');
    });

    await run('initialising it against the tree it was seeded for adds nothing back', async () => {
      const conversation = await makeConversation(session, 'initialised-by-hand');
      release(conversation);
      // What a document written before the flag existed looks like: seeded for
      // the tree it works in, with nothing recording that it ever was.
      conversation.setMetadata(INITIALISED_KEY, false);

      const seeds = countSeeds(session);
      try {
        await session.initialiseConversation(conversation);
        assert(seeds.calls() === 0,
          `the pass for that tree has already run, got ${seeds.calls()} seeding pass(es)`);
      } finally {
        seeds.restore();
      }
      assert(conversation.initialised === true, 'and the conversation reports itself initialised');
    });

    await run('initialising it against another tree seeds that one', async () => {
      const conversation = await makeConversation(session, 'initialised-elsewhere');
      release(conversation);
      conversation.setMetadata(INITIALISED_KEY, false);

      const seeds = countSeeds(session);
      try {
        await session.initialiseConversation(conversation, { workspaceId: registeredId });
        assert(seeds.calls() === 1,
          `a tree it was not seeded for is read now, got ${seeds.calls()} seeding pass(es)`);
      } finally {
        seeds.restore();
      }
      assert(conversation.seededFor === registeredId,
        `and becomes the tree its seeds are for, got ${JSON.stringify(conversation.seededFor)}`);
    });

    await run('racing triggers initialise it exactly once', async () => {
      const conversation = await makeConversation(session, 'raced');
      release(conversation);

      // Put back into the state of a conversation whose seeds have never been
      // built — what every conversation written before any of this looks like —
      // so that the racing triggers have a pass between them to duplicate.
      conversation.setMetadata(INITIALISED_KEY, false);
      conversation.seededFor = null;

      const seeds = countSeeds(session);
      try {
        await Promise.all([
          conversation.ensureInitialised(),
          conversation.ensureInitialised(),
          conversation.ensureInitialised()
        ]);
        assert(seeds.calls() === 1,
          `three triggers at once seed once, got ${seeds.calls()}`);
        await conversation.ensureInitialised();
        assert(seeds.calls() === 1,
          `and an already-initialised conversation is never seeded again, got ${seeds.calls()}`);
      } finally {
        seeds.restore();
      }
      assert(conversation.initialised === true, 'and it ends up initialised');
    });

    await run('sending into a conversation does not seed over what it is showing', async () => {
      const conversation = await makeConversation(session, 'committed-by-send');
      release(conversation);

      const seeds = countSeeds(session);
      try {
        const refused = await conversation.sendMessage('Hello there', null, conversation.rootMessageThread, {
          consumeComposer: false
        });
        assert(refused === null, `expected the send to be accepted, got ${JSON.stringify(refused)}`);
        assert(conversation.initialised === true,
          'a conversation with content in it is initialised, as it was before the send');
        assert(seeds.calls() === 0,
          `and the send does not seed over the items it was already showing, got ${seeds.calls()}`);
      } finally {
        seeds.restore();
      }
    });

    await run('a conversation that predates the flag is never seeded a second time', async () => {
      // Every conversation on disk today has no `initialised` in its metadata,
      // so each one reaches its next send looking exactly like a conversation
      // that has never been seeded. Seeding it again would resurrect the items
      // its user had deleted and clear the undo history behind their work.
      const conversation = await makeConversation(session, 'from-before-the-flag');
      release(conversation);
      const refused = await conversation.sendMessage('a turn from before all this', null, conversation.rootMessageThread, {
        consumeComposer: false
      });
      assert(refused === null, `expected the send to be accepted, got ${JSON.stringify(refused)}`);
      // The worker writes the user item and it syncs back, so the history this
      // case is about arrives a moment after the send is accepted.
      await waitFor(() => conversation.rootMessageThread.items.some(
        (/** @type {any} */ item) => item?.get?.('type') === 'user'),
      { description: 'the sent message to reach the document' });

      // What an upgrade looks like: history in the document, and no flag.
      conversation.setMetadata(INITIALISED_KEY, false);
      assert(conversation.initialised === false, 'the conversation now looks uninitialised, as an upgraded one does');

      const seeds = countSeeds(session);
      try {
        await conversation.ensureInitialised();
        assert(seeds.calls() === 0,
          `a conversation with history behind it is left alone, got ${seeds.calls()} seeding pass(es)`);
      } finally {
        seeds.restore();
      }
      assert(conversation.initialised === true,
        'and is recorded as initialised, so it is only ever asked this once');
    });

    await run('moving to another tree seeds the assistant files it has', async () => {
      // A conversation shows what its next turn would carry, which means it is
      // showing one particular tree's assistant files. Moving it has to read the
      // tree it moved into, or the list is describing somewhere the conversation
      // is not working.
      const stamp = Math.random().toString(36).slice(2, 8);
      const elsewhere = `seed-swap-${stamp}`;
      const marker = `# instructions only this tree has ${stamp}`;
      const project = createBoundOps(() => ({ workspaceId: '' }));
      // `.cursorrules` is an assistant file the project root does not have, so
      // its arrival and departure are the tree being read, not a cache.
      await writeFile({ path: `${elsewhere}/.cursorrules`, content: marker });
      const made = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: { root: `${projectPath}/${elsewhere}`, label: 'a tree with rules of its own', state: 'ready' }
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, made.workspace];
      try {
        const conversation = await makeConversation(session, 'seeds-follow-the-row');
        release(conversation);

        assert(!seededFile(conversation, '.cursorrules'),
          'precondition: the tree it starts in has no rules file');

        const moved = await rebindConversation(conversation, made.workspace.id);
        assert(moved.done, `the move went through, got ${JSON.stringify(moved)}`);
        assert(conversation.workspaceId === made.workspace.id,
          `and the conversation works in the tree it moved to, got ${JSON.stringify(conversation.workspaceId)}`);

        assert(seededFile(conversation, '.cursorrules'),
          'the assistant file only that tree has is now in the conversation');
        const text = await seededFile(conversation, '.cursorrules').createContextText({});
        assert(text.includes(marker),
          `read from that tree rather than named after it, got ${JSON.stringify(text)}`);
      } finally {
        session.workspaces = saved;
        await fetchJson(`/api/session/workspaces/${made.workspace.id}`, { method: 'DELETE', fallback: null });
        await project.copyTree({ to: '.', delete: [elsewhere] });
      }
    });

    await run('a rebuild replaces the seeds and nothing else', async () => {
      // The seeded assistant files belong to where the conversation works. A
      // file the user pinned themselves does not — nor does the prompt they are
      // editing — so a move may not touch either.
      const stamp = Math.random().toString(36).slice(2, 8);
      const elsewhere = `seed-keep-${stamp}`;
      const project = createBoundOps(() => ({ workspaceId: '' }));
      await writeFile({ path: `${elsewhere}/.cursorrules`, content: `# ${stamp}` });
      const made = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: { root: `${projectPath}/${elsewhere}`, label: 'somewhere else entirely', state: 'ready' }
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, made.workspace];
      try {
        const conversation = await makeConversation(session, 'keeps-what-is-theirs');
        release(conversation);
        const mt = conversation.rootMessageThread;

        await mt.executeContextItem('file-content', { path: 'README.md' });
        const pinned = seededFile(conversation, 'README.md');
        assert(pinned && pinned.data.seeded !== true,
          'precondition: the user pinned a file of their own, which is not a seed');

        const moved = await rebindConversation(conversation, made.workspace.id);
        assert(moved.done, `the move went through, got ${JSON.stringify(moved)}`);

        const after = seededFile(conversation, 'README.md');
        assert(after, 'the file the user pinned is still in the conversation');
        assert(after.id === pinned.id,
          `and is the same item rather than one seeded over it, got ${JSON.stringify(after.id)}`);
        assert(mt.contextItems.some((/** @type {any} */ item) => item.type === 'system-prompt'),
          'and the prompt it starts from is untouched');
      } finally {
        session.workspaces = saved;
        await fetchJson(`/api/session/workspaces/${made.workspace.id}`, { method: 'DELETE', fallback: null });
        await project.copyTree({ to: '.', delete: [elsewhere] });
      }
    });

    await run('a seed the user deleted does not come back when the seeding runs again', async () => {
      // Seeding confirms rather than repeats. A conversation shows what its next
      // turn would carry, and a seed the user has read and thrown away is an
      // answer they have already given.
      const stamp = Math.random().toString(36).slice(2, 8);
      const elsewhere = `seed-deleted-${stamp}`;
      const project = createBoundOps(() => ({ workspaceId: '' }));
      await writeFile({ path: `${elsewhere}/.cursorrules`, content: `# ${stamp}` });
      const made = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: { root: `${projectPath}/${elsewhere}`, label: 'a tree with one instruction', state: 'ready' }
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, made.workspace];
      try {
        const conversation = await makeConversation(session, 'deleted-a-seed', {
          workspaceId: made.workspace.id
        });
        release(conversation);
        assert(seededFile(conversation, '.cursorrules'),
          'precondition: the tree it was born in seeded its instructions');

        conversation.rootMessageThread.removeContextItem(seededFile(conversation, '.cursorrules').id);
        assert(!seededFile(conversation, '.cursorrules'), 'precondition: the user threw it away');

        // The state a document written before the flag reaches its next send
        // in: no record that it was ever initialised, but still carrying which
        // tree its seeds were built for. That record is the whole guard — the
        // pass is skipped for a tree already answered, which is what leaves a
        // seed the user threw away thrown away.
        conversation.setMetadata(INITIALISED_KEY, false);
        await conversation.ensureInitialised();

        assert(conversation.workspaceId === made.workspace.id,
          `it still works where it was born, got ${JSON.stringify(conversation.workspaceId)}`);
        assert(!seededFile(conversation, '.cursorrules'),
          'and the seed they had already looked at and removed is not put back');
      } finally {
        session.workspaces = saved;
        await fetchJson(`/api/session/workspaces/${made.workspace.id}`, { method: 'DELETE', fallback: null });
        await project.copyTree({ to: '.', delete: [elsewhere] });
      }
    });

    await run('the same bytes under two names are seeded once, whoever pinned them', async () => {
      // A common setup keeps CLAUDE.md and AGENTS.md as one file under two
      // names. The insert-time dedup matches on path, so the hashes are what
      // collapse them — including the hash of a copy the user pinned before the
      // seeds went looking, which is otherwise the one way to get the same bytes
      // into one conversation twice.
      const stamp = Math.random().toString(36).slice(2, 8);
      const elsewhere = `seed-twins-${stamp}`;
      const shared = `# one file, two names ${stamp}`;
      const project = createBoundOps(() => ({ workspaceId: '' }));
      await writeFile({ path: `${elsewhere}/AGENTS.md`, content: shared });
      await writeFile({ path: `${elsewhere}/CLAUDE.md`, content: shared });
      const made = await fetchJson('/api/session/workspaces', {
        method: 'POST',
        body: { root: `${projectPath}/${elsewhere}`, label: 'a tree that keeps both', state: 'ready' }
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, made.workspace];
      try {
        const conversation = await makeConversation(session, 'pinned-one-of-a-pair');
        release(conversation);

        await conversation.rootMessageThread.executeContextItem('file-content', { path: 'AGENTS.md' });

        const moved = await rebindConversation(conversation, made.workspace.id);
        assert(moved.done, `the move went through, got ${JSON.stringify(moved)}`);

        assert(!seededFile(conversation, 'CLAUDE.md'),
          'the bytes the user already pinned are not seeded again under the other name');
        const theirs = conversation.rootMessageThread.contextItems
          .filter((/** @type {any} */ item) => item.type === 'file-content' && item.data.path === 'AGENTS.md');
        assert(theirs.length === 1,
          `and their own pin is left as the one copy of them, got ${theirs.length}`);
      } finally {
        session.workspaces = saved;
        await fetchJson(`/api/session/workspaces/${made.workspace.id}`, { method: 'DELETE', fallback: null });
        await project.copyTree({ to: '.', delete: [elsewhere] });
      }
    });

    await run('a conversation born from another inherits its workspace, already initialised', async () => {
      const source = await makeConversation(session, 'binding-source', { workspaceId: 'ws_inherited' });
      release(source);
      assert(source.workspaceId === 'ws_inherited',
        `a create can carry a binding, got ${JSON.stringify(source.workspaceId)}`);
      assert(source.initialised === true, 'and is seeded at birth, since nobody is being asked anything');

      const root = source.rootMessageThread;
      root.addUserMessage('something worth taking to its own tab');
      const newId = await source.copyItemsToNewTab(root, [root.items.length - 1], { name: 'inheritor' });
      assert(newId, 'the copy produced a conversation');
      const inheritor = session.conversations.get(newId);
      release(inheritor);

      assert(inheritor.workspaceId === 'ws_inherited',
        `the spawned conversation works in the same tree as the one that spawned it, got ${JSON.stringify(inheritor.workspaceId)}`);
      assert(inheritor.initialised === true,
        'and never waits to be asked — the question was answered by where it came from');
    });

    await run('a conversation born into a workspace goes to the top of its box, not the top of the bar', async () => {
      // A conversation born into a workspace goes to the front of its box, not
      // the front of the bar: its box is a place, and the tab belongs under the
      // header it was started from.
      // A tab of the project's own, made first so that the top of the bar is
      // demonstrably somewhere else: without one above it, "at the top of its
      // box" and "at the top of the bar" can be the same index and the case
      // proves nothing.
      const anchor = await makeConversation(session, 'above-the-box');
      release(anchor);

      const before = [...session.conversations.keys()];
      // Asked before the create, while the box is still as the bar is drawing
      // it: the top of the box when it has members, and the place its own row
      // names when it has none.
      const wanted = placeForNewConversation(session, registeredId);

      const made = await makeConversation(session, 'born-in-a-box', { workspaceId: registeredId });
      release(made);

      const after = [...session.conversations.keys()];
      const landed = after.indexOf(made.id);
      assert(landed > 0,
        `the top of the bar belongs to ${anchor.name}, and a conversation born into a box belongs in the box, got ${landed} of ${after.length}`);
      assert(landed === wanted,
        `it belongs at ${wanted}, the place its box is drawn at, got ${landed} of ${after.length}`);
      assert(after.slice(0, landed).join(',') === before.slice(0, landed).join(','),
        `and nothing above it moved to make room, got "${after.join(',')}" from "${before.join(',')}"`);
    });

    await run('a conversation born into no workspace is still the top tab', async () => {
      const before = [...session.conversations.keys()];
      const made = await makeConversation(session, 'born-at-the-top');
      release(made);

      const after = [...session.conversations.keys()];
      assert(after[0] === made.id,
        `the newest tab is the top tab wherever there is no box to be the top of, got "${after.join(',')}"`);
      assert(after.slice(1).join(',') === before.join(','),
        `and the strip below it is untouched, got "${after.join(',')}" from "${before.join(',')}"`);
    });

    await run('a duplicate carries the binding in the cloned document', async () => {
      const source = await makeConversation(session, 'duplicate-source', { workspaceId: 'ws_cloned' });
      release(source);

      const cloneId = await session.duplicateConversation(source.id);
      assert(cloneId, 'the duplicate produced a conversation');
      const clone = session.conversations.get(cloneId);
      release(clone);

      assert(clone.workspaceId === 'ws_cloned',
        `a clone works where its original did, got ${JSON.stringify(clone.workspaceId)}`);
      assert(clone.initialised === true,
        'and is as initialised as its original — the document was copied whole, seeds and all');
    });

  });
}
