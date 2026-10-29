//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Cases for juggler/no-private-test-wait. Run by `make lint-js`; throws
 * (exit 1) on the first case that disagrees. Which files the rule applies to is
 * the config's business (tooling/eslint.config.js); every case here is a file
 * it applies to.
 *
 * The cases that import a helper are linted as a file in a scratch directory
 * beside the modules they import, written here and removed afterwards.
 */

import { log } from 'node:console';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RuleTester } from 'eslint';
import rule from './no-private-test-wait.js';

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

// The id RuleTester gives the rule, which is what a directive must name.
const RULE = 'rule-to-test/no-private-test-wait';

const loop = { messageId: 'loop' };
const sleep = { messageId: 'sleep' };
const race = { messageId: 'race' };
const helper = { messageId: 'helper' };
const zeroHelper = { messageId: 'zeroHelper' };
const disableReason = { messageId: 'disableReason' };
const disableBare = { messageId: 'disableBare' };

const fixtures = mkdtempSync(path.join(tmpdir(), 'no-private-test-wait-'));
writeFileSync(path.join(fixtures, 'helpers.js'), [
  'export const nextTask = () => new Promise((resolve) => { setTimeout(resolve, 0); });',
  'export function pause(ms) { return new Promise((r) => setTimeout(r, ms)); }',
  'export { pause as rest };',
  'export async function poll(probe) { while (!probe()) await nextTask(); return true; }',
  'export default (ms) => new Promise((r) => setTimeout(r, ms));',
].join('\n'));
writeFileSync(path.join(fixtures, 'reexport.js'), "export { pause as linger } from './helpers.js';\n");
const importer = path.join(fixtures, 'importer-test.js');

try {
  tester.run('no-private-test-wait', rule, {
    valid: [
      // The one wait.
      "await waitFor(() => done(), 'it to be done');",
      // A yield to the task queue, alone or counted: task hops, not a duration.
      'await new Promise((r) => setTimeout(r, 0));',
      'await new Promise((r) => { setTimeout(r); });',
      'for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));',
      // Measuring time is not bounding on it.
      'const at = Date.now(); await work(); hops.push(Date.now() - at);',
      'for (const x of xs) { const t = Date.now(); await x(); costs.push(Date.now() - t); }',
      'for (const x of xs) { const t = performance.now(); await x(); costs.push(performance.now() - t); }',
      // A comparison with the clock outside any loop decides nothing about waiting.
      'if (Date.now() > expiresAt) refresh();',
      // A timer that is not a wait.
      'const t = setTimeout(() => fire(), 500);',
      'function arm(done) { setTimeout(done, 10); }',
      // A promise no timer settles.
      "await new Promise((r) => el.addEventListener('load', r));",
      'const load = () => fetch(url).then((r) => r.json());',
      // A local binding named setTimeout is not the timer.
      'function make(setTimeout) { return new Promise((r) => setTimeout(r, 5)); }',
      // A timer an event handler defers a re-check to does not decide the
      // promise; the event does.
      'const until = (check) => new Promise((resolve) => { new MutationObserver(() => { setTimeout(() => { if (check()) resolve(); }, 0); }).observe(el, {}); });',
      // A loop in a nested function is that function's, not the enclosing one's.
      'for (const x of xs) { items.push(async () => { await x(); }); }',
      // A sleep inside a function defined in a loop belongs to that function.
      'for (const d of delays) fixtures.push({ run: async () => { await d(); } });',
      // The shared zero-delay yield, alone or counted; a delay helper given 0;
      // an imported wait that is not itself a timer.
      {
        filename: importer,
        code: "import { nextTask, pause, poll } from './helpers.js'; await nextTask(); "
          + 'for (let i = 0; i < 3; i++) await nextTask(); await pause(0); await poll(ok);',
      },
      // A duration that is the subject, disabled for its line with the reason.
      `// eslint-disable-next-line ${RULE} -- the hold must outlast the guard, which is the subject\n`
        + 'await new Promise((r) => setTimeout(r, 150));',
    ],
    invalid: [
      // Private deadline loops.
      { code: 'while (Date.now() < deadline) { if (ok()) break; await tick(); }', errors: [loop] },
      { code: 'for (;;) { if (ok()) break; if (Date.now() > until) throw new Error("late"); await tick(); }', errors: [loop] },
      { code: 'do { await tick(); } while (!ok() && Date.now() - started < 5000);', errors: [loop] },
      { code: 'while (performance.now() < end) { if (ok()) break; await tick(); }', errors: [loop] },
      // A counted loop of timer sleeps is a wall-clock budget too, and is
      // reported once, not again for the sleep inside it.
      { code: 'for (let i = 0; i < 40 && !landed(); i++) await new Promise((r) => setTimeout(r, 25));', errors: [loop] },
      { code: 'while (!ok()) { await new Promise((resolve) => { setTimeout(resolve, 20); }); }', errors: [loop] },
      // Two clues in one loop: one report.
      { code: 'while (Date.now() < end) { if (ok()) break; await new Promise((r) => setTimeout(r, 10)); }', errors: [loop] },
      // The same loop through a helper — the doc example — whatever the
      // helper's name or shape: the helper and the loop are each reported.
      {
        code: 'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\n'
          + 'for (let i = 0; i < 40 && !done(); i++) await sleep(25);',
        errors: [helper, loop],
      },
      {
        code: 'function nap(ms) { return new Promise((resolve) => { setTimeout(resolve, ms); }); }\n'
          + 'while (!ok()) { await nap(10); }',
        errors: [helper, loop],
      },
      // ...or one imported from another module, directly or re-exported.
      { filename: importer, code: "import { pause } from './helpers.js'; while (!ok()) await pause(20);", errors: [loop] },
      { filename: importer, code: "import { linger } from './reexport.js'; for (const x of xs) { await x(); await linger(5); }", errors: [loop] },
      // Fixed sleeps, as a barrier and as a negative window.
      { code: 'await new Promise((r) => setTimeout(r, 300)); assert(landed());', errors: [sleep] },
      { code: 'await new Promise((resolve) => { setTimeout(resolve, 1200); }); assert(!refetched());', errors: [sleep] },
      { code: 'await new Promise(function (r) { setTimeout(r, ms); });', errors: [sleep] },
      // A delay that is not literally zero counts as a duration.
      { code: 'await new Promise((r) => setTimeout(r, budgetFor(5000)));', errors: [sleep] },
      // Resolving through a callback, or among other work in the executor.
      { code: 'await new Promise((r) => setTimeout(() => r(compute()), 50));', errors: [sleep] },
      // Armed from a callback, still with the resolve itself.
      { code: 'await new Promise((r) => { el.onload = () => setTimeout(r, 10); });', errors: [sleep] },
      // Through the timer's other spellings, and an executor defined apart.
      { code: 'await new Promise((r) => window.setTimeout(r, 40));', errors: [sleep] },
      { code: 'const st = setTimeout; await new Promise((r) => st(r, 40));', errors: [sleep] },
      { code: 'const arm = (r) => setTimeout(r, 50); await new Promise(arm);', errors: [sleep] },
      // Not awaited: chained, or held and awaited later.
      { code: 'new Promise((r) => setTimeout(r, 100)).then(() => check());', errors: [sleep] },
      { code: 'await new Promise((r) => setTimeout(r, 100)).then(check);', errors: [sleep] },
      // Raced against the work, or settled by whichever of an event and a
      // timer comes first: a private deadline. Joined to the work: a sleep.
      { code: 'await Promise.race([reply, new Promise((r) => setTimeout(r, 5000))]);', errors: [race] },
      { code: "const late = new Promise((_r, rej) => setTimeout(() => rej(new Error('late')), 4000)); await Promise.race([work, late]);", errors: [race] },
      {
        code: 'await new Promise((resolve) => { const t = setTimeout(resolve, 500); onDone(() => { clearTimeout(t); resolve(); }); });',
        errors: [race],
      },
      { code: 'await Promise.all([work(), new Promise((r) => setTimeout(r, 100))]);', errors: [sleep] },
      // Calls to a delay helper: each one is a fixed sleep.
      { code: 'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\nawait sleep(300);\nawait sleep(0);', errors: [helper, sleep] },
      { filename: importer, code: "import { rest } from './helpers.js'; await rest(200);", errors: [sleep] },
      { filename: importer, code: "import nap from './helpers.js'; await nap(10);", errors: [sleep] },
      { code: "import { setTimeout as delay } from 'node:timers/promises'; await delay(100);", errors: [sleep] },
      // Timer helpers, whatever they are called and however the delay arrives.
      { code: 'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));', errors: [helper] },
      { code: 'function wait(ms = 50) { return new Promise((resolve) => { setTimeout(resolve, ms); }); }', errors: [helper] },
      { code: 'const SETTLE_MS = 30;\nconst settle = () => new Promise((resolve) => { setTimeout(resolve, SETTLE_MS); });', errors: [helper] },
      { code: 'const outlast = () => new Promise((resolve) => { setTimeout(resolve, FOLLOW_MS * 3); });', errors: [helper] },
      { code: 'const nap = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };', errors: [helper] },
      { code: 'async function delay() { await new Promise((r) => setTimeout(r, 300)); }', errors: [helper] },
      { code: 'const h = { pause(ms) { return new Promise((r) => setTimeout(r, ms)); } };', errors: [helper] },
      { code: 'class Fixture { async rest() { await new Promise((r) => setTimeout(r, 20)); } }', errors: [helper] },
      { code: 'const later = (ms) => new Promise((r) => { const id = setInterval(() => { clearInterval(id); r(); }, ms); });', errors: [helper] },
      { code: 'const nap = () => new Promise((r) => globalThis.setTimeout(r, 40));', errors: [helper] },
      { code: 'const later = (fn) => new Promise((r) => setTimeout(r, 10)).then(fn);', errors: [helper] },
      { code: "const ready = () => new Promise((resolve) => { el.addEventListener('load', resolve); setTimeout(resolve, 2000); });", errors: [helper] },
      { code: 'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\nconst settle = () => sleep(20);', errors: [helper, helper] },
      { code: "const within = (p, ms) => Promise.race([p, new Promise((_r, rej) => setTimeout(() => rej(new Error('late')), ms))]);", errors: [helper] },
      // A deadline helper is reported where it is defined; its callers, and
      // a function that only passes it on, are bound by it, not sleeping.
      {
        code: "const within = (p, ms) => Promise.race([p, new Promise((_r, rej) => setTimeout(() => rej(new Error('late')), ms))]);\n"
          + 'const soon = (p) => within(p, 10);\nawait within(work, 4000);\nfor (const x of xs) await soon(x);',
        errors: [helper],
      },
      // Zero-delay ones too: there is one shared yield, not a copy per file.
      { code: 'const tick = () => new Promise((r) => setTimeout(r, 0));', errors: [zeroHelper] },
      { code: 'function frame() { return new Promise((resolve) => { setTimeout(resolve); }); }', errors: [zeroHelper] },
      {
        code: 'const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };',
        errors: [zeroHelper],
      },
      { code: 'async function flush() { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); }', errors: [zeroHelper] },
      // A disable says why, names this rule, and covers one line.
      { code: `// eslint-disable-next-line ${RULE}\nawait new Promise((r) => setTimeout(r, 150));`, errors: [disableReason] },
      { code: '// eslint-disable-next-line -- the hold is the subject\nawait new Promise((r) => setTimeout(r, 150));', errors: [disableBare] },
      {
        code: `run();\n/* eslint-disable ${RULE} -- the holds are the subject */\nawait new Promise((r) => setTimeout(r, 150));`,
        errors: [{ messageId: 'disableForm', line: 1 }],
      },
      {
        code: `run(); /* eslint-disable ${RULE} -- the holds are the subject */ await new Promise((r) => setTimeout(r, 150));`,
        errors: [{ messageId: 'disableForm', line: 1, column: 1 }],
      },
      {
        code: `run();\nawait new Promise((r) => setTimeout(r, 150)); // eslint-disable-line ${RULE} -- the hold is the subject`,
        errors: [{ messageId: 'disableForm', line: 1 }],
      },
      {
        code: 'run();\n/* eslint-disable */\nawait new Promise((r) => setTimeout(r, 150));',
        errors: [{ messageId: 'disableForm', line: 1 }],
      },
    ],
  });
} finally {
  rmSync(fixtures, { recursive: true, force: true });
}

log('no-private-test-wait: all cases pass');
