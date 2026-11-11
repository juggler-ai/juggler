//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Render the input/output detail view for one LLM round-trip.
 *
 * The blob is loaded lazily from the per-conversation transaction store
 * (`.juggler/{convID}.txns/{txnID}.json`) when the user opens the View
 * Transaction panel. Shape mirrors what the worker writes in
 * `cmd/juggler/worker/strategy.go:saveTransactionBlob`.
 *
 * Two things shape the layout. The output is the answer, so it comes first;
 * the input is reference material you consult, so it comes second and arrives
 * as a list of rows — one per message, each carrying its estimated share of
 * the context — rather than one unreadable dump. A row builds its body the
 * first time it is opened, so a hundred-message history costs nothing to show.
 */

import { formatNumber, formatTokens } from '../utils/format.js';
import { formatNumber as formatLocaleNumber, formatDate, t, markForTranslation } from '../../sdk/lib/i18n.js';
import { escapeJsonContent } from '../../sdk/lib/html.js';
import { createCopyButton } from '../utils/properties-panel-helpers.js';
import { estimateValueTokens, LONG_TEXT_CHARS } from '../utils/token-estimate.js';
import {
  buildToolInventory,
  diffToolNames,
  formatToolDrift,
  groupToolsByOrigin,
  parseMcpToolName,
  toolDriftDetail
} from '../services/thread-tool-inventory.js';

/**
 * @typedef {object} TransactionBlobInput
 * @property {string|null} [systemPrompt] - System prompt sent to the LLM.
 * @property {Array<Record<string, unknown>>} [messages] - Provider-format message history.
 * @property {Array<Record<string, unknown>>} [tools] - Tool definitions advertised to the LLM.
 */

/**
 * @typedef {object} TransactionBlobOutputBlock
 * @property {string} type - 'text' | 'thinking' | 'tool_use'
 * @property {string} [content] - Text content when type='text'.
 * @property {string} [thinking] - Thinking content.
 * @property {string} [toolUseId] - Tool-use id when type='tool_use'.
 * @property {string} [toolName] - Tool name when type='tool_use'.
 * @property {Record<string, unknown>} [toolInput] - Tool input args when type='tool_use'.
 */

/**
 * @typedef {object} TransactionBlob
 * @property {string} id - Transaction id (matches the file stem on disk).
 * @property {string} [timestamp] - ISO8601 round-trip start time.
 * @property {number} [duration] - Round-trip duration in milliseconds.
 * @property {number} [inputTokens] - Provider-reported input tokens, or a fallback estimate when inputTokensApproximate is true.
 * @property {boolean} [inputTokensApproximate] - Whether inputTokens is a local fallback estimate.
 * @property {number} [outputTokens] - Output token count reported by the provider.
 * @property {number} [cachedTokens] - Input tokens served from prompt cache.
 * @property {number} [cacheWriteTokens] - Input tokens written to the prompt cache this turn.
 * @property {string} [stopReason] - Provider stop reason ('end_turn', 'tool_use', 'error', etc.).
 * @property {{provider?: string, model?: string}} [modelConfig] - Provider/model that handled this round-trip.
 * @property {TransactionBlobInput} [input] - Input context sent to the LLM.
 * @property {{blocks?: TransactionBlobOutputBlock[], error?: string}} [output] - Response blocks returned by the LLM, plus an error string if the round-trip failed.
 */

/** Longest row label shown before the browser's own ellipsis takes over. */
const LABEL_CHARS = 200;

/**
 * The word drawn for a tool's category. The category itself is an identifier
 * and stays as it is; only its label is translated, where it is drawn.
 */
const CATEGORY_LABELS = /** @type {Record<string, string>} */ ({
  read: markForTranslation('read'),
  write: markForTranslation('write'),
  meta: markForTranslation('meta'),
});

/**
 * Render the full transaction detail into `parent` (cleared first).
 * @param {HTMLElement} parent - Container to render into.
 * @param {TransactionBlob|null} blob - Parsed blob, or null if not found.
 * @param {string} [emptyMessage] - What to say instead when there is no blob.
 *   The default covers a blob that should exist and doesn't; callers that know
 *   the item never had a round-trip say so instead.
 * @param {{messageThread?: {strategy?: unknown}|null}} [options] - `messageThread`
 *   is the thread this transaction belongs to; given it, the tool list can say
 *   how the thread's live tools differ from the ones this turn sent.
 */
export function renderTransactionDetail(parent, blob, emptyMessage = t('No transaction data.'), options = {}) {
  parent.innerHTML = '';
  if (!blob) {
    const empty = document.createElement('div');
    empty.className = 'properties-panel-text';
    empty.textContent = emptyMessage;
    parent.appendChild(empty);
    return;
  }

  parent.appendChild(_buildMetadataBar(blob));

  const sections = document.createElement('properties-panel-tx-sections');
  sections.appendChild(_buildOutputSection(blob));
  sections.appendChild(_buildInputSection(blob, options.messageThread || null));
  parent.appendChild(sections);
}

// ============================================================================
// Section builders
// ============================================================================

/**
 * @param {TransactionBlob} blob
 * @returns {HTMLElement} Metadata bar element with tokens/cache/duration/stop/time/model.
 */
function _buildMetadataBar(blob) {
  const bar = document.createElement('properties-panel-tx-metadata');
  bar.className = 'properties-panel-tx-metadata';
  const add = (/** @type {string} */ text) => {
    const span = document.createElement('span');
    span.className = 'meta-item';
    span.textContent = text;
    bar.appendChild(span);
  };
  if (blob.inputTokens || blob.outputTokens) {
    const tokens = { input: formatNumber(blob.inputTokens ?? 0), output: formatNumber(blob.outputTokens ?? 0) };
    add(blob.inputTokensApproximate
      ? t('Tokens: ~{input} in \u2192 {output} out', tokens)
      : t('Tokens: {input} in \u2192 {output} out', tokens));
  }
  if (blob.cachedTokens !== undefined || blob.cacheWriteTokens !== undefined) {
    // A key that is present but 0 is a provider-reported zero; format it as a
    // real number. Only a fully absent pair means the provider reported no
    // cache usage at all.
    const read = blob.cachedTokens !== undefined ? formatNumber(blob.cachedTokens) : '?';
    const write = blob.cacheWriteTokens !== undefined ? formatNumber(blob.cacheWriteTokens) : '?';
    add(t('Cache: {read} read / {write} written', { read, write }));
  } else if (blob.inputTokens) {
    add(t('Cache: not reported'));
  }
  if (blob.duration) {
    const seconds = formatLocaleNumber(blob.duration / 1000, {
      minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false
    });
    add(t('Duration: {seconds}s', { seconds }));
  }
  if (blob.stopReason) {
    add(t('Stop: {reason}', { reason: blob.stopReason }));
  }
  // formatDate is '' for a garbled timestamp, which drops the field.
  const time = blob.timestamp ? formatDate(new Date(blob.timestamp), { timeStyle: 'medium' }) : '';
  if (time) {
    add(t('Time: {time}', { time }));
  }
  if (blob.modelConfig?.model) {
    add(t('Model: {model}', { model: blob.modelConfig.model }));
  }
  return bar;
}

/**
 * LLM Output: the response blocks, each rendered as what it is — text and
 * thinking as text, a tool call as its name and arguments — rather than as one
 * JSON dump with every newline escaped. Copying still yields the whole blob.
 * @param {TransactionBlob} blob
 * @returns {HTMLElement} Output section element.
 */
function _buildOutputSection(blob) {
  const output = blob.output;
  const blocks = output?.blocks || [];
  const error = output?.error;

  const reconstructed = {
    blocks,
    stopReason: blob.stopReason,
    inputTokens: blob.inputTokens,
    outputTokens: blob.outputTokens,
    // Absent means the provider reported no cache usage (unknown, not 0);
    // JSON.stringify drops the undefined key so the copy stays honest.
    cachedTokens: blob.cachedTokens
  };

  const section = _section(t('LLM Output'), {
    summary: blob.outputTokens ? t('{count, plural, one {{tokens} token} other {{tokens} tokens}}', { count: blob.outputTokens, tokens: formatLocaleNumber(blob.outputTokens) }) : '',
    copyText: JSON.stringify(reconstructed, null, 2),
    copyLabel: t('Copy the output as JSON')
  });

  if (error) {
    const errEl = document.createElement('pre');
    errEl.className = 'properties-panel-result is-error';
    errEl.textContent = error;
    section.appendChild(errEl);
  }

  if (blocks.length) {
    for (const block of blocks) section.appendChild(_buildOutputBlock(block));
  } else if (!error) {
    const msg = blob.stopReason === 'cancelled' ? t('Cancelled before any output.') : t('The model returned nothing.');
    section.appendChild(_textBlock(msg));
  }

  return section;
}

/**
 * @param {TransactionBlobOutputBlock} block - One response block.
 * @returns {HTMLElement} Rendered block, labelled with its kind.
 */
function _buildOutputBlock(block) {
  const el = document.createElement('div');
  el.className = 'transaction-out-block';

  const kind = document.createElement('div');
  kind.className = 'transaction-out-kind';
  // A block's type and a tool's name are the provider's identifiers, shown as they are.
  kind.textContent = block.type === 'tool_use' && block.toolName
    ? `tool_use · ${block.toolName}` // i18n-ignore: provider block type and tool name
    : (block.type || t('block', undefined, { context: 'transaction output block kind' }));
  el.appendChild(kind);

  if (block.type === 'text' || block.type === 'thinking') {
    el.appendChild(_textBlock(block.content ?? block.thinking ?? ''));
    return el;
  }

  const { type: _t, ...rest } = block;
  _appendValue(el, rest, 0);
  return el;
}

/**
 * LLM Input as a list of rows — the system prompt, the tool definitions, then
 * one row per message — each carrying its estimated share of the context, so
 * "what is in here and what is eating it" is answerable at a glance. The final
 * message opens by default: it is the one this round-trip was actually
 * responding to.
 * @param {TransactionBlob} blob
 * @param {{strategy?: unknown}|null} [messageThread] - Thread this transaction belongs to, for the tool list's drift line.
 * @returns {HTMLElement} Input section element.
 */
function _buildInputSection(blob, messageThread = null) {
  const input = blob.input;
  const messages = input?.messages || [];
  const tools = input?.tools || [];
  const systemPrompt = input?.systemPrompt || '';

  const fullJson = JSON.stringify({
    systemPrompt: input?.systemPrompt ?? null,
    messages,
    tools
  }, null, 2);

  const section = _section(t('LLM Input'), {
    summary: _inputSummary(blob, { systemPrompt, messages, tools }),
    copyText: fullJson,
    copyLabel: t('Copy the whole input as JSON')
  });

  if (!input || (!systemPrompt && !messages.length && !tools.length)) {
    section.appendChild(_textBlock(t('No input recorded.')));
    return section;
  }

  const rows = document.createElement('div');
  rows.className = 'transaction-rows';

  if (systemPrompt) {
    rows.appendChild(_row(
      t('system prompt', undefined, { context: 'transaction row kind' }), _firstLine(systemPrompt), systemPrompt
    ));
  }
  if (tools.length) {
    rows.appendChild(_buildToolsRow(tools, blob, messageThread));
  }

  const displayMessages = _transformMessagesForDisplay(messages);
  displayMessages.forEach((msg, i) => {
    // A message's type is the provider's identifier, shown as it is.
    const kind = typeof msg.type === 'string' && msg.type
      ? msg.type
      : t('message', undefined, { context: 'transaction row kind' });
    rows.appendChild(_row(kind, _messageLabel(msg), msg, { open: i === displayMessages.length - 1 }));
  });

  section.appendChild(rows);
  return section;
}

/**
 * The input's own size line: what we estimate, checked against what the
 * provider reported. Seeing both is what tells the user how far to trust the
 * per-row estimates below.
 * @param {TransactionBlob} blob
 * @param {{systemPrompt: string, messages: Array<Record<string, unknown>>, tools: Array<Record<string, unknown>>}} parts
 * @returns {string} Summary line for the section header.
 */
function _inputSummary(blob, parts) {
  const estimated = estimateValueTokens(parts.systemPrompt)
    + estimateValueTokens(parts.messages)
    + estimateValueTokens(parts.tools);
  if (blob.inputTokens && !blob.inputTokensApproximate) {
    return t('~{estimated} estimated · {reported} reported', {
      estimated: formatTokens(estimated), reported: formatLocaleNumber(blob.inputTokens)
    });
  }
  return t('~{estimated} estimated', { estimated: formatTokens(estimated) });
}

// ============================================================================
// Rows
// ============================================================================

/**
 * One collapsible row: kind, a one-line label, and the entry's estimated token
 * cost. The body is built on first open — a long history stays cheap until the
 * user actually asks for a message.
 * @param {string} kind - Row kind shown in the leading lozenge (e.g. 'tool-use').
 * @param {string} label - One-line preview, ellipsised by CSS when it overflows.
 * @param {unknown} value - The entry itself; rendered as the body, measured for the size.
 * @param {{open?: boolean, body?: () => HTMLElement}} [options] - `open` renders the row
 *   expanded; `body` replaces the generic value tree for entries that deserve a
 *   shape of their own.
 * @returns {HTMLElement} The row element.
 */
function _row(kind, label, value, { open = false, body = undefined } = {}) {
  const row = document.createElement('details');
  row.className = 'transaction-row';

  const summary = document.createElement('summary');
  summary.className = 'transaction-row-summary';

  const kindEl = document.createElement('span');
  kindEl.className = 'transaction-row-kind';
  kindEl.textContent = kind;
  summary.appendChild(kindEl);

  const labelEl = document.createElement('span');
  labelEl.className = 'transaction-row-label text-truncate';
  labelEl.textContent = label;
  labelEl.title = label;
  summary.appendChild(labelEl);

  const sizeEl = document.createElement('span');
  sizeEl.className = 'transaction-row-size';
  sizeEl.textContent = `~${formatTokens(estimateValueTokens(value))}`;
  sizeEl.title = t('Estimated tokens (~4 characters per token)');
  summary.appendChild(sizeEl);

  summary.appendChild(createCopyButton(
    () => (typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
    'btn btn-icon btn-secondary transaction-row-copy',
    t('Copy this entry')
  ));

  row.appendChild(summary);

  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    row.appendChild(body ? body() : _buildEntryBody(value));
  };
  row.addEventListener('toggle', () => {
    if (row.open) build();
  });
  if (open) {
    row.open = true;
    build();
  }

  return row;
}

// ============================================================================
// Tool definitions
// ============================================================================

/**
 * @typedef {object} ToolEntry
 * @property {string} [name] - LLM-facing tool name.
 * @property {string} [description] - Description advertised to the model.
 * @property {unknown} [input_schema] - JSON Schema for the arguments.
 * @property {string} [category] - 'read' | 'write' | 'meta', when the engine recorded one.
 */

/**
 * The tools row: how many, and how much of the request they account for. Every
 * tool the model was offered on this round-trip is listed underneath, because
 * "was my tool actually offered" is otherwise unanswerable from the outside —
 * a tool missing from this list never reached the model, whatever the model
 * said about it.
 * @param {ToolEntry[]} tools - Tool definitions as recorded in the blob.
 * @param {TransactionBlob} blob - The blob, for when this list was sent.
 * @param {{strategy?: unknown}|null} messageThread - Thread this transaction belongs to, or null.
 * @returns {HTMLElement} The row element.
 */
function _buildToolsRow(tools, blob, messageThread) {
  const groups = groupToolsByOrigin(tools);
  const mcpCount = groups.reduce((n, g) => n + (g.server === null ? 0 : g.tools.length), 0);
  const label = mcpCount
    ? t('{count, plural, one {{count} tool} other {{count} tools}} · {mcp, plural, other {{mcp} from MCP}}', {
      count: tools.length, mcp: mcpCount
    })
    : t('{count, plural, one {{count} tool} other {{count} tools}}', { count: tools.length });
  return _row(t('tools', undefined, { context: 'transaction row kind' }), label, tools, { body: () => _buildToolList(groups, tools, blob, messageThread) });
}

/**
 * @param {ReturnType<typeof groupToolsByOrigin>} groups - Grouped tools.
 * @param {ToolEntry[]} tools - The same tools, ungrouped, for the header.
 * @param {TransactionBlob} blob - The blob, for when this list was sent.
 * @param {{strategy?: unknown}|null} messageThread - Thread this transaction belongs to, or null.
 * @returns {HTMLElement} The row body.
 */
function _buildToolList(groups, tools, blob, messageThread) {
  const body = document.createElement('div');
  body.className = 'transaction-row-body transaction-tools';
  body.appendChild(_buildToolsHeader(tools, blob, messageThread));
  for (const group of groups) {
    const heading = document.createElement('div');
    heading.className = 'transaction-tool-group';

    const title = document.createElement('span');
    title.className = 'transaction-tool-group-title text-truncate';
    title.textContent = group.title;
    heading.appendChild(title);

    const count = document.createElement('span');
    count.className = 'transaction-tool-group-count';
    count.textContent = `${group.tools.length} · ~${formatTokens(group.tokens)}`;
    count.title = t('Tools in this group, and their estimated share of the request');
    heading.appendChild(count);

    body.appendChild(heading);
    for (const tool of group.tools) body.appendChild(_buildToolEntry(tool, group.server));
  }
  return body;
}

/**
 * What this list is, said out loud: a record of one moment, not the tools the
 * thread has now.
 *
 * This is the surface someone opens when they suspect a tool is missing, and an
 * undated list invites the wrong conclusion — a server that finished connecting
 * after this turn genuinely has tools that are absent here, and that is not a
 * bug. The count and the send time state the first half; {@link _appendToolDrift}
 * fills in the second when the two lists have actually moved apart.
 * @param {ToolEntry[]} tools - Tool definitions as recorded in the blob.
 * @param {TransactionBlob} blob - The blob, for its timestamp.
 * @param {{strategy?: unknown}|null} messageThread - Thread this transaction belongs to, or null.
 * @returns {HTMLElement} The header element.
 */
function _buildToolsHeader(tools, blob, messageThread) {
  const header = document.createElement('div');
  header.className = 'transaction-tools-header';

  const sent = document.createElement('div');
  sent.className = 'transaction-tools-sent';
  const time = blob?.timestamp ? formatDate(new Date(blob.timestamp), { timeStyle: 'medium' }) : '';
  const count = tools.length;
  sent.textContent = time
    ? t('{count, plural, one {{count} tool} other {{count} tools}}, as sent at {time} — not the live list.', {
      count, time
    })
    : t('{count, plural, one {{count} tool} other {{count} tools}}, as sent — not the live list.', { count });
  header.appendChild(sent);

  if (messageThread) void _appendToolDrift(header, tools, messageThread);
  return header;
}

/**
 * Add the drift line when the thread's live tool list has moved since this turn.
 *
 * The same statement the System Prompt panel makes, from the other end: there it
 * reads "since the last turn", here "since this turn", and both mean the model
 * has not been offered the current list. Best-effort and silent on failure — the
 * recorded list is ground truth on its own, and a comparison we can't make is no
 * reason to spoil it.
 * @param {HTMLElement} header - Header element to append to.
 * @param {ToolEntry[]} tools - Tool definitions as recorded in the blob.
 * @param {{strategy?: unknown}} messageThread - Thread this transaction belongs to.
 * @returns {Promise<void>}
 */
async function _appendToolDrift(header, tools, messageThread) {
  try {
    const inventory = await buildToolInventory(messageThread);
    const drift = diffToolNames(/** @type {Array<Record<string, any>>} */ (tools), inventory.offered);
    const changes = formatToolDrift(drift);
    if (!changes) return;

    const line = document.createElement('div');
    line.className = 'transaction-tools-drift';
    line.textContent = t('{changes} since this turn — the model has not been offered the current list yet.', {
      changes
    });
    line.title = toolDriftDetail(drift);
    header.appendChild(line);
  } catch {
    // No inventory, no comparison. The list above still stands on its own.
  }
}

/**
 * One tool: its name, what the model was told it does, and what it cost to say
 * so. Opens to the schema the model was given, which is the level of detail
 * that settles an argument about why a call came out malformed.
 * @param {ToolEntry} tool - One tool definition.
 * @param {string|null} server - Owning MCP server, or null for a built-in.
 * @returns {HTMLElement} The tool element.
 */
function _buildToolEntry(tool, server) {
  const name = String(tool?.name || '');
  const parts = server === null ? null : parseMcpToolName(name);

  const entry = document.createElement('details');
  entry.className = 'transaction-tool';

  const summary = document.createElement('summary');
  summary.className = 'transaction-tool-summary';

  const nameEl = document.createElement('span');
  nameEl.className = 'transaction-tool-name text-truncate';
  // Inside an MCP group the server is already named by the heading, so the
  // prefix is noise; the full name stays in the tooltip for copying out.
  nameEl.textContent = parts ? parts.tool : name;
  nameEl.title = name;
  summary.appendChild(nameEl);

  if (tool?.category) {
    const cat = document.createElement('span');
    cat.className = 'transaction-tool-category';
    const category = String(tool.category);
    cat.textContent = CATEGORY_LABELS[category] ? t(CATEGORY_LABELS[category]) : category;
    summary.appendChild(cat);
  }

  const desc = document.createElement('span');
  desc.className = 'transaction-tool-desc text-truncate';
  desc.textContent = _firstLine(String(tool?.description || ''));
  desc.title = String(tool?.description || '');
  summary.appendChild(desc);

  const size = document.createElement('span');
  size.className = 'transaction-row-size';
  size.textContent = `~${formatTokens(estimateValueTokens(tool))}`;
  size.title = t('Estimated tokens (~4 characters per token)');
  summary.appendChild(size);

  entry.appendChild(summary);

  let built = false;
  entry.addEventListener('toggle', () => {
    if (!entry.open || built) return;
    built = true;
    entry.appendChild(_buildEntryBody(tool?.input_schema ?? tool));
  });

  return entry;
}

/**
 * A one-line preview of a message for its row label: the tool name (plus its
 * most identifying argument) for a tool call, otherwise the first line of the
 * content.
 * @param {Record<string, any>} msg - Message entry.
 * @returns {string} Label text.
 */
function _messageLabel(msg) {
  if (msg.type === 'tool-use') {
    const name = typeof msg.toolName === 'string' ? msg.toolName : '';
    const arg = _firstStringValue(msg.toolInput);
    return arg ? `${name} · ${arg}` : name;
  }
  if (typeof msg.content === 'string') return _firstLine(msg.content);
  return _firstLine(_firstStringValue(msg));
}

/**
 * @param {unknown} value - Object to scan.
 * @returns {string} The first string value on the object, or ''.
 */
function _firstStringValue(value) {
  if (!value || typeof value !== 'object') return '';
  for (const v of Object.values(value)) {
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

/**
 * @param {string} text - Source text.
 * @returns {string} The first non-empty line, capped for the label slot.
 */
function _firstLine(text) {
  if (!text) return '';
  const line = String(text).split('\n').find((l) => l.trim()) || '';
  return line.trim().slice(0, LABEL_CHARS);
}

// ============================================================================
// Value rendering
// ============================================================================

/**
 * @param {unknown} value - The entry to render.
 * @returns {HTMLElement} The row body element.
 */
function _buildEntryBody(value) {
  const body = document.createElement('div');
  body.className = 'transaction-row-body';
  _appendValue(body, value, 0);
  return body;
}

/**
 * Render a value so that prose reads as prose: any long or multi-line string
 * becomes its own text block under its key, and the remaining short fields
 * stay together as compact JSON. Without this every newline in a system prompt
 * or a file body renders as a literal `\n` on one enormous line.
 * @param {HTMLElement} parent - Element to append into.
 * @param {unknown} value - Value to render.
 * @param {number} depth - Current nesting depth (bounded, so a pathological blob can't recurse forever).
 */
function _appendValue(parent, value, depth) {
  if (typeof value === 'string') {
    parent.appendChild(_textBlock(value));
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth >= 3) {
    parent.appendChild(_jsonBlock(value));
    return;
  }

  /** @type {Record<string, unknown>} */
  const compact = {};
  /** @type {Array<[string, unknown]>} */
  const expanded = [];
  for (const [key, v] of Object.entries(value)) {
    if (_isLongText(v) || _holdsLongText(v)) expanded.push([key, v]);
    else compact[key] = v;
  }

  if (Object.keys(compact).length > 0) parent.appendChild(_jsonBlock(compact));

  for (const [key, v] of expanded) {
    const field = document.createElement('div');
    field.className = 'transaction-field';
    const keyEl = document.createElement('div');
    keyEl.className = 'transaction-field-key';
    keyEl.textContent = key;
    field.appendChild(keyEl);
    _appendValue(field, v, depth + 1);
    parent.appendChild(field);
  }
}

/**
 * @param {unknown} value - Candidate value.
 * @returns {boolean} True for a string worth its own text block.
 */
function _isLongText(value) {
  return typeof value === 'string' && (value.includes('\n') || value.length > LONG_TEXT_CHARS);
}

/**
 * @param {unknown} value - Candidate object.
 * @returns {boolean} True when an object holds a long string one level down.
 */
function _holdsLongText(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).some(_isLongText);
}

// ============================================================================
// Tiny DOM helpers
// ============================================================================

/**
 * @param {string} title - Section title.
 * @param {{summary?: string, copyText?: string, copyLabel?: string}} [options] - Right-hand size line and copy-all button.
 * @returns {HTMLElement} Subsection wrapper with a header row.
 */
function _section(title, { summary = '', copyText = '', copyLabel = t('Copy to clipboard') } = {}) {
  const el = document.createElement('properties-panel-subsection');

  const head = document.createElement('div');
  head.className = 'transaction-section-head';

  const h = document.createElement('h4');
  h.className = 'properties-panel-subtitle caps-label-lg';
  h.textContent = title;
  head.appendChild(h);

  if (summary) {
    const summaryEl = document.createElement('span');
    summaryEl.className = 'transaction-section-summary';
    summaryEl.textContent = summary;
    head.appendChild(summaryEl);
  }
  if (copyText) {
    head.appendChild(createCopyButton(copyText, 'btn btn-icon btn-secondary', copyLabel));
  }

  el.appendChild(head);
  return el;
}

/**
 * @param {string} text - Text to show.
 * @returns {HTMLElement} Plain text block styled like other panel text.
 */
function _textBlock(text) {
  const el = document.createElement('pre');
  el.className = 'properties-panel-text transaction-text';
  el.textContent = text;
  return el;
}

/**
 * @param {unknown} value - Value to render as syntax-highlighted JSON.
 * @returns {HTMLElement} The rendered block.
 */
function _jsonBlock(value) {
  const pre = document.createElement('pre');
  pre.className = 'properties-panel-json-display';
  pre.innerHTML = _formatJson(value);
  return pre;
}

/**
 * Reorder messages so that tool-result entries are nested under their
 * matching tool-use.
 * @param {Array<Record<string, unknown>>} messages
 * @returns {Array<Record<string, unknown>>} Messages with tool-results folded into their tool-use entry.
 */
function _transformMessagesForDisplay(messages) {
  /** @type {Map<string, Record<string, unknown>>} */
  const resultsByToolUseId = new Map();
  for (const msg of messages) {
    if (msg.type === 'tool-result' && typeof msg.toolUseId === 'string') {
      const { type: _t, toolUseId: _id, ...rest } = msg;
      resultsByToolUseId.set(msg.toolUseId, rest);
    }
  }

  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  for (const msg of messages) {
    if (msg.type === 'tool-result') continue;
    const { type, ...rest } = msg;
    /** @type {Record<string, unknown>} */
    const reordered = { type, ...rest };
    if (type === 'tool-use' && typeof msg.toolUseId === 'string') {
      const result = resultsByToolUseId.get(msg.toolUseId);
      if (result) reordered.result = result;
    }
    out.push(reordered);
  }
  return out;
}

/**
 * Render an arbitrary value as syntax-highlighted JSON HTML.
 * @param {unknown} value
 * @param {number} [indent]
 * @returns {string} HTML markup for the JSON-rendered value.
 */
function _formatJson(value, indent = 0) {
  const pad = '  '.repeat(indent);
  const padNext = '  '.repeat(indent + 1);

  if (value === null) return '<span class="json-null">null</span>';
  if (value === undefined) return '<span class="json-undefined">undefined</span>';

  const type = typeof value;
  if (type === 'boolean') return `<span class="json-boolean">${String(value)}</span>`;
  if (type === 'number') return `<span class="json-number">${String(value)}</span>`;
  if (type === 'string') return `<span class="json-string">"${escapeJsonContent(/** @type {string} */ (value))}"</span>`;

  if (Array.isArray(value)) {
    if (value.length === 0) return '<span class="json-bracket">[]</span>';
    let out = '<span class="json-bracket">[</span>\n';
    value.forEach((entry, i) => {
      out += padNext + _formatJson(entry, indent + 1);
      if (i < value.length - 1) out += '<span class="json-comma">,</span>';
      out += '\n';
    });
    out += pad + '<span class="json-bracket">]</span>';
    return out;
  }

  if (type === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(obj);
    if (keys.length === 0) return '<span class="json-bracket">{}</span>';
    let out = '<span class="json-bracket">{</span>\n';
    keys.forEach((key, i) => {
      out += padNext + `<span class="json-key">"${escapeJsonContent(key)}"</span>: ` + _formatJson(obj[key], indent + 1);
      if (i < keys.length - 1) out += '<span class="json-comma">,</span>';
      out += '\n';
    });
    out += pad + '<span class="json-bracket">}</span>';
    return out;
  }

  return String(value);
}
