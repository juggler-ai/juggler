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
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import workspaceProviderRegistry from '../../js/registries/workspace-provider-registry.js';
import WorkspaceProvider from '../../sdk/workspace-provider.js';
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

const XA_EXTENSION = 'test-i18n-workspace-panel';
const XA_PROVIDER_ID = 'i18n-workspace-panel-provider';

/**
 * A provider whose every word is a digit, so whatever English the panel draws
 * is the panel's own — except its manifest name and description, which the
 * panel reads through the provider's extension catalogue.
 */
class SaysLittle extends WorkspaceProvider {
  static MANIFEST = {
    id: XA_PROVIDER_ID,
    name: 'Quiet place, for testing',
    version: '1.0.0',
    description: 'Says as little as a provider can',
  };

  /** @type {any} What the next status read answers; an Error is thrown. */
  static next = {};

  /**
   * @param {any} workspace - The row being reported on.
   * @returns {Promise<any>} Whatever the case set.
   */
  async status(workspace) {
    void workspace;
    if (SaysLittle.next instanceof Error) throw SaysLittle.next;
    return SaysLittle.next;
  }

  /**
   * @param {any} workspace - The row being finished with.
   * @returns {any[]} One ending that keeps the place, one that does not.
   */
  finishOptions(workspace) {
    void workspace;
    return [
      { id: 'keep', label: '1', description: '2', keepsWorkspace: true },
      { id: 'end', label: '3', description: '4', danger: true }
    ];
  }
}

const TRACK_PROVIDER_ID = 'tracking-workspace-provider';

/**
 * The fixture provider with a track: whatever steps the case sets, and the
 * endings a track-reading provider offers — no commit among them once the
 * host has passed the track it read, exactly as the git worktree's are.
 */
class Tracks extends FixtureProvider {
  static MANIFEST = {
    id: TRACK_PROVIDER_ID,
    name: 'On a track',
    version: '1.0.0',
    description: 'Has steps from here to done'
  };

  /** @type {any[]} What the next track read answers. */
  static steps = [];

  /** @type {any} The last track `finishOptions` was handed. */
  static knownTrack = undefined;

  /** @type {{actionId: string, input: any}|null} What the host last ran. */
  static ran = null;

  /**
   * @param {any} workspace - The row being reported on.
   * @param {any} ctx - Operations pinned to it, and a signal.
   * @returns {Promise<any>} The case's steps.
   */
  async track(workspace, ctx) {
    void workspace;
    void ctx;
    return { steps: Tracks.steps };
  }

  /**
   * @param {any} workspace - The row being finished with.
   * @param {any} [known] - What the host has read about it.
   * @returns {any[]} Commit only while no track has been read, then the two endings.
   */
  finishOptions(workspace, known) {
    void workspace;
    Tracks.knownTrack = known?.track;
    return [
      ...(known?.track ? [] : [{ id: 'commit', label: 'Commit the changes', keepsWorkspace: true, description: 'Commits.' }]),
      { id: 'unbind', label: 'Close, keep it', description: 'The tree stays on disk.' },
      { id: 'discard', label: 'Close and delete it', danger: true, description: 'Two commits exist only here.' }
    ];
  }

  /**
   * @param {any} workspace - The row being finished with.
   * @param {string} actionId - Which action.
   * @param {any} ctx - What the host handed over.
   * @returns {Promise<any>} Never finished: every case reads the notice.
   */
  async finish(workspace, actionId, ctx) {
    void workspace;
    Tracks.ran = { actionId, input: ctx?.input };
    return { done: false, message: `ran ${actionId}` };
  }
}

/**
 * A workspace row bound to the tracking provider.
 * @param {string} id - The workspace id.
 * @returns {any} The row.
 */
function trackedWorkspace(id) {
  return {
    ...workspace(id),
    providerId: TRACK_PROVIDER_ID,
    meta: { branch: id, base: 'develop', repoDir: '/tmp/repos/juggler-pro' }
  };
}

/**
 * Select a tracked workspace and wait for its track to be drawn.
 * @param {any} panel - The mounted panel.
 * @param {any} session - Its session.
 * @param {string} id - Which workspace.
 * @returns {Promise<void>} When the steps are on screen.
 */
async function openTracked(panel, session, id) {
  session.selection = { kind: 'workspace', id };
  panel._refresh();
  await waitFor(() => panel.querySelectorAll('.workspace-panel-step').length === Tracks.steps.length
    && !panel.querySelector('.workspace-panel-pending'),
  { description: 'the track to be drawn' });
}

const XA_TRACK_PROVIDER_ID = 'i18n-workspace-panel-track-provider';

/**
 * The same, with a track whose every word is a digit: a step with a field, a
 * list long enough to be cut, a group, and an update to put in the secondary
 * row — everything around them is the panel's own.
 */
class SaysLittleOnTrack extends SaysLittle {
  static MANIFEST = {
    id: XA_TRACK_PROVIDER_ID,
    name: 'Tracked place, for testing',
    version: '1.0.0',
    description: 'Says as little as a tracked provider can',
  };

  /**
   * @param {any} workspace - The row being reported on.
   * @returns {Promise<any>} Digits throughout.
   */
  async track(workspace) {
    void workspace;
    const files = Array.from({ length: 9 }, (_, i) => ({ path: `${i}`, state: '1' }));
    return {
      steps: [
        { id: 'a', state: 'now', title: '1', note: '2', files, fileCount: 20,
          actions: [{ id: 'keep', label: '3', primary: true, input: { placeholder: '4', hint: '5' }, alternative: { label: '6' } }] },
        { id: 'b', state: 'blocked', title: '7', commits: [{ sha: '8', subject: '9' }], commitCount: 12,
          groups: [{ name: '1', note: '2', commits: [{ sha: '3', subject: '4' }], commitCount: 11 }],
          actions: [{ id: 'update', label: '5' }] },
        { id: 'c', state: 'done', title: '6' }
      ]
    };
  }
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

  const confirmed = 'modal-dialog.is-open:not(.is-notice) .modal-footer .btn-primary, modal-dialog.is-open:not(.is-notice) .modal-footer .btn-danger';
  await waitFor(() => !!document.querySelector(confirmed), { description: 'the confirmation to appear' });
  /** @type {HTMLElement} */ (document.querySelector(confirmed)).click();

  await waitFor(() => !!document.querySelector('modal-dialog.is-notice.is-open .modal-message'),
    { description: 'the panel to say what happened' });
  return document.querySelector('modal-dialog.is-notice.is-open .modal-message')?.textContent ?? '';
}

/**
 * Run the workspace panel tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  await initializeRegistries();
  ensureFixtureProvider();
  // Only when the id is free: a lane runs suite after suite in one realm, and
  // `registerClass` refuses a taken id rather than replacing it.
  if (!workspaceProviderRegistry.get(TRACK_PROVIDER_ID)) {
    workspaceProviderRegistry.registerClass(Tracks, { extensionId: 'test', modulePath: '(test)' });
  }

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
      assert(panel.querySelector('.workspace-panel-kind')?.textContent === FixtureProvider.MANIFEST.name,
        'and said to be the kind of place whatever made it calls it');
    } finally {
      teardown();
    }
  });

  check('the head names the place, then says where it came from, then where it is', () => {
    const session = makeSession([workspace('ws_a'), trackedWorkspace('ws_t')]);
    const { panel, teardown } = mountPanel(session);
    /** @returns {string} The head's lines, by class. */
    const lines = () => [...(panel.querySelector('.workspace-panel-head')?.children ?? [])]
      .map((/** @type {any} */ line) => line.classList[0]).join(',');
    try {
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();

      // The name with its kind beside it, and the kind's own sentence under it
      // when nothing more particular is known of where this one came from.
      const note = panel.querySelector('.workspace-panel-kind-note')?.textContent;
      assert(note === FixtureProvider.MANIFEST.description,
        `a place with no recorded origin is described by its kind, got ${JSON.stringify(note)}`);
      assert(lines() === 'workspace-panel-title-row,workspace-panel-kind-note,workspace-panel-path-row',
        `the name first, then what it is, then the path, got ${JSON.stringify(lines())}`);

      session.selection = { kind: 'workspace', id: 'ws_t' };
      panel._refresh();
      const origin = panel.querySelector('.workspace-panel-origin')?.textContent;
      assert(origin === 'Branched from develop in juggler-pro',
        `one whose record names its base and repository says so instead, got ${JSON.stringify(origin)}`);
      assert(lines() === 'workspace-panel-title-row,workspace-panel-origin,workspace-panel-path-row',
        `in the kind note's place, got ${JSON.stringify(lines())}`);
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

      await panel.reread();

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

  await checkAsync('a redraw that changes nothing about a button keeps that button', async () => {
    const session = makeSession([workspace('ws_a')]);
    const { panel, teardown } = mountPanel(session);
    FixtureProvider.reported = { detail: 'branch feat/x · clean' };
    try {
      session.selection = { kind: 'workspace', id: 'ws_a' };
      panel._refresh();
      const buttons = /** @type {HTMLElement[]} */ (
        Array.from(panel.querySelectorAll('.workspace-panel-action')));
      assert(buttons.length >= 2, `the fixture offers buttons to hold on to, got ${buttons.length}`);

      // The status read lands about a second after the panel opens, which is
      // when a pointer is on its way to one of these; a workspace-table event
      // from anywhere in the session redraws it too.
      await panel.reread();
      panel._refresh();

      assert(panel.textContent?.includes('branch feat/x · clean'),
        'the answer arrived, so this is measuring the redraw that matters');
      const replaced = buttons.filter((button) => !button.isConnected)
        .map((button) => button.dataset.action ?? 'create');
      assert(replaced.length === 0,
        'a button swapped for an identical one between press and release swallows the click, and loses '
        + `focus and hover, so a redraw keeps every button it would draw the same, got replaced: ${replaced.join(',')}`);
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

  await checkAsync('a track draws its steps, and only the step to do now offers anything', async () => {
    const session = makeSession([trackedWorkspace('ws_t')]);
    const { panel, teardown } = mountPanel(session);
    const files = Array.from({ length: 10 }, (_, i) => ({ path: `src/f${i}.js`, state: 'Modified' }));
    Tracks.steps = [
      { id: 'commit', state: 'now', title: '12 files changed', files, fileCount: 12,
        actions: [{ id: 'commit', label: 'Commit', primary: true, input: { placeholder: 'Why' } }] },
      // A step that cannot run yet says what it waits on, and is not a button —
      // except that bringing the base in is never the step's own business.
      { id: 'land', state: 'wait', title: 'Land in develop', note: 'After the commit.',
        commits: [{ sha: 'abc1234', subject: 'Did a thing' }],
        actions: [{ id: 'land', label: 'Land in develop', primary: true }, { id: 'update', label: 'Update from develop' }] },
      { id: 'close', state: 'wait', title: 'Close and delete the worktree' }
    ];
    try {
      await openTracked(panel, session, 'ws_t');

      const states = [...panel.querySelectorAll('.workspace-panel-step')]
        .map((/** @type {any} */ step) => `${step.dataset.step}:${['done', 'now', 'wait', 'blocked']
          .find((state) => step.classList.contains(`workspace-panel-step--${state}`))}`).join(',');
      assert(states === 'commit:now,land:wait,close:wait', `each step in its state, got ${states}`);

      const offered = actionsIn(panel, '.workspace-panel-track');
      assert(offered === 'commit',
        `a step that cannot run yet offers nothing, or it is a button that opens a dead end, got "${offered}"`);
      const more = actionsIn(panel, '.workspace-panel-more');
      assert(more.split(',').includes('update'),
        `updating from the base is a secondary action, wherever the step that offers it stands, got "${more}"`);

      const rows = panel.querySelectorAll('[data-step="commit"] .workspace-panel-list > li:not(.workspace-panel-list-more)');
      const rest = panel.querySelector('[data-step="commit"] .workspace-panel-list-more')?.textContent;
      assert(rows.length === 8 && rest === '+4 more',
        `a long list stops at eight and counts what it left out from the real total, got ${rows.length} rows and ${JSON.stringify(rest)}`);
      assert(!panel.querySelector('.workspace-panel-state'),
        'and the track says how the place is doing, so there is no second status line saying it again');
    } finally {
      Tracks.steps = [];
      teardown();
    }
  });

  await checkAsync('a commit is typed where it is offered, and the alternative sends no message', async () => {
    const session = makeSession([trackedWorkspace('ws_t')]);
    const { panel, teardown } = mountPanel(session);
    const originalShowModal = /** @type {any} */ (window).showModal;
    /** @type {any[]} */
    const asked = [];
    // Every confirmation the panel asks for is recorded and agreed to: a commit
    // must ask none.
    /** @type {any} */ (window).showModal = async (/** @type {any} */ options) => { asked.push(options); return true; };
    Tracks.steps = [
      { id: 'commit', state: 'now', title: '1 file changed', files: [{ path: 'a.js', state: 'Modified' }],
        actions: [{ id: 'commit', label: 'Commit', primary: true, input: { placeholder: 'Why', hint: 'Say why' },
          alternative: { label: 'Let the conversation write it' } }] },
      { id: 'land', state: 'wait', title: 'Land in develop' },
      { id: 'close', state: 'wait', title: 'Close' }
    ];
    Tracks.ran = null;
    try {
      await openTracked(panel, session, 'ws_t');
      const field = /** @type {HTMLTextAreaElement} */ (panel.querySelector('[data-step="commit"] textarea'));
      const submit = /** @type {HTMLButtonElement} */ (panel.querySelector('[data-step="commit"] [data-action="commit"]'));
      assert(!!field && field.placeholder === 'Why', 'the message is asked for in the step, not in a dialog');
      assert(submit?.disabled === true, 'and there is nothing to commit with until something is typed');

      field.value = 'Fixed the thing';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      assert(submit.disabled === false, 'typing is what makes it pressable');
      submit.click();
      await waitFor(() => Tracks.ran !== null, { description: 'the commit to run' });
      assert(Tracks.ran?.actionId === 'commit' && Tracks.ran?.input?.message === 'Fixed the thing',
        `the provider gets the action and what was typed, got ${JSON.stringify(Tracks.ran)}`);
      await waitFor(() => !!document.querySelector('modal-dialog.is-notice.is-open .modal-message'),
        { description: 'the panel to say what happened' });
      assert(document.querySelector('modal-dialog.is-notice.is-open .modal-message')?.textContent?.includes('ran commit') === true,
        'what the provider said is shown');
      assert(asked.length === 0,
        `and nothing was asked first, got ${JSON.stringify(asked.map((a) => a.message))}`);
      await waitFor(() => !panel.querySelector('.workspace-panel-step-alternative:disabled'),
        { description: 'the buttons to come back' });

      Tracks.ran = null;
      /** @type {HTMLElement} */ (panel.querySelector('[data-step="commit"] .workspace-panel-step-alternative')).click();
      await waitFor(() => Tracks.ran !== null, { description: 'the alternative to run' });
      assert(Tracks.ran?.actionId === 'commit' && Tracks.ran?.input?.message === '',
        `the alternative is the same action with no message, got ${JSON.stringify(Tracks.ran)}`);
    } finally {
      /** @type {any} */ (window).showModal = originalShowModal;
      Tracks.steps = [];
      neutralizeStrayOverlays();
      teardown();
    }
  });

  await checkAsync('a tree with nothing to commit offers no commit anywhere', async () => {
    const session = makeSession([trackedWorkspace('ws_t')]);
    const { panel, teardown } = mountPanel(session);
    Tracks.steps = [
      { id: 'commit', state: 'done', title: 'Everything is committed' },
      { id: 'land', state: 'now', title: '2 commits not yet in develop', actions: [{ id: 'land', label: 'Land in develop', primary: true }] },
      { id: 'close', state: 'wait', title: 'Close' }
    ];
    try {
      await openTracked(panel, session, 'ws_t');
      assert(!!panel.querySelector('[data-action="land"]'), 'the step to do now is offered');
      /** @type {HTMLElement} */ (panel.querySelector('.workspace-panel-close')).click();
      await waitFor(() => !!document.querySelector('.workspace-panel-close-menu'), { description: 'the Close… menu' });
      assert(!panel.querySelector('[data-action="commit"]') && !document.querySelector('.workspace-panel-close-menu [data-action="commit"]'),
        'a commit offered on a clean tree opens a dialog whose only button cannot be pressed, so the endings '
        + 'are asked for knowing the track, and the provider leaves it out');
      assert(Array.isArray(Tracks.knownTrack?.steps), 'which means the track it read is handed to finishOptions');
    } finally {
      Tracks.steps = [];
      neutralizeStrayOverlays();
      document.querySelector('.workspace-panel-close-menu')?.remove();
      teardown();
    }
  });

  await checkAsync('Close… lists the endings and runs the chosen one through its confirmation', async () => {
    const session = makeSession([trackedWorkspace('ws_t')]);
    const { panel, teardown } = mountPanel(session);
    Tracks.steps = [
      { id: 'commit', state: 'done', title: 'Everything is committed' },
      { id: 'land', state: 'now', title: '2 commits not yet in develop', actions: [{ id: 'land', label: 'Land', primary: true }] },
      { id: 'close', state: 'wait', title: 'Close' }
    ];
    Tracks.ran = null;
    try {
      await openTracked(panel, session, 'ws_t');
      /** @type {HTMLElement} */ (panel.querySelector('.workspace-panel-close')).click();
      await waitFor(() => !!document.querySelector('.workspace-panel-close-menu'), { description: 'the Close… menu' });
      const menu = /** @type {HTMLElement} */ (document.querySelector('.workspace-panel-close-menu'));
      const ids = [...menu.querySelectorAll('[data-action]')].map((/** @type {any} */ row) => row.dataset.action).join(',');
      assert(ids === 'unbind,discard', `the provider's endings, in its order, got "${ids}"`);
      assert(menu.querySelector('[data-action="discard"]')?.classList.contains('menu-item-danger') === true,
        'the one that loses something says so in red');
      assert(menu.querySelector('[data-action="discard"]')?.textContent?.includes('Two commits exist only here.') === true,
        'and what it would lose is on the row, not behind it');

      /** @type {HTMLElement} */ (menu.querySelector('[data-action="unbind"]')).click();
      const confirmed = 'modal-dialog.is-open:not(.is-notice) .modal-footer .btn-primary, modal-dialog.is-open:not(.is-notice) .modal-footer .btn-danger';
      await waitFor(() => !!document.querySelector(confirmed), { description: 'the confirmation to appear' });
      assert(Tracks.ran === null, 'nothing ends before it is agreed to');
      /** @type {HTMLElement} */ (document.querySelector(confirmed)).click();
      await waitFor(() => Tracks.ran !== null, { description: 'the ending to run' });
      assert(Tracks.ran?.actionId === 'unbind', `the chosen ending ran, got ${JSON.stringify(Tracks.ran)}`);
      assert(!document.querySelector('.workspace-panel-close-menu'), 'and the menu went away when it was chosen');
    } finally {
      Tracks.steps = [];
      neutralizeStrayOverlays();
      document.querySelector('.workspace-panel-close-menu')?.remove();
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
      await panel.reread();

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

  await checkAsync('en-XA: the panel, its confirmation and its refusal draw no plain English in any state', async () => {
    // Pinned: only the stand-in provider is registered, under an extension id
    // whose catalogue the case supplies, so the kind and its note are proved to
    // go through that extension's catalogue rather than the lane's registry.
    const registry = /** @type {any} */ (workspaceProviderRegistry);
    const savedItems = new Map(registry.items);
    const savedExtensions = new Map(registry.itemExtensions);
    const savedPaths = new Map(registry.modulePaths);
    registry.items.clear();
    const added = registry.registerClass(SaysLittle, { extensionId: XA_EXTENSION, modulePath: '(test)' });
    const addedTrack = registry.registerClass(SaysLittleOnTrack, { extensionId: XA_EXTENSION, modulePath: '(test)' });
    const { MANIFEST } = SaysLittle;
    const TRACK_MANIFEST = SaysLittleOnTrack.MANIFEST;
    const originalShowModal = /** @type {any} */ (window).showModal;

    // Data is digits: labels, roots, conversation names, provider sentences.
    const table = [
      { id: 'ws_xa', root: '/1/2', label: '8', state: 'ready', available: true, providerId: XA_PROVIDER_ID, baseWorkspaceId: 'ws_xb' },
      { id: 'ws_xb', root: '/1/3', label: '9', state: 'ready', available: true, providerId: XA_PROVIDER_ID },
      { id: 'ws_xc', root: '/1', label: '7', state: 'ready', available: true, providerId: XA_PROVIDER_ID },
      { id: 'ws_xd', root: '/1/4', label: '6', state: 'ready', available: true, providerId: 'i18n-nobody' },
      { id: 'ws_xe', root: '/1/5', label: '5', state: 'ready', available: true, providerId: XA_TRACK_PROVIDER_ID, meta: { base: '5', repoDir: '/1/6' } }
    ];
    const session = makeSession(table);
    session.projectPath = '/1';
    const { panel, teardown } = mountPanel(session);

    /** @type {{where: string, text: string}[]} */
    const shown = [];
    /**
     * Record everything the panel shows in one state, less what is data.
     * @param {string} where - The state.
     */
    const collect = (where) => {
      // Digits are data; a step's ✓ and ! are glyphs, not words.
      const texts = shownStrings(panel).filter((text) => !/^[\d/\s…✓!]+$/.test(text));
      assert(texts.length >= 3, `the panel drew something (${where}), got ${JSON.stringify(texts)}`);
      for (const text of texts) shown.push({ where, text });
    };
    /**
     * Select a workspace and wait for its status read to land.
     * @param {string} id - Which workspace.
     * @param {any} status - What the stand-in answers.
     */
    const select = async (id, status) => {
      SaysLittle.next = status;
      session.selection = { kind: 'workspace', id };
      panel._refresh();
      collect(`${id}, before its status`);
      await waitFor(() => !panel.querySelector('.workspace-panel-pending'),
        { description: `the status read for ${id} to land` });
    };

    try {
      assert(added.registered && addedTrack.registered, `the stand-in providers registered, got ${JSON.stringify([added, addedTrack])}`);
      await underPseudoLocale('workspace-panel-test', async () => {
        // A workspace made from another, holding work it does not describe.
        await select('ws_xa', { dirty: true });
        assert(panel.querySelector('.workspace-panel-dirty'), 'the bare dirty line is drawn');
        assert(panel.querySelector('.workspace-panel-head .workspace-panel-detail'), 'the base workspace line is drawn');
        assert(panel.querySelector('.workspace-panel-kind-note'), 'the kind note is drawn');
        collect('ws_xa, dirty');

        // The red ending, agreed to through a confirmation carrying the warning.
        /** @type {any} */
        let asked = null;
        /** @type {any} */ (window).showModal = async (/** @type {any} */ options) => { asked = options; return false; };
        /** @type {HTMLElement} */ (panel.querySelector('[data-action="end"]')).click();
        await waitFor(() => asked !== null, { description: 'the confirmation to be asked' });
        const parts = String(asked.message).split('\n\n');
        assert(parts.length === 2 && parts[0] === '4', `the provider's sentence, then the warning, got ${JSON.stringify(asked.message)}`);
        shown.push({ where: 'confirmation', text: parts[1] });
        shown.push({ where: 'confirmation buttons', text: String(asked.cancelText) });
        await waitFor(() => !panel.querySelector('[data-action="end"]')?.hasAttribute('disabled'),
          { description: 'the rows to come back' });

        // A provider with nothing to say.
        SaysLittle.next = {};
        await panel.reread();
        assert(panel.querySelector('.workspace-panel-state .workspace-panel-note'), 'the nothing-to-report line is drawn');
        collect('ws_xa, nothing to report');

        // A provider that could not say: the reason is data, the rest is not.
        SaysLittle.next = new Error('5');
        await panel.reread();
        assert(panel.querySelector('.workspace-panel-problem'), 'the problem line is drawn');
        collect('ws_xa, status failed');

        // Two conversations mid-turn: the ending is refused in a sentence.
        session.conversations.set('c_x1', { id: 'c_x1', name: '1', workspaceId: 'ws_xa', isProcessing: true });
        session.conversations.set('c_x2', { id: 'c_x2', name: '2', workspaceId: 'ws_xa', isProcessing: true });
        /** @type {HTMLElement} */ (panel.querySelector('[data-action="end"]')).click();
        await waitFor(() => !!document.querySelector('modal-dialog.is-notice.is-open .modal-message'),
          { description: 'the refusal notice' });
        shown.push({ where: 'refusal (two)', text: document.querySelector('modal-dialog.is-notice.is-open .modal-message')?.textContent ?? '' });
        neutralizeStrayOverlays();
        session.conversations.delete('c_x2');
        /** @type {HTMLElement} */ (panel.querySelector('[data-action="end"]')).click();
        await waitFor(() => !!document.querySelector('modal-dialog.is-notice.is-open .modal-message'),
          { description: 'the refusal notice for one' });
        shown.push({ where: 'refusal (one)', text: document.querySelector('modal-dialog.is-notice.is-open .modal-message')?.textContent ?? '' });
        neutralizeStrayOverlays();
        session.conversations.clear();

        // A workspace whose tree is the project's.
        await select('ws_xc', {});
        collect('ws_xc, in the project');

        // A workspace whose provider is gone: before its status read the
        // reason sits under the actions; after it, in the status lines.
        await select('ws_xd', {});
        assert(panel.querySelector('.workspace-panel-problem'), 'the provider-missing problem is drawn');
        collect('ws_xd, provider missing');

        // A tracked workspace: the head's origin line, every kind of step, the
        // cut-off counts, the secondary row and the Close… menu.
        await select('ws_xe', {});
        assert(panel.querySelector('.workspace-panel-origin'), 'the origin line is drawn');
        assert(panel.querySelector('.workspace-panel-list-more'), 'a cut list is drawn');
        assert(panel.querySelector('.workspace-panel-group'), 'a group is drawn');
        assert(panel.querySelector('.workspace-panel-more [data-action="update"]'), 'the update is drawn');
        collect('ws_xe, tracked');
        /** @type {HTMLElement} */ (panel.querySelector('.workspace-panel-close')).click();
        await waitFor(() => !!document.querySelector('.workspace-panel-close-menu'), { description: 'the Close… menu' });
        const menu = /** @type {HTMLElement} */ (document.querySelector('.workspace-panel-close-menu'));
        for (const text of shownStrings(menu).filter((text) => !/^[\d/\s…]+$/.test(text))) shown.push({ where: 'close menu', text });
        /** @type {HTMLElement} */ (panel.querySelector('.workspace-panel-close')).click();
        assert(!document.querySelector('.workspace-panel-close-menu'), 'a second press closes the menu');
      }, { [XA_EXTENSION]: [MANIFEST.name, MANIFEST.description, TRACK_MANIFEST.name, TRACK_MANIFEST.description] });
    } finally {
      /** @type {any} */ (window).showModal = originalShowModal;
      SaysLittle.next = {};
      neutralizeStrayOverlays();
      teardown();
      registry.items.clear();
      for (const [k, v] of savedItems) registry.items.set(k, v);
      registry.itemExtensions.clear();
      for (const [k, v] of savedExtensions) registry.itemExtensions.set(k, v);
      registry.modulePaths.clear();
      for (const [k, v] of savedPaths) registry.modulePaths.set(k, v);
    }

    const raw = shown.filter(({ text }) => !isPseudoLocalized(text));
    assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
  });

  return { passed, failed, errors };
}
