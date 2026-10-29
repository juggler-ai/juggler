//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   https://juggler.studio
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██
//
//   This program is free software: you can redistribute it and/or modify it under the terms of
//   the GNU Affero General Public License as published by the Free Software Foundation, either
//   version 3 of the License, or (at your option) any later version. This program is distributed
//   in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
//   warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the LICENSE file or
//   <https://www.gnu.org/licenses/agpl-3.0.html> for full terms.

import { escapeHtml } from '../../../sdk/lib/html.js';
import { t, markForTranslation, htmlSlots, withHtml } from '../../../sdk/lib/i18n.js';
import { renderMarkdown } from '../../../sdk/lib/markdown.js';
import { errorText } from '../../../sdk/lib/error-utils.js';
import { formatBytes } from '../../utils/format.js';
import { CHECK_SVG, GITHUB_ICON_SVG, DROPDOWN_ARROW_SVG, REFRESH_SVG } from '../../utils/icons.js';
import { markPopupOpen, closePopupById } from '../../utils/popup-manager.js';
import { presentModal } from '../../utils/modal-surface.js';
import { markDialog, trapFocus } from '../../utils/dialog-a11y.js';
import { showAlert, showConfirm, showPrompt } from '../modal-dialog.js';
import { presentPopup } from '../../utils/popup-surface.js';
import { applyMenuRoles, attachMenuKeyboard } from '../../utils/menu-roles.js';
import { addFilePath } from '../../utils/properties-panel-helpers.js';
import { skillPreviewShell, openInstalledSkillPreview } from './skill-preview.js';
import { fetchSkills, resetSkillsCache } from '../../services/skills.js';
import { reloadRegistries } from '../../registries/reload-registries.js';
import {
  fetchCatalog,
  fetchCatalogEntry,
  installSkill,
  uninstallSkill,
  addSource,
  removeSource,
  fetchDefaultSources,
  restoreDefaultSource,
  resetCatalogCache,
} from '../../services/skills-registry.js';

/** Categories dimmed and hidden unless "Show deprecated" is on. */
const DEPRECATED_CATEGORIES = new Set(['deprecated', 'in-progress']);

/**
 * The three install destinations offered by the "choose install location"
 * dialog. Labels are English sources, translated where the dialog is drawn;
 * hints are on-disk paths and stay as written.
 */
const SCOPE_OPTIONS = [
  { value: 'user:agents', label: markForTranslation('Shared with all agents'), hint: '~/.agents/skills' },
  { value: 'user:juggler', label: markForTranslation('Juggler only'), hint: '~/.juggler/skills' },
  { value: 'project:juggler', label: markForTranslation('This project (committed)'), hint: '.juggler/skills' },
];

/**
 * Skills tab: one controller with two views over the same skills system.
 *
 *  • Discover — the marketplace: fuzzy search + source/category filters over the
 *    cached catalog, cards with a scripts badge and a stateful install button,
 *    and a preview drawer (SKILL.md rendered through the escaping markdown path)
 *    with a scope picker.
 *  • Installed — the installed skills (from GET /api/skills), with scope/source
 *    badges, error/shadow flags, and uninstall.
 *
 * Installing/uninstalling writes into one of the four discovery roots and then
 * calls reloadRegistries(), so the change is live with no restart. All remote
 * strings are escaped; bodies render only via renderMarkdown(..,{escapeXml}).
 */
export class SkillsTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope).
   */
  constructor(host) {
    /** @type {HTMLElement} @private */
    this.host = host;
    /** @type {'discover'|'manage'} @private */
    this.mode = 'discover';
    /** @type {import('../../services/skills-registry.js').CatalogResponse|null} @private */
    this.catalog = null;
    /** @type {any[]} @private - Installed skills from GET /api/skills. */
    this.installed = [];
    /** @type {boolean} @private */
    this.loading = false;
    /** @type {string} @private */
    this.loadError = '';
    /** @type {string} @private - Fuzzy search query. */
    this.query = '';
    /** @type {string} @private - 'all' or a source id. */
    this.activeSource = 'all';
    /** @type {Set<string>} @private - Selected category chips. */
    this.activeCategories = new Set();
    /** @type {boolean} @private */
    this.hideScripts = false;
    /** @type {boolean} @private */
    this.showDeprecated = false;
    /** @type {import('../../services/skills-registry.js').CatalogEntry|null} @private - Entry shown in the preview. */
    this.preview = null;
    /** @type {(() => void)|null} @private - Releases the preview's Escape/Back popup token. */
    this._releasePreviewPopup = null;
  }

  /**
   * The controller's root element inside the tab section.
   * @returns {HTMLElement|null} The root, or null before render().
   * @private
   */
  get root() {
    return this.host.querySelector('#skills-tab-root');
  }

  /** Build the static chrome and wire delegated listeners (called once). */
  render() {
    const root = this.root;
    if (!root) return;
    root.innerHTML = `
      <div class="skills-header">
        <div class="skills-modeswitch" role="tablist">
          <button class="skills-mode active" data-mode="discover" role="tab">${escapeHtml(t('Discover'))}</button>
          <button class="skills-mode" data-mode="manage" role="tab">${escapeHtml(t('Installed'))}</button>
        </div>
        <button class="btn-ghost skills-refresh" data-action="refresh" title="${escapeHtml(t('Refresh'))}" aria-label="${escapeHtml(t('Refresh'))}">${REFRESH_SVG}</button>
      </div>
      <div class="skills-body" id="skills-body"></div>
      <div class="skills-drawer" id="skills-drawer" hidden></div>
    `;
    root.querySelectorAll('.skills-mode').forEach((btn) => {
      btn.addEventListener('click', () => {
        const m = /** @type {HTMLElement} */ (btn).dataset.mode;
        if (m === 'discover' || m === 'manage') this._setMode(m);
      });
    });
    // Event delegation for all body/drawer actions (cards are re-rendered often).
    root.addEventListener('click', (e) => this._onClick(/** @type {MouseEvent} */ (e)));
    root.addEventListener('input', (e) => this._onInput(e));
    // "/" focuses the search box while the tab is visible (scoped, not global).
    root.addEventListener('keydown', (e) => {
      const ev = /** @type {KeyboardEvent} */ (e);
      const tag = /** @type {HTMLElement} */ (ev.target)?.tagName;
      if (ev.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        const search = root.querySelector('#skills-search');
        if (search) {
          ev.preventDefault();
          /** @type {HTMLInputElement} */ (search).focus();
        }
      }
    });
  }

  /** Tab shown: load catalog + installed skills, rescanning disk each open. */
  async show() {
    if (!this.catalog && !this.loading) {
      await this._loadAll(false);
      return;
    }
    // Re-opened: rescan the installed skill folders so a skill added or removed
    // on disk outside the app appears without a restart. The backend scans disk
    // live per request, so dropping our client cache and re-fetching is enough;
    // the remote catalog stays cached (Refresh re-fetches it on demand).
    if (!this.loading) {
      resetSkillsCache();
      try {
        this.installed = await fetchSkills();
      } catch {
        // keep the prior list on a transient failure
      }
    }
    this._renderBody();
  }

  /** Tab hidden: nothing to tear down (no pollers). */
  hide() {}

  /** Panel closed: collapse the preview drawer. */
  close() {
    this._closePreview();
  }

  /** Element disconnected: no global listeners to remove. */
  dispose() {
    // The preview holds a popup-manager token and a focus trap, both global;
    // the add-source menu is drawn into <body>. Everything else this tab takes
    // is a listener on its own root.
    this._closePreview();
    closePopupById('skills-add-source-menu');
  }

  /**
   * Refresh the active view in the way appropriate to it: Discover re-fetches the
   * registries over the network; Installed rescans the local skill folders. Wired
   * to the icon button on the mode-switch row.
   * @private
   */
  _refreshActiveTab() {
    if (this.mode === 'manage') {
      this._refreshInstalled();
    } else {
      this._loadAll(true);
    }
  }

  /**
   * Load the catalog and the installed-skill list together. Always drops the
   * installed-skills client cache first so the installed list reflects the disk
   * on every load (the backend scans disk per request); `refresh` additionally
   * forces the backend to re-fetch the remote registries over the network.
   * @param {boolean} refresh - Force the backend to re-fetch registries (network).
   * @private
   */
  async _loadAll(refresh) {
    this.loading = true;
    this.loadError = '';
    this._renderBody();
    resetSkillsCache();
    try {
      const [catalog, installed] = await Promise.all([
        fetchCatalog({ refresh, force: refresh }),
        fetchSkills(),
      ]);
      this.catalog = catalog;
      this.installed = installed;
    } catch (err) {
      this.loadError = errorText(err);
    } finally {
      this.loading = false;
      this._renderBody();
    }
  }

  /**
   * Rescan the local skill folders for the Installed view: drop the client cache
   * and re-fetch GET /api/skills (the backend scans disk live per request). The
   * remote catalog is untouched — that is Discover's refresh.
   * @private
   */
  async _refreshInstalled() {
    this.loading = true;
    this.loadError = '';
    this._renderBody();
    resetSkillsCache();
    try {
      this.installed = await fetchSkills();
    } catch (err) {
      this.loadError = errorText(err);
    } finally {
      this.loading = false;
      this._renderBody();
    }
  }

  /**
   * Switch between the Discover and Installed views.
   * @param {'discover'|'manage'} mode - The view to show.
   * @private
   */
  _setMode(mode) {
    this.mode = mode;
    const root = this.root;
    if (root) {
      root.querySelectorAll('.skills-mode').forEach((b) => {
        b.classList.toggle('active', /** @type {HTMLElement} */ (b).dataset.mode === mode);
      });
    }
    this._closePreview();
    this._renderBody();
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  /**
   * Render the active view (Discover or Installed) into the body container.
   * @private
   */
  _renderBody() {
    const body = this.host.querySelector('#skills-body');
    if (!body) return;
    if (this.loadError) {
      body.innerHTML = `<div class="skills-empty">${escapeHtml(this.loadError)}</div>`;
      return;
    }
    if (this.loading) {
      body.innerHTML = `<div class="skills-loading"><juggler-spinner style="--size: 1.75rem"></juggler-spinner></div>`;
      return;
    }
    body.innerHTML = this.mode === 'manage' ? this._manageHtml() : this._discoverHtml();
    this._hydrateFilePaths(/** @type {HTMLElement} */ (body));
  }

  /**
   * Replace every `.skills-filepath-mount` placeholder in a container with the
   * shared file-path control (mono path + copy + reveal-in-Finder buttons). The
   * views emit these placeholders as plain HTML strings; this hydrates them into
   * live DOM after innerHTML is set, matching the logs tab's file-path control.
   * @param {HTMLElement|null} container - The subtree to hydrate.
   * @private
   */
  _hydrateFilePaths(container) {
    if (!container) return;
    container.querySelectorAll('.skills-filepath-mount').forEach((el) => {
      const path = /** @type {HTMLElement} */ (el).dataset.path || '';
      el.textContent = '';
      if (path) addFilePath(/** @type {HTMLElement} */ (el), path);
    });
  }

  /**
   * Build the Discover view markup (toolbar, filter chips, card grid).
   * @returns {string} The Discover HTML.
   * @private
   */
  _discoverHtml() {
    const sources = this.catalog?.sources || [];
    const entries = this._filteredEntries();
    const categories = this._availableCategories();

    // "All" is a synthetic filter, not a source, so it has no remove control.
    // Every real source is removable (seeds included — the backend treats them
    // all equally). The remove × is a SIBLING of the [data-source-chip] button,
    // not a child: _onClick tests [data-source-chip] first with closest(), so a
    // nested × would select the source instead of removing it.
    const allChip = `<button class="skills-chip ${this.activeSource === 'all' ? 'active' : ''}" data-source-chip="all">${escapeHtml(t('All'))}</button>`;
    const sourceChips =
      allChip +
      sources
        .map((s) => {
          const chip = `<button class="skills-chip ${this.activeSource === s.id ? 'active' : ''}" data-source-chip="${escapeHtml(s.id)}">${escapeHtml(s.label)}</button>`;
          return `<span class="skills-chip-wrap">${chip}<button class="skills-chip-remove" data-remove-source="${escapeHtml(s.id)}" title="${escapeHtml(t('Remove this source'))}" aria-label="${escapeHtml(t('Remove source {label}', { label: s.label }))}">&times;</button></span>`;
        })
        .join('');

    const catChips = categories
      .map(
        (c) =>
          `<button class="skills-chip ${this.activeCategories.has(c) ? 'active' : ''} ${DEPRECATED_CATEGORIES.has(c) ? 'dim' : ''}" data-cat-chip="${escapeHtml(c)}">${escapeHtml(c)}</button>`
      )
      .join('');

    const staleNote = sources.some((s) => s.stale || s.error)
      ? `<div class="skills-stale">${escapeHtml(t('Showing cached results — some sources couldn\'t be refreshed.'))}</div>`
      : '';

    const cards = entries.length
      ? entries.map((e) => this._cardHtml(e)).join('')
      : `<div class="skills-empty">${escapeHtml(t('No skills match your filters.'))}</div>`;

    return `
      <div class="skills-toolbar">
        <input type="text" id="skills-search" class="skills-search" placeholder="${escapeHtml(t('Search skills…  ( / )'))}" value="${escapeHtml(this.query)}" />
        <button class="skills-btn" data-action="add-source" aria-haspopup="menu" aria-expanded="false" title="${escapeHtml(t('Add a GitHub repository (owner/repo) as a skills source'))}">${escapeHtml(t('Add source'))} ${DROPDOWN_ARROW_SVG}</button>
      </div>
      <div class="skills-chiprow">${sourceChips}</div>
      ${catChips ? `<div class="skills-chiprow skills-catrow">${catChips}</div>` : ''}
      <div class="skills-togglerow">
        <label><input type="checkbox" data-toggle="hideScripts" ${this.hideScripts ? 'checked' : ''}/> ${escapeHtml(t('Hide skills that run scripts'))}</label>
        <label><input type="checkbox" data-toggle="showDeprecated" ${this.showDeprecated ? 'checked' : ''}/> ${escapeHtml(t('Show deprecated / in-progress'))}</label>
      </div>
      ${staleNote}
      <div class="skills-grid">${cards}</div>
    `;
  }

  /**
   * Build one catalog card's markup.
   * @param {import('../../services/skills-registry.js').CatalogEntry} e - The entry.
   * @returns {string} The card HTML.
   * @private
   */
  _cardHtml(e) {
    const cat = e.category?.length ? escapeHtml(e.category.join(' / ')) : '';
    const sourceLabel = this._sourceLabel(e.source);
    const scripts = e.hasScripts ? `<span class="skills-badge tint-blue" title="${escapeHtml(t('Contains scripts that can run'))}">${escapeHtml(t('scripts'))}</span>` : '';
    const err = e.error ? `<span class="skills-badge error tint-red" title="${escapeHtml(e.error)}">⚠ ${escapeHtml(t('error'))}</span>` : '';
    const meta = [sourceLabel, cat].filter(Boolean).join(' · ');

    let installBtn;
    if (e.installed && !e.installed.upToDate) {
      installBtn = `<button class="skills-btn install update" data-install="${escapeHtml(e.id)}">${escapeHtml(t('Update'))}</button>`;
    } else if (e.installed) {
      installBtn = `<span class="skills-installed">${CHECK_SVG} ${escapeHtml(t('Installed'))}</span>`;
    } else {
      installBtn = `<button class="skills-btn install" data-install="${escapeHtml(e.id)}">${escapeHtml(t('Install'))}</button>`;
    }

    return `
      <div class="skills-card surface-card ${e.installed ? 'is-installed' : ''}" data-id="${escapeHtml(e.id)}">
        <div class="skills-card-head">
          <span class="skills-card-name">${escapeHtml(e.name || t('(unnamed)'))}</span>
          ${scripts}${err}
        </div>
        <div class="skills-card-meta">${escapeHtml(meta)}</div>
        <div class="skills-card-desc">${escapeHtml(e.description || t('No description.'))}</div>
        <div class="skills-card-actions">
          <button class="skills-btn" data-preview="${escapeHtml(e.id)}" title="${escapeHtml(t('View this skill\'s SKILL.md and files before installing'))}">${escapeHtml(t('Details'))}</button>
          ${installBtn}
        </div>
      </div>
    `;
  }

  /**
   * Build the Installed view markup (installed skills + uninstall).
   * @returns {string} The Installed HTML.
   * @private
   */
  _manageHtml() {
    const skills = [...this.installed].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (!skills.length) {
      const markup = { discover: `<b>${escapeHtml(t('Discover'))}</b>` };
      return `<div class="skills-empty">${withHtml(t('No skills installed yet. Switch to {discover} to add some.', htmlSlots(markup)), markup)}</div>`;
    }
    const rows = skills
      .map((s) => {
        const badge = `<span class="skills-scope-badge">${escapeHtml(s.scope)}-${escapeHtml(s.source)}</span>`;
        const scripts = s.hasScripts ? `<span class="skills-badge tint-blue">${escapeHtml(t('scripts'))}</span>` : '';
        const flag = s.error
          ? `<span class="skills-badge error tint-red" title="${escapeHtml(s.error)}">⚠ ${escapeHtml(s.error)}</span>`
          : s.shadowedBy
            ? `<span class="skills-badge tint-neutral" title="${escapeHtml(t('Shadowed by {name}', { name: s.shadowedBy }))}">${escapeHtml(t('shadowed by {name}', { name: s.shadowedBy }))}</span>`
            : '';
        const pathRow = s.path
          ? `<div class="skills-filepath-mount" data-path="${escapeHtml(s.path)}"></div>`
          : '';
        const ref = `${escapeHtml(s.scope)}:${escapeHtml(s.source)}:${escapeHtml(s.name)}`;
        return `
          <div class="skills-manage-row surface-card">
            <div class="skills-manage-main">
              <div class="skills-card-head">
                <span class="skills-card-name">${escapeHtml(s.name)}</span>
                ${badge}${scripts}${flag}
              </div>
              <div class="skills-card-desc">${escapeHtml(s.description || t('No description.'))}</div>
              ${pathRow}
            </div>
            <div class="skills-manage-actions">
              <button class="skills-btn" data-preview-installed="${ref}" title="${escapeHtml(t('View this skill\'s SKILL.md and files'))}">${escapeHtml(t('Details'))}</button>
              <button class="skills-btn danger" data-uninstall="${ref}">${escapeHtml(t('Uninstall'))}</button>
            </div>
          </div>
        `;
      })
      .join('');
    return `<div class="skills-manage-list">${rows}</div>`;
  }

  // ── filtering ─────────────────────────────────────────────────────────────

  /**
   * Apply the active source/category/scripts/deprecated filters and fuzzy search.
   * @returns {import('../../services/skills-registry.js').CatalogEntry[]} The filtered, ranked entries.
   * @private
   */
  _filteredEntries() {
    let entries = this.catalog?.entries || [];
    if (this.activeSource !== 'all') {
      entries = entries.filter((e) => e.source === this.activeSource);
    }
    if (!this.showDeprecated) {
      entries = entries.filter((e) => !(e.category || []).some((c) => DEPRECATED_CATEGORIES.has(c)));
    }
    if (this.hideScripts) {
      entries = entries.filter((e) => !e.hasScripts);
    }
    if (this.activeCategories.size) {
      entries = entries.filter((e) => (e.category || []).some((c) => this.activeCategories.has(c)));
    }
    const q = this.query.trim().toLowerCase();
    if (q) {
      const scored = [];
      for (const e of entries) {
        const hay = `${e.name} ${e.description} ${(e.category || []).join(' ')}`.toLowerCase();
        const score = subsequenceScore(q, hay);
        if (score >= 0) scored.push({ e, score });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.map((s) => s.e);
    }
    return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /**
   * The distinct categories present in the source-filtered set.
   * @returns {string[]} Sorted category names.
   * @private
   */
  _availableCategories() {
    let entries = this.catalog?.entries || [];
    if (this.activeSource !== 'all') entries = entries.filter((e) => e.source === this.activeSource);
    const set = new Set();
    for (const e of entries) for (const c of e.category || []) set.add(c);
    return [...set].sort();
  }

  /**
   * The display label for a source id.
   * @param {string} id - The source id.
   * @returns {string} The label, or the id if unknown.
   * @private
   */
  _sourceLabel(id) {
    const s = (this.catalog?.sources || []).find((x) => x.id === id);
    return s ? s.label : id;
  }

  // ── events ────────────────────────────────────────────────────────────────

  /**
   * Handle input on the search box and filter toggles.
   * @param {Event} e - The input event.
   * @private
   */
  _onInput(e) {
    const target = /** @type {HTMLInputElement} */ (e.target);
    if (target.id === 'skills-search') {
      this.query = target.value;
      this._rerenderGrid();
      return;
    }
    if (target.dataset && target.dataset.toggle) {
      if (target.dataset.toggle === 'hideScripts') this.hideScripts = target.checked;
      if (target.dataset.toggle === 'showDeprecated') this.showDeprecated = target.checked;
      this._renderBody();
    }
  }

  /**
   * Re-render only the grid so typing in search doesn't blur the input by
   * rebuilding the whole toolbar.
   * @private
   */
  _rerenderGrid() {
    const grid = this.host.querySelector('.skills-grid');
    if (!grid) {
      this._renderBody();
      return;
    }
    const entries = this._filteredEntries();
    grid.innerHTML = entries.length
      ? entries.map((e) => this._cardHtml(e)).join('')
      : `<div class="skills-empty">${escapeHtml(t('No skills match your filters.'))}</div>`;
  }

  /**
   * Delegated click handler for chips, buttons, cards, and the drawer.
   * @param {MouseEvent} e - The click event.
   * @private
   */
  _onClick(e) {
    const el = /** @type {HTMLElement} */ (e.target);
    const closest = (/** @type {string} */ sel) => /** @type {HTMLElement|null} */ (el.closest(sel));

    let node;
    if ((node = closest('[data-source-chip]'))) {
      this.activeSource = node.dataset.sourceChip || 'all';
      this.activeCategories.clear();
      this._renderBody();
    } else if ((node = closest('[data-cat-chip]'))) {
      const c = node.dataset.catChip || '';
      if (this.activeCategories.has(c)) this.activeCategories.delete(c);
      else this.activeCategories.add(c);
      this._renderBody();
    } else if ((node = closest('[data-action]'))) {
      const action = node.dataset.action;
      if (action === 'refresh') this._refreshActiveTab();
      else if (action === 'add-source') this._openAddSourceMenu(node);
      else if (action === 'drawer-close') this._closePreview();
    } else if ((node = closest('[data-preview]'))) {
      this._openPreview(node.dataset.preview || '');
    } else if ((node = closest('[data-preview-installed]'))) {
      this._openInstalledPreview(node.dataset.previewInstalled || '');
    } else if ((node = closest('[data-install]'))) {
      const entry = this._entryById(node.dataset.install || '');
      if (entry) this._installWithPrompt(entry);
    } else if ((node = closest('[data-uninstall]'))) {
      const [scope, source, name] = (node.dataset.uninstall || '').split(':');
      this._uninstall(scope || '', source || '', name || '');
    } else if (closest('[data-drawer-install]')) {
      this._installWithPrompt(this.preview);
    } else if ((node = closest('[data-remove-source]'))) {
      this._removeSource(node.dataset.removeSource || '');
    }
  }

  /**
   * Look up a catalog entry by its opaque id.
   * @param {string} id - The "<source>:<path>" id.
   * @returns {import('../../services/skills-registry.js').CatalogEntry|null} The entry, or null.
   * @private
   */
  _entryById(id) {
    return (this.catalog?.entries || []).find((e) => e.id === id) || null;
  }

  // ── install / uninstall ───────────────────────────────────────────────────

  /**
   * Install one entry into a root, prompting to overwrite on a name collision.
   * @param {import('../../services/skills-registry.js').CatalogEntry} entry - The entry.
   * @param {'user'|'project'} scope - Target scope.
   * @param {'juggler'|'agents'} target - Target root source.
   * @param {'install'|'overwrite'} [mode] - Write mode.
   * @private
   */
  async _install(entry, scope, target, mode) {
    if (!entry.name) {
      await this._alert(t('This skill has no valid name to install under.'));
      return;
    }
    try {
      await installSkill({ source: entry.source, path: entry.path, targetName: entry.name, scope, target, mode });
    } catch (err) {
      if (/** @type {any} */ (err).collision) {
        const existing = /** @type {any} */ (err).existing || entry.name;
        const ok = await this._confirm(t('A skill named "{existing}" already exists here. Overwrite it?', { existing }));
        if (ok) {
          await this._install(entry, scope, target, 'overwrite');
        }
        return;
      }
      await this._alert(errorText(err));
      return;
    }
    await this._afterMutation();
    this._closePreview();
  }

  /**
   * Install an entry after asking where to put it. Both the card and the preview
   * install buttons funnel through here, so they behave identically: a small
   * dialog offers the three install locations as action buttons, and the chosen
   * "<scope>:<target>" drives the install.
   * @param {import('../../services/skills-registry.js').CatalogEntry|null} entry - The entry to install.
   * @private
   */
  async _installWithPrompt(entry) {
    if (!entry) return;
    const choice = await this._promptInstallScope(entry);
    if (!choice) return;
    const [scope, target] = choice.split(':');
    await this._install(entry, /** @type {any} */ (scope), /** @type {any} */ (target));
  }

  /**
   * Show the "choose install location" dialog: the three destinations as a clear
   * set of action buttons (label + on-disk path). Uses the standard centered
   * modal chrome and popup-manager dismissal (backdrop / Escape / Back).
   * @param {import('../../services/skills-registry.js').CatalogEntry} entry - The entry being installed (for the title).
   * @returns {Promise<string|null>} The chosen "<scope>:<target>" value, or null if dismissed.
   * @private
   */
  _promptInstallScope(entry) {
    return new Promise((resolve) => {
      const modal = presentModal({
        className: 'skills-scope-dialog',
        dismissSelectors: ['[data-scope-cancel]', '.skills-scope-backdrop'],
        onClose: (/** @type {string|null|undefined} */ value) => resolve(value ?? null),
      });
      const host = modal.root;
      const optionsHTML = SCOPE_OPTIONS.map(
        (o) => `
          <button class="skills-scope-action" data-scope="${escapeHtml(o.value)}">
            <span class="skills-scope-action-label">${escapeHtml(t(o.label))}</span>
            <span class="skills-scope-action-hint">${escapeHtml(o.hint)}</span>
          </button>`
      ).join('');
      host.innerHTML = `
        <modal-backdrop class="skills-scope-backdrop"></modal-backdrop>
        <modal-panel class="skills-scope-panel">
          <header class="skills-scope-dialog-header">
            <h2 class="skills-scope-dialog-title">${escapeHtml(t('Install “{name}”', { name: entry.name || t('skill') }))}</h2>
          </header>
          <p class="skills-scope-dialog-sub">${escapeHtml(t('Choose where to install this skill:'))}</p>
          <div class="skills-scope-actions">${optionsHTML}</div>
          <div class="skills-scope-dialog-footer">
            <button class="skills-btn" data-scope-cancel>${escapeHtml(t('Cancel'))}</button>
          </div>
        </modal-panel>
      `;
      markDialog(host.querySelector('modal-panel'), host.querySelector('.skills-scope-dialog-title'));
      host.addEventListener('click', (e) => {
        const pick = /** @type {HTMLElement} */ (e.target).closest('[data-scope]');
        if (pick) modal.close(/** @type {HTMLElement} */ (pick).dataset.scope || null);
      });
    });
  }

  /**
   * Uninstall a skill after confirmation.
   * @param {string} scope - The scope.
   * @param {string} source - The root source.
   * @param {string} name - The skill name.
   * @private
   */
  async _uninstall(scope, source, name) {
    const ok = await this._confirm(t('Uninstall "{name}" ({scope}-{source})? This deletes its files.', { name, scope, source }));
    if (!ok) return;
    try {
      await uninstallSkill(/** @type {any} */ (scope), /** @type {any} */ (source), name);
    } catch (err) {
      await this._alert(errorText(err));
      return;
    }
    await this._afterMutation();
  }

  /**
   * Reload registries and refresh both data sets after an install/uninstall.
   *
   * The visible list refresh ({@link _loadAll}) must NOT be gated on
   * reloadRegistries(): that rebuild defers to local quiescence (it never
   * resolves while a conversation is mid-turn) and can reject if a plugin's
   * init() throws — either of which would otherwise leave the just-mutated list
   * stale on screen. So we kick the registry rebuild off without awaiting it
   * (it still applies live once quiescent) and always refresh the list.
   * @private
   */
  async _afterMutation() {
    resetSkillsCache();
    resetCatalogCache();
    reloadRegistries().catch((err) => {
      console.warn('[Skills] registry reload after mutation failed:', err);
    });
    await this._loadAll(false);
  }

  // ── preview drawer ────────────────────────────────────────────────────────

  /**
   * Open the shared installed-skill preview popup for an Installed-tab row.
   * Reuses {@link openInstalledSkillPreview} — the same modal the conversation
   * properties panel uses — so the two never drift and no Install button shows.
   * @param {string} ref - The "<scope>:<source>:<name>" row reference.
   * @private
   */
  _openInstalledPreview(ref) {
    const [scope, source, name] = (ref || '').split(':');
    const skill = this.installed.find((s) => s.scope === scope && s.source === source && s.name === name);
    if (skill) openInstalledSkillPreview(skill);
  }

  /**
   * Open the preview drawer for a catalog entry and load its body/manifest.
   * @param {string} id - The entry id.
   * @private
   */
  async _openPreview(id) {
    const entry = this._entryById(id);
    if (!entry) return;
    this.preview = entry;
    const drawer = this.host.querySelector('#skills-drawer');
    if (!drawer) return;
    drawer.removeAttribute('hidden');
    // Escape and the browser/mobile Back button dismiss via popup-manager,
    // matching every other app modal, and the open drawer holds Tab; one
    // release ends both.
    if (!this._releasePreviewPopup) {
      const releasePopup = markPopupOpen(() => this._closePreview());
      const releaseTrap = trapFocus(drawer);
      this._releasePreviewPopup = () => { releasePopup(); releaseTrap(); };
    }
    const title = escapeHtml(entry.name || t('Skill'));
    drawer.innerHTML = this._previewShell(
      title,
      `<div class="skills-loading"><juggler-spinner style="--size:1.5rem"></juggler-spinner></div>`,
      ''
    );
    let detail;
    try {
      detail = await fetchCatalogEntry(entry.source, entry.path);
    } catch (err) {
      if (this.preview !== entry) return; // switched away while loading
      drawer.innerHTML = this._previewShell(title, `<div class="skills-empty">${escapeHtml(errorText(err))}</div>`, '');
      return;
    }
    if (this.preview !== entry) return; // switched away while loading
    drawer.innerHTML = this._drawerHtml(entry, detail);
    this._hydrateFilePaths(/** @type {HTMLElement} */ (drawer));
  }

  /**
   * Wrap preview content in the standard centered-modal chrome. Delegates to the
   * shared {@link skillPreviewShell} so the Discover drawer, the Installed-tab
   * popup, and the conversation properties panel all use identical chrome.
   * @param {string} title - Pre-escaped dialog title.
   * @param {string} bodyHtml - Scrollable body markup.
   * @param {string} footerHtml - Footer markup (omitted when empty).
   * @returns {string} The modal HTML.
   * @private
   */
  _previewShell(title, bodyHtml, footerHtml) {
    return skillPreviewShell(title, bodyHtml, footerHtml);
  }

  /**
   * Build the preview drawer markup.
   * @param {import('../../services/skills-registry.js').CatalogEntry} entry - The entry.
   * @param {{ body: string, files: Array<{path:string,size:number,runs:boolean}> }} detail - The fetched body + manifest.
   * @returns {string} The drawer HTML.
   * @private
   */
  _drawerHtml(entry, detail) {
    const runs = detail.files.filter((f) => f.runs);
    const runsHtml = runs.length
      ? `<div class="skills-runs">
           <div class="skills-runs-title">${escapeHtml(t('Files that run'))}</div>
           ${runs.map((f) => `<div class="skills-run-file">${escapeHtml(f.path)} <span class="skills-file-size">${formatBytes(f.size)}</span></div>`).join('')}
         </div>`
      : '';

    // The catalog serves the raw SKILL.md, frontmatter and all. Lift the
    // frontmatter into a proper key/value table and render only the instruction
    // body as markdown — otherwise the `--- … ---` block renders as one giant
    // setext heading at the top of the preview.
    const { fields, body: markdownBody } = splitFrontmatter(detail.body || '');
    const metaTable = fields.length
      ? `<table class="skills-meta-table"><tbody>${fields
        .map((f) => `<tr><th>${escapeHtml(f.key)}</th><td>${escapeHtml(f.value)}</td></tr>`)
        .join('')}</tbody></table>`
      : '';

    const fileList = detail.files.length
      ? `<div class="skills-section surface-card skills-files">
           <div class="skills-section-title">${escapeHtml(t('Files ({count})', { count: detail.files.length }))}</div>
           <div class="skills-files-list">
             ${detail.files
                .map(
                  (f) =>
                    `<div class="skills-file ${f.runs ? 'runs' : ''}"><span class="skills-file-path">${escapeHtml(f.path)}</span><span class="skills-file-size">${formatBytes(f.size)}</span></div>`
                )
                .join('')}
           </div>
         </div>`
      : '';

    const slugMarkup = { name: `<code>${escapeHtml(entry.name)}</code>` };
    const slugNote = entry.slugged
      ? `<div class="skills-slug-note">${withHtml(t('Will install as {name} (renamed to a valid skill name).', htmlSlots(slugMarkup)), slugMarkup)}</div>`
      : '';
    const meta = [
      escapeHtml(this._sourceLabel(entry.source)),
      entry.category?.length ? escapeHtml(entry.category.join(' / ')) : '',
      entry.license ? escapeHtml(t('License: {license}', { license: entry.license })) : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const installed = entry.installed
      ? `<div class="skills-section surface-card skills-installed-section">
           <div class="skills-drawer-installed">${CHECK_SVG} ${escapeHtml(entry.installed.upToDate ? t('Installed') : t('Installed — update available'))}</div>
           <div class="skills-filepath-mount" data-path="${escapeHtml(entry.installed.path)}"></div>
         </div>`
      : '';

    const body = `
      ${meta ? `<div class="skills-preview-meta">${meta}</div>` : ''}
      ${metaTable}
      <div class="skills-safety">${escapeHtml(t('Installing downloads & writes files — it never runs anything. A skill\'s text still enters the model\'s context, so review it below before trusting it.'))}</div>
      ${installed}
      ${runsHtml}
      <div class="skills-drawer-body markdown">${renderMarkdown(markdownBody, { escapeXml: true })}</div>
      ${fileList}
      ${slugNote}
    `;
    const footer = `
      <a class="skills-btn" href="${escapeHtml(entry.sourceUrl)}" target="_blank" rel="noopener noreferrer">${GITHUB_ICON_SVG} ${escapeHtml(t('View on GitHub'))}</a>
      <button class="skills-btn install btn-primary" data-drawer-install>${escapeHtml(entry.installed ? t('Reinstall') : t('Install'))}</button>
    `;
    return this._previewShell(escapeHtml(entry.name || t('(unnamed)')), body, footer);
  }

  /**
   * Collapse and clear the preview drawer.
   * @private
   */
  _closePreview() {
    this.preview = null;
    if (this._releasePreviewPopup) {
      this._releasePreviewPopup();
      this._releasePreviewPopup = null;
    }
    const drawer = this.host.querySelector('#skills-drawer');
    if (drawer) {
      drawer.setAttribute('hidden', '');
      drawer.innerHTML = '';
    }
  }

  // ── add / remove source ───────────────────────────────────────────────────

  /**
   * Open the add-source menu anchored to the "Add source" button: a manual URL
   * entry plus one-click restore of each default seed (so a user who removed the
   * seeds — even all of them — can get them back). Defaults already configured
   * are shown disabled. Built with the shared menu utility + presentPopup, which
   * owns body-append, anchored/sheet placement, and dismissal.
   * @param {HTMLElement} anchor - The trigger button to anchor the menu to.
   * @private
   */
  async _openAddSourceMenu(anchor) {
    let defaults = /** @type {Array<{id:string,label:string,repo:string,trust:string}>} */ ([]);
    try {
      defaults = await fetchDefaultSources();
    } catch {
      defaults = [];
    }
    const present = new Set((this.catalog?.sources || []).map((s) => s.id));

    const surface = document.createElement('nav');
    surface.className = 'dropdown-menu skills-add-source-menu show';
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

    // Manual URL entry.
    const urlItem = document.createElement('li');
    urlItem.className = 'menu-item';
    urlItem.textContent = t('Enter a URL…');
    urlItem.addEventListener('click', () => {
      close();
      this._promptAddSource();
    });
    menu.appendChild(urlItem);

    if (defaults.length) {
      const divider = document.createElement('li');
      divider.className = 'menu-divider';
      menu.appendChild(divider);

      const header = document.createElement('li');
      header.className = 'menu-header';
      header.textContent = t('Suggested sources');
      menu.appendChild(header);

      for (const s of defaults) {
        const item = document.createElement('li');
        const added = present.has(s.id);
        if (added) {
          // Already configured: shown for context, greyed, not pickable. Restore
          // by seed id keeps the curated label/trust (not a raw custom repo).
          item.className = 'menu-item unavailable';
          item.setAttribute('aria-disabled', 'true');
          item.textContent = t('{label} — added', { label: s.label });
        } else {
          item.className = 'menu-item';
          item.textContent = s.label;
          item.addEventListener('click', async () => {
            close();
            try {
              await restoreDefaultSource(s.id);
            } catch (err) {
              await this._alert(errorText(err));
              return;
            }
            await this._loadAll(true);
          });
        }
        menu.appendChild(item);
      }
    }

    applyMenuRoles(menu, t('Add source'));
    surface.appendChild(menu);
    release = presentPopup({
      surface,
      anchor,
      id: 'skills-add-source-menu',
      onClose: close,
      align: 'right',
      insideSelectors: ['.skills-add-source-menu'],
    });
    attachMenuKeyboard(menu, { close });
    anchor.setAttribute('aria-expanded', 'true');
  }

  /**
   * Prompt for a github URL/owner-repo and add it as a custom source.
   * @private
   */
  async _promptAddSource() {
    const url = await showPrompt(t('Paste a github.com/owner/repo URL or owner/repo:'), '', t('Add skills source'));
    if (!url || !url.trim()) return;
    try {
      await addSource(url.trim());
    } catch (err) {
      await this._alert(errorText(err));
      return;
    }
    await this._loadAll(true);
  }

  /**
   * Remove a custom source after confirmation.
   * @param {string} id - The source id.
   * @private
   */
  async _removeSource(id) {
    const ok = await this._confirm(t('Remove this source? Installed skills are unaffected.'));
    if (!ok) return;
    try {
      await removeSource(id);
    } catch (err) {
      await this._alert(errorText(err));
      return;
    }
    if (this.activeSource === id) this.activeSource = 'all';
    await this._loadAll(false);
  }

  // ── small dialog helpers ──────────────────────────────────────────────────

  /**
   * Show a confirm dialog titled for this tab.
   * @param {string} msg - The prompt text.
   * @returns {Promise<boolean>} True when confirmed.
   * @private
   */
  async _confirm(msg) {
    return !!(await showConfirm(msg, t('Skills')));
  }

  /**
   * Show an alert dialog titled for this tab.
   * @param {string} msg - The message.
   * @private
   */
  async _alert(msg) {
    await showAlert(msg, t('Skills'));
  }
}

/**
 * Split a SKILL.md into its leading YAML frontmatter fields and the remaining
 * markdown body. The catalog serves the raw file, so the preview must peel the
 * `--- … ---` header off itself; without this it renders as a giant setext
 * heading. Only flat `key: value` scalars are parsed (all the skill spec uses) —
 * surrounding quotes are stripped and non-`key: value` lines (nested/multiline
 * YAML) are skipped rather than mis-parsed. No frontmatter → all body, no fields.
 * @param {string} raw - The raw SKILL.md text.
 * @returns {{ fields: Array<{key: string, value: string}>, body: string }} Parsed fields + the body after the frontmatter.
 */
function splitFrontmatter(raw) {
  const text = raw || '';
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { fields: [], body: text };
  /** @type {Array<{key: string, value: string}>} */
  const fields = [];
  for (const line of (match[1] || '').split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!kv) continue; // nested/multiline/blank — skip rather than mangle
    let value = (kv[2] || '').trim();
    if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    fields.push({ key: kv[1] || '', value });
  }
  return { fields, body: text.slice(match[0].length) };
}

/**
 * Tiny subsequence fuzzy scorer: returns a score ≥ 0 when every character of
 * query appears in order within text (contiguous runs and early matches score
 * higher), or -1 when it doesn't match at all. Hand-rolled to avoid a dependency.
 * @param {string} query - Lowercased query.
 * @param {string} text - Lowercased haystack.
 * @returns {number} The match score, or -1 for no match.
 */
function subsequenceScore(query, text) {
  if (!query) return 0;
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (let qi = 0; qi < query.length; qi++) {
    const c = query[qi];
    let found = -1;
    for (let j = ti; j < text.length; j++) {
      if (text[j] === c) {
        found = j;
        break;
      }
    }
    if (found === -1) return -1;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - Math.min(found - ti, 10);
    ti = found + 1;
  }
  return score;
}
