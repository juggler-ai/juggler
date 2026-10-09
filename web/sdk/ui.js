//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * `juggler/ui` — DOM, rendering and formatting helpers for an extension's
 * properties panel and result rendering.
 *
 * Curated re-export façade: only the symbols built-ins actually depend on are
 * surfaced, so the public UI surface is decoupled from the internal util layout.
 */

// DOM construction / escaping
export {
  createElement,
  escapeHtml,
  escapeAttr,
  escapeJsonContent,
  getToggleIcons,
  renderResultStatusMessage,
  createSummaryRow,
  createSummaryWithSubtitle,
  createLlmDescription,
} from './lib/html.js';

// One-shot stylesheet injection for modules that ship their own CSS
export { injectStylesOnce } from './lib/inject-styles.js';

// Output truncation / token budgets
export { smartTruncate } from './lib/smart-truncate.js';

// Error formatting
export {
  extractErrorMessage,
  extractUserMessage,
  extractErrorInfo,
} from './lib/error-utils.js';

// Dropdown positioning
export { positionDropdown } from './lib/dropdown-positioning.js';

// Popup presentation (anchored dropdown ↔ phone bottom sheet)
export { presentPopup } from '../js/utils/popup-surface.js';

// Properties-panel building blocks
export {
  createCopyButton,
  createCopyableText,
  addSubsection,
  labeledSubsection,
  addFilePath,
  createFileActions,
  pinFile,
  showPin,
  createShowPinControl,
  addDiffViewer,
} from '../js/utils/properties-panel-helpers.js';

// The shared diff renderer, for a host drawing a patch or a pair of snapshots
export { createDiffViewer } from '../js/components/diff-viewer.js';

// The review panel around it: a file rail, one diff at a time, and the draft
export { createReviewPanel } from '../js/components/review-panel.js';

// Syntax highlighting (Prism-backed, safe fallback)
export { highlightCode, highlightCodeLines, createHighlightedCode } from './lib/syntax-highlight.js';

// Language identification (pure string tables)
export {
  languageForPath,
  normalizeLanguageId,
  LANGUAGE_BY_EXT,
  LANGUAGE_BY_FILENAME,
} from './lib/languages.js';

// Markdown rendering
export {
  renderMarkdown,
  renderMarkdownWrapped,
  decorateCodeBlocks,
  escapeXmlTagsForMarkdown,
} from './lib/markdown.js';

// Task-list markers (the `[ ]`/`[/]`/`[x]`/`[!]`/`[-]` vocabulary)
export { taskMarker, taskStatusWord } from './lib/task-markers.js';

// Misc formatting helpers
export { FormattingHelpers } from './lib/formatting-helpers.js';

// The app's one date-time renderer — a plugin showing a timestamp (a file's
// mtime, a run's start) must read the same as the chrome around it
export { formatRelativeDateTime } from '../js/utils/format.js';

// Full-screen image overlay (shared by the image viewer and attachment thumbs)
export { openImageLightbox, createImageThumb } from '../js/utils/image-lightbox.js';

// Project-picker panel (used by file/path-selecting items)
export { buildPickerPanel } from '../js/components/project-picker.js';

// The desktop app's native chooser, for an item that can skip the typed-path
// panel when there is an OS dialog to ask instead
export { hasNativeHost, pickFile } from './lib/window-control.js';

// Clipboard, for a control that copies something without being a copy button
export { copyToClipboard } from './lib/clipboard.js';

// What "reveal" is called on this platform (Finder, Explorer, file manager)
export { revealLabel } from '../js/components/reveal-button.js';
