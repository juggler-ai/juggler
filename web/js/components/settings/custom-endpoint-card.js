//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   https://juggler.studio
//
//   This program is free software: you can redistribute it and/or modify it under the terms of
//   the GNU Affero General Public License as published by the Free Software Foundation, either
//   version 3 of the License, or (at your option) any later version. This program is distributed
//   in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
//   warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the LICENSE file or
//   <https://www.gnu.org/licenses/agpl-3.0.html> for full terms.

/**
 * One card per custom endpoint, for the "Your own endpoints" section of the
 * Providers tab.
 *
 * A custom endpoint is a provider like any other — it is registered as one, and
 * the model picker offers it beside the built-ins — so its card is the same
 * `provider-field` grid, with the same key row, model list and token-limit
 * fields. What it adds is the handful of facts only it has: the base URL, the
 * request headers, the label shown in the picker, and a way to remove it.
 *
 * The card is drawn from the endpoint definitions rather than from the published
 * provider list, because the endpoint most in need of a card is the one that is
 * not in that list: switched off, or with a base URL that no longer parses.
 * Where the provider IS registered, its published status is what the card shows
 * for health — the model list either loaded from the endpoint or it did not.
 * @module components/settings/custom-endpoint-card
 */

import {
  customProvidersSave,
  customProvidersRemove,
  customProvidersSetKey,
} from '../../services/ops-api.js';
import providersCache from '../../services/providers-cache.js';
import { extractErrorMessage } from '../../../sdk/lib/error-utils.js';
import { showConfirm } from '../modal-dialog.js';
import { CHECK_SVG } from '../../utils/icons.js';

/**
 * The id rule, mirroring the server's. An id becomes a provider id, a DOM
 * element id and part of a credential key, so it is lowercase, starts with a
 * letter, and separates words with single hyphens.
 */
const ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const MAX_ID_LENGTH = 40;

/** Shown when a name yields nothing usable as an id at all. */
const FALLBACK_ID = 'endpoint';

/**
 * Derive an endpoint's permanent id from the name the user typed.
 *
 * The id is never asked for. It is written into conversations, into the default
 * and cheap model stores and into the hidden-model and token-limit settings, so
 * it can never change — and a field that can never be corrected is a poor thing
 * to make someone fill in. The name they can change is asked for instead, and
 * this turns it into a key: a name that yields no usable id (one that is all
 * punctuation, or starts with a digit) falls back to a plain one, and a clash
 * with an id already in use takes the next free number.
 * @param {string} name - The display name typed on the add form.
 * @param {string[]} [takenIds] - Ids already configured.
 * @returns {string} An id matching the server's rule and free to use.
 */
export function deriveEndpointId(name, takenIds = []) {
  const slug = (name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ID_LENGTH)
    .replace(/-+$/, '');
  const base = ID_PATTERN.test(slug) ? slug : FALLBACK_ID;
  if (!takenIds.includes(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, MAX_ID_LENGTH - suffix.length).replace(/-+$/, '') + suffix;
    if (!takenIds.includes(candidate)) return candidate;
  }
}

/**
 * A labelled field in a provider card's control column, with a status note that
 * floats on the label line so the row height never moves.
 * @param {string} label - Visible label.
 * @returns {{element: HTMLElement, body: HTMLElement, setStatus: (text: string, kind?: 'ok'|'error'|'pending') => void}}
 *   The field, the element to put controls in, and its status setter.
 */
function subfield(label) {
  const element = document.createElement('div');
  element.className = 'provider-subfield';

  const labelEl = document.createElement('label');
  labelEl.className = 'provider-subfield-label';
  labelEl.textContent = label;
  element.appendChild(labelEl);

  const status = document.createElement('div');
  status.className = 'provider-subfield-status';
  element.appendChild(status);

  const body = document.createElement('div');
  element.appendChild(body);

  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let statusTimer;
  /**
   * @param {string} text - What to say, or '' to say nothing.
   * @param {'ok'|'error'|'pending'} [kind] - How to colour it.
   */
  const setStatus = (text, kind) => {
    clearTimeout(statusTimer);
    status.textContent = text;
    if (kind) status.dataset.kind = kind; else delete status.dataset.kind;
    // The saved value stays on screen, so a confirmation is a light touch that
    // fades. An error stays until the next attempt replaces it.
    if (kind === 'ok') {
      statusTimer = setTimeout(() => {
        status.textContent = '';
        delete status.dataset.kind;
      }, 2000);
    }
  };

  return { element, body, setStatus };
}

/**
 * A text input in the shared bordered wrapper the provider key fields use, so
 * every input in the card carries the same border and focus ring.
 * @param {{value?: string, placeholder?: string, ariaLabel: string, className?: string}} opts - Input options.
 * @returns {{wrapper: HTMLElement, input: HTMLInputElement}} The wrapper to append and the input inside it.
 */
function wrappedInput({ value, placeholder, ariaLabel, className }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'provider-input-wrapper';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = `settings-value-input ${className || ''}`.trim();
  input.value = value || '';
  if (placeholder) input.placeholder = placeholder;
  input.setAttribute('aria-label', ariaLabel);
  input.autocomplete = 'off';
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.spellcheck = false;
  wrapper.appendChild(input);
  return { wrapper, input };
}

/**
 * One card for one endpoint.
 *
 * A save changes the card and nothing else. Every part that a save can alter —
 * the heading, the reason it isn't serving, the key row, the model list — is
 * built once and updated in place, so the settings pane never has DOM pulled out
 * from under whoever is reading it. That is not a nicety: rebuilding the section
 * around a control someone has just clicked moves everything below it, and if
 * the pane is scrolled, the browser has nowhere to keep their place.
 * @param {import('../../services/ops-api.js').CustomEndpoint} endpoint - The endpoint to draw.
 * @param {object} ctx - What the card needs from the tab around it.
 * @param {(providerId: string) => any} ctx.providerFor - The published provider status, if it has one.
 * @param {(provider: any) => HTMLElement|null} ctx.modelRow - Builds the shared model list.
 * @param {(endpoints: any[]) => void} ctx.applyEndpoints - Hand back the list an op answered with.
 * @param {() => Promise<void>} ctx.refreshProviders - Re-read config and providers without touching the DOM.
 * @param {(endpoints: any[]) => void} ctx.onRemoved - This endpoint is gone.
 * @param {(message: string) => void} ctx.reportError - Report a failure with nowhere of its own to appear.
 * @returns {{element: HTMLElement, refresh: (opts?: {remodel?: boolean}) => void}} The card and its updater.
 */
export function buildEndpointCard(endpoint, ctx) {
  const card = document.createElement('div');
  card.className = 'settings-group provider-field custom-endpoint';
  card.dataset.endpointId = endpoint.id;

  const info = document.createElement('div');
  info.className = 'provider-info';

  const control = document.createElement('div');
  control.className = 'provider-control';

  const name = document.createElement('div');
  name.className = 'provider-name';
  info.appendChild(name);

  // The one thing about an endpoint that cannot be changed, shown as text
  // because it isn't editable. Everything that names this endpoint — every
  // conversation, the default and cheap model, the models hidden and the limits
  // corrected — names this.
  const providerId = document.createElement('div');
  providerId.className = 'provider-description';
  const idCode = document.createElement('code');
  idCode.className = 'custom-endpoint-id';
  idCode.textContent = endpoint.providerId;
  idCode.title = 'The provider id. Permanent: conversations and settings refer to it.';
  providerId.appendChild(idCode);
  info.appendChild(providerId);

  // Why this endpoint isn't serving. Either it never registered (the definition
  // itself is the problem) or it registered and the provider list has something
  // to report — a model list that wouldn't load is the endpoint failing to
  // answer, which is the only health signal an arbitrary endpoint offers. Always
  // present and empty when there is nothing wrong, so saying so later doesn't
  // mean rebuilding the column.
  const problem = document.createElement('div');
  problem.className = 'custom-endpoint-problem';
  info.appendChild(problem);

  const toggle = buildEnableToggle(endpoint, (patch, setStatus) => saveFields(patch, setStatus));
  const key = buildKeyField(endpoint, ctx);
  // Holds the shared model list. Kept as its own slot so the list survives every
  // save that has no bearing on it — an open list stays open, and stays where it
  // was on screen.
  const models = document.createElement('div');
  models.className = 'custom-endpoint-models';

  /**
   * Bring the card into line with the endpoint as the server now holds it.
   * @param {{remodel?: boolean}} [opts] - remodel rebuilds the model list, for a
   *   change that alters what the endpoint serves.
   */
  const refresh = ({ remodel = false } = {}) => {
    name.textContent = endpoint.displayName || endpoint.id;
    toggle.setChecked(endpoint.enabled);
    key.refresh();

    const provider = endpoint.registered ? ctx.providerFor(endpoint.providerId) : null;
    problem.textContent = endpoint.enabled
      ? (endpoint.error || (provider && !provider.available ? (provider.authHint || '') : ''))
      : '';

    if (!provider) {
      models.replaceChildren();
      return;
    }
    if (remodel || !models.firstChild) {
      const row = ctx.modelRow(provider);
      models.replaceChildren(...(row ? [row] : []));
    }
  };

  /**
   * Write one or more fields of this endpoint, reporting into a field's status
   * line, then bring the card into line with what the server actually stored.
   * @param {object} patch - The fields to change.
   * @param {(text: string, kind?: 'ok'|'error'|'pending') => void} setStatus - Where to report.
   * @param {boolean} [remodel] - The change alters what the endpoint serves, so
   *   the model list under it belongs to the old one.
   * @returns {Promise<boolean>} Whether the write landed.
   */
  const saveFields = async (patch, setStatus, remodel = false) => {
    setStatus('Saving…', 'pending');
    try {
      const { endpoints } = await customProvidersSave({ id: endpoint.id, ...patch });
      // The endpoint's models reach the picker without a restart, so the caches
      // every model menu reads have to catch up here.
      await providersCache.refresh();
      ctx.applyEndpoints(endpoints);
      Object.assign(endpoint, (endpoints || []).find((/** @type {any} */ e) => e.id === endpoint.id) || {});
      // A change to what the endpoint serves needs the provider list re-read
      // before the models can be drawn from it. No DOM is rebuilt by that read.
      if (remodel) await ctx.refreshProviders();
      setStatus('Saved', 'ok');
      refresh({ remodel });
      return true;
    } catch (error) {
      setStatus(`Couldn’t save. ${extractErrorMessage(error)}`, 'error');
      return false;
    }
  };

  control.appendChild(toggle.element);
  control.appendChild(buildNameField(endpoint, saveFields));
  control.appendChild(buildURLField(endpoint, saveFields));
  control.appendChild(buildHeadersField(endpoint, saveFields));
  control.appendChild(key.element);
  control.appendChild(models);
  control.appendChild(buildRemoveRow(endpoint, ctx));

  card.appendChild(info);
  card.appendChild(control);
  refresh();
  return { element: card, refresh };
}

/**
 * The switch that registers and unregisters the endpoint. Switching one off
 * keeps its definition, its hidden models and its corrected limits, which is
 * what makes it different from removing it.
 * @param {any} endpoint - The endpoint.
 * @param {(patch: object, setStatus: any) => Promise<boolean>} saveFields - The writer.
 * @returns {{element: HTMLElement, setChecked: (on: boolean) => void}} The row and its state setter.
 */
function buildEnableToggle(endpoint, saveFields) {
  const wrapper = document.createElement('div');
  wrapper.className = 'provider-toggle-wrapper';

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.id = `${endpoint.providerId}-toggle`;
  toggle.className = 'provider-toggle custom-endpoint-toggle';
  toggle.checked = endpoint.enabled;

  const label = document.createElement('label');
  label.setAttribute('for', toggle.id);
  label.className = 'toggle-switch';

  const note = document.createElement('span');
  note.className = 'custom-endpoint-toggle-note';

  toggle.addEventListener('change', async () => {
    const wanted = toggle.checked;
    /**
     * @param {string} text - What to say.
     * @param {string} [kind] - Only an error is worth saying here.
     */
    const setStatus = (text, kind) => { note.textContent = kind === 'error' ? text : ''; };
    // A switch that fails has to go back: the endpoint is in whichever state the
    // server kept, and a switch showing the other one is a lie about the picker.
    if (!await saveFields({ enabled: wanted }, setStatus)) toggle.checked = !wanted;
  });

  wrapper.appendChild(toggle);
  wrapper.appendChild(label);
  wrapper.appendChild(note);
  return {
    element: wrapper,
    setChecked: (/** @type {boolean} */ on) => { toggle.checked = on; },
  };
}

/**
 * The label shown in the model picker. Editing it renames nothing else — the
 * provider id under the heading is what everything stored refers to.
 * @param {any} endpoint - The endpoint.
 * @param {(patch: object, setStatus: any, remodel?: boolean) => Promise<boolean>} saveFields - The writer.
 * @returns {HTMLElement} The field.
 */
function buildNameField(endpoint, saveFields) {
  const field = subfield('Name');
  const { wrapper, input } = wrappedInput({
    value: endpoint.displayName || '',
    placeholder: endpoint.id,
    ariaLabel: 'Name shown in the model picker',
    className: 'custom-endpoint-name-input',
  });
  field.body.appendChild(wrapper);

  const save = async () => {
    const value = input.value.trim();
    if (value === (endpoint.displayName || '')) return;
    // The card's own heading follows from the refresh the save ends with.
    await saveFields({ displayName: value }, field.setStatus);
  };
  onCommit(input, save);
  return field.element;
}

/**
 * The endpoint itself. Models come from whatever this URL's own model list
 * returns, so it is the field that decides whether the endpoint works at all.
 * @param {any} endpoint - The endpoint.
 * @param {(patch: object, setStatus: any, redraw?: boolean) => Promise<boolean>} saveFields - The writer.
 * @returns {HTMLElement} The field.
 */
function buildURLField(endpoint, saveFields) {
  const field = subfield('Base URL');
  const { wrapper, input } = wrappedInput({
    value: endpoint.url || '',
    placeholder: 'https://gateway.example.com/v1',
    ariaLabel: 'Base URL',
    className: 'custom-endpoint-url-input',
  });
  field.body.appendChild(wrapper);

  const save = async () => {
    const value = input.value.trim();
    if (value === (endpoint.url || '')) return;
    // A URL the endpoint accepts changes what it can serve, so the model list
    // under it — and only that — is drawn again.
    await saveFields({ url: value }, field.setStatus, true);
  };
  onCommit(input, save);
  return field.element;
}

/**
 * Extra headers sent with every request — a gateway's tenant or routing header.
 * Rows are shown rather than hidden behind a disclosure: most endpoints have
 * none, so the field costs one button, and an endpoint that has them is one
 * where they matter.
 * @param {any} endpoint - The endpoint.
 * @param {(patch: object, setStatus: any, redraw?: boolean) => Promise<boolean>} saveFields - The writer.
 * @returns {HTMLElement} The field.
 */
function buildHeadersField(endpoint, saveFields) {
  const field = subfield('Request headers');
  const rows = document.createElement('div');
  rows.className = 'custom-endpoint-headers';
  field.body.appendChild(rows);

  const save = async () => {
    /** @type {Record<string, string>} */
    const headers = {};
    for (const row of Array.from(rows.querySelectorAll('.custom-endpoint-header-row'))) {
      const key = /** @type {HTMLInputElement} */ (row.querySelector('.custom-endpoint-header-name')).value.trim();
      const value = /** @type {HTMLInputElement} */ (row.querySelector('.custom-endpoint-header-value')).value;
      if (!key) {
        if (value.trim()) {
          field.setStatus('Every header needs a name.', 'error');
          return;
        }
        continue;
      }
      headers[key] = value;
    }
    if (JSON.stringify(headers) === JSON.stringify(endpoint.headers || {})) return;
    if (await saveFields({ headers }, field.setStatus)) endpoint.headers = headers;
  };

  /**
   * @param {string} key - Header name.
   * @param {string} value - Header value.
   * @returns {HTMLElement} The row, so a freshly added one can be focused.
   */
  const addRow = (key, value) => {
    const row = document.createElement('div');
    row.className = 'custom-endpoint-header-row';

    const name = wrappedInput({
      value: key, placeholder: 'X-Tenant', ariaLabel: 'Header name', className: 'custom-endpoint-header-name',
    });
    const val = wrappedInput({
      value, placeholder: 'value', ariaLabel: `Value for header ${key || 'being added'}`, className: 'custom-endpoint-header-value',
    });

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'settings-btn small custom-endpoint-header-remove';
    drop.textContent = '\u00d7';
    drop.setAttribute('aria-label', `Remove header ${key || 'being added'}`);
    drop.addEventListener('click', () => {
      row.remove();
      save();
    });

    onCommit(name.input, save);
    onCommit(val.input, save);

    row.appendChild(name.wrapper);
    row.appendChild(val.wrapper);
    row.appendChild(drop);
    rows.appendChild(row);
    return row;
  };

  for (const [key, value] of Object.entries(endpoint.headers || {})) addRow(key, String(value));

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'settings-btn small custom-endpoint-header-add';
  add.textContent = 'Add header';
  add.addEventListener('click', () => {
    const row = addRow('', '');
    /** @type {HTMLInputElement} */ (row.querySelector('.custom-endpoint-header-name')).focus();
  });
  field.body.appendChild(add);

  return field.element;
}

/**
 * The API key, in the same row every other provider's key gets: the value, the
 * "key is active" badge over it once one is stored, Save and Delete, and a note
 * when the key is coming from the environment instead.
 *
 * It writes through the endpoint's own operation rather than the shared config
 * route, because that route finds a provider's credential slot in the registry —
 * and an endpoint the user has switched off is not in it. The slot is derived
 * from the endpoint id server-side, so a key can be set whatever state it is in.
 * @param {any} endpoint - The endpoint.
 * @param {any} ctx - The card context (for handing the answer back to the tab).
 * @returns {{element: HTMLElement, refresh: () => void}} The field and its updater.
 */
function buildKeyField(endpoint, ctx) {
  const field = subfield('API key');
  const fromEnv = endpoint.keySource === 'env';

  const wrapper = document.createElement('div');
  wrapper.className = 'provider-input-wrapper';

  const input = document.createElement('input');
  input.type = 'text';
  // No settings-value-input: that class marks the non-secret values the panel
  // keeps across a close, and a typed key is neither.
  input.className = 'custom-endpoint-key-input';
  input.setAttribute('aria-label', 'API key');
  input.autocomplete = 'off';
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.spellcheck = false;
  input.disabled = fromEnv;
  input.placeholder = fromEnv
    ? `using $${endpoint.envVarName}`
    : (endpoint.hasKey ? '' : 'optional — some endpoints need none');

  const badge = document.createElement('span');
  badge.className = 'provider-active-badge';
  badge.innerHTML = `${CHECK_SVG}<span>key is active</span>`;
  badge.style.display = endpoint.hasKey && !fromEnv ? 'inline-flex' : 'none';

  const buttons = document.createElement('div');
  buttons.className = 'provider-buttons';

  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'settings-btn primary small custom-endpoint-key-save';
  saveButton.textContent = 'Save';
  saveButton.style.display = 'none';

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'settings-btn danger small custom-endpoint-key-delete';
  deleteButton.textContent = 'Delete';
  deleteButton.style.display = endpoint.keySource === 'credentials' ? 'block' : 'none';

  /**
   * Bring the row into line with what is stored: the badge over an empty field,
   * Save while something is typed, Delete only for a key this row can delete.
   */
  const refresh = () => {
    const typed = input.value.trim() !== '';
    saveButton.style.display = typed && !fromEnv ? 'block' : 'none';
    deleteButton.style.display = endpoint.keySource === 'credentials' ? 'block' : 'none';
    badge.style.display = endpoint.hasKey && !fromEnv && !typed ? 'inline-flex' : 'none';
    input.placeholder = fromEnv
      ? `using $${endpoint.envVarName}`
      : (endpoint.hasKey ? '' : 'optional — some endpoints need none');
  };

  input.addEventListener('input', refresh);

  /**
   * @param {string} apiKey - The key to store, or '' to clear the stored one.
   * @returns {Promise<void>} Completes when the write has been reported.
   */
  const writeKey = async (apiKey) => {
    field.setStatus('Saving…', 'pending');
    try {
      const { endpoints } = await customProvidersSetKey({ id: endpoint.id, apiKey });
      await providersCache.refresh();
      field.setStatus(apiKey ? 'Saved' : 'Deleted', 'ok');
      input.value = '';
      const stored = (endpoints || []).find((/** @type {any} */ e) => e.id === endpoint.id);
      if (stored) {
        endpoint.hasKey = stored.hasKey;
        endpoint.keySource = stored.keySource;
      }
      refresh();
      ctx.applyEndpoints(endpoints);
    } catch (error) {
      field.setStatus(`Couldn’t save the key. ${extractErrorMessage(error)}`, 'error');
    }
  };

  saveButton.addEventListener('click', () => writeKey(input.value.trim()));
  deleteButton.addEventListener('click', () => writeKey(''));

  buttons.appendChild(saveButton);
  buttons.appendChild(deleteButton);
  wrapper.appendChild(input);
  wrapper.appendChild(badge);
  wrapper.appendChild(buttons);
  field.body.appendChild(wrapper);

  if (fromEnv) {
    const hint = document.createElement('div');
    hint.className = 'key-source-hint';
    hint.textContent = `Using environment variable $${endpoint.envVarName}`;
    field.body.appendChild(hint);
  }

  return { element: field.element, refresh };
}

/**
 * The way out. Removing takes the endpoint's models out of the picker and
 * forgets what was curated for them, so it asks first.
 * @param {any} endpoint - The endpoint.
 * @param {any} ctx - The card context.
 * @returns {HTMLElement} The row.
 */
function buildRemoveRow(endpoint, ctx) {
  const row = document.createElement('div');
  row.className = 'custom-endpoint-actions';

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'settings-btn danger small custom-endpoint-remove';
  remove.textContent = 'Remove';
  remove.addEventListener('click', async () => {
    const label = endpoint.displayName || endpoint.id;
    const confirmed = await showConfirm(
      `Remove “${label}”? Its models leave the picker, and the limits and hidden models set for them are forgotten. Its API key stays in the credentials store.`,
      'Remove endpoint',
      { confirmText: 'Remove', danger: true },
    );
    if (!confirmed) return;
    remove.disabled = true;
    try {
      const { endpoints } = await customProvidersRemove({ id: endpoint.id });
      await providersCache.refresh();
      ctx.onRemoved(endpoints);
    } catch (error) {
      remove.disabled = false;
      ctx.reportError(`Couldn’t remove “${label}”. ${extractErrorMessage(error)}`);
    }
  });

  row.appendChild(remove);
  return row;
}

/**
 * The form for a new endpoint: a name and a URL, and a line saying which
 * provider id those will become. Nothing else is asked for — a key, headers and
 * the model list all belong to the card, which exists as soon as this is saved.
 * @param {object} ctx - What the form needs from the tab.
 * @param {string[]} ctx.takenIds - Ids already configured.
 * @param {(endpoints: any[]) => void} ctx.onAdded - Hand back the list with the new endpoint in it.
 * @param {() => void} ctx.onCancel - Close the form without adding.
 * @returns {HTMLElement} The form.
 */
export function buildAddEndpointForm(ctx) {
  const form = document.createElement('div');
  form.className = 'settings-group provider-field custom-endpoint custom-endpoint-add';

  const info = document.createElement('div');
  info.className = 'provider-info';
  const heading = document.createElement('div');
  heading.className = 'provider-name';
  heading.textContent = 'New endpoint';
  info.appendChild(heading);

  const idNote = document.createElement('div');
  idNote.className = 'provider-description custom-endpoint-add-id';
  info.appendChild(idNote);

  const control = document.createElement('div');
  control.className = 'provider-control';

  const nameField = subfield('Name');
  const name = wrappedInput({
    placeholder: 'Acme Gateway', ariaLabel: 'Name shown in the model picker', className: 'custom-endpoint-add-name',
  });
  nameField.body.appendChild(name.wrapper);

  const urlField = subfield('Base URL');
  const url = wrappedInput({
    placeholder: 'https://gateway.example.com/v1', ariaLabel: 'Base URL', className: 'custom-endpoint-add-url',
  });
  urlField.body.appendChild(url.wrapper);

  // The id is derived and shown as it is typed, because it is the one part of
  // this that can never be corrected afterwards.
  const showID = () => {
    const derived = deriveEndpointId(name.input.value, ctx.takenIds);
    idNote.textContent = name.input.value.trim()
      ? `Registers as custom-${derived}`
      : '';
  };
  name.input.addEventListener('input', showID);

  const actions = document.createElement('div');
  actions.className = 'custom-endpoint-actions';

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'settings-btn primary small custom-endpoint-add-save';
  add.textContent = 'Add';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'settings-btn small custom-endpoint-add-cancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => ctx.onCancel());

  add.addEventListener('click', async () => {
    const label = name.input.value.trim();
    const baseURL = url.input.value.trim();
    if (!baseURL) {
      urlField.setStatus('A base URL is required.', 'error');
      url.input.focus();
      return;
    }
    add.disabled = true;
    urlField.setStatus('Saving…', 'pending');
    try {
      const { endpoints } = await customProvidersSave({
        id: deriveEndpointId(label, ctx.takenIds),
        displayName: label,
        url: baseURL,
        enabled: true,
      });
      await providersCache.refresh();
      ctx.onAdded(endpoints);
    } catch (error) {
      add.disabled = false;
      urlField.setStatus(`Couldn’t add it. ${extractErrorMessage(error)}`, 'error');
    }
  });

  actions.appendChild(add);
  actions.appendChild(cancel);

  control.appendChild(nameField.element);
  control.appendChild(urlField.element);
  control.appendChild(actions);

  form.appendChild(info);
  form.appendChild(control);
  return form;
}

/**
 * Save when the user has finished with a field: on the way out of it, or on
 * Enter, which is the same thing said explicitly.
 * @param {HTMLInputElement} input - The field.
 * @param {() => void|Promise<void>} save - What to do with it.
 */
function onCommit(input, save) {
  input.addEventListener('blur', () => { save(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
      input.blur();
    }
  });
}
