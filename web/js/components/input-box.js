//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import './permission-controls.js';


import { DRAFT_SAVE_DEBOUNCE_MS } from '../utils/constants.js';
import slashCommandHandler from '../services/slash-command-handler.js';
import { isAnyPopupOpen } from '../utils/popup-manager.js';
import { presentPopup } from '../utils/popup-surface.js';
import { CompletionMenu } from './completion-menu.js';
import { fileMentionProvider, extractFileMentionsAsync } from './file-mention-provider.js';
import { slashCommandProvider } from './slash-command-provider.js';
import { THREAD_ARROW_SVG, IMAGE_ATTACH_SVG, SEND_ARROW_SVG, PLUS_SVG, CLOCK_SVG } from '../utils/icons.js';
import { showNotice } from './modal-dialog.js';
import apiService from '../services/api.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';

/**
 * Input box component for sending messages
 */

/** Maximum height (px) the prompt textarea grows to before it starts scrolling. */
const MAX_TEXTAREA_HEIGHT_PX = 400;

/**
 * Hard cap on a single message's length (characters, ~25k tokens). A message
 * is stored inline in the Yjs doc and re-sent to the model every turn, so a
 * huge paste bloats the doc and the context. This ceiling is forgiving enough
 * to never block a legitimate paste (a stack trace, a source file, a JSON
 * blob); past it the send is rejected and the user is asked to attach a file
 * instead.
 */
const MAX_MESSAGE_CHARS = 100_000;

/**
 * Fallback per-image byte ceiling — a generous upload-safety limit used when
 * the send target's provider has no specific, documented image cap (see
 * {@link PROVIDER_MAX_IMAGE_BYTES}), or when the model is automatic and the
 * provider isn't known client-side.
 */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Per-provider hard limit on a single image's byte size, keyed by the provider
 * `name` from the providers list. Each mirrors that vendor's documented API
 * ceiling. Enforced at drop/paste/pick time so an oversized image is rejected
 * locally instead of being uploaded, attached, and rejected by the provider at
 * send time — where, because the attachment is now part of the conversation
 * history, EVERY subsequent turn re-sends it and fails the same way ("image too
 * big") until the user rewinds past the message. This is purely a size gate;
 * model *capability* is still never gated client-side (an incapable model
 * rejects at send time). Providers absent here fall back to
 * {@link MAX_ATTACHMENT_BYTES}.
 * @type {Record<string, number>}
 */
const PROVIDER_MAX_IMAGE_BYTES = {
  anthropic: 5 * 1024 * 1024, // Claude API: 5 MB per image
  claudecode: 5 * 1024 * 1024, // Claude via Claude Code — same vision limit
  openai: 20 * 1024 * 1024, // OpenAI vision: 20 MB per image
  gemini: 20 * 1024 * 1024, // Gemini inline data: 20 MB request cap
};

/** Reject a send whose attachments sum past this aggregate (bytes). */
const MAX_TURN_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/**
 * Reject any single dropped TEXT file larger than this (bytes). Much smaller
 * than the image cap: a dropped text file is inlined into the prompt as context
 * (not sent as an opaque asset), so the binding constraint is the context
 * window, not bandwidth — ~512 KB is already ~130k tokens. Enforced on
 * `file.size` BEFORE the file is read, so a multi-GB drop is rejected without
 * ever being allocated or decoded.
 */
const MAX_TEXT_DROP_BYTES = 512 * 1024;

/** Reject a drop whose text files sum past this aggregate (bytes). */
const MAX_TEXT_DROP_TURN_BYTES = 1024 * 1024;

/**
 * Heuristic: does a just-decoded string look like binary rather than text?
 *
 * `FileReader.readAsText` will happily decode a PDF or image into mojibake, so
 * we sample the decoded string for the two tells of a mis-decoded binary: NUL
 * bytes (never present in real text) and a high ratio of U+FFFD replacement
 * characters (what invalid UTF-8 sequences collapse to). Only the head is
 * sampled — enough to catch binaries cheaply without walking a large file.
 * @param {string} str - Decoded file contents
 * @returns {boolean} True if the content appears to be binary
 */
function looksBinary(str) {
  if (!str) return false;
  const sample = str.length > 4096 ? str.slice(0, 4096) : str;
  let replacement = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code === 0) return true;            // NUL — decisive
    if (code === 0xfffd) replacement++;     // U+FFFD replacement char
  }
  return replacement / sample.length > 0.1;
}

/**
 * Wails' injected runtime installs a `dragover`/`drop` handler on `<html>` that
 * force-sets `dropEffect = 'none'` for file drags whenever the window's
 * `enableFileDrop` flag is off — which Juggler deliberately leaves off so WebKit
 * delivers real `File` objects to the page rather than routing drops through the
 * native bridge (see `cmd/juggler-app/app_state.go`). Because `<html>` is above
 * the message box in the bubble path, that handler runs *after* the input box's
 * own `dragover` and cancels the drop after the fact: the `drop` event never
 * fires and the image is silently rejected.
 *
 * This override listens one level higher (on `document`, which bubbles after
 * `<html>`) so it runs last and re-asserts `dropEffect = 'copy'` for file drags
 * aimed at an `input-box`, letting the drop land in the box's own `drop` handler.
 * Installed once for the whole document, regardless of how many input boxes mount.
 */
let fileDropOverrideInstalled = false;
/** Install the document-level `dragover` override (see block comment above). */
function installFileDropOverride() {
  if (fileDropOverrideInstalled) return;
  fileDropOverrideInstalled = true;
  document.addEventListener('dragover', (e) => {
    const dt = /** @type {DragEvent} */ (e).dataTransfer;
    if (!dt || !Array.from(dt.types || []).includes('Files')) return;
    if (!(e.target instanceof HTMLElement) || !e.target.closest('input-box')) return;
    e.preventDefault();
    dt.dropEffect = 'copy';
  });
}

/**
 * The preset delay chips offered in the scheduled-send picker, tuned to the
 * primary use case: firing a command when the next LLM-provider time slice
 * opens. Minutes only — the picker's steppers cover everything in between.
 * @type {Array<{label: string, minutes: number}>}
 */
const SCHEDULE_PRESETS = [
  { label: '15m', minutes: 15 },
  { label: '30m', minutes: 30 },
  { label: '1h', minutes: 60 },
  { label: '2h', minutes: 120 },
  { label: '3h', minutes: 180 },
  { label: '4h', minutes: 240 },
  { label: '5h', minutes: 300 },
];

/** Granularity (minutes) of the scheduled-send picker — no finer than this. */
const SCHEDULE_MINUTE_STEP = 5;
/** Upper bound (hours) on the scheduled-send picker's hours stepper. */
const SCHEDULE_MAX_HOURS = 12;

/**
 * Format a millisecond duration as a compact countdown for the armed clock
 * button: "2h", "1h5m", "45m", or "<1m" once under a minute.
 * @param {number} ms
 * @returns {string} The compact countdown string.
 */
function formatDelayShort(ms) {
  const totalMin = Math.floor(Math.max(0, ms) / 60000);
  if (totalMin < 1) return '<1m';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h && m) return `${h}h${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/**
 * Format an epoch-ms instant as a 24-hour wall-clock "HH:MM" — the absolute
 * time the user is actually aligning to ("sends at 14:35").
 * @param {number} epochMs
 * @returns {string} The 24-hour "HH:MM" wall-clock time.
 */
function formatClockTime(epochMs) {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

class InputBox extends HTMLElement {
  constructor() {
    super();
    /** @type {boolean} @private */
    this.disabled = false;

    /** @type {boolean} @private */
    this.confirmationPending = false;

    // History navigation state
    /** @type {import('../model/session.js').default|null} @private */
    this.session = null;           // Session reference for accessing messages
    /** @type {number} @private */
    this.historyIndex = -1;        // -1 = current draft, 0+ = index into history
    /** @type {string} @private */
    this.currentDraft = '';        // Save work-in-progress when navigating
    /** @type {Record<number, string>} @private */
    this._historyEdits = {};       // Per-level edits preserved across navigation

    // Draft save debounce timer
    /** @type {number|null} @private */
    this._draftSaveTimeoutId = null;

    // Conversation reference for strategy selector
    /** @type {import('../model/conversation.js').default|null} @private */
    this._conversation = null;

    // Thread context - when set, messages are routed to this thread's nested items
    /** @type {string|null} */
    this.threadItemId = null;

    // Column-scoped message thread
    /** @type {import('../model/message-thread.js').MessageThread|null} @private */
    this._messageThread = null;

    // Staged image attachments for the next send (AssetRefs from uploadAsset).
    // Populated by the paste/drag/picker UI (added in a later step); forwarded
    // on the send-message event and cleared after each dispatch.
    /** @type {Array<{id:string,mime:string,filename:string,bytes:number,width:number,height:number,_uploading?:boolean,_previewURL?:string}>} @private */
    this._pendingAttachments = [];

    // Staged dropped text files for the next send. Unlike image attachments
    // (which upload to the asset store and travel as AssetRefs), these carry
    // their content inline and become `dropped-file` context items at send
    // time. Kept in a separate array precisely because they are NOT AssetRefs
    // and must never leak into the `attachments` send field.
    /** @type {Array<{filename:string,content:string,bytes:number}>} @private */
    this._pendingTextFiles = [];

    // Scheduled-send ("send after a delay") state. The armed target is an
    // epoch-ms wall-clock time persisted on the bound thread's draft (so it
    // survives a reload and stays bound to that thread). This box only arms,
    // cancels, and DISPLAYS the schedule — the actual firing is owned by
    // scheduledSendService, which polls every thread so a send goes out even
    // when this thread isn't the one on screen. See _syncScheduledSendFromDraft.
    /** @type {number|null} @private epoch-ms target for the pending send, or null */
    this._scheduledSendAt = null;
    /** @type {number|null} @private setInterval id that refreshes the countdown label */
    this._scheduledCountdownId = null;
    /** @type {(() => void)|null} @private presentPopup release for the open delay picker */
    this._schedulePickerCleanup = null;

    // Commands menu state
    /** @type {HTMLElement|null} @private */
    this._commandsMenu = null;
    /** @type {boolean} @private */
    this._commandsMenuOpen = false;
    /** @type {(() => void)|null} @private - presentPopup release for the open commands menu. */
    this._popupCleanup = null;

    // Touch-only "+" actions sheet state (commands / attach / new thread).
    /** @type {HTMLElement|null} @private */
    this._actionsSheet = null;
    /** @type {boolean} @private */
    this._actionsSheetOpen = false;
    /** @type {(() => void)|null} @private - presentPopup release for the open actions sheet. */
    this._actionsSheetCleanup = null;
    /** @type {HTMLElement|null} @private - strategy-selector while relocated into the open sheet. */
    this._relocatedStrategy = null;

    // Initialized in setupListeners after render
    /** @type {CompletionMenu|null} @private */
    this._completions = null;

    // Stored promise from the last file-mention executeContextItem call (used by tests)
    /** @type {Promise<any>|null} */
    this._lastMentionPromise = null;

    // Test-only override for the touch-composer decision (matchMedia is
    // undrivable from the headless harness). undefined = use matchMedia.
    /** @type {boolean|undefined} @private */
    this._touchComposerOverride = undefined;
  }

  connectedCallback() {
    this.render();
    if (document.activeElement === document.body && !document.querySelector('conversation-bar.tab-list-focused')) {
      this.querySelector('textarea')?.focus();
    }
  }

  disconnectedCallback() {
    // Tear down an open commands menu (surface, scrim, observer, dismissal).
    if (this._popupCleanup) {
      this._popupCleanup();
      this._popupCleanup = null;
    }
    // Tear down an open actions sheet likewise.
    if (this._actionsSheetCleanup) {
      this._actionsSheetCleanup();
      this._actionsSheetCleanup = null;
    }
    // Tear down an open delay picker.
    if (this._schedulePickerCleanup) {
      this._schedulePickerCleanup();
      this._schedulePickerCleanup = null;
    }
    // Drop the countdown-refresh interval. The target stays persisted on the
    // thread's draft, so reconnecting (or rebinding) restores the countdown —
    // and scheduledSendService fires it whether or not this box is mounted.
    this._stopScheduledCountdown();
    // Release any object URLs held by in-flight upload previews.
    for (const a of this._pendingAttachments) {
      if (a._previewURL) URL.revokeObjectURL(a._previewURL);
    }
  }

  setupListeners() {
    const textarea = /** @type {HTMLTextAreaElement} */ (this.querySelector('textarea'));
    if (!textarea) return;

    // Slash-command completions take precedence at the very start of a message;
    // @-file mentions apply everywhere else. Both share the one caret-anchored
    // CompletionMenu, which activates the first provider whose trigger matches.
    this._completions = new CompletionMenu({
      textarea,
      getWrapper: () => this.querySelector('input-box-wrapper'),
      onResize: () => this.autoResize(textarea),
      providers: [slashCommandProvider, fileMentionProvider],
    });

    // Re-run autoResize whenever the textarea's width changes (e.g. column
    // drag-resize reflowing multi-line text to a different line count).
    // Two guards keep this from emitting "ResizeObserver loop completed with
    // undelivered notifications": (1) act on width only, since autoResize
    // mutates height and reacting to that would feed back into the observer;
    // (2) defer the height write to the next frame so it lands outside the
    // observer's own delivery cycle rather than mutating layout mid-delivery.
    /** @type {number|null|undefined} */
    let lastWidth = null;
    let resizeScheduled = false;
    const resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width === lastWidth) return;
      lastWidth = width;
      if (resizeScheduled) return;
      resizeScheduled = true;
      requestAnimationFrame(() => {
        resizeScheduled = false;
        this.autoResize(textarea);
      });
    });
    resizeObserver.observe(textarea);

    // Click on the empty wrapper area focuses the textarea. Skip clicks that
    // land on a control button (or anywhere in input-controls): those must not
    // programmatically focus the textarea, because on mobile that pops the
    // onscreen keyboard just from opening a popup. On desktop the caret already
    // stays in the textarea via the mousedown preventDefault below, so skipping
    // here changes nothing there — focus still "remains" on the message box.
    const wrapper = this.querySelector('input-box-wrapper');
    if (wrapper) {
      wrapper.addEventListener('click', (e) => {
        const target = /** @type {Element|null} */ (e.target);
        if (target && target.closest('button, .input-ctrl-btn, input-controls')) return;
        textarea.focus();
      });
    }

    // Toggling a control button (commands, strategy, model, permissions) on a
    // DESKTOP must not pull keyboard focus off the textarea: the browser focuses
    // a <button> on mousedown, so suppressing that default keeps the caret in
    // the textarea (there is no focus to "restore" because it never left).
    //
    // On TOUCH we want the opposite: opening a popup should let the textarea
    // blur so the onscreen keyboard dismisses instead of being held up. So the
    // focus-retention is gated on the pointer type of this interaction —
    // preventDefault for a real mouse, leave the default (blur) for touch/pen.
    // pointerdown fires before the compat mousedown for both, so it records the
    // type in time. click still fires either way, so the buttons' own toggle
    // handlers are unaffected. Capture phase so it runs regardless of any inner
    // stopPropagation. The menu surfaces are detached to <body>, outside
    // input-controls, so their own focusable inputs (e.g. the permission path
    // editor) are untouched by this.
    const inputControls = this.querySelector('input-controls');
    if (inputControls) {
      let lastPointerType = 'mouse';
      inputControls.addEventListener('pointerdown', (e) => {
        lastPointerType = /** @type {PointerEvent} */ (e).pointerType || 'mouse';
      }, true);
      inputControls.addEventListener('mousedown', (e) => {
        const target = /** @type {Element|null} */ (e.target);
        if (lastPointerType === 'mouse' && target && target.closest('button, .input-ctrl-btn')) {
          e.preventDefault();
        }
      }, true);
    }

    // Commands menu button
    const commandsButton = this.querySelector('#commands-button');
    if (commandsButton) {
      commandsButton.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleCommandsMenu();
      });
    }

    // Image attachments: file-picker button, paste, and drag-and-drop. All
    // three funnel image files through _handleFiles, which validates size /
    // capability and uploads to the asset store.
    const attachBtn = this.querySelector('#attach-image-button');
    const fileInput = /** @type {HTMLInputElement|null} */ (this.querySelector('.attach-file-input'));
    if (attachBtn && fileInput) {
      attachBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        fileInput.click();
      });
      fileInput.addEventListener('change', () => {
        if (fileInput.files) this._handleFiles(fileInput.files);
        // Reset so selecting the same file again re-fires change.
        fileInput.value = '';
      });
    }

    // Paste image data (screenshot, copied image) — upload it and suppress the
    // default paste of those image items (avoids also pasting a filename).
    //
    // Two paths, because clipboard engines differ:
    //   1. Synchronous — Chromium/WebView2 populate `clipboardData.items` with
    //      the image as a `File`, readable straight off the paste event.
    //   2. Asynchronous — WebKit (WebKitGTK on Linux, WKWebView on macOS — i.e.
    //      the Wails desktop app) routinely exposes only text on the synchronous
    //      paste event and hands the image out solely through the async Clipboard
    //      API (`navigator.clipboard.read()`). Without the fallback below,
    //      pasting a screenshot into the desktop app silently does nothing while
    //      text paste works — exactly the drag/drop asymmetry the Wails override
    //      above was added to fix, but for paste.
    // The async read is gated to pastes that actually signal an image (or carry
    // no text at all), so a plain-text paste in a browser never trips a
    // clipboard-read permission prompt.
    textarea.addEventListener('paste', (e) => {
      const dt = e.clipboardData;
      /** @type {File[]} */
      const imageFiles = [];
      // Reading `items`/`getAsFile()` can throw on some engines when the event
      // isn't a trusted user paste — never let that abort the handler before
      // the async fallback below gets its turn.
      try {
        for (const item of Array.from(dt?.items || [])) {
          if (item.kind === 'file' && item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) imageFiles.push(file);
          }
        }
      } catch { /* fall through to the async fallback */ }
      if (imageFiles.length > 0) {
        e.preventDefault();
        this._handleFiles(imageFiles);
        return;
      }
      // Nothing usable synchronously. Only reach for the async Clipboard API
      // when this paste plausibly carries an image: either the event advertises
      // an image (some WebKit builds surface the type in `types`/"Files" but no
      // File) or it carries no text at all (WebKit image-only paste, where the
      // event exposes nothing synchronously). A plain-text paste — text present,
      // no image signal — skips it, so browsers never see a permission prompt.
      //
      // Both `types` and `getData` are read defensively: WebKit restricts
      // `getData` to trusted paste events and throws otherwise, and a throw here
      // must not stop us from consulting the async clipboard.
      let types = /** @type {string[]} */ ([]);
      try { types = Array.from(dt?.types || []); } catch { /* ignore */ }
      const hasImageSignal = types.some((t) => t.startsWith('image/')) || types.includes('Files');
      let hasText = false;
      try { hasText = !!(dt && dt.getData('text/plain')); } catch { /* getData may be restricted */ }
      if (hasImageSignal || !hasText) {
        void this._pasteImagesFromAsyncClipboard();
      }
    });

    // Drag-and-drop image files anywhere onto the message box. The listeners
    // live on the host element (`this`) so the whole component is a drop zone —
    // including the padding around the bubble — not just the inner bubble. The
    // drag-over highlight stays on the bubble (`wrapper`) for visual feedback.
    // The document-level override below re-enables the drop, which the Wails
    // runtime otherwise cancels (see installFileDropOverride).
    installFileDropOverride();
    this.addEventListener('dragover', (e) => {
      const dt = /** @type {DragEvent} */ (e).dataTransfer;
      if (!dt || !Array.from(dt.types || []).includes('Files')) return;
      e.preventDefault();
      wrapper?.classList.add('drag-over');
    });
    this.addEventListener('dragleave', (e) => {
      // Only clear when the pointer actually leaves the host, not when it
      // crosses between the host's children (which also fire dragleave).
      if (e.target === this) wrapper?.classList.remove('drag-over');
    });
    this.addEventListener('drop', (e) => {
      wrapper?.classList.remove('drag-over');
      const dt = /** @type {DragEvent} */ (e).dataTransfer;
      const files = dt?.files;
      if (!files || files.length === 0) return;
      // Images upload to the asset store (bytes); everything else is treated as
      // a text file and inlined as a context-item snapshot. Split so a mixed
      // drop routes each kind to the right handler.
      const arr = Array.from(files);
      const images = arr.filter((f) => f.type.startsWith('image/'));
      const texts = arr.filter((f) => !f.type.startsWith('image/'));
      if (images.length === 0 && texts.length === 0) return;
      e.preventDefault();
      if (images.length > 0) this._handleFiles(images);
      if (texts.length > 0) this._handleTextFiles(texts);
    });

    // Render any chips that survived a re-render.
    this._renderAttachmentChips();

    textarea.addEventListener('keydown', (e) => {
      // Completion menu (@ mentions / slash commands) owns navigation keys while
      // open — it consumes Arrow/Enter/Tab/Escape as needed and reports back.
      if (this._completions?.handleKeydown(e)) return;

      // Enter to send (without Shift, Alt/Option, or Meta/Command). On a touch
      // composer Enter is the onscreen keyboard's return key, so a plain Enter
      // inserts a newline (handled by the branch below) and the Send button is
      // the send affordance instead.
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !this._isTouchComposer()) {
        e.preventDefault();
        this.sendMessage();
        return;
      }

      // Insert a newline: Alt+Enter / Cmd+Enter on any composer, plus a plain
      // (unmodified) Enter on a touch composer.
      if (e.key === 'Enter' && (e.altKey || e.metaKey || (this._isTouchComposer() && !e.shiftKey))) {
        e.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const value = textarea.value;
        textarea.value = value.substring(0, start) + '\n' + value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 1;
        this.autoResize(textarea);
        return;
      }

      // Escape to cancel LLM or clear input
      if (e.key === 'Escape') {
        // A popup/modal open over the input owns Escape — it dismisses
        // itself via its own handler / popup-manager. Don't let the key
        // leak through to cancel a running turn or clear the input.
        if (isAnyPopupOpen()) {
          return;
        }

        e.preventDefault();

        // Use the SAME decision as the conversation-area Escape and the
        // footer Stop button: shouldHandleEscape() also catches the worker
        // parked in activity='awaiting_llm' (a re-run whose tool is mid-flight
        // but no LLM is streaming). The old narrower check (isLLMActive ||
        // hasRunningActions) missed that, so Escape from the input cleared the
        // textarea instead of stopping the re-run.
        // @ts-ignore - jugglerApp is added dynamically in app.js
        if (window.jugglerApp && window.jugglerApp.shouldHandleEscape()) {
          // Cancel from THIS box's vantage: a sub-thread box (threadItemId set)
          // interrupts that thread without closing it; the root box (null) stops
          // everything and closes open sub-threads. Shift+Escape instead requests
          // a polite stop (Pause): finish the current step, then rest at idle —
          // nothing cancelled. (Plain Escape while a Pause is pending escalates
          // to a hard cancel, per D7.)
          // @ts-ignore - jugglerApp is added dynamically in app.js
          window.jugglerApp.cancelLLMOperation(this.threadItemId ?? null, { polite: e.shiftKey });
        } else {
          // No active LLM - save draft to history before clearing
          const currentValue = textarea.value.trim();
          if (currentValue && this.session) {
            // Save the draft message to history so it can be retrieved later
            this.session.addMessageToHistory(currentValue);
          }

          // Clear input
          this.setText('');
          this.currentDraft = '';
          this.historyIndex = -1;
        }
        return;
      }

      // ArrowUp/Down: navigate history, but only when cursor is stuck at
      // the top/bottom. Let the browser move the cursor first, then check
      // in a microtask whether it actually moved. Any modifier (Shift for
      // selection, Alt/Ctrl/Meta for word/line jumps) means the user is
      // navigating/selecting text, so leave the keypress alone.
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown')
                && (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey)) {
        return;
      }

      if (e.key === 'ArrowUp') {
        const prevStart = textarea.selectionStart;
        const prevEnd = textarea.selectionEnd;
        setTimeout(() => this._navigateHistoryUp(textarea, prevStart, prevEnd), 0);
        return;
      }

      if (e.key === 'ArrowDown') {
        const prevStart = textarea.selectionStart;
        const prevEnd = textarea.selectionEnd;
        setTimeout(() => this._navigateHistoryDown(textarea, prevStart, prevEnd), 0);
        return;
      }
    });

    textarea.addEventListener('input', () => {
      this.autoResize(textarea);
      this._updateSendButtonState();
      // Debounced draft save for page reload restoration
      this._scheduleDraftSave(textarea.value);
      // @ file completions
      this._completions?.handleInput();
    });
    // Paste in WKWebView updates value after the input event fires, so
    // re-run detection on the next tick to read the final pasted value.
    textarea.addEventListener('paste', () => setTimeout(() => this._completions?.handleInput(), 0));

    // Losing focus dismisses the completion menu. It is non-modal with no
    // outside-click handling — typing in the textarea is what drives it — so
    // without this a click away from the textarea would strand an open menu
    // with no path to dismiss it. Menu items accept on pointerdown +
    // preventDefault, which keeps focus in the textarea, so an accept never
    // reaches here; only a genuine focus change does.
    textarea.addEventListener('blur', () => this._completions?.close());

    // New thread button - creates thread immediately
    const threadBtn = this.querySelector('.new-thread-btn');
    if (threadBtn) {
      threadBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._createThread();
      });
    }

    // Schedule-send ("send after a delay") button — opens the delay picker.
    const scheduleBtn = this.querySelector('.schedule-send-btn');
    if (scheduleBtn) {
      scheduleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._toggleSchedulePicker();
      });
    }
    // A draft restored on mount may already carry a pending send — re-arm (or,
    // if its target has passed, fire) it now that the controls exist.
    this._syncScheduledSendFromDraft();

    // Touch-only Send button (CSS reveals it on a coarse pointer). Send-only —
    // cancelling a running turn is the footer Stop button's job, so this never
    // morphs into a Stop control.
    const sendBtn = this.querySelector('#send-button');
    if (sendBtn) {
      sendBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.sendMessage();
      });
    }

    // Touch-only "+" overflow button: opens the actions sheet (commands, attach
    // image, new thread) so those affordances need no inline row on a phone.
    const moreBtn = this.querySelector('#more-actions-button');
    if (moreBtn) {
      moreBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._toggleActionsSheet();
      });
    }

    // Seed the Send button's empty/disabled state from any restored draft.
    this._updateSendButtonState();
  }

  /**
   * Whether the composer currently holds nothing sendable — no non-whitespace
   * text and no staged attachments or dropped text files. This is the single
   * definition of "empty" shared by the Send button (which can't send an empty
   * message) and the schedule button (which mustn't arm a delayed send that
   * would silently fire nothing).
   * @returns {boolean} True when there is nothing sendable.
   * @private
   */
  _isComposerEmpty() {
    const textarea = this.querySelector('textarea');
    const hasText = !!(textarea && textarea.value.trim());
    const hasAttachments = this._resolvedAttachments().length > 0 || this._pendingTextFiles.length > 0;
    return !hasText && !hasAttachments;
  }

  /**
   * Refresh both empty-sensitive controls from the current composer contents:
   * the `.is-empty` class on the Send button (so a whitespace-only message
   * can't be sent) and the schedule button's disabled/armed look (so a delayed
   * send can't be armed on — or appear active over — an empty box). Cheap;
   * called from the textarea input handler, after programmatic text changes,
   * and on every attachment mutation.
   * @private
   */
  _updateSendButtonState() {
    const empty = this._isComposerEmpty();
    const sendBtn = this.querySelector('#send-button');
    if (sendBtn) sendBtn.classList.toggle('is-empty', empty);
    // The schedule button follows the same empty rule; _updateScheduleButton
    // re-reads emptiness itself, so just re-render it.
    this._updateScheduleButton();
  }

  /**
   * Whether this composer should behave as a touch composer: Enter inserts a
   * newline (the onscreen keyboard's return key) and the touch-only Send / "+"
   * affordances are active. Gated on a coarse pointer with no hover — the same
   * signal the CSS `@media (hover: none) and (pointer: coarse)` block keys off,
   * so the key behaviour and the layout never disagree. A narrow DESKTOP window
   * (fine pointer) keeps Enter-to-send.
   *
   * Tests can't drive `matchMedia`, so an explicit `_touchComposerOverride`
   * (true/false) wins when set — that is the only way the harness flips this.
   * @returns {boolean} True when the composer should treat Enter as newline.
   * @private
   */
  _isTouchComposer() {
    if (typeof this._touchComposerOverride === 'boolean') {
      return this._touchComposerOverride;
    }
    return window.matchMedia?.('(hover: none) and (pointer: coarse)').matches === true;
  }

  /**
   * The persistable subset of the staged attachments: fully-uploaded refs only
   * (a resolved AssetRef has an id and is not mid-upload), stripped of the
   * UI-only preview/uploading fields. This is exactly what both a send and a
   * draft-save carry — a mid-upload placeholder has no asset to reference yet.
   * @returns {import('../utils/attachments.js').AssetRef[]} The uploaded refs (no placeholders).
   * @private
   */
  _resolvedAttachments() {
    return this._pendingAttachments
      .filter((a) => a.id && !a._uploading)
      .map(({ id, mime, filename, bytes, width, height }) => ({ id, mime, filename, bytes, width, height }));
  }

  /**
   * Persist the full draft — text, staged image attachments, AND dropped text
   * files — to the thread model as one record. Called from every site that
   * mutates any part (text input, attachment add/remove/restore, text-file
   * drop/remove) so they can never drift: a quit/restart restores the whole
   * draft or nothing. Attachment/text-file changes call this immediately; text
   * changes go through the debounce below.
   * @param {string} [text] - Text to persist; defaults to the live textarea value.
   * @private
   */
  _persistDraft(text) {
    if (!this._messageThread) return;
    const value = (text !== undefined) ? text : this.getText();
    this._messageThread.draft = {
      text: value,
      attachments: this._resolvedAttachments(),
      textFiles: this._pendingTextFiles.map(({ filename, content, bytes }) => ({ filename, content, bytes })),
      // Preserve any armed send across the keystroke-driven draft saves — the
      // user keeps typing while a send is scheduled, and each save must not
      // drop the timer.
      scheduledSendAt: this._scheduledSendAt
    };
  }

  /**
   * Immediately persist the live textarea value, bypassing the debounce. Used by
   * page/native-window teardown, where the debounced timer may not get another
   * turn before the webview is destroyed.
   */
  flushDraft() {
    if (this._draftSaveTimeoutId !== null) {
      clearTimeout(this._draftSaveTimeoutId);
      this._draftSaveTimeoutId = null;
    }
    this._persistDraft();
  }

  /**
   * Schedule a debounced save of the draft (text + attachments). Debounced so
   * keystrokes don't thrash the Yjs doc; attachment add/remove persist
   * immediately via _persistDraft (a discrete, infrequent event).
   * @param {string} text - Current textarea value
   * @private
   */
  _scheduleDraftSave(text) {
    // Clear any existing timeout
    if (this._draftSaveTimeoutId !== null) {
      clearTimeout(this._draftSaveTimeoutId);
    }
    // Schedule save after debounce delay
    this._draftSaveTimeoutId = setTimeout(() => {
      this._draftSaveTimeoutId = null;
      this._persistDraft(text);
    }, DRAFT_SAVE_DEBOUNCE_MS);
  }

  /**
   * Set the textarea text and auto-resize
   * @param {string} text
   */
  setText(text) {
    const textarea = this.querySelector('textarea');
    if (!textarea) return;
    textarea.value = text;
    this.autoResize(textarea);
    this._updateSendButtonState();
  }

  /**
   * Set the textarea to a command-supplied draft, focus it, and place the caret
   * at the end so the user can immediately continue typing. Used by user-defined
   * slash commands in 'draft' run mode (via the setDraft command side effect).
   * @param {string} text
   */
  setDraft(text) {
    this.setText(text);
    const textarea = this.querySelector('textarea');
    if (!textarea) return;
    textarea.focus();
    const end = textarea.value.length;
    try {
      textarea.setSelectionRange(end, end);
    } catch {
      // setSelectionRange throws on some input types — non-fatal.
    }
  }

  /**
   * Get the current textarea text
   * @returns {string} Current text value
   */
  getText() {
    const textarea = this.querySelector('textarea');
    return textarea ? textarea.value : '';
  }

  /**
   * Auto-resize textarea to fit content
   * @param {HTMLTextAreaElement} textarea
   */
  autoResize(textarea) {
    textarea.style.overflowY = 'hidden'; // Temporarily hide scrollbar for accurate measurement
    textarea.style.height = 'auto'; // Reset height to auto to get correct scrollHeight
    const newHeight = Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT_PX);
    textarea.style.height = newHeight + 'px';
    // Enable scrolling if the maximum height is reached
    textarea.style.overflowY = newHeight < MAX_TEXTAREA_HEIGHT_PX ? 'hidden' : 'auto';
  }

  /**
   * Validate and dispatch the current input as a send-message event.
   * @returns {Promise<string|null>} null when the message was dispatched;
   *   otherwise a short reason describing which guard blocked the send.
   *   Callers that must know the message went out (the test driver, most
   *   importantly) check the return value — a blocked send is otherwise
   *   indistinguishable from a sent one.
   */
  async sendMessage() {
    const textarea = this.querySelector('textarea');
    if (!textarea) return 'no textarea';

    const message = textarea.value.trim();
    // A staged image OR a dropped text file makes an otherwise-empty message a
    // valid send: the text files become context items ahead of the (empty) user
    // message, exactly like a caption-less image attachment.
    const hasAttachments = this._resolvedAttachments().length > 0 || this._pendingTextFiles.length > 0;

    // Block sending while confirmation is pending. An image-only message (no
    // text but staged attachments) is a valid send: the worker treats an
    // attachment-bearing message as non-empty (UserMessageInput.isEmpty) and
    // each provider omits the empty text block on the wire, so nothing forces
    // the user to type a caption.
    if ((!message && !hasAttachments) || this.disabled || this.confirmationPending) {
      return 'empty, disabled, or confirmation pending';
    }

    // Reject an oversized message. A message is stored inline in the Yjs doc
    // and re-sent to the model every turn, so a huge paste bloats the doc and
    // the context. The cap is forgiving (a stack trace, a source file, a JSON
    // blob all fit); past it the user should put the data in a file and point
    // the model at it instead.
    if (message.length > MAX_MESSAGE_CHARS) {
      this.showWarning(
        `Message is too large (${message.length.toLocaleString()} characters, ` +
        `max ${MAX_MESSAGE_CHARS.toLocaleString()}). Save it to a file and ` +
        `reference the path instead.`
      );
      return 'message too large';
    }

    // While a turn is in flight (the conversation is processing, or the
    // thread has busy items such as a running tool or an approval awaiting
    // a decision) the message is QUEUED, not refused — Conversation.sendMessage
    // forwards it to the worker, which parks it in pendingItems and drains it
    // at the next boundary. So we don't block here; we just nudge the
    // status into view so the user sees the queued bubble land.
    const visibleConv = this.session ? this.session.getVisibleConversation() : null;
    const busy = (visibleConv && visibleConv.isProcessing) ||
            (this._messageThread && this._messageThread.hasBusyItems());
    if (busy) {
      this._scrollToStatus();
    }

    // Create context items for all @-mentions AND dropped text files before
    // sending. Awaited here so these content items land in the thread items
    // array BEFORE the user message — otherwise the user message (and even the
    // assistant reply) would be appended ahead of the file content. Dropped
    // files go through the same executeContextItem path as mentions, differing
    // only in that they carry inline content (a `dropped-file` snapshot) rather
    // than a path the server re-reads.
    if (this._messageThread) {
      // Parses the raw message text, so it works even if the user submits
      // before setupListeners() runs (paste + Enter immediately after mount) —
      // no dependency on the completion menu being initialised.
      const paths = await extractFileMentionsAsync(message);
      const textFiles = this._pendingTextFiles;
      this._pendingTextFiles = [];
      if (paths.length > 0 || textFiles.length > 0) {
        const mt = this._messageThread;
        this._lastMentionPromise = Promise.all([
          ...paths.map(p => mt.executeContextItem('file-content', { path: p })),
          ...textFiles.map(t => mt.executeContextItem('dropped-file',
            { filename: t.filename, content: t.content }))
        ]);
        await this._lastMentionPromise;
      }
      this._renderAttachmentChips();
    }

    // The Conversation calls clearInput() after successful validation, so the
    // message survives in the textarea if the send fails.
    // Forward any attachments staged on this input box (populated by the
    // paste/drag/picker UI in a later step). Pass a copy and clear after
    // dispatch so the next message starts empty.
    // Only forward fully-uploaded attachments (a resolved AssetRef has an id);
    // strip the UI-only preview/uploading fields before they leave the box.
    const attachments = this._pendingAttachments
      .filter((a) => a.id && !a._uploading)
      .map(({ id, mime, filename, bytes, width, height }) => ({ id, mime, filename, bytes, width, height }));
    for (const a of this._pendingAttachments) {
      if (a._previewURL) URL.revokeObjectURL(a._previewURL);
    }
    this._pendingAttachments = [];
    this._renderAttachmentChips();
    this.dispatchEvent(new CustomEvent('send-message', {
      detail: {
        message,
        threadItemId: this.threadItemId || null,
        messageThread: this._messageThread || null,
        attachments
      },
      bubbles: true,
      composed: true
    }));
    return null;
  }

  /**
   * Clear the input field after message is accepted
   * Called by Conversation after successful validation
   */
  clearInput() {
    const textarea = this.querySelector('textarea');
    if (!textarea) return;

    // Dismiss any open completion popup (@ mentions / slash commands). A send
    // via Enter keeps focus in the textarea, so the blur handler that normally
    // closes the menu never fires — without this, submitting a command like
    // `/clear` with nothing highlighted leaves the popup stranded over the now
    // empty box. Every successful send funnels through here, so this covers the
    // Enter, touch Send button, and scheduled-flush paths alike.
    this._completions?.close();

    // Reset history navigation state
    this.historyIndex = -1;
    this.currentDraft = '';
    this._historyEdits = {};

    // Drop any staged text files — they were flushed into context items at send.
    this._pendingTextFiles = [];

    // Clear any pending draft save and clear the saved draft (text +
    // attachments) as one unit.
    if (this._draftSaveTimeoutId !== null) {
      clearTimeout(this._draftSaveTimeoutId);
      this._draftSaveTimeoutId = null;
    }
    if (this._messageThread) {
      this._messageThread.draft = null;
    }

    // Sending (or otherwise clearing) the box consumes any armed scheduled send:
    // the draft it was attached to is now gone. Drop the in-memory target and
    // countdown too — otherwise the button stays visually "armed", and the next
    // keystroke's _persistDraft would re-attach the stale target to a fresh,
    // unrelated draft and fire it. The draft was just nulled above, so this
    // resets in-memory state only (no re-persist needed).
    this._stopScheduledCountdown();
    this._scheduledSendAt = null;
    this._updateScheduleButton();

    // Clear input; callers manage focus explicitly.
    this.setText('');
  }

  /**
   * Set disabled state for the input
   * @param {boolean} disabled
   */
  setDisabled(disabled) {
    this.disabled = disabled;
    const textarea = this.querySelector('textarea');

    if (textarea) textarea.disabled = disabled;
  }

  /**
   * Set confirmation pending state
   * @param {boolean} pending - Whether a confirmation is pending
   */
  setConfirmationPending(pending) {
    this.confirmationPending = pending;
    const textarea = this.querySelector('textarea');

    if (textarea) {
      if (pending) {
        textarea.setAttribute('data-confirmation-pending', 'true');
      } else {
        textarea.removeAttribute('data-confirmation-pending');
      }
    }
  }

  /**
   * Set blocked state (e.g., during action approval)
   * Disables input and shows a status message
   * @param {boolean} blocked - Whether input is blocked
   * @param {string} [reason] - Reason for blocking (e.g., "Waiting for approval...")
   */
  setBlocked(blocked, reason = '') {
    const textarea = this.querySelector('textarea');

    if (textarea) {
      if (blocked) {
        textarea.disabled = true;
        textarea.placeholder = reason || 'Input blocked...';
        textarea.setAttribute('data-blocked', 'true');
      } else {
        textarea.disabled = false;
        // On a touch composer Enter inserts a newline, so the desktop
        // "Shift+Enter for new line" hint would be wrong there.
        textarea.placeholder = this._isTouchComposer()
          ? 'Type your message...'
          : 'Type your message... (Shift+Enter for new line)';
        textarea.removeAttribute('data-blocked');
      }
    }
  }

  /**
   * Set the session reference for accessing message history
   * @param {import('../model/session.js').default} session - Session instance
   */
  setSession(session) {
    this.session = session;
  }

  /**
   * Set the conversation reference for the strategy selector and permission controls
   * @param {import('../model/conversation.js').default|null} conversation - Conversation instance
   */
  setConversation(conversation) {
    this._conversation = conversation;
    this._syncStrategySelector();
    const permissionControls = this.querySelector('permission-controls');
    if (permissionControls && 'setMessageThread' in permissionControls) {
      /** @type {HTMLElement & {setMessageThread: function(import('../model/message-thread.js').default|null): void}} */
      (permissionControls).setMessageThread(this._messageThread);
    }
    const modelSelector = this.querySelector('model-selector');
    if (modelSelector && 'setConversation' in modelSelector) {
      /** @type {any} */ (modelSelector).setConversation(this._conversation);
    }

  }

  /**
   * Bind the strategy selector to this input box's thread. Strategy is
   * per-thread with walk-up inheritance: a sub-thread shows its effective
   * strategy (inherited from the conversation unless it sets its own override),
   * and selecting one writes to the bound thread (MessageThread.setStrategy).
   * @private
   */
  _syncStrategySelector() {
    const strategySelector = this.querySelector('strategy-selector');
    if (!strategySelector || !('setMessageThread' in strategySelector)) return;
    /** @type {{setMessageThread: function(import('../model/message-thread.js').default|null): void}} */
    (strategySelector).setMessageThread(this._messageThread);
  }

  /**
   * Set the message thread for this input box
   * @param {import('../model/message-thread.js').MessageThread} messageThread
   */
  setMessageThread(messageThread) {
    // Compare LOGICAL identity (conversation + thread item), not object
    // identity: a sub-thread column rebuilds a fresh MessageThread wrapper for
    // the SAME underlying thread on every doc update (new items, status
    // changes). Object-identity here made isNewThread true on every such
    // rebuild, re-running the draft-restore below and resetting the textarea to
    // the last debounce-saved draft — clobbering the user's in-flight typing.
    // Restore the draft only on a genuine switch to a different thread.
    const prev = this._messageThread;
    const isNewThread = !prev
      || prev.conversationId !== messageThread.conversationId
      || prev.threadItemId !== messageThread.threadItemId;
    this._messageThread = messageThread;
    this.threadItemId = messageThread.threadItemId;

    this._syncStrategySelector();

    const modelSelector = this.querySelector('model-selector');
    if (modelSelector && 'setMessageThread' in modelSelector) {
      /** @type {any} */ (modelSelector).setMessageThread(messageThread);
    }

    // Restore the draft when switching to a new thread — text AND attachments,
    // as one unit (they were persisted together). Stage the attachments
    // without re-persisting (we're reading from the model, not changing it).
    if (isNewThread) {
      const draft = messageThread.draft;
      this._stagePendingAttachments(draft.attachments);
      this._stagePendingTextFiles(draft.textFiles);
      const textarea = this.querySelector('textarea');
      if (textarea) {
        const draftText = draft.text || '';
        if (textarea.value !== draftText) {
          textarea.value = draftText;
        }
        textarea.style.height = 'auto';
        const attemptResize = (/** @type {number} */ attempts) => {
          if (textarea.offsetHeight > 0) {
            this.autoResize(textarea);
          } else if (attempts < 5) {
            requestAnimationFrame(() => attemptResize(attempts + 1));
          }
        };
        // Settle synchronously when the textarea is already laid out (the
        // tab-switch case) so the column's scroll-to-bottom runs against a
        // stable input-box height instead of a still-growing one — otherwise
        // the textarea inflates a few frames later and shoves the footer
        // below the fold. Re-assert after layout for the not-yet-sized case
        // (and to correct any width-dependent wrap measurement).
        attemptResize(0);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => attemptResize(0));
        });
      }
      // Rebind the scheduled-send timer to the newly-bound thread: cancel the
      // previous thread's live timer and re-arm from THIS thread's persisted
      // draft (firing at once if its target already passed).
      this._syncScheduledSendFromDraft();
    }
  }

  /**
   * Get user message history from session (most recent first)
   * @returns {string[]} Array of user messages
   */
  getUserHistory() {
    if (!this.session) return [];

    // Return session-level message history (shared across all conversations)
    // Reverse for arrow-up navigation (most recent first)
    return [...this.session.messageHistory].reverse();
  }

  /**
   * @param {HTMLTextAreaElement} textarea
   * @param {number} prevStart
   * @param {number} prevEnd
   * @private
   */
  _navigateHistoryUp(textarea, prevStart, prevEnd) {
    if (this._completions?.isActive()) return;
    if (textarea.selectionStart !== prevStart || textarea.selectionEnd !== prevEnd) return;
    const history = this.getUserHistory();
    if (history.length === 0) return;
    if (this.historyIndex === -1) {
      this.currentDraft = textarea.value;
    } else {
      this._historyEdits[this.historyIndex] = textarea.value;
    }
    if (this.historyIndex < history.length - 1) {
      this.historyIndex++;
      const text = /** @type {string} */ (this._historyEdits[this.historyIndex] !== undefined
        ? this._historyEdits[this.historyIndex]
        : history[this.historyIndex]);
      this.setText(text);
      textarea.selectionStart = textarea.selectionEnd = text.length;
      this._scheduleDraftSave(textarea.value);
    }
  }

  /**
   * @param {HTMLTextAreaElement} textarea
   * @param {number} prevStart
   * @param {number} prevEnd
   * @private
   */
  _navigateHistoryDown(textarea, prevStart, prevEnd) {
    if (this._completions?.isActive()) return;
    if (textarea.selectionStart !== prevStart || textarea.selectionEnd !== prevEnd) return;
    if (this.historyIndex > -1) {
      this._historyEdits[this.historyIndex] = textarea.value;
      this.historyIndex--;
      let text;
      if (this.historyIndex === -1) {
        text = this.currentDraft;
      } else {
        const history = this.getUserHistory();
        text = /** @type {string} */ (this._historyEdits[this.historyIndex] !== undefined
          ? this._historyEdits[this.historyIndex]
          : history[this.historyIndex]);
      }
      this.setText(text);
      textarea.selectionStart = textarea.selectionEnd = text.length;
      this._scheduleDraftSave(textarea.value);
    }
  }

  /**
   * Show a prominent, transient warning notice to the user. Delegates to the
   * app-level `showNotice` (a centered modal-dialog): the input box owns no
   * warning state of its own.
   * @param {string} message - Warning message to display
   * @param {number} [duration=5000] - Duration to show warning in milliseconds (0 = manual dismissal only)
   */
  showWarning(message, duration = 5000) {
    showNotice(message, { duration });
  }

  /**
   * Scroll the parent conversation-area's footer into view.
   * Called when send is blocked so the user can see what's happening.
   * @private
   */
  _scrollToStatus() {
    const convArea = this.closest('conversation-area');
    if (!convArea) return;
    const footer = convArea.querySelector('conversation-footer');
    if (footer) {
      footer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // ========================================================================
  // IMAGE ATTACHMENTS
  // ========================================================================

  /**
   * The per-image byte ceiling for the model this input box will send to.
   * Resolves the effective provider (thread override → conversation default)
   * and returns its documented per-image limit ({@link PROVIDER_MAX_IMAGE_BYTES}),
   * falling back to {@link MAX_ATTACHMENT_BYTES} when the provider has no
   * specific limit or the model is automatic (provider unknown client-side).
   * @returns {number} Max bytes for a single image attachment.
   * @private
   */
  _maxImageBytes() {
    const cfg = this._messageThread?.getEffectiveModelConfig?.()
      || this._conversation?.modelConfig
      || null;
    const provider = cfg && cfg.provider ? cfg.provider : '';
    return PROVIDER_MAX_IMAGE_BYTES[provider] || MAX_ATTACHMENT_BYTES;
  }

  /**
   * Fallback image paste for engines whose synchronous `paste` event omits the
   * image file — notably WebKit (WebKitGTK/WKWebView), i.e. the Wails desktop
   * app. Reads the async Clipboard API, materialises any image entries as
   * `File`s, and routes them through the same {@link _handleFiles} path as
   * synchronous paste / drop / picker (which validates size and uploads).
   *
   * Best-effort by design: a missing API, an insecure context, a denied
   * permission, or a clipboard with no image all resolve to a silent no-op —
   * the same outcome as before this fallback existed, so it can only ever add
   * successful pastes, never break an existing one.
   * @returns {Promise<void>}
   * @private
   */
  async _pasteImagesFromAsyncClipboard() {
    const clipboard = navigator.clipboard;
    if (!clipboard || typeof clipboard.read !== 'function') return;
    let clipboardItems;
    try {
      clipboardItems = await clipboard.read();
    } catch {
      // No permission, insecure context, or nothing readable — nothing to do.
      return;
    }
    /** @type {File[]} */
    const files = [];
    for (const item of clipboardItems) {
      const type = Array.from(item.types || []).find((t) => t.startsWith('image/'));
      if (!type) continue;
      try {
        const blob = await item.getType(type);
        const ext = type.split('/')[1] || 'png';
        // Distinct name per image so a multi-image clipboard doesn't collide.
        files.push(new window.File([blob], `pasted-image-${Date.now()}-${files.length + 1}.${ext}`, { type }));
      } catch {
        // Skip an entry we can't materialise; keep any others.
      }
    }
    if (files.length > 0) this._handleFiles(files);
  }

  /**
   * Validate and upload a set of dropped/pasted/picked files, pushing each
   * successful upload onto _pendingAttachments. Non-image files are ignored;
   * oversized files (single or aggregate) are rejected with a warning.
   *
   * Image attachments are staged regardless of the current model's *capability*
   * — that is never gated client-side; a model that can't accept images rejects
   * the request at send time. Image *size* IS gated here, to the send target's
   * per-provider limit ({@link _maxImageBytes}), so an image the provider would
   * reject never enters the conversation in the first place.
   * @param {FileList|File[]} fileList
   * @private
   */
  _handleFiles(fileList) {
    const files = Array.from(fileList).filter((f) => f.type && f.type.startsWith('image/'));
    if (files.length === 0) return;

    const maxPerImage = this._maxImageBytes();

    for (const file of files) {
      if (file.size > maxPerImage) {
        this.showWarning(
          `"${file.name}" is too large (${(file.size / 1024 / 1024).toFixed(1)} MB, ` +
          `max ${maxPerImage / 1024 / 1024} MB per image for the current model).`
        );
        continue;
      }
      const pendingTotal = this._pendingAttachments.reduce((sum, a) => sum + (a.bytes || 0), 0);
      if (pendingTotal + file.size > MAX_TURN_ATTACHMENT_BYTES) {
        this.showWarning(
          `Attachments exceed the ${MAX_TURN_ATTACHMENT_BYTES / 1024 / 1024} MB ` +
          `per-message limit.`
        );
        break;
      }
      this._uploadAndAdd(file);
    }
  }

  /**
   * Validate and stage a set of dropped non-image files as text snapshots.
   *
   * Three gates, in order:
   *  1. per-file size — checked on `file.size` BEFORE any read, so a multi-GB
   *     drop is rejected without ever being allocated or decoded;
   *  2. aggregate size — the drop's text files may not sum past the per-message
   *     limit (counting already-staged files);
   *  3. binary — after decoding a known-small file, reject anything that looks
   *     binary rather than text ({@link looksBinary}).
   *
   * Survivors are pushed onto `_pendingTextFiles` and become `dropped-file`
   * context items at send time.
   * @param {FileList|File[]} fileList
   * @private
   */
  _handleTextFiles(fileList) {
    for (const file of Array.from(fileList)) {
      // Gate 1: size, on metadata, before reading a single byte.
      if (file.size > MAX_TEXT_DROP_BYTES) {
        this.showWarning(
          `"${file.name}" is too large to attach as text ` +
          `(${(file.size / 1024 / 1024).toFixed(1)} MB, ` +
          `max ${MAX_TEXT_DROP_BYTES / 1024} KB).`
        );
        continue;
      }
      // Gate 2: aggregate across already-staged text files.
      const stagedTotal = this._pendingTextFiles.reduce((sum, t) => sum + (t.bytes || 0), 0);
      if (stagedTotal + file.size > MAX_TEXT_DROP_TURN_BYTES) {
        this.showWarning(
          `Dropped text files exceed the ${MAX_TEXT_DROP_TURN_BYTES / 1024 / 1024} MB ` +
          `per-message limit.`
        );
        break;
      }

      const reader = new window.FileReader();
      reader.onload = () => {
        // readAsText yields a string; guard the union type without String().
        const content = typeof reader.result === 'string' ? reader.result : '';
        // Gate 3: binary check (file is already known-small, so this is cheap).
        if (looksBinary(content)) {
          this.showWarning(`"${file.name}" doesn't look like a text file.`);
          return;
        }
        this._pendingTextFiles.push({ filename: file.name, content, bytes: file.size });
        this._renderAttachmentChips();
        // Persist so the staged file survives a reload alongside the text.
        this._persistDraft();
      };
      reader.onerror = () => this.showWarning(`Couldn't read "${file.name}".`);
      reader.readAsText(file);
    }
  }

  /**
   * Remove a staged dropped text file and re-render the chip row.
   * @param {{filename:string,content:string,bytes:number}} entry
   * @private
   */
  _removeTextFile(entry) {
    const idx = this._pendingTextFiles.indexOf(entry);
    if (idx === -1) return;
    this._pendingTextFiles.splice(idx, 1);
    this._renderAttachmentChips();
    this._persistDraft();
  }

  /**
   * Upload one image file to the conversation's asset store, showing an
   * "uploading" chip while in flight and replacing it with the resolved
   * AssetRef on success (or removing it on failure).
   * @param {File} file
   * @private
   */
  async _uploadAndAdd(file) {
    const convId = this._conversation?.id;
    if (!convId) {
      this.showWarning('No active conversation for the attachment.');
      return;
    }
    // Placeholder chip while the bytes upload. Carries a local preview URL so
    // the thumbnail shows immediately (the asset GET URL only works post-upload).
    const placeholder = {
      id: '', mime: file.type, filename: file.name, bytes: file.size,
      width: 0, height: 0, _uploading: true, _previewURL: URL.createObjectURL(file)
    };
    this._pendingAttachments.push(placeholder);
    this._renderAttachmentChips();

    try {
      const ref = await apiService.uploadAsset(convId, file);
      const idx = this._pendingAttachments.indexOf(placeholder);
      if (idx !== -1) {
        // Carry the local preview URL onto the resolved ref so the thumbnail
        // doesn't flicker (revoked when the chip is removed / cleared).
        this._pendingAttachments[idx] = { ...ref, _previewURL: placeholder._previewURL };
      } else if (placeholder._previewURL) {
        // Chip was removed mid-upload — drop the resolved ref and free the URL.
        URL.revokeObjectURL(placeholder._previewURL);
      }
      this._renderAttachmentChips();
      // The attachment is now a resolved asset — fold it into the persisted
      // draft so it survives a reload alongside the text.
      this._persistDraft();
    } catch (err) {
      const idx = this._pendingAttachments.indexOf(placeholder);
      if (idx !== -1) this._pendingAttachments.splice(idx, 1);
      if (placeholder._previewURL) URL.revokeObjectURL(placeholder._previewURL);
      this._renderAttachmentChips();
      this.showWarning(`Image upload failed: ${extractErrorMessage(err)}`);
    }
  }

  /**
   * Remove a staged attachment and re-render the chip row.
   * @param {{_previewURL?:string}} ref
   * @private
   */
  _removeAttachment(ref) {
    const idx = this._pendingAttachments.indexOf(/** @type {any} */ (ref));
    if (idx === -1) return;
    this._pendingAttachments.splice(idx, 1);
    if (ref._previewURL) URL.revokeObjectURL(ref._previewURL);
    this._renderAttachmentChips();
    // Persist the draft so the removal survives a reload too.
    this._persistDraft();
  }

  /**
   * Replace the staged attachments with a restored set (used when a "rewind to
   * this message" puts an attachment-bearing user message back into the box for
   * editing/resend). Clones each ref down to the persistable AssetRef fields,
   * dropping any UI-only state (`_previewURL`/`_uploading`) from the source —
   * the restored chips render their thumbnails from the asset GET URL.
   *
   * Attachments are restored regardless of the current model — capability is
   * not gated client-side. A model that can't accept images rejects the
   * request at send time and that provider error surfaces as the turn error.
   * @param {Array<{id:string,mime:string,filename:string,bytes:number,width:number,height:number}>} refs
   * @returns {number} Count of attachments actually staged.
   */
  setPendingAttachments(refs) {
    const count = this._stagePendingAttachments(refs);
    // This is a genuine draft change (rewind/restore-from-message) — persist
    // the whole draft so text + attachments survive a reload together.
    this._persistDraft();
    return count;
  }

  /**
   * Replace the in-memory staged attachments and re-render the chip row WITHOUT
   * persisting. Used both by setPendingAttachments (which then persists) and by
   * the draft-restore path in setMessageThread (which is reading FROM the
   * persisted draft, so re-persisting would be redundant churn).
   * @param {Array<{id:string,mime:string,filename:string,bytes:number,width:number,height:number}>} refs
   * @returns {number} Count of attachments actually staged.
   * @private
   */
  _stagePendingAttachments(refs) {
    // Revoke any preview URLs on the outgoing pending set before replacing it.
    for (const a of this._pendingAttachments) {
      if (a._previewURL) URL.revokeObjectURL(a._previewURL);
    }
    this._pendingAttachments = [];

    const list = Array.isArray(refs) ? refs.filter((r) => r && r.id) : [];
    if (list.length === 0) {
      this._renderAttachmentChips();
      return 0;
    }

    this._pendingAttachments = list.map((r) => ({
      id: r.id,
      mime: r.mime,
      filename: r.filename,
      bytes: r.bytes,
      width: r.width,
      height: r.height
    }));
    this._renderAttachmentChips();
    return this._pendingAttachments.length;
  }

  /**
   * Replace the in-memory staged text files and re-render the chip row WITHOUT
   * persisting — the restore counterpart to {@link _stagePendingTextFiles}'s
   * caller reading FROM the persisted draft. Clones down to the persistable
   * fields so no stray UI state carries over.
   * @param {Array<{filename:string,content:string,bytes:number}>} entries
   * @returns {number} Count of text files actually staged.
   * @private
   */
  _stagePendingTextFiles(entries) {
    const list = Array.isArray(entries)
      ? entries.filter((t) => t && typeof t.content === 'string')
      : [];
    this._pendingTextFiles = list.map((t) => ({
      filename: t.filename || 'dropped file',
      content: t.content,
      bytes: t.bytes || 0
    }));
    this._renderAttachmentChips();
    return this._pendingTextFiles.length;
  }

  /**
   * Render the staged-attachment chip row from _pendingAttachments. Rebuilds
   * only its own container (never the textarea), so caret/focus are preserved.
   * @private
   */
  _renderAttachmentChips() {
    // An image staged with no text is a valid send, so the enabled state of the
    // send button depends on attachments too — refresh it on every attachment
    // mutation (this method is the single choke point for add/remove/stage).
    this._updateSendButtonState();
    const container = this.querySelector('input-box-attachments');
    if (!container) return;
    container.innerHTML = '';
    if (this._pendingAttachments.length === 0 && this._pendingTextFiles.length === 0) {
      container.classList.remove('has-attachments');
      return;
    }
    container.classList.add('has-attachments');
    const convId = this._conversation?.id;

    for (const ref of this._pendingAttachments) {
      const chip = document.createElement('div');
      chip.className = 'attachment-chip' + (ref._uploading ? ' uploading' : '');

      const thumb = document.createElement('img');
      thumb.className = 'attachment-thumb';
      thumb.alt = '';
      const src = ref._previewURL || (ref.id && convId ? apiService.assetURL(convId, ref.id) : '');
      if (src) thumb.src = src;
      chip.appendChild(thumb);

      const name = document.createElement('span');
      name.className = 'attachment-name';
      name.textContent = ref.filename || 'image';
      chip.appendChild(name);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'attachment-remove';
      remove.setAttribute('aria-label', 'Remove attachment');
      remove.textContent = '\u00d7';
      remove.addEventListener('click', () => this._removeAttachment(ref));
      chip.appendChild(remove);

      container.appendChild(chip);
    }

    // Dropped text files: a document-icon chip (no image thumbnail).
    for (const entry of this._pendingTextFiles) {
      const chip = document.createElement('div');
      chip.className = 'attachment-chip text-file';

      const icon = document.createElement('span');
      icon.className = 'attachment-icon icon-document';
      chip.appendChild(icon);

      const name = document.createElement('span');
      name.className = 'attachment-name';
      name.textContent = entry.filename || 'text file';
      chip.appendChild(name);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'attachment-remove';
      remove.setAttribute('aria-label', 'Remove attachment');
      remove.textContent = '\u00d7';
      remove.addEventListener('click', () => this._removeTextFile(entry));
      chip.appendChild(remove);

      container.appendChild(chip);
    }
  }

  /**
   * Create a new thread, including textarea text as initial message
   * @private
   */
  _createThread() {
    const textarea = this.querySelector('textarea');
    const text = textarea ? textarea.value.trim() : '';
    let command = '/thread';
    if (text) command += ` --draft-message ${text}`;

    this.dispatchEvent(new CustomEvent('send-message', {
      detail: {
        message: command,
        threadItemId: this.threadItemId || null,
        messageThread: this._messageThread || null
      },
      bubbles: true,
      composed: true
    }));
  }

  // ── Scheduled send ("send after a delay") ─────────────────────────────
  //
  // Clicking the clock button arms a send for a chosen wall-clock time — the
  // intended use is firing a queued command the instant the next LLM-provider
  // time slice opens, so precision is coarse (5-minute granularity). The target
  // is persisted on the thread's draft (epoch ms). This box only arms, cancels,
  // and DISPLAYS a live countdown; the firing itself is owned by
  // scheduledSendService, which sweeps every thread on an interval so a send
  // goes out even while a different thread or tab is on screen. When the due
  // thread IS on screen the service calls _fireScheduledSend here, so the send
  // carries the live textarea's exact contents.

  /**
   * Stop the countdown-refresh interval WITHOUT touching `_scheduledSendAt` or
   * the persisted draft — the target survives so a later rebind restores it.
   * @private
   */
  _stopScheduledCountdown() {
    if (this._scheduledCountdownId !== null) {
      clearInterval(this._scheduledCountdownId);
      this._scheduledCountdownId = null;
    }
  }

  /**
   * Start (or restart) the coarse interval that refreshes the countdown label.
   * Display only — it never fires the send. The label is recomputed from the
   * absolute target each tick, so a throttled background timer can't make the
   * displayed countdown drift.
   * @private
   */
  _startScheduledCountdown() {
    this._stopScheduledCountdown();
    this._scheduledCountdownId = setInterval(() => this._updateScheduleButton(), 30000);
  }

  /**
   * Arm a send for the absolute instant `targetAt` (epoch ms): record it,
   * persist it onto the thread's draft, start the countdown, and reflect it on
   * the clock button. scheduledSendService picks it up from the draft.
   * @param {number} targetAt
   * @private
   */
  _armScheduledSend(targetAt) {
    this._scheduledSendAt = targetAt;
    this._persistDraft();
    this._startScheduledCountdown();
    this._updateScheduleButton();
  }

  /**
   * Cancel the pending send: stop the countdown, clear the target, and remove
   * it from the persisted draft.
   * @private
   */
  _cancelScheduledSend() {
    this._stopScheduledCountdown();
    this._scheduledSendAt = null;
    this._persistDraft();
    this._updateScheduleButton();
  }

  /**
   * Fire the pending send. Called by scheduledSendService when THIS box is the
   * one bound to the due thread. Clears the schedule FIRST (and persists that,
   * so an empty box — where sendMessage() no-ops without clearing the draft —
   * doesn't leave the target behind to re-fire on the next sweep), then presses
   * Send on whatever is currently in the box.
   * @private
   */
  _fireScheduledSend() {
    this._stopScheduledCountdown();
    this._scheduledSendAt = null;
    this._persistDraft();
    this._updateScheduleButton();
    this.sendMessage();
  }

  /**
   * Re-derive the displayed scheduled-send state from the bound thread's
   * persisted draft. Stops any countdown left over from a previously-bound
   * thread, then restores the target and its countdown for the newly-bound
   * thread. Firing (including for an already-passed target) is left to
   * scheduledSendService. Called after the controls render and on every genuine
   * thread switch.
   * @private
   */
  _syncScheduledSendFromDraft() {
    this._stopScheduledCountdown();
    const when = this._messageThread ? this._messageThread.draft.scheduledSendAt : null;
    this._scheduledSendAt = (typeof when === 'number' && Number.isFinite(when)) ? when : null;
    if (this._scheduledSendAt !== null) {
      this._startScheduledCountdown();
    }
    this._updateScheduleButton();
  }

  /**
   * Reflect the current scheduled-send state on the clock button: an `armed`
   * class, a live countdown badge, and a tooltip naming the target time.
   *
   * An empty box overrides all of that: arming (or leaving armed) a delayed
   * send with nothing to send would silently fire nothing, so an empty box
   * disables the button and renders it un-armed — WITHOUT clearing
   * `_scheduledSendAt` or the persisted draft. A timer the user already set is
   * only hidden; the moment they type again this re-renders it armed with its
   * countdown intact.
   * @private
   */
  _updateScheduleButton() {
    const btn = this.querySelector('.schedule-send-btn');
    if (!btn) return;
    const label = btn.querySelector('.schedule-send-countdown');
    const empty = this._isComposerEmpty();
    /** @type {HTMLButtonElement} */ (btn).disabled = empty;
    if (this._scheduledSendAt === null || empty) {
      btn.classList.remove('armed');
      // When a timer is armed but hidden by an empty box, point the user at how
      // to bring it back rather than implying nothing is set.
      btn.setAttribute('title', (empty && this._scheduledSendAt !== null)
        ? 'Type a message to resume the timer'
        : 'Send after a delay');
      if (label) {
        /** @type {HTMLElement} */ (label).hidden = true;
        label.textContent = '';
      }
      return;
    }
    btn.classList.add('armed');
    const remaining = Math.max(0, this._scheduledSendAt - Date.now());
    btn.setAttribute('title', `Sending at ${formatClockTime(this._scheduledSendAt)} — click to change or cancel`);
    if (label) {
      /** @type {HTMLElement} */ (label).hidden = false;
      label.textContent = formatDelayShort(remaining);
    }
  }

  /**
   * Toggle the delay picker: close it if open, otherwise open it.
   * @private
   */
  _toggleSchedulePicker() {
    if (this._schedulePickerCleanup) {
      this._closeSchedulePicker();
    } else {
      this._openSchedulePicker();
    }
  }

  /**
   * Close the delay picker (tears down its popup surface).
   * @private
   */
  _closeSchedulePicker() {
    if (this._schedulePickerCleanup) {
      const release = this._schedulePickerCleanup;
      this._schedulePickerCleanup = null;
      release();
    }
  }

  /**
   * Build and present the delay picker, anchored to the clock button (or a
   * bottom sheet on a phone). Two shapes:
   *   • Armed — a single "Cancel timer" button (nothing else to decide).
   *   • Idle — full-width preset chips (15m…5h), hours + 5-minute steppers, and
   *     one full-width "Schedule to send at HH:MM" button that both previews the
   *     target time and confirms it.
   * The picker never edits the textarea.
   * @private
   */
  _openSchedulePicker() {
    const anchor = /** @type {HTMLElement|null} */ (this.querySelector('.schedule-send-btn'));
    if (!anchor) return;

    const menu = document.createElement('div');
    menu.className = 'dropdown-menu schedule-send-menu show';
    menu.id = 'schedule-send-menu';

    const present = () => {
      this._schedulePickerCleanup = presentPopup({
        surface: menu,
        anchor,
        id: 'schedule-send',
        onClose: () => this._closeSchedulePicker(),
        align: 'right',
        insideSelectors: ['.schedule-send-btn', '.schedule-send-menu'],
      });
    };

    // --- Armed: show the target time, offer to cancel -----------------------
    if (this._scheduledSendAt) {
      const targetLine = document.createElement('div');
      targetLine.className = 'schedule-armed-target';
      targetLine.textContent = `Sending at ${formatClockTime(this._scheduledSendAt)}`;
      menu.appendChild(targetLine);

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'schedule-cancel-btn schedule-cancel-only';
      cancelBtn.textContent = 'Cancel timer';
      cancelBtn.addEventListener('click', () => {
        this._cancelScheduledSend();
        this._closeSchedulePicker();
      });
      menu.appendChild(cancelBtn);
      present();
      return;
    }

    // --- Idle: pick a delay -------------------------------------------------
    let hours = 1;
    let minutes = 0;

    const heading = document.createElement('div');
    heading.className = 'schedule-send-heading';
    heading.textContent = 'Send after a delay';
    menu.appendChild(heading);

    // Preset chips — stretch to fill the row.
    const presetRow = document.createElement('div');
    presetRow.className = 'schedule-preset-row';
    menu.appendChild(presetRow);

    // Steppers.
    const steppers = document.createElement('div');
    steppers.className = 'schedule-steppers';
    menu.appendChild(steppers);

    /**
     * @param {string} unitLabel
     * @param {() => number} get
     * @param {(v: number) => void} set
     * @param {number} min
     * @param {number} max
     * @param {number} step
     * @returns {HTMLElement} the value element (for later text updates)
     */
    const buildStepper = (unitLabel, get, set, min, max, step) => {
      const wrap = document.createElement('div');
      wrap.className = 'schedule-stepper';
      const dec = document.createElement('button');
      dec.type = 'button';
      dec.className = 'schedule-stepper-btn';
      dec.textContent = '\u2212'; // minus
      dec.setAttribute('aria-label', `Fewer ${unitLabel}`);
      const val = document.createElement('span');
      val.className = 'schedule-stepper-value';
      const unit = document.createElement('span');
      unit.className = 'schedule-stepper-unit';
      unit.textContent = unitLabel;
      const inc = document.createElement('button');
      inc.type = 'button';
      inc.className = 'schedule-stepper-btn';
      inc.textContent = '+';
      inc.setAttribute('aria-label', `More ${unitLabel}`);
      dec.addEventListener('click', () => { set(Math.max(min, get() - step)); refresh(); });
      inc.addEventListener('click', () => { set(Math.min(max, get() + step)); refresh(); });
      wrap.append(dec, val, unit, inc);
      steppers.appendChild(wrap);
      return val;
    };

    const hoursValueEl = buildStepper('hr',
      () => hours, (v) => { hours = v; }, 0, SCHEDULE_MAX_HOURS, 1);
    const minutesValueEl = buildStepper('min',
      () => minutes, (v) => { minutes = v; }, 0, 60 - SCHEDULE_MINUTE_STEP, SCHEDULE_MINUTE_STEP);

    // One full-width button that both previews and confirms the target time.
    const actions = document.createElement('div');
    actions.className = 'schedule-actions';
    const scheduleBtn = document.createElement('button');
    scheduleBtn.type = 'button';
    scheduleBtn.className = 'schedule-confirm-btn';
    actions.appendChild(scheduleBtn);
    menu.appendChild(actions);

    const refresh = () => {
      hoursValueEl.textContent = String(hours);
      minutesValueEl.textContent = String(minutes).padStart(2, '0');
      const totalMin = hours * 60 + minutes;
      if (totalMin <= 0) {
        scheduleBtn.textContent = 'Pick a delay above';
        scheduleBtn.disabled = true;
      } else {
        scheduleBtn.disabled = false;
        scheduleBtn.textContent = `Schedule to send at ${formatClockTime(Date.now() + totalMin * 60000)}`;
      }
    };

    for (const preset of SCHEDULE_PRESETS) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'schedule-preset';
      chip.textContent = preset.label;
      chip.addEventListener('click', () => {
        hours = Math.min(SCHEDULE_MAX_HOURS, Math.floor(preset.minutes / 60));
        minutes = preset.minutes % 60;
        refresh();
      });
      presetRow.appendChild(chip);
    }

    scheduleBtn.addEventListener('click', () => {
      const totalMin = hours * 60 + minutes;
      if (totalMin <= 0) return;
      this._armScheduledSend(Date.now() + totalMin * 60000);
      this._closeSchedulePicker();
    });

    refresh();
    present();
  }

  /**
   * Create the commands dropdown menu element
   * @private
   */
  _createCommandsMenu() {
    if (this._commandsMenu) {
      this._commandsMenu.remove();
    }

    const menu = document.createElement('menu');
    menu.className = 'dropdown-menu commands-menu';
    menu.id = 'commands-menu';

    const commands = slashCommandHandler.getCommands();

    // Explicit menu ordering: tab operations first (new, duplicate), then
    // thread, then conversation-history operations (clear, compact).
    const ORDER = ['new', 'duplicate', 'thread', 'clear', 'compact'];
    commands.sort((a, b) => {
      const ai = ORDER.indexOf(a.name);
      const bi = ORDER.indexOf(b.name);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });

    for (const cmd of commands) {
      const item = document.createElement('li');
      item.className = 'menu-item' + (cmd.danger ? ' danger' : '');
      item.dataset.command = cmd.name;

      const code = document.createElement('code');
      code.textContent = '/' + cmd.name;
      item.appendChild(code);

      const desc = document.createElement('span');
      desc.className = 'menu-item-desc';
      const displayLabel = cmd.label || cmd.name.charAt(0).toUpperCase() + cmd.name.slice(1);
      desc.textContent = displayLabel;
      item.appendChild(desc);

      item.addEventListener('click', () => {
        this._executeSlashCommand(cmd.name);
      });

      menu.appendChild(item);
    }

    // presentPopup (in _openCommandsMenu) owns body-append and teardown.
    this._commandsMenu = menu;
  }

  /**
   * Toggle commands menu visibility
   * @private
   */
  _toggleCommandsMenu() {
    if (this._commandsMenuOpen) {
      this._closeCommandsMenu();
    } else {
      this._openCommandsMenu();
    }
  }

  /**
   * Open the commands menu
   * @private
   * @returns {Promise<void>}
   */
  async _openCommandsMenu() {
    await slashCommandHandler.init();
    this._createCommandsMenu();

    if (!this._commandsMenu) return;

    const button = this.querySelector('#commands-button');
    if (!button) return;

    this._commandsMenu.classList.add('show');
    this._commandsMenuOpen = true;

    // presentPopup owns body-append, dismissal wiring (outside-click via
    // insideSelectors + Escape, which dismisses the menu rather than
    // cancelling a running turn), the reposition observer, and the
    // anchored-vs-sheet decision.
    this._popupCleanup = presentPopup({
      surface: this._commandsMenu,
      anchor: /** @type {HTMLElement} */ (button),
      id: 'slash-commands',
      onClose: () => this._closeCommandsMenu(),
      align: 'left',
      gap: 4,
      insideSelectors: ['#commands-button', '.commands-menu'],
    });
  }

  /**
   * Close the commands menu
   * @private
   */
  _closeCommandsMenu() {
    if (!this._commandsMenu) return;

    this._commandsMenuOpen = false;
    // Release tears down the surface, scrim, observer and dismissal wiring.
    if (this._popupCleanup) {
      this._popupCleanup();
      this._popupCleanup = null;
    }
    this._commandsMenu = null;
  }

  /**
   * Execute a slash command
   * @param {string} commandName
   * @private
   */
  async _executeSlashCommand(commandName) {
    this._closeCommandsMenu();

    if (!this._conversation) return;

    await this._conversation.sendMessage('/' + commandName, null, this._messageThread || undefined);
  }

  /**
   * Toggle the touch-only "+" actions sheet.
   * @private
   */
  _toggleActionsSheet() {
    if (this._actionsSheetOpen) {
      this._closeActionsSheet();
    } else {
      this._openActionsSheet();
    }
  }

  /**
   * Build and present the "+" actions sheet: every slash command as a row,
   * followed by Attach image and New Thread. On a narrow viewport presentPopup
   * renders it as a bottom sheet (drag-to-dismiss); on a wider one it anchors
   * to the "+" button. The rows reuse the same handlers as the inline controls,
   * so nothing nests a second popup.
   * @private
   * @returns {Promise<void>}
   */
  async _openActionsSheet() {
    await slashCommandHandler.init();

    const button = this.querySelector('#more-actions-button');
    if (!button) return;

    const menu = document.createElement('menu');
    menu.className = 'dropdown-menu actions-sheet show';
    menu.id = 'actions-sheet';

    /**
     * @param {string} label
     * @param {string} iconSvg
     * @param {() => void} onClick
     */
    const addRow = (label, iconSvg, onClick) => {
      const item = document.createElement('li');
      item.className = 'menu-item actions-sheet-item';
      const icon = document.createElement('span');
      icon.className = 'actions-sheet-icon';
      icon.innerHTML = iconSvg;
      item.appendChild(icon);
      const text = document.createElement('span');
      text.className = 'actions-sheet-label';
      text.textContent = label;
      item.appendChild(text);
      item.addEventListener('click', () => {
        this._closeActionsSheet();
        onClick();
      });
      menu.appendChild(item);
    };

    const commands = slashCommandHandler.getCommands();
    const ORDER = ['new', 'duplicate', 'thread', 'clear', 'compact'];
    commands.sort((a, b) => {
      const ai = ORDER.indexOf(a.name);
      const bi = ORDER.indexOf(b.name);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
    for (const cmd of commands) {
      const displayLabel = cmd.label || cmd.name.charAt(0).toUpperCase() + cmd.name.slice(1);
      const row = document.createElement('li');
      row.className = 'menu-item actions-sheet-item' + (cmd.danger ? ' danger' : '');
      row.dataset.command = cmd.name;
      const code = document.createElement('code');
      code.textContent = '/' + cmd.name;
      row.appendChild(code);
      const desc = document.createElement('span');
      desc.className = 'actions-sheet-label';
      desc.textContent = displayLabel;
      row.appendChild(desc);
      row.addEventListener('click', () => {
        this._closeActionsSheet();
        this._executeSlashCommand(cmd.name);
      });
      menu.appendChild(row);
    }

    addRow('Attach image', IMAGE_ATTACH_SVG, () => {
      /** @type {HTMLInputElement|null} */
      (this.querySelector('.attach-file-input'))?.click();
    });
    addRow('New Thread', THREAD_ARROW_SVG, () => this._createThread());

    // Relocate the live strategy selector into the sheet — on touch it is
    // hidden from the inline row to keep that row single-line. Re-parenting
    // preserves its messageThread (a plain property, untouched by
    // disconnect/reconnect), so it keeps working; _closeActionsSheet returns it
    // to its inline home before the sheet surface is torn down. It renders its
    // own button + dropdown, so it works at any viewport width (unlike clicking
    // a hidden inline anchor, which would mis-anchor on wide tablets).
    const strategySel = /** @type {HTMLElement|null} */ (this.querySelector('strategy-selector'));
    if (strategySel) {
      const row = document.createElement('li');
      row.className = 'menu-item actions-sheet-item actions-sheet-strategy';
      const label = document.createElement('span');
      label.className = 'actions-sheet-label';
      label.textContent = 'Strategy';
      row.appendChild(label);
      row.appendChild(strategySel); // moves the element out of the inline row
      menu.appendChild(row);
      this._relocatedStrategy = strategySel;
    }

    this._actionsSheet = menu;
    this._actionsSheetOpen = true;
    this._actionsSheetCleanup = presentPopup({
      surface: menu,
      anchor: /** @type {HTMLElement} */ (button),
      id: 'input-actions-sheet',
      onClose: () => this._closeActionsSheet(),
      align: 'left',
      gap: 4,
      insideSelectors: ['#more-actions-button', '.actions-sheet'],
    });
  }

  /**
   * Close the "+" actions sheet.
   * @private
   */
  _closeActionsSheet() {
    if (!this._actionsSheetOpen) return;
    this._actionsSheetOpen = false;
    // Return the relocated strategy selector to its inline home (just before the
    // model selector) BEFORE the sheet surface is removed — otherwise it would
    // be torn down along with the sheet.
    if (this._relocatedStrategy) {
      const left = this.querySelector('input-controls-left');
      const model = this.querySelector('model-selector');
      if (left) left.insertBefore(this._relocatedStrategy, model || null);
      this._relocatedStrategy = null;
    }
    if (this._actionsSheetCleanup) {
      this._actionsSheetCleanup();
      this._actionsSheetCleanup = null;
    }
    this._actionsSheet = null;
  }

  render() {
    this.innerHTML = `
            <input-box-wrapper>
                <input-box-attachments></input-box-attachments>
                <textarea
                    placeholder="Enter your command..."
                    aria-label="Message input"
                    autocorrect="off"
                    autocapitalize="off"
                    spellcheck="false"
                    enterkeyhint="enter"
                ></textarea>
                <input type="file" class="attach-file-input" accept="image/*" multiple hidden />
                <input-controls>
                    <input-controls-left>
                        <permission-controls></permission-controls>
                        <button class="commands-button input-ctrl-btn" id="commands-button"
                                title="Commands"
                                aria-label="Commands menu">
                            <span class="icon-slash"></span>
                        </button>
                        <button class="attach-image-btn input-ctrl-btn" id="attach-image-button"
                                title="Attach image"
                                aria-label="Attach image">
                            <span class="attach-image-icon">${IMAGE_ATTACH_SVG}</span>
                        </button>
                        <strategy-selector></strategy-selector>
                        <model-selector id="conversation-model-selector"></model-selector>
                        <button class="more-actions-btn input-ctrl-btn" id="more-actions-button"
                                title="More actions"
                                aria-label="More actions">
                            <span class="more-actions-icon">${PLUS_SVG}</span>
                        </button>
                        <button class="schedule-send-btn input-ctrl-btn"
                                title="Send after a delay"
                                aria-label="Send after a delay">
                            <span class="schedule-send-icon">${CLOCK_SVG}</span>
                            <span class="schedule-send-countdown" hidden></span>
                        </button>
                    </input-controls-left>
                    <input-controls-right>
                        <button class="new-thread-btn input-ctrl-btn" title="Create a new sub-thread">
                            New Thread
                            <span class="new-thread-arrow">${THREAD_ARROW_SVG}</span>
                        </button>
                        <button class="send-btn is-empty" id="send-button"
                                title="Send message"
                                aria-label="Send message">
                            <span class="send-icon">${SEND_ARROW_SVG}</span>
                        </button>
                    </input-controls-right>
                </input-controls>
            </input-box-wrapper>
        `;
    // Defer listener setup a frame so the just-written DOM is laid out.
    requestAnimationFrame(() => {
      this.setupListeners();
      // Pass conversation to strategy selector and permission controls if already set
      if (this._conversation) {
        this.setConversation(this._conversation);
      }
    });
  }
}

customElements.define('input-box', InputBox);
