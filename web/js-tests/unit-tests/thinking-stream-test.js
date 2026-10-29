//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: streaming thinking block in the properties panel.
 *
 * When a thinking block streams in, the properties-panel renderer registers a
 * live-updater closure that re-renders the content as it grows. Three
 * behaviours are asserted here:
 *
 *  1. Re-renders are COALESCED onto a single requestAnimationFrame, so a burst
 *     of streaming deltas within one frame collapses to one render showing the
 *     latest text. (What that render costs is the streaming renderer's job, and
 *     is asserted in streaming-markdown-test.)
 *  2. The scroll container STICKS TO THE BOTTOM so the user can watch the tail
 *     stream without scrolling — but stops following the moment the user
 *     scrolls up to read back, and resumes once they return to the bottom.
 *  3. Markdown rendering is CONDITIONAL. One provider summarises its reasoning
 *     as Markdown, the next streams raw prose, and both arrive as the same item
 *     type; rendering prose as Markdown reflows it into the sans font and eats
 *     stray `*`/`_`/`#` as formatting. Text with no Markdown construct is shown
 *     verbatim instead, and the choice is re-made as the block grows.
 *
 * The viewer schedules the re-render on requestAnimationFrame; the test-pool
 * window is hidden, where rAF is throttled and never fires. We shim it for the
 * duration of the test with a frame the test runs itself, so the coalesced
 * flush happens exactly where the test says the frame is (production keeps the
 * real rAF).
 * @module unit-tests/thinking-stream-test
 */

import { assert } from '../utilities/test-helpers.js';
import { renderMessage } from '../../js/services/renderers/item-renderers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * @param {object} _ctx
 * @returns {Promise<TestResult>} Aggregated results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => (void | Promise<void>)} fn
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Shim requestAnimationFrame so the renderer's coalesced flush runs in the
  // hidden test window. The renderer reads the bare global, so reassigning the
  // window property redirects it. A requested frame runs when the test calls
  // flushFrame(), as a paint would; anything else on the page that asks for one
  // in the meantime still gets it, on the next macrotask.
  const realRaf = window.requestAnimationFrame;
  const realCaf = window.cancelAnimationFrame;
  /** @type {Map<number, {cb: FrameRequestCallback, timer: ReturnType<typeof setTimeout>}>} */
  const pendingFrames = new Map();
  let nextFrameId = 1;
  /** @param {number} id */
  const runFrame = (id) => {
    const frame = pendingFrames.get(id);
    if (!frame) return;
    clearTimeout(frame.timer);
    pendingFrames.delete(id);
    frame.cb(performance.now());
  };
  window.requestAnimationFrame = (/** @type {FrameRequestCallback} */ cb) => {
    const id = nextFrameId++;
    pendingFrames.set(id, { cb, timer: setTimeout(() => runFrame(id), 0) });
    return id;
  };
  window.cancelAnimationFrame = (/** @type {number} */ id) => {
    const frame = pendingFrames.get(id);
    if (frame) { clearTimeout(frame.timer); pendingFrames.delete(id); }
  };
  /** Run the frame: every callback requested before it, in order. */
  const flushFrame = () => {
    for (const id of [...pendingFrames.keys()]) runFrame(id);
  };

  // Minimal PanelHost: a thinking render only needs a scrollable section
  // wrapper, a controls element, and a slot to receive the live-updater.
  const makeHost = () => ({
    _conversation: null,
    _messageThread: null,
    _selectedItemId: 'think-1',
    /** @type {(() => boolean) | null} */
    _liveUpdater: null,
    _createSectionWithControls: () => document.createElement('properties-panel-section'),
    _renderMessageControls: () => document.createElement('properties-panel-controls'),
  });

  /**
   * @param {string} initial - Initial thinking content.
   * @returns {{ get: (k: string) => any, setContent: (c: string) => void }} Fake thinking message.
   */
  const makeMessage = (initial) => {
    let content = initial;
    return {
      setContent: (/** @type {string} */ c) => { content = c; },
      get: (/** @type {string} */ k) => (k === 'type' ? 'thinking' : k === 'content' ? content : undefined),
    };
  };

  const mount = () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    return container;
  };

  /**
   * @param {string} marker - Token embedded in each line.
   * @param {number} lines - Number of lines to generate.
   * @returns {string} Multi-paragraph text long enough to overflow the section.
   */
  const longText = (marker, lines) =>
    Array.from({ length: lines }, (_, i) => `${marker} line ${i}`).join('\n\n');

  /**
   * The body element the renderer writes into, whichever mode it chose.
   * @param {HTMLElement} container - Mounted render target.
   * @returns {HTMLElement} The `.markdown` or `.plain` block.
   */
  const bodyOf = (container) =>
    /** @type {HTMLElement} */ (container.querySelector('.markdown, .plain'));

  try {
    await run('streaming deltas defer and coalesce to one render of the latest text', async () => {
      const container = mount();
      try {
        const host = makeHost();
        const msg = makeMessage('ALPHA');
        renderMessage(/** @type {any} */ (host), container, msg);

        const md = bodyOf(container);
        assert(md && md.textContent.includes('ALPHA'), 'initial render shows ALPHA');
        assert(typeof host._liveUpdater === 'function', 'thinking render registers a live updater');

        // A burst of synchronous updates within one frame.
        msg.setContent('OMEGA-1'); host._liveUpdater();
        msg.setContent('OMEGA-2'); host._liveUpdater();
        msg.setContent('OMEGA-FINAL'); host._liveUpdater();

        // Deferred — nothing rendered synchronously.
        assert(!md.textContent.includes('OMEGA'), 'updates are deferred, not rendered per-call');
        assert(md.textContent.includes('ALPHA'), 'old content still shown before the frame');

        flushFrame();
        assert(md.textContent.includes('OMEGA-FINAL'), 'after the frame, the latest content is rendered');
        assert(!md.textContent.includes('ALPHA'), 'old content was replaced');
      } finally { container.remove(); }
    });

    await run('auto-scrolls to follow the streaming tail', async () => {
      const container = mount();
      try {
        const host = makeHost();
        const msg = makeMessage('start');
        renderMessage(/** @type {any} */ (host), container, msg);

        const section = /** @type {HTMLElement} */ (container.querySelector('properties-panel-section'));
        section.style.cssText = 'display:block;height:80px;overflow-y:auto';

        msg.setContent(longText('THINK', 80));
        /** @type {any} */ (host._liveUpdater)();
        flushFrame();

        assert(section.scrollHeight > section.clientHeight, 'content overflows the section');
        const dist = section.scrollHeight - section.clientHeight - section.scrollTop;
        assert(dist <= 2, `expected pinned to bottom, was ${dist}px from bottom`);
      } finally { container.remove(); }
    });

    await run('stops following when the user scrolls up, resumes at the bottom', async () => {
      const container = mount();
      try {
        const host = makeHost();
        const msg = makeMessage('start');
        renderMessage(/** @type {any} */ (host), container, msg);

        const section = /** @type {HTMLElement} */ (container.querySelector('properties-panel-section'));
        section.style.cssText = 'display:block;height:80px;overflow-y:auto';

        msg.setContent(longText('A', 80));
        /** @type {any} */ (host._liveUpdater)();
        flushFrame();

        // User scrolls up to read back → following disengages.
        section.scrollTop = 0;
        section.dispatchEvent(new Event('scroll'));

        msg.setContent(longText('B', 160));
        /** @type {any} */ (host._liveUpdater)();
        flushFrame();
        assert(section.scrollTop <= 4, `must not yank the user back to the bottom (scrollTop=${section.scrollTop})`);

        // User returns to the bottom → following resumes.
        section.scrollTop = section.scrollHeight;
        section.dispatchEvent(new Event('scroll'));

        msg.setContent(longText('C', 240));
        /** @type {any} */ (host._liveUpdater)();
        flushFrame();
        const dist = section.scrollHeight - section.clientHeight - section.scrollTop;
        assert(dist <= 2, `expected re-pinned to bottom, was ${dist}px from bottom`);
      } finally { container.remove(); }
    });

    await run('raw reasoning is shown verbatim, a Markdown summary is rendered', async () => {
      const container = mount();
      try {
        // Raw chain-of-thought, as GLM/DeepSeek/Anthropic stream it: the `*` is
        // arithmetic and the underscores are an identifier, not emphasis.
        const raw = 'Weighing 2 * 3 against foo_bar_baz before the #1 case.';
        renderMessage(/** @type {any} */ (makeHost()), container, makeMessage(raw));

        const body = bodyOf(container);
        assert(body.className === 'plain', `prose must not be parsed as Markdown (was "${body.className}")`);
        assert(body.textContent === raw, `verbatim text expected, got "${body.textContent}"`);
        assert(!body.querySelector('em, strong'), 'no emphasis may be invented from stray punctuation');
        assert(
          !!container.querySelector('.properties-panel-thinking'),
          'the body carries the thinking class the panel styles hang off'
        );
      } finally { container.remove(); }
    });

    await run('a summary that only turns Markdown mid-stream switches then', async () => {
      const container = mount();
      try {
        const host = makeHost();
        const msg = makeMessage('Considering the two options.');
        renderMessage(/** @type {any} */ (host), container, msg);
        assert(bodyOf(container).className === 'plain', 'opens as verbatim prose');

        // The reasoning summary's first bold title arrives.
        msg.setContent('Considering the two options.\n\n**Checking the flag**\n\nIt is set.');
        /** @type {any} */ (host._liveUpdater)();
        flushFrame();

        const body = bodyOf(container);
        assert(body.className === 'markdown', `expected a switch to Markdown, was "${body.className}"`);
        assert(!!body.querySelector('strong'), 'the title renders as a title');
        assert(!body.textContent.includes('**'), 'the markers are consumed, not shown');
      } finally { container.remove(); }
    });
  } finally {
    window.requestAnimationFrame = realRaf;
    window.cancelAnimationFrame = realCaf;
  }

  return { passed, failed, errors };
}
