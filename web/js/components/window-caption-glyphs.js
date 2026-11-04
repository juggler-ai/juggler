//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The window caption buttons' glyphs, drawn as 1px strokes on a 10×10 grid so
 * they stay crisp and match the thin-line Windows convention. currentColor
 * lets them take the button's theme colour (and the white-on-red close hover).
 *
 * Two readers draw them: the caption controls (window-caption-controls.js),
 * and the fallback bar laid over a page that is not Juggler's
 * (cmd/juggler-app/foreign_page.go), which cannot load this module and reads
 * the object between the markers below as JSON. So it stays JSON — double
 * quotes, no trailing commas, no comments inside — and the markers stay.
 *
 * `svg` is the attributes of the <svg> every glyph is drawn in; each glyph is
 * the list of its elements, as [tag, attributes].
 * @module components/window-caption-glyphs
 */

/** @typedef {[string, Record<string, string>]} GlyphPart - an element, as [tag, attributes] */
/** @typedef {'minimise'|'maximise'|'restore'|'close'} GlyphName */

/** @type {{svg: Record<string, string>} & Record<GlyphName, GlyphPart[]>} */
const CAPTION_GLYPHS = /* caption-glyphs */ {
  "svg": { "viewBox": "0 0 10 10", "fill": "none", "stroke": "currentColor", "stroke-width": "1" },
  "minimise": [["path", { "d": "M1 5 h8" }]],
  "maximise": [["rect", { "x": "1", "y": "1", "width": "8", "height": "8" }]],
  "restore": [
    ["path", { "d": "M3 3 V1.5 A0.5 0.5 0 0 1 3.5 1 H8.5 A0.5 0.5 0 0 1 9 1.5 V6.5 A0.5 0.5 0 0 1 8.5 7 H7" }],
    ["rect", { "x": "1", "y": "3", "width": "6", "height": "6" }]
  ],
  "close": [["path", { "d": "M1 1 L9 9 M9 1 L1 9" }]]
} /* end caption-glyphs */;

/**
 * A glyph's attributes as markup.
 * @param {Record<string, string>} attrs - The attributes, all constants above.
 * @returns {string} ` name="value"` for each
 */
function attributes(attrs) {
  return Object.entries(attrs).map(([name, value]) => ` ${name}="${value}"`).join('');
}

/**
 * A glyph as markup: its elements in the glyphs' <svg>.
 * @param {GlyphName} name - Which glyph.
 * @returns {string} the full `<svg>` element markup
 */
export function glyphSvg(name) {
  /** @type {GlyphPart[]} */
  const parts = CAPTION_GLYPHS[name];
  const inner = parts.map(([tag, attrs]) => `<${tag}${attributes(attrs)}/>`).join('');
  return `<svg${attributes(CAPTION_GLYPHS.svg)} aria-hidden="true" focusable="false">${inner}</svg>`;
}
