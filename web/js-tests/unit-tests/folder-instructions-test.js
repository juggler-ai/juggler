//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A folder's instruction files, loaded the first time the agent works in it
 * (`loadFolderInstructions`, services/instruction-files.js).
 *
 * Everything here is silent when it goes wrong: a folder whose AGENTS.md never
 * loads looks like an agent ignoring its instructions, one that loads on every
 * read costs its size on every call, and the wrong order makes the wider
 * file overrule the nearer one. Real files on disk, read through the real ops;
 * the thread is a stand-in holding exactly what the loader reads from it.
 * @module unit-tests/folder-instructions-test
 */

import { assert } from '../utilities/test-helpers.js';
import { fetchJson } from '../../js/services/http.js';
import { apiUrl } from '../../js/utils/api-url.js';
import { writeFile } from '../../js/services/ops-api.js';
import { loadFolderInstructions } from '../../js/services/instruction-files.js';

/**
 * A thread item as the loader reads it: anything with a `get`.
 * @param {Record<string, unknown>} fields - The item's fields
 * @returns {{get: (key: string) => unknown}} The item
 */
function item(fields) {
  return { get: (key) => fields[key] };
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated results
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /**
   * @param {string} label
   * @param {() => Promise<void>} fn
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const projectPath = String((await fetchJson(apiUrl('/session'))).projectPath);
  // A tree of its own, so nothing another lane writes is found, and nothing
  // here is at the fixture root where every conversation would seed it.
  const top = `folder-instructions-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile({ path: `${top}/AGENTS.md`, content: '# top' });
  await writeFile({ path: `${top}/pkg/AGENTS.md`, content: '# pkg' });
  await writeFile({ path: `${top}/pkg/AGENTS.local.md`, content: '# pkg, mine' });
  await writeFile({ path: `${top}/pkg/CLAUDE.md`, content: '# pkg' });
  await writeFile({ path: `${top}/pkg/src/index.js`, content: 'x' });
  await writeFile({ path: `${top}/other/CLAUDE.local.md`, content: '# other' });
  await writeFile({ path: `${top}/other/a.js`, content: 'y' });

  const conversation = { workspaceRoot: projectPath, workspaceId: '' };
  /**
   * @param {string} toolName
   * @param {Record<string, unknown>} toolInput
   * @param {{contextItems?: any[], items?: any[]}} [thread]
   * @returns {Promise<string[]>} The paths loaded, in order
   */
  const load = async (toolName, toolInput, thread = {}) => (await loadFolderInstructions({
    conversation,
    messageThread: { contextItems: thread.contextItems ?? [], items: thread.items ?? [] },
    toolUseId: 'now',
    toolName,
    toolInput
  })).map(f => f.path);

  await run('outermost folder first, .local after its twin, one name per set of bytes', async () => {
    const got = await load('read', { path: `${top}/pkg/src/index.js` });
    // pkg/CLAUDE.md holds the same bytes as pkg/AGENTS.md: a twin, not news.
    const want = [`${top}/AGENTS.md`, `${top}/pkg/AGENTS.md`, `${top}/pkg/AGENTS.local.md`];
    assert(JSON.stringify(got) === JSON.stringify(want), `loaded ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  });

  await run('an absolute path, and the alias the read tool accepts, reach the same folders', async () => {
    const got = await load('read', { file_path: `${projectPath}/${top}/other/a.js` });
    const want = [`${top}/AGENTS.md`, `${top}/other/CLAUDE.local.md`];
    assert(JSON.stringify(got) === JSON.stringify(want), `loaded ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  });

  await run('a batch read loads every folder it touched, each once', async () => {
    const got = await load('batch_read', { files: [{ file_path: `${top}/pkg/src/index.js` }, { file_path: `${top}/other/a.js` }] });
    const want = [`${top}/AGENTS.md`, `${top}/other/CLAUDE.local.md`, `${top}/pkg/AGENTS.md`, `${top}/pkg/AGENTS.local.md`];
    assert(JSON.stringify([...got].sort()) === JSON.stringify([...want].sort()) && got[0] === `${top}/AGENTS.md`,
      `loaded ${JSON.stringify(got)}, want ${JSON.stringify(want)} with the outermost first`);
  });

  await run('what an earlier call loaded is not loaded again, nor its twin; a re-run of the same call is', async () => {
    // What a real earlier call stored: top and pkg's AGENTS.md, but not the
    // .local one. pkg/CLAUDE.md is pkg/AGENTS.md by another name.
    const stored = (await loadFolderInstructions({
      conversation, messageThread: { contextItems: [], items: [] }, toolUseId: 'earlier', toolName: 'read',
      toolInput: { path: `${top}/pkg/src/index.js` }
    })).filter(f => !f.path.endsWith('.local.md'));
    const earlier = item({ type: 'tool-action', toolUseId: 'earlier', instructions: stored });
    const got = await load('edit', { path: `${top}/pkg/src/index.js` }, { items: [earlier] });
    assert(JSON.stringify(got) === JSON.stringify([`${top}/pkg/AGENTS.local.md`]),
      `with two of them already held, loaded ${JSON.stringify(got)}`);

    const sameCall = item({ type: 'tool-action', toolUseId: 'now', instructions: [{ path: `${top}/AGENTS.md`, content: '# top' }] });
    const again = await load('edit', { path: `${top}/pkg/src/index.js` }, { items: [sameCall] });
    assert(again.includes(`${top}/AGENTS.md`), `a re-run must load afresh, got ${JSON.stringify(again)}`);
  });

  await run('a file the thread already holds, or the call itself read, is not loaded beside it', async () => {
    const pinned = { type: 'file-content', data: { path: `${top}/AGENTS.md` } };
    const got = await load('read', { path: `${top}/pkg/AGENTS.md` }, { contextItems: [pinned] });
    assert(JSON.stringify(got) === JSON.stringify([`${top}/pkg/AGENTS.local.md`]),
      `with the top one pinned and pkg/AGENTS.md the file read, loaded ${JSON.stringify(got)}`);
  });

  await run('a file at the root, outside it, or a tool that touches no file loads nothing', async () => {
    assert((await load('read', { path: 'README.md' })).length === 0, 'the root\'s own files are seeded, not loaded');
    assert((await load('read', { path: '/etc/hosts' })).length === 0, 'a file outside the tree');
    assert((await load('bash', { command: `cat ${top}/pkg/src/index.js` })).length === 0, 'bash names no file to load for');
  });

  return { passed, failed, errors };
}
