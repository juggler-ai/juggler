//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { escapeHtml } from '../../../sdk/lib/html.js';
import { t, htmlSlots, withHtml } from '../../../sdk/lib/i18n.js';
import { fetchUserCommands } from '../../services/user-commands.js';
import { fetchExtensions } from '../../services/extensions.js';
import slashCommandHandler from '../../services/slash-command-handler.js';
import { commandText } from '../../services/command-manager-entry.js';
import { openSettings } from '../../services/settings-launcher.js';
import { USER_COMMANDS_REFRESHED } from '../../registries/command-registry.js';
import { REGISTRIES_RELOADED } from '../../registries/reload-registries.js';
import { mountCommandEditor } from '../command-editor.js';
import { showConfirm } from '../modal-dialog.js';

/**
 * @typedef {import('../../services/user-commands.js').UserCommandDef} UserCommandDef
 * @typedef {ReturnType<typeof slashCommandHandler.getCommands>[number]} BuiltinCommand
 */

/** Selection key of the unsaved draft a "New command…" press opens. */
const NEW_KEY = 'new';

/**
 * Selection key of a user command: scope and name, since the same name may exist
 * in both scopes (the project one shadows the other).
 * @param {{scope: string, name: string}} def - The definition
 * @returns {string} Its key
 */
function userKey(def) {
  return `user:${def.scope}:${def.name}`;
}

/**
 * Selection key of a built-in command.
 * @param {string} name - Command id
 * @returns {string} Its key
 */
function builtinKey(name) {
  return `builtin:${name}`;
}

/**
 * Slash commands tab: every command the slash menu offers, in one master/detail
 * page. The list holds the user's own commands, grouped by where they are saved,
 * then the built-ins; the detail pane is the editor for a user command, and for a
 * built-in a description with a link to its own entry in the Extensions tab.
 *
 * The user commands are read raw ({@link fetchUserCommands}) so a broken file
 * appears with its error rather than vanishing, and a shadowed one is still there
 * to edit. The built-ins are what the slash handler reports — the enabled ones,
 * which are the ones a user can type.
 *
 * An unsaved edit survives a panel close: the editor is left mounted and its
 * fields are not among the text inputs the panel blanks, so reopening settings
 * returns to the draft. Leaving it for another command asks first.
 */
export class CommandsTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope).
   */
  constructor(host) {
    /** @type {HTMLElement} @private */
    this.host = host;
    /** @type {UserCommandDef[]} @private */
    this.userCommands = [];
    /** @type {BuiltinCommand[]} @private */
    this.builtins = [];
    /** @type {Map<string, string>} @private - Extension id → display name. */
    this.extensionNames = new Map();
    /** @type {string|null} @private */
    this.selectedKey = null;
    /** @type {string} @private - Name a new draft was opened with. */
    this.draftName = '';
    /** @type {string} @private */
    this.filter = '';
    /** @type {import('../command-editor.js').CommandEditorHandle|null} @private */
    this.editor = null;
    /** @type {boolean} @private */
    this.loaded = false;
    /** @type {number} @private - Guards against a stale load overwriting a newer one. */
    this.loadSeq = 0;
    /** @type {Promise<void>|null} @private - The load in flight, for reveals to wait on. */
    this.loading = null;
    /** @type {boolean} @private */
    this.listening = false;
    /** @type {string|null} @private - What the detail pane was last drawn from, to skip a redraw that changes nothing. */
    this.detailSignature = null;
    /** @type {() => void} @private */
    this.onCommandsChanged = () => { void this.reload(); };
  }

  /**
   * The controller's root element inside the tab section.
   * @returns {HTMLElement|null} The root, or null before render().
   * @private
   */
  get root() {
    return this.host.querySelector('#commands-tab-root');
  }

  /** Build the static chrome and wire delegated listeners (called once). */
  render() {
    const root = this.root;
    if (!root) return;
    root.innerHTML = `
      <aside class="command-page-sidebar">
        <div class="command-page-toolbar">
          <input type="search" class="field-input command-page-filter" id="command-page-filter"
            placeholder="${escapeHtml(t('Filter commands'))}" aria-label="${escapeHtml(t('Filter commands'))}"
            autocorrect="off" autocapitalize="off" spellcheck="false" />
          <button type="button" class="modal-button btn-primary command-page-new" data-action="new">${escapeHtml(t('New command…'))}</button>
        </div>
        <nav class="command-page-list" id="command-page-list" aria-label="${escapeHtml(t('Slash commands'))}"></nav>
      </aside>
      <div class="command-page-detail" id="command-page-detail"></div>
    `;
    root.addEventListener('click', (e) => this._onClick(/** @type {MouseEvent} */ (e)));
    root.querySelector('#command-page-filter')?.addEventListener('input', (e) => {
      this.filter = /** @type {HTMLInputElement} */ (e.target).value.trim().toLowerCase();
      this._renderList();
    });
    this._renderDetail();
  }

  /** Element connected: follow command changes made anywhere. */
  connect() {
    if (this.listening) return;
    this.listening = true;
    // Any command file changing on disk — from this client, another one, or an
    // external edit — is broadcast as plugin-changed, which re-reads the user
    // commands at once (USER_COMMANDS_REFRESHED) and rebuilds every registry
    // once no turn is running (REGISTRIES_RELOADED). Both reset the
    // user-commands cache before dispatching, so the reload's fetch is fresh.
    document.addEventListener(USER_COMMANDS_REFRESHED, this.onCommandsChanged);
    document.addEventListener(REGISTRIES_RELOADED, this.onCommandsChanged);
  }

  /** Tab shown: read the lists afresh. */
  show() {
    void this.reload();
  }

  /** Element disconnected: drop the document listeners and the editor's picker. */
  dispose() {
    this.listening = false;
    document.removeEventListener(USER_COMMANDS_REFRESHED, this.onCommandsChanged);
    document.removeEventListener(REGISTRIES_RELOADED, this.onCommandsChanged);
    this.editor?.dispose();
  }

  /**
   * Open the detail pane on a new command's draft, the name pre-filled — the
   * deep-link the slash menu's "New command “/name”…" row follows.
   * @param {string} [name] - Name to pre-fill
   * @returns {Promise<boolean>} False when an unsaved edit was kept instead
   */
  async revealNewCommand(name = '') {
    await (this.loading ?? this.reload());
    return this._select(NEW_KEY, { draftName: name });
  }

  /**
   * Re-read both lists and redraw. A user command that is selected and unedited
   * is re-mounted from its fresh definition, so a change made elsewhere shows;
   * one being edited is left alone. Resolves once the page shows the newest
   * lists: a load overtaken by a later one waits for that one rather than
   * resolving on a page it never drew.
   * @returns {Promise<void>}
   */
  reload() {
    const seq = ++this.loadSeq;
    const run = (async () => {
      await slashCommandHandler.init();
      const [userCommands, extensions] = await Promise.all([fetchUserCommands(), fetchExtensions()]);
      if (seq !== this.loadSeq) {
        // Superseded by a newer load, which draws instead.
        await this.loading;
        return;
      }
      this.userCommands = userCommands;
      this.builtins = slashCommandHandler.getCommands()
        .filter((c) => !c.userDefined)
        .sort((a, b) => a.name.localeCompare(b.name));
      this.extensionNames = new Map();
      for (const ext of extensions) {
        const id = ext.manifest?.id;
        if (id) this.extensionNames.set(id, ext.manifest.name ? t(ext.manifest.name, undefined, { namespace: id }) : id);
      }
      this.loaded = true;

      const stillThere = this.selectedKey === NEW_KEY || !!this._entryFor(this.selectedKey);
      if (!stillThere && !this.editor?.isDirty()) this.selectedKey = null;
      this._renderList();
      if (!this.editor?.isDirty() && this._detailSignature() !== this.detailSignature) this._renderDetail();
    })();
    this.loading = run;
    run.finally(() => { if (this.loading === run) this.loading = null; });
    return run;
  }

  /**
   * The entry a selection key names.
   * @param {string|null} key - Selection key
   * @returns {{kind: 'user', def: UserCommandDef}|{kind: 'builtin', cmd: BuiltinCommand}|null} The entry, if listed
   * @private
   */
  _entryFor(key) {
    if (!key) return null;
    const def = this.userCommands.find((d) => userKey(d) === key);
    if (def) return { kind: 'user', def };
    const cmd = this.builtins.find((c) => builtinKey(c.name) === key);
    if (cmd) return { kind: 'builtin', cmd };
    return null;
  }

  /**
   * Delegated clicks: list rows, "New command…", and the built-in's link.
   * @param {MouseEvent} e
   * @private
   */
  _onClick(e) {
    const target = /** @type {HTMLElement} */ (e.target);
    const row = /** @type {HTMLElement|null} */ (target.closest('.command-page-row'));
    if (row?.dataset.key) {
      void this._select(row.dataset.key);
      return;
    }
    const action = /** @type {HTMLElement|null} */ (target.closest('[data-action]'))?.dataset.action;
    if (action === 'new') {
      void this._select(NEW_KEY, { draftName: '' });
    } else if (action === 'show-extension') {
      // The command's own entry, not just its extension's: the catalog expands
      // the extension, selects the command's row and scrolls it into view.
      const id = /** @type {HTMLElement} */ (target.closest('[data-command]')).dataset.command;
      if (id) openSettings('extensions', { capability: { itemType: 'command', id } });
    }
  }

  /**
   * Move the selection, asking first if it would throw away an unsaved edit.
   * @param {string|null} key - Selection key
   * @param {{draftName?: string, force?: boolean}} [opts] - A new draft's name;
   *   `force` skips the question (the edit was just saved or deleted)
   * @returns {Promise<boolean>} False when the user chose to keep editing
   * @private
   */
  async _select(key, opts = {}) {
    const same = key === this.selectedKey && key !== NEW_KEY;
    if (same && !opts.force) return true;
    if (!opts.force && this.editor?.isDirty()) {
      const discard = await showConfirm(
        t('Your changes to this command have not been saved.'),
        t('Discard changes?'),
        { danger: true, confirmText: t('Discard') });
      if (!discard) return false;
    }
    this.selectedKey = key;
    this.draftName = opts.draftName ?? '';
    this._renderList();
    this._renderDetail();
    this.editor?.focus();
    return true;
  }

  /**
   * Whether an entry passes the filter box.
   * @param {string} name - Command name
   * @param {string} [text] - Its description or label
   * @returns {boolean} True to list it
   * @private
   */
  _matches(name, text) {
    if (!this.filter) return true;
    return name.toLowerCase().includes(this.filter) || (text || '').toLowerCase().includes(this.filter);
  }

  /** @private */
  _renderList() {
    const list = this.root?.querySelector('#command-page-list');
    if (!list) return;
    list.replaceChildren();
    if (!this.loaded) return;

    const project = this.userCommands.filter((d) => d.scope === 'project');
    const user = this.userCommands.filter((d) => d.scope === 'user');
    list.append(
      this._group(t('This project'), project
        .filter((d) => this._matches(d.name, d.frontmatter?.description))
        .map((d) => this._row(userKey(d), d.name, d.error || d.frontmatter?.description || '', !!d.error)),
      t('None yet')),
      this._group(t('All my projects'), user
        .filter((d) => this._matches(d.name, d.frontmatter?.description))
        .map((d) => this._row(userKey(d), d.name, d.error || d.frontmatter?.description || '', !!d.error)),
      t('None yet')),
      this._group(t('Built-in'), this.builtins
        .filter((c) => this._matches(c.name, commandText(c, c.description || c.label || '')))
        .map((c) => this._row(builtinKey(c.name), c.name, commandText(c, c.description || c.label || ''), false)),
      t('No matches')),
    );
  }

  /**
   * One titled group of rows.
   * @param {string} title - Group heading, translated
   * @param {HTMLElement[]} rows - Its rows
   * @param {string} emptyText - Shown when it has none, translated
   * @returns {HTMLElement} The group
   * @private
   */
  _group(title, rows, emptyText) {
    const group = document.createElement('div');
    group.className = 'command-page-group';
    const h = document.createElement('h3');
    h.className = 'command-page-group-title';
    h.textContent = title;
    group.appendChild(h);
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'command-page-empty';
      // Filtering empties every group; say so only where nothing was there.
      empty.textContent = this.filter ? t('No matches') : emptyText;
      group.appendChild(empty);
    } else {
      group.append(...rows);
    }
    return group;
  }

  /**
   * One selectable row: the `/name`, then its description (or its error).
   * @param {string} key - Selection key
   * @param {string} name - Command name
   * @param {string} text - Description or error
   * @param {boolean} broken - Whether `text` is an error
   * @returns {HTMLElement} The row
   * @private
   */
  _row(key, name, text, broken) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'command-page-row' + (broken ? ' is-broken' : '') + (key === this.selectedKey ? ' selected' : '');
    row.dataset.key = key;
    if (key === this.selectedKey) row.setAttribute('aria-current', 'true');
    const code = document.createElement('code');
    code.className = 'command-page-row-name';
    code.textContent = '/' + name;
    const desc = document.createElement('span');
    desc.className = 'command-page-row-desc';
    desc.textContent = text;
    row.append(code, desc);
    return row;
  }

  /**
   * What the detail pane would be drawn from now: the selection and the entry
   * it names, as listed.
   * @returns {string} A comparable signature
   * @private
   */
  _detailSignature() {
    return JSON.stringify([this.selectedKey, this.draftName, this._entryFor(this.selectedKey), this.extensionNames.size]);
  }

  /** @private */
  _renderDetail() {
    const pane = /** @type {HTMLElement|null} */ (this.root?.querySelector('#command-page-detail') ?? null);
    if (!pane) return;
    this.editor?.dispose();
    this.editor = null;
    this.detailSignature = this._detailSignature();

    const entry = this._entryFor(this.selectedKey);
    if (this.selectedKey === NEW_KEY || entry?.kind === 'user') {
      const def = entry?.kind === 'user' ? entry.def : null;
      this.editor = mountCommandEditor(pane, def ? { def } : { name: this.draftName }, {
        onSaved: (name, scope) => {
          // The save already re-read the user commands; select what was written
          // once the list holds it.
          this.selectedKey = userKey({ scope, name });
          this.editor?.dispose();
          this.editor = null;
          this.detailSignature = null; // redraw even if the file came back unchanged
          void this.reload();
        },
        onDeleted: () => {
          this.selectedKey = null;
          this.editor?.dispose();
          this.editor = null;
          this.detailSignature = null;
          void this.reload();
        },
      });
      return;
    }
    if (entry?.kind === 'builtin') {
      pane.replaceChildren(this._builtinDetail(entry.cmd));
      return;
    }
    pane.replaceChildren(this._introDetail());
  }

  /**
   * The detail of a built-in command: what it does, and where it comes from.
   * @param {BuiltinCommand} cmd - The command
   * @returns {HTMLElement} The pane's content
   * @private
   */
  _builtinDetail(cmd) {
    const box = document.createElement('div');
    box.className = 'command-page-builtin';
    const h = document.createElement('h2');
    const code = document.createElement('code');
    code.textContent = '/' + cmd.name + (cmd.argsHint ? ' ' + cmd.argsHint : '');
    h.appendChild(code);
    box.appendChild(h);

    if (cmd.label) {
      const label = document.createElement('div');
      label.className = 'command-page-builtin-label';
      label.textContent = commandText(cmd, cmd.label);
      box.appendChild(label);
    }
    if (cmd.description) {
      const desc = document.createElement('p');
      desc.className = 'command-page-builtin-desc';
      desc.textContent = commandText(cmd, cmd.description);
      box.appendChild(desc);
    }

    if (cmd.extensionId) {
      const from = document.createElement('div');
      from.className = 'command-page-builtin-source';
      from.dataset.command = cmd.name;
      const text = document.createElement('span');
      // The extension's name is data inside the sentence, so it is a slot.
      const name = this.extensionNames.get(cmd.extensionId) || cmd.extensionId;
      const slots = { extension: `<strong class="command-page-builtin-ext">${escapeHtml(name)}</strong>` };
      text.innerHTML = withHtml(t('Built in to the {extension} extension.', htmlSlots(slots)), slots);
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'btn-ghost command-page-show-extension';
      link.dataset.action = 'show-extension';
      link.textContent = t('Show in Extensions');
      from.append(text, link);
      box.appendChild(from);
    }
    return box;
  }

  /**
   * The pane before anything is selected.
   * @returns {HTMLElement} The pane's content
   * @private
   */
  _introDetail() {
    const box = document.createElement('div');
    box.className = 'command-page-intro';
    const p = document.createElement('p');
    p.textContent = t('Type / in the message box to run any of these. Pick one to see what it does, or write your own: a saved prompt, run as /name.');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'modal-button btn-primary';
    btn.dataset.action = 'new';
    btn.textContent = t('New command…');
    box.append(p, btn);
    return box;
  }
}
