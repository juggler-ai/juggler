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

/**
 * Shared skill-preview UI — the single home for the SKILL.md preview modal.
 *
 * The Discover tab (skills-tab.js) previews a *catalog* entry (raw SKILL.md +
 * an Install footer) and owns its own drawer. Everywhere an *installed* skill is
 * previewed — the settings Installed tab and the skill context-item's properties
 * panel — funnels through {@link openInstalledSkillPreview} here, so both reuse
 * one modal with no Install button and no duplicated markup. The modal chrome
 * ({@link skillPreviewShell}) is shared by all three.
 *
 * All remote strings are escaped; the SKILL.md body renders only through
 * renderMarkdown(.., {escapeXml}). The `/api/skills/{scope}/{source}/{name}`
 * body is served with its YAML frontmatter already stripped, so no frontmatter
 * peeling is needed here (unlike the catalog's raw file).
 * @module components/settings/skill-preview
 */

import { escapeHtml } from '../../../sdk/lib/html.js';
import { t } from '../../../sdk/lib/i18n.js';
import { renderMarkdown } from '../../../sdk/lib/markdown.js';
import { httpErrorText } from '../../services/http.js';
import { formatBytes } from '../../utils/format.js';
import { presentModal } from '../../utils/modal-surface.js';
import { dialogAttributes, newDialogTitleId } from '../../utils/dialog-a11y.js';
import { addFilePath } from '../../utils/properties-panel-helpers.js';
import { fetchSkillBody } from '../../services/skills.js';

/**
 * Wrap preview content in the standard centered-modal chrome (backdrop +
 * modal-panel), matching bin-modal / about-modal. Shared by
 * the Discover drawer and the installed-skill popup so the two never drift.
 * @param {string} title - Pre-escaped dialog title.
 * @param {string} bodyHtml - Scrollable body markup.
 * @param {string} [footerHtml] - Footer markup (omitted when empty).
 * @returns {string} The modal HTML.
 */
export function skillPreviewShell(title, bodyHtml, footerHtml = '') {
  const titleId = newDialogTitleId();
  return `
    <modal-backdrop class="skills-preview-backdrop" data-action="drawer-close"></modal-backdrop>
    <modal-panel class="skills-preview-panel" ${dialogAttributes(titleId)}>
      <header class="skills-preview-header">
        <h2 class="skills-preview-title" id="${titleId}">${title}</h2>
        <button class="close-button skills-preview-close" data-action="drawer-close" title="${escapeHtml(t('Close (Esc)'))}" aria-label="${escapeHtml(t('Close'))}"><span class="icon-close"></span></button>
      </header>
      <div class="skills-preview-body">${bodyHtml}</div>
      ${footerHtml ? `<footer class="skills-preview-footer">${footerHtml}</footer>` : ''}
    </modal-panel>
  `;
}

/**
 * Replace every `.skills-filepath-mount` placeholder in a container with the
 * shared file-path control (mono path + copy + reveal-in-Finder buttons). Views
 * emit these placeholders as plain HTML strings; this hydrates them into live
 * DOM after innerHTML is set.
 * @param {HTMLElement|null} container - The subtree to hydrate.
 */
function hydrateSkillFilePaths(container) {
  if (!container) return;
  container.querySelectorAll('.skills-filepath-mount').forEach((el) => {
    const path = /** @type {HTMLElement} */ (el).dataset.path || '';
    el.textContent = '';
    if (path) addFilePath(/** @type {HTMLElement} */ (el), path);
  });
}

/**
 * Build the body markup for an installed-skill preview from its fetched detail:
 * scope/scripts badges, the full description, the on-disk location, the file
 * listing, and the SKILL.md instructions rendered as markdown. No Install
 * footer and no "installing writes files" safety note — the skill is already on
 * disk.
 * @param {{scope?: string, source?: string, description?: string, hasScripts?: boolean}} skill - Row metadata.
 * @param {import('../../services/skills.js').SkillDetail} detail - Fetched body + file listing.
 * @returns {string} The preview body HTML.
 * @private
 */
function installedPreviewBody(skill, detail) {
  const badge =
    skill.scope && skill.source
      ? `<span class="skills-scope-badge">${escapeHtml(skill.scope)}-${escapeHtml(skill.source)}</span>`
      : '';
  const scripts = skill.hasScripts ? `<span class="skills-badge tint-blue">${escapeHtml(t('scripts'))}</span>` : '';
  const head = badge || scripts ? `<div class="skills-card-head">${badge}${scripts}</div>` : '';
  const desc = skill.description ? `<div class="skills-preview-desc">${escapeHtml(skill.description)}</div>` : '';

  const location = detail.path
    ? `<div class="skills-section surface-card">
         <div class="skills-section-title">${escapeHtml(t('Location'))}</div>
         <div class="skills-filepath-mount" data-path="${escapeHtml(detail.path)}"></div>
       </div>`
    : '';

  const files = detail.files || [];
  const fileList = files.length
    ? `<div class="skills-section surface-card skills-files">
         <div class="skills-section-title">${escapeHtml(t('Files ({count})', { count: files.length }))}</div>
         <div class="skills-files-list">
           ${files
              .map(
                (f) =>
                  `<div class="skills-file"><span class="skills-file-path">${escapeHtml(f.path)}</span><span class="skills-file-size">${formatBytes(f.size)}</span></div>`
              )
              .join('')}
         </div>
       </div>`
    : '';

  const body = `<div class="skills-drawer-body markdown">${renderMarkdown(detail.body || '', { escapeXml: true })}</div>`;
  return `${head}${desc}${location}${fileList}${body}`;
}

/**
 * Open the preview modal for an installed skill: a self-contained overlay
 * appended to <body> (so it works from the settings tab and the conversation
 * properties panel alike), dismissed by its close button, backdrop, Escape, or
 * the browser/mobile Back button via popup-manager. Fetches the skill's SKILL.md
 * body lazily and renders it with no Install button.
 * @param {{scope: string, source: string, name: string, description?: string, hasScripts?: boolean}} skill - The installed skill to preview.
 * @returns {Promise<void>}
 */
export async function openInstalledSkillPreview(skill) {
  const { scope, source, name } = skill;
  if (!scope || !source || !name) return;

  const modal = presentModal({
    className: 'skills-drawer',
    dismissSelectors: ['.skills-preview-close', '.skills-preview-backdrop'],
  });
  const overlay = modal.root;

  const title = escapeHtml(name);
  overlay.innerHTML = skillPreviewShell(
    title,
    `<div class="skills-loading"><juggler-spinner style="--size:1.5rem"></juggler-spinner></div>`
  );

  let detail;
  try {
    detail = await fetchSkillBody(/** @type {any} */ (scope), /** @type {any} */ (source), name);
  } catch (err) {
    if (modal.closed) return;
    const failure = t('Failed to load skill "{name}": {error}', { name, error: httpErrorText(err) });
    overlay.innerHTML = skillPreviewShell(title, `<div class="skills-empty">${escapeHtml(failure)}</div>`);
    return;
  }
  if (modal.closed) return;
  overlay.innerHTML = skillPreviewShell(title, installedPreviewBody(skill, detail));
  hydrateSkillFilePaths(overlay);
}
