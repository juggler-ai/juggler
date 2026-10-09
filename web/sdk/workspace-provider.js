//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { validateManifest } from './lib/manifest.js';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Workspace provider manifest - static metadata describing a provider plugin.
 * Define this as a static MANIFEST property on your provider class.
 * @typedef {object} WorkspaceProviderManifest
 * @property {string} id - Unique provider identifier (kebab-case, e.g. 'git-worktree')
 * @property {string} name - Human-readable display name (e.g. 'Git Worktree')
 * @property {string} version - Semantic version (e.g. '1.0.0')
 * @property {string} description - What kind of place this provider makes
 * @property {string} [setupLabel] - The "New…" row's label in a place list
 *   (e.g. 'New git worktree'). Defaults to the name; see {@link WorkspaceProvider#getSetupLabel}.
 * @property {WorkspaceProviderRecommendations} [recommendations] - When and why to reach for it
 * @property {string} [icon] - CSS class for an icon (e.g. 'icon-git-branch')
 * @property {string} [color] - CSS colour for visual identification
 */

/**
 * When and why to use a provider, for the panel and for the model.
 * @typedef {object} WorkspaceProviderRecommendations
 * @property {string} [bestFor] - The work this place suits
 * @property {string} [avoidFor] - The work it does not
 * @property {string[]} [notes] - Anything a user should know before picking it
 */

/**
 * What a workspace is, minus the parts the server decides. Returned by
 * {@link WorkspaceProvider#provision}; the host assigns the id and the state,
 * and the server records what kind of place it is.
 * @typedef {object} WorkspaceDescriptor
 * @property {string} root - Where it is: an absolute path to the tree
 * @property {string} [label] - What to call it
 * @property {Record<string, any>} [meta] - The provider's own record of what it built
 */

/**
 * @typedef {object} ProvisionResult
 * @property {WorkspaceDescriptor} workspace - The place that now exists
 */

/**
 * The state of a provider's setup section, as its host reads it.
 * @typedef {object} SetupValue
 * @property {boolean} valid - Whether Create may be pressed
 * @property {object} values - What {@link WorkspaceProvider#provision} will be given
 * @property {string} [invalidFieldId] - Which field to focus when it is not valid
 */

/**
 * How a place is doing, as its provider reports it.
 *
 * It does not name the place. The workspace's row does that, and every surface
 * shows that name from the instant it draws; a status is asked for afterwards
 * and can take a walk of two trees or a git call to answer. A name from here
 * would therefore arrive seconds late and change the title under a reader —
 * and it would disagree with the same workspace's name in the strip, the setup
 * list and the move dialog, all of which read the row.
 * What kind of place it is is not here either: that is a property of the
 * provider, not of one workspace, and surfaces say it from the manifest's
 * `name` and `description`, which are known before anything is asked.
 * @typedef {object} WorkspaceStatus
 * @property {string} [detail] - A second line: branch, host, latency, whatever
 *   matters. It describes the PLACE, and a surface may show it wherever it
 *   shows the place — so a provider that cannot answer must leave it alone
 *   rather than explaining itself here. An HTTP status once reached the new
 *   conversation's picker this way, sitting under a workspace's name where its
 *   path belongs.
 * @property {string} [problem] - Why the place could not be asked, when it
 *   could not. Separate from `detail` because "nothing is wrong" and "nobody
 *   could say" are different answers and only one of them describes anywhere.
 *   Set by the host when `status()` throws; a provider may set it to report a
 *   failure it caught itself.
 * @property {string} [badge] - A very short state word ('idle', 'dirty', 'unreachable')
 * @property {boolean} [dirty] - Whether it holds uncommitted work of the user's
 * @property {boolean} [available] - Whether it can be reached at all right now
 * @property {WorkspaceFile[]} [files] - That work, file by file, as far as it
 *   could be listed. What `dirty` reports as a yes or no, an ending is about to
 *   act on in bulk: a commit takes the whole tree, and a count is not something
 *   a reader can consent to. Costs nothing where the status read already had the
 *   list in its hands; leave it alone where it would be a second round trip
 * @property {number} [fileCount] - How many there really are, when `files` is
 *   only the first of them. A list that quietly stopped reads as the whole of
 *   what is about to happen, which is the one way this can mislead
 */

/**
 * One file of uncommitted work.
 * @typedef {object} WorkspaceFile
 * @property {string} path - Relative to the workspace root, which is how git
 *   names it and how an operation takes it
 * @property {string} [state] - What is happening to it, in a word the reader
 *   does not have to already know: 'Modified', 'Untracked', 'Deleted'
 */

/**
 * The uncommitted work a workspace is holding, file by file, as its provider
 * accounts for it. Returned by {@link WorkspaceProvider#heldWork}.
 *
 * Paths are relative to the workspace's own root, which is the form an operation
 * takes them in and the form git names them in, so a list from either side goes
 * to the same place.
 * @typedef {object} HeldWork
 * @property {boolean} complete - Whether this is all of it. A short list is a
 *   wrong answer rather than a small one: work copied from a list that quietly
 *   stopped would leave the rest behind and report that it had brought everything.
 * @property {string[]} paths - What is there to take, changed or added
 * @property {string[]} removed - What this work does by being gone
 */

/**
 * @typedef {object} FinishOption
 * @property {string} id - Passed back to {@link WorkspaceProvider#finish}
 * @property {string} label - What the menu says. An ending declaring a `prompt`
 *   is shown with an ellipsis after it, which the host adds — do not write one
 * @property {boolean} [danger] - Whether it destroys something. A destructive
 *   ending is coloured, and ruled off from the endings above it
 * @property {boolean} [keepsWorkspace] - Whether the workspace is still in use
 *   afterwards. The default is false: these are endings, and the host groups them
 *   under a heading that says so. An action that merely does something useful to
 *   the place and leaves it in use — committing, pushing, reinstalling — sets
 *   this, and is shown apart from the endings. Such an action must return
 *   `done: false`, which is what actually keeps the workspace open; this only
 *   says where the row belongs
 * @property {string} [description] - What it will do, in a sentence. Read twice:
 *   under the label in the menu, and again in the dialog where the decision is
 *   actually made. Write it to stand on its own in both
 * @property {FinishPrompt} [prompt] - Ask for something to be typed before doing
 *   it; it arrives as `ctx.input.message`. An ending with none is confirmed instead.
 */

/**
 * What an ending needs typed into it before it can run — a commit message, a
 * name, a reason.
 *
 * The ending declares this rather than the host recognising the ending: the host
 * knowing that an action called `commit` wants a message is a promise it can
 * only keep for whichever provider was written first.
 *
 * An empty field must not mean something other than a full one. Where answering
 * nothing is a real choice rather than an omission, declare that choice as an
 * {@link FinishAlternative} button naming its outcome: one field standing for two
 * unrelated endings is a decision the reader is left to infer from a blank box.
 * @typedef {object} FinishPrompt
 * @property {string} [label] - The field's caption, e.g. `Message`. A field with
 *   none is captioned by the ending's own label, which names the act rather than
 *   the thing being typed
 * @property {string} [placeholder] - What the empty field shows, e.g. an example
 * @property {string} [confirmLabel] - What the button that does it says, when the
 *   ending's own label is too long to sit in a row of buttons: `Commit the
 *   changes` names the row in a menu, and `Commit` is what the button beside
 *   `Cancel` wants. The ending's label is used when there is none
 * @property {string} [hint] - A line under the field: what belongs there, or what
 *   it is for. Under the field, where it is read while typing
 * @property {string} [value] - What to put in the field to begin with
 * @property {boolean} [multiline] - Whether it takes more than one line. A
 *   multi-line field commits on ⌘/Ctrl+Enter, leaving Enter to do what it does
 *   everywhere else
 * @property {boolean} [requiresWork] - Whether the ending is pointless unless the
 *   workspace holds changes. The ending declares it; the host does not read it off
 *   the status and guess, because "nothing has changed" stops a commit and means
 *   nothing whatever to an ending that asks for a name
 * @property {FinishAlternative} [alternative] - A second way to answer, as its own
 *   button. It runs the ending with an empty `ctx.input.message`
 */

/**
 * The other answer: a button beside the primary one, for the ending that takes
 * nothing typed.
 * It is offered only when the ending is being carried out **for a conversation**
 * — `ctx.conversation` — because handing the work to one is what an alternative
 * is for. An ending asked for of the workspace itself, from a box several
 * conversations share, names none of them and shows the field alone.
 * @typedef {object} FinishAlternative
 * @property {string} label - What the button says, in full, e.g. `Let this conversation write it`
 * @property {string} [hint] - What choosing it does, read under the buttons
 */

/**
 * @typedef {object} FinishResult
 * @property {boolean} done - Whether the workspace is finished with
 * @property {string} [message] - What to tell the user, done or not
 * @property {'bin'|'return'} [conversations] - What becomes of the conversations
 *   working here, once `done`. The default, `'bin'`, sends them to the bin with
 *   the tree they were working in. `'return'` moves them back to the workspace
 *   this one was made from — for an ending that leaves nothing behind that
 *   they were about, such as ungrouping a group. The host carries it out and
 *   says so; the provider's `message` is about its own half
 */

/**
 * What a provider can find, set against what the session thinks it has.
 * @typedef {object} ReconcileResult
 * @property {import('../js/model/session.js').Workspace[]} [orphanedWorkspaces] - Rows whose artifact is gone
 * @property {object[]} [orphanedArtifacts] - Artifacts with no row, each `{ id?, label, detail? }`
 * @property {string[]} [confirmed] - Ids the provider found and vouches for
 */

/**
 * @typedef {object} CleanupResult
 * @property {boolean} removed - Whether there is nothing of this provision left
 * @property {string} [message] - What was removed, or why it could not be
 */

/**
 * The compensation stack. The host owns it, runs it in reverse, and renders each
 * entry as it goes.
 * @typedef {object} RollbackStack
 * @property {(compensation: () => Promise<void>|void) => void} push - Record how to undo the step just taken
 */

/**
 * What a lifecycle hook is given.
 *
 * `ops` is the one way a provider touches anything: it is pinned to the **base**
 * workspace during {@link WorkspaceProvider#provision}, and to the workspace
 * itself everywhere else. That is what makes "a worktree on a remote machine"
 * need no ssh-awareness in a worktree provider — the transport is the facade's
 * business, not the provider's.
 * @typedef {object} ProviderContext
 * @property {any} session - The session, for reading the project path and the table
 * @property {any} [conversation] - The conversation this is being done for, where there is one
 * @property {import('./ops.js').BoundOps} ops - Operations, already rooted (see above)
 * @property {import('./ops.js').BoundOps} [baseOps] - Operations pinned to the
 *   workspace this one was made from, where the host knows which that is. `ops`
 *   says where the workspace IS and this says where it CAME FROM, which are the
 *   same place only during {@link WorkspaceProvider#provision}. It is what an
 *   ending that *lands* work writes through, and what reaches a provider's own
 *   artifacts when they live beside the base rather than beside the project.
 * @property {string} [baseWorkspaceId] - The workspace being provisioned relative to; '' is the project
 * @property {object} [values] - {@link WorkspaceProvider#renderSetup} only: what the
 *   section last reported. A form is rebuilt whenever the panel's shape moves — a
 *   cancelled provision, a failure — and a provider that fills its fields back in
 *   from this costs a corrected typo one edit instead of a re-fill.
 * @property {object} [input] - {@link WorkspaceProvider#finish} only: whatever the
 *   host collected for this action — a commit message, an answered question. The
 *   provider declares nothing about it and the host asks for what the action it
 *   offered needs, which is what keeps `finish` headless and testable.
 * @property {AbortSignal} signal - Pass it to every op, in compensations too.
 *   While provisioning it is the signal a cancel aborts; once the host has begun
 *   unwinding it is a fresh one, so a compensation written the obvious way is
 *   not refused by the very abort that called for it.
 * @property {RollbackStack} rollback - Push an inverse after each irreversible step
 * @property {(metaPatch: Record<string, any>) => Promise<void>} checkpoint - Persist what has been built so far
 * @property {(step: string, detail?: string) => void} progress - One line per step, emitted BEFORE the slow part
 */

// ============================================================================
// WorkspaceProvider Base Class
// ============================================================================

/**
 * WorkspaceProvider - Base class for Juggler workspace provider plugins
 *
 * A **workspace** is the environment a conversation's tools run in: somewhere to
 * run commands and read and write files, plus the identity it is shown under.
 * Every project has one already — itself. A provider is what makes the others: a
 * git worktree, a throwaway copy of the tree, a folder inside the project.
 *
 * ## What a provider is not on the path of
 *
 * A workspace's `kind` and `root` live on the session's own row, not here. So a
 * provider that is disabled, uninstalled, or broken at startup **cannot strand a
 * conversation**: operations keep resolving and bound conversations keep
 * working. Only what the provider itself supplies degrades — status becomes a
 * flat "provider unavailable", finish actions are disabled with that reason, and
 * reconcile does not run for its rows, which are left strictly alone because
 * nothing present understands them.
 *
 * ## Setup, then provisioning
 *
 * The two are deliberately separate. {@link renderSetup} draws the fields and
 * {@link getSetupValue} reports what they say; {@link provision} then runs
 * **headless**, from those values alone. A provision that gathered its own input
 * through a dialog would drag UI puppetry into every test of a lifecycle that is
 * otherwise a sequence of commands.
 *
 * ## Cancelling and undoing are the same mechanism
 *
 * `provision()` gets an `AbortSignal` and must thread it into every operation.
 * **Before** each irreversible step it records how to undo it, twice: durably
 * with `ctx.checkpoint({…})`, and in memory with `ctx.rollback.push(…)`. Cancel,
 * failure part-way through, and Undo after success all run that stack in
 * reverse.
 *
 * Recording the inverse *before* the step rather than after is the ordering that
 * has no gap in it. An abort can land between a step and the line after it, and
 * a compensation pushed on that line is never pushed at all — so the one thing
 * the host cannot undo is the step it was interrupted immediately after, which
 * is the likeliest step of all. Declaring intent first closes that window.
 *
 * The price is that a compensation routinely runs for a step that never
 * happened, so compensations **must be idempotent and must tolerate absence**:
 * `rm -f`, not `rm`. That is true regardless — an abort races the step it is
 * cancelling, so the thing being undone may be missing, half-made or complete.
 *
 * Closures die with the tab, so they cannot be the whole story. Before each
 * irreversible step a provider also calls `ctx.checkpoint({…})` to record what
 * it is about to do; {@link cleanupPartial} is then able to undo a provision
 * that died with the process it was running in, from that record alone. A
 * provider whose two paths disagree is a bug, and the fixture tests exist to
 * find it.
 *
 * ## Quick Start
 *
 * ```javascript
 * import WorkspaceProvider from 'juggler/workspace-provider';
 *
 * class ScratchCopyProvider extends WorkspaceProvider {
 *   static MANIFEST = {
 *     id: 'scratch-copy',
 *     name: 'Scratch Copy',
 *     version: '1.0.0',
 *     description: 'A throwaway copy of the project to try something risky in',
 *     setupLabel: 'New scratch copy'
 *   };
 *
 *   async provision(values, ctx) {
 *     const root = `${ctx.session.projectPath}/.juggler/sandboxes/${values.name}`;
 *     ctx.progress('Copying the project', root);
 *     await ctx.checkpoint({ root });
 *     ctx.rollback.push(async () => {
 *       await ctx.ops.shell({ command: `rm -rf ${root}` }, ctx.signal);
 *     });
 *     await ctx.ops.shell({ command: `cp -R . ${root}` }, ctx.signal);
 *     return { workspace: { root, label: values.name } };
 *   }
 * }
 *
 * export default ScratchCopyProvider;
 * ```
 * @class
 * @abstract
 */
class WorkspaceProvider {
  /**
   * Workspace provider manifest (static property set by subclasses)
   * @type {WorkspaceProviderManifest}
   * @static
   */
  static MANIFEST;

  /**
   * Create a provider instance.
   *
   * An instance is short-lived and belongs to one job: a setup section the user
   * is filling in, or a single provision. The things a hook needs arrive in that
   * hook's `ctx` rather than being captured here, because a provider outlives
   * neither a rebind nor a project switch.
   * @param {{session?: any}} [context] - What little is known before any hook runs
   */
  constructor(context = {}) {
    if (new.target === WorkspaceProvider) {
      throw new Error('WorkspaceProvider is an abstract class and cannot be instantiated directly');
    }

    /** @type {any} */
    this.session = context.session;

    validateManifest(this.constructor);
  }

  // ==========================================================================
  // Setup
  // ==========================================================================

  /**
   * Render this provider's options into the host's container.
   *
   * The default renders nothing, which is a legitimate provider: one whose
   * every choice has an obvious default needs no form, and gets a bare
   * Create button.
   * @param {HTMLElement} container - The panel section's body, to fill
   * @param {ProviderContext} ctx - Session, operations, and the rest
   * @returns {void|Promise<void>} When it is rendered
   */
  renderSetup(container, ctx) {
    void container;
    void ctx;
  }

  /**
   * What the rendered section currently says, and whether it may be submitted.
   * @returns {SetupValue} Validity and values
   */
  getSetupValue() {
    return { valid: true, values: {} };
  }

  /**
   * What the "New…" row is called. The manifest's `setupLabel`, or the
   * provider's name when it has none — an author who left it out still gets a
   * row a user can read.
   * @returns {string} The row label
   */
  getSetupLabel() {
    const manifest = this.getManifest();
    return manifest.setupLabel || manifest.name;
  }

  /**
   * Where this provision intends to end up, before it has built anything.
   *
   * The host must register the workspace **before** running a single command,
   * so that a provision interrupted half way leaves a row describing what was
   * started — and a row is required to have a root. So the host has to be told
   * the destination up front, and a provider whose setup form collects a
   * location (a worktree's placement, a sandbox's directory) already knows it.
   *
   * Answering `''` is fine: the host then registers the row at the base
   * workspace's root, which is harmless because a `provisioning` row refuses
   * every operation anyway, and `cleanupPartial` undoes a dead provision from
   * `meta` rather than from `root`. What it costs is a table that, briefly,
   * describes the destination a little less accurately than it could.
   * @param {object} values - From {@link getSetupValue}, or supplied literally
   * @returns {string} The intended root, or '' when it is not yet known
   */
  plannedRoot(values) {
    return /** @type {any} */ (values)?.root ?? '';
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Build the place, from values already collected.
   *
   * Runs headless. Every operation goes through `ctx.ops` (pinned to the base
   * workspace) and carries `ctx.signal`; every irreversible step is preceded by
   * a `ctx.checkpoint` and followed by a `ctx.rollback.push`; every slow step is
   * announced through `ctx.progress` **before** it starts, so the panel names
   * what it is waiting on rather than what it has just finished.
   * @abstract
   * @param {object} values - From {@link getSetupValue}, or supplied literally
   * @param {ProviderContext} ctx - Operations, signal, rollback, checkpoint, progress
   * @returns {Promise<ProvisionResult>} The workspace, and anything to seed the conversation with
   * @throws {Error} If not implemented
   */
  async provision(values, ctx) {
    void values;
    void ctx;
    throw new Error('provision() must be implemented by subclass');
  }

  /**
   * How a workspace is doing — bound to a conversation or not.
   *
   * **Must be cheap and must honour `ctx.signal`**: a place list calls this
   * speculatively for every workspace it lists the moment it opens, not just for
   * the one in use. The default answers from the row alone, without touching
   * anything.
   * @param {import('../js/model/session.js').Workspace} workspace - The row to report on
   * @param {ProviderContext} ctx - Operations pinned to that workspace, and a signal
   * @returns {Promise<WorkspaceStatus>} What to show for it
   */
  async status(workspace, ctx) {
    void ctx;
    return { available: workspace.available !== false };
  }

  /**
   * Every file of uncommitted work this workspace holds, for a move that offers
   * to bring it along.
   *
   * {@link status} says whether there is work here; this says what it is. They
   * are separate because the first is asked of every row the moment a panel
   * opens and the second only when somebody is about to copy something, and a
   * provider whose enumeration is expensive should be free to make that
   * distinction.
   *
   * The default answers `null`, which means no opinion: the host then asks git,
   * which is what it did before any provider had a view. That is the
   * conservative answer and not the same as an empty list — a provider that
   * cannot enumerate must not be the reason a tree reads as clean.
   *
   * The same distinction one level in: `{complete: false}` says this workspace
   * holds work it could not list. The host is required to treat that as a reason
   * to carry nothing, never as nothing to carry.
   * @param {import('../js/model/session.js').Workspace} workspace - The row to account for
   * @param {ProviderContext} ctx - Operations pinned to that workspace, its base's, and a signal
   * @returns {Promise<HeldWork|null>} What it holds, or null to leave it to git
   */
  async heldWork(workspace, ctx) {
    void workspace;
    void ctx;
    return null;
  }

  /**
   * Other directories whose instruction files apply to work done here.
   *
   * A workspace root is not always the only place a conversation's AGENTS.md
   * lives. A worktree of a subrepo, and a folder inside the project, both sit
   * under instructions written above them, and seeding only the root leaves the
   * house rules unread. The host cannot work out which other place counts —
   * walking up from a worktree reaches the user's home directory, not the
   * project. The provider knows, because it knows what this workspace was made
   * from.
   *
   * It names DIRECTORIES only. Which filenames count, the content-hash dedup
   * and the skip for what the user pinned themselves all stay with the host, so
   * a provider never has to keep up with that list.
   *
   * Ordered widest first: each is seeded ahead of the workspace's own files, so
   * what a tree says for itself is the last word the model reads.
   *
   * The default is none, which is the right answer for a workspace that is a
   * tree in its own right.
   * @param {import('../js/model/session.js').Workspace} workspace - The row about to be seeded for
   * @param {ProviderContext} ctx - Operations pinned to that workspace, its base's, and a signal
   * @returns {string[]} Absolute directories, widest first
   */
  instructionRoots(workspace, ctx) {
    void workspace;
    void ctx;
    return [];
  }

  /**
   * The ways this workspace can be finished with, in the order to offer them.
   *
   * The default is none, and the panel renders that honestly — a provider whose
   * workspaces are simply unbound and forgotten has nothing to put here.
   * @param {import('../js/model/session.js').Workspace} workspace - The row being finished with
   * @returns {FinishOption[]} Ordered actions
   */
  finishOptions(workspace) {
    void workspace;
    return [];
  }

  /**
   * Carry out one finish action, then tear down.
   * @param {import('../js/model/session.js').Workspace} workspace - The row being finished with
   * @param {string} actionId - Which of {@link finishOptions}
   * @param {ProviderContext} ctx - Operations pinned to that workspace, and a signal
   * @returns {Promise<FinishResult>} Whether it is finished, and what to say
   */
  async finish(workspace, actionId, ctx) {
    void workspace;
    void ctx;
    return { done: false, message: `${this.getManifest().name} has no action "${actionId}".` };
  }

  /**
   * Compare the session's rows against what actually exists, and report both
   * kinds of orphan. The host renders the offer; this only looks.
   *
   * What it enumerates is also what a lost table is recovered from, though not
   * by this hook: a binding is an opaque id and nothing on disk says which place
   * it meant, so the artifacts reported here are offered to the user, who names
   * the one their stranded conversations were working in. It is registered again
   * under that id, and turns up in `workspaces` on the next pass like any other
   * row. Runs under a single-runner claim, so it happens once per session
   * however many windows are open.
   *
   * The default confirms nothing and orphans nothing, which is the conservative
   * answer: a provider that cannot enumerate its artifacts must not be the
   * reason a user is offered a cleanup.
   * @param {import('../js/model/session.js').Workspace[]} workspaces - This provider's rows
   * @param {ProviderContext} ctx - Operations rooted at the project, and a signal
   * @returns {Promise<ReconcileResult>} What matches and what does not
   */
  async reconcile(workspaces, ctx) {
    void workspaces;
    void ctx;
    return { orphanedWorkspaces: [], orphanedArtifacts: [], confirmed: [] };
  }

  /**
   * Undo a provision that died with its process — the durable twin of
   * `ctx.rollback`.
   *
   * Called for every row still marked `provisioning` when a session loads, which
   * is every one of them that was interrupted: provisioning is browser-driven,
   * so no provisioner survives a restart and such a row is stale by definition.
   *
   * It must work from `workspace.meta` alone, since no closure outlived the tab,
   * and it must tolerate that record describing a step which never actually
   * landed — a checkpoint is written *before* the thing it describes.
   * @param {import('../js/model/session.js').Workspace} workspace - The half-built row
   * @param {ProviderContext} ctx - Operations rooted at the project, and a signal
   * @returns {Promise<CleanupResult>} Whether anything is left
   */
  async cleanupPartial(workspace, ctx) {
    void workspace;
    void ctx;
    return {
      removed: false,
      message: `${this.getManifest().name} cannot clean up an interrupted provision.`
    };
  }

  /**
   * Get provider manifest
   * @returns {WorkspaceProviderManifest} Provider manifest
   */
  getManifest() {
    const ctor = /** @type {typeof WorkspaceProvider} */ (this.constructor);
    return ctor.MANIFEST;
  }
}

export default WorkspaceProvider;
