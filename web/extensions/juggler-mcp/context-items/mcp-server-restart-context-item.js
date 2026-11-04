//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { mcpListServers, mcpServerControl, mcpGetLog } from 'juggler/ops';
import { translator, markUntranslated } from 'juggler/i18n';
import { onMcpChange } from './mcp-tool-context-item.js';

const t = translator('@juggler/mcp');

/** The permission itemType restart grants are stored under. */
const ITEM_TYPE = 'mcp-server-restart';

/** The LLM-facing tool name. */
export const RESTART_TOOL_NAME = 'McpRestartServer';

/** Most lines of a failed server's stderr handed to the model. */
const MAX_LOG_LINES = 20;

/**
 * @typedef {object} ConfiguredServer
 * @property {string} name - Server name
 */

/**
 * @typedef {object} McpServerState
 * @property {string} name - Server name
 * @property {string} [status] - running, starting, stopped, failed, untrusted
 * @property {string} [error] - Why it is not running
 * @property {number} [toolCount] - Tools it publishes
 * @property {string} [serverName] - The name the server reports for itself
 * @property {string} [serverVersion] - The version it reports
 */

/**
 * @typedef {object} RestartResult
 * @property {string} server - The server restarted
 * @property {string} status - Its status once settled: running, failed, untrusted, stopped
 * @property {number} toolCount - Tools it publishes, when running
 * @property {string} [serverName] - The name the server reports for itself
 * @property {string} [serverVersion] - The version it reports
 * @property {string} [error] - Why it is not running
 * @property {string} [log] - Its recent stderr, when it is not running
 */

/**
 * The servers configured for the active project, kept current out of band like
 * the MCP tool snapshot: `getToolDefinitions()` is synchronous, and whether the
 * restart tool is offered depends on there being any server at all. Every
 * configured server counts, running or not — a server that failed to start is
 * the one most worth restarting.
 * @type {ConfiguredServer[]}
 */
let configuredServers = [];
/**
 * Whether the server list has been read once.
 * @type {boolean}
 */
let loaded = false;
/**
 * In-flight refresh, shared by concurrent callers.
 * @type {Promise<void>|null}
 */
let inFlight = null;

/**
 * Re-read the configured servers. Best-effort: a failure (the API token not yet
 * installed at first import) keeps the last list.
 * @returns {Promise<void>}
 */
async function refreshServers() {
  try {
    const res = await mcpListServers();
    configuredServers = Array.isArray(res?.servers) ? res.servers.map((s) => ({ name: String(s.name) })) : [];
    loaded = true;
  } catch (err) {
    console.debug('[MCP] Couldn\'t refresh the server list:', err);
  }
}

/** @returns {Promise<void>} The shared refresh */
function refreshOnce() {
  if (!inFlight) {
    inFlight = refreshServers().finally(() => { inFlight = null; });
  }
  return inFlight;
}

refreshOnce();

// The manager broadcasts a change when a server is added, removed or changes
// state, so a server added in Settings offers the tool from the next turn.
onMcpChange(() => { void refreshServers(); });

/**
 * The restart tool's definition, or none when no MCP server is configured, so a
 * user without MCP pays nothing for it. The definition is the same whichever
 * servers are configured: it rides the cached prompt prefix, and naming the
 * servers in it would rewrite that prefix on every config change. Pure —
 * exported for unit testing.
 * @param {ConfiguredServer[]} servers - The configured servers
 * @returns {Array<{name: string, category: 'write', description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Zero or one definition
 */
export function restartToolDefinitions(servers) {
  if (!servers.length) return [];
  return [{
    name: RESTART_TOOL_NAME,
    category: 'write',
    description: markUntranslated(
      'Restart one MCP server without restarting Juggler, and wait until it is running or has failed. ' +
      'Use it after changing something the server reads only at startup, such as its own config files. ' +
      'An edit to the server\'s entry in mcp.json (the global one, or <project>/.juggler/mcp.json: ' +
      'its command, args or "env") needs no restart: the next MCP call restarts that server by itself. ' +
      'A server\'s environment is Juggler\'s environment from when Juggler started, plus the "env" block ' +
      'of its mcp.json entry. Variables set since then (setx, a shell profile) never reach it, and ' +
      '.juggler/env.json files are for shell commands only, so put a variable the server needs in its ' +
      '"env" block. Returns the server\'s status, and for a server that did not start, its error and ' +
      'recent output.'
    ),
    input_schema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: markUntranslated('The MCP server\'s name, as configured') }
      },
      required: ['server']
    }
  }];
}

/**
 * Restart a server and report how it settled. Pure over its ops, which the
 * item passes as `mcpServerControl` and `mcpGetLog` — exported for unit testing.
 * @param {string} server - Server name
 * @param {{control: (params: {server: string, action: 'restart', wait: boolean}, signal?: AbortSignal) => Promise<{servers: McpServerState[]}>, log: (params: {server: string}, signal?: AbortSignal) => Promise<{log: string}>}} ops - The ops it uses
 * @param {AbortSignal} [signal] - The call's signal
 * @returns {Promise<RestartResult>} The settled state
 */
export async function restartMcpServer(server, ops, signal) {
  const { servers } = await ops.control({ server, action: 'restart', wait: true }, signal);
  const s = (Array.isArray(servers) ? servers : []).find((x) => x?.name === server);
  if (!s) {
    throw new Error(markUntranslated(`No MCP server named "${server}" is configured.`));
  }
  /** @type {RestartResult} */
  const out = { server, status: String(s.status || ''), toolCount: Number(s.toolCount) || 0 };
  if (s.serverName) out.serverName = String(s.serverName);
  if (s.serverVersion) out.serverVersion = String(s.serverVersion);
  if (out.status !== 'running') {
    out.error = String(s.error || '');
    try {
      const { log } = await ops.log({ server }, signal);
      out.log = String(log || '').trimEnd().split('\n').slice(-MAX_LOG_LINES).join('\n');
    } catch {
      // The status and error are the answer; the log only adds to it.
    }
  }
  return out;
}

/**
 * Whether saved rules let this restart run without asking: a rule naming the
 * server, or `*` for every server. Pure — exported for unit testing.
 * @param {Set<string>} values - Saved glob rule values for this itemType
 * @param {string} server - Server name
 * @returns {boolean} True when auto-approved
 */
export function restartIsPermitted(values, server) {
  return values.has(server) || values.has('*');
}

/**
 * "Don't ask again" choices, narrowest first: this server, then any server.
 * Pure — exported for unit testing.
 * @param {string} server - Server name
 * @returns {import('juggler/context-item').ApprovalSuggestion[]} Suggestions
 */
export function restartApprovalSuggestions(server) {
  return [
    { itemType: ITEM_TYPE, rules: [{ kind: 'glob', value: server }], label: t('restarting "{server}"', { server }) },
    { itemType: ITEM_TYPE, rules: [{ kind: 'glob', value: '*' }], label: t('restarting any MCP server') }
  ];
}

/**
 * Lets the agent restart an MCP server itself, so a server that needs a restart
 * is restarted rather than worked around or blamed on Juggler. Approval-gated
 * like any write.
 * @augments ContextItem
 */
class McpServerRestartContextItem extends ContextItem {
  static MANIFEST = {
    id: ITEM_TYPE,
    name: 'MCP Server Restart',
    version: '1.0.0',
    description: 'Lets the assistant restart an MCP server',
    author: 'Juggler Team',
    requiresApproval: true
  };

  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'web', icon: 'icon-search' };
  }

  /** @returns {string} Short type label */
  static getTypeName() {
    return t('MCP');
  }

  /**
   * Read the server list before the first tool list is built.
   * @returns {Promise<void>|void} Resolves once the list has loaded
   */
  static prepareToolDefinitions() {
    if (loaded) return;
    return refreshOnce();
  }

  /** @returns {ReturnType<typeof restartToolDefinitions>} Zero or one definition */
  static getToolDefinitions() {
    return restartToolDefinitions(configuredServers);
  }

  /**
   * @override
   * @param {Record<string, unknown>} toolInput
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    const server = typeof toolInput.server === 'string' ? toolInput.server.trim() : '';
    if (!server) {
      return { valid: false, error: markUntranslated('Parameter "server" must name an MCP server') };
    }
    if (loaded && !configuredServers.some((s) => s.name === server)) {
      const names = configuredServers.map((s) => `"${s.name}"`).join(', ');
      return { valid: false, error: markUntranslated(`No MCP server named "${server}" is configured. Configured: ${names || 'none'}.`) };
    }
    return { valid: true, params: { server } };
  }

  /**
   * @override
   * @returns {string} Permission key
   */
  getPermissionKey() {
    return ITEM_TYPE;
  }

  /**
   * @override
   * @param {Record<string, unknown>} toolInput
   * @returns {boolean} True when a saved rule permits this restart
   */
  isPermitted(toolInput) {
    const mt = this.messageThread;
    if (!mt) return false;
    const values = new Set(mt.getRulesFor(ITEM_TYPE).filter((r) => r.kind === 'glob').map((r) => String(r.value)));
    return restartIsPermitted(values, String(toolInput.server || ''));
  }

  /**
   * A grant belongs to the project, as an MCP tool grant does.
   * @returns {{allowedScopes: Array<'session'|'conversation'>, defaultScope: 'session'}} Scope policy
   */
  static getPermissionScopePolicy() {
    return { allowedScopes: ['session', 'conversation'], defaultScope: 'session' };
  }

  /**
   * @override
   * @param {Record<string, unknown>} toolInput
   * @returns {import('juggler/context-item').ApprovalSuggestion[]} Suggestions, narrowest first
   */
  getApprovalSuggestions(toolInput) {
    return restartApprovalSuggestions(String(toolInput.server || ''));
  }

  /**
   * @override
   * @param {Record<string, unknown>} params
   * @returns {Promise<import('juggler/context-item').ApprovalConfig>} Approval dialog config
   */
  async getApprovalConfig(params) {
    const server = String(params?.server || '');
    return {
      title: t('Restart MCP server "{server}"', { server }),
      message: t('Stops the server and starts it again with its current configuration. Juggler and your conversations keep running.')
    };
  }

  /**
   * @param {Record<string, unknown>} params - Validated params
   * @returns {Promise<RestartResult>} The settled state
   */
  async execute(params) {
    return restartMcpServer(String(params.server), { control: mcpServerControl, log: mcpGetLog }, this.signal);
  }

  /**
   * @param {import('juggler/context-item').Outcome} outcome
   * @returns {import('juggler/context-item').ItemSummary} Result for the model and UI
   */
  getSummary(outcome) {
    if (!outcome.success) {
      return this.failureSummary(outcome.error || markUntranslated('MCP server restart failed'));
    }
    const r = /** @type {RestartResult} */ (outcome.result || {});
    if (r.status === 'running') {
      const who = r.serverName ? ` (${r.serverName}${r.serverVersion ? ' ' + r.serverVersion : ''})` : '';
      return this.successSummary(markUntranslated(`MCP server "${r.server}"${who} restarted and is running with ${r.toolCount} tool(s).`));
    }
    let text = `MCP server "${r.server}" did not come back: it is ${r.status}.`;
    if (r.error) text += `\n\nError: ${r.error}`;
    if (r.log) text += `\n\nRecent output:\n${r.log}`;
    return this.failureSummary(this.truncateForLLM(markUntranslated(text)));
  }

  /**
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus
   * @param {Record<string, unknown>} toolInput
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message, or null
   */
  getStatusUI(actionStatus, toolInput) {
    const server = String(toolInput?.server || '');
    return this.buildStatusUI(actionStatus, {
      typeName: t('MCP'),
      pending: t('Restarting {server}…', { server }),
      success: () => {
        const r = /** @type {RestartResult} */ (actionStatus?.result || {});
        return r.status === 'running'
          ? t('Restarted {server}', { server })
          : { summary: t('{server} did not come back ({status})', { server, status: r.status }), status: /** @type {const} */ ('error') };
      },
      failurePrefix: t('Restarting {server} failed', { server })
    });
  }
}

export default McpServerRestartContextItem;
