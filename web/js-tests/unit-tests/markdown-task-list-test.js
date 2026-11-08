//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Markdown task-list test.
 *
 * GFM spells two task states; the renderer draws five. `[ ]` and `[x]` reach
 * the decorator as the `<input>` marked built for them, while `[/]`, `[!]` and
 * `[-]` reach it as the literal text marked declined to claim — two entirely
 * different shapes that must come out identical. These cases pin that, the
 * states themselves, and the two places the markers are written.
 * @module unit-tests/markdown-task-list-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const { renderMarkdown } = await import('../../sdk/lib/markdown.js');
  const { renderPlanMarkdown, renderTodoMarkdown, createPlanBlock, createTodoBlock } = await import(
    '../../extensions/juggler-core/lib/task-lists.js'
  );

  /**
   * @param {string} label - Case name
   * @param {() => void} fn - Case body
   */
  const run = (label, fn) => {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * Render markdown and hand back a real element to query.
   * @param {string} md - Markdown source
   * @returns {HTMLElement} Container holding the rendered output
   */
  const render = (md) => {
    const div = document.createElement('div');
    div.innerHTML = renderMarkdown(md);
    return div;
  };

  // --- the five states ------------------------------------------------------

  /** @type {Array<[string, string]>} Marker → expected state class */
  const states = [
    [' ', 'pending'],
    ['/', 'in-progress'],
    ['x', 'completed'],
    ['!', 'failed'],
    ['-', 'skipped'],
  ];

  for (const [marker, state] of states) {
    run(`[${marker}] renders a ${state} box`, () => {
      const el = render(`- [${marker}] step text`);
      const box = el.querySelector('.task-box');
      assert(box, `no .task-box for [${marker}]: ${el.innerHTML}`);
      assert(
        box.classList.contains(`task-box--${state}`),
        `[${marker}] should be ${state}, got "${box.className}"`
      );
      assert(
        box.querySelector('.task-box-mark'),
        `[${marker}] box has no mark element: ${el.innerHTML}`
      );
      // The marker itself must be consumed, not left sitting in the text.
      assert(
        !(el.textContent || '').includes(`[${marker}]`),
        `[${marker}] marker leaked into the text: ${el.textContent}`
      );
      assert(
        (el.textContent || '').includes('step text'),
        `[${marker}] lost its text: ${el.textContent}`
      );
    });
  }

  run('[X] is accepted as completed', () => {
    const box = render('- [X] done').querySelector('.task-box');
    assert(box, 'no box for [X]');
    assert(
      box.classList.contains('task-box--completed'),
      `[X] should be completed, got "${box.className}"`
    );
  });

  run('an unrecognised marker stays literal text', () => {
    const el = render('- [?] not a state');
    assert(!el.querySelector('.task-box'), `[?] should not make a box: ${el.innerHTML}`);
    assert(
      (el.textContent || '').includes('[?]'),
      `[?] should survive as text: ${el.textContent}`
    );
  });

  run('a plain list item is left alone', () => {
    const el = render('- ordinary item');
    assert(!el.querySelector('.task-box'), `plain item gained a box: ${el.innerHTML}`);
    assert(
      !el.querySelector('.task-list-item'),
      `plain item gained a task class: ${el.innerHTML}`
    );
  });

  // --- list shapes ----------------------------------------------------------

  run('ordered lists carry boxes too', () => {
    const el = render('1. [/] first\n2. [x] second');
    const boxes = el.querySelectorAll('.task-box');
    assert(boxes.length === 2, `expected 2 boxes in an ordered list, got ${boxes.length}`);
    assert(el.querySelector('ol'), `expected an <ol>: ${el.innerHTML}`);
    assert(
      boxes[0].classList.contains('task-box--in-progress'),
      `first should be in-progress, got "${boxes[0].className}"`
    );
    assert(
      boxes[1].classList.contains('task-box--completed'),
      `second should be completed, got "${boxes[1].className}"`
    );
  });

  run('a loose list puts the box inside the item paragraph', () => {
    // A blank line between items makes marked wrap each item's content in <p>.
    const el = render('- [!] first\n\n- [ ] second');
    const items = el.querySelectorAll('li.task-list-item');
    assert(items.length === 2, `expected 2 task items, got ${items.length}: ${el.innerHTML}`);
    for (const li of items) {
      const box = li.querySelector('.task-box');
      assert(box, `loose item has no box: ${li.innerHTML}`);
      // Wherever it lives, it must be the first thing in the item.
      assert(
        box.parentElement?.firstElementChild === box,
        `box is not first in its block: ${li.innerHTML}`
      );
    }
  });

  run('a mixed list keeps each item on its own state', () => {
    const el = render('- [x] a\n- [/] b\n- [!] c\n- [-] d\n- [ ] e');
    const got = Array.from(el.querySelectorAll('.task-box')).map((b) =>
      (b.className.match(/task-box--(\S+)/) || [])[1]
    );
    const want = ['completed', 'in-progress', 'failed', 'skipped', 'pending'];
    assert(
      got.join(',') === want.join(','),
      `states out of order: got ${got.join(',')} want ${want.join(',')}`
    );
  });

  // --- the box itself -------------------------------------------------------

  run('the box carries an accessible name', () => {
    const box = render('- [/] step').querySelector('.task-box');
    assert(box?.getAttribute('role') === 'img', `expected role=img, got "${box?.getAttribute('role')}"`);
    assert(
      box?.getAttribute('aria-label') === 'In progress',
      `expected aria-label "In progress", got "${box?.getAttribute('aria-label')}"`
    );
  });

  run('no bare checkbox input survives', () => {
    const el = render('- [ ] a\n- [x] b');
    assert(
      !el.querySelector('input'),
      `marked's <input> should have been replaced: ${el.innerHTML}`
    );
  });

  run('the decorator does not reopen the sanitiser', () => {
    // Runs after sanitizeRenderedHtml, so it must not resurrect anything.
    const el = render('- [/] <img src=x onerror=alert(1)> step');
    assert(!el.querySelector('img'), `raw <img> survived: ${el.innerHTML}`);
    assert(el.querySelector('.task-box'), `box missing: ${el.innerHTML}`);
  });

  // --- layout ---------------------------------------------------------------

  /**
   * Lay a task list out for real, at a width narrow enough to force wrapping,
   * and compare where the first line's text starts against where the wrapped
   * lines start.
   *
   * The first line's text begins at the box's right edge plus its gap — reading
   * it off the box rather than off a text node keeps the measurement honest for
   * content whose first line is split by inline markup such as `code`.
   * @param {string} md - Markdown source
   * @returns {{first: number, wrapped: number, lines: number, cleanup: () => void}} Offsets in px
   */
  const measureItem = (md) => {
    const host = document.createElement('div');
    host.className = 'markdown ci-text-block';
    host.style.cssText = 'position:absolute;left:0;top:0;width:15rem;';
    host.innerHTML = renderMarkdown(md);
    document.body.appendChild(host);

    const li = /** @type {HTMLElement} */ (host.querySelector('li.task-list-item'));
    // A nested list's own items are indented on purpose; measuring them would
    // read that deliberate indent as drift. Drop them and keep the item's text.
    li.querySelectorAll('ul, ol').forEach((n) => n.remove());
    const box = /** @type {HTMLElement} */ (li.querySelector('.task-box'));
    const gap = parseFloat(getComputedStyle(box).marginRight) || 0;

    const range = document.createRange();
    range.selectNodeContents(li);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5);

    const round = (/** @type {number} */ n) => Math.round(n * 100) / 100;
    return {
      first: round(box.getBoundingClientRect().right + gap),
      wrapped: round(rects[rects.length - 1].left),
      lines: rects.length,
      cleanup: () => host.remove(),
    };
  };

  /**
   * @param {string} label - Case name
   * @param {string} md - Markdown whose first item must wrap
   */
  const expectAligned = (label, md) => {
    run(label, () => {
      const { first, wrapped, lines, cleanup } = measureItem(md);
      cleanup();
      assert(lines >= 2, `content did not wrap (${lines} line), cannot compare`);
      assert(
        Math.abs(first - wrapped) < 0.5,
        `first line's text starts at ${first}px, wrapped lines at ${wrapped}px `
          + `— drift ${round2(first - wrapped)}px`
      );
    });
  };

  /**
   * @param {number} n - Value to round
   * @returns {number} The value to two decimal places
   */
  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  expectAligned('wrapped lines align (bullet list)', `- [x] ${'word '.repeat(40)}`);
  expectAligned('wrapped lines align (ordered list)', `1. [/] ${'word '.repeat(40)}`);
  expectAligned(
    'wrapped lines align when the first line contains inline code',
    `1. [x] Add a \`sortBy\` field to the conversation store and persist it `
      + `(write the load/save path) — verified by the existing settings round-trip test.`
  );
  expectAligned(
    'wrapped lines align in a loose list (box inside a paragraph)',
    `- [!] ${'word '.repeat(40)}\n\n- [ ] second item`
  );
  expectAligned(
    'wrapped lines align when the item carries a nested list',
    `- [/] ${'word '.repeat(40)}\n    - nested child`
  );
  expectAligned(
    'wrapped lines align in a real rendered plan',
    renderPlanMarkdown({
      title: 'Sort conversations',
      steps: [
        {
          content: 'Add a `sortBy` field to the conversation store and persist it '
            + '(write the load/save path) — verified by the existing settings round-trip test.',
          status: 'completed',
          result: 'Demo only — nothing actually changed; store step marked done.',
        },
      ],
    })
  );

  // --- plan and todo write the markers --------------------------------------

  run('plan renders a marker for every status', () => {
    const md = renderPlanMarkdown({
      title: 'T',
      steps: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'failed' },
        { content: 'd', status: 'skipped' },
        { content: 'e', status: 'pending' },
      ],
    });
    for (const marker of ['[x] a', '[/] b', '[!] c', '[-] d', '[ ] e']) {
      assert(md.includes(marker), `plan markdown missing "${marker}":\n${md}`);
    }
  });

  run('plan says the status in words only for the model', () => {
    /** @type {{steps: Array<{content: string, status: string}>}} */
    const data = { steps: [{ content: 'a', status: 'in_progress' }] };
    const forPanel = renderPlanMarkdown(data);
    const forModel = renderPlanMarkdown(data, { statusWords: true });
    assert(!forPanel.includes('in progress'), `panel copy should have no words:\n${forPanel}`);
    assert(forPanel.includes('[/]'), `panel copy should still mark the state:\n${forPanel}`);
    assert(forModel.includes('_(in progress)_'), `model copy needs the words:\n${forModel}`);
  });

  run('todo renders a marker for every status', () => {
    const md = renderTodoMarkdown([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
    ]);
    for (const marker of ['[x] a', '[/] b', '[ ] c']) {
      assert(md.includes(marker), `todo markdown missing "${marker}":\n${md}`);
    }
    assert(!md.includes('in progress'), `panel copy should have no words:\n${md}`);
  });

  run('todo says the status in words only for the model', () => {
    const todos = [{ content: 'a', status: 'in_progress' }];
    const forModel = renderTodoMarkdown(todos, { statusWords: true });
    assert(forModel.includes('_(in progress)_'), `model copy needs the words:\n${forModel}`);
  });

  run('a plan step survives the round trip through the renderer', () => {
    const md = renderPlanMarkdown({
      steps: [
        { content: 'Add a `sortBy` field to the store', status: 'in_progress', result: null },
        { content: 'Wire the menu', status: 'completed', result: 'Landed in sidebar.js' },
      ],
    });
    const el = render(md);
    const items = el.querySelectorAll('li.task-list-item');
    assert(items.length === 2, `expected 2 rendered steps, got ${items.length}:\n${el.innerHTML}`);
    assert(
      items[0].querySelector('.task-box--in-progress'),
      `first step lost its state: ${items[0].innerHTML}`
    );
    // The result line is a continuation of its own step, not a list item of its own.
    assert(
      (items[1].textContent || '').includes('Landed in sidebar.js'),
      `result line escaped its step: ${el.innerHTML}`
    );
  });

  // --- continuation lines stay inside their own item ------------------------

  run('the continuation indent follows the marker width', () => {
    /** @type {Array<Record<string, any>>} */
    const steps = Array.from({ length: 10 }, (_, i) => ({
      content: `Step ${i + 1}`, status: 'completed', result: 'Done.',
    }));
    const md = renderPlanMarkdown({ steps });
    assert(md.includes('\n   Result: Done.'), `a single-digit step indents three:\n${md}`);
    assert(md.includes('\n    Result: Done.'), `step ten indents four:\n${md}`);
  });

  run('a step past nine keeps its blank-line paragraphs, and the steps after it', () => {
    /** @type {Array<Record<string, any>>} */
    const steps = Array.from({ length: 11 }, (_, i) => ({
      content: i === 9
        ? 'Ten opens.\n\nA second paragraph inside step ten.'
        : `Step ${i + 1}`,
      status: 'completed',
      result: i === 9 ? 'Landed.\n\nAnd a second result paragraph.' : null,
    }));
    const md = renderPlanMarkdown({ title: 'Eleven steps', steps });
    assert(!/\n[ \t]+\n/.test(md), `blank continuation lines carry no padding:\n${md}`);

    const el = render(md);
    const items = el.querySelectorAll('li.task-list-item');
    assert(items.length === 11, `expected 11 rendered steps, got ${items.length}:\n${el.innerHTML}`);
    assert(
      (items[9].textContent || '').includes('And a second result paragraph.'),
      `step ten's later paragraphs escaped it: ${el.innerHTML}`
    );
    assert(
      (items[10].textContent || '').includes('Step 11'),
      `the step after it stopped being a list item: ${el.innerHTML}`
    );
  });

  run('a todo item past nine keeps its blank-line paragraphs', () => {
    /** @type {Array<Record<string, any>>} */
    const todos = Array.from({ length: 10 }, (_, i) => ({
      content: i === 9 ? 'Ten opens.\n\nA second paragraph.' : `Item ${i + 1}`,
      status: 'pending',
    }));
    const el = render(renderTodoMarkdown(todos));
    const items = el.querySelectorAll('li.task-list-item');
    assert(items.length === 10, `expected 10 rendered items, got ${items.length}:\n${el.innerHTML}`);
    assert(
      (items[9].textContent || '').includes('A second paragraph.'),
      `item ten's second paragraph escaped it: ${el.innerHTML}`
    );
  });

  // --- both blocks draw their progress --------------------------------------

  /**
   * The progress bar's segments, in the order they are drawn.
   * @param {HTMLElement} block - A block from createPlanBlock or createTodoBlock.
   * @returns {Array<{state: string, width: number}>} Each segment's state and its width in percent.
   */
  const segments = (block) => Array.from(block.querySelectorAll('.task-progress__segment')).map(
    (el) => ({
      state: (el.className.match(/task-progress__segment--([a-z-]+)/) || [])[1] || '',
      width: parseFloat(/** @type {HTMLElement} */ (el).style.width),
    })
  );

  /**
   * A block's bar must sit between the count line it illustrates and the list.
   * @param {string} label - Case name
   * @param {() => HTMLElement} build - Builds the block to check.
   * @param {string} count - The count the line above the bar must carry.
   */
  const expectBarUnderCount = (label, build, count) => {
    run(label, () => {
      const block = build();
      const bar = block.querySelector('.task-progress');
      assert(!!bar, `no progress bar in the block:\n${block.innerHTML}`);
      const before = bar?.previousElementSibling;
      assert(
        before?.tagName === 'P' && (before.textContent || '').includes(count),
        `the bar left its count line: ${block.innerHTML}`
      );
      assert(
        bar?.nextElementSibling?.tagName === 'OL',
        `the list stopped following the bar: ${block.innerHTML}`
      );
    });
  };

  expectBarUnderCount(
    'the plan bar sits under the status line it illustrates',
    () => createPlanBlock({ title: 'T', steps: [{ content: 'a', status: 'completed' }] }),
    'Progress: 1/1'
  );

  expectBarUnderCount(
    'the todo bar sits under the progress line it illustrates',
    () => createTodoBlock([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'pending' },
    ]),
    'Progress: 1/2'
  );

  run('the bar draws a segment per resolved state, in order, to scale', () => {
    /** @type {Array<Record<string, any>>} */
    const steps = [
      ...Array.from({ length: 4 }, (_, i) => ({ content: `done ${i}`, status: 'completed' })),
      { content: 'running', status: 'in_progress' },
      { content: 'broke', status: 'failed' },
      { content: 'stood down', status: 'skipped' },
      { content: 'waiting', status: 'pending' },
    ];
    const segs = segments(createPlanBlock({ steps }));
    assert(
      segs.map((s) => s.state).join(',') === 'completed,in-progress,failed',
      `wrong segments, or out of order: ${JSON.stringify(segs)}`
    );
    // Half done, one step of eight running, one failed — and the skipped and
    // pending steps leave bare track, as the "4/8 completed" line above says.
    assert(Math.abs(segs[0].width - 50) < 0.01, `four of eight is half: ${JSON.stringify(segs)}`);
    assert(Math.abs(segs[1].width - 12.5) < 0.01, `one of eight is an eighth: ${JSON.stringify(segs)}`);
    assert(Math.abs(segs[2].width - 12.5) < 0.01, `one of eight is an eighth: ${JSON.stringify(segs)}`);
  });

  run('a todo list colours the three states it spells', () => {
    const segs = segments(createTodoBlock([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
      { content: 'd', status: 'pending' },
    ]));
    assert(
      segs.map((s) => s.state).join(',') === 'completed,in-progress',
      `wrong segments, or out of order: ${JSON.stringify(segs)}`
    );
    assert(Math.abs(segs[0].width - 25) < 0.01, `one of four is a quarter: ${JSON.stringify(segs)}`);
  });

  run('a state nothing is in draws nothing', () => {
    const segs = segments(createPlanBlock({ steps: [{ content: 'a', status: 'pending' }] }));
    assert(segs.length === 0, `an untouched plan should be bare track: ${JSON.stringify(segs)}`);
  });

  run('an empty list has no bar to draw', () => {
    const plan = createPlanBlock({ title: 'T', steps: [] });
    assert(!plan.querySelector('.task-progress'), `an empty plan drew a bar: ${plan.innerHTML}`);
    const todo = createTodoBlock([]);
    assert(!todo.querySelector('.task-progress'), `an empty todo list drew a bar: ${todo.innerHTML}`);
  });

  return { passed, failed, errors };
}
