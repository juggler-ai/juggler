//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * ANSI terminal-output renderer.
 *
 * Command output (bash, etc.) can contain ANSI escape sequences — SGR colour
 * codes, cursor moves, OSC strings. Rendered with `.textContent` they show up
 * as literal garbage (`\x1b[31m`). This module turns the SGR colour/style
 * subset into styled DOM spans and drops the non-display escapes so the
 * properties panel shows colours the way a terminal would.
 *
 * Colours resolve to `--ansi-fg-*` / `--ansi-bg-*` CSS custom properties: the
 * foregrounds and the two `default` roles per theme in
 * tokens/theme-{dark,light}.css, the sixteen background fills once in
 * tokens/scale.css, being vivid enough for either theme. So the palette stays
 * theme-aware and a colour reads correctly whether it paints text or a
 * background. 256-colour and 24-bit truecolor escapes resolve to literal
 * `rgb()` values.
 * @module utils/ansi
 */

const ESC = '\x1b';

/** Standard ANSI colour names, indexed 0-7 (SGR 30-37 / 40-47). */
const COLOR_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

/**
 * Resolve an internal colour descriptor to a CSS colour string.
 *
 * Named colours resolve to a role-specific custom property: `--ansi-fg-*` when
 * painting text, `--ansi-bg-*` when painting a background. The two palettes
 * differ in light theme — foregrounds are darkened to read on the light panel,
 * backgrounds stay vivid so the author's paired foreground (e.g. black on a
 * yellow highlight) reads on them.
 * @param {null | {kind: 'named', index: number, bright: boolean} | {kind: 'rgb', value: string}} color
 * @param {'fg'|'bg'} role - Whether the colour paints text or a background
 * @returns {string|null} CSS colour, or null for "default / inherit"
 */
function resolveColor(color, role) {
  if (!color) return null;
  if (color.kind === 'rgb') return color.value;
  const name = COLOR_NAMES[color.index];
  return `var(--ansi-${role}-${color.bright ? 'bright-' : ''}${name})`;
}

/**
 * Map an xterm 256-colour palette index to a colour descriptor.
 *  - 0-7   standard, 8-15 bright (named, theme-aware)
 *  - 16-231 the 6×6×6 colour cube
 *  - 232-255 the 24-step grayscale ramp
 * @param {number} n - Palette index (0-255)
 * @returns {{kind: 'named', index: number, bright: boolean} | {kind: 'rgb', value: string}} Colour descriptor for the index
 */
function color256(n) {
  if (n < 8) return { kind: 'named', index: n, bright: false };
  if (n < 16) return { kind: 'named', index: n - 8, bright: true };
  if (n < 232) {
    const c = n - 16;
    const r = Math.floor(c / 36);
    const g = Math.floor((c % 36) / 6);
    const b = c % 6;
    const v = (/** @type {number} */ x) => (x === 0 ? 0 : x * 40 + 55);
    return { kind: 'rgb', value: `rgb(${v(r)} ${v(g)} ${v(b)})` };
  }
  const gray = (n - 232) * 10 + 8;
  return { kind: 'rgb', value: `rgb(${gray} ${gray} ${gray})` };
}

/** @typedef {null | {kind: 'named', index: number, bright: boolean} | {kind: 'rgb', value: string}} AnsiColor */

/** @returns {{fg: AnsiColor, bg: AnsiColor, bold: boolean, dim: boolean, italic: boolean, underline: boolean, inverse: boolean, strike: boolean}} Fresh default style state */
function freshState() {
  return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false };
}

/**
 * Apply one SGR escape's numeric parameters to the running style state.
 * @param {ReturnType<typeof freshState>} state - Mutated in place
 * @param {number[]} params - SGR parameters (empty == [0], a reset)
 */
function applySgr(state, params) {
  const codes = params.length === 0 ? [0] : params;
  for (let i = 0; i < codes.length; i++) {
    const code = /** @type {number} */ (codes[i]); // bounded by i < codes.length
    if (code === 0) Object.assign(state, freshState());
    else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 3) state.italic = true;
    else if (code === 4) state.underline = true;
    else if (code === 7) state.inverse = true;
    else if (code === 9) state.strike = true;
    else if (code === 22) { state.bold = false; state.dim = false; }
    else if (code === 23) state.italic = false;
    else if (code === 24) state.underline = false;
    else if (code === 27) state.inverse = false;
    else if (code === 29) state.strike = false;
    else if (code >= 30 && code <= 37) state.fg = { kind: 'named', index: code - 30, bright: false };
    else if (code === 39) state.fg = null;
    else if (code >= 40 && code <= 47) state.bg = { kind: 'named', index: code - 40, bright: false };
    else if (code === 49) state.bg = null;
    else if (code >= 90 && code <= 97) state.fg = { kind: 'named', index: code - 90, bright: true };
    else if (code >= 100 && code <= 107) state.bg = { kind: 'named', index: code - 100, bright: true };
    else if (code === 38 || code === 48) {
      // Extended colour: 5;n (256) or 2;r;g;b (truecolor). Consumes params.
      const target = code === 38 ? 'fg' : 'bg';
      if (codes[i + 1] === 5) {
        state[target] = color256((codes[i + 2] ?? 0) | 0);
        i += 2;
      } else if (codes[i + 1] === 2) {
        const r = (codes[i + 2] ?? 0) | 0, g = (codes[i + 3] ?? 0) | 0, b = (codes[i + 4] ?? 0) | 0;
        state[target] = { kind: 'rgb', value: `rgb(${r} ${g} ${b})` };
        i += 4;
      }
    }
    // Other SGR codes (e.g. blink, font selection) are ignored.
  }
}

/**
 * @param {ReturnType<typeof freshState>} state - Active style state
 * @returns {boolean} True if the state differs from default (needs a span)
 */
function isStyled(state) {
  return !!(state.fg || state.bg || state.bold || state.dim || state.italic || state.underline || state.inverse || state.strike);
}

/**
 * Build a styled span (or bare text node when no styling is active) for a run
 * of text under the given style state.
 * @param {string} text - Run of plain text (no escapes)
 * @param {ReturnType<typeof freshState>} state - Active style state
 * @returns {Node} A span element or a text node
 */
function makeNode(text, state) {
  if (!isStyled(state)) return document.createTextNode(text);
  const span = document.createElement('span');
  span.textContent = text;
  const s = span.style;

  if (state.inverse) {
    // Swap fg/bg, substituting the panel's default colours where unset. The
    // swapped colours adopt the role they now paint, not the one they came from.
    s.color = resolveColor(state.bg, 'fg') || 'var(--ansi-bg-default)';
    s.backgroundColor = resolveColor(state.fg, 'bg') || 'var(--ansi-fg-default)';
  } else {
    const fg = resolveColor(state.fg, 'fg');
    const bg = resolveColor(state.bg, 'bg');
    if (fg) s.color = fg;
    if (bg) s.backgroundColor = bg;
  }

  if (state.bold) s.fontWeight = 'bold';
  if (state.dim) s.opacity = '0.7';
  if (state.italic) s.fontStyle = 'italic';
  const deco = [];
  if (state.underline) deco.push('underline');
  if (state.strike) deco.push('line-through');
  if (deco.length) s.textDecoration = deco.join(' ');

  return span;
}

/**
 * Parse a string containing ANSI escape sequences into a DocumentFragment of
 * text nodes and styled spans. Non-SGR escapes (cursor moves, OSC titles,
 * etc.) are consumed and dropped rather than displayed as garbage.
 * @param {string} text - Raw output, possibly with ANSI escapes
 * @returns {DocumentFragment} Fragment ready to append into a `<pre>`
 */
export function ansiToFragment(text) {
  const frag = document.createDocumentFragment();
  const str = String(text ?? '');

  // Fast path: no escapes at all.
  if (str.indexOf(ESC) === -1) {
    if (str) frag.appendChild(document.createTextNode(str));
    return frag;
  }

  const state = freshState();
  let buf = '';
  const flush = () => {
    if (buf) { frag.appendChild(makeNode(buf, state)); buf = ''; }
  };

  let i = 0;
  while (i < str.length) {
    const ch = /** @type {string} */ (str[i]); // bounded by i < str.length
    if (ch !== ESC) { buf += ch; i++; continue; }

    const next = str[i + 1];
    if (next === '[') {
      // CSI: ESC [ params... finalByte
      let j = i + 2;
      while (j < str.length && /** @type {string} */ (str[j]) >= '\x30' && /** @type {string} */ (str[j]) <= '\x3f') j++; // parameter bytes
      while (j < str.length && /** @type {string} */ (str[j]) >= '\x20' && /** @type {string} */ (str[j]) <= '\x2f') j++; // intermediate bytes
      const finalByte = str[j];
      if (finalByte === 'm') {
        flush();
        const paramStr = str.slice(i + 2, j);
        const params = paramStr === '' ? [] : paramStr.split(';').map(p => parseInt(p, 10) || 0);
        applySgr(state, params);
      }
      // Non-SGR CSI sequences are dropped.
      i = j + 1;
    } else if (next === ']') {
      // OSC: ESC ] ... terminated by BEL or ST (ESC \). Dropped.
      let j = i + 2;
      while (j < str.length && str[j] !== '\x07' && !(str[j] === ESC && str[j + 1] === '\\')) j++;
      i = (str[j] === ESC) ? j + 2 : j + 1;
    } else {
      // Other two-byte escape (or trailing lone ESC). Drop it.
      i += 2;
    }
  }
  flush();
  return frag;
}

/**
 * Render ANSI output into an element, replacing its current content.
 * @param {HTMLElement} el - Target element (typically a `<pre>`)
 * @param {string} text - Raw output, possibly with ANSI escapes
 */
export function applyAnsi(el, text) {
  el.textContent = '';
  el.appendChild(ansiToFragment(text));
}

/**
 * Strip all ANSI escape sequences, returning just the visible text. Used for
 * copy-to-clipboard so the clipboard gets clean text, not escape codes.
 * @param {string} text - Raw output, possibly with ANSI escapes
 * @returns {string} Text with escape sequences removed
 */
export function stripAnsi(text) {
  const str = String(text ?? '');
  if (str.indexOf(ESC) === -1) return str;
  return ansiToFragment(str).textContent || '';
}
