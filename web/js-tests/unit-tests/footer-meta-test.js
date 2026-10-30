//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The footer's readings row — the token meter and the "Updated …" time. Neither
 * is a control, and each fails for its own reasons:
 *   1. `MessageThread.lastActivityAt` derives the time by scanning back for the
 *      newest item the worker dated. Nothing stores a conversation-level
 *      modification time, so items the client inserted optimistically (no
 *      `timestamp` yet) must not blank the answer.
 *   2. The time shows only at rest — a running turn must not leave a label on
 *      screen claiming a time that is really "now", and a group column
 *      (status-only) is a lens on a run of rows, not the thread the time is of.
 *   3. The row has to survive a narrow column: every figure stays joined to the
 *      unit or word that qualifies it, and a million-token window is stated in
 *      millions rather than as four digits of thousands.
 *   4. The button that opens this conversation's log rides with the time — the
 *      same reading, so the same visibility — and must name the conversation it
 *      belongs to when it deep-links into the Logs tab.
 *   5–6. Under en-XA, the meter and then the footer around it show no English.
 *   7. While a duplicate of this conversation is in flight, the Duplicate
 *      button is disabled and says so, so a second click has nothing to press.
 * @module unit-tests/footer-meta-test
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../utilities/test-helpers.js';
import '../../js/components/conversation-footer.js';
import '../../js/components/token-display.js';
import { registerSettingsOpener } from '../../js/services/settings-launcher.js';
import { formatRelativeDateTime, formatTokens } from '../../js/utils/format.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';

/**
 * Run the footer readings-row test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /**
   * @param {unknown} e - Whatever a check threw.
   * @returns {string} The error's message.
   */
  const msg = (e) => e instanceof Error ? e.message : String(e);

  // --- 1: lastActivityAt reads the newest dated item -----------------------
  try {
    const session = await createTestSession();
    const conversation = await createTestConversation(session);
    const thread = conversation.rootMessageThread;

    assert(thread.lastActivityAt === 0, 'a thread with no items has no last-activity time');

    const older = new Date('2026-02-03T10:00:00Z');
    const newer = new Date('2026-02-03T10:05:00Z');
    thread.addEvent({ type: 'user', content: 'first', timestamp: older.toISOString() });
    assert(thread.lastActivityAt === older.getTime(), 'one dated item dates the thread');

    thread.addEvent({ type: 'assistant', content: 'second', timestamp: newer.toISOString() });
    assert(thread.lastActivityAt === newer.getTime(), 'the newest dated item wins');

    // The client appends before the worker echoes the item back with its
    // timestamp; that gap must leave the previous answer standing rather than
    // clearing the label to nothing.
    thread.addEvent({ type: 'user', content: 'not yet dated' });
    assert(thread.lastActivityAt === newer.getTime(),
      'an undated item is skipped, not treated as "unknown"');
    passed++;
  } catch (e) { failed++; errors.push(`lastActivityAt: ${msg(e)}`); }

  // --- 2: the footer shows it at rest, and only at rest --------------------
  const footer = /** @type {any} */ (document.createElement('conversation-footer'));
  document.body.appendChild(footer);
  try {
    const at = new Date('2026-02-03T10:05:00Z').getTime();
    const { short, full } = formatRelativeDateTime(at);
    const label = () => /** @type {HTMLElement|null} */ (footer.querySelector('.footer-last-activity'));
    // The time and the log button are one reading, shown and hidden together, so
    // the `hidden` class lives on the pair rather than on either of them.
    const group = () => /** @type {HTMLElement|null} */ (footer.querySelector('.footer-activity'));
    /**
     * @param {Element|null} el - A part of the footer.
     * @returns {boolean} True when that part is hidden.
     */
    const hidden = (el) => !!el?.classList.contains('hidden');

    footer.update({ isProcessing: false, canContinue: true, lastActivityAt: at });
    assert(!hidden(group()), 'an idle footer dates the thread it ends');
    assert(label()?.textContent === `Updated ${short}`,
      'the label reads through the app-wide relative date-time formatter');
    assert(label()?.title === `Last updated ${full}`,
      'the tooltip carries the full absolute time the short label elides');
    assert(group()?.contains(footer.querySelector('.footer-log-btn')),
      'the log button rides with the time rather than standing on its own');
    passed++;

    footer.update({ isProcessing: true, statusMessage: 'Running…', lastActivityAt: at });
    assert(hidden(group()), 'a running turn dates itself, so the label goes for the duration');
    passed++;

    footer.update({ isProcessing: false, canContinue: false, lastActivityAt: 0 });
    assert(hidden(group()), 'a conversation with nothing in it has no date to show');
    passed++;

    footer.setStatusOnly(true);
    footer.update({ isProcessing: false, canContinue: true, lastActivityAt: at });
    assert(hidden(group()) && hidden(footer.querySelector('.footer-meta')),
      'a group column shows a run of rows, not the thread whose time this is');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`footer render: ${msg(e)}`);
  } finally {
    footer.remove();
  }

  // --- 3: the meter reads the same however narrow the column ---------------
  const pill = /** @type {any} */ (document.createElement('token-display'));
  document.body.appendChild(pill);
  try {
    pill.setUsage({ total: 872000, cached: null, budget: 1048576 });
    const text = pill.textContent || '';
    assert(text.includes('872k'), `the total states its own figure, got ${JSON.stringify(text)}`);
    assert(text.includes('/\u00A01M'),
      `the window reads in millions, glued to its slash, got ${JSON.stringify(text)}`);
    assert(!/\/ /.test(text),
      `nothing in the meter may wrap after the slash, got ${JSON.stringify(text)}`);
    passed++;

    assert(formatTokens(1000000) === '1M', 'a round million is a bare "1M"');
    assert(formatTokens(1500000) === '1.5M', 'a part million keeps one decimal');
    assert(formatTokens(2097152) === '2M', 'a redundant decimal is dropped');
    assert(formatTokens(999999) === '999k',
      'the million tier floors like the thousand tier, so a count never reads high');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`token meter: ${msg(e)}`);
  } finally {
    pill.remove();
  }

  // --- 4: the log button names its own conversation ------------------------
  const logFooter = /** @type {any} */ (document.createElement('conversation-footer'));
  document.body.appendChild(logFooter);
  /** @type {(() => void)|null} */
  let restoreOpener = null;
  try {
    const session = await createTestSession();
    const conversation = await createTestConversation(session);
    logFooter.setMessageThread(conversation.rootMessageThread);

    /** @type {Array<[string|undefined, any]>} */
    const opened = [];
    restoreOpener = registerSettingsOpener((tab, options) => { opened.push([tab, options]); });

    /** @type {HTMLElement} */ (logFooter.querySelector('.footer-log-btn')).click();
    assert(opened.length === 1, `one click opens settings once, got ${opened.length}`);
    assert(opened[0][0] === 'logs', `on the Logs tab, got ${JSON.stringify(opened[0][0])}`);
    // Without the id the Logs tab would open on server.log and leave the user
    // hunting their conversation in the picker — the thing the button exists to
    // avoid.
    assert(opened[0][1]?.conversationLog === conversation.id,
      `naming this conversation, got ${JSON.stringify(opened[0][1])}`);
    passed++;
  } catch (e) {
    failed++;
    errors.push(`log button: ${msg(e)}`);
  } finally {
    if (restoreOpener) restoreOpener();
    logFooter.remove();
  }

  // --- 5: every state of the meter, under en-XA ----------------------------
  // Last, because it switches the locale. The pill sets its own title and
  // aria-label, so it is walked from a host element that contains it.
  const host = document.createElement('div');
  const xaPill = /** @type {any} */ (document.createElement('token-display'));
  host.appendChild(xaPill);
  document.body.appendChild(host);
  try {
    /** @type {string[]} */
    const raw = [];
    // A bare figure — the total, `~` for an estimate, the `/ window` — is data.
    const DATA = /^[~\d,.\s/\u00A0]+$/;
    /**
     * Record every plain-English string the meter shows.
     * @param {string} where - The state, for the failure.
     */
    const collect = (where) => {
      const shown = shownStrings(host);
      assert(shown.length >= 2, `expected the count and the aria-label (${where}), found ${shown.length}`);
      for (const s of shown) {
        if (!DATA.test(s) && !isPseudoLocalized(s)) raw.push(`${where}: ${s}`);
      }
    };
    /**
     * @param {string} sel
     * @returns {boolean} True when the pill draws that part.
     */
    const has = (sel) => !!xaPill.querySelector(sel);

    await underPseudoLocale('footer-meta-test', () => {
      xaPill.setUsage({ total: 1500, cached: null });
      assert(!!xaPill.title, 'an unreported cache says so in the tooltip');
      collect('cache unreported');

      xaPill.setUsage({ total: 1500, cached: 500 });
      assert(has('.token-cached') && !xaPill.title, 'a cached count draws its parenthetical');
      collect('cached, no window');

      xaPill.setUsage({ total: 1000, cached: 500, budget: 1900 });
      assert(has('.token-denominator'), 'a known window draws the meter');
      collect('within the window');

      xaPill.setUsage({ total: 1850, cached: 1000, budget: 1900 });
      assert(!!xaPill.title, 'a nearly-full window says so in the tooltip');
      collect('nearly full');

      xaPill.setUsage({ total: 1950, cached: 1000, budget: 1000 });
      assert(!!xaPill.title, 'a passed window states the overrun');
      collect('over the window');

      xaPill.setUsage({ total: 1500, cached: 500, budget: 1900, processing: true });
      collect('processing');

      xaPill.setUsage({ total: 1500, cached: null, approximate: true });
      collect('approximate');

      // The warning needs over 5000 uncached tokens, so the figures carry a
      // `k` — a message of its own, translated like the words around it.
      xaPill.setUsage({ total: 7000, cached: 1000 });
      assert(has('.token-new'), 'a large uncached delta draws the warning');
      collect('cache warn');

      xaPill.clear();
      assert(!xaPill.hasAttribute('aria-label') && !xaPill.title && !xaPill.textContent,
        'a cleared pill shows nothing');
    });
    assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    passed++;
  } catch (e) {
    failed++;
    errors.push(`en-XA: ${msg(e)}`);
  } finally {
    host.remove();
  }

  // --- 6: every state of the footer itself, under en-XA --------------------
  // The template is drawn when the footer connects, so it connects under the
  // locale. Hidden parts are walked too: every state's controls are in the tree.
  /** @type {any} */
  let xaFooter = null;
  try {
    /** @type {string[]} */
    const raw = [];
    // Times are Intl data, and the only data the walk shows; each is mapped to
    // a digit before judging the words.
    const DATA = /^[\d\s]*$/;
    const at = Date.now() - 60_000;
    /**
     * Record every plain-English string the footer shows.
     * @param {string} where - The state, for the failure.
     */
    const collect = (where) => {
      const { short, full } = formatRelativeDateTime(at);
      const shown = shownStrings(xaFooter);
      assert(shown.length >= 10, `expected the footer's labels (${where}), found ${shown.length}`);
      for (const s of shown) {
        const v = s.split(full).join('0').split(short).join('0');
        if (!DATA.test(v) && !isPseudoLocalized(v)) raw.push(`${where}: ${s}`);
      }
    };

    await underPseudoLocale('footer-meta-test', () => {
      xaFooter = document.createElement('conversation-footer');
      document.body.appendChild(xaFooter);
      // The Undo offer needs a conversation to watch; nothing else here does.
      xaFooter._messageThread = {
        conversation: { observeMetadata() {}, unobserveMetadata() {} },
      };

      xaFooter.update({ isProcessing: false, canContinue: true, showDuplicateTab: true, lastActivityAt: at });
      assert(!!xaFooter.querySelector('.footer-last-activity')?.textContent, 'an idle footer dates the thread');
      collect('idle');

      xaFooter.update({ isProcessing: false, canContinue: true, showDuplicateTab: true, duplicating: true, lastActivityAt: at });
      collect('duplicating');

      xaFooter.update({ isProcessing: false, canContinue: true, politePaused: true, lastActivityAt: at });
      collect('paused');

      xaFooter.update({ isProcessing: true, statusMessage: '', runningTools: 1 });
      collect('running');

      xaFooter.update({ isProcessing: true, statusMessage: '', politePending: true });
      assert(xaFooter.querySelector('.footer-pause-label')?.textContent !== 'Pause', 'a pending pause relabels the button');
      collect('pausing');

      xaFooter.update({ isProcessing: false, canContinue: false, lastActivityAt: 0 });
      xaFooter._showUndoOffer(1);
      collect('undo one');
      xaFooter._showUndoOffer(3);
      assert(!xaFooter.querySelector('.footer-undo-offer')?.classList.contains('hidden'), 'the Undo offer shows');
      collect('undo several');
      xaFooter._hideUndoOffer();
    });
    assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    passed++;
  } catch (e) {
    failed++;
    errors.push(`footer en-XA: ${msg(e)}`);
  } finally {
    xaFooter?.remove();
  }

  // --- 7: a duplicate in flight disables its button ------------------------
  const dupFooter = /** @type {any} */ (document.createElement('conversation-footer'));
  document.body.appendChild(dupFooter);
  try {
    const btn = () => /** @type {HTMLButtonElement|null} */ (dupFooter.querySelector('.duplicate-to-tab-btn'));
    const label = () => (btn()?.textContent || '').trim();

    dupFooter.update({ isProcessing: false, canContinue: true, showDuplicateTab: true });
    assert(btn()?.disabled === false && label() === 'Duplicate as new conversation',
      `at rest the button is live and offers the duplicate, got disabled=${btn()?.disabled} "${label()}"`);

    dupFooter.update({ isProcessing: false, canContinue: true, showDuplicateTab: true, duplicating: true });
    assert(btn()?.disabled === true, 'while the copy is made the button cannot be pressed again');
    assert(label() === 'Duplicating…', `and it says what is happening, got "${label()}"`);

    dupFooter.update({ isProcessing: false, canContinue: true, showDuplicateTab: true, duplicating: false });
    assert(btn()?.disabled === false && label() === 'Duplicate as new conversation',
      `once it lands the button comes back, got disabled=${btn()?.disabled} "${label()}"`);
    passed++;
  } catch (e) {
    failed++;
    errors.push(`footer duplicating: ${msg(e)}`);
  } finally {
    dupFooter.remove();
  }

  return { passed, failed, errors };
}
