//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Why an MCP tool isn't reaching the model.
 *
 * MCP has two independent switches and only one of them is visible from the MCP
 * UI. A server can be configured, running, and reporting a full tool list while
 * the `@juggler/mcp` extension that publishes those tools is disabled — the
 * settings tab shows green dots, `/mcp` lists tools, and the model is offered
 * none of them. That gap is what this module closes: one place that knows the
 * extension can be off, so the settings tab, the System Prompt panel, and a
 * failed tool call can all say the same thing instead of each showing a
 * different half of the truth.
 * @module services/mcp-availability
 */

import { fetchDisabledPluginIds } from './extensions.js';
import { mcpListServers } from './ops-api.js';
import { parseMcpToolName } from './thread-tool-inventory.js';
import { markForTranslation } from '../../sdk/lib/i18n.js';

/** Extension that publishes every MCP tool to the model. */
const MCP_EXTENSION_ID = '@juggler/mcp';

/** Capability id of the MCP bridge context item, disableable on its own. */
const MCP_ITEM_TYPE = 'mcp-tool';

/**
 * The one-line statement every MCP surface makes when the extension is off.
 * Servers keep running and keep reporting tools; nothing publishes them.
 * English: a UI surface passes it to `t()` where it draws it, while
 * {@link mcpToolMissReason} hands it to the model as it stands.
 * @type {string}
 */
export const MCP_DISABLED_NOTICE = markForTranslation(
  'The MCP extension is disabled, so no MCP tools reach the model. Turn "Juggler MCP" back on in Settings › Extensions.'
);

/**
 * Whether MCP tools are switched off at the extension level for this project.
 *
 * Mirrors what the registries do with the same set (`base-registry.js`
 * `_applyDisabledFilter`): a capability is off when its own id or its
 * extension's id is listed, so both spellings count here too. Best-effort — an
 * unreadable config is reported as "not disabled", because claiming the
 * extension is off when we don't know is the worse lie.
 * @returns {Promise<boolean>} True when nothing MCP publishes reaches the model
 */
export async function isMcpExtensionDisabled() {
  try {
    const disabled = await fetchDisabledPluginIds();
    if (!disabled) return false; // unknown — don't claim the extension is off
    return disabled.has(MCP_EXTENSION_ID) || disabled.has(MCP_ITEM_TYPE);
  } catch {
    return false;
  }
}

/**
 * Why a call to `mcp__<server>__<tool>` found no tool, given what we know about
 * the extension and that server. Pure — exported for unit testing.
 *
 * The distinction worth drawing is between "MCP is off", "that server isn't
 * there", and "that server is there and this tool wasn't in the list" — three
 * different fixes wearing one error message.
 * @param {object} state - What is known about the call
 * @param {string} state.server - Server name from the tool name
 * @param {string} state.tool - Raw tool name from the tool name
 * @param {boolean} state.disabled - Whether the MCP extension is disabled
 * @param {{status?: string, enabled?: boolean, error?: string}|null|undefined} state.status - The server's live status, or null/undefined when it isn't configured
 * @returns {string} A sentence to append to the error, or '' when there is nothing to add
 */
export function mcpToolMissReason({ server, tool, disabled, status }) {
  if (disabled) return MCP_DISABLED_NOTICE;
  if (!status) return `No MCP server named "${server}" is configured.`;
  if (status.enabled === false) return `The MCP server "${server}" is turned off in Settings › MCP servers.`;
  if (status.status && status.status !== 'running') {
    // The server's own first error line, verbatim — a plain-English lead never
    // replaces it. No trailing full stop after it: the error supplies its own.
    return status.error
      ? `The MCP server "${server}" is ${status.status}: ${String(status.error).split('\n')[0]}`
      : `The MCP server "${server}" is ${status.status}.`;
  }
  return `The MCP server "${server}" is running, but "${tool}" was not in this turn's tool list — either that server's tool filter hides it, or it arrived after the turn was sent.`;
}

/**
 * An unknown-tool message with the MCP reason appended, when there is one.
 *
 * "No tool found" is the same sentence whether MCP is switched off, the server
 * is dead, or the tool simply wasn't in this turn's list — and the model, which
 * reads this, will keep retrying until it is told which. Non-MCP tool names come
 * back unchanged.
 * @param {string} message - The caller's own unknown-tool message
 * @param {string} toolName - The LLM-facing tool name that missed
 * @returns {Promise<string>} The message, with the reason on its own line when known
 */
export async function withMcpToolMissReason(message, toolName) {
  const reason = await describeMcpToolMiss(toolName);
  return reason ? `${message}\n\n${reason}` : message;
}

/**
 * Why an `mcp__*` tool name found no handler, as a sentence to append to an
 * unknown-tool error. '' for any other tool name, and for an MCP name we can
 * say nothing useful about — an error that guesses is worse than a plain one.
 * @param {string} toolName - The LLM-facing tool name that missed
 * @returns {Promise<string>} The reason, or ''
 */
async function describeMcpToolMiss(toolName) {
  const parts = parseMcpToolName(String(toolName || ''));
  if (!parts) return '';
  try {
    const [disabled, res] = await Promise.all([isMcpExtensionDisabled(), mcpListServers()]);
    const status = (res?.servers || []).find((s) => String(s.name) === parts.server) || null;
    return mcpToolMissReason({ server: parts.server, tool: parts.tool, disabled, status });
  } catch {
    // No MCP ops in this context: the caller's own message still stands.
    return '';
  }
}
