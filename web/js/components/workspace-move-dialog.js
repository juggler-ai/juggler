//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Whether a conversation dragged somewhere else should really work there.
 *
 * A confirmation, and only that. Where it is going was settled by the gesture
 * that opened this — a tab dropped in another workspace's box, or out of every
 * box onto the flat strip, which is the project folder. Asking again where to
 * go would be asking a question the drag has already answered.
 *
 * What it does ask is worth the pause: a rebinding moves where a conversation's
 * files and commands happen, under an agent that may be working, and an eighth
 * of a second of slipped finger must not do that silently. So it states both
 * ends in full — the tree being left and the tree being moved into, each named
 * and addressed — and waits. Naming one end would confirm nothing; a drag that
 * landed one box off looks exactly like the one that landed right.
 *
 * It is a dialog rather than a block in the transcript because by then the
 * transcript belongs to the work: a conversation half way through a task is not
 * a conversation with a question at the top of it.
 * @module components/workspace-move-dialog
 */

import { presentModal } from '../utils/modal-surface.js';
import { rebindConversation } from '../services/workspace-rebinding.js';
import { errorText } from '../../sdk/lib/error-utils.js';
import { createFileActions } from '../utils/properties-panel-helpers.js';
import { setupButton } from './workspace-setup-form.js';
import { t } from '../../sdk/lib/i18n.js';

/**
 * Ask whether this conversation should move, and move it if so.
 * @param {any} conversation - The conversation that would move.
 * @param {string} workspaceId - Where it would move to: a workspace id, or `''`
 *   for the project folder. Required — this dialog confirms a destination, it
 *   does not offer one.
 * @returns {Promise<{moved: boolean, workspaceId?: string}>} Where it went, if it went.
 */
export function openWorkspaceMove(conversation, workspaceId) {
  const session = conversation?.session;
  const currentId = conversation?.workspaceId || '';
  const target = workspaceId || '';

  return new Promise((resolve) => {
    const modal = presentModal({
      className: 'workspace-move-overlay',
      dismissSelectors: ['.workspace-move-backdrop', '.workspace-move-close', '.workspace-move-cancel'],
      onClose: (/** @type {{moved: boolean, workspaceId?: string}|undefined} */ result) => resolve(result ?? { moved: false })
    });
    const root = modal.root;

    /** @type {string} Why the last attempt did not happen. */
    let error = '';
    /** @type {boolean} Whether the move is in flight, so a second press is not a second move. */
    let moving = false;

    /**
     * What to call a place, and where it is.
     * @param {string} id - A workspace id, or '' for the project folder.
     * @returns {{label: string, path: string}} Its name and its address.
     */
    const describe = (id) => {
      if (!id) return { label: t('The project folder'), path: session?.projectPath || '' };
      const workspace = session?.getWorkspace?.(id);
      // The id is the last resort rather than a lie: a workspace this window
      // cannot resolve is one the move is about to be refused for, and the
      // refusal reads better against something than against "the project".
      return { label: workspace?.label || workspace?.root || id, path: workspace?.root || '' };
    };

    /**
     * One end of the move: what it is called, then where it is.
     *
     * Both ends are set the same way, because the reader's whole job here is to
     * compare them, and two places written down two ways have to be translated
     * before they can be compared.
     * @param {string} modifier - The class saying which end this is.
     * @param {string} lead - What this end is to the move.
     * @param {string} id - The place itself.
     * @returns {HTMLElement} The block.
     */
    const placeBlock = (modifier, lead, id) => {
      const { label, path } = describe(id);
      const block = document.createElement('div');
      block.className = `workspace-move-now ${modifier}`;
      block.dataset.workspaceId = id;

      const says = document.createElement('div');
      says.className = 'workspace-move-now-lead';
      says.textContent = lead;
      block.appendChild(says);

      const named = document.createElement('div');
      named.className = 'workspace-move-now-label';
      named.textContent = label;
      block.appendChild(named);

      // The address, whole and on its own line. It is the part of this a reader
      // may want out of the dialog rather than in it — into a terminal, or open
      // in a file manager beside it — so it is offered as a path, with the two
      // things you can do with one, and not as the tail of a sentence. Pinning
      // is not among them: this is a modal, and a pin put on the board behind
      // one is a thing that happened out of sight.
      const where = document.createElement('div');
      where.className = 'workspace-move-now-path-row';
      const box = document.createElement('div');
      box.className = 'workspace-move-now-path';
      box.textContent = path;
      if (path) box.dataset.filePath = path;
      where.appendChild(box);
      const onPath = createFileActions(path, { directory: true });
      if (onPath) where.appendChild(onPath);
      block.appendChild(where);

      return block;
    };

    /**
     * Move, or say why not. A refusal — a turn in flight, a tree that cannot be
     * worked in — is shown here rather than in a dialog over this one, and
     * leaves the question on screen to answer again.
     * @returns {Promise<void>} When it has moved, or has not.
     */
    const commit = async () => {
      if (moving) return;
      moving = true;
      error = '';
      render();
      try {
        const result = await rebindConversation(conversation, target);
        if (result.done) {
          modal.close({ moved: true, workspaceId: target });
          return;
        }
        error = result.message || t(`Couldn't move the conversation.`);
      } catch (failure) {
        // The press is answered whatever happens. Every refusal is phrased to be
        // shown here, but a throw nobody expected would leave the dialog as it
        // was — a button that did nothing, which is the one thing it must never
        // be.
        error = errorText(failure);
      }
      if (modal.closed) return;
      moving = false;
      render();
    };

    /** Draw the dialog as it stands. */
    const render = () => {
      if (modal.closed) return;
      root.replaceChildren();

      // The chrome every other dialog in the app wears: the shared scrim, and a
      // panel whose surface, corner and shadow come from the one popup-surface
      // rule. A modal that paints its own card is a modal that drifts from the
      // rest of them one token at a time.
      const backdrop = document.createElement('modal-backdrop');
      backdrop.className = 'workspace-move-backdrop';
      root.appendChild(backdrop);

      const dialog = document.createElement('modal-panel');
      dialog.className = 'workspace-move-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-label', t('Move this conversation'));
      root.appendChild(dialog);

      const header = document.createElement('div');
      header.className = 'workspace-move-header';
      const title = document.createElement('h2');
      title.className = 'workspace-move-title';
      title.textContent = t('Move this conversation');
      header.appendChild(title);
      const close = setupButton('close-button workspace-move-close', '', () => modal.close(undefined));
      close.setAttribute('aria-label', t('Close'));
      close.title = t('Close');
      const cross = document.createElement('span');
      cross.className = 'icon-close';
      close.appendChild(cross);
      header.appendChild(close);
      dialog.appendChild(header);

      const body = document.createElement('div');
      body.className = 'workspace-move-body';
      dialog.appendChild(body);

      body.appendChild(placeBlock('workspace-move-from', t('Working in'), currentId));
      body.appendChild(placeBlock('workspace-move-to', t('Moving to'), target));

      if (error) {
        const failure = document.createElement('div');
        failure.className = 'setup-error';
        failure.textContent = error;
        body.appendChild(failure);
      }

      const actions = document.createElement('div');
      actions.className = 'workspace-move-footer';
      actions.appendChild(setupButton('btn-secondary workspace-move-cancel', t('Cancel'),
        () => modal.close(undefined)));
      const move = setupButton('btn-primary workspace-move-commit', t('Move', undefined, { context: 'button' }),
        () => { void commit(); });
      move.disabled = moving;
      actions.appendChild(move);
      dialog.appendChild(actions);
    };

    render();
    // The keyboard starts on the act the dialog exists for. There is one thing
    // to decide and two ways to decide it, and the one that was asked for is
    // the one under the hands.
    /** @type {HTMLElement|null} */ (root.querySelector('.workspace-move-commit'))?.focus();
  });
}
