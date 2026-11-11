//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The furniture around a workspace provider's own setup form.
 *
 * A provider renders its fields and answers for them; everything around those
 * fields is the host's — the container, the context they are rendered with, the
 * reporting of every edit, and the line of progress a provision writes while it
 * runs. Two dialogs ask a provider to build something: the one that makes a
 * workspace, and the one that moves a conversation into a place that does not
 * exist yet. This is the one copy of what they share, because two of it is how
 * two views of one flow start looking like two applications.
 *
 * It holds no state. Each caller keeps its own, and passes the values in and
 * takes the edits out.
 * @module components/workspace-setup-form
 */

import workspaceProviderRegistry from '../registries/workspace-provider-registry.js';
import { createBoundOps } from '../../sdk/ops.js';
import { t } from '../../sdk/lib/i18n.js';
import { capabilityLabel } from '../utils/capability-label.js';
// For the side effect of defining <path-input>: a provider builds its fields
// from tag names, so the completing path field has to exist wherever a setup
// form does, and this is the one module both of its hosts go through.
import './path-input.js';

/**
 * A button, made once and wired once.
 * @param {string} className - Its class.
 * @param {string} label - What it says.
 * @param {() => void} onClick - What it does.
 * @returns {HTMLButtonElement} The button.
 */
export function setupButton(className, label, onClick) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}

/**
 * A provider's setup fields, rendered and reporting.
 * @typedef {object} ProviderFields
 * @property {HTMLElement} element - The fields, to put where the caller wants them
 * @property {any} provider - The provider instance, or null when it is not loaded
 * @property {() => import('../../sdk/workspace-provider.js').SetupValue} getValue - What the form says now
 */

/**
 * Render a provider's setup fields.
 *
 * Setup runs where the provision will: against the base workspace, which is the
 * project until there is a reason for it to be anything else. Whatever the
 * caller last recorded goes back in with it, because a form is rebuilt whenever
 * the view around it moves — a cancelled provision, a failure — and re-typing
 * every field is a poor answer to a typo in one of them.
 *
 * `onValue` fires on every edit and nothing redraws in response: the thing that
 * has to react is the caller's commit button, which is why it is handed the
 * value rather than told to go and ask.
 * @param {object} request - What to render, and for whom.
 * @param {any} request.session - The session the workspace would belong to.
 * @param {any} [request.conversation] - The conversation it would be made for.
 * @param {string} request.providerId - Whose form this is.
 * @param {object} [request.values] - What the form last said.
 * @param {string} [request.baseWorkspaceId] - What it would be built relative to.
 * @param {(value: import('../../sdk/workspace-provider.js').SetupValue) => void} [request.onValue] - Told on every edit.
 * @returns {ProviderFields} The fields, and how to ask them anything.
 */
export function buildProviderFields(request) {
  const { session, conversation, providerId, values = {}, baseWorkspaceId = '', onValue } = request;

  const fields = document.createElement('div');
  fields.className = 'setup-fields';

  const provider = workspaceProviderRegistry.createProvider(providerId, session) ?? null;
  if (!provider) {
    fields.textContent = t('This provider is not loaded.');
    return { element: fields, provider: null, getValue: () => ({ valid: false, values: {} }) };
  }

  const advice = buildRecommendations(provider, providerId);
  if (advice) fields.appendChild(advice);

  provider.renderSetup(fields, /** @type {any} */ ({
    session,
    conversation,
    ops: createBoundOps(() => ({ workspaceId: baseWorkspaceId })),
    baseOps: createBoundOps(() => ({ workspaceId: baseWorkspaceId })),
    baseWorkspaceId,
    values,
    signal: new AbortController().signal,
    rollback: { push: () => {} },
    checkpoint: async () => {},
    progress: () => {}
  }));

  const getValue = () => provider.getSetupValue();
  if (onValue) {
    const report = () => onValue(getValue());
    fields.addEventListener('input', report);
    fields.addEventListener('change', report);
    report();
  }

  return { element: fields, provider, getValue };
}

/**
 * What a provider says its places are good for, bad for, and surprising about.
 *
 * It is drawn with the form rather than with the row, because the row is a list
 * of choices and this is the answer to a question only asked once one of them is
 * being considered: which of these do I want, and what will I wish I had known.
 * Providers that say nothing get nothing — the block is absent rather than
 * empty, so a form is not pushed down the panel by a heading with no content.
 * @param {any} provider - The provider whose form this is.
 * @param {string} providerId - Its registry id, which names the extension whose
 *   catalogue translates its manifest's advice.
 * @returns {HTMLElement|null} The block, or null when there is nothing to say.
 */
function buildRecommendations(provider, providerId) {
  const advice = provider?.getManifest?.()?.recommendations;
  const notes = Array.isArray(advice?.notes) ? advice.notes.filter(Boolean) : [];
  if (!advice?.bestFor && !advice?.avoidFor && !notes.length) return null;

  const block = document.createElement('div');
  block.className = 'setup-recommend';

  const line = (/** @type {string} */ className, /** @type {string} */ text) => {
    const element = document.createElement('p');
    element.className = className;
    element.textContent = text;
    block.appendChild(element);
  };

  /**
   * @param {string} text - Manifest text.
   * @returns {string} It, translated in the provider's extension's catalogue.
   */
  const own = (text) => capabilityLabel(text, providerId, workspaceProviderRegistry);

  // A fragment on its own is not a sentence, and the frame is what makes each of
  // them read as advice rather than as a claim about this particular workspace.
  if (advice.bestFor) line('setup-recommend-for', t('Best for {work}.', { work: own(advice.bestFor) }));
  if (advice.avoidFor) line('setup-recommend-against', t('Not for {work}.', { work: own(advice.avoidFor) }));
  for (const note of notes) line('setup-recommend-note', own(String(note)));

  return block;
}

/**
 * The list of places a conversation could work, as both views draw it.
 *
 * The rows themselves come from `setupRows`, which is view-free and knows
 * nothing about which conversation is asking. What is here is how they look and
 * how they answer: the radio group, the roving tabindex, the status a row was
 * probed for, and the adopt row that is an offer rather than a choice.
 * @param {object} request - What to draw.
 * @param {import('../services/workspace-places.js').SetupRow[]} request.rows - The places, in order.
 * @param {string|null} request.selection - The selected row's id, or null for none.
 * @param {string} request.label - What the group is called, for a screen reader.
 * @param {(rowId: string) => any} [request.statusFor] - What a row was last probed to say.
 * @param {(row: any) => void} request.onSelect - A row was chosen.
 * @param {(row: any) => void} [request.onAdopt] - An offer was taken up.
 * @param {string} [request.adoptVerb] - What taking up an offer does here, when
 *   it is not plain adoption: putting a lost workspace back is the same row and
 *   a different act, and the row is what says which.
 * @param {boolean} [request.asRail] - Draw the group as a column of names down
 *   the side of the view, in the shape the settings panel's sidebar has. For the
 *   view that answers the choice in a pane beside the list rather than under the
 *   row: a rail is narrow, so a row is a name and everything about the chosen one
 *   is the pane's to say.
 * @param {string} [request.role] - What the group is. Places are a choice, so it
 *   is a `radiogroup` by default; a band holding nothing but offers is a `group`,
 *   because a radio group in which nothing can be checked is a lie told to a
 *   screen reader.
 * @returns {HTMLElement} The group.
 */
export function buildPlaceRows(request) {
  const {
    rows, selection, label, statusFor, onSelect, onAdopt, adoptVerb, asRail,
    role = 'radiogroup'
  } = request;

  const group = document.createElement('div');
  group.className = 'setup-rows';
  if (asRail) group.classList.add('setup-rows-rail');
  group.setAttribute('role', role);
  group.setAttribute('aria-label', label);

  for (const row of rows) {
    const selected = selection !== null && row.id === selection;
    const element = document.createElement('button');
    element.type = 'button';
    element.className = `setup-row setup-row-${row.kind}`;
    // A place that exists but has no workspace is not one of the choices: it is
    // an offer to make it one, which is why it is a button among the radios
    // rather than another radio.
    element.setAttribute('role', row.kind === 'adopt' ? 'button' : 'radio');
    if (row.kind !== 'adopt') element.setAttribute('aria-checked', String(selected));
    // Roving tabindex: one stop for the whole group, then arrows within it.
    element.tabIndex = selected ? 0 : -1;
    element.dataset.rowId = row.id;
    element.dataset.rowKind = row.kind;

    // The name and what stands beside it: one line of the row, whatever else it
    // grows underneath.
    const head = document.createElement('span');
    head.className = 'setup-row-head';
    element.appendChild(head);

    const name = document.createElement('span');
    name.className = 'setup-row-label';
    name.textContent = row.label;
    head.appendChild(name);

    if (row.kind === 'adopt') {
      const verb = document.createElement('span');
      verb.className = 'setup-row-verb';
      verb.textContent = adoptVerb || t('Adopt');
      head.appendChild(verb);
    }

    // What choosing this does. Written by whoever made the row — the project's
    // line is the core's, a "New…" row's is its provider's — and shown wherever
    // the rows are, because the reader deciding between them is the same reader
    // in both views.
    if (row.meaning) {
      const means = document.createElement('span');
      means.className = 'setup-row-meaning text-truncate';
      means.textContent = row.meaning;
      element.appendChild(means);
    }

    // What a provider says about a workspace it did not have to be asked about:
    // every listed row is probed when the view opens, so a choice is informed
    // rather than a guess.
    const status = row.kind === 'workspace' ? statusFor?.(row.id) : null;

    // The line says where this is, so only something describing the place may
    // go on it: the probe's `detail` when it answered, and otherwise what the
    // row knows by itself, which is the path. Why a probe could not answer
    // arrives separately as `problem` and belongs in the tooltip, where it
    // explains the dimming without being read as a description of anywhere.
    const detail = status?.detail || row.detail;
    if (detail) {
      const note = document.createElement('span');
      // Which of the two this line is, because they are not set alike: a probe
      // answers in a sentence, and the fallback is an address. Monospace is what
      // makes a path scannable and what makes a sentence read as output.
      note.className = 'setup-row-detail text-truncate';
      if (status?.detail) note.classList.add('setup-row-said');
      note.textContent = detail;
      element.appendChild(note);
    }
    if (status?.problem) element.title = status.problem;
    if (status?.available === false) element.classList.add('setup-row-away');

    element.addEventListener('click', () => {
      if (row.kind === 'adopt') {
        onAdopt?.(row);
        return;
      }
      onSelect(row);
    });
    // Each row is wrapped, so that a view which draws a choice as something
    // larger than its row has an element to draw. Where there is no such view
    // the wrapper stands aside, and the rows go on being the group's own
    // children.
    const choice = document.createElement('div');
    choice.className = 'setup-choice';
    choice.appendChild(element);
    group.appendChild(choice);
  }

  // With nothing selected there is no row holding the group's one tab stop, so
  // the first one holds it instead: a group nothing can reach by keyboard is
  // worse than one that starts at the top.
  const first = /** @type {HTMLElement|null} */ (group.querySelector('.setup-row'));
  if (first && !group.querySelector('.setup-row[tabindex="0"]')) first.tabIndex = 0;

  return group;
}

/**
 * Arrow keys move between rows and select as they go; Enter and Space take the
 * row that has focus.
 *
 * `host` is the element that outlives a redraw — the panel, the dialog's root —
 * because selecting rebuilds the group under the key that selected it, so the
 * row to focus afterwards is the one now in that position rather than the node
 * that was there before.
 * @param {KeyboardEvent} event - The key.
 * @param {HTMLElement} host - What holds the group across a rebuild.
 */
export function handlePlaceRowKey(event, host) {
  const rows = /** @type {HTMLElement[]} */ (Array.from(host.querySelectorAll('.setup-row')));
  const current = rows.indexOf(/** @type {HTMLElement} */ (document.activeElement));
  if (current < 0) return;

  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    rows[current]?.click();
    return;
  }
  const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
  if (!step) return;
  event.preventDefault();
  const next = rows[(current + step + rows.length) % rows.length];
  // Arrows select as they go, which is right for a choice and wrong for an
  // offer: walking past "adopt this tree" must not adopt it. Enter still does.
  if (next?.dataset.rowKind === 'adopt') {
    next.focus();
    return;
  }
  next?.click();
  const rebuilt = /** @type {HTMLElement[]} */ (Array.from(host.querySelectorAll('.setup-row')));
  rebuilt[(current + step + rows.length) % rows.length]?.focus();
}

/**
 * What is happening, while it happens: the steps so far, and the Cancel that is
 * available for the whole of it. A block of its own, in the shape the rows it
 * replaced had, because it stands where they stood and for as long as they did.
 *
 * The lines arrive before their step rather than after it, so this is a list of
 * what is being waited on rather than of what is finished.
 * @param {{step: string, detail?: string}[]} lines - The provision so far.
 * @param {() => void} onCancel - Stop it.
 * @returns {HTMLElement} The progress view.
 */
export function buildProvisionProgress(lines, onCancel) {
  const view = document.createElement('div');
  view.className = 'setup-progress';

  const running = document.createElement('div');
  running.className = 'setup-progress-running';
  view.appendChild(running);

  // Beside the steps rather than over them, at the size the spinner is
  // everywhere else. What it reports is the whole block, not any one step: a
  // build is the one thing in a conversation that takes minutes and shows no
  // output while it does, so the part that says "still going" is the part worth
  // seeing from across the room.
  const spinner = document.createElement('juggler-spinner');
  spinner.className = 'setup-progress-spinner';
  running.appendChild(spinner);

  const steps = document.createElement('div');
  steps.className = 'setup-progress-steps';
  running.appendChild(steps);

  let said = '';
  for (const line of lines) {
    const step = document.createElement('div');
    step.className = 'setup-progress-step';
    const what = document.createElement('span');
    what.className = 'setup-progress-what';
    what.textContent = line.step;
    step.appendChild(what);
    // Where each step happens, said when it changes and not again. A provider
    // that names the same place on every line is describing one piece of work,
    // and a column repeating one path down the card is a wall of text saying
    // nothing the line above it did not.
    if (line.detail && line.detail !== said) {
      const detail = document.createElement('span');
      detail.className = 'setup-progress-detail';
      detail.textContent = line.detail;
      step.appendChild(detail);
    }
    said = line.detail || said;
    steps.appendChild(step);
  }

  const actions = document.createElement('div');
  actions.className = 'setup-actions';
  actions.appendChild(setupButton('setup-cancel', t('Cancel'), onCancel));
  view.appendChild(actions);
  return view;
}
