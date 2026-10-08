//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The box header, the workspace panel, the move dialog, and reconcile.
 *
 * The surfaces a workspace is seen and steered through, and the sweep that puts
 * the table back together. A move is the act with the most to lose, so it is
 * confirmed before it happens — both trees named and addressed — refused
 * audibly when the service says no, and undone by nothing when it is declined.
 * @module unit-tests/conversation-workspace-move-test
 */

import { waitFor, assert } from '../utilities/test-helpers.js';
import { writeFileOp } from '../../js/services/ops-api.js';
import { createBoundOps } from '../../sdk/ops.js';
import { registerWorkspace, unregisterWorkspace, listWorkspaces } from '../../js/services/workspaces.js';
import {
  workspaceStatus,
  workspaceFinishOptions,
  PROVIDER_UNAVAILABLE
} from '../../js/services/workspace-provisioning.js';
import { reconcileWorkspaces } from '../../js/services/workspace-reconcile.js';
import { rebindConversation } from '../../js/services/workspace-rebinding.js';
import {
  setupRows,
  probeSetupAdoptions,
  adoptSetupRow
} from '../../js/services/workspace-places.js';
import workspaceProviderRegistry from '../../js/registries/workspace-provider-registry.js';
import { openWorkspaceMove } from '../../js/components/workspace-move-dialog.js';
import '../../js/components/workspace-box-header.js';
import '../../js/components/workspace-panel.js';
import {
  runWorkspaceSuite,
  FixtureProvider,
  abandonProvision,
  fileTurnsUp,
  makeConversation,
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
 * Run the conversation-workspace-move tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  return runWorkspaceSuite('conversation-workspace-move-test', async ({ run, session, projectPath, release }) => {
    await run('the box names the place; the panel says everything else about it', async () => {
      // Everything here is true of the TREE and not of whoever is working in
      // it — the label, the kind, the path, the endings — which is why it is
      // said once for the workspace instead of once inside each conversation's
      // composer. What is missing is as deliberate: moving ONE conversation
      // names none of the tabs in a box, so it is not here, and neither is the
      // project, which is drawn flat and has nothing to be finished with.
      //
      // The split between the two surfaces is the subject: a strip two hundred
      // pixels wide gets the name, and the panel a selected box opens gets
      // everything that wants room to be read and aimed at.
      const saved = session.workspaces;
      session.workspaces = [
        workspaceRow('ws_head', '/tmp/head-tree', {
          label: 'feat/heads',
          providerId: FixtureProvider.MANIFEST.id
        }),
        workspaceRow('ws_orphan', '/tmp/orphan-tree', {
          label: 'made by something gone',
          providerId: '@someone/uninstalled'
        })
      ];
      const header = /** @type {any} */ (document.createElement('workspace-box-header'));
      document.body.appendChild(header);
      const panel = /** @type {any} */ (document.createElement('workspace-panel'));
      document.body.appendChild(panel);
      panel.setSession(session);
      try {
        const bound = await makeConversation(session, 'header-bound', { workspaceId: 'ws_head' });
        release(bound);
        header.setContext({ session, workspace: session.workspaces[0] });

        const label = header.querySelector('.conversation-box-label');
        assert(label?.textContent === 'feat/heads',
          `the box names the place its conversations work in, got ${JSON.stringify(label?.textContent)}`);
        assert(!header.querySelector('button'),
          'and nothing else: a title, a status line and two buttons in the width of a tab is what the panel exists to undo');

        session.selectWorkspace('ws_head');
        panel._refresh();
        assert(panel.textContent?.includes('/tmp/head-tree'),
          `selecting it says which tree that is, got ${JSON.stringify(panel.textContent)}`);
        assert(panel.querySelector('[data-action="done"]'),
          `with the ways to be done with it, from the provider that made it, got ${JSON.stringify(panel.textContent)}`);
        assert(!panel.querySelector('[data-action="move"]'),
          'and not the move, which is one conversation\'s business and belongs on its tab');

        // An extension can be uninstalled while its workspaces stay on the
        // table. The conversations keep working; only what the provider
        // supplied goes, and it goes for a stated reason.
        session.selectWorkspace('ws_orphan');
        panel._refresh();
        assert(!panel.querySelector('[data-action]'),
          'a workspace whose provider is gone offers no endings');
        assert(panel.textContent?.includes(PROVIDER_UNAVAILABLE),
          `and says why rather than looking like a workspace with nothing to do, got ${JSON.stringify(panel.textContent)}`);
        assert(panel.querySelector('.workspace-panel-title')?.textContent === 'made by something gone',
          `keeping the row's own name, which nothing else here is left to say, got ${JSON.stringify(panel.textContent)}`);

        // A box is only ever drawn for a workspace there is something to say
        // about: the bar draws one per usable row and nothing for the rest. A
        // header told about no workspace draws nothing rather than a frame
        // around an empty statement.
        header.setContext({ session, workspace: null });
        assert(!header.querySelector('.conversation-box-title'),
          `a header about nothing shows nothing, got ${JSON.stringify(header.textContent)}`);
      } finally {
        header.remove();
        panel.remove();
        session.registry.select(null);
        document.body.classList.remove('workspace-selected');
        session.workspaces = saved;
      }
    });

    await run('an ending that asks for something is asked; one that does not is confirmed', async () => {
      // The host used to know one provider's action id by name — it collected a
      // commit message for anything called `commit` — which is a promise it
      // could only keep for the provider that was written first. An ending now
      // says for itself whether it needs something typed, and the panel asks
      // for it exactly when it is wanted.
      //
      // The two are asked for in different surfaces, which is the point of the
      // assertions below: an ending that wants something typed gets the finish
      // dialog, where the field is named; one that wants nothing gets a confirm.
      const saved = session.workspaces;
      session.workspaces = [
        workspaceRow('ws_asked', '/tmp/asked-tree', {
          label: 'feat/asked',
          providerId: FixtureProvider.MANIFEST.id
        })
      ];
      const panel = /** @type {any} */ (document.createElement('workspace-panel'));
      document.body.appendChild(panel);
      panel.setSession(session);
      /** @type {any[]} */
      const asked = [];
      const realModal = /** @type {any} */ (window).showModal;
      /** @type {any} */ (window).showModal = async (/** @type {any} */ request) => {
        asked.push(request);
        return request.type === 'prompt' ? 'a note' : true;
      };
      try {
        const bound = await makeConversation(session, 'header-asked', { workspaceId: 'ws_asked' });
        release(bound);
        session.selectWorkspace('ws_asked');
        panel._refresh();
        FixtureProvider.lastFinish = null;

        /** @type {any} */ (panel.querySelector('[data-action="note"]')).click();

        await waitFor(() => !!document.querySelector('.workspace-finish-overlay .setup-field-input'),
          'the finish dialog for an ending that asks for something');
        const dialog = /** @type {any} */ (document.querySelector('.workspace-finish-overlay'));
        assert(!asked.length,
          `an ending declaring a prompt gets its own dialog, not the generic box, got ${JSON.stringify(asked[0]?.type)}`);

        const caption = /** @type {any} */ (dialog.querySelector('label.setup-field-label'));
        const field = /** @type {any} */ (dialog.querySelector('.setup-field-input'));
        assert(caption?.htmlFor === field?.id && caption?.textContent === 'Note',
          `with the field named as the ending named it, got ${JSON.stringify(caption?.textContent)}`);
        assert(dialog.textContent?.includes('It is written into the workspace'),
          `and the hint the ending wrote, got ${JSON.stringify(dialog.textContent)}`);

        field.value = 'a note';
        field.dispatchEvent(new Event('input', { bubbles: true }));
        /** @type {any} */ (dialog.querySelector('.workspace-finish-commit')).click();

        await waitFor(() => FixtureProvider.lastFinish?.actionId === 'note',
          'the ending that asks for something to run');
        assert(FixtureProvider.lastFinish?.input?.message === 'a note',
          `and what was typed reaches finish, got ${JSON.stringify(FixtureProvider.lastFinish?.input)}`);

        asked.length = 0;
        FixtureProvider.lastFinish = null;
        panel._refresh();
        /** @type {any} */ (panel.querySelector('[data-action="leave"]')).click();
        await waitFor(() => FixtureProvider.lastFinish?.actionId === 'leave',
          'the ending that asks for nothing to run');
        assert(asked[0]?.type === 'confirm',
          `an ending declaring none is confirmed instead, got ${JSON.stringify(asked[0]?.type)}`);
        assert(!FixtureProvider.lastFinish?.input?.message,
          `and carries nothing it never collected, got ${JSON.stringify(FixtureProvider.lastFinish?.input)}`);
      } finally {
        /** @type {any} */ (window).showModal = realModal;
        panel.remove();
        session.registry.select(null);
        document.body.classList.remove('workspace-selected');
        session.workspaces = saved;
        FixtureProvider.lastFinish = null;
      }
    });

    await run('the panel says each thing once, in the order it is wanted', async () => {
      // A small menu found four ways to say "feat/menu", and every ending
      // printed the sentence the dialog was about to print again. What a row is
      // FOR decides where its words go: the head names the place, the state
      // section names the state, and the sentence somebody agrees to belongs
      // where they agree to it.
      const saved = session.workspaces;
      session.workspaces = [
        workspaceRow('ws_menu', '/tmp/menu-tree', {
          label: 'feat/menu (worktree)',
          providerId: FixtureProvider.MANIFEST.id
        })
      ];
      const panel = /** @type {any} */ (document.createElement('workspace-panel'));
      document.body.appendChild(panel);
      panel.setSession(session);
      /** @type {any[]} */
      const asked = [];
      const realModal = /** @type {any} */ (window).showModal;
      /** @type {any} */ (window).showModal = async (/** @type {any} */ request) => {
        asked.push(request);
        return request.type === 'prompt' ? '' : true;
      };
      FixtureProvider.reported = { detail: 'feat/menu · clean' };
      FixtureProvider.discardDescription = 'Removes the tree and deletes feat/menu.';
      try {
        const bound = await makeConversation(session, 'header-menu', { workspaceId: 'ws_menu' });
        release(bound);
        session.selectWorkspace('ws_menu');
        panel._refresh();
        await waitFor(() => panel.textContent?.includes('feat/menu · clean'),
          'the status the provider reported to reach the panel');

        const text = String(panel.textContent ?? '');
        const says = (/** @type {string} */ selector) =>
          panel.querySelector(`${selector} .workspace-panel-action-name`)?.textContent ?? '';
        assert(panel.querySelector('.workspace-panel-title')?.textContent === 'feat/menu (worktree)',
          `the panel names the place, which is the name on its row, got ${JSON.stringify(text)}`);
        assert(panel.querySelector('.workspace-panel-eyebrow')?.textContent
          === `Workspace · ${FixtureProvider.MANIFEST.name}`,
        `above a line saying what it is and which kind of one, got ${JSON.stringify(text)}`);
        assert(text.includes('/tmp/menu-tree') && text.includes('feat/menu · clean'),
          `then where it is and what its provider says about it, got ${JSON.stringify(text)}`);
        assert(text.split('(worktree)').length - 1 === 1,
          `each of which is said once: a small menu once found four ways to say "feat/menu", got ${JSON.stringify(text)}`);

        // The address, whole and in one piece. Anything that elides part of a
        // path hides the one segment that tells two places apart: every scratch
        // copy ever made ends in the same `work` directory, and what it is a
        // copy OF is the segment above that — which is exactly what an ellipsis
        // ate.
        const box = panel.querySelector('.workspace-panel-path');
        assert(box?.textContent === '/tmp/menu-tree',
          `the path is shown whole, in one element, got ${JSON.stringify(box?.textContent)}`);
        const acts = (/** @type {string} */ selector) =>
          panel.querySelector(`.workspace-panel-path-row ${selector}`);
        assert(acts('[aria-label="Copy path to clipboard"]') && acts('reveal-button'),
          'and carries the copy and reveal buttons every other path in the app has');

        // Left edges, because the fault this catches — `align-items: center`
        // inherited into a column, which centres every stacked section —
        // changes no class name and nothing else would see it.
        const edge = (/** @type {any} */ element) => element?.getBoundingClientRect().left ?? -1;
        const starts = [
          panel.querySelector('.workspace-panel-eyebrow'),
          panel.querySelector('.workspace-panel-title'),
          ...panel.querySelectorAll('.workspace-panel-heading'),
          ...panel.querySelectorAll('.workspace-panel-action')
        ];
        const gutter = edge(starts[0]);
        assert(gutter > 0 && starts.every((/** @type {any} */ line) => Math.abs(edge(line) - gutter) < 1),
          `every section starts at the same edge, got ${JSON.stringify(starts.map(edge))}`);
        assert(Math.abs(edge(panel.querySelector('.workspace-panel-path-row')) - gutter) < 1,
          'and so does the path');

        // What pressing a button will do is written under it, where it is read
        // BEFORE the decision. A label cannot carry it: "Leave it be" does not
        // say whether anything on disk is about to go, and a sentence somebody
        // has to hover to find is a sentence nobody reads. An ending says what
        // becomes of the PLACE; what becomes of the conversations working in it
        // is the host's to say, since it is the host that moves them and a
        // provider cannot know how many there are.
        const note = (/** @type {string} */ selector) =>
          panel.querySelector(`${selector} .workspace-panel-action-note`)?.textContent ?? '';
        assert(note('[data-action="leave"]').includes('Nothing changes on disk'),
          `every ending says what becomes of the tree, got ${JSON.stringify(note('[data-action="leave"]'))}`);
        assert(says('[data-action="note"]') === 'Leave a note…',
          `one that will ask for something says so with an ellipsis, got ${JSON.stringify(says('[data-action="note"]'))}`);
        assert(says('[data-action="leave"]') === 'Leave it be',
          'and one that only needs agreeing to does not');

        // An action that leaves the workspace in use is not an ending and is not
        // grouped with one: committing is the case this exists for, and it sat
        // among the endings for as long as it closed the workspace half the
        // time. What separates them is the rule above the endings, not a
        // sentence — each of these labels already says whether the workspace
        // survives it.
        const endings = panel.querySelector('.workspace-panel-endings');
        assert(!endings?.querySelector('.workspace-panel-heading'),
          'the endings carry no heading: every one of them says outright what it ends');
        const doing = [...panel.querySelectorAll('.workspace-panel-doing [data-action]')];
        assert(doing.map((/** @type {any} */ row) => row.dataset.action).join(',') === 'note',
          `what keeps the workspace sits above the rule, got ${JSON.stringify(doing.map((/** @type {any} */ row) => row.textContent))}`);
        assert([...endings.querySelectorAll('[data-action]')]
          .map((/** @type {any} */ row) => row.dataset.action).join(',') === 'done,leave,discard',
        'and every way of not working here any more sits below it');

        // A destructive ending is marked as one. That is what warns, and it
        // warns wherever the button happens to sit.
        assert(panel.querySelector('[data-action="discard"]')?.classList.contains('danger')
          && !panel.querySelector('[data-action="leave"]')?.classList.contains('danger'),
        'an ending that takes something away is marked, and one that does not is not');

        // And again at the point of no return, where it is agreed to.
        asked.length = 0;
        FixtureProvider.lastFinish = null;
        /** @type {any} */ (panel.querySelector('[data-action="discard"]')).click();
        await waitFor(() => FixtureProvider.lastFinish?.actionId === 'discard',
          'the destructive ending to run once it is agreed to');
        assert(String(asked[0]?.message ?? '').includes('Removes the tree and deletes feat/menu.'),
          `with what it costs said in the dialog, got ${JSON.stringify(asked[0]?.message)}`);
      } finally {
        /** @type {any} */ (window).showModal = realModal;
        panel.remove();
        session.registry.select(null);
        document.body.classList.remove('workspace-selected');
        session.workspaces = saved;
        FixtureProvider.reported = null;
        FixtureProvider.discardDescription = null;
        FixtureProvider.lastFinish = null;
      }
    });

    await run('the dialog confirms a move, and the instructions move with it', async () => {
      // The box header reports and finishes; this is where one conversation
      // that has been dragged somewhere else is asked whether that is really
      // what was meant. The move itself is `rebindConversation`'s — what the
      // dialog adds is the pause before it, which is why the assertion below is
      // about the instructions the model reads and not only about the id in the
      // metadata.
      const stamp = Math.random().toString(36).slice(2, 8);
      const from = `dialog-from-${stamp}`;
      const to = `dialog-to-${stamp}`;
      const fromMarker = `# instructions of the tree it started in ${stamp}`;
      const toMarker = `# instructions of the tree it moved to ${stamp}`;
      const project = createBoundOps(() => ({ workspaceId: '' }));
      await writeFileOp({ path: `${from}/AGENTS.md`, content: fromMarker });
      await writeFileOp({ path: `${to}/AGENTS.md`, content: toMarker });
      const madeFrom = await registerWorkspace({
        root: `${projectPath}/${from}`, label: 'where it started', state: 'ready'
      });
      const madeTo = await registerWorkspace({
        root: `${projectPath}/${to}`, label: 'where it moved to', state: 'ready'
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, madeFrom, madeTo];
      // Lanes share one project fixture and another of them builds git
      // repositories in it, so whether the tree being left reads as dirty is
      // not this case's business: whatever is asked, the answer is yes.
      const realModal = /** @type {any} */ (window).showModal;
      /** @type {any} */ (window).showModal = async () => true;
      try {
        const moved = await makeConversation(session, 'moved-by-the-dialog',
          { workspaceId: madeFrom.id });
        release(moved);
        const before = await seededFile(moved, 'AGENTS.md').createContextText({ forRequest: true });
        assert(before.includes(fromMarker),
          `precondition: it reads the instructions of the tree it starts in, got ${JSON.stringify(before)}`);
        await waitFor(() => typeof seededFile(moved, 'AGENTS.md')?.data.content === 'string',
          { description: 'the snapshot to reach the document' });

        const settled = openWorkspaceMove(moved, madeTo.id);
        const dialog = /** @type {any} */ (document.querySelector('.workspace-move-overlay'));
        assert(dialog, 'opening it puts a dialog on screen');
        // Both ends of the move, and an address is only a fact when it is
        // whole: what is being confirmed is which two trees these are, so each
        // is stated in full rather than named and left to be guessed at.
        const leaving = dialog.querySelector('.workspace-move-from .workspace-move-now-path');
        assert(leaving?.textContent === `${projectPath}/${from}`,
          `the tree being left is stated in full, got ${JSON.stringify(leaving?.textContent)}`);
        const arriving = dialog.querySelector('.workspace-move-to .workspace-move-now-path');
        assert(arriving?.textContent === `${projectPath}/${to}`,
          `and so is the one being moved into, got ${JSON.stringify(arriving?.textContent)}`);
        assert(/where it started/.test(String(dialog.querySelector('.workspace-move-from')?.textContent ?? ''))
          && /where it moved to/.test(String(dialog.querySelector('.workspace-move-to')?.textContent ?? '')),
        `each named as well as addressed, got ${JSON.stringify(dialog.textContent)}`);
        assert(dialog.querySelector('.workspace-move-now [aria-label="Copy path to clipboard"]')
          && dialog.querySelector('.workspace-move-now reveal-button'),
        'and can be copied or shown on disk without leaving the dialog');
        // Where it is going was settled by the drag that opened this. Offering
        // anywhere else would be asking a question already answered.
        assert(!dialog.querySelector('.setup-row'),
          `nowhere else is offered, got ${JSON.stringify(dialog.textContent)}`);
        assert(!(/** @type {HTMLButtonElement} */ (dialog.querySelector('.workspace-move-commit')).disabled),
          'and the one thing it can do is ready to be pressed');

        /** @type {any} */ (dialog.querySelector('.workspace-move-commit')).click();
        const outcome = await settled;
        assert(outcome.moved === true && moved.workspaceId === madeTo.id,
          `pressing it moves the conversation, got ${JSON.stringify(outcome)}`);
        assert(!document.querySelector('.workspace-move-overlay'),
          'and the dialog closes behind it');

        await waitFor(() => (seededFile(moved, 'AGENTS.md')?.data.content || '') !== before,
          { description: 'the move to take the snapshot again' });
        const after = await seededFile(moved, 'AGENTS.md').createContextText({});
        assert(after.includes(toMarker),
          `a conversation moved through the dialog reads the instructions of the tree it is in, got ${JSON.stringify(after)}`);

        // The other answer. A confirmation that moved things anyway would be
        // worse than no confirmation, because it would be trusted.
        const staying = await makeConversation(session, 'asked-and-declined',
          { workspaceId: madeFrom.id });
        release(staying);
        const declined = openWorkspaceMove(staying, madeTo.id);
        /** @type {any} */ (document.querySelector('.workspace-move-cancel')).click();
        const refused = await declined;
        assert(refused.moved === false && staying.workspaceId === madeFrom.id,
          `cancelling leaves it where it was, got ${JSON.stringify(refused)}`);
      } finally {
        /** @type {any} */ (window).showModal = realModal;
        // An assertion that fails between opening the dialog and pressing it
        // leaves the overlay on screen, and every case after this one queries
        // for one and finds it — one failure then reads as the whole suite
        // hanging. Whatever happened above, the screen is cleared here.
        document.querySelector('.workspace-move-overlay')?.remove();
        session.workspaces = saved;
        await unregisterWorkspace(madeFrom.id).catch(() => {});
        await unregisterWorkspace(madeTo.id).catch(() => {});
        await project.copyTree({ to: '.', delete: [from, to] });
      }
    });

    await run('a move the service refuses is said in the dialog, not swallowed', async () => {
      // The refusal belongs to `rebindConversation` — a service whose safety
      // lives in its caller has none — so what is tested here is that the caller
      // does something with the answer. A dialog that closes on a refusal would
      // read as a move that happened.
      const made = await registerWorkspace({
        root: `${projectPath}/src`, label: 'somewhere it cannot go yet', state: 'ready'
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, made];
      // As above: the shared fixture's cleanliness is another case's subject.
      const realModal = /** @type {any} */ (window).showModal;
      /** @type {any} */ (window).showModal = async () => true;
      try {
        const busy = await makeConversation(session, 'busy-when-asked-to-move');
        release(busy);
        Object.defineProperty(busy, 'isProcessing', { get: () => true, configurable: true });

        const settled = openWorkspaceMove(busy, made.id);
        const dialog = /** @type {any} */ (document.querySelector('.workspace-move-overlay'));
        /** @type {any} */ (dialog.querySelector('.workspace-move-commit')).click();

        await waitFor(() => document.querySelector('.workspace-move-overlay .setup-error'),
          { description: 'the refusal to be shown where it was asked for' });
        const said = document.querySelector('.workspace-move-overlay .setup-error')?.textContent ?? '';
        assert(/turn/i.test(said),
          `and to say what stopped it, got ${JSON.stringify(said)}`);
        assert((busy.workspaceId || '') === '',
          `with the conversation left where it was, got ${JSON.stringify(busy.workspaceId)}`);

        // The dialog is still open on the same question, so the answer to "now
        // then?" is one press rather than starting again.
        Object.defineProperty(busy, 'isProcessing', { get: () => false, configurable: true });
        /** @type {any} */ (document.querySelector('.workspace-move-commit')).click();
        const outcome = await settled;
        assert(outcome.moved === true && busy.workspaceId === made.id,
          `and once the turn is over the same press goes through, got ${JSON.stringify(outcome)}`);
      } finally {
        /** @type {any} */ (window).showModal = realModal;
        session.workspaces = saved;
        await unregisterWorkspace(made.id).catch(() => {});
      }
    });

    // The three cases below share one thing that can only happen once: the
    // server's reconcile claim is spent by the first client that asks for it.
    // They therefore run in this order deliberately — the first proves it does
    // NOT spend the claim, and the proof of that is the second one still
    // getting it.
    await run('a client with no providers loaded leaves the claim for one that has', async () => {
      // The engine realm is the case this is really about: it runs a
      // ConnectionManager too, and has no provider registry at all. It cannot
      // be stood up inside a viewer test, but the condition that matters is the
      // same one — nothing loaded that could do the work — and burning the
      // one-shot claim from there would disable reconcile for the whole run.
      workspaceProviderRegistry.reset();
      let pass;
      try {
        pass = await reconcileWorkspaces(session);
      } finally {
        workspaceProviderRegistry.registerClass(FixtureProvider, { extensionId: 'test', modulePath: '(test)' });
      }
      assert(pass.ran === false,
        'a client that can reconcile nothing does not offer to');
      assert(/no workspace providers/.test(pass.reason ?? ''),
        `and says why, got ${JSON.stringify(pass.reason)}`);
    });

    await run('reconcile undoes an interrupted provision and leaves other providers alone', async () => {
      const name = `fixture-sweep-${Math.random().toString(36).slice(2, 8)}`;
      const dir = `${projectPath}/${name}`;
      const projectOps = createBoundOps(() => ({}));

      // One row this provider made and never finished, and one belonging to a
      // provider nothing has loaded — an extension the user disabled after
      // making a workspace with it.
      const mine = await abandonProvision(session, { dir, dirStallMs: 2000 },
        () => fileTurnsUp(projectOps, name, 5000).then(() => {}));
      const theirs = await registerWorkspace({
        kind: 'local',
        root: `${projectPath}/src`,
        providerId: '@someone/uninstalled',
        state: 'provisioning',
        meta: { dir: `${projectPath}/src` }
      });
      // And a third: a place that is still there but is no longer what its row
      // says — a pooled tree switched to another branch while the app was shut.
      // It is the one failure nothing downstream catches, because every
      // operation against it succeeds, so the sweep closes it here.
      const moved = await registerWorkspace({
        kind: 'local',
        root: `${projectPath}/src`,
        providerId: FixtureProvider.MANIFEST.id,
        state: 'ready',
        meta: { dir: `${projectPath}/src` }
      });
      FixtureProvider.report = {
        orphanedWorkspaces: [{ ...moved, tombstone: true, reason: 'it is on somebody/else now.' }],
        orphanedArtifacts: [],
        confirmed: []
      };

      try {
        const pass = await reconcileWorkspaces(session);
        assert(pass.ran === true,
          `this client took the claim, got ${JSON.stringify(pass.reason)}`);
        assert(pass.cleaned.includes(mine.id),
          `the interrupted provision was undone and removed, got ${JSON.stringify(pass.cleaned)}`);
        assert(!(await projectOps.stat({ path: name })).exists,
          'and what it had built is gone from disk');

        const remaining = await listWorkspaces();
        assert(remaining.some(ws => ws.id === theirs.id),
          'while the row whose provider is not loaded is left exactly where it was');
        assert((await projectOps.stat({ path: 'src' })).exists,
          'and nothing of its went near the tree it names');

        const tombstoned = remaining.find(ws => ws.id === moved.id);
        assert(tombstoned?.state === 'closed',
          `a row its provider says is no longer what it claims is closed, got ${JSON.stringify(tombstoned?.state)}`);
        assert(/somebody\/else/.test(String(tombstoned?.meta?.closedReason ?? '')),
          `carrying the reason, for the banner its conversations will show, got ${JSON.stringify(tombstoned?.meta)}`);
        assert((await projectOps.stat({ path: 'src' })).exists,
          'and closing a row is not removing a tree — the place itself is untouched');
      } finally {
        FixtureProvider.report = null;
        await unregisterWorkspace(moved.id).catch(() => {});
        await unregisterWorkspace(theirs.id).catch(() => {});
        await unregisterWorkspace(mine.id).catch(() => {});
      }
    });

    await run('a place with no workspace is offered, adopted in one click, and then bindable', async () => {
      // The cheapest honest version of pooled working: a tree that exists and is
      // already built is one click from being somewhere a conversation works,
      // with no pool-release machinery and no fresh-tree recompile.
      const name = `adopt-me-${Math.random().toString(36).slice(2, 8)}`;
      const dir = `${projectPath}/${name}`;
      // A second tree, found by the same sweep and belonging to nothing this
      // case is about. The offer band lists what every provider can find, and
      // the project root is shared, so "the offer" is never this case's offer
      // on its own: an assertion that counted the adopt rows, or read the only
      // one, was asserting that no sibling case had a tree of its own out at
      // the same moment. Every assertion below names its tree by the id the row
      // carries, and the decoy is what holds them to it.
      const decoy = `adopt-decoy-${Math.random().toString(36).slice(2, 8)}`;
      const decoyDir = `${projectPath}/${decoy}`;
      /**
       * @param {string} tree - The directory whose offer is wanted.
       * @returns {(row: any) => boolean} Whether a row is that tree's offer.
       */
      const offerOf = (tree) => (row) =>
        row.kind === 'adopt' && String(row.id).endsWith(`\u0000${tree}`);
      const projectOps = createBoundOps(() => ({}));
      const saved = session.workspaces;
      /** @type {any} */
      let adopted = null;
      /** @type {any} The decoy, taken up at the end so the offer table is left as it was found. */
      let adoptedDecoy = null;
      try {
        await projectOps.shell({ command: `mkdir -p ${name} ${decoy}` });
        FixtureProvider.report = {
          orphanedWorkspaces: [],
          orphanedArtifacts: [{
            id: `fixture\u0000${name}`,
            label: name,
            detail: 'somewhere with no workspace',
            workspace: { root: dir, label: `${name} (adopted)`, meta: { dir } }
          }, {
            id: `fixture\u0000${decoy}`,
            label: decoy,
            detail: 'somewhere else with no workspace',
            workspace: { root: decoyDir, label: decoy, meta: { dir: decoyDir } }
          }],
          confirmed: []
        };

        await probeSetupAdoptions(session);
        const offered = setupRows(session).filter(offerOf(name));
        assert(offered.length === 1 && offered[0]?.label === name,
          `what exists and has no row is offered in the panel, got ${JSON.stringify(offered)}`);
        assert(setupRows(session).some(offerOf(decoy)),
          'alongside every other place a provider can find, which is no business of this case');

        adopted = await adoptSetupRow(session, String(offered[0]?.id));
        assert(adopted?.state === 'ready',
          `adopting registers it, ready to be worked in, got ${JSON.stringify(adopted)}`);
        assert(adopted?.providerId === FixtureProvider.MANIFEST.id,
          `owned by the provider that found it, so it can be finished with, got ${JSON.stringify(adopted?.providerId)}`);
        assert(adopted?.root === dir,
          `where the provider said it was, got ${JSON.stringify(adopted?.root)}`);

        session.workspaces = [...saved, adopted];
        const rows = setupRows(session);
        assert(rows.some((/** @type {any} */ row) => row.kind === 'workspace' && row.id === adopted.id),
          'and it is then offered exactly where every other workspace is');
        assert(!rows.some(offerOf(name)),
          'while the offer to adopt it is gone, having been taken');
        // What "gone" is measured against. An adopt band that emptied would
        // satisfy the line above without the offer having been taken at all.
        const stray = rows.find(offerOf(decoy));
        assert(stray,
          'and the offer nobody took is still there, which is what makes the one above an answer about this tree');

        // Taken up as well, because the offer table belongs to the panel rather
        // than to this case: an offer invented here and left on it is the fault
        // the decoy exists to catch, arriving one case later.
        adoptedDecoy = await adoptSetupRow(session, String(stray?.id));
      } finally {
        FixtureProvider.report = null;
        session.workspaces = saved;
        if (adopted) await unregisterWorkspace(adopted.id).catch(() => {});
        if (adoptedDecoy) await unregisterWorkspace(adoptedDecoy.id).catch(() => {});
        await projectOps.shell({ command: `rm -rf ${name} ${decoy}` }).catch(() => {});
      }
    });

    await run('a workspace outlives the provider that made it', async () => {
      // The guarantee the whole indirection was built for. An extension can be
      // disabled at any moment, and when it is, the conversations bound to the
      // workspaces it made must lose the provider's FEATURES and nothing else.
      // `src/` again, because `greeter.js` exists only there: a read that
      // quietly resolved against the project would come back missing.
      const made = await registerWorkspace({
        root: `${projectPath}/src`,
        label: 'made by something no longer installed',
        providerId: '@someone/uninstalled',
        state: 'ready'
      });
      const saved = session.workspaces;
      session.workspaces = [...saved, made];
      try {
        const bound = await makeConversation(session, 'orphaned-provider', { workspaceId: made.id });
        release(bound);
        const read = await readIn(session, bound, 'greeter.js');
        assert(read.exists !== false,
          `a bound conversation still works in its tree with no provider loaded, got ${JSON.stringify(read)}`);
        assert(bound.workspaceRoot === `${projectPath}/src`,
          `and still resolves its binding, got ${JSON.stringify(bound.workspaceRoot)}`);

        const status = await workspaceStatus(session, made);
        assert(status.providerMissing === true && status.problem === PROVIDER_UNAVAILABLE,
          `status says the provider is gone rather than throwing, got ${JSON.stringify(status)}`);
        assert(!status.detail,
          `and says it as a problem, not as a description of the tree, got ${JSON.stringify(status.detail)}`);
        assert(made.label === 'made by something no longer installed',
          `while the row goes on naming the workspace, which is what every surface reads, got ${JSON.stringify(made.label)}`);

        const finish = await workspaceFinishOptions(session, made);
        assert(finish.options.length === 0 && finish.unavailableReason === PROVIDER_UNAVAILABLE,
          `and the finish menu is empty for a stated reason rather than silently, got ${JSON.stringify(finish)}`);
      } finally {
        session.workspaces = saved;
        await unregisterWorkspace(made.id).catch(() => {});
      }
    });

    await run('the folders a conversation may write to move with it', async () => {
      // A grant is an absolute path, frozen at the moment it was given. Left
      // alone by a move, every one of them describes the tree the conversation
      // has just left: the folders it works in daily start asking again, while
      // the stale grants go on quietly authorising the tree it was moved out of.
      const saved = session.workspaces;
      session.workspaces = [...saved, workspaceRow('ws_grants', '/tmp/grants-tree')];
      const moved = await makeConversation(session, 'grants-follow-the-move');
      release(moved);
      const messageThread = moved.rootMessageThread;
      const projectWide = `${projectPath}/generated`;
      try {
        messageThread.addAllowedPath(`${projectPath}/vendor`);
        messageThread.addAllowedPath(projectWide, { scope: 'session' });
        messageThread.addAllowedPath('/tmp/somewhere-else');

        await rebindConversation(moved, 'ws_grants');
        const allowed = messageThread.getAllowedPaths();

        assert(allowed.includes('/tmp/grants-tree/vendor'),
          `the grant follows the conversation into the new tree, got ${JSON.stringify(allowed)}`);
        assert(!allowed.includes(`${projectPath}/vendor`),
          `and stops authorising the tree it left, got ${JSON.stringify(allowed)}`);

        // A session grant belongs to the project and to every conversation in
        // it, so a move copies it rather than editing it out from under them.
        assert(allowed.includes('/tmp/grants-tree/generated'),
          `a project-wide grant is re-rooted for the conversation that moved, got ${JSON.stringify(allowed)}`);
        const entry = messageThread.getAllowedPathEntries().find(p => p.path === projectWide);
        assert(entry && entry.scope === 'session',
          `while the project-wide entry itself is left where it stands, got ${JSON.stringify(entry)}`);

        assert(allowed.includes('/tmp/somewhere-else'),
          `and a grant that was never in the old tree is untouched, got ${JSON.stringify(allowed)}`);

        // Moving is something people do repeatedly, and a grant rewritten on
        // every move must not leave a copy of itself behind each time.
        await rebindConversation(moved, '');
        assert(messageThread.getAllowedPaths().includes(`${projectPath}/vendor`),
          `a move back re-roots the grant back, got ${JSON.stringify(messageThread.getAllowedPaths())}`);
        await rebindConversation(moved, 'ws_grants');
        const after = messageThread.getAllowedPaths();
        assert(after.filter(p => p === '/tmp/grants-tree/vendor').length === 1,
          `and a second move re-roots rather than accumulating, got ${JSON.stringify(after)}`);
      } finally {
        for (const p of messageThread.getAllowedPathEntries()) {
          if (!p.implicit && p.scope === 'session') messageThread.removeAllowedPath(p.id);
        }
        session.workspaces = saved;
      }
    });

    await run('a second client finds the reconcile already claimed', async () => {
      const pass = await reconcileWorkspaces(session);
      assert(pass.ran === false,
        'the claim answers yes once and no afterwards');
      assert(/another client/.test(pass.reason ?? ''),
        `and the second client is told which of the two reasons applies, got ${JSON.stringify(pass.reason)}`);
    });
  });
}
