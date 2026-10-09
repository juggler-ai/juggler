//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Per-item-type renderers for the properties panel.
 *
 * Each renderer accepts the panel host (for shared section/header helpers
 * and live-updater binding) and the container plus the item to render. The
 * registry below dispatches by item type — adding a new conversation-item
 * type means adding a renderer function plus a registry entry, not editing
 * properties-panel.js's render method.
 *
 * Renderers stay coupled to the panel host for two reasons:
 *  - `host._createSectionWithControls` / `_renderXxxControls` produce the
 *    same chrome the panel uses elsewhere (live-updater fast path,
 *    delete/branch controls, view-transaction button). Lifting that to a
 *    standalone module would be a larger refactor than the architectural
 *    payoff justifies.
 *  - `host._liveUpdater = fn` is how a streaming render registers its
 *    delta-patch closure with the panel's observer dispatch.
 */

import { renderAssistantContent, decorateCodeBlocks } from '../../../sdk/lib/markdown.js';
import { createStreamingMarkdown } from '../../utils/streaming-markdown.js';
import { stripThinkingTags } from '../../utils/content-utils.js';
import { formatDuration } from '../../utils/format.js';
import { badgeForItem } from '../../utils/item-badge.js';
import { readItemData } from '../../utils/item-data.js';
import { getThreadDisplayContent, getThreadStatus, paintThreadSummary } from '../../utils/thread-display.js';
import contextItemRegistry from '../../registries/context-item-registry.js';
import * as panelHelpers from '../../utils/properties-panel-helpers.js';
import { applyAnsi } from '../../../sdk/lib/ansi.js';
import { TOOL_STATES } from '../../../sdk/lib/message.js';
import { normalizeAttachments, formatAttachmentBytes } from '../../utils/attachments.js';
import { createImageThumb } from '../../utils/image-lightbox.js';
import { renderTaskDeliveryControl } from '../../../sdk/lib/task-delivery-control.js';
import apiService from '../../services/api.js';
import { plain, yGet } from '../../model/item-accessor.js';
import { itemGoal } from '../../model/thread-alias.js';

/**
 * Normalise a Yjs Y.Map result (or already-plain object) to a plain JS object.
 * Centralises the `r.get ? r.get(k) : r[k]` pattern used throughout this module.
 * @param {any} r - Raw result value from toolAction.get('result')
 * @returns {{isError?: boolean, cancelled?: boolean, content?: string, output?: string, fullResult?: {error?: string, durationMs?: number}}} Normalised plain-object view of the result
 */
function resolveResult(r) {
  return plain(r) || {};
}

/**
 * Construct a plugin instance for the selected tool action, used to render its
 * tool-specific input/details section (`renderToolActionDetails`). The badge
 * itself comes from the shared `badgeForItem` resolver — this instance only
 * drives the panel-only details body. Returns null if construction throws.
 * @param {PanelHost} host
 * @param {any} PluginClass
 * @returns {any} Plugin instance, or null if construction throws
 */
function makeActionInstance(host, PluginClass) {
  try {
    return new PluginClass({
      id: host._selectedItemId || 'properties-panel',
      session: host._conversation?.session,
      conversation: host._conversation,
      messageThread: host._messageThread,
    });
  } catch {
    return null;
  }
}

/**
 * Badge-resolution context for the panel, sourced from the host.
 * @param {PanelHost} host
 * @returns {{conversation: any, messageThread: any}} Context for badgeForItem
 */
function badgeCtx(host) {
  return { conversation: host._conversation, messageThread: host._messageThread };
}

/**
 * Renderer host contract. Implemented by PropertiesPanel; we describe the
 * surface the renderers need rather than referencing the class directly so
 * TS doesn't fight us about per-class private-field access from this module.
 * @typedef {object} PanelHost
 * @property {any} _messageThread Current MessageThread (or null).
 * @property {any} _conversation Current Conversation (or null).
 * @property {string|null} _selectedItemId Currently selected item id.
 * @property {((...args: any[]) => HTMLElement)} _createSectionWithControls Builds a section wrapper with header + controls.
 * @property {((msg: any) => HTMLElement)} _renderMessageControls Controls strip for plain-message rows.
 * @property {((item: any) => HTMLElement)} _renderContextItemControls Controls strip for context-item rows.
 * @property {((action: any) => HTMLElement)} _renderToolActionControls Controls strip for tool-action rows.
 * @property {((() => boolean) | null)} _liveUpdater Closure the panel calls on same-item updates; returns false to force a full re-render.
 */

/** @typedef {(host: PanelHost, container: Element, item: any) => void} ItemRenderer */

/**
 * Display metadata for each approval-provenance value, keyed by the item's
 * `approvalSource`. Each value names the approving BODY (who granted it), not
 * the mechanism. Mirrors the vocabulary the approval pipeline stamps (see
 * MessageThread.resolveApproval): `user` (a human clicked approve), `rule` (a
 * saved permission rule allowed it), `strategy` (the active strategy approved it
 * without individual confirmation — a force-approve strategy or an out-of-band
 * reviewer), `hook` (a tool hook allowed it — see the Hooks section).
 * @type {Record<string, {label: string, icon: string, title: string}>}
 */
const APPROVAL_SOURCE_META = {
  user: { label: 'User', icon: 'icon-check', title: 'Approved by the user' },
  rule: { label: 'Permitted', icon: 'icon-checklist', title: 'Allowed by a permission rule' },
  strategy: { label: 'Strategy', icon: 'icon-auto-awesome', title: 'Approved by the active strategy' },
  hook: { label: 'Hook', icon: 'icon-checklist', title: 'Approved by a tool hook' }
};

/**
 * Build the approval-provenance badge for a tool-action's properties-panel
 * header — a lozenge matching the item type-name badge, carrying a
 * source-specific leading icon and short label. Returns null when the item
 * carries no (or an unknown) `approvalSource` — e.g. an item added out-of-band
 * that never passed an approval gate — so the header simply omits it.
 * @param {string|undefined} source - The item's `approvalSource` field
 * @returns {HTMLSpanElement|null} The badge element, or null when unset/unknown
 */
export function buildApprovalSourceBadge(source) {
  const meta = source ? APPROVAL_SOURCE_META[source] : undefined;
  if (!meta) return null;
  const badge = document.createElement('span');
  badge.className = `context-item-type-badge properties-panel-approval-badge approval-source-${source}`;
  badge.title = meta.title;
  const icon = document.createElement('span');
  icon.className = meta.icon;
  icon.setAttribute('aria-hidden', 'true');
  badge.appendChild(icon);
  badge.appendChild(document.createTextNode(meta.label));
  return badge;
}

/** @type {ItemRenderer} */
export function renderError(host, container, message) {
  const badge = badgeForItem(message, badgeCtx(host));
  const wrapper = host._createSectionWithControls(
    badge.typeName, badge, host._renderMessageControls(message),
    undefined, message.get('transactionId'), message.get('timestamp') || undefined
  );

  const data = readItemData(message);
  if (data) {
    if (data.provider) panelHelpers.addSubsection(wrapper, 'Provider', data.provider, 'properties-panel-code');
    if (data.model) panelHelpers.addSubsection(wrapper, 'Model', data.model, 'properties-panel-code');
    if (data.duration !== undefined && data.duration !== null) {
      const sec = (data.duration / 1000).toFixed(1);
      panelHelpers.addSubsection(wrapper, 'Duration', `${sec}s`, 'properties-panel-code');
    }
  }

  const timestamp = message.get('timestamp');
  if (timestamp) {
    panelHelpers.addSubsection(wrapper, 'Time', new Date(timestamp).toLocaleTimeString(), 'properties-panel-code');
  }

  const body = document.createElement('properties-panel-body');
  const errorText = message.get('content') || message.get('message') || '';
  body.appendChild(panelHelpers.createCopyableText(errorText, 'properties-panel-result error'));
  wrapper.appendChild(body);
  container.appendChild(wrapper);
}

/** @type {ItemRenderer} */
export function renderMessage(host, container, message) {
  const msgType = message.get('type');
  const isUser = msgType === 'user';
  const isThinking = msgType === 'thinking';

  const badge = badgeForItem(message, badgeCtx(host));
  const wrapper = host._createSectionWithControls(
    badge.typeName,
    badge,
    host._renderMessageControls(message),
    undefined,
    message.get('transactionId'),
    message.get('timestamp') || undefined
  );

  const content = document.createElement('properties-panel-body');
  const msgContent = message.get('content') || '';
  if (isThinking || msgType === 'assistant') {
    content.classList.add('properties-panel-copyable');
    const copyHeader = document.createElement('div');
    copyHeader.className = 'properties-panel-copy-header';
    copyHeader.appendChild(panelHelpers.createCopyButton(() => stripThinkingTags(message.get('content') || '')));
    content.appendChild(copyHeader);
    const markdownEl = document.createElement('div');
    if (isThinking) {
      content.classList.add('properties-panel-thinking');
      // One item type, two wire shapes: a provider either summarises its
      // reasoning as Markdown (OpenAI's reasoning summaries, Gemini's thought
      // parts) or streams raw prose (Anthropic's thinking_delta, the
      // reasoning_content of GLM/DeepSeek), and the server forwards whichever
      // it gets verbatim. createStreamingMarkdown makes that choice per update
      // — Markdown only when a construct is actually present, otherwise the
      // text as it arrived — and renders only the part still in flight, so a
      // block that grows to thousands of tokens doesn't re-parse all of itself
      // on every frame.
      const stream = createStreamingMarkdown(markdownEl, { escapeXml: true });
      let lastRendered = stripThinkingTags(msgContent);
      stream.update(lastRendered);

      // Stream-follow: while a long thinking block streams in, keep the tail in
      // view so the user can watch it grow without manually scrolling. We stop
      // auto-following the moment the user scrolls up (to read back), and resume
      // once they return to the bottom. The scroll container is the enclosing
      // properties-panel-section (overflow-y:auto); it isn't an ancestor yet at
      // setup time, so resolve it lazily on first flush.
      let following = true;
      /** @type {HTMLElement|null} */
      let scroller = null;
      const NEAR_BOTTOM_PX = 32;
      const ensureScroller = () => {
        if (scroller) return;
        scroller = /** @type {HTMLElement|null} */ (content.closest('properties-panel-section'));
        if (scroller) {
          const s = scroller;
          s.addEventListener('scroll', () => {
            following = s.scrollHeight - s.scrollTop - s.clientHeight <= NEAR_BOTTOM_PX;
          }, { passive: true });
        }
      };

      // Two limits on how much a burst of deltas can cost. rAF caps how OFTEN
      // the block is re-rendered — at most once per paint, however many deltas
      // land in between — and the streaming renderer caps how MUCH each render
      // touches, to the tail that is still in flight. The equality guard skips
      // fires where the selected item's content didn't actually change
      // (unrelated doc edits).
      let rafId = 0;
      const flush = () => {
        rafId = 0;
        if (!markdownEl.isConnected) return;
        const latest = stripThinkingTags(message.get('content') || '');
        if (latest === lastRendered) return;
        lastRendered = latest;
        ensureScroller();
        stream.update(latest);
        if (following && scroller) scroller.scrollTop = scroller.scrollHeight;
      };
      host._liveUpdater = () => {
        if (!rafId) rafId = requestAnimationFrame(flush);
        return true;
      };
    } else {
      markdownEl.className = 'markdown';
      markdownEl.innerHTML = renderAssistantContent(stripThinkingTags(msgContent));
      decorateCodeBlocks(markdownEl);
    }
    content.appendChild(markdownEl);
  } else {
    content.appendChild(panelHelpers.createCopyableText(msgContent, 'properties-panel-text'));
  }

  wrapper.appendChild(content);

  // User messages carry image attachments as a single unit with their text;
  // surface them (with whatever metadata the AssetRef holds) below the body.
  if (isUser) {
    renderMessageAttachments(host, wrapper, message);
    // A chunk injected by a background-task output pump (e.g. Monitor) carries a
    // `taskSource` provenance ref. Render the shared status + Stop control so the
    // monitor can be killed from any of its output messages, not just its
    // originating tool-action.
    renderTaskSourceControl(host, wrapper, message);
  }

  container.appendChild(wrapper);
}

/**
 * If a user message carries a `taskSource` provenance ref (it was injected by a
 * background-task output delivery pump), append the shared Monitor status + Stop
 * control bound to that task. No-op for ordinary user messages.
 * @param {PanelHost} host
 * @param {HTMLElement} wrapper - The section wrapper to append into.
 * @param {any} message - The user message Y.Map.
 */
function renderTaskSourceControl(host, wrapper, message) {
  const raw = message.get('taskSource');
  if (!raw) return;
  const ts = plain(raw);
  const taskId = ts?.taskId || '';
  if (!taskId) return;
  renderTaskDeliveryControl(wrapper, {
    messageThread: host._messageThread,
    taskId,
    label: ts?.label || '',
  });
}

/**
 * Append an "Attachments" subsection listing each AssetRef on a user message:
 * an image thumbnail (click → lightbox) alongside whatever details we know —
 * filename, type, intrinsic dimensions and byte size. No-op when the message
 * carries no attachments.
 * @param {PanelHost} host
 * @param {HTMLElement} wrapper - The section wrapper to append into.
 * @param {any} message - The user message Y.Map.
 */
function renderMessageAttachments(host, wrapper, message) {
  const attachments = normalizeAttachments(message.get('attachments'));
  if (attachments.length === 0) return;

  const section = panelHelpers.labeledSubsection(
    attachments.length === 1 ? 'Attachment' : `Attachments (${attachments.length})`
  );

  const list = document.createElement('div');
  list.className = 'properties-panel-attachments';

  const conversationId = host._conversation?.id || '';

  for (const ref of attachments) {
    const isImage = typeof ref.mime === 'string' && ref.mime.startsWith('image/');
    const src = conversationId && ref.id ? apiService.assetURL(conversationId, ref.id) : '';

    const figure = document.createElement('figure');
    figure.className = 'properties-panel-attachment';

    if (isImage && src) {
      figure.appendChild(createImageThumb({
        src,
        alt: ref.filename || 'attachment',
        className: 'properties-panel-attachment-thumb',
        width: ref.width,
        height: ref.height,
      }));
    }

    const caption = document.createElement('figcaption');
    caption.className = 'properties-panel-attachment-caption';

    const name = document.createElement('span');
    name.className = 'properties-panel-attachment-name';
    name.textContent = ref.filename || ref.id || 'attachment';
    name.title = name.textContent;
    caption.appendChild(name);

    // Compose whatever metadata we know into a single muted meta line.
    const metaParts = [];
    if (ref.mime) metaParts.push(ref.mime);
    if (ref.width && ref.height) metaParts.push(`${ref.width}\u00d7${ref.height}`);
    const size = formatAttachmentBytes(ref.bytes);
    if (size) metaParts.push(size);
    if (metaParts.length > 0) {
      const meta = document.createElement('span');
      meta.className = 'properties-panel-attachment-meta';
      meta.textContent = metaParts.join(' \u00b7 ');
      caption.appendChild(meta);
    }

    figure.appendChild(caption);
    list.appendChild(figure);
  }

  section.appendChild(list);
  wrapper.appendChild(section);
}

/** @type {ItemRenderer} */
export function renderContextItem(host, container, contextItem) {
  const isContextItemInstance = typeof /** @type {any} */ (contextItem).getTitle === 'function';

  if (isContextItemInstance) {
    const itemInstance = /** @type {any} */ (contextItem);
    const badge = badgeForItem(itemInstance, badgeCtx(host));
    const wrapper = host._createSectionWithControls(
      badge.typeName, badge, host._renderContextItemControls(itemInstance)
    );

    const itemContent = document.createElement('div');
    itemContent.className = 'context-item-expanded-content';
    try {
      itemContent.appendChild(itemInstance.createPropertiesPanelElement());
    } catch (err) {
      console.error(`[PropertiesPanel] Failed to render context item ${itemInstance.id}:`, err);
      itemContent.textContent = 'Error rendering context item';
    }
    wrapper.appendChild(itemContent);
    container.appendChild(wrapper);

    // A context item with an editable body (e.g. the system prompt's identity
    // textarea) opts into in-place updates: without this, a same-item Yjs change
    // — including the item persisting its OWN edit — routes through the panel's
    // snapshot path and, when the item's title scalar shifts, triggers a full
    // rebuild that destroys the actively-edited field (its drag-set height,
    // focus, and caret). The updater patches in place and returns true to skip
    // the rebuild; returning false (or omitting the method) leaves the snapshot
    // path in charge, unchanged.
    if (typeof itemInstance.updatePropertiesPanel === 'function') {
      host._liveUpdater = () => itemInstance.updatePropertiesPanel(itemContent) !== false;
    }
    return;
  }

  const itemMsg = /** @type {any} */ (contextItem);
  const emptyControls = document.createElement('properties-panel-controls');
  const badge = badgeForItem(itemMsg, badgeCtx(host));
  const wrapper = host._createSectionWithControls(badge.typeName, badge, emptyControls);

  const body = document.createElement('properties-panel-body');
  if (itemMsg.get('error')) {
    body.appendChild(panelHelpers.createCopyableText(itemMsg.get('error'), 'properties-panel-error'));
  } else {
    const info = document.createElement('p');
    info.className = 'properties-panel-text';
    info.textContent = `Item ID: ${itemMsg.get('itemId') || 'Unknown'}`;
    body.appendChild(info);
  }
  wrapper.appendChild(body);
  container.appendChild(wrapper);
}

/** @type {ItemRenderer} */
export function renderToolAction(host, container, toolAction) {
  const taToolName = toolAction.get('toolName');
  const ActionClass = taToolName ? contextItemRegistry.getByToolName(taToolName) : null;

  // The header badge (icon + lozenge) comes from the one shared resolver the
  // conversation tiles use, so the panel header is identical to the tile.
  const badge = badgeForItem(toolAction, badgeCtx(host));

  const toolName = (taToolName || '').toLowerCase();
  const input = yGet(toolAction, 'toolInput') || {};

  // A separate instance drives the panel-only tool-specific input section.
  const actionInstance = ActionClass ? makeActionInstance(host, ActionClass) : null;

  /** @type {string|HTMLElement|undefined} */
  let statusText = undefined;
  const result = toolAction.get('result');
  if (result) {
    const res = resolveResult(result);
    const state = res.cancelled ? 'Cancelled' : res.isError ? 'Failed' : 'Completed';
    const durationMs = res.fullResult?.durationMs;
    statusText = durationMs ? `${state} in ${formatDuration(Math.round(durationMs / 1000))}` : state;
  } else if (toolAction.get('toolUseId')) {
    const isAwaitingApproval = toolAction.get('state') === TOOL_STATES.PENDING;
    if (isAwaitingApproval) {
      statusText = 'Awaiting approval';
    } else {
      // Render as an element carrying data-elapsed-since so the panel's
      // 1s ticker can refresh just the digit without re-rendering the
      // whole tool-action section. The anchor MUST be runningStartedAt
      // (stamped at APPROVED→RUNNING in claimRunning); the item's
      // creation `timestamp` is wrong for re-runs because it's the
      // original creation time, not the start of the current run.
      // Falls back to a plain "Running…" when the field is absent.
      const startMs = Number(toolAction.get('runningStartedAt'));
      const span = document.createElement('span');
      span.className = 'properties-panel-title-status';
      if (Number.isFinite(startMs) && startMs > 0) {
        span.dataset.elapsedSince = String(startMs);
        const seconds = Math.max(0, Math.round((Date.now() - startMs) / 1000));
        span.textContent = `Running… ${formatDuration(seconds)}`;
      } else {
        span.textContent = 'Running…';
      }
      statusText = span;
    }
  }

  const isRunning = !toolAction.get('result') && toolAction.get('toolUseId')
        && toolAction.get('state') !== TOOL_STATES.PENDING;

  const controls = host._renderToolActionControls(toolAction);
  const wrapper = host._createSectionWithControls(
    badge.typeName, badge, controls,
    statusText, toolAction.get('transactionId'), toolAction.get('timestamp') || undefined
  );

  // Approval provenance sits in the header beside the type-name badge (and the
  // duration status), naming who approved this call — only when it was stamped.
  // Injected here rather than through the shared header helper because only
  // tool-actions carry an approvalSource.
  const approvalBadge = buildApprovalSourceBadge(toolAction.get('approvalSource'));
  if (approvalBadge) {
    const header = wrapper.querySelector('.properties-panel-header');
    const iconBadge = header?.querySelector('.message-icon-badge');
    if (iconBadge) {
      iconBadge.insertAdjacentElement('afterend', approvalBadge);
    } else if (header) {
      header.appendChild(approvalBadge);
    }
  }

  if (isRunning) wrapper.setAttribute('data-processing', 'true');

  // Tool-specific input section via plugin polymorphism. Tool-name branching
  // belongs INSIDE plugin classes — see ContextItem.renderToolActionDetails.

  /** @type {{ skipResultSection?: boolean, controls?: HTMLElement[] } | void} */
  let renderResult = undefined;
  if (actionInstance) {
    renderResult = /** @type {any} */ (actionInstance).renderToolActionDetails(wrapper, {
      toolAction,
      toolName,
      input,
      helpers: panelHelpers,
      conversation: host._conversation,
      messageThread: host._messageThread,
      session: host._conversation?.session ?? null,
      selectedItemId: host._selectedItemId,
    });
  } else {
    const inputText = JSON.stringify(input, null, 2);
    if (inputText !== '{}') {
      panelHelpers.addSubsection(wrapper, 'Input', inputText, 'properties-panel-code', { language: 'json' });
    }
  }

  // A plugin's own controls lead the block: they act on what this call made,
  // and the framework's (Re-run, Delete) act on the call itself.
  const extraControls = (renderResult?.controls || []).filter(Boolean);
  if (extraControls.length) controls.prepend(...extraControls);

  if (!renderResult?.skipResultSection) {
    const resultLabel = ActionClass
      ? /** @type {any} */ (ActionClass).getResultSectionLabel(toolName)
      : 'Result';

    // Terminal-output plugins (bash) carry ANSI colour codes in their
    // output — render through the ANSI parser so colours show and stray
    // escapes don't appear as literal garbage. Plain-text tools opt out.
    const isTerminal = !!(ActionClass && /** @type {any} */ (ActionClass).rendersTerminalOutput?.());

    const resultSection = panelHelpers.labeledSubsection(resultLabel);

    const r = toolAction.get('result');
    if (r) {
      const res = resolveResult(r);
      if (res.isError) {
        // fullResult.error has the canonical message; fall back to the
        // human-readable content string written for the LLM.
        const errText = res.fullResult?.error || res.content || 'Error';
        resultSection.appendChild(panelHelpers.createCopyableText(errText, 'properties-panel-result error'));
      } else if (res.cancelled) {
        const div = document.createElement('div');
        div.className = 'properties-panel-result cancelled';
        div.textContent = 'Cancelled';
        resultSection.appendChild(div);
      } else {
        // A successful result whose `content`/`output` is an empty string is a
        // real (empty) result, not a missing one — show an explicit placeholder
        // rather than dumping the raw result envelope. Only fall back to the
        // JSON dump when the result carries no text-shaped field at all.
        const hasTextField = typeof res.content === 'string' || typeof res.output === 'string';
        // The raw-envelope fallback is literally JSON; a text field carries
        // whatever the plugin declares via resultSectionLanguage (e.g. 'json').
        const usedJsonDump = !res.content && !res.output && !hasTextField;
        const resultText = res.content || res.output || (hasTextField ? '' : JSON.stringify(res, null, 2));
        if (resultText === '') {
          const empty = document.createElement('div');
          empty.className = 'properties-panel-result empty';
          empty.textContent = 'No output';
          resultSection.appendChild(empty);
        } else {
          // ANSI terminal rendering wins; otherwise highlight per the plugin's
          // declared result language (or JSON for the raw envelope dump).
          const declaredLang = ActionClass ? (/** @type {any} */ (ActionClass).resultSectionLanguage?.(toolName) || '') : '';
          const language = isTerminal ? '' : (usedJsonDump ? 'json' : declaredLang);
          resultSection.appendChild(panelHelpers.createCopyableText(resultText, 'properties-panel-result', { ansi: isTerminal, language }));
        }
      }
    } else if (toolAction.get('toolUseId')) {
      const outputDiv = document.createElement('pre');
      outputDiv.className = 'properties-panel-result';
      const isAwaitingApproval = toolAction.get('state') === TOOL_STATES.PENDING;
      const displayDataPlain = yGet(toolAction, 'displayData');
      const streamedOutput = displayDataPlain?.output;
      const streamText = streamedOutput || displayDataPlain?.status || (isAwaitingApproval ? 'Waiting for approval...' : '');
      if (isTerminal) applyAnsi(outputDiv, streamText);
      else outputDiv.textContent = streamText;
      resultSection.appendChild(outputDiv);

      const itemId = toolAction.get('itemId');
      // Snapshot state at render time to detect transitions into RUNNING.
      // Anything other than RUNNING here means the header was painted
      // without a `data-elapsed-since` anchor (runningStartedAt wasn't
      // set yet), so the first move into RUNNING must force a full
      // re-render to rebuild the header with the freshly-stamped anchor.
      const initialState = toolAction.get('state');
      const wasRunning = initialState === TOOL_STATES.RUNNING;
      host._liveUpdater = () => {
        const items = host._messageThread ? host._messageThread.items : [];
        const msg = items.find((/** @type {any} */ i) => i.get('itemId') === itemId);
        if (!msg) return false;

        const state = msg.get('state');
        if (state !== TOOL_STATES.RUNNING
                    && state !== TOOL_STATES.APPROVED
                    && state !== TOOL_STATES.PENDING
                    && state !== undefined && state !== '') {
          // Completed/cancelled/failed — stop pulsing and let full re-render fire.
          wrapper.removeAttribute('data-processing');
          return false;
        }

        const awaitingApproval = state === TOOL_STATES.PENDING;
        // Any transition INTO RUNNING — from PENDING (user approval),
        // APPROVED (rerun path / auto-approved tool) or initial empty
        // state — must force a full re-render so the header title
        // picks up runningStartedAt and the elapsed digit starts.
        if (!wasRunning && state === TOOL_STATES.RUNNING) return false;

        // Start pulsing once running.
        if (!awaitingApproval) wrapper.setAttribute('data-processing', 'true');

        const ddPlain = yGet(msg, 'displayData');
        const liveText = ddPlain?.output || ddPlain?.status || (awaitingApproval ? 'Waiting for approval...' : '');
        if (isTerminal) applyAnsi(outputDiv, liveText);
        else outputDiv.textContent = liveText;
        return true;
      };
    }

    wrapper.appendChild(resultSection);
  }

  const hooksText = describeHookRecords(yGet(toolAction, 'hooks'));
  if (hooksText) panelHelpers.addSubsection(wrapper, 'Hooks', hooksText, 'properties-panel-text');

  container.appendChild(wrapper);
}

/**
 * One line per tool hook that acted on a call, then its note or reason —
 * what it ruled, what it told the model, and whether it failed. The notes are
 * shown in full because they are part of what the model was sent.
 * @param {unknown} records - The tool-action's `hooks` field, as plain JS
 * @returns {string} The section text, or '' when no hook acted
 */
export function describeHookRecords(records) {
  if (!Array.isArray(records) || records.length === 0) return '';
  /** @type {string[]} */
  const blocks = [];
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    const when = r.event === 'beforeTool' ? 'before the call' : 'after the call';
    /** @type {string[]} */
    const did = [];
    if (r.verdict === 'deny') did.push('blocked it');
    else if (r.verdict === 'ask') did.push('held it for your approval');
    else if (r.verdict === 'allow') did.push('allowed it');
    if (r.markError) did.push('marked it failed');
    if (r.note) did.push('added a note for the model');
    if (r.repeatSuppressed) did.push('had a note already given earlier in this thread');
    if (r.error) did.push(`failed: ${r.error}`);
    if (!did.length) did.push('had nothing to add');
    const source = r.source === 'user' ? 'hook file' : 'extension hook';
    const lines = [`${r.name || r.id} (${source}), ${when}: ${did.join('; ')}`];
    if (r.reason) lines.push(r.reason);
    if (r.note) lines.push(r.note);
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

/** @type {ItemRenderer} */
export function renderThread(host, container, message) {
  const badge = badgeForItem(message, badgeCtx(host));
  const goal = itemGoal(message);
  const wrapper = host._createSectionWithControls(
    badge.typeName,
    badge,
    host._renderMessageControls(message),
    goal || undefined,
    message.get('transactionId'),
    message.get('timestamp') || undefined
  );

  const body = document.createElement('properties-panel-body');
  // Wrap the summary so the standard hover-reveal copy button can float over it.
  // The button is only meaningful once an actual summary is shown (not a live
  // status block), so paint() toggles its header.
  const copyable = document.createElement('div');
  copyable.className = 'properties-panel-copyable';
  const copyHeader = document.createElement('div');
  copyHeader.className = 'properties-panel-copy-header';
  copyHeader.appendChild(panelHelpers.createCopyButton(() => getThreadDisplayContent(message).text || ''));
  copyable.appendChild(copyHeader);
  const summary = document.createElement('div');
  copyable.appendChild(summary);
  body.appendChild(copyable);

  const paint = () => {
    const { text } = getThreadDisplayContent(message);
    const conv = host._messageThread?.conversation;
    const llmState = conv?.llmState;
    /** @type {import('../../utils/thread-display.js').ThreadLiveStatus|null} */
    let live = null;
    if (llmState && conv?.id) {
      const byThread = llmState.getLiveThreadMessages(conv.id);
      if (Object.keys(byThread).length > 0) live = { byThread };
    }
    const status = getThreadStatus(message, live);
    paintThreadSummary(summary, text, { status });
    // The copy affordance belongs to the summary surface, so it appears exactly
    // when paintThreadSummary paints one.
    copyHeader.style.display = status.showSummary ? '' : 'none';
  };
  paint();
  host._liveUpdater = () => { paint(); return true; };

  wrapper.appendChild(body);
  container.appendChild(wrapper);
}

/**
 * Registry of conversation-item renderers, keyed by item type as written
 * to the Yjs doc. Lookup via `dispatchItemRenderer` from the panel; the
 * panel handles context-item-instance items (which aren't Yjs messages)
 * separately because they have a different shape.
 * @type {Record<string, ItemRenderer>}
 */
export const itemRendererRegistry = {
  'error': renderError,
  'user': renderMessage,
  'assistant': renderMessage,
  'thinking': renderMessage,
  // Opaque provider continuation state is deliberately absent from properties.
  'provider-state': () => { /* Deliberately hidden. */ },
  'tool-action': renderToolAction,
  'thread': renderThread,
};

/**
 * Dispatch to the registered renderer for a Yjs item, falling back to
 * the generic message renderer for unknown types.
 * @param {PanelHost} host
 * @param {Element} container
 * @param {any} item - Yjs message item with .get('type')
 */
export function dispatchItemRenderer(host, container, item) {
  const renderer = /** @type {Record<string, ItemRenderer>} */ (itemRendererRegistry)[item.get('type')] || renderMessage;
  renderer(host, container, item);
}
