//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import * as espree from 'espree';
import * as eslintScope from 'eslint-scope';

/** @typedef {import('estree').Node & {parent?: ASTNode, [key: string]: unknown}} ASTNode */
/** @typedef {import('eslint').Scope.Scope} Scope */
/** @typedef {import('eslint').Scope.Variable} Variable */
/** @typedef {{getScope: (node: ASTNode) => Scope, filename: string}} ModuleView */
/**
 * What waiting on a timer expression amounts to. `delays` holds each timer's
 * delay expression — `undefined` when absent, NONZERO when only known not to be
 * zero; `race` is set when a timer bounds other work rather than being the
 * wait (a deadline); `viaHelper` when every timer in it is reached through a
 * helper call.
 * @typedef {{delays: Array<ASTNode|undefined>, race: boolean, viaHelper: boolean}} TimerWait
 */
/**
 * A function whose result is a timer wait; `race` when that wait is a deadline.
 * `delayParam` is the index of the parameter its one delay is read from, with
 * that parameter's default.
 * @typedef {{delays: Array<ASTNode|undefined>, race: boolean, delayParam?: number, defaultDelay?: ASTNode}} TimerHelper
 */

/**
 * ESLint rule: a test waits through the one wait primitive, never a clock of
 * its own.
 *
 * Every bound in a test must follow the test's progress (`waitFor`,
 * `pollPatiently`, `racePatiently` and `deadlineTimer`, which ride the
 * deadline the stall watchdog moves), because any bound measured on the wall
 * clock is a guess at how fast this core is, and on a slow one the guess is
 * wrong. The rule follows what a promise waits on, not what anything is
 * called. A **timer promise** is a `new Promise(executor)` whose executor —
 * inline, or a local function passed by name — arms `setTimeout` or
 * `setInterval` (bare, through `window`/`globalThis`/`self`, or a local alias)
 * with its resolve or reject, among any other work: the settler itself
 * wherever it is armed, or a callback that calls one when the executor arms it
 * directly (a timer an event handler arms to defer a re-check is that event's).
 * Its timer is a **deadline** when it only rejects or another settler can win.
 * A **timer wait** is a timer promise, a `.then`/`.catch`/`.finally` chain on
 * one, a `Promise.race/any/all/allSettled` over one (`race`/`any` make it a
 * deadline), or a call to a timer helper: a function, local or imported from a
 * relative module (followed through re-exports), or `setTimeout` from
 * `node:timers/promises`. A delay that is not literally `0` (or absent) counts
 * as a duration. It flags:
 *
 * - **A timer helper**: any function — declaration, expression, arrow or
 *   method — that returns a timer wait, or whose body does nothing but await
 *   them. Its name and how its delay arrives (parameter, default, constant,
 *   literal) do not matter: a helper hides each sleep it serves from this rule.
 *   A zero-delay one is a copy of `nextTask` (js-tests/utilities/
 *   test-helpers.js), the one shared yield.
 * - **A private polling loop**: a loop that compares against `Date.now()` or
 *   `performance.now()` (`while (Date.now() < deadline)`, `if (Date.now() >
 *   until) throw`), or that awaits a timer wait with a duration each round
 *   (`for (let i = 0; i < 40 && !done(); i++) await sleep(25)` — a fixed number
 *   of fixed sleeps is a wall-clock budget too). Use `waitFor`.
 * - **A fixed sleep**: a timer wait with a duration anywhere else — awaited,
 *   chained, or held to be awaited later. As a barrier ("let it land, then
 *   assert") it fails a slow core; as a negative window ("give it a chance,
 *   then assert it did not happen") it passes a slow core vacuously. Wait for
 *   the condition, or for the later event that would have carried the effect
 *   and then assert it is absent.
 * - **A private deadline**: a deadline timer wait written in place, in a loop
 *   or not. Use `racePatiently`. A call to a deadline helper — or a function
 *   that only passes one on — is bound by it rather than sleeping, and is
 *   answered where the helper is defined.
 *
 * A zero-delay timer wait written inline is a yield to the task queue, not a
 * guess at a duration — alone or counted in a loop, since a slow core does not
 * change a count of task hops — and is left alone. A duration that is itself
 * what a case tests — a fixture's delay, a hold that must outlast a timeout —
 * disables its one line, naming this rule and saying why:
 * `// eslint-disable-next-line juggler/no-private-test-wait -- <reason>`. A
 * disable without the reason, one that names no rule, and the `eslint-disable`
 * block and `eslint-disable-line` forms that would cover this rule are each
 * reported, at a place the directive itself does not cover.
 * The wait primitives' own modules are where clocks belong and are not given
 * this rule (tooling/eslint.config.js).
 * @type {import('eslint').Rule.RuleModule}
 */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Tests wait through waitFor and the deadline, never a private loop, a fixed sleep or a timer helper' },
    schema: [],
    messages: {
      loop: 'A private polling loop measures the wall clock, which is a guess at how fast this core is. '
        + 'Use waitFor (js-tests/utilities/test-helpers.js): it follows the test\'s progress and names what it waited for.',
      sleep: 'A fixed sleep is a guess at how long something takes, wrong on a slow core. Wait for the condition with '
        + 'waitFor; to show something did NOT happen, wait for the later event that would have carried it, then assert '
        + 'it is absent. A duration that is itself the subject may disable this line, saying why.',
      race: 'Racing the work against a wall-clock timer is a private deadline, wrong on a slow core. Use racePatiently '
        + '(js-tests/utilities/test-patience.js), whose bound follows the test\'s progress.',
      helper: 'A local timer helper hides every wall-clock wait it serves, whatever it is called. Wait for the condition '
        + 'with waitFor (js-tests/utilities/test-helpers.js), or bound a race with racePatiently (test-patience.js).',
      zeroHelper: 'A local zero-delay yield is a copy of the shared one: import nextTask from '
        + 'js-tests/utilities/test-helpers.js instead.',
      disableReason: 'Say why the duration is the subject: `// eslint-disable-next-line {{rule}} -- <reason>`.',
      disableBare: 'A disable that names no rule switches {{rule}} off without saying so. Name it, with the reason: '
        + '`// eslint-disable-next-line {{rule}} -- <reason>`.',
      disableForm: 'The {{form}} on line {{line}} switches {{rule}} off for more than one line, or for its own line. '
        + 'Disable it one line at a time, with the reason: `// eslint-disable-next-line {{rule}} -- <reason>`.',
    },
  },
  create(context) {
    const { sourceCode } = context;
    const view = { getScope: (/** @type {ASTNode} */ node) => sourceCode.getScope(node), filename: context.physicalFilename ?? context.filename };
    const analysis = createAnalysis(view);
    const { timerWait, helperOf, isZero, isTimerPromise, helperCallee, boundByHelper } = analysis;

    const RELATIONAL = new Set(['<', '<=', '>', '>=']);

    /**
     * @param {ASTNode} node - Any node.
     * @returns {boolean} Whether it is a call to `Date.now()` or `performance.now()`.
     */
    const isClock = (node) => node?.type === 'CallExpression'
      && node.callee.type === 'MemberExpression' && !node.callee.computed
      && node.callee.object.type === 'Identifier' && ['Date', 'performance'].includes(node.callee.object.name)
      && node.callee.property.type === 'Identifier' && node.callee.property.name === 'now';

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

    /** @type {ASTNode[]} */ const functions = [];
    /** @type {ASTNode[]} */ const awaits = [];
    /** @type {ASTNode[]} */ const seeds = [];

    /**
     * Reports each disable directive that would switch this rule off without
     * a reason, without naming it, or for more than the one line after it.
     */
    const checkDirectives = () => {
      const lineCount = sourceCode.lines.length;
      for (const directive of sourceCode.getDisableDirectives().directives) {
        if (directive.type === 'enable') continue;
        const rules = directive.value.split(',').map((s) => s.trim()).filter(Boolean);
        if (rules.length && !rules.includes(context.id)) continue;
        const { loc } = directive.node;
        const data = { rule: context.id };
        if (directive.type === 'disable-next-line') {
          if (!rules.length) context.report({ loc, messageId: 'disableBare', data });
          else if (!directive.justification) context.report({ loc, messageId: 'disableReason', data });
          continue;
        }
        // A block disable covers from where it starts and a line disable its
        // whole line, so the report goes just before what each covers.
        const { line, column } = loc.start;
        let at = loc.start;
        if (directive.type === 'disable' && column > 0) at = { line, column: 0 };
        else if (line > 1) at = { line: line - 1, column: 0 };
        else if (directive.type === 'disable-line' && line < lineCount) at = { line: line + 1, column: 0 };
        const form = directive.type === 'disable' ? '`eslint-disable` block' : '`eslint-disable-line`';
        context.report({ loc: at, messageId: 'disableForm', data: { ...data, form, line: String(line) } });
      }
    };

    /**
     * The outermost expression a timer wait at `node` is part of: up through
     * chains, combinators and conditionals.
     * @param {ASTNode} node - A timer promise or helper call.
     * @returns {ASTNode} The expression its waiting is decided by.
     */
    const outermostWait = (node) => {
      let cur = node;
      for (;;) {
        const p = cur.parent;
        if (p?.type === 'MemberExpression' && p.object === cur && p.parent?.type === 'CallExpression'
          && p.parent.callee === p && CHAINS.has(propertyName(p))) cur = p.parent;
        else if (p?.type === 'ArrayExpression' && p.parent?.type === 'CallExpression' && p.parent.arguments[0] === p
          && isPromiseCombinator(p.parent.callee, analysis)) cur = p.parent;
        else if ((p?.type === 'ConditionalExpression' && p.test !== cur) || p?.type === 'LogicalExpression') cur = p;
        else return cur;
      }
    };

    return {
      'FunctionDeclaration, FunctionExpression, ArrowFunctionExpression'(node) { functions.push(node); },
      AwaitExpression(node) { awaits.push(node); },
      NewExpression(node) { seeds.push(node); },
      CallExpression(node) { seeds.push(node); },
      BinaryExpression(node) {
        if (!RELATIONAL.has(node.operator)) return;
        const mentionsClock = (/** @type {ASTNode} */ side) => {
          if (isClock(side)) return true;
          return side?.type === 'BinaryExpression' && (isClock(side.left) || isClock(side.right));
        };
        if (!mentionsClock(node.left) && !mentionsClock(node.right)) return;
        const loop = enclosingLoop(node);
        if (loop) reportLoop(loop);
      },
      'Program:exit'() {
        checkDirectives();

        // Helpers first: what waits inside one is the helper's, reported once.
        const helpers = new Set();
        for (const fn of functions) {
          const info = helperOf(fn);
          if (!info) continue;
          helpers.add(fn);
          const at = fn.parent?.type === 'VariableDeclarator' || fn.parent?.type === 'MethodDefinition'
            || (fn.parent?.type === 'Property' && fn.parent.value === fn) ? fn.parent : fn;
          context.report({ node: at, messageId: info.delays.every(isZero) ? 'zeroHelper' : 'helper' });
        }
        const inHelper = (/** @type {ASTNode} */ node) => helpers.has(enclosingFunction(node));

        const handled = new Set();
        for (const node of awaits) {
          if (inHelper(node)) continue;
          const wait = timerWait(node.argument);
          if (!wait) continue;
          handled.add(node.argument);
          // A zero-delay wait yields to the task queue — in a loop, a count of
          // task hops, which a slow core does not change.
          if (boundByHelper(wait) || wait.delays.every(isZero)) continue;
          // A deadline is reported where it is written, in a loop or not: the
          // loop waits on the work, which the deadline only bounds.
          if (wait.race) { context.report({ node, messageId: 'race' }); continue; }
          const loop = enclosingLoop(node);
          if (loop) reportLoop(loop);
          else context.report({ node, messageId: 'sleep' });
        }

        // Timer waits not awaited where they are made: chained, held, passed on.
        const seen = new Set();
        for (const seed of seeds) {
          if (!(seed.type === 'NewExpression' ? isTimerPromise(seed) : helperCallee(seed))) continue;
          const outer = outermostWait(seed);
          if (seen.has(outer) || handled.has(outer) || inHelper(outer)) continue;
          seen.add(outer);
          const wait = timerWait(outer);
          if (!wait || boundByHelper(wait) || wait.delays.every(isZero)) continue;
          context.report({ node: outer, messageId: wait.race ? 'race' : 'sleep' });
        }
      },
    };
  },
};

const LOOPS = new Set(['WhileStatement', 'DoWhileStatement', 'ForStatement', 'ForOfStatement', 'ForInStatement']);
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const TIMERS = new Set(['setTimeout', 'setInterval']);
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self']);
const CHAINS = new Set(['then', 'catch', 'finally']);
const COMBINATORS = new Set(['race', 'any', 'all', 'allSettled']);
const RACES = new Set(['race', 'any']);
const TIMER_PROMISE_MODULES = new Set(['timers/promises', 'node:timers/promises']);
/** A delay known only not to be zero. */
const NONZERO = /** @type {ASTNode} */ (/** @type {unknown} */ ({ type: 'NonZeroDelay' }));

/**
 * @param {ASTNode} member - A MemberExpression.
 * @returns {string|undefined} Its property's name, when written as one.
 */
const propertyName = (member) => (!member.computed && member.property.type === 'Identifier' ? member.property.name : undefined);

/**
 * @param {ASTNode} node - Any node.
 * @returns {ASTNode|null} The function it is in, if any.
 */
const enclosingFunction = (node) => {
  for (let n = node.parent; n; n = n.parent) if (FUNCTIONS.has(n.type)) return n;
  return null;
};

/**
 * @param {ASTNode} callee - A call's callee.
 * @param {{isGlobal: (id: ASTNode) => boolean}} analysis - The module's analysis.
 * @returns {string|undefined} The combinator, for `Promise.race` and its kin.
 */
const isPromiseCombinator = (callee, analysis) => (callee.type === 'MemberExpression'
  && callee.object.type === 'Identifier' && callee.object.name === 'Promise' && analysis.isGlobal(callee.object)
  && COMBINATORS.has(propertyName(callee) ?? '') ? propertyName(callee) : undefined);

/**
 * Calls `visit` on every node below `node`, nested functions included.
 * @param {ASTNode} node - The root.
 * @param {(n: ASTNode) => void} visit - The visitor.
 */
const walk = (node, visit) => {
  for (const key of espree.VisitorKeys[node.type] ?? []) {
    const child = node[key];
    for (const c of Array.isArray(child) ? child : [child]) {
      if (c && typeof c.type === 'string') { visit(c); walk(c, visit); }
    }
  }
};

/** Modules read for the helpers they export, by path, with the stamp they were read at. */
const moduleCache = new Map();

/**
 * The analysis of another module, for the helpers it exports; null when it
 * cannot be read or parsed.
 * @param {string} file - Absolute path.
 * @returns {ReturnType<typeof createAnalysis>|null} Its analysis.
 */
const loadModule = (file) => {
  let stamp;
  try {
    const st = statSync(file);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
  const cached = moduleCache.get(file);
  if (cached?.stamp === stamp) return cached.analysis;
  const entry = { stamp, analysis: /** @type {ReturnType<typeof createAnalysis>|null} */ (null) };
  moduleCache.set(file, entry);
  try {
    const ast = espree.parse(readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true });
    const setParents = (/** @type {ASTNode} */ n) => {
      for (const key of espree.VisitorKeys[n.type] ?? []) {
        const child = n[key];
        for (const c of Array.isArray(child) ? child : [child]) {
          if (c && typeof c.type === 'string') { c.parent = n; setParents(c); }
        }
      }
    };
    setParents(ast);
    const scopeManager = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: 'module' });
    const getScope = (/** @type {ASTNode} */ node) => {
      for (let n = node; n; n = n.parent) {
        const scope = scopeManager.acquire(n, n.type !== 'Program');
        if (scope) return scope.type === 'function-expression-name' ? scope.childScopes[0] : scope;
      }
      return scopeManager.globalScope;
    };
    entry.analysis = createAnalysis({ getScope, filename: file }, ast);
  } catch {
    entry.analysis = null;
  }
  return entry.analysis;
};

/**
 * What one module's timer promises, timer waits and helpers are.
 * @param {ModuleView} view - How to look up its scopes, and where it lives.
 * @param {ASTNode} [program] - Its AST, for finding what it exports.
 * @returns {object} The analysis.
 */
function createAnalysis(view, program) {
  /** @type {Map<ASTNode, TimerHelper|null|'pending'>} */
  const helperMemo = new Map();

  /**
   * @param {ASTNode} id - An identifier.
   * @returns {Variable|null} The variable it refers to, or null when it is a global or undeclared.
   */
  const variableOf = (id) => {
    for (let scope = view.getScope(id); scope; scope = scope.upper) {
      const v = scope.set.get(id.name);
      if (v) return v.defs.length ? v : null;
    }
    return null;
  };

  /**
   * @param {ASTNode} id - An identifier.
   * @returns {boolean} Whether it names the global of that name.
   */
  const isGlobal = (id) => !variableOf(id);

  /**
   * The value a const-like local is bound to: declared once and never reassigned.
   * @param {Variable|null} v - A variable.
   * @returns {ASTNode|null} Its initialiser, or the function it declares.
   */
  const boundValue = (v) => {
    if (!v || v.defs.length !== 1) return null;
    const [def] = v.defs;
    if (def.type === 'FunctionName') return def.node;
    if (def.type !== 'Variable' || def.node.id.type !== 'Identifier' || !def.node.init) return null;
    if (def.parent.kind !== 'const' && v.references.some((/** @type {import('eslint').Scope.Reference} */ r) => r.isWrite() && !r.init)) return null;
    return def.node.init;
  };

  /**
   * @param {ASTNode} node - A callee or an executor.
   * @param {number} [depth] - How many aliases were followed to reach it.
   * @returns {boolean} Whether it is `setTimeout`/`setInterval`: bare, on a global object, or a local alias.
   */
  const isTimerRef = (node, depth = 0) => {
    if (node.type === 'MemberExpression') {
      return node.object.type === 'Identifier' && GLOBAL_OBJECTS.has(node.object.name) && isGlobal(node.object)
        && TIMERS.has(propertyName(node) ?? '');
    }
    if (node.type !== 'Identifier') return false;
    const v = variableOf(node);
    if (!v) return TIMERS.has(node.name);
    // An alias of an alias is followed a few steps, so a cycle ends.
    const value = depth < 8 ? boundValue(v) : null;
    return !!value && (value.type === 'Identifier' || value.type === 'MemberExpression') && isTimerRef(value, depth + 1);
  };

  /**
   * The delays of the timers an executor settles its promise from.
   * @param {ASTNode} fn - The executor function.
   * @returns {Array<ASTNode|undefined>|null} Each timer's delay, or null when no timer settles it.
   */
  const executorDelays = (fn) => {
    const [resolveParam, rejectParam] = fn.params;
    const resolveName = resolveParam?.type === 'Identifier' ? resolveParam.name : null;
    const rejectName = rejectParam?.type === 'Identifier' ? rejectParam.name : null;
    const isSettler = (/** @type {ASTNode} */ n) => n?.type === 'Identifier' && (n.name === resolveName || n.name === rejectName);
    if (!resolveName && !rejectName) return null;
    /**
     * @param {ASTNode} n - A node, itself included.
     * @param {(m: ASTNode) => void} visit - The visitor.
     */
    const each = (n, visit) => { visit(n); walk(n, visit); };
    /** @type {Array<ASTNode|undefined>} */ const delays = [];
    /** Settler references the timers account for. */
    const timed = new Set();
    let resolves = false;
    each(fn.body, (n) => {
      if (n.type !== 'CallExpression' || !isTimerRef(n.callee)) return;
      const [cb, delay] = n.arguments;
      if (!cb) return;
      /** @type {ASTNode[]} */ const refs = [];
      if (isSettler(cb)) refs.push(cb);
      // A timer whose callback settles counts when the executor arms it
      // itself; one a nested callback arms (an event handler deferring a
      // re-check) is that event's, and the event decides the promise.
      else if (FUNCTIONS.has(cb.type) && enclosingFunction(n) === fn) {
        each(cb.body, (m) => {
          if (m.type === 'CallExpression' && isSettler(m.callee)) refs.push(m.callee);
        });
      }
      if (!refs.length) return;
      delays.push(delay);
      for (const r of refs) {
        timed.add(r);
        if (r.name === resolveName) resolves = true;
      }
    });
    if (!delays.length) return null;
    // A timer that only rejects, or one that races another settler, bounds
    // the wait rather than being it: a deadline.
    let elsewhere = false;
    walk(fn.body, (n) => {
      if (!isSettler(n) || timed.has(n)) return;
      const p = n.parent;
      const isName = (p?.type === 'MemberExpression' && p.property === n && !p.computed)
        || (p?.type === 'Property' && p.key === n && !p.computed && !p.shorthand);
      if (!isName) elsewhere = true;
    });
    return { delays, race: !resolves || elsewhere };
  };

  /**
   * @param {ASTNode} node - Any expression.
   * @returns {{delays: Array<ASTNode|undefined>, race: boolean}|null} A timer promise's delays, and whether its timer is a deadline; null when it is not one.
   */
  const timerPromiseDelays = (node) => {
    if (node?.type !== 'NewExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'Promise' || !isGlobal(node.callee)) return null;
    const executor = node.arguments[0];
    if (!executor) return null;
    if (FUNCTIONS.has(executor.type)) return executorDelays(executor);
    // `new Promise(setTimeout)` arms a timer with no delay.
    if (isTimerRef(executor)) return { delays: [undefined], race: false };
    if (executor.type === 'Identifier') {
      const fn = boundValue(variableOf(executor));
      if (fn && FUNCTIONS.has(fn.type)) return executorDelays(fn);
    }
    return null;
  };

  /**
   * The timer helper a callee names: a local function, an import from a
   * relative module, or `node:timers/promises`'s `setTimeout`.
   * @param {ASTNode} call - A CallExpression.
   * @returns {TimerHelper|null} The helper, when it is one.
   */
  const helperCallee = (call) => {
    if (call?.type !== 'CallExpression' || call.callee.type !== 'Identifier') return null;
    const v = variableOf(call.callee);
    if (!v || v.defs.length !== 1) return null;
    const [def] = v.defs;
    if (def.type === 'ImportBinding') {
      const source = def.parent.source.value;
      const imported = def.node.type === 'ImportSpecifier'
        ? (def.node.imported.name ?? def.node.imported.value)
        : def.node.type === 'ImportDefaultSpecifier' ? 'default' : null;
      if (!imported) return null;
      if (TIMER_PROMISE_MODULES.has(source)) return imported === 'setTimeout' ? { delays: [NONZERO], race: false, delayParam: 0 } : null;
      return importedHelper(source, imported);
    }
    const fn = boundValue(v);
    return fn && FUNCTIONS.has(fn.type) ? helperOf(fn) : null;
  };

  /**
   * @param {string} source - A module specifier.
   * @param {string} name - The export's name.
   * @returns {TimerHelper|null} The exported timer helper, if that is what it is.
   */
  const importedHelper = (source, name) => {
    if (!source.startsWith('.') || !path.isAbsolute(view.filename)) return null;
    const other = loadModule(path.resolve(path.dirname(view.filename), source));
    return other ? other.exportedHelper(name) : null;
  };

  /**
   * @param {TimerHelper} helper - A helper.
   * @param {ASTNode} call - A call to it.
   * @returns {Array<ASTNode|undefined>} The delays this call waits on.
   */
  const callDelays = (helper, call) => {
    if (helper.delayParam === undefined) return helper.delays.every(isZero) ? [undefined] : [NONZERO];
    const arg = call.arguments[helper.delayParam];
    return [arg === undefined ? helper.defaultDelay : arg];
  };

  /**
   * What waiting on `node` amounts to, when it is a timer wait.
   * @param {ASTNode} node - Any expression.
   * @returns {TimerWait|null} The wait, or null when no timer decides it.
   */
  const timerWait = (node) => {
    if (!node) return null;
    const own = timerPromiseDelays(node);
    if (own) return { ...own, viaHelper: false };
    if (node.type === 'AwaitExpression') return timerWait(node.argument);
    /**
     * @param {Array<TimerWait|null>} found - The waits of an expression's parts.
     * @param {boolean} race - Whether the expression itself races them.
     * @returns {TimerWait|null} Their combined wait.
     */
    const combine = (found, race) => {
      const parts = /** @type {TimerWait[]} */ (found.filter(Boolean));
      return parts.length ? {
        delays: parts.flatMap((p) => p.delays),
        race: race || parts.some((p) => p.race),
        viaHelper: parts.every((p) => p.viaHelper),
      } : null;
    };
    if (node.type === 'ConditionalExpression') return combine([node.consequent, node.alternate].map(timerWait), false);
    if (node.type === 'LogicalExpression') return combine([node.left, node.right].map(timerWait), false);
    if (node.type !== 'CallExpression') return null;
    const { callee } = node;
    if (callee.type === 'MemberExpression' && CHAINS.has(propertyName(callee) ?? '')) return timerWait(callee.object);
    const combinator = isPromiseCombinator(callee, { isGlobal });
    if (combinator) {
      const list = node.arguments[0];
      if (list?.type !== 'ArrayExpression') return null;
      return combine(list.elements.map((e) => (e ? timerWait(e) : null)), RACES.has(combinator));
    }
    const helper = helperCallee(node);
    return helper ? { delays: callDelays(helper, node), race: helper.race, viaHelper: true } : null;
  };

  /**
   * @param {TimerWait} wait - A timer wait.
   * @returns {boolean} Whether it is only a call to a deadline helper, which is
   *   bound by that helper's deadline rather than sleeping, and is answered
   *   where the helper is defined.
   */
  const boundByHelper = (wait) => wait.race && wait.viaHelper;

  /**
   * The timer waits a statement consists of, when it does nothing else.
   * @param {ASTNode} stmt - A statement.
   * @returns {TimerWait[]|null} Its waits, or null when it does anything but wait on timers.
   */
  const onlyWaits = (stmt) => {
    switch (stmt.type) {
      case 'EmptyStatement': return [];
      case 'BlockStatement': {
        const all = [];
        for (const s of stmt.body) {
          const w = onlyWaits(s);
          if (!w) return null;
          all.push(...w);
        }
        return all;
      }
      case 'ExpressionStatement': {
        if (stmt.expression.type !== 'AwaitExpression') return null;
        const w = timerWait(stmt.expression.argument);
        return w ? [w] : null;
      }
      case 'ReturnStatement': return stmt.argument ? null : [];
      case 'WhileStatement': case 'DoWhileStatement': case 'ForStatement': case 'ForOfStatement': case 'ForInStatement':
        return onlyWaits(stmt.body);
      default: return null;
    }
  };

  /**
   * Whether `fn` is a timer helper: it returns a timer wait, or does nothing but await them.
   * @param {ASTNode} fn - A function.
   * @returns {TimerHelper|null} The helper it is, or null.
   */
  const helperOf = (fn) => {
    const memo = helperMemo.get(fn);
    if (memo === 'pending') return null;
    if (memo !== undefined) return memo;
    helperMemo.set(fn, 'pending');
    /** @type {TimerWait[]} */ let waits = [];
    if (fn.body.type !== 'BlockStatement') {
      const w = timerWait(fn.body);
      if (w) waits.push(w);
    } else {
      walk(fn.body, (n) => {
        if (n.type === 'ReturnStatement' && n.argument && enclosingFunction(n) === fn) {
          const w = timerWait(n.argument);
          if (w) waits.push(w);
        }
      });
      if (!waits.length) waits = onlyWaits(fn.body) ?? [];
    }
    // Passing a deadline helper's wait on is calling it, not being one.
    waits = waits.filter((w) => !boundByHelper(w));
    /** @type {TimerHelper|null} */ let helper = null;
    if (waits.length) {
      const delays = waits.flatMap((w) => w.delays);
      helper = { delays, race: waits.every((w) => w.race) };
      const [only] = delays;
      if (delays.length === 1 && only?.type === 'Identifier') {
        fn.params.forEach((/** @type {ASTNode} */ p, /** @type {number} */ i) => {
          const id = p.type === 'AssignmentPattern' ? p.left : p;
          if (id.type === 'Identifier' && id.name === only.name && helper) {
            helper.delayParam = i;
            if (p.type === 'AssignmentPattern') helper.defaultDelay = p.right;
          }
        });
      }
    }
    helperMemo.set(fn, helper);
    return helper;
  };

  /**
   * The timer helper this module exports under `name`, following re-exports.
   * @param {string} name - The export's name (`default` for the default export).
   * @returns {TimerHelper|null} The helper, if that is what it is.
   */
  const exportedHelper = (name) => {
    if (!program) return null;
    const asHelper = (/** @type {ASTNode|null|undefined} */ node) => (node && FUNCTIONS.has(node.type) ? helperOf(node) : null);
    /**
     * @param {string} local - A top-level binding's name.
     * @returns {TimerHelper|null} The helper that binding declares, if it is one.
     */
    const local = (local) => {
      for (const stmt of program.body) {
        const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
        if (decl?.type === 'FunctionDeclaration' && decl.id?.name === local) return asHelper(decl);
        if (decl?.type === 'VariableDeclaration') {
          for (const d of decl.declarations) if (d.id.type === 'Identifier' && d.id.name === local) return asHelper(d.init);
        }
      }
      return null;
    };
    for (const stmt of program.body) {
      if (name === 'default' && stmt.type === 'ExportDefaultDeclaration') {
        const d = stmt.declaration;
        return d.type === 'Identifier' ? local(d.name) : asHelper(d);
      }
      if (stmt.type !== 'ExportNamedDeclaration') continue;
      if (stmt.declaration) {
        const d = stmt.declaration;
        if (d.type === 'FunctionDeclaration' && d.id?.name === name) return asHelper(d);
        if (d.type === 'VariableDeclaration') {
          for (const v of d.declarations) if (v.id.type === 'Identifier' && v.id.name === name) return asHelper(v.init);
        }
        continue;
      }
      for (const spec of stmt.specifiers) {
        const exported = spec.exported.name ?? spec.exported.value;
        if (exported !== name) continue;
        const from = spec.local.name ?? spec.local.value;
        if (!stmt.source) return local(from);
        const source = stmt.source.value;
        if (!source.startsWith('.')) return null;
        const other = loadModule(path.resolve(path.dirname(view.filename), source));
        return other ? other.exportedHelper(from) : null;
      }
    }
    return null;
  };

  /**
   * @param {ASTNode|undefined} delay - A delay expression (absent means 0).
   * @returns {boolean} Whether it is literally zero.
   */
  const isZero = (delay) => !delay || (delay.type === 'Literal' && delay.value === 0);

  return {
    timerWait, helperOf, isZero, isGlobal, exportedHelper, helperCallee, boundByHelper,
    isTimerPromise: (/** @type {ASTNode} */ node) => !!timerPromiseDelays(node),
  };
}
