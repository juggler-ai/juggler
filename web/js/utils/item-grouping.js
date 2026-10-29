//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * item-grouping — folds a run of adjacent tool-use rows into one display entry.
 *
 * This is a **display transform only**. Nothing here reads or writes the
 * conversation document: `buildDisplayItems` takes the items a column is about
 * to render and returns the same Y.Maps with each run replaced by an
 * {@link ItemGroup} wrapper. Turning the preference off renders the identical
 * list unfolded, because the model never changed.
 *
 * ## What counts as groupable — inferred, with one declared exception
 *
 * A tool use is exactly an item whose Yjs `type` is `'tool-action'` (see
 * `model/SCHEMA.md` §2). Every item that must NOT fold already has a different
 * type: `user`, `assistant`, `thinking`, `error`, `thread`, and standing
 * context items (whose `type` IS their context-item id — `system-prompt`,
 * `memory`, `file-content`, …). So for almost everything groupability needs no
 * declaration at all: a new tool groups automatically, and a new
 * standing-context type never does.
 *
 * What the type cannot express is a tool row that is not merely the record of a
 * tool having run. An item that opts out of a standing card (`isVisible()`
 * false — the plan and the todo list) renders its entire state on its tool row,
 * so folding that row hides the item ITSELF, not a record of it; and a row the
 * user must keep in sight (a question they answered, a slash command or a
 * conversation created outside this transcript) is not summary fodder either.
 * Such a type declares `static isGroupable()` false on its `ContextItem` class
 * — the one thing an author opts into — and its rows are left unfolded, each
 * breaking the run around it like any other real row.
 *
 * The one refinement is invisibility. A tool-action whose result is a context
 * item renders no row at all (`conversation-area-rendering.createToolActionElement`),
 * as does an assistant/thinking bubble with no visible text. Such items are
 * treated as transparent — they neither join a run nor split one — so a fold
 * matches what the user actually sees on screen.
 * @module utils/item-grouping
 */

import contextItemRegistry from '../registries/context-item-registry.js';
import { hasPendingApprovalInTree, hasUnsettledToolInTree } from '../model/thread-navigation.js';
import { TOOL_STATES, MESSAGE_TYPES, itemField } from '../../sdk/lib/message.js';
import { anyThreadLive } from './thread-display.js';
import { t, formatList } from '../../sdk/lib/i18n.js';

/** Display `type` reported by a group entry (never a document item type). */
const GROUP_TYPE = 'tool-group';

/** Prefix marking a display id as a group rather than a document itemId. */
const GROUP_ID_PREFIX = 'group:';

/** Minimum number of visible tool rows before a run is worth folding. */
const MIN_RUN = 2;

/** Distinct tool kinds named in a group's summary before it says "+N more". */
const MAX_SUMMARY_KINDS = 3;

/** U+00A0, spelled out so it can't be mistaken for an ordinary space in source. */
const NBSP = '\u00A0';

/**
 * One field of a row, read through its `get` — a Y.Map's, or a group's.
 * @param {unknown} item - The row.
 * @param {string} key - Field name.
 * @returns {unknown} The field value, or undefined for anything with no `get`.
 */
function field(item, key) {
  if (!item || typeof item !== 'object' || !('get' in item) || typeof item.get !== 'function') return undefined;
  return /** @type {unknown} */ (item.get(key));
}

/**
 * The rows a group still has in the document.
 *
 * Deleting a Y.Map clears all of its entries, so a member removed by an undo
 * (or any delete) reports `undefined` for EVERY field — including `type`. Such
 * a row is not part of the run any more and must not be counted or described.
 * @template T
 * @param {ReadonlyArray<T>} members - The group's members, live or stale.
 * @returns {T[]} Only the members the document still holds.
 */
function presentRows(members) {
  return members.filter((m) => field(m, 'type') === 'tool-action');
}

/**
 * How many rows a group actually shows. The tile's badge and its composition
 * summary both count this, so the two always agree.
 * @param {ReadonlyArray<unknown>} members - The group's tool-action items.
 * @returns {number} Number of rows still in the document.
 */
export function countGroupRows(members) {
  return presentRows(members).length;
}

/**
 * A folded run of tool-action items.
 *
 * Quacks like a Yjs item for the two fields the renderer's id-based diff needs
 * (`itemId`, `type`), so `getItemId`, `identifyElementsToKeep` and
 * `positionElements` handle a group with no special-casing. The id is derived
 * from the first member, so it stays stable as the run grows — the common case
 * while a turn streams in.
 * @template [T=unknown]
 */
export class ItemGroup {
  /**
   * @param {T[]} members - The tool-action Y.Maps in this run, in order.
   */
  constructor(members) {
    /** @type {T[]} */
    this.members = members;
    /** @type {string} @private */
    this._id = GROUP_ID_PREFIX + String(field(members[0], 'itemId') || '');
  }

  /**
   * @overload
   * @param {'itemId'|'type'} key - Field name.
   * @returns {string} The group's display id, or its display type.
   */
  /**
   * @overload
   * @param {'items'} key - Field name.
   * @returns {T[]} The group's members.
   */
  /**
   * @overload
   * @param {string} key - Field name.
   * @returns {string|T[]|undefined} The field value, or undefined.
   */
  /**
   * Yjs-shaped field read. Only the fields the render/selection path asks for
   * are answered; anything else is undefined, exactly as for a Y.Map key that
   * was never set.
   * @param {string} key - Field name.
   * @returns {string|T[]|undefined} The field value, or undefined.
   */
  get(key) {
    switch (key) {
      case 'itemId': return this._id;
      case 'type': return GROUP_TYPE;
      case 'items': return this.members;
      default: return undefined;
    }
  }
}

/**
 * Whether a display entry is a folded group rather than a document item.
 * @param {unknown} entry - Entry from {@link buildDisplayItems}.
 * @returns {entry is ItemGroup} True for a group entry.
 */
export function isGroupEntry(entry) {
  return entry instanceof ItemGroup;
}

/**
 * Whether an id names a group (as opposed to a document itemId).
 * @param {string|null|undefined} id - Candidate id.
 * @returns {boolean} True for a group id.
 */
export function isGroupId(id) {
  return typeof id === 'string' && id.startsWith(GROUP_ID_PREFIX);
}

/**
 * Read a field off a tool-action's `result`, which may be a Y.Map or a plain
 * object depending on how it was written.
 * @param {unknown} item - Tool-action item.
 * @param {string} key - Result field name.
 * @returns {unknown} The field value, or undefined.
 */
function resultField(item, key) {
  const result = field(item, 'result');
  if (!result || typeof result !== 'object') return undefined;
  return 'get' in result ? field(result, key) : /** @type {Record<string, unknown>} */ (result)[key];
}

/**
 * Whether an item renders no row in the transcript, and so should neither join
 * a run nor break one. Mirrors the cases the bubble factory bails on: a
 * tool-action that produced a context item (rendered as that context item, not
 * as a tool row), a text bubble with nothing visible in it, and a Continue's
 * marker, which is a run record rather than a message.
 * @param {unknown} item - Conversation item Y.Map.
 * @returns {boolean} True if the item paints nothing.
 */
function rendersNothing(item) {
  const type = field(item, 'type');
  if (type === 'user') return !!field(item, 'continuation');
  if (type === 'tool-action') return resultField(item, 'resultType') === 'context';
  if (type === 'assistant' || type === 'thinking') {
    const stored = field(item, 'content');
    const content = typeof stored === 'string' ? stored : '';
    // Plan tags are surfaced by the next-steps indicator, not as a bubble, so a
    // message holding only a plan paints nothing — same test the bubble uses.
    return !content.replace(/<plan>[\s\S]*?<\/plan>/g, '').replace(/<plan[\s\S]*$/, '').trim();
  }
  return false;
}

/**
 * Whether an item paints no row anywhere in the transcript.
 *
 * The grouping fold and the selection both need this, for the same reason: an
 * item with no row on screen is an item the user cannot be pointed at. It is
 * every case {@link rendersNothing} covers, plus durable provider continuation
 * state, which the bubble factory discards before any of them
 * (`conversation-area-rendering.createBubblesForEvent`).
 * @param {unknown} item - Conversation item Y.Map.
 * @returns {boolean} True if the item has no row of its own.
 */
export function paintsNoRow(item) {
  return itemField(item, 'type') === MESSAGE_TYPES.PROVIDER_STATE || rendersNothing(item);
}

/**
 * The context-item plugin class that owns a tool row, if any is registered for
 * its tool name. A tool no plugin claims (an MCP tool, an unknown name) has no
 * class, and callers fall back to their defaults.
 * @param {unknown} item - Tool-action item.
 * @returns {typeof import('juggler/context-item').default|null} The owning plugin class, or null.
 */
function pluginFor(item) {
  const toolName = field(item, 'toolName');
  return typeof toolName === 'string' && toolName ? contextItemRegistry.getByToolName(toolName) || null : null;
}

/**
 * Whether an item is a tool row eligible to fold into a group. A row whose
 * owning plugin declares `static isGroupable()` false is never folded; a tool
 * with no registered plugin folds, as every ordinary tool does.
 * @param {unknown} item - Conversation item Y.Map.
 * @returns {boolean} True if the item is a visible, foldable tool-action row.
 */
function isGroupable(item) {
  if (field(item, 'type') !== 'tool-action' || rendersNothing(item)) return false;
  return pluginFor(item)?.isGroupable?.() !== false;
}

/**
 * Fold each maximal run of adjacent tool rows into a single display entry.
 * @template T
 * @param {T[]|null|undefined} items - The column's items, in document order.
 * @param {{enabled?: boolean}} [opts] - `enabled: false` returns the items untouched.
 * @returns {{entries: Array<T|ItemGroup<T>>, memberToGroup: Map<string, string>}} The entries to
 *   render (items and {@link ItemGroup}s), and a lookup from a folded member's
 *   itemId to the display id of the group hiding it.
 */
export function buildDisplayItems(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  /** @type {Map<string, string>} */
  const memberToGroup = new Map();
  if (!opts.enabled) return { entries: list, memberToGroup };

  /** @type {Array<T|ItemGroup<T>>} */
  const entries = [];
  /** @type {T[]} */
  let run = [];
  /** @type {T[]} */
  let passengers = [];

  // Close the open run: fold it when it's long enough to be worth folding,
  // otherwise emit its members as they were. Invisible items picked up mid-run
  // ride along afterwards; they paint nothing, so their position is immaterial.
  const flush = () => {
    if (run.length >= MIN_RUN) {
      const group = new ItemGroup(run);
      const groupId = String(group.get('itemId'));
      for (const member of run) {
        const memberId = field(member, 'itemId');
        if (typeof memberId === 'string') memberToGroup.set(memberId, groupId);
      }
      entries.push(group);
    } else {
      entries.push(...run);
    }
    entries.push(...passengers);
    run = [];
    passengers = [];
  };

  for (const item of list) {
    if (!item || typeof item !== 'object' || !('get' in item) || !item.get) continue;
    if (isGroupable(item)) {
      run.push(item);
    } else if (paintsNoRow(item)) {
      // Transparent: keeps the run open across it.
      (run.length ? passengers : entries).push(item);
    } else {
      flush();
      entries.push(item);
    }
  }
  flush();

  return { entries, memberToGroup };
}

/**
 * Re-derive a group by its display id. Used by the column chain, which holds
 * only the selected id and must recover the run it stands for.
 * @template T
 * @param {T[]|null|undefined} items - The column's items, in document order.
 * @param {string} groupId - Display id of the group to find.
 * @returns {ItemGroup<T>|null} The group, or null if the run no longer exists.
 */
export function findGroup(items, groupId) {
  if (!isGroupId(groupId)) return null;
  const { entries } = buildDisplayItems(items, { enabled: true });
  for (const entry of entries) {
    if (isGroupEntry(entry) && entry.get('itemId') === groupId) return entry;
  }
  return null;
}

/**
 * A key that changes whenever a group column must re-render: the group's id,
 * then each member's id and state. States are part of it because no Yjs
 * observer is bound to a group, so a row going pending → completed is only
 * noticed through this key.
 * @param {string} groupId - Display id of the group.
 * @param {ReadonlyArray<unknown>} members - The group's rows, in order.
 * @returns {string} The render key.
 */
export function groupRenderKey(groupId, members) {
  const rows = members.map((member) => `${String(field(member, 'itemId') ?? '')}:${String(field(member, 'state') ?? '')}`);
  return `${groupId}|${rows.join(',')}`;
}

/**
 * Where a group's rows sit in the list it was folded from — the positions a
 * caller must remove to delete the whole run.
 *
 * This stays display-side work: it reads the list it is handed and returns
 * indices into it, exactly as {@link buildDisplayItems} reads that list and
 * returns entries. Mutating the document is entirely the caller's business.
 * @param {unknown[]} items - The column's items, in document order.
 * @param {string} groupId - Display id of the group.
 * @returns {number[]} Ascending indices of the group's rows; empty when the run
 *   no longer exists.
 */
export function groupMemberIndices(items, groupId) {
  const group = findGroup(items, groupId);
  if (!group) return [];
  const memberIds = new Set(presentRows(group.members).map((member) => field(member, 'itemId')));
  /** @type {number[]} */
  const indices = [];
  items.forEach((item, index) => {
    if (memberIds.has(field(item, 'itemId'))) indices.push(index);
  });
  return indices;
}

/**
 * The user-facing label for one tool row — the owning plugin's manifest name
 * ("Read File", "Execute Command"), falling back to the raw tool name for a
 * tool no plugin claims.
 * @param {unknown} item - Tool-action item.
 * @returns {string} Display label.
 */
function toolLabel(item) {
  const toolName = field(item, 'toolName');
  return pluginFor(item)?.MANIFEST?.name || (typeof toolName === 'string' && toolName) || 'Tool';
}

/**
 * Describe what a group contains: each distinct tool kind with its count,
 * commonest first (e.g. "3× Read File, 2× Execute Command"). Ties keep
 * first-appearance order, since `sort` is stable.
 *
 * Long mixtures are capped at {@link MAX_SUMMARY_KINDS} kinds so the tile stays
 * one line, and the tail is reported as the number of ROWS it stands for, not
 * the number of kinds — every number in the line counts tool rows, so they sum
 * to the row count on the badge ("30 tools" → "4× …, 2× …, 2× …, +22 more").
 * Naming the biggest kinds first is what keeps that tail small.
 *
 * A count is joined to the kind it counts by a NON-BREAKING space, so the two
 * always wrap as one word. The line's only ordinary spaces are the ", "
 * separators between kinds, which makes them the only places it can break — the
 * list wraps between entries, never leaving a bare "3×" stranded at the end of
 * a line from the kind it belongs to.
 * @param {ReadonlyArray<unknown>} members - The group's tool-action items.
 * @returns {string} Composition summary.
 */
export function summarizeGroup(members) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const member of presentRows(members)) {
    const label = toolLabel(member);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const kinds = [...counts].sort((a, b) => b[1] - a[1]);
  const shown = kinds.slice(0, MAX_SUMMARY_KINDS);
  const parts = shown.map(([label, count]) => `${count}×${NBSP}${label}`);
  if (kinds.length > MAX_SUMMARY_KINDS) {
    const count = kinds.slice(MAX_SUMMARY_KINDS).reduce((total, [, n]) => total + n, 0);
    parts.push(t('{count, plural, other {+{count}\u00A0more}}', { count }));
  }
  return formatList(parts);
}

/**
 * Classify a group for tile display, in the same {@link
 * import('./thread-display.js').ThreadStatus} shape a sub-thread tile uses — so
 * the group tile paints through the shared thread-display painters and inherits
 * their styling (notably the orange pulse of `data-kind="paused"`).
 *
 * A group is a run of tool rows, so its state is the aggregate of theirs, using
 * the same tree predicates the thread tiles and the conversation tab already
 * agree on. Awaiting approval wins outright: whatever else is going on, the
 * user has something to act on inside this tile.
 *
 * The classification is deliberately conservative about claiming to be busy: a
 * tile is a summary of rows the user can't see, so busy-ness it shows is
 * something they cannot check or dismiss. It therefore reports live work only
 * from positive evidence — see the two guards below.
 *
 * No group ever asks for a spinner. The live status a running group would
 * report is the conversation's own, already painted in the column footer
 * directly beneath the tile; repeating it word for word buys nothing. The
 * tile's pulse (driven by `kind`, not by `spinner`) is the whole signal.
 * @param {ReadonlyArray<unknown>} members - The group's tool-action items.
 * @param {import('./thread-display.js').ThreadLiveStatus|null} [live] - Live LLM status snapshot.
 * @returns {import('./thread-display.js').ThreadStatus} Classification + display fields.
 */
export function getGroupStatus(members, live) {
  // Rows the document no longer holds say nothing about this group: a deleted
  // member reports no `state` either, which would read as "not completed", i.e.
  // as live work, leaving the tile claiming to be running forever.
  const present = presentRows(members);
  const goal = summarizeGroup(present);

  if (hasPendingApprovalInTree(present)) {
    const waiting = present.filter((m) => {
      const state = field(m, 'state');
      return state === TOOL_STATES.PENDING || state === 'awaiting_approval';
    }).length;
    const message = waiting > 1 ? `${waiting} waiting for approval` : 'Waiting for approval';
    return { kind: 'paused', goal, message, spinner: false };
  }

  // "Live" is a positive test, never "not finished". A row counts as live when
  // it has actually been claimed for execution (approved/running), or — while
  // this conversation is genuinely driving a turn — when it is anything but
  // settled, which covers the beat between a row appearing and its approval
  // being evaluated. Asking the question the other way round ("is it something
  // other than completed/cancelled") makes every unknown or missing state read
  // as running, so an idle conversation shows a spinner nothing will clear.
  //
  // Conversation-wide is the right scope for that second guard even though
  // several threads may be running: it only widens the window in which THESE
  // rows — already required to be unsettled — count as live.
  const claimed = present.some((m) => {
    const state = field(m, 'state');
    return state === TOOL_STATES.APPROVED || state === TOOL_STATES.RUNNING;
  });
  if (claimed || (anyThreadLive(live) && hasUnsettledToolInTree(present))) {
    return { kind: 'running', goal, message: '', spinner: false };
  }

  const failed = present.filter((m) => resultField(m, 'isError')).length;
  if (failed > 0) {
    const message = failed === present.length
      ? (failed === 1 ? 'Failed' : `${failed} failed`)
      : `${failed} of ${present.length} failed`;
    return { kind: 'errored', goal, message, spinner: false };
  }

  // Nothing to report: the run is done and none of it failed. The tile's badge
  // already counts the rows, so a status line here would only say it again — an
  // empty message drops the line entirely, leaving just the composition summary.
  return { kind: 'idle', goal, message: '', spinner: false };
}
