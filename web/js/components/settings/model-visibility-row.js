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
 * The per-model list on a provider account's card: which of its models the
 * model menu offers, and each one's token limits.
 * @module components/settings/model-visibility-row
 */

import * as settingsApi from '../../services/settings-api.js';
import { httpErrorText } from '../../services/http.js';
import { sortModelsByVersion } from '../../utils/model-filter.js';
import { formatTokens } from '../../utils/format.js';
import { t, formatNumber } from '../../../sdk/lib/i18n.js';

/**
 * Whether a published model's context window is a guess nobody has corrected:
 * the server reported none, and the user has set no window of their own.
 * @param {{windowAssumed?: boolean, providerContextWindow?: number|null}} model
 * @returns {boolean} True for an uncorrected assumed window.
 */
function isAssumedWindow(model) {
  return !!model.windowAssumed
    && (model.providerContextWindow === undefined || model.providerContextWindow === null);
}

/**
 * Build the collapsible per-model list for a provider: one row per model,
 * carrying a visibility checkbox and the two token limits, plus a filter box.
 *
 * The visibility preference is a deny-list (`models.hidden` in the global
 * settings), so a model the provider adds later shows up on its own and only
 * what the user explicitly turned off stays off. Unchecking writes the id into
 * that list; the server then flags the model `hidden` everywhere it publishes
 * the catalogue, which is what actually keeps it out of the model menu and out
 * of default/cheap-model resolution.
 *
 * The limits (`models.limits`) are the escape hatch for a model whose real
 * context window or output cap differs from what this build believes. That is
 * not cosmetic: the window decides admission and when a conversation compacts,
 * so a model catalogued at 128k that really serves 1M compacts eight times
 * sooner than it needs to. Correcting it here is what saves the user waiting
 * on a release to carry a new number.
 *
 * The filter isn't decoration: OpenRouter publishes several hundred models, and
 * an unfiltered list of that is unusable.
 *
 * The list opens on its own only when it holds a window the server didn't
 * report and the user hasn't corrected: a guess that decides when every
 * conversation on that model compacts. That is in practice a local server,
 * whose list is short; an API provider's dozens of models, or OpenRouter's
 * hundreds, would bury the page if every list started open.
 * @param {any} provider - Provider info object, including `modelsWithContext`
 * @param {(update: (models: any[]) => void) => void} registerUpdater - Takes
 *   the function that writes a freshly published catalogue onto this list's
 *   controls in place, for the tab to call when one arrives.
 * @returns {HTMLElement|null} The row to append, or null when the provider
 *   lists no models (nothing to choose between).
 */
export function buildModelVisibilityRow(provider, registerUpdater) {
  /** @type {Array<{id: string, displayName?: string, hidden?: boolean, fromAPI?: boolean, windowAssumed?: boolean, contextWindow?: number, maxOutputTokens?: number, providerContextWindow?: number, providerMaxOutputTokens?: number, derivedMaxOutputTokens?: number}>} */
  const models = Array.isArray(provider.modelsWithContext) ? provider.modelsWithContext : [];
  if (models.length === 0) return null;

  // Seeded from the published flags, then kept in step locally: a save
  // triggers a providers refresh, but the fields aren't rebuilt on that, so
  // this Set is the live truth for the summary and the checkboxes.
  const hidden = new Set(models.filter(m => m.hidden).map(m => m.id));
  // Models whose window is a guess nobody has corrected, kept in step the same
  // way: an override arriving from another window takes a model out.
  const assumed = new Set(models.filter(isAssumedWindow).map(m => m.id));

  const details = document.createElement('details');
  details.className = 'settings-model-visibility';
  details.open = assumed.size > 0;

  const summary = document.createElement('summary');
  summary.className = 'settings-model-visibility-summary';
  details.appendChild(summary);

  const summaryLabel = document.createElement('span');
  summaryLabel.className = 'settings-model-visibility-label';
  summaryLabel.textContent = t('Models and token limits');
  summary.appendChild(summaryLabel);

  // The count carries the state, so it's the part that stays legible when the
  // label dims — hence its own element rather than one string.
  const summaryCount = document.createElement('span');
  summaryCount.className = 'settings-model-visibility-count';
  summary.appendChild(summaryCount);

  const summaryAssumed = document.createElement('span');
  summaryAssumed.className = 'settings-model-visibility-assumed';
  summary.appendChild(summaryAssumed);

  const updateSummary = () => {
    summaryCount.textContent = hidden.size === 0
      ? `${models.length}`
      : t('{shown} of {total} shown', { shown: models.length - hidden.size, total: models.length });
    summaryAssumed.textContent = assumed.size > 0
      ? t('{count, plural, one {# assumed} other {# assumed}}', { count: assumed.size })
      : '';
    summaryAssumed.hidden = assumed.size === 0;
  };
  updateSummary();

  const status = document.createElement('div');
  status.className = 'settings-model-visibility-status';
  status.hidden = true;

  const filter = document.createElement('input');
  filter.type = 'text';
  filter.className = 'settings-value-input settings-model-visibility-filter field-input field-input-sm';
  filter.placeholder = t('Filter models');
  filter.autocomplete = 'off';
  filter.setAttribute('autocorrect', 'off');
  filter.setAttribute('autocapitalize', 'off');
  filter.setAttribute('aria-label', t('Filter {name} models', { name: provider.displayName }));
  filter.spellcheck = false;

  const list = document.createElement('div');
  list.className = 'settings-model-visibility-list surface-well';

  // Column headings, inside the scroller and pinned to its top, so they stay
  // over the numbers they name however far the list is scrolled.
  const header = document.createElement('div');
  header.className = 'settings-model-visibility-header';
  const nameHeading = document.createElement('span');
  nameHeading.textContent = t('Model');
  const windowHeading = document.createElement('span');
  windowHeading.className = 'settings-model-visibility-header-limit';
  windowHeading.textContent = t('Context window');
  const outputHeading = document.createElement('span');
  outputHeading.className = 'settings-model-visibility-header-limit';
  outputHeading.textContent = t('Max output');
  header.append(nameHeading, windowHeading, outputHeading);
  list.appendChild(header);

  const empty = document.createElement('div');
  empty.className = 'settings-model-visibility-empty';
  empty.textContent = t('Nothing.');
  empty.hidden = true;

  // The overrides this provider currently has, seeded from the catalogue: the
  // server publishes the provider's own number beside the effective one for
  // exactly the models it replaced, so a present `providerContextWindow` is
  // what marks a field as overridden — the effective value is then the
  // override. Kept as one object because a save has to send the provider's
  // COMPLETE set (see saveLimits).
  /** @type {Record<string, {contextWindow?: number, maxOutputTokens?: number}>} */
  const limits = {};
  for (const model of models) {
    /** @type {{contextWindow?: number, maxOutputTokens?: number}} */
    const entry = {};
    if (model.providerContextWindow !== undefined && model.providerContextWindow !== null) {
      entry.contextWindow = model.contextWindow;
    }
    if (model.providerMaxOutputTokens !== undefined && model.providerMaxOutputTokens !== null) {
      entry.maxOutputTokens = model.maxOutputTokens;
    }
    if (Object.keys(entry).length > 0) limits[model.id] = entry;
  }

  /**
   * Persist every override this provider has. The server replaces a named
   * provider's whole set rather than merging into it, so a partial send would
   * silently delete the models it left out.
   * @returns {Promise<any>} The settings PUT.
   */
  const saveLimits = () => settingsApi.updateSettings({ models: { limits: { [provider.name]: limits } } });

  /**
   * Write what a blank field stands for onto it: the placeholder and the
   * tooltip saying where that number comes from. Called when the field is
   * built and again when the catalogue is republished, because an override of
   * the window elsewhere moves a derived output budget with it.
   * @param {HTMLInputElement} input - The limit field.
   * @param {any} model - The catalogue entry this row is for.
   * @param {'contextWindow'|'maxOutputTokens'} field - Which limit it edits.
   */
  const describeLimit = (input, model, field) => {
    const overridden = field === 'contextWindow'
      ? model.providerContextWindow !== undefined && model.providerContextWindow !== null
      : model.providerMaxOutputTokens !== undefined && model.providerMaxOutputTokens !== null;
    const reported = field === 'contextWindow'
      ? (model.providerContextWindow ?? model.contextWindow)
      : (model.providerMaxOutputTokens ?? model.maxOutputTokens);
    // The budget the server derives when nobody states one. Shown as what
    // "auto" resolves to, so a turn cut off at that figure can be traced here.
    const derived = field === 'maxOutputTokens' && model.derivedMaxOutputTokens > 0
      ? model.derivedMaxOutputTokens
      : 0;
    if (derived) {
      input.placeholder = t('auto ({count})', { count: formatNumber(derived) });
    } else {
      input.placeholder = reported > 0 ? String(reported) : t('auto');
    }
    // Five numbers that look identical in a box: one the provider stated, one
    // from Juggler's catalogue for this model, one guessed because neither
    // knows the model, one Juggler derives from the window, and one typed
    // here. Which it is decides how much to trust it, and nothing else on the
    // row says. windowAssumed describes the context window only; a guessed
    // window's output cap is worked out from it.
    const who = provider.displayName;
    if (overridden && derived) {
      input.title = t("You set this. Clear the field to go back to Juggler's default of {count} tokens, derived from the context window.", { count: formatNumber(derived) });
    } else if (overridden) {
      input.title = t('You set this. Clear the field to go back to {count}.', { count: reported });
    } else if (derived && model.windowAssumed) {
      input.title = t('Worked out from the guessed context window. Type a number to set it yourself.');
    } else if (derived) {
      input.title = t("{count} tokens, Juggler's default, derived from the {window}-token context window because {name} doesn't report a max output for this model. Type a number to set it yourself.", {
        count: formatNumber(derived),
        window: formatNumber(model.contextWindow),
        name: who,
      });
    } else if (model.fromAPI && !(field === 'contextWindow' && model.windowAssumed)) {
      input.title = t('{count} tokens, as reported by {name} for this model.', { count: reported, name: who });
    } else if (model.windowAssumed) {
      input.title = field === 'contextWindow'
        ? t("{count} tokens is a guess. The server didn't say how large this model's context window is, so Juggler assumed a small, safe size. Enter the size the model is loaded with.", { count: reported })
        : t('Worked out from the guessed context window. Type a number to set it yourself.');
    } else {
      input.title = t("{count} tokens, from Juggler's list of {name}'s models. {name} doesn't report limits itself — if it's out of date, type the right figure.", { count: reported, name: who });
    }
  };

  /**
   * One token-limit field: blank means "use whatever the provider reports",
   * which is also what the placeholder shows — on an overridden model that is
   * the number clearing the field restores, not the override in force. Where
   * the provider reports no output limit, that is the budget Juggler derives.
   * @param {any} model - The catalogue entry this row is for.
   * @param {'contextWindow'|'maxOutputTokens'} field - Which limit to edit.
   * @param {string} ariaLabel - The field's accessible name.
   * @returns {HTMLInputElement} The input to append to the row.
   */
  const buildLimitInput = (model, field, ariaLabel) => {
    const stored = () => limits[model.id]?.[field];

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.className = 'model-limit-input field-input field-input-xs';
    input.dataset.limit = field;
    input.value = stored() ? String(stored()) : '';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', ariaLabel);
    describeLimit(input, model, field);

    input.addEventListener('change', async () => {
      const previous = limits[model.id] ? { ...limits[model.id] } : undefined;
      const restore = () => {
        if (previous) limits[model.id] = previous;
        else delete limits[model.id];
        input.value = previous?.[field] ? String(previous[field]) : '';
      };
      const raw = input.value.trim();
      const parsed = raw === '' ? 0 : Number.parseInt(raw, 10);
      // A blank or a zero is how "no override" is spelled; anything that isn't
      // a usable number is a typo, and putting the field back says so more
      // clearly than an error line would.
      if (!Number.isFinite(parsed) || parsed < 0) {
        restore();
        return;
      }
      const entry = { ...(limits[model.id] || {}) };
      if (parsed > 0) entry[field] = parsed;
      else delete entry[field];
      if (Object.keys(entry).length > 0) limits[model.id] = entry;
      else delete limits[model.id];
      try {
        await saveLimits();
        status.hidden = true;
      } catch (err) {
        // Nothing was stored, so leaving the number on screen would misreport
        // the window every later turn is admitted against.
        restore();
        status.textContent = t("Couldn't save the token limits. {error}", { error: httpErrorText(err) });
        status.hidden = false;
      }
    });
    return input;
  };

  /** @type {Array<{row: HTMLElement, haystack: string, id: string, box: HTMLInputElement, applyRowState: () => void, marker: HTMLButtonElement|null, fields: Record<string, HTMLInputElement>}>} */
  const rows = [];
  // Same lineage grouping the model menu uses, so the two lists read alike.
  for (const model of sortModelsByVersion(models)) {
    const row = document.createElement('div');
    row.className = 'settings-model-visibility-row';
    row.dataset.model = model.id;

    // The checkbox and the name are the label; the number fields are not. A
    // label forwards a click anywhere inside it to its control, so wrapping
    // the whole row would hide the model every time one was clicked into.
    const toggle = document.createElement('label');
    toggle.className = 'settings-model-visibility-toggle';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'settings-model-visibility-check';
    box.checked = !hidden.has(model.id);

    const name = document.createElement('span');
    name.className = 'settings-model-visibility-name';
    name.title = model.id;
    // A long id wraps rather than being cut off, since gateway ids share a
    // vendor prefix and differ only at the end. Each "/" offers a break, so
    // the vendor and the model name part before a word is split.
    const parts = model.id.split('/');
    parts.forEach((part, i) => {
      if (i < parts.length - 1) {
        name.append(`${part}/`, document.createElement('wbr'));
      } else {
        name.append(part);
      }
    });

    // Dims the name of a model that won't be offered, so the shown/hidden
    // split is readable down the list without checking every box.
    const applyRowState = () => row.classList.toggle('is-hidden', !box.checked);
    applyRowState();

    box.addEventListener('change', async () => {
      const show = box.checked;
      if (show) hidden.delete(model.id);
      else hidden.add(model.id);
      updateSummary();
      applyRowState();
      try {
        // Always send this provider's COMPLETE list. The server merges the
        // hidden map key by key, so an omitted provider keeps whatever it had
        // and re-showing the last hidden model has to be an explicit [].
        await settingsApi.updateSettings({ models: { hidden: { [provider.name]: [...hidden] } } });
        status.hidden = true;
      } catch (err) {
        // Put the checkbox back where it was: the stored list is unchanged, so
        // leaving it flipped would misreport what the model menu will do.
        if (show) hidden.add(model.id);
        else hidden.delete(model.id);
        box.checked = !show;
        updateSummary();
        applyRowState();
        status.textContent = t("Couldn't save which models to show. {error}", { error: httpErrorText(err) });
        status.hidden = false;
      }
    });

    toggle.appendChild(box);
    toggle.appendChild(name);
    row.appendChild(toggle);

    const limitFields = document.createElement('span');
    limitFields.className = 'model-limit-fields';
    const contextInput = buildLimitInput(model, 'contextWindow', t('Context window for {model}', { model: model.id }));
    const outputInput = buildLimitInput(model, 'maxOutputTokens', t('Max output tokens for {model}', { model: model.id }));
    limitFields.appendChild(contextInput);
    limitFields.appendChild(outputInput);

    // The picker's "assumed" marker, beside the number it qualifies. Outside
    // the label, so clicking it focuses the field instead of hiding the model.
    /** @type {HTMLButtonElement|null} */
    let marker = null;
    const published = /** @type {any} */ (model);
    if (published.windowAssumed) {
      marker = document.createElement('button');
      marker.type = 'button';
      marker.className = 'model-window-assumed';
      marker.textContent = t('assumed');
      const guess = published.providerContextWindow ?? published.contextWindow ?? 0;
      marker.title = t("The server didn't report this model's context window, so Juggler assumed {size}. Enter the real size in the Context window field.",
        { size: formatTokens(guess) });
      marker.hidden = !assumed.has(model.id);
      marker.addEventListener('click', () => contextInput.focus());
      row.appendChild(marker);
    }
    row.appendChild(limitFields);

    list.appendChild(row);
    rows.push({
      row,
      haystack: `${model.id} ${model.displayName || ''}`.toLowerCase(),
      id: model.id,
      box,
      applyRowState,
      marker,
      fields: { contextWindow: contextInput, maxOutputTokens: outputInput },
    });
  }

  filter.addEventListener('input', () => {
    const query = filter.value.trim().toLowerCase();
    let matches = 0;
    for (const { row, haystack } of rows) {
      const hit = query === '' || haystack.includes(query);
      row.hidden = !hit;
      if (hit) matches++;
    }
    empty.hidden = matches !== 0;
  });

  // Write a freshly published catalogue onto these controls, in place.
  //
  // Not a rebuild: that would close the list, clear the filter and lose the
  // scroll position, for a change that can only ever move a checkbox or a
  // number. A number field the user is inside keeps what they typed — it commits
  // on change, so an uncommitted value is still theirs — while a checkbox is
  // written either way, since clicking one commits immediately and there is no
  // half-made edit to protect. The local state is re-seeded alongside the DOM,
  // because it is what the next save sends.
  registerUpdater((nextModels) => {
    const byID = new Map(nextModels.map((m) => [m.id, m]));
    for (const entry of rows) {
      const next = byID.get(entry.id);
      if (!next) continue;

      if (next.hidden) hidden.add(entry.id);
      else hidden.delete(entry.id);
      entry.box.checked = !next.hidden;
      entry.applyRowState();

      /** @type {{contextWindow?: number, maxOutputTokens?: number}} */
      const overrides = {};
      if (next.providerContextWindow !== undefined && next.providerContextWindow !== null) {
        overrides.contextWindow = next.contextWindow;
      }
      if (next.providerMaxOutputTokens !== undefined && next.providerMaxOutputTokens !== null) {
        overrides.maxOutputTokens = next.maxOutputTokens;
      }
      if (Object.keys(overrides).length > 0) limits[entry.id] = overrides;
      else delete limits[entry.id];

      if (isAssumedWindow(next)) assumed.add(entry.id);
      else assumed.delete(entry.id);
      if (entry.marker) entry.marker.hidden = !assumed.has(entry.id);

      for (const field of /** @type {const} */ (['contextWindow', 'maxOutputTokens'])) {
        const input = entry.fields[field];
        if (input) describeLimit(input, next, field);
        if (!input || document.activeElement === input) continue;
        const value = /** @type {any} */ (overrides)[field];
        input.value = value ? String(value) : '';
      }
    }
    updateSummary();
  });

  // The empty state lives inside the scroller so a filter that matches nothing
  // leaves a box saying so, rather than an empty box with a note under it.
  list.appendChild(empty);

  const legend = document.createElement('div');
  legend.className = 'model-limit-legend';
  legend.textContent = t('Token limits. Leave a field blank to use the figure shown in grey; type a number to override it.');

  details.appendChild(filter);
  details.appendChild(legend);
  details.appendChild(list);
  details.appendChild(status);
  return details;
}
