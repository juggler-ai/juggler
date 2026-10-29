//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A conversation as one self-contained HTML page, for sharing.
 *
 * It is the conversation a person read — the same selection as the Markdown
 * copy (`conversation-markdown.js`): the user's and the agent's messages, a row
 * per tool call, each sub-thread's goal and the answer it handed back, and
 * errors. Standing context (system prompt, memory, files), thinking, reminders
 * and notices are never included.
 *
 * What else goes in is the user's choice, and both choices default to out:
 *  - `includeToolDetails`: each tool row expands (a `<details>`) to the call's
 *    input and output. Without it the row is one line: the tool and what it
 *    was asked to do.
 *  - `includeFiles`: images attached to messages or produced by tools, inlined
 *    as data: URIs, and the output of tools whose plugin says it is file
 *    contents (`ContextItem.resultIsFileContent`) — that output stays out even
 *    with tool details on.
 *
 * The page looks like the app because it is built from the app's own pieces:
 * rows use the transcript's element names and classes, Markdown goes through
 * `renderMarkdown` (the same sanitiser and highlighter), sub-thread answers
 * through `paintThreadSummary`, tool rows through each plugin's `getStatusUI`,
 * and the stylesheet is every rule of the app's live cascade that matches the
 * exported page, copied in its layers. The live row components themselves are
 * not used: they find their item through the live `<conversation-area>`.
 *
 * Self-contained means it fetches nothing and runs nothing when opened. The page
 * is assembled in an inert document, so nothing in it loads while it is built;
 * then every script, frame, stylesheet link and event handler is removed, any
 * resource that is not a data: URI is dropped (a remote image becomes a link to
 * it), and so is every CSS `url()` that is not one. Links a reader can follow
 * stay. Nothing is sent anywhere: the only requests made are for the
 * conversation's own image attachments, from this app's server.
 * @module utils/conversation-html
 */

import {
  isUserMessage,
  isAssistantMessage,
  isToolActionMessage,
  isThreadMessage,
  isErrorMessage,
  itemField
} from '../../sdk/lib/message.js';
import { renderMarkdownWrapped, renderAssistantContentWrapped, decorateCodeBlocks, looksLikeMarkdown } from '../../sdk/lib/markdown.js';
import { renderResultStatusMessage } from '../../sdk/lib/html.js';
import { highlightCode } from '../../sdk/lib/syntax-highlight.js';
import contextItemRegistry from '../registries/context-item-registry.js';
import apiService from '../services/api.js';
import { plain } from '../model/item-accessor.js';
import { itemGoal } from '../model/thread-alias.js';
import { stripThinkingTags } from './content-utils.js';
import { getThreadDisplayContent, paintThreadSummary } from './thread-display.js';
import { wrapWithIcon, createErrorArticle } from './icon-message-renderer.js';
import { badgeForItem, iconOptionsForItem } from './item-badge.js';
import { textOf, toolSummary } from './conversation-markdown.js';
import { itemSummaryText } from './item-text.js';
import { t } from '../../sdk/lib/i18n.js';
import { displayConversationName } from '../model/conversation-naming.js';

/** Longest a tool's input or output may run in the page before it is cut. */
const TOOL_SECTION_MAX_CHARS = 20_000;

/** Where the footer sends a reader. */
const JUGGLER_URL = 'https://juggler.studio';

/** The app's cascade layers, lowest first — `web/css/manifest.json`. */
const LAYER_ORDER = '@layer tokens, base, layout, patterns, components, vendor, utilities;';

/** Elements that fetch or run something, and have no business in the page. */
const FORBIDDEN_TAGS = ['script', 'link', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'base', 'meta', 'noscript', 'button', 'input', 'select', 'textarea', 'form', 'audio', 'video', 'source', 'track'];

/** Attributes that make a browser fetch what they name. */
const RESOURCE_ATTRS = ['src', 'srcset', 'poster', 'data', 'background', 'action', 'formaction', 'lowsrc', 'dynsrc', 'ping'];

/** Pseudo-classes that describe interaction, not structure: a static page can't match them, but its rules still apply when it is used. */
const DYNAMIC_PSEUDO = /:(?:hover|focus-visible|focus-within|focus|active|visited|link|any-link|target)\b/g;

/** Pseudo-elements, which `querySelector` cannot match on their own. */
const PSEUDO_ELEMENT = /::?(?:before|after|marker|placeholder|selection|backdrop|first-line|first-letter|file-selector-button|-webkit-[\w-]+|-moz-[\w-]+)(?:\([^)]*\))?/g;

/**
 * @typedef {object} ExportOptions
 * @property {boolean} [includeToolDetails=false] - Each tool row expands to its input and output.
 * @property {boolean} [includeFiles=false] - Images, and output that is file contents.
 * @property {(ref: {id: string, mime?: string}) => Promise<string|null>} [loadAsset] - Resolves an
 *   attachment to a data: URI. Defaults to fetching it from this conversation's asset route.
 * @property {Date} [now] - When the export was made, for the header.
 */

/** @typedef {import('../model/conversation.js').default} Conversation */
/** @typedef {import('../../sdk/lib/message.js').Message} Message */
/** @typedef {import('../../sdk/lib/message.js').ToolActionResult} ToolActionResult */
/** @typedef {{id: string, mime?: string, filename?: string, width?: number, height?: number}} ImageRef */

/**
 * A stored value as a plain record, or null when it is not an object.
 * @param {unknown} value - A plain value (already materialised from any Y type).
 * @returns {Record<string, unknown>|null} The record, or null.
 */
function asRecord(value) {
  return value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : null;
}

/**
 * @typedef {object} RenderContext
 * @property {Document} doc - The inert document the page is built in.
 * @property {Conversation|undefined} conversation - The Conversation model.
 * @property {import('../model/message-thread.js').MessageThread|undefined} messageThread - The root MessageThread.
 * @property {import('./thread-display.js').SiblingArray|undefined} siblingArray - The Y.Array the items stand in.
 * @property {boolean} includeToolDetails - See {@link ExportOptions}.
 * @property {boolean} includeFiles - See {@link ExportOptions}.
 * @property {Map<string, string>} assets - Attachment id → data: URI, loaded up front.
 */

/**
 * A whole conversation — its root thread — as a self-contained HTML page. The
 * conversation must be loaded (see `Session.ensureConversationLoaded`).
 * @param {Conversation|null|undefined} conversation - A Conversation model.
 * @param {ExportOptions} [options] - What to include.
 * @returns {Promise<string>} The page, from `<!DOCTYPE html>`.
 */
export async function conversationToHtml(conversation, options = {}) {
  const { includeToolDetails = false, includeFiles = false, now = new Date() } = options;
  const messageThread = conversation?.rootMessageThread;
  const items = messageThread ? messageThread.items : [];
  const loadAsset = options.loadAsset || ((ref) => fetchAssetAsDataUri(conversation?.id || '', ref));

  /** @type {Map<string, string>} */
  const assets = new Map();
  if (includeFiles) {
    for (const ref of imageRefsIn(items)) {
      if (assets.has(ref.id)) continue;
      try {
        const uri = await loadAsset(ref);
        if (uri && /^data:image\//i.test(uri)) assets.set(ref.id, uri);
      } catch {
        // An image that will not load is left out; the row says so.
      }
    }
  }

  const doc = document.implementation.createHTMLDocument('');
  const theme = document.documentElement.getAttribute('data-theme') || 'light';
  doc.documentElement.setAttribute('data-theme', theme);
  doc.documentElement.setAttribute('lang', 'en');

  /** @type {RenderContext} */
  const ctx = {
    doc, conversation: conversation ?? undefined, messageThread, siblingArray: messageThread?.yarray ?? undefined,
    includeToolDetails, includeFiles, assets,
  };

  const main = doc.createElement('main');
  main.className = 'export-page';
  const name = conversation?.name ? displayConversationName(conversation.name) : '';
  main.appendChild(renderHeader(doc, name, now));
  const list = doc.createElement('div');
  list.className = 'conversation-message-list-inner export-items';
  for (const item of items) {
    const exported = exportRow(item, ctx);
    if (exported) list.appendChild(exported);
  }
  main.appendChild(list);
  main.appendChild(renderFooter(doc));
  doc.body.appendChild(main);

  harden(doc.body);

  const appCss = stripRemoteUrls(collectUsedCss(doc));
  const title = `${name || t('Conversation')} — Juggler`; // i18n-ignore: the app's name
  return [
    '<!DOCTYPE html>',
    `<html lang="en" data-theme="${escapeAttr(theme)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="Juggler">',
    `<title>${escapeText(title)}</title>`,
    `<style>\n${appCss}\n</style>`,
    `<style>\n${EXPORT_CSS}\n</style>`,
    '</head>',
    `<body>\n${doc.body.innerHTML}\n</body>`,
    '</html>',
    '',
  ].join('\n');
}

/**
 * A file name for an exported conversation: its name, made safe for any file
 * system, with `.html`.
 * @param {string} name - The conversation's name as shown (`displayConversationName`).
 * @returns {string} The suggested file name.
 */
export function exportFileName(name) {
  const cleaned = String(name || '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}_\s.-]+/gu, ' ')
    .trim()
    .replace(/\s+/g, '-');
  // Cut by character, not UTF-16 unit, so no surrogate pair is split.
  const stem = Array.from(cleaned).slice(0, 80).join('').replace(/^[.-]+|[.-]+$/g, '');
  return `${stem || 'conversation'}.html`;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * One row of the page, or null for an item that is not conversation.
 * @param {Message} item - A thread item.
 * @param {RenderContext} ctx - Render context.
 * @returns {HTMLElement|null} The row.
 */
function exportRow(item, ctx) {
  if (isUserMessage(item)) return renderUser(item, ctx);
  if (isAssistantMessage(item)) return renderAssistant(item, ctx);
  if (isToolActionMessage(item)) return renderTool(item, ctx);
  if (isThreadMessage(item)) return renderThread(item, ctx);
  if (isErrorMessage(item)) return renderError(item, ctx);
  return null;
}

/**
 * Fill a row: the host is made under the live component's tag name, so the
 * transcript's own rules apply to it.
 * @param {HTMLElement} host - The row element.
 * @param {HTMLElement} article - The row's article.
 * @returns {HTMLElement} The host.
 */
function fillRow(host, article) {
  host.classList.add('conversation-item');
  host.appendChild(host.ownerDocument.adoptNode(article));
  return host;
}

/**
 * The user's message: Markdown when it reads as Markdown, verbatim otherwise,
 * exactly as `<user-message>` decides; then its images when files are in.
 * @param {import('../../sdk/lib/message.js').UserMessage} item - User message item.
 * @param {RenderContext} ctx - Render context.
 * @returns {HTMLElement|null} The row.
 */
function renderUser(item, ctx) {
  const { doc } = ctx;
  const content = textOf(item);
  const refs = imageRefs(item);
  if (!content && !refs.length) return null;

  const article = doc.createElement('article');
  article.className = 'user';
  if (content) {
    const text = doc.createElement('div');
    text.className = 'user-message-text';
    if (looksLikeMarkdown(content)) {
      text.innerHTML = renderMarkdownWrapped(content, { escapeXml: true });
      decorateCodeBlocks(text);
    } else {
      text.classList.add('plain');
      text.textContent = content;
    }
    article.appendChild(text);
  }
  const images = renderImages(refs, ctx, true);
  if (images) article.appendChild(images);
  if (!article.childNodes.length) return null;
  return fillRow(doc.createElement('user-message'), article);
}

/**
 * The agent's reply, rendered as the transcript renders it.
 * @param {import('../../sdk/lib/message.js').AssistantMessage} item - Assistant message item.
 * @param {RenderContext} ctx - Render context.
 * @returns {HTMLElement|null} The row.
 */
function renderAssistant(item, ctx) {
  const { doc } = ctx;
  const content = stripThinkingTags(textOf(item));
  if (!content) return null;
  const article = doc.createElement('article');
  article.className = 'assistant';
  const box = doc.createElement('div');
  box.className = 'message-content-box';
  box.innerHTML = renderAssistantContentWrapped(content);
  decorateCodeBlocks(box);
  article.appendChild(box);
  return fillRow(doc.createElement('assistant-message'), article);
}

/**
 * A tool call: the plugin's own one-line status, as the transcript shows it,
 * and — with tool details on — a collapsed `<details>` holding its input and
 * output.
 * @param {import('../../sdk/lib/message.js').ToolActionMessage} item - Tool-action item.
 * @param {RenderContext} ctx - Render context.
 * @returns {HTMLElement} The row.
 */
function renderTool(item, ctx) {
  const { doc } = ctx;
  const toolName = String(itemField(item, 'toolName') || 'tool');
  const ToolClass = contextItemRegistry.getByToolName(toolName) || null;
  /** @type {unknown} */
  const storedInput = plain(itemField(item, 'toolInput'));
  const input = asRecord(storedInput) ?? {};
  /** @type {unknown} */
  const storedResult = plain(itemField(item, 'result'));
  const result = /** @type {ToolActionResult|null} */ (asRecord(storedResult));

  const status = renderResultStatusMessage(toolStatus(item, ToolClass, input, result, ctx));
  const article = doc.createElement('article');
  article.className = result?.isError || result?.fullResult?.error ? 'error' : 'action';
  article.appendChild(wrapWithIcon(status, iconOptionsForItem(item, toolBadgeContext(ctx))));
  const content = /** @type {HTMLElement|null} */ (article.querySelector('.message-content-box'));

  if (ctx.includeToolDetails && content) {
    const isFileContent = safeCall(() => !!ToolClass?.resultIsFileContent?.(toolName.toLowerCase()), false);
    content.appendChild(renderToolDetails(doc, input, result, isFileContent && !ctx.includeFiles));
  }
  const images = renderImages(imageRefs(item), ctx, false);
  if (images && content) content.appendChild(images);

  const host = doc.createElement('tool-action-message');
  host.classList.add('export-tool');
  return fillRow(host, article);
}

/**
 * The status line for a tool row. Asks the tool's plugin, as the live row
 * does, and falls back to the tool's name and the one argument that says what
 * the call was for.
 * @param {unknown} item - Tool-action item.
 * @param {typeof import('juggler/context-item').default|null} ToolClass - The plugin class, or null.
 * @param {Record<string, unknown>} input - The call's input.
 * @param {ToolActionResult|null} result - The call's stored result, or null.
 * @param {RenderContext} ctx - Render context.
 * @returns {import('../../sdk/lib/html.js').ResultStatusMessage} The status.
 */
function toolStatus(item, ToolClass, input, result, ctx) {
  const toolName = String(itemField(item, 'toolName') || 'tool');
  const cancelled = !!result?.cancelled || itemField(item, 'state') === 'cancelled';
  if (ToolClass && typeof ToolClass.prototype?.getStatusUI === 'function') {
    const config = safeCall(() => {
      // An export may run outside the conversation's live session; a plugin
      // that needs one throws, and the row falls back to the plain status.
      const instance = new ToolClass(/** @type {import('../../sdk/context-item-types.js').ItemContext} */ ({
        id: 'conversation-export',
        session: ctx.conversation?.session,
        conversation: ctx.conversation,
        messageThread: ctx.messageThread,
      }));
      const full = result?.fullResult || null;
      /** @type {Record<string, unknown>} */
      const status = full
        ? { content: result?.content || '', ...(cancelled ? { cancelled: true } : {}), ...full }
        : { content: result?.content || '', cancelled, pending: !result && !cancelled };
      const actionResult = /** @type {import('../services/action-executor.js').ActionStatus} */ (status);
      const toolUseId = itemField(item, 'toolUseId');
      const statusContext = {
        conversation: ctx.conversation,
        messageThread: ctx.messageThread,
        session: ctx.conversation?.session,
        toolUseId: typeof toolUseId === 'string' ? toolUseId : undefined,
      };
      return instance.getStatusUI(actionResult, input, statusContext);
    }, null);
    if (config && (config.summary || config.typeName)) {
      if (!config.typeName) config.typeName = badgeForItem(item, toolBadgeContext(ctx)).typeName || toolName;
      return config;
    }
  }
  return {
    typeName: safeCall(() => badgeForItem(item, toolBadgeContext(ctx)).typeName, '') || toolName,
    summary: toolSummary(item),
    status: cancelled ? 'cancelled' : (result?.isError ? 'error' : (result ? 'success' : 'running')),
  };
}

/**
 * What the badge resolver needs to name a tool row.
 * @param {RenderContext} ctx - Render context.
 * @returns {import('./item-badge.js').BadgeContext} Badge context.
 */
function toolBadgeContext(ctx) {
  return { conversation: ctx.conversation, messageThread: ctx.messageThread, fallbackType: 'tool-action' };
}

/**
 * A tool's input and output, collapsed behind one disclosure.
 * @param {Document} doc - The page's document.
 * @param {Record<string, unknown>} input - The call's input.
 * @param {ToolActionResult|null} result - The call's stored result, or null.
 * @param {boolean} withholdOutput - The output is file contents the user left out.
 * @returns {HTMLElement} The `<details>`.
 */
function renderToolDetails(doc, input, result, withholdOutput) {
  const details = doc.createElement('details');
  details.className = 'export-tool-details';
  const summary = doc.createElement('summary');
  summary.textContent = t('Details');
  details.appendChild(summary);

  const inputText = JSON.stringify(input, null, 2);
  if (inputText && inputText !== '{}') details.appendChild(codeSection(doc, 'Input', inputText, 'json'));

  if (withholdOutput) {
    const note = doc.createElement('p');
    note.className = 'export-withheld';
    note.textContent = t('Output omitted: file contents were not included in this export.');
    details.appendChild(note);
  } else {
    const output = typeof result?.content === 'string' && result.content
      ? result.content
      : String(result?.fullResult?.error || '');
    if (output) details.appendChild(codeSection(doc, 'Output', output, ''));
  }
  return details;
}

/**
 * A labelled block of code, cut at {@link TOOL_SECTION_MAX_CHARS}.
 * @param {Document} doc - The page's document.
 * @param {string} label - Its heading.
 * @param {string} text - The code.
 * @param {'json'|''} language - 'json' to highlight it, '' for plain text.
 * @returns {HTMLElement} The section.
 */
function codeSection(doc, label, text, language) {
  const section = doc.createElement('section');
  section.className = 'export-tool-section';
  const heading = doc.createElement('h4');
  heading.textContent = label;
  section.appendChild(heading);
  const cut = text.length > TOOL_SECTION_MAX_CHARS;
  const shown = cut ? text.slice(0, TOOL_SECTION_MAX_CHARS) : text;
  const pre = doc.createElement('pre');
  const code = doc.createElement('code');
  if (language === 'json') {
    code.className = 'language-json';
    code.innerHTML = highlightCode(shown, 'json');
  } else {
    code.textContent = shown;
  }
  pre.appendChild(code);
  section.appendChild(pre);
  if (cut) {
    const note = doc.createElement('p');
    note.className = 'export-withheld';
    note.textContent = t('Truncated: {count} more characters not shown.', { count: (text.length - TOOL_SECTION_MAX_CHARS).toLocaleString() });
    section.appendChild(note);
  }
  return section;
}

/**
 * A sub-thread: its goal under the thread badge, and the answer it handed back,
 * painted by the tile's own summary painter.
 * @param {import('../../sdk/lib/message.js').ThreadMessage} item - Thread item.
 * @param {RenderContext} ctx - Render context.
 * @returns {HTMLElement} The row.
 */
function renderThread(item, ctx) {
  const { doc } = ctx;
  const article = doc.createElement('article');
  article.className = 'thread-item';
  const goal = doc.createElement('div');
  goal.className = 'thread-goal llm-description';
  goal.textContent = itemGoal(item, ctx.siblingArray) || t('Sub-thread');
  const badge = badgeForItem(item, { fallbackType: 'thread' });
  article.appendChild(wrapWithIcon(goal, { ...badge, badge: badge.typeName }));

  const text = getThreadDisplayContent(item, ctx.siblingArray).text.trim();
  if (text) {
    const body = doc.createElement('div');
    body.className = 'thread-body message-row-body';
    const summary = doc.createElement('div');
    paintThreadSummary(summary, text);
    body.appendChild(summary);
    article.appendChild(body);
  }
  return fillRow(doc.createElement('thread-message'), article);
}

/**
 * An error, as the transcript's error row shows it.
 * @param {import('../../sdk/lib/message.js').ErrorMessage} item - Error item.
 * @param {RenderContext} ctx - Render context.
 * @returns {HTMLElement|null} The row.
 */
function renderError(item, ctx) {
  const text = itemSummaryText(item).trim() || String(plain(itemField(item, 'message')) || '').trim() || textOf(item);
  if (!text) return null;
  return fillRow(ctx.doc.createElement('error-message'), createErrorArticle(text));
}

/**
 * The images an item carries, inlined — or nothing when files are out.
 * @param {Array<{id: string, mime?: string, filename?: string, width?: number, height?: number}>} refs - Image refs.
 * @param {RenderContext} ctx - Render context.
 * @param {boolean} attached - Attached to a user message, so styled as the transcript styles those.
 * @returns {HTMLElement|null} The grid.
 */
function renderImages(refs, ctx, attached) {
  if (!ctx.includeFiles || !refs.length) return null;
  const grid = ctx.doc.createElement('div');
  grid.className = attached ? 'user-message-attachments' : 'export-images';
  for (const ref of refs) {
    const uri = ctx.assets.get(ref.id);
    if (!uri) {
      const missing = ctx.doc.createElement('span');
      missing.className = 'export-withheld';
      missing.textContent = t('[image not available: {name}]', { name: ref.filename || ref.id });
      grid.appendChild(missing);
      continue;
    }
    const img = ctx.doc.createElement('img');
    img.className = attached ? 'user-message-attachment' : 'export-image';
    img.alt = ref.filename || t('Image');
    if (ref.width) img.width = ref.width;
    if (ref.height) img.height = ref.height;
    img.src = uri;
    grid.appendChild(img);
  }
  return grid;
}

/**
 * The page's heading: the conversation's name and when it was exported.
 * @param {Document} doc - The page's document.
 * @param {string} name - The conversation's name.
 * @param {Date} now - When.
 * @returns {HTMLElement} The header.
 */
function renderHeader(doc, name, now) {
  const header = doc.createElement('header');
  header.className = 'export-header';
  const h1 = doc.createElement('h1');
  h1.textContent = name || t('Conversation');
  header.appendChild(h1);
  const meta = doc.createElement('p');
  meta.className = 'export-meta';
  meta.textContent = t('Exported {date}', { date: now.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) });
  header.appendChild(meta);
  return header;
}

/**
 * The credit line.
 * @param {Document} doc - The page's document.
 * @returns {HTMLElement} The footer.
 */
function renderFooter(doc) {
  const footer = doc.createElement('footer');
  footer.className = 'export-footer';
  footer.append(`${t('Made with Juggler')} — `);
  const link = doc.createElement('a');
  link.href = JUGGLER_URL;
  link.textContent = 'juggler.studio'; // i18n-ignore: a domain name
  footer.appendChild(link);
  return footer;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/**
 * The image attachments an item carries.
 * @param {unknown} item - A thread item.
 * @returns {ImageRef[]} The refs.
 */
function imageRefs(item) {
  /** @type {unknown} */
  const refs = plain(itemField(item, 'attachments'));
  if (!Array.isArray(refs)) return [];
  return refs.flatMap((entry) => {
    const ref = asRecord(entry);
    if (!ref || typeof ref.id !== 'string' || !ref.id) return [];
    if (ref.mime && !String(ref.mime).startsWith('image/')) return [];
    return [/** @type {ImageRef} */ (ref)];
  });
}

/**
 * Every image the exported rows can show.
 * @param {Message[]} items - Thread items.
 * @returns {ImageRef[]} The refs, in order.
 */
function imageRefsIn(items) {
  return items.filter((item) => isUserMessage(item) || isToolActionMessage(item)).flatMap(imageRefs);
}

/**
 * Fetch one of the conversation's assets as a data: URI.
 * @param {string} conversationId - The conversation.
 * @param {{id: string}} ref - The asset.
 * @returns {Promise<string|null>} The data: URI, or null when it will not load.
 */
async function fetchAssetAsDataUri(conversationId, ref) {
  const response = await fetch(apiService.assetURL(conversationId, ref.id));
  if (!response.ok) return null;
  const blob = await response.blob();
  return new Promise((resolve) => {
    const reader = new window.FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------------------
// Self-containment
// ---------------------------------------------------------------------------

/**
 * Remove everything that would fetch or run when the page is opened. A remote
 * image becomes a link to it; every other resource that is not a data: URI is
 * dropped. Links stay.
 * @param {HTMLElement} root - The page body.
 */
function harden(root) {
  Array.from(root.querySelectorAll(FORBIDDEN_TAGS.join(','))).forEach((el) => el.remove());
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const src = img.getAttribute('src') || '';
    if (isDataUri(src)) continue;
    if (/^https?:/i.test(src)) {
      const link = root.ownerDocument.createElement('a');
      link.href = src;
      link.textContent = img.getAttribute('alt') || src;
      img.replaceWith(link);
    } else {
      img.remove();
    }
  }
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith('on')
        || (RESOURCE_ATTRS.includes(name) && !isDataUri(value))
        || /^(?:javascript|vbscript):/i.test(value)
        || (el.namespaceURI === 'http://www.w3.org/2000/svg' && /(?:^|:)href$/.test(name)
          && !value.startsWith('#') && !isDataUri(value))) {
        el.removeAttribute(attr.name);
      }
    }
    const style = el.getAttribute('style');
    if (style && /url\(|@import/i.test(style)) el.setAttribute('style', stripRemoteUrls(style));
  }
  for (const style of Array.from(root.querySelectorAll('style'))) {
    style.textContent = stripRemoteUrls(style.textContent || '');
  }
}

/**
 * CSS with every `@import` and every `url()` that is not a data: URI taken out.
 * A declaration left holding `none` where a url was is either still valid or
 * dropped by the browser — either way it fetches nothing.
 * @param {string} css - Stylesheet text.
 * @returns {string} The same, fetching nothing.
 */
function stripRemoteUrls(css) {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (whole, _q, url) => (isDataUri(url) ? whole : 'none'));
}

/**
 * @param {string} value - A URL.
 * @returns {boolean} Whether it is a data: URI.
 */
function isDataUri(value) {
  return /^\s*data:/i.test(value);
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

/**
 * The app's live cascade, cut down to the rules the page uses: every style
 * rule whose selector matches something in it (interaction states counted as
 * matching), inside the same `@layer`, `@media` and `@supports` blocks, plus
 * every `@property`. Fonts and animations are left out — the page uses the
 * font stacks' system fallbacks and has nothing that moves.
 * @param {Document} doc - The exported page.
 * @returns {string} Stylesheet text.
 */
function collectUsedCss(doc) {
  /** @type {string[]} */
  const parts = [LAYER_ORDER];
  /** @type {Map<string, boolean>} */
  const seen = new Map();
  for (const sheet of Array.from(document.styleSheets)) {
    /** @type {CSSRuleList|null} */
    let rules = null;
    try { rules = sheet.cssRules; } catch { rules = null; }
    if (!rules) continue;
    const text = usedRules(rules, doc, seen);
    if (text) parts.push(text);
  }
  return parts.join('\n');
}

/**
 * The rules of one list the page uses, as text.
 * @param {CSSRuleList} rules - A rule list.
 * @param {Document} doc - The exported page.
 * @param {Map<string, boolean>} seen - Selector → whether it matched, memoised.
 * @returns {string} The rules, or ''.
 */
function usedRules(rules, doc, seen) {
  // The CSSOM rule classes, read off the window: a missing one (an engine
  // without @layer, say) simply matches nothing.
  const is = (/** @type {CSSRule} */ rule, /** @type {string} */ kind) => {
    /** @type {unknown} */
    const ctor = Reflect.get(window, kind);
    return typeof ctor === 'function' && rule instanceof ctor;
  };
  /** @type {string[]} */
  const out = [];
  for (const rule of Array.from(rules)) {
    if (is(rule, 'CSSStyleRule')) {
      const style = /** @type {CSSStyleRule} */ (rule);
      if (selectorUsed(style.selectorText, doc, seen)) out.push(style.cssText);
    } else if (is(rule, 'CSSLayerBlockRule')) {
      const layer = /** @type {CSSLayerBlockRule} */ (rule);
      const inner = usedRules(layer.cssRules, doc, seen);
      if (inner) out.push(`@layer ${layer.name} {\n${inner}\n}`);
    } else if (is(rule, 'CSSMediaRule')) {
      const media = /** @type {CSSMediaRule} */ (rule);
      const inner = usedRules(media.cssRules, doc, seen);
      if (inner) out.push(`@media ${media.conditionText || media.media.mediaText} {\n${inner}\n}`);
    } else if (is(rule, 'CSSSupportsRule')) {
      const supports = /** @type {CSSSupportsRule} */ (rule);
      const inner = usedRules(supports.cssRules, doc, seen);
      if (inner) out.push(`@supports ${supports.conditionText} {\n${inner}\n}`);
    } else if (is(rule, 'CSSPropertyRule')) {
      out.push(rule.cssText);
    }
  }
  return out.join('\n');
}

/**
 * Whether any selector in a list matches something in the page, reading
 * interaction states and pseudo-elements as their element.
 * @param {string} selectorText - A selector list.
 * @param {Document} doc - The exported page.
 * @param {Map<string, boolean>} seen - Memo.
 * @returns {boolean} Whether the rule applies to the page.
 */
function selectorUsed(selectorText, doc, seen) {
  const memo = seen.get(selectorText);
  if (memo !== undefined) return memo;
  let used = false;
  for (const selector of splitSelectorList(selectorText)) {
    const structural = selector.replace(PSEUDO_ELEMENT, '').replace(DYNAMIC_PSEUDO, '').trim() || '*';
    try {
      if (doc.querySelector(structural.replace(/(^|[\s>+~(,])$/, '$1*'))) { used = true; break; }
    } catch {
      // A selector this engine can't parse here can't match here either.
    }
  }
  seen.set(selectorText, used);
  return used;
}

/**
 * Split a selector list at its top-level commas, leaving those inside
 * `:is()`, `:where()`, `:not()` and attribute values alone.
 * @param {string} list - A selector list.
 * @returns {string[]} The selectors.
 */
function splitSelectorList(list) {
  /** @type {string[]} */
  const out = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === '\'') quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { out.push(list.slice(start, i)); start = i + 1; }
  }
  out.push(list.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * The page's own layout — a readable column, the header and footer, and the
 * tool details — on top of the app's rules. Unlayered, so it wins over them,
 * as an extension's stylesheet does.
 */
const EXPORT_CSS = `
html, body { height: auto; overflow: visible; }
body { margin: 0; background: var(--bg-primary); color: var(--text-primary); }
.export-page { box-sizing: border-box; max-width: 52rem; margin: 0 auto; padding: 2.5rem 1.25rem 1.5rem; }
.export-header { margin-bottom: 1.5rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border-divider); }
.export-header h1 { margin: 0; font-size: var(--font-size-2xl); font-weight: 600; line-height: 1.25; }
.export-meta { margin: 0.35rem 0 0; color: var(--text-secondary); font-size: var(--font-size-sm); }
.export-items { gap: 0.25rem; }
.export-items > * { display: block; }
.export-items .action-result-summary { white-space: normal; overflow-wrap: anywhere; }
.export-tool-details { margin: 0.25rem 0 0.5rem; font-size: var(--font-size-sm); }
.export-tool-details > summary { cursor: pointer; color: var(--text-secondary); user-select: none; }
.export-tool-details[open] > summary { margin-bottom: 0.25rem; }
.export-tool-section h4 { margin: 0.5rem 0 0.25rem; font-size: var(--font-size-xs); font-weight: 600;
  color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.04em; }
.export-tool-section pre { margin: 0; max-height: 32rem; overflow: auto; padding: 0.5rem 0.75rem;
  background: var(--bg-code-medium); border: 1px solid var(--border-code); border-radius: var(--radius-md);
  font-family: var(--font-mono); font-size: var(--font-size-xs); white-space: pre-wrap; overflow-wrap: anywhere; }
.export-tool-section pre code { font: inherit; white-space: inherit; }
.export-withheld { margin: 0.25rem 0; color: var(--text-tertiary); font-size: var(--font-size-xs); font-style: italic; }
.export-images { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.5rem; }
.export-images img, .user-message-attachment { max-width: 100%; height: auto; }
.export-image { max-height: 24rem; border-radius: var(--radius-md); }
.export-footer { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid var(--border-divider);
  color: var(--text-tertiary); font-size: var(--font-size-xs); text-align: center; }
.export-footer a { color: inherit; }
@media print { .export-tool-details > summary { display: none; } }
`.trim();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Run something that may throw on an item it was not written for.
 * @template T
 * @param {() => T} fn - The call.
 * @param {T} fallback - What to use when it throws.
 * @returns {T} Its result, or the fallback.
 */
function safeCall(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

/**
 * @param {string} text - Text for an element's body.
 * @returns {string} The text, escaped.
 */
function escapeText(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * @param {string} text - Text for a double-quoted attribute.
 * @returns {string} The text, escaped.
 */
function escapeAttr(text) {
  return escapeText(text).replace(/"/g, '&quot;');
}
