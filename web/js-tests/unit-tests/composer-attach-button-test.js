//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The composer's attach button: where it sits and what it takes.
 *
 * It sits beside Send, where the eye already goes, and it takes any file —
 * routed exactly as the same file dropped on the box would be (images upload,
 * everything else is staged as a text snapshot). The staging itself is
 * covered by `unit:dropped-file`; this suite asserts placement and routing.
 * The touch layout's copy of the button is asserted in `unit:mobile-composer`.
 * @module unit-tests/composer-attach-button-test
 */

import { initializeRegistries, assert } from '../utilities/test-helpers.js';
import '../../js/components/composer.js';

/**
 * Mount a desktop composer-box and bind its listeners synchronously (they are
 * otherwise deferred to a rAF, which a test lane never delivers).
 * @returns {{box: any, container: HTMLElement}} The mounted box and its container.
 */
function mountComposer() {
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:900px;height:600px;';
  const box = /** @type {any} */ (document.createElement('composer-box'));
  box._touchComposerOverride = false;
  container.appendChild(box);
  document.body.appendChild(container);
  box.setupListeners();
  box.setupListeners = () => {};
  return { box, container };
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {(box: any) => void | Promise<void>} fn
   */
  const test = async (name, fn) => {
    const { box, container } = mountComposer();
    try {
      await fn(box);
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      container.remove();
    }
  };

  await test('sits-beside-send', (box) => {
    const btn = /** @type {HTMLElement|null} */ (box.querySelector('#attach-button'));
    assert(!!btn, 'the composer must render an #attach-button');
    const send = box.querySelector('#send-button');
    assert(btn.parentElement?.tagName.toLowerCase() === 'input-controls-send',
      `the attach button must live in the send cluster, got ${btn.parentElement?.tagName}`);
    assert(btn.nextElementSibling === send,
      'the attach button must sit immediately before the send button');
    assert(btn.getBoundingClientRect().width > 0, 'the attach button must be displayed on desktop');
    assert(btn.getAttribute('aria-label') === 'Attach files',
      `the attach button must be labelled "Attach files", got ${btn.getAttribute('aria-label')}`);
  });

  await test('picker-accepts-any-file', (box) => {
    const input = /** @type {HTMLInputElement|null} */ (box.querySelector('.attach-file-input'));
    assert(!!input, 'the composer must render the hidden file input');
    assert(!input.accept, `the picker must not restrict file types, got accept="${input.accept}"`);
    assert(input.multiple, 'the picker must allow several files at once');
  });

  await test('button-opens-picker', (box) => {
    const input = /** @type {HTMLInputElement} */ (box.querySelector('.attach-file-input'));
    let opened = false;
    input.click = () => { opened = true; };
    /** @type {HTMLElement} */ (box.querySelector('#attach-button')).click();
    assert(opened, 'clicking the attach button must open the file picker');
  });

  await test('picked-files-route-like-a-drop', (box) => {
    /** @type {File[]} */
    const images = [];
    /** @type {File[]} */
    const texts = [];
    box._handleFiles = (/** @type {File[]} */ list) => images.push(...Array.from(list));
    box._handleTextFiles = (/** @type {File[]} */ list) => texts.push(...Array.from(list));

    const png = new window.File(['png'], 'shot.png', { type: 'image/png' });
    const txt = new window.File(['notes'], 'notes.txt', { type: 'text/plain' });
    const input = /** @type {HTMLInputElement} */ (box.querySelector('.attach-file-input'));
    // WebKit has no constructible DataTransfer, so a FileList cannot be built;
    // shadow the prototype's accessor on this instance instead.
    Object.defineProperty(input, 'files', { configurable: true, value: [png, txt] });
    input.dispatchEvent(new Event('change', { bubbles: true }));

    assert(images.length === 1 && images[0] === png,
      `a picked image must be uploaded, got ${images.map((f) => f.name).join(', ') || 'nothing'}`);
    assert(texts.length === 1 && texts[0] === txt,
      `a picked non-image must be staged as a text snapshot, got ${texts.map((f) => f.name).join(', ') || 'nothing'}`);
  });

  return { passed, failed, errors };
}
