//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Every button in the app presses the same way (`js/utils/press-feedback.js`):
 * a quick dip sized to the button, then a spring back on release.
 *
 *   1. A press dips an icon button further than a wide one, so both move by
 *      about the same few pixels.
 *   2. A release springs back: from the dip, past rest, to rest.
 *   3. A disabled button, a non-button, and anything under data-press="none"
 *      do not move.
 *   4. A key press dips a focused button as a pointer press does.
 *   5. No stylesheet gives a button a press of its own, which would double the
 *      dip or fight the spring.
 *
 * The animations are read from `getAnimations()`, which holds them whether or
 * not the lane paints.
 * @module unit-tests/press-feedback-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import { budgetFor } from '../utilities/test-deadline.js';
import { installPressFeedback, PRESS_ANIMATION_ID, RELEASE_ANIMATION_ID } from '../../js/utils/press-feedback.js';

/**
 * @param {Element} el
 * @param {string} id
 * @returns {Animation|undefined} The element's running animation with that id.
 */
function animationOf(el, id) {
  return el.getAnimations().find((a) => a.id === id);
}

/**
 * @param {Animation} animation
 * @returns {number[]} The `scale` of each of its keyframes.
 */
function scales(animation) {
  const effect = /** @type {KeyframeEffect} */ (animation.effect);
  return effect.getKeyframes().map((k) => parseFloat(String(k.scale)));
}

/**
 * @param {HTMLElement} el
 * @param {string} type
 */
function point(el, type) {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, isPrimary: true, pointerType: 'mouse' }));
}

/**
 * Run the press-feedback suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {(host: HTMLElement) => Promise<void>} fn
   */
  const run = async (name, fn) => {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-9999px;top:0;';
    document.body.appendChild(host);
    const dispose = installPressFeedback();
    try {
      await fn(host);
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      dispose();
      host.remove();
    }
  };

  /**
   * @param {HTMLElement} host
   * @param {string} markup
   * @returns {HTMLElement} The first element the markup makes.
   */
  const make = (host, markup) => {
    host.innerHTML = markup;
    return /** @type {HTMLElement} */ (host.firstElementChild);
  };

  await run('a press dips a button by its size', async (/** @type {HTMLElement} */ host) => {
    const icon = make(host, '<button style="width:32px;height:32px;padding:0"></button>');
    point(icon, 'pointerdown');
    const iconPress = animationOf(icon, PRESS_ANIMATION_ID);
    assert(!!iconPress, 'pressing an icon button starts its dip');
    const iconDip = scales(/** @type {Animation} */ (iconPress)).at(-1) ?? 1;
    assert(iconDip > 0.85 && iconDip < 0.9, `an icon button dips to about 0.88, got ${iconDip}`);
    point(icon, 'pointerup');

    const wide = make(host, '<button style="width:200px;height:32px;padding:0">Approve</button>');
    point(wide, 'pointerdown');
    const wideDip = scales(/** @type {Animation} */ (animationOf(wide, PRESS_ANIMATION_ID))).at(-1) ?? 1;
    assert(wideDip > 0.97 && wideDip < 1, `a wide button dips only a little, got ${wideDip}`);
    point(wide, 'pointerup');
  });

  await run('a release springs back from the dip, past rest, to rest', async (/** @type {HTMLElement} */ host) => {
    const button = make(host, '<button class="input-ctrl-btn" style="width:32px;height:32px;padding:0"></button>');
    point(button, 'pointerdown');
    const dip = scales(/** @type {Animation} */ (animationOf(button, PRESS_ANIMATION_ID))).at(-1) ?? 1;
    point(button, 'pointerup');
    const release = await waitFor(() => animationOf(button, RELEASE_ANIMATION_ID) ?? null,
      'the release to start', budgetFor(2000));
    const frames = scales(/** @type {Animation} */ (release));
    assert(Math.abs((frames[0] ?? 0) - dip) < 1e-6, `the spring starts from the dip (${dip}), got ${frames[0]}`);
    assert(frames.at(-1) === 1, `the spring ends at rest, got ${frames.at(-1)}`);
    assert(Math.max(...frames) > 1, `the spring overshoots rest, peaking at ${Math.max(...frames)}`);
    assert(!animationOf(button, PRESS_ANIMATION_ID), 'the dip is gone once the spring has it');
  });

  await run('a disabled button, a non-button and an opted-out one do not move', async (/** @type {HTMLElement} */ host) => {
    host.innerHTML = `
      <button disabled id="a" style="width:32px;height:32px"></button>
      <button aria-disabled="true" id="b" style="width:32px;height:32px"></button>
      <div id="c" style="width:32px;height:32px"></div>
      <div data-press="none"><button id="d" style="width:32px;height:32px"></button></div>`;
    for (const id of ['a', 'b', 'c', 'd']) {
      const el = /** @type {HTMLElement} */ (host.querySelector(`#${id}`));
      point(el, 'pointerdown');
      assert(!animationOf(el, PRESS_ANIMATION_ID), `#${id} should not dip`);
      point(el, 'pointerup');
    }
  });

  await run('a key press dips a focused button', async (/** @type {HTMLElement} */ host) => {
    const button = make(host, '<button style="width:32px;height:32px;padding:0"></button>');
    button.focus();
    button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    assert(!!animationOf(button, PRESS_ANIMATION_ID), 'Space on a focused button dips it');
    button.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
    await waitFor(() => animationOf(button, RELEASE_ANIMATION_ID) ?? null, 'the release to start', budgetFor(2000));
  });

  await run('no stylesheet gives a button a press of its own', async () => {
    /** @type {string[]} */
    const own = [];
    /** @param {CSSRuleList} rules */
    const scan = (rules) => {
      for (const rule of Array.from(rules)) {
        if ('selectorText' in rule) {
          const style = /** @type {CSSStyleRule} */ (rule).style;
          const selector = /** @type {CSSStyleRule} */ (rule).selectorText;
          const moves = (style.transform && style.transform !== 'none') || (style.scale && style.scale !== 'none');
          if (moves && /:active/.test(selector)) own.push(selector);
        } else if ('cssRules' in rule) {
          scan(/** @type {CSSGroupingRule} */ (rule).cssRules);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try { scan(sheet.cssRules); } catch (_e) { /* a cross-origin sheet */ }
    }
    assert(own.length === 0, `these rules move a pressed control themselves: ${own.join(' | ')}`);
  });

  return { passed, failed, errors };
}
