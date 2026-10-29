//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Paths, for a workspace provider that has two path worlds to keep apart.
 *
 * A provider registers roots in the server's own native form and names things to
 * operations relative to a root. On Windows those disagree about what an
 * absolute path even looks like (`C:\src\app` against `/c/src/app` or
 * `/mnt/c/src/app`), and which is right depends on which POSIX toolchain the
 * machine happens to have. So absolute paths are built and compared here, in the
 * separator they arrived in, and what is handed to an operation is relative.
 *
 * Shared by the providers rather than copied into each: two implementations of
 * `relativePath` are two chances to disagree about the one thing neither of them
 * can afford to be wrong about.
 * @module lib/workspace-paths
 */

/**
 * Split a path into its parts, in either platform's separator.
 * @param {string} path - A path.
 * @returns {string[]} Its non-empty segments.
 */
function segments(path) {
  return path.split(/[/\\]+/).filter(Boolean);
}

/**
 * Whether two path segments name the same thing.
 *
 * Case-insensitively when the path is a Windows one, because `C:\Src` and
 * `c:\src` are one directory there and a relative path computed as though they
 * were two would climb out of the tree it was measured in.
 * @param {string} a - One segment.
 * @param {string} b - Another.
 * @param {boolean} windows - Whether these came from a Windows path.
 * @returns {boolean} Whether they match.
 */
function sameSegment(a, b, windows) {
  return windows ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Whether a path is in Windows form — a drive letter, or a backslash.
 * @param {string} path - A path.
 * @returns {boolean} Whether to treat it as Windows'.
 */
function isWindowsPath(path) {
  return /^[A-Za-z]:/.test(path) || path.includes('\\');
}

/**
 * The separator a path is written in, so anything built from it matches.
 * @param {string} path - A path.
 * @returns {string} '\\' or '/'.
 */
function separatorOf(path) {
  return isWindowsPath(path) && !path.includes('/') ? '\\' : '/';
}

/**
 * The directory holding something.
 * @param {string} path - An absolute path.
 * @returns {string} Its parent, without a trailing separator.
 */
export function parentOf(path) {
  return path.replace(/[/\\]+[^/\\]+[/\\]*$/, '');
}

/**
 * The last segment of a path — a repository's name, a tree's name.
 * @param {string} path - An absolute path.
 * @returns {string} Its final segment, or '' for a root.
 */
export function baseName(path) {
  const parts = segments(path);
  return parts[parts.length - 1] ?? '';
}

/**
 * Join a path onto a root in the root's own separator.
 * @param {string} root - An absolute path.
 * @param {string} relative - Something below it; '' answers the root itself.
 * @returns {string} The absolute result.
 */
export function join(root, relative) {
  if (!relative) return root;
  const separator = separatorOf(root);
  // `..` is resolved rather than carried: a worktree beside its repository is
  // named `../repo-branch` from inside it, and a root registered as
  // `/src/repo/../repo-branch` would work everywhere and read like a mistake
  // in every place it is shown.
  const trimmed = root.replace(/[/\\]+$/, '');
  // Whatever the root led with, verbatim: one separator for an absolute POSIX
  // path, two for a UNC share, none for a drive letter.
  const lead = trimmed.match(/^[/\\]*/)?.[0] ?? '';
  const parts = segments(trimmed);
  for (const part of segments(relative)) {
    if (part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `${lead}${parts.join(separator)}`;
}

/**
 * The path of `to` as seen from `from`, in POSIX form for a shell to read.
 *
 * Returns null when there is no such path — different drives on Windows — and
 * the caller must then fall back to the absolute one and accept that a shell
 * which disagrees about absolute paths will not find it.
 * @param {string} from - The directory being stood in.
 * @param {string} to - The destination.
 * @returns {string|null} A relative path, or null if there is none.
 */
export function relativePath(from, to) {
  const windows = isWindowsPath(from) || isWindowsPath(to);
  const fromParts = segments(from);
  const toParts = segments(to);
  const fromDrive = fromParts[0];
  const toDrive = toParts[0];
  if (windows && fromDrive && toDrive && !sameSegment(fromDrive, toDrive, true)) {
    return null;
  }
  let shared = 0;
  while (shared < fromParts.length && shared < toParts.length) {
    const here = fromParts[shared];
    const there = toParts[shared];
    if (!here || !there || !sameSegment(here, there, windows)) break;
    shared++;
  }
  const up = new Array(fromParts.length - shared).fill('..');
  const down = toParts.slice(shared);
  const parts = [...up, ...down];
  return parts.length ? parts.join('/') : '.';
}
