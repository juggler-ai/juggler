//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * A workspace that is a throwaway copy of the tree: somewhere to try a change
 * that may well be a mistake, and either fold back into the project or delete.
 *
 * ## Where the copies live, and why not the temp directory
 *
 * Under `.juggler/sandboxes/` of the workspace the copy was made from — the
 * project, ordinarily. "Throwaway" describes what the user means to do with it,
 * not what the storage guarantees: a sandbox holds hours of unapplied work, and
 * a reboot that clears `/tmp`, or macOS reaping `/var/folders`, would destroy it
 * silently. Living beside the project also makes the artifacts enumerable —
 * cleaning up after an interrupted provision is a directory listing rather than
 * a guess at a temp-directory naming convention.
 * @module workspaces/scratch-copy-workspace-provider
 */

import WorkspaceProvider from 'juggler/workspace-provider';
import { baseName, join } from '../lib/workspace-paths.js';
import { field, nextFormSequence, showNote } from '../lib/setup-fields.js';

/**
 * The file that keeps the copies out of the user's own `git status`.
 *
 * Every surface in this app already refuses to look inside `.juggler`, whatever
 * a project's ignore file says — but git has never heard of that rule, and a
 * project that does not ignore `.juggler` itself would start reporting a
 * sandbox as untracked work the moment one was made. One line, written where the
 * copies live, says it in the only language git reads.
 * @type {string}
 */
const IGNORE_MARKER = '*\n';

/**
 * Where sandboxes go, relative to the workspace they are copies of.
 * @type {string}
 */
export const SANDBOXES_REL = '.juggler/sandboxes';

/**
 * A name as a single path segment: what the user typed, minus anything a
 * directory name cannot be.
 * @param {string} name - What the form collected.
 * @returns {string} A usable segment, or '' when nothing of it survived.
 */
export function slug(name) {
  return String(name ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '');
}

/**
 * Everywhere one sandbox is, absolute and relative, from its name alone.
 *
 * The suite builds its fixtures through this and the provider builds the real
 * thing through it, so the place that is tested and the place that is made
 * cannot be two different places.
 * @param {string} baseRoot - The workspace being copied, absolutely.
 * @param {string} name - What the sandbox is called.
 * @returns {{name: string, rel: string, workRel: string, pristineRel: string, dir: string, work: string, pristine: string}} Everywhere involved.
 */
export function sandboxPlaces(baseRoot, name) {
  const named = slug(name);
  const rel = `${SANDBOXES_REL}/${named}`;
  return {
    name: named,
    rel,
    // Relative paths are what operations are given: they are the only form both
    // path worlds agree on (see lib/workspace-paths).
    workRel: `${rel}/work`,
    pristineRel: `${rel}/pristine`,
    dir: join(baseRoot, rel),
    // What the conversation works in, and what it is registered as.
    work: join(baseRoot, `${rel}/work`),
    // What it looked like when it was copied, which is the whole of how a change
    // made in a sandbox is told apart from the tree it was made in.
    pristine: join(baseRoot, `${rel}/pristine`)
  };
}

/**
 * How many files, said in words that read as a sentence either way.
 * @param {number} count - How many.
 * @returns {string} e.g. '1 file' or '7 files'.
 */
function countOf(count) {
  return `${count} file${count === 1 ? '' : 's'}`;
}

/**
 * A few paths, named, with the rest counted.
 *
 * Every name would be a paragraph in a dialog, and none of them would be the
 * one the reader is looking for after the fifth.
 * @param {string[]} paths - What to name.
 * @returns {string} A readable list.
 */
function namedFiles(paths) {
  const shown = paths.slice(0, 3);
  const rest = paths.length - shown.length;
  const list = shown.join(', ');
  if (!rest) return `${list} ${paths.length === 1 ? 'has' : 'have'}`;
  return `${list} and ${countOf(rest)} more have`;
}

/**
 * A copy of the tree, as a place a conversation can work.
 */
class ScratchCopyWorkspaceProvider extends WorkspaceProvider {
  /**
   * @param {{session?: any}} [context] - What is known before any hook runs.
   */
  constructor(context = {}) {
    super(context);

    /** @type {any} The rendered form, while there is one. */
    this._form = null;
  }

  static MANIFEST = {
    id: 'scratch-copy',
    name: 'Scratch Copy',
    version: '1.0.0',
    description: 'A copy of this tree to try something risky in, and throw away',
    setupLabel: 'New scratch copy',
    recommendations: {
      bestFor: 'a change that may well be a mistake, in a project with or without git',
      avoidFor: 'work you already know you are keeping',
      notes: [
        'Anything your .gitignore leaves out is left out of the copy, so a build there starts from nothing.',
        'Applying the change back copies whole files, and refuses the ones the project has changed since.'
      ]
    }
  };

  /**
   * One field: what to call it.
   *
   * There is nothing else to ask. Where a copy goes is not a convention the way
   * a worktree's placement is — it is `.juggler/sandboxes/`, so that the app can
   * find every copy ever made in one listing and a reboot cannot quietly take
   * one away — so the location is shown under the field rather than offered as a
   * decision. A form with a choice in it that has only one right answer is a
   * form that wastes somebody's attention every time it opens.
   * @param {HTMLElement} container - The panel section's body.
   * @param {any} ctx - Session, operations pinned to the workspace being copied, and the rest.
   */
  renderSetup(container, ctx) {
    const id = `scratch-copy-name-${nextFormSequence()}`;
    container.replaceChildren();
    const { input, note } = field(container, id, 'name', 'Name', 'risky-idea');

    // What the section last reported, when there is any: a provision that was
    // cancelled or failed puts the form back, and retyping it is a poor reward
    // for changing your mind.
    input.value = String(ctx?.values?.name ?? '');

    const form = { ctx, container, id, input, note };
    this._form = form;
    input.addEventListener('input', () => { this._showDestination(); });
    this._showDestination();
  }

  /**
   * Say what a copy is and where this one is going, under the field that names
   * it. Written for somebody meeting the feature here: the reader who already
   * knows what a scratch copy is only needs the path, and the one who does not
   * needs to be told that their own files are not the ones being edited.
   */
  _showDestination() {
    const form = this._form;
    if (!form) return;
    const named = slug(form.input.value);
    if (!named) {
      showNote(form.note, form.input.value.trim()
        ? 'That leaves nothing that can be a directory name.'
        : '', { error: true });
      return;
    }
    const baseRoot = form.ctx?.session?.workspaceRoot?.(form.ctx?.baseWorkspaceId ?? '') ?? '';
    showNote(
      form.note,
      baseRoot ? 'Work in a copy of the project, not your own files. Files git ignores are not copied.' : '',
      { path: baseRoot ? sandboxPlaces(baseRoot, named).work : '' }
    );
  }

  /**
   * What the form currently says, and whether Create may be pressed.
   * @returns {any} Validity, values, and which field to go back to.
   */
  getSetupValue() {
    const form = this._form;
    if (!form) return { valid: false, values: {}, invalidFieldId: '' };

    const name = form.input.value.trim();
    const baseRoot = form.ctx?.session?.workspaceRoot?.(form.ctx?.baseWorkspaceId ?? '') ?? '';
    const named = slug(name);
    const values = {
      name,
      // Reported so the host can register the row where the copy is really
      // going before a single byte of it exists; `plannedRoot` reads it back.
      location: named && baseRoot ? sandboxPlaces(baseRoot, named).work : ''
    };
    return named
      ? { valid: true, values }
      : { valid: false, values, invalidFieldId: form.id };
  }

  /**
   * Where the copy will be, before anything has been copied.
   *
   * The form works it out and shows the user the same answer; a caller handing
   * values over literally names only the sandbox and gets '', which is harmless
   * — a provisioning row refuses every operation, and what undoes a dead
   * provision is `meta` rather than `root`.
   * @param {any} values - What the setup form collected; `location` when it knows one.
   * @returns {string} The intended root, or '' when nothing named one.
   */
  plannedRoot(values) {
    return values?.location ?? '';
  }

  /**
   * Which tree this is a copy of, and where the copy goes.
   *
   * The base workspace is the thing being copied — the project, ordinarily, but
   * a worktree just as well — and the copy lives under it rather than under the
   * project, because the operations that make it are pinned there and the ending
   * that lands the work has to reach the same tree it came from.
   * @param {any} values - What the setup form collected; only `name` is read.
   * @param {any} ctx - The hook's context, for the session and the base workspace.
   * @returns {{baseRoot: string, places: any}} The tree and the places.
   * @throws {Error} When there is no base root, or nothing usable to call it.
   */
  _places(values, ctx) {
    const baseRoot = ctx?.session?.workspaceRoot?.(ctx?.baseWorkspaceId ?? '');
    if (!baseRoot) throw new Error("Couldn't make a copy: the workspace it would be a copy of has no root.");
    const places = sandboxPlaces(baseRoot, values?.name ?? '');
    if (!places.name) {
      throw new Error(`Couldn't make a copy: ${JSON.stringify(String(values?.name ?? ''))} leaves nothing that can be a directory name.`);
    }
    return { baseRoot, places };
  }

  /**
   * Make the copy, and a snapshot of it.
   *
   * Two copies rather than one, and the second is the whole design: a change
   * made in a sandbox is only visible as a change against what was there when it
   * was made. A list of hashes would do the same job in less disk and rather
   * more code, and would not let anyone look at the original by hand.
   *
   * Nothing here runs a command. The ignore rules a copy has to honour are the
   * server's — which reads `.gitignore` whether or not git is installed — and a
   * copy expressed as an operation needs no opinion about which of the three
   * shells a Windows machine has, nor about how it quotes a path.
   * @param {any} values - name.
   * @param {any} ctx - Operations pinned to the base workspace, signal, rollback, checkpoint, progress.
   * @returns {Promise<any>} The workspace that now exists.
   */
  async provision(values, ctx) {
    const { baseRoot, places } = this._places(values, ctx);

    // Refuse rather than write into something already there. It is also what
    // makes the compensation below safe to run unconditionally: it removes a
    // directory that did not exist a moment ago, so it can never take away work
    // somebody else left in the way.
    const occupied = await ctx.ops.stat({ path: places.rel });
    if (occupied?.exists) {
      throw new Error(`Couldn't make a copy at ${places.dir}: there is already something there.`);
    }

    const meta = {
      name: places.name,
      baseDir: baseRoot,
      dir: places.dir,
      work: places.work,
      pristine: places.pristine
    };

    ctx.progress('Copying the tree', places.work);
    // Both records of how to undo this go in before the step, so there is no
    // instant in which a copy exists that nothing knows how to remove. The cost
    // is that this compensation routinely runs for a copy that was never made,
    // which a removal tolerates.
    await ctx.checkpoint(meta);
    ctx.rollback.push(async () => {
      await ctx.ops.copyTree({ to: '.', delete: [places.rel] }, ctx.signal);
    });

    await ctx.ops.writeFile(
      { path: `${SANDBOXES_REL}/.gitignore`, content: IGNORE_MARKER }, ctx.signal);
    await ctx.ops.copyTree({ from: '.', to: places.workRel }, ctx.signal);

    ctx.progress('Taking a snapshot of it', places.pristine);
    await ctx.ops.copyTree({ from: places.workRel, to: places.pristineRel }, ctx.signal);

    return {
      workspace: {
        root: places.work,
        label: places.name,
        meta
      }
    };
  }

  /**
   * How much has happened in the copy since it was taken.
   *
   * The count of {@link _changes}, which is cheap enough to be asked of every
   * row the panel lists the moment it opens, not only of the one in use.
   *
   * What it does not do is look at the project. Whether the change would still
   * apply cleanly is a second walk over a second tree, and it is a question with
   * an answer only at the moment of applying.
   * @param {any} workspace - The row to report on.
   * @param {any} ctx - Operations pinned to the copy, the base workspace's, and a signal.
   * @returns {Promise<any>} What to show for it.
   */
  async status(workspace, ctx) {
    const meta = workspace?.meta ?? {};
    if (workspace.available === false) {
      return { detail: 'The copy is missing.', available: false };
    }
    if (!meta?.baseDir) {
      return { detail: 'There is no record of what this is a copy of.', available: true };
    }

    const changes = await this._changes(workspace, ctx);
    const count = (changes?.paths ?? []).length + (changes?.removed ?? []).length;

    return {
      // Said against the thing it is measured against. A bare count is a number
      // whose question the reader has to guess at, and the guesses — changed
      // against the project? against the last turn? — are all answers this does
      // not give: it is the copy compared with the snapshot taken of it.
      detail: count
        ? `${countOf(count)} changed since the copy was made`
        : 'Nothing changed since the copy was made',
      badge: count ? 'changed' : '',
      dirty: count > 0,
      available: true
    };
  }

  /**
   * Every file the copy holds that its snapshot does not, for a conversation
   * moving out of it and taking its work along.
   *
   * A sandbox is the case this hook exists for. Git has never heard of a copy
   * under `.juggler/sandboxes` — there is no repository in it and nothing it has
   * committed — so a tree full of an afternoon's work reads as clean to the only
   * thing that can otherwise enumerate one. What the copy holds is exactly what
   * it does not share with its snapshot, which is the same comparison the panel
   * has been counting all along.
   *
   * Paths come back relative to the compared roots, which is relative to this
   * workspace, which is the form an operation takes them in.
   * @param {any} workspace - The row to account for.
   * @param {any} ctx - Operations pinned to the copy, the base workspace's, and a signal.
   * @returns {Promise<any>} What it holds, listed.
   */
  async heldWork(workspace, ctx) {
    const changes = await this._changes(workspace, ctx);
    // A copy with nothing to compare against holds work that cannot be
    // enumerated, which is not the same as holding none. Saying `complete:
    // false` refuses the carry; saying nothing would let it copy an empty list
    // over somebody's tree and report that it had brought everything.
    if (!changes) return { complete: false, paths: [], removed: [] };
    return { complete: true, ...changes };
  }

  /**
   * What has happened in the copy since it was taken.
   *
   * The single comparison {@link status} counts and {@link heldWork} lists, so
   * the number on screen and the files that get carried cannot be two different
   * answers to one question. It is cheap for the reason the snapshot is a copy
   * at all: two trees copied from one another agree on size and modification
   * time, so an untouched sandbox is answered for without a byte of it being
   * read.
   *
   * It asks through the BASE workspace's operations, because the snapshot is a
   * sibling of the copy and therefore outside the copy's own root — which is the
   * boundary this workspace's operations refuse to reach past, quite rightly.
   * @param {any} workspace - The row to compare.
   * @param {any} ctx - Operations pinned to the copy, the base workspace's, and a signal.
   * @returns {Promise<{paths: string[], removed: string[]}|null>} What changed, or null with nothing to compare against.
   */
  async _changes(workspace, ctx) {
    const meta = workspace?.meta ?? {};
    const baseDir = String(meta?.baseDir ?? '');
    if (!baseDir || workspace?.available === false) return null;

    const named = slug(String(meta?.name ?? '')) || workspace.label || baseName(workspace.root);
    const places = sandboxPlaces(baseDir, named);
    const ops = ctx.baseOps ?? ctx.ops;
    const difference = await ops.compareTrees(
      { left: places.pristineRel, right: places.workRel }, ctx.signal);
    return {
      paths: [...(difference?.changed ?? []), ...(difference?.added ?? [])],
      removed: [...(difference?.removed ?? [])]
    };
  }

  /**
   * The four ways to be done with a copy.
   *
   * Two of them apply the work and two of them do not, and the difference
   * between the two that apply is the whole of what this provider had to decide:
   * what to do when the tree the copy came from has moved on underneath it.
   * Applying refuses the lot and names what it would have had to overwrite;
   * overwriting is a second ending the user picks deliberately, having read that
   * sentence. There is no third way that quietly does half of it.
   * @param {any} workspace - The row being finished with.
   * @returns {any[]} The endings, the harmless ones first.
   */
  finishOptions(workspace) {
    const meta = workspace?.meta ?? {};
    const tree = meta.baseDir ? baseName(String(meta?.baseDir)) : 'the project';
    return [
      {
        id: 'apply',
        label: 'Apply the changes',
        description: `Copies what changed here back into ${tree}, then removes the copy. Anything ${tree} has changed since is refused by name, and nothing is applied.`
      },
      {
        id: 'keep',
        label: 'Close the workspace, keep the copy',
        description: 'The copy and everything in it stays on disk, ready to be adopted again. Conversations here go to the bin, which they can be restored from.'
      },
      {
        id: 'apply-anyway',
        label: 'Apply, overwriting',
        danger: true,
        description: `Copies the changes back even over files ${tree} has changed since. What is in ${tree} is lost.`
      },
      {
        id: 'discard',
        label: 'Close the workspace and delete the copy',
        danger: true,
        description: 'Deletes the copy and everything done in it. Conversations here go to the bin, which they can be restored from.'
      }
    ];
  }

  /**
   * Carry one of them out.
   *
   * Everything here runs through the BASE workspace's operations rather than the
   * copy's own: applying writes into the tree the copy came from, which is
   * outside the copy and so outside what its operations may touch — and removing
   * the copy through them would be sawing off the branch the next call stands on.
   * @param {any} workspace - The row being finished with.
   * @param {string} actionId - One of {@link finishOptions}.
   * @param {any} ctx - Operations pinned to the copy, the base workspace's, and a signal.
   * @returns {Promise<any>} Whether the workspace is finished with, and what to say.
   */
  async finish(workspace, actionId, ctx) {
    const meta = workspace?.meta ?? {};
    const named = slug(String(meta?.name ?? ''));
    const baseDir = String(meta?.baseDir ?? '');
    if (!named || !baseDir) {
      return { done: false, message: 'There is no record of what this is a copy of, so it is not ours to finish with.' };
    }

    const places = sandboxPlaces(baseDir, named);
    const ops = ctx.baseOps ?? ctx.ops;

    if (actionId === 'keep') {
      return { done: true, message: `Left ${places.dir} where it is.` };
    }
    if (actionId === 'discard') return this._discard(places, ops, ctx);
    if (actionId === 'apply' || actionId === 'apply-anyway') {
      return this._apply(places, ops, ctx, actionId === 'apply-anyway');
    }
    return { done: false, message: `${this.getManifest().name} has no action "${actionId}".` };
  }

  /**
   * Copy the work back into the tree it came from.
   *
   * Three comparisons and one copy, which is the whole of it. What the copy did
   * is `pristine` against `work`; what the tree has done since is `pristine`
   * against the tree; and the overlap between those two is only a real
   * disagreement where the copy and the tree still differ — two people who made
   * the same edit are not arguing, and refusing there would teach the user that
   * the refusal means nothing.
   *
   * Whole files, never hunks. A three-way merge of the contents is a feature
   * with conflicts in it, and this is a provider for a change you were prepared
   * to throw away.
   * @param {any} places - Where the copy and its snapshot are.
   * @param {any} ops - Operations pinned to the base workspace.
   * @param {any} ctx - For the signal.
   * @param {boolean} overwrite - Whether to apply over a tree that has moved on.
   * @returns {Promise<any>} Whether it landed.
   */
  async _apply(places, ops, ctx, overwrite) {
    // Exact, because the copy is deleted a few lines below this: a file this
    // comparison calls unchanged is a file that is never written back and then
    // thrown away with everything else. Equal size and equal time is a good
    // enough answer for a status line and the wrong kind of answer here.
    const mine = await ops.compareTrees(
      { left: places.pristineRel, right: places.workRel, exact: true }, ctx.signal);
    const written = [...(mine?.changed ?? []), ...(mine?.added ?? [])];
    const removed = [...(mine?.removed ?? [])];
    if (!written.length && !removed.length) {
      return { done: false, message: 'Nothing has changed in the copy, so there is nothing to apply.' };
    }

    if (!overwrite) {
      const conflicts = await this._conflicts(places, ops, ctx, [...written, ...removed]);
      if (conflicts.length) {
        return {
          done: false,
          message: `${baseName(places.dir)} could not be applied: ${namedFiles(conflicts)} changed since the copy was taken. Nothing was applied.`
        };
      }
    }

    await ops.copyTree(
      { from: places.workRel, to: '.', paths: written, delete: removed }, ctx.signal);
    // The copy has nothing left to hold: every byte of it is now in the tree it
    // came from.
    await ops.copyTree({ to: '.', delete: [places.rel] }, ctx.signal);
    return {
      done: true,
      message: `Applied ${countOf(written.length + removed.length)} and removed ${places.dir}.`
    };
  }

  /**
   * Which of the paths this apply would touch the base tree has changed for
   * itself — and still disagrees with the copy about.
   * @param {any} places - Where the copy and its snapshot are.
   * @param {any} ops - Operations pinned to the base workspace.
   * @param {any} ctx - For the signal.
   * @param {string[]} touched - What the apply wants to write or remove.
   * @returns {Promise<string[]>} The paths that are genuinely contested.
   */
  async _conflicts(places, ops, ctx, touched) {
    // Exact for the same reason as the apply it guards: what this misses is
    // overwritten without being mentioned.
    const theirs = await ops.compareTrees(
      { left: places.pristineRel, right: '.', exact: true }, ctx.signal);
    const moved = new Set([
      ...(theirs?.changed ?? []), ...(theirs?.added ?? []), ...(theirs?.removed ?? [])
    ]);
    const contested = touched.filter(path => moved.has(path));
    if (!contested.length) return [];

    // Only now, and only because something is contested: this walks the base
    // tree a second time, and the common ending is the one where nothing is.
    const disagreement = await ops.compareTrees(
      { left: places.workRel, right: '.', exact: true }, ctx.signal);
    const differ = new Set([
      ...(disagreement?.changed ?? []), ...(disagreement?.added ?? []), ...(disagreement?.removed ?? [])
    ]);
    return contested.filter(path => differ.has(path));
  }

  /**
   * Remove the copy and its snapshot.
   * @param {any} places - Where the copy is.
   * @param {any} ops - Operations pinned to the base workspace.
   * @param {any} ctx - For the signal.
   * @returns {Promise<any>} Whether anything is left.
   */
  async _discard(places, ops, ctx) {
    await ops.copyTree({ to: '.', delete: [places.rel] }, ctx.signal);
    const left = await ops.stat({ path: places.rel });
    return left?.exists
      ? { done: false, message: `${places.dir} is still there and could not be removed.` }
      : { done: true, message: `Removed ${places.dir}.` };
  }

  /**
   * Square the rows against the copies that are actually there.
   *
   * One directory listing, which is the whole argument for keeping the copies in
   * a known place rather than in the system's temp directory: what exists is
   * enumerable, rather than guessed at from a naming convention.
   *
   * Nothing is tombstoned. A copy that has gone is gone, and the server's own
   * `stat` already marks the row unavailable and tells the conversation so — the
   * closing rule next door is for the other kind of orphan, where everything
   * still works and quietly works on the wrong thing, which a copy has no way of
   * becoming. A copy with no row is the useful half: it is offered, and adopting
   * it builds nothing.
   * @param {any[]} workspaces - This provider's rows.
   * @param {any} ctx - Operations rooted at the project, and a signal.
   * @returns {Promise<any>} What matches, what does not, and what has no row.
   */
  async reconcile(workspaces, ctx) {
    /** @type {string[]} */
    const confirmed = [];
    /** @type {any[]} */
    const orphanedWorkspaces = [];
    /** @type {any[]} */
    const orphanedArtifacts = [];

    const projectPath = ctx?.session?.projectPath ?? '';
    if (!projectPath) return { orphanedWorkspaces, orphanedArtifacts, confirmed };

    // These operations are rooted at the project, so the project's copies are
    // what this pass can see. A copy made from somewhere else — a worktree —
    // is left strictly alone rather than reported missing on the strength of
    // having looked in the wrong place.
    const listing = await ctx.ops.expandDirectory({ path: SANDBOXES_REL }).catch(() => null);
    const present = new Set((listing?.items ?? [])
      .filter((/** @type {any} */ item) => item.isDir)
      .map((/** @type {any} */ item) => String(item.name)));

    /** @type {Set<string>} */
    const spokenFor = new Set();
    for (const workspace of workspaces) {
      const meta = workspace?.meta ?? {};
      const named = slug(String(meta?.name ?? ''));
      if (!named || String(meta?.baseDir ?? '') !== projectPath) continue;
      // A row that has been finished with speaks for nothing: its copy is
      // offered again, which is what stopping rather than deleting was for, and
      // a copy whose directory has gone is not reported missing on behalf of a
      // row that stopped caring.
      if (workspace.state === 'closed') continue;
      spokenFor.add(named);
      if (present.has(named)) {
        confirmed.push(workspace.id);
        continue;
      }
      orphanedWorkspaces.push({
        ...workspace,
        reason: `${meta.dir ?? workspace.root} is not there any more.`
      });
    }

    for (const named of present) {
      if (spokenFor.has(named)) continue;
      const places = sandboxPlaces(projectPath, named);
      orphanedArtifacts.push({
        id: places.dir,
        label: named,
        detail: `${places.dir} — a copy with no conversation`,
        workspace: {
          root: places.work,
          label: named,
          meta: {
            name: named,
            baseDir: projectPath,
            dir: places.dir,
            work: places.work,
            pristine: places.pristine
          }
        }
      });
    }

    return { orphanedWorkspaces, orphanedArtifacts, confirmed };
  }

  /**
   * Undo a provision that died with the tab it was running in.
   *
   * It works from `meta` alone, and rebuilds the path from the sandbox's name
   * rather than trusting the one recorded beside it: a name is put back through
   * the same slug on the way out, so a record that has been edited by hand
   * cannot name a directory outside the place sandboxes live.
   * @param {any} workspace - The half-built row.
   * @param {any} ctx - Operations rooted at the project, plus the base workspace's.
   * @returns {Promise<any>} Whether anything is left.
   */
  async cleanupPartial(workspace, ctx) {
    const meta = workspace?.meta ?? {};
    const named = slug(String(meta?.name ?? ''));
    const baseDir = String(meta?.baseDir ?? '');
    if (!named || !baseDir) {
      return { removed: false, message: 'Nothing was checkpointed, so there is nothing to undo.' };
    }

    // The base workspace's operations where the host has them, because that is
    // where the copy is: a sandbox of a worktree lives under the worktree, which
    // a pass rooted at the project cannot reach at all.
    const ops = ctx.baseOps ?? ctx.ops;
    const places = sandboxPlaces(baseDir, named);
    await ops.copyTree({ to: '.', delete: [places.rel] }, ctx.signal);

    // Asked rather than assumed: a removal succeeds for a copy that was never
    // made and for one that will not go, and those are opposite answers to the
    // one question the host has.
    const left = await ops.stat({ path: places.rel });
    return left?.exists
      ? { removed: false, message: `${places.dir} is still there and could not be removed.` }
      : { removed: true, message: `Removed ${places.dir}.` };
  }
}

export default ScratchCopyWorkspaceProvider;
