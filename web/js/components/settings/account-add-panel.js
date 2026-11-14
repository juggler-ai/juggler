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
 * "Add an account" on the Providers tab, always open under the accounts: a
 * grid of the kinds of account, grouped as subscriptions, API keys, local
 * servers and custom endpoints. Picking one opens its form in the grid's place
 * — the name it takes in the model menu, the id that name becomes, and
 * whatever the type needs to start with (a key, a base URL, a server address).
 * Signing in, where the type has a sign-in, happens on the card the form turns
 * into.
 *
 * Logins found on this machine, and accounts that were set up before, sit in
 * the grid beside their type, already filled in: picking one adds it.
 * @module components/settings/account-add-panel
 */

import * as settingsApi from '../../services/settings-api.js';
import { accountsPreview, accountsSave, customProvidersCatalog } from '../../services/ops-api.js';
import { t, markForTranslation, serverText } from '../../../sdk/lib/i18n.js';
import { errorText } from '../../../sdk/lib/error-utils.js';
import { providerDescription } from '../../utils/provider-text.js';
import { CLAUDE_PATH, ENDPOINT_TYPE, SERVER_ADDRESSES, subfield, wrappedInput } from './account-controls.js';

/** The groups of the type picker, in order, under their headings. */
const GROUPS = [
  { category: 'subscription', label: markForTranslation('Subscriptions') },
  { category: 'api_key', label: markForTranslation('API keys') },
  { category: 'local', label: markForTranslation('Local servers') },
  { category: 'custom', label: markForTranslation('Custom') },
];

/**
 * What the panel needs from the tab.
 * @typedef {object} AddPanelContext
 * @property {() => import('../../services/ops-api.js').AccountType[]} types - The addable types.
 * @property {(name: string) => any} providerFor - A type's default provider status, for its form.
 * @property {() => any[]} accounts - The accounts there are.
 * @property {() => import('../../services/ops-api.js').AccountCandidate[]} candidates - The logins on offer.
 * @property {(list: any, id: string) => void} onAdded - An account was added from a form.
 * @property {(key: string) => Promise<void>} addCandidate - Add a login on offer, reporting a failure itself.
 */

/**
 * The open panel.
 * @typedef {object} AddPanel
 * @property {HTMLElement} element - The panel.
 * @property {() => void} refresh - Redraw the grid from what the tab holds now, when it is showing.
 * @property {() => void} reset - Put the grid back, dropping any form.
 */

/**
 * Whether a type can take another account now: a built-in whose default is
 * free, any type that takes further accounts, and custom endpoints.
 * @param {import('../../services/ops-api.js').AccountType} type - The type.
 * @param {any[]} accounts - The accounts there are.
 * @returns {boolean} True when the menu offers it.
 */
function canAdd(type, accounts) {
  if (type.acceptsExtra || !type.hasDefaultAccount) return true;
  return !accounts.some((a) => a.id === type.name);
}

/**
 * Build the panel, showing the grid.
 * @param {AddPanelContext} ctx - The tab context.
 * @returns {AddPanel} The panel.
 */
export function buildAddPanel(ctx) {
  const panel = document.createElement('div');
  panel.className = 'account-add';
  showPicker(panel, ctx, false);
  return {
    element: panel,
    refresh: () => {
      if (!panel.querySelector('.account-types')) return;
      // A redraw keeps the tile that had focus focused.
      const focused = /** @type {HTMLElement|null} */ (panel.querySelector('.account-type:focus'));
      showPicker(panel, ctx, false);
      if (!focused) return;
      const selector = focused.dataset.key
        ? `.account-type[data-key="${CSS.escape(focused.dataset.key)}"]`
        : `.account-type[data-type="${CSS.escape(focused.dataset.type || '')}"]:not([data-key])`;
      /** @type {HTMLElement|null} */ (panel.querySelector(selector))?.focus();
    },
    reset: () => showPicker(panel, ctx, false),
  };
}

/**
 * Show the grid in the panel: in each group, the logins on offer of that
 * group's types, then the types that can take another account. A type whose
 * default account was removed is offered as that account, which adding brings
 * back as it was, rather than as a bare type too.
 * @param {HTMLElement} panel - The panel.
 * @param {AddPanelContext} ctx - The tab context.
 * @param {boolean} focus - Focus the first tile: the grid was returned to from a form.
 */
function showPicker(panel, ctx, focus) {
  const grid = document.createElement('div');
  grid.className = 'account-types';
  const accounts = ctx.accounts();
  const types = ctx.types();
  const candidates = ctx.candidates();
  const restorable = new Set(candidates.filter((c) => c.reason === 'removed').map((c) => c.type));
  for (const group of GROUPS) {
    const inGroup = types.filter((ty) => ty.category === group.category);
    const offered = candidates.filter((c) => inGroup.some((ty) => ty.name === c.type));
    const addable = inGroup.filter((ty) => canAdd(ty, accounts) && !restorable.has(ty.name));
    if (offered.length === 0 && addable.length === 0) continue;
    const label = document.createElement('div');
    label.className = 'account-type-group caps-label';
    label.textContent = t(group.label);
    grid.appendChild(label);
    for (const candidate of offered) {
      grid.appendChild(candidateTile(candidate, types, ctx));
    }
    for (const type of addable) {
      grid.appendChild(tile({
        name: type.displayName,
        description: descriptionOf(type, ctx),
        onPick: () => showForm(panel, type, ctx),
        dataset: { type: type.name },
      }));
    }
  }

  panel.replaceChildren(grid);
  if (focus) /** @type {HTMLElement|null} */ (grid.querySelector('.account-type'))?.focus();
}

/**
 * One tile of the grid.
 * @param {{name: string, description?: string, detail?: string, onPick: (button: HTMLButtonElement) => void, dataset: Record<string, string>, extraClass?: string}} spec - What it shows and does.
 * @returns {HTMLButtonElement} The tile.
 */
function tile({ name, description, detail, onPick, dataset, extraClass }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = extraClass ? `account-type ${extraClass}` : 'account-type';
  Object.assign(button.dataset, dataset);
  const title = document.createElement('span');
  title.className = 'account-type-name';
  title.textContent = name;
  button.appendChild(title);
  if (description) {
    const sub = document.createElement('span');
    sub.className = 'account-type-description';
    sub.textContent = description;
    button.appendChild(sub);
  }
  if (detail) {
    const where = document.createElement('span');
    where.className = 'account-type-detail';
    where.textContent = detail;
    button.appendChild(where);
  }
  button.addEventListener('click', () => onPick(button));
  return button;
}

/**
 * A login on offer's tile: what it is, why it is offered, and where it was
 * found. Picking it adds it; it leaves the grid when the list says it is an
 * account.
 * @param {import('../../services/ops-api.js').AccountCandidate} candidate - The login.
 * @param {import('../../services/ops-api.js').AccountType[]} types - The types, for its type's name.
 * @param {AddPanelContext} ctx - The tab context.
 * @returns {HTMLButtonElement} The tile.
 */
function candidateTile(candidate, types, ctx) {
  const typeName = types.find((ty) => ty.name === candidate.type)?.displayName || candidate.type;
  const shown = candidate.displayName || typeName;
  return tile({
    name: candidate.label ? t('{name} · {label}', { name: shown, label: candidate.label }) : shown,
    description: candidate.reason === 'found' ? t('Found on this machine') : t('Set up here before'),
    detail: candidate.path || '',
    extraClass: 'account-type-found',
    dataset: { type: candidate.type, key: candidate.key },
    onPick: async (button) => {
      if (button.disabled) return;
      button.disabled = true;
      try {
        await ctx.addCandidate(candidate.key);
      } finally {
        button.disabled = false;
      }
    },
  });
}

/**
 * A type's one-line blurb: its default provider's own description, which the
 * server translates, or failing that the type's.
 * @param {import('../../services/ops-api.js').AccountType} type - The type.
 * @param {AddPanelContext} ctx - The tab context.
 * @returns {string} The blurb, possibly empty.
 */
function descriptionOf(type, ctx) {
  const provider = ctx.providerFor(type.name);
  if (provider && provider.description) return providerDescription(provider);
  return type.descriptionMessage ? serverText(type.descriptionMessage, type.description) : (type.description || '');
}

/**
 * A form's Cancel: back to the grid, adding nothing.
 * @param {HTMLElement} panel - The panel.
 * @param {AddPanelContext} ctx - The tab context.
 * @returns {HTMLButtonElement} The button.
 */
function cancelButton(panel, ctx) {
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-sm btn-secondary account-add-cancel';
  cancel.textContent = t('Cancel');
  cancel.addEventListener('click', () => showPicker(panel, ctx, true));
  return cancel;
}

/**
 * What a form's fields hand to the add: settings and a key for the account,
 * and what to write once the account exists — never before, so a failed add
 * leaves nothing behind.
 * @typedef {{settings?: Record<string, any>, apiKey?: string, afterAdd?: () => Promise<void>}} Collected
 */

/**
 * Show one type's form in the panel. The server is asked what an add would
 * make before the form is drawn: whether it restores the type's default
 * account, which takes no settings of its own, and the id and name it takes.
 * @param {HTMLElement} panel - The panel.
 * @param {import('../../services/ops-api.js').AccountType} type - The type.
 * @param {AddPanelContext} ctx - The tab context.
 */
async function showForm(panel, type, ctx) {
  try {
    drawForm(panel, type, ctx, await accountsPreview({ type: type.name, displayName: '' }));
  } catch (error) {
    showFailure(panel, ctx, t('Couldn’t add it. {error}', { error: errorText(error) }));
  }
}

/**
 * Put a failure in the panel, with the way back to the type picker.
 * @param {HTMLElement} panel - The panel.
 * @param {AddPanelContext} ctx - The tab context.
 * @param {string} message - What went wrong.
 */
function showFailure(panel, ctx, message) {
  const status = document.createElement('div');
  status.className = 'account-add-status';
  status.textContent = message;
  const actions = document.createElement('div');
  actions.className = 'account-add-actions';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'btn btn-sm btn-secondary';
  back.textContent = t('Back to the kinds of account');
  back.addEventListener('click', () => showPicker(panel, ctx, true));
  actions.appendChild(back);
  panel.replaceChildren(status, actions);
}

/**
 * Draw one type's form.
 * @param {HTMLElement} panel - The panel.
 * @param {import('../../services/ops-api.js').AccountType} type - The type.
 * @param {AddPanelContext} ctx - The tab context.
 * @param {import('../../services/ops-api.js').AccountPreview} first - What an add with no name would make.
 */
function drawForm(panel, type, ctx, first) {
  const provider = ctx.providerFor(type.name);
  const isEndpoint = type.name === ENDPOINT_TYPE;
  const isDefault = first.isDefault;

  const heading = document.createElement('div');
  heading.className = 'account-add-heading';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'btn btn-icon btn-ghost account-add-back';
  back.textContent = '\u2039';
  back.setAttribute('aria-label', t('Back to the kinds of account'));
  back.addEventListener('click', () => showPicker(panel, ctx, true));
  const title = document.createElement('span');
  title.textContent = t('New {type} account', { type: type.displayName });
  heading.appendChild(back);
  heading.appendChild(title);

  const form = document.createElement('div');
  form.className = 'account-add-form';
  form.dataset.type = type.name;

  // The name, and the id it becomes.
  const nameColumn = document.createElement('div');
  nameColumn.className = 'provider-control';
  const nameField = subfield(t('Name shown in the model picker'));
  const name = wrappedInput({
    value: isEndpoint ? '' : first.displayName,
    placeholder: isEndpoint ? t('Acme Gateway') : '',
    ariaLabel: t('Name shown in the model picker'),
    className: 'account-add-name',
  });
  nameField.body.appendChild(name.wrapper);
  nameColumn.appendChild(nameField.element);
  const idNote = document.createElement('div');
  idNote.className = 'account-add-id';
  nameColumn.appendChild(idNote);

  // The id an add takes is the server's to give; it is shown because it can
  // never change afterwards. Each answer replaces the last, and an answer
  // overtaken by a later keystroke is dropped.
  /** @type {((id: string) => void)[]} */
  const idListeners = [];
  const showID = (/** @type {string} */ id) => {
    idNote.textContent = t('Id {id}. It cannot be changed once the account is added.', { id });
    for (const listener of idListeners) listener(id);
  };
  let asked = 0;
  name.input.addEventListener('input', async () => {
    const mine = ++asked;
    try {
      const preview = await accountsPreview({ type: type.name, displayName: name.input.value });
      if (mine === asked) showID(preview.id);
    } catch {
      if (mine === asked) idNote.textContent = '';
    }
  });

  // What the type needs to start with.
  const fieldColumn = document.createElement('div');
  fieldColumn.className = 'provider-control';
  /** @type {() => Promise<Collected|null>} */
  let collect = async () => ({});
  const server = SERVER_ADDRESSES[type.name];
  const folder = FOLDER_FIELDS[type.name];

  if (isEndpoint) {
    collect = buildEndpointFields(fieldColumn, name.input);
  } else if (provider && provider.authType !== 'oauth_bearer' && provider.configKeyName !== '') {
    const keyField = subfield(t('API key'));
    const key = wrappedInput({ ariaLabel: t('API key'), className: 'account-add-key', secret: true });
    keyField.body.appendChild(key.wrapper);
    fieldColumn.appendChild(keyField.element);
    if (provider.apiKeyURL) {
      const link = document.createElement('a');
      link.href = provider.apiKeyURL;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'get-api-key-link';
      link.textContent = t('Get API Key \u2192');
      fieldColumn.appendChild(link);
    }
    fieldColumn.appendChild(explain(isDefault || !provider.envVarName
      ? t('Stored in credentials.json.')
      : t('Stored in credentials.json under this account’s own name. Only the first {type} account reads {name}.',
        { type: type.displayName, name: provider.envVarName })));
    collect = async () => {
      const apiKey = key.input.value.trim();
      if (!apiKey) {
        keyField.setStatus(t('An API key is required.'), 'error');
        key.input.focus();
        return null;
      }
      return { apiKey };
    };
  } else if (folder && !isDefault) {
    collect = buildFolderField(fieldColumn, type.name, folder, idListeners);
  } else if (type.name === 'copilot' && !isDefault) {
    const hostField = subfield(t('GitHub host'));
    const host = wrappedInput({
      value: 'github.com',
      placeholder: t('{host} or your-tenant.ghe.com', { host: 'github.com' }),
      ariaLabel: t('GitHub host'),
      className: 'account-add-host',
    });
    hostField.body.appendChild(host.wrapper);
    fieldColumn.appendChild(hostField.element);
    fieldColumn.appendChild(explain(t('Sign in with GitHub on its card once it is added.')));
    collect = async () => ({ settings: { host: host.input.value.trim() || 'github.com' } });
  } else if (provider && provider.authType === 'oauth_bearer') {
    fieldColumn.appendChild(explain(t('Once it is added, its card shows how to sign in.')));
  } else if (server && isDefault) {
    const hostField = subfield(t('Server address'));
    const input = wrappedInput({ placeholder: server.address, ariaLabel: t('Server address'), className: 'account-add-host' });
    hostField.body.appendChild(input.wrapper);
    fieldColumn.appendChild(hostField.element);
    fieldColumn.appendChild(explain(t('Leave it empty for {address}.', { address: server.address })));
    collect = async () => {
      const value = input.input.value.trim();
      return value ? { afterAdd: () => settingsApi.setConfig(server.configKey, value) } : {};
    };
  } else if (type.name === 'claudecode' && isDefault) {
    const pathField = subfield(t('claude CLI path'));
    const input = wrappedInput({
      placeholder: t('CLI path (leave blank for auto)'), ariaLabel: t('claude CLI path'), className: 'account-add-cli',
    });
    pathField.body.appendChild(input.wrapper);
    fieldColumn.appendChild(pathField.element);
    collect = async () => {
      const value = input.input.value.trim();
      return value ? { afterAdd: () => settingsApi.setConfig(CLAUDE_PATH.configKey, value) } : {};
    };
  }
  if (!isEndpoint && provider && provider.description && !fieldColumn.querySelector('.account-add-explain')) {
    fieldColumn.appendChild(explain(providerDescription(provider)));
  }
  showID(first.id);

  const actions = document.createElement('div');
  actions.className = 'account-add-actions';
  const status = document.createElement('div');
  status.className = 'account-add-status';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn btn-sm btn-primary account-add-save';
  add.textContent = t('Add account');
  add.addEventListener('click', async () => {
    add.disabled = true;
    status.textContent = '';
    try {
      const collected = await collect();
      if (!collected) {
        add.disabled = false;
        return;
      }
      const { afterAdd, ...extra } = collected;
      const list = await accountsSave({ type: type.name, displayName: name.input.value.trim(), ...extra });
      if (afterAdd) await afterAdd();
      showPicker(panel, ctx, false);
      ctx.onAdded(list, list.id);
    } catch (error) {
      add.disabled = false;
      status.textContent = t('Couldn’t add it. {error}', { error: errorText(error) });
    }
  });
  actions.appendChild(status);
  actions.appendChild(cancelButton(panel, ctx));
  actions.appendChild(add);

  form.appendChild(nameColumn);
  form.appendChild(fieldColumn);
  panel.replaceChildren(heading, form, actions);
  name.input.focus();
}

/**
 * The types whose further accounts are a folder their CLI keeps a login in:
 * the setting it is saved as, the folder name it is suggested under, and what
 * the form says about it.
 * @type {Record<string, {setting: string, prefix: string, label: string, explain: string}>}
 */
const FOLDER_FIELDS = {
  claudecode: {
    setting: 'configDir',
    prefix: '~/.claude-',
    label: markForTranslation('Config folder (the CLI creates it if missing)'),
    explain: markForTranslation('Each Claude Code login lives in its own folder. Juggler runs your claude CLI with CLAUDE_CONFIG_DIR pointing there, and never sees the login itself.'),
  },
  openaicodex: {
    setting: 'codexHome',
    prefix: '~/.codex-',
    label: markForTranslation('CODEX_HOME folder (created if missing)'),
    explain: markForTranslation('A second ChatGPT login lives in its own CODEX_HOME. Juggler reads its auth.json as it reads the first one, and never writes it.'),
  },
};

/**
 * A further account's login folder, named after the account's id until the
 * user types one of their own.
 * @param {HTMLElement} column - Where the field goes.
 * @param {string} typeName - The type's id, which starts the account's.
 * @param {{setting: string, prefix: string, label: string, explain: string}} folder - What the folder is.
 * @param {((id: string) => void)[]} idListeners - Where to hear each id the form shows.
 * @returns {() => Promise<Collected|null>} Reads the field.
 */
function buildFolderField(column, typeName, folder, idListeners) {
  const field = subfield(t(folder.label));
  const dir = wrappedInput({ ariaLabel: t(folder.label), className: 'account-add-folder' });
  field.body.appendChild(dir.wrapper);
  column.appendChild(field.element);
  column.appendChild(explain(t(folder.explain)));

  // The folder this form named, so one the user typed is told apart from it.
  let suggested = '';
  idListeners.push((id) => {
    if (dir.input.value.trim() && dir.input.value.trim() !== suggested) return;
    suggested = `${folder.prefix}${id.startsWith(`${typeName}-`) ? id.slice(typeName.length + 1) : 'work'}`;
    dir.input.value = suggested;
  });

  return async () => {
    const value = dir.input.value.trim();
    if (!value) {
      field.setStatus(t('A folder is required.'), 'error');
      dir.input.focus();
      return null;
    }
    return { settings: { [folder.setting]: value } };
  };
}

/**
 * A line of explanation under a form's fields.
 * @param {string} text - What to say.
 * @returns {HTMLElement} The line.
 */
function explain(text) {
  const el = document.createElement('div');
  el.className = 'account-add-explain';
  el.textContent = text;
  return el;
}

/** Numbers each form's catalogue list, whose id the name field refers to. */
let catalogListSeq = 0;

/**
 * An endpoint's base URL and optional key. The name field doubles as a way to
 * pick a hosted provider the compiled-in models.dev catalogue knows: it
 * suggests their names, and naming one fills in its base URL. A URL the user
 * typed is never replaced, and a filled-in one follows the name until they do.
 * @param {HTMLElement} column - Where the fields go.
 * @param {HTMLInputElement} nameInput - The form's name field.
 * @returns {() => Promise<Collected|null>} Reads the fields.
 */
function buildEndpointFields(column, nameInput) {
  const urlField = subfield(t('Base URL'));
  const url = wrappedInput({
    // i18n-ignore: an example address
    placeholder: 'https://gateway.example.com/v1', ariaLabel: t('Base URL'), className: 'account-add-url',
  });
  urlField.body.appendChild(url.wrapper);
  column.appendChild(urlField.element);

  const keyField = subfield(t('API key'));
  const key = wrappedInput({
    placeholder: t('optional — some endpoints need none'), ariaLabel: t('API key'), className: 'account-add-key', secret: true,
  });
  keyField.body.appendChild(key.wrapper);
  column.appendChild(keyField.element);

  const catalogList = document.createElement('datalist');
  catalogList.id = `account-endpoint-catalog-${++catalogListSeq}`;
  nameInput.setAttribute('list', catalogList.id);
  column.appendChild(catalogList);

  /** @type {import('../../services/ops-api.js').CatalogProvider[]} */
  let known = [];
  // The URL this form filled in, so a URL the user typed is told apart from it.
  let filledURL = '';
  nameInput.addEventListener('input', () => {
    const current = url.input.value.trim();
    if (current && current !== filledURL) return;
    const typed = nameInput.value.trim().toLowerCase();
    const match = typed ? known.find((p) => p.name.toLowerCase() === typed) : undefined;
    filledURL = match ? match.api : '';
    url.input.value = filledURL;
    if (match) urlField.setStatus(t('Filled in from models.dev'), 'ok');
    else urlField.setStatus('');
  });
  customProvidersCatalog().then(({ providers }) => {
    known = Array.isArray(providers) ? providers : [];
    for (const p of known) {
      const option = document.createElement('option');
      option.value = p.name;
      catalogList.appendChild(option);
    }
  }).catch(() => {
    // Suggestions are a convenience: without them the form is the plain one.
  });

  return async () => {
    const baseURL = url.input.value.trim();
    if (!baseURL) {
      urlField.setStatus(t('A base URL is required.'), 'error');
      url.input.focus();
      return null;
    }
    const apiKey = key.input.value.trim();
    return { settings: { baseURL }, ...(apiKey ? { apiKey } : {}) };
  };
}
