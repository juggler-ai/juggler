//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * `juggler/ops` — the privileged host-operations layer.
 *
 * This is the keystone of third-party parity: the same file, shell, web, grep
 * and tree operations the built-in plugins use. These ops run
 * with the user's full authority — there is no per-extension sandbox. The
 * manifest `permissions` list is a *declaration* of the host access an
 * extension's code uses, surfaced to the user in the catalog and the
 * install/trust prompt; it is disclosure, not a gate. The real gate is the
 * user-approval layer (tool approval dialogs, allowed-paths), which applies to
 * every op regardless of what an extension declared in its manifest.
 *
 * The names below are a clean, guessable vocabulary (`readFile`, `glob`,
 * `grep`, `shell`, …), and they are the names `ops-api` itself uses: an op has
 * one name, whichever side of the SDK it is called from. Import what you need
 * by name; there is no bare `fetch`/`search` (those would shadow web globals). Use `httpRequest` for
 * generic server-side HTTP, or `webFetch`/`webSearch` for the convenience
 * specialisations. All three refuse private, loopback and link-local
 * destinations; `httpRequest`'s `allowPrivateHosts` is the only way to reach a
 * server on the machine or the network Juggler is running inside.
 */
import {
  readFile,
  writeFile,
  editFile,
  editFileLines,
  fileHash,
  stat,
  mkdir,
  getTree,
  expandDirectory,
  glob,
  copyTree,
  compareTrees,
  grep,
  findSymbol,
  shell,
  shellBackground
} from '../js/services/ops-api.js';
import { shellStreaming } from '../js/services/shell-streaming.js';
import { FileSystem, ReadOnlyFileSystem } from '../js/services/fs.js';

// No quote characters in comments inside these export lists: the engine
// worker's import rewriter (cmd/juggler/server/worker_module.go) reads one as
// the start of a module specifier, and the engine then fails to load.
export {
  OpsError,
  MAX_EXEC_TIMEOUT_MS,
  DEFAULT_EXEC_TIMEOUT_MS,
  // Filesystem
  readFile,
  uploadAssetBase64,
  // The snapshot a program tool keeps while one of its calls waits on the user
  saveProgramSnapshot,
  loadProgramSnapshot,
  deleteProgramSnapshot,
  writeFile,
  editFile,
  editFileLines,
  fileHash,
  stat,
  mkdir,
  // Directory tree
  getTree,
  expandDirectory,
  glob,
  copyTree,
  compareTrees,
  // Search
  grep,
  findSymbol,
  // Shell
  shell,
  shellBackground,
  shellOutput,
  shellOutputDelta,
  shellKill,
  // Liveness for tasks you already hold ids for. Not an inventory: it answers
  // only about the ids you pass, and carries no output, so a surface watching a
  // long-lived task polls this rather than dragging the whole log back with
  // `shellOutput` every few seconds.
  shellStatus,
  // Web
  httpRequest,
  webFetch,
  webSearch,
  // Extension configuration
  extensionConfigGet,
  extensionConfigSet,
  extensionConfigResolve,
  // LLM (out-of-band text generation, and decisions from a decision model)
  generateText,
  decide,
  // OS integration
  openPath,
  revealPath,
  // Environment variables shell commands get in this project
  projectEnvGet,
  projectEnvApprove,
  projectEnvSet,
  // MCP (Model Context Protocol) client
  mcpListServers,
  mcpListTools,
  mcpSnapshot,
  mcpCallTool,
  mcpServerControl,
  mcpGetLog,
  mcpGetConfig,
  mcpSetConfig,
} from '../js/services/ops-api.js';

// Live shell execution is the one op that streams rather than returning once,
// so it rides the WebSocket instead of /api/ops/call and lives beside it.
export {
  shellStreaming,
  cancelShellStreaming,
} from '../js/services/shell-streaming.js';

export { FileSystem, ReadOnlyFileSystem } from '../js/services/fs.js';

/**
 * @typedef {object} OpsScope
 * @property {string[]} [allowedPaths] - The caller's explicit allowed-path grants.
 * @property {string} [workspaceId] - The workspace the caller works in ('' = project).
 */

/**
 * The rooted operations, minus the two arguments the facade supplies. Each is
 * the identically-named export above with `allowedPaths` and `workspaceId`
 * already in it.
 * @typedef {object} BoundOps
 * @property {(params: Parameters<typeof readFile>[0], signal?: AbortSignal) => ReturnType<typeof readFile>} readFile - Read a file.
 * @property {(params: Parameters<typeof writeFile>[0], signal?: AbortSignal) => ReturnType<typeof writeFile>} writeFile - Create or overwrite a file.
 * @property {(params: Parameters<typeof editFile>[0], signal?: AbortSignal) => ReturnType<typeof editFile>} editFile - Search-and-replace within a file.
 * @property {(params: Parameters<typeof editFileLines>[0], signal?: AbortSignal) => ReturnType<typeof editFileLines>} editFileLines - Replace a line range.
 * @property {(params: Parameters<typeof fileHash>[0], signal?: AbortSignal) => ReturnType<typeof fileHash>} fileHash - Hash a file, for staleness checks.
 * @property {(params: Parameters<typeof stat>[0], signal?: AbortSignal) => ReturnType<typeof stat>} stat - File/directory metadata.
 * @property {(params: Parameters<typeof mkdir>[0], signal?: AbortSignal) => ReturnType<typeof mkdir>} mkdir - Create a directory.
 * @property {(params: Parameters<typeof getTree>[0], signal?: AbortSignal) => ReturnType<typeof getTree>} getTree - Directory tree.
 * @property {(params: Parameters<typeof expandDirectory>[0], signal?: AbortSignal) => ReturnType<typeof expandDirectory>} expandDirectory - One directory's entries.
 * @property {(params: Parameters<typeof glob>[0], signal?: AbortSignal) => ReturnType<typeof glob>} glob - Files matching a pattern.
 * @property {(params: Parameters<typeof copyTree>[0], signal?: AbortSignal) => ReturnType<typeof copyTree>} copyTree - Copy a tree, respecting the ignore rules.
 * @property {(params: Parameters<typeof compareTrees>[0], signal?: AbortSignal) => ReturnType<typeof compareTrees>} compareTrees - Say how two trees differ.
 * @property {(params: Parameters<typeof grep>[0], signal?: AbortSignal) => ReturnType<typeof grep>} grep - Search file contents.
 * @property {(params: Parameters<typeof findSymbol>[0], signal?: AbortSignal) => ReturnType<typeof findSymbol>} findSymbol - Find a symbol's definition.
 * @property {(params: Parameters<typeof shell>[0], signal?: AbortSignal) => ReturnType<typeof shell>} shell - Run a command and wait for it; aborting the signal kills it.
 * @property {(params: Parameters<typeof shellBackground>[0]) => ReturnType<typeof shellBackground>} shellBackground - Start a command in the background (stopped by id, not by signal).
 * @property {(params: Parameters<typeof shellStreaming>[0], onOutput: Parameters<typeof shellStreaming>[1], signal?: AbortSignal) => ReturnType<typeof shellStreaming>} shellStreaming - Run a command, streaming its output.
 * @property {() => FileSystem} fileSystem - An fs.promises-alike rooted here.
 * @property {() => ReadOnlyFileSystem} readOnlyFileSystem - The same, refusing writes.
 */

/**
 * The ops above, with the caller's scope already in them.
 *
 * Every operation below is rooted somewhere, and the two facts that say where —
 * the workspace it runs in and the roots the user has granted outside it — are
 * properties of the CALLER, not of the call. Passed per call site they are
 * optional, and omitting them is silent: the op runs, in the project, and looks
 * exactly like it worked. There is no answer to "which tree did you mean" that
 * is safe to guess, so the ops that need one are reached through a facade that
 * cannot be built without it — and a tool implementation may not import them any
 * other way, which ESLint enforces (tooling/eslint.config.js) the same way it
 * refuses a bare `fetch` to /api/ops/call.
 *
 * The scope is resolved on every call rather than captured once: a tool item
 * outlives both a permission grant being added and — through a rebind — the
 * binding itself.
 * @param {() => OpsScope} resolveScope - Called per op for the caller's current scope.
 * @returns {BoundOps} The scoped operations.
 */
export function createBoundOps(resolveScope) {
  /** @returns {string[]|undefined} The grant, or undefined to send none. */
  const paths = () => resolveScope().allowedPaths;
  /** @returns {string|undefined} The workspace id, or undefined for the project. */
  const where = () => resolveScope().workspaceId || undefined;

  return {
    readFile: (params, signal) => readFile(params, signal, paths(), where()),
    writeFile: (params, signal) => writeFile(params, signal, paths(), where()),
    editFile: (params, signal) => editFile(params, signal, paths(), where()),
    editFileLines: (params, signal) => editFileLines(params, signal, paths(), where()),
    fileHash: (params, signal) => fileHash(params, signal, paths(), where()),
    stat: (params, signal) => stat(params, signal, paths(), where()),
    mkdir: (params, signal) => mkdir(params, signal, paths(), where()),
    getTree: (params, signal) => getTree(params, signal, paths(), where()),
    expandDirectory: (params, signal) => expandDirectory(params, signal, paths(), where()),
    glob: (params, signal) => glob(params, signal, paths(), where()),
    copyTree: (params, signal) => copyTree(params, signal, paths(), where()),
    compareTrees: (params, signal) => compareTrees(params, signal, paths(), where()),
    grep: (params, signal) => grep(params, signal, paths(), where()),
    findSymbol: (params, signal) => findSymbol(params, signal, paths(), where()),
    shell: (params, signal) => shell(params, signal, where()),
    shellBackground: (params) => shellBackground(params, where()),
    shellStreaming: (params, onOutput, signal) => shellStreaming(params, onOutput, signal, where()),
    fileSystem: () => new FileSystem(paths(), where()),
    readOnlyFileSystem: () => new ReadOnlyFileSystem(paths(), where())
  };
}
