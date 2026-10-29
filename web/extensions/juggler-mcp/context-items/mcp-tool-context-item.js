//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { mcpSnapshot, mcpCallTool, uploadAssetBase64 } from 'juggler/ops';
import { translator, markUntranslated } from 'juggler/i18n';
// First-party builtin reaching a core singleton, the same way @juggler/core
// reaches ../../../js/services/*. This is the websocket the engine already uses;
// importing the module by its stable URL yields that same singleton instance.
import wsService from '../../../js/services/websocket.js';
import { renderMcpPermissionSection } from './permission-section.js';
import { extractErrorMessage } from 'juggler/ui';

const t = translator('@juggler/mcp');

/**
 * @typedef {object} McpToolInfo
 * @property {string} server - Owning server name
 * @property {string} name - Raw MCP tool name
 * @property {string} title - Display title (falls back to name)
 * @property {string} description - Server-provided description
 * @property {object} inputSchema - JSON Schema for the tool's arguments
 * @property {boolean} readOnly - annotations.readOnlyHint
 * @property {boolean} destructive - annotations.destructiveHint
 * @property {number} schemaTokens - ~chars/4 estimate of the input schema
 * @property {boolean} [autoApprove] - The server is pre-approved in the global MCP config
 */

/**
 * Module-level snapshot of every discovered MCP tool, plus an index from the
 * LLM-facing tool name to its owning server/tool. `getToolDefinitions()` is
 * static and synchronous, so it must read a cache that is kept fresh out of
 * band (the ES module is import-cached — its top level runs once — so we can't
 * rely on re-import to refresh it).
 * @type {McpToolInfo[]}
 */
let discoveredTools = [];
/** @type {Map<string, McpToolInfo>} */
let toolByLLMName = new Map();
/**
 * Whether the snapshot is the final word — it came back AND every enabled server
 * had published its tools by then. "No MCP tools", "nobody has asked yet" and "a
 * server is still connecting" are the same empty list to every reader, so this is
 * what tells them apart. Until it is set, the snapshot is re-fetched before each
 * turn's tool list, which is the backstop for the `plugin-changed` broadcast
 * below: with only the broadcast, one missed notification meant an empty tool
 * list for the rest of the session while every UI surface listed them in full.
 * @type {boolean}
 */
let loaded = false;
/**
 * In-flight refresh, so concurrent waiters share one round-trip.
 * @type {Promise<void>|null}
 */
let inFlight = null;

/** The permission itemType all MCP tool rules are stored under. */
const ITEM_TYPE = 'mcp-tool';

/** Max characters of a server-supplied tool description passed to the model. */
const MAX_DESC_CHARS = 1024;

/**
 * The LLM-facing tool name for a server/tool pair. `mcp__<server>__<tool>` is
 * the convention users know from other agents; it is collision-proof across
 * servers. (A server literally named "juggler" would collide with the Claude
 * CLI's `mcp__juggler__` strip in tool-generator.js — avoid that name.)
 * @param {string} server - Server name
 * @param {string} tool - Raw tool name
 * @returns {string} The LLM-facing tool name
 */
export function mcpLLMName(server, tool) {
  return `mcp__${server}__${tool}`;
}

/**
 * Build one LLM tool definition from a discovered tool. Read-only tools map to
 * the `read` category (so read/planning strategies include them and they run in
 * parallel); everything else is a mutating `write` (destructive-by-default).
 * Pure — exported for unit testing.
 * @param {McpToolInfo} t - A discovered tool
 * @returns {{name: string, category: 'read'|'write', description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}} Tool definition
 */
export function buildToolDefinition(t) {
  // Cast, not a guarantee: this schema is whatever a third-party MCP server
  // published, so it is the one tool schema in the tree that no annotation can
  // vouch for. It is checked at the provider seam before being advertised to
  // the model, and a server that publishes a malformed one loses that tool
  // rather than the whole tool list.
  const schema = /** @type {import('juggler/strategy-type').JSONObjectSchema} */ (
    (t.inputSchema && typeof t.inputSchema === 'object')
      ? t.inputSchema
      : { type: 'object', properties: {} }
  );
  let description = t.description || `${t.title || t.name} (via MCP server "${t.server}")`;
  if (description.length > MAX_DESC_CHARS) {
    description = description.slice(0, MAX_DESC_CHARS) + '…';
  }
  return {
    name: mcpLLMName(t.server, t.name),
    category: t.readOnly ? 'read' : 'write',
    description,
    input_schema: schema
  };
}

/**
 * The glob rule values that can auto-approve a call to server/tool.
 * @param {string} server - Server name
 * @param {string} tool - Raw tool name
 * @returns {{exact: string, readonly: string, all: string}} Rule values
 */
export function mcpRuleValues(server, tool) {
  return { exact: `${server}/${tool}`, readonly: `${server}/#readonly`, all: `${server}/*` };
}

/**
 * Escalating "don't ask again" suggestions, narrowest breadth first: this exact
 * tool, then (only if the tool is read-only) all read-only tools on the server,
 * then every tool on the server. Pure — exported for unit testing.
 * @param {{server: string, tool: string, readOnly: boolean}} target - Target tool
 * @returns {import('juggler/context-item').ApprovalSuggestion[]} Suggestions, narrowest first
 */
export function mcpApprovalSuggestions(target) {
  const rv = mcpRuleValues(target.server, target.tool);
  /** @type {import('juggler/context-item').ApprovalSuggestion[]} */
  const out = [
    { itemType: ITEM_TYPE, rules: [{ kind: 'glob', value: rv.exact }], patterns: [`${target.server}/${target.tool}`] }
  ];
  if (target.readOnly) {
    out.push({ itemType: ITEM_TYPE, rules: [{ kind: 'glob', value: rv.readonly }], label: t('all read-only tools on "{server}"', { server: target.server }) });
  }
  out.push({ itemType: ITEM_TYPE, rules: [{ kind: 'glob', value: rv.all }], label: t('all tools on "{server}" (trust this server)', { server: target.server }) });
  return out;
}

/**
 * Whether this call is auto-approved: by the server being pre-approved in the
 * user's global MCP config (`autoApprove`, which the Go manager never honours
 * from a project's own file), or by a persisted glob rule. A `#readonly` grant
 * applies ONLY when the tool is annotated read-only — never an approval based on
 * annotations alone. Pure — exported for unit testing.
 * @param {Set<string>} values - Persisted glob rule values for the mcp-tool itemType
 * @param {{server: string, tool: string, readOnly: boolean, autoApprove?: boolean}} t - Target tool
 * @returns {boolean} True if auto-approved
 */
export function mcpIsPermitted(values, t) {
  if (t.autoApprove) return true;
  const rv = mcpRuleValues(t.server, t.tool);
  if (values.has(rv.exact)) return true;
  if (values.has(rv.all)) return true;
  if (t.readOnly && values.has(rv.readonly)) return true;
  return false;
}

/**
 * Refresh the module-level snapshot from the Go manager's cache. Best-effort:
 * a failure (e.g. the API token isn't installed yet at first import) leaves the
 * previous snapshot in place. Calling it also reconciles the manager to the
 * active project Go-side, so enabled servers start discovering.
 * @returns {Promise<void>} Result
 */
async function refreshSnapshot() {
  try {
    const res = await mcpSnapshot();
    const tools = Array.isArray(res?.tools) ? res.tools : [];
    const index = new Map();
    for (const t of tools) index.set(mcpLLMName(t.server, t.name), t);
    discoveredTools = tools;
    toolByLLMName = index;
    // Only stop asking once the server says every enabled MCP server has
    // answered. An absent `complete` means nothing is reporting discovery state
    // (a bare test double), where re-asking forever would be the worse guess.
    loaded = res?.complete !== false;
  } catch (err) {
    // Leave the last-known snapshot untouched; a later refresh will update it.
    // Say so, though: a refresh that keeps failing looks exactly like a server
    // with no tools — an empty list, forever, and no other trace anywhere. Debug
    // level because the first call routinely loses a race with the API token.
    console.debug('[MCP] Couldn\'t refresh the tool snapshot:', err);
  }
}

/**
 * Refresh, sharing one in-flight request between concurrent callers. The tool
 * list is built per turn and several surfaces can ask at once; without this each
 * would open its own snapshot round-trip, and each of those can be holding the
 * server's bounded wait for a slow MCP server to connect.
 * @returns {Promise<void>} Resolves when the refresh settles
 */
function refreshOnce() {
  if (!inFlight) {
    inFlight = refreshSnapshot().finally(() => { inFlight = null; });
  }
  return inFlight;
}

// Kick an initial best-effort load (also starts Go-side discovery). Not awaited
// at top level: a slow/failed fetch must never wedge registry init.
refreshOnce();

// Refresh whenever the tool set changes. The Go manager broadcasts
// `plugin-changed` (via the server) on every snapshot change — a server became
// ready, crashed, or sent tools/list_changed — which the engine also uses to
// reload registries. This module is imported during contextItemRegistry.init(),
// which runs BEFORE engine-app installs its own plugin-changed→reloadRegistries
// listener, so our refresh is registered first and runs ahead of the rebuild.
// We also refresh on (re)connect, by which point the API token is installed.
try {
  wsService.on('plugin-changed', () => { void refreshSnapshot(); });
  wsService.on('open', () => { void refreshSnapshot(); });
} catch {
  // No wsService in this context (e.g. a bare unit harness) — the initial
  // refresh above still applies.
}

/** Image types every provider accepts, as the image viewer claims them. */
const ATTACHABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Largest image attached: the smallest common provider ceiling (5 MB). */
const MAX_ATTACHED_IMAGE_BYTES = 5 << 20;

/**
 * A tool's content block as an item keeps it: its base64 `data` dropped, and
 * an image marked with the asset it was stored as or why it was not.
 * @typedef {Omit<import('../../../js/services/ops-api.js').McpContentBlock, 'data'> & {attached?: string, note?: string}} StoredMcpBlock
 */

/**
 * Store the images a tool returned in the conversation's assets, so the model
 * is sent them as image parts beside the tool's result, as it is a read image.
 * No block keeps its base64 bytes: they would sit in the document for the life
 * of the conversation. An image that is stored names its asset as `attached`;
 * one that is not says why in `note`, and the model is told.
 * @param {import('../../../js/services/ops-api.js').McpContentBlock[]} blocks - The tool's content
 * @param {object} deps
 * @param {(convId: string, base64: string, mime: string, signal?: AbortSignal) => Promise<import('../../../js/services/ops-api.js').AssetRef>} deps.upload - The asset upload
 * @param {string|undefined} deps.conversationId - Whose assets
 * @param {AbortSignal} [deps.signal] - The call's signal
 * @returns {Promise<{blocks: StoredMcpBlock[], images: import('../../../js/services/ops-api.js').AssetRef[]}>} The blocks without bytes, and the images stored
 */
export async function storeMcpImages(blocks, { upload, conversationId, signal }) {
  /** @type {StoredMcpBlock[]} */
  const out = [];
  /** @type {import('../../../js/services/ops-api.js').AssetRef[]} */
  const images = [];
  for (const block of blocks) {
    if (block?.type !== 'image' && block?.type !== 'audio') {
      out.push(block);
      continue;
    }
    const { data, ...rest } = block;
    if (block.type === 'audio') {
      out.push(rest);
      continue;
    }
    const mime = typeof rest.mimeType === 'string' ? rest.mimeType : '';
    if (!ATTACHABLE_IMAGE_TYPES.has(mime)) {
      out.push({ ...rest, note: markUntranslated(`not a type the model can be sent (${mime || 'unknown'})`) });
    } else if (typeof data !== 'string' || !conversationId) {
      out.push({ ...rest, note: markUntranslated('nowhere to keep it') });
    } else if (Math.floor(data.length * 3 / 4) > MAX_ATTACHED_IMAGE_BYTES) {
      out.push({ ...rest, note: markUntranslated('too large to attach') });
    } else {
      try {
        const ref = await upload(conversationId, data, mime, signal);
        images.push(ref);
        out.push({ ...rest, attached: ref.id });
      } catch (err) {
        out.push({ ...rest, note: markUntranslated(`could not be stored: ${extractErrorMessage(err)}`) });
      }
    }
  }
  return { blocks: out, images };
}

/**
 * MCP tool bridge. ONE context-item class exposes MANY tools: one per tool
 * discovered across all connected MCP servers. Each tool result is a first-class
 * context item — summarized, truncated, droppable, richly rendered — not a raw
 * JSON blob wedged into history.
 * @augments ContextItem
 */
class McpToolContextItem extends ContextItem {
  static MANIFEST = {
    id: ITEM_TYPE,
    name: 'MCP Tools',
    version: '1.0.0',
    description: 'Tools provided by connected MCP (Model Context Protocol) servers',
    author: 'Juggler Team',
    requiresApproval: true
  };

  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'web', icon: 'icon-search' };
  }

  /** @returns {string} Short type label shown on item cards and the permissions popup */
  static getTypeName() {
    return t('MCP');
  }

  /**
   * Load the snapshot before the tool list is built, until one comes back with
   * every enabled server accounted for.
   *
   * The first snapshot request is also what starts Go-side discovery, so without
   * this the very request that builds a turn's tool list would be the one
   * kicking the servers off — and the turn would go out with no MCP tools in it
   * while the settings panel, asking a moment later, lists them all. The server
   * side holds that first answer until the servers have settled, so one await is
   * usually enough. A server slower than that wait, or one that failed its first
   * attempt and reconnected, costs a turn instead of the session: this keeps
   * asking until the answer is final, and `plugin-changed` keeps it current after
   * that. The repeat calls are a local snapshot read, and only park while a
   * server is on its first connect attempt.
   * @returns {Promise<void>|void} Resolves once a complete snapshot has loaded
   */
  static prepareToolDefinitions() {
    if (loaded) return;
    return refreshOnce();
  }

  /**
   * One tool definition per discovered MCP tool. Read from the module-level
   * snapshot, which {@link prepareToolDefinitions} has loaded and
   * `plugin-changed` keeps current.
   * @returns {Array<{name: string, category: 'read'|'write', description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} One tool definition per discovered MCP tool
   */
  static getToolDefinitions() {
    return discoveredTools.map(buildToolDefinition);
  }

  /**
   * Resolve this instance's target (server, tool, info) from the invoked tool
   * name the framework set on the item.
   * @returns {{server: string, tool: string, info: McpToolInfo|undefined, llm: string}} The resolved target for this instance
   * @private
   */
  _target() {
    const llm = this.toolName || '';
    const info = toolByLLMName.get(llm);
    return { server: info?.server || '', tool: info?.name || '', info, llm };
  }

  /**
   * Validate/normalize arguments. The base prepare() has already coerced the
   * input against the declared schemas; here we only confirm the tool is known.
   * @override
   * @param {Record<string, unknown>} toolInput
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    const { info, llm } = this._target();
    if (!info) {
      return { valid: false, error: markUntranslated(`Unknown MCP tool "${llm}" (its server may be stopped or reconfigured)`) };
    }
    return { valid: true, params: toolInput };
  }

  /**
   * Permission key: all MCP tool rules live under one itemType, with the
   * server/tool encoded in the rule value.
   * @override
   * @returns {string} Result value
   */
  getPermissionKey() {
    return ITEM_TYPE;
  }

  /**
   * Auto-approve when a matching rule exists. Annotations are UNVERIFIED hints
   * from an untrusted server, so a `#readonly` grant only applies when THIS
   * tool is annotated read-only — never an approval based on annotations alone.
   * @override
   * @param {Record<string, unknown>} _toolInput
   * @returns {boolean} True when auto-approved
   */
  isPermitted(_toolInput) {
    const { server, tool, info } = this._target();
    if (!info) return false;
    const mt = this.messageThread;
    if (!mt) return false;
    const values = new Set(
      mt.getRulesFor(ITEM_TYPE)
        .filter((r) => r.kind === 'glob')
        .map((r) => String(r.value))
    );
    return mcpIsPermitted(values, { server, tool, readOnly: info.readOnly, autoApprove: info.autoApprove === true });
  }

  /**
   * A "don't ask again" grant belongs to the project, as a shell pattern does:
   * trusting a server in one conversation should not mean being asked again in
   * the next. The permissions popup can still narrow one to this conversation.
   * @returns {{allowedScopes: Array<'session'|'conversation'>, defaultScope: 'session'}} Scope policy
   */
  static getPermissionScopePolicy() {
    return { allowedScopes: ['session', 'conversation'], defaultScope: 'session' };
  }

  /**
   * List the saved MCP grants in the permissions popup, so one can be narrowed
   * to this conversation or revoked. No section when there are none.
   * @override
   * @param {import('../../../js/model/message-thread.js').MessageThread} messageThread - Owning thread
   * @returns {{id: string, title: string, element: HTMLElement, dispose: () => void}|null} Permission section
   */
  static getPermissionSection(messageThread) {
    return renderMcpPermissionSection(messageThread);
  }

  /**
   * Escalating "don't ask again" choices, narrowest breadth first.
   * @override
   * @param {Record<string, unknown>} _toolInput
   * @returns {import('juggler/context-item').ApprovalSuggestion[]} Escalating approval suggestions, narrowest first
   */
  getApprovalSuggestions(_toolInput) {
    const { server, tool, info } = this._target();
    if (!info) return [];
    return mcpApprovalSuggestions({ server, tool, readOnly: info.readOnly });
  }

  /**
   * Approval dialog: name the server, the tool, and the arguments.
   * @override
   * @param {Record<string, unknown>} params
   * @returns {Promise<import('juggler/context-item').ApprovalConfig|null>} Approval dialog config
   */
  async getApprovalConfig(params) {
    const { server, info } = this._target();
    const title = t('MCP: {server} / {tool}', { server, tool: info?.title || info?.name || t('tool') });
    let argStr = '';
    try {
      argStr = JSON.stringify(params ?? {}, null, 2);
    } catch {
      argStr = String(params);
    }
    const message = info?.description
      ? t('{description}\n\nArguments:\n\n{arguments}', { description: info.description, arguments: argStr })
      : t('Arguments:\n\n{arguments}', { arguments: argStr });
    return { title, message };
  }

  /**
   * Invoke the tool via the Go manager, honoring cancellation.
   * @param {Record<string, unknown>} params - Prepared arguments
   * @returns {Promise<{server: string, tool: string, content: StoredMcpBlock[], isError: boolean, text: string, images: import('../../../js/services/ops-api.js').AssetRef[]}>} The tool call result
   */
  async execute(params) {
    const { server, tool, info, llm } = this._target();
    if (!info) {
      throw new Error(markUntranslated(`Unknown MCP tool "${llm}"`));
    }
    const result = await mcpCallTool({ server, tool, args: /** @type {object} */ (params) }, this.signal);
    const raw = Array.isArray(result?.content) ? result.content : [];
    const { blocks, images } = await storeMcpImages(raw, {
      upload: uploadAssetBase64, conversationId: this.conversation?.id, signal: this.signal
    });
    return { server, tool, content: blocks, isError: !!result?.isError, text: McpToolContextItem._extractText(raw), images };
  }

  /**
   * Concatenate the text of all text blocks.
   * @param {import('../../../js/services/ops-api.js').McpContentBlock[]} blocks
   * @returns {string} Result value
   * @private
   */
  static _extractText(blocks) {
    return blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }

  /**
   * Summarize a non-text block for the LLM when there is no text content.
   * @param {StoredMcpBlock} b
   * @param {import('../../../js/services/ops-api.js').AssetRef} [ref] - The asset an image was stored as
   * @returns {string} Result value
   * @private
   */
  static _describeBlock(b, ref) {
    switch (b?.type) {
      case 'image': {
        const what = b.mimeType || 'image';
        if (ref) return markUntranslated(`[image: ${what}${ref.width && ref.height ? `, ${ref.width}\u00d7${ref.height}` : ''}, attached below]`);
        return markUntranslated(`[image: ${what}${b.note ? `, not attached: ${b.note}` : ''}]`);
      }
      case 'audio': return markUntranslated(`[audio: ${b.mimeType || 'audio'}]`);
      case 'resource': return markUntranslated(`[resource: ${b.uri || ''}]`);
      case 'resource_link': return markUntranslated(`[resource link: ${b.uri || ''}${b.name ? ` (${b.name})` : ''}]`);
      default: return markUntranslated('[content]');
    }
  }

  /**
   * Format the outcome for the LLM + UI. isError from the server marks the item
   * failed even though execute() didn't throw.
   * @param {import('juggler/context-item').Outcome} outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result for LLM and UI
   */
  getSummary(outcome) {
    if (!outcome.success) {
      return this.failureSummary(outcome.error || markUntranslated('MCP tool call failed'));
    }
    // A successful outcome's result is what execute() returned.
    const result = /** @type {{content?: StoredMcpBlock[], isError?: boolean, text?: string, images?: import('../../../js/services/ops-api.js').AssetRef[]}} */ (outcome.result || {});
    const blocks = Array.isArray(result.content) ? result.content : [];
    const images = Array.isArray(result.images) ? result.images : [];
    const refOf = (/** @type {StoredMcpBlock} */ b) => images.find((r) => r.id === b?.attached);
    let text = result.text || '';
    if (!text) {
      text = blocks.map((b) => McpToolContextItem._describeBlock(b, refOf(b))).join('\n') || markUntranslated('(no content)');
    } else {
      // Beside text, the images are still named, so the model knows what is
      // attached and what could not be.
      const imageLines = blocks.filter((b) => b?.type === 'image').map((b) => McpToolContextItem._describeBlock(b, refOf(b)));
      if (imageLines.length) text = `${text}\n${imageLines.join('\n')}`;
    }
    // The call itself succeeded; `isError` is the server marking its own result
    // as a failure, which the item carries through as a failed summary.
    return result.isError
      ? this.failureSummary(this.truncateForLLM(text))
      : this.successSummary(this.truncateForLLM(text), images.length ? { attachments: images } : undefined);
  }

  /**
   * Status line in the viewer.
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus
   * @param {Record<string, unknown>} toolInput
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config, or null
   */
  getStatusUI(actionStatus, toolInput) {
    void toolInput;
    const info = this._target().info;
    const label = info ? `${info.server}: ${info.title || info.name}` : (this.toolName || t('MCP tool'));

    return this.buildStatusUI(actionStatus, {
      typeName: t('MCP'),
      pending: t('Calling {label}…', { label }),
      success: () => {
        const result = /** @type {{isError?: boolean}} */ (actionStatus?.result || {});
        // A completed call whose result the server flagged as an error.
        return result.isError
          ? { summary: t('{label} — tool reported an error', { label }), status: /** @type {const} */ ('error') }
          : label;
      },
      failurePrefix: t('{label} failed', { label })
    });
  }

  /**
   * @override
   * @param {string} _toolName
   * @returns {string} Result value
   */
  static getResultSectionLabel(_toolName) {
    return t('Result');
  }

  /**
   * Render the call details: server, tool, arguments, and any non-text content
   * blocks (images inline). Text content is left to the result section.
   * @override
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @returns {void} Nothing
   */
  renderToolActionDetails(wrapper, ctx) {
    const { input, helpers, toolName } = ctx;
    const info = toolByLLMName.get(toolName);
    if (info) {
      helpers.addSubsection(wrapper, t('Server'), info.server, 'properties-panel-code');
      helpers.addSubsection(wrapper, t('Tool'), info.name, 'properties-panel-code');
    }
    let argStr = '';
    try {
      argStr = JSON.stringify(input ?? {}, null, 2);
    } catch {
      argStr = String(input);
    }
    if (argStr && argStr !== '{}') {
      helpers.addSubsection(wrapper, t('Arguments'), argStr, 'properties-panel-code');
    }
  }
}

export default McpToolContextItem;
