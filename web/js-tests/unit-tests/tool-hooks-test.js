//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tests for tool hooks (`juggler/hook-type`, services/hook-runtime.js): the
 * policy and notes that run around every tool call whichever strategy is active.
 *
 * Drives the real engine gate (`handleNewToolAction`) and the real execution
 * path (`claimRunning` + `executeToolAction`) with hook classes registered
 * straight into the hook registry, so what is under test is the wiring as it
 * ships, not the runtime alone.
 *
 * Contract under test:
 *   1. A beforeTool deny ends the call as a failed tool whose result names the
 *      hook and its reason; a call the hook's match does not cover is untouched.
 *   2. A beforeTool ask parks the call even under a strategy that approves
 *      everything, says in the card which hook is holding it, and is never
 *      handed to the strategy's reviewer.
 *   3. A beforeTool allow approves a call that would have parked, stamped as
 *      the hook's approval — but never overrides a strategy that requires
 *      approval.
 *   4. Deny beats allow when hooks disagree.
 *   5. A beforeTool hook that throws fails open by default and parks the call
 *      when it is set to fail closed; either way the failure is recorded.
 *   6. An afterTool note is recorded on the call, the hook sees exactly the
 *      result content that is stored, and the stored content itself is the
 *      tool's own (the note reaches the model through the worker, inside the
 *      tool_result).
 *   7. `repeat: 'once-per-thread'` drops a note the thread already carries from
 *      the same hook.
 *   8. A hook file becomes a hook class that does what its frontmatter says,
 *      and a file whose pattern does not compile is refused at registration.
 *   9. The manifest validator rejects a hook that declares an event it does not
 *      implement, or a result match on a hook that never sees a result.
 *  10. The properties panel describes every record.
 * @module unit-tests/tool-hooks-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  assert
} from '../utilities/test-helpers.js';
import { handleNewToolAction, claimRunning, executeToolAction } from '../../js/model/conversation-tool-actions.js';
import { createToolActionMessage, TOOL_STATES } from '../../sdk/lib/message.js';
import hookRegistry from '../../js/registries/hook-registry.js';
import { runAfterToolHooks } from '../../js/services/hook-runtime.js';
import { makeUserHookClass, matchFromFrontmatter } from '../../js/plugins/user-hook-factory.js';
import { describeHookRecords } from '../../js/services/renderers/item-renderers.js';
import HookType, { validateHookManifest } from 'juggler/hook-type';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Insert an unstarted bash tool-action, so the gate treats it as freshly observed.
 * @param {any} conversation - Test conversation
 * @param {string} toolUseId - Unique tool-use id
 * @param {string} command - The command
 * @returns {string} The toolUseId
 */
function insertBash(conversation, toolUseId, command) {
  conversation.rootMessageThread.addEvent(createToolActionMessage({
    toolUseId,
    toolName: 'bash',
    toolInput: { command }
  }));
  return toolUseId;
}

/**
 * Read a field off a Y.Map or a plain object.
 * @param {any} value - Y.Map or object
 * @param {string} key - Field
 * @returns {any} The field as plain JS
 */
function field(value, key) {
  const v = value?.get ? value.get(key) : value?.[key];
  return v?.toJSON ? v.toJSON() : v;
}

/**
 * Register hook classes for one test, run it, and put the registry back.
 * @param {Array<typeof HookType>} classes - Hooks to register
 * @param {() => Promise<void>} body - The test
 * @returns {Promise<void>}
 */
async function withHooks(classes, body) {
  await hookRegistry.init();
  for (const Cls of classes) {
    const outcome = hookRegistry.registerClass(Cls, { extensionId: 'tool-hooks-test', modulePath: `/test/${Cls.MANIFEST.id}.js` });
    assert(outcome.registered, `test hook ${Cls.MANIFEST.id} should register: ${outcome.reason}`);
  }
  try {
    await body();
  } finally {
    hookRegistry.reset();
    await hookRegistry.init();
  }
}

/**
 * Build a beforeTool hook class answering with a fixed outcome.
 * @param {string} id - Hook id
 * @param {any} outcome - What beforeTool returns (a function is called instead)
 * @param {object} [extra] - Extra manifest fields
 * @returns {typeof HookType} The class
 */
function beforeHook(id, outcome, extra = {}) {
  return class extends HookType {
    static MANIFEST = { id, name: id, version: '1.0.0', description: `${id} test hook`, events: ['beforeTool'], ...extra };
    beforeTool(/** @type {any} */ ctx) {
      return typeof outcome === 'function' ? outcome(ctx) : outcome;
    }
  };
}

/**
 * Run all tool-hook tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await initializeRegistries();
  const session = await createTestSession();

  const prevEngine = /** @type {any} */ (globalThis).JUGGLER_ENGINE;
  /** @type {any} */ (globalThis).JUGGLER_ENGINE = true;

  /**
   * @param {string} name
   * @param {() => Promise<void>} fn
   */
  const test = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  try {
    // 1. deny ends the call; an unmatched call is untouched
    await test('beforeTool deny', () => withHooks([
      beforeHook('guard-rm', { verdict: 'deny', reason: 'never delete recursively' },
        { name: 'Guard', match: { tools: ['bash'], input: 'rm -rf' } })
    ], async () => {
      const conversation = await createApprovalTestConversation(session);
      const mt = conversation.rootMessageThread;
      mt.strategy = { getApprovalPolicy: () => 'approve' };

      const denied = insertBash(conversation, 'hook-deny-1', 'rm -rf build');
      await handleNewToolAction(mt, denied, conversation);
      const ta = mt.getToolAction(denied);
      assert(ta?.get('state') === TOOL_STATES.COMPLETED, `a denied call should be settled, got ${ta?.get('state')}`);
      const result = ta?.get('result');
      assert(field(result, 'isError') === true, 'a denied call is a failed call');
      assert(field(result, 'content') === 'Blocked by hook "Guard": never delete recursively',
        `the result should name the hook and its reason, got ${JSON.stringify(field(result, 'content'))}`);
      const records = field(ta, 'hooks');
      assert(records?.length === 1 && records[0].verdict === 'deny' && records[0].id === 'guard-rm',
        `the call should carry the deny record, got ${JSON.stringify(records)}`);

      const untouched = insertBash(conversation, 'hook-deny-2', 'echo fine');
      await handleNewToolAction(mt, untouched, conversation);
      const ta2 = mt.getToolAction(untouched);
      assert(ta2?.get('state') === TOOL_STATES.APPROVED, `an unmatched call should go ahead, got ${ta2?.get('state')}`);
      assert(!field(ta2, 'hooks'), 'a call no hook matched carries no hook record');
    }));

    // 2. ask parks the call under YOLO and is never handed to the reviewer
    await test('beforeTool ask', () => withHooks([
      beforeHook('ask-migrations', { verdict: 'ask', reason: 'migrations are shared' }, { name: 'Migrations' })
    ], async () => {
      const conversation = await createApprovalTestConversation(session);
      const mt = conversation.rootMessageThread;
      /** @type {any[]} */
      const reviewed = [];
      mt.strategy = { getApprovalPolicy: () => 'approve', onToolPending: (/** @type {any} */ info) => { reviewed.push(info); } };

      const id = insertBash(conversation, 'hook-ask-1', 'echo touch migrations');
      await handleNewToolAction(mt, id, conversation);
      const ta = mt.getToolAction(id);
      assert(ta?.get('state') === TOOL_STATES.PENDING, `a hook's ask must park even under YOLO, got ${ta?.get('state')}`);
      const label = field(ta?.get('reviewStatus'), 'label');
      assert(label === 'Held for you by hook "Migrations": migrations are shared',
        `the card should say which hook holds it, got ${JSON.stringify(label)}`);
      assert(reviewed.length === 0, 'a call a hook asked the user about must not go to a reviewer');
    }));

    // 3. allow waives the default gate, but not a strategy that requires approval
    await test('beforeTool allow', () => withHooks([
      beforeHook('allow-all', { verdict: 'allow' })
    ], async () => {
      const conversation = await createApprovalTestConversation(session);
      const mt = conversation.rootMessageThread;
      mt.strategy = { getApprovalPolicy: () => 'default' };

      const id = insertBash(conversation, 'hook-allow-1', 'touch hook-allow-file');
      await handleNewToolAction(mt, id, conversation);
      const ta = mt.getToolAction(id);
      assert(ta?.get('state') === TOOL_STATES.APPROVED, `a hook's allow should approve, got ${ta?.get('state')}`);
      assert(ta?.get('approvalSource') === 'hook', `the approval should be the hook's, got ${ta?.get('approvalSource')}`);

      mt.strategy = { getApprovalPolicy: () => 'require-approval' };
      const strict = insertBash(conversation, 'hook-allow-2', 'touch hook-allow-file');
      await handleNewToolAction(mt, strict, conversation);
      assert(mt.getToolAction(strict)?.get('state') === TOOL_STATES.PENDING,
        'a hook\'s allow must not override a strategy that requires approval');
    }));

    // 4. deny beats allow
    await test('deny beats allow', () => withHooks([
      beforeHook('allow-first', { verdict: 'allow' }),
      beforeHook('deny-second', { verdict: 'deny', reason: 'no' })
    ], async () => {
      const conversation = await createApprovalTestConversation(session);
      const mt = conversation.rootMessageThread;
      mt.strategy = { getApprovalPolicy: () => 'approve' };
      const id = insertBash(conversation, 'hook-merge-1', 'echo merge');
      await handleNewToolAction(mt, id, conversation);
      const ta = mt.getToolAction(id);
      assert(field(ta?.get('result'), 'isError') === true, 'deny should win over allow');
      const records = field(ta, 'hooks');
      assert(records?.map((/** @type {any} */ r) => r.id).join(',') === 'allow-first,deny-second',
        `both records should be kept in registry order, got ${JSON.stringify(records)}`);
    }));

    // 5. a throwing hook fails open, or parks the call when set to fail closed
    await test('beforeTool failure', () => withHooks([
      beforeHook('throws-open', () => { throw new Error('boom'); }),
      beforeHook('throws-closed', () => { throw new Error('bang'); }, { onError: 'closed', match: { input: 'closed' } })
    ], async () => {
      const conversation = await createApprovalTestConversation(session);
      const mt = conversation.rootMessageThread;
      mt.strategy = { getApprovalPolicy: () => 'approve' };

      const open = insertBash(conversation, 'hook-fail-1', 'echo open');
      await handleNewToolAction(mt, open, conversation);
      const ta = mt.getToolAction(open);
      assert(ta?.get('state') === TOOL_STATES.APPROVED, `a failing hook fails open by default, got ${ta?.get('state')}`);
      const records = field(ta, 'hooks');
      assert(records?.[0]?.error === 'boom' && !records[0].verdict,
        `the failure is recorded without a verdict, got ${JSON.stringify(records)}`);

      const closed = insertBash(conversation, 'hook-fail-2', 'echo closed');
      await handleNewToolAction(mt, closed, conversation);
      assert(mt.getToolAction(closed)?.get('state') === TOOL_STATES.PENDING,
        'a failing fail-closed hook must hold the call for the user');
    }));

    // 6. afterTool: recorded, sees the stored content, leaves it alone
    await test('afterTool note', async () => {
      /** @type {any[]} */
      const seen = [];
      class NoteHook extends HookType {
        static MANIFEST = { id: 'after-note', name: 'After note', version: '1.0.0', description: 'test',
          events: ['afterTool'], match: { tools: ['bash'], result: 'hook-after-marker' } };
        afterTool(/** @type {any} */ ctx) {
          seen.push(ctx);
          return { note: 'Diagnose with nono why.' };
        }
      }
      await withHooks([NoteHook], async () => {
        const conversation = await createApprovalTestConversation(session);
        const mt = conversation.rootMessageThread;
        const id = insertBash(conversation, 'hook-after-1', 'echo hook-after-marker');
        mt.updateToolActionState(id, TOOL_STATES.APPROVED);
        const ymap = mt.getToolAction(id);
        assert(claimRunning(conversation, ymap) === true, 'precondition: the claim should win');
        await executeToolAction(mt, id, conversation);

        assert(ymap.get('state') === TOOL_STATES.COMPLETED, `the call should complete, got ${ymap.get('state')}`);
        assert(seen.length === 1, `the hook should run once, ran ${seen.length} times`);
        const content = field(ymap.get('result'), 'content');
        assert(seen[0].result.content === content,
          `the hook must see exactly the stored content: saw ${JSON.stringify(seen[0].result.content)}, stored ${JSON.stringify(content)}`);
        assert(!String(content).includes('nono why'), 'the note is not written into the stored content');
        const records = field(ymap, 'hooks');
        assert(records?.length === 1 && records[0].note === 'Diagnose with nono why.' && records[0].event === 'afterTool',
          `the note should be recorded on the call, got ${JSON.stringify(records)}`);
      });
    });

    // 7. once-per-thread
    await test('once-per-thread', async () => {
      class OnceHook extends HookType {
        static MANIFEST = { id: 'once-note', name: 'Once', version: '1.0.0', description: 'test',
          events: ['afterTool'], repeat: 'once-per-thread' };
        afterTool() { return { note: 'standing guidance' }; }
      }
      await withHooks([OnceHook], async () => {
        const conversation = await createApprovalTestConversation(session);
        const mt = conversation.rootMessageThread;
        const call = {
          messageThread: mt, conversationId: conversation.id, threadId: conversation.id,
          toolName: 'bash', toolInput: {}, result: { content: 'x', isError: false }
        };
        const first = await runAfterToolHooks({ ...call, toolUseId: 'once-1' });
        assert(first.records[0]?.note === 'standing guidance', 'the first call in a thread gets the note');

        insertBash(conversation, 'once-1', 'echo one');
        const items = mt.items;
        mt.updateItemField(items.length - 1, 'hooks', first.records);

        const second = await runAfterToolHooks({ ...call, toolUseId: 'once-2' });
        assert(!second.records[0]?.note && second.records[0]?.repeatSuppressed === true,
          `a later call in the same thread must not repeat it, got ${JSON.stringify(second.records)}`);
      });
    });

    // 8. hook files
    await test('hook files', async () => {
      assert(JSON.stringify(matchFromFrontmatter({ tool: 'bash, write_file', result: 'EPERM', isError: 'true' })) ===
        JSON.stringify({ tools: ['bash', 'write_file'], result: 'EPERM', isError: true }), 'frontmatter maps onto a match');

      const Deny = makeUserHookClass({ name: 'no-force-push', scope: 'user', path: '/h/no-force-push.md', body: 'Ask first.\n',
        frontmatter: { description: 'd', event: 'beforeTool', input: 'push --force', verdict: 'deny' } });
      validateHookManifest(Deny);
      const denyOutcome = /** @type {any} */ (new Deny()).beforeTool({});
      assert(denyOutcome.verdict === 'deny' && denyOutcome.reason === 'Ask first.', `a deny file denies, got ${JSON.stringify(denyOutcome)}`);

      const Note = makeUserHookClass({ name: 'nono', scope: 'user', path: '/h/nono.md', body: 'Run nono why.',
        frontmatter: { description: 'd', event: 'afterTool', result: 'EPERM', repeat: 'once-per-thread' } });
      assert(/** @type {any} */ (new Note()).afterTool({}).note === 'Run nono why.', 'an afterTool file adds its body as a note');
      assert(Note.MANIFEST.repeat === 'once-per-thread', 'repeat carries over');

      const Broken = makeUserHookClass({ name: 'broken', scope: 'user', path: '/h/broken.md', body: 'x',
        frontmatter: { description: 'd', event: 'afterTool', result: '(unclosed' } });
      await hookRegistry.init();
      try {
        const outcome = hookRegistry.registerClass(Broken, { modulePath: 'user-hook:broken' });
        assert(!outcome.registered && /regular expression/.test(String(outcome.reason)),
          `a file whose pattern does not compile must be refused, got ${JSON.stringify(outcome)}`);
      } finally {
        hookRegistry.reset();
        await hookRegistry.init();
      }
    });

    // 9. manifest validation
    await test('manifest validation', async () => {
      class Unimplemented extends HookType {
        static MANIFEST = { id: 'u', name: 'u', version: '1', description: 'd', events: ['afterTool'] };
      }
      let threw = '';
      try { validateHookManifest(Unimplemented); } catch (e) { threw = String(e); }
      assert(/does not implement afterTool/.test(threw), `an unimplemented event must be refused, got ${threw}`);

      const Early = beforeHook('early', {}, { match: { result: 'x' } });
      threw = '';
      try { validateHookManifest(Early); } catch (e) { threw = String(e); }
      assert(/apply only to the afterTool event/.test(threw), `a result match before the call must be refused, got ${threw}`);
    });

    // 10. panel text
    await test('panel description', async () => {
      const text = describeHookRecords([
        { id: 'g', name: 'Guard', source: 'extension', event: 'beforeTool', verdict: 'deny', reason: 'no', ms: 1 },
        { id: 'n', name: 'nono', source: 'user', event: 'afterTool', note: 'Run nono why.', ms: 2 },
      ]);
      assert(text === 'Guard (extension hook), before the call: blocked it\nno\n\n' +
        'nono (hook file), after the call: added a note for the model\nRun nono why.',
      `unexpected panel text: ${JSON.stringify(text)}`);
      assert(describeHookRecords(undefined) === '', 'no records, no section');
    });
  } finally {
    /** @type {any} */ (globalThis).JUGGLER_ENGINE = prevEngine;
  }

  return { passed, failed, errors };
}
