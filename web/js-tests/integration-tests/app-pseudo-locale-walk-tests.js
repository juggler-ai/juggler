//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Test: the real app shell under en-XA shows no plain English.
 *
 * The lane hosts the whole of index.html in a frame, served by the test server
 * in the pseudo-locale through `?uiLocale=en-XA` (serveIndex honours it only in
 * test mode, so the shared `uiLocale` setting every other lane reads is never
 * touched). The test's own conversation — a turn with tool rows, plus an error
 * and a notice seeded into its document — is selected in that shell, and each
 * main surface is checked in turn: header, conversation bar, the conversation
 * (transcript, composer, footer), the pinboard empty and with a pin, and every
 * Settings tab.
 *
 * Every surface is checked before the test fails, so one run lists everything
 * still in English rather than the first thing found.
 * @module integration-tests/app-pseudo-locale-walk-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';
import { pollPatiently, whyGivingUp } from '../utilities/test-patience.js';
import { budgetFor } from '../utilities/test-deadline.js';
import { plainToYMap } from '../../js/model/item-accessor.js';
import { createErrorMessage, createNoticeMessage } from '../../sdk/lib/message.js';
import { serverPath, apiUrl } from '../../js/utils/api-url.js';
import { fetchJson } from '../../js/services/http.js';
import { applyPinboardOperations } from '../../js/services/pinboard-operations-api.js';
import { boardId } from '../../js/utils/view-mode.js';
import { UNTITLED_NAME_RE } from '../../js/model/conversation-naming.js';
import { pseudoLocalize } from '../../sdk/lib/i18n.js';

/** Every Settings tab, in strip order (settings-panel.js). */
const SETTINGS_TABS = [
  'language', 'providers', 'defaults', 'connectivity', 'extensions', 'skills', 'mcp', 'acp',
  'appearance', 'notifications', 'shortcuts', 'logs', 'updates',
];

/**
 * Text that is data, not UI: what the conversation and project hold, which no
 * catalogue translates.
 * - `.ppd-path`: the project directory.
 * - `.user-message-text`: what the user typed; `.markdown`: what the model wrote.
 * - `.model-name`: the model's own display name.
 * - `.info-card__usage-sub`: the usage card's provider name and plan.
 * - `.properties-panel-filepath`: a file's path on disk.
 * - `#auto-name-instruction-input`: its placeholder is the built-in prompt sent
 *   to the model, which stays in English whatever the UI language.
 * - `.plugin-version`, `.plugin-author`: an extension's manifest fields.
 * - `code`, `pre`: tool arguments, paths and file content.
 * - `option[lang]`: a Language menu entry naming a language in itself
 *   ("简体中文"), which stays in that language whatever the UI language.
 */
const DATA = '.ppd-path, .user-message-text, .markdown, .model-name, .info-card__usage-sub, '
  + '#auto-name-instruction-input, .plugin-version, .plugin-author, .properties-panel-filepath, '
  + 'code, pre, option[lang]';

/**
 * Whether an element shows data. Besides {@link DATA}, a conversation tab's name
 * is data — another test's title, or the auto-namer's — unless it is a stored
 * placeholder ("Untitled N"), the one name that is UI: displayConversationName
 * translates it, so one still showing in that English shape is a finding.
 * @param {Element} el
 * @returns {boolean} True for data.
 */
function isData(el) {
  if (el.closest(DATA)) return true;
  // Text marked as another language than the page's is in that language on
  // purpose — the Language menu names each language in itself ("中文（中国）"),
  // and marks it with its own lang — so it is not a message left untranslated.
  // The app's own <html>, not this test page's: the walk reads an iframe.
  const page = el.ownerDocument.documentElement;
  const marked = el.closest('[lang]');
  if (marked && marked !== page && marked.getAttribute('lang') !== page.lang) return true;
  const name = el.closest('.conversation-tab-name');
  return !!name && !UNTITLED_NAME_RE.test((name.textContent || '').trim());
}

/** Inline elements whose text is part of the message around them. */
const INLINE = new Set(['SPAN', 'CODE', 'A', 'STRONG', 'EM', 'B', 'I', 'KBD']);

/**
 * Whether a shown string is translated, for a whole-app walk with real data in
 * it. A translated message carries the en-XA wrapper — `[` … ` ·…·]` — around
 * whatever data it was given (a path, a name, a date), so the wrapper is the
 * test, line by line for a tooltip built from several messages. Letter-free text
 * (a keycap like ↵ or ⌘N, a drag handle ⠿, a count, `@` or `/`) is no message at
 * all and has nothing to translate.
 * @param {string} s
 * @returns {boolean} True when `s` is translated or is not words.
 */
function translatedOrSymbol(s) {
  if (!/\p{L}/u.test(s)) return true;
  // A key chord's key (N, F2) is labelled on the keyboard rather than
  // translated. On macOS the modifiers are glyphs (⌘N, ⌥⇧⌘M); elsewhere they are
  // words joined by `+`, each one a message ([Çţŕļ ·]+N) — and the `+` key
  // itself makes the chord end in `++`.
  const key = /^(?:[A-Z0-9]|F\d{1,2}|\P{L}+)$/u;
  const chord = s.trim();
  if (/^[⌘⌥⇧⌃]*(?:[A-Z0-9]|F\d{1,2})$/.test(chord)) return true;
  const parts = chord.endsWith('++') ? [...chord.slice(0, -2).split('+'), '+'] : chord.split('+');
  if (parts.length > 1 && parts.every((p) => key.test(p) || isTranslatedLine(p))) return true;
  return s.split('\n').map((l) => l.trim()).filter(Boolean).every(isTranslatedLine);
}

/**
 * @param {string} line
 * @returns {boolean} True when `line` carries the en-XA wrapper.
 */
function isTranslatedLine(line) {
  return line.startsWith('[') && /\s·+\]$/.test(line);
}

/**
 * Every string `root` shows — text judged per element as one string, with an
 * inline child's text joined to its parent's (so a message split into spans
 * around a count is read whole), plus aria-label, title and placeholder —
 * minus the elements `skip` says are data.
 * @param {Element} root
 * @param {(el: Element) => boolean} skip
 * @returns {string[]} The strings.
 */
function shownText(root, skip) {
  /** @type {Map<Element, string>} */
  const blocks = new Map();
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (!parent || skip(parent) || parent.closest('script, style')) continue;
    let block = parent;
    while (block !== root && block.parentElement && INLINE.has(block.parentElement.tagName)) block = block.parentElement;
    blocks.set(block, (blocks.get(block) || '') + (n.textContent || ''));
  }
  const shown = [...blocks.values()].map((s) => s.trim()).filter(Boolean);
  for (const node of root.querySelectorAll('[aria-label], [title], [placeholder]')) {
    if (skip(node)) continue;
    for (const attr of ['aria-label', 'title', 'placeholder']) {
      const v = node.getAttribute(attr);
      if (v) shown.push(v);
    }
  }
  return shown;
}

/**
 * What the shell is showing, for a failure that has to say why it stopped.
 * @returns {string} A line to append, or '' before the shell has a session.
 */
let describeShell = () => '';

/**
 * Where the walk has got to — the conversation's name and the findings so
 * far — for a failure that has to say where it stopped.
 * @returns {string} Lines to append, or '' outside a walk.
 */
let describeWalk = () => '';

/**
 * Wait for `probe` to be truthy within the test's deadline, or throw.
 *
 * The wait's description is read when a report asks for it, so a walk the
 * runner fails for making no progress is reported at the wait it stopped in,
 * with the shell's state and the findings as they stand then.
 * @template T
 * @param {() => T} probe
 * @param {string} what - What is awaited, for the failure.
 * @param {number} [nominalMs]
 * @returns {Promise<T>} The probe's truthy value.
 */
async function until(probe, what, nominalMs = 10000) {
  const got = await pollPatiently(() => {
    try { return probe(); } catch { return null; }
  }, { nominalMs: budgetFor(nominalMs), intervalMs: 50, what: () => `${what}${describeShell()}${describeWalk()}` });
  if (!got) throw new Error(`timed out waiting for ${what} — ${await whyGivingUp()}${describeShell()}`);
  return /** @type {T} */ (got);
}

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const appPseudoLocaleWalkTest = {
  name: 'app-pseudo-locale-walk',
  description: 'The full app shell served under en-XA shows no plain English on its main surfaces',
  fixture: 'unit-test-fixture',
  timeoutMs: 90000,

  llmResponses: [
    toolUseResponse('call_1', 'read', { file_path: 'src/main.go' }, 'Reading.'),
    toolUseResponse('call_2', 'read', { file_path: 'does-not-exist.txt' }, 'Reading again.'),
    textResponse('Done.'),
  ],

  operations: [
    { type: 'send-message', message: 'Read two files' },
  ],

  customAssertions: async (conversation) => {
    // The name the conversation was given by the time its turn has run, quoted in
    // a failure so a title in the bar can be told from a placeholder.
    const nameAfterTurn = conversation.name;
    // Seeded in the wrapper's shape: what an error or a notice says is the test's
    // own data, and only the UI around it is under test.
    const rootThread = conversation.rootMessageThread;
    rootThread.insertAt(rootThread.length, plainToYMap(createErrorMessage({ message: '[Ẽŕŕöŕ ðåţå ···]' })));
    rootThread.insertAt(rootThread.length, plainToYMap(createNoticeMessage({ summary: '[Ñöţîçé ðåţå ···]', detail: '', source: 'test' })));

    // The board the shell will show is the project's shared one; put it back
    // as it was found.
    const board = boardId();
    const before = await fetchJson(apiUrl(`/session/pinboard?board=${encodeURIComponent(board)}`));
    const pinsBefore = new Set((before?.pins || []).map((/** @type {any} */ p) => p.id));

    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1280px;height:800px;border:0';
    frame.src = serverPath('/') + '?uiLocale=en-XA';
    document.body.appendChild(frame);

    /** @type {string[]} */
    const findings = [];
    // The shell renders chords for the platform it runs on, so the walk sees
    // one form or the other; each form is judged here on every platform.
    const chords = {
      [`${pseudoLocalize('Ctrl')}+${pseudoLocalize('Shift')}+N`]: true,
      [`${pseudoLocalize('Ctrl')}+${pseudoLocalize('Enter')}`]: true,
      [`${pseudoLocalize('Ctrl')}+F2`]: true,
      [`${pseudoLocalize('Ctrl')}++`]: true,
      '⌥⇧⌘M': true,
      'Ctrl+N': false,
      'Ctrl++': false,
      [`${pseudoLocalize('Ctrl')}+Enter`]: false,
    };
    for (const [chord, ok] of Object.entries(chords)) {
      if (translatedOrSymbol(chord) !== ok) findings.push(`the walk misjudges the key chord ${JSON.stringify(chord)} as ${ok ? 'English' : 'translated'}`);
    }
    /**
     * @param {Element|null|undefined} root
     * @param {string} where
     * @param {{skip?: (el: Element) => boolean, atLeast?: number}} [opts]
     */
    const check = (root, where, { skip = isData, atLeast = 1 } = {}) => {
      if (!root) {
        findings.push(`${where}: not found`);
        return;
      }
      const shown = shownText(root, skip);
      if (shown.length < atLeast) findings.push(`${where}: expected at least ${atLeast} strings, found ${shown.length}`);
      const raw = [...new Set(shown.filter((s) => !translatedOrSymbol(s)))];
      if (raw.length) findings.push(`plain English under en-XA (${where}): ${JSON.stringify(raw)}`);
    };

    // A walk that stops moving is failed by the runner's stall watchdog, whose
    // report lists the waits in flight: `until` describes each with where the
    // walk has got to, so the report says where it stopped.
    describeWalk = () => `\n  conversation named ${JSON.stringify(nameAfterTurn)}\n  findings so far:\n  ${findings.join('\n  ')}`;
    try {
      await walkShell();
    } finally {
      describeShell = () => '';
      describeWalk = () => '';
      frame.remove();
      const after = await fetchJson(apiUrl(`/session/pinboard?board=${encodeURIComponent(board)}`)).catch(() => null);
      const added = (after?.pins || []).filter((/** @type {any} */ p) => !pinsBefore.has(p.id));
      if (added.length) {
        await applyPinboardOperations(board, added.map((/** @type {any} */ p) => ({ op: 'remove', id: p.id })));
      }
    }

    if (findings.length) {
      throw new Error(`${findings.length} surface(s) show plain English under en-XA (conversation named ${JSON.stringify(nameAfterTurn)}):\n  ${findings.join('\n  ')}`);
    }

    /** @returns {Promise<void>} Resolves once every surface is checked. */
    async function walkShell() {
      const win = /** @type {any} */ (frame.contentWindow);
      await until(() => frame.contentDocument?.documentElement.getAttribute('data-ui-locale') === 'en-XA',
        'the shell to be served in en-XA');
      const session = await until(() => win.jugglerApp?.getSession()?.conversations.get(conversation.id) && win.jugglerApp.getSession(),
        'the shell to load this conversation', 20000);
      const doc = /** @type {Document} */ (frame.contentDocument);
      /** @returns {any} The shell's tab for this conversation, from the shell's own tab bar. */
      const ownTab = () => /** @type {any} */ (doc.querySelector('conversation-bar'))?.getTabElement?.(conversation.id) ?? null;
      describeShell = () => {
        const own = /** @type {any} */ (session.conversations.get(conversation.id));
        const t = ownTab();
        const active = /** @type {any} */ (doc.querySelector('conversation-tab.active'));
        return `\n  shell: visible=${session.visibleConversationId} own=${conversation.id}`
          + ` ownTab=${t ? (t.isConnected ? 'connected' : 'detached') : 'none'}`
          + ` ownToolRows=${t ? t.querySelectorAll('tool-action-message, tool-group-message').length : '-'}`
          + ` ownRows=${t ? t.querySelectorAll('#message-list > *').length : '-'}`
          + ` ownItems=${own?.rootMessageThread?.length ?? '-'}`
          + ` activeTabConv=${active?.getConversation?.()?.id || 'none'}`
          + ` tabs=${doc.querySelectorAll('conversation-tab').length}`
          + ` ownTabText=${JSON.stringify((t?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200))}`;
      };
      // The shell opens on the project's stored active conversation, which another
      // lane may have moved. Only a switch announces itself to the bar and shows
      // the tab; a bare registry.select() would mark ours visible behind a tab that
      // stays hidden and unrendered.
      session.switchConversation(conversation.id);
      const tab = await until(() => {
        const t = ownTab();
        return t && t.querySelector('tool-action-message, tool-group-message') ? t : null;
      }, 'the conversation to render its tool rows', 20000);
      await until(() => !doc.querySelector('[data-loading-overlay="startup"]:not([hidden])')
        || doc.querySelector('[data-loading-overlay="startup"]')?.classList.contains('hidden')
        || win.getComputedStyle(doc.querySelector('[data-loading-overlay="startup"]')).display === 'none',
      'the startup overlay to go', 10000).catch((e) => findings.push(String(e.message)));

      // The shell under test is the one a user gets: nothing in it knows a test
      // server served it, so the info rail mounts here as it does for them, and
      // the conversation-bar check below reads its cards too.
      const rail = /** @type {HTMLElement|null} */ (doc.querySelector('conversation-bar info-rail'));
      if (!rail || rail.hidden) findings.push(`the hosted shell's info rail is ${rail ? 'hidden' : 'missing'} — it is mounted for users`);
      if ('JUGGLER_TEST_MODE' in win) findings.push('the hosted shell was told it is under test (window.JUGGLER_TEST_MODE)');
      check(doc.querySelector('.app-header'), 'header');
      check(doc.querySelector('conversation-bar'), 'conversation bar');
      check(tab, 'conversation (transcript, composer, footer)');

      // Pinboard, empty and then with a pin.
      /** @type {HTMLElement} */ (doc.querySelector('#pinboard-header-button')).click();
      const shell = /** @type {HTMLElement} */ (doc.querySelector('pinboard-shell'));
      await until(() => !shell.hidden, 'the pinboard to open');
      check(shell, 'pinboard');
      const pinId = `pin_walk_${Date.now().toString(36)}`;
      await applyPinboardOperations(board, [{ op: 'add', id: pinId, type: 'git', config: {} }]);
      await until(() => shell.textContent && shell.querySelector(`[data-pin-id="${pinId}"], .pinboard-tab, .pin-tab`),
        'the git pin to appear').catch((e) => findings.push(String(e.message)));
      check(shell, 'pinboard with a git pin');

      // Settings, every tab.
      /** @type {HTMLElement} */ (doc.querySelector('#settings-button')).click();
      const panel = /** @type {any} */ (await until(() => doc.querySelector('settings-panel'), 'the settings panel'));
      // open() adds `loaded` once its first load has settled (settings-panel.js).
      await until(() => panel.classList.contains('loaded'), 'settings to load', 15000);
      check(panel.querySelector('.settings-tabs'), 'settings tab strip');
      for (const id of SETTINGS_TABS) {
        panel.switchTab(id);
        const section = panel.querySelector(`#tab-${id}`);
        await until(() => section && section.textContent.trim(), `settings tab ${id} to render`)
          .catch((e) => findings.push(String(e.message)));
        check(section, `settings: ${id}`);
      }
      panel.close?.();
    }
  },
};

export const tests = [appPseudoLocaleWalkTest];
