//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tool-run grouping — folding a run of adjacent tool rows into one tile.
 *
 * The feature is display-only, so the assertions are about the display
 * transform and the things that read it, never about the document:
 *   1. Which runs fold (and which items break a run) — derived from item type
 *      alone, except for the types that declare `static isGroupable()` false.
 *   2. The tile's composition summary and its aggregate status.
 *   3. The column chain: a group id resolves to a column listing that run,
 *      still bound to the same thread, and a selection inside it resolves on.
 *   4. The presentational guarantee: folding and unfolding leaves the Yjs
 *      document byte-identical.
 *   5. The group column's footer: a status strip scoped to the run, with none
 *      of the thread-level controls or the thread's token meter.
 *
 * Pure-module level throughout (plus detached elements), so the suite needs no
 * session, worker or network. It IS marked needsExclusiveRun, for a different
 * reason than the focus suites: the preference is one localStorage key on an
 * origin every lane shares, so writing it while a sibling renders could fold
 * that sibling's rows out from under its assertions.
 * @module unit-tests/tool-grouping-test
 */

import { assert, initializeRegistries } from '../utilities/test-helpers.js';
import {
  buildDisplayItems,
  findGroup,
  isGroupEntry,
  isGroupId,
  summarizeGroup,
  getGroupStatus,
  countGroupRows,
  groupMemberIndices,
} from '../../js/utils/item-grouping.js';
import contextItemRegistry from '../../js/registries/context-item-registry.js';
import { setUserPref, setWindowPref } from '../../js/services/prefs.js';
import { ColumnSelectionState } from '../../js/utils/column-selection.js';
import { positionElements, buildElementMap } from '../../js/components/conversation-area-rendering.js';
import {
  isToolGroupingEnabled,
  setToolGroupingEnabled,
  toggleToolGrouping,
} from '../../js/utils/tool-grouping-pref.js';
import { groupBadgeBackground } from '../../js/components/tool-group-message.js';
import '../../js/components/conversation-footer.js';

/**
 * @param {unknown} e
 * @returns {string} the message to surface for an assertion failure
 */
function msg(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} the aggregate test result
 */
export async function runTests() {
  const Y = await import('../../js/vendor/yjs.mjs');
  // Groupability is a property of the owning plugin, so the opt-outs below are
  // asserted against the real registered classes rather than a stub policy.
  await initializeRegistries();
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  let seq = 0;
  /**
   * @param {Record<string, any>} fields - Item fields to set.
   * @returns {any} A Y.Map shaped like a conversation item.
   */
  const item = (fields) => {
    const m = new Y.Map();
    m.set('itemId', fields.itemId || `it_${++seq}`);
    for (const [k, v] of Object.entries(fields)) {
      if (k !== 'itemId') m.set(k, v);
    }
    return m;
  };
  /**
   * @param {string} toolName - Tool name to stamp on the row.
   * @param {Record<string, any>} [extra] - Extra fields (state, result, itemId).
   * @returns {any} A Y.Map shaped like a tool-action item.
   */
  const tool = (toolName, extra = {}) =>
    item({ type: 'tool-action', toolName, toolUseId: `tu_${++seq}`, state: 'completed', ...extra });
  /**
   * @param {any[]} items - Items to place in a fresh doc-integrated array.
   * @returns {{doc: any, items: any[]}} The doc and its integrated items.
   */
  const build = (items) => {
    const doc = new Y.Doc();
    const arr = doc.getArray('items');
    doc.transact(() => { arr.insert(0, items); });
    return { doc, items: arr.toArray() };
  };
  /**
   * @param {any[]} items - Items to fold.
   * @returns {any[]} Display entries with grouping enabled.
   */
  const fold = (items) => buildDisplayItems(items, { enabled: true }).entries;

  // --- 1: a run of tool rows folds; a lone one doesn't ---
  try {
    const { items } = build([
      item({ type: 'user', content: 'go' }),
      tool('read'), tool('read'), tool('bash'),
      item({ type: 'assistant', content: 'done' }),
      tool('read'),
    ]);
    const entries = fold(items);
    assert(entries.length === 4,
      `user + group + assistant + lone tool = 4 entries, got ${entries.length}`);
    assert(isGroupEntry(entries[1]), 'the run of three tool rows folds into a group');
    assert(entries[1].members.length === 3, 'the group holds all three rows');
    assert(isGroupEntry(entries[3]) === false, 'a single tool row is left alone');

    const flat = buildDisplayItems(items, { enabled: false }).entries;
    assert(flat.length === 6 && flat.every((e) => !isGroupEntry(e)),
      'with the preference off nothing folds');
    passed++;
  } catch (e) { failed++; errors.push(`fold basics: ${msg(e)}`); }

  // --- 2: the group id is stable as the run grows ---
  try {
    const first = tool('read', { itemId: 'tu_first' });
    const { items } = build([first, tool('read'), tool('read')]);
    const before = fold(items)[0].get('itemId');
    const { items: grown } = build([item({ type: 'tool-action', toolName: 'read', itemId: 'tu_first', toolUseId: 'x', state: 'completed' }), tool('read'), tool('read'), tool('bash')]);
    const after = fold(grown)[0].get('itemId');
    assert(before === after, `group id must be derived from the first row (${before} vs ${after})`);
    assert(isGroupId(before) && !isGroupId('tu_first'), 'group ids are distinguishable from item ids');
    passed++;
  } catch (e) { failed++; errors.push(`stable id: ${msg(e)}`); }

  // --- 3: what breaks a run, and what doesn't ---
  try {
    // Messages, sub-threads and errors are real rows: they split the run.
    for (const barrier of [
      { type: 'user', content: 'hi' },
      { type: 'assistant', content: 'text' },
      { type: 'error', message: 'boom' },
      { type: 'thread', goal: 'sub' },
      // A standing context item's `type` IS its context-item id — never a tool row.
      { type: 'file-content', data: {} },
    ]) {
      const { items } = build([tool('read'), tool('read'), item(barrier), tool('read'), tool('read')]);
      const entries = fold(items);
      assert(entries.length === 3 && isGroupEntry(entries[0]) && isGroupEntry(entries[2]),
        `a '${barrier.type}' item must split the run (got ${entries.length} entries)`);
      assert(!isGroupEntry(entries[1]), `the '${barrier.type}' item itself is never folded`);
    }

    // Rows that paint nothing are transparent: the run reads as adjacent
    // on screen, so it must fold as one.
    for (const invisible of [
      { type: 'assistant', content: '   ' },
      { type: 'tool-action', toolName: 'memory', state: 'completed', result: { resultType: 'context' } },
      // Provider continuation state is durable but has no transcript row. It can
      // occur between tools, so treating it as a barrier leaves visibly adjacent
      // tools stranded outside the group.
      { type: 'provider-state', provider: 'test', state: {} },
      // A Continue's marker is a run record, not a message: it paints nothing,
      // so unlike the user message above it must not wedge a run in half.
      { type: 'user', continuation: true },
    ]) {
      const { items } = build([tool('read'), tool('read'), item(invisible), tool('read')]);
      const entries = fold(items);
      const groups = entries.filter(isGroupEntry);
      assert(groups.length === 1 && groups[0].members.length === 3,
        `an invisible '${invisible.type}' row must not split the run`);
    }

    // Hidden provider state on both sides of an existing fold must not strand
    // tools as apparently adjacent individual rows around the group.
    const { items: providerSplit } = build([
      tool('read'), item({ type: 'provider-state', provider: 'test', state: {} }),
      tool('replace'), tool('bash'),
      item({ type: 'provider-state', provider: 'test', state: {} }), tool('read'),
    ]);
    const providerSplitEntries = fold(providerSplit);
    const providerSplitGroups = providerSplitEntries.filter(isGroupEntry);
    assert(providerSplitGroups.length === 1 && providerSplitGroups[0].members.length === 4,
      'provider state around a fold leaves all four visible tool rows in one group');
    passed++;
  } catch (e) { failed++; errors.push(`run boundaries: ${msg(e)}`); }

  // --- 3b: a type that declares itself ungroupable is never folded away ---
  try {
    // These rows are ordinary tool-actions, so type alone would fold them. The
    // plan and the todo list have no standing card — the row IS the item, and a
    // plan or checklist hidden behind a "+N more" tile is one the user cannot
    // follow. The others are records the user must be able to find: what they
    // were asked and answered, and artifacts created outside this transcript.
    for (const toolName of ['plan', 'todo', 'AskUserQuestion', 'define_command', 'new_conversation']) {
      const ActionClass = /** @type {any} */ (contextItemRegistry.getByToolName(toolName));
      assert(!!ActionClass, `precondition: a plugin is registered for '${toolName}'`);
      assert(ActionClass.isGroupable() === false,
        `'${toolName}' must declare itself ungroupable`);

      // Unfolded AND a barrier: it splits the run rather than riding along as a
      // passenger, so no tile ever spans it and its position is preserved.
      const { items } = build([tool('read'), tool('read'), tool(toolName), tool('read'), tool('read')]);
      const entries = fold(items);
      assert(entries.length === 3 && isGroupEntry(entries[0]) && isGroupEntry(entries[2]),
        `a '${toolName}' row must split the run (got ${entries.length} entries)`);
      assert(!isGroupEntry(entries[1]) && entries[1].get('toolName') === toolName,
        `the '${toolName}' row itself is left unfolded, in place`);

      // Not even a run made only of these folds — MIN_RUN must not rescue them.
      const solid = fold(build([tool(toolName), tool(toolName), tool(toolName)]).items);
      assert(solid.length === 3 && !solid.some(isGroupEntry),
        `a run of '${toolName}' rows still doesn't fold (got ${solid.length} entries)`);
    }

    // The default is unchanged: a tool that declares nothing still folds, and so
    // does one no plugin claims at all (an MCP tool, an unknown name).
    const { items } = build([tool('read'), tool('mcp__acme__deploy')]);
    assert(isGroupEntry(fold(items)[0]), 'an unclaimed tool name folds by default');
    passed++;
  } catch (e) { failed++; errors.push(`declared opt-out: ${msg(e)}`); }

  // --- 4: composition summary counts each kind, commonest first, and adds up ---
  try {
    const { items } = build([tool('bash'), tool('read'), tool('read'), tool('read')]);
    const group = fold(items)[0];
    const summary = summarizeGroup(group.members);
    assert(summary.startsWith('3×') && summary.includes(','),
      `summary leads with the commonest kind and lists both: "${summary}"`);
    assert(/3×[^,]+, 1×/.test(summary), `summary counts each kind: "${summary}"`);

    // Capped: only the biggest kinds are named, and the tail counts the ROWS it
    // stands for — so every number on the line sums to the row count the badge
    // shows. ("+N more" counting KINDS is the bug: "30 tools" summarised as
    // "4× …, 2× …, 2× …, +2 more" accounts for 10 of 30 rows.)
    const many = build([
      ...Array.from({ length: 4 }, () => tool('replace')),
      ...Array.from({ length: 3 }, () => tool('read')),
      // All groupable: a row that declares itself ungroupable (`todo`, `plan`)
      // would break this run rather than join it — that is case 3b's business.
      tool('bash'), tool('glob'), tool('grep'), tool('write'), tool('query_code'),
    ]).items;
    const capped = summarizeGroup(fold(many)[0].members);
    const total = [...capped.matchAll(/(\d+)(?:×|\u00A0more)/g)].reduce((n, m) => n + Number(m[1]), 0);
    assert(total === many.length,
      `every number in "${capped}" counts rows, so they sum to ${many.length} (got ${total})`);
    assert(/^4×\u00A0.+, 3×\u00A0.+, 1×\u00A0.+, \+4\u00A0more$/.test(capped),
      `the biggest kinds are named first and the rest are counted as rows: "${capped}"`);

    // The space joining a count to its kind is non-breaking (asserted above), so
    // the pair wraps as one word. Stated here as the negative too, because that
    // is the regression: an ordinary space there lets a line end on a bare "3×"
    // with the kind it counts wrapped onto the next line.
    assert(!/\d+× /.test(capped) && !/\+\d+ more/.test(capped),
      `no count may be separated from its label by a breaking space: "${capped}"`);
    assert(countGroupRows(fold(many)[0].members) === many.length,
      'the badge counts the same rows the summary describes');
    passed++;
  } catch (e) { failed++; errors.push(`summary: ${msg(e)}`); }

  // --- 4b: badge colours describe consequences, and groups summarise them ---
  try {
    const ResearchClass = /** @type {any} */ (contextItemRegistry.getByToolName('Research'));
    const TodoClass = /** @type {any} */ (contextItemRegistry.getByToolName('todo'));
    const SystemClass = /** @type {any} */ (contextItemRegistry.get('system-prompt'));
    assert(ResearchClass.getBadgeOptions().color === 'thread',
      'Research shares the delegation family with other subthreads');
    assert(TodoClass.getBadgeOptions().color === 'plan',
      'Todo shares the organisational family with Plan');
    assert(SystemClass.getBadgeOptions().color === 'meta',
      'the system prompt uses the neutral metadata family');

    const solid = groupBadgeBackground(build([tool('read'), tool('read')]).items);
    assert(solid.includes('--ci-family-badge-read') && !solid.startsWith('linear-gradient'),
      `a homogeneous group keeps its family colour, got "${solid}"`);

    const mixed = build([tool('read'), tool('bash'), tool('read')]);
    const striped = groupBadgeBackground(mixed.items);
    assert(striped.startsWith('linear-gradient(90deg, '),
      `a mixed group gets hard-edged colour bands, got "${striped}"`);
    assert((striped.match(/--ci-family-badge-read/g) || []).length === 2,
      'interleaved reads combine into one contiguous segment');
    assert(striped.includes('66.66666666666666%') && striped.includes('100%'),
      `band widths are proportional to the 2:1 composition, got "${striped}"`);

    mixed.doc.transact(() => { mixed.doc.getArray('items').delete(0, 1); });
    const withoutStale = groupBadgeBackground(mixed.items);
    assert(withoutStale.includes('50%'),
      `deleted rows are excluded from proportions, got "${withoutStale}"`);

    const fallback = groupBadgeBackground(build([tool('unclaimed-tool'), tool('unclaimed-tool')]).items);
    assert(fallback.includes('--ci-preset-badge-slate'),
      `an unsupported badge colour falls back to slate, got "${fallback}"`);
    passed++;
  } catch (e) { failed++; errors.push(`badge composition: ${msg(e)}`); }

  // --- 5: aggregate status — approval wins, then live work, then settled ---
  try {
    const paused = build([tool('read'), tool('bash', { state: 'pending' })]).items;
    assert(getGroupStatus(paused).kind === 'paused',
      'a row awaiting approval parks the whole group');

    const running = build([tool('read'), tool('bash', { state: 'running' })]).items;
    assert(getGroupStatus(running).kind === 'running', 'an unsettled row keeps the group live');
    // The live wording belongs to the conversation, and the footer under the
    // tile is already showing it: the tile says the run is live by pulsing.
    const liveStatus = getGroupStatus(running, { byThread: { '': 'Streaming • 40 tokens' } });
    assert(liveStatus.message === '' && liveStatus.spinner === false,
      `a live group repeats neither the status line nor its spinner, got "${liveStatus.message}"`);

    const settled = build([tool('read'), tool('bash')]).items;
    const status = getGroupStatus(settled);
    // The badge already counts the rows, so a settled run has nothing to add.
    assert(status.kind === 'idle' && status.message === '',
      `a settled group says nothing beyond its composition, got "${status.message}"`);

    const failedRun = build([tool('read', { result: { isError: true } }), tool('bash')]).items;
    assert(getGroupStatus(failedRun).kind === 'errored', 'a failed row surfaces on the tile');
    passed++;
  } catch (e) { failed++; errors.push(`group status: ${msg(e)}`); }

  // --- 5b: a group never invents live work out of an unknown state ---
  try {
    // Rows an undo (or any delete) removed report `undefined` for every field,
    // because Yjs clears a deleted map's entries. Read as "not completed", that
    // is indistinguishable from a running tool — which is how a tile ends up
    // stuck showing a spinner in a conversation where nothing is running.
    const { doc, items } = build([tool('read'), tool('bash')]);
    const stale = fold(items)[0];
    doc.transact(() => { doc.getArray('items').delete(0, 2); });
    assert(stale.members[0].get('state') === undefined,
      'precondition: a deleted row reports no state at all');
    const gone = getGroupStatus(stale.members, null);
    assert(gone.kind === 'idle', `a group of deleted rows is not running, got "${gone.kind}"`);
    assert(getGroupStatus(stale.members, { byThread: { '': 'Streaming' } }).kind === 'idle',
      'nor is it running just because the conversation is busy elsewhere');
    assert(countGroupRows(stale.members) === 0, 'and it counts none of them as rows');

    // An unevaluated row (state never stamped) is live only while the
    // conversation is actually driving a turn — never once it has gone idle.
    const fresh = build([tool('read'), tool('bash', { state: '' })]).items;
    assert(getGroupStatus(fresh, null).kind === 'idle',
      'an idle conversation cannot have a running group');
    assert(getGroupStatus(fresh, { byThread: { '': 'Streaming' } }).kind === 'running',
      'the same row mid-turn is live work');

    // A claimed row is live on its own evidence, idle conversation or not.
    for (const state of ['approved', 'running']) {
      const claimed = build([tool('read'), tool('bash', { state })]).items;
      assert(getGroupStatus(claimed, null).kind === 'running',
        `a ${state} row is live work in its own right`);
    }
    passed++;
  } catch (e) { failed++; errors.push(`stale members: ${msg(e)}`); }

  // --- 6: the tile paints the shared status block (so it inherits its styling) ---
  try {
    const { items } = build([tool('read'), tool('bash', { state: 'pending' })]);
    const group = fold(items)[0];
    const tile = /** @type {any} */ (document.createElement('tool-group-message'));
    tile.updateFromItem(group, null);
    document.body.appendChild(tile);
    try {
      const block = tile.querySelector('.thread-summary.thread-status');
      assert(!!block, 'the tile paints the shared thread-status block');
      assert(block.dataset.kind === 'paused',
        'a group holding an approval is marked paused, so it gets the same highlight as a thread');
      assert(tile.querySelector('.context-item-type-badge')?.textContent === '2 tools',
        'the lozenge counts what is inside');
      const iconBackground = /** @type {HTMLElement} */ (tile.querySelector('.message-icon-box')).style.background;
      const badgeBackground = /** @type {HTMLElement} */ (tile.querySelector('.context-item-type-badge')).style.background;
      assert(iconBackground.startsWith('linear-gradient') && badgeBackground === iconBackground,
        'the icon and lozenge share the group composition stripes');

      // The composition summary is the tile's TITLE, in the same slot and at
      // the same depth as every other item's title — a bare `.message-text`
      // directly inside `.message-content-box`. That is exactly what the shared
      // title-row rule selects, so the summary sits on the icon/lozenge band
      // instead of being styled ad-hoc.
      const title = tile.querySelector('.message-content-box > .message-text');
      assert(!!title, 'the summary is painted into the standard title slot');
      assert(title.textContent === summarizeGroup(group.members),
        `the title carries the composition summary, got "${title.textContent}"`);
      assert(!block.querySelector('.thread-status-goal'),
        'and it is NOT repeated inside the status block');
      assert(tile.getBusyState() === null, 'the tile owns its own status, so the footer stays quiet');
    } finally {
      tile.remove();
    }
    passed++;
  } catch (e) { failed++; errors.push(`tile paint: ${msg(e)}`); }

  // --- 6b: only LIVE work marks the tile busy, and the mark tracks both ways ---
  try {
    const settled = fold(build([tool('read'), tool('bash')]).items)[0];
    const failedRun = fold(build([tool('read', { result: { isError: true } }), tool('bash')]).items)[0];
    const waiting = fold(build([tool('read'), tool('bash', { state: 'pending' })]).items)[0];
    const running = fold(build([tool('read'), tool('bash', { state: 'running' })]).items)[0];

    const tile = /** @type {any} */ (document.createElement('tool-group-message'));
    document.body.appendChild(tile);
    try {
      /** @returns {boolean} whether the tile face is marked as live work. */
      const busy = () => tile.querySelector('article')?.getAttribute('data-processing') === 'true';

      tile.updateFromItem(settled, null);
      assert(!busy(), 'a settled run is finished — nothing to pulse');
      assert(!tile.querySelector('.thread-status-message'),
        'a settled run paints no status line — the badge already counts the rows');
      assert(tile.querySelector('.message-content-box > .message-text')?.textContent,
        'the composition summary is still shown, in the title slot');
      // The regression: a failed row is terminal, but classified 'errored'. It
      // must not leave the tile pulsing forever in an idle conversation.
      tile.updateFromItem(failedRun, null);
      assert(!busy(), 'a run holding a failed row is still finished — it must not pulse');

      // The mirror regression: the mark must appear on a state change that
      // doesn't add a spinner (idle → awaiting approval), and clear again.
      tile.updateFromItem(waiting, null);
      assert(busy(), 'a run parked on an approval is live work');
      assert(tile.querySelector('.thread-status-message > span')?.textContent === 'Waiting for approval',
        'the status line comes back when there is something to say');
      tile.updateFromItem(running, null);
      assert(busy(), 'a run with a running row is live work');
      assert(!tile.querySelector('.thread-status-message'),
        'a live run paints no status line either — the footer beneath it already has one');
      tile.updateFromItem(settled, null);
      assert(!busy(), 'the mark clears once the run settles');

      // The icon box survives every one of those updates, so its pulse runs
      // uninterrupted rather than restarting from frame zero on each tick.
      const icon = tile.querySelector('.message-icon-box');
      tile.updateFromItem(running, null);
      assert(tile.querySelector('.message-icon-box') === icon,
        'the icon box is never rebuilt, so the pulse animation is never restarted');

      const grown = fold(build([tool('read'), tool('bash'), tool('read')]).items)[0];
      tile.updateFromItem(grown, null);
      assert(tile.querySelector('.context-item-type-badge')?.textContent === '3 tools',
        'the lozenge follows the run as it grows');
    } finally {
      tile.remove();
    }
    passed++;
  } catch (e) { failed++; errors.push(`tile busy mark: ${msg(e)}`); }

  // --- 7: the column chain opens a group, then resolves on into it ---
  try {
    const { doc, items } = build([item({ type: 'user', content: 'go' }), tool('read'), tool('bash')]);
    const container = doc.getMap('root');
    const rootThread = { container, items };
    const groupId = fold(items)[1].get('itemId');
    const memberId = items[2].get('itemId');

    const state = new ColumnSelectionState();
    state.selections = [groupId, memberId];
    const chain = state.resolveColumnChain(rootThread, (/** @type {any} */ it) => it.get('type') === 'thread',
      { groupingEnabled: true });

    assert(chain.length === 3, `root + group + properties = 3 columns, got ${chain.length}`);
    assert(chain[1].type === 'conversation' && chain[1].groupId === groupId,
      'selecting a group opens a conversation column for the run');
    assert(chain[1].groupItems?.length === 2, 'that column lists the folded rows');
    assert(chain[1].container === container,
      'the group column stays bound to the same thread — its rows never moved');
    assert(chain[2].type === 'properties' && chain[2].selectedItemId === memberId,
      'selecting a row inside the group opens its properties panel, as in the parent');

    // With grouping off the same selection resolves to nothing beyond the root.
    const off = state.resolveColumnChain(rootThread, () => false, { groupingEnabled: false });
    assert(off.length === 1, 'a group id names nothing when grouping is off');
    passed++;
  } catch (e) { failed++; errors.push(`column chain: ${msg(e)}`); }

  // --- 7b: a group resolves to the exact rows a delete has to remove ---
  try {
    const { items } = build([
      item({ type: 'user', content: 'go' }),
      tool('read'), tool('bash'), tool('read'),
      item({ type: 'assistant', content: 'done' }),
      tool('read'), tool('read'),
    ]);
    const groupId = fold(items)[1].get('itemId');
    assert(groupMemberIndices(items, groupId).join(',') === '1,2,3',
      `deleting a group means deleting its own rows and nothing else, got [${groupMemberIndices(items, groupId)}]`);
    assert(groupMemberIndices(items, 'group:gone').length === 0,
      'a run that no longer exists resolves to no rows, so a stale delete removes nothing');
    passed++;
  } catch (e) { failed++; errors.push(`group member indices: ${msg(e)}`); }

  // --- 8: presentational only — the document is untouched by folding ---
  try {
    const { doc, items } = build([item({ type: 'user', content: 'go' }), tool('read'), tool('bash'), tool('read')]);
    const before = Y.encodeStateAsUpdate(doc);
    buildDisplayItems(items, { enabled: true });
    buildDisplayItems(items, { enabled: false });
    findGroup(items, fold(items)[1].get('itemId'));
    getGroupStatus(fold(items)[1].members);
    const after = Y.encodeStateAsUpdate(doc);
    assert(before.length === after.length && before.every((/** @type {number} */ b, /** @type {number} */ i) => b === after[i]),
      'folding, unfolding and reading a group must not touch the document');
    passed++;
  } catch (e) { failed++; errors.push(`document untouched: ${msg(e)}`); }

  // --- 9: the render seam — folded entries paint one tile, not N rows ---
  try {
    const { items } = build([item({ type: 'user', content: 'go' }), tool('read'), tool('bash'), tool('read')]);
    /** @type {any} */
    const area = { _snapshotLiveStatus: () => null };

    /**
     * @param {any[]} entries - Display entries to paint.
     * @returns {HTMLElement} A detached list containing the painted rows.
     */
    const paint = (entries) => {
      const list = document.createElement('div');
      const footer = document.createElement('conversation-footer');
      list.appendChild(footer);
      positionElements(area, list, footer, entries, buildElementMap(list));
      return list;
    };

    const folded = paint(fold(items));
    const tiles = folded.querySelectorAll('tool-group-message');
    assert(tiles.length === 1, `one group tile, got ${tiles.length}`);
    assert(folded.querySelectorAll('tool-action-message').length === 0,
      'the folded rows are not also painted individually');
    assert(isGroupId(tiles[0]?.getAttribute('message-id') || ''),
      'the tile carries the group id, so selection and the DOM diff agree');
    assert(folded.querySelectorAll('user-message').length === 1,
      'items outside the run are painted as usual');

    const flat = paint(buildDisplayItems(items, { enabled: false }).entries);
    assert(flat.querySelectorAll('tool-group-message').length === 0
      && flat.querySelectorAll('tool-action-message').length === 3,
    'with grouping off the same items paint as three tool rows');
    passed++;
  } catch (e) { failed++; errors.push(`render seam: ${msg(e)}`); }

  // --- 10: the preference round-trips and defaults to off ---
  try {
    const original = isToolGroupingEnabled();
    try {
      setToolGroupingEnabled(false);
      assert(isToolGroupingEnabled() === false, 'the preference reads back what was written');
      assert(toggleToolGrouping() === true && isToolGroupingEnabled() === true, 'toggle flips it on');
      assert(toggleToolGrouping() === false && isToolGroupingEnabled() === false, 'toggle flips it back');
      void setWindowPref('juggler-tool-grouping', null);
      assert(isToolGroupingEnabled() === false, 'unset means off — the flat transcript is the default');
    } finally {
      await setToolGroupingEnabled(original);
    }
    passed++;
  } catch (e) { failed++; errors.push(`preference: ${msg(e)}`); }

  // --- 10b: the preference is this window's, not the person's ---
  // A choice made in another window, project or remote client arrives as a
  // settings.json change; it must not flip the transcript drawn here.
  try {
    const original = isToolGroupingEnabled();
    try {
      setToolGroupingEnabled(false);
      await setUserPref('juggler-tool-grouping', true);
      assert(isToolGroupingEnabled() === false,
        'a user-wide value does not override this window\'s choice');
    } finally {
      await setUserPref('juggler-tool-grouping', null);
      await setToolGroupingEnabled(original);
    }
    passed++;
  } catch (e) { failed++; errors.push(`preference realm: ${msg(e)}`); }

  // --- 11: the group column's footer is a status strip, not a thread footer ---
  try {
    const footer = /** @type {any} */ (document.createElement('conversation-footer'));
    document.body.appendChild(footer);
    try {
      footer.setStatusOnly(true);
      // Every thread-level field is set, to prove the mode ignores them all.
      footer.update({
        isProcessing: true,
        canContinue: true,
        statusMessage: 'Running…',
        showSpinner: true,
        nextSteps: 'next: ship it',
        showDuplicateTab: true,
        busyItemMessageId: 'it_1',
      });

      /**
       * @param {string} selector - Selector for a part of the footer.
       * @returns {boolean} True when that part is hidden.
       */
      const hidden = (selector) => !!footer.querySelector(selector)?.classList.contains('hidden');

      assert(!footer.classList.contains('hidden'), 'a live run shows its status strip');
      assert(!hidden('footer-processing'), 'the status line is what survives in a group column');
      assert(footer.querySelector('.llm-busy-text')?.textContent === 'Running…',
        'the strip carries the status its column computed for the run');
      assert(hidden('footer-idle'),
        'no thread controls: Continue, Duplicate and Add Context Item all act on the parent thread');
      assert(hidden('token-display'),
        'no token meter: it counts the whole thread, not the run of tool rows on screen');
      assert(hidden('.footer-pause-btn') && hidden('.footer-stop-btn'),
        'Pause and Stop drive the thread, so they stay on the thread column');
      assert(hidden('.llm-next-steps'), 'the plan belongs to the thread, not to a run of its tool calls');
      assert(!footer.querySelector('footer-processing')?.dataset.messageId,
        'no click-to-select — the busy row is already on screen in this column');

      footer.update({ isProcessing: false, canContinue: true });
      assert(footer.classList.contains('hidden'),
        'a settled run leaves no footer at all, so the column ends at its last row');

      footer.setStatusOnly(false);
      assert(!footer.classList.contains('hidden') && !hidden('token-display'),
        'a column reused as a thread column gets its full footer back');
    } finally {
      footer.remove();
    }
    passed++;
  } catch (e) { failed++; errors.push(`status-only footer: ${msg(e)}`); }

  return { passed, failed, errors };
}
