//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for the shell auto-approval analyser. The tokenizer
 * (`shell-tokenizer.js`), the per-command handlers (`command-handlers.js`) and
 * the segment analysis (`command-approval.js`) all speak these shapes, so they
 * live in one module none of the three has to import at runtime.
 * @module juggler-core/context-items/execute/approval-types
 */

/**
 * @typedef {{type: 'word', text: string, raw: string, start: number, end: number, subst?: string[], unquotedVar?: boolean}} WordToken
 * @typedef {{type: 'op', text: string, start: number, end: number}} OpToken
 * @typedef {WordToken | OpToken} ShellToken
 * @typedef {{platform: string, allowedRoots: string[], home?: string, patterns?: string[], writeEnabled?: boolean, cwd?: string, vars?: Map<string, VarProvenance>}} ApprovalCtx
 * @typedef {{kind: 'literal', value: string} | {kind: 'inProjectPath'}} VarProvenance
 * @typedef {{allowedRoots?: string[], writeEnabled?: boolean, home?: string, platform?: string, cwd?: string}} RedirectCfg
 */

// no runtime exports; file is imported for typedefs only
export {};
