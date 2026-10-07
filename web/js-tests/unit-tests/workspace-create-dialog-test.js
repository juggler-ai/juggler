//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Making a workspace with no conversation in the question.
 *
 * The dialog the tab strip opens. What is asserted here is mostly what it does
 * NOT do: it offers no place that already exists, because offering one would be
 * offering to do nothing; it binds nothing, seeds nothing, and leaves a
 * workspace with no conversations in it, which is the whole point of being able
 * to make one before there is anything to put inside. The rest is the shape of
 * a master-and-detail dialog — that the kind chosen on the way in has its form
 * and its provider's advice on screen without a click to get them there.
 * @module unit-tests/workspace-create-dialog-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import { createBoundOps } from '../../sdk/ops.js';
import { unregisterWorkspace } from '../../js/services/workspaces.js';
import { setupRows, probeSetupAdoptions, adoptSetupRow, NEW_ROW_PREFIX } from '../../js/services/workspace-places.js';
import {
  openWorkspaceCreate,
  workspaceCreatePlaces
} from '../../js/components/workspace-create-dialog.js';
import WorkspaceProvider from '../../sdk/workspace-provider.js';
import workspaceProviderRegistry from '../../js/registries/workspace-provider-registry.js';
import {
  runWorkspaceSuite,
  FixtureProvider
} from '../utilities/conversation-workspace-helpers.js';

/**
 * A second kind, so that the rail has something to walk between. It builds
 * nothing: every case that reaches a provision uses the fixture, and this one
 * exists to be a row — and to be a taller form than the one beside it, because
 * a dialog sized to its contents is one that changes size on the way between
 * two kinds, and nothing is proved about that by two forms of one field.
 */
class SecondKindProvider extends WorkspaceProvider {
  static MANIFEST = {
    id: 'second-kind-workspace-provider',
    name: 'Somewhere else again',
    version: '1.0.0',
    description: 'Stands in the list so there are two kinds to walk between'
  };

  /** @param {HTMLElement} container - Where its fields go. */
  renderSetup(container) {
    const field = document.createElement('input');
    field.type = 'text';
    field.id = 'second-kind-dir';
    container.appendChild(field);
    this._field = field;

    // The rest are furniture, at the length of a real provider's form: the one
    // that makes a worktree asks for a repository, a base, a branch and a
    // location, and says something about each.
    for (let extra = 0; extra < 6; extra++) {
      const line = document.createElement('div');
      line.className = 'setup-field';
      line.textContent = 'Another thing this kind wants to know';
      container.appendChild(line);
    }
  }

  /** @returns {any} What the form says, and whether Create may be pressed. */
  getSetupValue() {
    const dir = this._field?.value ?? '';
    return dir ? { valid: true, values: { dir } } : { valid: false, values: {}, invalidFieldId: 'second-kind-dir' };
  }
}

/**
 * It builds directories in the shared fixture root, which a sibling lane
 * walking the project reads as they come and go.
 * @type {boolean}
 */
export const needsExclusiveRun = true;

/**
 * The dialog's rows, as the DOM holds them.
 * @returns {HTMLElement[]} Every place row on screen.
 */
function rowsOnScreen() {
  return /** @type {HTMLElement[]} */ (Array.from(document.querySelectorAll('.workspace-create-overlay .setup-row')));
}

/**
 * Choose a kind in the rail by its provider, the way a click does.
 *
 * By id rather than by position: which kind the rail leads with is the host's
 * decision and depends on what else the lane has registered, and a case about
 * the fixture's form is not a case about the order of the list.
 * @param {string} providerId - The kind to choose.
 */
function choose(providerId) {
  const row = rowsOnScreen().find((candidate) => candidate.dataset.rowId === `${NEW_ROW_PREFIX}${providerId}`);
  if (!row) throw new Error(`no row for ${providerId} on screen`);
  if (row.getAttribute('aria-checked') !== 'true') row.click();
}

/**
 * Put the fixture's form on screen in a dialog that has just been opened.
 * @returns {Promise<void>} Once its field is there to type into.
 */
async function chooseFixture() {
  await waitFor(() => rowsOnScreen().length > 0, 2000);
  choose(FixtureProvider.MANIFEST.id);
  await waitFor(() => document.querySelector('.workspace-create-overlay #fixture-dir') !== null, 2000);
}

/**
 * Fill the fixture provider's directory field and report the edit, the way a
 * keystroke does.
 * @param {string} dir - Where the workspace is going.
 */
function typeDirectory(dir) {
  const field = /** @type {HTMLInputElement|null} */ (document.querySelector('.workspace-create-overlay #fixture-dir'));
  if (!field) throw new Error('the fixture provider\'s form is not on screen');
  field.value = dir;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * What a row's fill actually looks like: its own background, laid over the
 * surface it sits on.
 *
 * Computed style reports what was declared, so white at 10% opacity reads as a
 * colour even when the panel beneath it is white — which is precisely the state
 * a reader sees nothing in. Anything asking whether a fill can be SEEN has to
 * do the compositing itself.
 * @param {HTMLElement} element - The row.
 * @param {HTMLElement} surface - What it is drawn on.
 * @returns {number[]} Red, green and blue, as the screen gets them.
 */
function overSurface(element, surface) {
  const channels = (/** @type {string} */ value) => (value.match(/[\d.]+/g) ?? []).map(Number);
  const top = channels(getComputedStyle(element).backgroundColor);
  const under = channels(getComputedStyle(surface).backgroundColor);
  const alpha = top[3] ?? 1;
  return [0, 1, 2].map((i) => (top[i] ?? 0) * alpha + (under[i] ?? 0) * (1 - alpha));
}

/**
 * Press one of the dialog's buttons.
 * @param {string} selector - Which one.
 */
function press(selector) {
  const button = /** @type {HTMLButtonElement|null} */ (document.querySelector(`.workspace-create-overlay ${selector}`));
  if (!button) throw new Error(`no ${selector} on screen`);
  button.click();
}

/**
 * Run the workspace-create-dialog tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  return runWorkspaceSuite('workspace-create-dialog-test', async ({ run, session, projectPath }) => {
    const projectOps = createBoundOps(() => ({}));

    // Registered rather than reset into place, like the fixture: a reset would
    // take the real providers out from under whatever else is on this page, and
    // an id nobody else uses needs no room made for it. The cases choose the
    // kind they are about by id (see `choose`), so which kind the dialog opens
    // on is up to the rail's own order.
    if (!workspaceProviderRegistry.get(SecondKindProvider.MANIFEST.id)) {
      workspaceProviderRegistry.registerClass(SecondKindProvider, { extensionId: 'test', modulePath: '(test)' });
    }

    await run('it offers only the ways to make one', async () => {
      // The suite has a registered workspace on the table and the session has a
      // project, so both of the bands this dialog drops are populated: if it
      // were sharing the setup panel's list they would be here.
      const everywhere = setupRows(session);
      assert(everywhere.some((row) => row.kind === 'project'),
        'the shared list still offers the project folder');
      assert(everywhere.some((row) => row.kind === 'workspace'),
        'and the workspace this suite registered');

      const offered = workspaceCreatePlaces(session);
      assert(!offered.some((row) => row.kind === 'project' || row.kind === 'workspace'),
        `but making one offers neither, got ${JSON.stringify(offered.map((row) => row.kind))}`);
      assert(offered.some((row) => row.kind === 'new'),
        'and does offer the providers that could build one');

      const settled = openWorkspaceCreate(session);
      try {
        await waitFor(() => rowsOnScreen().length > 0, 2000);
        const kinds = rowsOnScreen().map((row) => row.dataset.rowKind);
        assert(!kinds.includes('project') && !kinds.includes('workspace'),
          `and draws neither either, got ${JSON.stringify(kinds)}`);
      } finally {
        press('.workspace-create-cancel');
        await settled;
      }
    });

    await run('it opens on a kind, with that kind\'s advice beside its form', async () => {
      const settled = openWorkspaceCreate(session);
      try {
        await waitFor(() => document.querySelector('.workspace-create-detail') !== null, 2000);
        let detail = /** @type {HTMLElement} */ (document.querySelector('.workspace-create-detail'));

        // Whichever kind leads the rail is chosen on the way in, and its half
        // is already filled.
        const opened = rowsOnScreen().find((row) => row.getAttribute('aria-checked') === 'true');
        assert(opened?.dataset.rowKind === 'new',
          `the dialog opens on a kind, got ${JSON.stringify(opened?.dataset.rowId)}`);
        const openedName = workspaceProviderRegistry
          .createProvider(String(opened?.dataset.rowId).slice(NEW_ROW_PREFIX.length), session)
          ?.getManifest().name;
        assert(detail.querySelector('.workspace-create-detail-title')?.textContent === openedName,
          `the chosen kind names itself in its own half, got ${JSON.stringify(detail.textContent)}`);

        choose(FixtureProvider.MANIFEST.id);
        await waitFor(() => document.querySelector('.workspace-create-overlay #fixture-dir') !== null, 2000);
        detail = /** @type {HTMLElement} */ (document.querySelector('.workspace-create-detail'));
        assert(detail.querySelector('.workspace-create-detail-title')?.textContent === FixtureProvider.MANIFEST.name,
          `and choosing another names that one instead, got ${JSON.stringify(detail.textContent)}`);
        // The point of splitting the dialog: what a provider says one of its
        // places is good and bad for is on screen while the form is filled in,
        // rather than behind the click that selects the row.
        assert(detail.textContent?.includes('a test that wants to read its own advice back'),
          `with what it is best for, unasked, got ${JSON.stringify(detail.textContent)}`);
        assert(detail.textContent?.includes('anything anybody is relying on'),
          `and what it is not for, got ${JSON.stringify(detail.textContent)}`);
        assert(detail.querySelector('#fixture-dir'),
          'and the provider\'s own fields, with no click to get to them');

        // Nothing is built by arriving: a selection says which form is showing.
        const create = /** @type {HTMLButtonElement} */ (document.querySelector('.workspace-create-commit'));
        assert(create.disabled,
          'and Create is refused until the form says it may be pressed');
      } finally {
        press('.workspace-create-cancel');
        await settled;
      }
    });

    await run('it opens with the keyboard in the chosen kind\'s first field', async () => {
      // The kind is already chosen on the way in, so the next thing to do is
      // fill in its form: a group's name is typed straight away, with no click
      // or Tab to get into the field first.
      const settled = openWorkspaceCreate(session);
      try {
        await waitFor(() => document.querySelector('.workspace-create-detail') !== null, 2000);
        const field = document.querySelector('.workspace-create-detail input');
        assert(field, 'the kind the dialog opens on has a field to type into');
        assert(document.activeElement === field,
          `and it has the focus, got ${document.activeElement?.tagName}.${document.activeElement?.className}`);
      } finally {
        press('.workspace-create-cancel');
        await settled;
      }
    });

    await run('Create makes a workspace with nothing bound to it', async () => {
      const name = 'create-dialog-tree';
      const dir = `${projectPath}/${name}`;
      /** @type {any} */
      let made = null;
      const settled = openWorkspaceCreate(session);
      try {
        await chooseFixture();
        typeDirectory(dir);
        press('.workspace-create-commit');

        made = await settled;
        assert(made.created === true && typeof made.workspaceId === 'string' && made.workspaceId !== '',
          `it reports what it made, got ${JSON.stringify(made)}`);

        const row = (session.workspaces ?? []).find((/** @type {any} */ w) => w.id === made.workspaceId);
        assert(row,
          'and puts it on this window\'s table rather than waiting for the broadcast');
        assert(row.root === dir,
          `where the form said, got ${JSON.stringify(row.root)}`);

        // The whole reason for the dialog: a place, with nothing in it. Every
        // conversation this session holds is somewhere else.
        const inside = Array.from(session.conversations.values())
          .filter((/** @type {any} */ c) => c.workspaceId === made.workspaceId);
        assert(inside.length === 0,
          `and nothing is bound to it, got ${inside.length} conversation(s)`);
        // No undo comes back with it. Making one selects it, which puts the
        // panel for it on screen, and that panel already carries the provider's
        // own ways of being finished with a tree.
        assert(made.undo === undefined,
          'and offers no second, briefer way to discard it');
      } finally {
        if (made?.workspaceId) await unregisterWorkspace(made.workspaceId).catch(() => {});
        await projectOps.shell({ command: `rm -rf ${name}` }).catch(() => {});
      }
    });

    await run('the rail is one tab stop, and the arrows walk it', async () => {
      // The kinds are a radio group, so the whole rail holds one stop in the tab
      // order and the arrows move within it. A group that took a stop per row
      // would put every provider an extension installs between the dialog and
      // its Create button.
      const settled = openWorkspaceCreate(session);
      try {
        await waitFor(() => rowsOnScreen().length > 1, 2000);
        const stops = rowsOnScreen().filter((row) => row.tabIndex === 0);
        assert(stops.length === 1,
          `the rail holds exactly one tab stop, got ${stops.length} of ${rowsOnScreen().length} rows`);

        const first = rowsOnScreen()[0];
        first.focus();
        first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

        // Selecting rebuilds the rail under the key that selected it, so the row
        // to read is the one now in that position rather than the node that was
        // there before.
        const after = rowsOnScreen();
        assert(after[1]?.getAttribute('aria-checked') === 'true',
          `walking down selects as it goes, got ${JSON.stringify(after.map((r) => r.getAttribute('aria-checked')))}`);
      } finally {
        press('.workspace-create-cancel');
        await settled;
      }
    });

    await run('the rail marks what is chosen, in both themes', async () => {
      // The rail is the settings panel's sidebar in a dialog, and a sidebar that
      // cannot show which row you are on is a list of dead words. It was drawn
      // in white at 10% opacity, which is invisible against a light panel: the
      // rows answered clicks and looked identical while doing it. The colours
      // are taste and are not pinned here; that the chosen row is a different
      // colour from its neighbour, in both themes, is not.
      const settled = openWorkspaceCreate(session);
      const root = document.documentElement;
      const was = root.dataset.theme;
      try {
        await waitFor(() => rowsOnScreen().length > 1, 2000);
        rowsOnScreen()[1].click();

        const rows = rowsOnScreen();
        const chosen = rows.find((row) => row.getAttribute('aria-checked') === 'true');
        const other = rows.find((row) => row.getAttribute('aria-checked') === 'false');
        assert(chosen && other, 'a rail of kinds, one of them chosen');

        const panel = /** @type {HTMLElement} */ (document.querySelector('.workspace-create-dialog'));
        for (const theme of ['dark', 'light']) {
          root.dataset.theme = theme;
          const lit = overSurface(/** @type {HTMLElement} */ (chosen), panel);
          const plain = overSurface(/** @type {HTMLElement} */ (other), panel);
          const apart = Math.max(...lit.map((channel, i) => Math.abs(channel - plain[i])));
          assert(apart >= 8,
            `in ${theme}, the chosen kind has to look different from the ones beside it, `
            + `got ${apart.toFixed(1)}/255 between ${lit.map(Math.round)} and ${plain.map(Math.round)}`);
        }
      } finally {
        if (was === undefined) delete root.dataset.theme; else root.dataset.theme = was;
        press('.workspace-create-cancel');
        await settled;
      }
    });

    await run('the dialog is the same size whichever kind is chosen', async () => {
      // Every provider's form is a different height, and a note appearing under
      // a field is another. Sized to its contents, the dialog resized on the way
      // between two kinds, and the rail — a column in a grid, stretched to
      // whichever half is taller — grew and shrank with the form beside it,
      // moving the rows out from under the pointer that was picking between
      // them. So the dialog is given a size and each half scrolls inside it.
      const settled = openWorkspaceCreate(session);
      try {
        await chooseFixture();
        const measure = () => {
          const dialog = /** @type {HTMLElement} */ (document.querySelector('.workspace-create-dialog'));
          const rail = /** @type {HTMLElement} */ (document.querySelector('.workspace-create-rail'));
          return { dialog: dialog.getBoundingClientRect().height, rail: rail.getBoundingClientRect().height };
        };
        const before = measure();
        choose(SecondKindProvider.MANIFEST.id);
        const after = measure();

        // This browser's window is 450px tall, which is shorter than the dialog
        // wants to be, so here it is always at its cap and these two can only
        // fail in a window with room to spare — which is the window the resizing
        // was reported in. What pins the fix in THIS viewport is the pair below.
        assert(Math.abs(before.dialog - after.dialog) < 0.5,
          `the same dialog, whichever kind is chosen, got ${before.dialog}px then ${after.dialog}px`);
        assert(Math.abs(before.rail - after.rail) < 0.5,
          `and the same rail, so the row under the pointer stays under it, got ${before.rail}px then ${after.rail}px`);

        // The halves scroll, not the split. A body that scrolled took the rail
        // with it: a long form pushed the kinds off the top of a dialog whose
        // whole point is choosing between them.
        const body = /** @type {HTMLElement} */ (document.querySelector('.workspace-create-body'));
        const detail = /** @type {HTMLElement} */ (document.querySelector('.workspace-create-detail'));
        assert(body.scrollHeight <= body.clientHeight + 0.5,
          `the split itself never scrolls, got ${body.scrollHeight}px of content in ${body.clientHeight}px`);
        assert(detail.scrollHeight > detail.clientHeight,
          `and a form longer than the room is the pane's to scroll, got ${detail.scrollHeight}px in ${detail.clientHeight}px`);
      } finally {
        press('.workspace-create-cancel');
        await settled;
      }
    });

    await run('choosing another kind keeps the dialog where it is', async () => {
      // The panel and its scrim animate in when they are inserted, so a redraw
      // that rebuilt them played the entrance again on every click in the rail:
      // the dialog dropped back into place each time a kind was chosen. What a
      // choice changes is what is inside the panel, never the panel.
      const settled = openWorkspaceCreate(session);
      try {
        await chooseFixture();
        const panel = document.querySelector('.workspace-create-overlay .workspace-create-dialog');
        const backdrop = document.querySelector('.workspace-create-overlay .workspace-create-backdrop');
        choose(SecondKindProvider.MANIFEST.id);
        await waitFor(() => document.querySelector('.workspace-create-overlay #second-kind-dir') !== null, 2000);
        assert(document.querySelector('.workspace-create-overlay .workspace-create-dialog') === panel,
          'the panel is the same element after a choice, not one inserted (and animated in) again');
        assert(document.querySelector('.workspace-create-overlay .workspace-create-backdrop') === backdrop,
          'and so is the scrim behind it');
      } finally {
        press('.workspace-create-cancel');
        await settled;
      }
    });

    await run('the rail names the kinds, and leaves the describing to the pane', async () => {
      // Master and detail: the rail is a column of names and the pane beside it
      // says what the chosen one means, in full. Printing the meaning in both
      // spends the rail's fourteen rems on a sentence it can only show the first
      // four words of — which is what a kind whose name had wrapped to three
      // lines was sitting under.
      const settled = openWorkspaceCreate(session);
      try {
        await waitFor(() => document.querySelector('.workspace-create-detail') !== null, 2000);
        const chosen = workspaceCreatePlaces(session).find((row) => row.kind === 'new');
        assert(chosen?.meaning, 'the fixture says what one of its places is');

        for (const row of rowsOnScreen().filter((row) => row.dataset.rowKind === 'new')) {
          assert(!row.querySelector('.setup-row-meaning'),
            `a kind in the rail is a name, got ${JSON.stringify(row.textContent)}`);
        }
        const detail = /** @type {HTMLElement} */ (document.querySelector('.workspace-create-detail'));
        assert(detail.querySelector('.workspace-create-detail-meaning')?.textContent === chosen?.meaning,
          `and the pane is where it is said, whole, got ${JSON.stringify(detail.querySelector('.workspace-create-detail-meaning')?.textContent)}`);
      } finally {
        press('.workspace-create-cancel');
        await settled;
      }
    });

    await run('a drag in the dialog selects nothing it could not want', async () => {
      // Chrome, by the policy in app-shell.css: the whole dialog is a surface to
      // aim clicks at — a title, a column of names, a form's labels and two
      // buttons — and a drag across it is a mis-aimed click. What is carved back
      // out is what somebody might actually copy: what they typed, and a path.
      const settled = openWorkspaceCreate(session);
      try {
        await chooseFixture();
        const selects = (/** @type {string} */ selector) => {
          const element = /** @type {HTMLElement} */ (document.querySelector(`.workspace-create-overlay ${selector}`));
          if (!element) throw new Error(`no ${selector} on screen`);
          const style = /** @type {any} */ (getComputedStyle(element));
          return style.userSelect ?? style.webkitUserSelect;
        };

        for (const chrome of ['.workspace-create-title', '.workspace-create-lead', '.setup-row',
          '.workspace-create-detail-meaning', '.workspace-create-commit']) {
          assert(selects(chrome) === 'none',
            `${chrome} is something to click, not to read off the screen, got ${selects(chrome)}`);
        }
        assert(selects('#fixture-dir') === 'text',
          `but what was typed into the form stays selectable, got ${selects('#fixture-dir')}`);
      } finally {
        press('.workspace-create-cancel');
        await settled;
      }
    });

    await run('a tree found on disk is offered under its own heading', async () => {
      // "Build it as" is a promise about every row under it, and a tree that is
      // already there is not something to build: it is an offer to pick it up,
      // taken on one click. So the rail breaks in two, and each half says what
      // its rows are.
      const name = `create-dialog-found-${Math.random().toString(36).slice(2, 8)}`;
      const dir = `${projectPath}/${name}`;
      /** @type {string} */
      let adoptedId = '';
      try {
        FixtureProvider.report = {
          orphanedWorkspaces: [],
          orphanedArtifacts: [{
            id: name,
            label: 'a tree nobody registered',
            detail: dir,
            workspace: { kind: 'local', root: dir, label: 'a tree nobody registered' }
          }],
          confirmed: []
        };
        await probeSetupAdoptions(session);

        const settled = openWorkspaceCreate(session);
        try {
          await waitFor(() => document.querySelector('.workspace-create-overlay .setup-row-adopt') !== null, 2000);
          const found = /** @type {HTMLElement} */ (
            document.querySelector('.workspace-create-overlay .setup-row-adopt'));
          const build = /** @type {HTMLElement} */ (
            document.querySelector('.workspace-create-overlay .setup-row-new'));

          const groupOf = (/** @type {HTMLElement} */ row) => row.closest('.setup-rows');
          assert(groupOf(found) && groupOf(found) !== groupOf(build),
            'the found tree is not in the list of ways to build one');

          // Parted by a rule rather than by a caption. A column of three names
          // needs no heading to say it is a column of three names, and the one
          // over it said the same thing twice as badly.
          const rail = /** @type {HTMLElement} */ (document.querySelector('.workspace-create-rail'));
          assert(!rail.querySelector('.setup-section-title'),
            `nothing in the rail is a heading, got ${JSON.stringify(rail.textContent)}`);
          const second = /** @type {HTMLElement} */ (groupOf(found));
          assert(parseFloat(getComputedStyle(second).borderTopWidth) > 0,
            'the two bands are told apart by a line drawn between them');

          // Still one keyboard sequence: the arrows walk the whole rail, not
          // each half of it.
          const rows = rowsOnScreen();
          rows[0].focus();
          for (let step = 0; step < rows.length - 1; step++) {
            /** @type {HTMLElement} */ (document.activeElement)
              .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
          }
          assert(document.activeElement === rowsOnScreen()[rows.length - 1],
            'and the arrows cross from one half into the other');
        } finally {
          press('.workspace-create-cancel');
          await settled;
        }
      } finally {
        // The offer is cached for the life of the page, and taking it up is the
        // only thing that drops it. Registered and unregistered, so no later
        // dialog in this run is offered a tree that was never there.
        FixtureProvider.report = null;
        const offered = workspaceCreatePlaces(session).find((row) => row.kind === 'adopt');
        if (offered) {
          adoptedId = (await adoptSetupRow(session, offered.id).catch(() => null))?.id ?? '';
        }
        if (adoptedId) await unregisterWorkspace(adoptedId).catch(() => {});
        session.workspaces = (session.workspaces ?? []).filter((/** @type {any} */ row) => row.root !== dir);
      }
    });

    await run('while it builds, the steps read from the top-left and nothing is cut', async () => {
      // The build is the one thing in this dialog that takes minutes, and for
      // all of them these few lines are the whole of what is on screen. A block
      // centred in a half-empty box reads as a placeholder; text starts at the
      // top-left because that is where text starts.
      const name = `creating-${'long-enough-to-wrap-'.repeat(4)}dir`;
      const dir = `${projectPath}/${name}`;
      const settled = openWorkspaceCreate(session);
      try {
        await chooseFixture();
        typeDirectory(dir);
        const stall = /** @type {HTMLInputElement} */ (
          document.querySelector('.workspace-create-overlay #fixture-stall'));
        stall.value = '1500';
        stall.dispatchEvent(new Event('input', { bubbles: true }));
        press('.workspace-create-commit');

        // Two steps in: the first is taken, the second is the one being waited
        // on, which is the state the lines below are about.
        await waitFor(() => document.querySelectorAll('.workspace-create-overlay .setup-progress-step').length > 1,
          { description: 'the provider to get as far as its second step' });

        const body = /** @type {HTMLElement} */ (document.querySelector('.workspace-create-body'));
        const steps = /** @type {HTMLElement} */ (document.querySelector('.setup-progress-running'));
        const room = body.getBoundingClientRect();
        const style = getComputedStyle(body);
        const at = steps.getBoundingClientRect();
        assert(Math.abs(at.left - (room.left + parseFloat(style.paddingLeft))) < 1,
          `the steps start at the left of the box, got ${at.left}px against ${room.left + parseFloat(style.paddingLeft)}px`);
        assert(Math.abs(at.top - (room.top + parseFloat(style.paddingTop))) < 1,
          `and at the top of it, got ${at.top}px against ${room.top + parseFloat(style.paddingTop)}px`);

        // A path is the one line here somebody reads character by character, and
        // there is a dialog's width to read it in.
        const said = /** @type {HTMLElement} */ (document.querySelector('.setup-progress-detail'));
        assert(getComputedStyle(said).whiteSpace !== 'nowrap',
          'a path with room to wrap is wrapped rather than cut');
        assert(said.scrollWidth <= said.clientWidth + 0.5,
          `and none of it is off the end, got ${said.scrollWidth}px of line in ${said.clientWidth}px`);

        // And it is laid out like something meant to be read for a minute or
        // two, which is how long it is up for. Set solid, a step and its path
        // read as one wrapped line, and a path long enough to wrap sets its own
        // lines on top of each other — in a dialog with most of its height going
        // spare.
        const owner = /** @type {HTMLElement} */ (said.closest('.setup-progress-step'));
        const phrase = /** @type {HTMLElement} */ (owner.querySelector('.setup-progress-what'));
        const under = said.getBoundingClientRect().top - phrase.getBoundingClientRect().bottom;
        assert(under >= 3,
          `a path is set off from the step it belongs to, got ${under}px between them`);

        const size = parseFloat(getComputedStyle(said).fontSize);
        const leading = parseFloat(getComputedStyle(said).lineHeight);
        assert(leading >= size * 1.4,
          `and has room between its own lines when it wraps, got ${leading}px of line for ${size}px of type`);

        // The two spacings say which lines belong together, so they cannot be
        // the same spacing: a step sits nearer its own path than the next step
        // does.
        const blocks = Array.from(document.querySelectorAll('.setup-progress-step'));
        const between = blocks[1].getBoundingClientRect().top - blocks[0].getBoundingClientRect().bottom;
        assert(between >= under * 2,
          `one step stands further from the next than from its own path, got ${between}px against ${under}px`);

        // One way out, meaning one thing. Two Cancels — the progress's own and
        // the footer's, which dismisses the whole dialog — are two answers to a
        // question nobody asked twice.
        const cancels = Array.from(document.querySelectorAll('.workspace-create-overlay button'))
          .filter((button) => button.textContent?.trim() === 'Cancel');
        assert(cancels.length === 1,
          `there is one way to stop it, got ${cancels.length}`);

        // Which of the lines is the one being waited on, said in the colour.
        const written = Array.from(document.querySelectorAll('.setup-progress-step'));
        assert(written.length > 1, `more than one step by now, got ${written.length}`);
        const waiting = getComputedStyle(/** @type {HTMLElement} */ (written[written.length - 1])).color;
        const done = getComputedStyle(/** @type {HTMLElement} */ (written[0])).color;
        assert(waiting !== done,
          `the step being waited on is not the colour of the ones already taken, got ${waiting} for both`);

        // Stopping a build is not answering the question: the form comes back
        // with what was typed into it. The wait is generous because the abort
        // has a `sleep` to interrupt and a directory to take back out.
        /** @type {HTMLButtonElement} */ (cancels[0]).click();
        await waitFor(() => document.querySelector('.workspace-create-overlay #fixture-dir') !== null,
          { timeoutMs: 15000, description: 'the form to come back, since cancelling a build did not cancel the question' });
      } finally {
        // Through the backdrop, which dismisses the dialog in either state and
        // stops a build on the way out. A `press('.workspace-create-cancel')`
        // here throws whenever the case failed mid-build — replacing the real
        // error with a missing button, and leaving the dialog up for the next
        // case to trip over.
        const backdrop = /** @type {HTMLElement|null} */ (
          document.querySelector('.workspace-create-overlay .workspace-create-backdrop'));
        backdrop?.click();
        await settled;
        await projectOps.shell({ command: `rm -rf ${name}` }).catch(() => {});
      }
    });

    await run('a form being filled in survives what the dialog learns behind it', async () => {
      // The adoption probe lands whenever it lands. Redrawing the dialog around
      // an open form would take the focus out of the field mid-word and throw
      // away what had been typed, so a form on screen outranks anything that
      // arrived on its own.
      const settled = openWorkspaceCreate(session);
      try {
        await chooseFixture();
        const field = /** @type {HTMLInputElement} */ (document.querySelector('.workspace-create-overlay #fixture-dir'));
        field.focus();
        typeDirectory(`${projectPath}/half-typed`);

        // The probe the dialog runs as it opens, settled and asking for a redraw.
        await probeSetupAdoptions(session);
        await new Promise((resolve) => setTimeout(resolve, 50));

        const still = /** @type {HTMLInputElement|null} */ (document.querySelector('.workspace-create-overlay #fixture-dir'));
        assert(still === field,
          'the field being typed into is the same element afterwards, not one rebuilt under the cursor');
        assert(still?.value === `${projectPath}/half-typed`,
          `and still holds what was typed into it, got ${JSON.stringify(still?.value)}`);
      } finally {
        press('.workspace-create-cancel');
        await settled;
      }
    });

    await run('Enter in a field presses Create, once Create can be pressed', async () => {
      const name = 'create-dialog-enter';
      const dir = `${projectPath}/${name}`;
      /** @type {any} */
      let made = null;
      const settled = openWorkspaceCreate(session);
      try {
        await chooseFixture();
        const field = /** @type {HTMLInputElement} */ (document.querySelector('.workspace-create-overlay #fixture-dir'));
        const enter = () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

        // Empty, the form is not ready, and Enter is no way round the button.
        enter();
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert(document.querySelector('.workspace-create-overlay #fixture-dir'),
          'Enter with Create disabled does nothing');

        typeDirectory(dir);
        enter();
        await waitFor(() => !document.querySelector('.workspace-create-overlay'),
          { timeoutMs: 5000, description: 'Enter to press Create, which closes the dialog on what it made' });
        made = await settled;
        assert(made.created === true && (session.workspaces ?? []).some((/** @type {any} */ w) => w.id === made.workspaceId && w.root === dir),
          `Enter made what the form described, got ${JSON.stringify(made)}`);
      } finally {
        if (!made) {
          /** @type {HTMLElement|null} */ (document.querySelector('.workspace-create-overlay .workspace-create-backdrop'))?.click();
          await settled;
        }
        if (made?.workspaceId) await unregisterWorkspace(made.workspaceId).catch(() => {});
        await projectOps.shell({ command: `rm -rf ${name}` }).catch(() => {});
      }
    });

    await run('cancelling builds nothing', async () => {
      const before = (session.workspaces ?? []).length;
      const settled = openWorkspaceCreate(session);
      await chooseFixture();
      typeDirectory(`${projectPath}/never-built`);
      press('.workspace-create-cancel');

      const outcome = await settled;
      assert(outcome.created === false,
        `a dialog dismissed made nothing, got ${JSON.stringify(outcome)}`);
      assert((session.workspaces ?? []).length === before,
        'and left the table as it was');
      assert(!document.querySelector('.workspace-create-overlay'),
        'and took itself off the screen');
    });
  });
}
