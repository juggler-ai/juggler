//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Exporting a conversation as one self-contained HTML page.
 *   1. The page fetches nothing and runs nothing: no script, no stylesheet
 *      link, no frame, no event handler, and every resource it shows (image
 *      sources, CSS urls) is a data: URI. Links a reader can follow are fine.
 *   2. It carries the conversation: messages rendered as Markdown, code
 *      highlighted, a one-line row per tool call, each sub-thread's goal and
 *      answer, and the "Made with Juggler" footer — and leaves out what the
 *      Markdown copy leaves out (standing context, thinking).
 *   3. What it reveals is the user's choice, conservative by default: tool
 *      inputs and outputs only with `includeToolDetails`, and file contents and
 *      images only with `includeFiles`.
 *   4. The dialog that asks: both options start off, it says what is never
 *      included and that nothing is uploaded, and Export saves the page.
 *   4b. A placeholder name ("Untitled N") is drawn in the UI language in the
 *      page's title and heading and in the suggested file name.
 *   5. Where it is offered: a tab's right-click menu, beside the Markdown copy,
 *      and `/export`, which asks the host for the dialog.
 * @module unit-tests/conversation-html-test
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../utilities/test-helpers.js';
import { conversationToHtml, exportFileName } from '../../js/utils/conversation-html.js';
import { openConversationExport } from '../../js/components/conversation-export-dialog.js';
import { displayConversationName } from '../../js/model/conversation-naming.js';
import { underPseudoLocale } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import '../../js/components/conversation-bar.js';
import Session from '../../js/model/session.js';
import ConversationRegistry from '../../js/model/conversation-registry.js';
import commandRegistry from '../../js/registries/command-registry.js';
import { resolveMenu } from '../../js/services/context-menu-service.js';

/** A 1×1 transparent PNG. */
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/**
 * Parse a page into an inert document: nothing in it loads or runs.
 * @param {string} html - The exported page.
 * @returns {Document} The parsed page.
 */
function parse(html) {
  const doc = document.implementation.createHTMLDocument('');
  doc.open();
  doc.write(html);
  doc.close();
  return doc;
}

/** Attributes that make a browser fetch what they name. */
const RESOURCE_ATTRS = ['src', 'srcset', 'poster', 'data', 'background', 'action', 'formaction', 'lowsrc', 'dynsrc'];

/**
 * Every way the page could reach outside itself or run code, as a list of
 * complaints; empty when it is self-contained.
 * @param {string} html - The exported page.
 * @returns {string[]} What is wrong with it.
 */
function selfContainmentProblems(html) {
  /** @type {string[]} */
  const problems = [];
  const doc = parse(html);
  for (const tag of ['script', 'link', 'iframe', 'frame', 'object', 'embed', 'base', 'noscript']) {
    if (doc.querySelector(tag)) problems.push(`has a <${tag}>`);
  }
  if (doc.querySelector('meta[http-equiv]')) problems.push('has a <meta http-equiv>');
  const isData = (/** @type {string} */ v) => /^\s*data:/i.test(v);
  const nonDataUrl = (/** @type {string} */ css) =>
    [...css.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)].map((m) => m[2]).filter((u) => !isData(u));
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of el.attributes) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) problems.push(`<${el.localName}> has a ${name} handler`);
      if (RESOURCE_ATTRS.includes(name) && !isData(attr.value)) {
        problems.push(`<${el.localName} ${name}="${attr.value.slice(0, 80)}">`);
      }
      if ((name === 'href' || name === 'xlink:href') && el.namespaceURI === 'http://www.w3.org/2000/svg'
        && !attr.value.startsWith('#') && !isData(attr.value)) {
        problems.push(`svg <${el.localName}> references ${attr.value.slice(0, 80)}`);
      }
      if (/^javascript:/i.test(attr.value.trim())) problems.push(`<${el.localName} ${name}> is a javascript: URL`);
    }
    const style = el.getAttribute('style');
    if (style) for (const u of nonDataUrl(style)) problems.push(`inline style url(${u.slice(0, 80)})`);
  }
  for (const sheet of doc.querySelectorAll('style')) {
    const css = sheet.textContent || '';
    if (/@import/i.test(css)) problems.push('a <style> uses @import');
    for (const u of nonDataUrl(css)) problems.push(`<style> url(${u.slice(0, 80)})`);
  }
  return problems;
}

/**
 * Run the conversation-html test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /**
   * @param {string} name - What the check is about.
   * @param {() => Promise<void>|void} fn - The check.
   */
  async function test(name, fn) {
    try { await fn(); passed++; } catch (e) { failed++; errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  }

  const session = await createTestSession();
  const conversation = await createTestConversation(session);
  const thread = conversation.rootMessageThread;
  thread.addEvent({ type: 'memory', content: 'STANDING-CONTEXT' });
  thread.addEvent({
    type: 'user',
    content: 'Fix the **build**',
    attachments: [{ id: 'sha-shot', mime: 'image/png', filename: 'shot.png', bytes: 68, width: 1, height: 1 }],
  });
  thread.addEvent({ type: 'thinking', content: 'PRIVATE-REASONING' });
  thread.addEvent({
    type: 'assistant',
    content: [
      'Looking.',
      '```js\nconst answer = 42;\n```',
      '![remote chart](https://example.com/chart.png)',
      '<script>window.__exportPwned = 1</script>',
      '<img src="https://example.com/beacon.png" onerror="window.__exportPwned = 2">',
    ].join('\n\n'),
  });
  thread.addEvent({
    type: 'tool-action', toolName: 'bash', toolUseId: 'tu-bash', state: 'completed',
    toolInput: { command: 'make test', description: 'Run the tests' },
    result: { content: 'BASH-OUTPUT-LINE', resultType: 'action', fullResult: { actionId: 'execute', success: true } },
  });
  thread.addEvent({
    type: 'tool-action', toolName: 'read', toolUseId: 'tu-read', state: 'completed',
    toolInput: { file_path: '/repo/src/secret.go' },
    result: {
      content: 'FILE-BODY-SECRET', resultType: 'action',
      fullResult: { actionId: 'read-file', success: true, result: { totalLines: 1, lineCount: 1, lineOffset: 1 } },
    },
  });
  thread.addEvent({ type: 'thread', goal: 'Trace the failure', result: 'It was the **linker**.', items: [] });
  thread.addEvent({ type: 'assistant', content: 'Fixed.' });

  /** @type {string[]} */
  const assetsAsked = [];
  /**
   * Stands in for the asset route, so the image is the test's and not a fetch.
   * @param {{id: string}} ref - The attachment.
   * @returns {Promise<string>} Its data URI.
   */
  const loadAsset = async (ref) => { assetsAsked.push(ref.id); return PIXEL; };

  const conservative = await conversationToHtml(conversation, { loadAsset });
  const withTools = await conversationToHtml(conversation, { loadAsset, includeToolDetails: true });
  const withAll = await conversationToHtml(conversation, { loadAsset, includeToolDetails: true, includeFiles: true });

  // --- 1: self-contained -----------------------------------------------------
  await test('self-contained', () => {
    assert(/^<!DOCTYPE html>/i.test(conservative), `a whole HTML document, got: ${conservative.slice(0, 80)}`);
    for (const [label, html] of [['default', conservative], ['tool details', withTools], ['everything', withAll]]) {
      const problems = selfContainmentProblems(html);
      assert(problems.length === 0, `${label} export reaches outside itself: ${problems.slice(0, 8).join('; ')}`);
    }
    const doc = parse(withAll);
    assert(!!doc.querySelector('style') && (doc.querySelector('style')?.textContent || '').length > 1000,
      'the app\'s styling travels inline in the page');
    // The sanitiser shows a disallowed tag as escaped text, as the transcript
    // does — so the script's source may be read on the page, but only as text.
    const inMarkup = Array.from(doc.querySelectorAll('*')).some((el) =>
      Array.from(el.attributes).some((a) => a.value.includes('__exportPwned'))
      || (el.localName === 'style' && (el.textContent || '').includes('__exportPwned')));
    assert(!inMarkup, 'authored script reaches the page only as visible text, never as markup or an attribute');
  });

  // --- 2: the conversation ---------------------------------------------------
  await test('content', () => {
    const doc = parse(conservative);
    const text = doc.body.textContent || '';
    assert(!!doc.querySelector('strong') && [...doc.querySelectorAll('strong')].some((s) => s.textContent === 'build'),
      'the user\'s Markdown is rendered');
    assert(text.includes('Looking.') && text.includes('Fixed.'), 'the agent\'s replies are there');
    const pre = [...doc.querySelectorAll('pre')].find((p) => (p.textContent || '').includes('const answer = 42;'));
    assert(!!pre, 'the fenced block is a <pre>');
    assert(!!pre?.querySelector('.token'), 'and it is syntax-highlighted');
    assert(!doc.querySelector('.copy-button, button'), 'no dead buttons from the live UI');
    const chart = [...doc.querySelectorAll('a')].find((a) => a.getAttribute('href') === 'https://example.com/chart.png');
    assert(!!chart, 'a remote image becomes a link to it rather than a fetch');
    assert(!doc.querySelector('img[src^="http"]'), 'no remote <img> survives');

    const tools = [...doc.querySelectorAll('.export-tool')];
    assert(tools.length === 2, `one row per tool call, got ${tools.length}`);
    assert((tools[0].textContent || '').includes('Run the tests') || (tools[0].textContent || '').includes('make test'),
      `the bash row says what it ran, got "${tools[0].textContent}"`);
    assert((tools[1].textContent || '').includes('secret.go'), `the read row names its file, got "${tools[1].textContent}"`);

    assert(text.includes('Trace the failure'), 'a sub-thread shows its goal');
    assert([...doc.querySelectorAll('strong')].some((s) => s.textContent === 'linker'), 'and its rendered answer');

    const footer = doc.querySelector('footer');
    assert(!!footer?.querySelector('a[href="https://juggler.studio"]'), 'and links to juggler.studio');

    assert(!text.includes('STANDING-CONTEXT'), 'standing context is not exported');
    assert(!text.includes('PRIVATE-REASONING'), 'thinking is not exported');
  });

  // --- 3: the options --------------------------------------------------------
  await test('conservative by default', () => {
    const doc = parse(conservative);
    assert(!conservative.includes('BASH-OUTPUT-LINE'), 'no tool output by default');
    assert(!conservative.includes('FILE-BODY-SECRET'), 'no file contents by default');
    assert(!doc.querySelector('.export-tool details'), 'a tool row has nothing to expand by default');
    assert(!doc.querySelector('img'), 'no images by default');
  });

  await test('tool details', () => {
    const doc = parse(withTools);
    const bash = doc.querySelectorAll('.export-tool')[0];
    const details = bash?.querySelector('details');
    assert(!!details && !details.open, 'the bash row expands, collapsed to start with');
    assert((details?.textContent || '').includes('BASH-OUTPUT-LINE'), 'to its output');
    assert((details?.textContent || '').includes('make test'), 'and its input');
    assert(!withTools.includes('FILE-BODY-SECRET'), 'a file read\'s body is still file contents, so still out');
    assert(!doc.querySelector('img'), 'images are still out');
  });

  await test('file contents and images', () => {
    const doc = parse(withAll);
    assert(withAll.includes('FILE-BODY-SECRET'), 'the read\'s body is in');
    const img = doc.querySelector('img');
    assert(img?.getAttribute('src') === PIXEL, `the attachment is inlined, got ${img?.getAttribute('src')?.slice(0, 40)}`);
    assert(assetsAsked.includes('sha-shot'), 'loaded through the asset loader');
  });

  // --- 4: the options dialog -------------------------------------------------
  await test('dialog', async () => {
    /** @type {Array<{name: string, content: string, mime: string}>} */
    const saved = [];
    /**
     * Stands in for the save path, so nothing is written.
     * @param {string} name - Suggested file name.
     * @param {string} content - The page.
     * @param {string} mime - Its type.
     * @returns {Promise<string>} Where it "went".
     */
    const save = async (name, content, mime) => { saved.push({ name, content, mime }); return `/tmp/${name}`; };
    const outcome = openConversationExport(conversation, { save, loadAsset });
    try {
      const panel = /** @type {HTMLElement|null} */ (document.querySelector('.conversation-export-dialog'));
      assert(!!panel, 'the dialog opens');
      const boxes = Array.from(panel?.querySelectorAll('input[type="checkbox"]') || []);
      assert(boxes.length === 2, `two options, got ${boxes.length}`);
      assert(boxes.every((b) => !/** @type {HTMLInputElement} */ (b).checked), 'both start off');
      const text = panel?.textContent || '';
      assert(/thinking/i.test(text) && /memory/i.test(text), 'it says what is never included');
      assert(/uploaded/i.test(text), 'and that nothing is uploaded');
      /** @type {HTMLElement|null} */ (panel?.querySelector('.conversation-export-commit'))?.click();
      const result = await outcome;
      assert(result.saved && result.path === `/tmp/${saved[0]?.name}`, `it reports where it went, got ${JSON.stringify(result)}`);
      assert(saved.length === 1 && saved[0].name.endsWith('.html') && saved[0].mime === 'text/html',
        `one HTML file saved, got ${JSON.stringify(saved.map((s) => [s.name, s.mime]))}`);
      assert(saved[0].content.startsWith('<!DOCTYPE html>') && saved[0].content.includes('Looking.'), 'the page is the conversation');
      assert(!saved[0].content.includes('BASH-OUTPUT-LINE') && !saved[0].content.includes('FILE-BODY-SECRET'),
        'with nothing ticked, the conservative export');
      assert(!document.querySelector('.conversation-export-dialog'), 'and the dialog has gone');
    } finally {
      document.querySelector('.conversation-export-overlay')?.remove();
    }
  });

  // --- 4b: a placeholder name is shown in the reader's language ---------------
  // The page and its file are for the user, so a stored "Untitled N" is drawn
  // as the UI draws it, N kept, in the title, the heading and the file name.
  await test('placeholder name', async () => {
    const untitled = { id: conversation.id, name: 'Untitled 3', rootMessageThread: conversation.rootMessageThread };
    await underPseudoLocale('conversation-html-test', async () => {
      const doc = parse(await conversationToHtml(untitled, { loadAsset }));
      const heading = doc.querySelector('h1')?.textContent || '';
      assert(isPseudoLocalized(heading) && heading.includes('3'), `"Untitled 3" headed the page as ${JSON.stringify(heading)}`);
      assert(doc.title.startsWith(heading), `the page's title leads with ${JSON.stringify(heading)}, got ${JSON.stringify(doc.title)}`);

      /** @type {string[]} */
      const names = [];
      const outcome = openConversationExport(untitled, {
        save: async (name) => { names.push(name); return null; }, loadAsset,
      });
      try {
        /** @type {HTMLElement|null} */ (document.querySelector('.conversation-export-commit'))?.click();
        await outcome;
      } finally {
        document.querySelector('.conversation-export-overlay')?.remove();
      }
      const expected = exportFileName(displayConversationName('Untitled 3'));
      assert(expected !== 'Untitled-3.html', `the fixture cannot tell the languages apart: ${expected}`);
      assert(names.length === 1 && names[0] === expected, `suggested file name ${JSON.stringify(names)}, expected ${expected}`);
    });
  });

  // --- 4c: a name in any script names the file ---------------------------------
  await test('file name in any script', async () => {
    /** @type {Array<[string, string]>} */
    const cases = [
      ['日本語の会話 2', '日本語の会話-2.html'],
      ['Café: notes/1', 'Café-notes-1.html'],
      ['Привет мир', 'Привет-мир.html'],
      ['a<b>c|d?"e"', 'a-b-c-d-e.html'],
      ['...', 'conversation.html'],
      ['???', 'conversation.html'],
    ];
    const wrong = cases
      .map(([name, want]) => ({ name, want, got: exportFileName(name) }))
      .filter(({ want, got }) => want !== got);
    assert(wrong.length === 0, `exportFileName got these wrong: ${JSON.stringify(wrong)}`);
    const long = exportFileName('😀'.repeat(100));
    assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(long), `a long name was cut inside a character: ${JSON.stringify(long.slice(-12))}`);
  });

  // --- 5: where it is offered -------------------------------------------------
  // A Session carrying only what the strip reads, over the real conversation,
  // as the Markdown copy's own test builds it.
  await test('tab menu', async () => {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:0;top:0;width:360px;height:900px;';
    try {
      const stripSession = /** @type {any} */ (Object.create(Session.prototype));
      stripSession.workspaces = [];
      stripSession.projectPath = '/tmp/project';
      stripSession.bin = { count: 0, sizeBytes: 0 };
      // The strip subscribes, but nothing it is shown here needs announcing.
      stripSession.events = { subscribe: () => () => {}, notify: () => {}, clear: () => {} };
      stripSession.registry = new ConversationRegistry();
      stripSession.registry.insert(conversation.id, conversation, 'test');
      stripSession.save = () => {};
      stripSession._requestConversationLoad = () => {};

      host.appendChild(document.createElement('conversation-tabs-container'));
      document.body.appendChild(host);
      const bar = /** @type {any} */ (document.createElement('conversation-bar'));
      host.appendChild(bar);
      bar._session = stripSession;
      bar.render();

      const tab = /** @type {Element|null} */ (
        bar.querySelector(`.conversation-bar-tab[data-conversation-id="${conversation.id}"]`));
      assert(!!tab, 'the strip draws a tab for the conversation');
      const labels = resolveMenu(/** @type {Element} */ (tab))?.items.map((item) => item.label) || [];
      const at = labels.indexOf('Export as HTML…');
      assert(at >= 0, `the tab's menu offers Export as HTML…, got ${JSON.stringify(labels)}`);
      assert(labels[at - 1] === 'Copy Conversation to Clipboard', 'right after the Markdown copy');

      await bar._exportConversationHtml(conversation.id);
      assert(!!document.querySelector('.conversation-export-dialog'), 'the row opens the export dialog');
    } finally {
      /** @type {HTMLElement|null} */ (document.querySelector('.conversation-export-cancel'))?.click();
      document.querySelector('.conversation-export-overlay')?.remove();
      host.remove();
    }
  });

  await test('/export', async () => {
    if (!commandRegistry.isInitialized()) await commandRegistry.init();
    const Export = /** @type {any} */ (commandRegistry.get('export'));
    assert(!!Export, '/export is a registered command');
    const result = await new Export({ messageThread: thread }).execute([]);
    assert(result?.handled === true, 'it handles itself');
    assert(JSON.stringify(result?.sideEffects) === JSON.stringify([{ type: 'openExportDialog' }]),
      `it asks the host for the dialog rather than opening it, got ${JSON.stringify(result?.sideEffects)}`);
  });

  return { passed, failed, errors };
}
