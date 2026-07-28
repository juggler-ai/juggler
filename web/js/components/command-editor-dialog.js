//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Command editor dialog — the editing surface for user-defined slash commands.
 *
 * Opened from the slash menu's "New command…" row, the `/commands` manager, or
 * a "Save as slash command" action. It writes a `.juggler/commands/*.md` file
 * via the backend (the same validation path `define_command` uses) and triggers
 * a registry hot-reload so the command appears in the menu immediately.
 * @module components/command-editor-dialog
 */

import { writeUserCommand, deleteUserCommand, fetchUserCommands, resetUserCommandsCache, USER_COMMAND_NAME_RE } from '../services/user-commands.js';
import { expandTemplate } from '../plugins/user-command-factory.js';
import { reloadRegistries } from '../registries/reload-registries.js';
import slashCommandHandler from '../services/slash-command-handler.js';
import strategyRegistry from '../registries/strategy-registry.js';
import { markPopupOpen } from '../utils/popup-manager.js';
import { focusWhenShown } from '../utils/focus.js';

/**
 * Set of built-in / extension command ids a user command may not shadow. User
 * commands are registered in the same registry, so they are filtered out —
 * a user command may collide with (overwrite) another user command, but never
 * a built-in.
 * @returns {Set<string>} Reserved command ids
 */
function builtinCommandIds() {
  const ids = new Set();
  for (const cmd of slashCommandHandler.getCommands()) {
    if (!cmd.userDefined) ids.add(cmd.name);
  }
  return ids;
}

/**
 * Apply a command write/delete to the live registries after the file is already
 * on disk. Resets the user-commands cache synchronously (so the very next
 * {@link fetchUserCommands} re-reads the change) and kicks the registry rebuild
 * off WITHOUT awaiting it.
 *
 * `reloadRegistries()` defers its rebuild to local quiescence — it never
 * resolves while a conversation is mid-turn, and can reject if a plugin's
 * init() throws. Awaiting it would leave the dialog stuck open and the manager
 * re-reading a stale cache, so the just-saved edit appears lost. The rebuild
 * still applies live once quiescent; the UI just doesn't block on it. Mirrors
 * skills-tab's `_afterMutation`.
 */
function refreshRegistries() {
  resetUserCommandsCache();
  reloadRegistries().catch((err) => {
    console.warn('[Commands] registry reload after mutation failed:', err);
  });
}

/**
 * @typedef {object} CommandEditorOptions
 * @property {string} [name] - Initial command name (pre-fills the name field)
 * @property {'user'|'project'} [scope] - Initial scope
 * @property {import('../services/user-commands.js').UserCommandDef|null} [def] - Existing definition when editing
 */

/**
 * Open the command editor dialog. Resolves when the dialog closes: with the
 * saved command name on save, `{deleted: name}` on delete, or null on cancel.
 * @param {CommandEditorOptions} [options]
 * @returns {Promise<string|{deleted: string}|null>} The saved name, `{deleted}`, or null on cancel
 */
export function openCommandEditor(options = {}) {
  const def = options.def || null;
  const editing = !!def;
  const fm = def?.frontmatter || {};

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'command-editor-overlay';
    overlay.innerHTML = buildMarkup({
      editing,
      name: def?.name ?? options.name ?? '',
      scope: def?.scope ?? options.scope ?? 'project',
      description: fm.description ?? '',
      argsHint: fm.argsHint ?? '',
      run: fm.run ?? 'send',
      strategy: fm.strategy ?? '',
      model: fm.model ?? '',
      icon: fm.icon ?? '',
      goal: fm.goal ?? '',
      template: def?.body ?? '',
    });
    document.body.appendChild(overlay);

    let releasePopup = () => {};
    const close = (/** @type {string|{deleted: string}|null} */ result) => {
      releasePopup();
      overlay.remove();
      resolve(result);
    };
    releasePopup = markPopupOpen(() => close(null));

    const $ = (/** @type {string} */ sel) => /** @type {any} */ (overlay.querySelector(sel));

    // Populate the strategy picker from the live registry.
    const strategySelect = $('#cmd-strategy');
    if (strategySelect) {
      for (const { id, manifest } of strategyManifests()) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = manifest?.name || id;
        if (id === fm.strategy) opt.selected = true;
        strategySelect.appendChild(opt);
      }
    }

    const nameInput = $('#cmd-name');
    const nameError = $('#cmd-name-error');
    const templateInput = $('#cmd-template');
    const previewArgs = $('#cmd-preview-args');
    const previewOut = $('#cmd-preview-out');
    const runRadios = overlay.querySelectorAll('input[name="cmd-run"]');
    const subthreadFields = $('#cmd-subthread-fields');
    const saveBtn = $('#cmd-save');
    const pathHint = $('#cmd-path-hint');

    const reserved = builtinCommandIds();

    const currentScope = () => /** @type {any} */ (overlay.querySelector('input[name="cmd-scope"]:checked'))?.value || 'project';
    const currentRun = () => /** @type {any} */ (overlay.querySelector('input[name="cmd-run"]:checked'))?.value || 'send';

    const validateName = () => {
      const v = nameInput.value.trim();
      let msg = '';
      if (!v) msg = '';
      else if (!USER_COMMAND_NAME_RE.test(v)) msg = 'Lowercase letters, digits, and hyphens; must start with a letter.';
      else if (reserved.has(v)) msg = `"/${v}" already exists as a built-in command.`;
      nameError.textContent = msg;
      const ok = !!v && !msg;
      saveBtn.disabled = !ok;
      return ok;
    };

    const updatePreview = () => {
      const args = previewArgs.value.trim() ? previewArgs.value.trim().split(/\s+/) : [];
      previewOut.textContent = expandTemplate(templateInput.value, args);
    };

    const updateRunUI = () => {
      subthreadFields.classList.toggle('hidden', currentRun() !== 'subthread');
    };

    const updatePathHint = () => {
      const dir = currentScope() === 'user' ? '~/.juggler/commands' : '<project>/.juggler/commands';
      const nm = nameInput.value.trim() || 'name';
      pathHint.textContent = `Stored in ${dir}/${nm}.md`;
    };

    nameInput.addEventListener('input', () => { validateName(); updatePathHint(); });
    templateInput.addEventListener('input', updatePreview);
    previewArgs.addEventListener('input', updatePreview);
    runRadios.forEach((r) => r.addEventListener('change', updateRunUI));
    overlay.querySelectorAll('input[name="cmd-scope"]').forEach((r) => r.addEventListener('change', updatePathHint));

    $('#cmd-close').addEventListener('click', () => close(null));
    overlay.querySelector('.command-editor-backdrop')?.addEventListener('click', () => close(null));

    if (editing) {
      const del = $('#cmd-delete');
      del.classList.remove('hidden');
      del.addEventListener('click', async () => {
        const ok = await /** @type {any} */ (window).showConfirm(
          `Delete the /${def?.name} command?`, 'Delete command', { danger: true, confirmText: 'Delete' });
        if (!ok) return;
        await deleteUserCommand(/** @type {any} */ (def?.scope), /** @type {any} */ (def?.name));
        refreshRegistries();
        close({ deleted: /** @type {string} */ (def?.name) });
      });
    }

    saveBtn.addEventListener('click', async () => {
      if (!validateName()) return;
      clearFieldErrors(overlay);
      const scope = currentScope();
      const name = nameInput.value.trim();
      const body = {
        description: $('#cmd-description').value.trim(),
        argsHint: $('#cmd-argshint').value.trim(),
        run: currentRun(),
        strategy: currentRun() === 'subthread' ? (strategySelect?.value || '') : '',
        model: currentRun() === 'subthread' ? $('#cmd-model').value.trim() : '',
        icon: $('#cmd-icon').value.trim(),
        goal: currentRun() === 'subthread' ? $('#cmd-goal').value.trim() : '',
        template: templateInput.value,
      };
      saveBtn.disabled = true;
      const res = await writeUserCommand(/** @type {any} */ (scope), name, body);
      if (res.ok) {
        // If editing renamed/rescoped, remove the old file so we don't leave a dup.
        if (editing && def && (def.name !== name || def.scope !== scope)) {
          await deleteUserCommand(/** @type {any} */ (def.scope), def.name);
        }
        refreshRegistries();
        close(name);
        return;
      }
      saveBtn.disabled = false;
      if (res.status === 400 && res.data?.errors) {
        showFieldErrors(overlay, res.data.errors);
      } else {
        showFieldErrors(overlay, { template: res.data?.error || 'Could not save command.' });
      }
    });

    // Initial state.
    updateRunUI();
    updatePreview();
    updatePathHint();
    validateName();
    focusWhenShown(nameInput, { delay: 50 });
  });
}

/**
 * Open the `/commands` manager: a dialog listing every slash command grouped by
 * origin (Built-in / This project / All projects), with edit / delete / new
 * actions on user commands. Broken definitions are shown with their error and an
 * edit button rather than hidden. Resolves when the manager closes.
 * @returns {Promise<void>}
 */
export function openCommandManager() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'command-editor-overlay';
    overlay.innerHTML = `
      <div class="command-editor-backdrop"></div>
      <div class="command-editor-panel" role="dialog" aria-modal="true" aria-label="Slash commands">
        <header class="command-editor-header">
          <h2>Slash commands</h2>
          <button id="cmd-close" class="close-button command-editor-close" title="Close" aria-label="Close">×</button>
        </header>
        <div class="command-editor-body" id="cmd-manager-body"></div>
        <footer class="command-editor-footer">
          <div class="command-editor-path"></div>
          <div class="command-editor-actions">
            <button id="cmd-manager-new" class="modal-button primary">New command…</button>
          </div>
        </footer>
      </div>`;
    document.body.appendChild(overlay);

    let releasePopup = () => {};
    const close = () => { releasePopup(); overlay.remove(); resolve(); };
    releasePopup = markPopupOpen(close);

    const body = /** @type {HTMLElement} */ (overlay.querySelector('#cmd-manager-body'));

    const render = async () => {
      const userCommands = await fetchUserCommands();
      await slashCommandHandler.init();
      const builtins = slashCommandHandler.getCommands().filter((c) => !c.userDefined);
      body.innerHTML = '';
      body.appendChild(builtinGroup('Built-in', builtins));
      body.appendChild(userGroup('This project', userCommands.filter((d) => d.scope === 'project'), render));
      body.appendChild(userGroup('All projects', userCommands.filter((d) => d.scope === 'user'), render));
    };

    overlay.querySelector('.command-editor-backdrop')?.addEventListener('click', close);
    overlay.querySelector('#cmd-close')?.addEventListener('click', close);
    overlay.querySelector('#cmd-manager-new')?.addEventListener('click', async () => {
      await openCommandEditor({});
      render();
    });

    render();
  });
}

/**
 * @param {string} title
 * @param {Array<{name: string, description?: string, label?: string}>} cmds
 * @returns {HTMLElement} Group element
 */
function builtinGroup(title, cmds) {
  const group = document.createElement('div');
  group.className = 'command-manager-group';
  const h = document.createElement('h3');
  h.textContent = title;
  group.appendChild(h);
  for (const c of cmds) {
    const row = document.createElement('div');
    row.className = 'command-manager-row';
    const code = document.createElement('code');
    code.textContent = '/' + c.name;
    const desc = document.createElement('span');
    desc.className = 'command-manager-desc';
    desc.textContent = c.description || c.label || '';
    row.append(code, desc);
    group.appendChild(row);
  }
  return group;
}

/**
 * @param {string} title
 * @param {import('../services/user-commands.js').UserCommandDef[]} defs
 * @param {() => void} refresh
 * @returns {HTMLElement} Group element
 */
function userGroup(title, defs, refresh) {
  const group = document.createElement('div');
  group.className = 'command-manager-group';
  const h = document.createElement('h3');
  h.textContent = title;
  group.appendChild(h);
  if (defs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'command-editor-hint';
    empty.textContent = 'None yet.';
    group.appendChild(empty);
    return group;
  }
  for (const def of defs) {
    const row = document.createElement('div');
    row.className = 'command-manager-row' + (def.error ? ' is-broken' : '');
    const code = document.createElement('code');
    code.textContent = '/' + def.name;
    row.appendChild(code);
    if (def.error) {
      const err = document.createElement('span');
      err.className = 'command-manager-error';
      err.textContent = def.error;
      row.appendChild(err);
    } else {
      const desc = document.createElement('span');
      desc.className = 'command-manager-desc';
      desc.textContent = def.frontmatter?.description || '';
      row.appendChild(desc);
    }
    const actions = document.createElement('div');
    actions.className = 'command-manager-actions';
    const edit = document.createElement('button');
    edit.className = 'modal-button secondary';
    edit.textContent = 'Edit';
    edit.addEventListener('click', async () => { await openCommandEditor({ def }); refresh(); });
    const del = document.createElement('button');
    del.className = 'modal-button danger';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      const ok = await /** @type {any} */ (window).showConfirm(
        `Delete the /${def.name} command?`, 'Delete command', { danger: true, confirmText: 'Delete' });
      if (!ok) return;
      await deleteUserCommand(/** @type {any} */ (def.scope), def.name);
      refreshRegistries();
      refresh();
    });
    actions.append(edit, del);
    row.appendChild(actions);
    group.appendChild(row);
  }
  return group;
}

/**
 * @returns {Array<{id: string, manifest: any}>} Strategy manifests, or empty on error
 */
function strategyManifests() {
  try {
    return strategyRegistry.getAllManifests();
  } catch {
    return [];
  }
}

/**
 * Clear any inline field-error text in the dialog.
 * @param {HTMLElement} overlay
 */
function clearFieldErrors(overlay) {
  overlay.querySelectorAll('.command-editor-field-error').forEach((el) => { el.textContent = ''; });
}

/**
 * Render server-returned field errors inline beside their inputs.
 * @param {HTMLElement} overlay
 * @param {Record<string, string>} errors - field → message
 */
function showFieldErrors(overlay, errors) {
  for (const [field, message] of Object.entries(errors)) {
    const el = overlay.querySelector(`[data-error-for="${field}"]`);
    if (el) el.textContent = message;
  }
}

/**
 * Build the dialog markup.
 * @param {{editing: boolean, name: string, scope: string, description: string, argsHint: string, run: string, strategy: string, model: string, icon: string, goal: string, template: string}} v
 * @returns {string} HTML
 */
function buildMarkup(v) {
  const esc = (/** @type {string} */ s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const checked = (/** @type {boolean} */ b) => (b ? ' checked' : '');
  return `
    <div class="command-editor-backdrop"></div>
    <div class="command-editor-panel" role="dialog" aria-modal="true" aria-label="Command editor">
      <header class="command-editor-header">
        <h2>${v.editing ? 'Edit command' : 'New command'}</h2>
        <button id="cmd-close" class="close-button command-editor-close" title="Close" aria-label="Close">×</button>
      </header>
      <div class="command-editor-body">
        <label class="command-editor-label">Name
          <div class="command-editor-name-row"><span class="command-editor-slash">/</span>
            <input id="cmd-name" type="text" class="command-editor-input" value="${esc(v.name)}"
              autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="review-pr" /></div>
          <div id="cmd-name-error" class="command-editor-field-error" data-error-for="name"></div>
        </label>

        <label class="command-editor-label">Description
          <input id="cmd-description" type="text" class="command-editor-input" value="${esc(v.description)}"
            placeholder="Shown in the slash menu" />
          <div class="command-editor-field-error" data-error-for="description"></div>
        </label>

        <label class="command-editor-label">Args hint <span class="command-editor-optional">(optional)</span>
          <input id="cmd-argshint" type="text" class="command-editor-input" value="${esc(v.argsHint)}" placeholder="&lt;pr-number&gt;" />
        </label>

        <label class="command-editor-label">Prompt template
          <textarea id="cmd-template" class="command-editor-textarea" rows="6"
            placeholder="Review PR $1. $ARGUMENTS">${esc(v.template)}</textarea>
          <div class="command-editor-field-error" data-error-for="template"></div>
          <div class="command-editor-hint">Placeholders: <code>$1</code>…<code>$9</code>, <code>$ARGUMENTS</code>, <code>$$</code> for a literal $.</div>
        </label>

        <div class="command-editor-preview">
          <label class="command-editor-label">Preview — sample args
            <input id="cmd-preview-args" type="text" class="command-editor-input" placeholder="42 extra words" />
          </label>
          <pre id="cmd-preview-out" class="command-editor-preview-out"></pre>
        </div>

        <fieldset class="command-editor-fieldset">
          <legend>Run mode</legend>
          <label><input type="radio" name="cmd-run" value="send"${checked(v.run === 'send' || !v.run)} /> Send immediately</label>
          <label><input type="radio" name="cmd-run" value="draft"${checked(v.run === 'draft')} /> Insert as draft</label>
          <label><input type="radio" name="cmd-run" value="subthread"${checked(v.run === 'subthread')} /> Run in a thread</label>
        </fieldset>

        <div id="cmd-subthread-fields" class="command-editor-subthread hidden">
          <label class="command-editor-label">Thread goal
            <input id="cmd-goal" type="text" class="command-editor-input" value="${esc(v.goal)}" placeholder="PR review" />
          </label>
          <label class="command-editor-label">Strategy override
            <select id="cmd-strategy" class="command-editor-input"><option value="">(inherit)</option></select>
          </label>
          <label class="command-editor-label">Model override <span class="command-editor-optional">(model id)</span>
            <input id="cmd-model" type="text" class="command-editor-input" value="${esc(v.model)}" placeholder="(inherit)" />
          </label>
        </div>

        <input id="cmd-icon" type="hidden" value="${esc(v.icon)}" />

        <fieldset class="command-editor-fieldset">
          <legend>Scope</legend>
          <label><input type="radio" name="cmd-scope" value="project"${checked(v.scope !== 'user')} /> This project</label>
          <label><input type="radio" name="cmd-scope" value="user"${checked(v.scope === 'user')} /> All my projects</label>
        </fieldset>
      </div>
      <footer class="command-editor-footer">
        <div id="cmd-path-hint" class="command-editor-path"></div>
        <div class="command-editor-actions">
          <button id="cmd-delete" class="modal-button danger hidden">Delete</button>
          <button id="cmd-save" class="modal-button primary">Save</button>
        </div>
      </footer>
    </div>
  `;
}
