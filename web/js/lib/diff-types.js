//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

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
 * A file's patch as the renderer holds it: the fields of the server's
 * `GitFileDiff` that change what is drawn, with its hunks already in the shape
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
