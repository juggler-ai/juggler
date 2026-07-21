//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * `juggler/ops` — the privileged host-operations layer.
 *
 * This is the keystone of third-party parity: file, shell, web, grep and tree
 * operations that previously only built-in plugins could reach. These ops run
 * with the user's full authority — there is no per-extension sandbox. The
 * manifest `permissions` list is a *declaration* of the host access an
 * extension's code uses, surfaced to the user in the catalog and the
 * install/trust prompt; it is disclosure, not a gate. The real gate is the
 * user-approval layer (tool approval dialogs, allowed-paths), which applies to
 * every op regardless of what an extension declared in its manifest.
 *
 * The public names below are a clean, guessable vocabulary (`readFile`, `glob`,
 * `grep`, `shell`, …) — deliberately decoupled from the internal `ops-api`
 * implementation names, which carry a subsystem prefix (`readFileLoad`,
 * `treeGlob`, `grepSearch`, …). Import what you need by name; there is no bare
 * `fetch`/`search` (those would shadow web globals — use `webFetch`/`webSearch`).
 */
export {
  OpsError,
  MAX_EXEC_TIMEOUT_MS,
  DEFAULT_EXEC_TIMEOUT_MS,
  // Filesystem
  readFileLoad as readFile,
  writeFileOp as writeFile,
  readFileEdit as editFile,
  readFileEditLines as editFileLines,
  readFileGetHash as fileHash,
  statOp as stat,
  mkdirOp as mkdir,
  // Directory tree
  treeGetTree as getTree,
  treeExpandDirectory as expandDirectory,
  treeGlob as glob,
  // Search
  grepSearch as grep,
  grepFindSymbol as findSymbol,
  // Shell
  shellExecute as shell,
  shellExecuteStreaming as shellStreaming,
  shellCancelStreaming as cancelShellStreaming,
  shellStartBackground as shellBackground,
  shellGetOutput as shellOutput,
  shellGetOutputDelta as shellOutputDelta,
  shellKill,
  // Web
  webFetch,
  webSearch,
  // Workspace binding — redirect a conversation's execution root (worktrees etc.)
  bindWorkspace,
  unbindWorkspace,
  // OS integration
  osOpenPath as openPath,
  osRevealPath as revealPath,
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
export { FileSystem, ReadOnlyFileSystem } from '../js/services/fs.js';
