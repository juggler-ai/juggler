//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: the incremental ("sealed prefix") Markdown renderer.
 *
 * createStreamingMarkdown exists to stop a growing block re-parsing all of
 * itself on every update. Two things have to hold, and they pull against each
 * other, so both are asserted throughout:
 *
 *  1. CHEAP — the total text handed to the Markdown parser across a whole
 *     stream stays proportional to the text's length, not to length × number
 *     of updates. Measured by counting the characters marked.parse actually
 *     receives.
 *  2. IDENTICAL — the DOM it arrives at is the one a single all-at-once render
 *     would have produced. Sealing early would be a silent corruption, so the
 *     traps get their own cases: a blank line inside a fenced code block, a
 *     blank line between list items (which keeps one list, loosely), a table,
 *     and a link reference definition, which reaches back over everything
 *     rendered before it.
 * @module unit-tests/streaming-markdown-test
 */

import { assert } from '../utilities/test-helpers.js';
import { createStreamingMarkdown, findSealPoint } from '../../js/utils/streaming-markdown.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * @param {object} _ctx
 * @returns {Promise<TestResult>} Aggregated results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => (void | Promise<void>)} fn
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

  /** @returns {HTMLElement} A mounted render target. */
  const mount = () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    return el;
  };

  /**
   * The rendered markup, with the internal sealed/live marker removed so it can
   * be compared against a one-shot render.
   * @param {HTMLElement} host - Render target.
   * @returns {string} Comparable markup.
   */
  const markup = (host) => host.innerHTML.replace(/<!--live-->/g, '');

  /**
   * Stream `text` in `steps` roughly equal pieces and return the final markup
   * plus how much text the Markdown parser was handed in total.
   * @param {string} text - Full text to stream.
   * @param {number} steps - Number of updates to split it into.
   * @param {object} [options] - Passed to createStreamingMarkdown.
   * @returns {{html: string, parsedChars: number}} Result of the stream.
   */
  const stream = (text, steps, options = { escapeXml: true }) => {
    const host = mount();
    // marked's own `parse` is a read-only property, so the meter goes on a
    // stand-in global; renderMarkdown reads window.marked afresh each call.
    const real = /** @type {any} */ (window).marked;
    let parsedChars = 0;
    Object.defineProperty(window, 'marked', {
      configurable: true,
      writable: true,
      value: {
        setOptions: (/** @type {any} */ o) => real.setOptions(o),
        parse: (/** @type {string} */ src, /** @type {any[]} */ ...rest) => {
          parsedChars += src.length;
          return real.parse(src, ...rest);
        },
      },
    });
    try {
      const s = createStreamingMarkdown(host, options);
      for (let i = 1; i <= steps; i++) {
        s.update(text.slice(0, Math.round((text.length * i) / steps)));
      }
      // Settle rather than waiting out the debounce: the comparison is against
      // fully-rendered output, and a timing-dependent test would be flaky.
      s.settle();
      return { html: markup(host), parsedChars };
    } finally {
      Object.defineProperty(window, 'marked', { configurable: true, writable: true, value: real });
      host.remove();
    }
  };

  /**
   * The markup a single all-at-once render produces for the same text.
   * @param {string} text - Full text.
   * @param {object} [options] - Passed to createStreamingMarkdown.
   * @returns {string} Reference markup.
   */
  const oneShot = (text, options = { escapeXml: true }) => {
    const host = mount();
    try {
      const s = createStreamingMarkdown(host, options);
      s.update(text);
      s.settle();
      return markup(host);
    } finally { host.remove(); }
  };

  /**
   * Assert that streaming `text` in `steps` pieces lands on the same DOM as
   * rendering it in one go.
   * @param {string} label - What the text is, for the failure message.
   * @param {string} text - Full text.
   * @param {number} [steps] - Number of updates.
   * @param {object} [options] - Passed to createStreamingMarkdown.
   */
  const assertSameAsOneShot = (label, text, steps = 12, options = { escapeXml: true }) => {
    const { html } = stream(text, steps, options);
    const expected = oneShot(text, options);
    assert(html === expected, `${label}: streamed DOM diverged\n  got:      ${html}\n  expected: ${expected}`);
  };

  /**
   * @param {number} n - Paragraph count.
   * @returns {string} Prose with no Markdown construct in it.
   */
  const paragraphs = (n) =>
    Array.from({ length: n }, (_, i) => `Paragraph ${i} weighing the options at hand.`).join('\n\n');

  /**
   * @param {number} n - Paragraph count.
   * @returns {string} The same prose, carrying a Markdown construct.
   */
  const mdParagraphs = (n) =>
    Array.from({ length: n }, (_, i) => `**Step ${i}** weighing the options at hand.`).join('\n\n');

  await run('a stream costs the parser its own length, not its length per update', () => {
    const text = mdParagraphs(40);
    const { parsedChars } = stream(text, 40);
    assert(parsedChars > 0, 'the meter must actually see the parser');
    // Re-parsing the whole accumulation each time costs ~20x the text at this
    // number of updates. Sealing measures ~1.2x: each paragraph is parsed as
    // the live tail, and most are sealed in the same pass that first saw them.
    // The bound is loose enough not to fuss, tight enough to catch a return to
    // whole-string re-parsing.
    assert(parsedChars < text.length * 4,
      `expected roughly linear parse cost, parsed ${parsedChars} chars for ${text.length} of text`);
  });

  await run('plain paragraphs stream to the same DOM as one render', () => {
    assertSameAsOneShot('verbatim prose', paragraphs(12));
    assertSameAsOneShot('markdown paragraphs', mdParagraphs(12));
  });

  await run('a blank line inside a fenced code block is not a seal point', () => {
    const text = [
      'Trying this:',
      '',
      '```js',
      'const a = 1;',
      '',
      'const b = 2;',
      '```',
      '',
      'That should do it.',
      '',
    ].join('\n');
    assertSameAsOneShot('fenced code with a blank line', text);

    // Mid-stream, with the fence still open, the blank line inside the code is
    // the only candidate there is — and taking it would cut the block in half.
    const openFence = text.slice(0, text.indexOf('const b = 2;'));
    assert(findSealPoint(openFence, 0).seal === text.indexOf('```js'),
      'an open fence must not be sealed into');
    // Once it closes, sealing past the whole block is safe.
    assert(findSealPoint(text, 0).seal === text.indexOf('That should do it.'),
      'a closed fence should seal along with the text before it');
  });

  await run('a blank line between list items is not a seal point', () => {
    const text = [
      'Options:',
      '',
      '- first',
      '',
      '- second',
      '',
      '- third',
      '',
      'Going with the second.',
      '',
    ].join('\n');
    assertSameAsOneShot('loose list', text);
    const { seal } = findSealPoint(text, 0);
    assert(seal === text.indexOf('- first'),
      `a list must seal as one block, not item by item (sealed at ${seal})`);
  });

  await run('a table streams to the same DOM as one render', () => {
    const text = [
      'Comparing:',
      '',
      '| opt | cost |',
      '| --- | ---- |',
      '| a   | 1    |',
      '| b   | 2    |',
      '',
      'So: a.',
      '',
    ].join('\n');
    assertSameAsOneShot('table', text);
  });

  await run('a link reference definition re-renders everything before it', () => {
    const text = [
      'See [the notes][n] for context.',
      '',
      'More reasoning follows here.',
      '',
      '[n]: https://example.com/notes',
      '',
    ].join('\n');
    assertSameAsOneShot('link reference definition', text);
    const { html } = stream(text, 8);
    assert(html.includes('https://example.com/notes'),
      'the definition must reach the link that was rendered before it');
  });

  await run('raw prose is shown verbatim and switches to Markdown when a construct arrives', () => {
    const host = mount();
    try {
      const s = createStreamingMarkdown(host, { escapeXml: true });
      s.update('Weighing 2 * 3 against foo_bar_baz.');
      assert(host.className === 'plain', `prose must not be parsed as Markdown (was "${host.className}")`);
      assert(host.textContent === 'Weighing 2 * 3 against foo_bar_baz.', 'shown verbatim');

      s.update('Weighing 2 * 3 against foo_bar_baz.\n\n**Then** the flag.');
      assert(host.className === 'markdown', `expected a switch to Markdown, was "${host.className}"`);
      assert(!!host.querySelector('strong'), 'the construct renders');
      assert(!host.textContent.includes('**'), 'the markers are consumed, not shown');
    } finally { host.remove(); }
  });

  await run('a complete reply is highlighted on the spot, a half-arrived fence is not', () => {
    const host = mount();
    try {
      // A reply restored from history: complete, rendered in one go, coloured
      // immediately — the shape of every message on screen when a tab opens.
      const s = createStreamingMarkdown(host, { escapeXml: false, detect: false });
      s.update('Here:\n\n```js\nconst a = 1;\n```\n');
      assert(host.querySelector('pre code .token') !== null, 'a complete reply should be coloured');

      const live = mount();
      try {
        const t = createStreamingMarkdown(live, { escapeXml: false, detect: false });
        t.update('Trying this:\n\n```js\nconst a = 1;');
        assert(live.querySelector('pre code') !== null, 'the partial block should still render');
        assert(live.querySelector('pre code .token') === null,
          'a fence that is still arriving must not be tokenised');
      } finally { live.remove(); }
    } finally { host.remove(); }
  });

  await run('a sealed fence is highlighted, and the trailing one when it settles', () => {
    const host = mount();
    try {
      const s = createStreamingMarkdown(host, { escapeXml: false, detect: false });
      s.update('Trying this:\n\n```js\nconst a = 1;');
      // Closed, with a blank line and more text after it: the block seals.
      s.update('Trying this:\n\n```js\nconst a = 1;\n```\n\nThat should do it.\n\nAnd then:\n\n```js\nconst b = 2;');
      const blocks = host.querySelectorAll('pre code');
      assert(blocks.length === 2, `expected two blocks, got ${blocks.length}`);
      assert(blocks[0]?.querySelector('.token') !== null, 'the sealed fence should be coloured');
      assert(blocks[1]?.querySelector('.token') === null, 'the live tail should not be');
      assert(blocks[0]?.textContent?.trim() === 'const a = 1;', 'highlighting changed the visible text');

      s.settle();
      assert(host.querySelectorAll('pre code')[1]?.querySelector('.token') !== null,
        'settling should colour the trailing block');
    } finally { host.remove(); }
  });

  // An assistant reply renders its own inline HTML (escapeXml: false), so a
  // blank line inside an SVG or a <div> is a blank line inside an element whose
  // children are still arriving. Sealing there parses the opening tag as a
  // fragment of its own — where innerHTML closes it — and every later child into
  // a second fragment, which lands outside it. The one-shot render cannot go
  // wrong that way, so these compare against it.
  const raw = { escapeXml: false, detect: false };

  await run('a blank line inside an SVG is not a seal point', () => {
    const text = [
      'Here is the chart:',
      '',
      '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">',
      '  <rect x="0" y="0" width="100" height="100" fill="#111"/>',
      '',
      '  <circle cx="50" cy="50" r="40" fill="#e33"/>',
      '</svg>',
      '',
      'That should do it.',
      '',
    ].join('\n');
    assertSameAsOneShot('svg with a blank line', text, 12, raw);

    const { html } = stream(text, 12, raw);
    // The symptom, stated in its own terms: the circle has to be INSIDE the svg.
    // Split across two fragments it is an unknown HTML element sitting after the
    // picture, which occupies no space and paints nothing — the reply appears to
    // stop rendering halfway through the image.
    const host = mount();
    try {
      host.innerHTML = html;
      const svg = host.querySelector('svg');
      assert(!!svg, 'the svg element must survive the stream');
      assert(!!svg?.querySelector('circle'),
        'the child after the blank line must land inside the svg, not after it');
      assert(svg?.querySelectorAll('rect, circle').length === 2,
        'every shape belongs to the one picture');
    } finally { host.remove(); }
  });

  await run('a blank line inside an open HTML block is not a seal point', () => {
    const text = [
      '<div class="card">',
      '  <p>First.</p>',
      '',
      '  <p>Second.</p>',
      '</div>',
      '',
      'Done.',
      '',
    ].join('\n');
    assertSameAsOneShot('div with a blank line', text, 10, raw);
    assert(findSealPoint(text, 0).seal === text.indexOf('Done.'),
      'an unclosed HTML element must not be sealed into');
  });

  await run('CSS a reply brings still reaches the markup it styles', () => {
    // Authored CSS is scoped to a box minted per parse (see markdown.js's
    // boxAuthoredHtml), so a <style> parsed in one segment and the markup it
    // names parsed in another are scoped to two different boxes and the styling
    // silently does nothing — until a reload renders the lot in one pass.
    const text = [
      '<style>',
      '.card { color: red; }',
      '</style>',
      '',
      '<div class="card">Styled.</div>',
      '',
      'Done.',
      '',
    ].join('\n');
    const { html } = stream(text, 10, raw);
    const host = mount();
    try {
      host.innerHTML = html;
      const scope = host.querySelector('[data-markdown-scope]');
      assert(!!scope, 'authored CSS must still be boxed');
      assert(!!scope?.querySelector('.card'),
        'the styled markup must sit inside the scope its CSS was written for');
    } finally { host.remove(); }
  });

  await run('a tag named in prose does not stop the stream sealing', () => {
    // The cheapness half of the bargain: suspending sealing for raw HTML must
    // key on a block that actually opened, not on any `<` the prose mentions.
    const text = [
      'The `<div>` element wraps it, and <span> is inline.',
      '',
      ...Array.from({ length: 20 }, (_, i) => `**Step ${i}** weighing the options.\n`),
    ].join('\n');
    const { parsedChars } = stream(text, 20, raw);
    assert(parsedChars < text.length * 4,
      `prose naming a tag must not disable sealing, parsed ${parsedChars} chars for ${text.length} of text`);
  });

  await run('a rewritten prefix is re-rendered rather than appended to', () => {
    const host = mount();
    try {
      const s = createStreamingMarkdown(host, { escapeXml: true });
      s.update('# One\n\nFirst body.\n\nSecond body.\n\n');
      // Not a continuation of what came before — the whole text changed.
      s.update('# Two\n\nDifferent body entirely.\n\n');
      assert(host.textContent.includes('Two'), 'the new text is rendered');
      assert(!host.textContent.includes('One'), 'the stale sealed prefix is gone');
    } finally { host.remove(); }
  });

  return { passed, failed, errors };
}
