//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ESLint rule: SVG markup written in a string names no colour of its own.
 *
 * The stylesheets may only use the design tokens for colour (web/css/README.md
 * ▸ Tokens; stylelint enforces it). An icon written as markup in a string or
 * template literal could still paint `fill="white"` or `stroke="#d73a49"`, out
 * of reach of the themes. So in any literal that holds SVG markup — an `<svg`
 * or an SVG element tag (`<path`, `<circle`, `<stop`, …) — every paint
 * attribute (`fill`, `stroke`, `stop-color`, `flood-color`, `lighting-color`,
 * `color`), and every such property in a `style` attribute, must be one of:
 * - `currentColor`, with the colour set by CSS on the element or an ancestor;
 * - `none`, `transparent`, `inherit`, `context-fill`, `context-stroke`;
 * - `var(--token)`, with no fallback (a fallback is itself a literal colour);
 * - `url(#id)`, a paint server defined in the same markup.
 * A value built by a `${}` is not judged here: it is not written in the markup.
 * @type {import('eslint').Rule.RuleModule}
 */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'SVG markup in strings must take its colours from CSS, not literal values' },
    schema: [],
    messages: {
      literal: 'Literal colour {{attr}}="{{value}}" in SVG markup — use currentColor and set the colour in CSS, '
        + 'or var(--token) from web/css/tokens/ (web/css/README.md ▸ Tokens).',
    },
  },
  create(context) {
    const SVG = /<(?:svg|path|circle|rect|ellipse|line|polyline|polygon|g|stop|use|text|tspan|linearGradient|radialGradient|mask|clipPath|symbol|defs|pattern|marker|filter|fe[A-Z]\w*)[\s/>]/;
    const PAINT = 'fill|stroke|stop-color|flood-color|lighting-color|color';
    const ATTR = new RegExp(`(?<![\\w:.-])(${PAINT}|style)\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>/]+))`, 'g');
    const STYLE_DECL = new RegExp(`(?:^|;)\\s*(${PAINT})\\s*:\\s*([^;]*)`, 'gi');
    const ALLOWED = /^(?:currentcolor|none|transparent|inherit|context-fill|context-stroke|var\(\s*--[\w-]+\s*\)|url\(\s*#[\w-]+\s*\))$/i;
    // A NUL cannot occur in markup a developer writes, so it marks where a
    // `${}` stood.
    const HOLE = '\u0000';
    const sourceCode = context.sourceCode;

    /**
     * Report the literal colours in one stretch of markup.
     * @param {import('estree').Node} node - The literal it came from.
     * @param {string} text - Its text, a `${}` as HOLE.
     * @param {(i: number) => number} offsetOf - The source offset of text[i].
     */
    function check(node, text, offsetOf) {
      if (!SVG.test(text)) return;
      for (const m of text.matchAll(ATTR)) {
        const name = m[1];
        const value = m[2] ?? m[3] ?? m[4];
        const valueAt = m.index + m[0].length - value.length - (m[4] === undefined ? 1 : 0);
        /** @type {Array<[string, string, number]>} */
        const paints = [];
        if (name === 'style') {
          for (const d of value.matchAll(STYLE_DECL)) {
            paints.push([d[1], d[2].trim(), valueAt + d.index + d[0].indexOf(d[2])]);
          }
        } else {
          paints.push([name, value.trim(), valueAt]);
        }
        for (const [attr, v, at] of paints) {
          if (v.includes(HOLE) || ALLOWED.test(v)) continue;
          context.report({
            node,
            loc: { start: sourceCode.getLocFromIndex(offsetOf(at)), end: sourceCode.getLocFromIndex(offsetOf(at) + v.length) },
            messageId: 'literal',
            data: { attr, value: v },
          });
        }
      }
    }

    return {
      Literal(node) {
        if (typeof node.value !== 'string') return;
        const [start, end] = /** @type {[number, number]} */ (node.range);
        // Where the value is its source verbatim, each character is at its own
        // offset; an escape sequence shifts them, so the report falls back to
        // the literal's opening quote.
        const verbatim = sourceCode.text.slice(start + 1, end - 1) === node.value;
        check(node, node.value, (i) => (verbatim ? start + 1 + i : start));
      },
      TemplateLiteral(node) {
        // Each text's range takes in its delimiters: the backtick or `}` before
        // it and the `${` or backtick after it. The source between them is
        // read rather than `raw`, which folds CRLF to LF and so would drift.
        /** @type {Array<[number, number]>} */
        const spans = [];
        let text = '';
        const last = node.quasis.length - 1;
        node.quasis.forEach((q, i) => {
          const [start, end] = /** @type {[number, number]} */ (q.range);
          if (i > 0) text += HOLE;
          spans.push([text.length, start + 1]);
          text += sourceCode.text.slice(start + 1, end - (i === last ? 1 : 2));
        });
        check(node, text, (i) => {
          let span = spans[0];
          for (const s of spans) if (s[0] <= i) span = s;
          return span[1] + (i - span[0]);
        });
      },
    };
  },
};
