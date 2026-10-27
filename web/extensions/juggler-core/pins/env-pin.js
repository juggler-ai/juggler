//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import PinboardItemType from 'juggler/pinboard-item-type';
// The env files are the project's, never a worktree's: these ops always act on
// the project, so there is no workspace for a pin to pass.
import { projectEnvGet, projectEnvApprove, projectEnvSet } from 'juggler/ops';
import { translator, markForTranslation } from 'juggler/i18n';
import { createElement, errorText, injectStylesOnce } from 'juggler/ui';
import { debounce } from 'juggler/utils/debounce';
import { pinEmpty } from '../lib/pin-empty.js';

const t = translator('@juggler/core');

injectStylesOnce('env-pin-styles', `
.env-pin {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  height: 100%;
  overflow: auto;
}
.env-pin__pending {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border: 0.0625rem solid var(--accent-orange);
  border-radius: var(--radius-lg);
}
.env-pin__pending-list { margin: 0; padding-left: 1.25rem; font-family: var(--font-mono); font-size: var(--font-size-sm); }
.env-pin__error { color: var(--error-color, var(--text-secondary)); font-size: var(--font-size-sm); }
.env-pin__scope { display: flex; flex-direction: column; gap: 0.25rem; }
.env-pin__scope-title { font-weight: 600; }
.env-pin__scope-path { color: var(--text-secondary); font-size: var(--font-size-sm); word-break: break-all; }
.env-pin__row { display: flex; align-items: center; gap: 0.5rem; font-family: var(--font-mono); font-size: var(--font-size-sm); }
.env-pin__name { flex: 0 1 auto; overflow-wrap: anywhere; }
.env-pin__value { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; color: var(--text-secondary); }
.env-pin__shadowed .env-pin__name, .env-pin__shadowed .env-pin__value { text-decoration: line-through; }
.env-pin__row button { flex-shrink: 0; }
.env-pin__add { display: flex; gap: 0.25rem; }
.env-pin__add input { min-width: 0; flex: 1 1 0; font-family: var(--font-mono); font-size: var(--font-size-sm); }
`);

/** What each file is, in the user's terms, in merge order. */
const SCOPE_TITLES = {
  user: markForTranslation('Yours, in every project'),
  project: markForTranslation('This project, committed'),
  local: markForTranslation('Yours, in this project only'),
};

/** The project-relative env files the watcher reports. */
const WATCHED = ['.juggler/env.json', '.juggler/env.local.json'];

/** Coalesces a burst of watcher events into one read. */
const REFRESH_DEBOUNCE_MS = 150;

/**
 * The longest a burst may hold the read off, so a stream of rewrites (a script
 * setting variables in a loop) still shows its progress rather than nothing.
 */
const REFRESH_MAX_WAIT_MS = 1000;

/**
 * EnvPin — the environment variables shell commands get in this project.
 *
 * Three files feed them, merged user < project < local (package projectenv on
 * the server). The project file can arrive with a clone, so its variables apply
 * only once approved, and only as approved: this card is where that happens.
 * It shows the variables themselves before asking, because approving something
 * nobody has read is not approval.
 *
 * The two project files are watched (the watcher allowlists them out of
 * `.juggler/`); the user's own file lives in the config directory, outside any
 * project, so a hand edit to it is picked up by Refresh.
 * @class
 * @augments PinboardItemType
 */
class EnvPin extends PinboardItemType {
  /** @type {import('juggler/pinboard-item-type').PinboardItemManifest} */
  static MANIFEST = {
    id: 'env',
    name: 'Environment',
    version: '1.0.0',
    description: 'The environment variables commands run with in this project',
    order: 70,
  };

  /**
   * @param {import('juggler/pinboard-item-type').PinActiveContext} active - The active context.
   * @returns {true|string} True when there is a project.
   */
  canAdd(active) {
    return active?.project?.path ? true : t('No project');
  }

  /**
   * @returns {import('juggler/pinboard-item-type').PinDescription} The tab's word.
   */
  describe() {
    return { title: t(this.name) };
  }

  /**
   * @param {HTMLElement} container - The body to fill.
   * @param {import('juggler/pinboard-item-type').PinContext} pinContext - The pin and its context.
   * @returns {import('juggler/pinboard-item-type').PinController} The controller.
   */
  mount(container, pinContext) {
    let context = pinContext;
    const body = createElement('div', 'env-pin');
    container.replaceChildren(body);

    /** @type {import('../../../js/services/ops-api.js').ProjectEnvState|null} */
    let state = null;
    /** `scope:NAME` of the values shown in full, kept across redraws. */
    const revealed = new Set();
    let generation = 0;

    /**
     * Show a failure above everything, replacing the previous one.
     * @param {string} message - What went wrong.
     */
    const showError = (message) => {
      body.querySelector('.env-pin__error--action')?.remove();
      body.prepend(createElement('div', 'env-pin__error env-pin__error--action', message));
    };

    /**
     * Run a write and draw what it returns.
     * @param {() => Promise<any>} op - The write.
     */
    const act = async (op) => {
      try {
        state = await op();
        draw();
      } catch (error) {
        if (context.signal.aborted) return;
        showError(t("Couldn't save it. {error}", { error: errorText(error) }));
      }
    };

    /**
     * Replace one file's variables, starting from what it holds now.
     * @param {'user'|'project'|'local'} scope - Which file.
     * @param {(env: Record<string, string>) => void} change - The edit.
     * @returns {Promise<void>} Settles once the write is drawn or its failure shown.
     */
    const edit = (scope, change) => act(async () => {
      const latest = await projectEnvGet(context.signal);
      const file = latest.files.find((f) => f.scope === scope);
      const env = { ...(file?.env || {}) };
      change(env);
      return projectEnvSet({ scope, env }, context.signal);
    });

    const render = async () => {
      const mine = ++generation;
      try {
        const next = await projectEnvGet(context.signal);
        if (mine !== generation || context.signal.aborted) return;
        state = next;
        draw();
      } catch (error) {
        if (mine !== generation || context.signal.aborted) return;
        body.replaceChildren(createElement('div', 'env-pin__error',
          t("Couldn't read the environment files. {error}", { error: errorText(error) })));
      }
    };

    const draw = () => {
      if (!state) return;
      const nodes = [];

      const project = state.files.find((f) => f.scope === 'project');
      if (state.pending && project) {
        const box = createElement('div', 'env-pin__pending');
        box.appendChild(createElement('div', 'env-pin__pending-text', t(
          "This project's {file} sets these variables. They are not used until you approve them, and a change to the file asks again.",
          { file: '.juggler/env.json' },
        )));
        const list = createElement('ul', 'env-pin__pending-list');
        for (const [name, value] of Object.entries(project.env).sort(([a], [b]) => a.localeCompare(b))) {
          list.appendChild(createElement('li', 'env-pin__pending-entry', `${name}=${value}`));
        }
        box.appendChild(list);
        const approve = /** @type {HTMLButtonElement} */ (createElement('button', 'env-pin__approve btn-primary', t('Approve')));
        approve.type = 'button';
        approve.addEventListener('click', () => {
          approve.disabled = true;
          void act(() => projectEnvApprove(context.signal));
        });
        box.appendChild(approve);
        nodes.push(box);
      }

      for (const file of state.files) {
        if (file.error) {
          nodes.push(createElement('div', 'env-pin__error env-pin__error--file',
            t('{file} is not used: {error}', { file: file.path, error: file.error })));
        }
      }

      if (!state.files.some((f) => Object.keys(f.env).length)) {
        nodes.push(pinEmpty(t(
          'Variables set here are added to every command the assistant runs in this project. Keep secrets in the last file: it stays out of git.',
        )));
      }

      for (const file of state.files) nodes.push(drawScope(file));
      body.replaceChildren(...nodes);
    };

    /**
     * One file's section: its variables and a row to add one.
     * @param {import('../../../js/services/ops-api.js').ProjectEnvFile} file - The file.
     * @returns {HTMLElement} The section.
     */
    const drawScope = (file) => {
      const section = createElement('section', `env-pin__scope env-pin__scope--${file.scope}`);
      section.appendChild(createElement('div', 'env-pin__scope-title', t(SCOPE_TITLES[file.scope])));
      section.appendChild(createElement('div', 'env-pin__scope-path', file.path));

      for (const [name, value] of Object.entries(file.env).sort(([a], [b]) => a.localeCompare(b))) {
        const key = `${file.scope}:${name}`;
        // Shadowed by a later file, or waiting for approval: listed, not in effect.
        const inEffect = state?.sources?.[name] === file.scope;
        const row = createElement('div', `env-pin__row${inEffect ? '' : ' env-pin__shadowed'}`);
        row.dataset.name = name;
        row.appendChild(createElement('span', 'env-pin__name', name));
        row.appendChild(createElement('span', 'env-pin__value', revealed.has(key) ? value : '••••••'));
        if (!inEffect) row.title = file.approved ? t('Overridden by a later file') : t('Waiting for approval');

        const reveal = /** @type {HTMLButtonElement} */ (createElement('button', 'env-pin__reveal btn-secondary',
          revealed.has(key) ? t('Hide') : t('Show')));
        reveal.type = 'button';
        reveal.addEventListener('click', () => {
          if (revealed.has(key)) revealed.delete(key); else revealed.add(key);
          draw();
        });
        row.appendChild(reveal);

        const del = /** @type {HTMLButtonElement} */ (createElement('button', 'env-pin__delete icon-btn'));
        del.type = 'button';
        del.title = t('Remove {name}', { name });
        del.setAttribute('aria-label', t('Remove {name}', { name }));
        del.innerHTML = '<span class="icon-trashcan"></span>';
        del.addEventListener('click', () => {
          del.disabled = true;
          void edit(file.scope, (env) => { delete env[name]; });
        });
        row.appendChild(del);
        section.appendChild(row);
      }

      const form = /** @type {HTMLFormElement} */ (createElement('form', 'env-pin__add'));
      const nameInput = /** @type {HTMLInputElement} */ (createElement('input', 'env-pin__add-name'));
      nameInput.placeholder = t('NAME');
      nameInput.setAttribute('aria-label', t('Variable name'));
      nameInput.spellcheck = false;
      const valueInput = /** @type {HTMLInputElement} */ (createElement('input', 'env-pin__add-value'));
      valueInput.placeholder = t('value');
      valueInput.setAttribute('aria-label', t('Value'));
      valueInput.spellcheck = false;
      const add = /** @type {HTMLButtonElement} */ (createElement('button', 'env-pin__add-button btn-secondary', t('Add')));
      add.type = 'submit';
      form.append(nameInput, valueInput, add);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const name = nameInput.value.trim();
        if (!name) return;
        void edit(file.scope, (env) => { env[name] = valueInput.value; });
      });
      section.appendChild(form);
      return section;
    };

    const refresh = debounce(() => { void render(); }, REFRESH_DEBOUNCE_MS, { maxWait: REFRESH_MAX_WAIT_MS });

    const stopWatching = context.services.files.onChange((changes) => {
      const root = (context.active?.project?.path || '').replace(/\/+$/, '');
      if (!root) return;
      const targets = WATCHED.map((rel) => `${root}/${rel}`);
      if (changes.some((change) => targets.includes(change.path))) refresh();
    });

    void render();

    return {
      update: (next) => {
        const moved = next.active?.project?.path !== context.active?.project?.path;
        context = next;
        if (moved) void render();
      },
      teardown: () => {
        refresh.cancel();
        stopWatching();
      },
      getActions: () => [
        { id: 'refresh', label: t('Refresh'), icon: 'refresh', primary: true, run: () => render() },
      ],
    };
  }
}

export default EnvPin;
