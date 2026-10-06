//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import './permission-controls.js';


import { DRAFT_SAVE_DEBOUNCE_MS } from '../utils/constants.js';
import slashCommandHandler from '../services/slash-command-handler.js';
import { menuOrderedCommands, buildCommandRow, buildManageCommandsRow, buildBrowseCommandsRow } from '../services/command-manager-entry.js';
import { openCommandManager } from './command-editor-dialog.js';
import { isAnyPopupOpen } from '../utils/popup-manager.js';
import { handleEscapeKey } from '../services/escape-behaviour.js';
import { presentPopup, COARSE_POINTER_QUERY } from '../utils/popup-surface.js';
import { CompletionMenu } from './completion-menu.js';
import { fileMentionProvider, extractFileMentionsAsync } from './file-mention-provider.js';
import { slashCommandProvider } from './slash-command-provider.js';
import {
  createSkillMentionProvider,
  getThreadSkillSnapshot,
  extractSkillMentions,
  renderSkillMenuItem,
} from './skill-mention-provider.js';
import { THREAD_ARROW_SVG, PAPERCLIP_SVG, SEND_ARROW_SVG, KEBAB_SVG, CLOCK_SVG } from '../utils/icons.js';
import { showNotice } from './modal-dialog.js';
import { openSettings } from '../services/settings-launcher.js';
import tooltipManager from '../services/tooltip-manager.js';
import { CONTEXT_CACHE_IMPACT_CHANGED } from '../services/context-cache-impact.js';
import { isDesktopWindow } from '../../sdk/lib/window-control.js';
import { isConversationalItemType } from '../../sdk/lib/message.js';
import {
  COMPOSER_IDLE_MS,
  COMPOSER_LONG_THREAD_ITEMS,
  pickComposerPlaceholder,
  trailingTurnOutcome,
} from '../utils/composer-placeholders.js';
import { expandPasteTokens } from '../utils/paste-tokens.js';
import {
  isFileDrag,
  splitFiles,
  installFileDropGuard,
  markFileDropAccepted,
} from '../utils/file-drop.js';
import {
  handleFiles,
  handleTextFiles,
  pasteImagesFromAsyncClipboard,
  renderAttachmentChips,
  setPendingAttachments,
  stagePendingAttachments,
  stagePendingTextFiles,
  uploadAndAdd,
} from './composer-attachments.js';
import {
  capturePaste,
  handleTokenKeydown,
  onClipboardCopyCut,
  reconcileTokens,
  shouldCapturePaste,
  snapSelectionOutOfTokens,
  syncPasteMirror,
  teardownPasteMirror,
  tokenAtPoint,
  expandTokenWithFeedback,
} from './composer-paste-tokens.js';
import {
  clearScheduledSendState,
  fireScheduledSend as fireArmedSend,
  reconcileScheduleWithDraft,
  stopScheduledCountdown,
  syncScheduledSendFromDraft,
  toggleSchedulePicker,
  updateScheduleButton,
} from './composer-schedule.js';

/**
 * Composer component for sending messages.
 *
 * Three self-contained corners of it live in companion modules, each taking
 * this element as their first argument: composer-attachments.js (image and
 * text-file staging), composer-paste-tokens.js (pasted-text placeholders) and
 * composer-schedule.js (send after a delay). What stays here is the box
 * itself — text, drafts, history, sending, and the menus.
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



class Composer extends HTMLElement {
  constructor() {
    super();
    /** @type {boolean} @private */
    this.disabled = false;

    // Whether the send is held while the box itself stays live, and what it is
    // waiting for.
    /** @type {boolean} @private */
    this.sendBlocked = false;

    /** @type {string} @private */
    this._sendBlockedReason = '';

    // True from the moment a send is accepted until its `send-message` event
    // has been dispatched. sendMessage() reads the box, then awaits the skill
    // snapshot and the @-mention/dropped-file reads before dispatching, and the
    // box is only cleared downstream by Conversation.sendMessage — so for the
    // width of those awaits the text is still present and `is-empty` is still
    // off, leaving the button and Enter live. On a slow link that window is
    // seconds wide, and each press would otherwise dispatch its own send and
    // land its own copy of the message (the worker appends unconditionally and
    // queues the rest in pendingItems). This latch is the only thing making the
    // send re-entrancy-safe; every entry point funnels through sendMessage().
    /** @type {boolean} @private */
    this._sending = false;

    /** @type {number|null} @private */
    this._autoResizeFrame = null;

    // History navigation state
    /** @type {import('../model/session.js').default|null} @private */
    this.session = null;           // Session reference for accessing messages
    /** @type {number} @private */
    this.historyIndex = -1;        // -1 = current draft, 0+ = index into history
    /** @type {import('../model/session.js').HistoryMessage} @private */
    this.currentDraft = { content: '', attachments: [] }; // Work-in-progress (text + staged images) saved when navigating
    /** @type {Record<number, import('../model/session.js').HistoryMessage>} @private */
    this._historyEdits = {};       // Per-level edits (text + staged images) preserved across navigation

    // Draft save debounce timer
    /** @type {number|null} @private */
    this._draftSaveTimeoutId = null;

    // Conversation reference for strategy selector
    /** @type {import('../model/conversation.js').default|null} @private */
    this._conversation = null;
    /** @type {((event: any) => void)|null} @private */
    this._conversationMetadataObserver = null;

    // Thread context - when set, messages are routed to this thread's nested items
    /** @type {string|null} */
    this.threadItemId = null;

    // Column-scoped message thread
    /** @type {import('../model/message-thread.js').MessageThread|null} @private */
    this._messageThread = null;

    // Logical key ("conversationId::threadItemId") of the thread whose draft was
    // last restored into the textarea. Restoring writes `textarea.value`, which
    // wipes the browser's native undo stack — so the restore must be STICKY on
    // this key, not on `_messageThread` object/field state: a re-bind to the
    // same logical thread (which happens on every doc-driven rebuild, and after
    // a transient loss of the binding) must be a no-op, never a re-restore.
    /** @type {string|null} @private */
    this._restoredThreadKey = null;

    // The conversation state the placeholder currently on screen was picked
    // for. A bucket can hold several lines and the pick is random, so re-picking
    // on every doc update would leave the empty box reshuffling its own text
    // under the user; remembering the state means the line changes only when
    // the situation it describes does.
    /** @type {string} @private */
    this._placeholderState = '';

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

    // Paste-placeholder side table: token id → captured blob. APPEND-ONLY for
    // the draft's life (never pruned when a token vanishes from the text), which
    // is what makes native undo/redo of a token airtight — any resurrected token
    // character still resolves. GC'd only at draft boundaries (send / clear /
    // thread-switch restore). See utils/paste-tokens and _capturePaste.
    /** @type {Map<number, {content:string, bytes:number}>} @private */
    this._pasteBlobs = new Map();
    // Backdrop mirror that renders the styled token pills behind a
    // transparent-text textarea. Built lazily on the first token and torn down
    // when the last token goes, so a token-free composer is a plain textarea.
    /** @type {HTMLElement|null} @private */
    this._pasteMirror = null;
    /** @type {ResizeObserver|null} @private */
    this._pasteMirrorRO = null;
    /** @type {(() => void)|null} @private selectionchange listener while mirrored */
    this._pasteSelectionListener = null;
    /** @type {boolean} @private reentrancy guard while snapping the selection */
    this._snappingSelection = false;
    // Last reconciled textarea value — the revert base for the input-time token
    // reconciler. Any input that damages a token's interior is rolled back to
    // this, so a placeholder's contents can never be edited (only deleted whole).
    /** @type {string} @private */
    this._pasteLastValue = '';
    // Last known caret offset, used to snap a collapsed caret OUT of a token in
    // the direction of travel (word/line jump into a label → bounce past it).
    /** @type {number} @private */
    this._pasteLastCaret = 0;
    // True between compositionstart/end so the reconciler and caret-snapping keep
    // hands off an in-flight IME composition.
    /** @type {boolean} @private */
    this._pasteComposing = false;
    // True while the reconciler's own repair edit runs, so the input that edit
    // fires is not reconciled a second time.
    /** @type {boolean} @private */
    this._pasteRepairing = false;
    // Depth of the undo/redo steps the reconciler is taking past a broken
    // token (see reconcileTokens), bounding that recursion.
    /** @type {number} @private */
    this._pasteHistoryHops = 0;

    // Scheduled-send ("send after a delay") state. The armed target is an
    // epoch-ms wall-clock time persisted on the bound thread's draft (so it
    // survives a reload and stays bound to that thread). This box only arms,
    // cancels, and DISPLAYS the schedule — the actual firing is owned by
    // scheduledSendService, which polls every thread so a send goes out even
    // when this thread isn't the one on screen. See composer-schedule.js's
    // syncScheduledSendFromDraft.
    /** @type {number|null} @private epoch-ms target for the pending send, or null */
    this._scheduledSendAt = null;
    // What the armed send is waiting for: a wall-clock instant ('delay') or the
    // end of the conversation's current turn ('turn-end', where the target is
    // just the arming time). Only meaningful while `_scheduledSendAt` is set.
    /** @type {import('../utils/attachments.js').ScheduledSendMode} @private */
    this._scheduledSendMode = 'delay';
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

    // Skill picker menu state
    /** @type {HTMLElement|null} @private */
    this._skillMenu = null;
    /** @type {boolean} @private */
    this._skillMenuOpen = false;
    /** @type {(() => void)|null} @private - presentPopup release for the open skill picker. */
    this._skillPopupCleanup = null;

    // Touch-only "⋮" actions sheet state (commands / attach / new thread).
    /** @type {HTMLElement|null} @private */
    this._actionsSheet = null;
    /** @type {boolean} @private */
    this._actionsSheetOpen = false;
    /** @type {(() => void)|null} @private - presentPopup release for the open actions sheet. */
    this._actionsSheetCleanup = null;

    /** @type {(() => void)|null} @private - Detaches the pointer-type listener that re-homes the config controls. */
    this._pointerQueryCleanup = null;

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

    // Guards the once-only context-cache-impact listener on `this` (setupListeners
    // reruns on every render, but this listener rides child re-renders and must
    // not stack). See setupListeners.
    /** @type {boolean} @private */
    this._impactListenerBound = false;
    // Guards the once-only drag-and-drop listeners on `this`, for the same
    // reason: they ride child re-renders, and a second set would stage every
    // dropped file twice. See setupListeners.
    /** @type {boolean} @private */
    this._dragListenersBound = false;
    /** @type {boolean} @private */
    this._cacheImpactWarning = false;
  }

  connectedCallback() {
    this.render();
    this._watchPointerType();
    // Take an unclaimed keyboard on arrival — except in a sub-thread column,
    // whose box gets focus only through conversation-tab's Rule 15. That rule
    // stands down while the arrow keys are walking the item list, which is
    // precisely when focus sits on <body>; a thread column created by ↑/↓
    // landing on a thread tile would otherwise pull the keyboard out of the list.
    if (document.activeElement === document.body
      && !this.closest('.thread-column')
      && !document.querySelector('conversation-bar.tab-list-focused')) {
      this.querySelector('textarea')?.focus();
    }
  }

  disconnectedCallback() {
    // Stop following the pointer type; the listener outlives the element.
    if (this._pointerQueryCleanup) {
      this._pointerQueryCleanup();
      this._pointerQueryCleanup = null;
    }
    // Drop a queued height measurement: it would resolve against a detached box
    // and measure nothing.
    this._cancelScheduledAutoResize();
    // Tear down an open commands menu (surface, scrim, observer, dismissal).
    if (this._popupCleanup) {
      this._popupCleanup();
      this._popupCleanup = null;
    }
    // Tear down an open skill picker likewise.
    this._closeSkillMenu();
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
    if (this._conversationMetadataObserver && this._conversation) {
      this._conversation.unobserveMetadata(this._conversationMetadataObserver);
      this._conversationMetadataObserver = null;
    }
    // Drop the countdown-refresh interval. The target stays persisted on the
    // thread's draft, so reconnecting (or rebinding) restores the countdown —
    // and scheduledSendService fires it whether or not this box is mounted.
    stopScheduledCountdown(this);
    // Tear down the token mirror — critically, this detaches the document-level
    // selectionchange listener so a removed box leaves no dangling handler.
    teardownPasteMirror(this);
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
      getWrapper: () => this.querySelector('composer-box-wrapper'),
      onResize: () => this.autoResize(textarea),
      // An argument-less slash command runs on the Enter/click that accepts it,
      // so accepting it submits the composer directly instead of leaving the
      // user to press Enter a second time.
      onSubmit: () => this.sendMessage(),
      // `$name` skill mentions resolve against THIS thread's frozen snapshot,
      // evaluated lazily per fetch so a later thread swap is picked up.
      providers: [
        slashCommandProvider,
        fileMentionProvider,
        createSkillMentionProvider(() => getThreadSkillSnapshot(this._messageThread)),
      ],
    });

    // Re-run autoResize whenever the textarea's width changes (e.g. column
    // drag-resize reflowing multi-line text to a different line count).
    // Two guards keep this from emitting "ResizeObserver loop completed with
    // undelivered notifications": (1) act on width only, since autoResize
    // mutates height and reacting to that would feed back into the observer;
    // (2) defer the height write to the next frame — _scheduleAutoResize, whose
    // deferral this depends on — so it lands outside the observer's own
    // delivery cycle rather than mutating layout mid-delivery.
    /** @type {number|null|undefined} */
    let lastWidth = null;
    const resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width === lastWidth) return;
      lastWidth = width;
      this._scheduleAutoResize(textarea);
    });
    resizeObserver.observe(textarea);

    // Click on the empty wrapper area focuses the textarea. Skip clicks that
    // land on a control button (or anywhere in input-controls): those must not
    // programmatically focus the textarea, because on mobile that pops the
    // onscreen keyboard just from opening a popup. On desktop the caret already
    // stays in the textarea via the mousedown preventDefault below, so skipping
    // here changes nothing there — focus still "remains" on the composer.
    const wrapper = this.querySelector('composer-box-wrapper');
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

    // Skill picker button: a mouse-first alternative to typing `$`, mirroring the
    // commands (`/`) button. It opens a menu of this thread's skills and inserts
    // NOTHING on open or dismissal — only SELECTING a skill splices `$name ` into
    // the composer, which then flows through the identical send-time activation
    // path.
    const skillButton = this.querySelector('#skill-button');
    if (skillButton) {
      skillButton.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleSkillMenu();
      });
    }

    // Attachments: the file-picker button, paste, and drag-and-drop. The
    // picker takes any file and routes it exactly as a drop would
    // (acceptFiles): images through _handleFiles, which validates size /
    // capability and uploads to the asset store, and everything else through
    // _handleTextFiles as a text snapshot. A browser picker reads the CLIENT's
    // disk, which is the right machine whether or not the server is local.
    const attachBtn = this.querySelector('#attach-button');
    const fileInput = /** @type {HTMLInputElement|null} */ (this.querySelector('.attach-file-input'));
    if (attachBtn && fileInput) {
      attachBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        fileInput.click();
      });
      fileInput.addEventListener('change', () => {
        this.acceptFiles(fileInput.files);
        // Reset so selecting the same file again re-fires change.
        fileInput.value = '';
      });
    }

    // Paste image data (screenshot, copied image) — upload it and suppress the
    // default paste of those image items (avoids also pasting a filename).
    textarea.addEventListener('paste', (e) => {
      /** @type {File[]} */
      const imageFiles = [];
      for (const item of Array.from(e.clipboardData?.items || [])) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        this._handleFiles(imageFiles);
        return;
      }
      // Large text paste → collapse into an inline placeholder token instead of
      // flooding the textarea. Runs after the image branch (images keep
      // priority) and only for a genuinely large payload; anything smaller falls
      // through to the browser's normal text paste, unchanged.
      let pastedText = '';
      try { pastedText = e.clipboardData?.getData('text/plain') || ''; } catch { /* restricted */ }
      if (pastedText && this._shouldCapturePaste(pastedText)) {
        e.preventDefault();
        this._capturePaste(pastedText);
        return;
      }
      // WebKit desktop (WebKitGTK/WKWebView, i.e. the Wails app) routinely leaves
      // the synchronous paste event without the image file, exposing it only
      // through the async Clipboard API. Fall back to that — but only in the
      // desktop window (no clipboard-read permission prompt there) and only for a
      // text-less paste, so ordinary text pastes never read the clipboard.
      if (!isDesktopWindow()) return;
      let hasText = false;
      try { hasText = !!e.clipboardData?.getData('text/plain'); } catch { /* restricted */ }
      if (!hasText) void this._pasteImagesFromAsyncClipboard();
    });

    // Drag-and-drop files anywhere onto the composer. The listeners live on the
    // host element (`this`) so the whole component is a drop zone — including
    // the padding around the bubble — not just the inner bubble. The drag-over
    // highlight stays on the bubble for visual feedback. The
    // surrounding column is a drop zone too and hands its drops here (see
    // conversation-area's _dropTargetComposer), so this path serves a drop that
    // landed on the box itself.
    //
    // Bound once: these ride on the host, which survives the re-renders that
    // rebuild the bubble, so a second binding would stage every dropped file
    // twice. The bubble is therefore looked up per event rather than captured.
    installFileDropGuard();
    if (!this._dragListenersBound) {
      this._dragListenersBound = true;
      const bubble = () => this.querySelector('composer-box-wrapper');
      this.addEventListener('dragover', (e) => {
        if (!isFileDrag(/** @type {DragEvent} */ (e).dataTransfer)) return;
        e.preventDefault();
        markFileDropAccepted(e);
        bubble()?.classList.add('drag-over');
      });
      this.addEventListener('dragleave', (e) => {
        // Only clear when the pointer actually leaves the host, not when it
        // crosses between the host's children (which also fire dragleave).
        if (e.target === this) bubble()?.classList.remove('drag-over');
      });
      this.addEventListener('drop', (e) => {
        bubble()?.classList.remove('drag-over');
        if (this.acceptDroppedFiles(/** @type {DragEvent} */ (e).dataTransfer)) e.preventDefault();
      });
    }

    // Render any chips that survived a re-render.
    renderAttachmentChips(this);

    textarea.addEventListener('keydown', (e) => {
      // Completion menu (@ mentions / slash commands) owns navigation keys while
      // open — it consumes Arrow/Enter/Tab/Escape as needed and reports back.
      if (this._completions?.handleKeydown(e)) return;

      // Paste-placeholder atomicity: a token is many characters but acts like a
      // single object under Backspace/Delete/Arrow. Skipped while composing (IME
      // safety) and a fast no-op when the box holds no tokens.
      if (!e.isComposing && this._handleTokenKeydown(e, textarea)) return;

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
        // Direct value writes don't fire input; keep the token mirror and the
        // reconciler's known-good base in step so a later edit isn't misjudged.
        this._syncPasteMirror();
        this._pasteLastValue = textarea.value;
        this._pasteLastCaret = textarea.selectionStart;
        return;
      }

      // Escape to stop the turn or clear the input
      if (e.key === 'Escape') {
        // A popup/modal open over the input owns Escape — it dismisses
        // itself via its own handler / popup-manager. Don't let the key
        // leak through to cancel a running turn or clear the input.
        if (isAnyPopupOpen()) {
          return;
        }

        e.preventDefault();

        // What Escape MEANS on a running/idle conversation is the user's choice
        // (Settings ▸ Keyboard shortcuts ▸ Escape key), so the whole decision —
        // stop, pause, two-step, clear — lives in escape-behaviour.js and is
        // shared with the conversation-area Escape. All this box contributes is
        // the vantage: a sub-thread box (threadItemId set) interrupts that
        // thread without closing it; the root box (null) stops everything.
        handleEscapeKey(e, {
          focusedThreadId: this.threadItemId ?? null,
          getComposer: () => this,
        });
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

    textarea.addEventListener('input', (e) => {
      // Token reconciler: reject any edit that damaged a placeholder's interior
      // (revert to the last good value) and strip orphaned delimiters, BEFORE
      // anything else reads the value. Reachable only by paths that dodge the
      // caret/selection interceptors (autocorrect/spell replace, dictation,
      // drag-drop, exotic IME) — the caret can otherwise never rest in a token.
      // The inputType tells it an undo/redo apart from a fresh edit.
      this._reconcileTokens(textarea, /** @type {InputEvent} */ (e).inputType);
      this._scheduleAutoResize(textarea);
      this._updateSendButtonState();
      // Debounced draft save for page reload restoration
      this._scheduleDraftSave(textarea.value);
      // @ file completions
      this._completions?.handleInput();
      // Rebuild/teardown the token mirror to match the current text.
      this._syncPasteMirror();
    });
    // Paste in WKWebView updates value after the input event fires, so
    // re-run detection on the next tick to read the final pasted value.
    textarea.addEventListener('paste', () => setTimeout(() => this._completions?.handleInput(), 0));

    // IME safety: caret-snapping and the token reconciler stand down while a
    // composition is in flight (they would fight the input method).
    textarea.addEventListener('compositionstart', () => { this._pasteComposing = true; });
    textarea.addEventListener('compositionend', () => {
      this._pasteComposing = false;
      this._reconcileTokens(textarea);
      this._syncPasteMirror();
    });

    // Click on a token pill expands it back to its full content (undoable). The
    // hit-test is against the mirror's rendered pill geometry, not the caret,
    // because a click that lands inside a token is snapped to a boundary before
    // this fires — so a caret-based test would never see the interior.
    textarea.addEventListener('click', (e) => {
      if (this._pasteBlobs.size === 0 || !this._pasteMirror) return;
      const hit = tokenAtPoint(this, e.clientX, e.clientY);
      if (hit) expandTokenWithFeedback(this, textarea, hit.token, hit.span);
    });

    // Show a pointer cursor while hovering a pill. The transparent textarea sits
    // above the (pointer-events:none) mirror, so its own cursor must be swapped;
    // only meaningful while a mirror exists.
    textarea.addEventListener('mousemove', (e) => {
      if (this._pasteBlobs.size === 0 || !this._pasteMirror) {
        if (textarea.style.cursor) textarea.style.cursor = '';
        return;
      }
      const want = tokenAtPoint(this, e.clientX, e.clientY) ? 'pointer' : '';
      if (textarea.style.cursor !== want) textarea.style.cursor = want;
    });

    // Copy/cut of a selection that contains any token writes the EXPANDED text
    // to the clipboard — the sentinel characters never leave the composer.
    textarea.addEventListener('copy', (e) => this._onClipboardCopyCut(e, textarea, false));
    textarea.addEventListener('cut', (e) => this._onClipboardCopyCut(e, textarea, true));

    // Keep the mirror's scroll aligned with the textarea's.
    textarea.addEventListener('scroll', () => {
      if (this._pasteMirror) this._pasteMirror.scrollTop = textarea.scrollTop;
    });

    // Losing focus dismisses the completion menu. It is non-modal with no
    // outside-click handling — typing in the textarea is what drives it — so
    // without this a click away from the textarea would strand an open menu
    // with no path to dismiss it. Menu items accept on pointerdown +
    // preventDefault, which keeps focus in the textarea, so an accept never
    // reaches here; only a genuine focus change does.
    // Losing focus also commits the draft. The debounce exists to keep
    // keystrokes from thrashing the Yjs doc, and the user has demonstrably
    // stopped typing — waiting out the remaining delay only widens the window
    // where the text lives nowhere but this textarea, which is what a crash or
    // a force-quit takes with it.
    textarea.addEventListener('blur', () => {
      this._completions?.close();
      this.flushDraft();
    });

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
        toggleSchedulePicker(this);
      });
    }
    // A draft restored on mount may already carry a pending send — re-arm (or,
    // if its target has passed, fire) it now that the controls exist.
    syncScheduledSendFromDraft(this);

    // Send button (always visible). Send-only — cancelling a running turn is
    // the footer Stop button's job, so this never morphs into a Stop control.
    const sendBtn = this.querySelector('#send-button');
    if (sendBtn) {
      sendBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.sendMessage();
      });
    }

    // Context-cache warning — the round alert just before Send. The strategy
    // selector owns detection and fires a bubbling event when its classification
    // flips; mirror that onto the button's visibility. Bound once on `this`: the
    // event rides up through the child re-renders, so the listener must not stack.
    if (!this._impactListenerBound) {
      this._impactListenerBound = true;
      this.addEventListener(CONTEXT_CACHE_IMPACT_CHANGED, (e) => {
        this._cacheImpactWarning = !!(/** @type {CustomEvent} */ (e).detail?.busts);
        this._updateCacheWarningButton();
      });
    }
    // Clicking (or tapping) the warning surfaces its explanation — touch has no
    // hover, so the native-title tooltip would otherwise never appear there.
    const cacheWarnBtn = this.querySelector('#context-cache-warning');
    if (cacheWarnBtn) {
      cacheWarnBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        tooltipManager.showFor(/** @type {HTMLElement} */ (cacheWarnBtn));
      });
    }

    // Touch-only "⋮" overflow button: opens the actions sheet (commands, attach
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
   * message), the schedule button (which mustn't arm a delayed send that would
   * silently fire nothing), and the "is the user mid-message?" test that decides
   * whether a conversation may pull the user to another tab.
   * @returns {boolean} True when there is nothing sendable.
   */
  isEmpty() {
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
    const empty = this.isEmpty();
    const sendBtn = this.querySelector('#send-button');
    if (sendBtn) {
      // A held send wears the same look as an empty box, which is already the
      // "there is nothing to press this for" state — and says what it is
      // waiting for, since unlike an empty box the reason is not self-evident.
      sendBtn.classList.toggle('is-empty', empty || this.sendBlocked);
      const title = this.sendBlocked && this._sendBlockedReason ? this._sendBlockedReason : 'Send message';
      sendBtn.setAttribute('title', title);
      sendBtn.setAttribute('aria-label', title);
    }
    this._updateNewThreadControls();
    // The schedule button follows the same empty rule; updateScheduleButton
    // re-reads emptiness itself, so just re-render it.
    updateScheduleButton(this);
  }

  _updateNewThreadControls() {
    const busy = this._conversation?.isTurnActive() === true;
    const button = /** @type {HTMLButtonElement|null} */ (this.querySelector('.new-thread-btn'));
    if (button) {
      button.disabled = busy;
      button.title = busy
        ? 'Wait for the current turn to finish before creating a new thread'
        : 'Create a new sub-thread';
    }
    this.querySelectorAll('[data-command="thread"], [data-action="new-thread"]').forEach((row) => {
      row.classList.toggle('disabled', busy);
      row.setAttribute('aria-disabled', String(busy));
    });
  }

  /**
   * Which placeholder bucket this composer's thread is in — see
   * utils/composer-placeholders. The order of the tests is the priority: how
   * the last turn ENDED outranks anything about the thread as a whole, because
   * it is the more recent and more actionable fact.
   *
   * How the trailing turn ended is read from the items themselves — see
   * trailingTurnOutcome for where that turn begins.
   * @returns {string} A key of COMPOSER_PLACEHOLDERS
   * @private
   */
  _derivePlaceholderState() {
    const thread = this._messageThread;
    const items = thread ? thread.items : [];

    // A new conversation is not an empty one: it is seeded with standing
    // context items (agents files, project memory, the system prompt) before
    // anyone has said anything, so the raw item count is never zero. Only
    // conversation HISTORY counts as something having happened here — and it is
    // the same count that decides whether the thread is long, so both lines
    // speak about the same thing.
    let historyCount = 0;
    for (const item of items) {
      if (isConversationalItemType(item?.get?.('type'))) historyCount++;
    }
    if (!historyCount) return 'fresh';

    const status = this._conversation?.processingState?.status;
    if (status === 'error' || status === 'validation-error') return 'error';

    const outcome = trailingTurnOutcome(items);
    if (outcome) return outcome;

    const lastActivityAt = thread ? thread.lastActivityAt : 0;
    if (lastActivityAt && Date.now() - lastActivityAt > COMPOSER_IDLE_MS) return 'idle';
    if (historyCount >= COMPOSER_LONG_THREAD_ITEMS) return 'long';
    return 'ready';
  }

  /**
   * Re-derive the placeholder, picking a fresh line only when the state has
   * actually moved. A blocked composer is left alone: `setBlocked` writes the
   * reason it is blocked, which is a more useful thing to say than any of this.
   * @private
   */
  _updatePlaceholder() {
    const textarea = this.querySelector('textarea');
    if (!textarea || textarea.hasAttribute('data-blocked')) return;
    const state = this._derivePlaceholderState();
    if (state === this._placeholderState && textarea.placeholder) return;
    this._placeholderState = state;
    textarea.placeholder = pickComposerPlaceholder(state);
  }

  /**
   * Show or hide the cache caution beside Send. It speaks only about the send
   * the user has not made yet: the transcript no longer matches what was last
   * cached, so the next message re-reads a large slice at full price. A miss
   * that has ALREADY happened is a different statement about a different moment,
   * and is recorded as a notice item in the transcript instead.
   * @private
   */
  _updateCacheWarningButton() {
    const btn = this.querySelector('#context-cache-warning');
    if (!btn) return;
    btn.toggleAttribute('hidden', !this._cacheImpactWarning);
  }

  /**
   * Whether this composer should behave as a touch composer: Enter inserts a
   * newline (the onscreen keyboard's return key) and the touch-only Send / "⋮"
   * affordances are active. Gated on a coarse pointer with no hover. This is
   * the single source of that decision — _applyConfigPlacement turns it into
   * the `touch-composer` class the CSS layout selects on — so the key
   * behaviour and the layout cannot disagree. A narrow DESKTOP window (fine
   * pointer) keeps Enter-to-send.
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
    return window.matchMedia?.(COARSE_POINTER_QUERY).matches === true;
  }

  /**
   * Follow the pointer type for as long as this box is mounted, so a device
   * that changes it mid-session — an iPad gaining a trackpad, a convertible
   * folding back into a tablet — re-homes the config controls to match. The CSS
   * half of the touch layout re-evaluates on its own; without this the DOM half
   * would not, and the two would disagree.
   * @private
   */
  _watchPointerType() {
    if (this._pointerQueryCleanup || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(COARSE_POINTER_QUERY);
    const onChange = () => this._applyConfigPlacement();
    query.addEventListener('change', onChange);
    this._pointerQueryCleanup = () => query.removeEventListener('change', onChange);
  }

  /**
   * Home the three config controls — strategy, permissions, model — in the row
   * or in the strip, depending on the layout in force.
   *
   * On a pointer big enough to hit a pill they sit inline in the controls row.
   * On touch they move to `<composer-config-strip>` above the textarea, where
   * they render as a line of plain text rather than three pills. The controls
   * row is then just the "⋮" and Send, which is what makes it stable: text
   * ellipsises in the space it is given, whereas three pills on a phone-width
   * row cannot all fit and push the controls after them off the edge.
   *
   * The elements MOVE rather than being rebuilt — each one owns live state its
   * host set on it (the strategy selector's messageThread, the model chip's
   * config), and all of that is plain properties, untouched by the disconnect
   * and reconnect a re-parent causes.
   * @private
   */
  _applyConfigPlacement() {
    const strip = this.querySelector('composer-config-strip');
    const inlineRow = this.querySelector('input-controls-config');
    if (!strip || !inlineRow) return;

    const touch = this._isTouchComposer();
    // The class the whole touch layout hangs off. Written here, from the same
    // predicate that decides where the controls go and whether Enter sends, so
    // that CSS and DOM can never describe different layouts.
    this.classList.toggle('touch-composer', touch);
    const home = touch ? strip : inlineRow;

    // Appending in order both moves and re-sorts, so one pass settles the
    // layout whichever home the controls were in before. The orders differ:
    // inline, strategy leads so its fixed left edge anchors the permission
    // button beside it. In the strip the model leads, because the model is what
    // a glance at the strip is usually looking for, and — load-bearing —
    // permissions comes LAST because it is the one of the three that is never
    // hidden. The strip's separators hang off `:not(:last-child)`, so a final
    // slot that can vanish (the strategy selector hides itself on a delegated
    // thread) would strand a dangling "·" at the end of the line.
    const order = touch
      ? ['model-selector', 'strategy-selector', 'permission-controls']
      : ['strategy-selector', 'permission-controls', 'model-selector'];
    for (const selector of order) {
      const control = this.querySelector(selector);
      if (control) home.appendChild(control);
    }

    // Empty the home they left. Moving the elements out leaves the whitespace
    // between them behind as text nodes, and a box holding "\n        " is not
    // `:empty` — it still lays out, and the flex gap beside it still counts, so
    // the rule that collapses the unused home would silently not apply and the
    // row would be a few pixels wider than it has any content for.
    const vacated = touch ? inlineRow : strip;
    vacated.textContent = '';
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
   *
   * This is also where an armed scheduled send is kept honest, because it is the
   * one place that writes the record the schedule lives on. Two rules, both
   * "the timer belongs to the message":
   *   • Emptying the box disarms it. A timer over an empty box would sit there
   *     with nothing to send, lit on the tab and uncancellable from a button
   *     that an empty box disables.
   *   • A schedule cleared elsewhere stays cleared. Another window may have
   *     fired this send between our saves; carrying our stale copy back into the
   *     draft would re-arm an instant whose fire has already been claimed, so
   *     nothing would ever fire it again.
   * `scheduleIsAuthoritative` exempts the arm/cancel path itself, which calls
   * this precisely BECAUSE the schedule changed and must not have it read back.
   * @param {string} [text] - Text to persist; defaults to the live textarea value.
   * @param {{scheduleIsAuthoritative?: boolean}} [options]
   * @private
   */
  _persistDraft(text, { scheduleIsAuthoritative = false } = {}) {
    if (!this._messageThread) return;
    const value = (text !== undefined) ? text : this.getText();
    let disarmed = false;
    if (!scheduleIsAuthoritative) {
      reconcileScheduleWithDraft(this);
      // Emptiness is judged on what is about to be written, not on the live DOM:
      // the debounced save that carries the user's deletion is the event that
      // empties this draft, and `value` is that text.
      const stillSendable = !!value.trim()
        || this._resolvedAttachments().length > 0
        || this._pendingTextFiles.length > 0;
      if (!stillSendable && this._scheduledSendAt !== null) {
        // Reset in memory only, so the write below carries the cleared schedule.
        // Repainting and announcing have to wait until AFTER it: announcing runs
        // the service's scan, which would read this still-armed draft and put
        // the timer straight back.
        disarmed = true;
        this._scheduledSendAt = null;
        this._scheduledSendMode = 'delay';
      }
    }
    this._messageThread.draft = {
      text: value,
      attachments: this._resolvedAttachments(),
      textFiles: this._pendingTextFiles.map(({ filename, content, bytes }) => ({ filename, content, bytes })),
      // The append-only paste-blob table, so an inline placeholder survives a
      // reload / thread switch / remote client and resolves at send time.
      pasteBlobs: Array.from(this._pasteBlobs, ([id, b]) => ({ id, content: b.content, bytes: b.bytes })),
      // Preserve any armed send across the keystroke-driven draft saves — the
      // user keeps typing while a send is scheduled, and each save must not
      // drop the timer.
      scheduledSendAt: this._scheduledSendAt,
      scheduledSendMode: this._scheduledSendMode
    };
    // Safe now the cleared draft is written: stops the countdown, repaints the
    // clock button, and drops the tab clock. The state it clears is already null.
    if (disarmed) clearScheduledSendState(this);
  }

  /**
   * Immediately persist the live textarea value, bypassing the debounce. Used by
   * page/native-window teardown, where the debounced timer may not get another
   * turn before the webview is destroyed.
   *
   * Returns the conversation id when there were unsaved keystrokes — a debounce
   * was pending, so this call is what rescued them — and null otherwise. Quit
   * teardown uses that to force a synchronous disk write for exactly the
   * conversations that need one. Attachment and text-file changes persist
   * immediately when they happen, so they never arm the timer and never appear
   * here.
   * @returns {string|null} The rescued conversation's id, or null if there was
   *   nothing pending to rescue.
   */
  flushDraft() {
    const pendingSave = this._draftSaveTimeoutId;
    if (pendingSave !== null) {
      clearTimeout(pendingSave);
      this._draftSaveTimeoutId = null;
    }
    this._persistDraft();
    return pendingSave !== null ? (this._messageThread?.conversationId ?? null) : null;
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
    // Assigning `.value` — even the same string — resets the browser's native
    // undo stack. Skip the write when the value is unchanged so a preceding
    // undoable clear (e.g. New Thread moving the draft out via
    // _clearMovedTextUndoable, then clearInput() calling setText('')) stays
    // recoverable with Ctrl/Cmd+Z instead of being wiped by the empty re-set.
    if (textarea.value !== text) textarea.value = text;
    this.autoResize(textarea);
    this._updateSendButtonState();
    // Programmatic sets (history nav, restored/moved drafts) may carry raw
    // tokens; the blob table lives on the box, so refresh the mirror to match.
    this._syncPasteMirror();
    // Re-baseline the reconciler: a programmatic write is trusted, so it becomes
    // the new known-good value (never something to revert to a stale base).
    this._pasteLastValue = textarea.value;
    this._pasteLastCaret = textarea.selectionStart;
  }

  /**
   * Clear the textarea as an UNDOABLE edit — Ctrl/Cmd+Z restores the text — so a
   * mis-pressed Escape doesn't silently lose a drafted prompt. Assigning
   * `textarea.value = ''` wipes the browser's native undo stack; going through
   * `execCommand` on a full selection keeps the clear on that stack instead.
   * The draft is saved to history first (retrievable with ArrowUp) as a second
   * safety net. Focuses + selects the textarea because execCommand edits target
   * the focused selection, which also makes this work when the box wasn't
   * focused (e.g. Escape from an empty conversation).
   * @returns {boolean} True if there was text to clear
   */
  clearTextUndoable() {
    const textarea = this.querySelector('textarea');
    if (!textarea) return false;
    if (textarea.value === '') return false;

    // Save the draft to history before clearing so ArrowUp can retrieve it.
    this._saveDraftToHistory();

    textarea.focus();
    textarea.select();
    // Clearing the box is the REQUIRED outcome; keeping it on the native undo
    // stack (Ctrl/Cmd+Z restores the draft) is the nice-to-have. So attempt the
    // undoable delete, then unconditionally force-empty if anything survived —
    // never trust execCommand's return value. `delete` on the full selection is
    // the undoable primitive; `insertText('', '')` is NOT usable here (on WebKit
    // — the desktop app — an empty insert is a no-op that still returns true, so
    // the box would silently never clear).
    document.execCommand('delete', false);
    if (textarea.value !== '') {
      textarea.value = '';
    }

    this.currentDraft = { content: '', attachments: [] };
    this.historyIndex = -1;
    this.autoResize(textarea);
    this._updateSendButtonState();
    this._scheduleDraftSave(textarea.value);
    // Cleared to empty: drop the mirror and re-baseline the reconciler (the
    // fallback value write above fires no input event of its own).
    this._syncPasteMirror();
    this._pasteLastValue = textarea.value;
    this._pasteLastCaret = textarea.selectionStart;
    return true;
  }

  /**
   * Clear the textarea as an UNDOABLE edit WITHOUT disturbing focus — used by the
   * New Thread flow, which moves this box's text into a freshly opened thread and
   * needs that new thread's box (not this one) to end up with the keyboard.
   *
   * Unlike {@link clearTextUndoable}, this deliberately does NOT call focus() or
   * select-then-refocus: it only acts when the textarea is ALREADY the active
   * element (execCommand requires a focused, selected target), and it never
   * blurs. So the focus state is left exactly as the caller found it and the
   * subsequent column rebuild's focus lands where it should. No-op (returning
   * false) when the box isn't focused or is empty — the normal clearInput() then
   * empties it non-undoably, which is an acceptable degradation for that case.
   * @returns {boolean} True if the text was cleared undoably in place.
   * @private
   */
  _clearMovedTextUndoable() {
    const textarea = /** @type {HTMLTextAreaElement|null} */ (this.querySelector('textarea'));
    if (!textarea || textarea.value === '') return false;
    if (document.activeElement !== textarea) return false;

    const savedStart = textarea.selectionStart;
    const savedEnd = textarea.selectionEnd;
    textarea.select();
    // `delete` keeps the clear on the native undo stack (Ctrl/Cmd+Z restores it).
    // Not `insertText('', '')`: an empty insert is a no-op that still returns true
    // on WebKit (so the box wouldn't actually clear) and corrupts Chromium's undo
    // stack. If the host rejects the editing command there is nothing we can do
    // undoably without a focus()-based fallback, so leave it to clearInput.
    const ok = document.execCommand('delete', false);
    if (!ok) {
      try { textarea.setSelectionRange(savedStart, savedEnd); } catch { /* non-fatal */ }
      return false;
    }

    this.currentDraft = { content: '', attachments: [] };
    this.historyIndex = -1;
    this.autoResize(textarea);
    this._updateSendButtonState();
    this._syncPasteMirror();
    this._pasteLastValue = textarea.value;
    this._pasteLastCaret = textarea.selectionStart;
    return true;
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
   * Put a stored user message back into the box as the live draft: its text AND
   * its staged image attachments, since a message is one unit. Used by the
   * rewind and branch flows, which delete a message and hand it back for
   * editing and re-sending.
   *
   * Whatever was already typed goes to history first, so overwriting a draft
   * never loses it (ArrowUp retrieves it). The attachment set is replaced
   * wholesale rather than merged — restoring a message with no images clears
   * any that were staged — which is also what persists the restored draft.
   * @param {{content?: string, attachments?: Array<import('../utils/attachments.js').AssetRef>}} message - The message to restore.
   */
  restoreMessage({ content = '', attachments = [] } = {}) {
    this._saveDraftToHistory();
    this.setDraft(content);
    this.setPendingAttachments(attachments);
  }

  /**
   * Save whatever is currently in the box to the shared message history, so an
   * ArrowUp brings it back after the box is cleared or overwritten. No-op on an
   * empty box, or before a session is wired up.
   * @private
   */
  _saveDraftToHistory() {
    const trimmed = this.getText().trim();
    if (trimmed && this.session) {
      this.session.addMessageToHistory({ content: trimmed, attachments: [] });
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
   * Auto-resize textarea to fit content.
   *
   * Resetting the height and then reading `scrollHeight` is a forced synchronous
   * layout: the read cannot be answered until every pending layout in the
   * document has been resolved, the whole transcript included. That is cheap
   * against a settled page and expensive against a streaming one, so the
   * per-keystroke path goes through _scheduleAutoResize instead of here.
   * @param {HTMLTextAreaElement} textarea
   */
  autoResize(textarea) {
    // This measurement supersedes any frame already queued for the same job.
    this._cancelScheduledAutoResize();
    textarea.style.overflowY = 'hidden'; // Temporarily hide scrollbar for accurate measurement
    textarea.style.height = 'auto'; // Reset height to auto to get correct scrollHeight
    const newHeight = Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT_PX);
    textarea.style.height = newHeight + 'px';
    // Enable scrolling if the maximum height is reached
    textarea.style.overflowY = newHeight < MAX_TEXTAREA_HEIGHT_PX ? 'hidden' : 'auto';
  }

  /**
   * Coalesce an autoResize onto the next frame, for callers that fire faster
   * than the box can meaningfully change size.
   *
   * Typing is the case that matters. Measuring inline makes every keystroke wait
   * on a full-document layout, and while a turn streams the document is dirtied
   * again between one keystroke and the next — so each character pays for a
   * relayout of the entire conversation before it is echoed, which is what turns
   * a busy window's composer to treacle. Deferring collapses a burst of
   * keystrokes into one measurement per frame and, more to the point, takes the
   * layout off the keystroke entirely: the character lands now and the box
   * catches up on the next frame.
   *
   * The height is one frame late, which is not a perceptible thing for a box
   * that grows a line at a time. Callers that need the new height to have landed
   * — anything about to measure or scroll to it — call autoResize directly.
   * @param {HTMLTextAreaElement} textarea
   * @private
   */
  _scheduleAutoResize(textarea) {
    if (this._autoResizeFrame !== null) return;
    this._autoResizeFrame = requestAnimationFrame(() => {
      this._autoResizeFrame = null;
      this.autoResize(textarea);
    });
  }

  /**
   * Drop a queued autoResize.
   * @returns {void}
   * @private
   */
  _cancelScheduledAutoResize() {
    if (this._autoResizeFrame === null) return;
    cancelAnimationFrame(this._autoResizeFrame);
    this._autoResizeFrame = null;
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

    // Expand any inline paste placeholders to their full content at their exact
    // positions BEFORE any downstream logic. From here on `message` is the plain
    // text a normal paste would have produced, so the size cap, @-mention
    // extraction, the stored user message, and every consumer are unchanged.
    const message = expandPasteTokens(textarea.value, this._pasteBlobs).trim();
    // A staged image OR a dropped text file makes an otherwise-empty message a
    // valid send: the text files become context items ahead of the (empty) user
    // message, exactly like a caption-less image attachment.
    const hasAttachments = this._resolvedAttachments().length > 0 || this._pendingTextFiles.length > 0;

    // An image-only message (no text but staged attachments) is a valid send:
    // the worker treats an attachment-bearing message as non-empty
    // (UserMessageInput.isEmpty) and each provider omits the empty text block on
    // the wire, so nothing forces the user to type a caption.
    if ((!message && !hasAttachments) || this.disabled) {
      return 'empty or disabled';
    }

    // Nowhere to send it yet. The box is deliberately still live — the message
    // is worth writing while the place it will run in is being built — so this
    // is the one state where there is text, the box is enabled, and the send
    // still does not go.
    if (this.sendBlocked) {
      return 'the workspace is still being built';
    }

    // Refuse a second send while the first is still resolving its mentions.
    // Until it dispatches, the box still holds the text and the button is still
    // live, so a repeat press arrives here with identical input; letting it
    // through would post the message twice. See the `_sending` field.
    if (this._sending) {
      return 'send already in flight';
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

    // Held for the whole resolve-and-dispatch body below. Released in the
    // `finally` so a mention read that rejects (an unreadable path, a dropped
    // connection) leaves the box usable rather than latched shut — sendMessage()
    // is called un-awaited from the click and keydown handlers, so a throw here
    // surfaces nowhere and would otherwise strand the flag set.
    this._sending = true;
    try {
      // While a turn is in flight on THIS thread (it is being driven, or it has
      // busy items such as a running tool or an approval awaiting a decision)
      // the message is QUEUED, not refused — Conversation.sendMessage forwards
      // it to the worker, which parks it in pendingItems and drains it at the
      // next boundary. So we don't block here; we just nudge the status into
      // view so the user sees the queued bubble land. Asked of this thread,
      // because a busy sibling queues nothing here.
      const busy = !!this._messageThread &&
              (this._messageThread.isProcessing || this._messageThread.hasBusyItems());
      if (busy) {
        this._scrollToStatus();
      }

      // Create context items for all @-mentions AND dropped text files before
      // sending. Awaited here so these content items land BEFORE the user message.
      //
      // Where they land depends on whether this send will be QUEUED. On an idle
      // send the reads go straight into the committed items array, landing just
      // before the about-to-send message. But while a turn is in flight the
      // message is parked in the worker's pendingItems queue and only promoted at
      // the next turn boundary — so reads written into items now would be stranded
      // above the whole in-flight turn's output, with the message promoted far
      // below. When busy we therefore enqueue the reads onto the SAME pendingItems
      // queue (ahead of the worker's queued user message), so promotePendingItems
      // moves the reads and the message into items together, as a contiguous group.
      //
      // A mention is FROZEN (`frozen: true`): the model is handed the file as it
      // stands when this message is sent, and editing it afterwards does not
      // rewrite that — a live pin near the head of the conversation would
      // cold-start the whole cached prefix on every edit to the very file the
      // user mentioned for the agent to work on. Dropped files are snapshots
      // too, differing only in that they carry the bytes inline (a
      // `dropped-file`) rather than a path read at the first send.
      // The prose actually sent: the typed text with any `$name` skill triggers
      // removed (they become tool-calls, never prose). Reassigned in the thread
      // block below; equals `message` when there is no thread or no `$name`.
      let outgoingMessage = message;
      // Agent Skills the user explicitly chose via `$name` mentions, forwarded to
      // the worker (NOT loaded here). Resolved against THIS thread's FROZEN
      // snapshot — never the live catalog — so we only ever forward names the
      // `skill` tool will accept; unknown `$foo` is left verbatim as prose. The
      // worker loads each as a real, visible `skill` TOOL-ACTION before the turn:
      // that document-driven action is the only path that injects the SKILL.md
      // body (a plain context-item call would merely re-seed the standing
      // "## Skills" list), so the composer forwards names rather than loading.
      /** @type {string[]} */
      let skillNames = [];
      if (this._messageThread) {
        const mt = this._messageThread;

        // The mention and dropped-file reads below are the first content to
        // reach the document on this send, and they are read relative to the
        // conversation's workspace — so the conversation commits to one here,
        // before them, rather than a moment later in Conversation.sendMessage.
        await mt.conversation?.ensureInitialised?.();

        const snapshot = await getThreadSkillSnapshot(mt);
        const extracted = extractSkillMentions(message, snapshot.map((s) => s.name));
        skillNames = extracted.names;
        outgoingMessage = extracted.text;

        // Create context items for all @-mentions AND dropped text files before
        // sending (from the trigger-stripped prose — stripping `$name` never
        // affects an `@` token). Awaited here so these land BEFORE the user message.
        const paths = await extractFileMentionsAsync(outgoingMessage);
        const textFiles = this._pendingTextFiles;
        this._pendingTextFiles = [];
        if (paths.length > 0 || textFiles.length > 0) {
          const runFile = busy
            ? (/** @type {string} */ p) => mt.executeContextItemIntoPending('file-content', { path: p, frozen: true })
            : (/** @type {string} */ p) => mt.executeContextItem('file-content', { path: p, frozen: true });
          const runDropped = busy
            ? (/** @type {{filename:string,content:string}} */ t) =>
              mt.executeContextItemIntoPending('dropped-file', { filename: t.filename, content: t.content })
            : (/** @type {{filename:string,content:string}} */ t) =>
              mt.executeContextItem('dropped-file', { filename: t.filename, content: t.content });
          this._lastMentionPromise = Promise.all([
            ...paths.map(runFile),
            ...textFiles.map(runDropped)
          ]);
          await this._lastMentionPromise;
        }
        renderAttachmentChips(this);
      }

      // The Conversation calls clearInput() after successful validation, so the
      // message survives in the textarea if the send fails.
      // Forward any attachments staged on this composer (populated by the
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
      renderAttachmentChips(this);
      this.dispatchEvent(new CustomEvent('send-message', {
        detail: {
          message: outgoingMessage,
          threadItemId: this.threadItemId || null,
          messageThread: this._messageThread || null,
          attachments,
          skills: skillNames
        },
        bubbles: true,
        composed: true
      }));
      return null;
    } finally {
      // The listener chain runs synchronously inside dispatchEvent, so on an
      // accepted send Conversation.sendMessage has already emptied the box by
      // the time this runs and `is-empty` keeps the button inert. On a refused
      // one the text is still there, deliberately, and the user can retry.
      this._sending = false;
    }
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
    this.currentDraft = { content: '', attachments: [] };
    this._historyEdits = {};

    // Drop any staged text files — they were flushed into context items at send.
    this._pendingTextFiles = [];

    // GC the paste-blob side table and tear down the mirror — this draft is done,
    // so the append-only table's life ends here (a fresh draft starts empty).
    this._pasteBlobs = new Map();
    teardownPasteMirror(this);
    this._pasteLastValue = '';
    this._pasteLastCaret = 0;

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
    clearScheduledSendState(this);

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
   * Hold the send without taking the box away.
   *
   * For the one state where there is nothing wrong with the message and nowhere
   * to send it: the place this conversation will work in is still being built.
   * Writing and editing go on — that wait is exactly when the first message gets
   * composed — and only the send itself waits.
   * @param {boolean} blocked - Whether the send is held.
   * @param {string} [reason] - What it is waiting for, said on the button.
   */
  setSendBlocked(blocked, reason = '') {
    this.sendBlocked = blocked;
    this._sendBlockedReason = reason;
    this._updateSendButtonState();
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
        textarea.placeholder = reason || 'Input blocked';
        textarea.setAttribute('data-blocked', 'true');
      } else {
        textarea.disabled = false;
        textarea.removeAttribute('data-blocked');
        // The reason is gone, so fall back to whatever the conversation's own
        // state has to say.
        this._placeholderState = '';
        this._updatePlaceholder();
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
    if (this._conversationMetadataObserver && this._conversation) {
      this._conversation.unobserveMetadata(this._conversationMetadataObserver);
    }
    this._conversation = conversation;
    this._conversationMetadataObserver = null;
    if (conversation) {
      this._conversationMetadataObserver = (event) => {
        const keys = event.keysChanged;
        if (keys?.has?.('processingState')) {
          this._updateNewThreadControls();
        }
        // `completedTurns` is the durable "a turn just ended" edge, and
        // `processingState` carries the error statuses — between them they
        // cover every transition the placeholder distinguishes.
        if (keys?.has?.('processingState') || keys?.has?.('completedTurns')) {
          this._updatePlaceholder();
        }
      };
      conversation.observeMetadata(this._conversationMetadataObserver);
    }
    this._updateNewThreadControls();
    this._updatePlaceholder();

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
   * Bind the strategy selector to this composer's thread. Strategy is
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
   * The thread this composer is bound to, for callers that need to tell one
   * on-screen composer from another — scheduled-send-service matches the armed
   * thread against every mounted composer this way.
   * @returns {import('../model/message-thread.js').MessageThread|null} The bound thread, or null.
   */
  getMessageThread() {
    return this._messageThread;
  }

  /**
   * Set the message thread for this composer
   * @param {import('../model/message-thread.js').MessageThread} messageThread
   */
  setMessageThread(messageThread) {
    // Key on LOGICAL identity (conversation + thread item), and make the guard
    // STICKY via `_restoredThreadKey`: a sub-thread column rebuilds a fresh
    // MessageThread wrapper for the SAME underlying thread on every doc update,
    // and the binding can transiently reset — either would make an
    // object/field-identity check think the thread is new, re-run the restore
    // below, and reset the textarea to the last debounce-saved draft, clobbering
    // in-flight typing AND wiping the native undo stack. Restoring only when the
    // logical key genuinely changes means a same-thread re-bind never touches
    // the textarea. Restore the draft only on a real switch to a different thread.
    const key = `${messageThread.conversationId}::${messageThread.threadItemId ?? 'root'}`;
    const isNewThread = this._restoredThreadKey !== key;

    // Switching away from a previously-bound thread: flush its live draft first,
    // so in-flight typing isn't stranded by the keystroke debounce (which may
    // not have fired). Guarded — the outgoing thread's container may already be
    // gone (a deleted sub-thread), and losing the flush there is benign.
    if (isNewThread && this._messageThread && this._restoredThreadKey !== null) {
      try {
        this.flushDraft();
      } catch { /* outgoing thread torn down — nothing to preserve */ }
    }

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
      // Mark this thread's draft as restored BEFORE the writes below, so any
      // re-entrant/rebuild bind that lands mid-restore sees the key and skips.
      this._restoredThreadKey = key;
      const draft = messageThread.draft;
      stagePendingAttachments(this, draft.attachments);
      stagePendingTextFiles(this, draft.textFiles);
      // Restore the append-only paste-blob table for this thread before staging
      // its text, so any inline placeholder in that text resolves and renders.
      this._pasteBlobs = new Map((draft.pasteBlobs || []).map((b) => [b.id, { content: b.content, bytes: b.bytes }]));
      const textarea = this.querySelector('textarea');
      if (textarea) {
        const draftText = draft.text || '';
        if (textarea.value !== draftText) {
          textarea.value = draftText;
        }
        // Rebuild (or tear down) the token mirror for the newly-bound thread.
        this._syncPasteMirror();
        // Baseline the reconciler on the restored text (trusted).
        this._pasteLastValue = textarea.value;
        this._pasteLastCaret = textarea.selectionStart;
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
        // stable composer-box height instead of a still-growing one — otherwise
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
      syncScheduledSendFromDraft(this);
    }

    // A different thread is a different situation, so let it re-pick even when
    // the state happens to match the one being left behind.
    if (isNewThread) this._placeholderState = '';
    this._updatePlaceholder();
  }

  /**
   * Get user message history from session (most recent first).
   * @returns {import('../model/session.js').HistoryMessage[]} History entries, newest first.
   */
  getUserHistory() {
    if (!this.session) return [];

    // Return session-level message history (shared across all conversations)
    // Reverse for arrow-up navigation (most recent first)
    return [...this.session.messageHistory].reverse();
  }

  /**
   * Snapshot the live composer as a history level: its text plus the currently
   * staged (uploaded) image attachments. Used to preserve the -1 draft and any
   * per-level edits before navigating away from them.
   * @returns {import('../model/session.js').HistoryMessage} The composer's current text and staged attachments.
   * @private
   */
  _snapshotComposerLevel() {
    return { content: this.getText(), attachments: this._resolvedAttachments() };
  }

  /**
   * Load a history level into the composer: set the text, re-stage its image
   * attachments as chips (a GC'd asset simply renders broken and is dropped at
   * send), park the caret at the end, and persist the whole draft.
   * @param {HTMLTextAreaElement} textarea
   * @param {import('../model/session.js').HistoryMessage} entry
   * @private
   */
  _applyHistoryLevel(textarea, entry) {
    this.setText(entry.content);
    stagePendingAttachments(this, entry.attachments || []);
    textarea.selectionStart = textarea.selectionEnd = entry.content.length;
    this._scheduleDraftSave(textarea.value);
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
    // Preserve the level we're leaving: the work-in-progress draft at -1,
    // otherwise this level's in-place edit (text + staged attachments).
    if (this.historyIndex === -1) {
      this.currentDraft = this._snapshotComposerLevel();
    } else {
      this._historyEdits[this.historyIndex] = this._snapshotComposerLevel();
    }
    if (this.historyIndex < history.length - 1) {
      this.historyIndex++;
      const entry = /** @type {import('../model/session.js').HistoryMessage} */ (
        this._historyEdits[this.historyIndex] !== undefined
          ? this._historyEdits[this.historyIndex]
          : history[this.historyIndex]);
      this._applyHistoryLevel(textarea, entry);
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
      this._historyEdits[this.historyIndex] = this._snapshotComposerLevel();
      this.historyIndex--;
      /** @type {import('../model/session.js').HistoryMessage} */
      let entry;
      if (this.historyIndex === -1) {
        entry = this.currentDraft;
      } else {
        const history = this.getUserHistory();
        entry = /** @type {import('../model/session.js').HistoryMessage} */ (
          this._historyEdits[this.historyIndex] !== undefined
            ? this._historyEdits[this.historyIndex]
            : history[this.historyIndex]);
      }
      this._applyHistoryLevel(textarea, entry);
    }
  }

  /**
   * Show a prominent, transient warning notice to the user. Delegates to the
   * app-level `showNotice` (a centered modal-dialog): the composer owns no
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

  // ── Attachments ───────────────────────────────────────────────────────────
  //
  // The staging, upload, size gates and chip row live in
  // composer-attachments.js. What stays here is the handful of methods the
  // tests drive on a mounted element (and, for _uploadAndAdd, replace): every
  // internal caller reaches them through the instance, so a stub is seen.

  /**
   * Read any images out of the async Clipboard API and route them through
   * {@link Composer#_handleFiles} — the WebKit desktop-app paste path.
   * @returns {Promise<void>}
   */
  async _pasteImagesFromAsyncClipboard() {
    return pasteImagesFromAsyncClipboard(this);
  }

  /**
   * Stage dropped/pasted/picked image files, subject to the size gates.
   * @param {FileList|File[]} fileList
   */
  _handleFiles(fileList) {
    handleFiles(this, fileList);
  }

  /**
   * Stage dropped text files as dropped-file context items.
   * @param {FileList|File[]} fileList
   */
  _handleTextFiles(fileList) {
    handleTextFiles(this, fileList);
  }

  /**
   * Stage files however they arrived — dropped on the box or the column around
   * it, or chosen in the attach button's picker — so the two can never treat
   * the same file differently. Images upload to the asset store as bytes and
   * everything else is inlined as a text snapshot, so a mixed set is routed one
   * kind at a time.
   * @param {FileList|File[]|null|undefined} fileList - The files to stage.
   * @returns {boolean} True when files were taken.
   */
  acceptFiles(fileList) {
    const { images, texts } = splitFiles(fileList);
    if (images.length === 0 && texts.length === 0) return false;
    if (images.length > 0) this._handleFiles(images);
    if (texts.length > 0) this._handleTextFiles(texts);
    return true;
  }

  /**
   * Stage the files from a drop, whatever surface caught it ({@link acceptFiles}).
   * The caller cancels the event iff this took something, leaving a drag that
   * carried nothing to the document-level guard.
   * @param {DataTransfer|null|undefined} dataTransfer - The drop's payload.
   * @returns {boolean} True when files were taken.
   */
  acceptDroppedFiles(dataTransfer) {
    return this.acceptFiles(dataTransfer?.files);
  }

  /**
   * Upload one image and add it to the pending attachments.
   * @param {File} file
   * @returns {Promise<void>}
   */
  async _uploadAndAdd(file) {
    return uploadAndAdd(this, file);
  }

  /**
   * Re-stage attachments from saved references (draft restore, history level).
   * @param {Array<{id:string,mime:string,filename:string,bytes:number,width:number,height:number}>} refs
   * @returns {number} Count of attachments actually staged.
   */
  setPendingAttachments(refs) {
    return setPendingAttachments(this, refs);
  }

  // ── Pasted-text tokens ────────────────────────────────────────────────────
  //
  // The capture thresholds, atomic-token editing, clipboard expansion and
  // mirror overlay live in composer-paste-tokens.js. These stay methods
  // because paste-token-test.js drives them on a mounted element.

  /**
   * Whether a pasted string is big enough to become a placeholder token.
   * @param {string} text
   * @returns {boolean} True to capture, false to paste normally.
   */
  _shouldCapturePaste(text) {
    return shouldCapturePaste(text);
  }

  /**
   * Capture pasted content into a placeholder token at the caret.
   * @param {string} content
   */
  _capturePaste(content) {
    capturePaste(this, content);
  }

  /**
   * Apply the atomic-token editing rules to a keydown.
   * @param {KeyboardEvent} e
   * @param {HTMLTextAreaElement} textarea
   * @returns {boolean} Whether the key was handled as a token operation.
   */
  _handleTokenKeydown(e, textarea) {
    return handleTokenKeydown(this, e, textarea);
  }

  /**
   * Put the expanded text on the clipboard when a token is copied or cut.
   * @param {ClipboardEvent} e
   * @param {HTMLTextAreaElement} textarea
   * @param {boolean} isCut
   */
  _onClipboardCopyCut(e, textarea, isCut) {
    onClipboardCopyCut(this, e, textarea, isCut);
  }

  /**
   * Revert an edit that damaged a token, and drop stray delimiters.
   * @param {HTMLTextAreaElement} textarea
   * @param {string} [inputType] - The `inputType` of the input being reconciled.
   * @returns {boolean} True if the value was changed (reverted, cleaned or stepped).
   */
  _reconcileTokens(textarea, inputType) {
    return reconcileTokens(this, textarea, inputType);
  }

  /** Bring the backdrop mirror into line with the textarea's current value. */
  _syncPasteMirror() {
    syncPasteMirror(this);
  }

  /**
   * Move a collapsed caret out of a token's interior.
   * @param {HTMLTextAreaElement} textarea
   */
  _snapSelectionOutOfTokens(textarea) {
    snapSelectionOutOfTokens(this, textarea);
  }

  /**
   * Create a new thread, including textarea text as initial message
   * @private
   */
  _createThread() {
    if (this._conversation?.isTurnActive()) {
      this.showWarning('Wait for the current turn to finish before creating a new thread.');
      return;
    }
    const textarea = this.querySelector('textarea');
    // Expand any inline paste placeholders before moving the text: the new
    // thread's draft carries the full content inline (no blob table travels
    // through the slash command), matching what a send would have produced.
    const text = textarea ? expandPasteTokens(textarea.value, this._pasteBlobs).trim() : '';
    let command = '/thread';
    if (text) {
      command += ` --draft-message ${text}`;
      // The text is being MOVED into the new thread, so this box must clear. The
      // plain clearInput() that the dispatched '/thread' triggers empties it via
      // `textarea.value = ''`, which wipes the browser's native undo stack — so
      // the user can't Ctrl/Cmd+Z the moved prompt back. Clear it undoably here
      // FIRST (an execCommand edit stays on the undo stack; setText() then skips
      // the no-op re-set of ''), but ONLY when the textarea already holds focus.
      // execCommand needs a focused, selected target, yet we must NOT call
      // focus() ourselves: grabbing focus to this box would rob the new thread's
      // box of the keyboard (its column-rebuild focus is what should win). When
      // the box isn't focused we simply leave it to clearInput() — undo isn't
      // preserved in that rare case, but focus behaviour is untouched.
      this._clearMovedTextUndoable();
    }

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

  // ── Scheduled send ────────────────────────────────────────────────────────
  //
  // Arming, the countdown and the delay picker live in composer-schedule.js.
  // The fire path stays a method: it is what scheduled-send-service.js calls on
  // the composer element when the wait is up, so it is public API, not a
  // private the service reaches past.

  /** Send the composed message now, ending an armed scheduled send. */
  fireScheduledSend() {
    fireArmedSend(this);
  }

  /**
   * Re-derive the displayed scheduled send from the bound thread's draft.
   * Public for the same reason as `fireScheduledSend`: scheduled-send-service.js
   * calls it on the element each sweep, so a box whose schedule was fired or
   * cancelled somewhere else — another window, or this window's own off-screen
   * fire path — stops showing a timer that no longer exists, without the user
   * having to touch the box first.
   */
  reconcileScheduledSend() {
    reconcileScheduleWithDraft(this);
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

    // The manager leads as a button rather than sitting in the list as
    // `/commands`, which is the row nobody reads as "you can write your own".
    // The built-ins below it are the ones this list already shows, so their
    // button goes where the rest of what the app loads is documented.
    const manageRow = buildManageCommandsRow();
    manageRow.addEventListener('click', () => {
      this._closeCommandsMenu();
      openCommandManager();
    });
    menu.appendChild(manageRow);

    const browseRow = buildBrowseCommandsRow();
    browseRow.addEventListener('click', () => {
      this._closeCommandsMenu();
      openSettings('extensions');
    });
    menu.appendChild(browseRow);

    for (const cmd of menuOrderedCommands(slashCommandHandler.getCommands())) {
      const item = buildCommandRow(cmd);
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
   * Toggle the skill picker menu.
   * @private
   */
  _toggleSkillMenu() {
    if (this._skillMenuOpen) {
      this._closeSkillMenu();
    } else {
      this._openSkillMenu();
    }
  }

  /**
   * Open the skill picker: a button-anchored menu of this thread's available
   * skills, mirroring the commands (`/`) button. Nothing is inserted on open or
   * on dismissal — only SELECTING a skill splices `$name ` into the composer (via
   * {@link _insertSkillMention}), so the choice flows through the same send-time
   * activation path as typing `$name`. It opens on an empty snapshot too: with no
   * skills the menu is the only place that says so and points at the Skills page.
   * @private
   * @returns {Promise<void>}
   */
  async _openSkillMenu() {
    const button = this.querySelector('#skill-button');
    if (!button) return;
    const skills = await getThreadSkillSnapshot(this._messageThread);
    // The snapshot is awaited, so the box may have detached meanwhile (nothing
    // would then release the popup), or a second click may have opened it.
    if (!this.isConnected || this._skillMenuOpen) return;

    this._createSkillMenu(Array.isArray(skills) ? skills : []);
    if (!this._skillMenu) return;

    this._skillMenu.classList.add('show');
    this._skillMenuOpen = true;

    // presentPopup owns body-append, dismissal wiring (outside-click via
    // insideSelectors + Escape) and the reposition observer, exactly as the
    // commands menu uses it. A dedicated cleanup handle keeps it independent of
    // the commands-menu popup.
    this._skillPopupCleanup = presentPopup({
      surface: this._skillMenu,
      anchor: /** @type {HTMLElement} */ (button),
      id: 'skill-picker',
      onClose: () => this._closeSkillMenu(),
      align: 'left',
      gap: 4,
      insideSelectors: ['#skill-button', '.skill-menu'],
    });
  }

  /**
   * Close the skill picker menu.
   * @private
   */
  _closeSkillMenu() {
    if (!this._skillMenu) return;
    this._skillMenuOpen = false;
    // Release tears down the surface, observer and dismissal wiring.
    if (this._skillPopupCleanup) {
      this._skillPopupCleanup();
      this._skillPopupCleanup = null;
    }
    this._skillMenu = null;
  }

  /**
   * Build the skill picker menu: one row per available skill (mono `$name` +
   * one-line description), each inserting `$name ` on click, followed by a
   * "Manage skills…" footer that opens the Skills settings page. With no skills
   * the rows are replaced by a hint saying so, since the footer is then the whole
   * point of the menu. Carries the `commands-menu` class so it borrows the
   * slash-command popup's justified two-column grid and colour scheme verbatim,
   * and shares the `$` completion menu's row builder ({@link renderSkillMenuItem}).
   * presentPopup (in _openSkillMenu) owns body-append and teardown.
   * @param {import('../services/skills.js').SkillMeta[]} skills - This thread's snapshot skills
   * @private
   */
  _createSkillMenu(skills) {
    if (this._skillMenu) {
      this._skillMenu.remove();
    }
    const menu = document.createElement('menu');
    menu.className = 'dropdown-menu commands-menu skill-menu';
    menu.id = 'skill-menu';

    // Name-sorted, matching the `$` autocomplete's stable ordering.
    const sorted = [...skills].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const skill of sorted) {
      // Same row builder as the `$` completion menu; only the click handler
      // differs (the picker splices the mention; the autocomplete accepts it).
      const item = renderSkillMenuItem(skill);
      item.addEventListener('click', () => {
        this._insertSkillMention(skill.name);
      });
      menu.appendChild(item);
    }

    // Nothing to list: one line where the rows would have been, and the footer
    // below it reads as the remedy — so no divider, which would only rule off a
    // sentence from its own answer. `skill-menu-empty` drops the wide fixed width
    // the description column needs, leaving the popup the size of its message.
    if (sorted.length === 0) {
      menu.classList.add('skill-menu-empty');
      const hint = document.createElement('li');
      hint.className = 'menu-item menu-item-hint';
      const text = document.createElement('span');
      text.className = 'menu-hint-text';
      text.textContent = 'No skills installed.';
      hint.appendChild(text);
      menu.appendChild(hint);
    } else {
      const divider = document.createElement('li');
      divider.className = 'menu-divider';
      menu.appendChild(divider);
    }

    // Footer: a jump to the Skills settings page (install / edit / remove
    // skills). The picker is a deliberate, mouse-first surface — unlike the `$`
    // autocomplete — so it carries the management affordance the typed path omits.

    const manage = document.createElement('li');
    manage.className = 'menu-item skill-menu-manage';
    manage.dataset.action = 'manage-skills';
    manage.textContent = 'Manage skills…';
    manage.addEventListener('click', () => {
      this._closeSkillMenu();
      openSettings('skills');
    });
    menu.appendChild(manage);

    this._skillMenu = menu;
  }

  /**
   * Splice a `$name ` skill mention into the composer at the caret (prefixed with
   * a space when the preceding char isn't a mention boundary), then close the
   * menu and focus the textarea. Identical to accepting the `$` autocomplete, so
   * the mention is loaded and stripped by the normal send-time path.
   * @param {string} name - Exact skill name
   * @private
   */
  _insertSkillMention(name) {
    this._closeSkillMenu();
    const textarea = /** @type {HTMLTextAreaElement|null} */ (this.querySelector('textarea'));
    if (!textarea) return;
    const pos = textarea.selectionStart ?? textarea.value.length;
    const before = textarea.value.slice(0, pos);
    // Mirror the mention-boundary rule: a `$` only triggers at start-of-text or
    // after whitespace, so insert a leading space when the caret sits on a
    // non-boundary char.
    const needsSpace = before.length > 0 && !/\s$/.test(before);
    const insertText = (needsSpace ? ' ' : '') + '$' + name + ' ';
    textarea.value = before + insertText + textarea.value.slice(pos);
    const newPos = pos + insertText.length;
    textarea.selectionStart = textarea.selectionEnd = newPos;
    this.autoResize(textarea);
    textarea.focus();
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
   * Toggle the touch-only "⋮" actions sheet.
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
   * Build and present the "⋮" actions sheet. Essential controls lead — Send
   * later, New Thread — always visible so they never scroll off behind a long
   * list. (Attach files is not among them: it stays inline beside Send on touch
   * too, where it can be found.) Below them, slash commands and skills each get their own
   * closed-by-default collapsible section (standing in for the inline `/` and `$`
   * buttons, which are hidden on touch), so the sheet opens short and each list is
   * one tap away. On a narrow viewport presentPopup renders it as a bottom sheet
   * (drag-to-dismiss); on a wider one it anchors to the "⋮" button. The rows reuse
   * the same handlers as the inline controls, so nothing nests a second popup.
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
     * @param {string} [action]
     */
    const addRow = (label, iconSvg, onClick, action = '') => {
      const item = document.createElement('li');
      item.className = 'menu-item actions-sheet-item';
      if (action) item.dataset.action = action;
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

    // Essentials lead the sheet so they never scroll off behind a long command
    // list. Strategy is not among them: on touch it is on show in the config
    // strip, which is both a display of the current strategy and the control
    // that changes it. Nor is Attach files, which stays inline beside Send.
    // Schedule-send ("send later") is a rarely-used control, so on touch it
    // lives here rather than on the inline row. The row opens the same picker as
    // the inline clock button (which stays visible only while armed).
    addRow('Send later', CLOCK_SVG, () => toggleSchedulePicker(this));

    /**
     * Append a closed-by-default collapsible section of pre-built rows (native
     * `<details>`, so the header toggle needs no JS state). Skipped when empty.
     * @param {string} title - Section header label
     * @param {HTMLElement[]} rows - Row elements revealed when the section expands
     */
    const addSection = (title, rows) => {
      if (!rows.length) return;
      const section = document.createElement('details');
      section.className = 'actions-sheet-section';
      const summary = document.createElement('summary');
      summary.className = 'actions-sheet-section-header';
      summary.textContent = title;
      section.appendChild(summary);
      for (const row of rows) section.appendChild(row);
      menu.appendChild(section);
    };

    // Slash commands section (collapsed), led by the manager button in place of
    // the `/commands` row it stands for, and the built-ins' button beside it.
    const manageRow = buildManageCommandsRow('actions-sheet-item');
    manageRow.addEventListener('click', () => {
      this._closeActionsSheet();
      openCommandManager();
    });
    const browseRow = buildBrowseCommandsRow('actions-sheet-item');
    browseRow.addEventListener('click', () => {
      this._closeActionsSheet();
      openSettings('extensions');
    });
    const commandRows = menuOrderedCommands(slashCommandHandler.getCommands()).map((cmd) => {
      const row = buildCommandRow(cmd, { extraClass: 'actions-sheet-item', labelClass: 'actions-sheet-label' });
      row.addEventListener('click', () => {
        this._closeActionsSheet();
        this._executeSlashCommand(cmd.name);
      });
      return row;
    });
    addSection('Slash commands', [manageRow, browseRow, ...commandRows]);

    // Skills section (collapsed) — this thread's frozen snapshot, standing in for
    // the inline `$` picker on touch. Selecting one splices `$name ` into the
    // composer via the same path as the picker/autocomplete, and the section is
    // led by the same "Manage skills…" row the picker ends with, so it is there
    // to be found when the thread advertises no skills at all.
    /** @type {import('../services/skills.js').SkillMeta[]} */
    let skills = [];
    try {
      skills = await getThreadSkillSnapshot(this._messageThread);
    } catch {
      skills = [];
    }
    const skillRows = (Array.isArray(skills) ? skills : [])
      .slice()
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((skill) => {
        const row = document.createElement('li');
        row.className = 'menu-item actions-sheet-item';
        row.dataset.skill = skill.name;
        const code = document.createElement('code');
        code.textContent = '$' + skill.name;
        row.appendChild(code);
        const desc = document.createElement('span');
        desc.className = 'actions-sheet-label';
        desc.textContent = skill.description || skill.name;
        row.appendChild(desc);
        row.addEventListener('click', () => {
          this._closeActionsSheet();
          this._insertSkillMention(skill.name);
        });
        return row;
      });
    const manageSkillsRow = document.createElement('li');
    manageSkillsRow.className = 'menu-item actions-sheet-item skill-menu-manage';
    manageSkillsRow.dataset.action = 'manage-skills';
    const manageSkillsLabel = document.createElement('span');
    manageSkillsLabel.className = 'actions-sheet-label';
    manageSkillsLabel.textContent = 'Manage skills…';
    manageSkillsRow.appendChild(manageSkillsLabel);
    manageSkillsRow.addEventListener('click', () => {
      this._closeActionsSheet();
      openSettings('skills');
    });
    addSection('Skills', [manageSkillsRow, ...skillRows]);

    // New Thread closes the sheet — it starts a fresh sub-thread rather than
    // acting on this composer, so it sits apart at the bottom below the command
    // and skill sections.
    addRow('New Thread', THREAD_ARROW_SVG, () => this._createThread(), 'new-thread');
    this._updateNewThreadControls();

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
   * Close the "⋮" actions sheet.
   * @private
   */
  _closeActionsSheet() {
    if (!this._actionsSheetOpen) return;
    this._actionsSheetOpen = false;
    if (this._actionsSheetCleanup) {
      this._actionsSheetCleanup();
      this._actionsSheetCleanup = null;
    }
    this._actionsSheet = null;
  }

  render() {
    this.innerHTML = `
            <composer-box-wrapper>
                <composer-config-strip></composer-config-strip>
                <composer-box-attachments></composer-box-attachments>
                <textarea
                    aria-label="Message input"
                    autocorrect="off"
                    autocapitalize="off"
                    spellcheck="false"
                    enterkeyhint="enter"
                ></textarea>
                <input type="file" class="attach-file-input" multiple hidden />
                <input-controls>
                    <input-controls-config>
                        <strategy-selector></strategy-selector>
                        <permission-controls></permission-controls>
                        <model-selector id="conversation-model-selector"></model-selector>
                    </input-controls-config>
                    <input-controls-actions>
                        <button class="commands-button input-ctrl-btn" id="commands-button"
                                title="Commands"
                                aria-label="Commands menu">
                            <span class="icon-slash"></span>
                        </button>
                        <button class="skill-button input-ctrl-btn" id="skill-button"
                                title="Load a skill ($)"
                                aria-label="Load a skill">
                            <span class="skill-glyph" aria-hidden="true">$</span>
                        </button>
                        <button class="more-actions-btn input-ctrl-btn" id="more-actions-button"
                                title="More actions"
                                aria-label="More actions">
                            <span class="more-actions-icon">${KEBAB_SVG}</span>
                        </button>
                        <button class="schedule-send-btn input-ctrl-btn"
                                title="Send later"
                                aria-label="Send later">
                            <span class="schedule-send-icon">${CLOCK_SVG}</span>
                            <span class="schedule-send-countdown" hidden></span>
                        </button>
                    </input-controls-actions>
                    <input-controls-send>
                        <button class="new-thread-btn input-ctrl-btn" title="Create a new sub-thread">
                            New Thread
                            <span class="new-thread-arrow">${THREAD_ARROW_SVG}</span>
                        </button>
                        <button class="context-cache-warning-btn" id="context-cache-warning" hidden
                                title="Items in the conversation have changed, so the next message will cause a cache-miss"
                                aria-label="Items in the conversation have changed, so the next message will cause a cache-miss">
                            <span class="icon-warning" aria-hidden="true"></span>
                        </button>
                        <button class="attach-btn input-ctrl-btn" id="attach-button"
                                title="Attach files — or drop or paste them here"
                                aria-label="Attach files">
                            <span class="attach-icon">${PAPERCLIP_SVG}</span>
                        </button>
                        <button class="send-btn is-empty" id="send-button"
                                title="Send message"
                                aria-label="Send message">
                            <span class="send-icon">${SEND_ARROW_SVG}</span>
                        </button>
                    </input-controls-send>
                </input-controls>
            </composer-box-wrapper>
        `;
    // Home the config controls synchronously, in the same frame as the DOM they
    // belong to: deferring it would paint the row once with three pills in it
    // before moving them to the strip.
    this._applyConfigPlacement();
    // Seed the placeholder synchronously: the textarea exists as of the write
    // above, and the box is on screen before the deferred setup below runs.
    this._updatePlaceholder();
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

customElements.define('composer-box', Composer);

export default Composer;
