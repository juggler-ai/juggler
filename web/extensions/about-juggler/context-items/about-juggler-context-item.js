//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import keyShortcutManager, { isMac, formatBindingForPlatform } from '../../../js/services/key-shortcut-manager.js';
import CORPUS from '../corpus.js';

/**
 * The platform's real log directory, mirroring internal/logpaths/logpaths.go so
 * the manual points a user at the right place. Kept as a small pure table rather
 * than an app call because execute() has no filesystem/env access.
 * @param {string} platform - session.platform: 'darwin' | 'linux' | 'windows'
 * @returns {string} A human-readable log location for that platform
 */
function logLocationFor(platform) {
  switch (platform) {
    case 'darwin': return '~/Library/Logs/Juggler';
    case 'windows': return '%LOCALAPPDATA%\\Juggler\\Logs';
    case 'linux': return '$XDG_STATE_HOME/juggler/logs (default ~/.local/state/juggler/logs)';
    default: return 'your platform\u2019s standard log directory';
  }
}

/**
 * Render the live keyboard-shortcut table as markdown, each binding formatted
 * for the given platform. Sourced from the app's own KeyShortcutManager, so it
 * always matches the real key map (and any future user overrides) instead of a
 * frozen copy in the corpus.
 * @param {boolean} mac - True to render macOS glyphs, false for Ctrl+ style
 * @returns {string} Markdown: one bulleted list per shortcut category
 */
function shortcutsMarkdownFor(mac) {
  const lines = [];
  for (const group of keyShortcutManager.byCategoryForPlatform(mac)) {
    lines.push(`**${group.category}**`, '');
    for (const def of group.shortcuts) {
      // Aliases are listed too (a command may answer to more than one key), so
      // the manual can name a key that actually works on the asker's surface.
      // Asked for the asker's platform rather than this window's, so a key bound
      // only on the other one is never offered.
      const combos = keyShortcutManager.getBindings(def.id, mac)
        .map((binding) => formatBindingForPlatform(binding, mac));
      lines.push(`- ${combos.join(' or ') || '(unbound)'} — ${def.label}: ${def.description}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

/**
 * Fill the corpus's platform placeholders from the live session platform.
 * @param {string} platform - session.platform ('' when not yet hydrated)
 * @returns {string} The fully-resolved manual
 */
function buildCorpus(platform) {
  // session.platform is authoritative for the host; fall back to a navigator
  // sniff only when it is absent (e.g. a not-yet-hydrated session).
  const mac = platform ? platform === 'darwin' : isMac();
  return CORPUS
    .replace('{{KEYBOARD_SHORTCUTS}}', shortcutsMarkdownFor(mac))
    .replace('{{LOG_LOCATION}}', logLocationFor(platform));
}

/**
 * @typedef {object} AboutJugglerParams
 * @property {string} [question] - Optional: what the user wants to know about
 *   Juggler. Recorded for display only; the whole manual is returned regardless.
 */

/**
 * @typedef {object} AboutJugglerResult
 * @property {string} corpus - The full About-Juggler reference manual (markdown)
 * @property {string} [question] - The question the model passed, if any
 */

/**
 * AboutJugglerContextItem — answer questions about Juggler itself.
 *
 * A deliberately tiny, on-demand tool: its only cost on a normal turn is its
 * one-line tool definition (billed at the cache-read rate). The reference manual
 * (imported CORPUS) enters context ONLY when the model actually calls the tool,
 * so it is free unless a chat genuinely needs it. Shipped as its own extension
 * (@juggler/about), on by default; disabling the extension removes this tool and
 * unloads the corpus entirely.
 *
 * The manual is BUNDLED with the app, not read from the user's project — the
 * read tool is path-scoped to the project and cannot reach shipped docs, so the
 * corpus travels as an imported module instead. The imported corpus is a generic
 * cross-platform base; execute() fills its platform placeholders (the keyboard
 * shortcut table and log location) from the live session's platform, so the
 * answer is correct for the machine being described.
 * @class
 * @augments ContextItem
 */
class AboutJugglerContextItem extends ContextItem {
  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'web', icon: 'icon-search' };
  }

  static MANIFEST = {
    id: 'about-juggler',
    name: 'About Juggler',
    version: '1.0.0',
    description: 'Answer questions about the Juggler application itself',
    author: 'Juggler Team',
    requiresApproval: false
  };

  /**
   * The manual is static reference text — re-running returns the identical
   * dump, so offer no "Re-run" control.
   * @returns {boolean} False — re-running this item type is a no-op.
   */
  static isRerunnable() {
    return false;
  }

  /**
   * Get tool definitions for the AboutJuggler action.
   *
   * The description is intentionally tightly scoped so the model reaches for this
   * only when the user is asking about Juggler itself — not about their code.
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definitions
   */
  static getToolDefinitions() {
    /** @type {import('juggler/strategy-type').JSONObjectSchema} */
    const inputSchema = {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'Optional: the specific thing the user wants to know about '
            + 'Juggler, recorded for display. The full manual is returned regardless.'
        }
      },
      required: []
    };

    const description = 'Returns Juggler\'s own reference manual: what Juggler is, '
      + 'its tools, strategies, slash-commands, keyboard shortcuts, supported model '
      + 'providers, configuration and data locations, and extensions. Call this ONLY '
      + 'when the user asks about Juggler itself — the application, its features, UI, '
      + 'shortcuts, config, or how to use it. Do NOT call it for questions about the '
      + 'user\'s own code, project, or general programming. One call returns the whole manual.';

    return [
      {
        name: 'AboutJuggler',
        category: 'read',
        description,
        input_schema: inputSchema
      }
    ];
  }

  /**
   * Validate parameters. All fields are optional, so this only type-checks a
   * supplied question.
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    const params = /** @type {AboutJugglerParams} */ (toolInput);
    if (params.question !== undefined && typeof params.question !== 'string') {
      return { valid: false, error: 'Parameter "question" must be a string' };
    }
    return { valid: true, params: toolInput };
  }

  /**
   * Execute — return the bundled corpus with its platform placeholders resolved
   * for the live session. No I/O, no network: the base manual is an imported
   * module string and the injected parts come from in-process app state.
   * @param {Record<string, unknown>} params - Prepared params
   * @returns {Promise<AboutJugglerResult>} The manual (and echoed question)
   */
  async execute(params) {
    const p = /** @type {AboutJugglerParams} */ (params);
    const platform = (this.session && this.session.platform) || '';
    return { corpus: buildCorpus(platform), question: p.question };
  }

  /**
   * Format the outcome for the LLM tool_result and simple display. The corpus is
   * the tool_result content.
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    if (!outcome.success) {
      return this.failureSummary(outcome.error || 'Failed to load the Juggler manual');
    }

    const result = /** @type {AboutJugglerResult} */ (outcome.result);
    return this.successSummary(result.corpus || buildCorpus(''));
  }

  /**
   * Status UI: a small lozenge summarising the lookup.
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Action execution status
   * @param {Record<string, unknown>} toolInput - Original tool input parameters
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config
   */
  getStatusUI(actionStatus, toolInput) {
    const question = toolInput && typeof toolInput.question === 'string' ? toolInput.question : '';

    return this.buildStatusUI(actionStatus, {
      typeName: 'About Juggler',
      pending: 'Looking up Juggler\u2026',
      success: question || 'About Juggler',
      failurePrefix: 'Failed'
    });
  }

  /**
   * @override
   * @param {string} _toolName
   * @returns {string} Section label
   */
  static getResultSectionLabel(_toolName) {
    return 'Manual';
  }
}

export default AboutJugglerContextItem;
