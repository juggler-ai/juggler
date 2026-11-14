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
 * One card per provider account on the Providers tab.
 *
 * An account is a registered provider whose name is the account id, so every
 * card has the same shell whatever kind of account it is: its name (renamed in
 * place), what type it is, where it comes from, who is signed in, its id, the
 * controls its kind takes (account-controls.js), the list of its models, and a
 * ⋯ menu holding Rename and Remove. Nothing on it switches an account off: an
 * account exists or it does not.
 *
 * A change made on a card changes that card and nothing else. Its parts are
 * built once and updated in place, so the settings pane never has DOM pulled
 * out from under whoever is reading it.
 * @module components/settings/account-card
 */

import { accountsRemove, accountsSave, accountsUsage } from '../../services/ops-api.js';
import { showConfirm } from '../modal-dialog.js';
import { presentPopup } from '../../utils/popup-surface.js';
import { applyMenuRoles, attachMenuKeyboard } from '../../utils/menu-roles.js';
import { t, serverText } from '../../../sdk/lib/i18n.js';
import { errorText } from '../../../sdk/lib/error-utils.js';
import { providerAuthHint, providerDescription } from '../../utils/provider-text.js';
import { accountKind, buildAccountControls } from './account-controls.js';

/**
 * What a card needs from the tab around it.
 * @typedef {object} CardContext
 * @property {(id: string) => any} providerFor - The published provider status of an account.
 * @property {() => any} config - The /api/config payload.
 * @property {(provider: any) => HTMLElement|null} modelRow - Builds the shared model list.
 * @property {(id: string) => Promise<void>} recheck - Re-check an account and
 *   redraw its card.
 * @property {(id: string, available: boolean, hint: string) => void} setSignedIn - Record
 *   a sign-in or sign-out a card made.
 * @property {(providers: any[]) => void} onSwitched - The provider list after a switch.
 * @property {() => Promise<void>} reloadConfig - Re-read config and providers without redrawing.
 * @property {(list: any) => void} applyList - Hand back the list an op answered with.
 * @property {(message: string) => void} reportError - Report a failure with nowhere of its own to appear.
 */

/**
 * Build one account's card.
 * @param {import('../../services/ops-api.js').ProviderAccount} initial - The account.
 * @param {CardContext} ctx - The tab context.
 * @returns {{element: HTMLElement, update: (account: any) => void, redraw: () => void, redrawModels: () => void, refresh: () => void, dispose: () => void, account: () => any}}
 *   The card; update writes a fresh copy of the account onto it, redraw
 *   rebuilds its controls and model list from the provider status in hand,
 *   refresh brings its controls into line with what is stored, and dispose
 *   lets go of everything its controls hold.
 */
export function buildAccountCard(initial, ctx) {
  /** @type {any} */
  const account = { ...initial };

  const card = document.createElement('div');
  card.className = 'settings-group provider-field account-card';
  // Names the provider this card is for: the account id is the provider name.
  card.dataset.provider = account.id;

  const info = document.createElement('div');
  info.className = 'provider-info';

  const heading = document.createElement('div');
  heading.className = 'account-heading';
  const name = document.createElement('div');
  name.className = 'provider-name';
  const typeChip = document.createElement('span');
  typeChip.className = 'account-chip';
  const sourceChip = document.createElement('span');
  sourceChip.className = 'account-chip account-chip-source';
  heading.appendChild(name);
  heading.appendChild(typeChip);
  heading.appendChild(sourceChip);
  info.appendChild(heading);

  const description = document.createElement('div');
  description.className = 'provider-description';
  info.appendChild(description);

  const label = document.createElement('div');
  label.className = 'account-label';
  info.appendChild(label);

  const location = document.createElement('div');
  location.className = 'account-location';
  info.appendChild(location);

  // Why this account isn't serving, when that is the account rather than a
  // sign-in: a definition that did not register, or an endpoint that will not
  // answer. Always present and empty when nothing is wrong.
  const problem = document.createElement('div');
  problem.className = 'account-problem';
  info.appendChild(problem);

  // The one thing about an account that cannot change: every conversation,
  // the default and cheap model, the models hidden and the limits corrected
  // name it.
  const idCode = document.createElement('code');
  idCode.className = 'account-id';
  idCode.title = t('The provider id. Permanent: conversations and settings refer to it.');
  info.appendChild(idCode);

  const control = document.createElement('div');
  control.className = 'provider-control';

  // Holds the shared model list, in its own slot so the list survives every
  // change that has no bearing on it: an open list stays open.
  const models = document.createElement('div');
  models.className = 'account-models';

  const menuButton = document.createElement('button');
  menuButton.type = 'button';
  menuButton.className = 'btn btn-icon btn-ghost account-menu-button';
  menuButton.textContent = '\u22ef';
  menuButton.setAttribute('aria-haspopup', 'menu');
  menuButton.setAttribute('aria-expanded', 'false');

  card.appendChild(info);
  card.appendChild(control);
  card.appendChild(models);
  card.appendChild(menuButton);

  const provider = () => ctx.providerFor(account.id);

  /**
   * The facts the controls are drawn from: when the list brings different ones
   * (a card first drawn from the provider list, an edit in another window), the
   * controls are redrawn.
   * @returns {string} Their signature.
   */
  const controlFacts = () => JSON.stringify([account.type, account.registered, account.keySource,
    account.envVarName, account.signInCommand, account.settings || {}]);
  let drawnFacts = '';

  /**
   * Write the account's facts onto the card. The controls are redrawn when what
   * they show has changed — but never under the user's hands: a change made
   * from a field on this card comes back as a change, and the field already
   * shows it.
   * @param {any} next - A fresh copy of the account, or null to redraw from the one in hand.
   */
  const update = (next) => {
    if (next) {
      // In place: the controls hold this object and read it live.
      Object.assign(account, next);
      if (controlFacts() !== drawnFacts && !control.contains(document.activeElement)) {
        redraw();
        return;
      }
    }
    const p = provider();
    name.textContent = account.displayName || account.id;
    menuButton.setAttribute('aria-label', t('More actions for {name}', { name: name.textContent }));

    // Only where the name does not already say what type the account is.
    const typeName = account.typeDisplayName && account.typeDisplayName !== account.displayName
      ? account.typeDisplayName : '';
    typeChip.textContent = typeName;
    typeChip.hidden = !typeName;

    sourceChip.textContent = account.keySource === 'env' && account.envVarName
      ? t('From {name}', { name: account.envVarName })
      : (account.detected ? t('Detected') : '');
    sourceChip.hidden = !sourceChip.textContent;

    description.textContent = p && p.description ? providerDescription(p) : '';
    description.hidden = !description.textContent;

    label.textContent = account.accountLabel ? t('Signed in as {label}', { label: account.accountLabel }) : '';
    label.hidden = !label.textContent;

    const where = account.settings?.configDir || account.settings?.codexHome || '';
    location.textContent = where;
    location.hidden = !where;

    const why = account.problemMessage
      ? serverText(account.problemMessage, account.problem)
      : (account.problem || '');
    problem.textContent = why || (accountKind(account, p) === 'endpoint' && p && !p.available
      ? providerAuthHint(p) : '');

    idCode.textContent = account.id;
  };

  /** Rebuild the model list from the provider status in hand. */
  const redrawModels = () => {
    const p = provider();
    const row = p ? ctx.modelRow(p) : null;
    models.replaceChildren(...(row ? [row] : []));
  };

  /** @type {import('./account-controls.js').ControlHooks[]} What the drawn controls asked to be run. */
  let hooks = [];
  const refresh = () => { for (const h of hooks) h.refresh?.(); };
  const dispose = () => {
    for (const h of hooks) h.dispose?.();
    hooks = [];
  };

  /** Rebuild the controls and model list from the provider status in hand. */
  function redraw() {
    update(null);
    dispose();
    drawnFacts = controlFacts();
    control.replaceChildren(...buildAccountControls({
      account,
      provider,
      config: ctx.config,
      recheck: () => ctx.recheck(account.id),
      setSignedIn: (available, hint) => ctx.setSignedIn(account.id, available, hint),
      onSwitched: ctx.onSwitched,
      reloadConfig: ctx.reloadConfig,
      applyList: ctx.applyList,
      redrawModels,
      track: (h) => { hooks.push(h); },
    }));
    redrawModels();
  }

  menuButton.addEventListener('click', () => openMenu(menuButton, {
    rename: () => startRename(),
    remove: () => removeAccount(),
  }));
  name.addEventListener('dblclick', () => startRename());

  /** Swap the name for a field; Enter or leaving it saves, Escape keeps the name. */
  const startRename = () => {
    if (heading.querySelector('.account-rename-input')) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'field-input field-input-sm settings-value-input account-rename-input';
    input.value = account.displayName || '';
    input.setAttribute('aria-label', t('Name shown in the model picker'));
    let done = false;
    const finish = async (/** @type {boolean} */ keep) => {
      if (done) return;
      done = true;
      const wanted = input.value.trim();
      input.replaceWith(name);
      if (!keep || !wanted || wanted === account.displayName) return;
      const previous = account.displayName;
      name.textContent = wanted;
      try {
        const list = await accountsSave({ id: account.id, displayName: wanted });
        ctx.applyList(list);
      } catch (error) {
        name.textContent = previous;
        ctx.reportError(t('Couldn’t rename “{name}”. {error}', { name: previous, error: errorText(error) }));
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    name.replaceWith(input);
    input.focus();
    input.select();
  };

  /** Confirm, then remove. The confirm names the conversations using it, when any do. */
  const removeAccount = async () => {
    const shown = account.displayName || account.id;
    let count = 0;
    try {
      ({ conversations: count } = await accountsUsage({ id: account.id }));
    } catch {
      // The count only colours the question; without it the question stands.
    }
    const message = count > 0
      ? t('Remove {name}? {count, plural, one {# conversation uses it.} other {# conversations use it.}}', { name: shown, count })
      : t('Remove {name}?', { name: shown });
    const confirmed = await showConfirm(message, t('Remove account'), { confirmText: t('Remove'), danger: true });
    if (!confirmed) return;
    menuButton.disabled = true;
    try {
      const list = await accountsRemove({ id: account.id });
      ctx.applyList(list);
    } catch (error) {
      menuButton.disabled = false;
      ctx.reportError(t('Couldn’t remove “{name}”. {error}', { name: shown, error: errorText(error) }));
    }
  };

  redraw();
  return { element: card, update, redraw, redrawModels, refresh, dispose, account: () => account };
}

/**
 * The card's ⋯ menu.
 * @param {HTMLElement} anchor - The ⋯ button.
 * @param {{rename: () => void, remove: () => void}} actions - What its rows do.
 */
function openMenu(anchor, actions) {
  const surface = document.createElement('nav');
  surface.className = 'dropdown-menu account-menu is-open';
  const menu = document.createElement('menu');

  /** @type {(() => void)|null} */
  let release = null;
  const close = () => {
    anchor.setAttribute('aria-expanded', 'false');
    if (release) {
      release();
      release = null;
    }
  };
  /**
   * @param {string} text - The row's label.
   * @param {() => void} run - What it does.
   * @param {string} [extra] - A modifier class.
   */
  const item = (text, run, extra = '') => {
    const li = document.createElement('li');
    li.className = `menu-item ${extra}`.trim();
    li.textContent = text;
    li.addEventListener('click', () => {
      close();
      run();
    });
    menu.appendChild(li);
  };
  item(t('Rename'), actions.rename);
  item(t('Remove'), actions.remove, 'menu-item-danger');

  applyMenuRoles(menu, t('Account'));
  surface.appendChild(menu);
  release = presentPopup({
    surface,
    anchor,
    id: 'account-card-menu',
    onClose: close,
    align: 'right',
    insideSelectors: ['.account-menu'],
  });
  attachMenuKeyboard(menu, { close });
  anchor.setAttribute('aria-expanded', 'true');
}
