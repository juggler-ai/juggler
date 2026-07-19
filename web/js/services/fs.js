//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Node.js `fs.promises`-compatible filesystem API backed by Go ops.
 * @module fs
 */

import { readFileLoad, writeFileOp, statOp, mkdirOp } from './ops-api.js';
import { treeExpandDirectory } from './ops-api.js';

/**
 * Lightweight Dirent-like object returned by readdir with `withFileTypes`.
 */
class Dirent {
  /**
   * @param {string} name - Entry name
   * @param {boolean} isDir - Whether this entry is a directory
   */
  constructor(name, isDir) {
    this.name = name;
    this._isDir = isDir;
  }

  /** @returns {boolean} True if this entry is a regular file */
  isFile() { return !this._isDir; }
  /** @returns {boolean} True if this entry is a directory */
  isDirectory() { return this._isDir; }
}

/**
 * Stats object returned by stat(), matching Node.js fs.Stats shape.
 */
class Stats {
  /** @param {{size?: number, modified?: number, isFile?: boolean, isDirectory?: boolean}} raw - Raw response from the stat op */
  constructor(raw) {
    /** @type {number} */
    this.size = /** @type {number} */ (raw.size ?? 0);
    /** @type {number} */
    this.mtimeMs = /** @type {number} */ (raw.modified ?? 0);
    /** @type {Date} */
    this.mtime = new Date(/** @type {number} */ (this.mtimeMs));
    /** @type {boolean} */
    this._isFile = /** @type {boolean} */ (raw.isFile ?? false);
    /** @type {boolean} */
    this._isDir = /** @type {boolean} */ (raw.isDirectory ?? false);
  }

  /** @returns {boolean} True if this is a regular file */
  isFile() { return this._isFile; }
  /** @returns {boolean} True if this is a directory */
  isDirectory() { return this._isDir; }
}

/**
 * Filesystem error with a Node.js-style `code` property.
 */
class FileSystemError extends Error {
  /**
   * @param {string} code - Error code (e.g. 'ENOENT')
   * @param {string} message - Error detail
   */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

/**
 * Standard filesystem API backed by Go ops.
 */
export class FileSystem {
  /**
   * @param {string[]} [allowedPaths] - Standing allowed-paths grant (session +
   *   conversation + project root). Forwarded as the dedicated allowed-paths
   *   transport arg to the read/search/tree ops (NOT inside params) so this
   *   filesystem can reach user-approved locations outside the project root.
   *   Defaults to project-root-only when omitted.
   * @param {string} [conversationId] - Owning conversation, tagged onto each
   *   op so it runs in that conversation's dedicated git worktree. '' ⇒ base.
   */
  constructor(allowedPaths = [], conversationId = '') {
    /** @type {string[]} */
    this._allowedPaths = Array.isArray(allowedPaths) ? allowedPaths : [];
    /**
     * Owning conversation, tagged onto each op's params so the backend routes
     * it into that conversation's dedicated git worktree (per-conversation
     * isolation). '' ⇒ the base project root.
     * @type {string}
     */
    this._conversationId = conversationId || '';
  }

  /**
   * Tag op params with this filesystem's conversation id (see callOp), so the
   * op runs in the conversation's worktree. No-op when unbound.
   * @template T
   * @param {T} params - Op params
   * @returns {any} params tagged with conversationId when bound
   * @private
   */
  _conv(params) {
    return this._conversationId ? { ...params, conversationId: this._conversationId } : params;
  }

  /**
   * Read a file's content.
   * @param {string} filePath - Path to file
   * @param {string|{encoding?: string, offset?: number, limit?: number}} [options] - Encoding string or options object
   * @returns {Promise<string>} File content as string
   */
  async readFile(filePath, options) {
    /** @type {Record<string, unknown>} */
    const params = { path: filePath };
    if (typeof options === 'object' && options !== null) {
      if (options.offset !== undefined || options.limit !== undefined) {
        const offset = options.offset || 1;
        const limit = options.limit || 2000;
        params.lineRange = { start: offset, end: offset + limit - 1 };
      }
    }
    const result = await readFileLoad(this._conv(params), undefined, this._allowedPaths);
    if (!result.exists) {
      throw new FileSystemError('ENOENT', `no such file or directory: ${filePath}`);
    }
    return result.content;
  }

  /**
   * Write content to a file (creates or overwrites).
   * @param {string} filePath - Path to file
   * @param {string} content - Content to write
   * @returns {Promise<void>}
   */
  async writeFile(filePath, content) {
    await writeFileOp(this._conv({ path: filePath, content: String(content) }));
  }

  /**
   * Read directory entries.
   * @param {string} dirPath - Path to directory
   * @param {{withFileTypes?: boolean}} [options] - Options
   * @returns {Promise<string[]|Dirent[]>} Directory entry names or Dirent objects
   */
  async readdir(dirPath, options) {
    const result = await treeExpandDirectory(this._conv({ path: dirPath }), this._allowedPaths);
    const items = result.items || [];
    if (options?.withFileTypes) {
      return items.map(i => new Dirent(i.name, i.isDir));
    }
    return items.map(i => i.name);
  }

  /**
   * Get file/directory metadata.
   * @param {string} filePath - Path to file or directory
   * @returns {Promise<Stats>} Stats object with size, mtime, isFile/isDirectory
   */
  async stat(filePath) {
    const result = await statOp(this._conv({ path: filePath }), this._allowedPaths);
    if (!result.exists) {
      throw new FileSystemError('ENOENT', `no such file or directory: ${filePath}`);
    }
    return new Stats(result);
  }

  /**
   * Check that a path is accessible (throws if it doesn't exist).
   * @param {string} filePath - Path to check
   * @returns {Promise<void>}
   */
  async access(filePath) {
    const result = await statOp(this._conv({ path: filePath }), this._allowedPaths);
    if (!result.exists) {
      throw new FileSystemError('ENOENT', `no such file or directory: ${filePath}`);
    }
  }

  /**
   * Create a directory.
   * @param {string} dirPath - Path to create
   * @param {{recursive?: boolean}} [options] - Options
   * @returns {Promise<void>}
   */
  async mkdir(dirPath, options) {
    await mkdirOp(this._conv({ path: dirPath, recursive: options?.recursive ?? false }), this._allowedPaths);
  }
}

/**
 * Read-only filesystem for sandboxed code execution (e.g. explore_code).
 * Throws on any write operation.
 */
export class ReadOnlyFileSystem extends FileSystem {
  /** @returns {Promise<never>} Always throws */
  async writeFile() {
    throw new FileSystemError('EROFS', 'read-only filesystem');
  }

  /** @returns {Promise<never>} Always throws */
  async mkdir() {
    throw new FileSystemError('EROFS', 'read-only filesystem');
  }
}

export { Dirent, Stats, FileSystemError };
