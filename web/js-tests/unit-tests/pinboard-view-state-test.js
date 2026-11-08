//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A pin keeps its place: the two ways the board offers a pin that is rebuilt
 * on every tab switch to come back where the reader left it.
 *
 * - **In-place config writes.** A pin that writes down state as the reader
 *   works (a tree's open folders) and asks for it to be written `inPlace` is
 *   already showing that config, so the store's echo of it must not rebuild
 *   the pin. Without this, every folder opened tore the tree down and read it
 *   again from the top. A write without `inPlace`, and a change the pin did not
 *   make, still rebuild: the file pin depends on the first.
 * - **View state.** What a pin hands back from `saveViewState()` as it is torn
 *   down comes back as `viewState` on its next mount — scroll positions inside
 *   the pin's own scroller, which the board's body never sees, and a selection.
 *
 * Driven through a probe item type registered only here, as
 * `unit:pinboard-retention` does. The store's write is not what is under test
 * and is not awaited; each echo is delivered by hand, the way the board panel
 * delivers one.
 * @module unit-tests/pinboard-view-state-test
 */

import { initializeRegistries, assert } from '../utilities/test-helpers.js';
import pinboardItemRegistry from '../../js/registries/pinboard-item-registry.js';
import PinboardItemType from 'juggler/pinboard-item-type';
import '../../js/components/pinboard-content.js';

/** How many times each pin id has been mounted. */
const mounts = new Map();

/** The context each pin id was last mounted with. */
const contexts = new Map();

/** What each pin id will hand back from `saveViewState()`, if anything. */
const saved = new Map();

/**
 * A pin that counts its mounts and hands back whatever the case set for it.
 * @param {string} id - The item-type id.
 * @param {boolean} offersViewState - Whether its controller has `saveViewState`.
 * @returns {any} The item-type class.
 */
function probeType(id, offersViewState) {
  return class ProbePin extends PinboardItemType {
    /** @type {import('juggler/pinboard-item-type').PinboardItemManifest} */
    static MANIFEST = {
      id,
      name: `Probe ${id}`,
      version: '1.0.0',
      description: 'A pin that exists only in this test',
      instances: 'multiple',
    };

    /**
     * @param {HTMLElement} container - The body region to fill.
     * @param {any} pinContext - The pin, the active snapshot and the host services.
     * @returns {any} The controller.
     */
    mount(container, pinContext) {
      const pinId = pinContext.pin.id;
      mounts.set(pinId, (mounts.get(pinId) || 0) + 1);
      contexts.set(pinId, pinContext);
      container.textContent = `probe ${pinId}`;
      return {
        teardown: () => {},
        ...(offersViewState ? { saveViewState: () => saved.get(pinId) } : {}),
      };
    }
  };
}

/**
 * Write config from inside the pin, as the pin would, without waiting on a
 * store that has no board behind it here.
 * @param {string} pinId - The pin writing.
 * @param {Record<string, unknown>} config - What it writes.
 * @param {{inPlace?: boolean}} [options] - How.
 */
function write(pinId, config, options) {
  contexts.get(pinId).updateConfig(config, options).catch(() => {});
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
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

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1200px;height:800px;';
  document.body.appendChild(container);
  pinboardItemRegistry.reset();

  const active = {
    project: { path: '/tmp/pinboard-view-state', displayName: 'pinboard-view-state' },
    conversation: { id: 'conv_view_state', title: 'View state' },
    thread: { id: null },
  };

  /** @type {any} */
  let content = null;

  try {
    for (const Type of [probeType('state-probe', true), probeType('bare-probe', false)]) {
      const reg = pinboardItemRegistry.registerClass(/** @type {any} */ (Type), { modulePath: '(test)' });
      assert(reg.registered, `registerClass refused a probe: ${reg.reason}`);
    }
    content = /** @type {any} */ (document.createElement('pinboard-content'));
    container.appendChild(content);

    const tree = { id: 'pin_tree', type: 'state-probe', config: { expanded: [] } };
    const other = { id: 'pin_other', type: 'bare-probe', config: {} };

    await run('the echo of an in-place write does not rebuild the pin that wrote it', () => {
      content.setPin(tree, active);
      const before = mounts.get('pin_tree');
      write('pin_tree', { expanded: ['src'], sort: 'name' }, { inPlace: true });
      // The server marshals keys in its own order, so the echo need not match
      // the write character for character.
      content.setPin({ ...tree, config: { sort: 'name', expanded: ['src'] } }, active);
      assert(mounts.get('pin_tree') === before,
        `an in-place write must not remount the pin; mounted ${mounts.get('pin_tree') - before} more time(s)`);
    });

    await run('echoes of quick in-place writes arriving one by one do not rebuild it', () => {
      const before = mounts.get('pin_tree');
      write('pin_tree', { expanded: ['src', 'src/a'] }, { inPlace: true });
      write('pin_tree', { expanded: ['src', 'src/a', 'src/b'] }, { inPlace: true });
      content.setPin({ ...tree, config: { expanded: ['src', 'src/a'] } }, active);
      content.setPin({ ...tree, config: { expanded: ['src', 'src/a', 'src/b'] } }, active);
      assert(mounts.get('pin_tree') === before,
        `a pin opening folders quickly must not be rebuilt by its own earlier echo; mounted ${mounts.get('pin_tree') - before} more`);
    });

    await run('a write without inPlace still rebuilds, as the file pin relies on', () => {
      const before = mounts.get('pin_tree');
      write('pin_tree', { expanded: ['lib'] });
      content.setPin({ ...tree, config: { expanded: ['lib'] } }, active);
      assert(mounts.get('pin_tree') === before + 1, 'an ordinary write must mount the pin afresh');
    });

    await run('a config change the pin did not write still rebuilds it', () => {
      const before = mounts.get('pin_tree');
      content.setPin({ ...tree, config: { expanded: ['docs'] } }, active);
      assert(mounts.get('pin_tree') === before + 1, 'a change from elsewhere must mount the pin afresh');
    });

    await run('view state saved on the way out comes back on the next mount', () => {
      content.setPin({ ...tree, config: { expanded: ['docs'] } }, active);
      saved.set('pin_tree', { scrollTop: 420, selected: 'docs/a.md' });
      content.setPin(other, active);
      saved.delete('pin_tree');
      content.setPin({ ...tree, config: { expanded: ['docs'] } }, active);
      const viewState = contexts.get('pin_tree').viewState;
      assert(viewState?.scrollTop === 420 && viewState?.selected === 'docs/a.md',
        `expected the saved view state back, got ${JSON.stringify(viewState)}`);
    });

    await run('a pin offering no view state is handed none', () => {
      content.setPin(other, active);
      content.setPin(tree, active);
      content.setPin(other, active);
      assert(contexts.get('pin_other').viewState === undefined, 'a pin that saved nothing must be given nothing');
    });

    await run('a pin taken off the board forgets its view state', () => {
      saved.set('pin_tree', { scrollTop: 7 });
      content.setPin(tree, active);
      content.setPin(other, active);
      content.syncPins([other]);
      saved.delete('pin_tree');
      content.setPin(tree, active);
      assert(contexts.get('pin_tree').viewState === undefined,
        'a pin pinned again is a new pin, and must not open where an old one was left');
    });
  } finally {
    content?.remove();
    container.remove();
    pinboardItemRegistry.reset();
    mounts.clear();
    contexts.clear();
    saved.clear();
  }

  return { passed, failed, errors };
}
