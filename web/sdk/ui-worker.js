//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Worker-safe `juggler/ui` facade.
 *
 * Engine/plugin workers may import modules that reference UI helpers for
 * viewer-only methods, but those helpers must not pull DOM modules into the
 * worker at import time. Pure formatting helpers are re-exported; DOM helpers
 * are present as throwing stubs so accidental engine-side use fails clearly.
 */

export { smartTruncate } from './lib/smart-truncate.js';
// Not a stub: injectStylesOnce is DOM-guarded and returns without touching a
// global when there is no document, so the worker gets the real function.
export { injectStylesOnce } from './lib/inject-styles.js';
export {
  extractErrorMessage,
  extractUserMessage,
  extractErrorInfo,
} from './lib/error-utils.js';
export { FormattingHelpers } from './lib/formatting-helpers.js';
// Date formatting is pure `Date`/`Intl` work, so the worker gets the real one:
// an engine-side plugin naming a time must name it the way the viewer would.
export { formatRelativeDateTime } from '../js/utils/format.js';

// Pure (DOM-free): highlightCode returns escaped/highlighted HTML as a string
// and no-ops to escaped text when `window.Prism` is absent — which it always is
// off the main thread — so it is safe to surface for real in the worker. The
// per-line variant splits that string, and the language lookups beside it are
// plain string tables.
export { highlightCode, highlightCodeLines } from './lib/syntax-highlight.js';
export {
  languageForPath,
  normalizeLanguageId,
  LANGUAGE_BY_EXT,
  LANGUAGE_BY_FILENAME,
} from './lib/languages.js';

// Pure string lookups, and needed for real off the main thread: a context item
// composes its LLM text (plan steps, todo items) inside the engine worker.
export { taskMarker, taskStatusWord } from './lib/task-markers.js';

// Pure string escaping, shared verbatim with the browser façade: one specifier
// must not mean two escapers. `lib/html.js` touches `document` only inside its
// DOM helpers, so importing it here costs the worker nothing.
export { escapeHtml, escapeAttr, escapeJsonContent } from './lib/html.js';

/** @param {string} name */
function domUnavailable(name) {
  throw new Error(`juggler/ui.${name} is viewer-only and unavailable in an engine worker`);
}

// Viewer-only DOM helpers — present so plugin imports resolve in the engine
// worker, but they throw if actually called off the main thread. Arrow consts
// (not function declarations) keep require-jsdoc quiet without per-stub noise.
export const createElement = () => domUnavailable('createElement');
export const getToggleIcons = () => domUnavailable('getToggleIcons');
export const renderResultStatusMessage = () => domUnavailable('renderResultStatusMessage');
export const positionDropdown = () => domUnavailable('positionDropdown');
export const presentPopup = () => domUnavailable('presentPopup');
export const createCopyButton = () => domUnavailable('createCopyButton');
export const createCopyableText = () => domUnavailable('createCopyableText');
export const addSubsection = () => domUnavailable('addSubsection');
export const labeledSubsection = () => domUnavailable('labeledSubsection');
export const addFilePath = () => domUnavailable('addFilePath');
export const createFileActions = () => domUnavailable('createFileActions');
export const pinFile = () => domUnavailable('pinFile');
export const showPin = () => domUnavailable('showPin');
export const createShowPinControl = () => domUnavailable('createShowPinControl');
export const addDiffViewer = () => domUnavailable('addDiffViewer');
export const createDiffViewer = () => domUnavailable('createDiffViewer');
export const createReviewPanel = () => domUnavailable('createReviewPanel');
export const openImageLightbox = () => domUnavailable('openImageLightbox');
export const createImageThumb = () => domUnavailable('createImageThumb');
export const renderMarkdown = () => domUnavailable('renderMarkdown');
export const renderMarkdownWrapped = () => domUnavailable('renderMarkdownWrapped');
export const decorateCodeBlocks = () => domUnavailable('decorateCodeBlocks');
export const escapeXmlTagsForMarkdown = () => domUnavailable('escapeXmlTagsForMarkdown');
export const buildPickerPanel = () => domUnavailable('buildPickerPanel');
export const hasNativeHost = () => domUnavailable('hasNativeHost');
export const pickFile = () => domUnavailable('pickFile');
export const copyToClipboard = () => domUnavailable('copyToClipboard');
export const revealLabel = () => domUnavailable('revealLabel');
export const createHighlightedCode = () => domUnavailable('createHighlightedCode');
export const createSummaryRow = () => domUnavailable('createSummaryRow');
export const createSummaryWithSubtitle = () => domUnavailable('createSummaryWithSubtitle');
export const createLlmDescription = () => domUnavailable('createLlmDescription');
