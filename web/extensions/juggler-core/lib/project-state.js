//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Where a project's local state is — memory, env.local.json, scratch-copy
 * sandboxes — for the code that names one of those files.
 *
 * The server keeps it in `<project>/.juggler` unless the user has asked for it
 * to be kept outside the project, and says which in `stateDir` on the session
 * (`RuntimeInfo.StateDir`, `GET /api/session`). Every file here is then named one
 * of two ways:
 *
 *  - in the project, by the same relative `.juggler/<name>` it has always had,
 *    so nothing a project with its state at home sees or sends changes by a byte;
 *  - outside it, by its absolute path, the only spelling a file outside the
 *    project has. The server's scope admits that folder for the project's own
 *    operations (`ops/validation.go`), and its watcher reports changes there by
 *    the absolute path too (`core/filewatcher.go`).
 *
 * A session with no `stateDir` — an older server, a test session — is in the
 * project.
 * @module lib/project-state
 */

import { join } from './workspace-paths.js';

/** The project's own folder, relative to its root. */
export const STATE_REL = '.juggler';

/**
 * A path in one spelling, for comparing: forward slashes, no trailing one.
 * @param {string} path - A path in either separator.
 * @returns {string} The same path, normalised.
 */
function normalise(path) {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * The state folder when it is outside the project, or '' when it is in it.
 * @param {string|undefined} projectPath - The project root, as the session reports it.
 * @param {string|undefined} stateDir - The state folder, as the session reports it.
 * @returns {string} The absolute outside folder, or ''.
 */
function outsideStateDir(projectPath, stateDir) {
  if (!stateDir) return '';
  if (projectPath && normalise(stateDir) === `${normalise(projectPath)}/${STATE_REL}`) return '';
  return stateDir;
}

/**
 * The state folder of a session when it is outside the project, or ''.
 * @param {{projectPath?: string, stateDir?: string}|null|undefined} session - The session.
 * @returns {string} The absolute outside folder, or ''.
 */
export function sessionOutsideStateDir(session) {
  return outsideStateDir(session?.projectPath, session?.stateDir);
}

/**
 * How to name a file of the project's local state: `.juggler/<name>` when the
 * state is in the project, its absolute path when it is not.
 * @param {string|undefined} projectPath - The project root.
 * @param {string|undefined} stateDir - The state folder.
 * @param {string} name - The file, relative to the state folder (`MEMORY.md`).
 * @returns {string} The path to hand to an operation or show the model.
 */
export function statePath(projectPath, stateDir, name) {
  const outside = outsideStateDir(projectPath, stateDir);
  return outside ? join(outside, name) : `${STATE_REL}/${name}`;
}

/**
 * {@link statePath} for a session.
 * @param {{projectPath?: string, stateDir?: string}|null|undefined} session - The session.
 * @param {string} name - The file, relative to the state folder.
 * @returns {string} The path to hand to an operation or show the model.
 */
export function sessionStatePath(session, name) {
  return statePath(session?.projectPath, session?.stateDir, name);
}

/**
 * Whether two absolute paths name the same file, whatever separator each was
 * written in.
 * @param {string} a - One path.
 * @param {string} b - Another.
 * @returns {boolean} Whether they match.
 */
export function samePath(a, b) {
  return normalise(a) === normalise(b);
}
