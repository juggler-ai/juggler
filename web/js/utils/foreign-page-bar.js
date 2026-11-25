//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The desktop app's fallback bar for a page that is not Juggler's
 * (cmd/juggler-app/foreign_page.go). No page imports it: the app hands the
 * source of offerForeignPageBar to each top-level page it loads, through
 * ExecJS, as a classic script inside a function of its own that calls it with
 * that load's configuration and the page's window. So this module holds that
 * one function and nothing else — no imports, nothing it closes over — and the
 * app takes its source as written, minus the `export`.
 *
 * It builds the bar with the DOM and CSSOM alone — no markup, no style sheet —
 * which a page's CSP or Trusted Types cannot refuse, inside a closed shadow
 * root the page's own CSS cannot reach. It wears the header's chrome as
 * window-chrome.css draws it: the theme's colours, the caption buttons' glyphs
 * and close red, the macOS traffic-light gutter (none in fullscreen, none on a
 * frameless window), and the strip along the top edge left to the OS's resize
 * zone, which does not drag the window.
 * @module utils/foreign-page-bar
 */

/**
 * @typedef {object} ForeignBarColours
 * @property {string} bg - The header's background.
 * @property {string} raised - A hovered button's background.
 * @property {string} border - The bar's bottom edge, and a pressed button.
 * @property {string} text - The label, and a hovered button's glyph.
 * @property {string} textSecondary - A resting button's glyph.
 * @property {string} onAccent - The close button's glyph on its red.
 */

/**
 * A foreignBarConfig (foreign_page.go): what one load's offer is given.
 * @typedef {object} ForeignBarConfig
 * @property {string} token - The load's token, sent with each press.
 * @property {string} prefix - What starts each press's message.
 * @property {boolean} canGoBack - Whether the bar has Back to Juggler.
 * @property {boolean} frameless - Whether it carries minimise, maximise and close.
 * @property {boolean} fullscreen - Whether the window is fullscreen.
 * @property {boolean} maximised - Whether the window is maximised.
 * @property {Record<string, string>} labels - The bar's text, translated.
 * @property {string} gutter - The macOS traffic lights' gutter.
 * @property {string} titleBar - How tall the macOS title bar is, which the lights are centred in.
 * @property {string} strip - The resize strip along the top edge.
 * @property {string} closeHover - The close button's hovered red.
 * @property {string} closeActive - The close button's pressed red.
 * @property {ForeignBarColours} colours - The theme's colours.
 * @property {ForeignBarGlyphs} glyphs - The caption glyphs.
 */

/** @typedef {[string, Record<string, string>]} GlyphPart - An element of a glyph: its tag and attributes. */

/**
 * @typedef {object} ForeignBarGlyphs
 * @property {Record<string, string>} svg - Each glyph's root attributes.
 * @property {GlyphPart[]} minimise - The minimise glyph.
 * @property {GlyphPart[]} maximise - The maximise glyph.
 * @property {GlyphPart[]} restore - The restore glyph.
 * @property {GlyphPart[]} close - The close glyph.
 */

/** @typedef {{postMessage: (m: string) => void}} MessagePort_ - A webview's message channel. */

/**
 * A page's window, with the bridges a webview may put in it.
 * @typedef {Window & {_wails?: {invoke?: (m: string) => void}, chrome?: {webview?: MessagePort_}, webkit?: {messageHandlers?: {external?: MessagePort_}}}} BarWindow
 */

/**
 * Lay the fallback bar over win's page, unless the page is Juggler's, in
 * place of any bar an earlier offer laid there.
 *
 * Each offer answers for the page as it stands, so any earlier bar goes first,
 * on a Juggler page too. And an offer can reach a page before its header is
 * parsed — the window's next page, when it moved on before the offer ran — so
 * a page still loading is judged once it has been parsed, never by its first
 * few bytes.
 * @param {ForeignBarConfig} bar - The load's configuration.
 * @param {BarWindow} win - The page's window.
 * @returns {void}
 */
export function offerForeignPageBar(bar, win) {
  const document = win.document;
  const location = win.location;
  const id = '__juggler-foreign-page-bar';
  document.getElementById(id)?.remove();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { offerForeignPageBar(bar, win); }, { once: true });
    return;
  }
  if (document.querySelector('window-caption-controls')) return;
  const c = bar.colours;
  /** @param {string} m - The message. */
  const send = (m) => {
    if (win._wails && win._wails.invoke) win._wails.invoke(m);
    else if (win.chrome && win.chrome.webview) win.chrome.webview.postMessage(m);
    else if (win.webkit && win.webkit.messageHandlers && win.webkit.messageHandlers.external) win.webkit.messageHandlers.external.postMessage(m);
  };
  /** @param {string} action - The button pressed. */
  const press = (action) => {
    send(bar.prefix + JSON.stringify({ token: bar.token, action, url: location.href }));
  };
  const NS = 'http://www.w3.org/2000/svg';
  /**
   * @param {Element} el - The element.
   * @param {Record<string, string>} attrs - Its attributes.
   */
  const setAll = (el, attrs) => {
    Object.keys(attrs).forEach((k) => { el.setAttribute(k, attrs[k] ?? ''); });
  };
  /**
   * @param {'minimise' | 'maximise' | 'restore' | 'close'} name - The glyph.
   * @returns {SVGSVGElement} It, drawn.
   */
  const glyph = (name) => {
    const svg = document.createElementNS(NS, 'svg');
    setAll(svg, bar.glyphs.svg);
    setAll(svg, { 'aria-hidden': 'true', focusable: 'false', width: '10', height: '10' });
    bar.glyphs[name].forEach((part) => {
      const el = document.createElementNS(NS, part[0]);
      setAll(el, part[1]);
      svg.appendChild(el);
    });
    return svg;
  };
  const host = document.createElement('div');
  host.id = id;
  const root = host.attachShadow({ mode: 'closed' });
  const strip = parseFloat(bar.strip) || 0;
  const gutter = !bar.frameless && !bar.fullscreen;
  // Beside the macOS traffic lights the bar is the title bar's height, so they
  // sit inside it rather than over the page below.
  const height = gutter && bar.titleBar ? bar.titleBar : '32px';
  const el = document.createElement('div');
  Object.assign(el.style, {
    position: 'fixed', top: '0', left: '0', right: '0', height, zIndex: '2147483647',
    display: 'flex', alignItems: 'stretch', boxSizing: 'border-box',
    paddingLeft: gutter ? bar.gutter : '12px',
    background: c.bg, color: c.text, borderBottom: '1px solid ' + c.border,
    font: '12px system-ui, sans-serif', lineHeight: height, userSelect: 'none', cursor: 'default',
  });
  const text = document.createElement('span');
  text.textContent = (bar.labels.page ?? '') + (location.host ? ' \u2014 ' + location.host : '');
  Object.assign(text.style, { flex: '1', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' });
  el.appendChild(text);
  /**
   * @param {string | Element} content - Its text or glyph.
   * @param {string} title - Its tooltip and label.
   * @param {string} action - What it presses.
   * @param {boolean} close - Whether it is the close button.
   * @returns {HTMLButtonElement} The button.
   */
  const button = (content, title, action, close) => {
    const b = document.createElement('button');
    b.type = 'button';
    if (typeof content === 'string') b.textContent = content; else b.appendChild(content);
    b.title = title;
    b.setAttribute('aria-label', title);
    Object.assign(b.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      border: '0', margin: '0', padding: '0 14px', minWidth: '46px', background: 'transparent',
      color: c.textSecondary, font: 'inherit', cursor: 'default',
    });
    b.addEventListener('mouseenter', () => {
      b.style.background = close ? bar.closeHover : c.raised;
      b.style.color = close ? c.onAccent : c.text;
    });
    b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; b.style.color = c.textSecondary; });
    b.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      b.style.background = close ? bar.closeActive : c.border;
    });
    b.addEventListener('mouseup', () => { b.style.background = close ? bar.closeHover : c.raised; });
    b.addEventListener('dblclick', (e) => { e.stopPropagation(); });
    b.addEventListener('click', (e) => { e.stopPropagation(); press(action); });
    return b;
  };
  let maximised = bar.maximised;
  /** @type {HTMLButtonElement | null} */
  let maxButton = null;
  const showMaximised = () => {
    if (!maxButton) return;
    const label = (maximised ? bar.labels.restore : bar.labels.maximise) ?? '';
    maxButton.replaceChildren(glyph(maximised ? 'restore' : 'maximise'));
    maxButton.title = label;
    maxButton.setAttribute('aria-label', label);
  };
  const labels = bar.labels;
  if (bar.canGoBack) el.appendChild(button(labels.back ?? '', labels.back ?? '', 'back', false));
  if (bar.frameless) {
    el.appendChild(button(glyph('minimise'), labels.minimise ?? '', 'minimise', false));
    const max = button(glyph('maximise'), labels.maximise ?? '', 'maximise', false);
    max.addEventListener('click', () => { maximised = !maximised; showMaximised(); });
    el.appendChild(max);
    maxButton = max;
    el.appendChild(button(glyph('close'), labels.close ?? '', 'close', true));
    showMaximised();
  }
  el.addEventListener('mousedown', (e) => {
    if (e.button === 0 && e.clientY >= strip) send('wails:drag');
  });
  el.addEventListener('dblclick', (e) => {
    if (e.clientY < strip) return;
    // The runtime's double-click message acts only on macOS (where it honours
    // the system's title-bar setting); a frameless window asks for maximise.
    if (bar.frameless) press('maximise'); else send('wails:drag:doubleclick');
    maximised = !maximised;
    showMaximised();
  });
  root.appendChild(el);
  (document.body || document.documentElement).appendChild(host);
}
