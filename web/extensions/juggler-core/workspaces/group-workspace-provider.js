//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * A group: a named box to keep conversations together in, and nothing else.
 *
 * ## It is the project, under another name
 *
 * The row is rooted at the project itself, so a conversation in a group works
 * exactly where it would have worked outside one — the same tools, the same
 * files, the same git. That is the whole point: a group changes how the
 * conversations are arranged, never where they work. Everything a workspace
 * would otherwise say about its own tree is therefore left unsaid here, because
 * whatever this tree holds is the project's, and the project already says it:
 * no dirty dot, no held work, no instructions of its own to seed.
 *
 * ## Its two endings
 *
 * Nothing was built, so the endings are about the conversations rather than
 * the tree. Ungrouping hands them back to the project, which is where they were
 * working all along; deleting sends them to the bin, as ending any other
 * workspace does. Either way the row is closed and the project is untouched.
 * @module workspaces/group-workspace-provider
 */

import WorkspaceProvider from 'juggler/workspace-provider';
import { field, nextFormSequence, showNote } from '../lib/setup-fields.js';

/**
 * What a group made without a name is called, followed by a number.
 * @type {string}
 */
const DEFAULT_NAME = 'Group';

/**
 * A group of conversations, working in the project.
 */
class GroupWorkspaceProvider extends WorkspaceProvider {
  /**
   * @param {{session?: any}} [context] - What is known before any hook runs.
   */
  constructor(context = {}) {
    super(context);

    /** @type {any} The rendered form, while there is one. */
    this._form = null;
  }

  static MANIFEST = {
    id: 'group',
    name: 'Group',
    version: '1.0.0',
    description: 'A container for you to group related conversations together.',
    setupLabel: 'New group',
    recommendations: {
      bestFor: 'keeping related conversations together in the strip',
      avoidFor: 'isolating work from the project — a worktree or a copy does that',
      notes: [
        'Nothing is created on disk: conversations in a group work in the project exactly as they would outside it.',
        'Ungrouping puts its conversations back in the project; deleting it sends them to the bin.'
      ]
    }
  };

  /**
   * One field: what to call it. Optional — a group left unnamed is numbered.
   * @param {HTMLElement} container - The panel section's body.
   * @param {any} ctx - Session, operations, and what the section last reported.
   */
  renderSetup(container, ctx) {
    const id = `group-name-${nextFormSequence()}`;
    container.replaceChildren();
    const { input, note } = field(container, id, 'name', 'Name', 'Enter group name');
    input.value = String(ctx?.values?.name ?? '');
    showNote(note, 'Conversations in a group work in the project, exactly as they would outside it.');
    this._form = { input };
  }

  /**
   * What the form says. Always pressable: an empty name is a numbered group.
   * @returns {any} Validity and values.
   */
  getSetupValue() {
    return { valid: true, values: { name: String(this._form?.input?.value ?? '').trim() } };
  }

  /**
   * The project itself, named.
   * @param {any} values - name, which may be empty.
   * @param {any} ctx - The hook's context, for the session.
   * @returns {Promise<any>} The workspace.
   */
  async provision(values, ctx) {
    const project = String(ctx?.session?.projectPath ?? '');
    if (!project) throw new Error("Couldn't make a group: the session has no project.");
    const label = String(values?.name ?? '').trim() || nextGroupName(ctx.session);
    return { workspace: { root: project, label } };
  }

  /**
   * What it is, and nothing about its tree, which is the project's.
   * @param {any} workspace - The row to report on.
   * @param {any} ctx - Unused.
   * @returns {Promise<any>} What to show for it.
   */
  async status(workspace, ctx) {
    void ctx;
    return { kind: 'Group', available: workspace?.available !== false };
  }

  /**
   * Nothing. What is uncommitted in the project belongs to the project, and
   * leaving this to git would report all of it as the group's.
   * @param {any} workspace - The row.
   * @param {any} ctx - Unused.
   * @returns {Promise<any>} An empty account.
   */
  async heldWork(workspace, ctx) {
    void workspace;
    void ctx;
    return { complete: true, paths: [], removed: [] };
  }

  /**
   * None: the root is the project, whose instructions are the root's own.
   * @param {any} workspace - The row.
   * @param {any} ctx - Unused.
   * @returns {string[]} Nothing further.
   */
  instructionRoots(workspace, ctx) {
    void workspace;
    void ctx;
    return [];
  }

  /**
   * Ungroup, or delete.
   * @param {any} workspace - The row being finished with.
   * @returns {any[]} The two endings.
   */
  finishOptions(workspace) {
    void workspace;
    return [
      {
        id: 'ungroup',
        label: 'Ungroup',
        description: 'Its conversations go back into the project, and the group is removed.'
      },
      {
        id: 'delete',
        label: 'Delete group',
        danger: true,
        description: 'Its conversations go to the bin, and the group is removed. Nothing in the project changes.'
      }
    ];
  }

  /**
   * There is nothing to take down; what becomes of the conversations is the
   * host's to carry out, and this says which.
   * @param {any} workspace - The row being finished with.
   * @param {string} actionId - Which ending.
   * @param {any} ctx - The hook's context.
   * @returns {Promise<any>} Finished, and where its conversations go.
   */
  async finish(workspace, actionId, ctx) {
    if (actionId === 'ungroup') return { done: true, conversations: 'return' };
    if (actionId === 'delete') return { done: true, conversations: 'bin' };
    return super.finish(workspace, actionId, ctx);
  }

  /**
   * Nothing was built, so nothing is left.
   * @param {any} workspace - The half-built row.
   * @param {any} ctx - Unused.
   * @returns {Promise<any>} Nothing was left.
   */
  async cleanupPartial(workspace, ctx) {
    void workspace;
    void ctx;
    return { removed: true, message: 'Nothing was built for a group, so nothing is left of it.' };
  }
}

/**
 * "Group N", for the lowest N no open group is already called.
 * @param {any} session - The session whose groups these are.
 * @returns {string} The name.
 */
function nextGroupName(session) {
  const taken = new Set();
  for (const row of session?.workspaces ?? []) {
    if (row?.state === 'closed') continue;
    taken.add(String(row?.label ?? ''));
  }
  let n = 1;
  while (taken.has(`${DEFAULT_NAME} ${n}`)) n++;
  return `${DEFAULT_NAME} ${n}`;
}

export default GroupWorkspaceProvider;
