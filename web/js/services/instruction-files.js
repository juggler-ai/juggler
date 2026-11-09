//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Agent instruction files — AGENTS.md and the names other agents give it.
 *
 * Three places hold them, and they reach a conversation two ways:
 *
 * - **Global** (`~/.juggler`, `~/.agents`) and **the tree's own root** (plus
 *   the wider places its workspace provider names) are seeded as frozen
 *   context items when the conversation is bound (`conversation-seeder.js`).
 * - **A folder below the root** is loaded the first time the agent reads or
 *   edits a file in it ({@link loadFolderInstructions}). A monorepo pays only for
 *   the packages a conversation actually works in. What was loaded is stored on
 *   that tool call (`instructions`) and sent inside its own tool_result, which
 *   keeps the request append-only and can never separate a tool_use from its
 *   result; the worker renders it (`toolResultInstructions`, llm_request.go).
 *
 * The list of names is here so the two paths cannot disagree about it.
 * @module services/instruction-files
 */

import { createBoundOps } from '../../sdk/ops.js';
import { posixNormalize } from '../../sdk/lib/path-containment.js';
import { isToolActionMessage, itemField } from '../../sdk/lib/message.js';
import { plain } from '../model/item-accessor.js';
import { resolveToolName } from './tool-generator.js';

/**
 * The file names that hold instructions for an agent, in the order they are
 * read within one folder. Each `.local` file — personal, and usually
 * gitignored — follows its shared twin, so what the user says for themselves
 * is read after what the project says.
 * @type {readonly string[]}
 */
export const INSTRUCTION_FILE_NAMES = Object.freeze([
  'AGENTS.md',
  'AGENTS.local.md',
  'CLAUDE.md',
  'CLAUDE.local.md',
  '.claude.md',
  '.cursorrules',
  '.instructions'
]);

/**
 * Longest instruction file sent whole. The same bound a frozen file-content
 * snapshot keeps (`MAX_FROZEN_SNAPSHOT_CHARS`), for the same reason: it rides
 * the conversation for the rest of its life.
 * @type {number}
 */
const MAX_INSTRUCTION_CHARS = 256_000;

/**
 * The tools whose target path makes its folder's instructions apply, keyed by
 * the name the model calls them.
 * @type {Readonly<Record<string, (input: Record<string, unknown>) => unknown[]>>}
 */
const PATHS_OF_TOOL = Object.freeze({
  read: (input) => [input.path ?? input.file_path],
  edit: (input) => [input.path],
  write: (input) => [input.path],
  batch_read: (input) => (Array.isArray(input.files) ? input.files : [])
    .map((/** @type {any} */ f) => f?.file_path ?? f?.path)
});

/**
 * One instruction file loaded for a folder, as stored on the tool call.
 * @typedef {object} LoadedInstructions
 * @property {string} path - Workspace-relative, forward-slashed
 * @property {string} content - The file's text, bounded by {@link MAX_INSTRUCTION_CHARS}
 * @property {string} [contentHash] - SHA-256 of its bytes, so a later call knows a twin by another name
 */

/**
 * `dir` and `name` joined in the separator `dir` arrived in: a Windows root
 * joined with '/' is a path the user never sees written that way anywhere else.
 * @param {string} dir - A directory
 * @param {string} name - A file name
 * @returns {string} The joined path
 */
export function joinInstructionPath(dir, name) {
  return `${dir}${dir.includes('\\') && !dir.includes('/') ? '\\' : '/'}${name}`;
}

/**
 * A path forward-slashed and normalised, for comparing.
 * @param {string} p - Any path
 * @returns {string} The comparable form
 */
function comparable(p) {
  return posixNormalize(String(p).replace(/\\/g, '/'));
}

/**
 * Where a path sits under a root, as forward-slashed segments.
 * @param {string} root - The workspace root, absolute
 * @param {string} target - A path, absolute or relative to the root
 * @returns {string[]|null} The segments below the root, or null when outside it
 */
function segmentsUnder(root, target) {
  const base = comparable(root).replace(/\/+$/, '');
  const raw = String(target).replace(/\\/g, '/');
  const isAbsolute = raw.startsWith('/') || /^[A-Za-z]:\//.test(raw);
  const full = comparable(isAbsolute ? raw : `${base}/${raw}`);
  if (full === base) return [];
  if (!full.startsWith(`${base}/`)) return null;
  return full.slice(base.length + 1).split('/');
}

/**
 * The folders of a tree whose instructions apply to the files at `paths`,
 * outermost first and without repeats. The root itself is never among them: its
 * files are seeded with the conversation.
 * @param {string} root - The workspace root, absolute
 * @param {string[]} paths - The files touched
 * @returns {string[]} Workspace-relative folders, forward-slashed
 */
function foldersBelowRoot(root, paths) {
  /** @type {string[]} */
  const folders = [];
  for (const path of paths) {
    const segments = segmentsUnder(root, path);
    if (!segments) continue;
    for (let depth = 1; depth < segments.length; depth++) {
      const folder = segments.slice(0, depth).join('/');
      if (!folders.includes(folder)) folders.push(folder);
    }
  }
  return folders.sort((a, b) => a.split('/').length - b.split('/').length);
}

/**
 * Every instruction file this thread already holds, as comparable paths: the
 * file-content items on it (seeded, mentioned or pinned) and what earlier tool
 * calls loaded. Read from the thread rather than remembered, so it survives an
 * engine reload and agrees with what the model was sent — and a call that
 * compaction has folded away takes its instructions with it, so they can be
 * loaded again where the model can still see them.
 * @param {any} messageThread - The thread
 * @param {string} root - The workspace root, for relative paths
 * @param {string} toolUseId - The call being completed (excluded)
 * @returns {{paths: Set<string>, hashes: Set<string>}} Comparable absolute paths, and the content hashes earlier calls loaded
 */
function heldInstructionPaths(messageThread, root, toolUseId) {
  const base = comparable(root).replace(/\/+$/, '');
  /**
   * @param {unknown} p - A stored path, absolute or root-relative
   * @returns {string} Its comparable absolute form, or '' for none
   */
  const key = (p) => {
    const raw = String(p ?? '').replace(/\\/g, '/');
    if (!raw) return '';
    return comparable(raw.startsWith('/') || /^[A-Za-z]:\//.test(raw) ? raw : `${base}/${raw}`);
  };
  /** @type {Set<string>} */
  const held = new Set();
  /** @type {Set<string>} */
  const hashes = new Set();
  for (const item of messageThread?.contextItems || []) {
    if (item?.type !== 'file-content') continue;
    const path = key(itemField(item.data, 'path'));
    if (path) held.add(path);
  }
  for (const item of messageThread?.items || []) {
    if (!isToolActionMessage(item) || item.get('toolUseId') === toolUseId) continue;
    const loaded = plain(item.get('instructions'));
    if (!Array.isArray(loaded)) continue;
    for (const entry of loaded) {
      const path = key(entry?.path);
      if (path) held.add(path);
      if (typeof entry?.contentHash === 'string' && entry.contentHash) hashes.add(entry.contentHash);
    }
  }
  return { paths: held, hashes };
}

/**
 * The reader of a tool's target paths, whichever of its names the model used.
 * @param {string} toolName - The tool as the model called it
 * @returns {((input: Record<string, unknown>) => unknown[])|null} The reader, or null for a tool that touches no file
 */
function pathsOfTool(toolName) {
  for (const name of [toolName, resolveToolName(toolName)]) {
    const reader = Object.hasOwn(PATHS_OF_TOOL, name) ? PATHS_OF_TOOL[name] : undefined;
    if (reader) return reader;
  }
  return null;
}

/**
 * The instruction files of the folders a tool call just touched, that this
 * thread has not been given yet.
 *
 * Outermost folder first and, within a folder, in {@link INSTRUCTION_FILE_NAMES}
 * order, so the nearest file is the last word. The file the call itself read
 * or wrote is never loaded a second time beside it, and two names for the same
 * bytes (a CLAUDE.md symlinked to AGENTS.md) load once.
 *
 * Best-effort throughout: a file that cannot be read is skipped, and a failure
 * of any kind answers with nothing — losing a folder's instructions must never
 * cost the call it rode on.
 * @param {object} call - The finished call
 * @param {any} call.conversation - Its conversation (for the tree it works in)
 * @param {any} call.messageThread - Its thread
 * @param {string} call.toolUseId - Its id
 * @param {string} call.toolName - The tool as the model called it
 * @param {Record<string, unknown>} call.toolInput - Its input
 * @param {AbortSignal} [call.signal] - Aborted when the call is cancelled
 * @returns {Promise<LoadedInstructions[]>} What to send with the call's result
 */
export async function loadFolderInstructions({ conversation, messageThread, toolUseId, toolName, toolInput, signal }) {
  try {
    const pathsOf = pathsOfTool(toolName);
    if (!pathsOf) return [];
    const root = conversation?.workspaceRoot;
    if (!root) return [];
    const touched = pathsOf(toolInput || {})
      .filter((p) => typeof p === 'string' && p !== '')
      .map(String);
    const folders = foldersBelowRoot(root, touched);
    if (!folders.length) return [];

    const base = comparable(root).replace(/\/+$/, '');
    const { paths: held, hashes: seenHashes } = heldInstructionPaths(messageThread, root, toolUseId);
    // An instruction file the call itself read or wrote is in its result
    // already. It is still read here, but only so a twin of it under another
    // name is known for one.
    /** @type {Set<string>} */
    const own = new Set();
    for (const path of touched) {
      const segments = segmentsUnder(root, path);
      if (segments) own.add(comparable(`${base}/${segments.join('/')}`));
    }

    const candidates = folders.flatMap(folder => INSTRUCTION_FILE_NAMES.map(name => `${folder}/${name}`))
      .filter(rel => !held.has(comparable(`${base}/${rel}`)));
    if (!candidates.length) return [];

    const workspaceId = conversation.workspaceId;
    const ops = createBoundOps(() => ({ workspaceId }));
    const found = await Promise.all(candidates.map(async (path) => {
      try {
        const result = await ops.readFile({ path }, signal);
        return result && typeof result.content === 'string' && result.content.trim()
          ? { path, content: result.content, contentHash: result.contentHash, own: own.has(comparable(`${base}/${path}`)) }
          : null;
      } catch {
        return null;
      }
    }));
    for (const file of found) {
      if (file?.own && file.contentHash) seenHashes.add(file.contentHash);
    }

    /** @type {LoadedInstructions[]} */
    const loaded = [];
    for (const file of found) {
      if (!file || file.own) continue;
      if (file.contentHash) {
        if (seenHashes.has(file.contentHash)) continue;
        seenHashes.add(file.contentHash);
      }
      const content = file.content.length > MAX_INSTRUCTION_CHARS
        ? `${file.content.slice(0, MAX_INSTRUCTION_CHARS)}\n…`
        : file.content;
      loaded.push(file.contentHash ? { path: file.path, content, contentHash: file.contentHash } : { path: file.path, content });
    }
    return loaded;
  } catch (err) {
    console.warn('[instruction-files] Could not load folder instructions:', err);
    return [];
  }
}
