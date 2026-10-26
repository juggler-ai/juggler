  //     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
  //     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
  //   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import js from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';
import stylistic from '@stylistic/eslint-plugin';
import noAbsoluteApiUrl from './eslint-rules/no-absolute-api-url.js';
import noRawUiString from './eslint-rules/no-raw-ui-string.js';
import testHooksInTestsOnly from './eslint-rules/test-hooks-in-tests-only.js';
import sdkBoundary from './eslint-rules/sdk-boundary.js';
import escapeHtmlInterpolation from './eslint-rules/escape-html-interpolation.js';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

// Juggler's own rules, as one plugin object: flat config refuses a second,
// different object under the same plugin name, and both blocks below use it.
const jugglerPlugin = {
  rules: {
    'no-absolute-api-url': noAbsoluteApiUrl,
    'no-raw-ui-string': noRawUiString,
    'test-hooks-in-tests-only': testHooksInTestsOnly,
    'sdk-boundary': sdkBoundary,
    'escape-html-interpolation': escapeHtmlInterpolation,
  },
};

// The declared crossings of the SDK/app boundary (juggler/sdk-boundary below).
// Each entry is `{ why, imports }`; the rule wants file → imports.
const SDK_BOUNDARY = JSON.parse(readFileSync(new URL('./sdk-boundary.json', import.meta.url), 'utf8'));
/**
 * @param {Record<string, {imports: string[]}>} entries - The declarations of one boundary
 * @returns {Record<string, string[]>} Each file's declared imports
 */
const boundaryImports = (entries) => Object.fromEntries(Object.entries(entries).map(([file, e]) => [file, e.imports]));
// The declared crossings of the model/view boundary, in the same shape, beside
// the file's own `_comment`.
const LAYER_BOUNDARY = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(new URL('./layer-boundary.json', import.meta.url), 'utf8')))
    .filter(([file]) => !file.startsWith('_'))
);

// UI source: every file a user can see text from. Tests and vendored code are not.
const UI_FILES = ['web/js/**/*.js', 'web/sdk/**/*.js', 'web/extensions/**/*.js', 'web/machine/**/*.js'];
const NOT_UI = ['web/js/vendor/**', 'web/extensions/**/_tests/**/*.js'];

// Test files: raw console.log calls must go through the logger with a proper
// prefix. This catches the misuse like "console.log('[TestScorer] Scoring
// task:')" without the actual data.
const TEST_CONSOLE_SELECTORS = [
  {
    selector: "CallExpression[callee.object.name='console'][callee.property.name='log'][arguments.0.type='BinaryExpression']",
    message: 'Do not use console.log with concatenation. Import logger from test-logger.js and use logger.info(), logger.debug(), or logger.essential() with template literals instead.'
  },
  {
    selector: "CallExpression[callee.object.name='console'][callee.property.name='log'][arguments.length>1]",
    message: 'Do not use console.log with multiple arguments. Import logger from test-logger.js and use logger methods with template literals for proper formatting.'
  },
  {
    selector: "CallExpression[callee.object.name='console'][callee.property.name='log'][arguments.0.type='Literal'][arguments.0.value=/^\\[(?!ESSENTIAL|INFO|DEBUG|LLM)/]",
    message: 'Do not use console.log with custom prefixes. Import logger from test-logger.js and use logger.info(), logger.debug(), or logger.essential() instead. The logger will add proper prefixes.'
  }
];

// Test files: one polling wait, the shared one. A private `waitFor` polls a bare
// wall clock, so it fails on a busy machine that the shared helper — which asks
// the machine for more time before giving up — would have waited out.
const LOCAL_WAITFOR_MESSAGE = 'Do not declare a local waitFor. Import waitFor from js-tests/utilities/test-helpers.js: it takes (predicate, description, timeoutMs) or (predicate, options), returns the predicate\'s value, and is load-aware where a private copy is not.';
const TEST_LOCAL_WAITFOR_SELECTORS = [
  { selector: "FunctionDeclaration[id.name='waitFor']", message: LOCAL_WAITFOR_MESSAGE },
  { selector: "VariableDeclarator[id.name='waitFor']", message: LOCAL_WAITFOR_MESSAGE },
];

export default [
  js.configs.recommended,
  jsdoc.configs['flat/recommended'],
  {
    ignores: ['web/js/vendor/**'],
  },
  {
    files: ['web/js/**/*.js', 'web/sdk/**/*.js', 'web/extensions/**/*.js', 'web/machine/**/*.js', 'web/js-tests/**/*.js', 'examples/**/*.js'],
    plugins: { '@stylistic': stylistic },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Browser globals
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        customElements: 'readonly',
        HTMLElement: 'readonly',
        WebSocket: 'readonly',
        BroadcastChannel: 'readonly',
        CustomEvent: 'readonly',
        MessageEvent: 'readonly',
        MessageChannel: 'readonly',
        navigator: 'readonly',
        CSS: 'readonly',
        location: 'readonly',
        Element: 'readonly',
        Node: 'readonly',
        NodeFilter: 'readonly',
        Range: 'readonly',
        Highlight: 'readonly',
        DOMException: 'readonly',
        DOMMatrixReadOnly: 'readonly',
        DOMRect: 'readonly',
        PopStateEvent: 'readonly',
        getComputedStyle: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        Event: 'readonly',
        KeyboardEvent: 'readonly',
        MouseEvent: 'readonly',
        PointerEvent: 'readonly',
        MutationObserver: 'readonly',
        IntersectionObserver: 'readonly',
        ResizeObserver: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        queueMicrotask: 'readonly',
        confirm: 'readonly',
        self: 'readonly',
        performance: 'readonly',
        Worker: 'readonly',

        // Standard JavaScript
        Map: 'readonly',
        Set: 'readonly',
        Promise: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Blob: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        AbortController: 'readonly',
        SVGElement: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',

        // Third-party libraries loaded via script tags
        hljs: 'readonly',       // highlight.js
        marked: 'readonly',     // markdown parser
      },
    },
    rules: {
      // Indentation - enforce 2-space indent (auto-fixable). Catches the
      // broken-indent edits that ESLint's recommended preset lets through.
      '@stylistic/indent': ['error', 2, { SwitchCase: 1 }],

      // Code quality - ALL ERRORS (no warnings)
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none', // Allow unused catch parameters
      }],
      'no-console': 'off', // We use console for logging (but see test-specific rules below)
      'no-debugger': 'error',
      // Off: a variable is given its fallback where it is declared, and a
      // `catch` restates it — `let ok = false; try { ok = f(); } catch { ok = false; }`.
      // The rule calls the first assignment useless; it is what tells the
      // reader (and tsc) the variable's type and its value when nothing else ran.
      'no-useless-assignment': 'off',

      // Best practices
      'eqeqeq': ['error', 'always'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-with': 'error',
      'prefer-const': 'error',
      'no-var': 'error',

      // Async/Promise
      'no-async-promise-executor': 'error',
      'require-await': 'off', // Allow async without await (useful for interface consistency)

      // Potential errors
      'no-case-declarations': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-empty': 'error',
      'no-ex-assign': 'error',
      'no-extra-boolean-cast': 'error',
      'no-func-assign': 'error',
      'no-invalid-regexp': 'error',
      'no-irregular-whitespace': 'error',
      'no-obj-calls': 'error',
      'no-sparse-arrays': 'error',
      'no-unexpected-multiline': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',

      // JSDoc validation - enforce strong typing
      // A @param list that disagrees with the signature is an error, so a
      // caller typed against a stale signature is caught at lint time.
      'jsdoc/check-param-names': ['error', {
        checkDestructured: false,  // Don't enforce destructured params
      }],
      'jsdoc/require-param': ['error', {
        checkDestructured: false,  // Don't require docs for destructured params
        exemptedBy: ['inheritdoc', 'override'],  // Skip if inheriting docs
      }],
      'jsdoc/require-param-type': 'error',      // Requires types for params
      'jsdoc/require-returns': ['error', {
        checkGetters: false,       // Don't require returns for getters
        exemptedBy: ['inheritdoc', 'override'],
      }],
      'jsdoc/require-returns-type': 'error',    // Requires return types

      // Type checking (strict)
      'jsdoc/check-types': 'error',             // Enforce lowercase 'object' not 'Object'
      'jsdoc/check-tag-names': ['error', { definedTags: ['plugin-api'] }], // Enforce @augments over @extends; allow @plugin-api
      'jsdoc/valid-types': 'off',               // Allow function|null syntax
      'jsdoc/check-alignment': 'error',         // Enforce aligned JSDoc blocks
      'jsdoc/reject-any-type': 'off',           // Allow 'any' type - JS doesn't have proper unknown narrowing

      // Style (strict)
      'jsdoc/tag-lines': ['error', 'never'],    // No blank lines after block description
      'jsdoc/require-param-description': 'off', // Descriptions optional for now
      'jsdoc/require-returns-description': 'error', // Require returns description
      'jsdoc/no-defaults': 'off',               // Allow default values in docs
      'jsdoc/no-undefined-types': 'off',        // Allow browser/custom types
      'jsdoc/reject-function-type': 'off',      // Allow Function type
      'jsdoc/no-multi-asterisks': 'off',        // Allow decorative comment formatting

      // Property validation (off for now)
      'jsdoc/check-property-names': 'off',
      'jsdoc/require-property': 'off',
      'jsdoc/require-property-name': 'off',
      'jsdoc/require-property-type': 'off',
      'jsdoc/require-param-name': 'off',        // Already checked by check-param-names

      // ===================================================================
      // Enforce ES6 imports - prevent window global pollution
      // ===================================================================
      // This prevents regression back to the old window.* pattern.
      // Services, registries, and stores MUST use ES6 imports.
      // Acceptable window.* usage: showAlert, showConfirm, showPrompt,
      // jugglerApp (debugging), browser APIs
      'no-restricted-syntax': [
        'error',
        // ===================================================================
        // Forbid the strategyOwnerIframeId ownership-election bodge
        // ===================================================================
        // Session-wide flow (strategy onActivate/onWorkerIdle, tool execution)
        // runs in the ONE engine, decided by the worker — never in a per-iframe
        // "owner" elected by matching an iframe nonce stored in the doc. That
        // trick silently stops hooks firing for any conversation reopened in a
        // fresh page. The worker dispatches run-strategy-hook to the engine.
        {
          selector: "Literal[value='strategyOwnerIframeId']",
          message: 'FORBIDDEN: strategyOwnerIframeId reintroduces per-viewer ownership election for session-wide flow. The worker drives strategy hooks in the engine (run-strategy-hook).'
        },
        {
          selector: "AssignmentExpression[left.object.name='window'][left.property.name=/^(apiService|wsService|actionExecutor|Session|Conversation|eventBus|escapeHtml)$/]",
          message: 'Do not assign service/registry singletons to window. Use ES6 export default instead.'
        },
        {
          selector: "MemberExpression[object.name='window'][property.name=/^(apiService|wsService|actionExecutor|Session|Conversation|eventBus)$/]",
          message: 'Do not access services/registries via window globals. Import them using ES6 imports instead. Example: import apiService from \'./services/api.js\''
        },
        // ===================================================================
        // Enforce typed ops-api.js - prevent direct /api/ops/call usage
        // ===================================================================
        // All backend operations MUST go through ops-api.js for type safety.
        // This prevents runtime errors from parameter typos and wrong types.
        // The URL itself is built by apiUrl() (juggler/no-absolute-api-url),
        // so the call to catch is apiUrl('/ops/call').
        {
          selector: "CallExpression[callee.name='apiUrl'] > Literal[value=/^\\/ops\\/call/]",
          message: 'FORBIDDEN: Direct fetch() to /api/ops/call detected. Use typed functions from ops-api.js instead. Example: import { readFile } from \'./services/ops-api.js\' and call readFile(params)'
        },
        {
          selector: "CallExpression[callee.name='apiUrl'] > TemplateLiteral:has(TemplateElement[value.raw=/^\\/ops\\/call/])",
          message: 'FORBIDDEN: Direct fetch() to /api/ops/call detected. Use typed functions from ops-api.js instead. Example: import { readFile } from \'./services/ops-api.js\' and call readFile(params)'
        },
        // ===================================================================
        // Enforce ContextBuilder - prevent manual context string concatenation
        // ===================================================================
        // All LLM context MUST be built using ContextBuilder semantic API.
        // This prevents hardcoded formatting and ensures provider flexibility.
        {
          selector: "AssignmentExpression[operator='+='][left.name=/^(context|llmContext|llmMessage|currentMessage)$/]",
          message: 'FORBIDDEN: Manual LLM context string concatenation detected. Use ContextBuilder semantic API instead. Import { ContextBuilder } from \'./services/context-builder.js\' and use the builder API.'
        },
        // ===================================================================
        // Prevent dangerous String() coercion on error objects
        // ===================================================================
        // String() on an object produces "[object Object]" which is useless.
        // Use extractErrorMessage() from error-utils.js instead.
        {
          selector: "CallExpression[callee.name='String'][arguments.0.type='Identifier'][arguments.0.name=/^(error|err|reason|result|outcome|response)$/]",
          message: 'Avoid String(error) - use extractErrorMessage() from error-utils.js instead. String() on objects produces "[object Object]".'
        },
        {
          selector: "CallExpression[callee.name='String'][arguments.0.type='LogicalExpression'][arguments.0.left.type='MemberExpression']",
          message: 'Avoid String(obj.prop || fallback) - use extractErrorMessage() from error-utils.js for error handling. String() on objects produces "[object Object]".'
        },
        // ===================================================================
        // Enforce worker-only item mutations - prevent proxy cache desync
        // ===================================================================
        // Direct mutations to conversation.items bypass the worker and cause
        // state desync. Use worker commands: workerManager.insertItem() or
        // workerManager.removeItemsAt() instead.
        // NOTE: The method call rule (push/splice) is here. Assignment rule is
        // in a separate override for conversation.js only (to avoid false
        // positives in other classes that have their own 'items' property).
        {
          selector: "CallExpression[callee.property.name=/^(push|pop|shift|unshift|splice)$/][callee.object.property.name='items']",
          message: 'FORBIDDEN: Direct mutation of .items detected. Route through worker: workerManager.insertItem() or workerManager.removeItemsAt(). Direct mutations cause proxy/worker state desync.'
        },
        // ===================================================================
        // Enforce plugin polymorphism - prevent hardcoded tool-name branches
        // ===================================================================
        // Tool-name string comparisons (e.g. `toolName === 'bash'`) embed
        // plugin-specific behavior in general UI/service code. That breaks
        // the ContextItem plugin contract. Override the relevant method
        // (renderToolActionDetails, getResultSectionLabel, getStatusUI, ...)
        // on the plugin class instead. See web/sdk/context-item.js.
        // The base plugin classes themselves are exempted by the override
        // block for `web/sdk/**` below.
        // Match when a tool-name-shaped variable/property is compared to a known
        // plugin tool-name literal. Restricting the LHS to identifiers/properties
        // matching `/toolName/i` avoids false positives on unrelated string
        // comparisons (e.g. `category === 'read'`, `status === 'plan...'`).
        {
          selector: "BinaryExpression[operator=/^(===|==|!==|!=)$/][left.type='Identifier'][left.name=/[Tt]oolName/][right.type='Literal'][right.value=/^(bash|read|read_file|write|write_file|edit|replace_text|grep|search|glob|batch_read|batch_grep|websearch|webfetch|query_code|askuserquestion|plan)$/]",
          message: 'FORBIDDEN: Hardcoded plugin tool-name comparison. Add behavior to the ContextItem plugin class (renderToolActionDetails, getResultSectionLabel, getStatusUI, etc.) instead of branching in general code. See web/sdk/context-item.js.'
        },
        {
          selector: "BinaryExpression[operator=/^(===|==|!==|!=)$/][left.type='MemberExpression'][left.property.name=/[Tt]oolName/][right.type='Literal'][right.value=/^(bash|read|read_file|write|write_file|edit|replace_text|grep|search|glob|batch_read|batch_grep|websearch|webfetch|query_code|askuserquestion|plan)$/]",
          message: 'FORBIDDEN: Hardcoded plugin tool-name comparison. Add behavior to the ContextItem plugin class instead. See web/sdk/context-item.js.'
        },
        {
          selector: "BinaryExpression[operator=/^(===|==|!==|!=)$/][right.type='Identifier'][right.name=/[Tt]oolName/][left.type='Literal'][left.value=/^(bash|read|read_file|write|write_file|edit|replace_text|grep|search|glob|batch_read|batch_grep|websearch|webfetch|query_code|askuserquestion|plan)$/]",
          message: 'FORBIDDEN: Hardcoded plugin tool-name comparison. Add behavior to the ContextItem plugin class instead. See web/sdk/context-item.js.'
        },
        {
          selector: "BinaryExpression[operator=/^(===|==|!==|!=)$/][right.type='MemberExpression'][right.property.name=/[Tt]oolName/][left.type='Literal'][left.value=/^(bash|read|read_file|write|write_file|edit|replace_text|grep|search|glob|batch_read|batch_grep|websearch|webfetch|query_code|askuserquestion|plan)$/]",
          message: 'FORBIDDEN: Hardcoded plugin tool-name comparison. Add behavior to the ContextItem plugin class instead. See web/sdk/context-item.js.'
        }
      ],
    },
  },
  // ===================================================================
  // Every /api URL is built by web/js/utils/api-url.js
  // ===================================================================
  // A server may be mounted under a path prefix (the machine server's
  // /s/<id>/), so client code never writes an absolute '/api/…' URL. Tests
  // are exempt: they match request URLs in fetch stubs, not build them. The
  // machine server's sessions page always sits at its origin's root, so its
  // one API client, control-api.js, addresses /api/server/* as written.
  {
    files: ['web/js/**/*.js', 'web/sdk/**/*.js', 'web/extensions/**/*.js', 'web/machine/**/*.js'],
    ignores: ['web/extensions/**/_tests/**/*.js', 'web/js/utils/api-url.js', 'web/machine/control-api.js'],
    plugins: { juggler: jugglerPlugin },
    rules: {
      'juggler/no-absolute-api-url': 'error',
    },
  },
  // ===================================================================
  // The SDK/app boundary (juggler/sdk-boundary)
  // ===================================================================
  // web/sdk/** is Apache-2.0 and web/js/** is AGPL. An SDK module that imports
  // the app binds the public interface to this host's implementation; each
  // such binding is declared in tooling/sdk-boundary.json, and LICENSING.md's
  // boundary audit is rendered from that file (TestLicensingBoundaryAudit).
  {
    files: ['web/sdk/**/*.js'],
    plugins: { juggler: jugglerPlugin },
    rules: {
      'juggler/sdk-boundary': ['error', {
        forbidden: ['web/js/'],
        allowed: boundaryImports(SDK_BOUNDARY.sdk),
        hint: 'An SDK module reaches the app only through a host binding declared, with its reason, under "sdk" in tooling/sdk-boundary.json (which LICENSING.md is rendered from).',
      }],
    },
  },
  // A bundled extension is written the way a third-party one must be: through
  // the juggler/* specifiers, since no relative path reaches web/js/ or
  // web/sdk/lib/ from a user extension's directory. The exceptions are the
  // built-ins that ARE a host feature (its own store, cache or settings UI),
  // each declared with its reason under "extensions" in tooling/sdk-boundary.json.
  {
    files: ['web/extensions/**/*.js'],
    ignores: ['web/extensions/**/_tests/**/*.js'],
    plugins: { juggler: jugglerPlugin },
    rules: {
      'juggler/sdk-boundary': ['error', {
        forbidden: ['web/js/', 'web/sdk/lib/'],
        allowed: boundaryImports(SDK_BOUNDARY.extensions),
        hint: 'Import it through a juggler/* specifier (export it from the SDK façade if it is missing — every specifier is registered in the five places TestSDKSpecifiersRegisteredEverywhere checks). A built-in that is itself a host feature may be declared, with its reason, under "extensions" in tooling/sdk-boundary.json.',
      }],
    },
  },
  // ===================================================================
  // The model/view boundary (juggler/sdk-boundary, tooling/layer-boundary.json)
  // ===================================================================
  // The model and the services announce what happened and ask for UI through
  // ports; the components decide what to show. A model or service module that
  // imports a component makes the layer below depend on the view — and on
  // whatever that component's module does as it loads.
  {
    files: ['web/js/model/**/*.js', 'web/js/services/**/*.js', 'web/js/registries/**/*.js'],
    plugins: { juggler: jugglerPlugin },
    rules: {
      'juggler/sdk-boundary': ['error', {
        forbidden: ['web/js/components/'],
        allowed: boundaryImports(LAYER_BOUNDARY),
        declaredIn: 'tooling/layer-boundary.json',
        hint: 'Ask for the UI through a port the component registers into (services/ui-port.js for dialogs, services/settings-launcher.js for settings), or move the logic out of components/. A crossing that cannot move yet is declared, with its reason, in tooling/layer-boundary.json.',
      }],
    },
  },
  // ===================================================================
  // Test hooks are reached only from tests (juggler/test-hooks-in-tests-only)
  // ===================================================================
  // A module's test seams ship with it — `__…` exports, `…ForTests` methods —
  // so nothing but a test may call one. The tests are web/js-tests/ and each
  // extension's _tests/.
  {
    files: ['web/js/**/*.js', 'web/sdk/**/*.js', 'web/extensions/**/*.js', 'web/machine/**/*.js'],
    ignores: ['web/extensions/**/_tests/**/*.js'],
    plugins: { juggler: jugglerPlugin },
    rules: {
      'juggler/test-hooks-in-tests-only': 'error',
    },
  },
  // ===================================================================
  // Markup templates escape what they interpolate (juggler/escape-html-interpolation)
  // ===================================================================
  // Every `${}` in a template written to innerHTML / outerHTML /
  // insertAdjacentHTML is escaped, or is named …HTML / …Html / …Svg because it
  // is built markup. Tests build fixtures, not UI, and are exempt.
  {
    files: ['web/js/**/*.js', 'web/sdk/**/*.js', 'web/extensions/**/*.js', 'web/machine/**/*.js'],
    ignores: ['web/extensions/**/_tests/**/*.js'],
    plugins: { juggler: jugglerPlugin },
    rules: {
      'juggler/escape-html-interpolation': 'error',
    },
  },
  // ===================================================================
  // Web Storage is reached through services/prefs.js
  // ===================================================================
  // A preference belongs to a realm (tab, device, window, project, machine,
  // user), and the realm decides who shares it. Writing localStorage directly
  // picks one without saying so, and per port, which is not per project. The
  // files listed are the deliberate exceptions, each for a reason prefs.js
  // cannot serve:
  //   prefs.js                  — the realms themselves
  //   theme-manager             — the device's record of the OS light/dark setting
  //   viewer-id                 — a tab's identity, not a preference
  //   websocket                 — a reload throttle, not a preference
  //   scheduled-send-service    — a claim lock between same-origin windows
  {
    files: ['web/js/**/*.js', 'web/sdk/**/*.js', 'web/extensions/**/*.js', 'web/machine/**/*.js'],
    ignores: [
      'web/extensions/**/_tests/**/*.js',
      'web/js/services/prefs.js',
      'web/js/utils/theme-manager.js',
      'web/js/utils/viewer-id.js',
      'web/js/services/websocket.js',
      'web/js/services/scheduled-send-service.js',
    ],
    rules: {
      'no-restricted-globals': ['error',
        ...['localStorage', 'sessionStorage'].map((name) => ({
          name,
          message: 'Store preferences through services/prefs.js, choosing the realm by who the value belongs to (its header explains each). A non-preference use goes on the exceptions list in tooling/eslint.config.js, with its reason.',
        })),
      ],
      'no-restricted-properties': ['error',
        ...['window', 'globalThis', 'self'].flatMap((object) => ['localStorage', 'sessionStorage'].map((property) => ({
          object,
          property,
          message: 'Store preferences through services/prefs.js, choosing the realm by who the value belongs to (its header explains each).',
        }))),
      ],
    },
  },
  // ===================================================================
  // UI text goes through t() (juggler/no-raw-ui-string)
  // ===================================================================
  // Every UI file: raw user-visible strings, and t() at module scope.
  {
    files: UI_FILES,
    ignores: NOT_UI,
    plugins: { juggler: jugglerPlugin },
    rules: {
      'juggler/no-raw-ui-string': 'error',
    },
  },
  // ===================================================================
  // Infrastructure files - exempt from /api/ops/call restriction
  // ===================================================================
  {
    files: [
      'web/js/services/ops-api.js',
      'web/js/services/action-executor.js',
      'web/js-tests/**/*.js',
      'web/extensions/**/_tests/**/*.js'
    ],
    rules: {
      // These files are allowed to call /api/ops/call directly
      'no-restricted-syntax': 'off'
    }
  },
  // ===================================================================
  // Conversation.js - enforce worker-only state mutations
  // ===================================================================
  // These rules catch direct assignments to worker-synced state.
  // All mutations to items and context items must route through worker commands.
  {
    files: ['web/js/model/conversation.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "AssignmentExpression[left.property.name='items'][left.object.type='ThisExpression']",
          message: 'FORBIDDEN: Direct assignment to this.items detected. Route the mutation through a worker command.'
        },
        {
          selector: "AssignmentExpression[left.property.name='_contextItems'][left.object.type='ThisExpression']",
          message: 'FORBIDDEN: Direct assignment to this._contextItems detected. Use addContextItem()/removeContextItem()/clearContextItems() which sync to worker.'
        },
        // Prevent direct state/result mutations on tool-action items - must route through worker
        // NOTE: These catch common patterns like msg.state, toolAction.result, etc.
        // Excludes: this.result (conversation's own property), method return objects
        {
          selector: "AssignmentExpression[left.property.name='state'][left.object.type='Identifier']",
          message: 'FORBIDDEN: Direct mutation of item.state detected. Route through worker: workerManager.completeToolAction() or workerManager.resolveApproval(). Direct mutations cause worker state desync.'
        },
        {
          selector: "AssignmentExpression[left.property.name='result'][left.object.type='Identifier'][left.object.name!='this']",
          message: 'FORBIDDEN: Direct mutation of item.result detected. Route through worker: workerManager.completeToolAction(). Direct mutations cause worker state desync.'
        }
      ]
    }
  },
  // ===================================================================
  // Response-handler.js - enforce worker-only state mutations
  // ===================================================================
  {
    files: ['web/js/services/response-handler.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "AssignmentExpression[left.property.name='state'][left.object.type='Identifier']",
          message: 'FORBIDDEN: Direct mutation of item.state detected. Route through worker: workerManager.completeToolAction() or workerManager.resolveApproval().'
        },
        {
          selector: "AssignmentExpression[left.property.name='result'][left.object.type='Identifier'][left.object.name!='this']",
          message: 'FORBIDDEN: Direct mutation of item.result detected. Route through worker: workerManager.completeToolAction().'
        }
      ]
    }
  },
  // ===================================================================
  // Files allowed to use String() with safe ternary patterns
  // ===================================================================
  // These files use the safe pattern: err instanceof Error ? err.message : String(err)
  // This pattern is safe because Error objects use .message, and String() only runs on
  // non-Error values (which are typically primitives). The ESLint rule is too aggressive
  // to distinguish this pattern from dangerous direct String(error) calls.
  {
    files: [
      'web/sdk/lib/error-utils.js',
      'web/extensions/juggler-core/context-items/*.js',
      // Worker entry/diagnostic files follow the same safe
      // `err instanceof Error ? err.message : String(err)` pattern.
      'web/js/engine-worker-runtime.js',
      'web/js/engine-worker-main.js',
    ],
    rules: {
      // These files follow safe error handling patterns
      'no-restricted-syntax': 'off'
    }
  },
  // ===================================================================
  // Plugin Architecture Enforcement
  // ===================================================================
  {
    files: ['web/extensions/**/*-context-item.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // Prevent direct Yjs mutations in plugins
          selector: "CallExpression[callee.property.name=/^(push|insert|delete|splice)$/][callee.object.property.name=/^(items|contextItems)$/]",
          message: 'FORBIDDEN: Direct Yjs mutations in plugins. Use Conversation API methods (addMessage, insertMessage, addContextItem, removeContextItem, etc.)'
        },
        {
          // Prevent document.dispatchEvent for state changes in plugins
          selector: "CallExpression[callee.object.name='document'][callee.property.name='dispatchEvent']",
          message: 'FORBIDDEN: document.dispatchEvent in plugins. Use instance callbacks (onContentChange, onRefreshStateChange) or Conversation methods which trigger Yjs observers automatically.'
        }
      ]
    }
  },
  // ===================================================================
  // Tools reach the rooted ops through their item, never directly
  // ===================================================================
  // pins/file-pin.js and lib/live-file.js read paths a user gesture vouched
  // for, and are excluded while that path (userInitiated) is reviewed.
  {
    files: ['web/extensions/**/*.js'],
    ignores: [
      'web/extensions/**/_tests/**/*.js',
      'web/extensions/juggler-core/pins/file-pin.js',
      'web/extensions/juggler-core/lib/live-file.js',
    ],
    rules: {
      // Every op below runs somewhere, and where is a property of the ITEM —
      // its conversation's workspace, and the roots its user has granted — not
      // of the call. Imported directly they take those as optional arguments,
      // so forgetting them was silent: the op ran in the project and looked
      // exactly like it had worked. `this.ops` cannot be built without them.
      // An item that genuinely means the project (memory, whose file is the
      // project's and never a worktree's) disables this by name, with a reason.
      // The rule covers all extension code, not only the tool items, because a
      // helper module a tool imports runs under that tool's scope just the same.
      // Only a ContextItem has `this.ops`: a pin or a viewer has no
      // conversation to scope by, and states with a disable why it means the
      // project (or the path it was handed).
      'no-restricted-imports': ['error', {
        paths: [{
          name: 'juggler/ops',
          importNames: [
            'readFile', 'writeFile', 'editFile', 'editFileLines', 'fileHash',
            'stat', 'mkdir', 'getTree', 'expandDirectory', 'glob', 'grep',
            'findSymbol', 'shell', 'shellBackground', 'shellStreaming',
            'FileSystem', 'ReadOnlyFileSystem'
          ],
          message: 'Use this.ops.<name>() instead — the item carries the workspace and allowed-paths grant these ops run under. Importing them directly makes both optional, and an op that quietly ran in the project looks exactly like one that worked. See ContextItem#ops. Code with no item to scope by (a pin, a viewer) disables this by name, saying why it means the project.'
        }]
      }],
    },
  },
  // ===================================================================
  // Base plugin classes - allow helper methods
  // ===================================================================
  {
    files: [
      'web/sdk/context-item.js',
      'web/sdk/strategy-type.js',
      'web/sdk/command-type.js'
    ],
    rules: {
      // Base classes have helper methods like emitEvent() that use document.dispatchEvent
      // for lifecycle events (context-item:created, context-item:activated, etc.)
      'no-restricted-syntax': 'off'
    }
  },
  // ===================================================================
  // Test files configuration - enforce proper logging
  // ===================================================================
  {
    files: ['web/js-tests/**/*.js', 'web/extensions/**/_tests/**/*.js'],
    ignores: ['web/js-tests/test-logger.js'], // Exclude logger itself
    rules: {
      // In test files, console.log should not be used directly
      // Instead, use the logger module with proper log levels
      'no-console': ['error', {
        allow: ['error', 'warn'] // Allow console.error and console.warn for critical issues
      }],

      'no-restricted-syntax': ['error', ...TEST_CONSOLE_SELECTORS, ...TEST_LOCAL_WAITFOR_SELECTORS],
    },
  },
  // The shared waitFor is declared here, so this one file keeps only the
  // console rules (a later block's rule replaces an earlier one's outright).
  {
    files: ['web/js-tests/utilities/test-helpers.js'],
    rules: {
      'no-restricted-syntax': ['error', ...TEST_CONSOLE_SELECTORS],
    },
  },
];
