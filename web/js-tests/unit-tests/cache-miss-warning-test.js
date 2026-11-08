//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Display tests for context-cache misses. The two warnings are about different
 * moments and live in different places: a miss that has ALREADY happened is a
 * notice item standing in the transcript, and the composer's button speaks only
 * about the send the user has not made yet.
 * @module unit-tests/cache-miss-warning-test
 */

import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale, assertPseudoLocalized } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized, pseudoLocalize } from '../../sdk/lib/i18n.js';
import '../../js/components/composer.js';
import NoticeMessage from '../../js/components/notice-message.js';
import { buildPrefixFingerprint, classifyContextCacheImpact } from '../../js/services/context-cache-impact.js';
import { typeNameForItem } from '../../js/utils/item-badge.js';
import { registerSettingsOpener } from '../../js/services/settings-launcher.js';
import { formatTokens } from '../../js/utils/format.js';

/**
 * @returns {{box: any, container: HTMLElement, metadata: Map<string, any>, notify: (key: string) => void}} Mounted composer and metadata controls
 */
function mountComposer() {
  const metadata = new Map();
  /** @type {((event: any) => void)|null} */
  let observer = null;
  const conversation = {
    processingState: undefined,
    isTurnActive: () => true,
    observeMetadata: (/** @type {(event: any) => void} */ cb) => { observer = cb; },
    unobserveMetadata: () => {},
  };
  Object.defineProperty(conversation, 'processingState', {
    get: () => metadata.get('processingState'),
  });

  const container = document.createElement('div');
  const box = /** @type {any} */ (document.createElement('composer-box'));
  container.appendChild(box);
  document.body.appendChild(container);
  box.setupListeners();
  box.setupListeners = () => {};
  box.setConversation(conversation);
  box.threadItemId = null;

  return {
    box,
    container,
    metadata,
    notify(key) { observer?.({ keysChanged: new Set([key]) }); },
  };
}

/**
 * A plain-object stand-in for a conversation item Y.Map — enough for the
 * fingerprint's `.get()` reads.
 * @param {Record<string, any>} fields - The item's fields
 * @returns {{get: (key: string) => any}} A Y.Map-shaped item
 */
function item(fields) {
  return { get: (key) => fields[key] };
}

/**
 * Run cache-miss display tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test counts and errors
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * Run one test case and collect its outcome.
   * @param {string} name - Test case name
   * @param {() => void} fn - Test case body
   */
  function test(name, fn) {
    try { fn(); passed++; }
    catch (e) { failed++; errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  }

  test('the composer button stays silent about a miss that already happened', () => {
    const { box, container, metadata, notify } = mountComposer();
    try {
      // The worker no longer writes a cache-miss into processingState, but a
      // stale doc from an older build might: the button must ignore it either
      // way, because a past-tense miss is the notice item's business.
      metadata.set('processingState', {
        status: 'streaming',
        startedAt: 123,
        threadItemId: '',
        cacheMissReason: 'diverged: system prompt changed',
      });
      notify('processingState');

      const warning = /** @type {HTMLElement|null} */ (box.querySelector('#context-cache-warning'));
      assert(!!warning, 'cache warning button must exist');
      assert(warning.hasAttribute('hidden'),
        'a miss that already happened must not reveal the predictive warning');
    } finally {
      container.remove();
    }
  });

  test('the composer button still warns about the next send', () => {
    const { box, container } = mountComposer();
    try {
      const warning = /** @type {HTMLElement|null} */ (box.querySelector('#context-cache-warning'));
      assert(!!warning?.hasAttribute('hidden'), 'warning starts hidden');

      box._cacheImpactWarning = true;
      box._updateCacheWarningButton();
      assert(!warning.hasAttribute('hidden'), 'a predicted bust must reveal the warning');
      assert((warning.getAttribute('title') || '').includes('next message'),
        `warning must speak about the send not yet made, got ${warning.getAttribute('title')}`);

      box._cacheImpactWarning = false;
      box._updateCacheWarningButton();
      assert(warning.hasAttribute('hidden'), 'warning clears when the prefix matches again');
    } finally {
      container.remove();
    }
  });

  test('a notice explains itself on the row, under a fixed Warning lozenge', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const explanation = 'Claude Code re-read the whole conversation';
    try {
      const el = /** @type {any} */ (document.createElement('notice-message'));
      el.setAttribute('message-id', 'NOTICE_1');
      el.setAttribute('notice-text', explanation);
      container.appendChild(el);

      assert(el instanceof NoticeMessage, 'notice-message must upgrade to the NoticeMessage class');
      const badge = el.querySelector('.message-icon-badge .context-item-type-badge');
      assert(!!badge, 'notice must label itself with a lozenge beside the icon');
      assert(badge.textContent === 'Warning',
        `lozenge names the kind of item, got ${badge.textContent}`);
      assert(!!el.querySelector('.message-icon-box svg'), 'notice must keep its warning triangle');
      // The whole point: a reader who never opens the panel is still told why
      // the row is there.
      assert((el.textContent || '').includes(explanation),
        `the row must carry the explanation, got ${el.textContent}`);
      assert(!el.querySelector('button'), 'a notice reports; it must offer no action button');
    } finally {
      container.remove();
    }
  });

  // The row is a transcript row like any other: its triangle sits at the
  // column's left edge, whatever any whole-window message's stylesheet does
  // with a class of a similar name.
  test('a notice row starts at the left edge of its column', () => {
    const container = document.createElement('div');
    container.style.width = '40rem';
    document.body.appendChild(container);
    try {
      const el = /** @type {any} */ (document.createElement('notice-message'));
      el.setAttribute('message-id', 'NOTICE_LEFT');
      el.setAttribute('notice-text', 'Claude Code re-read the whole conversation');
      container.appendChild(el);

      const icon = /** @type {HTMLElement|null} */ (el.querySelector('.message-icon-box'));
      assert(!!icon, 'notice must draw its icon');
      // Measured from the row's article, inside the gutter every row shares.
      const article = /** @type {HTMLElement} */ (el.querySelector('article'));
      const offset = icon.getBoundingClientRect().left - article.getBoundingClientRect().left;
      assert(Math.abs(offset) < 1,
        `the triangle must sit at the row's left edge, but is ${offset}px in from it`);
    } finally {
      container.remove();
    }
  });

  // A notice about an assumed context window names the one field that fixes
  // it, so it carries one action: the deep link to that field. Nothing else
  // grows a button — the case above still stands for every other notice.
  test('a notice that names a setting links straight to it', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    /** @type {Array<{tab: string|undefined, options: any}>} */
    const opened = [];
    const restore = registerSettingsOpener((tab, options) => { opened.push({ tab, options }); });
    try {
      const el = /** @type {any} */ (document.createElement('notice-message'));
      el.setAttribute('message-id', 'NOTICE_2');
      el.setAttribute('notice-text', 'Compacting at an assumed 8192-token context window for qwen');
      el.setAttribute('notice-settings', JSON.stringify(
        { tab: 'providers', provider: 'local', model: 'qwen', field: 'contextWindow' }));
      container.appendChild(el);

      const button = /** @type {HTMLButtonElement|null} */ (el.querySelector('button'));
      assert(!!button, 'a notice with a settings target must offer its link');
      assert(/context window/i.test(button.textContent || ''),
        `the action must say what it opens, got ${JSON.stringify(button.textContent)}`);
      button.click();
      assert(opened.length === 1 && opened[0].tab === 'providers'
        && opened[0].options?.model?.provider === 'local' && opened[0].options?.model?.id === 'qwen',
      `the action opened ${JSON.stringify(opened)}, want the providers tab at local/qwen`);
    } finally {
      restore();
      container.remove();
    }
  });

  // A notice offering a one-off retry at a larger Max output carries that one
  // action, and only while it is the thread's last item: once the conversation
  // has moved on, re-running the turn would rewrite history under it.
  test('a truncation notice offers its retry while it is the last word', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    /** @type {string[]} */
    const retried = [];
    try {
      const el = /** @type {any} */ (document.createElement('notice-message'));
      el.setAttribute('message-id', 'NOTICE_RETRY');
      el.setAttribute('notice-text', 'The model hit its output limit before it finished, so this turn stops mid-reply.');
      el.setAttribute('notice-retry-max-output', '65536');
      el._getMessageThread = () => ({ retryTruncatedTurn: (/** @type {string} */ id) => { retried.push(id); } });
      container.appendChild(el);
      assert(!el.querySelector('.notice-retry-btn'), 'a notice the thread has moved past offers no retry');

      el.setAttribute('item-final', '');
      const button = /** @type {HTMLButtonElement|null} */ (el.querySelector('.notice-retry-btn'));
      assert(!!button, 'the last-word truncation notice must offer its retry');
      assert((button.textContent || '').includes(formatTokens(65536)),
        `the action must name the Max output it retries at, got ${JSON.stringify(button.textContent)}`);
      button.click();
      assert(retried.length === 1 && retried[0] === 'NOTICE_RETRY', `retry asked for ${JSON.stringify(retried)}`);
    } finally {
      container.remove();
    }
  });

  test('the panel labels a notice the same way the row does', () => {
    const notice = item({ type: 'notice', summary: 'Cache miss happened', content: 'lead\n\nReason: diverged' });
    assert(typeNameForItem(notice) === 'Warning',
      `panel header must wear the same lozenge as the row, got ${typeNameForItem(notice)}`);
    assert(typeNameForItem(item({ type: 'notice' })) === 'Warning',
      'the lozenge is the item kind, so it never depends on the notice having text');
  });

  test('adding and removing a notice never reads as a cache bust', () => {
    const history = [
      item({ itemId: 'MSG_1', type: 'user', content: 'x'.repeat(40000) }),
      item({ itemId: 'MSG_2', type: 'assistant', content: 'y'.repeat(40000) }),
    ];
    const baseline = buildPrefixFingerprint({ toolsetSig: 'a,b', items: history });

    // A notice inserted mid-history must not shift the fingerprint at all: it
    // is not in the cached prefix, so it cannot have moved it.
    const withNotice = buildPrefixFingerprint({
      toolsetSig: 'a,b',
      items: [history[0], item({ itemId: 'NOTICE_1', type: 'notice', content: 'z'.repeat(500) }), history[1]],
    });
    assert(withNotice.join('|') === baseline.join('|'),
      'a notice must contribute nothing to the prefix fingerprint');

    // And tidying it away again must not caution about a bust that never happens.
    const impact = classifyContextCacheImpact({
      baseline: withNotice,
      current: baseline,
      anchorTokens: 50000,
    });
    assert(impact === 'none', `deleting a notice must stay silent, got ${impact}`);
  });

  // Under en-XA the row's own text — the lozenge, and the settings link with its
  // tooltip — is translated, in the row and the panel header alike. The notice's
  // sentence comes from the worker; here it is already pseudo-localised, and the
  // model's name is a digit, so only the row's text is under test.
  try {
    await underPseudoLocale('cache-miss-warning-test', () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      try {
        const el = /** @type {any} */ (document.createElement('notice-message'));
        el.setAttribute('message-id', 'NOTICE_XA');
        el.setAttribute('notice-text', pseudoLocalize('Something happened'));
        el.setAttribute('notice-settings', JSON.stringify(
          { tab: 'providers', provider: 'local', model: '1', field: 'contextWindow' }));
        container.appendChild(el);
        assert(!!el.querySelector('.notice-settings-btn'), 'no settings link');
        assertPseudoLocalized(el, { atLeast: 4, where: 'notice with a settings link' });

        const retry = /** @type {any} */ (document.createElement('notice-message'));
        retry.setAttribute('message-id', 'NOTICE_XA_RETRY');
        retry.setAttribute('notice-text', pseudoLocalize('Something happened'));
        retry.setAttribute('notice-retry-max-output', '1');
        retry.setAttribute('item-final', '');
        container.appendChild(retry);
        assert(!!retry.querySelector('.notice-retry-btn'), 'no retry button');
        assertPseudoLocalized(retry, { atLeast: 3, where: 'notice with a retry' });
        const lozenge = typeNameForItem(item({ type: 'notice' }));
        assert(isPseudoLocalized(lozenge), `panel lozenge ${JSON.stringify(lozenge)}`);
      } finally {
        container.remove();
      }
    });
    passed++;
  } catch (e) {
    failed++;
    errors.push(`en-XA: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
