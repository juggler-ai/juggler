//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Skill context-item tests.
 *
 * Covers the two halves of the Agent Skills feature at the unit level, without a
 * backend:
 *  - The system-prompt "## Skills" block (`_buildBlock`): formatting, one-line
 *    description sanitisation + truncation, the 50-skill cap, and byte-stability
 *    (same skills in → identical text out, so it rides the prompt cache).
 *  - The freeze: seeding snapshots the catalog into `this.data.skills`, and the
 *    block/panel read that snapshot (not the live catalog) so an existing
 *    conversation's injected context never moves when skills change on disk.
 *  - The `skill` tool (`execute` + `getSummary`): a fresh load returns the
 *    SKILL.md body plus a resource listing (with SKILL.md itself elided); a
 *    repeat load in the same thread returns an "already loaded" notice; an
 *    unknown name is rejected. The skills service is stubbed via the item's
 *    `_listSkills` / `_loadBody` seams, so no server or on-disk skills required.
 * @module unit-tests/skill-item-test
 */

import SkillContextItem from '../context-items/skill-context-item.js';
import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../../../js-tests/utilities/test-helpers.js';
import { underPseudoLocale, assertPseudoLocalized } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';
import { HttpError } from '../../../js/services/http.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * A SkillContextItem with the skills-service seams stubbed to fixture data, so
 * execute()/createContextText() run without a backend.
 */
class FakeSkillItem extends SkillContextItem {
  /**
   * @param {import('../../../sdk/context-item-types.js').ItemContext} ctx - ContextItem constructor context
   * @param {any[]} skills - Fixture available-skills list
   * @param {Record<string, any>} bodies - name → {body, files} fixture details
   */
  constructor(ctx, skills, bodies) {
    super(ctx);
    this._skills = skills;
    this._bodies = bodies;
  }

  /** @returns {Promise<any[]>} Fixture skills */
  async _listSkills() {
    return this._skills;
  }

  /**
   * @param {string} _scope - Scope
   * @param {string} _source - Source
   * @param {string} name - Skill name
   * @returns {Promise<any>} Fixture detail
   */
  async _loadBody(_scope, _source, name) {
    if (!this._bodies[name]) {
      throw new Error(`no fixture body for ${name}`);
    }
    return this._bodies[name];
  }
}

/**
 * Run skill context-item tests.
 * @param {{fixtureDir: string}} _ctx - Test context (unused; no backend needed)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => Promise<void>|void} fn
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

  /**
   * The skills snapshot an item froze into its doc.
   * @param {FakeSkillItem} item - A seeded item
   * @returns {import('../../../js/services/skills.js').SkillMeta[]} Its `data.skills`
   */
  function frozenSkills(item) {
    return /** @type {import('../../../js/services/skills.js').SkillMeta[]} */ (item.data.skills);
  }

  await initializeRegistries();
  const session = await createTestSession();
  const conversation = await createTestConversation(session);

  /**
   * @param {any[]} skills - Fixture skills
   * @param {Record<string, any>} [bodies] - Fixture bodies
   * @returns {FakeSkillItem} Item bound to the test conversation
   */
  function makeItem(skills, bodies = {}) {
    return new FakeSkillItem(
      { id: `SKILL_${Math.random().toString(36).slice(2)}`, session, conversation, messageThread: conversation.rootMessageThread },
      skills,
      bodies
    );
  }

  // ---- system-prompt block (_buildBlock) ---------------------------------

  await test('empty skills contribute nothing', () => {
    assert(SkillContextItem._buildBlock([]) === '', 'empty list must yield empty string');
    assert(SkillContextItem._buildBlock(/** @type {any} */ (null)) === '', 'null must yield empty string');
  });

  await test('block lists one name: description line per skill, under a ## Skills heading', () => {
    const block = SkillContextItem._buildBlock([
      { name: 'a-skill', description: 'first' },
      { name: 'b-skill', description: 'second' }
    ]);
    assert(block.startsWith('## Skills'), `should start with heading; got:\n${block}`);
    const lines = block.split('\n');
    assert(lines.includes('- a-skill: first'), `missing a-skill line; got:\n${block}`);
    assert(lines.includes('- b-skill: second'), `missing b-skill line; got:\n${block}`);
  });

  await test('block is byte-stable for identical input (cache-friendly)', () => {
    const skills = [{ name: 'a', description: 'x' }, { name: 'b', description: 'y' }];
    const a = SkillContextItem._buildBlock(skills);
    const b = SkillContextItem._buildBlock(skills);
    assert(a === b, 'same skills must produce byte-identical block');
  });

  await test('descriptions are collapsed to a single line', () => {
    const block = SkillContextItem._buildBlock([
      { name: 'x', description: 'line one\n\nline two   with   spaces' }
    ]);
    const lines = block.split('\n');
    assert(lines.includes('- x: line one line two with spaces'), `newlines/space not collapsed; got:\n${block}`);
  });

  await test('long descriptions are truncated with an ellipsis', () => {
    const block = SkillContextItem._buildBlock([{ name: 'z', description: 'q'.repeat(500) }]);
    const zline = block.split('\n').find((l) => l.startsWith('- z:')) || '';
    assert(zline.length < 250, `description not truncated; line length ${zline.length}`);
    assert(zline.endsWith('…'), 'truncated line should end with an ellipsis');
  });

  await test('descriptions are capped at 50 skills; overflow is listed by name so it stays activatable', () => {
    const many = Array.from({ length: 60 }, (_v, i) => ({ name: `s${String(i).padStart(2, '0')}`, description: 'd' }));
    const block = SkillContextItem._buildBlock(many);
    const shown = block.split('\n').filter((l) => /^- s\d\d:/.test(l));
    assert(shown.length === 50, `should show exactly 50 described skills, showed ${shown.length}`);
    assert(block.includes('…and 10 more, loadable by exact name:'), `missing overflow note; got tail:\n${block.split('\n').slice(-2).join('\n')}`);
    assert(block.includes('s50') && block.includes('s59'), 'every overflow skill name must still be listed');
  });

  await test('createContextText renders the block from the available skills', async () => {
    const item = makeItem([{ name: 'pdf-tools', description: 'Handle PDFs' }]);
    const block = await item.createContextText({});
    assert(block.startsWith('## Skills'), 'context text should be the skills block');
    assert(block.includes('- pdf-tools: Handle PDFs'), `missing skill line; got:\n${block}`);
  });

  // ---- the skill tool (execute + getSummary) -----------------------------

  const oneSkill = [{ name: 'pdf-tools', description: 'Handle PDFs', scope: 'project', source: 'juggler' }];
  const oneBody = {
    'pdf-tools': {
      body: '# PDF tools\n\nStep one.',
      files: [
        { path: 'SKILL.md', size: 40 },
        { path: 'references/api.md', size: 1200 },
        { path: 'scripts/run.sh', size: 7 }
      ]
    }
  };

  await test('validate requires a non-empty name and trims it', async () => {
    const item = makeItem(oneSkill, oneBody);
    const bad = await item.validate({});
    assert(bad.valid === false, 'missing name must be invalid');
    const ok = await item.validate({ name: '  pdf-tools  ' });
    assert(ok.valid === true && ok.params?.name === 'pdf-tools', 'valid name must be trimmed');
  });

  await test('loading a skill returns its body and a resource listing (SKILL.md elided)', async () => {
    const item = makeItem(oneSkill, oneBody);
    const res = await item.execute({ name: 'pdf-tools' });
    assert(res.alreadyLoaded === false, 'first load should not be already-loaded');
    const summary = item.getSummary({ success: true, result: res }).summary;
    assert(summary.includes('Skill: pdf-tools (project/juggler)'), `missing origin header; got:\n${summary}`);
    assert(summary.includes('# PDF tools'), 'body must be present in the tool result');
    assert(summary.includes('references/api.md'), 'resource file should be listed');
    assert(summary.includes('scripts/run.sh'), 'script file should be listed');
    assert(!summary.includes('SKILL.md'), 'SKILL.md itself must not be listed as a resource');
  });

  await test('re-loading the same skill in a thread returns an already-loaded notice', async () => {
    const item = makeItem(oneSkill, oneBody);
    await item.execute({ name: 'pdf-tools' });
    const res2 = await item.execute({ name: 'pdf-tools' });
    assert(res2.alreadyLoaded === true, 'second load should be flagged already-loaded');
    const summary = item.getSummary({ success: true, result: res2 }).summary;
    assert(summary.includes('already loaded'), `expected already-loaded notice; got:\n${summary}`);
    assert(!summary.includes('# PDF tools'), 'already-loaded notice must not re-inject the body');
  });

  await test('an unknown skill name is rejected', async () => {
    const item = makeItem(oneSkill, oneBody);
    let threw = false;
    try {
      await item.execute({ name: 'does-not-exist' });
    } catch (/** @type {any} */ e) {
      threw = true;
      assert(/No skill named/.test(e.message), `unexpected error message: ${e.message}`);
    }
    assert(threw, 'loading an unknown skill must throw');
  });

  await test('getSummary reports a failed load', () => {
    const item = makeItem(oneSkill, oneBody);
    const summary = item.getSummary({ success: false, error: 'boom' });
    assert(summary.success === false, 'failed outcome must be success:false');
    assert(summary.summary.includes('boom'), 'error message must surface');
  });

  // ---- auto-instantiate / seeding path -----------------------------------

  await test('properties panel lists the available skills, not just the type name', async () => {
    const item = makeItem(oneSkill, oneBody);
    const container = document.createElement('div');
    await item.__renderPanelForTests(container);
    const text = container.textContent || '';
    assert(text !== 'skill', 'panel must not be just the bare type name');
    assert(text.includes('pdf-tools'), `panel should list the skill name; got:\n${text}`);
    assert(text.includes('Handle PDFs'), `panel should show the skill description; got:\n${text}`);
    assert(/in the system prompt/i.test(text), 'panel should explain the skills are listed in the system prompt');
  });

  await test('properties panel marks a skill loaded once activated in this thread', async () => {
    const item = makeItem(oneSkill, oneBody);
    await item.execute({ name: 'pdf-tools' });
    const container = document.createElement('div');
    await item.__renderPanelForTests(container);
    assert(/loaded/i.test(container.textContent || ''), 'an activated skill should be marked loaded in the panel');
  });

  await test('properties panel shows an empty state when no skills exist', async () => {
    const item = makeItem([]);
    const container = document.createElement('div');
    await item.__renderPanelForTests(container);
    assert(/No skills yet/i.test(container.textContent || ''), 'empty catalog should show an empty-state note');
  });

  await test('seeding via handleToolCall with empty params succeeds (no base onToolCall throw)', async () => {
    // When ≥1 skill exists the item auto-instantiates and is seeded through
    // executeContextItem -> handleToolCall('skill', {}). Without a no-op
    // onToolCall override this hit the base class throw
    // ("onToolCall() must be implemented by subclass") and injected that error
    // as a context-item message. Guard the no-op override stays in place.
    const item = makeItem(oneSkill, oneBody);
    const ctx = { session, conversation };
    const result = await item.handleToolCall('skill', {}, ctx);
    assert(result.success === true, `seed must succeed; got error: ${result.error}`);
    assert(
      !/must be implemented by subclass/.test(result.error || ''),
      'seed must not surface the base-class onToolCall error'
    );
  });

  await test('seeding freezes the available-skills snapshot into the doc (this.data.skills)', async () => {
    const item = makeItem(oneSkill, oneBody);
    await item.handleToolCall('skill', {}, { session, conversation });
    assert(Array.isArray(item.data.skills), 'seed should freeze a skills snapshot into this.data.skills');
    assert(
      frozenSkills(item).length === 1 && frozenSkills(item)[0]?.name === 'pdf-tools',
      `snapshot should record the available skills; got: ${JSON.stringify(item.data.skills)}`
    );
    assert(frozenSkills(item)[0]?.scope === 'project' && frozenSkills(item)[0]?.source === 'juggler',
      'snapshot must carry scope/source so the skill tool can resolve a load');
  });

  await test('the FROZEN snapshot, not the live catalog, drives the block and panel', async () => {
    const item = makeItem([{ name: 'a-skill', description: 'first' }], {});
    await item.handleToolCall('skill', {}, { session, conversation });
    // Mutate the live catalog AFTER seeding — a frozen conversation must not move.
    item._skills = [{ name: 'b-skill', description: 'second' }];
    const block = await item.createContextText({});
    assert(block.includes('- a-skill: first'), `block should reflect the frozen snapshot; got:\n${block}`);
    assert(!block.includes('b-skill'), 'block must not reflect post-seed catalog changes');
    const container = document.createElement('div');
    await item.__renderPanelForTests(container);
    const text = container.textContent || '';
    assert(text.includes('a-skill') && !text.includes('b-skill'),
      `panel must show the frozen snapshot, not the live catalog; got:\n${text}`);
  });

  await test('the freeze is write-once: re-seeding keeps the original snapshot', async () => {
    const item = makeItem([{ name: 'a-skill', description: 'first' }], {});
    await item.handleToolCall('skill', {}, { session, conversation });
    item._skills = [{ name: 'b-skill', description: 'second' }];
    await item.handleToolCall('skill', {}, { session, conversation });
    assert(
      frozenSkills(item).length === 1 && frozenSkills(item)[0]?.name === 'a-skill',
      `re-seed must not overwrite the frozen snapshot; got: ${JSON.stringify(item.data.skills)}`
    );
  });

  await test('createContextText falls back to a live scan when not seeded (no frozen snapshot)', async () => {
    const item = makeItem([{ name: 'live-skill', description: 'unfrozen' }]);
    const block = await item.createContextText({});
    assert(block.includes('- live-skill: unfrozen'),
      `unseeded item should fall back to the live list; got:\n${block}`);
  });

  // The tool result is the model's, so a failed load reads in English whatever
  // language the UI is in. The skills service hands back the request's own
  // HttpError; the item words it.
  await test('under en-XA a failed load fails in English', async () => {
    await underPseudoLocale('skill-item-test', async () => {
      for (const [error, expected] of [
        [new HttpError('HTTP 404: no such skill', 404, 'no such skill'), 'Failed to load skill "pdf-tools": no such skill'],
        [new HttpError('HTTP 500', 500, ''), 'Failed to load skill "pdf-tools" (HTTP 500)'],
      ]) {
        const item = makeItem(oneSkill, {});
        item._loadBody = async () => { throw error; };
        let message = '';
        try {
          await item.execute({ name: 'pdf-tools' });
        } catch (e) {
          message = e instanceof Error ? e.message : String(e);
        }
        assert(message === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(message)}`);
      }
    });
  });

  // Everything the item draws for the user is translated: the title, the row in
  // every state, the standing Skills card (full and empty) and the load panel
  // (fresh, already loaded, unknown skill, body not re-fetched). What the model
  // reads — the tool result, the validate error, the system-prompt block — stays
  // English. Skill names, descriptions, scope badges, file paths/sizes and the
  // model's text are data, so the fixture uses digits and the walk skips them.
  await test('under en-XA every state the item draws is translated, and the model\'s text is English', async () => {
    const CORE_TEXT = [
      'Skills', 'Skill', 'skill', 'Loading…', '{name} (already loaded)',
      'Loadable instruction sets — listed for the assistant',
      'Available skills', 'Available skills ({count})', 'No skills yet.',
      'Agent Skills are specialized instruction sets the LLM can load on demand as extra guidance for a particular kind of task, but kept out of the way until needed.',
      'The skills below are listed (name + description) in the system prompt, so the LLM knows what it can reach for.',
      'The LLM can choose to load a particular skill with a tool-call if it decides it\'s useful during the chat.',
      'Loading a skill only adds text. Any scripts or files it bundles are read or run later through the normal tools, under your usual approval rules.',
      'Manage skills', '(unnamed)', '(unknown skill)', 'scripts', 'Bundles scripts that can be run through the normal tools',
      'loaded', 'Already loaded into this conversation', 'No description.', 'Details',
      'View this skill\'s SKILL.md and files', 'Files ({count})', 'Instructions',
      'These instructions were already loaded earlier in this conversation, so they weren\u2019t added again.',
    ];
    const DATA = '.skills-card-name, .skills-scope-badge, .skills-file-path, .skills-file-size, .skill-load-body, .skill-load-raw';
    const skills = [
      { name: '1', description: '', scope: 'project', source: 'juggler', hasScripts: true },
      { name: '2', description: '', scope: 'user', source: 'agents' },
    ];
    const bodies = { 1: { body: '3', files: [{ path: 'SKILL.md', size: 4 }, { path: '5', size: 6 }] } };
    /**
     * A tool-action stand-in whose stored result is what the engine keeps.
     * @param {any} data - What `execute` returned
     * @param {string} content - The model's tool result
     * @returns {any} Render context
     */
    const ctxFor = (data, content) => ({
      toolAction: { get: () => ({ content, fullResult: { success: true, result: data } }) },
    });

    await underPseudoLocale('skill-item-test', async () => {
      /** @type {Record<string, string>} */
      const shown = {};
      /** @type {string[]} */
      const failures = [];
      /**
       * @param {string} where - State name
       * @param {() => void} fn - Assertion
       */
      const check = (where, fn) => {
        try { fn(); } catch (e) { failures.push(`${where}: ${e instanceof Error ? e.message : String(e)}`); }
      };

      const item = makeItem(skills, bodies);
      shown.title = item.getTitle();

      /** @type {Array<[string, any]>} */
      const states = [
        ['standing card', null],
        ['pending', { pending: true }],
        ['loaded', { success: true, result: { name: '1', alreadyLoaded: false } }],
        ['already loaded', { success: true, result: { name: '1', alreadyLoaded: true } }],
        ['loaded, no name', { success: true, result: {} }],
        ['neither', { success: false }],
      ];
      for (const [name, status] of states) {
        const ui = /** @type {any} */ (item.getStatusUI(status));
        // A plain load's row is the skill's name alone: data.
        if (name === 'loaded') check('loaded row', () => assert(ui?.summary === '1', `loaded row changed: ${JSON.stringify(ui?.summary)}`));
        else shown[`row ${name}`] = String(ui?.summary);
        shown[`type name ${name}`] = String(ui?.typeName);
      }
      // An error row is the model's English error, shown as it was.
      const errorRow = /** @type {any} */ (item.getStatusUI(/** @type {any} */ ({ success: false, error: 'No skill named "9"' })));
      check('error row', () => assert(errorRow.summary === 'No skill named "9"', `error row changed: ${JSON.stringify(errorRow.summary)}`));
      shown['type name error'] = String(errorRow.typeName);

      // Standing card, with one skill loaded so both badges show.
      await item.execute({ name: '1' });
      const panel = document.createElement('div');
      await item.__renderPanelForTests(panel);
      check('standing card', () => assertPseudoLocalized(panel, { skip: DATA, atLeast: 10, where: 'standing card' }));
      check('standing card badges', () => assert(panel.querySelectorAll('.skills-badge').length === 2, 'expected the scripts and loaded badges'));
      const empty = document.createElement('div');
      await makeItem([]).__renderPanelForTests(empty);
      check('empty card', () => assertPseudoLocalized(empty, { skip: DATA, atLeast: 6, where: 'empty card' }));

      /** @type {Array<[string, any, string, string, string]>} */
      const loads = [
        ['fresh load', makeItem(skills, bodies), '1', '.skill-load-body', ''],
        ['already loaded', makeItem(skills, bodies), '1', '.skill-load-note', ''],
        ['unknown skill', makeItem([], {}), '', '.skill-load-raw', '7'],
        ['body not re-fetched', makeItem(skills, {}), '2', '.skill-load-raw', '8'],
      ];
      for (const [where, loader, name, expect, content] of loads) {
        const host = document.createElement('div');
        const data = where === 'already loaded' ? { name, alreadyLoaded: true } : { name, alreadyLoaded: false, body: content };
        await loader._renderLoadPanel(host, name, ctxFor(data, content));
        check(where, () => assert(host.querySelector(expect) !== null, `${where}: expected ${expect}`));
        check(where, () => assertPseudoLocalized(host, { skip: DATA, atLeast: 2, where }));
        if (!name) shown['unknown skill name'] = String(host.querySelector('.skills-card-name')?.textContent);
      }
      shown['unnamed skill'] = String(SkillContextItem.__skillCardForTests({ name: '' }).querySelector('.skills-card-name')?.textContent);

      const raw = Object.entries(shown).filter(([, s]) => !isPseudoLocalized(s));
      if (raw.length) failures.push(`plain English under en-XA: ${JSON.stringify(raw)}`);

      // What the model reads is English under any UI language.
      const fresh = makeItem(skills, bodies);
      const summary = fresh.getSummary({ success: true, result: await fresh.execute({ name: '1' }) }).summary;
      check('model result', () => assert(summary.startsWith('Skill: 1 (project/juggler)\n\n3\n\nResources bundled with this skill'), `the model's result changed: ${JSON.stringify(summary)}`));
      const again = fresh.getSummary({ success: true, result: await fresh.execute({ name: '1' }) }).summary;
      check('model repeat', () => assert(again === 'Skill "1" is already loaded in this conversation — its instructions are already in context.', `repeat notice changed: ${JSON.stringify(again)}`));
      const bad = await fresh.validate({});
      check('validate', () => assert(bad.error === 'The "name" parameter is required — the exact name of the skill to load.', `validate error changed: ${JSON.stringify(bad.error)}`));
      const block = await fresh.createContextText({});
      check('system block', () => assert(block.startsWith('## Skills\nSpecialized instruction sets'), `block changed: ${JSON.stringify(block)}`));

      if (failures.length) throw new Error(failures.join(' | '));
    }, { '@juggler/core': CORE_TEXT });
  });

  return { passed, failed, errors };
}
