//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Make a workspace, with no conversation in the question.
 *
 * A workspace is a place, and a place is worth having before there is anything
 * to put in it: the tab strip shows them as boxes, and this is what fills the
 * empty one. The move dialog asks a working conversation where it should work
 * instead, and both of those questions are about a conversation. This one is
 * not. Nothing is bound, nothing is seeded, and what it leaves behind is a
 * workspace with no conversations — which the strip already draws, and which
 * conversations are dropped into, started in, or moved to afterwards.
 *
 * So it lists only the ways to make one. The places that already exist are not
 * choices here — offering them would be offering to do nothing — which leaves
 * one row per provider, and that is few enough to stop being a list. It reads
 * as master and detail instead: the kinds down one side, and what the chosen
 * one means and needs down the other, where the provider's own advice is on
 * screen while its form is being filled in rather than a click away from it.
 * @module components/workspace-create-dialog
 */

import { presentModal } from '../utils/modal-surface.js';
import {
  NEW_ROW_PREFIX,
  setupRows,
  probeSetupAdoptions,
  adoptSetupRow
} from '../services/workspace-places.js';
import { provisionWorkspace, provisionLeftBehind, recordProgress } from '../services/workspace-provisioning.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import {
  setupButton,
  buildProviderFields,
  buildPlaceRows,
  handlePlaceRowKey,
  buildProvisionProgress
} from './workspace-setup-form.js';

/**
 * Input types where Enter means something other than "submit the form".
 * @type {Set<string>}
 */
const NOT_SUBMITTING_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file']);

/**
 * The ways a workspace could be made: one row per provider, then anything found
 * on the disk with no row of its own.
 *
 * The providers come first. This dialog is opened by somebody who has decided
 * to make one, and a found tree is the exception it is worth knowing about
 * rather than the thing they came for — the reverse of the order the rows are
 * offered in elsewhere, where a place that already exists outranks building
 * another.
 * @param {any} session - The session whose providers and finds these are.
 * @returns {any[]} The rows, providers first.
 */
export function workspaceCreatePlaces(session) {
  const rows = setupRows(session);
  return [
    ...rows.filter((row) => row.kind === 'new'),
    ...rows.filter((row) => row.kind === 'adopt')
  ];
}

/**
 * Ask what kind of workspace to make, and make it.
 * There is no undo in what it hands back. Making a workspace selects it, which
 * opens the panel for it, which carries the provider's own ways of being
 * finished with a tree — including discarding it, in the provider's words. A
 * second, briefer way to say the same thing would be a transient button
 * duplicating a permanent one that is already on screen.
 * @param {any} session - The session it would belong to.
 * @returns {Promise<{created: boolean, workspaceId?: string}>} What was made.
 */
export function openWorkspaceCreate(session) {
  return new Promise((resolve) => {
    const modal = presentModal({
      className: 'workspace-create-overlay',
      dismissSelectors: ['.workspace-create-backdrop', '.workspace-create-close', '.workspace-create-cancel'],
      onClose: (result) => {
        probes.abort();
        // Escape and the backdrop end a build the same way its own Cancel does:
        // a tree finished after the question that asked for it was dismissed is
        // a tree nobody asked for.
        stop?.abort();
        resolve(result ?? { created: false });
      }
    });
    const root = modal.root;

    /** Speculative, and abandoned with the dialog. */
    const probes = new AbortController();

    /** @type {string|null} Which kind is chosen. */
    let selection = null;
    /** @type {string} Why the last attempt did not happen. */
    let error = '';
    /** @type {object} What the selected provider's form last said. */
    let values = {};
    /** @type {boolean} Whether that form may be submitted. */
    let valid = false;
    /** @type {boolean} Whether a workspace is being built right now. */
    let building = false;
    /** @type {{step: string, detail?: string}[]} What that build has announced. */
    let progress = [];
    /** @type {AbortController|null} How to stop it, for as long as it runs. */
    let stop = null;

    /**
     * The ways to make one. See {@link workspaceCreatePlaces}.
     * @returns {any[]} The rows.
     */
    const places = () => workspaceCreatePlaces(session);

    // The first kind is chosen on the way in. The move dialog deliberately opens
    // on nothing, because there answering nothing has to move nothing; here the
    // selection only says which form is on screen, and nothing is built until
    // Create is pressed. An empty half of a two-part dialog teaches nobody what
    // the two parts are for.
    const opening = places().find((row) => row.kind === 'new');
    if (opening) selection = opening.id;

    /**
     * The provider the selection names, or '' when it names none.
     * @returns {string} A provider id, or ''.
     */
    const selectedProviderId = () => (selection ?? '').startsWith(NEW_ROW_PREFIX)
      ? /** @type {string} */ (selection).slice(NEW_ROW_PREFIX.length)
      : '';

    /**
     * Build what the chosen kind describes, and hand the caller the result.
     *
     * `provisionWorkspace` owns everything difficult — the row registered before
     * the first command runs, each step's inverse recorded before the step, the
     * unwinding of a failure or a cancel. What is deliberately absent is any
     * mention of a conversation: nothing is bound, nothing is seeded, and the
     * workspace stands on its own the moment this returns.
     * @returns {Promise<void>} When it is built, or has failed to be.
     */
    const create = async () => {
      const providerId = selectedProviderId();
      if (!providerId || building) return;

      // Taken before anything is drawn: a form rebuilt by the redraw below
      // reports itself empty, and these are the values that were filled in.
      const chosen = values;
      const controller = new AbortController();
      building = true;
      stop = controller;
      progress = [];
      error = '';
      render();
      try {
        const outcome = await provisionWorkspace({
          session,
          providerId,
          values: chosen,
          signal: controller.signal,
          onProgress: (step, detail) => {
            recordProgress(progress, step, detail);
            render();
          }
        });
        building = false;
        stop = null;

        // Onto this window's table by hand. The row is the server's the moment
        // it is registered, but a client learns of it through the
        // `workspaces-changed` broadcast — and what opened this dialog is about
        // to draw a box for it. Waiting for the announcement of something we
        // just built would leave the strip empty for the round trip. The
        // broadcast will bring it again, harmlessly.
        if (session && !session.workspaces?.some?.((/** @type {any} */ row) => row.id === outcome.workspace.id)) {
          session.workspaces = [...(session.workspaces ?? []), outcome.workspace];
        }

        modal.close({ created: true, workspaceId: outcome.workspace.id });
      } catch (failure) {
        building = false;
        stop = null;
        // Cancelled and failed are the same unwinding and different things to
        // say. A cancel was the user's own instruction and needs no explanation;
        // a failure is the only account they will get of why there is no new
        // workspace, so it is kept and shown against the form they can correct.
        values = chosen;
        // Except for what the unwinding could not take back, which is said
        // whichever of the two it was: a cancel that left a tree on the disk is
        // still a tree on the disk.
        const leftBehind = provisionLeftBehind(failure);
        const said = controller.signal.aborted ? '' : extractErrorMessage(failure);
        error = [said, leftBehind].filter(Boolean).join(' ');
        render();
      }
    };

    /**
     * Take up an offer: register something that is already on the disk.
     *
     * It finishes the dialog rather than selecting the row, because the row
     * carries its own verb and adopting is the whole of what this dialog was
     * opened to do. A found tree that needed Create pressed afterwards would be
     * asking twice for one decision.
     * @param {any} row - The adopt row that was clicked.
     * @returns {Promise<void>} When it is registered, or has failed to be.
     */
    const adopt = async (row) => {
      try {
        const adopted = await adoptSetupRow(session, row.id);
        if (modal.closed) return;
        if (adopted?.id) {
          modal.close({ created: true, workspaceId: adopted.id });
          return;
        }
        error = `Couldn't adopt that workspace.`;
        render();
      } catch (failure) {
        if (modal.closed) return;
        error = extractErrorMessage(failure);
        render();
      }
    };

    /**
     * The chosen kind, said at the top of its own half: what it is called, and
     * what one of them is. The name is repeated from the rail on purpose — the
     * detail pane has to stand as the answer to "what am I filling in", which a
     * form with no heading does not.
     * @param {any} row - The selected row.
     * @returns {HTMLElement} The heading block.
     */
    const buildDetailHead = (row) => {
      const head = document.createElement('div');
      head.className = 'workspace-create-detail-head';
      const name = document.createElement('h3');
      name.className = 'workspace-create-detail-title';
      name.textContent = row.label;
      head.appendChild(name);
      if (row.meaning) {
        const means = document.createElement('p');
        means.className = 'workspace-create-detail-meaning';
        means.textContent = row.meaning;
        head.appendChild(means);
      }
      return head;
    };

    // The chrome every other dialog in the app wears: the shared scrim, and a
    // panel whose surface, corner and shadow come from the one popup-surface
    // rule. A modal that paints its own card is a modal that drifts from the
    // rest of them one token at a time.
    //
    // Built once, outside `render`: both animate in when they are inserted, so
    // a redraw that rebuilt them would play the entrance again on every choice
    // in the rail. A redraw replaces what is inside the panel, never the panel.
    const backdrop = document.createElement('modal-backdrop');
    backdrop.className = 'workspace-create-backdrop';
    root.appendChild(backdrop);

    const dialog = document.createElement('modal-panel');
    dialog.className = 'workspace-create-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'New workspace');
    root.appendChild(dialog);

    /** Draw the dialog as it stands. */
    const render = () => {
      if (modal.closed) return;
      dialog.replaceChildren();

      const header = document.createElement('div');
      header.className = 'workspace-create-header';
      const title = document.createElement('h2');
      title.className = 'workspace-create-title';
      title.textContent = 'New workspace';
      header.appendChild(title);
      const close = setupButton('close-button workspace-create-close', '', () => modal.close(undefined));
      close.setAttribute('aria-label', 'Close');
      close.title = 'Close';
      const cross = document.createElement('span');
      cross.className = 'icon-close';
      close.appendChild(cross);
      header.appendChild(close);
      dialog.appendChild(header);

      // One sentence saying what the thing being made is. It is here because
      // this dialog is where the word is met: the strip shows workspaces as
      // boxes and never has room to say what a box is, so the place that offers
      // to make one carries the definition.
      const lead = document.createElement('p');
      lead.className = 'workspace-create-lead';
      lead.textContent = 'Workspace plugins provide different environments for the LLM to work inside.';
      dialog.appendChild(lead);

      const body = document.createElement('div');
      body.className = 'workspace-create-body';
      dialog.appendChild(body);

      // While something is being built there is nothing to choose: the choice
      // has been made, and what is worth showing is what it is waiting on and
      // the way out of it. One Cancel, inside the progress, so there are never
      // two of them meaning different things.
      if (building) {
        // And nothing to split the body into either, so it stops being two
        // columns: the progress stood in the rail's fourteen rems with the
        // other half of the dialog empty beside it.
        body.classList.add('workspace-create-building');
        // No footer: its Cancel dismisses the whole dialog and the progress's
        // own stops the build and leaves the form to be corrected. Two buttons
        // reading Cancel, a few inches apart, doing different things.
        body.appendChild(buildProvisionProgress(progress, () => stop?.abort()));
        return;
      }

      // The kinds, down one side. A rail rather than blocks: the block form is
      // for a view where reading the rows is the whole question, and here the
      // question is answered in the pane beside them, which says everything a
      // block would have and has room for the form as well.
      const rail = document.createElement('div');
      rail.className = 'workspace-create-rail';
      body.appendChild(rail);

      /**
       * One band of the rail: rows that are the same kind of thing.
       *
       * Unheaded. A column of three names reads as a column of three names
       * without a caption saying so, and the bands are told apart by the line
       * drawn between them and by what the rows themselves say. `label` is the
       * same information for a screen reader, which cannot see either.
       * @param {object} request - The band.
       * @param {string} request.label - What these rows are, for a screen reader.
       * @param {any[]} request.rows - The rows.
       * @param {string} [request.role] - What the group is, where it is not a choice.
       */
      const band = ({ label, rows, role }) => {
        if (!rows.length) return;
        const group = buildPlaceRows({
          rows,
          selection,
          label,
          ...(role ? { role } : {}),
          asRail: true,
          onSelect: (row) => {
            selection = row.id;
            values = {};
            valid = false;
            error = '';
            render();
          },
          onAdopt: (row) => { void adopt(row); }
        });
        // The arrows walk the whole rail rather than each band of it: the root
        // is what they are given, and it outlives the redraw a selection causes.
        group.addEventListener('keydown', (event) => handlePlaceRowKey(event, root));
        rail.appendChild(group);
      };

      const offered = places();

      // The kinds, stripped of what they mean. The pane beside the rail says
      // that in full and says it about the one the reader has chosen; printed
      // in the rail as well it is a sentence shown as its first four words,
      // under a name that had to wrap to three lines to make room for it.
      band({
        label: 'What kind of workspace to make',
        rows: offered.filter((row) => row.kind === 'new').map((row) => ({ ...row, meaning: undefined }))
      });

      // And what is already there, which is not a way to build anything: a tree
      // that exists is taken up on one click rather than chosen and then
      // created. Nothing in this band can be the selection, so it is a group of
      // offers rather than a second set of radios with nothing checked in it.
      band({
        label: 'Trees found with no workspace',
        role: 'group',
        rows: offered.filter((row) => row.kind === 'adopt')
      });

      // What the chosen kind is, and what it needs, down the other.
      const detail = document.createElement('div');
      detail.className = 'workspace-create-detail';
      body.appendChild(detail);

      const chosen = places().find((row) => row.id === selection);
      const providerId = selectedProviderId();
      if (chosen && providerId) {
        detail.appendChild(buildDetailHead(chosen));
        // The provider's fields, which carry its own Best for / Not for at the
        // top of them. On screen for the whole time the form is being filled in,
        // which is the point of splitting the dialog in two: the advice and the
        // fields it is advice about are the same glance.
        const fields = buildProviderFields({
          session,
          providerId,
          values,
          onValue: (value) => {
            values = value?.values ?? {};
            valid = value?.valid !== false;
            // Nothing redraws for a keystroke, so the one thing that has to
            // react is updated in place.
            const button = /** @type {HTMLButtonElement|null} */ (root.querySelector('.workspace-create-commit'));
            if (button) button.disabled = !valid;
          }
        });
        detail.appendChild(fields.element);
      } else if (!places().length) {
        // No providers registered at all. Said rather than left blank: an empty
        // dialog reads as one that is still loading.
        const none = document.createElement('p');
        none.className = 'workspace-create-empty';
        none.textContent = 'Nothing can make one.';
        detail.appendChild(none);
      }

      if (error) {
        const failure = document.createElement('div');
        failure.className = 'setup-error';
        failure.textContent = error;
        detail.appendChild(failure);
      }

      dialog.appendChild(buildFooter());
    };

    /**
     * Cancel, and the one button that does the thing. Drawn only while there is
     * a question on screen: a build carries its own way out, inside the progress.
     * @returns {HTMLElement} The footer.
     */
    const buildFooter = () => {
      const actions = document.createElement('div');
      actions.className = 'workspace-create-footer';
      actions.appendChild(setupButton('btn-secondary workspace-create-cancel', 'Cancel',
        () => modal.close(undefined)));
      const make = setupButton('btn-primary workspace-create-commit', 'Create',
        () => { void create(); });
      make.disabled = !selectedProviderId() || !valid;
      actions.appendChild(make);
      return actions;
    };

    // Enter in one of the form's fields presses Create, as it would in any form,
    // once Create can be pressed. On the root, which outlives every redraw. A
    // field that uses Enter for itself — a path field taking a completion from
    // its menu — has already claimed the key by the time it gets here.
    root.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing) return;
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
      const field = /** @type {any} */ (event.target);
      if (field?.tagName !== 'INPUT' || NOT_SUBMITTING_INPUTS.has(field.type)) return;
      if (!field.closest('.workspace-create-detail')) return;
      const button = /** @type {HTMLButtonElement|null} */ (root.querySelector('.workspace-create-commit'));
      if (!button || button.disabled) return;
      event.preventDefault();
      void create();
    });

    render();
    // The kind is chosen on the way in, so the keyboard starts in its form's
    // first field, ready to type — a group's name, typically. A kind with nothing
    // to type starts it on the chosen row instead, where the arrows walk the rail.
    const first = root.querySelector('.workspace-create-detail input:not([type="hidden"]):not(:disabled)')
      || root.querySelector('.setup-row[aria-checked="true"]') || root.querySelector('.setup-row');
    /** @type {HTMLElement|null} */ (first)?.focus();

    /**
     * Redraw for something that arrived on its own, unless a form is open.
     *
     * A form being filled in outranks the rail behind it: rebuilding the dialog
     * around it would take the focus out of the field mid-word and throw away
     * what had been typed. A row that arrived meanwhile appears when the
     * selection next changes, which is a redraw in its own right.
     */
    const renderIfIdle = () => {
      if (root.querySelector('.setup-fields')) return;
      render();
    };

    // The only probe worth running here: what is on the disk with no row of its
    // own. Statuses are not — nothing in this dialog lists a workspace that
    // already exists, so there is nothing to ask how it is doing.
    void probeSetupAdoptions(session, probes.signal).then(renderIfIdle, () => {});
  });
}
