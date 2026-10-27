//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for the transaction panel's tool list — the record of which tools
 * a round-trip actually offered the model.
 *
 * This is the surface that answers "was my MCP server's tool even in the
 * request?", which is otherwise unanswerable: a tool absent from this list never
 * reached the model, whatever the model then said about it. The list is built
 * from the persisted blob, so it is ground truth rather than a reconstruction —
 * these tests pin the grouping (built-ins together, one group per MCP server),
 * the ordering (servers alphabetical, expensive schemas first within a group),
 * and that every tool in the blob reaches the DOM.
 * @module unit-tests/transaction-tool-list-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import { renderTransactionDetail } from '../../js/components/transaction-detail-renderer.js';
import { setLocale, formatDate, isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import { parseMcpToolName, groupToolsByOrigin } from '../../js/services/thread-tool-inventory.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * One tool definition in the shape the worker records (worker/messages.go
 * ToolDefinition): name, description, input_schema, optional category.
 * @param {string} name - LLM-facing tool name
 * @param {number} [schemaProps] - How many properties to give the schema, to vary its token cost
 * @param {string} [category] - 'read' | 'write' | 'meta'
 * @returns {Record<string, unknown>} Tool entry
 */
function tool(name, schemaProps = 1, category = 'read') {
  /** @type {Record<string, unknown>} */
  const properties = {};
  for (let i = 0; i < schemaProps; i++) {
    properties[`field_${i}`] = { type: 'string', description: 'x'.repeat(40) };
  }
  return {
    name,
    description: `Description of ${name}.\nSecond line that must not reach the label.`,
    input_schema: { type: 'object', properties },
    category,
  };
}

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label
   * @param {() => (void | Promise<void>)} fn - Test body
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // =========================================================================
  // Name parsing — the grouping keys off this, so a mis-parse silently files
  // an MCP tool under the built-ins.
  // =========================================================================
  await run('parseMcpToolName splits server from tool', () => {
    const parts = parseMcpToolName('mcp__linear__create_issue');
    assert(parts?.server === 'linear', `server was ${JSON.stringify(parts?.server)}`);
    assert(parts?.tool === 'create_issue', `tool was ${JSON.stringify(parts?.tool)}`);
  });

  await run('parseMcpToolName keeps underscores inside a tool name', () => {
    const parts = parseMcpToolName('mcp__linear__list__issues');
    assert(parts?.server === 'linear', `server was ${JSON.stringify(parts?.server)}`);
    assert(parts?.tool === 'list__issues', `tool was ${JSON.stringify(parts?.tool)}`);
  });

  await run('parseMcpToolName rejects anything that is not an MCP tool', () => {
    for (const name of ['bash', 'mcp__', 'mcp__server__', 'mcp__server', 'read_file', '']) {
      assert(parseMcpToolName(name) === null, `expected null for ${JSON.stringify(name)}`);
    }
  });

  // =========================================================================
  // Grouping and ordering.
  // =========================================================================
  await run('built-ins group first, then MCP servers alphabetically', () => {
    const groups = groupToolsByOrigin([
      tool('mcp__zulip__send'),
      tool('bash'),
      tool('mcp__linear__create_issue'),
      tool('read'),
    ]);
    const titles = groups.map((g) => g.title);
    assert(
      JSON.stringify(titles) === JSON.stringify(['Juggler tools', 'MCP · linear', 'MCP · zulip']),
      `groups were ${JSON.stringify(titles)}`
    );
  });

  await run('a request with no built-in tools still groups its servers', () => {
    const groups = groupToolsByOrigin([tool('mcp__linear__create_issue')]);
    assert(groups.length === 1, `expected one group, got ${groups.length}`);
    assert(groups[0].title === 'MCP · linear', `title was ${groups[0].title}`);
    assert(groups[0].server === 'linear', `server was ${JSON.stringify(groups[0].server)}`);
  });

  await run('the most expensive schema sorts first within its group', () => {
    const groups = groupToolsByOrigin([
      tool('mcp__linear__small', 1),
      tool('mcp__linear__huge', 12),
      tool('mcp__linear__medium', 5),
    ]);
    const names = groups[0].tools.map((t) => t.name);
    assert(
      JSON.stringify(names) === JSON.stringify(['mcp__linear__huge', 'mcp__linear__medium', 'mcp__linear__small']),
      `order was ${JSON.stringify(names)}`
    );
  });

  await run('a group reports the total cost of its tools', () => {
    const groups = groupToolsByOrigin([tool('mcp__linear__a', 3), tool('mcp__linear__b', 3)]);
    const [g] = groups;
    assert(g.tokens > 0, 'group token total should be positive');
    const summed = g.tools.length;
    assert(summed === 2, `expected 2 tools in the group, got ${summed}`);
  });

  await run('grouping an empty tool list yields no groups', () => {
    assert(groupToolsByOrigin([]).length === 0, 'expected no groups for no tools');
  });

  // =========================================================================
  // Rendering — every tool must reach the DOM, because the whole point is that
  // a missing tool is visibly missing.
  // =========================================================================
  await run('every tool in the blob is rendered, under its server heading', () => {
    const tools = [
      tool('bash', 2, 'write'),
      tool('read', 2, 'read'),
      tool('mcp__linear__create_issue', 6, 'write'),
      tool('mcp__linear__list_issues', 3, 'read'),
    ];
    const host = document.createElement('div');
    renderTransactionDetail(host, {
      id: 'txn_1',
      input: { systemPrompt: 'You are a test.', messages: [], tools },
    });

    const toolsRow = /** @type {HTMLDetailsElement|null} */ (host.querySelector('.tx-row'));
    assert(toolsRow, 'no input rows rendered');

    // Rows build their body on first open, matching how a long history stays
    // cheap until asked for.
    const rows = [...host.querySelectorAll('.tx-row')];
    const row = rows.find((r) => r.querySelector('.tx-row-kind')?.textContent === 'tools');
    assert(row, `no tools row; kinds were ${JSON.stringify(rows.map((r) => r.querySelector('.tx-row-kind')?.textContent))}`);

    const label = row.querySelector('.tx-row-label')?.textContent || '';
    assert(label === '4 tools · 2 from MCP', `label was ${JSON.stringify(label)}`);

    /** @type {HTMLDetailsElement} */ (row).open = true;
    row.dispatchEvent(new Event('toggle'));

    const headings = [...row.querySelectorAll('.tx-tool-group-title')].map((e) => e.textContent);
    assert(
      JSON.stringify(headings) === JSON.stringify(['Juggler tools', 'MCP · linear']),
      `headings were ${JSON.stringify(headings)}`
    );

    const names = [...row.querySelectorAll('.tx-tool-name')].map((e) => e.getAttribute('title'));
    assert(names.length === 4, `expected 4 tool rows, got ${names.length}: ${JSON.stringify(names)}`);
    for (const t of tools) {
      assert(names.includes(String(t.name)), `${t.name} missing from the rendered list`);
    }
  });

  await run('an MCP tool is shown without its redundant server prefix', () => {
    const host = document.createElement('div');
    renderTransactionDetail(host, {
      id: 'txn_2',
      input: { systemPrompt: '', messages: [], tools: [tool('mcp__linear__create_issue')] },
    });
    const row = [...host.querySelectorAll('.tx-row')]
      .find((r) => r.querySelector('.tx-row-kind')?.textContent === 'tools');
    assert(row, 'no tools row rendered');
    /** @type {HTMLDetailsElement} */ (row).open = true;
    row.dispatchEvent(new Event('toggle'));

    const nameEl = row.querySelector('.tx-tool-name');
    assert(nameEl?.textContent === 'create_issue', `displayed name was ${JSON.stringify(nameEl?.textContent)}`);
    assert(
      nameEl?.getAttribute('title') === 'mcp__linear__create_issue',
      'the full LLM-facing name must stay available in the tooltip'
    );
  });

  await run('a tool description is reduced to its first line', () => {
    const host = document.createElement('div');
    renderTransactionDetail(host, {
      id: 'txn_3',
      input: { systemPrompt: '', messages: [], tools: [tool('bash')] },
    });
    const row = [...host.querySelectorAll('.tx-row')]
      .find((r) => r.querySelector('.tx-row-kind')?.textContent === 'tools');
    assert(row, 'no tools row rendered');
    /** @type {HTMLDetailsElement} */ (row).open = true;
    row.dispatchEvent(new Event('toggle'));

    const desc = row.querySelector('.tx-tool-desc')?.textContent || '';
    assert(desc === 'Description of bash.', `description line was ${JSON.stringify(desc)}`);
  });

  // =========================================================================
  // Saying what the list is. An undated tool list invites the wrong conclusion:
  // a server that connected after this turn is legitimately absent here, and
  // without the header that reads as the tool having gone missing.
  // =========================================================================

  /**
   * Open the tools row of a freshly-rendered blob.
   * @param {HTMLElement} host - Container rendered into
   * @returns {HTMLElement} The opened tools row
   */
  const openToolsRow = (host) => {
    const row = [...host.querySelectorAll('.tx-row')]
      .find((r) => r.querySelector('.tx-row-kind')?.textContent === 'tools');
    assert(row, 'no tools row rendered');
    /** @type {HTMLDetailsElement} */ (row).open = true;
    row.dispatchEvent(new Event('toggle'));
    return /** @type {HTMLElement} */ (row);
  };

  await run('the tool list says when it was sent, and that it is not the live list', () => {
    const host = document.createElement('div');
    const timestamp = new Date(2026, 1, 3, 14, 32, 5).toISOString();
    // The time follows the UI's formatting locale, which otherwise defaults to
    // the machine's; pinned so the assertion can name the exact text. Newer ICU
    // puts a narrow no-break space before "PM", which \s matches.
    const previousLocale = setLocale('en-US');
    let header = '';
    try {
      renderTransactionDetail(host, {
        id: 'txn_5',
        timestamp,
        input: { systemPrompt: '', messages: [], tools: [tool('bash'), tool('mcp__linear__create_issue')] },
      });
      header = openToolsRow(host).querySelector('.tx-tools-sent')?.textContent || '';
    } finally {
      setLocale(previousLocale);
    }
    assert(header.startsWith('2 tools, as sent at '), `header was ${JSON.stringify(header)}`);
    assert(
      /as sent at 2:32:05\sPM /u.test(header),
      `header should carry the send time, was ${JSON.stringify(header)}`
    );
    assert(header.endsWith('— not the live list.'), `header was ${JSON.stringify(header)}`);
  });

  await run('a single tool is counted in the singular, and a missing timestamp drops the clause', () => {
    const host = document.createElement('div');
    renderTransactionDetail(host, {
      id: 'txn_6',
      input: { systemPrompt: '', messages: [], tools: [tool('bash')] },
    });
    const header = openToolsRow(host).querySelector('.tx-tools-sent')?.textContent || '';
    assert(header === '1 tool, as sent — not the live list.', `header was ${JSON.stringify(header)}`);
  });

  await run('a garbled timestamp drops the clause instead of failing the render', () => {
    const host = document.createElement('div');
    renderTransactionDetail(host, {
      id: 'txn_7',
      timestamp: 'not a date',
      input: { systemPrompt: '', messages: [], tools: [tool('bash')] },
    });
    const header = openToolsRow(host).querySelector('.tx-tools-sent')?.textContent || '';
    assert(header === '1 tool, as sent — not the live list.', `header was ${JSON.stringify(header)}`);
    assert(!host.textContent?.includes('Time:'), 'the metadata bar leaves the time out');
  });

  // The drift line: the same statement the System Prompt panel makes, from the
  // other end. `offered` is a strategy's own output, so a thread whose strategy
  // returns a fixed list gives a deterministic live list to compare against.
  /**
   * A thread whose live tool list is exactly `tools`. `asked` counts the times
   * the live list was read, which is the comparison's last asynchronous step.
   * @param {Array<Record<string, unknown>>} tools - The tools this thread offers
   * @returns {{asked: number, strategy: object}} A stand-in message thread
   */
  const threadOffering = (tools) => {
    const thread = {
      asked: 0,
      strategy: {
        /**
         * @returns {Array<Record<string, unknown>>} The fixed live list
         */
        filterTools() { thread.asked++; return tools; },
      },
    };
    return thread;
  };

  /**
   * Wait for the drift annotation, which lands a few microtasks after render.
   * Rides `waitFor`'s patience, and throws, saying why it gave up, if the line
   * never appears.
   * @param {HTMLElement} row - The opened tools row
   * @returns {Promise<string>} The drift line's text
   */
  const driftText = async (row) => {
    await waitFor(() => !!row.querySelector('.tx-tools-drift'), { description: 'the tool list\'s drift line' });
    return row.querySelector('.tx-tools-drift')?.textContent || '';
  };

  await run('a tool that appeared since the turn is reported, not silently missing', async () => {
    const host = document.createElement('div');
    renderTransactionDetail(
      host,
      { id: 'txn_7', input: { systemPrompt: '', messages: [], tools: [tool('bash')] } },
      undefined,
      { messageThread: threadOffering([tool('bash'), tool('mcp__linear__create_issue')]) }
    );
    const row = openToolsRow(host);
    const text = await driftText(row);
    assert(text.startsWith('1 added since this turn'), `drift line was ${JSON.stringify(text)}`);
    assert(
      text.includes('the model has not been offered the current list yet'),
      `drift line was ${JSON.stringify(text)}`
    );
    const title = row.querySelector('.tx-tools-drift')?.getAttribute('title') || '';
    assert(title.includes('mcp__linear__create_issue'), `the tooltip should name the tool, was ${JSON.stringify(title)}`);
  });

  await run('a live list matching the recorded one says nothing at all', async () => {
    const host = document.createElement('div');
    const thread = threadOffering([tool('bash')]);
    renderTransactionDetail(
      host,
      { id: 'txn_8', input: { systemPrompt: '', messages: [], tools: [tool('bash')] } },
      undefined,
      { messageThread: thread }
    );
    const row = openToolsRow(host);
    // Once the live list has been read, a drift line is a microtask away at most.
    await waitFor(() => thread.asked > 0, 'the live tool list to be compared');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(!row.querySelector('.tx-tools-drift'), 'no drift means no line');
  });

  await run('without a thread the list still renders, minus the comparison', async () => {
    const host = document.createElement('div');
    renderTransactionDetail(host, {
      id: 'txn_9',
      input: { systemPrompt: '', messages: [], tools: [tool('bash')] },
    });
    // The header is drawn with the row, and only a thread starts the comparison
    // that could add a drift line later, so both hold as soon as it renders.
    const row = openToolsRow(host);
    assert(row.querySelector('.tx-tools-sent'), 'the header must not depend on having a thread');
    assert(!row.querySelector('.tx-tools-drift'), 'nothing to compare against means no drift line');
  });

  await run('a blob with no tools renders no tools row', () => {
    const host = document.createElement('div');
    renderTransactionDetail(host, {
      id: 'txn_4',
      input: { systemPrompt: 'prompt', messages: [], tools: [] },
    });
    const kinds = [...host.querySelectorAll('.tx-row-kind')].map((e) => e.textContent);
    assert(!kinds.includes('tools'), `expected no tools row, kinds were ${JSON.stringify(kinds)}`);
  });

  // =========================================================================
  // en-XA: every label, heading, empty state, count and tooltip the panel
  // draws is translated; the request/response bodies, tool names and tool
  // descriptions are the model's data and are shown as they are.
  // =========================================================================
  await run('en-XA: the transaction detail is translated in every state, the model data is not', async () => {
    /** @type {string[]} */
    const problems = [];
    // Model data and lone figures: bodies, tool names and descriptions, labels
    // previewing a message, and the bare `~123` size figures.
    const skip = [
      '.tx-out-block', '.tx-row-body .properties-panel-json-display', '.tx-row-body .tx-text',
      '.tx-field-key', '.tx-row-label', '.tx-row-size', '.tx-tool-group-count', '.tx-tool-name',
      '.tx-tool-desc', '.properties-panel-result.error',
    ].join(', ');
    /**
     * @param {string} where - The state, for the failure message
     * @param {string[]} shown - Strings the state drew
     * @param {string} [time] - A formatted time in them (Intl data), mapped to a digit
     */
    const check = (where, shown, time = '') => {
      if (shown.length === 0) problems.push(`${where}: nothing drawn`);
      for (const s of shown) {
        const text = time ? s.split(time).join('1') : s;
        if (!isPseudoLocalized(text)) problems.push(`${where}: ${JSON.stringify(s)}`);
      }
    };
    /**
     * Open a row by position (its kind is translated, so it can't be found by name).
     * @param {HTMLElement} host - Container rendered into
     * @param {number} index - Row position
     * @returns {HTMLElement} The opened row
     */
    const openRow = (host, index) => {
      const row = /** @type {HTMLDetailsElement} */ (host.querySelectorAll('.tx-row')[index]);
      assert(row, `no row ${index}`);
      row.open = true;
      row.dispatchEvent(new Event('toggle'));
      return row;
    };
    const xaTool = (/** @type {string} */ name) => ({ ...tool(name), description: '2' });

    await underPseudoLocale('transaction-tool-list-test', async () => {
      // No blob at all: the default empty message.
      const empty = document.createElement('div');
      renderTransactionDetail(empty, null);
      check('no blob', shownStrings(empty));

      // A full round-trip: metadata, output, every input row kind, the tool
      // list with a built-in and an MCP group, the send time and the drift line.
      const timestamp = new Date(2026, 1, 3, 14, 32, 5).toISOString();
      const time = formatDate(new Date(timestamp), { timeStyle: 'medium' });
      if (!time) problems.push('the fixture time formatted to nothing');
      const full = document.createElement('div');
      renderTransactionDetail(full, {
        id: '1',
        timestamp,
        duration: 1234,
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 10,
        cacheWriteTokens: 0,
        stopReason: '5',
        modelConfig: { model: '6' },
        output: { blocks: [{ type: 'text', content: '7' }, /** @type {any} */ ({})], error: '3' },
        input: {
          systemPrompt: '8',
          messages: [{ content: '9' }],
          tools: [xaTool('1'), xaTool('mcp__7__8')],
        },
      }, undefined, { messageThread: threadOffering([xaTool('1'), xaTool('mcp__7__8'), xaTool('4')]) });
      const row = openRow(full, 1);
      const drift = await driftText(row);
      if (!drift) problems.push('the drift line never appeared');
      for (const entry of full.querySelectorAll('.tx-tool')) {
        /** @type {HTMLDetailsElement} */ (entry).open = true;
        entry.dispatchEvent(new Event('toggle'));
      }
      check('full round-trip', shownStrings(full, skip), time);
      const kinds = [...full.querySelectorAll('.tx-row-kind')].map((e) => e.textContent || '');
      if (kinds.length !== 3) problems.push(`expected three row kinds, got ${JSON.stringify(kinds)}`);
      if (full.querySelectorAll('.tx-tool-category').length !== 2) problems.push('expected two category lozenges');
      if (full.querySelectorAll('.tx-tool-group').length !== 2) problems.push('expected two tool groups');
      // The skipped figures' own tooltips, and the fallback kind of a typeless block.
      check('figure tooltips', [...full.querySelectorAll('.tx-row-size, .tx-tool-group-count')]
        .map((e) => e.getAttribute('title') || ''));
      const blockKinds = [...full.querySelectorAll('.tx-out-kind')].map((e) => e.textContent || '');
      check('typeless block kind', blockKinds.slice(1));
      if (blockKinds[0] !== 'text') problems.push(`a block's type is shown as it is, got ${JSON.stringify(blockKinds[0])}`);
      if (full.querySelector('.tx-tool-name')?.textContent !== '1') problems.push('the tool name changed');
      const meta = [...full.querySelectorAll('.meta-item')].map((e) => e.textContent || '');
      if (meta.length !== 6) problems.push(`expected six metadata fields, got ${JSON.stringify(meta)}`);

      // Cancelled with nothing back, approximate tokens, no cache report, no
      // input. The third field is `Stop: cancelled` — a provider identifier.
      const cancelled = document.createElement('div');
      renderTransactionDetail(cancelled, { id: '2', inputTokens: 100, inputTokensApproximate: true, stopReason: 'cancelled' });
      check('cancelled', shownStrings(cancelled, '.meta-item:nth-child(3)'));

      // Nothing returned; one built-in tool, no send time, no drift.
      const nothing = document.createElement('div');
      renderTransactionDetail(nothing, { id: '3', input: { systemPrompt: '', messages: [], tools: [xaTool('1')] } });
      openRow(nothing, 0);
      check('nothing returned', shownStrings(nothing, skip));
    });
    assert(problems.length === 0, problems.join('; '));
  });

  return { passed, failed, errors };
}
