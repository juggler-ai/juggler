//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A tab's status circle.
 *
 * Every tab carries one, left of its name, drawn from the same badge pattern
 * the conversation panel's item circles are (patterns/item-badge.css): a preset
 * fill and a white glyph. The fill says the state — the meta slate at rest,
 * green while the turn runs, red when it failed, the ask family's yellow
 * while it waits on the user — and the glyph says what is in it: the
 * assistant, a question (waited on, or nothing said yet), a "!" for a
 * failure, or a clock while a send is scheduled. Only running pulses; nothing
 * else on the tab animates.
 *
 * The fills are compared against a panel circle of the same preset class,
 * which is the claim being made: the two are one definition, not two that
 * happen to look alike.
 * @module unit-tests/conversation-tab-status-test
 */

import * as Y from '../../js/vendor/yjs.mjs';
import { assert } from '../utilities/test-helpers.js';
import scheduledSendService from '../../js/services/scheduled-send-service.js';
import '../../js/components/conversation-bar.js';

/**
 * A conversation record with the activity the bar reads off it.
 * @param {string} id - The conversation id.
 * @param {{running?: boolean, awaiting?: boolean, items?: string[], loadState?: string}} [state] - Its
 *   activity, the types of its root thread's items in order (a user message and
 *   a reply unless given), and its load state (loaded unless given).
 * @returns {any} The record.
 */
function conversation(id, state = {}) {
  const types = state.items || ['user', 'assistant'];
  // The root thread's items as the model holds them: a Y.Array of Y.Maps in a
  // real doc, exposed as MessageThread#yarray.
  const doc = new Y.Doc();
  const yarray = doc.getArray('items');
  yarray.push(types.map(type => {
    const item = new Y.Map();
    item.set('type', type);
    return item;
  }));
  return {
    id,
    name: id,
    workspaceId: '',
    loadState: state.loadState || 'loaded',
    rootMessageThread: { yarray },
    llmState: { isConversationProcessing: () => !!state.running },
    isAwaitingApproval: () => !!state.awaiting
  };
}

/**
 * Which of a circle's glyphs is showing.
 * @param {Element} circle - The status circle.
 * @returns {string[]} The `conversation-tab-glyph-*` suffixes of the visible ones.
 */
function visibleGlyphs(circle) {
  return Array.from(circle.querySelectorAll('.conversation-tab-glyph'))
    .filter(glyph => getComputedStyle(glyph).display !== 'none')
    .map(glyph => (Array.from(glyph.classList).find(c => c.startsWith('conversation-tab-glyph-')) || '')
      .replace('conversation-tab-glyph-', ''));
}

/**
 * Whether this machine asks for reduced motion.
 *
 * The running pulse is dropped under the preference, and CI machines report
 * it, so the pulse case asserts whichever behaviour this machine is entitled to.
 * @returns {boolean} True when the reduce preference is set.
 */
function reducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:300px;height:600px;';
  // conversation-bar's keyboard setup looks up <conversation-tabs-container/>
  // via document.querySelector, so it must exist somewhere in the document.
  container.appendChild(document.createElement('conversation-tabs-container'));
  const bar = /** @type {any} */ (document.createElement('conversation-bar'));
  container.appendChild(bar);
  document.body.appendChild(container);

  const armed = new Set(['scheduled', 'empty-scheduled', 'failed-scheduled']);
  const realHasArmed = scheduledSendService.hasArmedSchedule;
  scheduledSendService.hasArmedSchedule = (/** @type {string} */ id) => armed.has(id);

  /**
   * A panel circle wearing a preset, mounted where the bar's own are, to read
   * the fill that preset resolves to.
   * @param {string} preset - e.g. `color-ask`.
   * @returns {string} Its computed background colour.
   */
  const panelFill = (preset) => {
    const probe = document.createElement('span');
    probe.className = `message-icon-box ${preset}`;
    container.appendChild(probe);
    const fill = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return fill;
  };

  /**
   * @param {string} name - What is being checked.
   * @param {() => void|Promise<void>} body - The check.
   * @returns {Promise<void>} When it has run.
   */
  const check = async (name, body) => {
    try {
      await body();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  try {
    bar._session = {
      workspaces: [],
      conversations: new Map([
        ['idle', conversation('idle')],
        ['running', conversation('running', { running: true })],
        ['awaiting', conversation('awaiting', { awaiting: true })],
        ['scheduled', conversation('scheduled', { running: true })],
        ['failed', conversation('failed', { items: ['user', 'error'] })],
        ['retried', conversation('retried', { items: ['user', 'error', 'user', 'assistant'] })],
        ['empty', conversation('empty', { items: ['system-prompt'] })],
        ['unloaded', conversation('unloaded', { items: [], loadState: 'unloaded' })],
        ['empty-awaiting', conversation('empty-awaiting', { items: [], awaiting: true })],
        ['empty-scheduled', conversation('empty-scheduled', { items: [] })],
        ['failed-scheduled', conversation('failed-scheduled', { items: ['user', 'error'] })]
      ]),
      bin: { count: 0, sizeBytes: 0 },
      selection: null,
      loadedConversationId: null
    };
    bar.render();

    const tab = (/** @type {string} */ id) => /** @type {HTMLElement} */ (
      bar.querySelector(`.conversation-tab[data-conversation-id="${id}"]`));
    const circle = (/** @type {string} */ id) => /** @type {HTMLElement} */ (
      tab(id).querySelector('.conversation-tab-status'));

    await check('every tab carries one status circle, ahead of its name', () => {
      for (const id of ['idle', 'running', 'awaiting', 'scheduled']) {
        const circles = tab(id).querySelectorAll('.conversation-tab-status');
        assert(circles.length === 1, `tab ${id} must carry one status circle, got ${circles.length}`);
        assert(circles[0].classList.contains('item-circle'), `tab ${id}'s circle must be the shared badge circle`);
        const name = /** @type {Element} */ (tab(id).querySelector('.conversation-tab-name'));
        assert(!!(circles[0].compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING),
          `tab ${id}'s circle must come before its name`);
      }
      assert(!bar.querySelector('.conversation-tab-activity, .conversation-tab-schedule'),
        'the circle is the only status mark: no separate activity blob or clock slot');
    });

    await check('the fill says the state, and is the panel\'s own preset', () => {
      const cases = /** @type {[string, string][]} */ ([
        ['idle', 'color-meta'], ['running', 'color-green'], ['awaiting', 'color-ask'], ['scheduled', 'color-green']
      ]);
      for (const [id, preset] of cases) {
        assert(circle(id).classList.contains(preset), `tab ${id}'s circle must wear ${preset}, got "${circle(id).className}"`);
        const fill = getComputedStyle(circle(id)).backgroundColor;
        assert(fill === panelFill(preset),
          `tab ${id}'s circle must be filled exactly as a panel circle wearing ${preset} is, got ${fill} against ${panelFill(preset)}`);
      }
      assert(getComputedStyle(circle('idle')).color === 'rgb(255, 255, 255)', 'the glyph is white');
    });

    await check('the circle and its glyph are the size of a panel item\'s', () => {
      // Measured against a real panel circle — the glyph inside it sized by the
      // panel's own rule, the padding by the badge pattern — so the tab follows
      // whatever the panel's circle is rather than a number copied from it.
      const row = document.createElement('div');
      row.className = 'message-with-icon';
      row.innerHTML = '<span class="message-icon-box color-meta"><svg viewBox="0 0 16 16"></svg></span>';
      container.appendChild(row);
      const panel = /** @type {Element} */ (row.querySelector('.message-icon-box')).getBoundingClientRect();
      const panelGlyph = /** @type {Element} */ (row.querySelector('svg')).getBoundingClientRect();
      row.remove();

      const tabCircle = circle('idle').getBoundingClientRect();
      const tabGlyph = /** @type {Element} */ (circle('idle').querySelector('.conversation-tab-glyph-assistant')).getBoundingClientRect();
      assert(Math.abs(tabCircle.width - panel.width) < 0.5 && Math.abs(tabCircle.height - panel.height) < 0.5,
        `the tab's circle must be ${panel.width}x${panel.height}px like a panel item's, got ${tabCircle.width}x${tabCircle.height}px`);
      assert(Math.abs(tabGlyph.width - panelGlyph.width) < 0.5,
        `its glyph must be ${panelGlyph.width}px like a panel item's, got ${tabGlyph.width}px`);
    });

    await check('the glyph says what is in it', () => {
      assert(visibleGlyphs(circle('idle')).join() === 'assistant', `idle shows the assistant, got ${visibleGlyphs(circle('idle'))}`);
      assert(visibleGlyphs(circle('running')).join() === 'assistant', `running shows the assistant, got ${visibleGlyphs(circle('running'))}`);
      assert(visibleGlyphs(circle('awaiting')).join() === 'question', `awaiting shows a question, got ${visibleGlyphs(circle('awaiting'))}`);
      assert(visibleGlyphs(circle('scheduled')).join() === 'clock', `a scheduled send shows the clock, got ${visibleGlyphs(circle('scheduled'))}`);
    });

    await check('a turn that ended in an error shows a red "!" until something follows it', () => {
      assert(visibleGlyphs(circle('failed')).join() === 'alert', `a failed turn shows the alert, got ${visibleGlyphs(circle('failed'))}`);
      assert(circle('failed').classList.contains('color-red'), `and is filled red, got "${circle('failed').className}"`);
      assert(getComputedStyle(circle('failed')).backgroundColor === panelFill('color-red'), 'exactly as a panel circle wearing color-red is');
      assert(visibleGlyphs(circle('retried')).join() === 'assistant',
        `an error with a later turn after it is history, got ${visibleGlyphs(circle('retried'))}`);
      assert(circle('retried').classList.contains('color-meta'), 'and is back at rest');
      assert(visibleGlyphs(circle('failed-scheduled')).join() === 'alert', 'an error outranks a scheduled send\'s clock');
    });

    await check('a conversation with no messages yet shows a question mark on slate', () => {
      assert(visibleGlyphs(circle('empty')).join() === 'question', `an empty conversation shows the question, got ${visibleGlyphs(circle('empty'))}`);
      assert(circle('empty').classList.contains('color-meta'), `on the meta slate, got "${circle('empty').className}"`);
      assert(visibleGlyphs(circle('unloaded')).join() === 'assistant',
        `a conversation not loaded yet has no items to judge by and is not called empty, got ${visibleGlyphs(circle('unloaded'))}`);
      assert(circle('empty-awaiting').classList.contains('color-ask'), 'awaiting still wins the fill over empty');
      assert(visibleGlyphs(circle('empty-scheduled')).join() === 'clock', 'a scheduled send outranks empty');
    });

    await check('only running pulses, and nothing else on the tab animates', () => {
      const pulse = getComputedStyle(circle('running')).animationName;
      if (reducedMotion()) {
        assert(pulse === 'none', `under reduced motion a running circle holds still, got ${pulse}`);
      } else {
        assert(pulse === 'icon-pulse', `a running circle pulses with the badge pulse, got ${pulse}`);
      }
      for (const id of ['idle', 'awaiting']) {
        assert(getComputedStyle(circle(id)).animationName === 'none', `tab ${id}'s circle must hold still`);
        assert(getComputedStyle(tab(id)).animationName === 'none', `tab ${id} itself must not animate`);
      }
    });

    await check('a selected tab wears a neutral overlay, never a hue', () => {
      // Chosen the way a conversation-panel item is chosen — a neutral wash over
      // the tab's own surface, in a stronger measure because a tab strip is read
      // at a glance — with its name set heavier. No border of its own, and the
      // text stays the theme's: the old blue slab with white text is gone.
      bar._session.visibleConversationId = 'idle';
      bar.render();
      const chosen = tab('idle');
      const other = tab('running');
      assert(chosen.classList.contains('active'), 'precondition: the tab is the chosen one');

      const probe = document.createElement('span');
      probe.style.background = 'var(--item-selected-strong-bg)';
      container.appendChild(probe);
      const overlay = getComputedStyle(probe).backgroundColor;
      probe.remove();
      assert(overlay !== 'rgba(0, 0, 0, 0)', 'precondition: the strong selection token resolves');
      assert(getComputedStyle(chosen).backgroundImage.includes(overlay),
        `the chosen tab is washed with --item-selected-strong-bg, got ${getComputedStyle(chosen).backgroundImage}`);
      assert(getComputedStyle(chosen).color === getComputedStyle(other).color,
        `its text stays the theme's, got ${getComputedStyle(chosen).color} against ${getComputedStyle(other).color}`);
      assert(getComputedStyle(chosen).borderTopColor === 'rgba(0, 0, 0, 0)',
        `and it has no border colour, got ${getComputedStyle(chosen).borderTopColor}`);
      const name = /** @type {Element} */ (chosen.querySelector('.conversation-tab-name'));
      assert(Number(getComputedStyle(name).fontWeight) >= 600, `its name is set heavier, got ${getComputedStyle(name).fontWeight}`);
      assert(getComputedStyle(other).backgroundImage === 'none', 'and an unchosen tab carries no overlay');
      bar._session.visibleConversationId = null;
      bar.render();
    });

    await check('a running tab keeps its bin out of reach without changing its width', () => {
      const bin = /** @type {HTMLElement} */ (tab('running').querySelector('.conversation-tab-bin'));
      const style = getComputedStyle(bin);
      assert(style.display !== 'none' && style.visibility === 'hidden',
        `the bin must hold its place but be hidden, got display ${style.display}, visibility ${style.visibility}`);
    });
  } finally {
    scheduledSendService.hasArmedSchedule = realHasArmed;
    container.remove();
  }

  return { passed, failed, errors };
}
