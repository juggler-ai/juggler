//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Environment pin tests — the board's view of the variables shell commands get.
 *
 * Every projectEnv op is answered here, by a small model of the server, and
 * never by the real one. The real files would be the shared test server's: an
 * env.local.json written by one lane adds variables to every command every other
 * lane runs, and an approval written here would outlive the run. What the files
 * mean — merge order, approval, validation, where they are written — is asserted
 * against the real code in `projectenv_test.go` and `project_env_ops_test.go`;
 * this is what the card shows and what it asks the server to do.
 * @module _tests/env-pin-test
 */

import EnvPin from '../pins/env-pin.js';
import { assert, waitFor } from '../../../js-tests/utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';

/** juggler-core's English for this pin, standing in for its catalogue. */
const CORE_TEXT = [
  'No project', 'Environment', 'Refresh', 'Approve', 'Show', 'Hide', 'Add', 'NAME', 'value', 'Value',
  'Variable name', 'Remove {name}', 'Overridden by a later file', 'Waiting for approval',
  'Yours, in every project', 'This project, committed', 'Yours, in this project only',
  "Couldn't save it. {error}", "Couldn't read the environment files. {error}", '{file} is not used: {error}',
  "This project's {file} sets these variables. They are not used until you approve them, and a change to the file asks again.",
  'Variables set here are added to every command the assistant runs in this project. Keep secrets in the last file: it stays out of git.',
];

const ROOT = '/proj';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * A model of the projectEnv ops: three maps, an approved snapshot of the
 * project file, and the requests the pin made.
 * @param {{user?: object, project?: object, local?: object, approved?: boolean, errors?: Record<string, string>}} seed - Starting files.
 * @returns {any} The model.
 */
function fakeServer(seed) {
  const files = { user: { ...(seed.user || {}) }, project: { ...(seed.project || {}) }, local: { ...(seed.local || {}) } };
  const errors = seed.errors || {};
  let approvedJSON = seed.approved ? JSON.stringify(files.project) : JSON.stringify({});
  /** @type {{operation: string, params: any}[]} */
  const calls = [];
  /** @type {string|null} Fail the next set with this message. */
  let failSet = null;

  const state = () => {
    const projectApproved = !Object.keys(files.project).length || JSON.stringify(files.project) === approvedJSON;
    /** @type {Record<string, string>} */
    const env = {};
    /** @type {Record<string, string>} */
    const sources = {};
    const list = /** @type {const} */ (['user', 'project', 'local']).map((scope) => {
      const approved = scope !== 'project' || projectApproved;
      if (approved && !errors[scope]) {
        for (const [k, v] of Object.entries(files[scope])) { env[k] = v; sources[k] = scope; }
      }
      const path = scope === 'user' ? '/home/me/.juggler/env.json' : `${ROOT}/.juggler/${scope === 'local' ? 'env.local.json' : 'env.json'}`;
      return { scope, path, exists: true, env: { ...files[scope] }, approved, ...(errors[scope] ? { error: errors[scope] } : {}) };
    });
    return { env, sources, files: list, pending: !projectApproved && !errors.project };
  };

  const realFetch = window.fetch;
  window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
    if (!String(url).includes('/ops/call')) return realFetch(url, init);
    const { toolId, operation, params } = JSON.parse(init.body);
    if (toolId !== 'projectEnv') return realFetch(url, init);
    calls.push({ operation, params });
    let reply;
    if (operation === 'get') reply = { success: true, data: state() };
    else if (operation === 'approve') { approvedJSON = JSON.stringify(files.project); reply = { success: true, data: state() }; }
    else if (operation === 'set') {
      if (failSet) { reply = { success: false, error: failSet }; failSet = null; }
      else {
        files[/** @type {'user'|'project'|'local'} */ (params.scope)] = { ...params.env };
        if (params.scope === 'project') approvedJSON = JSON.stringify(files.project);
        reply = { success: true, data: state() };
      }
    } else reply = { success: false, error: `unknown operation ${operation}` };
    return new window.Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  return {
    files,
    calls,
    writes: () => calls.filter((c) => c.operation !== 'get'),
    reads: () => calls.filter((c) => c.operation === 'get').length,
    failNextSet: (/** @type {string} */ message) => { failSet = message; },
    restore: () => { window.fetch = realFetch; },
  };
}

/**
 * Run the environment pin tests.
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Test label.
   * @param {() => Promise<void>|void} fn - Test body.
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
  }

  const pin = new EnvPin();

  /**
   * Mount the pin over a fake server.
   * @param {Parameters<typeof fakeServer>[0]} seed - The files.
   * @returns {any} Body, controller, server and levers.
   */
  function mount(seed) {
    const server = fakeServer(seed);
    const body = document.createElement('div');
    document.body.appendChild(body);
    const abort = new AbortController();
    /** @type {((changes: any[]) => void)[]} */
    const fileListeners = [];
    const controller = /** @type {any} */ (pin.mount(body, /** @type {any} */ ({
      pin: { id: 'pin_env', type: 'env', config: {} },
      active: { project: { path: ROOT, displayName: 'proj' }, conversation: { id: 'c1' }, thread: { id: null } },
      services: {
        files: {
          onChange: (/** @type {any} */ listener) => {
            fileListeners.push(listener);
            return () => fileListeners.splice(fileListeners.indexOf(listener), 1);
          },
        },
        contextItems: { find: () => null, onChange: () => () => {}, reveal: () => {} },
      },
      signal: abort.signal,
      updateConfig: async () => {},
    })));
    return {
      body,
      controller,
      server,
      watchers: () => fileListeners.length,
      fileChange: (/** @type {string} */ path) => { for (const l of [...fileListeners]) l([{ path, event: 'write' }]); },
      teardown: () => {
        controller.teardown?.();
        abort.abort();
        body.remove();
        server.restore();
      },
    };
  }

  /**
   * Wait for the body to satisfy a condition.
   * @param {HTMLElement} body - The pin body.
   * @param {(body: HTMLElement) => any} cond - What to wait for.
   * @param {string} what - For the failure.
   * @returns {Promise<any>} The condition's value.
   */
  const until = (body, cond, what) => waitFor(() => cond(body) || null,
    () => `${what} (the pin shows ${JSON.stringify(body.textContent)})`);

  /**
   * @param {HTMLElement} body - The pin body.
   * @param {string} scope - Which file.
   * @param {string} name - Which variable.
   * @returns {HTMLElement|null} Its row.
   */
  const row = (body, scope, name) => body.querySelector(`.env-pin__scope--${scope} .env-pin__row[data-name="${name}"]`);

  // --- the manifest and its gates ------------------------------------------

  await test('an environment pin needs a project, and says so', () => {
    assert(pin.canAdd(/** @type {any} */ ({ project: { path: '' } })) === 'No project', 'expected the reason');
    assert(pin.canAdd(/** @type {any} */ ({ project: { path: '/p' } })) === true, 'a project is all it needs');
    assert(!pin.allowsMultiple, 'there is one set of files per project, so one pin');
  });

  // --- what it shows --------------------------------------------------------

  await test('each file lists its own variables, values hidden until asked', async () => {
    const m = mount({ user: { EDITOR: 'vim' }, local: { API_KEY: 'sk-secret' } });
    try {
      const key = await until(m.body, (b) => row(b, 'local', 'API_KEY'), 'the local variable drawn');
      assert(row(m.body, 'user', 'EDITOR') !== null, 'the user variable is drawn in the user section');
      assert(!(m.body.textContent || '').includes('sk-secret'), 'a value is shown before anyone asked');
      /** @type {HTMLButtonElement} */ (key.querySelector('.env-pin__reveal')).click();
      await until(m.body, (b) => (b.textContent || '').includes('sk-secret'), 'Show to reveal the value');
      assert(!(m.body.textContent || '').includes('vim'), 'revealing one value revealed another');
    } finally { m.teardown(); }
  });

  await test('a variable a later file overrides is listed but marked as not in effect', async () => {
    const m = mount({ user: { MODE: 'user' }, local: { MODE: 'local' } });
    try {
      const shadowed = await until(m.body, (b) => row(b, 'user', 'MODE'), 'the user MODE drawn');
      assert(shadowed.classList.contains('env-pin__shadowed'), 'the overridden one is not marked');
      assert(!row(m.body, 'local', 'MODE')?.classList.contains('env-pin__shadowed'), 'the winning one is marked');
    } finally { m.teardown(); }
  });

  await test('with nothing set, the card says what it is for and still offers to add', async () => {
    const m = mount({});
    try {
      await until(m.body, (b) => b.querySelector('.pin-empty'), 'the empty state');
      assert(m.body.querySelectorAll('.env-pin__add').length === 3, 'every file should offer an add row');
    } finally { m.teardown(); }
  });

  await test('a file that was skipped says why', async () => {
    const m = mount({ local: { X: '1' }, errors: { local: 'invalid variable name or value: A-B' } });
    try {
      const err = await until(m.body, (b) => b.querySelector('.env-pin__error--file'), 'the file error');
      assert((err.textContent || '').includes('A-B') && (err.textContent || '').includes('env.local.json'),
        `the error should name the file and the problem: ${err.textContent}`);
    } finally { m.teardown(); }
  });

  // --- approval --------------------------------------------------------------

  await test('an unapproved project file shows what it sets, and Approve applies it', async () => {
    const m = mount({ project: { GIT_SSH_COMMAND: 'ssh -i deploy' } });
    try {
      const box = await until(m.body, (b) => b.querySelector('.env-pin__pending'), 'the approval banner');
      assert((box.textContent || '').includes('GIT_SSH_COMMAND=ssh -i deploy'),
        `approval must show the variables themselves, not a count: ${box.textContent}`);
      assert(row(m.body, 'project', 'GIT_SSH_COMMAND')?.classList.contains('env-pin__shadowed') === true,
        'a pending variable is drawn as in effect');
      /** @type {HTMLButtonElement} */ (box.querySelector('.env-pin__approve')).click();
      await until(m.body, (b) => !b.querySelector('.env-pin__pending'), 'the banner to go once approved');
      assert(m.server.writes().map((/** @type {any} */ c) => c.operation).join() === 'approve',
        `expected one approve, got ${JSON.stringify(m.server.writes())}`);
      assert(!row(m.body, 'project', 'GIT_SSH_COMMAND')?.classList.contains('env-pin__shadowed'),
        'the approved variable is still drawn as not in effect');
    } finally { m.teardown(); }
  });

  await test('an approved project file asks nothing', async () => {
    const m = mount({ project: { A: '1' }, approved: true });
    try {
      await until(m.body, (b) => row(b, 'project', 'A'), 'the project variable drawn');
      assert(!m.body.querySelector('.env-pin__pending'), 'an approved file still shows the banner');
    } finally { m.teardown(); }
  });

  // --- editing ---------------------------------------------------------------

  await test('Add writes the whole file with the new variable beside the old ones', async () => {
    const m = mount({ local: { KEEP: 'k' } });
    try {
      const form = await until(m.body, (b) => b.querySelector('.env-pin__scope--local .env-pin__add'), 'the local add row');
      /** @type {HTMLInputElement} */ (form.querySelector('.env-pin__add-name')).value = ' NEW_ONE ';
      /** @type {HTMLInputElement} */ (form.querySelector('.env-pin__add-value')).value = 'v a l';
      /** @type {HTMLButtonElement} */ (form.querySelector('.env-pin__add-button')).click();
      await until(m.body, (b) => row(b, 'local', 'NEW_ONE'), 'the added variable drawn');
      const [set] = m.server.writes();
      assert(set?.operation === 'set' && set.params.scope === 'local', `expected a local set, got ${JSON.stringify(set)}`);
      assert(JSON.stringify(set.params.env) === JSON.stringify({ KEEP: 'k', NEW_ONE: 'v a l' }),
        `the name is trimmed, the value kept as typed, and nothing else lost: ${JSON.stringify(set.params.env)}`);
    } finally { m.teardown(); }
  });

  await test('Remove writes the file without that variable', async () => {
    const m = mount({ user: { A: '1', B: '2' } });
    try {
      const a = await until(m.body, (b) => row(b, 'user', 'A'), 'A drawn');
      /** @type {HTMLButtonElement} */ (a.querySelector('.env-pin__delete')).click();
      await until(m.body, (b) => !row(b, 'user', 'A'), 'A gone');
      assert(row(m.body, 'user', 'B') !== null, 'removing one variable removed another');
      assert(JSON.stringify(m.server.writes()[0]?.params) === JSON.stringify({ scope: 'user', env: { B: '2' } }),
        `unexpected write ${JSON.stringify(m.server.writes())}`);
    } finally { m.teardown(); }
  });

  await test('a write the server refuses says why and changes nothing on screen', async () => {
    const m = mount({ local: { A: '1' } });
    try {
      const form = await until(m.body, (b) => b.querySelector('.env-pin__scope--local .env-pin__add'), 'the add row');
      m.server.failNextSet('invalid variable name or value: A-B');
      /** @type {HTMLInputElement} */ (form.querySelector('.env-pin__add-name')).value = 'A-B';
      /** @type {HTMLButtonElement} */ (form.querySelector('.env-pin__add-button')).click();
      const err = await until(m.body, (b) => b.querySelector('.env-pin__error--action'), 'the refusal shown');
      assert((err.textContent || '').includes('A-B'), `the server's reason is lost: ${err.textContent}`);
      assert(!row(m.body, 'local', 'A-B'), 'a refused variable was drawn');
    } finally { m.teardown(); }
  });

  // --- staying current --------------------------------------------------------

  await test('a change to either project env file re-reads; anything else does not', async () => {
    const m = mount({ local: { A: '1' } });
    try {
      await until(m.body, (b) => row(b, 'local', 'A'), 'first read');
      const before = m.server.reads();
      m.fileChange(`${ROOT}/src/main.go`);
      m.fileChange(`/elsewhere/.juggler/env.json`);
      m.server.files.local.B = '2';
      m.fileChange(`${ROOT}/.juggler/env.local.json`);
      await until(m.body, (b) => row(b, 'local', 'B'), 'the hand edit picked up');
      assert(m.server.reads() === before + 1, `expected exactly one re-read, got ${m.server.reads() - before}`);
    } finally { m.teardown(); }
  });

  await test('Refresh picks up the user file, which nothing watches', async () => {
    const m = mount({});
    try {
      await until(m.body, (b) => b.querySelector('.pin-empty'), 'first read');
      m.server.files.user.HAND = 'edited';
      const refresh = m.controller.getActions().find((/** @type {any} */ a) => a.id === 'refresh');
      assert(refresh, 'Refresh is how a hand edit to ~/.juggler/env.json is seen');
      await refresh.run();
      await until(m.body, (b) => row(b, 'user', 'HAND'), 'the user edit shown');
    } finally { m.teardown(); }
  });

  await test('teardown stops listening', async () => {
    const m = mount({});
    await until(m.body, (b) => b.querySelector('.pin-empty'), 'first read');
    assert(m.watchers() === 1, `expected one listener, got ${m.watchers()}`);
    m.teardown();
    assert(m.watchers() === 0, `the pin kept listening after teardown: ${m.watchers()}`);
  });

  // --- en-XA ----------------------------------------------------------------

  await test('en-XA: titles, sections, controls, banner, empty state and errors are translated', async () => {
    await underPseudoLocale('env-pin-test', async () => {
      /** @type {Record<string, string>} */
      const shown = {};
      shown['add reason'] = String(pin.canAdd(/** @type {any} */ ({ project: { path: '' } })));
      shown['tab title'] = String(pin.describe().title);

      const empty = mount({});
      try {
        const line = await until(empty.body, (b) => b.querySelector('.pin-empty'), 'the empty state');
        shown['empty state'] = String(line.textContent);
        shown['refresh action'] = String(empty.controller.getActions()[0]?.label);
      } finally { empty.teardown(); }

      // Names with no letters, so a message that embeds one is still judged; the
      // paths are data the pin prints, inside messages and on their own.
      const full = mount({ user: { _1: '1' }, local: { _1: '2' }, project: { _2: '1' }, errors: { user: '7' } });
      /**
       * @param {string} s - A shown string.
       * @returns {string} It, without the paths.
       */
      const unpathed = (s) => s.replace(/[\w./-]*\.juggler\/env(\.local)?\.json/g, '');
      try {
        await until(full.body, (b) => b.querySelector('.env-pin__pending'), 'the banner');
        // Shadowed and pending rows both drawn, so both titles are on screen.
        assert(!!(row(full.body, 'user', '_1')?.title && row(full.body, 'project', '_2')?.title), 'a row title is missing');
        full.server.failNextSet('7');
        /** @type {HTMLButtonElement} */ (full.body.querySelector('.env-pin__delete')).click();
        await until(full.body, (b) => b.querySelector('.env-pin__error--action'), 'the save error');
        shownStrings(full.body, '.env-pin__name, .env-pin__value, .env-pin__scope-path, .env-pin__pending-entry')
          .map(unpathed)
          .forEach((s, i) => { shown[`shown ${i}`] = s; });
      } finally { full.teardown(); }
      assert(Object.keys(shown).length > 12, `the full card drew too little to check: ${JSON.stringify(shown)}`);

      const raw = Object.entries(shown).filter(([, s]) => !isPseudoLocalized(s));
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    }, { '@juggler/core': CORE_TEXT });
  });

  return { passed, failed, errors };
}
