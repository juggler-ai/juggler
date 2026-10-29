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
 * It is a panel rather than a menu because that is what these are. A path you
 * may want to copy, a branch and a working state you may want to read twice,
 * and a row of endings that each take something away are not things to hold a
 * pointer still over: they want room, and they want to stay put while they are
 * read. The strip's box is left with only the name on it.
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
import { showConfirm, showNotice } from './modal-dialog.js';
import { openWorkspaceFinish } from './workspace-finish-dialog.js';
import { sameTree } from '../services/workspace-rebinding.js';

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

    /** @type {AbortController|null} The status read in flight, if there is one. */
    this._probe = null;

    /** @type {HTMLElement|null} The column's right-edge resize grip. */
    this._resizeHandle = null;

    /** @type {string} The ending being carried out, while one is. */
    this._running = '';
  }

  connectedCallback() {
    // A panel put back in the document already has its session and is not
    // handed it again: take back the feed the disconnect dropped, and redraw,
    // which asks again about a tree whose status read the disconnect abandoned.
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
   * Follow the session's selection and workspace table. A no-op without a
   * session or while already listening.
   * @private
   */
  _listen() {
    const session = this._session;
    if (!session || this._unsubscribe) return;

    this._unsubscribe = session.subscribe((/** @type {{type: string}} */ event) => {
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

    if (!workspace) {
      this._probe?.abort();
      this._probe = null;
      this._status = null;
      this.replaceChildren();
      return;
    }

    if (changed) this._status = null;
    this.render();
    // The row is all this can draw without asking anyone, and it says nothing
    // about the state of the tree. So the first draw is followed by the
    // question. Once, though: the panel redraws on events that say nothing
    // about the workspace, and each of those aborting the last one's probe
    // would leave a panel that never manages to say how the tree is doing.
    if (changed || (!this._status && !this._probe)) void this.refreshStatus();
  }

  /**
   * Ask the workspace's provider how it is doing.
   * @returns {Promise<void>} When there is an answer, or it has been abandoned.
   */
  async refreshStatus() {
    const workspace = this._workspace;
    this._probe?.abort();
    this._probe = null;
    if (!workspace || !this._session) return;

    const controller = new AbortController();
    this._probe = controller;
    const status = await workspaceStatus(this._session, workspace, controller.signal);
    // Both are worth asking: the answer may be to a question about a workspace
    // this panel has since stopped being about.
    if (controller.signal.aborted || this._workspace?.id !== workspace.id) return;
    this._probe = null;
    this._status = status;
    this.render();
  }

  /**
   * What the panel calls the place: the name on its row.
   *
   * The row is the only thing that names a workspace. A status read says how a
   * tree is DOING and has no say in what it is called — it arrives a walk of
   * two trees or a git call after the first draw, so a name taken from there
   * would change under somebody already reading it. What the probe learns about
   * the place appears in the lines below the title, which is where a reader is
   * expecting something to fill in.
   * @returns {string} The name.
   * @private
   */
  _label() {
    return this._workspace?.label || this._workspace?.root || '';
  }

  /**
   * What kind of place it is, in the words of whatever made it.
   *
   * The provider's manifest name, which is a property of the TYPE and so is
   * known from the first draw. A status read describes this instance — which
   * repository the worktree is of, what the copy was taken from — and belongs
   * in the lines a reader expects to be filled in late, not in the head where
   * it would rewrite itself a second after the panel opened.
   * @returns {string} The kind, in the UI language, or '' when its provider is
   *   not loaded.
   * @private
   */
  _kind() {
    const kind = workspaceKind(this._session, this._workspace);
    return kind ? capabilityLabel(kind, this._workspace?.providerId, workspaceProviderRegistry) : '';
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
    body.appendChild(this._where());
    body.appendChild(this._state());
    body.appendChild(this._starting());

    const { options, unavailableReason } = workspaceFinishOptions(this._session, workspace);

    const keeps = unavailableReason ? [] : options.filter(option => option.keepsWorkspace);
    if (keeps.length || unavailableReason) {
      body.appendChild(this._doing(keeps, unavailableReason ?? ''));
    }

    const endings = unavailableReason ? [] : options.filter(option => !option.keepsWorkspace);
    if (endings.length) body.appendChild(this._endings(endings));

    this.replaceChildren(body, this._columnHandle());
  }

  /**
   * The grip that widens the column, made once and put back after each redraw.
   *
   * A column is resized by the handle it hosts on its own right edge, and
   * `setupColumnResize` looks for that child before it wires anything — so it
   * is built first, and only ever wired once.
   *
   * Under `juggler-column-width` at depth 0, the root conversation column's own
   * width, with its own default: the panel stands exactly where a root
   * conversation stands, so it is the same column at the same width, and
   * widening either widens both. A width of its own would be a second answer to
   * a question that already has one.
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
   * The type, what that type is for, and then this one's name.
   *
   * The first two lines are about the KIND of place and say nothing about this
   * instance: "Workspace · Git Worktree", then the provider's own sentence about
   * what a git worktree is. Both are manifest facts, so they are right on the
   * first draw and never change under a reader. The name follows, and from there
   * down the panel is about this workspace alone.
   *
   * A box in the strip is clicked before it is understood, and what it opens is
   * a branch name over a directory path — which is a description of something,
   * if you already know what. So the term the whole feature is named for, and
   * the kind of place within it, are the first thing read.
   * @returns {HTMLElement} The panel's head.
   * @private
   */
  _head() {
    const head = document.createElement('header');
    head.className = 'workspace-panel-head';

    const kind = this._kind();
    const what = document.createElement('div');
    what.className = 'workspace-panel-eyebrow';
    what.textContent = kind ? t('Workspace · {kind}', { kind }) : t('Workspace');
    head.appendChild(what);

    // The kind's own description, which the provider already wrote: "Git
    // Worktree" names the thing, and only the sentence under it says what one
    // of those is.
    const note = workspaceKindNote(this._session, this._workspace);
    if (note) {
      const says = document.createElement('p');
      says.className = 'workspace-panel-kind-note';
      says.textContent = capabilityLabel(note, this._workspace?.providerId, workspaceProviderRegistry);
      head.appendChild(says);
    }

    const title = document.createElement('h2');
    title.className = 'workspace-panel-title';
    title.textContent = this._label();
    head.appendChild(title);
    return head;
  }

  /**
   * The root, written out in full, with the things one does with a path: copy
   * it, show it on disk, put it on the board.
   *
   * No heading over it. A path under the name of the place, with copy and reveal
   * beside it, is a path — a line of prose saying so would be telling a reader
   * what they are already looking at.
   *
   * Whole, because no rule about which part of a path matters survives contact
   * with the paths providers actually make: a scratch copy's root ends in the
   * same `work` directory for every copy ever taken, and the segment saying
   * which copy this is sits above it.
   * @returns {HTMLElement} The path section.
   * @private
   */
  _where() {
    const section = document.createElement('div');
    section.className = 'workspace-panel-section workspace-panel-where';

    const path = this._workspace?.root ?? '';
    const row = document.createElement('div');
    row.className = 'workspace-panel-path-row';

    const box = document.createElement('div');
    box.className = 'workspace-panel-path properties-panel-filepath-box';
    box.textContent = path;
    // The same hook the right-click Open / Reveal / Copy menu reads elsewhere,
    // so the path behaves like a path wherever it is met.
    if (path) box.dataset.filePath = path;
    row.appendChild(box);

    const actions = createFileActions(path, { pin: path, directory: true });
    if (actions) row.appendChild(actions);

    section.appendChild(row);

    // A tree made out of another tree says so. Only when the other one is a
    // workspace too: everything here is made from the project unless it says
    // otherwise, and a line repeating the default on every panel is furniture.
    const base = this._base();
    if (base) {
      const from = document.createElement('p');
      from.className = 'workspace-panel-detail';
      from.textContent = t('Base workspace: {base}', { base });
      section.appendChild(from);
    }
    return section;
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
   * What the provider reports about this workspace, in a section that is there
   * from the first draw.
   *
   * Drawn empty and filled in, rather than appended when the answer arrives.
   * The answer is a round trip away and this section sits ABOVE the buttons, so
   * a section that appeared with it shoved every row of the panel down a second
   * after it opened — which is exactly when a pointer is on its way to one of
   * them. The heading and the room are immediate; only the words are late.
   *
   * It is the one part of the panel that keeps a heading, because the lines in it
   * are the provider's own words — a branch, a count, a divergence — and a run of
   * those under a path is facts with nothing saying what they are facts about.
   *
   * How much room is the sheet's business: the answer is one line or two, and
   * nothing here knows how tall a line is (`.workspace-panel-state-lines`).
   *
   * The problem is kept apart from the detail: a workspace that answered and one
   * nobody could reach must never read alike.
   * @returns {HTMLElement} The state section.
   * @private
   */
  _state() {
    const section = document.createElement('div');
    section.className = 'workspace-panel-section workspace-panel-state';

    const heading = document.createElement('h3');
    heading.className = 'workspace-panel-heading';
    heading.textContent = t('Status');
    section.appendChild(heading);

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
    // of its own. A provider that reports it says what it consists of — "2
    // changed, 1 staged", "3 files changed since the copy was made" — and a
    // sentence under that repeating the yes/no it was derived from is one fact
    // written twice, the second time with less in it. Only a provider that
    // flagged the work without describing it gets a line to say so.
    if (detail) say(`workspace-panel-detail${dirty ? ' workspace-panel-dirty' : ''}`, detail);
    else if (dirty) say('workspace-panel-dirty', t('Uncommitted changes.'));
    if (problem) say('workspace-panel-problem', problem);
    // A provider that answers with no opinion has still answered, and the
    // heading is already on screen by then. Saying so beats a heading over a gap.
    if (!lines.children.length) say('workspace-panel-note', t('Nothing to report.'));
    return section;
  }

  /**
   * The button that starts work here.
   *
   * No list of who is working here already. The tab strip is drawing exactly
   * that, a box away, in the boxes this panel was opened from — a second copy
   * of it under a heading is a list you have to check against the one you can
   * already see.
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
    // "Here" rather than the place's name, which the head above has already
    // said. What the description says turns on the one thing a reader needs to
    // know before pressing: where the new conversation's files and commands will
    // be. A group is rooted at the project, and telling somebody starting one
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
   * What the provider offers that leaves the workspace in use — committing,
   * landing work — and the reason there is nothing on offer at all.
   *
   * No heading. Each of these says what it is and what it will do, on the button
   * itself, which is where somebody deciding whether to press it is looking; a
   * word over the top of them adds a line to read and nothing to know.
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

    // A provider that is not loaded has nothing to offer, and the reason is
    // said rather than left as a gap: "this provider offers no endings" and
    // "the extension that knew how to end this is gone" are different things to
    // be told. Not repeated when the state section has already said it.
    if (unavailableReason && unavailableReason !== this._status?.problem) {
      const note = document.createElement('p');
      note.className = 'workspace-panel-note';
      note.textContent = unavailableReason;
      section.appendChild(note);
    }
    return section;
  }

  /**
   * The ways of finishing with the place.
   *
   * Nothing rules them off. Each of these carries the trashcan and says outright
   * that it closes the workspace and what becomes of what is on disk, which is
   * the whole of what a line between them was there to hint at.
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
   * One thing a provider can do with this workspace, as a button.
   *
   * The ellipsis is the promise the rest of the app makes: a label that ends in
   * one asks for something before it does anything. An ending that only wants
   * agreeing to does not get one — a confirmation is not a question.
   *
   * An option that does not keep the workspace wears the trashcan, which is what
   * this app puts on everything that takes something away. Read down a column of
   * rows that all look alike, it is what separates the two that end the place
   * from the ones that carry on working in it.
   * @param {any} option - What the provider offered.
   * @returns {HTMLElement} The button.
   * @private
   */
  _finishButton(option) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `workspace-panel-action${option.danger ? ' danger' : ''}`;
    button.dataset.action = option.id;
    // A redraw in the middle of an ending must not hand back a pressable row:
    // the panel asks the tree how it is doing before a dialog opens, and that
    // answer arrives while the ending it belongs to is still running.
    button.disabled = this._running !== '';
    button.appendChild(this._actionLabel(
      option.prompt ? `${option.label}…` : option.label,
      option.description,
      option.keepsWorkspace ? '' : 'icon-trashcan'));
    button.addEventListener('click', () => { void this._finish(option); });
    return button;
  }

  /**
   * What a button says, on two lines.
   *
   * The second is not decoration and is not a tooltip. Most of these end a
   * place work is happening in, and a label alone cannot carry that: a label
   * has room for the one fact that separates it from the button beside it, and
   * none for where the conversations go or what a deletion takes with it.
   * Nothing a pointer has to hover to find is going to be read by someone
   * deciding whether it is safe to press.
   * @param {string} text - What it is called.
   * @param {string} [note] - What happens if it is pressed.
   * @param {string} [icon] - The class of the app's icon for what it does, on
   *   the first line before the name.
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

  /**
   * Ask for a conversation in this workspace.
   *
   * Asked rather than done: starting one is the tab strip's, and carries the
   * strip's guards — the double-activation debounce and the conversation cap,
   * which are one set of rules however many places offer the button. Going to
   * the new conversation is what leaves this panel, the strip having one
   * selection.
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
   * Ask, then do it.
   *
   * What is asked is the whole coordination story: nobody owns a workspace, so
   * the confirmation names every conversation working in this one, and a turn
   * in flight is refused rather than confirmed — removing a tree under a
   * running agent is the one thing here that loses work. The refusal is the
   * service's too; this only says it earlier and in a sentence.
   *
   * Which conversation the ending is carried out *for* is
   * {@link workspaceFinishActor}'s answer, and it may be nobody: a workspace
   * with three conversations names none of them, and an empty one has none to
   * name.
   *
   * The rows stand down for as long as one of them is running, which is as long
   * as git takes. It is the guard as well as the signal: an ending is several
   * seconds of nothing visible happening, and a second press in that window used
   * to be a second `git add -A` and a second commit — or, worse, a discard
   * arriving on top of a commit.
   *
   * Held on the panel rather than on the button that was pressed, because the
   * panel redraws while an ending is in flight: it asks the tree how it is doing
   * before the dialog opens, and the button pressed a moment ago is gone by the
   * time the answer comes back.
   * @param {any} option - The ending that was chosen.
   * @returns {Promise<void>} When it has run, or been called off.
   * @private
   */
  async _finish(option) {
    if (this._running) return;
    this._running = option.id;
    this._standDown();
    try {
      await this._carryOut(option);
    } catch (error) {
      // Nothing here is allowed to end as an unhandled rejection: the whole
      // point of this row is that the user learns what happened, and a failure
      // they are not told about is indistinguishable from a button that does
      // nothing.
      showNotice(errorText(error));
    } finally {
      this._running = '';
      this._standDown();
    }
  }

  /**
   * Reflect the ending in flight into the rows that are on screen now.
   * @returns {void}
   * @private
   */
  _standDown() {
    const rows = /** @type {HTMLButtonElement[]} */ (
      Array.from(this.querySelectorAll('.workspace-panel-action[data-action]')));
    for (const row of rows) row.disabled = this._running !== '';
  }

  /**
   * The ending itself: ask, then do it.
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
      // Asked again first. The panel's reading is as old as the panel, and this
      // dialog acts on it twice over: it refuses an ending that needs work when
      // the tree read clean, and it lists the files the commit is about to take.
      // Deciding either from a reading taken when the panel opened is deciding
      // from what the tree used to hold.
      await this.refreshStatus();

      // Its own dialog, because what it asks for has a name and the answer is
      // not always typed: an ending that offers an alternative is two endings,
      // and a generic box with one OK button can only state the one.
      const answer = await openWorkspaceFinish(option, {
        status: this._status,
        warning: warning.warning,
        conversation
      });
      if (answer === null) return;
      input = answer;
    } else {
      // What the ending does, then what the host has to add about this tree,
      // as separate paragraphs: one is the provider's sentence and the other
      // is what this tree holds, and a reader about to press a red button
      // takes them in faster apart than run together.
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
    // An ending that took the workspace away takes the selection with it, and
    // _refresh reads that off the table rather than being told.
    this._refresh();
    if (this._workspace) void this.refreshStatus();
  }
}

customElements.define('workspace-panel', WorkspacePanel);
