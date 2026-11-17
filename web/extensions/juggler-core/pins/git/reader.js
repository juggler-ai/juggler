//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * One kind of read, at most one out at a time, asked for in one of two ways:
 *
 * - **`request()` coalesces.** One asked while a read is out reads once more
 *   when it ends, however many were asked meanwhile. For reads a burst of
 *   `git-change` events asks for (refs, worktrees): every answer is current
 *   when it lands, and aborting each one for the next could starve them all.
 * - **`replace()` is latest-wins.** It aborts the read that is out — its
 *   answer, or failure, is then dropped — and starts a new one at once. For
 *   reads a user action supersedes (the selected commit), and for a tree or
 *   repository switch, after which what is out is about another one.
 *
 * The read is given a signal, aborted when it is replaced or cancelled; passed
 * on to the pin's git service, that closes the request, which ends the git
 * process the server is running for it and frees the browser's connection.
 * @module pins/git/reader
 */

/**
 * @typedef {object} Reader
 * @property {() => void} request - Read, or once more after the read that is out.
 * @property {() => void} replace - Abort what is out, and read now.
 * @property {() => void} cancel - Abort what is out, and read nothing more.
 * @property {() => boolean} busy - Whether a read is out or due.
 */

/**
 * @param {(signal: AbortSignal) => Promise<any>} fetch - The read.
 * @param {(value: any) => void} adopt - Its answer.
 * @param {(e: any) => void} fail - Its failure; never an abort's.
 * @returns {Reader} The reader.
 */
export function createReader(fetch, adopt, fail) {
  /** @type {AbortController|null} The read that is out. */
  let current = null;
  let again = false;
  const start = async () => {
    const mine = new AbortController();
    current = mine;
    try {
      const value = await fetch(mine.signal);
      if (current === mine && !mine.signal.aborted) adopt(value);
    } catch (e) {
      if (current === mine && !mine.signal.aborted) fail(e);
    } finally {
      if (current === mine) {
        current = null;
        if (again) {
          again = false;
          void start();
        }
      }
    }
  };
  const cancel = () => {
    again = false;
    const out = current;
    current = null;
    out?.abort();
  };
  return {
    request: () => {
      if (current) {
        again = true;
        return;
      }
      void start();
    },
    replace: () => {
      cancel();
      void start();
    },
    cancel,
    busy: () => current !== null || again,
  };
}
