//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <workspace-panel> — a selected workspace, shown where a conversation would be.
 *
 * A box in the tab strip is selected the way a tab is, and this is what that
 * selection shows: the place itself. What is here is true of the tree rather
 * than of anyone working in it — what it is called, what kind of place it is,
 * where it is on disk, how it is doing, and the ways of finishing with it.
 *
 * Two layouts, chosen by the provider. One with a track (`track()` in
 * `sdk/workspace-provider.js`) gets its steps from here to done, with the next
 * thing to do as the only primary button, a quiet row of everything else, and
 * its endings behind "Close…". One without gets its status line and its finish
 * options as rows, each saying what it will do.
 *
 * What is NOT here is the one thing that belongs to a single conversation:
 * moving one to a different workspace. A workspace of three conversations
 * names none of them, so that lives on the tab.
 * @module components/workspace-panel
 */

import JugglerElement from './juggler-element.js';
import {
  selectedWorkspace,
  workspaceStatus,
  workspaceTrack,
  workspaceHasTrack,
  workspaceKind,
  workspaceKindNote,
  workspaceFinishOptions,
  workspaceFinishWarning,
  workspaceFinishActor,
  finishWorkspace
} from '../services/workspace-provisioning.js';
import { errorText } from '../../sdk/lib/error-utils.js';
import { t } from '../../sdk/lib/i18n.js';
import workspaceProviderRegistry from '../registries/workspace-provider-registry.js';
import { capabilityLabel } from '../utils/capability-label.js';
import { createFileActions } from '../utils/properties-panel-helpers.js';
import { setupColumnResize, startingColumnWidth } from '../utils/column-resize.js';
import { presentPopup } from '../utils/popup-surface.js';
import { applyMenuRoles, attachMenuKeyboard } from '../utils/menu-roles.js';
import { showConfirm, showNotice } from './modal-dialog.js';
import { openWorkspaceFinish } from './workspace-finish-dialog.js';
import { sameTree } from '../services/workspace-rebinding.js';
import pinboardView from '../services/pinboard-view.js';

/** How many rows of a file or commit list are drawn before the rest is counted. */
const LIST_ROWS = 8;

/**
 * Track actions that ask first. Everything else on a track is safe by
 * construction — a commit, a landing that stops on a conflict without touching
 * the base — and asking would only teach that the question means nothing.
 */
const ASKS_FIRST = new Set(['abort', 'discard']);

/**
 * WorkspacePanel - the workspace the tab strip has selected, written out.
 */
class WorkspacePanel extends JugglerElement {
  constructor() {
    super();

    /** @type {any} The session holding the selection. */
    this._session = null;

    /** @type {(() => void)|null} How to stop listening to it. */
    this._unsubscribe = null;

    /** @type {any} The workspace currently drawn, or null. */
    this._workspace = null;

    /** @type {any} What its provider last said about it. */
    this._status = null;

    /**
     * Its track as last read: undefined before the first answer, null for a
     * provider that answered with none.
     * @type {any}
     */
    this._track = undefined;

    /** @type {AbortController|null} The read in flight, if there is one. */
    this._probe = null;

    /** @type {HTMLElement|null} The column's right-edge resize grip. */
    this._resizeHandle = null;

    /** @type {string} The action being carried out, while one is. */
    this._running = '';

    /**
     * The provider's options as of the last draw, by id. A button kept from an
     * earlier draw finds its option here when pressed, so it carries out what
     * the provider offers now rather than what it offered when the button was
     * made.
     * @type {Map<string, any>}
     */
    this._options = new Map();

    /**
     * What has been typed into each step's field, by `step:action`, so a read
     * landing while somebody types — a turn ending, the window regaining focus —
     * redraws the field with their words still in it.
     * @type {Map<string, string>}
     */
    this._drafts = new Map();

    /** @type {Set<string>} Conversations here last seen mid-turn. */
    this._busy = new Set();

    /** @type {(() => void)|null} Closes the Close… menu, while it is open. */
    this._closeMenu = null;
  }

  connectedCallback() {
    // A panel put back in the document already has its session and is not
    // handed it again: take back the feed the disconnect dropped, and redraw,
    // which asks again about a tree whose read the disconnect abandoned.
    if (this._session && !this._unsubscribe) {
      this._listen();
      this._refresh();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    // Re-assignable (setSession drops and re-takes it mid-life), so it stays a
    // field rather than an addCleanup registration.
    this._stopListening();
    this._closeMenu?.();
    this._probe?.abort();
    this._probe = null;
  }

  /**
   * @param {import('../model/session.js').default|null} session - The session to follow.
   * @returns {void}
   */
  setSession(session) {
    this._stopListening();
    this._session = session;
    this._refresh();
    if (this.isConnected) this._listen();
  }

  /** @private */
  _stopListening() {
    this._unsubscribe?.();
    this._unsubscribe = null;
  }

  /**
   * Follow the session's selection and workspace table, and everything that
   * may have changed the tree while nobody was reading it: a conversation here
   * finishing a turn, and the window coming back to the front. No polling — a
   * read of a worktree is several git commands.
   * @private
   */
  _listen() {
    const session = this._session;
    if (!session || this._unsubscribe) return;

    const offSession = session.subscribe((/** @type {{type: string}} */ event) => {
      // Nothing here is about a conversation except the selection: going to one
      // is what takes this panel off screen. What the conversations are called
      // and how many there are belongs to the tab strip, which is drawing them.
      if (event.type === 'workspace:selected'
        || event.type === 'conversation:switched'
        || event.type === 'session:workspaces-changed'
        || event.type === 'session:loaded') {
        this._refresh();
      }
    });
    // The processing-state feed, not `conversation:changed`: what ends a turn
    // is the run settling, and that is the one thing this feed reports.
    const offStatus = typeof session.onLLMStatusChange === 'function'
      ? session.onLLMStatusChange((/** @type {string} */ id) => this._onConversationStatus(id))
      : () => {};
    const onVisible = () => {
      if (document.visibilityState === 'visible') this._rereadIfIdle();
    };
    const onFocus = () => this._rereadIfIdle();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);

    this._unsubscribe = () => {
      offSession();
      offStatus();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
    };
  }

  /**
   * A conversation's run started or stopped. One working here that has come
   * to rest has probably changed the tree, so the tree is read again.
   * @param {string} id - The conversation whose status changed.
   * @private
   */
  _onConversationStatus(id) {
    const conversation = this._session?.conversations?.get?.(id);
    const here = this._workspace?.id ?? '';
    if (!conversation || !here || (conversation.workspaceId || '') !== here) {
      this._busy.delete(id);
      return;
    }
    if (conversation.llmState?.isConversationProcessing?.(id)) this._busy.add(id);
    else if (this._busy.delete(id)) this._rereadIfIdle();
  }

  /**
   * Read the tree again, unless nothing is shown or an action is running —
   * that action reads it again itself when it is done.
   * @private
   */
  _rereadIfIdle() {
    if (this._workspace && !this._running) void this.reread();
  }

  /**
   * Show the selected workspace, or get out of the way.
   *
   * The tab column is hidden by one class on <body>, the way the two
   * onboarding overlays hide it — the panel is what is on screen instead of a
   * conversation, not something drawn over one.
   * @private
   */
  _refresh() {
    const workspace = selectedWorkspace(this._session);
    const changed = this._workspace?.id !== workspace?.id;
    this._workspace = workspace;

    document.body.classList.toggle('workspace-selected', !!workspace);
    this.hidden = !workspace;

    if (changed) {
      this._closeMenu?.();
      this._drafts.clear();
      this._busy.clear();
    }
    if (!workspace) {
      this._probe?.abort();
      this._probe = null;
      this._status = null;
      this._track = undefined;
      this.replaceChildren();
      return;
    }

    if (changed) {
      this._status = null;
      this._track = undefined;
    }
    this.render();
    // The row is all this can draw without asking anyone, and it says nothing
    // about the state of the tree. So the first draw is followed by the
    // question. Once, though: the panel redraws on events that say nothing
    // about the workspace, and each of those aborting the last one's read
    // would leave a panel that never manages to say how the tree is doing.
    if (changed || (!this._status && !this._probe)) void this.reread();
  }

  /**
   * Ask the workspace's provider how it is doing and, when it has one, where
   * its track stands — both at once, drawn together. A read already in flight
   * is abandoned: this one asks the same question later.
   * @returns {Promise<void>} When there is an answer, or it has been abandoned.
   */
  async reread() {
    const workspace = this._workspace;
    this._probe?.abort();
    this._probe = null;
    if (!workspace || !this._session) return;

    const controller = new AbortController();
    this._probe = controller;
    const [status, track] = await Promise.all([
      workspaceStatus(this._session, workspace, controller.signal),
      workspaceHasTrack(this._session, workspace)
        ? workspaceTrack(this._session, workspace, controller.signal)
        : Promise.resolve(null)
    ]);
    // Both are worth asking: the answer may be to a question about a workspace
    // this panel has since stopped being about.
    if (controller.signal.aborted || this._workspace?.id !== workspace.id) return;
    this._probe = null;
    this._status = status;
    this._track = track;
    this.render();
  }

  /**
   * What the panel calls the place: the name on its row.
   *
   * The row is the only thing that names a workspace. A read says how a tree
   * is DOING and has no say in what it is called — it arrives a second after
   * the first draw, so a name taken from there would change under somebody
   * already reading it.
   * @returns {string} The name.
   * @private
   */
  _label() {
    return this._workspace?.label || this._workspace?.root || '';
  }

  /**
   * What kind of place it is, in the words of whatever made it: the
   * provider's manifest name, a property of the TYPE and so known from the
   * first draw.
   * @returns {string} The kind, in the UI language, or '' when its provider is
   *   not loaded.
   * @private
   */
  _kind() {
    const kind = workspaceKind(this._session, this._workspace);
    return kind ? capabilityLabel(kind, this._workspace?.providerId, workspaceProviderRegistry) : '';
  }

  /**
   * Whether this workspace is drawn with its track: its provider has one, and
   * did not answer that this tree has none.
   * @returns {boolean} True for the track layout.
   * @private
   */
  _tracked() {
    return this._track !== null && workspaceHasTrack(this._session, this._workspace);
  }

  render() {
    const workspace = this._workspace;
    if (!workspace) {
      this.replaceChildren();
      return;
    }

    const body = document.createElement('section');
    body.className = 'workspace-panel-body';
    body.setAttribute('aria-label', t('Workspace'));
    body.appendChild(this._head());

    // What has been read is handed on, so an ending can say what it would cost
    // — and a provider that reads its track does not offer a commit the track
    // has already said there is nothing for.
    const track = this._track && Array.isArray(this._track.steps) ? this._track : null;
    const { options, unavailableReason } = workspaceFinishOptions(this._session, workspace, {
      status: this._status,
      ...(track ? { track } : {})
    });
    this._options = new Map(options.map((/** @type {any} */ option) => [option.id, option]));
    const keeps = unavailableReason ? [] : options.filter(option => option.keepsWorkspace);
    const endings = unavailableReason ? [] : options.filter(option => !option.keepsWorkspace);

    if (this._tracked()) {
      body.appendChild(this._trackSection());
      body.appendChild(this._more(keeps, endings, unavailableReason ?? ''));
    } else {
      body.appendChild(this._state());
      body.appendChild(this._starting());
      if (keeps.length || unavailableReason) body.appendChild(this._doing(keeps, unavailableReason ?? ''));
      if (endings.length) body.appendChild(this._endings(endings));
    }

    this._settle(body);
    // A menu whose button a redraw replaced is anchored to nothing on screen.
    if (this._closeMenu && !this.querySelector('.workspace-panel-close[aria-expanded="true"]')) this._closeMenu();
  }

  /**
   * Put a fresh draw on screen, keeping every section of the last one that it
   * would draw the same.
   *
   * The panel redraws when a read lands, about a second after it opens, and on
   * workspace-table events from anywhere in the session — and most of those
   * change nothing about the buttons. A button swapped for its identical twin
   * under a pointer swallows the click whose press landed on the old one, and
   * takes focus and hover with it. So only a section that differs is replaced;
   * the rest stay the nodes they were.
   * @param {HTMLElement} body - The fresh draw.
   * @returns {void}
   * @private
   */
  _settle(body) {
    const current = /** @type {HTMLElement|null} */ (this.querySelector(':scope > .workspace-panel-body'));
    if (!current) {
      this.replaceChildren(body, this._columnHandle());
      return;
    }
    // Taken before the loop: each replaceWith moves a fresh section out of
    // `body`, which would otherwise shift the ones after it.
    const fresh = Array.from(body.children);
    fresh.forEach((section, i) => {
      const was = current.children[i];
      if (!was) current.appendChild(section);
      else if (!was.isEqualNode(section)) was.replaceWith(section);
    });
    while (current.children.length > fresh.length) current.lastElementChild?.remove();
  }

  /**
   * The grip that widens the column, made once and put back after each redraw.
   *
   * Under `juggler-column-width` at depth 0, the root conversation column's own
   * width: the panel stands exactly where a root conversation stands, so it is
   * the same column at the same width, and widening either widens both.
   * @returns {HTMLElement} The handle.
   * @private
   */
  _columnHandle() {
    if (this._resizeHandle) return this._resizeHandle;
    this._resizeHandle = document.createElement('col-resize-handle');
    this.appendChild(this._resizeHandle);
    setupColumnResize(this, 'juggler-column-width', undefined, startingColumnWidth(), 0);
    return this._resizeHandle;
  }

  /**
   * The name, what kind of place it is, where it came from, and where it is.
   *
   * Every line here is known from the row and the manifest, so the head is
   * right on the first draw and never changes under a reader. Where the row's
   * record names the branch it was made from and the repository, that is said;
   * otherwise the kind's own sentence says what one of these is.
   * @returns {HTMLElement} The panel's head.
   * @private
   */
  _head() {
    const head = document.createElement('header');
    head.className = 'workspace-panel-head';

    const titleRow = document.createElement('div');
    titleRow.className = 'workspace-panel-title-row';
    const title = document.createElement('h2');
    title.className = 'workspace-panel-title';
    title.textContent = this._label();
    titleRow.appendChild(title);
    const kind = this._kind();
    if (kind) {
      const chip = document.createElement('span');
      chip.className = 'workspace-panel-kind';
      chip.textContent = kind;
      titleRow.appendChild(chip);
    }
    head.appendChild(titleRow);

    const meta = this._workspace?.meta ?? {};
    const base = typeof meta.base === 'string' ? meta.base : '';
    const repoDir = typeof meta.repoDir === 'string' ? meta.repoDir : '';
    const repo = repoDir.split(/[\\/]/).filter(Boolean).pop() ?? '';
    if (base && repo) {
      const origin = document.createElement('p');
      origin.className = 'workspace-panel-origin';
      origin.textContent = t('Branched from {base} in {repo}', { base, repo });
      head.appendChild(origin);
    } else {
      const note = workspaceKindNote(this._session, this._workspace);
      if (note) {
        const says = document.createElement('p');
        says.className = 'workspace-panel-kind-note';
        says.textContent = capabilityLabel(note, this._workspace?.providerId, workspaceProviderRegistry);
        head.appendChild(says);
      }
    }

    head.appendChild(this._pathRow());

    // A tree made out of another tree says so. Only when the other one is a
    // workspace too: everything here is made from the project unless it says
    // otherwise, and a line repeating the default on every panel is furniture.
    const from = this._base();
    if (from) {
      const line = document.createElement('p');
      line.className = 'workspace-panel-detail';
      line.textContent = t('Base workspace: {base}', { base: from });
      head.appendChild(line);
    }
    return head;
  }

  /**
   * The root, written out in full on one line, with the things one does with a
   * path: copy it, show it on disk, put it on the board. Whole, because no rule
   * about which part of a path matters survives the paths providers make.
   * @returns {HTMLElement} The row.
   * @private
   */
  _pathRow() {
    const path = this._workspace?.root ?? '';
    const row = document.createElement('div');
    row.className = 'workspace-panel-path-row';

    const box = document.createElement('div');
    box.className = 'workspace-panel-path properties-panel-filepath-box';
    box.textContent = path;
    box.title = path;
    // The same hook the right-click Open / Reveal / Copy menu reads elsewhere,
    // so the path behaves like a path wherever it is met.
    if (path) box.dataset.filePath = path;
    row.appendChild(box);

    const actions = createFileActions(path, { pin: path, directory: true });
    if (actions) row.appendChild(actions);
    return row;
  }

  /**
   * The workspace this one was made out of, when that is another workspace.
   * @returns {string} What to call it, or '' when it was made from the project.
   * @private
   */
  _base() {
    const id = this._workspace?.baseWorkspaceId ?? '';
    if (!id) return '';
    const row = this._session?.getWorkspace?.(id);
    return row ? (row.label || row.root || '') : '';
  }

  /**
   * A button that stands down while any action here is running. The guard is
   * on the panel rather than the button, because the panel redraws while an
   * action is in flight and the button pressed is gone by the time it ends.
   * @param {string} className - Its classes.
   * @param {string} label - What it says.
   * @param {() => void} onClick - What it does.
   * @param {string} [needs] - The draft it needs text in before it can be pressed.
   * @returns {HTMLButtonElement} The button.
   * @private
   */
  _runButton(className, label, onClick, needs = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${className} workspace-panel-runs`;
    button.textContent = label;
    if (needs) button.dataset.needs = needs;
    button.disabled = this._standsDown(button);
    button.addEventListener('click', onClick);
    return button;
  }

  /**
   * @param {HTMLButtonElement} button - A button made by {@link _runButton}.
   * @returns {boolean} Whether it may not be pressed now.
   * @private
   */
  _standsDown(button) {
    const needs = button.dataset.needs ?? '';
    return this._running !== '' || (needs !== '' && !(this._drafts.get(needs) ?? '').trim());
  }

  // ==========================================================================
  // The track
  // ==========================================================================

  /**
   * The steps from here to done, or the room they will be drawn in.
   * @returns {HTMLElement} The section.
   * @private
   */
  _trackSection() {
    const section = document.createElement('div');
    section.className = 'workspace-panel-section workspace-panel-track-section';

    if (this._track === undefined) {
      const pending = document.createElement('p');
      pending.className = 'workspace-panel-pending';
      pending.textContent = t('Reading…');
      section.appendChild(pending);
      return section;
    }

    if (this._track?.problem) {
      const problem = document.createElement('p');
      problem.className = 'workspace-panel-problem';
      problem.textContent = this._track.problem;
      section.appendChild(problem);
    }

    const steps = Array.isArray(this._track?.steps) ? this._track.steps : [];
    // A draft belongs to a field that is still offered; one whose step has
    // moved on was for work that has been done.
    const offered = new Set();
    if (steps.length) {
      const list = document.createElement('ol');
      list.className = 'workspace-panel-track';
      steps.forEach((/** @type {any} */ step, /** @type {number} */ index) => {
        list.appendChild(this._step(step, index, offered));
      });
      section.appendChild(list);
    }
    for (const key of [...this._drafts.keys()]) if (!offered.has(key)) this._drafts.delete(key);
    return section;
  }

  /**
   * One step: its dot, what it is, what it is about, and — only for the step to
   * do now or the one stopped on something — what can be done from it.
   * @param {any} step - The provider's step.
   * @param {number} index - Its place in the track.
   * @param {Set<string>} offered - Collects the drafts whose fields are drawn.
   * @returns {HTMLElement} The step.
   * @private
   */
  _step(step, index, offered) {
    const state = ['done', 'now', 'wait', 'blocked'].includes(step.state) ? step.state : 'wait';
    // Each modifier written out, so the stylesheet's selectors can be found
    // from here and the element they land on is known to be this one.
    const item = document.createElement('li');
    item.className = 'workspace-panel-step';
    item.classList.toggle('workspace-panel-step--done', state === 'done');
    item.classList.toggle('workspace-panel-step--now', state === 'now');
    item.classList.toggle('workspace-panel-step--wait', state === 'wait');
    item.classList.toggle('workspace-panel-step--blocked', state === 'blocked');
    item.dataset.step = step.id;

    const dot = document.createElement('span');
    dot.className = 'workspace-panel-step-dot';
    dot.setAttribute('aria-hidden', 'true');
    dot.textContent = state === 'done' ? '✓' : state === 'blocked' ? '!' : String(index + 1);
    item.appendChild(dot);

    const body = document.createElement('div');
    body.className = 'workspace-panel-step-body';
    const title = document.createElement('h3');
    title.className = 'workspace-panel-step-title';
    title.textContent = step.title ?? '';
    body.appendChild(title);
    if (step.note) {
      const note = document.createElement('p');
      note.className = 'workspace-panel-step-note';
      note.textContent = step.note;
      body.appendChild(note);
    }

    this._lists(body, step);
    for (const group of step.groups ?? []) {
      const box = document.createElement('div');
      box.className = 'workspace-panel-group';
      const name = document.createElement('div');
      name.className = 'workspace-panel-group-name';
      name.textContent = group.name ?? '';
      box.appendChild(name);
      if (group.note) {
        const note = document.createElement('p');
        note.className = 'workspace-panel-step-note';
        note.textContent = group.note;
        box.appendChild(note);
      }
      this._lists(box, group);
      body.appendChild(box);
    }

    if (state === 'now' || state === 'blocked') {
      // Bringing the base in is never what a step is waiting on, so it is
      // offered in the quiet row under the track instead.
      const actions = (step.actions ?? []).filter((/** @type {any} */ action) => action.id !== 'update');
      if (actions.length) body.appendChild(this._stepActions(step, actions, offered));
    }
    item.appendChild(body);
    return item;
  }

  /**
   * A step's or a group's files and commits, each cut at {@link LIST_ROWS}
   * with the rest counted from the provider's total.
   * @param {HTMLElement} into - Where they go.
   * @param {any} source - The step or group.
   * @private
   */
  _lists(into, source) {
    if (source.files?.length) {
      into.appendChild(this._list(source.files.map((/** @type {any} */ file) => {
        const row = document.createElement('li');
        const path = document.createElement('span');
        path.className = 'workspace-panel-list-text';
        path.textContent = file.path ?? '';
        row.appendChild(path);
        if (file.state) {
          const state = document.createElement('span');
          state.className = 'workspace-panel-list-key';
          state.textContent = file.state;
          row.appendChild(state);
        }
        return row;
      }), source.fileCount));
    }
    if (source.commits?.length) {
      into.appendChild(this._list(source.commits.map((/** @type {any} */ commit) => {
        const row = document.createElement('li');
        const sha = document.createElement('span');
        sha.className = 'workspace-panel-list-key';
        sha.textContent = commit.sha ?? '';
        row.appendChild(sha);
        const subject = document.createElement('span');
        subject.className = 'workspace-panel-list-text';
        subject.textContent = commit.subject ?? '';
        row.appendChild(subject);
        return row;
      }), source.commitCount));
    }
  }

  /**
   * @param {HTMLElement[]} rows - Every row the provider listed.
   * @param {number} [total] - How many there really are.
   * @returns {HTMLElement} The list, cut, with what it left out counted.
   * @private
   */
  _list(rows, total) {
    const list = document.createElement('ul');
    list.className = 'workspace-panel-list';
    for (const row of rows.slice(0, LIST_ROWS)) list.appendChild(row);
    const left = Math.max(Number(total ?? 0), rows.length) - Math.min(rows.length, LIST_ROWS);
    if (left > 0) {
      const more = document.createElement('li');
      more.className = 'workspace-panel-list-more';
      more.textContent = t('{count, plural, one {+# more} other {+# more}}', { count: left });
      list.appendChild(more);
    }
    return list;
  }

  /**
   * What a step offers. An action that asks for text gets its field here, in
   * the step that shows what it will act on, and a button that cannot be
   * pressed until something is typed; ⌘/Ctrl+Enter presses it.
   * @param {any} step - The step.
   * @param {any[]} actions - Its actions, less the update.
   * @param {Set<string>} offered - Collects the drafts whose fields are drawn.
   * @returns {HTMLElement} The actions.
   * @private
   */
  _stepActions(step, actions, offered) {
    const box = document.createElement('div');
    box.className = 'workspace-panel-step-form';
    const row = document.createElement('div');
    row.className = 'workspace-panel-step-actions';

    for (const action of actions) {
      if (!action.input) {
        const button = this._runButton(action.primary ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-secondary',
          action.label, () => this._runTrack(step.id, action.id, ''));
        button.dataset.action = action.id;
        row.appendChild(button);
        continue;
      }

      const key = `${step.id}:${action.id}`;
      offered.add(key);
      const field = document.createElement('textarea');
      field.className = 'field-input field-input-sm workspace-panel-step-input';
      field.rows = action.input.multiline ? 3 : 1;
      if (action.input.placeholder) field.placeholder = action.input.placeholder;
      field.setAttribute('aria-label', action.label);
      field.value = this._drafts.get(key) ?? '';
      box.appendChild(field);
      if (action.input.hint) {
        const hint = document.createElement('p');
        hint.className = 'workspace-panel-step-hint';
        hint.textContent = action.input.hint;
        box.appendChild(hint);
      }

      const submit = this._runButton(action.primary ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-secondary',
        action.input.confirmLabel || action.label,
        () => this._runTrack(step.id, action.id, field.value.trim()), key);
      submit.dataset.action = action.id;
      row.appendChild(submit);
      field.addEventListener('input', () => {
        this._drafts.set(key, field.value);
        submit.disabled = this._standsDown(submit);
      });
      field.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          if (!submit.disabled) submit.click();
        }
      });

      if (action.alternative?.label) {
        const other = this._runButton('btn btn-sm btn-ghost workspace-panel-step-alternative',
          action.alternative.label, () => this._runTrack(step.id, action.id, ''));
        if (action.alternative.hint) other.title = action.alternative.hint;
        row.appendChild(other);
      }
    }
    box.appendChild(row);
    return box;
  }

  /**
   * The quiet row under the track: a new conversation here, the tree in the
   * Git view, the update the track offers, anything else that keeps the
   * workspace, and "Close…".
   * @param {any[]} keeps - The finish options that keep the workspace.
   * @param {any[]} endings - The ones that do not.
   * @param {string} unavailableReason - Why there are none, if there are none.
   * @returns {HTMLElement} The row.
   * @private
   */
  _more(keeps, endings, unavailableReason) {
    const section = document.createElement('div');
    section.className = 'workspace-panel-section workspace-panel-more';

    const create = this._runButton('btn btn-xs btn-ghost workspace-panel-more-create', t('New conversation here'),
      () => this._create());
    const plus = document.createElement('span');
    plus.className = 'icon-plus';
    create.prepend(plus);
    section.appendChild(create);

    if (pinboardView.canPin({ kind: 'git' })) {
      section.appendChild(this._runButton('btn btn-xs btn-ghost workspace-panel-more-git', t('Show in Git view'),
        () => { void this._showInGit(); }));
    }

    const steps = Array.isArray(this._track?.steps) ? this._track.steps : [];
    for (const step of steps) {
      const update = (step.actions ?? []).find((/** @type {any} */ action) => action.id === 'update');
      if (!update) continue;
      const button = this._runButton('btn btn-xs btn-ghost', update.label, () => this._runTrack(step.id, 'update', ''));
      button.dataset.action = 'update';
      section.appendChild(button);
    }

    for (const option of keeps) {
      const button = this._runButton('btn btn-xs btn-ghost', option.prompt ? `${option.label}…` : option.label,
        () => { void this._finish(this._options.get(option.id) ?? option); });
      button.dataset.action = option.id;
      button.title = option.description ?? '';
      section.appendChild(button);
    }

    const spacer = document.createElement('span');
    spacer.className = 'workspace-panel-more-spacer';
    section.appendChild(spacer);

    if (unavailableReason) {
      const note = document.createElement('p');
      note.className = 'workspace-panel-note';
      note.textContent = unavailableReason;
      section.appendChild(note);
    } else if (endings.length) {
      const close = this._runButton('btn btn-xs btn-ghost workspace-panel-close', t('Close…'), () => {
        if (this._closeMenu) this._closeMenu();
        else this._openCloseMenu(close);
      });
      close.setAttribute('aria-haspopup', 'menu');
      close.setAttribute('aria-expanded', this._closeMenu ? 'true' : 'false');
      section.appendChild(close);
    }
    return section;
  }

  /**
   * Put this workspace's tree on the board as a Git pin fixed to it, comparing
   * the branch with the one it was made from — what landing it would bring in —
   * or, where the record names neither, the branch against where it left the
   * default branch.
   * @returns {Promise<void>} When it is on the board.
   * @private
   */
  async _showInGit() {
    const workspace = this._workspace;
    if (!workspace) return;
    const meta = workspace.meta ?? {};
    const base = typeof meta.base === 'string' ? meta.base : '';
    const branch = typeof meta.branch === 'string' ? meta.branch : '';
    try {
      await pinboardView.add('git', {
        workspace: workspace.id,
        scope: base && branch ? `${base}...${branch}` : '@branch'
      });
    } catch (error) {
      showNotice(errorText(error));
    }
  }

  /**
   * The endings, as a menu under "Close…": each its label and what it does to
   * the tree, red where it would lose something. Choosing one goes the way
   * every ending goes — the warning, the confirmation, then the provider.
   * @param {HTMLElement} anchor - The "Close…" button.
   * @private
   */
  _openCloseMenu(anchor) {
    const endings = [...this._options.values()].filter((option) => !option.keepsWorkspace);
    if (!endings.length) return;

    const surface = document.createElement('nav');
    surface.className = 'dropdown-menu workspace-panel-close-menu is-open';
    const list = document.createElement('menu');
    for (const option of endings) {
      const row = document.createElement('li');
      row.className = option.danger ? 'menu-item menu-item-danger workspace-panel-close-item' : 'menu-item workspace-panel-close-item';
      row.dataset.action = option.id;
      const label = document.createElement('span');
      label.className = 'workspace-panel-close-label';
      label.textContent = option.prompt ? `${option.label}…` : option.label;
      row.appendChild(label);
      if (option.description) {
        const note = document.createElement('span');
        note.className = 'workspace-panel-close-note';
        note.textContent = option.description;
        row.appendChild(note);
      }
      row.addEventListener('click', () => {
        this._closeMenu?.();
        void this._finish(this._options.get(option.id) ?? option);
      });
      list.appendChild(row);
    }
    applyMenuRoles(list, t('Close…'));
    surface.appendChild(list);

    /** @type {(() => void)|null} */
    let release = null;
    const close = () => {
      this._closeMenu = null;
      for (const button of this.querySelectorAll('.workspace-panel-close')) button.setAttribute('aria-expanded', 'false');
      const r = release;
      release = null;
      r?.();
    };
    this._closeMenu = close;
    release = presentPopup({
      surface,
      anchor,
      id: 'workspace-panel-close-menu',
      onClose: close,
      gap: 4,
      align: 'right',
      insideSelectors: ['.workspace-panel-close-menu', '.workspace-panel-close'],
    });
    attachMenuKeyboard(list, { close });
    anchor.setAttribute('aria-expanded', 'true');
  }

  /**
   * Run one of a track step's actions, looked up in the track as it stands
   * now. Deleting the tree is an ending, whichever step offers it, so it goes
   * the endings' way and carries their warning and their red.
   * @param {string} stepId - Which step.
   * @param {string} actionId - Which of its actions.
   * @param {string} message - What was typed, or '' for none.
   * @returns {void}
   * @private
   */
  _runTrack(stepId, actionId, message) {
    const steps = Array.isArray(this._track?.steps) ? this._track.steps : [];
    const action = steps.find((/** @type {any} */ step) => step.id === stepId)?.actions
      ?.find((/** @type {any} */ candidate) => candidate.id === actionId);
    if (!action) return;
    const ending = this._options.get(actionId);
    if (ending && !ending.keepsWorkspace) {
      void this._finish(ending);
      return;
    }
    void this._guard(actionId, () => this._carryOutTrack(action, message));
  }

  /**
   * A track action: asked about first only where it throws something away,
   * then handed to the provider with what was typed.
   * @param {any} action - The action.
   * @param {string} message - What was typed.
   * @returns {Promise<void>} When it has run, or been called off.
   * @private
   */
  async _carryOutTrack(action, message) {
    const workspace = this._workspace;
    const session = this._session;
    if (!workspace || !session) return;

    if (ASKS_FIRST.has(action.id)) {
      const agreed = await showConfirm(action.label, action.label,
        { confirmText: action.label, danger: action.id === 'discard' });
      if (!agreed) return;
    }
    const result = await finishWorkspace({
      session,
      workspace,
      conversation: workspaceFinishActor(session, workspace),
      actionId: action.id,
      input: { message }
    });
    if (result?.message) showNotice(result.message);
    this._settled();
  }

  // ==========================================================================
  // Without a track
  // ==========================================================================

  /**
   * What the provider reports about this workspace, in room held from the
   * first draw: the answer is a round trip away and the buttons are under it,
   * so a line that appeared with the answer would shove them down just as a
   * pointer reaches for one. The problem is kept apart from the detail: a
   * workspace that answered and one nobody could reach must never read alike.
   * @returns {HTMLElement} The state section.
   * @private
   */
  _state() {
    const section = document.createElement('div');
    section.className = 'workspace-panel-section workspace-panel-state';

    const lines = document.createElement('div');
    lines.className = 'workspace-panel-state-lines';
    section.appendChild(lines);

    /**
     * @param {string} className - Which kind of line it is.
     * @param {string} text - What it says.
     */
    const say = (className, text) => {
      const line = document.createElement('p');
      line.className = className;
      line.textContent = text;
      lines.appendChild(line);
    };

    if (!this._status) {
      say('workspace-panel-pending', t('Reading…'));
      return section;
    }

    const detail = this._status.detail || '';
    const problem = this._status.problem || '';
    const dirty = this._status.dirty === true;
    // Uncommitted work is a colour on the line that accounts for it, not a line
    // of its own; only a provider that flagged the work without describing it
    // gets a line to say so.
    if (detail) say(`workspace-panel-detail${dirty ? ' workspace-panel-dirty' : ''}`, detail);
    else if (dirty) say('workspace-panel-dirty', t('Uncommitted changes.'));
    if (problem) say('workspace-panel-problem', problem);
    if (!lines.children.length) say('workspace-panel-note', t('Nothing to report.'));
    return section;
  }

  /**
   * The row that starts work here, saying where that work will happen. No
   * list of who is working here already: the tab strip is drawing exactly
   * that, a box away.
   * @returns {HTMLElement} The section.
   * @private
   */
  _starting() {
    const section = document.createElement('div');
    section.className = 'workspace-panel-section workspace-panel-starting';

    const rows = document.createElement('div');
    rows.className = 'workspace-panel-actions';

    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'workspace-panel-action workspace-panel-create';
    // A group is rooted at the project, and telling somebody starting one
    // there that it works somewhere else would be the opposite of true.
    const inProject = sameTree(this._session, this._workspace?.id ?? '', '');
    create.appendChild(this._actionLabel(
      t('Start a new conversation here'),
      inProject
        ? t('It works in the project as usual, and is kept here with the others.')
        : t('It works in this workspace’s own files, not the project’s.'),
      'icon-plus'));
    create.addEventListener('click', () => this._create());
    rows.appendChild(create);
    section.appendChild(rows);
    return section;
  }

  /**
   * What the provider offers that leaves the workspace in use, and the reason
   * there is nothing on offer at all — "this provider offers no endings" and
   * "the extension that knew how to end this is gone" are different things to
   * be told. Not repeated when the state section has already said it.
   * @param {any[]} options - The provider's options that keep the workspace.
   * @param {string} unavailableReason - Why it offered nothing, if it did not.
   * @returns {HTMLElement} The section.
   * @private
   */
  _doing(options, unavailableReason) {
    const section = document.createElement('div');
    section.className = 'workspace-panel-section workspace-panel-doing';

    if (options.length) {
      const rows = document.createElement('div');
      rows.className = 'workspace-panel-actions';
      for (const option of options) rows.appendChild(this._finishButton(option));
      section.appendChild(rows);
    }

    if (unavailableReason && unavailableReason !== this._status?.problem) {
      const note = document.createElement('p');
      note.className = 'workspace-panel-note';
      note.textContent = unavailableReason;
      section.appendChild(note);
    }
    return section;
  }

  /**
   * The ways of finishing with the place. Each carries the trashcan and says
   * what becomes of what is on disk.
   * @param {any[]} endings - The options that do not keep the workspace.
   * @returns {HTMLElement} The section.
   * @private
   */
  _endings(endings) {
    const section = document.createElement('div');
    section.className = 'workspace-panel-section workspace-panel-endings';

    const rows = document.createElement('div');
    rows.className = 'workspace-panel-actions';
    for (const option of endings) rows.appendChild(this._finishButton(option));
    section.appendChild(rows);
    return section;
  }

  /**
   * One thing a provider can do with this workspace, as a row.
   *
   * The ellipsis is the promise the rest of the app makes: a label that ends in
   * one asks for something before it does anything. An ending wears the
   * trashcan, which is what this app puts on everything that takes something
   * away.
   * @param {any} option - What the provider offered.
   * @returns {HTMLElement} The button.
   * @private
   */
  _finishButton(option) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = option.danger
      ? 'workspace-panel-action danger workspace-panel-runs'
      : 'workspace-panel-action workspace-panel-runs';
    button.dataset.action = option.id;
    button.disabled = this._running !== '';
    button.appendChild(this._actionLabel(
      option.prompt ? `${option.label}…` : option.label,
      option.description,
      option.keepsWorkspace ? '' : 'icon-trashcan'));
    button.addEventListener('click', () => { void this._finish(this._options.get(option.id) ?? option); });
    return button;
  }

  /**
   * What a row says, on two lines: what it is called, and what happens if it
   * is pressed — not a tooltip, because nothing a pointer has to hover to find
   * is read by someone deciding whether it is safe to press.
   * @param {string} text - What it is called.
   * @param {string} [note] - What happens if it is pressed.
   * @param {string} [icon] - The class of the app's icon for what it does.
   * @returns {DocumentFragment} The two lines.
   * @private
   */
  _actionLabel(text, note = '', icon = '') {
    const fragment = document.createDocumentFragment();
    const name = document.createElement('span');
    name.className = 'workspace-panel-action-name';
    if (icon) {
      const glyph = document.createElement('span');
      glyph.className = icon;
      name.appendChild(glyph);
    }
    name.appendChild(document.createTextNode(text));
    fragment.appendChild(name);
    if (note) {
      const says = document.createElement('span');
      says.className = 'workspace-panel-action-note';
      says.textContent = note;
      fragment.appendChild(says);
    }
    return fragment;
  }

  // ==========================================================================
  // Carrying things out
  // ==========================================================================

  /**
   * Ask for a conversation in this workspace. Asked rather than done: starting
   * one is the tab strip's, and carries the strip's guards.
   * @returns {void}
   * @private
   */
  _create() {
    const workspace = this._workspace;
    if (!workspace) return;
    document.dispatchEvent(new CustomEvent('juggler:new-conversation-in-workspace', {
      detail: { workspaceId: workspace.id }
    }));
  }

  /**
   * Run one action at a time, with every button here standing down while it
   * runs — an ending is several seconds of nothing visible happening, and a
   * second press in that window is a second commit, or a discard arriving on
   * top of one. Nothing here may end as an unhandled rejection: a failure the
   * user is not told about is indistinguishable from a button that does
   * nothing.
   * @param {string} id - What is running.
   * @param {() => Promise<void>} run - The action.
   * @returns {Promise<void>} When it is over.
   * @private
   */
  async _guard(id, run) {
    if (this._running) return;
    this._running = id;
    this._standDown();
    try {
      await run();
    } catch (error) {
      showNotice(errorText(error));
    } finally {
      this._running = '';
      this._standDown();
    }
  }

  /**
   * An ending, chosen from a row or from "Close…".
   * @param {any} option - The ending.
   * @returns {Promise<void>} When it has run, or been called off.
   * @private
   */
  _finish(option) {
    return this._guard(option.id, () => this._carryOut(option));
  }

  /**
   * Reflect the action in flight into the buttons that are on screen now.
   * @returns {void}
   * @private
   */
  _standDown() {
    const buttons = /** @type {HTMLButtonElement[]} */ (Array.from(this.querySelectorAll('button.workspace-panel-runs')));
    for (const button of buttons) button.disabled = this._standsDown(button);
  }

  /**
   * After an action: an ending that took the workspace away takes the
   * selection with it, which _refresh reads off the table; otherwise the tree
   * is read again, since the action changed it.
   * @private
   */
  _settled() {
    this._refresh();
    if (this._workspace) void this.reread();
  }

  /**
   * The ending itself: ask, then do it.
   *
   * What is asked is the whole coordination story: nobody owns a workspace, so
   * a turn in flight here is refused rather than confirmed — removing a tree
   * under a running agent is the one thing here that loses work.
   * @param {any} option - The ending that was chosen.
   * @returns {Promise<void>} When it has run, or been called off.
   * @private
   */
  async _carryOut(option) {
    const workspace = this._workspace;
    const session = this._session;
    if (!workspace || !session) return;

    const conversation = workspaceFinishActor(session, workspace);
    const warning = workspaceFinishWarning(session, workspace, {
      action: option,
      status: this._status
    });
    if (warning.refusal) {
      showNotice(warning.refusal);
      return;
    }

    /** @type {object} */
    let input = {};
    if (option.prompt) {
      // Asked again first: this dialog refuses an ending that needs work when
      // the tree read clean, and lists the files the commit is about to take,
      // and a reading as old as the panel is what the tree used to hold.
      await this.reread();
      const answer = await openWorkspaceFinish(option, {
        status: this._status,
        warning: warning.warning,
        conversation
      });
      if (answer === null) return;
      input = answer;
    } else {
      // The provider's sentence, then what the host has to add about this
      // tree, as separate paragraphs.
      const agreed = await showConfirm(
        [option.description, warning.warning].filter(Boolean).join('\n\n'),
        option.label,
        { confirmText: option.label, danger: option.danger === true });
      if (!agreed) return;
    }

    const result = await finishWorkspace({
      session,
      workspace,
      conversation,
      actionId: option.id,
      input
    });
    if (result?.message) showNotice(result.message);
    this._settled();
  }
}

customElements.define('workspace-panel', WorkspacePanel);
