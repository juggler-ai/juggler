//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Apache-2.0 - see LICENSE
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   SPDX-License-Identifier: Apache-2.0

import CommandType from 'juggler/command-type';
import { mcpListServers, mcpServerControl, mcpGetLog } from 'juggler/ops';
import { extractErrorMessage } from 'juggler/ui';
import { translator, markForTranslation, formatNumber } from 'juggler/i18n';

const t = translator('@juggler/mcp');

/**
 * How a server's status is named, keyed by the value the MCP manager reports.
 * A value missing here is shown as it came.
 * @type {Record<string, string>}
 */
const STATUS_LABELS = {
  running: markForTranslation('running'),
  starting: markForTranslation('starting'),
  stopped: markForTranslation('stopped'),
  failed: markForTranslation('failed'),
  disabled: markForTranslation('disabled'),
};

/**
 * `/mcp` — inspect and control MCP servers from the composer.
 *
 *   /mcp                     list servers, status, tool counts, schema tokens
 *   /mcp start|stop|restart <name>
 *   /mcp reload              re-read config and reconcile
 *   /mcp logs <name>         recent stderr for diagnostics
 *
 * Text-first in phase 1; a richer panel is phase 2.
 * @augments CommandType
 */
class McpCommandType extends CommandType {
  static MANIFEST = {
    id: 'mcp',
    name: 'MCP Servers',
    version: '1.0.0',
    description: 'List and control connected MCP servers',
    icon: 'icon-search'
  };

  /**
   * @param {string[]} args
   * @returns {Promise<import('juggler/command-type').CommandResult>} Command result
   */
  async execute(args) {
    const [sub, name] = args;
    try {
      switch ((sub || '').toLowerCase()) {
        case '':
        case 'list':
          return { handled: true, message: await McpCommandType._list() };
        case 'start':
        case 'stop':
        case 'restart':
          if (!name) return { handled: true, message: t('Usage: /mcp {subcommand} <server>', { subcommand: sub }) };
          await mcpServerControl({ server: name, action: /** @type {'start'|'stop'|'restart'} */ (sub) });
          return { handled: true, message: await McpCommandType._list() };
        case 'reload': {
          // Any server works as the reconcile target; the manager reloads all.
          const { servers } = await mcpListServers();
          const target = servers[0]?.name;
          if (target) await mcpServerControl({ server: target, action: 'reload' });
          return { handled: true, message: await McpCommandType._list() };
        }
        case 'logs':
          if (!name) return { handled: true, message: t('Usage: /mcp {subcommand} <server>', { subcommand: 'logs' }) };
          {
            const { log } = await mcpGetLog({ server: name });
            return { handled: true, message: log ? t('MCP "{server}" recent output:\n\n{log}', { server: name, log }) : t('No recent output for "{server}".', { server: name }) };
          }
        default:
          return { handled: true, message: t('Unknown subcommand "{subcommand}". Try: /mcp, /mcp start|stop|restart <server>, /mcp reload, /mcp logs <server>', { subcommand: sub }) };
      }
    } catch (err) {
      return { handled: true, message: t('MCP command failed: {error}', { error: extractErrorMessage(err) }) };
    }
  }

  /**
   * Render the server table as text.
   * @returns {Promise<string>} Rendered text
   * @private
   */
  static async _list() {
    const { servers } = await mcpListServers();
    if (!servers || servers.length === 0) {
      return t('No MCP servers configured. Add them to ~/.juggler/mcp.json or <project>/.juggler/mcp.json.');
    }
    const lines = servers.map((s) => {
      const err = s.error ? `\n    ↳ ${String(s.error).split('\n')[0]}` : '';
      const ver = s.serverName ? ` [${s.serverName}${s.serverVersion ? ' ' + s.serverVersion : ''}]` : '';
      const label = Object.prototype.hasOwnProperty.call(STATUS_LABELS, s.status) ? STATUS_LABELS[s.status] : '';
      const params = { server: s.name, status: label ? t(label) : s.status, version: ver, count: s.toolCount };
      const line = s.schemaTokens
        ? t('• {server} — {status}{version} · {count, plural, one {{count} tool} other {{count} tools}} · ~{tokens} tokens/request',
          { ...params, tokens: McpCommandType._fmtTokens(s.schemaTokens) })
        : t('• {server} — {status}{version} · {count, plural, one {{count} tool} other {{count} tools}}', params);
      return `${line}${err}`;
    });
    return `${t('MCP servers:')}\n${lines.join('\n')}`;
  }

  /**
   * A schema-token count: exact below a thousand, else thousands to one
   * decimal ("1.2k"), in the UI language's digits with its `k` a message.
   * @param {number} n
   * @returns {string} Result value
   * @private
   */
  static _fmtTokens(n) {
    if (n < 1000) return formatNumber(n);
    const thousands = formatNumber(n / 1000, { useGrouping: false, minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return t('{n}k', { n: thousands }, { context: 'thousands, in a compact count' });
  }

  /**
   * Test seam for `_fmtTokens`.
   * @param {number} n - A schema-token count
   * @returns {string} The count as `/mcp` states it
   */
  static __fmtTokensForTests(n) {
    return McpCommandType._fmtTokens(n);
  }
}

export default McpCommandType;
