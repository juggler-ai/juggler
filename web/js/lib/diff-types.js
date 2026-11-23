//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * One line of a hunk, as a host hands it over.
 * @typedef {object} FileDiffLine
 * @property {string} kind - "context", "add" or "remove".
 * @property {number} [oldLine] - Line number on the old side; absent for an added line.
 * @property {number} [newLine] - Line number on the new side; absent for a removed line.
 * @property {string} text - The line, with no leading +/-/space.
 */

/**
 * One hunk, as a host hands it over.
 * @typedef {object} FileDiffHunk
 * @property {number} oldStart - First line this hunk covers on the old side.
 * @property {number} oldLines - Lines it covers there.
 * @property {number} newStart - First line it covers on the new side.
 * @property {number} newLines - Lines it covers there.
 * @property {string} [heading] - The section the hunk header names, often absent.
 * @property {FileDiffLine[]} lines - The hunk's lines, in file order.
 */

/**
 * One file's change, as whatever produced it — the git client, for one — hands
 * it to the diff viewer and the review panel. Neither asks for it: a host gives
 * the panel a loader that resolves with one.
 * @typedef {object} FileDiff
 * @property {string} repo - The group of files it belongs to — for git, the
 *   repository by its path in the tree — '' for the first or only one.
 * @property {string} path - The file, relative to that group.
 * @property {string} [oldPath] - Former path, for a rename or copy.
 * @property {string} status - modified, added, deleted, renamed, copied, typechange,
 *   conflicted, untracked or unchanged.
 * @property {boolean} binary - Whether it is binary; no patch text is invented for one.
 * @property {boolean} [conflicted] - Whether it is mid-conflict.
 * @property {boolean} truncated - Whether the patch was cut short; the counts still describe all of it.
 * @property {number} added - Added lines.
 * @property {number} removed - Removed lines.
 * @property {string} revision - Fingerprint of every byte it describes,
 *   including any past a ceiling that were never handed over.
 * @property {number} context - Unchanged lines carried around each change; more
 *   than this takes another read.
 * @property {string} [oldMode] - The file's mode on the old side, when it differs.
 * @property {string} [newMode] - The file's mode on the new side, when it differs.
 * @property {FileDiffHunk[]} hunks - The patch, hunk by hunk.
 */

/**
 * Shared diff JSDoc typedefs used by both UI and tests.
 * Import this module (side-effect) to make the typedefs available to checkJs.
 */

/**
 * @typedef {{
 *   type: 'add'|'remove'|'equal',
 *   content: string,
 *   oldLineNum: number|null,
 *   newLineNum: number|null,
 *   markup?: string
 * }} DiffLine
 */

/**
 * @typedef {{
 *   oldStart: number,
 *   oldCount: number,
 *   newStart: number,
 *   newCount: number,
 *   heading?: string,
 *   lines: DiffLine[]
 * }} DiffHunk
 */

/**
 * A file's patch as the renderer holds it: the fields of a {@link FileDiff}
 * that change what is drawn, with its hunks already in the shape
 * both inputs share. What git could not express as lines — a binary file, an
 * unresolved conflict, a patch cut short at a ceiling — travels beside them,
 * because the absence of hunks alone would read as "no changes".
 * @typedef {{
 *   repo: string,
 *   path: string,
 *   oldPath?: string,
 *   status: string,
 *   binary: boolean,
 *   conflicted: boolean,
 *   truncated: boolean,
 *   added: number,
 *   removed: number,
 *   revision: string,
 *   context: number,
 *   hunks: DiffHunk[]
 * }} DiffPatch
 */

/**
 * One comment drawn against a diff. `side` and `endLine` say where it hangs;
 * `revision` is the fingerprint of the patch it was written against, and
 * `lineText` the code it quoted then — which is all that is left to show once
 * the file has moved on from it.
 * @typedef {{
 *   id: string,
 *   side: 'old'|'new'|'file',
 *   startLine?: number,
 *   endLine?: number,
 *   lineText?: string[],
 *   body: string,
 *   revision?: string,
 *   stale?: boolean
 * }} DiffAnnotation
 */

// no runtime exports; file is imported for typedefs only
export {};
