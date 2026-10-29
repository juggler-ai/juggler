//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Dropped-text-file support tests.
 *
 * Three concerns, all backend-free:
 *  1. DroppedFileContextItem.createContextText — a staged text file must reach
 *     the LLM in the same `<file>`-wrapped, line-numbered form as an `@`-mention;
 *     empty content collapses to '' (nothing injected).
 *  2. normalizeDraft round-trips the new `textFiles` field, so a dropped file
 *     staged in the composer survives the draft save/reload cycle alongside the
 *     text and image attachments (they are one persisted record).
 *  3. composer-box._handleTextFiles guards: a per-file SIZE gate that fires on
 *     `file.size` BEFORE any read (so a gigabyte drop is rejected without being
 *     allocated), and a binary-content gate. Both reject-with-warning and do
 *     NOT stage the file; a valid small text file IS staged.
 *  4. composer-box._handleFiles image-size gate: a dropped image is rejected when
 *     it exceeds the send target's per-provider limit (model-aware), so an
 *     image the provider would reject never enters the conversation.
 * @module unit-tests/dropped-file-test
 */

import DroppedFileContextItem from '../context-items/dropped-file-context-item.js';
import { normalizeDraft, normalizeTextFiles } from '../../../js/utils/attachments.js';
import { initializeRegistries, assert, waitFor } from '../../../js-tests/utilities/test-helpers.js';
import '../../../js/components/composer.js';
import { underPseudoLocale, shownStrings } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';

/** juggler-core's English for this plugin, standing in for its catalogue. */
const CORE_TEXT = ['Dropped file', 'Dropped file: {filename}', '(empty)'];

/**
 * Mount an <composer-box> offscreen and bind its listeners synchronously (render()
 * defers setupListeners to rAF, which never pumps in the hidden test window —
 * mirrors mobile-composer-test's mount). Stubs showWarning to capture messages.
 * @returns {{box: any, container: HTMLElement, warnings: string[]}} Mounted box, its container, and captured warnings.
 */
function mountComposer() {
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:360px;height:600px;';
  const box = /** @type {any} */ (document.createElement('composer-box'));
  container.appendChild(box);
  document.body.appendChild(container);

  /** @type {any} */ (box).setupListeners?.();
  /** @type {any} */ (box).setupListeners = () => {};

  /** @type {string[]} */
  const warnings = [];
  box.showWarning = (/** @type {string} */ msg) => { warnings.push(msg); };

  return { box, container, warnings };
}

/**
 * Build a File whose reported `size` is overridden without allocating bytes —
 * lets us simulate a multi-GB drop from a one-byte payload. The size gate reads
 * `file.size` before any read, so the override alone drives the rejection.
 * @param {string} name
 * @param {string} content
 * @param {number} size
 * @returns {File} A File with the given name/content and a forced size.
 */
function fileWithSize(name, content, size) {
  const file = new window.File([content], name, { type: 'text/plain' });
  Object.defineProperty(file, 'size', { value: size, configurable: true });
  return file;
}

/**
 * Build an image File whose reported `size` is overridden without allocating
 * bytes — lets us simulate a large image drop from a one-byte payload. The
 * image-size gate reads `file.size`, so the override alone drives acceptance or
 * rejection.
 * @param {string} name
 * @param {number} size
 * @returns {File} An image/png File with a forced size.
 */
function imageWithSize(name, size) {
  const file = new window.File(['x'], name, { type: 'image/png' });
  Object.defineProperty(file, 'size', { value: size, configurable: true });
  return file;
}

/**
 * Stub the model this composer will send to, so {@link _maxImageBytes}
 * resolves a specific provider without a live conversation.
 * @param {any} box
 * @param {string} provider
 */
function stubModel(box, provider) {
  box._messageThread = { getEffectiveModelConfig: () => ({ provider, model: 'm' }) };
}

/**
 * The context for an item whose tests reach none of its host objects: each is
 * an empty stand-in for the session, conversation and thread.
 * @returns {import('../../../sdk/context-item-types.js').ItemContext} The context.
 */
function bareItemContext() {
  return /** @type {import('../../../sdk/context-item-types.js').ItemContext} */ (
    { id: 'DROP_test', session: {}, conversation: {}, messageThread: {} });
}

/**
 * Run the dropped-file test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts and any error messages.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => Promise<void>|void} fn
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── 1. Context item formatting ────────────────────────────────────────────

  await test('createContextText wraps content in <file> with line numbers', async () => {
    const item = new DroppedFileContextItem(bareItemContext());
    await item.onToolCall('dropped-file', { filename: 'notes.txt', content: 'alpha\nbeta' });
    const text = await item.createContextText();
    assert(text.includes('<file path="notes.txt">'), `missing <file> wrapper:\n${text}`);
    assert(/\bbeta\b/.test(text), `missing content:\n${text}`);
    assert(text.includes('1\talpha'), `missing line-numbered first line:\n${text}`);
    assert(text.includes('2\tbeta'), `missing line-numbered second line:\n${text}`);
  });

  await test('createContextText returns "" for empty content', async () => {
    const item = new DroppedFileContextItem(bareItemContext());
    await item.onToolCall('dropped-file', { filename: 'empty.txt', content: '' });
    const text = await item.createContextText();
    assert(text === '', `empty content must inject nothing, got ${JSON.stringify(text)}`);
  });

  await test('onToolCall rejects a non-string content param', async () => {
    const item = new DroppedFileContextItem(bareItemContext());
    let threw = false;
    try {
      await item.onToolCall('dropped-file', { filename: 'x.txt' });
    } catch {
      threw = true;
    }
    assert(threw, 'onToolCall must throw when content is missing');
  });

  // ── 2. Draft round-trip ───────────────────────────────────────────────────

  await test('normalizeDraft round-trips textFiles', () => {
    const raw = {
      text: 'see attached',
      attachments: [],
      textFiles: [{ filename: 'log.txt', content: 'line one\n', bytes: 9 }]
    };
    const draft = normalizeDraft(raw);
    assert(draft.text === 'see attached', `text lost: ${JSON.stringify(draft.text)}`);
    assert(Array.isArray(draft.textFiles) && draft.textFiles.length === 1,
      `textFiles count wrong: ${JSON.stringify(draft.textFiles)}`);
    assert(draft.textFiles[0]?.filename === 'log.txt' && draft.textFiles[0]?.content === 'line one\n',
      `textFiles not faithful: ${JSON.stringify(draft.textFiles)}`);
  });

  await test('normalizeDraft defaults textFiles to [] when absent', () => {
    const draft = normalizeDraft({ text: 'hi' });
    assert(Array.isArray(draft.textFiles) && draft.textFiles.length === 0,
      `expected empty textFiles, got ${JSON.stringify(draft.textFiles)}`);
    const empty = normalizeDraft(null);
    assert(Array.isArray(empty.textFiles) && empty.textFiles.length === 0,
      `null draft must yield empty textFiles, got ${JSON.stringify(empty.textFiles)}`);
  });

  await test('normalizeDraft drops textFile entries without string content', () => {
    const draft = normalizeDraft({
      text: '',
      textFiles: [{ filename: 'a.txt', content: 'ok', bytes: 2 }, { filename: 'b.bin' }]
    });
    assert(draft.textFiles.length === 1, `bad entry should be dropped: ${JSON.stringify(draft.textFiles)}`);
    assert(draft.textFiles[0]?.filename === 'a.txt', 'the valid entry must remain');
  });

  // ── 3. _handleTextFiles guards ────────────────────────────────────────────

  await test('a valid small text file is staged', async () => {
    const { box, container, warnings } = mountComposer();
    try {
      box._handleTextFiles([new window.File(['hello world\n'], 'notes.txt', { type: 'text/plain' })]);
      await waitFor(() => box._pendingTextFiles.length === 1, () => `expected 1 staged text file, got ${box._pendingTextFiles.length}`);
      assert(box._pendingTextFiles[0].filename === 'notes.txt', 'filename must be captured');
      assert(box._pendingTextFiles[0].content === 'hello world\n', 'content must be captured');
      assert(warnings.length === 0, `no warning expected, got ${JSON.stringify(warnings)}`);
    } finally {
      container.remove();
    }
  });

  await test('an oversized file is rejected before any read', async () => {
    const { box, container, warnings } = mountComposer();
    try {
      // 2 GB reported size on a one-byte payload: the size gate must reject it
      // from file.size alone, never calling readAsText.
      box._handleTextFiles([fileWithSize('huge.log', 'x', 2 * 1024 * 1024 * 1024)]);
      await waitFor(() => warnings.length === 1, () => `expected a size warning, got ${JSON.stringify(warnings)}`);
      assert(/too large/i.test(warnings[0] ?? ''), `warning should mention size: ${warnings[0]}`);
      assert(box._pendingTextFiles.length === 0, 'oversized file must not be staged');
    } finally {
      container.remove();
    }
  });

  await test('a binary-looking file is rejected with a warning', async () => {
    const { box, container, warnings } = mountComposer();
    try {
      // A NUL byte is decisive for looksBinary().
      box._handleTextFiles([new window.File(['abc\u0000def'], 'blob.bin', { type: '' })]);
      await waitFor(() => warnings.length === 1, () => `expected a binary warning, got ${JSON.stringify(warnings)}`);
      assert(/text file/i.test(warnings[0] ?? ''), `warning should mention text: ${warnings[0]}`);
      assert(box._pendingTextFiles.length === 0, 'binary file must not be staged');
    } finally {
      container.remove();
    }
  });

  // ── 4. _handleFiles image-size guard (model-aware) ────────────────────────

  await test('an image over the current model\'s per-image limit is rejected', async () => {
    const { box, container, warnings } = mountComposer();
    try {
      stubModel(box, 'anthropic'); // 5 MB per-image limit
      let uploads = 0;
      box._uploadAndAdd = () => { uploads++; };
      box._handleFiles([imageWithSize('big.png', 6 * 1024 * 1024)]);
      assert(warnings.length === 1, `expected one size warning, got ${JSON.stringify(warnings)}`);
      assert(/too large/i.test(warnings[0] ?? ''), `warning should mention size: ${warnings[0]}`);
      assert(/5 MB per image/.test(warnings[0] ?? ''), `warning should state the model's 5 MB limit: ${warnings[0]}`);
      assert(uploads === 0, 'oversized image must not be uploaded');
      assert(box._pendingAttachments.length === 0, 'oversized image must not be staged');
    } finally {
      container.remove();
    }
  });

  await test('an image under the current model\'s limit is accepted', async () => {
    const { box, container, warnings } = mountComposer();
    try {
      stubModel(box, 'anthropic');
      let uploads = 0;
      box._uploadAndAdd = () => { uploads++; };
      box._handleFiles([imageWithSize('ok.png', 3 * 1024 * 1024)]);
      assert(warnings.length === 0, `no warning expected, got ${JSON.stringify(warnings)}`);
      assert(uploads === 1, `expected the image to be uploaded, got ${uploads}`);
    } finally {
      container.remove();
    }
  });

  await test('the limit is model-aware: 6 MB is fine on a provider without a specific cap', async () => {
    const { box, container, warnings } = mountComposer();
    try {
      // The SAME 6 MB image that anthropic rejects is accepted here, because an
      // unmapped provider falls back to the generous upload ceiling (25 MB).
      stubModel(box, 'text-co');
      let uploads = 0;
      box._uploadAndAdd = () => { uploads++; };
      box._handleFiles([imageWithSize('big.png', 6 * 1024 * 1024)]);
      assert(warnings.length === 0, `no warning expected on fallback provider, got ${JSON.stringify(warnings)}`);
      assert(uploads === 1, `expected the image to be uploaded, got ${uploads}`);

      // ...but the fallback ceiling still applies: 30 MB is rejected.
      box._handleFiles([imageWithSize('huge.png', 30 * 1024 * 1024)]);
      assert(warnings.length === 1, `expected the fallback ceiling to reject 30 MB, got ${JSON.stringify(warnings)}`);
      assert(uploads === 1, '30 MB image must not be uploaded');
    } finally {
      container.remove();
    }
  });

  // ── 5. en-XA: what the item shows is UI text, what the model reads is not ──

  await test('under en-XA the item\'s own words are translated and the model\'s text stays English', async () => {
    await underPseudoLocale('dropped-file-test', async () => {
      /** @type {Record<string, string>} */
      const shown = {};
      const context = { id: 'DROP_xa', session: {}, conversation: {}, messageThread: {} };

      // A drop whose name is digits reads as data inside each message.
      const named = new DroppedFileContextItem(/** @type {any} */ (context));
      await named.onToolCall('dropped-file', { filename: '1', content: '2' });
      shown['brief summary, named'] = named.getBriefSummary();
      shown['type name'] = String(/** @type {any} */ (named.getStatusUI()).typeName);

      // The fallbacks drawn when no filename was captured.
      const unnamed = new DroppedFileContextItem(/** @type {any} */ (context));
      unnamed.data = { filename: '', content: '' };
      shown['title, unnamed'] = unnamed.getTitle();
      shown['brief summary, unnamed'] = unnamed.getBriefSummary();
      shown['row, unnamed'] = String(/** @type {any} */ (unnamed.getStatusUI()).summary);
      const emptyPanel = unnamed.createPropertiesPanelElement();
      shownStrings(emptyPanel).forEach((s, i) => { shown[`empty panel ${i}`] = s; });
      unnamed.data = { filename: '', content: '3' };
      const view = /** @type {any} */ (unnamed.createPropertiesPanelElement().querySelector('file-view'));
      assert(view?._source, 'the panel must hand the file view a source');
      shown['panel path, unnamed'] = String(view._source.path);

      // The model's text never follows the UI language.
      /** @type {string[]} */
      const modelProblems = [];
      const defaulted = new DroppedFileContextItem(/** @type {any} */ (context));
      await defaulted.onToolCall('dropped-file', { filename: '', content: '4' });
      if (defaulted.data.filename !== 'dropped file') modelProblems.push(`stored filename ${JSON.stringify(defaulted.data.filename)}`);
      const text = await defaulted.createContextText();
      if (!text.includes('<file path="dropped file">')) modelProblems.push(`context text ${JSON.stringify(text)}`);
      // A draft's text-file snapshot with no name is stored under the name
      // the model reads in `<file path=…>`.
      const stored = normalizeTextFiles([{ content: '6' }])[0]?.filename;
      if (stored !== 'dropped file') modelProblems.push(`draft snapshot filename ${JSON.stringify(stored)}`);
      try {
        await defaulted.onToolCall('dropped-file', { filename: '5' });
        modelProblems.push('no throw for missing content');
      } catch (/** @type {any} */ e) {
        if (e.message !== 'Missing required parameter: content') modelProblems.push(`error ${JSON.stringify(e.message)}`);
      }

      const raw = Object.entries(shown).filter(([, s]) => !isPseudoLocalized(s));
      assert(raw.length === 0 && modelProblems.length === 0,
        `plain English under en-XA: ${JSON.stringify(raw)}; model text changed: ${JSON.stringify(modelProblems)}`);
    }, { '@juggler/core': CORE_TEXT });
  });

  return { passed, failed, errors };
}
