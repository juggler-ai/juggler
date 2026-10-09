//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Slash-command completions on the composer.
 *
 * Typing `/` at the START of a message activates the shared caret-anchored
 * completion menu (the same one `@` file-mentions use), populated from the
 * registered slash commands. This suite pins:
 *   1. the slash provider triggers only at message start (a bare `/`, `/cl`),
 *      never mid-message and never for an `@` mention,
 *   2. its fetch is filtered by the typed prefix and offers /clear,
 *   3. accepting a command splices `/name ` and, for an argument-less command,
 *      runs it on that same keystroke (submitAfterAccept → menu.onSubmit) so the
 *      popup never asks for a second Enter; a command taking arguments splices
 *      the text and waits for the user to type them,
 *   4. Tab is a completion key: it splices the command and leaves sending to
 *      the user, even for a command Enter would have run outright,
 *   5. the composer wires slash + file-mention providers into one menu, with
 *      slash taking precedence at the message start,
 *   6. the `@` provider and the send-time existence check both ask about the
 *      tree the composer's conversation works in — the one its mentions are
 *      read from — and ask about the project only when it works there.
 *
 * Assertions read SYNCHRONOUS, deterministic state: `handleInput()` selects the
 * active provider and anchor before it kicks off the (debounced) fetch, the
 * provider's `fetch`/`insert` are awaited/called directly, and `accept()` is
 * driven from explicit menu state exactly as the `@`-mention test driver does.
 * The debounced fetch and the layout-dependent popup surface are deliberately
 * NOT exercised here — background-window timer throttling makes them racy, and
 * the provider contract above is what actually matters.
 * @module unit-tests/slash-completion-test
 */

import { initializeRegistries, assert } from '../utilities/test-helpers.js';
import slashCommandHandler from '../../js/services/slash-command-handler.js';
import { slashCommandProvider } from '../../js/components/slash-command-provider.js';
import { extractFileMentionsAsync } from '../../js/components/file-mention-provider.js';
import '../../js/components/composer.js';

/**
 * Mount an <composer-box> and bind its listeners synchronously (render() defers
 * setupListeners() to rAF, which never pumps in the hidden test window).
 * @returns {{box: any, textarea: HTMLTextAreaElement, container: HTMLElement}} The mounted composer-box, its textarea and container.
 */
function mountComposer() {
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:480px;height:600px;';
  const box = document.createElement('composer-box');
  container.appendChild(box); // connectedCallback → render() writes the DOM now
  document.body.appendChild(container);

  /** @type {any} */ (box).setupListeners();
  /** @type {any} */ (box).setupListeners = () => {};

  const textarea = /** @type {HTMLTextAreaElement} */ (box.querySelector('textarea'));
  assert(!!textarea, 'composer-box must render a textarea');
  return { box, textarea, container };
}

/**
 * Run the slash-command completion suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts and any error messages.
 */
export async function runTests() {
  await initializeRegistries();
  await slashCommandHandler.init();

  let passed = 0;
  let failed = 0;
  const errors = [];

  // ── Test 1: provider triggers only at message start; fetch filters ────────
  {
    try {
      // detect() is the trigger gate — synchronous and pure.
      const bare = slashCommandProvider.detect('/');
      assert(!!bare && bare.anchorPos === 0 && bare.query === '',
        `"/" must trigger at anchor 0 with empty query, got ${JSON.stringify(bare)}`);

      const partial = slashCommandProvider.detect('/cl');
      assert(!!partial && partial.anchorPos === 0 && partial.query === 'cl',
        `"/cl" must trigger with query "cl", got ${JSON.stringify(partial)}`);

      assert(slashCommandProvider.detect('run /cl') === null,
        'a "/" that is not at the message start must NOT trigger');
      assert(slashCommandProvider.detect('@src/main.go') === null,
        'an @-mention must NOT trigger the slash provider');
      assert(slashCommandProvider.detect('/two words') === null,
        'once a space is typed the command name is settled — no trigger');

      // fetch() is registry-backed; await it directly (no debounce). The list is
      // bracketed by synthetic rows (no `name`) — the two pinned buttons and the
      // "New command…" row; real commands are isolated by dropping them all.
      const realNames = (/** @type {any[]} */ items) => items.filter((c) => typeof c.name === 'string').map((c) => c.name);
      const bareItems = await slashCommandProvider.fetch('');
      const all = realNames(bareItems);
      assert(all.includes('clear'), `fetch("") must offer /clear, got ${JSON.stringify(all)}`);

      // A bare "/" leads with the two buttons — the manager, standing in for the
      // /commands row it replaces (one action, one row), and the built-ins,
      // which live in the Extensions settings.
      assert(bareItems[0]?.action === 'manage-commands',
        `fetch("") must lead with the manage-commands row, got ${JSON.stringify(bareItems[0])}`);
      assert(bareItems[1]?.action === 'browse-commands',
        `fetch("") must follow it with the browse-commands row, got ${JSON.stringify(bareItems[1])}`);
      assert(!all.includes('commands'),
        `fetch("") must drop the plain /commands row, got ${JSON.stringify(all)}`);

      // Typing brings it back: the buttons are a discovery affordance, not
      // permanent rows competing with what the user is filtering for.
      const typed = await slashCommandProvider.fetch('comm');
      assert(typed.every((c) => c.action !== 'manage-commands' && c.action !== 'browse-commands'),
        'a typed query must NOT pin the manage-commands or browse-commands rows');
      assert(realNames(typed).includes('commands'),
        `fetch("comm") must offer /commands itself, got ${JSON.stringify(realNames(typed))}`);

      const filtered = realNames(await slashCommandProvider.fetch('cl'));
      assert(filtered.length > 0 && filtered.every((n) => n.startsWith('cl')),
        `fetch("cl") must return only cl* commands, got ${JSON.stringify(filtered)}`);
      assert(filtered.includes('clear'), `fetch("cl") must still offer /clear, got ${JSON.stringify(filtered)}`);

      // The pinned "New command…" row is last, carrying the typed query.
      const withRow = await slashCommandProvider.fetch('standup');
      const pinned = withRow[withRow.length - 1];
      assert(pinned && pinned.action === 'new-command' && pinned.query === 'standup',
        `fetch must pin a New command row carrying the query, got ${JSON.stringify(pinned)}`);

      // …but it is suppressed when the query exactly names an existing command —
      // creating a duplicate /clear is impossible, so no dead-end create row.
      const exact = await slashCommandProvider.fetch('clear');
      assert(exact.every((c) => c.action !== 'new-command'),
        `fetch("clear") must not offer a New command row for an existing name, got ${JSON.stringify(exact.map((c) => c.action || c.name))}`);
      assert(realNames(exact).includes('clear'), 'fetch("clear") must still offer /clear itself');

      // insert() splices text only — "/name " with a trailing space, no send.
      assert(slashCommandProvider.insert({ name: 'clear' }) === '/clear ',
        'insert must produce "/clear " (text only)');

      // submitAfterAccept() decides whether accepting the item runs it on the
      // same keystroke. An argument-less command is runnable as-is, so it
      // submits; one declaring an argsHint expects arguments next, so it does
      // not; the synthetic "New command…" row opens a dialog, never submits.
      assert(slashCommandProvider.submitAfterAccept({ name: 'clear' }) === true,
        'an argument-less command must submit on accept');
      assert(slashCommandProvider.submitAfterAccept({ name: 'review', argsHint: '<pr>' }) === false,
        'a command declaring an argsHint must NOT submit on accept');
      assert(slashCommandProvider.submitAfterAccept({ action: 'new-command', query: 'x' }) === false,
        'the New command row must NOT submit on accept');
      assert(slashCommandProvider.submitAfterAccept({ action: 'manage-commands' }) === false,
        'the manage-commands row must NOT submit on accept');
      assert(slashCommandProvider.submitAfterAccept({ action: 'browse-commands' }) === false,
        'the browse-commands row must NOT submit on accept');
      passed++;
    } catch (e) {
      failed++;
      errors.push('slash-provider-detect-and-fetch: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // ── Test 2: the composer wires both providers; slash wins at msg start ────
  {
    const { box, textarea, container } = mountComposer();
    try {
      const menu = box._completions;
      assert(!!menu, 'composer-box must construct a CompletionMenu');
      assert(menu._providers.some((/** @type {any} */ p) => p === slashCommandProvider),
        'the menu must include the slash-command provider');
      assert(menu._providers.some((/** @type {any} */ p) => p.id === 'file-mention'),
        'the menu must include the file-mention provider');

      // handleInput() selects the active provider + anchor SYNCHRONOUSLY, before
      // the debounced fetch — so this is deterministic in a throttled window.
      textarea.value = '/cl';
      textarea.selectionStart = textarea.selectionEnd = 3;
      menu.handleInput();
      assert(menu._provider === slashCommandProvider,
        'typing "/cl" at message start must select the slash-command provider');
      assert(menu._anchorPos === 0, 'the slash anchor must be the message start');

      // A "/" mid-message selects no provider and closes the menu.
      textarea.value = 'run /cl';
      textarea.selectionStart = textarea.selectionEnd = 7;
      menu.handleInput();
      assert(!menu.isActive() && menu._provider === null,
        'a "/" mid-message must not activate any completion provider');
      passed++;
    } catch (e) {
      failed++;
      errors.push('composer-box-wires-providers: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      box._completions.close();
      container.remove();
    }
  }

  // ── Test 3: accepting a command splices "/name " and runs it in one step ──
  // Driven from explicit menu state, exactly as the @-mention test driver does
  // (bypasses the debounced fetch + popup surface, which are timer/layout bound).
  // An argument-less command submits on the accepting keystroke (menu.onSubmit),
  // so the popup never demands a second Enter; a command taking arguments splices
  // the text and waits, leaving the caret after "/name " for the user to type.
  {
    const { box, textarea, container } = mountComposer();
    try {
      const menu = box._completions;

      // Spy on the composer submit the menu was wired to fire.
      let submits = 0;
      menu._onSubmit = () => { submits++; };

      // (a) Argument-less command: splices "/clear " AND submits once.
      textarea.value = '/cl';
      textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
      menu._provider = slashCommandProvider;
      menu._anchorPos = 0;
      menu._items = [{ name: 'clear', label: 'Clear', description: 'Clear the conversation' }];
      menu._index = 0;
      menu._active = true;

      menu.accept();

      assert(textarea.value === '/clear ',
        `accepting /clear must splice "/clear ", got ${JSON.stringify(textarea.value)}`);
      assert(submits === 1, `accepting an argument-less command must submit once, got ${submits}`);
      assert(!menu.isActive(), 'accepting a command must close the menu');

      // (b) Command taking arguments: splices text, does NOT submit.
      submits = 0;
      textarea.value = '/rev';
      textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
      menu._provider = slashCommandProvider;
      menu._anchorPos = 0;
      menu._items = [{ name: 'review', description: 'Review a PR', argsHint: '<pr>' }];
      menu._index = 0;
      menu._active = true;

      menu.accept();

      assert(textarea.value === '/review ',
        `accepting /review must splice "/review ", got ${JSON.stringify(textarea.value)}`);
      assert(submits === 0, `accepting a command with arguments must NOT submit, got ${submits}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push('slash-accept-runs-or-waits: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      box._completions.close();
      container.remove();
    }
  }

  // ── Test 4: Tab completes the command but never sends it ─────────────────
  // Enter on an argument-less command runs it on that keystroke (Test 3a), but
  // Tab is a completion key: it splices "/name " and stops, leaving the send to
  // the user's own Enter. Both Tab paths are pinned — a highlighted row, and the
  // sole-match path through tabComplete().
  {
    const { box, textarea, container } = mountComposer();
    try {
      const menu = box._completions;
      let submits = 0;
      menu._onSubmit = () => { submits++; };

      /** @returns {KeyboardEvent} A Tab keydown the menu can consume. */
      const tabKey = () => new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });

      // (a) Tab on the highlighted argument-less command: completes, no send.
      textarea.value = '/cl';
      textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
      menu._provider = slashCommandProvider;
      menu._anchorPos = 0;
      menu._items = [{ name: 'clear', description: 'Clear the conversation' }, { name: 'clone', description: 'Clone it' }];
      menu._index = 0;
      menu._active = true;

      assert(menu.handleKeydown(tabKey()) === true, 'the menu must consume Tab while open');
      assert(textarea.value === '/clear ',
        `Tab must complete to "/clear ", got ${JSON.stringify(textarea.value)}`);
      assert(submits === 0, `Tab must NOT send the command, got ${submits} submit(s)`);

      // (b) Sole match, nothing highlighted: same completion, still no send.
      submits = 0;
      textarea.value = '/cle';
      textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
      menu._provider = slashCommandProvider;
      menu._anchorPos = 0;
      menu._items = [{ name: 'clear', description: 'Clear the conversation' }];
      menu._index = -1;
      menu._active = true;

      menu.handleKeydown(tabKey());
      assert(textarea.value === '/clear ',
        `Tab on a sole match must complete to "/clear ", got ${JSON.stringify(textarea.value)}`);
      assert(submits === 0, `Tab on a sole match must NOT send, got ${submits} submit(s)`);
      passed++;
    } catch (e) {
      failed++;
      errors.push('slash-tab-completes-without-sending: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      box._completions.close();
      container.remove();
    }
  }

  // ── Test 5: "@" asks about the conversation's own tree ────────────────────
  // A mention is read from the conversation's working workspace, so the menu
  // that offers it and the check that admits a bare "@word" must ask about that
  // tree. Only the id travels; the server resolves it. Read per fetch, so a
  // binding acquired after the composer was built is followed.
  {
    const { box, container } = mountComposer();
    const realFetch = window.fetch;
    /** @type {string[]} */
    const asked = [];
    window.fetch = /** @type {any} */ (async (/** @type {any} */ url) => {
      asked.push(String(url));
      return { ok: true, status: 200, json: async () => ({ results: [], existing: [] }) };
    });
    try {
      const provider = box._completions._providers.find((/** @type {any} */ p) => p.id === 'file-mention');

      await provider.fetch('main');
      assert(asked.length === 1 && !asked[0].includes('workspace='),
        `a composer with no conversation must ask about the project, asked ${JSON.stringify(asked)}`);

      box._messageThread = { conversation: { workingWorkspaceId: 'ws_tree' } };
      asked.length = 0;
      await provider.fetch('main');
      await provider.fetch('./sr');
      assert(asked.length === 2 && asked.every((u) => u.includes('workspace=ws_tree')),
        `both completers must name the conversation's workspace, asked ${JSON.stringify(asked)}`);

      asked.length = 0;
      await extractFileMentionsAsync('look at @Makefile', 'ws_tree');
      assert(asked.length === 1 && asked[0].includes('/completions/exists') && asked[0].includes('workspace=ws_tree'),
        `the bare-word check must ask the workspace, asked ${JSON.stringify(asked)}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push('file-mention-asks-the-conversations-tree: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      window.fetch = realFetch;
      box._messageThread = null;
      box._completions.close();
      container.remove();
    }
  }

  return { passed, failed, errors };
}
