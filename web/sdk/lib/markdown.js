//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Markdown rendering utilities with safe XML/HTML handling
 */

import { createCopyButton } from './copy-button.js';
import { externalURLFromHref } from './window-control.js';
import { TASK_STATES, TASK_LABELS, TASK_MARKER_RE } from './task-markers.js';
import { highlightCode } from './syntax-highlight.js';
import { normalizeLanguageId } from './languages.js';

/**
 * Escape XML/HTML tags that appear outside of code blocks
 * This prevents stray XML like <read_file> from vanishing in markdown rendering
 * Also wraps XML tags in inline code formatting for monospace display
 * @param {string} text - Raw text that may contain XML tags
 * @returns {string} Text with XML tags wrapped in inline code
 */
export function escapeXmlTagsForMarkdown(text) {
  // Strategy: Find XML tags and wrap them in inline code (`...`) for monospace display
  // We detect code blocks by looking for ``` fences and inline code with `

  let result = '';
  let inCodeBlock = false;
  let inInlineCode = false;
  let i = 0;

  while (i < text.length) {
    // Check for code fence (```)
    if (text.substr(i, 3) === '```') {
      inCodeBlock = !inCodeBlock;
      result += '```';
      i += 3;
      continue;
    }

    // Check for inline code (`)
    if (text[i] === '`' && !inCodeBlock) {
      inInlineCode = !inInlineCode;
      result += '`';
      i++;
      continue;
    }

    // If we're in a code context, don't escape
    if (inCodeBlock || inInlineCode) {
      result += text[i];
      i++;
      continue;
    }

    // Outside code: look for XML tags and wrap them in inline code
    if (text[i] === '<') {
      // Find the end of the tag
      let tagEnd = i + 1;
      while (tagEnd < text.length && text[tagEnd] !== '>') {
        tagEnd++;
      }

      if (tagEnd < text.length) {
        // Found complete tag, wrap it in inline code
        const tag = text.substring(i, tagEnd + 1);
        result += '`' + tag + '`';
        i = tagEnd + 1;
      } else {
        // Incomplete tag (just < without >), escape it
        result += '&lt;';
        i++;
      }
    } else if (text[i] === '>') {
      // Stray > without matching <, escape it
      result += '&gt;';
      i++;
    } else {
      result += text[i];
      i++;
    }
  }

  return result;
}

/**
 * Replace href/src URLs whose scheme is one of the script-execution sinks
 * (javascript:, vbscript:, data: when not a known-safe image type) with "#".
 * Operates on the rendered HTML string; we accept the small false-positive
 * cost (e.g. text content that literally contains the substring inside an
 * attribute) in exchange for not pulling in a full HTML parser.
 * @param {string} html - HTML to scrub
 * @returns {string} HTML with dangerous URLs neutralised
 */
function neutraliseDangerousUrls(html) {
  // Matches href= or src= followed by " or ' or no quote, then optional
  // whitespace, then one of the dangerous schemes.
  return html.replace(
    /(\b(?:href|src)\s*=\s*)(["']?)\s*(javascript:|vbscript:|data:text\/html)[^"'\s>]*/gi,
    (_match, attr, quote) => `${attr}${quote}#`
  );
}

/**
 * Rewrite every external link in rendered markdown so it opens outside the app
 * instead of navigating the in-process WebView off its page.
 *
 * This is the real fix for "an LLM-authored link hijacked my window": a markdown
 * link emits a plain same-window `<a href>` with no `target`, so a click makes
 * the WebView navigate away. We own the markdown→HTML step, so we neutralise it
 * here at the source. For each external (or scheme-less bare-domain) link we:
 *  - re-qualify the href to an absolute `https://` URL (a bare `github.com/u/r`
 *    would otherwise resolve same-origin and navigate the app to itself), and
 *  - add `target="_blank" rel="noopener noreferrer"`.
 *
 * In a normal browser `target="_blank"` opens a new tab. In the native WebView
 * `_blank` is swallowed (no navigation), and the delegated click handler in
 * app.js turns that click into a system-browser open via the loopback opener —
 * so the destructive navigation never happens regardless of which path runs.
 *
 * Genuine relative links (`readme.md`, `docs/guide`), in-page `#hash`, and
 * same-origin links are left untouched. Operates on the HTML string (consistent
 * with neutraliseDangerousUrls); marked emits `href` as the first anchor
 * attribute, so the targeted regex is sufficient.
 * @param {string} html - Rendered HTML.
 * @returns {string} HTML with external links rewritten to open externally.
 */
function externalizeLinks(html) {
  if (typeof window === 'undefined') return html;
  const origin = window.location.origin;
  const base = window.location.href;
  return html.replace(/<a\s+href="([^"]*)"([^>]*)>/gi, (match, href, rest) => {
    let resolved = href;
    try {
      resolved = new URL(href, base).href;
    } catch {
      // Leave unparseable hrefs to externalURLFromHref's own handling.
    }
    const external = externalURLFromHref(href, resolved, origin);
    if (!external) return match;
    // Drop any target/rel marked may have emitted; we set our own.
    const cleaned = rest.replace(/\s(?:target|rel)="[^"]*"/gi, '');
    return `<a href="${external}"${cleaned} target="_blank" rel="noopener noreferrer">`;
  });
}

/**
 * Tags marked (with gfm) legitimately emits, plus the handful of inline
 * formatting elements a summary/plan can carry. Everything else — most
 * importantly any hyphenated *custom element* like `<composer-box>` — is neutralised
 * by {@link sanitizeRenderedHtml}. `input` is here only for gfm task-list
 * checkboxes; its attributes are still filtered against ALLOWED_ATTRS.
 */
const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'circle', 'code', 'defs', 'del', 'div', 'ellipse', 'em', 'g',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'kbd', 'line', 'lineargradient', 'li',
  'ol', 'p', 'path', 'polygon', 'pre', 'radialgradient', 'rect', 's', 'small', 'span', 'stop', 'strong',
  'style', 'sub', 'sup', 'svg', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
]);

/**
 * Attributes allowed to survive on an allowlisted element. Anything else — and
 * every `on*` inline event handler regardless of this list — is stripped. URL
 * attributes (href/src) are additionally scrubbed by neutraliseDangerousUrls
 * before this pass runs.
 */
const ALLOWED_ATTRS = new Set([
  'href', 'src', 'alt', 'title', 'class', 'id', 'target', 'rel', 'type',
  'checked', 'disabled', 'align', 'colspan', 'rowspan', 'start', 'width', 'height',
  // Inline declarations. Safe from script in every engine we run on (`expression()`
  // and `javascript:` URLs in CSS are long dead), and layout-wise it can reach no
  // further than the `<style>` blocks alongside it: both are confined to the
  // contained box sanitizeRenderedHtml wraps authored HTML in.
  'style',
  // `data-*`: content the message styles itself with (the preview's checkbox
  // states) and nothing the engine gives meaning to. Every one passes through;
  // there is no `data-` attribute the browser will act on for us.
  'data-task-state',
  // Declarative SVG geometry and paint attributes. We intentionally exclude
  // `href`/`xlink:href` for SVG elements, `foreignObject`, animation,
  // filters, and every event-handler attribute.
  'viewbox', 'xmlns', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'd', 'points', 'transform', 'fill', 'fill-opacity', 'fill-rule', 'stroke',
  'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'opacity',
  'offset', 'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform',
]);

/**
 * Class on the box authored HTML is wrapped in, and the attribute carrying the
 * per-render scope id.
 *
 * Two nested elements rather than one, because they hold opposite privileges:
 * the outer box carries `contain`, and only the inner one carries the scope id.
 * Authored CSS can therefore only ever name the inner element, so a
 * `position: fixed` it sets on itself still resolves against the outer box —
 * the worst a message can do is cover itself, not the window.
 */
const HTML_SCOPE_CLASS = 'markdown-html-scope';
const HTML_SCOPE_ATTR = 'data-markdown-scope';

/** Per-render id source, so two messages on screen never share a scope. */
let htmlScopeSeq = 0;

/** Leading document-root selectors, which a standalone fragment writes out of habit. */
const ROOT_SELECTOR = /^\s*(?::root|html|body)(?:\s+(?::root|html|body))*\b/;

/**
 * A closing style tag surviving inside a CSS string would break out of the `<style>` we serialise into.
 */
const CLOSING_STYLE_TAG = /<\/(style)/gi;

/**
 * Keep `<style>` blocks whole across CommonMark's HTML-block rules.
 *
 * An HTML block that opens with a tag like `<div>` ends at the first blank
 * line — but stylesheets are conventionally written with blank lines between
 * their sections, so the `<style>` a message nests inside its markup is cut in
 * half: everything from the first blank line to `</style>` falls out of the
 * block and is parsed as markdown prose. (A `<style>` that *starts* its own
 * block is type 1, which runs to the closing tag and is unaffected.)
 *
 * CSS is whitespace-blind between tokens, so collapsing the blank lines inside
 * a `<style>` region changes nothing about the rules while keeping the block
 * intact until `</style>`.
 * @param {string} content - Markdown source that may contain style blocks.
 * @returns {string} Content with blank lines inside `<style>` regions collapsed.
 */
function keepStyleBlocksIntact(content) {
  if (!content.includes('<style')) return content;
  return content.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, (block) => block.replace(/\n[ \t]*\n+/g, '\n'));
}

/**
 * Split a selector list on its top-level commas. `String.split(',')` would
 * corrupt `:is(a, b)` and `[title="a,b"]`, both of which are ordinary things to
 * write and neither of which is a comma we may cut on.
 * @param {string} selectorText - A selector list.
 * @returns {string[]} The individual complex selectors.
 */
function splitSelectorList(selectorText) {
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < selectorText.length; i++) {
    const ch = selectorText[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === '\'') {
      quote = ch;
    } else if (ch === '(' || ch === '[') {
      depth++;
    } else if (ch === ')' || ch === ']') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      parts.push(selectorText.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(selectorText.slice(start));
  return parts;
}

/**
 * Confine one selector to the scope element.
 *
 * `body`/`html`/`:root` are retargeted at the scope element itself rather than
 * prefixed: a fragment written as if it were a whole page means "the thing I am
 * in" by them, and `[scope] body` would match nothing. Everything else becomes a
 * descendant of the scope, which is what makes the containment total — no
 * combinator can walk back out of a descendant selector.
 * @param {string} selector - One complex selector.
 * @param {string} scope - Selector matching the scope element.
 * @returns {string} The scoped selector.
 */
function scopeOneSelector(selector, scope) {
  const trimmed = selector.trim();
  if (!trimmed) return trimmed;
  const rooted = trimmed.replace(ROOT_SELECTOR, '');
  // `body.dark .x` keeps its compound and becomes `[scope].dark .x`.
  if (rooted !== trimmed) return `${scope}${rooted}`;
  return `${scope} ${trimmed}`;
}

/**
 * `instanceof` against a CSSOM class the engine may not have.
 * @param {CSSRule} rule - Rule to test.
 * @param {string} className - Global CSSOM constructor name.
 * @returns {boolean} True if rule is an instance of that class.
 */
function cssRuleIs(rule, className) {
  const ctor = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis))[className];
  return typeof ctor === 'function' && rule instanceof ctor;
}

/**
 * Give every `@keyframes` in the sheet a scope-unique name and record the
 * renames. Animation names are global no matter where the rule sits, so a
 * message defining `@keyframes spin` would otherwise redefine the app's.
 * @param {CSSRuleList} rules - Rules to walk.
 * @param {string} suffix - Suffix making a name unique to this render.
 * @param {Map<string, string>} renamed - Accumulates original → new name.
 */
function renameKeyframes(rules, suffix, renamed) {
  for (const rule of Array.from(rules)) {
    if (cssRuleIs(rule, 'CSSKeyframesRule')) {
      const keyframes = /** @type {CSSKeyframesRule} */ (rule);
      const original = keyframes.name;
      if (!original) continue;
      keyframes.name = `${original}${suffix}`;
      renamed.set(original, keyframes.name);
    } else if ('cssRules' in rule && rule.cssRules) {
      renameKeyframes(/** @type {CSSGroupingRule} */ (rule).cssRules, suffix, renamed);
    }
  }
}

/**
 * Point every `animation-name` at the renamed keyframes. Reads the longhand, so
 * it catches names set through the `animation` shorthand too.
 * @param {CSSRule} rule - Style rule to fix up, along with any nested rules.
 * @param {Map<string, string>} renamed - Original → new keyframes name.
 */
function remapAnimationNames(rule, renamed) {
  const declarations = 'style' in rule ? /** @type {CSSStyleRule} */ (rule).style : null;
  if (declarations) {
    const names = declarations.getPropertyValue('animation-name');
    if (names) {
      const mapped = names.split(',').map((/** @type {string} */ name) => {
        const trimmed = name.trim();
        return renamed.get(trimmed) || trimmed;
      }).join(', ');
      if (mapped !== names) {
        declarations.setProperty('animation-name', mapped, declarations.getPropertyPriority('animation-name'));
      }
    }
  }
  if ('cssRules' in rule && rule.cssRules) {
    for (const child of Array.from(/** @type {CSSGroupingRule} */ (rule).cssRules)) remapAnimationNames(child, renamed);
  }
}
/**
 * Rewrite a rule list in place so every selector in it is confined to the scope.
 * @param {CSSStyleSheet|CSSGroupingRule} owner - Sheet or grouping rule to rewrite.
 * @param {string} scope - Selector matching the scope element.
 * @param {Map<string, string>} renamed - Original → new keyframes name.
 */
function scopeRuleList(owner, scope, renamed) {
  const rules = owner.cssRules;
  // Backwards: deleting a rule reindexes everything after it.
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = /** @type {CSSRule} */ (rules[i]);
    if (!rule) continue;
    if (cssRuleIs(rule, 'CSSFontFaceRule') || cssRuleIs(rule, 'CSSImportRule')) {
      // Both fetch on the message's behalf, which makes a rendered message a
      // tracking beacon. `@import` is already dropped by replaceSync; this is
      // for `@font-face`, which is not.
      owner.deleteRule(i);
      continue;
    }
    // Keyframe selectors are percentages, not selectors — leave them alone.
    if (cssRuleIs(rule, 'CSSKeyframesRule')) continue;
    if (cssRuleIs(rule, 'CSSStyleRule')) {
      const styleRule = /** @type {CSSStyleRule} */ (rule);
      styleRule.selectorText = splitSelectorList(styleRule.selectorText)
        .map((selector) => scopeOneSelector(selector, scope))
        .join(', ');
      // Nested rules are relative to this one, so they are already scoped by it.
      remapAnimationNames(styleRule, renamed);
      continue;
    }
    // @media / @supports / @layer / @container: scope what they hold.
    if ('cssRules' in rule && rule.cssRules && 'deleteRule' in rule && typeof rule.deleteRule === 'function') {
      scopeRuleList(/** @type {CSSGroupingRule} */ (rule), scope, renamed);
    }
  }
}

/**
 * Confine a message's own CSS to that message.
 *
 * Parsing happens in the browser's CSS engine rather than by regex: a detached
 * stylesheet is inert (it applies to nothing until adopted, and it drops
 * `@import` on the floor), it discards anything it cannot parse, and
 * re-serialising from the CSSOM guarantees the result is balanced — so no
 * arrangement of stray braces can close the scope early and reach the app.
 *
 * Selectors are prefixed rather than wrapped in `@scope`, which is a nicety
 * absent from several engines we run on; a prefix works everywhere and fails
 * closed if it doesn't.
 * @param {string} css - Authored CSS.
 * @param {string} scope - Selector matching the scope element.
 * @param {string} suffix - Suffix making keyframes names unique to this render.
 * @returns {string} Scoped CSS, or "" if the engine can't parse or scope it.
 */
function scopeAuthoredCss(css, scope, suffix) {
  if (!css.trim()) return '';
  try {
    // Parsing in a detached stylesheet: `@import` never resolves, nothing can
    // observe the rules, and a constructable sheet can be fed straight to the
    // CSSOM and re-serialised from it.
    const SheetCtor = globalThis.CSSStyleSheet;
    const sheet = new SheetCtor();
    sheet.replaceSync(css);
    /** @type {Map<string, string>} */
    const renamed = new Map();
    renameKeyframes(sheet.cssRules, suffix, renamed);
    scopeRuleList(sheet, scope, renamed);
    return Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\n');
  } catch (e) {
    // No constructable stylesheets, or the engine refused the rewrite. Dropping
    // the CSS costs the message its styling; letting it through unscoped would
    // cost the app its own.
    console.warn('[Markdown] Dropped unscopable CSS:', e);
    return '';
  }
}

/**
 * Box up authored HTML: lift its `<style>` blocks out, scope them, and put the
 * content inside a contained wrapper the scoped CSS can reach and nothing else
 * can. Called only when the message actually brought CSS, so ordinary markdown
 * renders exactly as it did before.
 * @param {HTMLTemplateElement} tpl - Template holding the sanitised content.
 * @param {Element[]} styleEls - Style elements found in it.
 * @returns {string} The wrapped HTML.
 */
function boxAuthoredHtml(tpl, styleEls) {
  const scopeId = `md${++htmlScopeSeq}`;
  const scopeSelector = `[${HTML_SCOPE_ATTR}="${scopeId}"]`;
  const css = styleEls
    .map((el) => {
      const scoped = scopeAuthoredCss(el.textContent || '', scopeSelector, `-${scopeId}`);
      el.remove();
      return scoped;
    })
    .filter(Boolean)
    .join('\n');

  const box = document.createElement('div');
  box.className = HTML_SCOPE_CLASS;
  if (css) {
    const styleEl = document.createElement('style');
    // A `<style>` is a raw-text element: its content is serialised verbatim, so
    // a closing tag inside the CSS would end the element and everything after it
    // would parse as markup. Escaped as CSS rather than dropped — `\3c ` is a
    // `<` in both a string and a url(), the only places this can legitimately appear.
    styleEl.textContent = css.replace(CLOSING_STYLE_TAG, '\\3c /$1');
    box.appendChild(styleEl);
  }
  const scope = document.createElement('div');
  scope.setAttribute(HTML_SCOPE_ATTR, scopeId);
  scope.appendChild(tpl.content);
  box.appendChild(scope);

  const out = /** @type {HTMLTemplateElement} */ (document.createElement('template'));
  out.content.appendChild(box);
  return out.innerHTML;
}

/**
 * The authoritative HTML sanitiser for rendered markdown. marked (with gfm and
 * inline HTML on) happily emits any raw tag the source text contained, and
 * escapeXmlTagsForMarkdown is only a best-effort *pre*-pass whose naive backtick
 * accounting desyncs from marked's real code-span parsing — so a raw tag can
 * still reach the output string. Since callers drop that string into
 * `innerHTML`, a surviving *custom element* (e.g. `<composer-box>`) is upgraded by
 * the browser into a live component (the "mirror composer in a thread summary"
 * bug). This pass is the real boundary: it parses the HTML into an inert
 * `<template>` (scripts don't run, images don't load, custom elements do NOT
 * upgrade), drops disallowed tags to visible escaped text, strips disallowed and
 * event-handler attributes, then re-serialises. It permits a deliberately small,
 * declarative inline-SVG subset for assistant illustrations; executable SVG and
 * external-resource features remain excluded. Runs last so nothing downstream
 * can reintroduce raw markup.
 *
 * CSS the content brought with it — a `<style>` block or an inline `style` — is
 * kept, but only by being boxed: see {@link boxAuthoredHtml}. A message that
 * illustrates a design gets to look like the design; it does not get to restyle
 * the app around it.
 * @param {string} html - Rendered (and URL-scrubbed) HTML.
 * @returns {string} HTML containing only allowlisted tags and attributes.
 */
function sanitizeRenderedHtml(html) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    // No DOM to parse with. Every real caller runs in a DOM context (renderMarkdown
    // already depends on window.marked + document); this is only a defensive guard.
    return html;
  }
  const tpl = document.createElement('template');
  // Assigning to a <template>'s innerHTML parses into an inert document fragment:
  // custom elements are NOT upgraded and scripts do NOT execute here.
  tpl.innerHTML = html;

  /** @type {Element[]} Style blocks to lift out and scope once the walk is done. */
  const styleEls = [];
  let sawInlineStyle = false;

  /** @param {Node} parent */
  const walk = (parent) => {
    // Snapshot children first — we mutate the tree during iteration.
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === 8 /* COMMENT_NODE */) {
        parent.removeChild(node);
        continue;
      }
      if (node.nodeType !== 1 /* ELEMENT_NODE */) continue;
      const el = /** @type {Element} */ (node);
      const tag = el.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) {
        // Neutralise: replace the element (and its subtree) with its serialised
        // markup as a text node. `<composer-box></composer-box>` becomes visible,
        // inert text (`&lt;composer-box&gt;…`) instead of a live component.
        parent.replaceChild(document.createTextNode(el.outerHTML), el);
        continue;
      }
      if (tag === 'style') {
        // Its content is CSS, not markup, and it is worthless where it stands:
        // hold it for boxAuthoredHtml, which is the only thing that may keep it.
        styleEls.push(el);
        continue;
      }
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        const svgUrl = (name === 'href' || name === 'src') && el.namespaceURI === 'http://www.w3.org/2000/svg';
        if (name.startsWith('on') || svgUrl || !ALLOWED_ATTRS.has(name)) {
          el.removeAttribute(attr.name);
        } else if (name === 'style') {
          sawInlineStyle = true;
        }
      }
      walk(el);
    }
  };
  walk(tpl.content);
  if (!styleEls.length && !sawInlineStyle) return tpl.innerHTML;
  return boxAuthoredHtml(tpl, styleEls);
}

/**
 * Build the tick box: an outer box element and an inner mark, so a theme can
 * retint the box and the glyph independently (a single element can only carry
 * one `mask`). Mirrors the `.option-tick` / `.icon-check` pairing used for
 * AskUserQuestion's options.
 * @param {string} state - One of the values in {@link TASK_STATES}.
 * @returns {HTMLElement} The box element.
 */
function taskBoxElement(state) {
  const box = document.createElement('span');
  box.className = `tick-box task-box task-box--${state}`;
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', TASK_LABELS[state] || state);
  const mark = document.createElement('span');
  mark.className = 'tick-box-mark task-box-mark';
  box.appendChild(mark);
  return box;
}

/**
 * Replace task-list markers with tick boxes, for the three states GFM has no
 * syntax for as well as the two it does.
 *
 * marked hard-codes `/^\[[ xX]\] /` and emits an `<input type="checkbox">` for a
 * match, so `[ ]` and `[x]` arrive here as that input while `[/]`, `[!]` and
 * `[-]` arrive as the literal text marked declined to claim. Both shapes are
 * normalised to the same markup.
 *
 * Runs AFTER {@link sanitizeRenderedHtml} deliberately. The boxes carry `role`
 * and `aria-label`, which the allowlist does not permit — and widening the
 * allowlist would grant those attributes to every element in every piece of
 * rendered markdown, where they are an AT-spoofing surface. Adding them here
 * instead keeps that blast radius at zero: this pass reads no untrusted input,
 * builds from a closed vocabulary of five states, and only ever removes an
 * input or strips a leading marker from already-sanitised text.
 *
 * Authored-HTML boxes are off limits: an `<input type="checkbox">` inside one is
 * preview markup the message drew on purpose (see boxAuthoredHtml), not a task
 * marker to swap for our own.
 * @param {string} html - Sanitised HTML from {@link sanitizeRenderedHtml}.
 * @returns {string} HTML with task markers replaced by tick boxes.
 */
function decorateTaskLists(html) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return html;
  }
  if (!html.includes('[') && !html.includes('type="checkbox"')) return html;

  const tpl = document.createElement('template');
  tpl.innerHTML = html;

  for (const li of Array.from(tpl.content.querySelectorAll('li'))) {
    if (li.closest(`.${HTML_SCOPE_CLASS}`)) continue;
    // A loose list wraps each item's content in a <p>; a tight one leaves the
    // text directly on the <li>. The marker lives at the start of whichever it is.
    const firstEl = li.firstElementChild;
    const host = firstEl && firstEl.tagName === 'P' ? firstEl : li;
    const first = host.firstChild;
    if (!first) continue;

    /** @type {string|undefined} */
    let state;

    if (first.nodeType === 1 /* ELEMENT_NODE */
        && /** @type {Element} */ (first).tagName === 'INPUT'
        && /** @type {Element} */ (first).getAttribute('type') === 'checkbox') {
      state = /** @type {Element} */ (first).hasAttribute('checked') ? 'completed' : 'pending';
      host.removeChild(first);
      // marked writes a space between the checkbox and the text; it would now
      // sit inside the item's leading edge.
      const next = host.firstChild;
      if (next && next.nodeType === 3 /* TEXT_NODE */) {
        next.nodeValue = (next.nodeValue || '').replace(/^[ \t]+/, '');
      }
    } else if (first.nodeType === 3 /* TEXT_NODE */) {
      const match = TASK_MARKER_RE.exec(first.nodeValue || '');
      const marker = match?.[1];
      if (match && marker) {
        state = TASK_STATES.get(marker);
        if (state) first.nodeValue = (first.nodeValue || '').slice(match[0].length);
      }
    }

    if (!state) continue;

    host.insertBefore(taskBoxElement(state), host.firstChild);
    // GitHub's own class names for the same construct.
    li.classList.add('task-list-item', `task-list-item--${state}`);
    li.parentElement?.classList.add('contains-task-list');
  }

  return tpl.innerHTML;
}

/**
 * Attribute carrying a quote's markdown source, for its copy button. It is not
 * in {@link ALLOWED_ATTRS}, so the sanitiser strips it from anything a message
 * authored: only {@link attachQuoteSources} can set it, and a quote cannot be
 * made to copy something other than what the message's markdown said.
 */
const QUOTE_SOURCE_ATTR = 'data-markdown-source';

/**
 * The render in progress, while `marked.parse` runs inside renderMarkdown:
 * the quote sources it has seen, and the per-render class that tags their
 * `<blockquote>`s for {@link attachQuoteSources}. Null at any other time, which
 * leaves marked's own blockquote rendering in charge.
 * @type {{ tag: string, sources: string[] } | null}
 */
let quoteRender = null;

/**
 * What a marked renderer override sees as `this`: the parser it can hand child
 * tokens back to.
 * @typedef {object} MarkedRendererContext
 * @property {{parse: (tokens: object[]) => string}} parser - Renders a token list
 */

/**
 * The parts of the global `marked` (loaded by script tag) this module uses.
 * @typedef {object} MarkedLib
 * @property {(src: string) => string} parse - Render markdown to HTML
 * @property {(options: {breaks?: boolean, gfm?: boolean}) => void} setOptions - Set parse options
 * @property {(extension: {renderer: {blockquote: (this: MarkedRendererContext, token: {text: string, tokens: object[]}) => string|false}}) => void} use - Install renderer overrides
 */

/** The marked instances {@link installQuoteRenderer} has already extended. */
const quoteRendererInstalled = new WeakSet();

/**
 * Teach marked to record each quote's source as it renders it. The `<blockquote>`
 * is tagged with a class unique to this render rather than given the source
 * directly: the class survives the sanitiser, and a message cannot guess it, so
 * the pass after the sanitiser knows every tagged quote came from markdown.
 * @param {MarkedLib} marked - The global marked instance.
 */
function installQuoteRenderer(marked) {
  if (quoteRendererInstalled.has(marked)) return;
  quoteRendererInstalled.add(marked);
  marked.use({
    renderer: {
      /**
       * @this {MarkedRendererContext}
       * @param {{ text: string, tokens: object[] }} token - marked's blockquote token;
       *   `text` is its source with one level of `>` markers removed.
       * @returns {string|false} The quote's HTML, or false for marked's default.
       */
      blockquote(token) {
        if (!quoteRender) return false;
        const index = quoteRender.sources.push(token.text.replace(/\s+$/, '')) - 1;
        return `<blockquote class="${quoteRender.tag}-${index}">\n${this.parser.parse(token.tokens)}</blockquote>\n`;
      },
    },
  });
}

/**
 * Swap the per-render tags {@link installQuoteRenderer} put on quotes for their
 * markdown source. Runs on sanitised HTML and reads only sources marked handed
 * over, so it is as safe on this side of the boundary as decorateTaskLists.
 * @param {string} html - Sanitised HTML.
 * @param {{ tag: string, sources: string[] }} render - The render's quote record.
 * @returns {string} HTML whose markdown quotes carry {@link QUOTE_SOURCE_ATTR}.
 */
function attachQuoteSources(html, render) {
  if (!render.sources.length || typeof document === 'undefined') return html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const prefix = `${render.tag}-`;
  for (const quote of Array.from(tpl.content.querySelectorAll('blockquote'))) {
    const tagClass = Array.from(quote.classList).find((name) => name.startsWith(prefix));
    if (!tagClass) continue;
    quote.classList.remove(tagClass);
    if (!quote.classList.length) quote.removeAttribute('class');
    const source = render.sources[Number(tagClass.slice(prefix.length))];
    if (source !== undefined) quote.setAttribute(QUOTE_SOURCE_ATTR, source);
  }
  return tpl.innerHTML;
}

/**
 * A class name no message can have written in advance.
 * @returns {string} `mdq-` and 16 random hex digits.
 */
function quoteRenderTag() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return `mdq-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Render markdown with syntax highlighting and safe XML handling
 * @param {string} content - Markdown content to render
 * @param {object} [options] - Rendering options
 * @param {boolean} [options.escapeXml=true] - Whether to escape XML tags outside code blocks
 * @returns {string} Rendered HTML
 */
export function renderMarkdown(content, options = {}) {
  const { escapeXml = true } = options;

  const marked = /** @type {{marked?: MarkedLib}} */ (/** @type {unknown} */ (window)).marked;

  if (!marked) {
    console.warn('[Markdown] marked.js not available, falling back to plain text');
    const div = document.createElement('div');
    div.textContent = content;
    return div.innerHTML;
  }

  try {
    // Pre-process: escape XML tags if enabled, and keep any <style> block from
    // being cut in half by markdown's blank-line HTML-block boundary.
    const processedContent = keepStyleBlocksIntact(escapeXml ? escapeXmlTagsForMarkdown(content) : content);

    marked.setOptions({
      breaks: true,
      gfm: true
    });

    // Parse markdown, then strip dangerous URL schemes from the result.
    // marked.js does not filter javascript: / vbscript: / data: hrefs by
    // default, so a link like [click](javascript:alert(1)) would render
    // as a live XSS sink. Belt-and-braces neutralisation post-parse:
    installQuoteRenderer(marked);
    const render = { tag: quoteRenderTag(), sources: /** @type {string[]} */ ([]) };
    quoteRender = render;
    let raw;
    try {
      raw = marked.parse(processedContent);
    } finally {
      quoteRender = null;
    }
    // Sanitise LAST among the passes that handle marked's output:
    // neutraliseDangerousUrls/externalizeLinks are string passes that scrub
    // URLs; sanitizeRenderedHtml is the authoritative tag/attribute boundary
    // that strips any raw markup (custom elements, script, stray HTML) marked
    // emitted, so nothing unsafe reaches the caller's innerHTML.
    const safe = sanitizeRenderedHtml(externalizeLinks(neutraliseDangerousUrls(raw)));
    // Then swap task markers for tick boxes. This one runs on the far side of
    // the boundary on purpose — see decorateTaskLists: it consumes no untrusted
    // input, so it can add the `role`/`aria-label` the allowlist withholds
    // without granting them to every other element in the document.
    // And give each markdown quote its source, for its copy button — on this
    // side of the boundary for the same reason (see QUOTE_SOURCE_ATTR).
    return attachQuoteSources(decorateTaskLists(safe), render);
  } catch (e) {
    console.error('[Markdown] Parsing error:', e);
    // Fall back to escaped content
    const div = document.createElement('div');
    div.textContent = content;
    return div.innerHTML;
  }
}

/** @type {RegExp[]} Markdown-construct detectors used by {@link looksLikeMarkdown}. */
const MARKDOWN_PATTERNS = [
  /(^|\n)[ \t]{0,3}#{1,6}[ \t]+\S/, //            ATX heading (# .. ######)
  /(^|\n)[ \t]{0,3}[-*+][ \t]+\S/, //             bullet list item
  /(^|\n)[ \t]{0,3}\d+[.)][ \t]+\S/, //           ordered list item
  /(^|\n)[ \t]{0,3}>[ \t]+\S/, //                 blockquote
  /(^|\n)[ \t]{0,3}(```|~~~)/, //                 fenced code block
  /(^|\n)[ \t]{0,3}(\*[ \t]*){3,}(\n|$)/, //      thematic break ***
  /(^|\n)[ \t]{0,3}(-[ \t]*){3,}(\n|$)/, //       thematic break ---
  /(^|\n)[ \t]{0,3}(_[ \t]*){3,}(\n|$)/, //       thematic break ___
  /`[^`\n]+`/, //                                 inline code
  /!?\[[^\]\n]*\]\([^)\n]+\)/, //                 link or image
  /\*\*[^\s*][^*]*\*\*/, //                        bold  **...**
  /(^|[^\w_])__[^\s_][^_]*__(?![\w_])/, //         bold  __...__ (word-boundary)
  /~~[^\s~][^~]*~~/, //                            strikethrough  ~~...~~
  /(^|[^\w*])\*[^\s*][^*\n]*\*(?![\w])/, //        italic *...* (not a lone/space *)
  /(^|[^\w_])_[^\s_][^_\n]*_(?![\w])/, //          italic _..._ (intraword _ excluded)
  /(^|\n)\|.*\|.*\n[ \t]*\|?[ \t:|-]*-{3,}/, //    table (header + separator row)
];

/**
 * Conservative test for whether a string contains Markdown worth rendering —
 * used to decide whether untrusted, human-authored text (e.g. a user message
 * bubble) should go through the Markdown renderer at all, or be shown verbatim.
 * Ordinary prose, snake_case identifiers, a lone `*`, or a pasted stack trace
 * return false, so they are not reflowed into the sans font or reinterpreted as
 * formatting.
 *
 * The patterns mirror the constructs the renderer acts on, and are
 * boundary-aware where a naive match would fire on plain text: intraword `_` is
 * literal in Markdown, so `foo_bar_baz` does not count; `*`/`_` emphasis
 * requires a non-space right after the opening marker, so `2 * 3` and `a > b`
 * do not count.
 * @param {string} text - Raw source to test.
 * @returns {boolean} True if the source contains a Markdown construct.
 */
export function looksLikeMarkdown(text) {
  if (!text) return false;
  return MARKDOWN_PATTERNS.some((re) => re.test(text));
}

/**
 * Largest fenced block we syntax-highlight. Tokenising is linear in the source,
 * but a pathological block — a pasted minified bundle — costs more than the
 * colour is worth, and it reads perfectly well as plain text.
 */
const MAX_HIGHLIGHT_CHARS = 100_000;

/**
 * Syntax-highlight one rendered fenced block, in place.
 *
 * This runs on the safe side of the sanitiser: the source is read back out of
 * the DOM as text (so whatever `marked` emitted has already been through
 * {@link sanitizeRenderedHtml}) and `highlightCode` escapes everything it does
 * not tokenise. Nothing attacker-controlled can reach `innerHTML` here, which is
 * why this is a DOM pass rather than a `marked` renderer override — the trust
 * boundary stays where it was.
 * @param {HTMLElement} pre - A rendered `<pre>` from the markdown renderer.
 */
function highlightFencedBlock(pre) {
  const code = pre.querySelector('code');
  // `data-highlighted` keeps a re-decorate — streaming re-renders the live tail
  // on every delta — from tokenising a block that is already coloured.
  if (!code || code.dataset.highlighted === 'true') return;

  const fenced = Array.from(code.classList)
    .find((name) => name.startsWith('language-'))?.slice('language-'.length) || '';
  const language = normalizeLanguageId(fenced);
  // A fence with no language, or one that says plain text, is left alone: it is
  // as likely to be output or prose as it is to be code.
  if (!fenced || language === 'text') return;

  const source = code.textContent || '';
  if (!source || source.length > MAX_HIGHLIGHT_CHARS) return;

  code.innerHTML = highlightCode(source, language);
  code.dataset.highlighted = 'true';
}

/**
 * Post-process a freshly-rendered markdown element: syntax-highlight every
 * fenced code block, add our standard copy-to-clipboard button to every `<pre>`
 * and to every outermost `<blockquote>`, and wrap every `<table>` in a
 * horizontal-scroll container so a table wider than the panel can be scrolled
 * instead of silently spilling off the edge.
 *
 * `renderMarkdown` returns an HTML string, so it cannot wire up live buttons or
 * wrappers; callers that insert that HTML into the DOM call this on the
 * container afterwards. Each `<pre>` is wrapped in a non-scrolling positioning
 * context (`.code-block-wrap`) so the button stays pinned to the visible corner
 * even when the code scrolls horizontally. Each `<table>` is wrapped in a
 * `.table-scroll-wrap` (a `<table>` ignores `overflow`, so it needs a block
 * ancestor to scroll). A `<blockquote>` does not scroll, so its button goes
 * straight inside it. Idempotent: an element already inside its wrapper, already
 * highlighted or already holding its button is skipped, so re-running on the
 * same subtree is a no-op.
 * @param {HTMLElement|null|undefined} root - Container holding rendered markdown.
 * @param {object} [options] - Decoration options.
 * @param {boolean} [options.highlight=true] - Syntax-highlight fenced blocks.
 *   Pass false for text still being streamed: a fence that is still arriving
 *   would be re-tokenised on every delta, for tokens that are wrong until it
 *   closes. The caller highlights once the text settles.
 */
export function decorateCodeBlocks(root, options = {}) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const { highlight = true } = options;

  root.querySelectorAll('pre').forEach((pre) => {
    if (highlight) highlightFencedBlock(/** @type {HTMLElement} */ (pre));

    // Skip a <pre> we've already wrapped (e.g. on a redundant re-decorate).
    if (pre.parentElement?.classList.contains('code-block-wrap')) return;

    const wrap = document.createElement('div');
    wrap.className = 'code-block-wrap';
    pre.parentNode?.insertBefore(wrap, pre);
    wrap.appendChild(pre);

    const codeEl = pre.querySelector('code');
    wrap.appendChild(createCopyButton(
      () => (codeEl || pre).textContent || '',
      'code-copy-button'
    ));
  });

  root.querySelectorAll('blockquote').forEach((quote) => {
    // One button per quote: a nested quote is copied with the one around it,
    // and a quote that already has its button is left alone.
    if (quote.parentElement?.closest('blockquote')) return;
    if (quote.querySelector(':scope > .quote-copy-button')) return;

    // A markdown quote copies its source, minus the `>` markers. One a message
    // wrote as raw HTML has no source, so it copies its text: `innerText` keeps
    // the paragraph breaks `textContent` would run together, and the button
    // holds only an icon, so it adds nothing to it.
    quote.appendChild(createCopyButton(
      () => quote.getAttribute(QUOTE_SOURCE_ATTR)
        ?? (/** @type {HTMLElement} */ (quote).innerText || quote.textContent || '').trim(),
      'code-copy-button quote-copy-button'
    ));
  });

  root.querySelectorAll('table').forEach((table) => {
    // Skip a <table> we've already wrapped (e.g. on a redundant re-decorate).
    if (table.parentElement?.classList.contains('table-scroll-wrap')) return;

    const wrap = document.createElement('div');
    wrap.className = 'table-scroll-wrap';
    table.parentNode?.insertBefore(wrap, table);
    wrap.appendChild(table);
  });
}

/**
 * Render markdown and wrap in a div with markdown class
 * @param {string} content - Markdown content to render
 * @param {object} [options] - Rendering options
 * @param {boolean} [options.escapeXml=true] - Whether to escape XML tags outside code blocks
 * @returns {string} Rendered HTML wrapped in div.markdown
 */
export function renderMarkdownWrapped(content, options = {}) {
  const html = renderMarkdown(content, options);
  return `<div class="markdown">${html}</div>`;
}

/**
 * Render an assistant reply as Markdown with allowlisted inline HTML enabled.
 * The standard post-parse sanitizer still removes unsafe elements, attributes,
 * and URL schemes before callers assign the result to `innerHTML`.
 * @param {string} content - Assistant-authored Markdown and/or HTML.
 * @returns {string} Sanitized rendered HTML.
 */
export function renderAssistantContent(content) {
  return renderMarkdown(content, { escapeXml: false });
}

/**
 * Render an assistant reply with the standard Markdown wrapper.
 * @param {string} content - Assistant-authored Markdown and/or HTML.
 * @returns {string} Sanitized rendered HTML wrapped in `div.markdown`.
 */
export function renderAssistantContentWrapped(content) {
  return `<div class="markdown">${renderAssistantContent(content)}</div>`;
}
