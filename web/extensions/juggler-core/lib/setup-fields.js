//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The fields a workspace provider's setup form is made of: one for a value that
 * is typed, one for a value that is picked from a list.
 *
 * The classes are the panel's, not any provider's: a setup form is the host's
 * furniture, and every provider's ought to be the same form with different
 * fields in it. Shared so that stays true — a second copy of this is how two
 * forms start looking like two different applications.
 * @module lib/setup-fields
 */

/**
 * Where the next form's field ids start, so two forms on screen at once — two
 * new conversations, side by side — do not both call their fields the same
 * thing.
 * @type {number}
 */
let formCount = 0;

/**
 * A run of ids nothing else on the page will use.
 * @returns {number} A number for this form alone.
 */
export function nextFormSequence() {
  return ++formCount;
}

/**
 * One labelled field, and the line under it that says what is wrong with it —
 * or, where a provider derives something from what was typed, what it derived.
 * @param {HTMLElement} container - The section body being filled in.
 * @param {string} id - The field's id, which is what a refused send is pointed at.
 * @param {string} name - What to call it in `data-field`, for anything looking for it.
 * @param {string} label - What the user reads beside it.
 * @param {string} placeholder - What it says while it is empty.
 * @returns {{input: HTMLInputElement, note: HTMLElement}} The field and its note line.
 */
export function field(container, id, name, label, placeholder) {
  const row = document.createElement('div');
  row.className = 'setup-field';

  const caption = document.createElement('label');
  caption.className = 'setup-field-label';
  caption.htmlFor = id;
  caption.textContent = label;

  const input = document.createElement('input');
  input.type = 'text';
  input.id = id;
  input.className = 'setup-field-input field-input field-input-sm';
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.dataset.field = name;

  const note = document.createElement('div');
  note.className = 'setup-field-note';
  note.dataset.fieldNote = name;

  row.append(caption, input, note);
  container.appendChild(row);
  return { input, note };
}

/**
 * One labelled field for a path, completing as it is typed.
 *
 * The same row as {@link field} with the app's own completing path control in
 * it — the one the project picker and the permission rules use — rather than a
 * second implementation of the same dropdown grown inside an extension. It is
 * created by tag name: the element is defined by whoever hosts a setup form, so
 * nothing here has to import it.
 * @param {HTMLElement} container - The section body being filled in.
 * @param {string} id - The field's id, which is what a refused send is pointed at.
 * @param {string} name - What to call it in `data-field`, for anything looking for it.
 * @param {string} label - What the user reads beside it.
 * @param {string} placeholder - What it says while it is empty.
 * @param {{dirsOnly?: boolean, projectRelative?: boolean}} [options] - Which paths it offers.
 * @returns {{input: any, note: HTMLElement}} The field and its note line.
 */
export function pathField(container, id, name, label, placeholder, options = {}) {
  const row = document.createElement('div');
  row.className = 'setup-field';

  const caption = document.createElement('label');
  caption.className = 'setup-field-label';
  caption.textContent = label;

  const input = document.createElement('path-input');
  input.id = id;
  input.setAttribute('placeholder', placeholder);
  input.dataset.field = name;
  if (options.dirsOnly) input.setAttribute('dirs-only', '');
  if (options.projectRelative) input.setAttribute('project-relative', '');

  // A label reaches its control by id, and an id on a custom element names
  // nothing the browser considers a control, so the click is wired by hand
  // rather than left to look like it works.
  caption.addEventListener('click', () => /** @type {any} */ (input).focus());

  const note = document.createElement('div');
  note.className = 'setup-field-note';
  note.dataset.fieldNote = name;

  row.append(caption, input, note);
  container.appendChild(row);
  return { input: /** @type {any} */ (input), note };
}

/**
 * One labelled field whose value is chosen rather than typed, for the setting
 * with a known and short list of answers.
 *
 * It is the same row as {@link field} with a different control in it, and it
 * carries the same note line, because a choice can be as much in need of a line
 * under it as anything typed.
 * @param {HTMLElement} container - The section body being filled in.
 * @param {string} id - The field's id, which is what a refused send is pointed at.
 * @param {string} name - What to call it in `data-field`, for anything looking for it.
 * @param {string} label - What the user reads beside it.
 * @param {{value: string, label: string}[]} options - The answers, in the order to offer them.
 * @returns {{select: HTMLSelectElement, note: HTMLElement}} The field and its note line.
 */
export function choice(container, id, name, label, options) {
  const row = document.createElement('div');
  row.className = 'setup-field';

  const caption = document.createElement('label');
  caption.className = 'setup-field-label';
  caption.htmlFor = id;
  caption.textContent = label;

  const select = document.createElement('select');
  select.id = id;
  select.className = 'setup-field-select field-input field-input-sm';
  select.dataset.field = name;
  for (const option of options) {
    const item = document.createElement('option');
    item.value = option.value;
    item.textContent = option.label;
    select.appendChild(item);
  }

  const note = document.createElement('div');
  note.className = 'setup-field-note';
  note.dataset.fieldNote = name;

  row.append(caption, select, note);
  container.appendChild(row);
  return { select, note };
}

/**
 * Put a line under a field, and say which kind of line it is.
 *
 * The note carries two things that look alike and are not: something the reader
 * has to fix, and something the form worked out from what they typed. Only the
 * first is an error, so that is the one that has to ask for the colour — a
 * provider that says nothing gets the quiet one.
 * @param {HTMLElement} note - The note line, as `field` returned it.
 * @param {string} text - What it says, or '' to clear it.
 * @param {{error?: boolean, path?: string}} [kind] - Whether it is something to fix, and a place to name under it.
 */
export function showNote(note, text, kind = {}) {
  note.replaceChildren();
  note.classList.toggle('setup-field-note-error', Boolean(kind.error));
  if (text) note.appendChild(document.createTextNode(text));
  if (kind.path) {
    const where = document.createElement('div');
    where.className = 'setup-field-note-path';
    where.textContent = kind.path;
    note.appendChild(where);
  }
}
