//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Regression tests for the tool-action row's convergence guard: a tool-action
 * carrying a settled `result` is terminal regardless of `state`.
 *
 * Bug: cancelling a bash tool in the brief APPROVED→RUNNING window let the JS
 * engine's claimRunning() win the Yjs last-write-wins on `state` against the
 * worker's concurrent `state='cancelled'`, while the worker's `result` write
 * (an uncontested key) persisted. The item converged to state='running' +
 * result={cancelled:true,…} — a terminal result under a non-terminal state —
 * so the footer spinner and transcript row stuck on "Running …" forever.
 *
 * These isolate the decision by overriding `_getItem` with a fake and (for
 * render) spying on the `_render*` methods, so no conversation/DOM plumbing is
 * needed.
 *
 * Also covers the auto-approve review indicator's in-place update: a
 * reviewStatus-only change is churn (`_isReviewStatusChurn` → true) so the live
 * approval buttons are never rebuilt; a first paint renders the
 * `.approval-review-status` row above the buttons for both a busy review and a
 * settled note; and busy → settled swaps the row in place, leaving the buttons
 * untouched.
 * @module unit-tests/tool-action-render
 */

import { TOOL_STATES } from '../../sdk/lib/message.js';
import {
  buildApprovalSourceBadge, renderError, renderMessage, renderContextItem, renderToolAction,
} from '../../js/services/renderers/item-renderers.js';
import contextItemRegistry from '../../js/registries/context-item-registry.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { formatDuration } from '../../js/utils/format.js';
import { createSummaryWithSubtitle } from '../../sdk/lib/html.js';
import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import '../../js/components/tool-action-message.js'; // registers the custom element
import '../../js/components/action-confirmation.js'; // registers <action-confirmation>

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Minimal Y.Map-ish item; nested result supports .get() like a Y.Map.
 * @param {object} fields - Field values keyed by name (e.g. state, toolName, result).
 * @returns {{get: (k: string) => any}} A Y.Map-like item exposing `.get(key)`.
 */
function fakeItem(fields) {
  const m = new Map(Object.entries(fields));
  if (fields.result && typeof fields.result === 'object') {
    const rm = new Map(Object.entries(fields.result));
    m.set('result', { get: (k) => rm.get(k) });
  }
  return { get: (k) => m.get(k) };
}

/**
 * Run all tool-action render tests.
 * @returns {Promise<TestResult>} Pass/fail counts and error messages.
 */
export async function runTests() {
  let passed = 0, failed = 0; const errors = [];
  const el = /** @type {any} */ (document.createElement('tool-action-message'));

  // A — footer/spinner must go quiet once a result is present, even at state=running.
  try {
    el._getItem = () => fakeItem({
      state: TOOL_STATES.RUNNING, toolName: 'bash',
      result: { content: 'Interrupted', cancelled: true, isError: false },
    });
    const busy = el.getBusyState();
    if (busy !== null) throw new Error(`expected null (terminal), got ${JSON.stringify(busy)}`);
    passed++;
  } catch (e) { failed++; errors.push(`getBusyState terminal-result: ${e.message}`); }

  // A2 — the footer names a running tool as its card does (the card's type
  // label and summary), never by its wire name; a tool with no status UI
  // falls back to the wire name.
  const realGetByToolName = contextItemRegistry.getByToolName;
  try {
    const summary = document.createElement('span');
    summary.textContent = 'Swap the greeting';
    class CardTool {
      getStatusUI() { return { typeName: 'Program', summary, status: 'running' }; }
    }
    contextItemRegistry.getByToolName = (name) => (name === 'run_code' ? CardTool : undefined);
    const busyEl = /** @type {any} */ (document.createElement('tool-action-message'));
    busyEl._getConversation = () => ({ session: {} });
    busyEl._getMessageThread = () => ({});
    busyEl._getItem = () => fakeItem({ state: TOOL_STATES.RUNNING, toolName: 'run_code', toolInput: {} });
    const busy = busyEl.getBusyState();
    if (busy?.message !== 'Program: Swap the greeting')
      throw new Error(`expected the card's label, got ${JSON.stringify(busy)}`);
    busyEl._getItem = () => fakeItem({ state: TOOL_STATES.RUNNING, toolName: 'mystery', toolInput: {} });
    const bare = busyEl.getBusyState();
    if (bare?.message !== 'Running mystery…')
      throw new Error(`expected the wire-name fallback, got ${JSON.stringify(bare)}`);
    passed++;
  } catch (e) { failed++; errors.push(`getBusyState card label: ${e.message}`); }
  finally { contextItemRegistry.getByToolName = realGetByToolName; }

  // A2b — a two-line card summary (command + description subtitle) gives the
  // footer its main line only: the subtitle is the card's second line, not
  // part of the one-line label.
  try {
    class SubtitledTool {
      getStatusUI() { return { typeName: 'Bash', summary: createSummaryWithSubtitle('ls -la', 'Run by the user'), status: 'running' }; }
    }
    contextItemRegistry.getByToolName = (name) => (name === 'bash' ? SubtitledTool : undefined);
    const busyEl = /** @type {any} */ (document.createElement('tool-action-message'));
    busyEl._getConversation = () => ({ session: {} });
    busyEl._getMessageThread = () => ({});
    busyEl._getItem = () => fakeItem({ state: TOOL_STATES.RUNNING, toolName: 'bash', toolInput: {} });
    const busy = busyEl.getBusyState();
    if (busy?.message !== 'Bash: ls -la')
      throw new Error(`expected the main line only, got ${JSON.stringify(busy)}`);
    passed++;
  } catch (e) { failed++; errors.push(`getBusyState subtitled summary: ${e.message}`); }
  finally { contextItemRegistry.getByToolName = realGetByToolName; }

  // A3 — an item with no tool name looks nothing up in the registry: a
  // capability whose tool happens to be called 'tool' or 'Action' must not
  // draw an unnamed row's busy label or cancelled card.
  try {
    /** @type {string[]} */
    const looked = [];
    class Squatter {
      getStatusUI() { return { typeName: 'Squatter', summary: 'not this one', status: 'running' }; }
    }
    contextItemRegistry.getByToolName = (name) => { looked.push(String(name)); return Squatter; };
    const unnamed = /** @type {any} */ (document.createElement('tool-action-message'));
    unnamed._getConversation = () => ({ session: {} });
    unnamed._getMessageThread = () => ({});
    unnamed._getItem = () => fakeItem({ state: TOOL_STATES.RUNNING, toolInput: {} });
    const busy = unnamed.getBusyState();
    if (busy?.message !== 'Running tool…') throw new Error(`expected the generic busy label, got ${JSON.stringify(busy)}`);
    unnamed._renderCancelled(fakeItem({ state: TOOL_STATES.CANCELLED, toolInput: {}, result: { cancelled: true } }));
    if (unnamed.textContent.includes('Squatter')) throw new Error(`the cancelled card was drawn by a registry squatter: ${unnamed.textContent}`);
    if (looked.length) throw new Error(`expected no registry lookup, got ${JSON.stringify(looked)}`);
    passed++;
  } catch (e) { failed++; errors.push(`unnamed item registry lookup: ${e.message}`); }
  finally { contextItemRegistry.getByToolName = realGetByToolName; }

  // B — transcript body must render the cancelled row, not the running row.
  try {
    const calls = [];
    el._renderRunning   = () => calls.push('running');
    el._renderCancelled = () => calls.push('cancelled');
    el._renderResult    = () => calls.push('result');
    el._getItem = () => fakeItem({
      state: TOOL_STATES.RUNNING, toolName: 'bash',
      result: { content: 'Interrupted', cancelled: true, isError: false },
    });
    el.render();
    if (calls.join(',') !== 'cancelled')
      throw new Error(`expected ['cancelled'], got [${calls}]`);
    passed++;
  } catch (e) { failed++; errors.push(`render terminal-result routing: ${e.message}`); }

  // C — a reviewStatus-only change on a mounted approval widget is in-place
  // churn: _isReviewStatusChurn must return true (so the observer skips the
  // destructive render() that would rebuild the buttons under the cursor), and
  // false when no action-confirmation is mounted.
  try {
    const base = {
      state: TOOL_STATES.PENDING, hasResult: false, resultIsError: false,
      hasApprovalOptions: true, displayDataJson: '{"cmd":"echo"}', reviewStatusJson: '',
    };
    const next = { ...base, reviewStatusJson: '{"busy":true,"label":"Auto-approve reviewing…"}' };

    const mounted = /** @type {any} */ (document.createElement('tool-action-message'));
    mounted.appendChild(document.createElement('action-confirmation'));
    if (mounted._isReviewStatusChurn(base, next) !== true)
      throw new Error('expected churn=true when only reviewStatus changes with buttons mounted');

    const bare = /** @type {any} */ (document.createElement('tool-action-message'));
    if (bare._isReviewStatusChurn(base, next) !== false)
      throw new Error('expected churn=false when no action-confirmation is mounted');

    // A displayData change alongside reviewStatus is NOT review-status churn.
    const both = { ...next, displayDataJson: '{"cmd":"ls"}' };
    if (mounted._isReviewStatusChurn(base, both) !== false)
      throw new Error('expected churn=false when displayData also changed');
    passed++;
  } catch (e) { failed++; errors.push(`reviewStatus churn guard: ${e.message}`); }

  // D — first paint with reviewStatus.busy renders the .approval-review-status
  // row above the approval buttons.
  try {
    const paintEl = /** @type {any} */ (document.createElement('tool-action-message'));
    const container = document.createElement('div');
    container.className = 'action-approval-container';
    paintEl._appendApprovalButtons(container, fakeItem({
      toolUseId: 't-review', toolName: 'bash',
      approvalOptions: { options: [{ label: 'Approve', value: 'yes' }] },
      reviewStatus: { busy: true, label: 'Auto-approve reviewing…' },
    }));
    const row = container.querySelector('.approval-review-status');
    const buttons = container.querySelector('action-confirmation');
    if (!row) throw new Error('expected a .approval-review-status row on first paint');
    const labelEl = row.querySelector('.approval-review-status-label');
    if (!labelEl || labelEl.textContent !== 'Auto-approve reviewing…')
      throw new Error(`expected the manifest label, got ${labelEl && labelEl.textContent}`);
    if (!buttons) throw new Error('expected action-confirmation buttons present');
    // Row must precede the buttons in document order.
    const rowBeforeButtons = !!(row.compareDocumentPosition(buttons) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (!rowBeforeButtons) throw new Error('review-status row must be above the buttons');
    passed++;
  } catch (e) { failed++; errors.push(`review-status first paint: ${e.message}`); }

  // D2 — a settled (non-busy) reviewStatus is a closing note that must still
  // paint: no spinner, the --done styling, and the note shown verbatim as text.
  // This is what tells the user why a call is still parked after the reviewer
  // declined to approve it.
  try {
    const NOTE = 'Auto-approve declined: force-pushes over shared history';
    const paintEl = /** @type {any} */ (document.createElement('tool-action-message'));
    const container = document.createElement('div');
    container.className = 'action-approval-container';
    paintEl._appendApprovalButtons(container, fakeItem({
      toolUseId: 't-review-done', toolName: 'bash',
      approvalOptions: { options: [{ label: 'Approve', value: 'yes' }] },
      reviewStatus: { busy: false, label: NOTE },
    }));
    const row = container.querySelector('.approval-review-status');
    if (!row) throw new Error('a settled note must still render a row');
    if (!row.classList.contains('approval-review-status--done'))
      throw new Error('a settled row must carry the --done modifier');
    if (row.querySelector('juggler-spinner'))
      throw new Error('a settled row must not spin');
    const labelEl = row.querySelector('.approval-review-status-label');
    if (!labelEl || labelEl.textContent !== NOTE)
      throw new Error(`expected the note verbatim, got ${labelEl && labelEl.textContent}`);
    if (!container.querySelector('action-confirmation'))
      throw new Error('the approval buttons must stay live alongside the note');
    passed++;
  } catch (e) { failed++; errors.push(`review-status settled note: ${e.message}`); }

  // D3 — busy → settled is applied in place: _applyReviewStatus swaps the row
  // (spinner out, note in) without disturbing the mounted approval buttons.
  try {
    const el2 = /** @type {any} */ (document.createElement('tool-action-message'));
    const container = document.createElement('div');
    container.className = 'action-approval-container';
    el2.appendChild(container);
    const buttons = document.createElement('action-confirmation');
    container.appendChild(buttons);
    container.insertBefore(el2._buildReviewStatusRow('Auto-approve reviewing…', true), buttons);

    el2._applyReviewStatus(fakeItem({ reviewStatus: { busy: false, label: 'Auto-approve declined: nope' } }));
    const rows = container.querySelectorAll('.approval-review-status');
    if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
    if (!rows[0].classList.contains('approval-review-status--done'))
      throw new Error('the row should have become the settled variant');
    if (container.querySelector('action-confirmation') !== buttons)
      throw new Error('the original buttons element must be untouched');

    // Clearing the status removes the row entirely.
    el2._applyReviewStatus(fakeItem({ reviewStatus: null }));
    if (container.querySelector('.approval-review-status'))
      throw new Error('a cleared reviewStatus must remove the row');
    passed++;
  } catch (e) { failed++; errors.push(`review-status in-place swap: ${e.message}`); }

  // E — approval-provenance badge (properties panel only). Each known source
  // names its approving body with a lozenge carrying a leading icon + label; an
  // unknown/absent source yields null so the header simply omits it. This badge
  // lives ONLY in the properties panel — the tool-action row/card carries no
  // approval marker.
  try {
    const cases = [
      { source: 'user', icon: 'icon-check' },
      { source: 'rule', icon: 'icon-checklist' },
      { source: 'strategy', icon: 'icon-auto-awesome' },
    ];
    for (const { source, icon } of cases) {
      const badge = buildApprovalSourceBadge(source);
      if (!badge) throw new Error(`expected a badge for approvalSource=${source}`);
      if (!badge.classList.contains('context-item-type-badge'))
        throw new Error(`${source} badge must reuse the type-name lozenge style`);
      if (!badge.classList.contains(`approval-source-${source}`))
        throw new Error(`${source} badge must carry the approval-source-${source} class`);
      if (!badge.querySelector(`.${icon}`))
        throw new Error(`${source} badge must contain the ${icon} glyph`);
      if (!badge.textContent || !badge.textContent.trim())
        throw new Error(`${source} badge must carry a label`);
      if (!badge.title) throw new Error(`${source} badge must carry a descriptive tooltip`);
    }
    // Legacy/removed value 'auto' is no longer a known source — treated as unknown.
    for (const source of [undefined, '', 'auto', 'bogus']) {
      if (buildApprovalSourceBadge(/** @type {any} */ (source)) !== null)
        throw new Error(`approvalSource=${JSON.stringify(source)} must yield no badge`);
    }
    passed++;
  } catch (e) { failed++; errors.push(`approval-source badge: ${e.message}`); }

  // E2 — the images a tool call attached to its result (what the model saw)
  // show in its panel, captioned with what the plugin calls each one; a plugin
  // whose own details already draw them opts out, so they show once.
  try {
    const attachments = [
      { id: 'a1', mime: 'image/png', filename: '', bytes: 10, width: 4, height: 5 },
      { id: 'a2', mime: 'image/png', filename: '', bytes: 10, width: 4, height: 5 },
    ];
    class LabelledTool {
      renderToolActionDetails() {}
      static getResultSectionLabel() { return 'Output'; }
      static attachmentLabels(/** @type {any} */ stored) { return stored?.imageLabels || {}; }
    }
    class SelfDrawingTool {
      renderToolActionDetails() { return { skipResultSection: true, skipAttachments: true }; }
    }
    contextItemRegistry.getByToolName = (name) => ({ labelled: LabelledTool, selfdrawing: SelfDrawingTool })[name];
    const host = /** @type {any} */ ({
      _conversation: { id: 'conv1' },
      _messageThread: { items: [] },
      _selectedItemId: '1',
      _createSectionWithControls: () => document.createElement('properties-panel-section'),
      _renderToolActionControls: () => document.createElement('properties-panel-controls'),
    });
    const render = (/** @type {string} */ toolName) => {
      const box = document.createElement('div');
      // The result as a plain object: how a locally completed call holds it
      // (fakeItem's get-only stand-in has no toJSON, so plain() can't read it).
      const fields = /** @type {Record<string, any>} */ ({
        toolName, toolInput: {}, state: TOOL_STATES.COMPLETED, attachments,
        result: { content: 'done', fullResult: { success: true, result: { imageLabels: { a1: 'frames/fire-1.png' } } } },
      });
      renderToolAction(host, box, /** @type {any} */ ({ get: (/** @type {string} */ k) => fields[k] }));
      return box;
    };

    const shown = render('labelled');
    const thumbs = shown.querySelectorAll('.properties-panel-attachment-thumb');
    if (thumbs.length !== 2) throw new Error(`expected two thumbnails, got ${thumbs.length}`);
    const names = [...shown.querySelectorAll('.properties-panel-attachment-name')].map((n) => n.textContent);
    if (names.join('|') !== 'frames/fire-1.png|a2')
      throw new Error(`expected the label, then the id for the unlabelled one, got ${names.join('|')}`);

    const own = render('selfdrawing');
    if (own.querySelector('.properties-panel-attachments'))
      throw new Error('a plugin that draws its own images must not get them twice');
    passed++;
  } catch (e) { failed++; errors.push(`tool-action attachments: ${e.message}`); }
  finally { contextItemRegistry.getByToolName = realGetByToolName; }

  // F — en-XA: every word the properties panel's item renderers draw follows
  // the UI language, in every state. The data (provider, model, ids, results,
  // hook notes) is digits, so a string with no letter at all is data and is
  // left out; the formatted time is checked only for being there.
  try {
    await underPseudoLocale('tool-action-render-test', async () => {
      /** @type {{where: string, text: string}[]} */
      const shown = [];
      const collect = (/** @type {string} */ where, /** @type {string[]} */ strings) => {
        for (const text of strings) if (/\p{L}/u.test(text)) shown.push({ where, text });
      };
      /** @type {any[]} */
      const threadItems = [];
      const host = /** @type {any} */ ({
        _conversation: null,
        _messageThread: { items: threadItems },
        _selectedItemId: '1',
        _liveUpdater: null,
        // The panel's own chrome (properties-panel.js) is not this file's: the
        // stand-in draws only the header status this file passes it.
        _createSectionWithControls: (/** @type {any} */ _title, /** @type {any} */ _badge, /** @type {HTMLElement|null} */ controls, /** @type {string|HTMLElement|undefined} */ statusText) => {
          const section = document.createElement('properties-panel-section');
          const header = document.createElement('div');
          header.className = 'properties-panel-header';
          if (typeof statusText === 'string') {
            const span = document.createElement('span');
            span.textContent = statusText;
            header.appendChild(span);
          } else if (statusText) header.appendChild(statusText);
          section.appendChild(header);
          if (controls) section.appendChild(controls);
          return section;
        },
        _renderMessageControls: () => document.createElement('properties-panel-controls'),
        _renderContextItemControls: () => document.createElement('properties-panel-controls'),
        _renderToolActionControls: () => document.createElement('properties-panel-controls'),
      });
      const item = (/** @type {Record<string, any>} */ fields) => ({ get: (/** @type {string} */ k) => fields[k] });

      // An error item with provider, model, duration and time.
      const errBox = document.createElement('div');
      renderError(host, errBox, item({
        type: 'error', content: '7', timestamp: Date.now(),
        data: { provider: '1', model: '2', duration: 1500 },
      }));
      const timeSub = errBox.querySelector('properties-panel-subsection:last-of-type pre');
      assert(!!timeSub?.textContent?.trim(), 'the Time subsection shows no time');
      collect('error item', shownStrings(errBox, 'properties-panel-subsection:last-of-type pre'));

      // A user message with one attachment, then with two — the second an
      // unnamed image, whose thumbnail's alt text is the fallback word.
      for (const attachments of [
        [{ id: '1', filename: '1', bytes: 0 }],
        [{ id: '1', filename: '1', bytes: 0 }, { id: '2', mime: 'image/png', bytes: 0 }],
      ]) {
        const box = document.createElement('div');
        host._conversation = { id: '1' };
        try {
          renderMessage(host, box, item({ type: 'user', content: '1', attachments }));
        } finally { host._conversation = null; }
        collect(`user message, ${attachments.length} attachment(s)`, shownStrings(box, '.properties-panel-attachment-caption'));
        if (attachments.length === 2) {
          const thumb = box.querySelector('img');
          assert(!!thumb, 'the unnamed image drew no thumbnail');
          collect('unnamed image alt', [thumb?.alt || '<no alt>']);
        }
      }

      // A context item that throws while rendering, and the two marker forms.
      const throwing = {
        id: '1', getTitle: () => '1',
        createPropertiesPanelElement: () => { throw new Error('9'); },
      };
      const realConsoleError = console.error;
      console.error = () => {};
      try {
        const box = document.createElement('div');
        renderContextItem(host, box, /** @type {any} */ (throwing));
        collect('throwing context item', shownStrings(box));
      } finally { console.error = realConsoleError; }
      for (const itemId of ['1', '']) {
        const box = document.createElement('div');
        renderContextItem(host, box, item({ type: '1', itemId }));
        collect(`context marker ${itemId ? 'with' : 'without'} id`, shownStrings(box));
      }

      // Tool actions in every state, for a tool no plugin claims.
      const base = { type: 'tool-action', toolName: '1', toolUseId: '2', itemId: '3', toolInput: { 4: 5 } };
      const states = [
        ['pending approval', { state: TOOL_STATES.PENDING }],
        ['running, no start', { state: TOOL_STATES.RUNNING }],
        ['running, started', { state: TOOL_STATES.RUNNING, runningStartedAt: Date.now() - 3000 }],
        ['completed', { state: 'completed', result: { content: '6' } }],
        ['completed, timed', { state: 'completed', result: { content: '6', fullResult: { durationMs: 3000 } } }],
        ['failed, no text', { state: 'failed', result: { isError: true } }],
        ['failed, timed', { state: 'failed', result: { isError: true, content: '6', fullResult: { durationMs: 3000 } } }],
        ['cancelled', { state: 'cancelled', result: { cancelled: true } }],
        ['cancelled, timed', { state: 'cancelled', result: { cancelled: true, fullResult: { durationMs: 3000 } } }],
        ['no output', { state: 'completed', result: { content: '' } }],
        ...['user', 'rule', 'strategy', 'hook'].map((s) => [`approved by ${s}`, { state: 'completed', approvalSource: s, result: { content: '6' } }]),
      ];
      for (const [where, fields] of states) {
        const ta = item({ ...base, ...fields });
        threadItems.length = 0;
        threadItems.push(ta);
        host._liveUpdater = null;
        const box = document.createElement('div');
        renderToolAction(host, box, ta);
        // A run time is formatDuration's Intl output — data, not a message —
        // so the exact text it gives becomes a digit. The running fixture's
        // elapsed time is measured from Date.now(), so a loaded lane may read
        // more than 3s: any whole-second run time up to a minute is accepted,
        // longest first so "30s" is not read as "3s" plus a stray "0".
        const timed = /timed|started/.test(/** @type {string} */ (where));
        const asData = (/** @type {string} */ s) => {
          for (let n = 60; n >= 3; n--) s = s.replace(formatDuration(n), '9');
          return s;
        };
        collect(/** @type {string} */ (where), shownStrings(box).map((s) => (timed ? asData(s) : s)));
        // The live updater repaints the waiting text while approval is pending.
        if (where === 'pending approval') {
          assert(typeof host._liveUpdater === 'function', 'no live updater for a pending call');
          assert(host._liveUpdater() === true, 'the live updater gave up on a pending call');
          collect('pending approval, live', shownStrings(box));
        }
      }

      // Hooks: every verb a record can carry. Each line is judged on its own,
      // since a hook's reason and note (digits here) follow its summary line.
      const hooks = [
        { id: '1', source: 'extension', event: 'beforeTool', verdict: 'deny', reason: '2' },
        { id: '1', source: 'user', event: 'afterTool', verdict: 'ask', markError: true, note: '3', repeatSuppressed: true, error: '4' },
        { id: '1', source: 'user', event: 'beforeTool', verdict: 'allow' },
        { id: '1', source: 'extension', event: 'afterTool' },
      ];
      const hookBox = document.createElement('div');
      renderToolAction(host, hookBox, item({ ...base, state: 'completed', result: { content: '6' }, hooks }));
      const hookSub = [...hookBox.querySelectorAll('properties-panel-subsection')].pop();
      assert(!!hookSub, 'no Hooks subsection');
      collect('hooks heading', [hookSub?.querySelector('.properties-panel-subtitle')?.textContent || '']);
      collect('hooks text', (hookSub?.querySelector('pre')?.textContent || '').split('\n'));

      const raw = shown.filter((s) => !isPseudoLocalized(s.text));
      assert(shown.length >= 40, `expected at least 40 strings, found ${shown.length}`);
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    });
    passed++;
  } catch (e) { failed++; errors.push(`en-XA item renderers: ${e.message}`); }

  // G — en-XA: every fallback the transcript row itself draws, in every state,
  // for a tool no plugin draws a status UI for. The registry is pinned (no
  // plugin claims a tool name; action id '1' is a bare class with no manifest
  // name) so the lane's real registry decides nothing. Tool names, errors and
  // results are digits — data — and a string with no letter is left out.
  const realRegistry = {
    get: contextItemRegistry.get,
    getAll: contextItemRegistry.getAll,
    getByToolName: contextItemRegistry.getByToolName,
  };
  try {
    class Bare {}
    contextItemRegistry.getByToolName = /** @type {any} */ (() => undefined);
    contextItemRegistry.get = /** @type {any} */ ((/** @type {string} */ id) => (id === '1' ? Bare : undefined));
    contextItemRegistry.getAll = /** @type {any} */ (() => []);
    await underPseudoLocale('tool-action-render-test', async () => {
      /** @type {{where: string, text: string}[]} */
      const shown = [];
      const collect = (/** @type {string} */ where, /** @type {string[]} */ strings) => {
        for (const text of strings) if (/\p{L}/u.test(text)) shown.push({ where, text });
      };
      const row = (/** @type {Record<string, any>} */ fields) => {
        const r = /** @type {any} */ (document.createElement('tool-action-message'));
        r._getConversation = () => ({ session: {} });
        r._getMessageThread = () => ({ items: [] });
        r._getItem = () => fakeItem(fields);
        r._wrapWithIcon = (/** @type {HTMLElement} */ c) => c;
        return r;
      };
      const drawn = (/** @type {string} */ where, /** @type {Record<string, any>} */ fields) => {
        const r = row(fields);
        r.render();
        assert(r.childElementCount > 0, `${where}: nothing drawn`);
        collect(where, shownStrings(r));
      };

      // The footer's busy label, with and without a tool name.
      collect('busy, named', [row({ state: TOOL_STATES.RUNNING, toolName: '5' }).getBusyState()?.message || '<none>']);
      collect('busy, unnamed', [row({ state: TOOL_STATES.RUNNING }).getBusyState()?.message || '<none>']);

      drawn('pending approval', { state: TOOL_STATES.PENDING, toolName: '5' });
      drawn('running', { state: TOOL_STATES.RUNNING, toolName: '5' });
      drawn('cancelled, named', { state: TOOL_STATES.CANCELLED, toolName: '5', result: { cancelled: true } });
      drawn('cancelled, unnamed', { state: TOOL_STATES.CANCELLED, result: { cancelled: true } });
      drawn('unknown tool', { state: 'completed', toolName: '5', result: { fullResult: { success: false } } });
      drawn('completed', { state: 'completed', toolName: '5', result: { fullResult: { actionId: '1', success: true } } });
      drawn('failed', { state: 'completed', toolName: '5', result: { fullResult: { actionId: '1', success: false, error: '7' } } });
      drawn('result cancelled', { state: 'completed', toolName: '5', result: { fullResult: { actionId: '1', cancelled: true } } });
      drawn('result blocked', { state: 'completed', toolName: '5', result: { fullResult: { actionId: '1', blocked: true } } });

      // The review row above the approval buttons, before a strategy labels it.
      collect('review row, unlabelled', shownStrings(row({})._buildReviewStatusRow(undefined, true)));

      const raw = shown.filter((s) => !isPseudoLocalized(s.text));
      assert(shown.length >= 10, `expected at least 10 strings, found ${shown.length}: ${JSON.stringify(shown)}`);
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    });
    passed++;
  } catch (e) { failed++; errors.push(`en-XA tool-action row: ${e.message}`); }
  finally { Object.assign(contextItemRegistry, realRegistry); }

  return { passed, failed, errors };
}
