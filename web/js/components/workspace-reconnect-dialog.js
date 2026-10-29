//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Putting back a workspace the table has lost.
 *
 * `session.json` is deliberately disposable here — conversation folders are the
 * truth, and a load rebuilds what it can from them — but the workspace table
 * lives in it. A conversation's binding does not: it lives in the conversation's
 * own document and survives, which leaves conversations bound to ids nothing can
 * resolve, with the trees they worked in still sitting on disk.
 *
 * A binding is an opaque id and nothing else. Nowhere on disk says which tree
 * `ws_k3n8fq2p1` meant, so no sweep can work it out — but the user knows, and
 * the providers can enumerate what exists. So this asks the one question that
 * cannot be answered any other way, and registers the answer UNDER THE STRANDED
 * ID rather than as a new workspace. That is the whole difference between this
 * and adopting a tree from the move dialog: restoring the id brings back every
 * conversation bound to it, including ones nobody has opened, while adopting
 * makes a new row that each of them would have to be moved to by hand.
 *
 * Nothing is re-seeded afterwards. The conversation has not moved — the claim
 * being made is that this is the tree it was already in — and we could only
 * refresh the one in front of us anyway, never the others coming back with it.
 * A recovery that half-refreshes is worse than one that does not.
 * @module components/workspace-reconnect-dialog
 */

import { presentModal } from '../utils/modal-surface.js';
import { setupRows, probeSetupAdoptions, adoptSetupRow } from '../services/workspace-places.js';
import { errorText } from '../../sdk/lib/error-utils.js';
import { setupButton, buildPlaceRows, handlePlaceRowKey } from './workspace-setup-form.js';
import { t } from '../../sdk/lib/i18n.js';

/**
 * How many conversations are bound to a workspace, which is how many come back
 * with it.
 * @param {any} session - The session holding the conversations.
 * @param {string} workspaceId - The binding in question.
 * @returns {number} How many.
 */
function boundCount(session, workspaceId) {
  let bound = 0;
  for (const conversation of session?.conversations?.values?.() ?? []) {
    if ((conversation.workspaceId || '') === workspaceId) bound++;
  }
  return bound;
}

/**
 * Ask where a stranded conversation was working, and put that workspace back.
 * @param {any} conversation - The conversation whose binding resolves to nothing.
 * @returns {Promise<{reconnected: boolean, workspaceId?: string}>} What was put back, if anything.
 */
export function openWorkspaceReconnect(conversation) {
  const session = conversation?.session;
  const strandedId = conversation?.workspaceId || '';

  return new Promise((resolve) => {
    const modal = presentModal({
      className: 'workspace-move-overlay workspace-reconnect-overlay',
      dismissSelectors: [
        '.workspace-move-backdrop', '.workspace-move-close', '.workspace-move-cancel'
      ],
      onClose: (/** @type {{reconnected: boolean, workspaceId?: string}|undefined} */ result) => {
        probes.abort();
        resolve(result ?? { reconnected: false });
      }
    });
    const root = modal.root;

    // Abandoned with the dialog: enumerating is a round trip per provider, and a
    // dialog closed a moment later has no further interest in the answers.
    const probes = new AbortController();

    /** @type {string} Why the last attempt did not happen. */
    let error = '';

    /**
     * The places a provider can find that no workspace speaks for — the same
     * offers there are, which after a lost table is every tree the
     * user ever made.
     * @returns {any[]} The rows.
     */
    const places = () => setupRows(session).filter((row) => row.kind === 'adopt');

    /**
     * Put one of them back under the stranded id.
     *
     * The refusal that matters is the server's: an id already on the table is
     * not free to be re-registered, and hearing so is better than being given a
     * second workspace that answers to nothing.
     * @param {any} row - The place that was chosen.
     * @returns {Promise<void>} When it is back, or has failed to be.
     */
    const reconnect = async (row) => {
      error = '';
      try {
        const restored = await adoptSetupRow(session, row.id, { id: strandedId });
        if (modal.closed) return;
        if (!restored) {
          error = t('That place is no longer on offer.');
          render();
          return;
        }
        // The binding is untouched: it already names this id, and that is what
        // has just been made to resolve again. The banner goes when the table's
        // broadcast reaches this window, like every other workspace edit.
        modal.close({ reconnected: true, workspaceId: restored.id });
      } catch (failure) {
        if (modal.closed) return;
        error = errorText(failure);
        render();
      }
    };

    /** Draw the dialog as it stands. */
    const render = () => {
      if (modal.closed) return;
      root.replaceChildren();

      const backdrop = document.createElement('div');
      backdrop.className = 'workspace-move-backdrop';
      root.appendChild(backdrop);

      const dialog = document.createElement('div');
      dialog.className = 'workspace-move-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-label', t('Where was this conversation working?'));
      root.appendChild(dialog);

      const header = document.createElement('div');
      header.className = 'workspace-move-header';
      const title = document.createElement('h2');
      title.className = 'workspace-move-title';
      title.textContent = t('Where was this conversation working?');
      header.appendChild(title);
      const close = setupButton('close-button workspace-move-close', '', () => modal.close(undefined));
      close.setAttribute('aria-label', t('Close'));
      close.title = t('Close');
      const cross = document.createElement('span');
      cross.className = 'icon-close';
      close.appendChild(cross);
      header.appendChild(close);
      dialog.appendChild(header);

      // What is being decided, and for whom. The count is the reason to answer
      // this rather than simply moving: one answer brings every conversation
      // bound to that workspace back with it.
      const bound = boundCount(session, strandedId);
      const explains = document.createElement('div');
      explains.className = 'workspace-move-work';
      const lead = document.createElement('div');
      lead.className = 'workspace-move-work-lead';
      lead.textContent = t('{count, plural, =0 {This session has no record of the workspace this conversation works in. Naming where it was puts it back.} one {This session has no record of the workspace this conversation works in. Naming where it was puts it back.} other {{count} conversations work in a workspace this session has no record of. Naming where it was puts it back for all of them.}}', { count: bound });
      explains.appendChild(lead);
      dialog.appendChild(explains);

      const rows = places();
      if (rows.length) {
        const heading = document.createElement('div');
        heading.className = 'setup-section-title';
        heading.textContent = t('Places with no workspace');
        dialog.appendChild(heading);

        const group = buildPlaceRows({
          rows,
          selection: null,
          label: t('Where this conversation was working'),
          adoptVerb: t('It was here'),
          onSelect: () => {},
          onAdopt: (row) => { void reconnect(row); }
        });
        group.addEventListener('keydown', (event) => handlePlaceRowKey(event, root));
        dialog.appendChild(group);
      } else {
        // Said rather than left as an empty dialog. A tree that has been deleted
        // is not coming back, and the ways out are on the banner behind this.
        const nothing = document.createElement('div');
        nothing.className = 'setup-row-detail';
        nothing.textContent = t('No provider can find a place that has no workspace.');
        dialog.appendChild(nothing);
      }

      if (error) {
        const failure = document.createElement('div');
        failure.className = 'setup-error';
        failure.textContent = error;
        dialog.appendChild(failure);
      }

      const actions = document.createElement('div');
      actions.className = 'setup-actions';
      actions.appendChild(setupButton('btn-secondary workspace-move-cancel', t('Cancel'),
        () => modal.close(undefined)));
      dialog.appendChild(actions);
    };

    render();
    /** @type {HTMLElement|null} */ (root.querySelector('.setup-row'))?.focus();

    // The offers arrive a round trip late, and are the whole content of this
    // dialog: it opens saying what it knows and fills in when the providers
    // answer.
    void probeSetupAdoptions(session, probes.signal).then(render, () => {});
  });
}
