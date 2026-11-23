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
  withNodes,
} from './lib/html.js';

// One-shot stylesheet injection for modules that ship their own CSS
export { injectStylesOnce } from './lib/inject-styles.js';

// A handle that moves the line between two panes, and what a rem is in pixels
export { attachSplitDrag, remPx } from './lib/split-drag.js';

// Output truncation / token budgets
export { smartTruncate } from './lib/smart-truncate.js';

// Error formatting
export {
  extractErrorMessage,
  extractUserMessage,
  extractErrorInfo,
  errorText,
} from './lib/error-utils.js';

// Dropdown positioning
export { positionDropdown } from './lib/dropdown-positioning.js';

// Popup presentation (anchored dropdown ↔ phone bottom sheet)
export { presentPopup } from '../js/utils/popup-surface.js';

// The app's dialog holding an extension's own fields, with Cancel and a confirm
// button — for asking for a name or a message the way the app itself does
export { showFormDialog } from '../js/components/modal-dialog.js';

// Properties-panel building blocks
export {
  createCopyButton,
  createCopyableText,
  addSubsection,
  labeledSubsection,
  addFilePath,
  createFileActions,
  pinFile,
  pinSource,
  canPinSource,
  showPin,
  createShowPinControl,
  addDiffViewer,
  // A file's name as a link that opens it on the Pinboard, as file references
  // in replies are
  createFileRefLink,
} from '../js/utils/properties-panel-helpers.js';

// The reader's place: the nearest context item of a type from the thread they
// are in (what the Plan and Todo pins show), and word when they change thread
export { findReaderContextItem, onReaderThreadChange } from '../js/services/nearest-context-item.js';

// The shared diff renderer, for a host drawing a patch or a pair of snapshots
export { createDiffViewer } from '../js/components/diff-viewer.js';

// The review panel around it: a file rail, one diff at a time, and the draft
export { createReviewPanel } from '../js/components/review-panel.js';

// A file's contents as the app shows them, and a path field with its completions
export { createFileView } from '../js/components/file-view.js';
export { createPathInput } from '../js/components/path-input.js';

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
// mtime, a run's start) must read the same as the chrome around it — and its
// token-count renderer (`12.3k`), for the same reason
export { formatRelativeDateTime, formatTokens } from '../js/utils/format.js';

// Keyboard navigation for a role="menu" popup (arrow keys, Home/End, Escape),
// and focus on its checked item once the popup is on screen (a picker's open)
export { attachMenuKeyboard, focusMenuItem, focusMenuChoice } from '../js/utils/menu-roles.js';

// The app's context menu, opened at a point (for a long-press, or a ⋯ button)
// or on a right-click within an element an extension draws, with the same
// chrome and dismissal as every other context menu
export { contextMenuFor, openMenuAt } from '../js/services/context-menu-service.js';

// A background task's live output, tailed while it runs, and the control that
// says whether its output is delivered to the model
export { renderLiveTaskOutput } from './lib/live-task-output.js';
export { renderTaskDeliveryControl } from './lib/task-delivery-control.js';

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

// The app's key map as plain data, and the platform it formats for by default
export { shortcutTableForPlatform, isMac } from '../js/services/key-shortcut-manager.js';

// A served asset path as a fetchable URL (cache-busting prefix, base path)
export { resolveAssetUrl } from '../js/utils/asset-url.js';
