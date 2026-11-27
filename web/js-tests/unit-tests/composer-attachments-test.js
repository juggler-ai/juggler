//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for the composer's attachment staging
 * (`components/composer-attachments.js`): every refusal notice it raises and
 * everything the chip row draws follows the UI language.
 *
 * The functions are driven against a stand-in composer that records its
 * warnings, so nothing is mounted and no real upload happens. File names are
 * digits (data), which keeps each notice letter-free outside its message.
 * @module unit-tests/composer-attachments-test
 */

import {
  handleFiles, handleTextFiles, uploadAndAdd, renderAttachmentChips,
} from '../../js/components/composer-attachments.js';
import apiService from '../../js/services/api.js';
import { HttpError } from '../../js/services/http.js';
import fileViewerRegistry from '../../js/registries/file-viewer-registry.js';
import { normalizeTextFiles } from '../../js/utils/attachments.js';
import { pdfBytes, PDF_TEXT } from '../utilities/pdf-fixture.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { assert, waitFor } from '../utilities/test-helpers.js';
import { underPseudoLocale, assertPseudoLocalized } from '../utilities/pseudo-locale.js';

/**
 * A stand-in composer: the fields and methods the module reaches through.
 * @returns {{composer: any, container: HTMLElement, warnings: string[]}} The composer, its chip row, and the notices it was asked to show.
 */
function fakeComposer() {
  const container = document.createElement('div');
  /** @type {string[]} */
  const warnings = [];
  const composer = {
    _pendingAttachments: /** @type {any[]} */ ([]),
    _pendingTextFiles: /** @type {any[]} */ ([]),
    _conversation: /** @type {any} */ (null),
    showWarning: (/** @type {string} */ m) => { warnings.push(m); },
    querySelector: (/** @type {string} */ sel) => (sel === 'composer-box-attachments' ? container : null),
    _updateSendButtonState() {},
    _persistDraft() {},
    _uploadAndAdd() {},
  };
  return { composer, container, warnings };
}

/**
 * A File whose reported `size` is overridden without allocating the bytes.
 * @param {string} name
 * @param {string} type
 * @param {number} size
 * @returns {File} The file.
 */
function fileWithSize(name, type, size) {
  const file = new window.File(['1'], name, { type });
  Object.defineProperty(file, 'size', { value: size, configurable: true });
  return file;
}

/**
 * Run the composer-attachments test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  /** @type {string[]} */
  const errors = [];
  let passed = 0;
  let failed = 0;

  /**
   * @param {string} name
   * @param {() => Promise<void>} fn
   */
  const run = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? `${e.message}\n${e.stack}` : String(e)}`);
    }
  };

  // A drop delivers bytes and no path, so a binary file a viewer can read — a
  // PDF — is extracted in the composer and staged as that viewer's model-facing
  // text, the same text an @-mention of the file gives the model. Read as text,
  // it would be refused as "doesn't look like a text file".
  await run('a dropped PDF is staged as its extracted text', async () => {
    await fileViewerRegistry.ensureInitialized();
    const { composer, warnings } = fakeComposer();
    handleTextFiles(composer, [new window.File([pdfBytes()], '1.pdf', { type: 'application/pdf' })]);
    await waitFor(() => composer._pendingTextFiles.length === 1 || warnings.length > 0,
      () => `nothing staged; warnings ${JSON.stringify(warnings)}`);
    assert(warnings.length === 0, `the drop was refused: ${JSON.stringify(warnings)}`);
    const [staged] = composer._pendingTextFiles;
    assert(staged.extracted === true, `the snapshot should be marked extracted: ${JSON.stringify(staged)}`);
    assert(staged.content.includes(PDF_TEXT) && staged.content.includes('<file path="1.pdf">'),
      `the snapshot should be the viewer's extraction: ${JSON.stringify(staged.content)}`);
    // The mark survives the draft round-trip, or a reload would wrap the text twice.
    const [restored] = /** @type {import('../../js/utils/attachments.js').TextFileSnapshot[]} */ (normalizeTextFiles([{ ...staged }]));
    assert(restored?.extracted === true, `the draft dropped the extracted mark: ${JSON.stringify(restored)}`);
  });

  // A drop too large to inline, or that is not text, is uploaded to the
  // project and staged as the path it was stored at — never refused, and an
  // oversized one never read.
  for (const [what, file] of /** @type {Array<[string, File]>} */ ([
    ['past the inline cap, from its size alone', fileWithSize('12.log', 'text/plain', 2 * 1024 * 1024 * 1024)],
    ['that looks binary', new window.File(['1\u00002'], '13.bin', { type: '' })],
  ])) {
    await run(`a drop ${what} is stored in the project`, async () => {
      const { composer, warnings } = fakeComposer();
      composer._conversation = { id: '14' };
      const RealReader = window.FileReader;
      let reads = 0;
      /** Counts reads, delegating to the real reader. */
      class CountingReader extends RealReader {
        /** @param {Blob} blob */
        readAsText(blob) { reads++; super.readAsText(blob); }
      }
      const realUpload = apiService.uploadDrop;
      /** @type {string[]} */
      const calls = [];
      apiService.uploadDrop = async (convId, f) => {
        calls.push(`${convId}/${f instanceof window.File ? f.name : ''}`);
        return { filename: file.name, path: `.juggler-drops/ab/${file.name}`, absPath: `/p/.juggler-drops/ab/${file.name}`, bytes: file.size };
      };
      window.FileReader = CountingReader;
      try {
        handleTextFiles(composer, [file]);
        await waitFor(() => composer._pendingTextFiles.some((/** @type {any} */ e) => e.path && !e._uploading) || warnings.length > 0,
          () => `nothing stored; staged ${JSON.stringify(composer._pendingTextFiles)}`);
      } finally {
        window.FileReader = RealReader;
        apiService.uploadDrop = realUpload;
      }
      assert(warnings.length === 0, `the drop was refused: ${JSON.stringify(warnings)}`);
      assert(calls.length === 1 && calls[0] === `14/${file.name}`, `upload calls ${JSON.stringify(calls)}`);
      const [staged] = composer._pendingTextFiles;
      assert(staged.content === undefined && staged.absPath === `/p/.juggler-drops/ab/${file.name}`,
        `the staged drop must carry its path, not content: ${JSON.stringify(staged)}`);
      if (file.size > 1024 * 1024) assert(reads === 0, `an oversized drop was read ${reads} time(s)`);
    });
  }

  // The remote link answers a body past its cap with a 413 of its own, with no
  // message from the server: the user is told the connection is the limit, and
  // nothing stays staged.
  await run('a drop the connection refuses is not staged', async () => {
    const { composer, warnings } = fakeComposer();
    composer._conversation = { id: '15' };
    const realUpload = apiService.uploadDrop;
    apiService.uploadDrop = async () => { throw new HttpError('HTTP 413', 413, 'request body too large'); };
    try {
      handleTextFiles(composer, [fileWithSize('16.log', 'text/plain', 64 * 1024 * 1024)]);
      await waitFor(() => warnings.length === 1, () => `expected a size notice, got ${JSON.stringify(warnings)}`);
    } finally {
      apiService.uploadDrop = realUpload;
    }
    assert(/connection/.test(warnings[0] ?? '') && (warnings[0] ?? '').includes('16.log'), `notice ${JSON.stringify(warnings[0])}`);
    assert(composer._pendingTextFiles.length === 0, `a refused drop stayed staged: ${JSON.stringify(composer._pendingTextFiles)}`);
  });

  await run('en-XA: every notice and chip draws no plain English', async () => {
    await underPseudoLocale('composer-attachments-test', async () => {
      /** @type {string[]} */
      const notices = [];
      /** @type {string[]} */
      const problems = [];

      // Image over the per-image cap.
      {
        const { composer, warnings } = fakeComposer();
        handleFiles(composer, [fileWithSize('1', 'image/png', 30 * 1024 * 1024)]);
        assert(warnings.length === 1, `per-image refusal: ${JSON.stringify(warnings)}`);
        notices.push(...warnings);
      }
      // Images over the per-message aggregate.
      {
        const { composer, warnings } = fakeComposer();
        composer._pendingAttachments = [{ bytes: 50 * 1024 * 1024 }];
        handleFiles(composer, [fileWithSize('2', 'image/png', 10)]);
        assert(warnings.length === 1, `aggregate image refusal: ${JSON.stringify(warnings)}`);
        notices.push(...warnings);
      }
      // A text file over the per-file cap goes to the drop upload, which
      // needs a conversation.
      {
        const { composer, warnings } = fakeComposer();
        handleTextFiles(composer, [fileWithSize('3', 'text/plain', 2 * 1024 * 1024)]);
        assert(warnings.length === 1, `stored-drop refusal: ${JSON.stringify(warnings)}`);
        notices.push(...warnings);
      }
      // A drop the connection refuses as too large.
      {
        const { composer, warnings } = fakeComposer();
        composer._conversation = { id: '4' };
        const realUpload = apiService.uploadDrop;
        apiService.uploadDrop = async () => { throw Object.assign(new Error('5'), { status: 413 }); };
        try {
          handleTextFiles(composer, [fileWithSize('5', 'text/plain', 2 * 1024 * 1024)]);
          await waitFor(() => warnings.length === 1, () => `413 refusal: ${JSON.stringify(warnings)}`);
        } finally {
          apiService.uploadDrop = realUpload;
        }
        notices.push(...warnings);
      }
      // A drop upload that fails, and the uploading chip's tooltip.
      {
        const { composer, container, warnings } = fakeComposer();
        composer._conversation = { id: '6' };
        const realUpload = apiService.uploadDrop;
        /** @type {(e: Error) => void} */
        let fail = () => {};
        apiService.uploadDrop = () => new Promise((_resolve, reject) => { fail = reject; });
        try {
          handleTextFiles(composer, [fileWithSize('7', 'text/plain', 2 * 1024 * 1024)]);
          const tip = container.querySelector('.attachment-chip.uploading')?.getAttribute('title') || '';
          if (!isPseudoLocalized(tip)) problems.push(`uploading chip title ${JSON.stringify(tip)}`);
          fail(new Error('8'));
          await waitFor(() => warnings.length === 1, () => `upload failure: ${JSON.stringify(warnings)}`);
        } finally {
          apiService.uploadDrop = realUpload;
        }
        notices.push(...warnings);
      }
      // A read that fails.
      {
        const { composer, warnings } = fakeComposer();
        const RealReader = window.FileReader;
        /** Reader stand-in whose every read fails. */
        class FailingReader {
          constructor() {
            /** @type {(() => void)|null} */
            this.onerror = null;
            /** @type {(() => void)|null} */
            this.onload = null;
            this.result = null;
          }

          readAsText() { setTimeout(() => this.onerror?.(), 0); }
        }
        window.FileReader = /** @type {any} */ (FailingReader);
        try {
          handleTextFiles(composer, [new window.File(['1'], '7', { type: 'text/plain' })]);
          await waitFor(() => warnings.length === 1, () => `read failure: ${JSON.stringify(warnings)}`);
        } finally {
          window.FileReader = RealReader;
        }
        notices.push(...warnings);
      }
      // An upload with no conversation.
      {
        const { composer, warnings } = fakeComposer();
        await uploadAndAdd(composer, new window.File(['1'], '8', { type: 'image/png' }));
        assert(warnings.length === 1, `no-conversation refusal: ${JSON.stringify(warnings)}`);
        notices.push(...warnings);
      }
      // An upload that fails.
      {
        const { composer, warnings } = fakeComposer();
        composer._conversation = { id: '9' };
        const realUpload = apiService.uploadAsset;
        apiService.uploadAsset = async () => { throw new Error('10'); };
        try {
          await uploadAndAdd(composer, new window.File(['1'], '11', { type: 'image/png' }));
        } finally {
          apiService.uploadAsset = realUpload;
        }
        assert(warnings.length === 1, `upload failure: ${JSON.stringify(warnings)}`);
        notices.push(...warnings);
      }
      for (const n of notices) if (!isPseudoLocalized(n)) problems.push(`notice ${JSON.stringify(n)}`);

      // The chip row: an image and a text file, each with no name (the fallbacks).
      const { composer, container } = fakeComposer();
      composer._pendingAttachments = [{ id: '', filename: '', bytes: 1 }];
      composer._pendingTextFiles = [{ filename: '', content: '1', bytes: 1 }];
      renderAttachmentChips(composer);
      const removes = [...container.querySelectorAll('.attachment-remove')];
      assert(removes.length === 2, `expected two remove buttons, got ${removes.length}`);
      for (const r of removes) {
        const label = r.getAttribute('aria-label') || '';
        if (!isPseudoLocalized(label)) problems.push(`remove aria-label ${JSON.stringify(label)}`);
      }
      try {
        // The × glyph is a lone symbol, so the remove buttons are checked above.
        assertPseudoLocalized(container, { skip: '.attachment-remove', atLeast: 2, where: 'chips' });
      } catch (e) {
        problems.push(e instanceof Error ? e.message : String(e));
      }

      assert(problems.length === 0, `plain English under en-XA: ${problems.join('; ')}`);
    });
  });

  return { passed, failed, errors };
}
