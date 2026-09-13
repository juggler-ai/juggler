//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Incremental renderer for text that arrives by growing.
 *
 * Rendering a stream by re-parsing the whole accumulated string on each update
 * costs O(length) per update, which over a block that arrives in many updates
 * is quadratic — the reason a long reasoning block used to make the UI stutter
 * for as long as it took to arrive. This splits the text at Markdown block
 * boundaries instead: everything before the last boundary is SEALED (parsed
 * once, then left alone in the DOM) and only the tail after it is re-parsed as
 * it grows. Each update then costs O(tail), and a tail is one paragraph.
 *
 * A boundary is only taken where appending more text cannot change what has
 * already been rendered: a blank line, outside any open fence and any open raw
 * HTML element, whose preceding block is not one that more text could continue
 * (a list, a blockquote, a table, an indented code block). Text with no such
 * boundary — one very long unbroken paragraph, or an SVG still arriving —
 * simply never seals, and degrades to re-parsing the whole thing, exactly as
 * before. Link reference definitions reach backwards (a `[x]: url` line can
 * change a link rendered paragraphs earlier), so the first one seen turns
 * sealing off for the rest of the stream.
 *
 * Each segment is parsed on its own, so a boundary inside raw HTML is not a
 * split that a later segment can heal: the parser closes whatever the first
 * segment left open, and the children in the second land outside it.
 *
 * The text is assumed to only ever GROW at the end. A rewrite of the sealed
 * prefix is detected by fingerprint and answered with a full re-render.
 *
 * Syntax highlighting follows the same split. Anything parsed once and left
 * alone — a sealed segment, or a whole message rendered from history — is
 * coloured as it is parsed. The live tail is not: a fence that is still arriving
 * would be re-tokenised on every delta, for tokens that are wrong until it
 * closes. The tail is coloured once the text stops growing (see SETTLE_MS),
 * which is also what covers a code block at the very end of a reply, where
 * nothing follows it to seal it.
 * @module utils/streaming-markdown
 */

import { renderMarkdown, looksLikeMarkdown, decorateCodeBlocks } from '../../sdk/lib/markdown.js';

/** Opens or closes a fenced code block; the capture is the fence marker. */
const FENCE_RE = /^ {0,3}(```|~~~)/;

/**
 * A block that a blank line does NOT necessarily end: another list item,
 * quote line, table row or indented code line after the blank continues the
 * same construct, and sealing between them would split it in two.
 */
const CONTINUABLE_RE = /^ {0,3}(?:[-*+]|\d+[.)])[ \t]|^ {0,3}>|^ {0,3}\||^(?:\t| {4,})\S/;

/** A link reference definition, whose effect reaches back over the whole document. */
const REF_DEF_RE = /^ {0,3}\[[^\]\n]+\]:/;

/** The start of a `<style>` block, whose CSS reaches the markup around it. */
const STYLE_OPEN_RE = /<style\b/i;

/** A tag, as it appears on a line of the raw HTML a reply writes for itself. */
const TAG_RE = /<(\/?)([a-zA-Z][-\w]*)(?:\s[^>]*?)?(\/?)>/g;

/** Elements written without a closing tag, which therefore hold nothing open. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source',
  'track', 'wbr',
]);

/**
 * How many raw-HTML elements are still open after `line`.
 *
 * Only lines that BEGIN with a tag are counted, so a paragraph mentioning
 * `<div>` in passing — or naming one in a backtick span, which this scan is too
 * early to know about — leaves the count alone. A block is only allowed to open
 * at up to three spaces of indentation, matching where CommonMark will read one;
 * deeper than that with nothing open is an indented code block, whose tags are
 * text. Inside an element that is already open, indentation means nothing and
 * every line counts.
 * @param {string} line - One line of the text, without its newline.
 * @param {number} depth - Elements open before it.
 * @returns {number} Elements open after it.
 */
function htmlDepthAfter(line, depth) {
  const body = line.trimStart();
  if (!body.startsWith('<')) return depth;
  if (depth === 0 && line.length - body.length > 3) return depth;

  let open = depth;
  for (const [, closing, name, selfClosing] of body.matchAll(TAG_RE)) {
    if (selfClosing || VOID_ELEMENTS.has((name || '').toLowerCase())) continue;
    // Floor at zero: a stray closing tag is the reply's mistake to make, not a
    // reason for this to start counting backwards.
    open = closing ? Math.max(0, open - 1) : open + 1;
  }
  return open;
}

/** Characters of already-sealed text kept to detect a rewritten prefix. */
const FINGERPRINT_LEN = 64;

/**
 * Characters re-tested for Markdown constructs behind the newly arrived text.
 * A construct can straddle the join (a table is a header line plus a separator
 * line), so the detector never starts exactly where the last one stopped.
 */
const DETECT_OVERLAP = 512;

/**
 * Quiet period after which the live tail is syntax-highlighted. Deltas arrive
 * far faster than this while a reply streams, so in practice the pass runs once,
 * when the text stops growing; a provider that stalls mid-block pays for one
 * extra pass, which is idempotent.
 */
const SETTLE_MS = 250;

/**
 * Whether `text` stops inside an unclosed fenced code block.
 *
 * Only ever asked of text about to be rendered whole, to tell a reply that has
 * finished arriving from one caught mid-block: the first is worth colouring
 * immediately, the second would be coloured on tokens that are still wrong.
 * @param {string} text - The full accumulated text.
 * @returns {boolean} True when a fence is still open at the end of the text.
 */
function endsInsideFence(text) {
  /** The marker that opened the fence we are inside, or '' when outside one. */
  let fence = '';
  for (const line of text.split('\n')) {
    const opener = FENCE_RE.exec(line)?.[1];
    if (opener && (!fence || opener === fence)) fence = fence ? '' : opener;
  }
  return fence !== '';
}

/**
 * The end of the longest prefix of `text` that can be parsed now and never
 * revisited, searching from `from` (which must be at a line start).
 * @param {string} text - The full accumulated text.
 * @param {number} from - Index to scan from; everything before it is sealed.
 * @returns {{seal: number, nonLocal: boolean}} New seal point (>= from), and
 *   whether the scanned region held a construct whose effect reaches outside
 *   the segment it sits in — a link reference definition, or a `<style>` block.
 */
export function findSealPoint(text, from) {
  /** The marker that opened the fence we are inside, or '' when outside one. */
  let fence = '';
  let nonLocal = false;
  let seal = from;
  let lastContentLine = '';
  let i = from;
  // Raw-HTML elements still open. Starts at zero on every scan because a seal is
  // only ever taken where nothing is open, so `from` is always such a point.
  let htmlDepth = 0;

  while (i < text.length) {
    const nl = text.indexOf('\n', i);
    // A line with no newline yet is still arriving, so it can never be sealed.
    if (nl === -1) break;
    const line = text.slice(i, nl);
    i = nl + 1;

    const opener = FENCE_RE.exec(line)?.[1];
    // Only the marker that opened a fence can close it, so a ~~~ inside a ```
    // block doesn't hand us a seal point in the middle of the code.
    if (opener && (!fence || opener === fence)) {
      fence = fence ? '' : opener;
      lastContentLine = line;
      continue;
    }
    if (fence) continue;
    if (REF_DEF_RE.test(line)) nonLocal = true;
    // Authored CSS is scoped to a box minted per parse, so a <style> sealed
    // away from the markup it names is scoped to a box that markup is not in,
    // and styles nothing. Same test as the depth count: a line that starts with
    // a tag, so prose naming the element is left alone.
    if (line.trimStart().startsWith('<') && STYLE_OPEN_RE.test(line)) nonLocal = true;
    htmlDepth = htmlDepthAfter(line, htmlDepth);

    if (line.trim() === '') {
      // A blank line inside an open element is a blank line between an SVG's
      // shapes or a card's paragraphs. Sealing there would parse the opening tag
      // as a fragment of its own — where the parser closes it — and drop every
      // child that arrives afterwards into a second fragment, outside the
      // element they belong to.
      if (!htmlDepth && lastContentLine && !CONTINUABLE_RE.test(lastContentLine)) seal = i;
    } else {
      lastContentLine = line;
    }
  }

  return { seal, nonLocal };
}

/**
 * Render growing text into `host`, re-parsing only what is still in flight.
 *
 * `host`'s class is set to `markdown` or `plain` per update: reasoning arrives
 * either as a Markdown summary or as raw prose, and prose rendered as Markdown
 * loses its stray `*`/`_`/`#` to formatting. The decision is re-made as the
 * text grows (so a block whose first construct arrives late switches then) but
 * never reverses, because append-only text cannot lose a construct it has.
 * @param {HTMLElement} host - Element to render into. Owned entirely by this.
 * @param {object} [options] - Rendering options.
 * @param {boolean} [options.escapeXml=true] - Passed to renderMarkdown.
 * @param {boolean} [options.detect=true] - Choose between Markdown and verbatim
 *   per update. False renders as Markdown always, for a source that is known to
 *   be Markdown (an assistant reply) rather than possibly raw prose.
 * @returns {{update: (text: string) => void, reset: () => void, settle: () => void}}
 *   Controller. `settle` highlights the live tail immediately; it is armed
 *   automatically on a quiet period, so callers rarely need to call it.
 */
export function createStreamingMarkdown(host, options = {}) {
  const { escapeXml = true, detect = true } = options;

  /** @type {'markdown'|'plain'|null} */
  let mode = null;
  /** Index in the text up to which the DOM is sealed. */
  let sealedUpTo = 0;
  /** Tail of the sealed text, to catch a prefix that was rewritten. */
  let fingerprint = '';
  /** Set once a construct reaching beyond its segment is seen; sealing stops for good. */
  let nonLocalSeen = false;
  /** Marker separating the sealed nodes from the re-parsed tail. */
  /** @type {Comment|null} */
  let marker = null;
  /** How much of the text the Markdown detector has already looked at. */
  let detectedUpTo = 0;
  /** Pending settle pass, re-armed by each update. */
  let settleTimer = 0;

  const disarmSettle = () => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = 0;
  };

  /**
   * Colour what is still live. Sealed nodes were coloured as they were sealed;
   * this catches the tail — above all a fenced block at the very end of a reply,
   * which never seals because nothing follows it. Idempotent, since
   * decorateCodeBlocks leaves a block it has already coloured alone.
   */
  const settle = () => {
    disarmSettle();
    if (mode === 'markdown') decorateCodeBlocks(host, { highlight: true });
  };

  /** Push the settle pass out past the next delta. */
  const armSettle = () => {
    disarmSettle();
    settleTimer = setTimeout(settle, SETTLE_MS);
  };

  const reset = () => {
    mode = null;
    sealedUpTo = 0;
    fingerprint = '';
    nonLocalSeen = false;
    marker = null;
    detectedUpTo = 0;
    disarmSettle();
    host.replaceChildren();
  };

  /**
   * Whether the text contains a Markdown construct, testing only what has
   * newly arrived once the answer so far is "no". Latches on.
   * @param {string} text - The full accumulated text.
   * @returns {boolean} True once a construct has appeared.
   */
  const isMarkdown = (text) => {
    if (!detect || mode === 'markdown') return true;
    // Start at a line start, or a pattern anchored to `^` would match the
    // middle of a line the last pass already cleared.
    const back = Math.max(0, detectedUpTo - DETECT_OVERLAP);
    const from = back === 0 ? 0 : text.lastIndexOf('\n', back) + 1;
    detectedUpTo = text.length;
    return looksLikeMarkdown(text.slice(from));
  };

  /**
   * Parse a segment and hand back its nodes, already decorated, in a detached
   * holder. Decorating before insertion keeps the pass proportional to the new
   * segment rather than to everything rendered so far.
   * @param {string} md - Markdown source for one or more whole blocks.
   * @param {boolean} highlight - Syntax-highlight this segment's code blocks.
   *   True for text that will not be parsed again — a sealed segment, or a whole
   *   message rendered from history, which is the shape of every reply already
   *   on screen when a conversation opens.
   * @returns {HTMLElement} Holder whose children are the rendered nodes.
   */
  const parse = (md, highlight) => {
    const holder = document.createElement('div');
    holder.innerHTML = renderMarkdown(md, { escapeXml });
    decorateCodeBlocks(holder, { highlight });
    return holder;
  };

  /**
   * @param {HTMLElement} holder - Holder from parse().
   * @param {Node|null} before - Insert before this node, or append at the end.
   */
  const moveInto = (holder, before) => {
    while (holder.firstChild) host.insertBefore(holder.firstChild, before);
  };

  /** @param {string} text - Full text; renders it from scratch as Markdown. */
  const renderWhole = (text) => {
    host.replaceChildren();
    marker = document.createComment('live');
    host.appendChild(marker);
    // The one place the tail is worth colouring up front: a reply restored from
    // history renders here exactly once, and waiting out the settle pass would
    // show every code block in the conversation uncoloured first. Text stopping
    // inside an open fence is a reply still arriving, so it waits.
    moveInto(parse(text, !endsInsideFence(text)), null);
    sealedUpTo = 0;
    fingerprint = '';
  };

  /** @param {string} text - Full text; shown verbatim, appending the delta. */
  const renderPlain = (text) => {
    const first = host.firstChild;
    if (mode === 'plain' && first && first.nodeType === Node.TEXT_NODE && host.childNodes.length === 1) {
      const existing = /** @type {Text} */ (first);
      if (text.startsWith(existing.data)) {
        existing.appendData(text.slice(existing.data.length));
        return;
      }
    }
    host.replaceChildren(document.createTextNode(text));
  };

  return {
    reset,
    settle,

    /** @param {string} text - The full accumulated text, so far. */
    update(text) {
      const wantMarkdown = isMarkdown(text);
      const wantMode = wantMarkdown ? 'markdown' : 'plain';

      if (wantMode === 'plain') {
        renderPlain(text);
        mode = 'plain';
        host.className = 'plain';
        disarmSettle();
        return;
      }

      // Entering Markdown mode (from nothing, or from verbatim prose) starts
      // the sealed/live split over.
      const restart = mode !== 'markdown' || !marker
        || text.length < sealedUpTo
        || text.slice(sealedUpTo - fingerprint.length, sealedUpTo) !== fingerprint;

      mode = 'markdown';
      host.className = 'markdown';

      if (restart) {
        renderWhole(text);
        armSettle();
        return;
      }

      const live = /** @type {Comment} */ (marker);
      while (live.nextSibling) live.nextSibling.remove();

      if (!nonLocalSeen) {
        const { seal, nonLocal } = findSealPoint(text, sealedUpTo);
        if (nonLocal) {
          // A definition can retarget a link rendered long before it, and a
          // <style> block styles markup on both sides of it, so what was sealed
          // may now be wrong: re-parse the lot, and stop sealing.
          nonLocalSeen = true;
          renderWhole(text);
          armSettle();
          return;
        }
        if (seal > sealedUpTo) {
          moveInto(parse(text.slice(sealedUpTo, seal), true), live);
          sealedUpTo = seal;
          fingerprint = text.slice(Math.max(0, seal - FINGERPRINT_LEN), seal);
        }
      }

      moveInto(parse(text.slice(sealedUpTo), false), null);
      armSettle();
    },
  };
}
