//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import {
  createElement, createCopyableText, addSubsection, labeledSubsection, createHighlightedCode, createSummaryWithSubtitle
} from 'juggler/ui';
import { translator, markUntranslated } from 'juggler/i18n';

const t = translator('@juggler/core');

/**
 * Persisted Yjs shape for a command the user ran from the composer.
 * @typedef {object} ShellOutputData
 * @property {string} command - The command line exactly as the user typed it
 * @property {string} output - Merged stdout+stderr, as capped by the server
 * @property {number|null} exitCode - Exit code, or null when the run never finished
 * @property {string} error - Why the run did not complete (refused, timed out, no shell), or ''
 * @property {boolean} cancelled - The user stopped it before it finished
 * @property {string} outputFile - Spill file holding the complete output, or ''
 * @property {boolean} truncated - The output above dropped its middle
 */

/**
 * ShellOutputContextItem — a shell command the USER ran from the composer
 * (`! cmd` or `/shell cmd`), with its output.
 *
 * SEMANTICS:
 *  - Created only by the `/shell` command, after the command has finished, via
 *    `executeContextItem('shell-output', {...})`. The run costs no model call: the
 *    output simply stands in the conversation and reaches the model in place,
 *    immediately before the user's next message.
 *  - A frozen record — it never re-runs, exposes no tool for the LLM and is not
 *    addable through the picker.
 *  - The text the model reads says the user ran it, so the model does not take
 *    the output for the result of a tool call of its own.
 * @class
 * @augments ContextItem
 */
class ShellOutputContextItem extends ContextItem {
  /** @type {import('juggler/context-item').ContextItemManifest} */
  static MANIFEST = {
    id: 'shell-output',
    name: 'Shell command',
    version: '1.0.0',
    description: 'A shell command the user ran from the composer, with its output',
    author: 'Juggler Team',
    idPrefix: 'SHELL',
    userAddable: false,
    watchesFileChanges: false,
    exampleData: {
      command: 'echo hello',
      output: 'hello\n',
      exitCode: 0,
      error: '',
      cancelled: false,
      outputFile: '',
      truncated: false
    }
  };

  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'execute', icon: 'icon-terminal' };
  }

  /**
   * @param {import('juggler/context-item').ItemContext} context - Item context
   */
  constructor(context) {
    super(context);

    /** @type {ShellOutputData} */
    const defaults = {
      command: '', output: '', exitCode: null, error: '', cancelled: false, outputFile: '', truncated: false
    };
    this.data = { ...defaults, ...this.data };
  }

  /**
   * Record a finished run. No execution happens here — the `/shell` command ran
   * it and hands over the result.
   * @param {string} _toolName - Unused (no LLM-facing tool)
   * @param {Record<string, any>} params - {@link ShellOutputData}
   * @returns {Promise<void>}
   */
  async onToolCall(_toolName, params) {
    if (typeof params.command !== 'string' || !params.command.trim()) {
      // The thrown error is the item's outcome error, which stays English.
      throw new Error(markUntranslated('Missing required parameter: command'));
    }
    this.data.command = params.command;
    this.data.output = typeof params.output === 'string' ? params.output : '';
    this.data.exitCode = Number.isInteger(params.exitCode) ? params.exitCode : null;
    this.data.error = typeof params.error === 'string' ? params.error : '';
    this.data.cancelled = Boolean(params.cancelled);
    this.data.outputFile = typeof params.outputFile === 'string' ? params.outputFile : '';
    this.data.truncated = Boolean(params.truncated);
  }

  /**
   * How the run ended: the tile's status, and a line saying so unless it simply
   * succeeded.
   * @returns {{text: string, status: 'success'|'error'|'cancelled'}} Outcome line ('' for exit 0) and its status
   */
  _outcome() {
    const { cancelled, error, exitCode } = this.data;
    if (cancelled) return { text: t('Stopped before it finished'), status: 'cancelled' };
    if (error) return { text: t('Didn\'t run to completion'), status: 'error' };
    if (exitCode === 0) return { text: '', status: 'success' };
    return { text: t('Exit code {code}', { code: String(exitCode ?? '?') }), status: 'error' };
  }

  /**
   * Status UI: the highlighted command line, as the bash tool's tile shows one,
   * with how it ended beneath it unless it exited 0.
   * @returns {import('juggler/context-item').ResultStatusMessage} Status UI config
   */
  getStatusUI() {
    const outcome = this._outcome();
    const command = createHighlightedCode(this.data.command, 'bash');
    command.setAttribute('data-file-refs', '');
    return {
      typeName: t('Shell'),
      summary: createSummaryWithSubtitle(command, outcome.text),
      status: outcome.status
    };
  }

  /** @returns {string} Item title */
  getTitle() {
    return `$ ${this.data.command}`;
  }

  /** @returns {string} Brief summary for transaction display */
  getBriefSummary() {
    return t('Ran: {command}', { command: this.data.command });
  }

  /**
   * The text the model reads. Says who ran the command, then the command, its
   * output and how it ended — the same facts the bash tool's result gives.
   * @returns {Promise<string>} Context text for the LLM
   */
  async createContextText() {
    const { command, output, exitCode, error, cancelled, outputFile, truncated } = this.data;
    if (!command) return '';
    let text = `The user ran this shell command themselves (not a tool call of yours):\n$ ${command}\n\n`;
    text += output ? this.truncateForLLM(output) : '(no output)';
    if (cancelled) {
      text += '\n\n(The user stopped the command before it finished.)';
    } else if (error) {
      text += `\n\nThe command did not run to completion: ${error}`;
    } else {
      text += `\n\nexit code: ${exitCode ?? 'unknown'}`;
    }
    if (truncated && outputFile) {
      text += `\n\nThe middle of the output was dropped; the complete output is in ${outputFile}`;
    }
    return markUntranslated(text);
  }

  /**
   * Properties panel: the command, then its output with ANSI colours.
   * @returns {HTMLElement} Properties panel element
   */
  createPropertiesPanelElement() {
    const container = createElement('div');
    if (this.id) container.dataset.contextItemId = this.id;

    addSubsection(container, t('Command'), this.data.command, 'properties-panel-code', { fileRefs: true });

    const section = labeledSubsection(t('Output'));
    const outcome = this._outcome();
    if (outcome.text) section.appendChild(createElement('div', 'properties-panel-text', outcome.text));
    // The server's own reason for an incomplete run, shown as it came.
    if (this.data.error) section.appendChild(createCopyableText(this.data.error, 'properties-panel-result error'));
    if (this.data.output) {
      section.appendChild(createCopyableText(this.data.output, 'properties-panel-result', { ansi: true, fileRefs: true }));
    } else {
      section.appendChild(createElement('div', 'properties-panel-result empty', t('No output')));
    }
    if (this.data.truncated && this.data.outputFile) {
      section.appendChild(createElement('div', 'properties-panel-text',
        t('Middle dropped — the complete output is in {file}', { file: this.data.outputFile })));
    }
    container.appendChild(section);
    return container;
  }
}

export default ShellOutputContextItem;
