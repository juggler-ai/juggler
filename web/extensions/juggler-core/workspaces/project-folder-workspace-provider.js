//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * A workspace that is a folder of the project already on disk: the package, the
 * service, the subrepo a conversation is actually about.
 *
 * ## Nothing is built, and that is the whole provider
 *
 * The other two providers make a place and can take it away again. This one
 * names a place that was already there, so `provision` runs no command, pushes
 * no compensation, and writes no checkpoint, and there are no endings to offer:
 * a folder cannot be finished with, only worked in or left. A conversation
 * leaves it by being moved, exactly as it moves anywhere else.
 *
 * ## Focus, not isolation — and the difference is not decoration
 *
 * A workspace confines where commands RUN: the shell's cwd is the workspace
 * root and nothing widens it (`ops.validateCwd` on the server consults the root
 * alone). Reads are deliberately not confined that way — every workspace's read
 * scope is widened by the project — so a conversation in `packages/ui` can still
 * read the monorepo around it, which is the point rather than a leak. What it
 * buys is that the agent's commands, its environment block, its `query_code`
 * sandbox and its git surfaces are all the folder's rather than the whole
 * project's.
 *
 * Anyone reaching for this expecting a sandbox wants the scratch copy instead,
 * and the recommendations say so in those words.
 * @module workspaces/project-folder-workspace-provider
 */

import WorkspaceProvider from 'juggler/workspace-provider';
import { extractErrorMessage } from 'juggler/ui';
import { baseName, join, relativePath } from '../lib/workspace-paths.js';
import { nextFormSequence, pathField, showNote } from '../lib/setup-fields.js';

/**
 * How long after the last keystroke the folder is looked for. The same pause the
 * worktree provider leaves before asking git about a branch name: long enough
 * that a path being typed is not one round trip per character, short enough that
 * the verdict arrives while the user is still looking at the field.
 * @type {number}
 */
const FOLDER_CHECK_DELAY_MS = 200;

/**
 * A folder of the project, as the place a conversation works.
 */
class ProjectFolderWorkspaceProvider extends WorkspaceProvider {
  /**
   * @param {{session?: any}} [context] - What is known before any hook runs.
   */
  constructor(context = {}) {
    super(context);

    /** @type {any} The rendered form, while there is one. */
    this._form = null;
  }

  static MANIFEST = {
    id: 'project-folder',
    name: 'Subfolder',
    version: '1.0.0',
    description: 'Conversations here work in a subfolder instead of the project root',
    setupLabel: 'A subfolder of this project',
    recommendations: {
      bestFor: 'one package, service or subrepo of a large project',
      avoidFor: 'anything that needs the project left untouched — a copy does that',
      notes: [
        'Commands run in the folder. The rest of the project stays readable, which is what makes a monorepo usable from here.',
        'Nothing is created and nothing is removed: the folder is yours, before and after.'
      ]
    }
  };

  /**
   * One field: which folder.
   *
   * It completes as it is typed, against the project and directories only, so
   * the common case is three keystrokes and a click rather than a path typed
   * from memory. What is typed is project-relative, which is also how the row is
   * labelled and how the note reads it back — a form that takes a relative path
   * and then reports an absolute one makes the user check whether they are the
   * same place.
   * @param {HTMLElement} container - The panel section's body.
   * @param {any} ctx - Session, operations, and what the section last reported.
   */
  renderSetup(container, ctx) {
    const id = `project-folder-${nextFormSequence()}`;
    container.replaceChildren();
    const { input, note } = pathField(
      container, id, 'folder', 'Folder', 'packages/ui',
      { dirsOnly: true, projectRelative: true });

    // What the section last reported, when there is any: a provision that was
    // cancelled or failed puts the form back, and retyping a path is a poor
    // reward for changing your mind.
    input.value = String(ctx?.values?.folder ?? '');

    const form = { ctx, container, id, input, note, checking: null, verdict: '' };
    this._form = form;
    input.addEventListener('input', () => { this._scheduleCheck(); });
    this._scheduleCheck();
  }

  /**
   * Look for the folder once typing has stopped.
   *
   * The verdict is remembered rather than re-derived, because `getSetupValue` is
   * asked on every edit and a form that answered by going to disk would put a
   * round trip between a keystroke and the Create button.
   * @private
   */
  _scheduleCheck() {
    const form = this._form;
    if (!form) return;
    form.verdict = '';
    if (form.checking) clearTimeout(form.checking);
    form.checking = setTimeout(() => { this._check(); }, FOLDER_CHECK_DELAY_MS);
    this._report();
  }

  /**
   * Say whether there is a folder there, under the field.
   * @private
   */
  async _check() {
    const form = this._form;
    if (!form) return;
    const typed = String(form.input?.value ?? '').trim();
    if (!typed) {
      showNote(form.note, '');
      return;
    }

    let places;
    try {
      places = this._places({ folder: typed }, form.ctx);
    } catch (error) {
      form.verdict = extractErrorMessage(error);
      showNote(form.note, form.verdict, { error: true });
      this._report();
      return;
    }

    // Absolute, because the operations here are rooted at whatever workspace the
    // form was opened from — the project in the create dialog, but the
    // conversation's own tree in the move dialog — while the folder is always
    // the project's. An operation is the one thing that may be handed an
    // absolute path: it validates it, where a shell would have to spell it.
    const found = await form.ctx.ops.stat({ path: places.dir });
    if (this._form !== form || String(form.input?.value ?? '').trim() !== typed) return;

    if (!found?.exists) {
      form.verdict = 'There is no such folder.';
    } else if (!found.isDirectory) {
      form.verdict = 'That is a file, not a folder.';
    } else {
      form.verdict = '';
    }

    showNote(
      form.note,
      form.verdict || 'Commands run here. The rest of the project stays readable.',
      { error: Boolean(form.verdict), path: form.verdict ? '' : places.dir });
    this._report();
  }

  /**
   * Tell the host the form has changed when nothing the user did changed it —
   * the verdict arriving is what turns Create on or off, and the panel only
   * listens to the events a field would raise for itself.
   * @private
   */
  _report() {
    this._form?.container?.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * What the form currently says, and whether Create may be pressed.
   * @returns {any} Validity, values, and which field to go back to.
   */
  getSetupValue() {
    const form = this._form;
    if (!form) return { valid: false, values: {}, invalidFieldId: '' };

    const folder = String(form.input?.value ?? '').trim();
    let location = '';
    try {
      location = folder ? this._places({ folder }, form.ctx).dir : '';
    } catch {
      location = '';
    }
    // Reported so the host can register the row at the folder itself rather than
    // at the base workspace; `plannedRoot` reads it back.
    const values = { folder, location };
    return folder && location && !form.verdict
      ? { valid: true, values }
      : { valid: false, values, invalidFieldId: form.id };
  }

  /**
   * Where this workspace is, which is where it already was.
   * @param {any} values - What the setup form collected.
   * @returns {string} The folder, or '' when nothing named one.
   */
  plannedRoot(values) {
    return values?.location ?? '';
  }

  /**
   * The project, the folder relative to it, and the folder itself.
   *
   * Measured from the project rather than from the base workspace, because this
   * provider is about the project whichever tree the form was opened from. The
   * relative path is taken back off the resolved location rather than trusted as
   * typed: `join` resolves `..` segments, so this is what catches a path that
   * climbs out of the project by way of something that looks like it does not.
   * @param {any} values - What the setup form collected; only `folder` is read.
   * @param {any} ctx - The hook's context, for the session.
   * @returns {{project: string, rel: string, dir: string}} The project and the folder.
   * @throws {Error} When there is no project, or the folder is not one of its own.
   */
  _places(values, ctx) {
    const project = String(ctx?.session?.projectPath ?? '');
    if (!project) throw new Error("Couldn't use that folder: the session has no project.");

    const typed = String(values?.folder ?? '').trim().replace(/[/\\]+$/, '');
    if (!typed) throw new Error("Couldn't use that folder: none was named.");

    const dir = join(project, typed);
    const rel = relativePath(project, dir);
    if (rel === null) throw new Error('That is not on the same drive as the project.');
    if (rel === '.') {
      throw new Error('That is the project itself, which the panel offers above.');
    }
    if (rel.startsWith('..')) throw new Error('That is outside the project.');
    return { project, rel, dir };
  }

  /**
   * Bind to the folder. There is nothing to build.
   *
   * No checkpoint and no compensation, because nothing here is irreversible:
   * what the host registered is a row, and undoing this provision is the host
   * unregistering it. It still checks that the folder is there, for the caller
   * that never went near the form — the row would otherwise go `ready` at a path
   * that every operation is about to refuse, which is a worse way to find out.
   * @param {any} values - folder.
   * @param {any} ctx - Operations pinned to the base workspace, and the rest.
   * @returns {Promise<any>} The workspace, which was there all along.
   */
  async provision(values, ctx) {
    const { rel, dir } = this._places(values, ctx);

    const found = await ctx.ops.stat({ path: dir });
    if (!found?.exists) throw new Error(`Couldn't use ${dir}: there is no such folder.`);
    if (!found.isDirectory) throw new Error(`Couldn't use ${dir}: that is a file, not a folder.`);

    return { workspace: { root: dir, label: rel, meta: { folder: rel } } };
  }

  /**
   * What it is, and whether it is still there.
   *
   * Nothing further is worth a round trip, and nothing further is worth a line:
   * a folder has no branch, no drift and no unapplied change of its own — what
   * git has to say about it is the project's own status, which the user can
   * already see. The place is named by its `kind` and addressed by the path every
   * surface shows beside it, so a status line here could only spell that path a
   * second time, under the first.
   * @param {any} workspace - The row to report on.
   * @param {any} ctx - Operations pinned to it, and a signal.
   * @returns {Promise<any>} What to show for it.
   */
  async status(workspace, ctx) {
    void ctx;
    const project = String(this.session?.projectPath ?? '');
    const kind = project ? `Folder of ${baseName(project)}` : 'Folder of the project';
    if (workspace.available === false) {
      return { kind, detail: 'The folder is missing.', available: false };
    }
    return { kind, available: true };
  }

  /**
   * The project, which is where the instructions for a folder of it live.
   *
   * A package of a monorepo may have an AGENTS.md of its own — that one is the
   * workspace root's, and the host finds it without being told — but the
   * project's is the one it would otherwise lose, and it is the one that says
   * how anything here is meant to be built and tested.
   * @param {any} workspace - The row about to be seeded for.
   * @param {any} ctx - The hook's context, for the session.
   * @returns {string[]} The project, or nothing.
   */
  instructionRoots(workspace, ctx) {
    const project = String(ctx?.session?.projectPath ?? '');
    if (!project) return [];
    const rel = relativePath(project, String(workspace?.root ?? ''));
    // A row somehow rooted at the project itself has nothing above it, and
    // seeding the same files twice is worse than not seeding them at all.
    return rel === null || rel === '.' ? [] : [project];
  }

  /**
   * Nothing, deliberately.
   *
   * Every ending the other providers offer disposes of something they made.
   * Nothing was made here: the folder is the user's, it was there first, and it
   * stays. A conversation that is done with it moves somewhere else, which is
   * the picker's job rather than an ending's.
   * @param {any} workspace - The row being finished with.
   * @returns {any[]} None.
   */
  finishOptions(workspace) {
    void workspace;
    return [];
  }

  /**
   * A row of this provider's that a restart caught mid-provision has nothing
   * behind it to remove — the provision is one `stat` — so the honest answer is
   * that there is nothing left, which lets the host clear the row rather than
   * leaving a half-built folder nobody can account for.
   * @param {any} workspace - The half-built row.
   * @param {any} ctx - Operations rooted at the project, and a signal.
   * @returns {Promise<any>} Nothing was left.
   */
  async cleanupPartial(workspace, ctx) {
    void workspace;
    void ctx;
    return { removed: true, message: 'Nothing was built for a folder, so nothing is left of it.' };
  }
}

export default ProjectFolderWorkspaceProvider;
