//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: query_code Tool
 *
 * Tests query_code through the full pipeline: sendMessage → worker → mock LLM → tool execution → Yjs sync.
 * Verifies that fs, path, grep, glob all work, and that errors are correctly reported.
 * @module integration-tests/query-code-tests
 */

import { textResponse, toolUseResponse, testDirFor } from '../utilities/integration-test-runner.js';

/**
 * Helper to build a standard query_code test definition.
 * @param {string} name - Test name
 * @param {string} description - Test description
 * @param {string} code - JavaScript code to execute
 * @param {string} expectedContent - Expected tool result content
 * @param {boolean} isError - Whether the result should be an error
 * @returns {import('../utilities/integration-test-runner.js').IntegrationTestDefinition} Test definition
 */
function queryTest(name, description, code, expectedContent, isError = false) {
  return {
    name,
    description,
    fixture: 'unit-test-fixture',
    llmResponses: [
      toolUseResponse('call_1', 'query_code', { code }, 'Running code.'),
      textResponse('Done.')
    ],
    operations: [
      { type: 'send-message', message: description }
    ],
    expectedDocument: {
      items: [
        { type: 'system-prompt', itemId: '$ITEM_1' },
        { type: 'user', content: description },
        { type: 'assistant', content: 'Running code.' },
        {
          type: 'tool-action',
          toolUseId: '$TOOL_1',
          toolName: 'query_code',
          toolInput: { code },
          state: 'completed',
          result: { content: expectedContent, isError }
        },
        { type: 'assistant', content: 'Done.' }
      ]
    }
  };
}

// ============================================================================
// TESTS: Consolidated into 4 representative tests
// ============================================================================

export const tests = [
  // fs.readFile — representative of all fs read helpers
  queryTest(
    'query-readFile',
    'query_code: fs.readFile returns file content',
    'const c = await fs.readFile("src/main.go");\nreturn c.includes("Hello, World!") ? "found" : "not found";',
    'found'
  ),

  // grep + glob — search helpers
  queryTest(
    'query-grep',
    'query_code: grep finds matches',
    'const r = await grep("func main");\nreturn r.length > 0 ? "matches found" : "no matches";',
    'matches found'
  ),

  // glob({ cwd }) should match Node-style fs.glob semantics: returned paths
  // are relative to cwd, so joining them back onto cwd must not duplicate the
  // absolute project root.
  queryTest(
    'query-glob-cwd-relative',
    'query_code: glob with absolute cwd returns relative paths',
    'const files = await glob("src/*.go", { cwd: projectRoot });\nconst f = files.find((x) => x === "src/main.go");\nif (!f) return JSON.stringify(files);\nconst c = await fs.readFile(path.join(projectRoot, f));\nreturn c.includes("Hello, World!") ? "relative" : "bad read";',
    'relative'
  ),

  // Read-only: writeFile blocked
  queryTest(
    'query-write-blocked',
    'query_code: fs.writeFile throws EROFS',
    'await fs.writeFile("hack.txt", "pwned");',
    'EROFS: read-only filesystem',
    true
  ),

  // Runtime error: ENOENT
  queryTest(
    'query-runtime-enoent',
    'query_code: ENOENT error reported',
    'return await fs.readFile("nonexistent-file.txt");',
    'ENOENT: no such file or directory: nonexistent-file.txt',
    true
  ),

  // Parse-time errors in user code should report the real syntax error, not
  // hang until the sandbox timeout fires. This mirrors an LLM mistake where it
  // redeclares an injected binding (`fs`) with `const fs = require(...)`.
  queryTest(
    'query-parse-error',
    'query_code: parse error reported without timeout',
    'const fs = require("fs/promises");\nreturn "unreachable";',
    'Cannot declare a const variable twice: \'fs\'.',
    true
  ),

  // Un-awaited Promise in the return value: grep/glob/fs/import() are async, so
  // returning one un-awaited leaves a Promise the host can't structured-clone.
  // That must be caught and reported (naming the offending path), NOT left to
  // hang until the sandbox timeout — the same "report, don't hang" contract as
  // the parse-error case above.
  queryTest(
    'query-unawaited-promise',
    'query_code: un-awaited Promise in return reported without timeout',
    'return { hits: grep("func main") };',
    'Return value .hits is a Promise that was never awaited. grep(), glob(), fs.*, and import() are async; await them before returning, e.g. return { x: await grep(...) } or await Promise.all([...]).',
    true
  ),

  // Absolute-path import: an LLM-natural `import('/abs/path/web/...')`
  // must resolve. The sandbox's import map rewrites the project-root
  // prefix to /v<ver>/, served same-origin with ACAO=*. Without the
  // rewrite this throws "Cross-origin script load denied".
  queryTest(
    'query-absolute-path-import',
    'query_code: can import() absolute project paths',
    'const m = await import(`${projectRoot}/web/js/model/model-config.js`);\nreturn typeof m.resolveConfig === "function" ? "ok" : "missing-export";',
    'ok'
  ),

  // On-disk project module import: a real JavaScript file anywhere in the user's
  // project (not just under web/) resolves from disk, so the model can load and
  // call the project's own code. src/greeter.js ships in unit-test-fixture.
  queryTest(
    'query-project-file-import',
    'query_code: can import() a project source module from disk',
    'const m = await import(`${projectRoot}/src/greeter.js`);\nreturn m.greet("World") === "Hello, World!" && m.ANSWER === 42 ? "ok" : "bad";',
    'ok'
  ),

  // Sandbox isolation: the untrusted code runs in a nested worker spawned by
  // the opaque-origin sandbox iframe, so the worker INHERITS that opaque
  // origin. That is what denies it the backend: its security origin is
  // "null", it has no window/document, and a fetch to the backend fails.
  // This is a tight regression guard — if the code ever ran in the privileged
  // engine worker instead, self.location.origin would be the real http origin
  // (and the fetch would reach the backend); if it ran in the main page,
  // `window` would be defined. Either fallback fails this assertion loudly.
  queryTest(
    'query-sandbox-isolation',
    'query_code: runs in an opaque-origin worker with no backend access',
    'const origin = (self.location && self.location.origin) || "none";\nlet net;\ntry { await fetch(origin + "/api/health"); net = "reached"; } catch (_) { net = "blocked"; }\nreturn `origin=${origin};window=${typeof window};document=${typeof document};net=${net}`;',
    'origin=null;window=undefined;document=undefined;net=blocked'
  ),

  // Capability-mediated access works while the same script's DIRECT backend
  // access is denied: fs.readFile (serviced on the host over the MessagePort)
  // returns real content, but a direct fetch of that same file off the backend
  // is blocked by the worker's opaque origin. Proves the only way out is the
  // mediated channel.
  queryTest(
    'query-capability-vs-direct',
    'query_code: capability works, direct backend access blocked',
    'const c = await fs.readFile("src/main.go");\nconst cap = c.includes("Hello, World!") ? "ok" : "no";\nlet direct;\ntry { await fetch("/api/completions/files?q=main"); direct = "reached"; } catch (_) { direct = "blocked"; }\nreturn `cap=${cap};direct=${direct}`;',
    'cap=ok;direct=blocked'
  ),

  // Printed output comes back with the result. Without capture, console.* went
  // to the hidden engine's devtools and the model never saw it.
  queryTest(
    'query-console',
    'query_code: console output is returned with the result',
    'console.log("hi", { a: 1 }, [2]);\nconsole.warn("careful");\nconsole.error(new Error("oops"));\nreturn 7;',
    '7\n\nConsole output:\nhi {"a":1} [2]\n[warn] careful\n[error] Error: oops'
  ),

  // A script that prints and then fails: the output is most useful exactly
  // here, so it rides the error rather than being lost with the result.
  queryTest(
    'query-console-then-throw',
    'query_code: console output survives a thrown error',
    'console.log("got this far");\nthrow new Error("boom");',
    'boom\n\nConsole output:\ngot this far',
    true
  ),

  // Output is capped where it is produced, so a print loop cannot flood the
  // channel or the transcript, and the cut is said out loud.
  queryTest(
    'query-console-cap',
    'query_code: console output is capped',
    'for (let i = 0; i < 500; i++) console.log("line " + i);\nreturn "done";',
    'done\n\nConsole output:\n'
      + Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
      + '\n… console output truncated (limit: 200 lines, 20000 characters)'
  ),

  // Read-credit for the freshness guard: an query_code script's fs.readFile
  // records the file in the action's filesRead map, which satisfies the edit
  // tool's read-before-edit guard (read-history.js). The target is seeded via
  // setupFiles — on disk but with NO transcript record — so only the sandbox
  // read can make the follow-up edit admissible.
  queryReadThenEditTest(),
];

/**
 * Build the query-read-then-edit test definition.
 * @returns {import('../utilities/integration-test-runner.js').IntegrationTestDefinition} Test definition
 */
function queryReadThenEditTest() {
  const TD = testDirFor('query-read-then-edit');
  const target = `${TD}/queried.txt`;
  const code = `const c = await fs.readFile(${JSON.stringify(target)});\nreturn c.trim();`;
  return {
    name: 'query-read-then-edit',
    description: 'query_code read satisfies the edit freshness guard',
    fixture: 'unit-test-fixture',
    setupFiles: {
      [target]: 'greeting: hello\n'
    },
    llmResponses: [
      toolUseResponse('call_1', 'query_code', { code }, 'Querying.'),
      toolUseResponse(
        'call_2',
        'edit',
        { file_path: target, old_string: 'greeting: hello', new_string: 'greeting: goodbye' },
        'Editing.'
      ),
      textResponse('Done.')
    ],
    operations: [
      { type: 'send-message', message: 'Query then edit the greeting' }
    ],
    expectedDocument: {
      items: [
        { type: 'system-prompt', itemId: '$ITEM_1' },
        { type: 'user', content: 'Query then edit the greeting' },
        { type: 'assistant', content: 'Querying.' },
        {
          type: 'tool-action',
          toolUseId: '$TOOL_1',
          toolName: 'query_code',
          toolInput: { code },
          state: 'completed',
          result: { content: 'greeting: hello', isError: false }
        },
        { type: 'assistant', content: 'Editing.' },
        {
          type: 'tool-action',
          toolUseId: '$TOOL_2',
          toolName: 'edit',
          toolInput: {
            file_path: target,
            old_string: 'greeting: hello',
            new_string: 'greeting: goodbye'
          },
          state: 'completed',
          result: {
            content: `Edited file: ${target}`,
            isError: false
          }
        },
        { type: 'assistant', content: 'Done.' }
      ]
    },
    fileAssertions: [
      { path: target, content: 'greeting: goodbye\n' }
    ]
  };
}
