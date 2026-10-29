//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Exporting a conversation as a page to share: what goes in, then where to.
 *
 * The question is asked every time, and the answer always starts at the
 * conservative end — both options off — because the page is meant to be posted
 * somewhere public, and what a conversation shows is whatever the agent was
 * shown. A choice remembered from last time is a choice the user did not make
 * about this conversation. So the dialog says plainly what is always in, what
 * is never in, and that the file goes nowhere but where they save it.
 *
 * The page itself is `utils/conversation-html.js`; saving is `saveFile` — the
 * desktop app's Save dialog, or a browser download.
 *
 * It wears the move dialog's chrome (`.workspace-move-*`), as the reconnect
 * dialog does: the shared scrim and card, with the same header and footer
 * rhythm. Only the option rows are its own.
 * @module components/conversation-export-dialog
 */

import { presentModal } from '../utils/modal-surface.js';
import { conversationToHtml, exportFileName } from '../utils/conversation-html.js';
import { saveFile } from '../../sdk/lib/window-control.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { setupButton } from './workspace-setup-form.js';
import { showNotice } from './modal-dialog.js';
import { t } from '../../sdk/lib/i18n.js';
import { displayConversationName } from '../model/conversation-naming.js';

/** Gives each dialog's checkboxes ids of their own, for their labels. */
let dialogCount = 0;

/**
 * @typedef {object} ExportDialogOptions
 * @property {(name: string, content: string, mime: string) => Promise<string|null>} [save] - Where the
 *   page goes. Defaults to `saveFile`.
 * @property {import('../utils/conversation-html.js').ExportOptions['loadAsset']} [loadAsset] - How
 *   images are fetched. Defaults to the conversation's asset route.
 */

/**
 * Export a conversation, from wherever it was asked for — a tab's menu or
 * `/export`: the dialog, then a word saying where the file went. A failure to
 * save is shown in the dialog itself, which stays up to be tried again.
 * @param {any} conversation - A loaded Conversation.
 * @returns {Promise<void>} When the dialog has closed.
 */
export async function exportConversation(conversation) {
  const outcome = await openConversationExport(conversation);
  if (outcome.saved && outcome.path) showNotice(t('Exported to {path}', { path: outcome.path }));
}

/**
 * Ask what to include, then export the conversation and save it.
 * @param {any} conversation - A loaded Conversation.
 * @param {ExportDialogOptions} [options] - Seams for the save and the asset loader.
 * @returns {Promise<{saved: boolean, path?: string}>} Whether it was saved, and where.
 */
export function openConversationExport(conversation, options = {}) {
  const save = options.save || saveFile;
  const id = ++dialogCount;

  return new Promise((resolve) => {
    const modal = presentModal({
      className: 'workspace-move-overlay conversation-export-overlay',
      dismissSelectors: ['.workspace-move-backdrop', '.workspace-move-close', '.conversation-export-cancel'],
      onClose: (/** @type {{saved: boolean, path?: string}|undefined} */ result) => resolve(result ?? { saved: false })
    });
    const root = modal.root;

    let includeToolDetails = false;
    let includeFiles = false;
    /** @type {string} Why the last attempt did not happen. */
    let error = '';
    /** @type {boolean} Whether an export is in flight, so a second press is not a second file. */
    let exporting = false;

    /**
     * Build the page and save it, or say why not; the dialog stays up after a
     * failure so the press can be tried again.
     * @returns {Promise<void>} When it has saved, been cancelled, or failed.
     */
    const commit = async () => {
      if (exporting) return;
      exporting = true;
      error = '';
      render();
      try {
        const html = await conversationToHtml(conversation, {
          includeToolDetails, includeFiles, loadAsset: options.loadAsset
        });
        const name = conversation?.name ? displayConversationName(conversation.name) : '';
        const path = await save(exportFileName(name), html, 'text/html');
        modal.close(path ? { saved: true, path } : { saved: false });
        return;
      } catch (failure) {
        error = extractErrorMessage(failure);
      }
      if (modal.closed) return;
      exporting = false;
      render();
    };

    /**
     * One option: a checkbox, its label, and what ticking it puts in the page.
     * @param {string} key - Which option, for its id.
     * @param {string} label - What it is.
     * @param {string} hint - What it adds.
     * @param {boolean} checked - Its state.
     * @param {(on: boolean) => void} onChange - Called with the new state.
     * @returns {HTMLElement} The row.
     */
    const optionRow = (key, label, hint, checked, onChange) => {
      const row = document.createElement('div');
      row.className = 'conversation-export-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'conversation-export-checkbox';
      input.id = `conversation-export-${key}-${id}`;
      input.checked = checked;
      input.disabled = exporting;
      input.addEventListener('change', () => onChange(input.checked));
      const text = document.createElement('label');
      text.className = 'conversation-export-option-text';
      text.htmlFor = input.id;
      const name = document.createElement('span');
      name.className = 'conversation-export-option-label';
      name.textContent = label;
      const detail = document.createElement('span');
      detail.className = 'conversation-export-option-hint';
      detail.textContent = hint;
      text.append(name, detail);
      row.append(input, text);
      return row;
    };

    /** Draw the dialog as it stands. */
    const render = () => {
      if (modal.closed) return;
      root.replaceChildren();

      const backdrop = document.createElement('modal-backdrop');
      backdrop.className = 'workspace-move-backdrop';
      root.appendChild(backdrop);

      const dialog = document.createElement('modal-panel');
      dialog.className = 'workspace-move-dialog conversation-export-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-label', t('Export as HTML'));
      root.appendChild(dialog);

      const header = document.createElement('div');
      header.className = 'workspace-move-header';
      const title = document.createElement('h2');
      title.className = 'workspace-move-title';
      title.textContent = t('Export as HTML');
      header.appendChild(title);
      const close = setupButton('close-button workspace-move-close', '', () => modal.close(undefined));
      close.setAttribute('aria-label', t('Close'));
      close.title = t('Close');
      const cross = document.createElement('span');
      cross.className = 'icon-close';
      close.appendChild(cross);
      header.appendChild(close);
      dialog.appendChild(header);

      const body = document.createElement('div');
      body.className = 'workspace-move-body conversation-export-body';
      dialog.appendChild(body);

      const intro = document.createElement('div');
      intro.className = 'conversation-export-text';
      intro.textContent = t('One self-contained page of this conversation that opens in any browser, ready to post or send.');
      body.appendChild(intro);

      const always = document.createElement('div');
      always.className = 'conversation-export-text';
      always.textContent = t('It always has your messages, the agent’s replies, a line for each tool call, and each sub-thread’s answer. It never has the agent’s thinking, the system prompt, memory, or anything else the agent was given but did not say.');
      body.appendChild(always);

      const choices = document.createElement('div');
      choices.className = 'conversation-export-options';
      choices.appendChild(optionRow('tools', t('Include tool call details'),
        t('Each tool call can be expanded to show its input and output.'),
        includeToolDetails, (on) => { includeToolDetails = on; }));
      choices.appendChild(optionRow('files', t('Include file contents and images'),
        t('Files the agent read, and images in the conversation. Without this they are left out even with tool details.'),
        includeFiles, (on) => { includeFiles = on; }));
      body.appendChild(choices);

      const where = document.createElement('div');
      where.className = 'conversation-export-text conversation-export-note';
      where.textContent = t('Nothing is uploaded: the file is saved on this device, and the page loads nothing when it is opened. Read it before you share it — it shows whatever the conversation does.');
      body.appendChild(where);

      if (error) {
        const failure = document.createElement('div');
        failure.className = 'setup-error';
        failure.textContent = error;
        body.appendChild(failure);
      }

      const actions = document.createElement('div');
      actions.className = 'workspace-move-footer';
      actions.appendChild(setupButton('btn-secondary conversation-export-cancel', t('Cancel'),
        () => modal.close(undefined)));
      const commitButton = setupButton('btn-primary conversation-export-commit',
        exporting ? t('Exporting…') : t('Export…'), () => { void commit(); });
      commitButton.disabled = exporting;
      actions.appendChild(commitButton);
      dialog.appendChild(actions);
    };

    render();
    /** @type {HTMLElement|null} */ (root.querySelector('.conversation-export-commit'))?.focus();
  });
}
