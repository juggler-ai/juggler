//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <workspace-panel> — what a selected workspace box shows in the main area.
 *
 * The panel exists because the same facts and the same endings used to be
 * crammed into a box header three tabs wide and a menu you had to hold a
 * pointer inside. So the assertions here are mostly about room and separation:
 * the path is a path with the things one does to a path beside it, the endings
 * are kept apart from the actions that leave the workspace in use and wear the
 * trashcan that says so, and a row that asks something before it does anything
 * says so in its label.
 *
 * The last case is the one that costs nothing and would hurt: a workspace
 * finished with while its own panel is open leaves a selection naming nothing,
 * and the panel has to get out of the way rather than draw a ghost.
 * @module unit-tests/workspace-panel-test
 */

import { assert, initializeRegistries, neutralizeStrayOverlays, waitFor } from '../utilities/test-helpers.js';
import { FixtureProvider, ensureFixtureProvider } from '../utilities/conversation-workspace-helpers.js';
import '../../js/components/workspace-panel.js';
// For the width comparison: the column a workspace panel stands in place of.
import '../../js/components/conversation-area.js';

/**
 * A workspace row bound to the fixture provider, so the panel has real endings
 * to lay out rather than a provider-missing note.
 * @param {string} id - The workspace id.
 * @returns {any} The row.
 */
function workspace(id) {
  return {
    id,
    root: `/tmp/${id}/work`,
    label: id,
    state: 'ready',
    available: true,
    providerId: FixtureProvider.MANIFEST.id
  };
}

/**
 * A session carrying only what the panel reads. The panel asks the table for
 * the row behind the selected id on every draw, which is the behaviour the
 * last case is about, so the table is a live array the case can edit.
 * @param {any[]} workspaces - The workspace table.
 * @returns {any} The session.
 */
function makeSession(workspaces) {
  return {
    workspaces,
    projectPath: '/tmp/project',
    conversations: new Map(),
    selection: null,
    loadedConversationId: null,
    /**
     * @param {string} id - Which workspace.
     * @returns {any} The row, if the table still holds it.
     */
    getWorkspace(id) { return workspaces.find((row) => row.id === id) || null; },
    /**
     * @param {string} id - Which workspace, '' for the project.
     * @returns {string|null} Where it works.
     */
    workspaceRoot(id) {
      if (!id) return this.projectPath;
      return workspaces.find((row) => row.id === id)?.root ?? null;
    },
    /**
     * @returns {() => void} How to stop listening.
     */
    subscribe() { return () => {}; }
  };
}

/**
 * Mount a panel over a session.
 * @param {any} session - The session to draw.
 * @returns {{panel: any, column: HTMLElement, teardown: () => void}} The panel, its column container, and a teardown.
 */
function mountPanel(session) {
  // In a column container, because that is where it lives: the panel is a
  // column, and its width comes from being one.
  const column = document.createElement('column-container');
  column.className = 'workspace-panel-column';
  column.setAttribute('style', 'position:absolute;left:0;top:0;width:1600px;height:800px;');
  const panel = /** @type {any} */ (document.createElement('workspace-panel'));
  panel.hidden = true;
  column.appendChild(panel);
  document.body.appendChild(column);
  panel.setSession(session);
  return {
    panel,
    column,
    teardown: () => {
      column.remove();
      // The panel hides the tab column with a class on <body>, which outlives
      // the element that set it.
      document.body.classList.remove('workspace-selected');
    }
  };
}

/**
 * What a section of the panel offers, by the ids the provider gave.
 * @param {any} panel - The mounted panel.
 * @param {string} selector - Which section.
 * @returns {string} The action ids, in order.
 */
function actionsIn(panel, selector) {
  const section = panel.querySelector(selector);
  if (!section) return '(no section)';
  return /** @type {HTMLElement[]} */ (Array.from(section.querySelectorAll('[data-action]')))
    .map((button) => button.dataset.action)
    .join(',');
}

/**
 * Press an ending, agree to it, and hand back what the panel said afterwards.
 *
 * Through the real dialogs rather than around them: an ending that keeps its
 * bad news inside an unhandled rejection passes every test that stubs the
 * presenter, because the press and the notice are the two ends of exactly the
 * path under test.
 * @param {any} panel - The mounted panel.
 * @param {string} actionId - Which ending to press.
 * @returns {Promise<string>} What the notice said.
 */
async function pressAndAgree(panel, actionId) {
  /** @type {HTMLElement} */ (panel.querySelector(`[data-action="${actionId}"]`)).click();

  const confirmed = 'modal-dialog.show:not(.is-notice) .modal-button.primary, modal-dialog.show:not(.is-notice) .modal-button.danger';
  await waitFor(() => !!document.querySelector(confirmed), { description: 'the confirmation to appear' });
  /** @type {HTMLElement} */ (document.querySelector(confirmed)).click();

  await waitFor(() => !!document.querySelector('modal-dialog.is-notice.show .modal-message'),
    { description: 'the panel to say what happened' });
  return document.querySelector('modal-dialog.is-notice.show .modal-message')?.textContent ?? '';
}

/**
 * Run the workspace panel tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  await initializeRegistries();
  ensureFixtureProvider();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - What is being checked.
   * @param {() => void} body - The check.
   */
  const check = (name, body) => {
    try {
      body();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * The same, for a case that has to wait for the status probe.
   * @param {string} name - What is being checked.
   * @param {() => Promise<void>} body - The check.
   * @returns {Promise<void>} When it has run.
   */
  const checkAsync = async (name, body) => {
    try {
      await body();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  check('nothing selected is nothing shown', () => {
    const { panel, teardown } = mountPanel(makeSession([workspace('ws_a')]));
    try {
      assert(panel.hidden === true,
        'a panel for no workspace is not a panel, and takes none of the room a conversation wants');
      assert(!document.body.classList.contains('workspace-selected'),
        'and the tab column keeps the main area');
    } finally {
      teardown();
    }
  });

  check('a selected workspace takes the place of the conversation', () => {
    const session = makeSession([workspace('ws_a')]);
    const { panel, teardown } = mountPanel(session);
    try {
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();

      assert(panel.hidden === false, 'the panel is what is on screen');
      assert(document.body.classList.contains('workspace-selected'),
        'and the tab column stands down, the way it does for the two onboarding overlays');
      assert(panel.querySelector('.workspace-panel-title')?.textContent === 'ws_a',
        `the place is named, got ${JSON.stringify(panel.querySelector('.workspace-panel-title')?.textContent)}`);
      assert(panel.querySelector('.workspace-panel-eyebrow')?.textContent?.includes(FixtureProvider.MANIFEST.name),
        'and said to be the kind of place whatever made it calls it');
    } finally {
      teardown();
    }
  });

  check('the head says what kind of thing this is, then what that kind is for, then its name', () => {
    const session = makeSession([workspace('ws_a')]);
    const { panel, teardown } = mountPanel(session);
    try {
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();

      const eyebrow = panel.querySelector('.workspace-panel-eyebrow')?.textContent;
      assert(eyebrow === `Workspace · ${FixtureProvider.MANIFEST.name}`,
        'a box is clicked before it is understood, so one line says the word the feature is named for and '
        + `which kind of one this is, got ${JSON.stringify(eyebrow)}`);

      const note = panel.querySelector('.workspace-panel-kind-note')?.textContent;
      assert(note === FixtureProvider.MANIFEST.description,
        `and under it what that kind is for, which the provider already wrote, got ${JSON.stringify(note)}`);

      // Both of those are about the TYPE and both are manifest facts, so they
      // are right on the first draw. The name is where this one workspace
      // starts, and nothing above it may be about the instance.
      const head = [...(panel.querySelector('.workspace-panel-head')?.children ?? [])]
        .map((/** @type {any} */ line) => line.className).join(',');
      assert(head === 'workspace-panel-eyebrow,workspace-panel-kind-note,workspace-panel-title',
        `the kind is said before the name and each of those once, got ${JSON.stringify(head)}`);
    } finally {
      teardown();
    }
  });

  await checkAsync('the status read never rewrites the head', async () => {
    const session = makeSession([workspace('ws_a')]);
    const { panel, teardown } = mountPanel(session);
    // A status that describes this instance the way the git worktree provider's
    // does, which is not what the head is about.
    FixtureProvider.reported = { detail: 'branch feat/x · clean' };
    try {
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();
      const head = panel.querySelector('.workspace-panel-head')?.textContent;

      await panel.refreshStatus();

      assert(panel.textContent?.includes('branch feat/x · clean'),
        'the answer arrived, so this is measuring the redraw that matters');
      assert(panel.querySelector('.workspace-panel-head')?.textContent === head,
        'a line that changes a second after the panel opens is a line somebody is already reading, so what '
        + `the probe learnt goes in the status section, got ${JSON.stringify(panel.querySelector('.workspace-panel-head')?.textContent)}`);
    } finally {
      FixtureProvider.reported = null;
      teardown();
    }
  });

  check('the panel does not list the conversations the tab strip is drawing', () => {
    const session = makeSession([workspace('ws_a')]);
    session.conversations = new Map([
      ['c_here', { id: 'c_here', name: 'in the tree', workspaceId: 'ws_a' }],
      ['c_elsewhere', { id: 'c_elsewhere', name: 'in the project', workspaceId: '' }]
    ]);

    const { panel, teardown } = mountPanel(session);
    try {
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();

      assert(!panel.textContent?.includes('in the tree'),
        'the strip is drawing this workspace\'s conversations in the box the panel was opened from, and a '
        + `second copy of the list is one to check against the other, got ${JSON.stringify(panel.textContent)}`);
    } finally {
      teardown();
    }
  });

  check('the panel is a column, exactly as wide as the conversation it replaces', () => {
    const session = makeSession([workspace('ws_a')]);
    const { panel, column, teardown } = mountPanel(session);
    // A real conversation column beside it, because the width under test is
    // "the same as that one" — asserting a number instead would let the two
    // drift apart and still pass.
    const area = document.createElement('conversation-area');
    column.appendChild(area);
    try {
      document.body.classList.add('workspace-selected');
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();

      const width = panel.getBoundingClientRect().width;
      // Two unlaid-out columns are both nothing wide and would agree on it.
      assert(width > 0, `the panel is laid out at all, got ${width}px`);
      assert(width === area.getBoundingClientRect().width,
        'a workspace opens in the column a conversation would have opened in, at the width that column '
        + `has, got ${width}px against the conversation's ${area.getBoundingClientRect().width}px`);
      assert(width < column.getBoundingClientRect().width,
        'rather than stretching across a window that may be very wide, which nothing else the tab strip '
        + 'selects does');
      assert(!!panel.querySelector('col-resize-handle'),
        'and it is widened the way every other column is, by the grip on its own edge');
    } finally {
      area.remove();
      teardown();
    }
  });

  check('the path is a path, with the things one does to a path beside it', () => {
    const session = makeSession([workspace('ws_a')]);
    const { panel, teardown } = mountPanel(session);
    try {
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();

      const box = /** @type {HTMLElement|null} */ (panel.querySelector('.workspace-panel-path'));
      assert(box?.textContent === '/tmp/ws_a/work',
        `written out whole — no rule about which part of a path matters survives the paths providers make, got ${JSON.stringify(box?.textContent)}`);
      assert(box?.dataset.filePath === '/tmp/ws_a/work',
        'and carrying the hook the right-click Open / Reveal / Copy menu reads everywhere else');
      assert(!!panel.querySelector('.properties-panel-filepath-actions'),
        'with copy, reveal and pin beside it, as a path has everywhere else');
    } finally {
      teardown();
    }
  });

  check('the endings are kept apart from the things that keep the workspace', () => {
    const session = makeSession([workspace('ws_a')]);
    const { panel, teardown } = mountPanel(session);
    try {
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();

      const working = actionsIn(panel, '.workspace-panel-doing');
      assert(working === 'note',
        `an action that leaves the workspace in use is in its own section, got "${working}"`);

      const endings = actionsIn(panel, '.workspace-panel-endings');
      assert(endings === 'done,leave',
        `and every way of not working here any more is in the last one, got "${endings}"`);

      assert(!!panel.querySelector('.workspace-panel-starting .workspace-panel-create'),
        'starting a conversation is the first thing you do in a place you are keeping, so it sits with what '
        + 'this workspace is rather than among the ways of leaving it');
    } finally {
      teardown();
    }
  });

  check('what a row does to the place is on it, as the icon the app uses for it', () => {
    // A column of rows that all look alike is read by their labels alone, and
    // the two that take the place away are the two nobody may press by mistake.
    const session = makeSession([workspace('ws_a')]);
    const { panel, teardown } = mountPanel(session);
    try {
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();

      for (const id of ['done', 'leave']) {
        assert(!!panel.querySelector(`[data-action="${id}"] .icon-trashcan`),
          `an ending wears the trashcan this app puts on everything that takes something away, and "${id}" has none`);
      }
      assert(!panel.querySelector('[data-action="note"] .icon-trashcan'),
        'while an action that leaves the workspace in use must not — nothing is being removed');
      assert(!!panel.querySelector('.workspace-panel-create .icon-plus'),
        'and the row that makes a new one of something wears the plus, as every other such row does');
    } finally {
      teardown();
    }
  });

  check('the button that starts a conversation says truthfully where it will work', () => {
    // A group is rooted at the project, so "not the project's" is exactly
    // wrong there — and it is the sentence somebody reads to find out what a
    // conversation started from this box will be working on.
    const session = makeSession([
      workspace('ws_a'),
      { ...workspace('ws_g'), root: '/tmp/project', label: 'Group 1' }
    ]);
    const { panel, teardown } = mountPanel(session);
    const said = () => String(panel.querySelector('.workspace-panel-create')?.textContent ?? '');
    try {
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();
      assert(said().includes('Start a new conversation here') && !said().includes('ws_a'),
        `the button says "here", leaving the naming to the head, got ${JSON.stringify(said())}`);
      assert(/own files/.test(said()) && /not the project/.test(said()),
        `and a tree of its own says the work happens there, got ${JSON.stringify(said())}`);

      session.selection = { kind: 'workspace', id: 'ws_g' };
      panel._refresh();
      assert(/works in the project/.test(said()) && !/not the project/.test(said()),
        `and one rooted at the project says it works in the project, got ${JSON.stringify(said())}`);
    } finally {
      teardown();
    }
  });

  check('only the section a label tells you anything about has one', () => {
    const session = makeSession([workspace('ws_a')]);
    const { panel, teardown } = mountPanel(session);
    try {
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();

      const labelled = [...panel.querySelectorAll('.workspace-panel-heading')]
        .map((/** @type {any} */ heading) => heading.textContent).join(',');
      // A path with copy and reveal beside it is a path, and a button that says
      // what it does and what will happen needs nothing over the top of it. What
      // does need naming is a run of the provider's own words — a branch, a
      // count, a divergence.
      assert(labelled === 'Status',
        `a heading that only names what is plainly below it is a line to read and nothing to know, got ${JSON.stringify(labelled)}`);
      assert(!panel.querySelector('.workspace-panel-where .workspace-panel-heading')
        && !panel.querySelector('.workspace-panel-endings .workspace-panel-heading'),
      'so neither the path nor the endings carry one');
    } finally {
      teardown();
    }
  });

  check('a row that asks something first says so', () => {
    const session = makeSession([workspace('ws_a')]);
    const { panel, teardown } = mountPanel(session);
    try {
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();

      const asks = /** @type {HTMLElement|null} */ (panel.querySelector('[data-action="note"] .workspace-panel-action-name'));
      assert(asks?.textContent === 'Leave a note…',
        `the ellipsis is the promise the rest of the app makes, got ${JSON.stringify(asks?.textContent)}`);

      const agrees = /** @type {HTMLElement|null} */ (panel.querySelector('[data-action="leave"] .workspace-panel-action-name'));
      assert(agrees?.textContent === 'Leave it be',
        `and an ending that only wants agreeing to does not get one — a confirmation is not a question, got ${JSON.stringify(agrees?.textContent)}`);

      const note = panel.querySelector('[data-action="done"] .workspace-panel-action-note');
      assert(note?.textContent === 'Removes the directory.',
        'what a press will do is written under it, where someone deciding whether it is safe will read it');
    } finally {
      teardown();
    }
  });

  await checkAsync('the status arriving moves nothing that can be clicked', async () => {
    const session = makeSession([workspace('ws_a')]);
    const { panel, teardown } = mountPanel(session);
    FixtureProvider.reported = { detail: 'branch feat/x · clean', dirty: true };
    try {
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();

      /**
       * Where the buttons are, both ways: which child of the body they are, and
       * where that lands on screen.
       * @returns {{index: number, top: number}} The two.
       */
      const buttons = () => {
        const body = /** @type {HTMLElement} */ (panel.querySelector('.workspace-panel-body'));
        const doing = /** @type {HTMLElement} */ (panel.querySelector('.workspace-panel-doing'));
        return {
          index: Array.from(body.children).indexOf(doing),
          top: doing.getBoundingClientRect().top
        };
      };

      const before = buttons();
      assert(before.top > 0,
        `the panel is laid out at all, or the measurement below is two zeroes agreeing, got ${before.top}px`);
      assert(!!panel.querySelector('.workspace-panel-state'),
        'the section the answer will go in is there before the answer is, or there is nothing to fill in');

      // What the panel does a second or so after it opens, and the moment this
      // case is about: a button under the pointer must not move out from under it.
      await panel.refreshStatus();

      const after = buttons();
      assert(panel.textContent?.includes('branch feat/x · clean'),
        'the answer arrived and was drawn, so this is measuring the redraw that matters');
      assert(after.index === before.index,
        `the answer fills the section that was already there rather than inserting one above the buttons, got child ${after.index} where it was ${before.index}`);
      assert(after.top === before.top,
        `so nothing below it moves at the moment someone is reaching for it, got ${after.top}px where it was ${before.top}px`);

      // And the work the provider counted is reported once. The count is the
      // fact; "this workspace is holding uncommitted work" underneath it is the
      // same fact with the number taken out, so the flag is a colour on the line
      // that accounts for it instead of a line of its own.
      const lines = [...panel.querySelectorAll('.workspace-panel-state-lines > *')];
      assert(lines.length === 1 && lines[0].classList.contains('workspace-panel-dirty'),
        `uncommitted work colours the line that accounts for it, got ${JSON.stringify(lines.map((/** @type {any} */ line) => line.textContent))}`);
    } finally {
      FixtureProvider.reported = null;
      teardown();
    }
  });

  await checkAsync('an ending that falls over says so, rather than nothing at all', async () => {
    const session = makeSession([workspace('ws_a')]);
    const { panel, teardown } = mountPanel(session);
    // What the tree can never answer for: the op could not be run at all, so
    // the provider throws instead of reporting a command that failed.
    FixtureProvider.finishError = 'workspace ws_a is missing its root: /tmp/ws_a/work';
    try {
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();

      const said = await pressAndAgree(panel, 'leave');
      assert(said.includes('missing its root'),
        `git's own reason survives the trip to the screen instead of the press doing nothing visible at all, got ${JSON.stringify(said)}`);
    } finally {
      FixtureProvider.finishError = null;
      neutralizeStrayOverlays();
      teardown();
    }
  });

  await checkAsync('an ending in flight cannot be started a second time', async () => {
    const session = makeSession([workspace('ws_a')]);
    const { panel, teardown } = mountPanel(session);
    // Long enough that the second press lands inside the first, which is the
    // window a commit spends waiting on git.
    FixtureProvider.finishDelayMs = 150;
    FixtureProvider.finishCalls = 0;
    try {
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();

      const pressing = pressAndAgree(panel, 'leave');
      const button = /** @type {HTMLButtonElement} */ (panel.querySelector('[data-action="leave"]'));
      await waitFor(() => button.disabled,
        'the button to stand down while the ending it started is running');
      button.click();
      await pressing;

      assert(FixtureProvider.finishCalls === 1,
        `a second press while the first is in flight is not a second ending — for a commit it would be a second commit, got ${FixtureProvider.finishCalls}`);
      assert(!/** @type {HTMLButtonElement} */ (panel.querySelector('[data-action="leave"]')).disabled,
        'and the button comes back once it is over, whatever the answer was');
    } finally {
      FixtureProvider.finishDelayMs = 0;
      neutralizeStrayOverlays();
      teardown();
    }
  });

  check('a workspace finished with under its own panel stops being selected', () => {
    const table = [workspace('ws_a')];
    const session = makeSession(table);
    const { panel, teardown } = mountPanel(session);
    try {
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();
      assert(panel.hidden === false, 'it starts out showing');

      // What finishing with one leaves behind: an id naming nothing.
      table.length = 0;
      panel._refresh();

      assert(panel.hidden === true,
        'a selection that names nothing selects nothing, rather than drawing a workspace that is gone');
      assert(!document.body.classList.contains('workspace-selected'),
        'and the tab column takes the room back without anyone having to tidy the id');
    } finally {
      teardown();
    }
  });

  check('a workspace that closes under its panel stops being selected too', () => {
    const table = [workspace('ws_a')];
    const session = makeSession(table);
    const { panel, teardown } = mountPanel(session);
    try {
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();

      // Still on the table, but no longer somewhere to work — which is exactly
      // when the strip stops drawing a box for it.
      table[0].state = 'closed';
      panel._refresh();

      assert(panel.hidden === true,
        'a selection has to mean the box that is drawn, and no box is drawn for a place nobody can work in');
    } finally {
      teardown();
    }
  });

  return { passed, failed, errors };
}
