//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * `$name` skill-mention completions and explicit composer skill activation.
 *
 * Typing `$` at a mention boundary activates the shared completion menu with the
 * skill provider, populated from THIS conversation's frozen skill snapshot. On
 * send, each `$name` that exactly matches a snapshot skill is loaded through the
 * same visible `skill` tool-call the model uses, and the trigger token is
 * stripped so it never goes out as prose. This suite pins:
 *   1. detect() triggers only at a boundary over the `[a-z0-9-]` name charset,
 *      so `$HOME`, `echo$x`, and `$5.00` never activate it;
 *   2. fetch() prefix-filters the injected snapshot; insert()/tab splice `$name`;
 *   3. extractSkillMentions() extracts ONLY exact snapshot names, strips the
 *      token (no doubled space), dedupes, and leaves an unknown `$foo` as prose;
 *   4. the composer wires the skill provider into its menu and the picker
 *      button inserts `$` and opens it;
 *   5. with no skills the button stays clickable and the picker opens on an
 *      empty state plus the "Manage skills…" route to the Skills page;
 *   6. sending `$tdd do it` loads the `tdd` skill via executeContextItem and
 *      dispatches the trigger-stripped prose "do it"; a bare `$tdd` is a preload
 *      (skill loaded, box cleared, no turn dispatched);
 *   7. detaching the composer releases an open picker, and an open still
 *      awaiting the snapshot when the box detaches presents nothing.
 * @module unit-tests/skill-completion-test
 */

import { assert } from '../utilities/test-helpers.js';
import {
  createSkillMentionProvider,
  extractSkillMentions,
} from '../../js/components/skill-mention-provider.js';
import '../../js/components/composer.js';
import MessageThread from '../../js/model/message-thread.js';

/** @type {import('../../js/services/skills.js').SkillMeta[]} */
const FIXTURE = /** @type {any} */ ([
  { name: 'tdd', description: 'Test-driven development workflow', scope: 'project', source: 'juggler', hasScripts: false },
  { name: 'code-review', description: 'Review code changes', scope: 'user', source: 'agents', hasScripts: true },
  { name: 'research', description: 'Deep research and synthesis', scope: 'project', source: 'juggler', hasScripts: false },
]);

/**
 * Mount an <composer-box> and bind its listeners synchronously (render() defers
 * setupListeners() to rAF, which never pumps in the hidden test window).
 * @returns {{box: any, textarea: HTMLTextAreaElement, container: HTMLElement}} The mounted composer-box, its textarea and container.
 */
function mountComposer() {
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:480px;height:600px;';
  const box = document.createElement('composer-box');
  container.appendChild(box);
  document.body.appendChild(container);
  /** @type {any} */ (box).setupListeners();
  /** @type {any} */ (box).setupListeners = () => {};
  const textarea = /** @type {HTMLTextAreaElement} */ (box.querySelector('textarea'));
  assert(!!textarea, 'composer-box must render a textarea');
  return { box, textarea, container };
}

/**
 * A stub message thread that advertises the given skills and records every
 * context-item activation, so the send path can be exercised with no backend.
 * @param {import('../../js/services/skills.js').SkillMeta[]} [skills] - Snapshot the stub advertises (FIXTURE by default)
 * @returns {{thread: any, calls: Array<{type: string, params: any, pending: boolean}>}} The stub and its call log.
 */
function makeStubThread(skills = FIXTURE) {
  /** @type {Array<{type: string, params: any, pending: boolean}>} */
  const calls = [];
  const skillItem = {
    // Own `constructor` property shadows Object's, so the id lookup in
    // getThreadSkillSnapshot resolves to this manifest.
    constructor: { MANIFEST: { id: 'skill' } },
    getSnapshotSkills: async () => skills,
  };
  const thread = {
    conversationId: 'c-test',
    threadItemId: null,
    // Never queued; the real placement, so a stubbed writer below is the one it calls.
    sendWillQueue: false,
    addSendContext(/** @type {any} */ reads) { return MessageThread.prototype.addSendContext.call(this, reads); },
    getContextItems: () => [skillItem],
    executeContextItem: async (/** @type {string} */ type, /** @type {any} */ params) => {
      calls.push({ type, params, pending: false });
    },
    executeContextItemIntoPending: async (/** @type {string} */ type, /** @type {any} */ params) => {
      calls.push({ type, params, pending: true });
    },
  };
  return { thread, calls };
}

/**
 * Run the skill-completion suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  const errors = [];
  const provider = createSkillMentionProvider(async () => FIXTURE);

  // ── Test 1: detect() boundary + charset gate ──────────────────────────────
  {
    try {
      const bare = provider.detect('$');
      assert(!!bare && bare.anchorPos === 0 && bare.query === '',
        `"$" must trigger at anchor 0 with empty query, got ${JSON.stringify(bare)}`);

      const partial = provider.detect('$td');
      assert(!!partial && partial.anchorPos === 0 && partial.query === 'td',
        `"$td" must trigger with query "td", got ${JSON.stringify(partial)}`);

      const afterSpace = provider.detect('hello $co');
      assert(!!afterSpace && afterSpace.anchorPos === 6 && afterSpace.query === 'co',
        `"hello $co" must trigger at anchor 6 with query "co", got ${JSON.stringify(afterSpace)}`);

      assert(provider.detect('echo$x') === null,
        'a "$" glued to a preceding token must NOT trigger');
      assert(provider.detect('$HOME') === null,
        'an uppercase shell-style "$HOME" must NOT trigger (charset is [a-z0-9-])');
      assert(provider.detect('run /cl') === null,
        'text with no "$" must NOT trigger the skill provider');
      passed++;
    } catch (e) {
      failed++;
      errors.push('skill-detect-boundary: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // ── Test 2: fetch() prefix filter + insert()/tab ──────────────────────────
  {
    try {
      const all = (await provider.fetch('')).map((s) => s.name);
      assert(JSON.stringify(all) === JSON.stringify(['code-review', 'research', 'tdd']),
        `fetch("") must return all skills name-sorted, got ${JSON.stringify(all)}`);

      const co = (await provider.fetch('co')).map((s) => s.name);
      assert(JSON.stringify(co) === JSON.stringify(['code-review']),
        `fetch("co") must return only co* skills, got ${JSON.stringify(co)}`);

      const none = await provider.fetch('xyz');
      assert(none.length === 0, `fetch("xyz") must return nothing, got ${JSON.stringify(none)}`);

      assert(provider.insert({ name: 'tdd' }) === '$tdd ',
        'insert must produce "$tdd " (text only, trailing space)');

      const tab = provider.tabCompleteReplacement([{ name: 'code-review' }, { name: 'code-gen' }], 'co');
      assert(tab === '$code-', `tab must extend to the longest common prefix "$code-", got ${JSON.stringify(tab)}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push('skill-fetch-insert: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // ── Test 3: extractSkillMentions() — the send-time gate ───────────────────
  {
    try {
      const names = ['tdd', 'code-review', 'research'];
      /**
       * @param {string} text - Input message
       * @param {{names: string[], text: string}} want - Expected extraction result
       * @param {string} label - Assertion label
       */
      const check = (text, want, label) => {
        const got = extractSkillMentions(text, names);
        assert(JSON.stringify(got) === JSON.stringify(want),
          `${label}: extractSkillMentions(${JSON.stringify(text)}) → ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      };

      check('$tdd do it', { names: ['tdd'], text: 'do it' }, 'leading trigger stripped');
      check('use $code-review please', { names: ['code-review'], text: 'use please' }, 'mid trigger, no double space');
      check('go $research', { names: ['research'], text: 'go' }, 'trailing trigger');
      check('$tdd', { names: ['tdd'], text: '' }, 'bare trigger → empty prose');
      check('$tdd and $research now', { names: ['tdd', 'research'], text: 'and now' }, 'two triggers, order preserved');
      check('$tdd $tdd again', { names: ['tdd'], text: 'again' }, 'duplicate collapses to one');

      // Non-triggers: left verbatim as prose, no names.
      check('echo $HOME and $PATH', { names: [], text: 'echo $HOME and $PATH' }, 'uppercase shell vars ignored');
      check('price is $5 today', { names: [], text: 'price is $5 today' }, 'a price is not a skill');
      check('foo$tdd bar', { names: [], text: 'foo$tdd bar' }, 'glued "$" is not a boundary');
      check('$unknown thing', { names: [], text: '$unknown thing' }, 'unknown skill left as prose');
      check('$tdd.', { names: [], text: '$tdd.' }, 'trailing punctuation is not a mention boundary');
      passed++;
    } catch (e) {
      failed++;
      errors.push('skill-extract: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // ── Test 4: skill provider wired; picker menu inserts only on selection ───
  {
    const { box, textarea, container } = mountComposer();
    try {
      const menu = box._completions;
      assert(!!menu, 'composer-box must construct a CompletionMenu');
      assert(menu._providers.some((/** @type {any} */ p) => p.id === 'skill-mention'),
        'the menu must include the skill-mention provider');

      // Opening the picker menu (like the `/` commands button) must NOT touch the
      // composer — only selecting a skill inserts text.
      textarea.value = 'hello';
      textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
      box._messageThread = makeStubThread().thread;
      await box._skillPopup.open();
      assert(!!box._skillPopup.surface, 'the picker must build a skill menu');
      const items = box._skillPopup.surface.querySelectorAll('li.skill-mention-item');
      assert(items.length === FIXTURE.length,
        `the menu must list one row per skill, got ${items.length}`);
      // A "Manage skills…" footer follows the skill rows (opens Skills settings).
      assert(!!box._skillPopup.surface.querySelector('li.skill-menu-manage'),
        'the picker must offer a "Manage skills…" footer row');
      assert(textarea.value === 'hello',
        `opening the menu must not modify the composer, got ${JSON.stringify(textarea.value)}`);

      // Selecting a skill splices "$name " at the caret, with a leading space
      // because the caret sits on a non-boundary char.
      /** @type {HTMLElement} */ (items[0]).click();
      assert(textarea.value === 'hello $code-review ',
        `selecting must splice "$name ", got ${JSON.stringify(textarea.value)}`);
      assert(!box._skillPopup.surface, 'selecting a skill must close the menu');

      // From an empty composer there is no leading space.
      textarea.value = '';
      textarea.selectionStart = textarea.selectionEnd = 0;
      box._insertSkillMention('tdd');
      assert(textarea.value === '$tdd ',
        `at start-of-text the mention needs no leading space, got ${JSON.stringify(textarea.value)}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push('composer-box-skill-picker-menu: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      box._completions?.close();
      container.remove();
    }
  }

  // ── Test 5: with no skills the picker still opens, on an empty state ──────
  // A dead button teaches nothing: with an empty snapshot the button stays
  // clickable and the picker says there are none and offers the way to add some.
  {
    const { box, container } = mountComposer();
    try {
      const { thread } = makeStubThread([]);
      box._messageThread = thread;

      const button = /** @type {HTMLButtonElement} */ (box.querySelector('#skill-button'));
      assert(!!button, 'composer-box must render a skill picker button');
      assert(!button.hidden, 'the skill button must stay clickable when there are no skills');

      await box._skillPopup.open();
      assert(!!box._skillPopup.surface, 'clicking with no skills must still open the picker');
      const rows = box._skillPopup.surface.querySelectorAll('li.skill-mention-item');
      assert(rows.length === 0, `an empty snapshot must list no skills, got ${rows.length}`);
      const hint = box._skillPopup.surface.querySelector('li.menu-item-hint');
      assert(!!hint, 'the empty picker must say that there are no skills');
      assert(!!box._skillPopup.surface.querySelector('li.skill-menu-manage'),
        'the empty picker must offer a "Manage skills…" row into the Skills page');

      // Layout: with nothing to describe, the popup must not keep the wide fixed
      // width its description column needs, and the hint must fill the row rather
      // than being wedged into the narrow name column of the two-column grid.
      const menuWidth = box._skillPopup.surface.getBoundingClientRect().width;
      assert(menuWidth > 0 && menuWidth < 320,
        `an empty picker must shrink to its message, got ${Math.round(menuWidth)}px wide`);
      const rowWidth = hint.getBoundingClientRect().width;
      const hintText = hint.querySelector('.menu-hint-text');
      const textWidth = hintText.getBoundingClientRect().width;
      const rowStyle = getComputedStyle(hint);
      const pad = parseFloat(rowStyle.paddingLeft) + parseFloat(rowStyle.paddingRight);
      assert(textWidth >= rowWidth - pad - 1,
        `the hint must span the row, not one grid column (row ${Math.round(rowWidth)}px, text ${Math.round(textWidth)}px, display ${rowStyle.display}, padding ${Math.round(pad)}px, align ${getComputedStyle(hintText).textAlign})`);
      passed++;
    } catch (e) {
      failed++;
      errors.push('composer-box-skill-picker-empty: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      box._skillPopup.close();
      box._completions?.close();
      container.remove();
    }
  }

  // ── Test 6: send path FORWARDS chosen skills and strips the triggers ──────
  // Skills are loaded worker-side (a real `skill` tool-action), so the composer
  // only forwards the names in the send-message detail — it must NOT run a
  // context-item load itself (which would merely re-seed the standing list).
  {
    const { box, textarea, container } = mountComposer();
    try {
      const { thread, calls } = makeStubThread();
      box._messageThread = thread;
      box.session = null;

      /** @type {any} */
      let sent = null;
      const onSend = (/** @type {any} */ e) => { sent = e.detail; };
      box.addEventListener('send-message', onSend);

      // (a) prose + trigger: "do it" dispatched without "$tdd"; skills=['tdd'].
      textarea.value = '$tdd do it';
      const r1 = await box.sendMessage();
      assert(r1 === null, `a valid send must resolve null, got ${JSON.stringify(r1)}`);
      assert(!!sent && sent.message === 'do it',
        `dispatched message must be the trigger-stripped prose "do it", got ${JSON.stringify(sent && sent.message)}`);
      assert(!!sent && JSON.stringify(sent.skills) === JSON.stringify(['tdd']),
        `dispatched skills must be ['tdd'], got ${JSON.stringify(sent && sent.skills)}`);
      assert(calls.length === 0,
        `the composer must NOT load skills via executeContextItem, got ${JSON.stringify(calls)}`);

      // (b) skills-only send: empty prose, skills still forwarded (worker preloads,
      // no empty turn — that decision now lives in the worker, so the composer
      // still dispatches).
      sent = null;
      textarea.value = '$research';
      const r2 = await box.sendMessage();
      assert(r2 === null, `a skills-only send must resolve null, got ${JSON.stringify(r2)}`);
      assert(!!sent && sent.message === '',
        `a skills-only send must dispatch empty prose, got ${JSON.stringify(sent && sent.message)}`);
      assert(!!sent && JSON.stringify(sent.skills) === JSON.stringify(['research']),
        `a skills-only send must forward ['research'], got ${JSON.stringify(sent && sent.skills)}`);
      box.removeEventListener('send-message', onSend);
      passed++;
    } catch (e) {
      failed++;
      errors.push('skill-send-path: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      box._completions?.close();
      container.remove();
    }
  }

  // ── Test 7: detaching the composer tears down an open picker ──────────────
  // presentPopup appends the menu to <body> and wires dismissal and a
  // reposition observer there, so none of it goes away with the composer. The
  // box must release it on disconnect — both when the picker is already up and
  // when the detach lands while the open is still awaiting the skill snapshot.
  {
    const { box, container } = mountComposer();
    /** @type {HTMLElement|null} */
    let opened = null;
    try {
      const { thread } = makeStubThread();
      box._messageThread = thread;

      await box._skillPopup.open();
      opened = box._skillPopup.surface;
      assert(!!opened && opened.isConnected, 'the picker must be presented in the document');
      container.remove();
      assert(!opened.isConnected,
        'detaching the composer must remove its open skill picker from the document');
      assert(box._skillPopup.surface === null && !box._skillPopup.isOpen,
        'detaching the composer must reset the skill picker state');

      // Detach while the open is suspended on the snapshot: it must not present
      // a popup for a composer that is no longer in the document.
      document.body.appendChild(container);
      const pending = box._skillPopup.open();
      container.remove();
      await pending;
      const stray = document.querySelector('#skill-menu');
      assert(stray === null && box._skillPopup.surface === null,
        'an open that resolves after the composer detached must present nothing');
      passed++;
    } catch (e) {
      failed++;
      errors.push('composer-box-skill-picker-detach: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      box._skillPopup.close();
      opened?.remove();
      document.querySelector('#skill-menu')?.remove();
      box._completions?.close();
      container.remove();
    }
  }

  return { passed, failed, errors };
}
