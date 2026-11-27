//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A video given to the composer — dropped, picked, or dragged in with no type —
 * is staged only for a model that takes video input, by the `inputModalities`
 * its provider publishes. For any other target it is refused up front, with a
 * notice that says the file is a video, which model will not take it, and what
 * to do instead, whatever the file's size. A video staged before the model was
 * switched away blocks the send with the same notice. Audio, which no model
 * here is given, is not refused: it is stored in the project, as any file
 * that yields no text, for the agent to read with its file tools.
 *
 * Driven through a mounted composer's real entry points (`acceptFiles`,
 * `sendMessage`) with the providers list and both uploads (an attachment's
 * and a stored drop's) stubbed, so nothing reaches a server.
 * @module unit-tests/composer-video-attachments-test
 */

import { initializeRegistries, assert, waitFor } from '../utilities/test-helpers.js';
import { underPseudoLocale } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import providersCache from '../../js/services/providers-cache.js';
import apiService from '../../js/services/api.js';
import fileViewerRegistry from '../../js/registries/file-viewer-registry.js';
import { renderAttachmentChips } from '../../js/components/composer-attachments.js';
import '../../js/components/composer.js';

/**
 * A provider entry as `providersCache` holds it.
 * @param {string} name
 * @param {string} id
 * @param {string} displayName
 * @param {string[]} inputModalities
 * @returns {any} The provider.
 */
function providerWith(name, id, displayName, inputModalities) {
  return { name, displayName: name, available: true, modelsWithContext: [{ id, displayName, inputModalities }] };
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
 * Mount a composer-box whose send target is `modelConfig` (null: automatic),
 * against `providers`, recording its notices, uploads (attachments), drops
 * (files stored in the project) and sends.
 * @param {any} modelConfig
 * @param {any[]} providers
 * @returns {{box: any, warnings: string[], uploads: File[], drops: File[], sent: any[], done: () => void}} The box, what it did, and the teardown.
 */
function mount(modelConfig, providers) {
  const realGet = providersCache.get;
  const realUpload = apiService.uploadAsset;
  const realDrop = apiService.uploadDrop;
  providersCache.get = () => providers;
  /** @type {File[]} */
  const uploads = [];
  apiService.uploadAsset = async (/** @type {string} */ _conv, /** @type {File} */ file) => {
    uploads.push(file);
    return { id: `asset-${uploads.length}`, mime: file.type, filename: file.name, bytes: file.size, width: 0, height: 0 };
  };
  /** @type {File[]} */
  const drops = [];
  apiService.uploadDrop = async (/** @type {string} */ _conv, /** @type {File} */ file) => {
    drops.push(file);
    return { filename: file.name, path: `.juggler-drops/ab/${file.name}`, absPath: `/p/.juggler-drops/ab/${file.name}`, bytes: file.size };
  };

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:900px;height:600px;';
  const box = /** @type {any} */ (document.createElement('composer-box'));
  box.isCoarsePointer = () => false;
  container.appendChild(box);
  document.body.appendChild(container);
  box.setupListeners();
  box.setupListeners = () => {};
  /** @type {string[]} */
  const warnings = [];
  box.showWarning = (/** @type {string} */ m) => { warnings.push(m); };
  box._conversation = { id: 'conv-1', modelConfig, isTurnActive: () => false, unobserveMetadata() {} };
  box._messageThread = {
    getContextItems: () => [],
    getEffectiveModelConfig: () => modelConfig,
    sendWillQueue: false,
    executeContextItem: async () => {},
    executeContextItemIntoPending: async () => {},
  };
  /** @type {any[]} */
  const sent = [];
  container.addEventListener('send-message', (e) => sent.push(/** @type {CustomEvent} */ (e).detail));
  const done = () => {
    providersCache.get = realGet;
    apiService.uploadAsset = realUpload;
    apiService.uploadDrop = realDrop;
    container.remove();
  };
  return { box, warnings, uploads, drops, sent, done };
}

const TEXT_ONLY = providerWith('openai', 'gpt-x', 'GPT X', ['text', 'image']);
const WATCHES = providerWith('vidco', 'watcher', 'Watcher 2', ['text', 'image', 'video']);

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  await initializeRegistries();
  // The media viewer is what claims an audio file, as it does in the app.
  await fileViewerRegistry.ensureInitialized();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

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
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * Give `files` to a composer aimed at `modelConfig` and return the one
   * notice it raised, having checked nothing was staged or uploaded.
   * @param {any} modelConfig
   * @param {any[]} providers
   * @param {File[]} files
   * @returns {Promise<string>} The notice.
   */
  const refusal = async (modelConfig, providers, files) => {
    const { box, warnings, uploads, drops, done } = mount(modelConfig, providers);
    try {
      box.acceptFiles(files);
      await waitFor(() => warnings.length > 0, () => 'the video raised no notice');
      assert(warnings.length === 1, `one notice per video, got ${JSON.stringify(warnings)}`);
      assert(uploads.length === 0, `a refused video was uploaded: ${uploads.map((f) => f.name)}`);
      assert(drops.length === 0, `a refused video was stored in the project: ${drops.map((f) => f.name)}`);
      assert(box._pendingAttachments.length === 0 && box._pendingTextFiles.length === 0,
        'a refused video was staged');
      return warnings[0] || '';
    } finally {
      done();
    }
  };

  await run('a video for a model without video input is refused, naming the model', async () => {
    const notice = await refusal({ provider: 'openai', model: 'gpt-x' }, [TEXT_ONLY],
      [new window.File(['x'], 'clip.mov', { type: 'video/quicktime' })]);
    assert(notice.includes('"clip.mov" is a video') && notice.includes('GPT X') && notice.includes('screenshots'),
      `the notice must say the file is a video, name the model and offer screenshots: ${notice}`);
  });

  await run('the refusal holds at any size', async () => {
    const notice = await refusal({ provider: 'openai', model: 'gpt-x' }, [TEXT_ONLY],
      [fileWithSize('big.mov', 'video/quicktime', 150 * 1024 * 1024)]);
    assert(notice.includes('"big.mov" is a video') && !notice.includes('too large'),
      `a large video must get the video refusal, not a size one: ${notice}`);
  });

  await run('a video with no type is known by its extension', async () => {
    const notice = await refusal({ provider: 'openai', model: 'gpt-x' }, [TEXT_ONLY],
      [new window.File(['x'], 'rec.mp4', { type: '' })]);
    assert(notice.includes('"rec.mp4" is a video'), `an untyped .mp4 must be treated as a video: ${notice}`);
  });

  await run('the refusal names a model that does take video', async () => {
    const notice = await refusal({ provider: 'openai', model: 'gpt-x' }, [TEXT_ONLY, WATCHES],
      [new window.File(['x'], 'clip.webm', { type: 'video/webm' })]);
    assert(notice.includes('GPT X') && notice.includes('Watcher 2'),
      `the notice must name the target and the model to switch to: ${notice}`);
  });

  await run('an automatic model is refused', async () => {
    const lone = await refusal(null, [TEXT_ONLY], [new window.File(['x'], 'a.mov', { type: 'video/quicktime' })]);
    assert(lone.includes('"a.mov" is a video') && !lone.includes('GPT X'),
      `an automatic target must be refused without naming a model it may not use: ${lone}`);
    const offered = await refusal(null, [TEXT_ONLY, WATCHES], [new window.File(['x'], 'b.mov', { type: 'video/quicktime' })]);
    assert(offered.includes('Watcher 2'), `an automatic target must be offered the model that takes video: ${offered}`);
  });

  await run('a model that takes video is sent it, past the image size limits', async () => {
    const { box, warnings, uploads, done } = mount({ provider: 'vidco', model: 'watcher' }, [WATCHES]);
    try {
      box.acceptFiles([fileWithSize('clip.mov', 'video/quicktime', 59 * 1024 * 1024)]);
      await waitFor(() => box._pendingAttachments.some((/** @type {any} */ a) => a.id), () => `nothing staged; ${JSON.stringify(warnings)}`);
      assert(warnings.length === 0, `the video was refused: ${JSON.stringify(warnings)}`);
      assert(uploads.length === 1 && uploads[0]?.type === 'video/quicktime', 'the video must be uploaded as itself');
      const chips = box.querySelector('composer-box-attachments');
      assert(!!chips?.querySelector('.attachment-chip.video') && !chips.querySelector('img'),
        'a staged video must show a video chip, not an image thumbnail');
    } finally {
      done();
    }
  });

  await run('a video staged before the model changed blocks the send', async () => {
    const { box, warnings, sent, done } = mount({ provider: 'openai', model: 'gpt-x' }, [TEXT_ONLY]);
    try {
      box._pendingAttachments = [{ id: 'v1', mime: 'video/mp4', filename: 'clip.mp4', bytes: 10, width: 0, height: 0 }];
      /** @type {HTMLTextAreaElement} */ (box.querySelector('textarea')).value = 'what breaks?';
      const result = await box.sendMessage();
      assert(result === 'video not accepted', `the send must be blocked, got ${JSON.stringify(result)}`);
      assert(sent.length === 0, 'a blocked send dispatched');
      const [warning = ''] = warnings;
      assert(warnings.length === 1 && warning.includes('"clip.mp4" is a video') && warning.includes('GPT X'),
        `the block must explain itself: ${JSON.stringify(warnings)}`);
      assert(box._pendingAttachments.length === 1, 'the blocked video must stay staged');
    } finally {
      done();
    }
  });

  await run('audio is stored in the project for the agent, not refused', async () => {
    const { box, warnings, uploads, drops, done } = mount({ provider: 'openai', model: 'gpt-x' }, [TEXT_ONLY]);
    try {
      box.acceptFiles([new window.File(['x'], 'memo.mp3', { type: 'audio/mpeg' })]);
      await waitFor(() => box._pendingTextFiles.some((/** @type {any} */ e) => e.path && !e._uploading) || warnings.length > 0,
        () => `nothing stored; staged ${JSON.stringify(box._pendingTextFiles)}`);
      assert(warnings.length === 0, `the audio was refused: ${JSON.stringify(warnings)}`);
      assert(drops.length === 1 && drops[0]?.name === 'memo.mp3', `stored drops ${JSON.stringify(drops.map((f) => f.name))}`);
      assert(uploads.length === 0 && box._pendingAttachments.length === 0, 'the audio was attached as media for a model that takes none');
      const [staged] = box._pendingTextFiles;
      assert(box._pendingTextFiles.length === 1 && staged.content === undefined && staged.absPath === '/p/.juggler-drops/ab/memo.mp3',
        `the audio must be staged by its path in the project, not as content: ${JSON.stringify(box._pendingTextFiles)}`);
    } finally {
      done();
    }
  });

  await run('en-XA: every refusal and the video chip draw no plain English', async () => {
    await underPseudoLocale('composer-video-attachments-test', async () => {
      // Digits only outside the message — names included, the types say what
      // each file is — so any letter is the message's own.
      const one = providerWith('1', '2', '3', ['text']);
      const two = providerWith('4', '5', '6', ['text', 'video']);
      const notices = [
        await refusal({ provider: '1', model: '2' }, [one], [new window.File(['x'], '7', { type: 'video/quicktime' })]),
        await refusal({ provider: '1', model: '2' }, [one, two], [new window.File(['x'], '8', { type: 'video/quicktime' })]),
        await refusal(null, [one], [new window.File(['x'], '9', { type: 'video/quicktime' })]),
        await refusal(null, [one, two], [new window.File(['x'], '10', { type: 'video/quicktime' })]),
        // For a model that takes video: a format the store keeps no copy of,
        // and a video past the size limit.
        await refusal({ provider: '4', model: '5' }, [two], [new window.File(['x'], '12', { type: 'video/x-msvideo' })]),
        await refusal({ provider: '4', model: '5' }, [two], [fileWithSize('13', 'video/quicktime', 150 * 1024 * 1024)]),
      ];
      const plain = notices.filter((n) => !isPseudoLocalized(n));
      assert(plain.length === 0, `plain English under en-XA: ${JSON.stringify(plain)}`);

      const { box, done } = mount({ provider: '4', model: '5' }, [two]);
      try {
        box._pendingAttachments = [{ id: 'v', mime: 'video/mp4', filename: '', bytes: 1, width: 0, height: 0 }];
        renderAttachmentChips(box);
        const name = box.querySelector('.attachment-chip.video .attachment-name')?.textContent || '';
        assert(isPseudoLocalized(name), `the nameless video chip's fallback is plain English: ${JSON.stringify(name)}`);
      } finally {
        done();
      }
    });
  });

  return { passed, failed, errors };
}
