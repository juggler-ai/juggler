//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/** @typedef {import('estree').Node & {parent?: ASTNode, [key: string]: unknown}} ASTNode */

/**
 * ESLint rule: a test waits through the one wait primitive, never a clock of
 * its own.
 *
 * Every bound in a test must follow the test's progress (`waitFor`,
 * `pollPatiently`, `racePatiently` and `deadlineTimer`, which ride the
 * deadline the stall watchdog moves), because any bound measured on the wall
 * clock is a guess at how fast this core is, and on a slow one the guess is
 * wrong. Two shapes make that guess privately, and this flags both:
 *
 * - **A private polling loop**: a loop that compares against `Date.now()`
 *   (`while (Date.now() < deadline)`, `if (Date.now() > until) throw`), or that
 *   sleeps on a timer each round (`for (let i = 0; i < 40 && !done(); i++)
 *   await sleep(25)` — a fixed number of fixed sleeps is a wall-clock budget
 *   too). Use `waitFor`.
 * - **A fixed sleep**: `await new Promise((r) => setTimeout(r, N))` with N not
 *   zero, outside such a loop. As a barrier ("let it land, then assert") it
 *   fails a slow core; as a negative window ("give it a chance, then assert it
 *   did not happen") it passes a slow core vacuously. Wait for the condition,
 *   or for the later event that would have carried the effect and then assert
 *   it is absent.
 *
 * A zero-delay sleep is a yield to the task queue, not a guess at a duration,
 * and is left alone. A duration that is itself what a case tests — a fixture's
 * delay, a hold that must outlast a timeout — disables the line and says so.
 * The wait primitives' own modules are where clocks belong and are not given
 * this rule (tooling/eslint.config.js).
 * @type {import('eslint').Rule.RuleModule}
 */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Tests wait through waitFor and the deadline, never a private loop or a fixed sleep' },
    schema: [],
    messages: {
      loop: 'A private polling loop measures the wall clock, which is a guess at how fast this core is. '
        + 'Use waitFor (js-tests/utilities/test-helpers.js): it follows the test\'s progress and names what it waited for.',
      sleep: 'A fixed sleep is a guess at how long something takes, wrong on a slow core. Wait for the condition with '
        + 'waitFor; to show something did NOT happen, wait for the later event that would have carried it, then assert '
        + 'it is absent. A duration that is itself the subject may disable this line, saying why.',
    },
  },
  create(context) {
    const LOOPS = new Set(['WhileStatement', 'DoWhileStatement', 'ForStatement', 'ForOfStatement', 'ForInStatement']);
    const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
    const RELATIONAL = new Set(['<', '<=', '>', '>=']);

    /**
     * @param {ASTNode} node - Any node.
     * @returns {boolean} Whether it is a call to `Date.now()`.
     */
    const isDateNow = (node) => node?.type === 'CallExpression'
      && node.callee.type === 'MemberExpression' && !node.callee.computed
      && node.callee.object.type === 'Identifier' && node.callee.object.name === 'Date'
      && node.callee.property.type === 'Identifier' && node.callee.property.name === 'now';

    /**
     * Whether `node` — the argument of an `await` — is a timer sleep:
     * `new Promise((r) => setTimeout(r, delay))`, braces or not.
     * @param {ASTNode} node - The awaited expression.
     * @returns {{delay: ASTNode|undefined}|null} The delay expression when it is one.
     */
    const timerSleep = (node) => {
      if (node?.type !== 'NewExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'Promise') return null;
      const fn = node.arguments[0];
      if (!fn || !FUNCTIONS.has(fn.type) || fn.params[0]?.type !== 'Identifier') return null;
      const resolve = fn.params[0].name;
      let call = fn.body;
      if (call.type === 'BlockStatement') {
        if (call.body.length !== 1 || call.body[0].type !== 'ExpressionStatement') return null;
        call = call.body[0].expression;
      }
      if (call.type !== 'CallExpression' || call.callee.type !== 'Identifier' || call.callee.name !== 'setTimeout') return null;
      const [cb, delay] = call.arguments;
      if (cb?.type !== 'Identifier' || cb.name !== resolve) return null;
      return { delay };
    };

    /**
     * @param {ASTNode} delay - A sleep's delay expression (absent means 0).
     * @returns {boolean} Whether it is literally zero.
     */
    const isZero = (delay) => !delay || (delay.type === 'Literal' && delay.value === 0);

    /**
     * The innermost loop enclosing `node` within its own function, if any.
     * @param {ASTNode} node - The node.
     * @returns {ASTNode|null} The loop, or null.
     */
    const enclosingLoop = (node) => {
      for (let n = node.parent; n; n = n.parent) {
        if (FUNCTIONS.has(n.type)) return null;
        if (LOOPS.has(n.type)) return n;
      }
      return null;
    };

    /** Loops already reported, so neither a second clue nor the sleep inside is reported again. */
    const reported = new Set();
    /** @param {ASTNode} loop - The loop to report once. */
    const reportLoop = (loop) => {
      if (reported.has(loop)) return;
      reported.add(loop);
      context.report({ node: loop, messageId: 'loop' });
    };

    /** Sleeps outside any loop, reported at the end so a later loop clue can claim them first. */
    const looseSleeps = [];

    return {
      BinaryExpression(node) {
        if (!RELATIONAL.has(node.operator)) return;
        const mentionsNow = (/** @type {ASTNode} */ side) => {
          if (isDateNow(side)) return true;
          return side?.type === 'BinaryExpression' && (isDateNow(side.left) || isDateNow(side.right));
        };
        if (!mentionsNow(node.left) && !mentionsNow(node.right)) return;
        const loop = enclosingLoop(node);
        if (loop) reportLoop(loop);
      },
      AwaitExpression(node) {
        const sleep = timerSleep(node.argument);
        // A zero-delay sleep yields to the task queue — in a loop, a count of
        // task hops, which a slow core does not change.
        if (!sleep || isZero(sleep.delay)) return;
        const loop = enclosingLoop(node);
        if (loop) reportLoop(loop);
        else looseSleeps.push(node);
      },
      'Program:exit'() {
        for (const node of looseSleeps) context.report({ node, messageId: 'sleep' });
      },
    };
  },
};
