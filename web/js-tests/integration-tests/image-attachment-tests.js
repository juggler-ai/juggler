//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration tests for image-attachment support that live at the JS layer:
 *
 *  1. Compaction stand-in — getContentMessages() must represent a user
 *     message's image attachments as a short "[image: <filename>]" text
 *     stand-in (so a summariser never tries to re-embed bytes) WITHOUT
 *     mutating the underlying doc item.
 *
 * The provider-request-carries-the-image and asset-GC properties are covered
 * by deterministic Go tests (tests/integration/image_attachment_test.go and
 * cmd/juggler/worker/asset_gc_test.go) where the captured request and the
 * sweep are inspectable directly.
 *  2. Rewind restores attachments — sending a user message that carries an
 *     image attachment, then rewinding to it, must restore the attachment into
 *     the input box (pending list + rendered chip) alongside the text, and a
 *     re-send must carry the attachment through again. Attachments are restored
 *     regardless of the current model's capability (image capability is never
 *     gated client-side; an incapable model rejects the image at send time).
 * @module integration-tests/image-attachment-tests
 */

import { textResponse } from '../utilities/integration-test-runner.js';
import { normalizeAttachments } from '../../js/utils/attachments.js';

/**
 * Poll for a predicate to become true (image-attachment rewind test).
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 * @param {string} [label]
 */
async function waitFor(predicate, timeoutMs = 2000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

/**
 * Push the standard two-provider list (one image-capable, one text-only)
 * through the WS provider-update path so currentModelSupportsImages() reads it.
 * @param {any} wsService
 */
function pushVisionAndTextProviders(wsService) {
  wsService._emit('providers-update', [
    {
      name: 'vision-co',
      displayName: 'Vision Co',
      modelsWithContext: [
        { id: 'vis-1', contextWindow: 200000, maxOutputTokens: 8192, fromAPI: false, inputModalities: ['text', 'image'] }
      ]
    },
    {
      name: 'text-co',
      displayName: 'Text Co',
      modelsWithContext: [
        { id: 'txt-1', contextWindow: 200000, maxOutputTokens: 8192, fromAPI: false, inputModalities: [] }
      ]
    }
  ]);
}

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const compactionAttachmentStandinTest = {
  name: 'compaction-attachment-standin',
  description: 'getContentMessages() appends a "[image: <filename>]" stand-in for a user item\'s attachments without mutating the doc item.',
  fixture: 'unit-test-fixture',
  llmResponses: [],
  operations: [],

  async customAssertions() {
    const { getContentMessages } = await import('../../js/utils/compaction-utils.js');

    // Minimal Y.Map-like fakes: getContentMessages only uses .get(key).
    const backing = {
      user: { type: 'user', content: 'look at this', attachments: [{ id: 'sha-1', mime: 'image/png', filename: 'pixel.png' }] },
      plain: { type: 'user', content: 'no image here' }
    };
    const mk = (m) => ({ get: (k) => m[k] });
    const userItem = mk(backing.user);
    const plainItem = mk(backing.plain);

    const out = getContentMessages({ getMessages: () => [userItem, plainItem] });
    if (out.length !== 2) {
      throw new Error(`Expected 2 content messages, got ${out.length}`);
    }

    // The attachment-bearing message's content carries the stand-in.
    const augmented = out[0].get('content');
    if (augmented !== 'look at this\n[image: pixel.png]') {
      throw new Error(`Stand-in not appended correctly; got ${JSON.stringify(augmented)}`);
    }

    // The plain message is untouched.
    if (out[1].get('content') !== 'no image here') {
      throw new Error(`Plain message content was altered; got ${JSON.stringify(out[1].get('content'))}`);
    }

    // Crucially, the underlying doc item is NOT mutated (read via the backing).
    if (backing.user.content !== 'look at this') {
      throw new Error(`getContentMessages mutated the doc item content: ${JSON.stringify(backing.user.content)}`);
    }
    // Other fields still delegate through the wrapper.
    if (out[0].get('type') !== 'user') {
      throw new Error('Wrapper failed to delegate non-content field "type"');
    }
  }
};

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const rewindRestoresAttachmentsTest = {
  name: 'rewind-restores-attachments',
  description: 'Rewinding to a user message that carried an image attachment restores the attachment into the input box (pending + chip) and re-sending carries it through, regardless of the current model (capability is never gated client-side).',
  fixture: 'unit-test-fixture',
  llmResponses: [
    textResponse('first.'),
    textResponse('second.')
  ],
  operations: [],

  async customAssertions(conversation, ctx) {
    const harness = ctx.harness;
    const wsService = (await import('../../js/services/websocket.js')).default;
    const providersCache = (await import('../../js/services/providers-cache.js')).default;

    const prior = providersCache.get();
    try {
      pushVisionAndTextProviders(wsService);
      await conversation.setModelConfig({ provider: 'vision-co', model: 'vis-1' });

      const tab = /** @type {any} */ (conversation.getTabElement());
      const inputBox = tab?.getInputBox?.();
      if (!inputBox) return; // headless — no UI to drive

      // The image attachment to attach + send.
      const ref = { id: 'sha-rewind-1', mime: 'image/png', filename: 'pixel.png', bytes: 123, width: 1, height: 1 };

      /**
       * Send `text` through the real input-box UI path. When `attachments` is
       * given it is staged on the box first (mirrors a user attaching images);
       * otherwise whatever is already staged is sent.
       * @param {string} text
       * @param {Array<any>} [attachments]
       */
      const sendVia = async (text, attachments) => {
        if (attachments) inputBox._pendingAttachments = attachments.map((a) => ({ ...a }));
        const textarea = inputBox.querySelector('textarea');
        textarea.value = text;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        const since = conversation.completedTurns;
        harness.consumeResponse();
        const blocked = await inputBox.sendMessage();
        if (blocked) throw new Error(`send blocked: ${blocked}`);
        await harness.awaitPendingSend();
        await harness.waitForTurnComplete(6000, since);
      };

      const userAttachments = (conv) => {
        const items = conv.rootMessageThread.items;
        const idx = items.findIndex((/** @type {any} */ it) => it.get('type') === 'user');
        if (idx < 0) return { idx, atts: [] };
        return { idx, atts: normalizeAttachments(items[idx].get('attachments')) };
      };

      // 1. Send a message WITH the image attachment.
      await sendVia('look at this', [ref]);

      const first = userAttachments(conversation);
      if (first.atts.length !== 1 || first.atts[0].id !== ref.id) {
        throw new Error(`Expected sent user item to carry the attachment; got ${JSON.stringify(first.atts)}`);
      }

      // 2. Rewind to that user message — mirrors app.js _handleRollbackFromItem:
      //    read content + attachments, delete the range, restore into the box.
      const restoredText = conversation.rootMessageThread.items[first.idx].get('content');
      const restoredAtts = normalizeAttachments(conversation.rootMessageThread.items[first.idx].get('attachments'));
      conversation.deleteRangeWithCleanup(conversation.rootMessageThread, first.idx);
      inputBox.setText(restoredText);
      const staged = inputBox.setPendingAttachments(restoredAtts);

      // 3. The input box now holds the attachment again (pending + chip).
      if (staged !== 1) {
        throw new Error(`Expected setPendingAttachments to stage 1 attachment; got ${staged}`);
      }
      if (inputBox._pendingAttachments.length !== 1 || inputBox._pendingAttachments[0].id !== ref.id) {
        throw new Error(`Pending attachments not restored; got ${JSON.stringify(inputBox._pendingAttachments)}`);
      }
      // UI-only fields must NOT leak onto the restored ref.
      if ('_previewURL' in inputBox._pendingAttachments[0] || '_uploading' in inputBox._pendingAttachments[0]) {
        throw new Error('Restored attachment carried UI-only fields (_previewURL/_uploading)');
      }
      await waitFor(
        () => {
          const c = inputBox.querySelector('input-box-attachments');
          const chip = c && c.querySelector('.attachment-chip');
          const name = chip && chip.querySelector('.attachment-name');
          return !!name && name.textContent === 'pixel.png';
        },
        2000,
        'attachment chip rendered after rewind'
      );

      // 4. Re-send (text already set, attachment already staged): the new user
      //    item must carry the attachment through again.
      await sendVia(restoredText);
      const second = userAttachments(conversation);
      if (second.atts.length !== 1 || second.atts[0].id !== ref.id) {
        throw new Error(`Re-sent user item lost the attachment; got ${JSON.stringify(second.atts)}`);
      }

      // 5. No client-side capability gating: restoring onto a text-only model
      //    still stages the attachment. An incapable model rejects the image at
      //    send time (provider error), rather than the UI silently dropping it.
      await conversation.setModelConfig({ provider: 'text-co', model: 'txt-1' });
      const staged2 = inputBox.setPendingAttachments([{ ...ref }]);
      if (staged2 !== 1 || inputBox._pendingAttachments.length !== 1 || inputBox._pendingAttachments[0].id !== ref.id) {
        throw new Error(`Text-only model must still stage restored attachments; staged=${staged2}, pending=${inputBox._pendingAttachments.length}`);
      }
    } finally {
      wsService._emit('providers-update', prior);
    }
  }
};

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const propertiesPanelShowsAttachmentsTest = {
  name: 'properties-panel-shows-attachments',
  description: 'Selecting a user message that carries an image attachment renders an Attachments section in the properties panel with the filename, type/size metadata, and a thumbnail pointing at the asset URL.',
  fixture: 'unit-test-fixture',
  llmResponses: [
    textResponse('looked.')
  ],
  operations: [],

  async customAssertions(conversation, ctx) {
    const harness = ctx.harness;
    const apiService = (await import('../../js/services/api.js')).default;

    const tab = /** @type {any} */ (conversation.getTabElement());
    const inputBox = tab?.getInputBox?.();
    if (!inputBox) return; // headless — no UI to drive

    const ref = { id: 'sha-props-1', mime: 'image/png', filename: 'diagram.png', bytes: 5000, width: 640, height: 480 };

    // Send a user message carrying the attachment via the real input-box path.
    inputBox._pendingAttachments = [{ ...ref }];
    const textarea = inputBox.querySelector('textarea');
    textarea.value = 'look at this diagram';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    const since = conversation.completedTurns;
    harness.consumeResponse();
    const blocked = await inputBox.sendMessage();
    if (blocked) throw new Error(`send blocked: ${blocked}`);
    await harness.awaitPendingSend();
    await harness.waitForTurnComplete(6000, since);

    // Locate the committed user item and select it via the real path.
    const items = conversation.rootMessageThread.items;
    const userItem = items.find((/** @type {any} */ it) => it.get('type') === 'user');
    if (!userItem) throw new Error('No committed user item found after send');
    const itemId = userItem.get('itemId');

    const area = /** @type {any} */ (document.querySelector('conversation-area'));
    if (!area || typeof area._selectItem !== 'function') {
      throw new Error('No conversation-area available to select the user message in');
    }
    area._selectItem(itemId, 'user');

    // The panel render is debounced; poll for the attachment section.
    const expectedSrc = apiService.assetURL(conversation.id, ref.id);
    let img = null;
    let nameEl = null;
    let metaEl = null;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const panel = /** @type {any} */ (document.querySelector('properties-panel'));
      img = panel ? panel.querySelector('.properties-panel-attachment-thumb') : null;
      nameEl = panel ? panel.querySelector('.properties-panel-attachment-name') : null;
      metaEl = panel ? panel.querySelector('.properties-panel-attachment-meta') : null;
      if (img && nameEl && metaEl) break;
      await new Promise((r) => setTimeout(r, 30));
    }

    if (!nameEl || nameEl.textContent !== 'diagram.png') {
      throw new Error(`Attachment filename not rendered; got ${nameEl ? JSON.stringify(nameEl.textContent) : 'null'}`);
    }
    if (!img || img.getAttribute('src') !== expectedSrc) {
      throw new Error(`Attachment thumbnail src wrong; expected ${expectedSrc}, got ${img ? img.getAttribute('src') : 'null'}`);
    }
    const meta = metaEl ? (metaEl.textContent || '') : '';
    if (!meta.includes('image/png') || !meta.includes('640×480') || !meta.includes('4.9 KB')) {
      throw new Error(`Attachment metadata incomplete; got ${JSON.stringify(meta)}`);
    }
  }
};

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const imageOnlySendTest = {
  name: 'image-only-send',
  description: 'Staging an image with no caption text enables the send button and sends: the committed user item carries the attachment with empty content, and no blank entry is pushed into input history.',
  fixture: 'unit-test-fixture',
  llmResponses: [
    textResponse('saw it.')
  ],
  operations: [],

  async customAssertions(conversation, ctx) {
    const harness = ctx.harness;
    const wsService = (await import('../../js/services/websocket.js')).default;
    const providersCache = (await import('../../js/services/providers-cache.js')).default;

    const prior = providersCache.get();
    try {
      pushVisionAndTextProviders(wsService);
      await conversation.setModelConfig({ provider: 'vision-co', model: 'vis-1' });

      const tab = /** @type {any} */ (conversation.getTabElement());
      const inputBox = tab?.getInputBox?.();
      if (!inputBox) return; // headless — no UI to drive

      const ref = { id: 'sha-imageonly-1', mime: 'image/png', filename: 'pixel.png', bytes: 123, width: 1, height: 1 };
      const sendBtn = inputBox.querySelector('#send-button');
      const textarea = inputBox.querySelector('textarea');
      const historyLenBefore = conversation._session.messageHistory.length;

      // Stage the image via the real staging path; leave the textarea empty.
      const staged = inputBox.setPendingAttachments([{ ...ref }]);
      if (staged !== 1) {
        throw new Error(`Expected setPendingAttachments to stage 1 attachment; got ${staged}`);
      }

      // An image staged with empty text must enable the send button.
      if (sendBtn && sendBtn.classList.contains('is-empty')) {
        throw new Error('Send button stayed disabled (is-empty) with an image staged and no text');
      }
      if (textarea.value.trim() !== '') {
        throw new Error('Test setup wrong: textarea should be empty for the image-only case');
      }

      // Send with NO text — must not be blocked.
      const since = conversation.completedTurns;
      harness.consumeResponse();
      const blocked = await inputBox.sendMessage();
      if (blocked) throw new Error(`image-only send blocked: ${blocked}`);
      await harness.awaitPendingSend();
      await harness.waitForTurnComplete(6000, since);

      // The committed user item carries the attachment with empty content.
      const items = conversation.rootMessageThread.items;
      const userItem = items.find((/** @type {any} */ it) => it.get('type') === 'user');
      if (!userItem) throw new Error('No committed user item after image-only send');
      const atts = normalizeAttachments(userItem.get('attachments'));
      if (atts.length !== 1 || atts[0].id !== ref.id) {
        throw new Error(`Image-only user item lost the attachment; got ${JSON.stringify(atts)}`);
      }
      const content = userItem.get('content');
      if (content !== '' && content !== null && content !== undefined) {
        throw new Error(`Image-only user item should have empty content; got ${JSON.stringify(content)}`);
      }

      // No blank entry pushed into up-arrow history.
      if (conversation._session.messageHistory.length !== historyLenBefore) {
        throw new Error(`Image-only send polluted input history; len ${historyLenBefore} -> ${conversation._session.messageHistory.length}`);
      }
    } finally {
      wsService._emit('providers-update', prior);
    }
  }
};

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const pasteAsyncClipboardFallbackTest = {
  name: 'paste-async-clipboard-fallback',
  description: 'When the synchronous paste event carries no image file (the WebKit / Wails desktop-app case), the paste handler falls back to the async Clipboard API (navigator.clipboard.read) and routes the image blob through _handleFiles. Part A drives the fallback method directly; Part B drives it through a paste event whose synchronous data has no image.',
  fixture: 'unit-test-fixture',
  llmResponses: [],
  operations: [],

  async customAssertions(conversation) {
    const tab = /** @type {any} */ (conversation.getTabElement());
    const inputBox = tab?.getInputBox?.();
    if (!inputBox) return; // headless — no UI to drive
    const textarea = inputBox.querySelector('textarea');
    if (!textarea) throw new Error('input box has no textarea');

    // Stub the async Clipboard API to return exactly one PNG image. Defined as
    // an own property on `navigator` so it shadows the prototype getter; if the
    // environment forbids that, skip rather than fail.
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG signature
    const fakeItem = {
      types: ['image/png'],
      getType: async (/** @type {string} */ t) => new Blob([pngBytes], { type: t })
    };
    const hadOwn = Object.prototype.hasOwnProperty.call(navigator, 'clipboard');
    const originalDescriptor = hadOwn ? Object.getOwnPropertyDescriptor(navigator, 'clipboard') : null;
    try {
      Object.defineProperty(navigator, 'clipboard', {
        value: { read: async () => [fakeItem] },
        configurable: true
      });
    } catch {
      return; // Can't stub the clipboard here — nothing to assert.
    }

    const originalHandleFiles = inputBox._handleFiles;
    const originalFallback = inputBox._pasteImagesFromAsyncClipboard;
    try {
      // ── Part A: the async fallback method itself materialises the clipboard
      //    image and routes it through _handleFiles (read → getType → File). ──
      /** @type {any[]} */
      const captured = [];
      inputBox._handleFiles = (/** @type {FileList|File[]} */ files) => {
        for (const f of Array.from(files)) captured.push(f);
      };
      await inputBox._pasteImagesFromAsyncClipboard();
      if (captured.length === 0) {
        throw new Error('async fallback did not deliver any file to _handleFiles');
      }
      const file = captured[0];
      if (!file || typeof file.type !== 'string' || !file.type.startsWith('image/')) {
        throw new Error(`async fallback delivered a non-image; got ${JSON.stringify(file)}`);
      }
      if (!(file.size > 0)) {
        throw new Error(`pasted image File has no bytes; size=${file && file.size}`);
      }

      // ── Part B: a paste event that carries no synchronous image (the WebKit
      //    case) consults the async fallback. A paste event with no
      //    clipboardData image and no text is exactly the "no synchronous image,
      //    no text" shape that triggers it. (A synthetic ClipboardEvent isn't
      //    dispatched to listeners in WebKit, so a plain Event of type 'paste' —
      //    which yields clipboardData === undefined — is used to drive the
      //    handler's gate.) ─────────────────────────────────────────────────
      // The input box wires its listeners in a requestAnimationFrame after
      // render; in this headless test-pool the frame may not have run for this
      // box yet (event-driven paths aren't exercised by the other attachment
      // tests, which call methods directly). Ensure the paste listener is bound
      // before driving it — this mirrors what the real app's rAF does.
      if (!inputBox._completions) inputBox.setupListeners();
      captured.length = 0; // reset; the real fallback (below) should refill it
      textarea.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }));
      try {
        await waitFor(
          () => captured.length > 0,
          2000,
          'paste event with no synchronous image consulted the async clipboard fallback'
        );
      } catch (err) {
        throw new Error(
          `${err.message} [DIAG _completions=${!!inputBox._completions} ` +
          `sameTextarea=${textarea === inputBox.querySelector('textarea')}]`
        );
      }
      if (!captured[0] || !String(captured[0].type).startsWith('image/')) {
        throw new Error(`paste-driven fallback delivered a non-image; got ${JSON.stringify(captured[0])}`);
      }
    } finally {
      inputBox._handleFiles = originalHandleFiles;
      inputBox._pasteImagesFromAsyncClipboard = originalFallback;
      if (originalDescriptor) {
        Object.defineProperty(navigator, 'clipboard', originalDescriptor);
      } else {
        // No own property existed before — remove ours to unshadow the getter.
        delete (/** @type {any} */ (navigator)).clipboard;
      }
    }
  }
};

export const tests = [
  compactionAttachmentStandinTest,
  rewindRestoresAttachmentsTest,
  propertiesPanelShowsAttachmentsTest,
  imageOnlySendTest,
  pasteAsyncClipboardFallbackTest
];
