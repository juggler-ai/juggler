//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * HTML Utilities
 *
 * Common HTML helper functions used across context items and actions.
 *
 * The escaping helpers here are the single implementation behind the
 * `juggler/ui` and `juggler/utils/html` specifiers: `sdk/ui.js` and
 * `sdk/ui-worker.js` both re-export them, so a plugin gets the same output
 * whichever realm resolved its import. They are pure string work with no
 * `document`, which is what lets the worker twin surface them for real.
 */

/**
 * Escape HTML special characters to prevent XSS.
 *
 * Escapes the quote characters as well as the tag characters, so the result is
 * equally safe interpolated into an attribute value or into element content.
 * @param {string} text - Text to escape
 * @returns {string} Escaped text safe for HTML insertion
 */
export function escapeHtml(text) {
  if (text === null || text === undefined) return '';

  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The entities `escapeHtml` produces, keyed lowercase for lookup.
 * @type {Record<string, string>}
 */
const HTML_ENTITY_VALUES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'"
};

/**
 * Decode the HTML entities `escapeHtml` produces.
 *
 * For model-authored strings that are displayed as text rather than markup — a
 * conversation name, a thread goal — which sometimes arrive HTML-escaped
 * because the model treats every string it writes as reply markup. Nothing
 * renders those through innerHTML, so the entities reach the user verbatim.
 *
 * One pass, so `&amp;lt;` decodes to `&lt;` and not to `<`.
 * @param {string} text - Text that may contain escaped entities
 * @returns {string} Text with the escapeHtml entity set decoded
 */
export function decodeHtmlEntities(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(
    /&(?:amp|lt|gt|quot|#39|#x27);/gi,
    (entity) => HTML_ENTITY_VALUES[entity.toLowerCase()] ?? entity
  );
}

/**
 * Escape JSON string content for HTML display without surrounding quotes.
 * This is a specialized function for custom JSON formatters that manually build HTML.
 * @param {string} str - String to escape
 * @returns {string} JSON-escaped content without quotes, safe for HTML
 */
export function escapeJsonContent(str) {
  // Use JSON.stringify for proper JSON escaping, then remove the quotes it adds
  const withQuotes = JSON.stringify(String(str));
  const withoutQuotes = withQuotes.slice(1, -1);
  // Then escape HTML entities for safe display
  return escapeHtml(withoutQuotes);
}

/**
 * Escape a string for safe use in HTML attributes.
 *
 * Takes plain text, never already-escaped text: the ampersand is escaped first,
 * so an entity in the input survives as the literal entity text, not as the
 * character it names. `<` is escaped too, which an attribute does not strictly
 * need, so the value is safe even where a caller's attribute quoting slips.
 * @param {string} text - Text to escape
 * @returns {string} Escaped string safe for HTML attributes
 */
export function escapeAttr(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Create a DOM element with given tag, className, and optional text content
 * @param {string} tag - HTML tag name
 * @param {string} [className] - CSS class name(s)
 * @param {string} [textContent] - Text content
 * @returns {HTMLElement} Created element
 */
export function createElement(tag, className, textContent) {
  const el = document.createElement(tag);
  if (className) {
    el.className = className;
  }
  if (textContent !== undefined) {
    el.textContent = textContent;
  }
  return el;
}

/**
 * Create a `<button>` with a class, text label, and click handler. The
 * `className` is applied verbatim so callers control their own styling
 * convention (e.g. "btn btn-primary", "btn btn-sm btn-neutral").
 * @param {string} text - Button label
 * @param {string} className - Full class string applied verbatim
 * @param {() => void} onClick - Click handler
 * @returns {HTMLButtonElement} The constructed button
 */
export function createButton(text, className, onClick) {
  const button = document.createElement('button');
  button.className = className;
  button.textContent = text;
  button.addEventListener('click', onClick);
  return button;
}

/**
 * SVG icons for expand/collapse toggle buttons (used by model-selector)
 * @private
 */
const TOGGLE_ICONS = {
  expand: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor"><path d="M480-359.51 642.38-521.9l-36-35L480-430.51 353.62-556.9l-36 35L480-359.51Zm.07 259.51q-78.43 0-147.67-29.92-69.24-29.92-120.89-81.54-51.64-51.63-81.58-120.84Q100-401.51 100-479.93q0-78.84 29.92-148.21t81.54-120.68q51.63-51.31 120.84-81.25Q401.51-860 479.93-860q78.84 0 148.21 29.92t120.68 81.21q51.31 51.29 81.25 120.63Q860-558.9 860-480.07q0 78.43-29.92 147.67-29.92 69.24-81.21 120.89-51.29 51.64-120.63 81.58Q558.9-100 480.07-100Zm-.07-50.26q137.79 0 233.77-96.18 95.97-96.18 95.97-233.56 0-137.79-95.97-233.77-95.98-95.97-233.77-95.97-137.38 0-233.56 95.97-96.18 95.98-96.18 233.77 0 137.38 96.18 233.56T480-150.26ZM480-480Z"/></svg>',
  collapse: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor"><path d="M353.62-403.1 480-529.49 606.38-403.1l36-35L480-600.49 317.62-438.1l36 35ZM480.07-100q-78.84 0-148.21-29.92t-120.68-81.21q-51.31-51.29-81.25-120.63Q100-401.1 100-479.93q0-78.84 29.92-147.87 29.92-69.04 81.21-120.69 51.29-51.64 120.63-81.58Q401.1-860 479.93-860q78.84 0 147.87 29.92 69.04 29.92 120.69 81.54 51.64 51.63 81.58 120.63Q860-558.9 860-480.07q0 78.84-29.92 148.21t-81.54 120.68q-51.63 51.31-120.63 81.25Q558.9-100 480.07-100Zm-.07-50.26q137.38 0 233.56-95.97 96.18-95.98 96.18-233.77 0-137.38-96.18-233.56T480-809.74q-137.79 0-233.77 96.18-95.97 96.18-95.97 233.56 0 137.79 95.97 233.77 95.98 95.97 233.77 95.97ZM480-480Z"/></svg>'
};

/**
 * Get the expand/collapse SVG icons for use in other components
 * @returns {{expand: string, collapse: string}} SVG icon strings
 */
export function getToggleIcons() {
  return TOGGLE_ICONS;
}

/**
 * Semantic status for action result styling.
 * @typedef {'success'|'error'|'cancelled'|'running'} ActionResultStatus
 */

/**
 * Result status message configuration for action result rendering.
 * @typedef {object} ResultStatusMessage
 * @property {string|HTMLElement} summary - Status line content (will be truncated with ellipsis)
 * @property {ActionResultStatus} [status] - Semantic status for styling (success, error, cancelled, running)
 * @property {string} [typeName] - Type label rendered as a lozenge badge (e.g., "Read", "Question")
 */

/**
 * Render a ResultStatusMessage config into an HTMLElement.
 * Creates a consistent layout with a single-row status display.
 * @param {ResultStatusMessage} config - Status message configuration
 * @returns {HTMLElement} Rendered result view element
 */
export function renderResultStatusMessage(config) {
  const container = document.createElement('div');
  container.className = 'action-result';

  const statusRow = document.createElement('div');
  statusRow.className = 'action-result-status';

  const summaryEl = document.createElement('span');
  summaryEl.className = 'action-result-summary text-truncate';

  if (config.typeName) {
    const badge = document.createElement('span');
    badge.className = 'context-item-type-badge';
    badge.textContent = config.typeName;
    summaryEl.appendChild(badge);
  }

  if (typeof HTMLElement !== 'undefined' && config.summary instanceof HTMLElement) {
    summaryEl.classList.add('action-result-summary-rich');
    summaryEl.appendChild(config.summary);
  } else {
    const textSpan = document.createElement('span');
    textSpan.className = 'action-result-summary-text';
    textSpan.textContent = typeof config.summary === 'string' ? config.summary : '';
    summaryEl.appendChild(textSpan);
  }

  if (config.status) {
    summaryEl.classList.add(`status-${config.status}`);
  }

  statusRow.appendChild(summaryEl);
  container.appendChild(statusRow);

  return container;
}

/**
 * Create a summary row element.
 * @param {string} main - Primary text content
 * @param {string} [note] - Optional secondary note
 * @returns {HTMLElement} Styled summary element
 */
export function createSummaryRow(main, note) {
  const row = document.createElement('span');
  row.className = 'action-summary-row';

  const mainEl = document.createElement('span');
  mainEl.className = 'action-summary-main';
  mainEl.textContent = main;
  row.appendChild(mainEl);

  if (note) {
    const noteEl = document.createElement('span');
    noteEl.className = 'action-summary-note';
    noteEl.textContent = note;
    row.appendChild(noteEl);
  }

  return row;
}

/**
 * Create a two-line summary: a primary line with a smaller subtitle below.
 * Use as the `summary` field of a ResultStatusMessage when an action wants to
 * show "what" and "why" on adjacent lines (e.g. command + description).
 *
 * `main` may be a plain string or a pre-built element (e.g. a syntax-highlighted
 * `<code>`); an element is inserted into the main-line slot so it still inherits
 * the mono/ellipsis styling.
 * @param {string|HTMLElement} main - Primary line (e.g. command, file path)
 * @param {string} [subtitle] - Secondary descriptive line; if empty, returns the main as-is
 * @returns {string|HTMLElement} Subtitle element, or the main value if no subtitle
 */
export function createSummaryWithSubtitle(main, subtitle) {
  const mainIsNode = typeof HTMLElement !== 'undefined' && main instanceof HTMLElement;
  if (!subtitle) {
    if (!mainIsNode) return main;
    // Wrap a bare node so it keeps the main-line styling it would otherwise
    // only get in the two-line layout below.
    const soleWrapper = document.createElement('span');
    soleWrapper.className = 'summary-with-subtitle-main';
    soleWrapper.appendChild(main);
    return soleWrapper;
  }
  const wrapper = document.createElement('span');
  wrapper.className = 'summary-with-subtitle';
  const mainEl = document.createElement('span');
  mainEl.className = 'summary-with-subtitle-main';
  if (main instanceof HTMLElement) mainEl.appendChild(main);
  else mainEl.textContent = main;
  const subEl = document.createElement('span');
  subEl.className = 'summary-with-subtitle-sub llm-description';
  subEl.textContent = subtitle;
  wrapper.appendChild(mainEl);
  wrapper.appendChild(subEl);
  return wrapper;
}

/**
 * Wrap LLM-provided descriptive text (e.g. a tool call's `description` field)
 * in the shared `.llm-description` style so it renders with the same italic
 * accent typography used for descriptions across tiles. Use as a `summary`
 * value of a ResultStatusMessage when the only thing to show is the description.
 * @param {string} text - Description text from the LLM
 * @returns {HTMLElement} Span styled as an LLM description
 */
export function createLlmDescription(text) {
  const el = document.createElement('span');
  el.className = 'llm-description';
  el.textContent = text;
  return el;
}

