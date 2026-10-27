//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Cases for juggler/no-private-test-wait. Run by `make lint-js`; throws
 * (exit 1) on the first case that disagrees. Which files the rule applies to is
 * the config's business (tooling/eslint.config.js); every case here is a file
 * it applies to.
 */

import { log } from 'node:console';
import { RuleTester } from 'eslint';
import rule from './no-private-test-wait.js';

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

const loop = { messageId: 'loop' };
const sleep = { messageId: 'sleep' };

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
    // A comparison with the clock outside any loop decides nothing about waiting.
    'if (Date.now() > expiresAt) refresh();',
    // A timer that is not a sleep.
    'const t = setTimeout(() => fire(), 500);',
    'await new Promise((r) => setTimeout(() => r(compute()), 50));',
    // A loop in a nested function is that function's, not the enclosing one's.
    'for (const x of xs) { items.push(async () => { await x(); }); }',
    // A sleep inside a function defined in a loop belongs to that function.
    'for (const d of delays) fixtures.push({ run: async () => { await d(); } });',
  ],
  invalid: [
    // Private deadline loops.
    { code: 'while (Date.now() < deadline) { if (ok()) break; await tick(); }', errors: [loop] },
    { code: 'for (;;) { if (ok()) break; if (Date.now() > until) throw new Error("late"); await tick(); }', errors: [loop] },
    { code: 'do { await tick(); } while (!ok() && Date.now() - started < 5000);', errors: [loop] },
    // A counted loop of timer sleeps is a wall-clock budget too, and is
    // reported once, not again for the sleep inside it.
    { code: 'for (let i = 0; i < 40 && !landed(); i++) await new Promise((r) => setTimeout(r, 25));', errors: [loop] },
    { code: 'while (!ok()) { await new Promise((resolve) => { setTimeout(resolve, 20); }); }', errors: [loop] },
    // Two clues in one loop: one report.
    { code: 'while (Date.now() < end) { if (ok()) break; await new Promise((r) => setTimeout(r, 10)); }', errors: [loop] },
    // Fixed sleeps, as a barrier and as a negative window.
    { code: 'await new Promise((r) => setTimeout(r, 300)); assert(landed());', errors: [sleep] },
    { code: 'await new Promise((resolve) => { setTimeout(resolve, 1200); }); assert(!refetched());', errors: [sleep] },
    { code: 'await new Promise(function (r) { setTimeout(r, ms); });', errors: [sleep] },
  ],
});

log('no-private-test-wait: all cases pass');
